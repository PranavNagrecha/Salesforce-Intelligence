/**
 * Handler for the `sfi.generate_sharing_summary` MCP tool.
 *
 * The v2.5 documentation-generation tier sharing-summary tool. Given
 * an optional `objectFilter` (api name string), emits a structured
 * markdown document covering every CustomObject's OWD (organization-
 * wide default), the SharingRules that apply to it (each NAMING its
 * `sharedWith` recipient — CR-CAP-05b — in a "Shared With" column;
 * a `roleAndSubordinates` recipient is marked "(and its subordinate
 * roles)" via the shared `expandRoleSubordinates` helper that
 * `who_can_access_object` also uses, so the two surfaces never drift),
 * and the Profile / PermissionSet OBJECT-level CRUD grants that surface
 * as incoming `grantedBy` edges to the object itself. Restriction & Scoping
 * rules (RestrictionRule / ScopingRule nodes whose `parentId` is the object)
 * are listed per object with their enforcement type, active state, and record
 * filter — they NARROW visibility on top of OWD + sharing, so omitting them
 * (as this tool previously did) invented an OWD-only access posture. The Role
 * hierarchy is rendered as a mermaid diagram when Role nodes are present.
 *
 * Input:
 *   - `objectFilter` (optional string): when supplied, narrows the
 *     scan to the single CustomObject whose api name matches. Default
 *     scans every extracted CustomObject (capped at 50 per the
 *     architect-tier convention — CR-RV12: a >50-object org's response
 *     discloses the truncation, see Output below, rather than silently
 *     reading as complete).
 *   - `objectApiName` / `componentId` (optional string, aliases —
 *     GENERATE-SHARING-SUMMARY-ALIAS-SKEW): equivalent object selectors
 *     to `objectFilter`. `componentId` accepts the canonical
 *     `CustomObject:{ApiName}` id (or a bare api name); `objectFilter`
 *     wins when more than one is supplied. WHICHEVER scope is applied is
 *     echoed honestly in the Overview (`objectFilter: \`...\``) and the
 *     re-run footer — the tool never reports a scoped single-object doc
 *     as "no objectFilter applied".
 *
 * Output: `{ document: GeneratedDocument, scanTruncated?, totalMatchingObjects? }`.
 *   `scanTruncated` (CR-RV12) is present ONLY when the org has more than 50
 *   matching CustomObjects — the OBJECT_SCAN_CAP silently dropped the rest
 *   BEFORE this tool existed to say so. `totalMatchingObjects` carries the
 *   TRUE count alongside it (a `COUNT(*)` on the unfiltered path, never the
 *   length of a capped page: every type here is walked to exhaustion by the
 *   shared `scanAllNodesOfTypes`, so a SharingRule / RestrictionRule / Role /
 *   CustomObject past id-ASC node 500 is no longer silently unread). The
 *   same disclosure also appears inline in
 *   `document.body`'s Overview line ("N of M matching (capped...)") and as a
 *   verbatim entry in `document.boundaries` — a reader scanning the rendered
 *   markdown sees it without inspecting the structured fields.
 *
 * Honesty axis: per-object sharing details come from declared metadata
 * (`properties.sharingModel` on the CustomObject; the SharingRule nodes
 * extracted in v1.1). Profile / PermissionSet counts are tallied from
 * the OBJECT's incoming `grantedBy` edges that carry an object-CRUD flag
 * (allowCreate/Read/Edit/Delete or View/Modify-All). CR-04: field-level
 * security (FLS) is a separate plane — it is NOT counted here; see
 * `field_access_audit` for per-field grants.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType, listEdges } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  INHERITED_CONFIDENCE_DISCLOSURE,
  Q125_FRESHNESS_DISCLOSURE,
  STRUCTURAL_DISCLOSURE,
  fitDocumentToBudget,
  generatedDocByteBudget,
  renderFooter,
  type GeneratedDocument,
} from './generate-data-dictionary.js';
import { resolveExistingObjectScope } from './input-aliases.js';
import { expandRoleSubordinates, ROLE_PREFIX } from './role-hierarchy.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/** Per-scan cap on the number of objects covered. */
const OBJECT_SCAN_CAP = 50;

/**
 * Honest disclosure of the sharing dimensions this summary does NOT model, so
 * the rules table is never read as the complete access model (P11-G5).
 * CR-CAP-16: territory & guest sharing rules are now EXTRACTED and listed (their
 * row appears in the table with a guest/territory predicate), so they are no
 * longer "skipped" — but their APPLICABILITY is still record-level, so the
 * disclosure keeps them as a not-decidable dimension. Sharing sets,
 * account/opportunity/case teams, and manual / Apex sharing remain record-level
 * or config the offline metadata does not carry. Absence of any of these here
 * means "not modeled / not decidable", never "the object has none".
 */
const UNMODELED_SHARING_DIMENSIONS_DISCLOSURE =
  'Sharing dimensions whose record-level applicability this summary cannot decide (absence ≠ none): territory and guest (Experience Cloud) sharing rules are now LISTED (CR-CAP-16) but whether a given record/user is shared needs record-level + requester context the offline metadata lacks; sharing sets, account / opportunity / case teams, and manual & Apex (programmatic) sharing are record-level or config not in the offline metadata. Each rule now NAMES its `sharedWith` recipient (CR-CAP-05b) — a `roleAndSubordinates` recipient is marked "(and its subordinate roles)" and the descending role subtree is counted; the `…Internal` variant cannot exclude portal/partner roles offline (disclosed separately). This summary covers OWD, owner + criteria + guest + territory sharing rules and their recipients, role hierarchy, and Profile/PermissionSet grants. For a per-user record verdict (which surfaces these as explicit not-decidable stages) use `why_cant_user_see_record`.';

/** Zod schema for the `sfi.generate_sharing_summary` tool input. */
export const generateSharingSummaryInputSchema = z.object({
  objectFilter: z.string().min(1).optional(),
  /** Alias for `objectFilter` (NI-3). */
  objectApiName: z.string().min(1).optional(),
  /**
   * Object selector alias (GENERATE-SHARING-SUMMARY-ALIAS-SKEW). Accepts the
   * canonical `CustomObject:{ApiName}` id the router and sibling access tools
   * hand hosts, or a bare object api name. Previously Zod-stripped, so a
   * `componentId`-scoped call silently fell through to the org-wide scan.
   */
  componentId: z.string().min(1).optional(),
});

/** The `CustomObject:` id prefix a `componentId` selector may carry. */
const CUSTOM_OBJECT_ID_PREFIX = 'CustomObject:';

/**
 * Resolve a `componentId` object selector (GENERATE-SHARING-SUMMARY-ALIAS-SKEW)
 * into a bare object api name equivalent to `objectFilter` / `objectApiName`.
 * Strips a leading `CustomObject:` id prefix; a value without that prefix is
 * treated as a bare api name. Returns `undefined` when no `componentId` was
 * supplied so it never fabricates a scope.
 */
const objectApiNameFromComponentId = (
  componentId: string | undefined,
): string | undefined => {
  if (componentId === undefined) return undefined;
  return componentId.startsWith(CUSTOM_OBJECT_ID_PREFIX)
    ? componentId.slice(CUSTOM_OBJECT_ID_PREFIX.length)
    : componentId;
};

/** Parsed input shape. */
export type GenerateSharingSummaryInput = z.infer<
  typeof generateSharingSummaryInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GenerateSharingSummaryOutput {
  readonly document: GeneratedDocument;
  /**
   * Set only when `objectFilter`/`objectApiName` named an object that matched
   * no RETRIEVED CustomObject but IS referenced elsewhere in the org — a
   * phantom (B29). Distinguishes "not retrieved" from "no sharing", so a
   * security review is never silently handed an empty FLS/sharing answer.
   */
  readonly targetMissing?: {
    readonly id: ComponentId;
    /** How many components reference the phantom (inbound edges). */
    readonly referencedBy: number;
  };
  /**
   * CR-RV12: TRUE when the `OBJECT_SCAN_CAP` (50) slice dropped matching
   * CustomObjects BEFORE the per-object sharing entries were built — so the
   * document covers only the first 50 (by return order). Also TRUE when the
   * full multi-window type walk (`scanAllNodesOfTypes`) stopped at its residual
   * `FULL_SCAN_MAX_NODES` ceiling, which leaves a type's tail unread; that case
   * carries `fullScanTruncationNote` in `document.boundaries`. Present ONLY when
   * actually true, mirroring `unassigned-permission-sets.ts`'s `scanTruncated`
   * shape, so a ≤50-object org's golden response is byte-identical.
   */
  readonly scanTruncated?: boolean;
  /** CR-RV12: the TRUE matching-object count (only when the scan was capped). */
  readonly totalMatchingObjects?: number;
}

/** Escape a markdown table cell. */
const escapeCell = (raw: string): string =>
  raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Pull a string property with a fallback. */
const stringProp = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string => {
  const v = properties[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
};

/**
 * The record-match predicate of a criteria-based sharing rule, mirroring
 * `why_cant_user_see_record`'s criteria step so both consumers describe the
 * criteria path the same way. Prefers the explicit `booleanFilter`, falls back
 * to the criteria-item count, then to an honest "unspecified".
 */
const criteriaPredicate = (
  properties: Readonly<Record<string, unknown>>,
): string => {
  const bf = properties['booleanFilter'];
  if (typeof bf === 'string' && bf.length > 0) return bf;
  const count = properties['criteriaItemCount'];
  if (typeof count === 'number' && count > 0) return `${count} criteria item(s)`;
  return 'unspecified criteria';
};

/** Rule families that are criteria-shaped (carry a predicate) — CR-CAP-16. */
const PREDICATE_RULE_TYPES: ReadonlySet<string> = new Set([
  'criteria',
  'guest',
  'territory',
  'territoryGroup',
]);

/**
 * The Criteria-column text for a rule row. CR-CAP-16: guest / territory rules
 * are criteria-shaped, so they show their predicate too; a guest rule also
 * prefixes its Experience-Cloud site name so the portal is visible. Owner rules
 * have no predicate ("—").
 */
const ruleCriteriaCell = (
  ruleType: string,
  properties: Readonly<Record<string, unknown>>,
): string => {
  if (!PREDICATE_RULE_TYPES.has(ruleType)) return '—';
  const predicate = criteriaPredicate(properties);
  const siteName = properties['siteName'];
  if (ruleType === 'guest' && typeof siteName === 'string' && siteName.length > 0) {
    return `site '${siteName}': ${predicate}`;
  }
  return predicate;
};

/**
 * Per-object sharing payload built before rendering. Collected once
 * per object so the rendering pass is purely formatting.
 */
interface ObjectSharing {
  readonly object: Node;
  readonly owd: string;
  /**
   * External OWD (externalSharingModel) — controls access for Experience Cloud
   * / community (external) users. `null` when the object metadata does not
   * declare an external OWD.
   */
  readonly externalOwd: string | null;
  readonly sharingRules: readonly Node[];
  /**
   * RESTRICTION-RULE-MISSING-OBJECT-GRAPH-AND-SHARING-SUMMARY: the
   * RestrictionRule / ScopingRule nodes whose `parentId` is this object.
   * Restriction (Restrict) and Scoping rules NARROW record visibility even for
   * users who otherwise have access, so an OWD-only summary that omitted them
   * invented a broader access posture. Keyed on `parentId` (the extractor sets
   * it from `<targetEntity>`), so this surfaces on the CURRENT vault.
   */
  readonly restrictionRules: readonly Node[];
  readonly profilesWithGrants: number;
  readonly permSetsWithGrants: number;
  /**
   * CR-CAP-05b: the rendered "Shared With" recipient cell per rule id. The
   * summary previously named NO recipient (4-column table); each cell now lists
   * the rule's `sharedWith` targets, appending "(and its subordinate roles)" for
   * a `roleAndSubordinates` / `…Internal` marker. Computed async (edge reads +
   * the shared role-subtree helper) before the sync render pass.
   */
  readonly ruleRecipients: ReadonlyMap<string, string>;
}

/**
 * CR-CAP-05b: build the "Shared With" recipient cell for one sharing rule by
 * reading its outbound `sharedWith` edges. A `roleAndSubordinates` /
 * `…Internal` Role target is marked "(and its subordinate roles)" and its
 * descending subtree counted via the SAME `expandRoleSubordinates` helper
 * `who_can_access_object` uses, so the two surfaces never drift. Returns the
 * cell text plus whether any subtree was truncated or any internal marker was
 * seen (for the doc-level disclosures). Owner rules emit both `sharedTo` and
 * `sharedFrom` edges (the latter carries `direction: 'from'`) — only the
 * `sharedTo` recipient side is named.
 */
const buildRecipientCell = async (
  ctx: Context,
  rule: Node,
): Promise<{ cell: string; truncated: boolean; hasInternal: boolean }> => {
  const edgesResult = await listEdges(ctx.graph, rule.id, {
    direction: 'out',
    edgeType: 'sharedWith',
  });
  if (!edgesResult.ok || edgesResult.value.length === 0) {
    // No recipient edge: honest "—" (absence is not "shared with nobody" — the
    // disclosure already covers the unmodeled dimensions).
    return { cell: '—', truncated: false, hasInternal: false };
  }
  const parts: string[] = [];
  let truncated = false;
  let hasInternal = false;
  for (const edge of edgesResult.value) {
    if (edge.properties['direction'] === 'from') continue; // owner sharedFrom side
    const targetId = edge.toId;
    const name = targetId.includes(':')
      ? targetId.slice(targetId.indexOf(':') + 1)
      : targetId;
    const type = targetId.includes(':')
      ? targetId.slice(0, targetId.indexOf(':'))
      : 'Group';
    const inheritance = edge.properties['inheritance'];
    const isSub =
      targetId.startsWith(ROLE_PREFIX) &&
      (inheritance === 'subordinates' || inheritance === 'subordinatesInternal');
    if (isSub) {
      if (inheritance === 'subordinatesInternal') hasInternal = true;
      const subtree = await expandRoleSubordinates(ctx, targetId);
      const subCount = subtree.ok
        ? Math.max(0, subtree.value.roleIds.size - 1)
        : 0;
      if (subtree.ok && subtree.value.truncated) truncated = true;
      const internalNote =
        inheritance === 'subordinatesInternal'
          ? ' [internal-only filter not applied offline]'
          : '';
      parts.push(
        `${type} ${name} (and its subordinate roles${subCount > 0 ? `: ${subCount.toString()}` : ''})${internalNote}`,
      );
    } else {
      parts.push(`${type} ${name}`);
    }
  }
  return {
    cell: parts.length > 0 ? parts.join('; ') : '—',
    truncated,
    hasInternal,
  };
};

/**
 * Render the per-object H2 section.
 *
 * `sharingRuleNotRetrieved` is set when the manifest reports the SharingRule
 * type was requested but retrieved nothing (or errored / was scoped out) — an
 * empty rules table then means "not retrieved", NOT "this object has no sharing
 * rules" (the C2 lie). When SharingRule coverage is confirmed (or unknown on a
 * pre-v4 vault), the empty case keeps its original "_(no sharing rules)_".
 */
const renderObjectSection = (
  entry: ObjectSharing,
  sharingRuleNotRetrieved: boolean,
): string => {
  const label = entry.object.label ?? entry.object.apiName;
  const externalOwdLine =
    entry.externalOwd !== null
      ? `**External OWD (externalSharingModel):** \`${entry.externalOwd}\` — controls access for Experience Cloud / community (external) users  `
      : '';
  const lines: string[] = [
    `## ${escapeCell(label)} (\`${entry.object.apiName}\`)`,
    '',
    `**OWD (Sharing Model):** \`${entry.owd}\`  `,
    ...(externalOwdLine ? [externalOwdLine] : []),
    `**Profiles with grants:** ${entry.profilesWithGrants.toString()}  `,
    `**PermissionSets with grants:** ${entry.permSetsWithGrants.toString()}`,
    '',
    '### Sharing Rules',
    '',
  ];
  if (entry.sharingRules.length === 0) {
    lines.push(
      sharingRuleNotRetrieved
        ? '_(SharingRule not retrieved — the last refresh did not pull this type into the vault, so this is **not checked**, not "no sharing rules". Run `sfi refresh` including SharingRule.)_'
        : '_(no sharing rules)_',
    );
  } else {
    // CR-CAP-05b: a "Shared With" column names the recipient — previously the
    // table OMITTED recipients entirely (the role/group a rule shared with was
    // never named). A `roleAndSubordinates` recipient is marked "(and its
    // subordinate roles)" via the shared expandRoleSubordinates helper.
    lines.push('| Rule | Type | Shared With | Access Level | Criteria |');
    lines.push('| --- | --- | --- | --- | --- |');
    const sorted = [...entry.sharingRules].sort((a, b) =>
      a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0,
    );
    for (const rule of sorted) {
      const ruleType = stringProp(rule.properties, 'ruleType', 'unknown');
      const access = stringProp(rule.properties, 'accessLevel', 'Unknown');
      // Surface the criteria/guest/territory predicate (P11-G5, CR-CAP-16) so a
      // predicate-based access path isn't invisible. The predicate needs record
      // data to evaluate, so it is a declared rule definition, not a per-record
      // verdict.
      const criteria = ruleCriteriaCell(ruleType, rule.properties);
      const recipient = entry.ruleRecipients.get(rule.id) ?? '—';
      lines.push(
        `| \`${escapeCell(rule.apiName)}\` | ${escapeCell(ruleType)} | ${escapeCell(recipient)} | ${escapeCell(access)} | ${escapeCell(criteria)} |`,
      );
    }
  }

  // RESTRICTION-RULE-MISSING-OBJECT-GRAPH-AND-SHARING-SUMMARY: Restriction /
  // Scoping rules NARROW visibility on top of OWD + sharing rules, so a summary
  // that omitted them read as OWD-only visibility. List every RestrictionRule /
  // ScopingRule on this object with its enforcement type, active state, and
  // record filter (the SOQL predicate that scopes which records stay visible).
  lines.push('', '### Restriction & Scoping Rules', '');
  if (entry.restrictionRules.length === 0) {
    lines.push('_(no restriction or scoping rules)_');
  } else {
    lines.push('| Rule | Kind | Enforcement | Active | Record Filter |');
    lines.push('| --- | --- | --- | --- | --- |');
    const sortedRr = [...entry.restrictionRules].sort((a, b) =>
      a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0,
    );
    for (const rule of sortedRr) {
      const enforcement = stringProp(rule.properties, 'enforcementType', 'Unknown');
      const active = stringProp(rule.properties, 'active', 'unknown');
      const recordFilter = stringProp(rule.properties, 'recordFilter', '—');
      lines.push(
        `| \`${escapeCell(rule.apiName)}\` | ${escapeCell(rule.type)} | ${escapeCell(enforcement)} | ${escapeCell(active)} | ${escapeCell(recordFilter)} |`,
      );
    }
  }
  return lines.join('\n');
};

/**
 * Render the Role Hierarchy diagram from the supplied Role nodes.
 * Walks each role's `properties.parentRoleId` to draw edges. An empty
 * role population surfaces a disclosure.
 */
const renderRoleHierarchySection = (
  roles: readonly Node[],
  roleNotRetrieved: boolean,
): string => {
  if (roles.length === 0) {
    return [
      '## Role Hierarchy',
      '',
      roleNotRetrieved
        ? '_(Role type not retrieved — the last refresh did not pull `Role` into the vault, so the role hierarchy is **not checked**, not "no roles". Run `sfi refresh` including Role.)_'
        : '_(no Role nodes extracted — role-hierarchy data depends on v1.1 sharing extractors having processed `roles/` metadata)_',
    ].join('\n');
  }
  const lines: string[] = ['## Role Hierarchy', '', '```mermaid', 'graph TD'];
  const sorted = [...roles].sort((a, b) =>
    a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0,
  );
  for (const role of sorted) {
    const safe = role.apiName.replace(/[^A-Za-z0-9_]/g, '_');
    lines.push(`  ${safe}["${escapeCell(role.apiName)}"]`);
  }
  for (const role of sorted) {
    const parent = stringProp(role.properties, 'parentRoleId', '');
    if (parent.length === 0) continue;
    const safeChild = role.apiName.replace(/[^A-Za-z0-9_]/g, '_');
    const parentName = parent.startsWith('Role:') ? parent.slice('Role:'.length) : parent;
    const safeParent = parentName.replace(/[^A-Za-z0-9_]/g, '_');
    lines.push(`  ${safeParent} --> ${safeChild}`);
  }
  lines.push('```');
  return lines.join('\n');
};

/**
 * The parent CustomObject api name a SharingRule applies to. The v1.1 sharing
 * extractor sets the rule's `parentId` to `CustomObject:{Object}` and its
 * `apiName` to `{Object}.{RuleName}`; it does NOT emit a `properties.sObjectType`.
 * The previous index keyed on that non-existent `sObjectType`, so it matched
 * NOTHING and every object rendered "_(no sharing rules)_" even when dozens of
 * `SharingRule:{Object}.*` nodes existed (the false-empty C2-class lie). Derive
 * the object from `parentId` first, then the `apiName` head, then the legacy
 * `sObjectType` property for any producer that still sets it.
 */
const sharingRuleObjectApiName = (rule: Node): string => {
  const parentId = rule.parentId;
  if (typeof parentId === 'string' && parentId.startsWith('CustomObject:')) {
    return parentId.slice('CustomObject:'.length);
  }
  const dot = rule.apiName.indexOf('.');
  if (dot > 0) return rule.apiName.slice(0, dot);
  return stringProp(rule.properties, 'sObjectType', '');
};

/**
 * Walk all SharingRule nodes once and return a map of parent CustomObject
 * ApiName to its applicable rules. The object is derived via
 * {@link sharingRuleObjectApiName} (parentId / apiName), NOT the never-emitted
 * `properties.sObjectType`.
 */
const buildSharingRulesIndex = (
  rules: readonly Node[],
): Map<string, Node[]> => {
  const index = new Map<string, Node[]>();
  for (const rule of rules) {
    const sobj = sharingRuleObjectApiName(rule);
    if (sobj.length === 0) continue;
    const list = index.get(sobj) ?? [];
    list.push(rule);
    index.set(sobj, list);
  }
  return index;
};

/**
 * Tally the profile / perm-set OBJECT-LEVEL CRUD grant counts for a single
 * object. Walks the OBJECT node's incoming `grantedBy` edges and counts only
 * grantors carrying an object-CRUD flag (allowCreate/Read/Edit/Delete or
 * View/Modify-All), deduped by grantor id.
 *
 * CR-04: object CRUD, field-level security (FLS), and record sharing are three
 * orthogonal planes. The previous implementation walked each child
 * CustomField's `grantedBy` edges and counted FLS grants toward this
 * object-access tally — conflating two planes (and inflating the count via
 * one grantor across many fields). FLS now belongs to `field_access_audit`;
 * this counts object access only. Mirrors `object-access-audit.ts`'s
 * object-CRUD edge read for cross-tool consistency.
 */
const tallyGrants = async (
  ctx: Context,
  object: Node,
): Promise<Result<{ profiles: Set<ComponentId>; permSets: Set<ComponentId> }, McpError>> => {
  const profiles = new Set<ComponentId>();
  const permSets = new Set<ComponentId>();
  const edgesResult = await listEdges(ctx.graph, object.id, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }
  for (const edge of edgesResult.value) {
    const p = edge.properties;
    const hasObjectCrud =
      p['allowCreate'] === true ||
      p['allowRead'] === true ||
      p['allowEdit'] === true ||
      p['allowDelete'] === true ||
      p['viewAllRecords'] === true ||
      p['modifyAllRecords'] === true;
    // Belt-and-suspenders: the extractor drops all-false object-CRUD edges, but
    // an FLS-only / structural edge that ever reaches the object node is a
    // different plane and must not count here.
    if (!hasObjectCrud) continue;
    if (edge.fromId.startsWith('Profile:')) profiles.add(edge.fromId);
    else if (edge.fromId.startsWith('PermissionSet:')) permSets.add(edge.fromId);
  }
  return ok({ profiles, permSets });
};

/**
 * The `sfi.generate_sharing_summary` MCP tool. Returns a structured
 * markdown summary of every CustomObject's sharing model. See the
 * module JSDoc for the recipe.
 */
export const generateSharingSummaryHandler = async (
  ctx: Context,
  input: GenerateSharingSummaryInput,
): Promise<Result<McpResponse<GenerateSharingSummaryOutput>, McpError>> => {
  // FULL-TYPE-SCAN-CAPPED-AT-500: every type this security document depends on
  // is now walked to EXHAUSTION through the shared `scanAllNodesOfTypes`
  // (advancing SQL `OFFSET`, window by window), not read from ONE
  // `listNodesByType` page.
  //
  // What this replaced: four single-page fetches at `limit: 500` — the graph's
  // HARD `LIST_MAX_LIMIT` — with no offset and no sentinel. Any node past
  // id-ASC #500 was NEVER fetched, and NONE of this file's honesty apparatus
  // fires for that cap: `sharingRuleNotRetrieved` consults the MANIFEST, which
  // correctly reports SharingRule AS retrieved. So an object whose rules sort
  // late rendered an EMPTY "Sharing Rules" table and an EMPTY "Restriction &
  // Scoping Rules" section, with zero disclosure — read exactly as "OWD is the
  // whole story, nobody else can see these records". Worse for
  // RestrictionRule / ScopingRule: those rules NARROW visibility, so dropping
  // them invents a WIDER posture than the org has, and the boundary below
  // asserts the opposite reading ("an empty ... section means none were
  // retrieved for that object").
  //
  // The walk's only residual ceiling is `FULL_SCAN_MAX_NODES` (20 000/type),
  // and when THAT bites it is disclosed via `fullScanTruncationNote` below.
  const scan = await scanAllNodesOfTypes(ctx.graph, [
    'CustomObject',
    'SharingRule',
    'Role',
    // RESTRICTION-RULE-MISSING-OBJECT-GRAPH-AND-SHARING-SUMMARY: Restriction /
    // Scoping rules narrow record visibility on top of OWD + sharing rules; the
    // summary previously never mentioned them, inventing OWD-only visibility.
    // Both types are walked (Scoping enforcement may live under either).
    'RestrictionRule',
    'ScopingRule',
  ]);
  if (!scan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${scan.error.message}`,
    });
  }
  const allObjects = scan.value.nodes.filter((n) => n.type === 'CustomObject');
  const allSharingRules = scan.value.nodes.filter((n) => n.type === 'SharingRule');
  const allRoles = scan.value.nodes.filter((n) => n.type === 'Role');
  // Index restriction / scoping rules by `parentId` — the extractor stamps it
  // from `<targetEntity>`, so this surfaces on the CURRENT vault without a
  // re-extract.
  const restrictionByParent = new Map<string, Node[]>();
  for (const rule of scan.value.nodes) {
    if (rule.type !== 'RestrictionRule' && rule.type !== 'ScopingRule') continue;
    const parentId = rule.parentId;
    if (typeof parentId !== 'string' || parentId.length === 0) continue;
    const list = restrictionByParent.get(parentId) ?? [];
    list.push(rule);
    restrictionByParent.set(parentId, list);
  }

  // GENERATE-SHARING-SUMMARY-ALIAS-SKEW: treat `objectFilter`, `objectApiName`,
  // and `componentId` (`CustomObject:{ApiName}` or a bare api name) as equivalent
  // object selectors. `objectFilter` wins so an existing caller's output stays
  // byte-identical; the aliases fill in only when it is absent. The resolved
  // `appliedScope` drives BOTH the object filter below AND the honest scope echo
  // in the Overview / footer — previously `objectApiName` scoped the scan yet the
  // body still claimed "no objectFilter applied", and `componentId` was ignored
  // entirely and answered org-wide.
  const requestedScope =
    input.objectFilter ??
    input.objectApiName ??
    objectApiNameFromComponentId(input.componentId);

  // GENERATE-SHARING-SUMMARY-ANSWERS-A-NONEXISTENT-OBJECT: verify the named
  // object EXISTS before narrowing, via the same `resolveExistingObjectScope`
  // `unused_fields_deep` / `flow_fault_audit` / `flow_bulkification_audit` use.
  //
  // What this replaced: the filter was a raw STRING COMPARE
  // (`o.apiName === filterName`) against the objects already in hand. The vault
  // was never asked whether the named object exists. What a user saw: asking
  // "who can see Zzz_Nonexistent__c?" produced a complete-looking Sharing Model
  // Summary — Overview, Role Hierarchy, the full boundaries list — whose only
  // trace of the miss was the body line "_(no CustomObjects matched the
  // filter)_"; `targetMissing` was absent and the structured payload carried no
  // marker at all. A security reviewer reads that document as "this object has
  // no sharing rules and no grants". The same string compare silently produced
  // that identical empty for a REAL object typed in the wrong case (`account`
  // never equals `Account`), so an exactly-correct question got an
  // exactly-wrong access answer.
  //
  // `appliedScope` now carries the VAULT's exact casing, so the Overview echo
  // and the re-run footer name an object that actually exists.
  let appliedScope = requestedScope;
  let targetMissing: GenerateSharingSummaryOutput['targetMissing'];
  if (requestedScope !== undefined) {
    const scopeResult = await resolveExistingObjectScope(ctx.graph, {
      objectApiName: requestedScope,
    });
    if (scopeResult.ok) {
      appliedScope =
        scopeResult.value === null ? undefined : scopeResult.value.object;
    } else {
      // B29 is a DIFFERENT and answerable question, so it survives the refusal:
      // an object with inbound edges but no retrieved definition is a PHANTOM
      // ("referenced, not retrieved"), not a name that means nothing. Only a
      // name the vault knows in NEITHER sense is refused. A case-ambiguity
      // refusal cannot land here: its variants are real nodes, so edges point at
      // those ids and never at the exact-cased id that failed to resolve.
      const candidateId = `CustomObject:${requestedScope}` as ComponentId;
      const inbound = await listEdges(ctx.graph, candidateId, { direction: 'in' });
      const referencedBy = inbound.ok ? inbound.value.length : 0;
      if (referencedBy === 0) return err(scopeResult.error);
      targetMissing = { id: candidateId, referencedBy };
    }
  }

  // Apply the optional filter.
  let scanObjects = allObjects;
  const filterName = appliedScope;
  if (filterName !== undefined) {
    const filter = filterName;
    scanObjects = scanObjects.filter((o) => o.apiName === filter);
  }
  // CR-RV12: capture the TRUE matching count BEFORE the architect-tier
  // OBJECT_SCAN_CAP slice, so a >50-object org's summary discloses that it
  // covers only the first 50 rather than silently reading as complete.
  //
  // FULL-TYPE-SCAN-CAPPED-AT-500: this number USED to be measured on the
  // already-capped 500-node page, so the truncation disclosure's own figure was
  // itself truncated — a 520-object org read "50 of 500 matching". `scanObjects`
  // is now a FULL walk, so its length is exact; the UNFILTERED path additionally
  // derives the total from `countNodesByType`'s `COUNT(*)` (whose JSDoc states
  // verbatim that a caller needing a true tally must never measure a capped
  // page's `.length`), so the figure stays exact even if the residual
  // FULL_SCAN_MAX_NODES ceiling ever bit.
  let totalMatchingObjects = scanObjects.length;
  if (filterName === undefined) {
    const objectCount = await countNodesByType(ctx.graph, 'CustomObject');
    if (!objectCount.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${objectCount.error.message}`,
      });
    }
    totalMatchingObjects = objectCount.value;
  }
  const objectScanTruncated = totalMatchingObjects > OBJECT_SCAN_CAP;
  scanObjects = scanObjects.slice(0, OBJECT_SCAN_CAP);

  // Build per-object sharing entries.
  const sharingIndex = buildSharingRulesIndex(allSharingRules);
  const entries: ObjectSharing[] = [];
  // CR-CAP-05b: doc-level disclosure flags — set if any rule's subordinate-role
  // subtree was incomplete, or any recipient was roleAndSubordinatesInternal.
  let roleSubtreeTruncated = false;
  let internalSubordinatesUndisclosable = false;
  for (const object of scanObjects) {
    // CR-04: count OBJECT-level CRUD grants (one edge query on the object),
    // not field-level FLS grants (which conflated planes and inflated counts).
    const grantsResult = await tallyGrants(ctx, object);
    if (!grantsResult.ok) return err(grantsResult.error);
    const owd = stringProp(object.properties, 'sharingModel', 'Unknown');
    const externalOwdRaw = object.properties['externalSharingModel'];
    const externalOwd = typeof externalOwdRaw === 'string' && externalOwdRaw.length > 0
      ? externalOwdRaw
      : null;
    const rules = sharingIndex.get(object.apiName) ?? [];
    // CR-CAP-05b: name each rule's sharedWith recipient (was omitted) via the
    // shared role-subtree helper, so this surface matches who_can_access_object.
    const ruleRecipients = new Map<string, string>();
    for (const rule of rules) {
      const built = await buildRecipientCell(ctx, rule);
      ruleRecipients.set(rule.id, built.cell);
      if (built.truncated) roleSubtreeTruncated = true;
      if (built.hasInternal) internalSubordinatesUndisclosable = true;
    }
    entries.push({
      object,
      owd,
      externalOwd,
      sharingRules: rules,
      restrictionRules: restrictionByParent.get(object.id) ?? [],
      profilesWithGrants: grantsResult.value.profiles.size,
      permSetsWithGrants: grantsResult.value.permSets.size,
      ruleRecipients,
    });
  }

  const sortedEntries = [...entries].sort((a, b) =>
    a.object.apiName < b.object.apiName ? -1 : a.object.apiName > b.object.apiName ? 1 : 0,
  );

  // C2: distinguish "the org has no sharing rules / roles" from "the SharingRule
  // / Role type was never retrieved into this vault". An empty graph result for
  // either is otherwise byte-identical, so consult manifest coverage. Only fires
  // when coverage is KNOWN (a v4+ vault carries a coverage array); a pre-v4 vault
  // has `coverageKnown: false`, so the original "no sharing rules / no roles"
  // wording is kept — legacy vaults don't suddenly emit "not retrieved" noise
  // (mirrors `buildEnumerationCoverageCaveat`'s `!coverage.coverageKnown` guard).
  const sharingRuleCoverage = summarizeCoverage(ctx.manifest, ['SharingRule']);
  const sharingRuleNotRetrieved =
    sharingRuleCoverage.coverageKnown &&
    sharingRuleCoverage.missingCoverage.includes('SharingRule');
  const roleCoverage = summarizeCoverage(ctx.manifest, ['Role']);
  const roleNotRetrieved =
    roleCoverage.coverageKnown && roleCoverage.missingCoverage.includes('Role');

  const sourceTreeHash = ctx.manifest.sourceTreeHash;
  const refreshedAt = ctx.manifest.refreshedAt;
  const generatedAt = new Date().toISOString();

  const title = 'Sharing Model Summary';

  const objectSections =
    sortedEntries.length > 0
      ? sortedEntries
          .map((entry) => renderObjectSection(entry, sharingRuleNotRetrieved))
          .join('\n\n')
      : targetMissing !== undefined
        ? `> ⚠️ **\`${targetMissing.id}\` is referenced by ${targetMissing.referencedBy.toString()} component(s) in this org ` +
          '(e.g. lookup fields, permission-set grants, or code) but its own CustomObject definition was never ' +
          'retrieved into the vault** — typically a managed-package object or one outside the retrieve scope. ' +
          'Its OWD, sharing rules, and field-level grants cannot be reported until it is retrieved. This is **not ' +
          '"no sharing"** — it is **"not retrieved"**. Run `sfi refresh` including this object, then re-run this tool.'
        : '_(no CustomObjects matched the filter)_';

  const body = [
    `# ${title}`,
    '',
    '## Overview',
    '',
    // CR-RV12: when the OBJECT_SCAN_CAP truncated the scan, show "first N of M"
    // inline in the Overview a reader sees first — never let the plain scanned
    // count silently read as the org's complete object inventory.
    objectScanTruncated
      ? `Scanned objects: ${sortedEntries.length.toString()} of ${totalMatchingObjects.toString()} matching (capped at ${OBJECT_SCAN_CAP.toString()} — narrow with \`objectFilter\` to cover a specific object)  `
      : `Scanned objects: ${sortedEntries.length.toString()}  `,
    appliedScope === undefined
      ? '_(no objectFilter applied)_'
      : `objectFilter: \`${appliedScope}\``,
    '',
    objectSections,
    '',
    renderRoleHierarchySection(allRoles, roleNotRetrieved),
    '',
    renderFooter(
      refreshedAt,
      appliedScope === undefined
        ? 'Re-run `sfi.generate_sharing_summary({})` after the next `sfi refresh`.'
        : `Re-run \`sfi.generate_sharing_summary({ objectFilter: '${appliedScope}' })\` after the next \`sfi refresh\`.`,
    ),
  ].join('\n');

  const sectionConfidence: Record<string, ConfidenceLevel> = {
    Overview: 'declared',
    'Sharing Rules': 'declared',
    'Restriction & Scoping Rules': 'declared',
    'Role Hierarchy': 'declared',
  };

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
    'Profile / PermissionSet "with grants" counts are OBJECT-level CRUD grants (incoming `grantedBy` edges on the object carrying allowCreate / allowRead / allowEdit / allowDelete or View / Modify-All), deduped by grantor. Field-level security (FLS) is a SEPARATE plane and is NOT counted here — use `field_access_audit` for per-field grants.',
    'Restriction & Scoping rules (Restrict / Scoping enforcement) NARROW record visibility on top of OWD + sharing rules — a user who otherwise has access still only sees records matching the rule\'s `recordFilter`. They are listed per object with their enforcement type and active state; whether a given record/user is scoped needs record-level + requester context the offline metadata lacks. An empty "Restriction & Scoping Rules" section means none were retrieved for that object, not a guarantee the object is unrestricted.',
    UNMODELED_SHARING_DIMENSIONS_DISCLOSURE,
  ];
  // CR-RV12: the OBJECT_SCAN_CAP=50 slice (~L467) had NO reader-facing
  // disclosure — on a >50-object org the summary silently read as complete.
  // Mirrors the scanTruncated / "showing first N of M" shape
  // `unassigned-permission-sets.ts` established for its own per-type scan cap.
  if (objectScanTruncated) {
    boundaries.push(
      `Object scan capped: showing the first ${OBJECT_SCAN_CAP.toString()} of ${totalMatchingObjects.toString()} matching CustomObject(s) — the rest are NOT covered by this summary (not "no sharing", simply not scanned). Narrow with \`objectFilter\` to a single object for full coverage, or run \`sfi.who_can_access_object\` per object for the ones this summary omitted.`,
    );
  }
  // FULL-TYPE-SCAN-CAPPED-AT-500: the multi-window walk exhausts each type, so
  // this fires ONLY at the pathological `FULL_SCAN_MAX_NODES` residual ceiling —
  // but when it does, the missing tail is disclosed instead of rendering as an
  // empty (and therefore reassuring) sharing / restriction table.
  if (scan.value.scanIncomplete) {
    boundaries.push(fullScanTruncationNote(scan.value.incompleteTypes));
  }
  if (targetMissing !== undefined) {
    boundaries.push(
      `targetMissing: \`${targetMissing.id}\` is a phantom — referenced by ${targetMissing.referencedBy.toString()} component(s) but not retrieved; its sharing/FLS could not be computed. Refresh to retrieve it (B29).`,
    );
  }
  // C2: when the SharingRule / Role type itself was not retrieved, every empty
  // sharing-rule table and the role hierarchy are "not checked", not "none". The
  // UNMODELED_SHARING_DIMENSIONS_DISCLOSURE above covers territory / teams /
  // manual sharing — NOT "the SharingRule type was not pulled at all", which is
  // exactly the gap the C2 bug exploited.
  if (sharingRuleNotRetrieved) {
    boundaries.push(
      'SharingRule coverage gap: the `SharingRule` type was NOT retrieved into this vault (the last refresh did not pull it — a scoped, errored, or empty retrieve). Every "no sharing rules" above is therefore **not checked**, never proof an object has no sharing rules. Run `sfi refresh` including SharingRule, then re-run this tool.',
    );
  }
  if (roleNotRetrieved) {
    boundaries.push(
      'Role coverage gap: the `Role` type was NOT retrieved into this vault, so the role hierarchy is **not checked**, never "no roles". Run `sfi refresh` including Role, then re-run this tool.',
    );
  }
  // CR-CAP-05b: a roleAndSubordinates recipient expands to the role subtree
  // below it; an incomplete subtree (a subordinate Role node not retrieved, or
  // the cap hit) is disclosed, never silently treated as complete.
  if (roleSubtreeTruncated) {
    boundaries.push(
      'roleAndSubordinates subtree gap: a sharing rule shares with a role and its subordinates, but the role hierarchy BELOW that role is INCOMPLETE — a subordinate Role node was not retrieved into this vault (a partial refresh) or the subtree scan was capped. The "(and its subordinate roles)" count may UNDER-report; additional subordinate roles could also gain access. Run `sfi refresh` including Role, or see `coverage_report`.',
    );
  }
  // CR-CAP-05b: the internal-vs-portal exclusion of roleAndSubordinatesInternal
  // cannot be applied offline (Role nodes carry no portal/partner marker).
  if (internalSubordinatesUndisclosable) {
    boundaries.push(
      'roleAndSubordinatesInternal honesty boundary: a sharing rule shares with a role and its INTERNAL subordinates only (excluding partner / community portal roles), but Role nodes carry no portal/partner marker in the offline metadata, so the internal-vs-portal filter could NOT be applied. The marked subordinate roles may INCLUDE portal/partner roles the real rule excludes — verify those roles in the org.',
    );
  }

  const componentIds: ComponentId[] = [
    ...sortedEntries.map((e) => e.object.id),
    ...sortedEntries.flatMap((e) => e.sharingRules.map((r) => r.id)),
    ...sortedEntries.flatMap((e) => e.restrictionRules.map((r) => r.id)),
    ...allRoles.map((r) => r.id),
  ];

  // CR-08: fit the assembled doc (with the already-mutated CR-02/CR-04
  // `boundaries[]`) under the response budget BEFORE the global guard, so its
  // slimDataStrings never 1024-cuts `document.body` and silently strips the
  // honesty footer. `targetMissing` is a sibling DATA field (outside the
  // GeneratedDocument) and is untouched by the helper.
  const document: GeneratedDocument = fitDocumentToBudget(
    {
      frontmatter: {
        title,
        generatedAt,
        sourceTreeHash,
        componentIds,
      },
      body,
      sectionConfidence,
      boundaries,
    },
    generatedDocByteBudget(),
  );

  return ok({
    data: {
      document,
      ...(targetMissing !== undefined ? { targetMissing } : {}),
      ...(objectScanTruncated || scan.value.scanIncomplete
        ? { scanTruncated: true, totalMatchingObjects }
        : {}),
    },
    vaultState: {
      sourceTreeHash,
      refreshedAt,
    },
  });
};
