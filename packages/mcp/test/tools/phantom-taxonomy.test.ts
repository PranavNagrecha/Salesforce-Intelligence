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
import { getComponentHandler } from '../../src/tools/get-component.js';
import {
  buildReferenceStub,
  classifyPhantom,
  managedNamespaceOf,
} from '../../src/tools/phantom-taxonomy.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-03T12:00:00.000Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, ApexTrigger: 1 },
  edges: {},
  sourceTreeHash: 'sha256:phantom-tax',
  coverageComputedAt: '2026-06-03T12:01:00.000Z',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'ApexTrigger', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'WorkflowAlert', requested: false, retrieved: 0, errored: false, neverModeled: true },
  ],
};

const node = (id: string, type: Node['type']): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const edge = (
  fromId: string,
  edgeType: Edge['edgeType'],
  toId: string,
  confidence: Edge['confidence'] = 'declared',
): Edge => ({ fromId, toId, edgeType, confidence, source: 'test', properties: {} });

// One real object + a trigger, plus dangling edges of every phantom class.
const SEED: ExtractionResult = {
  nodes: [node('CustomObject:Acme_Order__c', 'CustomObject'), node('ApexTrigger:Acme_Trig', 'ApexTrigger')],
  edges: [
    edge('ApexTrigger:Acme_Trig', 'triggersOn', 'CustomObject:Acme_Auto__c'), // automation-critical
    edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:Acme_Grant__c'), // grant-only
    edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:ns__Managed__c'), // managed-extension (precedence over grant)
    edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:Account'), // standard-field-phantom
    edge('WorkflowRule:Acme_WR', 'references', 'WorkflowAlert:Acme.Alert1'), // blindspot-manifest (type notModeled)
    edge('ApexClass:Acme_Svc', 'readsFrom', 'CustomObject:Acme_Misc__c', 'heuristic'), // unknown (only a heuristic functional ref)
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-phantom-tax-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('classifyPhantom + managedNamespaceOf', () => {
  it('detects managed namespace only for ns__Object__c', () => {
    expect(managedNamespaceOf('CustomObject:ns__Managed__c')).toBe('ns');
    expect(managedNamespaceOf('CustomObject:Acme_Order__c')).toBeUndefined();
    expect(managedNamespaceOf('CustomObject:Account')).toBeUndefined();
  });

  it('applies the bucket precedence', () => {
    expect(classifyPhantom('WorkflowAlert:X.Y', ['references'], ['references'], 'notModeled')).toBe('blindspot-manifest');
    expect(classifyPhantom('CustomObject:ns__M__c', ['grantedBy'], ['grantedBy'], 'covered')).toBe('managed-extension');
    expect(classifyPhantom('CustomObject:Account', ['grantedBy'], ['grantedBy'], 'covered')).toBe('standard-field-phantom');
    // P14-PHANTOM-edges: a LOWERCASE no-__ object part is an un-type-resolved
    // Apex local variable (CustomField:app.Id), NEVER a standard object — it
    // must not get the "treat it as standard" remedy. Falls to its honest
    // bucket instead (unknown here: only a heuristic functional ref).
    expect(classifyPhantom('CustomField:app.Id', ['readsFrom'], [], 'covered')).toBe('unknown');
    expect(classifyPhantom('CustomField:application.Status__c', ['readsFrom'], [], 'covered')).toBe('unknown');
    expect(classifyPhantom('CustomObject:Foo__c', ['grantedBy'], ['grantedBy'], 'covered')).toBe('grant-only');
    expect(classifyPhantom('CustomObject:Foo__c', ['triggersOn'], ['triggersOn'], 'covered')).toBe('automation-critical');
    // A functional ref present only at heuristic confidence is NOT automation-critical.
    expect(classifyPhantom('CustomObject:Foo__c', ['triggersOn'], [], 'covered')).toBe('unknown');
    // Only non-functional kinds (grant + layout) → unknown (not grant-only — has layout too).
    expect(classifyPhantom('CustomObject:Foo__c', ['grantedBy', 'usedInLayout'], ['grantedBy', 'usedInLayout'], 'covered')).toBe('unknown');
    // standard-field-phantom is SCHEMA-only. A no-`__` object part on a NON-schema
    // id is NOT a standard field — e.g. `ApexClass:newMap` (a Trigger.newMap parse
    // artifact, heuristic callsApex only) → unknown, not standard-field-phantom.
    expect(classifyPhantom('ApexClass:newMap', ['callsApex'], [], 'covered')).toBe('unknown');
    // A CustomField on a standard object still classifies as standard-field-phantom.
    expect(classifyPhantom('CustomField:Account.Name', ['readsFrom'], ['readsFrom'], 'covered')).toBe('standard-field-phantom');
    // A phantom RecordType with no `__` is not a standard field either.
    expect(classifyPhantom('RecordType:Account.Foo', ['references'], [], 'covered')).toBe('unknown');
  });
});

describe('buildReferenceStub', () => {
  const cases: Array<[string, string, boolean, string | undefined]> = [
    ['CustomObject:Acme_Auto__c', 'automation-critical', true, undefined],
    ['CustomObject:Acme_Grant__c', 'grant-only', false, undefined],
    ['CustomObject:ns__Managed__c', 'managed-extension', false, 'ns'],
    ['CustomObject:Account', 'standard-field-phantom', false, undefined],
    ['WorkflowAlert:Acme.Alert1', 'blindspot-manifest', false, undefined],
    ['CustomObject:Acme_Misc__c', 'unknown', false, undefined],
  ];
  it.each(cases)('classifies %s as %s', async (id, classification, demandRetrievable, namespace) => {
    const stub = await buildReferenceStub(ctx, id);
    expect(stub).not.toBeNull();
    expect(stub?.classification).toBe(classification);
    expect(stub?.demandRetrievable).toBe(demandRetrievable);
    expect(stub?.namespace).toBe(namespace);
    expect(stub?.tier).toBe('stub');
    expect(stub?.referenceCount).toBeGreaterThanOrEqual(1);
    expect(stub?.remedy.length).toBeGreaterThan(0);
  });

  it('returns null for a genuinely-unknown id (no inbound edges)', async () => {
    expect(await buildReferenceStub(ctx, 'CustomObject:NoSuchThing__c')).toBeNull();
  });
});

describe('get_component returns a classified stub for a phantom', () => {
  it('a grant-only phantom yields component-not-found with error.stub', async () => {
    const r = await getComponentHandler(ctx, { id: 'CustomObject:Acme_Grant__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.stub?.classification).toBe('grant-only');
    expect(r.error.stub?.demandRetrievable).toBe(false);
  });

  it('an automation-critical phantom marks the stub demand-retrievable', async () => {
    const r = await getComponentHandler(ctx, { id: 'CustomObject:Acme_Auto__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.stub?.classification).toBe('automation-critical');
    expect(r.error.stub?.demandRetrievable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CHANGEEVENT-IS-NOT-A-RETRIEVE-GAP
//
// A `CustomObject:{X}ChangeEvent` dangling target used to fall through to the
// coverage/edge-shape buckets: `AccountChangeEvent` (no `__`, PascalCase) came
// out `standard-field-phantom` — "treat it as standard" — while
// `Order__ChangeEvent` reached by an automation edge came out
// `automation-critical`, i.e. DEMAND-RETRIEVABLE. Both remedies are impossible:
// the platform synthesises a Change Event and the Metadata API emits no
// component for it, so no refresh on any org can produce the node. The
// automation-critical verdict is what made the refresh re-request the same
// entity forever.
// ---------------------------------------------------------------------------

const CHANGE_EVENT_SEED: ExtractionResult = {
  nodes: [node('ApexTrigger:Cdc_Trig', 'ApexTrigger'), node('PermissionSet:Acme_PS2', 'PermissionSet')],
  edges: [
    // Standard CDC reached by a permission grant (the shape a real vault shows).
    edge('PermissionSet:Acme_PS2', 'grantedBy', 'CustomObject:AccountChangeEvent'),
    // Custom CDC reached by an Apex CDC trigger's declared object binding.
    edge('ApexTrigger:Cdc_Trig', 'triggersOn', 'CustomObject:Order__ChangeEvent'),
    // Managed CDC stream — namespaced, same structural verdict.
    edge('PlatformEventChannelMember:M', 'references', 'CustomObject:ns__Widget__ChangeEvent'),
  ],
};

describe('phantom taxonomy — Change Data Capture entities are structural, not a coverage gap', () => {
  let cdcDir: string;
  let cdcStore: GraphStore;
  let cdcCtx: Context;

  beforeAll(async () => {
    cdcDir = mkdtempSync(join(tmpdir(), 'sfi-phantom-cdc-'));
    const opened = await openGraph(join(cdcDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    cdcStore = opened.value;
    const imp = await importExtractionResults(cdcStore, [CHANGE_EVENT_SEED]);
    if (!imp.ok) throw new Error(imp.error.message);
    cdcCtx = { vaultRoot: cdcDir, manifest: MANIFEST, graph: cdcStore };
  });
  afterAll(async () => {
    await closeGraph(cdcStore);
    rmSync(cdcDir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: classifies every ChangeEvent shape as change-event-stream', () => {
    // Standard CDC: previously `standard-field-phantom` ("treat it as standard").
    expect(classifyPhantom('CustomObject:AccountChangeEvent', ['grantedBy'], ['grantedBy'], 'covered')).toBe('change-event-stream');
    // Custom CDC on an automation edge: previously `automation-critical`, i.e.
    // a demand-retrieve candidate the retrieve can never satisfy.
    expect(classifyPhantom('CustomObject:Order__ChangeEvent', ['triggersOn'], ['triggersOn'], 'covered')).toBe('change-event-stream');
    // Managed CDC: previously `managed-extension`.
    expect(classifyPhantom('CustomObject:ns__Widget__ChangeEvent', ['references'], ['references'], 'covered')).toBe('change-event-stream');
    // Precedence: the verdict does not depend on coverage — a "widen the
    // manifest" remedy is just as impossible as "retrieve it".
    expect(classifyPhantom('CustomObject:CaseChangeEvent', ['references'], ['references'], 'notModeled')).toBe('change-event-stream');
  });

  it('does NOT capture a retrievable custom object whose name merely contains ChangeEvent', () => {
    expect(classifyPhantom('CustomObject:ChangeEvent_Log__c', ['triggersOn'], ['triggersOn'], 'covered')).toBe('automation-critical');
    expect(classifyPhantom('CustomObject:Signal__e', ['listensTo'], ['listensTo'], 'covered')).toBe('automation-critical');
  });

  it('a ChangeEvent stub is never demand-retrievable and its remedy never promises a refresh', async () => {
    for (const id of [
      'CustomObject:AccountChangeEvent',
      'CustomObject:Order__ChangeEvent',
      'CustomObject:ns__Widget__ChangeEvent',
    ]) {
      const stub = await buildReferenceStub(cdcCtx, id);
      expect(stub).not.toBeNull();
      if (stub === null) continue;
      expect(stub.classification).toBe('change-event-stream');
      // The load-bearing invariant: the product must not offer a fix-it it
      // cannot deliver. `sfi refresh` appears ONLY inside an explicit negation.
      expect(stub.demandRetrievable).toBe(false);
      expect(stub.remedy).toMatch(/no `sfi refresh`/);
      expect(stub.remedy).toMatch(/STRUCTURAL, not a coverage gap/);
    }
  });

  it('get_component answers a ChangeEvent with the structural fact, not a retrieve prompt', async () => {
    const result = await getComponentHandler(cdcCtx, {
      id: 'CustomObject:Order__ChangeEvent',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toMatch(/STRUCTURAL, not a coverage gap/);
    // Points at the component that IS retrievable: `Order__ChangeEvent` is the
    // CDC name for the custom object `Order__c` (the `__c` the name dropped).
    expect(result.error.message).toContain('CustomObject:Order__c');
    // Must NOT repeat the generic phantom remedy.
    expect(result.error.message).not.toMatch(/Run `sfi refresh` if it should be retrievable/);
  });
});
