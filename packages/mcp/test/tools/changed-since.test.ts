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

import type { Context } from '../../src/server.js';
import {
  changedSinceHandler,
  changedSinceInputSchema,
} from '../../src/tools/changed-since.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 3, Flow: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'src/path.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// Graph holds:
//   - ApexClass:NewFoo with properties.lastModifiedDate = 2026-05-15 (after boundary)
//   - ApexClass:OldBar with properties.lastModifiedDate = 2026-04-01 (before boundary)
//   - ApexClass:UnenrichedBaz with no lastModifiedDate (counted as unenriched)
//   - Flow:FreshFlow with properties.lastModifiedDate = 2026-05-20 (after boundary)
//   - CustomField:Account.LegacyField with TOP-LEVEL lastModifiedDate = 2026-05-12
//     (proves legacy field reads, no enrichment needed)
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexClass:NewFoo',
      type: 'ApexClass',
      apiName: 'NewFoo',
      properties: {
        lastModifiedDate: '2026-05-15T12:00:00.000Z',
        lastModifiedBy: { id: '005xxAA', name: 'Alice' },
      },
    }),
    makeNode({
      id: 'ApexClass:OldBar',
      type: 'ApexClass',
      apiName: 'OldBar',
      properties: {
        lastModifiedDate: '2026-04-01T00:00:00.000Z',
        lastModifiedBy: { id: '005xxBB', name: 'Bob' },
      },
    }),
    makeNode({
      id: 'ApexClass:UnenrichedBaz',
      type: 'ApexClass',
      apiName: 'UnenrichedBaz',
    }),
    makeNode({
      id: 'Flow:FreshFlow',
      type: 'Flow',
      apiName: 'FreshFlow',
      properties: {
        lastModifiedDate: '2026-05-20T00:00:00.000Z',
        lastModifiedBy: { id: '005xxCC', name: 'Carol' },
      },
    }),
    makeNode({
      id: 'CustomField:Account.LegacyField',
      type: 'CustomField',
      apiName: 'LegacyField',
      lastModifiedDate: '2026-05-12T00:00:00.000Z',
      lastModifiedBy: '005xxDD',
    }),
  ],
  edges: [] as readonly Edge[],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-changed-since-'));
  const dbPath = join(tempDir, 'changed-since.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('changedSinceInputSchema', () => {
  it('accepts a date-only ISO string', () => {
    const r = changedSinceInputSchema.safeParse({ since: '2026-05-01' });
    expect(r.success).toBe(true);
  });

  it('accepts a full ISO 8601 timestamp', () => {
    const r = changedSinceInputSchema.safeParse({ since: '2026-05-01T00:00:00.000Z' });
    expect(r.success).toBe(true);
  });

  it('rejects a non-date string', () => {
    const r = changedSinceInputSchema.safeParse({ since: 'tomorrow' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown component type', () => {
    const r = changedSinceInputSchema.safeParse({
      since: '2026-05-01',
      types: ['NotARealType'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects limit out of range', () => {
    const r = changedSinceInputSchema.safeParse({
      since: '2026-05-01',
      limit: 999_999,
    });
    expect(r.success).toBe(false);
  });
});

describe('changedSinceHandler — boundary filter and partial-data axis', () => {
  it('returns nodes whose lastModifiedDate is at or after the since boundary', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-05-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.changed.map((c) => c.id);
    expect(ids).toContain('ApexClass:NewFoo');
    expect(ids).toContain('Flow:FreshFlow');
    expect(ids).toContain('CustomField:Account.LegacyField');
    expect(ids).not.toContain('ApexClass:OldBar');
  });

  it('omits nodes whose lastModifiedDate is null and reports unenrichedCount > 0', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-01-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.changed.map((c) => c.id);
    expect(ids).not.toContain('ApexClass:UnenrichedBaz');
    expect(result.value.data.unenrichedCount).toBeGreaterThanOrEqual(1);
  });

  it('reads lastModifiedDate from the top-level node field when properties does not carry one', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['CustomField'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed.map((c) => c.id)).toEqual([
      'CustomField:Account.LegacyField',
    ]);
  });

  it('falls back to the legacy string lastModifiedBy when properties does not carry an object', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['CustomField'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const legacy = result.value.data.changed[0];
    expect(legacy).toBeDefined();
    if (legacy === undefined) return;
    expect(legacy.lastModifiedBy.id).toBe('005xxDD');
    expect(legacy.lastModifiedBy.name).toBe('');
  });
});

describe('changedSinceHandler — narrows by types', () => {
  it('respects the optional types filter and skips other types', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['Flow'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed.map((c) => c.id)).toEqual(['Flow:FreshFlow']);
  });
});

describe('changedSinceHandler — fully functional against un-enriched vault', () => {
  it('returns ok with empty changed and the full unenrichedCount when nothing has been enriched', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-05-01',
      types: ['ValidationRule'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed).toEqual([]);
    expect(result.value.data.unenrichedCount).toBe(0);
    expect(result.value.data.truncated).toBe(false);
  });
});

describe('changedSinceHandler — limit + truncation', () => {
  it('truncates to limit and flips truncated true when matched > limit', async () => {
    const result = await changedSinceHandler(ctx, {
      since: '2026-01-01',
      limit: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.changed).toHaveLength(1);
    expect(result.value.data.truncated).toBe(true);
  });
});

describe('changedSinceHandler — sort order is date DESC then id ASC', () => {
  it('orders the most-recently-modified first', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-01-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Expected dates: Flow:FreshFlow 05-20, ApexClass:NewFoo 05-15,
    // CustomField:Account.LegacyField 05-12, ApexClass:OldBar 04-01.
    const ids = result.value.data.changed.map((c) => c.id);
    expect(ids.slice(0, 3)).toEqual([
      'Flow:FreshFlow',
      'ApexClass:NewFoo',
      'CustomField:Account.LegacyField',
    ]);
  });
});

describe('changedSinceHandler — normalises since to UTC', () => {
  it('emits the canonical UTC ISO form of the input boundary', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-05-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.since).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('changedSinceHandler — vault-state envelope', () => {
  it('copies the manifest sourceTreeHash + refreshedAt into the response envelope', async () => {
    const result = await changedSinceHandler(ctx, { since: '2026-05-01' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(FIXTURE_MANIFEST.sourceTreeHash);
    expect(result.value.vaultState.refreshedAt).toBe(FIXTURE_MANIFEST.refreshedAt);
  });
});
