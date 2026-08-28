/**
 * The shared "we did not check this, so do not read the empty value as a zero"
 * disclosures.
 *
 * ## Why this exists
 *
 * This product's central promise is that an absence in the answer is
 * distinguishable from an absence in the org. Two different absences keep
 * recurring across the permissions family, and each had grown its own bespoke
 * wording:
 *
 *   1. **A whole metadata FAMILY was never extracted.** The vault was built by
 *      a refresh that predates the extractor, so every container reports the
 *      family as empty. `effective_permissions` reported
 *      `summary.customPermissions: 0` for 230 of 230 containers on a 0.1.11
 *      vault whose XML declares 100 real grants — a false `0` in a security
 *      tool, which is a missed grant, not a rounding error.
 *   2. **An individual grant TARGET is not a node in this vault.** The grant
 *      edge is declared and real; the component it names is managed-package or
 *      simply outside the retrieve scope. Emitting the id with no marker sends
 *      the admin to `resolve` / `get_component`, which dead-ends, and they
 *      conclude the VAULT is broken rather than that the component is external.
 *
 * ## Why it is centralised
 *
 * The text is built here, once, so the surfaces cannot drift apart as they are
 * edited independently — the same reasoning as
 * `declared-only-disclosure.ts`. Before this module there were five separate
 * wordings of case 1 in the tree (`effective-permissions.ts`,
 * `what-if-merge-profiles.ts`, `app-access.ts` ×2, `tab-availability.ts`),
 * which is how three of them ended up describing families their tool no longer
 * checked. **A tool that starts handling the case should DELETE its call, not
 * reword it.**
 *
 * ## The sentinel, not the array length
 *
 * Case 1 is decided by {@link familyWasExtracted} — whether the node carries
 * the property AT ALL — never by whether the array is empty. A container with
 * `customPermissionGrantCount: 0` was CHECKED and holds none; a container with
 * no such key was never checked. Those two must never render the same, which
 * is the entire finding.
 *
 * Case 2 is decided by {@link edgeTargetMissing} — the marker
 * `edgeRowParams()` (`packages/graph/src/import.ts`) stamps against the FINAL
 * node set on both the cold-import and the incremental `applyChangeSet` path.
 * Reading the marker costs nothing; resolving each target with `getNodeById`
 * would cost thousands of graph round-trips on a wide bundle.
 */

import type { Edge } from '@sf-intelligence/contracts';

/**
 * How many container ids the family sentence enumerates before it summarises
 * the rest. A 230-container bundle must not paste 230 ids into one sentence,
 * and every caller must truncate the SAME way or the two disclosures on one
 * response disagree about how long a list is allowed to be.
 */
const MAX_ENUMERATED_CONTAINERS = 10;

/** Per-surface inputs for {@link notExtractedFamilyDisclosure}. */
export interface NotExtractedFamilyOptions {
  /** Sentence subject, capitalised, e.g. 'Custom permissions', 'Tab visibility'. */
  readonly subject: string;
  /** 'checked' | 'compared' — the verb the host tool uses for its own work. */
  readonly verb: string;
  /**
   * Number agreement for the copula: `false`/omitted renders "was", `true`
   * renders "were".
   *
   * Not cosmetic. The two pinned contract sentences disagree on it —
   * "Tab visibility was NOT compared" (singular subject) and "Custom
   * permissions were NOT checked" (plural) — and no single hardcoded copula
   * renders both. English number is a property of the SUBJECT, so it is
   * declared next to the subject rather than inferred from its spelling.
   */
  readonly pluralSubject?: boolean;
  /** The node property that is ALWAYS written when the family WAS extracted. */
  readonly sentinelProperty: string;
  /** Container ids missing it (sorted by the caller; may be a single id). */
  readonly containers: readonly string[];
  /** The output field(s) that go silent, in backticks. */
  readonly surface: string;
  /** How a naive reader would MISREAD the empty value, e.g. '"no custom permissions"'. */
  readonly zeroReading: string;
}

/**
 * Build the "this metadata family was never extracted" sentence.
 *
 * The template is fixed so that `{ subject: 'Tab visibility', verb: 'compared' }`
 * renders a string beginning `Tab visibility was NOT compared` — the substring
 * `what-if-merge-profiles.test.ts` has pinned since the tab-visibility
 * consumer bug. Treat that pin as this template's acceptance test.
 *
 * @example
 *   disclosures.unshift(notExtractedFamilyDisclosure({
 *     subject: 'Custom permissions',
 *     verb: 'checked',
 *     pluralSubject: true,
 *     sentinelProperty: 'customPermissionGrantCount',
 *     containers: [...ids].sort(),
 *     surface: '`customPermissions` / `summary.customPermissions`',
 *     zeroReading: '"no custom permissions"',
 *   }));
 */
export const notExtractedFamilyDisclosure = (
  options: NotExtractedFamilyOptions,
): string => {
  const { containers } = options;
  const shown = containers.slice(0, MAX_ENUMERATED_CONTAINERS);
  const rest = containers.length - shown.length;
  const ids = rest > 0 ? `${shown.join(', ')}, … and ${rest} more` : shown.join(', ');
  const wasWere = options.pluralSubject === true ? 'were' : 'was';
  return (
    `${options.subject} ${wasWere} NOT ${options.verb} — ${containers.length} container(s) carry no ` +
    `extracted \`${options.sentinelProperty}\` property (${ids}); this vault's refresh predates ` +
    `${options.subject} extraction, so ${options.surface} is "not modeled", NEVER a verified ` +
    `${options.zeroReading}. Re-run \`/sfi-refresh\`.`
  );
};

/**
 * True when the node was built by a refresh that DID emit this family.
 *
 * Deliberately `hasOwnProperty`, not truthiness and not `!== undefined`: the
 * CHECKED-zero case writes `0` / `[]` / `false`, all of which are falsy and all
 * of which are real answers.
 */
export const familyWasExtracted = (
  props: Readonly<Record<string, unknown>>,
  sentinelProperty: string,
): boolean => Object.prototype.hasOwnProperty.call(props, sentinelProperty);

/**
 * The importer's phantom marker: this edge's target resolves to no node in the
 * final node set. Stamped by `edgeRowParams()` on every import path, so it is
 * present on vaults built by any version carrying that function — the 0.1.11
 * era included — and needs no graph round-trip to read.
 */
export const edgeTargetMissing = (e: Edge): boolean =>
  e.properties['targetMissing'] === true;

/** Per-surface inputs for {@link unresolvedTargetsDisclosure}. */
export interface UnresolvedTargetsOptions {
  readonly count: number;
  /** Singular noun for the target family, e.g. 'Flow', 'object'. */
  readonly targetKind: string;
  /**
   * The output list carrying the marked rows, in backticks.
   *
   * CURRENTLY UNREFERENCED: the contract sentence below is fixed product copy
   * and does not interpolate this value — it says "grant(s) above", which is
   * true in both the `boundaryNote` and the `disclosures` rendering. The field
   * is reserved in the interface signature so that a future version can
   * interpolate the surface name without changing every call site. Every caller
   * currently supplies this value correctly, but it is read by no code.
   */
  readonly surface: string;
  /**
   * Singular noun for the RELATIONSHIP being disclosed. Defaults to `'grant'`,
   * which is where this module was extracted from.
   *
   * It exists because the sentence used to hardcode that noun, and the module
   * then spread beyond permissions: `downstream-effects.ts` renders
   * "effect-edge grant(s)", and `what-if-deactivate-flow.ts` would have rendered
   * "impact-edge grant(s)" — a permissions word applied to an impact edge, in
   * copy whose whole job is to be precise about what is and is not known. The
   * caller that hit it correctly refused to reword locally, because a fourth
   * spelling of a shared sentence is the drift this module exists to prevent.
   * Parameterising the noun is the fix; every existing call site renders
   * byte-identically.
   */
  readonly targetNoun?: string;
}

/**
 * Build the "this individual target is not in the vault" sentence.
 *
 * The relationship noun defaults to `'grant'` (this module's birthplace) and is
 * overridable via {@link UnresolvedTargetsOptions.targetNoun} — see that field
 * for why.
 *
 * Callers PUSH this (they do not unshift it): it is a follow-the-id caveat,
 * not an over- or under-statement of access, so it must not displace a muting
 * warning from the front of a disclosures array.
 */
export const unresolvedTargetsDisclosure = (
  options: UnresolvedTargetsOptions,
): string =>
  `${options.count} ${options.targetKind} ${options.targetNoun ?? 'grant'}(s) above name a component that is NOT in this ` +
  'vault (`targetMissing`) — a managed-package component, or one this refresh did not retrieve. ' +
  'The GRANT is declared and real; the TARGET is not resolvable here, so `resolve` / ' +
  '`get_component` on that id returns component-not-found. Each affected row carries ' +
  '`targetMissing: true`.';
