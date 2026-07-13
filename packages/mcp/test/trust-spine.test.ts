/// <reference types="vitest/globals" />
/**
 * R1–R3 trust spine: Report field usage must block safe_to_delete_field.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
  ExtractionResult,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExtendedVaultManifest } from '@sf-intelligence/vault';

import { mintLiveCapability } from '../src/live-capability.js';
import type { Context } from '../src/server.js';
import { coverageReportHandler } from '../src/tools/coverage-report.js';
import { safeToDeleteFieldHandler } from '../src/tools/safe-to-delete-field.js';

const completeCoverage = (): readonly CoverageEntry[] =>
  [
    'CustomField',
    'ValidationRule',
    'Flow',
    'ApexClass',
    'ApexTrigger',
    'Layout',
    'LightningComponentBundle',
    'AuraDefinitionBundle',
    'VisualforcePage',
    'VisualforceComponent',
    'QuickAction',
    'WorkflowRule',
    'SharingRule',
    'Report',
    'Dashboard',
    'ListView',
    'ReportType',
    'FlexiPage',
  ].map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
  }));

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00.000Z',
  sourceOrg: 'trust-spine',
  components: { CustomObject: 1, CustomField: 1, Report: 1 },
  edges: { references: 1 },
  sourceTreeHash: 'sha256:trust-spine',
  coverageComputedAt: '2026-05-29T00:00:00.000Z',
  coverage: completeCoverage(),
};

const FIELD = 'CustomField:Account.Industry__c';
const REPORT = 'Report:Account_Usage';

const seed: ExtractionResult = {
  nodes: [
    {
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      parentId: null,
      sourcePath: 'objects/Account/Account.object-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    },
    {
      id: FIELD,
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    },
    {
      id: REPORT,
      type: 'Report',
      apiName: 'Account_Usage',
      label: 'Account Usage',
      parentId: null,
      sourcePath: 'reports/Account_Usage.report-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    },
  ],
  edges: [
    {
      fromId: REPORT,
      toId: FIELD,
      edgeType: 'references',
      confidence: 'declared',
      source: 'trust-spine-test',
      properties: {},
    },
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-trust-spine-'));
  const opened = await openGraph(join(tempDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store, liveCapability: mintLiveCapability('opt-in')};
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('trust spine (R1–R3)', () => {
  it('coverage_report reports known coverage', async () => {
    const r = await coverageReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageKnown).toBe(true);
  });

  it('safe_to_delete_field is blocking when a Report references the field', async () => {
    const r = await safeToDeleteFieldHandler(ctx, { fieldId: FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.verdict).toBe('blocking');
    expect(r.value.data.reasoning.some((x) => x.category === 'analytics')).toBe(true);
  });
});

describe('trust spine — ListView coverage gap', () => {
  const FIELD_LV = 'CustomField:Account.Segment__c';

  const listViewNeverModeledManifest = (): ExtendedVaultManifest => ({
    ...MANIFEST,
    skippedDirectories: { listViews: 3 },
    coverage: [
      ...completeCoverage().filter((e) => e.type !== 'ListView'),
      {
        type: 'ListView',
        requested: true,
        retrieved: 3,
        errored: false,
        neverModeled: true,
      },
    ],
  });

  it('downgrades safe to review when ListView is neverModeled in coverage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-trust-listview-'));
    const opened = await openGraph(join(dir, 'graph.duckdb'));
    if (!opened.ok) throw new Error(opened.error.message);
    const localStore = opened.value;
    const seedLv: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomObject:Account',
          type: 'CustomObject',
          apiName: 'Account',
        }),
        makeNode({
          id: FIELD_LV,
          type: 'CustomField',
          apiName: 'Segment__c',
          parentId: 'CustomObject:Account',
        }),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(localStore, [seedLv]);
    if (!imported.ok) throw new Error(imported.error.message);
    const localCtx: Context = {
      vaultRoot: dir,
      manifest: listViewNeverModeledManifest(),
      graph: localStore,
      liveCapability: mintLiveCapability('opt-in'),
    };
    const r = await safeToDeleteFieldHandler(localCtx, { fieldId: FIELD_LV });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain('ListView');
    expect(r.value.data.verdict).toBe('review');
    await closeGraph(localStore);
    rmSync(dir, { recursive: true, force: true });
  });
});

const makeNode = (
  overrides: Partial<ExtractionResult['nodes'][number]> &
    Pick<ExtractionResult['nodes'][number], 'id'>,
): ExtractionResult['nodes'][number] => ({
  type: 'ApexClass',
  apiName: 'Test',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});
