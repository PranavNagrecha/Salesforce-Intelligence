/**
 * Handler for the `sfi.synthesize_answer` MCP tool — the v0.2 "answer layer".
 *
 * The other 130+ tools return structured JSON; turning that into a user-facing
 * answer is the caller's job, and an LLM doing it free-hand can fabricate
 * component ids or drop the honesty caveats. This tool is a DETERMINISTIC
 * grounding pass over the JSON the caller already has: it extracts the
 * canonical-id CITATIONS actually present, carries the CAVEATS verbatim, pulls
 * the headline FACTS into bullets, and — when given a `draft` narrative —
 * flags any canonical id in the draft that is NOT in the source
 * (`hallucinatedIds`). An input reduced by the global response byte budget
 * (a `responseBudget` truncation block, P13-GUARD-global-size) is carried as
 * an explicit caveat with the dropped/trimmed counts: a synthesis over
 * truncated data must never read absence as evidence.
 *
 * It is a pure transform: it reads ONLY the supplied `input`, never the graph
 * or the live org, so it can never add a fact that was not handed to it. Prose
 * wording is still the caller's job (mirroring the `explain_*` "Claude composes
 * prose" convention); this tool guarantees the GROUNDING, not the sentences.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * A canonical id as a WHOLE string value: a PascalCase type prefix, a colon,
 * then a non-whitespace remainder (`CustomField:Contact.Email`). The
 * no-whitespace rule rejects prose and SOQL ("SELECT COUNT() FROM Account")
 * while matching every real id, so the citation set can only ever be a subset
 * of what the input literally contains.
 */
const CANONICAL_ID_WHOLE = /^[A-Z][A-Za-z0-9]+:[^\s]+$/;

/**
 * Same shape, found INLINE in a prose draft (for hallucination checking). The
 * id may contain `.`/`/`/`-` internally but must END in an alphanumeric or `_`,
 * so trailing sentence punctuation ("…Conga_Batch_Manager.") is not captured
 * into the id (which would mis-flag a grounded id as hallucinated).
 */
const CANONICAL_ID_INLINE = /\b[A-Z][A-Za-z0-9]+:[A-Za-z0-9_./-]*[A-Za-z0-9_]/g;

/** Keys whose string (or string[]) values are honesty/caveat text. */
const CAVEAT_KEY =
  /^(disclosure|caveat|caveats|note|notes|boundary|boundaries|limitation|limitations|notModeledNote|honesty|warning|warnings)$/i;

/** Keys whose scalar values are headline facts worth a bullet. */
const FACT_KEY =
  /^(count|total|totalCount|totalClassCount|totalFindingCount|totalGapsCount|verdict|disposition|status|coverageStatus|riskLevel|truncated|notModeled|plane|intent|confidence|matchKind|fieldLabel|fieldId|piiClassification|piiCategory)$/;

/** Array keys worth a "N item(s)" count bullet. */
const COUNT_ARRAY_KEY =
  /^(grants|findings|gaps|components|candidates|edges|nodes|reasoning|viaApexAccess|fields|matches|classes|tools)$/;

/** Key whose string value is a source tool's trust provenance. */
const PROVENANCE_KEY = /^provenance$/i;

// P12-UX-synth-next-action — keys whose string values populate the grounded
// Finding → Evidence → Cause → Fix → Risk → Next-action template. Each field is
// lifted VERBATIM from the source tool output (never invented), so the
// evidence skeleton stays as grounded as the citations.
/** Keys whose string value names a likely CAUSE. */
const CAUSE_KEY = /^(reason|cause|rootCause|why|via|explanation)$/i;
/** Keys whose string value is a recommended FIX / remedy / guidance. */
const FIX_KEY =
  /^(recommendation|recommended|remedy|remediation|suggestedFix|resolution|boundaryNote|advice|retrievalHint)$/i;
/** Keys whose string value is a concrete NEXT step / action. */
const NEXT_KEY = /^(nextAction|nextStep|nextSteps|action|suggestion)$/i;

const MAX_CITATIONS = 200;
const MAX_BULLETS = 60;
const MAX_CAVEATS = 40;

const DISCLOSURE =
  'This answer skeleton is composed ONLY from the JSON supplied in `input`: ' +
  'every citation is an id that appears verbatim in that input, every caveat ' +
  'is carried from it, and no components, counts, or facts were invented. When ' +
  'a `draft` is supplied, `hallucinatedIds` lists canonical ids in the draft ' +
  'that are NOT in the source — remove or re-ground them before answering. ' +
  '`provenance` rolls up the source output’s trust provenance ' +
  '(offline_snapshot / live_org / hybrid) so the host can stamp the answer’s ' +
  'origin and never let a vault claim read as a live one. ' +
  'Prose wording is the caller’s job; this tool guarantees grounding, not ' +
  'sentences.';

/**
 * Zod schema for `sfi.synthesize_answer`.
 *   - `input` (required): the JSON returned by prior tool call(s) to ground on.
 *   - `question` (optional): the user's question, echoed into the summary.
 *   - `draft` (optional): a proposed narrative whose canonical ids are checked
 *     against the source so hallucinated ids surface before the user sees them.
 */
export const synthesizeAnswerInputSchema = z.object({
  input: z.unknown(),
  question: z.string().optional(),
  draft: z.string().optional(),
});

export type SynthesizeAnswerInput = z.infer<typeof synthesizeAnswerInputSchema>;

/** One grounded citation, parsed from a canonical id present in the input. */
export interface Citation {
  readonly id: ComponentId;
  /** The id's type prefix (the text before the first colon). */
  readonly type: string;
  /** The id's remainder (api name, or `Object.Field` for a field). */
  readonly apiName: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface SynthesizeAnswerOutput {
  readonly summary: string;
  readonly bullets: readonly string[];
  readonly citations: readonly Citation[];
  readonly caveats: readonly string[];
  /** Canonical ids in `draft` NOT found in the source; present only with a `draft`. */
  readonly hallucinatedIds?: readonly string[];
  /**
   * P13-ANNOT-tools laundering check: lifecycle claims ("X is deprecated")
   * the draft makes WITHOUT a backing annotation in the source. Present only
   * when a draft was supplied and at least one claim is ungrounded.
   */
  readonly ungroundedAnnotationClaims?: readonly UngroundedAnnotationClaim[];
  /** Canonical ids in `draft` confirmed present in the source; present only with a `draft`. */
  readonly groundedIds?: readonly string[];
  /**
   * Rolled-up provenance of the source tool output(s) so the host can stamp the
   * answer's origin. `stamp` is the single provenance when the input agrees,
   * `'hybrid'` when it fuses `offline_snapshot` + `live_org` (or carries
   * `hybrid`), `'mixed'` for any other multi-source combination, and `null`
   * when the input carried no provenance.
   */
  readonly provenance: {
    readonly stamp: string | null;
    readonly sources: readonly string[];
  };
  /** Grounded Finding → Evidence → Cause → Fix → Risk → Next-action skeleton. */
  readonly evidence: EvidenceTemplate;
  readonly disclosure: string;
}

interface Collected {
  readonly ids: Set<string>;
  readonly caveats: string[];
  readonly bullets: string[];
  readonly provenances: Set<string>;
  readonly causeHints: string[];
  readonly fixHints: string[];
  readonly nextHints: string[];
}

const MAX_HINTS = 8;

/**
 * The grounded Finding → Evidence → Cause → Fix → Risk → Next-action skeleton
 * (P12-UX-synth-next-action). Every field is lifted from the source tool output
 * — `null` when the source carried nothing for it (never fabricated).
 * `orphanComponentIds` lists any canonical id mentioned inside a cause/fix/next
 * string that is NOT independently cited (an ungrounded reference to flag).
 */
export interface EvidenceTemplate {
  readonly finding: string | null;
  readonly evidence: readonly string[];
  readonly likelyCause: string | null;
  readonly recommendedFix: string | null;
  readonly risk: string | null;
  readonly nextAction: string | null;
  readonly orphanComponentIds: readonly string[];
}

/** Push `s` onto `arr` (deduped) while it is under the cap. */
const pushCapped = (arr: string[], s: string, cap: number): void => {
  if (arr.length < cap && !arr.includes(s)) arr.push(s);
};

/**
 * Single recursive pass over the input. `key` is the property name the current
 * `value` sits under (null at the root / for array elements), which drives the
 * caveat- and fact-key matching.
 */
const collect = (value: unknown, key: string | null, out: Collected): void => {
  if (typeof value === 'string') {
    if (out.ids.size < MAX_CITATIONS && CANONICAL_ID_WHOLE.test(value)) {
      out.ids.add(value);
    }
    if (key !== null && PROVENANCE_KEY.test(key) && value.trim().length > 0) {
      out.provenances.add(value.trim());
    }
    if (key !== null && CAVEAT_KEY.test(key) && value.trim().length > 0) {
      pushCapped(out.caveats, value, MAX_CAVEATS);
    } else if (key !== null && FACT_KEY.test(key)) {
      pushCapped(out.bullets, `${key}: ${value}`, MAX_BULLETS);
    }
    // Grounded evidence-template hints (independent of the caveat/fact branch —
    // the key names do not overlap). Verbatim from the source, never invented.
    if (key !== null && value.trim().length > 0) {
      if (CAUSE_KEY.test(key)) pushCapped(out.causeHints, value.trim(), MAX_HINTS);
      else if (NEXT_KEY.test(key)) pushCapped(out.nextHints, value.trim(), MAX_HINTS);
      else if (FIX_KEY.test(key)) pushCapped(out.fixHints, value.trim(), MAX_HINTS);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (key !== null && FACT_KEY.test(key)) {
      pushCapped(out.bullets, `${key}: ${String(value)}`, MAX_BULLETS);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (key !== null && CAVEAT_KEY.test(key)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim().length > 0) {
          pushCapped(out.caveats, item, MAX_CAVEATS);
        }
      }
    } else if (key !== null && COUNT_ARRAY_KEY.test(key)) {
      pushCapped(out.bullets, `${key}: ${value.length} item(s)`, MAX_BULLETS);
    }
    // Recurse into elements with a null key — elements are not "under" the
    // array's property name, so they must not inherit its caveat/fact matching.
    for (const item of value) collect(item, null, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    if (key === 'responseBudget') {
      // P13-GUARD-synth-caveat: a tool response reduced by the global byte
      // budget must surface as an explicit caveat in the synthesis — absence
      // of a row in truncated input is NOT evidence of absence. One composed
      // caveat (with the counts) replaces the block's generic note; the
      // block is not recursed so the note is not double-carried.
      const rb = value as {
        readonly truncated?: boolean;
        readonly droppedCount?: number;
        readonly stringsSlimmed?: number;
      };
      const parts: string[] = [];
      if (rb.truncated === true) {
        parts.push(`${rb.droppedCount ?? 'an unknown number of'} row(s) dropped`);
      }
      if ((rb.stringsSlimmed ?? 0) > 0) {
        parts.push(`${rb.stringsSlimmed} long string(s) trimmed`);
      }
      if (parts.length > 0) {
        pushCapped(
          out.caveats,
          `Tool input was REDUCED to fit the response byte budget (${parts.join(
            ', ',
          )}) — a row absent from this synthesis may still exist in the org; re-query with limit/offset or a narrower scope for complete data.`,
          MAX_CAVEATS,
        );
      }
      return;
    }
    for (const [k, v] of Object.entries(value)) collect(v, k, out);
  }
};

const parseCitation = (id: string): Citation => {
  const colon = id.indexOf(':');
  return {
    id: id as ComponentId,
    type: id.slice(0, colon),
    apiName: id.slice(colon + 1),
  };
};

/**
 * The `sfi.synthesize_answer` MCP tool. Grounds a narrative in the supplied
 * tool JSON — see the module JSDoc for the no-hallucination contract.
 *
 * @example
 *   const r = await synthesizeAnswerHandler(ctx, { input: priorToolJson });
 *   if (r.ok) cite(r.value.data.citations);
 */
/** One flagged lifecycle claim the draft makes without a backing annotation. */
export interface UngroundedAnnotationClaim {
  readonly id: string;
  readonly claim: string;
  readonly note: string;
}

/**
 * Collect annotation entries from the source output: any object carrying the
 * `{componentId, key, value}` annotation shape (the consumer-embedded
 * `annotations` blocks and `sfi.annotations` payloads both match). Returns
 * componentId → lowercase "key:value" pairs.
 */
const collectAnnotationEntries = (value: unknown): Map<string, Set<string>> => {
  const found = new Map<string, Set<string>>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (
      typeof o['componentId'] === 'string' &&
      typeof o['key'] === 'string' &&
      typeof o['value'] === 'string'
    ) {
      const set = found.get(o['componentId']) ?? new Set<string>();
      set.add(`${o['key'].toLowerCase()}:${o['value'].toLowerCase()}`);
      found.set(o['componentId'], set);
    }
    Object.values(o).forEach(walk);
  };
  walk(value);
  return found;
};

/**
 * Flag "X is deprecated"-class draft claims with no backing annotation. A
 * claim is grounded when the source carries an annotation entry for that id
 * whose value mentions deprecation (any key — `status: deprecated` is the
 * canonical form).
 */
const findUngroundedDeprecationClaims = (
  draft: string,
  annotationEntries: ReadonlyMap<string, ReadonlySet<string>>,
): UngroundedAnnotationClaim[] => {
  const claims: UngroundedAnnotationClaim[] = [];
  // Sentence split on terminators followed by whitespace/end — a bare '.'
  // also lives INSIDE canonical ids (CustomField:Contact.Fax__c), so a naive
  // split would sever the id from its claim.
  for (const sentence of draft.split(/(?:[!?\n]|\.(?=\s|$))+/)) {
    if (!/\bdeprecat/i.test(sentence)) continue;
    for (const id of new Set(sentence.match(CANONICAL_ID_INLINE) ?? [])) {
      const entries = annotationEntries.get(id);
      const grounded =
        entries !== undefined &&
        [...entries].some((pair) => pair.includes('deprecat'));
      if (!grounded) {
        claims.push({
          id,
          claim: 'deprecated',
          note:
            'The draft asserts deprecation but the source carries NO matching annotation — lifecycle status is curated knowledge (provenance `annotation`), never inferred. Drop the claim or record it via sfi.propose_annotation for a human to confirm.',
        });
      }
    }
  }
  return claims.sort((a, b) => (a.id < b.id ? -1 : 1));
};

export const synthesizeAnswerHandler = async (
  ctx: Context,
  input: SynthesizeAnswerInput,
): Promise<Result<McpResponse<SynthesizeAnswerOutput>, McpError>> => {
  const out: Collected = {
    ids: new Set<string>(),
    caveats: [],
    bullets: [],
    provenances: new Set<string>(),
    causeHints: [],
    fixHints: [],
    nextHints: [],
  };
  // A host may hand the prior tool's output as a JSON STRING rather than a
  // parsed object (e.g. copying the tool's text result, or a transport that
  // serializes the `unknown` arg). Parse it first so the grounding/provenance
  // walk sees the real structure — otherwise the whole blob is one opaque
  // string, every id reads as ungrounded, and provenance is lost.
  let source: unknown = input.input;
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        source = JSON.parse(trimmed);
      } catch {
        /* not JSON — keep the raw string (collect treats it as text) */
      }
    }
  }
  collect(source, null, out);

  const citations = [...out.ids].sort().map(parseCitation);

  // Roll the source output's trust provenance up for the host to stamp.
  const provSources = [...out.provenances].sort();
  const provenanceStamp: string | null =
    provSources.length === 0
      ? null
      : provSources.length === 1
        ? (provSources[0] ?? null)
        : provSources.includes('hybrid') ||
            (provSources.includes('offline_snapshot') &&
              provSources.includes('live_org'))
          ? 'hybrid'
          : 'mixed';

  let hallucinatedIds: string[] | undefined;
  let groundedIds: string[] | undefined;
  let ungroundedAnnotationClaims: UngroundedAnnotationClaim[] | undefined;
  if (input.draft !== undefined) {
    const draftIds = [...new Set(input.draft.match(CANONICAL_ID_INLINE) ?? [])];
    groundedIds = draftIds.filter((id) => out.ids.has(id)).sort();
    hallucinatedIds = draftIds.filter((id) => !out.ids.has(id)).sort();

    // P13-ANNOT-tools LAUNDERING CHECK: lifecycle claims like "X is
    // deprecated" are CURATED knowledge — they ground ONLY in an actual
    // annotation entry in the source, never in vibes. A draft asserting
    // deprecation for an id whose source carries no matching annotation is
    // flagged, exactly like a hallucinated id.
    const annotationEntries = collectAnnotationEntries(source);
    ungroundedAnnotationClaims = findUngroundedDeprecationClaims(
      input.draft,
      annotationEntries,
    );
  }

  const qPrefix =
    input.question !== undefined && input.question.trim().length > 0
      ? `Q: ${input.question.trim()} — `
      : '';
  const summary =
    `${qPrefix}Grounded in the supplied tool output: ` +
    `${citations.length} component(s) cited, ${out.bullets.length} key fact(s), ` +
    `${out.caveats.length} caveat(s)` +
    (hallucinatedIds !== undefined
      ? `, ${hallucinatedIds.length} ungrounded id(s) in the draft`
      : '') +
    '.';

  // Grounded evidence skeleton (P12-UX-synth-next-action). Each field is the
  // first matching value lifted from the source; nextAction falls back to the
  // recommended fix (also from the source) — nothing is invented.
  const firstOrNull = (arr: readonly string[]): string | null => (arr.length > 0 ? (arr[0] ?? null) : null);
  const likelyCause = firstOrNull(out.causeHints);
  const recommendedFix = firstOrNull(out.fixHints);
  const nextAction = firstOrNull(out.nextHints) ?? recommendedFix;
  const risk = firstOrNull(out.caveats);
  // An id mentioned INSIDE a cause/fix/next string but not independently cited
  // (the whole-id grounding) is an ungrounded reference — flag it.
  const idsInText = (text: string | null): string[] =>
    text === null ? [] : [...new Set(text.match(CANONICAL_ID_INLINE) ?? [])].filter((id) => !out.ids.has(id));
  const orphanComponentIds = [
    ...new Set([...idsInText(likelyCause), ...idsInText(recommendedFix), ...idsInText(nextAction)]),
  ].sort();
  const evidence: EvidenceTemplate = {
    finding: out.bullets[0] ?? null,
    evidence: citations.slice(0, 5).map((c) => c.id),
    likelyCause,
    recommendedFix,
    risk,
    nextAction,
    orphanComponentIds,
  };

  return ok({
    data: {
      summary,
      bullets: out.bullets,
      citations,
      caveats: out.caveats,
      evidence,
      ...(input.draft !== undefined
        ? { hallucinatedIds: hallucinatedIds ?? [], groundedIds: groundedIds ?? [] }
        : {}),
      ...(ungroundedAnnotationClaims !== undefined &&
      ungroundedAnnotationClaims.length > 0
        ? { ungroundedAnnotationClaims }
        : {}),
      provenance: { stamp: provenanceStamp, sources: provSources },
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
