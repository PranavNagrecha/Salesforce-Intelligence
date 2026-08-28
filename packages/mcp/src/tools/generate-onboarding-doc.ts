/**
 * Handler for the `sfi.generate_onboarding_doc` MCP tool.
 *
 * The v2.5 documentation-generation tier onboarding-doc tool. The
 * most composite generator in v2.5 — chains:
 *
 *   - `sfi.generate_admin_handbook` (for org-level context) — the
 *     persona drives section emphasis.
 *   - `sfi.generate_architecture_overview` (for the architecture map).
 *   - `sfi.org_overview` (to identify the top 3 objects worth a
 *     spotlighted data-dictionary entry).
 *   - `sfi.get_naming_convention_report` (for the conventions section).
 *   - A simple custom-field-label glossary builder (heuristic on labels
 *     appearing in fewer than `GLOSSARY_LABEL_MAX_OBJECT_COUNT` objects).
 *
 * Input:
 *   - `personaFocus` (optional `'admin' | 'developer'`, default
 *     `'admin'`): drives section emphasis and what tooling hints get
 *     surfaced in "Where To Go Next".
 *
 * Output: `{ document: GeneratedDocument }`.
 *
 * Honesty axis: the glossary is HEURISTIC — a label that appears on
 * one CustomObject MAY be org-specific terminology OR may simply be
 * an underused standard label. Key Contacts depends on v1.7
 * enrichment and surfaces a disclosure when absent — but ONLY when the
 * scan actually succeeded and found nothing; a graph failure is
 * propagated as an `internal` error rather than rendered as a missing
 * enrichment with a remedy that would change nothing.
 *
 * Both corpus reads go through the shared `scanAllNodesOfTypes`, which
 * windows the SQL `OFFSET` forward. A single capped page ranked the top
 * modifiers of an ALPHABETICAL first 500 rows and presented them to a new
 * hire as the org's key people, with no truncation note.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../server.js';

import { generateAdminHandbookHandler } from './generate-admin-handbook.js';
import { generateArchitectureOverviewHandler } from './generate-architecture-overview.js';
import {
  INHERITED_CONFIDENCE_DISCLOSURE,
  Q125_FRESHNESS_DISCLOSURE,
  STRUCTURAL_DISCLOSURE,
  fitDocumentToBudget,
  generatedDocByteBudget,
  renderFooter,
  type GeneratedDocument,
} from './generate-data-dictionary.js';
import { orgOverviewHandler } from './org-overview.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/**
 * Cap on the number of CustomObjects a label may appear on before it
 * fails the "org-specific terminology" heuristic. A label on more than
 * this many objects is treated as standard / generic.
 */
const GLOSSARY_LABEL_MAX_OBJECT_COUNT = 5;

/**
 * Cap on the glossary size. The heuristic surfaces top-N labels in
 * order of "fewer objects = more org-specific" (and then api name ASC).
 */
const GLOSSARY_TOP_N = 30;

/** Zod schema for the `sfi.generate_onboarding_doc` tool input. */
export const generateOnboardingDocInputSchema = z.object({
  personaFocus: z.enum(['admin', 'developer']).optional(),
});

/** Parsed input shape. */
export type GenerateOnboardingDocInput = z.infer<
  typeof generateOnboardingDocInputSchema
>;

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface GenerateOnboardingDocOutput {
  readonly document: GeneratedDocument;
}

/** Escape a markdown table cell. */
const escapeCell = (raw: string): string =>
  raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * One glossary entry — a CustomField label that appears in fewer than
 * `GLOSSARY_LABEL_MAX_OBJECT_COUNT` objects.
 */
interface GlossaryEntry {
  readonly label: string;
  readonly apiName: string;
  readonly objectCount: number;
}

/**
 * Build the glossary from the CustomField population. Index labels by
 * the count of distinct parent objects they appear on. Surface labels
 * with `< GLOSSARY_LABEL_MAX_OBJECT_COUNT` parents as the heuristic
 * org-specific terms.
 */
const buildGlossary = (fields: readonly Node[]): readonly GlossaryEntry[] => {
  type Tally = { readonly label: string; readonly apiName: string; readonly objects: Set<string> };
  const labelMap = new Map<string, Tally>();
  for (const field of fields) {
    const label = field.label ?? field.apiName;
    if (label.length === 0) continue;
    const objectApiName =
      field.parentId === null ? '' : field.parentId.replace(/^[^:]+:/, '');
    const existing = labelMap.get(label);
    if (existing === undefined) {
      const tally: Tally = {
        label,
        apiName: field.apiName,
        objects: new Set(objectApiName === '' ? [] : [objectApiName]),
      };
      labelMap.set(label, tally);
    } else {
      if (objectApiName !== '') existing.objects.add(objectApiName);
    }
  }
  const entries: GlossaryEntry[] = [];
  for (const tally of labelMap.values()) {
    const objectCount = tally.objects.size;
    if (objectCount === 0) continue;
    if (objectCount >= GLOSSARY_LABEL_MAX_OBJECT_COUNT) continue;
    entries.push({
      label: tally.label,
      apiName: tally.apiName,
      objectCount,
    });
  }
  entries.sort((a, b) => {
    if (a.objectCount !== b.objectCount) return a.objectCount - b.objectCount;
    return a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0;
  });
  return entries.slice(0, GLOSSARY_TOP_N);
};

/** Render the glossary H2 from the heuristic entries. */
const renderGlossarySection = (
  glossary: readonly GlossaryEntry[],
): string => {
  if (glossary.length === 0) {
    return [
      '## Glossary',
      '',
      '_(no org-specific terminology surfaced — glossary heuristic found no labels appearing in fewer than the threshold objects)_',
    ].join('\n');
  }
  const lines = [
    '## Glossary',
    '',
    '| Term | Source field | Objects |',
    '| --- | --- | --- |',
  ];
  for (const entry of glossary) {
    lines.push(
      `| ${escapeCell(entry.label)} | \`${escapeCell(entry.apiName)}\` | ${entry.objectCount.toString()} |`,
    );
  }
  return lines.join('\n');
};

/**
 * Render the Key Contacts section. v1.7 enrichment is required;
 * surfaces a verbatim disclosure when no enrichment data is present.
 */
const renderKeyContactsSection = (
  topModifiers: readonly { name: string; count: number }[],
): string => {
  if (topModifiers.length === 0) {
    return [
      '## Key Contacts',
      '',
      'Key Contacts data depends on v1.7 enrichment. Run `sfi refresh --with-tooling-api` to populate `lastModifiedBy` for the enriched types.',
    ].join('\n');
  }
  const lines = [
    '## Key Contacts',
    '',
    '| Contact | Modifications |',
    '| --- | --- |',
  ];
  for (const entry of topModifiers) {
    lines.push(`| ${escapeCell(entry.name)} | ${entry.count.toString()} |`);
  }
  return lines.join('\n');
};

/**
 * Render the Where To Go Next H2 with persona-specific tool hints.
 */
const renderWhereToGoNextSection = (persona: 'admin' | 'developer'): string => {
  const items =
    persona === 'admin'
      ? [
          'Run `sfi.org_overview` for a structured tour of the org.',
          'Run `sfi.unused_components` to find dead-weight components ripe for cleanup.',
          'Run `sfi.field_access_audit` on a specific field to investigate who can see it.',
          'Run `sfi.why_cant_user_see_record` when a user reports a missing record.',
        ]
      : [
          'Run `sfi.find_code_usages` to trace how a class is invoked.',
          'Run `sfi.explain_apex_method` for a structured narrative of a class.',
          'Run `sfi.tech_debt_score` for a weighted summary of code-tier debt.',
          'Run `sfi.test_coverage_gaps` to surface ApexClass nodes without sufficient test coverage.',
        ];
  return ['## Where To Go Next', '', ...items.map((t) => `- ${t}`)].join('\n');
};

/**
 * The `sfi.generate_onboarding_doc` MCP tool. Chains the admin handbook,
 * architecture overview, naming convention report, and glossary into a
 * structured markdown document tuned for a new admin or developer.
 */
export const generateOnboardingDocHandler = async (
  ctx: Context,
  input: GenerateOnboardingDocInput,
): Promise<Result<McpResponse<GenerateOnboardingDocOutput>, McpError>> => {
  const persona = input.personaFocus ?? 'admin';

  // Step 1: chain the admin handbook for the org-level context.
  const handbookResult = await generateAdminHandbookHandler(ctx, {
    personaFocus: persona,
  });
  if (!handbookResult.ok) return err(handbookResult.error);

  // Step 2: chain the architecture overview for the system map.
  const archResult = await generateArchitectureOverviewHandler(ctx, {});
  if (!archResult.ok) return err(archResult.error);

  // Step 3: chain the org overview for the top objects to spotlight.
  const overviewResult = await orgOverviewHandler(ctx, {});
  if (!overviewResult.ok) return err(overviewResult.error);
  const overview = overviewResult.value.data;
  const topObjects = overview.topObjects.slice(0, 3);

  // Step 4: build the glossary from the ENTIRE CustomField population.
  // buildGlossary tallies each label's distinct parent-object count, so a
  // single capped page would undercount those tallies — wrongly including
  // common labels whose count is truncated below the threshold and omitting
  // org-specific terms whose fields sort past page 1. The shared scan windows
  // the SQL OFFSET forward at `clampedNodeScanLimit()` (derived, not a local
  // literal asserting parity with the graph layer in a comment).
  const fieldScan = await scanAllNodesOfTypes(ctx.graph, ['CustomField']);
  if (!fieldScan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${fieldScan.error.message}`,
    });
  }
  const fields: readonly Node[] = fieldScan.value.nodes;
  const glossary = buildGlossary(fields);

  // Step 5: build Key Contacts from the lastModifiedBy axis over the FULL code
  // corpus. A single capped page named the top modifiers of an ALPHABETICAL
  // first page as the org's key people. A graph FAILURE is propagated, never
  // folded into an empty tally: an empty tally renders the v1.7 enrichment
  // remedy, and prescribing `sfi refresh --with-tooling-api` for a query error
  // would change nothing.
  const codeScan = await scanAllNodesOfTypes(ctx.graph, [
    'ApexClass',
    'ApexTrigger',
    'Flow',
  ]);
  if (!codeScan.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${codeScan.error.message}`,
    });
  }
  const codeNodes: readonly Node[] = codeScan.value.nodes;

  const modifierTally = new Map<string, number>();
  for (const node of codeNodes) {
    if (node.lastModifiedBy === null) continue;
    modifierTally.set(
      node.lastModifiedBy,
      (modifierTally.get(node.lastModifiedBy) ?? 0) + 1,
    );
  }
  const topModifiers = [...modifierTally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.name < b.name ? -1 : 1;
    })
    .slice(0, 10);

  // Compose body.
  const sourceTreeHash = ctx.manifest.sourceTreeHash;
  const refreshedAt = ctx.manifest.refreshedAt;
  const generatedAt = new Date().toISOString();

  const title = `Welcome to ${ctx.manifest.sourceOrg}`;

  const whatThisOrgDoes = [
    '## What This Org Does',
    '',
    `This is a structured tour of \`${escapeCell(ctx.manifest.sourceOrg)}\` for a new ${persona}.`,
    `Total CustomObjects: ${(overview.componentCounts['CustomObject'] ?? 0).toString()}  `,
    `Total ApexClasses: ${(overview.componentCounts['ApexClass'] ?? 0).toString()}  `,
    `Total Flows: ${(overview.componentCounts['Flow'] ?? 0).toString()}`,
  ].join('\n');

  const dataModelLines: string[] = ['## Main Data Model', ''];
  if (topObjects.length === 0) {
    dataModelLines.push('_(no objects to spotlight)_');
  } else {
    dataModelLines.push('| Object | Inbound references |');
    dataModelLines.push('| --- | --- |');
    for (const obj of topObjects) {
      dataModelLines.push(
        `| \`${escapeCell(obj.id)}\` | ${obj.inboundReferences.toString()} |`,
      );
    }
  }

  const commonWorkflowsSection = [
    '## Common Workflows',
    '',
    `Automations extracted: ${overview.automationSummary.workflowRules.toString()} workflow rules, ${overview.automationSummary.flows.toString()} flows, ${overview.automationSummary.apexTriggers.toString()} apex triggers.`,
    `Active ratio: ${overview.automationSummary.activeRatio.toFixed(2)}`,
  ].join('\n');

  const howSecurityWorksSection = [
    '## How Security Works',
    '',
    `Profiles: ${(overview.componentCounts['Profile'] ?? 0).toString()}  `,
    `PermissionSets: ${(overview.componentCounts['PermissionSet'] ?? 0).toString()}  `,
    `Top profile (by grants): ${overview.topProfiles[0]?.apiName ?? '_n/a_'}`,
  ].join('\n');

  const namingConventions = overview.namingConventionObservations;
  const conventionsLines: string[] = ['## Naming Conventions', ''];
  if (namingConventions.length === 0) {
    conventionsLines.push('_(no naming conventions surfaced)_');
  } else {
    for (const obs of namingConventions.slice(0, 5)) {
      conventionsLines.push(`- ${escapeCell(obs.statement)}`);
    }
  }

  const body = [
    `# ${title}`,
    '',
    whatThisOrgDoes,
    '',
    dataModelLines.join('\n'),
    '',
    commonWorkflowsSection,
    '',
    howSecurityWorksSection,
    '',
    conventionsLines.join('\n'),
    '',
    renderGlossarySection(glossary),
    '',
    renderKeyContactsSection(topModifiers),
    '',
    renderWhereToGoNextSection(persona),
    '',
    renderFooter(
      refreshedAt,
      `Re-run \`sfi.generate_onboarding_doc({ personaFocus: '${persona}' })\` after the next \`sfi refresh\`.`,
    ),
  ].join('\n');

  const sectionConfidence: Record<string, ConfidenceLevel> = {
    'What This Org Does': 'declared',
    'Main Data Model': 'declared',
    'Common Workflows': 'declared',
    'How Security Works': 'declared',
    'Naming Conventions': 'heuristic',
    Glossary: 'heuristic',
    'Key Contacts': 'declared',
    'Where To Go Next': 'declared',
  };

  const boundaries: string[] = [
    Q125_FRESHNESS_DISCLOSURE.replace('{TIMESTAMP}', refreshedAt),
    INHERITED_CONFIDENCE_DISCLOSURE,
    STRUCTURAL_DISCLOSURE,
    'Glossary entries are heuristic — a label on fewer than the threshold objects MAY be org-specific terminology or may simply be an underused standard label.',
    'Key Contacts depends on v1.7 enrichment; without it the section surfaces an enrichment disclosure rather than a fabricated list.',
  ];

  // Residual-cap honesty: the full scans stop at FULL_SCAN_MAX_NODES only for a
  // pathological type. When that happens the glossary tallies and the Key
  // Contacts ranking are drawn from a PREFIX of the type, so say so rather than
  // present a partial scan as the whole org. The wording is the shared
  // `fullScanTruncationNote` (not a local copy), so it quotes the ceiling that
  // actually bit and does not prescribe the dead-end SFI_NODE_SCAN_LIMIT knob.
  const incompleteTypes = [
    ...new Set([
      ...fieldScan.value.incompleteTypes,
      ...codeScan.value.incompleteTypes,
    ]),
  ];
  if (incompleteTypes.length > 0) {
    boundaries.push(fullScanTruncationNote(incompleteTypes));
  }

  // Compose the chained component ids — handbook + architecture +
  // top objects + glossary source fields. Deduplicated (first-seen order):
  // the same objects appear in the handbook's id list, the architecture
  // overview's id list, AND the top objects — the frontmatter id list is a
  // provenance SET, not a multiset.
  const componentIds: ComponentId[] = [
    ...new Set<ComponentId>([
      ...handbookResult.value.data.document.frontmatter.componentIds,
      ...archResult.value.data.document.frontmatter.componentIds,
      ...topObjects.map((o) => o.id),
    ]),
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
