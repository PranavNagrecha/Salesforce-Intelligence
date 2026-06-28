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
  GENERATED_DOC_BUDGET_FLOOR_BYTES,
  INHERITED_CONFIDENCE_DISCLOSURE,
  Q125_FRESHNESS_DISCLOSURE,
  STRUCTURAL_DISCLOSURE,
  fitDocumentToBudget,
  generatedDocByteBudget,
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

  // CR-08: fit the assembled doc under the response budget BEFORE the global
  // guard so its slimDataStrings never 1024-cuts `document.body` and strips the
  // honesty footer.
  const budget = generatedDocByteBudget();
  const rawDoc = {
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

  const vaultState = { sourceTreeHash, refreshedAt };

  // Markdown path: identical to every sibling generator — fit the document to
  // the per-doc budget, return. The 40 KB small-org path is byte-identical.
  if (input.format !== 'html') {
    const document = fitDocumentToBudget(rawDoc, budget);
    return ok({ data: { document }, vaultState });
  }

  // CR-P3-4 / CR-RV8: html path. The saved artifact is the html string, which
  // is built FROM `document.body` — so the assembled envelope carries the body
  // TWICE (once as `document`, once embedded+JSON-escaped inside `html`). The
  // old `budget / 2` reserve double-counted the body WITHOUT measuring the real
  // envelope, so a large overview's `html` overflowed the global guard's
  // reductionCap and was slim-chopped to 1024 chars (no closing `</html>`, a
  // corrupt artifact). Fix: measure the ACTUAL assembled envelope
  // `{ data: { document, html }, vaultState }` (matches jsonResult's utf8Bytes)
  // and shrink the FITTED document until that whole envelope fits — never the
  // body alone. The html is always rebuilt from the fitted body, so the saved
  // .html tracks the markdown exactly. If even a minimally-fitted document still
  // overflows, return a structured `oversize` error rather than a silently
  // chopped html.
  const envelopeBytes = (document: GeneratedDocument, html: string): number =>
    Buffer.byteLength(
      JSON.stringify({ data: { document, html }, vaultState }),
      'utf8',
    );

  const buildFitted = (
    docBudget: number,
  ): { document: GeneratedDocument; html: string } => {
    const document = fitDocumentToBudget(rawDoc, docBudget);
    const html = renderHtmlDocument(title, document.body);
    return { document, html };
  };

  // Try the full budget first (the small-org common case: the assembled
  // envelope fits well under the cap, so `document` is byte-identical to the
  // markdown path and the html is returned whole).
  let docBudget = budget;
  let fitted = buildFitted(docBudget);

  // Shrink the document budget until the assembled envelope fits the per-doc
  // budget. Each pass roughly halves the headroom; bounded by the budget floor.
  while (envelopeBytes(fitted.document, fitted.html) > budget) {
    const overshoot = envelopeBytes(fitted.document, fitted.html) - budget;
    const next = docBudget - Math.max(512, overshoot);
    if (next <= GENERATED_DOC_BUDGET_FLOOR_BYTES) {
      // Already at the smallest fit and the envelope STILL overflows — the
      // irreducible document + html cannot fit. Surface a structured oversize
      // error instead of a slim-chopped, malformed artifact.
      const minimal = buildFitted(GENERATED_DOC_BUDGET_FLOOR_BYTES);
      if (envelopeBytes(minimal.document, minimal.html) > budget) {
        return err({
          kind: 'oversize',
          message:
            `The architecture overview html artifact (~${Math.round(
              envelopeBytes(minimal.document, minimal.html) / 1000,
            ).toString()} KB even after maximal reduction) exceeds the response budget ` +
            `(~${Math.round(budget / 1000).toString()} KB, SFI_MAX_RESPONSE_BYTES). ` +
            'Request `format: "markdown"` (the document is returned without the doubled html), or raise SFI_MAX_RESPONSE_BYTES.',
        });
      }
      fitted = minimal;
      break;
    }
    docBudget = next;
    fitted = buildFitted(docBudget);
  }

  return ok({
    data: { document: fitted.document, html: fitted.html },
    vaultState,
  });
};
