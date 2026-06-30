/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractFlow } from '../src/flow.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/flows/RT_CU_BS_Update_Number_of_Event_Members_on_Engagement.flow-meta.xml';
const GOLDEN_PATH_REL =
  'tests/golden/extractor-flow/RT_CU_BS_Update_Number_of_Event_Members_on_Engagement.json';

const VALID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Test Flow</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
</Flow>`;

/**
 * Write content to a freshly-created temp file and return its absolute path.
 * Caller is responsible for cleanup; tests typically delete the parent dir.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-flow-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractFlow', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the RT_CU_BS_Update_Number_of_Event_Members_on_Engagement fixture', async () => {
      // The extractor accepts the path verbatim and stores it as
      // `sourcePath`. The golden's `sourcePath` is the harness-rooted
      // relative path. Because vitest's cwd is the package directory (not
      // the harness root) and `process.chdir` is unsupported in vitest's
      // worker pool, we call the extractor with the absolute path and
      // patch the golden's `sourcePath` to match — deep-equality on
      // every other field still proves correctness.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractFlow(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('v2.0a — ConditionalContext extraction', () => {
    it('emits a flow-decision ConditionalContext per <decisions><rules>', async () => {
      const xml = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Decide Stage</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <decisions>
    <name>Choose_Path</name>
    <label>Choose Path</label>
    <rules>
      <name>HighValue</name>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.Amount</leftValueReference>
        <operator>GreaterThan</operator>
        <rightValue>
          <numberValue>100000</numberValue>
        </rightValue>
      </conditions>
    </rules>
  </decisions>
</Flow>`;
      const { dir, path } = await writeTempXml('Decide_Stage.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const conditionNode = result.value.nodes.find(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNode).toBeDefined();
        expect(conditionNode!.id).toBe(
          'ConditionalContext:Flow:Decide_Stage.condition-0',
        );
        expect(conditionNode!.properties.kind).toBe('flow-decision');
        const firesWhen = result.value.edges.find(
          (e) => e.edgeType === 'firesWhen',
        );
        expect(firesWhen!.fromId).toBe('Flow:Decide_Stage');
        expect(firesWhen!.confidence).toBe('declared');
        expect(firesWhen!.properties.kind).toBe('flow-decision');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a flow-recordtrigger ConditionalContext when <start> carries a <filterFormula>', async () => {
      const xml = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Watch Amount</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <object>Opportunity</object>
    <triggerType>RecordBeforeSave</triggerType>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <filterFormula>ISCHANGED($Record.Amount)</filterFormula>
  </start>
</Flow>`;
      const { dir, path } = await writeTempXml('Watch_Amount.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const conditionNode = result.value.nodes.find(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNode).toBeDefined();
        expect(conditionNode!.properties.kind).toBe('flow-recordtrigger');
        const firesWhen = result.value.edges.find(
          (e) => e.edgeType === 'firesWhen',
        );
        // filterFormula → parsed confidence (formula-based).
        expect(firesWhen!.confidence).toBe('parsed');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no ConditionalContext for an autolaunched Flow with no conditions', async () => {
      const xml = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Empty</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
</Flow>`;
      const { dir, path } = await writeTempXml('Empty.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.nodes.filter((n) => n.type === 'ConditionalContext'),
        ).toHaveLength(0);
        expect(
          result.value.edges.filter((e) => e.edgeType === 'firesWhen'),
        ).toHaveLength(0);
        const flowNode = result.value.nodes.find((n) => n.type === 'Flow');
        expect(flowNode!.properties.conditions).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('optional apiVersion', () => {
    it('extracts a flow that omits the optional <apiVersion> (apiVersion=null)', async () => {
      // <apiVersion> is OPTIONAL — auto-generated flows (e.g. the mass.gov
      // PolicyCondition_* flows and customer_satisfaction) omit it entirely.
      // The extractor wrongly listed it in REQUIRED_ELEMENTS (5 errors on the
      // mass.gov refresh) AND the read site did `Number(undefined)` → NaN.
      // An absent <apiVersion> must extract cleanly with apiVersion === null,
      // matching the `number | null` graph column (queries.ts api_version).
      const xml = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>customer_satisfaction</label>
  <processType>Flow</processType>
  <status>Active</status>
</Flow>`;
      const { dir, path } = await writeTempXml(
        'customer_satisfaction.flow-meta.xml',
        xml,
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const flowNode = result.value.nodes.find((n) => n.type === 'Flow');
        expect(flowNode).toBeDefined();
        expect(flowNode!.apiVersion).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const result = await extractFlow('/this/path/does/not/exist.flow-meta.xml');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe('/this/path/does/not/exist.flow-meta.xml');
    });

    it('returns parse-error for malformed XML', async () => {
      // Mismatched closing tag — fails XMLValidator.validate strictly.
      const { dir, path } = await writeTempXml(
        'Bad.flow-meta.xml',
        '<?xml version="1.0"?><Flow><label>Hi</wrongClose></Flow>',
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <Flow>', async () => {
      const { dir, path } = await writeTempXml(
        'Wrong.flow-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <Flow> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a required element (<status>) is missing', async () => {
      const xml = `<?xml version="1.0"?>
<Flow>
  <apiVersion>59.0</apiVersion>
  <label>NoStatus</label>
  <processType>AutoLaunchedFlow</processType>
</Flow>`;
      const { dir, path } = await writeTempXml('NoStatus.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <status>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when status is not in the allowed set', async () => {
      const xml = VALID_XML.replace(
        '<status>Active</status>',
        '<status>Foo</status>',
      );
      const { dir, path } = await writeTempXml('BadStatus.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid status: Foo');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns parse-error when fast-xml-parser throws on entity-expansion overflow', async () => {
      // fast-xml-parser's `maxTotalExpansions` cap throws at runtime
      // once the cumulative count of standard entity refs (`&lt;`,
      // `&gt;`, `&quot;`, `&apos;`) exceeds the limit. The extractor
      // raises the cap to 10000 (see `flow.ts`); without the try/catch
      // around `parser.parse()`, the throw would bubble out of
      // `runRefresh` and kill the whole pipeline. This test asserts
      // the throw is still mapped to a per-file `parse-error` once the
      // raised ceiling is exceeded.
      //
      // Note: `&amp;` is replaced last in fast-xml-parser and does NOT
      // count toward the expansion limit (`OrderedObjParser.js`); use
      // `&lt;` for the synthetic overflow input. 11000 refs comfortably
      // exceed the raised cap of 10000. The XML is otherwise
      // well-formed so `XMLValidator.validate` passes and we exercise
      // the `parser.parse()` throw path.
      const overflowingLabel = '&lt;'.repeat(11000);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>${overflowingLabel}</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
</Flow>`;
      const { dir, path } = await writeTempXml('Overflow.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
        // The fast-xml-parser error message names the overflow cause; we
        // assert the substring rather than the exact text so a parser
        // version bump that rewords the message doesn't break the test.
        expect(result.error.message).toMatch(/[Ee]ntity expansion limit/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts legitimately complex Flows with entity counts above the default cap', async () => {
      // Regression test for the entity-expansion raise. The default
      // fast-xml-parser cap of 1000 was tripped by one real Flow in
      // the edu-org fixture (`Admissions_Committee_Application_Review`,
      // 1003 expansions). The extractor raises the cap to 10000 so
      // legitimate complex Flows parse successfully. 5000 entity refs
      // comfortably exceed the old 1000 cap while staying well under
      // the new 10000 ceiling — proving the raise took effect.
      const complexLabel = '&lt;'.repeat(5000);
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>${complexLabel}</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
</Flow>`;
      const { dir, path } = await writeTempXml('Complex.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('semantic edge emission', () => {
    /**
     * A synthetic Flow XML that exercises every edge-emission rule in
     * one shot:
     *   - `<start>` record-triggered on Account → 1 `triggersOn` edge.
     *   - One `<actionCalls>` of `actionType=apex` → 1 `callsApex` edge.
     *   - One `<recordLookups>` on Contact → 1 `readsFrom` edge.
     *   - One `<recordCreates>` on Task setting `Subject` → 1 OBJECT-level
     *     `writesTo` (Task) + 1 FIELD-level `writesTo` (Task.Subject).
     *   - One `<recordUpdates>` on Account setting `Description` → 1
     *     `readsFrom` + 1 OBJECT-level `writesTo` (Account) + 1 FIELD-level
     *     `writesTo` (Account.Description).
     *   - One `<recordDeletes>` on Lead → 1 `writesTo`.
     *
     * Total expected: 9 distinct edges after dedup. The two FIELD-level
     * `writesTo` edges (target `CustomField:...`) sort before the
     * OBJECT-level ones (`CustomObject:...`) because 'F' < 'O'.
     */
    const SYNTHETIC_FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Synthetic v0.2 Edge Test</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Account</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <actionCalls>
        <name>Call_MyApex</name>
        <actionName>MyApexClass</actionName>
        <actionType>apex</actionType>
    </actionCalls>
    <actionCalls>
        <name>Send_Email</name>
        <actionName>MyEmailAlert</actionName>
        <actionType>emailAlert</actionType>
    </actionCalls>
    <recordLookups>
        <name>Find_Contact</name>
        <object>Contact</object>
        <filters>
            <field>Email</field>
            <operator>EqualTo</operator>
            <value><elementReference>$Record.PersonEmail</elementReference></value>
        </filters>
    </recordLookups>
    <recordCreates>
        <name>Create_Task</name>
        <object>Task</object>
        <inputAssignments>
            <field>Subject</field>
            <value><stringValue>Follow up</stringValue></value>
        </inputAssignments>
    </recordCreates>
    <recordUpdates>
        <name>Update_Account</name>
        <object>Account</object>
        <inputAssignments>
            <field>Description</field>
            <value><stringValue>Updated</stringValue></value>
        </inputAssignments>
    </recordUpdates>
    <recordDeletes>
        <name>Delete_Lead</name>
        <object>Lead</object>
    </recordDeletes>
</Flow>`;

    it('emits the full set of edges for a synthetic Flow covering every rule', async () => {
      const { dir, path } = await writeTempXml(
        'Synthetic.flow-meta.xml',
        SYNTHETIC_FLOW_XML,
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const flowId = 'Flow:Synthetic';
        // Edges are deduped by (fromId,toId,edgeType,source) and
        // sorted by toId asc, then edgeType asc. With the synthetic
        // input above the deterministic ordering is:
        //   1. ApexClass:MyApexClass         | callsApex
        //   2. CustomField:Account.Description| writesTo  (recordUpdate)
        //   3. CustomField:Task.Subject       | writesTo  (recordCreate)
        //   4. CustomObject:Account           | readsFrom (recordUpdate)
        //   5. CustomObject:Account           | triggersOn (start)
        //   6. CustomObject:Account           | writesTo  (recordUpdate)
        //   7. CustomObject:Contact           | readsFrom (recordLookup)
        //   8. CustomObject:Lead              | writesTo  (recordDelete)
        //   9. CustomObject:Task              | writesTo  (recordCreate)
        expect(result.value.edges).toEqual([
          {
            fromId: flowId,
            toId: 'ApexClass:MyApexClass',
            edgeType: 'callsApex',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: { actionType: 'apex' },
          },
          {
            fromId: flowId,
            toId: 'CustomField:Account.Description',
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: {
              operation: 'recordUpdate',
              assignedValue: 'Updated',
              assignedValueKind: 'literal',
            },
          },
          {
            fromId: flowId,
            toId: 'CustomField:Task.Subject',
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: {
              operation: 'recordCreate',
              assignedValue: 'Follow up',
              assignedValueKind: 'literal',
            },
          },
          {
            fromId: flowId,
            toId: 'CustomObject:Account',
            edgeType: 'readsFrom',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: { operation: 'recordUpdate' },
          },
          {
            fromId: flowId,
            toId: 'CustomObject:Account',
            edgeType: 'triggersOn',
            confidence: 'declared',
            source: 'flow-extractor',
            properties: {
              triggerType: 'RecordAfterSave',
              recordTriggerType: 'CreateAndUpdate',
            },
          },
          {
            fromId: flowId,
            toId: 'CustomObject:Account',
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: { operation: 'recordUpdate' },
          },
          {
            fromId: flowId,
            toId: 'CustomObject:Contact',
            edgeType: 'readsFrom',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: { operation: 'recordLookup' },
          },
          {
            fromId: flowId,
            toId: 'CustomObject:Lead',
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: { operation: 'recordDelete' },
          },
          {
            fromId: flowId,
            toId: 'CustomObject:Task',
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: { operation: 'recordCreate' },
          },
        ]);
        // The emailAlert actionCall is deferred to v0.3 — it does not
        // produce an edge and is not a warning (it's a normal Flow
        // element, just not yet edge-emitting).
        expect(
          result.value.nodes[0]?.properties['flowExtractionWarnings'],
        ).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a FIELD-level writesTo per <inputAssignments> alongside the OBJECT-level create edge', async () => {
      // The make-field-required tool needs to know WHICH fields a creating
      // Flow sets. The extractor keeps the object-level recordCreate edge
      // (record_creation_paths depends on it) AND adds one field-level
      // writesTo per inputAssignments field.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Create Payment</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <recordCreates>
        <name>Create_Payment</name>
        <object>Payment__c</object>
        <inputAssignments>
            <field>Amount__c</field>
            <value><elementReference>vAmount</elementReference></value>
        </inputAssignments>
        <inputAssignments>
            <field>Status__c</field>
            <value><stringValue>Pending</stringValue></value>
        </inputAssignments>
    </recordCreates>
</Flow>`;
      const { dir, path } = await writeTempXml('CreatePayment.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const flowId = 'Flow:CreatePayment';
        const writesTo = result.value.edges.filter((e) => e.edgeType === 'writesTo');
        // 1 object-level + 2 field-level, all operation=recordCreate.
        // R2-1: field-level edges also carry the assigned <value> — the
        // Amount__c via an elementReference (kind 'reference'), the
        // Status__c via a stringValue literal (kind 'literal'). The
        // object-level edge carries no assignedValue.
        expect(writesTo).toEqual([
          {
            fromId: flowId,
            toId: 'CustomField:Payment__c.Amount__c',
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: {
              operation: 'recordCreate',
              assignedValue: 'vAmount',
              assignedValueKind: 'reference',
            },
          },
          {
            fromId: flowId,
            toId: 'CustomField:Payment__c.Status__c',
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: {
              operation: 'recordCreate',
              assignedValue: 'Pending',
              assignedValueKind: 'literal',
            },
          },
          {
            fromId: flowId,
            toId: 'CustomObject:Payment__c',
            edgeType: 'writesTo',
            confidence: 'parsed',
            source: 'flow-extractor',
            properties: { operation: 'recordCreate' },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('stamps assignedValue/assignedValueKind=literal for a stringValue assignment and kind=reference for an elementReference (R2-1)', async () => {
      // R2-1: the field-level writesTo edge must record WHICH value the flow
      // assigns AND whether it is a literal (statically comparable) or a
      // reference (variable/formula/$Record — NOT comparable). A consumer
      // (what_if_remove_picklist_value) must only literal-match.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Set Status</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <recordCreates>
        <name>Create_Payment</name>
        <object>Payment__c</object>
        <inputAssignments>
            <field>Status__c</field>
            <value><stringValue>Completed</stringValue></value>
        </inputAssignments>
        <inputAssignments>
            <field>Owner_Region__c</field>
            <value><elementReference>$Record.Region__c</elementReference></value>
        </inputAssignments>
    </recordCreates>
</Flow>`;
      const { dir, path } = await writeTempXml('SetStatus.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const byTo = new Map(
          result.value.edges
            .filter((e) => e.edgeType === 'writesTo')
            .map((e) => [e.toId, e]),
        );
        // Literal assignment: kind 'literal', value verbatim.
        expect(
          byTo.get('CustomField:Payment__c.Status__c')?.properties,
        ).toEqual({
          operation: 'recordCreate',
          assignedValue: 'Completed',
          assignedValueKind: 'literal',
        });
        // elementReference assignment: kind 'reference' (NOT a literal).
        expect(
          byTo.get('CustomField:Payment__c.Owner_Region__c')?.properties,
        ).toEqual({
          operation: 'recordCreate',
          assignedValue: '$Record.Region__c',
          assignedValueKind: 'reference',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('warns and emits no field edge when an <inputAssignments> has no <field>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Bad Assignment</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <recordCreates>
        <name>Create_Task</name>
        <object>Task</object>
        <inputAssignments>
            <value><stringValue>orphaned</stringValue></value>
        </inputAssignments>
    </recordCreates>
</Flow>`;
      const { dir, path } = await writeTempXml('BadAssign.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Only the object-level create edge survives; the field edge is skipped.
        const fieldEdges = result.value.edges.filter((e) =>
          e.toId.startsWith('CustomField:'),
        );
        expect(fieldEdges).toEqual([]);
        expect(
          result.value.nodes[0]?.properties['flowExtractionWarnings'],
        ).toEqual(['<recordCreates>[0].<inputAssignments>[0] has no <field>']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does not emit a triggersOn for autolaunched flows without a record trigger', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>AutoLaunched</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
</Flow>`;
      const { dir, path } = await writeTempXml('AutoLaunched.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('skips an <inputReference> update that is NOT a resolvable trigger record', async () => {
      // An AutoLaunchedFlow (no record-trigger <start>) whose update targets a
      // non-`$Record` reference can't be resolved offline — skip and warn.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>InputRef Update</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <recordUpdates>
        <name>Update_LoopVar</name>
        <inputReference>someLoopVariable</inputReference>
    </recordUpdates>
</Flow>`;
      const { dir, path } = await writeTempXml('InputRef.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        expect(
          result.value.nodes[0]?.properties['flowExtractionWarnings'],
        ).toEqual([
          '<recordUpdates>[0] has no <object> and its <inputReference> is not the trigger record ($Record); skipped',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('resolves <inputReference>$Record on a record-triggered Flow to the trigger object (bug 17)', async () => {
      // The dominant before-save pattern: a RecordBeforeSave Flow updates
      // `$Record` (the trigger record). `$Record` resolves to <start><object>,
      // so the update now emits real (heuristic) read+write + field edges
      // instead of being dropped — `explain_flow` is no longer blank.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Before Save Stamp</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Disability__c</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <recordUpdates>
        <name>Stamp_Fields</name>
        <inputReference>$Record</inputReference>
        <inputAssignments>
            <field>Verification_Status__c</field>
            <value><stringValue>Verified</stringValue></value>
        </inputAssignments>
    </recordUpdates>
</Flow>`;
      const { dir, path } = await writeTempXml('BeforeSave.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The recordUpdate edges (operation: recordUpdate) on the trigger
        // object — both heuristic because $Record was resolved via the trigger
        // type. (The separate `triggersOn` edge to the same object is declared.)
        const updateEdges = result.value.edges.filter(
          (e) =>
            e.toId === 'CustomObject:Disability__c' &&
            e.properties?.['operation'] === 'recordUpdate',
        );
        expect(updateEdges.some((e) => e.edgeType === 'readsFrom')).toBe(true);
        expect(updateEdges.some((e) => e.edgeType === 'writesTo')).toBe(true);
        for (const e of updateEdges) expect(e.confidence).toBe('heuristic');
        // field-level write for the stamped field.
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'writesTo' &&
              e.toId === 'CustomField:Disability__c.Verification_Status__c',
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('resolves <inputReference>$Record on a Scheduled Flow to the <start><object> (no spurious "no object" warning)', async () => {
      // A scheduled flow runs over the records matching its schedule filter on
      // <start><object>. An <inputReference>$Record</inputReference> update
      // inside it writes to THAT same object — it is NOT a cross-object write,
      // and it must NOT be dropped with a "has no <object>" warning. Mirrors
      // Close_the_Mid_Point_Feedbacks: scheduled on a course object, $Record
      // update sets a status field on the same object.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Close Feedbacks</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Draft</status>
    <start>
        <object>Schedule_Target__c</object>
        <schedule>
            <frequency>Daily</frequency>
            <startDate>2023-10-22</startDate>
            <startTime>06:00:00.000Z</startTime>
        </schedule>
        <triggerType>Scheduled</triggerType>
    </start>
    <recordUpdates>
        <name>Close_the_Course</name>
        <inputReference>$Record</inputReference>
        <inputAssignments>
            <field>Status__c</field>
            <value><stringValue>Close</stringValue></value>
        </inputAssignments>
    </recordUpdates>
</Flow>`;
      const { dir, path } = await writeTempXml('Scheduled.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The $Record update resolves to the scheduled object (heuristic), so
        // it emits read+write edges to the SAME object instead of being skipped.
        const updateEdges = result.value.edges.filter(
          (e) =>
            e.toId === 'CustomObject:Schedule_Target__c' &&
            e.properties?.['operation'] === 'recordUpdate',
        );
        expect(updateEdges.some((e) => e.edgeType === 'readsFrom')).toBe(true);
        expect(updateEdges.some((e) => e.edgeType === 'writesTo')).toBe(true);
        for (const e of updateEdges) expect(e.confidence).toBe('heuristic');
        // field-level write to the same object's status field.
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'writesTo' &&
              e.toId === 'CustomField:Schedule_Target__c.Status__c',
          ),
        ).toBe(true);
        // No spurious "has no <object>" warning for the resolved $Record update.
        const warnings =
          (result.value.nodes[0]?.properties['flowExtractionWarnings'] as
            | readonly string[]
            | undefined) ?? [];
        expect(
          warnings.some((w) => w.includes('<recordUpdates>') && w.includes('no <object>')),
        ).toBe(false);
        // A scheduled flow does NOT get a record-trigger `triggersOn` edge.
        expect(
          result.value.edges.some((e) => e.edgeType === 'triggersOn'),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('dedupes repeated lookups to the same SObject into a single readsFrom edge', async () => {
      // Two `<recordLookups>` on the same object produce two raw edges
      // with the same (fromId,toId,edgeType,source) tuple, which the
      // dedup pass collapses to one.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Dedup Lookups</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <recordLookups>
        <name>Lookup_1</name>
        <object>Account</object>
    </recordLookups>
    <recordLookups>
        <name>Lookup_2</name>
        <object>Account</object>
    </recordLookups>
</Flow>`;
      const { dir, path } = await writeTempXml('Dedup.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const readsFrom = result.value.edges.filter(
          (e) => e.edgeType === 'readsFrom',
        );
        expect(readsFrom).toHaveLength(1);
        expect(readsFrom[0]?.toId).toBe('CustomObject:Account');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('ignores non-apex action types without warning', async () => {
      // emailAlert, chatterPost, etc. are normal Flow constructs that
      // v0.2 explicitly defers. They produce no edge and no warning.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>NonApex</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <actionCalls>
        <name>Send</name>
        <actionName>MyAlert</actionName>
        <actionType>emailAlert</actionType>
    </actionCalls>
    <actionCalls>
        <name>Post</name>
        <actionName>SomeChatterAction</actionName>
        <actionType>chatterPost</actionType>
    </actionCalls>
</Flow>`;
      const { dir, path } = await writeTempXml('NonApex.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        expect(
          result.value.nodes[0]?.properties['flowExtractionWarnings'],
        ).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // v1.5-R3: Flow PlatformEvent subscriber recognition. A Flow whose
  // `<start>` element has `<triggerType>PlatformEvent</triggerType>`
  // is an event subscriber. v1.5 emits a `listensTo` edge in addition
  // to (NOT instead of) any pre-v1.5 record-triggered behavior. The
  // record-trigger types `RecordAfterSave` etc. continue to produce
  // `triggersOn`; the v1.5 `listensTo` production is additive and
  // scoped to the `PlatformEvent` triggerType only. See
  // IntegrationTopologySemantics.md Rule 3.
  describe('v1.5 Flow PlatformEvent listensTo', () => {
    it('emits a listensTo edge for a PlatformEvent-triggered Flow', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Event Subscriber</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <triggerType>PlatformEvent</triggerType>
        <object>Account_Change__e</object>
    </start>
</Flow>`;
      const { dir, path } = await writeTempXml('EventSub.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // listensTo emitted; triggersOn is NOT (PlatformEvent is not in
        // RECORD_TRIGGER_TYPES — that filter is the precondition for
        // the pre-v1.5 triggersOn builder).
        const edges = result.value.edges;
        expect(edges).toHaveLength(1);
        expect(edges[0]?.edgeType).toBe('listensTo');
        expect(edges[0]?.toId).toBe('CustomObject:Account_Change__e');
        expect(edges[0]?.confidence).toBe('declared');
        expect(edges[0]?.source).toBe('flow-extractor');
        expect(edges[0]?.properties).toMatchObject({
          eventName: 'Account_Change__e',
          mechanism: 'platformEventStart',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('warns when PlatformEvent triggerType has no <object>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Bad Event Sub</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <triggerType>PlatformEvent</triggerType>
    </start>
</Flow>`;
      const { dir, path } = await writeTempXml('BadEvent.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        expect(
          result.value.nodes[0]?.properties['flowExtractionWarnings'],
        ).toEqual([
          '<start> has triggerType PlatformEvent but no <object>',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('extracts a listensTo edge from the synthetic AccountChangeEventFlow fixture', async () => {
      // On-disk synthetic flow with a PlatformEvent start. Verifies
      // the listensTo production runs against a real .flow-meta.xml
      // file, mirroring the canonical golden flow's coverage but for
      // the v1.5 case.
      const fixturePath = resolve(
        HARNESS_ROOT,
        'tests/fixtures/synthetic-v1.5/flows/AccountChangeEventFlow.flow-meta.xml',
      );
      const result = await extractFlow(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edges = result.value.edges;
      expect(edges).toHaveLength(1);
      expect(edges[0]?.edgeType).toBe('listensTo');
      expect(edges[0]?.toId).toBe('CustomObject:Account_Change__e');
    });

    it('does NOT emit listensTo for a record-triggered Flow (RecordAfterSave)', async () => {
      // Confirms the v1.5 production is scoped to PlatformEvent only;
      // a record-triggered Flow still emits its pre-v1.5 triggersOn
      // edge and no listensTo. This is the additive boundary —
      // `listensTo` does NOT subsume `triggersOn`.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Record Sub</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <triggerType>RecordAfterSave</triggerType>
        <object>Account</object>
    </start>
</Flow>`;
      const { dir, path } = await writeTempXml('RecordSub.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const listensTo = result.value.edges.find(
          (e) => e.edgeType === 'listensTo',
        );
        const triggersOn = result.value.edges.find(
          (e) => e.edgeType === 'triggersOn',
        );
        expect(listensTo).toBeUndefined();
        expect(triggersOn?.toId).toBe('CustomObject:Account');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('T7 — scheduled-Flow <start><schedule> extraction', () => {
    it('stamps scheduleFrequency/scheduleStartDate/scheduleStartTime on the Flow node', async () => {
      // A scheduled flow declares its cadence under <start><schedule>.
      // startTime is UTC (trailing Z); the extractor stamps it verbatim and
      // consumers disclose the UTC framing.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Scheduled Payment Status Update</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <schedule>
            <frequency>Weekly</frequency>
            <startDate>2024-11-09</startDate>
            <startTime>08:00:00.000Z</startTime>
        </schedule>
        <triggerType>Scheduled</triggerType>
    </start>
</Flow>`;
      const { dir, path } = await writeTempXml('Scheduled.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['scheduleFrequency']).toBe('Weekly');
        expect(props?.['scheduleStartDate']).toBe('2024-11-09');
        expect(props?.['scheduleStartTime']).toBe('08:00:00.000Z');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves all three schedule properties null when <start> has no <schedule>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Record Triggered</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Account</object>
        <triggerType>RecordAfterSave</triggerType>
    </start>
</Flow>`;
      const { dir, path } = await writeTempXml('NoSchedule.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['scheduleFrequency']).toBeNull();
        expect(props?.['scheduleStartDate']).toBeNull();
        expect(props?.['scheduleStartTime']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
