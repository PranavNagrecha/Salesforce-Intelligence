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
import { isUnresolvedFieldReceiver } from '../../src/tools/apex-receiver.js';
import {
  explainApexMethodHandler,
  explainApexMethodInputSchema,
} from '../../src/tools/explain-apex-method.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 4, ApexTrigger: 1 },
  edges: { callsApex: 1, readsFrom: 2, writesTo: 1 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'TestClass',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Default edge-shape helper. */
const makeEdge = (overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

// =============================================================================
// Seed 1: A full-featured ApexClass with every classifier set to true (or
// the test-flag false branch chosen), modifiers, line/byte counts, one
// callsApex edge, two readsFrom edges (one is a read-only field), and one
// writesTo edge (matches the second readsFrom — collapses to access 'both').
// Verifies every classifier surfaces, the field-access merge, and the calls
// projection.
// =============================================================================

const ALL_CLASSIFIERS_ID = 'ApexClass:AllClassifiers';
const CALLEE_ID = 'ApexClass:Callee';
const READ_FIELD_ID = 'CustomField:Account.Industry__c';
const RW_FIELD_ID = 'CustomField:Account.Description__c';

const allClassifiersSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CALLEE_ID,
      type: 'ApexClass',
      apiName: 'Callee',
      label: 'Callee',
      properties: { isTest: false, isQueueable: false },
    }),
    makeNode({
      id: ALL_CLASSIFIERS_ID,
      type: 'ApexClass',
      apiName: 'AllClassifiers',
      label: 'AllClassifiers',
      apiVersion: 60,
      properties: {
        status: 'Active',
        description: 'A class exercising every classifier.',
        modifiers: ['public', 'with sharing'],
        sharingModel: 'with sharing',
        superclass: null,
        implements: ['Queueable', 'Schedulable', 'Database.Batchable<SObject>'],
        annotations: ['@AuraEnabled'],
        isTest: false,
        isQueueable: true,
        isSchedulable: true,
        isBatchable: true,
        hasFutureMethod: true,
        hasInvocableMethod: true,
        hasAuraEnabledMethod: true,
        isRestResource: true,
        lineCount: 250,
        sourceBytes: 5120,
        // The v2.1 R2 quality-issue enricher hasn't run on this
        // fixture; the test verifies the empty-array fallback below.
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: ALL_CLASSIFIERS_ID,
      toId: CALLEE_ID,
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: ALL_CLASSIFIERS_ID,
      toId: 'ApexClass:PhantomScannerTarget',
      edgeType: 'callsApex',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    makeEdge({
      fromId: ALL_CLASSIFIERS_ID,
      toId: READ_FIELD_ID,
      edgeType: 'readsFrom',
    }),
    makeEdge({
      fromId: ALL_CLASSIFIERS_ID,
      toId: RW_FIELD_ID,
      edgeType: 'readsFrom',
    }),
    makeEdge({
      fromId: ALL_CLASSIFIERS_ID,
      toId: RW_FIELD_ID,
      edgeType: 'writesTo',
    }),
    // Unresolved receivers the heuristic scanner keys on the raw token: an Apex
    // `this.` instance member and an un-type-resolved local variable. These must
    // be segregated OUT of fieldAccess into unresolvedFieldAccess.
    makeEdge({
      fromId: ALL_CLASSIFIERS_ID,
      toId: 'CustomField:this.caseLogId',
      edgeType: 'writesTo',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
    makeEdge({
      fromId: ALL_CLASSIFIERS_ID,
      toId: 'CustomField:acc.Status__c',
      edgeType: 'readsFrom',
      confidence: 'heuristic',
      source: 'apex-scanner',
    }),
  ],
};

// =============================================================================
// Seed 2: A test ApexClass — verifies isTest surfaces true and the
// classifiers default-false branch.
// =============================================================================

const TEST_CLASS_ID = 'ApexClass:MyTestClass';

const testClassSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TEST_CLASS_ID,
      type: 'ApexClass',
      apiName: 'MyTestClass',
      label: 'MyTestClass',
      properties: {
        status: 'Active',
        modifiers: ['private'],
        isTest: true,
        isQueueable: false,
        isSchedulable: false,
        isBatchable: false,
        hasFutureMethod: false,
        hasInvocableMethod: false,
        hasAuraEnabledMethod: false,
        isRestResource: false,
        lineCount: 30,
        sourceBytes: 500,
        // Real qualityIssues are OBJECTS ({rule,severity,location,explanation}),
        // NOT strings — the shape governor_limit_risks / code_quality_audit emit.
        // A trailing string entry proves malformed elements are dropped (F8).
        qualityIssues: [
          { rule: 'fake-assertion', severity: 'high', location: 'line 12', explanation: 'no meaningful assertion' },
          { rule: 'soql-in-loop', severity: 'critical', location: 'line 20', explanation: 'SOQL query inside a loop body' },
          'not-an-object',
        ],
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 3: An ApexTrigger — verifies the ApexTrigger: prefix is accepted and
// the type discriminator flows through correctly.
// =============================================================================

const TRIGGER_ID = 'ApexTrigger:AccountTrigger';

const triggerSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TRIGGER_ID,
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      label: 'AccountTrigger',
      properties: {
        status: 'Active',
        triggerObject: 'Account',
        events: ['before insert', 'after update'],
        modifiers: [],
        isTest: false,
        isQueueable: false,
        isSchedulable: false,
        isBatchable: false,
        hasFutureMethod: false,
        hasInvocableMethod: false,
        hasAuraEnabledMethod: false,
        isRestResource: false,
        lineCount: 10,
        sourceBytes: 200,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 4: A no-keyword BATCH class (Batchable + Stateful, no sharing keyword)
// — the exact shape of the sharing-semantics bug. A no-keyword top-level class
// must NOT be reported as `without sharing` by default; as async Apex it runs
// in SYSTEM context. Neutral name (no real org tokens).
// =============================================================================

const NOKEY_BATCH_ID = 'ApexClass:PaymentBatch';

const noKeywordBatchSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NOKEY_BATCH_ID,
      type: 'ApexClass',
      apiName: 'PaymentBatch',
      label: 'PaymentBatch',
      properties: {
        status: 'Active',
        // `global` only — NO sharing keyword declared. `sharingModel: null` is
        // what the extractor stamps for a class it READ and found no keyword on
        // (real vault shape); it is NOT the same as the property being absent,
        // which is the NOT-READ seed below.
        modifiers: ['global'],
        sharingModel: null,
        implements: ['Database.Batchable<sObject>', 'Database.Stateful'],
        isTest: false,
        isQueueable: false,
        isSchedulable: false,
        isBatchable: true,
        hasFutureMethod: false,
        hasInvocableMethod: false,
        hasAuraEnabledMethod: false,
        isRestResource: false,
        lineCount: 130,
        sourceBytes: 4096,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 5a: A no-keyword QUEUEABLE + AllowsCallouts class (matches the shape of
// a feed-item poster queueable used in case-log automation). Neutral name.
// Verifies the CRUD/FLS independence note: system-context execution means
// sharing is NOT enforced, but CRUD/FLS is a SEPARATE security layer that
// applies independently — these must NOT be conflated.
// =============================================================================

const NOKEY_QUEUEABLE_ID = 'ApexClass:FeedItemPosterJob';

const noKeywordQueueableSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NOKEY_QUEUEABLE_ID,
      type: 'ApexClass',
      apiName: 'FeedItemPosterJob',
      label: 'FeedItemPosterJob',
      properties: {
        status: 'Active',
        // `public` only — NO sharing keyword, implements Queueable + AllowsCallouts.
        modifiers: ['public'],
        sharingModel: null,
        implements: ['Queueable', 'Database.AllowsCallouts'],
        isTest: false,
        isQueueable: true,
        isSchedulable: false,
        isBatchable: false,
        hasFutureMethod: false,
        hasInvocableMethod: false,
        hasAuraEnabledMethod: false,
        isRestResource: false,
        lineCount: 35,
        sourceBytes: 900,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 5: A no-keyword SYNCHRONOUS service class (no async classifier). It must
// be reported as `inherits-caller`, NOT `without sharing`, NOT system-context.
// =============================================================================

const NOKEY_SYNC_ID = 'ApexClass:AccountService';

const noKeywordSyncSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NOKEY_SYNC_ID,
      type: 'ApexClass',
      apiName: 'AccountService',
      label: 'AccountService',
      properties: {
        status: 'Active',
        // `public` only — NO sharing keyword, synchronous.
        modifiers: ['public'],
        sharingModel: null,
        isTest: false,
        isQueueable: false,
        isSchedulable: false,
        isBatchable: false,
        hasFutureMethod: false,
        hasInvocableMethod: false,
        hasAuraEnabledMethod: false,
        isRestResource: false,
        lineCount: 40,
        sourceBytes: 800,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 6: SHARING-KEYWORD-LIVES-IN-SHARINGMODEL — the REAL vault shape for a
// class that DOES declare a keyword. The extractor's header parser splits the
// class declaration into `modifiers` (access/abstract/virtual) and
// `sharingModel` (the keyword); it does NOT join the keyword into `modifiers`.
// Every fixture above happened to duplicate the keyword into `modifiers`, so a
// tool reading ONLY `modifiers` looked correct here while answering
// `declared: null` for every keyword-declaring class in a real vault — and the
// `without sharing` direction is the security-relevant one.
// =============================================================================

const REAL_WITHOUT_ID = 'ApexClass:OrderIntakeService';
const REAL_WITH_ID = 'ApexClass:OrderPortalController';
const REAL_INHERITED_ID = 'ApexClass:OrderConditionEvaluator';

const realShapeProps = (
  sharingModel: string,
): Record<string, unknown> => ({
  status: 'Active',
  // The extractor keeps the sharing keyword OUT of `modifiers`.
  modifiers: ['public'],
  sharingModel,
  isTest: false,
  isQueueable: false,
  isSchedulable: false,
  isBatchable: false,
  hasFutureMethod: false,
  hasInvocableMethod: false,
  hasAuraEnabledMethod: false,
  isRestResource: false,
  lineCount: 60,
  sourceBytes: 1200,
});

const realShapeSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: REAL_WITHOUT_ID,
      apiName: 'OrderIntakeService',
      label: 'OrderIntakeService',
      properties: realShapeProps('without sharing'),
    }),
    makeNode({
      id: REAL_WITH_ID,
      apiName: 'OrderPortalController',
      label: 'OrderPortalController',
      properties: realShapeProps('with sharing'),
    }),
    makeNode({
      id: REAL_INHERITED_ID,
      apiName: 'OrderConditionEvaluator',
      label: 'OrderConditionEvaluator',
      properties: realShapeProps('inherited sharing'),
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 7: the LEGACY layout — the keyword joined into `modifiers`, with NO
// `sharingModel` property. Kept readable so an old vault still gets a real
// answer instead of falling through to NOT-READ.
// =============================================================================

const LEGACY_MODIFIERS_ID = 'ApexClass:LegacyLayoutService';

const legacyModifiersSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: LEGACY_MODIFIERS_ID,
      apiName: 'LegacyLayoutService',
      label: 'LegacyLayoutService',
      properties: {
        status: 'Active',
        modifiers: ['global', 'with sharing'],
        isTest: false,
        isQueueable: false,
        isSchedulable: false,
        isBatchable: false,
        hasFutureMethod: false,
        hasInvocableMethod: false,
        hasAuraEnabledMethod: false,
        isRestResource: false,
        lineCount: 20,
        sourceBytes: 400,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 8: a node carrying NEITHER `sharingModel` NOR a keyword-bearing
// `modifiers` array, and none of the async classifiers. NOTHING read the class
// declaration, so no enforcement model may be asserted — a `without sharing`
// class on such a node presents identically.
// =============================================================================

const NOT_READ_ID = 'ApexClass:UnreadDeclarationService';

const notReadSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NOT_READ_ID,
      apiName: 'UnreadDeclarationService',
      label: 'UnreadDeclarationService',
      properties: { status: 'Active', lineCount: 12, sourceBytes: 300 },
    }),
  ],
  edges: [],
};

// One shared graph store + Context across the suite.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-explain-apex-'));
  const dbPath = join(tempDir, 'explain-apex.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    allClassifiersSeed,
    testClassSeed,
    triggerSeed,
    noKeywordBatchSeed,
    noKeywordQueueableSeed,
    noKeywordSyncSeed,
    realShapeSeed,
    legacyModifiersSeed,
    notReadSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('explainApexMethodHandler', () => {
  it('surfaces every v1.5 classifier flag for an all-classifiers class', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: ALL_CLASSIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.classApiName).toBe(ALL_CLASSIFIERS_ID);
    expect(data.apiName).toBe('AllClassifiers');
    expect(data.type).toBe('ApexClass');
    expect(data.status).toBe('Active');
    expect(data.apiVersion).toBe(60);
    expect(data.modifiers).toEqual(['public', 'with sharing']);
    expect(data.lineCount).toBe(250);
    expect(data.sourceBytes).toBe(5120);
    expect(data.isTest).toBe(false);
    // Every classifier surfaces explicitly.
    expect(data.classifiers.isQueueable).toBe(true);
    expect(data.classifiers.isSchedulable).toBe(true);
    expect(data.classifiers.isBatchable).toBe(true);
    expect(data.classifiers.hasFutureMethod).toBe(true);
    expect(data.classifiers.hasInvocableMethod).toBe(true);
    expect(data.classifiers.hasAuraEnabledMethod).toBe(true);
    expect(data.classifiers.isRestResource).toBe(true);
    expect(data.disclosure).toContain('Structured narrative; Claude composes prose');
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('reports a declared `with sharing` class as effectiveModel `with sharing`', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: ALL_CLASSIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.value.data.sharingSemantics;
    expect(s.declared).toBe('with sharing');
    expect(s.effectiveModel).toBe('with sharing');
    // Still async — runs as system, but enforcement is per the keyword.
    expect(s.runsAsSystem).toBe(true);
  });

  it('does NOT report a no-keyword BATCH class as `without sharing` (system-context, runs as system)', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: NOKEY_BATCH_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.value.data.sharingSemantics;
    // The bug: a no-keyword batch class was answered as "without sharing by default".
    expect(s.declared).toBeNull();
    expect(s.effectiveModel).not.toBe('without sharing');
    expect(s.effectiveModel).toBe('system-context');
    expect(s.runsAsSystem).toBe(true);
    // The note must correct the misconception AND name system context.
    expect(s.note).toContain('does NOT default to `without sharing`');
    expect(s.note.toLowerCase()).toContain('system context');
    // Never impersonates the scheduling/submitting user.
    expect(s.note.toLowerCase()).toContain('never');
  });

  it('sharing and CRUD/FLS independence: no-keyword queueable note must NOT conflate system-context with CRUD/FLS bypass', async () => {
    // Regression: the note previously said "CRUD/FLS are also bypassed unless checked
    // explicitly" which wrongly implied system-context execution auto-bypasses FLS.
    // Sharing enforcement and CRUD/FLS are INDEPENDENT security layers — system context
    // only means sharing is not enforced; CRUD/FLS applies separately.
    const result = await explainApexMethodHandler(ctx, {
      classApiName: NOKEY_QUEUEABLE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.value.data.sharingSemantics;
    // System-context, no declared keyword.
    expect(s.declared).toBeNull();
    expect(s.effectiveModel).toBe('system-context');
    expect(s.runsAsSystem).toBe(true);
    // Sharing is not enforced due to system-context.
    expect(s.note).toContain('does NOT default to `without sharing`');
    expect(s.note.toLowerCase()).toContain('system context');
    // CRUD/FLS independence note must be present and explicit.
    expect(s.note).toContain('INDEPENDENT');
    expect(s.note.toLowerCase()).toContain('crud/fls');
    // Must NOT say "bypassed" without attributing the correct condition
    // (the old note wrongly implied FLS is bypassed by system-context itself).
    // The note must clarify it is a SEPARATE mechanism.
    expect(s.note.toLowerCase()).toContain('separate');
  });

  it('reports a no-keyword SYNCHRONOUS class as inherits-caller (not without sharing)', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: NOKEY_SYNC_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.value.data.sharingSemantics;
    expect(s.declared).toBeNull();
    expect(s.effectiveModel).toBe('inherits-caller');
    expect(s.runsAsSystem).toBe(false);
    expect(s.note).toContain('INHERITS THE CALLER');
    expect(s.note).toContain('does NOT default to `without sharing`');
  });

  // ===========================================================================
  // SHARING-KEYWORD-LIVES-IN-SHARINGMODEL. On a real vault the keyword is in
  // `properties.sharingModel`, NOT in `properties.modifiers`. Reading only
  // `modifiers` answered `declared: null` / `effectiveModel: 'inherits-caller'`
  // for EVERY class that declares a keyword — telling a reviewer auditing
  // sharing bypass that a `without sharing` class inherits the caller's
  // context. `sfi.apex_structure` reads the same declaration correctly, so the
  // product contradicted itself on the same class.
  // ===========================================================================
  it('reads `without sharing` from properties.sharingModel when modifiers does NOT carry it', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: REAL_WITHOUT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // The exact real-vault shape: no keyword anywhere in `modifiers`.
    expect(data.modifiers).toEqual(['public']);
    const s = data.sharingSemantics;
    expect(s.declared).toBe('without sharing');
    expect(s.effectiveModel).toBe('without sharing');
    // The false answer this fix removes.
    expect(s.effectiveModel).not.toBe('inherits-caller');
    expect(data.sharingSource).toBe('node-sharing-model');
  });

  it('reads `with sharing` and `inherited sharing` from properties.sharingModel too', async () => {
    const withResult = await explainApexMethodHandler(ctx, {
      classApiName: REAL_WITH_ID,
    });
    expect(withResult.ok).toBe(true);
    if (!withResult.ok) return;
    expect(withResult.value.data.sharingSemantics.declared).toBe('with sharing');
    expect(withResult.value.data.sharingSemantics.effectiveModel).toBe('with sharing');

    const inheritedResult = await explainApexMethodHandler(ctx, {
      classApiName: REAL_INHERITED_ID,
    });
    expect(inheritedResult.ok).toBe(true);
    if (!inheritedResult.ok) return;
    expect(inheritedResult.value.data.sharingSemantics.declared).toBe('inherited sharing');
    expect(inheritedResult.value.data.sharingSemantics.effectiveModel).toBe(
      'inherited sharing',
    );
  });

  it('still reads the keyword out of `modifiers` on a legacy vault that carries no sharingModel', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: LEGACY_MODIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.sharingSemantics.declared).toBe('with sharing');
    expect(result.value.data.sharingSource).toBe('node-modifiers');
  });

  it('reports NOT-READ (not inherits-caller) when NEITHER sharingModel NOR modifiers carries the keyword', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: NOT_READ_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const s = data.sharingSemantics;
    expect(s.declared).toBeNull();
    // The third state, matching `sfi.apex_structure`'s vocabulary — asserting
    // `inherits-caller` here would be a wrong security answer.
    expect(s.effectiveModel).toBe('not-read');
    expect(s.effectiveModel).not.toBe('inherits-caller');
    expect(data.sharingSource).toBe('not-read');
    // This node carries no classifiers either, so runsAsSystem is UNCHECKED,
    // never a bare `false`.
    expect(s.runsAsSystem).toBeNull();
    expect(s.note).toContain('NOT READ');
    expect(result.value.data.disclosure).toContain('NOT READ');
  });

  it('an ApexTrigger reports system-context, never inherits-caller (a trigger cannot declare a keyword)', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: TRIGGER_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    const s = data.sharingSemantics;
    expect(s.declared).toBeNull();
    expect(s.effectiveModel).toBe('system-context');
    expect(s.effectiveModel).not.toBe('inherits-caller');
    expect(s.runsAsSystem).toBe(true);
    expect(data.sharingSource).toBe('trigger-system-context');
    expect(s.note).toContain('CANNOT declare a sharing keyword');
  });

  it('surfaces calls with target ApiName', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: ALL_CLASSIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calls = result.value.data.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.targetId).toBe(CALLEE_ID);
    expect(calls[0]?.targetApiName).toBe('Callee');
    expect(result.value.data.unresolvedCallTargets).toEqual([
      'PhantomScannerTarget',
    ]);
    expect(result.value.data.disclosure).toContain('unresolvedCallTargets');
  });

  it("merges readsFrom + writesTo into one fieldAccess row with accessType 'both'", async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: ALL_CLASSIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fieldAccess = result.value.data.fieldAccess;
    // Two fields: one read-only (Industry__c), one read+write
    // (Description__c).
    expect(fieldAccess.length).toBe(2);
    const readOnly = fieldAccess.find((f) => f.fieldId === READ_FIELD_ID);
    expect(readOnly?.accessType).toBe('read');
    const both = fieldAccess.find((f) => f.fieldId === RW_FIELD_ID);
    expect(both?.accessType).toBe('both');
  });

  it('segregates this.* and local-variable field receivers into unresolvedFieldAccess', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: ALL_CLASSIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fieldAccess, unresolvedFieldAccess, disclosure } = result.value.data;
    // The Apex `this.` member and the unresolved local var must NOT pose as fields.
    expect(fieldAccess.map((f) => f.fieldId)).not.toContain('CustomField:this.caseLogId');
    expect(fieldAccess.map((f) => f.fieldId)).not.toContain('CustomField:acc.Status__c');
    // They land in the dedicated bucket as raw receiver.field tokens.
    expect(unresolvedFieldAccess).toContain('this.caseLogId');
    expect(unresolvedFieldAccess).toContain('acc.Status__c');
    // The real Account fields are untouched.
    expect(fieldAccess.map((f) => f.fieldId)).toContain(READ_FIELD_ID);
    // The disclosure names the new bucket so a host can't read it as real fields.
    expect(disclosure).toContain('unresolvedFieldAccess');
  });

  it('isUnresolvedFieldReceiver: this/super + local-var aliases true; real objects false', () => {
    // unresolved receivers
    expect(isUnresolvedFieldReceiver('CustomField:this.caseLogId')).toBe(true);
    expect(isUnresolvedFieldReceiver('CustomField:super.x')).toBe(true);
    expect(isUnresolvedFieldReceiver('CustomField:acc.Status__c')).toBe(true);
    expect(isUnresolvedFieldReceiver('CustomField:courseOffering.Compensation__c')).toBe(true);
    // real receivers — KEEP (standard, custom, namespaced/managed)
    expect(isUnresolvedFieldReceiver('CustomField:Account.Industry__c')).toBe(false);
    expect(isUnresolvedFieldReceiver('CustomField:FeedComment.CommentBody')).toBe(false);
    expect(isUnresolvedFieldReceiver('CustomField:Payment__c.Amount__c')).toBe(false);
    expect(isUnresolvedFieldReceiver('CustomField:hed__Course__c.hed__Name__c')).toBe(false);
  });

  it('surfaces empty qualityIssues for a class without the v2.1 mirror', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: ALL_CLASSIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.qualityIssues).toEqual([]);
  });

  it('QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS: an empty mirror on an UNSCANNED node says NOT CHECKED', async () => {
    // The array shape is kept — callers depend on it — but a node that carries
    // no `qualityIssues` KEY was never scanned, and `[]` alone said "we looked
    // and found nothing" about a node nothing looked at.
    const result = await explainApexMethodHandler(ctx, {
      classApiName: ALL_CLASSIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.qualityIssues).toEqual([]);
    expect(result.value.data.disclosure).toContain('NOT CHECKED, not clean');
    expect(result.value.data.disclosure).toContain('sfi refresh');
  });

  it('a SCANNED node says nothing extra — the disclosure stays byte-identical', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: TEST_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).not.toContain('NOT CHECKED, not clean');
  });

  it('surfaces qualityIssues as objects when the v2.1 mirror is populated (F8: was always [])', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: TEST_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Regression: the reader treated qualityIssues as string[] and filtered out
    // every (object) finding, so this tool ALWAYS returned []. It must now
    // surface the structured findings, dropping only the malformed string entry.
    expect(result.value.data.qualityIssues).toEqual([
      { rule: 'fake-assertion', severity: 'high', location: 'line 12', explanation: 'no meaningful assertion' },
      { rule: 'soql-in-loop', severity: 'critical', location: 'line 20', explanation: 'SOQL query inside a loop body' },
    ]);
    // Test classes surface isTest: true.
    expect(result.value.data.isTest).toBe(true);
    // The default-false classifiers surface false.
    expect(result.value.data.classifiers.isQueueable).toBe(false);
    expect(result.value.data.classifiers.isRestResource).toBe(false);
  });

  it('carries methodName verbatim into the response when provided', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: TEST_CLASS_ID,
      methodName: 'testMyMethod',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.methodName).toBe('testMyMethod');
  });

  it('defaults methodName to null when omitted', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: TEST_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.methodName).toBeNull();
  });

  it('accepts an ApexTrigger: prefix', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: TRIGGER_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.type).toBe('ApexTrigger');
    expect(result.value.data.apiName).toBe('AccountTrigger');
  });

  it('surfaces triggerObject + events for an ApexTrigger', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: TRIGGER_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The defining facts of a trigger — WHICH object it fires on and WHEN —
    // were dropped (the tool surfaced class-level axes only). "Explain this
    // trigger" needs both.
    expect(result.value.data.triggerObject).toBe('Account');
    expect(result.value.data.events).toEqual(['before insert', 'after update']);
  });

  it('returns null triggerObject + empty events for an ApexClass', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: ALL_CLASSIFIERS_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A class is not a trigger — these are not fabricated.
    expect(result.value.data.triggerObject).toBeNull();
    expect(result.value.data.events).toEqual([]);
  });

  it('returns component-not-found for an unknown class id', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: 'ApexClass:DoesNotExist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('ApexClass:DoesNotExist');
  });

  it('returns invalid-query when classApiName does not have an accepted prefix', async () => {
    const result = await explainApexMethodHandler(ctx, {
      classApiName: 'CustomObject:Account',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('classApiName');
  });
});

describe('explainApexMethodInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = explainApexMethodInputSchema.safeParse({
      classApiName: 'ApexClass:Foo',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional methodName', () => {
    const parsed = explainApexMethodInputSchema.safeParse({
      classApiName: 'ApexClass:Foo',
      methodName: 'someMethod',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty classApiName string', () => {
    const parsed = explainApexMethodInputSchema.safeParse({
      classApiName: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty methodName string', () => {
    const parsed = explainApexMethodInputSchema.safeParse({
      classApiName: 'ApexClass:Foo',
      methodName: '',
    });
    expect(parsed.success).toBe(false);
  });
});
