/**
 * Field-level classifiers for the value-change-impact tier (the Data
 * Steward / Identity & Integration persona).
 *
 * **Why this exists.** The `what_if_*` schema-change tools answer "what
 * REFERENCES this field?" — the blast radius of a type/required/delete
 * change. The value-change tools answer a different question: "what breaks
 * if the stored VALUE changes?" That blast radius can be catastrophic on a
 * field with *zero* references (e.g. a SAML federation key: nothing in
 * metadata references it, but changing its value desyncs SSO login). So
 * value-change impact needs a model built from the field's own intrinsic
 * role — identity binding, upsert/match key, uniqueness — not just the
 * reference graph.
 *
 * These are **pure** classifiers over a CustomField `Node`'s properties —
 * no graph traversal — so they are cheap, deterministic, and unit-testable
 * against real field shapes. `what_if_change_field_value` and
 * `value_change_audit` compose over them.
 *
 * Three independent axes:
 *   - **mutability** — can the value even be changed directly? Formula /
 *     roll-up-summary / auto-number / system-audit fields are DERIVED;
 *     the question re-routes to their source.
 *   - **upsert key** — is this an integration/upsert key? Per Salesforce, a
 *     field with `externalId`, `unique`, or `idLookup` = true is usable in
 *     an upsert. The first two live in the field metadata (per-instance!);
 *     `idLookup` is a curated standard-field list (not in the XML).
 *     A node that does not CARRY `externalId`/`unique` was never checked
 *     for them (describe-synthesized standard fields carry neither) — that
 *     reports as `unverifiedSignals`, never as a checked `false`.
 *   - **identity role** — does the value carry login/identity/match
 *     meaning? Seeded from a standard-field catalog + the upsert signal + a
 *     conservative name lexicon (weak prior only).
 *
 * **Empirical grounding** (a real SSO-connected org):
 * the same field NAME carries different `externalId` flags on different
 * objects (`External_Record_ID__c` is a key on Account/Contact/Lead
 * but a denormalized shadow copy elsewhere), and key-NAMED fields are
 * sometimes formulas (`Partner_ID__c` = `Pay_To__r.Partner_ID__c`). So
 * name-based detection without the mutability + per-instance flag gates
 * produces nonsense — these gates exist for exactly that reason.
 */

import type { Node } from '@sf-intelligence/contracts';

import { familyWasExtracted } from './absence-disclosure.js';
import { readFieldDataType } from './field-properties.js';

/** Canonical id prefix for CustomField nodes. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Severity scale for a value change. Default-to-higher when uncertain. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** How sure we are the role/severity applies. */
export type Confidence = 'confirmed' | 'likely' | 'potential';

const SEV_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** `{ object, field }` parsed from a `CustomField:{Object}.{Field}` id. */
export interface ParsedFieldId {
  readonly object: string;
  readonly field: string;
}

/**
 * Split a CustomField id into its object + field parts. Splits on the
 * FIRST `.` after the prefix: the object may be a custom object
 * (`XREF_Academic_Program__c`, no dot) and the field may be namespaced
 * (`Q9__Federation_Email__c`, no dot) — neither contains a `.`. Returns
 * `null` for a non-CustomField id or one missing the `.`.
 */
export const parseFieldId = (id: string): ParsedFieldId | null => {
  if (!id.startsWith(CUSTOM_FIELD_PREFIX)) return null;
  const rest = id.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  return { object: rest.slice(0, dot), field: rest.slice(dot + 1) };
};

/** Leaf field name from an apiName that may be `Object.Field` or `Field`. */
const leafName = (apiName: string): string => {
  const i = apiName.lastIndexOf('.');
  return i >= 0 ? apiName.slice(i + 1) : apiName;
};

// ---------------------------------------------------------------------------
// Axis 1 — mutability
// ---------------------------------------------------------------------------

export type Mutability = 'writable' | 'derived';

export interface MutabilityResult {
  readonly mutability: Mutability;
  readonly reason: string;
  /** Present only for formula fields: the raw formula expression. */
  readonly sourceFormula?: string;
}

/** Data types whose values are system-computed, never directly written. */
const DERIVED_DATA_TYPES: ReadonlySet<string> = new Set(['Summary', 'AutoNumber']);

/** Standard system-audit fields that are not user-writable. */
const SYSTEM_AUDIT_FIELDS: ReadonlySet<string> = new Set([
  'Id',
  'IsDeleted',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
  'LastActivityDate',
  'LastViewedDate',
  'LastReferencedDate',
]);

/**
 * Classify whether a field's value can be changed directly. A `derived`
 * verdict means "you can't edit this value — re-route to its source"; the
 * value-change tools must not analyze a derived field as if it were
 * editable. Formula is detected from `properties.formula` (the extractor's
 * canonical key); roll-up / auto-number from the data type; audit fields by
 * name.
 */
export const classifyMutability = (node: Node, fieldName?: string): MutabilityResult => {
  const formula = node.properties['formula'];
  if (typeof formula === 'string' && formula.trim() !== '') {
    const expr = formula.trim();
    return {
      mutability: 'derived',
      reason: `Formula field — value is computed from \`${expr}\`. Change the source field(s), not this one.`,
      sourceFormula: expr,
    };
  }
  const dataType = readFieldDataType(node);
  if (DERIVED_DATA_TYPES.has(dataType)) {
    return {
      mutability: 'derived',
      reason: `${dataType} field — value is system-computed, not directly editable.`,
    };
  }
  const name = fieldName ?? leafName(node.apiName);
  if (SYSTEM_AUDIT_FIELDS.has(name)) {
    return {
      mutability: 'derived',
      reason: `${name} is a system audit field — not user-writable.`,
    };
  }
  return { mutability: 'writable', reason: 'Directly editable field.' };
};

// ---------------------------------------------------------------------------
// Axis 2 — upsert / integration key
// ---------------------------------------------------------------------------

export type UpsertSignal = 'externalId' | 'unique' | 'idLookup';

export interface UpsertKeyResult {
  readonly isUpsertKey: boolean;
  readonly signals: readonly UpsertSignal[];
  /**
   * The per-instance metadata flags this node does not CARRY, so they were
   * never checked — NOT flags that were checked and came back `false`.
   *
   * `packages/extractors/src/custom-field.ts` writes `unique` and
   * `externalId` as fixed keys (`toBooleanWithDefault`), so a DX-extracted
   * field always carries both and a `false` there is a real answer.
   * `packages/extractors/src/standard-object-describe-fields.ts`
   * (`describePropertiesFromRow`) writes NEITHER, so every
   * describe-synthesized standard-object field (`provenance:
   * 'org-describe-snapshot'`) arrives with both ABSENT. Reading absence as
   * `false` turns "we never looked" into "we looked and it is not a key",
   * which is the one verdict this module must never produce.
   */
  readonly unverifiedSignals: readonly UpsertSignal[];
}

/**
 * The upsert signals that live in the field's own metadata, i.e. the ones a
 * node can be MISSING. `idLookup` is not here: it comes from the curated
 * {@link STANDARD_IDLOOKUP} list, so it is answerable for every node
 * regardless of what the extractor wrote.
 */
const METADATA_UPSERT_SIGNALS = ['externalId', 'unique'] as const satisfies readonly UpsertSignal[];

/**
 * Curated standard `idLookup` fields (upsert-targetable but NOT marked in
 * field-meta.xml). Conservative: only high-confidence entries. `'*'` =
 * every object. Expand deliberately — over-claiming here produces false
 * "confirmed key" verdicts.
 */
const STANDARD_IDLOOKUP: Record<string, ReadonlySet<string>> = {
  '*': new Set(['Id']),
  User: new Set(['Username', 'FederationIdentifier']),
};

/**
 * Classify a field as an upsert/integration key from the Salesforce-defined
 * signals: `externalId` or `unique` (read from metadata, per field
 * instance) or `idLookup` (curated list). Any one makes the field usable as
 * an upsert match key — so a value change can break inbound sync (no-match →
 * duplicate / error) or a uniqueness save.
 */
export const classifyUpsertKey = (
  node: Node,
  object: string,
  fieldName: string,
): UpsertKeyResult => {
  const signals: UpsertSignal[] = [];
  const unverifiedSignals: UpsertSignal[] = [];
  for (const flag of METADATA_UPSERT_SIGNALS) {
    // R1: `hasOwnProperty`, never truthiness — `externalId: false` is a real
    // answer, an absent `externalId` is no answer at all.
    if (!familyWasExtracted(node.properties, flag)) {
      unverifiedSignals.push(flag);
      continue;
    }
    if (node.properties[flag] === true) signals.push(flag);
  }
  const idLookup =
    (STANDARD_IDLOOKUP[object]?.has(fieldName) ?? false) ||
    (STANDARD_IDLOOKUP['*']?.has(fieldName) ?? false);
  if (idLookup) signals.push('idLookup');
  return { isUpsertKey: signals.length > 0, signals, unverifiedSignals };
};

// ---------------------------------------------------------------------------
// Axis 3 — identity role
// ---------------------------------------------------------------------------

export interface RoleResult {
  readonly role: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly signals: readonly string[];
}

interface CatalogEntry {
  readonly role: string;
  readonly severity: Severity;
}

/**
 * Standard-identity-field catalog — known a-priori semantics for a small
 * set of standard fields. Keyed by `Object.Field`. This is the
 * high-confidence supplement, NOT the detection mechanism (custom/
 * integration keys are detected by flags + lexicon). FederationIdentifier
 * is seeded `high`/`likely`; a later phase gates it on `SamlSsoConfig`
 * (critical when SSO uses it, low when no SAML config exists).
 */
const IDENTITY_CATALOG: Record<string, CatalogEntry> = {
  'User.Username': { role: 'Login identity (global-unique)', severity: 'critical' },
  'User.FederationIdentifier': { role: 'SSO / SAML federation subject', severity: 'high' },
  'User.EmployeeNumber': { role: 'Employee number — common HRIS integration key', severity: 'high' },
  'User.CommunityNickname': { role: 'Experience Cloud display (org-unique)', severity: 'medium' },
  'User.Alias': { role: 'Short display name', severity: 'low' },
  'User.Email': { role: 'User email — login & notifications', severity: 'high' },
  'Contact.Email': { role: 'Contact email / common match key', severity: 'medium' },
};

/**
 * Expose the identity-catalog entry for `(object, field)`, or `null`. Used
 * by the value-change risk model (bucket A — identity) so it does not
 * re-implement the catalog.
 */
export const lookupIdentityCatalog = (
  object: string,
  field: string,
): { readonly role: string; readonly severity: Severity } | null =>
  IDENTITY_CATALOG[`${object}.${field}`] ?? null;

/** Rank a severity for max-merging. Exposed for the risk model. */
export const severityRank = (s: Severity): number => SEV_RANK[s];

/** Return the higher of two severities. */
export const maxSeverity = (a: Severity, b: Severity): Severity =>
  SEV_RANK[a] >= SEV_RANK[b] ? a : b;

interface LexiconRule {
  readonly test: RegExp;
  readonly role: string;
  readonly severity: Severity;
}

/**
 * Name lexicon — a WEAK prior only. A name match alone is `potential`
 * confidence; it never upgrades a field to confirmed. Tuned to the patterns
 * actually present in real orgs (SIS keys, martech keys, UUIDs, federation).
 */
const NAME_LEXICON: readonly LexiconRule[] = [
  { test: /(_SIS_ID|SIS_?Key|Comment_SIS_ID)__c$/i, role: 'SIS integration key (name pattern)', severity: 'high' },
  { test: /(Marketo|Sparkroom|Pardot)/i, role: 'Marketing-platform key (name pattern)', severity: 'medium' },
  { test: /(_uuid|_guid)__c$/i, role: 'External UUID/GUID key (name pattern)', severity: 'medium' },
  { test: /Federation/i, role: 'Federation / SSO identity (name pattern)', severity: 'high' },
];

interface Candidate {
  readonly role: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly signal: string;
}

const CONF_RANK: Record<Confidence, number> = { potential: 0, likely: 1, confirmed: 2 };

/**
 * The signal sentence for {@link UpsertKeyResult.unverifiedSignals}: the
 * per-instance key flags this node never carried.
 *
 * Deliberately NOT `notExtractedFamilyDisclosure()`: that shared sentence
 * ends "this vault's refresh predates X extraction … Re-run `/sfi-refresh`",
 * and a re-refresh does NOT fix this case — a describe-synthesized standard
 * field has no `field-meta.xml` in the retrieve to read the flags from, so
 * the remedy clause would be a false promise. The shared PREDICATE
 * (`familyWasExtracted`) is what decides the case; only the copy is local.
 */
const unverifiedFlagsSignal = (unverified: readonly UpsertSignal[]): string =>
  `upsert-key flags NOT extracted (${unverified.join(', ')}) — this field node carries no such ` +
  `property (describe-synthesized standard field), so "not an upsert key" here is UNCHECKED, ` +
  `never a verified negative. Confirm in Setup before mass-updating the value.`;

/**
 * Classify a field's identity/integration role by merging three signals:
 * the standard-field catalog (likely→confirmed when corroborated), the
 * upsert-key flags (confirmed, metadata-derived), and the name lexicon
 * (potential). Derived fields short-circuit to a low, can't-change-this
 * verdict. The headline role is the highest-severity candidate (ties broken
 * by confidence); all signals are surfaced.
 */
export const classifyRole = (
  upsert: UpsertKeyResult,
  mutability: MutabilityResult,
  object: string,
  fieldName: string,
): RoleResult => {
  if (mutability.mutability === 'derived') {
    return {
      role: 'Derived / computed — value not directly changeable',
      severity: 'low',
      confidence: 'confirmed',
      signals: [mutability.reason],
    };
  }

  const candidates: Candidate[] = [];

  const catalog = IDENTITY_CATALOG[`${object}.${fieldName}`];
  if (catalog !== undefined) {
    candidates.push({
      role: catalog.role,
      severity: catalog.severity,
      // Corroborated by an upsert flag → confirmed; otherwise a known but
      // org-config-dependent default → likely.
      confidence: upsert.isUpsertKey ? 'confirmed' : 'likely',
      signal: 'standard-identity-field catalog',
    });
  }

  if (upsert.isUpsertKey) {
    candidates.push({
      role: 'Integration / upsert key',
      severity: 'high',
      confidence: 'confirmed',
      signal: `upsert key (${upsert.signals.join(' + ')})`,
    });
  }

  const lex = NAME_LEXICON.find((r) => r.test.test(fieldName));
  if (lex !== undefined) {
    candidates.push({
      role: lex.role,
      severity: lex.severity,
      confidence: 'potential',
      signal: 'name pattern',
    });
  }

  if (candidates.length === 0) {
    // R1: the fallthrough is only CONFIRMED when every metadata flag that
    // could have contradicted it was actually read. With the flags absent the
    // low/`Standard editable field` verdict is a guess, and stamping it
    // `confirmed` is exactly how a genuine integration key gets mass-updated.
    if (upsert.unverifiedSignals.length > 0) {
      return {
        role: 'Standard editable field (upsert-key flags NOT extracted — unverified)',
        severity: 'low',
        confidence: 'potential',
        signals: [unverifiedFlagsSignal(upsert.unverifiedSignals)],
      };
    }
    return {
      role: 'Standard editable field',
      severity: 'low',
      confidence: 'confirmed',
      signals: [],
    };
  }

  const top = candidates.reduce((best, c) => {
    if (SEV_RANK[c.severity] !== SEV_RANK[best.severity]) {
      return SEV_RANK[c.severity] > SEV_RANK[best.severity] ? c : best;
    }
    return CONF_RANK[c.confidence] > CONF_RANK[best.confidence] ? c : best;
  });

  return {
    role: top.role,
    severity: top.severity,
    confidence: top.confidence,
    // The unchecked-flag note rides along even when another signal fired: a
    // `likely` catalog verdict on a describe-synthesized field is `likely`
    // BECAUSE the flags that would corroborate it were never read, and the
    // reader cannot tell that from the confidence word alone.
    signals: [
      ...candidates.map((c) => c.signal),
      ...(upsert.unverifiedSignals.length > 0
        ? [unverifiedFlagsSignal(upsert.unverifiedSignals)]
        : []),
    ],
  };
};

// ---------------------------------------------------------------------------
// Combined classification
// ---------------------------------------------------------------------------

export interface FieldClassification {
  readonly fieldId: string;
  readonly object: string;
  readonly field: string;
  readonly mutability: MutabilityResult;
  readonly upsertKey: UpsertKeyResult;
  readonly role: RoleResult;
}

/**
 * Run all three axes for one CustomField node. Convenience wrapper the
 * tools call once per field. `object`/`field` are derived from the node id
 * when parseable, else from the apiName.
 */
export const classifyField = (node: Node): FieldClassification => {
  const parsed = parseFieldId(node.id);
  const object = parsed?.object ?? '';
  const field = parsed?.field ?? leafName(node.apiName);
  const mutability = classifyMutability(node, field);
  const upsertKey = classifyUpsertKey(node, object, field);
  const role = classifyRole(upsertKey, mutability, object, field);
  return { fieldId: node.id, object, field, mutability, upsertKey, role };
};
