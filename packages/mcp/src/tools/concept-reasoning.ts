/**
 * REASONING-REACHABILITY — the shared seam that lets a component-anchored tool
 * carry deterministic concept-rule claims inside its OWN answer.
 *
 * Background: the concept model (142 concepts / 193 rules) used to be reachable
 * through exactly one leaf tool, `sfi.interpret`, anchored on a `componentId`
 * the caller had to already know. No other tool composed it, so the reasoning
 * engine never ran as part of an answer anyone actually asked for. This module
 * is the adapter: given a component a tool has ALREADY resolved, it runs
 * {@link reasonAboutComponent} ONCE and projects the result onto the shared
 * {@link EvidenceEnvelopeV2} contract — the same claims / evidence / coverage /
 * absence / freshness / trust shape `sfi.interpret` and
 * `sfi.safe_to_delete_field` already emit. It does NOT invent a competing shape.
 *
 * WHAT GETS CAPPED, AND WHY IT IS NOT THE CLAIMS. An earlier revision fitted the
 * block to a byte ceiling by dropping CLAIMS. That optimized exactly backwards:
 * measured over 75 real components it discarded every cited claim — the product
 * — and still blew the ceiling by ~89%, because the irreducible bulk was never
 * the claims (a handful of sentences) but the `completeness` ENUMERATIONS: a
 * multi-kilobyte list of rule ids that did not apply. The honesty axis is the
 * COUNTS and the summary sentence, not the full id list. So:
 *
 *   - `claims` are PRESERVED (capped only at {@link COMPOSED_CLAIM_CAP}, which a
 *     real component never reaches);
 *   - the per-concept ENUMERATIONS are sampled at {@link CONCEPT_LIST_SAMPLE_CAP}
 *     with an explicit `…and N more` marker in `sampled`;
 *   - every COUNT, the per-reason split, the flags and the summary are verbatim.
 *
 * ONE REASONING PASS. {@link reasonAboutComponent} is called exactly once; the
 * fit to a byte ceiling is a PURE re-projection of that one result
 * ({@link projectConceptReasoning}), never another graph traversal. The earlier
 * revision re-ran the whole engine 4-6 times per call.
 *
 * TWO KINDS OF "NOT EVALUABLE", NEVER MERGED. The classifier distinguishes
 * `vault-coverage-missing` (the vault never retrieved a family the rule reads —
 * a real gap with a real remedy) from `shape-not-provable` (the rule RAN against
 * the slice and matched nothing, but its inapplicability could not be PROVEN).
 * They imply different user actions, so they get separate counts, separate
 * sentences, and separate `absence` treatment. Only the first is ever blamed on
 * retrieval; only the first can drive `absence.status: 'not-checked'`.
 *
 * Cost: one `listEdgesForNodes` + one `listNodesByIds` over the component's
 * bound-type edges, capped at `SLICE_EDGE_CAP` (1,000), plus the conditional
 * second hops the selected rule shapes require (each capped at
 * `JOIN_FANOUT_CAP`). Callers that already hold the root `Node` pass it through
 * `rootNode` so no redundant `getNodeById` is issued. Offline and read-only.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  EvidenceAbsenceV2,
  EvidenceClaimV2,
  EvidenceCoverageV2,
  EvidenceEnvelopeV2,
  EvidenceRefV2,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { buildMixedFreshness } from '@sf-intelligence/vault';

import {
  type ConceptCoverageReport,
  reasonAboutComponent,
  type ReasonAboutComponentResult,
  type ReasonContext,
  type UnevaluableReason,
  type UnevaluableRule,
  weakest,
} from '../knowledge/index.js';

import { assertEvidenceEnvelopeV2 } from './evidence-envelope.js';

/**
 * Cap on claims surfaced inside a COMPOSED answer. An edge-shaped rule can emit
 * one interpretation per matched edge, so a hub could otherwise dominate the
 * host's response. `sfi.interpret` is the uncapped surface. This is a ceiling a
 * real component does not reach — claims are NOT the size problem.
 */
export const COMPOSED_CLAIM_CAP = 25;

/**
 * How many entries each per-concept enumeration may carry inside a COMPOSED
 * answer. THIS is the size lever: the classifier deliberately routes every rule
 * it cannot PROVE inapplicable into `notEvaluable`, so on a sparse component
 * those lists approach the full rule count and dwarf everything else in the
 * payload. Counts beside them stay exact; only the enumeration is sampled.
 */
export const CONCEPT_LIST_SAMPLE_CAP = 5;

/**
 * Ceiling for a composed reasoning block, in bytes. A block that fits this is
 * safe to attach by DEFAULT to any tool, which is the whole point: the size
 * defect is what made default-on dangerous, not the default itself.
 *
 * SET FROM MEASUREMENT, not preference. With every enumeration emptied
 * (`listCap: 0`) AND zero claims, the block still measures ~2,470 bytes,
 * because what remains is irreducible honesty PROSE, not data:
 *
 *   disclosure   ~830 B   the four conditional honesty sentences
 *   completeness ~540 B   exact counts + the summary sentence
 *   trust        ~270 B   provenance / confidence / freshness / limitations
 *   absence      ~123 B   the not-checked vs unknown verdict and why
 *   coverage      ~21 B
 *
 * A 2,000-byte target is therefore unreachable without deleting one of those
 * sentences — which is the honesty axis the whole seam exists to carry. 3,500
 * leaves ~1 KB for real claims plus a sampled enumeration, is 7.8% of the 45 KB
 * global response cap (the earlier 8,000 was 18%), and is 4.3x smaller than the
 * 15 KB blocks measured before the enumeration cap landed.
 *
 * It is a TARGET, not a hard guarantee. A component whose claims are unusually
 * long can land slightly above it (measured worst case ~3.9 KB on an ApexClass
 * with two long async-boundary claims), and that is the correct outcome: the fit
 * will not delete cited claims or honesty prose to hit a round number. What it
 * guarantees is that the enumerations — the part that actually scaled to 15 KB —
 * are bounded first.
 */
export const CONCEPT_RESERVATION_MAX_BYTES = 3_500;

/**
 * HARD stop above which claims may finally be trimmed.
 *
 * Between {@link CONCEPT_RESERVATION_MAX_BYTES} and this value the block is
 * simply accepted over target: measured, an ApexClass with two long
 * async-boundary claims lands at 4,343 B, and the only way to reach 3,500 was to
 * delete one of the two claims — trading the product for 463 bytes. That is the
 * same backwards trade the earlier revision made at scale, just smaller, so the
 * fit now tolerates a modest overshoot instead.
 *
 * Above 6,000 B the block genuinely is dominated by claims (a hub firing an edge
 * rule once per matched edge), and trimming them is the correct call.
 */
export const CONCEPT_BLOCK_HARD_MAX_BYTES = 6_000;

/** Rank for the deterministic claim cut: strongest confidence first. */
const CONFIDENCE_SCORE: Readonly<Record<ConfidenceLevel | 'unknown', number>> = {
  declared: 3,
  parsed: 2,
  heuristic: 1,
  unknown: 0,
};

/** Which enumerations were sampled, and out of how many. Counts stay exact. */
export interface ConceptListSampling {
  readonly conceptsCheckedClean?: { readonly returned: number; readonly total: number };
  readonly conceptsNotApplicable?: { readonly returned: number; readonly total: number };
  readonly conceptsNotEvaluable?: { readonly returned: number; readonly total: number };
}

/**
 * Bounded projection of {@link ConceptCoverageReport} for a composed answer.
 *
 * Counts are EXACT and complete; enumerations are sampled at
 * {@link CONCEPT_LIST_SAMPLE_CAP} with the shortfall named in `sampled`, so a
 * reader can always tell "5 of 143 shown" from "5 of 5". Nothing carrying an
 * honesty signal is dropped: the bucket counts, the per-reason split,
 * `noRuleCoversComponentType`, `sliceTruncated` and `summary` are always whole.
 */
export interface ConceptCompletenessDigest {
  readonly rulesConsidered: number;
  readonly rulesFired: number;
  readonly rulesCheckedClean: number;
  readonly rulesNotApplicable: number;
  readonly rulesNotEvaluable: number;
  /**
   * The `notEvaluable` count split by WHY. `vault-coverage-missing` is a real
   * retrieval gap with a real remedy; `shape-not-provable` means the rule RAN
   * and matched nothing but its inapplicability was not proven. They imply
   * different user actions, so they are never merged into one number.
   */
  readonly rulesNotEvaluableByReason: Readonly<Record<UnevaluableReason, number>>;
  /** Complete — bounded by the claim cap already applied. */
  readonly conceptsFired: readonly string[];
  readonly conceptsCheckedClean: readonly string[];
  readonly conceptsNotApplicable: readonly string[];
  readonly conceptsNotEvaluable: readonly UnevaluableRule[];
  /** Present only when at least one enumeration above was sampled. */
  readonly sampled?: ConceptListSampling;
  readonly noRuleCoversComponentType: boolean;
  readonly sliceTruncated: boolean;
  readonly summary: string;
}

/**
 * An {@link EvidenceEnvelopeV2} EXTENDED with the concept-layer completeness
 * digest. Every base field keeps its shared meaning; `completeness` is the
 * additive honesty axis that distinguishes "checked and clean" from "never
 * checked".
 */
export interface ConceptReasoningEnvelope extends EvidenceEnvelopeV2 {
  /** Which concept layers were checked, skipped, or could not be evaluated. */
  readonly completeness: ConceptCompletenessDigest;
  /**
   * Present ONLY when the claim list was capped. `total` is how many claims the
   * engine emitted; `returned` is how many are in `claims`. The cut is
   * deterministic (highest confidence first, ties by rule id) — never silent.
   */
  readonly claimsTruncated?: { readonly returned: number; readonly total: number };
  /**
   * QUESTION→ANCHOR BRIDGE — present when the caller's identifier was not a
   * canonical id and the shared resolver mapped it onto the anchor this block
   * describes. Relay it: the user named one thing, these claims are about
   * another.
   */
  readonly resolvedFrom?: ReasonAboutComponentResult['resolvedFrom'];
}

const sampleOf = <T>(
  rows: readonly T[],
  cap: number,
): { readonly rows: readonly T[]; readonly note?: { returned: number; total: number } } =>
  rows.length <= cap
    ? { rows }
    : { rows: rows.slice(0, cap), note: { returned: cap, total: rows.length } };

/** Split the unevaluable rows by reason. Both counts are exact. */
const countByReason = (
  rows: readonly UnevaluableRule[],
): Record<UnevaluableReason, number> => {
  const byReason: Record<UnevaluableReason, number> = {
    'vault-coverage-missing': 0,
    'shape-not-provable': 0,
  };
  for (const row of rows) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
  return byReason;
};

/** Project the full coverage report onto its bounded, response-safe digest. */
export const toCompletenessDigest = (
  report: ConceptCoverageReport,
  cap = CONCEPT_LIST_SAMPLE_CAP,
): ConceptCompletenessDigest => {
  const clean = sampleOf(report.conceptsCheckedClean, cap);
  const notApplicable = sampleOf(report.conceptsNotApplicable, cap);
  const notEvaluable = sampleOf<UnevaluableRule>(report.conceptsNotEvaluable, cap);

  const sampled: ConceptListSampling = {
    ...(clean.note !== undefined ? { conceptsCheckedClean: clean.note } : {}),
    ...(notApplicable.note !== undefined ? { conceptsNotApplicable: notApplicable.note } : {}),
    ...(notEvaluable.note !== undefined ? { conceptsNotEvaluable: notEvaluable.note } : {}),
  };

  return {
    rulesConsidered: report.rulesConsidered,
    rulesFired: report.rulesFired,
    rulesCheckedClean: report.rulesCheckedClean,
    rulesNotApplicable: report.rulesNotApplicable,
    rulesNotEvaluable: report.rulesNotEvaluable,
    rulesNotEvaluableByReason: countByReason(report.conceptsNotEvaluable),
    conceptsFired: report.conceptsFired,
    conceptsCheckedClean: clean.rows,
    conceptsNotApplicable: notApplicable.rows,
    conceptsNotEvaluable: notEvaluable.rows,
    ...(Object.keys(sampled).length > 0 ? { sampled } : {}),
    noRuleCoversComponentType: report.noRuleCoversComponentType,
    sliceTruncated: report.sliceTruncated,
    summary: report.summary,
  };
};

/** Base disclosure — always present. */
const BASE_DISCLOSURE =
  'Deterministic concept-rule reasoning over the offline vault snapshot — NOT a live org read and NOT an LLM inference. ' +
  'Each claim is a curated structural rule fired against the graph slice assembled for this component; it cites the exact ' +
  'component ids it is grounded in, and its confidence is the weakest of the rule ceiling and its matched edges.';

/**
 * Appended when NOT ONE rule could be shown to apply.
 *
 * Deliberately does NOT say "the concept model has no rule for this component
 * type" — `noRuleCoversComponentType` is set when every rule was proven
 * inapplicable OR merely undetermined, and the stronger claim would be false for
 * the undetermined half. Says what is actually known instead.
 */
const noCoverageNote = (digest: ConceptCompletenessDigest, rootType: string): string =>
  ` NOT ONE concept rule could be SHOWN to apply to this ${rootType}: ` +
  `${digest.rulesNotApplicable} are provably inapplicable to this component type and ` +
  `${digest.rulesNotEvaluable} could not be evaluated at all. NOTHING was analysed here — ` +
  'this is silence, NOT a finding that the component is clean.';

/** Appended when rules applied but none fired. */
const NONE_FIRED_NOTE =
  ' No concept rule fired for this component. That is not a claim that nothing depends on it — only that no curated ' +
  'reasoning rule matched the graph slice assembled for it.';

/**
 * Appended ONLY for rules blocked by a real RETRIEVAL gap.
 *
 * An earlier revision keyed this on the TOTAL unevaluable count and blamed the
 * vault — so on components where every unevaluable rule was `shape-not-provable`
 * it shipped a false statement about the user's vault on every single call.
 * `shape-not-provable` has nothing to do with retrieval and is described
 * separately below.
 */
const vaultGapNote = (n: number): string =>
  ` ${n} concept rule${n === 1 ? '' : 's'} could NOT be evaluated because the metadata famil` +
  `${n === 1 ? 'y it depends' : 'ies they depend'} on was not retrieved into this vault — ` +
  'treat those layers as unchecked, not as clean.';

/**
 * Appended for rules that RAN and matched nothing but whose inapplicability the
 * classifier could not prove. Worded to say exactly that — these rules DID
 * execute, so calling them "not checked" would be false.
 */
const notProvableNote = (n: number): string =>
  ` ${n} further rule${n === 1 ? '' : 's'} ran against this component and matched nothing, but ` +
  `${n === 1 ? 'its' : 'their'} bind shape could not be PROVEN inapplicable here, so ` +
  `${n === 1 ? 'it is' : 'they are'} reported as undetermined rather than as a clean result.`;

/**
 * Absence verdict.
 *
 * ONLY a real retrieval gap (or a truncated slice) makes this `not-checked`.
 * `shape-not-provable` must NOT drive it: an earlier revision keyed on the total
 * and returned `'not-checked'` on 100% of calls, which carried zero information.
 */
const absenceFor = (digest: ConceptCompletenessDigest): EvidenceAbsenceV2 => {
  const vaultGap = digest.rulesNotEvaluableByReason['vault-coverage-missing'];
  if (digest.noRuleCoversComponentType) {
    return {
      status: 'not-checked',
      note:
        'Not one concept rule could be shown to apply to this component — the reasoning layer was not ' +
        'exercised. An empty claim list here means "not checked", never "checked and clean".',
    };
  }
  if (vaultGap > 0 || digest.sliceTruncated) {
    return {
      status: 'not-checked',
      note:
        `${digest.rulesCheckedClean} rule(s) were evaluated against this component and found nothing, but ` +
        `${vaultGap} could not be evaluated because the vault lacks their metadata` +
        (digest.sliceTruncated ? ', and the graph slice was truncated at its cap' : '') +
        '. Those layers are unchecked, not clean.',
    };
  }
  return {
    status: 'unknown',
    note:
      digest.rulesFired > 0
        ? 'Concept reasoning returns structural implications, not proven-none / unused absence verdicts.'
        : `All ${digest.rulesCheckedClean} applicable concept rule(s) were evaluated against this component ` +
          'and matched nothing. That is "checked, no structural implication found" for THOSE rules only — ' +
          'not an absence claim about the component.',
  };
};

/**
 * PURE projection of one reasoning result onto the shared envelope. No graph
 * access — every knob here re-shapes an already-computed result, which is what
 * makes fitting to a byte ceiling cheap.
 */
export const projectConceptReasoning = (
  ctx: ReasonContext,
  reasoned: ReasonAboutComponentResult,
  opts: { readonly maxClaims?: number; readonly listCap?: number } = {},
): ConceptReasoningEnvelope => {
  const {
    componentId,
    componentType,
    interpretations,
    unionCoverageTypes,
    aggSummary,
    aggCoverage,
    junctionMissNote,
    completenessStatus,
    topCoverageCaveat,
    coverageReport,
    resolvedFrom,
  } = reasoned;

  const digest = toCompletenessDigest(coverageReport, opts.listCap ?? CONCEPT_LIST_SAMPLE_CAP);

  // Deterministic cap: strongest confidence first, ties by rule id then claim
  // text, so the same vault always yields the same cut.
  const cap = opts.maxClaims ?? COMPOSED_CLAIM_CAP;
  const ranked = [...interpretations].sort(
    (a, b) =>
      CONFIDENCE_SCORE[b.confidence] - CONFIDENCE_SCORE[a.confidence] ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.claim.localeCompare(b.claim),
  );
  const kept = ranked.slice(0, cap);
  const claimsTruncated =
    kept.length < interpretations.length
      ? { returned: kept.length, total: interpretations.length }
      : undefined;

  const claims: EvidenceClaimV2[] = kept.map((row) => ({
    claim: row.claim,
    groundedIn: row.groundedIn,
    confidence: row.confidence,
    coverageCaveat: row.coverageCaveat,
    ruleId: row.ruleId,
    concept: row.concept,
  }));

  const evidence: EvidenceRefV2[] = [];
  const seen = new Set<string>();
  evidence.push({ componentId, role: 'anchor' });
  seen.add(componentId);
  for (const row of kept) {
    for (const id of row.groundedIn) {
      if (seen.has(id)) continue;
      seen.add(id);
      evidence.push({ componentId: id, role: 'groundedIn' });
    }
  }

  const firedConfidences = interpretations.map((i) => i.confidence);
  const overallConfidence: ConfidenceLevel | 'unknown' =
    firedConfidences.length === 0 || firedConfidences.some((c) => c === 'unknown')
      ? 'unknown'
      : weakest(...(firedConfidences as ConfidenceLevel[]));

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
    limitations: [
      'Deterministic concept-rule reasoning over the offline vault snapshot — not a live read, no LLM.',
      // `completeness.summary` is NOT repeated here: it already travels in this
      // same payload, and duplicating a ~380-byte sentence into every block was
      // pure weight with no added honesty.
      'What was and was not checked is in `completeness` (exact counts) and `completeness.summary`.',
      ...(aggCoverage.caveat !== null ? [aggCoverage.caveat] : []),
      ...(junctionMissNote !== null ? [junctionMissNote] : []),
    ],
  };

  const coverage: EvidenceCoverageV2 = {
    status: completenessStatus,
    ...(aggSummary.missingCoverage.length > 0
      ? { missingCoverage: aggSummary.missingCoverage }
      : {}),
    ...(topCoverageCaveat !== null ? { message: topCoverageCaveat } : {}),
  };

  const vaultGap = digest.rulesNotEvaluableByReason['vault-coverage-missing'];
  const notProvable = digest.rulesNotEvaluableByReason['shape-not-provable'];

  const disclosure =
    BASE_DISCLOSURE +
    (digest.noRuleCoversComponentType
      ? noCoverageNote(digest, componentType)
      : interpretations.length === 0
        ? NONE_FIRED_NOTE
        : '') +
    (vaultGap > 0 ? vaultGapNote(vaultGap) : '') +
    (notProvable > 0 ? notProvableNote(notProvable) : '') +
    (claimsTruncated !== undefined
      ? ` Showing the ${claimsTruncated.returned} highest-confidence of ${claimsTruncated.total} claims to fit the response budget; ` +
        'call `sfi.interpret` on this component for the complete, uncapped list.'
      : '') +
    (digest.sampled !== undefined
      ? ' The per-concept lists in `completeness` are SAMPLES — every count beside them is exact, and ' +
        '`completeness.sampled` names how many were withheld.'
      : '') +
    (resolvedFrom !== undefined
      ? ` You named '${resolvedFrom.identifier}', which is not a canonical component id; it was resolved to ` +
        `${componentId} via the shared resolver. Every claim here is about THAT component.`
      : '');

  const envelope: ConceptReasoningEnvelope = {
    envelopeVersion: 2,
    claims,
    evidence,
    coverage,
    freshness: trust.freshness,
    trust,
    absence: absenceFor(digest),
    disclosure,
    completeness: digest,
    ...(claimsTruncated !== undefined ? { claimsTruncated } : {}),
    ...(resolvedFrom !== undefined ? { resolvedFrom } : {}),
  };
  assertEvidenceEnvelopeV2(envelope);
  return envelope;
};

/**
 * Run the concept rules for one already-resolved component and project the
 * result onto the shared evidence envelope.
 *
 * Returns `null` — never a throw and never a partial answer — when the component
 * cannot be resolved OR the graph read fails. A composing tool MUST still say
 * something in that case: absence of the block is not evidence of absence, and
 * a silently missing block is exactly the conflation this product exists to
 * prevent. See {@link CONCEPT_REASONING_UNAVAILABLE_NOTE}.
 */
export const buildConceptReasoningEnvelope = async (
  ctx: ReasonContext,
  componentId: ComponentId,
  opts: {
    readonly rootNode?: Node;
    readonly maxClaims?: number;
    readonly listCap?: number;
    readonly resolveIdentifier?: boolean;
  } = {},
): Promise<ConceptReasoningEnvelope | null> => {
  const reasoned = await reasonAboutComponent(ctx, componentId, {
    ...(opts.rootNode !== undefined ? { rootNode: opts.rootNode } : {}),
    ...(opts.resolveIdentifier !== undefined
      ? { resolveIdentifier: opts.resolveIdentifier }
      : {}),
  });
  if (!reasoned.ok) return null;
  return projectConceptReasoning(ctx, reasoned.value, {
    ...(opts.maxClaims !== undefined ? { maxClaims: opts.maxClaims } : {}),
    ...(opts.listCap !== undefined ? { listCap: opts.listCap } : {}),
  });
};

/**
 * The sentence a composing tool MUST emit when the reasoning block is absent
 * because it could not be produced. `null` covers BOTH a component that did not
 * resolve AND a graph read that failed, so the wording attributes neither.
 */
export const CONCEPT_REASONING_UNAVAILABLE_NOTE = (id: string): string =>
  `Concept reasoning could NOT be run for ${id} — the component did not resolve, or its graph ` +
  'slice could not be read. No concept layer was checked here. That is "not checked", not ' +
  '"nothing found".';

/** The sentence a composing tool MUST emit when the caller opted OUT. */
export const CONCEPT_REASONING_SKIPPED_NOTE =
  'Concept-rule reasoning was NOT run for this component (includeConceptReasoning: false), so no ' +
  'structural implication was checked. That is "not checked", not "nothing found".';

/** A fitted reasoning block plus the bytes it occupies. */
export interface ReservedConceptReasoning {
  readonly envelope: ConceptReasoningEnvelope;
  /**
   * Serialized size of `envelope`. INFORMATIONAL for a host tool's disclosure —
   * a host must NOT subtract this from a budget that already measures the
   * payload containing the block (that double-counts; see
   * `soe-payload-bounds.ts`, which measures `sizeOf(payload)` whole).
   */
  readonly reservedBytes: number;
  /** True when the fit had to sample harder than the default to stay in budget. */
  readonly reservationCapped: boolean;
}

/**
 * Build a concept-reasoning block FITTED to a byte ceiling.
 *
 * The engine runs ONCE; fitting is a pure re-projection of that single result at
 * successively tighter ENUMERATION caps. Claims are preserved — they are the
 * product, and they were never the size problem. Coverage, absence, trust, the
 * bucket counts and the summary are never trimmed.
 *
 * Returns `null` (never a throw) when the component cannot be resolved or the
 * graph read fails, so a composing tool omits the block — and, per the honesty
 * contract, says so with {@link CONCEPT_REASONING_UNAVAILABLE_NOTE}.
 */
export const buildReservedConceptReasoning = async (
  ctx: ReasonContext,
  componentId: ComponentId,
  opts: {
    readonly rootNode?: Node;
    readonly maxBytes?: number;
    readonly resolveIdentifier?: boolean;
  } = {},
): Promise<ReservedConceptReasoning | null> => {
  const ceiling = opts.maxBytes ?? CONCEPT_RESERVATION_MAX_BYTES;

  // ONE traversal. Everything below re-projects this same result.
  const reasoned = await reasonAboutComponent(ctx, componentId, {
    ...(opts.rootNode !== undefined ? { rootNode: opts.rootNode } : {}),
    ...(opts.resolveIdentifier !== undefined
      ? { resolveIdentifier: opts.resolveIdentifier }
      : {}),
  });
  if (!reasoned.ok) return null;

  const sizeOf = (e: ConceptReasoningEnvelope): number =>
    Buffer.byteLength(JSON.stringify(e), 'utf8');

  let envelope = projectConceptReasoning(ctx, reasoned.value);
  let bytes = sizeOf(envelope);
  if (bytes <= ceiling) {
    return { envelope, reservedBytes: bytes, reservationCapped: false };
  }

  // Tighten the ENUMERATIONS first — that is where the bytes are. Counts and
  // summary survive every step, so the honesty axis is never what gets cut.
  for (const listCap of [3, 1, 0]) {
    envelope = projectConceptReasoning(ctx, reasoned.value, { listCap });
    bytes = sizeOf(envelope);
    if (bytes <= ceiling) return { envelope, reservedBytes: bytes, reservationCapped: true };
  }

  // Past this point the enumerations are EMPTY, so whatever remains is either
  // irreducible honesty prose (~2.5 KB measured, floor with ZERO claims and ZERO
  // rows) or genuinely enormous claims.
  //
  // A modest overshoot is ACCEPTED rather than paid for with claims. The guard
  // is load-bearing: the earlier revision halved claims to chase a round number
  // and, measured across 75 components, ended with zero claims while still
  // exceeding the ceiling by 89% — it destroyed the answer and did not even buy
  // the budget. Only a block past the hard stop is dominated by its claims.
  const hardMax = Math.max(ceiling, CONCEPT_BLOCK_HARD_MAX_BYTES);
  if (bytes <= hardMax) {
    return { envelope, reservedBytes: bytes, reservationCapped: true };
  }

  let claimCap = envelope.claims.length;
  while (bytes > hardMax && claimCap > 1) {
    claimCap = Math.floor(claimCap / 2);
    envelope = projectConceptReasoning(ctx, reasoned.value, { listCap: 0, maxClaims: claimCap });
    bytes = sizeOf(envelope);
  }
  return { envelope, reservedBytes: bytes, reservationCapped: true };
};
