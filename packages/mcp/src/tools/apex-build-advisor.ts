/**
 * Handler for the `sfi.apex_build_advisor` MCP tool.
 *
 * The decision-support "before I write Apex here, what should I watch out for?"
 * tool. Synthesises what the org already teaches about its own Apex into a
 * developer briefing — it does NOT write code (backend knowledge layer):
 *
 *   - `governorPitfalls`: the governor-limit risks ALREADY in the org
 *     (soql-in-loop, dml-in-loop, …) so the dev knows the hotspots to avoid.
 *   - `testExpectations`: the 75% deploy gate + the org's untested-class
 *     backlog, so they plan the test class up front.
 *   - `flsCrudNorms`: whether the org's existing Apex enforces CRUD/FLS, and
 *     how often it skips it — the norm the new code should meet or beat.
 *   - `similarLogic` (when `objectApiName` is given): the Apex that already
 *     touches that object, so the dev reuses instead of duplicating.
 *
 * Composes `governor_limit_risks`, `apex_test_coverage`, and `crud_fls_audit`
 * (each a real, vault-grounded scan). Every sub-scan degrades gracefully: if
 * one can't run, its section is null with a note rather than failing the brief.
 *
 * **Honesty axis**: all findings are heuristic static analysis over the last
 * refresh; dynamic/reflective code is invisible. Read it as "here's what the
 * org's existing Apex shows", not a guarantee about code you haven't written.
 * Both scopes are VERIFIED before anything is briefed: an unresolved class is
 * `component-not-found` and an `objectApiName` no `CustomObject` node matches
 * is `invalid-query` — never the org-wide briefing under a scoped heading.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { apexTestCoverageHandler } from './apex-test-coverage.js';
import { crudFlsAuditHandler } from './crud-fls-audit.js';
import { governorLimitRisksHandler } from './governor-limit-risks.js';
import {
  firstNonEmpty,
  resolveApexClassAlias,
  resolveExistingObjectScope,
} from './input-aliases.js';

export const apexBuildAdvisorInputSchema = z.object({
  // Optional CLASS SCOPE (APEX-BUILD-ADVISOR-IGNORES-CLASS-SCOPE): narrow the
  // briefing to ONE ApexClass / ApexTrigger — its governor pitfalls, its test
  // coverage, its CRUD/FLS posture — instead of the org-wide advisor template.
  // Pass a bare class api name via `classApiName` / `apiName`, or an
  // `ApexClass:{name}` / `ApexTrigger:{name}` `componentId`. Omit for org-wide.
  componentId: z.string().min(1).optional(),
  classApiName: z.string().min(1).optional(),
  apiName: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
});

export type ApexBuildAdvisorInput = z.infer<typeof apexBuildAdvisorInputSchema>;

export interface ApexBuildAdvisorOutput {
  /**
   * The SCOPE actually applied. Present ONLY when the caller passed a
   * `componentId` / `classApiName` / `apiName` class scope or an
   * `objectApiName` object scope — an unscoped org-wide call omits it entirely
   * so its response stays byte-identical to the pre-scope shape. A host that
   * sees no `appliedScope` MUST treat the briefing as org-wide.
   *
   * `component` is the resolved `ApexClass:`/`ApexTrigger:` id (null when only
   * an object was named). `object` is the resolved `CustomObject:` id in the
   * VAULT's exact casing, present only on an object-scoped call — the
   * `similarLogic` section is the part of the briefing it governs. `mode` names
   * the axis that narrows the composed sub-scans: `component` whenever a class
   * scope is in force (it wins, and may carry an `object` alongside it),
   * `object` when only an object was named.
   */
  readonly appliedScope?: {
    readonly component: string | null;
    readonly object?: string;
    readonly mode: 'component' | 'object';
  };
  readonly governorPitfalls: {
    readonly totalRisks: number;
    readonly byRule: Readonly<Record<string, number>>;
    readonly note: string;
  } | null;
  readonly testExpectations: {
    readonly deployGate: string;
    readonly testClasses: number;
    readonly untestedClasses: number;
    readonly note: string;
  } | null;
  readonly flsCrudNorms: {
    readonly totalFindings: number;
    readonly byRule: Readonly<Record<string, number>>;
    readonly enforcesConsistently: boolean;
    readonly note: string;
  } | null;
  readonly similarLogic?: {
    readonly objectApiName: string;
    readonly apexTouchingObject: readonly ComponentId[];
  };
  readonly recommendations: readonly string[];
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'Heuristic static analysis over the last refresh; dynamic/reflective Apex is invisible. "Here is what the org\'s existing Apex shows", not a guarantee about new code.',
  'Composes governor_limit_risks, apex_test_coverage, and crud_fls_audit — see each tool for its own honesty boundaries.',
]);

/** Apex node-id prefixes used to find code that touches an object. */
const APEX_PREFIXES = ['ApexClass:', 'ApexTrigger:'];

const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/** The Apex ComponentTypes a CLASS SCOPE may resolve to. */
const CLASS_SCOPE_TYPES: readonly ComponentType[] = [
  'ApexClass',
  'ApexTrigger',
];

/**
 * Resolve the optional CLASS SCOPE from `componentId` / `classApiName` /
 * `apiName`. No selector → org-wide (`null`). A selector routes through the
 * shared `resolveApexClassAlias` normalizer so the three keys are
 * interchangeable, conflict-detected, and NEVER silently stripped. A
 * `componentId` with a non-Apex type prefix (e.g. `CustomObject:`) is a category
 * error → `invalid-query` (mirrors `governor_limit_risks` / `crud_fls_audit`)
 * rather than coerced into a bogus `ApexClass:` id. An `ApexTrigger:`
 * `componentId` is a valid scope and passes through verbatim.
 */
const resolveClassScope = (
  input: ApexBuildAdvisorInput,
): Result<ComponentId | null, McpError> => {
  const selector = firstNonEmpty(
    input.componentId,
    input.classApiName,
    input.apiName,
  );
  if (selector === undefined) return ok(null);
  const cid = firstNonEmpty(input.componentId);
  if (
    cid !== undefined &&
    cid.includes(':') &&
    !cid.startsWith(APEX_CLASS_PREFIX) &&
    !cid.startsWith(APEX_TRIGGER_PREFIX)
  ) {
    return err({
      kind: 'invalid-query',
      message: `\`${cid}\` is not an ApexClass / ApexTrigger — pass a bare class api name or an 'ApexClass:{name}' / 'ApexTrigger:{name}' id`,
      path: 'componentId',
    });
  }
  if (
    cid?.startsWith(APEX_TRIGGER_PREFIX) === true &&
    firstNonEmpty(input.classApiName, input.apiName) === undefined
  ) {
    return ok(cid as ComponentId);
  }
  const resolved = resolveApexClassAlias(input);
  if (!resolved.ok) return resolved;
  return ok(resolved.value.componentId as ComponentId);
};

export const apexBuildAdvisorHandler = async (
  ctx: Context,
  input: ApexBuildAdvisorInput,
): Promise<Result<McpResponse<ApexBuildAdvisorOutput>, McpError>> => {
  const recommendations: string[] = [];

  // Optional CLASS SCOPE (APEX-BUILD-ADVISOR-IGNORES-CLASS-SCOPE). Resolve +
  // validate it UP FRONT so an unresolvable / non-Apex scope surfaces a named
  // error here rather than being swallowed into a null sub-section (the
  // composed sub-scans "degrade to null" on failure — that graceful path would
  // otherwise hide a silently-ignored scope). Each sub-scan is then narrowed to
  // this one class; the bare (no-scope) call stays byte-identical.
  const scopeResult = resolveClassScope(input);
  if (!scopeResult.ok) return scopeResult;
  const scopeId = scopeResult.value;
  if (scopeId !== null) {
    const nodeRes = await getNodeById(ctx.graph, scopeId);
    if (!nodeRes.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodeRes.error.message}` });
    }
    if (nodeRes.value === null) {
      return err({
        kind: 'component-not-found',
        message: `no ApexClass / ApexTrigger matches \`${scopeId}\` in this vault`,
        path: scopeId,
      });
    }
    if (!CLASS_SCOPE_TYPES.includes(nodeRes.value.type)) {
      return err({
        kind: 'invalid-query',
        message: `\`${scopeId}\` is a ${nodeRes.value.type}, not an ApexClass / ApexTrigger — the apex_build_advisor class scope is Apex-only`,
        path: 'componentId',
      });
    }
  }
  // APEX-BUILD-ADVISOR-ANSWERS-FOR-NONEXISTENT-OBJECT: resolve + VERIFY the
  // optional OBJECT scope on the same footing as the class scope above.
  //
  // `objectApiName` used to be concatenated straight into
  // `CustomObject:{name}` at the `similarLogic` block and handed to
  // `listEdges` — nothing ever asked the vault whether that object existed,
  // and no sub-scan was narrowed by it. So "before I write Apex on
  // Zzz_Nonexistent_Object_9x7__c, what should I watch out for?" returned the
  // ENTIRE ORG-WIDE briefing — governor pitfalls, test expectations, CRUD/FLS
  // norms and every recommendation, byte-identical to the bare call — plus
  // `similarLogic: { apexTouchingObject: [] }`, an unchecked zero that reads
  // as "no Apex touches this object yet, go ahead". There was no
  // `appliedScope` naming an object either, so nothing in the payload
  // disclosed that the object scope had been dropped.
  //
  // The shared resolver refuses an api name no `CustomObject:` node matches,
  // rewrites a wrong-case name to the vault's spelling, and refuses two
  // objects differing only by case. Only `objectApiName` is read: this tool's
  // `componentId` is an APEX id (the class scope), never an object alias.
  const objectScopeResult = await resolveExistingObjectScope(ctx.graph, {
    objectApiName: input.objectApiName,
  });
  if (!objectScopeResult.ok) return err(objectScopeResult.error);
  const objectScope = objectScopeResult.value;

  // The scope argument the composed sub-scans receive: `{}` (org-wide) or the
  // resolved class id. `subject` gives the prose an honest antecedent — the
  // class name when scoped, "the org's Apex" org-wide.
  const scopeArg: { componentId?: ComponentId } =
    scopeId !== null ? { componentId: scopeId } : {};
  const subject =
    scopeId !== null
      ? `\`${scopeId.slice(scopeId.indexOf(':') + 1)}\``
      : "the org's Apex";

  // --- governor pitfalls ---
  let governorPitfalls: ApexBuildAdvisorOutput['governorPitfalls'] = null;
  const gov = await governorLimitRisksHandler(ctx, scopeArg);
  if (gov.ok) {
    const total = gov.value.data.totalRiskCount;
    governorPitfalls = {
      totalRisks: total,
      byRule: gov.value.data.byRule,
      note:
        total > 0
          ? scopeId !== null
            ? `${subject} already has ${total.toString()} governor-limit risk(s). These are the patterns to avoid in new code.`
            : `The org's Apex already has ${total} governor-limit risk(s). These are the patterns to avoid in new code.`
          : scopeId !== null
            ? `No governor-limit risks detected in ${subject} — keep it that way (no SOQL/DML in loops).`
            : 'No governor-limit risks detected in the existing Apex — keep it that way (no SOQL/DML in loops).',
    };
    if (total > 0) {
      const top = Object.entries(gov.value.data.byRule).sort((a, b) => b[1] - a[1])[0];
      recommendations.push(
        scopeId !== null
          ? `Bulkify everything: ${subject} already has ${total.toString()} governor risk(s)${top ? ` (top: ${top[0]} ×${top[1].toString()})` : ''}. Never put SOQL or DML inside a loop.`
          : `Bulkify everything: the org already has ${total} governor risk(s)${top ? ` (top: ${top[0]} ×${top[1]})` : ''}. Never put SOQL or DML inside a loop.`,
      );
    }
  }

  // --- test expectations ---
  let testExpectations: ApexBuildAdvisorOutput['testExpectations'] = null;
  const cov = await apexTestCoverageHandler(ctx, scopeArg);
  if (cov.ok) {
    const s = cov.value.data.summary;
    const target = cov.value.data.target;
    const scopedCov = scopeId !== null && target !== undefined;
    testExpectations = {
      deployGate: '75% org-wide Apex coverage required to deploy to production',
      testClasses: s.testClasses,
      untestedClasses: s.classesWithoutTestReferences,
      note: scopedCov
        ? `${subject} ${
            target.status === 'has-test-references'
              ? `has ${target.coveringTests.length.toString()} static test reference(s)`
              : 'has NO static test reference'
          } today.`
        : `${s.classesWithoutTestReferences}/${s.nonTestClasses} classes have no static test reference today.`,
    };
    recommendations.push(
      scopedCov
        ? target.status === 'has-test-references'
          ? `${subject} already has a covering test — extend it for the new logic and keep production coverage ≥ 75%.`
          : `${subject} has no covering test yet — write one before deploying (production deploys need 75% coverage). Mirror an existing *Test class's setup pattern.`
        : `Plan the test class up front: production deploys need 75% coverage and ${s.classesWithoutTestReferences} classes already lack a test reference. Mirror an existing *Test class's setup pattern.`,
    );
  }

  // --- FLS/CRUD norms ---
  let flsCrudNorms: ApexBuildAdvisorOutput['flsCrudNorms'] = null;
  const fls = await crudFlsAuditHandler(ctx, scopeArg);
  if (fls.ok) {
    const total = fls.value.data.totalFindingCount;
    flsCrudNorms = {
      totalFindings: total,
      byRule: fls.value.data.byRule,
      enforcesConsistently: total === 0,
      note:
        total > 0
          ? scopeId !== null
            ? `${total.toString()} CRUD/FLS gap(s) exist in ${subject} — set the bar higher in new code.`
            : `${total} CRUD/FLS gap(s) exist in current Apex — the org does NOT enforce consistently, so set the bar higher in new code.`
          : scopeId !== null
            ? `${subject} enforces CRUD/FLS — match that bar.`
            : 'Existing Apex enforces CRUD/FLS — match that bar.',
    };
    if (total > 0) {
      recommendations.push(
        scopeId !== null
          ? `Enforce CRUD/FLS in new code (Security.stripInaccessible / WITH SECURITY_ENFORCED / isAccessible()): ${subject} already has ${total.toString()} unguarded access finding(s).`
          : `Enforce CRUD/FLS in new code (Security.stripInaccessible / WITH SECURITY_ENFORCED / isAccessible()): the org already has ${total} unguarded access finding(s).`,
      );
    }
  }

  // --- similar logic (object-scoped) ---
  let similarLogic: ApexBuildAdvisorOutput['similarLogic'];
  if (objectScope !== null) {
    const objectId = objectScope.componentId as ComponentId;
    const edges = await listEdges(ctx.graph, objectId, { direction: 'in' });
    const touching = new Set<ComponentId>();
    if (edges.ok) {
      for (const e of edges.value) {
        if (APEX_PREFIXES.some((p) => e.fromId.startsWith(p))) touching.add(e.fromId);
      }
    }
    const apexTouchingObject = [...touching].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // The VAULT's spelling, not the caller's: echoing back `foo__C` would name
    // an object api name this org does not have.
    similarLogic = { objectApiName: objectScope.object, apexTouchingObject };
    if (apexTouchingObject.length > 0) {
      recommendations.push(
        `${apexTouchingObject.length} Apex component(s) already touch ${objectScope.object} — review them before adding logic so you reuse the existing handler/service instead of duplicating.`,
      );
    }
  }

  if (recommendations.length === 0) {
    recommendations.push(
      'Existing Apex looks clean on the measured axes; still follow the org conventions and write a test before deploying.',
    );
  }

  return ok({
    data: {
      // Emit appliedScope ONLY when a class OR object scope was passed, so a
      // bare org-wide call stays byte-identical to the pre-scope golden. A
      // class-only scope keeps its exact pre-0.3.3 two-key shape; the `object`
      // key appears only when an object was named.
      ...(scopeId !== null || objectScope !== null
        ? {
            appliedScope: {
              component: scopeId,
              ...(objectScope !== null ? { object: objectScope.componentId } : {}),
              mode: scopeId !== null ? ('component' as const) : ('object' as const),
            },
          }
        : {}),
      governorPitfalls,
      testExpectations,
      flsCrudNorms,
      ...(similarLogic !== undefined ? { similarLogic } : {}),
      recommendations,
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
