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

const CUSTOM_SITE_FILE_SUFFIX = '.site-meta.xml';
const ROOT_ELEMENT = 'CustomSite';
const EXTRACTOR_SOURCE = 'custom-site-extractor';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
};

/** Read a `<element>` as a tri-state boolean (`null` when absent — never fabricated). */
const optionalBoolean = (rootObj: Record<string, unknown>, key: string): boolean | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null;
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
 * The auto-provisioned guest-user profile a Salesforce Site owns is named
 * `"{Site Label} Profile"` — a NAMING CONVENTION, not a declared metadata
 * pointer. Verified against a real production org: each Site owns exactly
 * one `UserType='Guest'` profile named `"{that Site's label} Profile"`.
 *
 * This is the linchpin the guest-exposure audit resolves — but because the
 * XML carries NO `<guestProfile>` element, the linkage is HEURISTIC and the
 * edge it produces must carry `confidence: 'heuristic'` so downstream tools
 * disclose it rather than assert it.
 */
export const guestProfileNameForSite = (siteLabel: string): string =>
  `${siteLabel} Profile`;

/**
 * SITE-INDEXPAGE-AND-TEMPLATE-UNGRAPHED — the CustomSite metadata elements
 * that each name a `VisualforcePage` by API name. `<indexPage>` is the site's
 * entry point and `<siteTemplate>` its wrapper template; the remaining
 * elements are the standard error / special pages a site can override. A VF
 * page referenced ONLY as a site page carries no other inbound edge, so
 * without an edge here it reads as orphaned and `unused_components` /
 * `review_change` flags it deletable — deleting a live site's index or
 * template takes down the community entry point.
 *
 * Every element in this set is a VisualforcePage reference in the CustomSite
 * metadata type; `<favoriteIcon>` (a StaticResource, handled separately) and
 * non-page elements (`<subdomain>`, `<siteAdmin>`, …) are deliberately absent.
 */
const SITE_PAGE_ELEMENTS = [
  'indexPage',
  'siteTemplate',
  'changePasswordPage',
  'forgotPasswordPage',
  'fileNotFoundPage',
  'inMaintenancePage',
  'inactiveIndexPage',
  'myProfilePage',
  'selfRegPage',
  'serverIsDownPage',
  'authorizationRequiredPage',
  'bandwidthExceededPage',
  'genericErrorPage',
] as const;

/**
 * Extract a `CustomSite` Node from a single Salesforce `*.site-meta.xml`
 * file under `sites/` (the site container that fronts a Force.com site or an
 * Experience Cloud community — NOT the `experiences/` ExperienceBundle, which
 * shares the `.site-meta.xml` suffix but a different `<ExperienceBundle>`
 * root and is dispatched by directory).
 *
 * Surfaced as properties: `active` (a `false` site serves no pages),
 * `siteType` (`ChatterNetwork` = Experience Cloud, `Visualforce`/`null` =
 * classic Force.com site), `masterLabel` (the site's display label — the KEY
 * to the guest-profile convention), `urlPathPrefix`, and
 * `guestRecordDefaultOwner` (`<siteGuestRecordDefaultOwner>` — the user that
 * OWNS records a guest creates; security-relevant context).
 *
 * Emits ONE HEURISTIC `references` edge to the site's guest-user profile
 * (`Profile:{Site Label} Profile`, {@link guestProfileNameForSite}). The
 * edge carries `confidence: 'heuristic'` and
 * `properties.convention: 'site-guest-profile-naming'` because the linkage
 * is inferred from Salesforce's auto-naming, not declared in the source. The
 * target is dangling-by-design when the guest profile was not retrieved into
 * the vault — `guest_exposure_report` discloses that rather than treating an
 * absent profile as "no exposure".
 *
 * Emits ONE DECLARED `references` edge to the site's favicon StaticResource
 * (`StaticResource:{favoriteIcon}`, `properties.via: 'favoriteIcon'`) when
 * `<favoriteIcon>` is present — SITE-FAVICON-STATICRESOURCE-UNGRAPHED. Unlike
 * the guest-profile edge this is DECLARED (the XML names the resource
 * directly). Without it a resource referenced only by a site's favicon reads
 * as unused and `unused_components` flags it deletable.
 *
 * Error cases mirror the other declarative extractors: `file-not-found`,
 * `parse-error`, `malformed-input` (root not `<CustomSite>`).
 *
 * @example
 *   const r = await extractCustomSite('…/sites/MemberPortal.site-meta.xml');
 *   if (r.ok) console.log(r.value.edges[0].toId); // 'Profile:MemberPortal Profile'
 */
export const extractCustomSite = async (
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

  const apiName = deriveComponentApiName(path, CUSTOM_SITE_FILE_SUFFIX);
  const masterLabel = optionalString(rootObj, 'masterLabel');
  // The guest-profile convention keys off the site's LABEL; fall back to the
  // api name when the label is absent so a bare site still resolves a guess.
  const siteLabel = masterLabel ?? apiName;
  const guestProfileName = guestProfileNameForSite(siteLabel);
  // SITE-FAVICON-STATICRESOURCE-UNGRAPHED: `<favoriteIcon>` names a
  // StaticResource (the site's browser favicon). A resource referenced ONLY by
  // a site's favicon carries no other inbound edge, so without this edge it
  // reads as orphaned and `unused_components` flags it deletable — deleting it
  // breaks the live site favicon. Null when absent (never a dangling edge).
  const favoriteIcon = optionalString(rootObj, 'favoriteIcon');

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'CustomSite',
    apiName,
    label: masterLabel ?? apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      active: optionalBoolean(rootObj, 'active'),
      siteType: optionalString(rootObj, 'siteType'),
      masterLabel,
      urlPathPrefix: optionalString(rootObj, 'urlPathPrefix'),
      guestRecordDefaultOwner: optionalString(rootObj, 'siteGuestRecordDefaultOwner'),
      // The inferred guest-profile name, surfaced so a consumer can read the
      // convention without re-deriving it (kept in lock-step with the edge).
      guestProfileName,
      guestProfileConvention: 'heuristic',
      // SITE-FAVICON-STATICRESOURCE-UNGRAPHED: the favicon static-resource name
      // surfaced directly (null when absent), kept in lock-step with the edge.
      favoriteIcon,
    },
  };

  const edges: Edge[] = [
    {
      fromId: node.id,
      toId: `Profile:${guestProfileName}`,
      edgeType: 'references',
      confidence: 'heuristic',
      source: EXTRACTOR_SOURCE,
      properties: {
        via: 'guest-profile',
        convention: 'site-guest-profile-naming',
        siteLabel,
      },
    },
  ];

  // SITE-FAVICON-STATICRESOURCE-UNGRAPHED: emit the declared favicon ->
  // StaticResource edge. Declared confidence — `<favoriteIcon>` names the
  // resource directly (unlike the heuristic guest-profile naming convention
  // above). Dangling-tolerated when the resource was not retrieved.
  if (favoriteIcon !== null) {
    edges.push({
      fromId: node.id,
      toId: `StaticResource:${favoriteIcon}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { via: 'favoriteIcon' },
    });
  }

  // SITE-INDEXPAGE-AND-TEMPLATE-UNGRAPHED: emit a declared VisualforcePage
  // reference per site-page element (index / template / error pages). Declared
  // confidence — the element names the page directly (like `<favoriteIcon>`).
  // Dangling-tolerated when the page was not retrieved.
  for (const element of SITE_PAGE_ELEMENTS) {
    const pageName = optionalString(rootObj, element);
    if (pageName === null) continue;
    edges.push({
      fromId: node.id,
      toId: `VisualforcePage:${pageName}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { via: element },
    });
  }

  return ok({ nodes: [node], edges });
};
