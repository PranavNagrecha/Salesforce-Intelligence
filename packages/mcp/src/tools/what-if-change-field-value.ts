/**
 * Handler for the `sfi.what_if_change_field_value` MCP tool.
 *
 * The value-change complement to `sfi.what_if_change_field_type`. That tool
 * asks "what REFERENCES this field?" — the blast radius of a *schema* change.
 * This one asks "what breaks if the stored VALUE changes?" — a different
 * blast radius that can be catastrophic on a field with zero references (a
 * SAML federation key, an integration upsert key). It composes the
 * value-change risk model (`value-change-risk.ts`) into the standard MCP
 * envelope: impact buckets (identity / integration-key / uniqueness /
 * automation / save-pipeline / display), honesty-surface disclosures, an
 * overall severity, and recommended pre-change checks.
 *
 * Boundaries (verbatim in `DISCLOSURE`): identity/key/uniqueness verdicts come
 * from the field's own metadata (externalId / unique / idLookup, the identity
 * catalog); automation buckets surface the declarative value-literal coupling
 * (the value a rule compares this field to, read from ConditionalContext);
 * Apex literal comparisons remain invisible. The vault cannot see external
 * upsert systems, the IdP side of SSO, or dynamic / managed-package code.
 *
 *   - `fieldId` must start with `CustomField:`; other prefixes → `invalid-query`.
 *   - Unknown ids → `component-not-found`.
 *   - Derived fields (formula / roll-up / auto-number) return `mutable: false`
 *     and re-route to their source — you cannot change their value directly.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  applyCoverageToVerdict,
  type CoverageCaveat,
  type Verdict,
} from './coverage-trust.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import type { Severity } from './value-change-classification.js';
import { assessValueChange, type BucketHit } from './value-change-risk.js';

const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Metadata families the value-change verdict depends on for completeness. */
const VALUE_CHANGE_REQUIRED_COVERAGE = [
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'WorkflowRule',
  'Layout',
  'SharingRule',
  'DuplicateRule',
] as const;

export interface WhatIfChangeFieldValueOutput {
  readonly fieldId: ComponentId;
  readonly object: string;
  readonly field: string;
  readonly mutable: boolean;
  readonly overallSeverity: Severity;
  /**
   * Unified what-if verdict (P8-what-if-suite) mapped from `overallSeverity`
   * so this tool shares the family envelope. `overallSeverity` stays as the
   * richer 5-level signal; `verdict` is the cross-tool headline (and is
   * downgraded safe→review when coverage is partial, like the rest of the
   * family).
   */
  readonly verdict: Verdict;
  readonly buckets: readonly BucketHit[];
  readonly disclosures: readonly string[];
  readonly recommendedChecks: readonly string[];
  readonly newValue?: string;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

const DISCLOSURE =
  'Value-change impact analyzes what breaks if this field’s stored VALUE changes (not its schema) — distinct from what_if_change_field_type, which walks references. Identity / integration-key / uniqueness verdicts come from the field’s own metadata (externalId / unique / idLookup, identity catalog); automation buckets surface the declarative value-literal coupling (the value a rule compares this field to); Apex literal comparisons remain invisible. The vault cannot see external upsert systems, the IdP side of SSO, or dynamic / managed-package code — see disclosures.';

/**
 * Map the value-change `Severity` (5-level risk) onto the unified what-if
 * `Verdict` (P8-what-if-suite). A value change is advisory — the tool never
 * hard-blocks an edit — so `critical` lands on `blocking` only to signal "do
 * not proceed without the listed checks", keeping the headline vocabulary
 * consistent with the rest of the family.
 */
const severityToVerdict = (severity: Severity): Verdict => {
  switch (severity) {
    case 'critical':
      return 'blocking';
    case 'high':
      return 'risky';
    case 'medium':
    case 'low':
      return 'review';
    case 'info':
      return 'safe';
  }
};

export const whatIfChangeFieldValueInputSchema = z.object({
  fieldId: z.string().min(1),
  newValue: z.string().optional(),
});

export type WhatIfChangeFieldValueInput = z.infer<typeof whatIfChangeFieldValueInputSchema>;

const coverageCaveatFor = (ctx: Context): CoverageCaveat | undefined => {
  const coverage = summarizeCoverage(ctx.manifest, VALUE_CHANGE_REQUIRED_COVERAGE);
  if (coverage.status === 'complete') return undefined;
  const missingCoverage = coverage.missingCoverage.length > 0
    ? coverage.missingCoverage
    : [...VALUE_CHANGE_REQUIRED_COVERAGE];
  return {
    status: coverage.status === 'partial' ? 'partial' : 'unknown',
    missingCoverage,
    message:
      `Value-change impact is incomplete because the vault lacks coverage for: ${missingCoverage.join(', ')}. Absence of impacts in those families means "not checked", not "safe".`,
  };
};

/**
 * The `sfi.what_if_change_field_value` MCP tool. Given a CustomField id (and
 * an optional proposed `newValue`), returns the value-change impact buckets,
 * an overall severity, disclosures, and recommended checks.
 *
 * @example
 *   const r = await whatIfChangeFieldValueHandler(ctx, {
 *     fieldId: 'CustomField:Contact.Student_ID_Number_SIS_ID__c',
 *   });
 *   if (r.ok) console.log(r.value.data.overallSeverity); // 'high'
 */
export const whatIfChangeFieldValueHandler = async (
  ctx: Context,
  input: WhatIfChangeFieldValueInput,
): Promise<Result<McpResponse<WhatIfChangeFieldValueOutput>, McpError>> => {
  if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }
  const fieldId = input.fieldId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  if (nodeResult.value === null) {
    return err({ kind: 'component-not-found', message: await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'), path: fieldId });
  }

  const assessmentResult = await assessValueChange(ctx, nodeResult.value);
  if (!assessmentResult.ok) return err(assessmentResult.error);
  const a = assessmentResult.value;

  // When the caller names a concrete new value, add a targeted check (the
  // full collision / literal-match probe lands with the value-literal phase).
  const recommendedChecks = input.newValue !== undefined
    ? [
        `Verify the proposed value "${input.newValue}" does not collide on a unique/external-ID field and is accepted by referencing automation.`,
        ...a.recommendedChecks,
      ]
    : a.recommendedChecks;

  const coverageCaveat = coverageCaveatFor(ctx);
  const hasAutomation = a.buckets.some((b) => b.bucket === 'automation');
  const confidence: ConfidenceLevel = hasAutomation ? 'heuristic' : 'declared';

  return ok({
    data: {
      fieldId,
      object: a.object,
      field: a.field,
      mutable: a.mutable,
      overallSeverity: a.overallSeverity,
      verdict: applyCoverageToVerdict(
        severityToVerdict(a.overallSeverity),
        coverageCaveat,
        'safe',
        'review',
      ),
      buckets: a.buckets,
      disclosures: a.disclosures,
      recommendedChecks,
      ...(input.newValue !== undefined ? { newValue: input.newValue } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      trust: {
        provenance: 'offline_snapshot',
        confidence,
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: {
          status: coverageCaveat === undefined ? 'complete' : coverageCaveat.status,
          ...(coverageCaveat !== undefined ? { missingCoverage: coverageCaveat.missingCoverage } : {}),
        },
        limitations: [
          DISCLOSURE,
          ...a.disclosures,
          ...(coverageCaveat !== undefined ? [coverageCaveat.message] : []),
        ],
      },
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
