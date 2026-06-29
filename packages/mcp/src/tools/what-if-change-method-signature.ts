/**
 * Handler for the `sfi.what_if_change_method_signature` MCP tool.
 *
 * v2.3 R2b — the third of three component-level what-if composers.
 * Given an ApexClass canonical id (`ApexClass:{Name}`), a method name,
 * and an optional new signature string, enumerates every Apex caller
 * that invokes the named method on the target class plus every test
 * class exercising the target class. Each caller becomes a
 * `WhatIfImpactItem` flagged as needing update; the test classes
 * surface as a parallel list so the renderer can prioritise the
 * test-suite update axis.
 *
 * **The signature-axis honesty boundary.** v2.3 does NOT parse the
 * `newSignature` string. The parameter is accepted for v2.3.1
 * description (so a caller can echo the before/after for renderer
 * context), but it does NOT influence which callers are flagged. Per
 * the WhatIfSemantics.md "Cross-class transitive analysis not
 * available" boundary, every direct caller of the method is treated
 * as "needs update" — fail-conservative. A future-milestone tool with
 * Apex AST capability could parse the signature and surface only the
 * callers whose call-sites would actually compile-fail under the new
 * signature; v2.3 flags every caller for human review.
 *
 * **Caller identification.** Composes over the v0.3 apex-scanner's
 * outgoing `callsApex` edges (the method-call-site index):
 *
 *   - For each ApexClass / ApexTrigger with an outgoing `callsApex`
 *     edge to the target class AND `properties.methodName ===
 *     methodName`, surface a `code-needs-update` impact.
 *   - For each Flow with an outgoing `callsApex` edge to the target
 *     class (Flow callers don't index by methodName — the Flow XML
 *     declares the action name at the class level), surface a
 *     `code-needs-update` impact. The Flow caller's confidence is
 *     `parsed` (the Flow `<actionCalls>` block is parsed out of the
 *     Flow XML by the flow extractor — flow.ts emits `confidence:
 *     'parsed'`) per the WhatIfSemantics.md "Flow caller (when target
 *     is @InvocableMethod)" rule.
 *   - For each LWC / Aura / VF caller with an outgoing `callsApex`
 *     edge to the target class AND `properties.methodName ===
 *     methodName`, surface a `code-needs-update` impact. The frontend
 *     callers' confidence is `declared` for the
 *     `@salesforce/apex/{Class}.{method}` import pattern and
 *     `heuristic` for the inferred-from-source paths.
 *
 * **Test class identification.** Per the WhatIfSemantics.md "Test
 * class identification" rules, a test class needs update when it:
 *
 *   - Has an outgoing `coversTest` edge to the target class (the v0.3
 *     extracted convention from @TestVisible / @TestSetup), OR
 *   - Has an outgoing `callsApex` edge to the target class with the
 *     matching `methodName` AND its node properties indicate it is a
 *     test class (`properties.isTest === true` per the v1.5
 *     classifier).
 *
 * Test classes flagged this way surface in BOTH the
 * `callingClasses` impacts array (with `category:
 * 'test-class-update'`) AND the `testClassesNeedingUpdate` scalar
 * array so the renderer can prioritise them without re-walking the
 * impacts list.
 *
 * **Aggregate verdict.** Mirrors R2a / the sibling component-level
 * what-if tools:
 *   - `safe` if there are NO callers at all (the method is unused or
 *     only invoked dynamically).
 *   - `risky` if at least one direct caller appears (the default for
 *     this tool — no `metadata-blocker` paths exist for method
 *     signature changes since the v0.3 extractor is heuristic).
 *   - `blocking` reserved for the case where a Flow `<actionName>`
 *     declaration references the method by name (the Flow XML is
 *     metadata-declared, so a Flow call-site to a renamed method is
 *     a metadata-deploy blocker).
 *
 * **Honesty axis.** v2.3 surfaces the verbatim disclosure per the
 * WhatIfSemantics.md fail-conservative posture. The
 * `Boundary disclosure (surfaced ALWAYS for this tool)` text from
 * WhatIfSemantics.md is the prefix; the v2.3 anchor on dynamic Apex
 * blind-spots applies (reflective `Type.forName + invoke` paths are
 * invisible). Test classes that don't follow the
 * `{TargetClassName}Test` naming convention and don't carry a
 * `coversTest` edge may be missed.
 *
 * Implementation notes:
 *   - `classApiName` is required to start with `ApexClass:`. Other
 *     prefixes return `invalid-query`.
 *   - `methodName` is required, non-empty.
 *   - `newSignature` is optional — accepted for caller-side rendering
 *     and echoed verbatim in the response so the renderer can produce
 *     before/after output. The tool does NOT validate it as Apex
 *     syntax (per WhatIfSemantics.md "Signature parsing").
 *   - Unknown ids resolve to `component-not-found`.
 *   - One `listEdges(classId, { direction: 'in', edgeType: 'callsApex' })`
 *     fan-out enumerates every incoming method-call edge. Per-caller
 *     filtering against `methodName` runs in memory — sparse-graph
 *     misses are silently dropped.
 *   - One `listEdges(classId, { direction: 'in', edgeType: 'coversTest' })`
 *     fan-out enumerates every test class with a declared coverage
 *     edge.
 *   - Callers are deduped by `id` (a caller class with multiple
 *     `callsApex` edges to the same target method surfaces once).
 *   - Impacts are sorted by `(category, componentId)` ASC for
 *     deterministic output.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import {
  attachCoverageToWhatIf,
  type CoverageCaveat,
  METHOD_SIGNATURE_REQUIRED_COVERAGE,
  type Verdict,
} from './coverage-trust.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';


/** Canonical id prefix for the ApexClass node type. */
const APEX_CLASS_PREFIX = 'ApexClass:';

/**
 * One finding category in the `WhatIfImpactItem` shape, mirroring
 * R2a's `what-if-change-field-type.ts` and R2b's
 * `what-if-deactivate-flow.ts` / `what-if-disable-trigger.ts`.
 */
type Category =
  | 'metadata-blocker'
  | 'code-needs-update'
  | 'integration-touch'
  | 'test-class-update'
  | 'invisible-risk'
  | 'configuration-only';

/**
 * One impact entry in the response's `callingClasses` array. Mirrors
 * the `WhatIfImpactItem` interface in R2a's
 * `what-if-change-field-type.ts` — scoped to the fields v2.3 R2
 * populates.
 */
export interface WhatIfImpactItem {
  readonly category: Category;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  readonly explanation: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfChangeMethodSignatureOutput {
  readonly classApiName: ComponentId;
  readonly methodName: string;
  readonly newSignature: string | null;
  readonly callingClasses: readonly WhatIfImpactItem[];
  readonly testClassesNeedingUpdate: readonly ComponentId[];
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

/**
 * The verbatim disclosure surfaced in every response. Mirrors the
 * WhatIfSemantics.md "Boundary disclosure (surfaced ALWAYS for this
 * tool)" text so the test suite can lock the phrasing.
 */
const DISCLOSURE =
  "caller confidence varies by source: Apex and Visualforce callers come from the heuristic apex-scanner (regex/token, no AST) and are reported at heuristic confidence (may include false positives); Flow callers are parsed out of the Flow XML <actionCalls> (confidence: parsed); LWC/Aura callers come from the declarative @salesforce/apex import (confidence: declared). Dynamic dispatch via Type.forName + invoke is invisible to all of them. Test classes are identified by @isTest + naming convention (className + 'Test' suffix) and by coversTest edges; a test class that doesn't follow the naming convention and doesn't carry a @TestVisible-tagged covering reference may be missed.";

/**
 * Zod schema for the `sfi.what_if_change_method_signature` tool input.
 *
 *   - `classApiName`: required, non-empty string. The canonical
 *     ApexClass id (`ApexClass:{Name}`). Non-`ApexClass:` prefixes
 *     surface as `invalid-query` from the handler; unknown but
 *     well-formed ids surface as `component-not-found`.
 *   - `methodName`: required, non-empty string. The method whose
 *     signature is hypothetically changing.
 *   - `newSignature`: optional. Accepted for caller-side rendering;
 *     echoed verbatim in the response. The tool does NOT parse this
 *     string.
 */
export const whatIfChangeMethodSignatureInputSchema = z.object({
  classApiName: z.string().min(1),
  methodName: z.string().min(1),
  newSignature: z.string().optional(),
});

/** Parsed input shape, inferred from the Zod schema. */
export type WhatIfChangeMethodSignatureInput = z.infer<
  typeof whatIfChangeMethodSignatureInputSchema
>;

/**
 * Whether a `callsApex` edge invokes `methodName` on its target class.
 *
 * P4-C5 method-level: the apex-scanner edge now carries `methods` — the
 * COMPLETE set of the target's methods this caller invokes — so a caller of
 * both `Handler.save` and `Handler.deleteRecord` matches BOTH. Before P4-C5
 * the edge kept a single `methodName` (the lossy dedup), so this tool missed
 * callers of every method but one. We prefer `methods[]` and fall back to the
 * scalar `methodName` for vaults refreshed before P4-C5. The LWC/Aura/VF
 * extractors mirror the scalar `methodName` shape; both are honoured.
 */
const callsMethod = (edge: Edge, methodName: string): boolean => {
  const methods = edge.properties['methods'];
  if (Array.isArray(methods)) {
    return methods.includes(methodName);
  }
  const raw = edge.properties['methodName'];
  return typeof raw === 'string' && raw === methodName;
};

/**
 * Check whether a node represents a test class. Mirrors the
 * `explain-apex-method.ts` `isTest` axis: the v1.5 ApexClass
 * classifier populates `properties.isTest` as a top-level boolean.
 * Triggers and other types fall through to false.
 */
const isTestClass = (node: Node): boolean => {
  if (node.type !== 'ApexClass') return false;
  const raw = node.properties['isTest'];
  return raw === true;
};

/**
 * Synthesise the per-caller `explanation` string. The phrasing
 * mirrors the sibling component-level what-if tools so the renderer
 * can rely on a uniform "the caller does X" shape across the v2.3
 * surface.
 */
const buildExplanation = (
  fromNode: Node,
  edge: Edge,
  classApiName: string,
  methodName: string,
  isTest: boolean,
): string => {
  const callerLabel = `${fromNode.type} '${fromNode.apiName}'`;
  const targetLabel = `${classApiName}.${methodName}(...)`;
  // The Flow caller branch surfaces a slightly different verb because
  // the Flow XML's <actionName> declaration is the source of truth, not
  // a regex-scanned call-site.
  const verb =
    fromNode.type === 'Flow'
      ? 'invokes'
      : isTest
        ? 'exercises'
        : edge.confidence === 'declared'
          ? 'imports and calls'
          : 'calls';
  return `${callerLabel} ${verb} ${targetLabel}; the signature change requires updating this call-site.`;
};

/**
 * Decide the per-caller category. Test classes surface as
 * `test-class-update` so the renderer can prioritise mechanical
 * test-suite updates; non-test callers surface as `code-needs-update`.
 * Flow callers with the Flow XML's `<actionName>` declaration are
 * metadata-declared, but the v2.3 tool still classifies them as
 * `code-needs-update` (the Flow's invocable-action call-site must be
 * updated; the metadata declaration itself doesn't fail to deploy —
 * only fails at runtime if the method name changes).
 */
const classifyCaller = (
  _fromNode: Node,
  isTest: boolean,
): Category => {
  if (isTest) return 'test-class-update';
  return 'code-needs-update';
};

/**
 * Aggregate the per-impact verdicts into the headline severity. The
 * cascade mirrors R2a's `aggregateVerdict`:
 *   - empty impacts → `safe` (no callers — the method is unused or
 *     only invoked dynamically).
 *   - any `metadata-blocker` → `blocking` (reserved; v2.3 does not
 *     emit `metadata-blocker` for method-signature changes today).
 *   - any non-blocker → `risky` (the default — every caller flag
 *     warrants human review).
 */
const aggregateVerdict = (impacts: readonly WhatIfImpactItem[]): Verdict => {
  if (impacts.length === 0) return 'safe';
  for (const impact of impacts) {
    if (impact.category === 'metadata-blocker') return 'blocking';
  }
  return 'risky';
};

/**
 * Comparator for the deterministic impact sort. Sort first by
 * `category` ASC then by `componentId` ASC so test classes stay
 * grouped after code callers in the rendered output.
 */
const compareImpacts = (a: WhatIfImpactItem, b: WhatIfImpactItem): number => {
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  if (a.componentId !== b.componentId) {
    return a.componentId < b.componentId ? -1 : 1;
  }
  return 0;
};

/**
 * Comparator for the deterministic test-class id sort.
 */
const compareIds = (a: ComponentId, b: ComponentId): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Walk the incoming `callsApex` edges to the target class. For each
 * edge whose `properties.methodName === methodName`, resolve the
 * source node and emit a `WhatIfImpactItem`. Sparse-graph misses are
 * silently dropped. Duplicates (a caller class with multiple
 * call-sites to the same target method) are deduped by the caller's
 * `id`.
 */
const collectCallers = async (
  ctx: Context,
  classId: ComponentId,
  classApiName: string,
  methodName: string,
): Promise<
  Result<
    {
      readonly impacts: readonly WhatIfImpactItem[];
      readonly testIds: readonly ComponentId[];
    },
    string
  >
> => {
  const edgesResult = await listEdges(ctx.graph, classId, {
    direction: 'in',
    edgeType: 'callsApex',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);

  const impactsByCaller = new Map<ComponentId, WhatIfImpactItem>();
  const testIds = new Set<ComponentId>();

  for (const edge of edgesResult.value) {
    // Flow callers don't carry a per-method index — the Flow XML
    // declares the action name at the class level. Surface them as
    // potential callers regardless of method.
    const isFlowCaller = edge.fromId.startsWith('Flow:');
    if (!isFlowCaller && !callsMethod(edge, methodName)) {
      continue;
    }
    if (impactsByCaller.has(edge.fromId)) {
      // Dedupe: a caller with multiple call-sites to the same method
      // surfaces once.
      continue;
    }
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) return err(fromResult.error.message);
    const fromNode = fromResult.value;
    if (fromNode === null) {
      // Sparse-graph miss — drop silently.
      continue;
    }
    const isTest = isTestClass(fromNode);
    const category = classifyCaller(fromNode, isTest);
    impactsByCaller.set(edge.fromId, {
      category,
      componentId: fromNode.id,
      componentType: fromNode.type,
      apiName: fromNode.apiName,
      confidence: edge.confidence,
      explanation: buildExplanation(
        fromNode,
        edge,
        classApiName,
        methodName,
        isTest,
      ),
    });
    if (isTest) testIds.add(fromNode.id);
  }

  return ok({
    impacts: [...impactsByCaller.values()],
    testIds: [...testIds],
  });
};

/**
 * Walk the incoming `coversTest` edges to the target class. The v0.3
 * extractor populates these from `@TestVisible` / `@TestSetup`
 * annotations and the `className + 'Test'` naming convention. Each
 * source class is a test class that exercises the target — surfaces
 * in both the `callingClasses` array (with `category:
 * 'test-class-update'`) and the `testClassesNeedingUpdate` scalar.
 */
const collectCoveringTests = async (
  ctx: Context,
  classId: ComponentId,
  classApiName: string,
  methodName: string,
): Promise<
  Result<
    {
      readonly impacts: readonly WhatIfImpactItem[];
      readonly testIds: readonly ComponentId[];
    },
    string
  >
> => {
  const edgesResult = await listEdges(ctx.graph, classId, {
    direction: 'in',
    edgeType: 'coversTest',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);

  const impacts: WhatIfImpactItem[] = [];
  const testIds: ComponentId[] = [];

  for (const edge of edgesResult.value) {
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) return err(fromResult.error.message);
    const fromNode = fromResult.value;
    if (fromNode === null) continue;
    impacts.push({
      category: 'test-class-update',
      componentId: fromNode.id,
      componentType: fromNode.type,
      apiName: fromNode.apiName,
      confidence: edge.confidence,
      explanation: buildExplanation(
        fromNode,
        edge,
        classApiName,
        methodName,
        true,
      ),
    });
    testIds.push(fromNode.id);
  }

  return ok({ impacts, testIds });
};

/**
 * The `sfi.what_if_change_method_signature` MCP tool. Given an
 * ApexClass id, a method name, and an optional new signature, returns
 * the structured caller list, the test-class-needing-update axis, an
 * aggregated severity verdict, and the verbatim boundary disclosure.
 * See the module JSDoc for the classification rules.
 *
 * @example
 *   const r = await whatIfChangeMethodSignatureHandler(ctx, {
 *     classApiName: 'ApexClass:OpportunityService',
 *     methodName: 'processOpp',
 *     newSignature: 'processOpp(Opportunity opp, Boolean isUpdate)',
 *   });
 *   if (r.ok) console.log(r.value.data.callingClasses.length);
 */
export const whatIfChangeMethodSignatureHandler = async (
  ctx: Context,
  input: WhatIfChangeMethodSignatureInput,
): Promise<
  Result<McpResponse<WhatIfChangeMethodSignatureOutput>, McpError>
> => {
  const classApiName = coercePrefix(input.classApiName, [APEX_CLASS_PREFIX]);
  if (!classApiName.startsWith(APEX_CLASS_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `classApiName must be an ApexClass id (e.g. '${APEX_CLASS_PREFIX}Foo') or a bare class name (e.g. 'Foo'); got '${input.classApiName}'`,
      path: 'classApiName',
    });
  }

  const classId = classApiName as ComponentId;
  const methodName = input.methodName;
  const newSignature = input.newSignature ?? null;

  const nodeResult = await getNodeById(ctx.graph, classId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, classId, 'ApexClass'),
      path: classId,
    });
  }

  const classNode = nodeResult.value;

  // Defensive: the prefix pins the expected type, but the graph
  // round-trip could in principle return a different `type`. Treat
  // that as `component-not-found`.
  if (classNode.type !== 'ApexClass') {
    return err({
      kind: 'component-not-found',
      message: `node ${classId} is not an ApexClass (type=${classNode.type})`,
      path: classId,
    });
  }

  const callersResult = await collectCallers(
    ctx,
    classId,
    classNode.apiName,
    methodName,
  );
  if (!callersResult.ok) {
    return err({ kind: 'internal', message: callersResult.error });
  }

  const coveringTestsResult = await collectCoveringTests(
    ctx,
    classId,
    classNode.apiName,
    methodName,
  );
  if (!coveringTestsResult.ok) {
    return err({ kind: 'internal', message: coveringTestsResult.error });
  }

  // Merge caller impacts with covering-test impacts. A class that
  // both directly calls the method AND declares a coversTest edge
  // surfaces once: the explicit caller wins (its confidence reflects
  // the actual call-site, not the coverage annotation). Dedupe by
  // componentId.
  const mergedById = new Map<ComponentId, WhatIfImpactItem>();
  for (const impact of callersResult.value.impacts) {
    mergedById.set(impact.componentId, impact);
  }
  for (const impact of coveringTestsResult.value.impacts) {
    if (!mergedById.has(impact.componentId)) {
      mergedById.set(impact.componentId, impact);
    }
  }

  const sortedImpacts = [...mergedById.values()].sort(compareImpacts);

  // Merge test ids from both sources; dedupe and sort.
  const testIdSet = new Set<ComponentId>([
    ...callersResult.value.testIds,
    ...coveringTestsResult.value.testIds,
  ]);
  const sortedTestIds = [...testIdSet].sort(compareIds);

  const rawVerdict = aggregateVerdict(sortedImpacts);
  const coverage = attachCoverageToWhatIf(
    ctx,
    METHOD_SIGNATURE_REQUIRED_COVERAGE,
    'Method signature change impact',
    rawVerdict,
  );

  return ok({
    data: {
      classApiName: classId,
      methodName,
      newSignature,
      callingClasses: sortedImpacts,
      testClassesNeedingUpdate: sortedTestIds,
      verdict: coverage.verdict as Verdict,
      ...(coverage.coverageCaveat !== undefined
        ? { coverageCaveat: coverage.coverageCaveat }
        : {}),
      trust: coverage.trust,
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
