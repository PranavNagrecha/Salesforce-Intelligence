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

import { deriveComponentApiName, deriveParentApiName } from './path-utils.js';

const FILE_SUFFIX = '.fieldSet-meta.xml';
const ROOT_ELEMENT = 'FieldSet';
const DIR_NAME = 'fieldSets';

const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

const toNullableString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  return v === undefined || v === null ? null : String(v);
};

/**
 * Pull the `<field>` API names out of a repeatable `<displayedFields>` /
 * `<availableFields>` block. Each entry is an object `{ field, isRequired, … }`.
 */
const fieldNamesFrom = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of arr) {
    if (typeof entry === 'object' && entry !== null) {
      const name = unwrapSingle((entry as Record<string, unknown>)['field']);
      if (name !== undefined && name !== null) out.push(String(name));
    }
  }
  return out;
};

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

const derivePathParts = (
  path: string,
): Result<{ objectApiName: string; apiName: string }, ExtractorError> => {
  const apiName = deriveComponentApiName(path, FILE_SUFFIX);
  const immediateParent = basename(dirname(path));
  const objectApiName = deriveParentApiName(path, 2);
  if (immediateParent !== DIR_NAME || objectApiName.length === 0) {
    return err({
      kind: 'malformed-input',
      path,
      message: 'cannot derive ObjectApiName from path',
    });
  }
  return ok({ objectApiName, apiName });
};

/**
 * Extract a Node and edges from a single `*.fieldSet-meta.xml` file.
 *
 * Emits one `FieldSet` Node, one `parentOf` edge from the enclosing
 * CustomObject, and one `usedInLayout` edge per distinct field across
 * `<displayedFields>` + `<availableFields>` (sorted by `toId`). A field set is
 * consumed by LWC/VF/managed code, so a referenced field is a real dependent.
 *
 * @example
 *   const r = await extractFieldSet('.../objects/Contact/fieldSets/SparkTable__Fields.fieldSet-meta.xml');
 *   // r.value.nodes[0].id === 'FieldSet:Contact.SparkTable__Fields'
 */
export const extractFieldSet = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const pathParts = derivePathParts(path);
  if (!pathParts.ok) return pathParts;
  const { objectApiName, apiName } = pathParts.value;

  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

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

  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;

  const labelRaw = unwrapSingle(rootObj['label']);
  const label = labelRaw === undefined ? apiName : String(labelRaw);
  const displayedFields = fieldNamesFrom(rootObj['displayedFields']);
  const availableFields = fieldNamesFrom(rootObj['availableFields']);

  const parentId = `CustomObject:${objectApiName}`;
  const nodeId = `${ROOT_ELEMENT}:${objectApiName}.${apiName}`;

  const node: Node = {
    id: nodeId,
    type: 'FieldSet',
    apiName,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      label,
      description: toNullableString(rootObj['description']),
      displayedFields,
      availableFields,
    },
  };

  const parentEdge: Edge = {
    fromId: parentId,
    toId: nodeId,
    edgeType: 'parentOf',
    confidence: 'declared',
    source: 'field-set-extractor',
    properties: {},
  };

  const fieldEdges: Edge[] = [...new Set([...displayedFields, ...availableFields])]
    .map((field) => ({
      fromId: nodeId,
      toId: `CustomField:${objectApiName}.${field}`,
      edgeType: 'usedInLayout' as const,
      confidence: 'declared' as const,
      source: 'field-set-extractor',
      properties: {},
    }))
    .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));

  return ok({ nodes: [node], edges: [parentEdge, ...fieldEdges] });
};
