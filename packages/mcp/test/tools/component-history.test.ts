/// <reference types="vitest/globals" />

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  componentAsOfHandler,
  componentHistoryHandler,
} from '../../src/tools/component-history.js';

/**
 * P13-GITHIST-tools — fixture repo ×3 commits: history timeline, capped
 * diff, properties-as-of via the REAL extractor on historical bytes, and
 * the non-git `available:false` + hint path.
 */

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const CLS_REL = 'source/main/default/classes/Alpha.cls';

const clsBody = (version: string): string =>
  `public class Alpha {\n  // ${version}\n  public void go() {}\n}\n`;

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-10T00:00:00.000Z',
  sourceOrg: 'test',
  components: { ApexClass: 1 },
  edges: {},
  sourceTreeHash: 'sha256:githist-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: overrides.id.slice(overrides.id.indexOf(':') + 1),
  label: null,
  parentId: null,
  sourcePath: CLS_REL,
  lastModifiedDate: '2026-06-01T00:00:00.000Z',
  lastModifiedBy: 'Org Admin',
  apiVersion: null,
  properties: {},
  ...overrides,
});

let vaultRoot: string;
let store: GraphStore;
let ctx: Context;
const hashes: string[] = [];

beforeAll(async () => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'sfi-githist-tools-'));
  // fixture repo: 3 commits of the same class
  git(vaultRoot, 'init');
  git(vaultRoot, 'config', 'user.email', 'test@example.com');
  git(vaultRoot, 'config', 'user.name', 'Test');
  mkdirSync(join(vaultRoot, 'source/main/default/classes'), { recursive: true });
  for (const v of ['v1', 'v2', 'v3']) {
    writeFileSync(join(vaultRoot, CLS_REL), clsBody(v), 'utf8');
    writeFileSync(
      join(vaultRoot, `${CLS_REL}-meta.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>6${v.slice(1)}.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
      'utf8',
    );
    git(vaultRoot, 'add', '-A', '.');
    git(vaultRoot, 'commit', '--no-gpg-sign', '-m', `refresh — ${v}`);
    hashes.push(git(vaultRoot, 'rev-parse', 'HEAD').trim());
  }

  const opened = await openGraph(join(vaultRoot, 'graph.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const seed: ExtractionResult = {
    nodes: [makeNode({ id: 'ApexClass:Alpha', type: 'ApexClass' })],
    edges: [],
  };
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('sfi.component_history', () => {
  it('returns the 3-commit timeline newest-first with merged metadata stamps', async () => {
    const r = await componentHistoryHandler(ctx, { componentId: 'ApexClass:Alpha' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.entries.length).toBe(3);
    expect(r.value.data.entries[0]?.hash).toBe(hashes[2]);
    expect(r.value.data.entries[2]?.hash).toBe(hashes[0]);
    expect(r.value.data.entries[0]?.subject).toContain('v3');
    expect(r.value.data.metadataLastModified.lastModifiedBy).toBe('Org Admin');
  });

  it('includeLatestDiff returns a capped unified diff of the newest change', async () => {
    const r = await componentHistoryHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      includeLatestDiff: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.latestDiff).toContain('-  // v2');
    expect(r.value.data.latestDiff).toContain('+  // v3');
    expect(r.value.data.latestDiffTruncated).toBe(false);
  });

  it('limit narrows the timeline', async () => {
    const r = await componentHistoryHandler(ctx, { componentId: 'ApexClass:Alpha', limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entries.length).toBe(1);
    expect(r.value.data.entries[0]?.hash).toBe(hashes[2]);
  });
});

describe('sfi.component_as_of', () => {
  it('re-runs the REAL extractor on historical bytes — properties-as-of v1', async () => {
    const r = await componentAsOfHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      ref: hashes[0] ?? 'HEAD~2',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(true);
    expect(r.value.data.extracted).toBe(true);
    expect(r.value.data.properties?.['apiName']).toBe('Alpha');
  });

  it('an unknown ref fails structured with a history-coverage hint', async () => {
    const r = await componentAsOfHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      ref: 'deadbeef',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('predate');
  });

  it('rejects a hostile ref string', async () => {
    const r = await componentAsOfHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      ref: '$(rm -rf /)',
    });
    expect(r.ok).toBe(false);
  });
});

describe('non-git vault honesty', () => {
  let bareRoot: string;
  let bareStore: GraphStore;
  let bareCtx: Context;

  beforeAll(async () => {
    bareRoot = mkdtempSync(join(tmpdir(), 'sfi-githist-bare-'));
    const opened = await openGraph(join(bareRoot, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    bareStore = opened.value;
    const imp = await importExtractionResults(bareStore, [
      { nodes: [makeNode({ id: 'ApexClass:Alpha', type: 'ApexClass' })], edges: [] },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    bareCtx = { vaultRoot: bareRoot, manifest: FIXTURE_MANIFEST, graph: bareStore };
  });

  afterAll(async () => {
    await closeGraph(bareStore);
    rmSync(bareRoot, { recursive: true, force: true });
  });

  it('history → available:false + enable hint (never an error)', async () => {
    const r = await componentHistoryHandler(bareCtx, { componentId: 'ApexClass:Alpha' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(false);
    expect(r.value.data.remedy).toContain('sfi vault git enable');
  });

  it('as_of → available:false + enable hint', async () => {
    const r = await componentAsOfHandler(bareCtx, { componentId: 'ApexClass:Alpha', ref: 'HEAD' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.available).toBe(false);
    expect(r.value.data.remedy).toContain('sfi vault git enable');
  });
});
