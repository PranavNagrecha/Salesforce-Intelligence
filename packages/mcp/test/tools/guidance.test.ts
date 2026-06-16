/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import { KNOWLEDGE_TOPICS } from '../../src/knowledge-topics.js';
import type { Context } from '../../src/server.js';
import { guidanceHandler } from '../../src/tools/guidance.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:guidance-fixture',
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  // guidance never queries the graph (only ctx.manifest), but Context requires
  // a live GraphStore — open a throwaway one.
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-guidance-'));
  const opened = await openGraph(join(tempDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('guidanceHandler', () => {
  it('returns the curated topic for a known key', async () => {
    const r = await guidanceHandler(ctx, { topic: 'flow-vs-apex' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.matched).toBe(true);
    expect(d.topic).toBe('flow-vs-apex');
    expect(d.guidance?.title.toLowerCase()).toContain('apex');
    expect(d.guidance?.docs.length ?? 0).toBeGreaterThan(0);
  });

  it('loose-matches a phrase to a topic', async () => {
    const r = await guidanceHandler(ctx, { topic: 'governor limits' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matched).toBe(true);
    expect(r.value.data.topic).toBe('governor-limits');
  });

  it('lists all topics when no topic is supplied', async () => {
    const r = await guidanceHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.matched).toBe(false);
    expect(d.guidance).toBeNull();
    expect(d.topic).toBeNull();
    expect(d.availableTopics.length).toBe(Object.keys(KNOWLEDGE_TOPICS).length);
  });

  it('flags an unknown topic without fabricating', async () => {
    const r = await guidanceHandler(ctx, { topic: 'how-to-mine-bitcoin' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.matched).toBe(false);
    expect(r.value.data.guidance).toBeNull();
    expect(r.value.data.availableTopics.length).toBeGreaterThan(0);
  });

  it('is honest that guidance is not org-specific', async () => {
    const r = await guidanceHandler(ctx, { topic: 'owd-sharing-model' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure.toLowerCase()).toContain('not specific to this org');
  });

  it('every topic has a title, a substantive summary, and official https doc links', () => {
    for (const t of Object.values(KNOWLEDGE_TOPICS)) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.summary.length).toBeGreaterThan(40);
      expect(t.docs.length).toBeGreaterThan(0);
      for (const doc of t.docs) {
        expect(doc.url.startsWith('https://')).toBe(true);
        expect(doc.url).toMatch(/salesforce\.com/);
      }
    }
  });
});
