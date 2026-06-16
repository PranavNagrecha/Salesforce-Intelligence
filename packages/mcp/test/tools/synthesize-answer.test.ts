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
