/**
 * Handler for the `sfi.cpq_rule_chain` MCP tool.
 *
 * The first of three v2.6a CPQ-specialist tools. Given a CpqProductRule
 * or CpqPriceRule canonical id, walks the chain of rules of the same
 * type sharing the same parent CustomObject (the SBQQ__ rule object
 * definition) and returns them in their effective evaluation order.
 *
 * Sort precedence per CpqSemantics.md §4.1:
 *   1. active DESC (active rules surface before inactive)
 *   2. evaluationOrder ASC (lower order fires first)
 *   3. id ASC (deterministic tie-breaker)
 *
 * Honesty axis: the rule chain reflects the v2.6a-extracted records
 * only. Apex-customized rule firing logic (custom
 * `SBQQ.QuoteCalculatorPlugin` implementations) and runtime
 * re-ordering via the CPQ pricing API are invisible to the recognition
 * layer. The chain order is the DECLARED order, not the runtime
 * evaluation order.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { phantomAwareNotFoundMessage } from './phantom-node.js';

/**
 * The two CPQ rule ComponentTypes the tool accepts as input. CPQ Quote
 * Templates and Lookup Queries and Configuration Attributes are out of
 * scope for the chain walker — those don't have a documented evaluation
 * order in the SBQQ namespace.
 */
const RULE_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'CpqProductRule',
  'CpqPriceRule',
]);

const CPQ_PRODUCT_RULE_PREFIX = 'CpqProductRule:';
const CPQ_PRICE_RULE_PREFIX = 'CpqPriceRule:';

/**
 * Verbatim boundary disclosure for the rule chain. Surfaced in every
 * successful response so consumers see the recognition boundary
 * alongside the chain order.
 */
const RULE_CHAIN_DISCLOSURE =
  'The rule chain reflects the v2.6a-extracted CPQ records only. ' +
  'Apex-customized CPQ rule firing logic (custom ' +
  '`SBQQ.QuoteCalculatorPlugin` implementations) is invisible. ' +
  'Runtime re-ordering via the CPQ pricing API is invisible. ' +
  'The chain order shown is the declared evaluation order, not the ' +
  'runtime order.';

/**
 * Zod schema for the `sfi.cpq_rule_chain` tool input. `ruleId` is a
 * required non-empty string; the prefix constraint (`CpqProductRule:`
 * or `CpqPriceRule:`) is enforced at the handler boundary because
 * Zod cannot express the prefix constraint here.
 */
export const cpqRuleChainInputSchema = z.object({
  ruleId: z.string().min(1),
});

/** Parsed input shape, inferred from `cpqRuleChainInputSchema`. */
export type CpqRuleChainInput = z.infer<typeof cpqRuleChainInputSchema>;

/**
 * One entry in the emitted rule chain. The chain is the list of sibling
 * CPQ rules of the same type sharing the same parent CustomObject,
 * sorted per CpqSemantics.md §4.1.
 */
export interface CpqRuleChainEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly label: string | null;
  readonly active: boolean;
  readonly evaluationOrder: number | null;
  readonly position: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CpqRuleChainOutput {
  readonly ruleId: ComponentId;
  readonly type: ComponentType;
  readonly parentId: ComponentId | null;
  readonly chain: readonly CpqRuleChainEntry[];
  readonly targetPosition: number;
  readonly disclosure: string;
}

/**
 * Decide whether a `ruleId` carries one of the two accepted CPQ-rule
 * prefixes. Returns the type the prefix maps to on success, `null`
 * otherwise. The handler surfaces a `null` return as `invalid-query`.
 */
const classifyRuleId = (ruleId: string): ComponentType | null => {
  if (ruleId.startsWith(CPQ_PRODUCT_RULE_PREFIX)) return 'CpqProductRule';
  if (ruleId.startsWith(CPQ_PRICE_RULE_PREFIX)) return 'CpqPriceRule';
  return null;
};

/**
 * Read the `active` flag from a CPQ node's properties. Defaults to
 * `false` when absent (the v2.6a recognition layer derives `active`
 * with a `false` default for unset checkbox fields).
 */
const readActive = (node: Node): boolean => node.properties['active'] === true;

/**
 * Read the `evaluationOrder` numeric property. Returns `null` when
 * absent or non-numeric — the chain walker treats `null` as
 * "place last among same-active-status rules" per the sort precedence.
 */
const readEvaluationOrder = (node: Node): number | null => {
  const raw = node.properties['evaluationOrder'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

/**
 * Sort the chain per CpqSemantics.md §4.1 precedence. Stable because
 * the secondary tie-breaker (`id ASC`) is unique across the chain.
 */
const sortChain = (nodes: readonly Node[]): readonly Node[] => {
  return [...nodes].sort((a, b) => {
    // active DESC — true (1) before false (0).
    const aActive = readActive(a) ? 1 : 0;
    const bActive = readActive(b) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    // evaluationOrder ASC — nulls last.
    const aOrder = readEvaluationOrder(a);
    const bOrder = readEvaluationOrder(b);
    if (aOrder !== bOrder) {
      if (aOrder === null) return 1;
      if (bOrder === null) return -1;
      return aOrder - bOrder;
    }
    // id ASC.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
};

/**
 * The `sfi.cpq_rule_chain` MCP tool. Returns the chain of CPQ rules
 * sharing the input rule's type and parent CustomObject, sorted by
 * (active DESC, evaluationOrder ASC, id ASC). The input rule's
 * position in the sorted chain is surfaced as `targetPosition`.
 *
 * @example
 *   const r = await cpqRuleChainHandler(ctx, {
 *     ruleId: 'CpqPriceRule:SBQQ__PriceRule__c.HighDiscountAlert',
 *   });
 *   if (r.ok) console.log(r.value.data.chain.length);
 */
export const cpqRuleChainHandler = async (
  ctx: Context,
  input: CpqRuleChainInput,
): Promise<Result<McpResponse<CpqRuleChainOutput>, McpError>> => {
  const ruleType = classifyRuleId(input.ruleId);
  if (ruleType === null) {
    return err({
      kind: 'invalid-query',
      message: `ruleId must start with '${CPQ_PRODUCT_RULE_PREFIX}' or '${CPQ_PRICE_RULE_PREFIX}'; got '${input.ruleId}'`,
      path: 'ruleId',
    });
  }

  const targetResult = await getNodeById(ctx.graph, input.ruleId);
  if (!targetResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${targetResult.error.message}`,
    });
  }
  const target = targetResult.value;
  if (target === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, input.ruleId, 'CPQ rule'),
      path: input.ruleId,
    });
  }
  if (!RULE_NODE_TYPES.has(target.type)) {
    return err({
      kind: 'component-not-found',
      message: `no CPQ rule with id ${input.ruleId}`,
      path: input.ruleId,
    });
  }

  // List every node of the same CPQ rule type, then filter by shared
  // parentId. The `listNodesByType.parentId` option pushes the parent
  // filter into the SQL layer when set, avoiding a client-side scan.
  const parentId = target.parentId;
  if (parentId === null) {
    // A CPQ rule with no parent is malformed by the v2.6a contract —
    // every recognized record carries the underlying CustomObject
    // as its parentId. Surface this defensively as a single-entry
    // chain so the tool stays usable.
    return ok({
      data: {
        ruleId: target.id,
        type: target.type,
        parentId: null,
        chain: [
          {
            id: target.id,
            apiName: target.apiName,
            label: target.label,
            active: readActive(target),
            evaluationOrder: readEvaluationOrder(target),
            position: 1,
          },
        ],
        targetPosition: 1,
        disclosure: RULE_CHAIN_DISCLOSURE,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const siblingsResult = await listNodesByType(ctx.graph, ruleType, {
    parentId,
    limit: 500,
  });
  if (!siblingsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${siblingsResult.error.message}`,
    });
  }
  const sortedSiblings = sortChain(siblingsResult.value);
  const chain: CpqRuleChainEntry[] = sortedSiblings.map((node, index) => ({
    id: node.id,
    apiName: node.apiName,
    label: node.label,
    active: readActive(node),
    evaluationOrder: readEvaluationOrder(node),
    position: index + 1,
  }));
  const targetEntry = chain.find((entry) => entry.id === target.id);

  return ok({
    data: {
      ruleId: target.id,
      type: target.type,
      parentId,
      chain,
      targetPosition: targetEntry?.position ?? 0,
      disclosure: RULE_CHAIN_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
