/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  aiExposureReportHandler,
  aiExposureReportInputSchema,
} from '../../src/tools/ai-exposure-report.js';

const manifest = (hash: string): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-07-10T00:00:00Z',
  sourceOrg: 'test',
  components: {},
  edges: {},
  sourceTreeHash: `sha256:${hash}`,
});

const node = (
  id: string,
  type: Node['type'],
  apiName: string,
  props: Record<string, unknown> = {},
): Node => ({
  id,
  type,
  apiName,
  label: null,
  parentId: null,
  sourcePath: `${id}.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: props,
});

/** A CustomField node whose apiName is the FIELD-only name (the real convention). */
const field = (objectDotField: string, dataType: string): Node =>
  node(`CustomField:${objectDotField}`, 'CustomField', objectDotField.split('.')[1] ?? objectDotField, {
    dataType,
  });

const ref = (fromId: string, toId: string, referenceKind: string): Edge => ({
  fromId,
  toId,
  edgeType: 'references',
  confidence: 'declared',
  source: 'unit-test',
  properties: { referenceKind },
});

const rw = (fromId: string, toId: string, edgeType: 'readsFrom' | 'writesTo'): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'heuristic',
  source: 'unit-test',
  properties: {},
});

// --- Fixture: a small Agentforce surface -------------------------------
//
// Prompt template `Draft_Loyalty_Followup` grounds on Contact.SSN__c (PII),
// Contact.Loyalty_Tier__c (public), and Case.Unmodeled__c (no node -> unknown).
// Function `Get_Order_Status` invokes ApexClass:OrderService, which READS
// Order__c.Ship_To_SSN__c (PII) and WRITES Order__c.Status__c (public).
// Plugin `Order_Management` groups the function; agent `Order_Support_Agent`
// orchestrates the plugin -> the PII field must roll all the way up to the
// agent surface transitively.
// Bot `Order_Support_Bot` maps MessagingSession.EndUserContactId as a
// context variable (includeInPrompt) and its BotVersion points at the same
// planner — so the Bot surface must expose BOTH the context field AND the
// transitive Apex-read PII.
const seed: ExtractionResult = {
  nodes: [
    node('GenAiPromptTemplate:Draft_Loyalty_Followup', 'GenAiPromptTemplate', 'Draft_Loyalty_Followup', {}),
    node('GenAiFunction:Get_Order_Status', 'GenAiFunction', 'Get_Order_Status', {
      invocationTarget: 'OrderService',
      invocationTargetType: 'apex',
    }),
    node('GenAiPlugin:Order_Management', 'GenAiPlugin', 'Order_Management', {}),
    node('GenAiPlannerBundle:Order_Support_Agent', 'GenAiPlannerBundle', 'Order_Support_Agent', {}),
    node('Bot:Order_Support_Bot', 'Bot', 'Order_Support_Bot', {}),
    node('BotVersion:Order_Support_Bot.v1', 'BotVersion', 'Order_Support_Bot.v1', {}),
    node('ApexClass:OrderService', 'ApexClass', 'OrderService', {}),
    // The parent objects of the modeled fields. A real vault always carries the
    // CustomObject node beside the CustomField nodes; the fixture omitted them
    // only because nothing used to look. `objectApiName` now VERIFIES the
    // object exists before filtering, so leaving them out would make the
    // object-filter test assert against a vault no refresh can produce.
    // `Case` is deliberately still absent — `Case.Unmodeled__c` is the
    // "object not retrieved" case the unknown-classification test needs.
    node('CustomObject:Contact', 'CustomObject', 'Contact', {}),
    node('CustomObject:Order__c', 'CustomObject', 'Order__c', {}),
    node('CustomObject:MessagingSession', 'CustomObject', 'MessagingSession', {}),
    field('Contact.SSN__c', 'Text'),
    field('Contact.Loyalty_Tier__c', 'Text'),
    field('Order__c.Ship_To_SSN__c', 'Text'),
    field('Order__c.Status__c', 'Picklist'),
    field('MessagingSession.EndUserContactId', 'Text'),
    // Case.Unmodeled__c intentionally has NO node -> classified `unknown`.
  ],
  edges: [
    ref('GenAiPromptTemplate:Draft_Loyalty_Followup', 'CustomField:Contact.SSN__c', 'promptTemplateGroundingField'),
    ref('GenAiPromptTemplate:Draft_Loyalty_Followup', 'CustomField:Contact.Loyalty_Tier__c', 'promptTemplateGroundingField'),
    ref('GenAiPromptTemplate:Draft_Loyalty_Followup', 'CustomField:Case.Unmodeled__c', 'promptTemplateGroundingField'),
    ref('GenAiFunction:Get_Order_Status', 'ApexClass:OrderService', 'genAiFunctionApexTarget'),
    rw('ApexClass:OrderService', 'CustomField:Order__c.Ship_To_SSN__c', 'readsFrom'),
    rw('ApexClass:OrderService', 'CustomField:Order__c.Status__c', 'writesTo'),
    ref('GenAiPlugin:Order_Management', 'GenAiFunction:Get_Order_Status', 'genAiPluginFunction'),
    ref('GenAiPlannerBundle:Order_Support_Agent', 'GenAiPlugin:Order_Management', 'plannerBundlePlugin'),
    {
      fromId: 'Bot:Order_Support_Bot',
      toId: 'CustomField:MessagingSession.EndUserContactId',
      edgeType: 'references',
      confidence: 'declared',
      source: 'unit-test',
      properties: { referenceKind: 'botContextVariableField', includeInPrompt: true },
    },
    {
      fromId: 'Bot:Order_Support_Bot',
      toId: 'BotVersion:Order_Support_Bot.v1',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'unit-test',
      properties: {},
    },
    ref('BotVersion:Order_Support_Bot.v1', 'GenAiPlannerBundle:Order_Support_Agent', 'botVersionPlanner'),
  ],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-ai-exposure-'));
  const opened = await openGraph(join(dir, 'ai.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: dir, manifest: manifest('ai-fixture'), graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

describe('aiExposureReportInputSchema', () => {
  it('accepts no args, an object filter, and a bounded limit', () => {
    expect(aiExposureReportInputSchema.safeParse({}).success).toBe(true);
    expect(aiExposureReportInputSchema.safeParse({ objectApiName: 'Contact' }).success).toBe(true);
    expect(aiExposureReportInputSchema.safeParse({ limit: 10 }).success).toBe(true);
    expect(aiExposureReportInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(aiExposureReportInputSchema.safeParse({ objectApiName: '' }).success).toBe(false);
  });
});

describe('aiExposureReportHandler — org-wide', () => {
  it('reports every GenAI surface and flags PII grounding', async () => {
    const r = await aiExposureReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).toBe('ai-surface-modeled');
    expect(d.scope.mode).toBe('org-wide');
    expect(d.summary.promptTemplates).toBe(1);
    expect(d.summary.functions).toBe(1);
    expect(d.summary.plugins).toBe(1);
    expect(d.summary.plannerBundles).toBe(1);
    expect(d.summary.bots).toBe(1);

    // Contact.SSN__c and Order__c.Ship_To_SSN__c are the two PII fields.
    expect(d.summary.piiFieldsExposed).toBe(2);

    // The prompt template's PII grounding is a headline exposure.
    const promptPii = d.piiExposures.find(
      (e) => e.surfaceId === 'GenAiPromptTemplate:Draft_Loyalty_Followup' && e.fieldApiName === 'SSN__c',
    );
    expect(promptPii).toBeDefined();
    expect(promptPii?.classification).toBe('pii');
    expect(promptPii?.via).toContain('prompt-grounding-field');

    // The agent transitively exposes the Apex-read PII field via plugin->function.
    const agentPii = d.piiExposures.find(
      (e) => e.surfaceId === 'GenAiPlannerBundle:Order_Support_Agent' && e.fieldApiName === 'Ship_To_SSN__c',
    );
    expect(agentPii).toBeDefined();
    expect(agentPii?.via).toContain('apex-action-read');

    // Bot rolls up the same planner PII + its own context-variable field.
    const botPii = d.piiExposures.find(
      (e) => e.surfaceId === 'Bot:Order_Support_Bot' && e.fieldApiName === 'Ship_To_SSN__c',
    );
    expect(botPii).toBeDefined();
    expect(botPii?.via).toContain('bot-version-planner');
    expect(botPii?.via).toContain('apex-action-read');
    const botSurface = d.surfaces.find((s) => s.id === 'Bot:Order_Support_Bot');
    const ctxField = botSurface?.exposedFields.find((f) => f.fieldApiName === 'EndUserContactId');
    expect(ctxField?.via).toContain('bot-context-variable');
    expect(ctxField?.via).toContain('bot-context-in-prompt');

    expect(r.value.data.trust.provenance).toBe('offline_snapshot');
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
    expect(r.value.data.boundaries.some((b) => b.includes('NOT YET composed'))).toBe(false);
  });

  it('classifies an unmodeled grounded field as unknown, never "not PII"', async () => {
    const r = await aiExposureReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const promptSurface = r.value.data.surfaces.find(
      (s) => s.id === 'GenAiPromptTemplate:Draft_Loyalty_Followup',
    );
    const unmodeled = promptSurface?.exposedFields.find((f) => f.fieldApiName === 'Unmodeled__c');
    expect(unmodeled?.classification).toBe('unknown');
    expect(unmodeled?.modeled).toBe(false);
    // Completeness is downgraded to partial when an unknown field is present.
    expect(r.value.data.trust.completeness.status).toBe('partial');
  });
});

describe('aiExposureReportHandler — object filter', () => {
  it('narrows surfaces + exposures to fields on the named object', async () => {
    const r = await aiExposureReportHandler(ctx, { objectApiName: 'Contact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.scope.mode).toBe('object');
    expect(d.scope.objectApiName).toBe('Contact');
    // Every exposed field in every surface is on Contact.
    for (const s of d.surfaces) {
      for (const f of s.exposedFields) expect(f.objectApiName).toBe('Contact');
    }
    // The Order__c Apex-read surfaces drop out entirely (no Contact fields).
    expect(d.surfaces.some((s) => s.id === 'GenAiPlannerBundle:Order_Support_Agent')).toBe(false);
    // Only the Contact PII field remains flagged.
    expect(d.piiExposures.every((e) => e.objectApiName === 'Contact')).toBe(true);
  });
});

describe('aiExposureReportHandler — fail closed', () => {
  it('returns no-ai-surface-modeled (not an empty org) when the vault has zero GenAI nodes', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'sfi-ai-empty-'));
    const opened = await openGraph(join(emptyDir, 'empty.db'));
    if (!opened.ok) throw new Error('openGraph failed');
    const emptyStore = opened.value;
    // Seed a NON-GenAI node so the vault is clearly not empty overall.
    await importExtractionResults(emptyStore, [
      { nodes: [node('CustomObject:Account', 'CustomObject', 'Account', {})], edges: [] },
    ]);
    const emptyCtx = { vaultRoot: emptyDir, manifest: manifest('empty'), graph: emptyStore } as Context;
    try {
      const r = await aiExposureReportHandler(emptyCtx, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.disposition).toBe('no-ai-surface-modeled');
      expect(r.value.data.message).toBe(
        'no AI surface modeled — either the org has none or the vault predates GenAI/Bot extraction (re-run /sfi-refresh)',
      );
      expect(r.value.data.surfaces).toHaveLength(0);
      expect(r.value.data.summary.promptTemplates).toBe(0);
    } finally {
      await closeGraph(emptyStore);
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// AI-EXPOSURE-ANSWERS-FOR-AN-OBJECT-IT-NEVER-FOUND (0.3.3).
//
// `objectApiName` was applied as a raw string compare against each exposed
// field's parsed object (`parts.object !== objectFilter`) with NO check that the
// object exists. Ask about `Zzz_Nonexistent_Object_9x7__c` and the compare
// matched nothing, so the tool answered `disposition: 'ai-surface-modeled'`,
// `surfaces: []`, `piiExposures: []`, `piiFieldsExposed: 0` — a confident
// SECURITY answer ("nothing on this object is exposed to your org's AI") about
// an object it never found. The same unchecked zero the 0.3.2 changelog named
// for `unused_fields_deep`.
//
// The raw compare was also case-SENSITIVE, so a real object typed `contact`
// produced the identical false all-clear.
// =============================================================================
describe('aiExposureReportHandler — unresolvable object scope', () => {
  const PHANTOM = 'Zzz_Nonexistent_Object_9x7__c';

  it('refuses an object that exists nowhere in the vault, never reports "nothing exposed"', async () => {
    const r = await aiExposureReportHandler(ctx, { objectApiName: PHANTOM });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain(PHANTOM);
  });

  it('refuses the same phantom passed as a CustomObject: id', async () => {
    const r = await aiExposureReportHandler(ctx, { objectApiName: `CustomObject:${PHANTOM}` });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('a REAL object in the wrong case still answers, echoed in the vault casing', async () => {
    const lower = await aiExposureReportHandler(ctx, { objectApiName: 'contact' });
    const exact = await aiExposureReportHandler(ctx, { objectApiName: 'Contact' });
    expect(lower.ok && exact.ok).toBe(true);
    if (!lower.ok || !exact.ok) return;
    expect(lower.value.data.scope).toEqual({ mode: 'object', objectApiName: 'Contact' });
    expect(lower.value.data.piiExposures.map((e) => e.fieldId).sort()).toEqual(
      exact.value.data.piiExposures.map((e) => e.fieldId).sort(),
    );
    expect(lower.value.data.piiExposures.length).toBeGreaterThan(0);
  });

  it('REGRESSION: the bare org-wide call is untouched by the existence gate', async () => {
    const r = await aiExposureReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.scope).toEqual({ mode: 'org-wide' });
    expect(d.disposition).toBe('ai-surface-modeled');
    expect(d.summary.piiFieldsExposed).toBe(2);
    expect(d.summary.bots).toBe(1);
  });
});
