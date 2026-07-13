import { readFile } from 'node:fs/promises';

import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName } from './path-utils.js';

const TIME_SHEET_TEMPLATE_FILE_SUFFIX = '.timeSheetTemplate-meta.xml';
const ROOT_ELEMENT = 'TimeSheetTemplate';
// Per the Field Service Developer Guide's TimeSheetTemplate reference, these
// six elements are documented as required ("Yes" in the field table).
const REQUIRED_ELEMENTS = [
  'active',
  'frequency',
  'masterLabel',
  'startDate',
  'workWeekEndDay',
  'workWeekStartDay',
] as const;

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise. Used for `<timeSheetTemplateAssignments>`
 * which may appear zero, one, or many times.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

/** Coerce an XML scalar to boolean; non-`true` values become false (per SF defaults). */
const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
};

/**
 * Read and strictly-validate a file as XML. Validates before parsing so
 * malformed input surfaces as `parse-error` (fast-xml-parser's `parse()`
 * silently truncates on mismatched tags).
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

/** Locate the `<TimeSheetTemplate>` root and verify required children per the Field Service Developer Guide. */
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
 * Extract a Node from a single Salesforce `*.timeSheetTemplate-meta.xml`
 * file (one file per template, flat top-level `timeSheetTemplates/` folder
 * — verified against the Field Service Developer Guide's TimeSheetTemplate
 * reference, API version 46.0+).
 *
 * Finding #38 (corrected recipe): `TimeSheetTemplate` is the third of the
 * three genuine FSL Metadata API types (alongside `FieldServiceSettings`
 * and `Skill`).
 *
 * Reads the six documented-required elements (`active`, `frequency`,
 * `masterLabel`, `startDate`, `workWeekEndDay`, `workWeekStartDay`) plus the
 * optional `description`. `masterLabel` doubles as the node's `label`.
 *
 * The repeatable `<timeSheetTemplateAssignments><assignedTo>` blocks are
 * captured VERBATIM into `properties.assignedTo` (deduplicated + sorted,
 * omitted when none present) with NO edge minted: the Field Service
 * Developer Guide describes the value as "the IDs of the user profiles" but
 * does not confirm whether real orgs populate it with a Profile developer
 * name or an opaque record Id, and this codebase's honesty discipline is to
 * never fabricate a `Profile:` reference edge from an unconfirmed id shape
 * (mirroring `QueueRoutingConfig.userOverflowAssignee` / `PresenceUserConfig`
 * assignedUsernames precedent). An `[ORG]` retrieve would resolve this
 * ambiguity and is recommended, not required, before promoting it to an edge.
 *
 * Error cases:
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<TimeSheetTemplate>` or a
 *     required element is missing
 *
 * @example
 *   const result = await extractTimeSheetTemplate(
 *     'force-app/main/default/timeSheetTemplates/Standard_Weekly.timeSheetTemplate-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'TimeSheetTemplate:Standard_Weekly'
 */
export const extractTimeSheetTemplate = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. Default 1000 is too
  // tight for production-scale metadata XML.
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    processEntities: { maxTotalExpansions: 10000 },
  });
  // `XMLValidator.validate` above catches structural errors, but
  // `parser.parse()` still throws at runtime on guards the validator
  // doesn't enforce (e.g., fast-xml-parser's default entity-expansion cap).
  // Catch it so a single pathological file becomes a per-file `parse-error`
  // rather than aborting the refresh pipeline.
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

  const apiName = deriveComponentApiName(path, TIME_SHEET_TEMPLATE_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;
  const masterLabel = String(unwrapSingle(rootObj['masterLabel']));

  const assignmentBlocks = toArray(rootObj['timeSheetTemplateAssignments']);
  const assignedTo = [
    ...new Set(
      assignmentBlocks
        .map((block) => {
          if (typeof block !== 'object' || block === null) return null;
          const raw = unwrapSingle((block as Record<string, unknown>)['assignedTo']);
          return raw === undefined ? null : String(raw);
        })
        .filter((v): v is string => v !== null),
    ),
  ].sort();

  const node: Node = {
    id: nodeId,
    type: 'TimeSheetTemplate',
    apiName,
    label: masterLabel,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      active: coerceBoolean(unwrapSingle(rootObj['active'])),
      frequency: String(unwrapSingle(rootObj['frequency'])),
      masterLabel,
      startDate: String(unwrapSingle(rootObj['startDate'])),
      workWeekStartDay: String(unwrapSingle(rootObj['workWeekStartDay'])),
      workWeekEndDay: String(unwrapSingle(rootObj['workWeekEndDay'])),
      description: optionalString(rootObj, 'description'),
      ...(assignedTo.length > 0 ? { assignedTo } : {}),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
