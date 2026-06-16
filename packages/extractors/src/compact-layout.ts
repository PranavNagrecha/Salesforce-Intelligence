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

const FILE_SUFFIX = '.compactLayout-meta.xml';
const ROOT_ELEMENT = 'CompactLayout';
const DIR_NAME = 'compactLayouts';

/** Unwrap a possibly-array single-occurrence XML child. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Coerce a repeatable XML element to a string array (single value → one-element array). */
const asStringArray = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => String(v)).filter((s) => s.length > 0);
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
 * Extract a Node and edges from a single `*.compactLayout-meta.xml` file.
 *
 * Emits one `CompactLayout` Node, one `parentOf` edge from the enclosing
 * CustomObject, and one `usedInLayout` edge per distinct `<fields>` entry
 * (sorted by `toId` for determinism), so a compact layout counts as a real
 * dependent when asking whether a field is safe to delete.
 *
 * @example
 *   const r = await extractCompactLayout('.../objects/Case_Log__c/compactLayouts/Case_Log_Compact_Layout.compactLayout-meta.xml');
 *   // r.value.nodes[0].id === 'CompactLayout:Case_Log__c.Case_Log_Compact_Layout'
 */
export const extractCompactLayout = async (
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
  const fields = asStringArray(rootObj['fields']);

  const parentId = `CustomObject:${objectApiName}`;
  const nodeId = `${ROOT_ELEMENT}:${objectApiName}.${apiName}`;

  const node: Node = {
    id: nodeId,
    type: 'CompactLayout',
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
    source: 'compact-layout-extractor',
    properties: {},
  };

  const fieldEdges: Edge[] = [...new Set(fields)]
    .map((field) => ({
      fromId: nodeId,
      toId: `CustomField:${objectApiName}.${field}`,
      edgeType: 'usedInLayout' as const,
      confidence: 'declared' as const,
      source: 'compact-layout-extractor',
      properties: {},
    }))
    .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));

  return ok({ nodes: [node], edges: [parentEdge, ...fieldEdges] });
};
