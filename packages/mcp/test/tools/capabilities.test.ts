/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import { classifyQuestion } from '../../src/intent-router.js';
import type { Context } from '../../src/server.js';
import {
  capabilitiesHandler,
  capabilitiesInputSchema,
} from '../../src/tools/capabilities.js';
import { V01_TOOLS } from '../../src/tools/index.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:capabilities-fixture',
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  // The handler never queries the graph (it only reads ctx.manifest), but
  // Context requires a live GraphStore — open a throwaway one.
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-capabilities-'));
  const opened = await openGraph(join(tempDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('capabilitiesHandler', () => {
  it('reports the LIVE tool count (matches the dispatcher registry)', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Derived dynamically so it can never drift from the real registry.
    expect(r.value.data.toolCount).toBe(V01_TOOLS.length);
    expect(r.value.data.toolCount).toBeGreaterThan(50);
  });

  it('every tool referenced in a category actually exists in the registry', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const registered = new Set(V01_TOOLS.map((t) => t.name));
    const referenced = r.value.data.categories.flatMap((c) => c.tools);
    const missing = referenced.filter((name) => !registered.has(name));
    // A curated category must never point at a tool that isn't registered.
    expect(missing).toEqual([]);
  });

  it('each category is well-formed (title, description, examples, tools)', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.categories.length).toBeGreaterThanOrEqual(6);
    for (const c of r.value.data.categories) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.exampleQuestions.length).toBeGreaterThan(0);
      expect(c.tools.length).toBeGreaterThan(0);
    }
  });

  it('exposes the admin / developer / architect / release-manager / support personas (P12-UX-capabilities-personas)', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.personas.map((p) => p.id).sort();
    expect(ids).toEqual(['admin', 'architect', 'developer', 'release-manager', 'support']);
  });

  it('every persona categoryId references a real category + every question path is a real tool (no drift)', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const categoryIds = new Set(r.value.data.categories.map((c) => c.id));
    const registered = new Set(V01_TOOLS.map((t) => t.name));
    for (const p of r.value.data.personas) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.questionPaths.length).toBeGreaterThan(0);
      expect(p.categoryIds.length).toBeGreaterThan(0);
      const bad = p.categoryIds.filter((id) => !categoryIds.has(id));
      expect(bad).toEqual([]); // persona must not point at a non-existent category
      for (const path of p.questionPaths) {
        expect(path.question.length).toBeGreaterThan(0);
        expect(path.tools.length).toBeGreaterThan(0);
        // Every tool in a published question path must be a real registered tool.
        const deadTools = path.tools.filter((t) => !registered.has(t));
        expect(deadTools).toEqual([]);
      }
    }
  });

  it('every published question path actually routes into its own tool list (P12-UX-capabilities-router-contract)', async () => {
    // A persona path advertises "ask THIS, the answer comes from THESE tools".
    // If `route_question` sends the advertised question somewhere outside the
    // path, the published path is a lie. Assert the router routes each question
    // to a non-prelude tool that appears in the path (overlap — multi-tool
    // intents have a fixed primary, so exact-primary equality is too strict).
    const PRELUDE = new Set(['sfi.resolve', 'sfi.route_question']);
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const offenders: string[] = [];
    for (const p of r.value.data.personas) {
      for (const path of p.questionPaths) {
        const route = classifyQuestion(path.question);
        const routedAnswerTools = route.tools.filter((t) => !PRELUDE.has(t));
        const pathAnswerTools = new Set(path.tools.filter((t) => !PRELUDE.has(t)));
        const overlaps = routedAnswerTools.some((t) => pathAnswerTools.has(t));
        if (!overlaps) {
          offenders.push(
            `[${p.id}] "${path.question}" routed to ${route.intent} ${JSON.stringify(route.tools)} — none in path ${JSON.stringify([...pathAnswerTools])}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('surfaces the resolve-first conversational guidance', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.value.data.conversationalGuidance;
    // The headline pattern: resolve first, ask on ambiguous, refresh/stop on none.
    expect(g.startHere.toLowerCase()).toContain('sfi.resolve');
    expect(g.onAmbiguous.toLowerCase()).toContain('clarif');
    expect(g.onNone).toContain('/sfi-refresh');
    // SYNTH-01 — the grounding step: tools -> synthesize_answer -> prose, no orphan ids.
    expect(g.groundAnswer).toContain('sfi.synthesize_answer');
    expect(g.groundAnswer).toContain('hallucinatedIds');
    expect(r.value.data.routingGuidance.groundAnswer).toContain(
      'sfi.synthesize_answer',
    );
  });

  it('trustGlossary keys are the verbatim runtime trust tags (P3-confidence-glossary)', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.value.data.trustGlossary;
    // The glossary is keyed by the EXACT values a host sees on a tool's trust
    // block, so it can never drift from the tags the tools actually emit.
    expect(Object.keys(g.confidence).sort()).toEqual([
      'declared',
      'heuristic',
      'parsed',
    ]);
    expect(Object.keys(g.provenance).sort()).toEqual([
      'hybrid',
      'live_org',
      'offline_snapshot',
    ]);
    expect(Object.keys(g.completeness).sort()).toEqual([
      'complete',
      'partial',
      'unknown',
    ]);
    for (const section of [g.confidence, g.provenance, g.completeness]) {
      for (const def of Object.values(section)) {
        expect(typeof def).toBe('string');
        expect(def.length).toBeGreaterThan(0);
      }
    }
  });

  it('lists the three slash commands including /sfi-refresh', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cmds = r.value.data.commands.map((c) => c.command);
    expect(cmds).toContain('/sfi-init');
    expect(cmds).toContain('/sfi-refresh');
    expect(cmds).toContain('/sfi-status');
    expect(r.value.data.commandCount).toBe(r.value.data.commands.length);
  });

  it('surfaces intelligence planes and hybrid routing guidance', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.intelligencePlanes.length).toBe(3);
    expect(r.value.data.intelligencePlanes.find((p) => p.id === 'offline')?.default).toBe(
      true,
    );
    expect(r.value.data.routingGuidance.startHere).toContain('sfi.live_');
    const registered = new Set(V01_TOOLS.map((t) => t.name));
    const planeTools = r.value.data.intelligencePlanes.flatMap((p) => p.tools);
    expect(planeTools.every((name) => registered.has(name))).toBe(true);
  });

  it('surfaces the read-only honesty boundary', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
    expect(r.value.data.disclosure.length).toBeGreaterThan(0);
    expect(
      r.value.data.boundaries.some((b) => /read-only/i.test(b)),
    ).toBe(true);
    expect(
      r.value.data.boundaries.some((b) => /offline by default/i.test(b)),
    ).toBe(true);
  });

  it('copies vault state into the envelope', async () => {
    const r = await capabilitiesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vaultState.sourceTreeHash).toBe('sha256:capabilities-fixture');
  });

  it('is deterministic across two calls', async () => {
    const a = await capabilitiesHandler(ctx, {});
    const b = await capabilitiesHandler(ctx, {});
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('capabilitiesInputSchema', () => {
  it('accepts an empty object', () => {
    expect(capabilitiesInputSchema.safeParse({}).success).toBe(true);
  });
});
