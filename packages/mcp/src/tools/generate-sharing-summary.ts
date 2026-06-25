/**
 * Handler for the `sfi.generate_sharing_summary` MCP tool.
 *
 * The v2.5 documentation-generation tier sharing-summary tool. Given
 * an optional `objectFilter` (api name string), emits a structured
 * markdown document covering every CustomObject's OWD (organization-
 * wide default), the SharingRules that apply to it, and the Profile /
 * PermissionSet grants that surface as incoming `grantedBy` edges to
 * the object's children. The Role hierarchy is rendered as a mermaid
 * diagram when Role nodes are present.
 *
 * Input:
 *   - `objectFilter` (optional string): when supplied, narrows the
 *     scan to the single CustomObject whose api name matches. Default
 *     scans every extracted CustomObject (capped at 50 per the
 *     architect-tier convention).
 *
 * Output: `{ document: GeneratedDocument }`.
 *
 * Honesty axis: per-object sharing details come from declared metadata
 * (`properties.sharingModel` on the CustomObject; the SharingRule nodes
 * extracted in v1.1). Profile / PermissionSet counts are tallied from
 * incoming `grantedBy` edges to the object's fields — a proxy for the
 * object-level grant since v1.1 stores per-component grants.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  listChildren,
  listEdges,
  listNodesByType,
} from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  INHERITED_CONFIDENCE_DISCLOSURE,
  Q125_FRESHNESS_DISCLOSURE,
  STRUCTURAL_DISCLOSURE,
  renderFooter,
  type GeneratedDocument,
} from './generate-data-dictionary.js';

/** Per-scan cap on the number of objects covered. */
const OBJECT_SCAN_CAP = 50;

/** Per-type scan cap matching the graph layer's `LIST_MAX_LIMIT`. */
const TYPE_SCAN_CAP = 500;

/**
 * Honest disclosure of the sharing dimensions this summary does NOT model, so
 * an "owner + criteria rules only" report is never read as the complete access
 * model (P11-G5). Territory & guest sharing rules are SKIPPED by the
 * sharing-rule extractor (`<sharingTerritoryRules>` / `<sharingGuestRules>`);
 * sharing sets, account/opportunity/case teams, and manual / Apex sharing are
 * record-level or config the offline metadata does not carry. Absence of any of
 * these here means "not modeled", never "the object has none".
 */
const UNMODELED_SHARING_DIMENSIONS_DISCLOSURE =
  'Sharing dimensions NOT modeled here (absence ≠ none): territory sharing rules and guest (Experience Cloud) sharing rules are skipped by the extractor; sharing sets, account / opportunity / case teams, and manual & Apex (programmatic) sharing are record-level or config not in the offline metadata. This summary covers OWD, owner + criteria sharing rules, role hierarchy, and Profile/PermissionSet grants. For a per-user record verdict (which surfaces these as explicit not-modeled stages) use `why_cant_user_see_record`.';

/** Zod schema for the `sfi.generate_sharing_summary` tool input. */
export const generateSharingSummaryInputSchema = z.object({
  objectFilter: z.string().min(1).optional(),
  /** Alias for `objectFilter` (NI-3). */
  objectApiName: z.string().min(1).optional(),
});

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

/**
 * Per-object sharing payload built before rendering. Collected once
 * per object so the rendering pass is purely formatting.
 */
interface ObjectSharing {
  readonly object: Node;
  readonly owd: string;
  readonly sharingRules: readonly Node[];
  readonly profilesWithGrants: number;
  readonly permSetsWithGrants: number;
}

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
  const lines: string[] = [
    `## ${escapeCell(label)} (\`${entry.object.apiName}\`)`,
    '',
    `**OWD (Sharing Model):** \`${entry.owd}\`  `,
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
    lines.push('| Rule | Type | Access Level | Criteria |');
    lines.push('| --- | --- | --- | --- |');
    const sorted = [...entry.sharingRules].sort((a, b) =>
      a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0,
    );
    for (const rule of sorted) {
      const ruleType = stringProp(rule.properties, 'ruleType', 'unknown');
      const access = stringProp(rule.properties, 'accessLevel', 'Unknown');
      // Surface the criteria predicate (P11-G5) so a criteria-based access path
      // isn't invisible. The predicate needs record data to evaluate, so it is a
      // declared rule definition, not a per-record verdict.
      const criteria = ruleType === 'criteria' ? criteriaPredicate(rule.properties) : '—';
      lines.push(
        `| \`${escapeCell(rule.apiName)}\` | ${escapeCell(ruleType)} | ${escapeCell(access)} | ${escapeCell(criteria)} |`,
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
 * Walk all SharingRule nodes once and return a map of sobjectType ApiName
 * to its applicable rules. v1.1 sharing-rule nodes carry the parent
 * object's api name in `properties.sObjectType`.
 */
const buildSharingRulesIndex = (
  rules: readonly Node[],
): Map<string, Node[]> => {
  const index = new Map<string, Node[]>();
  for (const rule of rules) {
    const sobj = stringProp(rule.properties, 'sObjectType', '');
    if (sobj.length === 0) continue;
    const list = index.get(sobj) ?? [];
    list.push(rule);
    index.set(sobj, list);
  }
  return index;
};

/**
 * Tally the profile / perm-set grant counts for a single object. Walks
 * each child CustomField's incoming `grantedBy` edges and collects the
 * unique grantor ids by type.
 */
const tallyGrants = async (
  ctx: Context,
  fields: readonly Node[],
): Promise<Result<{ profiles: Set<ComponentId>; permSets: Set<ComponentId> }, McpError>> => {
  const profiles = new Set<ComponentId>();
  const permSets = new Set<ComponentId>();
  for (const field of fields) {
    const edgesResult = await listEdges(ctx.graph, field.id, {
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
      if (edge.fromId.startsWith('Profile:')) profiles.add(edge.fromId);
      else if (edge.fromId.startsWith('PermissionSet:')) permSets.add(edge.fromId);
    }
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
  // Fetch CustomObjects + SharingRules + Roles once.
  const objectsResult = await listNodesByType(ctx.graph, 'CustomObject', {
    limit: TYPE_SCAN_CAP,
  });
  if (!objectsResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${objectsResult.error.message}`,
    });
  }
  const sharingRulesResult = await listNodesByType(ctx.graph, 'SharingRule', {
    limit: TYPE_SCAN_CAP,
  });
  if (!sharingRulesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${sharingRulesResult.error.message}`,
    });
  }
  const rolesResult = await listNodesByType(ctx.graph, 'Role', {
    limit: TYPE_SCAN_CAP,
  });
  if (!rolesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${rolesResult.error.message}`,
    });
  }

  // Apply the optional filter.
  let scanObjects = objectsResult.value;
  const filterName = input.objectFilter ?? input.objectApiName;
  if (filterName !== undefined) {
    const filter = filterName;
    scanObjects = scanObjects.filter((o) => o.apiName === filter);
  }
  scanObjects = scanObjects.slice(0, OBJECT_SCAN_CAP);

  // B29: a filter that matched no RETRIEVED CustomObject may still name a
  // PHANTOM — an object referenced by lookups, permission grants, or code whose
  // own definition was never pulled into the vault (managed package / outside
  // retrieve scope). Detect it via inbound edges so the answer is an honest
  // `targetMissing` ("not retrieved"), never a silent "_(no objects matched)_"
  // that reads as "this object has no sharing".
  let targetMissing: GenerateSharingSummaryOutput['targetMissing'];
  if (filterName !== undefined && scanObjects.length === 0) {
    const candidateId = `CustomObject:${filterName}` as ComponentId;
    const inbound = await listEdges(ctx.graph, candidateId, { direction: 'in' });
    const referencedBy = inbound.ok ? inbound.value.length : 0;
    if (referencedBy > 0) {
      targetMissing = { id: candidateId, referencedBy };
    }
  }

  // Build per-object sharing entries.
  const sharingIndex = buildSharingRulesIndex(sharingRulesResult.value);
  const entries: ObjectSharing[] = [];
  for (const object of scanObjects) {
    const childrenResult = await listChildren(ctx.graph, object.id);
    if (!childrenResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${childrenResult.error.message}`,
      });
    }
    const fields = childrenResult.value.filter((c) => c.type === 'CustomField');
    const grantsResult = await tallyGrants(ctx, fields);
    if (!grantsResult.ok) return err(grantsResult.error);
    const owd = stringProp(object.properties, 'sharingModel', 'Unknown');
    const rules = sharingIndex.get(object.apiName) ?? [];
    entries.push({
      object,
      owd,
      sharingRules: rules,
      profilesWithGrants: grantsResult.value.profiles.size,
      permSetsWithGrants: grantsResult.value.permSets.size,
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
    `Scanned objects: ${sortedEntries.length.toString()}  `,
    input.objectFilter === undefined
      ? '_(no objectFilter applied)_'
      : `objectFilter: \`${input.objectFilter}\``,
    '',
    objectSections,
    '',
    renderRoleHierarchySection(rolesResult.value, roleNotRetrieved),
    '',
    renderFooter(
      refreshedAt,
      input.objectFilter === undefined
        ? 'Re-run `sfi.generate_sharing_summary({})` after the next `sfi refresh`.'
        : `Re-run \`sfi.generate_sharing_summary({ objectFilter: '${input.objectFilter}' })\` after the next \`sfi refresh\`.`,
    ),
  ].join('\n');

  const sectionConfidence: Record<string, ConfidenceLevel> = {
    Overview: 'declared',
    'Sharing Rules': 'declared',
    'Role Hierarchy': 'declared',
  };

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
    'Profile / PermissionSet grant counts are tallied from field-level `grantedBy` edges; object-level grant aggregation may include duplicate grantors when multiple fields share a grant.',
    UNMODELED_SHARING_DIMENSIONS_DISCLOSURE,
  ];
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

  const componentIds: ComponentId[] = [
    ...sortedEntries.map((e) => e.object.id),
    ...sortedEntries.flatMap((e) => e.sharingRules.map((r) => r.id)),
    ...rolesResult.value.map((r) => r.id),
  ];

  const document: GeneratedDocument = {
    frontmatter: {
      title,
      generatedAt,
      sourceTreeHash,
      componentIds,
    },
    body,
    sectionConfidence,
    boundaries,
  };

  return ok({
    data: { document, ...(targetMissing !== undefined ? { targetMissing } : {}) },
    vaultState: {
      sourceTreeHash,
      refreshedAt,
    },
  });
};
