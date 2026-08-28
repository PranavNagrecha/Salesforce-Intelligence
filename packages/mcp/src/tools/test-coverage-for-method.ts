/**
 * Handler for the `sfi.test_coverage_for_method` MCP tool.
 *
 * Answers the developer's "which test classes cover this Apex class?"
 * (or, when v2.7.1 ships, this method) question. Composes an upstream
 * BFS from `classApiName` over incoming `callsApex` AND
 * `dispatchesAsync` edges and filters the BFS-reached set to nodes with
 * `properties.isTest === true`.
 *
 * **Granularity (v2.7 honesty boundary, load-bearing)**: v2.7 ships
 * CLASS-level coverage. A class is "covered" when at least one test
 * class can reach it via incoming `callsApex` / `dispatchesAsync` edges
 * within the depth cap. The `methodName` input is ACCEPTED and echoed
 * verbatim into the response so callers can pipeline through a future
 * v2.7.1 method-scoped resolution — but v2.7 does NOT subset coverage
 * by method.
 *
 * **Composition model**:
 *   1. Validate the `ApexClass:` / `ApexTrigger:` prefix; reject
 *      other prefixes as `invalid-query`.
 *   2. `getNodeById` against the target — unknown surfaces as
 *      `component-not-found`.
 *   3. BFS upstream over incoming `callsApex` AND `dispatchesAsync`
 *      edges, bounded by the v2.1 depth-3 cap inherited from
 *      `sfi.test_coverage_gaps`. Following `dispatchesAsync` catches
 *      tests that exercise a batch/queueable/schedulable class via
 *      async dispatch (`Database.executeBatch(new XBatch())`), which
 *      links through `dispatchesAsync` rather than `callsApex`.
 *      A class genuinely tested via dynamic dispatch
 *      (`Type.forName('...').newInstance().method(...)`) is invisible
 *      to the heuristic — surfaced in the disclosure verbatim.
 *   4. Resolve each upstream node; emit those with
 *      `properties.isTest === true` as `coveringTestClasses[]`.
 *
 * **TCFM-CERTIFIED-ZERO (the certified-zero fix)**: the walk above sees only
 * CALL paths. The most common Apex coverage topology in Salesforce is not a
 * call — a test does DML on an object, the object's trigger fires, the trigger
 * calls a helper class — and `coversTest`, the edge type that would express it,
 * is declared in contracts but emitted by NO extractor, so no vault holds one.
 * The tool used to answer `totalCoveringCount: 0` with
 * `soundness { complete: true, blindSpots: [], staticCoverage: 'full' }` for
 * exactly that shape. Two changes: (a) `triggerMediatedCoverage` reconstructs
 * the path from `triggersOn` + `writesTo`, which DO exist, and names the
 * candidate tests; (b) soundness is DERIVED from what the walk traversed via
 * `soundnessForReachabilityWalk`, so the un-traversed usage edge types are named
 * in `unwalkedEdgeTypes` and no answer here claims completeness it lacks.
 *
 * **TCFM-TRIGGER-BARE-NAME**: a bare name is probed against BOTH `ApexClass:`
 * and `ApexTrigger:` (it used to be hard-prefixed `ApexClass:`, making every
 * trigger unreachable by bare name through all three selectors), and the
 * not-found text names exactly the ids that were looked up. On a two-family
 * miss `error.path` carries the BARE NAME the caller passed, never a
 * synthesized `ApexClass:` id: the typed field a machine consumer reads must
 * not re-assert the single-family search the message disclaims.
 *
 * Implementation notes:
 *   - The walk visits each id at most once. Cycles do not loop.
 *   - Test classes are SORTED by id ASC so the response is
 *     deterministic across runs.
 *   - When the target is itself a test class, the response carries
 *     an empty list and the disclosure (it can't "cover itself").
 */

import type {
  ComponentId,
  EdgeType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listChildren,
  listEdges,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { firstNonEmpty } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { soundnessForReachabilityWalk, type Soundness } from './soundness.js';

/**
 * BFS depth cap. Matches the v2.1 `sfi.test_coverage_gaps`
 * `MAX_COVERAGE_DEPTH` and the v0.3 `find_apex_usages` BFS budget.
 */
const COVERAGE_BFS_DEPTH = 3;

/**
 * Incoming edge types the upstream coverage walk follows. `callsApex`
 * is the direct invocation edge; `dispatchesAsync` captures async
 * dispatch (`Database.executeBatch(new XBatch())`,
 * `System.enqueueJob(new MyQueueable())`, `System.schedule(...)`),
 * which a test exercising a batch/queueable/schedulable class links
 * through INSTEAD of `callsApex`. Without it, batch-tested classes
 * surface as a false-negative "uncovered".
 */
const COVERAGE_EDGE_TYPES: readonly EdgeType[] = [
  'callsApex',
  'dispatchesAsync',
];

/**
 * TCFM-CERTIFIED-ZERO — the edge pair that reconstructs TRIGGER/DML-MEDIATED
 * coverage, the single most common Apex coverage topology in Salesforce: a test
 * does DML on an object, the object's trigger fires, the trigger calls a helper
 * class. There is NO Apex-to-Apex edge on that path — `coversTest` is declared in
 * contracts and emitted by NO extractor (`packages/contracts` states it verbatim),
 * so no vault has ever held one — and the walk over {@link COVERAGE_EDGE_TYPES}
 * therefore returns a TRUE-shaped zero for a class a test class exercises on
 * every deploy. `triggersOn` (trigger -> object) joined to `writesTo` (test ->
 * a field of that object) recovers the path from edges that DO exist.
 */
const DML_MEDIATED_EDGE_TYPES: readonly EdgeType[] = ['triggersOn', 'writesTo'];

/**
 * Every edge type that can relay coverage onto an Apex component, whether or not
 * this walk traverses it. Passed to `soundnessForReachabilityWalk` so
 * `soundness.blindSpots` NAMES the un-traversed remainder instead of the tool
 * asserting a completeness it does not have. `references` is in the set and is
 * never walked: a test that touches the target only through a generic
 * `references` edge (a constant read, a `new` of a type the call scanner did not
 * resolve to `callsApex`) is absent from every answer this tool gives.
 */
const COVERAGE_USAGE_EDGE_TYPES: readonly EdgeType[] = [
  ...COVERAGE_EDGE_TYPES,
  ...DML_MEDIATED_EDGE_TYPES,
  'references',
];

/**
 * Cap on the NAMED trigger-mediated candidate tests. The count beside the list is
 * the TRUE total; `listTruncated` says when names were omitted. There is no
 * cursor for this section — adding one needs a `cursor` key on the advertised
 * inputSchema, which lives in the shared roster.
 */
const TRIGGER_MEDIATED_LIST_CAP = 50;

/** Canonical id prefixes the tool accepts. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/** Prefix of a `triggersOn` target that names an SObject. */
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

/** The two Apex families this tool targets, in probe order for a bare name. */
const APEX_KINDS = ['ApexClass', 'ApexTrigger'] as const;
type ApexKind = (typeof APEX_KINDS)[number];

/**
 * TCFM-CERTIFIED-ZERO — appended VERBATIM to both disclosures. A host reads the
 * prose aloud; the structured fields alone let it say "nothing covers this".
 */
const TRIGGER_MEDIATED_DISCLOSURE =
  'TRIGGER/DML-MEDIATED COVERAGE IS NOT AN EDGE IN THIS GRAPH. The coversTest edge type is declared but emitted by NO extractor, graph-build mint, or enricher in this product, so no vault contains one; and a test that covers this code by doing DML on an object whose trigger calls it has no callsApex/dispatchesAsync path to it. totalCoveringCount therefore counts only tests that reach this component through a CALL path — a 0 means "no calling test found among the edge types walked", NEVER "no test covers this". triggerMediatedCoverage reconstructs the missing path from the edges that DO exist: the ApexTriggers on the upstream call path, the objects they fire on (triggersOn), and the test classes that write fields on those objects (writesTo). Those candidates are HEURISTIC — a field write in a test is strong evidence of DML but is not proof the record is inserted or updated, and a test that only reads is not listed. soundness.blindSpots names, in unwalkedEdgeTypes, every usage edge type this walk did not traverse. Do not delete, rename, or resign a method on the strength of a zero here: read the named candidate tests, or run the deploy against a sandbox.';

/**
 * Verbatim v2.7 honesty disclosure. Method-level granularity promised
 * for v2.7.1; dynamic dispatch is invisible to the heuristic.
 */
const COVERAGE_DISCLOSURE =
  'test_coverage_for_method ships CLASS granularity for a class-level query (no methodName). The upstream walk follows both callsApex and dispatchesAsync incoming edges, so coverage exercised via async dispatch (Database.executeBatch, System.enqueueJob, System.schedule) is included. A test class is a coverage SINK — it is recorded as covering but the walk never traverses THROUGH it, so a test is never credited with covering a class its own production code never references. Dynamic dispatch (Type.forName) and reflective invocation are still invisible. BFS is capped at depth 3; coverage chains longer than 3 hops surface as uncovered even when they exist. calloutCoverage (present only when the target implements Database.AllowsCallouts) cross-references covering tests against mock usage: setsMock is heuristic — derived from a test implementing an Apex mock interface (HttpCalloutMock / WebServiceMock), so a test that instead references a SEPARATE mock class via Test.setMock(MyMock.class) reads false; coveredOnlyByMockLessTests flags the inflated-coverage anti-pattern (callout code covered, but no covering test installs a mock). ' +
  TRIGGER_MEDIATED_DISCLOSURE;

const COVERAGE_METHOD_DISCLOSURE =
  'methodName given: each covering test carries `exercisesMethod` (P4-test-reachability) — true when its shortest reaching path enters the target via a callsApex edge whose methods[] (P4-C5) includes methodName, i.e. it actually exercises the changed method, not just the class. This is heuristic and shortest-path: a test reaching the method only via a longer alternate path may read false, and dispatchesAsync hops carry no method index (treated as not-method-specific). methods[] populates only on vaults refreshed after P4-C5; older vaults fall back to the scalar methodName. The upstream walk still follows callsApex + dispatchesAsync; dynamic/reflective dispatch invisible; BFS capped at depth 3. ' +
  TRIGGER_MEDIATED_DISCLOSURE;

/**
 * Zod schema for the `sfi.test_coverage_for_method` tool input.
 *
 *   - `classApiName` / `componentId` / `apiName`: the target Apex class /
 *     trigger, interchangeable (a host naturally reaches for `componentId` as
 *     on sibling Apex tools). Each accepts a bare name or a canonical
 *     `ApexClass:` / `ApexTrigger:` id; non-matching prefixes surface as
 *     `invalid-query` at the handler boundary. Disagreeing selectors are
 *     `invalid-query` (never a silent pick); at least one is required.
 *   - `methodName`: optional. v2.7 echoes the value verbatim into the
 *     response; v2.7.1 will use it to subset coverage at the method
 *     edge level.
 */
export const testCoverageForMethodInputSchema = z.object({
  classApiName: z.string().min(1).optional(),
  componentId: z.string().min(1).optional(),
  apiName: z.string().min(1).optional(),
  methodName: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type TestCoverageForMethodInput = z.infer<
  typeof testCoverageForMethodInputSchema
>;

/**
 * TCFM-TRIGGER-BARE-NAME — one selector parsed into (family, api name).
 *
 * The old shape ran every selector through the shared `coercePrefix`, whose
 * bare-name branch appends the PRIMARY accepted prefix — here `ApexClass:`. The
 * tool's own contract advertises "an ApexClass: or ApexTrigger: id ... a bare
 * name or the canonical id", so every ApexTrigger in a vault was unreachable by
 * bare name through all three selectors, and the resulting not-found message
 * ("no ApexClass or ApexTrigger with id ApexClass:X") asserted a two-family
 * search the echoed id disproves. Parsing the family OUT instead lets the
 * handler probe BOTH families for a bare name and say exactly which ids it
 * looked up. `coercePrefix` is untouched — its single-family callers still need
 * its behavior; this tool is the two-family case it cannot express.
 */
interface TargetSelector {
  /** The api name with any accepted `Type:` prefix stripped. */
  readonly name: string;
  /** The family the caller NAMED, or `null` when they passed a bare name. */
  readonly kind: ApexKind | null;
}

/** `ApexClass` + `Foo` -> `ApexClass:Foo`. */
const toApexId = (kind: ApexKind, name: string): ComponentId =>
  `${kind}:${name}` as ComponentId;

/**
 * Parse one raw selector value. Returns `null` for a value carrying a
 * DIFFERENT `Type:` prefix (a wrong-type id) so the caller can reject it with
 * the precise wrong-type message.
 */
const parseSelector = (raw: string): TargetSelector | null => {
  if (raw.startsWith(APEX_CLASS_PREFIX)) {
    return { name: raw.slice(APEX_CLASS_PREFIX.length), kind: 'ApexClass' };
  }
  if (raw.startsWith(APEX_TRIGGER_PREFIX)) {
    return { name: raw.slice(APEX_TRIGGER_PREFIX.length), kind: 'ApexTrigger' };
  }
  if (raw.includes(':')) return null;
  return { name: raw, kind: null };
};

/**
 * Resolve the single target selector from the interchangeable
 * `classApiName` / `componentId` / `apiName` inputs. Disagreeing selectors →
 * `invalid-query` (never a silent pick); none → `invalid-query`. A bare name
 * alongside a prefixed id for the SAME api name AGREES — the prefixed one
 * decides the family.
 */
const resolveTargetSelector = (
  input: TestCoverageForMethodInput,
): Result<TargetSelector, McpError> => {
  const raws = [input.classApiName, input.componentId, input.apiName]
    .map((v) => firstNonEmpty(v))
    .filter((v): v is string => v !== undefined);
  if (raws.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'name the Apex class — pass `classApiName` (e.g. "OrderService"), `componentId` (`ApexClass:OrderService`), or `apiName`',
      path: 'classApiName',
    });
  }
  const parsed: TargetSelector[] = [];
  for (const raw of raws) {
    const sel = parseSelector(raw);
    if (sel === null) {
      return err({
        kind: 'invalid-query',
        message: `classApiName must be an ApexClass/ApexTrigger id (e.g. '${APEX_CLASS_PREFIX}Foo') or a bare class name (e.g. 'Foo'); got '${raw}'`,
        path: 'classApiName',
      });
    }
    parsed.push(sel);
  }
  const names = [...new Set(parsed.map((s) => s.name))];
  const kinds = [...new Set(parsed.map((s) => s.kind).filter((k): k is ApexKind => k !== null))];
  if (names.length > 1 || kinds.length > 1) {
    const shown = [...new Set(raws)].join(', ');
    return err({
      kind: 'invalid-query',
      message: `class selectors name different targets (${shown}); pass exactly one of classApiName / componentId / apiName`,
      path: 'classApiName',
    });
  }
  return ok({ name: names[0] as string, kind: kinds[0] ?? null });
};

/** One covering test class entry in the response. */
export interface CoveringTestClass {
  readonly id: ComponentId;
  readonly apiName: string;
  /** The shortest-path BFS depth at which this test class was reached. */
  readonly depth: number;
  /**
   * P4-test-reachability: present ONLY when `methodName` was supplied. `true`
   * when this test's shortest reaching path enters the target via a `callsApex`
   * edge whose `methods[]` (P4-C5) includes `methodName` — i.e. the test
   * actually exercises the CHANGED method, not merely the class. `false` means
   * it reaches the class but (on its shortest path) not via that method.
   */
  readonly exercisesMethod?: boolean;
  /**
   * Callout-mock cross-reference (present only when the target class makes
   * callouts — `calloutCoverage.targetMakesCallout === true`). `true` when this
   * test installs an Apex mock interface (`HttpCalloutMock` / `WebServiceMock`),
   * so it exercises the callout against a fake; `false` when it reaches the
   * callout code with no mock in its own implements list — a real-endpoint /
   * mock-less covering test.
   */
  readonly setsMock?: boolean;
}

/**
 * Callout-vs-mock cross-reference: lets a caller answer "is this callout class
 * covered exclusively by mock-less tests?" without re-reading source. Present
 * only when the target class makes callouts.
 */
export interface CalloutCoverage {
  /** True when the target class implements `Database.AllowsCallouts`. */
  readonly targetMakesCallout: boolean;
  /** Covering tests that install a mock interface (exercise the callout faked). */
  readonly mockSettingTestCount: number;
  /** Covering tests that reach the callout code with no mock in their implements list. */
  readonly mockLessTestCount: number;
  /**
   * True when the callout code is covered ONLY by mock-less tests (≥1 covering
   * test, none of which set a mock) — the inflated-coverage anti-pattern: the
   * line counts as covered but no test validates the callout against a fake.
   * False when at least one covering test sets a mock, or when there is no
   * covering test at all (that is plain "uncovered", reported separately).
   */
  readonly coveredOnlyByMockLessTests: boolean;
}

/** One trigger-mediated candidate test. */
export interface TriggerMediatedTest {
  readonly id: ComponentId;
  readonly apiName: string;
  /** The trigger object(s) this test writes fields on — the DML that fires the chain. */
  readonly viaObjects: readonly ComponentId[];
}

/**
 * TCFM-CERTIFIED-ZERO — the coverage the CALL walk structurally cannot see.
 *
 * Present only when an `ApexTrigger` sits on the target's upstream call path (or
 * IS the target); `null` otherwise, because then no DML can reach the target
 * through a trigger and there is nothing to disclose. Never folded into
 * `coveringTestClasses` / `totalCoveringCount`: those keep their exact
 * call-path meaning, and this block is the separately-labelled heuristic beside
 * them.
 */
export interface TriggerMediatedCoverage {
  /** ApexTriggers on the target's upstream call path, sorted. */
  readonly triggers: readonly ComponentId[];
  /** Objects those triggers fire on (`triggersOn`), sorted. */
  readonly triggerObjects: readonly ComponentId[];
  /**
   * Test classes writing fields on those objects — DML in the test fires the
   * trigger, which runs the target. EXCLUDES the target itself and any test
   * already reported in `coveringTestClasses`, so the two lists never
   * double-count one test. Capped; see `listTruncated`.
   */
  readonly candidateTestClasses: readonly TriggerMediatedTest[];
  /** TRUE total before the list cap — never the length of the capped list. */
  readonly candidateTestCount: number;
  /** True when `candidateTestClasses` omits names `candidateTestCount` counts. */
  readonly listTruncated: boolean;
  /**
   * Always `'heuristic'`: a field write in a test is strong evidence of DML but
   * is not proof the record is inserted or updated.
   */
  readonly confidence: 'heuristic';
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface TestCoverageForMethodOutput {
  /**
   * Echoes the class scope ACTUALLY resolved so a host that passed a
   * `componentId` / `apiName` alias sees it was honored, not silently stripped.
   * Always `component` mode — the tool is single-class by contract.
   */
  readonly appliedScope: {
    readonly component: ComponentId;
    readonly mode: 'component';
  };
  readonly classApiName: ComponentId;
  readonly methodName: string | null;
  readonly coveringTestClasses: readonly CoveringTestClass[];
  readonly totalCoveringCount: number;
  /**
   * Callout-mock cross-reference. Present only when the target class makes
   * callouts (`implements Database.AllowsCallouts`); `null` otherwise so the
   * common no-callout class stays uncluttered.
   */
  readonly calloutCoverage: CalloutCoverage | null;
  /**
   * P4-test-reachability: count of covering tests with `exercisesMethod === true`.
   * `null` when no `methodName` was supplied (class-level query).
   */
  readonly methodCoveringCount: number | null;
  /**
   * TCFM-CERTIFIED-ZERO: coverage that reaches the target through a trigger's
   * DML rather than an Apex call. `null` when no trigger is on the upstream
   * path. Read this before trusting a `totalCoveringCount` of 0.
   */
  readonly triggerMediatedCoverage: TriggerMediatedCoverage | null;
  /** Static-analysis blind spots: `complete: false` when the analyzed class uses dynamic Apex. */
  readonly soundness: Soundness;
  readonly disclosure: string;
}

const isApexCallable = (id: string): boolean =>
  id.startsWith(APEX_CLASS_PREFIX) || id.startsWith(APEX_TRIGGER_PREFIX);

const isTestClass = (node: Node): boolean =>
  node.properties['isTest'] === true;

/**
 * Read a node's parsed `implements` interface list (extractor-populated on
 * ApexClass nodes). Returns an empty array when absent or malformed so callers
 * can `.some(...)` without a guard.
 */
const implementsList = (node: Node): readonly string[] => {
  const raw = node.properties['implements'];
  return Array.isArray(raw) ? (raw.filter((x) => typeof x === 'string') as string[]) : [];
};

/**
 * Whether a class is annotated to make HTTP callouts. The honest, offline
 * signal is `implements Database.AllowsCallouts` (required for synchronous
 * callouts from async Apex) — surfaced verbatim in the parsed `implements`
 * list. This is a heuristic presence signal, NOT proof a callout fires at
 * runtime; the disclosure says so.
 */
const makesCallout = (node: Node): boolean =>
  implementsList(node).some((i) => i === 'Database.AllowsCallouts');

/**
 * Whether a TEST class installs an HTTP/WebService mock. A test that exercises
 * callout code without `Test.setMock` will hit a real endpoint (or throw) — the
 * honest offline signal that it sets a mock is that it implements one of the
 * Apex mock interfaces (`HttpCalloutMock`, `WebServiceMock`,
 * `HttpCalloutMockInterface`). Heuristic: a test could also reference a
 * separate mock class via `Test.setMock(...)`, which the implements list does
 * not capture — surfaced in the disclosure.
 */
const MOCK_INTERFACES: ReadonlySet<string> = new Set([
  'HttpCalloutMock',
  'WebServiceMock',
  'HttpCalloutMockInterface',
]);
const setsMock = (node: Node): boolean =>
  implementsList(node).some((i) => MOCK_INTERFACES.has(i));

/**
 * Whether a `callsApex` edge invokes `methodName` on its target (P4-C5).
 * Prefers the complete `methods[]`; falls back to the scalar `methodName` for
 * pre-P4-C5 vaults. `dispatchesAsync` edges carry no method index → false.
 */
const edgeCallsMethod = (
  edge: { readonly edgeType: EdgeType; readonly properties: Readonly<Record<string, unknown>> },
  methodName: string,
): boolean => {
  if (edge.edgeType !== 'callsApex') return false;
  const methods = edge.properties['methods'];
  if (Array.isArray(methods)) return methods.includes(methodName);
  const scalar = edge.properties['methodName'];
  return typeof scalar === 'string' && scalar === methodName;
};

/**
 * BFS upstream from `targetId` over INCOMING coverage edges (both
 * `callsApex` and `dispatchesAsync` — see `COVERAGE_EDGE_TYPES`).
 * Returns the depth at which each upstream id was first discovered. The
 * walk visits each id at most once; the dedupe is edge-type-agnostic,
 * so a node reachable via both edge types is recorded once at its
 * first-discovered (shortest) depth.
 */
const upstreamWalk = async (
  ctx: Context,
  targetId: ComponentId,
  maxDepth: number,
  methodName: string | undefined,
  loadNode: (id: ComponentId) => Promise<Result<Node | null, string>>,
): Promise<Result<Map<ComponentId, { depth: number; exercisesMethod: boolean }>, string>> => {
  const discovered = new Map<ComponentId, { depth: number; exercisesMethod: boolean }>();
  let frontier: { id: ComponentId; exercisesMethod: boolean }[] = [
    { id: targetId, exercisesMethod: false },
  ];
  const visited = new Set<ComponentId>([targetId]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: { id: ComponentId; exercisesMethod: boolean }[] = [];
    for (const { id, exercisesMethod: parentExercises } of frontier) {
      for (const edgeType of COVERAGE_EDGE_TYPES) {
        const r = await listEdges(ctx.graph, id, {
          direction: 'in',
          edgeType,
        });
        if (!r.ok) return err(r.error.message);
        for (const edge of r.value) {
          // The edge into the TARGET (depth 1) decides method exercise via its
          // methods[]; deeper nodes inherit (their path to target passes through
          // that method-calling edge). No methodName → flag is irrelevant.
          const edgeExercises =
            methodName === undefined
              ? false
              : id === targetId
                ? edgeCallsMethod(edge, methodName)
                : parentExercises;
          if (visited.has(edge.fromId)) {
            // A node reachable via BOTH a method-exercising and a non-exercising
            // path should report `true` — upgrade in place (no re-queue).
            const rec = discovered.get(edge.fromId);
            if (rec !== undefined && edgeExercises && !rec.exercisesMethod) {
              discovered.set(edge.fromId, { depth: rec.depth, exercisesMethod: true });
            }
            continue;
          }
          visited.add(edge.fromId);
          discovered.set(edge.fromId, { depth: depth + 1, exercisesMethod: edgeExercises });
          // A test class is a coverage SINK: record it, but never walk THROUGH
          // it. Nothing legitimately calls a test, so following an incoming
          // edge into a test node would credit the far side as covering the
          // target via a path that never touches the target's code — the
          // fabricated-dependency bug. Only non-test relays grow the frontier.
          const nodeRes = await loadNode(edge.fromId);
          if (!nodeRes.ok) return nodeRes;
          const node = nodeRes.value;
          if (node !== null && isTestClass(node)) continue;
          next.push({ id: edge.fromId, exercisesMethod: edgeExercises });
        }
      }
    }
    frontier = next;
  }
  return ok(discovered);
};

/**
 * TCFM-CERTIFIED-ZERO — reconstruct trigger/DML-mediated coverage from the edges
 * that DO exist.
 *
 *   trigger --triggersOn--> object --(parentOf)--> field <--writesTo-- test class
 *
 * `triggerIds` are the ApexTriggers the upstream call walk already discovered
 * (plus the target when it IS a trigger), so the join is bounded by that walk,
 * not by the vault. Object-level `writesTo` targets are included alongside the
 * field-level ones because both shapes occur.
 *
 * `excludedIds` carries the target id (R3: a component is never its own coverer)
 * and every id already reported in `coveringTestClasses`, so the two lists never
 * double-count one test.
 */
const buildTriggerMediatedCoverage = async (
  ctx: Context,
  triggerIds: readonly ComponentId[],
  excludedIds: ReadonlySet<ComponentId>,
): Promise<Result<TriggerMediatedCoverage | null, string>> => {
  if (triggerIds.length === 0) return ok(null);
  const firesOn = await listEdgesForNodes(ctx.graph, triggerIds, {
    direction: 'out',
    edgeTypes: ['triggersOn'],
  });
  if (!firesOn.ok) return err(firesOn.error.message);
  const triggerObjects = [
    ...new Set(
      [...firesOn.value.values()]
        .flat()
        .map((e) => e.toId)
        .filter((id) => id.startsWith(CUSTOM_OBJECT_PREFIX)),
    ),
  ].sort();
  const base = {
    triggers: [...triggerIds].sort(),
    triggerObjects,
    confidence: 'heuristic',
  } as const;
  if (triggerObjects.length === 0) {
    return ok({
      ...base,
      candidateTestClasses: [],
      candidateTestCount: 0,
      listTruncated: false,
    });
  }
  // Every DML target that means "a record of this object": the object node
  // itself plus each of its fields. `dmlTargetObject` remembers which object
  // each one belongs to so the answer can name it.
  const dmlTargetObject = new Map<ComponentId, ComponentId>();
  for (const objectId of triggerObjects) {
    dmlTargetObject.set(objectId, objectId);
    const fields = await listChildren(ctx.graph, objectId);
    if (!fields.ok) return err(fields.error.message);
    for (const field of fields.value) dmlTargetObject.set(field.id, objectId);
  }
  const writers = await listEdgesForNodes(ctx.graph, [...dmlTargetObject.keys()], {
    direction: 'in',
    edgeTypes: ['writesTo'],
  });
  if (!writers.ok) return err(writers.error.message);
  const objectsByWriter = new Map<ComponentId, Set<ComponentId>>();
  for (const [dmlTargetId, edges] of writers.value) {
    const objectId = dmlTargetObject.get(dmlTargetId);
    if (objectId === undefined) continue;
    for (const edge of edges) {
      if (excludedIds.has(edge.fromId)) continue;
      if (!isApexCallable(edge.fromId)) continue;
      const seen = objectsByWriter.get(edge.fromId);
      if (seen === undefined) objectsByWriter.set(edge.fromId, new Set([objectId]));
      else seen.add(objectId);
    }
  }
  const writerNodes = await listNodesByIds(ctx.graph, [...objectsByWriter.keys()]);
  if (!writerNodes.ok) return err(writerNodes.error.message);
  const candidates: TriggerMediatedTest[] = writerNodes.value
    .filter((node) => isTestClass(node))
    .map((node) => ({
      id: node.id,
      apiName: node.apiName,
      viaObjects: [...(objectsByWriter.get(node.id) ?? new Set<ComponentId>())].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok({
    ...base,
    candidateTestClasses: candidates.slice(0, TRIGGER_MEDIATED_LIST_CAP),
    candidateTestCount: candidates.length,
    listTruncated: candidates.length > TRIGGER_MEDIATED_LIST_CAP,
  });
};

/**
 * The `sfi.test_coverage_for_method` MCP tool. Returns the list of
 * test classes that cover the target class (or method, in v2.7.1) via
 * upstream `callsApex` walks.
 *
 * @example
 *   const r = await testCoverageForMethodHandler(ctx, {
 *     classApiName: 'ApexClass:OrderService',
 *   });
 *   if (r.ok) console.log(r.value.data.totalCoveringCount);
 */
export const testCoverageForMethodHandler = async (
  ctx: Context,
  input: TestCoverageForMethodInput,
): Promise<Result<McpResponse<TestCoverageForMethodOutput>, McpError>> => {
  // Resolve the single target from the interchangeable classApiName /
  // componentId / apiName selectors (never silently stripping a mismatched one).
  const scopeRes = resolveTargetSelector(input);
  if (!scopeRes.ok) return scopeRes;
  const selector = scopeRes.value;

  // Per-id node cache shared by the existence check, the walk's test-sink
  // decision, and the post-walk classification — each node is fetched once.
  const nodeCache = new Map<ComponentId, Node | null>();
  const loadNode = async (id: ComponentId): Promise<Result<Node | null, string>> => {
    const cached = nodeCache.get(id);
    if (cached !== undefined) return ok(cached);
    const r = await getNodeById(ctx.graph, id);
    if (!r.ok) return err(r.error.message);
    nodeCache.set(id, r.value);
    return ok(r.value);
  };

  // TCFM-TRIGGER-BARE-NAME: a bare name is probed against BOTH families, so a
  // trigger is reachable by bare name through every selector; a caller who
  // NAMED a family gets exactly that one looked up, and the error text below
  // claims only the search that actually ran.
  const probeKinds: readonly ApexKind[] =
    selector.kind !== null ? [selector.kind] : APEX_KINDS;
  const probedIds = probeKinds.map((kind) => toApexId(kind, selector.name));
  const foundIds: ComponentId[] = [];
  let targetNode: Node | null = null;
  for (const id of probedIds) {
    const res = await loadNode(id);
    if (!res.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${res.error}` });
    }
    if (res.value !== null) {
      foundIds.push(id);
      targetNode = targetNode ?? res.value;
    }
  }
  if (foundIds.length === 0) {
    // A missing id is not one state. `phantomAwareNotFoundMessage` distinguishes
    // genuinely-unknown from PHANTOM (referenced by this org, definition never
    // retrieved) — a distinction the bare-name branch must not lose just because
    // it looked up two ids instead of one. Keep every non-plain message.
    const disclosures: string[] = [];
    for (const id of probedIds) {
      const kindLabel = id.slice(0, id.indexOf(':'));
      const msg = await phantomAwareNotFoundMessage(ctx, id, kindLabel);
      if (msg !== `no ${kindLabel} with id ${id}`) disclosures.push(msg);
    }
    const message =
      probedIds.length === 1
        ? await phantomAwareNotFoundMessage(
            ctx,
            probedIds[0] as ComponentId,
            probeKinds[0] as ApexKind,
          )
        : `no ApexClass or ApexTrigger node matches the bare name \`${selector.name}\` — ` +
          `\`${probedIds.join('` and `')}\` were both looked up in this vault. ` +
          (disclosures.length > 0
            ? disclosures.join(' ')
            : `Run \`sfi.resolve\` on the name for near-matches, or pass the canonical ` +
              `id if the component belongs to another type.`);
    // `McpError.path` is "pointer to the offending input" and is the TYPED field
    // a machine consumer reads INSTEAD of the prose. When TWO families were
    // probed there is no single id that was the input — synthesizing
    // `ApexClass:<name>` here would re-assert, in the one field a host cannot
    // skip, the single-family search the message above just disclaimed. Point at
    // the bare name the caller actually passed; keep the exact id when the
    // caller named the family and only that one id was looked up.
    const offendingInput =
      probedIds.length === 1 ? (probedIds[0] as ComponentId) : selector.name;
    return err({ kind: 'component-not-found', message, path: offendingInput });
  }
  if (foundIds.length > 1) {
    // A class and a trigger genuinely share this api name. Picking one would be
    // the silent-strip this resolver exists to prevent.
    return err({
      kind: 'invalid-query',
      message: `the bare name '${selector.name}' matches BOTH \`${foundIds.join('` and `')}\` in this vault; pass the canonical id as componentId to say which one`,
      path: 'classApiName',
    });
  }
  const targetId = foundIds[0] as ComponentId;
  if (targetNode === null) {
    return err({ kind: 'internal', message: `graph query failed: ${targetId}` });
  }

  const walkRes = await upstreamWalk(
    ctx,
    targetId,
    COVERAGE_BFS_DEPTH,
    input.methodName,
    loadNode,
  );
  if (!walkRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${walkRes.error}`,
    });
  }

  // Callout-mock cross-reference: only when the TARGET class makes callouts.
  // For each covering test we surface whether it installs a mock interface, and
  // roll up whether the callout code is covered ONLY by mock-less tests.
  const targetMakesCallout = makesCallout(targetNode);

  const hasMethod = input.methodName !== undefined;
  const covering: CoveringTestClass[] = [];
  let mockSettingTestCount = 0;
  let mockLessTestCount = 0;
  for (const [id, { depth, exercisesMethod }] of walkRes.value) {
    const r = await loadNode(id);
    if (!r.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${r.error}` });
    }
    const node = r.value;
    if (node === null) continue;
    if (!isTestClass(node)) continue;
    const testSetsMock = setsMock(node);
    if (targetMakesCallout) {
      if (testSetsMock) mockSettingTestCount += 1;
      else mockLessTestCount += 1;
    }
    covering.push({
      id: node.id,
      apiName: node.apiName,
      depth,
      ...(hasMethod ? { exercisesMethod } : {}),
      ...(targetMakesCallout ? { setsMock: testSetsMock } : {}),
    });
  }

  // Sort by id ASC for determinism.
  covering.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const calloutCoverage: CalloutCoverage | null = targetMakesCallout
    ? {
        targetMakesCallout: true,
        mockSettingTestCount,
        mockLessTestCount,
        // Inflated-coverage anti-pattern: callout code covered, but every
        // covering test reaches it WITHOUT a mock. Requires ≥1 covering test.
        coveredOnlyByMockLessTests:
          covering.length > 0 && mockSettingTestCount === 0,
      }
    : null;

  // TCFM-CERTIFIED-ZERO: the coverage the CALL walk cannot see. Bounded by the
  // triggers the walk already found — the target itself when it IS a trigger,
  // plus every trigger relay upstream of it.
  const triggerIds = [
    ...new Set<ComponentId>([
      ...(targetId.startsWith(APEX_TRIGGER_PREFIX) ? [targetId] : []),
      ...[...walkRes.value.keys()].filter((id) => id.startsWith(APEX_TRIGGER_PREFIX)),
    ]),
  ].sort();
  const triggerMediatedRes = await buildTriggerMediatedCoverage(
    ctx,
    triggerIds,
    // R3 self-match + no double-counting against coveringTestClasses.
    new Set<ComponentId>([targetId, ...covering.map((c) => c.id)]),
  );
  if (!triggerMediatedRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${triggerMediatedRes.error}`,
    });
  }
  const triggerMediated = triggerMediatedRes.value;

  // Soundness is DERIVED from what this walk actually traversed, not read off an
  // unrelated signal. `soundnessFromIds` reported only the dynamic-Apex/quality
  // signal, so a scanned-clean class produced `complete: true` / `blindSpots: []`
  // / `staticCoverage: 'full'` on a coverage answer whose most common real-world
  // topology (test -> DML -> trigger -> class) has no edge in this graph at all —
  // a certified zero. `soundnessForReachabilityWalk` keeps the dynamic-Apex
  // finding and ADDS the `unwalked-edge-type` blind spot naming every usage edge
  // type this walk did not traverse, so no answer here can claim completeness it
  // does not have.
  const walkedEdgeTypes: readonly EdgeType[] = [
    ...COVERAGE_EDGE_TYPES,
    ...(triggerMediated !== null ? DML_MEDIATED_EDGE_TYPES : []),
  ];
  const soundness = soundnessForReachabilityWalk(
    [targetNode],
    walkedEdgeTypes,
    COVERAGE_USAGE_EDGE_TYPES,
  );

  return ok({
    data: {
      appliedScope: { component: targetId, mode: 'component' },
      classApiName: targetId,
      methodName: input.methodName ?? null,
      coveringTestClasses: covering,
      totalCoveringCount: covering.length,
      calloutCoverage,
      methodCoveringCount: hasMethod
        ? covering.filter((c) => c.exercisesMethod === true).length
        : null,
      triggerMediatedCoverage: triggerMediated,
      soundness,
      disclosure: hasMethod ? COVERAGE_METHOD_DISCLOSURE : COVERAGE_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
