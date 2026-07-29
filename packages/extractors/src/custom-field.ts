import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { buildReferencesEdges } from './formula-references.js';
import { deriveComponentApiName, deriveParentApiName } from './path-utils.js';

const FIELD_FILE_SUFFIX = '.field-meta.xml';
const ROOT_ELEMENT = 'CustomField';
const FIELDS_DIR_NAME = 'fields';
const PICKLIST_TYPES = ['Picklist', 'MultiselectPicklist'] as const;
const FORMULA_ELEMENT_NAME = 'formula';
/**
 * Extractor `source` marker on the roll-up summary coupling edges. Distinct from
 * `formula-tokenizer` (the special case `classifyEdge` evaluates first) and from
 * the generic `custom-field-extractor` marker, so a consumer can tell a declared
 * roll-up coupling apart from a tokenized formula reference by source alone.
 */
const ROLLUP_SUMMARY_SOURCE = 'rollup-summary';

/**
 * Reserved standard-field names whose Salesforce data type is FIXED on every
 * object. Standard fields omit `<type>` from retrieved metadata; rather than
 * leaving these as the `Unknown` sentinel (which confused type-change advisors,
 * e.g. for Contact.Email), infer the deterministic type. Only names whose type
 * is identical across all orgs are listed — anything ambiguous (Id, Name, the
 * various *Id references) is deliberately omitted and stays `Unknown`. Values
 * match the downstream FieldType vocabulary (Email/Phone/Url/Date/DateTime/
 * Checkbox).
 */
const STANDARD_FIELD_TYPES: Readonly<Record<string, string>> = {
  Email: 'Email',
  Phone: 'Phone',
  Fax: 'Phone',
  MobilePhone: 'Phone',
  HomePhone: 'Phone',
  OtherPhone: 'Phone',
  AssistantPhone: 'Phone',
  Website: 'Url',
  CreatedDate: 'DateTime',
  LastModifiedDate: 'DateTime',
  SystemModstamp: 'DateTime',
  LastViewedDate: 'DateTime',
  LastReferencedDate: 'DateTime',
  LastActivityDate: 'Date',
  Birthdate: 'Date',
  IsDeleted: 'Checkbox',
};

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Most CustomField elements the extractor reads
 * are single-occurrence; this helper tolerates either shape.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Coerce an XML scalar to a boolean. The Salesforce default for unset
 * boolean elements is `false`, so anything that isn't the literal `true`
 * (or its string form) collapses to `false`.
 */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/**
 * Coerce an XML scalar element to a nullable string. Missing or
 * `undefined` becomes `null`; everything else stringifies. Used for
 * optional string-valued elements that default to `null`.
 */
const toNullableString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  return String(v);
};

/**
 * Coerce an XML scalar element to a nullable number. Used for `length`,
 * `precision`, `scale`. Returns `null` for missing or non-numeric values.
 */
const toNullableNumber = (value: unknown): number | null => {
  const v = unwrapSingle(value);
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Coerce an XML scalar element to a boolean, defaulting to `false` when
 * the element is missing or undefined.
 */
const toBooleanWithDefault = (value: unknown): boolean =>
  coerceBoolean(unwrapSingle(value));

/**
 * Coerce a picklist `<value>`'s `<isActive>` element with a default of
 * `true` — the INVERSE default of {@link toBooleanWithDefault}. Salesforce
 * DX-source OMITS `<isActive>` for ACTIVE values and only writes
 * `<isActive>false</isActive>` on a DEACTIVATED value, so an absent element
 * means the value is selectable (active). Reusing the `false`-defaulting
 * coercion here would mark every active value inactive on every real
 * picklist (H10) — keep this helper separate and do NOT "unify" it with
 * `toBooleanWithDefault`.
 */
const coerceIsActiveDefaultTrue = (value: unknown): boolean => {
  const v = unwrapSingle(value);
  return v === undefined ? true : coerceBoolean(v);
};

/**
 * Read and strictly-validate a file as XML. fast-xml-parser's `parse()`
 * is permissive (it silently truncates on mismatched tags), so we
 * validate first to surface malformed input as `parse-error` rather than
 * a misleading partial extraction.
 */
const readAndValidateXml = async (
  path: string,
): Promise<Result<string, ExtractorError>> => {
  let xmlText: string;
  try {
    xmlText = await readFile(path, 'utf-8');
  } catch (cause: unknown) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as { code?: string }).code === 'ENOENT'
    ) {
      return err({ kind: 'file-not-found', path, message: 'file not found' });
    }
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const validation = XMLValidator.validate(xmlText);
  if (validation !== true) {
    return err({ kind: 'parse-error', path, message: validation.err.msg });
  }
  return ok(xmlText);
};

/**
 * Locate and validate the `<CustomField>` root in a parsed XML tree. Custom
 * fields (`__c`) must declare `<label>` and `<type>`; standard fields (no `__c`
 * suffix) carry those as system-defined and may omit them — they are
 * synthesized (label = fullName; type = the reserved field's fixed type when
 * known, else the `Unknown` sentinel) rather than rejected.
 */
const validateRoot = (
  parsed: Record<string, unknown>,
  path: string,
): Result<Record<string, unknown>, ExtractorError> => {
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;
  // Standard fields (api name without a `__c` suffix) carry a system-defined
  // label + type that Salesforce OMITS from retrieved metadata — the XML is
  // often just <fullName> + tracking flags. Requiring label/type errored on
  // every standard field (380 on a real govt-org refresh). For a standard field
  // synthesize sensible defaults (label = fullName, type = the `Unknown`
  // sentinel) so it still extracts; only CUSTOM fields (`__c`) must declare both.
  const fullName = String(unwrapSingle(rootObj['fullName']) ?? '');
  const isCustomField = fullName.endsWith('__c');
  if (rootObj['label'] === undefined) {
    if (isCustomField) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <label>',
      });
    }
    rootObj['label'] = fullName;
  }
  if (rootObj['type'] === undefined) {
    if (isCustomField) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <type>',
      });
    }
    // Standard fields omit <type>. Salesforce reserves these field names with a
    // FIXED type on every object, so inferring them is deterministic (not a
    // guess) — e.g. Contact.Email surfaced as `Unknown` and confused
    // type-change advisors. Anything not in this provably-safe map stays
    // `Unknown` rather than risking a wrong type.
    const bareName = fullName.includes('.')
      ? (fullName.split('.').pop() as string)
      : fullName;
    rootObj['type'] = STANDARD_FIELD_TYPES[bareName] ?? 'Unknown';
  }
  return ok(rootObj);
};

/**
 * Derive `{ObjectApiName, FieldApiName}` from a `*.field-meta.xml` path.
 *
 * Per the vendored CustomField doc, the file lives at
 * `.../objects/{ObjectApiName}/fields/{FieldApiName}.field-meta.xml`.
 * The function asserts the immediate parent directory is `fields` and
 * that an enclosing directory (the ObjectApiName) exists.
 */
const derivePathParts = (
  path: string,
): Result<{ objectApiName: string; fieldApiName: string }, ExtractorError> => {
  const fieldApiName = deriveComponentApiName(path, FIELD_FILE_SUFFIX);
  const immediateParent = basename(dirname(path));
  const objectApiName = deriveParentApiName(path, 2);
  if (immediateParent !== FIELDS_DIR_NAME || objectApiName.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot derive ObjectApiName from path',
    });
  }
  return ok({ objectApiName, fieldApiName });
};

/**
 * One inline picklist value as the vault stores it. `isActive` carries the
 * honesty axis (H10): an INACTIVE value is RETAINED but no longer selectable
 * for new records — existing records may still hold it — so consumers must
 * list-and-mark inactive values, never drop them silently nor present them as
 * selectable. `label` / `default` are present only when the source `<label>`
 * / `<default>` element was, to avoid churning fields that never had them.
 */
export interface PicklistValue {
  readonly value: string;
  readonly isActive: boolean;
  readonly label?: string;
  readonly default?: boolean;
}

/**
 * One entry in a picklist controlling-field dependency map. Each `<valueSettings>`
 * block in `<valueSet>` names a controlling field value and the dependent picklist
 * value that becomes available when that controlling value is selected.
 */
export interface PicklistControllingFieldValue {
  readonly controllingFieldValue: string;
  readonly valueName: string;
}

/**
 * Extract picklist values from a `<valueSet>` subtree, or `null` when
 * the structure is absent. Picklist values live at
 * `valueSet > valueSetDefinition > value`, each carrying `<fullName>` (the
 * API value), `<label>`, `<default>`, and — only when DEACTIVATED —
 * `<isActive>false</isActive>`. The emitted element is an object carrying
 * `isActive` (H10): Salesforce DX OMITS `<isActive>` for active values, so an
 * absent element defaults to `true` (selectable). Inactive values are EMITTED
 * (not dropped) so consumers can mark them retained-but-not-selectable rather
 * than reporting them as current or claiming they do not exist.
 */
const extractPicklistValues = (rootObj: Record<string, unknown>): PicklistValue[] | null => {
  const valueSet = unwrapSingle(rootObj['valueSet']);
  if (typeof valueSet !== 'object' || valueSet === null) return null;
  const definition = unwrapSingle((valueSet as Record<string, unknown>)['valueSetDefinition']);
  if (typeof definition !== 'object' || definition === null) return null;
  const rawValues = (definition as Record<string, unknown>)['value'];
  if (rawValues === undefined) return [];
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  return values.map((raw) => {
    const entry = raw as Record<string, unknown>;
    const value = String(unwrapSingle(entry['fullName']));
    const isActive = coerceIsActiveDefaultTrue(entry['isActive']);
    const label = toNullableString(entry['label']);
    const out: PicklistValue = { value, isActive };
    // OMIT-when-null: only attach label/default when the source element was
    // present, mirroring the valueSetName pattern so fields that never carried
    // them do not gain new keys (avoids A7 / golden churn).
    return {
      ...out,
      ...(label !== null ? { label } : {}),
      ...(unwrapSingle(entry['default']) !== undefined
        ? { default: toBooleanWithDefault(entry['default']) }
        : {}),
    };
  });
};

/**
 * Extract the controlling-field name and per-value dependency mappings from a
 * `<valueSet>` subtree. A dependent picklist carries `<controllingField>` (the
 * API name of the field whose selection drives which values are visible) and one
 * or more `<valueSettings>` blocks — each pairing a `<controllingFieldValue>`
 * with the `<valueName>` that becomes available under it.
 *
 * Returns `null` for both when the `<valueSet>` is absent or the field is not
 * dependent (no `<controllingField>` element). Never fabricates a dependency
 * structure from `inlineHelpText` or other heuristics.
 */
const extractControllingFieldInfo = (
  rootObj: Record<string, unknown>,
): {
  controllingField: string | null;
  controllingFieldValues: PicklistControllingFieldValue[] | null;
} => {
  const valueSet = unwrapSingle(rootObj['valueSet']);
  if (typeof valueSet !== 'object' || valueSet === null) {
    return { controllingField: null, controllingFieldValues: null };
  }
  const vsObj = valueSet as Record<string, unknown>;
  const controllingField = toNullableString(vsObj['controllingField']);
  if (controllingField === null) {
    return { controllingField: null, controllingFieldValues: null };
  }
  const rawSettings = vsObj['valueSettings'];
  if (rawSettings === undefined) {
    return { controllingField, controllingFieldValues: [] };
  }
  const settingsArr = Array.isArray(rawSettings) ? rawSettings : [rawSettings];
  const controllingFieldValues: PicklistControllingFieldValue[] = settingsArr.map((raw) => {
    const entry = raw as Record<string, unknown>;
    return {
      controllingFieldValue: String(unwrapSingle(entry['controllingFieldValue']) ?? ''),
      valueName: String(unwrapSingle(entry['valueName']) ?? ''),
    };
  });
  return { controllingField, controllingFieldValues };
};

/**
 * Pull `<valueSet><valueSetName>` — the GLOBAL value-set reference a picklist
 * carries instead of an inline definition (P14-USAGE-gvs-edge, closes
 * FINDINGS P-GVS-EDGE). Returns `null` when the value set is inline or the
 * field carries no value set at all.
 */
const extractValueSetName = (rootObj: Record<string, unknown>): string | null => {
  const valueSet = unwrapSingle(rootObj['valueSet']);
  if (typeof valueSet !== 'object' || valueSet === null) return null;
  return toNullableString((valueSet as Record<string, unknown>)['valueSetName']);
};

/** The `SummaryOperation` enumeration Salesforce carries on `<summaryOperation>`. */
const SUMMARY_DATA_TYPE = 'Summary';

/**
 * Extract the roll-up-summary-specific triple from a `<type>Summary</type>`
 * CustomField: `summarizedField` (the child-object field being aggregated —
 * ABSENT for a `count` operation, since counting rows needs no source field),
 * `summaryForeignKey` (the child-object master-detail field that points back
 * at THIS field's own object — the anchor a consumer needs to answer "which
 * child object recalculates this rollup"), and `summaryOperation` (`count` /
 * `sum` / `min` / `max`). Both `summarizedField` and `summaryForeignKey` are
 * `{ChildObjectApiName}.{ChildFieldApiName}` dot-qualified strings verbatim
 * from the XML — NOT re-parsed into a canonical CustomField id here, so a
 * consumer that wants the child object alone splits on the first `.`.
 *
 * Returns all-`null` for a non-Summary field so the caller's OMIT-when-null
 * spread keeps every other CustomField byte-identical (no churn).
 */
const extractSummaryInfo = (
  rootObj: Record<string, unknown>,
  dataType: string,
): {
  summarizedField: string | null;
  summaryForeignKey: string | null;
  summaryOperation: string | null;
} => {
  if (dataType !== SUMMARY_DATA_TYPE) {
    return { summarizedField: null, summaryForeignKey: null, summaryOperation: null };
  }
  return {
    summarizedField: toNullableString(rootObj['summarizedField']),
    summaryForeignKey: toNullableString(rootObj['summaryForeignKey']),
    summaryOperation: toNullableString(rootObj['summaryOperation']),
  };
};

/**
 * Extract the child-object field named by each `<summaryFilterItems><field>` on
 * a roll-up summary field. Each is a `{ChildObject}.{ChildField}` string, the
 * same shape as `summarizedField`. Deduplicated, source order preserved.
 *
 * These are dependencies in the same sense the summarized field is: the roll-up
 * filter stops compiling if the field it tests is removed, so the platform
 * refuses the delete. Like the rest of the roll-up triple, the declaration lives
 * on the PARENT object's file, invisible to any search scoped to the child.
 */
const extractSummaryFilterFields = (
  rootObj: Record<string, unknown>,
): readonly string[] => {
  const raw = rootObj['summaryFilterItems'];
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const field = toNullableString((item as Record<string, unknown>)['field']);
    if (field === null || field.length === 0) continue;
    if (seen.has(field)) continue;
    seen.add(field);
    out.push(field);
  }
  return out;
};

/**
 * Build the `properties` map for a CustomField Node. Keys are exactly
 * those listed in the vendored doc's "Node properties" section.
 */
const buildProperties = (
  rootObj: Record<string, unknown>,
  dataType: string,
): Readonly<Record<string, unknown>> => {
  const isPicklist = PICKLIST_TYPES.includes(dataType as (typeof PICKLIST_TYPES)[number]);
  const formula = toNullableString(rootObj['formula']);
  // Derived classifier: in DX-source format `<type>` holds a formula's RETURN
  // type (Text, Checkbox, Number, …), NOT the literal `'Formula'`, so `dataType`
  // alone CANNOT tell a computed field from a stored one. The presence of a
  // non-empty `<formula>` body is the authoritative signal. Surface it as a
  // first-class `isFormula` boolean so consumers (list_components, field
  // summaries, field_360, data-dictionary) can group/count formula fields
  // without re-deriving the rule — and never report "No Formula fields were
  // found" for an object whose formula fields all carry a non-`Formula` <type>.
  const isFormula = formula !== null && formula.length > 0;
  const { controllingField, controllingFieldValues } = isPicklist
    ? extractControllingFieldInfo(rootObj)
    : { controllingField: null, controllingFieldValues: null };
  const { summarizedField, summaryForeignKey, summaryOperation } = extractSummaryInfo(
    rootObj,
    dataType,
  );

  return {
    label: String(unwrapSingle(rootObj['label'])),
    dataType,
    description: toNullableString(rootObj['description']),
    length: toNullableNumber(rootObj['length']),
    precision: toNullableNumber(rootObj['precision']),
    scale: toNullableNumber(rootObj['scale']),
    required: toBooleanWithDefault(rootObj['required']),
    unique: toBooleanWithDefault(rootObj['unique']),
    externalId: toBooleanWithDefault(rootObj['externalId']),
    defaultValue: toNullableString(rootObj['defaultValue']),
    formula,
    referenceTo: toNullableString(rootObj['referenceTo']),
    relationshipName: toNullableString(rootObj['relationshipName']),
    inlineHelpText: toNullableString(rootObj['inlineHelpText']),
    trackHistory: toBooleanWithDefault(rootObj['trackHistory']),
    picklistValues: isPicklist ? extractPicklistValues(rootObj) : null,
    // OMIT-when-null: only dependent picklists carry a controlling field. A
    // `controllingField: null` row on every non-dependent picklist and every
    // non-picklist field would churn all markdown vault files.
    ...(controllingField !== null ? { controllingField } : {}),
    // OMIT-when-null: only dependent picklists carry per-value controlling-field
    // mappings. Stored alongside controllingField so consumers can answer
    // dependency questions directly from the node without guessing from
    // inlineHelpText. The array is [] (not null) when controllingField exists
    // but no <valueSettings> blocks were present.
    ...(controllingFieldValues !== null ? { controllingFieldValues } : {}),
    // OMIT-when-false (unlike the fixed keys above): only computed fields carry
    // a formula body, and an `isFormula: false` row on every CustomField would
    // churn every rendered markdown file in every vault. Emitting it only when
    // `true` keeps stored fields byte-identical while making formula fields
    // self-describing.
    ...(isFormula ? { isFormula: true } : {}),
    // OMIT-when-null (unlike the fixed keys above): only GlobalValueSet-driven
    // picklists carry a value-set name, and a `valueSetName: null` row on every
    // CustomField would churn every rendered markdown file in every vault
    // (P14-USAGE-gvs-edge).
    ...(() => {
      const valueSetName = extractValueSetName(rootObj);
      return valueSetName !== null ? { valueSetName } : {};
    })(),
    // OMIT-when-null (unlike the fixed keys above): only `type: Summary`
    // (roll-up summary) fields carry these three, and a null row on every
    // stored/formula CustomField would churn every rendered markdown vault
    // file. `summarizedField` is itself OMIT-able even on a Summary field —
    // a `count` operation has no source field to summarize, so it is absent
    // (not null) on that shape. Consumers (the SOE post-save-rollup-recalc
    // phase, field_360, data-dictionary) read `summaryForeignKey`'s
    // `{ChildObject}.` prefix to find which child object's save recalculates
    // this field.
    ...(summarizedField !== null ? { summarizedField } : {}),
    ...(summaryForeignKey !== null ? { summaryForeignKey } : {}),
    ...(summaryOperation !== null ? { summaryOperation } : {}),
  };
};

/**
 * Extract a Node and edges from a single Salesforce `*.field-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates required elements per the
 * vendored `CustomField.md` spec, and returns an `ExtractionResult`
 * containing one `Node` of type `'CustomField'`, one `parentOf` edge
 * from the enclosing CustomObject, and — for formula fields — zero or
 * more `references` edges (one per distinct field referenced in
 * `<formula>`, sorted by `toId` for determinism). Tokenizer errors on
 * the formula are tolerated: the Node and `parentOf` edge still emit,
 * just without `references`.
 *
 * References edges are emitted whenever the `<formula>` element is a
 * non-empty string. In DX-source format `<type>` holds the formula's
 * RETURN type (Text, Checkbox, Number, etc.), not the literal string
 * `'Formula'`, so gating on `<type>` would miss real formula fields.
 * The presence of a non-empty `<formula>` is the correct identifier.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing required element, or unrecognized DX path layout).
 *
 * @example
 *   const result = await extractCustomField(
 *     'tests/fixtures/edu-org/source/main/default/objects/Budget__c/fields/Month__c.field-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'CustomField:Budget__c.Month__c'
 *   }
 */
export const extractCustomField = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = derivePathParts(path);
  if (!pathParts.ok) return pathParts;
  const { objectApiName, fieldApiName } = pathParts.value;

  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is
  // too tight for production-scale Profile/PermissionSet/Layout XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion
  // cap of 1000). Catch it here so a single pathological file becomes a
  // per-file `parse-error` rather than aborting the refresh pipeline.
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xmlResult.value) as Record<string, unknown>;
  } catch (cause: unknown) {
    return err({
      kind: 'parse-error',
      path,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const rootResult = validateRoot(parsed, path);
  if (!rootResult.ok) return rootResult;
  const rootObj = rootResult.value;

  const dataType = String(unwrapSingle(rootObj['type']));
  const label = String(unwrapSingle(rootObj['label']));
  const parentId = `CustomObject:${objectApiName}`;
  const nodeId = `CustomField:${objectApiName}.${fieldApiName}`;

  const node: Node = {
    id: nodeId,
    type: 'CustomField',
    apiName: fieldApiName,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: buildProperties(rootObj, dataType),
  };

  const parentEdge: Edge = {
    fromId: parentId,
    toId: nodeId,
    edgeType: 'parentOf',
    confidence: 'declared',
    source: 'custom-field-extractor',
    properties: {},
  };

  // Per Formula.md: formula fields emit one `references` edge per
  // distinct field-reference token in `<formula>`. In DX-source format
  // `<type>` holds the formula's RETURN type (Text, Checkbox, Number,
  // etc.) — NOT the literal string `'Formula'`. The correct identifier
  // of a formula field is therefore the PRESENCE of a non-empty
  // `<formula>` element; `dataType` is preserved on `properties` for
  // reporting only.
  const formulaSource = toNullableString(rootObj['formula']);
  const referencesEdges =
    formulaSource !== null && formulaSource.length > 0
      ? buildReferencesEdges(formulaSource, nodeId, objectApiName, FORMULA_ELEMENT_NAME)
      : [];

  // v3.3 schema-relationship tier: a Lookup / Master-Detail field carries a
  // `referenceTo` target object. Promote it to a first-class `lookupTo` edge
  // (field -> target CustomObject) so dependency walks traverse the data model
  // (get_impact on an object can finally list inbound lookups). A polymorphic
  // lookup has multiple `referenceTo` entries → one edge each. Master-Detail vs
  // Lookup is recorded in `properties.relationshipType`. The target may be a
  // standard / managed object not retrieved into the vault (dangling edge,
  // classified by the phantom taxonomy).
  const rawReferenceTo = rootObj['referenceTo'];
  const referenceTargets = (Array.isArray(rawReferenceTo) ? rawReferenceTo : [rawReferenceTo])
    .map((r) => toNullableString(r))
    .filter((r): r is string => r !== null && r.length > 0);
  const relationshipType = dataType === 'MasterDetail' ? 'MasterDetail' : 'Lookup';
  const lookupEdges: Edge[] = referenceTargets.map((target) => ({
    fromId: nodeId,
    toId: `CustomObject:${target}`,
    edgeType: 'lookupTo',
    confidence: 'declared',
    source: 'custom-field-extractor',
    properties: { relationshipType },
  }));

  // ROLLUP-SOURCE-EDGE: a roll-up summary field aggregates a field on a CHILD
  // object, and the coupling metadata lives entirely in the PARENT's file. Until
  // this edge existed the coupling was a node PROPERTY only, so an incoming-edge
  // walk from the child field (safe_to_delete_field, find_field_anywhere,
  // get_impact) could not see it — and the platform's hardest field-delete
  // blocker returned no reason at all. Both targets are genuine blockers:
  //
  //   summarizedField    the child field being aggregated. Salesforce REFUSES to
  //                      delete it while the roll-up exists. ABSENT for a `count`
  //                      operation, which aggregates rows rather than a field.
  //   summaryForeignKey  the child's master-detail field anchoring the roll-up.
  //                      Deleting it (or converting MD -> Lookup) is refused too.
  //
  // Both are `{ChildObject}.{ChildField}` verbatim from the XML, which is already
  // the `CustomField:` id body — no re-parsing needed. The child object may not
  // have been retrieved into this vault, in which case the edge dangles and the
  // existing phantom taxonomy classifies it (same contract as `lookupTo`).
  //
  // Source marker is deliberately NOT `formula-tokenizer`: that marker is the
  // special case `classifyEdge` checks first, and these are declared XML facts,
  // not tokenizer output.
  const summaryInfo = extractSummaryInfo(rootObj, dataType);
  const rollupTargets: readonly (readonly [string, string | null])[] = [
    ['summarizedField', summaryInfo.summarizedField],
    ['summaryForeignKey', summaryInfo.summaryForeignKey],
    // A roll-up's FILTER also names child fields, and the platform refuses to
    // delete those too — the filter would no longer compile. Same file, same
    // parent-side invisibility as the two above.
    ...(dataType === SUMMARY_DATA_TYPE
      ? extractSummaryFilterFields(rootObj).map(
          (field) => ['summaryFilterItem', field] as const,
        )
      : []),
  ];
  const rollupEdges: Edge[] = rollupTargets
    .filter(
      (entry): entry is readonly [string, string] =>
        entry[1] !== null && entry[1].length > 0,
    )
    .map(([rollupRole, target]) => ({
      fromId: nodeId,
      toId: `CustomField:${target}`,
      edgeType: 'references' as const,
      confidence: 'declared' as const,
      source: ROLLUP_SUMMARY_SOURCE,
      properties: {
        rollupRole,
        // OMIT-when-null so a `count` roll-up (no operation recorded) does not
        // carry a null row into every stored edge.
        ...(summaryInfo.summaryOperation !== null
          ? { summaryOperation: summaryInfo.summaryOperation }
          : {}),
      },
    }));

  // P14-USAGE-gvs-edge (closes FINDINGS P-GVS-EDGE): a picklist driven by a
  // GlobalValueSet carries <valueSet><valueSetName> instead of an inline
  // definition. The usesValueSet edge type was declared in the contracts and
  // described in docs since v1.2 but NEVER emitted — so every GlobalValueSet
  // read as unused and unused_components cited an edge that did not exist.
  const valueSetName = extractValueSetName(rootObj);
  const valueSetEdges: Edge[] =
    valueSetName !== null
      ? [
          {
            fromId: nodeId,
            toId: `GlobalValueSet:${valueSetName}`,
            edgeType: 'usesValueSet',
            confidence: 'declared',
            source: 'custom-field-extractor',
            properties: {},
          },
        ]
      : [];

  return ok({
    nodes: [node],
    edges: [
      parentEdge,
      ...referencesEdges,
      ...lookupEdges,
      ...rollupEdges,
      ...valueSetEdges,
    ],
  });
};
