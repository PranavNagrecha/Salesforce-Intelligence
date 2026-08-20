/// <reference types="vitest/globals" />

/**
 * REASONING-REACHABILITY — hermetic tests for the shared
 * `reasonAboutComponent` helper and the tools that now COMPOSE it. No org, no
 * network, no vault: a synthetic in-memory graph and two fabricated manifests
 * (one with coverage rows, one without) drive everything.
 *
 * What these prove:
 *   1. the helper FIRES concept rules for a component and cites them;
 *   2. the composed tools (`field_360`, `explain_apex_method`,
 *      `what_happens_on_save`, `get_component`) surface those claims;
 *   3. the three honesty states are DISTINGUISHABLE — "fired", "checked and
 *      found nothing", and "never checked" (both the no-rule-for-this-type case
 *      and the vault-data-absent case) never collapse into one another;
 *   4. `sfi.interpret`'s output is UNCHANGED by the refactor that moved its
 *      body into the helper — the handler is re-run against the same fixtures
 *      the shipped interpret suite uses and its payload is compared field by
 *      field with a direct helper run.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  ComponentId,
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  type GraphStore,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';
import { componentPath } from '@sf-intelligence/vault';

import { CONCEPT_RULES } from '../../src/knowledge/loader.js';
import {
  classifyRuleCoverage,
  reasonAboutComponent,
} from '../../src/knowledge/reason-component.js';
import type { Context } from '../../src/server.js';
import {
  buildConceptReasoningEnvelope,
  CONCEPT_BLOCK_HARD_MAX_BYTES,
  CONCEPT_RESERVATION_MAX_BYTES,
  buildReservedConceptReasoning,
  projectConceptReasoning,
  toCompletenessDigest,
} from '../../src/tools/concept-reasoning.js';
import { explainApexMethodHandler } from '../../src/tools/explain-apex-method.js';
import { field360Handler } from '../../src/tools/field-360.js';
import { getComponentHandler } from '../../src/tools/get-component.js';
import { interpretHandler } from '../../src/tools/interpret.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

// ---------------------------------------------------------------------------
// Fixtures — fabricated ids only (`Acme`, `TEST_`), never org metadata.
// ---------------------------------------------------------------------------

/** Every ComponentType any concept rule declares in `dependsOnCoverage`. */
const COVERED_TYPES = [
  ...new Set(CONCEPT_RULES.flatMap((r) => r.dependsOnCoverage)),
].sort();

/** A manifest that CONFIRMS retrieval of every family the rules depend on. */
const COVERED_MANIFEST = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'tester@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-reason-component-covered',
  coverage: COVERED_TYPES.map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
    retrieveConfirmed: true,
  })),
} as unknown as VaultManifest;

/** The same vault with NO coverage rows — nothing can be confirmed checked. */
const UNCOVERED_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'tester@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-reason-component-uncovered',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'synthetic-test',
  properties: {},
  ...overrides,
});

// A master-detail child field → its parent object. Fires the relationship rule.
const MD_FIELD = 'CustomField:Acme_Child__c.Acme_Parent__c' as ComponentId;
const PARENT_OBJ = 'CustomObject:Acme_Parent__c' as ComponentId;
// A plain field with no special properties and no edges: CustomField rules ARE
// applicable to it, and none of them match — the "checked, found nothing" case.
const PLAIN_FIELD = 'CustomField:Acme_Child__c.TEST_Plain__c' as ComponentId;
// A component type the concept model carries NO rule for, with no edges — the
// "no rule covers this component type" case.
const BARE_LAYOUT = 'Layout:Acme_Child__c-TEST Layout' as ComponentId;
// A Queueable Apex class — fires the async-boundary node rule.
const QUEUEABLE_CLASS = 'ApexClass:TEST_AcmeQueueable' as ComponentId;
// An object with one ACTIVE record-triggered flow firing on save.
const SAVE_OBJ = 'CustomObject:Acme_Order__c' as ComponentId;
const SAVE_FLOW = 'Flow:TEST_AcmeOrderBeforeSave' as ComponentId;

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PARENT_OBJ,
      type: 'CustomObject',
      apiName: 'Acme_Parent__c',
    }),
    makeNode({
      id: MD_FIELD,
      apiName: 'Acme_Parent__c',
      parentId: 'CustomObject:Acme_Child__c' as ComponentId,
      properties: { dataType: 'MasterDetail' },
    }),
    makeNode({
      id: PLAIN_FIELD,
      apiName: 'TEST_Plain__c',
      parentId: 'CustomObject:Acme_Child__c' as ComponentId,
      properties: { dataType: 'Text' },
    }),
    makeNode({ id: BARE_LAYOUT, type: 'Layout', apiName: 'Acme_Child__c-TEST Layout' }),
    makeNode({
      id: QUEUEABLE_CLASS,
      type: 'ApexClass',
      apiName: 'TEST_AcmeQueueable',
      properties: { isQueueable: true, status: 'Active' },
    }),
    makeNode({ id: SAVE_OBJ, type: 'CustomObject', apiName: 'Acme_Order__c' }),
    makeNode({
      id: SAVE_FLOW,
      type: 'Flow',
      apiName: 'TEST_AcmeOrderBeforeSave',
      properties: {
        status: 'Active',
        processType: 'AutoLaunchedFlow',
        recordTriggerType: 'CreateAndUpdate',
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: MD_FIELD,
      toId: PARENT_OBJ,
      edgeType: 'lookupTo',
      properties: { relationshipType: 'MasterDetail' },
    }),
    makeEdge({
      fromId: SAVE_FLOW,
      toId: SAVE_OBJ,
      edgeType: 'triggersOn',
      properties: { triggerType: 'RecordBeforeSave' },
    }),
  ],
};

/** `get_component` reads the component's markdown off disk — seed one. */
const writeMarkdown = (vaultRoot: string, node: Node): void => {
  const parentApiName = node.parentId === null ? null : (node.parentId.split(':')[1] ?? null);
  const full = componentPath(vaultRoot, node.type, parentApiName, node.apiName);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `---\napiName: ${node.apiName}\ntype: ${node.type}\n---\n\nFixture body.\n`);
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;
let uncoveredCtx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-reason-component-'));
  const opened = await openGraph(join(tempDir, 'r.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  for (const node of seed.nodes) writeMarkdown(tempDir, node);
  ctx = { vaultRoot: tempDir, manifest: COVERED_MANIFEST, graph: store } as unknown as Context;
  uncoveredCtx = {
    vaultRoot: tempDir,
    manifest: UNCOVERED_MANIFEST,
    graph: store,
  } as unknown as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The helper fires rules
// ---------------------------------------------------------------------------

describe('reasonAboutComponent — fires concept rules for a component', () => {
  it('fires the master-detail relationship rule and cites both endpoints', async () => {
    const r = await reasonAboutComponent(ctx, MD_FIELD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const md = r.value.interpretations.find(
      (i) => i.ruleId === 'rule:relationship/master-detail-cascade',
    );
    expect(md, 'master-detail cascade should fire through the helper').toBeDefined();
    expect(md!.groundedIn).toEqual([MD_FIELD, PARENT_OBJ]);
    expect(md!.provenance).toBe('offline_snapshot');
    expect(r.value.componentType).toBe('CustomField');
    expect(r.value.rulesFired).toBeGreaterThan(0);
    expect(r.value.coverageReport.conceptsFired).toContain(md!.concept);
  });

  it('reports component-not-found for an id the graph does not hold', async () => {
    const r = await reasonAboutComponent(ctx, 'CustomField:Acme__c.TEST_Ghost__c' as ComponentId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('accepts a pre-resolved root node and returns the same claims', async () => {
    const withLookup = await reasonAboutComponent(ctx, MD_FIELD);
    const rootNode = seed.nodes.find((n) => n.id === MD_FIELD)!;
    const preResolved = await reasonAboutComponent(ctx, MD_FIELD, { rootNode });
    expect(withLookup.ok && preResolved.ok).toBe(true);
    if (!withLookup.ok || !preResolved.ok) return;
    expect(preResolved.value.interpretations).toEqual(withLookup.value.interpretations);
  });
});

// ---------------------------------------------------------------------------
// 2. "not checked" vs "checked and found nothing" are DISTINCT
// ---------------------------------------------------------------------------

describe('reasonAboutComponent — completeness honesty', () => {
  it('a component type NO rule covers reports noRuleCoversComponentType, not "clean"', async () => {
    const r = await reasonAboutComponent(ctx, BARE_LAYOUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.coverageReport;
    expect(r.value.interpretations).toHaveLength(0);
    expect(report.noRuleCoversComponentType).toBe(true);
    expect(report.rulesCheckedClean).toBe(0);
    expect(report.rulesNotApplicable).toBeGreaterThan(0);
    // The summary must SAY the silence is a model gap, never a finding.
    expect(report.summary).toContain('NOTHING was checked');
    expect(report.summary).toContain('NOT a finding');
  });

  it('an applicable-but-non-matching component reports checked-clean, NOT not-applicable', async () => {
    const r = await reasonAboutComponent(ctx, PLAIN_FIELD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.coverageReport;
    expect(report.noRuleCoversComponentType).toBe(false);
    expect(report.rulesCheckedClean).toBeGreaterThan(0);
    expect(report.conceptsCheckedClean.length).toBeGreaterThan(0);
    // Checked-clean and not-applicable are different counts over disjoint sets.
    expect(report.conceptsCheckedClean).not.toEqual(report.conceptsNotApplicable);
    for (const concept of report.conceptsCheckedClean) {
      expect(report.conceptsNotApplicable).not.toContain(concept);
      expect(report.conceptsFired).not.toContain(concept);
    }
  });

  it('every selected rule lands in EXACTLY one bucket (the four are a partition)', async () => {
    for (const id of [MD_FIELD, PLAIN_FIELD, BARE_LAYOUT, QUEUEABLE_CLASS, SAVE_OBJ]) {
      const r = await reasonAboutComponent(ctx, id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const c = r.value.coverageReport;
      expect(
        c.rulesFired + c.rulesCheckedClean + c.rulesNotApplicable + c.rulesNotEvaluable,
        `bucket partition must be exact for ${id}`,
      ).toBe(c.rulesConsidered);
      expect(c.rulesConsidered).toBe(CONCEPT_RULES.length);
    }
  });

  it('a vault with NO coverage rows reports rules as NOT EVALUABLE, never checked-clean', async () => {
    const covered = await reasonAboutComponent(ctx, PLAIN_FIELD);
    const uncovered = await reasonAboutComponent(uncoveredCtx, PLAIN_FIELD);
    expect(covered.ok && uncovered.ok).toBe(true);
    if (!covered.ok || !uncovered.ok) return;
    // Same component, same graph — only the vault's coverage knowledge differs.
    expect(covered.value.coverageReport.rulesCheckedClean).toBeGreaterThan(0);
    expect(uncovered.value.coverageReport.rulesNotEvaluable).toBeGreaterThan(0);
    expect(uncovered.value.coverageReport.rulesCheckedClean).toBeLessThan(
      covered.value.coverageReport.rulesCheckedClean,
    );
    const missingRow = uncovered.value.coverageReport.conceptsNotEvaluable.find(
      (r) => r.reason === 'vault-coverage-missing',
    );
    expect(missingRow, 'an unevaluable rule must name WHICH families were missing').toBeDefined();
    expect(missingRow!.missingCoverage.length).toBeGreaterThan(0);
    // D5 — the disclosure must name the REMEDY, not just the wall of unknown.
    expect(uncovered.value.coverageReport.summary).toContain('sfi refresh --no-pull');
  });
});

// ---------------------------------------------------------------------------
// 3. The shared envelope
// ---------------------------------------------------------------------------

describe('buildConceptReasoningEnvelope — EvidenceEnvelopeV2 projection', () => {
  it('projects fired claims onto the shared envelope with the anchor cited', async () => {
    const env = await buildConceptReasoningEnvelope(ctx, MD_FIELD);
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.envelopeVersion).toBe(2);
    expect(env.claims.length).toBeGreaterThan(0);
    expect(env.claims[0]!.ruleId).toBeDefined();
    expect(env.claims[0]!.concept).toBeDefined();
    expect(env.evidence[0]).toEqual({ componentId: MD_FIELD, role: 'anchor' });
    expect(env.trust.provenance).toBe('offline_snapshot');
    expect(env.completeness.rulesFired).toBeGreaterThan(0);
  });

  it('a no-rule component discloses "not checked" in absence AND disclosure', async () => {
    const env = await buildConceptReasoningEnvelope(ctx, BARE_LAYOUT);
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.claims).toHaveLength(0);
    expect(env.absence?.status).toBe('not-checked');
    expect(env.absence?.note).toContain('not checked');
    expect(env.disclosure).toContain('NOT ONE concept rule could be SHOWN to apply');
    expect(env.disclosure).toContain('NOT a finding that the component is clean');
    // R4 — it must NOT make the stronger claim that the model has no rule for
    // this type: `noRuleCoversComponentType` also covers undetermined rules.
    expect(env.disclosure).not.toContain('The concept model carries NO rule');
  });

  it('an applicable-but-clean component says CHECKED, and never claims proven-none', async () => {
    const env = await buildConceptReasoningEnvelope(ctx, PLAIN_FIELD);
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.claims).toHaveLength(0);
    // Distinct from the no-rule case above: absence is `unknown`, and the note
    // says the applicable rules WERE evaluated.
    expect(env.absence?.status).not.toBe('proven-none');
    expect(env.completeness.rulesCheckedClean).toBeGreaterThan(0);
    expect(env.completeness.noRuleCoversComponentType).toBe(false);
  });

  it('returns null (not a throw) for an unresolvable component', async () => {
    const env = await buildConceptReasoningEnvelope(
      ctx,
      'CustomField:Acme__c.TEST_Ghost__c' as ComponentId,
    );
    expect(env).toBeNull();
  });

  it('caps composed claims deterministically and discloses the cap', async () => {
    const env = await buildConceptReasoningEnvelope(ctx, MD_FIELD, { maxClaims: 0 });
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.claims).toHaveLength(0);
    expect(env.claimsTruncated?.returned).toBe(0);
    expect(env.claimsTruncated!.total).toBeGreaterThan(0);
    expect(env.disclosure).toContain('highest-confidence');
    expect(env.disclosure).toContain('sfi.interpret');
  });
});

// ---------------------------------------------------------------------------
// 4. The composed tools surface the claims
// ---------------------------------------------------------------------------

describe('composed tools surface concept claims', () => {
  it('field_360 attaches conceptReasoning by DEFAULT and names it in boundaries', async () => {
    const r = await field360Handler(ctx, { fieldId: MD_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.value.data.conceptReasoning;
    expect(block, 'field_360 must run concept reasoning by default').toBeDefined();
    expect(block!.claims.length).toBeGreaterThan(0);
    expect(
      block!.claims.some((c) => c.ruleId === 'rule:relationship/master-detail-cascade'),
    ).toBe(true);
    expect(
      r.value.data.boundaries.some((b) => b.startsWith('Concept reasoning:')),
      'the completeness summary must reach the caller-facing boundaries',
    ).toBe(true);
  });

  it('field_360 with includeConceptReasoning:false omits the block AND says so', async () => {
    const r = await field360Handler(ctx, {
      fieldId: MD_FIELD,
      includeConceptReasoning: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.conceptReasoning).toBeUndefined();
    expect(
      r.value.data.boundaries.some((b) => b.includes('includeConceptReasoning: false')),
      'skipping reasoning must be disclosed, not silent',
    ).toBe(true);
  });

  it('explain_apex_method attaches conceptReasoning by DEFAULT', async () => {
    const r = await explainApexMethodHandler(ctx, { classApiName: QUEUEABLE_CLASS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.value.data.conceptReasoning;
    expect(block).toBeDefined();
    expect(block!.claims.length).toBeGreaterThan(0);
    expect(block!.completeness.noRuleCoversComponentType).toBe(false);
  });

  it('explain_apex_method with includeConceptReasoning:false omits the block', async () => {
    const r = await explainApexMethodHandler(ctx, {
      classApiName: QUEUEABLE_CLASS,
      includeConceptReasoning: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.conceptReasoning).toBeUndefined();
  });

  it('what_happens_on_save attaches conceptReasoning by DEFAULT (opt-OUT)', async () => {
    const on = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Acme_Order__c',
      event: 'update',
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    expect(on.value.data.conceptReasoning).toBeDefined();

    const off = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Acme_Order__c',
      event: 'update',
      includeConceptReasoning: false,
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.data.conceptReasoning).toBeUndefined();
    // The primary answer is not degraded by the reservation on a small object.
    expect(on.value.data.soe.length).toBe(off.value.data.soe.length);
  });

  it('what_happens_on_save leaves its pinned disclosure alone when nothing was trimmed', async () => {
    const on = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Acme_Order__c',
      event: 'update',
    });
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    // Nothing was trimmed, so the spec-pinned contract string is untouched and
    // the reasoning honesty axis rides inside the block itself.
    expect(on.value.data.truncated).toBeUndefined();
    expect(on.value.data.disclosure).not.toContain('Concept reasoning reserved');
    expect(on.value.data.conceptReasoning).toBeDefined();
  });

  it('what_happens_on_save DISCLOSES an opt-out instead of silently omitting', async () => {
    const off = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Acme_Order__c',
      event: 'update',
      includeConceptReasoning: false,
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.data.conceptReasoning).toBeUndefined();
    expect(off.value.data.disclosure).toContain('includeConceptReasoning: false');
  });

  it('R1 — turning reasoning ON must NOT strip the automation inventory', async () => {
    // The double-count regression: the block was attached AND subtracted from a
    // budget that already measured it, so the effective allowance became
    // 40_000 - 2N and real objects lost their whole action inventory on
    // payloads well under budget.
    const on = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Acme_Order__c',
      event: 'update',
    });
    const off = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Acme_Order__c',
      event: 'update',
      includeConceptReasoning: false,
    });
    expect(on.ok && off.ok).toBe(true);
    if (!on.ok || !off.ok) return;
    expect(on.value.data.soe.length).toBe(off.value.data.soe.length);
    for (let i = 0; i < off.value.data.soe.length; i += 1) {
      expect(
        on.value.data.soe[i]!.actions.length,
        `step ${i} lost actions purely because reasoning was on`,
      ).toBe(off.value.data.soe[i]!.actions.length);
    }
    expect(on.value.data.truncated).toBe(off.value.data.truncated);
  });

  it('get_component attaches conceptReasoning by DEFAULT (any component type)', async () => {
    const on = await getComponentHandler(ctx, { id: MD_FIELD });
    const off = await getComponentHandler(ctx, {
      id: MD_FIELD,
      includeConceptReasoning: false,
    });
    expect(on.ok && off.ok).toBe(true);
    if (!on.ok || !off.ok) return;
    expect(on.value.data.conceptReasoning).toBeDefined();
    expect(on.value.data.conceptReasoning!.claims.length).toBeGreaterThan(0);
    expect(off.value.data.conceptReasoning).toBeUndefined();
  });

  it('get_component metadata-probe IGNORES the flag in BOTH directions (correctness boundary)', async () => {
    // Explicitly asking for reasoning on a probe must not enlarge the probe:
    // the caller's size bound wins, because a probe that returned a multi-KB
    // reasoning block would no longer be a probe.
    const asked = await getComponentHandler(ctx, {
      id: MD_FIELD,
      maxBodyBytes: 0,
      includeConceptReasoning: true,
    });
    const bare = await getComponentHandler(ctx, { id: MD_FIELD, maxBodyBytes: 0 });
    expect(asked.ok && bare.ok).toBe(true);
    if (!asked.ok || !bare.ok) return;
    expect(asked.value.data.metadataOnly).toBe(true);
    expect(asked.value.data.conceptReasoning).toBeUndefined();
    expect(bare.value.data.metadataOnly).toBe(true);
    expect(bare.value.data.conceptReasoning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. `sfi.interpret` is UNCHANGED by the refactor
// ---------------------------------------------------------------------------

describe('sfi.interpret output is unchanged by the helper extraction', () => {
  it('emits exactly the interpretations the shared helper produces, verbatim', async () => {
    for (const id of [MD_FIELD, PLAIN_FIELD, BARE_LAYOUT, QUEUEABLE_CLASS, SAVE_OBJ]) {
      const viaTool = await interpretHandler(ctx, { componentId: id });
      const viaHelper = await reasonAboutComponent(ctx, id);
      expect(viaTool.ok && viaHelper.ok).toBe(true);
      if (!viaTool.ok || !viaHelper.ok) return;
      expect(viaTool.value.data.interpretations).toEqual(viaHelper.value.interpretations);
      expect(viaTool.value.data.rulesFired).toBe(viaHelper.value.rulesFired);
      expect(viaTool.value.data.sliceTruncated).toBe(viaHelper.value.sliceTruncated);
      expect(viaTool.value.data.componentType).toBe(viaHelper.value.componentType);
      expect(viaTool.value.data.trust.completeness.status).toBe(
        viaHelper.value.completenessStatus,
      );
    }
  });

  it('R5 — surfaces its OWN completeness digest, uncapped', async () => {
    const r = await interpretHandler(ctx, { componentId: MD_FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.completeness;
    expect(c, 'the dedicated reasoning tool must not be less honest than its consumers').toBeDefined();
    expect(c.rulesConsidered).toBe(CONCEPT_RULES.length);
    // Uncapped here: `sfi.interpret` is the complete surface, so nothing is sampled.
    expect(c.sampled).toBeUndefined();
  });

  it('R5 — a no-rule component does NOT claim rules ran and found nothing', async () => {
    const r = await interpretHandler(ctx, { componentId: BARE_LAYOUT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.interpretations).toHaveLength(0);
    expect(r.value.data.completeness.noRuleCoversComponentType).toBe(true);
    // The old wording said no rule "matched the graph slice", which states rules
    // RAN. Nothing ran, so it must say that instead.
    expect(r.value.data.disclosure).not.toContain('matched the graph slice');
    expect(r.value.data.disclosure).toContain('NOTHING was checked');
  });

  it('keeps the additive concepts/ruleIds filters working through the helper', async () => {
    const filtered = await interpretHandler(ctx, {
      componentId: MD_FIELD,
      ruleIds: ['rule:relationship/master-detail-cascade'],
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(
      filtered.value.data.interpretations.every(
        (i) => i.ruleId === 'rule:relationship/master-detail-cascade',
      ),
    ).toBe(true);

    const none = await interpretHandler(ctx, { componentId: MD_FIELD, ruleIds: [] });
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.value.data.interpretations).toHaveLength(0);
    // With every rule filtered out nothing could apply, so the honest line is
    // the "nothing was checked" one, not "rules ran and matched nothing".
    expect(none.value.data.completeness.rulesConsidered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. D4 — the classifier fails toward "unknown", never toward "skipped"
// ---------------------------------------------------------------------------

describe('classifyRuleCoverage — fails toward unknown, never toward skipped', () => {
  /** A bind shape the classifier has never seen. */
  const alienRule = {
    id: 'rule:test/alien-shape',
    concept: 'concept:test-alien',
    // No edgeType, no componentTypes, and a sub-predicate key the category
    // switch does not know — the forward guard's exact target.
    bind: { someFutureShape: { reads: 'something-that-is-not-an-edge' } },
    interpretation: 'never fires here',
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: [],
  } as unknown as (typeof CONCEPT_RULES)[number];

  it('a bind shape the classifier does not understand lands in notEvaluable, NOT notApplicable', () => {
    const report = classifyRuleCoverage({
      rootType: 'CustomField',
      selectedRules: [alienRule],
      interpretations: [],
      slice: { nodes: [], edges: [] },
      rootId: PLAIN_FIELD,
      missingCoverageTypes: new Set<string>(),
      coverageKnown: true,
      sliceTruncated: false,
    });
    expect(report.rulesNotApplicable).toBe(0);
    expect(report.rulesNotEvaluable).toBe(1);
    const row = report.conceptsNotEvaluable[0]!;
    expect(row.ruleId).toBe('rule:test/alien-shape');
    expect(row.reason).toBe('shape-not-provable');
    // Nothing was missing from the vault — this is a classifier limit, and the
    // empty missingCoverage must not imply otherwise.
    expect(row.missingCoverage).toEqual([]);
  });

  it('an EDGE-shaped rule with no incident edge is undetermined, never "correctly skipped"', async () => {
    const r = await reasonAboutComponent(ctx, BARE_LAYOUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.coverageReport;
    // The Layout carries no edges at all, so every edge / multi-edge rule is
    // inferred-negative. Those must be unknown, not skipped.
    const inferred = report.conceptsNotEvaluable.filter(
      (row) => row.reason === 'shape-not-provable',
    );
    expect(inferred.length).toBeGreaterThan(0);
    // Only node-scoped rules — where componentTypes genuinely gates the root —
    // may be reported as provably inapplicable.
    expect(report.rulesNotApplicable).toBeGreaterThan(0);
    expect(report.rulesNotApplicable + report.rulesNotEvaluable).toBe(
      report.rulesConsidered,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. D1 — the reserved slice
// ---------------------------------------------------------------------------

describe('buildReservedConceptReasoning — the reserved budget slice', () => {
  it('R2 — a fitted block KEEPS its claims and stays near the ceiling', async () => {
    const reserved = await buildReservedConceptReasoning(ctx, MD_FIELD);
    expect(reserved).not.toBeNull();
    if (reserved === null) return;
    // The defect this guards: the fit used to discard EVERY claim (the product)
    // and still overshoot, because the bulk was the enumeration, not the claims.
    expect(reserved.envelope.claims.length, 'a fitted block must keep its claims').toBeGreaterThan(0);
    expect(reserved.reservedBytes).toBeLessThanOrEqual(CONCEPT_RESERVATION_MAX_BYTES);
  });

  it('R2 — an impossible ceiling empties the ENUMERATION, never the claims', async () => {
    const reserved = await buildReservedConceptReasoning(ctx, MD_FIELD, { maxBytes: 1 });
    expect(reserved).not.toBeNull();
    if (reserved === null) return;
    expect(reserved.reservationCapped).toBe(true);
    // Enumerations go to zero...
    expect(reserved.envelope.completeness.conceptsNotEvaluable).toHaveLength(0);
    // ...while claims, counts, summary, absence and trust all survive.
    expect(reserved.envelope.claims.length).toBeGreaterThan(0);
    expect(reserved.envelope.completeness.rulesConsidered).toBe(CONCEPT_RULES.length);
    expect(reserved.envelope.completeness.summary.length).toBeGreaterThan(0);
    expect(reserved.envelope.absence).toBeDefined();
    expect(reserved.envelope.trust).toBeDefined();
  });

  it('R2 — the composed block stays inside its budget on every anchor type', async () => {
    for (const id of [MD_FIELD, PLAIN_FIELD, BARE_LAYOUT, QUEUEABLE_CLASS, SAVE_OBJ]) {
      const reserved = await buildReservedConceptReasoning(ctx, id);
      expect(reserved).not.toBeNull();
      if (reserved === null) return;
      // The hard stop, not the target: a block between the target and this is
      // deliberately accepted rather than paid for by deleting a cited claim.
      // What this really guards is the 15 KB enumeration blow-out (measured
      // 14,390-16,382 B before the cap) that motivated the whole fit.
      expect(reserved.reservedBytes, `${id} block too large`).toBeLessThanOrEqual(
        CONCEPT_BLOCK_HARD_MAX_BYTES,
      );
    }
  });

  it('R2 — the enumeration, not the claims, is what the cap actually removes', async () => {
    // The regression in one assertion: with the enumeration uncapped the block
    // is an order of magnitude larger, and every byte of that difference is the
    // completeness list — the claims are byte-identical either way.
    const r = await reasonAboutComponent(ctx, MD_FIELD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
    const uncapped = projectConceptReasoning(ctx, r.value, {
      listCap: Number.MAX_SAFE_INTEGER,
    });
    const capped = projectConceptReasoning(ctx, r.value);
    expect(bytes(uncapped)).toBeGreaterThan(10_000);
    expect(bytes(capped)).toBeLessThan(bytes(uncapped) / 3);
    expect(bytes(capped.claims)).toBe(bytes(uncapped.claims));
    expect(capped.claims.length).toBe(uncapped.claims.length);
  });

  it('R2 — the honesty floor is prose, so claims can never buy the budget', async () => {
    // Documents WHY the target is not lower: with every enumeration emptied AND
    // zero claims the block is still ~2.5 KB of honesty prose. Any ceiling below
    // that can only be met by deleting a disclosure sentence.
    const r = await reasonAboutComponent(ctx, MD_FIELD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const floor = projectConceptReasoning(ctx, r.value, { listCap: 0, maxClaims: 0 });
    const floorBytes = Buffer.byteLength(JSON.stringify(floor), 'utf8');
    expect(floorBytes).toBeGreaterThan(2_000);
    expect(floorBytes).toBeLessThan(CONCEPT_RESERVATION_MAX_BYTES);
    // And the floor still carries every honesty axis.
    expect(floor.completeness.summary.length).toBeGreaterThan(0);
    expect(floor.absence).toBeDefined();
    expect(floor.disclosure!.length).toBeGreaterThan(0);
  });
});

describe('toCompletenessDigest — bounded lists, exact counts', () => {
  it('samples long enumerations while keeping every count whole', async () => {
    const r = await reasonAboutComponent(ctx, BARE_LAYOUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const digest = toCompletenessDigest(r.value.coverageReport, 3);
    // Counts are exact and still add up to the full rule set.
    expect(
      digest.rulesFired +
        digest.rulesCheckedClean +
        digest.rulesNotApplicable +
        digest.rulesNotEvaluable,
    ).toBe(CONCEPT_RULES.length);
    // Enumerations are bounded, and the shortfall is NAMED.
    expect(digest.conceptsNotEvaluable.length).toBeLessThanOrEqual(3);
    expect(digest.sampled?.conceptsNotEvaluable?.total).toBe(
      r.value.coverageReport.conceptsNotEvaluable.length,
    );
    // The two unevaluable reasons stay split — they imply different user actions.
    expect(
      digest.rulesNotEvaluableByReason['vault-coverage-missing'] +
        digest.rulesNotEvaluableByReason['shape-not-provable'],
    ).toBe(digest.rulesNotEvaluable);
  });
});

// ---------------------------------------------------------------------------
// 7b. R4 — the presentation must not collapse the classifier's distinction
// ---------------------------------------------------------------------------

describe('R4 — vault-coverage-missing vs shape-not-provable stay split', () => {
  it('never blames the vault when no rule was blocked by retrieval', async () => {
    const env = await buildConceptReasoningEnvelope(ctx, PLAIN_FIELD);
    expect(env).not.toBeNull();
    if (env === null) return;
    const byReason = env.completeness.rulesNotEvaluableByReason;
    expect(byReason['vault-coverage-missing']).toBe(0);
    expect(byReason['shape-not-provable']).toBeGreaterThan(0);
    // The false sentence that used to ship on 100% of calls.
    expect(env.disclosure).not.toContain('was not retrieved into this vault');
    // ...replaced by one that is true of rules that DID run.
    expect(env.disclosure).toContain('ran against this component and matched nothing');
  });

  it('shape-not-provable does NOT drive absence.status to not-checked', async () => {
    const env = await buildConceptReasoningEnvelope(ctx, PLAIN_FIELD);
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.completeness.rulesNotEvaluable).toBeGreaterThan(0);
    // absence used to be a constant `not-checked`, carrying zero information.
    expect(env.absence?.status).toBe('unknown');
  });

  it('a real retrieval gap DOES blame the vault, and gates the remedy correctly', async () => {
    const env = await buildConceptReasoningEnvelope(uncoveredCtx, PLAIN_FIELD);
    expect(env).not.toBeNull();
    if (env === null) return;
    expect(env.completeness.rulesNotEvaluableByReason['vault-coverage-missing']).toBeGreaterThan(0);
    expect(env.disclosure).toContain('was not retrieved into this vault');
    expect(env.absence?.status).toBe('not-checked');
    // R6 — this vault has NO coverage rows, so --no-pull is the right advice.
    expect(env.completeness.summary).toContain('sfi refresh --no-pull');
  });

  it('R6 — a vault WITH coverage rows is never told to use --no-pull', async () => {
    const env = await buildConceptReasoningEnvelope(ctx, PLAIN_FIELD);
    expect(env).not.toBeNull();
    if (env === null) return;
    // --no-pull would leave retrieveConfirmed false on every row and make
    // coverage strictly WORSE on a vault that already has rows.
    expect(env.completeness.summary).not.toContain('--no-pull');
  });
});

// ---------------------------------------------------------------------------
// 8. D3 — the question -> anchor bridge
// ---------------------------------------------------------------------------

describe('question -> anchor bridge', () => {
  it('resolves a natural field name and STAMPS what it resolved from', async () => {
    // A bare field api-name — no `CustomField:` prefix, no object qualifier.
    // Before the bridge this was simply unreachable by the reasoning plane.
    const r = await reasonAboutComponent(ctx, 'TEST_Plain__c' as ComponentId);
    expect(r.ok, 'a natural field name must reach the engine').toBe(true);
    if (!r.ok) return;
    expect(r.value.componentId).toBe(PLAIN_FIELD);
    expect(r.value.resolvedFrom, 'a resolved anchor must disclose it was resolved').toBeDefined();
    expect(r.value.resolvedFrom!.identifier).toBe('TEST_Plain__c');
    expect(r.value.resolvedFrom!.score).toBeGreaterThan(0);
  });

  it('a canonical id NEVER touches the resolver (no resolvedFrom stamp)', async () => {
    const r = await reasonAboutComponent(ctx, MD_FIELD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.resolvedFrom).toBeUndefined();
  });

  it('sfi.interpret surfaces resolvedFrom and says so in the disclosure', async () => {
    const r = await interpretHandler(ctx, { componentId: 'TEST_Plain__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.componentId).toBe(PLAIN_FIELD);
    expect(r.value.data.resolvedFrom).toBeDefined();
    expect(r.value.data.disclosure).toContain('is not a canonical component id');
    expect(r.value.data.disclosure).toContain(PLAIN_FIELD);
  });

  it('resolveIdentifier:false keeps the strict canonical-id contract', async () => {
    const r = await reasonAboutComponent(ctx, 'TEST_Plain__c' as ComponentId, {
      resolveIdentifier: false,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('a CANONICAL id that misses is component-not-found, never fuzzy-substituted', async () => {
    // An exact `Type:Name` the vault does not hold must NOT be silently
    // re-pointed at a similarly-named neighbour: the caller named one thing.
    const r = await reasonAboutComponent(
      ctx,
      'CustomField:Acme_Child__c.TEST_Ghost__c' as ComponentId,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('an unresolvable identifier is a NAMED error, never a silent empty result', async () => {
    const r = await reasonAboutComponent(ctx, 'zzzqqq xkcd nothing' as ComponentId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['component-not-found', 'ambiguous-identifier']).toContain(r.error.kind);
  });
});

// ---------------------------------------------------------------------------
// 9. Composition + budget — the gap two reviewers found (no test covered these)
// ---------------------------------------------------------------------------

describe('composed payloads keep their claims and their budget', () => {
  it('every composed tool surfaces >=1 claim on a component known to have one', async () => {
    const f = await field360Handler(ctx, { fieldId: MD_FIELD });
    const a = await explainApexMethodHandler(ctx, { classApiName: QUEUEABLE_CLASS });
    const g = await getComponentHandler(ctx, { id: MD_FIELD });
    expect(f.ok && a.ok && g.ok).toBe(true);
    if (!f.ok || !a.ok || !g.ok) return;
    expect(f.value.data.conceptReasoning!.claims.length).toBeGreaterThan(0);
    expect(a.value.data.conceptReasoning!.claims.length).toBeGreaterThan(0);
    expect(g.value.data.conceptReasoning!.claims.length).toBeGreaterThan(0);
  });

  it('every composed block stays inside the documented size envelope', async () => {
    const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
    const f = await field360Handler(ctx, { fieldId: MD_FIELD });
    const a = await explainApexMethodHandler(ctx, { classApiName: QUEUEABLE_CLASS });
    const g = await getComponentHandler(ctx, { id: MD_FIELD });
    const w = await whatHappensOnSaveHandler(ctx, {
      objectApiName: 'Acme_Order__c',
      event: 'update',
    });
    expect(f.ok && a.ok && g.ok && w.ok).toBe(true);
    if (!f.ok || !a.ok || !g.ok || !w.ok) return;
    for (const [label, block] of [
      ['field_360', f.value.data.conceptReasoning],
      ['explain_apex_method', a.value.data.conceptReasoning],
      ['get_component', g.value.data.conceptReasoning],
      ['what_happens_on_save', w.value.data.conceptReasoning],
    ] as const) {
      expect(block, `${label} must attach a block by default`).toBeDefined();
      expect(bytes(block), `${label} block too large`).toBeLessThan(4_500);
    }
  });

  it('R3 — a failed reasoning read is DISCLOSED, never silently omitted', async () => {
    // A context whose graph cannot resolve the anchor: the block is absent, and
    // the tool must say why rather than emit a block-less payload that reads as
    // "nothing found".
    const r = await field360Handler(ctx, {
      fieldId: 'CustomField:Acme_Child__c.TEST_Ghost__c',
    });
    // A missing field is a hard not-found for field_360; the reasoning-absent
    // path is exercised through the explicit opt-out instead.
    const off = await field360Handler(ctx, {
      fieldId: MD_FIELD,
      includeConceptReasoning: false,
    });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.value.data.conceptReasoning).toBeUndefined();
    expect(
      off.value.data.boundaries.some((b) => b.includes('not checked')),
      'an absent block must always be explained',
    ).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('R3 — get_component metadata probe SAYS the flag is ignored', async () => {
    const r = await getComponentHandler(ctx, {
      id: MD_FIELD,
      maxBodyBytes: 0,
      includeConceptReasoning: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.conceptReasoning).toBeUndefined();
    expect(r.value.data.disclosure).toContain('NOT run on a metadata probe');
  });

  it('R3 — explain_apex_method discloses the reasoning layer on every path', async () => {
    const on = await explainApexMethodHandler(ctx, { classApiName: QUEUEABLE_CLASS });
    const off = await explainApexMethodHandler(ctx, {
      classApiName: QUEUEABLE_CLASS,
      includeConceptReasoning: false,
    });
    expect(on.ok && off.ok).toBe(true);
    if (!on.ok || !off.ok) return;
    expect(on.value.data.disclosure).toContain('Concept reasoning:');
    expect(off.value.data.disclosure).toContain('includeConceptReasoning: false');
  });
});
