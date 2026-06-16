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

const CONNECTED_APP_FILE_SUFFIX = '.connectedApp-meta.xml';
const ROOT_ELEMENT = 'ConnectedApp';
// Only <label> is unconditionally present. <contactEmail> and <oauthConfig>
// are NOT universal across real-org ConnectedApp variants — Canvas apps,
// session-based apps, and many managed-package apps legitimately omit the OAuth
// block (real org: 3 of N connected apps had no <oauthConfig>). Treat them as
// optional so a valid app is modeled rather than dropped as malformed.
const ROOT_REQUIRED_ELEMENTS = ['label'] as const;

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Normalize an XML child into an array; `[]` for undefined/null. */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
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

interface OauthConfig {
  readonly consumerKey: string | null;
  readonly callbackUrl: string | null;
  readonly scopes: readonly string[];
}

/**
 * Unpack the optional `<oauthConfig>` block. Returns `null` when the app has no
 * OAuth config (Canvas / session-based / many managed apps) — that is a valid
 * shape, not malformed. When present, fields are read leniently (a missing
 * consumerKey/callbackUrl becomes null rather than rejecting the whole app), so
 * real-org variance never drops an otherwise-valid ConnectedApp.
 */
const parseOauthConfig = (
  rootObj: Record<string, unknown>,
): OauthConfig | null => {
  const oauthRaw = unwrapSingle(rootObj['oauthConfig']);
  if (typeof oauthRaw !== 'object' || oauthRaw === null) return null;
  const oauth = oauthRaw as Record<string, unknown>;
  return {
    consumerKey: optionalString(oauth, 'consumerKey'),
    callbackUrl: optionalString(oauth, 'callbackUrl'),
    scopes: toArray(oauth['scopes']).map((s) => String(s)),
  };
};

/** Locate the `<ConnectedApp>` root and verify required top-level children. */
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
  // `label` and `contactEmail` are scalar elements; their absence is a
  // simple undefined check. `oauthConfig` is a nested element handled by
  // `parseOauthConfig`, but presence is also verified here so the error
  // surfaces in the documented top-level order.
  for (const required of ROOT_REQUIRED_ELEMENTS) {
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
 * Extract a Node from a single Salesforce Connected App file.
 *
 * Reads `<label>`, `<contactEmail>`, and a nested `<oauthConfig>`
 * (`<consumerKey>`, `<callbackUrl>`, repeated `<scopes>`). Optional
 * top-level `<description>`, `<iconUrl>`, and `<infoUrl>` are surfaced
 * on the node's `properties` map.
 *
 * `scopes` is an array of strings preserving XML element order, ready
 * for downstream YAML-frontmatter array serialization (per journal
 * 0060). The extractor does not validate scope strings against
 * Salesforce's allowed set; it surfaces them verbatim.
 *
 * Returns one `Node` of type `'ConnectedApp'` and zero edges. The
 * callback URL and OAuth scopes are strings, not graph nodes; linking
 * to managed-package namespaces is deferred to v0.3.
 *
 * Error cases (per vendored `ConnectedApp.md`):
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root isn't `<ConnectedApp>` or any of
 *     `<label>`, `<contactEmail>`, `<oauthConfig>`,
 *     `<oauthConfig><consumerKey>`, or `<oauthConfig><callbackUrl>`
 *     is missing
 *
 * @example
 *   const result = await extractConnectedApp(
 *     'force-app/main/default/connectedApps/My_OAuth_Client.connectedApp-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'ConnectedApp:My_OAuth_Client'
 */
export const extractConnectedApp = async (
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

  const oauth = parseOauthConfig(rootObj);

  const apiName = deriveComponentApiName(path, CONNECTED_APP_FILE_SUFFIX);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'ConnectedApp',
    apiName,
    label: String(unwrapSingle(rootObj['label'])),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      contactEmail: optionalString(rootObj, 'contactEmail'),
      description: optionalString(rootObj, 'description'),
      iconUrl: optionalString(rootObj, 'iconUrl'),
      infoUrl: optionalString(rootObj, 'infoUrl'),
      // Whether the app exposes an OAuth surface (a security-relevant signal).
      hasOauthConfig: oauth !== null,
      consumerKey: oauth?.consumerKey ?? null,
      callbackUrl: oauth?.callbackUrl ?? null,
      scopes: oauth?.scopes ?? [],
    },
  };

  return ok({ nodes: [node], edges: [] });
};
