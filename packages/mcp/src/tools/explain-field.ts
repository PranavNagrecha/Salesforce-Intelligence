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
 *   - The `parent is __mdt` check uses the field's `parentId`
 *     (`CustomObject:{TypeApiName}`). If the type name ends with
 *     `__mdt`, the parent is a CustomMetadataDefinition and the
 *     recordValues enumeration kicks in (unless the caller passes
 *     `includeRecordValues: false`). For non-`__mdt` parents,
 *     `recordValues` is omitted from the output entirely — present-
 *     but-empty would be misleading (a non-`__mdt` parent has no
 *     CustomMetadataRecord children by definition).
 *   - **Honesty axis** (per PLAN-v1.6 §3): when the parent is
 *     `__mdt` but the v1.6 R2 extraction did not surface any
 *     CustomMetadataRecord children (the vault either has no
 *     records for the type or the records were extracted but
 *     dropped), `recordValues` is the empty array. The tool does
 *     NOT fabricate records. Records that exist but lack a value
 *     for this specific field are omitted from the list — emitting
 *     `value: null` without context would conflate "no value set"
 *     with "the masked value is null", which is the wrong signal
 *     for a business-user trying to understand what a field is
 *     configured to.
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
import { getNodeById, listChildren, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { annotationsBlockFor, type AnnotationsBlock } from './annotations.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
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
export const explainFieldInputSchema = z.object({
  fieldId: z.string().min(1),
  includeRecordValues: z.boolean().optional(),
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
   */
  readonly picklistValues: readonly string[] | null;
  /**
   * Present ONLY when `picklistValues` was resolved by FOLLOWING the field's
   * `usesValueSet` edge to a GlobalValueSet (0.1.10+ vaults) — carries the
   * value set's canonical id so the consumer can cite where the values are
   * declared (P14-USAGE-gvs-edge). Absent for inline definitions.
   */
  readonly picklistValuesSource?: string;
  /**
   * Present ONLY when the field IS picklist-typed but `picklistValues` is
   * `null`: the value set was not inline at extraction time AND the
   * usesValueSet edge could not resolve it (pre-0.1.10 vault, or the
   * GlobalValueSet was not retrieved). Without this note a `null` would
   * silently read as "no values", which is the wrong signal for a value-set
   * that simply lives on another component.
   */
  readonly picklistValuesNote?: string;
  readonly recordValues?: readonly ExplainFieldRecordValue[];  /** P13-ANNOT-tools: curated annotations (provenance `annotation`); absent when none. */
  readonly annotations?: AnnotationsBlock;
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
 * Returns the string entries verbatim (an empty array is a real zero-value
 * inline definition); returns `null` for any non-array shape — non-picklist
 * fields and non-inline (GlobalValueSet-driven) picklists both land here.
 */
const readFieldPicklistValues = (node: Node): readonly string[] | null => {
  const raw = node.properties['picklistValues'];
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * For a GlobalValueSet-driven picklist (inline values null), follow the
 * field's outgoing `usesValueSet` edge to the GlobalValueSet node and return
 * its declared `properties.values` (P14-USAGE-gvs-edge — the edge and the
 * values both land on vaults refreshed at 0.1.10+). Returns `null` when the
 * edge or the target node is absent (pre-0.1.10 vault, or the value set was
 * not retrieved) — the caller falls back to the honesty note.
 */
const resolveGlobalValueSetValues = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<{ values: readonly string[]; valueSetId: string } | null> => {
  const edgesRes = await listEdges(ctx.graph, fieldId, { direction: 'out' });
  if (!edgesRes.ok) return null;
  const edge = edgesRes.value.find((e) => e.edgeType === 'usesValueSet');
  if (edge === undefined) return null;
  const gvsRes = await getNodeById(ctx.graph, edge.toId);
  if (!gvsRes.ok || gvsRes.value === null) return null;
  const raw = gvsRes.value.properties['values'];
  if (!Array.isArray(raw)) return null;
  return {
    values: raw.filter((v): v is string => typeof v === 'string'),
    valueSetId: edge.toId,
  };
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
 * Pull one CustomMetadataRecord child's value for a given field name.
 * Returns `null` when the record has no matching `<values>` entry for
 * the field — the v1.6 R2 extractor only emits an entry when the
 * record's XML carries one, so a missing entry semantically means
 * "no value set" and should be omitted from the cross-record list
 * (per the honesty-axis design in this module's JSDoc).
 */
const findValueForField = (
  record: Node,
  fieldApiName: string,
): { value: unknown; isMasked: boolean } | null => {
  const values = record.properties['values'];
  if (!Array.isArray(values)) return null;
  for (const entry of values) {
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
 * Enumerate every CustomMetadataRecord child of the parent
 * `__mdt` type and project each one's matching field value into the
 * `ExplainFieldRecordValue` shape. Records without a value for the
 * field are omitted (per the honesty axis). Sort: `recordId` ASC.
 */
const collectRecordValues = async (
  ctx: Context,
  parentId: ComponentId,
  fieldApiName: string,
): Promise<Result<readonly ExplainFieldRecordValue[], string>> => {
  const childrenResult = await listChildren(ctx.graph, parentId);
  if (!childrenResult.ok) {
    return err(childrenResult.error.message);
  }
  const out: ExplainFieldRecordValue[] = [];
  for (const child of childrenResult.value) {
    if (child.type !== 'CustomMetadataRecord') continue;
    const match = findValueForField(child, fieldApiName);
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
  return ok(out.sort(compareRecordValues));
};

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
 */
export const explainFieldHandler = async (
  ctx: Context,
  input: ExplainFieldInput,
): Promise<Result<McpResponse<ExplainFieldOutput>, McpError>> => {
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

  const nodeResult = await getNodeById(ctx.graph, input.fieldId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  const node = nodeResult.value;
  if (node === null) {
    // B12/B29: a standard or managed-package field that is referenced by other
    // components but has no definition of its own in the vault is a PHANTOM,
    // not a non-existent id. Disclose that (the field exists in the org, just
    // wasn't retrieved) instead of a bare "no field with id".
    return err(
      await fieldNotFoundError(
        ctx,
        input.fieldId as ComponentId,
        await phantomAwareNotFoundMessage(
          ctx,
          input.fieldId as ComponentId,
          'CustomField',
        ),
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
      message: `node ${input.fieldId} is not a CustomField (type=${node.type})`,
      path: input.fieldId,
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
    ...(picklistValues === null && PICKLIST_DATA_TYPES.includes(fieldType)
      ? { picklistValuesNote: NON_INLINE_VALUE_SET_NOTE }
      : {}),
    ...(annotations !== undefined ? { annotations } : {}),
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
    // No parent to enumerate from — surface an empty list rather
    // than fabricating. This is the same honesty signal as the
    // "parent has no extracted records" path below: callers see an
    // empty array and know to refresh the vault if they expected
    // records.
    return ok({
      data: { ...base, recordValues: [] },
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

  return ok({
    data: { ...base, recordValues: recordValuesResult.value },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
