/**
 * Handler for the `sfi.explain_field` MCP tool.
 *
 * The second of two v1.6 business-user-tier headline tools (per
 * PLAN-v1.6 §4): given a CustomField canonical id, return the field's
 * label, description, inline help text, type, required flag, — for
 * formula fields — the formula expression (a non-null `formula` flags the
 * field as a read-only computed value, not a writable one), — for
 * lookup / master-detail fields — the `referenceTo` target object the field
 * points at (a bare `type: "Lookup"` is useless without it), and — for
 * picklist-family fields — the declared `picklistValues` from the inline
 * value-set definition ("what values are in this picklist?"), with an
 * explicit `picklistValuesNote` when the value set is NOT inline (commonly
 * a GlobalValueSet reference) so `null` never reads as "no values". The inline help
 * text is the end-user-facing hover bubble and is often the only human
 * context when `description` is null. This is the metadata a business-user
 * needs to understand "what does this field mean?".
 * When the field's parent type is a CustomMetadataDeftnition
 * (`__mdt`), the tool additionally enumerates every
 * CustomMetadataRecord child of that parent and surfaces the value
 * each record holds for this field, giving the business-user a
 * literal "here's what this field is set to across records" answer in
 * one call.
 *
 * Implementation notes:
 *   - One `getNodeById(fieldId)` call resolves the field. The handler
 *     projects `node.properties` to the contract output shape —
 *     `label`, `description`, `type` (from `properties.dataType`),
 *     and `required`.
 *   - Input validation: `fieldId` must start with `CustomField:`. Any
 *     other prefix surfaces as `invalid-query` from the handler (not
 *     a Zod-level rejection — Zod cannot express the prefix
 *     constraint here). This mirrors the v1.5 `sfi.event_subscribers`
 *     convention of pinning input-axis prefixes at the handler
 *     boundary.
 *   - A field id with no node resolves to `component-not-found`, but the
 *     message is PHANTOM-AWARE: a standard or managed-package field that is
 *     referenced by other components (yet has no definition of its own in the
 *     vault) is disclosed as "referenced but not retrieved" rather than a flat
 *     "doesn't exist" (B12/B29). An id with no node and no references gets the
 *     plain "no CustomField with id" message.
 *   - **Case-insensitive resolution**: Salesforce api names are
 *     case-insensitive but canonical component ids are not, so a caller who
 *     types `CustomField:account.industry` names a real field. The exactly-cased
 *     id is tried FIRST (a correct call pays nothing); on a miss the object and
 *     field segments are folded against the vault's own casing. Exactly one
 *     match is answered, and the correction ships as the typed `resolvedFrom`
 *     plus the prose `resolutionNote` so the answer is never mistaken for one
 *     about the id the caller typed. Two matches differing only by case are
 *     REFUSED with both ids (`invalid-query`) — resolution is never IDENTITY.
 *     Zero matches fall through to the phantom-aware not-found above unchanged.
 *   - The `parent is __mdt` check uses the field's `parentId`
 *     (`CustomObject:{TypeApiName}`). If the type name ends with
 *     `__mdt`, the parent is a CustomMetadataDefinition and the
 *     recordValues enumeration kicks in (unless the caller passes
 *     `includeRecordValues: false`). For non-`__mdt` parents,
 *     `recordValues` is omitted from the output entirely — present-
 *     but-empty would be misleading (a non-`__mdt` parent has no
 *     CustomMetadataRecord children by definition).
 *   - **Honesty axis** (per PLAN-v1.6 §3): the tool does NOT fabricate
 *     records. Records that exist but lack a value for this specific
 *     field are omitted from the list — emitting `value: null` without
 *     context would conflate "no value set" with "the masked value is
 *     null", which is the wrong signal for a business-user trying to
 *     understand what a field is configured to.
 *   - **Typed absence (R1)**: an empty `recordValues` is only ever a
 *     VERIFIED zero. The three ways it can be empty no longer render
 *     identically. (a) Every record carries an extracted `values` array
 *     and none names this field → `recordValues: []` with NO note: a real
 *     "no record sets this field". (b) One or more records carry no
 *     `values` property AT ALL — a vault refreshed before the v1.6 R2
 *     record-values extractor, which always writes `values` (`[]` when the
 *     record declares none) — or carry one that is not an array →
 *     `recordValuesNote` names those record ids and says the values were
 *     NOT read. (c) The field node has no `parentId`, so there is no
 *     Custom Metadata Type to enumerate from → `recordValuesNote` says so.
 *     The decision is made by `familyWasExtracted` (does the node CARRY
 *     the property) — never by whether the array is empty, which is
 *     exactly what `absence-disclosure.ts` forbids.
 *   - Masked values are passed through verbatim per the lookup-record
 *     convention: `{ value: null, isMasked: true }` so the caller
 *     surfaces the masked status to the end user.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listChildren } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  familyWasExtracted,
  notExtractedFamilyDisclosure,
} from './absence-disclosure.js';
import { annotationsBlockFor, type AnnotationsBlock } from './annotations.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { objectIdCaseVariants, resolveFieldAlias } from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  normalizePicklistValues,
  resolveGlobalValueSetValues,
} from './picklist-values.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * The Custom Metadata Type suffix. Parent types whose ApiName ends
 * with `__mdt` are CustomMetadataDefinition objects; their children
 * are the CustomMetadataRecord nodes the v1.6 R2 extractor produces.
 */
const CUSTOM_METADATA_DEFINITION_SUFFIX = '__mdt';

/**
 * Zod schema for the `sfi.explain_field` tool input.
 *
 *   - `fieldId`: required, non-empty string. The canonical CustomField
 *     id (`CustomField:{ObjectApiName}.{FieldApiName}`). Invalid
 *     prefixes surface as `invalid-query` from the handler, not a
 *     Zod-level rejection — Zod cannot express the prefix constraint
 *     here.
 *   - `includeRecordValues`: optional boolean. Default behaviour is
 *     "true when the parent is `__mdt`, false otherwise" — explicit
 *     `true` keeps recordValues on even for non-`__mdt` parents
 *     (which yields an empty array since those parents have no
 *     CustomMetadataRecord children); explicit `false` suppresses
 *     recordValues even when the parent IS `__mdt`. Suppressing is
 *     useful when the caller only wants the field's intrinsic
 *     metadata and would otherwise pay the listChildren round-trip.
 */
export const explainFieldInputSchema = z
  .object({
    // Field identity: `fieldId` (canonical `CustomField:…` or `<Object>.<Field>`
    // short form) or the `componentId` alias a host reaches for (L2 Alias OS).
    fieldId: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    includeRecordValues: z.boolean().optional(),
  })
  .refine((i) => i.fieldId !== undefined || i.componentId !== undefined, {
    message: 'name the field — pass `fieldId` or `componentId` (e.g. "CustomField:Account.My_Field__c")',
    path: ['fieldId'],
  });

/** Parsed input shape, inferred from `explainFieldInputSchema`. */
export type ExplainFieldInput = z.infer<typeof explainFieldInputSchema>;

/**
 * One `(record, value)` tuple in the `recordValues` array. Mirrors the
 * shape `sfi.lookup_record` emits but trimmed to the cross-record
 * comparison axes — `recordId` to point back at the record, the
 * `recordLabel` for human-readable display, and the field's value /
 * masked status. `valueType` is intentionally omitted: the field's
 * top-level `type` already carries the answer for all non-masked
 * entries, and masked entries surface via `isMasked` directly.
 */
export interface ExplainFieldRecordValue {
  readonly recordId: ComponentId;
  readonly recordLabel: string;
  readonly value: unknown;
  readonly isMasked: boolean;
}

/**
 * One declared picklist value (H10). `isActive: false` marks a DEACTIVATED
 * value — retained but not selectable for new records; existing records may
 * still hold it. `label` / `default` carried when the source recorded them.
 */
export interface ExplainFieldPicklistValue {
  readonly value: string;
  readonly isActive: boolean;
  readonly label?: string;
  readonly default?: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ExplainFieldOutput {
  readonly fieldId: ComponentId;
  readonly label: string;
  readonly description: string | null;
  /**
   * The field's inline help text — the `?` hover bubble Salesforce shows to
   * END USERS in the UI — or `null`. This is often the most user-facing
   * "what does this field mean?" string the platform carries; when
   * `description` (the admin-facing note) is null it is frequently the ONLY
   * human context, so the field explainer must not drop it.
   */
  readonly inlineHelpText: string | null;
  readonly type: string;
  readonly required: boolean;
  /**
   * The formula expression when this is a FORMULA (computed) field, else
   * `null`. A non-null `formula` means the field is READ-ONLY / derived —
   * its `type` is the formula's RETURN type, not a stored, writable value.
   * Surfacing this stops a consumer from treating a computed field as an
   * editable one (and lets a renderer say "computed as: <expr>").
   */
  readonly formula: string | null;
  /**
   * For a Lookup / MasterDetail (relationship) field, the ApiName of the
   * object it points at (e.g. `hed__Course_Enrollment__c`); `null` for
   * non-relationship fields. `type` alone only says "Lookup" — `referenceTo`
   * is what the field actually POINTS TO, the defining fact a business-user
   * needs. `generate_data_dictionary` already surfaces this same node
   * property; the field explainer must not drop it.
   */
  readonly referenceTo: string | null;
  /**
   * The DECLARED value set for a Picklist / MultiselectPicklist field, as
   * the extractor recorded it from the field's inline
   * `<valueSet><valueSetDefinition>` — the literal answer to "what values
   * are in this picklist?" (P14-ROUTER-picklist-values). `null` for
   * non-picklist fields AND for picklists whose value set is not inline
   * (commonly a GlobalValueSet reference — the vault does not yet emit the
   * `usesValueSet` link, so the values are not reachable from the field
   * node; `picklistValuesNote` discloses that). An EMPTY array means an
   * inline definition with zero values — a real placeholder, not "unknown".
   *
   * H10: each entry carries `isActive`. An INACTIVE value is RETAINED but
   * NOT selectable for new records — existing records may still hold it — so
   * it is LISTED-and-marked, never dropped and never presented as current.
   * Old vaults (pre-CR-10) stored bare strings; those normalize to
   * `isActive: true` (active). GVS-resolved values carry the SAME honest
   * `isActive` as an inline definition (CR-10b — the GlobalValueSet
   * extractor now captures per-value activation status directly).
   */
  readonly picklistValues: readonly ExplainFieldPicklistValue[] | null;
  /**
   * Present ONLY when `picklistValues` was resolved by FOLLOWING the field's
   * `usesValueSet` edge to a GlobalValueSet (0.1.10+ vaults) — carries the
   * value set's canonical id so the consumer can cite where the values are
   * declared (P14-USAGE-gvs-edge). Absent for inline definitions.
   */
  readonly picklistValuesSource?: string;
  /**
   * Present when the field IS picklist-typed but `picklistValues` is `null`:
   * the value set was not inline at extraction time AND the usesValueSet edge
   * could not resolve it (pre-0.1.10 vault, or the GlobalValueSet was not
   * retrieved) — without this note a `null` would silently read as
   * "no values". Absent when the values WERE resolved from a GlobalValueSet
   * (`picklistValuesSource` set) — CR-10b: those now carry the same honest
   * `isActive` as an inline definition, so no disclosure is needed.
   */
  readonly picklistValuesNote?: string;
  readonly recordValues?: readonly ExplainFieldRecordValue[];
  /**
   * Present ONLY when `recordValues` is incomplete for a reason that is NOT
   * "the org sets no value" (R1 typed absence). Two causes: one or more
   * CustomMetadataRecord children carry no extracted `values` property (a
   * vault built before the v1.6 R2 record-values extractor, which ALWAYS
   * writes `values` — `[]` when the record declares none) or carry one that
   * is not an array; or the field node has no `parentId` so there is no
   * Custom Metadata Type to enumerate records from. Absent when every record
   * WAS read — an empty `recordValues` with no note is a verified zero.
   */
  readonly recordValuesNote?: string;
  /** P13-ANNOT-tools: curated annotations (provenance `annotation`); absent when none. */
  readonly annotations?: AnnotationsBlock;
  /**
   * The `fieldId` the CALLER passed, present ONLY when it differs from the
   * canonical `fieldId` above because the vault spells the same api name with
   * different CASE (Salesforce api names are case-insensitive; component ids
   * are not). Absent for an exactly-cased call.
   *
   * Typed on purpose: a machine consumer that reads `fieldId` alone would
   * otherwise never learn that the id it asked about is not the id it was
   * answered about. Always ships together with {@link resolutionNote}.
   */
  readonly resolvedFrom?: string;
  /**
   * Prose form of {@link resolvedFrom} for a host to read aloud — present and
   * absent on exactly the same calls. Never emitted without `resolvedFrom`.
   */
  readonly resolutionNote?: string;
}

/**
 * Pull the CustomField's `type` property. The custom-field extractor
 * stores the field's Salesforce dataType (e.g., `Text`, `Number`,
 * `Picklist`) under `properties.dataType`. Falls back to an empty
 * string for malformed inputs so the response shape stays stable.
 */
const readFieldType = (node: Node): string => {
  const raw = node.properties['dataType'];
  return typeof raw === 'string' ? raw : '';
};

/**
 * Pull the CustomField's `formula` property. The custom-field extractor
 * stores the formula expression under `properties.formula` for formula
 * fields and `null` for stored fields. Returns `null` for any non-string
 * or empty value so a non-null result reliably means "this is a read-only
 * computed field" — its `type` is the formula's return type, not a stored
 * value.
 */
const readFieldFormula = (node: Node): string | null => {
  const raw = node.properties['formula'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * Pull the CustomField's `referenceTo` property — the ApiName of the object a
 * Lookup / MasterDetail field points at (e.g. `hed__Course_Enrollment__c`).
 * The custom-field extractor stores it under `properties.referenceTo` and
 * `null` for non-relationship fields. Returns `null` for any non-string or
 * empty value so a non-null result reliably means "this field points to
 * <object>" — for a relationship field that target is the single most
 * important fact answering "what does this field mean?".
 */
const readFieldReferenceTo = (node: Node): string | null => {
  const raw = node.properties['referenceTo'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * The picklist-family dataTypes whose declared value set the custom-field
 * extractor records under `properties.picklistValues`. Mirrors the
 * extractor's PICKLIST_TYPES gate — for every other dataType the property
 * is `null` by construction.
 */
const PICKLIST_DATA_TYPES: readonly string[] = ['Picklist', 'MultiselectPicklist'];

/**
 * Disclosure for a picklist-typed field whose `picklistValues` is `null`:
 * the value set was not inline in the field's metadata (commonly a
 * GlobalValueSet reference), so the declared values live on another
 * component the field node does not yet link to.
 */
const NON_INLINE_VALUE_SET_NOTE =
  'This field is picklist-typed but its value set was not inline in the field metadata — ' +
  'commonly a GlobalValueSet reference. The declared values live on that GlobalValueSet ' +
  'component, and this vault carries no resolvable usesValueSet link (vaults refreshed at ' +
  '0.1.10+ resolve it automatically); `null` here means "not inline", NOT "no values".';

/**
 * Pull the CustomField's `picklistValues` property — the declared value set
 * the extractor parsed from an inline `<valueSet><valueSetDefinition>`.
 * Routes through the shared H10 normalizer so BOTH the legacy bare-string
 * shape (pre-CR-10 vaults; each string ⇒ an active value) and the new object
 * shape `{value,isActive,label?,default?}` are read — the old
 * `typeof === 'string'` filter silently dropped object entries, reporting zero
 * values on a re-extracted vault. An empty array is a real zero-value inline
 * definition; `null` for any non-array shape — non-picklist fields and
 * non-inline (GlobalValueSet-driven) picklists both land here.
 */
const readFieldPicklistValues = (node: Node): readonly ExplainFieldPicklistValue[] | null => {
  const normalized = normalizePicklistValues(node.properties['picklistValues']);
  if (normalized === null) return null;
  return normalized.map((entry) => ({
    value: entry.value,
    isActive: entry.isActive,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.default !== undefined ? { default: entry.default } : {}),
  }));
};

/**
 * Pull the CustomField's `description` property. The extractor stores
 * `null` when the field has no description, a non-empty string
 * otherwise. Returns `null` for any non-string shape so the contract
 * surface stays honest.
 */
const readFieldDescription = (node: Node): string | null => {
  const raw = node.properties['description'];
  return typeof raw === 'string' ? raw : null;
};

/**
 * Pull the CustomField's `inlineHelpText` property — the UI hover-help
 * string shown to end users. Returns `null` for any non-string or empty
 * value, so a non-null result is meaningful help text (an empty help string
 * is "no help", not "" ).
 */
const readFieldInlineHelpText = (node: Node): string | null => {
  const raw = node.properties['inlineHelpText'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * Pull the CustomField's `required` property. The extractor stores a
 * boolean; falls back to `false` for any non-boolean shape since the
 * v1.0 schema's `required` element defaults to `false` when absent.
 */
const readFieldRequired = (node: Node): boolean => {
  const raw = node.properties['required'];
  return raw === true;
};

/**
 * Pull the CustomField's `label` property. The extractor stores the
 * label as a non-empty string; falls back to the node's top-level
 * `label` field (also written by the extractor) and finally to an
 * empty string so the response shape stays stable.
 */
const readFieldLabel = (node: Node): string => {
  const raw = node.properties['label'];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (node.label !== null) return node.label;
  return '';
};

/**
 * Pull the parent type's ApiName from the field's `parentId`
 * (`CustomObject:{TypeApiName}`). Returns the empty string for
 * malformed parents — the caller treats that as "not `__mdt`" since
 * the empty string does not end in the suffix.
 */
const parentTypeApiName = (node: Node): string => {
  if (node.parentId === null) return '';
  const colonIdx = node.parentId.indexOf(':');
  if (colonIdx < 0) return '';
  return node.parentId.slice(colonIdx + 1);
};

/**
 * Decide whether the recordValues axis should be included. The caller
 * can opt in / out explicitly via `includeRecordValues`; the default
 * is true for `__mdt` parents and false for everything else.
 */
const shouldIncludeRecordValues = (
  parentType: string,
  flag: boolean | undefined,
): boolean => {
  if (flag === false) return false;
  if (flag === true) return true;
  return parentType.endsWith(CUSTOM_METADATA_DEFINITION_SUFFIX);
};

/**
 * Pull the CustomField's API name from the canonical id. The
 * extractor stores the field's bare apiName (without the parent
 * object prefix); the canonical id stores `Object.Field`. Either
 * lookup yields the same value, but the apiName on the node is
 * authoritative.
 */
const readFieldApiName = (node: Node): string => node.apiName;

/**
 * The CustomMetadataRecord node property that says the record-values family
 * WAS extracted. `packages/extractors/src/custom-metadata-record.ts` writes it
 * unconditionally (alongside `valuesCount`), `[]` included, so a node that
 * does not CARRY it was built by a refresh predating that extractor.
 */
const RECORD_VALUES_SENTINEL = 'values';

/**
 * How readable one record's value list turned out to be. R1: the three states
 * are kept apart at the point of reading so the caller cannot collapse
 * NEVER-SCANNED into SCANNED-AND-CLEAN downstream.
 */
type RecordValuesReadState = 'not-extracted' | 'unreadable' | 'read';

/**
 * Read one CustomMetadataRecord's `values` list, reporting WHY it is
 * unusable when it is.
 *
 *   - no sentinel property → never extracted (the R1 law: the node not
 *     CARRYING the property, not an empty array, is what says "not checked");
 *   - sentinel present but not an array → a corrupt vault entry. The
 *     extractor guarantees an array, so a non-array is unreadable and
 *     contributes nothing — a blind spot, never a silent skip.
 *
 * An extracted, EMPTY array is a real answer and comes back as `read`.
 */
const readRecordValueEntries = (
  props: Readonly<Record<string, unknown>>,
): { readonly state: RecordValuesReadState; readonly entries: readonly unknown[] } => {
  if (!familyWasExtracted(props, RECORD_VALUES_SENTINEL)) {
    return { state: 'not-extracted', entries: [] };
  }
  const raw = props[RECORD_VALUES_SENTINEL];
  if (!Array.isArray(raw)) return { state: 'unreadable', entries: [] };
  return { state: 'read', entries: raw as readonly unknown[] };
};

/**
 * Pull one record's value for a given field name out of an ALREADY-READ
 * `values` list. Returns `null` when the list has no matching entry for the
 * field — the v1.6 R2 extractor only emits an entry when the record's XML
 * carries one, so a missing entry semantically means "no value set" and is
 * omitted from the cross-record list (per the honesty-axis design in this
 * module's JSDoc). Callers must route through {@link readRecordValueEntries}
 * so a `null` here can only ever mean "read, and this record sets nothing" —
 * never "we could not look".
 */
const findValueForField = (
  entries: readonly unknown[],
  fieldApiName: string,
): { value: unknown; isMasked: boolean } | null => {
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    if (obj['field'] === fieldApiName) {
      const value = obj['value'] === undefined ? null : obj['value'];
      const isMasked = obj['isMasked'] === true;
      return { value, isMasked };
    }
  }
  return null;
};

/**
 * Deterministic comparator: `recordId` ASC. Two records with the same
 * id collapse to a single entry upstream (the graph enforces id
 * uniqueness), so the comparator does not need a secondary tiebreaker.
 */
const compareRecordValues = (
  a: ExplainFieldRecordValue,
  b: ExplainFieldRecordValue,
): number => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);

/**
 * What one `__mdt` parent's record sweep produced: the rows that were read,
 * plus the record ids whose values could NOT be read at all. The second half
 * is what stops an empty `rows` from reading as a verified zero.
 */
interface CollectedRecordValues {
  readonly rows: readonly ExplainFieldRecordValue[];
  /** Records carrying no `values` property — a pre-v1.6 refresh. */
  readonly notExtracted: readonly string[];
  /** Records whose `values` is present but not an array — corrupt. */
  readonly unreadable: readonly string[];
}

/**
 * Enumerate every CustomMetadataRecord child of the parent
 * `__mdt` type and project each one's matching field value into the
 * `ExplainFieldRecordValue` shape. Records without a value for the
 * field are omitted (per the honesty axis); records whose value list could
 * not be READ are collected separately so the caller can disclose them
 * instead of letting them vanish. Sort: `recordId` ASC.
 */
const collectRecordValues = async (
  ctx: Context,
  parentId: ComponentId,
  fieldApiName: string,
): Promise<Result<CollectedRecordValues, string>> => {
  const childrenResult = await listChildren(ctx.graph, parentId);
  if (!childrenResult.ok) {
    return err(childrenResult.error.message);
  }
  const out: ExplainFieldRecordValue[] = [];
  const notExtracted: string[] = [];
  const unreadable: string[] = [];
  for (const child of childrenResult.value) {
    if (child.type !== 'CustomMetadataRecord') continue;
    const read = readRecordValueEntries(child.properties);
    if (read.state === 'not-extracted') {
      notExtracted.push(child.id);
      continue;
    }
    if (read.state === 'unreadable') {
      unreadable.push(child.id);
      continue;
    }
    const match = findValueForField(read.entries, fieldApiName);
    if (match === null) continue;
    const recordLabelRaw = child.properties['label'];
    const recordLabel =
      typeof recordLabelRaw === 'string'
        ? recordLabelRaw
        : child.label !== null
          ? child.label
          : '';
    out.push({
      recordId: child.id,
      recordLabel,
      value: match.value,
      isMasked: match.isMasked,
    });
  }
  return ok({
    rows: out.sort(compareRecordValues),
    notExtracted: notExtracted.sort(),
    unreadable: unreadable.sort(),
  });
};

/**
 * The ONE place the record-values blind spot is worded (R6). The
 * never-extracted half is built from the shared `notExtractedFamilyDisclosure`
 * template so it cannot drift from the rest of the tree; the corrupt half gets
 * its own clause because "carries no extracted `values` property" would be a
 * false statement about a record that carries a malformed one.
 *
 * Returns `undefined` when every record was read — an empty `recordValues`
 * with no note is a VERIFIED "no record sets this field", and hedging that
 * would be as dishonest as hiding the blind spot.
 */
const recordValuesBlindSpotNote = (
  collected: CollectedRecordValues,
): string | undefined => {
  const parts: string[] = [];
  if (collected.notExtracted.length > 0) {
    parts.push(
      notExtractedFamilyDisclosure({
        subject: 'Custom metadata record values',
        verb: 'read',
        pluralSubject: true,
        sentinelProperty: RECORD_VALUES_SENTINEL,
        containers: collected.notExtracted,
        surface: '`recordValues`',
        zeroReading: '"no record sets this field"',
      }),
    );
  }
  if (collected.unreadable.length > 0) {
    parts.push(
      `${collected.unreadable.length} CustomMetadataRecord(s) carry a ` +
        `\`${RECORD_VALUES_SENTINEL}\` property that is NOT an array and could not be read ` +
        `(${collected.unreadable.join(', ')}) — a corrupt or partially written vault entry. ` +
        'Their values are a BLIND SPOT here, NEVER a verified "no value set". ' +
        'Re-run `/sfi-refresh`.',
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
};

/**
 * The `parentId === null` disclosure. There is no Custom Metadata Type to
 * enumerate CustomMetadataRecord children from, so NOTHING was checked — the
 * empty array is a structural absence, not a verified zero.
 */
const NO_PARENT_RECORD_VALUES_NOTE =
  '`recordValues` is empty because this CustomField node carries NO parentId — there is no ' +
  'Custom Metadata Type to enumerate CustomMetadataRecord children from, so nothing was ' +
  'checked. This is a structural absence (the vault recorded this field without a parent), ' +
  'NEVER a verified "no record sets this field". Re-run `/sfi-refresh`.';

/** Canonical id prefix for the CustomObject node type (a field id's parent). */
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

/** What {@link resolveFieldIdCase} decided about the caller's casing. */
interface FieldIdCaseResolution {
  /** The vault's EXACT id when one was found; the caller's id otherwise. */
  readonly fieldId: ComponentId;
  /** The resolved node, or `null` when nothing in the vault matches. */
  readonly node: Node | null;
  /** The caller's id when it was case-corrected; `null` when it was exact. */
  readonly resolvedFrom: string | null;
}

/**
 * WRONG-CASE-FIELD-ID-WAS-A-CONFIDENT-MISS.
 *
 * Salesforce api names are CASE-INSENSITIVE; canonical component ids are not.
 * `sfi.resolve` grades a fully-lower-cased `<Object>.<Field>` string
 * `disposition: "exact"` and `sfi.object_360` states the case-insensitivity
 * rule out loud in its own `resolutionNote` — while this tool answered
 * `component-not-found` for a field the vault holds in full. "no CustomField
 * with id X" reads to a user as evidence about their ORG (go re-refresh their
 * vault), not about the resolver, which makes a wrong turn expensive on a
 * freshness-sensitive product.
 *
 * The probe runs ONLY after the exactly-cased id has already missed, so a
 * correctly-cased call pays nothing, and it is bounded by one object's field
 * list rather than a whole-graph scan.
 *
 * Case-insensitive RESOLUTION is never case-insensitive IDENTITY: when two
 * vault fields fold to the same name nothing here can pick between them, so the
 * caller is REFUSED with both ids — the same rule `canonicalizeObjectScope`
 * applies to objects. A name matching NOTHING is returned unchanged so the
 * existing phantom-aware `component-not-found` path still owns that wording.
 */
const resolveFieldIdCase = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<Result<FieldIdCaseResolution, McpError>> => {
  const exact = await getNodeById(ctx.graph, fieldId);
  if (!exact.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${exact.error.message}`,
    });
  }
  if (exact.value !== null) {
    return ok({ fieldId, node: exact.value, resolvedFrom: null });
  }

  const rest = fieldId.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 1 || dot === rest.length - 1) {
    return ok({ fieldId, node: null, resolvedFrom: null });
  }
  const objectApi = rest.slice(0, dot);
  const fieldApi = rest.slice(dot + 1);

  // The parent object is resolved case-insensitively too — a caller who
  // lower-cased the field name almost always lower-cased the object with it,
  // and the lower-cased OBJECT segment was the half that suppressed every
  // recovery path.
  const parentIds: string[] = [];
  const exactParentId = `${CUSTOM_OBJECT_PREFIX}${objectApi}` as ComponentId;
  const exactParent = await getNodeById(ctx.graph, exactParentId);
  if (!exactParent.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${exactParent.error.message}`,
    });
  }
  if (exactParent.value !== null) {
    parentIds.push(exactParentId);
  } else {
    const variants = await objectIdCaseVariants(ctx.graph, objectApi);
    if (!variants.ok) return err(variants.error);
    parentIds.push(...variants.value);
  }

  const folded = fieldApi.toLowerCase();
  const matches: Node[] = [];
  for (const parentId of parentIds) {
    const children = await listChildren(ctx.graph, parentId as ComponentId);
    if (!children.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${children.error.message}`,
      });
    }
    for (const child of children.value) {
      if (child.type !== 'CustomField') continue;
      if (child.id === fieldId) continue;
      if (child.apiName.toLowerCase() !== folded) continue;
      matches.push(child);
    }
  }

  if (matches.length === 0) {
    return ok({ fieldId, node: null, resolvedFrom: null });
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id).sort();
    return err({
      kind: 'invalid-query',
      message:
        `\`${fieldId}\` matches ${ids.length} fields in this vault that differ only by CASE ` +
        `(${ids.join(', ')}). Salesforce api names are case-insensitive, so nothing here can ` +
        'pick between them — pass the exact `fieldId` you mean. No explanation was rendered.',
      path: 'fieldId',
    });
  }

  const only = matches[0] as Node;
  return ok({
    fieldId: only.id as ComponentId,
    node: only,
    resolvedFrom: fieldId,
  });
};

/**
 * Verbatim disclosure for a case-corrected `fieldId`. Shipped as the typed
 * `resolutionNote` on EVERY success rendered from a corrected id, so a reader
 * can never mistake the explanation for one about the id they typed.
 */
const caseCorrectionNote = (resolvedFrom: string, fieldId: string): string =>
  `\`${resolvedFrom}\` is not a component id in this vault; it was case-corrected to ` +
  `\`${fieldId}\` (Salesforce api names are case-insensitive, component ids are not). ` +
  'Everything below describes the corrected id — confirm it is the field you meant.';

/**
 * The `sfi.explain_field` MCP tool. Returns one field's label,
 * description, type, and required flag, and (when the parent is a
 * `__mdt` type) the per-CustomMetadataRecord value list. See the
 * module JSDoc for the input-axis validation rules and the
 * honesty-axis design for missing record values.
 *
 * @example
 *   const r = await explainFieldHandler(ctx, {
 *     fieldId: 'CustomField:Marketo_Api_Setting__mdt.Number_Of_Retries__c',
 *   });
 *   if (r.ok) console.log(r.value.data.recordValues?.length);
 *   // An empty list with NO `recordValuesNote` is a verified zero; one WITH
 *   // a note means some record's values were never extracted.
 */
export const explainFieldHandler = async (
  ctx: Context,
  rawInput: ExplainFieldInput,
): Promise<Result<McpResponse<ExplainFieldOutput>, McpError>> => {
  // L2 Alias OS: accept the `componentId` alias for `fieldId`. Disagreeing
  // values -> invalid-query (never a silent pick). Normalize into `fieldId`.
  const fieldAlias = resolveFieldAlias(rawInput);
  if (!fieldAlias.ok) return err(fieldAlias.error);
  const input = { ...rawInput, fieldId: fieldAlias.value.fieldId };
  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(suggestionResult.value as unknown as McpResponse<ExplainFieldOutput>);
  }

  if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }

  // WRONG-CASE-FIELD-ID-WAS-A-CONFIDENT-MISS — resolve the caller's casing
  // against the vault's own BEFORE any not-found path runs. See
  // `resolveFieldIdCase`. This also stops a custom field whose `__c` suffix was
  // typed `__C` from reaching the phantom message, which classified it as a
  // standard field on a case-SENSITIVE suffix test and volunteered a specific,
  // technical, FALSE causal explanation about a field this vault holds in full.
  const caseResolved = await resolveFieldIdCase(ctx, input.fieldId as ComponentId);
  if (!caseResolved.ok) return err(caseResolved.error);
  const resolvedFieldId = caseResolved.value.fieldId;
  const caseResolvedFrom = caseResolved.value.resolvedFrom;
  const caseDisclosure =
    caseResolvedFrom !== null
      ? {
          resolvedFrom: caseResolvedFrom,
          resolutionNote: caseCorrectionNote(caseResolvedFrom, resolvedFieldId),
        }
      : {};

  const node = caseResolved.value.node;
  if (node === null) {
    // B12/B29: a standard or managed-package field that is referenced by other
    // components but has no definition of its own in the vault is a PHANTOM,
    // not a non-existent id. Disclose that (the field exists in the org, just
    // wasn't retrieved) instead of a bare "no field with id".
    return err(
      await fieldNotFoundError(
        ctx,
        resolvedFieldId,
        await phantomAwareNotFoundMessage(ctx, resolvedFieldId, 'CustomField'),
      ),
    );
  }

  // Defensive: the prefix already pins the expected type, but the
  // graph round-trip could in principle return a node with a
  // different `type`. Treat that as `component-not-found` since the
  // caller's request cannot be satisfied by what the vault holds.
  if (node.type !== 'CustomField') {
    return err({
      kind: 'component-not-found',
      message: `node ${resolvedFieldId} is not a CustomField (type=${node.type})`,
      path: resolvedFieldId,
    });
  }

  const annotations = await annotationsBlockFor(ctx, node.id);
  const fieldType = readFieldType(node);
  let picklistValues = readFieldPicklistValues(node);
  // GlobalValueSet-driven picklist: the inline definition is null, but the
  // usesValueSet edge (0.1.10+ vaults) leads to the declared values — resolve
  // them so the routed "what values are in this picklist?" question gets a
  // real answer instead of a redirect (P14-USAGE-gvs-edge).
  let resolvedFromValueSet: string | null = null;
  if (picklistValues === null && PICKLIST_DATA_TYPES.includes(fieldType)) {
    const fromGvs = await resolveGlobalValueSetValues(ctx, node.id);
    if (fromGvs !== null) {
      picklistValues = fromGvs.values;
      resolvedFromValueSet = fromGvs.valueSetId;
    }
  }
  const base: Omit<ExplainFieldOutput, 'recordValues'> = {
    fieldId: node.id,
    label: readFieldLabel(node),
    description: readFieldDescription(node),
    inlineHelpText: readFieldInlineHelpText(node),
    type: fieldType,
    required: readFieldRequired(node),
    formula: readFieldFormula(node),
    referenceTo: readFieldReferenceTo(node),
    picklistValues,
    ...(resolvedFromValueSet !== null ? { picklistValuesSource: resolvedFromValueSet } : {}),
    // CR-10b: GVS-resolved values now carry an honestly-captured isActive
    // (same as an inline definition), so no disclosure note is needed for
    // that case anymore. The not-inline / unresolved case still surfaces
    // NON_INLINE_VALUE_SET_NOTE.
    ...(resolvedFromValueSet === null &&
    picklistValues === null &&
    PICKLIST_DATA_TYPES.includes(fieldType)
      ? { picklistValuesNote: NON_INLINE_VALUE_SET_NOTE }
      : {}),
    ...(annotations !== undefined ? { annotations } : {}),
    // Typed + prose, populated together, on EVERY branch below (they all spread
    // `base`) so no success path can render a corrected id silently.
    ...caseDisclosure,
  };

  const parentType = parentTypeApiName(node);
  const includeRecordValues = shouldIncludeRecordValues(
    parentType,
    input.includeRecordValues,
  );

  if (!includeRecordValues) {
    return ok({
      data: base,
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  if (node.parentId === null) {
    // No parent to enumerate from. R1: an empty array ALONE would read as a
    // verified "no record sets this field", so the structural reason ships
    // with it.
    return ok({
      data: {
        ...base,
        recordValues: [],
        recordValuesNote: NO_PARENT_RECORD_VALUES_NOTE,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const recordValuesResult = await collectRecordValues(
    ctx,
    node.parentId,
    readFieldApiName(node),
  );
  if (!recordValuesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${recordValuesResult.error}`,
    });
  }

  const recordValuesNote = recordValuesBlindSpotNote(recordValuesResult.value);
  return ok({
    data: {
      ...base,
      recordValues: recordValuesResult.value.rows,
      ...(recordValuesNote !== undefined ? { recordValuesNote } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
