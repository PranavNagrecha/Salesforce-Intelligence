/**
 * Handler for the `sfi.outbound_message_catalog` MCP tool.
 *
 * The v2.8 async-deep-tier surface for "what SOAP-based outbound
 * messages does my org send, where do they go, and which workflow
 * rule invokes them?". Walks the `OutboundMessage` node family the
 * v2.8 workflow-rule extractor promotes from dangling-by-design
 * references into real nodes (mirroring the v1.5 R1 promotion of
 * NamedCredential / RemoteSiteSetting / ExternalDataSource into the
 * integration-topology tier).
 *
 * Implementation notes:
 *   - `objectFilter` narrows the scan to one parent CustomObject —
 *     useful when an architect wants to focus on "what outbound
 *     messages does Account send?". When omitted every
 *     OutboundMessage in the graph is included. The named object is
 *     RESOLVED AND VERIFIED against the vault first (shared
 *     `resolveExistingObjectScope`), so a typo or an object this
 *     refresh never retrieved is REFUSED rather than answered with a
 *     confident empty catalog, and a wrong-case name is corrected to
 *     the vault's exact casing. A scoped call echoes `appliedScope`
 *     and its disclosure is scoped too — a zero-result for ONE object
 *     is never phrased as an org-wide "this org defines none".
 *   - Each catalog entry surfaces the entry's identity (id, apiName,
 *     name) plus the four extracted endpoint properties
 *     (endpointUrl, includeSessionId, useDeadLetterQueue,
 *     integrationUser), the fields list (the SOAP body's payload
 *     shape), and the parent CustomObject id.
 *   - The `invokedByWorkflowRules` array is computed by walking
 *     incoming `references` edges from WorkflowRule nodes (the
 *     v1.3 reference shape preserved by the v2.8 promotion). Each
 *     entry carries the rule's id + apiName so the renderer can
 *     show "Account.Notify_Sales_On_New_Tier1 invokes
 *     SendOrderToWarehouse" without an extra graph round-trip.
 *   - Honesty axis (verbatim in `disclosure`): the endpoint URL is
 *     captured verbatim — v2.8 does NOT probe the URL, does NOT
 *     validate the destination exists, and does NOT confirm the
 *     message is actually invoked at runtime. The architect verifies
 *     destination reachability separately.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope } from './input-aliases.js';

/**
 * Hard cap on the per-call scan. Mirrors the
 * `INTEGRATION_MAP_MAX_LIMIT` and `SCHEDULED_JOB_CATALOG_MAX_CLASSES`
 * ceilings so the v2.8 catalog tools share a uniform blast-radius
 * cap.
 */
const OUTBOUND_MESSAGE_CATALOG_MAX_ENTRIES = 500;

/**
 * Zod schema for the `sfi.outbound_message_catalog` tool input.
 *
 *   - `objectFilter`: optional, non-empty string. The CustomObject
 *     apiName to narrow the scan to (e.g., `'Account'`). When
 *     omitted every OutboundMessage in the graph is included.
 */
export const outboundMessageCatalogInputSchema = z.object({
  objectFilter: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `outboundMessageCatalogInputSchema`. */
export type OutboundMessageCatalogInput = z.infer<
  typeof outboundMessageCatalogInputSchema
>;

/**
 * One WorkflowRule that invokes the outbound message. Computed from
 * the incoming `references` edge produced by the v1.3 workflow-rule
 * extractor (preserved verbatim through the v2.8 promotion).
 */
export interface OutboundMessageInvoker {
  readonly workflowRuleId: ComponentId;
  readonly apiName: string;
}

/** One entry in the outbound-message catalog. */
export interface OutboundMessageCatalogEntry {
  readonly outboundMessageId: ComponentId;
  readonly apiName: string;
  readonly name: string;
  readonly parentObjectId: ComponentId | null;
  readonly endpointUrl: string | null;
  readonly includeSessionId: boolean;
  readonly useDeadLetterQueue: boolean;
  readonly integrationUser: string | null;
  readonly fields: readonly string[];
  readonly invokedByWorkflowRules: readonly OutboundMessageInvoker[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface OutboundMessageCatalogOutput {
  /**
   * Present ONLY on an `objectFilter` call — echoes the canonical
   * `CustomObject:` id the catalog was narrowed to, in the VAULT's exact
   * casing (not the caller's), so a host can never read a one-object answer
   * as an org-wide catalog. Absent on the bare call, which keeps that
   * response byte-identical to the pre-scope shape.
   */
  readonly appliedScope?: {
    readonly object: string;
    readonly mode: 'component';
  };
  readonly entries: readonly OutboundMessageCatalogEntry[];
  readonly entriesByObject: Readonly<
    Record<string, readonly OutboundMessageCatalogEntry[]>
  >;
  readonly summary: {
    readonly totalEntries: number;
    readonly totalObjects: number;
    readonly entriesWithKnownInvokers: number;
  };
  /**
   * Coverage status of the WorkflowRule family that hosts classic
   * `<outboundMessages>` definitions. Classic SOAP outbound messages
   * live INSIDE `.workflow-meta.xml` (the same source the WorkflowRule
   * extractor retrieves), so when that family's coverage is `complete`
   * a zero-entry result is a DETERMINATE NEGATIVE ("this org defines no
   * outbound messages"), NOT a coverage gap. When coverage is `partial`
   * or `unknown` an empty result is inconclusive — the definitions may
   * simply not have been retrieved. The renderer/host MUST use this to
   * phrase a zero-result honestly instead of defaulting to "refresh the
   * vault".
   *
   * COVERAGE IS ORG-WIDE; the RESULT may be object-scoped. `complete` plus
   * zero entries is a determinate negative about THE ORG only on a bare
   * call — on an `objectFilter` call it is a determinate negative about
   * THAT OBJECT and says nothing about the rest of the org. `disclosure`
   * already carries that distinction; read it, not `coverageStatus` alone.
   */
  readonly coverageStatus: 'complete' | 'partial' | 'unknown';
  readonly disclosure: string;
}

/**
 * Verbatim honesty disclosure surfaced ALWAYS in the response. The
 * endpoint URL is captured verbatim from the
 * `<outboundMessages><endpointUrl>` element; v2.8 does NOT probe
 * the URL, does NOT validate the destination exists, and does NOT
 * confirm the message is actually invoked at runtime.
 */
const OUTBOUND_MESSAGE_DISCLOSURE =
  'Endpoint URLs are captured verbatim from the `<outboundMessages><endpointUrl>` element and NOT VALIDATED — v2.8 does not probe the URL, does not confirm the destination exists, and does not confirm the message is invoked at runtime. Runtime registration via a custom Apex caller or a programmatically-modified workflow rule is invisible to the offline extractor.';

/**
 * The metadata families whose coverage backs an outbound-message
 * answer. Classic SOAP outbound messages are serialized INSIDE the
 * `.workflow-meta.xml` files under the `<outboundMessages>` element, so
 * the WorkflowRule family's coverage is the authoritative signal for
 * whether a zero-entry result is a determinate negative or a gap.
 */
const OUTBOUND_COVERAGE_TYPES = ['WorkflowRule'] as const;

/**
 * Build the disclosure for a ZERO-entry result. When the backing
 * WorkflowRule coverage is `complete`, the org genuinely defines no
 * outbound messages — say so plainly (a false premise, not a retrieval
 * miss) so the host does not default to "refresh the vault". When
 * coverage is `partial`/`unknown` the empty result is inconclusive.
 */
const buildEmptyDisclosure = (
  coverageStatus: 'complete' | 'partial' | 'unknown',
): string =>
  coverageStatus === 'complete'
    ? 'No outbound message definitions exist in this org. The WorkflowRule family — which is where classic SOAP `<outboundMessages>` are serialized — has COMPLETE coverage in this vault, so this is a determinate negative (the org defines none), NOT a coverage gap: do not suggest a refresh to "surface" outbound messages that are not there. ' +
      OUTBOUND_MESSAGE_DISCLOSURE
    : 'No outbound message entries were found, BUT the WorkflowRule family that hosts classic `<outboundMessages>` is only partially covered in this vault, so this result is INCONCLUSIVE — outbound message definitions may exist in the org but were not retrieved. Run `/sfi-refresh` (or check `sfi.coverage_report`) before concluding the org has none. ' +
      OUTBOUND_MESSAGE_DISCLOSURE;

/**
 * OUTBOUND-MESSAGE-CATALOG-SCOPED-NEGATIVE-READ-AS-ORG-WIDE: the leading
 * sentence on EVERY `objectFilter` answer. `entries` is the count AFTER the
 * narrowing, so without this the reader has no way to tell a one-object
 * catalog from the org's whole catalog — and on a zero-result the old
 * org-wide wording actively told them not to look further.
 */
const scopedPrefix = (objectApiName: string): string =>
  `SCOPED to ${objectApiName}: this catalog covers ONLY outbound messages whose parent object is ${objectApiName} — it is NOT an org-wide count, and says NOTHING about outbound messages on other objects. Re-run without \`objectFilter\` for the org-wide catalog. `;

/**
 * The zero-entry disclosure for an OBJECT-SCOPED call. The determinate
 * negative it can honestly assert is bounded by the scope: "this OBJECT
 * defines none", never "this ORG defines none". Coverage still decides
 * determinate-vs-inconclusive, because the WorkflowRule family is the
 * retrieval unit either way.
 */
const buildScopedEmptyDisclosure = (
  objectApiName: string,
  coverageStatus: 'complete' | 'partial' | 'unknown',
): string =>
  scopedPrefix(objectApiName) +
  (coverageStatus === 'complete'
    ? `No outbound message definitions are attached to ${objectApiName}. The WorkflowRule family — which is where classic SOAP \`<outboundMessages>\` are serialized — has COMPLETE coverage in this vault, so this is a determinate negative FOR ${objectApiName} (that object defines none), NOT a coverage gap: do not suggest a refresh to "surface" outbound messages that are not there. Other objects in this org may still define outbound messages. `
    : `No outbound message entries were found on ${objectApiName}, BUT the WorkflowRule family that hosts classic \`<outboundMessages>\` is only partially covered in this vault, so this result is INCONCLUSIVE — outbound message definitions may exist on ${objectApiName} but were not retrieved. Run \`/sfi-refresh\` (or check \`sfi.coverage_report\`) before concluding ${objectApiName} has none. `) +
  OUTBOUND_MESSAGE_DISCLOSURE;

/**
 * Read a string property defensively. Returns the verbatim value
 * when it's a string, or null otherwise.
 */
const readOptionalString = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const raw = properties[key];
  return typeof raw === 'string' ? raw : null;
};

/**
 * Read a boolean property defensively. Returns the verbatim value
 * when it's a boolean, or false otherwise. v2.8's producer (the
 * extended workflow-rule extractor) writes both flags explicitly
 * so the empty-property default is also `false`.
 */
const readBoolean = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): boolean => properties[key] === true;

/**
 * Read the `fields` property as a string array, defensively. v2.8's
 * producer writes the SOAP payload's per-field list; other shapes
 * pass through as the empty array.
 */
const readFields = (
  properties: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const raw = properties['fields'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * Read the `name` property as a string, defensively. The v2.8
 * producer writes the verbatim `<fullName>` value; absent or
 * non-string values fall back to the entry's apiName tail.
 */
const readName = (
  properties: Readonly<Record<string, unknown>>,
  apiName: string,
): string => {
  const raw = properties['name'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  const dot = apiName.lastIndexOf('.');
  return dot === -1 ? apiName : apiName.slice(dot + 1);
};

/**
 * Compute the parent CustomObject apiName from the OutboundMessage's
 * apiName, which is shaped as `{ObjectApiName}.{Name}`. Used both
 * for `objectFilter` matching and for the `entriesByObject` group-by
 * key. Returns the empty string when the apiName has no `.` (a
 * defensive case the v2.8 producer never emits).
 */
const apiNameToObjectKey = (apiName: string): string => {
  const dot = apiName.indexOf('.');
  return dot === -1 ? '' : apiName.slice(0, dot);
};

/**
 * Walk every incoming `references` edge to the OutboundMessage node
 * and narrow to those originating from WorkflowRule nodes (the v1.3
 * producer of these references). Each surviving caller is resolved
 * to its identity for the catalog entry.
 */
const collectInvokers = async (
  ctx: Context,
  outboundMessageId: ComponentId,
): Promise<Result<readonly OutboundMessageInvoker[], string>> => {
  const edgesResult = await listEdges(ctx.graph, outboundMessageId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const invokers: OutboundMessageInvoker[] = [];
  for (const edge of edgesResult.value) {
    if (!edge.fromId.startsWith('WorkflowRule:')) continue;
    const nodeResult = await getNodeById(ctx.graph, edge.fromId);
    if (!nodeResult.ok) return err(nodeResult.error.message);
    const node = nodeResult.value;
    if (node === null) continue;
    invokers.push({ workflowRuleId: node.id, apiName: node.apiName });
  }
  return ok(invokers);
};

/**
 * Deterministic entry comparator: outboundMessageId ASC.
 */
const compareEntries = (
  a: OutboundMessageCatalogEntry,
  b: OutboundMessageCatalogEntry,
): number =>
  a.outboundMessageId < b.outboundMessageId
    ? -1
    : a.outboundMessageId > b.outboundMessageId
      ? 1
      : 0;

/**
 * Deterministic invoker comparator: workflowRuleId ASC.
 */
const compareInvokers = (
  a: OutboundMessageInvoker,
  b: OutboundMessageInvoker,
): number =>
  a.workflowRuleId < b.workflowRuleId
    ? -1
    : a.workflowRuleId > b.workflowRuleId
      ? 1
      : 0;

/**
 * The `sfi.outbound_message_catalog` MCP tool. Returns one entry per
 * OutboundMessage node (the v2.8 promotion of the v1.3
 * dangling-by-design references), with endpoint URL, payload
 * shape, integration user, and the WorkflowRules that invoke it.
 *
 * @example
 *   const r = await outboundMessageCatalogHandler(ctx, { objectFilter: 'Account' });
 *   if (r.ok) console.log(r.value.data.summary.totalEntries);
 */
export const outboundMessageCatalogHandler = async (
  ctx: Context,
  input: OutboundMessageCatalogInput,
): Promise<Result<McpResponse<OutboundMessageCatalogOutput>, McpError>> => {
  // OUTBOUND-MESSAGE-CATALOG-UNVERIFIED-OBJECT-SCOPE: `objectFilter` used to
  // be a case-SENSITIVE `===` against the apiName prefix with no check that
  // the object exists, so `account`, `Acount__c` and an object this refresh
  // never retrieved ALL fell through to a zero-entry answer that was then
  // dressed up as an ORG-WIDE determinate negative. It now goes through the
  // one shared `resolveExistingObjectScope`, which verifies the object EXISTS
  // in the vault, rewrites it to the vault's exact casing, and REFUSES what it
  // cannot resolve instead of answering about the empty set.
  let scopedObject: string | null = null;
  let appliedScope: { readonly object: string; readonly mode: 'component' } | null =
    null;
  if (input.objectFilter !== undefined) {
    const scopeResult = await resolveExistingObjectScope(ctx.graph, {
      objectApiName: input.objectFilter,
    });
    if (!scopeResult.ok) return err(scopeResult.error);
    const scope = scopeResult.value;
    // `objectFilter` is `min(1)`, so the resolver cannot report "no object
    // named"; the null branch exists only so the type is honoured.
    if (scope !== null) {
      scopedObject = scope.object;
      appliedScope = { object: scope.componentId, mode: 'component' };
    }
  }

  const nodesResult = await listNodesByType(ctx.graph, 'OutboundMessage', {
    limit: OUTBOUND_MESSAGE_CATALOG_MAX_ENTRIES,
  });
  if (!nodesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodesResult.error.message}`,
    });
  }

  const entries: OutboundMessageCatalogEntry[] = [];
  let entriesWithKnownInvokers = 0;
  for (const node of nodesResult.value as readonly Node[]) {
    const objectKey = apiNameToObjectKey(node.apiName);
    // Salesforce api names are case-INSENSITIVE: `Account` and `account` name
    // the same object, and the OutboundMessage apiName prefix is whatever the
    // source file spelled. Compare case-folded against the vault-resolved
    // name so the narrowing agrees with the resolution above.
    if (
      scopedObject !== null &&
      objectKey.toLowerCase() !== scopedObject.toLowerCase()
    ) {
      continue;
    }
    const invokersResult = await collectInvokers(ctx, node.id);
    if (!invokersResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${invokersResult.error}`,
      });
    }
    const invokers = [...invokersResult.value].sort(compareInvokers);
    if (invokers.length > 0) entriesWithKnownInvokers++;
    entries.push({
      outboundMessageId: node.id,
      apiName: node.apiName,
      name: readName(node.properties, node.apiName),
      parentObjectId: node.parentId,
      endpointUrl: readOptionalString(node.properties, 'endpointUrl'),
      includeSessionId: readBoolean(node.properties, 'includeSessionId'),
      useDeadLetterQueue: readBoolean(node.properties, 'useDeadLetterQueue'),
      integrationUser: readOptionalString(node.properties, 'integrationUser'),
      fields: readFields(node.properties),
      invokedByWorkflowRules: invokers,
    });
  }

  const sorted = entries.sort(compareEntries);
  const byObject: Record<string, OutboundMessageCatalogEntry[]> = {};
  for (const entry of sorted) {
    const key = apiNameToObjectKey(entry.apiName);
    const bucket = byObject[key] ?? [];
    bucket.push(entry);
    byObject[key] = bucket;
  }

  const coverageStatus = summarizeCoverage(
    ctx.manifest,
    OUTBOUND_COVERAGE_TYPES,
  ).status;

  return ok({
    data: {
      // appliedScope FIRST + only when scoped, so a bare call omits the whole
      // block and its serialized response stays byte-identical to pre-fix.
      ...(appliedScope !== null ? { appliedScope } : {}),
      entries: sorted,
      entriesByObject: byObject,
      summary: {
        totalEntries: sorted.length,
        totalObjects: Object.keys(byObject).length,
        entriesWithKnownInvokers,
      },
      coverageStatus,
      // Two independent axes, and BOTH have to be right:
      //  - coverage decides determinate-negative vs inconclusive (a zero is
      //    only "the org has none" when the backing WorkflowRule family is
      //    fully covered), which stops a "refresh the vault" framing on an
      //    org that simply has none;
      //  - SCOPE decides what the negative is ABOUT. `sorted.length` is the
      //    count AFTER the `objectFilter` narrowing, so the org-wide wording
      //    is reachable ONLY on a bare call. A scoped answer — empty or not —
      //    always says so.
      disclosure:
        scopedObject !== null
          ? sorted.length === 0
            ? buildScopedEmptyDisclosure(scopedObject, coverageStatus)
            : scopedPrefix(scopedObject) + OUTBOUND_MESSAGE_DISCLOSURE
          : sorted.length === 0
            ? buildEmptyDisclosure(coverageStatus)
            : OUTBOUND_MESSAGE_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
