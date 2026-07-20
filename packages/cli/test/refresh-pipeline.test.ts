/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  getNodeById,
  importExtractionResults,
  listNodesByType,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import {
  buildProfileIdIndex,
  componentTypeFromSourcePath,
  FOLDED_REPORT_DASHBOARD_NAME_CAP,
  foldReportDashboardUsageIntoFields,
  renderVault,
  resolveRestrictionRuleProfileEdges,
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

  // Finding #36: "which reports break if I change this field" was structurally
  // unanswerable from the boolean alone. These two cases prove the fold now
  // preserves a capped, named list — with an honest truncation disclosure once
  // a field crosses the per-field cap.
  it('Finding #36 — preserves a capped, sorted name list for a field used by 2+ reports/dashboards', () => {
    const results: readonly ExtractionResult[] = [
      {
        nodes: [mkNode('CustomField:Account.Multi__c', 'CustomField')],
        edges: [],
      },
      {
        nodes: [
          mkNode('Report:Sales/Pipeline', 'Report'),
          mkNode('Report:Exec/Forecast', 'Report'),
        ],
        edges: [
          mkRef('Report:Sales/Pipeline', 'CustomField:Account.Multi__c'),
          mkRef('Report:Exec/Forecast', 'CustomField:Account.Multi__c'),
        ],
      },
      {
        nodes: [mkNode('Dashboard:Exec/KPIs', 'Dashboard')],
        edges: [mkRef('Dashboard:Exec/KPIs', 'CustomField:Account.Multi__c')],
      },
    ];

    const out = foldReportDashboardUsageIntoFields(results);
    const field = out
      .flatMap((r) => r.nodes)
      .find((n) => n.id === 'CustomField:Account.Multi__c');

    expect(field?.properties['usedInReport']).toBe(true);
    // Sorted (not encounter-order) so the answer is deterministic.
    expect(field?.properties['usedInReports']).toEqual(['Exec/Forecast', 'Sales/Pipeline']);
    expect(field?.properties['usedInReportsTruncated']).toBeUndefined();
    expect(field?.properties['usedInDashboard']).toBe(true);
    expect(field?.properties['usedInDashboards']).toEqual(['Exec/KPIs']);
    expect(field?.properties['usedInDashboardsTruncated']).toBeUndefined();
    // Report/Dashboard nodes still dropped — only the capped name list survives.
    const outNodes = out.flatMap((r) => r.nodes);
    expect(outNodes.some((n) => n.type === 'Report' || n.type === 'Dashboard')).toBe(false);
  });

  it('Finding #36 — discloses truncation when a field exceeds the per-field name cap', () => {
    const reportCount = 55;
    const reportNodes = Array.from({ length: reportCount }, (_, i) =>
      mkNode(`Report:Bulk/Report${String(i).padStart(3, '0')}`, 'Report'),
    );
    const reportEdges = reportNodes.map((n) =>
      mkRef(n.id, 'CustomField:Account.HeavilyUsed__c'),
    );
    const results: readonly ExtractionResult[] = [
      {
        nodes: [mkNode('CustomField:Account.HeavilyUsed__c', 'CustomField')],
        edges: [],
      },
      { nodes: reportNodes, edges: reportEdges },
    ];

    const out = foldReportDashboardUsageIntoFields(results);
    const field = out
      .flatMap((r) => r.nodes)
      .find((n) => n.id === 'CustomField:Account.HeavilyUsed__c');

    const names = field?.properties['usedInReports'] as string[] | undefined;
    expect(names).toHaveLength(FOLDED_REPORT_DASHBOARD_NAME_CAP);
    // Truncated total discloses the TRUE count, not just "capped".
    expect(field?.properties['usedInReportsTruncated']).toBe(55);
    // The capped 50 are the alphabetically-first 50 (deterministic, not
    // dependent on file-walk / edge-emission order).
    expect(names?.[0]).toBe('Bulk/Report000');
    expect(names?.[49]).toBe('Bulk/Report049');
  });

  it('R6-24 Option B — folded names survive import so impact tools can read them', async () => {
    const results: readonly ExtractionResult[] = [
      {
        nodes: [mkNode('CustomField:Account.OptionB__c', 'CustomField')],
        edges: [],
      },
      {
        nodes: [
          mkNode('Report:Sales/Pipeline', 'Report'),
          mkNode('Report:Exec/Forecast', 'Report'),
        ],
        edges: [
          mkRef('Report:Sales/Pipeline', 'CustomField:Account.OptionB__c'),
          mkRef('Report:Exec/Forecast', 'CustomField:Account.OptionB__c'),
        ],
      },
      {
        nodes: [mkNode('Dashboard:Exec/KPIs', 'Dashboard')],
        edges: [mkRef('Dashboard:Exec/KPIs', 'CustomField:Account.OptionB__c')],
      },
    ];
    const folded = foldReportDashboardUsageIntoFields(results);
    const dir = await makeTempRoot();
    try {
      const opened = await openGraph(join(dir, 'option-b.db'));
      if (!opened.ok) throw new Error(opened.error.message);
      const store: GraphStore = opened.value;
      try {
        const imp = await importExtractionResults(store, folded);
        if (!imp.ok) throw new Error(imp.error.message);
        // No Report/Dashboard nodes in the graph — identity is field properties only.
        const reports = await listNodesByType(store, 'Report');
        const dashboards = await listNodesByType(store, 'Dashboard');
        expect(reports.ok).toBe(true);
        expect(dashboards.ok).toBe(true);
        if (reports.ok) expect(reports.value).toHaveLength(0);
        if (dashboards.ok) expect(dashboards.value).toHaveLength(0);
        const fieldResult = await getNodeById(store, 'CustomField:Account.OptionB__c');
        expect(fieldResult.ok).toBe(true);
        if (!fieldResult.ok || fieldResult.value === null) return;
        expect(fieldResult.value.properties['usedInReports']).toEqual([
          'Exec/Forecast',
          'Sales/Pipeline',
        ]);
        expect(fieldResult.value.properties['usedInDashboards']).toEqual(['Exec/KPIs']);
      } finally {
        await closeGraph(store);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: the extractor emits an
// explicit `UnresolvedProfile:{id}` stub for a userCriteria `$User.ProfileId`
// gate (a single-file extractor cannot resolve the opaque id, and a
// `Profile:{id}` phantom would masquerade as a real Profile). This cross-file
// pass resolves the stub into a real `Profile:{apiName}` edge when a Profile
// node carries its Salesforce id — and leaves the honest stub in place when it
// does not (the real offline vault: Profile metadata carries no id). All ids /
// apiNames below are SYNTHETIC and verified absent from org-kb.
describe('resolveRestrictionRuleProfileEdges (RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE)', () => {
  const SYN_PROFILE_SID18 = '00eSYNTHETIC001AAA';
  const SYN_PROFILE_APINAME = 'Synthetic_Widget_Reviewer';
  const SYN_UNMAPPED_ID = '00eSYNTHNOMATCH999';

  const mkNode = (
    id: string,
    type: Node['type'],
    properties: Record<string, unknown> = {},
  ): Node => ({
    id,
    type,
    apiName: id.slice(id.indexOf(':') + 1),
    label: null,
    parentId: null,
    sourcePath: 'x',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties,
  });

  /** A synthetic Profile node carrying its Salesforce id (offline vaults do NOT). */
  const profileWithId = (apiName: string, salesforceId: string): Node => ({
    ...mkNode(`Profile:${apiName}`, 'Profile', { salesforceId }),
  });

  /** A RestrictionRule result shaped exactly like the extractor emits. */
  const ruleResultWithStub = (ruleName: string, profileId: string): ExtractionResult => ({
    nodes: [
      mkNode(`RestrictionRule:${ruleName}`, 'RestrictionRule', {
        active: 'true',
        userCriteriaProfileIds: [profileId],
        unresolvedProfileIds: [profileId],
      }),
    ],
    edges: [
      {
        fromId: `RestrictionRule:${ruleName}`,
        toId: `UnresolvedProfile:${profileId}`,
        edgeType: 'references',
        confidence: 'heuristic',
        source: 'enterprise-metadata-extractor',
        properties: {
          referenceKind: 'restrictionUserProfileUnresolved',
          unresolvedProfileId: profileId,
          idBasedTarget: true,
        },
      },
    ],
  });

  it('rewrites the stub to a real Profile:{apiName} edge when the id resolves', () => {
    const results: readonly ExtractionResult[] = [
      { nodes: [profileWithId(SYN_PROFILE_APINAME, SYN_PROFILE_SID18)], edges: [] },
      ruleResultWithStub('Limit_Widget_Reviewer', SYN_PROFILE_SID18),
    ];

    const out = resolveRestrictionRuleProfileEdges(results);
    const edges = out.flatMap((r) => r.edges);

    // The stub is gone; a real Profile edge takes its place.
    expect(edges.some((e) => e.toId.startsWith('UnresolvedProfile:'))).toBe(false);
    const profileEdge = edges.find(
      (e) => e.toId === `Profile:${SYN_PROFILE_APINAME}`,
    );
    expect(profileEdge).toBeDefined();
    if (!profileEdge) return;
    expect(profileEdge.fromId).toBe('RestrictionRule:Limit_Widget_Reviewer');
    expect(profileEdge.edgeType).toBe('references');
    // "that Profile's usages include the RestrictionRule" — the inbound
    // reference now lands on the real Profile node, not a phantom.
    expect(profileEdge.properties).toEqual({
      referenceKind: 'restrictionUserProfile',
      profileId: SYN_PROFILE_SID18,
      resolvedFromProfileId: true,
    });

    // Node props are trimmed in lockstep: resolved id moves into the map, the
    // now-empty `unresolvedProfileIds` disclosure is dropped, and the full gated
    // list survives.
    const ruleNode = out
      .flatMap((r) => r.nodes)
      .find((n) => n.id === 'RestrictionRule:Limit_Widget_Reviewer')!;
    expect(ruleNode.properties['userCriteriaResolvedProfiles']).toEqual({
      [SYN_PROFILE_SID18]: SYN_PROFILE_APINAME,
    });
    expect(ruleNode.properties['unresolvedProfileIds']).toBeUndefined();
    expect(ruleNode.properties['userCriteriaProfileIds']).toEqual([SYN_PROFILE_SID18]);
  });

  it('leaves an UNRESOLVABLE id as an explicit stub — never mints a Profile:{id} phantom', () => {
    const results: readonly ExtractionResult[] = [
      // A real profile exists, but its id does NOT match the rule's gated id.
      { nodes: [profileWithId(SYN_PROFILE_APINAME, SYN_PROFILE_SID18)], edges: [] },
      ruleResultWithStub('Limit_Orphan_Access', SYN_UNMAPPED_ID),
    ];

    const out = resolveRestrictionRuleProfileEdges(results);
    const edges = out.flatMap((r) => r.edges);

    // No Profile:{id} phantom, and the unmatched id does NOT collide with the
    // real profile node.
    expect(edges.some((e) => e.toId === `Profile:${SYN_UNMAPPED_ID}`)).toBe(false);
    expect(edges.some((e) => e.toId === `Profile:${SYN_PROFILE_APINAME}`)).toBe(false);
    const stub = edges.find((e) => e.toId === `UnresolvedProfile:${SYN_UNMAPPED_ID}`);
    expect(stub).toBeDefined();
    expect(stub?.properties['referenceKind']).toBe('restrictionUserProfileUnresolved');
    const ruleNode = out
      .flatMap((r) => r.nodes)
      .find((n) => n.id === 'RestrictionRule:Limit_Orphan_Access')!;
    expect(ruleNode.properties['unresolvedProfileIds']).toEqual([SYN_UNMAPPED_ID]);
    expect(ruleNode.properties['userCriteriaResolvedProfiles']).toBeUndefined();
  });

  it('resolves across a 15-vs-18-char id width mismatch', () => {
    const sid15 = SYN_PROFILE_SID18.slice(0, 15);
    const results: readonly ExtractionResult[] = [
      // Profile keyed on the 15-char form; rule gates on the 18-char form.
      { nodes: [profileWithId(SYN_PROFILE_APINAME, sid15)], edges: [] },
      ruleResultWithStub('Limit_Width_Mismatch', SYN_PROFILE_SID18),
    ];
    const out = resolveRestrictionRuleProfileEdges(results);
    const edges = out.flatMap((r) => r.edges);
    expect(edges.some((e) => e.toId === `Profile:${SYN_PROFILE_APINAME}`)).toBe(true);
    expect(edges.some((e) => e.toId.startsWith('UnresolvedProfile:'))).toBe(false);
  });

  it('is an identity no-op on a real offline vault — profiles carry no id, so the stub survives', () => {
    const results: readonly ExtractionResult[] = [
      // Profile WITHOUT a salesforceId — the real offline shape.
      { nodes: [mkNode(`Profile:${SYN_PROFILE_APINAME}`, 'Profile')], edges: [] },
      ruleResultWithStub('Limit_Real_Vault', SYN_PROFILE_SID18),
    ];
    // Empty index → returns the SAME array ref (observably free no-op).
    expect(buildProfileIdIndex(results).size).toBe(0);
    expect(resolveRestrictionRuleProfileEdges(results)).toBe(results);
  });

  it('builds an Id->apiName index (both id widths) from a profile that carries its id', () => {
    const results: readonly ExtractionResult[] = [
      { nodes: [profileWithId(SYN_PROFILE_APINAME, SYN_PROFILE_SID18)], edges: [] },
    ];
    const index = buildProfileIdIndex(results);
    expect(index.get(SYN_PROFILE_SID18)).toBe(SYN_PROFILE_APINAME);
    expect(index.get(SYN_PROFILE_SID18.slice(0, 15))).toBe(SYN_PROFILE_APINAME);
  });

  // DUPLICATE-RULE-FILTER-PROFILE-UNGRAPHED sibling: a DuplicateRule
  // `<duplicateRuleFilter>` `ProfileId` item emits the SAME honest
  // `UnresolvedProfile:{id}` stub (referenceKind `duplicateRuleProfileUnresolved`),
  // and this SAME pass resolves it — preserving the duplicate edge's
  // `filterField` / `operation` and leaving the DuplicateRule node untouched
  // (no restriction-specific `unresolvedProfileIds` disclosure array to trim).
  const dupRuleResultWithStub = (
    ruleName: string,
    profileId: string,
    operation = 'notEqual',
  ): ExtractionResult => ({
    nodes: [
      mkNode(`DuplicateRule:${ruleName}`, 'DuplicateRule', {
        filterProfiles: [profileId],
      }),
    ],
    edges: [
      {
        fromId: `DuplicateRule:${ruleName}`,
        toId: `UnresolvedProfile:${profileId}`,
        edgeType: 'references',
        confidence: 'heuristic',
        source: 'duplicate-rule-extractor',
        properties: {
          referenceKind: 'duplicateRuleProfileUnresolved',
          filterField: 'ProfileId',
          operation,
          unresolvedProfileId: profileId,
          idBasedTarget: true,
        },
      },
    ],
  });

  it('rewrites a DuplicateRule ProfileId stub to Profile:{apiName}, preserving filterField/operation', () => {
    const results: readonly ExtractionResult[] = [
      { nodes: [profileWithId(SYN_PROFILE_APINAME, SYN_PROFILE_SID18)], edges: [] },
      dupRuleResultWithStub('Account.Block_Portal_Dup', SYN_PROFILE_SID18, 'notEqual'),
    ];

    const out = resolveRestrictionRuleProfileEdges(results);
    const edges = out.flatMap((r) => r.edges);

    // The stub is gone; a real Profile edge takes its place.
    expect(edges.some((e) => e.toId.startsWith('UnresolvedProfile:'))).toBe(false);
    const profileEdge = edges.find((e) => e.toId === `Profile:${SYN_PROFILE_APINAME}`);
    expect(profileEdge).toBeDefined();
    if (!profileEdge) return;
    expect(profileEdge.fromId).toBe('DuplicateRule:Account.Block_Portal_Dup');
    // Reads as a duplicateFilterProfile (parity with a name-based filter), keeps
    // the exclusion operation + source field, and records the resolved id.
    expect(profileEdge.properties).toEqual({
      referenceKind: 'duplicateFilterProfile',
      profileId: SYN_PROFILE_SID18,
      resolvedFromProfileId: true,
      filterField: 'ProfileId',
      operation: 'notEqual',
    });

    // DuplicateRule node carries no restriction-specific disclosure array, so
    // the pass leaves its properties untouched.
    const dupNode = out
      .flatMap((r) => r.nodes)
      .find((n) => n.id === 'DuplicateRule:Account.Block_Portal_Dup')!;
    expect(dupNode.properties['userCriteriaResolvedProfiles']).toBeUndefined();
    expect(dupNode.properties['filterProfiles']).toEqual([SYN_PROFILE_SID18]);
  });

  it('leaves an UNRESOLVABLE DuplicateRule ProfileId as a stub — never a Profile:{id} phantom', () => {
    const results: readonly ExtractionResult[] = [
      { nodes: [profileWithId(SYN_PROFILE_APINAME, SYN_PROFILE_SID18)], edges: [] },
      dupRuleResultWithStub('Account.Orphan_Dup', SYN_UNMAPPED_ID, 'equals'),
    ];

    const out = resolveRestrictionRuleProfileEdges(results);
    const edges = out.flatMap((r) => r.edges);

    expect(edges.some((e) => e.toId === `Profile:${SYN_UNMAPPED_ID}`)).toBe(false);
    expect(edges.some((e) => e.toId === `Profile:${SYN_PROFILE_APINAME}`)).toBe(false);
    const stub = edges.find((e) => e.toId === `UnresolvedProfile:${SYN_UNMAPPED_ID}`);
    expect(stub).toBeDefined();
    expect(stub?.properties['referenceKind']).toBe('duplicateRuleProfileUnresolved');
  });

  it('is an identity no-op for a DuplicateRule ProfileId stub on a real offline vault', () => {
    const results: readonly ExtractionResult[] = [
      // Profile WITHOUT a salesforceId — the real offline shape.
      { nodes: [mkNode(`Profile:${SYN_PROFILE_APINAME}`, 'Profile')], edges: [] },
      dupRuleResultWithStub('Account.Real_Vault_Dup', SYN_PROFILE_SID18),
    ];
    expect(buildProfileIdIndex(results).size).toBe(0);
    expect(resolveRestrictionRuleProfileEdges(results)).toBe(results);
  });
});

describe('componentTypeFromSourcePath bundle directory resolution (R6-29)', () => {
  // Regression guard: a prior version computed `dirSegments` differently for
  // `isDirectory: true` than for `isDirectory: false`, leaving the bundle's
  // OWN basename (e.g. `orderCard`) as the last `dirSegments` entry instead
  // of its parent (`lwc`/`aura`). `dispatchFile`'s bundle branch reads
  // `segments[segments.length - 1]` expecting the parent dir name, so it
  // always missed and returned `null` — every LWC/Aura bundle directory
  // silently failed to resolve, both from `walkAndExtract`'s own coverage
  // reporting AND from `sfi review-change`'s git-diff path mapper (worked
  // around there until this fix — see review-change.ts `deriveComponentFromPath`).

  it('resolves an LWC bundle directory to LightningComponentBundle', () => {
    const root = '/vault/source';
    const bundleDir = `${root}/lwc/orderCard`;
    expect(componentTypeFromSourcePath(root, bundleDir, true)).toBe(
      'LightningComponentBundle',
    );
  });

  it('resolves an Aura bundle directory to AuraDefinitionBundle', () => {
    const root = '/vault/source';
    const bundleDir = `${root}/aura/orderForm`;
    expect(componentTypeFromSourcePath(root, bundleDir, true)).toBe(
      'AuraDefinitionBundle',
    );
  });

  it('still resolves a file-shaped type when isDirectory is false (no regression)', () => {
    const root = '/vault/source';
    const filePath = `${root}/classes/OrderService.cls`;
    expect(componentTypeFromSourcePath(root, filePath, false)).toBe('ApexClass');
  });

  it('returns null for a directory that is not a recognised bundle parent', () => {
    const root = '/vault/source';
    const dir = `${root}/omniProcesses/SomeProcess`;
    expect(componentTypeFromSourcePath(root, dir, true)).toBeNull();
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

  it('dispatches PlatformEventChannel + PlatformEventChannelMember files, wiring channel→member→event (CR-CAP-18)', async () => {
    const root = await makeTempRoot();
    try {
      // Flat top-level dispatches. Fail-before: no dispatch branch -> the two
      // dirs are walked but never routed (no nodes, inflated skip count).
      // Pass-after: both nodes exist AND the member emits parentOf(channel→member)
      // + references(member→CustomObject:Application_Event__e carrying the filter).
      await writeAt(
        root,
        'platformEventChannels/Application_Event_Channel__chn.platformEventChannel-meta.xml',
        '<?xml version="1.0"?><PlatformEventChannel xmlns="http://soap.sforce.com/2006/04/metadata"><channelType>event</channelType><label>Application Event Channel</label></PlatformEventChannel>',
      );
      await writeAt(
        root,
        'platformEventChannelMembers/Application_Event_Member__chn.platformEventChannelMember-meta.xml',
        "<?xml version=\"1.0\"?><PlatformEventChannelMember xmlns=\"http://soap.sforce.com/2006/04/metadata\"><eventChannel>Application_Event_Channel__chn</eventChannel><selectedEntity>Application_Event__e</selectedEntity><filterExpression>Status__c = 'New'</filterExpression></PlatformEventChannelMember>",
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain(
        'PlatformEventChannel:Application_Event_Channel__chn',
      );
      expect(ids).toContain(
        'PlatformEventChannelMember:Application_Event_Member__chn',
      );
      const edges = walked.results.flatMap((r) => r.edges);
      const parentOf = edges.find(
        (e) =>
          e.edgeType === 'parentOf' &&
          e.toId === 'PlatformEventChannelMember:Application_Event_Member__chn',
      );
      expect(parentOf?.fromId).toBe(
        'PlatformEventChannel:Application_Event_Channel__chn',
      );
      const ref = edges.find(
        (e) =>
          e.edgeType === 'references' &&
          e.fromId ===
            'PlatformEventChannelMember:Application_Event_Member__chn',
      );
      expect(ref?.toId).toBe('CustomObject:Application_Event__e');
      expect(ref?.properties.filterExpression).toBe("Status__c = 'New'");
      expect(walked.skippedDirectories.platformEventChannels).toBeUndefined();
      expect(
        walked.skippedDirectories.platformEventChannelMembers,
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches a top-level SamlSsoConfig file to a node (R6-01)', async () => {
    const root = await makeTempRoot();
    try {
      // samlssoconfigs/{Name}.samlssoconfig-meta.xml is a flat top-level
      // dispatch. Fail-before: the extractor + ComponentType existed but no
      // dispatch branch routed the file to it — the file was walked but
      // never extracted, so value-change-risk.ts's `listNodesByType(...,
      // 'SamlSsoConfig', ...)` silently saw zero configs. Pass-after: a
      // SamlSsoConfig:Entra_ID_SSO node exists and the directory is never
      // counted as an uncovered-type skip.
      await writeAt(
        root,
        'samlssoconfigs/Entra_ID_SSO.samlssoconfig-meta.xml',
        '<?xml version="1.0"?><SamlSsoConfig xmlns="http://soap.sforce.com/2006/04/metadata"><identityMapping>FederationId</identityMapping></SamlSsoConfig>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('SamlSsoConfig:Entra_ID_SSO');
      expect(walked.skippedDirectories.samlssoconfigs).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches a top-level Certificate file to a node and never dispatches the paired .crt content file (R6-22)', async () => {
    const root = await makeTempRoot();
    try {
      // certs/{Name}.crt-meta.xml is a flat top-level dispatch. The Metadata
      // API always retrieves a Certificate as TWO files: this sidecar and a
      // {Name}.crt content file (the actual PEM/DER cert/key material). The
      // strict `.crt-meta.xml` suffix check must dispatch the sidecar and
      // MUST NOT dispatch the bare `.crt` file — verified against a real
      // production-scale sandbox retrieve.
      await writeAt(
        root,
        'certs/EC_Community.crt-meta.xml',
        '<?xml version="1.0"?><Certificate xmlns="http://soap.sforce.com/2006/04/metadata"><caSigned>true</caSigned><expirationDate>2026-11-12T14:40:53.000Z</expirationDate><keySize>2048</keySize></Certificate>',
      );
      await writeAt(root, 'certs/EC_Community.crt', '-----BEGIN CERTIFICATE-----\nMIIG...\n-----END CERTIFICATE-----');

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('Certificate:EC_Community');
      // Exactly one Certificate node — the .crt content file never produced
      // its own extraction result (it was never dispatched at all).
      expect(ids.filter((id) => id.startsWith('Certificate:')).length).toBe(1);
      // The bare .crt content file is honestly counted as skipped (unlike
      // SamlSsoConfig/StandardValueSet, where 100% of a covered directory's
      // files dispatch, `certs/` legitimately carries one undispatched file
      // per component BY DESIGN — the skip-counter tracking that is the
      // correct, honest behavior, not a coverage gap).
      expect(walked.skippedDirectories.certs).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches a top-level TransactionSecurityPolicy file to a node with an ApexClass condition edge (R6-22)', async () => {
    const root = await makeTempRoot();
    try {
      // transactionSecurityPolicies/{Name}.transactionSecurityPolicy-meta.xml
      // is a flat top-level dispatch. Folder + suffix verified against the
      // Metadata API Developer Guide (no real org in the accessible sandbox
      // fleet has Shield/Event Monitoring enabled to retrieve one live).
      await writeAt(
        root,
        'transactionSecurityPolicies/Block_Suspicious_Login.transactionSecurityPolicy-meta.xml',
        '<?xml version="1.0"?><TransactionSecurityPolicy xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><apexClass>SuspiciousLoginCondition</apexClass><eventName>LoginEvent</eventName></TransactionSecurityPolicy>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('TransactionSecurityPolicy:Block_Suspicious_Login');
      const edges = walked.results.flatMap((r) => r.edges);
      expect(
        edges.some(
          (e) =>
            e.fromId === 'TransactionSecurityPolicy:Block_Suspicious_Login' &&
            e.toId === 'ApexClass:SuspiciousLoginCondition',
        ),
      ).toBe(true);
      expect(walked.skippedDirectories.transactionSecurityPolicies).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches a top-level StandardValueSet file to a node (R6-08)', async () => {
    const root = await makeTempRoot();
    try {
      // standardValueSets/{Name}.standardValueSet-meta.xml is a flat top-level
      // dispatch. Fail-before: no ComponentType, no dispatch branch -> the
      // directory is walked but never routed. Pass-after: a
      // StandardValueSet:LeadSource node exists and the directory is never
      // counted as an uncovered-type skip.
      await writeAt(
        root,
        'standardValueSets/LeadSource.standardValueSet-meta.xml',
        '<?xml version="1.0"?><StandardValueSet xmlns="http://soap.sforce.com/2006/04/metadata"><standardValue><fullName>Web</fullName></standardValue></StandardValueSet>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('StandardValueSet:LeadSource');
      expect(walked.skippedDirectories.standardValueSets).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches the four R6-18 Service Cloud top-level types, wiring EntitlementProcess->MilestoneType and Queue->QueueRoutingConfig', async () => {
    const root = await makeTempRoot();
    try {
      // All four are flat top-level dispatches under their own DX directory —
      // folder/suffix verified via real scoped retrieves from two live orgs.
      // Fail-before: no dispatch branch -> files walked but never routed
      // (inflated skip count, zero nodes). Pass-after: all four nodes exist,
      // the entitlement process's declared milestone reference resolves, and
      // the pre-existing Queue extractor's <queueRoutingConfig> string now
      // also emits a references edge.
      await writeAt(
        root,
        'entitlementProcesses/standard_case.entitlementProcess-meta.xml',
        '<?xml version="1.0"?><EntitlementProcess xmlns="http://soap.sforce.com/2006/04/metadata"><SObjectType>Case</SObjectType><active>true</active><milestones><milestoneName>First Response to Customer</milestoneName></milestones></EntitlementProcess>',
      );
      await writeAt(
        root,
        'milestoneTypes/First Response to Customer.milestoneType-meta.xml',
        '<?xml version="1.0"?><MilestoneType xmlns="http://soap.sforce.com/2006/04/metadata"><recurrenceType>none</recurrenceType></MilestoneType>',
      );
      await writeAt(
        root,
        'serviceChannels/sfdc_phone.serviceChannel-meta.xml',
        '<?xml version="1.0"?><ServiceChannel xmlns="http://soap.sforce.com/2006/04/metadata"><label>Phone</label><relatedEntityType>VoiceCall</relatedEntityType></ServiceChannel>',
      );
      await writeAt(
        root,
        'queueRoutingConfigs/agent_routing.queueRoutingConfig-meta.xml',
        '<?xml version="1.0"?><QueueRoutingConfig xmlns="http://soap.sforce.com/2006/04/metadata"><label>agent routing</label><routingModel>MOST_AVAILABLE</routingModel><routingPriority>1</routingPriority></QueueRoutingConfig>',
      );
      await writeAt(
        root,
        'queues/Case_Queue.queue-meta.xml',
        '<?xml version="1.0"?><Queue xmlns="http://soap.sforce.com/2006/04/metadata"><name>Case Queue</name><doesSendEmailToMembers>false</doesSendEmailToMembers><queueRoutingConfig>agent_routing</queueRoutingConfig></Queue>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('EntitlementProcess:standard_case');
      expect(ids).toContain('MilestoneType:First Response to Customer');
      expect(ids).toContain('ServiceChannel:sfdc_phone');
      expect(ids).toContain('QueueRoutingConfig:agent_routing');
      expect(ids).toContain('Queue:Case_Queue');

      const edges = walked.results.flatMap((r) => r.edges);
      expect(edges).toContainEqual(
        expect.objectContaining({
          fromId: 'EntitlementProcess:standard_case',
          toId: 'MilestoneType:First Response to Customer',
          edgeType: 'references',
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          fromId: 'Queue:Case_Queue',
          toId: 'QueueRoutingConfig:agent_routing',
          edgeType: 'references',
        }),
      );

      expect(walked.skippedDirectories.entitlementProcesses).toBeUndefined();
      expect(walked.skippedDirectories.milestoneTypes).toBeUndefined();
      expect(walked.skippedDirectories.serviceChannels).toBeUndefined();
      expect(walked.skippedDirectories.queueRoutingConfigs).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches the GenAI tier — including a nested GenAiPlannerBundle (R6-13)', async () => {
    const root = await makeTempRoot();
    try {
      // The four Agentforce GenAI families are flat file-based dispatches under
      // their own DX directory; GenAiPlannerBundle additionally nests one level
      // (genAiPlannerBundles/{agent}/...). Fail-before: no ComponentType, no
      // dispatch branch -> the directories are walked but never routed. Names
      // are SYNTHETIC.
      await writeAt(
        root,
        'genAiFunctions/Get_Order_Status.genAiFunction-meta.xml',
        '<?xml version="1.0"?><GenAiFunction xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>get_order_status</masterLabel><invocationTarget>Get_Order_Status</invocationTarget><invocationTargetType>apex</invocationTargetType></GenAiFunction>',
      );
      await writeAt(
        root,
        'genAiPlugins/Order_Management.genAiPlugin-meta.xml',
        '<?xml version="1.0"?><GenAiPlugin xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>Order Management</masterLabel><pluginType>Topic</pluginType><genAiFunctions><functionName>Get_Order_Status</functionName></genAiFunctions></GenAiPlugin>',
      );
      await writeAt(
        root,
        'genAiPlannerBundles/Order_Support_Agent/Order_Support_Agent.genAiPlannerBundle-meta.xml',
        '<?xml version="1.0"?><GenAiPlannerBundle xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>Order Support Agent</masterLabel><plannerType>AiCopilot__ReAct</plannerType><genAiPlugins><genAiPluginName>Order_Management</genAiPluginName></genAiPlugins></GenAiPlannerBundle>',
      );
      await writeAt(
        root,
        'genAiPromptTemplates/Draft_Followup.genAiPromptTemplate-meta.xml',
        '<?xml version="1.0"?><GenAiPromptTemplate xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>Draft Followup</masterLabel><type>einstein_gpt__flex</type><templateVersions><content>Hi {!$Input:Guest.Loyalty_Number__c}</content><inputs><apiName>Guest</apiName><definition>SOBJECT://Contact</definition><referenceName>Input:Guest</referenceName></inputs></templateVersions></GenAiPromptTemplate>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('GenAiFunction:Get_Order_Status');
      expect(ids).toContain('GenAiPlugin:Order_Management');
      expect(ids).toContain('GenAiPlannerBundle:Order_Support_Agent');
      expect(ids).toContain('GenAiPromptTemplate:Draft_Followup');
      // The grounding merge-field resolved to a real field edge.
      const edges = walked.results.flatMap((r) => r.edges);
      expect(edges.some((e) => e.toId === 'CustomField:Contact.Loyalty_Number__c')).toBe(true);
      expect(walked.skippedDirectories.genAiFunctions).toBeUndefined();
      expect(walked.skippedDirectories.genAiPromptTemplates).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches a nested Bot definition + two BotVersions, wiring Bot->BotVersion parentOf (R7-C7)', async () => {
    const root = await makeTempRoot();
    try {
      // Bot's own file basename embeds the bot name (nesting transparent,
      // like GenAiPlannerBundle); BotVersion files are bare (v1/v2), NOT
      // basename-disambiguated — folder/suffix verified via a real scoped
      // retrieve (`sf project retrieve start --metadata Bot`) that landed
      // BOTH shapes from a single request. All names SYNTHETIC.
      await writeAt(
        root,
        'bots/Campus_Support_Agent/Campus_Support_Agent.bot-meta.xml',
        '<?xml version="1.0"?><Bot xmlns="http://soap.sforce.com/2006/04/metadata"><label>Agent Plum</label><type>ExternalCopilot</type></Bot>',
      );
      await writeAt(
        root,
        'bots/Campus_Support_Agent/v1.botVersion-meta.xml',
        '<?xml version="1.0"?><BotVersion xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>v1</fullName><botDialogs><developerName>Welcome</developerName></botDialogs></BotVersion>',
      );
      await writeAt(
        root,
        'bots/Campus_Support_Agent/v2.botVersion-meta.xml',
        '<?xml version="1.0"?><BotVersion xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>v2</fullName><conversationDefinitionPlanners><genAiPlannerName>Campus_Support_Agent_v2</genAiPlannerName></conversationDefinitionPlanners></BotVersion>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('Bot:Campus_Support_Agent');
      expect(ids).toContain('BotVersion:Campus_Support_Agent.v1');
      expect(ids).toContain('BotVersion:Campus_Support_Agent.v2');

      const edges = walked.results.flatMap((r) => r.edges);
      expect(edges).toContainEqual(
        expect.objectContaining({
          fromId: 'Bot:Campus_Support_Agent',
          toId: 'BotVersion:Campus_Support_Agent.v1',
          edgeType: 'parentOf',
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          fromId: 'Bot:Campus_Support_Agent',
          toId: 'BotVersion:Campus_Support_Agent.v2',
          edgeType: 'parentOf',
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          fromId: 'BotVersion:Campus_Support_Agent.v2',
          toId: 'GenAiPlannerBundle:Campus_Support_Agent_v2',
          edgeType: 'references',
        }),
      );

      expect(walked.skippedDirectories.bots).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches a top-level PresenceUserConfig file, wiring a Profile references edge (R7-C7)', async () => {
    const root = await makeTempRoot();
    try {
      // Flat top-level dispatch under its own DX directory — folder/suffix
      // verified via real scoped retrieves from two live orgs. All names
      // SYNTHETIC.
      await writeAt(
        root,
        'presenceUserConfigs/agentforce.presenceUserConfig-meta.xml',
        '<?xml version="1.0"?><PresenceUserConfig xmlns="http://soap.sforce.com/2006/04/metadata"><assignments><profiles><profile>einstein agent user</profile></profiles><users><user>agentuser@example.invalid</user></users></assignments><capacity>10</capacity><label>agentforce</label></PresenceUserConfig>',
      );

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('PresenceUserConfig:agentforce');

      const edges = walked.results.flatMap((r) => r.edges);
      expect(edges).toContainEqual(
        expect.objectContaining({
          fromId: 'PresenceUserConfig:agentforce',
          toId: 'Profile:einstein agent user',
          edgeType: 'references',
        }),
      );
      const node = walked.results.flatMap((r) => r.nodes).find((n) => n.id === 'PresenceUserConfig:agentforce');
      expect(node?.properties['assignedUsernames']).toEqual(['agentuser@example.invalid']);

      expect(walked.skippedDirectories.presenceUserConfigs).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dispatches the Experience Cloud community family (Network / CustomSite / ExperienceBundle) and suppresses the bundle page tree (R6-17)', async () => {
    const root = await makeTempRoot();
    try {
      // Network (networks/) is the anchor; CustomSite (sites/) and
      // ExperienceBundle (experiences/{Name}.site-meta.xml) share the
      // `.site-meta.xml` suffix but are told apart by directory. The bundle's
      // JSON page tree under experiences/{Name}/... is OUT OF SCOPE and must
      // NOT inflate the skip-counter. All names synthetic.
      await writeAt(
        root,
        'networks/MemberPortal.network-meta.xml',
        '<?xml version="1.0"?><Network xmlns="http://soap.sforce.com/2006/04/metadata"><status>Live</status><selfRegistration>false</selfRegistration><site>MemberPortal</site><picassoSite>MemberPortal1</picassoSite></Network>',
      );
      await writeAt(
        root,
        'sites/MemberPortal.site-meta.xml',
        '<?xml version="1.0"?><CustomSite xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><masterLabel>MemberPortal</masterLabel><siteType>ChatterNetwork</siteType></CustomSite>',
      );
      await writeAt(
        root,
        'experiences/MemberPortal1.site-meta.xml',
        '<?xml version="1.0"?><ExperienceBundle xmlns="http://soap.sforce.com/2006/04/metadata"><label>Member Portal</label><type>ChatterNetworkPicasso</type></ExperienceBundle>',
      );
      // The (out-of-scope) page tree — must be suppressed from the skip-counter.
      await writeAt(root, 'experiences/MemberPortal1/views/home.json', '{}');
      await writeAt(root, 'experiences/MemberPortal1/routes/home.json', '{}');
      await writeAt(root, 'experiences/MemberPortal1/config/main.json', '{}');

      const walked = await walkAndExtract(root, null);
      const ids = walked.results.flatMap((r) => r.nodes.map((n) => n.id));
      expect(ids).toContain('Network:MemberPortal');
      expect(ids).toContain('CustomSite:MemberPortal');
      expect(ids).toContain('ExperienceBundle:MemberPortal1');
      // The bundle's JSON page tree is covered-by-design (not a coverage gap).
      expect(walked.skippedDirectories.experiences).toBeUndefined();
      expect(walked.skippedDirectories.views).toBeUndefined();
      expect(walked.skippedDirectories.routes).toBeUndefined();
      expect(walked.skippedDirectories.config).toBeUndefined();
      // The heuristic guest-profile linkage edge is emitted from the CustomSite.
      const edges = walked.results.flatMap((r) => r.edges);
      const guestEdge = edges.find(
        (e) => e.fromId === 'CustomSite:MemberPortal' && e.toId === 'Profile:MemberPortal Profile',
      );
      expect(guestEdge).toBeDefined();
      expect(guestEdge!.confidence).toBe('heuristic');
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
