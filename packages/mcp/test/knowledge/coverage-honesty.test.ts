/// <reference types="vitest/globals" />

/**
 * COVERAGE HONESTY — every claim the engine emits over a slice it could NOT
 * fully see must SAY SO.
 *
 * The defect these tests pin (measured on a real vault): the ONLY route to a
 * non-null `coverageCaveat` in the scalar `interpretRaw` path was gated on
 * `rule.absenceShaped`. The condition that actually matters is TRUNCATION /
 * incomplete coverage. So a PRESENCE-shaped ENUMERATIVE claim computed over a
 * truncated graph slice kept its full `weakest(...)` confidence — `declared` —
 * and `coverageCaveat: null`. Three rules over the SAME truncated slice in ONE
 * real run:
 *
 *   declared | cites 807 | access/field-fls-readable-grant                | caveat=null
 *   declared | cites 641 | access/field-fls-editable-grant                | caveat=null
 *   unknown  | cites   2 | access/crud-fls-field-edit-without-object-edit | caveat="coverage is partial …"
 *
 * Ground truth on that anchor: readable=2,659 / editable=2,123. It reported
 * 807 / 641 at DECLARED confidence with no caveat — 81 of 285 parent objects
 * dropped WHOLLY, the enumeration stopping mid-alphabet. An admin asking "does
 * this profile grant read on <late-alphabet field>?" gets an enumerated set
 * that omits it and concludes NO. That is a WRONG ANSWER about access control.
 *
 * The invariant, stated once: a claim emitted under non-`complete` coverage
 *   1. carries the caller's `coverageCaveat` — regardless of rule SHAPE;
 *   2. is NOT `declared` (a truncated enumeration may not be asserted at the
 *      tier that means "this is what Salesforce returned, in full");
 *   3. discloses in the CLAIM TEXT that the cited set is a FLOOR, so a host
 *      that folds only `claim` into its answer cannot lose the disclosure;
 *   4. and — the other half of the product thesis — an ABSENCE-shaped rule's
 *      existing `unknown` + "not checked" treatment does NOT regress into a
 *      confident presence claim.
 */

import type { ConceptRule, ConfidenceLevel, Edge, Node } from '@sf-intelligence/contracts';

import { CONCEPT_RULES } from '../../src/knowledge/loader.js';
import { interpret, type Coverage, type GroundedSlice } from '../../src/knowledge/reason.js';

// ---------------------------------------------------------------------------
// Synthetic fixtures — no real org data.
// ---------------------------------------------------------------------------

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
): Edge => ({ fromId, toId, edgeType, confidence, source: 'synthetic-test', properties });

const COMPLETE: Coverage = { status: 'complete', caveat: null };
/** Exactly the caveat `adaptCoverage` emits for a hub-capped slice. */
const TRUNCATED: Coverage = {
  status: 'partial',
  caveat: 'coverage is partial — graph slice truncated at the hub cap.',
};
const UNKNOWN: Coverage = {
  status: 'unknown',
  caveat: 'coverage is unknown — CustomField not fully modeled.',
};

const ruleById = (id: string): ConceptRule => {
  const rule = CONCEPT_RULES.find((r) => r.id === id);
  if (rule === undefined) throw new Error(`missing shipped rule ${id}`);
  return rule;
};

// The measured anchor, in miniature: one field, three grantors.
const FIELD = 'CustomField:Ns__Deal__c.Ns__Secret__c';
const PS_A = 'PermissionSet:Ns__ReaderA';
const PS_B = 'PermissionSet:Ns__ReaderB';
const PROFILE = 'Profile:Ns__Support';

const flsSlice = (confidence: ConfidenceLevel = 'declared'): GroundedSlice => ({
  nodes: [
    node(FIELD, 'CustomField'),
    node(PS_A, 'PermissionSet'),
    node(PS_B, 'PermissionSet'),
    node(PROFILE, 'Profile'),
  ],
  edges: [
    edge(PS_A, FIELD, 'grantedBy', confidence, { readable: true, editable: false }),
    edge(PS_B, FIELD, 'grantedBy', confidence, { readable: true, editable: true }),
    edge(PROFILE, FIELD, 'grantedBy', confidence, { readable: true, editable: false }),
  ],
});

// ---------------------------------------------------------------------------
// 1. The measured defect — a shipped, PRESENCE-shaped, ENUMERATIVE access rule.
// ---------------------------------------------------------------------------

describe('coverage honesty — presence-shaped enumerative claim over a TRUNCATED slice', () => {
  const READ_RULE = ruleById('rule:access/field-fls-readable-grant');

  it('guard: the rule really is presence-shaped and declared-max (so the caveat cannot come from absence)', () => {
    expect(READ_RULE.absenceShaped).toBe(false);
    expect(READ_RULE.maxConfidence).toBe('declared');
  });

  it('carries the coverage caveat — the disclosure is NOT gated on rule shape', () => {
    const out = interpret(READ_RULE, flsSlice(), TRUNCATED, FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.coverageCaveat).toBe(TRUNCATED.caveat);
  });

  it('is NOT `declared` — a truncated enumeration may not be asserted at the full-fidelity tier', () => {
    const out = interpret(READ_RULE, flsSlice(), TRUNCATED, FIELD);
    expect(out[0]!.confidence).not.toBe('declared');
  });

  it('is not `unknown` either — the cited grants WERE observed; absence must stay distinguishable from ignorance', () => {
    const out = interpret(READ_RULE, flsSlice(), TRUNCATED, FIELD);
    expect(out[0]!.confidence).not.toBe('unknown');
    // The claim is KEPT: every cited grantor is still named.
    expect(out[0]!.claim).toContain(PS_A);
    expect(out[0]!.claim).toContain(PS_B);
    expect(out[0]!.claim).toContain(PROFILE);
    // Match order, verbatim — the citation is not reordered by the disclosure.
    expect(out[0]!.groundedIn).toEqual([PS_A, FIELD, PS_B, PROFILE]);
  });

  it('discloses in the CLAIM TEXT that the cited set is a FLOOR, not the whole set', () => {
    const out = interpret(READ_RULE, flsSlice(), TRUNCATED, FIELD);
    const claim = out[0]!.claim;
    expect(claim).toContain('COVERAGE FLOOR');
    expect(claim.toLowerCase()).toContain('not the complete set');
    // An id absent from the citation is NOT evidence it does not exist.
    expect(claim.toLowerCase()).toContain('missing');
  });

  it('the same holds under UNKNOWN coverage (a family was never retrieved), not just truncation', () => {
    const out = interpret(READ_RULE, flsSlice(), UNKNOWN, FIELD);
    expect(out[0]!.coverageCaveat).toBe(UNKNOWN.caveat);
    expect(out[0]!.confidence).not.toBe('declared');
    expect(out[0]!.claim).toContain('COVERAGE FLOOR');
  });

  it('CONTROL — under COMPLETE coverage the interpretation is byte-identical to today', () => {
    const out = interpret(READ_RULE, flsSlice(), COMPLETE, FIELD);
    expect(out).toHaveLength(1);
    expect(out[0]!.coverageCaveat).toBeNull();
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim).not.toContain('COVERAGE FLOOR');
  });

  it('the cap is a CAP, never a floor-raise: a heuristic-grounded claim stays heuristic', () => {
    const out = interpret(READ_RULE, flsSlice('heuristic'), TRUNCATED, FIELD);
    expect(out[0]!.confidence).toBe('heuristic');
  });
});

// ---------------------------------------------------------------------------
// 2. NO REGRESSION on the absence side — the half that already worked.
// ---------------------------------------------------------------------------

describe('coverage honesty — absence-shaped rules must NOT regress', () => {
  const absenceRule: ConceptRule = {
    id: 'rule-no-flow-reads',
    concept: 'field-provenance',
    bind: { edgeType: 'readsFrom', componentTypes: ['Flow'] },
    interpretation: 'no flow reads this field',
    maxConfidence: 'declared',
    absenceShaped: true,
    dependsOnCoverage: ['Flow'],
  };
  const emptySlice: GroundedSlice = { nodes: [node(FIELD, 'CustomField')], edges: [] };

  it('stays `unknown` + "not checked" + caveat under partial coverage — never a capped presence claim', () => {
    const out = interpret(absenceRule, emptySlice, TRUNCATED, FIELD);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.confidence).toBe('unknown');
    expect(only.coverageCaveat).toBe(TRUNCATED.caveat);
    expect(only.claim.toLowerCase()).toContain('not checked');
    expect(only.claim.toLowerCase()).not.toContain('no flow reads this field');
    // "not checked" is IGNORANCE, not a floor over observed evidence — the
    // presence-claim floor language must not be pasted onto it.
    expect(only.claim).not.toContain('COVERAGE FLOOR');
  });

  it('still emits its confident absence claim under COMPLETE coverage', () => {
    const out = interpret(absenceRule, emptySlice, COMPLETE, FIELD);
    expect(out[0]!.claim).toBe('no flow reads this field');
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.coverageCaveat).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The invariant is SHAPE-INDEPENDENT — it must hold on every emit path, not
//    just the scalar one. A JOIN rule's emit hardcoded `coverageCaveat: null`
//    and never even received the coverage.
// ---------------------------------------------------------------------------

describe('coverage honesty — every emit shape, not just the scalar one', () => {
  // Real-shape ids: the object segment parses out of `Type:Object.…` (the join
  // is `sameObject`-scoped, so the firer must carry an object segment).
  const FIRER = 'WorkflowRule:Ns__Obj__c.Gate_Rule';
  const CC = 'ConditionalContext:WorkflowRule:Ns__Obj__c.Gate_Rule.condition-0';
  const GATED = 'CustomField:Ns__Obj__c.Ns__Gated__c';
  const WRITER = 'Flow:Ns__Obj_Writer';

  const joinRule: ConceptRule = {
    id: 'rule:automation/coupled-field-write',
    concept: 'automation-collision',
    bind: {
      edgeType: 'firesWhen',
      componentTypes: ['WorkflowRule', 'Flow'],
      join: {
        throughType: 'ConditionalContext',
        throughConditionKinds: ['criteria'],
        throughKeyArray: 'fieldRefs',
        writeEdgeType: 'writesTo',
        writerTypes: ['Flow'],
        sameObject: true,
        excludeSelf: true,
      },
    },
    interpretation: "Automation {0}'s firing condition tests {1}, which automation {2} also writes.",
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: ['Flow', 'WorkflowRule'],
  };

  const joinSlice: GroundedSlice = {
    nodes: [
      node(FIRER, 'WorkflowRule'),
      node(CC, 'ConditionalContext', { kind: 'criteria', fieldRefs: [GATED] }),
      node(GATED, 'CustomField'),
      node(WRITER, 'Flow'),
    ],
    edges: [
      edge(FIRER, CC, 'firesWhen', 'declared', { kind: 'criteria' }),
      edge(WRITER, GATED, 'writesTo', 'declared'),
    ],
  };

  it('JOIN emit under partial coverage carries the caveat and is not declared', () => {
    const out = interpret(joinRule, joinSlice, TRUNCATED, FIRER);
    expect(out).toHaveLength(1);
    expect(out[0]!.coverageCaveat).toBe(TRUNCATED.caveat);
    expect(out[0]!.confidence).not.toBe('declared');
    expect(out[0]!.claim).toContain('COVERAGE FLOOR');
  });

  it('JOIN emit under COMPLETE coverage is unchanged', () => {
    const out = interpret(joinRule, joinSlice, COMPLETE, FIRER);
    expect(out[0]!.coverageCaveat).toBeNull();
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim).not.toContain('COVERAGE FLOOR');
  });

  const OBJ = 'CustomObject:Ns__Deal__c';
  const FLOW_A = 'Flow:Ns__Before_A';
  const FLOW_B = 'Flow:Ns__Before_B';
  const aggRule: ConceptRule = {
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
    interpretation: '{object} runs {count} active record-triggered flows ({timing}): {ids}.',
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: ['Flow'],
  };
  const aggSlice: GroundedSlice = {
    nodes: [
      node(OBJ, 'CustomObject'),
      node(FLOW_A, 'Flow', { status: 'Active' }),
      node(FLOW_B, 'Flow', { status: 'Active' }),
    ],
    edges: [
      edge(FLOW_A, OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
      edge(FLOW_B, OBJ, 'triggersOn', 'declared', { triggerType: 'RecordBeforeSave' }),
    ],
  };

  it('AGGREGATE count under partial coverage is an UNDER-count — caveat kept, and no longer declared', () => {
    const out = interpret(aggRule, aggSlice, TRUNCATED, OBJ);
    expect(out).toHaveLength(1);
    // Pre-existing behaviour that must be preserved.
    expect(out[0]!.coverageCaveat).toBe(TRUNCATED.caveat);
    // New: a count read off a clipped slice is a floor, so it is not `declared`.
    expect(out[0]!.confidence).not.toBe('declared');
    expect(out[0]!.claim).toContain('COVERAGE FLOOR');
  });

  it('AGGREGATE count under COMPLETE coverage is unchanged', () => {
    const out = interpret(aggRule, aggSlice, COMPLETE, OBJ);
    expect(out[0]!.coverageCaveat).toBeNull();
    expect(out[0]!.confidence).toBe('declared');
    expect(out[0]!.claim).not.toContain('COVERAGE FLOOR');
  });
});

// ---------------------------------------------------------------------------
// 4. A remediation may never read STRONGER than the finding it fixes.
// ---------------------------------------------------------------------------

describe('coverage honesty — remediation inherits the capped confidence', () => {
  const remediatedRule: ConceptRule = {
    id: 'rule-remediated',
    concept: 'field-provenance',
    bind: { edgeType: 'writesTo' },
    interpretation: 'writers: {ids}',
    maxConfidence: 'declared',
    absenceShaped: false,
    dependsOnCoverage: ['ApexClass'],
    remediation: { steps: ['Review {0}.'] },
  };
  const slice: GroundedSlice = {
    nodes: [node('ApexClass:Ns__H', 'ApexClass'), node(FIELD, 'CustomField')],
    edges: [edge('ApexClass:Ns__H', FIELD, 'writesTo', 'declared')],
  };

  it('the fix carries the SAME (capped) confidence as the claim under partial coverage', () => {
    const out = interpret(remediatedRule, slice, TRUNCATED, FIELD);
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.confidence).not.toBe('declared');
    expect(only.remediation).toBeDefined();
    expect(only.remediation!.confidence).toBe(only.confidence);
  });

  it('CONTROL — under complete coverage the fix still reads declared', () => {
    const out = interpret(remediatedRule, slice, COMPLETE, FIELD);
    expect(out[0]!.remediation!.confidence).toBe('declared');
  });
});
