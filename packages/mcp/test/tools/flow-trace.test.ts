/// <reference types="vitest/globals" />

/**
 * Unit tests for the `sfi.flow_trace` MCP tool (spec §5.5 DoD).
 *
 * A real DuckDB fixture graph (mirroring `flow-graph.test.ts`) seeds Flow nodes
 * whose `sourcePath` points at synthetic `.flow-meta.xml` files written to the
 * temp vault dir, so the handler's on-demand `readFile(join(vaultRoot,
 * sourcePath))` resolves. Every name is SYNTHETIC — zero org identifiers.
 *
 * Coverage (spec §5.5): entry pass/fail; a decision picking a rule vs the
 * default; an assignment chain producing a FieldWrite; a formula evaluated and
 * one left `unresolved`; a loop with a supplied collection and one assumed-empty;
 * an Apex-action branch → `unevaluated`; the `maxSteps` guard; and `persists`
 * true/false via the `$Record`-whole-record-update precondition. Plus the shared
 * ambiguous-flowRef success envelope and schema validation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  flowTraceHandler,
  flowTraceInputSchema,
  type FlowTrace,
} from '../../src/tools/flow-trace.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.2.0',
  refreshedAt: '2026-06-01T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: { Flow: 13 },
  edges: {},
  sourceTreeHash: 'sha256:flow-trace-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Flow',
  apiName: 'TestFlow',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'flow',
  properties: {},
  ...overrides,
});

// ---------------------------------------------------------------------------
// Synthetic flows (real element <name>s, never synthetic condition-N).
// ---------------------------------------------------------------------------

/**
 * The MAIN flow: `$Record` after-save entry filter, a decision (one rule +
 * default), assignments referencing two formulas (one evaluable, one runtime),
 * and a whole-record `$Record` update (so `$Record` assignments persist).
 */
const MAIN_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <apiVersion>60.0</apiVersion>',
  '    <label>Ns Trace Main</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <recordTriggerType>CreateAndUpdate</recordTriggerType>',
  '        <filterLogic>and</filterLogic>',
  '        <filters>',
  '            <field>Status__c</field>',
  '            <operator>EqualTo</operator>',
  '            <value><stringValue>Active</stringValue></value>',
  '        </filters>',
  '        <connector><targetReference>My_Decision</targetReference></connector>',
  '    </start>',
  '    <decisions>',
  '        <name>My_Decision</name>',
  '        <label>My Decision</label>',
  '        <defaultConnector><targetReference>My_Assign_Default</targetReference></defaultConnector>',
  '        <defaultConnectorLabel>Otherwise</defaultConnectorLabel>',
  '        <rules>',
  '            <name>Rule_High</name>',
  '            <label>Rule High</label>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Amount__c</leftValueReference>',
  '                <operator>GreaterThan</operator>',
  '                <rightValue><numberValue>100</numberValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>My_Assign_High</targetReference></connector>',
  '        </rules>',
  '    </decisions>',
  '    <assignments>',
  '        <name>My_Assign_High</name>',
  '        <label>My Assign High</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Total__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><elementReference>My_Formula_Ok</elementReference></value>',
  '        </assignmentItems>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Owner_Label__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><elementReference>My_Formula_Bad</elementReference></value>',
  '        </assignmentItems>',
  '        <connector><targetReference>My_Update</targetReference></connector>',
  '    </assignments>',
  '    <assignments>',
  '        <name>My_Assign_Default</name>',
  '        <label>My Assign Default</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Total__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>Zero</stringValue></value>',
  '        </assignmentItems>',
  '        <connector><targetReference>My_Update</targetReference></connector>',
  '    </assignments>',
  '    <recordUpdates>',
  '        <name>My_Update</name>',
  '        <label>My Update</label>',
  '        <inputReference>$Record</inputReference>',
  '        <inputAssignments>',
  '            <field>Reviewed__c</field>',
  '            <value><booleanValue>true</booleanValue></value>',
  '        </inputAssignments>',
  '    </recordUpdates>',
  '    <formulas>',
  '        <name>My_Formula_Ok</name>',
  '        <dataType>Number</dataType>',
  '        <expression>{!$Record.Amount__c} + 1</expression>',
  '    </formulas>',
  '    <formulas>',
  '        <name>My_Formula_Bad</name>',
  '        <dataType>Text</dataType>',
  '        <expression>{!$User.Id}</expression>',
  '    </formulas>',
  '</Flow>',
].join('\n');

/** After-save flow with a `$Record` assignment but NO whole-record update → persists:false. */
const NO_UPDATE_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace No Update</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <recordTriggerType>CreateAndUpdate</recordTriggerType>',
  '        <connector><targetReference>My_Assign</targetReference></connector>',
  '    </start>',
  '    <assignments>',
  '        <name>My_Assign</name>',
  '        <label>My Assign</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Flag__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>Yes</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/** A loop over `My_Coll`; the body assigns a variable then loops back; exit → an assignment. */
const LOOP_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Loop</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <connector><targetReference>My_Loop</targetReference></connector>',
  '    </start>',
  '    <loops>',
  '        <name>My_Loop</name>',
  '        <label>My Loop</label>',
  '        <collectionReference>My_Coll</collectionReference>',
  '        <iterationOrder>Asc</iterationOrder>',
  '        <nextValueConnector><targetReference>My_Loop_Body</targetReference></nextValueConnector>',
  '        <noMoreValuesConnector><targetReference>My_After_Loop</targetReference></noMoreValuesConnector>',
  '    </loops>',
  '    <assignments>',
  '        <name>My_Loop_Body</name>',
  '        <label>My Loop Body</label>',
  '        <assignmentItems>',
  '            <assignToReference>My_Counter</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>x</stringValue></value>',
  '        </assignmentItems>',
  '        <connector><targetReference>My_Loop</targetReference><isGoTo>true</isGoTo></connector>',
  '    </assignments>',
  '    <assignments>',
  '        <name>My_After_Loop</name>',
  '        <label>My After Loop</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Done__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>true</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/** A flow whose executed path immediately hits an Apex action → unevaluated. */
const ACTION_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Action</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <connector><targetReference>My_Action</targetReference></connector>',
  '    </start>',
  '    <actionCalls>',
  '        <name>My_Action</name>',
  '        <label>My Action</label>',
  '        <actionType>apex</actionType>',
  '        <actionName>Ns__SomeApex</actionName>',
  '        <connector><targetReference>My_After_Action</targetReference></connector>',
  '    </actionCalls>',
  '    <assignments>',
  '        <name>My_After_Action</name>',
  '        <label>My After Action</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Never__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>unreached</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/**
 * A decision with a `GreaterThanOrEqualTo` rule and a `LessThanOrEqualTo` rule
 * (the verbatim FlowComparisonOperator names — Fix 1). First-match wins; the
 * default writes `mid`.
 */
const CMP_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Cmp</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <connector><targetReference>Cmp_Decision</targetReference></connector>',
  '    </start>',
  '    <decisions>',
  '        <name>Cmp_Decision</name>',
  '        <label>Cmp Decision</label>',
  '        <defaultConnector><targetReference>Assign_Mid</targetReference></defaultConnector>',
  '        <rules>',
  '            <name>Rule_GE</name>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Score__c</leftValueReference>',
  '                <operator>GreaterThanOrEqualTo</operator>',
  '                <rightValue><numberValue>10</numberValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>Assign_High</targetReference></connector>',
  '        </rules>',
  '        <rules>',
  '            <name>Rule_LE</name>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Score__c</leftValueReference>',
  '                <operator>LessThanOrEqualTo</operator>',
  '                <rightValue><numberValue>3</numberValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>Assign_Low</targetReference></connector>',
  '        </rules>',
  '    </decisions>',
  '    <assignments>',
  '        <name>Assign_High</name>',
  '        <label>Assign High</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Bucket__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>high</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '    <assignments>',
  '        <name>Assign_Low</name>',
  '        <label>Assign Low</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Bucket__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>low</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '    <assignments>',
  '        <name>Assign_Mid</name>',
  '        <label>Assign Mid</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Bucket__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>mid</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/** An `EqualTo` decision on a text field — exercises looseEqual (Fix 2). */
const EQ_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Eq</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <connector><targetReference>Eq_Decision</targetReference></connector>',
  '    </start>',
  '    <decisions>',
  '        <name>Eq_Decision</name>',
  '        <label>Eq Decision</label>',
  '        <defaultConnector><targetReference>Assign_NoMatch</targetReference></defaultConnector>',
  '        <rules>',
  '            <name>Rule_Eq</name>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Code__c</leftValueReference>',
  '                <operator>EqualTo</operator>',
  '                <rightValue><stringValue>1</stringValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>Assign_Match</targetReference></connector>',
  '        </rules>',
  '    </decisions>',
  '    <assignments>',
  '        <name>Assign_Match</name>',
  '        <label>Assign Match</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Result__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>matched</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '    <assignments>',
  '        <name>Assign_NoMatch</name>',
  '        <label>Assign No Match</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Result__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>nomatch</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/** `IsBlank` + `IsEmpty` decision rules (Fix 3). */
const BLANK_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Blank</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <connector><targetReference>Blank_Decision</targetReference></connector>',
  '    </start>',
  '    <decisions>',
  '        <name>Blank_Decision</name>',
  '        <label>Blank Decision</label>',
  '        <defaultConnector><targetReference>Assign_Filled</targetReference></defaultConnector>',
  '        <rules>',
  '            <name>Rule_Blank</name>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Note__c</leftValueReference>',
  '                <operator>IsBlank</operator>',
  '                <rightValue><booleanValue>true</booleanValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>Assign_Blank</targetReference></connector>',
  '        </rules>',
  '        <rules>',
  '            <name>Rule_Empty</name>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Other__c</leftValueReference>',
  '                <operator>IsEmpty</operator>',
  '                <rightValue><booleanValue>true</booleanValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>Assign_Empty</targetReference></connector>',
  '        </rules>',
  '    </decisions>',
  '    <assignments>',
  '        <name>Assign_Blank</name>',
  '        <label>Assign Blank</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Marker__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>blank</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '    <assignments>',
  '        <name>Assign_Empty</name>',
  '        <label>Assign Empty</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Marker__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>empty</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '    <assignments>',
  '        <name>Assign_Filled</name>',
  '        <label>Assign Filled</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Marker__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>filled</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/**
 * An assignment overwrites a supplied `$Record` field with an UNRESOLVED value
 * (`{!$User…}`), then a decision reads that field (Fix 4 — taint).
 */
const TAINT_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Taint</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <connector><targetReference>Taint_Assign</targetReference></connector>',
  '    </start>',
  '    <assignments>',
  '        <name>Taint_Assign</name>',
  '        <label>Taint Assign</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Gate__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><elementReference>$User.ProfileId</elementReference></value>',
  '        </assignmentItems>',
  '        <connector><targetReference>Taint_Decision</targetReference></connector>',
  '    </assignments>',
  '    <decisions>',
  '        <name>Taint_Decision</name>',
  '        <label>Taint Decision</label>',
  '        <defaultConnector><targetReference>Assign_Else</targetReference></defaultConnector>',
  '        <rules>',
  '            <name>Rule_Gate</name>',
  '            <conditionLogic>and</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.Gate__c</leftValueReference>',
  '                <operator>EqualTo</operator>',
  '                <rightValue><stringValue>OPEN</stringValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>Assign_Then</targetReference></connector>',
  '        </rules>',
  '    </decisions>',
  '    <assignments>',
  '        <name>Assign_Then</name>',
  '        <label>Assign Then</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Reached__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>yes</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '    <assignments>',
  '        <name>Assign_Else</name>',
  '        <label>Assign Else</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Reached__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>no</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/** The executed path reaches a `<waits>` element — unmodeled canvas type (Fix 5). */
const WAIT_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Wait</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <connector><targetReference>My_Wait</targetReference></connector>',
  '    </start>',
  '    <waits>',
  '        <name>My_Wait</name>',
  '        <label>My Wait</label>',
  '        <defaultConnector><targetReference>After_Wait</targetReference></defaultConnector>',
  '        <waitEvents>',
  '            <name>Wait_Event</name>',
  '            <connector><targetReference>After_Wait</targetReference></connector>',
  '        </waitEvents>',
  '    </waits>',
  '    <assignments>',
  '        <name>After_Wait</name>',
  '        <label>After Wait</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Never__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>unreached</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/**
 * A decision rule with an UNPARSEABLE custom `conditionLogic` (`1 AND 2 AND` — a
 * trailing operator the index-boolean parser cannot parse) over two otherwise-
 * true conditions — must degrade to `unknown`, not guess AND (Fix 6).
 */
const CUSTOM_LOGIC_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Custom</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <connector><targetReference>Custom_Decision</targetReference></connector>',
  '    </start>',
  '    <decisions>',
  '        <name>Custom_Decision</name>',
  '        <label>Custom Decision</label>',
  '        <defaultConnector><targetReference>Assign_Default</targetReference></defaultConnector>',
  '        <rules>',
  '            <name>Rule_Custom</name>',
  '            <conditionLogic>1 AND 2 AND</conditionLogic>',
  '            <conditions>',
  '                <leftValueReference>$Record.A__c</leftValueReference>',
  '                <operator>EqualTo</operator>',
  '                <rightValue><stringValue>x</stringValue></rightValue>',
  '            </conditions>',
  '            <conditions>',
  '                <leftValueReference>$Record.B__c</leftValueReference>',
  '                <operator>EqualTo</operator>',
  '                <rightValue><stringValue>y</stringValue></rightValue>',
  '            </conditions>',
  '            <connector><targetReference>Assign_Then</targetReference></connector>',
  '        </rules>',
  '    </decisions>',
  '    <assignments>',
  '        <name>Assign_Then</name>',
  '        <label>Assign Then</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Marker__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>then</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '    <assignments>',
  '        <name>Assign_Default</name>',
  '        <label>Assign Default</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Marker__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>default</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/** An entry filter that depends on a field NOT in recordState (Fix 7 — indeterminate). */
const ENTRY_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Entry</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <filterLogic>and</filterLogic>',
  '        <filters>',
  '            <field>Missing__c</field>',
  '            <operator>EqualTo</operator>',
  '            <value><stringValue>Active</stringValue></value>',
  '        </filters>',
  '        <connector><targetReference>Entry_Assign</targetReference></connector>',
  '    </start>',
  '    <assignments>',
  '        <name>Entry_Assign</name>',
  '        <label>Entry Assign</label>',
  '        <assignmentItems>',
  '            <assignToReference>$Record.Touched__c</assignToReference>',
  '            <operator>Assign</operator>',
  '            <value><stringValue>yes</stringValue></value>',
  '        </assignmentItems>',
  '    </assignments>',
  '</Flow>',
].join('\n');

/**
 * A before-save flow with a single `$Record` assignment (so a RUNNABLE version's
 * write persists), templated by `<status>` — used to prove FLOW-TRACE-OMITS-
 * FLOW-STATUS: an Obsolete/Draft flow must not claim live persists, while the
 * identical Active body still does. No entry filters → enters unconditionally.
 */
const statusFlowXml = (status: string): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <label>Ns Trace Status</label>',
    '    <processType>AutoLaunchedFlow</processType>',
    `    <status>${status}</status>`,
    '    <start>',
    '        <object>Ns__Obj__c</object>',
    '        <triggerType>RecordBeforeSave</triggerType>',
    '        <recordTriggerType>Create</recordTriggerType>',
    '        <connector><targetReference>Status_Assign</targetReference></connector>',
    '    </start>',
    '    <assignments>',
    '        <name>Status_Assign</name>',
    '        <label>Status Assign</label>',
    '        <assignmentItems>',
    '            <assignToReference>$Record.Marker__c</assignToReference>',
    '            <operator>Assign</operator>',
    '            <value><stringValue>set</stringValue></value>',
    '        </assignmentItems>',
    '    </assignments>',
    '</Flow>',
  ].join('\n');

const OBSOLETE_FLOW_XML = statusFlowXml('Obsolete');
const DRAFT_FLOW_XML = statusFlowXml('Draft');
const ACTIVE_STATUS_FLOW_XML = statusFlowXml('Active');

/**
 * A record-triggered flow whose entry gate is a `<start><filterFormula>` (NOT
 * structured `<filters>`) that connects straight to an Apex action — the
 * FLOW-GRAPH-TRACE-DROPS-START-FILTER-FORMULA shape. Pre-fix the empty filter
 * list read as unconditional entry (`entered:true`) and the walk marched into the
 * action; post-fix entry is INDETERMINATE (the projection does not evaluate the
 * formula), never a silent yes.
 */
const FORMULA_START_FLOW_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
  '    <label>Ns Trace Formula Start</label>',
  '    <processType>AutoLaunchedFlow</processType>',
  '    <status>Active</status>',
  '    <start>',
  '        <object>Ns__Obj__c</object>',
  '        <triggerType>RecordAfterSave</triggerType>',
  '        <recordTriggerType>CreateAndUpdate</recordTriggerType>',
  "        <filterFormula>ISPICKVAL({!$Record.Status__c}, 'Submitted')</filterFormula>",
  '        <connector><targetReference>Formula_Action</targetReference></connector>',
  '    </start>',
  '    <actionCalls>',
  '        <name>Formula_Action</name>',
  '        <label>Formula Action</label>',
  '        <actionType>apex</actionType>',
  '        <actionName>Ns__SomeApex</actionName>',
  '    </actionCalls>',
  '</Flow>',
].join('\n');

const MAIN_ID = 'Flow:Ns__Trace_Main';
const NO_UPDATE_ID = 'Flow:Ns__Trace_No_Update';
const LOOP_ID = 'Flow:Ns__Trace_Loop';
const ACTION_ID = 'Flow:Ns__Trace_Action';
const CMP_ID = 'Flow:Ns__Trace_Cmp';
const EQ_ID = 'Flow:Ns__Trace_Eq';
const BLANK_ID = 'Flow:Ns__Trace_Blank';
const TAINT_ID = 'Flow:Ns__Trace_Taint';
const WAIT_ID = 'Flow:Ns__Trace_Wait';
const CUSTOM_LOGIC_ID = 'Flow:Ns__Trace_Custom';
const ENTRY_ID = 'Flow:Ns__Trace_Entry';
const OBSOLETE_ID = 'Flow:Ns__Trace_Obsolete';
const DRAFT_ID = 'Flow:Ns__Trace_Draft';
const ACTIVE_STATUS_ID = 'Flow:Ns__Trace_Active_Status';
const FORMULA_START_ID = 'Flow:Ns__Trace_Formula_Start';

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: MAIN_ID,
      apiName: 'Ns__Trace_Main',
      label: 'Ns Trace Main',
      sourcePath: 'source/flows/Ns__Trace_Main.flow-meta.xml',
      apiVersion: 60,
      properties: { status: 'Active', processType: 'AutoLaunchedFlow' },
    }),
    makeNode({
      id: NO_UPDATE_ID,
      apiName: 'Ns__Trace_No_Update',
      label: 'Ns Trace No Update',
      sourcePath: 'source/flows/Ns__Trace_No_Update.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: LOOP_ID,
      apiName: 'Ns__Trace_Loop',
      label: 'Ns Trace Loop',
      sourcePath: 'source/flows/Ns__Trace_Loop.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: ACTION_ID,
      apiName: 'Ns__Trace_Action',
      label: 'Ns Trace Action',
      sourcePath: 'source/flows/Ns__Trace_Action.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: CMP_ID,
      apiName: 'Ns__Trace_Cmp',
      label: 'Ns Trace Cmp',
      sourcePath: 'source/flows/Ns__Trace_Cmp.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: EQ_ID,
      apiName: 'Ns__Trace_Eq',
      label: 'Ns Trace Eq',
      sourcePath: 'source/flows/Ns__Trace_Eq.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: BLANK_ID,
      apiName: 'Ns__Trace_Blank',
      label: 'Ns Trace Blank',
      sourcePath: 'source/flows/Ns__Trace_Blank.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: TAINT_ID,
      apiName: 'Ns__Trace_Taint',
      label: 'Ns Trace Taint',
      sourcePath: 'source/flows/Ns__Trace_Taint.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: WAIT_ID,
      apiName: 'Ns__Trace_Wait',
      label: 'Ns Trace Wait',
      sourcePath: 'source/flows/Ns__Trace_Wait.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: CUSTOM_LOGIC_ID,
      apiName: 'Ns__Trace_Custom',
      label: 'Ns Trace Custom',
      sourcePath: 'source/flows/Ns__Trace_Custom.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: ENTRY_ID,
      apiName: 'Ns__Trace_Entry',
      label: 'Ns Trace Entry',
      sourcePath: 'source/flows/Ns__Trace_Entry.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    // FLOW-TRACE-OMITS-FLOW-STATUS witnesses: identical before-save body, three
    // statuses. Obsolete/Draft must trace as non-runnable (no live persists);
    // the Active control still persists.
    makeNode({
      id: OBSOLETE_ID,
      apiName: 'Ns__Trace_Obsolete',
      label: 'Ns Trace Status',
      sourcePath: 'source/flows/Ns__Trace_Obsolete.flow-meta.xml',
      properties: { status: 'Obsolete' },
    }),
    makeNode({
      id: DRAFT_ID,
      apiName: 'Ns__Trace_Draft',
      label: 'Ns Trace Status',
      sourcePath: 'source/flows/Ns__Trace_Draft.flow-meta.xml',
      properties: { status: 'Draft' },
    }),
    makeNode({
      id: ACTIVE_STATUS_ID,
      apiName: 'Ns__Trace_Active_Status',
      label: 'Ns Trace Status',
      sourcePath: 'source/flows/Ns__Trace_Active_Status.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    // FLOW-GRAPH-TRACE-DROPS-START-FILTER-FORMULA witness: filterFormula-only start.
    makeNode({
      id: FORMULA_START_ID,
      apiName: 'Ns__Trace_Formula_Start',
      label: 'Ns Trace Formula Start',
      sourcePath: 'source/flows/Ns__Trace_Formula_Start.flow-meta.xml',
      properties: { status: 'Active' },
    }),
    // Two shared-prefix flows so a typo of the prefix resolves AMBIGUOUSLY.
    makeNode({
      id: 'Flow:Order_Escalation_One',
      apiName: 'Order_Escalation_One',
      label: 'Order Escalation One',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: 'Flow:Order_Escalation_Two',
      apiName: 'Order_Escalation_Two',
      label: 'Order Escalation Two',
      properties: { status: 'Active' },
    }),
  ],
  edges: [
    makeEdge({ fromId: MAIN_ID, toId: 'ApexClass:Ns__Helper', edgeType: 'callsApex' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-flow-trace-'));
  const sourceDir = join(tempDir, 'source/flows');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'Ns__Trace_Main.flow-meta.xml'), MAIN_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_No_Update.flow-meta.xml'), NO_UPDATE_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Loop.flow-meta.xml'), LOOP_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Action.flow-meta.xml'), ACTION_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Cmp.flow-meta.xml'), CMP_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Eq.flow-meta.xml'), EQ_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Blank.flow-meta.xml'), BLANK_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Taint.flow-meta.xml'), TAINT_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Wait.flow-meta.xml'), WAIT_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Custom.flow-meta.xml'), CUSTOM_LOGIC_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Entry.flow-meta.xml'), ENTRY_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Obsolete.flow-meta.xml'), OBSOLETE_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Draft.flow-meta.xml'), DRAFT_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Active_Status.flow-meta.xml'), ACTIVE_STATUS_FLOW_XML, 'utf-8');
  writeFileSync(join(sourceDir, 'Ns__Trace_Formula_Start.flow-meta.xml'), FORMULA_START_FLOW_XML, 'utf-8');

  const opened = await openGraph(join(tempDir, 'flow-trace.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

/** Narrow the union to the completed-trace branch (asserts it is NOT ambiguous). */
const asTrace = (data: unknown): FlowTrace => {
  if (data !== null && typeof data === 'object' && 'ambiguous' in data) {
    throw new Error('expected a completed FlowTrace, got an ambiguous envelope');
  }
  return data as FlowTrace;
};

describe('flowTraceHandler — entry criteria', () => {
  it('enters when the start filter passes', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: MAIN_ID,
      recordState: { Status__c: 'Active', Amount__c: 150 },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.entered).toBe(true);
    expect(t.entryEvaluation).toHaveLength(1);
    expect(t.entryEvaluation[0]?.result).toBe(true);
    // Verbatim honesty disclosure.
    expect(t.disclosure).toBe(
      'Declared-logic projection, NOT a runtime. A branch depending on data not in recordState is unknown, never assumed. No Apex/callout/DML/subflow execution; no cross-automation order-of-execution.',
    );
    expect(r.value.vaultState.sourceTreeHash).toBe('sha256:flow-trace-fixture');
  });

  it('does not enter (no-entry) when the start filter fails', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: MAIN_ID,
      recordState: { Status__c: 'Inactive', Amount__c: 150 },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.entered).toBe(false);
    expect(t.stoppedReason).toBe('no-entry');
    expect(t.path).toEqual([]);
    expect(t.writes).toEqual([]);
    expect(t.entryEvaluation[0]?.result).toBe(false);
  });
});

describe('flowTraceHandler — start filterFormula entry gate (FLOW-GRAPH-TRACE-DROPS-START-FILTER-FORMULA)', () => {
  it('does NOT invent entry for a filterFormula-only start — entry is indeterminate, walk never runs', async () => {
    const r = await flowTraceHandler(ctx, {
      // A record whose Status contradicts the ISPICKVAL(...,'Submitted') gate.
      flowRef: FORMULA_START_ID,
      recordState: { Status__c: 'Draft' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    // Pre-fix this returned entered:true with an empty entryEvaluation and walked
    // into the Apex action. Now entry is UNKNOWN, never a silent yes.
    expect(t.entered).toBe(false);
    expect(t.entryIndeterminate).toBe(true);
    expect(t.stoppedReason).toBe('no-entry');
    expect(t.path).toEqual([]);
    expect(t.writes).toEqual([]);
    // The formula gate is disclosed in the assumptions.
    expect(t.assumptions.some((a) => a.includes('filterFormula') && a.includes('ISPICKVAL'))).toBe(true);
  });

  it('stays indeterminate even when a supplied field would satisfy the formula (no partial guess)', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: FORMULA_START_ID,
      recordState: { Status__c: 'Submitted' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    // Honest: the projection does not evaluate the formula, so it never asserts
    // entry — not even when recordState happens to match.
    expect(t.entered).toBe(false);
    expect(t.entryIndeterminate).toBe(true);
  });
});

describe('flowTraceHandler — non-runnable flow status (FLOW-TRACE-OMITS-FLOW-STATUS)', () => {
  it('traces an Obsolete flow as non-runnable: status echoed, writes never persist, assumption disclosed', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: OBSOLETE_ID,
      recordState: { Name: 'anything' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    // The Flow's status is surfaced (previously ENTIRELY absent from the payload).
    expect(t.flowRef.status).toBe('Obsolete');
    expect(t.notRunnable).toBe(true);
    // The write is projected (structural), but a dead automation cannot persist it.
    const marker = t.writes.find((w) => w.field === 'Marker__c');
    expect(marker).toBeDefined();
    expect(marker?.persists).toBe(false);
    // An explicit non-runnable assumption leads the ledger.
    expect(t.assumptions[0]).toContain('Flow status is Obsolete');
    expect(t.assumptions[0]).toContain('cannot run');
  });

  it('gates a Draft flow the same way', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: DRAFT_ID,
      recordState: { Name: 'anything' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.flowRef.status).toBe('Draft');
    expect(t.notRunnable).toBe(true);
    expect(t.writes.every((w) => w.persists === false)).toBe(true);
  });

  it('leaves an Active flow with the identical body runnable (persists true, no notRunnable marker)', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: ACTIVE_STATUS_ID,
      recordState: { Name: 'anything' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.flowRef.status).toBe('Active');
    expect(t.notRunnable).toBeUndefined();
    const marker = t.writes.find((w) => w.field === 'Marker__c');
    // Before-save flow → $Record assignment persists automatically.
    expect(marker?.persists).toBe(true);
    expect(t.assumptions.some((a) => a.includes('cannot run'))).toBe(false);
  });
});

describe('flowTraceHandler — decisions, assignments, formulas, writes', () => {
  it('takes the matching rule branch and writes a formula-derived FieldWrite (persists via the $Record update)', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: MAIN_ID,
      recordState: { Status__c: 'Active', Amount__c: 150 },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    // Path: decision (rule) → high assignment → whole-record update → end.
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.element).toBe('My_Decision');
    expect(decisionStep?.decision?.matchedRule).toBe('Rule_High');
    expect(t.path.map((s) => s.element)).toEqual(['My_Decision', 'My_Assign_High', 'My_Update']);
    expect(t.stoppedReason).toBe('end');
    // The evaluable formula {!$Record.Amount__c} + 1 → 151, valueKind 'formula'.
    const total = t.writes.find((w) => w.field === 'Total__c');
    expect(total?.value).toBe('151');
    expect(total?.valueKind).toBe('formula');
    expect(total?.persists).toBe(true);
    expect(total?.object).toBe('Ns__Obj__c');
    // The runtime-only formula {!$User.Id} → unresolved (recorded, never guessed).
    const owner = t.writes.find((w) => w.field === 'Owner_Label__c');
    expect(owner?.valueKind).toBe('unresolved');
    expect(owner?.value).toBeNull();
    // The record-op input assignment is a real DML write → persists true.
    const reviewed = t.writes.find((w) => w.field === 'Reviewed__c');
    expect(reviewed?.valueKind).toBe('literal');
    expect(reviewed?.persists).toBe(true);
  });

  it('falls through to the default branch when no rule matches', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: MAIN_ID,
      recordState: { Status__c: 'Active', Amount__c: 50 },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.decision?.matchedRule).toBeNull();
    expect(t.path.map((s) => s.element)).toContain('My_Assign_Default');
    expect(t.path.map((s) => s.element)).not.toContain('My_Assign_High');
    // The default assignment writes a literal.
    const total = t.writes.find((w) => w.field === 'Total__c');
    expect(total?.value).toBe('Zero');
    expect(total?.valueKind).toBe('literal');
  });

  it('marks a $Record assignment persists:false when the flow has no whole-record update', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: NO_UPDATE_ID,
      recordState: {},
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.entered).toBe(true); // no entry filters
    const flag = t.writes.find((w) => w.field === 'Flag__c');
    expect(flag?.value).toBe('Yes');
    expect(flag?.persists).toBe(false);
  });
});

describe('flowTraceHandler — loops', () => {
  it('iterates a supplied collection once per item, then exits via noMoreValues', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: LOOP_ID,
      recordState: { My_Coll: [1, 2] },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const bodyVisits = t.path.filter((s) => s.element === 'My_Loop_Body').length;
    expect(bodyVisits).toBe(2);
    expect(t.path.map((s) => s.element)).toContain('My_After_Loop');
    expect(t.stoppedReason).toBe('end');
    // A supplied collection is NOT an assumption.
    expect(t.assumptions.some((a) => a.includes('assumed empty'))).toBe(false);
  });

  it('assumes an unsupplied collection is empty and takes noMoreValues', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: LOOP_ID,
      recordState: {},
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.path.map((s) => s.element)).not.toContain('My_Loop_Body');
    expect(t.path.map((s) => s.element)).toContain('My_After_Loop');
    expect(t.assumptions.some((a) => a.includes("collection 'My_Coll' assumed empty"))).toBe(true);
  });
});

describe('flowTraceHandler — honesty boundaries', () => {
  it('stops unevaluated at an Apex action and does not proceed past it', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: ACTION_ID,
      recordState: {},
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.stoppedReason).toBe('unevaluated-branch');
    expect(t.unevaluated.some((u) => u.element === 'My_Action')).toBe(true);
    expect(t.path.map((s) => s.element)).not.toContain('My_After_Action');
    // The action's write must never appear — the branch was not executed.
    expect(t.writes.some((w) => w.field === 'Never__c')).toBe(false);
  });

  it('honors the maxSteps guard', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: MAIN_ID,
      recordState: { Status__c: 'Active', Amount__c: 150 },
      maxSteps: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.stoppedReason).toBe('max-steps');
    expect(t.path).toHaveLength(1);
  });
});

describe('flowTraceHandler — comparison operators (Fix 1)', () => {
  it('evaluates a GreaterThanOrEqualTo rule (>=) correctly', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: CMP_ID,
      recordState: { Score__c: 10 }, // 10 >= 10 → true
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.decision?.matchedRule).toBe('Rule_GE');
    // The >= condition resolved to a real boolean, not 'unknown'.
    expect(decisionStep?.decision?.evaluated[0]?.result).toBe(true);
    expect(t.path.map((s) => s.element)).toContain('Assign_High');
    expect(t.writes.find((w) => w.field === 'Bucket__c')?.value).toBe('high');
  });

  it('evaluates a LessThanOrEqualTo rule (<=) correctly', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: CMP_ID,
      recordState: { Score__c: 3 }, // 3 >= 10 false, 3 <= 3 true → Rule_LE
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.decision?.matchedRule).toBe('Rule_LE');
    // The matched rule's <= condition resolved to a real boolean (true), not unknown.
    expect(decisionStep?.decision?.evaluated.map((e) => e.result)).toEqual([true]);
    expect(t.writes.find((w) => w.field === 'Bucket__c')?.value).toBe('low');
  });

  it('takes the default when neither >= nor <= matches', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: CMP_ID,
      recordState: { Score__c: 5 }, // 5 >= 10 false, 5 <= 3 false → default
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.decision?.matchedRule).toBeNull();
    // On the default push both operator conditions were evaluated to booleans
    // (>= false, <= false) — neither fell through to 'unknown'.
    expect(decisionStep?.decision?.evaluated.map((e) => e.result)).toEqual([false, false]);
    expect(t.writes.find((w) => w.field === 'Bucket__c')?.value).toBe('mid');
  });
});

describe('flowTraceHandler — looseEqual over-coercion (Fix 2)', () => {
  it('treats "01" and "1" as UNEQUAL strings (no numeric coercion of two strings)', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: EQ_ID,
      recordState: { Code__c: '01' }, // EqualTo "1" must be FALSE
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.decision?.evaluated[0]?.result).toBe(false);
    expect(decisionStep?.decision?.matchedRule).toBeNull();
    expect(t.writes.find((w) => w.field === 'Result__c')?.value).toBe('nomatch');
  });

  it('still compares numerically when one operand is a real number', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: EQ_ID,
      recordState: { Code__c: 1 }, // number 1 EqualTo "1" → true
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.decision?.evaluated[0]?.result).toBe(true);
    expect(decisionStep?.decision?.matchedRule).toBe('Rule_Eq');
    expect(t.writes.find((w) => w.field === 'Result__c')?.value).toBe('matched');
  });
});

describe('flowTraceHandler — IsBlank / IsEmpty (Fix 3)', () => {
  it('matches an IsBlank rule when the field is empty', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: BLANK_ID,
      recordState: { Note__c: '' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.decision?.matchedRule).toBe('Rule_Blank');
    expect(decisionStep?.decision?.evaluated[0]?.result).toBe(true);
    expect(t.writes.find((w) => w.field === 'Marker__c')?.value).toBe('blank');
  });

  it('matches an IsEmpty rule when a non-blank field precedes an empty one', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: BLANK_ID,
      recordState: { Note__c: 'x', Other__c: '' }, // Note not blank → Rule_Empty
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    const decisionStep = t.path.find((s) => s.type === 'decision');
    expect(decisionStep?.decision?.matchedRule).toBe('Rule_Empty');
    expect(t.writes.find((w) => w.field === 'Marker__c')?.value).toBe('empty');
  });

  it('falls to the default when neither field is blank/empty', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: BLANK_ID,
      recordState: { Note__c: 'x', Other__c: 'y' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.path.find((s) => s.type === 'decision')?.decision?.matchedRule).toBeNull();
    expect(t.writes.find((w) => w.field === 'Marker__c')?.value).toBe('filled');
  });
});

describe('flowTraceHandler — unresolved-assignment taint (Fix 4)', () => {
  it('a field overwritten with an unresolved value reads as unknown downstream (branch unevaluated)', async () => {
    const r = await flowTraceHandler(ctx, {
      // Gate__c is supplied as OPEN, but Taint_Assign overwrites it with {!$User…}
      // (unresolved). A later decision on Gate__c must NOT match against the stale
      // OPEN — the branch is unevaluated.
      flowRef: TAINT_ID,
      recordState: { Gate__c: 'OPEN' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.stoppedReason).toBe('unevaluated-branch');
    expect(t.unevaluated.some((u) => u.element === 'Taint_Decision')).toBe(true);
    // Neither branch of the tainted decision was taken.
    expect(t.path.map((s) => s.element)).not.toContain('Assign_Then');
    expect(t.path.map((s) => s.element)).not.toContain('Assign_Else');
    // The tainting assignment recorded an unresolved write.
    expect(t.writes.find((w) => w.field === 'Gate__c')?.valueKind).toBe('unresolved');
  });
});

describe('flowTraceHandler — unmodeled canvas element (Fix 5)', () => {
  it('stops honestly at a <waits> element with an unmodeled-type why', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: WAIT_ID,
      recordState: {},
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.stoppedReason).toBe('unevaluated-branch');
    const waitEntry = t.unevaluated.find((u) => u.element === 'My_Wait');
    expect(waitEntry).toBeDefined();
    expect(waitEntry?.why).toContain('unmodeled canvas type');
    // The walk did not proceed past the wait.
    expect(t.path.map((s) => s.element)).not.toContain('After_Wait');
    expect(t.writes.some((w) => w.field === 'Never__c')).toBe(false);
  });
});

describe('flowTraceHandler — unparseable conditionLogic (Fix 6)', () => {
  it('degrades an unparseable custom conditionLogic to unknown (never guesses AND)', async () => {
    const r = await flowTraceHandler(ctx, {
      // Both conditions are true; a naive AND fallback would MATCH the rule. The
      // logic "1 AND 2 AND" (trailing operator) does not parse, so it degrades to
      // unknown rather than guessing AND.
      flowRef: CUSTOM_LOGIC_ID,
      recordState: { A__c: 'x', B__c: 'y' },
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.stoppedReason).toBe('unevaluated-branch');
    expect(t.path.find((s) => s.type === 'decision')?.decision?.matchedRule).toBeNull();
    expect(t.path.map((s) => s.element)).not.toContain('Assign_Then');
    expect(t.path.map((s) => s.element)).not.toContain('Assign_Default');
  });
});

describe('flowTraceHandler — entry indeterminate (Fix 7)', () => {
  it('flags entryIndeterminate when entry criteria depend on unsupplied data', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: ENTRY_ID,
      recordState: {}, // Missing__c not supplied → entry criteria unknown
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.entered).toBe(false);
    expect(t.entryIndeterminate).toBe(true);
    expect(t.stoppedReason).toBe('no-entry');
    expect(t.assumptions.some((a) => a.includes('UNKNOWN'))).toBe(true);
    expect(t.path).toEqual([]);
  });

  it('does NOT flag entryIndeterminate on a definitive no-entry', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: MAIN_ID,
      recordState: { Status__c: 'Inactive', Amount__c: 150 }, // filter definitively false
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = asTrace(r.value.data);
    expect(t.entered).toBe(false);
    expect(t.entryIndeterminate).toBeUndefined();
    expect(t.stoppedReason).toBe('no-entry');
  });
});

describe('flowTraceInputSchema — maxSteps upper bound (Fix 8)', () => {
  it('rejects a maxSteps above the hard cap', () => {
    expect(
      flowTraceInputSchema.safeParse({ flowRef: 'My_Flow', recordState: {}, maxSteps: 100001 })
        .success,
    ).toBe(false);
  });

  it('accepts maxSteps at the hard cap', () => {
    expect(
      flowTraceInputSchema.safeParse({ flowRef: 'My_Flow', recordState: {}, maxSteps: 100000 })
        .success,
    ).toBe(true);
  });
});

describe('flowTraceHandler — resolution edge cases', () => {
  it('surfaces an ambiguous bare name as a success envelope (never a pick)', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: 'Order_Escalaton',
      recordState: {},
      maxSteps: 500,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    expect('ambiguous' in data && data.ambiguous).toBe(true);
    if (!('ambiguous' in data)) return;
    expect(data.flowRef.requested).toBe('Order_Escalaton');
    expect(data.candidates.length).toBeGreaterThanOrEqual(2);
    expect('path' in data).toBe(false);
  });

  it('fails closed on a Flow record id with no id index', async () => {
    const r = await flowTraceHandler(ctx, {
      flowRef: '301000000000001AAA',
      recordState: {},
      maxSteps: 500,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/Tooling-API/);
  });
});

describe('flowTraceInputSchema', () => {
  it('accepts a minimal well-formed input and defaults maxSteps', () => {
    const parsed = flowTraceInputSchema.safeParse({
      flowRef: 'Flow:My_Flow',
      recordState: { Status__c: 'Active' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.maxSteps).toBe(500);
  });

  it('accepts priorState + an explicit maxSteps', () => {
    const parsed = flowTraceInputSchema.safeParse({
      flowRef: 'My_Flow',
      recordState: { Status__c: 'Active' },
      priorState: { Status__c: 'Draft' },
      maxSteps: 50,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty flowRef and a missing recordState', () => {
    expect(flowTraceInputSchema.safeParse({ flowRef: '', recordState: {} }).success).toBe(false);
    expect(flowTraceInputSchema.safeParse({ flowRef: 'My_Flow' }).success).toBe(false);
  });

  it('rejects a non-positive maxSteps', () => {
    expect(
      flowTraceInputSchema.safeParse({ flowRef: 'My_Flow', recordState: {}, maxSteps: 0 }).success,
    ).toBe(false);
  });
});
