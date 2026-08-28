/**
 * Handler for the `sfi.picklist_integrity_scan` MCP tool.
 *
 * The org-wide INVERSE of `sfi.what_if_remove_picklist_value`. Where the
 * what-if tool starts from ONE value and asks "what breaks if I remove it",
 * this scan sweeps EVERY picklist CustomField in the vault, collects every
 * string literal that DECLARATIVE source metadata COMPARES or ASSIGNS against
 * that field (`ISPICKVAL(field,'x')` / formula-field formulas, Validation-Rule
 * formulas, Flow decision criteria and literal assignments, Workflow-Rule
 * criteria, field defaults), and flags each literal that:
 *
 *   - matches NO defined value on the field (a typo / renamed-away / orphaned
 *     reference) — HIGH. When a defined value is spelling-close, a NEAR-MATCH
 *     suggestion is attached. An orphaned literal in a COMPARISON is a branch
 *     that silently died; an orphaned literal that is only ASSIGNED is flagged
 *     only when the field is a RESTRICTED picklist (see below).
 *   - matches only an INACTIVE (deactivated) value — MEDIUM.
 *
 * A field whose DEFAULT (the field-level `defaultValue` literal, or a picklist
 * value flagged `default: true`) points at an absent or inactive value is
 * flagged the same way, cited on the field itself.
 *
 * This catches the class of bug where a picklist value is renamed or
 * deactivated but a comparison / assignment elsewhere still references the OLD
 * string — the branch quietly stops firing BEFORE a user reports it.
 *
 * Honesty spine:
 *   - **Two confidence axes.** The DEFINED value set is `declared` metadata;
 *     literals parsed from formula source (VR / formula-field) are `parsed`;
 *     declarative Flow / Workflow criteria and defaults are `declared`. Each
 *     per-hit citation carries its own tier; the claim confidence is the WEAKEST
 *     grounding source (any `parsed` reference ⇒ the field's finding is
 *     `parsed`). No finding is ever emitted as `heuristic`-certain.
 *   - **Comparison vs assignment + restricted awareness.** An orphaned COMPARISON
 *     cannot match a defined value, so it is flagged. An orphaned ASSIGNMENT is a
 *     defect only for a RESTRICTED picklist — an UNRESTRICTED picklist accepts
 *     free text — so an orphaned assignment to a field of unknown/unrestricted
 *     restrictedness is NOT flagged (this is why a free-text Task-subject write
 *     is not mis-flagged). See {@link classifyPicklistLiterals}.
 *   - **Apex is NOT covered.** Apex picklist-literal comparison is out of scope
 *     (see the module Apex boundary): an Apex node carries no literal-bearing
 *     property, and a bare-name scan of raw `.cls` source cross-attributes a
 *     same-named field on a different object. Reviewed separately.
 *   - **Metadata integrity, NOT a record-value check.** Whether any RECORD
 *     actually holds a value is a runtime question answered by
 *     `sfi.live_picklist_usage`, not this tool.
 *
 * The classification is factored into a PURE function
 * ({@link classifyPicklistLiterals}) that takes a field's normalized values +
 * a set of `{ literal, source, kind, location, componentId }` references and
 * returns the findings — so it is unit-testable with synthetic fixtures, no
 * vault. The handler is the thin MCP wrapper: it enumerates picklist fields,
 * batches their incoming edges + source nodes, gathers references with the
 * reused extractors, classifies per field, and pages over FIELDS-with-findings.
 *
 * Distinct from — and must not duplicate — `sfi.what_if_remove_picklist_value`
 * (single-value blast radius) and `sfi.live_picklist_usage` (runtime record
 * distribution).
 */

import type {
  ComponentId,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  jaroWinkler,
  listEdgesForNodes,
  listNodesByIds,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { readFieldDataType } from './field-properties.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { extractEqualityLiterals } from './picklist-literal-check.js';
import {
  normalizePicklistValues,
  type NormalizedPicklistValue,
} from './picklist-values.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

/** Tool name stamped onto minted cursors and checked on resume (R6 / CR-22). */
const PICKLIST_INTEGRITY_SCAN_TOOL = 'sfi.picklist_integrity_scan';

/** Inclusive upper bound on `limit` (the shared enumeration-style cap). */
const PICKLIST_INTEGRITY_MAX_LIMIT = 500;
/** Default `limit` when the caller omits it. The slice is over FIELDS. */
const PICKLIST_INTEGRITY_DEFAULT_LIMIT = 50;

/** Field data types that carry an inline picklist value set. */
const PICKLIST_TYPES = new Set<string>(['Picklist', 'MultiselectPicklist']);

/**
 * Jaro-Winkler similarity at/above which a defined value is offered as the
 * near-match for an orphaned literal. High enough that a genuine typo
 * (`Widthdrawn`≈`Withdrawn`) qualifies but an unrelated value does not.
 */
const NEAR_MATCH_THRESHOLD = 0.82;

/**
 * The verbatim scope boundary — this is a METADATA integrity check. Whether any
 * RECORD holds a value is a runtime question for `sfi.live_picklist_usage`.
 */
const PICKLIST_INTEGRITY_SCOPE_DISCLOSURE =
  'This is a METADATA integrity check: it compares literals found in SOURCE metadata against each field\'s defined picklist values. It does NOT read record data — whether any RECORD actually holds a value (or an inactive one) is a runtime question answered by `sfi.live_picklist_usage`, not this tool. It is also NOT the single-value blast radius of `sfi.what_if_remove_picklist_value`.';

/**
 * The verbatim recall-gap boundary — the static scan sees only literals ADJACENT
 * to the field reference in DECLARATIVE metadata; variable comparisons, dynamic
 * strings, and reflective access are invisible.
 */
const PICKLIST_INTEGRITY_RECALL_DISCLOSURE =
  'Only string literals compared/assigned ADJACENT to the field reference in declarative metadata are seen (a Validation-Rule / formula-field formula, a Flow literal assignment / decision criterion, a field default). Variable-based comparisons (`field == someVar`), dynamically-built SOQL/Apex strings, and reflective field access (`obj.get(\'Field\')`) are NOT statically resolvable and are invisible here — a recall gap, so an empty finding is "not checked", not proven clean.';

/**
 * The verbatim Apex boundary — Apex picklist-literal comparison is NOT covered.
 * An ApexClass / ApexTrigger node carries no literal-bearing property, and a
 * bare-field-name scan of the raw `.cls` source cross-attributes a same-named
 * field on a different object (a cross-object false positive) without Apex type
 * inference the offline model does not have.
 */
const PICKLIST_INTEGRITY_APEX_DISCLOSURE =
  'Apex picklist-literal comparison is NOT covered. An Apex `field == \'X\'` / `ISPICKVAL(field,\'X\')` reference is invisible to this scan: an Apex node carries no literal-bearing property, and a bare-field-name scan of the raw `.cls` source would cross-attribute a same-named field on a DIFFERENT object (e.g. `acct.Status__c` vs `Case.Status__c`) — an unsound false positive without Apex type inference. Review Apex picklist comparisons separately.';

/**
 * The verbatim "static shape, not proof" boundary — an orphaned literal is a
 * comparison the value set cannot satisfy, not a proven dead branch, and an
 * assignment is narrated as an assignment, not a dead branch.
 */
const PICKLIST_INTEGRITY_STATIC_DISCLOSURE =
  'An orphaned literal in a COMPARISON is a static test the field\'s value set cannot satisfy (a typo, a renamed-away value, or a value never defined) — a strong signal that the branch silently died, but confirm in context before deleting the value or the branch. An orphaned literal in an ASSIGNMENT is a value written to the field, which is a defect only for a RESTRICTED picklist (see the restricted-flag boundary) — it is NOT a dead branch. An "inactive-only" literal references a value that is retained but no longer selectable.';

/**
 * The verbatim restricted-flag boundary — the offline vault does not model each
 * picklist's `restricted` flag, so an orphaned ASSIGNMENT to a field of unknown
 * restrictedness is deliberately NOT flagged (it may be legitimate free text).
 */
const PICKLIST_INTEGRITY_RESTRICTED_DISCLOSURE =
  'The offline vault does not model each picklist\'s `restricted` flag on a field, so this scan cannot always tell a RESTRICTED picklist (which rejects undefined values) from an UNRESTRICTED one (which accepts free text). Policy: an orphaned literal in a COMPARISON is flagged (it cannot match a defined value regardless), but an orphaned literal that is only ASSIGNED to a field of unknown restrictedness is NOT flagged — it may be legitimate free text on an unrestricted picklist. When a field DOES carry a `restricted` flag in the vault it is honored: orphaned literals on an unrestricted field are suppressed; on a restricted field both comparisons and assignments are flagged.';

/**
 * Zod schema for the `sfi.picklist_integrity_scan` tool input.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 50 inside the
 *     handler. The slice is over FIELDS-with-findings, not individual findings —
 *     a field with 4 orphaned literals counts as 1 entry in the limit budget.
 *   - `offset`: optional zero-based offset for paging the FIELD list forward.
 *   - `cursor`: optional opaque continuation token from a prior truncated
 *     page's `nextCursor` (R6 / CR-22, via `paginateLegacy`). Bound to this
 *     tool + the vault's `sourceTreeHash`, so a cursor minted before a refresh
 *     is rejected with `invalid-query` instead of silently reading the wrong
 *     page — a raw `offset` carried across a refresh cannot be checked this
 *     way. An explicit `cursor` wins over `offset` when both are given.
 */
export const picklistIntegrityScanInputSchema = z.object({
  limit: z.number().int().min(1).max(PICKLIST_INTEGRITY_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape. */
export type PicklistIntegrityScanInput = z.infer<
  typeof picklistIntegrityScanInputSchema
>;

/** The kind of source a literal reference came from (for the citation). */
export type PicklistReferenceSource =
  | 'apex'
  | 'flow'
  | 'validation-rule'
  | 'workflow-rule'
  | 'formula-field'
  | 'conditional-context'
  | 'default'
  | 'other';

/** The two flag kinds this tool emits. */
export type PicklistFindingKind = 'orphaned' | 'inactive-only';

/** Two-tier severity — orphaned literals are HIGH, inactive-only MEDIUM. */
export type PicklistFindingSeverity = 'high' | 'medium';

/**
 * How the literal is USED against the field — the axis that decides whether an
 * orphaned literal is a genuine integrity problem:
 *   - `comparison` — a decision / criterion / formula test (`field == 'X'`,
 *     `ISPICKVAL(field,'X')`, a Flow decision criterion). A comparison against a
 *     value the set cannot hold is a branch that silently dies.
 *   - `assignment` — a literal WRITTEN to the field (a Flow record-update literal
 *     assignment, an Apex `field = 'X'`). Assigning a value outside the defined
 *     set fails at save ONLY for a RESTRICTED picklist; an UNRESTRICTED picklist
 *     accepts free text, so an orphaned assignment is not, by itself, a defect.
 *   - `default` — the field's OWN default value (field-level `defaultValue` or a
 *     value flagged `default: true`). A default outside the field's own value set
 *     is a metadata-config smell regardless of use.
 */
export type PicklistReferenceKind = 'comparison' | 'assignment' | 'default';

/**
 * One per-hit citation: a literal the source compares/assigns against the field,
 * with WHERE it came from and at what confidence.
 */
export interface PicklistLiteralReference {
  /** The literal as it appears in source (original casing preserved). */
  readonly literal: string;
  /** The kind of source metadata the literal was found in. */
  readonly source: PicklistReferenceSource;
  /**
   * How the literal is used against the field. Optional for back-compat with
   * hand-built fixtures: when absent it is derived (a `default`-source ref is a
   * `default`, everything else a `comparison`).
   */
  readonly kind?: PicklistReferenceKind;
  /** Human-readable, org-agnostic location (property / element / criterion). */
  readonly location: string;
  /** The referencing component's canonical id (the field itself for a default). */
  readonly componentId: ComponentId;
  /** Per-hit confidence tier: `parsed` for source literals, `declared` for metadata. */
  readonly confidence: ConfidenceLevel;
}

/** One flagged literal on a field, with its per-hit citations. */
export interface PicklistFinding {
  /** The offending literal (original casing). */
  readonly literal: string;
  /** `orphaned` (matches no value) or `inactive-only` (matches a deactivated value). */
  readonly kind: PicklistFindingKind;
  /** `high` for orphaned, `medium` for inactive-only. */
  readonly severity: PicklistFindingSeverity;
  /** Closest defined value by spelling for an orphaned literal, else `null`. */
  readonly nearMatch: string | null;
  /** Every place this literal is referenced (deduplicated, sorted). */
  readonly references: readonly PicklistLiteralReference[];
}

/** One per-field entry: identity + its findings. */
export interface PicklistFieldFindings {
  readonly fieldId: ComponentId;
  readonly apiName: string;
  readonly fieldType: string;
  /** Count of defined values on the field (active + inactive). */
  readonly definedValueCount: number;
  /** Count of ACTIVE (selectable) values. */
  readonly activeValueCount: number;
  /** Findings on this field, orphaned first then inactive-only, literal ASC. */
  readonly findings: readonly PicklistFinding[];
}

/** Output payload. */
export interface PicklistIntegrityScanOutput {
  /** Per-field entries with at least one finding, sorted by fieldId ASC (sliced by `limit`). */
  readonly fields: readonly PicklistFieldFindings[];
  /** CustomFields scanned (read) this run. */
  readonly scannedFieldCount: number;
  /** Picklist / MultiselectPicklist fields with an inline value set that were checked. */
  readonly picklistFieldCount: number;
  /** Fields with >=1 finding BEFORE the `limit` slice. */
  readonly totalFieldCount: number;
  /** Total findings across all flagged fields (FULL, pre-slice). */
  readonly totalFindingCount: number;
  /** Per-kind counter across the FULL matched set. */
  readonly byKind: Readonly<Record<PicklistFindingKind, number>>;
  /** Verbatim honesty disclosures. */
  readonly boundaries: readonly string[];
  /** True when the FIELD-level slice was trimmed to `limit`. */
  readonly truncated: boolean;
  /** Provenance / confidence / completeness for the answer. */
  readonly trust: TrustSummary;
  /** Page size applied. Present only on a PAGED response (`truncated` or `offset > 0`). */
  readonly limit?: number;
  /** Zero-based offset of the first returned field. Present only when paged. */
  readonly offset?: number;
  /** Offset to pass on the next call. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * Opaque continuation token, present ONLY when this page was truncated.
   * Prefer this over `nextOffset` to resume — it is bound to this tool and
   * the vault's `sourceTreeHash`, so it is rejected outright if replayed
   * after a refresh instead of silently reading the wrong page.
   */
  readonly nextCursor?: string;
  /** Structured page info mirroring `nextCursor` (used by the seam detector). */
  readonly pageInfo?: PageInfo;
}

// ---------------------------------------------------------------------------
// The PURE classifier — unit-testable without a vault.
// ---------------------------------------------------------------------------

/** Case-insensitive, whitespace-trimmed match key for a picklist value / literal. */
const normKey = (value: string): string => value.trim().toLowerCase();

/**
 * Closest defined value to `literal` by Jaro-Winkler similarity, returned only
 * when the best score is at/above {@link NEAR_MATCH_THRESHOLD}; else `null`.
 * Reuses the repo's canonical spelling-closeness metric (the same one the
 * typo-tolerant resolver uses) — no new dependency.
 */
export const closestDefinedValue = (
  literal: string,
  definedValues: readonly NormalizedPicklistValue[],
  threshold: number = NEAR_MATCH_THRESHOLD,
): string | null => {
  const needle = normKey(literal);
  let best: { value: string; score: number } | null = null;
  for (const dv of definedValues) {
    const score = jaroWinkler(needle, normKey(dv.value));
    if (best === null || score > best.score) best = { value: dv.value, score };
  }
  return best !== null && best.score >= threshold ? best.value : null;
};

/** Deterministic reference ordering: componentId, then source, then location. */
const compareReferences = (
  a: PicklistLiteralReference,
  b: PicklistLiteralReference,
): number => {
  if (a.componentId !== b.componentId)
    return a.componentId < b.componentId ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.location !== b.location) return a.location < b.location ? -1 : 1;
  return 0;
};

/** Severity rank for sorting — high before medium. */
const severityRank = (s: PicklistFindingSeverity): number =>
  s === 'high' ? 0 : 1;

/**
 * The USE kind of a reference, deriving a sensible default when the fixture /
 * caller did not stamp one: a `default`-source ref is a `default`, everything
 * else is a `comparison`. (The vault-facing gather layer stamps the axis
 * explicitly; this keeps hand-built fixtures — and the existing pure-classifier
 * tests — behaving as before.)
 */
const referenceKind = (ref: PicklistLiteralReference): PicklistReferenceKind =>
  ref.kind ?? (ref.source === 'default' ? 'default' : 'comparison');

/**
 * PURE picklist-literal classifier. Given a field's normalized defined values
 * and a set of `{ literal, source, location, componentId, kind }` references,
 * classify each DISTINCT literal (case-insensitively) into:
 *
 *   - `orphaned`      — matches no defined value at all (HIGH). A near-match
 *     suggestion is attached when a defined value is spelling-close.
 *   - `inactive-only` — matches a defined value that is ONLY inactive (MEDIUM).
 *   - (ok)            — matches an ACTIVE value → NO finding emitted.
 *
 * **Restricted-flag policy (`options.fieldRestricted`).** An orphaned literal is
 * only a genuine integrity problem when the picklist cannot legitimately hold
 * it:
 *   - `fieldRestricted === true`  — the field rejects undefined values, so EVERY
 *     orphaned literal (comparison OR assignment) is flagged HIGH.
 *   - `fieldRestricted === false` — the field accepts free text, so NO orphaned
 *     literal is flagged (a record may legitimately hold it).
 *   - `fieldRestricted === undefined` (the offline default — the vault does not
 *     model the flag) — an orphaned COMPARISON / DEFAULT is flagged HIGH (it
 *     cannot match a defined value regardless), but an orphaned literal that is
 *     ONLY ever ASSIGNED is suppressed (it may be free text on an unrestricted
 *     picklist). This is what stops a free-text assignment to an unrestricted
 *     standard picklist from being mis-flagged as a dead branch.
 *
 * `inactive-only` is flagged MEDIUM regardless of restrictedness or use kind — a
 * reference to a deactivated value is a smell either way.
 *
 * References are grouped by normalized literal (first-seen casing wins for
 * display) and deduplicated by `(componentId, source, location)`. Findings are
 * returned severity-first (orphaned before inactive-only), then literal ASC.
 * No I/O, no graph — the handler and the unit tests both call this.
 */
export const classifyPicklistLiterals = (
  definedValues: readonly NormalizedPicklistValue[],
  references: readonly PicklistLiteralReference[],
  options?: {
    readonly nearMatchThreshold?: number;
    readonly fieldRestricted?: boolean | undefined;
  },
): readonly PicklistFinding[] => {
  const threshold = options?.nearMatchThreshold ?? NEAR_MATCH_THRESHOLD;
  const fieldRestricted = options?.fieldRestricted;

  const activeKeys = new Set<string>();
  const inactiveKeys = new Set<string>();
  for (const dv of definedValues) {
    const key = normKey(dv.value);
    if (dv.isActive) activeKeys.add(key);
    else inactiveKeys.add(key);
  }

  // Group references by normalized literal, deduping identical citations.
  const groups = new Map<
    string,
    { literal: string; refs: PicklistLiteralReference[] }
  >();
  for (const ref of references) {
    const key = normKey(ref.literal);
    if (key.length === 0) continue;
    let group = groups.get(key);
    if (group === undefined) {
      group = { literal: ref.literal, refs: [] };
      groups.set(key, group);
    }
    const dup = group.refs.some(
      (r) =>
        r.componentId === ref.componentId &&
        r.source === ref.source &&
        r.location === ref.location,
    );
    if (!dup) group.refs.push(ref);
  }

  const findings: PicklistFinding[] = [];
  for (const [key, group] of groups) {
    // A literal that matches an ACTIVE defined value is fine — no finding.
    if (activeKeys.has(key)) continue;

    if (inactiveKeys.has(key)) {
      findings.push({
        literal: group.literal,
        kind: 'inactive-only',
        severity: 'medium',
        nearMatch: null,
        references: [...group.refs].sort(compareReferences),
      });
      continue;
    }

    // Orphaned: matches no defined value. Apply the restricted-flag policy.
    if (fieldRestricted === false) continue; // unrestricted → free text allowed.
    if (fieldRestricted !== true) {
      // Unknown restrictedness: flag only when at least one reference is NOT a
      // bare assignment (a comparison or the field's own default). A literal
      // that is ONLY assigned could be legitimate free text — suppress it.
      const flaggable = group.refs.some((r) => referenceKind(r) !== 'assignment');
      if (!flaggable) continue;
    }
    findings.push({
      literal: group.literal,
      kind: 'orphaned',
      severity: 'high',
      nearMatch: closestDefinedValue(group.literal, definedValues, threshold),
      references: [...group.refs].sort(compareReferences),
    });
  }

  findings.sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return normKey(a.literal) < normKey(b.literal)
      ? -1
      : normKey(a.literal) > normKey(b.literal)
        ? 1
        : 0;
  });
  return findings;
};

// ---------------------------------------------------------------------------
// Reference gathering (the vault-facing extraction layer).
// ---------------------------------------------------------------------------

/** Escape a string for literal use inside a `RegExp`. */
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A field reference optionally qualified by a relationship / object / variable
 * prefix (`$Record.`, `Account.`, `obj.`) ending in the field's bare API name.
 */
const fieldRefPattern = (shortName: string): string =>
  `(?:[A-Za-z0-9_$]+\\.)*${escapeRegex(shortName)}\\b`;

/** Undo backslash escaping inside a captured string literal. */
const unescapeLiteral = (raw: string): string => raw.replace(/\\(.)/g, '$1');

/**
 * Extract string literals compared/assigned ADJACENT to `shortName` in a text
 * (Apex, formula, expression). Handles `field = / == / != / <> 'x'` in both
 * orders, `ISPICKVAL(field, 'x')`, `TEXT(field) op 'x'` in both orders, and —
 * via the reused {@link extractEqualityLiterals} — SOQL/formula `field = 'x'`
 * and `field IN ('a','b')`. A bare literal NOT adjacent to the field reference
 * is deliberately NOT collected (it cannot be soundly attributed to this field).
 */
export const extractQuotedFieldLiterals = (
  text: string,
  shortName: string,
): readonly string[] => {
  const out: string[] = [];
  const ref = fieldRefPattern(shortName);
  const lit = `(['"])((?:[^'"\\\\]|\\\\.)*)\\1`;
  const op = `(?:==|=|!=|<>)`;
  const patterns: readonly RegExp[] = [
    // ISPICKVAL(field, 'lit')
    new RegExp(`ISPICKVAL\\s*\\(\\s*${ref}\\s*,\\s*${lit}`, 'gi'),
    // TEXT(field) op 'lit'
    new RegExp(`TEXT\\s*\\(\\s*${ref}\\s*\\)\\s*${op}\\s*${lit}`, 'gi'),
    // field op 'lit'
    new RegExp(`${ref}\\s*${op}\\s*${lit}`, 'gi'),
  ];
  for (const re of patterns) {
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      // The `ref` prefix is non-capturing, so `lit`'s two groups are m[1]
      // (quote) and m[2] (the literal value). Reading m[3] — as the broken
      // build did — silently returned NOTHING for every ISPICKVAL / TEXT() /
      // `field op 'lit'` forward match, so formula-mirror / VR literals were
      // never extracted. The literal is group 2.
      const value = m[2];
      if (value !== undefined && value.length > 0) out.push(unescapeLiteral(value));
    }
  }
  // Reversed shapes: 'lit' op field  and  'lit' op TEXT(field). The literal is
  // group 2 here (quote is group 1), field ref trails.
  const reversed: readonly RegExp[] = [
    new RegExp(`${lit}\\s*${op}\\s*TEXT\\s*\\(\\s*${ref}\\s*\\)`, 'gi'),
    new RegExp(`${lit}\\s*${op}\\s*${ref}`, 'gi'),
  ];
  for (const re of reversed) {
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const value = m[2];
      if (value !== undefined && value.length > 0) out.push(unescapeLiteral(value));
    }
  }
  // SOQL / formula `field = 'x'` and `field IN ('a','b')` via the reused parser,
  // filtered to equalities whose left field matches this field's bare name.
  for (const eq of extractEqualityLiterals(text)) {
    const seg = eq.field.split('.').pop();
    if (seg !== undefined && seg.toLowerCase() === shortName.toLowerCase()) {
      for (const l of eq.literals) if (l.length > 0) out.push(l);
    }
  }
  return out;
};

/**
 * A criteria operand that is a BOOLEAN literal, not a picklist value. Flow
 * decision operators like `IsNull`, `IsChanged`, `WasSet`, `WasVisited` take a
 * boolean right-hand side (`$Record.X IsNull false`), which the token-run
 * capture would otherwise mis-read as an orphaned picklist literal.
 */
const isBooleanOperand = (value: string): boolean => {
  const t = value.trim().toLowerCase();
  return t === 'true' || t === 'false';
};

/**
 * A criteria operand that is a FIELD REFERENCE / merge field, not a literal
 * picklist value: `$Record.X`, `$Record__Prior.X`, `{!$Record.X}`, `$User.Foo`,
 * or a bare dotted identifier path (`Account.Name`). A field-to-field comparison
 * (`$Record__Prior.X NotEqualTo $Record.X`) is not a literal and must not be
 * attributed to the field as a picklist value. Genuine picklist values may
 * contain spaces / slashes / hyphens but never take a bare `A.B` identifier
 * shape, so this filter does not clip real values.
 */
const isReferenceOperand = (value: string): boolean => {
  const t = value.trim();
  if (t.startsWith('$') || t.startsWith('{!') || t.startsWith('{$')) return true;
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(t);
};

/**
 * Extract comparison values from a DECLARATIVE criteria expression (the
 * `properties.conditions[].expression` mirror from the condition-extractor),
 * where the value is UNQUOTED: `$Record.Status__c EqualTo Withdrawn`. Splits on
 * `AND` / `OR`, and for each clause that references `shortName`, takes the token
 * run after the operation word as the raw value.
 *
 * The raw value is then split on commas (a multi-value criterion such as
 * `Closed,Cancelled/Pass` names TWO defined values, not one orphaned literal),
 * and each part is dropped when it is not a real picklist literal:
 *   - a BOOLEAN operand (`true` / `false`) — the RHS of `IsNull` / `IsChanged`;
 *   - a FIELD-REFERENCE / merge-field operand (`$Record.X`, `Account.Name`) — a
 *     field-to-field comparison, not a literal.
 * A value-less operation (`IsNull` with no operand) yields nothing.
 */
export const extractCriteriaValues = (
  expression: string,
  shortName: string,
): readonly string[] => {
  const out: string[] = [];
  const clauseRe = new RegExp(
    `(?:^|\\s)${fieldRefPattern(shortName)}\\s+\\S+\\s+(.+)$`,
    'i',
  );
  for (const raw of expression.split(/\s+(?:AND|OR)\s+/i)) {
    const clause = raw.replace(/^[\s(]+|[\s)]+$/g, '');
    const m = clause.match(clauseRe);
    const captured = m?.[1];
    if (captured === undefined) continue;
    const rawValue = captured.trim().replace(/^['"]|['"]$/g, '').trim();
    if (rawValue.length === 0) continue;
    // Split a multi-value criterion (comma-delimited) and keep only genuine
    // picklist literals — drop booleans and field references.
    for (const part of rawValue.split(',')) {
      const value = part.trim().replace(/^['"]|['"]$/g, '').trim();
      if (value.length === 0) continue;
      if (isBooleanOperand(value)) continue;
      if (isReferenceOperand(value)) continue;
      out.push(value);
    }
  }
  return out;
};

/**
 * Whether a condition-mirror expression is raw FORMULA text (quoted literals,
 * merge fields, function calls) rather than a declarative unquoted criteria
 * triplet. Criteria triplets render as `field OP value AND …` with NO quotes or
 * `{!…}` merge syntax, so the presence of a quote or a merge field is a reliable
 * discriminator. Formula text must go through the quoted-literal extractor —
 * running the unquoted criteria-token extractor over it captures operator + quote
 * garbage (`!= 'Cancelled/Pass`).
 */
const looksLikeFormulaText = (expression: string): boolean =>
  expression.includes('{!') ||
  expression.includes("'") ||
  expression.includes('"');

/** Map a referencing node's type to a citation source bucket. */
const sourceForNode = (node: Node): PicklistReferenceSource => {
  switch (node.type) {
    case 'ApexClass':
    case 'ApexTrigger':
      return 'apex';
    case 'Flow':
      return 'flow';
    case 'ValidationRule':
      return 'validation-rule';
    case 'WorkflowRule':
      return 'workflow-rule';
    case 'CustomField':
      return 'formula-field';
    case 'ConditionalContext':
      return 'conditional-context';
    default:
      return 'other';
  }
};

/**
 * Text properties on a referencing node worth scanning for a field-adjacent
 * literal (declarative formula / criteria text the extractor stamped onto the
 * node). Apex has NO literal-bearing text property on its node and its raw
 * source is deliberately NOT scanned (see the module Apex boundary).
 * `stringLiterals` (a bare Apex literal index) is likewise absent: a bare literal
 * is not adjacent to a field reference, so attributing it to this field would be
 * an unsound false positive.
 */
const SCANNED_TEXT_PROPERTIES: readonly string[] = [
  'formula',
  'errorConditionFormula',
  'expression',
  'criteria',
];

/** Confidence tier for a literal read from a text property of a given node. */
const textConfidenceFor = (node: Node): ConfidenceLevel =>
  node.type === 'ApexClass' || node.type === 'ApexTrigger'
    ? 'parsed'
    : node.type === 'ValidationRule' || node.type === 'CustomField'
      ? 'parsed'
      : 'declared';

/**
 * Read a field's `restricted` flag from its node properties when the vault
 * carries it (some enrichment paths / global value sets do). Returns `undefined`
 * when the flag is not modeled — the offline default for an inline picklist,
 * which the classifier treats as "unknown restrictedness".
 */
const readRestricted = (node: Node): boolean | undefined =>
  typeof node.properties['restricted'] === 'boolean'
    ? (node.properties['restricted'] as boolean)
    : undefined;

/**
 * The `properties.conditions[]` mirror shape (from the condition-extractor) we
 * read defensively off a firer node.
 */
interface ConditionMirrorLike {
  readonly kind?: unknown;
  readonly expression?: unknown;
  readonly fieldRefs?: unknown;
}

/**
 * Collect every literal a single referencing source (one incoming edge's source
 * node, plus the edge itself for a Flow literal assignment) compares/assigns
 * against the target field, as citation references.
 *
 * Apex classes / triggers are deliberately NOT scanned for picklist literals —
 * see the module-level Apex boundary. Their node carries no literal-bearing
 * property, and a bare-field-name scan of the raw `.cls` source cross-attributes
 * a literal from one object's same-named field (`acct.Status__c`) to a
 * different object's field (`Case.Status__c`), a cross-object
 * false positive the offline model cannot resolve without Apex type inference.
 */
export const referencesFromEdgeSource = (
  edge: Edge,
  sourceNode: Node,
  shortName: string,
): readonly PicklistLiteralReference[] => {
  const refs: PicklistLiteralReference[] = [];
  const source = sourceForNode(sourceNode);

  // Flow literal assignment: the value lives on the `writesTo` edge, not in any
  // scanned text property. Only a literal assignment (`<stringValue>`) is
  // statically comparable — a reference assignment (variable/formula) is not.
  // This is an ASSIGNMENT (a value written TO the field), so it is a defect only
  // for a RESTRICTED picklist — the classifier's restricted policy decides.
  if (
    edge.edgeType === 'writesTo' &&
    edge.properties['assignedValueKind'] === 'literal' &&
    typeof edge.properties['assignedValue'] === 'string' &&
    edge.properties['assignedValue'].length > 0
  ) {
    refs.push({
      literal: edge.properties['assignedValue'],
      source: 'flow',
      kind: 'assignment',
      location: 'flow literal assignment',
      componentId: sourceNode.id,
      confidence: edge.confidence,
    });
  }

  // Text properties (formula / VR formula / expression / criteria). These are
  // COMPARISONS the field is tested against.
  const textConfidence = textConfidenceFor(sourceNode);
  for (const key of SCANNED_TEXT_PROPERTIES) {
    const text = sourceNode.properties[key];
    if (typeof text !== 'string' || text.length === 0) continue;
    for (const literal of extractQuotedFieldLiterals(text, shortName)) {
      refs.push({
        literal,
        source,
        kind: 'comparison',
        location: key,
        componentId: sourceNode.id,
        confidence: textConfidence,
      });
    }
  }

  // Declarative condition mirror (Flow decisions / Workflow criteria / VR
  // formulas rendered by the condition-extractor). A raw-FORMULA expression
  // carries QUOTED literals (use the quoted extractor); a declarative criteria
  // triplet carries UNQUOTED values (use the criteria extractor). Running the
  // criteria-token extractor over formula text captures operator + quote garbage,
  // so route by shape, NOT by scanning both.
  const conditions = sourceNode.properties['conditions'];
  if (Array.isArray(conditions)) {
    for (const raw of conditions) {
      if (typeof raw !== 'object' || raw === null) continue;
      const cond = raw as ConditionMirrorLike;
      const expression = cond.expression;
      if (typeof expression !== 'string' || expression.length === 0) continue;
      if (!expression.includes(shortName)) continue;
      const kind = typeof cond.kind === 'string' ? cond.kind : '';
      const isFormula = kind === 'formula' || looksLikeFormulaText(expression);
      const confidence: ConfidenceLevel = isFormula ? 'parsed' : 'declared';
      const literals = isFormula
        ? extractQuotedFieldLiterals(expression, shortName)
        : extractCriteriaValues(expression, shortName);
      for (const literal of literals) {
        refs.push({
          literal,
          source,
          kind: 'comparison',
          location: `condition (${kind || 'criteria'})`,
          componentId: sourceNode.id,
          confidence,
        });
      }
    }
  }

  return refs;
};

/**
 * Parse the field-level `<defaultValue>` into a single literal when it is a
 * plain quoted string or a bare token, else `null` (a complex formula default
 * cannot be attributed to one value). Picklist defaults in DX-source are usually
 * a quoted string (`"Draft"`).
 */
const readDefaultLiteral = (node: Node): string | null => {
  const raw = node.properties['defaultValue'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const dq = trimmed.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (dq?.[1] !== undefined) return unescapeLiteral(dq[1]);
  const sq = trimmed.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (sq?.[1] !== undefined) return unescapeLiteral(sq[1]);
  // A bare token / phrase with no formula syntax is a direct default value.
  if (/^[A-Za-z0-9_ ]+$/.test(trimmed)) return trimmed;
  return null;
};

/**
 * Gather every literal reference for ONE picklist field: its default(s) plus the
 * literals each incoming-edge source compares/assigns against it.
 */
const gatherFieldReferences = (
  fieldNode: Node,
  definedValues: readonly NormalizedPicklistValue[],
  incomingEdges: readonly Edge[],
  sourceById: ReadonlyMap<ComponentId, Node>,
): readonly PicklistLiteralReference[] => {
  const refs: PicklistLiteralReference[] = [];
  const shortName = fieldNode.apiName;

  // Field-level default value — a DEFAULT (the field's own config), always
  // flagged when it points outside the value set.
  const defaultLiteral = readDefaultLiteral(fieldNode);
  if (defaultLiteral !== null) {
    refs.push({
      literal: defaultLiteral,
      source: 'default',
      kind: 'default',
      location: 'field default value',
      componentId: fieldNode.id,
      confidence: 'declared',
    });
  }
  // Per-value default flag (`<default>true</default>`): flagged only if the
  // defaulted value is itself inactive (the classifier decides).
  for (const dv of definedValues) {
    if (dv.default === true) {
      refs.push({
        literal: dv.value,
        source: 'default',
        kind: 'default',
        location: 'picklist default value',
        componentId: fieldNode.id,
        confidence: 'declared',
      });
    }
  }

  // Incoming references.
  for (const edge of incomingEdges) {
    if (edge.edgeType === 'parentOf') continue;
    const sourceNode = sourceById.get(edge.fromId);
    if (sourceNode === undefined) continue;
    refs.push(...referencesFromEdgeSource(edge, sourceNode, shortName));
  }

  return refs;
};

/** Weakest confidence across a set of references — the claim's confidence. */
const weakestConfidence = (
  refs: readonly PicklistLiteralReference[],
): ConfidenceLevel => {
  let sawParsed = false;
  for (const r of refs) {
    if (r.confidence === 'heuristic') return 'heuristic';
    if (r.confidence === 'parsed') sawParsed = true;
  }
  return sawParsed ? 'parsed' : 'declared';
};

// ---------------------------------------------------------------------------
// The MCP handler.
// ---------------------------------------------------------------------------

/**
 * The `sfi.picklist_integrity_scan` MCP tool. Enumerates every picklist
 * CustomField with an inline value set, gathers the literals source metadata
 * compares/assigns against each, and flags orphaned / inactive-only references
 * plus bad defaults. See the module JSDoc for the rule set and honesty spine.
 *
 * @example
 *   const r = await picklistIntegrityScanHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.totalFindingCount);
 */
export const picklistIntegrityScanHandler = async (
  ctx: Context,
  input: PicklistIntegrityScanInput,
): Promise<Result<McpResponse<PicklistIntegrityScanOutput>, McpError>> => {
  const limit = input.limit ?? PICKLIST_INTEGRITY_DEFAULT_LIMIT;
  // This tool takes no filter args beyond limit/offset/cursor, so the
  // fingerprint is constant — it still binds the cursor to THIS tool + vault,
  // rejecting a cursor minted by a different tool or before a stale-vault swap.
  const fingerprint = argsFingerprint({});
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: PICKLIST_INTEGRITY_SCAN_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const scan = await scanAllNodesOfTypes(ctx.graph, ['CustomField']);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }

  // Keep only picklist fields that carry an INLINE value set — a field whose
  // values live in a Global Value Set has no offline value set to check against.
  const picklistFields: Array<{
    readonly node: Node;
    readonly defined: readonly NormalizedPicklistValue[];
    readonly fieldType: string;
  }> = [];
  for (const node of scan.value.nodes) {
    const fieldType = readFieldDataType(node);
    if (!PICKLIST_TYPES.has(fieldType)) continue;
    const defined = normalizePicklistValues(node.properties['picklistValues']);
    if (defined === null || defined.length === 0) continue;
    picklistFields.push({ node, defined, fieldType });
  }

  // Batch the incoming edges for every picklist field, then batch every source
  // node those edges point from — no per-field round trips.
  const fieldIds = picklistFields.map((f) => f.node.id);
  const edgesMap = fieldIds.length > 0
    ? await listEdgesForNodes(ctx.graph, fieldIds, { direction: 'in' })
    : null;
  if (edgesMap !== null && !edgesMap.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesMap.error.message}`,
    });
  }
  const edgesByField = edgesMap !== null && edgesMap.ok ? edgesMap.value : null;

  const sourceIds = new Set<ComponentId>();
  if (edgesByField !== null) {
    for (const edges of edgesByField.values()) {
      for (const edge of edges) {
        if (edge.edgeType === 'parentOf') continue;
        sourceIds.add(edge.fromId);
      }
    }
  }
  const sourceNodesResult = await listNodesByIds(ctx.graph, [...sourceIds]);
  if (!sourceNodesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${sourceNodesResult.error.message}`,
    });
  }
  const sourceById = new Map<ComponentId, Node>(
    sourceNodesResult.value.map((n) => [n.id, n]),
  );

  const fieldFindings: PicklistFieldFindings[] = [];
  const allWeakest: PicklistLiteralReference[] = [];
  const byKind: Record<PicklistFindingKind, number> = {
    orphaned: 0,
    'inactive-only': 0,
  };
  let totalFindingCount = 0;

  for (const { node, defined, fieldType } of picklistFields) {
    const incoming = edgesByField?.get(node.id) ?? [];
    const references = gatherFieldReferences(node, defined, incoming, sourceById);
    const findings = classifyPicklistLiterals(defined, references, {
      fieldRestricted: readRestricted(node),
    });
    if (findings.length === 0) continue;
    for (const finding of findings) {
      byKind[finding.kind] += 1;
      totalFindingCount += 1;
      allWeakest.push(...finding.references);
    }
    fieldFindings.push({
      fieldId: node.id,
      apiName: node.apiName,
      fieldType,
      definedValueCount: defined.length,
      activeValueCount: defined.filter((v) => v.isActive).length,
      findings,
    });
  }

  fieldFindings.sort((a, b) =>
    a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0,
  );

  // R6: call the shared pager instead of open-coding slice + truncated +
  // nextOffset — it adds a bound-checked `nextCursor` on top of the same
  // `items` / `hasMore` / `nextOffset` shape this handler already emitted, so
  // an in-budget response stays byte-identical. `fieldFindings` is already
  // sorted to a total order by `fieldId` (unique per field) just above, so
  // `fieldId` is a safe tiebreak key for the minted cursor. No per-handler
  // byte budget (offset/limit only, matching pre-fix behavior) — the global
  // response-budget guard backstops any oversized page.
  const paged = paginateLegacy(fieldFindings, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    keyOf: (f) => f.fieldId,
    binding: {
      tool: PICKLIST_INTEGRITY_SCAN_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const slice = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  const boundaries: string[] = [
    PICKLIST_INTEGRITY_SCOPE_DISCLOSURE,
    PICKLIST_INTEGRITY_RECALL_DISCLOSURE,
    PICKLIST_INTEGRITY_STATIC_DISCLOSURE,
    PICKLIST_INTEGRITY_RESTRICTED_DISCLOSURE,
    PICKLIST_INTEGRITY_APEX_DISCLOSURE,
  ];
  if (scan.value.scanIncomplete) {
    boundaries.push(
      scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
    );
  }

  const completeness: TrustSummary['completeness'] = scan.value.scanIncomplete
    ? { status: 'partial', missingCoverage: ['CustomField (scan capped)'] }
    : { status: 'complete' };

  const trust: TrustSummary = {
    provenance: 'offline_snapshot',
    // Claim confidence is the WEAKEST grounding source across all findings: any
    // `parsed` source literal weakens the answer from the `declared` value set.
    confidence: totalFindingCount === 0 ? 'declared' : weakestConfidence(allWeakest),
    freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
    completeness,
    limitations: boundaries,
  };

  const isPaged = truncated || offset > 0;

  return ok({
    data: {
      fields: slice,
      scannedFieldCount: scan.value.nodes.length,
      picklistFieldCount: picklistFields.length,
      totalFieldCount: fieldFindings.length,
      totalFindingCount,
      byKind,
      boundaries,
      truncated,
      trust,
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + slice.length } : {}),
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
