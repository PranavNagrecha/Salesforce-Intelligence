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
 * Cross-class transitive analysis is not available: every direct
 * caller of the method is treated as "needs update" — fail-conservative. A future-milestone tool with
 * Apex AST capability could parse the signature and surface only the
 * callers whose call-sites would actually compile-fail under the new
 * signature; v2.3 flags every caller for human review.
 *
 * **CR-CAP-06 caller-method enrichment (additive, does NOT narrow the
 * verdict).** When a caller's `callsApex` edge was AST-extracted
 * (`source: 'apex-ast'`), it carries `callerMethodsByMethod` — a
 * target-method-partitioned map of which method(s) of the caller hold
 * the call-site. This tool reads ONLY the partition for the queried
 * `methodName` (never the flat class-level union — that would phantom-
 * attribute a sibling caller method that called a DIFFERENT method of the
 * same target class) and surfaces it as `callerMethods` on the impact
 * item plus a "(call-site in method …)" clause in the explanation. It is
 * pure enrichment: attribution is by method NAME so overloaded callers
 * collapse to one name, the class-level dedup and the verdict are
 * unchanged, and every caller is still flagged for human review. Absent
 * on heuristic-scanner / Flow / LWC-Aura-declared callers and pre-fix
 * vaults (caller method unknown — the field is omitted, never `[]`).
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
 *     'parsed'`) when the target is @InvocableMethod (Flow callers
 *     have known confidence: parsed, from the Flow XML).
 *   - For each LWC / Aura / VF caller with an outgoing `callsApex`
 *     edge to the target class AND `properties.methodName ===
 *     methodName`, surface a `code-needs-update` impact. The frontend
 *     callers' confidence is `declared` for the
 *     `@salesforce/apex/{Class}.{method}` import pattern and
 *     `heuristic` for the inferred-from-source paths.
 *
 * **Test class identification.** Per internal semantics, a test class
 * needs update when it:
 *
 *   - Has an outgoing `coversTest` edge to the target class — NOTE: this
 *     branch is DEAD on every real vault. `coversTest` is a declared
 *     `EdgeType` with ZERO producers (see `UNPRODUCED_EDGE_TYPES` in
 *     `@sf-intelligence/contracts`); the "v0.3 extracted convention from
 *     @TestVisible / @TestSetup" this comment used to claim was never built,
 *     and could not be: neither annotation names a test-to-class mapping, and
 *     Salesforce publishes coverage only as a RUNTIME artifact. The walk is
 *     kept (it costs one query and would light up the moment a producer
 *     lands) and the gap is DISCLOSED rather than hidden, OR
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
 *   - `safe` if there are NO callers at all AND the method was VERIFIED to
 *     exist (the method is unused or only invoked dynamically).
 *   - `unknown` if there are no callers but the method could not be verified
 *     (source unreadable / unparseable / possibly inherited) - an empty caller
 *     list is then equally consistent with "there is no such method".
 *   - `risky` if at least one direct caller appears (the default for
 *     this tool — no `metadata-blocker` paths exist for method
 *     signature changes since the v0.3 extractor is heuristic).
 *   - `blocking` reserved for the case where a Flow `<actionName>`
 *     declaration references the method by name (the Flow XML is
 *     metadata-declared, so a Flow call-site to a renamed method is
 *     a metadata-deploy blocker).
 *
 * **Honesty axis.** v2.3 surfaces the verbatim disclosure using a
 * fail-conservative posture: all direct callers are flagged for review.
 * Dynamic Apex blind-spots apply (reflective `Type.forName + invoke`
 * paths are invisible). Test-class identification reduces, in practice, to "an
 * `@isTest` class with a DIRECT `callsApex` call-site to the target": the
 * `{TargetClassName}Test` naming convention is not implemented at all, and
 * `coversTest` has no producer. An empty `testClassesNeedingUpdate` therefore
 * means the coverage mapping is UNAVAILABLE, not that the class is untested,
 * and the always-on `disclosure` says so verbatim.
 *
 * Implementation notes:
 *   - `classApiName` is required to start with `ApexClass:`. Other
 *     prefixes return `invalid-query`.
 *   - `methodName` is required, non-empty, and is verified against the
 *     class's parsed source. A name the class provably does not declare
 *     returns `invalid-query` naming the methods it does declare.
 *   - `newSignature` is optional — accepted for caller-side rendering
 *     and echoed verbatim in the response so the renderer can produce
 *     before/after output. The tool does NOT validate the signature
 *     as Apex syntax.
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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
import { parseApexStructure } from '@sf-intelligence/parsers';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import {
  attachCoverageToWhatIf,
  type CoverageCaveat,
  METHOD_SIGNATURE_REQUIRED_COVERAGE,
  type Verdict,
} from './coverage-trust.js';
import { firstNonEmpty } from './input-aliases.js';
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
  /**
   * CR-CAP-06: AST-path only — the method(s) of THIS calling class that hold a
   * call-site to the SPECIFIC queried method (read from the edge's
   * `callerMethodsByMethod[methodName]` partition, NOT the class-level union —
   * so a sibling method that calls a DIFFERENT method of the target is never
   * falsely attributed here). Absent on heuristic-scanner / Flow /
   * LWC-Aura-declared callers and pre-fix vaults (caller method unknown). This
   * ENRICHES the explanation, it NEVER narrows the verdict (overloaded callers
   * collapse to one NAME, so the class-level human-review posture stands).
   */
  readonly callerMethods?: readonly string[];
}

/**
 * How many declared method names a refusal names before it summarises the
 * rest. Mirrors `apex-structure.ts`'s cap so the two "no such method"
 * refusals read identically.
 */
const DECLARED_NAMES_SHOWN = 20;

/**
 * Why the target class's method inventory could not be read, so `methodName`
 * could NOT be checked against it. Each value is a distinct cause with a
 * distinct fix — collapsing them into one boolean would hide which.
 *
 *   - `no-source-path` — the vault node records no source file at all.
 *   - `source-unreadable` — the recorded file is missing / unreadable.
 *   - `parse-failed` — the Apex grammar could not parse the file, so the
 *     method list is UNKNOWN, not empty.
 *   - `not-declared-here-but-inheritable` — the file parsed and does NOT
 *     declare the name, but the class extends a superclass, implements an
 *     interface, or holds inner types, any of which can legitimately supply
 *     the method. Absence here is inconclusive, so it is NOT refused.
 */
export type MethodUnverifiedReason =
  | 'no-source-path'
  | 'source-unreadable'
  | 'parse-failed'
  | 'not-declared-here-but-inheritable';

/**
 * Whether the method whose signature is hypothetically changing was PROVEN to
 * exist on the target class.
 *
 * METHOD-NAME-NEVER-VERIFIED: before this, `methodName` was a free-form string
 * used only as a filter over `callsApex` edges. A typo'd or hallucinated name
 * matched nothing, `callingClasses` came back `[]`, and the headline read
 * `verdict: 'safe'` — a confident "safe to change" for a method that does not
 * exist, byte-indistinguishable from a real method with no callers. A
 * PROVEN-absent method is now REFUSED (never answered), and an UNVERIFIABLE
 * one is typed here and blocks the `safe` headline.
 */
export type MethodVerification =
  | {
      readonly verified: true;
      readonly source: 'parsed-source';
      /**
       * The name AS DECLARED in the source. Apex resolves method names
       * case-insensitively, so `PROCESSOPPORTUNITY` matches and echoes back
       * with the declared casing rather than the caller's.
       */
      readonly declaredAs: string;
      /** How many overloads share that name (all of them change together). */
      readonly overloads: number;
    }
  | {
      readonly verified: false;
      readonly source: 'unavailable';
      readonly reason: MethodUnverifiedReason;
      /** Plain-language statement of what was NOT checked, and why. */
      readonly note: string;
    };

/**
 * Internal outcome of {@link resolveMethod}. Adds the PROVEN-ABSENT case,
 * which never reaches the response: the handler turns it into an
 * `invalid-query` refusal.
 */
type MethodResolution =
  | { readonly status: 'known'; readonly verification: MethodVerification }
  | { readonly status: 'absent'; readonly declared: readonly string[] };

/**
 * Verify `methodName` against the target class's ACTUAL method inventory,
 * parsed from the retrieved source (the same `parseApexStructure` path
 * `sfi.apex_structure` uses — this tool does not invent a second inventory).
 *
 * Three outcomes, and the difference between them is the whole point:
 *   - declared → `verified: true` (with the declared casing and overload
 *     count), and a `safe` headline is available.
 *   - PROVEN absent (parsed clean, no name match, and nothing — superclass,
 *     interface, inner type — that could legitimately supply it) → `absent`,
 *     which the handler REFUSES. The house law from
 *     `resolveExistingObjectScope`: an unresolvable scope is refused, never
 *     silently widened into a confident empty answer.
 *   - unverifiable (no source path / unreadable / unparseable / inheritable)
 *     → `verified: false` with the reason, which blocks `safe`.
 */
const resolveMethod = async (
  ctx: Context,
  classNode: Node,
  methodName: string,
): Promise<MethodResolution> => {
  const unverified = (
    reason: MethodUnverifiedReason,
    note: string,
  ): MethodResolution => ({
    status: 'known',
    verification: { verified: false, source: 'unavailable', reason, note },
  });

  const sourcePath = classNode.sourcePath;
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    return unverified(
      'no-source-path',
      `the vault node for ${classNode.id} records no source path, so '${methodName}' could not be checked against the class's declared methods — this answer does not assert that the method exists. Re-run /sfi-refresh.`,
    );
  }

  let source: string | null = null;
  try {
    source = await readFile(join(ctx.vaultRoot, sourcePath), 'utf-8');
  } catch {
    source = null;
  }
  if (source === null) {
    return unverified(
      'source-unreadable',
      `the source file recorded for ${classNode.id} could not be read, so '${methodName}' could not be checked against the class's declared methods — this answer does not assert that the method exists. Re-run /sfi-refresh.`,
    );
  }

  const parsed = await parseApexStructure(source, { kind: 'class' });
  if (!parsed.parsed || parsed.structure === null) {
    return unverified(
      'parse-failed',
      `the Apex grammar could not parse ${classNode.id}, so its method list is UNKNOWN (not empty) and '${methodName}' could not be checked against it. First error: ${parsed.parseErrors[0] ?? 'unknown'}.`,
    );
  }

  const structure = parsed.structure;
  const wanted = methodName.toLowerCase();
  const matches = structure.methods.filter(
    (m) => m.name.toLowerCase() === wanted,
  );
  if (matches.length > 0) {
    return {
      status: 'known',
      verification: {
        verified: true,
        source: 'parsed-source',
        declaredAs: (matches[0] as { readonly name: string }).name,
        overloads: matches.length,
      },
    };
  }

  // Not declared HERE — but an inherited, interface-declared, or inner-type
  // method is a real method this class legitimately answers to, and the parse
  // above cannot see any of them. Refusing on that evidence would be the same
  // confident-wrong-answer defect pointed the other way, so it is disclosed
  // instead.
  // An enum's usable methods (`values()`, `name()`, `ordinal()`) are supplied
  // by the language and appear in NO declaration, so an enum body that omits a
  // name proves nothing.
  if (
    structure.kind === 'enum' ||
    structure.superclass !== null ||
    structure.interfaces.length > 0 ||
    structure.innerTypes.length > 0
  ) {
    return unverified(
      'not-declared-here-but-inheritable',
      `${classNode.apiName} does not declare '${methodName}' in its own body, but it is an enum / extends / implements / nests other types whose methods this parse cannot see, so the name is neither confirmed nor refuted here.`,
    );
  }

  return { status: 'absent', declared: structure.methods.map((m) => m.name) };
};

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfChangeMethodSignatureOutput {
  /**
   * Echoes the class scope ACTUALLY resolved so a host that passed a
   * `componentId` / `apiName` alias sees it was honored, not silently rejected
   * (WHAT-IF-CHANGE-METHOD-SIGNATURE-REJECTS-COMPONENTID). Always `component`
   * mode — the tool is single-class by contract.
   */
  readonly appliedScope: {
    readonly component: ComponentId;
    readonly mode: 'component';
  };
  readonly classApiName: ComponentId;
  /** The method name AS ASKED, verbatim. See {@link methodVerification}. */
  readonly methodName: string;
  /**
   * Whether that name was PROVEN to be a method of this class, and if not,
   * why it could not be. A hallucinated or typo'd method no longer returns a
   * confident `safe`: a proven-absent name is refused outright
   * (`invalid-query`), and an unverifiable one lands here with
   * `verified: false` and downgrades the headline to `unknown`.
   */
  readonly methodVerification: MethodVerification;
  readonly newSignature: string | null;
  readonly callingClasses: readonly WhatIfImpactItem[];
  readonly testClassesNeedingUpdate: readonly ComponentId[];
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

/**
 * The verbatim disclosure surfaced in every response. Documents the
 * honesty boundaries (caller confidence, test identification, dynamic
 * dispatch) so the test suite can lock the phrasing.
 */
const DISCLOSURE =
  "the method name is CHECKED against the class's own source before any caller is enumerated: a name the parsed class does not declare (and cannot inherit) is REFUSED, not answered, and when the source could not be read or parsed `methodVerification.verified` is false and the headline is `unknown` rather than `safe` - so an empty caller list never doubles as \"that method does not exist\". caller confidence varies by source: Apex and Visualforce callers come from the heuristic apex-scanner (regex/token, no AST) and are reported at heuristic confidence (may include false positives); Flow callers are parsed out of the Flow XML <actionCalls> (confidence: parsed); LWC/Aura callers come from the declarative @salesforce/apex import (confidence: declared). Dynamic dispatch via Type.forName + invoke is invisible to all of them. Test classes are identified in ONE way that actually works: an incoming `callsApex` edge from a class whose `properties.isTest` is true. The `coversTest` edge this tool ALSO walks is declared in the contract but is emitted by NO extractor, graph-build mint, or enricher in this product (see `UNPRODUCED_EDGE_TYPES`), so on a real vault that walk ALWAYS returns nothing - Salesforce does not declare test-to-class coverage anywhere in the metadata source format (coverage is a RUNTIME artifact of a test run). Read an empty `testClassesNeedingUpdate` as \"test-coverage mapping UNAVAILABLE for this class\", never as \"no tests cover this class\": a test class that exercises the target only indirectly - through a helper, a trigger, or dynamic dispatch - has no `callsApex` edge to it and is invisible here. When an Apex caller's edge was AST-extracted, `callerMethods` names which method(s) of that caller hold a call-site to THIS specific method (enrichment only — overloaded callers collapse to one NAME, so every caller is still flagged for human review at class granularity and the verdict is unchanged); absent callerMethods means the call-site method is unknown (heuristic scanner, Flow, or LWC/Aura caller).";

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
  classApiName: z.string().min(1).optional(),
  // Interchangeable class selectors a host naturally reaches for (as on the
  // sibling Apex tools) — WHAT-IF-CHANGE-METHOD-SIGNATURE-REJECTS-COMPONENTID.
  // Resolved to the single target through `resolveTargetId`; disagreeing
  // selectors → `invalid-query`; at least one is required.
  componentId: z.string().min(1).optional(),
  apiName: z.string().min(1).optional(),
  methodName: z.string().min(1),
  newSignature: z.string().optional(),
});

/** Parsed input shape, inferred from the Zod schema. */
export type WhatIfChangeMethodSignatureInput = z.infer<
  typeof whatIfChangeMethodSignatureInputSchema
>;

/**
 * Resolve the single target class from the interchangeable `classApiName` /
 * `componentId` / `apiName` selectors — the alias residual this closes (a host
 * naturally passes `componentId` as on get_impact / the Track B-fixed siblings).
 * Each value is coerced through `coercePrefix` so a bare name and an `ApexClass:`
 * id both resolve while a WRONG-type prefix (`CustomObject:` / `ApexTrigger:`)
 * still reaches the handler's precise `invalid-query`. Disagreeing selectors →
 * `invalid-query` (never a silent pick); none → `invalid-query`.
 */
const resolveTargetId = (
  input: WhatIfChangeMethodSignatureInput,
): Result<string, McpError> => {
  const distinct = [
    ...new Set(
      [input.classApiName, input.componentId, input.apiName]
        .map((v) => firstNonEmpty(v))
        .filter((v): v is string => v !== undefined)
        .map((v) => coercePrefix(v, [APEX_CLASS_PREFIX])),
    ),
  ];
  if (distinct.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'name the Apex class — pass `classApiName` (e.g. "OrderService"), `componentId` (`ApexClass:OrderService`), or `apiName`',
      path: 'classApiName',
    });
  }
  if (distinct.length > 1) {
    return err({
      kind: 'invalid-query',
      message: `class selectors name different targets (${distinct.join(', ')}); pass exactly one of classApiName / componentId / apiName`,
      path: 'classApiName',
    });
  }
  return ok(distinct[0] as string);
};

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
 *
 * The comparison is CASE-INSENSITIVE because Apex is: `svc.ProcessOpp()` and
 * `svc.processOpp()` invoke the same method, and the scanner records whatever
 * casing the CALL SITE wrote, not the declaration's. A case-sensitive `===`
 * dropped every caller whose casing differed from the query's and returned the
 * empty caller list as `safe` — the same confident-absence defect the
 * method-existence check above closes, one axis over.
 */
const callsMethod = (edge: Edge, methodName: string): boolean => {
  const wanted = methodName.toLowerCase();
  const methods = edge.properties['methods'];
  if (Array.isArray(methods)) {
    return methods.some(
      (m) => typeof m === 'string' && m.toLowerCase() === wanted,
    );
  }
  const raw = edge.properties['methodName'];
  return typeof raw === 'string' && raw.toLowerCase() === wanted;
};

/**
 * CR-CAP-06: read the caller class's method(s) that hold a call-site to the
 * SPECIFIC `methodName`, from the AST edge's `callerMethodsByMethod`
 * partition (`{ [targetMethod]: callerMethod[] }`). Partitioned by TARGET
 * METHOD so we attribute ONLY the caller methods that called THIS method —
 * never the flat class-level union, which would phantom-attribute a sibling
 * caller method that called a different method of the same target class.
 * Returns `undefined` when the partition is absent or holds no entry for the
 * queried method (scanner-path / Flow / declared / pre-fix edge → caller
 * method unknown → field OMITTED, never `[]`). Always sorted + deduped.
 */
const callerMethodsForTarget = (
  edge: Edge,
  methodName: string,
): readonly string[] | undefined => {
  const byMethod = edge.properties['callerMethodsByMethod'];
  if (byMethod === null || typeof byMethod !== 'object' || Array.isArray(byMethod)) {
    return undefined;
  }
  // Case-insensitive key lookup, for the same reason `callsMethod` is: the
  // partition is keyed by the casing the call site wrote.
  const wanted = methodName.toLowerCase();
  const strs = Object.entries(byMethod as Record<string, unknown>)
    .filter(([key]) => key.toLowerCase() === wanted)
    .flatMap(([, value]) => (Array.isArray(value) ? value : []))
    .filter((x): x is string => typeof x === 'string');
  return strs.length === 0 ? undefined : [...new Set(strs)].sort();
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
  /**
   * CR-CAP-06: the caller's method(s) holding the call-site to `methodName`
   * (AST-path, partitioned by target method). When present, the prose pinpoints
   * the method so a reviewer narrows from class to method; absent leaves the
   * sentence unchanged (caller method unknown).
   */
  callerMethods?: readonly string[],
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
  const siteClause =
    callerMethods !== undefined && callerMethods.length > 0
      ? ` (call-site in ${callerMethods.length === 1 ? 'method' : 'methods'} ${callerMethods
          .map((m) => `'${m}'`)
          .join(', ')})`
      : '';
  return `${callerLabel} ${verb} ${targetLabel}${siteClause}; the signature change requires updating this call-site.`;
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
 *     only invoked dynamically). The HANDLER downgrades that to `unknown`
 *     when the method itself could not be verified to exist, so this
 *     function's `safe` is a STRUCTURAL statement, not the headline.
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
    // CR-CAP-06: the caller's method(s) that call THIS specific method
    // (partitioned by target method — no cross-method phantom). Absent on
    // scanner/Flow/declared edges → field omitted, explanation unchanged.
    const callerMethods = callerMethodsForTarget(edge, methodName);
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
        callerMethods,
      ),
      ...(callerMethods !== undefined ? { callerMethods } : {}),
    });
    if (isTest) testIds.add(fromNode.id);
  }

  return ok({
    impacts: [...impactsByCaller.values()],
    testIds: [...testIds],
  });
};

/**
 * Walk the incoming `coversTest` edges to the target class.
 *
 * COVERSTEST-DECLARED-BUT-NEVER-PRODUCED: this walk returns EMPTY on every
 * real vault. The doc here used to state that "the v0.3 extractor populates
 * these from `@TestVisible` / `@TestSetup` annotations and the
 * `className + 'Test'` naming convention" — no such extractor exists, and a
 * scan of every producing package finds ZERO `edgeType: 'coversTest'`
 * emission sites (`UNPRODUCED_EDGE_TYPES` in `@sf-intelligence/contracts`
 * pins that, and `packages/mcp/test/tools/edge-type-producers.test.ts` fails
 * if it ever stops being true). It is not an oversight that can be patched
 * locally either: neither annotation declares a test-to-class mapping, and the
 * one statically-knowable signal ("an @isTest class calls this class") is
 * already modeled as `callsApex` + `properties.isTest` and is walked by
 * {@link collectCallers}.
 *
 * The function is KEPT rather than deleted so the tool lights up automatically
 * if a producer ever lands (the Tooling API's `ApexCodeCoverage` being the only
 * sound source), and the tool's always-on `disclosure` names the gap so an
 * empty `testClassesNeedingUpdate` reads as "coverage mapping unavailable"
 * instead of "nothing tests this".
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
  const scopeRes = resolveTargetId(input);
  if (!scopeRes.ok) return scopeRes;
  const classApiName = scopeRes.value;
  if (!classApiName.startsWith(APEX_CLASS_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `classApiName must be an ApexClass id (e.g. '${APEX_CLASS_PREFIX}Foo') or a bare class name (e.g. 'Foo'); got '${classApiName}'`,
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

  // METHOD-NAME-NEVER-VERIFIED: check the METHOD before enumerating callers of
  // it. The class was resolved and type-checked above; the method — the very
  // thing whose signature is changing — used to be taken verbatim and used only
  // as a string filter, so a name that does not exist produced zero matches and
  // a confident `safe`.
  const methodResolution = await resolveMethod(ctx, classNode, methodName);
  if (methodResolution.status === 'absent') {
    const declared = [...new Set(methodResolution.declared)].sort();
    const shown = declared.slice(0, DECLARED_NAMES_SHOWN);
    const more =
      declared.length > shown.length
        ? ` (and ${String(declared.length - shown.length)} more)`
        : '';
    return err({
      kind: 'invalid-query',
      message: `no method named '${methodName}' is declared in ${classNode.apiName} (matched case-insensitively, the way Apex resolves it). Declared methods: ${shown.join(', ') || '(none)'}${more}. Refused rather than answered: an empty caller list for a method that does not exist would have read as "safe to change".`,
      path: 'methodName',
    });
  }
  const methodVerification = methodResolution.verification;

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

  const structuralVerdict = aggregateVerdict(sortedImpacts);
  // `safe` here asserts "nothing calls THIS method". That claim is only
  // available once the method is known to exist — otherwise an empty caller
  // list is equally consistent with "there is no such method", and reporting
  // `safe` would answer a question that was never checked.
  const rawVerdict: Verdict =
    structuralVerdict === 'safe' && !methodVerification.verified
      ? 'unknown'
      : structuralVerdict;
  const coverage = attachCoverageToWhatIf(
    ctx,
    METHOD_SIGNATURE_REQUIRED_COVERAGE,
    'Method signature change impact',
    rawVerdict,
  );
  // An unverified method is a hole in THIS answer, so the trust block has to
  // say so rather than reporting `completeness: complete` beside a headline
  // that exists because something was not checked.
  const trust: TrustSummary = methodVerification.verified
    ? coverage.trust
    : {
        ...coverage.trust,
        completeness:
          coverage.trust.completeness.status === 'complete'
            ? { status: 'partial' }
            : coverage.trust.completeness,
        limitations: [
          ...coverage.trust.limitations,
          `method existence NOT verified (${methodVerification.reason}): ${methodVerification.note}`,
        ],
      };

  return ok({
    data: {
      appliedScope: { component: classId, mode: 'component' },
      classApiName: classId,
      methodName,
      methodVerification,
      newSignature,
      callingClasses: sortedImpacts,
      testClassesNeedingUpdate: sortedTestIds,
      verdict: coverage.verdict as Verdict,
      ...(coverage.coverageCaveat !== undefined
        ? { coverageCaveat: coverage.coverageCaveat }
        : {}),
      trust,
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
