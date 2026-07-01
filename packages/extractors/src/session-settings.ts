import { readFile } from 'node:fs/promises';

import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const ROOT_ELEMENT = 'SessionSettings';

/** Fixed org-level id — a single SessionSettings node per org, no parent scope. */
const NODE_ID = 'SessionSettings:default';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/**
 * Read a `<Foo>true</Foo>` boolean element. Returns `true` only when the
 * element is present and its trimmed value is exactly `"true"`; `false` for
 * an explicit `"false"`; and `null` when the element is absent (so callers
 * can distinguish "policy disabled" from "policy not declared in this org").
 */
const optionalBoolean = (rootObj: Record<string, unknown>, key: string): boolean | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined) return null;
  return String(raw) === 'true';
};

/**
 * Read a numeric element (e.g. `<sessionTimeout>480</sessionTimeout>`).
 * Returns the parsed integer, or `null` when the element is absent or not a
 * finite number. Session timeout in the metadata is expressed in minutes.
 */
const optionalMinutes = (rootObj: Record<string, unknown>, key: string): number | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined) return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : null;
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

/**
 * Extract the org-wide session-security policy from the single
 * `settings/Session.settings-meta.xml` file (root element
 * `<SessionSettings>`; Salesforce delivers it under the generic `Settings`
 * container directory rather than a dedicated type directory).
 *
 * SessionSettings is an ORG-LEVEL metadata singleton — there is exactly one
 * per org — so this extractor emits one `Node` with the fixed id
 * `SessionSettings:default` and zero edges (the policy is org-wide; it has no
 * inter-component references).
 *
 * The three properties surfaced are the ones the profile-security tier reads:
 *   - `mfaRequired` — from `<MFARequired>` (Salesforce's org-wide
 *     multi-factor-auth requirement for UI logins).
 *   - `requiresStrongAuth` — from
 *     `<enableRequiredStrongAuthForUILogins>` (the "require high-assurance
 *     session for UI logins" policy).
 *   - `sessionTimeoutMinutes` — from `<sessionTimeout>` (idle-session
 *     timeout, in minutes).
 *
 * Each is `null` when its element is absent, so a downstream consumer can
 * distinguish "policy disabled" (`false` / a value) from "policy not declared
 * in this org's retrieved metadata" (`null`). The extractor surfaces the
 * source faithfully and does NOT validate the values (e.g. it does not check
 * that `sessionTimeout` is one of Salesforce's allowed discrete minutes).
 *
 * Error cases:
 *   - `file-not-found` if the file is missing
 *   - `parse-error` if the XML is malformed
 *   - `malformed-input` if the root element isn't `<SessionSettings>`
 *
 * @example
 *   const result = await extractSessionSettings(
 *     'force-app/main/default/settings/Session.settings-meta.xml',
 *   );
 *   if (result.ok) console.log(result.value.nodes[0].id);
 *   // => 'SessionSettings:default'
 */
export const extractSessionSettings = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const xmlResult = await readAndValidateXml(path);
  if (!xmlResult.ok) return xmlResult;

  // Local trusted disk content; XXE not a concern. The default entity-
  // expansion cap is raised to mirror the other settings-tier extractors.
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

  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  if (typeof root !== 'object' || root === null) {
    return err({
      kind: 'malformed-input',
      path,
      message: `expected <${ROOT_ELEMENT}> root`,
    });
  }
  const rootObj = root as Record<string, unknown>;

  const node: Node = {
    id: NODE_ID,
    type: 'SessionSettings',
    // The org-level singleton has no meaningful API name of its own; both
    // `apiName` and `label` use the stable `SessionSettings` moniker so the
    // node renders and resolves consistently.
    apiName: 'SessionSettings',
    label: 'Session Settings',
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      mfaRequired: optionalBoolean(rootObj, 'MFARequired'),
      requiresStrongAuth: optionalBoolean(rootObj, 'enableRequiredStrongAuthForUILogins'),
      sessionTimeoutMinutes: optionalMinutes(rootObj, 'sessionTimeout'),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
