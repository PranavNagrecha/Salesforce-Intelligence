/**
 * Handler for the `sfi.export_manifest` MCP tool (P8-manifest-export).
 *
 * Groups a set of component ids by metadata type into a well-formed
 * `package.xml` snippet a human can hand to Gearset / Copado / `sf project
 * deploy`. It PROPOSES a manifest — it never deploys or writes to the org, and
 * it does not verify the ids exist (it packages exactly the ids you pass).
 * Synthetic graph nodes (e.g. `ConditionalContext`) are skipped and listed.
 */
import type {
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Default metadata API version stamped into the generated package.xml. */
const SF_API_VERSION = '62.0';

/**
 * ComponentType → the deployable metadata `<name>` for the types whose
 * package.xml name differs from the graph ComponentType. Anything not listed
 * maps to itself.
 *
 * This is the same alias table the retrieve manifest uses
 * (`packages/cli/src/commands/refresh.ts` `METADATA_API_NAME`), and for a
 * while a comment saying "KEEP IN SYNC" was the only thing holding the two
 * together. It did not: the retrieve side grew the three settings singletons
 * below and this copy did not, so `export_manifest` emitted
 * `<name>SecuritySettings</name>` — not a Metadata API xmlName — and reported
 * it packaged cleanly. The comment is no longer the guard; the drift test in
 * `packages/mcp/test/tools/export-manifest.test.ts` parses the alias literal
 * out of BOTH files and fails when this table stops covering that one.
 */
const METADATA_API_NAME: Readonly<Record<string, string>> = Object.freeze({
  VisualforcePage: 'ApexPage',
  VisualforceComponent: 'ApexComponent',
  SharingRule: 'SharingRules',
  AssignmentRule: 'AssignmentRules',
  AutoResponseRule: 'AutoResponseRules',
  EscalationRule: 'EscalationRules',
  MatchingRule: 'MatchingRules',
  WorkflowRule: 'Workflow',
  CustomMetadataRecord: 'CustomMetadata',
  // The org describe exposes no top-level `SessionSettings` /
  // `SecuritySettings` / `FieldServiceSettings` xmlName — only the umbrella
  // `Settings` container, one file per feature under `settings/`. See the
  // matching entries in refresh.ts for the describe evidence.
  SessionSettings: 'Settings',
  SecuritySettings: 'Settings',
  FieldServiceSettings: 'Settings',
});

/**
 * ComponentType → the `<members>` text for the org-level settings singletons.
 *
 * The graph ids these types carry are `{Type}:default`, but `default` names no
 * settings file: a `Settings` entry's member is the `[FeatureName]` of the
 * `[FeatureName].settings` file it deploys. Mapping only the `<name>` above
 * and leaving `<members>default</members>` would still be an undeployable
 * package.xml reported as packaged cleanly, so the member is mapped here too.
 *
 * `SessionSettings` deliberately folds onto `Security`: Salesforce emits no
 * `Session.settings-meta.xml` (the session block is nested inside
 * `Security.settings-meta.xml`, which is why one extractor co-emits both
 * nodes). Passing both singleton ids therefore yields ONE member, not two —
 * they are the same deployable file.
 */
const SETTINGS_MEMBER_NAME: Readonly<Record<string, string>> = Object.freeze({
  SecuritySettings: 'Security',
  SessionSettings: 'Security',
  FieldServiceSettings: 'FieldService',
});

/** Synthetic graph node types that are not deployable metadata — skipped. */
const NON_DEPLOYABLE_TYPES: ReadonlySet<string> = new Set([
  'ConditionalContext',
  'ReferenceStub',
]);

const toMetadataName = (type: string): string => METADATA_API_NAME[type] ?? type;

/**
 * The `<members>` text for one id. Everything except the org-level settings
 * singletons packages its ApiName verbatim (this tool packages exactly the ids
 * you pass); those three name the settings FILE they deploy instead.
 */
const toMemberName = (type: string, member: string): string =>
  SETTINGS_MEMBER_NAME[type] ?? member;

/**
 * Escape the five XML special characters so member/name text stays well-formed.
 * Exported so the `proposal-artifact` sibling (destructiveChanges.xml emitter)
 * escapes member text with the SAME rules as the package.xml generator.
 */
export const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export const exportManifestInputSchema = z.object({
  componentIds: z.array(z.string().min(1)).min(1),
  apiVersion: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `exportManifestInputSchema`. */
export type ExportManifestInput = z.infer<typeof exportManifestInputSchema>;

/** One id that could not be added to the manifest, with the reason. */
export interface ExportManifestSkipped {
  readonly id: string;
  readonly reason: string;
}

/** Per-metadata-type rollup in the manifest summary. */
export interface ExportManifestTypeBucket {
  /**
   * The graph ComponentType behind this `<types>` block — or, when SEVERAL
   * ComponentTypes deploy under one `<name>` (the settings singletons all
   * deploy as `Settings`), that shared metadata name. One `<types>` block is
   * one bucket, so this never splits a block in two. The bucket shape is
   * pinned by the published `docs/schemas/proposal.schema.json`
   * (`additionalProperties: false`), so it takes no new field here.
   */
  readonly type: string;
  readonly metadataName: string;
  readonly members: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ExportManifestOutput {
  readonly packageXml: string;
  readonly version: string;
  readonly summary: {
    readonly typeCount: number;
    readonly memberCount: number;
    readonly byType: readonly ExportManifestTypeBucket[];
  };
  readonly skipped: readonly ExportManifestSkipped[];
  readonly disclosure: string;
}

const DISCLOSURE =
  'export_manifest groups the component ids you pass into a well-formed package.xml by metadata type (each member is the id’s ApiName and the <name> is the deployable metadata-type name — the one exception is the org-level settings singletons, which deploy as members of the umbrella `Settings` type named after their `[FeatureName].settings` file, so SecuritySettings and SessionSettings are ONE member, `Security`). It PROPOSES a manifest to hand to Gearset / Copado / `sf project deploy` and NEVER deploys or writes to the org. It does not verify the ids exist in the org or vault — it packages exactly what you pass; synthetic graph nodes (e.g. ConditionalContext) and malformed ids are skipped and listed in `skipped`.';

const sortStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The grouped, rendered `<types>` body shared by the package.xml generator and
 * its destructiveChanges.xml sibling in `proposal-artifact.ts`. Both need the
 * SAME canonical `Type:Member` grouping, de-dupe/sort, NON_DEPLOYABLE_TYPES
 * skip, metadata-name mapping, and XML escaping — only the surrounding
 * `<Package>` wrapper (version vs no-version, package vs destructiveChanges)
 * differs. Extracting this keeps the two emitters byte-identical on the part
 * that matters (which members land under which `<name>`).
 */
export interface ManifestGrouping {
  /** Fully rendered `  <types>…</types>` lines, ready to splice into a Package. */
  readonly typesXml: readonly string[];
  /** Per-`<types>`-block rollup (label, deployable metadata name, member count). */
  readonly byType: readonly ExportManifestTypeBucket[];
  /** Total members across all types (post de-dupe). */
  readonly memberCount: number;
  /** Ids that were malformed or synthetic/non-deployable, with the reason. */
  readonly skipped: readonly ExportManifestSkipped[];
}

/**
 * Pure grouping+render helper shared by {@link buildExportManifest} and the
 * proposal-artifact destructiveChanges emitter. Groups canonical `Type:Member`
 * ids by type, de-dupes + sorts members and types, skips synthetic/malformed
 * ids, maps each type to its deployable metadata `<name>`, and escapes XML
 * special characters. Emits only the `<types>` block — the caller wraps it.
 */
export const groupComponentIds = (
  componentIds: readonly string[],
): ManifestGrouping => {
  // Keyed by the DEPLOYABLE metadata name, not the graph ComponentType: a
  // package.xml `<types>` block is identified by its `<name>`, and several
  // ComponentTypes can deploy under one (the settings singletons all deploy as
  // `Settings`). Keying by ComponentType emitted a separate `<types>` block per
  // ComponentType — duplicate `<name>Settings</name>` blocks naming the same
  // file, and a de-dupe that could not see across them.
  const byMetadataName = new Map<string, Set<string>>();
  const contributingTypes = new Map<string, Set<string>>();
  const skipped: ExportManifestSkipped[] = [];

  for (const id of componentIds) {
    const colon = id.indexOf(':');
    if (colon <= 0 || colon === id.length - 1) {
      skipped.push({ id, reason: 'not a canonical Type:Member id' });
      continue;
    }
    const type = id.slice(0, colon);
    const member = id.slice(colon + 1);
    if (NON_DEPLOYABLE_TYPES.has(type)) {
      skipped.push({
        id,
        reason: `${type} is a synthetic graph node, not deployable metadata`,
      });
      continue;
    }
    const metadataName = toMetadataName(type);
    const members = byMetadataName.get(metadataName) ?? new Set<string>();
    members.add(toMemberName(type, member));
    byMetadataName.set(metadataName, members);
    const sources = contributingTypes.get(metadataName) ?? new Set<string>();
    sources.add(type);
    contributingTypes.set(metadataName, sources);
  }

  const sortedNames = [...byMetadataName.keys()].sort(sortStrings);
  const typesXml = sortedNames.flatMap((metadataName) => {
    const members = [...(byMetadataName.get(metadataName) ?? new Set<string>())].sort(
      sortStrings,
    );
    return [
      '  <types>',
      ...members.map((m) => `    <members>${escapeXml(m)}</members>`),
      `    <name>${escapeXml(metadataName)}</name>`,
      '  </types>',
    ];
  });

  const byTypeSummary: ExportManifestTypeBucket[] = sortedNames.map((metadataName) => {
    const sources = [...(contributingTypes.get(metadataName) ?? new Set<string>())].sort(
      sortStrings,
    );
    return {
      type: sources.length === 1 ? (sources[0] as string) : metadataName,
      metadataName,
      members: (byMetadataName.get(metadataName) ?? new Set<string>()).size,
    };
  });
  const memberCount = byTypeSummary.reduce((n, b) => n + b.members, 0);

  return { typesXml, byType: byTypeSummary, memberCount, skipped };
};

/**
 * Pure builder: group canonical `Type:Member` ids into a package.xml. Members
 * are de-duplicated and sorted; types are sorted; XML special characters in
 * member / name text are escaped so the output parses.
 */
export const buildExportManifest = (
  componentIds: readonly string[],
  apiVersion: string,
): ExportManifestOutput => {
  const grouping = groupComponentIds(componentIds);

  const packageXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...grouping.typesXml,
    `  <version>${escapeXml(apiVersion)}</version>`,
    '</Package>',
    '',
  ].join('\n');

  return {
    packageXml,
    version: apiVersion,
    summary: {
      typeCount: grouping.byType.length,
      memberCount: grouping.memberCount,
      byType: grouping.byType,
    },
    skipped: grouping.skipped,
    disclosure: DISCLOSURE,
  };
};

export const exportManifestHandler = async (
  ctx: Context,
  input: ExportManifestInput,
): Promise<Result<McpResponse<ExportManifestOutput>, McpError>> => {
  const data = buildExportManifest(
    input.componentIds,
    input.apiVersion ?? SF_API_VERSION,
  );
  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
