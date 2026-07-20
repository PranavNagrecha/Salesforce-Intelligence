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

import { deriveComponentApiName } from './path-utils.js';

const PATH_ASSISTANT_FILE_SUFFIX = '.pathAssistant-meta.xml';
const ROOT_ELEMENT = 'PathAssistant';
const EXTRACTOR_SOURCE = 'path-assistant-extractor';
// `<entityName>` is required: it is the authoritative API name of the object
// the path is bound to. Unlike most metadata, the object is NOT encoded in the
// filename — the basename is the path's own developer name — so without
// `<entityName>` the node is unidentifiable.
const REQUIRED_ELEMENTS = ['active', 'masterLabel', 'entityName'] as const;
// Salesforce serializes the master ("default") record type as this sentinel.
// A PathAssistant whose `<recordTypeName>` is `__MASTER__` (or absent) is an
// object-level default path with no specific record type.
const MASTER_RECORD_TYPE_SENTINEL = '__MASTER__';

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence PathAssistant elements use
 * this helper.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise. Used for `<pathAssistantSteps>` which may repeat once
 * per stage.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

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

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined || raw === null) return null;
  return String(raw);
};

/**
 * Max length of a step's plain-text guidance snippet. A Path step's `<info>` is
 * free-form rich text (often a large HTML block); keep the ordered Status value
 * as the load-bearing fact and cap the guidance so a node stays a lean summary,
 * not a document store. `guidanceTruncated` flags when the cap was hit.
 */
const GUIDANCE_SNIPPET_MAX = 280;

/** Strip HTML tags, collapse whitespace, and cap. Returns `null` when empty. */
const guidanceSnippet = (
  raw: unknown,
): { text: string; truncated: boolean } | null => {
  if (typeof raw !== 'string') return null;
  const plain = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length === 0) return null;
  return plain.length > GUIDANCE_SNIPPET_MAX
    ? { text: plain.slice(0, GUIDANCE_SNIPPET_MAX), truncated: true }
    : { text: plain, truncated: false };
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
 * Locate the `<PathAssistant>` root and verify required children per
 * `PathAssistant.md`.
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
  for (const required of REQUIRED_ELEMENTS) {
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
 * Extract a Node and one edge from a single Salesforce
 * `*.pathAssistant-meta.xml` file.
 *
 * Reads the file, parses it as XML, validates the `<PathAssistant>` root
 * per the vendored `PathAssistant.md` spec, and returns an
 * `ExtractionResult` containing one `Node` of type `'PathAssistant'` and
 * one `parentOf` edge from the bound parent.
 *
 * **Node identity.** A PathAssistant file is named by the path's own
 * developer name — there is NO object prefix in the filename (e.g.
 * `Default.pathAssistant-meta.xml`, `Default_Opportunity.pathAssistant-meta.xml`).
 * The bound object is the authoritative `<entityName>` element in the body,
 * NOT something parsed from the filename. The canonical ID therefore
 * namespaces the path's basename developer name with `<entityName>`:
 * `PathAssistant:{entityName}.{pathDevName}`. `apiName` is the same
 * object-qualified string (mirroring RecordType), so two objects' same-named
 * paths never collide as vault files.
 *
 * **Record type is optional.** `<recordTypeName>` names a specific record
 * type when the path is record-type-specific. An object-level *default* path
 * declares the master sentinel (`__MASTER__`) or omits the element entirely;
 * in both cases `recordTypeName` is surfaced as `null`.
 *
 * **Parent.** A record-type-specific path parents to its **RecordType**
 * (`RecordType:{entityName}.{recordTypeName}`). An object-level default path
 * (no specific record type) parents to the **CustomObject**
 * (`CustomObject:{entityName}`) — there is no master-RecordType node to point
 * at. Dangling parent edges (when the RecordType/CustomObject is not in
 * source) are tolerated.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root or a
 * missing required element — `<active>`, `<masterLabel>`, or `<entityName>`).
 *
 * @example
 *   const result = await extractPathAssistant(
 *     'org-kb/source/pathAssistants/Default_Opportunity.pathAssistant-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'PathAssistant:Opportunity.Default_Opportunity'
 *   }
 */
export const extractPathAssistant = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  // The basename (minus suffix) is the path's own Salesforce developer name —
  // it carries no object prefix. The bound object comes from `<entityName>`
  // (validated below), so file reading happens before identity construction.
  const pathDevName = deriveComponentApiName(path, PATH_ASSISTANT_FILE_SUFFIX);

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

  // `<entityName>` is required, so it is present here.
  const entityName = String(unwrapSingle(rootObj['entityName']));
  const masterLabel = String(unwrapSingle(rootObj['masterLabel']));
  const active = coerceBoolean(unwrapSingle(rootObj['active']));
  // `<recordTypeName>` is the bound record type's API name, or `null` for an
  // object-level default path — the element is absent/empty, or holds the
  // master sentinel `__MASTER__`.
  const rawRecordType = optionalString(rootObj, 'recordTypeName');
  const recordTypeName =
    rawRecordType === null ||
    rawRecordType.trim().length === 0 ||
    rawRecordType === MASTER_RECORD_TYPE_SENTINEL
      ? null
      : rawRecordType;
  // Each `<pathAssistantSteps>` binds guidance to one picklist value of the
  // path's `<fieldName>` (typically Status). v1 counted them into `stepCount`
  // but dropped the value names, so "what are the ordered steps of this path?"
  // could not be answered from the node (PATH-ASSISTANT-OMITS-STEPS). Emit the
  // ordered `steps: [{ picklistValueName, guidance?, guidanceTruncated? }]` in
  // declared XML order — the Status values a record moves through, with a capped
  // plain-text guidance snippet when the step declares `<info>`.
  const rawSteps = toArray(rootObj['pathAssistantSteps']);
  const steps = rawSteps.flatMap((rawStep) => {
    if (typeof rawStep !== 'object' || rawStep === null) return [];
    const stepObj = rawStep as Record<string, unknown>;
    const picklistValueName = optionalString(stepObj, 'picklistValueName');
    if (picklistValueName === null) return [];
    const snippet = guidanceSnippet(unwrapSingle(stepObj['info']));
    return [
      {
        picklistValueName,
        ...(snippet !== null ? { guidance: snippet.text } : {}),
        ...(snippet !== null && snippet.truncated ? { guidanceTruncated: true } : {}),
      },
    ];
  });
  const stepCount = rawSteps.length;

  const nodeId = `${ROOT_ELEMENT}:${entityName}.${pathDevName}`;
  const compositeApiName = `${entityName}.${pathDevName}`;
  // Record-type-specific paths parent to the RecordType; object-level default
  // paths parent to the CustomObject (no master-RecordType node exists).
  const parentId =
    recordTypeName === null
      ? `CustomObject:${entityName}`
      : `RecordType:${entityName}.${recordTypeName}`;

  const node: Node = {
    id: nodeId,
    type: 'PathAssistant',
    apiName: compositeApiName,
    label: masterLabel,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      masterLabel,
      active,
      entityName,
      recordTypeName,
      fieldName: optionalString(rootObj, 'fieldName'),
      stepCount,
      steps,
    },
  };

  const edges: Edge[] = [
    {
      fromId: parentId,
      toId: nodeId,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: {},
    },
  ];

  return ok({ nodes: [node], edges });
};
