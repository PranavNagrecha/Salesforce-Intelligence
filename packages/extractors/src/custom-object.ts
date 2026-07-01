import { readFile } from 'node:fs/promises';

import type {
  Edge,
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName, deriveEntityVariant } from './path-utils.js';

const OBJECT_FILE_SUFFIX = '.object-meta.xml';
const ROOT_ELEMENT = 'CustomObject';
// Per CustomObject.md, only `<label>` is unconditionally required.
// `<nameField>`, `<pluralLabel>`, `<deploymentStatus>`, and
// `<sharingModel>` are all conditionally required and checked per
// variant after variant detection.
const REQUIRED_ELEMENTS = ['label'] as const;

/**
 * A standard object (Account, Contact, Case, …) has no custom-suffix in its
 * API name. Salesforce serializes such objects WITHOUT the custom-object-only
 * elements (`<label>`, `<pluralLabel>`, `<nameField>`, `<deploymentStatus>`,
 * `<sharingModel>`) because their labels and shape are system-defined. We
 * still model them as nodes (so automation tools like `what_happens_on_save`
 * can anchor on Account/Contact) by treating those elements as optional and
 * falling back to the API name for the label.
 */
const isStandardObject = (apiName: string): boolean => !apiName.includes('__');

/**
 * Platform-universal system/audit fields present on EVERY queryable SObject.
 * Standard objects (Account, Contact, …) serialize none of their fields to DX
 * source — custom fields on them are separate files, but these system fields
 * have no source at all — so automation/formula references to `CreatedById`,
 * `LastModifiedDate`, etc. on a standard object would dangle. We synthesize them
 * as nodes, flagged `system`/`synthetic`, so field-level questions on standard
 * objects ("who created this", "last modified") have an anchor.
 *
 * Deliberately ONLY these universally-guaranteed fields — NOT a per-object
 * standard-field catalog (Industry, Phone, …), which varies by edition/version
 * and would dishonestly imply completeness. The non-system standard fields of a
 * standard object require the live describe plane; tools that list fields
 * disclose that. `Name`/`OwnerId` are intentionally excluded here because they
 * are NOT universal (e.g. Case has CaseNumber, junction objects lack OwnerId);
 * `Name` is synthesized only when the object's `<nameField>` is serialized.
 */
const SYSTEM_FIELDS: ReadonlyArray<{
  readonly name: string;
  readonly dataType: string;
  readonly label: string;
  readonly referenceTo?: string;
}> = [
  { name: 'Id', dataType: 'Id', label: 'Record ID' },
  { name: 'CreatedById', dataType: 'Lookup', label: 'Created By ID', referenceTo: 'User' },
  { name: 'CreatedDate', dataType: 'DateTime', label: 'Created Date' },
  { name: 'LastModifiedById', dataType: 'Lookup', label: 'Last Modified By ID', referenceTo: 'User' },
  { name: 'LastModifiedDate', dataType: 'DateTime', label: 'Last Modified Date' },
  { name: 'SystemModstamp', dataType: 'DateTime', label: 'System Modstamp' },
  { name: 'IsDeleted', dataType: 'Checkbox', label: 'Deleted' },
];

/**
 * Synthesize system/audit field nodes (+ their `parentOf` edges) for a standard
 * object. Returns empty for custom objects (their custom fields are extracted
 * from real source files; their system fields are implied and add only noise).
 * When the object serialized a `<nameField>`, its Name field is included too,
 * carrying the declared type — this is the one standard field we KNOW exists
 * because the metadata named it.
 */
const synthesizeSystemFields = (
  apiName: string,
  path: string,
  nameField: { readonly type: string | null; readonly label: string | null } | null,
): { nodes: Node[]; edges: Edge[] } => {
  if (!isStandardObject(apiName)) return { nodes: [], edges: [] };
  const parentId = `${ROOT_ELEMENT}:${apiName}`;
  const specs = [
    ...SYSTEM_FIELDS,
    ...(nameField !== null
      ? [
          {
            name: 'Name',
            dataType: nameField.type ?? 'Text',
            label: nameField.label ?? 'Name',
          },
        ]
      : []),
  ];
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const f of specs) {
    const id = `CustomField:${apiName}.${f.name}`;
    nodes.push({
      id,
      type: 'CustomField',
      apiName: f.name,
      label: f.label,
      parentId,
      sourcePath: path,
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        label: f.label,
        dataType: f.dataType,
        system: true,
        synthetic: true,
        provenance: 'platform-standard',
        referenceTo: 'referenceTo' in f ? f.referenceTo : null,
      },
    });
    edges.push({
      fromId: parentId,
      toId: id,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'custom-object-extractor:system-field',
      properties: { synthetic: true },
    });
  }
  return { nodes, edges };
};
const ALLOWED_DEPLOYMENT_STATUS = ['InDevelopment', 'Deployed'] as const;
const ALLOWED_SHARING_MODEL = [
  'Private',
  'Read',
  // `ReadSelect` is the OWD of the standard Pricebook2 object; `ReadWriteTransfer`
  // (Lead/Case/Opportunity transfer) and `ControlledByCampaign` (CampaignMember)
  // are the remaining values of the Salesforce SharingModel metadata enum. All
  // three are valid — omitting them made real objects fail extraction.
  'ReadSelect',
  'ReadWrite',
  'ReadWriteTransfer',
  'ControlledByParent',
  'ControlledByCampaign',
  'FullAccess',
] as const;

type DeploymentStatus = (typeof ALLOWED_DEPLOYMENT_STATUS)[number];
type SharingModel = (typeof ALLOWED_SHARING_MODEL)[number];

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. The CustomObject elements the extractor reads
 * are all single-occurrence; this helper tolerates either shape.
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
 * Locate and validate the `<CustomObject>` root in a parsed XML tree,
 * then verify every required child element is present.
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
  const standard = isStandardObject(deriveComponentApiName(path, OBJECT_FILE_SUFFIX));
  for (const required of REQUIRED_ELEMENTS) {
    // Standard objects carry a system-defined label not serialized in
    // metadata; don't require <label> for them (it falls back to the API name).
    if (required === 'label' && standard) continue;
    if (rootObj[required] === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: `missing required element: <${required}>`,
      });
    }
  }
  return ok(rootObj);
};

/**
 * Extract a Node from a single Salesforce `*.object-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates required elements per the
 * vendored `CustomObject.md` spec, and returns an `ExtractionResult`
 * containing one `Node` of type `'CustomObject'` and zero edges.
 *
 * Entity variant is derived from the API name suffix (and the presence
 * of `<customSettingsType>` for `__c`): one of `CustomObject`,
 * `CustomSetting`, `CustomMetadataType`, `PlatformEvent`, `BigObject`,
 * or `KnowledgeArticle`. Required-element checks for `<nameField>`,
 * `<pluralLabel>`, `<deploymentStatus>`, and `<sharingModel>` apply
 * conditionally per variant. `<visibility>` is read as an optional
 * string regardless of variant. The canonical ID prefix is always
 * `CustomObject:` regardless of variant.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing required element, or out-of-set enum value).
 *
 * @example
 *   const result = await extractCustomObject(
 *     'tests/fixtures/dx/objects/CustomerProject__c/CustomerProject__c.object-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'CustomObject:CustomerProject__c'
 *   }
 */
export const extractCustomObject = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
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

  const apiName = deriveComponentApiName(path, OBJECT_FILE_SUFFIX);
  const hasCustomSettingsType = rootObj['customSettingsType'] !== undefined;
  const variant = deriveEntityVariant(apiName, hasCustomSettingsType);
  // Standard objects (no custom suffix) omit the custom-object-only elements;
  // treat them all as optional so the node is still produced.
  const standard = isStandardObject(apiName);
  const nameFieldRequired = variant === 'CustomObject' && !standard;
  const pluralLabelRequired = variant !== 'CustomSetting' && !standard;
  const deploymentStatusRequired =
    !standard &&
    (variant === 'CustomObject' ||
      variant === 'PlatformEvent' ||
      variant === 'BigObject' ||
      variant === 'KnowledgeArticle');
  const sharingModelRequired = variant === 'CustomObject' && !standard;

  // Per CustomObject.md "Conditionally required elements":
  // `<deploymentStatus>` is required for CustomObject, PlatformEvent,
  // BigObject, and KnowledgeArticle. When absent for the other variants
  // (CustomSetting, CustomMetadataType) the properties map defaults to
  // `null`. When present, the value must be in the allowed set
  // regardless of variant — a malformed value is always a malformed
  // value.
  const deploymentStatusRaw = unwrapSingle(rootObj['deploymentStatus']);
  let deploymentStatus: string | null;
  if (deploymentStatusRaw === undefined) {
    if (deploymentStatusRequired) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <deploymentStatus>',
      });
    }
    deploymentStatus = null;
  } else {
    const value = String(deploymentStatusRaw);
    if (!ALLOWED_DEPLOYMENT_STATUS.includes(value as DeploymentStatus)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid deploymentStatus: ${value}`,
      });
    }
    deploymentStatus = value;
  }

  // Per CustomObject.md: `<sharingModel>` is required only for the
  // canonical `CustomObject` variant. Every other variant defaults to
  // `null` when absent. Strict-set validation still runs when the
  // element is present, regardless of variant.
  const sharingModelRaw = unwrapSingle(rootObj['sharingModel']);
  let sharingModel: string | null;
  if (sharingModelRaw === undefined) {
    if (sharingModelRequired) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <sharingModel>',
      });
    }
    sharingModel = null;
  } else {
    const value = String(sharingModelRaw);
    if (!ALLOWED_SHARING_MODEL.includes(value as SharingModel)) {
      return err({
        kind: 'malformed-input',
        path,
        message: `invalid sharingModel: ${value}`,
      });
    }
    sharingModel = value;
  }

  // Per CustomObject.md "Conditionally required elements": `<nameField>`
  // is required only for the canonical `CustomObject` variant. Every
  // other variant (CustomSetting, CustomMetadataType, PlatformEvent,
  // BigObject, KnowledgeArticle) treats it as absent — Salesforce
  // supplies a default Name field implicitly and does not serialize
  // `<nameField>` in DX source — and the properties map populates
  // `nameFieldLabel` and `nameFieldType` with `null`.
  const nameFieldRaw = unwrapSingle(rootObj['nameField']);
  if (nameFieldRequired && (typeof nameFieldRaw !== 'object' || nameFieldRaw === null)) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <nameField>',
    });
  }
  const nameFieldObj =
    typeof nameFieldRaw === 'object' && nameFieldRaw !== null
      ? (nameFieldRaw as Record<string, unknown>)
      : null;

  const labelRaw = unwrapSingle(rootObj['label']);
  const label = labelRaw === undefined ? apiName : String(labelRaw);

  // Per CustomObject.md: `<pluralLabel>` is required for every variant
  // except CustomSetting, which defaults to the value of `<label>`.
  const pluralLabelRaw = unwrapSingle(rootObj['pluralLabel']);
  if (pluralLabelRequired && pluralLabelRaw === undefined) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'missing required element: <pluralLabel>',
    });
  }
  const pluralLabel = pluralLabelRaw === undefined ? label : String(pluralLabelRaw);

  const nameFieldLabel =
    nameFieldObj === null ? null : String(unwrapSingle(nameFieldObj['label']) ?? '');
  const nameFieldType =
    nameFieldObj === null ? null : String(unwrapSingle(nameFieldObj['type']) ?? '');

  const descriptionRaw = unwrapSingle(rootObj['description']);
  const description = descriptionRaw === undefined ? null : String(descriptionRaw);

  // Per CustomObject.md "Optional elements the extractor reads":
  // `<visibility>` is read as an optional string (Public / Protected on
  // __mdt and CustomSetting). Absent on every other variant; defaults to
  // `null`. The extractor surfaces it because downstream consumers
  // (architect persona, permission-set joins) need it for cross-package
  // visibility reasoning.
  const visibilityRaw = unwrapSingle(rootObj['visibility']);
  const visibility = visibilityRaw === undefined ? null : String(visibilityRaw);

  // `<externalSharingModel>` controls access for external / Experience Cloud
  // (community) users. It is distinct from `<sharingModel>` (internal OWD)
  // and is optional — absent on standard objects and variants that don't
  // expose records to external users. Defaults to `null` when absent so
  // consumers can distinguish "not applicable" from "Private".
  const externalSharingModelRaw = unwrapSingle(rootObj['externalSharingModel']);
  const externalSharingModel =
    externalSharingModelRaw === undefined ? null : String(externalSharingModelRaw);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'CustomObject',
    apiName,
    label,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      label,
      pluralLabel,
      description,
      deploymentStatus,
      sharingModel,
      externalSharingModel,
      visibility,
      nameFieldLabel,
      nameFieldType,
      enableActivities: coerceBoolean(unwrapSingle(rootObj['enableActivities'])),
      enableHistory: coerceBoolean(unwrapSingle(rootObj['enableHistory'])),
      enableReports: coerceBoolean(unwrapSingle(rootObj['enableReports'])),
      enableSearch: coerceBoolean(unwrapSingle(rootObj['enableSearch'])),
    },
  };

  // Standard objects: synthesize their platform-universal system/audit fields
  // (no source file exists for them) so field-level questions can anchor. Name
  // is included only when the metadata actually serialized a <nameField> — so
  // we never invent a Name on objects that don't have one (e.g. Case).
  const system = synthesizeSystemFields(
    apiName,
    path,
    nameFieldObj !== null ? { type: nameFieldType, label: nameFieldLabel } : null,
  );

  return ok({ nodes: [node, ...system.nodes], edges: system.edges });
};
