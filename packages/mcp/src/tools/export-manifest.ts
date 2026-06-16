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
 * package.xml name differs from the graph ComponentType. KEEP IN SYNC with
 * `packages/cli/src/commands/refresh.ts` `METADATA_API_NAME` (the retrieve
 * manifest uses the same mapping). Anything not listed maps to itself.
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
});

/** Synthetic graph node types that are not deployable metadata — skipped. */
const NON_DEPLOYABLE_TYPES: ReadonlySet<string> = new Set([
  'ConditionalContext',
  'ReferenceStub',
]);

const toMetadataName = (type: string): string => METADATA_API_NAME[type] ?? type;

/** Escape the five XML special characters so member/name text stays well-formed. */
const escapeXml = (s: string): string =>
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
  'export_manifest groups the component ids you pass into a well-formed package.xml by metadata type (each member is the id’s ApiName; the <name> uses the deployable metadata-type name). It PROPOSES a manifest to hand to Gearset / Copado / `sf project deploy` and NEVER deploys or writes to the org. It does not verify the ids exist in the org or vault — it packages exactly what you pass; synthetic graph nodes (e.g. ConditionalContext) and malformed ids are skipped and listed in `skipped`.';

const sortStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pure builder: group canonical `Type:Member` ids into a package.xml. Members
 * are de-duplicated and sorted; types are sorted; XML special characters in
 * member / name text are escaped so the output parses.
 */
export const buildExportManifest = (
  componentIds: readonly string[],
  apiVersion: string,
): ExportManifestOutput => {
  const byType = new Map<string, Set<string>>();
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
    const members = byType.get(type) ?? new Set<string>();
    members.add(member);
    byType.set(type, members);
  }

  const sortedTypes = [...byType.keys()].sort(sortStrings);
  const typesXml = sortedTypes.flatMap((type) => {
    const members = [...(byType.get(type) ?? new Set<string>())].sort(sortStrings);
    return [
      '  <types>',
      ...members.map((m) => `    <members>${escapeXml(m)}</members>`),
      `    <name>${escapeXml(toMetadataName(type))}</name>`,
      '  </types>',
    ];
  });

  const packageXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...typesXml,
    `  <version>${escapeXml(apiVersion)}</version>`,
    '</Package>',
    '',
  ].join('\n');

  const byTypeSummary: ExportManifestTypeBucket[] = sortedTypes.map((type) => ({
    type,
    metadataName: toMetadataName(type),
    members: (byType.get(type) ?? new Set<string>()).size,
  }));
  const memberCount = byTypeSummary.reduce((n, b) => n + b.members, 0);

  return {
    packageXml,
    version: apiVersion,
    summary: { typeCount: sortedTypes.length, memberCount, byType: byTypeSummary },
    skipped,
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
