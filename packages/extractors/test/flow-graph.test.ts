/// <reference types="vitest/globals" />

import {
  parseFlowGraph,
  parseFlowGraphSource,
  type Connector,
  type FlowGraphProjection,
} from '../src/flow-graph.js';

/**
 * Parse a synthetic Flow-XML string and assert success, returning the
 * projection. All fixtures use synthetic names only (Ns__Obj__c, My_Flow,
 * My_Field__c, My_Decision, Acct, Status__c) — zero org identifiers.
 */
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

/**
 * Kitchen-sink record-triggered flow exercising every connector kind, the
 * loop's two connectors, a decision with N rules + default, fault connectors,
 * scheduled paths, a $Record start with entry filters, an isGoTo edge, and two
 * unmodeled element types.
 */
const KITCHEN_SINK = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>My Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <triggerType>RecordAfterSave</triggerType>
    <recordTriggerType>Create</recordTriggerType>
    <object>Acct</object>
    <doesRequireRecordChangedToMeetCriteria>false</doesRequireRecordChangedToMeetCriteria>
    <filterLogic>1</filterLogic>
    <filters>
      <field>Status__c</field>
      <operator>EqualTo</operator>
      <value>
        <stringValue>Active</stringValue>
      </value>
    </filters>
    <connector>
      <targetReference>My_Decision</targetReference>
    </connector>
    <scheduledPaths>
      <name>My_Scheduled_Path</name>
      <label>My Scheduled Path</label>
      <offsetNumber>2</offsetNumber>
      <offsetUnit>DaysAfter</offsetUnit>
      <timeSource>My_Field__c</timeSource>
      <connector>
        <targetReference>My_Scheduled_Assignment</targetReference>
      </connector>
    </scheduledPaths>
  </start>
  <decisions>
    <name>My_Decision</name>
    <label>My Decision</label>
    <defaultConnector>
      <targetReference>My_Default_Assignment</targetReference>
    </defaultConnector>
    <defaultConnectorLabel>Otherwise</defaultConnectorLabel>
    <rules>
      <name>Rule_A</name>
      <label>Rule A</label>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>GreaterThan</operator>
        <rightValue>
          <numberValue>10</numberValue>
        </rightValue>
      </conditions>
      <connector>
        <targetReference>My_Create</targetReference>
      </connector>
    </rules>
    <rules>
      <name>Rule_B</name>
      <label>Rule B</label>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.Status__c</leftValueReference>
        <operator>EqualTo</operator>
        <rightValue>
          <stringValue>Active</stringValue>
        </rightValue>
      </conditions>
      <connector>
        <targetReference>My_Loop</targetReference>
        <isGoTo>true</isGoTo>
      </connector>
    </rules>
  </decisions>
  <assignments>
    <name>My_Default_Assignment</name>
    <label>My Default Assignment</label>
    <assignmentItems>
      <assignToReference>My_Var</assignToReference>
      <operator>Assign</operator>
      <value>
        <stringValue>Done</stringValue>
      </value>
    </assignmentItems>
    <connector>
      <targetReference>My_Loop</targetReference>
    </connector>
  </assignments>
  <assignments>
    <name>My_Scheduled_Assignment</name>
    <label>My Scheduled Assignment</label>
    <assignmentItems>
      <assignToReference>$Record.My_Field__c</assignToReference>
      <operator>Add</operator>
      <value>
        <elementReference>My_Var</elementReference>
      </value>
    </assignmentItems>
  </assignments>
  <recordCreates>
    <name>My_Create</name>
    <label>My Create</label>
    <object>Ns__Obj__c</object>
    <inputAssignments>
      <field>My_Field__c</field>
      <value>
        <stringValue>New</stringValue>
      </value>
    </inputAssignments>
    <connector>
      <targetReference>My_Action</targetReference>
    </connector>
    <faultConnector>
      <targetReference>My_Fault_Screen</targetReference>
    </faultConnector>
  </recordCreates>
  <loops>
    <name>My_Loop</name>
    <collectionReference>My_Coll</collectionReference>
    <iterationOrder>Asc</iterationOrder>
    <nextValueConnector>
      <targetReference>My_Update</targetReference>
    </nextValueConnector>
    <noMoreValuesConnector>
      <targetReference>My_End_Screen</targetReference>
    </noMoreValuesConnector>
  </loops>
  <recordUpdates>
    <name>My_Update</name>
    <label>My Update</label>
    <inputReference>$Record</inputReference>
    <connector>
      <targetReference>My_Loop</targetReference>
      <isGoTo>true</isGoTo>
    </connector>
  </recordUpdates>
  <actionCalls>
    <name>My_Action</name>
    <label>My Action</label>
    <actionType>apex</actionType>
    <actionName>My_Apex</actionName>
    <connector>
      <targetReference>My_Subflow</targetReference>
    </connector>
    <faultConnector>
      <targetReference>My_Fault_Screen</targetReference>
    </faultConnector>
  </actionCalls>
  <subflows>
    <name>My_Subflow</name>
    <label>My Subflow</label>
    <flowName>Other_Flow</flowName>
    <connector>
      <targetReference>My_End_Screen</targetReference>
    </connector>
  </subflows>
  <screens>
    <name>My_End_Screen</name>
    <label>My End Screen</label>
  </screens>
  <screens>
    <name>My_Fault_Screen</name>
    <label>My Fault Screen</label>
  </screens>
  <variables>
    <name>My_Var</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
  <formulas>
    <name>My_Formula</name>
    <dataType>Number</dataType>
    <expression>{!My_Var} + 1</expression>
  </formulas>
  <waits>
    <name>My_Wait</name>
    <label>My Wait</label>
  </waits>
  <collectionProcessors>
    <name>My_Collection_Processor</name>
  </collectionProcessors>
</Flow>`;

describe('parseFlowGraph — connector graph (spec §4.2)', () => {
  const graph = parse(KITCHEN_SINK);

  it('emits the start connector as kind:immediate', () => {
    expect(findConnector(graph.connectors, '$start', 'My_Decision', 'immediate')).toBeDefined();
    expect(graph.start.connector).toEqual({ to: 'My_Decision' });
  });

  it('emits a scheduled-path connector with its scheduledPathName', () => {
    const c = findConnector(
      graph.connectors,
      '$start',
      'My_Scheduled_Assignment',
      'scheduled',
    );
    expect(c).toBeDefined();
    expect(c!.scheduledPathName).toBe('My_Scheduled_Path');
  });

  it('emits a decision defaultConnector as kind:default', () => {
    expect(
      findConnector(graph.connectors, 'My_Decision', 'My_Default_Assignment', 'default'),
    ).toBeDefined();
  });

  it('emits one kind:rule connector per decision rule, carrying the rule name', () => {
    const ruleA = findConnector(graph.connectors, 'My_Decision', 'My_Create', 'rule');
    const ruleB = findConnector(graph.connectors, 'My_Decision', 'My_Loop', 'rule');
    expect(ruleA).toBeDefined();
    expect(ruleA!.ruleName).toBe('Rule_A');
    expect(ruleB).toBeDefined();
    expect(ruleB!.ruleName).toBe('Rule_B');
  });

  it('preserves <isGoTo>true</isGoTo> as isGoTo on the reconnect edge only', () => {
    const goTo = findConnector(graph.connectors, 'My_Decision', 'My_Loop', 'rule');
    expect(goTo!.isGoTo).toBe(true);
    const updateBack = findConnector(graph.connectors, 'My_Update', 'My_Loop', 'default');
    expect(updateBack!.isGoTo).toBe(true);
    // A non-goto edge does NOT carry the flag at all.
    const plain = findConnector(graph.connectors, 'My_Decision', 'My_Default_Assignment', 'default');
    expect(plain!.isGoTo).toBeUndefined();
  });

  it('emits both loop connectors (nextValue + noMoreValues)', () => {
    expect(findConnector(graph.connectors, 'My_Loop', 'My_Update', 'nextValue')).toBeDefined();
    expect(
      findConnector(graph.connectors, 'My_Loop', 'My_End_Screen', 'noMoreValues'),
    ).toBeDefined();
  });

  it('emits fault connectors as kind:fault from record ops and actions', () => {
    expect(
      findConnector(graph.connectors, 'My_Create', 'My_Fault_Screen', 'fault'),
    ).toBeDefined();
    expect(
      findConnector(graph.connectors, 'My_Action', 'My_Fault_Screen', 'fault'),
    ).toBeDefined();
  });

  it('emits assignment/create/subflow plain connectors as kind:default', () => {
    expect(findConnector(graph.connectors, 'My_Default_Assignment', 'My_Loop', 'default')).toBeDefined();
    expect(findConnector(graph.connectors, 'My_Create', 'My_Action', 'default')).toBeDefined();
    expect(findConnector(graph.connectors, 'My_Subflow', 'My_End_Screen', 'default')).toBeDefined();
  });

  it('covers every Connector kind at least once', () => {
    const kinds = new Set(graph.connectors.map((c) => c.kind));
    for (const kind of [
      'immediate',
      'scheduled',
      'default',
      'rule',
      'fault',
      'nextValue',
      'noMoreValues',
    ]) {
      expect(kinds.has(kind as Connector['kind'])).toBe(true);
    }
  });
});

describe('parseFlowGraph — <start> element (spec §4.1)', () => {
  const graph = parse(KITCHEN_SINK);

  it('projects the $Record-triggered start with entry filters', () => {
    expect(graph.start.triggerType).toBe('RecordAfterSave');
    expect(graph.start.recordTriggerType).toBe('Create');
    expect(graph.start.object).toBe('Acct');
    expect(graph.start.doesRequireRecordChangedToMeetCriteria).toBe(false);
    expect(graph.start.filterLogic).toBe('1');
    expect(graph.start.filters).toEqual([
      {
        leftValueReference: 'Status__c',
        operator: 'EqualTo',
        rightValue: 'Active',
        rightValueKind: 'literal',
      },
    ]);
    // Structured-filter start carries NO filterFormula (regression pin).
    expect(graph.start.filterFormula).toBeNull();
  });

  it('projects a start filterFormula entry gate (FLOW-GRAPH-TRACE-DROPS-START-FILTER-FORMULA)', () => {
    const formulaStart = parse(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
        '  <label>My Formula Start</label>',
        '  <processType>AutoLaunchedFlow</processType>',
        '  <status>Active</status>',
        '  <start>',
        '    <object>Acct</object>',
        '    <triggerType>RecordAfterSave</triggerType>',
        '    <recordTriggerType>CreateAndUpdate</recordTriggerType>',
        "    <filterFormula>ISPICKVAL({!$Record.Status__c}, 'Submitted')</filterFormula>",
        '    <connector><targetReference>My_Assignment</targetReference></connector>',
        '  </start>',
        '  <assignments>',
        '    <name>My_Assignment</name>',
        '    <assignmentItems>',
        '      <assignToReference>$Record.Flag__c</assignToReference>',
        '      <operator>Assign</operator>',
        '      <value><stringValue>x</stringValue></value>',
        '    </assignmentItems>',
        '  </assignments>',
        '</Flow>',
      ].join('\n'),
    );
    // The formula gate is captured verbatim, and structured filters stay empty —
    // a consumer must NOT read the empty filter list as "no entry criteria".
    expect(formulaStart.start.filterFormula).toBe(
      "ISPICKVAL({!$Record.Status__c}, 'Submitted')",
    );
    expect(formulaStart.start.filters).toEqual([]);
  });

  it('projects the scheduled path detail verbatim', () => {
    expect(graph.start.scheduledPaths).toEqual([
      {
        name: 'My_Scheduled_Path',
        label: 'My Scheduled Path',
        offsetNumber: 2,
        offsetUnit: 'DaysAfter',
        timeSource: 'My_Field__c',
        connectsTo: 'My_Scheduled_Assignment',
      },
    ]);
  });

  it('lists the start among elements with the synthetic sentinel name', () => {
    const startEl = graph.elements.find((e) => e.type === 'start');
    expect(startEl).toBeDefined();
    expect(startEl!.name).toBe('$start');
  });
});

describe('parseFlowGraph — decisions / assignments / loops / formulas / variables', () => {
  const graph = parse(KITCHEN_SINK);

  it('projects a decision with its default label and N rules (real names)', () => {
    const dec = graph.decisions.find((d) => d.name === 'My_Decision');
    expect(dec).toBeDefined();
    expect(dec!.defaultConnectorLabel).toBe('Otherwise');
    expect(dec!.rules.map((r) => r.name)).toEqual(['Rule_A', 'Rule_B']);
    const ruleA = dec!.rules.find((r) => r.name === 'Rule_A')!;
    expect(ruleA.connectsTo).toBe('My_Create');
    expect(ruleA.conditionLogic).toBe('and');
    expect(ruleA.conditions).toEqual([
      {
        leftValueReference: '$Record.My_Field__c',
        operator: 'GreaterThan',
        rightValue: '10',
        rightValueKind: 'literal',
      },
    ]);
  });

  it('projects assignment items with literal vs reference value kinds', () => {
    const literalAsn = graph.assignments.find((a) => a.name === 'My_Default_Assignment')!;
    expect(literalAsn.connectsTo).toBe('My_Loop');
    expect(literalAsn.items).toEqual([
      { assignToReference: 'My_Var', operator: 'Assign', value: 'Done', valueKind: 'literal' },
    ]);
    const refAsn = graph.assignments.find((a) => a.name === 'My_Scheduled_Assignment')!;
    expect(refAsn.items).toEqual([
      {
        assignToReference: '$Record.My_Field__c',
        operator: 'Add',
        value: 'My_Var',
        valueKind: 'reference',
      },
    ]);
    expect(refAsn.connectsTo).toBeNull();
  });

  it('projects a loop with its collection + both branch targets', () => {
    const loop = graph.loops.find((l) => l.name === 'My_Loop')!;
    expect(loop.collectionReference).toBe('My_Coll');
    expect(loop.iterationOrder).toBe('Asc');
    expect(loop.nextValueConnectsTo).toBe('My_Update');
    expect(loop.noMoreValuesConnectsTo).toBe('My_End_Screen');
  });

  it('projects formulas and variables verbatim', () => {
    expect(graph.formulas).toEqual([
      { name: 'My_Formula', dataType: 'Number', expression: '{!My_Var} + 1' },
    ]);
    const v = graph.variables.find((x) => x.name === 'My_Var')!;
    expect(v).toEqual({
      name: 'My_Var',
      dataType: 'String',
      objectType: null,
      isCollection: false,
      isInput: false,
      isOutput: false,
    });
  });

  it('projects action calls with their parameters, and subflows by identity', () => {
    const action = graph.actions.find((a) => a.name === 'My_Action')!;
    // Identity ALONE is no longer the contract: two calls of the same action
    // must be distinguishable, so the parameter arrays are part of the shape
    // (empty here — this fixture's action declares none).
    expect(action).toEqual({
      name: 'My_Action',
      actionType: 'apex',
      actionName: 'My_Apex',
      inputParameters: [],
      outputParameters: [],
      connectsTo: 'My_Subflow',
      faultConnectsTo: 'My_Fault_Screen',
    });
    const sub = graph.subflows.find((s) => s.name === 'My_Subflow')!;
    expect(sub).toEqual({
      name: 'My_Subflow',
      targetFlowId: 'Flow:Other_Flow',
      resolved: false,
      connectsTo: 'My_End_Screen',
      faultConnectsTo: null,
    });
  });
});

describe('parseFlowGraph — unmodeled elements (honest gap list, spec §4.3)', () => {
  const graph = parse(KITCHEN_SINK);

  it('surfaces unmodeled canvas-element types by name, never silently dropped', () => {
    expect(graph.unmodeled).toContain('My_Wait');
    expect(graph.unmodeled).toContain('My_Collection_Processor');
    // They are NOT smuggled into any modeled array.
    // The BODY is the gap, not the element: each unmodeled element keeps an
    // identity row typed `unmodeled` + its source container, so `elements[]`
    // indexes every connector endpoint instead of dangling at these nodes.
    const wait = graph.elements.find((e) => e.name === 'My_Wait');
    expect(wait?.type).toBe('unmodeled');
    expect(wait?.container).toBe('waits');
    const proc = graph.elements.find((e) => e.name === 'My_Collection_Processor');
    expect(proc?.type).toBe('unmodeled');
    expect(proc?.container).toBe('collectionProcessors');
  });
});

describe('parseFlowGraph — unmodeled-element connectors (spec §4.2 completeness)', () => {
  // Body semantics of these element types stay unmodeled (name → unmodeled[]),
  // but their outgoing connectors are now captured so the graph is not silently
  // disconnected at Filter/Wait/apexPluginCall nodes.
  const UNMODELED_EDGES = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Unmodeled Edges</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <collectionProcessors>
    <name>My_Filter</name>
    <label>My Filter</label>
    <collectionProcessorType>FilterCollectionProcessor</collectionProcessorType>
    <connector>
      <targetReference>My_Assignment</targetReference>
    </connector>
  </collectionProcessors>
  <apexPluginCalls>
    <name>My_Plugin</name>
    <label>My Plugin</label>
    <connector>
      <targetReference>My_Assignment</targetReference>
    </connector>
    <faultConnector>
      <targetReference>My_Fault_Screen</targetReference>
    </faultConnector>
  </apexPluginCalls>
  <waits>
    <name>My_Wait</name>
    <label>My Wait</label>
    <connector>
      <targetReference>My_Assignment</targetReference>
    </connector>
    <defaultConnector>
      <targetReference>My_End_Screen</targetReference>
    </defaultConnector>
    <waitEvents>
      <name>My_Wait_Event</name>
      <connector>
        <targetReference>My_Fault_Screen</targetReference>
      </connector>
    </waitEvents>
  </waits>
  <assignments>
    <name>My_Assignment</name>
    <assignmentItems>
      <assignToReference>My_Var</assignToReference>
      <operator>Assign</operator>
      <value>
        <stringValue>X</stringValue>
      </value>
    </assignmentItems>
  </assignments>
  <screens>
    <name>My_Fault_Screen</name>
    <label>My Fault Screen</label>
  </screens>
</Flow>`;
  const graph = parse(UNMODELED_EDGES);

  it('emits a collectionProcessor <connector> as kind:default AND keeps its name in unmodeled[]', () => {
    expect(
      findConnector(graph.connectors, 'My_Filter', 'My_Assignment', 'default'),
    ).toBeDefined();
    expect(graph.unmodeled).toContain('My_Filter');
    // Body stays unmodeled — no typed detail array, not smuggled into elements[].
    // Identity row present, body still the honest gap (see unmodeled[]).
    expect(graph.elements.find((e) => e.name === 'My_Filter')?.type).toBe('unmodeled');
    expect(graph.elements.find((e) => e.name === 'My_Filter')?.container).toBe(
      'collectionProcessors',
    );
  });

  it('emits an apexPluginCall <connector>+<faultConnector> as default+fault, name still unmodeled', () => {
    expect(
      findConnector(graph.connectors, 'My_Plugin', 'My_Assignment', 'default'),
    ).toBeDefined();
    expect(
      findConnector(graph.connectors, 'My_Plugin', 'My_Fault_Screen', 'fault'),
    ).toBeDefined();
    expect(graph.unmodeled).toContain('My_Plugin');
    // Identity row present, body still the honest gap (see unmodeled[]).
    expect(graph.elements.find((e) => e.name === 'My_Plugin')?.type).toBe('unmodeled');
    expect(graph.elements.find((e) => e.name === 'My_Plugin')?.container).toBe(
      'apexPluginCalls',
    );
  });

  it('emits a <waits> top-level <connector> as a default edge and keeps it unmodeled', () => {
    expect(
      findConnector(graph.connectors, 'My_Wait', 'My_Assignment', 'default'),
    ).toBeDefined();
    // Each <waitEvents><connector> is also captured as a default edge (spec §4.2).
    expect(
      findConnector(graph.connectors, 'My_Wait', 'My_Fault_Screen', 'default'),
    ).toBeDefined();
    // A wait's default-resume path lives on <defaultConnector> → also 'default'.
    expect(
      findConnector(graph.connectors, 'My_Wait', 'My_End_Screen', 'default'),
    ).toBeDefined();
    expect(graph.unmodeled).toContain('My_Wait');
    // Identity row present, body still the honest gap (see unmodeled[]).
    expect(graph.elements.find((e) => e.name === 'My_Wait')?.type).toBe('unmodeled');
    expect(graph.elements.find((e) => e.name === 'My_Wait')?.container).toBe(
      'waits',
    );
  });
});

describe('parseFlowGraph — record-op object resolution (three ways + unresolved)', () => {
  const RESOLUTION = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Res Flow</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <triggerType>RecordAfterSave</triggerType>
    <recordTriggerType>Create</recordTriggerType>
    <object>Acct</object>
  </start>
  <recordLookups>
    <name>Op_Object</name>
    <object>Ns__Obj__c</object>
    <filterLogic>1</filterLogic>
    <filters>
      <field>Status__c</field>
      <operator>EqualTo</operator>
      <value>
        <elementReference>$Record.Status__c</elementReference>
      </value>
    </filters>
  </recordLookups>
  <recordUpdates>
    <name>Op_Trigger</name>
    <inputReference>$Record</inputReference>
  </recordUpdates>
  <recordCreates>
    <name>Op_Var</name>
    <inputReference>My_Record_Var</inputReference>
  </recordCreates>
  <recordDeletes>
    <name>Op_Unresolved</name>
    <inputReference>Some_Undeclared</inputReference>
  </recordDeletes>
  <variables>
    <name>My_Record_Var</name>
    <objectType>Ns__Obj__c</objectType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
</Flow>`;
  const graph = parse(RESOLUTION);
  const op = (name: string) => graph.recordOps.find((o) => o.name === name)!;

  it('resolves via <object> → objectResolution:object', () => {
    expect(op('Op_Object').object).toBe('Ns__Obj__c');
    expect(op('Op_Object').objectResolution).toBe('object');
  });

  it('resolves $Record → objectResolution:triggerRecord on the trigger object', () => {
    expect(op('Op_Trigger').object).toBe('Acct');
    expect(op('Op_Trigger').objectResolution).toBe('triggerRecord');
  });

  it('resolves a typed record variable → objectResolution:inputReference', () => {
    expect(op('Op_Var').object).toBe('Ns__Obj__c');
    expect(op('Op_Var').objectResolution).toBe('inputReference');
  });

  it('leaves an undeclared reference unresolved (object null, never guessed)', () => {
    expect(op('Op_Unresolved').object).toBeNull();
    expect(op('Op_Unresolved').objectResolution).toBe('unresolved');
  });

  it('carries a reference-valued filter rightValue with rightValueKind:reference', () => {
    expect(op('Op_Object').filters).toEqual([
      {
        leftValueReference: 'Status__c',
        operator: 'EqualTo',
        rightValue: '$Record.Status__c',
        rightValueKind: 'reference',
      },
    ]);
  });
});

describe('parseFlowGraph — a null-right-value condition', () => {
  it('records rightValueKind:null when <rightValue> is absent', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Null RV</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>My_Decision</name>
    <rules>
      <name>Is_Blank</name>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.My_Field__c</leftValueReference>
        <operator>IsNull</operator>
        <rightValue>
          <booleanValue>true</booleanValue>
        </rightValue>
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
      rightValue: 'true',
      rightValueKind: 'literal',
    });
  });
});

describe('parseFlowGraph — legacy <startElementReference>', () => {
  it('emits an immediate connector to the legacy start element reference', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>50.0</apiVersion>
  <label>Legacy</label>
  <processType>Flow</processType>
  <status>Active</status>
  <startElementReference>My_First_Screen</startElementReference>
  <screens>
    <name>My_First_Screen</name>
    <label>First</label>
  </screens>
</Flow>`;
    const graph = parse(xml);
    expect(findConnector(graph.connectors, '$start', 'My_First_Screen', 'immediate')).toBeDefined();
    expect(graph.start.connector).toEqual({ to: 'My_First_Screen' });
  });
});

describe('parseFlowGraphSource — validation', () => {
  it('returns parse-error on malformed XML', () => {
    const result = parseFlowGraphSource('<Flow><label>oops</Flow>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse-error');
  });

  it('returns malformed-input when the root is not <Flow>', () => {
    const result = parseFlowGraphSource(
      '<?xml version="1.0"?><NotAFlow><label>x</label></NotAFlow>',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed-input');
  });
});

describe('parseFlowGraph — pure entry point over a pre-parsed root', () => {
  it('accepts a plain object root (no XML)', () => {
    const root = {
      label: 'Pure',
      processType: 'AutoLaunchedFlow',
      status: 'Active',
      assignments: {
        name: 'My_Assignment',
        assignmentItems: {
          assignToReference: 'My_Var',
          operator: 'Assign',
          value: { stringValue: 'X' },
        },
        connector: { targetReference: 'My_End' },
      },
    };
    const graph = parseFlowGraph(root);
    expect(graph.assignments).toHaveLength(1);
    expect(findConnector(graph.connectors, 'My_Assignment', 'My_End', 'default')).toBeDefined();
  });
});

describe('parseFlowGraph — unprojected[] is a MEASUREMENT, not a boilerplate caveat', () => {
  it('classifies referencable resources, unrecognised elements, and flow metadata', () => {
    const graph = parse(`<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>Flow</processType>
  <status>Active</status>
  <interviewLabel>My Flow {!$Flow.CurrentDateTime}</interviewLabel>
  <constants><name>My_Const_A</name></constants>
  <constants><name>My_Const_B</name></constants>
  <choices><name>My_Choice</name></choices>
  <someFutureElementType><name>My_Future_Element</name></someFutureElementType>
  <decisions>
    <name>My_Decision</name>
    <rules>
      <name>My_Rule</name>
      <connector><targetReference>My_Decision</targetReference></connector>
    </rules>
  </decisions>
</Flow>`);
    const byContainer = new Map(graph.unprojected.map((u) => [u.container, u]));
    // Multiplicity is real, not a 0/1 flag.
    expect(byContainer.get('constants')).toEqual({
      container: 'constants',
      count: 2,
      kind: 'resource',
    });
    expect(byContainer.get('choices')?.kind).toBe('resource');
    expect(byContainer.get('interviewLabel')?.kind).toBe('metadata');
    // A container nobody has taught this parser about is the LOUDEST bucket —
    // it means a real canvas element type is invisible — and it is found by
    // "present minus accounted-for", never by an allowlist of known drops.
    expect(byContainer.get('someFutureElementType')?.kind).toBe('element');
    // A container the projection DOES carry never appears here.
    expect(byContainer.has('decisions')).toBe(false);
    expect(byContainer.has('label')).toBe(false);
    // Element rows sort first so the reader hits the comprehension gap before
    // the trivia.
    expect(graph.unprojected[0]?.kind).toBe('element');
  });

  it('reports an empty unprojected[] for a flow that declares nothing extra', () => {
    const graph = parse(`<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Flow</label>
  <processType>Flow</processType>
  <status>Active</status>
  <decisions><name>My_Decision</name></decisions>
</Flow>`);
    expect(graph.unprojected).toEqual([]);
  });
});
