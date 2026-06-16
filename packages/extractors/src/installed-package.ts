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

const INSTALLED_PACKAGE_FILE_SUFFIX = '.installedPackage-meta.xml';
const ROOT_ELEMENT = 'InstalledPackage';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Return `<element>` value as a string, or `null` when absent / xsi:nil. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object') return null; // e.g. `<activateRSS xsi:nil="true"/>` -> {}
  return String(raw);
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
 * Extract a Node from a single Salesforce InstalledPackage sidecar file.
 *
 * Each `installedPackages/<namespace>.installedPackage-meta.xml` describes one
 * managed or unlocked package installed in the org. The file's fullName (the
 * name before the suffix) IS the package's namespace prefix — the same prefix
 * managed-package components carry (`hed__Course__c` -> `hed`). `<versionNumber>`
 * is the installed version (e.g. `8.293`). InstalledPackage metadata is tiny, so
 * it is always retrieved; it grounds "what packages are installed?" and the
 * managed-extension taxonomy with REAL version + namespace data instead of
 * inferring the namespace from component prefixes alone.
 *
 * Returns one `Node` of type `'InstalledPackage'` and zero edges. `versionNumber`
 * is `null` when absent (a beta/managed-1GP package can omit it).
 *
 * @example
 *   const r = await extractInstalledPackage('…/installedPackages/hed.installedPackage-meta.xml');
 *   if (r.ok) console.log(r.value.nodes[0].id); // => 'InstalledPackage:hed'
 */
export const extractInstalledPackage = async (
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

  // A `<InstalledPackage>` root is required, but it may be empty/self-closing
  // (`<InstalledPackage/>` parses to '') — that is still a valid package node
  // with a null version, NOT malformed. Only a missing/wrong root is malformed.
  if (parsed[ROOT_ELEMENT] === undefined) {
    return err({ kind: 'malformed-input', path, message: `expected <${ROOT_ELEMENT}> root` });
  }
  const root = unwrapSingle(parsed[ROOT_ELEMENT]);
  const rootObj: Record<string, unknown> =
    typeof root === 'object' && root !== null ? (root as Record<string, unknown>) : {};

  const namespace = deriveComponentApiName(path, INSTALLED_PACKAGE_FILE_SUFFIX);
  const node: Node = {
    id: `${ROOT_ELEMENT}:${namespace}`,
    type: 'InstalledPackage',
    apiName: namespace,
    label: namespace,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      namespace,
      versionNumber: optionalString(rootObj, 'versionNumber'),
    },
  };

  return ok({ nodes: [node], edges: [] });
};
