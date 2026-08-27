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
  apexBuildAdvisorHandler,
  apexBuildAdvisorInputSchema,
} from '../../src/tools/apex-build-advisor.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { ApexClass: 3, CustomObject: 1 },
  edges: { callsApex: 1, readsFrom: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const node = (id: string, type: Node['type'], props: Record<string, unknown> = {}): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `${id}.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: props,
});

const edge = (fromId: string, toId: string, edgeType: Edge['edgeType']): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
});

const seed: ExtractionResult = {
  nodes: [
    node('ApexClass:SvcA', 'ApexClass'),
    node('ApexClass:SvcB', 'ApexClass'),
    node('ApexClass:SvcATest', 'ApexClass', { isTest: true }),
    node('CustomObject:Foo__c', 'CustomObject', { label: 'Foo' }),
  ],
  edges: [
    edge('ApexClass:SvcATest', 'ApexClass:SvcA', 'callsApex'),
    edge('ApexClass:SvcA', 'CustomObject:Foo__c', 'readsFrom'),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-apexadv-'));
  const opened = await openGraph(join(tempDir, 'apexadv.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('apexBuildAdvisorHandler', () => {
  it('synthesises governor / test / FLS sections and recommendations', async () => {
    const r = await apexBuildAdvisorHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.governorPitfalls).not.toBeNull();
    expect(d.testExpectations).not.toBeNull();
    expect(d.flsCrudNorms).not.toBeNull();
    // SvcB has no covering test → at least one untested class.
    expect(d.testExpectations?.untestedClasses).toBeGreaterThanOrEqual(1);
    expect(d.recommendations.length).toBeGreaterThan(0);
  });

  it('adds similarLogic when scoped to an object', async () => {
    const r = await apexBuildAdvisorHandler(ctx, { objectApiName: 'Foo__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.similarLogic?.apexTouchingObject).toContain('ApexClass:SvcA');
  });

  it('omits similarLogic when no object is given', async () => {
    const r = await apexBuildAdvisorHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.similarLogic).toBeUndefined();
  });
});

// =============================================================================
// GUARD (APEX-BUILD-ADVISOR-ANSWERS-FOR-NONEXISTENT-OBJECT): `objectApiName`
// was concatenated straight into `CustomObject:{name}` and used ONLY for a
// `listEdges` probe. Nothing ever asked the vault whether that object exists,
// and no sub-scan was narrowed by it — so a MISTYPED object name returned the
// full ORG-WIDE briefing (governor pitfalls, test expectations, CRUD/FLS norms
// and every recommendation, byte-identical to the bare call) plus
// `similarLogic: { objectApiName: 'Zzz_Nonexistent_Object_9x7__c',
// apexTouchingObject: [] }` — an unchecked zero reading as "no Apex touches
// this object yet". The object scope was IGNORED, not applied; there was no
// `appliedScope` naming it either, so a host could not tell the answer was
// org-wide. An unresolvable object scope must be REFUSED.
describe('apexBuildAdvisorHandler — object scope (guard)', () => {
  it('an object that does not exist is invalid-query, not an org-wide briefing', async () => {
    const r = await apexBuildAdvisorHandler(ctx, {
      objectApiName: 'Zzz_Nonexistent_Object_9x7__c',
    });
    // Diagnostic first: on a regression the failure prints the briefing that
    // was handed back for an object that is not in the vault.
    expect(
      r.ok
        ? JSON.stringify({
            recommendations: r.value.data.recommendations,
            similarLogic: r.value.data.similarLogic,
          })
        : 'refused',
    ).toBe('refused');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Zzz_Nonexistent_Object_9x7__c');
  });

  it('a real object in the WRONG CASE still answers + echoes appliedScope', async () => {
    const r = await apexBuildAdvisorHandler(ctx, { objectApiName: 'foo__C' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Resolved to the vault's exact casing, and the echo names the object axis
    // so the briefing cannot be read as org-wide.
    expect(r.value.data.similarLogic?.objectApiName).toBe('Foo__c');
    expect(r.value.data.similarLogic?.apexTouchingObject).toContain('ApexClass:SvcA');
    expect(r.value.data.appliedScope).toEqual({
      component: null,
      object: 'CustomObject:Foo__c',
      mode: 'object',
    });
  });

  it('a class scope with no object keeps its exact pre-0.3.3 appliedScope shape', async () => {
    const r = await apexBuildAdvisorHandler(ctx, { componentId: 'ApexClass:SvcA' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({
      component: 'ApexClass:SvcA',
      mode: 'component',
    });
  });
});

// =============================================================================
// GUARD (APEX-BUILD-ADVISOR-IGNORES-CLASS-SCOPE): "apex build advisor for SvcA"
// passes componentId / classApiName / apiName, but the schema stripped them and
// every call returned the same org-wide briefing. A class scope must now narrow
// the composed sub-scans to that ONE class + echo appliedScope; the bare call
// stays byte-identical (no appliedScope key).
describe('apexBuildAdvisorHandler — class scope (guard)', () => {
  it('bare call omits appliedScope (byte-identical shape)', async () => {
    const r = await apexBuildAdvisorHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('appliedScope' in r.value.data).toBe(false);
    // Org-wide: SvcB is untested → at least one untested class.
    expect(r.value.data.testExpectations?.untestedClasses).toBeGreaterThanOrEqual(1);
  });

  it('componentId scope narrows the briefing to that class + echoes appliedScope', async () => {
    const bare = await apexBuildAdvisorHandler(ctx, {});
    const scoped = await apexBuildAdvisorHandler(ctx, {
      componentId: 'ApexClass:SvcA',
    });
    expect(bare.ok && scoped.ok).toBe(true);
    if (!bare.ok || !scoped.ok) return;
    expect(scoped.value.data.appliedScope).toEqual({
      component: 'ApexClass:SvcA',
      mode: 'component',
    });
    // SvcA has a covering test (SvcATest) → 0 untested in scope, vs the bare
    // org-wide briefing which counts SvcB as untested. Scoped ≠ bare.
    expect(scoped.value.data.testExpectations?.untestedClasses).toBe(0);
    expect(scoped.value.data.testExpectations?.untestedClasses).not.toBe(
      bare.value.data.testExpectations?.untestedClasses,
    );
  });

  it('classApiName and apiName aliases resolve identically to componentId', async () => {
    const byComponentId = await apexBuildAdvisorHandler(ctx, {
      componentId: 'ApexClass:SvcA',
    });
    const byClassApiName = await apexBuildAdvisorHandler(ctx, { classApiName: 'SvcA' });
    const byApiName = await apexBuildAdvisorHandler(ctx, { apiName: 'SvcA' });
    expect(byComponentId.ok && byClassApiName.ok && byApiName.ok).toBe(true);
    if (!byComponentId.ok || !byClassApiName.ok || !byApiName.ok) return;
    expect(byClassApiName.value.data.appliedScope).toEqual(
      byComponentId.value.data.appliedScope,
    );
    expect(byApiName.value.data.appliedScope).toEqual(
      byComponentId.value.data.appliedScope,
    );
    expect(byClassApiName.value.data.testExpectations).toEqual(
      byComponentId.value.data.testExpectations,
    );
  });

  it('an unresolved class scope is component-not-found (not a silent org-wide briefing)', async () => {
    const r = await apexBuildAdvisorHandler(ctx, {
      componentId: 'ApexClass:GhostSvc',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('a non-Apex type prefix is invalid-query', async () => {
    const r = await apexBuildAdvisorHandler(ctx, {
      componentId: 'CustomObject:Foo__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

describe('apexBuildAdvisorInputSchema', () => {
  it('accepts empty input and an objectApiName', () => {
    expect(apexBuildAdvisorInputSchema.safeParse({}).success).toBe(true);
    expect(apexBuildAdvisorInputSchema.safeParse({ objectApiName: 'Account' }).success).toBe(true);
  });

  it('accepts the class-scope selectors', () => {
    expect(
      apexBuildAdvisorInputSchema.safeParse({ componentId: 'ApexClass:SvcA' }).success,
    ).toBe(true);
    expect(apexBuildAdvisorInputSchema.safeParse({ classApiName: 'SvcA' }).success).toBe(true);
    expect(apexBuildAdvisorInputSchema.safeParse({ apiName: 'SvcA' }).success).toBe(true);
  });
});
