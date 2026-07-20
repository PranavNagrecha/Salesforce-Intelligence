/// <reference types="vitest/globals" />

/**
 * RM-1a — unit tests for the pure reasoning engine (`interpret` / `weakest`).
 *
 * Everything here is SYNTHETIC: `Ns__…`-style component ids, hand-built nodes
 * and edges, no real graph and no real org. The tests prove the honesty
 * invariants by construction:
 *   1. a matching rule cites EXACTLY the matched ids;
 *   2. `confidence = weakest(...)` — a heuristic matched edge forces heuristic
 *      even under a `declared`-max rule;
 *   3. an `absenceShaped` rule under partial coverage downgrades to `'unknown'`
 *      + a "not checked" claim, never a "none/safe" conclusion;
 *   4. a non-matching, non-absence rule yields `[]` (no citation ⇒ no claim).
 */

import type { ConceptRule, ConfidenceLevel, Edge, Node } from '@sf-intelligence/contracts';

import { CONCEPT_RULES, MODEL_VERSION } from '../../src/knowledge/loader.js';
import {
  aggregateHasUnresolvedCountedEndpoint,
  interpret,
  matchesWhere,
  weakest,
  type Coverage,
  type GroundedSlice,
} from '../../src/knowledge/reason.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures — no real org data.
// ---------------------------------------------------------------------------

const HANDLER_ID = 'ApexClass:Ns__Handler';
const FIELD_ID = 'CustomField:Ns__Obj__c.Ns__Field__c';
const FLOW_ID = 'Flow:Ns__MyFlow';

const node = (
  id: string,
  type: Node['type'],
  properties: Record<string, unknown> = {},
): Node => ({
  id,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `synthetic/${id}`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const edge = (
  fromId: string,
  toId: string,
  edgeType: Edge['edgeType'],
  confidence: ConfidenceLevel,
  properties: Record<string, unknown> = {},
): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence,
  source: 'synthetic-test',
  properties,
});

const OBJ_ID = 'CustomObject:Ns__Obj__c';

const COMPLETE: Coverage = { status: 'complete', caveat: null };
const PARTIAL: Coverage = { status: 'partial', caveat: 'Flow coverage is partial in this vault.' };
const UNKNOWN: Coverage = { status: 'unknown', caveat: 'Flow coverage is unknown in this vault.' };

// ---------------------------------------------------------------------------
// weakest — the confidence total order.
// ---------------------------------------------------------------------------

describe('weakest', () => {
  it('returns the identity (declared) with no arguments', () => {
    expect(weakest()).toBe('declared');
  });

  it('returns a single argument unchanged', () => {
    expect(weakest('parsed')).toBe('parsed');
  });

  it('picks the WEAKEST across declared > parsed > heuristic (order-independent)', () => {
    expect(weakest('declared', 'heuristic')).toBe('heuristic');
    expect(weakest('heuristic', 'declared')).toBe('heuristic');
    expect(weakest('declared', 'parsed')).toBe('parsed');
    expect(weakest('parsed', 'declared', 'parsed')).toBe('parsed');
    expect(weakest('declared', 'declared')).toBe('declared');
  });
});

// ---------------------------------------------------------------------------
// matchesWhere — the shared node/edge predicate primitive. Fail-CLOSED on an
// empty clause list (`[].every(...) === true` would match-all every node/edge
// and fabricate a cited claim on 100% of the graph).
// ---------------------------------------------------------------------------

describe('matchesWhere', () => {
  const props = { sharingModel: 'without sharing', isTest: false } as const;

  it('fail-closed: an EMPTY clause array matches NOTHING (never match-all)', () => {
    // `[].every(...)` is `true` in JS — without the length guard this would
    // match every node/edge. The shared primitive must return false instead.
    expect(matchesWhere(props, [])).toBe(false);
  });

  it('undefined ⇒ unconstrained (matches)', () => {
    expect(matchesWhere(props, undefined)).toBe(true);
  });

  it('a scalar clause is byte-identical to strict === on the one key', () => {
    expect(matchesWhere(props, { key: 'sharingModel', equals: 'without sharing' })).toBe(true);
    expect(matchesWhere(props, { key: 'sharingModel', equals: 'with sharing' })).toBe(false);
    // strict === — no coercion (boolean false is not the string 'false').
    expect(matchesWhere(props, { key: 'isTest', equals: false })).toBe(true);
    expect(matchesWhere(props, { key: 'isTest', equals: 'false' })).toBe(false);
  });

  it('a non-empty array ANDs every clause (all must hold)', () => {
    expect(
      matchesWhere(props, [
        { key: 'sharingModel', equals: 'without sharing' },
        { key: 'isTest', equals: false },
      ]),
    ).toBe(true);
    // One failing clause fails the whole conjunction.
    expect(
      matchesWhere(props, [
        { key: 'sharingModel', equals: 'without sharing' },
        { key: 'isTest', equals: true },
      ]),
    ).toBe(false);
  });

  // ── operator-class clauses (in / notIn / neq) — additive to equals ──────────
  const kindProps = { kind: 'formula' } as const;

  it('`in`: matches when the property value is a member of the set', () => {
    expect(
      matchesWhere(kindProps, { key: 'kind', in: ['criteria', 'formula', 'flow-recordtrigger'] }),
    ).toBe(true);
    // A non-member value does NOT match.
    expect(matchesWhere(kindProps, { key: 'kind', in: ['criteria', 'flow-recordtrigger'] })).toBe(
      false,
    );
    // strict membership — no coercion (number 1 is not the string '1').
    expect(matchesWhere({ n: 1 }, { key: 'n', in: ['1', 2] })).toBe(false);
    expect(matchesWhere({ n: 1 }, { key: 'n', in: [1, 2] })).toBe(true);
  });

  it('`in`: an ABSENT property (undefined) is not a member unless listed → no match', () => {
    expect(matchesWhere({}, { key: 'kind', in: ['formula'] })).toBe(false);
  });

  it('`notIn`: matches the complement — including an ABSENT property (mirrors !==)', () => {
    expect(matchesWhere(kindProps, { key: 'kind', notIn: ['flow-decision'] })).toBe(true);
    expect(matchesWhere(kindProps, { key: 'kind', notIn: ['formula'] })).toBe(false);
    // An absent property satisfies notIn (undefined is not a listed value).
    expect(matchesWhere({}, { key: 'kind', notIn: ['formula'] })).toBe(true);
  });

  it('`neq`: strict !== — matches a differing value AND an absent property', () => {
    expect(matchesWhere(kindProps, { key: 'kind', neq: 'flow-decision' })).toBe(true);
    expect(matchesWhere(kindProps, { key: 'kind', neq: 'formula' })).toBe(false);
    // no coercion: boolean false !== the string 'false' → matches
    expect(matchesWhere({ isTest: false }, { key: 'isTest', neq: 'false' })).toBe(true);
    expect(matchesWhere({ isTest: false }, { key: 'isTest', neq: false })).toBe(false);
    // absent property is !== any concrete value → matches
    expect(matchesWhere({}, { key: 'kind', neq: 'formula' })).toBe(true);
  });

  it('an operator clause COMPOSES with an equals clause in an AND-array', () => {
    const p = { kind: 'formula', synthesized: false } as const;
    // equals AND in — both hold.
    expect(
      matchesWhere(p, [
        { key: 'synthesized', equals: false },
        { key: 'kind', in: ['criteria', 'formula', 'flow-recordtrigger'] },
      ]),
    ).toBe(true);
    // the `in` clause fails (flow-decision not present here) → whole AND fails.
    expect(
      matchesWhere(p, [
        { key: 'synthesized', equals: false },
        { key: 'kind', in: ['flow-decision'] },
      ]),
    ).toBe(false);
  });

  // ── isNull — the NULLISH (present/absent) operator ──────────────────────────
  it('`isNull: true`: matches a NULL value AND an ABSENT (undefined) property', () => {
    // present-as-null
    expect(matchesWhere({ defaultValue: null }, { key: 'defaultValue', isNull: true })).toBe(true);
    // absent key ⇒ undefined ⇒ nullish ⇒ matches (why nullish, not strict === null)
    expect(matchesWhere({}, { key: 'defaultValue', isNull: true })).toBe(true);
    // a PRESENT value does NOT satisfy isNull:true
    expect(matchesWhere({ defaultValue: 'USD' }, { key: 'defaultValue', isNull: true })).toBe(false);
  });

  it('`isNull: false`: matches any PRESENT value — including falsy-but-present false / 0 / ""', () => {
    // present string / number
    expect(matchesWhere({ defaultValue: 'USD' }, { key: 'defaultValue', isNull: false })).toBe(true);
    expect(matchesWhere({ n: 5 }, { key: 'n', isNull: false })).toBe(true);
    // CRITICAL: false / 0 / '' are PRESENT (not nullish) — a falsy check would wrongly reject these.
    expect(matchesWhere({ b: false }, { key: 'b', isNull: false })).toBe(true);
    expect(matchesWhere({ n: 0 }, { key: 'n', isNull: false })).toBe(true);
    expect(matchesWhere({ s: '' }, { key: 's', isNull: false })).toBe(true);
    // null / undefined are the ONLY values isNull:false rejects.
    expect(matchesWhere({ defaultValue: null }, { key: 'defaultValue', isNull: false })).toBe(false);
    expect(matchesWhere({}, { key: 'defaultValue', isNull: false })).toBe(false);
  });

  it('`isNull` composes with equals in an AND-array (required===true AND defaultValue nullish)', () => {
    // The A1 shape: a required field with no default value fires; a required field
    // WITH a present default does NOT (the second clause fails).
    expect(
      matchesWhere({ required: true, defaultValue: null }, [
        { key: 'required', equals: true },
        { key: 'defaultValue', isNull: true },
      ]),
    ).toBe(true);
    expect(
      matchesWhere({ required: true }, [
        { key: 'required', equals: true },
        { key: 'defaultValue', isNull: true },
      ]),
    ).toBe(true);
    expect(
      matchesWhere({ required: true, defaultValue: 'USD' }, [
        { key: 'required', equals: true },
        { key: 'defaultValue', isNull: true },
      ]),
    ).toBe(false);
  });

  // ── isEmpty — EC-11 empty-array predicate (never equate absent with empty) ───
  it('`isEmpty: true`: matches a PRESENT empty array only', () => {
    expect(matchesWhere({ loginIpRanges: [] }, { key: 'loginIpRanges', isEmpty: true })).toBe(true);
    expect(
      matchesWhere(
        { loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }] },
        { key: 'loginIpRanges', isEmpty: true },
      ),
    ).toBe(false);
    // ABSENT / null / non-array fail closed — never treat missing as empty.
    expect(matchesWhere({}, { key: 'loginIpRanges', isEmpty: true })).toBe(false);
    expect(matchesWhere({ loginIpRanges: null }, { key: 'loginIpRanges', isEmpty: true })).toBe(false);
    expect(matchesWhere({ loginIpRanges: '' }, { key: 'loginIpRanges', isEmpty: true })).toBe(false);
  });

  it('`isEmpty: false`: matches a PRESENT non-empty array only', () => {
    expect(
      matchesWhere(
        { loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }] },
        { key: 'loginIpRanges', isEmpty: false },
      ),
    ).toBe(true);
    expect(matchesWhere({ loginIpRanges: [] }, { key: 'loginIpRanges', isEmpty: false })).toBe(false);
    expect(matchesWhere({}, { key: 'loginIpRanges', isEmpty: false })).toBe(false);
  });

  // ── anyElement — the EXISTENTIAL array-element matcher (CAP-A / CAP-B) ────────
  // OBJECT-element mode: `qualityIssues[].rule ∈ {…}` — some element's `rule`
  // sub-property satisfies the inner scalar operator.
  const qiProps = {
    qualityIssues: [
      { rule: 'hardcoded-id', severity: 'medium' },
      { rule: 'soql-injection', severity: 'critical' },
    ],
  };
  it('`anyElement` (object mode): HOLDS when SOME element matches the inner `in`', () => {
    expect(
      matchesWhere(qiProps, {
        key: 'qualityIssues',
        anyElement: { key: 'rule', in: ['soql-injection', 'dml-in-loop'] },
      }),
    ).toBe(true);
  });

  it('`anyElement` (object mode): HOLDS on an inner `equals` match', () => {
    expect(
      matchesWhere(qiProps, {
        key: 'qualityIssues',
        anyElement: { key: 'rule', equals: 'hardcoded-id' },
      }),
    ).toBe(true);
  });

  it('`anyElement` (object mode): does NOT hold when NO element matches', () => {
    expect(
      matchesWhere(qiProps, {
        key: 'qualityIssues',
        anyElement: { key: 'rule', in: ['dml-in-loop', 'missing-fls-check'] },
      }),
    ).toBe(false);
  });

  it('`anyElement`: an EMPTY array does NOT hold (some over [] is false)', () => {
    expect(
      matchesWhere(
        { qualityIssues: [] },
        { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-injection'] } },
      ),
    ).toBe(false);
  });

  it('`anyElement`: an ABSENT property does NOT hold (undefined is not an array)', () => {
    expect(
      matchesWhere({}, { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-injection'] } }),
    ).toBe(false);
  });

  it('`anyElement`: a NON-array value does NOT hold (short-circuits false)', () => {
    expect(
      matchesWhere(
        { qualityIssues: 'soql-injection' },
        { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-injection'] } },
      ),
    ).toBe(false);
  });

  it('`anyElement` (object mode): a NON-object element never matches (no thrown access)', () => {
    // A scalar / null element under a KEYED inner is simply skipped, not a throw.
    expect(
      matchesWhere(
        { qualityIssues: ['soql-injection', null, 42] },
        { key: 'qualityIssues', anyElement: { key: 'rule', equals: 'soql-injection' } },
      ),
    ).toBe(false);
  });

  it('`anyElement` (object mode): inner `neq` / `notIn` match on SOME element', () => {
    // neq: some element whose rule !== 'hardcoded-id' (soql-injection qualifies).
    expect(
      matchesWhere(qiProps, { key: 'qualityIssues', anyElement: { key: 'rule', neq: 'hardcoded-id' } }),
    ).toBe(true);
    // notIn: some element whose rule ∉ {hardcoded-id} (soql-injection qualifies).
    expect(
      matchesWhere(qiProps, {
        key: 'qualityIssues',
        anyElement: { key: 'rule', notIn: ['hardcoded-id'] },
      }),
    ).toBe(true);
  });

  // SCALAR-array mode (CAP-B): `ApexTrigger.events` string[] membership — the
  // element IS the value; the inner has NO `key`.
  const trigProps = { events: ['before insert', 'after update'] };
  it('`anyElement` (scalar mode): HOLDS when SOME element is `in` the set', () => {
    expect(
      matchesWhere(trigProps, { key: 'events', anyElement: { in: ['before delete', 'after update'] } }),
    ).toBe(true);
  });

  it('`anyElement` (scalar mode): does NOT hold when NO element is in the set', () => {
    expect(
      matchesWhere(trigProps, { key: 'events', anyElement: { in: ['before delete', 'after delete'] } }),
    ).toBe(false);
  });

  it('`anyElement` (scalar mode): inner `equals` on a scalar element', () => {
    expect(
      matchesWhere(trigProps, { key: 'events', anyElement: { equals: 'before insert' } }),
    ).toBe(true);
    expect(matchesWhere(trigProps, { key: 'events', anyElement: { equals: 'before delete' } })).toBe(
      false,
    );
  });

  it('`anyElement`: composes in an outer AND-array with scalar clauses', () => {
    // A NON-test class whose qualityIssues include soql-injection fires; a test
    // class (first clause fails) or a clean class (second clause fails) does not.
    const clause = [
      { key: 'isTest', equals: false },
      { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-injection'] } },
    ];
    expect(matchesWhere({ isTest: false, ...qiProps }, clause)).toBe(true);
    expect(matchesWhere({ isTest: true, ...qiProps }, clause)).toBe(false);
    expect(matchesWhere({ isTest: false, qualityIssues: [] }, clause)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// interpret — the four required cases.
// ---------------------------------------------------------------------------

describe('interpret', () => {
  it('1) a matching rule yields an Interpretation citing EXACTLY the matched ids', () => {
    const rule: ConceptRule = {
      id: 'rule-reads',
      concept: 'field-provenance',
      bind: { edgeType: 'readsFrom' },
      interpretation: '{0} reads {1}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    const slice: GroundedSlice = {
      nodes: [node(HANDLER_ID, 'ApexClass'), node(FIELD_ID, 'CustomField')],
      // An unrelated edge that must NOT be cited.
      edges: [
        edge(HANDLER_ID, FIELD_ID, 'readsFrom', 'declared'),
        edge(HANDLER_ID, FIELD_ID, 'writesTo', 'declared'),
      ],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.groundedIn).toEqual([HANDLER_ID, FIELD_ID]);
    expect(only.claim).toBe(`${HANDLER_ID} reads ${FIELD_ID}`);
    expect(only.ruleId).toBe('rule-reads');
    expect(only.concept).toBe('field-provenance');
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('2) confidence = weakest(...): a heuristic matched edge forces heuristic under a declared-max rule', () => {
    const rule: ConceptRule = {
      id: 'rule-writes',
      concept: 'field-provenance',
      bind: { edgeType: 'writesTo' },
      interpretation: 'writers: {ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    const slice: GroundedSlice = {
      nodes: [node(HANDLER_ID, 'ApexClass'), node(FIELD_ID, 'CustomField')],
      edges: [
        edge(HANDLER_ID, FIELD_ID, 'writesTo', 'declared'),
        edge(FLOW_ID, FIELD_ID, 'writesTo', 'heuristic'),
      ],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    // Even though the rule's ceiling is 'declared' and one edge is 'declared',
    // the weakest matched edge ('heuristic') wins.
    expect(out[0]!.confidence).toBe('heuristic');
    expect(out[0]!.groundedIn).toEqual([HANDLER_ID, FIELD_ID, FLOW_ID]);
    expect(out[0]!.claim).toBe(`writers: ${HANDLER_ID}, ${FIELD_ID}, ${FLOW_ID}`);
  });

  it('3) an absenceShaped rule under partial coverage downgrades to unknown + "not checked"', () => {
    const rule: ConceptRule = {
      id: 'rule-no-flow-reads',
      concept: 'field-provenance',
      // Matches nothing in the slice → absence.
      bind: { edgeType: 'readsFrom', componentTypes: ['Flow'] },
      interpretation: 'no flow reads this field',
      maxConfidence: 'declared',
      absenceShaped: true,
      dependsOnCoverage: ['Flow'],
    };
    const slice: GroundedSlice = { nodes: [node(FIELD_ID, 'CustomField')], edges: [] };

    const out = interpret(rule, slice, PARTIAL);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.confidence).toBe('unknown');
    expect(only.coverageCaveat).toBe(PARTIAL.caveat);
    expect(only.claim.toLowerCase()).toContain('not checked');
    // Never asserts the absence ("none/safe") under partial coverage.
    expect(only.claim.toLowerCase()).not.toContain('no flow reads this field');
    expect(only.groundedIn).toEqual([]);
  });

  it('3b) the same absenceShaped rule under COMPLETE coverage emits its confident absence claim', () => {
    const rule: ConceptRule = {
      id: 'rule-no-flow-reads',
      concept: 'field-provenance',
      bind: { edgeType: 'readsFrom', componentTypes: ['Flow'] },
      interpretation: 'no flow reads this field',
      maxConfidence: 'declared',
      absenceShaped: true,
      dependsOnCoverage: ['Flow'],
    };
    const slice: GroundedSlice = { nodes: [node(FIELD_ID, 'CustomField')], edges: [] };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toBe('no flow reads this field');
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.coverageCaveat).toBeNull();
  });

  it('4) a non-matching, non-absence rule yields [] (no citation ⇒ no claim)', () => {
    const rule: ConceptRule = {
      id: 'rule-triggers',
      concept: 'automation-collision',
      bind: { edgeType: 'triggersOn' },
      interpretation: 'triggers on {ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['Flow', 'ApexTrigger'],
    };
    const slice: GroundedSlice = {
      nodes: [node(HANDLER_ID, 'ApexClass'), node(FIELD_ID, 'CustomField')],
      edges: [edge(HANDLER_ID, FIELD_ID, 'readsFrom', 'declared')],
    };

    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('5) [FIX 1] an edge predicate with componentTypes cites ONLY endpoints of those types, never the other endpoint', () => {
    const TRIGGER_ID = 'ApexTrigger:Ns__Trg';
    const rule: ConceptRule = {
      id: 'rule-triggers-on-object',
      concept: 'automation-collision',
      // `triggersOn` is automation → object; only the automation endpoint is a
      // save-aborting culprit — the object it fires on must NOT be cited.
      bind: { edgeType: 'triggersOn', componentTypes: ['ApexTrigger', 'Flow'] },
      interpretation: 'automations: {ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexTrigger', 'Flow'],
    };
    const slice: GroundedSlice = {
      nodes: [node(TRIGGER_ID, 'ApexTrigger'), node(OBJ_ID, 'CustomObject')],
      edges: [edge(TRIGGER_ID, OBJ_ID, 'triggersOn', 'declared')],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    // The object endpoint is filtered out; only the automation is grounded/cited.
    expect(only.groundedIn).toEqual([TRIGGER_ID]);
    expect(only.groundedIn).not.toContain(OBJ_ID);
    expect(only.claim).toContain(TRIGGER_ID);
    expect(only.claim).not.toContain(OBJ_ID);
    // The matched declared edge still contributes its confidence.
    expect(only.confidence).toBe('declared');
  });

  it('5a) [F6] a scalar edge rule does NOT self-cite an AUTOMATION anchor over its own OUTGOING triggersOn (degenerate self-reference guard)', () => {
    const TRIGGER_ID = 'ApexTrigger:Ns__Trg';
    const rule: ConceptRule = {
      id: 'rule:status-code/cross-ref-automation',
      concept: 'status-code',
      bind: { edgeType: 'triggersOn', componentTypes: ['ApexTrigger', 'Flow'] },
      interpretation: 'Any of {ids} could have aborted the save; verify which ran.',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexTrigger', 'Flow'],
    };
    // The automation's OWN outgoing triggersOn points at the (grounded) object it
    // fires on. The object is not a cited type, so the ONLY qualifying endpoint
    // would be the anchor itself — a degenerate "any of [self]" claim. Anchored on
    // the AUTOMATION, the rule must NOT fire.
    const slice: GroundedSlice = {
      nodes: [node(TRIGGER_ID, 'ApexTrigger'), node(OBJ_ID, 'CustomObject')],
      edges: [edge(TRIGGER_ID, OBJ_ID, 'triggersOn', 'declared')],
    };
    expect(interpret(rule, slice, COMPLETE, TRIGGER_ID)).toEqual([]);
    // The SAME edge, anchored on the OBJECT, still fires citing the automation.
    const objOut = interpret(rule, slice, COMPLETE, OBJ_ID);
    expect(objOut).toHaveLength(1);
    expect(objOut[0]!.groundedIn).toEqual([TRIGGER_ID]);
  });

  it('5b) [F6] the guard PRESERVES a single-endpoint claim whose other endpoint is DANGLING (absent from the slice), not a self-reference', () => {
    const CHILD_FIELD = 'CustomField:Child__c.Parent__c';
    const DANGLING_PARENT = 'CustomObject:Managed__Parent__c';
    const rule: ConceptRule = {
      id: 'rule:relationship/master-detail-cascade',
      concept: 'relationship',
      bind: {
        edgeType: 'lookupTo',
        componentTypes: ['CustomField', 'CustomObject'],
        edgeWhereProperty: { key: 'relationshipType', equals: 'MasterDetail' },
      },
      interpretation: 'Master-detail relationship ({ids}): the parent cascade-deletes its children.',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['CustomField', 'CustomObject'],
    };
    // The parent object is NOT in the slice (a managed/standard master not
    // retrieved into the vault). The anchored child field is the genuine subject;
    // because the other endpoint is ABSENT (dangling, not a resolved non-cited
    // node) the claim is NOT a degenerate self-reference and still fires.
    const slice: GroundedSlice = {
      nodes: [node(CHILD_FIELD, 'CustomField')],
      edges: [
        edge(CHILD_FIELD, DANGLING_PARENT, 'lookupTo', 'declared', {
          relationshipType: 'MasterDetail',
        }),
      ],
    };
    const out = interpret(rule, slice, COMPLETE, CHILD_FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([CHILD_FIELD]);
  });

  it('6) [FIX 2] an absenceShaped rule whose bind MATCHES under COMPLETE coverage returns [] (never emits "safe/none")', () => {
    const rule: ConceptRule = {
      id: 'rule-no-writers',
      concept: 'field-provenance',
      bind: { edgeType: 'writesTo', componentTypes: ['Flow', 'ApexClass'] },
      interpretation: 'no writer — safe to treat as read-only',
      maxConfidence: 'declared',
      absenceShaped: true,
      dependsOnCoverage: ['Flow'],
    };
    // A writer EXISTS → the absence is FALSE → the "safe/none" conclusion is void.
    const slice: GroundedSlice = {
      nodes: [node(FLOW_ID, 'Flow'), node(FIELD_ID, 'CustomField')],
      edges: [edge(FLOW_ID, FIELD_ID, 'writesTo', 'declared')],
    };

    // Without the guard this emits the absence template citing the contradicting writer.
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('7) [FIX 6] an absenceShaped rule (no match) under UNKNOWN coverage downgrades to "not checked" + unknown', () => {
    const rule: ConceptRule = {
      id: 'rule-no-flow-reads',
      concept: 'field-provenance',
      bind: { edgeType: 'readsFrom', componentTypes: ['Flow'] },
      interpretation: 'no flow reads this field',
      maxConfidence: 'declared',
      absenceShaped: true,
      dependsOnCoverage: ['Flow'],
    };
    const slice: GroundedSlice = { nodes: [node(FIELD_ID, 'CustomField')], edges: [] };

    const out = interpret(rule, slice, UNKNOWN);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.confidence).toBe('unknown');
    expect(only.coverageCaveat).toBe(UNKNOWN.caveat);
    expect(only.claim.toLowerCase()).toContain('not checked');
    // Names the ACTUAL coverage status, so a `!== 'complete'` → `=== 'partial'`
    // narrowing regression (which would drop UNKNOWN into the confident branch)
    // is caught here.
    expect(only.claim).toContain('unknown');
    // Never asserts the absence ("none/safe") when coverage is unknown.
    expect(only.claim.toLowerCase()).not.toContain('no flow reads this field');
    expect(only.groundedIn).toEqual([]);
  });

  it('8) [edgeWhereProperty] an edge predicate matches ONLY edges whose OWN property equals the value', () => {
    // NEW matcher: bind an edge by one of ITS OWN properties (not a node's). A
    // `lookupTo` edge only matches when its `relationshipType` is 'MasterDetail'.
    const rule: ConceptRule = {
      id: 'rule-master-detail-edge',
      concept: 'relationship',
      bind: {
        edgeType: 'lookupTo',
        edgeWhereProperty: { key: 'relationshipType', equals: 'MasterDetail' },
      },
      interpretation: 'master-detail: {ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['CustomField', 'CustomObject'],
    };
    const MD_FIELD = 'CustomField:Ns__Child__c.Ns__Parent__c';
    const LK_FIELD = 'CustomField:Ns__Child__c.Ns__Ref__c';
    const PARENT_OBJ = 'CustomObject:Ns__Parent__c';

    // An edge WITH the matching property matches; both endpoints are cited.
    const matchSlice: GroundedSlice = {
      nodes: [node(MD_FIELD, 'CustomField'), node(PARENT_OBJ, 'CustomObject')],
      edges: [edge(MD_FIELD, PARENT_OBJ, 'lookupTo', 'declared', { relationshipType: 'MasterDetail' })],
    };
    const matched = interpret(rule, matchSlice, COMPLETE);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.groundedIn).toEqual([MD_FIELD, PARENT_OBJ]);
    expect(matched[0]!.claim).toBe(`master-detail: ${MD_FIELD}, ${PARENT_OBJ}`);
    expect(matched[0]!.confidence).toBe('declared');

    // A same-type edge WITHOUT the matching property does NOT match → [].
    const missSlice: GroundedSlice = {
      nodes: [node(LK_FIELD, 'CustomField'), node(PARENT_OBJ, 'CustomObject')],
      edges: [edge(LK_FIELD, PARENT_OBJ, 'lookupTo', 'declared', { relationshipType: 'Lookup' })],
    };
    expect(interpret(rule, missSlice, COMPLETE)).toEqual([]);

    // A `lookupTo` edge with NO relationshipType property is likewise excluded.
    const bareSlice: GroundedSlice = {
      nodes: [node(LK_FIELD, 'CustomField'), node(PARENT_OBJ, 'CustomObject')],
      edges: [edge(LK_FIELD, PARENT_OBJ, 'lookupTo', 'declared')],
    };
    expect(interpret(rule, bareSlice, COMPLETE)).toEqual([]);
  });

  // #4 — root scoping of the EDGE branch. An edge rule may only reason about
  // edges INCIDENT to the queried root. This is what stops the shipped
  // master-detail-cascade rule from firing redundantly on a JUNCTION object once
  // the junction aggregate's 2-hop drags the object's CHILD FIELDS' outgoing
  // lookupTo edges into the shared slice (neither endpoint is the object).
  it('9) [FIX 1 edge branch] an edge rule fires ONLY on edges incident to the root — a child-field edge on an object anchor is skipped', () => {
    const cascadeRule: ConceptRule = {
      id: 'rule:relationship/master-detail-cascade',
      concept: 'relationship',
      bind: {
        edgeType: 'lookupTo',
        componentTypes: ['CustomField', 'CustomObject'],
        edgeWhereProperty: { key: 'relationshipType', equals: 'MasterDetail' },
      },
      interpretation: 'Master-detail relationship ({ids}).',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['CustomField', 'CustomObject'],
    };
    const JUNC = 'CustomObject:Ns__Junction__c';
    const CHILD_FIELD = 'CustomField:Ns__Junction__c.Ns__AlphaRef__c';
    const PARENT = 'CustomObject:Ns__Alpha__c';
    // The junction's OWN child field points at a parent — an edge dragged into the
    // slice by the aggregate 2-hop. NEITHER endpoint is the queried object root.
    const slice: GroundedSlice = {
      nodes: [
        { ...node(JUNC, 'CustomObject') },
        { ...node(CHILD_FIELD, 'CustomField'), parentId: JUNC },
        node(PARENT, 'CustomObject'),
      ],
      edges: [edge(CHILD_FIELD, PARENT, 'lookupTo', 'declared', { relationshipType: 'MasterDetail' })],
    };
    // Anchored on the OBJECT (a junction) → NOT incident → the edge rule stays silent.
    expect(interpret(cascadeRule, slice, COMPLETE, JUNC)).toEqual([]);
    // md-cascade's OWN legit fires stay green: a child-MD-FIELD anchor (outgoing,
    // fromId === root) and a parent-OBJECT anchor (incoming, toId === root) both fire.
    const fieldAnchored = interpret(cascadeRule, slice, COMPLETE, CHILD_FIELD);
    expect(fieldAnchored).toHaveLength(1);
    expect(fieldAnchored[0]!.groundedIn).toEqual([CHILD_FIELD, PARENT]);
    const parentAnchored = interpret(cascadeRule, slice, COMPLETE, PARENT);
    expect(parentAnchored).toHaveLength(1);
    expect(parentAnchored[0]!.groundedIn).toEqual([CHILD_FIELD, PARENT]);
    // With no rootId (raw-predicate unit tests) the pre-fix scan-all behavior stands.
    expect(interpret(cascadeRule, slice, COMPLETE)).toHaveLength(1);
  });

  it('9) [FIX 1] a node-shaped rule matches the ROOT node ONLY — never a neighbor dragged into the slice', () => {
    // A roll-up-shaped node predicate. The slice holds the queried ROOT (a firer,
    // not a CustomField) AND a neighbor Summary field the join's 2-hop expansion
    // would drag in. Asking about the firer must NOT claim the neighbor field.
    const rule: ConceptRule = {
      id: 'rule-summary-node',
      concept: 'relationship',
      bind: {
        componentTypes: ['CustomField'],
        whereProperty: { key: 'dataType', equals: 'Summary' },
      },
      interpretation: '{ids} is a roll-up summary field',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['CustomField'],
    };
    const ROOT_FIRER = 'WorkflowRule:Obj__c.Gate';
    const NEIGHBOR_SUMMARY = 'CustomField:Obj__c.Rollup__c';
    const slice: GroundedSlice = {
      nodes: [
        node(ROOT_FIRER, 'WorkflowRule'),
        node(NEIGHBOR_SUMMARY, 'CustomField', { dataType: 'Summary' }),
      ],
      edges: [],
    };

    // Root = the firer: the neighbor Summary field is a mere neighbor → no claim.
    // Without root scoping the old scan-every-node path (wrongly) claims it.
    expect(interpret(rule, slice, COMPLETE, ROOT_FIRER)).toEqual([]);

    // Root = the Summary field itself (its OWN component) → the rule fires on it.
    const own = interpret(rule, slice, COMPLETE, NEIGHBOR_SUMMARY);
    expect(own).toHaveLength(1);
    expect(own[0]!.groundedIn).toEqual([NEIGHBOR_SUMMARY]);
    expect(own[0]!.confidence).toBe('declared');
  });
});

// ---------------------------------------------------------------------------
// interpret — the multi-edge JOIN predicate (RM-loop). Synthetic slices match
// the real shapes: a firer F `firesWhen`-> a ConditionalContext{kind, fieldRefs}
// and a writer W `writesTo`-> a gated field X; the join intersects on X,
// scoped same-object and self-excluded.
// ---------------------------------------------------------------------------

describe('interpret — EC-5 writer-later / C10 invisibility', () => {
  const VR_FIRER = 'ValidationRule:Obj__c.Status_Gate';
  const VR_CC = 'ConditionalContext:ValidationRule:Obj__c.Status_Gate.condition-0';
  const GATED_FIELD = 'CustomField:Obj__c.Status__c';
  const AFTER_FLOW_WRITER = 'Flow:StatusComputerAfter';
  const WRITER_OBJ = 'CustomObject:Obj__c';
  const BEFORE_FLOW_WRITER = 'Flow:StatusComputerBefore';

  const c10Rule = (): ConceptRule => {
    const r = CONCEPT_RULES.find((x) => x.id === 'rule:automation/cross-phase-write-invisibility');
    expect(r, 'shipped C10 rule must exist').toBeDefined();
    return r!;
  };

  it('fires when an after-save Flow writer feeds a ValidationRule firer (writer-later)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(VR_FIRER, 'ValidationRule'),
        node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(AFTER_FLOW_WRITER, 'Flow', { status: 'Active' }),
      ],
      edges: [
        edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(AFTER_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        edge(AFTER_FLOW_WRITER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
      ],
    };
    const out = interpret(c10Rule(), slice, COMPLETE, VR_FIRER);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('LATER save-order phase');
    expect(out[0]!.claim).toContain('post-save-flows after pre-save-validation');
    expect(out[0]!.claim).toContain('NEVER observe');
    expect(out[0]!.groundedIn).toEqual([VR_FIRER, GATED_FIELD, AFTER_FLOW_WRITER]);
    expect(out[0]!.confidence).toBe('parsed');
  });

  it('stays silent when the writer is EARLIER (before-save → validation) — that is the other upgrade', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(VR_FIRER, 'ValidationRule'),
        node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(BEFORE_FLOW_WRITER, 'Flow', { status: 'Active' }),
      ],
      edges: [
        edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(BEFORE_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        edge(BEFORE_FLOW_WRITER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
      ],
    };
    expect(interpret(c10Rule(), slice, COMPLETE, VR_FIRER)).toEqual([]);
  });

  it('coupled-field-write does NOT upgrade to EARLIER wording on a writer-later triple', () => {
    const shipped = CONCEPT_RULES.find((x) => x.id === 'rule:automation/coupled-field-write')!;
    const slice: GroundedSlice = {
      nodes: [
        node(VR_FIRER, 'ValidationRule'),
        node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(AFTER_FLOW_WRITER, 'Flow', { status: 'Active' }),
      ],
      edges: [
        edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(AFTER_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        edge(AFTER_FLOW_WRITER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
      ],
    };
    const out = interpret(shipped, slice, COMPLETE, VR_FIRER);
    expect(out).toHaveLength(1);
    // Still a coupling, but NOT the earlier upgrade.
    expect(out[0]!.claim).not.toContain('EARLIER save-order phase');
    expect(out[0]!.claim.toLowerCase()).toContain('may be reacting');
  });
});

describe('interpret — EC-4 toWhereProperty / fromWhereProperty', () => {
  const FORMULA = 'CustomField:Obj__c.Score__c';
  const INNER = 'CustomField:Obj__c.Base__c';
  const SUMMARY = 'CustomField:Obj__c.ChildCount__c';
  const PLAIN = 'CustomField:Obj__c.Name__c';

  const formulaOnFormula = (): ConceptRule => ({
    id: 'rule:field/formula-on-derived-formula',
    concept: 'concept:formula-on-derived',
    bind: {
      edgeType: 'references',
      componentTypes: ['CustomField'],
      fromWhereProperty: { key: 'isFormula', equals: true },
      toWhereProperty: { key: 'isFormula', equals: true },
    },
    interpretation:
      '{0} is a formula field that references another formula field {1} — a second-order derivation.',
    maxConfidence: 'parsed',
    absenceShaped: false,
    dependsOnCoverage: ['CustomField'],
  });

  it('fires when a formula references another formula', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FORMULA, 'CustomField', { isFormula: true }),
        node(INNER, 'CustomField', { isFormula: true }),
      ],
      edges: [edge(FORMULA, INNER, 'references', 'parsed')],
    };
    const out = interpret(formulaOnFormula(), slice, COMPLETE, FORMULA);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FORMULA, INNER]);
  });

  it('stays silent when the referenced field is not a formula', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FORMULA, 'CustomField', { isFormula: true }),
        node(PLAIN, 'CustomField'),
      ],
      edges: [edge(FORMULA, PLAIN, 'references', 'parsed')],
    };
    expect(interpret(formulaOnFormula(), slice, COMPLETE, FORMULA)).toEqual([]);
  });

  it('fires formula→Summary via toWhereProperty dataType', () => {
    const rule: ConceptRule = {
      id: 'rule:field/formula-on-derived-summary',
      concept: 'concept:formula-on-derived',
      bind: {
        edgeType: 'references',
        componentTypes: ['CustomField'],
        fromWhereProperty: { key: 'isFormula', equals: true },
        toWhereProperty: { key: 'dataType', equals: 'Summary' },
      },
      interpretation: '{0} references roll-up {1}.',
      maxConfidence: 'parsed',
      absenceShaped: false,
      dependsOnCoverage: ['CustomField'],
    };
    const slice: GroundedSlice = {
      nodes: [
        node(FORMULA, 'CustomField', { isFormula: true }),
        node(SUMMARY, 'CustomField', { dataType: 'Summary' }),
      ],
      edges: [edge(FORMULA, SUMMARY, 'references', 'parsed')],
    };
    const out = interpret(rule, slice, COMPLETE, FORMULA);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(SUMMARY);
  });
});

describe('interpret — EC-13 prop: node-property interpolation', () => {
  it('fills {prop:key} tokens from the root node properties on a node-shaped rule', () => {
    const FIELD = 'CustomField:Obj__c.ChildCount__c';
    const rule: ConceptRule = {
      id: 'rule:relationship/rollup-recalc-source',
      concept: 'concept:rollup-recalc-source-coupling',
      bind: {
        componentTypes: ['CustomField'],
        whereProperty: [
          { key: 'dataType', equals: 'Summary' },
          { key: 'summaryForeignKey', isNull: false },
          { key: 'summaryOperation', isNull: false },
        ],
      },
      interpretation:
        '{0} is a roll-up summary that recalculates from child relationship field {prop:summaryForeignKey} using operation {prop:summaryOperation}.',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['CustomField'],
    };
    const slice: GroundedSlice = {
      nodes: [
        node(FIELD, 'CustomField', {
          dataType: 'Summary',
          summaryForeignKey: 'Child__c.Parent__c',
          summaryOperation: 'count',
        }),
      ],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('Child__c.Parent__c');
    expect(out[0]!.claim).toContain('count');
    expect(out[0]!.claim).not.toContain('{prop:');
  });
});

describe('interpret — EC-6 dualEdge recursive self-write', () => {
  const FLOW = 'Flow:SelfWrite';
  const OBJ = 'CustomObject:Obj__c';
  const FIELD = 'CustomField:Obj__c.Status__c';
  const OTHER_FIELD = 'CustomField:Other__c.Status__c';

  const dualRule = (): ConceptRule => ({
    id: 'rule:automation/recursive-self-write',
    concept: 'concept:recursive-automation-self-write',
    bind: {
      componentTypes: ['Flow', 'ApexTrigger', 'WorkflowRule', 'ApprovalProcess'],
      dualEdge: {
        edgeTypeA: 'triggersOn',
        edgeTypeB: 'writesTo',
        sameObject: true,
        excludeInactive: true,
      },
    },
    interpretation:
      'Automation {0} both fires on {1} and writes {2} on the SAME object — a self-write that can re-enter the save order. Confirm with order_of_execution whether re-entry is intentional or guarded.',
    maxConfidence: 'heuristic',
    absenceShaped: false,
    dependsOnCoverage: ['Flow', 'ApexTrigger', 'WorkflowRule'],
  });

  it('fires when one Flow triggersOn an object and writesTo a same-object field', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', { status: 'Active' }),
        node(OBJ, 'CustomObject'),
        node(FIELD, 'CustomField'),
      ],
      edges: [
        edge(FLOW, OBJ, 'triggersOn', 'declared'),
        edge(FLOW, FIELD, 'writesTo', 'parsed'),
      ],
    };
    const out = interpret(dualRule(), slice, COMPLETE, FLOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FLOW, OBJ, FIELD]);
    expect(out[0]!.confidence).toBe('heuristic');
    expect(out[0]!.claim).toContain(FLOW);
    expect(out[0]!.claim).toContain(OBJ);
    expect(out[0]!.claim).toContain(FIELD);
  });

  it('stays silent when writesTo targets a DIFFERENT object', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', { status: 'Active' }),
        node(OBJ, 'CustomObject'),
        node(OTHER_FIELD, 'CustomField'),
      ],
      edges: [
        edge(FLOW, OBJ, 'triggersOn', 'declared'),
        edge(FLOW, OTHER_FIELD, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(dualRule(), slice, COMPLETE, FLOW)).toEqual([]);
  });

  it('stays silent for an Obsolete Flow when excludeInactive is true', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', { status: 'Obsolete' }),
        node(OBJ, 'CustomObject'),
        node(FIELD, 'CustomField'),
      ],
      edges: [
        edge(FLOW, OBJ, 'triggersOn', 'declared'),
        edge(FLOW, FIELD, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(dualRule(), slice, COMPLETE, FLOW)).toEqual([]);
  });

  it('requires a rootId (no scan-everything for dualEdge)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', { status: 'Active' }),
        node(OBJ, 'CustomObject'),
        node(FIELD, 'CustomField'),
      ],
      edges: [
        edge(FLOW, OBJ, 'triggersOn', 'declared'),
        edge(FLOW, FIELD, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(dualRule(), slice, COMPLETE)).toEqual([]);
  });
});

describe('interpret — EC-8 antiJoin C15/C17', () => {
  const PS = 'PermissionSet:Ns__Editor';
  const FIELD = 'CustomField:Ns__Deal__c.Status__c';
  const OBJ = 'CustomObject:Ns__Deal__c';

  const fieldWithoutObject = (): ConceptRule => ({
    id: 'rule:access/crud-fls-field-edit-without-object-edit',
    concept: 'concept:crud-fls-consistency-anti-join',
    bind: {
      edgeType: 'grantedBy',
      componentTypes: ['PermissionSet', 'Profile', 'CustomField'],
      edgeWhereProperty: { key: 'editable', equals: true },
      antiJoin: {
        absentEdgeType: 'grantedBy',
        absentToTypes: ['CustomObject'],
        absentEdgeWhereProperty: { key: 'allowEdit', equals: true },
        correlate: 'sameFromToPresentObject',
      },
    },
    interpretation: 'INERT field EDIT among {ids}.',
    maxConfidence: 'declared',
    absenceShaped: true,
    dependsOnCoverage: ['PermissionSet', 'Profile', 'CustomField', 'CustomObject'],
  });

  const deepGap = (): ConceptRule => ({
    id: 'rule:field/deep-creation-gap-no-before-save-writer',
    concept: 'concept:deep-creation-gap',
    bind: {
      componentTypes: ['CustomField'],
      whereProperty: [
        { key: 'required', equals: true },
        { key: 'defaultValue', isNull: true },
      ],
      antiJoin: {
        absentEdgeType: 'writesTo',
        absentFromTypes: ['Flow', 'ApexTrigger'],
        correlate: 'sameTo',
        absentFromPhaseIn: ['before-save-flows', 'pre-save-triggers'],
      },
    },
    interpretation: '{ids} is a deep creation gap.',
    maxConfidence: 'parsed',
    absenceShaped: true,
    dependsOnCoverage: ['CustomField', 'Flow', 'ApexTrigger'],
  });

  it('C15 fires when field editable grant has no matching object allowEdit', () => {
    const slice: GroundedSlice = {
      nodes: [node(PS, 'PermissionSet'), node(FIELD, 'CustomField'), node(OBJ, 'CustomObject')],
      edges: [edge(PS, FIELD, 'grantedBy', 'declared', { editable: true, readable: true })],
    };
    const out = interpret(fieldWithoutObject(), slice, COMPLETE, FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('INERT');
    expect(out[0]!.groundedIn).toEqual([PS, FIELD]);
  });

  it('C15 stays silent when the same grantor also has object allowEdit', () => {
    const slice: GroundedSlice = {
      nodes: [node(PS, 'PermissionSet'), node(FIELD, 'CustomField'), node(OBJ, 'CustomObject')],
      edges: [
        edge(PS, FIELD, 'grantedBy', 'declared', { editable: true, readable: true }),
        edge(PS, OBJ, 'grantedBy', 'declared', { allowEdit: true, allowRead: true }),
      ],
    };
    expect(interpret(fieldWithoutObject(), slice, COMPLETE, FIELD)).toEqual([]);
  });

  it('C15 under partial coverage downgrades to not-checked (never claims inert)', () => {
    const slice: GroundedSlice = {
      nodes: [node(PS, 'PermissionSet'), node(FIELD, 'CustomField'), node(OBJ, 'CustomObject')],
      edges: [edge(PS, FIELD, 'grantedBy', 'declared', { editable: true, readable: true })],
    };
    const out = interpret(fieldWithoutObject(), slice, PARTIAL, FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('unknown');
    expect(out[0]!.claim.toLowerCase()).toContain('not checked');
  });

  it('C17 fires on required+no-default with no before-save writer', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIELD, 'CustomField', { required: true, defaultValue: null })],
      edges: [],
    };
    const out = interpret(deepGap(), slice, COMPLETE, FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('deep creation gap');
  });

  it('C17 stays silent when a before-save Flow writes the field', () => {
    const FLOW = 'Flow:Ns__FillStatus';
    const slice: GroundedSlice = {
      nodes: [
        node(FIELD, 'CustomField', { required: true, defaultValue: null }),
        node(FLOW, 'Flow', { status: 'Active' }),
        node(OBJ, 'CustomObject'),
      ],
      edges: [
        edge(FLOW, FIELD, 'writesTo', 'parsed'),
        edge(FLOW, OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
      ],
    };
    expect(interpret(deepGap(), slice, COMPLETE, FIELD)).toEqual([]);
  });

  it('C17 still fires when only an after-save writer exists (does not close the gap)', () => {
    const FLOW = 'Flow:Ns__AfterFill';
    const slice: GroundedSlice = {
      nodes: [
        node(FIELD, 'CustomField', { required: true, defaultValue: null }),
        node(FLOW, 'Flow', { status: 'Active' }),
        node(OBJ, 'CustomObject'),
      ],
      edges: [
        edge(FLOW, FIELD, 'writesTo', 'parsed'),
        edge(FLOW, OBJ, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
      ],
    };
    const out = interpret(deepGap(), slice, COMPLETE, FIELD);
    expect(out).toHaveLength(1);
  });

  it('C17 under unknown coverage downgrades to not-checked', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIELD, 'CustomField', { required: true, defaultValue: null })],
      edges: [],
    };
    const out = interpret(deepGap(), slice, UNKNOWN, FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('unknown');
    expect(out[0]!.claim.toLowerCase()).toContain('not checked');
  });
});

describe('interpret — EC-9 setDifference C16', () => {
  const PSG = 'PermissionSetGroup:Ns__SalesGroup';
  const MEMBER = 'PermissionSet:Ns__SalesMember';
  const MEMBER_B = 'PermissionSet:Ns__SalesMemberB';
  const MUTE = 'MutingPermissionSet:Ns__SalesMute';

  const psgDiff = (): ConceptRule => ({
    id: 'rule:access/psg-muting-set-difference',
    concept: 'concept:permission-set-group-muting-calculation',
    bind: {
      componentTypes: ['PermissionSetGroup'],
      setDifference: {
        includeEdgeType: 'references',
        includeToTypes: ['PermissionSet'],
        includeEdgeWhereProperty: {
          key: 'referenceKind',
          equals: 'permissionSetGroupMember',
        },
        subtractEdgeType: 'references',
        subtractToTypes: ['MutingPermissionSet'],
        subtractEdgeWhereProperty: {
          key: 'referenceKind',
          equals: 'mutingPermissionSet',
        },
        requireBothNonEmpty: true,
      },
    },
    interpretation: 'Permission set group muting calculation among {ids}.',
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: ['PermissionSetGroup', 'PermissionSet', 'MutingPermissionSet'],
  });

  it('C16 fires when PSG has both members and muting sets', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(PSG, 'PermissionSetGroup'),
        node(MEMBER, 'PermissionSet'),
        node(MUTE, 'MutingPermissionSet'),
      ],
      edges: [
        edge(PSG, MEMBER, 'references', 'declared', {
          referenceKind: 'permissionSetGroupMember',
        }),
        edge(PSG, MUTE, 'references', 'declared', {
          referenceKind: 'mutingPermissionSet',
        }),
      ],
    };
    const out = interpret(psgDiff(), slice, COMPLETE, PSG);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('muting calculation');
    expect(out[0]!.groundedIn).toEqual([PSG, MEMBER, MUTE]);
    expect(out[0]!.confidence).toBe('declared');
  });

  it('C16 cites all members and muting sets in sorted order after the root', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(PSG, 'PermissionSetGroup'),
        node(MEMBER_B, 'PermissionSet'),
        node(MEMBER, 'PermissionSet'),
        node(MUTE, 'MutingPermissionSet'),
      ],
      edges: [
        edge(PSG, MEMBER_B, 'references', 'declared', {
          referenceKind: 'permissionSetGroupMember',
        }),
        edge(PSG, MEMBER, 'references', 'declared', {
          referenceKind: 'permissionSetGroupMember',
        }),
        edge(PSG, MUTE, 'references', 'declared', {
          referenceKind: 'mutingPermissionSet',
        }),
      ],
    };
    const out = interpret(psgDiff(), slice, COMPLETE, PSG);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([PSG, MEMBER, MEMBER_B, MUTE]);
  });

  it('C16 stays silent when PSG has members but no muting (requireBothNonEmpty)', () => {
    const slice: GroundedSlice = {
      nodes: [node(PSG, 'PermissionSetGroup'), node(MEMBER, 'PermissionSet')],
      edges: [
        edge(PSG, MEMBER, 'references', 'declared', {
          referenceKind: 'permissionSetGroupMember',
        }),
      ],
    };
    expect(interpret(psgDiff(), slice, COMPLETE, PSG)).toEqual([]);
  });

  it('C16 stays silent when PSG has muting but no members', () => {
    const slice: GroundedSlice = {
      nodes: [node(PSG, 'PermissionSetGroup'), node(MUTE, 'MutingPermissionSet')],
      edges: [
        edge(PSG, MUTE, 'references', 'declared', {
          referenceKind: 'mutingPermissionSet',
        }),
      ],
    };
    expect(interpret(psgDiff(), slice, COMPLETE, PSG)).toEqual([]);
  });

  it('C16 stays silent without a root id', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(PSG, 'PermissionSetGroup'),
        node(MEMBER, 'PermissionSet'),
        node(MUTE, 'MutingPermissionSet'),
      ],
      edges: [
        edge(PSG, MEMBER, 'references', 'declared', {
          referenceKind: 'permissionSetGroupMember',
        }),
        edge(PSG, MUTE, 'references', 'declared', {
          referenceKind: 'mutingPermissionSet',
        }),
      ],
    };
    expect(interpret(psgDiff(), slice, COMPLETE)).toEqual([]);
  });
});

describe('interpret — EC-11 crossObjectCascade (D3 cross-object-cascade-save)', () => {
  const WRITER = 'Flow:CrossCascadeWriter';
  const OBJ_A = 'CustomObject:Account';
  const FIELD_B = 'CustomField:Contact.Status__c';
  const FIELD_A = 'CustomField:Account.Status__c';
  const TARGET_FLOW = 'Flow:ContactAfterSave';

  const cascadeRule = (): ConceptRule => ({
    id: 'rule:automation/cross-object-cascade-save',
    concept: 'concept:cross-object-cascade-save',
    bind: {
      componentTypes: ['Flow', 'ApexTrigger', 'WorkflowRule', 'ApprovalProcess'],
      crossObjectCascade: {
        writerTriggerEdge: 'triggersOn',
        writeEdge: 'writesTo',
        targetIncomingEdgeTypes: ['triggersOn', 'firesWhen'],
        excludeInactive: true,
        excludeBeforeSaveFlowWriter: true,
      },
    },
    interpretation:
      'Cross-object cascade save among {ids}: writer {0} writes {1} on B which has automation {2}.',
    maxConfidence: 'parsed',
    absenceShaped: false,
    dependsOnCoverage: ['Flow', 'ApexTrigger', 'WorkflowRule', 'ApprovalProcess'],
  });

  it('fires when writer on A writes B and B has incoming triggersOn automation', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(WRITER, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' }),
        node(OBJ_A, 'CustomObject'),
        node(FIELD_B, 'CustomField'),
        node(TARGET_FLOW, 'Flow', { status: 'Active' }),
      ],
      edges: [
        edge(WRITER, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
        edge(WRITER, FIELD_B, 'writesTo', 'parsed'),
        edge(TARGET_FLOW, 'CustomObject:Contact', 'triggersOn', 'declared', {
          triggerType: 'RecordAfterSave',
        }),
      ],
    };
    const out = interpret(cascadeRule(), slice, COMPLETE, WRITER);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([WRITER, FIELD_B, TARGET_FLOW]);
    expect(out[0]!.confidence).toBe('parsed');
    expect(out[0]!.claim.toLowerCase()).toContain('cascade');
  });

  it('stays silent on same-object write (C11 / dualEdge territory)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(WRITER, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' }),
        node(OBJ_A, 'CustomObject'),
        node(FIELD_A, 'CustomField'),
        node(TARGET_FLOW, 'Flow', { status: 'Active' }),
      ],
      edges: [
        edge(WRITER, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
        edge(WRITER, FIELD_A, 'writesTo', 'parsed'),
        edge(TARGET_FLOW, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
      ],
    };
    expect(interpret(cascadeRule(), slice, COMPLETE, WRITER)).toEqual([]);
  });

  it('stays silent when target object B has no incoming automation', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(WRITER, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' }),
        node(OBJ_A, 'CustomObject'),
        node(FIELD_B, 'CustomField'),
      ],
      edges: [
        edge(WRITER, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
        edge(WRITER, FIELD_B, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(cascadeRule(), slice, COMPLETE, WRITER)).toEqual([]);
  });

  it('stays silent for RecordBeforeSave Flow writer when excludeBeforeSaveFlowWriter is true', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(WRITER, 'Flow', { status: 'Active', triggerType: 'RecordBeforeSave' }),
        node(OBJ_A, 'CustomObject'),
        node(FIELD_B, 'CustomField'),
        node(TARGET_FLOW, 'Flow', { status: 'Active' }),
      ],
      edges: [
        edge(WRITER, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
        edge(WRITER, FIELD_B, 'writesTo', 'parsed'),
        edge(TARGET_FLOW, 'CustomObject:Contact', 'triggersOn', 'declared', {
          triggerType: 'RecordAfterSave',
        }),
      ],
    };
    expect(interpret(cascadeRule(), slice, COMPLETE, WRITER)).toEqual([]);
  });

  it('requires a rootId (no scan-everything for crossObjectCascade)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(WRITER, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' }),
        node(OBJ_A, 'CustomObject'),
        node(FIELD_B, 'CustomField'),
        node(TARGET_FLOW, 'Flow', { status: 'Active' }),
      ],
      edges: [
        edge(WRITER, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
        edge(WRITER, FIELD_B, 'writesTo', 'parsed'),
        edge(TARGET_FLOW, 'CustomObject:Contact', 'triggersOn', 'declared', {
          triggerType: 'RecordAfterSave',
        }),
      ],
    };
    expect(interpret(cascadeRule(), slice, COMPLETE)).toEqual([]);
  });
});

describe('interpret — EC-11 dualEdge sameObject:false (D4) + isEmpty (D7)', () => {
  const FLOW = 'Flow:CrossWriteBeforeSave';
  const OBJ_A = 'CustomObject:Account';
  const FIELD_B = 'CustomField:Contact.Status__c';
  const FIELD_A = 'CustomField:Account.Status__c';
  const PROFILE = 'Profile:Ns__Admin';

  const beforeSaveCross = (): ConceptRule => ({
    id: 'rule:automation/before-save-flow-cross-record-write',
    concept: 'concept:before-save-flow-cross-record-write',
    bind: {
      componentTypes: ['Flow'],
      whereProperty: { key: 'triggerType', equals: 'RecordBeforeSave' },
      dualEdge: {
        edgeTypeA: 'triggersOn',
        edgeTypeB: 'writesTo',
        sameObject: false,
        excludeInactive: true,
      },
    },
    interpretation:
      'Before-save flow cross-record write among {ids}: fires on {1} but writes {2}.',
    maxConfidence: 'parsed',
    absenceShaped: false,
    dependsOnCoverage: ['Flow'],
  });

  const emptyIp = (): ConceptRule => ({
    id: 'rule:access/profile-ip-restriction-absence',
    concept: 'concept:profile-ip-restriction-absence',
    bind: {
      componentTypes: ['Profile'],
      whereProperty: { key: 'loginIpRanges', isEmpty: true },
    },
    interpretation: 'Profile IP restriction absence among {ids}.',
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: ['Profile'],
  });

  it('D4 fires when RecordBeforeSave Flow writes a DIFFERENT object', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', { status: 'Active', triggerType: 'RecordBeforeSave' }),
        node(OBJ_A, 'CustomObject'),
        node(FIELD_B, 'CustomField'),
      ],
      edges: [
        edge(FLOW, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
        edge(FLOW, FIELD_B, 'writesTo', 'parsed'),
      ],
    };
    const out = interpret(beforeSaveCross(), slice, COMPLETE, FLOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FLOW, OBJ_A, FIELD_B]);
    expect(out[0]!.confidence).toBe('parsed');
    expect(out[0]!.claim).toContain('cross-record');
  });

  it('D4 stays silent on same-object before-save write (C11 territory)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', { status: 'Active', triggerType: 'RecordBeforeSave' }),
        node(OBJ_A, 'CustomObject'),
        node(FIELD_A, 'CustomField'),
      ],
      edges: [
        edge(FLOW, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
        edge(FLOW, FIELD_A, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(beforeSaveCross(), slice, COMPLETE, FLOW)).toEqual([]);
  });

  it('D4 stays silent when triggerType is not RecordBeforeSave', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' }),
        node(OBJ_A, 'CustomObject'),
        node(FIELD_B, 'CustomField'),
      ],
      edges: [
        edge(FLOW, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
        edge(FLOW, FIELD_B, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(beforeSaveCross(), slice, COMPLETE, FLOW)).toEqual([]);
  });

  it('D7 fires on a Profile with present empty loginIpRanges', () => {
    const slice: GroundedSlice = {
      nodes: [node(PROFILE, 'Profile', { loginIpRanges: [] })],
      edges: [],
    };
    const out = interpret(emptyIp(), slice, COMPLETE, PROFILE);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([PROFILE]);
    expect(out[0]!.confidence).toBe('declared');
  });

  it('D7 stays silent when loginIpRanges is non-empty', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(PROFILE, 'Profile', {
          loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }],
        }),
      ],
      edges: [],
    };
    expect(interpret(emptyIp(), slice, COMPLETE, PROFILE)).toEqual([]);
  });

  it('D7 stays silent when loginIpRanges key is ABSENT (fail closed)', () => {
    const slice: GroundedSlice = {
      nodes: [node(PROFILE, 'Profile')],
      edges: [],
    };
    expect(interpret(emptyIp(), slice, COMPLETE, PROFILE)).toEqual([]);
  });
});

describe('interpret — EC-12 propertyCompare (D8 external OWD exceeds internal)', () => {
  const OBJ = 'CustomObject:Ns__Deal__c';

  const exceeds = (): ConceptRule => ({
    id: 'rule:sharing/external-owd-exceeds-internal',
    concept: 'concept:external-owd-exceeds-internal',
    bind: {
      componentTypes: ['CustomObject'],
      propertyCompare: {
        leftKey: 'externalSharingModel',
        rightKey: 'sharingModel',
        op: 'gt',
        rankTable: 'owdPermissiveness',
      },
    },
    interpretation:
      'External OWD exceeds internal among {ids}: external={prop:externalSharingModel} internal={prop:sharingModel}.',
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: ['CustomObject'],
  });

  it('fires when external ReadWrite exceeds internal Private', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', {
          sharingModel: 'Private',
          externalSharingModel: 'ReadWrite',
        }),
      ],
      edges: [],
    };
    const out = interpret(exceeds(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([OBJ]);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim).toContain('ReadWrite');
    expect(out[0]!.claim).toContain('Private');
  });

  it('fires when external Read exceeds internal Private', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', {
          sharingModel: 'Private',
          externalSharingModel: 'Read',
        }),
      ],
      edges: [],
    };
    expect(interpret(exceeds(), slice, COMPLETE, OBJ)).toHaveLength(1);
  });

  it('stays silent when external equals internal', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', {
          sharingModel: 'Read',
          externalSharingModel: 'Read',
        }),
      ],
      edges: [],
    };
    expect(interpret(exceeds(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('stays silent when external is stricter than internal', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', {
          sharingModel: 'ReadWrite',
          externalSharingModel: 'Private',
        }),
      ],
      edges: [],
    };
    expect(interpret(exceeds(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('stays silent when either OWD key is absent (fail closed)', () => {
    expect(
      interpret(
        exceeds(),
        { nodes: [node(OBJ, 'CustomObject', { sharingModel: 'Private' })], edges: [] },
        COMPLETE,
        OBJ,
      ),
    ).toEqual([]);
    expect(
      interpret(
        exceeds(),
        {
          nodes: [node(OBJ, 'CustomObject', { externalSharingModel: 'Read' })],
          edges: [],
        },
        COMPLETE,
        OBJ,
      ),
    ).toEqual([]);
  });

  it('stays silent on unknown OWD tokens (fail closed)', () => {
    expect(
      interpret(
        exceeds(),
        {
          nodes: [
            node(OBJ, 'CustomObject', {
              sharingModel: 'Private',
              externalSharingModel: 'NotARealOwd',
            }),
          ],
          edges: [],
        },
        COMPLETE,
        OBJ,
      ),
    ).toEqual([]);
  });
});

describe('interpret — EC-10 fieldJoin orphan set-diff (C18)', () => {
  const DEP = 'CustomField:Ns__Deal__c.SubType__c';
  const CTRL = 'CustomField:Ns__Deal__c.Type__c';
  const OTHER_OBJ = 'CustomField:Account.Type__c';

  const orphanRule = (): ConceptRule => ({
    id: 'rule:field/dependent-picklist-orphaned-value',
    concept: 'concept:dependent-picklist-orphaned-value',
    bind: {
      componentTypes: ['CustomField'],
      whereProperty: { key: 'controllingField', isNull: false },
      fieldJoin: {
        nameProperty: 'controllingField',
        orphanSetDiff: {
          leftArrayKey: 'controllingFieldValues',
          leftElementKey: 'controllingFieldValue',
          rightArrayKey: 'picklistValues',
          rightElementKey: 'value',
          rightElementWhere: { key: 'isActive', equals: true },
        },
      },
    },
    interpretation:
      'Orphan among {ids}: values [{orphanValues}] missing/inactive on {1}.',
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: ['CustomField'],
  });

  it('fires when a controllingFieldValue is absent from the sibling active values', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DEP, 'CustomField', {
          controllingField: 'Type__c',
          controllingFieldValues: [
            { controllingFieldValue: 'New', valueName: 'A' },
            { controllingFieldValue: 'Removed', valueName: 'B' },
          ],
        }),
        node(CTRL, 'CustomField', {
          picklistValues: [
            { value: 'New', isActive: true },
            { value: 'Old', isActive: true },
          ],
        }),
      ],
      edges: [],
    };
    const out = interpret(orphanRule(), slice, COMPLETE, DEP);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([DEP, CTRL]);
    expect(out[0]!.claim).toContain('Removed');
    expect(out[0]!.confidence).toBe('declared');
  });

  it('treats inactive controlling values as orphans', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DEP, 'CustomField', {
          controllingField: 'Type__c',
          controllingFieldValues: [
            { controllingFieldValue: 'Legacy', valueName: 'X' },
          ],
        }),
        node(CTRL, 'CustomField', {
          picklistValues: [{ value: 'Legacy', isActive: false }],
        }),
      ],
      edges: [],
    };
    const out = interpret(orphanRule(), slice, COMPLETE, DEP);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('Legacy');
  });

  it('stays silent when every controllingFieldValue is active on the sibling', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DEP, 'CustomField', {
          controllingField: 'Type__c',
          controllingFieldValues: [
            { controllingFieldValue: 'New', valueName: 'A' },
          ],
        }),
        node(CTRL, 'CustomField', {
          picklistValues: [{ value: 'New', isActive: true }],
        }),
      ],
      edges: [],
    };
    expect(interpret(orphanRule(), slice, COMPLETE, DEP)).toEqual([]);
  });

  it('stays silent when the sibling is on a different object', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DEP, 'CustomField', {
          controllingField: 'Type__c',
          controllingFieldValues: [
            { controllingFieldValue: 'Removed', valueName: 'B' },
          ],
        }),
        node(OTHER_OBJ, 'CustomField', {
          picklistValues: [{ value: 'New', isActive: true }],
        }),
      ],
      edges: [],
    };
    expect(interpret(orphanRule(), slice, COMPLETE, DEP)).toEqual([]);
  });

  it('stays silent when sibling picklistValues is ungrounded (fail closed)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DEP, 'CustomField', {
          controllingField: 'Type__c',
          controllingFieldValues: [
            { controllingFieldValue: 'Removed', valueName: 'B' },
          ],
        }),
        node(CTRL, 'CustomField', { valueSetName: 'SomeGvs' }),
      ],
      edges: [],
    };
    expect(interpret(orphanRule(), slice, COMPLETE, DEP)).toEqual([]);
  });
});

describe('interpret — D9 propertyEqualsEndpoint (flow-self-dml-reentry)', () => {
  const FLOW = 'Flow:Ns__DealAfterSave';
  const OBJ = 'CustomObject:Ns__Deal__c';
  const OTHER = 'CustomObject:Ns__Account__c';

  const reentry = (): ConceptRule => ({
    id: 'rule:automation/flow-self-dml-reentry',
    concept: 'concept:flow-self-dml-reentry',
    bind: {
      componentTypes: ['Flow'],
      propertyEqualsEndpoint: {
        nodeProperty: 'triggerObject',
        endpointEdgeType: 'writesTo',
        relation: 'equal',
        endpointEdgeWhereProperty: {
          key: 'operation',
          in: ['recordCreate', 'recordUpdate', 'recordDelete'],
        },
        excludeInactive: true,
      },
    },
    interpretation:
      'Flow {0} triggers on {prop:triggerObject} and DML {writeOp} on that SAME object (endpoint {1}) — self-DML re-entry.',
    maxConfidence: 'heuristic',
    absenceShaped: false,
    dependsOnCoverage: ['Flow'],
  });

  const activeFlow = () =>
    node(FLOW, 'Flow', {
      status: 'Active',
      triggerType: 'RecordAfterSave',
      triggerObject: 'Ns__Deal__c',
    });

  it('fires when a record-triggered flow does a recordUpdate DML on its own trigger object', () => {
    const slice: GroundedSlice = {
      nodes: [activeFlow()],
      edges: [edge(FLOW, OBJ, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
    };
    const out = interpret(reentry(), slice, COMPLETE, FLOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FLOW, OBJ]);
    expect(out[0]!.confidence).toBe('heuristic');
    expect(out[0]!.claim).toContain('recordUpdate');
    expect(out[0]!.claim).toContain('Ns__Deal__c');
  });

  it('fires for recordCreate and recordDelete on the trigger object', () => {
    for (const operation of ['recordCreate', 'recordDelete']) {
      const slice: GroundedSlice = {
        nodes: [activeFlow()],
        edges: [edge(FLOW, OBJ, 'writesTo', 'parsed', { operation })],
      };
      const out = interpret(reentry(), slice, COMPLETE, FLOW);
      expect(out, operation).toHaveLength(1);
      expect(out[0]!.claim).toContain(operation);
    }
  });

  it('cites the FIELD-level DML endpoint object scope too (CustomField:Obj.Field → Obj)', () => {
    const FIELD = 'CustomField:Ns__Deal__c.Stage__c';
    const slice: GroundedSlice = {
      nodes: [activeFlow()],
      edges: [edge(FLOW, FIELD, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
    };
    const out = interpret(reentry(), slice, COMPLETE, FLOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FLOW, FIELD]);
  });

  it('STAYS SILENT on a before-save in-place $Record field assignment (the C11-vs-D9 honesty line)', () => {
    // Same trigger object, same writesTo edge — but operation is the in-place
    // beforeSaveFieldAssignment, which does NOT re-enter. C11 dualEdge would
    // fire here; D9 must not.
    const FIELD = 'CustomField:Ns__Deal__c.Stage__c';
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', {
          status: 'Active',
          triggerType: 'RecordBeforeSave',
          triggerObject: 'Ns__Deal__c',
        }),
      ],
      edges: [
        edge(FLOW, FIELD, 'writesTo', 'parsed', { operation: 'beforeSaveFieldAssignment' }),
      ],
    };
    expect(interpret(reentry(), slice, COMPLETE, FLOW)).toEqual([]);
  });

  it('stays silent when the DML targets a DIFFERENT object (cross-object write is not re-entry)', () => {
    const slice: GroundedSlice = {
      nodes: [activeFlow()],
      edges: [edge(FLOW, OTHER, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
    };
    expect(interpret(reentry(), slice, COMPLETE, FLOW)).toEqual([]);
  });

  it('stays silent when triggerObject is absent (fail closed)', () => {
    const slice: GroundedSlice = {
      nodes: [node(FLOW, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' })],
      edges: [edge(FLOW, OBJ, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
    };
    expect(interpret(reentry(), slice, COMPLETE, FLOW)).toEqual([]);
  });

  it('drops a provably-inactive (Obsolete) flow under excludeInactive', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', {
          status: 'Obsolete',
          triggerType: 'RecordAfterSave',
          triggerObject: 'Ns__Deal__c',
        }),
      ],
      edges: [edge(FLOW, OBJ, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
    };
    expect(interpret(reentry(), slice, COMPLETE, FLOW)).toEqual([]);
  });

  it('takes the weakest confidence — a heuristic ($Record-resolved) DML edge drags it down', () => {
    const slice: GroundedSlice = {
      nodes: [activeFlow()],
      edges: [edge(FLOW, OBJ, 'writesTo', 'heuristic', { operation: 'recordUpdate' })],
    };
    const out = interpret(reentry(), slice, COMPLETE, FLOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('notEqual relation fires on the cross-object DML instead', () => {
    const rule: ConceptRule = {
      ...reentry(),
      bind: {
        componentTypes: ['Flow'],
        propertyEqualsEndpoint: {
          nodeProperty: 'triggerObject',
          endpointEdgeType: 'writesTo',
          relation: 'notEqual',
          endpointEdgeWhereProperty: {
            key: 'operation',
            in: ['recordCreate', 'recordUpdate', 'recordDelete'],
          },
        },
      },
    };
    const slice: GroundedSlice = {
      nodes: [activeFlow()],
      edges: [edge(FLOW, OTHER, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
    };
    const out = interpret(rule, slice, COMPLETE, FLOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FLOW, OTHER]);
  });
});

describe('interpret — coupled-field-write JOIN', () => {
  // Real-shape ids: object segment parses out of `Type:Object.…`.
  const FIRER = 'WorkflowRule:Obj__c.Gate_Rule';
  const CC = 'ConditionalContext:WorkflowRule:Obj__c.Gate_Rule.condition-0';
  const GATED_FIELD = 'CustomField:Obj__c.Status__c'; // X, same object as F
  const CROSS_FIELD = 'CustomField:Other__c.Status__c'; // X on a DIFFERENT object
  const WRITER = 'Flow:Obj_Writer'; // W (another automation)

  /** The shipped join rule's shape (org-agnostic; no component ids). */
  const joinRule = (maxConfidence: ConfidenceLevel = 'parsed'): ConceptRule => ({
    id: 'rule:automation/coupled-field-write',
    concept: 'automation-collision',
    bind: {
      edgeType: 'firesWhen',
      componentTypes: [
        'WorkflowRule',
        'ValidationRule',
        'ApprovalProcess',
        'AutoResponseRule',
        'AssignmentRule',
        'EscalationRule',
        'Flow',
      ],
      join: {
        throughType: 'ConditionalContext',
        throughConditionKinds: ['criteria', 'formula', 'flow-recordtrigger'],
        throughKeyArray: 'fieldRefs',
        writeEdgeType: 'writesTo',
        writerTypes: ['Flow', 'ApexTrigger', 'ApexClass', 'WorkflowRule', 'ApprovalProcess'],
        sameObject: true,
        excludeSelf: true,
      },
    },
    interpretation:
      "Automation {0}'s firing condition tests {1}, which automation {2} also writes — so {0} may be reacting to a value another automation computed, not your direct edit. Confirm the save order with order_of_execution.",
    maxConfidence,
    absenceShaped: false,
    dependsOnCoverage: ['Flow', 'ApexTrigger', 'WorkflowRule'],
  });

  const cc = (fieldRefs: readonly string[], kind = 'criteria'): Node =>
    node(CC, 'ConditionalContext', { kind, fieldRefs });

  it('fires on a coupled write, citing EXACTLY [F, X, W] in that order', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FIRER, 'WorkflowRule'),
        cc([GATED_FIELD]),
        node(GATED_FIELD, 'CustomField'),
        node(WRITER, 'Flow'),
      ],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(WRITER, GATED_FIELD, 'writesTo', 'parsed'),
      ],
    };

    const out = interpret(joinRule(), slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.groundedIn).toEqual([FIRER, GATED_FIELD, WRITER]);
    // {0} F, {1} X, {2} W filled positionally.
    expect(only.claim).toContain(FIRER);
    expect(only.claim).toContain(GATED_FIELD);
    expect(only.claim).toContain(WRITER);
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.coverageCaveat).toBeNull();
  });

  // #8 — root scoping of the JOIN branch (symmetry with FIX 1). The coupled-write
  // rule is FIRER-anchored: a firesWhen via-edge counts only when its firer IS the
  // queried root, so a coupling can never fire on a NON-firer anchor (e.g. a
  // ConditionalContext) whose incident firesWhen edge belongs to another firer.
  it('[FIX 1 join branch] fires when the root IS the firer, stays silent on a non-firer (ConditionalContext) anchor, scans all with no rootId', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FIRER, 'WorkflowRule'),
        cc([GATED_FIELD]),
        node(GATED_FIELD, 'CustomField'),
        node(WRITER, 'Flow'),
      ],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(WRITER, GATED_FIELD, 'writesTo', 'parsed'),
      ],
    };
    // Root IS the firer → the coupling fires (the shipped, intended shape).
    expect(interpret(joinRule(), slice, COMPLETE, FIRER)).toHaveLength(1);
    // Root is the ConditionalContext (a NON-firer that the firesWhen edge points
    // AT) → root-scoped out, no fire — the anchor does not own the coupling.
    expect(interpret(joinRule(), slice, COMPLETE, CC)).toEqual([]);
    // No rootId (raw-predicate unit tests) → scan-all, the pre-fix behavior.
    expect(interpret(joinRule(), slice, COMPLETE)).toHaveLength(1);
  });

  it("[FIX 3] the SHIPPED coupled-field-write rule renders a phase-AGNOSTIC claim (order_of_execution, no phase wording)", () => {
    // Run the SHIPPED rule from CONCEPT_RULES — NOT an inline rule the test
    // defines — so a phase-order regression in the REAL interpretation string is
    // caught here (a tautological test over a local rule would not notice it).
    const shipped = CONCEPT_RULES.find((r) => r.id === 'rule:automation/coupled-field-write');
    expect(shipped, 'shipped rule:automation/coupled-field-write must exist').toBeDefined();

    const slice: GroundedSlice = {
      nodes: [node(FIRER, 'WorkflowRule'), cc([GATED_FIELD]), node(GATED_FIELD, 'CustomField'), node(WRITER, 'Flow')],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(WRITER, GATED_FIELD, 'writesTo', 'parsed'),
      ],
    };

    const out = interpret(shipped!, slice, COMPLETE, FIRER);
    expect(out).toHaveLength(1);
    const claim = out[0]!.claim;

    // Directs the reader to the order-of-execution tools …
    expect(claim).toContain('order_of_execution');
    // … but asserts NO phase ordering itself (the offline vault cannot ground it).
    expect(claim).not.toMatch(/\bphase\b|precede|before the (read|gate|check)|runs first/i);
    // The hedged coupling wording is present, NOT a definitive claim.
    expect(claim.toLowerCase()).toContain('may be reacting');
  });

  // ── RM-loop PASS 2 — phase-derivation upgrade ────────────────────────────
  // The SHIPPED rule (with `interpretationCrossPhase`) is used so the REAL
  // upgrade template is exercised. A record-triggered before-save Flow writer
  // (before-save-flows) writing a field a ValidationRule (pre-save-validation)
  // gates on is the canonical provable cross-phase computed gate.
  const shippedJoinRule = (): ConceptRule => {
    const r = CONCEPT_RULES.find((x) => x.id === 'rule:automation/coupled-field-write');
    expect(r, 'shipped rule:automation/coupled-field-write must exist').toBeDefined();
    return r!;
  };
  const VR_FIRER = 'ValidationRule:Obj__c.Status_Gate'; // F, object Obj__c, pre-save-validation
  const VR_CC = 'ConditionalContext:ValidationRule:Obj__c.Status_Gate.condition-0';
  const BEFORE_FLOW_WRITER = 'Flow:StatusComputer'; // W, before-save flow (before-save-flows)
  const WRITER_OBJ = 'CustomObject:Obj__c'; // W's triggersOn target (carries triggerType)

  it('[PASS 2] UPGRADES to a strict cross-phase claim when a before-save-flow writer feeds a validation-rule firer', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(VR_FIRER, 'ValidationRule'),
        node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(BEFORE_FLOW_WRITER, 'Flow'),
      ],
      edges: [
        edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(BEFORE_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        // The writer's before-save timing lives on ITS triggersOn edge.
        edge(BEFORE_FLOW_WRITER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
      ],
    };

    const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
    expect(out).toHaveLength(1);
    const claim = out[0]!.claim;
    // The UPGRADED wording: strictly earlier, naming both save-order phases.
    expect(claim).toContain('EARLIER save-order phase');
    // FIX 2 (HIGH) — assert the ORDERED phase phrase as a CONTIGUOUS substring so
    // a swapped writerPhase/firerPhase fill FAILS. An order-agnostic pair of
    // separate `.toContain('before-save-flows')` / `.toContain('pre-save-validation')`
    // would pass a REVERSED "(pre-save-validation before before-save-flows)" claim.
    expect(claim).toContain('before-save-flows before pre-save-validation');
    expect(claim).toContain('order_of_execution');
    // FIX 1 (crux) — the causation is CONDITIONED on the writer running, NOT the
    // old absolute "{0} IS reacting to the value {2} computed, not your direct edit".
    expect(claim).toContain('On saves where');
    expect(claim).not.toMatch(/is reacting to the value/i);
    // NOT the hedged coupling wording — the order is now proven.
    expect(claim.toLowerCase()).not.toContain('may be reacting');
    // Still cites EXACTLY [F, X, W]; phase derivation adds no ground.
    expect(out[0]!.groundedIn).toEqual([VR_FIRER, GATED_FIELD, BEFORE_FLOW_WRITER]);
    // Phase derivation adds no edge, so confidence is unchanged (weakest = parsed).
    expect(out[0]!.confidence).toBe('parsed');
  });

  it('[PASS 2] keeps the COUPLING claim when the writer phase is UNKNOWN (an ApexClass writer has no phase)', () => {
    const APEX_WRITER = 'ApexClass:ObjWriter';
    const slice: GroundedSlice = {
      nodes: [
        node(VR_FIRER, 'ValidationRule'),
        node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(APEX_WRITER, 'ApexClass'),
      ],
      edges: [
        edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(APEX_WRITER, GATED_FIELD, 'writesTo', 'heuristic'),
      ],
    };

    const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
    expect(out).toHaveLength(1);
    const claim = out[0]!.claim;
    // The honest coupling wording — no provable order.
    expect(claim.toLowerCase()).toContain('may be reacting');
    expect(claim).toContain('order_of_execution');
    expect(claim).not.toContain('EARLIER');
    expect(claim).not.toMatch(/save-order phase/);
  });

  it('[PASS 2] keeps the COUPLING claim on REVERSE order (an after-save-flow writer feeding a validation-rule firer)', () => {
    // W runs post-save-flows (ordinal 7), F runs pre-save-validation (ordinal 2):
    // the writer is LATER, so this is NOT a cross-phase computed gate.
    const AFTER_FLOW_WRITER = 'Flow:LateComputer';
    const slice: GroundedSlice = {
      nodes: [
        node(VR_FIRER, 'ValidationRule'),
        node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(AFTER_FLOW_WRITER, 'Flow'),
      ],
      edges: [
        edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(AFTER_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        edge(AFTER_FLOW_WRITER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
      ],
    };

    const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
    expect(out).toHaveLength(1);
    const claim = out[0]!.claim;
    expect(claim.toLowerCase()).toContain('may be reacting');
    expect(claim).not.toContain('EARLIER');
  });

  it('[PASS 2/FIX 1] does NOT upgrade an ApprovalProcess FIRER even with an earlier-phase writer (approval is not a synchronous save step)', () => {
    // The crux over-claim: a post-save Flow writes the gated field ON A SAVE, but
    // the approval's entry criteria evaluate on a separate SUBMIT action — the two
    // never co-fire, so "the approval IS reacting to the value the flow computed"
    // is false. ordinal(before-save-flows)=0 < ordinal(post-save-approval)=8, so
    // WITHOUT the synchronous-firer gate this would (wrongly) upgrade; the gate
    // keeps the honest coupling wording. (33 of 47 real-vault upgrades were
    // exactly this over-claim.)
    const APPROVAL_FIRER = 'ApprovalProcess:Obj__c.Status_Approval'; // F, post-save-approval
    const APPROVAL_CC = 'ConditionalContext:ApprovalProcess:Obj__c.Status_Approval.condition-0';
    const slice: GroundedSlice = {
      nodes: [
        node(APPROVAL_FIRER, 'ApprovalProcess'),
        node(APPROVAL_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(BEFORE_FLOW_WRITER, 'Flow'),
      ],
      edges: [
        edge(APPROVAL_FIRER, APPROVAL_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(BEFORE_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        edge(BEFORE_FLOW_WRITER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
      ],
    };

    const out = interpret(shippedJoinRule(), slice, COMPLETE, APPROVAL_FIRER);
    expect(out).toHaveLength(1);
    const claim = out[0]!.claim;
    // The honest coupling wording — the ordering is NOT asserted for an approval.
    expect(claim.toLowerCase()).toContain('may be reacting');
    expect(claim).not.toContain('EARLIER');
    expect(claim).not.toMatch(/save-order phase/);
  });

  it('[PASS 2/guard] does NOT upgrade an EQUAL-phase coupling (two before-save flows on one field) — guards the strict `<`', () => {
    // W and F are BOTH before-save flows (ordinal 0): ordinal(W) === ordinal(F),
    // so the strict `<` denies the upgrade. A `<`→`<=` mutation would (wrongly)
    // upgrade this equal-phase coupling, so this test pins the strict inequality.
    const BEFORE_FLOW_FIRER = 'Flow:BeforeGate'; // F, before-save-flows (via triggersOn)
    const BEFORE_FLOW_CC = 'ConditionalContext:Flow:BeforeGate.start';
    const OTHER_BEFORE_WRITER = 'Flow:BeforeWriter'; // W, also before-save-flows
    const slice: GroundedSlice = {
      nodes: [
        node(BEFORE_FLOW_FIRER, 'Flow'),
        node(BEFORE_FLOW_CC, 'ConditionalContext', { kind: 'flow-recordtrigger', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(OTHER_BEFORE_WRITER, 'Flow'),
      ],
      edges: [
        edge(BEFORE_FLOW_FIRER, BEFORE_FLOW_CC, 'firesWhen', 'declared', { kind: 'flow-recordtrigger' }),
        // The FIRER's own before-save timing (so it places as before-save-flows)
        // AND its object (a Flow id has no object segment) both come off this edge.
        edge(BEFORE_FLOW_FIRER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
        edge(OTHER_BEFORE_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        // The WRITER is ALSO a before-save flow → same ordinal as the firer.
        edge(OTHER_BEFORE_WRITER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
      ],
    };

    const out = interpret(shippedJoinRule(), slice, COMPLETE, BEFORE_FLOW_FIRER);
    expect(out).toHaveLength(1);
    const claim = out[0]!.claim;
    expect(claim.toLowerCase()).toContain('may be reacting');
    expect(claim).not.toContain('EARLIER');
    expect(claim).not.toMatch(/save-order phase/);
  });

  it('[PASS 2] a rule WITHOUT interpretationCrossPhase keeps coupling even on a provable cross-phase coupling', () => {
    // The LOCAL joinRule() has NO interpretationCrossPhase; even though the engine
    // proves the cross-phase (before-save flow → validation rule), it falls back
    // to the coupling template — the upgrade is opt-in per rule.
    const slice: GroundedSlice = {
      nodes: [
        node(VR_FIRER, 'ValidationRule'),
        node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
        node(GATED_FIELD, 'CustomField'),
        node(BEFORE_FLOW_WRITER, 'Flow'),
      ],
      edges: [
        edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
        edge(BEFORE_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        edge(BEFORE_FLOW_WRITER, WRITER_OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
      ],
    };
    const out = interpret(joinRule(), slice, COMPLETE, VR_FIRER);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('may');
    expect(out[0]!.claim).not.toContain('EARLIER');
  });

  it('does NOT fire when the ONLY writer of the gated field is the firer itself (W ≠ F enforced)', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIRER, 'WorkflowRule'), cc([GATED_FIELD]), node(GATED_FIELD, 'CustomField')],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        // The firer both gates on and writes X — a self-write, not a coupling.
        edge(FIRER, GATED_FIELD, 'writesTo', 'parsed'),
      ],
    };

    expect(interpret(joinRule(), slice, COMPLETE)).toEqual([]);
  });

  it('does NOT fire when no writer touches any gated field', () => {
    const OTHER_FIELD = 'CustomField:Obj__c.Other__c';
    const slice: GroundedSlice = {
      nodes: [
        node(FIRER, 'WorkflowRule'),
        cc([GATED_FIELD]),
        node(GATED_FIELD, 'CustomField'),
        node(OTHER_FIELD, 'CustomField'),
        node(WRITER, 'Flow'),
      ],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        // The writer writes a DIFFERENT field than the one gated on.
        edge(WRITER, OTHER_FIELD, 'writesTo', 'parsed'),
      ],
    };

    expect(interpret(joinRule(), slice, COMPLETE)).toEqual([]);
  });

  it('confidence = weakest across the joined edges: a heuristic (Apex) writesTo → heuristic', () => {
    const APEX_WRITER = 'ApexClass:ObjWriter';
    const slice: GroundedSlice = {
      nodes: [node(FIRER, 'WorkflowRule'), cc([GATED_FIELD]), node(GATED_FIELD, 'CustomField'), node(APEX_WRITER, 'ApexClass')],
      edges: [
        // A declared firesWhen + a heuristic writesTo — under a `parsed` ceiling.
        edge(FIRER, CC, 'firesWhen', 'declared'),
        edge(APEX_WRITER, GATED_FIELD, 'writesTo', 'heuristic'),
      ],
    };

    const out = interpret(joinRule('parsed'), slice, COMPLETE);
    expect(out).toHaveLength(1);
    // weakest(parsed, declared, heuristic) === 'heuristic'.
    expect(out[0]!.confidence).toBe('heuristic');
    expect(out[0]!.confidence).not.toBe('parsed');
  });

  it('caps confidence at the rule ceiling: declared edges under a parsed ceiling → parsed', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIRER, 'WorkflowRule'), cc([GATED_FIELD]), node(GATED_FIELD, 'CustomField'), node(WRITER, 'Flow')],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        edge(WRITER, GATED_FIELD, 'writesTo', 'declared'),
      ],
    };
    // weakest(parsed, declared, declared) === 'parsed' — the ceiling holds.
    expect(interpret(joinRule('parsed'), slice, COMPLETE)[0]!.confidence).toBe('parsed');
  });

  it('same-object scope EXCLUDES a cross-object gated field (object(F) ≠ object(X))', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FIRER, 'WorkflowRule'), // object Obj__c
        cc([CROSS_FIELD]), // gates on a field of Other__c
        node(CROSS_FIELD, 'CustomField'),
        node(WRITER, 'Flow'),
      ],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        edge(WRITER, CROSS_FIELD, 'writesTo', 'parsed'),
      ],
    };

    expect(interpret(joinRule(), slice, COMPLETE)).toEqual([]);
  });

  it('excludes a non-firing-gate condition kind (flow-decision) via throughConditionKinds', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIRER, 'Flow'), cc([GATED_FIELD], 'flow-decision'), node(GATED_FIELD, 'CustomField'), node(WRITER, 'Flow')],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        edge(WRITER, GATED_FIELD, 'writesTo', 'parsed'),
      ],
    };
    // The mid-flow decision kind is not in throughConditionKinds → no coupling.
    expect(interpret(joinRule(), slice, COMPLETE)).toEqual([]);
  });

  it('never cites an unresolved writer (writesTo edge whose W node is absent from the slice)', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIRER, 'WorkflowRule'), cc([GATED_FIELD]), node(GATED_FIELD, 'CustomField')], // WRITER node omitted
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        edge(WRITER, GATED_FIELD, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(joinRule(), slice, COMPLETE)).toEqual([]);
  });

  it('[FIX 3] drops a coupling whose gated FIELD (X) node is absent from the slice (X-drop branch)', () => {
    // Complements the dangling-W test above: here the writesTo witness resolves
    // but the gated field X node itself is NOT in the slice → the coupling is
    // dropped (an unresolved shared key is never cited).
    const slice: GroundedSlice = {
      nodes: [node(FIRER, 'WorkflowRule'), cc([GATED_FIELD]), node(WRITER, 'Flow')], // GATED_FIELD (X) node omitted
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        edge(WRITER, GATED_FIELD, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(joinRule(), slice, COMPLETE)).toEqual([]);
  });

  it('[FIX 3/FIX 4] a DUPLICATE (F, X, W) witness → exactly ONE interpretation, at the WEAKEST witness confidence', () => {
    // The same writer writes the same gated field via TWO writesTo edges of
    // DIFFERING confidence (e.g. two DML elements). Dedup emits the coupling
    // ONCE, and FIX 4 keeps the WEAKEST confidence across the witnesses — not
    // whichever edge was seen first.
    const slice: GroundedSlice = {
      nodes: [node(FIRER, 'WorkflowRule'), cc([GATED_FIELD]), node(GATED_FIELD, 'CustomField'), node(WRITER, 'Flow')],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        edge(WRITER, GATED_FIELD, 'writesTo', 'declared'), // strong witness, seen FIRST
        edge(WRITER, GATED_FIELD, 'writesTo', 'heuristic'), // weak witness, same (F, X, W)
      ],
    };

    const out = interpret(joinRule('parsed'), slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FIRER, GATED_FIELD, WRITER]);
    // First-seen would keep 'declared' → weakest(parsed, declared) = parsed;
    // FIX 4 keeps the weakest witness → weakest(parsed, …, heuristic) = heuristic.
    expect(out[0]!.confidence).toBe('heuristic');
    expect(out[0]!.confidence).not.toBe('parsed');
  });

  it('[FIX 2] a Flow firer (object-less id) couples via its triggersOn edge on a same-object gated field', () => {
    // A record-triggered Flow id (`Flow:{ApiName}`) has NO object segment, so the
    // firer's object is derived from `Flow --triggersOn--> CustomObject:Deal__c`.
    // Then object(F) = Deal__c === object(X) and the coupling fires.
    const FLOW_FIRER = 'Flow:RecordTriggeredGate';
    const FLOW_CC = 'ConditionalContext:Flow:RecordTriggeredGate.start';
    const FLOW_OBJECT = 'CustomObject:Deal__c';
    const FLOW_GATED = 'CustomField:Deal__c.Status__c'; // same object as the triggersOn target
    const APEX_WRITER = 'ApexClass:DealWriter';
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW_FIRER, 'Flow'),
        node(FLOW_CC, 'ConditionalContext', { kind: 'flow-recordtrigger', fieldRefs: [FLOW_GATED] }),
        node(FLOW_GATED, 'CustomField'),
        node(FLOW_OBJECT, 'CustomObject'),
        node(APEX_WRITER, 'ApexClass'),
      ],
      edges: [
        edge(FLOW_FIRER, FLOW_CC, 'firesWhen', 'declared', { kind: 'flow-recordtrigger' }),
        edge(FLOW_FIRER, FLOW_OBJECT, 'triggersOn', 'declared'),
        edge(APEX_WRITER, FLOW_GATED, 'writesTo', 'parsed'),
      ],
    };

    const out = interpret(joinRule(), slice, COMPLETE, FLOW_FIRER);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FLOW_FIRER, FLOW_GATED, APEX_WRITER]);
  });

  it('[FIX 2] a Flow firer with NO resolvable triggersOn object is EXCLUDED (never guessed same-object)', () => {
    const FLOW_FIRER = 'Flow:NoObjectGate';
    const FLOW_CC = 'ConditionalContext:Flow:NoObjectGate.start';
    const FLOW_GATED = 'CustomField:Deal__c.Status__c';
    const APEX_WRITER = 'ApexClass:DealWriter';
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW_FIRER, 'Flow'),
        node(FLOW_CC, 'ConditionalContext', { kind: 'flow-recordtrigger', fieldRefs: [FLOW_GATED] }),
        node(FLOW_GATED, 'CustomField'),
        node(APEX_WRITER, 'ApexClass'),
      ],
      edges: [
        edge(FLOW_FIRER, FLOW_CC, 'firesWhen', 'declared', { kind: 'flow-recordtrigger' }),
        // NO triggersOn edge → object(F) is unresolvable → the coupling is excluded.
        edge(APEX_WRITER, FLOW_GATED, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(joinRule(), slice, COMPLETE, FLOW_FIRER)).toEqual([]);
  });

  it('emits ONE interpretation per (F, X, W) — two distinct writers of the same gated field → two, sorted', () => {
    const WRITER_A = 'Flow:AaWriter';
    const WRITER_B = 'Flow:ZzWriter';
    const slice: GroundedSlice = {
      nodes: [
        node(FIRER, 'WorkflowRule'),
        cc([GATED_FIELD]),
        node(GATED_FIELD, 'CustomField'),
        node(WRITER_A, 'Flow'),
        node(WRITER_B, 'Flow'),
      ],
      edges: [
        edge(FIRER, CC, 'firesWhen', 'declared'),
        edge(WRITER_B, GATED_FIELD, 'writesTo', 'parsed'),
        edge(WRITER_A, GATED_FIELD, 'writesTo', 'parsed'),
      ],
    };

    const out = interpret(joinRule(), slice, COMPLETE);
    expect(out).toHaveLength(2);
    // Deterministic (firer, field, writer) sort → WRITER_A before WRITER_B.
    expect(out.map((i) => i.groundedIn[2])).toEqual([WRITER_A, WRITER_B]);
  });

  it('leaves single-predicate (non-join) rules unchanged — a writesTo rule still cites both endpoints', () => {
    // Guard: the join branch must not perturb the scalar path. Reuse the plain
    // `writesTo` edge predicate and confirm classic behavior survives.
    const plainRule: ConceptRule = {
      id: 'rule-writes-plain',
      concept: 'field-provenance',
      bind: { edgeType: 'writesTo' },
      interpretation: 'writers: {ids}',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['ApexClass'],
    };
    const slice: GroundedSlice = {
      nodes: [node(WRITER, 'Flow'), node(GATED_FIELD, 'CustomField')],
      edges: [edge(WRITER, GATED_FIELD, 'writesTo', 'declared')],
    };
    const out = interpret(plainRule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([WRITER, GATED_FIELD]);
  });

  // ── P1-A REASONING-COUPLED-FIELD-WRITE-DEAD-PLANE ────────────────────────
  // The SHIPPED rule now carries `excludeInactiveFirer` + `excludeTestWriter`
  // join gates: an INACTIVE firer owns no live coupling (a dead gate does not
  // fire), and a TEST-class Apex writer never establishes a PRODUCTION write
  // path. Both must be dropped so a dead / test plane is never conflated into a
  // live production coupling. These use the SHIPPED rule (shippedJoinRule) so the
  // REAL config is exercised. Cases (a) + (b) FAIL on HEAD bbf82f8 pre-fix — the
  // pre-guard join emits the coupling regardless of firer liveness / writer isTest.
  describe('[P1-A] dead-plane join gates (excludeInactiveFirer / excludeTestWriter / excludeInactiveWriter)', () => {
    const APEX_TEST_WRITER = 'ApexClass:Ns__StatusWriterTest'; // isTest → excluded
    const APEX_PROD_WRITER = 'ApexClass:Ns__StatusWriter'; // production writer
    const OBSOLETE_FLOW_WRITER = 'Flow:Ns__StatusWriter_Obsolete'; // status Obsolete → excluded
    const DRAFT_FLOW_WRITER = 'Flow:Ns__StatusWriter_Draft'; // status Draft → excluded
    const ACTIVE_FLOW_WRITER = 'Flow:Ns__StatusWriter_Active'; // status Active → kept

    it('the shipped rule carries all three dead-plane join gates', () => {
      const join = shippedJoinRule().bind.join;
      expect(join, 'shipped coupled-field-write must carry a join').toBeDefined();
      expect(join!.excludeInactiveFirer).toBe(true);
      expect(join!.excludeTestWriter).toBe(true);
      expect(join!.excludeInactiveWriter).toBe(true);
    });

    it('(a) an INACTIVE ValidationRule firer + an ACTIVE writer → NO coupling (dead gate never cited) [FAILS pre-fix]', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: false }), // provably inactive gate
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(WRITER, 'Flow'), // an active production writer
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        ],
      };
      expect(interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER)).toEqual([]);
    });

    it('(a-control) the SAME shape with an ACTIVE firer DOES fire (only liveness changed)', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(WRITER, 'Flow'),
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        ],
      };
      const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
      expect(out).toHaveLength(1);
      expect(out[0]!.groundedIn).toEqual([VR_FIRER, GATED_FIELD, WRITER]);
    });

    it('(b) an ACTIVE firer + a TEST-class (isTest) Apex writer → NO coupling (test plane excluded) [FAILS pre-fix]', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(APEX_TEST_WRITER, 'ApexClass', { isTest: true }),
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(APEX_TEST_WRITER, GATED_FIELD, 'writesTo', 'heuristic'),
        ],
      };
      expect(interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER)).toEqual([]);
    });

    it('(b-mixed) an ACTIVE firer + BOTH a test writer AND a production writer → couples ONLY the production writer', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(APEX_TEST_WRITER, 'ApexClass', { isTest: true }),
          node(APEX_PROD_WRITER, 'ApexClass', { isTest: false }),
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(APEX_TEST_WRITER, GATED_FIELD, 'writesTo', 'heuristic'),
          edge(APEX_PROD_WRITER, GATED_FIELD, 'writesTo', 'heuristic'),
        ],
      };
      const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
      expect(out).toHaveLength(1);
      expect(out[0]!.groundedIn).toEqual([VR_FIRER, GATED_FIELD, APEX_PROD_WRITER]);
      expect(out[0]!.groundedIn).not.toContain(APEX_TEST_WRITER);
    });

    it('(c) an ACTIVE firer + a PRODUCTION (non-test) writer is UNCHANGED (fires, confidence intact)', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(APEX_PROD_WRITER, 'ApexClass', { isTest: false }),
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(APEX_PROD_WRITER, GATED_FIELD, 'writesTo', 'heuristic'),
        ],
      };
      const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
      expect(out).toHaveLength(1);
      expect(out[0]!.groundedIn).toEqual([VR_FIRER, GATED_FIELD, APEX_PROD_WRITER]);
      // weakest(parsed ceiling, heuristic writesTo) — the gate never touches confidence.
      expect(out[0]!.confidence).toBe('heuristic');
    });

    // ── excludeInactiveWriter (the residual: Obsolete/Draft/Inactive Flow WRITER) ──
    // The writer-side twin of the firer gate. `excludeTestWriter` catches an
    // `isTest` Apex writer but an Obsolete Flow carries NO isTest, so it slipped
    // through and was still cited as a live "also writes". This gate closes it.
    it('(d) an ACTIVE firer + an OBSOLETE-only Flow writer → NO coupling (dead writer plane excluded) [FAILS pre-fix]', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(OBSOLETE_FLOW_WRITER, 'Flow', { status: 'Obsolete' }), // provably-dead writer
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(OBSOLETE_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        ],
      };
      expect(interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER)).toEqual([]);
    });

    it('(d) an ACTIVE firer + a DRAFT-only Flow writer → NO coupling (dead writer plane excluded) [FAILS pre-fix]', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(DRAFT_FLOW_WRITER, 'Flow', { status: 'Draft' }),
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(DRAFT_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        ],
      };
      expect(interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER)).toEqual([]);
    });

    it('(d-control) an ACTIVE firer + an ACTIVE Flow writer is UNCHANGED (fires — only writer status changed)', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(ACTIVE_FLOW_WRITER, 'Flow', { status: 'Active' }),
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(ACTIVE_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        ],
      };
      const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
      expect(out).toHaveLength(1);
      expect(out[0]!.groundedIn).toEqual([VR_FIRER, GATED_FIELD, ACTIVE_FLOW_WRITER]);
    });

    it('(d-mixed) an ACTIVE firer + BOTH an Obsolete AND an Active Flow writer → couples ONLY the active writer', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(OBSOLETE_FLOW_WRITER, 'Flow', { status: 'Obsolete' }),
          node(ACTIVE_FLOW_WRITER, 'Flow', { status: 'Active' }),
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(OBSOLETE_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
          edge(ACTIVE_FLOW_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        ],
      };
      const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
      expect(out).toHaveLength(1);
      expect(out[0]!.groundedIn).toEqual([VR_FIRER, GATED_FIELD, ACTIVE_FLOW_WRITER]);
      expect(out[0]!.groundedIn).not.toContain(OBSOLETE_FLOW_WRITER);
    });

    it('(d-status-less) an ACTIVE firer + a status-less ApexTrigger writer is KEPT (only PROVABLY-inactive writers drop)', () => {
      // The gate reuses `isActiveSoeFirer`, whose conservative prior keeps a
      // writer with no resolvable status. A production writer must NOT be dropped.
      const APEX_TRIGGER_WRITER = 'ApexTrigger:Ns__StatusWriterTrigger';
      const slice: GroundedSlice = {
        nodes: [
          node(VR_FIRER, 'ValidationRule', { active: true }),
          node(VR_CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED_FIELD] }),
          node(GATED_FIELD, 'CustomField'),
          node(APEX_TRIGGER_WRITER, 'ApexTrigger'), // no status ⇒ active prior
        ],
        edges: [
          edge(VR_FIRER, VR_CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(APEX_TRIGGER_WRITER, GATED_FIELD, 'writesTo', 'parsed'),
        ],
      };
      const out = interpret(shippedJoinRule(), slice, COMPLETE, VR_FIRER);
      expect(out).toHaveLength(1);
      expect(out[0]!.groundedIn).toEqual([VR_FIRER, GATED_FIELD, APEX_TRIGGER_WRITER]);
    });
  });
});

// ---------------------------------------------------------------------------
// P1-B REASONING-STATUS-CODE-CITES-INACTIVE-AUTOMATION — the status-code
// cross-ref rule now carries an `inactive-firer` witness partition: it classifies
// each incoming `triggersOn` firer (the edge's `from`) by the shared SOE liveness
// predicate. A Draft/Obsolete Flow or Inactive trigger is EXCLUDED from the
// "could have aborted" claim; a status-less/always-live firer (an ApexClass) is
// KEPT. ACTIVE-ONLY ⇒ the base claim (byte-identical); MIXED ⇒ active-only claim +
// inactive disclosure; ALL-INACTIVE ⇒ the no-active-automation disclosure. Uses
// the SHIPPED rule so the REAL config is exercised. The MIXED + ALL-INACTIVE cases
// FAIL on HEAD bbf82f8 pre-fix (the pre-guard scalar path cites every firer).
// ---------------------------------------------------------------------------

describe('[P1-B] status-code cross-ref — inactive-firer witness partition', () => {
  const OBJ = 'CustomObject:Ns__Ord__c';
  const ACTIVE_FLOW = 'Flow:Ns__Ord_Active';
  const OBSOLETE_FLOW = 'Flow:Ns__Ord_Obsolete';
  const DRAFT_FLOW = 'Flow:Ns__Ord_Draft';
  const INACTIVE_TRIGGER = 'ApexTrigger:Ns__Ord_Legacy';
  const APEX_FIRER = 'ApexClass:Ns__Ord_InvocableSaver'; // status-less → always live

  const shippedStatusRule = (): ConceptRule => {
    const r = CONCEPT_RULES.find((x) => x.id === 'rule:status-code/cross-ref-automation');
    expect(r, 'shipped rule:status-code/cross-ref-automation must exist').toBeDefined();
    return r!;
  };

  it('the shipped rule carries the inactive-firer witness partition (from-firer, no witnessProperty)', () => {
    const wp = shippedStatusRule().witnessPartition;
    expect(wp).toBeDefined();
    expect(wp!.roleEndpoint).toBe('from');
    expect(wp!.witnessKind).toBe('inactive-firer');
    expect(wp!.witnessProperty).toBeUndefined();
  });

  it('ACTIVE-ONLY — an Active Flow + a status-less ApexClass firer → the base claim over BOTH, no disclosure (byte-identical)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        node(ACTIVE_FLOW, 'Flow', { status: 'Active' }),
        node(APEX_FIRER, 'ApexClass'), // no status → conservatively live
      ],
      edges: [
        edge(ACTIVE_FLOW, OBJ, 'triggersOn', 'declared'),
        edge(APEX_FIRER, OBJ, 'triggersOn', 'declared'),
      ],
    };
    const out = interpret(shippedStatusRule(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect([...out[0]!.groundedIn].sort()).toEqual([ACTIVE_FLOW, APEX_FIRER].sort());
    expect(out[0]!.claim).toContain('could have aborted the save; verify which ran');
    expect(out[0]!.claim).not.toContain('INACTIVE');
  });

  it('MIXED — an Active + an Obsolete Flow → cites ONLY the active, DISCLOSES the excluded inactive [FAILS pre-fix]', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        node(ACTIVE_FLOW, 'Flow', { status: 'Active' }),
        node(OBSOLETE_FLOW, 'Flow', { status: 'Obsolete' }),
      ],
      edges: [
        edge(ACTIVE_FLOW, OBJ, 'triggersOn', 'declared'),
        edge(OBSOLETE_FLOW, OBJ, 'triggersOn', 'declared'),
      ],
    };
    const out = interpret(shippedStatusRule(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    // Only the ACTIVE flow is a grounded save-abort suspect.
    expect(only.groundedIn).toEqual([ACTIVE_FLOW]);
    expect(only.groundedIn).not.toContain(OBSOLETE_FLOW);
    // The base claim still holds for the active firer, and the obsolete one is
    // DISCLOSED as excluded (never a suspect).
    expect(only.claim).toContain('could have aborted the save; verify which ran');
    expect(only.claim).toContain('Excluded as INACTIVE');
    expect(only.claim).toContain(OBSOLETE_FLOW);
  });

  it('ALL-INACTIVE — a Draft Flow + an Inactive trigger → the no-active-automation disclosure, NOT a production abort claim [FAILS pre-fix]', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        node(DRAFT_FLOW, 'Flow', { status: 'Draft' }),
        node(INACTIVE_TRIGGER, 'ApexTrigger', { status: 'Inactive' }),
      ],
      edges: [
        edge(DRAFT_FLOW, OBJ, 'triggersOn', 'declared'),
        edge(INACTIVE_TRIGGER, OBJ, 'triggersOn', 'declared'),
      ],
    };
    const out = interpret(shippedStatusRule(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    // The disclosure still cites the inactive firers, but refuses the "verify
    // which ran" production suspect claim.
    expect([...only.groundedIn].sort()).toEqual([DRAFT_FLOW, INACTIVE_TRIGGER].sort());
    expect(only.claim).toContain('None of the automation');
    expect(only.claim).toContain('currently ACTIVE');
    expect(only.claim).not.toContain('; verify which ran');
  });
});

// ---------------------------------------------------------------------------
// interpret — the AGGREGATE group-count predicate (RM-loop). For a root
// CustomObject, count its incoming `triggersOn` edges from ACTIVE record-
// triggered Flows, bucketed by the flow's exact TRIGGER CONTEXT — three DISJOINT
// buckets: before-save / after-save / before-delete (from the edge's
// `triggerType`). A before-delete flow runs only on the DELETE path and can never
// co-execute with a save-timing flow, so it never collides with one. Fire once
// per context carrying >= threshold ACTIVE flows. Synthetic slices match the
// real shape: a Flow `triggersOn`-> its CustomObject, context on the edge's
// `triggerType`, active on the Flow node's `status`.
// ---------------------------------------------------------------------------

describe('interpret — stacked-record-triggered-flows AGGREGATE', () => {
  const OBJ = 'CustomObject:Deal__c';
  const FLOW_A = 'Flow:Deal_Before_A';
  const FLOW_B = 'Flow:Deal_Before_B';
  const FLOW_C = 'Flow:Deal_After_C';
  const FLOW_D = 'Flow:Deal_After_D';

  /** The shipped aggregate rule's shape (org-agnostic; no component ids). */
  const aggRule = (maxConfidence: ConfidenceLevel = 'declared'): ConceptRule => ({
    id: 'rule:automation/stacked-record-triggered-flows',
    concept: 'automation-collision',
    bind: {
      edgeType: 'triggersOn',
      componentTypes: ['Flow'],
      aggregate: {
        groupByEdgeProperty: 'triggerType',
        endpointWhereProperty: { key: 'status', equals: 'Active' },
        op: 'gte',
        threshold: 2,
      },
    },
    interpretation:
      '{object} runs {count} active record-triggered flows in the same trigger context ({timing}): {ids}. Salesforce best practice is one record-triggered flow per object per {timing} context — multiple in one context run in an undefined order and are hard to maintain; consider consolidating. If this is a managed-package object you may not be able to change its automation.',
    maxConfidence,
    absenceShaped: false,
    dependsOnCoverage: ['Flow'],
  });

  const activeFlow = (id: string): Node => node(id, 'Flow', { status: 'Active' });
  const triggersOn = (
    flowId: string,
    triggerType: string | undefined,
    confidence: ConfidenceLevel = 'declared',
  ): Edge =>
    edge(flowId, OBJ, 'triggersOn', confidence, triggerType !== undefined ? { triggerType } : {});

  it('fires on 2 ACTIVE before-save record-triggered flows — cites both flows, discloses count 2, before timing', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), activeFlow(FLOW_B)],
      edges: [triggersOn(FLOW_A, 'RecordBeforeSave'), triggersOn(FLOW_B, 'RecordBeforeSave')],
    };

    const out = interpret(aggRule(), slice, COMPLETE, OBJ);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    // Cites the FLOWS (culprits) first; the object trails as context.
    expect(only.groundedIn).toEqual([FLOW_A, FLOW_B, OBJ]);
    expect(only.claim).toContain(FLOW_A);
    expect(only.claim).toContain(FLOW_B);
    // Discloses the REAL count (self-disclosing severity).
    expect(only.claim).toContain('2 active record-triggered flows');
    expect(only.claim).toContain('before-save');
    expect(only.claim).toContain(OBJ);
    expect(only.confidence).toBe('declared');
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.coverageCaveat).toBeNull();
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire at a single active before-save flow (threshold gte 2)', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A)],
      edges: [triggersOn(FLOW_A, 'RecordBeforeSave')],
    };
    expect(interpret(aggRule(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[active filter] does NOT fire when one of two before-save flows is Obsolete (only 1 active) — proves endpointWhereProperty', () => {
    const OBSOLETE_FLOW = 'Flow:Deal_Before_Obsolete';
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        activeFlow(FLOW_A),
        node(OBSOLETE_FLOW, 'Flow', { status: 'Obsolete' }),
      ],
      edges: [
        triggersOn(FLOW_A, 'RecordBeforeSave'),
        triggersOn(OBSOLETE_FLOW, 'RecordBeforeSave'),
      ],
    };
    // Without the active filter both would count → a false "2 flows" cry-wolf.
    expect(interpret(aggRule(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[active filter] a status-LESS flow is NOT counted (strict status===Active) — never cries wolf on unknown status', () => {
    const NO_STATUS_FLOW = 'Flow:Deal_Before_NoStatus';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), node(NO_STATUS_FLOW, 'Flow', {})],
      edges: [triggersOn(FLOW_A, 'RecordBeforeSave'), triggersOn(NO_STATUS_FLOW, 'RecordBeforeSave')],
    };
    expect(interpret(aggRule(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[buckets] 1 before + 1 after → no fire (each timing bucket has a single flow)', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), activeFlow(FLOW_C)],
      edges: [triggersOn(FLOW_A, 'RecordBeforeSave'), triggersOn(FLOW_C, 'RecordAfterSave')],
    };
    expect(interpret(aggRule(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[buckets] 2 before + 1 after → fires ONLY on the before bucket', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        activeFlow(FLOW_A),
        activeFlow(FLOW_B),
        activeFlow(FLOW_C),
      ],
      edges: [
        triggersOn(FLOW_A, 'RecordBeforeSave'),
        triggersOn(FLOW_B, 'RecordBeforeSave'),
        triggersOn(FLOW_C, 'RecordAfterSave'),
      ],
    };
    const out = interpret(aggRule(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('before-save');
    expect(out[0]!.claim).not.toContain('after-save');
    expect(out[0]!.groundedIn).toEqual([FLOW_A, FLOW_B, OBJ]);
  });

  it('[buckets] 2 before + 2 after → TWO interpretations (before then after), each citing only its bucket', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        activeFlow(FLOW_A),
        activeFlow(FLOW_B),
        activeFlow(FLOW_C),
        activeFlow(FLOW_D),
      ],
      edges: [
        triggersOn(FLOW_A, 'RecordBeforeSave'),
        triggersOn(FLOW_B, 'RecordBeforeSave'),
        triggersOn(FLOW_C, 'RecordAfterSave'),
        triggersOn(FLOW_D, 'RecordAfterSave'),
      ],
    };
    const out = interpret(aggRule(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(2);
    // Deterministic order: the before bucket is emitted first.
    expect(out[0]!.claim).toContain('before-save');
    expect(out[0]!.groundedIn).toEqual([FLOW_A, FLOW_B, OBJ]);
    expect(out[1]!.claim).toContain('after-save');
    expect(out[1]!.groundedIn).toEqual([FLOW_C, FLOW_D, OBJ]);
  });

  it('[absent triggerType] flows with NO triggerType on the edge are NOT counted toward any collision (never folded into a save bucket)', () => {
    // Post-fix honesty: an absent/unknown triggerType places in NO trigger
    // context, so two such flows do not fabricate a collision. (A record-
    // triggered Flow always carries one of the three real triggerTypes; a missing
    // one means "unplaceable", never "after-save".)
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), activeFlow(FLOW_B)],
      edges: [triggersOn(FLOW_A, undefined), triggersOn(FLOW_B, undefined)],
    };
    expect(interpret(aggRule(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[FIX 1 — the crux] a RecordBeforeDelete flow is NOT counted in the after-save bucket (1 after-save + 1 before-delete → NO fire)', () => {
    // The HIGH cry-wolf bug: the old `!= before ⇒ after` catch-all folded a
    // before-delete flow into the after-save bucket, so an after-save flow + a
    // before-delete flow falsely read as "2 flows in the same save phase". A
    // before-delete flow runs only on the DELETE path — it can NEVER co-execute
    // with a save-timing flow, so this must NOT fire. Removing the 3-way fix
    // (folding delete → after) re-fires this as a false collision.
    const AFTER_FLOW = 'Flow:Deal_After_C';
    const DELETE_FLOW = 'Flow:Deal_Delete_X';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(AFTER_FLOW), activeFlow(DELETE_FLOW)],
      edges: [
        triggersOn(AFTER_FLOW, 'RecordAfterSave'),
        triggersOn(DELETE_FLOW, 'RecordBeforeDelete'),
      ],
    };
    expect(interpret(aggRule(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[FIX 1] two active RecordBeforeDelete flows DO stack → fire a before-delete collision with the correct timing label', () => {
    // Two before-delete flows on one object run in an undefined DELETE-path order:
    // a legitimate collision, bucketed as `before-delete` (NOT a save phase). The
    // claim renders the real delete context, never a hardcoded "save phase".
    const DELETE_FLOW_A = 'Flow:Deal_Delete_A';
    const DELETE_FLOW_B = 'Flow:Deal_Delete_B';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(DELETE_FLOW_A), activeFlow(DELETE_FLOW_B)],
      edges: [
        triggersOn(DELETE_FLOW_A, 'RecordBeforeDelete'),
        triggersOn(DELETE_FLOW_B, 'RecordBeforeDelete'),
      ],
    };
    const out = interpret(aggRule(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.claim).toContain('before-delete');
    // Never mislabeled as a save-timing collision.
    expect(only.claim).not.toContain('before-save');
    expect(only.claim).not.toContain('after-save');
    expect(only.claim).not.toMatch(/save phase/i);
    expect(only.groundedIn).toEqual([DELETE_FLOW_A, DELETE_FLOW_B, OBJ]);
  });

  it('[FIX 2 — count, not threshold] 3 active before-save flows → claim discloses the REAL count 3 (a String(count)→String(threshold) mutation fails)', () => {
    // Every other firing fixture has exactly 2 flows == threshold, so a mutation
    // rendering `threshold` instead of `count` survives. Three flows separate the
    // two: the claim must read "3 active", not "2 active".
    const FLOW_E = 'Flow:Deal_Before_E';
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        activeFlow(FLOW_A),
        activeFlow(FLOW_B),
        activeFlow(FLOW_E),
      ],
      edges: [
        triggersOn(FLOW_A, 'RecordBeforeSave'),
        triggersOn(FLOW_B, 'RecordBeforeSave'),
        triggersOn(FLOW_E, 'RecordBeforeSave'),
      ],
    };
    const out = interpret(aggRule(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.claim).toContain('3 active record-triggered flows');
    expect(only.claim).not.toContain('2 active record-triggered flows');
    expect(only.groundedIn).toEqual([FLOW_A, FLOW_B, FLOW_E, OBJ]);
  });

  it('[FIX 3 — distinct-endpoint dedup] two triggersOn edges from the SAME firer are counted ONCE (a duplicate edge cannot inflate the count)', () => {
    // FLOW_A reaches the root via TWO triggersOn edges; FLOW_B via one. The count
    // is over DISTINCT firers, so it is 2 (not 3) and each firer is cited once.
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), activeFlow(FLOW_B)],
      edges: [
        triggersOn(FLOW_A, 'RecordBeforeSave'),
        triggersOn(FLOW_A, 'RecordBeforeSave'), // duplicate witness of the same firer
        triggersOn(FLOW_B, 'RecordBeforeSave'),
      ],
    };
    const out = interpret(aggRule(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.claim).toContain('2 active record-triggered flows');
    expect(only.claim).not.toContain('3 active');
    expect(only.groundedIn).toEqual([FLOW_A, FLOW_B, OBJ]);
  });

  it('[FIX 4 — truncation caveat] a non-complete coverage surfaces its caveat on the interpretation (the count is a floor, an under-claim)', () => {
    // When the slice was truncated the caller degrades coverage below `complete`;
    // the aggregate count then under-reports, so the caveat must ride along rather
    // than presenting the count as exact. Under COMPLETE coverage it stays null.
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), activeFlow(FLOW_B)],
      edges: [triggersOn(FLOW_A, 'RecordBeforeSave'), triggersOn(FLOW_B, 'RecordBeforeSave')],
    };
    const out = interpret(aggRule(), slice, PARTIAL, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.coverageCaveat).toBe(PARTIAL.caveat);
    // Control: the same slice under complete coverage carries no caveat.
    const complete = interpret(aggRule(), slice, COMPLETE, OBJ);
    expect(complete[0]!.coverageCaveat).toBeNull();
  });

  it('confidence = weakest across the counted edges: a parsed triggersOn caps the declared-max rule to parsed', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), activeFlow(FLOW_B)],
      edges: [
        triggersOn(FLOW_A, 'RecordBeforeSave', 'declared'),
        triggersOn(FLOW_B, 'RecordBeforeSave', 'parsed'),
      ],
    };
    const out = interpret(aggRule('declared'), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    // weakest(declared, declared, parsed) === 'parsed'.
    expect(out[0]!.confidence).toBe('parsed');
    expect(out[0]!.confidence).not.toBe('declared');
  });

  it('does NOT count an ApexTrigger firer (componentTypes scopes the count to Flow)', () => {
    const TRIGGER = 'ApexTrigger:DealTrigger';
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        activeFlow(FLOW_A),
        node(TRIGGER, 'ApexTrigger', { status: 'Active' }),
      ],
      edges: [triggersOn(FLOW_A, 'RecordBeforeSave'), triggersOn(TRIGGER, 'RecordBeforeSave')],
    };
    // Only 1 Flow survives the componentTypes filter → below threshold → no fire.
    expect(interpret(aggRule(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('yields [] without a rootId (an aggregate rule anchors its count on the queried root)', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), activeFlow(FLOW_B)],
      edges: [triggersOn(FLOW_A, 'RecordBeforeSave'), triggersOn(FLOW_B, 'RecordBeforeSave')],
    };
    expect(interpret(aggRule(), slice, COMPLETE)).toEqual([]);
  });

  it('the SHIPPED rule renders the count-disclosing best-practice claim and cites the flows (guards the real wording)', () => {
    const shipped = CONCEPT_RULES.find(
      (r) => r.id === 'rule:automation/stacked-record-triggered-flows',
    );
    expect(shipped, 'shipped rule:automation/stacked-record-triggered-flows must exist').toBeDefined();
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(FLOW_A), activeFlow(FLOW_B)],
      edges: [triggersOn(FLOW_A, 'RecordBeforeSave'), triggersOn(FLOW_B, 'RecordBeforeSave')],
    };
    const out = interpret(shipped!, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:automation-collision');
    // States facts + best practice, never a bare value judgment. Both flows carry
    // no recordTriggerType, so the DML-event split places them conservatively in
    // BOTH insert and update — identical membership → merged into ONE claim.
    expect(only.claim).toContain('2 active record-triggered before-save flows');
    expect(only.claim).toContain('co-fire on the insert or update operation');
    expect(only.claim.toLowerCase()).toContain('best practice');
    // RM-review F12: hedges Flow Trigger Order (deterministic since Spring '22)
    // and offers set-trigger-order + consolidate, not a blanket "undefined order".
    expect(only.claim.toLowerCase()).toContain('flow trigger order');
    expect(only.claim.toLowerCase()).toContain('consolidate');
    expect(only.claim.toLowerCase()).toContain('managed-package');
    // Names the flows (culprits) first; the object is trailing context.
    expect(only.groundedIn).toEqual([FLOW_A, FLOW_B, OBJ]);
  });
});

// ---------------------------------------------------------------------------
// interpret — stacked-record-triggered-flows DML-EVENT SPLIT
// (REASONING-STACKED-FLOWS-IGNORES-RECORD-TRIGGER-TYPE). The SHIPPED rule now
// carries `eventSplitByProperty: recordTriggerType`, so each timing bucket splits
// by the concrete DML operation a flow fires on. Two flows only "co-fire on one
// save" when they share a DML event, so a Create-only flow (insert) + an
// Update-only flow (update) in the same timing are mutually exclusive and must NOT
// be reported as a collision. A CreateAndUpdate flow lands in BOTH insert and
// update. Buckets with identical membership (an all-CreateAndUpdate stack) merge
// to one "insert or update" claim; a mixed stack reports per-event max (e.g.
// insert 3 / update 2). before-delete flows are the single `delete` event and
// still stack. Exercises the SHIPPED rule (from CONCEPT_RULES) so a wording/bind
// regression is caught. All synthetic ids.
// ---------------------------------------------------------------------------

describe('interpret — stacked-record-triggered-flows DML-EVENT SPLIT', () => {
  const OBJ = 'CustomObject:Ns__Deal__c';
  const shipped = (): ConceptRule => {
    const r = CONCEPT_RULES.find((rule) => rule.id === 'rule:automation/stacked-record-triggered-flows');
    expect(r, 'shipped stacked-record-triggered-flows must exist').toBeDefined();
    // The rule must carry the DML-event split (the fix); a regression that drops it
    // re-introduces the mutually-exclusive over-count.
    expect(r!.bind.aggregate?.eventSplitByProperty).toBe('recordTriggerType');
    return r!;
  };
  const activeFlow = (id: string): Node => node(id, 'Flow', { status: 'Active' });
  const trig = (flowId: string, triggerType: string, recordTriggerType: string | undefined): Edge =>
    edge(flowId, OBJ, 'triggersOn', 'declared', { triggerType, recordTriggerType });

  it('[crux] a Create-only + an Update-only before-save flow do NOT fire — mutually exclusive, never a same-save collision', () => {
    const CREATE_FLOW = 'Flow:Ns__CreateOnly';
    const UPDATE_FLOW = 'Flow:Ns__UpdateOnly';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(CREATE_FLOW), activeFlow(UPDATE_FLOW)],
      edges: [
        trig(CREATE_FLOW, 'RecordBeforeSave', 'Create'),
        trig(UPDATE_FLOW, 'RecordBeforeSave', 'Update'),
      ],
    };
    // insert bucket = {Create}, update bucket = {Update} — each size 1 < 2, no fire.
    // Pre-fix (single timing bucket) this fabricated a 2-flow before-save collision.
    expect(interpret(shipped(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[crux] the same mutually-exclusive pair in after-save also does NOT fire', () => {
    const CREATE_FLOW = 'Flow:Ns__ACreate';
    const UPDATE_FLOW = 'Flow:Ns__AUpdate';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(CREATE_FLOW), activeFlow(UPDATE_FLOW)],
      edges: [
        trig(CREATE_FLOW, 'RecordAfterSave', 'Create'),
        trig(UPDATE_FLOW, 'RecordAfterSave', 'Update'),
      ],
    };
    expect(interpret(shipped(), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('reports the PER-EVENT MAX for a mixed stack: 2 Create + 1 Update + 1 CreateAndUpdate → insert 3 / update 2 (not 4)', () => {
    const C1 = 'Flow:Ns__C1'; // Create
    const C2 = 'Flow:Ns__C2'; // Create
    const U1 = 'Flow:Ns__U1'; // Update
    const CU = 'Flow:Ns__CU'; // CreateAndUpdate
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(C1), activeFlow(C2), activeFlow(U1), activeFlow(CU)],
      edges: [
        trig(C1, 'RecordBeforeSave', 'Create'),
        trig(C2, 'RecordBeforeSave', 'Create'),
        trig(U1, 'RecordBeforeSave', 'Update'),
        trig(CU, 'RecordBeforeSave', 'CreateAndUpdate'),
      ],
    };
    const out = interpret(shipped(), slice, COMPLETE, OBJ);
    // TWO claims (insert then update) — never one "4 flows" over-count.
    expect(out).toHaveLength(2);
    const insert = out[0]!;
    const update = out[1]!;
    // insert = {C1, C2, CU} = 3 (sorted: C1 < C2 < CU).
    expect(insert.claim).toContain('3 active record-triggered before-save flows');
    expect(insert.claim).toContain('co-fire on the insert operation');
    expect(insert.groundedIn).toEqual([C1, C2, CU, OBJ]);
    // update = {U1, CU} = 2.
    expect(update.claim).toContain('2 active record-triggered before-save flows');
    expect(update.claim).toContain('co-fire on the update operation');
    expect(update.groundedIn).toEqual([CU, U1, OBJ]);
    // Never a phantom "4".
    for (const only of out) expect(only.claim).not.toContain('4 active record-triggered');
  });

  it('an all-CreateAndUpdate stack MERGES to a single "insert or update" claim (not doubled)', () => {
    const A = 'Flow:Ns__CuA';
    const B = 'Flow:Ns__CuB';
    const C = 'Flow:Ns__CuC';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(A), activeFlow(B), activeFlow(C)],
      edges: [
        trig(A, 'RecordAfterSave', 'CreateAndUpdate'),
        trig(B, 'RecordAfterSave', 'CreateAndUpdate'),
        trig(C, 'RecordAfterSave', 'CreateAndUpdate'),
      ],
    };
    const out = interpret(shipped(), slice, COMPLETE, OBJ);
    // insert {A,B,C} == update {A,B,C} → merged into ONE claim.
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.claim).toContain('3 active record-triggered after-save flows');
    expect(only.claim).toContain('co-fire on the insert or update operation');
    expect(only.groundedIn).toEqual([A, B, C, OBJ]);
  });

  it('a Create-only flow stacks with a CreateAndUpdate flow ON INSERT ONLY (they share the insert event)', () => {
    const CREATE_FLOW = 'Flow:Ns__Co';
    const CU_FLOW = 'Flow:Ns__Cu';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(CREATE_FLOW), activeFlow(CU_FLOW)],
      edges: [
        trig(CREATE_FLOW, 'RecordBeforeSave', 'Create'),
        trig(CU_FLOW, 'RecordBeforeSave', 'CreateAndUpdate'),
      ],
    };
    const out = interpret(shipped(), slice, COMPLETE, OBJ);
    // insert = {Create, CU} = 2 (fires); update = {CU} = 1 (does not).
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('co-fire on the insert operation');
    expect(out[0]!.claim).not.toContain('update operation');
    // sorted: 'Flow:Ns__Co' < 'Flow:Ns__Cu'.
    expect(out[0]!.groundedIn).toEqual([CREATE_FLOW, CU_FLOW, OBJ]);
  });

  it('two before-delete flows still stack on the single delete event (regression — event split leaves delete whole)', () => {
    const D1 = 'Flow:Ns__Del1';
    const D2 = 'Flow:Ns__Del2';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeFlow(D1), activeFlow(D2)],
      // before-delete flows commonly carry recordTriggerType Delete (or none).
      edges: [
        trig(D1, 'RecordBeforeDelete', 'Delete'),
        trig(D2, 'RecordBeforeDelete', undefined),
      ],
    };
    const out = interpret(shipped(), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('2 active record-triggered before-delete flows');
    expect(out[0]!.claim).toContain('co-fire on the delete operation');
    expect(out[0]!.groundedIn).toEqual([D1, D2, OBJ]);
  });
});

// ---------------------------------------------------------------------------
// interpret — junction-object AGGREGATE (RM-loop generalization). The junction
// count is a 2-hop over the ROOT OBJECT's OWN fields: a master-detail `lookupTo`
// edge hangs off the child FIELD, so the object node has ZERO incident ones.
// Exercises the four ADDITIVE aggregate knobs — `edgeSource:
// 'root-children-outgoing'`, `countedEdgeWhereProperty` (MasterDetail only),
// `countDistinctEndpoint: 'to'` (distinct parent), `op: 'eq'` (exactly two) —
// with SYNTHETIC `Ns__…` ids (no real org). The final block asserts the shipped
// stacked-flows `gte`/incident path is UNCHANGED under these additive defaults.
// ---------------------------------------------------------------------------

describe('interpret — junction-object AGGREGATE (root-children-outgoing, eq, distinct-to)', () => {
  const JUNCTION = 'CustomObject:Ns__Junction__c';
  const PARENT_A = 'CustomObject:Ns__Alpha__c';
  const PARENT_B = 'CustomObject:Ns__Beta__c';
  const PARENT_C = 'CustomObject:Ns__Gamma__c';
  const F_A = 'CustomField:Ns__Junction__c.Ns__AlphaRef__c';
  const F_B = 'CustomField:Ns__Junction__c.Ns__BetaRef__c';
  const F_C = 'CustomField:Ns__Junction__c.Ns__GammaRef__c';

  /** The junction rule's shape (org-agnostic; no component ids). */
  const junctionRule = (maxConfidence: ConfidenceLevel = 'declared'): ConceptRule => ({
    id: 'rule:relationship/junction-object',
    concept: 'concept:junction-object',
    bind: {
      edgeType: 'lookupTo',
      componentTypes: ['CustomField', 'CustomObject'],
      aggregate: {
        edgeSource: 'root-children-outgoing',
        countedEdgeWhereProperty: { key: 'relationshipType', equals: 'MasterDetail' },
        countDistinctEndpoint: 'to',
        op: 'eq',
        threshold: 2,
      },
    },
    interpretation:
      '{0} is a junction (join) object: it has exactly two master-detail parents ({1} and {2}), a many-to-many link. Deleting a record of EITHER parent cascade-deletes the junction records; {0} has no owner or sharing of its own.',
    maxConfidence,
    absenceShaped: false,
    dependsOnCoverage: ['CustomField', 'CustomObject'],
  });

  /** A CustomField node parented by the junction object. */
  const childField = (id: string): Node => ({ ...node(id, 'CustomField'), parentId: JUNCTION });
  /** A master-detail lookupTo edge from a child field to a parent object. */
  const md = (fieldId: string, parentId: string, confidence: ConfidenceLevel = 'declared'): Edge =>
    edge(fieldId, parentId, 'lookupTo', confidence, { relationshipType: 'MasterDetail' });

  it('fires on EXACTLY 2 distinct master-detail parents — cites [root, parentA, parentB] (root FIRST), declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        childField(F_B),
        node(PARENT_A, 'CustomObject'),
        node(PARENT_B, 'CustomObject'),
      ],
      edges: [md(F_A, PARENT_A), md(F_B, PARENT_B)],
    };
    const out = interpret(junctionRule(), slice, COMPLETE, JUNCTION);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    // Citation order [root, …sorted parents] — junction {0}, masters {1}/{2}.
    expect(only.groundedIn).toEqual([JUNCTION, PARENT_A, PARENT_B]);
    expect(only.claim).toContain(JUNCTION);
    expect(only.claim).toContain(PARENT_A);
    expect(only.claim).toContain(PARENT_B);
    // `{0}` filled with the junction, not a parent.
    expect(only.claim.startsWith(JUNCTION)).toBe(true);
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('[op: eq] does NOT fire on a single master-detail parent (one is not a junction)', () => {
    const slice: GroundedSlice = {
      nodes: [node(JUNCTION, 'CustomObject'), childField(F_A), node(PARENT_A, 'CustomObject')],
      edges: [md(F_A, PARENT_A)],
    };
    expect(interpret(junctionRule(), slice, COMPLETE, JUNCTION)).toEqual([]);
  });

  it('[op: eq — the crux] does NOT fire on THREE distinct master-detail parents (eq 2, not gte 2)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        childField(F_B),
        childField(F_C),
        node(PARENT_A, 'CustomObject'),
        node(PARENT_B, 'CustomObject'),
        node(PARENT_C, 'CustomObject'),
      ],
      edges: [md(F_A, PARENT_A), md(F_B, PARENT_B), md(F_C, PARENT_C)],
    };
    // A gte>=2 mutation would fire here; eq===2 must not.
    expect(interpret(junctionRule(), slice, COMPLETE, JUNCTION)).toEqual([]);
  });

  it('[countDistinctEndpoint: to] two master-detail fields to the SAME parent count as ONE parent → NO fire', () => {
    const F_A2 = 'CustomField:Ns__Junction__c.Ns__AlphaRef2__c';
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        { ...node(F_A2, 'CustomField'), parentId: JUNCTION },
        node(PARENT_A, 'CustomObject'),
      ],
      edges: [md(F_A, PARENT_A), md(F_A2, PARENT_A)], // two fields, ONE distinct parent
    };
    expect(interpret(junctionRule(), slice, COMPLETE, JUNCTION)).toEqual([]);
  });

  it('[countedEdgeWhereProperty] a plain Lookup (relationshipType!=MasterDetail) is NOT counted → 1 MD + 1 lookup does not fire', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        childField(F_B),
        node(PARENT_A, 'CustomObject'),
        node(PARENT_B, 'CustomObject'),
      ],
      edges: [
        md(F_A, PARENT_A),
        edge(F_B, PARENT_B, 'lookupTo', 'declared', { relationshipType: 'Lookup' }),
      ],
    };
    // Only 1 master-detail parent survives the counted-edge filter → below eq 2.
    expect(interpret(junctionRule(), slice, COMPLETE, JUNCTION)).toEqual([]);
  });

  it('[edgeSource locus] a master-detail edge off a DIFFERENT object’s field (parentId != root) is NOT counted', () => {
    const OTHER = 'CustomObject:Ns__Other__c';
    const OTHER_FIELD = 'CustomField:Ns__Other__c.Ns__Ref__c';
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        { ...node(OTHER_FIELD, 'CustomField'), parentId: OTHER }, // NOT a child of the root
        node(PARENT_A, 'CustomObject'),
        node(PARENT_B, 'CustomObject'),
      ],
      edges: [md(F_A, PARENT_A), md(OTHER_FIELD, PARENT_B)],
    };
    // Only 1 MD parent is off the ROOT's own field → below eq 2 → no fire.
    expect(interpret(junctionRule(), slice, COMPLETE, JUNCTION)).toEqual([]);
  });

  it('[unresolved parent] a dangling master-detail parent (node absent from the slice) is NOT counted or cited', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        childField(F_B),
        node(PARENT_A, 'CustomObject'),
        // PARENT_B node deliberately absent (not retrieved into the vault).
      ],
      edges: [md(F_A, PARENT_A), md(F_B, PARENT_B)],
    };
    // The unresolved parent endpoint is dropped → only 1 grounded parent → no fire.
    expect(interpret(junctionRule(), slice, COMPLETE, JUNCTION)).toEqual([]);
  });

  // #2 — the SILENT-MISS detector. A dropped phantom master endpoint (the case
  // above) must be DETECTABLE so the caller can disclose it: "complete coverage"
  // may never sit beside a silent junction non-detection.
  describe('aggregateHasUnresolvedCountedEndpoint (#2 silent-miss detector)', () => {
    it('returns true when a counted master-detail PARENT is a phantom (dropped, so the rule silently under-counts)', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(JUNCTION, 'CustomObject'),
          childField(F_A),
          childField(F_B),
          node(PARENT_A, 'CustomObject'),
          // PARENT_B deliberately absent — an un-retrieved (standard/managed) master.
        ],
        edges: [md(F_A, PARENT_A), md(F_B, PARENT_B)],
      };
      // The rule itself stays silent (count 1 < 2) …
      expect(interpret(junctionRule(), slice, COMPLETE, JUNCTION)).toEqual([]);
      // … but the miss is now DETECTABLE for disclosure.
      expect(aggregateHasUnresolvedCountedEndpoint(junctionRule(), slice, JUNCTION)).toBe(true);
    });

    it('returns false when every counted parent resolves (a genuine 2-master junction)', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(JUNCTION, 'CustomObject'),
          childField(F_A),
          childField(F_B),
          node(PARENT_A, 'CustomObject'),
          node(PARENT_B, 'CustomObject'),
        ],
        edges: [md(F_A, PARENT_A), md(F_B, PARENT_B)],
      };
      expect(aggregateHasUnresolvedCountedEndpoint(junctionRule(), slice, JUNCTION)).toBe(false);
    });

    it('ignores a phantom endpoint reached by a PLAIN lookup (not a master-detail parent → not a junction miss)', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(JUNCTION, 'CustomObject'),
          childField(F_A),
          childField(F_C),
          node(PARENT_A, 'CustomObject'),
          // PARENT_C (a plain-lookup target) absent — but a lookup is never counted.
        ],
        edges: [
          md(F_A, PARENT_A),
          edge(F_C, PARENT_C, 'lookupTo', 'declared', { relationshipType: 'Lookup' }),
        ],
      };
      expect(aggregateHasUnresolvedCountedEndpoint(junctionRule(), slice, JUNCTION)).toBe(false);
    });

    it('returns false without a rootId and for a non-child-outgoing aggregate (a root-incident firer is always present)', () => {
      const slice: GroundedSlice = {
        nodes: [node(JUNCTION, 'CustomObject'), childField(F_A), node(PARENT_A, 'CustomObject')],
        edges: [md(F_A, PARENT_A)],
      };
      expect(aggregateHasUnresolvedCountedEndpoint(junctionRule(), slice, undefined)).toBe(false);
      // A rule with no aggregate is never a counted-endpoint miss.
      const noAgg: ConceptRule = { ...junctionRule(), bind: { edgeType: 'lookupTo' } };
      expect(aggregateHasUnresolvedCountedEndpoint(noAgg, slice, JUNCTION)).toBe(false);
    });
  });

  it('confidence = weakest across the counted master-detail edges (a parsed edge caps declared-max to parsed)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        childField(F_B),
        node(PARENT_A, 'CustomObject'),
        node(PARENT_B, 'CustomObject'),
      ],
      edges: [md(F_A, PARENT_A, 'declared'), md(F_B, PARENT_B, 'parsed')],
    };
    const out = interpret(junctionRule('declared'), slice, COMPLETE, JUNCTION);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('parsed');
  });

  it('yields [] without a rootId (an aggregate rule anchors its count on the queried root)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        childField(F_B),
        node(PARENT_A, 'CustomObject'),
        node(PARENT_B, 'CustomObject'),
      ],
      edges: [md(F_A, PARENT_A), md(F_B, PARENT_B)],
    };
    expect(interpret(junctionRule(), slice, COMPLETE)).toEqual([]);
  });

  it('[truncation caveat] non-complete coverage rides its caveat onto the junction interpretation', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        childField(F_B),
        node(PARENT_A, 'CustomObject'),
        node(PARENT_B, 'CustomObject'),
      ],
      edges: [md(F_A, PARENT_A), md(F_B, PARENT_B)],
    };
    const out = interpret(junctionRule(), slice, PARTIAL, JUNCTION);
    expect(out).toHaveLength(1);
    expect(out[0]!.coverageCaveat).toBe(PARTIAL.caveat);
  });

  it('[REGRESSION — additive defaults] a legacy incident/gte aggregate (no new keys) still cites firers-first, root-last', () => {
    // Byte-identical shipped path: the automation-collision aggregate carries NONE
    // of the new knobs, so edgeSource defaults to root-incident, countDistinctEndpoint
    // to `from`, and the citation order stays [firers…, root] (NOT root-first).
    const OBJ = 'CustomObject:Ns__Deal__c';
    const FLOW_1 = 'Flow:Ns__Before_1';
    const FLOW_2 = 'Flow:Ns__Before_2';
    const legacyRule: ConceptRule = {
      id: 'rule:automation/stacked-record-triggered-flows',
      concept: 'automation-collision',
      bind: {
        edgeType: 'triggersOn',
        componentTypes: ['Flow'],
        aggregate: {
          groupByEdgeProperty: 'triggerType',
          endpointWhereProperty: { key: 'status', equals: 'Active' },
          op: 'gte',
          threshold: 2,
        },
      },
      interpretation: '{object} runs {count} in {timing}: {ids}.',
      maxConfidence: 'declared',
      absenceShaped: false,
      dependsOnCoverage: ['Flow'],
    };
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        node(FLOW_1, 'Flow', { status: 'Active' }),
        node(FLOW_2, 'Flow', { status: 'Active' }),
      ],
      edges: [
        edge(FLOW_1, OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
        edge(FLOW_2, OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
      ],
    };
    const out = interpret(legacyRule, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    // Firers first, root trailing as context — the shipped ordering, unchanged.
    expect(out[0]!.groundedIn).toEqual([FLOW_1, FLOW_2, OBJ]);
    // Named-token fill (not positional): {object}/{count}/{timing} resolve.
    expect(out[0]!.claim).toBe(`${OBJ} runs 2 in before-save: ${FLOW_1}, ${FLOW_2}.`);
  });

  it('the SHIPPED junction rule fires on a 2-master junction and renders the honest cascade/ControlledByParent claim', () => {
    const shipped = CONCEPT_RULES.find((r) => r.id === 'rule:relationship/junction-object');
    expect(shipped, 'shipped rule:relationship/junction-object must exist').toBeDefined();
    const slice: GroundedSlice = {
      nodes: [
        node(JUNCTION, 'CustomObject'),
        childField(F_A),
        childField(F_B),
        node(PARENT_A, 'CustomObject'),
        node(PARENT_B, 'CustomObject'),
      ],
      edges: [md(F_A, PARENT_A), md(F_B, PARENT_B)],
    };
    const out = interpret(shipped!, slice, COMPLETE, JUNCTION);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:junction-object');
    // Junction cited first ({0}), the two masters next ({1}/{2}).
    expect(only.groundedIn).toEqual([JUNCTION, PARENT_A, PARENT_B]);
    // Names the structural PATTERN, not a proven design intent (pattern-not-intent
    // reword): the claim states the signature and explicitly disclaims pure-connector.
    expect(only.claim).toContain('structural signature of a many-to-many junction');
    expect(only.claim).toContain('structural pattern only');
    expect(only.claim).toContain('not a proven pure-connector design intent');
    expect(only.claim).toContain('exactly two master-detail parents');
    expect(only.claim).toContain('cascade-deletes');
    // Controlled by Parent, attributed as an inference from the MD edges (not read
    // from sharingModel) — never the old bare "record access is Controlled by Parent".
    expect(only.claim).toContain('Controlled by Parent');
    expect(only.claim).toContain('inferred from the relationship type');
    expect(only.claim).toContain('derived from the two master-detail edges rather than read from');
    // Honest boundaries carried verbatim.
    expect(only.claim.toLowerCase()).toContain('not determinable offline');
    expect(only.claim.toLowerCase()).toContain('live-plane');
    expect(only.confidence).toBe('declared');
  });
});

// ---------------------------------------------------------------------------
// interpret — OWD sharing-posture NODE rules (RM-loop, DATA-only). These bind
// the grounded `sharingModel` property on a CustomObject node and state the
// OBJECT-level baseline posture ONLY. Tests exercise the SHIPPED rules (from
// CONCEPT_RULES), so a claim-wording or bind regression is caught. All
// synthetic: `Ns__…` ids, no real org.
// ---------------------------------------------------------------------------

describe('interpret — OWD sharing-posture NODE rules', () => {
  const shipped = (id: string): ConceptRule => {
    const r = CONCEPT_RULES.find((rule) => rule.id === id);
    expect(r, `shipped ${id} must exist`).toBeDefined();
    return r!;
  };

  // (rule id, bound sharingModel value, a distinctive phrase from the claim).
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:sharing/owd-private', 'Private', 'org-wide default Private'],
    ['rule:sharing/owd-controlled-by-parent', 'ControlledByParent', 'Controlled by Parent'],
    ['rule:sharing/owd-public-readwrite', 'ReadWrite', 'Public Read/Write'],
    ['rule:sharing/owd-public-read', 'Read', 'Public Read Only'],
    // ReadWriteTransfer (owdRank rank 2 — same view/edit posture as ReadWrite,
    // the standard-object default for Lead/Case) reuses the Public Read/Write claim.
    ['rule:sharing/owd-readwritetransfer', 'ReadWriteTransfer', 'Public Read/Write'],
    // Coverage-gap closure: the two remaining OWD values the 5-rule set did not
    // bind. FullAccess (Campaign-only Public Full Access) is the MOST permissive;
    // ControlledByCampaign inherits access from the parent Campaign (no sharing
    // model of its own, like ControlledByParent).
    ['rule:sharing/owd-full-access', 'FullAccess', 'Public Full Access'],
    ['rule:sharing/owd-controlled-by-campaign', 'ControlledByCampaign', 'Controlled by Campaign'],
  ];

  const OBJ_A = 'CustomObject:Ns__ObjA__c';
  const OBJ_B = 'CustomObject:Ns__ObjB__c';

  it.each(CASES)(
    '%s fires on a CustomObject with its sharingModel, cites ONLY that object, confidence declared',
    (ruleId, value, phrase) => {
      const rule = shipped(ruleId);
      // A node-shaped rule: componentTypes CustomObject + equals on sharingModel.
      expect(rule.bind.componentTypes).toEqual(['CustomObject']);
      expect(rule.bind.whereProperty).toEqual({ key: 'sharingModel', equals: value });
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');

      const slice: GroundedSlice = {
        nodes: [node(OBJ_A, 'CustomObject', { sharingModel: value })],
        edges: [],
      };
      const out = interpret(rule, slice, COMPLETE, OBJ_A);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:owd-sharing-posture');
      // Cites ONLY the root object (node-shaped → single id), never a neighbor.
      expect(only.groundedIn).toEqual([OBJ_A]);
      expect(only.confidence).toBe('declared');
      expect(only.coverageCaveat).toBeNull();
      expect(only.claim).toContain(OBJ_A);
      expect(only.claim).toContain(phrase);
    },
  );

  it('the Private claim FENCES record-level visibility (never claims who sees a specific record)', () => {
    const rule = shipped('rule:sharing/owd-private');
    const slice: GroundedSlice = {
      nodes: [node(OBJ_A, 'CustomObject', { sharingModel: 'Private' })],
      edges: [],
    };
    const only = interpret(rule, slice, COMPLETE, OBJ_A)[0]!;
    // Explicitly disclaims per-record determinability offline.
    expect(only.claim.toLowerCase()).toContain("can't be determined offline");
    expect(only.claim.toLowerCase()).toContain('record-level');
  });

  it('[F1/F2] the Public Read Only claim is HONEST about edit — discloses edit-widening, never absolutizes edit', () => {
    // The headline-phrase assertion in the CASES table only guards "Public Read
    // Only"; this guards the BODY of the edit clause. Regressing to the old
    // wording ("...can edit records they own.") — which falsely absolutized edit
    // and mis-stated ownership — turns this test red.
    const rule = shipped('rule:sharing/owd-public-read');
    const slice: GroundedSlice = {
      nodes: [node(OBJ_A, 'CustomObject', { sharingModel: 'Read' })],
      edges: [],
    };
    const claim = interpret(rule, slice, COMPLETE, OBJ_A)[0]!.claim;
    const lower = claim.toLowerCase();
    // View is universal; edit is the DEFAULT-only owner + role-hierarchy superiors.
    expect(lower).toContain('all users can view every record');
    // Mirrors the Private rule's widening disclosure: edit access can be WIDENED by
    // record-level mechanisms, so who can edit a given record isn't offline-decidable.
    expect(lower).toContain('sharing rules');
    expect(lower).toContain('widen edit');
    expect(lower).toContain("can't be determined offline");
    // Must NOT carry the old false absolute, which implied edit is fixed to the
    // records a user owns with no possibility of widening.
    expect(lower).not.toContain('records they own');
  });

  it('a CustomObject with a DIFFERENT sharingModel does NOT fire the wrong rule', () => {
    const priv = shipped('rule:sharing/owd-private');
    // The object is Public Read/Write, so the Private rule must NOT fire.
    const slice: GroundedSlice = {
      nodes: [node(OBJ_A, 'CustomObject', { sharingModel: 'ReadWrite' })],
      edges: [],
    };
    expect(interpret(priv, slice, COMPLETE, OBJ_A)).toEqual([]);
    // Symmetric: the ReadWrite rule DOES fire on the same object.
    const rw = shipped('rule:sharing/owd-public-readwrite');
    expect(interpret(rw, slice, COMPLETE, OBJ_A)).toHaveLength(1);
  });

  it('a null-sharingModel object (CustomSetting/CMDT/PlatformEvent shape) fires NOTHING', () => {
    // sharingModel: null — the extractor's value for entity variants with no OWD.
    const slice: GroundedSlice = {
      nodes: [node(OBJ_A, 'CustomObject', { sharingModel: null })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(shipped(ruleId), slice, COMPLETE, OBJ_A)).toEqual([]);
    }
    // Also nothing when the property is entirely absent.
    const bare: GroundedSlice = { nodes: [node(OBJ_A, 'CustomObject', {})], edges: [] };
    for (const [ruleId] of CASES) {
      expect(interpret(shipped(ruleId), bare, COMPLETE, OBJ_A)).toEqual([]);
    }
    // And an UNRECOGNIZED sharingModel token matches NONE of the equals-gated
    // rules — each fires only on its exact value, there is no catch-all. (Every
    // real OWD value is now covered, so this uses a token no rule binds.)
    const unknown: GroundedSlice = {
      nodes: [node(OBJ_A, 'CustomObject', { sharingModel: 'SomeUnrecognizedModel' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(shipped(ruleId), unknown, COMPLETE, OBJ_A)).toEqual([]);
    }
  });

  it('[FIX 1 root-scoping] a neighbor CustomObject of the matching value does NOT get a posture claim — only the root', () => {
    const rule = shipped('rule:sharing/owd-private');
    // Root A is Public Read/Write; neighbor B (dragged into the slice) is Private.
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ_A, 'CustomObject', { sharingModel: 'ReadWrite' }),
        node(OBJ_B, 'CustomObject', { sharingModel: 'Private' }),
      ],
      edges: [],
    };
    // Querying A: the Private rule must NOT claim about the neighbor B.
    expect(interpret(rule, slice, COMPLETE, OBJ_A)).toEqual([]);
    // Querying B (its OWN object): the Private rule fires, citing B alone.
    const own = interpret(rule, slice, COMPLETE, OBJ_B);
    expect(own).toHaveLength(1);
    expect(own[0]!.groundedIn).toEqual([OBJ_B]);
  });

  it('the Public Full Access claim is HONEST — most permissive, Campaign-only, no restriction below the OWD', () => {
    const rule = shipped('rule:sharing/owd-full-access');
    const slice: GroundedSlice = {
      nodes: [node(OBJ_A, 'CustomObject', { sharingModel: 'FullAccess' })],
      edges: [],
    };
    const lower = interpret(rule, slice, COMPLETE, OBJ_A)[0]!.claim.toLowerCase();
    expect(lower).toContain('public full access');
    expect(lower).toContain('most permissive');
    expect(lower).toContain('available only for campaigns');
    // Mirrors the ReadWrite sibling's widening disclosure: sharing rules can only
    // ADD access, never restrict below the org-wide default.
    expect(lower).toContain('sharing rules cannot restrict access below the org-wide default');
  });

  it('the Controlled by Campaign claim is HONEST — access inherited from the parent Campaign, no sharing model of its own', () => {
    const rule = shipped('rule:sharing/owd-controlled-by-campaign');
    const slice: GroundedSlice = {
      nodes: [node(OBJ_A, 'CustomObject', { sharingModel: 'ControlledByCampaign' })],
      edges: [],
    };
    const lower = interpret(rule, slice, COMPLETE, OBJ_A)[0]!.claim.toLowerCase();
    expect(lower).toContain('controlled by campaign');
    // Access follows the parent Campaign — mirrors ControlledByParent's inheritance
    // framing; the object carries no sharing model of its own.
    expect(lower).toContain('inherited from its associated parent campaign');
    expect(lower).toContain('no sharing model of its own');
    // Does NOT over-assert per-record visibility as offline-decidable.
  });

  // GUARD (REASONING-CBP-CLAIMS-MASTER-DETAIL-ALWAYS): a ControlledByParent object
  // that is NOT a master-detail detail (Activity / Asset / other platform-parented
  // standard objects, whose CBP posture has NO master-detail relationship) must NOT
  // be told its records inherit "from its master-detail parent record". The rule
  // reads only `sharingModel`, which cannot substantiate the MD mechanism, so the
  // claim must state the proven fact (inherits from a controlling parent, no sharing
  // model of its own) and DISCLOSE both possible mechanisms without asserting MD.
  // This FAILS pre-fix (the old wording hard-asserted "master-detail parent record").
  it('[REASONING-CBP-CLAIMS-MASTER-DETAIL-ALWAYS] a non-master-detail CBP object is NOT told it has a master-detail parent', () => {
    const rule = shipped('rule:sharing/owd-controlled-by-parent');
    // A ControlledByParent object with NO master-detail child field in the slice —
    // an Activity/Asset-shaped standard CBP object. The node rule fires on the
    // sharingModel value alone (no MD edge exists to substantiate a master-detail
    // parent), so the claim must not assert one.
    const slice: GroundedSlice = {
      nodes: [node(OBJ_A, 'CustomObject', { sharingModel: 'ControlledByParent' })],
      edges: [],
    };
    const claim = interpret(rule, slice, COMPLETE, OBJ_A)[0]!.claim;
    // The proven baseline still fires.
    expect(claim).toContain('Controlled by Parent');
    // MUST NOT hard-assert the master-detail parent-record mechanism (the pre-fix
    // over-claim). The rule cannot substantiate MD from `sharingModel` alone.
    expect(claim).not.toContain('master-detail parent');
    expect(claim).not.toContain('inherited from its master-detail parent record');
    // MUST state the honest, proven inheritance framing …
    expect(claim).toContain('inherited from a controlling parent record');
    expect(claim).toContain('not from a sharing model of its own');
    // … and DISCLOSE the platform-parented standard-object case (Activity / Asset),
    // so a non-MD CBP object is never mislabeled as a master-detail detail.
    expect(claim).toContain('platform-defined owner');
    expect(claim.toLowerCase()).toContain('activity');
  });
});

// ---------------------------------------------------------------------------
// concept:async-boundary — four class-marker NODE rules + one dispatch EDGE
// rule. Async markers are grounded structural facts already in the graph
// (ApexClass boolean properties + the dispatchesAsync edge); no engine change.
// ---------------------------------------------------------------------------

describe('interpret — async-boundary NODE + EDGE rules', () => {
  const shipped = (id: string): ConceptRule => {
    const r = CONCEPT_RULES.find((rule) => rule.id === id);
    expect(r, `shipped ${id} must exist`).toBeDefined();
    return r!;
  };

  const CLS_QUEUEABLE = 'ApexClass:Ns__MyQueueable';
  const CLS_BATCHABLE = 'ApexClass:Ns__MyBatch';
  const CLS_FUTURE = 'ApexClass:Ns__MyFutureHolder';
  const CLS_CALLER = 'ApexClass:Ns__Enqueuer';
  const CLS_PLAIN = 'ApexClass:Ns__PlainService';
  const TRIGGER_CALLER = 'ApexTrigger:Ns__OrderTrigger';

  // (rule id, bound boolean property key, a distinctive phrase from the claim).
  const NODE_CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:async-boundary/queueable', 'isQueueable', 'implements Queueable'],
    ['rule:async-boundary/batchable', 'isBatchable', 'implements Batch Apex'],
    ['rule:async-boundary/schedulable', 'isSchedulable', 'implements Schedulable'],
    ['rule:async-boundary/future-method', 'hasFutureMethod', 'contains a @future method'],
  ];

  it.each(NODE_CASES)(
    '%s fires on an ApexClass whose %s === true, cites ONLY that class, confidence declared',
    (ruleId, key, phrase) => {
      const rule = shipped(ruleId);
      // A node-shaped rule: componentTypes ApexClass + equals:true on the marker.
      expect(rule.concept).toBe('concept:async-boundary');
      expect(rule.bind.componentTypes).toEqual(['ApexClass']);
      expect(rule.bind.whereProperty).toEqual({ key, equals: true });
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');

      const CLS = 'ApexClass:Ns__Marker';
      const slice: GroundedSlice = { nodes: [node(CLS, 'ApexClass', { [key]: true })], edges: [] };
      const out = interpret(rule, slice, COMPLETE, CLS);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:async-boundary');
      // A node match cites ONLY the root class (never a neighbor) and carries no
      // edge confidence, so weakest() keeps the declared ceiling.
      expect(only.groundedIn).toEqual([CLS]);
      expect(only.confidence).toBe('declared');
      expect(only.coverageCaveat).toBeNull();
      expect(only.claim).toContain(CLS);
      expect(only.claim).toContain(phrase);
      // Every class-marker claim names the SEPARATE-transaction / deferred boundary…
      expect(only.claim.toLowerCase()).toContain('separate transaction');
      // …and none assert WHEN the job runs or whether it succeeds.
      expect(only.claim.toUpperCase()).toContain('WHEN');
    },
  );

  it('the @future claim is METHOD-scoped — it does NOT call the whole class async', () => {
    const rule = shipped('rule:async-boundary/future-method');
    const slice: GroundedSlice = {
      nodes: [node(CLS_FUTURE, 'ApexClass', { hasFutureMethod: true })],
      edges: [],
    };
    const only = interpret(rule, slice, COMPLETE, CLS_FUTURE)[0]!;
    expect(only.claim.toLowerCase()).toContain('only the annotated method is async');
    expect(only.claim.toLowerCase()).toContain('not the rest of the class');
  });

  it('a marker=false / absent-property ApexClass fires NONE of the four node rules', () => {
    const falseSlice: GroundedSlice = {
      nodes: [
        node(CLS_PLAIN, 'ApexClass', {
          isQueueable: false,
          isBatchable: false,
          isSchedulable: false,
          hasFutureMethod: false,
        }),
      ],
      edges: [],
    };
    const bareSlice: GroundedSlice = { nodes: [node(CLS_PLAIN, 'ApexClass', {})], edges: [] };
    for (const [ruleId] of NODE_CASES) {
      expect(interpret(shipped(ruleId), falseSlice, COMPLETE, CLS_PLAIN)).toEqual([]);
      expect(interpret(shipped(ruleId), bareSlice, COMPLETE, CLS_PLAIN)).toEqual([]);
    }
  });

  it('[type guard] a non-ApexClass node with a truthy marker does NOT fire (componentTypes scopes the match)', () => {
    const rule = shipped('rule:async-boundary/queueable');
    // A Flow that (nonsensically) declares isQueueable must NOT be claimed async.
    const slice: GroundedSlice = {
      nodes: [node('Flow:Ns__Odd', 'Flow', { isQueueable: true })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Odd')).toEqual([]);
  });

  describe('rule:async-boundary/dispatches-async (EDGE)', () => {
    const rule = shipped('rule:async-boundary/dispatches-async');

    it('is an edge rule scoped to ApexClass citations, declared ceiling, presence-shaped', () => {
      expect(rule.concept).toBe('concept:async-boundary');
      expect(rule.bind.edgeType).toBe('dispatchesAsync');
      expect(rule.bind.componentTypes).toEqual(['ApexClass']);
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');
    });

    it('cites [caller, target] for a declared ApexClass→ApexClass dispatch, confidence declared', () => {
      const slice: GroundedSlice = {
        nodes: [node(CLS_CALLER, 'ApexClass'), node(CLS_QUEUEABLE, 'ApexClass')],
        edges: [
          edge(CLS_CALLER, CLS_QUEUEABLE, 'dispatchesAsync', 'declared', {
            dispatchMechanism: 'enqueueJob',
          }),
        ],
      };
      const out = interpret(rule, slice, COMPLETE, CLS_CALLER);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      // Both ApexClass endpoints resolve → cited [from, to]; the F6 self-citation
      // guard (length-1 only) does not trip on this length-2 citation.
      expect(only.groundedIn).toEqual([CLS_CALLER, CLS_QUEUEABLE]);
      expect(only.confidence).toBe('declared');
      expect(only.claim).toContain(CLS_CALLER);
      expect(only.claim).toContain(CLS_QUEUEABLE);
      expect(only.claim.toLowerCase()).toContain('separate transaction');
      expect(only.claim.toLowerCase()).toContain('deferred');
      // No unfilled positional token ever leaks into the rendered claim.
      expect(only.claim).not.toMatch(/\{\d+\}/);
    });

    it('weakest() drops a heuristic future-mechanism dispatch to heuristic', () => {
      const slice: GroundedSlice = {
        nodes: [node(CLS_CALLER, 'ApexClass'), node(CLS_FUTURE, 'ApexClass')],
        edges: [
          edge(CLS_CALLER, CLS_FUTURE, 'dispatchesAsync', 'heuristic', {
            dispatchMechanism: 'future',
          }),
        ],
      };
      const only = interpret(rule, slice, COMPLETE, CLS_CALLER)[0]!;
      expect(only.confidence).toBe(weakest('declared', 'heuristic'));
      expect(only.confidence).toBe('heuristic');
      expect(only.groundedIn).toEqual([CLS_CALLER, CLS_FUTURE]);
    });

    it('a multi-target ApexClass caller cites EVERY dispatched target (no positional truncation)', () => {
      const slice: GroundedSlice = {
        nodes: [
          node(CLS_CALLER, 'ApexClass'),
          node(CLS_QUEUEABLE, 'ApexClass'),
          node(CLS_BATCHABLE, 'ApexClass'),
        ],
        edges: [
          edge(CLS_CALLER, CLS_QUEUEABLE, 'dispatchesAsync', 'declared', { dispatchMechanism: 'enqueueJob' }),
          edge(CLS_CALLER, CLS_BATCHABLE, 'dispatchesAsync', 'declared', { dispatchMechanism: 'executeBatch' }),
        ],
      };
      const only = interpret(rule, slice, COMPLETE, CLS_CALLER)[0]!;
      expect(only.groundedIn).toEqual([CLS_CALLER, CLS_QUEUEABLE, CLS_BATCHABLE]);
      // The {ids} template renders every cited id — the caller AND both targets.
      expect(only.claim).toContain(CLS_QUEUEABLE);
      expect(only.claim).toContain(CLS_BATCHABLE);
      expect(only.claim).not.toMatch(/\{\d+\}/);
    });

    it('a NON-ApexClass source anchor (ApexTrigger dispatching async apex) cites only the resolved ApexClass target and renders honestly — no literal token', () => {
      // Real-vault shape: 2 of 30 dispatchesAsync edges have a non-ApexClass source
      // (an ApexTrigger + an LWC bundle). Anchoring on the trigger, componentTypes
      // filters the citation to the ApexClass TARGET (length 1); the {ids} template
      // must still render a coherent claim (a positional {0}/{1} would leak a "{1}").
      const slice: GroundedSlice = {
        nodes: [node(TRIGGER_CALLER, 'ApexTrigger'), node(CLS_QUEUEABLE, 'ApexClass')],
        edges: [
          edge(TRIGGER_CALLER, CLS_QUEUEABLE, 'dispatchesAsync', 'declared', {
            dispatchMechanism: 'enqueueJob',
          }),
        ],
      };
      const out = interpret(rule, slice, COMPLETE, TRIGGER_CALLER);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      // The non-ApexClass source is NOT cited; only the resolved ApexClass target is.
      expect(only.groundedIn).toEqual([CLS_QUEUEABLE]);
      expect(only.groundedIn).not.toContain(TRIGGER_CALLER);
      expect(only.claim).toContain(CLS_QUEUEABLE);
      expect(only.claim).not.toContain(TRIGGER_CALLER);
      expect(only.claim).not.toMatch(/\{\d+\}/); // no unfilled positional token
      expect(only.claim.toLowerCase()).toContain('deferred');
    });

    it('does NOT fire when the ApexClass anchor has no dispatchesAsync edge', () => {
      const slice: GroundedSlice = { nodes: [node(CLS_PLAIN, 'ApexClass')], edges: [] };
      expect(interpret(rule, slice, COMPLETE, CLS_PLAIN)).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // REASONING-ASYNC-TEST-CALLER-BLEED — a `dispatchesAsync` edge's dispatch
    // site is its `from` (the caller). When a production async class's ONLY
    // dispatchers are TEST classes, the bare relationship claim read as a
    // production async path though no production code reaches the job. The
    // witness partition classifies each edge by the DISPATCHER's `isTest` and
    // never lets a test-only edge establish production reachability. All ids
    // are GENERIC synthetic (RecalcBatch / …Test / OtherService).
    // -----------------------------------------------------------------------
    describe('witness partition (test-caller plane guard)', () => {
      const ASYNC_TARGET = 'ApexClass:Ns__RecalcBatch'; // production async class (queried anchor)
      const PROD_CALLER = 'ApexClass:Ns__OtherService'; // production dispatcher
      const TEST_CALLER = 'ApexClass:Ns__RecalcBatchTest'; // test-class dispatcher
      const TEST_CALLER_2 = 'ApexClass:Ns__RecalcBatchEnhancedTest'; // 2nd test dispatcher

      it('carries the witness partition config (from-endpoint dispatcher, isTest marker)', () => {
        expect(rule.witnessPartition).toBeDefined();
        expect(rule.witnessPartition!.roleEndpoint).toBe('from');
        expect(rule.witnessPartition!.witnessProperty).toBe('isTest');
        expect(rule.witnessPartition!.interpretationWitnessOnly.length).toBeGreaterThan(0);
        expect(rule.witnessPartition!.interpretationMixedWitnessSuffix.length).toBeGreaterThan(0);
      });

      // (a) PRODUCTION-ONLY — byte-identical to the un-partitioned path: cites
      // every endpoint, no test disclosure. (Regression anchor: passes pre- AND
      // post-fix, proving the fix leaves the legitimate production case alone.)
      it('production-only dispatch → base production claim, cites all endpoints, NO test disclosure', () => {
        const slice: GroundedSlice = {
          nodes: [
            node(PROD_CALLER, 'ApexClass', { isTest: false }),
            node(ASYNC_TARGET, 'ApexClass', { isTest: false }),
          ],
          edges: [
            edge(PROD_CALLER, ASYNC_TARGET, 'dispatchesAsync', 'declared', {
              dispatchMechanism: 'enqueueJob',
            }),
          ],
        };
        const out = interpret(rule, slice, COMPLETE, ASYNC_TARGET);
        expect(out).toHaveLength(1);
        const only = out[0]!;
        // Identical to the scalar edge path: both endpoints cited, declared, base claim.
        expect(only.groundedIn).toEqual([PROD_CALLER, ASYNC_TARGET]);
        expect(only.confidence).toBe('declared');
        expect(only.claim).toContain('Async dispatch relationship among');
        expect(only.claim.toLowerCase()).toContain('separate transaction');
        expect(only.claim.toLowerCase()).toContain('deferred');
        // No test-plane disclosure leaks into a purely-production claim.
        expect(only.claim).not.toContain('Test-only');
        expect(only.claim).not.toContain('test witnesses');
        expect(only.claim).not.toMatch(/\{\w+\}/); // no unfilled token
      });

      // (b) MIXED — the PRODUCTION dispatcher carries the async path; the TEST
      // dispatcher is EXCLUDED from the reachability citation and only disclosed.
      // FAILS pre-fix: the un-partitioned path stuffs the test caller into groundedIn.
      it('mixed prod+test dispatch → production path only; test dispatcher NOT in groundedIn, disclosed as witness', () => {
        const slice: GroundedSlice = {
          nodes: [
            node(PROD_CALLER, 'ApexClass', { isTest: false }),
            node(TEST_CALLER, 'ApexClass', { isTest: true }),
            node(ASYNC_TARGET, 'ApexClass', { isTest: false }),
          ],
          edges: [
            edge(PROD_CALLER, ASYNC_TARGET, 'dispatchesAsync', 'declared', {
              dispatchMechanism: 'enqueueJob',
            }),
            edge(TEST_CALLER, ASYNC_TARGET, 'dispatchesAsync', 'declared', {
              dispatchMechanism: 'enqueueJob',
            }),
          ],
        };
        const only = interpret(rule, slice, COMPLETE, ASYNC_TARGET)[0]!;
        // The production reachability set is production-only — the test caller is
        // NEVER conflated into it.
        expect(only.groundedIn).toEqual([PROD_CALLER, ASYNC_TARGET]);
        expect(only.groundedIn).not.toContain(TEST_CALLER);
        // …but the excluded test dispatcher IS disclosed (not silently dropped).
        expect(only.claim).toContain(TEST_CALLER);
        expect(only.claim.toLowerCase()).toContain('excluded from the production dispatch path');
        expect(only.claim).toContain('Async dispatch relationship among'); // base production claim retained
        expect(only.confidence).toBe('declared');
        expect(only.claim).not.toMatch(/\{\w+\}/);
      });

      // (c) TEST-ONLY — NO production reachability is asserted; the claim is the
      // test-only disclosure, still citing the witnesses + target. FAILS pre-fix:
      // the un-partitioned path emits the base production relationship claim.
      it('test-only dispatch → NO production path; test-only disclosure present, witnesses cited', () => {
        const slice: GroundedSlice = {
          nodes: [
            node(TEST_CALLER, 'ApexClass', { isTest: true }),
            node(TEST_CALLER_2, 'ApexClass', { isTest: true }),
            node(ASYNC_TARGET, 'ApexClass', { isTest: false }),
          ],
          edges: [
            edge(TEST_CALLER, ASYNC_TARGET, 'dispatchesAsync', 'declared', {
              dispatchMechanism: 'enqueueJob',
            }),
            edge(TEST_CALLER_2, ASYNC_TARGET, 'dispatchesAsync', 'declared', {
              dispatchMechanism: 'enqueueJob',
            }),
          ],
        };
        const out = interpret(rule, slice, COMPLETE, ASYNC_TARGET);
        expect(out).toHaveLength(1);
        const only = out[0]!;
        // The distinctive test-only disclosure — NOT the base production claim.
        expect(only.claim).toContain('Test-only async dispatch');
        expect(only.claim.toLowerCase()).toContain('not evidence of a production async execution path');
        expect(only.claim.toLowerCase()).toContain('no production dispatcher was found');
        // The base production relationship opener must NOT be presented here.
        expect(only.claim).not.toContain('Async dispatch relationship among');
        // Witnesses are preserved (disclosed, never hidden) and the target is cited.
        expect(only.groundedIn).toContain(TEST_CALLER);
        expect(only.groundedIn).toContain(TEST_CALLER_2);
        expect(only.groundedIn).toContain(ASYNC_TARGET);
        expect(only.confidence).toBe('declared');
        expect(only.claim).not.toMatch(/\{\w+\}/);
      });

      // A test-class DISPATCHER of a heuristic `future` hop still drops to
      // heuristic (weakest) in the test-only disclosure — confidence is computed
      // from the witness edges, not asserted.
      it('test-only weakest() — a heuristic future dispatch from a test class stays heuristic', () => {
        const slice: GroundedSlice = {
          nodes: [
            node(TEST_CALLER, 'ApexClass', { isTest: true }),
            node(ASYNC_TARGET, 'ApexClass', { isTest: false }),
          ],
          edges: [
            edge(TEST_CALLER, ASYNC_TARGET, 'dispatchesAsync', 'heuristic', {
              dispatchMechanism: 'future',
            }),
          ],
        };
        const only = interpret(rule, slice, COMPLETE, ASYNC_TARGET)[0]!;
        expect(only.confidence).toBe('heuristic');
        expect(only.claim).toContain('Test-only async dispatch');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// concept:external-api-surface — three class-marker NODE rules (concept #10).
// The API-surface markers are always-present ApexClass boolean properties
// (isRestResource / hasAuraEnabledMethod / hasInvocableMethod) already in the
// graph; no engine change, and DELIBERATELY no edge rule (the `exposes` edge is
// a 1:1 re-expression of the same boolean pointing at a synthetic non-resolving
// id, so a node rule alone carries the concept anchored on the real ApexClass).
// ---------------------------------------------------------------------------

describe('interpret — external-api-surface NODE rules', () => {
  const shipped = (id: string): ConceptRule => {
    const r = CONCEPT_RULES.find((rule) => rule.id === id);
    expect(r, `shipped ${id} must exist`).toBeDefined();
    return r!;
  };

  const CLS_PLAIN = 'ApexClass:Ns__PlainService';

  // (rule id, bound boolean property key, a distinctive phrase from the claim).
  const NODE_CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:external-api-surface/rest-resource', 'isRestResource', 'is a REST resource'],
    ['rule:external-api-surface/aura-enabled', 'hasAuraEnabledMethod', 'Lightning components (Aura/LWC)'],
    ['rule:external-api-surface/invocable', 'hasInvocableMethod', 'has @InvocableMethod method'],
  ];

  it.each(NODE_CASES)(
    '%s fires on an ApexClass whose %s === true, cites ONLY that class, confidence declared',
    (ruleId, key, phrase) => {
      const rule = shipped(ruleId);
      // A node-shaped rule: componentTypes ApexClass + equals:true on the marker,
      // no edge, presence-shaped, declared ceiling.
      expect(rule.concept).toBe('concept:external-api-surface');
      expect(rule.bind.componentTypes).toEqual(['ApexClass']);
      expect(rule.bind.whereProperty).toEqual({ key, equals: true });
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');

      const CLS = 'ApexClass:Ns__Marker';
      const slice: GroundedSlice = { nodes: [node(CLS, 'ApexClass', { [key]: true })], edges: [] };
      const out = interpret(rule, slice, COMPLETE, CLS);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:external-api-surface');
      // A node match cites ONLY the root class (never a neighbor) and carries no
      // edge confidence, so weakest() keeps the declared ceiling.
      expect(only.groundedIn).toEqual([CLS]);
      expect(only.confidence).toBe('declared');
      expect(only.coverageCaveat).toBeNull();
      expect(only.claim).toContain(CLS);
      expect(only.claim).toContain(phrase);
      // Every claim names the FLS/CRUD-not-auto-enforced boundary (record-level
      // sharing is a SEPARATE concern deferred to the without-sharing concept, no
      // longer folded into a false blanket "sharing not enforced")…
      expect(only.claim.toLowerCase()).toContain('not automatically enforced');
      // …and refuses to assert the endpoint is insecure.
      expect(only.claim.toLowerCase()).toContain('does not assert');
      // …and defers RECORD-LEVEL sharing to the class's with/without-sharing
      // declaration instead of the old false blanket "sharing not enforced".
      expect(only.claim.toLowerCase()).toContain('record-level sharing');
      expect(only.claim.toLowerCase()).toContain('without sharing');
    },
  );

  it('the Invocable claim is per-CLASS, not per-method (hasInvocableMethod is a genuine method marker)', () => {
    const CLS = 'ApexClass:Ns__Exposed';
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { hasInvocableMethod: true })],
      edges: [],
    };
    const only = interpret(shipped('rule:external-api-surface/invocable'), slice, COMPLETE, CLS)[0]!;
    expect(only.claim.toLowerCase()).toContain('per-class, not per-method');
  });

  it('the AuraEnabled claim hedges member-vs-method (hasAuraEnabledMethod is set from ANY @AuraEnabled token — a METHOD or a serialized property — so it must NOT over-claim a callable endpoint)', () => {
    const CLS = 'ApexClass:Ns__Exposed';
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { hasAuraEnabledMethod: true })],
      edges: [],
    };
    const only = interpret(shipped('rule:external-api-surface/aura-enabled'), slice, COMPLETE, CLS)[0]!;
    // The marker is class-level and does not distinguish a callable method from a
    // serialized DTO property, so the claim hedges and asks for confirmation…
    expect(only.claim.toLowerCase()).toContain('class-level');
    expect(only.claim.toLowerCase()).toContain('confirm whether a callable method is present');
    expect(only.claim.toLowerCase()).toContain('property exposes a serialized field');
    // …it must NOT flatly assert an @AuraEnabled METHOD (the old member-blind claim)…
    expect(only.claim.toLowerCase()).not.toContain('has @auraenabled method');
    // …and it must NOT mislabel the surface as the Salesforce "UI API" product.
    expect(only.claim.toLowerCase()).not.toContain('ui api');
  });

  it('a marker=false / absent-property ApexClass fires NONE of the three rules', () => {
    const falseSlice: GroundedSlice = {
      nodes: [
        node(CLS_PLAIN, 'ApexClass', {
          isRestResource: false,
          hasAuraEnabledMethod: false,
          hasInvocableMethod: false,
        }),
      ],
      edges: [],
    };
    const bareSlice: GroundedSlice = { nodes: [node(CLS_PLAIN, 'ApexClass', {})], edges: [] };
    for (const [ruleId] of NODE_CASES) {
      expect(interpret(shipped(ruleId), falseSlice, COMPLETE, CLS_PLAIN)).toEqual([]);
      expect(interpret(shipped(ruleId), bareSlice, COMPLETE, CLS_PLAIN)).toEqual([]);
    }
  });

  it('[type guard] a non-ApexClass node with a truthy marker does NOT fire (componentTypes scopes the match)', () => {
    const rule = shipped('rule:external-api-surface/aura-enabled');
    // A Flow that (nonsensically) declares hasAuraEnabledMethod must NOT be claimed.
    const slice: GroundedSlice = {
      nodes: [node('Flow:Ns__Odd', 'Flow', { hasAuraEnabledMethod: true })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Odd')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// concept:apex-sharing-mode — two class-declaration NODE rules (concept #11).
// The `sharingModel` property is an always-present ApexClass string already in
// the graph (`with sharing` | `without sharing` | `inherited sharing` | null);
// no engine change. Only the two security-relevant / context-dependent postures
// are built — `without sharing` (system context, sharing NOT enforced) and
// `inherited sharing` (enforcement depends on the caller). `with sharing` (safe
// default) and null/unspecified are DEFERRED, so a with-sharing or unspecified
// class fires NEITHER rule. The rules key the SAME `sharingModel` property as the
// OWD `owd-sharing-posture` concept, but the token spaces are DISJOINT (two-word
// lowercase here vs single-word PascalCase for CustomObject OWD) and
// componentTypes:[ApexClass] scopes them — proven below to be non-cross-firing.
// ---------------------------------------------------------------------------

describe('interpret — apex-sharing-mode NODE rules', () => {
  const shipped = (id: string): ConceptRule => {
    const r = CONCEPT_RULES.find((rule) => rule.id === id);
    expect(r, `shipped ${id} must exist`).toBeDefined();
    return r!;
  };

  const CLS = 'ApexClass:Ns__SharingService';
  const CLS_DEFAULT = 'ApexClass:Ns__WithSharingService';

  // (rule id, bound sharingModel value, a distinctive phrase from the claim).
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:apex-sharing/without-sharing', 'without sharing', 'system context'],
    ['rule:apex-sharing/inherited-sharing', 'inherited sharing', 'entry point'],
  ];

  it.each(CASES)(
    '%s fires on an ApexClass with its sharingModel token, cites ONLY that class, confidence declared',
    (ruleId, value, phrase) => {
      const rule = shipped(ruleId);
      // A node-shaped rule: componentTypes ApexClass + equals on sharingModel, no
      // edge, presence-shaped, declared ceiling.
      expect(rule.concept).toBe('concept:apex-sharing-mode');
      expect(rule.bind.componentTypes).toEqual(['ApexClass']);
      expect(rule.bind.whereProperty).toEqual({ key: 'sharingModel', equals: value });
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');

      const slice: GroundedSlice = {
        nodes: [node(CLS, 'ApexClass', { sharingModel: value })],
        edges: [],
      };
      const out = interpret(rule, slice, COMPLETE, CLS);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:apex-sharing-mode');
      // A node match cites ONLY the root class (never a neighbor) and carries no
      // edge confidence, so weakest() keeps the declared ceiling.
      expect(only.groundedIn).toEqual([CLS]);
      expect(only.confidence).toBe('declared');
      expect(only.coverageCaveat).toBeNull();
      expect(only.claim).toContain(CLS);
      expect(only.claim).toContain(value); // the backticked declaration token
      expect(only.claim.toLowerCase()).toContain(phrase);
    },
  );

  it('the without-sharing claim keeps its honesty boundaries — FLS/CRUD-separate, class-level, declared-not-proven', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { sharingModel: 'without sharing' })],
      edges: [],
    };
    const claim = interpret(shipped('rule:apex-sharing/without-sharing'), slice, COMPLETE, CLS)[0]!.claim;
    const lower = claim.toLowerCase();
    // Runs in system context and does NOT enforce the running user's record sharing.
    expect(lower).toContain('do not enforce');
    // Often intentional — NOT by itself a vulnerability (no over-claim).
    expect(lower).toContain('not by itself a vulnerability');
    // FLS / CRUD are a SEPARATE concern Apex also does not auto-enforce.
    expect(lower).toContain('field-level security and object crud are a separate concern');
    // The declaration is CLASS-level, not per-method; a callee that declares NO sharing
    // keyword runs in THIS class's sharing context (without sharing can silently propagate).
    expect(lower).toContain('class-level, not per-method');
    // Declared posture, never a proven runtime access outcome.
    expect(lower).toContain('not a proven access outcome');
  });

  it('the inherited-sharing claim fences enforcement to the execution context (depends on the caller / entry point)', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { sharingModel: 'inherited sharing' })],
      edges: [],
    };
    const claim = interpret(shipped('rule:apex-sharing/inherited-sharing'), slice, COMPLETE, CLS)[0]!.claim;
    const lower = claim.toLowerCase();
    // Runs with the CALLER's sharing mode; enforces when it is the ENTRY POINT.
    expect(lower).toContain('caller');
    expect(lower).toContain('entry point');
    // Whether sharing is enforced DEPENDS on the execution context.
    expect(lower).toContain('depends on the execution context');
    // Declared posture, never a proven runtime access outcome.
    expect(lower).toContain('not a proven access outcome');
  });

  it('a `with sharing` (safe default) ApexClass fires NEITHER built rule — the default is deliberately not claimed', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS_DEFAULT, 'ApexClass', { sharingModel: 'with sharing' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(shipped(ruleId), slice, COMPLETE, CLS_DEFAULT)).toEqual([]);
    }
  });

  it('a null / unspecified-sharing ApexClass (no keyword) fires NEITHER built rule', () => {
    // sharingModel: null — the extractor's value for a class that declares no mode.
    const nullSlice: GroundedSlice = {
      nodes: [node(CLS_DEFAULT, 'ApexClass', { sharingModel: null })],
      edges: [],
    };
    // …and the bare/absent-property shape must be equally inert.
    const bareSlice: GroundedSlice = { nodes: [node(CLS_DEFAULT, 'ApexClass', {})], edges: [] };
    for (const [ruleId] of CASES) {
      expect(interpret(shipped(ruleId), nullSlice, COMPLETE, CLS_DEFAULT)).toEqual([]);
      expect(interpret(shipped(ruleId), bareSlice, COMPLETE, CLS_DEFAULT)).toEqual([]);
    }
  });

  it('[no OWD cross-contamination] the disjoint token space keeps ApexClass and CustomObject sharingModel rules apart', () => {
    // An ApexClass declared `without sharing` must NOT trip any OWD CustomObject
    // rule (which keys the SAME `sharingModel` property but PascalCase tokens)…
    const apexSlice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { sharingModel: 'without sharing' })],
      edges: [],
    };
    expect(interpret(shipped('rule:sharing/owd-private'), apexSlice, COMPLETE, CLS)).toEqual([]);
    expect(interpret(shipped('rule:sharing/owd-public-readwrite'), apexSlice, COMPLETE, CLS)).toEqual([]);
    // …and a CustomObject with a PascalCase OWD token must NOT trip the Apex rules,
    // even though it keys the same property — componentTypes:[ApexClass] scopes them.
    const objSlice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__ObjA__c', 'CustomObject', { sharingModel: 'Private' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(shipped(ruleId), objSlice, COMPLETE, 'CustomObject:Ns__ObjA__c')).toEqual([]);
    }
  });

  it('[type guard] a non-ApexClass node carrying an Apex sharing token does NOT fire (componentTypes scopes the match)', () => {
    const rule = shipped('rule:apex-sharing/without-sharing');
    // A Flow that (nonsensically) declares sharingModel `without sharing` must NOT be claimed.
    const slice: GroundedSlice = {
      nodes: [node('Flow:Ns__Odd', 'Flow', { sharingModel: 'without sharing' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Odd')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// interpret — polymorphic whereProperty AND-array (engine capability).
// A node predicate whose `whereProperty` is a NON-EMPTY array matches a node
// only when EVERY clause holds (AND); a scalar `whereProperty` keeps its exact
// prior single-clause behavior. Synthetic ids only — no real org.
// ---------------------------------------------------------------------------

describe('interpret — whereProperty AND-array (polymorphic node predicate)', () => {
  const CLS = 'ApexClass:Ns__AndTarget';
  const arrayRule: ConceptRule = {
    id: 'rule-and-array',
    concept: 'concept:apex-sharing-mode',
    bind: {
      componentTypes: ['ApexClass'],
      whereProperty: [
        { key: 'sharingModel', equals: 'without sharing' },
        { key: 'hasAuraEnabledMethod', equals: true },
        { key: 'isTest', equals: false },
      ],
    },
    interpretation: '{ids} is without-sharing AND externally reachable',
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: ['ApexClass'],
  };

  it('fires only when ALL clauses hold (AND), citing ONLY the root, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(CLS, 'ApexClass', {
          sharingModel: 'without sharing',
          hasAuraEnabledMethod: true,
          isTest: false,
        }),
      ],
      edges: [],
    };
    const out = interpret(arrayRule, slice, COMPLETE, CLS);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([CLS]);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.coverageCaveat).toBeNull();
  });

  it('does NOT fire when a single clause is false (one-false ⇒ no match)', () => {
    // The first two clauses hold; `isTest: true` breaks the third.
    const slice: GroundedSlice = {
      nodes: [
        node(CLS, 'ApexClass', {
          sharingModel: 'without sharing',
          hasAuraEnabledMethod: true,
          isTest: true,
        }),
      ],
      edges: [],
    };
    expect(interpret(arrayRule, slice, COMPLETE, CLS)).toEqual([]);
  });

  it('does NOT fire when a clause key is absent (strict === against undefined)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(CLS, 'ApexClass', {
          sharingModel: 'without sharing',
          // hasAuraEnabledMethod absent → its clause is undefined === true → false
          isTest: false,
        }),
      ],
      edges: [],
    };
    expect(interpret(arrayRule, slice, COMPLETE, CLS)).toEqual([]);
  });

  it('a scalar whereProperty keeps its exact prior single-clause behavior', () => {
    const scalarRule: ConceptRule = {
      ...arrayRule,
      id: 'rule-scalar',
      bind: {
        componentTypes: ['ApexClass'],
        whereProperty: { key: 'sharingModel', equals: 'without sharing' },
      },
    };
    const match: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { sharingModel: 'without sharing' })],
      edges: [],
    };
    const noMatch: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { sharingModel: 'with sharing' })],
      edges: [],
    };
    expect(interpret(scalarRule, match, COMPLETE, CLS)).toHaveLength(1);
    expect(interpret(scalarRule, noMatch, COMPLETE, CLS)).toEqual([]);
  });

  it('a single-element AND-array is equivalent to the scalar form', () => {
    const oneEl: ConceptRule = {
      ...arrayRule,
      id: 'rule-one-el',
      bind: {
        componentTypes: ['ApexClass'],
        whereProperty: [{ key: 'sharingModel', equals: 'without sharing' }],
      },
    };
    const match: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { sharingModel: 'without sharing' })],
      edges: [],
    };
    expect(interpret(oneEl, match, COMPLETE, CLS)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// interpret — operator-class whereProperty (in / notIn / neq engine capability).
// A NODE predicate whose `whereProperty` carries a set/inequality operator fires
// on a MEMBER value and refuses a non-member, composing with `componentTypes` and
// the AND-array. Synthetic ids only — no real org. Proves the engine capability
// the firing-condition upgrade rests on.
// ---------------------------------------------------------------------------

describe('interpret — operator-class whereProperty (in / notIn / neq)', () => {
  const CC = 'ConditionalContext:Ns__OperatorProbe.condition-0';
  const inRule: ConceptRule = {
    id: 'rule-in',
    concept: 'concept:firing-condition',
    bind: {
      componentTypes: ['ConditionalContext'],
      whereProperty: { key: 'kind', in: ['criteria', 'formula', 'flow-recordtrigger'] },
    },
    interpretation: '{ids} is an entry-condition kind',
    maxConfidence: 'parsed',
    absenceShaped: false,
    dependsOnCoverage: ['ValidationRule'],
  };

  const fireWithKind = (rule: ConceptRule, kind: string): ReturnType<typeof interpret> =>
    interpret(rule, { nodes: [node(CC, 'ConditionalContext', { kind })], edges: [] }, COMPLETE, CC);

  it('`in`: fires on EACH member kind, cites the node at the parsed ceiling', () => {
    for (const kind of ['criteria', 'formula', 'flow-recordtrigger']) {
      const out = fireWithKind(inRule, kind);
      expect(out).toHaveLength(1);
      expect(out[0]!.groundedIn).toEqual([CC]);
      expect(out[0]!.confidence).toBe('parsed');
    }
  });

  it('`in`: refuses a NON-member kind (flow-decision) — no citation, no claim', () => {
    expect(fireWithKind(inRule, 'flow-decision')).toEqual([]);
  });

  it('`notIn` is the exact complement of `in` over the kinds', () => {
    const notInRule: ConceptRule = {
      ...inRule,
      id: 'rule-notin',
      bind: {
        componentTypes: ['ConditionalContext'],
        whereProperty: { key: 'kind', notIn: ['flow-decision'] },
      },
    };
    expect(fireWithKind(notInRule, 'formula')).toHaveLength(1);
    expect(fireWithKind(notInRule, 'flow-decision')).toEqual([]);
  });

  it('`neq`: fires on any value other than the excluded one', () => {
    const neqRule: ConceptRule = {
      ...inRule,
      id: 'rule-neq',
      bind: {
        componentTypes: ['ConditionalContext'],
        whereProperty: { key: 'kind', neq: 'flow-decision' },
      },
    };
    expect(fireWithKind(neqRule, 'criteria')).toHaveLength(1);
    expect(fireWithKind(neqRule, 'flow-decision')).toEqual([]);
  });

  it('composes an `in` clause with an equals clause in an AND-array (both must hold)', () => {
    const compound: ConceptRule = {
      ...inRule,
      id: 'rule-in-and-equals',
      bind: {
        componentTypes: ['ConditionalContext'],
        whereProperty: [
          { key: 'synthesized', equals: false },
          { key: 'kind', in: ['criteria', 'formula', 'flow-recordtrigger'] },
        ],
      },
    };
    const fires: GroundedSlice = {
      nodes: [node(CC, 'ConditionalContext', { kind: 'formula', synthesized: false })],
      edges: [],
    };
    // The equals clause fails (synthesized true) → the whole AND fails.
    const blocked: GroundedSlice = {
      nodes: [node(CC, 'ConditionalContext', { kind: 'formula', synthesized: true })],
      edges: [],
    };
    expect(interpret(compound, fires, COMPLETE, CC)).toHaveLength(1);
    expect(interpret(compound, blocked, COMPLETE, CC)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// interpret — system-context-external-surface COMPOUND NODE rules.
// The FIRST consumer of the whereProperty AND-array: each rule requires THREE
// grounded ApexClass properties at once — `sharingModel == 'without sharing'`,
// an external marker == true, and `isTest == false`. The compound ADDS a third
// claim alongside the co-firing apex-sharing-mode (without) + external-api-surface
// claims; it does not replace them. Synthetic ids — no real org.
// ---------------------------------------------------------------------------

describe('interpret — system-context-external-surface COMPOUND NODE rules', () => {
  const shipped = (id: string): ConceptRule => {
    const r = CONCEPT_RULES.find((rule) => rule.id === id);
    expect(r, `shipped ${id} must exist`).toBeDefined();
    return r!;
  };

  const CLS = 'ApexClass:Ns__SystemExternal';

  // (rule id, external-marker key, a distinctive phrase from the claim).
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:system-context-external-surface/rest-resource', 'isRestResource', 'rest endpoint'],
    ['rule:system-context-external-surface/aura-enabled', 'hasAuraEnabledMethod', 'lightning components'],
    ['rule:system-context-external-surface/invocable', 'hasInvocableMethod', '@invocablemethod'],
  ];

  it.each(CASES)(
    '%s binds the 3-clause AND-array (without-sharing + marker + not-test), declared, presence-shaped',
    (ruleId, marker) => {
      const rule = shipped(ruleId);
      expect(rule.concept).toBe('concept:system-context-external-surface');
      expect(rule.bind.componentTypes).toEqual(['ApexClass']);
      // A NON-scalar whereProperty: a 3-clause AND-array in fixed order.
      expect(rule.bind.whereProperty).toEqual([
        { key: 'sharingModel', equals: 'without sharing' },
        { key: marker, equals: true },
        { key: 'isTest', equals: false },
      ]);
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');
      expect(rule.dependsOnCoverage).toEqual(['ApexClass']);
    },
  );

  it.each(CASES)(
    '%s FIRES when without-sharing + marker + non-test all hold, cites ONLY the class, declared, no caveat',
    (ruleId, marker, phrase) => {
      const rule = shipped(ruleId);
      const slice: GroundedSlice = {
        nodes: [
          node(CLS, 'ApexClass', {
            sharingModel: 'without sharing',
            [marker]: true,
            isTest: false,
          }),
        ],
        edges: [],
      };
      const out = interpret(rule, slice, COMPLETE, CLS);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:system-context-external-surface');
      expect(only.groundedIn).toEqual([CLS]);
      expect(only.confidence).toBe('declared');
      expect(only.coverageCaveat).toBeNull();
      expect(only.claim).toContain(CLS);
      const lower = only.claim.toLowerCase();
      // Names BOTH sides of the conjunction and the reachability consequence…
      expect(lower).toContain('without sharing');
      expect(lower).toContain(phrase);
      expect(lower).toContain('system context');
      // …frames it as a review priority, not an asserted vulnerability…
      expect(lower).toContain('security-review priority');
      expect(lower).toContain('not by itself a vulnerability');
      // …keeps FLS/CRUD a separate concern and refuses to over-claim.
      expect(lower).toContain('separate concern');
      expect(lower).toContain('not a proven access outcome');
    },
  );

  it('[negative control — first clause] a `with sharing` class with the marker does NOT fire (proves the AND gates on sharing, not just the marker)', () => {
    for (const [ruleId, marker] of CASES) {
      const slice: GroundedSlice = {
        nodes: [
          node(CLS, 'ApexClass', {
            sharingModel: 'with sharing',
            [marker]: true,
            isTest: false,
          }),
        ],
        edges: [],
      };
      expect(interpret(shipped(ruleId), slice, COMPLETE, CLS)).toEqual([]);
    }
  });

  it('[negative control — third clause] a test (isTest=true) without-sharing external class does NOT fire (the isTest guard filters scaffolding)', () => {
    for (const [ruleId, marker] of CASES) {
      const slice: GroundedSlice = {
        nodes: [
          node(CLS, 'ApexClass', {
            sharingModel: 'without sharing',
            [marker]: true,
            isTest: true,
          }),
        ],
        edges: [],
      };
      expect(interpret(shipped(ruleId), slice, COMPLETE, CLS)).toEqual([]);
    }
  });

  it('[negative control — second clause] a without-sharing class with the marker FALSE does NOT fire', () => {
    for (const [ruleId, marker] of CASES) {
      const slice: GroundedSlice = {
        nodes: [
          node(CLS, 'ApexClass', {
            sharingModel: 'without sharing',
            [marker]: false,
            isTest: false,
          }),
        ],
        edges: [],
      };
      expect(interpret(shipped(ruleId), slice, COMPLETE, CLS)).toEqual([]);
    }
  });

  it('[type guard] a non-ApexClass node with all three properties does NOT fire (componentTypes scopes the match)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node('Flow:Ns__Odd', 'Flow', {
          sharingModel: 'without sharing',
          hasAuraEnabledMethod: true,
          isTest: false,
        }),
      ],
      edges: [],
    };
    expect(
      interpret(shipped('rule:system-context-external-surface/aura-enabled'), slice, COMPLETE, 'Flow:Ns__Odd'),
    ).toEqual([]);
  });

  it('[coexistence] on a fired class the compound ADDS a third claim alongside apex-sharing(without) + external-api(aura) — it does not replace them', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(CLS, 'ApexClass', {
          sharingModel: 'without sharing',
          hasAuraEnabledMethod: true,
          isTest: false,
        }),
      ],
      edges: [],
    };
    const compound = interpret(
      shipped('rule:system-context-external-surface/aura-enabled'),
      slice,
      COMPLETE,
      CLS,
    );
    const sharing = interpret(shipped('rule:apex-sharing/without-sharing'), slice, COMPLETE, CLS);
    const external = interpret(shipped('rule:external-api-surface/aura-enabled'), slice, COMPLETE, CLS);
    // All three co-fire on the SAME class, each a distinct proposition citing it.
    expect(compound).toHaveLength(1);
    expect(sharing).toHaveLength(1);
    expect(external).toHaveLength(1);
    expect(compound[0]!.concept).toBe('concept:system-context-external-surface');
    expect(sharing[0]!.concept).toBe('concept:apex-sharing-mode');
    expect(external[0]!.concept).toBe('concept:external-api-surface');
  });
});

// ---------------------------------------------------------------------------
// RM-reason — view-modify-all object-grant EDGE rules. TWO edge rules over the
// `grantedBy` edge (PermissionSet/Profile --grantedBy--> CustomObject), keyed on
// the edge's OWN boolean `viewAllRecords` / `modifyAllRecords` property. Same
// shape as master-detail-cascade / dispatches-async. All ids GENERIC synthetic.
// Proves: BOTH anchor directions cite honestly (object anchor -> its grantors +
// itself; permset/profile anchor -> its objects + itself); the {ids} template
// renders every cited id with no positional leak; Modify⊆View co-firing reads as
// ONE escalating grant; a view-all-only grant fires only view-all; a grant of
// neither fires nothing; a dangling (unretrieved) object endpoint is never
// fabricated; and confidence is DERIVED (a heuristic edge drops the ceiling).
// ---------------------------------------------------------------------------

describe('interpret — view-modify-all object-grant EDGE rules', () => {
  const shipped = (id: string): ConceptRule => {
    const r = CONCEPT_RULES.find((rule) => rule.id === id);
    expect(r, `shipped ${id} must exist`).toBeDefined();
    return r!;
  };
  const VIEW = 'rule:access/view-all-records';
  const MODIFY = 'rule:access/modify-all-records';

  const OBJ = 'CustomObject:Ns__Deal__c';
  const PERMSET = 'PermissionSet:Ns__ReadAll';
  const PERMSET_2 = 'PermissionSet:Ns__AdminAll';
  const PROFILE = 'Profile:Ns__Ops';
  const OBJ_2 = 'CustomObject:Ns__Invoice__c';

  it('both rules are declared, presence-shaped grantedBy edge rules scoped to PermissionSet/Profile/CustomObject citations', () => {
    for (const [id, key] of [[VIEW, 'viewAllRecords'], [MODIFY, 'modifyAllRecords']] as const) {
      const rule = shipped(id);
      expect(rule.concept).toBe('concept:view-modify-all');
      expect(rule.bind.edgeType).toBe('grantedBy');
      expect(rule.bind.componentTypes).toEqual(['PermissionSet', 'Profile', 'CustomObject']);
      expect(rule.bind.edgeWhereProperty).toEqual({ key, equals: true });
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');
    }
  });

  it('OBJECT anchor — view-all cites the object + every granting permission set/profile (the ENUMERATED SET), confidence declared', () => {
    // Two grantors (a permission set + a profile) grant View All on the object.
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(PERMSET, 'PermissionSet'), node(PROFILE, 'Profile')],
      edges: [
        edge(PERMSET, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false }),
        edge(PROFILE, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false }),
      ],
    };
    const out = interpret(shipped(VIEW), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    // Incident edges are toId===root; endpoints [grantor, object] both cited, deduped
    // in match order → [grantor1, object, grantor2]. The object AND both grantors are cited.
    expect(only.groundedIn).toEqual([PERMSET, OBJ, PROFILE]);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(OBJ);
    expect(only.claim).toContain(PERMSET);
    expect(only.claim).toContain(PROFILE);
    expect(only.claim).toContain('View All Records');
    expect(only.claim.toLowerCase()).toContain('regardless of');
    expect(only.claim).not.toMatch(/\{\d+\}/); // no unfilled positional token
    expect(only.claim).not.toContain('{ids}'); // the {ids} token itself is filled
  });

  it('PERMSET anchor — view-all cites the permission set + every object it grants View All on', () => {
    // One permission set grants View All on two objects.
    const slice: GroundedSlice = {
      nodes: [node(PERMSET, 'PermissionSet'), node(OBJ, 'CustomObject'), node(OBJ_2, 'CustomObject')],
      edges: [
        edge(PERMSET, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false }),
        edge(PERMSET, OBJ_2, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false }),
      ],
    };
    const out = interpret(shipped(VIEW), slice, COMPLETE, PERMSET);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    // Outgoing edges fromId===root; endpoints [permset, object], deduped → [permset, obj1, obj2].
    expect(only.groundedIn).toEqual([PERMSET, OBJ, OBJ_2]);
    expect(only.claim).toContain(PERMSET);
    expect(only.claim).toContain(OBJ);
    expect(only.claim).toContain(OBJ_2);
    expect(only.claim).not.toMatch(/\{\d+\}/);
  });

  it('a grant with viewAllRecords FALSE (a plain read/edit grant) fires NEITHER rule (edgeWhereProperty matches the edge\'s own boolean)', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(PERMSET, 'PermissionSet')],
      edges: [
        edge(PERMSET, OBJ, 'grantedBy', 'declared', {
          allowRead: true, allowEdit: true, viewAllRecords: false, modifyAllRecords: false,
        }),
      ],
    };
    expect(interpret(shipped(VIEW), slice, COMPLETE, OBJ)).toEqual([]);
    expect(interpret(shipped(MODIFY), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('ESCALATION — a Modify-All grant (viewAll=true AND modifyAll=true) fires BOTH rules on the SAME grant; the modify-all claim reads as the stronger form that INCLUDES View All', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(PERMSET, 'PermissionSet')],
      edges: [
        edge(PERMSET, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: true }),
      ],
    };
    const view = interpret(shipped(VIEW), slice, COMPLETE, OBJ);
    const modify = interpret(shipped(MODIFY), slice, COMPLETE, OBJ);
    // Both fire on the ONE grant edge, each citing the same two endpoints.
    expect(view).toHaveLength(1);
    expect(modify).toHaveLength(1);
    expect(view[0]!.groundedIn).toEqual([PERMSET, OBJ]);
    expect(modify[0]!.groundedIn).toEqual([PERMSET, OBJ]);
    // The modify-all wording frames it as an escalation of the SAME grant, not a
    // second independent one — so co-firing with view-all is coherent.
    const mClaim = modify[0]!.claim;
    expect(mClaim).toContain('Modify All Records');
    expect(mClaim).toContain('STRONGER');
    expect(mClaim).toContain('INCLUDES View All');
    expect(mClaim.toLowerCase()).toContain('read, edit, and delete');
    expect(modify[0]!.concept).toBe('concept:view-modify-all');
  });

  it('the MODIFY-all rule does NOT fire on a View-all-ONLY grant (modifyAllRecords false)', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(PERMSET_2, 'PermissionSet')],
      edges: [
        edge(PERMSET_2, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false }),
      ],
    };
    expect(interpret(shipped(MODIFY), slice, COMPLETE, OBJ)).toEqual([]);
    // …while the view-all rule DOES fire on the same grant.
    expect(interpret(shipped(VIEW), slice, COMPLETE, OBJ)).toHaveLength(1);
  });

  it('a PERMSET anchor granting View All on an UNRETRIEVED object cites ONLY the permission set (dangling endpoint never fabricated, not a self-reference skip)', () => {
    // The object endpoint is absent from the slice (a standard object referenced by
    // objectPermissions but not modeled) — the same dangling guard master-detail
    // uses: the grant still fires, citing the resolved permission set alone.
    const UNRETRIEVED = 'CustomObject:Account';
    const slice: GroundedSlice = {
      nodes: [node(PERMSET, 'PermissionSet')],
      edges: [
        edge(PERMSET, UNRETRIEVED, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false }),
      ],
    };
    const out = interpret(shipped(VIEW), slice, COMPLETE, PERMSET);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([PERMSET]);
    expect(out[0]!.groundedIn).not.toContain(UNRETRIEVED);
    expect(out[0]!.claim).not.toMatch(/\{\d+\}/);
  });

  it('an object with NO View/Modify All grant (no grantedBy edge, or only ordinary grants) fires NEITHER rule', () => {
    const slice: GroundedSlice = { nodes: [node(OBJ, 'CustomObject')], edges: [] };
    expect(interpret(shipped(VIEW), slice, COMPLETE, OBJ)).toEqual([]);
    expect(interpret(shipped(MODIFY), slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('confidence is DERIVED not asserted — a heuristic grantedBy edge drops the declared ceiling to heuristic via weakest()', () => {
    // The real extractor always emits `declared` grantedBy edges, but the engine must
    // still compute the confidence from the ground, never assert the rule ceiling.
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(PERMSET, 'PermissionSet')],
      edges: [
        edge(PERMSET, OBJ, 'grantedBy', 'heuristic', { viewAllRecords: true, modifyAllRecords: false }),
      ],
    };
    const only = interpret(shipped(VIEW), slice, COMPLETE, OBJ)[0]!;
    expect(only.confidence).toBe(weakest('declared', 'heuristic'));
    expect(only.confidence).toBe('heuristic');
  });

  it('the view-all + modify-all claims keep their honesty boundaries verbatim (FLS not bypassed, NOT the org-wide View/Modify All Data system perm, WHO-holds not asserted, declared-not-proven)', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(PERMSET, 'PermissionSet')],
      edges: [
        edge(PERMSET, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: true }),
      ],
    };
    const vClaim = interpret(shipped(VIEW), slice, COMPLETE, OBJ)[0]!.claim.toLowerCase();
    const mClaim = interpret(shipped(MODIFY), slice, COMPLETE, OBJ)[0]!.claim.toLowerCase();
    for (const claim of [vClaim, mClaim]) {
      // object-level only — does NOT bypass field-level security.
      expect(claim).toContain('field-level security');
      // NOT the org-wide View/Modify All DATA system permission (broader, separate).
      expect(claim).toContain('system permission');
      // does NOT assert WHO HOLDS the permission set/profile (assignment question).
      expect(claim).toContain('holds');
      // it is the DECLARED grant, not a proven per-user access outcome.
      expect(claim).toContain('declared');
      expect(claim).toContain('not a proof');
    }
    // The view-all-DATA / modify-all-DATA system-permission distinction is named per rule.
    expect(vClaim).toContain('view all data');
    expect(mClaim).toContain('modify all data');
  });

  // ---- REASONING-VIEW-MODIFY-ALL-MIXES-SYSTEM-PERMS (system-perm partition) ----
  // A grantor whose View/Modify-All actually comes from the org-wide View All Data /
  // Modify All Data SYSTEM permission must NOT be presented as a clean object-level
  // grant. The system perm lives on the grantor node's `userPermissions` array; the
  // object-level grant is the edge's `viewAllRecords`/`modifyAllRecords` boolean.
  const SYS_PERMS = (perms: readonly string[]): Record<string, unknown> => ({ userPermissions: perms });

  it('[MIXED] view-all EXCLUDES a grantor that holds ViewAllData (system) and DISCLOSES it, keeping the clean object-level grantor', () => {
    const CLEAN = 'PermissionSet:Ns__CleanReadAll';
    const SYS = 'Profile:Ns__SysAdmin';
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        node(CLEAN, 'PermissionSet'), // no system perm → a genuine object-level grant
        node(SYS, 'Profile', SYS_PERMS(['ViewAllData'])), // view-all here is the system perm
      ],
      edges: [
        edge(CLEAN, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false }),
        edge(SYS, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false }),
      ],
    };
    const out = interpret(shipped(VIEW), slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    // The system-perm grantor is EXCLUDED from the clean object-level citation.
    // (Pre-fix cited BOTH grantors as clean object-level grants → this FAILS.)
    expect(only.groundedIn).toEqual([CLEAN, OBJ]);
    expect(only.groundedIn).not.toContain(SYS);
    // …but it is still DISCLOSED in the suffix (nothing hidden).
    expect(only.claim).toContain(SYS);
    expect(only.claim).toContain('EXCLUDED from the object-level list');
    expect(only.claim.toLowerCase()).toContain('read-all-data system permission');
    expect(only.confidence).toBe('declared');
  });

  it('[WITNESS-ONLY] view-all on an object whose ONLY grantor holds ViewAllData refuses the clean object-level claim', () => {
    const SYS = 'PermissionSet:Ns__SysReadAll';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(SYS, 'PermissionSet', SYS_PERMS(['ViewAllData']))],
      edges: [edge(SYS, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false })],
    };
    const only = interpret(shipped(VIEW), slice, COMPLETE, OBJ)[0]!;
    // Still cites the grantor + object (nothing hidden), but refuses the clean claim.
    expect(only.groundedIn).toEqual([SYS, OBJ]);
    expect(only.claim).toContain('NOT a clean object-level grant');
    // Pre-fix presented this AS a clean object-level grant.
    expect(only.claim).not.toContain('Object-level View All Records grant among');
  });

  it('[OR array] view-all ALSO excludes a grantor holding only ModifyAllData (Modify All Data confers read-all too)', () => {
    const MOD = 'Profile:Ns__ModAllOnly';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(MOD, 'Profile', SYS_PERMS(['ModifyAllData']))],
      edges: [edge(MOD, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false })],
    };
    const only = interpret(shipped(VIEW), slice, COMPLETE, OBJ)[0]!;
    // ModifyAllData confers read-all-data, so the view-all rule excludes it too.
    expect(only.claim).toContain('NOT a clean object-level grant');
  });

  it('[asymmetry] modify-all KEEPS a grantor holding only ViewAllData (View All Data does NOT confer modify) — a genuine object-level modify grant', () => {
    const VIEW_ONLY = 'PermissionSet:Ns__ViewOnlyGrantor';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(VIEW_ONLY, 'PermissionSet', SYS_PERMS(['ViewAllData']))],
      edges: [edge(VIEW_ONLY, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: true })],
    };
    const only = interpret(shipped(MODIFY), slice, COMPLETE, OBJ)[0]!;
    // ViewAllData does NOT grant modify, so the object-level Modify All grant is
    // genuine and stays in the clean citation (PRIMARY-ONLY, base claim).
    expect(only.groundedIn).toEqual([VIEW_ONLY, OBJ]);
    expect(only.claim).toContain('Object-level Modify All Records grant among');
    expect(only.claim).not.toContain('NOT a clean object-level grant');
  });

  it('[MODIFY witness] modify-all EXCLUDES a grantor holding ModifyAllData (system)', () => {
    const MOD = 'Profile:Ns__ModAllHolder';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(MOD, 'Profile', SYS_PERMS(['ModifyAllData']))],
      edges: [edge(MOD, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: true })],
    };
    const only = interpret(shipped(MODIFY), slice, COMPLETE, OBJ)[0]!;
    expect(only.claim).toContain('NOT a clean object-level grant');
  });

  it('[PRIMARY-ONLY regression] a grantor with unrelated userPermissions is NOT a witness — the base claim is byte-identical', () => {
    const G = 'PermissionSet:Ns__OrdinaryGrantor';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(G, 'PermissionSet', SYS_PERMS(['ApiEnabled', 'ManageUsers']))],
      edges: [edge(G, OBJ, 'grantedBy', 'declared', { viewAllRecords: true, modifyAllRecords: false })],
    };
    const only = interpret(shipped(VIEW), slice, COMPLETE, OBJ)[0]!;
    // No read-all-data system perm → clean object-level grant, cited normally.
    expect(only.groundedIn).toEqual([G, OBJ]);
    expect(only.claim).toContain('Object-level View All Records grant among');
    expect(only.claim).not.toContain('EXCLUDED from the object-level list');
    expect(only.claim).not.toContain('NOT a clean object-level grant');
  });
});

// ---------------------------------------------------------------------------
// interpret — firstMatchOrdinal AGGREGATE (EC-14 / D10). Assignment rules
// evaluate entries top-down; a catch-all entry starves later specific ones.
// FAIL CLOSED when entryIndex or criteria metadata is missing.
// ---------------------------------------------------------------------------

describe('interpret — assignment-escalation-first-match-ordering AGGREGATE (EC-14 firstMatchOrdinal)', () => {
  const RULE = 'AssignmentRule:Case.Ns__Routing';
  const CATCH_ALL = 'Queue:Ns__Default';
  const SPECIFIC = 'Queue:Ns__Priority';
  const SPECIFIC_B = 'Queue:Ns__VIP';

  const shipped = (): ConceptRule => {
    const r = CONCEPT_RULES.find(
      (rule) => rule.id === 'rule:automation/assignment-escalation-first-match-ordering',
    );
    expect(r, 'shipped D10 rule must exist').toBeDefined();
    return r!;
  };

  const assignEdge = (
    toId: string,
    entryIndex: number,
    criteriaItemCount: number,
    hasFormula = false,
  ): Edge =>
    edge(RULE, toId, 'references', 'declared', {
      entryIndex,
      criteriaItemCount,
      hasFormula,
      assignedToType: 'Queue',
    });

  it('fires when a catch-all entry precedes a specific entry — cites [rule, catch-all, starved]', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(RULE, 'AssignmentRule', { active: true, ruleEntryCount: 2 }),
        node(CATCH_ALL, 'Queue'),
        node(SPECIFIC, 'Queue'),
      ],
      edges: [
        assignEdge(CATCH_ALL, 0, 0, false),
        assignEdge(SPECIFIC, 1, 2, false),
      ],
    };
    const out = interpret(shipped(), slice, COMPLETE, RULE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:assignment-escalation-first-match-ordering');
    expect(only.groundedIn).toEqual([RULE, CATCH_ALL, SPECIFIC]);
    expect(only.claim).toContain('catch-all');
    expect(only.claim).toContain('entry 0');
    expect(only.confidence).toBe('declared');
  });

  it('does NOT fire when every entry has criteria (no catch-all)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(RULE, 'AssignmentRule', { active: true }),
        node(SPECIFIC, 'Queue'),
        node(SPECIFIC_B, 'Queue'),
      ],
      edges: [
        assignEdge(SPECIFIC, 0, 1, false),
        assignEdge(SPECIFIC_B, 1, 2, false),
      ],
    };
    expect(interpret(shipped(), slice, COMPLETE, RULE)).toEqual([]);
  });

  it('does NOT fire when catch-all is the ONLY entry', () => {
    const slice: GroundedSlice = {
      nodes: [node(RULE, 'AssignmentRule'), node(CATCH_ALL, 'Queue')],
      edges: [assignEdge(CATCH_ALL, 0, 0, false)],
    };
    expect(interpret(shipped(), slice, COMPLETE, RULE)).toEqual([]);
  });

  it('[fail closed] yields [] when any counted edge lacks entryIndex', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(RULE, 'AssignmentRule'),
        node(CATCH_ALL, 'Queue'),
        node(SPECIFIC, 'Queue'),
      ],
      edges: [
        assignEdge(CATCH_ALL, 0, 0, false),
        edge(RULE, SPECIFIC, 'references', 'declared', {
          criteriaItemCount: 2,
          hasFormula: false,
          assignedToType: 'Queue',
        }),
      ],
    };
    expect(interpret(shipped(), slice, COMPLETE, RULE)).toEqual([]);
  });

  it('[fail closed] yields [] when any counted edge lacks criteriaItemCount', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(RULE, 'AssignmentRule'),
        node(CATCH_ALL, 'Queue'),
        node(SPECIFIC, 'Queue'),
      ],
      edges: [
        assignEdge(CATCH_ALL, 0, 0, false),
        edge(RULE, SPECIFIC, 'references', 'declared', {
          entryIndex: 1,
          hasFormula: false,
          assignedToType: 'Queue',
        }),
      ],
    };
    expect(interpret(shipped(), slice, COMPLETE, RULE)).toEqual([]);
  });

  it('treats formula-only entry as specific (not broad)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(RULE, 'AssignmentRule'),
        node(CATCH_ALL, 'Queue'),
        node(SPECIFIC, 'Queue'),
      ],
      edges: [
        assignEdge(SPECIFIC, 0, 0, true),
        assignEdge(CATCH_ALL, 1, 0, false),
      ],
    };
    // catch-all is second — no starvation of earlier formula entry
    expect(interpret(shipped(), slice, COMPLETE, RULE)).toEqual([]);
  });
});
