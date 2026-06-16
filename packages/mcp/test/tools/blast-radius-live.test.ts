/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import type { Context } from '../../src/server.js';
import { blastRadiusLiveHandler } from '../../src/tools/blast-radius-live.js';
import { STALE_CHECK_TYPES } from '../../src/tools/live-plane.js';
import { resetLiveSession } from '../../src/tools/live-session.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 2, ValidationRule: 1 },
  edges: { parentOf: 2, references: 2 },
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>): Edge => ({
  edgeType: 'references',
  confidence: 'parsed',
  source: 'x',
  properties: {},
  ...o,
});

// Root = CustomField:Account.Industry__c. Impact (hops 1, incoming):
//   Account (parentOf) — CustomObject, countable (total rows)
//   IndustryVR (references) — ValidationRule, NOT countable
//   Segment__c (references) — CustomField, countable (non-null rows)
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Account', apiName: 'Account' }),
    node({ id: 'CustomField:Account.Industry__c', type: 'CustomField', apiName: 'Industry__c', parentId: 'CustomObject:Account' }),
    node({ id: 'CustomField:Account.Segment__c', type: 'CustomField', apiName: 'Segment__c', parentId: 'CustomObject:Account' }),
    node({ id: 'ValidationRule:Account.IndustryVR', type: 'ValidationRule', apiName: 'IndustryVR', parentId: 'CustomObject:Account' }),
  ],
  edges: [
    edge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Industry__c', edgeType: 'parentOf', confidence: 'declared' }),
    edge({ fromId: 'ValidationRule:Account.IndustryVR', toId: 'CustomField:Account.Industry__c', edgeType: 'references' }),
    edge({ fromId: 'CustomField:Account.Segment__c', toId: 'CustomField:Account.Industry__c', edgeType: 'references' }),
  ],
};

/** Mock `sf`: staleness Tooling queries return `staleCount`; COUNT() queries a fixed map. */
const makeExec = (staleCount = 0): { exec: ExecCommand; soqls: () => string[] } => {
  const soqls: string[] = [];
  const exec: ExecCommand = async (_bin, args) => {
    const soql = String(args[args.indexOf('--query') + 1] ?? '');
    soqls.push(soql);
    if (args.includes('--use-tooling-api')) {
      return { stdout: JSON.stringify({ result: { totalSize: staleCount } }), stderr: '' };
    }
    let count = 0;
    if (soql.includes('Industry__c != null')) count = 847;
    else if (soql.includes('Segment__c != null')) count = 300;
    else if (soql === 'SELECT COUNT() FROM Account') count = 1000;
    return { stdout: JSON.stringify({ result: { totalSize: count } }), stderr: '' };
  };
  return { exec, soqls: () => soqls };
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;
let consentDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-blast-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error('openGraph failed');
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error('seed import failed');
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetLiveSession();
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-blast-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'consent.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  delete process.env.SFI_BLAST_RADIUS_MAX_LIVE;
});

afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  rmSync(consentDir, { recursive: true, force: true });
});

const ROOT = 'CustomField:Account.Industry__c';

describe('blastRadiusLiveHandler (P6-blast-radius-live)', () => {
  it('without consent returns the static impact with a caveat — never blocked on live', async () => {
    const { exec, soqls } = makeExec();
    const r = await blastRadiusLiveHandler(ctx, { componentId: ROOT, hops: 1 }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.consentPresent).toBe(false);
    expect(d.trust.provenance).toBe('offline_snapshot');
    expect(d.rootAffectedRecords).toBeNull();
    expect(d.staticImpact.nodeCount).toBeGreaterThanOrEqual(4);
    expect(d.dependencies.every((dep) => dep.liveAffectedRecords === null)).toBe(true);
    // No org call was made.
    expect(soqls()).toHaveLength(0);
  });

  it('with consent fuses a live affected-record count per record-bearing dependency', async () => {
    const { exec } = makeExec();
    const r = await blastRadiusLiveHandler(ctx, { componentId: ROOT, hops: 1, liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.consentPresent).toBe(true);
    expect(d.trust.provenance).toBe('hybrid');
    expect(d.trust.freshness.snapshotRefreshedAt).toBe(MANIFEST.refreshedAt);
    expect(d.trust.freshness.liveQueriedAt).toBeDefined();
    // Headline: non-null records on the changed field.
    expect(d.rootAffectedRecords).toBe(847);
    const byId = Object.fromEntries(d.dependencies.map((x) => [x.componentId, x]));
    expect(byId['CustomObject:Account']?.liveAffectedRecords).toBe(1000);
    expect(byId['CustomField:Account.Segment__c']?.liveAffectedRecords).toBe(300);
    // A validation rule breaks but carries no record count.
    expect(byId['ValidationRule:Account.IndustryVR']?.liveAffectedRecords).toBeNull();
    expect(d.countedDependencies).toBe(2);
  });

  it('leads with a vault-staleness warning when the org is ahead', async () => {
    const { exec } = makeExec(5); // 5 per type × 6 checked types = 30 drift
    const r = await blastRadiusLiveHandler(ctx, { componentId: ROOT, hops: 1, liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.staleness?.vaultStale).toBe(true);
    expect(d.staleness?.driftCount).toBe(5 * STALE_CHECK_TYPES.length); // 5 per checked type
    expect(d.disclosure).toContain('STALE');
  });

  it('respects the per-call live-count cap and marks the answer partial', async () => {
    const { exec } = makeExec();
    const r = await blastRadiusLiveHandler(
      ctx,
      { componentId: ROOT, hops: 1, liveEnabled: true, maxLiveCounts: 1 },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.countedDependencies).toBe(1);
    expect(r.value.data.partial).toBe(true);
  });
});
