/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import { appendAnnotationEvent, readAnnotations } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import {
  annotationsHandler,
  proposeAnnotationHandler,
  PROPOSE_SESSION_CAP,
  resetProposalSessionCap,
} from '../../src/tools/annotations.js';

/**
 * P13-ANNOT-tools — sfi.annotations (read) + sfi.propose_annotation
 * (AI proposal: ALWAYS source:'ai' confirmed:false; session rate-cap).
 */

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-10T00:00:00.000Z',
  sourceOrg: 'test',
  components: { ApexClass: 1 },
  edges: {},
  sourceTreeHash: 'sha256:annotations-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: overrides.id.slice(overrides.id.indexOf(':') + 1),
  label: null,
  parentId: null,
  sourcePath: 'src',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-annotations-'));
  const opened = await openGraph(join(tempDir, 'a.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const seed: ExtractionResult = {
    nodes: [makeNode({ id: 'ApexClass:Alpha', type: 'ApexClass' })],
    edges: [],
  };
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetProposalSessionCap();
  rmSync(join(tempDir, 'meta', 'annotations.jsonl'), { force: true });
});

describe('sfi.annotations (read)', () => {
  it('empty overlay reads as zero annotations with the disclosure', async () => {
    const r = await annotationsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.annotations).toEqual([]);
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.disclosure).toContain('CURATED');
  });

  it('scopes by componentId and key; counts unconfirmed AI proposals', async () => {
    const at = '2026-06-10T01:00:00.000Z';
    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha', key: 'owner', value: 'Platform',
      author: 'pranav', source: 'human', confirmed: true, at, op: 'set',
    });
    await appendAnnotationEvent(tempDir, {
      componentId: 'ApexClass:Alpha', key: 'status', value: 'deprecated',
      author: 'ai', source: 'ai', confirmed: false, at, op: 'set',
    });
    await appendAnnotationEvent(tempDir, {
      componentId: 'CustomObject:Other', key: 'note', value: 'x',
      author: 'pranav', source: 'human', confirmed: true, at, op: 'set',
    });
    const scoped = await annotationsHandler(ctx, { componentId: 'ApexClass:Alpha' });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.value.data.totalCount).toBe(2);
    expect(scoped.value.data.unconfirmedProposals).toBe(1);
    const keyed = await annotationsHandler(ctx, { componentId: 'ApexClass:Alpha', key: 'status' });
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    expect(keyed.value.data.annotations.map((a) => a.value)).toEqual(['deprecated']);
  });
});

describe('sfi.propose_annotation', () => {
  it('writes ALWAYS as source:ai confirmed:false; reports componentExists', async () => {
    const r = await proposeAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'status',
      value: 'deprecated',
      rationale: 'user said so',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.proposal.source).toBe('ai');
    expect(r.value.data.proposal.confirmed).toBe(false);
    expect(r.value.data.componentExists).toBe(true);
    expect(r.value.data.confirmHint).toContain('sfi annotate');
    const stored = await readAnnotations(tempDir);
    expect(stored[0]?.source).toBe('ai');
    expect(stored[0]?.confirmed).toBe(false);
    expect(stored[0]?.author).toContain('user said so');

    const phantom = await proposeAnnotationHandler(ctx, {
      componentId: 'CustomObject:NotInGraph__c',
      key: 'note',
      value: 'proposal on a phantom is allowed but flagged',
    });
    expect(phantom.ok).toBe(true);
    if (!phantom.ok) return;
    expect(phantom.value.data.componentExists).toBe(false);
  });

  it('enforces the session rate-cap with an actionable error', async () => {
    for (let i = 0; i < PROPOSE_SESSION_CAP; i += 1) {
      const r = await proposeAnnotationHandler(ctx, {
        componentId: 'ApexClass:Alpha',
        key: 'note',
        value: `proposal ${i}`,
      });
      expect(r.ok).toBe(true);
    }
    const over = await proposeAnnotationHandler(ctx, {
      componentId: 'ApexClass:Alpha',
      key: 'note',
      value: 'one too many',
    });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error.message).toContain('session cap');
    expect(over.error.message).toContain('sfi annotate');
  });
});
