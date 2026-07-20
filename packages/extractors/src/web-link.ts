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

const FILE_SUFFIX = '.webLink-meta.xml';
const ROOT_ELEMENT = 'WebLink';
const DIR_NAME = 'webLinks';

/** Merge-field token: `{!Object.Field}` (relationship traversal tolerated). */
const MERGE_FIELD_RE = /\{!\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_.]*?)\s*\}/g;

/**
 * Flow-launch route inside a button/link URL: `/flow/{ApiName}` (classic) or
 * `/lightning/flow/{ApiName}` (the Lightning variant, whose substring also
 * matches this pattern). A Flow API name starts with a letter and contains
 * only letters, digits, and underscores, so the capture stops at the first
 * `?`, `/`, or other delimiter — leaving the query string out.
 */
const FLOW_URL_RE = /\/flow\/([A-Za-z][A-Za-z0-9_]*)/g;

/** Escape a literal string for safe interpolation into a `RegExp` source. */
const escapeRegExp = (literal: string): string =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

const toNullableString = (value: unknown): string | null => {
  const v = unwrapSingle(value);
  return v === undefined || v === null ? null : String(v);
};

/**
 * Heuristically pull field references off the OWNING object out of merge-field
 * tokens in the link's URL/content. Two classic merge-field shapes are read,
 * both restricted to the owning object so cross-object / global tokens
 * (`{!User.Manager}`, `{!$User.Id}`) can never produce a wrong-object edge:
 *
 *   1. **Dotted** — `{!{objectApiName}.<field>}` (a relationship path keeps
 *      only its first segment). e.g. Conga's `{!Account.Id}`.
 *   2. **Underscore** — `{!{objectApiName}_<field>}`, the legacy S-control /
 *      classic-button form. e.g. `{!Account_BillingStreet}` on Account. The
 *      capture is anchored on the literal `{objectApiName}_` prefix, so
 *      everything after that prefix (including a trailing `__c`) is the field.
 */
const ownObjectFieldRefs = (
  content: string,
  objectApiName: string,
): string[] => {
  const out = new Set<string>();
  for (const m of content.matchAll(MERGE_FIELD_RE)) {
    const obj = m[1];
    const fieldPath = m[2];
    if (obj === objectApiName && fieldPath !== undefined) {
      const field = fieldPath.split('.')[0];
      if (field !== undefined && field.length > 0) out.add(field);
    }
  }
  // Underscore form: anchor on `{!{objectApiName}_` and take the remaining
  // field token. A field API name starts with a letter and continues with
  // letters/digits/underscores (covering the `__c` custom suffix).
  const underscoreRe = new RegExp(
    `\\{!\\s*${escapeRegExp(objectApiName)}_([A-Za-z][A-Za-z0-9_]*)\\s*\\}`,
    'g',
  );
  for (const m of content.matchAll(underscoreRe)) {
    const field = m[1];
    if (field !== undefined && field.length > 0) out.add(field);
  }
  return [...out];
};

/**
 * Heuristically pull the API names of screen flows launched from a button/link
 * URL. Custom buttons whose URL is `/flow/{ApiName}?...` (or the Lightning
 * `/lightning/flow/{ApiName}` form) are the primary business entry point to a
 * screen flow; the launched flow is named in the route path. Distinct names,
 * in first-seen order; the caller re-sorts for deterministic output.
 */
const flowUrlRefs = (content: string): string[] => {
  const out = new Set<string>();
  for (const m of content.matchAll(FLOW_URL_RE)) {
    const apiName = m[1];
    if (apiName !== undefined && apiName.length > 0) out.add(apiName);
  }
  return [...out];
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
 * Extract a Node and edges from a single `*.webLink-meta.xml` file (an object
 * button/link).
 *
 * Emits one `WebLink` Node, one `parentOf` edge from the enclosing
 * CustomObject, and zero or more HEURISTIC `references` edges (sorted by
 * `toId`):
 *   - one per distinct own-object field named in a `{!Object.Field}` merge
 *     token in the URL. Cross-object and global merge tokens are ignored to
 *     avoid false positives.
 *   - one per distinct screen flow launched by a `/flow/{ApiName}` (or
 *     `/lightning/flow/{ApiName}`) route in the URL, targeting `Flow:{ApiName}`
 *     with `properties.targetKind: 'flow'`.
 *
 * All references are heuristic confidence (regex over the button URL).
 *
 * @example
 *   const r = await extractWebLink('.../objects/Opportunity/webLinks/SAP_Approval.webLink-meta.xml');
 *   // r.value.nodes[0].id === 'WebLink:Opportunity.SAP_Approval'
 */
export const extractWebLink = async (
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

  const labelRaw = unwrapSingle(rootObj['masterLabel']);
  const label = labelRaw === undefined ? apiName : String(labelRaw);
  const linkType = toNullableString(rootObj['linkType']);
  const displayType = toNullableString(rootObj['displayType']);
  const url = toNullableString(rootObj['url']);
  const page = toNullableString(rootObj['page']);

  const parentId = `CustomObject:${objectApiName}`;
  const nodeId = `${ROOT_ELEMENT}:${objectApiName}.${apiName}`;

  const node: Node = {
    id: nodeId,
    type: 'WebLink',
    apiName,
    label,
    parentId,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      label,
      linkType,
      displayType,
      openType: toNullableString(rootObj['openType']),
      url,
      page,
      description: toNullableString(rootObj['description']),
    },
  };

  const parentEdge: Edge = {
    fromId: parentId,
    toId: nodeId,
    edgeType: 'parentOf',
    confidence: 'declared',
    source: 'web-link-extractor',
    properties: {},
  };

  const fieldEdges: Edge[] = ownObjectFieldRefs(url ?? '', objectApiName)
    .map((field) => ({
      fromId: nodeId,
      toId: `CustomField:${objectApiName}.${field}`,
      edgeType: 'references' as const,
      confidence: 'heuristic' as const,
      source: 'web-link-extractor',
      properties: {},
    }))
    .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));

  const flowEdges: Edge[] = flowUrlRefs(url ?? '')
    .map((flowApiName) => ({
      fromId: nodeId,
      toId: `Flow:${flowApiName}`,
      edgeType: 'references' as const,
      confidence: 'heuristic' as const,
      source: 'web-link-extractor',
      properties: { targetKind: 'flow' },
    }))
    .sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));

  return ok({ nodes: [node], edges: [parentEdge, ...fieldEdges, ...flowEdges] });
};
