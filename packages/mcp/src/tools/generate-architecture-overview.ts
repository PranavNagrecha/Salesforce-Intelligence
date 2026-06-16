/**
 * Handler for the `sfi.generate_architecture_overview` MCP tool.
 *
 * The v2.5 documentation-generation tier architecture-overview tool.
 * Returns a 3-4 page architecture document composed by chaining the
 * existing `sfi.org_overview`, `sfi.domain_clusters`, and
 * `sfi.integration_map` handlers, then rendering the composed output
 * as structured markdown with mermaid diagrams.
 *
 * Input: `{ format?: 'markdown' | 'html' }`.
 *
 * Output: `{ document: GeneratedDocument }`, plus `html` (a self-contained
 * HTML page) when `format: 'html'`. The body is structured markdown with
 * three mermaid diagrams (org structure, domain clustering, integration
 * topology) and supporting tables; the HTML export renders all of it
 * client-side and is meant to be written to a `.html` file.
 *
 * Honesty axis: every "top X" ranking inherits the upstream tools'
 * heuristic provenance. The body's Boundaries section surfaces the
 * v2.5 verbatim disclosures.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { renderHtmlDocument } from '../html-document.js';
import type { Context } from '../server.js';

import { domainClustersHandler } from './domain-clusters.js';
import {
  INHERITED_CONFIDENCE_DISCLOSURE,
  Q125_FRESHNESS_DISCLOSURE,
  STRUCTURAL_DISCLOSURE,
  renderFooter,
  type GeneratedDocument,
} from './generate-data-dictionary.js';
import { integrationMapHandler } from './integration-map.js';
import { orgOverviewHandler } from './org-overview.js';

/** Zod schema for the `sfi.generate_architecture_overview` tool input. */
export const generateArchitectureOverviewInputSchema = z.object({
  /**
   * Output format. `'markdown'` (default) returns just the structured
   * `document`. `'html'` ALSO returns a self-contained `html` page that renders
   * the markdown and its mermaid diagrams in a browser — write it to a `.html`
   * file to share the architecture overview as a standalone artifact.
   */
  format: z.enum(['markdown', 'html']).optional(),
});

/** Parsed input shape. */
export type GenerateArchitectureOverviewInput = z.infer<
  typeof generateArchitectureOverviewInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GenerateArchitectureOverviewOutput {
  readonly document: GeneratedDocument;
  /**
   * A self-contained HTML rendering of `document`. Present only when the caller
   * passed `format: 'html'`. The `document` (markdown) is always returned.
   */
  readonly html?: string;
}

/** Escape a markdown table cell. */
const escapeCell = (raw: string): string =>
  raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Sanitise an api name for use as a mermaid node id. */
const safeMermaidId = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * The `sfi.generate_architecture_overview` MCP tool. Composes
 * `sfi.org_overview` + `sfi.domain_clusters` + `sfi.integration_map`
 * into a single structured markdown document.
 */
export const generateArchitectureOverviewHandler = async (
  ctx: Context,
  input: GenerateArchitectureOverviewInput,
): Promise<
  Result<McpResponse<GenerateArchitectureOverviewOutput>, McpError>
> => {
  const overviewResult = await orgOverviewHandler(ctx, {});
  if (!overviewResult.ok) return err(overviewResult.error);
  const domainsResult = await domainClustersHandler(ctx, {});
  if (!domainsResult.ok) return err(domainsResult.error);
  const integrationResult = await integrationMapHandler(ctx, {});
  if (!integrationResult.ok) return err(integrationResult.error);

  const overview = overviewResult.value.data;
  const domains = domainsResult.value.data;
  const integration = integrationResult.value.data;

  // Executive summary: a few headline counts.
  const counts = overview.componentCounts;
  const exec = [
    '## Executive Summary',
    '',
    `Total CustomObjects: ${(counts['CustomObject'] ?? 0).toString()}  `,
    `Total ApexClasses: ${(counts['ApexClass'] ?? 0).toString()}  `,
    `Total Flows: ${(counts['Flow'] ?? 0).toString()}  `,
    `Top objects by inbound references: ${overview.topObjects.length.toString()}`,
  ].join('\n');

  // Org Structure diagram (mermaid): the top 5 objects as nodes.
  const topObjects = overview.topObjects.slice(0, 5);
  const orgDiagram: string[] = ['```mermaid', 'graph TD'];
  if (topObjects.length === 0) {
    orgDiagram.push('  empty["no extracted objects"]');
  } else {
    for (const obj of topObjects) {
      orgDiagram.push(
        `  ${safeMermaidId(obj.apiName)}["${escapeCell(obj.apiName)} (${obj.inboundReferences.toString()} refs)"]`,
      );
    }
  }
  orgDiagram.push('```');

  const orgStructureSection = [
    '## Org Structure',
    '',
    ...orgDiagram,
  ].join('\n');

  // Domain Clustering diagram + per-domain section.
  const domainsLines: string[] = ['## Domain Clustering', ''];
  if (domains.clusters.length === 0) {
    domainsLines.push('_(no clusters surfaced — every candidate was below the density threshold)_');
  } else {
    domainsLines.push('```mermaid');
    domainsLines.push('graph LR');
    for (const cluster of domains.clusters) {
      const centerSlug = safeMermaidId(cluster.centerComponent.apiName);
      const memberCount = cluster.members.length.toString();
      domainsLines.push(
        `  ${centerSlug}["${escapeCell(cluster.suggestedName)} (${memberCount})"]`,
      );
    }
    domainsLines.push('```');
    domainsLines.push('');
    domainsLines.push('| Cluster | Members | Center |');
    domainsLines.push('| --- | --- | --- |');
    for (const cluster of domains.clusters) {
      domainsLines.push(
        `| ${escapeCell(cluster.suggestedName)} | ${cluster.members.length.toString()} | \`${cluster.centerComponent.id}\` |`,
      );
    }
  }

  // Integration Topology diagram + table.
  const integrationLines: string[] = ['## Integration Topology', ''];
  const allIntegrationNodes = [
    ...integration.authProviders,
    ...integration.namedCredentials,
    ...integration.remoteSiteSettings,
    ...integration.cspTrustedSites,
    ...integration.externalDataSources,
    ...integration.externalServices,
    ...integration.connectedApps,
    ...integration.networkAccesses,
  ];
  if (allIntegrationNodes.length === 0) {
    integrationLines.push('_(no integration surfaces extracted)_');
  } else {
    integrationLines.push('```mermaid');
    integrationLines.push('graph LR');
    for (const node of allIntegrationNodes.slice(0, 20)) {
      integrationLines.push(
        `  ${safeMermaidId(node.apiName)}["${escapeCell(node.apiName)} (${node.type})"]`,
      );
    }
    for (const edge of integration.references) {
      integrationLines.push(
        `  ${safeMermaidId(edge.fromId.split(':').slice(1).join(':'))} --> ${safeMermaidId(edge.toId.split(':').slice(1).join(':'))}`,
      );
    }
    integrationLines.push('```');
    integrationLines.push('');
    integrationLines.push('| Type | Count |');
    integrationLines.push('| --- | --- |');
    integrationLines.push(`| AuthProvider | ${integration.authProviders.length.toString()} |`);
    integrationLines.push(`| NamedCredential | ${integration.namedCredentials.length.toString()} |`);
    integrationLines.push(`| RemoteSiteSetting | ${integration.remoteSiteSettings.length.toString()} |`);
    integrationLines.push(`| CspTrustedSite | ${integration.cspTrustedSites.length.toString()} |`);
    integrationLines.push(`| ExternalDataSource | ${integration.externalDataSources.length.toString()} |`);
    integrationLines.push(`| ExternalService | ${integration.externalServices.length.toString()} |`);
    integrationLines.push(`| ConnectedApp | ${integration.connectedApps.length.toString()} |`);
    integrationLines.push(`| NetworkAccess | ${integration.networkAccesses.length.toString()} |`);
  }

  // Automation footprint.
  const automation = overview.automationSummary;
  const automationSection = [
    '## Automation Footprint',
    '',
    '| Surface | Count |',
    '| --- | --- |',
    `| WorkflowRule | ${automation.workflowRules.toString()} |`,
    `| ApprovalProcess | ${automation.approvalProcesses.toString()} |`,
    `| Flow | ${automation.flows.toString()} |`,
    `| ApexTrigger | ${automation.apexTriggers.toString()} |`,
    `| Active ratio | ${automation.activeRatio.toFixed(2)} |`,
  ].join('\n');

  // Codebase footprint.
  const codebase = overview.frontendSummary;
  const codebaseSection = [
    '## Codebase Footprint',
    '',
    '| Surface | Count |',
    '| --- | --- |',
    `| LightningComponentBundle | ${codebase.lwcBundles.toString()} |`,
    `| AuraDefinitionBundle | ${codebase.auraBundles.toString()} |`,
    `| VisualforcePage | ${codebase.vfPages.toString()} |`,
    `| VisualforceComponent | ${codebase.vfComponents.toString()} |`,
    `| Legacy VF debt ratio | ${codebase.legacyVfDebtRatio.toFixed(2)} |`,
  ].join('\n');

  const sourceTreeHash = ctx.manifest.sourceTreeHash;
  const refreshedAt = ctx.manifest.refreshedAt;
  const generatedAt = new Date().toISOString();

  const title = `${ctx.manifest.sourceOrg} — Architecture Overview`;

  const body = [
    `# ${title}`,
    '',
    exec,
    '',
    orgStructureSection,
    '',
    domainsLines.join('\n'),
    '',
    integrationLines.join('\n'),
    '',
    automationSection,
    '',
    codebaseSection,
    '',
    renderFooter(
      refreshedAt,
      'Re-run `sfi.generate_architecture_overview({})` after the next `sfi refresh`.',
    ),
  ].join('\n');

  const sectionConfidence: Record<string, ConfidenceLevel> = {
    'Executive Summary': 'declared',
    'Org Structure': 'heuristic',
    'Domain Clustering': 'heuristic',
    'Integration Topology': 'declared',
    'Automation Footprint': 'declared',
    'Codebase Footprint': 'declared',
  };

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
    'Domain clusters and top-object rankings are heuristic — present as suggested starting points, not authoritative groupings.',
    'Scope: this overview is a STRUCTURED TOUR composed from org_overview, domain_clusters, and integration_map — a starting map, not a deep architectural analysis. It does not trace Apex call chains, data/field lineage, or the sharing model. For those, follow up with `sfi.call_graph`, `sfi.get_subgraph`, `sfi.field_lineage`, and `sfi.generate_sharing_summary` on the components this tour surfaces.',
  ];

  // Component ids: top objects + domain centres + integration nodes,
  // DEDUPLICATED in first-seen order. A component can be selected by more
  // than one source list — most commonly a top object (by inbound
  // references) that is ALSO a domain-cluster centre — and the frontmatter
  // id list is a provenance SET, not a multiset, so it must not repeat.
  const componentIds: ComponentId[] = [
    ...new Set<ComponentId>([
      ...overview.topObjects.map((o) => o.id),
      ...domains.clusters.map((c) => c.centerComponent.id),
      ...allIntegrationNodes.map((n) => n.id),
    ]),
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

  // P11-artifacts-html: when asked, also render a self-contained HTML page so the
  // overview can be saved as a shareable `.html` artifact (mermaid diagrams and
  // all). The markdown `document` is always returned regardless of format.
  const html =
    input.format === 'html' ? renderHtmlDocument(title, body) : undefined;

  return ok({
    data: html === undefined ? { document } : { document, html },
    vaultState: {
      sourceTreeHash,
      refreshedAt,
    },
  });
};
