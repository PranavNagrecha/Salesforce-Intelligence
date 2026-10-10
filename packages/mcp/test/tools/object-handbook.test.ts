/// <reference types="vitest/globals" />
/**
 * `sfi.object_360 { format: 'handbook' }` — the single-object brief for a new
 * team member (WOW-9). Before this format existed, "document this object for a
 * new hire" had two answers: an org-wide onboarding doc, or the sectioned
 * object_360 accounting cut to 3 rows per section of mostly caveats.
 *
 * Pinned here: every promised section renders with REAL content, lists are
 * ranked then capped with the true total, the save sequence says which event
 * each step fires on, empty sections say what was checked, and a wide object
 * still fits the handbook byte budget.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExtendedVaultManifest } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { generateOnboardingDocInputSchema } from '../../src/tools/generate-onboarding-doc.js';
import { object360Handler, object360InputSchema } from '../../src/tools/object-360.js';
import { HANDBOOK_BYTE_BUDGET } from '../../src/tools/object-handbook.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

/**
 * Pass-through over the real save tool. `failPhaseRefetch` makes the
 * `phase`-filtered recovery call fail, which is the only way to leave a phase
 * short after the handbook's refetch (the filtered call never sheds steps).
 */
const soeControl = vi.hoisted(() => ({ failPhaseRefetch: false }));
vi.mock('../../src/tools/what-happens-on-save.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/tools/what-happens-on-save.js')>();
  const wrapped: typeof real.whatHappensOnSaveHandler = async (c, input) =>
    soeControl.failPhaseRefetch && input.phase !== undefined
      ? { ok: false, error: { kind: 'invalid-query', message: 'forced refetch failure (test)' } }
      : real.whatHappensOnSaveHandler(c, input);
  return { ...real, whatHappensOnSaveHandler: wrapped };
});

const MANIFEST: ExtendedVaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 3 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 3, errored: false, neverModeled: false },
    { type: 'RecordType', requested: true, retrieved: 2, errored: false, neverModeled: false },
  ],
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const OBJ = 'CustomObject:Gadget__c';
const F = 'CustomField:Gadget__c';

/** Filler fields so ranking and capping have something to rank. */
const FILLER = 30;

const seed: ExtractionResult = (() => {
  const nodes: Node[] = [
    node({
      id: OBJ,
      type: 'CustomObject',
      apiName: 'Gadget__c',
      label: 'Gadget',
      properties: { description: 'Tracks every gadget we ship.', pluralLabel: 'Gadgets', sharingModel: 'Private', externalSharingModel: 'Private' },
    }),
    node({ id: `${F}.Code__c`, type: 'CustomField', apiName: 'Code__c', label: 'Code', parentId: OBJ, properties: { dataType: 'Text', externalId: true, unique: true, description: 'Key from the upstream catalog.' } }),
    node({
      id: `${F}.Stage__c`,
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: OBJ,
      properties: {
        dataType: 'Picklist',
        inlineHelpText: 'Where the gadget is in its life.',
        picklistValues: [
          { value: 'Draft', isActive: true },
          { value: 'Shipped', isActive: true },
          { value: 'Legacy', isActive: false },
        ],
      },
    }),
    node({ id: `${F}.Region__c`, type: 'CustomField', apiName: 'Region__c', parentId: OBJ, properties: { dataType: 'Picklist', valueSetName: 'Regions', picklistValues: null } }),
    node({ id: `${F}.Status`, type: 'CustomField', apiName: 'Status', parentId: OBJ, properties: { dataType: 'Picklist', picklistValues: null } }),
    node({ id: `${F}.Account__c`, type: 'CustomField', apiName: 'Account__c', parentId: OBJ, properties: { dataType: 'Lookup', referenceTo: 'Account' } }),
    node({ id: `${F}.CreatedById`, type: 'CustomField', apiName: 'CreatedById', parentId: OBJ, properties: { dataType: 'Lookup', referenceTo: 'User', synthetic: true, system: true } }),
    node({ id: 'RecordType:Gadget__c.Retail', type: 'RecordType', apiName: 'Gadget__c.Retail', label: 'Retail', parentId: OBJ, properties: { active: true, businessProcess: 'Retail Flow' } }),
    node({ id: 'RecordType:Gadget__c.Old', type: 'RecordType', apiName: 'Gadget__c.Old', label: 'Old', parentId: OBJ, properties: { active: false } }),
    node({ id: 'CustomField:Part__c.Gadget__c', type: 'CustomField', apiName: 'Gadget__c', parentId: 'CustomObject:Part__c', properties: { dataType: 'MasterDetail', referenceTo: 'Gadget__c' } }),
    node({ id: 'CustomObject:Part__c', type: 'CustomObject', apiName: 'Part__c' }),
    // Save sequence.
    node({ id: 'Flow:Gadget_Before_Create', type: 'Flow', apiName: 'Gadget_Before_Create', properties: { status: 'Active' } }),
    node({ id: 'Flow:Gadget_After_Update', type: 'Flow', apiName: 'Gadget_After_Update', properties: { status: 'Active' } }),
    node({ id: 'Flow:Gadget_Retired', type: 'Flow', apiName: 'Gadget_Retired', properties: { status: 'Obsolete' } }),
    node({ id: 'ApexTrigger:GadgetTriggerA', type: 'ApexTrigger', apiName: 'GadgetTriggerA', properties: { triggerObject: 'Gadget__c', events: ['before insert', 'before update', 'after insert'] } }),
    node({ id: 'ApexTrigger:GadgetTriggerB', type: 'ApexTrigger', apiName: 'GadgetTriggerB', properties: { triggerObject: 'Gadget__c', events: ['before update'] } }),
    // Runs on delete only — outside the insert/update sequence, still named.
    node({ id: 'ApexTrigger:GadgetMergeTrigger', type: 'ApexTrigger', apiName: 'GadgetMergeTrigger', properties: { triggerObject: 'Gadget__c', events: ['after delete'] } }),
    // Inactive on UPDATE only, beside the inactive create flow: two distinct inactive components.
    node({ id: 'Flow:Gadget_Draft_Update', type: 'Flow', apiName: 'Gadget_Draft_Update', properties: { status: 'Draft' } }),
    // An entry that grants nothing is not access.
    node({ id: 'Profile:NoAccess', type: 'Profile', apiName: 'NoAccess' }),
    node({ id: 'ValidationRule:Gadget__c.Code_Required', type: 'ValidationRule', apiName: 'Code_Required', parentId: OBJ, properties: { active: true, errorMessage: 'Enter a code before shipping.', errorDisplayField: 'Code__c' } }),
    // Access.
    node({ id: 'Profile:Builder', type: 'Profile', apiName: 'Builder' }),
    node({ id: 'Profile:Viewer', type: 'Profile', apiName: 'Viewer' }),
    node({ id: 'PermissionSet:Gadget_Admin', type: 'PermissionSet', apiName: 'Gadget_Admin' }),
    // Integrations.
    node({ id: 'ApexClass:GadgetApi', type: 'ApexClass', apiName: 'GadgetApi', properties: { isRestResource: true } }),
    node({ id: 'ApexClass:GadgetHelper', type: 'ApexClass', apiName: 'GadgetHelper', properties: { isRestResource: false } }),
    node({ id: 'PlatformEventChannelMember:ChangeEvents_Gadget', type: 'PlatformEventChannelMember', apiName: 'ChangeEvents_Gadget' }),
  ];
  const edges: Edge[] = [
    edge({ fromId: 'CustomField:Part__c.Gadget__c', toId: OBJ, edgeType: 'lookupTo', properties: { relationshipType: 'MasterDetail' } }),
    edge({ fromId: OBJ, toId: 'ValidationRule:Gadget__c.Code_Required', edgeType: 'parentOf' }),
    edge({ fromId: 'Flow:Gadget_Before_Create', toId: OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordBeforeSave', recordTriggerType: 'Create' } }),
    edge({ fromId: 'Flow:Gadget_After_Update', toId: OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'Update' } }),
    edge({ fromId: 'Flow:Gadget_Retired', toId: OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'Create' } }),
    edge({ fromId: 'ApexTrigger:GadgetTriggerA', toId: OBJ, edgeType: 'triggersOn', properties: { events: ['before insert', 'before update', 'after insert'] } }),
    edge({ fromId: 'ApexTrigger:GadgetTriggerB', toId: OBJ, edgeType: 'triggersOn', properties: { events: ['before update'] } }),
    edge({ fromId: 'ApexTrigger:GadgetMergeTrigger', toId: OBJ, edgeType: 'triggersOn', properties: { events: ['after delete'] } }),
    edge({ fromId: 'Flow:Gadget_Draft_Update', toId: OBJ, edgeType: 'triggersOn', properties: { triggerType: 'RecordAfterSave', recordTriggerType: 'Update' } }),
    edge({ fromId: 'Profile:NoAccess', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: false, allowCreate: false, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false } }),
    edge({ fromId: 'Profile:Builder', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: true, viewAllRecords: true, modifyAllRecords: true } }),
    edge({ fromId: 'Profile:Viewer', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowCreate: false, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false } }),
    edge({ fromId: 'PermissionSet:Gadget_Admin', toId: OBJ, edgeType: 'grantedBy', properties: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: false, viewAllRecords: false, modifyAllRecords: false } }),
    edge({ fromId: 'ApexClass:GadgetApi', toId: `${F}.Code__c`, edgeType: 'readsFrom', confidence: 'parsed' }),
    edge({ fromId: 'ApexClass:GadgetHelper', toId: `${F}.Stage__c`, edgeType: 'writesTo', confidence: 'parsed' }),
    edge({ fromId: 'PlatformEventChannelMember:ChangeEvents_Gadget', toId: 'CustomObject:Gadget__ChangeEvent', edgeType: 'references' }),
  ];
  // Stage__c is the most-referenced field; Region__c next.
  for (let i = 0; i < 5; i += 1) {
    nodes.push(node({ id: `Layout:Gadget__c.L${i}`, type: 'Layout', apiName: `L${i}`, parentId: OBJ }));
    edges.push(edge({ fromId: `Layout:Gadget__c.L${i}`, toId: `${F}.Stage__c`, edgeType: 'references' }));
    if (i < 3) edges.push(edge({ fromId: `Layout:Gadget__c.L${i}`, toId: `${F}.Region__c`, edgeType: 'references' }));
  }
  for (let i = 0; i < FILLER; i += 1) {
    nodes.push(node({ id: `${F}.Filler_${String(i).padStart(2, '0')}__c`, type: 'CustomField', apiName: `Filler_${String(i).padStart(2, '0')}__c`, parentId: OBJ, properties: { dataType: 'Text' } }));
  }
  return { nodes, edges };
})();

/**
 * A save-heavy object: more active validation rules (with long messages) than
 * the save tool's own budget holds, so its un-filtered view sheds steps and
 * names them in `phasesOmitted`.
 */
const HEAVY_VR_COUNT = 160;
const heavySeed: ExtractionResult = (() => {
  const H = 'CustomObject:Heavy__c';
  const nodes: Node[] = [node({ id: H, type: 'CustomObject', apiName: 'Heavy__c' })];
  const edges: Edge[] = [];
  for (let i = 0; i < HEAVY_VR_COUNT; i += 1) {
    const pad = String(i).padStart(3, '0');
    const id = `ValidationRule:Heavy__c.Rule_${pad}`;
    nodes.push(node({ id, type: 'ValidationRule', apiName: `Rule_${pad}`, parentId: H, properties: { active: true, errorMessage: `Rule ${pad} blocks the save when the synthetic roster is inconsistent — padding text for byte bulk.` } }));
    edges.push(edge({ fromId: H, toId: id, edgeType: 'parentOf' }));
  }
  nodes.push(node({ id: 'ApexTrigger:HeavyTrigger', type: 'ApexTrigger', apiName: 'HeavyTrigger', properties: { triggerObject: 'Heavy__c', events: ['after insert', 'after update'] } }));
  edges.push(edge({ fromId: 'ApexTrigger:HeavyTrigger', toId: H, edgeType: 'triggersOn', properties: { events: ['after insert', 'after update'] } }));
  return { nodes, edges };
})();

/**
 * Lookups as a source-only standard object carries them offline: no captured
 * target, a polymorphic target list, and a field whose type was not captured.
 */
const memoSeed: ExtractionResult = (() => {
  const M = 'CustomObject:Memo__c';
  const fid = (n: string): string => `CustomField:Memo__c.${n}`;
  return {
    nodes: [
      node({ id: M, type: 'CustomObject', apiName: 'Memo__c' }),
      node({ id: fid('ParentId'), type: 'CustomField', apiName: 'ParentId', parentId: M, properties: { dataType: 'Lookup' } }),
      node({ id: fid('RelatedToId'), type: 'CustomField', apiName: 'RelatedToId', parentId: M, properties: { dataType: 'Lookup', referenceTargets: [] } }),
      node({ id: fid('OwnerId'), type: 'CustomField', apiName: 'OwnerId', parentId: M, properties: { dataType: 'Lookup', referenceTargets: ['User', 'Group'] } }),
      node({ id: fid('Subject'), type: 'CustomField', apiName: 'Subject', parentId: M, properties: { dataType: 'Unknown' } }),
    ],
    edges: [],
  };
})();

/** A label so long that even the tightest caps cannot fit the budget. */
const hugeLabelSeed: ExtractionResult = {
  nodes: [node({ id: 'CustomObject:Longname__c', type: 'CustomObject', apiName: 'Longname__c', label: 'L'.repeat(HANDBOOK_BYTE_BUDGET + 2_000) })],
  edges: [],
};

/** An object with nothing on it but a name — every section must say what was checked. */
const bareSeed: ExtractionResult = {
  nodes: [node({ id: 'CustomObject:Bare__c', type: 'CustomObject', apiName: 'Bare__c' })],
  edges: [],
};

/** A wide object: many fields with long help text, many grants, many children. */
const wideSeed: ExtractionResult = (() => {
  const W = 'CustomObject:Huge__c';
  const nodes: Node[] = [node({ id: W, type: 'CustomObject', apiName: 'Huge__c' })];
  const edges: Edge[] = [];
  for (let i = 0; i < 400; i += 1) {
    const pad = String(i).padStart(3, '0');
    nodes.push(
      node({
        id: `CustomField:Huge__c.F${pad}__c`,
        type: 'CustomField',
        apiName: `F${pad}__c`,
        parentId: W,
        properties: {
          dataType: i % 4 === 0 ? 'Picklist' : 'Text',
          inlineHelpText: 'x'.repeat(400),
          picklistValues: i % 4 === 0 ? Array.from({ length: 60 }, (_, v) => ({ value: `Value number ${v} ${'y'.repeat(30)}`, isActive: true })) : null,
          ...(i % 3 === 0 ? { referenceTo: `Target${pad}__c` } : {}),
        },
      }),
    );
    nodes.push(node({ id: `CustomField:Child${pad}__c.Huge__c`, type: 'CustomField', apiName: 'Huge__c', parentId: `CustomObject:Child${pad}__c`, properties: { referenceTo: 'Huge__c' } }));
    edges.push(edge({ fromId: `CustomField:Child${pad}__c.Huge__c`, toId: W, edgeType: 'lookupTo', properties: { relationshipType: 'Lookup' } }));
    const pid = `Profile:P${pad}`;
    nodes.push(node({ id: pid, type: 'Profile', apiName: `P${pad}` }));
    edges.push(edge({ fromId: pid, toId: W, edgeType: 'grantedBy', properties: { allowRead: true, allowEdit: true, modifyAllRecords: true } }));
    nodes.push(node({ id: `RecordType:Huge__c.RT${pad}`, type: 'RecordType', apiName: `Huge__c.RT${pad}`, parentId: W, properties: { active: true, description: 'z'.repeat(300) } }));
  }
  return { nodes, edges };
})();

let store: GraphStore;
let tempDir: string;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-object-handbook-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed, bareSeed, wideSeed, heavySeed, memoSeed, hugeLabelSeed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const handbook = async (apiName: string): Promise<Readonly<Record<string, unknown>>> => {
  const r = await object360Handler(ctx, { objectApiName: apiName, format: 'handbook' });
  if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`);
  return r.value.data;
};

/** The markdown block under one `## ` heading (heading line included). */
const section = (md: string, heading: string): string => {
  const start = md.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`no section "${heading}" in:\n${md}`);
  const next = md.indexOf('\n## ', start + 3);
  return next < 0 ? md.slice(start) : md.slice(start, next);
};

describe('object_360 format: handbook — the single-object brief', () => {
  it('accepts format in the input schema and rejects an unknown format', () => {
    expect(object360InputSchema.safeParse({ objectApiName: 'Gadget__c', format: 'handbook' }).success).toBe(true);
    expect(object360InputSchema.safeParse({ objectApiName: 'Gadget__c', format: 'pdf' }).success).toBe(false);
  });

  it('returns Markdown with every promised section, not the sectioned JSON', async () => {
    const data = await handbook('Gadget__c');
    expect(data['format']).toBe('handbook');
    expect(data['usage']).toBeUndefined();
    const md = String(data['markdown']);
    for (const h of [
      'What it is',
      'Key fields',
      'Picklists',
      'Record types',
      'Relationships',
      'What runs when a record is saved',
      'Who can access it',
      'Integrations touching it',
      'Risk signals',
      'Where to look next',
    ]) {
      expect(md).toContain(`## ${h}`);
    }
    expect(section(md, 'What it is')).toContain('Tracks every gadget we ship.');
  });

  it('ranks key fields: external id / unique first, then by references, with true totals', async () => {
    const md = String((await handbook('Gadget__c'))['markdown']);
    const keys = section(md, 'Key fields');
    // 35 non-system fields; the platform system field is counted, not listed.
    expect(keys).toContain('of 35');
    expect(keys).toContain('plus 1 platform system fields not listed');
    const order = ['Code__c', 'Stage__c', 'Region__c'].map((n) => keys.indexOf(`\`${n}\``));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(keys).toContain('external id, unique');
    expect(keys).toContain('Where the gadget is in its life.');
    const facts = (await handbook('Gadget__c'))['facts'] as Record<string, Record<string, number>>;
    expect(facts['fields']?.['externalId']).toBe(1);
    const truncation = (await handbook('Gadget__c'))['truncation'] as { section: string; total: number }[];
    expect(truncation.find((t) => t.section === 'keyFields')?.total).toBe(35);
  });

  it('lists ACTIVE picklist values and says where values live when the field carries none', async () => {
    const pick = section(String((await handbook('Gadget__c'))['markdown']), 'Picklists');
    expect(pick).toContain('`Stage__c`: 2 active value(s) — Draft · Shipped; 1 inactive');
    expect(pick).not.toContain('Legacy');
    expect(pick).toContain('global value set `Regions`');
    expect(pick).toMatch(/`Status`: values are not in the retrieved field metadata/);
  });

  it('separates business lookups from system lookups and names cascading children', async () => {
    const md = String((await handbook('Gadget__c'))['markdown']);
    const rel = section(md, 'Relationships');
    expect(rel).toContain('`Account__c` → `Account`');
    expect(rel).toContain('1 platform system lookup(s): `CreatedById`');
    expect(rel).toContain('`Part__c` via `Gadget__c` (1 master-detail — deletes cascade)');
    const rts = section(md, 'Record types');
    expect(rts).toContain('2 total, 1 active');
    expect(rts).toContain('business process `Retail Flow`');
    expect(rts).toContain('(inactive)');
  });

  it('orders the save sequence and tags each step with the events it fires on', async () => {
    const save = section(String((await handbook('Gadget__c'))['markdown']), 'What runs when a record is saved');
    expect(save).toContain('`Gadget_Before_Create` [insert]');
    expect(save).toContain('`Gadget_After_Update` [update]');
    expect(save).toContain('`GadgetTriggerA` [insert+update]');
    // The same trigger ALSO runs after the write on insert — a per-component
    // merge dropped this second phase.
    expect(section(save, 'What runs').split('the record is written')[1]).toContain('`GadgetTriggerA` [insert]');
    expect(save).toContain('blocks with "Enter a code before shipping."');
    expect(save.indexOf('Before-save flows')).toBeLessThan(save.indexOf('the record is written'));
    expect(save.indexOf('the record is written')).toBeLessThan(save.indexOf('After-save flows'));
    // One inactive on create, one on update: both are counted.
    expect(save).toContain('INACTIVE (does not run): 2 — 2 Flow');
    // GadgetTriggerA runs before AND after: one component, two steps.
    expect(save).toContain('(5 active component(s) in 6 step(s), in order)');
    expect(save).not.toContain('Gadget_Retired` [');
    expect(save).toContain('1 ApexClass');
  });

  it('summarises access per verb and names Modify All holders as a risk', async () => {
    const md = String((await handbook('Gadget__c'))['markdown']);
    const access = section(md, 'Who can access it');
    expect(access).toContain('2 profile(s), 1 permission set(s)');
    expect(access).toContain('- Create: 1 profile(s) (`Builder`), 1 permission set(s) (`Gadget_Admin`)');
    expect(access).toContain('- Modify All: 1 profile(s) (`Builder`), 0 permission set(s)');
    const risks = section(md, 'Risk signals');
    expect(risks).toContain('hold Modify All on this object');
    expect(risks).toContain('2 Apex triggers fire in the same phase');
    expect(risks).toContain('32 of 34 custom field(s) have neither a description nor help text');
  });

  it('finds REST resources and CDC enablement, and not plain Apex helpers', async () => {
    const integ = section(String((await handbook('Gadget__c'))['markdown']), 'Integrations touching it');
    expect(integ).toContain('`ApexClass:GadgetApi` — Apex REST resource');
    expect(integ).toContain('Change Data Capture is enabled');
    expect(integ).not.toContain('GadgetHelper');
  });

  it('says what was checked when a section is empty, never a bare "none"', async () => {
    const md = String((await handbook('Bare__c'))['markdown']);
    expect(md).toContain('No description is declared in the metadata.');
    expect(section(md, 'Integrations touching it')).toContain('None found among outbound messages');
    expect(section(md, 'Record types')).toContain('this empty result means "this object has no record types"');
    expect(section(md, 'Risk signals')).toContain('None of the checked signals fired');
  });

  it('refuses sections-only knobs with the handbook format, naming the fix', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Gadget__c', format: 'handbook', includeSections: ['usage'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('format: "sections"');
  });

  it('fits a wide object inside the handbook budget, with real rows and every cap disclosed', async () => {
    const data = await handbook('Huge__c');
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(HANDBOOK_BYTE_BUDGET);
    const md = String(data['markdown']);
    expect(section(md, 'Key fields')).toMatch(/`F\d{3}__c`/);
    expect(section(md, 'Relationships')).toMatch(/more child object\(s\)/);
    expect(section(md, 'Record types')).toMatch(/more record type\(s\) not shown/);
    const sections = (data['truncation'] as { section: string; shown: number; total: number }[]).map((t) => t.section);
    for (const s of ['keyFields', 'picklists', 'recordTypes', 'parents', 'children']) expect(sections).toContain(s);
    expect(String(data['truncationNote'])).toContain('TRUE total');
  });

  it('generate_onboarding_doc refuses an object scope instead of answering org-wide, and names the handbook', () => {
    // FAIL-BEFORE: the non-strict schema stripped `objectApiName` and the
    // whole-org tour came back for an object question.
    const parsed = generateOnboardingDocInputSchema.safeParse({ objectApiName: 'Gadget__c' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = parsed.error.issues.map((i) => i.message).join(' ');
    expect(message).toContain('sfi.object_360');
    expect(message).toContain('"format": "handbook"');
    expect(generateOnboardingDocInputSchema.safeParse({ personaFocus: 'developer' }).success).toBe(true);
  });

  it('leaves the default sections format unchanged', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Gadget__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data['markdown']).toBeUndefined();
    expect(r.value.data['usage']).toBeDefined();
  });
  it('counts a save phase the save tool had to shed — refetched in full, never the survivors', async () => {
    // Precondition: the save tool's own un-filtered view DOES drop steps here.
    const raw = await whatHappensOnSaveHandler(ctx, { componentId: 'CustomObject:Heavy__c', event: 'update', includeConceptReasoning: false });
    if (!raw.ok) throw new Error(raw.error.message);
    const omitted = raw.value.data.phasesOmitted ?? [];
    expect(omitted.find((o) => o.phase === 'pre-save-validation')?.declared).toBe(HEAVY_VR_COUNT);
    expect(omitted.find((o) => o.phase === 'pre-save-validation')?.present ?? 0).toBeLessThan(HEAVY_VR_COUNT);

    const data = await handbook('Heavy__c');
    const md = String(data['markdown']);
    const save = section(md, 'What runs when a record is saved');
    // FAIL-BEFORE: the heading and phase counted only the surviving steps.
    expect(save).toContain(`(${HEAVY_VR_COUNT + 1} active component(s) in ${HEAVY_VR_COUNT + 1} step(s), in order)`);
    expect(save).toContain(`**Validation rules** (${HEAVY_VR_COUNT})`);
    expect(save).not.toContain('at least');
    expect(section(md, 'Risk signals')).toContain(`${HEAVY_VR_COUNT} active validation rule(s)`);
    const facts = data['facts'] as Record<string, Record<string, unknown>>;
    expect(facts['saveSequence']).toMatchObject({ activeComponents: HEAVY_VR_COUNT + 1, steps: HEAVY_VR_COUNT + 1, complete: true });
    const row = (data['truncation'] as { section: string; total: number }[]).find((t) => t.section === 'save.pre-save-validation');
    expect(row?.total).toBe(HEAVY_VR_COUNT);
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(HANDBOOK_BYTE_BUDGET);
  });

  it('reports a phase still short after the refetch as a LOWER bound, never as the true total', async () => {
    soeControl.failPhaseRefetch = true;
    try {
      const data = await handbook('Heavy__c');
      const md = String(data['markdown']);
      const save = section(md, 'What runs when a record is saved');
      // The total still comes from the save tool's declared count, not the survivors.
      expect(save).toMatch(new RegExp(`\\(at least \\d+ active component\\(s\\) in at least ${HEAVY_VR_COUNT + 1} step\\(s\\)`));
      expect(save).toContain(`**Validation rules** (at least ${HEAVY_VR_COUNT})`);
      expect(save).toContain('could not list them all');
      expect(section(md, 'Risk signals')).toContain(`at least ${HEAVY_VR_COUNT} active validation rule(s)`);
      const facts = data['facts'] as Record<string, Record<string, unknown>>;
      expect(facts['saveSequence']).toMatchObject({ complete: false, incompletePhases: ['pre-save-validation'] });
      const row = (data['truncation'] as { section: string; total: number; atLeast?: boolean }[]).find((t) => t.section === 'save.pre-save-validation');
      expect(row).toMatchObject({ total: HEAVY_VR_COUNT, atLeast: true });
      expect(String(data['truncationNote'])).toContain('lower bound');
    } finally {
      soeControl.failPhaseRefetch = false;
    }
  });

  it('keeps lookups whose target was not captured, and says so instead of reporting none', async () => {
    const data = await handbook('Memo__c');
    const md = String(data['markdown']);
    const rel = section(md, 'Relationships');
    // FAIL-BEFORE: ParentId was dropped and the heading read 1 (or 0) lookup(s).
    expect(rel).toContain('3 lookup field(s) to parents, 2 with target not captured');
    expect(rel).toContain('`ParentId` → target not captured (Lookup)');
    expect(rel).toContain('`RelatedToId` → target not captured (Lookup)');
    expect(rel).toContain('`OwnerId` → `User` / `Group` (Lookup)');
    expect(rel).not.toContain('No business lookup');
    const keys = section(md, 'Key fields');
    expect(keys).toContain('`OwnerId` (Lookup; → `User` / `Group`)');
    expect(keys).toContain('`Subject` (type not captured)');
    expect(keys).not.toContain('(Unknown');
    expect((data['facts'] as Record<string, Record<string, number>>)['relationships']).toMatchObject({ parentLookups: 3, parentTargetNotCaptured: 2 });
  });

  it('names delete / undelete automation that the insert/update sequence leaves out', async () => {
    const save = section(String((await handbook('Gadget__c'))['markdown']), 'What runs when a record is saved');
    expect(save).toContain('delete: 1 step(s) from 1 component(s) (`GadgetMergeTrigger`)');
    expect(save).toContain('undelete: none modeled');
  });

  it('counts only granters that grant at least one verb', async () => {
    const access = section(String((await handbook('Gadget__c'))['markdown']), 'Who can access it');
    // FAIL-BEFORE: the all-false NoAccess entry made this 3 profiles.
    expect(access).toContain('(2 profile(s), 1 permission set(s) grant at least one object permission)');
  });

  it('carries the reference-count boundary, plus the coverage caveat when nothing points at the object', async () => {
    const data = await handbook('Bare__c');
    const md = String(data['markdown']);
    expect(md).toContain('never proof of disuse');
    const caveat = data['coverageCaveat'] as { message: string } | undefined;
    expect(caveat).toBeDefined();
    expect(md).toContain(String(caveat?.message));
    // An object WITH usage edges carries the boundary but no empty-traversal caveat.
    const gadget = await handbook('Gadget__c');
    expect(gadget['coverageCaveat']).toBeUndefined();
    expect(String(gadget['markdown'])).toContain('never proof of disuse');
  });

  it('says so when even the tightest caps cannot fit the budget', async () => {
    const data = await handbook('Longname__c');
    expect(data['overBudget']).toMatchObject({ budgetBytes: HANDBOOK_BYTE_BUDGET });
    expect((data['overBudget'] as { bytes: number }).bytes).toBeGreaterThan(HANDBOOK_BYTE_BUDGET);
    // A brief that fits carries no such marker.
    expect((await handbook('Gadget__c'))['overBudget']).toBeUndefined();
  });
});
