/**
 * Handler for the `sfi.interpret` MCP tool (RM-wire).
 *
 * The visible, cited surface over the deterministic reasoning engine. Since
 * REASONING-REACHABILITY it is a THIN PROJECTION of the shared helper
 * `knowledge/reason-component.ts` — root resolution, the grounded-slice assembly
 * (1-hop bound-type edges + endpoint nodes, plus the five conditional second
 * hops the JOIN / `root-children-outgoing` AGGREGATE / EC-8 anti-join / EC-11
 * cascade shapes need), per-rule coverage adaptation, and the chain / compound /
 * reconcile passes ALL live there now, so `sfi.interpret` and every tool that
 * composes concept reasoning run exactly one code path. See that module for the
 * slice-assembly contract and the coverage-bucket semantics.
 *
 * What is left here is PRESENTATION and nothing else:
 *   - EPIC-5 proactive-risk ranking (severity × confidence, top 5);
 *   - the `trust` block (overall confidence = weakest fired, mixed freshness,
 *     completeness + limitations);
 *   - the disclosure and the rendered Markdown answer;
 *   - the AUDIT-F4 `EvidenceEnvelopeV2` projection.
 *
 * R5 — it now ALSO surfaces the helper's completeness digest as `completeness`.
 * Omitting it for byte-stability made the dedicated reasoning tool LESS honest
 * than the tools composing it: on a component where nothing could be evaluated,
 * `sfi.interpret` returned an empty claim list plus "no curated reasoning rule
 * matched the graph slice" — which states rules RAN and found nothing, when in
 * fact nothing ran. A payload-shape change is the correct price for that.
 *
 * Honesty is load-bearing:
 *   - `provenance` is hardwired `offline_snapshot`; the `disclosure` states this
 *     is DETERMINISTIC reasoning over the offline vault snapshot — no LLM, not a
 *     live read.
 *   - an EMPTY interpretation list renders/discloses "no concept rule fired for
 *     this component (this is NOT a claim that nothing depends on it)" rather
 *     than any absence conclusion.
 *   - a TRUNCATED slice (a hub whose edge count exceeds the cap) forces coverage
 *     to at most `partial`, so an absence rule can never read `complete` over a
 *     clipped slice.
 *
 * This tool is offline and read-only — it never touches the org.
 */

import type {
  ComponentId,
  ConceptSeverity,
  ConfidenceLevel,
  EvidenceEnvelopeV2,
  Interpretation,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { buildMixedFreshness } from '@sf-intelligence/vault';
import { z } from 'zod';

import { renderInterpretationsMarkdown } from '../answer-render.js';
import {
  CHAINED_RULES,
  COMPOUND_RULES,
  CONCEPT_RULES,
  CONCEPTS,
  reasonAboutComponent,
  SUPERSEDES_RULES,
  weakest,
} from '../knowledge/index.js';
import type { Context } from '../server.js';

import {
  type ConceptCompletenessDigest,
  toCompletenessDigest,
} from './concept-reasoning.js';
import { buildInterpretEvidenceEnvelope } from './evidence-envelope.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/**
 * Re-exported from the knowledge plane so the existing `sfi.interpret` import
 * surface is unchanged by the extraction. The implementation now lives in
 * `knowledge/reason-component.ts` alongside the slice assembly it belongs to.
 */
export { adaptCoverage } from '../knowledge/reason-component.js';

/**
 * Zod schema for the `sfi.interpret` tool input.
 *   - `componentId`: required, non-empty canonical id (e.g.
 *     `CustomField:Account.Amount__c`, `CustomObject:Order__c`).
 *   - `concepts`: optional additive filter — keep only rules whose `concept`
 *     is in this list. An EMPTY array matches NO rule.
 *   - `ruleIds`: optional additive filter — keep only rules whose `id` is in
 *     this list. An EMPTY array matches NO rule.
 */
export const interpretInputSchema = z.object({
  componentId: z.string().min(1),
  concepts: z.array(z.string()).optional(),
  ruleIds: z.array(z.string()).optional(),
});

/** Parsed input shape. */
export type InterpretInput = z.infer<typeof interpretInputSchema>;

/** EPIC-5: one ranked proactive-risk row derived from an interpretation. */
export interface ProactiveRiskRow {
  readonly ruleId: string;
  readonly concept: string;
  readonly severity: ConceptSeverity;
  readonly confidence: ConfidenceLevel;
  readonly riskScore: number;
  readonly claimPreview: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface InterpretOutput {
  readonly componentId: ComponentId;
  /**
   * R5 — which concept layers were checked, provably skipped, or could not be
   * evaluated, as the same bounded digest the composed tools carry.
   *
   * Read `noRuleCoversComponentType` FIRST: when true, NOTHING was analysed and
   * an empty `interpretations` array is SILENCE, never a clean bill of health.
   * The `rulesNotEvaluableByReason` split matters too — `vault-coverage-missing`
   * is a retrieval gap with a remedy, while `shape-not-provable` means the rule
   * ran and matched nothing but its inapplicability was not proven.
   */
  readonly completeness: ConceptCompletenessDigest;
  /**
   * QUESTION→ANCHOR BRIDGE — present ONLY when the caller's identifier was not
   * a canonical id and the shared resolver mapped it onto `componentId`. Absent
   * on the canonical path, so a canonical call is byte-unchanged. When present
   * the caller MUST relay it: the user named one thing and this answer is about
   * another, even though the mapping was unambiguous.
   */
  readonly resolvedFrom?: {
    readonly identifier: string;
    readonly matchKind: string;
    readonly score: number;
  };
  readonly componentType: string;
  /** The engine's interpretations, VERBATIM — claims are never reshaped here. */
  readonly interpretations: readonly Interpretation[];
  /** EPIC-5: top proactive risks ranked by severity × confidence (max 5). */
  readonly proactiveRisks?: readonly ProactiveRiskRow[];
  /**
   * THE rule counter. Identical to `completeness.rulesConsidered` on EVERY
   * response, by construction — it is read from the same coverage report.
   *
   * It used to be `selectedRules + CHAINED + COMPOUND + SUPERSEDES`, which
   * published a second, larger number beside the digest's (195 vs 200 on a bare
   * call; 0 vs 5 under a filter) and left a reader to guess which one the
   * "nothing was checked" verdict was about. The second-pass rules are counted
   * separately in {@link InterpretOutput.secondPassRules} — they are not
   * candidates evaluated against this component, so folding them in here made
   * the number describe nothing at all.
   */
  readonly rulesConsidered: number;
  /**
   * Chain / compound / supersedes rules. These run over the claims the selected
   * rules already emitted, NOT against the component, so they are never part of
   * the `rulesConsidered` partition — but they can add to `rulesFired`, which is
   * why `rulesFired` may exceed `rulesConsidered` by at most this many.
   * Constant for a given build; a caller filter does not narrow them.
   */
  readonly secondPassRules: number;
  /**
   * Present ONLY when the CALLER passed `concepts` / `ruleIds`. Names the
   * filter and how much of the model it kept, so an empty or thin answer under
   * a filter can be attributed to the caller's own narrowing rather than read
   * as a coverage gap. Absent on an unfiltered call, which stays byte-identical.
   */
  readonly ruleSelection?: {
    readonly concepts?: readonly string[];
    readonly ruleIds?: readonly string[];
    /** Concept rules the filter kept — equals `rulesConsidered`. */
    readonly rulesSelected: number;
    /** Concept rules in the model before the filter. */
    readonly rulesInModel: number;
  };
  /**
   * Distinct rule ids that emitted a claim — selected rules PLUS any second-pass
   * (chain / compound / supersedes) rule that fired over them.
   */
  readonly rulesFired: number;
  readonly sliceTruncated: boolean;
  readonly trust: TrustSummary;
  /** Present only when the aggregate coverage is not `complete`. */
  readonly coverageCaveat?: string;
  readonly disclosure: string;
  readonly rendered: string;
  /**
   * AUDIT-F4 — shared EvidenceEnvelope v2 projection of the fields above.
   * Additive; legacy keys remain the primary surface.
   */
  readonly evidenceEnvelope: EvidenceEnvelopeV2;
}

/** Base disclosure — always present. */
const BASE_DISCLOSURE =
  'Deterministic concept-rule reasoning over the offline vault snapshot — NOT a live org read and NOT an LLM inference. ' +
  'Each interpretation is a curated structural rule fired against the graph slice assembled for this component; it cites ' +
  'the exact component ids it is grounded in, and its confidence is the weakest of the rule ceiling and its matched edges — ' +
  'never asserted above its ground. An absence-based conclusion is only as strong as the coverage of the families it depends on.';

/**
 * Chain / compound / supersedes rules — the SECOND pass, which runs over claims
 * the selected rules already emitted rather than against the component. A
 * build constant, and deliberately NOT added into `rulesConsidered`.
 */
const SECOND_PASS_RULE_COUNT =
  CHAINED_RULES.length + COMPOUND_RULES.length + SUPERSEDES_RULES.length;

/**
 * The `noRuleCoversComponentType` summary, REWRITTEN for a call whose own
 * `concepts` / `ruleIds` filter is what emptied the rule set.
 *
 * The engine's sentence — "NOTHING was checked for this CustomObject: of 0
 * concept rules, 0 are provably inapplicable to this component type and 0 could
 * not be evaluated at all" — is a statement about how well the MODEL covers this
 * component type. Under a caller filter it is not one: the rules were removed by
 * the request, not missing from the model, and the arithmetic degenerates to
 * "of 0 rules, 0 and 0". The tool's description tells readers to consult
 * `completeness.noRuleCoversComponentType` FIRST, so that is the last field
 * allowed to blame the vault for the caller's own narrowing.
 *
 * The flag itself stays `true`: nothing WAS analysed, and an empty
 * `interpretations` list here is still silence, never a clean bill of health.
 * Only the stated REASON changes — to the true one.
 */
const filteredSelectionSummary = (
  rootType: string,
  rulesSelected: number,
  rulesNotApplicable: number,
  rulesNotEvaluable: number,
): string =>
  rulesSelected === 0
    ? `NOTHING was checked for this ${rootType}, because THIS CALL'S OWN concepts/ruleIds filter ` +
      `selected 0 of the ${CONCEPT_RULES.length} concept rules. That is a caller-applied narrowing, ` +
      `NOT a coverage gap in the concept model or in this vault — re-run without the filter (or with ` +
      `ids that exist) for the model's verdict on this ${rootType}. An empty interpretations list ` +
      'here is silence about the filtered set only.'
    : `NOTHING was checked for this ${rootType} among the ${rulesSelected} of ` +
      `${CONCEPT_RULES.length} concept rules THIS CALL'S OWN concepts/ruleIds filter selected: ` +
      `${rulesNotApplicable} are provably inapplicable to this component type and ` +
      `${rulesNotEvaluable} could not be evaluated at all. The other ` +
      `${CONCEPT_RULES.length - rulesSelected} rules were excluded by the filter, not by the ` +
      `vault — re-run without it for the model's full verdict. This is silence, NOT a finding of ` +
      '"no issues".';

/** Appended when NO rule fired — the honest non-absence framing. */
const EMPTY_DISCLOSURE_NOTE =
  ' No concept rule fired for this component: this is NOT a claim that nothing depends on it — only that no curated reasoning ' +
  'rule matched the graph slice assembled for it.';

/** EPIC-5 severity × confidence ranking for proactive risk surfacing. */
const SEVERITY_RANK: Readonly<Record<ConceptSeverity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const CONFIDENCE_SCORE: Readonly<Record<ConfidenceLevel, number>> = {
  declared: 3,
  parsed: 2,
  heuristic: 1,
};

const rankProactiveRisks = (
  interpretations: readonly Interpretation[],
  topN = 5,
): readonly ProactiveRiskRow[] =>
  interpretations
    .filter(
      (i): i is Interpretation & { confidence: ConfidenceLevel } =>
        i.confidence !== 'unknown' && i.supersededBy === undefined,
    )
    .map((i) => {
      const severity: ConceptSeverity = CONCEPTS[i.concept]?.severity ?? 'medium';
      const riskScore = SEVERITY_RANK[severity] * CONFIDENCE_SCORE[i.confidence];
      return {
        ruleId: i.ruleId,
        concept: i.concept,
        severity,
        confidence: i.confidence,
        riskScore,
        claimPreview: i.claim.length > 160 ? `${i.claim.slice(0, 157)}…` : i.claim,
      };
    })
    .sort(
      (a, b) =>
        b.riskScore - a.riskScore ||
        a.concept.localeCompare(b.concept) ||
        a.ruleId.localeCompare(b.ruleId),
    )
    .slice(0, topN);

/**
 * The `sfi.interpret` MCP tool. A thin projection of the shared
 * {@link reasonAboutComponent} helper: the slice assembly, rule evaluation,
 * chain/compound/reconcile passes and coverage arithmetic all live in
 * `knowledge/reason-component.ts` now, so `sfi.interpret` and every tool that
 * composes concept reasoning run the SAME code path. This handler's job is
 * presentation only — proactive-risk ranking, the trust block, the disclosure
 * and the rendered Markdown. Its output is byte-unchanged by the extraction.
 *
 * `sfi.interpret` deliberately does NOT surface the helper's
 * `coverageReport` — that block is the composed tools' honesty disclosure, and
 * adding it here would change this tool's wire shape.
 *
 * @example
 *   const r = await interpretHandler(ctx, {
 *     componentId: 'CustomField:Account.Amount__c',
 *   });
 *   if (r.ok) console.log(r.value.data.interpretations);
 */
export const interpretHandler = async (
  ctx: Context,
  input: InterpretInput,
): Promise<Result<McpResponse<InterpretOutput>, McpError>> => {
  const componentId = input.componentId as ComponentId;

  const reasoned = await reasonAboutComponent(ctx, componentId, {
    ...(input.concepts !== undefined ? { concepts: input.concepts } : {}),
    ...(input.ruleIds !== undefined ? { ruleIds: input.ruleIds } : {}),
  });
  if (!reasoned.ok) {
    if (reasoned.error.kind === 'component-not-found') {
      return err({
        kind: 'component-not-found',
        message: await phantomAwareNotFoundMessage(ctx, componentId, 'component'),
        path: componentId,
      });
    }
    // QUESTION→ANCHOR BRIDGE — a natural identifier that names several
    // components is a NAMED, actionable failure carrying every candidate, never
    // a silent pick of the top score and never an empty result that would read
    // as "the reasoning engine had nothing to say about this".
    if (reasoned.error.kind === 'ambiguous-identifier') {
      const { identifier, candidates } = reasoned.error;
      return err({
        kind: 'invalid-query',
        message:
          `'${identifier}' matches ${candidates.length} components — name one exactly so the ` +
          'reasoning engine anchors on the component you mean: ' +
          candidates
            .map((c) =>
              c.parentApiName === null
                ? c.componentId
                : `${c.componentId} (${c.apiName} on ${c.parentApiName})`,
            )
            .join('; '),
        path: 'componentId',
        resolveSuggestions: candidates.map((c) => ({
          componentId: c.componentId,
          type: c.type,
          apiName: c.apiName,
          score: c.score,
          matchKind: 'resolver',
        })),
      });
    }
    return err({ kind: 'internal', message: reasoned.error.message });
  }

  const {
    componentId: anchorId,
    resolvedFrom,
    coverageReport,
    componentType,
    interpretations: interpretationsReconciled,
    selectedRules,
    rulesFired,
    sliceTruncated,
    unionCoverageTypes,
    aggSummary,
    aggCoverage,
    junctionMissNote,
    completenessStatus,
    topCoverageCaveat,
  } = reasoned.value;

  const proactiveRisks = rankProactiveRisks(interpretationsReconciled);

  // A caller-applied filter is not a coverage gap. When `concepts`/`ruleIds`
  // narrowed (or emptied) the rule set, the digest's "nothing was checked"
  // sentence must say the FILTER did it — see `filteredSelectionSummary`.
  const ruleFilterApplied =
    input.concepts !== undefined || input.ruleIds !== undefined;
  // R5 — `sfi.interpret` is UNCAPPED, so the digest keeps every enumeration.
  const baseCompleteness = toCompletenessDigest(
    coverageReport,
    Number.MAX_SAFE_INTEGER,
  );
  const completeness: ConceptCompletenessDigest =
    ruleFilterApplied && baseCompleteness.noRuleCoversComponentType
      ? {
          ...baseCompleteness,
          summary: filteredSelectionSummary(
            componentType,
            baseCompleteness.rulesConsidered,
            baseCompleteness.rulesNotApplicable,
            baseCompleteness.rulesNotEvaluable,
          ),
        }
      : baseCompleteness;

  // Overall confidence: the WEAKEST across fired interpretations. Any `unknown`
  // (an absence rule under non-complete coverage) makes the whole `unknown`; no
  // interpretation at all is `unknown` by construction.
  const firedConfidences = interpretationsReconciled.map((i) => i.confidence);
  const overallConfidence: ConfidenceLevel | 'unknown' =
    firedConfidences.length === 0 || firedConfidences.some((c) => c === 'unknown')
      ? 'unknown'
      : weakest(...(firedConfidences as ConfidenceLevel[]));

  const limitations = [
    'Deterministic concept-rule reasoning over the offline vault snapshot — not a live read, no LLM.',
    ...(aggCoverage.caveat !== null ? [aggCoverage.caveat] : []),
    ...(junctionMissNote !== null ? [junctionMissNote] : []),
  ];

  const trust: TrustSummary = {
    provenance: 'offline_snapshot',
    confidence: overallConfidence,
    freshness: buildMixedFreshness(ctx.manifest, unionCoverageTypes),
    completeness: {
      status: completenessStatus,
      ...(aggSummary.missingCoverage.length > 0
        ? { missingCoverage: aggSummary.missingCoverage }
        : {}),
    },
    limitations,
  };

  const resolvedNote =
    resolvedFrom === undefined
      ? ''
      : ` You asked about '${resolvedFrom.identifier}', which is not a canonical component id; ` +
        `it was resolved to ${anchorId} via the shared resolver (${resolvedFrom.matchKind}). ` +
        'Every claim below is about THAT component.';

  // R5 — the empty-result note must not claim rules RAN when none could. When
  // nothing was analysable, say that instead; `completeness.summary` carries the
  // exact bucket split either way.
  const emptyNote =
    interpretationsReconciled.length === 0
      ? completeness.noRuleCoversComponentType
        ? ` ${completeness.summary}`
        : EMPTY_DISCLOSURE_NOTE
      : '';

  const disclosure = BASE_DISCLOSURE + emptyNote + resolvedNote;

  const rendered = renderInterpretationsMarkdown({
    componentId: anchorId,
    componentType,
    interpretations: interpretationsReconciled,
    sliceTruncated,
    ...(topCoverageCaveat !== null ? { coverageCaveat: topCoverageCaveat } : {}),
    trust,
  });

  const data: InterpretOutput = {
    componentId: anchorId,
    ...(resolvedFrom !== undefined ? { resolvedFrom } : {}),
    completeness,
    componentType,
    interpretations: interpretationsReconciled,
    ...(proactiveRisks.length > 0 ? { proactiveRisks } : {}),
    ...(ruleFilterApplied
      ? {
          ruleSelection: {
            ...(input.concepts !== undefined ? { concepts: input.concepts } : {}),
            ...(input.ruleIds !== undefined ? { ruleIds: input.ruleIds } : {}),
            rulesSelected: selectedRules.length,
            rulesInModel: CONCEPT_RULES.length,
          },
        }
      : {}),
    // ONE authoritative counter — the same number `completeness.rulesConsidered`
    // publishes, read from the same report. `selectedRules.length` is that
    // number; the second-pass rules get their own field rather than inflating
    // this one into a count of nothing in particular.
    rulesConsidered: completeness.rulesConsidered,
    secondPassRules: SECOND_PASS_RULE_COUNT,
    rulesFired,
    sliceTruncated,
    trust,
    ...(topCoverageCaveat !== null ? { coverageCaveat: topCoverageCaveat } : {}),
    disclosure,
    rendered,
    evidenceEnvelope: buildInterpretEvidenceEnvelope({
      interpretations: interpretationsReconciled,
      trust,
      ...(topCoverageCaveat !== null ? { coverageCaveat: topCoverageCaveat } : {}),
      disclosure,
    }),
  };

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
