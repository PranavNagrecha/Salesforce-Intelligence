/**
 * Org-card renderer (P13-CARD-render) — the ≤16 KB orientation document an AI
 * consumer loads BEFORE its first question. Rendered at refresh time into
 * `docs/org-card.md` (+ the same data as `meta/org-card.json`), beside the P9
 * onboarding handbook.
 *
 * PURE renderer: the body is a deterministic function of {@link OrgCardInput}
 * alone — every number is pre-derived from the graph/manifest by the caller
 * (`buildOrgCardInput` in the CLI) and re-derivable from them; iteration order
 * is the input's order (callers sort). The wall-clock stamp appears in the
 * FRONTMATTER only, never the body, so two renders over the same graph are
 * byte-identical body-for-body.
 *
 * HARD CAP: {@link ORG_CARD_MAX_BYTES}. When a very large org overflows it,
 * rows are dropped in a FIXED priority order (extra top-objects first, then
 * naming observations, then per-type scale rows) and the trim is disclosed in
 * the body — deterministic input → deterministic trim → deterministic bytes.
 */

import type { ComponentId } from '@sf-intelligence/contracts';

/** Hard cap on the rendered markdown body + frontmatter (bytes). */
export const ORG_CARD_MAX_BYTES = 16_384;

export interface OrgCardTopObject {
  readonly id: ComponentId;
  /** Inbound dependency edges (excludes structural `parentOf`). */
  readonly inboundRefs: number;
}

export interface OrgCardAutomationRow {
  readonly type: string;
  readonly total: number;
  readonly active: number;
}

export interface OrgCardNamingObservation {
  readonly pattern: string;
  readonly matching: number;
  readonly total: number;
}

export interface OrgCardInput {
  /** Stamped into frontmatter ONLY (and the JSON twin) — never the body. */
  readonly generatedAt: string;
  readonly sourceTreeHash: string;
  readonly refreshedAt: string;
  readonly targetOrg: string;
  /** Per-type component counts (caller sorts: count desc, type asc). */
  readonly componentCounts: ReadonlyArray<readonly [string, number]>;
  readonly totalComponents: number;
  readonly totalEdges: number;
  readonly coverage: {
    readonly status: string;
    readonly coveredTypeCount: number;
    readonly partialTypes: readonly string[];
    readonly notModeledTypes: readonly string[];
    readonly erroredTypes: readonly string[];
  };
  /** Caller sorts: inboundRefs desc, id asc; pre-capped to ~20. */
  readonly topObjects: readonly OrgCardTopObject[];
  /** How many objects the centrality scan covered (disclosure). */
  readonly objectScanCount: number;
  readonly automation: readonly OrgCardAutomationRow[];
  readonly permissions: {
    readonly profileCount: number;
    readonly permissionSetCount: number;
    /** Containers holding ViewAllData/ModifyAllData (capped scan). */
    readonly godModeContainers: number;
    readonly godModeScanCount: number;
  };
  /** Caller sorts: count desc, label asc. Zero-count rows pre-filtered. */
  readonly integrations: ReadonlyArray<readonly [string, number]>;
  readonly naming: readonly OrgCardNamingObservation[];
  /**
   * Captured record-data shape (P13-FACTS-consumers), when the vault holds
   * facts: approximate counts for the top objects + the capture stamp.
   * Graph-derived state (same vault → same values), so it may appear in the
   * deterministic body — unlike the render-time stamp.
   */
  readonly dataShape?: {
    readonly capturedAt: string;
    readonly counts: ReadonlyArray<readonly [string, number]>;
  };
}

const fmtRow = (cells: readonly (string | number)[]): string =>
  `| ${cells.join(' | ')} |`;

interface Sections {
  topObjects: OrgCardTopObject[];
  naming: OrgCardNamingObservation[];
  componentCounts: (readonly [string, number])[];
  trimmed: boolean;
}

const renderBody = (input: OrgCardInput, s: Sections): string => {
  const lines: string[] = [];
  lines.push(`# Org card — ${input.targetOrg}`);
  lines.push('');
  lines.push(
    `Offline snapshot of one Salesforce org. Source-tree hash \`${input.sourceTreeHash}\`; ` +
      `vault refreshed ${input.refreshedAt}. Answers ground in THIS snapshot — ` +
      'verify freshness with `sfi.health_check` before trusting time-sensitive claims.',
  );
  lines.push('');

  // Coverage & blind spots UP FRONT — what the vault can NOT answer comes
  // before what it can.
  lines.push('## Coverage & blind spots');
  lines.push('');
  lines.push(
    `Coverage status: **${input.coverage.status}** — ${input.coverage.coveredTypeCount} metadata families retrieved.`,
  );
  if (input.coverage.partialTypes.length > 0) {
    lines.push(`- Partial (retrieved with errors/limits): ${input.coverage.partialTypes.join(', ')}`);
  }
  if (input.coverage.erroredTypes.length > 0) {
    lines.push(`- Errored at retrieve: ${input.coverage.erroredTypes.join(', ')}`);
  }
  if (input.coverage.notModeledTypes.length > 0) {
    lines.push(
      `- NOT modeled (${input.coverage.notModeledTypes.length} families — absence of these is NEVER evidence): ` +
        `${input.coverage.notModeledTypes.slice(0, 12).join(', ')}` +
        (input.coverage.notModeledTypes.length > 12 ? ', …' : ''),
    );
  }
  lines.push('');

  lines.push('## Scale');
  lines.push('');
  lines.push(`${input.totalComponents} components, ${input.totalEdges} dependency edges.`);
  lines.push('');
  lines.push(fmtRow(['Type', 'Count']));
  lines.push(fmtRow(['---', '---']));
  for (const [type, count] of s.componentCounts) lines.push(fmtRow([type, count]));
  lines.push('');

  lines.push('## Where the org\'s gravity is (top objects by inbound dependencies)');
  lines.push('');
  lines.push(
    `Inbound dependency edges per object (structural containment excluded), over ${input.objectScanCount} scanned objects:`,
  );
  lines.push('');
  lines.push(fmtRow(['Object', 'Inbound refs']));
  lines.push(fmtRow(['---', '---']));
  for (const o of s.topObjects) lines.push(fmtRow([`\`${o.id}\``, o.inboundRefs]));
  lines.push('');

  lines.push('## Automation density');
  lines.push('');
  lines.push(fmtRow(['Automation', 'Total', 'Active']));
  lines.push(fmtRow(['---', '---', '---']));
  for (const a of input.automation) lines.push(fmtRow([a.type, a.total, a.active]));
  lines.push('');

  lines.push('## Permissions posture');
  lines.push('');
  lines.push(
    `${input.permissions.profileCount} profiles, ${input.permissions.permissionSetCount} permission sets. ` +
      `${input.permissions.godModeContainers} of ${input.permissions.godModeScanCount} scanned containers hold ` +
      'View All Data / Modify All Data (god-mode — see `sfi.permission_risk_report`).',
  );
  lines.push('');

  lines.push('## Integration surface');
  lines.push('');
  if (input.integrations.length === 0) {
    lines.push('No integration components retrieved (auth providers, named credentials, external services…).');
  } else {
    lines.push(input.integrations.map(([label, count]) => `${label}: ${count}`).join(' · '));
  }
  lines.push('');

  if (s.naming.length > 0) {
    lines.push('## Naming conventions (observed, heuristic)');
    lines.push('');
    for (const n of s.naming) {
      lines.push(`- ${n.pattern} (${n.matching}/${n.total} fields)`);
    }
    lines.push('');
  }

  lines.push('## Data-shape facts');
  lines.push('');
  if (input.dataShape === undefined) {
    lines.push('Not captured — run `sfi refresh --with-data-shape` (opt-in live plane) to capture approximate counts and fill rates.');
  } else {
    lines.push(
      `Approximate record counts (storage-level, captured ${input.dataShape.capturedAt} — a data snapshot, not a live read):`,
    );
    lines.push('');
    lines.push(
      input.dataShape.counts.map(([name, count]) => `\`${name}\`: ${count}`).join(' · '),
    );
  }
  lines.push('');

  if (s.trimmed) {
    lines.push('_Some rows were trimmed to keep this card under its size cap; the graph holds the full lists._');
    lines.push('');
  }

  lines.push('## How to ask');
  lines.push('');
  lines.push('1. Vague question → `sfi.route_question` first; it names the right tool(s).');
  lines.push('2. Informal component name → `sfi.resolve` first; never guess a canonical id.');
  lines.push('3. Cite canonical ids (`CustomObject:Account`, `CustomField:Account.Industry`).');
  lines.push('4. Check `sfi.coverage_report` before any absence-based claim (not modeled ≠ none).');
  lines.push('5. Record-level data (counts, samples) needs the opt-in live plane — vault answers are metadata-only.');

  return lines.join('\n');
};

export interface OrgCardRendered {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Markdown body (deterministic for a given input). */
  readonly body: string;
  /** The machine twin written to meta/org-card.json. */
  readonly json: Readonly<Record<string, unknown>>;
  /** True when rows were dropped to fit the cap. */
  readonly trimmed: boolean;
}

/**
 * Render the card. Deterministic: same input → same bytes. Enforces
 * {@link ORG_CARD_MAX_BYTES} by trimming rows in a fixed priority order.
 */
export const renderOrgCard = (input: OrgCardInput): OrgCardRendered => {
  const frontmatter = {
    generatedAt: input.generatedAt,
    sourceTreeHash: input.sourceTreeHash,
    refreshedAt: input.refreshedAt,
    kind: 'org-card',
  } as const;
  // Frontmatter is tiny and fixed-shape; budget the body against the cap
  // minus a fixed allowance for it so the WHOLE artifact respects the cap.
  const FRONTMATTER_ALLOWANCE = 512;
  const bodyBudget = ORG_CARD_MAX_BYTES - FRONTMATTER_ALLOWANCE;

  const sections: Sections = {
    topObjects: [...input.topObjects],
    naming: [...input.naming],
    componentCounts: [...input.componentCounts],
    trimmed: false,
  };
  let body = renderBody(input, sections);
  // Fixed trim order: top-objects beyond 10 → naming beyond 3 → component
  // rows beyond 10 → top-objects beyond 5. Each pass re-renders; the loop is
  // bounded and deterministic.
  const trims: ReadonlyArray<() => boolean> = [
    () => sections.topObjects.length > 10 && (sections.topObjects = sections.topObjects.slice(0, 10), true),
    () => sections.naming.length > 3 && (sections.naming = sections.naming.slice(0, 3), true),
    () => sections.componentCounts.length > 10 && (sections.componentCounts = sections.componentCounts.slice(0, 10), true),
    () => sections.topObjects.length > 5 && (sections.topObjects = sections.topObjects.slice(0, 5), true),
  ];
  for (const trim of trims) {
    if (Buffer.byteLength(body, 'utf8') <= bodyBudget) break;
    if (trim()) {
      sections.trimmed = true;
      body = renderBody(input, sections);
    }
  }

  const json = {
    ...frontmatter,
    targetOrg: input.targetOrg,
    totals: { components: input.totalComponents, edges: input.totalEdges },
    componentCounts: Object.fromEntries(input.componentCounts),
    coverage: input.coverage,
    topObjects: input.topObjects,
    objectScanCount: input.objectScanCount,
    automation: input.automation,
    permissions: input.permissions,
    integrations: Object.fromEntries(input.integrations),
    naming: input.naming,
  };
  return { frontmatter, body, json, trimmed: sections.trimmed };
};
