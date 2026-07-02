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
    // QA batch 5 regression: a same-object sibling whose NAME shares the `state`
    // token (fuzzy-near the query `status` token, below the contender-score band)
    // but NOT the `payment` token. The query "Payment_Status__c" names its own
    // PARENT object (Payment__c) via the `payment` token, so this sibling earns
    // PARENT-credit for `payment` and is flagged parent-matched. Pre-fix that made
    // it an always-contender, demoting the literal whole-name-exact hit on
    // Payment_Status__c to `ambiguous`; it is NOT a score-contender, so the bug is
    // purely the parent-credit-inflation path.
    makeNode({ id: 'CustomField:Payment__c.Settlement_State__c', type: 'CustomField', apiName: 'Settlement_State__c', label: 'Settlement State', parentId: 'CustomObject:Payment__c' }),
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
    // Phrase-synonym scenario (F1): a regulated SSN field plus a decoy Name
    // field on the same object. The phrase "social security number" must
    // collapse to the `ssn` token so Student_SSN__c wins over Student_Name__c
    // (whose "name"≈"number" fuzz used to float it above the SSN field).
    makeNode({ id: 'CustomObject:Student__c', apiName: 'Student__c', label: 'Student' }),
    makeNode({ id: 'CustomField:Student__c.Student_SSN__c', type: 'CustomField', apiName: 'Student_SSN__c', label: 'Student SSN', parentId: 'CustomObject:Student__c' }),
    makeNode({ id: 'CustomField:Student__c.Student_Name__c', type: 'CustomField', apiName: 'Student_Name__c', label: 'Student Name', parentId: 'CustomObject:Student__c' }),
    // Acronym near-miss decoys (resolver Bug 2): fields whose api-name token is a
    // same-length near-miss of "ssn" (asn/bsn/msn). A short 3-char query token
    // must NOT let these substring/fuzzy-graze their way over the field genuinely
    // named for SSN — Student_SSN__c (an exact token hit) owns the answer. Guards
    // the isPureShortSubstringOfCompound containment-suppression path.
    makeNode({ id: 'CustomField:Student__c.ASN__c', type: 'CustomField', apiName: 'ASN__c', label: 'ASN', parentId: 'CustomObject:Student__c' }),
    makeNode({ id: 'CustomField:Student__c.BSN__c', type: 'CustomField', apiName: 'BSN__c', label: 'BSN', parentId: 'CustomObject:Student__c' }),
    makeNode({ id: 'CustomField:Student__c.MSN_Compound_Status__c', type: 'CustomField', apiName: 'MSN_Compound_Status__c', label: 'MSN Compound Status', parentId: 'CustomObject:Student__c' }),
    // Type-hint scenarios (eval Family A): a ValidationRule with an exact `ssn`
    // token — a "<name> field" query's CustomField hint must PREFER fields among
    // equal-confidence matches but never resurrect the fuzzy acronym decoys
    // (ssn≈asn/bsn/msn, base ≈0.78) above this exact-token match of another
    // type. Plus a trigger on Contact so "Contact trigger" resolves to the
    // trigger rather than a fuzzy menu.
    makeNode({ id: 'ValidationRule:Student__c.SSN_Format_Check', type: 'ValidationRule', apiName: 'SSN_Format_Check', label: 'SSN Format Check', parentId: 'CustomObject:Student__c' }),
    makeNode({ id: 'ApexTrigger:ContactTrigger', type: 'ApexTrigger', apiName: 'ContactTrigger', label: 'ContactTrigger', parentId: 'CustomObject:Contact' }),
    // Generic-type-word decoy (resolver Bug 1): a Profile literally api-named
    // "Profile". A bare single-token conceptual query ("Profile") must NOT resolve
    // to this component (which would trigger an unwanted disambiguation); the
    // generic-type-word suppression drops it. A differently-named Profile
    // ("SalesRep") still resolves normally, proving the suppression is narrow.
    makeNode({ id: 'Profile:Profile', type: 'Profile', apiName: 'Profile', label: 'Profile' }),
    makeNode({ id: 'Profile:SalesRep', type: 'Profile', apiName: 'SalesRep', label: 'Sales Rep' }),
    // Corpus over-collapse decoy (F1 negative): a field literally labeled
    // "Social Media Campaign". The phrase pass must NOT collapse this corpus
    // label to `ssn`, or "social media campaign" queries would wrongly hit the
    // SSN field.
    makeNode({ id: 'CustomObject:Campaign', apiName: 'Campaign', label: 'Campaign' }),
    makeNode({ id: 'CustomField:Campaign.Social_Media_Campaign__c', type: 'CustomField', apiName: 'Social_Media_Campaign__c', label: 'Social Media Campaign', parentId: 'CustomObject:Campaign' }),
    // QA-Bundle-2 (resolve): an object with MULTIPLE same-object `*Status__c`
    // siblings whose names share the parent-object token. Querying the LITERAL
    // field api name "Deal_Status__c" makes every sibling reach base 1.0 — its own
    // `status` suffix token matches, and the query's `deal` token earns
    // PARENT-credit for the shared parent object — so the siblings tie the
    // literal-name hit on SCORE and inflated the contender count to `ambiguous`,
    // blocking the resolve-first cascade. A sole whole-name-exact (or dotted
    // Object.Field) hit must stay `exact`. (Neutral name `Deal__c` so it does not
    // collide with the `opportunity` token of the long __mdt above.)
    makeNode({ id: 'CustomObject:Deal__c', apiName: 'Deal__c', label: 'Deal' }),
    makeNode({ id: 'CustomField:Deal__c.Deal_Status__c', type: 'CustomField', apiName: 'Deal_Status__c', label: 'Deal Status', parentId: 'CustomObject:Deal__c' }),
    makeNode({ id: 'CustomField:Deal__c.Forecast_Status__c', type: 'CustomField', apiName: 'Forecast_Status__c', label: 'Forecast Status', parentId: 'CustomObject:Deal__c' }),
    makeNode({ id: 'CustomField:Deal__c.Approval_Status__c', type: 'CustomField', apiName: 'Approval_Status__c', label: 'Approval Status', parentId: 'CustomObject:Deal__c' }),
    makeNode({ id: 'CustomField:Deal__c.Review_Status__c', type: 'CustomField', apiName: 'Review_Status__c', label: 'Review Status', parentId: 'CustomObject:Deal__c' }),
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

describe('resolveComponents — phrase synonyms (F1)', () => {
  it('collapses "social security number" to the SSN field, not the Name decoy', async () => {
    const r = await resolveComponents(
      store,
      'the student social security number field',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Student_SSN__c must be the top candidate (exact/ambiguous-top), not buried
    // under Student_Name__c (number≈name fuzz). Disposition must NOT be 'none'.
    expect(r.value.candidates[0]?.id).toBe('CustomField:Student__c.Student_SSN__c');
    expect(r.value.disposition).not.toBe('none');
  });

  it('does NOT collapse a "social media" query onto the SSN field (negative)', async () => {
    const r = await resolveComponents(store, 'social media campaign field');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const top = r.value.candidates[0]?.id ?? '';
    expect(top).not.toBe('CustomField:Student__c.Student_SSN__c');
    // The intended corpus field should surface instead.
    const allIds = r.value.candidates.map((c) => c.id);
    expect(allIds).toContain('CustomField:Campaign.Social_Media_Campaign__c');
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

  it('reports a sole whole-name-exact field as exact even when a same-object sibling is parent-matched (Payment_Status__c)', async () => {
    // QA batch 5: querying the LITERAL field API name "Payment_Status__c" is a
    // definitive hit on CustomField:Payment__c.Payment_Status__c. But the name's
    // own `payment` token incidentally names its PARENT object (Payment__c), which
    // flags the genuine same-object sibling Payment_Amount__c as `parentMatched`.
    // The parent-credit contender rule then inflated the contender count and
    // demoted this literal-name match to `ambiguous` (the resolve-returns-
    // ambiguous-on-exact-field bug). A sole whole-name-exact top must stay `exact`.
    const r = await resolveComponents(store, 'Payment_Status__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe(
      'CustomField:Payment__c.Payment_Status__c',
    );
    expect(r.value.candidates[0]?.matchKind).toBe('exact');
    expect(r.value.disposition).toBe('exact');
  });

  it('resolves a literal field api name exact despite multiple score-tied same-object siblings (Deal_Status__c)', async () => {
    // QA-Bundle-2: Opportunity has four `*Status__c` fields. The query is the
    // LITERAL api name of one of them. Each sibling reaches base 1.0 (own `status`
    // token + parent-credit on `opportunity`) and the SAME score, so they tied the
    // literal-name hit on the contender-score band and demoted it to `ambiguous`,
    // blocking the resolve-first cascade. A sole whole-name-exact top owns the
    // answer — only ANOTHER whole-name-exact match could make it ambiguous.
    const r = await resolveComponents(store, 'Deal_Status__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe(
      'CustomField:Deal__c.Deal_Status__c',
    );
    expect(r.value.candidates[0]?.matchKind).toBe('exact');
    expect(r.value.disposition).toBe('exact');
  });

  it('resolves the dotted Object.Field form exact over same-object siblings (Deal__c.Deal_Status__c)', async () => {
    // The dotted Object.Field form names BOTH the parent object and the field's
    // literal name — the most specific reference. It used to fall to the
    // parent-aware token path (a dotted query never whole-name-matches a dotless
    // field name) and be reported `ambiguous` against the `*Status__c` siblings.
    // A candidate whose parent AND own name both equal the dotted parts is a
    // definitive `exact` hit.
    const r = await resolveComponents(store, 'Deal__c.Deal_Status__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe(
      'CustomField:Deal__c.Deal_Status__c',
    );
    expect(r.value.disposition).toBe('exact');
  });

  it('resolves a full canonical id exact (CustomField:Deal__c.Deal_Status__c)', async () => {
    // A caller may pass the canonical id verbatim. The leading `Type:` segment is
    // stripped and the dotted Object.Field tail resolves exact, not ambiguous.
    const r = await resolveComponents(
      store,
      'CustomField:Deal__c.Deal_Status__c',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe(
      'CustomField:Deal__c.Deal_Status__c',
    );
    expect(r.value.disposition).toBe('exact');
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

describe('resolveComponents — short-acronym false positives (Bug 2)', () => {
  it('resolves an SSN query to the SSN field, never the same-length acronym decoys (ASN/BSN/MSN)', async () => {
    // "ssn" is a 3-char token that Jaro-Winkler grazes against asn/bsn/msn
    // (all ≈0.78, same length) and could substring-graze a longer compound
    // token. The field genuinely named for SSN (an exact token hit, base 1.0)
    // must own the answer; the acronym near-misses stay below it.
    for (const q of ['SSN', 'the student social security number field']) {
      const r = await resolveComponents(store, q);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.candidates[0]?.id).toBe(
        'CustomField:Student__c.Student_SSN__c',
      );
      // The acronym decoys never outrank the real SSN field.
      const ssnRank = r.value.candidates.findIndex(
        (c) => c.id === 'CustomField:Student__c.Student_SSN__c',
      );
      for (const decoy of [
        'CustomField:Student__c.ASN__c',
        'CustomField:Student__c.BSN__c',
        'CustomField:Student__c.MSN_Compound_Status__c',
      ]) {
        const decoyRank = r.value.candidates.findIndex((c) => c.id === decoy);
        if (decoyRank !== -1) expect(ssnRank).toBeLessThan(decoyRank);
      }
    }
  });

  it('does not confidently pick a same-length acronym decoy for a bare SSN token', async () => {
    // The exact-token hit on Student_SSN__c is definitive; the fuzzy acronym
    // decoys (base ≈0.78) must never be the confident (`exact`) answer.
    const r = await resolveComponents(store, 'ssn');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.value.disposition === 'exact') {
      expect(r.value.candidates[0]?.id).toBe(
        'CustomField:Student__c.Student_SSN__c',
      );
    }
  });
});

describe('resolveComponents — leading/trailing schema nouns are type hints (Family A)', () => {
  it('"SSN field" scores exactly like bare "SSN": the noun is stripped from matching', async () => {
    // The trailing noun is a TYPE hint, not name content. Fed to the matcher it
    // used to resurrect the acronym false-positives Bug 2 suppressed (the
    // CustomField hint floated the fuzzy asn/bsn/msn fields over exact-token
    // matches of other types). Both forms must reduce to the same tokens and
    // put the genuine SSN field first with every decoy below it.
    for (const q of ['SSN', 'SSN field', 'ssn field']) {
      const r = await resolveComponents(store, q);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.queryTokens).toEqual(['ssn']);
      expect(r.value.candidates[0]?.id).toBe('CustomField:Student__c.Student_SSN__c');
      const rank = (id: string): number =>
        r.value.candidates.findIndex((c) => c.id === id);
      for (const decoy of [
        'CustomField:Student__c.ASN__c',
        'CustomField:Student__c.BSN__c',
        'CustomField:Student__c.MSN_Compound_Status__c',
      ]) {
        const decoyRank = rank(decoy);
        if (decoyRank !== -1) expect(rank('CustomField:Student__c.Student_SSN__c')).toBeLessThan(decoyRank);
      }
    }
  });

  it('the type hint never floats a weak fuzzy match of the hinted type over an exact-token match of another type', async () => {
    // "SSN field" hints CustomField — but the fuzzy acronym decoys (base ≈0.78)
    // must still rank BELOW the ValidationRule whose name carries an exact
    // `ssn` token (base 1.0). Type intent breaks ties within a confidence
    // tier; it never outranks confidence.
    const r = await resolveComponents(store, 'SSN field');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rank = (id: string): number => r.value.candidates.findIndex((c) => c.id === id);
    const vrRank = rank('ValidationRule:Student__c.SSN_Format_Check');
    expect(vrRank).not.toBe(-1);
    for (const decoy of [
      'CustomField:Student__c.ASN__c',
      'CustomField:Student__c.BSN__c',
      'CustomField:Student__c.MSN_Compound_Status__c',
    ]) {
      const decoyRank = rank(decoy);
      if (decoyRank !== -1) expect(vrRank).toBeLessThan(decoyRank);
    }
  });

  it('"<acronym> field" variants resolve their own field (hint helps, never hurts)', async () => {
    for (const [q, id] of [
      ['ASN field', 'CustomField:Student__c.ASN__c'],
      ['BSN field', 'CustomField:Student__c.BSN__c'],
    ] as const) {
      const r = await resolveComponents(store, q);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.candidates[0]?.id).toBe(id);
    }
  });

  it('"the payment object" resolves the Payment object instead of fuzzy "object" junk', async () => {
    // Pre-fix the token "object" fuzzy-matched unrelated names and dragged the
    // whole query to `none`/noise. Stripped as a hint, the query is just
    // "payment" with a CustomObject preference.
    const r = await resolveComponents(store, 'the payment object');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.queryTokens).toEqual(['payment']);
    expect(r.value.candidates[0]?.id).toBe('CustomObject:Payment__c');
    expect(r.value.disposition).toBe('exact');
  });

  it('"Contact trigger" resolves the trigger on Contact', async () => {
    const r = await resolveComponents(store, 'Contact trigger');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('ApexTrigger:ContactTrigger');
    expect(r.value.disposition).toBe('exact');
  });

  it('a query that is ONLY nouns/articles is left untouched ("permission set")', async () => {
    // Stripping everything would turn a concept word into an empty query;
    // noun-only queries keep their existing behavior instead.
    const r = await resolveComponents(store, 'permission set');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.queryTokens).toEqual(['permission', 'set']);
  });

  it('interior nouns are never stripped (a field genuinely named with the noun stays findable)', async () => {
    // Only the leading/trailing edge is hint territory — "pay period field"
    // loses the trailing noun but keeps its real name tokens.
    const r = await resolveComponents(store, 'pay period field');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.queryTokens).toEqual(['pay', 'period']);
    expect(r.value.candidates[0]?.id).toBe('CustomField:Account.Pay_Period__c');
  });
});

describe('resolveComponents — generic type-word suppression (Bug 1)', () => {
  it('a bare "Profile" query does NOT resolve to a component literally named "Profile"', async () => {
    // A lone type-word query is conceptual ("what's a Profile?"), not a request
    // for a component named "Profile". Suppression drops that decoy so the query
    // does not confidently disambiguate onto it.
    const r = await resolveComponents(store, 'Profile');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.candidates.map((c) => c.id);
    expect(ids).not.toContain('Profile:Profile');
    // With the type-name decoy suppressed, the bare word does not resolve to a
    // confident component — the caller should route it as a concept, not pick.
    if (r.value.disposition === 'exact') {
      expect(r.value.candidates[0]?.id).not.toBe('Profile:Profile');
    }
  });

  it('a differently-named Profile still resolves normally (suppression is narrow)', async () => {
    // Only a component whose api-name IS the type word is suppressed. A Profile
    // named "SalesRep" resolves as usual — the fix does not blanket-hide Profiles.
    const r = await resolveComponents(store, 'SalesRep');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('Profile:SalesRep');
    expect(r.value.disposition).toBe('exact');
  });

  it('a multi-word query containing the type word is NOT suppressed (Sales Rep profile)', async () => {
    // The suppression only fires for a LONE type-word token. A multi-token query
    // that merely mentions the type word must resolve normally.
    const r = await resolveComponents(store, 'Sales Rep');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.candidates.map((c) => c.id);
    expect(ids).toContain('Profile:SalesRep');
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

// =============================================================================
// Bug 3 — exact api-name match must win over a superset/substring rival
// =============================================================================
// Real-org eval case: query "Calculate_Contact_Budget_Group" returns
// disposition=ambiguous because both the exact flow AND a longer flow that
// merely CONTAINS the query string score highly. An exact api-name match must
// always win; only a genuine same-name collision (two components with the
// identical normalized api-name) stays ambiguous.
// =============================================================================
describe('resolveComponents — exact api-name wins over superset-containing rival (Bug 3)', () => {
  let bug3Dir: string;
  let bug3Store: GraphStore;

  beforeAll(async () => {
    bug3Dir = mkdtempSync(join(tmpdir(), 'sfi-resolve-bug3-'));
    const instance = await DuckDBInstance.create(join(bug3Dir, 'b3.db'));
    const connection = await instance.connect();
    const init = await initSchema(connection);
    if (!init.ok) throw new Error(init.error.message);
    bug3Store = { connection, instance };
    const bug3Seed: ExtractionResult = {
      nodes: [
        // The EXACT match: api-name equals the query verbatim.
        makeNode({
          id: 'Flow:Alpha_Beta_Flow',
          type: 'Flow',
          apiName: 'Alpha_Beta_Flow',
          label: 'Alpha Beta Flow',
        }),
        // The SUPERSET rival: contains the query string but is longer.
        // Made MORE popular (3 inbound refs) to stress-test that popularity
        // cannot let a superset override an exact api-name match.
        makeNode({
          id: 'Flow:RT_X_Alpha_Beta_Flow_Calculation',
          type: 'Flow',
          apiName: 'RT_X_Alpha_Beta_Flow_Calculation',
          label: 'RT X Alpha Beta Flow Calculation',
        }),
        // Dummy referrers that make the superset more popular.
        makeNode({ id: 'ApexClass:Ref1', type: 'ApexClass', apiName: 'Ref1' }),
        makeNode({ id: 'ApexClass:Ref2', type: 'ApexClass', apiName: 'Ref2' }),
        makeNode({ id: 'ApexClass:Ref3', type: 'ApexClass', apiName: 'Ref3' }),
        // Two same-named fields on different objects — genuine collision.
        makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
        makeNode({ id: 'CustomObject:Contact', apiName: 'Contact', label: 'Contact' }),
        makeNode({
          id: 'CustomField:Account.Foo__c',
          type: 'CustomField',
          apiName: 'Foo__c',
          label: 'Foo',
          parentId: 'CustomObject:Account',
        }),
        makeNode({
          id: 'CustomField:Contact.Foo__c',
          type: 'CustomField',
          apiName: 'Foo__c',
          label: 'Foo',
          parentId: 'CustomObject:Contact',
        }),
      ],
      edges: [
        makeEdge({ fromId: 'CustomObject:Account', toId: 'CustomField:Account.Foo__c', edgeType: 'parentOf' }),
        makeEdge({ fromId: 'CustomObject:Contact', toId: 'CustomField:Contact.Foo__c', edgeType: 'parentOf' }),
        // Make the superset rival popular.
        makeEdge({ fromId: 'ApexClass:Ref1', toId: 'Flow:RT_X_Alpha_Beta_Flow_Calculation' }),
        makeEdge({ fromId: 'ApexClass:Ref2', toId: 'Flow:RT_X_Alpha_Beta_Flow_Calculation' }),
        makeEdge({ fromId: 'ApexClass:Ref3', toId: 'Flow:RT_X_Alpha_Beta_Flow_Calculation' }),
      ],
    };
    const imp = await importExtractionResults(bug3Store, [bug3Seed]);
    if (!imp.ok) throw new Error(imp.error.message);
  });

  afterAll(() => {
    bug3Store.connection.disconnectSync();
    bug3Store.instance.closeSync();
    rmSync(bug3Dir, { recursive: true, force: true });
  });

  it('(a) unique exact api-name match wins over a more-popular superset rival — bare query', async () => {
    // query "Alpha_Beta_Flow" matches Flow:Alpha_Beta_Flow EXACTLY (api-name
    // equals query) but also Flow:RT_X_Alpha_Beta_Flow_Calculation (contains
    // every token). The superset is more popular (3 inbound refs). The resolver
    // must return disposition=exact with the exact-named flow ranked first.
    const r = await resolveComponents(bug3Store, 'Alpha_Beta_Flow');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('Flow:Alpha_Beta_Flow');
    expect(r.value.disposition).toBe('exact');
    // Superset may appear in candidates, but never as rank-1.
    const supersetRank = r.value.candidates.findIndex(
      (c) => c.id === 'Flow:RT_X_Alpha_Beta_Flow_Calculation',
    );
    if (supersetRank !== -1) expect(supersetRank).toBeGreaterThan(0);
  });

  it("(a') exact api-name + trailing type hint still resolves exact (Bug 3 core case)", async () => {
    // The highest-value real-org eval case: a user appends a type hint
    // ("Alpha_Beta_Flow flow"). The type-hint stripping removes "flow" from the
    // token stream, but normQuery was computed from the raw query and encodes
    // the hint ("alphabetaflowflow"), so the old wholeExact gate couldn't fire.
    // The fix computes normStrippedQuery from the hint-stripped form and uses it
    // as an additional wholeExact key, so the exact api-name node still wins.
    const r = await resolveComponents(bug3Store, 'Alpha_Beta_Flow flow');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates[0]?.id).toBe('Flow:Alpha_Beta_Flow');
    expect(r.value.disposition).toBe('exact');
  });

  it('(b) genuine same-name collision (two fields named Foo__c on different objects) stays ambiguous', async () => {
    // Both CustomField:Account.Foo__c and CustomField:Contact.Foo__c have the
    // same api-name. Neither is a unique exact match — this is a real collision
    // and must remain ambiguous so the user can disambiguate.
    const r = await resolveComponents(bug3Store, 'Foo__c');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.disposition).toBe('ambiguous');
    const topTwo = r.value.candidates.slice(0, 2).map((c) => c.id);
    expect(topTwo).toContain('CustomField:Account.Foo__c');
    expect(topTwo).toContain('CustomField:Contact.Foo__c');
  });
});

// --- router-v2 P4: nameCoverage exposure --------------------------------------
describe('nameCoverage (router-v2 P4 option hygiene input)', () => {
  let dir: string;
  let covStore: GraphStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-resolve-cov-'));
    const instance = await DuckDBInstance.create(join(dir, 'cov.db'));
    const connection = await instance.connect();
    const init = await initSchema(connection);
    if (!init.ok) throw new Error(init.error.message);
    covStore = { connection, instance };
    await importExtractionResults(covStore, [{
      nodes: [
        makeNode({ id: 'ApexClass:ApplicationPortalTestData', apiName: 'ApplicationPortalTestData', type: 'ApexClass' }),
        makeNode({ id: 'CustomField:Case.Resolution_Code__c', apiName: 'Resolution_Code__c', type: 'CustomField', parentId: 'CustomObject:Case' }),
        makeNode({ id: 'CustomObject:Case', apiName: 'Case' }),
      ],
      edges: [],
    }]);
  });

  afterAll(async () => {
    covStore.connection.closeSync();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a generic-token graze reports LOW own-name coverage; a full-name hit reports 1', async () => {
    const graze = await resolveComponents(covStore, 'test class');
    expect(graze.ok).toBe(true);
    if (!graze.ok) return;
    const testData = graze.value.candidates.find(
      (c) => c.id === 'ApexClass:ApplicationPortalTestData',
    );
    if (testData !== undefined) {
      expect(testData.nameCoverage ?? 1).toBeLessThan(0.5);
    }

    const full = await resolveComponents(covStore, 'Resolution_Code__c');
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const field = full.value.candidates.find(
      (c) => c.id === 'CustomField:Case.Resolution_Code__c',
    );
    expect(field?.nameCoverage).toBe(1);
  });
});
