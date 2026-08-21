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

const NETWORK_FILE_SUFFIX = '.network-meta.xml';
const ROOT_ELEMENT = 'Network';
const EXTRACTOR_SOURCE = 'network-extractor';

/** Unwrap fast-xml-parser's array-or-scalar shape for single-occurrence children. */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) ? value[0] : value;

/** Return `<element>` value as a string, or `null` when absent. */
const optionalString = (rootObj: Record<string, unknown>, key: string): string | null => {
  const raw = unwrapSingle(rootObj[key]);
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
};

/**
 * Read a `<element>` as a tri-state boolean: `true`/`false` for the literal
 * XML values, `null` when the element is absent (never fabricated as false —
 * absence is disclosed, not silently defaulted, per the honesty rules).
 */
const optionalBoolean = (rootObj: Record<string, unknown>, key: string): boolean | null => {
  const raw = unwrapSingle(rootObj[key]);
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null;
};

/**
 * Normalize a fast-xml-parser child into an array. Returns `[]` for
 * undefined/null, the value itself when already an array, or a
 * single-element array otherwise.
 */
const toArray = (value: unknown): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
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
 * Extract a `Network` Node from a single Salesforce `*.network-meta.xml`
 * file — the Experience Cloud / community DEFINITION node, and the anchor
 * of the community family (`Network` → `CustomSite` → `ExperienceBundle`).
 *
 * The community's security posture lives here. Surfaced as properties:
 *   - `status` (`Live` | `UnderConstruction` | `DownForMaintenance`) — a
 *     `Live` community is publicly reachable.
 *   - `selfRegistration` (the CRITICAL security property — when `true`,
 *     unauthenticated visitors can create their own login).
 *   - `selfRegProfile` (`<selfRegProfile>` — the Profile a self-registered
 *     visitor is CREATED AS, i.e. what self-registration actually GRANTS).
 *     Tri-state like the switches: a string when declared, `null` when the
 *     element is absent. `selfRegistration: true` with a `null`
 *     `selfRegProfile` is a real and distinct state (the site self-registers
 *     through a custom Apex registration handler, or the profile is resolved
 *     at runtime) — it is NEVER collapsed into "no self-registration profile".
 *   - the guest-access switches present in the retrieved XML:
 *     `enableGuestFileAccess`, `enableGuestChatter`,
 *     `enableGuestMemberVisibility`, `allowInternalUserLogin`. Each is
 *     tri-state: an ABSENT switch is `null` ("not declared"), never a
 *     fabricated `false`.
 *   - `urlPathPrefix` (the community's public URL segment) and the counts
 *     of declared `<networkMemberGroups>` member profiles / permission sets.
 *
 * DECLARED `references` edges wire the family together when the source names
 * them: `<site>` → `CustomSite:{name}` (the Force.com/community site container)
 * and `<picassoSite>` → `ExperienceBundle:{name}` (the Builder page tree), plus
 * one edge per `<networkMemberGroups>` member `<profile>` → `Profile:{name}` and
 * `<permissionSet>` → `PermissionSet:{name}`, plus `<selfRegProfile>` →
 * `Profile:{name}` (`properties.via: 'selfRegProfile'`) — the "who can sign
 * themselves up, and AS WHAT" linkage. All are dangling-by-design when the
 * referenced component was not retrieved into the vault (impact tools surface
 * that gap).
 *
 * NETWORK-DROPS-SELFREGPROFILE: the self-registration profile is frequently ALSO
 * a declared member profile, and the `edges` primary key is
 * `(fromId, toId, edgeType, source)` — a second `Network → Profile:X` row would
 * COLLIDE on import and one of the two would silently win. So when the target
 * already carries a member edge the existing row is kept in place and marked
 * `alsoSelfRegProfile: true` rather than duplicated; only a self-reg profile
 * that is NOT a declared member mints its own `via: 'selfRegProfile'` row.
 *
 * The guest USER PROFILE is NOT referenced from here — that linkage is a naming
 * convention keyed off the `CustomSite` label, emitted (heuristic) by the
 * CustomSite extractor. `<networkMemberGroups>` names are the community's MEMBER
 * (authenticated) profiles / permission sets, a different population from the
 * guest user. Each `<profile>` / `<permissionSet>` value is the component's
 * api-name (the profile fullName — which may contain spaces, e.g.
 * `Partner Community User` — and the permission-set developerName), i.e. the
 * exact stem used to form the `Profile:` / `PermissionSet:` node id, so it is
 * wired as a declared edge (and still counted). Answering "who can access this
 * community?" and Profile/PermissionSet usages now reach the Network.
 *
 * Error cases mirror the other declarative extractors: `file-not-found`,
 * `parse-error`, `malformed-input` (root not `<Network>`).
 *
 * @example
 *   const r = await extractNetwork('…/networks/MemberPortal.network-meta.xml');
 *   if (r.ok) console.log(r.value.nodes[0].properties.selfRegistration);
 */
export const extractNetwork = async (
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

  const apiName = deriveComponentApiName(path, NETWORK_FILE_SUFFIX);
  const site = optionalString(rootObj, 'site');
  const picassoSite = optionalString(rootObj, 'picassoSite');
  // NETWORK-DROPS-SELFREGPROFILE: `<selfRegProfile>` names the Profile a
  // self-registered visitor is created as. It was parsed past and dropped, so
  // "self-registration is ON" shipped with no answer to "as WHAT?".
  const selfRegProfile = optionalString(rootObj, 'selfRegProfile');

  // Collect declared member profiles / permission sets (the community's
  // AUTHENTICATED member population, distinct from the guest user). Each value
  // is the component's api-name (profile fullName / permission-set
  // developerName) — the exact stem of its `Profile:` / `PermissionSet:` node
  // id — so it is both counted AND wired as a declared edge below.
  const memberGroups = unwrapSingle(rootObj['networkMemberGroups']);
  const memberGroupsObj =
    typeof memberGroups === 'object' && memberGroups !== null
      ? (memberGroups as Record<string, unknown>)
      : {};
  const asMemberNames = (raw: unknown): string[] =>
    toArray(raw)
      .filter((v) => v !== undefined && v !== null && v !== '')
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
  const memberProfiles = asMemberNames(memberGroupsObj['profile']);
  const memberPermissionSets = asMemberNames(memberGroupsObj['permissionSet']);
  const memberProfileCount = memberProfiles.length;
  const memberPermissionSetCount = memberPermissionSets.length;

  const node: Node = {
    id: `${ROOT_ELEMENT}:${apiName}`,
    type: 'Network',
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: path,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      status: optionalString(rootObj, 'status'),
      selfRegistration: optionalBoolean(rootObj, 'selfRegistration'),
      selfRegProfile,
      enableGuestFileAccess: optionalBoolean(rootObj, 'enableGuestFileAccess'),
      enableGuestChatter: optionalBoolean(rootObj, 'enableGuestChatter'),
      enableGuestMemberVisibility: optionalBoolean(rootObj, 'enableGuestMemberVisibility'),
      allowInternalUserLogin: optionalBoolean(rootObj, 'allowInternalUserLogin'),
      urlPathPrefix: optionalString(rootObj, 'urlPathPrefix'),
      site,
      picassoSite,
      memberProfileCount,
      memberPermissionSetCount,
      memberProfiles,
      memberPermissionSets,
    },
  };

  const edges: Edge[] = [];
  if (site !== null) {
    edges.push({
      fromId: node.id,
      toId: `CustomSite:${site}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { via: 'site' },
    });
  }
  if (picassoSite !== null) {
    edges.push({
      fromId: node.id,
      toId: `ExperienceBundle:${picassoSite}`,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { via: 'picassoSite' },
    });
  }

  // Wire each `<networkMemberGroups>` member profile / permission set as a
  // DECLARED reference. These are the community's authenticated members, so
  // "who can access this community?" and Profile / PermissionSet usages resolve
  // to the Network. De-duplicated per target id (a group can repeat a name).
  // Dangling-by-design when the profile / permission set was not retrieved.
  const seenMemberTargets = new Set<string>();
  for (const profileName of memberProfiles) {
    const toId = `Profile:${profileName}`;
    if (seenMemberTargets.has(toId)) continue;
    seenMemberTargets.add(toId);
    edges.push({
      fromId: node.id,
      toId,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { via: 'memberProfile' },
    });
  }
  for (const permSetName of memberPermissionSets) {
    const toId = `PermissionSet:${permSetName}`;
    if (seenMemberTargets.has(toId)) continue;
    seenMemberTargets.add(toId);
    edges.push({
      fromId: node.id,
      toId,
      edgeType: 'references',
      confidence: 'declared',
      source: EXTRACTOR_SOURCE,
      properties: { via: 'memberPermissionSet' },
    });
  }

  // NETWORK-DROPS-SELFREGPROFILE: wire the self-registration profile as a
  // DECLARED reference — for a community with `selfRegistration: true` this is
  // the "who can sign themselves up, and AS WHAT" answer. Emitted AFTER the
  // member loops so an existing member edge to the same Profile keeps its
  // position (the edges primary key is (fromId, toId, edgeType, source), so a
  // duplicate row would collide on import); that row is marked
  // `alsoSelfRegProfile: true` instead of being duplicated or overwritten.
  if (selfRegProfile !== null) {
    const selfRegTargetId = `Profile:${selfRegProfile}`;
    const existingIndex = edges.findIndex((e) => e.toId === selfRegTargetId);
    if (existingIndex === -1) {
      edges.push({
        fromId: node.id,
        toId: selfRegTargetId,
        edgeType: 'references',
        confidence: 'declared',
        source: EXTRACTOR_SOURCE,
        properties: { via: 'selfRegProfile' },
      });
    } else {
      const existing = edges[existingIndex] as Edge;
      edges[existingIndex] = {
        ...existing,
        properties: { ...existing.properties, alsoSelfRegProfile: true },
      };
    }
  }

  return ok({ nodes: [node], edges });
};
