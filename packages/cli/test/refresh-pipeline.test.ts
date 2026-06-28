/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import {
  foldReportDashboardUsageIntoFields,
  renderVault,
  walkAndExtract,
} from '../src/refresh-pipeline.js';

const makeTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-refresh-pipeline-'));

/** Helper to drop a file under `sourceRoot/<relPath>`, creating parents. */
const writeAt = async (sourceRoot: string, relPath: string, content: string): Promise<void> => {
  const abs = join(sourceRoot, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content, 'utf8');
};

/** A minimal valid CustomObject XML body (matches the refresh.test.ts fixture). */
const objectXml = (label: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>${label}</label>
    <nameField>
        <label>Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>${label}s</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
`;

describe('foldReportDashboardUsageIntoFields', () => {
  const mkNode = (id: string, type: Node['type']): Node => ({
    id,
    type,
    apiName: id.slice(id.indexOf(':') + 1),
    label: null,
    parentId: null,
    sourcePath: 'x',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  });
  const mkRef = (fromId: string, toId: string): Edge => ({
    fromId,
    toId,
    edgeType: 'references',
    confidence: 'heuristic',
    source: 'test',
    properties: {},
  });

  it('folds report/dashboard usage onto the field and drops the report/dashboard nodes', () => {
    const results: readonly ExtractionResult[] = [
      {
        nodes: [
          mkNode('CustomField:Account.Region__c', 'CustomField'),
          mkNode('CustomField:Account.NeverUsed__c', 'CustomField'),
        ],
        edges: [],
      },
      {
        nodes: [mkNode('Report:Sales/Pipeline', 'Report')],
        edges: [mkRef('Report:Sales/Pipeline', 'CustomField:Account.Region__c')],
      },
      {
        nodes: [mkNode('Dashboard:Exec/KPIs', 'Dashboard')],
        edges: [mkRef('Dashboard:Exec/KPIs', 'CustomField:Account.Region__c')],
      },
    ];

    const out = foldReportDashboardUsageIntoFields(results);
    const nodes = out.flatMap((r) => r.nodes);
    const edges = out.flatMap((r) => r.edges);

    // Report / Dashboard nodes + their edges are gone — no per-report node bloat.
    expect(nodes.some((n) => n.type === 'Report' || n.type === 'Dashboard')).toBe(false);
    expect(edges).toHaveLength(0);
    // The referenced field carries the usage signal.
    const region = nodes.find((n) => n.id === 'CustomField:Account.Region__c');
    expect(region?.properties['usedInReport']).toBe(true);
    expect(region?.properties['usedInDashboard']).toBe(true);
    // An un-referenced field is untouched.
    const never = nodes.find((n) => n.id === 'CustomField:Account.NeverUsed__c');
    expect(never?.properties['usedInReport']).toBeUndefined();
  });

  it('is an identity no-op when no report/dashboard nodes are present', () => {
    const results: readonly ExtractionResult[] = [
      { nodes: [mkNode('CustomField:A.B__c', 'CustomField')], edges: [] },
    ];
    expect(foldReportDashboardUsageIntoFields(results)).toBe(results);
  });
});

describe('walkAndExtract skip-counter (architectural-bug-fix observability)', () => {
  it('returns an empty skippedDirectories map when every file matches a dispatch', async () => {
    const root = await makeTempRoot();
    try {
      // Only known DX directories (objects/) — nothing should skip.
      await writeAt(root, 'objects/Alpha__c/Alpha__c.object-meta.xml', objectXml('Alpha'));
      await writeAt(root, 'objects/Beta__c/Beta__c.object-meta.xml', objectXml('Beta'));

      const walked = await walkAndExtract(root, null);
      expect(walked.skippedDirectories).toEqual({});
      expect(walked.results.length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts top-level RestrictionRule / ScopingRule (.rule-meta.xml), never skips them', async () => {
    const root = await makeTempRoot();
    try {
      // RestrictionRule / ScopingRule are top-level `{type}Rules/{Name}.rule-meta.xml`,
      // NOT nested under objects/. Regression guard: a wrong suffix OR a detector
      // branch stuck in the objects block would skip these — both were real bugs
      // found via a grounded real-org refresh (CI passed the broken intermediate fix).
      await writeAt(
        root,
        'restrictionRules/Limit_X.rule-meta.xml',
        '<?xml version="1.0"?><RestrictionRule xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active></RestrictionRule>',
      );
      await writeAt(
        root,
        'scopingRules/Scope_Y.rule-meta.xml',
        '<?xml version="1.0"?><ScopingRule xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active></ScopingRule>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('RestrictionRule:Limit_X');
      expect(ids).toContain('ScopingRule:Scope_Y');
      expect(walked.skippedDirectories.restrictionRules).toBeUndefined();
      expect(walked.skippedDirectories.scopingRules).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches a top-level CustomPermission definition file to a node (CR-CAP-15)', async () => {
    const root = await makeTempRoot();
    try {
      // customPermissions/{Name}.customPermission-meta.xml is a flat top-level
      // dispatch. Fail-before: no dispatch branch -> file is walked but never
      // routed, so no CustomPermission node is emitted and it inflates the
      // skip count. Pass-after: a CustomPermission:SkipValidation node exists.
      await writeAt(
        root,
        'customPermissions/SkipValidation.customPermission-meta.xml',
        '<?xml version="1.0"?><CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata"><label>Skip Validation</label></CustomPermission>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('CustomPermission:SkipValidation');
      expect(walked.skippedDirectories.customPermissions).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not count static-resource content files as an uncovered-type skip', async () => {
    const root = await makeTempRoot();
    try {
      // Resource CONTENT (the binary + the unzipped bundle) sits under
      // staticresources/ next to the dispatched `.resource-meta.xml`. It is
      // covered by the StaticResource node, NOT a separate metadata type, so it
      // must not inflate the skip count (the warning is for REAL coverage gaps).
      await writeAt(root, 'staticresources/MyApp.resource', 'console.log(1);');
      await writeAt(root, 'staticresources/MyBundle/app.js', 'console.log(2);');

      const walked = await walkAndExtract(root, null);
      expect(walked.skippedDirectories.staticresources).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts unknown top-level directories by their basename', async () => {
    const root = await makeTempRoot();
    try {
      // Three unknown-type files under `omniProcesses/`, two under
      // `omniDataTransforms/`, one under a `weirdType/`. Nothing
      // matches the dispatch matrix.
      await writeAt(root, 'omniProcesses/OneProc.xml', '<?xml version="1.0"?><foo/>');
      await writeAt(root, 'omniProcesses/TwoProc.xml', '<?xml version="1.0"?><foo/>');
      await writeAt(root, 'omniProcesses/ThreeProc.xml', '<?xml version="1.0"?><foo/>');
      await writeAt(root, 'omniDataTransforms/OneDT.xml', '<?xml version="1.0"?><foo/>');
      await writeAt(root, 'omniDataTransforms/TwoDT.xml', '<?xml version="1.0"?><foo/>');
      await writeAt(root, 'weirdType/Lone.xml', '<?xml version="1.0"?><foo/>');

      const walked = await walkAndExtract(root, null);
      expect(walked.results).toEqual([]);
      expect(walked.skippedDirectories).toEqual({
        omniProcesses: 3,
        omniDataTransforms: 2,
        weirdType: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mixes known and unknown directories cleanly', async () => {
    const root = await makeTempRoot();
    try {
      // Known type: should extract.
      await writeAt(root, 'objects/Acme__c/Acme__c.object-meta.xml', objectXml('Acme'));
      // Unknown type: should be skipped + counted.
      await writeAt(root, 'omniProcesses/A.xml', '<?xml version="1.0"?><foo/>');
      await writeAt(root, 'omniProcesses/B.xml', '<?xml version="1.0"?><foo/>');

      const walked = await walkAndExtract(root, null);
      expect(walked.results.length).toBe(1);
      expect(walked.skippedDirectories).toEqual({ omniProcesses: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('looks past Salesforce DX wrapper segments (main/default) when attributing', async () => {
    const root = await makeTempRoot();
    try {
      // `sf project retrieve` lays out files under
      // `source/main/default/{actual-type-dir}/`. The attribution
      // key must point at `omniProcesses`, not the wrappers.
      await writeAt(root, 'main/default/omniProcesses/A.xml', '<?xml version="1.0"?><foo/>');
      await writeAt(root, 'main/default/omniProcesses/B.xml', '<?xml version="1.0"?><foo/>');

      const walked = await walkAndExtract(root, null);
      expect(walked.skippedDirectories).toEqual({ omniProcesses: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('attributes files at the source root with the "(root)" key', async () => {
    const root = await makeTempRoot();
    try {
      // A stray top-level file (e.g. an admin's leftover README).
      await writeAt(root, 'stray.txt', 'unrelated');

      const walked = await walkAndExtract(root, null);
      expect(walked.skippedDirectories).toEqual({ '(root)': 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('attributes object-nested unknowns to the inner directory type, not "objects"', async () => {
    const root = await makeTempRoot();
    try {
      // Known: CustomObject dispatch. compactLayouts/webLinks/fieldSets/indexes
      // are dispatched since v4.x (given valid content below they extract, so
      // they are NOT skipped); `actionOverrides/` remains an unrouted child.
      // Without inner-type attribution, the unrouted ones would land in `objects`.
      await writeAt(root, 'objects/Acme__c/Acme__c.object-meta.xml', objectXml('Acme'));
      await writeAt(
        root,
        'objects/Acme__c/compactLayouts/Main.compactLayout-meta.xml',
        '<?xml version="1.0"?><CompactLayout><fullName>Main</fullName><label>Main</label></CompactLayout>',
      );
      await writeAt(root, 'objects/Acme__c/actionOverrides/Edit.override-meta.xml', '<x/>');
      await writeAt(root, 'objects/Acme__c/actionOverrides/View.override-meta.xml', '<x/>');

      const walked = await walkAndExtract(root, null);
      // compactLayouts is dispatched + extracted, so only the genuinely-unrouted
      // actionOverrides directory is attributed as skipped.
      expect(walked.skippedDirectories).toEqual({ actionOverrides: 2 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not count known sidecar files (.cls-meta.xml et al.) as skipped', async () => {
    const root = await makeTempRoot();
    try {
      // ApexClass: the dispatcher routes the `.cls` body, the
      // `.cls-meta.xml` companion is read directly by the extractor
      // (not by the dispatcher). Without sidecar suppression, every
      // `.cls-meta.xml` would inflate the `classes` bucket with
      // cosmetic noise that hides real coverage gaps.
      await writeAt(
        root,
        'classes/Foo.cls',
        `public class Foo { public static void hi() {} }`,
      );
      await writeAt(
        root,
        'classes/Foo.cls-meta.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
      );

      const walked = await walkAndExtract(root, null);
      expect(walked.results.length).toBe(1);
      expect(walked.skippedDirectories).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles many skipped files in a single directory (large-count smoke)', async () => {
    const root = await makeTempRoot();
    try {
      // Sanity-check that the counter accumulates correctly at scale.
      const COUNT = 100;
      const writes = [];
      for (let i = 0; i < COUNT; i++) {
        writes.push(writeAt(root, `unknownDir/item-${i}.xml`, `<x>${i}</x>`));
      }
      await Promise.all(writes);

      const walked = await walkAndExtract(root, null);
      expect(walked.skippedDirectories.unknownDir).toBe(COUNT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('renderVault pagination (v3.2 R2 OmniUiCard regression)', () => {
  // Why this test exists. The graph layer's `listNodesByType` caps a
  // single query at 500 rows (`LIST_MAX_LIMIT`). Before v3.2 R2 the
  // renderer called it with `{ limit: 500 }` and stopped — fine while
  // no metadata type exceeded 500 nodes. The v3.2 R2 wave landed
  // OmniUiCard at 678 nodes in Globex, silently truncating the
  // rendered Markdown vault at 500. The fix paginates with `offset`
  // inside `renderVault`. This test guards against future regressions
  // by seeding 678 nodes of a single type and asserting every one is
  // rendered (no truncation at any multiple of 500).
  const TYPE_OVER_CAP_COUNT = 678;

  const buildSeed = (count: number): ExtractionResult => {
    const nodes: Node[] = [];
    for (let i = 0; i < count; i++) {
      // Zero-padded sequence keeps `id ASC` ordering stable and matches
      // the production layout where ApiNames are typically suffix-numbered.
      const seq = String(i).padStart(4, '0');
      nodes.push({
        id: `OmniUiCard:Card_${seq}`,
        type: 'OmniUiCard',
        apiName: `Card_${seq}`,
        label: `Card ${seq}`,
        parentId: null,
        sourcePath: `omniUiCard/Card_${seq}.ouc-meta.xml`,
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      });
    }
    return { nodes, edges: [] };
  };

  it('renders every node of a type whose count exceeds the 500-row graph-query cap', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'sfi-render-pagination-'));
    const vaultRoot = join(tempDir, 'org-kb');
    const dbPath = join(vaultRoot, 'graph', 'org-kb.db');
    await mkdir(join(vaultRoot, 'graph'), { recursive: true });
    await mkdir(join(vaultRoot, 'components'), { recursive: true });

    const opened = await openGraph(dbPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      await rm(tempDir, { recursive: true, force: true });
      return;
    }
    const store: GraphStore = opened.value;
    try {
      const imported = await importExtractionResults(store, [buildSeed(TYPE_OVER_CAP_COUNT)]);
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;

      const counts = await renderVault(store, vaultRoot);
      // Every seeded node must show up in the per-type tally — no
      // truncation at 500, no truncation at any page boundary.
      expect(counts.components.OmniUiCard).toBe(TYPE_OVER_CAP_COUNT);

      // And every node must have produced a Markdown file on disk.
      // Cards land under `components/OmniUiCard/`.
      const renderedFiles = await readdir(join(vaultRoot, 'components', 'OmniUiCard'));
      const mdFiles = renderedFiles.filter((f) => f.endsWith('.md'));
      expect(mdFiles).toHaveLength(TYPE_OVER_CAP_COUNT);
    } finally {
      await closeGraph(store);
      await rm(tempDir, { recursive: true, force: true });
    }
    // Heavy I/O: opens DuckDB, imports 678 nodes, then writes 678 Markdown
    // files. ~0.8s locally but the shared CI runner's disk contention pushed it
    // past the 5s default and flaked the build. A generous explicit budget
    // keeps it deterministic without masking a real hang.
  }, 30_000);
});

describe('renderVault edge batching (CR-17 N+1 elimination)', () => {
  const mkNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
    label: overrides.apiName,
    parentId: null,
    sourcePath: `x/${overrides.apiName}.xml`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
    ...overrides,
  });
  const mkEdge = (overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>): Edge => ({
    edgeType: 'references',
    confidence: 'parsed',
    source: 'extractor:test',
    properties: {},
    ...overrides,
  });

  const setupStore = async (
    seed: ExtractionResult,
  ): Promise<{ store: GraphStore; vaultRoot: string; tempDir: string }> => {
    const tempDir = await mkdtemp(join(tmpdir(), 'sfi-render-batch-'));
    const vaultRoot = join(tempDir, 'org-kb');
    await mkdir(join(vaultRoot, 'graph'), { recursive: true });
    await mkdir(join(vaultRoot, 'components'), { recursive: true });
    const opened = await openGraph(join(vaultRoot, 'graph', 'org-kb.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const store = opened.value;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    return { store, vaultRoot, tempDir };
  };

  it('issues O(pages) edge queries, not O(nodes) (CR-17)', async () => {
    // 5 CustomObjects, each with one outgoing edge. The old path issued one
    // `listEdges` per node (5 queries); the batched path issues one
    // `listEdgesForNodes` per page (1 query, all 5 < RENDER_PAGE_SIZE).
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `CustomObject:Obj_${i}`;
      nodes.push(mkNode({ id, type: 'CustomObject', apiName: `Obj_${i}` }));
      edges.push(
        mkEdge({ fromId: id, toId: 'CustomObject:Shared', edgeType: 'references' }),
      );
    }
    nodes.push(mkNode({ id: 'CustomObject:Shared', type: 'CustomObject', apiName: 'Shared' }));
    const { store, vaultRoot, tempDir } = await setupStore({ nodes, edges });
    try {
      const spy = vi.spyOn(store.connection, 'runAndReadAll');
      await renderVault(store, vaultRoot);
      const edgeQueries = spy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && /FROM edges/i.test(c[0] as string),
      );
      // CustomObject is the only non-empty type here; all 6 nodes fit one page.
      expect(edgeQueries.length).toBe(1);
      spy.mockRestore();
    } finally {
      await closeGraph(store);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('renders byte-identical Markdown for same-endpoint differing-source edges (CR-17)', async () => {
    // Two incoming `references` edges to Widget__c, BOTH from the same source
    // node (identical endpointId) but different `source` producers — the exact
    // same-endpoint tiebreak gap the plan-check flagged. The renderer sorts
    // incoming rows only by endpointId, so the two rows' order is decided by
    // the order the batched bucket feeds them; the pinned
    // `(toId, edgeType, fromId, source)` total order makes that deterministic.
    const seed: ExtractionResult = {
      nodes: [
        mkNode({ id: 'CustomObject:Widget__c', type: 'CustomObject', apiName: 'Widget__c' }),
        mkNode({ id: 'Flow:SyncFlow', type: 'Flow', apiName: 'SyncFlow' }),
      ],
      edges: [
        mkEdge({
          fromId: 'Flow:SyncFlow',
          toId: 'CustomObject:Widget__c',
          edgeType: 'references',
          source: 'extractor:flow-zeta',
        }),
        mkEdge({
          fromId: 'Flow:SyncFlow',
          toId: 'CustomObject:Widget__c',
          edgeType: 'references',
          source: 'extractor:flow-alpha',
        }),
      ],
    };
    const widgetRel = join('components', 'CustomObject', 'Widget__c.md');

    // Render once.
    const a = await setupStore(seed);
    let firstBytes: string;
    try {
      await renderVault(a.store, a.vaultRoot);
      firstBytes = await readFile(join(a.vaultRoot, widgetRel), 'utf8');
    } finally {
      await closeGraph(a.store);
      await rm(a.tempDir, { recursive: true, force: true });
    }

    // Render again in a fresh store — bytes must be identical (deterministic).
    const b = await setupStore(seed);
    let secondBytes: string;
    try {
      await renderVault(b.store, b.vaultRoot);
      secondBytes = await readFile(join(b.vaultRoot, widgetRel), 'utf8');
    } finally {
      await closeGraph(b.store);
      await rm(b.tempDir, { recursive: true, force: true });
    }

    expect(secondBytes).toBe(firstBytes);
    // Both producers are present and in the pinned (source ASC) order:
    // flow-alpha before flow-zeta.
    const alphaIdx = firstBytes.indexOf('extractor:flow-alpha');
    const zetaIdx = firstBytes.indexOf('extractor:flow-zeta');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zetaIdx);
  }, 30_000);

  it('counts only outgoing edges in RenderCounts (batched path preserves the tally)', async () => {
    // A -> B (references), and a self-loop A -> A (callsApex). Outgoing tally:
    // references=1 (A->B), callsApex=1 (A->A). B has no outgoing edges.
    const seed: ExtractionResult = {
      nodes: [
        mkNode({ id: 'ApexClass:A', type: 'ApexClass', apiName: 'A', sourcePath: 'classes/A.cls' }),
        mkNode({ id: 'ApexClass:B', type: 'ApexClass', apiName: 'B', sourcePath: 'classes/B.cls' }),
      ],
      edges: [
        mkEdge({ fromId: 'ApexClass:A', toId: 'ApexClass:B', edgeType: 'callsApex', confidence: 'heuristic', source: 'apex-scanner' }),
        mkEdge({ fromId: 'ApexClass:A', toId: 'ApexClass:A', edgeType: 'callsApex', confidence: 'heuristic', source: 'apex-scanner' }),
      ],
    };
    const { store, vaultRoot, tempDir } = await setupStore(seed);
    try {
      // Apex renderer reads the .cls source from the vault; write stubs.
      await mkdir(join(vaultRoot, 'classes'), { recursive: true });
      await writeFile(join(vaultRoot, 'classes', 'A.cls'), 'public class A {}', 'utf8');
      await writeFile(join(vaultRoot, 'classes', 'B.cls'), 'public class B {}', 'utf8');
      const counts = await renderVault(store, vaultRoot);
      // Two outgoing callsApex edges from A (A->B, A->A self-loop counted once).
      expect(counts.edges.callsApex).toBe(2);
    } finally {
      await closeGraph(store);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('renderVault per-type progress callback (P5-refresh-progress / B11)', () => {
  const objNode = (apiName: string): Node => ({
    id: `CustomObject:${apiName}`,
    type: 'CustomObject',
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: `objects/${apiName}/${apiName}.object-meta.xml`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  });
  const flowNode = (apiName: string): Node => ({
    id: `Flow:${apiName}`,
    type: 'Flow',
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: `flows/${apiName}.flow-meta.xml`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  });

  it('fires once per non-empty type with its count, and never for empty types', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'sfi-render-progress-'));
    const vaultRoot = join(tempDir, 'org-kb');
    await mkdir(join(vaultRoot, 'graph'), { recursive: true });
    await mkdir(join(vaultRoot, 'components'), { recursive: true });
    const opened = await openGraph(join(vaultRoot, 'graph', 'org-kb.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      await rm(tempDir, { recursive: true, force: true });
      return;
    }
    const store: GraphStore = opened.value;
    try {
      const seed: ExtractionResult = {
        nodes: [objNode('Aaa__c'), objNode('Bbb__c'), flowNode('My_Flow')],
        edges: [],
      };
      const imported = await importExtractionResults(store, [seed]);
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;

      const seen: Array<{ type: string; count: number }> = [];
      const counts = await renderVault(store, vaultRoot, (type, count) => {
        seen.push({ type, count });
      });

      // Exactly the two non-empty types, each with the right count.
      expect(seen).toContainEqual({ type: 'CustomObject', count: 2 });
      expect(seen).toContainEqual({ type: 'Flow', count: 1 });
      expect(seen).toHaveLength(2);
      // No callback for a type that produced zero nodes (no noise).
      expect(seen.some((e) => e.count === 0)).toBe(false);
      // The streamed counts agree with the final tally.
      expect(counts.components.CustomObject).toBe(2);
      expect(counts.components.Flow).toBe(1);
    } finally {
      await closeGraph(store);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('walkAndExtract incremental cache (P5-incremental-refresh)', () => {
  it('reuses unchanged files and re-extracts a changed one — graph results stay identical', async () => {
    const root = await makeTempRoot();
    const src = join(root, 'source');
    try {
      await writeAt(src, 'objects/Aaa__c/Aaa__c.object-meta.xml', objectXml('Aaa'));
      await writeAt(src, 'objects/Bbb__c/Bbb__c.object-meta.xml', objectXml('Bbb'));

      // Cold walk: nothing reused, cache populated for both files.
      const cold = await walkAndExtract(src, null);
      expect(cold.reusedCount).toBe(0);
      expect(cold.cache.size).toBe(2);
      const coldNodeCount = cold.results.reduce((n, r) => n + r.nodes.length, 0);

      // Warm walk with the cache: both files unchanged → both reused, and the
      // extracted results are IDENTICAL (same node count).
      const warm = await walkAndExtract(src, null, cold.cache);
      expect(warm.reusedCount).toBe(2);
      expect(warm.results.reduce((n, r) => n + r.nodes.length, 0)).toBe(coldNodeCount);

      // Change ONE file (a different-length label → different file size, a
      // deterministic cache miss regardless of mtime resolution). The other
      // file is still reused.
      await writeAt(
        src,
        'objects/Bbb__c/Bbb__c.object-meta.xml',
        objectXml('BbbRenamedLonger'),
      );
      const incr = await walkAndExtract(src, null, warm.cache);
      expect(incr.reusedCount).toBe(1); // only Aaa reused; Bbb re-extracted
      expect(incr.results).toHaveLength(2); // graph still has both objects
      // The fresh cache records the changed file's NEW size.
      const bbbEntry = incr.cache.get('objects/Bbb__c/Bbb__c.object-meta.xml');
      expect(bbbEntry).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
