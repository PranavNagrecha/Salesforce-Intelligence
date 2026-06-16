/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { resolveComponents } from '../src/resolve.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

let tempDir: string;
let store: GraphStore;

const makeNode = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
  type: 'CustomObject',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const makeEdge = (
  o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>,
): Edge => ({
  edgeType: 'references',
  confidence: 'declared',
  source: 'test',
  properties: {},
  ...o,
});

// Synthetic vault reproducing every hard case the live-vault probe surfaced.
const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Payment__c', apiName: 'Payment__c', label: 'Payment' }),
    makeNode({ id: 'CustomField:Payment__c.Payment_Amount__c', type: 'CustomField', apiName: 'Payment_Amount__c', label: 'Payment Amount', parentId: 'CustomObject:Payment__c' }),
    makeNode({ id: 'CustomField:Payment__c.Payment_Status__c', type: 'CustomField', apiName: 'Payment_Status__c', label: 'Payment Status', parentId: 'CustomObject:Payment__c' }),
    // Namespaced object + a Layout decoy that whole-string scoring wrongly outranks.
    makeNode({ id: 'CustomObject:ACME_Transaction__c', apiName: 'ACME_Transaction__c', label: 'Transaction' }),
    makeNode({ id: 'Layout:ACME_Transaction__c-Transaction Layout', type: 'Layout', apiName: 'ACME_Transaction__c-Transaction Layout', label: 'Transaction Layout', parentId: 'CustomObject:ACME_Transaction__c' }),
    // The org's own misspelling baked into metadata.
    makeNode({ id: 'CustomObject:EventLog__e', apiName: 'EventLog__e', label: 'Event Log' }),
    makeNode({ id: 'CustomField:EventLog__e.EvenLog__c', type: 'CustomField', apiName: 'EvenLog__c', label: 'Even Log', parentId: 'CustomObject:EventLog__e' }),
    // Email on TWO objects -> ambiguity.
    makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
    makeNode({ id: 'CustomObject:Contact', apiName: 'Contact', label: 'Contact' }),
    makeNode({ id: 'CustomField:Account.Email__c', type: 'CustomField', apiName: 'Email__c', label: 'Email', parentId: 'CustomObject:Account' }),
    makeNode({ id: 'CustomField:Contact.Email__c', type: 'CustomField', apiName: 'Email__c', label: 'Email', parentId: 'CustomObject:Contact' }),
    // Regression decoy: a field whose only overlap with "paymnet" is the
    // short token "pay" (mirrors the real "Gross Income Per Pay Period" field
    // in a real org). A long typo must NOT confidently match a short
    // contained token.
    makeNode({ id: 'CustomField:Account.Pay_Period__c', type: 'CustomField', apiName: 'Pay_Period__c', label: 'Pay Period', parentId: 'CustomObject:Account' }),
    // Synonym target: "rep" should reach this via the rep↔owner group.
    makeNode({ id: 'CustomField:Account.Account_Owner__c', type: 'CustomField', apiName: 'Account_Owner__c', label: 'Account Owner', parentId: 'CustomObject:Account' }),
    // Fuzzy decoy: 'transaction'~'transcript'. Present so we can prove exact
    // token beats fuzzy near-miss.
    makeNode({ id: 'CustomObject:Expected_Transcript__c', apiName: 'Expected_Transcript__c', label: 'Expected Transcript' }),
    // Long multi-token name: a single query token ("opportunity") matches just
    // one of its six tokens. base can reach 1.0 on that token, but the match
    // barely identifies the component, so disposition must NOT be 'exact'.
    makeNode({ id: 'CustomObject:Sales_SPA_Opportunity_Stage_Task_Detail__mdt', apiName: 'Sales_SPA_Opportunity_Stage_Task_Detail__mdt', label: 'Sales SPA Opportunity Stage Task Detail' }),
    // Buried-exact scenario for the `none`-gate: a POPULAR object that only
    // weakly (suffix-contain) matches "extrawidget", plus an EXACT-match Layout
    // (base 1.0) with low type-weight and no inbound refs. Popularity floats the
    // weak match to the top SCORE with base < NONE_THRESHOLD; keying `none` off
    // that top-by-score row wrongly returned 'none' and hid the exact Layout.
    makeNode({ id: 'CustomObject:Widget', apiName: 'Widget', label: 'Widget' }),
    makeNode({ id: 'Layout:Extrawidget-Page', type: 'Layout', apiName: 'Extrawidget', label: 'Extrawidget', parentId: 'CustomObject:Widget' }),
    // Exact-name-buried-by-popular-siblings (stress-test regression): an
    // UNpopular target object whose exact API name shares a prefix with several
    // POPULAR siblings. Pure token-mean × popularity used to bury (or drop to
    // `none`) the exact match under the popular fuzzy siblings — mirrors the
    // real resolve("ZeeToDo__c") -> none and resolve("Zee_MS_Alert__c") misses.
    makeNode({ id: 'CustomObject:ZeeToDo__c', apiName: 'ZeeToDo__c', label: 'Zee To Do' }),
    makeNode({ id: 'CustomObject:Zee_MS_Ledger__c', apiName: 'Zee_MS_Ledger__c', label: 'Zee Ledger' }),
    makeNode({ id: 'CustomObject:Zee_MS_Notice__c', apiName: 'Zee_MS_Notice__c', label: 'Zee Notice' }),
    makeNode({ id: 'CustomObject:Zee_MS_Alert__c', apiName: 'Zee_MS_Alert__c', label: 'Zee Alert' }),
    // Stop-word-named component: "IT" tokenizes to nothing ("it" is a stop
    // word), so only the whole-name exact pass can recover it.
    makeNode({ id: 'Profile:IT', type: 'Profile', apiName: 'IT', label: 'IT' }),
  ],
  edges: [
    // parentOf structure
    makeEdge({ fromId: 'CustomObject:Payment__c', toId: 'CustomField:Payment__c.Payment_Amount__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'CustomObject:Payment__c', toId: 'CustomField:Payment__c.Payment_Status__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'CustomObject:EventLog__e', toId: 'CustomField:EventLog__e.EvenLog__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Email__c', edgeType: 'parentOf' }),
    makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomField:Contact.Email__c', edgeType: 'parentOf' }),
    // popularity: things reference the objects (inbound edges => popularity prior)
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomObject:Payment__c' }),
    makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomObject:Payment__c' }),
    makeEdge({ fromId: 'CustomObject:Payment__c', toId: 'CustomObject:ACME_Transaction__c' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomObject:ACME_Transaction__c' }),
    // popularity for the buried-exact scenario: Widget out-scores the exact Layout.
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomObject:Widget' }),
    makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomObject:Widget' }),
    // Make the Zee_MS_* siblings POPULAR (many inbound refs) while ZeeToDo__c
    // stays unreferenced — so only the exact-name boost can float it to the top.
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomObject:Zee_MS_Ledger__c' }),
    makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomObject:Zee_MS_Ledger__c' }),
    makeEdge({ fromId: 'CustomObject:Payment__c', toId: 'CustomObject:Zee_MS_Ledger__c' }),
    makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomObject:Zee_MS_Notice__c' }),
    makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomObject:Zee_MS_Alert__c' }),
  ],
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-resolve-'));
  const instance = await DuckDBInstance.create(join(tempDir, 'r.db'));
  const connection = await instance.connect();
  const init = await initSchema(connection);
  if (!init.ok) throw new Error(init.error.message);
  store = { connection, instance };
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(() => {
  store.connection.disconnectSync();
  store.instance.closeSync();
  rmSync(tempDir, { recursive: true, force: true });
});

const ids = (r: Awaited<ReturnType<typeof resolveComponents>>): string[] => {
  if (!r.ok) throw new Error(`resolve failed: ${r.error.message}`);
  return r.value.candidates.map((c) => c.id);
};

describe('resolveComponents — typo tolerance', () => {
  it('resolves a 1-char typo to the right object (paymnet -> Payment__c, rank 1)', async () => {
    const r = await resolveComponents(store, 'paymnet');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomObject:Payment__c');
    expect(r.value.candidates[0]?.matchKind).toBe('fuzzy');
    expect(r.value.disposition).toBe('exact');
  });

  it('finds the org-misspelled field (event log -> EvenLog__c in top 3)', async () => {
    const r = await resolveComponents(store, 'where is the event log');
    expect(ids(r).slice(0, 3)).toContain('CustomField:EventLog__e.EvenLog__c');
  });

  it('resolves emale -> Email field(s)', async () => {
    const r = await resolveComponents(store, 'emale');
    const top = ids(r);
    expect(top.some((id) => id.endsWith('.Email__c'))).toBe(true);
  });

  it('does NOT fake exact when the query is a longer compound of a real prefix (Paymenttrigger -> Payment, BL-05)', async () => {
    // `Payment` is a strict, much-shorter prefix of "paymenttrigger" — the query
    // carries extra content ("trigger") the candidate does not cover, so the
    // resolver must ASK (ambiguous) rather than fake an `exact`. The real
    // component stays a candidate so the user can still pick it.
    const r = await resolveComponents(store, 'Paymenttrigger');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).not.toBe('exact');
    expect(ids(r)).toContain('CustomObject:Payment__c');
  });

  it('ignores a noise/typo’d filler word and still resolves the real term (wher is the emale field)', async () => {
    // "wher" is a misspelling of the stop word "where" — it survives stop-word
    // filtering but matches nothing, and must NOT dilute the strong "emale"
    // match into a 'none'. This is the messy-real-user case.
    const r = await resolveComponents(store, 'wher is the emale field');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).not.toBe('none');
    expect(r.value.candidates[0]?.id.endsWith('.Email__c')).toBe(true);
  });
});

describe('resolveComponents — semantic (synonyms)', () => {
  it('resolves a business synonym to the canonical field (rep -> Owner)', async () => {
    const r = await resolveComponents(store, 'rep');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.candidates.map((c) => c.id);
    expect(ids.some((id) => id.endsWith('Owner__c'))).toBe(true);
  });
});

describe('resolveComponents — exact name (stress-test regression)', () => {
  it('returns the exact-named object as rank 1 even when popular siblings share its prefix', async () => {
    const r = await resolveComponents(store, 'ZeeToDo__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomObject:ZeeToDo__c');
    expect(r.value.candidates[0]?.matchKind).toBe('exact');
    expect(r.value.disposition).not.toBe('none');
  });

  it('finds an exact-named object that popular fuzzy siblings used to bury (Zee_MS_Alert__c)', async () => {
    const r = await resolveComponents(store, 'Zee_MS_Alert__c');
    expect(ids(r)[0]).toBe('CustomObject:Zee_MS_Alert__c');
  });

  it('ranks a multi-token typo to the FULLER match over a popular clean-token sibling (Zee_MS_Alret)', async () => {
    // "Zee_MS_Alret" typos the "Alert" token. Zee_MS_Ledger/Notice share the
    // popular "zee"+"ms" tokens but NOT "alert"; before coverage-weighting they
    // won on popularity at base 1.0. Coverage now rewards Zee_MS_Alert for
    // covering all three anchor tokens. (This is the dominant stress-test
    // typo-recall miss: a clean-token-only sibling burying the fuller match.)
    const r = await resolveComponents(store, 'Zee_MS_Alret');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomObject:Zee_MS_Alert__c');
  });

  it('recovers a stop-word-named component via the whole-name pass (IT profile)', async () => {
    // "it" is a stop word, so the query tokenizes to nothing; the whole-name
    // exact pass must still surface a component literally named "IT".
    const r = await resolveComponents(store, 'IT');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('Profile:IT');
    expect(r.value.disposition).not.toBe('none');
  });
});

describe('resolveComponents — parent-object disambiguation (B1/B2 regression)', () => {
  // Isolated vault: the field actually ON Contact, plus a decoy field on
  // Account whose NAME contains "Contact". Pure lexical scoring matches BOTH
  // query tokens of "Email on Contact" against the decoy's name and reported
  // it as the confident (exact) answer — the headline resolver bug.
  let pTempDir: string;
  let pStore: GraphStore;

  beforeAll(async () => {
    pTempDir = mkdtempSync(join(tmpdir(), 'sfi-resolve-parent-'));
    const instance = await DuckDBInstance.create(join(pTempDir, 'p.db'));
    const connection = await instance.connect();
    const init = await initSchema(connection);
    if (!init.ok) throw new Error(init.error.message);
    pStore = { connection, instance };
    // The decoy is made MORE popular than the real field (extra inbound refs),
    // reproducing the live-vault case where popularity floated the wrong field
    // to the top under a mere score bonus. The fix ranks the parent-matched
    // field first regardless of popularity.
    const parentSeed: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
        makeNode({ id: 'CustomObject:Contact', apiName: 'Contact', label: 'Contact' }),
        makeNode({ id: 'CustomField:Contact.Email', type: 'CustomField', apiName: 'Email', label: 'Email', parentId: 'CustomObject:Contact' }),
        makeNode({ id: 'CustomField:Account.Contact_Email__c', type: 'CustomField', apiName: 'Contact_Email__c', label: 'Contact Email', parentId: 'CustomObject:Account' }),
        // Referrers that make the Account decoy heavily-referenced (popular).
        makeNode({ id: 'Flow:Ref1', type: 'Flow', apiName: 'Ref1' }),
        makeNode({ id: 'Flow:Ref2', type: 'Flow', apiName: 'Ref2' }),
        makeNode({ id: 'Flow:Ref3', type: 'Flow', apiName: 'Ref3' }),
      ],
      edges: [
        makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomField:Contact.Email', edgeType: 'parentOf' }),
        makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Contact_Email__c', edgeType: 'parentOf' }),
        // Three references INTO the decoy → high popularity for the wrong field.
        makeEdge({ fromId: 'Flow:Ref1', toId: 'CustomField:Account.Contact_Email__c' }),
        makeEdge({ fromId: 'Flow:Ref2', toId: 'CustomField:Account.Contact_Email__c' }),
        makeEdge({ fromId: 'Flow:Ref3', toId: 'CustomField:Account.Contact_Email__c' }),
      ],
    };
    const imp = await importExtractionResults(pStore, [parentSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
  });

  afterAll(() => {
    pStore.connection.disconnectSync();
    pStore.instance.closeSync();
    rmSync(pTempDir, { recursive: true, force: true });
  });

  it('ranks the field ON Contact above the Account field merely named Contact_Email (B1)', async () => {
    const r = await resolveComponents(pStore, 'Email on Contact');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const candidateIds = r.value.candidates.map((c) => c.id);
    expect(candidateIds).toContain('CustomField:Contact.Email');
    // The real Contact.Email must rank at or above the decoy — never below.
    const contactRank = candidateIds.indexOf('CustomField:Contact.Email');
    const decoyRank = candidateIds.indexOf('CustomField:Account.Contact_Email__c');
    expect(contactRank).toBe(0);
    if (decoyRank !== -1) expect(contactRank).toBeLessThan(decoyRank);
  });

  it('never CONFIDENTLY resolves to the wrong Account decoy, and always surfaces Contact.Email (B2)', async () => {
    for (const q of ['Email on Contact', 'Contact Email', 'Contact.Email', 'emale on contact']) {
      const r = await resolveComponents(pStore, q);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const candidateIds = r.value.candidates.map((c) => c.id);
      // The field actually on Contact is always a candidate.
      expect(candidateIds).toContain('CustomField:Contact.Email');
      // The original bug was a CONFIDENT (`exact`) pick of the Account decoy.
      // The decoy may only appear among several `ambiguous` candidates — never
      // as the confident answer.
      if (candidateIds[0] === 'CustomField:Account.Contact_Email__c') {
        expect(r.value.disposition).toBe('ambiguous');
      }
      if (r.value.disposition === 'exact') {
        expect(r.value.candidates[0]?.id).toBe('CustomField:Contact.Email');
      }
    }
  });

  it('puts the field ON Contact first for an object-qualified query (Contact.Email / emale on contact)', async () => {
    for (const q of ['Contact.Email', 'emale on contact']) {
      const r = await resolveComponents(pStore, q);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.candidates[0]?.id).toBe('CustomField:Contact.Email');
    }
  });

  it('a bare object name still resolves to the OBJECT, not its fields (no parent-credit flood)', async () => {
    const r = await resolveComponents(pStore, 'Contact');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomObject:Contact');
  });
});

describe('resolveComponents — ranking', () => {
  it('ranks the namespaced object above its Layout decoy (transaction)', async () => {
    const r = await resolveComponents(store, 'transaction');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomObject:ACME_Transaction__c');
    expect(r.value.candidates[0]?.matchKind).toBe('exact');
    const obj = r.value.candidates.find((c) => c.id === 'CustomObject:ACME_Transaction__c');
    const layout = r.value.candidates.find((c) => c.type === 'Layout');
    if (obj && layout) expect(obj.score).toBeGreaterThan(layout.score);
  });

  it('keeps output deterministic across repeated calls', async () => {
    const a = ids(await resolveComponents(store, 'payment'));
    const b = ids(await resolveComponents(store, 'payment'));
    expect(a).toEqual(b);
  });
});

describe('resolveComponents — disposition', () => {
  it('flags ambiguity when a field name lives on multiple objects (email)', async () => {
    const r = await resolveComponents(store, 'email');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).toBe('ambiguous');
    const top2 = r.value.candidates.slice(0, 2).map((c) => c.id);
    expect(top2).toContain('CustomField:Account.Email__c');
    expect(top2).toContain('CustomField:Contact.Email__c');
  });

  it('returns disposition none for gibberish', async () => {
    const r = await resolveComponents(store, 'zzzqqq xkcd');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).toBe('none');
    expect(r.value.candidates).toHaveLength(0);
  });

  it('does not let low-signal words turn an impossible no-match into exact', async () => {
    const r = await resolveComponents(store, 'zzzz_no_such_component_94817');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).toBe('none');
    expect(r.value.candidates).toHaveLength(0);
  });

  it('does not confidently match a long typo to a short contained token (paymnet !≈ "pay")', async () => {
    // Scoped to Account, the only "pay"-ish field is Pay_Period. "paymnet"
    // shares only the 3-char token "pay" — far too weak to assert as exact.
    const r = await resolveComponents(store, 'paymnet', {
      parentId: 'CustomObject:Account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).not.toBe('exact');
  });

  it('does not report a one-token-of-many match as exact (opportunity -> long __mdt name)', async () => {
    // "opportunity" matches only 1 of the 6 tokens in
    // Sales_SPA_Opportunity_Stage_Task_Detail__mdt. base hits 1.0 on that exact
    // token and it is the sole contender, so pre-gate this resolved to 'exact'
    // — overstating confidence. The name-coverage gate demotes it to 'ambiguous'.
    const r = await resolveComponents(store, 'opportunity');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe(
      'CustomObject:Sales_SPA_Opportunity_Stage_Task_Detail__mdt',
    );
    expect(r.value.disposition).not.toBe('exact');
  });

  it('ranks an exact match above a more-popular fuzzy match (and is not none)', async () => {
    // CustomObject:Widget is popular (inbound refs) and only weakly
    // (suffix-contain) matches "extrawidget"; the exact-match
    // Layout:Extrawidget-Page (base 1.0) is unpopular with a low type-weight.
    // With LINEAR base, Widget's popularity floated it to the top and the
    // best-base gate is what kept the result off 'none'. With base-dominant
    // scoring the exact match now ranks #1 outright — covering BOTH the
    // ranking fix and the none-gate.
    const r = await resolveComponents(store, 'extrawidget');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('Layout:Extrawidget-Page');
    expect(r.value.disposition).not.toBe('none');
  });

  it('returns disposition none for an all-stop-word query', async () => {
    const r = await resolveComponents(store, 'where is the');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).toBe('none');
    expect(r.value.candidates).toHaveLength(0);
  });
});

describe('resolveComponents — scoping', () => {
  it('honors a type filter', async () => {
    const r = await resolveComponents(store, 'payment', { types: ['CustomObject'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates.length).toBeGreaterThan(0);
    expect(r.value.candidates.every((c) => c.type === 'CustomObject')).toBe(true);
  });

  it('honors a parent scope (email within Account only, not Contact)', async () => {
    const r = await resolveComponents(store, 'email', { parentId: 'CustomObject:Account' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomField:Account.Email__c');
    const out = r.value.candidates.map((c) => c.id);
    expect(out).not.toContain('CustomField:Contact.Email__c');
  });
});

// =============================================================================
// B1/B2 — a query that names an object as its OWN word ("Contact Email") must
// prefer the field ON that object over a decoy field whose NAME merely collides
// once normalizeName erases the space ("Contact_Email__c" on Account). The
// discriminator is the space: a single-token query of the literal field name
// ("Contact_Email__c") has no separate object word, so whole-name-exact wins.
// =============================================================================
describe('resolveComponents — parent-object word beats whole-name decoy (B1/B2)', () => {
  let localDir: string;
  let localStore: GraphStore;

  beforeAll(async () => {
    localDir = mkdtempSync(join(tmpdir(), 'sfi-resolve-b1b2-'));
    const instance = await DuckDBInstance.create(join(localDir, 'r.db'));
    const connection = await instance.connect();
    const init = await initSchema(connection);
    if (!init.ok) throw new Error(init.error.message);
    localStore = { connection, instance };
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({ id: 'CustomObject:Contact', apiName: 'Contact', label: 'Contact' }),
          makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
          // The field the user means: an email field ON Contact.
          makeNode({ id: 'CustomField:Contact.SIS_Email__c', type: 'CustomField', apiName: 'SIS_Email__c', label: 'SIS Email', parentId: 'CustomObject:Contact' }),
          // The decoy: a field on ANOTHER object whose NAME collides with the
          // spaced query "Contact Email" after normalizeName erases the space.
          makeNode({ id: 'CustomField:Account.Contact_Email__c', type: 'CustomField', apiName: 'Contact_Email__c', label: 'Contact Email', parentId: 'CustomObject:Account' }),
          // A real component named exactly "ContactTrigger" plus a Contact field
          // that merely CONTAINS "Trigger": "Contact Trigger" must return the
          // trigger (a whole-name-exact COMPONENT), proving the decoy rule does
          // not demote legit exact components, only cross-object field decoys.
          makeNode({ id: 'ApexTrigger:ContactTrigger', type: 'ApexTrigger', apiName: 'ContactTrigger', label: 'Contact Trigger', parentId: 'CustomObject:Contact' }),
          makeNode({ id: 'CustomField:Contact.Trigger_Flag__c', type: 'CustomField', apiName: 'Trigger_Flag__c', label: 'Trigger Flag', parentId: 'CustomObject:Contact' }),
        ],
        edges: [
          makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomField:Contact.SIS_Email__c', edgeType: 'parentOf' }),
          makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Contact_Email__c', edgeType: 'parentOf' }),
          makeEdge({ fromId: 'CustomObject:Contact', toId: 'ApexTrigger:ContactTrigger', edgeType: 'parentOf' }),
          makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomField:Contact.Trigger_Flag__c', edgeType: 'parentOf' }),
          // Make the decoy MORE popular than the real field, so ONLY the
          // cross-object-decoy rule (not popularity) can demote it.
          makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomField:Account.Contact_Email__c' }),
          makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Contact_Email__c' }),
        ],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
  });

  afterAll(() => {
    localStore.connection.disconnectSync();
    localStore.instance.closeSync();
    rmSync(localDir, { recursive: true, force: true });
  });

  it('"Contact Email" ranks the Email field ON Contact above the Account decoy', async () => {
    const r = await resolveComponents(localStore, 'Contact Email');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomField:Contact.SIS_Email__c');
    const contactRank = r.value.candidates.findIndex(
      (c) => c.id === 'CustomField:Contact.SIS_Email__c',
    );
    const decoyRank = r.value.candidates.findIndex(
      (c) => c.id === 'CustomField:Account.Contact_Email__c',
    );
    expect(contactRank).toBeLessThan(decoyRank);
    // Two plausible readings -> ambiguous, never a confident pick of the decoy.
    expect(r.value.disposition).toBe('ambiguous');
  });

  it('the exact field NAME "Contact_Email__c" still returns that field first (no regression)', async () => {
    const r = await resolveComponents(localStore, 'Contact_Email__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A single-token query of the literal field name has no separate object
    // word, so whole-name-exact still wins.
    expect(r.value.candidates[0]?.id).toBe('CustomField:Account.Contact_Email__c');
    expect(r.value.candidates[0]?.matchKind).toBe('exact');
  });

  it('"Email on Contact" also ranks the Contact field first', async () => {
    const r = await resolveComponents(localStore, 'Email on Contact');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('CustomField:Contact.SIS_Email__c');
  });

  it('"Contact Trigger" returns the ContactTrigger component, not a Contact field named *Trigger* (B26)', async () => {
    const r = await resolveComponents(localStore, 'Contact Trigger');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The cross-object-decoy rule must NOT demote a legit whole-name-exact
    // COMPONENT: "Contact Trigger" is the ContactTrigger trigger, not a field
    // that merely contains "Trigger".
    expect(r.value.candidates[0]?.id).toBe('ApexTrigger:ContactTrigger');
    expect(r.value.candidates[0]?.matchKind).toBe('exact');
  });

  it('explicit "flow" in the query ranks the Flow above its ConditionalContext child', async () => {
    const typeIntentSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'Flow:Career_Opportunity_Triggered',
          type: 'Flow',
          apiName: 'Career_Opportunity_Triggered',
          label: 'Career Opportunity Triggered',
        }),
        makeNode({
          id: 'ConditionalContext:Flow:Career_Opportunity_Triggered.condition-0',
          type: 'ConditionalContext',
          apiName: 'condition-0',
          label: 'condition-0',
          parentId: 'Flow:Career_Opportunity_Triggered',
        }),
        makeNode({
          id: 'CustomObject:Experiential_Education_History__c',
          apiName: 'Experiential_Education_History__c',
          label: 'Experiential Education History',
        }),
        makeNode({
          id: 'CustomField:Experiential_Education_History__c.Name__c',
          type: 'CustomField',
          apiName: 'Name__c',
          label: 'Name',
          parentId: 'CustomObject:Experiential_Education_History__c',
        }),
        makeNode({
          id: 'ValidationRule:Experiential_Education_History__c.Deny_Decline',
          type: 'ValidationRule',
          apiName: 'Experiential_Education_History__c.Deny_Decline',
          label: 'Deny Decline',
          parentId: 'CustomObject:Experiential_Education_History__c',
        }),
      ],
      edges: [],
    };
    const dir = mkdtempSync(join(tmpdir(), 'sfi-resolve-type-intent-'));
    const dbPath = join(dir, 'graph.db');
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    await initSchema(connection);
    const local = { connection, instance } satisfies GraphStore;
    await importExtractionResults(local, [typeIntentSeed]);

    const flowResult = await resolveComponents(local, 'Career Opportunity Triggered flow');
    expect(flowResult.ok).toBe(true);
    if (!flowResult.ok) return;
    expect(flowResult.value.candidates[0]?.id).toBe('Flow:Career_Opportunity_Triggered');

    const objectResult = await resolveComponents(local, 'Experiential Education History object');
    expect(objectResult.ok).toBe(true);
    if (!objectResult.ok) return;
    expect(objectResult.value.candidates[0]?.id).toBe('CustomObject:Experiential_Education_History__c');

    connection.disconnectSync();
    instance.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });
});
