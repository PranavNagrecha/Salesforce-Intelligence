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

const SAML_SSO_CONFIG_FILE_SUFFIX = '.samlssoconfig-meta.xml';
const ROOT_ELEMENT = 'SamlSsoConfig';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined ? null : String(raw);
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

/**
 * Extract a Node from a single Salesforce `*.samlssoconfig-meta.xml` file.
 *
 * The SAML SSO configuration is the authoritative source of WHICH User
 * field the IdP asserts as the login subject — its `<identityMapping>`
 * (`Username` | `FederationId` | `UserId`; Salesforce defaults to
 * `Username` when the element is absent). The value-change tier reads this
 * to gate the `FederationIdentifier` verdict: only an org that maps SSO by
 * `FederationId` makes a change to that field break login. Without this
 * node the value-change tools cannot tell "FederationIdentifier is the SSO
 * key" from "FederationIdentifier is an unused column".
 *
 * Surfaces `identityMapping`, `identityLocation`, `issuer`, `samlEntityId`,
 * and `samlJitHandlerId` as properties. Emits one `SamlSsoConfig` node and
 * zero edges (the `samlJitHandlerId` names an ApexClass but, like
 * AuthProvider's registration handler, is left as a property binding).
 *
 * Error cases mirror the other declarative extractors: `file-not-found`,
 * `parse-error`, `malformed-input` (root not `<SamlSsoConfig>`).
 *
 * @example
 *   const r = await extractSamlSsoConfig('…/samlssoconfigs/EC_SSO.samlssoconfig-meta.xml');
 *   if (r.ok) console.log(r.value.nodes[0].properties.identityMapping); // 'FederationId'
 */
export const extractSamlSsoConfig = async (
  path: string,
): Promise<Result<ExtractionResult, ExtractorError>> => {
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
    return err({ kind: 'malformed-input', path, message: `expected <${ROOT_ELEMENT}> root` });
  }
  const rootObj = root as Record<string, unknown>;

  const apiName = deriveComponentApiName(path, SAML_SSO_CONFIG_FILE_SUFFIX);
  // Salesforce defaults the SAML Identity Type to Username when the element
  // is absent; preserve that default so an absent mapping isn't read as "no
  // identity" (which would wrongly clear the Username SSO coupling).
  const identityMapping = optionalString(rootObj, 'identityMapping') ?? 'Username';

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'SamlSsoConfig',
    apiName,
    label: optionalString(rootObj, 'samlEntityId'),
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      identityMapping,
      identityLocation: optionalString(rootObj, 'identityLocation'),
      issuer: optionalString(rootObj, 'issuer'),
      samlEntityId: optionalString(rootObj, 'samlEntityId'),
      samlJitHandlerId: optionalString(rootObj, 'samlJitHandlerId'),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
