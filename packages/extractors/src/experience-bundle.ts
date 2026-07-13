import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  ExtractionResult,
  ExtractorError,
  Node,
  Result,
} from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { deriveComponentApiName } from './path-utils.js';

const EXPERIENCE_BUNDLE_FILE_SUFFIX = '.site-meta.xml';
const ROOT_ELEMENT = 'ExperienceBundle';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
};

/** Read and strictly-validate a file as XML before the permissive parse pass. */
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
 * Best-effort count of the bundle's page views. The Builder page tree lives
 * in the SIBLING directory `experiences/{apiName}/views/*.json`; this counts
 * those files WITHOUT reading them (page-level content is out of scope — see
 * the extractor JSDoc). Returns `null` when the views directory is absent or
 * unreadable, so an unmeasured count is never fabricated as `0`.
 */
const countBundlePages = async (metaPath: string, apiName: string): Promise<number | null> => {
  const viewsDir = join(dirname(metaPath), apiName, 'views');
  try {
    const entries = await readdir(viewsDir);
    return entries.filter((name) => name.endsWith('.json')).length;
  } catch {
    return null;
  }
};

/**
 * Extract an `ExperienceBundle` Node from a single Salesforce Experience
 * Cloud bundle's TOP-LEVEL meta file (`experiences/{Name}.site-meta.xml`,
 * root `<ExperienceBundle>`).
 *
 * SCOPE (deliberately shallow): the bundle's real content is a large JSON
 * page tree (`experiences/{Name}/{config,views,routes,themes,...}/*.json`) —
 * hundreds of files describing every page, component, and audience rule.
 * That tree is EXPLICITLY OUT OF SCOPE: this extractor models only the
 * bundle's EXISTENCE and top-level meta (`label`, `type`, `urlPathPrefix`)
 * plus a best-effort `pageCount` (a count of `views/*.json`, no content
 * parsed) so the community's page tree is sized but not enumerated. Audience
 * / page / component parsing is not attempted.
 *
 * Node-only: the community's wiring (`Network` → `ExperienceBundle` via
 * `<picassoSite>`) is a `references` edge emitted by the `Network` extractor,
 * so this bundle produces no outgoing edges.
 *
 * NOTE: `ExperienceBundle` shares the `.site-meta.xml` file suffix with
 * `CustomSite` — the two are told apart by directory (`experiences/` vs
 * `sites/`) at dispatch, and by root element (`<ExperienceBundle>` vs
 * `<CustomSite>`) here; a `sites/` file whose root is `<ExperienceBundle>`
 * (or vice versa) is `malformed-input` for this extractor.
 *
 * Error cases mirror the other declarative extractors: `file-not-found`,
 * `parse-error`, `malformed-input` (root not `<ExperienceBundle>`).
 *
 * @example
 *   const r = await extractExperienceBundle('…/experiences/MemberPortal1.site-meta.xml');
 *   if (r.ok) console.log(r.value.nodes[0].properties.type); // 'ChatterNetworkPicasso'
 */
export const extractExperienceBundle = async (
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

  const apiName = deriveComponentApiName(path, EXPERIENCE_BUNDLE_FILE_SUFFIX);
  const label = optionalString(rootObj, 'label');
  const pageCount = await countBundlePages(path, apiName);

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'ExperienceBundle',
    apiName,
    label: label ?? apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      bundleLabel: label,
      type: optionalString(rootObj, 'type'),
      urlPathPrefix: optionalString(rootObj, 'urlPathPrefix'),
      pageCount,
      // Honest scope marker: page-level content (views/routes/components) is
      // NOT modeled — only the bundle's meta + a page count.
      pageContentModeled: false,
    },
  };

  return ok({ nodes: [node], edges: [] });
};
