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

const FILE_SUFFIX = '.index-meta.xml';
const ROOT_ELEMENT = 'Index';
const DIR_NAME = 'indexes';

const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Pull `{ name, sortDirection }` rows out of the repeatable `<fields>` block.
 * Returns the indexed field names in document order.
 */
const indexedFields = (
  value: unknown,
): Array<{ name: string; sortDirection: string | null }> => {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out: Array<{ name: string; sortDirection: string | null }> = [];
  for (const entry of arr) {
    if (typeof entry === 'object' && entry !== null) {
      const obj = entry as Record<string, unknown>;
      const name = unwrapSingle(obj['name']);
      if (name !== undefined && name !== null) {
        const dir = unwrapSingle(obj['sortDirection']);
        out.push({
          name: String(name),
          sortDirection: dir === undefined || dir === null ? null : String(dir),
        });
      }
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
 * Extract a Node and edges from a single `*.index-meta.xml` file.
 *
 * Emits one `Index` Node, one `parentOf` edge from the enclosing CustomObject,
 * and one `references` edge per distinct indexed field (sorted by `toId`).
 * Removing an indexed field breaks the custom index, so the reference matters
 * for delete-safety reasoning.
 *
 * @example
 *   const r = await extractCustomIndex('.../objects/SyncTable_DegreeProgram__b/indexes/Standard_Index.index-meta.xml');
 *   // r.value.nodes[0].id === 'Index:SyncTable_DegreeProgram__b.Standard_Index'
 */
export const extractCustomIndex = async (
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
  const fields = indexedFields(rootObj['fields']);

  const parentId = `CustomObject:${objectApiName}`;
  const nodeId = `${ROOT_ELEMENT}:${objectApiName}.${apiName}`;

  const node: Node = {
    id: nodeId,
    type: 'Index',
    apiName,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: { label, fields },
  };

  const parentEdge: Edge = {
    fromId: parentId,
    toId: nodeId,
    edgeType: 'parentOf',
    confidence: 'declared',
    source: 'custom-index-extractor',
    properties: {},
  };

  const fieldEdges: Edge[] = [...new Set(fields.map((f) => f.name))]
    .map((field) => ({
      fromId: nodeId,
      toId: `CustomField:${objectApiName}.${field}`,
      edgeType: 'references' as const,
      confidence: 'declared' as const,
      source: 'custom-index-extractor',
      properties: {},
    }))
    .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));

  return ok({ nodes: [node], edges: [parentEdge, ...fieldEdges] });
};
