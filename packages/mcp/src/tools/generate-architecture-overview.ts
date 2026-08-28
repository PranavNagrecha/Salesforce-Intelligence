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
 * FOUR mermaid diagrams (org structure, domain clustering, integration
 * topology, and — R6-19 — an entity-relationship diagram of the top
 * objects by Lookup/Master-Detail relationship degree) and supporting
 * tables; the HTML export renders all of it client-side and is meant to
 * be written to a `.html` file.
 *
 * Honesty axis: every "top X" ranking inherits the upstream tools'
 * heuristic provenance. The body's Boundaries section surfaces the
 * v2.5 verbatim disclosures. CR-22-B6: the two mermaid diagrams' node caps
 * (Org Structure top `ORG_STRUCTURE_DIAGRAM_CAP`=5 by inbound references;
 * Integration Topology top `INTEGRATION_DIAGRAM_CAP`=20 surfaces) are now
 * reader-facing — a "showing the top N of M" / "showing the first N of M"
 * line renders inline under the affected diagram AND as a verbatim
 * `document.boundaries` entry whenever the cap actually truncated something
 * (present only then, so an under-cap org's document stays byte-identical).
 * The Integration Topology Type/Count TABLE is never capped — only its
 * diagram's node list is. NOT covered here (byte-drop/hop-cursor pagination
 * for a many-thousand-object org's overview) — stays open, out of scope for
 * this fix; see `fitDocumentToBudget` for the existing byte-budget behavior
 * this tool already has, which is unrelated to the per-diagram node caps.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { buildErDiagram, type ErdRelationship } from '@sf-intelligence/renderers';
import { z } from 'zod';

import { renderHtmlDocument } from '../html-document.js';
import type { Context } from '../server.js';

import { domainClustersHandler } from './domain-clusters.js';
import {
  ERD_SCOPE_DISCLOSURE,
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

/**
 * CR-22-B6: node caps on the two mermaid diagrams below — previously
 * JSDoc-only (a `.slice(0, N)` with no reader-facing disclosure). Named so
 * both the slice and the "showing first N of M" line stay in lockstep.
 */
const ORG_STRUCTURE_DIAGRAM_CAP = 5;
const INTEGRATION_DIAGRAM_CAP = 20;

/** Escape a markdown table cell. */
const escapeCell = (raw: string): string =>
  raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Sanitise an api name for use as a mermaid node id. */
const safeMermaidId = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * R6-19: top-N objects by Lookup/Master-Detail RELATIONSHIP DEGREE (distinct
 * from `topObjects`'s inbound-reference-count ranking used by the Org
 * Structure diagram above). Capped so a hub object's diagram cannot balloon
 * to hundreds of entities; disclosed honestly (never implied complete).
 */
const ARCHITECTURE_ERD_MAX_OBJECTS = 12;

interface LookupToEdgeRow {
  readonly from_id: string;
  readonly to_id: string;
  readonly properties_json: string;
}

/** Canonical id prefixes this module parses without a graph round-trip. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

/** Split a `CustomField:{Object}.{Field}` id; `null` for any other shape. */
const parseCustomFieldId = (id: string): { readonly object: string; readonly field: string } | null => {
  if (!id.startsWith(CUSTOM_FIELD_PREFIX)) return null;
  const rest = id.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  return { object: rest.slice(0, dot), field: rest.slice(dot + 1) };
};

/**
 * Read every `lookupTo` edge in ONE table scan (mirrors the whole-vault
 * edge reads `compare-vaults.ts` / `diff-snapshots.ts` already treat as an
 * acceptable cost) and derive both (a) the per-object relationship DEGREE
 * (in + out) used to rank the top-N objects, and (b) the flat
 * {@link ErdRelationship} list `buildErDiagram` renders. A `lookupTo`
 * `fromId` is always a CustomField id (`CustomField:{child}.{field}`); its
 * `toId` is always a CustomObject id (`CustomObject:{parent}`) — that shape
 * is guaranteed by the extractor (`custom-field.ts`), so no extra Node
 * lookups are needed to resolve either side.
 */
const computeObjectRelationshipDegree = async (
  ctx: Context,
): Promise<
  Result<
    { readonly degreeByObject: Map<string, number>; readonly relationships: readonly ErdRelationship[] },
    McpError
  >
> => {
  let rows: readonly LookupToEdgeRow[];
  try {
    const reader = await ctx.graph.connection.runAndReadAll(
      "SELECT from_id, to_id, properties_json FROM edges WHERE edge_type = 'lookupTo'",
    );
    rows = reader.getRowObjectsJS() as unknown as readonly LookupToEdgeRow[];
  } catch (cause) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  const degreeByObject = new Map<string, number>();
  const bump = (name: string): void => {
    degreeByObject.set(name, (degreeByObject.get(name) ?? 0) + 1);
  };

  const relationships: ErdRelationship[] = [];
  for (const row of rows) {
    const parsed = parseCustomFieldId(row.from_id);
    if (parsed === null || !row.to_id.startsWith(CUSTOM_OBJECT_PREFIX)) continue;
    const parentObjectApiName = row.to_id.slice(CUSTOM_OBJECT_PREFIX.length);
    let relationshipType: unknown;
    try {
      relationshipType = (JSON.parse(row.properties_json) as Record<string, unknown>)['relationshipType'];
    } catch {
      relationshipType = undefined;
    }
    relationships.push({
      childObjectApiName: parsed.object,
      childFieldApiName: parsed.field,
      parentObjectApiName,
      relationshipKind: relationshipType === 'MasterDetail' ? 'MasterDetail' : 'Lookup',
    });
    bump(parsed.object);
    bump(parentObjectApiName);
  }

  return ok({ degreeByObject, relationships });
};

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
  const topObjects = overview.topObjects.slice(0, ORG_STRUCTURE_DIAGRAM_CAP);
  // CR-22-B6: the diagram shows the top N by inbound references — disclose
  // against the TRUE org-wide CustomObject count (Executive Summary already
  // computed it), not just `overview.topObjects.length` (itself a separate,
  // upstream org_overview cap) — a reader cares "how many objects does this
  // org have, and I'm seeing the top N", not the intermediate cap.
  const totalCustomObjects = counts['CustomObject'] ?? 0;
  const orgStructureTruncated = totalCustomObjects > topObjects.length;
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
    ...(orgStructureTruncated
      ? [
          '',
          `_(showing the top ${topObjects.length.toString()} of ${totalCustomObjects.toString()} CustomObjects, ranked by inbound references — see \`sfi.org_overview\` for the fuller ranking or \`sfi.list_components\` for the complete inventory)_`,
        ]
      : []),
  ].join('\n');

  // R6-19: Entity Relationship Diagram — top objects by Lookup/Master-Detail
  // relationship DEGREE (in+out lookupTo edges), distinct from the Org
  // Structure diagram's inbound-reference ranking above. The rendered
  // relationships are the INDUCED subgraph on that object set — both ends
  // of a relationship line must be one of the top-N objects, or the object
  // cap would be defeated by pulling in every neighbour.
  const degreeResult = await computeObjectRelationshipDegree(ctx);
  if (!degreeResult.ok) return err(degreeResult.error);
  const { degreeByObject, relationships: allLookupRelationships } = degreeResult.value;
  const rankedObjects = [...degreeByObject.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const topErdObjects = new Set(rankedObjects.slice(0, ARCHITECTURE_ERD_MAX_OBJECTS).map(([name]) => name));
  const inducedRelationships = allLookupRelationships.filter(
    (r) => topErdObjects.has(r.childObjectApiName) && topErdObjects.has(r.parentObjectApiName),
  );
  const erd = buildErDiagram(inducedRelationships);
  const objectCapDisclosure =
    rankedObjects.length > ARCHITECTURE_ERD_MAX_OBJECTS
      ? `Showing the top ${ARCHITECTURE_ERD_MAX_OBJECTS.toString()} of ${rankedObjects.length.toString()} objects with at least one Lookup/Master-Detail relationship, ranked by relationship degree (inbound + outbound \`lookupTo\` edges). For any single object's complete relationship set, use \`sfi.generate_data_dictionary\`.`
      : undefined;
  const erdSection = [
    '## Entity Relationship Diagram',
    '',
    erd.mermaid,
    ...(objectCapDisclosure !== undefined ? ['', `> ${objectCapDisclosure}`] : []),
    ...(erd.disclosure !== undefined ? ['', `> ${erd.disclosure}`] : []),
  ].join('\n');

  // Domain Clustering diagram + per-domain section.
  //
  // Census 114 / R1: `domainClustersHandler` already discloses when its
  // candidate enumeration was CAPPED before clustering ran
  // (`domains.candidateTruncated` + `domains.trueCandidateCounts`) — the
  // clustering in that case ran on a partial candidate set, so "no clusters"
  // cannot honestly be narrated as a measured density-threshold finding. An
  // empty list under a capped enumeration gets an honest "capped, not
  // measured" line instead of asserting a specific cause the tool never
  // actually checked for the missing candidates.
  const domainsLines: string[] = ['## Domain Clustering', ''];
  if (domains.clusters.length === 0) {
    domainsLines.push(
      domains.candidateTruncated === true
        ? '_(no clusters surfaced — candidate enumeration was capped before clustering ran; this is NOT a measured density-threshold result — see Boundaries)_'
        : '_(no clusters surfaced — every candidate was below the density threshold)_',
    );
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
  // CR-22-B6: the diagram's NODE list (not the Type/Count table below, which
  // is already complete) is capped at INTEGRATION_DIAGRAM_CAP.
  const integrationDiagramTruncated = allIntegrationNodes.length > INTEGRATION_DIAGRAM_CAP;
  if (allIntegrationNodes.length === 0) {
    integrationLines.push('_(no integration surfaces extracted)_');
  } else {
    integrationLines.push('```mermaid');
    integrationLines.push('graph LR');
    for (const node of allIntegrationNodes.slice(0, INTEGRATION_DIAGRAM_CAP)) {
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
    if (integrationDiagramTruncated) {
      integrationLines.push('');
      integrationLines.push(
        `_(diagram shows the first ${Math.min(allIntegrationNodes.length, INTEGRATION_DIAGRAM_CAP).toString()} of ${allIntegrationNodes.length.toString()} integration surfaces — the Type/Count table below covers ALL of them; see \`sfi.integration_map\` for the full per-surface list)_`,
      );
    }
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
    erdSection,
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
    'Entity Relationship Diagram': 'declared',
    'Domain Clustering': 'heuristic',
    'Integration Topology': 'declared',
    'Automation Footprint': 'declared',
    'Codebase Footprint': 'declared',
  };

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
    ERD_SCOPE_DISCLOSURE,
    ...(objectCapDisclosure !== undefined ? [objectCapDisclosure] : []),
    ...(erd.disclosure !== undefined ? [erd.disclosure] : []),
    'Domain clusters and top-object rankings are heuristic — present as suggested starting points, not authoritative groupings.',
    'Scope: this overview is a STRUCTURED TOUR composed from org_overview, domain_clusters, and integration_map — a starting map, not a deep architectural analysis. It does not trace Apex call chains, data/field lineage, or the sharing model. For those, follow up with `sfi.call_graph`, `sfi.get_subgraph`, `sfi.field_lineage`, and `sfi.generate_sharing_summary` on the components this tour surfaces.',
  ];
  // CR-22-B6: the two mermaid diagrams' node caps were previously JSDoc-only.
  if (orgStructureTruncated) {
    boundaries.push(
      `Org Structure diagram capped: showing the top ${topObjects.length.toString()} of ${totalCustomObjects.toString()} CustomObjects (ranked by inbound references) — the rest are NOT pictured. See \`sfi.org_overview\` for the fuller ranking.`,
    );
  }
  if (integrationDiagramTruncated) {
    boundaries.push(
      `Integration Topology diagram capped: showing the first ${Math.min(allIntegrationNodes.length, INTEGRATION_DIAGRAM_CAP).toString()} of ${allIntegrationNodes.length.toString()} integration surfaces as diagram nodes — the Type/Count table covers ALL of them, but only the first ${INTEGRATION_DIAGRAM_CAP.toString()} are pictured. See \`sfi.integration_map\` for the full per-surface list.`,
    );
  }
  // Census 114 / R1: forward domain_clusters' own candidate-truncation
  // disclosure rather than discarding it — a capped candidate enumeration
  // means the clustering (empty OR non-empty) ran on a partial candidate set.
  if (domains.candidateTruncated === true) {
    const perType = Object.entries(domains.trueCandidateCounts ?? {})
      .map(([type, count]) => `${type}: ${(count ?? 0).toString()}`)
      .join(', ');
    boundaries.push(
      `Domain Clustering candidate enumeration capped: at least one of CustomObject / ApexClass / Flow exceeds the 500-per-type candidate limit (true counts — ${perType}) — clustering ran on a PARTIAL candidate set. See \`sfi.domain_clusters\` for the full disclosure.`,
    );
  }

  // Component ids: top objects + domain centres + integration nodes,
  // DEDUPLICATED in first-seen order. A component can be selected by more
  // than one source list — most commonly a top object (by inbound
  // references) that is ALSO a domain-cluster centre — and the frontmatter
  // id list is a provenance SET, not a multiset, so it must not repeat.
  const componentIds: ComponentId[] = [
    ...new Set<ComponentId>([
      ...overview.topObjects.map((o) => o.id),
      ...[...topErdObjects].map((name) => `CustomObject:${name}` as ComponentId),
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
