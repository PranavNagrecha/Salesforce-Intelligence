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
import { getEdgesHandler } from '../../src/tools/get-edges.js';
import {
  synthesizeAnswerHandler,
  synthesizeAnswerInputSchema,
} from '../../src/tools/synthesize-answer.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

// The handler never queries the graph (it only reads ctx.manifest for
// vaultState), but Context requires one — open an empty fixture graph.
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-synth-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

// A realistic field_access_audit-shaped payload to ground on.
const FIELD_AUDIT_JSON = {
  fieldId: 'CustomField:Contact.Email',
  notModeled: true,
  notModeledNote: 'Definition not retrieved; grants from edges.',
  grants: [
    { grantorId: 'PermissionSet:Conga_Batch_Manager', permission: 'read' },
    { grantorId: 'Profile:System_Administrator', permission: 'edit' },
  ],
  summary: { permSetsWithRead: 12 },
  boundaries: ['Criteria-based sharing is deferred.'],
};

describe('synthesizeAnswerHandler', () => {
  it('cites only canonical ids present in the input (deduped, sorted, parsed)', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: FIELD_AUDIT_JSON });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.citations.map((c) => c.id);
    expect(ids).toEqual([
      'CustomField:Contact.Email',
      'PermissionSet:Conga_Batch_Manager',
      'Profile:System_Administrator',
    ]);
    const field = r.value.data.citations.find(
      (c) => c.id === 'CustomField:Contact.Email',
    );
    expect(field?.type).toBe('CustomField');
    expect(field?.apiName).toBe('Contact.Email');
  });

  it('carries caveats verbatim (string fields + boundary arrays)', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: FIELD_AUDIT_JSON });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.caveats).toContain(
      'Definition not retrieved; grants from edges.',
    );
    expect(r.value.data.caveats).toContain('Criteria-based sharing is deferred.');
  });

  it('extracts headline facts into bullets', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: FIELD_AUDIT_JSON });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.bullets).toContain('notModeled: true');
    expect(r.value.data.bullets).toContain('fieldId: CustomField:Contact.Email');
    expect(r.value.data.bullets).toContain('grants: 2 item(s)');
  });

  it('invents nothing — prose and SOQL are not cited', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: {
        note: 'Run SELECT COUNT() FROM Account to see the total.',
        label: 'Active Status',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.citations).toEqual([]);
  });

  it('flags draft ids absent from the source, grounds the rest, ignores trailing punctuation', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: FIELD_AUDIT_JSON,
      draft:
        'Editable via Profile:System_Administrator and read via ' +
        'PermissionSet:Conga_Batch_Manager. Also CustomField:Contact.FAKE__c ' +
        'and ApexClass:GhostService.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.groundedIds).toEqual([
      'PermissionSet:Conga_Batch_Manager',
      'Profile:System_Administrator',
    ]);
    expect(r.value.data.hallucinatedIds).toEqual([
      'ApexClass:GhostService',
      'CustomField:Contact.FAKE__c',
    ]);
  });

  it('omits draft fields when no draft is supplied', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: FIELD_AUDIT_JSON });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.hallucinatedIds).toBeUndefined();
    expect(r.value.data.groundedIds).toBeUndefined();
  });

  it('handles primitive / empty input without inventing anything', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.citations).toEqual([]);
    expect(r.value.data.caveats).toEqual([]);
    expect(r.value.data.bullets).toEqual([]);
  });

  // 0.1.17 FAIL-CLOSED grounding. End-user repro: a false draft with NO `input`
  // came back grounded:true, 0 citations, 0 hallucinated ids — rubber-stamping a
  // claim the vault never supported. A draft can only be grounded against real
  // evidence; with none, it must fail closed (grounded:false + caveat).
  it('fails closed: a draft with NO input is never grounded (end-user repro)', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      question: 'Is Amount__c safe to delete?',
      draft: 'Amount__c is safe to delete, nothing references it.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(false); // was true — the bug
    expect(r.value.data.hallucinatedIds).toEqual([]); // still 0, as the host saw
    expect(r.value.data.citations).toEqual([]);
    expect(
      r.value.data.caveats.some((c) => /GROUNDING NOT VERIFIED/.test(c)),
    ).toBe(true);
  });

  it('fails closed: a draft with an empty {} or [] input is never grounded', async () => {
    for (const empty of [{}, [] as unknown]) {
      const r = await synthesizeAnswerHandler(ctx, {
        input: empty,
        draft: 'Amount__c is safe to delete.',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.grounded).toBe(false);
    }
  });

  it('still grounds normally when real evidence backs the draft (no regression)', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: FIELD_AUDIT_JSON,
      draft: 'Editable via Profile:System_Administrator.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(true);
    expect(r.value.data.groundedIds).toContain('Profile:System_Administrator');
    expect(
      r.value.data.caveats.some((c) => /GROUNDING NOT VERIFIED/.test(c)),
    ).toBe(false);
  });

  it('rolls up a single source provenance for the host to stamp (P3-synthesize-trust)', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: { trust: { provenance: 'offline_snapshot' }, data: {} },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.provenance.stamp).toBe('offline_snapshot');
    expect(r.value.data.provenance.sources).toEqual(['offline_snapshot']);
  });

  it('stamps hybrid when the input fuses offline_snapshot + live_org', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: {
        vault: { trust: { provenance: 'offline_snapshot' } },
        live: { trust: { provenance: 'live_org' } },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.provenance.stamp).toBe('hybrid');
    expect(r.value.data.provenance.sources).toEqual([
      'live_org',
      'offline_snapshot',
    ]);
  });

  it('stamps null provenance when the input carries none', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: { data: { count: 3 } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.provenance.stamp).toBeNull();
    expect(r.value.data.provenance.sources).toEqual([]);
  });

  it('parses a JSON-STRING input so grounding + provenance still work (robustness)', async () => {
    // A host may hand the prior tool's output as a string rather than an object.
    const asString = JSON.stringify({
      fieldId: 'CustomField:Contact.Email',
      grants: [{ grantorId: 'PermissionSet:Sales' }],
      trust: { provenance: 'offline_snapshot' },
    });
    const r = await synthesizeAnswerHandler(ctx, {
      input: asString,
      draft: 'PermissionSet:Sales can edit it; Flow:Ghost is unrelated.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Ids inside the stringified JSON are grounded; the orphan is flagged.
    expect(d.citations.map((c) => c.id)).toContain('PermissionSet:Sales');
    expect(d.groundedIds).toContain('PermissionSet:Sales');
    expect(d.hallucinatedIds).toContain('Flow:Ghost');
    expect(d.hallucinatedIds).not.toContain('PermissionSet:Sales');
    // Provenance is recovered from the parsed string.
    expect(d.provenance.stamp).toBe('offline_snapshot');
  });

  it('P3-SYNTH-eval: grounding holds across 10+ representative tool-output chains', async () => {
    // Each entry is a realistic tool-output shape from a different family. A
    // draft built ONLY from its canonical ids must ground cleanly (empty
    // hallucinatedIds); an injected orphan id must be flagged. Synthetic ids.
    const CHAINS: { name: string; input: unknown; ids: string[] }[] = [
      {
        name: 'field_access_audit',
        input: { fieldId: 'CustomField:Account.SSN__c', grants: [{ grantorId: 'PermissionSet:HR' }], trust: { provenance: 'offline_snapshot' } },
        ids: ['CustomField:Account.SSN__c', 'PermissionSet:HR'],
      },
      {
        name: 'get_impact',
        input: { nodes: [{ id: 'CustomField:Account.Industry__c' }, { id: 'Flow:Account_After_Save' }], edges: [{ fromId: 'Flow:Account_After_Save', toId: 'CustomField:Account.Industry__c', edgeType: 'writesTo' }] },
        ids: ['CustomField:Account.Industry__c', 'Flow:Account_After_Save'],
      },
      {
        name: 'safe_to_delete_field',
        input: { fieldId: 'CustomField:Case.Legacy__c', verdict: 'blocking', reasoning: [{ category: 'formula', examples: [{ id: 'ValidationRule:Case.R1' }] }], trust: { provenance: 'offline_snapshot' } },
        ids: ['CustomField:Case.Legacy__c', 'ValidationRule:Case.R1'],
      },
      {
        name: 'code_quality_audit',
        input: { issues: [{ componentId: 'ApexClass:OrderService', confidence: 'heuristic' }] },
        ids: ['ApexClass:OrderService'],
      },
      {
        name: 'generate_sharing_summary',
        input: { document: { componentIds: ['CustomObject:Account'] } },
        ids: ['CustomObject:Account'],
      },
      {
        name: 'explain_flow',
        input: { flowId: 'Flow:Lead_Convert', triggerInfo: { object: 'CustomObject:Lead' } },
        ids: ['Flow:Lead_Convert', 'CustomObject:Lead'],
      },
      {
        name: 'find_code_usages',
        input: { usages: [{ id: 'ApexTrigger:AccountTrigger' }, { id: 'LightningComponentBundle:acctCard' }] },
        ids: ['ApexTrigger:AccountTrigger', 'LightningComponentBundle:acctCard'],
      },
      {
        name: 'field_360',
        input: { fieldId: 'CustomField:Opportunity.Amount', writers: { rows: [{ id: 'ApexClass:OppCalc' }] }, trust: { provenance: 'offline_snapshot' } },
        ids: ['CustomField:Opportunity.Amount', 'ApexClass:OppCalc'],
      },
      {
        name: 'integration_map',
        input: { endpoints: [{ id: 'NamedCredential:Payments' }], authProviders: [{ id: 'AuthProvider:Okta' }] },
        ids: ['NamedCredential:Payments', 'AuthProvider:Okta'],
      },
      {
        name: 'get_edges',
        input: { edges: [{ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Name', edgeType: 'parentOf' }] },
        ids: ['CustomObject:Account', 'CustomField:Account.Name'],
      },
      {
        name: 'what_if_deactivate_flow',
        input: { flowId: 'Flow:Case_Escalation', impacts: [{ source: 'ApexClass:CaseSvc' }] },
        ids: ['Flow:Case_Escalation', 'ApexClass:CaseSvc'],
      },
    ];
    expect(CHAINS.length).toBeGreaterThanOrEqual(10);

    for (const c of CHAINS) {
      const grounded = await synthesizeAnswerHandler(ctx, {
        input: c.input,
        draft: `The chain touches ${c.ids.join(' and ')}.`,
      });
      expect(grounded.ok, c.name).toBe(true);
      if (!grounded.ok) continue;
      // A draft made only of the chain's ids leaves NOTHING ungrounded.
      expect(grounded.value.data.hallucinatedIds, c.name).toEqual([]);
      expect([...(grounded.value.data.groundedIds ?? [])].sort(), c.name).toEqual(
        [...c.ids].sort(),
      );

      const withOrphan = await synthesizeAnswerHandler(ctx, {
        input: c.input,
        draft: `The chain touches ${c.ids.join(' and ')}, then Flow:Ghost_Orphan.`,
      });
      expect(withOrphan.ok, c.name).toBe(true);
      if (!withOrphan.ok) continue;
      expect(withOrphan.value.data.hallucinatedIds, c.name).toEqual([
        'Flow:Ghost_Orphan',
      ]);
    }
  });
});

// SYNTH-03 — golden multi-tool → synthesize chain. Run REAL tools against a
// seeded vault, feed their actual output to synthesize_answer, and prove the
// grounding contract: a draft built only from the chain has empty
// hallucinatedIds, while an orphan Flow:/ApexClass: id is flagged (the CI guard).
describe('synthesize golden chain (SYNTH-03)', () => {
  let chainStore: GraphStore;
  let chainCtx: Context;

  const node = (over: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
    apiName: 'x',
    label: null,
    parentId: null,
    sourcePath: 'unused.xml',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
    ...over,
  });
  const edge = (over: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
    confidence: 'parsed',
    source: 'unit-test',
    properties: {},
    ...over,
  });
  const seed: ExtractionResult = {
    nodes: [
      node({ id: 'Flow:Demo_Task_Flow', type: 'Flow', apiName: 'Demo_Task_Flow', label: 'Demo Task Flow' }),
      node({ id: 'ApexClass:Demo_TaskService', type: 'ApexClass', apiName: 'Demo_TaskService' }),
    ],
    edges: [
      edge({ fromId: 'Flow:Demo_Task_Flow', toId: 'ApexClass:Demo_TaskService', edgeType: 'callsApex' }),
    ],
  };

  beforeAll(async () => {
    const opened = await openGraph(join(tempDir, 'chain.duckdb'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    chainStore = opened.value;
    const imp = await importExtractionResults(chainStore, [seed]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    chainCtx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: chainStore };
  });
  afterAll(async () => {
    await closeGraph(chainStore);
  });

  const runChain = async () => {
    // Graph-backed tool: the outbound edge from the Flow carries both the Flow
    // (fromId) and the ApexClass (toId) — real ids the chain produced.
    const edges = await getEdgesHandler(chainCtx, {
      nodeId: 'Flow:Demo_Task_Flow',
      direction: 'out',
    });
    if (!edges.ok) throw new Error('chain tool call failed');
    return { edges: edges.value.data };
  };

  it('a draft built only from the real tool chain has EMPTY hallucinatedIds', async () => {
    const chain = await runChain();
    const r = await synthesizeAnswerHandler(chainCtx, {
      input: chain,
      draft:
        'Flow:Demo_Task_Flow runs on save and calls ApexClass:Demo_TaskService.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.hallucinatedIds).toEqual([]);
    expect(r.value.data.groundedIds).toEqual([
      'ApexClass:Demo_TaskService',
      'Flow:Demo_Task_Flow',
    ]);
  });

  it('CI guard: an orphan Flow:/ApexClass: id in the draft is flagged', async () => {
    const chain = await runChain();
    const r = await synthesizeAnswerHandler(chainCtx, {
      input: chain,
      draft:
        'Flow:Demo_Task_Flow calls ApexClass:Demo_TaskService, then ' +
        'Flow:Ghost_Flow hands off to ApexClass:Ghost_Service.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.hallucinatedIds).toEqual([
      'ApexClass:Ghost_Service',
      'Flow:Ghost_Flow',
    ]);
  });
});

// SYNTH bundle — the deterministic grounding pass must surface the
// flow/sharing/VR/false-premise fields the analytical tools emit, so a CORRECT
// cascade no longer flattens to an empty 0-bullet/0-caveat skeleton. Each test
// FAILS before the FACT_KEY/false-premise extensions and PASSES after.
describe('SYNTH bundle — surfaces flow/sharing/VR/false-premise facts', () => {
  it('lifts VR evaluation facts (errorConditionFormula, active, evaluatesAllActiveRules) into bullets', async () => {
    // ValidationRule cascade: both rules evaluate FALSE so the save succeeds;
    // one rule is inert only because its OWN formula tests the profile.
    const vrCascade = {
      verdict: 'save-succeeds',
      evaluatesAllActiveRules: true,
      rules: [
        {
          id: 'ValidationRule:Account.No_updates_to_Open',
          active: true,
          errorConditionFormula: 'ISCHANGED(StageName)',
        },
        {
          id: 'ValidationRule:Account.WidgetEdit',
          active: true,
          errorConditionFormula: "$Profile.Name = 'Sample_Profile'",
        },
      ],
    };
    const r = await synthesizeAnswerHandler(ctx, { input: vrCascade });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.data.bullets;
    expect(b).toContain('evaluatesAllActiveRules: true');
    expect(b).toContain('active: true');
    expect(b).toContain("errorConditionFormula: $Profile.Name = 'Sample_Profile'");
    // Both VR ids are cited, so the answer can name them.
    const ids = r.value.data.citations.map((c) => c.id);
    expect(ids).toContain('ValidationRule:Account.No_updates_to_Open');
    expect(ids).toContain('ValidationRule:Account.WidgetEdit');
    // The cascade is no longer an empty skeleton.
    expect(r.value.data.bullets.length).toBeGreaterThan(0);
  });

  it('lifts component-shape facts (apexCallCount, fieldAccessCount, isExposed) for a false-premise rebuttal', async () => {
    const componentShape = {
      componentId: 'LightningComponentBundle:applicationFormItem',
      apexCallCount: 0,
      fieldAccessCount: 0,
      isExposed: false,
    };
    const r = await synthesizeAnswerHandler(ctx, { input: componentShape });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.data.bullets;
    expect(b).toContain('apexCallCount: 0');
    expect(b).toContain('fieldAccessCount: 0');
    expect(b).toContain('isExposed: false');
  });

  it('lifts sharing semantics (sharingSemantics, effectiveModel, runInMode) into bullets', async () => {
    const sharingCascade = {
      componentId: 'ApexClass:ApplicationValidationService',
      sharingSemantics: 'inherited',
      effectiveModel: 'inherits-caller',
      runInMode: 'inherited',
      callers: [{ id: 'ApexClass:ApplicationFormService' }],
    };
    const r = await synthesizeAnswerHandler(ctx, { input: sharingCascade });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.data.bullets;
    expect(b).toContain('sharingSemantics: inherited');
    expect(b).toContain('effectiveModel: inherits-caller');
    expect(b).toContain('runInMode: inherited');
    expect(b).toContain('callers: 1 item(s)');
  });

  it('lifts flow trigger gate facts (triggerType, recordTriggerType, conditions, filterFormula)', async () => {
    const flowCascade = {
      flowId: 'Flow:Application_Field_Sync_To_Contact',
      triggerInfo: {
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'CreateAndUpdate',
        filterFormula: "{!$Profile.Name} = 'TRAA Community Login User'",
      },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: flowCascade });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.data.bullets;
    expect(b).toContain('triggerType: RecordAfterSave');
    expect(b).toContain('recordTriggerType: CreateAndUpdate');
    expect(b).toContain(
      "filterFormula: {!$Profile.Name} = 'TRAA Community Login User'",
    );
  });

  it('lifts transaction/save semantics (rollsBackTransaction, statement)', async () => {
    const saveCascade = {
      rollsBackTransaction: true,
      statement: 'All active validation rules fire on every DML regardless of profile.',
    };
    const r = await synthesizeAnswerHandler(ctx, { input: saveCascade });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.data.bullets;
    expect(b).toContain('rollsBackTransaction: true');
    expect(b).toContain(
      'statement: All active validation rules fire on every DML regardless of profile.',
    );
  });

  it('emits an explicit false-premise caveat when resolve disposition is "none"', async () => {
    // The named class does not exist in the vault — the premise is false.
    const noMatch = {
      query: 'ApplicationSubmissionService',
      disposition: 'none',
      candidates: [],
    };
    const r = await synthesizeAnswerHandler(ctx, { input: noMatch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caveat = r.value.data.caveats.find((c) => c.startsWith('FALSE PREMISE:'));
    expect(caveat).toBeDefined();
    expect(caveat).toContain('does not exist in the vault');
  });

  it('emits the false-premise caveat for a boolean premiseRejected/falsePremise signal', async () => {
    const rejected = {
      query: 'Admissions_Status_History__c',
      premiseRejected: true,
      redirectHint: 'CustomField:Contact.Best_Admission_Status__c',
    };
    const r = await synthesizeAnswerHandler(ctx, { input: rejected });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.caveats.some((c) => c.startsWith('FALSE PREMISE:')),
    ).toBe(true);
    // The redirect hint is still cited so the answer can point to the real field.
    expect(r.value.data.citations.map((c) => c.id)).toContain(
      'CustomField:Contact.Best_Admission_Status__c',
    );
  });

  it('does NOT emit a false-premise caveat when disposition is exact (no false positive)', async () => {
    const exact = { query: 'Account', disposition: 'exact', matchKind: 'exact' };
    const r = await synthesizeAnswerHandler(ctx, { input: exact });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.caveats.some((c) => c.startsWith('FALSE PREMISE:')),
    ).toBe(false);
  });
});

describe('synthesizeAnswerInputSchema', () => {
  it('accepts input of any shape plus optional question + draft', () => {
    expect(
      synthesizeAnswerInputSchema.safeParse({ input: { a: 1 } }).success,
    ).toBe(true);
    expect(
      synthesizeAnswerInputSchema.safeParse({
        input: 'x',
        question: 'q',
        draft: 'd',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-string question', () => {
    expect(
      synthesizeAnswerInputSchema.safeParse({ input: {}, question: 5 }).success,
    ).toBe(false);
  });
});

describe('grounded evidence template (P12-UX-synth-next-action)', () => {
  it('builds Finding → Evidence → Cause → Fix → Risk → Next-action ONLY from the source', async () => {
    const toolOutput = {
      verdict: 'restricted',
      reason: 'OWD is Private and no sharing rule grants access',
      recommendation: 'add a criteria-based sharing rule on CustomObject:Account',
      nextStep: 'run who_can_access_object on CustomObject:Account to confirm the new path',
      caveats: ['manual and Apex-managed sharing are not modeled'],
      componentId: 'CustomObject:Account',
    };
    const r = await synthesizeAnswerHandler(ctx, { input: toolOutput });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.data.evidence;
    expect(e.likelyCause).toBe('OWD is Private and no sharing rule grants access');
    expect(e.recommendedFix).toBe('add a criteria-based sharing rule on CustomObject:Account');
    // nextAction is present and lifted verbatim from the source nextStep.
    expect(e.nextAction).toBe('run who_can_access_object on CustomObject:Account to confirm the new path');
    expect(e.risk).toBe('manual and Apex-managed sharing are not modeled');
    // Evidence ids are grounded citations only.
    expect(e.evidence).toContain('CustomObject:Account');
  });

  it('nextAction falls back to the recommended fix when no explicit next-step (never fabricated)', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: { reason: 'unbounded SOQL', remediation: 'move the query out of the loop' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.evidence.nextAction).toBe('move the query out of the loop');
  });

  it('leaves template fields null when the source carries nothing for them (no invention)', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: { count: 3 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.data.evidence;
    expect(e.likelyCause).toBeNull();
    expect(e.recommendedFix).toBeNull();
    expect(e.nextAction).toBeNull();
    expect(e.orphanComponentIds).toEqual([]);
  });

  it('flags an ungrounded component id mentioned inside a cause/fix string (orphan step)', async () => {
    // The id sits INSIDE the reason prose and is never independently cited, so
    // it is an ungrounded reference the template must surface.
    const r = await synthesizeAnswerHandler(ctx, {
      input: { reason: 'blocked by ApexClass:GhostHandler which is not in the cited set' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.evidence.orphanComponentIds).toContain('ApexClass:GhostHandler');
  });
});

describe('responseBudget truncation carry (P13-GUARD-synth-caveat)', () => {
  it('composes an explicit caveat (with counts) from a truncated tool input — golden chain', async () => {
    // Simulates the global byte budget having reduced a prior tool's payload:
    // the synthesis over that input must disclose the reduction, with counts,
    // so absence of a row is never read as evidence of absence.
    const truncatedToolOutput = {
      data: {
        verdict: 'risky',
        rows: [{ id: 'CustomField:Account.Industry' }],
      },
      responseBudget: {
        applied: true,
        truncated: true,
        droppedCount: 120,
        stringsSlimmed: 2,
        note: 'Response exceeded the byte budget and was reduced to fit (lists tail-truncated, long strings trimmed). Narrow the query or page with limit/offset for complete rows.',
      },
      estimatedPayloadBytes: 39_500,
      vaultState: { sourceTreeHash: 'sha256:fixture', refreshedAt: '2026-05-27T14:33:08Z' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: truncatedToolOutput });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const caveat = r.value.data.caveats.find((c) => c.includes('REDUCED to fit the response byte budget'));
    expect(caveat).toBeDefined();
    expect(caveat).toContain('120 row(s) dropped');
    expect(caveat).toContain('2 long string(s) trimmed');
    // The composed caveat REPLACES the block's generic note (no double-carry).
    expect(r.value.data.caveats.filter((c) => c.includes('Narrow the query or page'))).toHaveLength(0);
  });

  it('emits no truncation caveat for an untruncated input', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: {
        data: { rows: [{ id: 'CustomObject:Account' }] },
        estimatedPayloadBytes: 900,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.caveats.some((c) => c.includes('response byte budget')),
    ).toBe(false);
  });
});

describe('annotation laundering check (P13-ANNOT-tools)', () => {
  const annotatedSource = {
    data: {
      fieldId: 'CustomField:Contact.Fax__c',
      annotations: {
        provenance: 'annotation',
        entries: [
          {
            componentId: 'CustomField:Contact.Fax__c',
            key: 'status',
            value: 'deprecated',
            author: 'pranav',
            source: 'human',
            confirmed: true,
            at: '2026-06-10T00:00:00.000Z',
          },
        ],
        disclosure: 'curated',
      },
      trust: { provenance: 'offline_snapshot' },
    },
  };

  it('grounds "X is deprecated" when the annotation exists — no flag', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: annotatedSource,
      draft: 'CustomField:Contact.Fax__c is deprecated per the field owner.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.ungroundedAnnotationClaims).toBeUndefined();
  });

  it('flags "X is deprecated" when NO annotation backs it (hallucinated lifecycle claim)', async () => {
    const bare = {
      data: {
        fieldId: 'CustomField:Contact.Fax__c',
        trust: { provenance: 'offline_snapshot' },
      },
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: bare,
      draft: 'CustomField:Contact.Fax__c is deprecated, so deleting is fine.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const claims = r.value.data.ungroundedAnnotationClaims ?? [];
    expect(claims.length).toBe(1);
    expect(claims[0]?.id).toBe('CustomField:Contact.Fax__c');
    expect(claims[0]?.note).toContain('propose_annotation');
  });

  it('annotation provenance never bleeds into offline_snapshot (a4 invariant): roll-up reads mixed', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: annotatedSource });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.provenance.sources).toContain('annotation');
    expect(r.value.data.provenance.sources).toContain('offline_snapshot');
    expect(r.value.data.provenance.stamp).toBe('mixed'); // NEVER collapsed to offline_snapshot
  });
});

// I3c (structural honesty — grounding guard). synthesize_answer is now
// ABSENCE-AWARE: a draft that narrates "no X references this / it's unused /
// safe to delete" over a source carrying an incomplete-coverage signal
// (coverageCaveat / notModeled / retrievalHint / dataNotAvailable / partial
// trust.completeness) is flagged grounded:false with the claim listed. Absence
// over COMPLETE coverage, or no absence claim at all, stays grounded:true.
describe('I3c absence-as-fact grounding guard', () => {
  // The I3b empty-traversal caveat shape a graph tool emits on an EMPTY result.
  const coverageCaveat = {
    status: 'partial',
    missingCoverage: ['ApexClass', 'Flow', 'ValidationRule'],
    message:
      'This is an EMPTY result. "Nothing references / uses this" can only be asserted for the dependency families the vault actually retrieved cannot be confirmed because the vault has incomplete coverage for: ApexClass, Flow, ValidationRule. Treat absence of dependencies in those families as "not checked", not "none".',
  };
  // A get_impact-shaped EMPTY result carrying the I3b caveat.
  const emptyImpactWithCaveat = {
    nodeId: 'CustomField:Account.Legacy_Code__c',
    nodes: [],
    edges: [],
    coverageCaveat,
    trust: {
      provenance: 'offline_snapshot',
      completeness: { status: 'partial', missingCoverage: ['ApexClass', 'Flow'] },
    },
  };

  it('absence claim + INCOMPLETE coverage → grounded:false + the claim listed', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: emptyImpactWithCaveat,
      draft:
        'No flows or Apex reference CustomField:Account.Legacy_Code__c, so it is ' +
        'safe to delete.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.grounded).toBe(false);
    expect(d.ungroundedAbsenceClaims).toBeDefined();
    expect(d.ungroundedAbsenceClaims?.length).toBeGreaterThan(0);
    // Both the "no flows…reference" and "safe to delete" absence assertions are
    // in one sentence; the sentence is surfaced verbatim.
    expect(
      d.ungroundedAbsenceClaims?.some((c) => c.includes('safe to delete')),
    ).toBe(true);
    // The summary announces the guard fired.
    expect(d.summary).toContain('grounded=false');
  });

  it('absence claim + COMPLETE coverage → grounded:true (no false positive)', async () => {
    // Same empty result but NO incomplete-coverage signal (complete coverage).
    const emptyImpactComplete = {
      nodeId: 'CustomField:Account.Legacy_Code__c',
      nodes: [],
      edges: [],
      trust: {
        provenance: 'offline_snapshot',
        completeness: { status: 'complete' },
      },
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: emptyImpactComplete,
      draft:
        'No flows or Apex reference CustomField:Account.Legacy_Code__c; it is ' +
        'unused and safe to delete.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.grounded).toBe(true);
    expect(d.ungroundedAbsenceClaims).toEqual([]);
    expect(d.summary).not.toContain('grounded=false');
  });

  it('NO absence claim → grounded:true even when coverage is incomplete', async () => {
    // Coverage is partial, but the draft asserts a POSITIVE fact (a reference
    // exists) — the guard only fires on ABSENCE assertions.
    const r = await synthesizeAnswerHandler(ctx, {
      input: emptyImpactWithCaveat,
      draft:
        'CustomField:Account.Legacy_Code__c is a plain text field on Account.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.grounded).toBe(true);
    expect(d.ungroundedAbsenceClaims).toEqual([]);
  });

  it('the two new fields are ADDITIVE and present only with a draft (no-draft = golden shape)', async () => {
    const noDraft = await synthesizeAnswerHandler(ctx, {
      input: emptyImpactWithCaveat,
    });
    expect(noDraft.ok).toBe(true);
    if (!noDraft.ok) return;
    // No draft → the draft-gated fields are absent (byte-identity with the
    // no-draft golden preserved).
    expect(noDraft.value.data.grounded).toBeUndefined();
    expect(noDraft.value.data.ungroundedAbsenceClaims).toBeUndefined();
    expect(noDraft.value.data.hallucinatedIds).toBeUndefined();

    const withDraft = await synthesizeAnswerHandler(ctx, {
      input: emptyImpactWithCaveat,
      draft: 'CustomField:Account.Legacy_Code__c is a text field.',
    });
    expect(withDraft.ok).toBe(true);
    if (!withDraft.ok) return;
    // With a draft → both fields are ALWAYS present (structural, not opt-in).
    expect(typeof withDraft.value.data.grounded).toBe('boolean');
    expect(Array.isArray(withDraft.value.data.ungroundedAbsenceClaims)).toBe(true);
  });

  it('fires on notModeled=true (field_access_audit shape) — "no grants" over a not-modeled field', async () => {
    const notModeledField = {
      fieldId: 'CustomField:Contact.SSN__c',
      notModeled: true,
      notModeledNote: 'Definition not retrieved; grants from edges only.',
      grants: [],
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: notModeledField,
      draft: 'Nothing grants access to CustomField:Contact.SSN__c.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(false);
    expect(
      r.value.data.ungroundedAbsenceClaims?.some((c) => /nothing/i.test(c)),
    ).toBe(true);
  });

  it('fires on a non-empty dataNotAvailable array (field_360 shape)', async () => {
    const field360 = {
      fieldId: 'CustomField:Opportunity.Amount',
      writers: { rows: [] },
      dataNotAvailable: ['list-view-filters', 'report-column-usage'],
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: field360,
      draft: 'No reports use CustomField:Opportunity.Amount.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(false);
    expect(r.value.data.ungroundedAbsenceClaims?.length).toBeGreaterThan(0);
  });

  it('fires on a retrievalHint string (list_components / FRESH-02 shape)', async () => {
    const partialList = {
      type: 'Flow',
      components: [],
      retrievalHint:
        'This type was not retrieved by the last refresh; run /sfi-refresh for complete coverage.',
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: partialList,
      draft: 'There are no flows in this org.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(false);
  });

  it('a caveat STRING that reads "not checked" is an incompleteness signal (no structured object needed)', async () => {
    const stringOnlyCaveat = {
      nodeId: 'CustomField:Case.Old_Status__c',
      edges: [],
      caveat:
        'Treat absence of dependencies in those families as "not checked", not "none".',
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: stringOnlyCaveat,
      draft: 'No triggers reference CustomField:Case.Old_Status__c.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(false);
  });

  it('a real deprecation-without-annotation is STILL flagged (claim-class generalization did not regress the lifecycle check)', async () => {
    // The absence generalization must not weaken the annotation-laundering pass.
    const bare = {
      data: {
        fieldId: 'CustomField:Contact.Fax__c',
        trust: { provenance: 'offline_snapshot', completeness: { status: 'complete' } },
      },
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: bare,
      draft: 'CustomField:Contact.Fax__c is deprecated, so removing it is fine.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Deprecation without annotation → still flagged in ungroundedAnnotationClaims.
    const claims = r.value.data.ungroundedAnnotationClaims ?? [];
    expect(claims.length).toBe(1);
    expect(claims[0]?.id).toBe('CustomField:Contact.Fax__c');
    // Coverage is COMPLETE here and the draft makes no absence claim, so the
    // absence guard stays grounded:true — the two guards are independent.
    expect(r.value.data.grounded).toBe(true);
    expect(r.value.data.ungroundedAbsenceClaims).toEqual([]);
  });

  it('an absence claim with NO source coverage signal at all stays grounded:true (bare positive source)', async () => {
    // A source that carries neither a coverage signal nor a completeness block
    // is treated as complete (never false-flag legacy/pre-v4 shapes).
    const r = await synthesizeAnswerHandler(ctx, {
      input: { nodeId: 'CustomObject:Account', edges: [] },
      draft: 'Nothing references CustomObject:Account.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(true);
    expect(r.value.data.ungroundedAbsenceClaims).toEqual([]);
  });
});

// Bundle 6 — structural caveat detectors added to synthesize_answer.
// Each test covers one of the five bug classes in this bundle and uses a
// REAL-org-shape fixture (the actual property names / XML element shapes
// used by list_components, approval-process extractors, and matching-rule
// extractors in production).
describe('bundle-6 structural caveats', () => {
  // BUG-1: Pagination disclosure — hasMore=true means only the first page was
  // retrieved; the cascade must not draw family-wide conclusions from a partial set.
  // Real shape: list_components emits hasMore at the top level AND inside pageInfo.
  it('emits INCOMPLETE RETRIEVAL caveat when hasMore=true (Bug 1 — paginated rule family)', async () => {
    // Real org shape: list_components response for ValidationRule on Lead with 73 rules,
    // default limit=50, so hasMore=true and the _Email_3 + _SrcofContact_123 rules are
    // beyond the first page.
    const partialListComponentsOutput = {
      components: [
        {
          id: 'ValidationRule:Lead.ContactCategorySecurity_AreaofInterest_1',
          type: 'ValidationRule',
          apiName: 'Lead.ContactCategorySecurity_AreaofInterest_1',
          label: 'ContactCategorySecurity_AreaofInterest_1',
          parentId: 'CustomObject:Lead',
          sourcePath: 'objects/Lead/validationRules/ContactCategorySecurity_AreaofInterest_1.validationRule-meta.xml',
          lastModifiedDate: null,
          lastModifiedBy: null,
          apiVersion: null,
          properties: { active: 'true', errorConditionFormula: "AND($User.Alias != 'iuser', TEXT(Contact_Security_Group__c)='1')" },
        },
        {
          id: 'ValidationRule:Lead.ContactCategorySecurity_City_1or2',
          type: 'ValidationRule',
          apiName: 'Lead.ContactCategorySecurity_City_1or2',
          label: 'ContactCategorySecurity_City_1or2',
          parentId: 'CustomObject:Lead',
          sourcePath: 'objects/Lead/validationRules/ContactCategorySecurity_City_1or2.validationRule-meta.xml',
          lastModifiedDate: null,
          lastModifiedBy: null,
          apiVersion: null,
          properties: { active: 'true', errorConditionFormula: "AND($User.Alias != 'iuser', TEXT(Contact_Security_Group__c)='1'||TEXT(Contact_Security_Group__c)='2')" },
        },
        // (48 more rules omitted — Email_3 and SrcofContact_123 are on page 2)
      ],
      limit: 50,
      offset: 0,
      hasMore: true,
      pageInfo: {
        totalCount: 73,
        returnedCount: 50,
        hasMore: true,
        nextCursor: 'eyJ2IjoxLCJ0IjoibGlzdF9jb21wb25lbnRzIiwiaCI6InNoYTI1NjpmaXh0dXJlIiwibyI6NTB9',
      },
      trust: { provenance: 'offline_snapshot' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: partialListComponentsOutput });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const incompleteCaveat = r.value.data.caveats.find((c) => c.includes('INCOMPLETE RETRIEVAL'));
    expect(incompleteCaveat).toBeDefined();
    expect(incompleteCaveat).toContain('hasMore=true');
    expect(incompleteCaveat).toContain('first page');
    // The hasMore fact must also appear as a bullet.
    expect(r.value.data.bullets.some((b) => b.startsWith('hasMore:'))).toBe(true);
  });

  it('does NOT emit INCOMPLETE RETRIEVAL caveat when hasMore=false (no false positive)', async () => {
    const completeOutput = {
      components: [
        { id: 'ValidationRule:Lead.ContactCategorySecurity_Email_3', type: 'ValidationRule', apiName: 'Lead.ContactCategorySecurity_Email_3', label: 'ContactCategorySecurity_Email_3', parentId: 'CustomObject:Lead', sourcePath: 'objects/Lead/validationRules/ContactCategorySecurity_Email_3.validationRule-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: 'true' } },
      ],
      limit: 50,
      offset: 0,
      hasMore: false,
      trust: { provenance: 'offline_snapshot' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: completeOutput });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.caveats.some((c) => c.includes('INCOMPLETE RETRIEVAL'))).toBe(false);
  });

  // BUG-3: Count consistency — a list_components response that states totalCount=11
  // but enumerates only 10 items in `components` is a count mismatch. The synthesis
  // must detect and disclose this so the host corrects the stated total.
  // Real shape: OA_Communication_Request__c has 10 approval process files on disk;
  // a stale count cache or off-by-one in the synthesis produced "11" in the summary.
  it('emits COUNT MISMATCH caveat when stated total differs from enumerated components length (Bug 3 — OA count)', async () => {
    // Real org shape: 10 approval process files, but the stated count is 11 (the bug).
    const mismatchedListOutput = {
      components: [
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approval', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approval', label: 'CommRequest_Approval', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approval.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approvalv2', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approvalv2', label: 'CommRequest_Approvalv2', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approvalv2.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approvalv3', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approvalv3', label: 'CommRequest_Approvalv3', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approvalv3.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approvalv4', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approvalv4', label: 'CommRequest_Approvalv4', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approvalv4.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approvalv5', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approvalv5', label: 'CommRequest_Approvalv5', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approvalv5.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approvalv6', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approvalv6', label: 'CommRequest_Approvalv6', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approvalv6.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approvalv7', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approvalv7', label: 'CommRequest_Approvalv7', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approvalv7.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approvalv8', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approvalv8', label: 'CommRequest_Approvalv8', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approvalv8.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: true } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.OA_CommRequest', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.OA_CommRequest', label: 'OA_CommRequest', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.OA_CommRequest.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
        { id: 'ApprovalProcess:OA_Communication_Request__c.OA_CommRequest_Approval', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.OA_CommRequest_Approval', label: 'OA_CommRequest_Approval', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.OA_CommRequest_Approval.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: false } },
      ],
      // The bug: stated total is 11, but there are only 10 files on disk.
      totalCount: 11,
      limit: 50,
      offset: 0,
      hasMore: false,
      trust: { provenance: 'offline_snapshot' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: mismatchedListOutput });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mismatchCaveat = r.value.data.caveats.find((c) => c.includes('COUNT MISMATCH'));
    expect(mismatchCaveat).toBeDefined();
    expect(mismatchCaveat).toContain('totalCount=11');
    expect(mismatchCaveat).toContain('10 item(s)');
    expect(mismatchCaveat).toContain('use the enumerated count (10)');
  });

  it('does NOT emit COUNT MISMATCH when stated total matches enumerated length (no false positive)', async () => {
    const matchingOutput = {
      components: [
        { id: 'ApprovalProcess:OA_Communication_Request__c.CommRequest_Approvalv8', type: 'ApprovalProcess', apiName: 'OA_Communication_Request__c.CommRequest_Approvalv8', label: 'CommRequest_Approvalv8', parentId: 'CustomObject:OA_Communication_Request__c', sourcePath: 'approvalProcesses/OA_Communication_Request__c.CommRequest_Approvalv8.approvalProcess-meta.xml', lastModifiedDate: null, lastModifiedBy: null, apiVersion: null, properties: { active: true } },
      ],
      totalCount: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
      trust: { provenance: 'offline_snapshot' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: matchingOutput });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.caveats.some((c) => c.includes('COUNT MISMATCH'))).toBe(false);
  });

  // BUG-4: Inactive ApprovalProcess + sibling retrieval — when an approval process
  // with active=false is in the cascade, the sibling active processes are missing.
  // Real shape: get_component on an inactive versioned approval process returns
  // active=false; the active successor version was not retrieved by the cascade.
  it('emits INACTIVE APPROVAL PROCESS caveat when ApprovalProcess is cited and active=false (Bug 4 — inactive versioned process)', async () => {
    // Real org shape: get_component output for an inactive approval process on
    // a versioned credit-limit process. The V3 successors are NOT in this payload.
    const inactiveApprovalProcess = {
      id: 'ApprovalProcess:Contract__c.Credit_Limit_V2',
      type: 'ApprovalProcess',
      apiName: 'Contract__c.Credit_Limit_V2',
      label: 'Credit_Limit_V2',
      parentId: 'CustomObject:Contract__c',
      sourcePath: 'approvalProcesses/Contract__c.Credit_Limit_V2.approvalProcess-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        active: false,
        entryCriteria: "AND(Approval_Status__c = 'Required', Hours_Limit_Approval_Status__c = 'Not Required')",
        initialSubmitters: 'submitter',
        finalApprovalRecordLock: false,
        allowRecall: false,
      },
      trust: { provenance: 'offline_snapshot' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: inactiveApprovalProcess });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const siblingCaveat = r.value.data.caveats.find((c) => c.includes('INACTIVE APPROVAL PROCESS'));
    expect(siblingCaveat).toBeDefined();
    expect(siblingCaveat).toContain('active=false');
    expect(siblingCaveat).toContain('sibling active processes');
    expect(siblingCaveat).toContain('list_components');
  });

  it('does NOT emit INACTIVE APPROVAL PROCESS caveat for a non-ApprovalProcess active=false (no false positive)', async () => {
    // A flow with active=false should not trigger the approval-process sibling caveat.
    const inactiveFlow = {
      id: 'Flow:Legacy_Assignment',
      type: 'Flow',
      apiName: 'Legacy_Assignment',
      active: false,
      trust: { provenance: 'offline_snapshot' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: inactiveFlow });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.caveats.some((c) => c.includes('INACTIVE APPROVAL PROCESS'))).toBe(false);
  });

  // BUG-5: booleanFilter vs matchingMethods — the cascade conflated the OR structure
  // in booleanFilter with per-field fuzziness. synthesize_answer must emit a structural
  // interpretation note when both are present.
  // Real shape: get_component on MatchingRule:Contact.Contact_FirstLastNameEmail returns
  // booleanFilter='(1 AND 2) OR (3 OR 4) OR 5' and matchingMethods='FirstName,LastName,Exact'
  // from properties extracted by matching-rule.ts.
  it('emits MATCHING RULE dimension caveat when booleanFilter and matchingMethods are both present (Bug 5)', async () => {
    // Real org shape: get_component output for MatchingRule:Contact.Contact_FirstLastNameEmail.
    // properties.booleanFilter and properties.matchingMethods come from the matching-rule extractor.
    const matchingRuleOutput = {
      id: 'MatchingRule:Contact.Contact_FirstLastNameEmail',
      type: 'MatchingRule',
      apiName: 'Contact.Contact_FirstLastNameEmail',
      label: 'Contact First Last Name Email',
      parentId: 'CustomObject:Contact',
      sourcePath: 'objects/Contact/matchingRules/Contact.matchingRule-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        ruleStatus: 'Active',
        booleanFilter: '(1 AND 2) OR (3 OR 4) OR 5',
        itemCount: 5,
        matchingMethods: 'FirstName,LastName,Exact',
        fieldsCompared: 'FirstName,LastName,Email,Phone,MobilePhone',
      },
      trust: { provenance: 'offline_snapshot' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: matchingRuleOutput });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dimensionCaveat = r.value.data.caveats.find((c) => c.includes('MATCHING RULE'));
    expect(dimensionCaveat).toBeDefined();
    expect(dimensionCaveat).toContain('booleanFilter');
    expect(dimensionCaveat).toContain('matchingMethods');
    expect(dimensionCaveat).toContain('trigger breadth');
    expect(dimensionCaveat).toContain('fuzziness');
    // Both properties surface as bullets.
    expect(r.value.data.bullets.some((b) => b.startsWith('booleanFilter:'))).toBe(true);
    expect(r.value.data.bullets.some((b) => b.startsWith('matchingMethods:'))).toBe(true);
  });

  it('does NOT emit MATCHING RULE caveat when only booleanFilter is present (no false positive)', async () => {
    // A sharing rule with booleanFilter but no matchingMethods should not trigger.
    const sharingRule = {
      id: 'SharingRule:Account.Acct_Territory',
      type: 'SharingRule',
      apiName: 'Account.Acct_Territory',
      properties: {
        booleanFilter: '1',
        sharingSemantics: 'criteria-based',
      },
      trust: { provenance: 'offline_snapshot' },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: sharingRule });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.caveats.some((c) => c.includes('MATCHING RULE'))).toBe(false);
  });
});

// RM-3 (steps 3b–3e). synthesize_answer folds the typed Interpretation[] that
// sfi.interpret produces into the assembled answer: the shape-gated collector
// populates evidence.interpretations, the claim(s) take PRECEDENCE over the
// key-name scrape for likelyCause/nextAction, coverageCaveat surfaces, and an
// interpret-explicit incompleteness signal (confidence unknown / non-null
// coverageCaveat / fired-nothing empty) degrades the absence guard. An EMPTY
// interpret result is disclosed as "no concept rule fired", never a safe verdict.
describe('RM-3 interpret fold', () => {
  // A realistic sfi.interpret payload, McpResponse-nested under `data`.
  const interpret = (
    interpretations: readonly Record<string, unknown>[],
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    data: {
      componentId: 'CustomField:Account.Amount__c',
      componentType: 'CustomField',
      interpretations,
      rulesConsidered: 7,
      rulesFired: interpretations.length,
      sliceTruncated: false,
      trust: {
        provenance: 'offline_snapshot',
        completeness: { status: 'complete' },
      },
      disclosure: 'deterministic offline interpretation',
      rendered: 'rendered text',
      ...over,
    },
    vaultState: {
      sourceTreeHash: 'sha256:fixture',
      refreshedAt: '2026-05-27T14:33:08Z',
    },
  });
  const formulaClaim = {
    ruleId: 'rule:field-provenance/is-formula',
    concept: 'concept:field-provenance',
    claim:
      'CustomField:Account.Amount__c is a formula field; its value is computed ' +
      'and cannot be written by Flow or Apex.',
    groundedIn: ['CustomField:Account.Amount__c'],
    confidence: 'declared',
    coverageCaveat: null,
    modelVersion: '1.0.0',
    provenance: 'offline_snapshot',
  };

  // 3b — the shape-gated collector populates evidence.interpretations and the
  // groundedIn ids flow into citations via the existing recursion.
  it('populates evidence.interpretations from a typed Interpretation[] (groundedIn → citations)', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: interpret([formulaClaim]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.data.evidence;
    expect(e.interpretations).toHaveLength(1);
    expect(e.interpretations[0]?.ruleId).toBe('rule:field-provenance/is-formula');
    expect(e.interpretations[0]?.concept).toBe('concept:field-provenance');
    expect(e.interpretations[0]?.claim).toContain('formula field');
    expect(e.interpretations[0]?.groundedIn).toEqual(['CustomField:Account.Amount__c']);
    // groundedIn id is a grounded citation via the existing whole-id recursion.
    expect(r.value.data.citations.map((c) => c.id)).toContain(
      'CustomField:Account.Amount__c',
    );
  });

  it('does NOT collect an unrelated array that only partially matches the Interpretation shape', async () => {
    // An `interpretations`-named array whose elements lack the full key-set
    // (no groundedIn / provenance) must NOT be folded — shape-gating, not a
    // bare key match.
    const decoy = {
      data: {
        interpretations: [
          { claim: 'this is not a real interpretation', concept: 'x' },
        ],
        rulesFired: 1,
        rulesConsidered: 1,
      },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: decoy });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.evidence.interpretations).toEqual([]);
  });

  // FIX-F3 — a NON-EMPTY interpret payload whose interpretation entries ALL fail
  // the shape gate (cross-version/shape drift) lifts zero valid claims. It must
  // be DISCLOSED as "could not be parsed", never resolved silently to nothing —
  // and it is NOT the "no concept rule fired" framing (a rule did produce output).
  it('discloses a shape-drifted (non-empty but unparseable) interpretations array', async () => {
    const drifted = {
      data: {
        componentId: 'CustomField:Account.Amount__c',
        componentType: 'CustomField',
        // Non-empty, but every element is missing the required key-set (drift).
        interpretations: [
          { claim: 'renamed-key result', kind: 'formula' },
          { note: 'another reshaped element' },
        ],
        rulesConsidered: 4,
        rulesFired: 2,
        trust: {
          provenance: 'offline_snapshot',
          completeness: { status: 'complete' },
        },
      },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: drifted });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Nothing valid was lifted ...
    expect(r.value.data.evidence.interpretations).toEqual([]);
    // ... but the drift is DISCLOSED (not swallowed) ...
    expect(
      r.value.data.caveats.some((c) => /could NOT be parsed/i.test(c)),
    ).toBe(true);
    // ... and it is NOT laundered into the fired-nothing framing.
    expect(
      r.value.data.caveats.some((c) => c.includes('NO concept rule fired')),
    ).toBe(false);
  });

  // FIX-F4 — a NON-interpret payload that coincidentally carries `interpretations: []`
  // beside a SINGLE numeric counter must NOT trip the empty-interpretation caveat:
  // every real InterpretOutput carries BOTH `rulesFired` and `rulesConsidered`, so
  // the interpretation-free byte-identity claim holds strictly.
  it('stays byte-identical for a coincidental non-interpret payload (single counter, empty array)', async () => {
    const coincidental = {
      data: {
        // A rules-engine-shaped result that is NOT an interpret payload.
        verdict: 'ok',
        interpretations: [],
        rulesFired: 3,
      },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: coincidental });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.evidence.interpretations).toEqual([]);
    // No empty-interpretation caveat (the payload is not interpret-shaped) ...
    expect(
      r.value.data.caveats.some((c) => c.includes('NO concept rule fired')),
    ).toBe(false);
    // ... and no shape-drift caveat either.
    expect(
      r.value.data.caveats.some((c) => /could NOT be parsed/i.test(c)),
    ).toBe(false);
  });

  // 3c (FIX-F1/F2, a deliberate design correction toward calibrated honesty) —
  // NON-CLOBBER: an on-topic SCRAPED cause KEEPS `likelyCause`; the interpretation
  // claim is surfaced as a hedged SUPPLEMENTARY note, never overwriting the
  // scraped evidence. A structural claim is a CAUSE, not an ACTION, so
  // `nextAction` reverts to the scrape.
  it('does NOT clobber a scraped cause: claim → hedged supplementary note, nextAction stays the scrape', async () => {
    const hedged = {
      ...formulaClaim,
      confidence: 'heuristic',
      coverageCaveat:
        'Apex coverage is partial; a dynamic SOQL write to this field would be ' +
        'invisible to the engine.',
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpret([hedged], {
        // An on-topic scraped cause + next-step the fold must NOT overwrite. This
        // mirrors a mixed input where a sharing tool supplied the real cause and
        // an off-topic formula interpretation also fired.
        reason: 'OWD is Private and no sharing rule grants the caller access',
        nextStep: 'run who_can_access_object to confirm the sharing path',
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.data.evidence;
    // The scraped cause WINS likelyCause (non-clobber) — the claim does not bury it.
    expect(e.likelyCause).toBe(
      'OWD is Private and no sharing rule grants the caller access',
    );
    expect(e.likelyCause).not.toContain('formula field');
    // nextAction is the scrape — a structural claim is never presented as an action.
    expect(e.nextAction).toBe('run who_can_access_object to confirm the sharing path');
    expect(e.nextAction).not.toContain('formula field');
    // The claim is surfaced as a hedged supplementary note (not clobbered away) ...
    expect(e.interpretationNotes.some((n) => n.includes('formula field'))).toBe(true);
    // ... and the hedge travels WITH it, so it never reads as a bare hard fact.
    expect(
      e.interpretationNotes.some(
        (n) => n.includes('dynamic SOQL write') || n.includes('heuristic'),
      ),
    ).toBe(true);
    // The typed interpretation surface is intact; per-item confidence preserved.
    expect(e.interpretations).toHaveLength(1);
    expect(e.interpretations[0]?.confidence).toBe('heuristic');
    // The coverageCaveat is still surfaced as risk here (no scraped caveat present).
    expect(e.risk).toContain('dynamic SOQL write');
    expect(r.value.data.citations.map((c) => c.id)).toContain(
      'CustomField:Account.Amount__c',
    );
  });

  // FIX-F1 — the pure reasoning flow (NO scraped cause): the claim FILLS
  // `likelyCause` (a cause, never `nextAction`), carrying its hedge inline.
  it('a claim with no scraped cause fills likelyCause (not nextAction), hedge attached', async () => {
    const hedged = {
      ...formulaClaim,
      confidence: 'heuristic',
      coverageCaveat: 'rollup coverage is partial',
    };
    const r = await synthesizeAnswerHandler(ctx, { input: interpret([hedged]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.data.evidence;
    // The claim fills likelyCause (there was no scraped cause) ...
    expect(e.likelyCause).toContain('formula field');
    // ... carrying its hedge inline (never a bare hard fact) ...
    expect(e.likelyCause).toMatch(/heuristic|rollup coverage is partial/);
    // ... and it is NOT surfaced as the next action (a claim is a cause, not a step).
    expect(e.nextAction).toBeNull();
    // Not double-surfaced as a note when it already holds likelyCause.
    expect(e.interpretationNotes).toEqual([]);
  });

  // FIX-F2 — calibration, not blanket hedging: a FULLY-GROUNDED claim (declared,
  // no coverageCaveat) surfaces as a firm fact with NO spurious hedge appended.
  it('a fully-grounded (declared) claim surfaces WITHOUT a hedge', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: interpret([formulaClaim]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.data.evidence;
    expect(e.likelyCause).toContain('formula field');
    expect(e.likelyCause).not.toContain('confidence:');
    expect(e.likelyCause).not.toContain('[');
  });

  it('presents a compound security concept once while preserving its constituent interpretations', async () => {
    const componentId = 'ApexClass:ExternalController';
    const base = {
      groundedIn: [componentId],
      confidence: 'declared',
      coverageCaveat: null,
      modelVersion: '1.0.0',
      provenance: 'offline_snapshot',
    };
    const external = {
      ...base,
      ruleId: 'rule:external-api-surface/aura-enabled',
      concept: 'concept:external-api-surface',
      claim: `${componentId} exposes an Aura endpoint.`,
    };
    const sharing = {
      ...base,
      ruleId: 'rule:apex-sharing/without-sharing',
      concept: 'concept:apex-sharing-mode',
      claim: `${componentId} is declared without sharing.`,
    };
    const compound = {
      ...base,
      ruleId: 'rule:system-context-external-surface/aura-enabled',
      concept: 'concept:system-context-external-surface',
      claim: `${componentId} is an externally reachable system-context security-review priority.`,
    };

    const r = await synthesizeAnswerHandler(ctx, {
      input: interpret([external, sharing, compound]),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.data.evidence;

    // Audit fidelity is unchanged: all source interpretations remain typed.
    expect(e.interpretations).toHaveLength(3);
    expect(e.interpretations.map((i) => i.ruleId)).toEqual([
      external.ruleId,
      sharing.ruleId,
      compound.ruleId,
    ]);
    // Presentation uses the conjunction once rather than repeating its parts.
    expect(e.likelyCause).toContain('security-review priority');
    expect(e.likelyCause).not.toContain('exposes an Aura endpoint');
    expect(e.likelyCause).not.toContain('declared without sharing');
    expect(e.interpretationNotes).toEqual([]);
    expect(e.orphanComponentIds).toEqual([]);
  });

  // 3d — the coverageCaveat (which the anchored CAVEAT_KEY does not match) is
  // surfaced through the shape-gated collector, both per-interpretation and at
  // the payload level.
  it('surfaces the per-interpretation and payload-level coverageCaveat as caveats', async () => {
    const hedged = {
      ...formulaClaim,
      confidence: 'heuristic',
      coverageCaveat: 'PER-INTERPRETATION: rollup coverage is partial.',
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpret([hedged], {
        coverageCaveat: 'PAYLOAD-LEVEL: this interpret run had incomplete coverage.',
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.caveats.some((c) => c.includes('PER-INTERPRETATION')),
    ).toBe(true);
    expect(
      r.value.data.caveats.some((c) => c.includes('PAYLOAD-LEVEL')),
    ).toBe(true);
  });

  // 3e — an interpret-EXPLICIT incompleteness signal (confidence "unknown")
  // degrades an absence draft to grounded:false even when the heuristic coverage
  // scan is silent (trust.completeness is "complete", no coverageCaveat).
  it('confidence "unknown" degrades an absence draft even when the heuristic scan is silent', async () => {
    const unknownClaim = {
      ...formulaClaim,
      confidence: 'unknown',
      coverageCaveat: null,
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpret([unknownClaim]), // trust.completeness = complete → heuristic silent
      draft:
        'Nothing depends on CustomField:Account.Amount__c, so it is safe to delete.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(false);
    expect(r.value.data.ungroundedAbsenceClaims?.length).toBeGreaterThan(0);
    expect(r.value.data.summary).toContain('grounded=false');
  });

  it('a fully-grounded interpretation (declared, complete, no caveat) does NOT over-fire the guard', async () => {
    // Control: the override adds signal, it must not flip a legitimately
    // complete answer. An absence draft over a complete interpretation stays true.
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpret([formulaClaim]), // declared + complete + coverageCaveat null
      draft: 'Nothing else depends on CustomField:Account.Amount__c.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(true);
    expect(r.value.data.ungroundedAbsenceClaims).toEqual([]);
  });

  // 3e / absence-honesty guardrail — an EMPTY interpret result is disclosed as
  // "no concept rule fired", NEVER a "safe"/"no-dependency" verdict.
  it('an EMPTY interpret result renders the honest no-rule-fired framing (guardrail)', async () => {
    const r = await synthesizeAnswerHandler(ctx, { input: interpret([]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.evidence.interpretations).toEqual([]);
    // The honest framing is surfaced; it explicitly denies a "safe" reading.
    expect(
      r.value.data.caveats.some((c) => c.includes('NO concept rule fired')),
    ).toBe(true);
    expect(
      r.value.data.caveats.some((c) => /not.*safe|change\/delete is safe/i.test(c)),
    ).toBe(true);
  });

  it('an EMPTY interpret result cannot certify an absence draft (grounded=false)', async () => {
    // The guardrail's teeth: honest silence must not become "safe to delete".
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpret([]),
      draft:
        'Nothing depends on CustomField:Account.Amount__c; it is safe to delete.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grounded).toBe(false);
    expect(r.value.data.ungroundedAbsenceClaims?.length).toBeGreaterThan(0);
  });

  // SYNTHESIZE-BURIES-INTERPRET-CLAIMS (Graph-B product honesty). The shipped
  // reasoning model fires correctly (concept:flow-run-mode →
  // SystemModeWithoutSharing), but the HOST answer path renders summary +
  // bullets. Before the fix, the generic scalar walk lifted only the bare
  // `confidence: declared` COUNTER from the interpret payload; the claim TEXT
  // survived only inside `evidence.*` and never reached the summary/bullets.
  // The fix PROMOTES the claim into the bullets, cited with concept/rule id +
  // confidence tier, without dropping any disclosure. A no-interpretations
  // control proves the non-reasoning path is unchanged.
  const flowRunMode = {
    ruleId: 'rule:flow-run-mode/system-without-sharing',
    concept: 'concept:flow-run-mode',
    claim:
      'Flow:Account_System_Automation declares `runInMode` `SystemModeWithoutSharing` ' +
      "— it runs in SYSTEM context and does NOT enforce the running user's " +
      'record-level sharing; it also does not enforce object CRUD or field-level ' +
      'security, so it can read and write any object and field.',
    groundedIn: ['Flow:Account_System_Automation'],
    confidence: 'declared',
    coverageCaveat: null,
    modelVersion: '1.0.0',
    provenance: 'offline_snapshot',
  };

  it('promotes a SystemModeWithoutSharing Flow claim into the host-facing bullets (SYNTHESIZE-BURIES-INTERPRET-CLAIMS)', async () => {
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpret([flowRunMode], {
        componentId: 'Flow:Account_System_Automation',
        componentType: 'Flow',
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // A bullet carries the CLAIM text (system context / sharing not enforced) —
    // NOT just a `confidence: declared` / `status: partial` counter alone.
    const claimBullet = d.bullets.find(
      (b) => /system context/i.test(b) && /sharing/i.test(b),
    );
    expect(claimBullet).toBeDefined();
    // ... cited with the concept id, the rule id, and the confidence tier.
    expect(claimBullet).toContain('concept:flow-run-mode');
    expect(claimBullet).toContain('rule:flow-run-mode/system-without-sharing');
    expect(claimBullet).toContain('confidence: declared');
    // The reasoning surface is more than the bare counter the scalar walk lifts.
    expect(d.bullets).not.toEqual(['confidence: declared']);
    // The summary acknowledges the promoted reasoning claim too.
    expect(d.summary).toContain('1 reasoning claim(s)');
    // Disclosures are PRESERVED, not dropped: the typed interpretation, its
    // confidence tier, and the grounded citation all remain intact.
    expect(d.evidence.interpretations).toHaveLength(1);
    expect(d.evidence.interpretations[0]?.confidence).toBe('declared');
    expect(d.citations.map((c) => c.id)).toContain('Flow:Account_System_Automation');
  });

  it('carries a heuristic Flow claim with its confidence tier AND coverage caveat inline', async () => {
    // Calibration: a hedged (heuristic + coverageCaveat) claim promotes with its
    // tier and its caveat attached, so the bullet never reads as a bare fact.
    const hedgedFlow = {
      ...flowRunMode,
      confidence: 'heuristic',
      coverageCaveat: 'Subflow run modes were not modeled in this snapshot.',
    };
    const r = await synthesizeAnswerHandler(ctx, {
      input: interpret([hedgedFlow], {
        componentId: 'Flow:Account_System_Automation',
        componentType: 'Flow',
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const claimBullet = r.value.data.bullets.find((b) => b.startsWith('REASONING ['));
    expect(claimBullet).toBeDefined();
    expect(claimBullet).toContain('confidence: heuristic');
    expect(claimBullet).toContain('coverage caveat: Subflow run modes were not modeled');
    // The coverageCaveat is ALSO still surfaced as a caveat (disclosure intact).
    expect(
      r.value.data.caveats.some((c) => c.includes('Subflow run modes were not modeled')),
    ).toBe(true);
  });

  it('leaves a NON-reasoning answer unchanged: no promoted bullet, no reasoning summary segment (control)', async () => {
    // A plain tool output with a `confidence` scalar but NO interpret payload
    // (no interpretations[] / rulesFired / rulesConsidered). The scalar walk
    // still lifts `confidence: parsed` as a bullet exactly as before; nothing is
    // promoted and the summary carries no reasoning segment — byte-identical.
    const nonReasoning = {
      data: {
        componentId: 'ApexClass:Fixture_Sharing_Probe',
        confidence: 'parsed',
        edges: [{ from: 'ApexClass:Fixture_Sharing_Probe', to: 'CustomObject:Account' }],
        trust: { provenance: 'offline_snapshot', completeness: { status: 'complete' } },
      },
    };
    const r = await synthesizeAnswerHandler(ctx, { input: nonReasoning });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // The `confidence` counter still renders as a plain bullet (unchanged) ...
    expect(d.bullets).toContain('confidence: parsed');
    // ... NO reasoning claim was promoted (no REASONING-tagged bullet) ...
    expect(d.bullets.some((b) => b.startsWith('REASONING ['))).toBe(false);
    // ... and the summary carries NO reasoning-claim segment.
    expect(d.summary).not.toContain('reasoning claim(s)');
    expect(d.evidence.interpretations).toEqual([]);
  });
});
