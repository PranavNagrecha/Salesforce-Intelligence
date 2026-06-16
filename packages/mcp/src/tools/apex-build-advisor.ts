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
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { apexTestCoverageHandler } from './apex-test-coverage.js';
import { crudFlsAuditHandler } from './crud-fls-audit.js';
import { governorLimitRisksHandler } from './governor-limit-risks.js';

export const apexBuildAdvisorInputSchema = z.object({
  objectApiName: z.string().min(1).optional(),
});

export type ApexBuildAdvisorInput = z.infer<typeof apexBuildAdvisorInputSchema>;

export interface ApexBuildAdvisorOutput {
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

export const apexBuildAdvisorHandler = async (
  ctx: Context,
  input: ApexBuildAdvisorInput,
): Promise<Result<McpResponse<ApexBuildAdvisorOutput>, McpError>> => {
  const recommendations: string[] = [];

  // --- governor pitfalls ---
  let governorPitfalls: ApexBuildAdvisorOutput['governorPitfalls'] = null;
  const gov = await governorLimitRisksHandler(ctx, {});
  if (gov.ok) {
    const total = gov.value.data.totalRiskCount;
    governorPitfalls = {
      totalRisks: total,
      byRule: gov.value.data.byRule,
      note:
        total > 0
          ? `The org's Apex already has ${total} governor-limit risk(s). These are the patterns to avoid in new code.`
          : 'No governor-limit risks detected in the existing Apex — keep it that way (no SOQL/DML in loops).',
    };
    if (total > 0) {
      const top = Object.entries(gov.value.data.byRule).sort((a, b) => b[1] - a[1])[0];
      recommendations.push(
        `Bulkify everything: the org already has ${total} governor risk(s)${top ? ` (top: ${top[0]} ×${top[1]})` : ''}. Never put SOQL or DML inside a loop.`,
      );
    }
  }

  // --- test expectations ---
  let testExpectations: ApexBuildAdvisorOutput['testExpectations'] = null;
  const cov = await apexTestCoverageHandler(ctx, {});
  if (cov.ok) {
    const s = cov.value.data.summary;
    testExpectations = {
      deployGate: '75% org-wide Apex coverage required to deploy to production',
      testClasses: s.testClasses,
      untestedClasses: s.classesWithoutTestReferences,
      note: `${s.classesWithoutTestReferences}/${s.nonTestClasses} classes have no static test reference today.`,
    };
    recommendations.push(
      `Plan the test class up front: production deploys need 75% coverage and ${s.classesWithoutTestReferences} classes already lack a test reference. Mirror an existing *Test class's setup pattern.`,
    );
  }

  // --- FLS/CRUD norms ---
  let flsCrudNorms: ApexBuildAdvisorOutput['flsCrudNorms'] = null;
  const fls = await crudFlsAuditHandler(ctx, {});
  if (fls.ok) {
    const total = fls.value.data.totalFindingCount;
    flsCrudNorms = {
      totalFindings: total,
      byRule: fls.value.data.byRule,
      enforcesConsistently: total === 0,
      note:
        total > 0
          ? `${total} CRUD/FLS gap(s) exist in current Apex — the org does NOT enforce consistently, so set the bar higher in new code.`
          : 'Existing Apex enforces CRUD/FLS — match that bar.',
    };
    if (total > 0) {
      recommendations.push(
        `Enforce CRUD/FLS in new code (Security.stripInaccessible / WITH SECURITY_ENFORCED / isAccessible()): the org already has ${total} unguarded access finding(s).`,
      );
    }
  }

  // --- similar logic (object-scoped) ---
  let similarLogic: ApexBuildAdvisorOutput['similarLogic'];
  if (input.objectApiName !== undefined) {
    const objectId: ComponentId = `CustomObject:${input.objectApiName}`;
    const edges = await listEdges(ctx.graph, objectId, { direction: 'in' });
    const touching = new Set<ComponentId>();
    if (edges.ok) {
      for (const e of edges.value) {
        if (APEX_PREFIXES.some((p) => e.fromId.startsWith(p))) touching.add(e.fromId);
      }
    }
    const apexTouchingObject = [...touching].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    similarLogic = { objectApiName: input.objectApiName, apexTouchingObject };
    if (apexTouchingObject.length > 0) {
      recommendations.push(
        `${apexTouchingObject.length} Apex component(s) already touch ${input.objectApiName} — review them before adding logic so you reuse the existing handler/service instead of duplicating.`,
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
