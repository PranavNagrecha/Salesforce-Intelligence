/// <reference types="vitest/globals" />

/**
 * QA adversarial gap-hunt for `parseFlowGraph` / `parseFlowGraphSource`
 * (Wave 1, spec §4.2/§4.3). Separate file from the builder's
 * `flow-graph.test.ts` (disjoint file ownership per BUILD-PLAN.md hard
 * rules) — probes losslessness, honest-gap disclosure, and no-phantom-
 * element guarantees the builder's happy-path suite did not exercise.
 * All fixtures synthetic (Ns__Obj__c, My_Flow, My_Field__c, My_Decision,
 * Acct, Status__c) — zero org identifiers.
 */

import {
  parseFlowGraphSource,
  type Connector,
  type FlowGraphProjection,
} from '../src/flow-graph.js';

const parse = (xml: string): FlowGraphProjection => {
  const result = parseFlowGraphSource(xml);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('parse failed');
  return result.value;
};

const findConnector = (
  connectors: readonly Connector[],
  from: string,
  to: string,
  kind: Connector['kind'],
): Connector | undefined =>
  connectors.find((c) => c.from === from && c.to === to && c.kind === kind);

describe('adversarial — isGoTo never fabricates a phantom element', () => {
  it('an isGoTo connector to a name with no matching element does not add one', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>My_Decision</name>
    <rules>
      <name>Rule_A</name>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>EqualTo</operator>
        <rightValue><stringValue>x</stringValue></rightValue>
      </conditions>
      <connector>
        <targetReference>Not_A_Real_Element</targetReference>
        <isGoTo>true</isGoTo>
      </connector>
    </rules>
  </decisions>
</Flow>`;
    const graph = parse(xml);
    const c = findConnector(graph.connectors, 'My_Decision', 'Not_A_Real_Element', 'rule');
    expect(c).toBeDefined();
    expect(c!.isGoTo).toBe(true);
    // The connector graph references the name, but no FlowElement was
    // fabricated for it — connectors[] is authoritative, elements[] is not
    // padded to match.
    expect(graph.elements.some((e) => e.name === 'Not_A_Real_Element')).toBe(false);
    expect(graph.elements).toHaveLength(1); // only My_Decision itself
  });
});

describe('adversarial — all 8 KNOWN_UNMODELED_ELEMENT_KEYS surface by name', () => {
  it('waits, steps, apexPluginCalls, collectionProcessors, orchestratedStages, customErrors, recordRollbacks, transforms all land in unmodeled[]', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>Flow</processType>
  <status>Active</status>
  <waits><name>My_Wait</name></waits>
  <steps><name>My_Step</name></steps>
  <apexPluginCalls><name>My_Apex_Plugin</name></apexPluginCalls>
  <collectionProcessors><name>My_Collection_Processor</name></collectionProcessors>
  <orchestratedStages><name>My_Stage</name></orchestratedStages>
  <customErrors><name>My_Custom_Error</name></customErrors>
  <recordRollbacks><name>My_Rollback</name></recordRollbacks>
  <transforms><name>My_Transform</name></transforms>
</Flow>`;
    const graph = parse(xml);
    expect([...graph.unmodeled].sort()).toEqual(
      [
        'My_Wait',
        'My_Step',
        'My_Apex_Plugin',
        'My_Collection_Processor',
        'My_Stage',
        'My_Custom_Error',
        'My_Rollback',
        'My_Transform',
      ].sort(),
    );
    // Each gets an IDENTITY row (typed `unmodeled`, tagged with its source
    // container) so `elements[]` indexes every connector endpoint — but none
    // leaks into a MODELED detail array, which is where the body would be.
    for (const name of graph.unmodeled) {
      const row = graph.elements.find((e) => e.name === name);
      expect(row?.type).toBe('unmodeled');
      expect(typeof row?.container).toBe('string');
    }
    expect(graph.elements).toHaveLength(8);
    for (const arr of [
      graph.decisions,
      graph.assignments,
      graph.recordOps,
      graph.loops,
      graph.screens,
      graph.subflows,
      graph.actions,
    ]) {
      expect(arr).toHaveLength(0);
    }
  });
});

describe('adversarial — losslessness: multiple conditions in one rule', () => {
  it('preserves every condition in a 2-condition AND rule, none dropped', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>My_Decision</name>
    <rules>
      <name>Rule_A</name>
      <conditionLogic>1 AND 2</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>GreaterThan</operator>
        <rightValue><numberValue>5</numberValue></rightValue>
      </conditions>
      <conditions>
        <leftValueReference>$Record.Status__c</leftValueReference>
        <operator>EqualTo</operator>
        <rightValue><stringValue>Active</stringValue></rightValue>
      </conditions>
      <connector>
        <targetReference>My_Assignment</targetReference>
      </connector>
    </rules>
  </decisions>
</Flow>`;
    const graph = parse(xml);
    const rule = graph.decisions[0]!.rules[0]!;
    expect(rule.conditionLogic).toBe('1 AND 2');
    expect(rule.conditions).toHaveLength(2);
    expect(rule.conditions).toEqual([
      {
        leftValueReference: '$Record.My_Field__c',
        operator: 'GreaterThan',
        rightValue: '5',
        rightValueKind: 'literal',
      },
      {
        leftValueReference: '$Record.Status__c',
        operator: 'EqualTo',
        rightValue: 'Active',
        rightValueKind: 'literal',
      },
    ]);
  });
});

describe('adversarial — rightValueKind:null on a truly absent <rightValue>', () => {
  it('records rightValue:null, rightValueKind:null when <rightValue> is entirely missing', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>My_Decision</name>
    <rules>
      <name>Rule_A</name>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>IsNull</operator>
      </conditions>
      <connector>
        <targetReference>My_Assignment</targetReference>
      </connector>
    </rules>
  </decisions>
</Flow>`;
    const graph = parse(xml);
    const cond = graph.decisions[0]!.rules[0]!.conditions[0]!;
    expect(cond).toEqual({
      leftValueReference: '$Record.My_Field__c',
      operator: 'IsNull',
      rightValue: null,
      rightValueKind: 'null',
    });
  });
});

describe('adversarial — dead-end rule (no <connector> at all)', () => {
  it('lists the rule with connectsTo:null and emits no connector edge for it', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>My_Decision</name>
    <rules>
      <name>Rule_Dangling</name>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>EqualTo</operator>
        <rightValue><stringValue>x</stringValue></rightValue>
      </conditions>
    </rules>
  </decisions>
</Flow>`;
    const graph = parse(xml);
    const rule = graph.decisions[0]!.rules[0]!;
    expect(rule.name).toBe('Rule_Dangling');
    expect(rule.connectsTo).toBeNull();
    expect(graph.connectors.filter((c) => c.from === 'My_Decision')).toHaveLength(0);
  });
});

describe('adversarial — decision with no <defaultConnector> at all', () => {
  it('does not fabricate a default connector edge; defaultConnectorLabel stays null', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>My_Decision</name>
    <rules>
      <name>Rule_A</name>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>EqualTo</operator>
        <rightValue><stringValue>x</stringValue></rightValue>
      </conditions>
      <connector><targetReference>My_Assignment</targetReference></connector>
    </rules>
  </decisions>
</Flow>`;
    const graph = parse(xml);
    expect(graph.decisions[0]!.defaultConnectorLabel).toBeNull();
    expect(
      graph.connectors.filter((c) => c.from === 'My_Decision' && c.kind === 'default'),
    ).toHaveLength(0);
  });
});

describe('adversarial — record op with a fault connector but no primary connector', () => {
  it('emits only the fault edge; connectsTo is null, no default connector fabricated', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <recordCreates>
    <name>My_Create</name>
    <object>Ns__Obj__c</object>
    <faultConnector><targetReference>My_Fault_Screen</targetReference></faultConnector>
  </recordCreates>
</Flow>`;
    const graph = parse(xml);
    const op = graph.recordOps[0]!;
    expect(op.connectsTo).toBeNull();
    expect(op.faultConnectsTo).toBe('My_Fault_Screen');
    expect(
      graph.connectors.filter((c) => c.from === 'My_Create' && c.kind === 'default'),
    ).toHaveLength(0);
    expect(findConnector(graph.connectors, 'My_Create', 'My_Fault_Screen', 'fault')).toBeDefined();
  });
});

describe('adversarial — loop with neither branch connector present', () => {
  it('projects the loop with both connectsTo fields null, no connector edges', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <loops>
    <name>My_Loop</name>
    <collectionReference>My_Coll</collectionReference>
  </loops>
</Flow>`;
    const graph = parse(xml);
    const loop = graph.loops[0]!;
    expect(loop.nextValueConnectsTo).toBeNull();
    expect(loop.noMoreValuesConnectsTo).toBeNull();
    expect(graph.connectors.filter((c) => c.from === 'My_Loop')).toHaveLength(0);
  });
});

describe('adversarial — assignment item with no <operator> defaults to Assign, never dropped', () => {
  it('still emits the item (assignToReference + value) rather than skipping it', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <assignments>
    <name>My_Assignment</name>
    <assignmentItems>
      <assignToReference>My_Var</assignToReference>
      <value><stringValue>X</stringValue></value>
    </assignmentItems>
  </assignments>
</Flow>`;
    const graph = parse(xml);
    expect(graph.assignments[0]!.items).toEqual([
      { assignToReference: 'My_Var', operator: 'Assign', value: 'X', valueKind: 'literal' },
    ]);
  });
});

describe('adversarial — multiple elements of the same DML kind are ALL parsed', () => {
  it('parses two <recordCreates> siblings, not just the first', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <recordCreates>
    <name>My_Create_A</name>
    <object>Ns__Obj__c</object>
  </recordCreates>
  <recordCreates>
    <name>My_Create_B</name>
    <object>Ns__Other__c</object>
  </recordCreates>
</Flow>`;
    const graph = parse(xml);
    expect(graph.recordOps.map((o) => o.name).sort()).toEqual(['My_Create_A', 'My_Create_B']);
  });
});

describe('adversarial — empty self-closing <connector/> does not throw', () => {
  it('treats an empty connector as absent (no crash, connectsTo:null)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <assignments>
    <name>My_Assignment</name>
    <assignmentItems>
      <assignToReference>My_Var</assignToReference>
      <operator>Assign</operator>
      <value><stringValue>X</stringValue></value>
    </assignmentItems>
    <connector></connector>
  </assignments>
</Flow>`;
    const result = parseFlowGraphSource(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assignments[0]!.connectsTo).toBeNull();
  });
});

describe('adversarial — decision rule with no <name> does not throw', () => {
  it('falls back to an empty-string rule name rather than crashing', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>My_Decision</name>
    <rules>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>EqualTo</operator>
        <rightValue><stringValue>x</stringValue></rightValue>
      </conditions>
      <connector><targetReference>My_Assignment</targetReference></connector>
    </rules>
  </decisions>
</Flow>`;
    const result = parseFlowGraphSource(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions[0]!.rules[0]!.name).toBe('');
  });
});

describe('adversarial — a rule connector kind is never mislabeled as default', () => {
  it('a decision rule connector is ALWAYS kind:rule, never kind:default, even with one rule', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>My_Decision</name>
    <defaultConnector><targetReference>My_Default_Path</targetReference></defaultConnector>
    <rules>
      <name>Rule_Solo</name>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>EqualTo</operator>
        <rightValue><stringValue>x</stringValue></rightValue>
      </conditions>
      <connector><targetReference>My_Rule_Path</targetReference></connector>
    </rules>
  </decisions>
</Flow>`;
    const graph = parse(xml);
    expect(findConnector(graph.connectors, 'My_Decision', 'My_Rule_Path', 'rule')).toBeDefined();
    expect(findConnector(graph.connectors, 'My_Decision', 'My_Default_Path', 'default')).toBeDefined();
    // No cross-contamination: the rule edge is not ALSO emitted as default,
    // and the default edge is not ALSO emitted as rule.
    expect(findConnector(graph.connectors, 'My_Decision', 'My_Rule_Path', 'default')).toBeUndefined();
    expect(findConnector(graph.connectors, 'My_Decision', 'My_Default_Path', 'rule')).toBeUndefined();
    expect(graph.connectors.filter((c) => c.from === 'My_Decision')).toHaveLength(2);
  });
});
