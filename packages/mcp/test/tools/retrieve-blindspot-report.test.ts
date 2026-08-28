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
  retrieveBlindspotReportHandler,
  retrieveBlindspotReportInputSchema,
} from '../../src/tools/retrieve-blindspot-report.js';

// Synthetic-only fixtures (no real org names).
const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-03T12:00:00.000Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, ApexTrigger: 1, ApexClass: 1 },
  edges: { triggersOn: 1, callsApex: 1, grantedBy: 1, usedInLayout: 1 },
  sourceTreeHash: 'sha256:blindspot',
  coverageComputedAt: '2026-06-03T12:01:00.000Z',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false },
    { type: 'ApexClass', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'EmailTemplate', requested: false, retrieved: 0, errored: false, neverModeled: true },
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
  confidence: Edge['confidence'],
): Edge => ({ fromId, toId, edgeType, confidence, source: 'test', properties: {} });

// Resolved object + trigger; a trigger that fires on a MISSING object (functional
// blind spot), calls a MISSING class, a layout referencing a MISSING field, a perm
// grant on a MISSING object, and a heuristic scanner phantom.
const SEED: ExtractionResult = {
  nodes: [
    node('CustomObject:Acme_Order__c', 'CustomObject'),
    node('ApexTrigger:Acme_OrderTrigger', 'ApexTrigger'),
  ],
  edges: [
    edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Order__c', 'declared'), // resolved
    edge('ApexTrigger:Acme_OrderTrigger', 'triggersOn', 'CustomObject:Acme_Missing__c', 'declared'), // functional
    edge('ApexTrigger:Acme_OrderTrigger', 'callsApex', 'ApexClass:Acme_MissingSvc', 'declared'), // functional
    edge('WorkflowAlert:Acme_Alert', 'sendsEmail', 'EmailTemplate:Acme.Missing_Tpl', 'declared'), // functional, notModeled type
    edge('Layout:Acme_Order__c-Layout', 'usedInLayout', 'CustomField:Acme_Order__c.Ghost__c', 'declared'), // layout
    edge('PermissionSet:Acme_PS', 'grantedBy', 'CustomObject:Acme_GrantTarget__c', 'declared'), // grant
    edge('ApexClass:Acme_Svc', 'readsFrom', 'CustomField:Acme_Missing__c.Foo__c', 'heuristic'), // scanner phantom
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-blindspot-'));
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

describe('retrieveBlindspotReportHandler', () => {
  it('surfaces automation/code references to unretrieved components, rolling up grant/layout/scanner noise', async () => {
    const r = await retrieveBlindspotReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    expect(d.cleanVault).toBe(false);
    const types = d.blindspots.map((b) => b.targetType).sort();
    // Functional blind spots only: CustomObject (triggersOn), ApexClass (callsApex), EmailTemplate (sendsEmail).
    expect(types).toEqual(['ApexClass', 'CustomObject', 'EmailTemplate']);
    // Every enumerated blindspot is the functional bucket.
    expect(d.blindspots.every((b) => b.bucket === 'automation-and-code')).toBe(true);

    const co = d.blindspots.find((b) => b.targetType === 'CustomObject');
    expect(co?.coverageStatus).toBe('covered'); // type retrieved; specific object missing
    expect(co?.edgeKinds.some((k) => k.edgeType === 'triggersOn')).toBe(true);
    expect(co?.edgeKinds.flatMap((k) => k.sampleTargets)).toContain('CustomObject:Acme_Missing__c');

    // notModeled type → whole-type manifest gap remedy.
    const et = d.blindspots.find((b) => b.targetType === 'EmailTemplate');
    expect(et?.coverageStatus).toBe('notModeled');
    expect(et?.remedy).toMatch(/manifest|never retrieved|not modeled/i);

    // Noise is rolled up, not enumerated.
    expect(d.rolledUp.permissionGrant.referenceEdges).toBe(1);
    expect(d.rolledUp.layoutReference.referenceEdges).toBe(1);
    expect(d.rolledUp.heuristicUnresolved.referenceEdges).toBe(1);
    expect(d.summary.functionalBlindspotTypes).toBe(3);
    expect(d.trust.provenance).toBe('offline_snapshot');
    expect(d.disclosure).toMatch(/lookupTo/);
  });

  it('includeLowSignal enumerates the grant/layout/scanner buckets too', async () => {
    const r = await retrieveBlindspotReportHandler(ctx, { includeLowSignal: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const buckets = new Set(r.value.data.blindspots.map((b) => b.bucket));
    expect(buckets.has('permission-grant')).toBe(true);
    expect(buckets.has('layout-reference')).toBe(true);
    expect(buckets.has('heuristic-unresolved')).toBe(true);
  });

  it('targetType filter narrows to one type', async () => {
    const r = await retrieveBlindspotReportHandler(ctx, { targetType: 'ApexClass' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.blindspots.map((b) => b.targetType)).toEqual(['ApexClass']);
  });

  it('coerces a stringified includeLowSignal boolean (MCP {} args)', () => {
    const parsed = retrieveBlindspotReportInputSchema.parse({ includeLowSignal: 'true' });
    expect(parsed.includeLowSignal).toBe(true);
  });
});

/**
 * REMEDY-CERTIFIES-AN-UNVERIFIED-CAUSE.
 *
 * Measured on a real vault: two sub-component families were both stamped
 * `coverageStatus: 'absent'` with the remedy "is never retrieved (not modeled /
 * not in the retrieve manifest) ... widen the retrieve manifest and run
 * /sfi-refresh". Both classifications were contradicted by the vault:
 *
 *   (1) One of the two families had DOZENS of real nodes in the graph — the
 *       family is modeled and only a handful of specific members dangle. The
 *       report already has the right word for that (`covered`, "specific
 *       components not in the vault"), and it used it correctly for two OTHER
 *       types in the same answer. Widening the manifest for a family that is
 *       already modeled cannot change anything.
 *
 *   (2) The other family had zero nodes AND no manifest coverage row — because
 *       the retrieve manifest only enumerates TOP-LEVEL metadata families, so a
 *       sub-component stored inside a parent file can never appear in it. The
 *       members were physically present in files the refresh had ALREADY pulled;
 *       the extractor simply does not model that family. `entries.find(...) ===
 *       undefined ? 'absent'` collapsed NEVER-CHECKED into CHECKED-AND-MISSING,
 *       and the remedy then prescribed hours of org refresh that returns the
 *       identical zero.
 *
 * The handler cannot tell (2) from a genuine retrieve gap — nothing in the graph
 * or the manifest distinguishes them. It CAN tell (1), and it must stop
 * certifying a single cause for (2).
 *
 * Fixtures are synthetic; the two families below stand in for the real pair.
 */
const SUBCOMPONENT_MANIFEST: VaultManifest = {
  ...MANIFEST,
  // Deliberately NO row for either workflow sub-component family: the retrieve
  // manifest enumerates top-level families only, which is exactly why "no row"
  // must not be read as "never retrieved".
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false },
  ],
};

const SUBCOMPONENT_SEED: ExtractionResult = {
  nodes: [
    node('CustomObject:Obj_A__c', 'CustomObject'),
    // The family IS modeled: three real nodes the extractor emitted.
    node('WorkflowAlert:Obj_A__c.Alert_B', 'WorkflowAlert'),
    node('WorkflowAlert:Obj_A__c.Alert_C', 'WorkflowAlert'),
    node('WorkflowAlert:Obj_A__c.Alert_D', 'WorkflowAlert'),
  ],
  edges: [
    // Resolved reference into the modeled family.
    edge('WorkflowRule:Obj_A__c.Rule_E', 'references', 'WorkflowAlert:Obj_A__c.Alert_B', 'declared'),
    // ONE member of the modeled family dangles (a parent file outside scope).
    edge('WorkflowRule:Obj_A__c.Rule_F', 'references', 'WorkflowAlert:Obj_Z__c.Alert_G', 'declared'),
    // A family with NO node and NO manifest row: cause genuinely undetermined.
    edge(
      'ApprovalProcess:Obj_A__c.Proc_H',
      'references',
      'WorkflowFieldUpdate:Obj_A__c.Fu_I',
      'declared',
    ),
    edge(
      'ApprovalProcess:Obj_A__c.Proc_J',
      'references',
      'WorkflowFieldUpdate:Obj_A__c.Fu_K',
      'declared',
    ),
  ],
};

describe('retrieveBlindspotReportHandler — the remedy must not certify an unverified cause', () => {
  let subDir: string;
  let subStore: GraphStore;
  let subCtx: Context;

  beforeAll(async () => {
    subDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-blindspot-sub-'));
    const opened = await openGraph(join(subDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    subStore = opened.value;
    const imp = await importExtractionResults(subStore, [SUBCOMPONENT_SEED]);
    if (!imp.ok) throw new Error(imp.error.message);
    subCtx = { vaultRoot: subDir, manifest: SUBCOMPONENT_MANIFEST, graph: subStore };
  });

  afterAll(async () => {
    await closeGraph(subStore);
    rmSync(subDir, { recursive: true, force: true });
  });

  it('a family the GRAPH models is never reported as a whole-family retrieve gap', async () => {
    const r = await retrieveBlindspotReportHandler(subCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.data.blindspots.find((x) => x.targetType === 'WorkflowAlert');
    expect(b).toBeDefined();
    // The graph holds three nodes of this family — it is NOT absent from the vault.
    expect(b?.modeledNodes).toBe(3);
    expect(b?.coverageStatus).not.toBe('absent');
    expect(b?.remedy).not.toMatch(/never retrieved/i);
    expect(b?.remedy).not.toMatch(/widen the retrieve manifest/i);
    // The cause here IS established: the family is modeled, only members dangle.
    expect(b?.causeVerified).toBe(true);
  });

  it('a family with no manifest row and no node names BOTH causes instead of certifying one', async () => {
    const r = await retrieveBlindspotReportHandler(subCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.data.blindspots.find((x) => x.targetType === 'WorkflowFieldUpdate');
    expect(b).toBeDefined();
    expect(b?.modeledNodes).toBe(0);
    // Nothing in the vault establishes WHY it is missing.
    expect(b?.causeVerified).toBe(false);
    // It must NOT assert the retrieve-gap cause as fact...
    expect(b?.remedy).not.toMatch(/is never retrieved/i);
    // ...and it must name the extraction-gap alternative a refresh cannot fix.
    expect(b?.remedy).toMatch(/extract/i);
    expect(b?.remedy).toMatch(/not established|cannot be established|undetermined/i);
  });

  it('an unverified cause is surfaced in a typed field and in trust.limitations', async () => {
    const r = await retrieveBlindspotReportHandler(subCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.causeUnverifiedTypes).toEqual(['WorkflowFieldUpdate']);
    expect(d.trust.limitations.some((l) => l.includes('WorkflowFieldUpdate'))).toBe(true);
    expect(d.trust.completeness.status).not.toBe('complete');
  });
});
