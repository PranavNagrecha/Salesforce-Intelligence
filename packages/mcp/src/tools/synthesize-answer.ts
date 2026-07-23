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
  ConfidenceLevel,
  Interpretation,
  McpError,
  McpResponse,
  Remediation,
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

/**
 * RM-3 absence-honesty guardrail. Composed when the source carried an interpret
 * PAYLOAD whose interpretations array was EMPTY — the reasoning engine ran and
 * NO concept rule fired. This is silence, not a finding: it must NEVER be
 * laundered into "nothing depends on this" / "safe to change / delete". The
 * caveat states the honest framing so the empty array cannot read as a verdict.
 */
const EMPTY_INTERPRETATION_CAVEAT =
  'REASONING: the interpret engine ran but NO concept rule fired for this ' +
  'component. This is NOT a finding that nothing depends on it or that a ' +
  'change/delete is safe — it means no curated reasoning concept matched the ' +
  'grounded structure. Draw no absence conclusion from the empty result.';

/**
 * FIX-F3 shape-drift disclosure. Composed when the source carried an interpret
 * PAYLOAD whose `interpretations` array was NON-EMPTY but whose elements did NOT
 * match the typed `Interpretation` shape (cross-package/version drift — a
 * renamed or missing key, a non-array `groundedIn`, etc.). The collector lifts
 * zero valid claims from it, so WITHOUT this caveat the reasoning result would
 * resolve silently to nothing. Disclosed — never swallowed — and explicitly NOT
 * the "no concept rule fired" framing (a rule DID produce output; we just could
 * not parse it).
 */
const SHAPE_DRIFT_INTERPRETATION_CAVEAT =
  'REASONING: a reasoning (interpret) result was present in the input but could ' +
  'NOT be parsed — its interpretation entries did not match the expected shape ' +
  '(a cross-version/shape drift). No reasoning claim was surfaced from it; this ' +
  'is NOT the same as "no concept rule fired", and no absence conclusion follows.';

/**
 * CITED-REMEDIATION absence disclosure. Composed when the source carried fired
 * reasoning claim(s) but NONE carried an authored remediation AND no scraped fix
 * filled the slot. The FIX slot stays empty by design (the engine never
 * fabricates a fix); this states WHY, so a host never invents one to paper over
 * the gap. Only for a real interpret payload with ≥1 fired claim — byte-identical
 * for interpretation-free inputs.
 */
const NO_REMEDIATION_CAVEAT =
  'REMEDIATION: no cited remediation was authored for the fired reasoning ' +
  'claim(s) yet, so none is surfaced here. Do NOT invent a fix — if one is ' +
  'needed, author it on the concept rule so it ships cited and confidence-tiered.';

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
  /**
   * RM-3 (step 3a): typed reasoning claims from `sfi.interpret` when the source
   * carried them. The shape-gated collector + non-clobbering fold POPULATE this.
   * An EMPTY array means "no concept rule fired" — NEVER a claim that nothing
   * depends on the component. Per-item `confidence`/`coverageCaveat` are kept
   * intact here so the flat template fields can never out-claim the reasoning.
   */
  readonly interpretations: readonly Interpretation[];
  /**
   * FIX-F1/F2: interpretation claim(s) surfaced as grounded, HEDGED supplementary
   * notes — populated ONLY when an on-topic SCRAPED cause already holds
   * `likelyCause`, so the reasoning is surfaced without clobbering the scraped
   * evidence. Each note carries its own inline hedge (a `heuristic`/`unknown`
   * confidence marker and/or the `coverageCaveat`) so it never reads as a bare
   * hard fact. Empty when the claim already IS `likelyCause` (no double-surface)
   * or when the source carried no interpretation — byte-identical to today.
   */
  readonly interpretationNotes: readonly string[];
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
 * RM-3 (step 3b) — the SHAPE gate for a typed `sfi.interpret` claim. An element
 * qualifies only when it carries the FULL Interpretation key-set — `ruleId` +
 * `concept` + `claim` + `groundedIn` + `provenance` — so the collector cannot
 * misfire on an unrelated `interpretations`/`items` array whose elements happen
 * to share one or two of these key names. A bare `claim` key (too generic) is
 * deliberately NOT sufficient on its own.
 */
const isInterpretationShaped = (v: unknown): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['ruleId'] === 'string' &&
    typeof o['concept'] === 'string' &&
    typeof o['claim'] === 'string' &&
    Array.isArray(o['groundedIn']) &&
    typeof o['provenance'] === 'string'
  );
};

/**
 * FIX-F6: the confidence tiers a lifted interpretation may carry. This MUST stay
 * in lockstep with the contracts source of truth — `ConfidenceLevel` (`declared`
 * | `parsed` | `heuristic`) plus the `Interpretation.confidence` `| 'unknown'`
 * widening. The `satisfies` clause fails the build if any listed value stops
 * being a valid tier; if a NEW tier is added to `ConfidenceLevel`, add it here
 * too (an unknown value falls back to `'unknown'`, never an over-claim).
 */
const INTERPRETATION_CONFIDENCE_TIERS = [
  'declared',
  'parsed',
  'heuristic',
  'unknown',
] as const satisfies readonly (ConfidenceLevel | 'unknown')[];

/**
 * CITED-REMEDIATION — normalize an untrusted `remediation` value into a typed
 * {@link Remediation}, or `undefined` when the source carried none / a malformed
 * one. Defensive: `steps` are filtered to non-empty strings (an empty result ⇒
 * `undefined`, never a fabricated fix), `confidence` falls back to `'unknown'`
 * outside the known tiers, `groundedIn` to string ids. Nothing is invented.
 */
const toRemediation = (v: unknown): Remediation | undefined => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const steps = Array.isArray(o['steps'])
    ? o['steps'].filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  if (steps.length === 0) return undefined;
  const confidence = o['confidence'];
  const groundedIn = Array.isArray(o['groundedIn'])
    ? o['groundedIn'].filter((x): x is string => typeof x === 'string')
    : [];
  return {
    steps,
    confidence: (INTERPRETATION_CONFIDENCE_TIERS as readonly string[]).includes(
      confidence as string,
    )
      ? (confidence as ConfidenceLevel | 'unknown')
      : 'unknown',
    groundedIn: groundedIn as ComponentId[],
    ...(typeof o['whatIfTool'] === 'string' && o['whatIfTool'].trim().length > 0
      ? { whatIfTool: o['whatIfTool'] }
      : {}),
  };
};

/**
 * Normalize a shape-matched object into a typed `Interpretation`. The source is
 * untrusted JSON (a host may reshape the interpret payload), so every field is
 * defensively narrowed: `groundedIn` is filtered to string ids, `confidence`
 * falls back to `'unknown'` when it is not one of the known tiers, and
 * `coverageCaveat`/`modelVersion` default to `null`/`''`. Nothing is invented —
 * only the values the source literally carried are lifted.
 */
const toInterpretation = (o: Record<string, unknown>): Interpretation => {
  // FIX-F5: `groundedIn` arrives as an array of ids, but a reshaping host may
  // pack multiple ids into a single comma-joined element ("A,B"). Split each
  // element on commas so those reshaped citations still land. Byte-neutral for
  // normal single-id elements (a canonical id carries no comma).
  const groundedIn = Array.isArray(o['groundedIn'])
    ? o['groundedIn']
        .filter((x): x is string => typeof x === 'string')
        .flatMap((s) => s.split(',').map((part) => part.trim()))
        .filter((part) => part.length > 0)
    : [];
  const confidence = o['confidence'];
  return {
    ruleId: String(o['ruleId']),
    concept: String(o['concept']),
    claim: String(o['claim']),
    groundedIn: groundedIn as ComponentId[],
    confidence: (INTERPRETATION_CONFIDENCE_TIERS as readonly string[]).includes(
      confidence as string,
    )
      ? (confidence as ConfidenceLevel | 'unknown')
      : 'unknown',
    coverageCaveat:
      typeof o['coverageCaveat'] === 'string' ? o['coverageCaveat'] : null,
    modelVersion: typeof o['modelVersion'] === 'string' ? o['modelVersion'] : '',
    provenance: 'offline_snapshot',
    // CITED-REMEDIATION — lift the authored fix when the source carried one.
    // Absent ⇒ the field is omitted (byte-identical to the pre-remediation lift).
    ...((): { remediation?: Remediation } => {
      const remediation = toRemediation(o['remediation']);
      return remediation !== undefined ? { remediation } : {};
    })(),
  };
};

/** What the shape-gated interpret collector returns. */
interface CollectedInterpretations {
  /** Every typed interpretation lifted from the source (deduped). */
  readonly list: readonly Interpretation[];
  /**
   * RM-3 absence-honesty guardrail: `true` when the source carried an interpret
   * PAYLOAD (an `interpretations` array beside the engine's `rulesFired`/
   * `rulesConsidered` counters) whose interpretations array was EMPTY — the
   * engine ran and fired nothing. An empty result is "no concept rule fired",
   * NEVER "nothing depends on this".
   */
  readonly emptyPayloadSeen: boolean;
  /**
   * FIX-F3: `true` when an interpret PAYLOAD carried a NON-EMPTY `interpretations`
   * array whose elements ALL failed the shape gate (cross-package/version drift),
   * so the collector lifted zero valid claims from it. Distinct from
   * `emptyPayloadSeen` (the engine fired nothing): here a result WAS produced but
   * could not be parsed. Drives the shape-drift disclosure so the reasoning
   * result is never swallowed silently.
   */
  readonly shapeDriftSeen: boolean;
  /**
   * Payload-level `coverageCaveat` string(s) (InterpretOutput.coverageCaveat).
   * The anchored `CAVEAT_KEY` does not match `coverageCaveat`, so this key would
   * otherwise be dropped; captured here (scoped to the interpret payload shape,
   * never a generic `coverageCaveat` elsewhere) for the caller to surface.
   */
  readonly payloadCaveats: readonly string[];
}

/**
 * RM-3 (steps 3b/3d) — the shape-gated interpret collector. Walk `source` for
 * (a) arrays whose EVERY element is `isInterpretationShaped` (robust to host
 * re-shaping — the interpret payload nests them under `data.interpretations`,
 * but a host may lift them elsewhere) and (b) the interpret PAYLOAD object
 * itself, to detect a fired-nothing EMPTY result and capture its top-level
 * `coverageCaveat`. Deduped by (ruleId, concept, claim, groundedIn) so a
 * doubly-nested payload cannot double-count a claim.
 */
const collectInterpretations = (value: unknown): CollectedInterpretations => {
  const byKey = new Map<string, Interpretation>();
  const payloadCaveats: string[] = [];
  let emptyPayloadSeen = false;
  let shapeDriftSeen = false;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      // An array of interpretation-shaped elements IS the fold input. Vacuous
      // match on an empty array collects nothing (the empty-payload signal
      // below carries the fired-nothing case instead).
      if (v.length > 0 && v.every(isInterpretationShaped)) {
        for (const el of v) {
          const it = toInterpretation(el as Record<string, unknown>);
          const key = JSON.stringify([
            it.ruleId,
            it.concept,
            it.claim,
            it.groundedIn,
          ]);
          if (!byKey.has(key)) byKey.set(key, it);
        }
      }
      v.forEach(walk);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    // Interpret PAYLOAD (InterpretOutput) shape: an `interpretations` array
    // beside the engine's counters. FIX-F4: require BOTH `rulesFired` AND
    // `rulesConsidered` (every real InterpretOutput carries both) so a non-
    // interpret payload that coincidentally has `interpretations: []` beside a
    // single numeric counter does NOT trip the empty/drift disclosures — the
    // "interpretation-free inputs stay byte-identical" claim holds strictly.
    // Used ONLY to (a) flag an EMPTY fired-nothing result, (b) flag a NON-EMPTY-
    // but-unparseable (shape-drift) result, and (c) surface the payload's top-
    // level coverageCaveat — never to collect (the array branch does that).
    if (
      Array.isArray(o['interpretations']) &&
      typeof o['rulesFired'] === 'number' &&
      typeof o['rulesConsidered'] === 'number'
    ) {
      const arr = o['interpretations'] as readonly unknown[];
      if (arr.length === 0) {
        emptyPayloadSeen = true;
      } else if (!arr.some(isInterpretationShaped)) {
        // FIX-F3: a result WAS produced but no element matched the typed shape —
        // the collector lifts zero valid claims. Disclose it; never swallow.
        shapeDriftSeen = true;
      }
      const cav = o['coverageCaveat'];
      if (typeof cav === 'string' && cav.trim().length > 0) payloadCaveats.push(cav);
    }
    Object.values(o).forEach(walk);
  };
  walk(value);
  return {
    list: [...byKey.values()],
    emptyPayloadSeen,
    shapeDriftSeen,
    payloadCaveats,
  };
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

  // RM-3 (step 3b): shape-gated fold of typed Interpretation[] from the source.
  // The `groundedIn` ids are already in `out.ids` (they are canonical-id strings
  // the recursive `collect` pass captured), so they flow into `citations` below
  // with no extra work. Populating `evidence.interpretations` is byte-neutral
  // for interpretation-free inputs (the collector returns an empty list).
  const interp = collectInterpretations(source);

  // RM-3 (step 3d): surface the interpret coverageCaveat(s) as caveats. The
  // anchored CAVEAT_KEY does NOT match `coverageCaveat`, so both the per-
  // interpretation `coverageCaveat` and the payload-level one would otherwise be
  // dropped. Surface them ONLY through the shape-gated collector (scoped to the
  // interpret shape) rather than broadening CAVEAT_KEY generically — a generic
  // widening would pull `coverageCaveat` from unrelated payloads. Byte-neutral
  // for interpretation-free inputs (both lists are empty).
  for (const it of interp.list) {
    if (it.coverageCaveat !== null && it.coverageCaveat.trim().length > 0) {
      pushCapped(out.caveats, it.coverageCaveat, MAX_CAVEATS);
    }
  }
  for (const cav of interp.payloadCaveats) pushCapped(out.caveats, cav, MAX_CAVEATS);

  // RM-3 (step 3e / absence-honesty guardrail): an interpret payload that fired
  // NOTHING is disclosed as "no concept rule fired", so the empty result can
  // never be read as a "safe"/"no-dependency" verdict. Only when the collector
  // saw a real interpret payload AND lifted zero interpretations.
  if (interp.list.length === 0 && interp.emptyPayloadSeen) {
    pushCapped(out.caveats, EMPTY_INTERPRETATION_CAVEAT, MAX_CAVEATS);
  }
  // FIX-F3: a reasoning payload whose interpretations could NOT be parsed
  // (shape drift) is DISCLOSED, never swallowed — so the reasoning result never
  // resolves silently to nothing. Distinct from the fired-nothing caveat above.
  // Byte-neutral for interpretation-free inputs (`shapeDriftSeen` is false).
  if (interp.shapeDriftSeen) {
    pushCapped(out.caveats, SHAPE_DRIFT_INTERPRETATION_CAVEAT, MAX_CAVEATS);
  }
  // The interpret-EXPLICIT incompleteness signal for the I3c absence guard
  // below. Preferred over the heuristic coverage scan, but LAYERED as an
  // override that FALLS BACK to it (never replaces it): a `confidence: unknown`
  // or a non-null `coverageCaveat` is grounded-by-construction incomplete, and
  // a fired-nothing empty result cannot certify an absence claim either. Zero
  // for interpretation-free inputs, so the heuristic scan stands alone (the
  // dense I3c block stays byte-identical).
  const reasoningIncomplete =
    (interp.list.length === 0 && interp.emptyPayloadSeen) ||
    interp.list.some(
      (i) =>
        i.confidence === 'unknown' ||
        (i.coverageCaveat !== null && i.coverageCaveat.trim().length > 0),
    );

  // SYNTHESIZE-BURIES-INTERPRET-CLAIMS (Graph-B product honesty). The shipped
  // reasoning model fires correctly (e.g. `concept:flow-run-mode` →
  // `SystemModeWithoutSharing`), but the HOST answer path renders `summary` +
  // `bullets`, and the generic scalar `collect` walk lifts only the bare
  // `confidence: <tier>` / `status: <state>` COUNTERS from the interpret payload
  // (the FACT_KEY match on `confidence`/`status`) — never the interpretation's
  // CLAIM text (the `claim` key matches no FACT_KEY). The reasoning conclusion
  // therefore survives only inside `evidence.*` and never reaches a host that
  // shows summary/bullets. PROMOTE each fired claim into the host-facing bullets,
  // tagged with its concept, rule id, and confidence tier (with any
  // coverageCaveat inline), so the claim is surfaced — never replaced by a
  // counter alone. The disclosures added above (coverageCaveat/empty/shape-drift
  // caveats) are UNTOUCHED — this ADDS the claim, it does not drop a hedge.
  //
  // Compound-concept fold mirrors the `likelyCause` presentation below: a fired
  // `concept:system-context-external-surface` subsumes its two constituents, so
  // the bullet set is not padded with pieces the conjunction already states.
  // `firedConcepts`/`presentationInterpretations` are computed ONCE here and
  // reused for the `likelyCause`/note rendering later. Byte-neutral for
  // interpretation-free inputs: `interp.list` is empty ⇒
  // `presentationInterpretations` is empty ⇒ the loop pushes nothing ⇒ every
  // downstream count/field (including the summary) is byte-identical.
  const firedConcepts = new Set(interp.list.map((i) => i.concept));
  const presentationInterpretations = firedConcepts.has(
    'concept:system-context-external-surface',
  )
    ? interp.list.filter(
        (i) =>
          i.concept !== 'concept:external-api-surface' &&
          i.concept !== 'concept:apex-sharing-mode',
      )
    : interp.list;
  let promotedClaimCount = 0;
  for (const i of presentationInterpretations) {
    const claim = i.claim.trim();
    if (claim.length === 0) continue;
    const coverage =
      i.coverageCaveat !== null && i.coverageCaveat.trim().length > 0
        ? ` (coverage caveat: ${i.coverageCaveat.trim()})`
        : '';
    const before = out.bullets.length;
    pushCapped(
      out.bullets,
      `REASONING [${i.concept} · ${i.ruleId} · confidence: ${i.confidence}]: ${claim}${coverage}`,
      MAX_BULLETS,
    );
    if (out.bullets.length > before) promotedClaimCount += 1;
  }

  // CITED-REMEDIATION — fold each fired interpretation's AUTHORED remediation into
  // the FIX / NEXT slots (the previously-empty `evidence.recommendedFix` /
  // `nextAction`). Uses `presentationInterpretations` (compound-subsumed
  // constituents already filtered, in lockstep with the bullet/note rendering) so
  // a compound claim's fix is not doubled by its parts. Pushed AFTER the scalar
  // `collect` pass, so a scraped `recommendation`/`nextStep` still WINS the slot
  // (non-clobbering); a PURE interpret flow (empty fix/next hints) gets the
  // remediation. Each hint is ATTRIBUTED (concept · ruleId · confidence), HEDGED
  // (its confidence tier + any coverageCaveat inline), CITED (the grounded ids
  // ride on the claim into `citations`), and framed as fix STEPS that do NOT close
  // the finding — the engine cannot compute a counterfactual closure, so we never
  // assert one. Byte-neutral for interpretation-free inputs (`interp.list` empty ⇒
  // `presentationInterpretations` empty ⇒ the loop pushes nothing).
  const scrapedFixCount = out.fixHints.length;
  let remediationSurfaced = false;
  for (const i of presentationInterpretations) {
    const rem = i.remediation;
    if (rem === undefined || rem.steps.length === 0) continue;
    remediationSurfaced = true;
    const ordered = rem.steps.map((s, n) => `(${n + 1}) ${s.trim()}`).join(' ');
    const tool =
      rem.whatIfTool !== undefined && rem.whatIfTool.trim().length > 0
        ? ` Model the change with ${rem.whatIfTool.trim()} (models the counterfactual; does NOT itself close this finding).`
        : '';
    const coverage =
      i.coverageCaveat !== null && i.coverageCaveat.trim().length > 0
        ? ` [coverage caveat: ${i.coverageCaveat.trim()}]`
        : '';
    pushCapped(
      out.fixHints,
      `Cited remediation [${i.concept} · ${i.ruleId} · confidence: ${rem.confidence}]: ${ordered}${tool} These are dependency-ordered fix STEPS; the engine does NOT re-verify the finding after them.${coverage}`,
      MAX_HINTS,
    );
    // NEXT — the immediate first step (or, when the only step is the tool
    // pointer, that). Verbatim from the authored remediation; never invented.
    const firstStep = rem.steps[0]?.trim();
    if (firstStep !== undefined && firstStep.length > 0) {
      pushCapped(out.nextHints, `${firstStep}${tool}`, MAX_HINTS);
    }
  }
  // CITED-REMEDIATION honesty — DISCLOSE ABSENCE. Fired reasoning claim(s), but
  // NONE carried authored remediation AND no scraped fix filled the slot: the FIX
  // slot stays empty BY DESIGN (never a fabricated fix). Surface an explicit "no
  // cited remediation authored" note so a host never invents one. Scoped so it
  // never fires for interpretation-free inputs (byte-identical) or when a
  // remediation / scraped fix IS present.
  if (interp.list.length > 0 && !remediationSurfaced && scrapedFixCount === 0) {
    pushCapped(out.caveats, NO_REMEDIATION_CAVEAT, MAX_CAVEATS);
  }

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
    // absence claim is UNGROUNDED when the source's coverage is incomplete —
    // "no X references this" over PARTIAL coverage is "not checked", not proven
    // "none". Coverage is incomplete when EITHER the heuristic key/phrase scan
    // trips (`out.coverageIncomplete`) OR the interpret-EXPLICIT signal fires
    // (`reasoningIncomplete`, RM-3 step 3e): a `confidence: unknown` / non-null
    // coverageCaveat / fired-nothing empty interpret result. The explicit signal
    // is an OVERRIDE layered ON TOP of the heuristic (never a replacement), and
    // it is zero for interpretation-free inputs so the heuristic stands alone.
    // Over COMPLETE coverage the same claim is grounded, so `grounded` stays
    // true and the list is empty. Always computed when a draft is present.
    const absenceClaims = findAbsenceClaims(input.draft);
    ungroundedAbsenceClaims =
      out.coverageIncomplete || reasoningIncomplete ? absenceClaims : [];
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
    // SYNTHESIZE-BURIES-INTERPRET-CLAIMS: acknowledge the promoted reasoning
    // claim(s) in the summary so a host that reads only the summary knows the
    // answer carries curated reasoning (the claim TEXT itself lives in the
    // bullets above). Empty — and thus byte-identical — when no claim fired.
    (promotedClaimCount > 0
      ? `, ${promotedClaimCount} reasoning claim(s)`
      : '') +
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
  // RM-3 (step 3c) — the interpret fold, CALIBRATED for honest presentation
  // (FIX-F1/F2, a deliberate design correction toward calibrated honesty):
  //   * A `claim` is a STRUCTURAL description ("X is a formula field; its value
  //     is computed and cannot be written by Flow/Apex"). That is a plausible
  //     CAUSE, never an ACTION — so it can feed `likelyCause` but NEVER
  //     `nextAction`, which reverts to the scrape.
  //   * Precedence is NON-CLOBBERING: an on-topic SCRAPED cause always keeps
  //     `likelyCause`; the claim fills that slot ONLY when the scrape carried no
  //     cause (`out.causeHints` empty — exactly the pure reasoning flow, where
  //     the interpret payload carries no scrape fields). When a scraped cause
  //     exists, the claim is surfaced as a hedged SUPPLEMENTARY note instead of
  //     overwriting on-topic scraped evidence.
  //   * The HEDGE travels WITH the claim (FIX-F2): a `heuristic`/`unknown`
  //     confidence and/or a non-null `coverageCaveat` is appended inline so a
  //     surfaced claim never reads as a bare hard fact, and each claim keeps its
  //     OWN marker (never flattened into one undifferentiated blob).
  // Interpretation-free inputs produce no claim, so every field below stays
  // BYTE-IDENTICAL to the pre-interpret output (P12 / I3c stay green).
  const hedgeSuffix = (i: Interpretation): string => {
    const marks: string[] = [];
    if (i.confidence === 'heuristic' || i.confidence === 'unknown') {
      marks.push(`confidence: ${i.confidence}`);
    }
    if (i.coverageCaveat !== null && i.coverageCaveat.trim().length > 0) {
      marks.push(i.coverageCaveat.trim());
    }
    return marks.length > 0 ? ` [${marks.join('; ')}]` : '';
  };
  // Compound-concept presentation precedence. Keep EVERY typed interpretation
  // in `evidence.interpretations` for audit, but do not concatenate a compound
  // conclusion beside the two constituent conclusions it already subsumes.
  // Without this fold, the system-context/external-surface hot-spot produces
  // ~3 KB of repetitive likelyCause prose (external surface + sharing mode +
  // their conjunction), even though the conjunction is the user-facing finding.
  // `presentationInterpretations` is computed once above (shared with the bullet
  // promotion) so the note rendering and the bullets stay in lockstep.
  const renderedClaims = presentationInterpretations
    .filter((i) => i.claim.trim().length > 0)
    .map((i) => `${i.claim.trim()}${hedgeSuffix(i)}`);
  const interpClaim = renderedClaims.length > 0 ? renderedClaims.join(' ') : null;
  const scrapedCause = firstOrNull(out.causeHints);
  // Non-clobber: the on-topic scraped cause wins; the claim only FILLS an empty
  // cause slot (the pure reasoning flow, where no scrape cause exists).
  const likelyCause = scrapedCause ?? interpClaim;
  const recommendedFix = firstOrNull(out.fixHints);
  // A structural claim is a CAUSE, not an ACTION — nextAction stays the scrape.
  const nextAction = firstOrNull(out.nextHints) ?? recommendedFix;
  // The interpret coverageCaveat is a genuine hedge, so it fronts the risk slot
  // when present (it is also surfaced in `out.caveats` and inline on the claim).
  // Byte-identical for interpretation-free inputs (`interpRisk` is null).
  const interpRisk =
    interp.list
      .map((i) => i.coverageCaveat)
      .find((c) => c !== null && c.trim().length > 0) ?? null;
  const risk = interpRisk ?? firstOrNull(out.caveats);
  // FIX-F1/F2: when an on-topic scraped cause held `likelyCause`, the claim(s)
  // are surfaced as grounded, hedged supplementary notes so the reasoning is not
  // buried — but the scraped evidence is never overwritten. Empty when the claim
  // already IS `likelyCause` (no double-surface) or there is no claim.
  const interpretationNotes = scrapedCause !== null ? renderedClaims : [];
  // An id mentioned INSIDE a cause/fix/next string (or a supplementary note) but
  // not independently cited (the whole-id grounding) is an ungrounded reference.
  const idsInText = (text: string | null): string[] =>
    text === null ? [] : [...new Set(text.match(CANONICAL_ID_INLINE) ?? [])].filter((id) => !out.ids.has(id));
  const orphanComponentIds = [
    ...new Set([
      ...idsInText(likelyCause),
      ...idsInText(recommendedFix),
      ...idsInText(nextAction),
      ...interpretationNotes.flatMap(idsInText),
    ]),
  ].sort();
  const evidence: EvidenceTemplate = {
    finding: out.bullets[0] ?? null,
    evidence: citations.slice(0, 5).map((c) => c.id),
    likelyCause,
    recommendedFix,
    risk,
    nextAction,
    orphanComponentIds,
    // RM-3 (step 3b): the typed interpretations lifted by the shape-gated
    // collector, with per-item confidence intact. Empty for interpretation-free
    // inputs (byte-identical output); an EMPTY array is "no concept rule fired",
    // never a no-dependency verdict.
    interpretations: interp.list,
    interpretationNotes,
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
