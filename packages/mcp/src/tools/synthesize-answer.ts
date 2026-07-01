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

/**
 * Keys whose scalar values are headline facts worth a bullet.
 *
 * Beyond the original count/verdict/status core, this also lifts the
 * flow/sharing/VR/false-premise fields the analytical tools emit so a CORRECT
 * cascade is no longer flattened to an empty skeleton (SYNTH bundle):
 *   - VR / formula evaluation: `errorConditionFormula`, `active`,
 *     `evaluatesAllActiveRules`, `evaluatesOn`.
 *   - component shape (false-premise rebuttals): `apexCallCount`,
 *     `fieldAccessCount`, `isExposed`.
 *   - flow trigger gates: `triggerType`, `processType`, `recordTriggerType`,
 *     `filterFormula`, `conditions`.
 *   - sharing semantics: `sharingSemantics`, `effectiveModel`, `runInMode`,
 *     `declaredSharing`.
 *   - transaction / save semantics: `rollsBackTransaction`, `statement`.
 *   - explicit false-premise signals: `premiseRejected`, `falsePremise`.
 *   - pagination / list completeness: `hasMore`.
 *   - matching rule dimensions: `booleanFilter`, `matchingMethods`.
 */
const FACT_KEY =
  /^(count|total|totalCount|totalClassCount|totalFindingCount|totalGapsCount|verdict|disposition|status|coverageStatus|riskLevel|truncated|notModeled|plane|intent|confidence|matchKind|fieldLabel|fieldId|piiClassification|piiCategory|errorConditionFormula|active|evaluatesAllActiveRules|evaluatesOn|apexCallCount|fieldAccessCount|isExposed|triggerType|processType|recordTriggerType|filterFormula|conditions|sharingSemantics|effectiveModel|runInMode|declaredSharing|rollsBackTransaction|statement|premiseRejected|falsePremise|hasMore|booleanFilter|matchingMethods)$/;

/** Array keys worth a "N item(s)" count bullet. */
const COUNT_ARRAY_KEY =
  /^(grants|findings|gaps|components|candidates|edges|nodes|reasoning|viaApexAccess|fields|matches|classes|tools|conditions|callers|usages|referrers)$/;

/** Key whose string value is a source tool's trust provenance. */
const PROVENANCE_KEY = /^provenance$/i;

/**
 * I3c (structural honesty — grounding guard). The CLAIM-CLASS table: each entry
 * matches an ASSERTION a draft can make that must be GROUNDED in the source and
 * is otherwise a laundering risk (an LLM stating a fact the source never
 * carried). Two families:
 *
 *   1. ABSENCE — "no X references this", "unused", "safe to delete", "nothing",
 *      "none". An absence assertion is only as strong as the coverage behind it:
 *      if the source carries ANY incomplete-coverage signal (a `coverageCaveat`,
 *      `notModeled`, `retrievalHint`, `dataNotAvailable`, or a partial/unknown
 *      `trust.completeness`), then "no X" is "not checked", NOT proven "none" —
 *      the claim is UNGROUNDED. This is the class the id-verbatim / annotation
 *      checks structurally cannot catch: an absence claim carries NO id to test.
 *
 *   2. LIFECYCLE — "deprecated", "legacy", "replaced by", "do not use", "owned
 *      by". Curated knowledge that grounds ONLY in an annotation entry (see
 *      `findUngroundedDeprecationClaims`); generalized here so the table is the
 *      single home for every laundering class, though the deprecation detector
 *      still owns the annotation cross-check.
 *
 * `id: 'absence'` claims are the ones I3c newly detects; the lifecycle entry is
 * kept for documentation parity with the annotation-laundering pass.
 */
interface ClaimClass {
  readonly id: 'absence' | 'lifecycle';
  readonly pattern: RegExp;
}
const CLAIM_CLASS_TABLE: readonly ClaimClass[] = [
  // ABSENCE class — an assertion of NON-existence / no-references / no-impact /
  // safe-to-delete. Tuned to real host phrasings ("no flows reference this",
  // "it is unused", "nothing depends on it", "safe to delete", "zero
  // dependencies", "not referenced anywhere"). Each alternative is anchored on
  // a word boundary so it does not fire inside a larger token.
  {
    id: 'absence',
    pattern:
      /\bno\b[^.!?\n]*\b(reference|references|referenced|use|uses|used|usage|depend|depends|dependent|dependents|dependenc|impact|impacts|flow|flows|apex|trigger|triggers|field|fields|caller|callers)\b/i,
  },
  { id: 'absence', pattern: /\bnone\b/i },
  { id: 'absence', pattern: /\bnot\s+(referenced|used|modeled|impacted|found)\b/i },
  { id: 'absence', pattern: /\bunused\b/i },
  { id: 'absence', pattern: /\bnothing\b/i },
  { id: 'absence', pattern: /\bzero\b/i },
  { id: 'absence', pattern: /\bsafe\s+to\s+delete\b/i },
  { id: 'absence', pattern: /\bno\s+(impact|dependencies|dependents|references|callers|usages)\b/i },
  // LIFECYCLE class — kept for parity; the annotation-laundering pass owns the
  // per-id cross-check (this table entry documents the class, it is not scanned
  // in the absence loop).
  { id: 'lifecycle', pattern: /\b(deprecat|legacy|replaced\s+by|do\s+not\s+use|owner)\b/i },
];

/** The absence-class patterns only, for the absence-claim scan. */
const ABSENCE_PATTERNS: readonly RegExp[] = CLAIM_CLASS_TABLE.filter(
  (c) => c.id === 'absence',
).map((c) => c.pattern);

/**
 * Keys whose presence in the source signals INCOMPLETE coverage for the family
 * an absence claim would rest on. When any of these is present-and-truthy, "no
 * X references this" is "not checked", not proven "none".
 *   - `coverageCaveat` — the I3b / what-if structural-honesty caveat object.
 *   - `retrievalHint` — list_components / FRESH-02 "this may be partial" hint.
 *   - `notModeled` / `notModeledNote` — the family's definition was not retrieved.
 *   - `dataNotAvailable` — field_360 / field_lineage explicit not-available list.
 */
const INCOMPLETE_COVERAGE_KEY =
  /^(coverageCaveat|retrievalHint|notModeled|notModeledNote|dataNotAvailable)$/;

/**
 * Free-text phrases a caveat/message carries when coverage is incomplete. The
 * `coverageCaveat.message` and the empty-traversal caveat both say "not
 * checked" / "incomplete coverage" / "not retrieved" / "not modeled"; matching
 * these lets a plain caveat STRING (not just the structured object) count as an
 * incompleteness signal.
 */
const INCOMPLETE_COVERAGE_PHRASE =
  /\b(not checked|incomplete coverage|not (?:been )?retrieved|not modeled|were not (?:checked|retrieved|modeled)|among the families the vault (?:actually )?(?:covers|retrieved))\b/i;

/**
 * Keys carrying a resolve-style disposition. When the value is `'none'` the
 * named component does not exist in the vault — the question's premise is false.
 */
const DISPOSITION_KEY = /^(disposition|matchKind|resolveDisposition)$/i;

/**
 * Keys whose truthy value is an explicit false-premise signal. Both the boolean
 * form (`premiseRejected: true` / `falsePremise: true`) and the string form
 * (`falsePremise: 'true'` / `'rejected'`) flag a counterfactual question.
 */
const FALSE_PREMISE_KEY = /^(falsePremise|premiseRejected)$/i;

/** The single user-readable caveat composed for a false-premise cascade. */
const FALSE_PREMISE_CAVEAT =
  'FALSE PREMISE: the named component does not exist in the vault (resolve ' +
  'disposition `none` / no source match) — the question assumes something that ' +
  'is not there. Do not present its absence as a normal answer; say plainly ' +
  'that the component was not found and (if the cascade carried a redirect ' +
  'hint) point to the real component instead.';

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
 *     A `draft` supplied with an empty or missing `input` FAILS CLOSED —
 *     `grounded: false` plus a caveat — never a rubber-stamped `grounded: true`,
 *     because there is nothing to check the draft against.
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
   * I3c (structural honesty — grounding guard). `false` when the draft asserts
   * ABSENCE ("no X references this", "unused", "safe to delete") while the
   * source carries an incomplete-coverage signal — absence read as fact over
   * partial coverage. `true` otherwise. Advisory (a signal, not a hard block),
   * but ALWAYS computed when a `draft` is present.
   */
  readonly grounded?: boolean;
  /**
   * I3c: the absence assertions in the draft that are UNGROUNDED because the
   * source's coverage is incomplete. Empty (and `grounded` stays `true`) when
   * the draft makes no absence claim or coverage is complete.
   */
  readonly ungroundedAbsenceClaims?: readonly string[];
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
  /**
   * I3c: set true when the source carries ANY incomplete-coverage signal (a
   * `coverageCaveat`/`retrievalHint`/`notModeled`/`dataNotAvailable` key, a
   * partial/unknown `trust.completeness`, or a caveat string that reads "not
   * checked"). An absence claim over such a source is UNGROUNDED.
   */
  coverageIncomplete: boolean;
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
    // I3c incompleteness signal — a non-empty `retrievalHint`/`notModeledNote`
    // string, OR a caveat/message string that reads "not checked" / "incomplete
    // coverage" / "not modeled" (the coverageCaveat message phrasing).
    if (
      key !== null &&
      value.trim().length > 0 &&
      (INCOMPLETE_COVERAGE_KEY.test(key) || INCOMPLETE_COVERAGE_PHRASE.test(value))
    ) {
      out.coverageIncomplete = true;
    }
    if (key !== null && CAVEAT_KEY.test(key) && value.trim().length > 0) {
      pushCapped(out.caveats, value, MAX_CAVEATS);
    } else if (key !== null && FACT_KEY.test(key)) {
      pushCapped(out.bullets, `${key}: ${value}`, MAX_BULLETS);
      // FALSE-PREMISE PATH (SYNTH bundle): a `disposition`/`falsePremise`
      // signal of "none"/no-match means the named component does not exist in
      // the vault — the question's premise is false. Surface that as an
      // explicit user-readable caveat instead of letting an empty skeleton
      // imply the absence is a real answer.
      if (
        (DISPOSITION_KEY.test(key) && /^none$/i.test(value.trim())) ||
        (FALSE_PREMISE_KEY.test(key) && /^(true|false-premise|rejected)$/i.test(value.trim()))
      ) {
        pushCapped(out.caveats, FALSE_PREMISE_CAVEAT, MAX_CAVEATS);
      }
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
    // I3c: `notModeled: true` is an incompleteness signal (the family's
    // definition was not retrieved), regardless of whether the key is a FACT.
    if (value === true && key !== null && INCOMPLETE_COVERAGE_KEY.test(key)) {
      out.coverageIncomplete = true;
    }
    if (key !== null && FACT_KEY.test(key)) {
      pushCapped(out.bullets, `${key}: ${String(value)}`, MAX_BULLETS);
      // Boolean false-premise signal (`premiseRejected: true` /
      // `falsePremise: true`) — same explicit caveat as the string form.
      if (value === true && FALSE_PREMISE_KEY.test(key)) {
        pushCapped(out.caveats, FALSE_PREMISE_CAVEAT, MAX_CAVEATS);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    // I3c: a NON-EMPTY `dataNotAvailable` array (field_360 / field_lineage)
    // names families the tool could not answer for — an incompleteness signal.
    if (key !== null && INCOMPLETE_COVERAGE_KEY.test(key) && value.length > 0) {
      out.coverageIncomplete = true;
    }
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
    // I3c incompleteness signals at object nodes:
    //   - a `coverageCaveat` OBJECT present at all (I3b / what-if): its very
    //     presence means a dependency family is partial/unknown.
    //   - a `completeness` block (TrustSummary.completeness) whose `status` is
    //     `partial` or `unknown` — "not fully covered".
    if (key !== null && INCOMPLETE_COVERAGE_KEY.test(key)) {
      out.coverageIncomplete = true;
    }
    if (key === 'completeness') {
      const status = (value as { readonly status?: unknown }).status;
      if (status === 'partial' || status === 'unknown') {
        out.coverageIncomplete = true;
      }
    }
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
 * Walk the source value tree to detect structural patterns that warrant
 * additional caveats. These run AFTER `collect` so they complement (never
 * duplicate) the scalar caveat/bullet pass. Each detector is independent.
 *
 * Detectors:
 *   1. PAGINATION — `hasMore: true` in the input means the list_components
 *      (or any paginated tool) returned only the first page; conclusions drawn
 *      from that partial set may be wrong for the full family.
 *   2. COUNT-CONSISTENCY — when a top-level object has both a stated total
 *      count scalar (`count`/`total`/`totalCount`) and a `components` array
 *      whose length differs from the stated total, the mismatch is a signal
 *      of an off-by-one or synthesis error in the prior tool call.
 *   3. INACTIVE-APPROVALPROCESS — when the input cites at least one
 *      `ApprovalProcess:` id AND carries `active: false`, emit a caveat that
 *      the sibling active processes on the same object were not retrieved and
 *      may provide required routing context.
 *   4. BOOLEANFILTER-MATCHINGMETHODS — when both `booleanFilter` and
 *      `matchingMethods` appear in the same object, emit a structural note
 *      distinguishing trigger-breadth (booleanFilter) from per-field fuzziness
 *      (matchingMethod values); conflating the two is the canonical error.
 */
const applyStructuralCaveats = (value: unknown, out: Collected): void => {
  // Walk every object node, applying pattern detectors.
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;

    // DETECTOR 1 — PAGINATION: `hasMore: true` means the list was not exhaustive.
    if (o['hasMore'] === true) {
      pushCapped(
        out.caveats,
        'INCOMPLETE RETRIEVAL: the source tool returned hasMore=true — this response ' +
          'covers only the first page of results. Conclusions about which values, members, ' +
          'or rules are present (or absent) in the full family may be wrong. Paginate with ' +
          'offset/nextCursor or narrow the query before drawing family-wide conclusions.',
        MAX_CAVEATS,
      );
    }

    // DETECTOR 2 — COUNT-CONSISTENCY: stated total vs enumerated components.
    // Only applies at object nodes that carry BOTH a count-like scalar AND
    // a `components` array — the canonical list_components response shape.
    if (Array.isArray(o['components'])) {
      const actualLen = (o['components'] as unknown[]).length;
      for (const countKey of ['count', 'total', 'totalCount'] as const) {
        const stated = o[countKey];
        if (typeof stated === 'number' && stated !== actualLen) {
          pushCapped(
            out.caveats,
            `COUNT MISMATCH: the input states ${countKey}=${stated} but the enumerated ` +
              `'components' array contains ${actualLen} item(s). The stated total may be ` +
              `a synthesis or off-by-one error — use the enumerated count (${actualLen}) ` +
              `as the authoritative figure; do not repeat the stated total uncritically.`,
            MAX_CAVEATS,
          );
          break; // one mismatch caveat per object node is enough
        }
      }
    }

    // DETECTOR 3 — INACTIVE-APPROVALPROCESS: inactive process without sibling retrieval.
    // Only fires when an ApprovalProcess canonical id is present in the collected
    // id set AND the current object node carries `active: false` — a strong signal
    // that the cascade fetched only the inactive member of the version family.
    if (o['active'] === false) {
      const hasApprovalId = [...out.ids].some((id) => id.startsWith('ApprovalProcess:'));
      if (hasApprovalId) {
        pushCapped(
          out.caveats,
          'INACTIVE APPROVAL PROCESS: the cited ApprovalProcess has active=false. ' +
            'The sibling active processes on the same object were NOT retrieved by this ' +
            'cascade — they may provide the current routing logic, successor entry criteria, ' +
            'and active step assignments. Call list_components on the same parent object ' +
            'to retrieve the full version family before drawing conclusions about active routing.',
          MAX_CAVEATS,
        );
      }
    }

    // DETECTOR 4 — BOOLEANFILTER-MATCHINGMETHODS independence.
    // When both properties are present in the same component properties node,
    // emit a structural interpretation note so the host distinguishes trigger
    // breadth (booleanFilter) from per-field fuzziness (matchingMethod values).
    const bf = o['booleanFilter'];
    const mm = o['matchingMethods'];
    if (typeof bf === 'string' && bf.length > 0 && typeof mm === 'string' && mm.length > 0) {
      pushCapped(
        out.caveats,
        'MATCHING RULE — two independent dimensions: ' +
          `(1) booleanFilter="${bf}" controls which field-combination sets are sufficient ` +
          'to declare a duplicate (trigger breadth / recall — OR groups widen recall, AND ' +
          'groups narrow it); ' +
          `(2) matchingMethods="${mm}" controls how fuzzily each individual field comparison ` +
          'works (precision — FirstName/LastName are fuzzy; Exact is not). ' +
          'Do not attribute per-field fuzziness to the OR structure in booleanFilter; ' +
          'fuzziness comes from matchingMethod values only.',
        MAX_CAVEATS,
      );
    }

    // Recurse into sub-objects AFTER applying node-level detectors.
    Object.values(o).forEach(walk);
  };
  walk(value);
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

/**
 * I3c (structural honesty — grounding guard). Scan a draft for ABSENCE
 * assertions ("no flows reference this", "it is unused", "safe to delete") and
 * return the sentences that assert absence. This runs on EVERY draft; the
 * caller cross-references `coverageIncomplete` to decide whether each such
 * claim is grounded (absence over COMPLETE coverage is fine; absence over
 * PARTIAL coverage is the laundering the guard exists to catch).
 *
 * Splits on sentence terminators — but NOT on a bare `.` (which lives inside
 * canonical ids and decimals), matching the annotation-laundering splitter — so
 * each returned string is one self-contained claim the host can locate and fix.
 * Returns each matching sentence once (deduped, trimmed), capped, sorted for a
 * stable contract.
 */
const findAbsenceClaims = (draft: string): string[] => {
  const found = new Set<string>();
  for (const raw of draft.split(/(?:[!?\n]|\.(?=\s|$))+/)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    if (ABSENCE_PATTERNS.some((p) => p.test(sentence))) found.add(sentence);
  }
  return [...found].sort().slice(0, MAX_CAVEATS);
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
    coverageIncomplete: false,
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
  // Apply structural pattern detectors AFTER the scalar collect pass so that
  // (a) the `out.ids` set is already populated (the inactive-ApprovalProcess
  // detector needs to see cited ids), and (b) no structural caveat is double-
  // emitted by the scalar walk.
  applyStructuralCaveats(source, out);

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
  let grounded: boolean | undefined;
  let ungroundedAbsenceClaims: string[] | undefined;
  // A draft can only be GROUNDED against real evidence. When the host supplies
  // none — a missing `input`, or an empty object / array / string — there is
  // nothing to check the draft against. This is the same "empty ≠ none" rule the
  // tool enforces for the host, applied to its own input: absence of evidence is
  // not evidence of grounding, so we must fail closed rather than rubber-stamp.
  const evidenceEmpty =
    source === undefined ||
    source === null ||
    (typeof source === 'string' && source.trim().length === 0) ||
    (Array.isArray(source) && source.length === 0) ||
    (typeof source === 'object' &&
      !Array.isArray(source) &&
      Object.keys(source as Record<string, unknown>).length === 0);
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

    // I3c ABSENCE-AS-FACT GUARD. Scan the draft for absence assertions. An
    // absence claim is UNGROUNDED only when the source's coverage is incomplete
    // (`out.coverageIncomplete`) — "no X references this" over PARTIAL coverage
    // is "not checked", not proven "none". Over COMPLETE coverage the same
    // claim is grounded, so `grounded` stays true and the list is empty. Always
    // computed when a draft is present (structural, not opt-in).
    const absenceClaims = findAbsenceClaims(input.draft);
    ungroundedAbsenceClaims =
      out.coverageIncomplete ? absenceClaims : [];
    grounded = ungroundedAbsenceClaims.length === 0;

    // FAIL-CLOSED: a draft handed in with no evidence to ground against must
    // never come back grounded:true — that silently rubber-stamps whatever the
    // host wrote (e.g. a "safe to delete, nothing references it" claim the vault
    // never supported). Certify only when there was something to certify against.
    if (evidenceEmpty) {
      grounded = false;
      out.caveats.unshift(
        'GROUNDING NOT VERIFIED: no evidence was supplied in `input`, so the ' +
          'draft was not checked against any tool output. Do NOT present it as ' +
          'grounded — pass the prior sfi.* tool result(s) as `input` and retry.',
      );
    }
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
    // I3c: only appended when a draft is present AND the guard fired, so the
    // no-draft golden summary stays byte-identical.
    (ungroundedAbsenceClaims !== undefined && ungroundedAbsenceClaims.length > 0
      ? `, ${ungroundedAbsenceClaims.length} absence claim(s) asserted over incomplete coverage (grounded=false)`
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
        ? {
            hallucinatedIds: hallucinatedIds ?? [],
            groundedIds: groundedIds ?? [],
            // I3c: structural — always present alongside the id-grounding when a
            // draft is passed. `grounded` false + the listed claims signal an
            // absence asserted over incomplete coverage. Keeps the no-draft
            // golden byte-identical (both fields gate on the draft, like the
            // id-grounding fields above).
            grounded: grounded ?? true,
            ungroundedAbsenceClaims: ungroundedAbsenceClaims ?? [],
          }
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
