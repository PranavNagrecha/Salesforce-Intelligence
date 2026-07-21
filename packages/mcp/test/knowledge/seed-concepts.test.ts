/// <reference types="vitest/globals" />

/**
 * RM-2 — reasoning proofs for the three seed concepts.
 *
 * Each proof assembles a SYNTHETIC grounded slice (`Ns__…` ids — synthetic,
 * NOT a real org) and runs the SHIPPED `CONCEPT_RULES` through the pure
 * `interpret` engine, then asserts the actual `Interpretation`. These
 * deterministic tests ARE the reasoning proof for the three concepts:
 *
 *   1. status-code       — cites the matched automation ids; a heuristic
 *                          `triggersOn` edge caps the declared-max rule to
 *                          `heuristic` via `weakest(...)`.
 *   2. field-provenance  — matches ONLY the `isFormula === true` (formula /
 *                          derived) field; the claim contains "read-only";
 *                          confidence `declared` (node matches carry no edge
 *                          confidence).
 *   3. relationship      — master-detail cascade + roll-up summary rules (see
 *                          the dedicated describe blocks below).
 *
 * The former `save-order` phase-order rule is DEFERRED, not proven here: no
 * save-order `order` phase index is extracted onto Flow / ApexTrigger /
 * WorkflowRule nodes today, so it fired on nothing on a real vault and would
 * ship as dead weight. `concept:save-order` remains as curated knowledge (its
 * summary + phase-order are still asserted below).
 *
 * Plus a coverage-hedging proof: an `absenceShaped: true` variant under partial
 * coverage downgrades to `'unknown'` + a "not checked" claim, never asserting
 * "safe/none".
 */

import type { ConceptRule, ConfidenceLevel, Edge, Node } from '@sf-intelligence/contracts';

import { CONCEPTS, CONCEPT_RULES, MODEL_VERSION } from '../../src/knowledge/loader.js';
import { interpret, weakest, type Coverage, type GroundedSlice } from '../../src/knowledge/reason.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures — no real org data.
// ---------------------------------------------------------------------------

const DEAL_OBJ = 'CustomObject:Ns__Deal__c';
const DEAL_TRIGGER = 'ApexTrigger:Ns__DealTrigger';
const DEAL_FLOW = 'Flow:Ns__DealFlow';
const HEALTH_FIELD = 'CustomField:Ns__Deal__c.Health__c';
const AMOUNT_FIELD = 'CustomField:Ns__Deal__c.Amount__c';
const EXTERNAL_ID_FIELD = 'CustomField:Ns__Deal__c.ExternalId__c';
const UNIQUE_CODE_FIELD = 'CustomField:Ns__Deal__c.Code__c';

// Master-detail / lookup relationship fixtures: a child object (Order) whose
// fields point at a parent object (Account).
const ACCOUNT_OBJ = 'CustomObject:Ns__Account';
const ORDER_OBJ = 'CustomObject:Ns__Order__c';
const ORDER_ACCOUNT_MD_FIELD = 'CustomField:Ns__Order__c.Ns__Account__c'; // master-detail → Account
const ORDER_REP_LOOKUP_FIELD = 'CustomField:Ns__Order__c.Ns__Rep__c'; // plain lookup → Account
// Roll-up summary fixture: a Summary field on the PARENT (Account) that rolls up
// its Order children across the master-detail relationship.
const ACCOUNT_TOTAL_ORDERS_FIELD = 'CustomField:Ns__Account.Ns__Total_Orders__c'; // dataType: Summary
const ACCOUNT_NAME_FIELD = 'CustomField:Ns__Account.Ns__Name__c'; // dataType: Text (non-Summary)

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

const COMPLETE: Coverage = { status: 'complete', caveat: null };
const PARTIAL: Coverage = {
  status: 'partial',
  caveat: 'Flow coverage is partial in this vault.',
};

/** Look up a shipped seed rule by id (fails loudly if the DATA drifts). */
const ruleById = (id: string): ConceptRule => {
  const rule = CONCEPT_RULES.find((r) => r.id === id);
  if (rule === undefined) throw new Error(`seed rule not found: ${id}`);
  return rule;
};

// ---------------------------------------------------------------------------
// The shipped seed model — the three concepts + three rules exist and cohere.
// ---------------------------------------------------------------------------

describe('RM-2 shipped seed model', () => {
  it('ships the three seed concepts with the expected kinds', () => {
    expect(CONCEPTS['concept:status-code']!.kind).toBe('status-code');
    expect(CONCEPTS['concept:save-order']!.kind).toBe('save-order-phase');
    expect(CONCEPTS['concept:field-provenance']!.kind).toBe('field-provenance');
  });

  it('ships the shipped seed rules, each bound to a concept that exists', () => {
    const ids = CONCEPT_RULES.map((r) => r.id);
    expect(ids).toContain('rule:status-code/cross-ref-automation');
    expect(ids).toContain('rule:field-provenance/derived-read-only');
    expect(ids).toContain('rule:relationship/master-detail-cascade');
    expect(ids).toContain('rule:relationship/master-detail-rollup');
    expect(ids).toContain('rule:required-field/no-default-creation-gap');
    // The save-order phase-order rule is DEFERRED (no grounded phase index is
    // extracted onto automation nodes), so it must NOT ship — a rule that fires
    // on nothing on a real vault is worse than an absent rule.
    expect(ids).not.toContain('rule:save-order/phase-order');
    for (const rule of CONCEPT_RULES) {
      expect(CONCEPTS[rule.concept]).toBeDefined();
    }
  });

  it('the save-order concept summary carries the 11 automation phases in order', () => {
    const summary = CONCEPTS['concept:save-order']!.summary;
    const phases = [
      'before-save-flows',
      'pre-save-triggers',
      'pre-save-validation',
      'duplicate-rules',
      'after-triggers',
      'post-save-assignment',
      'post-save-workflows',
      'post-save-flows',
      'post-save-approval',
      'post-save-rollup-recalc',
      'post-save-async',
    ];
    let cursor = -1;
    for (const phase of phases) {
      const at = summary.indexOf(phase, cursor + 1);
      expect(at).toBeGreaterThan(cursor); // present AND in order
      cursor = at;
    }
  });
});

// ---------------------------------------------------------------------------
// 1) concept:status-code — cross-reference the object's save automation.
// ---------------------------------------------------------------------------

describe('concept:status-code — rule:status-code/cross-ref-automation', () => {
  const rule = ruleById('rule:status-code/cross-ref-automation');

  it('cites the matched automation ids and caps confidence to the weakest matched edge', () => {
    // Two automations fire on save of the same object; the flow edge is only
    // heuristic (regex-recovered), the trigger edge is declared.
    const slice: GroundedSlice = {
      nodes: [
        node(DEAL_OBJ, 'CustomObject'),
        node(DEAL_TRIGGER, 'ApexTrigger'),
        node(DEAL_FLOW, 'Flow'),
      ],
      edges: [
        edge(DEAL_TRIGGER, DEAL_OBJ, 'triggersOn', 'declared'),
        edge(DEAL_FLOW, DEAL_OBJ, 'triggersOn', 'heuristic'),
      ],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:status-code');
    // FIX 1: the interpretation cites ONLY the matched automations (the
    // `triggersOn` edges' automation endpoints, deduped in edge order). The
    // OBJECT the automations fire on is NOT a save-aborting culprit and must
    // never be cited or named.
    expect(only.groundedIn).toEqual([DEAL_TRIGGER, DEAL_FLOW]);
    expect(only.groundedIn).toContain(DEAL_TRIGGER);
    expect(only.groundedIn).toContain(DEAL_FLOW);
    expect(only.groundedIn).not.toContain(DEAL_OBJ);
    // Confidence is COMPUTED: the heuristic triggersOn edge caps the
    // declared-max rule to heuristic.
    expect(only.confidence).toBe(weakest('declared', 'declared', 'heuristic'));
    expect(only.confidence).toBe('heuristic');
    // The truthful claim names only the automations as possible culprits.
    expect(only.claim).toContain(DEAL_TRIGGER);
    expect(only.claim).toContain(DEAL_FLOW);
    expect(only.claim).not.toContain(DEAL_OBJ);
    expect(only.claim.toLowerCase()).toContain('could have aborted the save');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('when every matched triggersOn edge is declared the confidence stays declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(DEAL_OBJ, 'CustomObject'), node(DEAL_TRIGGER, 'ApexTrigger')],
      edges: [edge(DEAL_TRIGGER, DEAL_OBJ, 'triggersOn', 'declared')],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe('declared');
    // FIX 1: only the automation is cited, not the object it triggers on.
    expect(out[0]!.groundedIn).toEqual([DEAL_TRIGGER]);
    expect(out[0]!.groundedIn).not.toContain(DEAL_OBJ);
  });
});

// ---------------------------------------------------------------------------
// 2) concept:field-provenance — a derived field is read-only.
// ---------------------------------------------------------------------------

describe('concept:field-provenance — rule:field-provenance/derived-read-only', () => {
  const rule = ruleById('rule:field-provenance/derived-read-only');

  it('matches ONLY the isFormula===true (formula/derived) field, claims read-only, confidence declared', () => {
    // Re-grounded on `isFormula` — the always-present formula signal the
    // CustomField extractor emits (custom-field.ts). A formula field is derived
    // and read-only. A stored field and an external-id field are NOT formulas.
    const slice: GroundedSlice = {
      nodes: [
        node(HEALTH_FIELD, 'CustomField', { isFormula: true }),
        node(AMOUNT_FIELD, 'CustomField', {}), // stored (no formula) → excluded
        node(EXTERNAL_ID_FIELD, 'CustomField', { externalId: true }), // stored → excluded
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:field-provenance');
    // EXACTLY the formula field — not the stored or external-id siblings.
    expect(only.groundedIn).toEqual([HEALTH_FIELD]);
    expect(only.claim.toLowerCase()).toContain('read-only');
    expect(only.claim).toBe(
      `${HEALTH_FIELD} is a FORMULA (derived) field → read-only; a write from a flow or integration will fail with a field-integrity error, so never map it as a write target.`,
    );
    // Node matches carry no edge confidence → the declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
  });

  it('yields no claim when no field is a formula (no citation ⇒ no claim)', () => {
    const slice: GroundedSlice = {
      nodes: [node(AMOUNT_FIELD, 'CustomField', {})],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('[FIX 3] does NOT match a non-CustomField node even when it declares isFormula===true (type guard)', () => {
    const FORMULA_FLOW = 'Flow:Ns__FormulaFlow';
    const slice: GroundedSlice = {
      nodes: [
        node(HEALTH_FIELD, 'CustomField', { isFormula: true }), // matches
        node(FORMULA_FLOW, 'Flow', { isFormula: true }), // wrong type → excluded
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    // Without `componentTypes: ['CustomField']` on the shipped rule, the Flow
    // node would be (wrongly) claimed as a formula read-only field.
    expect(out[0]!.groundedIn).toEqual([HEALTH_FIELD]);
    expect(out[0]!.groundedIn).not.toContain(FORMULA_FLOW);
  });
});

// ---------------------------------------------------------------------------
// 2b) concept:unique-field-constraint — a field marked `unique` enforces a
//     uniqueness constraint (DUPLICATE_VALUE on a duplicate insert/update).
//     A NODE-shaped rule (roadmap A2) mirroring field-provenance/isFormula: it
//     fires off a CustomField node whose OWN `unique === true` (an always-present
//     extractor boolean), claims DUPLICATE_VALUE, confidence declared. It must NOT
//     fire on a non-unique field, and componentTypes scopes it to CustomField.
//     The `unique` and `externalId` concepts key DISJOINT properties, proven
//     non-cross-firing below.
// ---------------------------------------------------------------------------

describe('concept:unique-field-constraint — rule:field/unique-constraint', () => {
  const rule = ruleById('rule:field/unique-constraint');

  it('ships the unique-field-constraint concept with the field-provenance kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('field-provenance');
  });

  it('is a node-shaped CustomField rule (componentTypes + whereProperty unique===true, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:unique-field-constraint');
    expect(rule.bind.componentTypes).toEqual(['CustomField']);
    expect(rule.bind.whereProperty).toEqual([{ key: 'unique', equals: true }]);
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['CustomField']);
  });

  it('matches ONLY the unique===true field, claims DUPLICATE_VALUE, cites the field, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(UNIQUE_CODE_FIELD, 'CustomField', { unique: true }),
        node(AMOUNT_FIELD, 'CustomField', { unique: false }), // non-unique → excluded
        node(EXTERNAL_ID_FIELD, 'CustomField', { externalId: true }), // external-id but not unique → excluded
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:unique-field-constraint');
    // EXACTLY the unique field — not the non-unique or external-id siblings.
    expect(only.groundedIn).toEqual([UNIQUE_CODE_FIELD]);
    expect(only.claim).toContain(UNIQUE_CODE_FIELD);
    expect(only.claim).toContain('DUPLICATE_VALUE');
    // RM-review F13: a unique violation is StatusCode.DUPLICATE_VALUE, NOT the
    // distinct sibling FIELD_INTEGRITY_EXCEPTION.
    expect(only.claim).not.toContain('FIELD_INTEGRITY_EXCEPTION');
    expect(only.claim.toLowerCase()).toContain('unique');
    // A node match carries no edge confidence → the declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('yields no claim when no field is unique (no citation ⇒ no claim)', () => {
    const slice: GroundedSlice = {
      nodes: [node(AMOUNT_FIELD, 'CustomField', { unique: false })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-CustomField node carrying unique===true does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Deal__c', 'CustomObject', { unique: true })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2c) concept:external-id-field — a field marked `externalId` is indexed and
//     eligible as an upsert key. A NODE-shaped rule (roadmap A2) keying the
//     always-present `externalId` extractor boolean. It claims upsert-key
//     eligibility, confidence declared, must NOT fire on a non-external-id field,
//     and componentTypes scopes it to CustomField. `externalId` and `unique` key
//     DISJOINT properties: a field that is BOTH fires BOTH rules (each stating its
//     own consequence) — proven below.
// ---------------------------------------------------------------------------

describe('concept:external-id-field — rule:field/external-id-upsert-key', () => {
  const rule = ruleById('rule:field/external-id-upsert-key');

  it('ships the external-id-field concept with the field-provenance kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('field-provenance');
  });

  it('is a node-shaped CustomField rule (componentTypes + whereProperty externalId===true, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:external-id-field');
    expect(rule.bind.componentTypes).toEqual(['CustomField']);
    expect(rule.bind.whereProperty).toEqual([{ key: 'externalId', equals: true }]);
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['CustomField']);
  });

  it('matches ONLY the externalId===true field, claims upsert-key eligibility, cites the field, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(EXTERNAL_ID_FIELD, 'CustomField', { externalId: true }),
        node(AMOUNT_FIELD, 'CustomField', { externalId: false }), // not external-id → excluded
        node(UNIQUE_CODE_FIELD, 'CustomField', { unique: true }), // unique but not external-id → excluded
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:external-id-field');
    // EXACTLY the external-id field — not the plain or unique-only siblings.
    expect(only.groundedIn).toEqual([EXTERNAL_ID_FIELD]);
    expect(only.claim).toContain(EXTERNAL_ID_FIELD);
    expect(only.claim.toLowerCase()).toContain('upsert');
    expect(only.claim.toLowerCase()).toContain('external id');
    // A node match carries no edge confidence → the declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('yields no claim when no field is an external id (no citation ⇒ no claim)', () => {
    const slice: GroundedSlice = {
      nodes: [node(AMOUNT_FIELD, 'CustomField', { externalId: false })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-CustomField node carrying externalId===true does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Deal__c', 'CustomObject', { externalId: true })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('[disjoint keys] a field that is BOTH external-id AND unique fires BOTH rules, each with its own consequence', () => {
    // externalId and unique are separate declared attributes; a field carrying
    // both legitimately fires both concepts (upsert-key eligibility AND the
    // DUPLICATE_VALUE constraint) — neither rule suppresses the other.
    const BOTH_FIELD = 'CustomField:Ns__Deal__c.ExternalUniqueKey__c';
    const slice: GroundedSlice = {
      nodes: [node(BOTH_FIELD, 'CustomField', { externalId: true, unique: true })],
      edges: [],
    };

    const extIdOut = interpret(rule, slice, COMPLETE);
    expect(extIdOut).toHaveLength(1);
    expect(extIdOut[0]!.groundedIn).toEqual([BOTH_FIELD]);
    expect(extIdOut[0]!.claim.toLowerCase()).toContain('upsert');

    const uniqueOut = interpret(ruleById('rule:field/unique-constraint'), slice, COMPLETE);
    expect(uniqueOut).toHaveLength(1);
    expect(uniqueOut[0]!.groundedIn).toEqual([BOTH_FIELD]);
    expect(uniqueOut[0]!.claim).toContain('DUPLICATE_VALUE');
  });
});

// ---------------------------------------------------------------------------
// 2b) concept:required-field-no-default — a universally required field with NO
//     default value is a creation gap (roadmap A1). The FIRST concept to use the
//     isNull whereProperty operator: it fires when `required === true` AND
//     `defaultValue` is NULLISH (present-as-null OR the key entirely absent —
//     both mean "no default value"), and NOT when a default is present.
// ---------------------------------------------------------------------------

describe('concept:required-field-no-default — rule:required-field/no-default-creation-gap', () => {
  const rule = ruleById('rule:required-field/no-default-creation-gap');

  const REQ_NO_DEFAULT = 'CustomField:Ns__Deal__c.ReqNoDefault__c'; // required, defaultValue key ABSENT
  const REQ_NULL_DEFAULT = 'CustomField:Ns__Deal__c.ReqNullDefault__c'; // required, defaultValue: null
  const REQ_WITH_DEFAULT = 'CustomField:Ns__Deal__c.ReqWithDefault__c'; // required, defaultValue: present
  const OPTIONAL_NO_DEFAULT = 'CustomField:Ns__Deal__c.OptNoDefault__c'; // NOT required

  it('reuses an existing ConceptKind (field-provenance) — no new kind invented', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('field-provenance');
  });

  it('binds required===true AND defaultValue isNull (the AND-array using the isNull operator)', () => {
    expect(rule.bind.componentTypes).toEqual(['CustomField']);
    expect(rule.bind.whereProperty).toEqual([
      { key: 'required', equals: true },
      { key: 'defaultValue', isNull: true },
    ]);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.absenceShaped).toBe(false);
    expect(rule.dependsOnCoverage).toEqual(['CustomField']);
  });

  it('fires on a required field with the defaultValue key ABSENT (nullish), claim pinned, confidence declared', () => {
    // The dominant real shape: a required field whose <defaultValue> element is
    // absent, so the extractor omits the key entirely (undefined). The nullish
    // isNull:true clause matches undefined — a strict ===null check would MISS it.
    const slice: GroundedSlice = {
      nodes: [node(REQ_NO_DEFAULT, 'CustomField', { required: true })],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:required-field-no-default');
    expect(only.groundedIn).toEqual([REQ_NO_DEFAULT]);
    expect(only.claim).toBe(
      `${REQ_NO_DEFAULT} is REQUIRED and declares NO default value → its value must be supplied on every insert path (a UI create, an Apex DML insert, an API create, a data import, or an upsert that inserts). An insert that omits it HARD-FAILS with a required-value error (REQUIRED_FIELD_MISSING) and creates no record. A required field WITH a default does not have this gap — the default fills the value — so this fires only because no default is set. Grounded from the field's own declared required flag and absent default value; it is general Salesforce behavior, not an observed runtime failure.`,
    );
    // Node match carries no edge → the declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
  });

  it('fires on required+null AND required+absent, but NOT on required+default or optional', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(REQ_NO_DEFAULT, 'CustomField', { required: true }), // absent default → nullish → fires
        node(REQ_NULL_DEFAULT, 'CustomField', { required: true, defaultValue: null }), // null → nullish → fires
        node(REQ_WITH_DEFAULT, 'CustomField', { required: true, defaultValue: 'USD' }), // present default → excluded
        node(OPTIONAL_NO_DEFAULT, 'CustomField', { required: false, defaultValue: null }), // not required → excluded
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    // ONE interpretation citing BOTH no-default required fields (node match order).
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([REQ_NO_DEFAULT, REQ_NULL_DEFAULT]);
    // The with-default and optional fields must never be cited.
    expect(out[0]!.groundedIn).not.toContain(REQ_WITH_DEFAULT);
    expect(out[0]!.groundedIn).not.toContain(OPTIONAL_NO_DEFAULT);
  });

  it('yields no claim when no required field exists (no citation ⇒ no claim)', () => {
    const slice: GroundedSlice = {
      nodes: [node(OPTIONAL_NO_DEFAULT, 'CustomField', { required: false, defaultValue: null })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('does NOT match a non-CustomField node even when it carries required===true and a null default (type guard)', () => {
    const FLOW_NODE = 'Flow:Ns__ReqFlow';
    const slice: GroundedSlice = {
      nodes: [
        node(REQ_NO_DEFAULT, 'CustomField', { required: true }), // matches
        node(FLOW_NODE, 'Flow', { required: true, defaultValue: null }), // wrong type → excluded
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([REQ_NO_DEFAULT]);
    expect(out[0]!.groundedIn).not.toContain(FLOW_NODE);
  });
});

// ---------------------------------------------------------------------------
// 3) concept:save-order — DEFERRED. The former `rule:save-order/phase-order`
//    bound `order: 4` on automation nodes, but no save-order phase index is
//    extracted onto Flow / ApexTrigger / WorkflowRule nodes today, so it fired
//    on nothing on a real vault. The rule is removed from the model; the
//    concept is retained as curated knowledge (its kind + phase-order summary
//    are still asserted in "RM-2 shipped seed model" above). No reasoning proof
//    exists here until a grounded phase index is extracted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4) concept:relationship — a master-detail relationship cascade-deletes its
//    children. The NEW answer class: reasoned by joining the master-detail RULE
//    to a grounded `lookupTo` edge's own `relationshipType` property. The
//    cascade-delete consequence lives in NEITHER the vault NOR a primer — the
//    engine computes it from rule + fact.
// ---------------------------------------------------------------------------

describe('concept:relationship — rule:relationship/master-detail-cascade', () => {
  const rule = ruleById('rule:relationship/master-detail-cascade');

  it('computes the cascade-delete claim from a MasterDetail lookupTo edge, citing both grounded endpoints', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(ORDER_ACCOUNT_MD_FIELD, 'CustomField'),
        node(ACCOUNT_OBJ, 'CustomObject'),
        node(ORDER_OBJ, 'CustomObject'),
      ],
      edges: [
        // The master-detail field on Order points at its parent Account.
        edge(ORDER_ACCOUNT_MD_FIELD, ACCOUNT_OBJ, 'lookupTo', 'declared', {
          relationshipType: 'MasterDetail',
        }),
      ],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:relationship');
    // Both grounded endpoints are cited: the master-detail field AND its parent.
    expect(only.groundedIn).toEqual([ORDER_ACCOUNT_MD_FIELD, ACCOUNT_OBJ]);
    // Confidence is COMPUTED from the matched (declared) edge, never asserted.
    expect(only.confidence).toBe('declared');
    // The NEW answer class: deleting the parent cascade-deletes its children.
    expect(only.claim.toLowerCase()).toContain('cascade');
    expect(only.claim).toContain(ORDER_ACCOUNT_MD_FIELD);
    expect(only.claim).toContain(ACCOUNT_OBJ);
    // The refined (definitive) claim fences record COUNTS to the live plane —
    // the offline vault cannot know how many children exist.
    expect(only.claim.toLowerCase()).toContain('live-plane');
    // …and it must NEVER fabricate a number: the synthetic ids carry no digit,
    // so any digit in the claim would be an invented count.
    expect(only.claim).not.toMatch(/\d/);
    expect(only.claim).toBe(
      `Master-detail relationship (${ORDER_ACCOUNT_MD_FIELD}, ${ACCOUNT_OBJ}): deleting the parent record cascade-deletes every child record, the child inherits the parent's ownership and sharing (it has none of its own), and the child cannot exist without a parent. How many child records exist is a live-plane question.`,
    );
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire for a plain Lookup (relationshipType==="Lookup") — no cascade rule triggers', () => {
    const slice: GroundedSlice = {
      nodes: [node(ORDER_REP_LOOKUP_FIELD, 'CustomField'), node(ACCOUNT_OBJ, 'CustomObject')],
      edges: [
        // A loose lookup does NOT cascade-delete → the edge-property predicate excludes it.
        edge(ORDER_REP_LOOKUP_FIELD, ACCOUNT_OBJ, 'lookupTo', 'declared', {
          relationshipType: 'Lookup',
        }),
      ],
    };

    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('[FIX A] drops a DANGLING parent: a MasterDetail lookupTo whose parent CustomObject is NOT in the slice still fires but cites ONLY the child field', () => {
    // A master-detail field can point at a managed/standard master object that
    // was NOT retrieved into the vault (a legal "dangling" edge — see
    // custom-field.ts). Only the CHILD field node is grounded; the parent
    // CustomObject is absent from `slice.nodes`. The engine must NOT fabricate
    // a citation for the ungrounded parent id.
    const slice: GroundedSlice = {
      nodes: [node(ORDER_ACCOUNT_MD_FIELD, 'CustomField')],
      edges: [
        edge(ORDER_ACCOUNT_MD_FIELD, ACCOUNT_OBJ, 'lookupTo', 'declared', {
          relationshipType: 'MasterDetail',
        }),
      ],
    };

    const out = interpret(rule, slice, COMPLETE);

    // The interpretation STILL fires — ≥1 endpoint (the child field) resolves
    // in the slice and qualifies under `componentTypes`.
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:relationship');
    // …but it cites ONLY the grounded child field. The dangling parent is
    // dropped by the `componentTypes` endpoint filter — never cited, never
    // named. Without the guard both endpoints are cited and the ungrounded
    // parent id is (wrongly) fabricated into `groundedIn`.
    expect(only.groundedIn).toEqual([ORDER_ACCOUNT_MD_FIELD]);
    expect(only.groundedIn).not.toContain(ACCOUNT_OBJ);
    // The rendered claim names the child field but never the ungrounded parent.
    expect(only.claim).toContain(ORDER_ACCOUNT_MD_FIELD);
    expect(only.claim).not.toContain(ACCOUNT_OBJ);
    expect(only.claim.toLowerCase()).toContain('cascade');
    // Confidence is COMPUTED from the matched (declared) edge.
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[FIX B] COMPUTES confidence from the matched edge: a heuristic MasterDetail edge caps the claim to heuristic (not the declared ceiling)', () => {
    // Both endpoints are grounded (normal case), but the master-detail edge is
    // only heuristic (e.g. recovered, not declared). The interpretation's
    // confidence must be DERIVED via weakest(maxConfidence, …edge) — not
    // asserted from the rule's declared `maxConfidence`.
    const slice: GroundedSlice = {
      nodes: [node(ORDER_ACCOUNT_MD_FIELD, 'CustomField'), node(ACCOUNT_OBJ, 'CustomObject')],
      edges: [
        edge(ORDER_ACCOUNT_MD_FIELD, ACCOUNT_OBJ, 'lookupTo', 'heuristic', {
          relationshipType: 'MasterDetail',
        }),
      ],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    // The heuristic edge caps the declared-max rule to heuristic.
    expect(only.confidence).toBe(weakest('declared', 'heuristic'));
    expect(only.confidence).toBe('heuristic');
    expect(only.confidence).not.toBe('declared');
    // Both grounded endpoints are still cited — confidence propagation is
    // proven independently of the citation guard.
    expect(only.groundedIn).toEqual([ORDER_ACCOUNT_MD_FIELD, ACCOUNT_OBJ]);
  });
});

// ---------------------------------------------------------------------------
// 5) concept:relationship — a roll-up summary field is read-only. Independently
//    grounded (node-shaped) from the cascade rule: it fires off a CustomField
//    node whose OWN `dataType === 'Summary'`, NOT off a lookupTo edge. The
//    read-only consequence is the reasoned claim.
// ---------------------------------------------------------------------------

describe('concept:relationship — rule:relationship/master-detail-rollup', () => {
  const rule = ruleById('rule:relationship/master-detail-rollup');

  it('fires on a dataType==="Summary" CustomField, claims read-only, cites the field, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(ACCOUNT_TOTAL_ORDERS_FIELD, 'CustomField', { dataType: 'Summary' }),
        node(ACCOUNT_NAME_FIELD, 'CustomField', { dataType: 'Text' }), // non-Summary sibling
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:relationship');
    // EXACTLY the Summary field — not the Text sibling.
    expect(only.groundedIn).toEqual([ACCOUNT_TOTAL_ORDERS_FIELD]);
    expect(only.claim).toContain(ACCOUNT_TOTAL_ORDERS_FIELD);
    expect(only.claim.toLowerCase()).toContain('read-only');
    expect(only.claim).toBe(
      `${ACCOUNT_TOTAL_ORDERS_FIELD} is a roll-up summary field: it aggregates child records across a master-detail relationship and recalculates automatically when a child record is inserted, updated, deleted, or undeleted. It is read-only and cannot be written by a flow or integration.`,
    );
    // A node match carries no edge confidence → the declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire for a non-Summary field (no citation ⇒ no claim)', () => {
    const slice: GroundedSlice = {
      nodes: [node(ACCOUNT_NAME_FIELD, 'CustomField', { dataType: 'Text' })],
      edges: [],
    };

    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Coverage hedging — an absenceShaped variant never asserts "safe" under
// partial coverage. Reuses the engine's documented downgrade behavior.
// ---------------------------------------------------------------------------

describe('coverage hedging — absenceShaped variant over a seed concept', () => {
  // A variant of the field-provenance concept whose claim is about ABSENCE:
  // "no integration/flow writes this field, so it is safe to treat as read-only".
  const absenceRule: ConceptRule = {
    id: 'rule:field-provenance/no-writers-variant',
    concept: 'concept:field-provenance',
    bind: { edgeType: 'writesTo', componentTypes: ['Flow', 'ApexClass'] },
    interpretation: 'no integration or flow writes this field — safe to treat as read-only',
    maxConfidence: 'declared',
    absenceShaped: true,
    dependsOnCoverage: ['CustomField', 'Flow'],
  };

  it('references a shipped seed concept', () => {
    expect(CONCEPTS[absenceRule.concept]).toBeDefined();
    expect(CONCEPTS[absenceRule.concept]!.kind).toBe('field-provenance');
  });

  it('downgrades to unknown + "not checked" under PARTIAL coverage, never asserting "safe"', () => {
    const slice: GroundedSlice = {
      nodes: [node(HEALTH_FIELD, 'CustomField', { isFormula: true })],
      edges: [], // no writers in the slice → absence
    };

    const out = interpret(absenceRule, slice, PARTIAL);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.confidence).toBe('unknown');
    expect(only.coverageCaveat).toBe(PARTIAL.caveat);
    expect(only.claim.toLowerCase()).toContain('not checked');
    // The "safe/none" conclusion is NEVER asserted when coverage is partial.
    expect(only.claim.toLowerCase()).not.toContain('safe to treat as read-only');
    expect(only.groundedIn).toEqual([]);
  });

  it('emits its confident absence claim under COMPLETE coverage', () => {
    const slice: GroundedSlice = {
      nodes: [node(HEALTH_FIELD, 'CustomField', { isFormula: true })],
      edges: [],
    };

    const out = interpret(absenceRule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toBe('no integration or flow writes this field — safe to treat as read-only');
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.coverageCaveat).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// concept:firing-condition — rule:firing-condition/declared-not-evaluated.
// A NODE-shaped rule: it fires off a synthetic `ConditionalContext` node whose
// OWN `properties.kind` is one of the THREE genuine entry/error gates — `criteria`,
// `formula`, or `flow-recordtrigger` — expressed via the operator-class predicate
// `kind in [criteria, formula, flow-recordtrigger]`. It states the honesty
// boundary — the condition is DECLARED in metadata, read STATICALLY, and NOT
// evaluated against a live record. Confidence `parsed` (a formula condition's field
// set is resolved by the tokenizer; a node match carries no edge, so weakest()
// keeps the ceiling). It must NOT fire on a mid-flow `flow-decision` branch, and
// componentTypes scopes it to the synthetic node type. `ruleById` fails loudly if
// the DATA rule is ever removed, so these proofs fail WITHOUT the shipped rule.
// ---------------------------------------------------------------------------

describe('concept:firing-condition — rule:firing-condition/declared-not-evaluated', () => {
  const rule = ruleById('rule:firing-condition/declared-not-evaluated');

  // Synthetic ConditionalContext ids (Ns__… — NOT a real org).
  const FORMULA_CC = 'ConditionalContext:ValidationRule:Ns__Deal__c.Guard.condition-0';
  const DECISION_CC = 'ConditionalContext:Flow:Ns__DealFlow.Route.condition-0';

  it('references the shipped firing-condition concept', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('firing-condition');
  });

  it('fires on a kind==="formula" ConditionalContext, cites the node, asserts declared-not-evaluated, confidence parsed', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(FORMULA_CC, 'ConditionalContext', {
          kind: 'formula',
          expression: 'ISBLANK(Health__c)',
          fieldRefs: [HEALTH_FIELD],
          synthesized: false,
        }),
        // A mid-flow decision sibling in the SAME slice must be ignored.
        node(DECISION_CC, 'ConditionalContext', {
          kind: 'flow-decision',
          expression: 'Amount__c > 0',
          fieldRefs: [AMOUNT_FIELD],
          synthesized: false,
        }),
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:firing-condition');
    // EXACTLY the formula condition — never the flow-decision sibling.
    expect(only.groundedIn).toEqual([FORMULA_CC]);
    expect(only.claim).toContain(FORMULA_CC);
    expect(only.claim).not.toContain(DECISION_CC);
    // The honesty boundary is stated verbatim.
    expect(only.claim.toLowerCase()).toContain('declared entry condition');
    expect(only.claim.toLowerCase()).toContain('does not evaluate');
    expect(only.claim.toLowerCase()).toContain('runtime');
    // A node match carries no edge confidence → the parsed ceiling holds.
    expect(only.confidence).toBe('parsed');
    expect(only.confidence).toBe(weakest('parsed', 'parsed'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('binds the three entry kinds via the `in` operator (not the scalar conditionKind)', () => {
    expect(rule.bind.whereProperty).toEqual({
      key: 'kind',
      in: ['criteria', 'formula', 'flow-recordtrigger'],
    });
    expect(rule.bind.conditionKind).toBeUndefined();
  });

  it('fires on a kind==="criteria" ConditionalContext (an XML criteria entry gate)', () => {
    const CRITERIA_CC = 'ConditionalContext:WorkflowRule:Ns__Deal__c.Escalate.condition-0';
    const slice: GroundedSlice = {
      nodes: [
        node(CRITERIA_CC, 'ConditionalContext', {
          kind: 'criteria',
          expression: 'Stage__c EQUALS Closed',
          fieldRefs: [HEALTH_FIELD],
          synthesized: false,
        }),
      ],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([CRITERIA_CC]);
    expect(out[0]!.claim.toLowerCase()).toContain('declared entry condition');
    expect(out[0]!.confidence).toBe('parsed');
  });

  it('fires on a kind==="flow-recordtrigger" ConditionalContext (a record-trigger entry gate)', () => {
    const RT_CC = 'ConditionalContext:Flow:Ns__DealTrigger.Start.condition-0';
    const slice: GroundedSlice = {
      nodes: [
        node(RT_CC, 'ConditionalContext', {
          kind: 'flow-recordtrigger',
          expression: 'ISCHANGED(Amount__c)',
          fieldRefs: [AMOUNT_FIELD],
          synthesized: false,
        }),
      ],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([RT_CC]);
    expect(out[0]!.confidence).toBe('parsed');
  });

  it('does NOT fire on a mid-flow flow-decision branch (kind==="flow-decision") — no firing-condition claim', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DECISION_CC, 'ConditionalContext', {
          kind: 'flow-decision',
          expression: 'Amount__c > 0',
          fieldRefs: [AMOUNT_FIELD],
          synthesized: false,
        }),
      ],
      edges: [],
    };

    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-ConditionalContext node carrying kind==="formula" does NOT fire', () => {
    const slice: GroundedSlice = {
      // A ValidationRule node that happens to carry a `kind: formula` property is
      // NOT a synthetic ConditionalContext, so the componentTypes clause drops it.
      nodes: [node('ValidationRule:Ns__Deal__c.Guard', 'ValidationRule', { kind: 'formula' })],
      edges: [],
    };

    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// concept:flow-run-mode — two Flow run-mode NODE rules (roadmap A11).
// The `runInMode` property is an always-present Flow string already in the graph
// (`SystemModeWithoutSharing` | `SystemModeWithSharing` | `DefaultMode` | null);
// no engine change. Only the two SYSTEM-context postures are built —
// `SystemModeWithoutSharing` (system context; sharing NOT enforced; CRUD/FLS NOT
// enforced) and `SystemModeWithSharing` (system context; sharing enforced;
// CRUD/FLS NOT enforced). `DefaultMode` (context-dependent default) and null (no
// run mode declared) are DEFERRED, so those flows fire NEITHER rule. The rules
// key `runInMode` (Flow-only, componentTypes:[Flow]) — a DIFFERENT property from
// the apex-sharing / OWD `sharingModel` concepts, proven non-cross-firing below.
// The reasoning value over the Apex analog: an Apex `without sharing` class STILL
// enforces object CRUD/FLS, but a system-context Flow does NOT — the claim states
// that extra bypass verbatim.
// ---------------------------------------------------------------------------

describe('concept:flow-run-mode — Flow run-mode NODE rules', () => {
  const NOSHARE_FLOW = 'Flow:Ns__SystemNoShareFlow';
  const SHARE_FLOW = 'Flow:Ns__SystemShareFlow';
  const DEFAULT_FLOW = 'Flow:Ns__DefaultModeFlow';

  // (rule id, bound runInMode value, a distinctive phrase from the claim).
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:flow-run-mode/system-without-sharing', 'SystemModeWithoutSharing', 'system context'],
    ['rule:flow-run-mode/system-with-sharing', 'SystemModeWithSharing', 'system context'],
  ];

  it('ships the flow-run-mode concept with the access-mechanism kind and its run-mode summary', () => {
    const concept = CONCEPTS['concept:flow-run-mode'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('runinmode');
    expect(summary).toContain('systemmodewithoutsharing');
    expect(summary).toContain('systemmodewithsharing');
    // RM-review F5: no FALSE claim that Apex `without sharing` enforces CRUD/FLS;
    // run mode is a separate concern from CRUD/FLS, which a system-context Flow
    // also does not enforce.
    expect(summary).toContain('separate concern from crud/fls');
    expect(summary).not.toContain('unlike an apex');
    expect(summary).toContain('field-level security');
    // The default posture is deliberately NOT asserted.
    expect(summary).toContain('not asserted');
  });

  it.each(CASES)(
    '%s fires on a Flow with its runInMode token, cites ONLY that flow, confidence declared',
    (ruleId, value, phrase) => {
      const rule = ruleById(ruleId);
      // A node-shaped rule: componentTypes Flow + equals on runInMode, no edge,
      // presence-shaped, declared ceiling.
      expect(rule.concept).toBe('concept:flow-run-mode');
      expect(rule.bind.componentTypes).toEqual(['Flow']);
      expect(rule.bind.whereProperty).toEqual({ key: 'runInMode', equals: value });
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');

      const flowId = `Flow:Ns__RunModeFlow_${value}`;
      const slice: GroundedSlice = {
        nodes: [node(flowId, 'Flow', { runInMode: value })],
        edges: [],
      };
      const out = interpret(rule, slice, COMPLETE, flowId);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:flow-run-mode');
      // A node match cites ONLY the root flow (never a neighbor) and carries no
      // edge confidence, so weakest() keeps the declared ceiling.
      expect(only.groundedIn).toEqual([flowId]);
      expect(only.confidence).toBe('declared');
      expect(only.confidence).toBe(weakest('declared', 'declared'));
      expect(only.coverageCaveat).toBeNull();
      expect(only.provenance).toBe('offline_snapshot');
      expect(only.modelVersion).toBe(MODEL_VERSION);
      expect(only.claim).toContain(flowId);
      expect(only.claim).toContain(value); // the backticked runInMode token
      expect(only.claim.toLowerCase()).toContain(phrase);
    },
  );

  it('the without-sharing claim: system context, bypasses record sharing AND object CRUD/FLS (no false Apex-enforces claim)', () => {
    const slice: GroundedSlice = {
      nodes: [node(NOSHARE_FLOW, 'Flow', { runInMode: 'SystemModeWithoutSharing' })],
      edges: [],
    };
    const claim = interpret(
      ruleById('rule:flow-run-mode/system-without-sharing'),
      slice,
      COMPLETE,
      NOSHARE_FLOW,
    )[0]!.claim;
    const lower = claim.toLowerCase();
    // Runs in system context and does NOT enforce the running user's record sharing.
    expect(lower).toContain('does not enforce the running user');
    expect(lower).toContain('record-level sharing');
    // RM-review F5: the claim no longer makes the FALSE assertion that Apex
    // `without sharing` enforces CRUD/FLS. It states run mode is a separate concern
    // from CRUD/FLS and that a system-context Flow does not enforce them.
    expect(lower).toContain('separate concern from crud/fls');
    expect(lower).not.toContain('still enforces object crud');
    expect(lower).toContain('does not enforce object crud or field-level security');
    // Often intentional — NOT by itself a vulnerability (no over-claim).
    expect(lower).toContain('not by itself a vulnerability');
    // Run mode is FLOW-level; declared posture, never a proven runtime outcome.
    expect(lower).toContain('flow-level');
    expect(lower).toContain('not a proven access outcome');
  });

  it('the with-sharing claim: system context, sharing enforced, but object CRUD/FLS still bypassed', () => {
    const slice: GroundedSlice = {
      nodes: [node(SHARE_FLOW, 'Flow', { runInMode: 'SystemModeWithSharing' })],
      edges: [],
    };
    const claim = interpret(
      ruleById('rule:flow-run-mode/system-with-sharing'),
      slice,
      COMPLETE,
      SHARE_FLOW,
    )[0]!.claim;
    const lower = claim.toLowerCase();
    // Respects record-level sharing (visibility enforced)…
    expect(lower).toContain('does respect the running user');
    expect(lower).toContain('record visibility is enforced');
    // …but object/field permissions are NOT enforced.
    expect(lower).toContain('still does not enforce object crud or field-level security');
    // Declared posture, never a proven runtime access outcome.
    expect(lower).toContain('not a proven access outcome');
  });

  it('a DefaultMode Flow fires NEITHER built rule — the context-dependent default is deliberately not claimed', () => {
    const slice: GroundedSlice = {
      nodes: [node(DEFAULT_FLOW, 'Flow', { runInMode: 'DefaultMode' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), slice, COMPLETE, DEFAULT_FLOW)).toEqual([]);
    }
  });

  it('a null / no-run-mode Flow (runInMode absent or null) fires NEITHER built rule', () => {
    // runInMode: null — the extractor's value for a flow that declares no run mode.
    const nullSlice: GroundedSlice = {
      nodes: [node(DEFAULT_FLOW, 'Flow', { runInMode: null })],
      edges: [],
    };
    // …and the bare/absent-property shape must be equally inert.
    const bareSlice: GroundedSlice = { nodes: [node(DEFAULT_FLOW, 'Flow', {})], edges: [] };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), nullSlice, COMPLETE, DEFAULT_FLOW)).toEqual([]);
      expect(interpret(ruleById(ruleId), bareSlice, COMPLETE, DEFAULT_FLOW)).toEqual([]);
    }
  });

  it('[type guard] a non-Flow node carrying a runInMode token does NOT fire (componentTypes scopes the match)', () => {
    // An ApexClass that (nonsensically) declares runInMode must NOT be claimed.
    const slice: GroundedSlice = {
      nodes: [node('ApexClass:Ns__Odd', 'ApexClass', { runInMode: 'SystemModeWithoutSharing' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), slice, COMPLETE, 'ApexClass:Ns__Odd')).toEqual([]);
    }
  });

  it('[no cross-contamination] flow-run-mode keys runInMode, NOT sharingModel — the sharing concepts stay disjoint', () => {
    // A Flow declared SystemModeWithoutSharing must NOT trip any `sharingModel`
    // rule (apex-sharing / OWD key a DIFFERENT property)…
    const flowSlice: GroundedSlice = {
      nodes: [node(NOSHARE_FLOW, 'Flow', { runInMode: 'SystemModeWithoutSharing' })],
      edges: [],
    };
    expect(interpret(ruleById('rule:apex-sharing/without-sharing'), flowSlice, COMPLETE, NOSHARE_FLOW)).toEqual([]);
    expect(interpret(ruleById('rule:sharing/owd-private'), flowSlice, COMPLETE, NOSHARE_FLOW)).toEqual([]);
    // …and a node carrying a `sharingModel` token (no runInMode) must NOT trip the
    // flow-run-mode rules, which key runInMode only.
    const apexSlice: GroundedSlice = {
      nodes: [node('ApexClass:Ns__Svc', 'ApexClass', { sharingModel: 'without sharing' })],
      edges: [],
    };
    const objSlice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Obj__c', 'CustomObject', { sharingModel: 'Private' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), apexSlice, COMPLETE, 'ApexClass:Ns__Svc')).toEqual([]);
      expect(interpret(ruleById(ruleId), objSlice, COMPLETE, 'CustomObject:Ns__Obj__c')).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('concept:external-sharing-model-posture — external OWD NODE rules', () => {
  // (rule id, bound externalSharingModel value, a distinctive lowercase phrase).
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:sharing/external-owd-private', 'Private', 'private'],
    ['rule:sharing/external-owd-controlled-by-parent', 'ControlledByParent', 'controlled by parent'],
    ['rule:sharing/external-owd-public-read', 'Read', 'public read only'],
    ['rule:sharing/external-owd-public-readwrite', 'ReadWrite', 'public read/write'],
  ];

  it('ships the concept with the access-mechanism kind (REUSED, not invented) and an external summary', () => {
    const concept = CONCEPTS['concept:external-sharing-model-posture'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('externalsharingmodel');
    expect(summary).toContain('external');
    // Distinct from the internal OWD concept (a SEPARATE setting).
    expect(summary).toContain('separate');
    expect(summary).toContain('never be more permissive');
  });

  it.each(CASES)(
    '%s fires on a CustomObject with its externalSharingModel token, cites ONLY that object, confidence declared',
    (ruleId, value, phrase) => {
      const rule = ruleById(ruleId);
      // Node-shaped: componentTypes CustomObject + equals on externalSharingModel,
      // no edge, presence-shaped, declared ceiling.
      expect(rule.concept).toBe('concept:external-sharing-model-posture');
      expect(rule.bind.componentTypes).toEqual(['CustomObject']);
      expect(rule.bind.whereProperty).toEqual({ key: 'externalSharingModel', equals: value });
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');

      const objId = `CustomObject:Ns__ExtObj_${value}__c`;
      const slice: GroundedSlice = {
        nodes: [node(objId, 'CustomObject', { externalSharingModel: value })],
        edges: [],
      };
      const out = interpret(rule, slice, COMPLETE, objId);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:external-sharing-model-posture');
      // A node match cites ONLY the root object and carries no edge confidence.
      expect(only.groundedIn).toEqual([objId]);
      expect(only.confidence).toBe('declared');
      expect(only.confidence).toBe(weakest('declared', 'declared'));
      expect(only.coverageCaveat).toBeNull();
      expect(only.provenance).toBe('offline_snapshot');
      expect(only.modelVersion).toBe(MODEL_VERSION);
      expect(only.claim).toContain(objId);
      expect(only.claim.toLowerCase()).toContain(phrase);
      // Always names the EXTERNAL audience — the disambiguator from the internal OWD.
      expect(only.claim.toLowerCase()).toContain('external');
    },
  );

  it('the Private external rule pins the FULL claim (external-only, floor-vs-internal, no per-record)', () => {
    const objId = 'CustomObject:Ns__ExtPosture_Private__c';
    const slice: GroundedSlice = {
      nodes: [node(objId, 'CustomObject', { externalSharingModel: 'Private' })],
      edges: [],
    };
    const claim = interpret(
      ruleById('rule:sharing/external-owd-private'),
      slice,
      COMPLETE,
      objId,
    )[0]!.claim;
    expect(claim).toBe(
      `${objId} has EXTERNAL sharing model Private — external (Experience Cloud / community / portal) users see only external records they own or that are explicitly shared to them, by default, independent of the INTERNAL org-wide default. This external baseline is set separately from the internal OWD and can never be more permissive than it. Object-level declared posture only — which specific external user can see a specific record is record-level state the offline vault does not hold.`,
    );
    // Never fabricates a per-record count / id: the synthetic id carries no digit.
    expect(claim).not.toMatch(/\d/);
  });

  it('[negative — null/absent] a null or absent externalSharingModel fires NONE of the four rules', () => {
    const nullObj = 'CustomObject:Ns__ExtPosture_None__c';
    const nullSlice: GroundedSlice = {
      nodes: [node(nullObj, 'CustomObject', { externalSharingModel: null })],
      edges: [],
    };
    const bareSlice: GroundedSlice = { nodes: [node(nullObj, 'CustomObject', {})], edges: [] };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), nullSlice, COMPLETE, nullObj)).toEqual([]);
      expect(interpret(ruleById(ruleId), bareSlice, COMPLETE, nullObj)).toEqual([]);
    }
  });

  it('[no cross-contamination] external rules key externalSharingModel, NOT sharingModel — internal OWD stays disjoint', () => {
    // An object whose INTERNAL sharingModel is Private (no external model) must
    // NOT trip any external rule…
    const internalObj = 'CustomObject:Ns__InternalOnly__c';
    const internalSlice: GroundedSlice = {
      nodes: [node(internalObj, 'CustomObject', { sharingModel: 'Private' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), internalSlice, COMPLETE, internalObj)).toEqual([]);
    }
    // …and an object with an EXTERNAL Private model (no internal token) must NOT
    // trip the internal owd-private rule, which keys sharingModel only.
    const extObj = 'CustomObject:Ns__ExtPosture_Private__c';
    const extSlice: GroundedSlice = {
      nodes: [node(extObj, 'CustomObject', { externalSharingModel: 'Private' })],
      edges: [],
    };
    expect(interpret(ruleById('rule:sharing/owd-private'), extSlice, COMPLETE, extObj)).toEqual([]);
  });

  it('[type guard] a non-CustomObject node carrying an externalSharingModel token does NOT fire', () => {
    const oddId = 'ApexClass:Ns__Odd';
    const slice: GroundedSlice = {
      nodes: [node(oddId, 'ApexClass', { externalSharingModel: 'Private' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), slice, COMPLETE, oddId)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// RM-c1 #6) concept:criteria-based-sharing-widens — the FIRST SharingRule NODE
// rule. Single scalar-equals on ruleType==='criteria'; the accessLevel
// in:[Read,Edit] clause is DROPPED (a tautology — ALLOWED_ACCESS_LEVELS is
// exactly those two values).
// ---------------------------------------------------------------------------

describe('concept:criteria-based-sharing-widens — SharingRule ruleType==criteria NODE rule', () => {
  const rule = ruleById('rule:sharing/criteria-based-widens');
  const CRITERIA_RULE = 'SharingRule:Ns__Deal__c.Ns__WidenOps';

  it('ships the concept with the access-mechanism kind (REUSED) and an add-only summary', () => {
    const concept = CONCEPTS['concept:criteria-based-sharing-widens'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('add-only');
    expect(summary).toContain('criteria');
  });

  it('is a node-shaped SharingRule rule (componentTypes + SINGLE whereProperty ruleType===criteria, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:criteria-based-sharing-widens');
    expect(rule.bind.componentTypes).toEqual(['SharingRule']);
    // The accessLevel in:[Read,Edit] clause is DROPPED → a SINGLE-clause node rule.
    expect(Array.isArray(rule.bind.whereProperty)).toBe(false);
    expect(rule.bind.whereProperty).toEqual({ key: 'ruleType', equals: 'criteria' });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
  });

  it('fires on a ruleType===criteria SharingRule, cites ONLY that rule, claim add-only, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(CRITERIA_RULE, 'SharingRule', { ruleType: 'criteria', accessLevel: 'Edit' })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, CRITERIA_RULE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:criteria-based-sharing-widens');
    expect(only.groundedIn).toEqual([CRITERIA_RULE]);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(CRITERIA_RULE);
    expect(only.claim.toLowerCase()).toContain('widens');
    expect(only.claim.toLowerCase()).toContain('add-only');
    expect(only.claim.toLowerCase()).toContain('not a proven per-record grant');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[negative — wrong value] an owner / guest / territory SharingRule does NOT fire the criteria rule', () => {
    for (const other of ['owner', 'guest', 'territory']) {
      const otherId = 'SharingRule:Ns__Deal__c.Ns__NonCriteria';
      const slice: GroundedSlice = {
        nodes: [node(otherId, 'SharingRule', { ruleType: other })],
        edges: [],
      };
      expect(interpret(rule, slice, COMPLETE, otherId)).toEqual([]);
    }
  });

  it('[type guard] a non-SharingRule node carrying ruleType===criteria does NOT fire', () => {
    const oddId = 'CustomObject:Ns__Odd__c';
    const slice: GroundedSlice = {
      nodes: [node(oddId, 'CustomObject', { ruleType: 'criteria' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, oddId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-c1 #8) concept:shared-to-all-internal-users-effective-public — a SharingRule
// NODE rule on sharedToType==='allInternalUsers' (the candidate wrongly proposed
// an EDGE; the node scalar makes it buildable). 'Effectively public' is
// CONDITIONAL on a restrictive OWD.
// ---------------------------------------------------------------------------

describe('concept:shared-to-all-internal-users-effective-public — SharingRule sharedToType NODE rule', () => {
  const rule = ruleById('rule:sharing/shared-to-all-internal-users');
  const ALL_INTERNAL_RULE = 'SharingRule:Ns__Deal__c.Ns__AllInternalShare';

  it('ships the concept with the access-mechanism kind (REUSED) and a conditional effective-public summary', () => {
    const concept = CONCEPTS['concept:shared-to-all-internal-users-effective-public'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('all internal users');
    // 'Effectively public' is CONDITIONAL on a restrictive OWD, not unconditional.
    expect(summary).toContain('restrictive');
  });

  it('is a NODE rule (componentTypes + whereProperty sharedToType===allInternalUsers, NOT an edge)', () => {
    expect(rule.concept).toBe('concept:shared-to-all-internal-users-effective-public');
    expect(rule.bind.componentTypes).toEqual(['SharingRule']);
    expect(rule.bind.whereProperty).toEqual({ key: 'sharedToType', equals: 'allInternalUsers' });
    // The candidate wrongly proposed an EDGE — this is a NODE rule.
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.bind.edgeWhereProperty).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
  });

  it('fires on a sharedToType===allInternalUsers rule, cites ONLY that rule, claim conditional on a restrictive OWD, declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(ALL_INTERNAL_RULE, 'SharingRule', {
          ruleType: 'criteria',
          sharedToType: 'allInternalUsers',
          accessLevel: 'Read',
        }),
      ],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, ALL_INTERNAL_RULE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:shared-to-all-internal-users-effective-public');
    expect(only.groundedIn).toEqual([ALL_INTERNAL_RULE]);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(ALL_INTERNAL_RULE);
    expect(only.claim.toLowerCase()).toContain('all internal users');
    expect(only.claim.toLowerCase()).toContain('not a proven per-record grant');
    // 'Effective-public' is qualified by WHEN the OWD is restrictive — no unconditional claim.
    expect(only.claim.toLowerCase()).toContain('restrictive');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[negative — other shared-to] a rule shared to a group / role / partner / guest audience does NOT fire', () => {
    for (const other of ['group', 'role', 'allPartnerUsers', 'guestUser']) {
      const otherId = 'SharingRule:Ns__Deal__c.Ns__NotAllInternal';
      const slice: GroundedSlice = {
        nodes: [node(otherId, 'SharingRule', { ruleType: 'criteria', sharedToType: other })],
        edges: [],
      };
      expect(interpret(rule, slice, COMPLETE, otherId)).toEqual([]);
    }
  });

  it('[type guard] a non-SharingRule node carrying sharedToType===allInternalUsers does NOT fire', () => {
    const oddId = 'Group:Ns__Odd';
    const slice: GroundedSlice = {
      nodes: [node(oddId, 'Group', { sharedToType: 'allInternalUsers' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, oddId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-c1 #10) concept:guest-user-sharing-exposure — a SharingRule NODE rule on
// ruleType==='guest' (unauthenticated Experience Cloud visitor — a top exposure
// vector). Fires only where guest rules exist (org-independent).
// ---------------------------------------------------------------------------

describe('concept:guest-user-sharing-exposure — SharingRule ruleType==guest NODE rule', () => {
  const rule = ruleById('rule:sharing/guest-user-exposure');
  const GUEST_RULE = 'SharingRule:Ns__Deal__c.Ns__GuestShare';

  it('ships the concept with the access-mechanism kind (REUSED) and an unauthenticated-exposure summary', () => {
    const concept = CONCEPTS['concept:guest-user-sharing-exposure'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('unauthenticated');
    expect(summary).toContain('read-only');
  });

  it('is a node-shaped SharingRule rule (componentTypes + whereProperty ruleType===guest, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:guest-user-sharing-exposure');
    expect(rule.bind.componentTypes).toEqual(['SharingRule']);
    expect(rule.bind.whereProperty).toEqual({ key: 'ruleType', equals: 'guest' });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
  });

  it('fires on a ruleType===guest SharingRule, cites ONLY that rule, claim anonymous-surface, declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(GUEST_RULE, 'SharingRule', {
          ruleType: 'guest',
          accessLevel: 'Read',
          siteName: 'Ns__PublicSite',
        }),
      ],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, GUEST_RULE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:guest-user-sharing-exposure');
    expect(only.groundedIn).toEqual([GUEST_RULE]);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(GUEST_RULE);
    expect(only.claim.toLowerCase()).toContain('unauthenticated');
    expect(only.claim.toLowerCase()).toContain('not a proven per-record leak');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[negative — wrong value] a criteria / owner SharingRule does NOT fire the guest rule', () => {
    for (const other of ['criteria', 'owner']) {
      const otherId = 'SharingRule:Ns__Deal__c.Ns__NonGuest';
      const slice: GroundedSlice = {
        nodes: [node(otherId, 'SharingRule', { ruleType: other })],
        edges: [],
      };
      expect(interpret(rule, slice, COMPLETE, otherId)).toEqual([]);
    }
  });

  it('[type guard] a non-SharingRule node carrying ruleType===guest does NOT fire', () => {
    const oddId = 'CustomObject:Ns__Odd__c';
    const slice: GroundedSlice = {
      nodes: [node(oddId, 'CustomObject', { ruleType: 'guest' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, oddId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-c1 #17) concept:owner-based-sharing-redistribution — one SharingRule NODE
// rule (ruleType==='owner') + TWO equals-only sharedWith EDGE rules keyed on the
// edge's own direction ('to' recipient / 'from' source).
// ---------------------------------------------------------------------------

describe('concept:owner-based-sharing-redistribution — SharingRule node + two sharedWith edge rules', () => {
  const OWNER_RULE = 'SharingRule:Ns__Deal__c.Ns__OwnerRedist';
  const RECIPIENT = 'Group:Ns__OpsSquad';
  const SOURCE = 'Role:Ns__FieldRep';
  const nodeRule = ruleById('rule:sharing/owner-based-redistribution');
  const recipientRule = ruleById('rule:sharing/owner-redistribution-recipient');
  const sourceRule = ruleById('rule:sharing/owner-redistribution-source');

  it('ships the concept with the access-mechanism kind (REUSED) and an add-only redistribution summary', () => {
    const concept = CONCEPTS['concept:owner-based-sharing-redistribution'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('add-only');
    expect(summary).toContain('owned');
    expect(summary).toContain('redistribution path');
  });

  it('the NODE rule binds ruleType===owner and fires on an owner rule, citing ONLY that rule, declared', () => {
    expect(nodeRule.bind.componentTypes).toEqual(['SharingRule']);
    expect(nodeRule.bind.whereProperty).toEqual({ key: 'ruleType', equals: 'owner' });
    expect(nodeRule.bind.edgeType).toBeUndefined();
    expect(nodeRule.maxConfidence).toBe('declared');
    const slice: GroundedSlice = {
      nodes: [node(OWNER_RULE, 'SharingRule', { ruleType: 'owner', accessLevel: 'Edit' })],
      edges: [],
    };
    const out = interpret(nodeRule, slice, COMPLETE, OWNER_RULE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.groundedIn).toEqual([OWNER_RULE]);
    expect(only.confidence).toBe('declared');
    expect(only.claim.toLowerCase()).toContain('redistribution path');
    expect(only.claim.toLowerCase()).toContain('not a proven per-record share');
  });

  it('the RECIPIENT edge rule is equals-only on direction===to and cites BOTH endpoints (rule + recipient)', () => {
    expect(recipientRule.bind.edgeType).toBe('sharedWith');
    expect(recipientRule.bind.componentTypes).toEqual(['SharingRule', 'Group', 'Role']);
    expect(recipientRule.bind.edgeWhereProperty).toEqual({ key: 'direction', equals: 'to' });
    const slice: GroundedSlice = {
      nodes: [node(OWNER_RULE, 'SharingRule', { ruleType: 'owner' }), node(RECIPIENT, 'Group')],
      edges: [edge(OWNER_RULE, RECIPIENT, 'sharedWith', 'declared', { direction: 'to' })],
    };
    const out = interpret(recipientRule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:owner-based-sharing-redistribution');
    expect(only.groundedIn).toEqual([OWNER_RULE, RECIPIENT]);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(OWNER_RULE);
    expect(only.claim).toContain(RECIPIENT);
    expect(only.claim.toLowerCase()).toContain('recipient');
  });

  it('the SOURCE edge rule is equals-only on direction===from and cites BOTH endpoints (rule + source)', () => {
    expect(sourceRule.bind.edgeType).toBe('sharedWith');
    expect(sourceRule.bind.edgeWhereProperty).toEqual({ key: 'direction', equals: 'from' });
    const slice: GroundedSlice = {
      nodes: [node(OWNER_RULE, 'SharingRule', { ruleType: 'owner' }), node(SOURCE, 'Role')],
      edges: [edge(OWNER_RULE, SOURCE, 'sharedWith', 'declared', { direction: 'from' })],
    };
    const out = interpret(sourceRule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.groundedIn).toEqual([OWNER_RULE, SOURCE]);
    expect(only.claim).toContain(SOURCE);
    expect(only.claim.toLowerCase()).toContain('source');
  });

  it('[negative — wrong direction] the recipient (to) rule does NOT fire on a from edge, and the source (from) rule not on a to edge', () => {
    const fromSlice: GroundedSlice = {
      nodes: [node(OWNER_RULE, 'SharingRule', { ruleType: 'owner' }), node(SOURCE, 'Role')],
      edges: [edge(OWNER_RULE, SOURCE, 'sharedWith', 'declared', { direction: 'from' })],
    };
    expect(interpret(recipientRule, fromSlice, COMPLETE)).toEqual([]);
    const toSlice: GroundedSlice = {
      nodes: [node(OWNER_RULE, 'SharingRule', { ruleType: 'owner' }), node(RECIPIENT, 'Group')],
      edges: [edge(OWNER_RULE, RECIPIENT, 'sharedWith', 'declared', { direction: 'to' })],
    };
    expect(interpret(sourceRule, toSlice, COMPLETE)).toEqual([]);
  });

  it('[negative — no direction] a criteria-rule sharedWith edge (no direction) fires NEITHER edge rule', () => {
    const criteriaShare = 'SharingRule:Ns__Deal__c.Ns__WidenOps';
    const slice: GroundedSlice = {
      nodes: [node(criteriaShare, 'SharingRule', { ruleType: 'criteria' }), node(RECIPIENT, 'Group')],
      edges: [edge(criteriaShare, RECIPIENT, 'sharedWith', 'declared', {})],
    };
    expect(interpret(recipientRule, slice, COMPLETE)).toEqual([]);
    expect(interpret(sourceRule, slice, COMPLETE)).toEqual([]);
  });

  it('[type guard] the NODE rule does NOT fire on a criteria rule (ruleType!==owner)', () => {
    const notOwner = 'SharingRule:Ns__Deal__c.Ns__NotOwner';
    const slice: GroundedSlice = {
      nodes: [node(notOwner, 'SharingRule', { ruleType: 'criteria' })],
      edges: [],
    };
    expect(interpret(nodeRule, slice, COMPLETE, notOwner)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-c1 #11) concept:role-and-subordinates-cascade — TWO equals-only sharedWith
// EDGE rules keyed on the edge's own inheritance ('subordinates' /
// 'subordinatesInternal'), same shape as the shipped master-detail-cascade edge
// rule.
// ---------------------------------------------------------------------------

describe('concept:role-and-subordinates-cascade — two sharedWith inheritance edge rules', () => {
  const CASCADE_RULE = 'SharingRule:Ns__Deal__c.Ns__RoleCascade';
  const TARGET_ROLE = 'Role:Ns__RegionVp';
  const subRule = ruleById('rule:sharing/role-and-subordinates-cascade');
  const subInternalRule = ruleById('rule:sharing/role-and-subordinates-internal-cascade');

  it('ships the concept with the access-mechanism kind (REUSED) and a subtree-cascade summary', () => {
    const concept = CONCEPTS['concept:role-and-subordinates-cascade'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('subtree');
    expect(summary).toContain('role hierarchy');
  });

  it('the subordinates rule is equals-only on inheritance===subordinates and cites BOTH endpoints (rule + role)', () => {
    expect(subRule.bind.edgeType).toBe('sharedWith');
    expect(subRule.bind.componentTypes).toEqual(['SharingRule', 'Role']);
    expect(subRule.bind.edgeWhereProperty).toEqual({ key: 'inheritance', equals: 'subordinates' });
    expect(subRule.maxConfidence).toBe('declared');
    const slice: GroundedSlice = {
      nodes: [node(CASCADE_RULE, 'SharingRule', { ruleType: 'criteria' }), node(TARGET_ROLE, 'Role')],
      edges: [edge(CASCADE_RULE, TARGET_ROLE, 'sharedWith', 'declared', { inheritance: 'subordinates' })],
    };
    const out = interpret(subRule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:role-and-subordinates-cascade');
    expect(only.groundedIn).toEqual([CASCADE_RULE, TARGET_ROLE]);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(CASCADE_RULE);
    expect(only.claim).toContain(TARGET_ROLE);
    expect(only.claim.toLowerCase()).toContain('subtree');
  });

  it('the internal rule is equals-only on inheritance===subordinatesInternal and scopes to internal subordinates', () => {
    expect(subInternalRule.bind.edgeType).toBe('sharedWith');
    expect(subInternalRule.bind.edgeWhereProperty).toEqual({
      key: 'inheritance',
      equals: 'subordinatesInternal',
    });
    const slice: GroundedSlice = {
      nodes: [node(CASCADE_RULE, 'SharingRule', { ruleType: 'criteria' }), node(TARGET_ROLE, 'Role')],
      edges: [
        edge(CASCADE_RULE, TARGET_ROLE, 'sharedWith', 'declared', { inheritance: 'subordinatesInternal' }),
      ],
    };
    const out = interpret(subInternalRule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.groundedIn).toEqual([CASCADE_RULE, TARGET_ROLE]);
    expect(only.claim.toLowerCase()).toContain('internal');
    expect(only.claim.toLowerCase()).toContain('portal');
  });

  it('[negative — wrong inheritance] the subordinates rule does NOT fire on an internal edge, and vice versa', () => {
    const internalSlice: GroundedSlice = {
      nodes: [node(CASCADE_RULE, 'SharingRule'), node(TARGET_ROLE, 'Role')],
      edges: [
        edge(CASCADE_RULE, TARGET_ROLE, 'sharedWith', 'declared', { inheritance: 'subordinatesInternal' }),
      ],
    };
    expect(interpret(subRule, internalSlice, COMPLETE)).toEqual([]);
    const plainSlice: GroundedSlice = {
      nodes: [node(CASCADE_RULE, 'SharingRule'), node(TARGET_ROLE, 'Role')],
      edges: [edge(CASCADE_RULE, TARGET_ROLE, 'sharedWith', 'declared', { inheritance: 'subordinates' })],
    };
    expect(interpret(subInternalRule, plainSlice, COMPLETE)).toEqual([]);
  });

  it('[negative — no inheritance] a plain role sharedWith edge (no inheritance marker) fires NEITHER rule', () => {
    const slice: GroundedSlice = {
      nodes: [node(CASCADE_RULE, 'SharingRule', { ruleType: 'criteria' }), node(TARGET_ROLE, 'Role')],
      edges: [edge(CASCADE_RULE, TARGET_ROLE, 'sharedWith', 'declared', {})],
    };
    expect(interpret(subRule, slice, COMPLETE)).toEqual([]);
    expect(interpret(subInternalRule, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('concept:role-associated-object-access-level — role associated-object NODE rules', () => {
  // (rule id, property key, value token) for the SEVEN shipped rules.
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:role-access/case-read', 'caseAccessLevel', 'Read'],
    ['rule:role-access/case-edit', 'caseAccessLevel', 'Edit'],
    ['rule:role-access/contact-read', 'contactAccessLevel', 'Read'],
    ['rule:role-access/contact-edit', 'contactAccessLevel', 'Edit'],
    ['rule:role-access/contact-controlled-by-parent', 'contactAccessLevel', 'ControlledByParent'],
    ['rule:role-access/opportunity-read', 'opportunityAccessLevel', 'Read'],
    ['rule:role-access/opportunity-edit', 'opportunityAccessLevel', 'Edit'],
  ];

  it('ships the concept with the access-mechanism kind', () => {
    const concept = CONCEPTS['concept:role-associated-object-access-level'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    // The Case/Opportunity-have-no-Controlled-by-Parent honesty note is in the summary.
    expect(concept!.summary.toLowerCase()).toContain('no controlled-by-parent role option');
  });

  it('deliberately ships NO case- or opportunity-ControlledByParent rule (not a valid Salesforce value)', () => {
    const ids = CONCEPT_RULES.map((r) => r.id);
    // RM-review F7: caseAccessLevel and opportunityAccessLevel admit only
    // Read / Edit / None; only contactAccessLevel admits ControlledByParent.
    expect(ids).not.toContain('rule:role-access/case-controlled-by-parent');
    expect(ids).not.toContain('rule:role-access/opportunity-controlled-by-parent');
    // The seven built rules all exist and bind this concept.
    for (const [ruleId] of CASES) {
      expect(ids).toContain(ruleId);
      expect(ruleById(ruleId).concept).toBe('concept:role-associated-object-access-level');
    }
  });

  it.each(CASES)(
    '%s is a node-shaped Role rule (componentTypes + whereProperty equals, no edge, declared) that cites ONLY the role',
    (ruleId, key, value) => {
      const rule = ruleById(ruleId);
      expect(rule.bind.componentTypes).toEqual(['Role']);
      expect(rule.bind.whereProperty).toEqual({ key, equals: value });
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');
      expect(rule.dependsOnCoverage).toEqual(['Role']);

      const roleId = `Role:Ns__RoleFor_${key}_${value}`;
      const slice: GroundedSlice = { nodes: [node(roleId, 'Role', { [key]: value })], edges: [] };
      const out = interpret(rule, slice, COMPLETE, roleId);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:role-associated-object-access-level');
      expect(only.groundedIn).toEqual([roleId]);
      expect(only.confidence).toBe('declared');
      expect(only.confidence).toBe(weakest('declared', 'declared'));
      expect(only.coverageCaveat).toBeNull();
      expect(only.provenance).toBe('offline_snapshot');
      expect(only.modelVersion).toBe(MODEL_VERSION);
      expect(only.claim).toContain(roleId);
      // Names the DECLARED grant, never a proven per-record outcome.
      expect(only.claim.toLowerCase()).toContain('declared');
      expect(only.claim.toLowerCase()).toContain('not a proven per-record grant');
    },
  );

  it('a role with caseAccessLevel Edit fires ONLY case-edit — not case-read', () => {
    const roleId = 'Role:Ns__CaseEditor';
    const slice: GroundedSlice = { nodes: [node(roleId, 'Role', { caseAccessLevel: 'Edit' })], edges: [] };
    expect(interpret(ruleById('rule:role-access/case-edit'), slice, COMPLETE, roleId)).toHaveLength(1);
    expect(interpret(ruleById('rule:role-access/case-read'), slice, COMPLETE, roleId)).toEqual([]);
  });

  it('a role with None / absent associated-object access fires NOTHING (no grant = no claim)', () => {
    const noneRole = 'Role:Ns__NoAccess';
    const noneSlice: GroundedSlice = {
      nodes: [node(noneRole, 'Role', { caseAccessLevel: 'None', contactAccessLevel: 'None', opportunityAccessLevel: 'None' })],
      edges: [],
    };
    const bareSlice: GroundedSlice = { nodes: [node(noneRole, 'Role', {})], edges: [] };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), noneSlice, COMPLETE, noneRole)).toEqual([]);
      expect(interpret(ruleById(ruleId), bareSlice, COMPLETE, noneRole)).toEqual([]);
    }
  });

  it('[type guard] a non-Role node carrying an access-level token does NOT fire (componentTypes scopes the match)', () => {
    const slice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Case', 'CustomObject', { caseAccessLevel: 'Edit' })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), slice, COMPLETE, 'CustomObject:Ns__Case')).toEqual([]);
    }
  });

  it('[disjoint values] a role granting Contact Read AND Case Edit fires BOTH rules, each with its own consequence', () => {
    const roleId = 'Role:Ns__MixedGrant';
    const slice: GroundedSlice = {
      nodes: [node(roleId, 'Role', { contactAccessLevel: 'Read', caseAccessLevel: 'Edit' })],
      edges: [],
    };
    const contact = interpret(ruleById('rule:role-access/contact-read'), slice, COMPLETE, roleId);
    const kase = interpret(ruleById('rule:role-access/case-edit'), slice, COMPLETE, roleId);
    expect(contact).toHaveLength(1);
    expect(kase).toHaveLength(1);
    expect(contact[0]!.claim.toLowerCase()).toContain('contacts');
    expect(kase[0]!.claim.toLowerCase()).toContain('cases');
  });
});

// ---------------------------------------------------------------------------
// ARC-2 #9 — concept:restriction-rule-narrows-below-sharing. ONE NODE rule over a
// RestrictionRule's grounded `active` STRING property (enterprise-metadata.ts:1625,
// extraProperties → Record<string,string>). It fires on `active === 'true'` (a
// STRING equals, NOT a boolean), cites the rule, confidence declared. It must NOT
// fire on an inactive rule, an absent `active`, a boolean `true` (wrong shape), or a
// non-RestrictionRule node.
// ---------------------------------------------------------------------------

describe('concept:restriction-rule-narrows-below-sharing — rule:restriction-rule/narrows-below-sharing', () => {
  const rule = ruleById('rule:restriction-rule/narrows-below-sharing');
  const ACTIVE_RR = 'RestrictionRule:Ns__Case.Limit_To_Owner';
  const INACTIVE_RR = 'RestrictionRule:Ns__Case.Disabled_Rule';

  it('ships the concept with the access-mechanism kind and the subtractive-mechanism summary', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
    expect(CONCEPTS[rule.concept]!.summary.toLowerCase()).toContain('sole subtractive one');
  });

  it('is a node-shaped RestrictionRule rule keying the STRING active equals "true"', () => {
    expect(rule.concept).toBe('concept:restriction-rule-narrows-below-sharing');
    expect(rule.bind.componentTypes).toEqual(['RestrictionRule']);
    // A STRING 'true' — the extractor emits `active` as a string extra-property.
    expect(rule.bind.whereProperty).toEqual({ key: 'active', equals: 'true' });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['RestrictionRule']);
  });

  it('fires on an ACTIVE restriction rule (active==="true"), cites the rule, claims narrowing, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(ACTIVE_RR, 'RestrictionRule', { active: 'true', enforcementType: 'Restriction' })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, ACTIVE_RR);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:restriction-rule-narrows-below-sharing');
    expect(only.groundedIn).toEqual([ACTIVE_RR]);
    expect(only.claim).toContain(ACTIVE_RR);
    expect(only.claim.toLowerCase()).toContain('narrows');
    expect(only.claim.toLowerCase()).toContain('sole subtractive');
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on an inactive rule (active==="false"), an absent active, or a boolean true (string-equals semantics)', () => {
    const inactive: GroundedSlice = { nodes: [node(INACTIVE_RR, 'RestrictionRule', { active: 'false' })], edges: [] };
    const absent: GroundedSlice = { nodes: [node(INACTIVE_RR, 'RestrictionRule', {})], edges: [] };
    // A boolean `true` is the WRONG shape (extractor emits a string) — strict === must reject it.
    const boolTrue: GroundedSlice = { nodes: [node(INACTIVE_RR, 'RestrictionRule', { active: true })], edges: [] };
    expect(interpret(rule, inactive, COMPLETE, INACTIVE_RR)).toEqual([]);
    expect(interpret(rule, absent, COMPLETE, INACTIVE_RR)).toEqual([]);
    expect(interpret(rule, boolTrue, COMPLETE, INACTIVE_RR)).toEqual([]);
  });

  it('[type guard] a non-RestrictionRule node carrying active==="true" does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Case', 'CustomObject', { active: 'true' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'CustomObject:Ns__Case')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 #12 — concept:role-hierarchy-grant-inheritance. ONE EDGE rule over the
// Role `inheritsFrom` edge (Role --inheritsFrom--> parent role, role.ts:201-213).
// It cites the immediate parent/child endpoints via `{ids}`, names ONLY the
// immediate hop (transitive mechanism is in the summary), confidence computed from
// the matched edge. Dangling parent (not in slice) cites only the grounded child.
// ---------------------------------------------------------------------------

describe('concept:role-hierarchy-grant-inheritance — rule:role-hierarchy/grant-inheritance', () => {
  const rule = ruleById('rule:role-hierarchy/grant-inheritance');
  const ROLE_CHILD = 'Role:Ns__RegionalManager';
  const ROLE_PARENT = 'Role:Ns__VP';

  it('ships the concept with the access-mechanism kind and the TRANSITIVE-chain summary', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
    // The transitive up-the-chain mechanism lives in the SUMMARY, not the per-edge rule.
    expect(CONCEPTS[rule.concept]!.summary.toLowerCase()).toContain('transitive');
  });

  it('is an edge-shaped Role rule (edgeType inheritsFrom, componentTypes [Role], declared)', () => {
    expect(rule.concept).toBe('concept:role-hierarchy-grant-inheritance');
    expect(rule.bind.edgeType).toBe('inheritsFrom');
    expect(rule.bind.componentTypes).toEqual(['Role']);
    expect(rule.bind.whereProperty).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['Role']);
  });

  it('fires on an inheritsFrom link, cites both immediate endpoints, names ONLY the immediate hop, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(ROLE_CHILD, 'Role'), node(ROLE_PARENT, 'Role')],
      edges: [edge(ROLE_CHILD, ROLE_PARENT, 'inheritsFrom', 'declared')],
    };
    const out = interpret(rule, slice, COMPLETE, ROLE_CHILD);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:role-hierarchy-grant-inheritance');
    expect(only.groundedIn).toEqual([ROLE_CHILD, ROLE_PARENT]);
    expect(only.claim).toContain(ROLE_CHILD);
    expect(only.claim).toContain(ROLE_PARENT);
    expect(only.claim.toLowerCase()).toContain('immediate');
    expect(only.claim.toLowerCase()).toContain('not the full transitive chain');
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('grounds the same link from the PARENT anchor (incoming inheritsFrom edge), citing both endpoints', () => {
    const slice: GroundedSlice = {
      nodes: [node(ROLE_CHILD, 'Role'), node(ROLE_PARENT, 'Role')],
      edges: [edge(ROLE_CHILD, ROLE_PARENT, 'inheritsFrom', 'declared')],
    };
    const out = interpret(rule, slice, COMPLETE, ROLE_PARENT);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([ROLE_CHILD, ROLE_PARENT]);
  });

  it('[dangling parent] a parent role NOT in the slice still fires but cites ONLY the grounded child', () => {
    const slice: GroundedSlice = {
      nodes: [node(ROLE_CHILD, 'Role')],
      edges: [edge(ROLE_CHILD, ROLE_PARENT, 'inheritsFrom', 'declared')],
    };
    const out = interpret(rule, slice, COMPLETE, ROLE_CHILD);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([ROLE_CHILD]);
    expect(out[0]!.groundedIn).not.toContain(ROLE_PARENT);
    expect(out[0]!.claim).toContain(ROLE_CHILD);
    expect(out[0]!.claim).not.toContain(ROLE_PARENT);
  });

  it('COMPUTES confidence from the matched edge: a heuristic inheritsFrom edge caps the claim to heuristic', () => {
    const slice: GroundedSlice = {
      nodes: [node(ROLE_CHILD, 'Role'), node(ROLE_PARENT, 'Role')],
      edges: [edge(ROLE_CHILD, ROLE_PARENT, 'inheritsFrom', 'heuristic')],
    };
    const out = interpret(rule, slice, COMPLETE, ROLE_CHILD);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(weakest('declared', 'heuristic'));
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('does NOT fire without an inheritsFrom edge (a top-of-hierarchy role), nor for a different edge type', () => {
    const topRole: GroundedSlice = { nodes: [node(ROLE_PARENT, 'Role')], edges: [] };
    expect(interpret(rule, topRole, COMPLETE, ROLE_PARENT)).toEqual([]);
    const wrongEdge: GroundedSlice = {
      nodes: [node(ROLE_CHILD, 'Role'), node(ROLE_PARENT, 'Role')],
      edges: [edge(ROLE_CHILD, ROLE_PARENT, 'lookupTo', 'declared', { relationshipType: 'Lookup' })],
    };
    expect(interpret(rule, wrongEdge, COMPLETE, ROLE_CHILD)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 #13 — concept:network-guest-and-selfreg-exposure-posture. FOUR sibling
// single-predicate NODE rules over a Network's grounded selfRegistration /
// enableGuestFileAccess / enableGuestChatter / enableGuestMemberVisibility booleans
// (network.ts:190-194). Each fires on its own switch === true, cites ONLY the
// network, confidence declared. An OFF/absent switch fires nothing; componentTypes
// scopes to Network; allowInternalUserLogin is deliberately NOT a rule.
// ---------------------------------------------------------------------------

describe('concept:network-guest-and-selfreg-exposure-posture — Network guest/self-reg NODE rules', () => {
  const NET = 'Network:Ns__PartnerPortal';
  // (rule id, switch key, a distinctive phrase from the claim).
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['rule:network/self-registration', 'selfRegistration', 'self-registration'],
    ['rule:network/guest-file-access', 'enableGuestFileAccess', 'guest file access'],
    ['rule:network/guest-chatter', 'enableGuestChatter', 'guest chatter'],
    ['rule:network/guest-member-visibility', 'enableGuestMemberVisibility', 'guest member visibility'],
  ];

  it('ships the concept with the access-mechanism kind and drops allowInternalUserLogin from the summary scope', () => {
    const concept = CONCEPTS['concept:network-guest-and-selfreg-exposure-posture'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    // allowInternalUserLogin is explicitly excluded (internal login, not guest exposure).
    expect(concept!.summary).toContain('allowInternalUserLogin');
    expect(concept!.summary.toLowerCase()).toContain('deliberately not part of this concept');
    // No rule keys allowInternalUserLogin.
    for (const r of CONCEPT_RULES.filter((x) => x.concept === 'concept:network-guest-and-selfreg-exposure-posture')) {
      expect(JSON.stringify(r.bind.whereProperty)).not.toContain('allowInternalUserLogin');
    }
  });

  it.each(CASES)(
    '%s is a node-shaped Network rule (componentTypes + whereProperty equals:true, no edge, declared) citing ONLY the network',
    (ruleId, key, phrase) => {
      const rule = ruleById(ruleId);
      expect(rule.concept).toBe('concept:network-guest-and-selfreg-exposure-posture');
      expect(rule.bind.componentTypes).toEqual(['Network']);
      expect(rule.bind.whereProperty).toEqual({ key, equals: true });
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.absenceShaped).toBe(false);
      expect(rule.maxConfidence).toBe('declared');
      expect(rule.dependsOnCoverage).toEqual(['Network']);

      const slice: GroundedSlice = { nodes: [node(NET, 'Network', { [key]: true })], edges: [] };
      const out = interpret(rule, slice, COMPLETE, NET);
      expect(out).toHaveLength(1);
      const only = out[0]!;
      expect(only.concept).toBe('concept:network-guest-and-selfreg-exposure-posture');
      expect(only.groundedIn).toEqual([NET]);
      expect(only.confidence).toBe('declared');
      expect(only.coverageCaveat).toBeNull();
      expect(only.provenance).toBe('offline_snapshot');
      expect(only.modelVersion).toBe(MODEL_VERSION);
      expect(only.claim).toContain(NET);
      expect(only.claim.toLowerCase()).toContain(phrase);
      expect(only.claim.toLowerCase()).toContain('unauthenticated');
    },
  );

  it('an OFF (false) or absent switch fires NOTHING', () => {
    const off: GroundedSlice = {
      nodes: [node(NET, 'Network', {
        selfRegistration: false, enableGuestFileAccess: false, enableGuestChatter: false, enableGuestMemberVisibility: false,
      })],
      edges: [],
    };
    const bare: GroundedSlice = { nodes: [node(NET, 'Network', {})], edges: [] };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), off, COMPLETE, NET)).toEqual([]);
      expect(interpret(ruleById(ruleId), bare, COMPLETE, NET)).toEqual([]);
    }
  });

  it('[type guard] a non-Network node carrying a guest switch does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Site', 'CustomObject', { selfRegistration: true })],
      edges: [],
    };
    for (const [ruleId] of CASES) {
      expect(interpret(ruleById(ruleId), slice, COMPLETE, 'CustomObject:Ns__Site')).toEqual([]);
    }
  });

  it('[independent siblings] a network with two switches ON fires BOTH corresponding rules, each with its own consequence', () => {
    const slice: GroundedSlice = {
      nodes: [node(NET, 'Network', { selfRegistration: true, enableGuestFileAccess: true })],
      edges: [],
    };
    const selfReg = interpret(ruleById('rule:network/self-registration'), slice, COMPLETE, NET);
    const guestFile = interpret(ruleById('rule:network/guest-file-access'), slice, COMPLETE, NET);
    expect(selfReg).toHaveLength(1);
    expect(guestFile).toHaveLength(1);
    expect(selfReg[0]!.claim.toLowerCase()).toContain('self-registration');
    expect(guestFile[0]!.claim.toLowerCase()).toContain('guest file access');
    // The guest-chatter / member-visibility switches are OFF here → those siblings stay silent.
    expect(interpret(ruleById('rule:network/guest-chatter'), slice, COMPLETE, NET)).toEqual([]);
    expect(interpret(ruleById('rule:network/guest-member-visibility'), slice, COMPLETE, NET)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 BACKFILL — concept:apex-sharing-mode 'unspecified'. A NEW rule APPENDED to
// the ALREADY-SHIPPED apex-sharing-mode concept, closing the no-sharing-keyword case
// the without-/inherited-sharing rules deferred. It fires when an ApexClass's
// `sharingModel` is NULLISH (null OR the key absent — apex-header-parser.ts defaults
// it to null when no keyword is declared) via the isNull operator, and NOT on a
// present with/without/inherited value. Honest claim: inherits the caller's mode; runs
// in SYSTEM context (without sharing enforcement) only when it is the entry point.
// ---------------------------------------------------------------------------

describe('concept:apex-sharing-mode — rule:apex-sharing/unspecified (isNull backfill)', () => {
  const rule = ruleById('rule:apex-sharing/unspecified');
  const UNSPEC_NULL = 'ApexClass:Ns__LegacyNoKeyword';
  const UNSPEC_ABSENT = 'ApexClass:Ns__LegacyBareHeader';

  it('binds the ALREADY-SHIPPED apex-sharing-mode concept (access-mechanism) — no new concept invented', () => {
    expect(rule.concept).toBe('concept:apex-sharing-mode');
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
    // The four value-space rules all share the one concept.
    for (const id of ['rule:apex-sharing/without-sharing', 'rule:apex-sharing/inherited-sharing', 'rule:apex-sharing/unspecified']) {
      expect(ruleById(id).concept).toBe('concept:apex-sharing-mode');
    }
  });

  it('is a node-shaped ApexClass rule keying sharingModel isNull:true (the operator), declared', () => {
    expect(rule.bind.componentTypes).toEqual(['ApexClass']);
    expect(rule.bind.whereProperty).toEqual({ key: 'sharingModel', isNull: true });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['ApexClass']);
  });

  it('fires on a null OR absent sharingModel (both nullish), cites the class, claims caller/entry-point context, declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(UNSPEC_NULL, 'ApexClass', { sharingModel: null }), // present-as-null → nullish → fires
        node(UNSPEC_ABSENT, 'ApexClass', {}), // absent key → nullish → fires
      ],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE); // no rootId → cites all matching nodes
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:apex-sharing-mode');
    expect(only.groundedIn).toEqual([UNSPEC_NULL, UNSPEC_ABSENT]);
    expect(only.claim.toLowerCase()).toContain('no sharing keyword');
    expect(only.claim.toLowerCase()).toContain('entry point');
    expect(only.claim.toLowerCase()).toContain('system context');
    // Honest boundary: declared (absent-keyword) posture, not a proven outcome.
    expect(only.claim.toLowerCase()).toContain('not a proven access outcome');
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on a with / without / inherited sharing class (a PRESENT value is not nullish)', () => {
    for (const value of ['with sharing', 'without sharing', 'inherited sharing']) {
      const id = `ApexClass:Ns__Declared_${value.replace(' ', '_')}`;
      const slice: GroundedSlice = { nodes: [node(id, 'ApexClass', { sharingModel: value })], edges: [] };
      expect(interpret(rule, slice, COMPLETE, id)).toEqual([]);
    }
  });

  it('[type guard] a non-ApexClass node with a null sharingModel does NOT fire (no cross-contamination with OWD)', () => {
    // A CustomObject with a null sharingModel (a custom setting / CMT / platform event —
    // the OWD null case) must NOT trip the Apex unspecified rule.
    const slice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Setting__c', 'CustomObject', { sharingModel: null })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'CustomObject:Ns__Setting__c')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('concept:workflow-field-update-partial-resave — rule:workflow/field-update-partial-resave', () => {
  const rule = ruleById('rule:workflow/field-update-partial-resave');
  const WF_FIELD_UPDATE = 'WorkflowRule:Ns__Account.Set_Tier';
  const WF_NO_ACTION = 'WorkflowRule:Ns__Account.Notify_Only';

  it('ships the concept with the save-order-phase kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('save-order-phase');
  });

  it('is a node-shaped WorkflowRule rule (componentTypes + whereProperty fieldUpdateCount neq 0, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:workflow-field-update-partial-resave');
    expect(rule.bind.componentTypes).toEqual(['WorkflowRule']);
    expect(rule.bind.whereProperty).toEqual({ key: 'fieldUpdateCount', neq: 0 });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['WorkflowRule']);
  });

  it('fires on a rule with immediate field updates, cites ONLY that rule, claims a partial save-order re-run, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(WF_FIELD_UPDATE, 'WorkflowRule', { fieldUpdateCount: 2, timeTriggerCount: 0 })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, WF_FIELD_UPDATE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:workflow-field-update-partial-resave');
    expect(only.groundedIn).toEqual([WF_FIELD_UPDATE]);
    expect(only.claim).toContain(WF_FIELD_UPDATE);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('field update');
    expect(lower).toContain('re-run');
    // Re-runs standard validation but NOT custom validation rules (the OOE gotcha).
    expect(lower).toContain('standard');
    expect(lower).toContain('custom validation rules');
    // Under-fires on time-dependent updates — never over-claims.
    expect(lower).toContain('time-dependent');
    // A node match carries no edge confidence → declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on a rule with zero immediate field updates (fieldUpdateCount 0 fails neq 0)', () => {
    const slice: GroundedSlice = {
      nodes: [node(WF_NO_ACTION, 'WorkflowRule', { fieldUpdateCount: 0, timeTriggerCount: 0 })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, WF_NO_ACTION)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-WorkflowRule node carrying fieldUpdateCount does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('Flow:Ns__Odd', 'Flow', { fieldUpdateCount: 3 })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Odd')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-cluster-c3 (backlog #14) — concept:workflow-time-dependent-action-deferred.
// A NODE rule keying the WorkflowRule extractor's always-present `timeTriggerCount`
// int with `neq: 0` (== count>=1). Fires on a rule with time-dependent actions,
// claims the deferred separate-transaction async boundary, cites ONLY that rule,
// declared confidence. A timeTriggerCount-0 rule does NOT fire; componentTypes
// scopes it to WorkflowRule; keys a DIFFERENT property than the field-update rule.
// ---------------------------------------------------------------------------

describe('concept:workflow-time-dependent-action-deferred — rule:workflow/time-dependent-action-deferred', () => {
  const rule = ruleById('rule:workflow/time-dependent-action-deferred');
  const WF_TIME = 'WorkflowRule:Ns__Case.Escalate_After_SLA';
  const WF_IMMEDIATE_ONLY = 'WorkflowRule:Ns__Case.Set_Priority';

  it('ships the concept with the async-boundary kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('async-boundary');
  });

  it('is a node-shaped WorkflowRule rule (componentTypes + whereProperty timeTriggerCount neq 0, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:workflow-time-dependent-action-deferred');
    expect(rule.bind.componentTypes).toEqual(['WorkflowRule']);
    expect(rule.bind.whereProperty).toEqual({ key: 'timeTriggerCount', neq: 0 });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['WorkflowRule']);
  });

  it('fires on a rule with time-dependent actions, cites ONLY that rule, claims a deferred separate transaction, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(WF_TIME, 'WorkflowRule', { timeTriggerCount: 1, fieldUpdateCount: 0 })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, WF_TIME);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:workflow-time-dependent-action-deferred');
    expect(only.groundedIn).toEqual([WF_TIME]);
    expect(only.claim).toContain(WF_TIME);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('time-dependent');
    expect(lower).toContain('separate transaction');
    expect(lower).toContain('deferred');
    // Does NOT assert WHEN it runs or whether it succeeds (honest boundary).
    expect(lower).toContain('does not evaluate the offset');
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on a rule with only immediate actions (timeTriggerCount 0 fails neq 0)', () => {
    const slice: GroundedSlice = {
      nodes: [node(WF_IMMEDIATE_ONLY, 'WorkflowRule', { timeTriggerCount: 0, fieldUpdateCount: 2 })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, WF_IMMEDIATE_ONLY)).toEqual([]);
  });

  it('[disjoint keys] a rule with BOTH time triggers and field updates fires BOTH workflow rules, each its own consequence', () => {
    const BOTH = 'WorkflowRule:Ns__Case.Escalate_And_Set';
    const slice: GroundedSlice = {
      nodes: [node(BOTH, 'WorkflowRule', { timeTriggerCount: 2, fieldUpdateCount: 1 })],
      edges: [],
    };
    const timeOut = interpret(rule, slice, COMPLETE, BOTH);
    const fieldOut = interpret(
      ruleById('rule:workflow/field-update-partial-resave'),
      slice,
      COMPLETE,
      BOTH,
    );
    expect(timeOut).toHaveLength(1);
    expect(fieldOut).toHaveLength(1);
    expect(timeOut[0]!.claim.toLowerCase()).toContain('time-dependent');
    expect(fieldOut[0]!.claim.toLowerCase()).toContain('field update');
  });

  it('componentTypes scopes the match: a non-WorkflowRule node carrying timeTriggerCount does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('Flow:Ns__Odd2', 'Flow', { timeTriggerCount: 4 })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Odd2')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-cluster-c3 (backlog #7) — concept:flow-scheduled-path-post-commit-fault.
// A NODE rule keying the Flow extractor's always-present `runAsyncAfterCommit`
// boolean with equals:true. Fires on a flow declaring an immediately-after-commit
// async scheduled path, claims the fault-cannot-roll-back-the-committed-save
// boundary, cites ONLY that flow, declared confidence. A false / absent flag does
// NOT fire; componentTypes scopes it to Flow; disjoint from runInMode.
// ---------------------------------------------------------------------------

describe('concept:flow-scheduled-path-post-commit-fault — rule:flow/scheduled-path-post-commit-fault', () => {
  const rule = ruleById('rule:flow/scheduled-path-post-commit-fault');
  const ASYNC_FLOW = 'Flow:Ns__Deal_After_AsyncPath';
  const SYNC_FLOW = 'Flow:Ns__Deal_After_SyncOnly';

  it('ships the concept with the async-boundary kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('async-boundary');
  });

  it('is a node-shaped Flow rule (componentTypes + whereProperty runAsyncAfterCommit===true, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:flow-scheduled-path-post-commit-fault');
    expect(rule.bind.componentTypes).toEqual(['Flow']);
    expect(rule.bind.whereProperty).toEqual({ key: 'runAsyncAfterCommit', equals: true });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['Flow']);
  });

  it('fires on a flow with an async post-commit path, cites ONLY that flow, claims a fault cannot roll back the save, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(ASYNC_FLOW, 'Flow', { runAsyncAfterCommit: true })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, ASYNC_FLOW);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:flow-scheduled-path-post-commit-fault');
    expect(only.groundedIn).toEqual([ASYNC_FLOW]);
    expect(only.claim).toContain(ASYNC_FLOW);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('separate transaction');
    expect(lower).toContain('after the triggering save has already committed');
    // The distinctive consequence: a fault cannot roll back the committed save.
    expect(lower).toContain('cannot roll back');
    // Does NOT assert WHEN it runs or whether it succeeds (honest boundary).
    expect(lower).toContain('does not assert when');
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on a flow with no async-after-commit path (runAsyncAfterCommit false), nor on a bare node (absent flag)', () => {
    const falseSlice: GroundedSlice = {
      nodes: [node(SYNC_FLOW, 'Flow', { runAsyncAfterCommit: false })],
      edges: [],
    };
    const bareSlice: GroundedSlice = { nodes: [node(SYNC_FLOW, 'Flow', {})], edges: [] };
    expect(interpret(rule, falseSlice, COMPLETE, SYNC_FLOW)).toEqual([]);
    expect(interpret(rule, bareSlice, COMPLETE, SYNC_FLOW)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-Flow node carrying runAsyncAfterCommit===true does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('ApexClass:Ns__Odd', 'ApexClass', { runAsyncAfterCommit: true })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'ApexClass:Ns__Odd')).toEqual([]);
  });

  it('[no cross-contamination] keys runAsyncAfterCommit, NOT runInMode — a system-mode flow does not trip it and vice-versa', () => {
    const runModeSlice: GroundedSlice = {
      nodes: [node(SYNC_FLOW, 'Flow', { runInMode: 'SystemModeWithoutSharing' })],
      edges: [],
    };
    expect(interpret(rule, runModeSlice, COMPLETE, SYNC_FLOW)).toEqual([]);
    const asyncSlice: GroundedSlice = {
      nodes: [node(ASYNC_FLOW, 'Flow', { runAsyncAfterCommit: true })],
      edges: [],
    };
    expect(
      interpret(ruleById('rule:flow-run-mode/system-without-sharing'), asyncSlice, COMPLETE, ASYNC_FLOW),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-cluster-c3 (backlog #16) — concept:flow-platform-event-triggered-async.
// A NODE rule keying the Flow extractor's always-key-present `triggerType` scalar
// with equals:'PlatformEvent'. Fires on a platform-event-triggered flow, claims
// the async Automated-Process-user boundary, cites ONLY that flow, declared
// confidence. A record-triggered / scheduled / null flow does NOT fire;
// componentTypes scopes it to Flow; disjoint from runInMode / runAsyncAfterCommit.
// ---------------------------------------------------------------------------

describe('concept:flow-platform-event-triggered-async — rule:flow/platform-event-triggered-async', () => {
  const rule = ruleById('rule:flow/platform-event-triggered-async');
  const PE_FLOW = 'Flow:Ns__Order_Event_Handler';
  const RECORD_FLOW = 'Flow:Ns__Deal_After_Save';

  it('ships the concept with the async-boundary kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('async-boundary');
  });

  it('is a node-shaped Flow rule (componentTypes + whereProperty triggerType===PlatformEvent, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:flow-platform-event-triggered-async');
    expect(rule.bind.componentTypes).toEqual(['Flow']);
    expect(rule.bind.whereProperty).toEqual({ key: 'triggerType', equals: 'PlatformEvent' });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['Flow']);
  });

  it('fires on a platform-event-triggered flow, cites ONLY that flow, claims async + Automated Process user, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(PE_FLOW, 'Flow', { triggerType: 'PlatformEvent' })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, PE_FLOW);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:flow-platform-event-triggered-async');
    expect(only.groundedIn).toEqual([PE_FLOW]);
    expect(only.claim).toContain(PE_FLOW);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('platform event');
    expect(lower).toContain('asynchronously');
    expect(lower).toContain('automated process user');
    // Cannot roll back the publisher's save; delivery not exactly-once.
    expect(lower).toContain('cannot roll back');
    expect(lower).toContain('not exactly-once');
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on a record-triggered / scheduled / null-triggerType flow, nor a bare node', () => {
    for (const props of [
      { triggerType: 'RecordAfterSave' },
      { triggerType: 'RecordBeforeSave' },
      { triggerType: 'Scheduled' },
      { triggerType: null },
      {},
    ]) {
      const slice: GroundedSlice = { nodes: [node(RECORD_FLOW, 'Flow', props)], edges: [] };
      expect(interpret(rule, slice, COMPLETE, RECORD_FLOW)).toEqual([]);
    }
  });

  it('componentTypes scopes the match: a non-Flow node carrying triggerType===PlatformEvent does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('ApexTrigger:Ns__Odd', 'ApexTrigger', { triggerType: 'PlatformEvent' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'ApexTrigger:Ns__Odd')).toEqual([]);
  });

  it('[no cross-contamination] keys triggerType, NOT runInMode / runAsyncAfterCommit — the other Flow async concepts stay disjoint', () => {
    const peSlice: GroundedSlice = {
      nodes: [node(PE_FLOW, 'Flow', { triggerType: 'PlatformEvent' })],
      edges: [],
    };
    expect(
      interpret(ruleById('rule:flow-run-mode/system-without-sharing'), peSlice, COMPLETE, PE_FLOW),
    ).toEqual([]);
    expect(
      interpret(ruleById('rule:flow/scheduled-path-post-commit-fault'), peSlice, COMPLETE, PE_FLOW),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-cluster-c3 (backlog #15) — concept:apex-trigger-platform-event-async.
// A NODE rule keying the ApexTrigger extractor's always-present
// `isPlatformEventSubscriber` boolean with equals:true. Fires on a trigger whose
// target is an __e event, claims the async Automated-Process-user boundary, cites
// ONLY that trigger, declared confidence. A trigger on a normal SObject (flag false
// or absent) does NOT fire; componentTypes scopes it to ApexTrigger; ApexTrigger
// analog of the Flow PE concept, disjoint from the ApexClass async markers.
// ---------------------------------------------------------------------------

describe('concept:apex-trigger-platform-event-async — rule:apex-trigger/platform-event-async', () => {
  const rule = ruleById('rule:apex-trigger/platform-event-async');
  const PE_TRIGGER = 'ApexTrigger:Ns__OrderEvent__e';
  const SOBJECT_TRIGGER = 'ApexTrigger:Ns__AccountTrigger';

  it('ships the concept with the async-boundary kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('async-boundary');
  });

  it('is a node-shaped ApexTrigger rule (componentTypes + whereProperty isPlatformEventSubscriber===true, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:apex-trigger-platform-event-async');
    expect(rule.bind.componentTypes).toEqual(['ApexTrigger']);
    expect(rule.bind.whereProperty).toEqual({ key: 'isPlatformEventSubscriber', equals: true });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['ApexTrigger']);
  });

  it('fires on a platform-event trigger, cites ONLY that trigger, claims async + Automated Process user, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(PE_TRIGGER, 'ApexTrigger', { isPlatformEventSubscriber: true })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, PE_TRIGGER);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:apex-trigger-platform-event-async');
    expect(only.groundedIn).toEqual([PE_TRIGGER]);
    expect(only.claim).toContain(PE_TRIGGER);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('platform event');
    expect(lower).toContain('asynchronously');
    expect(lower).toContain('separate transaction');
    expect(lower).toContain('automated process user');
    expect(lower).toContain('cannot roll back');
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on a trigger on a normal SObject (flag false), nor on a bare node (absent flag)', () => {
    const falseSlice: GroundedSlice = {
      nodes: [node(SOBJECT_TRIGGER, 'ApexTrigger', { isPlatformEventSubscriber: false })],
      edges: [],
    };
    const bareSlice: GroundedSlice = { nodes: [node(SOBJECT_TRIGGER, 'ApexTrigger', {})], edges: [] };
    expect(interpret(rule, falseSlice, COMPLETE, SOBJECT_TRIGGER)).toEqual([]);
    expect(interpret(rule, bareSlice, COMPLETE, SOBJECT_TRIGGER)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-ApexTrigger node carrying isPlatformEventSubscriber===true does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('Flow:Ns__Odd', 'Flow', { isPlatformEventSubscriber: true })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Odd')).toEqual([]);
  });

  it('[disjoint from ApexClass async markers] a platform-event trigger does NOT trip the class-marker async rules, and vice-versa', () => {
    const triggerSlice: GroundedSlice = {
      nodes: [node(PE_TRIGGER, 'ApexTrigger', { isPlatformEventSubscriber: true })],
      edges: [],
    };
    expect(interpret(ruleById('rule:async-boundary/queueable'), triggerSlice, COMPLETE, PE_TRIGGER)).toEqual([]);
    const classSlice: GroundedSlice = {
      nodes: [node('ApexClass:Ns__Job', 'ApexClass', { isQueueable: true })],
      edges: [],
    };
    expect(interpret(rule, classSlice, COMPLETE, 'ApexClass:Ns__Job')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RM-cluster-c3 (backlog #5) — concept:apex-trigger-per-object-multiplicity.
// The AGGREGATE group-count rule — the Apex-trigger analog of the shipped Flow-only
// stacked-flows count. Counts DISTINCT ACTIVE ApexTrigger firers incident to a root
// CustomObject (edgeType triggersOn, componentTypes [ApexTrigger], endpointWhereProperty
// status==Active, op gte, threshold 2), relying on the aggregate DEFAULTS
// (root-incident / countDistinctEndpoint from / SINGLE_GROUP). Fires once per object
// with >= 2 active triggers, citing the triggers FIRST and the object TRAILING
// (rootFirst=false). Inactive triggers and Flow firers are never counted; no save
// phase is hardcoded (SINGLE_GROUP → no {timing}). Modeled on the reason.test.ts
// stacked-flows aggregate suite.
// ---------------------------------------------------------------------------

describe('concept:apex-trigger-per-object-multiplicity — rule:automation/apex-trigger-per-object-multiplicity', () => {
  const rule = ruleById('rule:automation/apex-trigger-per-object-multiplicity');
  const OBJ = 'CustomObject:Ns__Deal__c';
  const TRIG_A = 'ApexTrigger:Ns__DealTriggerA';
  const TRIG_B = 'ApexTrigger:Ns__DealTriggerB';
  const TRIG_C = 'ApexTrigger:Ns__DealTriggerC';

  const activeTrigger = (id: string): Node => node(id, 'ApexTrigger', { status: 'Active' });
  // The counted edge: trigger --triggersOn--> object (firer=from, object=to=root).
  const triggersOn = (trigId: string): Edge => edge(trigId, OBJ, 'triggersOn', 'declared');

  it('ships the concept with the automation-collision kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('automation-collision');
  });

  it('has the shipped AGGREGATE bind structure (mirrors stacked-flows / junction): triggersOn + [ApexTrigger] + aggregate group-count, defaults for edgeSource/countDistinctEndpoint/SINGLE_GROUP', () => {
    expect(rule.concept).toBe('concept:apex-trigger-per-object-multiplicity');
    expect(rule.bind.edgeType).toBe('triggersOn');
    expect(rule.bind.componentTypes).toEqual(['ApexTrigger']);
    expect(rule.bind.aggregate).toBeDefined();
    const agg = rule.bind.aggregate!;
    expect(agg.endpointWhereProperty).toEqual({ key: 'status', equals: 'Active' });
    expect(agg.op).toBe('gte');
    expect(agg.threshold).toBe(2);
    // SINGLE_GROUP + defaults — do NOT hardcode a save phase / grouping.
    expect(agg.groupByEdgeProperty).toBeUndefined();
    expect(agg.eventSplitByProperty).toBeUndefined();
    expect(agg.edgeSource).toBeUndefined(); // ⇒ root-incident (rootFirst false)
    expect(agg.countDistinctEndpoint).toBeUndefined(); // ⇒ from (the firer)
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.absenceShaped).toBe(false);
    expect(rule.dependsOnCoverage).toEqual(['ApexTrigger']);
  });

  it('fires on an object with 2 active triggers — cites the triggers FIRST then the object, discloses count 2, no hardcoded save phase, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeTrigger(TRIG_A), activeTrigger(TRIG_B)],
      edges: [triggersOn(TRIG_A), triggersOn(TRIG_B)],
    };
    const out = interpret(rule, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:apex-trigger-per-object-multiplicity');
    // rootFirst=false: triggers (sorted) first, object trailing as context.
    expect(only.groundedIn).toEqual([TRIG_A, TRIG_B, OBJ]);
    expect(only.claim).toContain(TRIG_A);
    expect(only.claim).toContain(TRIG_B);
    expect(only.claim).toContain(OBJ);
    // Self-disclosing count.
    expect(only.claim).toContain('2 ACTIVE Apex triggers');
    // SINGLE_GROUP — no trigger-context / save-phase label leaks in.
    expect(only.claim.toLowerCase()).not.toContain('before-save');
    expect(only.claim.toLowerCase()).not.toContain('after-save');
    // Honest boundary: does not assert an actual runtime conflict.
    expect(only.claim.toLowerCase()).toContain('does not assert the triggers actually conflict');
    expect(only.confidence).toBe('declared');
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.coverageCaveat).toBeNull();
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on an object with a single active trigger (threshold gte 2)', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeTrigger(TRIG_A)],
      edges: [triggersOn(TRIG_A)],
    };
    expect(interpret(rule, slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[active filter] an INACTIVE trigger is never counted (1 active + 1 inactive → no fire) — proves endpointWhereProperty', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject'),
        activeTrigger(TRIG_A),
        node(TRIG_B, 'ApexTrigger', { status: 'Inactive' }),
      ],
      edges: [triggersOn(TRIG_A), triggersOn(TRIG_B)],
    };
    expect(interpret(rule, slice, COMPLETE, OBJ)).toEqual([]);
  });

  it('[3 active triggers] fires once, discloses count 3, cites all three triggers then the object', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeTrigger(TRIG_A), activeTrigger(TRIG_B), activeTrigger(TRIG_C)],
      edges: [triggersOn(TRIG_A), triggersOn(TRIG_B), triggersOn(TRIG_C)],
    };
    const out = interpret(rule, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([TRIG_A, TRIG_B, TRIG_C, OBJ]);
    expect(out[0]!.claim).toContain('3 ACTIVE Apex triggers');
  });

  it('[componentTypes scopes the firer] a Flow that triggersOn the object is NOT counted (1 active trigger + 1 Flow → no fire)', () => {
    const FLOW = 'Flow:Ns__DealFlow';
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), activeTrigger(TRIG_A), node(FLOW, 'Flow', { status: 'Active' })],
      edges: [triggersOn(TRIG_A), edge(FLOW, OBJ, 'triggersOn', 'declared')],
    };
    // Only the ApexTrigger firer counts → 1 < 2 → no fire (the Flow is a stacked-flows concern).
    expect(interpret(rule, slice, COMPLETE, OBJ)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 A12 (backlog CAP-D) — concept:flow-fault-path-rollback-gap.
// The FIRST rule to compose the `in` operator INSIDE a multi-clause AND-array
// (mixed with `equals` clauses): a node-shaped Flow rule gating to a PURELY
// SYNCHRONOUS record-triggered flow (triggerType in {RecordBeforeSave,
// RecordAfterSave} AND runAsyncAfterCommit===false) that carries an UNHANDLED
// fault (hasUnhandledFaults===true). Fires on before- and after-save faulty
// flows, claims the entire triggering save is rolled back, cites ONLY that
// flow, confidence `parsed`. A fault-handled, async, before-delete, or
// non-record-triggered flow does NOT fire — proving `in` composes with the
// surrounding equals clauses. componentTypes scopes it to Flow; disjoint from
// the runInMode / runAsyncAfterCommit===true (its async INVERSE) Flow concepts.
// ---------------------------------------------------------------------------

describe('concept:flow-fault-path-rollback-gap — rule:flow/fault-path-rollback-gap', () => {
  const rule = ruleById('rule:flow/fault-path-rollback-gap');
  const BEFORE_FAULTY = 'Flow:Ns__Deal_Before_Save_Unhandled_Fault';
  const AFTER_FAULTY = 'Flow:Ns__Deal_After_Save_Unhandled_Fault';
  const HANDLED = 'Flow:Ns__Deal_Before_Save_Fault_Handled';
  const ASYNC_FAULTY = 'Flow:Ns__Deal_After_Save_Async';
  const DELETE_FAULTY = 'Flow:Ns__Deal_Before_Delete_Unhandled';

  // A purely-synchronous before/after-save flow with an unhandled fault.
  const syncFaulty = (id: string, triggerType: string): Node =>
    node(id, 'Flow', { hasUnhandledFaults: true, triggerType, runAsyncAfterCommit: false });

  it('ships the concept with the save-order-phase kind (NOT async-boundary — this is the synchronous, in-transaction side)', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('save-order-phase');
  });

  it('is a node-shaped Flow rule: a 3-clause AND-array (equals + IN + equals), no edge, parsed, dependsOnCoverage [Flow]', () => {
    expect(rule.concept).toBe('concept:flow-fault-path-rollback-gap');
    expect(rule.bind.componentTypes).toEqual(['Flow']);
    // The load-bearing engine-capability proof: `in` composes INSIDE the AND-array
    // alongside two `equals` clauses, and survives the compile round-trip verbatim.
    expect(rule.bind.whereProperty).toEqual([
      { key: 'hasUnhandledFaults', equals: true },
      { key: 'triggerType', in: ['RecordBeforeSave', 'RecordAfterSave'] },
      { key: 'runAsyncAfterCommit', equals: false },
    ]);
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('parsed');
    expect(rule.dependsOnCoverage).toEqual(['Flow']);
  });

  it('fires on a SYNCHRONOUS before-save flow with an unhandled fault, cites ONLY it, claims the whole save rolls back, confidence parsed', () => {
    const slice: GroundedSlice = { nodes: [syncFaulty(BEFORE_FAULTY, 'RecordBeforeSave')], edges: [] };
    const out = interpret(rule, slice, COMPLETE, BEFORE_FAULTY);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:flow-fault-path-rollback-gap');
    expect(only.groundedIn).toEqual([BEFORE_FAULTY]);
    expect(only.claim).toContain(BEFORE_FAULTY);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('synchronously');
    expect(lower).toContain('unhandled fault');
    // The distinctive consequence: the ENTIRE triggering save is rolled back.
    expect(lower).toContain('rolled back');
    // Contrasts with the async path (which cannot roll back the committed save).
    expect(lower).toContain('cannot roll the save back');
    // Honest boundary: does not assert an element actually faults.
    expect(lower).toContain('does not assert that any element actually faults');
    expect(only.confidence).toBe('parsed');
    // A node match carries no edge, so weakest() keeps the parsed ceiling.
    expect(only.confidence).toBe(weakest('parsed'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('fires on the OTHER synchronous save timing too (after-save) — the IN-set matches both RecordBeforeSave and RecordAfterSave', () => {
    const slice: GroundedSlice = { nodes: [syncFaulty(AFTER_FAULTY, 'RecordAfterSave')], edges: [] };
    const out = interpret(rule, slice, COMPLETE, AFTER_FAULTY);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([AFTER_FAULTY]);
    expect(out[0]!.confidence).toBe('parsed');
  });

  it('does NOT fire when the fault IS handled (hasUnhandledFaults false), nor on a bare node (absent flag)', () => {
    const handled: GroundedSlice = {
      nodes: [node(HANDLED, 'Flow', { hasUnhandledFaults: false, triggerType: 'RecordBeforeSave', runAsyncAfterCommit: false })],
      edges: [],
    };
    const bare: GroundedSlice = { nodes: [node(HANDLED, 'Flow', {})], edges: [] };
    expect(interpret(rule, handled, COMPLETE, HANDLED)).toEqual([]);
    expect(interpret(rule, bare, COMPLETE, HANDLED)).toEqual([]);
  });

  it('[IN composes with the trailing equals] does NOT fire on an ASYNC save flow (runAsyncAfterCommit true) even WITH an unhandled fault + save trigger', () => {
    const slice: GroundedSlice = {
      nodes: [node(ASYNC_FAULTY, 'Flow', { hasUnhandledFaults: true, triggerType: 'RecordAfterSave', runAsyncAfterCommit: true })],
      edges: [],
    };
    // The async fault fires post-commit and cannot roll back the save, so the
    // rollback claim must NOT apply — the trailing `equals: false` clause excludes it.
    expect(interpret(rule, slice, COMPLETE, ASYNC_FAULTY)).toEqual([]);
  });

  it('[IN excludes the delete path] does NOT fire on a before-DELETE flow with an unhandled fault (RecordBeforeDelete is not in the save-timing IN-set)', () => {
    const slice: GroundedSlice = {
      nodes: [node(DELETE_FAULTY, 'Flow', { hasUnhandledFaults: true, triggerType: 'RecordBeforeDelete', runAsyncAfterCommit: false })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, DELETE_FAULTY)).toEqual([]);
  });

  it('does NOT fire on a non-record-triggered / null-triggerType flow, even with an unhandled fault', () => {
    for (const triggerType of ['PlatformEvent', 'Scheduled', null] as const) {
      const slice: GroundedSlice = {
        nodes: [node('Flow:Ns__Deal_Other', 'Flow', { hasUnhandledFaults: true, triggerType, runAsyncAfterCommit: false })],
        edges: [],
      };
      expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Deal_Other')).toEqual([]);
    }
  });

  it('componentTypes scopes the match: a non-Flow node carrying every matching property does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('ApexClass:Ns__Odd', 'ApexClass', { hasUnhandledFaults: true, triggerType: 'RecordBeforeSave', runAsyncAfterCommit: false })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'ApexClass:Ns__Odd')).toEqual([]);
  });

  it('[no cross-contamination] a runInMode-only flow does not trip it, and the async-INVERSE rule does not trip on this synchronous faulty flow', () => {
    const runModeSlice: GroundedSlice = {
      nodes: [node(BEFORE_FAULTY, 'Flow', { runInMode: 'SystemModeWithoutSharing' })],
      edges: [],
    };
    expect(interpret(rule, runModeSlice, COMPLETE, BEFORE_FAULTY)).toEqual([]);
    // The async twin (runAsyncAfterCommit===true) must NOT fire on our purely-sync faulty flow.
    const syncSlice: GroundedSlice = { nodes: [syncFaulty(BEFORE_FAULTY, 'RecordBeforeSave')], edges: [] };
    expect(
      interpret(ruleById('rule:flow/scheduled-path-post-commit-fault'), syncSlice, COMPLETE, BEFORE_FAULTY),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// APEX CODE-QUALITY BATCH — synthetic ApexClass fixtures carry the always-present
// `qualityIssues` array (each element `{rule, severity, location, confidence}`,
// mirroring code-quality-patterns.ts). The `anyElement` existential holds iff SOME
// element's `rule` matches. All qualityIssues-based claims are HEURISTIC. Ns__*
// ids are synthetic — verified absent from org-kb.
// ---------------------------------------------------------------------------

/** An ApexClass node whose qualityIssues array carries the named recognizer rules. */
const withQualityIssues = (id: string, ...rules: readonly string[]): Node =>
  node(id, 'ApexClass', {
    qualityIssues: rules.map((r) => ({
      rule: r,
      severity: 'critical',
      location: 'line 1',
      confidence: 'heuristic',
    })),
  });

// 2) concept:apex-soql-injection-surface — anyElement over qualityIssues[].rule.
describe('concept:apex-soql-injection-surface — rule:code-quality/soql-injection-surface', () => {
  const rule = ruleById('rule:code-quality/soql-injection-surface');
  const INJ_CLASS = 'ApexClass:Ns__DynamicQueryRepo';
  const INJ_TRIGGER = 'ApexTrigger:Ns__LeadImportTrigger';
  const CLEAN_CLASS = 'ApexClass:Ns__SafeRepo';

  it('ships the concept with the NEW code-quality-defect kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('code-quality-defect');
  });

  it('is a node-shaped anyElement rule over qualityIssues[].rule === soql-injection, heuristic ceiling', () => {
    expect(rule.concept).toBe('concept:apex-soql-injection-surface');
    expect(rule.bind.componentTypes).toEqual(['ApexClass', 'ApexTrigger']);
    // The load-bearing proof: the anyElement existential survives the compile
    // round-trip verbatim (object-element mode — inner `key` present).
    expect(rule.bind.whereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', equals: 'soql-injection' },
    });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.dependsOnCoverage).toEqual(['ApexClass']);
  });

  it('fires on an ApexClass whose qualityIssues has a soql-injection element, cites only it, heuristic, carries the caveat', () => {
    const slice: GroundedSlice = { nodes: [withQualityIssues(INJ_CLASS, 'soql-injection')], edges: [] };
    const out = interpret(rule, slice, COMPLETE, INJ_CLASS);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:apex-soql-injection-surface');
    expect(only.groundedIn).toEqual([INJ_CLASS]);
    expect(only.claim).toContain(INJ_CLASS);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('injection');
    expect(lower).toContain('heuristic');
    expect(lower).toContain('bind variable');
    expect(only.confidence).toBe('heuristic');
    // A node match carries no edge, so weakest() keeps the heuristic ceiling.
    expect(only.confidence).toBe(weakest('heuristic'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('[existential] fires when soql-injection is ONE element among several issues (not required to be the only one)', () => {
    const slice: GroundedSlice = {
      nodes: [withQualityIssues(INJ_CLASS, 'dml-in-loop', 'soql-injection', 'hardcoded-id')],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, INJ_CLASS);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([INJ_CLASS]);
  });

  it('does NOT fire on a clean class (empty qualityIssues), a bare node (absent array), or a class with only OTHER issues', () => {
    const cleanEmpty: GroundedSlice = { nodes: [node(CLEAN_CLASS, 'ApexClass', { qualityIssues: [] })], edges: [] };
    const bare: GroundedSlice = { nodes: [node(CLEAN_CLASS, 'ApexClass', {})], edges: [] };
    const other: GroundedSlice = { nodes: [withQualityIssues(CLEAN_CLASS, 'dml-in-loop', 'hardcoded-url')], edges: [] };
    expect(interpret(rule, cleanEmpty, COMPLETE, CLEAN_CLASS)).toEqual([]);
    expect(interpret(rule, bare, COMPLETE, CLEAN_CLASS)).toEqual([]);
    expect(interpret(rule, other, COMPLETE, CLEAN_CLASS)).toEqual([]);
  });

  it('a real ApexTrigger carries no qualityIssues array, so it does NOT fire — but componentTypes admits a trigger IF one ever carried the array', () => {
    // The extractor emits qualityIssues on ApexClass only (apex-trigger.ts), so a
    // real trigger node has no array and the anyElement clause short-circuits false.
    const bareTrigger: GroundedSlice = {
      nodes: [node(INJ_TRIGGER, 'ApexTrigger', { events: ['before insert'] })],
      edges: [],
    };
    expect(interpret(rule, bareTrigger, COMPLETE, INJ_TRIGGER)).toEqual([]);
    // A synthetic trigger WITH a qualityIssues array (hypothetical future extraction)
    // DOES fire — componentTypes lists ApexTrigger, so the type gate admits it.
    const synthTrigger: GroundedSlice = {
      nodes: [
        node(INJ_TRIGGER, 'ApexTrigger', {
          qualityIssues: [{ rule: 'soql-injection', severity: 'critical', location: 'line 1', confidence: 'heuristic' }],
        }),
      ],
      edges: [],
    };
    const out = interpret(rule, synthTrigger, COMPLETE, INJ_TRIGGER);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([INJ_TRIGGER]);
  });

  it('componentTypes scopes the match: a non-Apex node carrying a soql-injection qualityIssues array does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [
        node('Flow:Ns__Odd', 'Flow', {
          qualityIssues: [{ rule: 'soql-injection', severity: 'critical', location: 'line 1', confidence: 'heuristic' }],
        }),
      ],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Odd')).toEqual([]);
  });
});

// 3) concept:apex-bulkification-gap — anyElement with an IN set over two rules.
describe('concept:apex-bulkification-gap — rule:code-quality/bulkification-gap', () => {
  const rule = ruleById('rule:code-quality/bulkification-gap');
  const SOQL_LOOP = 'ApexClass:Ns__LoopQueryService';
  const DML_LOOP = 'ApexClass:Ns__LoopDmlService';
  const CLEAN = 'ApexClass:Ns__BulkSafeService';

  it('ships the concept with the code-quality-defect kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('code-quality-defect');
  });

  it('is a node-shaped anyElement rule with an IN set over both loop rules, heuristic ceiling, [ApexClass] only', () => {
    expect(rule.concept).toBe('concept:apex-bulkification-gap');
    expect(rule.bind.componentTypes).toEqual(['ApexClass']);
    // The load-bearing proof: anyElement composes with an inner `in` set (not just equals).
    expect(rule.bind.whereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', in: ['soql-in-loop', 'dml-in-loop'] },
    });
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.dependsOnCoverage).toEqual(['ApexClass']);
  });

  it('[IN member 1] fires on a soql-in-loop class, cites it, heuristic, names the governor-limit / loop risk', () => {
    const slice: GroundedSlice = { nodes: [withQualityIssues(SOQL_LOOP, 'soql-in-loop')], edges: [] };
    const out = interpret(rule, slice, COMPLETE, SOQL_LOOP);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.groundedIn).toEqual([SOQL_LOOP]);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('loop');
    expect(lower).toContain('governor');
    expect(lower).toContain('heuristic');
    expect(only.confidence).toBe('heuristic');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[IN member 2] fires on a dml-in-loop class too (the IN set matches either rule)', () => {
    const slice: GroundedSlice = { nodes: [withQualityIssues(DML_LOOP, 'dml-in-loop')], edges: [] };
    const out = interpret(rule, slice, COMPLETE, DML_LOOP);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([DML_LOOP]);
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('does NOT fire on a clean class, a bare node, or a class carrying only NON-loop issues (soql-injection / hardcoded-id)', () => {
    const cleanEmpty: GroundedSlice = { nodes: [node(CLEAN, 'ApexClass', { qualityIssues: [] })], edges: [] };
    const bare: GroundedSlice = { nodes: [node(CLEAN, 'ApexClass', {})], edges: [] };
    const other: GroundedSlice = { nodes: [withQualityIssues(CLEAN, 'soql-injection', 'hardcoded-id')], edges: [] };
    expect(interpret(rule, cleanEmpty, COMPLETE, CLEAN)).toEqual([]);
    expect(interpret(rule, bare, COMPLETE, CLEAN)).toEqual([]);
    expect(interpret(rule, other, COMPLETE, CLEAN)).toEqual([]);
  });

  it('componentTypes scopes to ApexClass: a trigger carrying a dml-in-loop qualityIssues array does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [
        node('ApexTrigger:Ns__Odd', 'ApexTrigger', {
          qualityIssues: [{ rule: 'dml-in-loop', severity: 'critical', location: 'line 1', confidence: 'heuristic' }],
        }),
      ],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'ApexTrigger:Ns__Odd')).toEqual([]);
  });
});

// 3b) concept:bulkification-gap-in-trigger-reachable — EC-4 edge join with
// toWhereProperty anyElement over the called ApexClass qualityIssues array.
describe('concept:bulkification-gap-in-trigger-reachable — rule:code-quality/bulkification-gap-trigger-reachable', () => {
  const rule = ruleById('rule:code-quality/bulkification-gap-trigger-reachable');
  const TRIGGER = 'ApexTrigger:Ns__AccountSaveTrigger';
  const HANDLER_SOQL = 'ApexClass:Ns__LoopQueryHandler';
  const HANDLER_DML = 'ApexClass:Ns__LoopDmlHandler';
  const CLEAN_HANDLER = 'ApexClass:Ns__BulkSafeHandler';

  it('ships the concept with code-quality-defect kind and high severity', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('code-quality-defect');
    expect(CONCEPTS[rule.concept]!.severity).toBe('high');
  });

  it('is an edge-shaped callsApex rule with toWhereProperty anyElement IN set, heuristic ceiling, [ApexTrigger, ApexClass] citation scope', () => {
    expect(rule.concept).toBe('concept:bulkification-gap-in-trigger-reachable');
    expect(rule.bind.edgeType).toBe('callsApex');
    expect(rule.bind.componentTypes).toEqual(['ApexTrigger', 'ApexClass']);
    expect(rule.bind.toWhereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', in: ['soql-in-loop', 'dml-in-loop'] },
    });
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.dependsOnCoverage).toEqual(['ApexClass', 'ApexTrigger']);
  });

  it('[soql-in-loop] fires on a trigger that calls a loop-query handler, cites the trigger, heuristic, names amplification', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(TRIGGER, 'ApexTrigger', { events: ['after insert', 'after update'] }),
        withQualityIssues(HANDLER_SOQL, 'soql-in-loop'),
      ],
      edges: [edge(TRIGGER, HANDLER_SOQL, 'callsApex', 'heuristic')],
    };
    const out = interpret(rule, slice, COMPLETE, TRIGGER);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:bulkification-gap-in-trigger-reachable');
    expect(only.groundedIn).toEqual([TRIGGER, HANDLER_SOQL]);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('loop');
    expect(lower).toContain('200');
    expect(lower).toContain('heuristic');
    expect(only.confidence).toBe('heuristic');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[dml-in-loop] fires on a trigger that calls a loop-dml handler too', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(TRIGGER, 'ApexTrigger', { events: ['before insert'] }),
        withQualityIssues(HANDLER_DML, 'dml-in-loop'),
      ],
      edges: [edge(TRIGGER, HANDLER_DML, 'callsApex', 'heuristic')],
    };
    const out = interpret(rule, slice, COMPLETE, TRIGGER);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([TRIGGER, HANDLER_DML]);
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('does NOT fire when the called class is clean (no loop gap)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(TRIGGER, 'ApexTrigger', { events: ['after update'] }),
        node(CLEAN_HANDLER, 'ApexClass', { qualityIssues: [] }),
      ],
      edges: [edge(TRIGGER, CLEAN_HANDLER, 'callsApex', 'heuristic')],
    };
    expect(interpret(rule, slice, COMPLETE, TRIGGER)).toEqual([]);
  });

  it('does NOT fire when the handler has only NON-loop quality issues', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(TRIGGER, 'ApexTrigger', { events: ['after update'] }),
        withQualityIssues(CLEAN_HANDLER, 'soql-injection', 'hardcoded-id'),
      ],
      edges: [edge(TRIGGER, CLEAN_HANDLER, 'callsApex', 'heuristic')],
    };
    expect(interpret(rule, slice, COMPLETE, TRIGGER)).toEqual([]);
  });

  it('does NOT fire when there is no callsApex edge to the loop handler', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(TRIGGER, 'ApexTrigger', { events: ['after update'] }),
        withQualityIssues(HANDLER_SOQL, 'soql-in-loop'),
      ],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, TRIGGER)).toEqual([]);
  });

  it('componentTypes scopes citations to ApexTrigger and ApexClass — a class anchor cites both endpoints', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(TRIGGER, 'ApexTrigger', { events: ['after update'] }),
        withQualityIssues(HANDLER_SOQL, 'soql-in-loop'),
      ],
      edges: [edge(TRIGGER, HANDLER_SOQL, 'callsApex', 'heuristic')],
    };
    const out = interpret(rule, slice, COMPLETE, HANDLER_SOQL);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([TRIGGER, HANDLER_SOQL]);
  });
});

// 4) concept:apex-hardcoded-org-specific-literal — anyElement IN over three rules.
describe('concept:apex-hardcoded-org-specific-literal — rule:code-quality/hardcoded-org-specific-literal', () => {
  const rule = ruleById('rule:code-quality/hardcoded-org-specific-literal');
  const HC_ID = 'ApexClass:Ns__HardcodedIdRefs';
  const HC_USER = 'ApexClass:Ns__HardcodedUserRefs';
  const HC_URL = 'ApexClass:Ns__HardcodedUrlRefs';
  const CLEAN = 'ApexClass:Ns__PortableService';

  it('ships the concept with the code-quality-defect kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('code-quality-defect');
  });

  it('is a node-shaped anyElement rule with a 3-member IN set, heuristic ceiling, [ApexClass] only', () => {
    expect(rule.concept).toBe('concept:apex-hardcoded-org-specific-literal');
    expect(rule.bind.componentTypes).toEqual(['ApexClass']);
    expect(rule.bind.whereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', in: ['hardcoded-id', 'hardcoded-username', 'hardcoded-url'] },
    });
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.dependsOnCoverage).toEqual(['ApexClass']);
  });

  it('fires on each of the three hardcoded literal kinds, cites the class, heuristic, names the cross-org / sandbox break', () => {
    for (const [id, ruleName] of [
      [HC_ID, 'hardcoded-id'],
      [HC_USER, 'hardcoded-username'],
      [HC_URL, 'hardcoded-url'],
    ] as const) {
      const slice: GroundedSlice = { nodes: [withQualityIssues(id, ruleName)], edges: [] };
      const out = interpret(rule, slice, COMPLETE, id);
      expect(out).toHaveLength(1);
      expect(out[0]!.groundedIn).toEqual([id]);
      expect(out[0]!.confidence).toBe('heuristic');
    }
    // Assert the claim wording once (org-independent template is identical per fire).
    const out = interpret(rule, { nodes: [withQualityIssues(HC_ID, 'hardcoded-id')], edges: [] }, COMPLETE, HC_ID);
    const lower = out[0]!.claim.toLowerCase();
    expect(lower).toContain('hardcode');
    expect(lower).toContain('sandbox');
    expect(lower).toContain('heuristic');
    expect(out[0]!.coverageCaveat).toBeNull();
  });

  it('does NOT fire on a clean class, a bare node, or a class carrying only NON-hardcoded issues (soql-in-loop)', () => {
    const cleanEmpty: GroundedSlice = { nodes: [node(CLEAN, 'ApexClass', { qualityIssues: [] })], edges: [] };
    const bare: GroundedSlice = { nodes: [node(CLEAN, 'ApexClass', {})], edges: [] };
    const other: GroundedSlice = { nodes: [withQualityIssues(CLEAN, 'soql-in-loop')], edges: [] };
    expect(interpret(rule, cleanEmpty, COMPLETE, CLEAN)).toEqual([]);
    expect(interpret(rule, bare, COMPLETE, CLEAN)).toEqual([]);
    expect(interpret(rule, other, COMPLETE, CLEAN)).toEqual([]);
  });
});

// 5) concept:apex-crud-fls-unenforced — kind access-mechanism (the CRUD/FLS plane
// the sharing + external-surface concepts disclaim). anyElement IN over two rules.
describe('concept:apex-crud-fls-unenforced — rule:code-quality/crud-fls-unenforced', () => {
  const rule = ruleById('rule:code-quality/crud-fls-unenforced');
  const NO_CRUD = 'ApexClass:Ns__UnguardedInsertService';
  const NO_FLS = 'ApexClass:Ns__UnguardedFieldWriter';
  const CLEAN = 'ApexClass:Ns__SecureService';

  it('ships the concept with the EXISTING access-mechanism kind (NOT code-quality-defect — it fills the disclaimed CRUD/FLS plane)', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
  });

  it('is a node-shaped anyElement rule with an IN set over both permission rules, heuristic ceiling, [ApexClass] only', () => {
    expect(rule.concept).toBe('concept:apex-crud-fls-unenforced');
    expect(rule.bind.componentTypes).toEqual(['ApexClass']);
    expect(rule.bind.whereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', in: ['missing-crud-check', 'missing-fls-check'] },
    });
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.dependsOnCoverage).toEqual(['ApexClass']);
  });

  it('[IN member 1] fires on a missing-crud-check class, cites it, heuristic, names CRUD/FLS + the custom-utility caveat', () => {
    const slice: GroundedSlice = { nodes: [withQualityIssues(NO_CRUD, 'missing-crud-check')], edges: [] };
    const out = interpret(rule, slice, COMPLETE, NO_CRUD);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.groundedIn).toEqual([NO_CRUD]);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('crud');
    expect(lower).toContain('fls');
    expect(lower).toContain('heuristic');
    // The distinctive caveat: a custom security-utility helper is invisible.
    expect(lower).toContain('security-utility helper');
    expect(only.confidence).toBe('heuristic');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[IN member 2] fires on a missing-fls-check class too', () => {
    const slice: GroundedSlice = { nodes: [withQualityIssues(NO_FLS, 'missing-fls-check')], edges: [] };
    const out = interpret(rule, slice, COMPLETE, NO_FLS);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([NO_FLS]);
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('does NOT fire on a clean class, a bare node, or a class carrying only NON-permission issues (soql-injection)', () => {
    const cleanEmpty: GroundedSlice = { nodes: [node(CLEAN, 'ApexClass', { qualityIssues: [] })], edges: [] };
    const bare: GroundedSlice = { nodes: [node(CLEAN, 'ApexClass', {})], edges: [] };
    const other: GroundedSlice = { nodes: [withQualityIssues(CLEAN, 'soql-injection')], edges: [] };
    expect(interpret(rule, cleanEmpty, COMPLETE, CLEAN)).toEqual([]);
    expect(interpret(rule, bare, COMPLETE, CLEAN)).toEqual([]);
    expect(interpret(rule, other, COMPLETE, CLEAN)).toEqual([]);
  });
});

// 6) concept:apex-async-amplified-governor-risk — TWO rules (batchable/queueable
// OR), each a 3-clause AND-array composing anyElement INSIDE the AND with scalars.
describe('concept:apex-async-amplified-governor-risk — batchable + queueable rules', () => {
  const CONCEPT = 'concept:apex-async-amplified-governor-risk';
  const batchRule = ruleById('rule:code-quality/async-amplified-governor-risk-batchable');
  const queueRule = ruleById('rule:code-quality/async-amplified-governor-risk-queueable');
  const BATCH_LOOP = 'ApexClass:Ns__NightlyReconcileBatch';
  const QUEUE_LOOP = 'ApexClass:Ns__EnrichmentQueueable';
  const SYNC_LOOP = 'ApexClass:Ns__SyncLoopService';
  const CLEAN_BATCH = 'ApexClass:Ns__CleanBatch';
  const TEST_BATCH = 'ApexClass:Ns__BatchTest';

  /** An ApexClass with an async marker, a test flag, and a loop qualityIssue. */
  const asyncWithLoop = (
    id: string,
    opts: { batch?: boolean; queue?: boolean; isTest?: boolean } = {},
  ): Node =>
    node(id, 'ApexClass', {
      isBatchable: opts.batch ?? false,
      isQueueable: opts.queue ?? false,
      isTest: opts.isTest ?? false,
      qualityIssues: [{ rule: 'soql-in-loop', severity: 'critical', location: 'line 1', confidence: 'heuristic' }],
    });

  it('ships one concept (async-boundary kind) bound by BOTH rules — the isBatchable/isQueueable OR', () => {
    expect(CONCEPTS[CONCEPT]).toBeDefined();
    expect(CONCEPTS[CONCEPT]!.kind).toBe('async-boundary');
    expect(batchRule.concept).toBe(CONCEPT);
    expect(queueRule.concept).toBe(CONCEPT);
  });

  it('each rule is a 3-clause AND-array (async marker + isTest false + anyElement loop-gap), heuristic, [ApexClass]', () => {
    // The load-bearing proof: the anyElement existential composes INSIDE the AND-array
    // alongside two scalar `equals` clauses, and survives the compile round-trip verbatim.
    expect(batchRule.bind.whereProperty).toEqual([
      { key: 'isBatchable', equals: true },
      { key: 'isTest', equals: false },
      { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-in-loop', 'dml-in-loop'] } },
    ]);
    expect(queueRule.bind.whereProperty).toEqual([
      { key: 'isQueueable', equals: true },
      { key: 'isTest', equals: false },
      { key: 'qualityIssues', anyElement: { key: 'rule', in: ['soql-in-loop', 'dml-in-loop'] } },
    ]);
    for (const r of [batchRule, queueRule]) {
      expect(r.bind.componentTypes).toEqual(['ApexClass']);
      expect(r.maxConfidence).toBe('heuristic');
      expect(r.absenceShaped).toBe(false);
      expect(r.dependsOnCoverage).toEqual(['ApexClass']);
    }
  });

  it('[batchable] fires on a non-test Batch class with an in-loop gap — cites it, heuristic, names async+loop+governor', () => {
    const slice: GroundedSlice = { nodes: [asyncWithLoop(BATCH_LOOP, { batch: true })], edges: [] };
    const out = interpret(batchRule, slice, COMPLETE, BATCH_LOOP);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe(CONCEPT);
    expect(only.groundedIn).toEqual([BATCH_LOOP]);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('batch');
    expect(lower).toContain('async');
    expect(lower).toContain('loop');
    expect(lower).toContain('governor');
    expect(lower).toContain('heuristic');
    expect(only.confidence).toBe('heuristic');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('[queueable] fires on a non-test Queueable class with an in-loop gap', () => {
    const slice: GroundedSlice = { nodes: [asyncWithLoop(QUEUE_LOOP, { queue: true })], edges: [] };
    const out = interpret(queueRule, slice, COMPLETE, QUEUE_LOOP);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([QUEUE_LOOP]);
    expect(out[0]!.claim.toLowerCase()).toContain('queueable');
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('[isTest gate] does NOT fire on a TEST Batch class even with the async marker + loop gap', () => {
    const slice: GroundedSlice = { nodes: [asyncWithLoop(TEST_BATCH, { batch: true, isTest: true })], edges: [] };
    expect(interpret(batchRule, slice, COMPLETE, TEST_BATCH)).toEqual([]);
  });

  it('[async gate] does NOT fire on a SYNCHRONOUS (non-async) class carrying the same loop gap', () => {
    const slice: GroundedSlice = { nodes: [asyncWithLoop(SYNC_LOOP)], edges: [] }; // batch=false, queue=false
    expect(interpret(batchRule, slice, COMPLETE, SYNC_LOOP)).toEqual([]);
    expect(interpret(queueRule, slice, COMPLETE, SYNC_LOOP)).toEqual([]);
  });

  it('[loop gate] does NOT fire on a clean async Batch class with no loop gap', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLEAN_BATCH, 'ApexClass', { isBatchable: true, isTest: false, qualityIssues: [] })],
      edges: [],
    };
    expect(interpret(batchRule, slice, COMPLETE, CLEAN_BATCH)).toEqual([]);
  });

  it('[cross-rule] the batchable rule does not fire on a Queueable-only class, and vice versa', () => {
    const batchOnly: GroundedSlice = { nodes: [asyncWithLoop(BATCH_LOOP, { batch: true })], edges: [] };
    const queueOnly: GroundedSlice = { nodes: [asyncWithLoop(QUEUE_LOOP, { queue: true })], edges: [] };
    expect(interpret(queueRule, batchOnly, COMPLETE, BATCH_LOOP)).toEqual([]);
    expect(interpret(batchRule, queueOnly, COMPLETE, QUEUE_LOOP)).toEqual([]);
  });

  it('[equals:false needs the property present] does NOT fire on a node missing isTest — undefined is not false', () => {
    // isTest is always-present on a real ApexClass; this documents the AND-array
    // semantics: `equals: false` requires isTest === false, and an absent isTest is
    // undefined (not false), so the clause does not hold.
    const noIsTest: GroundedSlice = {
      nodes: [
        node(BATCH_LOOP, 'ApexClass', {
          isBatchable: true,
          qualityIssues: [{ rule: 'soql-in-loop', severity: 'critical', location: 'line 1', confidence: 'heuristic' }],
        }),
      ],
      edges: [],
    };
    expect(interpret(batchRule, noIsTest, COMPLETE, BATCH_LOOP)).toEqual([]);
  });
});

// 7) concept:test-class-without-assertions — kind test-quality; a SCALAR AND-array
// (no anyElement): isTest === true AND assertionCount === 0. maxConfidence parsed.
describe('concept:test-class-without-assertions — rule:test-quality/test-class-without-assertions', () => {
  const rule = ruleById('rule:test-quality/test-class-without-assertions');
  const ASSERTLESS = 'ApexClass:Ns__AssertlessTest';
  const REAL_TEST = 'ApexClass:Ns__RealAssertTest';
  const NON_TEST = 'ApexClass:Ns__SomeService';

  const testClass = (id: string, assertionCount: number): Node =>
    node(id, 'ApexClass', { isTest: true, assertionCount });

  it('ships the concept with the NEW test-quality kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('test-quality');
  });

  it('is a node-shaped 2-clause SCALAR AND-array (isTest true + assertionCount 0), heuristic, [ApexClass]', () => {
    expect(rule.concept).toBe('concept:test-class-without-assertions');
    expect(rule.bind.componentTypes).toEqual(['ApexClass']);
    expect(rule.bind.whereProperty).toEqual([
      { key: 'isTest', equals: true },
      { key: 'assertionCount', equals: 0 },
    ]);
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    // RM-review F16: heuristic (tokenized assert-count; helper-delegated asserts
    // are invisible), matching roadmap C7 `heu` + the nine sibling quality rules.
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.dependsOnCoverage).toEqual(['ApexClass']);
  });

  it('fires on a test class with assertionCount 0 — cites it, heuristic, names test/assertion/coverage + the helper caveat', () => {
    const slice: GroundedSlice = { nodes: [testClass(ASSERTLESS, 0)], edges: [] };
    const out = interpret(rule, slice, COMPLETE, ASSERTLESS);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:test-class-without-assertions');
    expect(only.groundedIn).toEqual([ASSERTLESS]);
    expect(only.claim).toContain(ASSERTLESS);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('test class');
    expect(lower).toContain('assertion');
    expect(lower).toContain('coverage');
    // The distinctive boundary: assertions in a shared helper are invisible → strong smell.
    expect(lower).toContain('strong smell');
    // RM-review F16: assertionCount is a TOKENIZED count → heuristic tier.
    expect(only.confidence).toBe('heuristic');
    expect(only.confidence).toBe(weakest('heuristic'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('does NOT fire on a test class that HAS assertions (assertionCount > 0)', () => {
    const slice: GroundedSlice = { nodes: [testClass(REAL_TEST, 5)], edges: [] };
    expect(interpret(rule, slice, COMPLETE, REAL_TEST)).toEqual([]);
  });

  it('does NOT fire on a NON-test class (isTest false, no assertionCount)', () => {
    const slice: GroundedSlice = { nodes: [node(NON_TEST, 'ApexClass', { isTest: false })], edges: [] };
    expect(interpret(rule, slice, COMPLETE, NON_TEST)).toEqual([]);
  });

  it('[assertionCount present-and-0 required] does NOT fire on a test node MISSING assertionCount — undefined is not 0', () => {
    // A real test-class node always carries assertionCount; this documents that the
    // `equals: 0` clause needs the property present (undefined !== 0), so a bare
    // isTest-only node does not fire.
    const bare: GroundedSlice = { nodes: [node(ASSERTLESS, 'ApexClass', { isTest: true })], edges: [] };
    expect(interpret(rule, bare, COMPLETE, ASSERTLESS)).toEqual([]);
  });

  it('componentTypes scopes to ApexClass: a non-Apex node with isTest+assertionCount 0 does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('Flow:Ns__Odd', 'Flow', { isTest: true, assertionCount: 0 })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, 'Flow:Ns__Odd')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// concept:apex-trigger-before-after-phases (ARC-2) — an Apex trigger's declared
// `events` place its handler logic in the before-save and/or after-save phase.
// TWO node rules over ApexTrigger, each an AND-array mixing the
// `isPlatformEventSubscriber === false` scalar guard with the `events` SCALAR-ARRAY
// `anyElement` existential. The before-set is {before insert, before update,
// before delete}; the after-set is {after insert, after update, after delete,
// after undelete}. A trigger declaring BOTH phases fires BOTH rules (each phase
// asserted separately). A platform-event (`__e`) subscriber trigger fires NEITHER
// (it runs async, outside a record's save order — covered by the platform-event
// async concept). A non-ApexTrigger node fires neither. Confidence `declared`
// (a node match carries no edge, so weakest() keeps the declared ceiling).
// ---------------------------------------------------------------------------

describe('concept:apex-trigger-before-after-phases — before/after phase NODE rules', () => {
  const BEFORE_RULE = ruleById('rule:apex-trigger/before-phase-events');
  const AFTER_RULE = ruleById('rule:apex-trigger/after-phase-events');

  const BEFORE_TRIGGER = 'ApexTrigger:Ns__DealBeforeTrigger';
  const AFTER_TRIGGER = 'ApexTrigger:Ns__DealAfterTrigger';
  const BOTH_TRIGGER = 'ApexTrigger:Ns__DealBothTrigger';
  const PE_TRIGGER = 'ApexTrigger:Ns__OrderEventTrigger';

  const trigger = (id: string, events: readonly string[], isPE = false): Node =>
    node(id, 'ApexTrigger', { events, isPlatformEventSubscriber: isPE });

  it('ships the concept with the save-order-phase kind (REUSED, not a new kind)', () => {
    const concept = CONCEPTS['concept:apex-trigger-before-after-phases'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('save-order-phase');
  });

  it('both rules are node-shaped ApexTrigger rules with the AND-array anyElement predicate, declared', () => {
    for (const rule of [BEFORE_RULE, AFTER_RULE]) {
      expect(rule.concept).toBe('concept:apex-trigger-before-after-phases');
      expect(rule.bind.componentTypes).toEqual(['ApexTrigger']);
      expect(rule.bind.edgeType).toBeUndefined();
      expect(rule.maxConfidence).toBe('declared');
      expect(rule.absenceShaped).toBe(false);
      expect(rule.dependsOnCoverage).toEqual(['ApexTrigger']);
    }
    expect(BEFORE_RULE.bind.whereProperty).toEqual([
      { key: 'isPlatformEventSubscriber', equals: false },
      { key: 'events', anyElement: { in: ['before insert', 'before update', 'before delete'] } },
    ]);
    expect(AFTER_RULE.bind.whereProperty).toEqual([
      { key: 'isPlatformEventSubscriber', equals: false },
      {
        key: 'events',
        anyElement: { in: ['after insert', 'after update', 'after delete', 'after undelete'] },
      },
    ]);
  });

  it('before-phase rule FIRES on a trigger with a before event, cites it, claims MUTABLE, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [trigger(BEFORE_TRIGGER, ['before insert', 'before update'])],
      edges: [],
    };

    const out = interpret(BEFORE_RULE, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:apex-trigger-before-after-phases');
    expect(only.groundedIn).toEqual([BEFORE_TRIGGER]);
    expect(only.claim).toContain(BEFORE_TRIGGER);
    expect(only.claim).toContain('BEFORE-phase');
    expect(only.claim.toLowerCase()).toContain('mutable');
    // A node match carries no edge confidence → the declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('after-phase rule FIRES on a trigger with an after event (incl. after undelete), claims READ-ONLY + DML', () => {
    const slice: GroundedSlice = {
      nodes: [trigger(AFTER_TRIGGER, ['after insert', 'after undelete'])],
      edges: [],
    };

    const out = interpret(AFTER_RULE, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.groundedIn).toEqual([AFTER_TRIGGER]);
    expect(only.claim).toContain('AFTER-phase');
    expect(only.claim.toLowerCase()).toContain('read-only');
    expect(only.claim.toLowerCase()).toContain('dml');
    expect(only.confidence).toBe('declared');
  });

  it('the phase rules are mutually exclusive on a single-phase trigger (before-only fires only before; after-only fires only after)', () => {
    const afterOnly: GroundedSlice = {
      nodes: [trigger(AFTER_TRIGGER, ['after insert', 'after update', 'after delete'])],
      edges: [],
    };
    expect(interpret(BEFORE_RULE, afterOnly, COMPLETE)).toEqual([]);
    expect(interpret(AFTER_RULE, afterOnly, COMPLETE)).toHaveLength(1);

    const beforeOnly: GroundedSlice = {
      nodes: [trigger(BEFORE_TRIGGER, ['before insert'])],
      edges: [],
    };
    expect(interpret(AFTER_RULE, beforeOnly, COMPLETE)).toEqual([]);
    expect(interpret(BEFORE_RULE, beforeOnly, COMPLETE)).toHaveLength(1);
  });

  it('a trigger declaring BOTH before- and after-phase events fires BOTH rules — each phase asserted separately', () => {
    const slice: GroundedSlice = {
      nodes: [trigger(BOTH_TRIGGER, ['before insert', 'after update'])],
      edges: [],
    };

    const beforeOut = interpret(BEFORE_RULE, slice, COMPLETE);
    const afterOut = interpret(AFTER_RULE, slice, COMPLETE);

    expect(beforeOut).toHaveLength(1);
    expect(beforeOut[0]!.groundedIn).toEqual([BOTH_TRIGGER]);
    expect(beforeOut[0]!.claim).toContain('BEFORE-phase');

    expect(afterOut).toHaveLength(1);
    expect(afterOut[0]!.groundedIn).toEqual([BOTH_TRIGGER]);
    expect(afterOut[0]!.claim).toContain('AFTER-phase');
  });

  it('neither rule fires on a trigger with an EMPTY events array (an existential over [] is false)', () => {
    const slice: GroundedSlice = {
      nodes: [trigger('ApexTrigger:Ns__EmptyTrigger', [])],
      edges: [],
    };
    expect(interpret(BEFORE_RULE, slice, COMPLETE)).toEqual([]);
    expect(interpret(AFTER_RULE, slice, COMPLETE)).toEqual([]);
  });

  it('[platform-event guard] a __e platform-event subscriber trigger fires NEITHER phase rule (excluded from save-order framing)', () => {
    // A platform-event trigger only ever declares `after insert` and runs async in a
    // SEPARATE transaction — it does NOT participate in a record's before/after save
    // order, so the save-order-phase concept must exclude it. It is covered by
    // concept:apex-trigger-platform-event-async instead (disjoint, no double-claim).
    const slice: GroundedSlice = {
      nodes: [trigger(PE_TRIGGER, ['after insert'], true)],
      edges: [],
    };
    expect(interpret(AFTER_RULE, slice, COMPLETE)).toEqual([]);
    expect(interpret(BEFORE_RULE, slice, COMPLETE)).toEqual([]);
  });

  it('componentTypes scopes to ApexTrigger: a non-ApexTrigger node carrying the same events does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [
        node('Flow:Ns__BeforeFlow', 'Flow', {
          events: ['before insert'],
          isPlatformEventSubscriber: false,
        }),
      ],
      edges: [],
    };
    expect(interpret(BEFORE_RULE, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FLEET-CONCEPTS6 C2 — concept:connected-app-oauth-scope-exposure. A NODE rule:
// componentTypes [ConnectedApp] + scalar-array anyElement {in: [Full, Api,
// RefreshToken]} over the always-present `scopes` string array. Fires on an app
// carrying a broad scope; silent on narrow-only, empty, or a non-ConnectedApp.
// ---------------------------------------------------------------------------

describe('concept:connected-app-oauth-scope-exposure — rule:access-mechanism/connected-app-oauth-scope', () => {
  const rule = ruleById('rule:access-mechanism/connected-app-oauth-scope');
  const APP = 'ConnectedApp:Ns__Integration';

  it('ships the concept with the access-mechanism kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
  });

  it('is a node-shaped ConnectedApp rule (componentTypes + scalar-array anyElement scopes, no edge, declared)', () => {
    expect(rule.bind.componentTypes).toEqual(['ConnectedApp']);
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.bind.whereProperty).toEqual({
      key: 'scopes',
      anyElement: { in: ['Full', 'Api', 'RefreshToken'] },
    });
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.absenceShaped).toBe(false);
  });

  it('fires on a ConnectedApp carrying a broad scope (Api), cites the app, names the DECLARED grant, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(APP, 'ConnectedApp', { scopes: ['Api', 'Chatter'] })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:connected-app-oauth-scope-exposure');
    expect(only.groundedIn).toEqual([APP]);
    expect(only.claim).toContain(APP);
    expect(only.claim).toContain('BROAD OAuth scope');
    // Honest: names the declared grant, not a proven misuse.
    expect(only.claim.toLowerCase()).toContain('not a proven misuse');
    expect(only.confidence).toBe('declared');
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('fires when Full OR RefreshToken is present (each broad scope value)', () => {
    for (const scope of ['Full', 'RefreshToken']) {
      const slice: GroundedSlice = {
        nodes: [node(APP, 'ConnectedApp', { scopes: [scope] })],
        edges: [],
      };
      expect(interpret(rule, slice, COMPLETE)).toHaveLength(1);
    }
  });

  it('does NOT fire on an app with only narrow scopes (no broad scope in the set)', () => {
    const slice: GroundedSlice = {
      nodes: [node(APP, 'ConnectedApp', { scopes: ['OpenID', 'Chatter', 'Address'] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('does NOT fire on an app with an EMPTY scopes array (no OAuth surface) — existential over [] is false', () => {
    const slice: GroundedSlice = {
      nodes: [node(APP, 'ConnectedApp', { scopes: [] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-ConnectedApp node carrying scopes:[Full] does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Deal__c', 'CustomObject', { scopes: ['Full'] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FLEET-CONCEPTS6 L2 / L3 / L6 — three code-quality-defect concepts, each a NODE
// rule with an object-mode anyElement {key: rule, equals: <ruleName>} over the
// ApexClass `qualityIssues` array (byte-identical shape to the shipped
// soql-injection-surface rule). Each fires on its own qualityIssue and stays
// silent on a different one / an empty array / a non-ApexClass node.
// ---------------------------------------------------------------------------

describe('concept:apex-swallowed-exception — rule:code-quality/swallowed-exception', () => {
  const rule = ruleById('rule:code-quality/swallowed-exception');
  const CLS = 'ApexClass:Ns__SwallowSvc';

  it('ships the concept with the code-quality-defect kind and a heuristic ceiling', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('code-quality-defect');
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.bind.whereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', equals: 'swallowed-exception' },
    });
  });

  it('fires on an ApexClass carrying a swallowed-exception qualityIssue, confidence heuristic', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [{ rule: 'swallowed-exception', severity: 'high' }] })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:apex-swallowed-exception');
    expect(out[0]!.groundedIn).toEqual([CLS]);
    expect(out[0]!.claim.toLowerCase()).toContain('swallowed-exception');
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('does NOT fire on a class carrying only a DIFFERENT qualityIssue (soql-injection)', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [{ rule: 'soql-injection', severity: 'critical' }] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('does NOT fire on a class with an empty qualityIssues array', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

describe('concept:apex-database-dml-no-partial-success — rule:code-quality/database-dml-no-partial-success', () => {
  const rule = ruleById('rule:code-quality/database-dml-no-partial-success');
  const CLS = 'ApexClass:Ns__UpsertSvc';

  it('ships the concept with the code-quality-defect kind and the database-upsert-no-options existential', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('code-quality-defect');
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.bind.whereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', equals: 'database-upsert-no-options' },
    });
  });

  it('fires on an ApexClass carrying a database-upsert-no-options qualityIssue', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [{ rule: 'database-upsert-no-options', severity: 'medium' }] })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('all-or-nothing');
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('does NOT fire on a class carrying only a different qualityIssue (old-api-version)', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [{ rule: 'old-api-version', severity: 'low' }] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

describe('concept:apex-outdated-api-version — rule:code-quality/outdated-api-version', () => {
  const rule = ruleById('rule:code-quality/outdated-api-version');
  const CLS = 'ApexClass:Ns__LegacySvc';

  it('ships the concept with the code-quality-defect kind and the old-api-version existential', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('code-quality-defect');
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.bind.whereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', equals: 'old-api-version' },
    });
  });

  it('fires on an ApexClass carrying an old-api-version qualityIssue, framed as upgrade-readiness not a runtime bug', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [{ rule: 'old-api-version', severity: 'low' }] })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('upgrade-readiness');
    expect(out[0]!.claim.toLowerCase()).toContain('not a runtime');
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('does NOT fire on a class carrying only a different qualityIssue (swallowed-exception)', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [{ rule: 'swallowed-exception', severity: 'high' }] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FLEET-CONCEPTS6 C14 — concept:dependent-picklist-dependency-base. A NODE rule
// with whereProperty {key: controllingField, isNull: false} on CustomField. The
// extractor OMITS the key on a non-dependent field, so isNull:false must fire on
// a present controllingField and REJECT an absent key (the load-bearing behavior).
// ---------------------------------------------------------------------------

describe('concept:dependent-picklist-dependency-base — rule:field/dependent-picklist-base', () => {
  const rule = ruleById('rule:field/dependent-picklist-base');
  const DEP_FIELD = 'CustomField:Ns__Deal__c.SubStage__c';
  const PLAIN_FIELD = 'CustomField:Ns__Deal__c.Plain__c';

  it('ships the concept with the field-provenance kind (reused, no new kind)', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('field-provenance');
  });

  it('is a node-shaped CustomField rule (componentTypes + whereProperty controllingField isNull:false, no edge, declared)', () => {
    expect(rule.bind.componentTypes).toEqual(['CustomField']);
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.bind.whereProperty).toEqual({ key: 'controllingField', isNull: false });
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.absenceShaped).toBe(false);
  });

  it('fires on a dependent picklist (controllingField present), cites the field, names the dependency, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(DEP_FIELD, 'CustomField', { controllingField: 'StageName' })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:dependent-picklist-dependency-base');
    expect(out[0]!.groundedIn).toEqual([DEP_FIELD]);
    expect(out[0]!.claim).toContain(DEP_FIELD);
    expect(out[0]!.claim.toUpperCase()).toContain('DEPENDENT PICKLIST');
    expect(out[0]!.confidence).toBe('declared');
  });

  it('[absent key] does NOT fire on a field whose controllingField key is ABSENT (the extractor omits it on non-dependent fields)', () => {
    const slice: GroundedSlice = {
      nodes: [node(PLAIN_FIELD, 'CustomField', { dataType: 'Text' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('[present-as-null] does NOT fire on a field with controllingField===null', () => {
    const slice: GroundedSlice = {
      nodes: [node(PLAIN_FIELD, 'CustomField', { controllingField: null })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-CustomField node carrying controllingField does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('CustomObject:Ns__Deal__c', 'CustomObject', { controllingField: 'StageName' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FLEET-CONCEPTS6 B9 — concept:flow-field-writer-collision. An AGGREGATE
// group-count rule rooted on a CustomField, counting DISTINCT ACTIVE Flow writers
// (edgeType writesTo, componentTypes [Flow], endpointWhereProperty status==Active,
// op gte, threshold 2) via the aggregate DEFAULTS (root-incident / from /
// SINGLE_GROUP). A field-level writesTo is Flow(from)->CustomField(to), so the
// field IS the edge target and root-incident counts the flows — proving CustomField
// works as an aggregate root with no engine change. Cites the writers FIRST then the
// field (rootFirst=false). Inactive flows and non-Flow writers are never counted.
// ---------------------------------------------------------------------------

describe('concept:flow-field-writer-collision — rule:automation/flow-field-writer-collision', () => {
  const rule = ruleById('rule:automation/flow-field-writer-collision');
  const FIELD = 'CustomField:Ns__Deal__c.Status__c';
  const FLOW_A = 'Flow:Ns__DealFlowA';
  const FLOW_B = 'Flow:Ns__DealFlowB';

  const activeFlow = (id: string): Node => node(id, 'Flow', { status: 'Active' });
  // The counted edge: flow --writesTo--> field (writer=from, field=to=root); parsed.
  const writesTo = (flowId: string): Edge => edge(flowId, FIELD, 'writesTo', 'parsed');

  it('ships the concept with the automation-collision kind and a parsed ceiling', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('automation-collision');
    expect(rule.maxConfidence).toBe('parsed');
  });

  it('has the shipped AGGREGATE bind structure (writesTo + [Flow] + status==Active, gte 2, defaults for edgeSource/countDistinctEndpoint/SINGLE_GROUP)', () => {
    expect(rule.bind.edgeType).toBe('writesTo');
    expect(rule.bind.componentTypes).toEqual(['Flow']);
    expect(rule.bind.aggregate).toBeDefined();
    const agg = rule.bind.aggregate!;
    expect(agg.endpointWhereProperty).toEqual({ key: 'status', equals: 'Active' });
    expect(agg.op).toBe('gte');
    expect(agg.threshold).toBe(2);
    expect(agg.groupByEdgeProperty).toBeUndefined();
    expect(agg.eventSplitByProperty).toBeUndefined();
    expect(agg.edgeSource).toBeUndefined(); // ⇒ root-incident (rootFirst false)
    expect(agg.countDistinctEndpoint).toBeUndefined(); // ⇒ from (the flow writer)
    expect(rule.dependsOnCoverage).toEqual(['Flow']);
  });

  it('fires on a field written by 2 active flows — cites the FLOWS first then the field, discloses count 2, confidence parsed', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIELD, 'CustomField'), activeFlow(FLOW_A), activeFlow(FLOW_B)],
      edges: [writesTo(FLOW_A), writesTo(FLOW_B)],
    };
    const out = interpret(rule, slice, COMPLETE, FIELD);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:flow-field-writer-collision');
    // rootFirst=false: flows (sorted) first, field trailing as context.
    expect(only.groundedIn).toEqual([FLOW_A, FLOW_B, FIELD]);
    expect(only.claim).toContain(FLOW_A);
    expect(only.claim).toContain(FLOW_B);
    expect(only.claim).toContain(FIELD);
    expect(only.claim).toContain('written by 2 active flows');
    // Honest boundary: does not assert an actual runtime collision.
    expect(only.claim.toLowerCase()).toContain('does not assert the flows actually collide');
    expect(only.confidence).toBe('parsed');
    expect(only.coverageCaveat).toBeNull();
  });

  it('does NOT fire on a field written by a single active flow (threshold gte 2)', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIELD, 'CustomField'), activeFlow(FLOW_A)],
      edges: [writesTo(FLOW_A)],
    };
    expect(interpret(rule, slice, COMPLETE, FIELD)).toEqual([]);
  });

  it('[active filter] an OBSOLETE flow is never counted (1 active + 1 obsolete → no fire) — proves endpointWhereProperty', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIELD, 'CustomField'), activeFlow(FLOW_A), node(FLOW_B, 'Flow', { status: 'Obsolete' })],
      edges: [writesTo(FLOW_A), writesTo(FLOW_B)],
    };
    expect(interpret(rule, slice, COMPLETE, FIELD)).toEqual([]);
  });

  it('[componentTypes scopes the writer] a non-Flow writer (ApexClass) is NOT counted (1 active flow + 1 ApexClass → no fire)', () => {
    const CLS = 'ApexClass:Ns__DealSvc';
    const slice: GroundedSlice = {
      nodes: [node(FIELD, 'CustomField'), activeFlow(FLOW_A), node(CLS, 'ApexClass', { status: 'Active' })],
      edges: [writesTo(FLOW_A), edge(CLS, FIELD, 'writesTo', 'parsed')],
    };
    // Only the Flow writer counts → 1 < 2 → no fire.
    expect(interpret(rule, slice, COMPLETE, FIELD)).toEqual([]);
  });

  it('[distinct-endpoint dedup] a single flow writing the field via TWO assignments counts ONCE (no fire on 1 distinct writer)', () => {
    const slice: GroundedSlice = {
      nodes: [node(FIELD, 'CustomField'), activeFlow(FLOW_A)],
      edges: [writesTo(FLOW_A), writesTo(FLOW_A)],
    };
    expect(interpret(rule, slice, COMPLETE, FIELD)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 A5 — concept:field-fls-independent-of-crud. TWO EDGE rules over the
// PermissionSet/Profile --grantedBy--> CustomField edge with `readable` /
// `editable` boolean properties. FLS gates the column ANDed with CRUD+sharing;
// object View/Modify All does NOT bypass it.
// ---------------------------------------------------------------------------

describe('concept:field-fls-independent-of-crud — field FLS grantedBy EDGE rules', () => {
  const READ_RULE = ruleById('rule:access/field-fls-readable-grant');
  const EDIT_RULE = ruleById('rule:access/field-fls-editable-grant');
  const SECRET_FIELD = 'CustomField:Ns__Deal__c.Ns__Secret__c';
  const READER_PS = 'PermissionSet:Ns__FieldReader';
  const EDITOR_PS = 'PermissionSet:Ns__FieldEditor';

  it('ships the concept with the access-mechanism kind and the FLS-independence summary', () => {
    const concept = CONCEPTS['concept:field-fls-independent-of-crud'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('field-level security');
    expect(summary).toContain('do not bypass fls');
    expect(summary).toContain('view all');
  });

  it('readable rule is an edge-shaped grantedBy rule (componentTypes + edgeWhereProperty readable===true)', () => {
    expect(READ_RULE.concept).toBe('concept:field-fls-independent-of-crud');
    expect(READ_RULE.bind.edgeType).toBe('grantedBy');
    expect(READ_RULE.bind.componentTypes).toEqual(['PermissionSet', 'Profile', 'CustomField']);
    expect(READ_RULE.bind.edgeWhereProperty).toEqual({ key: 'readable', equals: true });
    expect(READ_RULE.absenceShaped).toBe(false);
    expect(READ_RULE.maxConfidence).toBe('declared');
  });

  it('editable rule is an edge-shaped grantedBy rule (edgeWhereProperty editable===true)', () => {
    expect(EDIT_RULE.concept).toBe('concept:field-fls-independent-of-crud');
    expect(EDIT_RULE.bind.edgeWhereProperty).toEqual({ key: 'editable', equals: true });
  });

  it('readable rule fires on a read-only FLS grant — cites field + grantor, claim ANDed with CRUD/sharing, View/Modify All does NOT bypass', () => {
    const slice: GroundedSlice = {
      nodes: [node(SECRET_FIELD, 'CustomField'), node(READER_PS, 'PermissionSet')],
      edges: [
        edge(READER_PS, SECRET_FIELD, 'grantedBy', 'declared', { readable: true, editable: false }),
      ],
    };
    const out = interpret(READ_RULE, slice, COMPLETE, SECRET_FIELD);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:field-fls-independent-of-crud');
    expect(only.groundedIn).toEqual([READER_PS, SECRET_FIELD]);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(SECRET_FIELD);
    expect(only.claim).toContain(READER_PS);
    expect(only.claim.toLowerCase()).toContain('read');
    expect(only.claim.toLowerCase()).toContain('does not bypass fls');
    expect(only.claim.toLowerCase()).toContain('anded');
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
  });

  it('editable rule fires on an edit FLS grant — co-fires readable on the same grant (editable implies readable)', () => {
    const slice: GroundedSlice = {
      nodes: [node(SECRET_FIELD, 'CustomField'), node(EDITOR_PS, 'PermissionSet')],
      edges: [
        edge(EDITOR_PS, SECRET_FIELD, 'grantedBy', 'declared', { readable: true, editable: true }),
      ],
    };
    const editOut = interpret(EDIT_RULE, slice, COMPLETE, SECRET_FIELD);
    const readOut = interpret(READ_RULE, slice, COMPLETE, SECRET_FIELD);
    expect(editOut).toHaveLength(1);
    expect(readOut).toHaveLength(1);
    expect(editOut[0]!.claim.toLowerCase()).toContain('edit');
    expect(editOut[0]!.claim.toLowerCase()).toContain('read grant interpretation also fires');
    expect(readOut[0]!.concept).toBe('concept:field-fls-independent-of-crud');
  });

  it('[negative — no FLS] a grantedBy edge with readable:false editable:false does NOT fire either rule', () => {
    const slice: GroundedSlice = {
      nodes: [node(SECRET_FIELD, 'CustomField'), node(READER_PS, 'PermissionSet')],
      edges: [
        edge(READER_PS, SECRET_FIELD, 'grantedBy', 'declared', { readable: false, editable: false }),
      ],
    };
    expect(interpret(READ_RULE, slice, COMPLETE, SECRET_FIELD)).toEqual([]);
    expect(interpret(EDIT_RULE, slice, COMPLETE, SECRET_FIELD)).toEqual([]);
  });

  it('[permset anchor] fires from the PermissionSet anchor — cites grantor + field', () => {
    const slice: GroundedSlice = {
      nodes: [node(SECRET_FIELD, 'CustomField'), node(READER_PS, 'PermissionSet')],
      edges: [
        edge(READER_PS, SECRET_FIELD, 'grantedBy', 'declared', { readable: true, editable: false }),
      ],
    };
    const out = interpret(READ_RULE, slice, COMPLETE, READER_PS);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([READER_PS, SECRET_FIELD]);
  });

  it('[type guard] a non-grantedBy edge or wrong endpoint types do NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node(SECRET_FIELD, 'CustomField'), node('ApexClass:Ns__Foo', 'ApexClass')],
      edges: [edge('ApexClass:Ns__Foo', SECRET_FIELD, 'references', 'declared')],
    };
    expect(interpret(READ_RULE, slice, COMPLETE, SECRET_FIELD)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 A15 — concept:object-crud-grant-layer. FOUR EDGE rules over
// PermissionSet/Profile --grantedBy--> CustomObject with allowCreate/Read/Edit/Delete.
// Table-level CRUD only — distinct from view-modify-all and field FLS.
// ---------------------------------------------------------------------------

describe('concept:object-crud-grant-layer — object CRUD grantedBy EDGE rules', () => {
  const CREATE_RULE = ruleById('rule:access/object-crud-create-grant');
  const READ_RULE = ruleById('rule:access/object-crud-read-grant');
  const EDIT_RULE = ruleById('rule:access/object-crud-edit-grant');
  const DELETE_RULE = ruleById('rule:access/object-crud-delete-grant');
  const OBJ = 'CustomObject:Ns__Deal__c';
  const CRUD_PS = 'PermissionSet:Ns__DealCrud';

  it('ships the concept with access-mechanism kind and table-level CRUD summary', () => {
    const concept = CONCEPTS['concept:object-crud-grant-layer'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    expect(concept!.summary.toLowerCase()).toContain('table-level');
    expect(concept!.summary.toLowerCase()).toContain('field-level security');
  });

  it('read rule fires on allowRead:true — cites object + grantor, table-level not record bypass', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(CRUD_PS, 'PermissionSet')],
      edges: [
        edge(CRUD_PS, OBJ, 'grantedBy', 'declared', {
          allowRead: true,
          allowCreate: false,
          allowEdit: false,
          allowDelete: false,
        }),
      ],
    };
    const out = interpret(READ_RULE, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:object-crud-grant-layer');
    expect(out[0]!.groundedIn).toEqual([CRUD_PS, OBJ]);
    expect(out[0]!.claim.toLowerCase()).toContain('read');
    expect(out[0]!.claim.toLowerCase()).toContain('table-level');
  });

  it('create/edit/delete rules fire independently on their CRUD bits', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(CRUD_PS, 'PermissionSet')],
      edges: [
        edge(CRUD_PS, OBJ, 'grantedBy', 'declared', {
          allowCreate: true,
          allowRead: true,
          allowEdit: true,
          allowDelete: true,
        }),
      ],
    };
    expect(interpret(CREATE_RULE, slice, COMPLETE, OBJ)).toHaveLength(1);
    expect(interpret(EDIT_RULE, slice, COMPLETE, OBJ)).toHaveLength(1);
    expect(interpret(DELETE_RULE, slice, COMPLETE, OBJ)).toHaveLength(1);
  });

  it('[negative] all CRUD bits false does NOT fire any rule', () => {
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(CRUD_PS, 'PermissionSet')],
      edges: [
        edge(CRUD_PS, OBJ, 'grantedBy', 'declared', {
          allowCreate: false,
          allowRead: false,
          allowEdit: false,
          allowDelete: false,
        }),
      ],
    };
    expect(interpret(READ_RULE, slice, COMPLETE, OBJ)).toEqual([]);
    expect(interpret(CREATE_RULE, slice, COMPLETE, OBJ)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 A16 — concept:apex-class-access-grant. ONE grantedBy EDGE rule to ApexClass.
// ---------------------------------------------------------------------------

describe('concept:apex-class-access-grant — Apex class grantedBy EDGE rule', () => {
  const RULE = ruleById('rule:access/apex-class-enabled-grant');
  const APEX = 'ApexClass:Ns__GuestController';
  const PS = 'PermissionSet:Ns__GuestAccess';

  it('ships the concept and enabled:true edge rule', () => {
    expect(CONCEPTS['concept:apex-class-access-grant']!.kind).toBe('access-mechanism');
    expect(RULE.bind.edgeType).toBe('grantedBy');
    expect(RULE.bind.edgeWhereProperty).toEqual({ key: 'enabled', equals: true });
  });

  it('fires on enabled class access grant — cites grantor + ApexClass', () => {
    const slice: GroundedSlice = {
      nodes: [node(APEX, 'ApexClass'), node(PS, 'PermissionSet')],
      edges: [edge(PS, APEX, 'grantedBy', 'declared', { enabled: true })],
    };
    const out = interpret(RULE, slice, COMPLETE, APEX);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:apex-class-access-grant');
    expect(out[0]!.groundedIn).toEqual([PS, APEX]);
    expect(out[0]!.claim.toLowerCase()).toContain('apex class');
  });

  it('[negative] enabled:false does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node(APEX, 'ApexClass'), node(PS, 'PermissionSet')],
      edges: [edge(PS, APEX, 'grantedBy', 'declared', { enabled: false })],
    };
    expect(interpret(RULE, slice, COMPLETE, APEX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 A17 — concept:custom-permission-gating. grantedBy + references rules.
// ---------------------------------------------------------------------------

describe('concept:custom-permission-gating — custom permission grant and gate rules', () => {
  const GRANT_RULE = ruleById('rule:access/custom-permission-granted');
  const GATE_RULE = ruleById('rule:access/custom-permission-referenced-gate');
  const CP = 'CustomPermission:Ns__Skip_Validation';
  const PS = 'PermissionSet:Ns__Bypass';
  const VR = 'ValidationRule:Ns__Deal__c.Ns__Require_Amount';

  it('ships the concept and both rule shapes', () => {
    expect(CONCEPTS['concept:custom-permission-gating']!.kind).toBe('access-mechanism');
    expect(GRANT_RULE.bind.edgeType).toBe('grantedBy');
    expect(GATE_RULE.bind.edgeType).toBe('references');
  });

  it('grant rule fires on enabled custom permission conferral', () => {
    const slice: GroundedSlice = {
      nodes: [node(CP, 'CustomPermission'), node(PS, 'PermissionSet')],
      edges: [edge(PS, CP, 'grantedBy', 'declared', { enabled: true })],
    };
    const out = interpret(GRANT_RULE, slice, COMPLETE, CP);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:custom-permission-gating');
    expect(out[0]!.groundedIn).toEqual([PS, CP]);
  });

  it('gate rule fires on $Permission references edge from validation rule', () => {
    const slice: GroundedSlice = {
      nodes: [node(VR, 'ValidationRule'), node(CP, 'CustomPermission')],
      edges: [edge(VR, CP, 'references', 'declared')],
    };
    const out = interpret(GATE_RULE, slice, COMPLETE, VR);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:custom-permission-gating');
    expect(out[0]!.groundedIn).toEqual([VR, CP]);
    expect(out[0]!.claim.toLowerCase()).toContain('gate');
  });
});

// ---------------------------------------------------------------------------
// ARC-2 A18 — concept:external-service-requires-named-credential. references edge.
// ---------------------------------------------------------------------------

describe('concept:external-service-requires-named-credential — ExternalService references NamedCredential', () => {
  const RULE = ruleById('rule:integration/external-service-named-credential');
  const SVC = 'ExternalService:Ns__OrderService';
  const NC = 'NamedCredential:Ns__OrderApi';

  it('ships the concept and references edge rule', () => {
    expect(CONCEPTS['concept:external-service-requires-named-credential']!.kind).toBe(
      'external-api-surface',
    );
    expect(RULE.bind.edgeType).toBe('references');
    expect(RULE.bind.componentTypes).toEqual(['ExternalService', 'NamedCredential']);
  });

  it('fires on ExternalService → NamedCredential reference', () => {
    const slice: GroundedSlice = {
      nodes: [node(SVC, 'ExternalService'), node(NC, 'NamedCredential')],
      edges: [edge(SVC, NC, 'references', 'declared', { role: 'credential' })],
    };
    const out = interpret(RULE, slice, COMPLETE, SVC);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:external-service-requires-named-credential');
    expect(out[0]!.groundedIn).toEqual([SVC, NC]);
    expect(out[0]!.claim.toLowerCase()).toContain('named credential');
  });
});

// ---------------------------------------------------------------------------
// ARC-2 A19 — concept:external-data-source-auth-dependency. references + principalType.
// ---------------------------------------------------------------------------

describe('concept:external-data-source-auth-dependency — EDS auth provider + principalType', () => {
  const AUTH_RULE = ruleById('rule:integration/external-data-source-auth-provider');
  const PRINC_RULE = ruleById('rule:integration/external-data-source-principal-type');
  const EDS = 'ExternalDataSource:Ns__SapCustomers';
  const AP = 'AuthProvider:Ns__OpenId';

  it('ships the concept and both rule shapes', () => {
    expect(CONCEPTS['concept:external-data-source-auth-dependency']!.kind).toBe(
      'external-api-surface',
    );
    expect(AUTH_RULE.bind.edgeType).toBe('references');
    expect(PRINC_RULE.bind.whereProperty).toEqual({ key: 'principalType', isNull: false });
  });

  it('auth rule fires on ExternalDataSource → AuthProvider reference', () => {
    const slice: GroundedSlice = {
      nodes: [node(EDS, 'ExternalDataSource'), node(AP, 'AuthProvider')],
      edges: [edge(EDS, AP, 'references', 'declared', { role: 'auth' })],
    };
    const out = interpret(AUTH_RULE, slice, COMPLETE, EDS);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:external-data-source-auth-dependency');
    expect(out[0]!.groundedIn).toEqual([EDS, AP]);
  });

  it('principalType node rule fires when principalType is declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(EDS, 'ExternalDataSource', {
          endpoint: 'https://example.com',
          dataSourceType: 'OData4',
          isWritable: false,
          principalType: 'PerUser',
        }),
      ],
      edges: [],
    };
    const out = interpret(PRINC_RULE, slice, COMPLETE, EDS);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:external-data-source-auth-dependency');
    expect(out[0]!.claim.toLowerCase()).toContain('principal type');
  });
});

// ---------------------------------------------------------------------------
// ARC-2 Wave 3 A10 — concept:object-widened-by-sharing-rule-count (root-outgoing
// parentOf aggregate, gte 2 SharingRule children).
// ---------------------------------------------------------------------------

describe('concept:object-widened-by-sharing-rule-count — rule:sharing/object-widened-by-sharing-rule-count', () => {
  const rule = ruleById('rule:sharing/object-widened-by-sharing-rule-count');
  const OBJ = 'CustomObject:Ns__Deal__c';
  const RULE_A = 'SharingRule:Ns__Deal__c.Ns__ShareA';
  const RULE_B = 'SharingRule:Ns__Deal__c.Ns__ShareB';
  const RULE_C = 'SharingRule:Ns__Deal__c.Ns__ShareC';

  const parentOf = (ruleId: string): Edge => edge(OBJ, ruleId, 'parentOf', 'declared');

  it('has root-outgoing parentOf aggregate (gte 2, distinct SharingRule endpoints)', () => {
    expect(rule.bind.edgeType).toBe('parentOf');
    expect(rule.bind.aggregate!.edgeSource).toBe('root-outgoing');
    expect(rule.bind.aggregate!.countDistinctEndpoint).toBe('to');
    expect(rule.bind.aggregate!.op).toBe('gte');
    expect(rule.bind.aggregate!.threshold).toBe(2);
  });

  it('fires on >= 2 sharing rules — cites rules first, object trailing', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', { sharingModel: 'Private' }),
        node(RULE_A, 'SharingRule', { ruleType: 'criteria' }),
        node(RULE_B, 'SharingRule', { ruleType: 'owner' }),
      ],
      edges: [parentOf(RULE_A), parentOf(RULE_B)],
    };
    const out = interpret(rule, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:object-widened-by-sharing-rule-count');
    expect(out[0]!.groundedIn).toEqual([RULE_A, RULE_B, OBJ]);
    expect(out[0]!.claim).toContain('2 sharing rules');
  });

  it('does NOT fire on 0 or 1 sharing rule', () => {
    const one: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), node(RULE_A, 'SharingRule', { ruleType: 'criteria' })],
      edges: [parentOf(RULE_A)],
    };
    expect(interpret(rule, one, COMPLETE, OBJ)).toEqual([]);
    expect(interpret(rule, { nodes: [node(OBJ, 'CustomObject')], edges: [] }, COMPLETE, OBJ)).toEqual([]);
  });

  it('fires on 3+ sharing rules and cites all rule ids before the object', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', { sharingModel: 'Private' }),
        node(RULE_A, 'SharingRule', { ruleType: 'criteria' }),
        node(RULE_B, 'SharingRule', { ruleType: 'owner' }),
        node(RULE_C, 'SharingRule', { ruleType: 'criteria' }),
      ],
      edges: [parentOf(RULE_A), parentOf(RULE_B), parentOf(RULE_C)],
    };
    const out = interpret(rule, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([RULE_A, RULE_B, RULE_C, OBJ]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 Wave 3 A20 — concept:duplicate-rule-blocks-save (anyElement Block + legacy
// actionOnInsert/Update Block NODE rules).
// ---------------------------------------------------------------------------

describe('concept:duplicate-rule-blocks-save — DuplicateRule Block NODE rules', () => {
  const INSERT_OPS = ruleById('rule:duplicate-rule/blocks-on-insert-operations');
  const UPDATE_OPS = ruleById('rule:duplicate-rule/blocks-on-update-operations');
  const INSERT_ACTION = ruleById('rule:duplicate-rule/blocks-on-insert-action');
  const DUP = 'DuplicateRule:Ns__Account.Ns__BlockDupes';

  it('fires on operationsOnInsert containing Block', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DUP, 'DuplicateRule', {
          isActive: true,
          operationsOnInsert: ['Alert', 'Block'],
          operationsOnUpdate: ['Allow'],
        }),
      ],
      edges: [],
    };
    const out = interpret(INSERT_OPS, slice, COMPLETE, DUP);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:duplicate-rule-blocks-save');
    expect(out[0]!.claim.toLowerCase()).toContain('block');
    expect(out[0]!.claim.toLowerCase()).toContain('insert');
  });

  it('does NOT fire when Block is absent from operations', () => {
    const slice: GroundedSlice = {
      nodes: [node(DUP, 'DuplicateRule', { operationsOnInsert: ['Allow'], actionOnInsert: 'Allow' })],
      edges: [],
    };
    expect(interpret(INSERT_OPS, slice, COMPLETE, DUP)).toEqual([]);
    expect(interpret(INSERT_ACTION, slice, COMPLETE, DUP)).toEqual([]);
  });

  it('legacy actionOnInsert Block fires independently', () => {
    const slice: GroundedSlice = {
      nodes: [node(DUP, 'DuplicateRule', { actionOnInsert: 'Block', operationsOnInsert: [] })],
      edges: [],
    };
    expect(interpret(INSERT_ACTION, slice, COMPLETE, DUP)).toHaveLength(1);
    expect(interpret(UPDATE_OPS, slice, COMPLETE, DUP)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 Wave 3 A21 — concept:redundant-sharing-rule-on-public-object (public OWD
// + root-outgoing parentOf SharingRule count gte 1).
// ---------------------------------------------------------------------------

describe('concept:redundant-sharing-rule-on-public-object — rule:sharing/redundant-rule-on-public-object', () => {
  const rule = ruleById('rule:sharing/redundant-rule-on-public-object');
  const OBJ = 'CustomObject:Ns__Deal__c';
  const SHARE = 'SharingRule:Ns__Deal__c.Ns__Redundant';

  it('fires only when OWD is public AND a sharing rule exists', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', { sharingModel: 'ReadWrite' }),
        node(SHARE, 'SharingRule', { ruleType: 'criteria' }),
      ],
      edges: [edge(OBJ, SHARE, 'parentOf', 'declared')],
    };
    const out = interpret(rule, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:redundant-sharing-rule-on-public-object');
    expect(out[0]!.claim.toLowerCase()).toContain('public');
  });

  it('does NOT fire on Private OWD even with sharing rules', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(OBJ, 'CustomObject', { sharingModel: 'Private' }),
        node(SHARE, 'SharingRule', { ruleType: 'criteria' }),
      ],
      edges: [edge(OBJ, SHARE, 'parentOf', 'declared')],
    };
    expect(interpret(rule, slice, COMPLETE, OBJ)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 Wave 3 B10 — concept:flow-subflow-inactive-target (Active parent → inactive
// subflow via references aggregate + endpointWhereProperty notIn Active).
// ---------------------------------------------------------------------------

describe('concept:flow-subflow-inactive-target — rule:flow/subflow-inactive-target', () => {
  const rule = ruleById('rule:flow/subflow-inactive-target');
  const PARENT = 'Flow:Ns__ParentFlow';
  const SUB_DRAFT = 'Flow:Ns__ChildDraft';
  const SUB_ACTIVE = 'Flow:Ns__ChildActive';

  const subflowRef = (target: string): Edge =>
    edge(PARENT, target, 'references', 'declared', { referenceKind: 'subflow' });

  it('has root-outgoing references aggregate with subflow edge filter and inactive target filter', () => {
    expect(rule.bind.whereProperty).toEqual({ key: 'status', equals: 'Active' });
    expect(rule.bind.aggregate!.edgeSource).toBe('root-outgoing');
    expect(rule.bind.aggregate!.countedEdgeWhereProperty).toEqual({
      key: 'referenceKind',
      equals: 'subflow',
    });
    expect(rule.bind.aggregate!.endpointWhereProperty).toEqual({
      key: 'status',
      notIn: ['Active'],
    });
  });

  it('fires when Active parent references a Draft subflow', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(PARENT, 'Flow', { status: 'Active' }),
        node(SUB_DRAFT, 'Flow', { status: 'Draft' }),
      ],
      edges: [subflowRef(SUB_DRAFT)],
    };
    const out = interpret(rule, slice, COMPLETE, PARENT);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:flow-subflow-inactive-target');
    expect(out[0]!.groundedIn).toEqual([SUB_DRAFT, PARENT]);
    expect(out[0]!.claim.toLowerCase()).toContain('inactive subflow');
  });

  it('does NOT fire when subflow target is Active or parent is Draft', () => {
    const activeTarget: GroundedSlice = {
      nodes: [
        node(PARENT, 'Flow', { status: 'Active' }),
        node(SUB_ACTIVE, 'Flow', { status: 'Active' }),
      ],
      edges: [subflowRef(SUB_ACTIVE)],
    };
    expect(interpret(rule, activeTarget, COMPLETE, PARENT)).toEqual([]);
    const draftParent: GroundedSlice = {
      nodes: [
        node(PARENT, 'Flow', { status: 'Draft' }),
        node(SUB_DRAFT, 'Flow', { status: 'Draft' }),
      ],
      edges: [subflowRef(SUB_DRAFT)],
    };
    expect(interpret(rule, draftParent, COMPLETE, PARENT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 Wave 4 — sharing batch (B2, B4, B14)
// ---------------------------------------------------------------------------

describe('concept:territory-sharing-rule — rule:sharing/territory-sharing-rule', () => {
  const rule = ruleById('rule:sharing/territory-sharing-rule');
  const TERRITORY_RULE = 'SharingRule:Ns__Deal__c.Ns__TerritoryShare';

  it('is a node-shaped SharingRule rule (ruleType===territory, declared)', () => {
    expect(rule.concept).toBe('concept:territory-sharing-rule');
    expect(rule.bind.componentTypes).toEqual(['SharingRule']);
    expect(rule.bind.whereProperty).toEqual({ key: 'ruleType', equals: 'territory' });
    expect(rule.maxConfidence).toBe('declared');
  });

  it('fires on ruleType===territory, not on criteria/owner/guest', () => {
    const slice: GroundedSlice = {
      nodes: [node(TERRITORY_RULE, 'SharingRule', { ruleType: 'territory', accessLevel: 'Read' })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, TERRITORY_RULE);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([TERRITORY_RULE]);
    expect(out[0]!.claim.toLowerCase()).toContain('territory');
    for (const other of ['criteria', 'owner', 'guest'] as const) {
      const otherId = 'SharingRule:Ns__Deal__c.Ns__Other';
      expect(interpret(rule, { nodes: [node(otherId, 'SharingRule', { ruleType: other })], edges: [] }, COMPLETE, otherId)).toEqual([]);
    }
  });
});

describe('concept:scoping-rule-not-security — rule:sharing/scoping-rule-not-security', () => {
  const rule = ruleById('rule:sharing/scoping-rule-not-security');
  const SCOPING = 'ScopingRule:Ns__AccountScope';

  it('fires on active===true string, not inactive or absent', () => {
    expect(rule.bind.whereProperty).toEqual({ key: 'active', equals: 'true' });
    const active = interpret(rule, { nodes: [node(SCOPING, 'ScopingRule', { active: 'true' })], edges: [] }, COMPLETE, SCOPING);
    expect(active).toHaveLength(1);
    expect(active[0]!.claim.toLowerCase()).toContain('not a security boundary');
    expect(interpret(rule, { nodes: [node(SCOPING, 'ScopingRule', { active: 'false' })], edges: [] }, COMPLETE, SCOPING)).toEqual([]);
    expect(interpret(rule, { nodes: [node(SCOPING, 'ScopingRule', {})], edges: [] }, COMPLETE, SCOPING)).toEqual([]);
  });
});

describe('concept:list-view-sharing-not-record-access — rule:sharing/list-view-visible-to', () => {
  const rule = ruleById('rule:sharing/list-view-visible-to');
  const LV = 'ListView:Ns__Deal__c.Ns__MyView';
  const ROLE = 'Role:Ns__SalesMgr';

  it('fires on visibleTo edge — claim is UI visibility, not record access', () => {
    expect(rule.bind.edgeType).toBe('visibleTo');
    const slice: GroundedSlice = {
      nodes: [node(LV, 'ListView'), node(ROLE, 'Role')],
      edges: [edge(LV, ROLE, 'visibleTo', 'declared', { sharedToType: 'role' })],
    };
    const out = interpret(rule, slice, COMPLETE, LV);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([LV, ROLE]);
    expect(out[0]!.claim.toLowerCase()).toContain('not record-level access');
  });
});

// ---------------------------------------------------------------------------
// ARC-2 Wave 4 — security batch (B7, B8, B16, B18)
// ---------------------------------------------------------------------------

describe('concept:session-security-posture — SessionSettings NODE rules', () => {
  const SESSION = 'SessionSettings:default';
  const mfaRule = ruleById('rule:security/session-mfa-required');
  const strongRule = ruleById('rule:security/session-strong-auth-required');

  it('fires MFA and strong-auth rules independently when true', () => {
    const both: GroundedSlice = {
      nodes: [node(SESSION, 'SessionSettings', { mfaRequired: true, requiresStrongAuth: true })],
      edges: [],
    };
    expect(interpret(mfaRule, both, COMPLETE, SESSION)).toHaveLength(1);
    expect(interpret(strongRule, both, COMPLETE, SESSION)).toHaveLength(1);
    expect(interpret(mfaRule, { nodes: [node(SESSION, 'SessionSettings', { mfaRequired: false })], edges: [] }, COMPLETE, SESSION)).toEqual([]);
  });
});

describe('concept:transaction-security-policy-posture — TSP rules', () => {
  const TSP = 'TransactionSecurityPolicy:Ns__BlockExport';
  const APEX = 'ApexClass:Ns__ExportCondition';
  const activeRule = ruleById('rule:security/tsp-active');
  const apexRule = ruleById('rule:security/tsp-apex-condition');

  it('active rule fires on active===true string only', () => {
    expect(interpret(activeRule, { nodes: [node(TSP, 'TransactionSecurityPolicy', { active: 'true' })], edges: [] }, COMPLETE, TSP)).toHaveLength(1);
    expect(interpret(activeRule, { nodes: [node(TSP, 'TransactionSecurityPolicy', { active: 'false' })], edges: [] }, COMPLETE, TSP)).toEqual([]);
  });

  it('apex references edge fires with TSP + ApexClass endpoints', () => {
    const slice: GroundedSlice = {
      nodes: [node(TSP, 'TransactionSecurityPolicy'), node(APEX, 'ApexClass')],
      edges: [edge(TSP, APEX, 'references', 'declared')],
    };
    const out = interpret(apexRule, slice, COMPLETE, TSP);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([TSP, APEX]);
    expect(out[0]!.claim.toLowerCase()).toContain('apex');
  });
});

describe('concept:guest-record-default-owner — rule:security/guest-record-default-owner', () => {
  const rule = ruleById('rule:security/guest-record-default-owner');
  const SITE = 'CustomSite:Ns__PartnerSite';

  it('fires when guestRecordDefaultOwner is present, not when absent', () => {
    expect(interpret(rule, { nodes: [node(SITE, 'CustomSite', { guestRecordDefaultOwner: '005xx0000000001' })], edges: [] }, COMPLETE, SITE)).toHaveLength(1);
    expect(interpret(rule, { nodes: [node(SITE, 'CustomSite', {})], edges: [] }, COMPLETE, SITE)).toEqual([]);
  });
});

describe('concept:login-hours-restriction — rule:security/profile-login-hours', () => {
  const rule = ruleById('rule:security/profile-login-hours');
  const PROFILE = 'Profile:Ns__RestrictedHours';

  it('fires when loginHoursDefined===true', () => {
    const slice: GroundedSlice = {
      nodes: [node(PROFILE, 'Profile', { loginHoursDefined: true, loginHours: [{ day: 'Monday', startTime: 480, endTime: 1020 }] })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, PROFILE);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('login hours');
    expect(interpret(rule, { nodes: [node(PROFILE, 'Profile', { loginHoursDefined: false })], edges: [] }, COMPLETE, PROFILE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 Wave 4 — flow batch (B21, B22)
// ---------------------------------------------------------------------------

describe('concept:flow-scheduled-trigger-batch-context — rule:flow/scheduled-trigger-batch-context', () => {
  const rule = ruleById('rule:flow/scheduled-trigger-batch-context');
  const SCHEDULED = 'Flow:Ns__NightlySweep';

  it('fires on triggerType===Scheduled only', () => {
    expect(rule.bind.whereProperty).toEqual({ key: 'triggerType', equals: 'Scheduled' });
    const out = interpret(rule, { nodes: [node(SCHEDULED, 'Flow', { triggerType: 'Scheduled' })], edges: [] }, COMPLETE, SCHEDULED);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('schedule');
    for (const other of ['RecordAfterSave', 'PlatformEvent'] as const) {
      expect(interpret(rule, { nodes: [node('Flow:Ns__Other', 'Flow', { triggerType: other })], edges: [] }, COMPLETE, 'Flow:Ns__Other')).toEqual([]);
    }
  });
});

describe('concept:flow-inactive-dead-automation — rule:flow/inactive-dead-automation', () => {
  const rule = ruleById('rule:flow/inactive-dead-automation');
  const DRAFT = 'Flow:Ns__DraftFlow';
  const ACTIVE = 'Flow:Ns__LiveFlow';

  it('fires on status!==Active, excluded from save-order claim', () => {
    expect(rule.bind.whereProperty).toEqual({ key: 'status', neq: 'Active' });
    const draft = interpret(rule, { nodes: [node(DRAFT, 'Flow', { status: 'Draft' })], edges: [] }, COMPLETE, DRAFT);
    expect(draft).toHaveLength(1);
    expect(draft[0]!.claim.toLowerCase()).toContain('excluded');
    expect(interpret(rule, { nodes: [node(ACTIVE, 'Flow', { status: 'Active' })], edges: [] }, COMPLETE, ACTIVE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 Wave 4 tail — B12, B13, B15, B17, B19
// ---------------------------------------------------------------------------

describe('concept:cdc-event-retention-replay-ordering', () => {
  const rule = ruleById('rule:integration/cdc-event-channel-present');
  const CH = 'PlatformEventChannel:Ns__AppChannel__chn';

  it('fires on PlatformEventChannel presence with async delivery claim', () => {
    const out = interpret(rule, { nodes: [node(CH, 'PlatformEventChannel', { channelType: 'event' })], edges: [] }, COMPLETE, CH);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('asynchronous');
  });
});

describe('concept:external-object-odata-live-callout', () => {
  const rule = ruleById('rule:integration/external-object-live-callout');
  const EDS = 'ExternalDataSource:Ns__OData';

  it('fires when endpoint is present', () => {
    const out = interpret(rule, { nodes: [node(EDS, 'ExternalDataSource', { endpoint: 'https://example.com', dataSourceType: 'OData', isWritable: false })], edges: [] }, COMPLETE, EDS);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('live callout');
  });
});

describe('concept:muting-permission-set-scope', () => {
  const rule = ruleById('rule:access/psg-muting-permission-set-binding');
  const PSG = 'PermissionSetGroup:Ns__SalesGroup';
  const MUTE = 'MutingPermissionSet:Ns__SalesMute';

  it('fires on PSG references mutingPermissionSet edge', () => {
    const slice: GroundedSlice = {
      nodes: [node(PSG, 'PermissionSetGroup'), node(MUTE, 'MutingPermissionSet')],
      edges: [edge(PSG, MUTE, 'references', 'declared', { referenceKind: 'mutingPermissionSet' })],
    };
    const out = interpret(rule, slice, COMPLETE, PSG);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('only inside');
  });
});

describe('concept:permission-provenance-profile-vs-permset', () => {
  const objRule = ruleById('rule:access/profile-grant-provenance');
  const PROF = 'Profile:Ns__Standard';
  const OBJ = 'CustomObject:Ns__Deal__c';

  it('fires on Profile grantedBy to CustomObject', () => {
    const slice: GroundedSlice = {
      nodes: [node(PROF, 'Profile'), node(OBJ, 'CustomObject')],
      edges: [edge(PROF, OBJ, 'grantedBy', 'declared', { allowRead: true })],
    };
    const out = interpret(objRule, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('profile');
  });
});

describe('concept:outbound-message-soap-callout-posture', () => {
  const sessRule = ruleById('rule:integration/outbound-message-session-id');
  const OM = 'OutboundMessage:Account.Ns__Notify';

  it('fires when includeSessionId is true', () => {
    const out = interpret(sessRule, { nodes: [node(OM, 'OutboundMessage', { includeSessionId: true, endpointUrl: 'https://example.com/soap' })], edges: [] }, COMPLETE, OM);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('session id');
  });
});


describe('concept:recursive-automation-self-write (EC-6 / C11)', () => {
  const rule = ruleById('rule:automation/recursive-self-write');
  const FLOW = 'Flow:Ns__SelfWrite';
  const OBJ = 'CustomObject:Ns__Deal__c';
  const FIELD = 'CustomField:Ns__Deal__c.Status__c';

  it('fires when Active Flow triggersOn object and writesTo same-object field', () => {
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
    const out = interpret(rule, slice, COMPLETE, FLOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FLOW, OBJ, FIELD]);
    expect(out[0]!.claim.toLowerCase()).toContain('re-enter');
  });

  it('stays silent on cross-object writesTo', () => {
    const other = 'CustomField:Ns__Other__c.Status__c';
    const slice: GroundedSlice = {
      nodes: [
        node(FLOW, 'Flow', { status: 'Active' }),
        node(OBJ, 'CustomObject'),
        node(other, 'CustomField'),
      ],
      edges: [
        edge(FLOW, OBJ, 'triggersOn', 'declared'),
        edge(FLOW, other, 'writesTo', 'parsed'),
      ],
    };
    expect(interpret(rule, slice, COMPLETE, FLOW)).toEqual([]);
  });
});


describe('concept:flow-self-dml-reentry (D9 / property-equals-endpoint)', () => {
  const rule = ruleById('rule:automation/flow-self-dml-reentry');
  const FLOW = 'Flow:Ns__DealAfterSave';
  const OBJ = 'CustomObject:Ns__Deal__c';
  const FIELD = 'CustomField:Ns__Deal__c.Stage__c';

  it('is a propertyEqualsEndpoint Flow rule gated to DML operations', () => {
    expect(rule.bind.componentTypes).toEqual(['Flow']);
    expect(rule.bind.propertyEqualsEndpoint).toEqual({
      nodeProperty: 'triggerObject',
      endpointEdgeType: 'writesTo',
      relation: 'equal',
      endpointEdgeWhereProperty: {
        key: 'operation',
        in: ['recordCreate', 'recordUpdate', 'recordDelete'],
      },
      excludeInactive: true,
    });
    expect(rule.maxConfidence).toBe('heuristic');
  });

  it('fires when an Active after-save flow DML-updates its own trigger object', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(FLOW, 'Flow', {
            status: 'Active',
            triggerType: 'RecordAfterSave',
            triggerObject: 'Ns__Deal__c',
          }),
          node(OBJ, 'CustomObject'),
        ],
        edges: [edge(FLOW, OBJ, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
      },
      COMPLETE,
      FLOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([FLOW, OBJ]);
    expect(out[0]!.claim.toLowerCase()).toContain('re-enter');
    expect(out[0]!.claim).toContain('recordUpdate');
    expect(out[0]!.claim).toContain('Ns__Deal__c');
  });

  it('stays silent on a before-save in-place $Record field assignment (C11 would fire)', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(FLOW, 'Flow', {
              status: 'Active',
              triggerType: 'RecordBeforeSave',
              triggerObject: 'Ns__Deal__c',
            }),
            node(FIELD, 'CustomField'),
          ],
          edges: [
            edge(FLOW, FIELD, 'writesTo', 'parsed', { operation: 'beforeSaveFieldAssignment' }),
          ],
        },
        COMPLETE,
        FLOW,
      ),
    ).toEqual([]);
  });

  it('stays silent on cross-object DML and absent triggerObject', () => {
    const other = 'CustomObject:Ns__Account__c';
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(FLOW, 'Flow', {
              status: 'Active',
              triggerType: 'RecordAfterSave',
              triggerObject: 'Ns__Deal__c',
            }),
            node(other, 'CustomObject'),
          ],
          edges: [edge(FLOW, other, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
        },
        COMPLETE,
        FLOW,
      ),
    ).toEqual([]);
    expect(
      interpret(
        rule,
        {
          nodes: [node(FLOW, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' })],
          edges: [edge(FLOW, OBJ, 'writesTo', 'parsed', { operation: 'recordUpdate' })],
        },
        COMPLETE,
        FLOW,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 concept-expansion — three new pure-YAML NODE concepts:
//   validation-rule-inactive, workflow-rule-inactive-dead,
//   picklist-backed-by-global-value-set.
// Each grounds on an already-extracted node property (active / valueSetName)
// with an already-supported bind predicate — no new engine primitive.
// ---------------------------------------------------------------------------

describe('concept:validation-rule-inactive — rule:validation-rule/inactive-dead', () => {
  const rule = ruleById('rule:validation-rule/inactive-dead');
  const INACTIVE = 'ValidationRule:Ns__Deal__c.Ns__Require_Amount';
  const ACTIVE = 'ValidationRule:Ns__Deal__c.Ns__Require_Close_Reason';

  it('ships the concept with the firing-condition kind and active===false bind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('firing-condition');
    expect(rule.bind.whereProperty).toEqual({ key: 'active', equals: false });
  });

  it('fires on active===false with an excluded-from-save-failure claim, declared', () => {
    const out = interpret(
      rule,
      { nodes: [node(INACTIVE, 'ValidationRule', { active: false })], edges: [] },
      COMPLETE,
      INACTIVE,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(INACTIVE);
    expect(out[0]!.confidence).toBe('declared');
    const claim = out[0]!.claim.toLowerCase();
    expect(claim).toContain('inactive');
    expect(claim).toContain('excluded');
  });

  it('does NOT fire on an active validation rule', () => {
    expect(
      interpret(rule, { nodes: [node(ACTIVE, 'ValidationRule', { active: true })], edges: [] }, COMPLETE, ACTIVE),
    ).toEqual([]);
  });
});

describe('concept:workflow-rule-inactive-dead — rule:workflow/inactive-dead', () => {
  const rule = ruleById('rule:workflow/inactive-dead');
  const INACTIVE = 'WorkflowRule:Ns__Deal__c.Ns__Stale_Alert';
  const ACTIVE = 'WorkflowRule:Ns__Deal__c.Ns__Live_Alert';

  it('ships the concept with the firing-condition kind and active===false bind', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('firing-condition');
    expect(rule.bind.whereProperty).toEqual({ key: 'active', equals: false });
  });

  it('fires on active===false with a dead-legacy-automation claim, declared', () => {
    const out = interpret(
      rule,
      { nodes: [node(INACTIVE, 'WorkflowRule', { active: false })], edges: [] },
      COMPLETE,
      INACTIVE,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(INACTIVE);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim.toLowerCase()).toContain('dead legacy automation');
  });

  it('does NOT fire on an active workflow rule', () => {
    expect(
      interpret(rule, { nodes: [node(ACTIVE, 'WorkflowRule', { active: true })], edges: [] }, COMPLETE, ACTIVE),
    ).toEqual([]);
  });
});


describe('concept:rollup-recalc-source-coupling (EC-13 / C9)', () => {
  const rule = ruleById('rule:relationship/rollup-recalc-source');
  const FIELD = 'CustomField:Ns__Parent__c.ChildCount__c';

  it('names summaryForeignKey and summaryOperation via prop interpolation', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(FIELD, 'CustomField', {
            dataType: 'Summary',
            summaryForeignKey: 'Ns__Child__c.Ns__Parent__c',
            summaryOperation: 'sum',
          }),
        ],
        edges: [],
      },
      COMPLETE,
      FIELD,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('Ns__Child__c.Ns__Parent__c');
    expect(out[0]!.claim).toContain('sum');
  });

  it('stays silent without summaryForeignKey', () => {
    expect(
      interpret(
        rule,
        { nodes: [node(FIELD, 'CustomField', { dataType: 'Summary', summaryOperation: 'count' })], edges: [] },
        COMPLETE,
        FIELD,
      ),
    ).toEqual([]);
  });
});


describe('concept:field-history-tracking-20-field-limit (D5)', () => {
  const rule = ruleById('rule:field/history-tracking-cap');
  const OBJ = 'CustomObject:Ns__Deal__c';

  const field = (i: number, tracked: boolean) =>
    node(`CustomField:Ns__Deal__c.F${i}__c`, 'CustomField', { trackHistory: tracked });

  it('fires when an object has ≥20 tracked fields', () => {
    const fields = Array.from({ length: 20 }, (_, i) => field(i, true));
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), ...fields],
      edges: fields.map((f) => edge(OBJ, f.id, 'parentOf', 'declared')),
    };
    const out = interpret(rule, slice, COMPLETE, OBJ);
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('20');
    expect(out[0]!.claim).toContain(OBJ);
  });

  it('stays silent at 19 tracked fields', () => {
    const fields = Array.from({ length: 19 }, (_, i) => field(i, true));
    const slice: GroundedSlice = {
      nodes: [node(OBJ, 'CustomObject'), ...fields],
      edges: fields.map((f) => edge(OBJ, f.id, 'parentOf', 'declared')),
    };
    expect(interpret(rule, slice, COMPLETE, OBJ)).toEqual([]);
  });
});


describe('concept:formula-on-derived (EC-4 / C8)', () => {
  const formulaRule = ruleById('rule:field/formula-on-derived-formula');
  const summaryRule = ruleById('rule:field/formula-on-derived-summary');
  const F = 'CustomField:Ns__Deal__c.Score__c';
  const INNER = 'CustomField:Ns__Deal__c.Base__c';
  const SUM = 'CustomField:Ns__Deal__c.ChildCount__c';

  it('fires formula→formula', () => {
    const out = interpret(
      formulaRule,
      {
        nodes: [
          node(F, 'CustomField', { isFormula: true }),
          node(INNER, 'CustomField', { isFormula: true }),
        ],
        edges: [edge(F, INNER, 'references', 'parsed')],
      },
      COMPLETE,
      F,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('second-order');
  });

  it('fires formula→Summary', () => {
    const out = interpret(
      summaryRule,
      {
        nodes: [
          node(F, 'CustomField', { isFormula: true }),
          node(SUM, 'CustomField', { dataType: 'Summary' }),
        ],
        edges: [edge(F, SUM, 'references', 'parsed')],
      },
      COMPLETE,
      F,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('roll-up');
  });
});


describe('concept:mixed-dml-setup-vs-nonsetup (EC-7 / C12)', () => {
  const rule = ruleById('rule:apex/mixed-dml-setup-write');
  const CLS = 'ApexClass:Ns__UserProvisioner';
  const USER_FIELD = 'CustomField:User.Email';
  const DEAL_FIELD = 'CustomField:Ns__Deal__c.Status__c';

  it('fires when Apex writesTo a User field (setup object)', () => {
    const out = interpret(
      rule,
      {
        nodes: [node(CLS, 'ApexClass'), node(USER_FIELD, 'CustomField')],
        edges: [edge(CLS, USER_FIELD, 'writesTo', 'heuristic')],
      },
      COMPLETE,
      CLS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('MIXED_DML');
  });

  it('stays silent when Apex only writes a business object field', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [node(CLS, 'ApexClass'), node(DEAL_FIELD, 'CustomField')],
          edges: [edge(CLS, DEAL_FIELD, 'writesTo', 'heuristic')],
        },
        COMPLETE,
        CLS,
      ),
    ).toEqual([]);
  });
});


describe('concept:cross-phase-write-invisibility (EC-5 / C10)', () => {
  const rule = ruleById('rule:automation/cross-phase-write-invisibility');
  const VR = 'ValidationRule:Ns__Deal__c.Status_Gate';
  const CC = 'ConditionalContext:ValidationRule:Ns__Deal__c.Status_Gate.condition-0';
  const FIELD = 'CustomField:Ns__Deal__c.Status__c';
  const AFTER = 'Flow:Ns__StatusAfter';
  const OBJ = 'CustomObject:Ns__Deal__c';

  it('fires on after-save writer → validation-rule firer', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(VR, 'ValidationRule'),
          node(CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [FIELD] }),
          node(FIELD, 'CustomField'),
          node(AFTER, 'Flow', { status: 'Active' }),
        ],
        edges: [
          edge(VR, CC, 'firesWhen', 'declared', { kind: 'criteria' }),
          edge(AFTER, FIELD, 'writesTo', 'parsed'),
          edge(AFTER, OBJ, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
        ],
      },
      COMPLETE,
      VR,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('NEVER observe');
  });
});


describe('concept:crud-fls-consistency-anti-join (EC-8 / C15)', () => {
  const fieldRule = ruleById('rule:access/crud-fls-field-edit-without-object-edit');
  const objectRule = ruleById('rule:access/crud-fls-object-edit-without-field-edit');
  const PS = 'PermissionSet:Ns__Editor';
  const FIELD = 'CustomField:Ns__Deal__c.Status__c';
  const OBJ = 'CustomObject:Ns__Deal__c';

  it('fires when field editable has no object allowEdit from the same grantor', () => {
    const out = interpret(
      fieldRule,
      {
        nodes: [node(PS, 'PermissionSet'), node(FIELD, 'CustomField'), node(OBJ, 'CustomObject')],
        edges: [edge(PS, FIELD, 'grantedBy', 'declared', { editable: true, readable: true })],
      },
      COMPLETE,
      FIELD,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('INERT');
  });

  it('fires when object allowEdit has no field editable from the same grantor', () => {
    const out = interpret(
      objectRule,
      {
        nodes: [node(PS, 'PermissionSet'), node(FIELD, 'CustomField'), node(OBJ, 'CustomObject')],
        edges: [edge(PS, OBJ, 'grantedBy', 'declared', { allowEdit: true, allowRead: true })],
      },
      COMPLETE,
      FIELD,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toContain('INERT');
  });

  it('stays silent when both field editable and object allowEdit are present', () => {
    const slice: GroundedSlice = {
      nodes: [node(PS, 'PermissionSet'), node(FIELD, 'CustomField'), node(OBJ, 'CustomObject')],
      edges: [
        edge(PS, FIELD, 'grantedBy', 'declared', { editable: true, readable: true }),
        edge(PS, OBJ, 'grantedBy', 'declared', { allowEdit: true, allowRead: true }),
      ],
    };
    expect(interpret(fieldRule, slice, COMPLETE, FIELD)).toEqual([]);
    expect(interpret(objectRule, slice, COMPLETE, FIELD)).toEqual([]);
  });
});


describe('concept:deep-creation-gap (EC-8 / C17)', () => {
  const rule = ruleById('rule:field/deep-creation-gap-no-before-save-writer');
  const FIELD = 'CustomField:Ns__Deal__c.Code__c';
  const FLOW = 'Flow:Ns__FillCode';
  const OBJ = 'CustomObject:Ns__Deal__c';

  it('fires on required+no-default with no before-save writer', () => {
    const out = interpret(
      rule,
      { nodes: [node(FIELD, 'CustomField', { required: true, defaultValue: null })], edges: [] },
      COMPLETE,
      FIELD,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('required');
    expect(out[0]!.claim.toLowerCase()).toContain('before-save');
  });

  it('stays silent when a before-save Flow writes the field', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(FIELD, 'CustomField', { required: true, defaultValue: null }),
            node(FLOW, 'Flow', { status: 'Active' }),
            node(OBJ, 'CustomObject'),
          ],
          edges: [
            edge(FLOW, FIELD, 'writesTo', 'parsed'),
            edge(FLOW, OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
          ],
        },
        COMPLETE,
        FIELD,
      ),
    ).toEqual([]);
  });
});


describe('concept:permission-set-group-muting-calculation (EC-9 / C16)', () => {
  const rule = ruleById('rule:access/psg-muting-set-difference');
  const PSG = 'PermissionSetGroup:Ns__SalesGroup';
  const MEMBER = 'PermissionSet:Ns__SalesMember';
  const MUTE = 'MutingPermissionSet:Ns__SalesMute';

  it('fires when PSG has both member and muting references', () => {
    const out = interpret(
      rule,
      {
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
      },
      COMPLETE,
      PSG,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('union');
    expect(out[0]!.claim.toLowerCase()).toContain('muting');
    expect(out[0]!.groundedIn).toEqual([PSG, MEMBER, MUTE]);
    expect(out[0]!.confidence).toBe('declared');
  });

  it('stays silent when PSG has only members (no muting to subtract)', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [node(PSG, 'PermissionSetGroup'), node(MEMBER, 'PermissionSet')],
          edges: [
            edge(PSG, MEMBER, 'references', 'declared', {
              referenceKind: 'permissionSetGroupMember',
            }),
          ],
        },
        COMPLETE,
        PSG,
      ),
    ).toEqual([]);
  });
});


describe('concept:cross-object-cascade-save (EC-11 / D3)', () => {
  const rule = ruleById('rule:automation/cross-object-cascade-save');
  const WRITER = 'Flow:Ns__CrossCascade';
  const OBJ_A = 'CustomObject:Ns__Deal__c';
  const FIELD_B = 'CustomField:Ns__Line__c.Status__c';
  const TARGET_FLOW = 'Flow:Ns__LineAfterSave';

  it('fires on after-save Flow writing a different object that has incoming automation', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(WRITER, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' }),
          node(OBJ_A, 'CustomObject'),
          node(FIELD_B, 'CustomField'),
          node(TARGET_FLOW, 'Flow', { status: 'Active' }),
        ],
        edges: [
          edge(WRITER, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
          edge(WRITER, FIELD_B, 'writesTo', 'parsed'),
          edge(TARGET_FLOW, 'CustomObject:Ns__Line__c', 'triggersOn', 'declared', {
            triggerType: 'RecordAfterSave',
          }),
        ],
      },
      COMPLETE,
      WRITER,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:cross-object-cascade-save');
    expect(out[0]!.groundedIn).toEqual([WRITER, FIELD_B, TARGET_FLOW]);
    expect(out[0]!.claim.toLowerCase()).toContain('cascade');
    expect(out[0]!.claim.toLowerCase()).toContain('different');
  });

  it('stays silent when target object has no incoming automation', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(WRITER, 'Flow', { status: 'Active', triggerType: 'RecordAfterSave' }),
            node(OBJ_A, 'CustomObject'),
            node(FIELD_B, 'CustomField'),
          ],
          edges: [
            edge(WRITER, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordAfterSave' }),
            edge(WRITER, FIELD_B, 'writesTo', 'parsed'),
          ],
        },
        COMPLETE,
        WRITER,
      ),
    ).toEqual([]);
  });
});


describe('concept:before-save-flow-cross-record-write (EC-11 / D4)', () => {
  const rule = ruleById('rule:automation/before-save-flow-cross-record-write');
  const FLOW = 'Flow:Ns__BeforeCross';
  const OBJ_A = 'CustomObject:Ns__Deal__c';
  const FIELD_B = 'CustomField:Ns__Line__c.Status__c';
  const FIELD_A = 'CustomField:Ns__Deal__c.Status__c';

  it('fires on RecordBeforeSave Flow writing a different object', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(FLOW, 'Flow', { status: 'Active', triggerType: 'RecordBeforeSave' }),
          node(OBJ_A, 'CustomObject'),
          node(FIELD_B, 'CustomField'),
        ],
        edges: [
          edge(FLOW, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
          edge(FLOW, FIELD_B, 'writesTo', 'parsed'),
        ],
      },
      COMPLETE,
      FLOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:before-save-flow-cross-record-write');
    expect(out[0]!.groundedIn).toEqual([FLOW, OBJ_A, FIELD_B]);
    expect(out[0]!.claim.toLowerCase()).toContain('before-save');
    expect(out[0]!.claim.toLowerCase()).toContain('different');
  });

  it('stays silent on same-object before-save write', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(FLOW, 'Flow', { status: 'Active', triggerType: 'RecordBeforeSave' }),
            node(OBJ_A, 'CustomObject'),
            node(FIELD_A, 'CustomField'),
          ],
          edges: [
            edge(FLOW, OBJ_A, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
            edge(FLOW, FIELD_A, 'writesTo', 'parsed'),
          ],
        },
        COMPLETE,
        FLOW,
      ),
    ).toEqual([]);
  });
});


describe('concept:profile-ip-restriction-absence (EC-11 / D7)', () => {
  const rule = ruleById('rule:access/profile-ip-restriction-absence');
  const PROFILE = 'Profile:Ns__NoIpFilter';

  it('fires on Profile with present empty loginIpRanges', () => {
    const out = interpret(
      rule,
      { nodes: [node(PROFILE, 'Profile', { loginIpRanges: [] })], edges: [] },
      COMPLETE,
      PROFILE,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:profile-ip-restriction-absence');
    expect(out[0]!.groundedIn).toEqual([PROFILE]);
    expect(out[0]!.claim.toLowerCase()).toContain('empty');
  });

  it('stays silent when loginIpRanges is non-empty or absent', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(PROFILE, 'Profile', {
              loginIpRanges: [{ startAddress: '10.0.0.1', endAddress: '10.0.0.255' }],
            }),
          ],
          edges: [],
        },
        COMPLETE,
        PROFILE,
      ),
    ).toEqual([]);
    expect(
      interpret(rule, { nodes: [node(PROFILE, 'Profile')], edges: [] }, COMPLETE, PROFILE),
    ).toEqual([]);
  });
});


describe('concept:external-owd-exceeds-internal (EC-12 / D8)', () => {
  const rule = ruleById('rule:sharing/external-owd-exceeds-internal');
  const OBJ = 'CustomObject:Ns__Deal__c';

  it('is a propertyCompare CustomObject rule (owdPermissiveness gt)', () => {
    expect(rule.bind.componentTypes).toEqual(['CustomObject']);
    expect(rule.bind.propertyCompare).toEqual({
      leftKey: 'externalSharingModel',
      rightKey: 'sharingModel',
      op: 'gt',
      rankTable: 'owdPermissiveness',
    });
    expect(rule.maxConfidence).toBe('declared');
  });

  it('fires when external is more permissive than internal', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(OBJ, 'CustomObject', {
            sharingModel: 'Private',
            externalSharingModel: 'ReadWrite',
          }),
        ],
        edges: [],
      },
      COMPLETE,
      OBJ,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([OBJ]);
    expect(out[0]!.claim.toLowerCase()).toContain('more permissive');
    expect(out[0]!.claim).toContain('ReadWrite');
    expect(out[0]!.claim).toContain('Private');
    expect(out[0]!.confidence).toBe('declared');
  });

  it('stays silent when external ≤ internal or either key is missing', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(OBJ, 'CustomObject', {
              sharingModel: 'ReadWrite',
              externalSharingModel: 'Private',
            }),
          ],
          edges: [],
        },
        COMPLETE,
        OBJ,
      ),
    ).toEqual([]);
    expect(
      interpret(
        rule,
        { nodes: [node(OBJ, 'CustomObject', { sharingModel: 'Private' })], edges: [] },
        COMPLETE,
        OBJ,
      ),
    ).toEqual([]);
  });
});


describe('concept:dependent-picklist-orphaned-value (EC-10 / C18)', () => {
  const rule = ruleById('rule:field/dependent-picklist-orphaned-value');
  const DEP = 'CustomField:Ns__Deal__c.SubType__c';
  const CTRL = 'CustomField:Ns__Deal__c.Type__c';

  it('is a fieldJoin CustomField rule with orphan set-diff', () => {
    expect(rule.bind.componentTypes).toEqual(['CustomField']);
    expect(rule.bind.whereProperty).toEqual({ key: 'controllingField', isNull: false });
    expect(rule.bind.fieldJoin).toEqual({
      nameProperty: 'controllingField',
      orphanSetDiff: {
        leftArrayKey: 'controllingFieldValues',
        leftElementKey: 'controllingFieldValue',
        rightArrayKey: 'picklistValues',
        rightElementKey: 'value',
        rightElementWhere: { key: 'isActive', equals: true },
      },
    });
    expect(rule.maxConfidence).toBe('declared');
  });

  it('fires when a referenced controlling value is missing from the sibling', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(DEP, 'CustomField', {
            controllingField: 'Type__c',
            controllingFieldValues: [
              { controllingFieldValue: 'Gone', valueName: 'Child' },
            ],
          }),
          node(CTRL, 'CustomField', {
            picklistValues: [{ value: 'Alive', isActive: true }],
          }),
        ],
        edges: [],
      },
      COMPLETE,
      DEP,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([DEP, CTRL]);
    expect(out[0]!.claim).toContain('Gone');
    expect(out[0]!.claim.toLowerCase()).toContain('unreachable');
    expect(out[0]!.confidence).toBe('declared');
  });

  it('stays silent when mappings are intact or sibling values are ungrounded', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(DEP, 'CustomField', {
              controllingField: 'Type__c',
              controllingFieldValues: [
                { controllingFieldValue: 'Alive', valueName: 'Child' },
              ],
            }),
            node(CTRL, 'CustomField', {
              picklistValues: [{ value: 'Alive', isActive: true }],
            }),
          ],
          edges: [],
        },
        COMPLETE,
        DEP,
      ),
    ).toEqual([]);
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(DEP, 'CustomField', {
              controllingField: 'Type__c',
              controllingFieldValues: [
                { controllingFieldValue: 'Gone', valueName: 'Child' },
              ],
            }),
            node(CTRL, 'CustomField'),
          ],
          edges: [],
        },
        COMPLETE,
        DEP,
      ),
    ).toEqual([]);
  });
});


describe('concept:queueable-chain-depth (EC-4 / C13)', () => {
  const rule = ruleById('rule:async-boundary/queueable-chain-depth');
  const Q1 = 'ApexClass:Ns__FirstQueueable';
  const Q2 = 'ApexClass:Ns__SecondQueueable';
  const BATCH = 'ApexClass:Ns__BatchDispatcher';

  it('fires queueable→queueable dispatchesAsync', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(Q1, 'ApexClass', { isQueueable: true }),
          node(Q2, 'ApexClass', { isQueueable: true }),
        ],
        edges: [edge(Q1, Q2, 'dispatchesAsync', 'declared', { dispatchMechanism: 'enqueueJob' })],
      },
      COMPLETE,
      Q1,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([Q1, Q2]);
    expect(out[0]!.claim.toLowerCase()).toContain('queueable');
    expect(out[0]!.confidence).toBe('declared');
  });

  it('stays silent when only the target is queueable', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(BATCH, 'ApexClass', { isBatchable: true }),
            node(Q2, 'ApexClass', { isQueueable: true }),
          ],
          edges: [edge(BATCH, Q2, 'dispatchesAsync', 'declared', { dispatchMechanism: 'enqueueJob' })],
        },
        COMPLETE,
        BATCH,
      ),
    ).toEqual([]);
  });
});


describe('concept:future-invoked-from-async-illegal (EC-4 / D1)', () => {
  const batchRule = ruleById('rule:async/future-from-batch-illegal');
  const futureRule = ruleById('rule:async/future-from-future-illegal');
  const BATCH = 'ApexClass:Ns__NightlyBatch';
  const FUTURE_CALLER = 'ApexClass:Ns__AsyncHelper';
  const FUTURE_TARGET = 'ApexClass:Ns__FutureWorker';
  const SYNC = 'ApexClass:Ns__SyncCaller';

  it('fires batch→@future', () => {
    const out = interpret(
      batchRule,
      {
        nodes: [
          node(BATCH, 'ApexClass', { isBatchable: true }),
          node(FUTURE_TARGET, 'ApexClass', { hasFutureMethod: true }),
        ],
        edges: [
          edge(BATCH, FUTURE_TARGET, 'dispatchesAsync', 'heuristic', { dispatchMechanism: 'future' }),
        ],
      },
      COMPLETE,
      BATCH,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('batch');
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('fires @future-caller→@future', () => {
    const out = interpret(
      futureRule,
      {
        nodes: [
          node(FUTURE_CALLER, 'ApexClass', { hasFutureMethod: true }),
          node(FUTURE_TARGET, 'ApexClass', { hasFutureMethod: true }),
        ],
        edges: [
          edge(FUTURE_CALLER, FUTURE_TARGET, 'dispatchesAsync', 'heuristic', {
            dispatchMechanism: 'future',
          }),
        ],
      },
      COMPLETE,
      FUTURE_CALLER,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('nested');
  });

  it('stays silent for sync caller→@future', () => {
    expect(
      interpret(
        batchRule,
        {
          nodes: [node(SYNC, 'ApexClass'), node(FUTURE_TARGET, 'ApexClass', { hasFutureMethod: true })],
          edges: [
            edge(SYNC, FUTURE_TARGET, 'dispatchesAsync', 'heuristic', { dispatchMechanism: 'future' }),
          ],
        },
        COMPLETE,
        SYNC,
      ),
    ).toEqual([]);
  });
});


describe('concept:validation-gates-on-rollup-recalculated-later (EC-4 / D2)', () => {
  const rule = ruleById('rule:automation/validation-gates-rollup-stale');
  const VR = 'ValidationRule:Ns__Parent__c.Block_When_Count_Low';
  const SUM = 'CustomField:Ns__Parent__c.ChildCount__c';
  const PLAIN = 'CustomField:Ns__Parent__c.Status__c';

  it('fires when validation references a Summary field', () => {
    const out = interpret(
      rule,
      {
        nodes: [node(VR, 'ValidationRule'), node(SUM, 'CustomField', { dataType: 'Summary' })],
        edges: [edge(VR, SUM, 'references', 'parsed')],
      },
      COMPLETE,
      VR,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.claim.toLowerCase()).toContain('pre-save');
    expect(out[0]!.groundedIn).toEqual([VR, SUM]);
  });

  it('stays silent when validation references a non-summary field', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [node(VR, 'ValidationRule'), node(PLAIN, 'CustomField')],
          edges: [edge(VR, PLAIN, 'references', 'parsed')],
        },
        COMPLETE,
        VR,
      ),
    ).toEqual([]);
  });
});

describe('concept:assignment-escalation-first-match-ordering (D10 / EC-14)', () => {
  const rule = ruleById('rule:automation/assignment-escalation-first-match-ordering');
  const RULE = 'AssignmentRule:Case.Ns__Routing';
  const CATCH = 'Queue:Ns__Default';
  const LATER = 'Queue:Ns__Priority';

  it('has the shipped firstMatchOrdinal aggregate bind (root-outgoing references)', () => {
    expect(rule.concept).toBe('concept:assignment-escalation-first-match-ordering');
    expect(rule.bind.edgeType).toBe('references');
    expect(rule.bind.aggregate?.edgeSource).toBe('root-outgoing');
    expect(rule.bind.aggregate?.countDistinctEndpoint).toBe('to');
    expect(rule.bind.aggregate?.firstMatchOrdinal?.ordinalEdgeProperty).toBe('entryIndex');
    expect(rule.bind.aggregate?.op).toBeUndefined();
  });

  it('fires on catch-all-then-specific assignment rule entries', () => {
    const out = interpret(
      rule,
      {
        nodes: [
          node(RULE, 'AssignmentRule', { active: true, ruleEntryCount: 2 }),
          node(CATCH, 'Queue'),
          node(LATER, 'Queue'),
        ],
        edges: [
          edge(RULE, CATCH, 'references', 'declared', {
            entryIndex: 0,
            criteriaItemCount: 0,
            hasFormula: false,
            assignedToType: 'Queue',
          }),
          edge(RULE, LATER, 'references', 'declared', {
            entryIndex: 1,
            criteriaItemCount: 1,
            hasFormula: false,
            assignedToType: 'Queue',
          }),
        ],
      },
      COMPLETE,
      RULE,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([RULE, CATCH, LATER]);
    expect(out[0]!.claim.toLowerCase()).toContain('top-down');
  });

  it('stays silent when all entries have criteria', () => {
    expect(
      interpret(
        rule,
        {
          nodes: [
            node(RULE, 'AssignmentRule'),
            node(CATCH, 'Queue'),
            node(LATER, 'Queue'),
          ],
          edges: [
            edge(RULE, CATCH, 'references', 'declared', {
              entryIndex: 0,
              criteriaItemCount: 1,
              hasFormula: false,
            }),
            edge(RULE, LATER, 'references', 'declared', {
              entryIndex: 1,
              criteriaItemCount: 2,
              hasFormula: false,
            }),
          ],
        },
        COMPLETE,
        RULE,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 concept-discovery batch — 10 new grounded NODE/EDGE concepts.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 2c) concept:field-longtext-richtext-not-filterable — a Long Text Area or
//     Rich Text (Html) field's dataType CLASS is not filterable / sortable /
//     groupable / indexable, so it cannot appear in a SOQL WHERE / ORDER BY /
//     GROUP BY, a list-view filter, or a report filter, and cannot be an
//     external id or unique. A NODE-shaped rule mirroring
//     rule:field-provenance/derived-read-only: it fires off a CustomField node
//     whose OWN `dataType` is in [LongTextArea, Html] (an always-present
//     extractor scalar — custom-field.ts:415), cites the field, claims the
//     query-restriction, confidence declared. It must NOT fire on a filterable
//     type (Text / Number), and componentTypes scopes it to CustomField.
// ---------------------------------------------------------------------------

describe('concept:field-longtext-richtext-not-filterable — rule:field/longtext-richtext-not-filterable', () => {
  const rule = ruleById('rule:field/longtext-richtext-not-filterable');
  const NOTES_FIELD = 'CustomField:Ns__Deal__c.Notes__c'; // dataType: LongTextArea
  const BODY_FIELD = 'CustomField:Ns__Deal__c.Body__c'; // dataType: Html (rich text)
  const NAME_TEXT_FIELD = 'CustomField:Ns__Deal__c.Name__c'; // dataType: Text → excluded

  it('ships the concept with the field-provenance kind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('field-provenance');
  });

  it('is a node-shaped CustomField rule (componentTypes + whereProperty dataType in [LongTextArea, Html], no edge, declared)', () => {
    expect(rule.concept).toBe('concept:field-longtext-richtext-not-filterable');
    expect(rule.bind.componentTypes).toEqual(['CustomField']);
    expect(rule.bind.whereProperty).toEqual({ key: 'dataType', in: ['LongTextArea', 'Html'] });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
    expect(rule.dependsOnCoverage).toEqual(['CustomField']);
  });

  it('matches a LongTextArea field, cites it, claims not-filterable, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(NOTES_FIELD, 'CustomField', { dataType: 'LongTextArea' }),
        node(NAME_TEXT_FIELD, 'CustomField', { dataType: 'Text' }), // filterable text → excluded
        node(AMOUNT_FIELD, 'CustomField', { dataType: 'Number' }), // filterable number → excluded
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:field-longtext-richtext-not-filterable');
    // EXACTLY the long-text field — not the filterable Text / Number siblings.
    expect(only.groundedIn).toEqual([NOTES_FIELD]);
    expect(only.groundedIn).toContain(NOTES_FIELD);
    expect(only.claim.toLowerCase()).toContain('not filterable, sortable, groupable');
    // A node match carries no edge confidence → the declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
  });

  it('also matches a Rich Text (Html) field — the `in` operator covers both query-hostile classes', () => {
    const slice: GroundedSlice = {
      nodes: [node(BODY_FIELD, 'CustomField', { dataType: 'Html' })],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([BODY_FIELD]);
    expect(out[0]!.confidence).toBe('declared');
  });

  it('does NOT fire on filterable field types (Text / Number) — no citation ⇒ no claim', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(NAME_TEXT_FIELD, 'CustomField', { dataType: 'Text' }),
        node(AMOUNT_FIELD, 'CustomField', { dataType: 'Number' }),
      ],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

describe('concept:duplicate-rule-bypass-sharing-match — DuplicateRule securityOption==BypassSharingRules NODE rule', () => {
  const rule = ruleById('rule:duplicate-rule/bypass-sharing-match');
  const DUP = 'DuplicateRule:Ns__Account.Ns__BypassMatch';

  it('ships the concept with the access-mechanism kind and a system-context / bypass summary', () => {
    const concept = CONCEPTS['concept:duplicate-rule-bypass-sharing-match'];
    expect(concept).toBeDefined();
    expect(concept!.kind).toBe('access-mechanism');
    const summary = concept!.summary.toLowerCase();
    expect(summary).toContain('system context');
    expect(summary).toContain('bypass sharing rules');
  });

  it('is a node-shaped DuplicateRule rule (componentTypes + SINGLE whereProperty securityOption===BypassSharingRules, no edge, declared)', () => {
    expect(rule.concept).toBe('concept:duplicate-rule-bypass-sharing-match');
    expect(rule.bind.componentTypes).toEqual(['DuplicateRule']);
    expect(Array.isArray(rule.bind.whereProperty)).toBe(false);
    expect(rule.bind.whereProperty).toEqual({ key: 'securityOption', equals: 'BypassSharingRules' });
    expect(rule.bind.edgeType).toBeUndefined();
    expect(rule.absenceShaped).toBe(false);
    expect(rule.maxConfidence).toBe('declared');
  });

  it('fires on securityOption===BypassSharingRules, cites ONLY that rule, claim system context, confidence declared', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DUP, 'DuplicateRule', {
          isActive: true,
          securityOption: 'BypassSharingRules',
          operationsOnInsert: ['Alert'],
        }),
      ],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE, DUP);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:duplicate-rule-bypass-sharing-match');
    expect(only.groundedIn).toContain(DUP);
    expect(only.confidence).toBe('declared');
    expect(only.claim).toContain(DUP);
    expect(only.claim.toLowerCase()).toContain('system context');
    expect(only.coverageCaveat).toBeNull();
  });

  it('does NOT fire on EnforceSharingRules', () => {
    const slice: GroundedSlice = {
      nodes: [node(DUP, 'DuplicateRule', { securityOption: 'EnforceSharingRules' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, DUP)).toEqual([]);
  });

  it('[type guard] a non-DuplicateRule node carrying securityOption===BypassSharingRules does NOT fire', () => {
    const oddId = 'CustomObject:Ns__Odd__c';
    const slice: GroundedSlice = {
      nodes: [node(oddId, 'CustomObject', { securityOption: 'BypassSharingRules' })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE, oddId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// concept:duplicate-rule-references-inactive-matching-rule — an ACTIVE duplicate
// rule with a `references` edge to a MatchingRule endpoint whose ruleStatus is
// NOT Active. componentTypes:[MatchingRule] scopes the counted endpoint so a
// co-parented filter-Profile reference (no ruleStatus) is never miscounted.
// ---------------------------------------------------------------------------

describe('concept:duplicate-rule-references-inactive-matching-rule — rule:duplicate-rule/references-inactive-matching-rule', () => {
  const rule = ruleById('rule:duplicate-rule/references-inactive-matching-rule');
  const DUP = 'DuplicateRule:Ns__Deal__c.Ns__BlockDupes';
  const MATCH_INACTIVE = 'MatchingRule:Ns__Deal__c.Ns__StaleMatcher';
  const MATCH_ACTIVE = 'MatchingRule:Ns__Deal__c.Ns__LiveMatcher';
  const FILTER_PROFILE = 'Profile:Ns__Integration';

  const matcherRef = (target: string): Edge =>
    edge(DUP, target, 'references', 'declared', { matcherIndex: 0, objectMappingCount: 0 });

  it('is a root-outgoing references aggregate scoped to MatchingRule endpoints with ruleStatus notIn Active', () => {
    expect(rule.bind.whereProperty).toEqual({ key: 'isActive', equals: true });
    expect(rule.bind.componentTypes).toEqual(['MatchingRule']);
    expect(rule.bind.aggregate!.edgeSource).toBe('root-outgoing');
    expect(rule.bind.aggregate!.countDistinctEndpoint).toBe('to');
    expect(rule.bind.aggregate!.endpointWhereProperty).toEqual({ key: 'ruleStatus', notIn: ['Active'] });
    expect(rule.maxConfidence).toBe('declared');
  });

  it('fires when an active duplicate rule references an inactive matching rule', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(DUP, 'DuplicateRule', { isActive: true }),
        node(MATCH_INACTIVE, 'MatchingRule', { ruleStatus: 'Inactive' }),
        // A filter-Profile endpoint on the SAME references edge type has NO
        // ruleStatus; componentTypes:[MatchingRule] excludes it, so a bare
        // notIn:[Active] endpoint clause can never miscount it.
        node(FILTER_PROFILE, 'Profile', {}),
      ],
      edges: [
        matcherRef(MATCH_INACTIVE),
        edge(DUP, FILTER_PROFILE, 'references', 'declared', { referenceKind: 'duplicateFilterProfile' }),
      ],
    };
    const out = interpret(rule, slice, COMPLETE, DUP);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:duplicate-rule-references-inactive-matching-rule');
    expect(out[0]!.groundedIn).toEqual([MATCH_INACTIVE, DUP]);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim.toLowerCase()).toContain('inactive matching rule');
  });

  it('does NOT fire when the matcher is Active or the duplicate rule is inactive', () => {
    const activeMatcher: GroundedSlice = {
      nodes: [
        node(DUP, 'DuplicateRule', { isActive: true }),
        node(MATCH_ACTIVE, 'MatchingRule', { ruleStatus: 'Active' }),
      ],
      edges: [matcherRef(MATCH_ACTIVE)],
    };
    expect(interpret(rule, activeMatcher, COMPLETE, DUP)).toEqual([]);
    const inactiveRule: GroundedSlice = {
      nodes: [
        node(DUP, 'DuplicateRule', { isActive: false }),
        node(MATCH_INACTIVE, 'MatchingRule', { ruleStatus: 'Inactive' }),
      ],
      edges: [matcherRef(MATCH_INACTIVE)],
    };
    expect(interpret(rule, inactiveRule, COMPLETE, DUP)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 concept-expansion — concept:approval-process-final-lock-record-readonly.
// TWO NODE rules on ONE concept (final-approval-lock + final-rejection-lock),
// each keying an always-present ApprovalProcess boolean (finalApprovalRecordLock
// / finalRejectionRecordLock). Fires on a lock-on-final process, cites ONLY that
// process, claims the record goes read-only until unlocked, declared confidence.
// A non-locking process fires neither; the two rules key DISJOINT booleans;
// componentTypes scopes the match to ApprovalProcess.
// ---------------------------------------------------------------------------

describe('concept:approval-process-final-lock-record-readonly — final-approval/rejection lock NODE rules', () => {
  const approvalRule = ruleById('rule:approval-process/final-approval-lock');
  const rejectionRule = ruleById('rule:approval-process/final-rejection-lock');
  const LOCK_APPROVAL = 'ApprovalProcess:Ns__Deal__c.Ns__Discount_Approval';
  const LOCK_REJECTION = 'ApprovalProcess:Ns__Deal__c.Ns__Reject_Lock_Approval';
  const NO_LOCK = 'ApprovalProcess:Ns__Deal__c.Ns__No_Lock_Approval';

  it('ships ONE concept (access-mechanism) bound by BOTH rules', () => {
    expect(approvalRule.concept).toBe('concept:approval-process-final-lock-record-readonly');
    expect(rejectionRule.concept).toBe('concept:approval-process-final-lock-record-readonly');
    expect(CONCEPTS[approvalRule.concept]).toBeDefined();
    expect(CONCEPTS[approvalRule.concept]!.kind).toBe('access-mechanism');
  });

  it('both are node-shaped ApprovalProcess rules (boolean-equals, no edge, declared)', () => {
    expect(approvalRule.bind.componentTypes).toEqual(['ApprovalProcess']);
    expect(approvalRule.bind.whereProperty).toEqual({ key: 'finalApprovalRecordLock', equals: true });
    expect(approvalRule.bind.edgeType).toBeUndefined();
    expect(approvalRule.maxConfidence).toBe('declared');
    expect(approvalRule.absenceShaped).toBe(false);
    expect(approvalRule.dependsOnCoverage).toEqual(['ApprovalProcess']);
    expect(rejectionRule.bind.componentTypes).toEqual(['ApprovalProcess']);
    expect(rejectionRule.bind.whereProperty).toEqual({ key: 'finalRejectionRecordLock', equals: true });
  });

  it('fires on a final-approval-lock process, cites ONLY it, claims a read-only lock until unlocked, declared', () => {
    const slice: GroundedSlice = {
      nodes: [node(LOCK_APPROVAL, 'ApprovalProcess', { finalApprovalRecordLock: true, finalRejectionRecordLock: false })],
      edges: [],
    };
    const out = interpret(approvalRule, slice, COMPLETE, LOCK_APPROVAL);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:approval-process-final-lock-record-readonly');
    expect(only.groundedIn).toEqual([LOCK_APPROVAL]);
    expect(only.claim).toContain(LOCK_APPROVAL);
    const lower = only.claim.toLowerCase();
    expect(lower).toContain('locks the record');
    expect(lower).toContain('read-only');
    expect(lower).toContain('entity-is-locked');
    expect(lower).toContain('does not assert whether any specific record is currently locked');
    expect(only.confidence).toBe('declared');
    expect(only.confidence).toBe(weakest('declared', 'declared'));
    expect(only.coverageCaveat).toBeNull();
    expect(only.provenance).toBe('offline_snapshot');
    expect(only.modelVersion).toBe(MODEL_VERSION);
  });

  it('the sibling rule fires on a final-rejection-lock process and claims the rejection lock', () => {
    const slice: GroundedSlice = {
      nodes: [node(LOCK_REJECTION, 'ApprovalProcess', { finalApprovalRecordLock: false, finalRejectionRecordLock: true })],
      edges: [],
    };
    const out = interpret(rejectionRule, slice, COMPLETE, LOCK_REJECTION);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toEqual([LOCK_REJECTION]);
    expect(out[0]!.claim.toLowerCase()).toContain('final rejection');
  });

  it('does NOT fire on an approval process that locks on neither (both false), nor on a bare node', () => {
    const falseSlice: GroundedSlice = {
      nodes: [node(NO_LOCK, 'ApprovalProcess', { finalApprovalRecordLock: false, finalRejectionRecordLock: false })],
      edges: [],
    };
    const bareSlice: GroundedSlice = { nodes: [node(NO_LOCK, 'ApprovalProcess', {})], edges: [] };
    expect(interpret(approvalRule, falseSlice, COMPLETE, NO_LOCK)).toEqual([]);
    expect(interpret(rejectionRule, falseSlice, COMPLETE, NO_LOCK)).toEqual([]);
    expect(interpret(approvalRule, bareSlice, COMPLETE, NO_LOCK)).toEqual([]);
  });

  it('[no cross-contamination] the two rules key DISJOINT booleans — approval-lock rule ignores a rejection-only lock and vice-versa', () => {
    const rejectionOnly: GroundedSlice = {
      nodes: [node(LOCK_REJECTION, 'ApprovalProcess', { finalApprovalRecordLock: false, finalRejectionRecordLock: true })],
      edges: [],
    };
    expect(interpret(approvalRule, rejectionOnly, COMPLETE, LOCK_REJECTION)).toEqual([]);
    const approvalOnly: GroundedSlice = {
      nodes: [node(LOCK_APPROVAL, 'ApprovalProcess', { finalApprovalRecordLock: true, finalRejectionRecordLock: false })],
      edges: [],
    };
    expect(interpret(rejectionRule, approvalOnly, COMPLETE, LOCK_APPROVAL)).toEqual([]);
  });

  it('componentTypes scopes the match: a non-ApprovalProcess node carrying finalApprovalRecordLock===true does NOT fire', () => {
    const slice: GroundedSlice = {
      nodes: [node('Flow:Ns__Odd', 'Flow', { finalApprovalRecordLock: true })],
      edges: [],
    };
    expect(interpret(approvalRule, slice, COMPLETE, 'Flow:Ns__Odd')).toEqual([]);
  });
});

describe('concept:record-type-inactive — rule:record-type/inactive', () => {
  const rule = ruleById('rule:record-type/inactive');
  const INACTIVE = 'RecordType:Ns__Deal__c.Ns__Enterprise';
  const ACTIVE = 'RecordType:Ns__Deal__c.Ns__SMB';

  it('ships the concept with the access-mechanism kind and active===false bind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
    expect(rule.bind.whereProperty).toEqual({ key: 'active', equals: false });
  });

  it('fires on active===false with a not-assignable claim, declared', () => {
    const out = interpret(
      rule,
      { nodes: [node(INACTIVE, 'RecordType', { active: false })], edges: [] },
      COMPLETE,
      INACTIVE,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(INACTIVE);
    expect(out[0]!.confidence).toBe('declared');
    const claim = out[0]!.claim.toLowerCase();
    expect(claim).toContain('inactive');
    expect(claim).toContain('cannot be assigned to new records');
    expect(claim).toContain('hidden');
  });

  it('does NOT fire on an active record type', () => {
    expect(
      interpret(rule, { nodes: [node(ACTIVE, 'RecordType', { active: true })], edges: [] }, COMPLETE, ACTIVE),
    ).toEqual([]);
  });
});


describe('concept:remote-site-setting-protocol-security-disabled — rule:integration/remote-site-protocol-security-disabled', () => {
  const rule = ruleById('rule:integration/remote-site-protocol-security-disabled');

  const INSECURE_RSS = 'RemoteSiteSetting:Ns__Legacy_Billing_API';
  const SECURE_RSS = 'RemoteSiteSetting:Ns__Stripe_API';
  const INACTIVE_INSECURE_RSS = 'RemoteSiteSetting:Ns__Retired_Endpoint';

  it('fires on an ACTIVE remote site setting with protocol security disabled, cites it, confidence declared', () => {
    // Grounded on the always-present disableProtocolSecurity + isActive booleans
    // the RemoteSiteSetting extractor emits (remote-site-setting.ts). Only the
    // active + insecure entry matches; the HTTPS entry and the inactive entry
    // are excluded.
    const slice: GroundedSlice = {
      nodes: [
        node(INSECURE_RSS, 'RemoteSiteSetting', {
          disableProtocolSecurity: true,
          isActive: true,
        }),
        node(SECURE_RSS, 'RemoteSiteSetting', {
          disableProtocolSecurity: false,
          isActive: true,
        }), // HTTPS-guarded → excluded
        node(INACTIVE_INSECURE_RSS, 'RemoteSiteSetting', {
          disableProtocolSecurity: true,
          isActive: false,
        }), // disabled entry permits no callout → excluded by the isActive guard
      ],
      edges: [],
    };

    const out = interpret(rule, slice, COMPLETE);

    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.concept).toBe('concept:remote-site-setting-protocol-security-disabled');
    // EXACTLY the active + insecure entry — not the HTTPS or inactive siblings.
    expect(only.groundedIn).toEqual([INSECURE_RSS]);
    expect(only.claim).toContain(INSECURE_RSS);
    // The distinctive answer class: cleartext HTTP allowed to the allowlisted host.
    expect(only.claim.toLowerCase()).toContain('cleartext http callouts');
    // Node match carries no edge confidence → the declared ceiling holds.
    expect(only.confidence).toBe('declared');
    expect(only.coverageCaveat).toBeNull();
  });

  it('does NOT fire when protocol security is enabled (disableProtocolSecurity===false)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(SECURE_RSS, 'RemoteSiteSetting', {
          disableProtocolSecurity: false,
          isActive: true,
        }),
      ],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('does NOT fire on an INACTIVE setting even when protocol security is disabled (the isActive guard)', () => {
    const slice: GroundedSlice = {
      nodes: [
        node(INACTIVE_INSECURE_RSS, 'RemoteSiteSetting', {
          disableProtocolSecurity: true,
          isActive: false,
        }),
      ],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 — concept:apex-intentional-system-mode-dml. A NODE anyElement rule over
// the ApexClass `qualityIssues` array (byte-identical shape to the shipped
// swallowed-exception rule). Binds the DELIBERATE AccessLevel.SYSTEM_MODE opt-out
// (recognizer rule `intentional-system-mode-dml`), NOT the accidental
// missing-crud-check omission — so it fires on its own qualityIssue and stays
// silent on the accidental sibling / an empty array.
// ---------------------------------------------------------------------------

describe('concept:apex-intentional-system-mode-dml — rule:code-quality/intentional-system-mode-dml', () => {
  const rule = ruleById('rule:code-quality/intentional-system-mode-dml');
  const CLS = 'ApexClass:Ns__SystemModeSvc';

  it('ships the concept with the access-mechanism kind and a heuristic ceiling', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
    expect(rule.maxConfidence).toBe('heuristic');
    expect(rule.bind.whereProperty).toEqual({
      key: 'qualityIssues',
      anyElement: { key: 'rule', equals: 'intentional-system-mode-dml' },
    });
  });

  it('fires on an ApexClass carrying an intentional-system-mode-dml qualityIssue, confidence heuristic', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [{ rule: 'intentional-system-mode-dml', severity: 'info' }] })],
      edges: [],
    };
    const out = interpret(rule, slice, COMPLETE);
    expect(out).toHaveLength(1);
    expect(out[0]!.concept).toBe('concept:apex-intentional-system-mode-dml');
    expect(out[0]!.groundedIn).toEqual([CLS]);
    expect(out[0]!.claim.toLowerCase()).toContain('system_mode');
    expect(out[0]!.confidence).toBe('heuristic');
  });

  it('does NOT fire on a class carrying only the ACCIDENTAL missing-crud-check qualityIssue', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [{ rule: 'missing-crud-check', severity: 'high' }] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });

  it('does NOT fire on a class with an empty qualityIssues array', () => {
    const slice: GroundedSlice = {
      nodes: [node(CLS, 'ApexClass', { qualityIssues: [] })],
      edges: [],
    };
    expect(interpret(rule, slice, COMPLETE)).toEqual([]);
  });
});

describe('concept:dataraptor-field-security-unenforced — rule:omnistudio/dataraptor-field-security-unenforced', () => {
  const rule = ruleById('rule:omnistudio/dataraptor-field-security-unenforced');
  const UNENFORCED = 'OmniDataTransform:Ns__LoadAccount';
  const ENFORCED = 'OmniDataTransform:Ns__SafeLoadContact';

  it('ships the concept with the access-mechanism kind and fieldLevelSecurityEnabled===false bind', () => {
    expect(CONCEPTS[rule.concept]).toBeDefined();
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
    expect(rule.bind.whereProperty).toEqual({ key: 'fieldLevelSecurityEnabled', equals: false });
  });

  it('fires on fieldLevelSecurityEnabled===false with an FLS-bypass claim, declared', () => {
    const out = interpret(
      rule,
      { nodes: [node(UNENFORCED, 'OmniDataTransform', { fieldLevelSecurityEnabled: false })], edges: [] },
      COMPLETE,
      UNENFORCED,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(UNENFORCED);
    expect(out[0]!.confidence).toBe('declared');
    const claim = out[0]!.claim.toLowerCase();
    expect(claim).toContain('field-level security');
    expect(claim).toContain('over-permissive data-access surface');
  });

  it('does NOT fire on a DataRaptor that enforces field-level security', () => {
    expect(
      interpret(
        rule,
        { nodes: [node(ENFORCED, 'OmniDataTransform', { fieldLevelSecurityEnabled: true })], edges: [] },
        COMPLETE,
        ENFORCED,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ARC-2 concepts-batch3 — 3 CustomField dataType concepts + 2 revived permset concepts.
// ---------------------------------------------------------------------------

describe('concept:field-classic-encrypted-text — rule:field/classic-encrypted-text', () => {
  const rule = ruleById('rule:field/classic-encrypted-text');
  const F = 'CustomField:Ns__Deal__c.Ns__X__c';
  const O = 'CustomField:Ns__Deal__c.Ns__Y__c';
  it('ships field-provenance kind + dataType bind', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('field-provenance');
    expect(rule.bind.whereProperty).toEqual({ key: 'dataType', equals: 'EncryptedText' });
  });
  it('fires on the data type with a declared claim', () => {
    const out = interpret(rule, { nodes: [node(F, 'CustomField', { dataType: 'EncryptedText' })], edges: [] }, COMPLETE, F);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(F);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim.toLowerCase()).toContain('masked');
  });
  it('does NOT fire on a different data type', () => {
    expect(interpret(rule, { nodes: [node(O, 'CustomField', { dataType: 'Text' })], edges: [] }, COMPLETE, O)).toEqual([]);
  });
});

describe('concept:field-autonumber-system-assigned-readonly — rule:field/autonumber-system-assigned-readonly', () => {
  const rule = ruleById('rule:field/autonumber-system-assigned-readonly');
  const F = 'CustomField:Ns__Deal__c.Ns__X__c';
  const O = 'CustomField:Ns__Deal__c.Ns__Y__c';
  it('ships field-provenance kind + dataType bind', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('field-provenance');
    expect(rule.bind.whereProperty).toEqual({ key: 'dataType', equals: 'AutoNumber' });
  });
  it('fires on the data type with a declared claim', () => {
    const out = interpret(rule, { nodes: [node(F, 'CustomField', { dataType: 'AutoNumber' })], edges: [] }, COMPLETE, F);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(F);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim.toLowerCase()).toContain('read-only');
  });
  it('does NOT fire on a different data type', () => {
    expect(interpret(rule, { nodes: [node(O, 'CustomField', { dataType: 'Text' })], edges: [] }, COMPLETE, O)).toEqual([]);
  });
});

describe('concept:field-multiselect-picklist-storage-semantics — rule:field/multiselect-picklist-storage', () => {
  const rule = ruleById('rule:field/multiselect-picklist-storage');
  const F = 'CustomField:Ns__Deal__c.Ns__X__c';
  const O = 'CustomField:Ns__Deal__c.Ns__Y__c';
  it('ships field-provenance kind + dataType bind', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('field-provenance');
    expect(rule.bind.whereProperty).toEqual({ key: 'dataType', equals: 'MultiselectPicklist' });
  });
  it('fires on the data type with a declared claim', () => {
    const out = interpret(rule, { nodes: [node(F, 'CustomField', { dataType: 'MultiselectPicklist' })], edges: [] }, COMPLETE, F);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(F);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim.toLowerCase()).toContain('delimited');
  });
  it('does NOT fire on a different data type', () => {
    expect(interpret(rule, { nodes: [node(O, 'CustomField', { dataType: 'Picklist' })], edges: [] }, COMPLETE, O)).toEqual([]);
  });
});

describe('concept:permission-set-license-scoped — rule:access/permission-set-license-scoped', () => {
  const rule = ruleById('rule:access/permission-set-license-scoped');
  const A = 'PermissionSet:Ns__Alpha';
  const B = 'PermissionSet:Ns__Beta';
  it('ships access-mechanism kind + expected bind', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
    expect(rule.bind.whereProperty).toEqual({ key: 'license', isNull: false });
  });
  it('fires with a declared claim', () => {
    const out = interpret(rule, { nodes: [node(A, 'PermissionSet', { license: 'Ns__SalesLicense' })], edges: [] }, COMPLETE, A);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(A);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim.toLowerCase()).toContain('license');
  });
  it('does NOT fire on the negative case', () => {
    expect(interpret(rule, { nodes: [node(B, 'PermissionSet', {})], edges: [] }, COMPLETE, B)).toEqual([]);
  });
});

describe('concept:session-based-permission-set-dormant — rule:permission-set/session-based-dormant', () => {
  const rule = ruleById('rule:permission-set/session-based-dormant');
  const A = 'PermissionSet:Ns__Alpha';
  const B = 'PermissionSet:Ns__Beta';
  it('ships access-mechanism kind + expected bind', () => {
    expect(CONCEPTS[rule.concept]!.kind).toBe('access-mechanism');
    expect(rule.bind.whereProperty).toEqual({ key: 'hasActivationRequired', equals: true });
  });
  it('fires with a declared claim', () => {
    const out = interpret(rule, { nodes: [node(A, 'PermissionSet', { hasActivationRequired: true })], edges: [] }, COMPLETE, A);
    expect(out).toHaveLength(1);
    expect(out[0]!.groundedIn).toContain(A);
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim.toLowerCase()).toContain('session');
  });
  it('does NOT fire on the negative case', () => {
    expect(interpret(rule, { nodes: [node(B, 'PermissionSet', { hasActivationRequired: false })], edges: [] }, COMPLETE, B)).toEqual([]);
  });
});
