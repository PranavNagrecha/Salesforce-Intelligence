/**
 * EvidenceEnvelope v2 helpers (AUDIT-F4).
 *
 * Builds the shared output contract from existing tool payloads and asserts
 * the required shape at the handler boundary. Opt-in per tool — never applied
 * roster-wide (goldens stay additive).
 */

import type {
  ComponentId,
  EvidenceAbsenceStatusV2,
  EvidenceClaimV2,
  EvidenceCoverageV2,
  EvidenceEnvelopeV2,
  EvidenceRefV2,
  EvidenceVerdictV2,
  Interpretation,
  TrustSummary,
} from '@sf-intelligence/contracts';

import type { CoverageCaveat } from './coverage-trust.js';

/** Runtime errors when a migrated tool emits a malformed envelope. */
export class EvidenceEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceEnvelopeError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isConfidence = (value: unknown): boolean =>
  value === 'declared' ||
  value === 'parsed' ||
  value === 'heuristic' ||
  value === 'unknown';

const isCoverageStatus = (value: unknown): boolean =>
  value === 'complete' || value === 'partial' || value === 'unknown';

const isAbsenceStatus = (value: unknown): boolean =>
  value === 'proven-none' || value === 'not-checked' || value === 'unknown';

const isVerdict = (value: unknown): boolean =>
  value === 'safe' ||
  value === 'review' ||
  value === 'risky' ||
  value === 'blocking' ||
  value === 'unknown';

/**
 * Fail-closed runtime check for {@link EvidenceEnvelopeV2}. Call only from
 * handlers that opted into the v2 envelope (allowlisted tools).
 */
export function assertEvidenceEnvelopeV2(
  value: unknown,
): asserts value is EvidenceEnvelopeV2 {
  if (!isObject(value)) {
    throw new EvidenceEnvelopeError('evidenceEnvelope must be an object');
  }
  if (value.envelopeVersion !== 2) {
    throw new EvidenceEnvelopeError(
      `evidenceEnvelope.envelopeVersion must be 2 (got ${String(value.envelopeVersion)})`,
    );
  }
  if (!Array.isArray(value.claims)) {
    throw new EvidenceEnvelopeError('evidenceEnvelope.claims must be an array');
  }
  for (const [i, claim] of value.claims.entries()) {
    if (!isObject(claim) || typeof claim.claim !== 'string') {
      throw new EvidenceEnvelopeError(
        `evidenceEnvelope.claims[${i}].claim must be a string`,
      );
    }
    if (!Array.isArray(claim.groundedIn)) {
      throw new EvidenceEnvelopeError(
        `evidenceEnvelope.claims[${i}].groundedIn must be an array`,
      );
    }
    if (!isConfidence(claim.confidence)) {
      throw new EvidenceEnvelopeError(
        `evidenceEnvelope.claims[${i}].confidence is invalid`,
      );
    }
  }
  if (!Array.isArray(value.evidence)) {
    throw new EvidenceEnvelopeError('evidenceEnvelope.evidence must be an array');
  }
  for (const [i, ref] of value.evidence.entries()) {
    if (!isObject(ref) || typeof ref.componentId !== 'string') {
      throw new EvidenceEnvelopeError(
        `evidenceEnvelope.evidence[${i}].componentId must be a string`,
      );
    }
  }
  if (!isObject(value.coverage) || !isCoverageStatus(value.coverage.status)) {
    throw new EvidenceEnvelopeError(
      'evidenceEnvelope.coverage.status must be complete|partial|unknown',
    );
  }
  if (!isObject(value.freshness)) {
    throw new EvidenceEnvelopeError('evidenceEnvelope.freshness must be an object');
  }
  if (!isObject(value.trust)) {
    throw new EvidenceEnvelopeError('evidenceEnvelope.trust must be an object');
  }
  const trust = value.trust;
  if (
    trust.provenance !== 'offline_snapshot' &&
    trust.provenance !== 'live_org' &&
    trust.provenance !== 'hybrid'
  ) {
    throw new EvidenceEnvelopeError('evidenceEnvelope.trust.provenance is invalid');
  }
  if (!isConfidence(trust.confidence)) {
    throw new EvidenceEnvelopeError('evidenceEnvelope.trust.confidence is invalid');
  }
  if (!isObject(trust.completeness) || !isCoverageStatus(trust.completeness.status)) {
    throw new EvidenceEnvelopeError(
      'evidenceEnvelope.trust.completeness.status is invalid',
    );
  }
  if (!Array.isArray(trust.limitations)) {
    throw new EvidenceEnvelopeError(
      'evidenceEnvelope.trust.limitations must be an array',
    );
  }
  if (value.absence !== undefined) {
    if (!isObject(value.absence) || !isAbsenceStatus(value.absence.status)) {
      throw new EvidenceEnvelopeError(
        'evidenceEnvelope.absence.status must be proven-none|not-checked|unknown',
      );
    }
    if (
      value.absence.verdict !== undefined &&
      !isVerdict(value.absence.verdict)
    ) {
      throw new EvidenceEnvelopeError(
        'evidenceEnvelope.absence.verdict is invalid',
      );
    }
  }
}

const coverageFromTrust = (
  trust: TrustSummary,
  message?: string,
): EvidenceCoverageV2 => ({
  status: trust.completeness.status,
  ...(trust.completeness.missingCoverage !== undefined
    ? { missingCoverage: trust.completeness.missingCoverage }
    : {}),
  ...(message !== undefined ? { message } : {}),
});

const coverageFromCaveat = (
  trust: TrustSummary,
  caveat?: CoverageCaveat | string,
): EvidenceCoverageV2 => {
  if (typeof caveat === 'string') {
    return coverageFromTrust(trust, caveat);
  }
  if (caveat !== undefined) {
    return {
      status: caveat.status,
      missingCoverage: caveat.missingCoverage,
      message: caveat.message,
    };
  }
  return coverageFromTrust(trust);
};

const claimsFromInterpretations = (
  interpretations: readonly Interpretation[],
): EvidenceClaimV2[] =>
  interpretations.map((row) => ({
    claim: row.claim,
    groundedIn: row.groundedIn,
    confidence: row.confidence,
    coverageCaveat: row.coverageCaveat,
    ruleId: row.ruleId,
    concept: row.concept,
  }));

const evidenceFromGroundedIds = (
  interpretations: readonly Interpretation[],
): EvidenceRefV2[] => {
  const seen = new Set<string>();
  const out: EvidenceRefV2[] = [];
  for (const row of interpretations) {
    for (const id of row.groundedIn) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ componentId: id, role: 'groundedIn' });
    }
  }
  return out;
};

/** Build v2 envelope for `sfi.interpret` from its existing payload fields. */
export const buildInterpretEvidenceEnvelope = (args: {
  readonly interpretations: readonly Interpretation[];
  readonly trust: TrustSummary;
  readonly coverageCaveat?: string;
  readonly disclosure: string;
}): EvidenceEnvelopeV2 => {
  const envelope: EvidenceEnvelopeV2 = {
    envelopeVersion: 2,
    claims: claimsFromInterpretations(args.interpretations),
    evidence: evidenceFromGroundedIds(args.interpretations),
    coverage: coverageFromCaveat(args.trust, args.coverageCaveat),
    freshness: args.trust.freshness,
    trust: args.trust,
    absence: {
      status: 'unknown',
      note:
        args.interpretations.length === 0
          ? 'No concept rule fired — this is NOT an absence claim that nothing depends on the component.'
          : 'Interpret returns structural implications, not proven-none / unused absence verdicts.',
    },
    disclosure: args.disclosure,
  };
  assertEvidenceEnvelopeV2(envelope);
  return envelope;
};

export interface SafeToDeleteEnvelopeSource {
  readonly fieldId: ComponentId;
  readonly verdict: EvidenceVerdictV2;
  readonly reasoning: readonly {
    readonly category: string;
    readonly verdict: EvidenceVerdictV2;
    readonly count: number;
    readonly examples: readonly { readonly id: ComponentId }[];
    readonly note: string;
  }[];
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
}

const absenceStatusForDelete = (
  verdict: EvidenceVerdictV2,
  caveat: CoverageCaveat | undefined,
): EvidenceAbsenceStatusV2 => {
  if (caveat !== undefined) return 'not-checked';
  if (verdict === 'safe') return 'proven-none';
  return 'unknown';
};

/** Build v2 envelope for `sfi.safe_to_delete_field` from its existing fields. */
export const buildSafeToDeleteEvidenceEnvelope = (
  source: SafeToDeleteEnvelopeSource,
): EvidenceEnvelopeV2 => {
  const claims: EvidenceClaimV2[] = source.reasoning.map((row) => ({
    claim: row.note,
    groundedIn: row.examples.map((ex) => ex.id),
    confidence: source.trust.confidence,
    coverageCaveat: source.coverageCaveat?.message ?? null,
    ruleId: `safe-to-delete:${row.category}`,
    concept: row.category,
  }));

  const evidence: EvidenceRefV2[] = [];
  const seen = new Set<string>();
  evidence.push({ componentId: source.fieldId, role: 'target' });
  seen.add(source.fieldId);
  for (const row of source.reasoning) {
    for (const ex of row.examples) {
      if (seen.has(ex.id)) continue;
      seen.add(ex.id);
      evidence.push({
        componentId: ex.id,
        role: row.category,
        note: `category verdict: ${row.verdict} (count ${row.count})`,
      });
    }
  }

  const status = absenceStatusForDelete(source.verdict, source.coverageCaveat);
  const envelope: EvidenceEnvelopeV2 = {
    envelopeVersion: 2,
    claims,
    evidence,
    coverage: coverageFromCaveat(source.trust, source.coverageCaveat),
    freshness: source.trust.freshness,
    trust: source.trust,
    absence: {
      status,
      verdict: source.verdict,
      note:
        status === 'proven-none'
          ? 'No static referrers found under complete coverage for the families this tool checks.'
          : status === 'not-checked'
            ? 'Absence of referrers is not proven — treat as "not checked", not "none".'
            : 'Presence / severity evidence answered the ask; absence is not the primary claim.',
    },
  };
  assertEvidenceEnvelopeV2(envelope);
  return envelope;
};
