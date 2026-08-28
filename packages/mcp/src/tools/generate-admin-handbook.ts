/**
 * Handler for the `sfi.generate_admin_handbook` MCP tool.
 *
 * The v2.5 documentation-generation tier admin-handbook tool. Returns
 * a structured markdown document covering the org's purpose, main
 * objects, automation summary, permission structure, integration
 * topology, and recent changes — composed over the same graph layer
 * helpers that back `sfi.org_overview` and `sfi.integration_map`.
 *
 * Input:
 *   - `personaFocus` (optional `'admin' | 'architect' | 'business-user'
 *     | 'developer'`, default `'admin'`): drives section emphasis. The
 *     `'developer'` persona moves Automation Summary up and adds a
 *     Codebase Footprint subsection; `'architect'` leads with
 *     Integration Topology; `'business-user'` keeps the default
 *     ordering but trims the codebase-tier rows.
 *
 * Output: `{ document: GeneratedDocument }` per the v2.5 contract.
 *
 * Honesty axis: the handbook is structure, not narrative. Recent
 * Changes depends on v1.7 enrichment — when no nodes carry
 * `lastModifiedDate`, the section surfaces a verbatim disclosure
 * naming the enrichment command rather than fabricating activity.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { countNodesByType } from '@sf-intelligence/graph';
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
import { scanAllNodesOfTypes } from './scan-all-nodes.js';

/** Top-N cap for the Main Objects and Recent Changes lists. */
const TOP_N = 10;

/**
 * Every metadata family this handbook tallies into a count table (Main
 * Objects, Automation Summary, Permission Structure, Integration Topology,
 * Codebase Footprint). Used to compute the R1 coverage-floor disclosure below
 * — `countNodesByType` alone cannot tell "retrieved, org genuinely has zero"
 * from "this refresh never retrieved the family", so every count in the
 * handbook must be paired with a coverage check over this exact type list.
 */
const HANDBOOK_MEASURED_TYPES: readonly ComponentType[] = [
  'CustomObject',
  'Profile',
  'PermissionSet',
  'WorkflowRule',
  'ApprovalProcess',
  'Flow',
  'ApexTrigger',
  'ApexClass',
  'NamedCredential',
  'AuthProvider',
  'ExternalService',
  'ExternalDataSource',
  'LightningComponentBundle',
  'VisualforcePage',
];

/** The PersonaFocus enum the input accepts. */
const PERSONA_FOCUS_VALUES = [
  'admin',
  'architect',
  'business-user',
  'developer',
] as const;

/** Zod schema for the `sfi.generate_admin_handbook` tool input. */
export const generateAdminHandbookInputSchema = z.object({
  personaFocus: z.enum(PERSONA_FOCUS_VALUES).optional(),
});

/** Parsed input shape, inferred from `generateAdminHandbookInputSchema`. */
export type GenerateAdminHandbookInput = z.infer<
  typeof generateAdminHandbookInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GenerateAdminHandbookOutput {
  readonly document: GeneratedDocument;
}

/**
 * Fetch EVERY node of a single ComponentType, windowing the SQL `OFFSET` past
 * the graph layer's 500-row per-page cap. Used for the per-section lists.
 * Recent Changes sorts by `lastModifiedDate` DESC over this list, so a single
 * id-ASC page made it "the most recent among the alphabetically-first 500".
 */
const fetchNodes = async (
  ctx: Context,
  type: ComponentType,
): Promise<Result<readonly Node[], McpError>> => {
  const result = await scanAllNodesOfTypes(ctx.graph, [type]);
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  return ok(result.value.nodes);
};

/**
 * Exact COUNT(*) tally for a single ComponentType. The per-section counts come
 * from here rather than `fetchNodes(...).value.length`: it is the cheaper
 * source of truth and it still holds for a type whose full scan stopped at the
 * residual `FULL_SCAN_MAX_NODES` ceiling. Mirrors `org_overview`.
 */
const countNodes = async (
  ctx: Context,
  type: ComponentType,
): Promise<Result<number, McpError>> => {
  const result = await countNodesByType(ctx.graph, type);
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  return ok(result.value);
};

/**
 * True when the manifest reports `complete` coverage for a family (or
 * coverage is unknown — a pre-v4/legacy vault is not false-flagged). Mirrors
 * the identical helper in `doc-coverage-report.ts` / `limit-headroom-report.ts`
 * (an R6 duplication the census flagged; those two files are off-limits to
 * this fix — see `needsOrchestrator`).
 */
const coverageComplete = (ctx: Context, type: ComponentType): boolean => {
  const summary = summarizeCoverage(ctx.manifest, [type]);
  if (!summary.coverageKnown) return true; // legacy vault — do not false-flag
  return summary.status === 'complete';
};

/**
 * R1: build the coverage-floor boundary naming every measured family whose
 * retrieve the manifest cannot confirm complete. A count table row of `0` for
 * an incomplete family reads identically to a confirmed-empty org unless this
 * fires — this is the disclosure that tells them apart.
 */
const buildCoverageFloorDisclosure = (
  incompleteFamilies: readonly string[],
): string =>
  incompleteFamilies.length > 0
    ? `Coverage floor: this vault's refresh did not confirm complete retrieval for ${[...incompleteFamilies].sort().join(', ')} — counts for these families above are a floor (possibly under-counted, or the family was dropped entirely), not a confirmed total. A row reading \`0\` for one of these families means "not confirmed retrieved", not "confirmed the org has none".`
    : 'All metadata families this handbook counts are fully covered per the manifest.';

/** Escape a markdown table cell. */
const escapeCell = (raw: string): string =>
  raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Render the Org Purpose H2 — a short paragraph naming the source org. */
const renderPurposeSection = (
  sourceOrg: string,
  totalComponents: number,
  personaFocus: string,
): string =>
  [
    '## Purpose and Audience',
    '',
    `This handbook describes the Salesforce org \`${escapeCell(sourceOrg)}\` (extracted offline). Persona focus: \`${personaFocus}\`. Total extracted components: ${totalComponents.toString()}.`,
  ].join('\n');

/**
 * Render the Main Objects H2 — top CustomObjects by api name with a
 * mermaid diagram showing the first N. The diagram uses simple boxes
 * so any mermaid renderer will display it.
 */
const renderMainObjectsSection = (objects: readonly Node[]): string => {
  if (objects.length === 0) {
    return ['## Main Objects', '', '_(no CustomObjects extracted)_'].join('\n');
  }
  const sorted = [...objects].sort((a, b) =>
    a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0,
  );
  const top = sorted.slice(0, TOP_N);
  const lines: string[] = ['## Main Objects', '', '```mermaid', 'graph LR'];
  for (let i = 0; i < top.length; i += 1) {
    const obj = top[i];
    if (obj === undefined) continue;
    const safeName = obj.apiName.replace(/[^A-Za-z0-9_]/g, '_');
    lines.push(`  ${safeName}["${obj.label ?? obj.apiName}"]`);
  }
  lines.push('```', '');
  lines.push('| API Name | Label |');
  lines.push('| --- | --- |');
  for (const obj of top) {
    lines.push(`| \`${escapeCell(obj.apiName)}\` | ${escapeCell(obj.label ?? '')} |`);
  }
  return lines.join('\n');
};

/** Render the Automation Summary H2 with a table of automation counts. */
const renderAutomationSection = (
  workflowRules: number,
  approvalProcesses: number,
  flows: number,
  apexTriggers: number,
): string => {
  return [
    '## Automation Summary',
    '',
    '| Surface | Count |',
    '| --- | --- |',
    `| WorkflowRule | ${workflowRules.toString()} |`,
    `| ApprovalProcess | ${approvalProcesses.toString()} |`,
    `| Flow | ${flows.toString()} |`,
    `| ApexTrigger | ${apexTriggers.toString()} |`,
  ].join('\n');
};

/** Render the Permission Structure H2 with Profile + PermissionSet counts. */
const renderPermissionSection = (
  profiles: number,
  permissionSets: number,
): string =>
  [
    '## Permission Structure',
    '',
    '| Surface | Count |',
    '| --- | --- |',
    `| Profile | ${profiles.toString()} |`,
    `| PermissionSet | ${permissionSets.toString()} |`,
  ].join('\n');

/** Render the Integration Topology H2 with NamedCred + ExternalDataSource counts. */
const renderIntegrationSection = (
  namedCredentials: number,
  authProviders: number,
  externalServices: number,
  externalDataSources: number,
): string =>
  [
    '## Integration Topology',
    '',
    '| Surface | Count |',
    '| --- | --- |',
    `| NamedCredential | ${namedCredentials.toString()} |`,
    `| AuthProvider | ${authProviders.toString()} |`,
    `| ExternalService | ${externalServices.toString()} |`,
    `| ExternalDataSource | ${externalDataSources.toString()} |`,
  ].join('\n');

/**
 * Render the Recent Changes H2. When no node in the supplied list
 * carries a non-null `lastModifiedDate`, surface the v1.7-enrichment
 * disclosure verbatim rather than fabricating activity.
 */
const renderRecentChangesSection = (
  candidates: readonly Node[],
): string => {
  const enriched = candidates.filter((n) => n.lastModifiedDate !== null);
  if (enriched.length === 0) {
    return [
      '## Recent Changes',
      '',
      'Recent-change data depends on v1.7 enrichment. Run `sfi refresh --with-tooling-api` to populate `lastModifiedDate` for the enriched types.',
    ].join('\n');
  }
  const sorted = [...enriched].sort((a, b) => {
    const ad = a.lastModifiedDate ?? '';
    const bd = b.lastModifiedDate ?? '';
    if (ad !== bd) return ad < bd ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
  const top = sorted.slice(0, TOP_N);
  const rows = top.map(
    (n) =>
      `| ${n.lastModifiedDate ?? '_n/a_'} | \`${n.id}\` | ${n.lastModifiedBy ?? '_n/a_'} |`,
  );
  return [
    '## Recent Changes',
    '',
    '| Last Modified | Component | Modified By |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
};

/**
 * Render the Codebase Footprint H2 — appended only for the `'developer'`
 * persona. A simple table of Apex + LWC + VF counts.
 */
const renderCodebaseFootprintSection = (
  apexClasses: number,
  apexTriggers: number,
  lwcBundles: number,
  vfPages: number,
): string =>
  [
    '## Codebase Footprint',
    '',
    '| Surface | Count |',
    '| --- | --- |',
    `| ApexClass | ${apexClasses.toString()} |`,
    `| ApexTrigger | ${apexTriggers.toString()} |`,
    `| LightningComponentBundle | ${lwcBundles.toString()} |`,
    `| VisualforcePage | ${vfPages.toString()} |`,
  ].join('\n');

/**
 * The `sfi.generate_admin_handbook` MCP tool. Returns a structured
 * markdown handbook for the org. See the module JSDoc for the recipe
 * and the persona-specific section ordering.
 */
export const generateAdminHandbookHandler = async (
  ctx: Context,
  input: GenerateAdminHandbookInput,
): Promise<Result<McpResponse<GenerateAdminHandbookOutput>, McpError>> => {
  const persona = input.personaFocus ?? 'admin';

  // Enumerate every type we tally, each scanned in full (the per-type walk
  // windows past the 500-row page cap).
  const objectsResult = await fetchNodes(ctx, 'CustomObject');
  if (!objectsResult.ok) return err(objectsResult.error);
  const profilesResult = await fetchNodes(ctx, 'Profile');
  if (!profilesResult.ok) return err(profilesResult.error);
  const permSetsResult = await fetchNodes(ctx, 'PermissionSet');
  if (!permSetsResult.ok) return err(permSetsResult.error);
  const workflowsResult = await fetchNodes(ctx, 'WorkflowRule');
  if (!workflowsResult.ok) return err(workflowsResult.error);
  const approvalsResult = await fetchNodes(ctx, 'ApprovalProcess');
  if (!approvalsResult.ok) return err(approvalsResult.error);
  const flowsResult = await fetchNodes(ctx, 'Flow');
  if (!flowsResult.ok) return err(flowsResult.error);
  const triggersResult = await fetchNodes(ctx, 'ApexTrigger');
  if (!triggersResult.ok) return err(triggersResult.error);
  const apexResult = await fetchNodes(ctx, 'ApexClass');
  if (!apexResult.ok) return err(apexResult.error);
  const namedCredResult = await fetchNodes(ctx, 'NamedCredential');
  if (!namedCredResult.ok) return err(namedCredResult.error);
  const authProvResult = await fetchNodes(ctx, 'AuthProvider');
  if (!authProvResult.ok) return err(authProvResult.error);
  const externalSvcResult = await fetchNodes(ctx, 'ExternalService');
  if (!externalSvcResult.ok) return err(externalSvcResult.error);
  const externalDsResult = await fetchNodes(ctx, 'ExternalDataSource');
  if (!externalDsResult.ok) return err(externalDsResult.error);
  const lwcResult = await fetchNodes(ctx, 'LightningComponentBundle');
  if (!lwcResult.ok) return err(lwcResult.error);
  const vfResult = await fetchNodes(ctx, 'VisualforcePage');
  if (!vfResult.ok) return err(vfResult.error);

  // Exact per-type tallies via COUNT(*). The fetchNodes lists above feed the
  // genuine list consumers (Main Objects top-N, Recent Changes candidates).
  const objectCount = await countNodes(ctx, 'CustomObject');
  if (!objectCount.ok) return err(objectCount.error);
  const profileCount = await countNodes(ctx, 'Profile');
  if (!profileCount.ok) return err(profileCount.error);
  const permSetCount = await countNodes(ctx, 'PermissionSet');
  if (!permSetCount.ok) return err(permSetCount.error);
  const workflowCount = await countNodes(ctx, 'WorkflowRule');
  if (!workflowCount.ok) return err(workflowCount.error);
  const approvalCount = await countNodes(ctx, 'ApprovalProcess');
  if (!approvalCount.ok) return err(approvalCount.error);
  const flowCount = await countNodes(ctx, 'Flow');
  if (!flowCount.ok) return err(flowCount.error);
  const triggerCount = await countNodes(ctx, 'ApexTrigger');
  if (!triggerCount.ok) return err(triggerCount.error);
  const apexCount = await countNodes(ctx, 'ApexClass');
  if (!apexCount.ok) return err(apexCount.error);
  const namedCredCount = await countNodes(ctx, 'NamedCredential');
  if (!namedCredCount.ok) return err(namedCredCount.error);
  const authProvCount = await countNodes(ctx, 'AuthProvider');
  if (!authProvCount.ok) return err(authProvCount.error);
  const externalSvcCount = await countNodes(ctx, 'ExternalService');
  if (!externalSvcCount.ok) return err(externalSvcCount.error);
  const externalDsCount = await countNodes(ctx, 'ExternalDataSource');
  if (!externalDsCount.ok) return err(externalDsCount.error);
  const lwcCount = await countNodes(ctx, 'LightningComponentBundle');
  if (!lwcCount.ok) return err(lwcCount.error);
  const vfCount = await countNodes(ctx, 'VisualforcePage');
  if (!vfCount.ok) return err(vfCount.error);

  const objects = objectsResult.value;
  const totalComponents =
    objectCount.value +
    profileCount.value +
    permSetCount.value +
    workflowCount.value +
    approvalCount.value +
    flowCount.value +
    triggerCount.value +
    apexCount.value +
    namedCredCount.value +
    authProvCount.value +
    externalSvcCount.value +
    externalDsCount.value +
    lwcCount.value +
    vfCount.value;

  // The Recent Changes candidate pool: every code-tier node, since the
  // v1.7 enricher targets those types. An empty enrichment surfaces a
  // disclosure rather than a fabricated list.
  const recentCandidates: Node[] = [
    ...apexResult.value,
    ...triggersResult.value,
    ...flowsResult.value,
  ];

  // Section blocks.
  const purposeSection = renderPurposeSection(
    ctx.manifest.sourceOrg,
    totalComponents,
    persona,
  );
  const mainObjectsSection = renderMainObjectsSection(objects);
  const automationSection = renderAutomationSection(
    workflowCount.value,
    approvalCount.value,
    flowCount.value,
    triggerCount.value,
  );
  const permissionSection = renderPermissionSection(
    profileCount.value,
    permSetCount.value,
  );
  const integrationSection = renderIntegrationSection(
    namedCredCount.value,
    authProvCount.value,
    externalSvcCount.value,
    externalDsCount.value,
  );
  const recentChangesSection = renderRecentChangesSection(recentCandidates);
  const codebaseSection = renderCodebaseFootprintSection(
    apexCount.value,
    triggerCount.value,
    lwcCount.value,
    vfCount.value,
  );

  // Persona-specific ordering. The H1 + Purpose always lead; the
  // remaining sections shuffle based on persona.
  let orderedSections: readonly string[];
  if (persona === 'developer') {
    orderedSections = [
      mainObjectsSection,
      automationSection,
      codebaseSection,
      permissionSection,
      integrationSection,
      recentChangesSection,
    ];
  } else if (persona === 'architect') {
    orderedSections = [
      integrationSection,
      mainObjectsSection,
      automationSection,
      permissionSection,
      recentChangesSection,
    ];
  } else if (persona === 'business-user') {
    orderedSections = [
      mainObjectsSection,
      automationSection,
      permissionSection,
      integrationSection,
      recentChangesSection,
    ];
  } else {
    // admin (default)
    orderedSections = [
      mainObjectsSection,
      automationSection,
      permissionSection,
      integrationSection,
      recentChangesSection,
    ];
  }

  const sourceTreeHash = ctx.manifest.sourceTreeHash;
  const refreshedAt = ctx.manifest.refreshedAt;
  const generatedAt = new Date().toISOString();

  const title = `${ctx.manifest.sourceOrg} — Admin Handbook (${persona})`;

  const body = [
    `# ${title}`,
    '',
    purposeSection,
    '',
    ...orderedSections.flatMap((s) => [s, '']),
    renderFooter(
      refreshedAt,
      `Re-run \`sfi.generate_admin_handbook({ personaFocus: '${persona}' })\` after the next \`sfi refresh\`.`,
    ),
  ].join('\n');

  const sectionConfidence: Record<string, ConfidenceLevel> = {
    'Purpose and Audience': 'declared',
    'Main Objects': 'declared',
    'Automation Summary': 'declared',
    'Permission Structure': 'declared',
    'Integration Topology': 'declared',
    'Recent Changes': 'declared',
  };
  if (persona === 'developer') {
    sectionConfidence['Codebase Footprint'] = 'declared';
  }

  // R1: coverage honesty across every family the count tables tally. A `0`
  // row for a family whose retrieve the manifest cannot confirm complete
  // must not read as a confirmed-empty org.
  const incompleteFamilies = HANDBOOK_MEASURED_TYPES.filter(
    (t) => !coverageComplete(ctx, t),
  );

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
    buildCoverageFloorDisclosure(incompleteFamilies),
  ];

  // Component ids: every node of every type, scanned to exhaustion via
  // scanAllNodesOfTypes. The id list is the union of every type-list.
  const componentIds: ComponentId[] = [
    ...objects.map((n) => n.id),
    ...profilesResult.value.map((n) => n.id),
    ...permSetsResult.value.map((n) => n.id),
    ...workflowsResult.value.map((n) => n.id),
    ...approvalsResult.value.map((n) => n.id),
    ...flowsResult.value.map((n) => n.id),
    ...triggersResult.value.map((n) => n.id),
    ...apexResult.value.map((n) => n.id),
    ...namedCredResult.value.map((n) => n.id),
    ...authProvResult.value.map((n) => n.id),
    ...externalSvcResult.value.map((n) => n.id),
    ...externalDsResult.value.map((n) => n.id),
    ...lwcResult.value.map((n) => n.id),
    ...vfResult.value.map((n) => n.id),
  ];

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
    data: { document },
    vaultState: {
      sourceTreeHash,
      refreshedAt,
    },
  });
};
