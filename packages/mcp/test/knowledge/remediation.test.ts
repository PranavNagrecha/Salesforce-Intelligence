/// <reference types="vitest/globals" />

/**
 * CITED-REMEDIATION — end-to-end tests for authored, dependency-ordered
 * remediation on concept RULES:
 *   1. a fired rule WITH authored remediation → `interpret` emits a
 *      {@link Remediation} whose `groundedIn` + `confidence` MATCH the claim, with
 *      each step filled from the claim's grounded ids;
 *   2. `synthesize_answer` renders that remediation into its FIX / NEXT slots
 *      (`evidence.recommendedFix` / `evidence.nextAction`), attributed + hedged;
 *   3. a fired rule WITHOUT remediation → NO fabricated fix, and the absence is
 *      DISCLOSED (never invented);
 *   4. REFUSE-CLOSURE — the remediation is fix STEPS only; the claim is never
 *      auto-cleared and no "the risk is now gone" language is emitted.
 *
 * Everything synthetic uses `Ns__…`-style ids — no real graph, no real org.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConceptRule, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import { CONCEPT_RULES } from '../../src/knowledge/loader.js';
import { interpret, type Coverage, type GroundedSlice } from '../../src/knowledge/reason.js';
import type { Context } from '../../src/server.js';
import { synthesizeAnswerHandler } from '../../src/tools/synthesize-answer.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures — no real org data.
// ---------------------------------------------------------------------------

const node = (
  id: string,
  type: Node['type'],
  properties: Record<string, unknown> = {},
): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `synthetic/${id}`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const COMPLETE: Coverage = { status: 'complete', caveat: null };

const CLASS_ID = 'ApexClass:Ns__Service';

/** A node-shaped rule that fires on a `without sharing` ApexClass, WITH remediation. */
const REMEDIATED_RULE: ConceptRule = {
  id: 'rule:test/remediated',
  concept: 'concept:apex-sharing-mode',
  bind: {
    componentTypes: ['ApexClass'],
    whereProperty: { key: 'sharingModel', equals: 'without sharing' },
  },
  interpretation: '{ids} runs in system context and does not enforce record-level sharing.',
  remediation: {
    steps: [
      'Confirm whether system context is intentional for {ids}.',
      'If not, declare `with sharing` or `inherited sharing`.',
      'Enforce FLS/CRUD in code regardless of the keyword.',
    ],
    whatIfTool: 'sfi.what_if_revoke_permset',
  },
  maxConfidence: 'declared',
  absenceShaped: false,
  dependsOnCoverage: ['ApexClass'],
};

/** The SAME rule with remediation stripped — proves the absence path. */
const BARE_RULE: ConceptRule = {
  id: 'rule:test/bare',
  concept: 'concept:apex-sharing-mode',
  bind: {
    componentTypes: ['ApexClass'],
    whereProperty: { key: 'sharingModel', equals: 'without sharing' },
  },
  interpretation: '{ids} runs in system context and does not enforce record-level sharing.',
  maxConfidence: 'declared',
  absenceShaped: false,
  dependsOnCoverage: ['ApexClass'],
};

const sliceFor = (sharingModel: string): GroundedSlice => ({
  nodes: [node(CLASS_ID, 'ApexClass', { sharingModel })],
  edges: [],
});

// ---------------------------------------------------------------------------
// 1. interpret emits the grounded remediation.
// ---------------------------------------------------------------------------

describe('interpret — cited remediation on a fired rule', () => {
  it('emits a remediation whose groundedIn + confidence MATCH the claim, steps filled', () => {
    const out = interpret(REMEDIATED_RULE, sliceFor('without sharing'), COMPLETE, CLASS_ID);
    expect(out).toHaveLength(1);
    const claim = out[0]!;
    expect(claim.remediation).toBeDefined();
    const rem = claim.remediation!;
    // Same grounding + confidence as the claim it attaches to.
    expect(rem.groundedIn).toEqual(claim.groundedIn);
    expect(rem.confidence).toBe(claim.confidence);
    expect(rem.confidence).toBe('declared');
    // Steps are AUTHORED templates filled from the claim's grounded ids.
    expect(rem.steps).toHaveLength(3);
    expect(rem.steps[0]).toBe(`Confirm whether system context is intentional for ${CLASS_ID}.`);
    expect(rem.steps[2]).toBe('Enforce FLS/CRUD in code regardless of the keyword.');
    // Optional pointer at a real tool that can MODEL the counterfactual.
    expect(rem.whatIfTool).toBe('sfi.what_if_revoke_permset');
  });

  it('a fired rule WITHOUT remediation emits no remediation (never fabricated)', () => {
    const out = interpret(BARE_RULE, sliceFor('without sharing'), COMPLETE, CLASS_ID);
    expect(out).toHaveLength(1);
    expect(out[0]!.remediation).toBeUndefined();
  });

  it('REFUSES closure — the claim is untouched and no "risk gone / resolved" language is emitted', () => {
    const out = interpret(REMEDIATED_RULE, sliceFor('without sharing'), COMPLETE, CLASS_ID);
    const claim = out[0]!;
    // The finding claim itself is byte-identical to the no-remediation emit.
    expect(claim.claim).toBe(
      `${CLASS_ID} runs in system context and does not enforce record-level sharing.`,
    );
    // No remediation step asserts the finding is now closed.
    for (const step of claim.remediation!.steps) {
      expect(step).not.toMatch(/\b(no longer|now safe|risk (is )?(gone|removed|resolved)|closed|cleared)\b/i);
    }
  });

  it('does not fire on a non-matching node (no citation, no claim, no remediation)', () => {
    const out = interpret(REMEDIATED_RULE, sliceFor('with sharing'), COMPLETE, CLASS_ID);
    expect(out).toEqual([]);
  });

  it('a REAL shipped rule (rule:apex-sharing/without-sharing) carries authored remediation and fires with it', () => {
    const shipped = CONCEPT_RULES.find((r) => r.id === 'rule:apex-sharing/without-sharing');
    expect(shipped).toBeDefined();
    expect(shipped!.remediation).toBeDefined();
    expect(shipped!.remediation!.steps.length).toBeGreaterThan(0);
    const out = interpret(shipped!, sliceFor('without sharing'), COMPLETE, CLASS_ID);
    expect(out).toHaveLength(1);
    expect(out[0]!.remediation).toBeDefined();
    expect(out[0]!.remediation!.confidence).toBe(out[0]!.confidence);
    expect(out[0]!.remediation!.groundedIn).toEqual(out[0]!.groundedIn);
  });
});

// ---------------------------------------------------------------------------
// 2/3. synthesize_answer renders the remediation into FIX/NEXT (and discloses
// its absence honestly).
// ---------------------------------------------------------------------------

describe('synthesize_answer — cited remediation into FIX/NEXT slots', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  const MANIFEST: VaultManifest = {
    version: '0.1.0',
    refreshedAt: '2026-05-27T14:33:08Z',
    sourceOrg: 'me@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:fixture',
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-remediation-'));
    const opened = await openGraph(join(tempDir, 'g.duckdb'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** An `sfi.interpret`-shaped payload wrapping the given interpretations. */
  const interpretPayload = (interpretations: readonly Record<string, unknown>[]) => ({
    data: {
      componentId: CLASS_ID,
      componentType: 'ApexClass',
      interpretations,
      rulesConsidered: 5,
      rulesFired: interpretations.length,
      sliceTruncated: false,
      trust: { provenance: 'offline_snapshot', completeness: { status: 'complete' } },
      disclosure: 'deterministic offline interpretation',
      rendered: 'rendered text',
    },
  });

  const firedWithRemediation = () => {
    const out = interpret(REMEDIATED_RULE, sliceFor('without sharing'), COMPLETE, CLASS_ID);
    return out[0]! as unknown as Record<string, unknown>;
  };

  it('fills recommendedFix + nextAction from the authored remediation (attributed, hedged, cited)', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpretPayload([firedWithRemediation()]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.data.evidence;
    // The FIX slot is now filled from the remediation, attributed to the rule.
    expect(e.recommendedFix).not.toBeNull();
    expect(e.recommendedFix).toContain('Cited remediation');
    expect(e.recommendedFix).toContain('rule:test/remediated');
    expect(e.recommendedFix).toContain('confidence: declared');
    // Dependency-ordered STEPS, not a closure.
    expect(e.recommendedFix).toContain('(1)');
    expect(e.recommendedFix).toContain('(2)');
    expect(e.recommendedFix).toMatch(/do(es)? NOT re-verify the finding/i);
    // The what_if pointer is surfaced but framed as MODEL, never closure.
    expect(e.recommendedFix).toContain('sfi.what_if_revoke_permset');
    expect(e.recommendedFix).toMatch(/does NOT itself close this finding/i);
    // NEXT is the immediate first step.
    expect(e.nextAction).toContain('Confirm whether system context is intentional');
    // The grounded id rides through into citations (cited, not invented).
    expect(r.value.data.citations.map((c) => c.id)).toContain(CLASS_ID);
    // The typed remediation survives on the audit surface.
    expect(e.interpretations[0]?.remediation?.steps.length).toBe(3);
  });

  it('discloses ABSENCE honestly when a fired claim carries no authored remediation', async () => {
    // The BARE rule fires but authored no remediation.
    const bareOut = interpret(BARE_RULE, sliceFor('without sharing'), COMPLETE, CLASS_ID);
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpretPayload([bareOut[0]! as unknown as Record<string, unknown>]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // No fabricated fix.
    expect(d.evidence.recommendedFix).toBeNull();
    expect(d.evidence.nextAction).toBeNull();
    // The absence is DISCLOSED, not invented.
    expect(d.caveats.some((c) => /no cited remediation was authored/i.test(c))).toBe(true);
    // And no remediation on the audit surface.
    expect(d.evidence.interpretations[0]?.remediation).toBeUndefined();
  });

  it('interpretation-free input is byte-neutral (no remediation caveat, empty FIX/NEXT)', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: { verdict: 'ok', count: 3 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.caveats.some((c) => /no cited remediation/i.test(c))).toBe(false);
    expect(r.value.data.evidence.recommendedFix).toBeNull();
  });
});
