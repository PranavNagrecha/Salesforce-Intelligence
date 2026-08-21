/**
 * Handler for the `sfi.community_catalog` MCP tool.
 *
 * "What Experience Cloud communities / sites does this org have, and WHO CAN
 * LOG INTO them?" — the offline-metadata half of the community question, which
 * had no home before: the router sent it to a LIVE inactive-user roster tool
 * that answered with a consent error, and `guest_exposure_report` answers only
 * the UNAUTHENTICATED (guest) half.
 *
 * This tool COMPOSES what the community extractors already put on disk rather
 * than adding a plane:
 *   - `Network` — the community DEFINITION: `status`, `urlPathPrefix`, the
 *     `networkMemberGroups` member profiles / permission sets (the
 *     AUTHENTICATED population), `selfRegistration`, `selfRegProfile`, and
 *     `allowInternalUserLogin`;
 *   - `CustomSite` — the site container the Network's `<site>` element names:
 *     `active`, `siteType`, `masterLabel`, `urlPathPrefix`, plus the DECLARED
 *     `references` edges to its login / self-registration / password
 *     Visualforce pages (`properties.via` carries the source element name);
 *   - the graph itself, to say whether each named Profile / PermissionSet /
 *     VisualforcePage is actually MODELED in this vault or is a
 *     dangling-by-design reference.
 *
 * THE THREE LOGIN DOORS, kept separate on purpose — collapsing them is how a
 * community access answer goes wrong:
 *   1. MEMBERS — the declared `networkMemberGroups` profiles / permission sets.
 *      A user holding one of these can be a member of the community.
 *   2. SELF-REGISTRATION — `selfRegistration: true` means anyone on the
 *      internet can mint their own login; `selfRegProfile` names the Profile
 *      they are created AS. `selfRegistration: true` with a null
 *      `selfRegProfile` is a REAL third state (a custom Apex registration
 *      handler assigns the profile), never reported as "no self-registration".
 *   3. INTERNAL USERS — `allowInternalUserLogin` decides whether the org's own
 *      internal users can log into the community at all.
 * The GUEST (unauthenticated) surface is deliberately NOT re-derived here; it
 * is named, with its heuristic linkage flagged, and delegated to
 * `sfi.guest_exposure_report`.
 *
 * Honesty boundaries (disclosed, never silently assumed):
 *   - The vault holds METADATA, not RECORD DATA. Declared member profiles are
 *     not a USER LIST: which named humans hold a community login, and how many,
 *     is live-plane (`sfi.live_license_usage`, `sfi.live_count`) or nothing.
 *     This tool never reports a member COUNT of people.
 *   - `selfRegProfile` entered the Network extractor after some vaults were
 *     built. When the property KEY is absent from every Network node the tool
 *     says the builder never LOOKED — a `coverageCaveat` a refresh closes —
 *     rather than reporting "no self-registration profile".
 *   - The community's rendered page tree is NOT modeled and NO refresh of this
 *     vault fully closes it: an Aura/Visualforce community's Builder tree is an
 *     `ExperienceBundle` (a supported type, so its absence is a coverage gap),
 *     but an LWR community's tree is a `DigitalExperienceBundle`, which is not
 *     a supported ComponentType at all — an `unproducedEdgeType`-shaped gap.
 *     Both are disclosed as UNKNOWN; the tool does not prescribe a Setup change
 *     it cannot verify.
 *   - The guest-profile linkage is the CustomSite naming convention
 *     (`{Site Label} Profile`) — `heuristic`, flagged per community.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { buildEnumerationCoverageCaveatFor, type CoverageCaveat } from './coverage-trust.js';

const NETWORK_PREFIX = 'Network:';
const CUSTOM_SITE_PREFIX = 'CustomSite:';
const PROFILE_PREFIX = 'Profile:';
const PERMISSION_SET_PREFIX = 'PermissionSet:';
const VISUALFORCE_PAGE_PREFIX = 'VisualforcePage:';

/**
 * Handler-internal ceiling on the scan, mirroring the sibling catalog tools
 * (`scheduled_job_catalog` / `outbound_message_catalog` / `endpoint_catalog`).
 * An org has communities in the single or low double digits; the cap exists so
 * a pathological vault cannot blow the transport budget, not as a page knob.
 */
const COMMUNITY_CATALOG_MAX_ENTRIES = 500;

/**
 * The metadata families this answer stands on. `Network` and `CustomSite` are
 * the two the catalog enumerates; `Profile` / `PermissionSet` back the
 * `modeled` flag on each named grant (an unretrieved Profile family would make
 * every grant read as "not modeled" for the wrong reason).
 */
const COMMUNITY_COVERAGE_TYPES = [
  'Network',
  'CustomSite',
  'Profile',
  'PermissionSet',
] as const;

/**
 * The `CustomSite` reference elements that make up a community's LOGIN and
 * REGISTRATION surface, mapped to a stable role token. The CustomSite extractor
 * already emits one DECLARED `references` edge per element with
 * `properties.via` set to the element name, so this is a read of existing
 * edges, not a new parse.
 *
 * `authorizationRequiredPage` is the page an unauthenticated visitor is sent to
 * — on an Experience Cloud site that is the community login page — so it is
 * given the `login` role, with the source `element` always echoed so a reader
 * can see exactly which metadata element the claim came from.
 */
const LOGIN_SURFACE_ELEMENTS: Readonly<Record<string, string>> = Object.freeze({
  authorizationRequiredPage: 'login',
  selfRegPage: 'self-registration',
  forgotPasswordPage: 'forgot-password',
  changePasswordPage: 'change-password',
  myProfilePage: 'my-profile',
  indexPage: 'landing',
});

/** Zod schema for the `sfi.community_catalog` tool input. */
export const communityCatalogInputSchema = z.strictObject({
  /**
   * Optional canonical id scoping the catalog to ONE community —
   * `Network:{name}` or `CustomSite:{name}`. Any other prefix is
   * `invalid-query` (a community is not addressed by an object or a class id).
   */
  componentId: z.string().min(1).optional(),
  /**
   * Optional COMMUNITY-scope alias carrying a canonical id — `Network:{name}`
   * or `CustomSite:{name}`. Advertised because it is the key the router and the
   * sibling `sfi.guest_exposure_report` already use for this family: without it
   * a host sending `communityId` would have the argument SILENTLY STRIPPED and
   * get an org-wide answer to a scoped question, which is the defect this tool
   * exists to stop making elsewhere.
   */
  communityId: z.string().min(1).optional(),
  /**
   * Optional bare `Network` api name (`'Member Portal'`), coerced to
   * `Network:{name}`. `networkName` is the same key under the alias the sibling
   * tool advertises. Resolves to the same scope as `componentId` — pass one.
   * Two that disagree are `invalid-query`, never silently one-wins.
   */
  networkApiName: z.string().min(1).optional(),
  networkName: z.string().min(1).optional(),
  /**
   * Optional bare `CustomSite` api name, coerced to `CustomSite:{name}` — the
   * site-side spelling of the same community scope.
   */
  siteApiName: z.string().min(1).optional(),
  /**
   * Advertised ONLY so an object-scoped call is REFUSED rather than silently
   * answered org-wide. A community is not indexed by the SObject its members
   * can reach; for that question use `sfi.guest_exposure_report` (guest CRUD /
   * FLS per object) or `sfi.who_can_access_object`. The canonical-id form of
   * the same mistake (`componentId: 'CustomObject:Contact'`) is refused by the
   * prefix check below, so no separate `objectId` key is needed — and adding
   * one would put a fourth non-canonical id key on the response-consistency
   * ledger for no capability.
   */
  objectApiName: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from {@link communityCatalogInputSchema}. */
export type CommunityCatalogInput = z.infer<typeof communityCatalogInputSchema>;

/**
 * One named Profile / PermissionSet that the community's metadata declares.
 * `modeled` says whether the named component is IN this vault — a `false` is a
 * dangling-by-design reference (managed package, or outside the retrieve
 * scope), NOT evidence the grant does not exist.
 */
export interface CommunityGrant {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly kind: 'profile' | 'permissionSet';
  readonly modeled: boolean;
}

/** One page on the community's login / registration surface. */
export interface CommunityLoginPage {
  /** Stable role token from {@link LOGIN_SURFACE_ELEMENTS}. */
  readonly role: string;
  /** The verbatim `CustomSite` element the reference came from. */
  readonly element: string;
  readonly pageId: ComponentId;
  readonly apiName: string;
  readonly modeled: boolean;
}

/** The `CustomSite` container a `Network` names through its `<site>` element. */
export interface CommunitySite {
  readonly siteId: ComponentId | null;
  readonly apiName: string | null;
  readonly label: string | null;
  readonly active: boolean | null;
  readonly siteType: string | null;
  readonly urlPathPrefix: string | null;
  /** False when `<site>` names a CustomSite this vault does not hold. */
  readonly modeled: boolean;
}

/**
 * How self-registration is configured for one community. Three DISTINCT states,
 * never collapsed:
 *   - `enabled: false` — self-registration is off;
 *   - `enabled: true` + `grantsProfile` non-null — anyone can sign up and is
 *     created as that Profile;
 *   - `enabled: true` + `grantsProfile: null` + `profileDeclared: false` — self
 *     registration is ON but the metadata names no profile (custom Apex
 *     registration handler). Reported as UNKNOWN, never as "none".
 *   - `enabled: null` — the switch is absent from the XML ("not declared").
 */
export interface CommunitySelfRegistration {
  readonly enabled: boolean | null;
  readonly grantsProfile: string | null;
  readonly grantsProfileId: ComponentId | null;
  readonly grantsProfileModeled: boolean | null;
  /**
   * False when this vault's Network nodes carry no `selfRegProfile` KEY at all
   * — the builder never looked, so `grantsProfile: null` means "not checked",
   * not "not configured". Distinguishing the two is the whole point.
   */
  readonly profileDeclared: boolean;
}

/** The heuristic guest-user linkage, named but delegated. */
export interface CommunityGuestProfile {
  readonly apiName: string;
  readonly componentId: ComponentId;
  readonly modeled: boolean;
  /** Always `heuristic` — the site's naming convention, not a declared pointer. */
  readonly linkage: 'heuristic';
}

/** One community: the Network joined to its CustomSite and its access surface. */
export interface CommunityCatalogEntry {
  readonly networkId: ComponentId;
  readonly apiName: string;
  readonly label: string;
  /** `Live` | `UnderConstruction` | `DownForMaintenance`; null when undeclared. */
  readonly status: string | null;
  /** The Network's own `<urlPathPrefix>`, falling back to the site's. */
  readonly urlPathPrefix: string | null;
  readonly site: CommunitySite;
  readonly loginAccess: {
    /** `allowInternalUserLogin` — can the org's OWN users log in here? */
    readonly internalUserLogin: boolean | null;
    readonly memberProfiles: readonly CommunityGrant[];
    readonly memberPermissionSets: readonly CommunityGrant[];
    readonly selfRegistration: CommunitySelfRegistration;
    readonly guestProfile: CommunityGuestProfile | null;
  };
  readonly loginPages: readonly CommunityLoginPage[];
  /** The Builder page tree the community declares — unmodeled, disclosed. */
  readonly builderPageTree: {
    readonly declaredBundle: string | null;
    readonly modeled: boolean;
    readonly note: string;
  };
  /** Per-community honesty notes; empty when nothing about this one is unknown. */
  readonly caveats: readonly string[];
}

/**
 * A `CustomSite` with NO inbound `Network` reference — a classic Force.com
 * site, not an Experience Cloud community. It has no member profiles by
 * construction (its only population is the guest user), so it is reported in
 * its own section instead of being padded into `communities` with empty
 * member lists that would read as "nobody can log in".
 */
export interface SiteWithoutCommunity {
  readonly siteId: ComponentId;
  readonly apiName: string;
  readonly label: string;
  readonly active: boolean | null;
  readonly siteType: string | null;
  readonly urlPathPrefix: string | null;
  readonly guestProfile: CommunityGuestProfile | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CommunityCatalogOutput {
  readonly communities: readonly CommunityCatalogEntry[];
  readonly sitesWithoutCommunity: readonly SiteWithoutCommunity[];
  readonly summary: {
    readonly totalCommunities: number;
    readonly liveCommunities: number;
    readonly selfRegistrationEnabled: number;
    readonly internalUserLoginAllowed: number;
    readonly sitesWithoutCommunity: number;
  };
  /** Echoed whenever the call was scoped; absent on the org-wide default. */
  readonly appliedScope?: {
    readonly componentId: ComponentId;
    readonly mode: 'community';
  };
  /** Present when a family this answer stands on is not fully covered. */
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * The gap NO refresh of this vault can fully close: an LWR community's page
   * tree is a `DigitalExperienceBundle`, which is not a supported
   * ComponentType, so its pages can never appear here. Present only when at
   * least one community declares a Builder page tree that is not modeled.
   */
  readonly boundaries: readonly string[];
  readonly disclosure: string;
}

/**
 * The boundary every response carries: declared access is not a user list.
 * Verbatim, so a host can quote it.
 */
const MEMBERSHIP_BOUNDARY =
  'Member profiles and permission sets are the DECLARED access surface, not a user list — the offline vault holds metadata, never record data, so which named people hold a login for a community and how many there are is not answerable here. Use sfi.live_license_usage or sfi.live_count (live plane, consent required) for the actual population.';

/** The guest half is named, not re-derived. */
const GUEST_BOUNDARY =
  "The guest (unauthenticated) profile is linked by the CustomSite naming convention '{Site Label} Profile', which is HEURISTIC — the metadata carries no guest-profile pointer. What that guest user can actually reach is not computed here; use sfi.guest_exposure_report.";

/** Page roles are element names read verbatim, not proof of enforcement. */
const LOGIN_PAGE_BOUNDARY =
  "Login and registration pages are the CustomSite reference elements read verbatim (the source element is echoed on every entry). 'authorizationRequiredPage' is the page an unauthenticated visitor is sent to — on an Experience Cloud site, the community login page — not proof that authentication is enforced on every page of the site.";

/**
 * The Builder page tree, disclosed as UNKNOWN with NO prescribed fix. An
 * Aura/Visualforce community's tree is an `ExperienceBundle`; an LWR
 * community's is a `DigitalExperienceBundle`, which is not a supported
 * ComponentType at all — so "enable it in Setup and re-refresh" is an
 * unverifiable instruction and is deliberately not given.
 */
const BUILDER_TREE_BOUNDARY =
  'The community\'s rendered page tree is not modeled, and WHICH of the two causes applies cannot be told from this vault. An Aura/Visualforce community declares an ExperienceBundle — a SUPPORTED type, so its absence is an ordinary retrieval gap a refresh CAN close. An LWR community\'s pages are a DigitalExperienceBundle, which this product does not model as a ComponentType at all, and no refresh can produce those. Nothing here distinguishes the two, so which pages exist, which are public, and which components they host is UNKNOWN — and it is NOT established that a refresh would fail to close it.';

/** Headline disclosure — always present. */
const COMMUNITY_DISCLOSURE =
  'This catalog answers who is DECLARED able to log into each community — member profiles and permission sets, self-registration and the profile it grants, and whether internal users may log in — from Network and CustomSite metadata. It does not evaluate record-level access inside a community: the external organization-wide defaults, sharing sets, and guest sharing rules that decide what a logged-in community user can SEE are a separate question.';

/**
 * The `selfRegProfile` gap message, used when this vault's Network nodes carry
 * no such property key. This is "the builder never looked", which a refresh
 * closes — deliberately worded so it can never be read as "no self-registration
 * profile is configured".
 */
const SELF_REG_PROFILE_NOT_EXTRACTED =
  'This vault\'s Network nodes carry no selfRegProfile property at all — they were extracted before the self-registration profile was modeled. For any community with self-registration ON, the profile a self-registered visitor is created as is NOT KNOWN here (the builder never read it); it is not "no profile". Re-run a refresh to populate it.';

/** Read a string property defensively; null for any non-string. */
const readOptionalString = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const raw = properties[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * Read a TRI-STATE boolean property: the literal boolean when present, `null`
 * for an absent / null / non-boolean value. Never coerces absence to `false` —
 * an undeclared switch is "not declared", which is the whole extractor contract.
 */
const readTriStateBoolean = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): boolean | null => {
  const raw = properties[key];
  return typeof raw === 'boolean' ? raw : null;
};

/** Read a string-array property defensively; `[]` for any other shape. */
const readStringArray = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] => {
  const raw = properties[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
};

/** True when the node's property bag CARRIES the key, whatever its value. */
const hasPropertyKey = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): boolean => Object.prototype.hasOwnProperty.call(properties, key);

/** Resolve whether a canonical id exists as a node in this vault. */
const isModeled = async (
  ctx: Context,
  id: ComponentId,
): Promise<Result<boolean, string>> => {
  const result = await getNodeById(ctx.graph, id);
  if (!result.ok) return err(result.error.message);
  return ok(result.value !== null);
};

/** Build one grant entry, resolving whether its target is in the vault. */
const buildGrant = async (
  ctx: Context,
  apiName: string,
  kind: 'profile' | 'permissionSet',
): Promise<Result<CommunityGrant, string>> => {
  const componentId = `${kind === 'profile' ? PROFILE_PREFIX : PERMISSION_SET_PREFIX}${apiName}`;
  const modeled = await isModeled(ctx, componentId);
  if (!modeled.ok) return err(modeled.error);
  return ok({ componentId, apiName, kind, modeled: modeled.value });
};

/**
 * Collect the community's login / registration pages from the CustomSite's
 * outgoing DECLARED `references` edges, keyed off `properties.via` (the source
 * element name the CustomSite extractor stamps on each edge).
 */
const collectLoginPages = async (
  ctx: Context,
  siteId: ComponentId,
): Promise<Result<readonly CommunityLoginPage[], string>> => {
  const edgesResult = await listEdges(ctx.graph, siteId, {
    direction: 'out',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const pages: CommunityLoginPage[] = [];
  for (const edge of edgesResult.value) {
    if (!edge.toId.startsWith(VISUALFORCE_PAGE_PREFIX)) continue;
    const via = edge.properties['via'];
    if (typeof via !== 'string') continue;
    const role = LOGIN_SURFACE_ELEMENTS[via];
    if (role === undefined) continue;
    const modeled = await isModeled(ctx, edge.toId);
    if (!modeled.ok) return err(modeled.error);
    pages.push({
      role,
      element: via,
      pageId: edge.toId,
      apiName: edge.toId.slice(VISUALFORCE_PAGE_PREFIX.length),
      modeled: modeled.value,
    });
  }
  pages.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
  return ok(pages);
};

/**
 * Build the heuristic guest-profile handle for a CustomSite node. Returns null
 * when the extractor did not derive one (a vault predating the convention).
 */
const buildGuestProfile = async (
  ctx: Context,
  siteNode: Node,
): Promise<Result<CommunityGuestProfile | null, string>> => {
  const guestProfileName = readOptionalString(siteNode.properties, 'guestProfileName');
  if (guestProfileName === null) return ok(null);
  const componentId = `${PROFILE_PREFIX}${guestProfileName}`;
  const modeled = await isModeled(ctx, componentId);
  if (!modeled.ok) return err(modeled.error);
  return ok({
    apiName: guestProfileName,
    componentId,
    modeled: modeled.value,
    linkage: 'heuristic',
  });
};

/** Deterministic ordering by canonical id ASC. */
const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Resolve the ONE community the caller scoped to, from `componentId` /
 * `networkApiName`. Returns `null` for the org-wide default. Two arguments that
 * disagree are `invalid-query` — never silently one-wins.
 */
const resolveScope = (
  input: CommunityCatalogInput,
): Result<ComponentId | null, McpError> => {
  if (input.objectApiName !== undefined) {
    return err({
      kind: 'invalid-query',
      message:
        'community_catalog is org-wide or scoped to ONE community; it cannot be scoped to an SObject. A community is not indexed by the objects its members reach. For per-object community access use sfi.guest_exposure_report (guest CRUD/FLS on that object) or sfi.who_can_access_object.',
    });
  }
  // Every accepted spelling of "one community", normalized to a canonical id.
  // Collected as (argument name, id) pairs so a disagreement can NAME both
  // culprits rather than reporting a generic conflict.
  const candidates: Array<readonly [string, string]> = [];
  const pushCanonical = (key: string, raw: string): McpError | null => {
    const id = raw.trim();
    if (
      !id.startsWith(NETWORK_PREFIX) &&
      !id.startsWith(CUSTOM_SITE_PREFIX)
    ) {
      return {
        kind: 'invalid-query',
        message: `${key} '${id}' is not a community id — pass 'Network:{name}' or 'CustomSite:{name}' (or omit it for the org-wide catalog).`,
      };
    }
    candidates.push([key, id]);
    return null;
  };
  if (input.componentId !== undefined) {
    const bad = pushCanonical('componentId', input.componentId);
    if (bad !== null) return err(bad);
  }
  if (input.communityId !== undefined) {
    const bad = pushCanonical('communityId', input.communityId);
    if (bad !== null) return err(bad);
  }
  if (input.networkApiName !== undefined) {
    candidates.push(['networkApiName', `${NETWORK_PREFIX}${input.networkApiName.trim()}`]);
  }
  if (input.networkName !== undefined) {
    candidates.push(['networkName', `${NETWORK_PREFIX}${input.networkName.trim()}`]);
  }
  if (input.siteApiName !== undefined) {
    candidates.push(['siteApiName', `${CUSTOM_SITE_PREFIX}${input.siteApiName.trim()}`]);
  }
  if (candidates.length === 0) return ok(null);
  const [firstKey, firstId] = candidates[0]!;
  for (const [key, id] of candidates.slice(1)) {
    if (id !== firstId) {
      return err({
        kind: 'invalid-query',
        message: `${firstKey} '${firstId}' and ${key} '${id}' name different communities — pass one, not both.`,
      });
    }
  }
  return ok(firstId);
};

/**
 * The `sfi.community_catalog` MCP tool — one row per Experience Cloud
 * community, joining `Network` to `CustomSite` and answering "who can log into
 * this?" from declared metadata across the three separate doors (members,
 * self-registration, internal users).
 *
 * @example
 *   const r = await communityCatalogHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.summary.totalCommunities);
 */
export const communityCatalogHandler = async (
  ctx: Context,
  input: CommunityCatalogInput,
): Promise<Result<McpResponse<CommunityCatalogOutput>, McpError>> => {
  const scopeResult = resolveScope(input);
  if (!scopeResult.ok) return scopeResult;
  const scope = scopeResult.value;

  const networksResult = await listNodesByType(ctx.graph, 'Network', {
    limit: COMMUNITY_CATALOG_MAX_ENTRIES,
  });
  if (!networksResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${networksResult.error.message}`,
    });
  }
  const sitesResult = await listNodesByType(ctx.graph, 'CustomSite', {
    limit: COMMUNITY_CATALOG_MAX_ENTRIES,
  });
  if (!sitesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${sitesResult.error.message}`,
    });
  }
  const networkNodes = networksResult.value as readonly Node[];
  const siteNodes = sitesResult.value as readonly Node[];
  const siteById = new Map(siteNodes.map((n) => [n.id, n]));

  // A vault whose Network nodes predate the selfRegProfile extraction carries
  // the key on NO node. One node carrying it is enough to prove the builder
  // looked, so `null` on the others is a real "not configured".
  const selfRegProfileExtracted =
    networkNodes.length > 0 &&
    networkNodes.some((n) => hasPropertyKey(n.properties, 'selfRegProfile'));

  const linkedSiteIds = new Set<string>();
  const communities: CommunityCatalogEntry[] = [];
  let builderTreeUnmodeled = false;

  for (const network of networkNodes) {
    if (scope !== null && scope.startsWith(NETWORK_PREFIX) && network.id !== scope) {
      continue;
    }
    const siteApiName = readOptionalString(network.properties, 'site');
    const siteId = siteApiName === null ? null : `${CUSTOM_SITE_PREFIX}${siteApiName}`;
    if (siteId !== null) linkedSiteIds.add(siteId);
    if (scope !== null && scope.startsWith(CUSTOM_SITE_PREFIX) && siteId !== scope) {
      continue;
    }
    const siteNode = siteId === null ? undefined : siteById.get(siteId);

    const caveats: string[] = [];

    const memberProfiles: CommunityGrant[] = [];
    for (const name of readStringArray(network.properties, 'memberProfiles')) {
      const grant = await buildGrant(ctx, name, 'profile');
      if (!grant.ok) return err({ kind: 'internal', message: `graph query failed: ${grant.error}` });
      memberProfiles.push(grant.value);
    }
    const memberPermissionSets: CommunityGrant[] = [];
    for (const name of readStringArray(network.properties, 'memberPermissionSets')) {
      const grant = await buildGrant(ctx, name, 'permissionSet');
      if (!grant.ok) return err({ kind: 'internal', message: `graph query failed: ${grant.error}` });
      memberPermissionSets.push(grant.value);
    }

    const selfRegEnabled = readTriStateBoolean(network.properties, 'selfRegistration');
    const selfRegProfileName = readOptionalString(network.properties, 'selfRegProfile');
    const selfRegProfileId =
      selfRegProfileName === null ? null : `${PROFILE_PREFIX}${selfRegProfileName}`;
    let selfRegProfileModeled: boolean | null = null;
    if (selfRegProfileId !== null) {
      const modeled = await isModeled(ctx, selfRegProfileId);
      if (!modeled.ok) return err({ kind: 'internal', message: `graph query failed: ${modeled.error}` });
      selfRegProfileModeled = modeled.value;
    }
    if (selfRegEnabled === true && selfRegProfileName === null) {
      caveats.push(
        selfRegProfileExtracted
          ? 'Self-registration is ON but this community declares NO selfRegProfile — the profile a self-registered visitor is created as is assigned by a custom Apex registration handler (or resolved at runtime) and is not knowable from metadata. This is not "no profile".'
          : SELF_REG_PROFILE_NOT_EXTRACTED,
      );
    }
    if (selfRegProfileModeled === false) {
      caveats.push(
        `Self-registration creates users as '${selfRegProfileName}', but that Profile was not retrieved into this vault — the grant is declared, its contents are unknown here.`,
      );
    }

    let guestProfile: CommunityGuestProfile | null = null;
    let loginPages: readonly CommunityLoginPage[] = [];
    if (siteNode !== undefined) {
      const guest = await buildGuestProfile(ctx, siteNode);
      if (!guest.ok) return err({ kind: 'internal', message: `graph query failed: ${guest.error}` });
      guestProfile = guest.value;
      const pages = await collectLoginPages(ctx, siteNode.id);
      if (!pages.ok) return err({ kind: 'internal', message: `graph query failed: ${pages.error}` });
      loginPages = pages.value;
    } else if (siteId !== null) {
      caveats.push(
        `This community names the site '${siteId}', which was not retrieved into this vault — its URL path prefix, active flag, and login pages are unknown here.`,
      );
    }

    const declaredBundle = readOptionalString(network.properties, 'picassoSite');
    let bundleModeled = false;
    if (declaredBundle !== null) {
      const modeled = await isModeled(ctx, `ExperienceBundle:${declaredBundle}`);
      if (!modeled.ok) return err({ kind: 'internal', message: `graph query failed: ${modeled.error}` });
      bundleModeled = modeled.value;
      if (!bundleModeled) builderTreeUnmodeled = true;
    }

    if (readTriStateBoolean(network.properties, 'allowInternalUserLogin') === null) {
      caveats.push(
        'allowInternalUserLogin is not declared in this community\'s metadata — whether internal org users can log in here is not knowable offline (absent, not false).',
      );
    }

    communities.push({
      networkId: network.id,
      apiName: network.apiName,
      label: network.label ?? network.apiName,
      status: readOptionalString(network.properties, 'status'),
      urlPathPrefix:
        readOptionalString(network.properties, 'urlPathPrefix') ??
        (siteNode === undefined
          ? null
          : readOptionalString(siteNode.properties, 'urlPathPrefix')),
      site: {
        siteId,
        apiName: siteNode?.apiName ?? siteApiName,
        label: siteNode?.label ?? null,
        active:
          siteNode === undefined
            ? null
            : readTriStateBoolean(siteNode.properties, 'active'),
        siteType:
          siteNode === undefined
            ? null
            : readOptionalString(siteNode.properties, 'siteType'),
        urlPathPrefix:
          siteNode === undefined
            ? null
            : readOptionalString(siteNode.properties, 'urlPathPrefix'),
        modeled: siteNode !== undefined,
      },
      loginAccess: {
        internalUserLogin: readTriStateBoolean(
          network.properties,
          'allowInternalUserLogin',
        ),
        memberProfiles,
        memberPermissionSets,
        selfRegistration: {
          enabled: selfRegEnabled,
          grantsProfile: selfRegProfileName,
          grantsProfileId: selfRegProfileId,
          grantsProfileModeled: selfRegProfileModeled,
          profileDeclared: selfRegProfileExtracted,
        },
        guestProfile,
      },
      loginPages,
      builderPageTree: {
        declaredBundle,
        modeled: bundleModeled,
        note:
          declaredBundle === null
            ? 'This community declares no Builder page tree in its metadata.'
            : bundleModeled
              ? 'The declared Builder bundle is modeled in this vault (top-level metadata only — page content is never parsed).'
              : BUILDER_TREE_BOUNDARY,
      },
      caveats,
    });
  }

  // Force.com sites (no inbound Network) get their own section rather than
  // being padded into `communities` with empty member lists.
  const sitesWithoutCommunity: SiteWithoutCommunity[] = [];
  for (const site of siteNodes) {
    if (linkedSiteIds.has(site.id)) continue;
    if (scope !== null && scope !== site.id) continue;
    const guest = await buildGuestProfile(ctx, site);
    if (!guest.ok) return err({ kind: 'internal', message: `graph query failed: ${guest.error}` });
    sitesWithoutCommunity.push({
      siteId: site.id,
      apiName: site.apiName,
      label: site.label ?? site.apiName,
      active: readTriStateBoolean(site.properties, 'active'),
      siteType: readOptionalString(site.properties, 'siteType'),
      urlPathPrefix: readOptionalString(site.properties, 'urlPathPrefix'),
      guestProfile: guest.value,
    });
  }

  communities.sort((a, b) => compareIds(a.networkId, b.networkId));
  sitesWithoutCommunity.sort((a, b) => compareIds(a.siteId, b.siteId));

  if (scope !== null && communities.length === 0 && sitesWithoutCommunity.length === 0) {
    return err({
      kind: 'component-not-found',
      message: `no community or site matches '${scope}' in this vault. List every one with sfi.community_catalog {} (no arguments).`,
    });
  }

  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    COMMUNITY_COVERAGE_TYPES,
    'The set of communities and who can log into them',
  );

  const boundaries: string[] = [
    MEMBERSHIP_BOUNDARY,
    LOGIN_PAGE_BOUNDARY,
    GUEST_BOUNDARY,
  ];
  if (builderTreeUnmodeled) boundaries.push(BUILDER_TREE_BOUNDARY);
  // Emitted ONLY on the path that warrants it, so a vault that DOES carry the
  // property returns a response with no such line.
  if (!selfRegProfileExtracted && communities.length > 0) {
    boundaries.push(SELF_REG_PROFILE_NOT_EXTRACTED);
  }

  return ok({
    data: {
      communities,
      sitesWithoutCommunity,
      summary: {
        totalCommunities: communities.length,
        liveCommunities: communities.filter((c) => c.status === 'Live').length,
        selfRegistrationEnabled: communities.filter(
          (c) => c.loginAccess.selfRegistration.enabled === true,
        ).length,
        internalUserLoginAllowed: communities.filter(
          (c) => c.loginAccess.internalUserLogin === true,
        ).length,
        sitesWithoutCommunity: sitesWithoutCommunity.length,
      },
      ...(scope !== null
        ? { appliedScope: { componentId: scope, mode: 'community' as const } }
        : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      // NO `unproducedEdgeType` here. That field is this repo's STRONGEST
      // honesty absolute — "no refresh on any org can ever produce this" — and
      // `builderTreeUnmodeled` does not establish it. It is set whenever a
      // Network declares `picassoSite` and `ExperienceBundle:{picassoSite}` is
      // absent, which is precisely the CLOSABLE case: ExperienceBundle is a
      // supported ComponentType, so a refresh that retrieves it closes the gap.
      // This handler has no LWR / DigitalExperienceBundle detection at all, so
      // it cannot tell the closable case from the unproducible one. Asserting
      // the absolute on the closable case tells an operator not to bother with
      // the one action that would work. The uncertainty is stated in
      // BUILDER_TREE_BOUNDARY instead.
      boundaries,
      disclosure:
        networkNodes.length === 0
          ? `No Network (Experience Cloud community) metadata is modeled in this vault${
              sitesWithoutCommunity.length > 0
                ? `, though ${String(sitesWithoutCommunity.length)} CustomSite(s) are — those are Force.com sites whose only population is the guest user`
                : ''
            }. ${COMMUNITY_DISCLOSURE}`
          : COMMUNITY_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
