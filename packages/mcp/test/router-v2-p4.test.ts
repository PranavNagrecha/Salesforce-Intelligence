/// <reference types="vitest/globals" />

/**
 * Router-v2 Phase 4 — targeted fixes, pinned:
 *
 * 1. CLARIFY-OPTION HYGIENE + BLOCKED-MISS CONVERSIONS
 *    - option hygiene: fuzzy/junk rivals (the SSN → {ASN,BSN,MSN} acronym
 *      graze) never appear as clarification options;
 *    - qualified-entity auto-resolve: an object/type qualifier already in the
 *      question resolves the ambiguity instead of blocking (tab-twin,
 *      parent-word, underscored api token, dotted reference);
 *    - genuine ambiguity (two real same-name components, no qualifier) STILL
 *      clarifies.
 * 2. NEEDS-LIVE REACHABILITY — runtime-data asks reach the live plane;
 *    vault questions are NOT hijacked to live (both directions pinned).
 * 3. REFUSAL-GATE extensions for the surviving genuine over-routes — each with
 *    a must-NOT-gate negative from the mislabeled-answerable family.
 * 4. q522 — a code-literal search ("System.debug") routes to
 *    search_apex_source, never the runtime-audit-trail fallback.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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

import { classifyQuestion } from '../src/intent-router.js';
import { detectRefusalShape } from '../src/refusal-gates.js';
import type { ToolCandidate } from '../src/semantic-funnel.js';
import type { Context } from '../src/server.js';
import {
  hygienicClarificationOptions,
  resolvePlaneTie,
  routeQuestionHandler,
} from '../src/tools/route-question.js';

// --- fixture vault (synthetic names only) -----------------------------------

const P4_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-01T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:router-v2-p4-fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'apiName' | 'type'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const P4_SEED: ExtractionResult = {
  nodes: [
    // Tab-twin pair: the CustomTab shares the object's exact api name.
    node({ id: 'CustomObject:Grant_Record__c', apiName: 'Grant_Record__c', type: 'CustomObject' }),
    node({ id: 'CustomTab:Grant_Record__c', apiName: 'Grant_Record__c', type: 'CustomTab' }),
    // Same-named field family across three parents (parent-qualifier shape).
    node({ id: 'CustomField:Case.Resolution_Code__c', apiName: 'Resolution_Code__c', type: 'CustomField', parentId: 'CustomObject:Case' }),
    node({ id: 'CustomField:Task.Resolution_Code__c', apiName: 'Resolution_Code__c', type: 'CustomField', parentId: 'CustomObject:Task' }),
    node({ id: 'CustomField:Event.Resolution_Code__c', apiName: 'Resolution_Code__c', type: 'CustomField', parentId: 'CustomObject:Event' }),
    node({ id: 'CustomObject:Case', apiName: 'Case', type: 'CustomObject' }),
    node({ id: 'CustomObject:Task', apiName: 'Task', type: 'CustomObject' }),
    node({ id: 'CustomObject:Event', apiName: 'Event', type: 'CustomObject' }),
    // Genuine same-name SSN pair + the acronym-graze junk rivals.
    node({ id: 'CustomField:Grant_Record__c.SSN__c', apiName: 'SSN__c', type: 'CustomField', parentId: 'CustomObject:Grant_Record__c' }),
    node({ id: 'CustomField:Lead.SSN__c', apiName: 'SSN__c', type: 'CustomField', parentId: 'CustomObject:Lead' }),
    node({ id: 'CustomObject:Lead', apiName: 'Lead', type: 'CustomObject' }),
    node({ id: 'CustomField:Application__c.ASN_Professional_Status__c', apiName: 'ASN_Professional_Status__c', type: 'CustomField', parentId: 'CustomObject:Application__c' }),
    node({ id: 'CustomField:Application__c.BSN_Professional_Status__c', apiName: 'BSN_Professional_Status__c', type: 'CustomField', parentId: 'CustomObject:Application__c' }),
    node({ id: 'CustomField:Application__c.MSN_Professional_Status__c', apiName: 'MSN_Professional_Status__c', type: 'CustomField', parentId: 'CustomObject:Application__c' }),
    node({ id: 'CustomObject:Application__c', apiName: 'Application__c', type: 'CustomObject' }),
    // Underscored flow name + a lookalike rival.
    node({ id: 'Flow:Clinical_Assignment_Screen_Flow', apiName: 'Clinical_Assignment_Screen_Flow', type: 'Flow' }),
    node({ id: 'Flow:Mid_Point_Review_Screen_Flow', apiName: 'Mid_Point_Review_Screen_Flow', type: 'Flow' }),
    // Dotted-reference target for the fallback-override shape.
    node({ id: 'CustomField:Grant_Record__c.Student_Token__c', apiName: 'Student_Token__c', type: 'CustomField', parentId: 'CustomObject:Grant_Record__c' }),
  ],
  edges: [],
};

describe('router-v2 P4 — clarify hygiene + qualified-entity auto-resolve (fixture vault)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-p4-'));
    const opened = await openGraph(join(dir, 'p4.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imported = await importExtractionResults(store, [P4_SEED]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx = { vaultRoot: dir, manifest: P4_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('CustomTab twin never blocks: "<X__c> object" resolves to the CustomObject', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'does the faculty profile have access to the Grant_Record__c object',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(false);
    const ee = r.value.data.entityEvidence;
    expect(ee?.disposition).toBe('exact');
    expect(ee?.candidates[0]?.componentId).toBe('CustomObject:Grant_Record__c');
  });

  it('parent word in the question auto-resolves a same-named field family (no block)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question:
        'is there a validation rule that stops me from saving a Case without a Resolution_Code__c?',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(false);
    const ee = r.value.data.entityEvidence;
    expect(ee?.disposition).toBe('exact');
    expect(ee?.candidates[0]?.componentId).toBe('CustomField:Case.Resolution_Code__c');
  });

  it('GENUINE ambiguity still clarifies: same-named field, no qualifier in the question', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'whats the Resolution_Code__c field for',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(true);
    const options = r.value.data.route.clarification?.options ?? [];
    expect(options).toContain('CustomField:Case.Resolution_Code__c');
    expect(options).toContain('CustomField:Task.Resolution_Code__c');
  });

  it('SSN clarification offers ONLY the genuine pair — no ASN/BSN/MSN acronym junk', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'which profiles can see the SSN field',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const clarification = r.value.data.route.clarification;
    expect(clarification?.required).toBe(true);
    const options = clarification?.options ?? [];
    expect(options).toContain('CustomField:Grant_Record__c.SSN__c');
    expect(options).toContain('CustomField:Lead.SSN__c');
    for (const option of options) {
      expect(option).not.toMatch(/Professional_Status/);
    }
  });

  it('an underscored api token is the entity — the whole-name flow resolves exact (no junk menu)', async () => {
    const r = await routeQuestionHandler(ctx, {
      question:
        "Explain Clinical_Assignment_Screen_Flow end to end — it's a screen flow, what's the user actually doing in it?",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(false);
    expect(r.value.data.entityEvidence?.disposition).toBe('exact');
    expect(r.value.data.entityEvidence?.candidates[0]?.componentId).toBe(
      'Flow:Clinical_Assignment_Screen_Flow',
    );
  });

  it('a dotted Object.Field reference overrides the short-phrase fallback clarification', async () => {
    const r = await routeQuestionHandler(ctx, {
      question: 'who populates Grant_Record__c.Student_Token__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.executionBlocked).toBe(false);
  });
});

// --- option hygiene, unit level ----------------------------------------------

describe('router-v2 P4 — hygienicClarificationOptions', () => {
  const candidate = (id: string, base: number, matchKind: string) => ({
    componentId: id,
    base,
    matchKind,
  });

  it('drops fuzzy acronym-graze rivals and far-below-top bases', () => {
    const kept = hygienicClarificationOptions([
      candidate('CustomField:A.SSN__c', 1, 'exact'),
      candidate('CustomField:B.SSN__c', 1, 'exact'),
      candidate('CustomField:X.ASN_Professional_Status__c', 0.96, 'fuzzy'),
      candidate('CustomField:X.MSN_Professional_Status__c', 0.96, 'fuzzy'),
      candidate('CustomField:Y.Other__c', 0.7, 'substring'),
    ]);
    expect(kept.map((c) => c.componentId)).toEqual([
      'CustomField:A.SSN__c',
      'CustomField:B.SSN__c',
    ]);
  });

  it('always offers the top option even when it alone survives', () => {
    const kept = hygienicClarificationOptions([
      candidate('Flow:Real_Flow', 0.95, 'fuzzy'),
      candidate('Flow:Other_Flow', 0.94, 'fuzzy'),
    ]);
    expect(kept[0]?.componentId).toBe('Flow:Real_Flow');
  });
});

// --- plane-tie resolution (needs-live vs vault, no blocking) ------------------

describe('router-v2 P4 — resolvePlaneTie', () => {
  const cand = (tool: string, score: number, plane: ToolCandidate['plane']): ToolCandidate => ({
    tool,
    score,
    cosine: score,
    category: null,
    plane,
    liveRequired: plane === 'live',
    confidence: 'medium',
  });

  it('a vault-flavored question keeps the vault candidate on top of a plane near-tie', () => {
    const out = resolvePlaneTie(
      [cand('sfi.live_owner_breakdown', 0.42, 'live'), cand('sfi.explain_flow', 0.4, 'vault')],
      'Give me a breakdown of the Case_Escalation_Flow.',
    );
    expect(out[0]?.tool).toBe('sfi.explain_flow');
  });

  it('a live-data question promotes the live candidate over a tied vault rival', () => {
    const out = resolvePlaneTie(
      [cand('sfi.list_components', 0.42, 'vault'), cand('sfi.live_count', 0.4, 'live')],
      'how many records do we have right now',
    );
    expect(out[0]?.tool).toBe('sfi.live_count');
  });

  it('no reorder outside the margin or on same-plane pairs', () => {
    const wide = resolvePlaneTie(
      [cand('sfi.live_count', 0.8, 'live'), cand('sfi.list_components', 0.4, 'vault')],
      'explain the schema',
    );
    expect(wide[0]?.tool).toBe('sfi.live_count');
    const samePlane = resolvePlaneTie(
      [cand('sfi.get_impact', 0.42, 'vault'), cand('sfi.explain_flow', 0.41, 'vault')],
      'anything',
    );
    expect(samePlane[0]?.tool).toBe('sfi.get_impact');
  });
});

// --- intent-pair conversions (blocked → clean) --------------------------------

describe('router-v2 P4 — complementary intent pairs stack instead of blocking', () => {
  it('"who can access the X object" runs both lenses, no clarification', () => {
    const route = classifyQuestion('who can access the Disability__c object');
    expect(route.clarification).toBeNull();
    expect(route.tools).toContain('sfi.who_can_access_object');
    expect(route.tools).toContain('sfi.object_access_audit');
  });

  it('"what happens if I change the type of X" stacks impact + simulation, no clarification', () => {
    const route = classifyQuestion(
      'what happens if I change the type of Opportunity.Amount from currency to text',
    );
    expect(route.clarification).toBeNull();
    expect(route.tools.length).toBeGreaterThan(1);
  });

  it('"who last modified <named flow>" auto-picks the metadata stamp', () => {
    const route = classifyQuestion('can u tell me who last modified the Application_Save_RT_Orch flow');
    expect(route.intent).toBe('last-modified');
    expect(route.clarification).toBeNull();
  });

  it('"who changed this?" (no component named) still clarifies runtime-vs-metadata', () => {
    const route = classifyQuestion('who changed this?');
    expect(route.intent).toBe('runtime-audit-trail');
    expect(route.clarification?.required).toBe(true);
  });
});

// --- needs-live reachability + vault precision guards -------------------------

describe('router-v2 P4 — needs-live questions reach the live plane', () => {
  const LIVE_CASES: ReadonlyArray<readonly [string, string]> = [
    ['count Course_Exam__c records', 'record-count'],
    ['count leads grouped by Program_of_Interest', 'group-count'],
    ['count of Contacts by MailingState', 'group-count'],
    ['whats the fill rate on Status__c on Application', 'field-population'],
    ['how many opportunities have a blank Amount', 'field-population'],
    ['Which users logged into the org in the last week?', 'inactive-users'],
    ['whos in the Intake Team Queue', 'group-count'],
    ['which picklist values on Case.Status are never used', 'picklist-usage'],
    ['Give me the distribution of Case.Status values across all Cases.', 'picklist-usage'],
    ['whats the most common Resolution_Code__c on closed Cases', 'picklist-usage'],
    ['the counselor swears the flow fired yesterday, did Create_Advising_Case actually run', 'automation-fired'],
    ['average number of Course Enrollments per student contact', 'field-aggregate'],
    ['Which objects have grown the fastest in record count since last quarter?', 'storage-by-object'],
    ['whats the most duplicated email domain in our Contacts', 'duplicate-check'],
    ['can you see if lead 00Q5x000004abcd converted and when', 'sample-records'],
    ['Give me a health snapshot of the org — data volume, limits, anything worrying.', 'org-health'],
    ['how many records per record type on Case', 'group-count'],
    ['How many students are enrolled this term?', 'record-count'],
  ];

  it.each(LIVE_CASES)('%s → %s (live/hybrid, liveRequired)', (q, intent) => {
    const route = classifyQuestion(q);
    expect(route.intent).toBe(intent);
    expect(['live', 'hybrid']).toContain(route.plane);
    expect(route.liveRequired).toBe(true);
  });

  const VAULT_NOT_HIJACKED: ReadonlyArray<readonly [string, string]> = [
    // Declared schema stays vault even near the new live patterns.
    ['what values are in the Status picklist', 'picklist-values'],
    ['how many validation rules are on Case', 'metadata-count'],
    ['how many custom objects do we have', 'metadata-count'],
    // Schema-redundancy "duplicated fields" is NOT a live duplicate scan.
    ['which fields on Contact are duplicated - same data stored twice', 'schema'],
    // Metadata "empty queues" inventory is NOT a live field-population read.
    ['how many queues are empty with no members', 'empty-queues-groups'],
  ];

  it.each(VAULT_NOT_HIJACKED)('%s stays %s on the vault plane', (q, intent) => {
    const route = classifyQuestion(q);
    expect(route.intent).toBe(intent);
    expect(route.plane).toBe('vault');
    expect(route.liveRequired).toBe(false);
  });
});

// --- refusal-gate extensions (positives + must-NOT negatives) -----------------

describe('router-v2 P4 — refusal-gate extensions', () => {
  const WRITES: readonly string[] = [
    'can you make the hed__SSN__c field required for me',
    'i need you to bulk update every Contact where Status__c is blank and set it to New',
    'upgrade the HEDA package to the latest version',
    'Can you go ahead and give the Admissions profile Modify All Data? The counselors keep complaining.',
    "give everyone admin access, we're behind on tickets",
    'can you write me the SOQL to find duplicate Contacts by SSN and then just run it and delete the dupes',
    'our async apex is getting flooded, whats causing it and can you throttle it',
  ];
  it.each(WRITES.map((q) => [q] as const))('%s → refused-write', (q) => {
    expect(detectRefusalShape(q)?.kind).toBe('write-imperative');
  });

  it('single-record sensitive-value ask is exfiltration', () => {
    expect(detectRefusalShape('whats the SSN of the most recent lead we got')?.kind).toBe(
      'injection-exfiltration',
    );
  });

  const OUT_OF_SCOPE: readonly string[] = [
    'Whats our data retention policy for old application records?',
    'Whats the retention policy on our SSN fields?',
    'how do students consent to us storing their SSN',
  ];
  it.each(OUT_OF_SCOPE.map((q) => [q] as const))('%s → out-of-scope', (q) => {
    expect(detectRefusalShape(q)?.kind).toBe('out-of-scope');
  });

  // Must-NOT-gate: answerable reads shaped like the 64-mislabeled set.
  const MUST_NOT_GATE: readonly string[] = [
    'can I edit the SSN field',
    'am I allowed to make the Email field required',
    'which profiles can edit and delete Cases',
    'can you give me a breakdown of the Accommodation_Flow permission grants',
    'give me the list of fields on Contact',
    'whats the SSN field on Grant_Record__c for',
    'which fields contain SSN data',
    'whats our password policy on the Admissions profile',
    'what would happen if we upgrade the HEDA package',
    'is it safe to delete the Resolution_Code__c field',
    'who can update Opportunity Amount',
    'how do I check which flows are inactive',
  ];
  it.each(MUST_NOT_GATE.map((q) => [q] as const))('%s routes normally (no refusal)', (q) => {
    expect(detectRefusalShape(q)).toBeNull();
  });
});

// --- q522: code-literal search -------------------------------------------------

describe('router-v2 P4 — q522 code-literal search', () => {
  it('"does anything call System.debug…" routes to search_apex_source with the literal bound', () => {
    const route = classifyQuestion(
      'does anything call System.debug all over the place, like leftover debug logs in apex',
    );
    expect(route.intent).toBe('apex-search');
    expect(route.tools).toContain('sfi.search_apex_source');
    expect(route.suggestedArgs?.['query']).toBe('system.debug');
  });

  it('a real runtime debug-logs ask still lands on the audit-trail disclosure', () => {
    const route = classifyQuestion('can you pull the debug logs from yesterday');
    expect(route.intent).toBe('runtime-audit-trail');
  });

  it('"which apex class handles the Boomi integration for bulk loads" is a source grep', () => {
    const route = classifyQuestion(
      'Which apex class handles the Boomi integration for bulk Contact loads?',
    );
    expect(route.intent).toBe('apex-search');
  });
});
