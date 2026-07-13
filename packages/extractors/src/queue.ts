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

const QUEUE_FILE_SUFFIX = '.queue-meta.xml';
const ROOT_ELEMENT = 'Queue';
const EXTRACTOR_SOURCE = 'queue-extractor';
const REQUIRED_ELEMENTS = ['name', 'doesSendEmailToMembers'] as const;

/**
 * Unwrap a possibly-array single-occurrence XML child. fast-xml-parser
 * returns an array when an element appears multiple times and a
 * scalar/object otherwise. Single-occurrence Queue elements
 * (`<name>`, `<doesSendEmailToMembers>`, etc.) use this helper.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a single-element
 * array otherwise. Used for `<queueSobject>` and `<members>` which may
 * appear zero, one, or many times.
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
  return raw === undefined ? null : String(raw);
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

/** Locate the `<Queue>` root and verify required children per `Queue.md`. */
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
 * Walk the `<queueSobject>` rows and return the ordered list of distinct
 * `<sobjectType>` values. Duplicates are folded to a single entry per
 * `Queue.md` ("emit at most one edge per `(queue, sobjectType)` pair").
 * Returns a `malformed-input` error when any row is missing
 * `<sobjectType>`.
 */
const collectSobjectTypes = (
  rootObj: Record<string, unknown>,
  path: string,
): Result<{ readonly sobjectTypes: readonly string[]; readonly rowCount: number }, ExtractorError> => {
  const rows = toArray(rootObj['queueSobject']);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <sobjectType>',
      });
    }
    const sobjectTypeRaw = unwrapSingle(
      (row as Record<string, unknown>)['sobjectType'],
    );
    if (sobjectTypeRaw === undefined) {
      return err({
        kind: 'malformed-input',
        path,
        message: 'missing required element: <sobjectType>',
      });
    }
    const sobjectType = String(sobjectTypeRaw);
    if (seen.has(sobjectType)) continue;
    seen.add(sobjectType);
    ordered.push(sobjectType);
  }
  return ok({ sobjectTypes: ordered, rowCount: rows.length });
};

/**
 * Extract a Node and edges from a single Salesforce `*.queue-meta.xml`
 * file.
 *
 * Reads the file, parses it as XML, validates the `<Queue>` root per the
 * vendored `Queue.md` spec, and returns an `ExtractionResult` containing
 * one `Node` of type `'Queue'` and one `sharedWith` edge per distinct
 * `<sobjectType>` (with `edge.properties.relationship = 'queueOwner'`).
 * Duplicate `<queueSobject>` rows targeting the same `sobjectType` are
 * deduplicated.
 *
 * The canonical ID derives from the filename, not from the `<name>`
 * element. `<name>` is the human-readable display label; the filename's
 * basename (minus `.queue-meta.xml`) is the API name.
 *
 * v1.1 does **not** turn `<members>` rows into edges — deep member
 * resolution is deferred to v1.2. The extractor only surfaces the row
 * count in `properties.memberCount`. `<queueRoutingConfig>`, when present,
 * is read into `properties.queueRoutingConfig` (a bare string) AND (R6-18)
 * emits a declared `references` edge to `QueueRoutingConfig:{Name}`
 * (`edge.properties.referenceKind = 'queueRoutingConfig'`) — Omni-Channel's
 * "how are cases routed to agents" walks this edge from the Queue to its
 * routing behavior. Verified against a real Queue file from a live org.
 *
 * Returns an `ExtractorError` for any of the documented failure modes:
 * `file-not-found`, `parse-error`, or `malformed-input` (wrong root,
 * missing `<name>` or `<doesSendEmailToMembers>`, or any
 * `<queueSobject>` row missing `<sobjectType>`).
 *
 * @example
 *   const result = await extractQueue(
 *     'force-app/main/default/queues/Tier1_Support.queue-meta.xml',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.nodes[0].id);
 *     // => 'Queue:Tier1_Support'
 *   }
 */
export const extractQueue = async (
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
  // cap). Catch it here so a single pathological file becomes a
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

  const apiName = deriveComponentApiName(path, QUEUE_FILE_SUFFIX);
  const nodeId = `${ROOT_ELEMENT}:${apiName}`;
  const label = String(unwrapSingle(rootObj['name']));

  const sobjectResult = collectSobjectTypes(rootObj, path);
  if (!sobjectResult.ok) return sobjectResult;
  const { sobjectTypes, rowCount } = sobjectResult.value;

  // v1.2 member resolution: navigate <queueMembers><users><user> to count
  // and identify named-user members declared in the metadata. The XML path
  // is NOT the legacy `<members>` flat list — that element is absent in
  // real org exports; the actual structure wraps users under:
  //   <queueMembers>
  //     <users>
  //       <user>username@example.com</user>
  //     </users>
  //   </queueMembers>
  const queueMembersBlock = unwrapSingle(rootObj['queueMembers']);
  const usersBlock =
    typeof queueMembersBlock === 'object' && queueMembersBlock !== null
      ? unwrapSingle((queueMembersBlock as Record<string, unknown>)['users'])
      : undefined;
  const memberUserRaws: unknown[] =
    typeof usersBlock === 'object' && usersBlock !== null
      ? toArray((usersBlock as Record<string, unknown>)['user'])
      : [];
  const memberEmails: string[] = memberUserRaws
    .map((u) => (u !== null && u !== undefined ? String(u).trim() : ''))
    .filter((s) => s.length > 0);
  const memberCount = memberEmails.length;

  const node: Node = {
    id: nodeId,
    type: 'Queue',
    apiName,
    label,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      description: optionalString(rootObj, 'description'),
      email: optionalString(rootObj, 'email'),
      doesSendEmailToMembers: coerceBoolean(
        unwrapSingle(rootObj['doesSendEmailToMembers']),
      ),
      doesIncludeBosses: coerceBoolean(unwrapSingle(rootObj['doesIncludeBosses'])),
      queueRoutingConfig: optionalString(rootObj, 'queueRoutingConfig'),
      sobjectTypeCount: rowCount,
      memberCount,
      memberEmails,
    },
  };

  // hasMember edges for each declared user member (v1.2).
  // Target id is `User:{email}` — dangling by design (there is no User
  // ComponentType vault node), consistent with the group-membership extractor.
  const memberEdges: Edge[] = memberEmails.map((email) => ({
    fromId: nodeId,
    toId: `User:${email}`,
    edgeType: 'hasMember' as const,
    confidence: 'declared' as const,
    source: EXTRACTOR_SOURCE,
    properties: { memberKind: 'user' },
  }));

  const edges: Edge[] = sobjectTypes.map((sobjectType) => ({
    fromId: nodeId,
    toId: `CustomObject:${sobjectType}`,
    edgeType: 'sharedWith' as const,
    confidence: 'declared' as const,
    source: EXTRACTOR_SOURCE,
    properties: { relationship: 'queueOwner' },
  }));

  // R6-18: `<queueRoutingConfig>` was already read into
  // `properties.queueRoutingConfig` (a bare string) but never turned into an
  // edge. Verified against a real Queue file from a live org
  // (`<queueRoutingConfig>cases_Routing_config</queueRoutingConfig>`
  // resolving to a real `QueueRoutingConfig` fullName retrieved from the same
  // org) — the value is a declared metadata pointer, not a heuristic guess.
  // Queues REFERENCE routing configs, never the reverse; the routing config
  // file itself carries no back-pointer to the queues that use it.
  const routingConfigEdges: Edge[] =
    rootObj['queueRoutingConfig'] !== undefined
      ? [
          {
            fromId: nodeId,
            toId: `QueueRoutingConfig:${String(unwrapSingle(rootObj['queueRoutingConfig']))}`,
            edgeType: 'references' as const,
            confidence: 'declared' as const,
            source: EXTRACTOR_SOURCE,
            properties: { referenceKind: 'queueRoutingConfig' },
          },
        ]
      : [];

  return ok({
    nodes: [node],
    edges: [...edges, ...memberEdges, ...routingConfigEdges],
  });
};
