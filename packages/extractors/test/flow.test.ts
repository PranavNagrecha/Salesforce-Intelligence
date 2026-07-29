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
        // BUG 6 — the bare `<conditionLogic>and</conditionLogic>` must render
        // the real predicate, NOT the literal word "and".
        expect(conditionNode!.properties.expression).toBe(
          '$Record.Amount GreaterThan 100000',
        );
        // BUG 7 — the decision `<name>` + rule `<name>` are captured as
        // `sourceName` (the synthetic `condition-0` id is left untouched).
        expect(conditionNode!.properties.sourceName).toBe(
          'Choose_Path (HighValue)',
        );
        const mirror = result.value.nodes.find(
          (n) => n.type === 'Flow',
        )!.properties.conditions as Array<Record<string, unknown>>;
        expect(mirror[0]?.sourceName).toBe('Choose_Path (HighValue)');
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

    it('emits condition field edges for <start><filters> entry criteria in the <field>/<value> dialect', async () => {
      // Record-trigger ENTRY CRITERIA use `<field>` / `<operator>` / `<value>`,
      // not the `<leftValueReference>` / `<rightValue>` spelling the decision
      // surface uses. Before the alias, every entry criterion parsed to null:
      // no CriteriaItem, no fieldRefs, no `readsFrom` edge — so a field used
      // ONLY as an entry filter was invisible to the incoming-edge walk behind
      // `safe_to_delete_field`.
      const xml = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Entry Criteria</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <object>Acct</object>
    <triggerType>RecordAfterSave</triggerType>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <filterLogic>1 AND 2</filterLogic>
    <filters>
      <field>Status__c</field>
      <operator>EqualTo</operator>
      <value>
        <stringValue>Active</stringValue>
      </value>
    </filters>
    <filters>
      <field>Retired__c</field>
      <operator>IsNull</operator>
      <value>
        <booleanValue>true</booleanValue>
      </value>
    </filters>
  </start>
</Flow>`;
      const { dir, path } = await writeTempXml(
        'Entry_Criteria.flow-meta.xml',
        xml,
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const conditionNode = result.value.nodes.find(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNode).toBeDefined();
        expect(conditionNode!.properties.kind).toBe('flow-recordtrigger');
        // Structured filters (not a filterFormula) → the criteria mode, and
        // `declared` confidence because the field name was read from XML.
        expect(conditionNode!.properties.mode).toBe('criteria');
        expect(conditionNode!.properties.itemCount).toBe(2);
        expect(conditionNode!.properties.expression).toBe(
          '(Status__c EqualTo Active) AND (Retired__c IsNull true)',
        );
        // Bare field names resolve against `<start><object>` — the triggering
        // record IS that object.
        expect(conditionNode!.properties.fieldRefs).toEqual([
          'CustomField:Acct.Status__c',
          'CustomField:Acct.Retired__c',
        ]);
        const conditionId = conditionNode!.id;
        const readsFrom = result.value.edges.filter(
          (e) => e.edgeType === 'readsFrom' && e.fromId === conditionId,
        );
        expect(readsFrom.map((e) => e.toId)).toEqual([
          'CustomField:Acct.Status__c',
          'CustomField:Acct.Retired__c',
        ]);
        expect(readsFrom[0]!.confidence).toBe('declared');
        expect(readsFrom[0]!.source).toBe('condition-extractor');
        expect(readsFrom[0]!.properties.firerId).toBe('Flow:Entry_Criteria');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves the <leftValueReference> decision dialect unchanged when a <field> alias exists', async () => {
      // Guard for the alias above: a decision condition still parses through
      // `leftValueReference` / `rightValue` and resolves exactly as it did
      // before the `<field>` alias existed — including the non-`$Record`
      // global, which stays verbatim in `fieldRefs` but is structurally
      // invalid as a field id and so mints no `readsFrom` edge.
      const xml = `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Mixed Dialects</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>
  <start>
    <object>Acct</object>
    <triggerType>RecordAfterSave</triggerType>
    <recordTriggerType>Create</recordTriggerType>
    <filters>
      <field>Status__c</field>
      <operator>EqualTo</operator>
      <value>
        <stringValue>Active</stringValue>
      </value>
    </filters>
  </start>
  <decisions>
    <name>Choose_Path</name>
    <rules>
      <name>HighValue</name>
      <conditionLogic>and</conditionLogic>
      <conditions>
        <leftValueReference>$Record.Amount__c</leftValueReference>
        <operator>GreaterThan</operator>
        <rightValue>
          <numberValue>100000</numberValue>
        </rightValue>
      </conditions>
      <conditions>
        <leftValueReference>$User.ProfileId</leftValueReference>
        <operator>EqualTo</operator>
        <rightValue>
          <stringValue>00e000000000000</stringValue>
        </rightValue>
      </conditions>
    </rules>
  </decisions>
</Flow>`;
      const { dir, path } = await writeTempXml(
        'Mixed_Dialects.flow-meta.xml',
        xml,
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const decision = result.value.nodes.find(
          (n) =>
            n.type === 'ConditionalContext' &&
            n.properties.kind === 'flow-decision',
        );
        expect(decision).toBeDefined();
        expect(decision!.properties.expression).toBe(
          '$Record.Amount__c GreaterThan 100000 AND $User.ProfileId EqualTo 00e000000000000',
        );
        // `$Record` IS the triggering record, so it resolves onto the start
        // object; `$User` is a different global and stays verbatim.
        expect(decision!.properties.fieldRefs).toEqual([
          'CustomField:Acct.Amount__c',
          'CustomField:$User.ProfileId',
        ]);
        // Only the resolvable ref becomes an edge — the `$`-prefixed one is
        // structurally invalid as a field id and is dropped rather than minted
        // as a phantom target.
        const decisionReads = result.value.edges.filter(
          (e) => e.edgeType === 'readsFrom' && e.fromId === decision!.id,
        );
        expect(decisionReads.map((e) => e.toId)).toEqual([
          'CustomField:Acct.Amount__c',
        ]);
        // Both surfaces produced a context: the decision AND the entry criteria.
        expect(
          result.value.nodes.filter((n) => n.type === 'ConditionalContext'),
        ).toHaveLength(2);
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
      // <apiVersion> is OPTIONAL — auto-generated flows (e.g. the example.gov
      // PolicyCondition_* flows and customer_satisfaction) omit it entirely.
      // The extractor wrongly listed it in REQUIRED_ELEMENTS (5 errors on the
      // example.gov refresh) AND the read site did `Number(undefined)` → NaN.
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
        // R6-11: reference-kind assignments additionally carry the dataflow
        // trace. `vAmount` is not declared anywhere in this flow, so the
        // trace resolves NOTHING and discloses one unresolved input.
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
              sourceFields: [],
              sourceFieldConfidence: [],
              unresolvedSourceCount: 1,
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
        // R6-11: this AUTOLAUNCHED flow has no <start><object>, so `$Record`
        // has no statically-known type — the trace discloses one unresolved
        // input instead of guessing an object for Region__c.
        expect(
          byTo.get('CustomField:Payment__c.Owner_Region__c')?.properties,
        ).toEqual({
          operation: 'recordCreate',
          assignedValue: '$Record.Region__c',
          assignedValueKind: 'reference',
          sourceFields: [],
          sourceFieldConfidence: [],
          unresolvedSourceCount: 1,
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

    it('skips an <inputReference> update that is neither $Record nor a typed record variable', async () => {
      // An AutoLaunchedFlow (no record-trigger <start>) whose update targets an
      // undeclared reference (not in <variables>) can't be resolved offline —
      // skip and warn.
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
          '<recordUpdates>[0] has no <object>; its <inputReference> is neither the trigger record ($Record) nor a typed record variable; skipped',
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

    it('surfaces every <actionCalls> {actionType, actionName} (apex AND non-apex) on the flow node (bundle-4 a)', async () => {
      // A non-apex actionCall (activateSessionPermSet) emits NO callsApex edge
      // — but it must still be identifiable. Without node.properties.actionCalls
      // explain_flow sees actionCalls:[] and cannot name the faultable element.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Activate Contact Delete Permission</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <actionCalls>
        <name>Activate_Session</name>
        <actionType>activateSessionPermSet</actionType>
        <actionName>Contact_Delete</actionName>
    </actionCalls>
    <actionCalls>
        <name>Call_Apex</name>
        <actionType>apex</actionType>
        <actionName>MyApexAction</actionName>
    </actionCalls>
</Flow>`;
      const { dir, path } = await writeTempXml('ActionCalls.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The non-apex call emits NO callsApex edge (a callsApex edge to an
        // ApexClass would be a lie for activateSessionPermSet).
        const callsApex = result.value.edges.filter(
          (e) => e.edgeType === 'callsApex',
        );
        expect(callsApex.map((e) => e.toId)).toEqual(['ApexClass:MyApexAction']);
        // But BOTH action calls are surfaced on the node, in source order, so
        // the consumer can identify activateSessionPermSet (a transient session
        // activation, not a PermissionSetAssignment insert).
        expect(result.value.nodes[0]?.properties['actionCalls']).toEqual([
          { actionType: 'activateSessionPermSet', actionName: 'Contact_Delete' },
          { actionType: 'apex', actionName: 'MyApexAction' },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults actionCalls to an empty list when the flow has none (bundle-4 a)', async () => {
      const { dir, path } = await writeTempXml('NoActions.flow-meta.xml', VALID_XML);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['actionCalls']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('surfaces an AsyncAfterCommit <scheduledPaths> path on the node (bundle-4 c)', async () => {
      // A record-triggered after-save flow with an immediate-async post-commit
      // scheduled path. explain_flow.buildFaultRollback reads runAsyncAfterCommit
      // / scheduledPathTypes to know the fault cannot roll back the committed save.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Contract Hours</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Contact</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
        <scheduledPaths>
            <name>run_async</name>
            <pathType>AsyncAfterCommit</pathType>
        </scheduledPaths>
    </start>
</Flow>`;
      const { dir, path } = await writeTempXml('AsyncPath.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['scheduledPathTypes']).toEqual(['AsyncAfterCommit']);
        expect(props?.['runAsyncAfterCommit']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('treats a time-based (non-async) scheduled path as not AsyncAfterCommit (bundle-4 c)', async () => {
      // A scheduled path with a real delay (no AsyncAfterCommit pathType) must
      // NOT flip runAsyncAfterCommit — only the immediate post-commit async path
      // qualifies for the async fault-rollback verdict.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Delayed Path</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Contact</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
        <scheduledPaths>
            <name>one_day_later</name>
            <offsetNumber>1</offsetNumber>
            <offsetUnit>Days</offsetUnit>
            <timeSource>RecordTriggerEvent</timeSource>
        </scheduledPaths>
    </start>
</Flow>`;
      const { dir, path } = await writeTempXml('DelayedPath.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        // No <pathType> declared → empty list, flag stays false.
        expect(props?.['scheduledPathTypes']).toEqual([]);
        expect(props?.['runAsyncAfterCommit']).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults scheduledPathTypes/runAsyncAfterCommit for a flow without <start> (bundle-4 c)', async () => {
      const { dir, path } = await writeTempXml('NoStart.flow-meta.xml', VALID_XML);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['scheduledPathTypes']).toEqual([]);
        expect(props?.['runAsyncAfterCommit']).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets hasImmediateConnector true when <start> has a direct <connector> (sync after-save)', async () => {
      // A record-triggered after-save flow whose <start> carries a direct
      // <connector> fires synchronously within the triggering transaction —
      // it belongs in post-save-flows, not post-save-async.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>61.0</apiVersion>
    <label>Sync After Save</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Account</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
        <connector>
            <targetReference>firstStep</targetReference>
        </connector>
    </start>
    <assignments>
        <name>firstStep</name>
        <label>First Step</label>
        <locationX>176</locationX>
        <locationY>134</locationY>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('SyncAfterSave.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['hasImmediateConnector']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets hasImmediateConnector false when <start> has only <scheduledPaths> (async-only)', async () => {
      // A record-triggered after-save flow whose <start> has ONLY
      // <scheduledPaths> and NO direct <connector> is a scheduled-only
      // (async) flow — it fires only via its time-offset paths and must be
      // placed in post-save-async, not post-save-flows.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>61.0</apiVersion>
    <label>Scheduled Only After Save</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Contact</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
        <scheduledPaths>
            <name>six_hours_later</name>
            <offsetNumber>6</offsetNumber>
            <offsetUnit>Hours</offsetUnit>
            <timeSource>RecordTriggerEvent</timeSource>
        </scheduledPaths>
    </start>
</Flow>`;
      const { dir, path } = await writeTempXml('ScheduledOnly.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['hasImmediateConnector']).toBe(false);
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

    it('keeps distinct DML operations on the SAME object as distinct edges (BUG 5)', async () => {
      // A Flow that does recordLookup + recordCreate + recordUpdate on ONE
      // object used to collapse to a single readsFrom + single writesTo,
      // because the dedup key was only (fromId,toId,edgeType,source) — the
      // first-emitted operation won and the rest vanished. The operation
      // dimension keeps each distinct DML operation as its own edge.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>DML Same Object</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <recordLookups>
        <name>Get_Ns__Obj__c</name>
        <object>Ns__Obj__c</object>
    </recordLookups>
    <recordCreates>
        <name>Create_Ns__Obj__c</name>
        <object>Ns__Obj__c</object>
    </recordCreates>
    <recordUpdates>
        <name>Update_Ns__Obj__c</name>
        <object>Ns__Obj__c</object>
    </recordUpdates>
</Flow>`;
      const { dir, path } = await writeTempXml('DmlSameObject.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const toObj = (e: { toId: string }) => e.toId === 'CustomObject:Ns__Obj__c';
        // Both writes survive: the create AND the update are distinct edges.
        const writes = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo' && toObj(e),
        );
        expect(
          writes.map((e) => e.properties?.['operation']).sort(),
        ).toEqual(['recordCreate', 'recordUpdate']);
        // Both reads survive: the lookup AND the update-read are distinct.
        const reads = result.value.edges.filter(
          (e) => e.edgeType === 'readsFrom' && toObj(e),
        );
        expect(
          reads.map((e) => e.properties?.['operation']).sort(),
        ).toEqual(['recordLookup', 'recordUpdate']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('still dedupes genuine same-operation duplicate writes to one object (BUG 5 guard)', async () => {
      // Two recordCreates on the SAME object share (from,to,type,source,operation)
      // — so they still collapse to a single object-level writesTo. The
      // operation dimension must not turn genuine duplicates into two edges.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Two Creates One Object</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <recordCreates>
        <name>Create_A</name>
        <object>Ns__Obj__c</object>
    </recordCreates>
    <recordCreates>
        <name>Create_B</name>
        <object>Ns__Obj__c</object>
    </recordCreates>
</Flow>`;
      const { dir, path } = await writeTempXml('TwoCreates.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const writes = result.value.edges.filter(
          (e) =>
            e.edgeType === 'writesTo' &&
            e.toId === 'CustomObject:Ns__Obj__c' &&
            e.properties?.['operation'] === 'recordCreate',
        );
        expect(writes).toHaveLength(1);
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

  // R6-02 — subflow references. A `<subflows>` element calls another Flow as a
  // subflow; each emits a `references` edge from the calling Flow to
  // `Flow:{flowName}` with confidence `declared` (the `<flowName>` is stated
  // metadata) and `properties.referenceKind: 'subflow'`. Before R6-02 subflows
  // were scoped out entirely, so NO flow→flow edge existed and a subflow called
  // by N parents read as having zero dependents (a false-"safe" deactivation
  // verdict). The target Flow may be dangling-by-design (a managed / uncaptured
  // subflow not in the vault) — the extractor emits the edge either way, exactly
  // as `callsApex` emits to a possibly-absent `ApexClass:{name}`.
  describe('R6-02 — subflow references', () => {
    it('emits one declared references edge per <subflows> element (resolvable + dangling)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Parent With Subflows</label>
    <processType>Flow</processType>
    <status>Active</status>
    <subflows>
        <name>Call_Send_Email</name>
        <label>Call: Send Email</label>
        <flowName>Send_Email_Subflow</flowName>
    </subflows>
    <subflows>
        <name>Call_Managed_Helper</name>
        <label>Call: Managed Helper</label>
        <flowName>mpns__Managed_Helper_Flow</flowName>
    </subflows>
</Flow>`;
      const { dir, path } = await writeTempXml('ParentWithSubflows.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const flowId = 'Flow:ParentWithSubflows';
        const subflowEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        // Both subflow elements emit an edge — the resolvable-looking target
        // and the managed (dangling-by-design) target are treated identically
        // by the extractor; resolvability is a graph-layer concern.
        expect(subflowEdges).toEqual([
          {
            fromId: flowId,
            toId: 'Flow:Send_Email_Subflow',
            edgeType: 'references',
            confidence: 'declared',
            source: 'flow-extractor',
            properties: {
              referenceKind: 'subflow',
              subflowElementName: 'Call_Send_Email',
            },
          },
          {
            fromId: flowId,
            toId: 'Flow:mpns__Managed_Helper_Flow',
            edgeType: 'references',
            confidence: 'declared',
            source: 'flow-extractor',
            properties: {
              referenceKind: 'subflow',
              subflowElementName: 'Call_Managed_Helper',
            },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('collapses two <subflows> pointing at the SAME target into one edge (dedup)', async () => {
      // A parent that calls the same subflow from two different call sites
      // dedups to one (fromId,toId,edgeType,source) edge; the first element's
      // name wins, matching how `callsApex` collapses repeat calls to one class.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Double Caller</label>
    <processType>Flow</processType>
    <status>Active</status>
    <subflows>
        <name>First_Call</name>
        <flowName>Shared_Subflow</flowName>
    </subflows>
    <subflows>
        <name>Second_Call</name>
        <flowName>Shared_Subflow</flowName>
    </subflows>
</Flow>`;
      const { dir, path } = await writeTempXml('DoubleCaller.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const subflowEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(subflowEdges).toHaveLength(1);
        expect(subflowEdges[0]?.toId).toBe('Flow:Shared_Subflow');
        expect(subflowEdges[0]?.properties['subflowElementName']).toBe(
          'First_Call',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('warns and skips a <subflows> element with no <flowName>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Bad Subflow</label>
    <processType>Flow</processType>
    <status>Active</status>
    <subflows>
        <name>Broken_Call</name>
        <label>Broken</label>
    </subflows>
</Flow>`;
      const { dir, path } = await writeTempXml('BadSubflow.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter((e) => e.edgeType === 'references'),
        ).toEqual([]);
        expect(
          result.value.nodes[0]?.properties['flowExtractionWarnings'],
        ).toContain('<subflows>[0] has no <flowName>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no references edge for a Flow without <subflows> (regression)', async () => {
      // A plain flow with no <subflows> must not gain a spurious references edge.
      const { dir, path } = await writeTempXml(
        'NoSubflow.flow-meta.xml',
        VALID_XML,
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter((e) => e.edgeType === 'references'),
        ).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('R7-W1 — record-variable <inputReference> DML', () => {
    it('emits an OBJECT-level declared writesTo with the whole-record disclosure for a recordCreate that inserts a record variable', async () => {
      // "Create Records → use a record/collection variable" carries an
      // <inputReference> (no <object>, no <inputAssignments>). Before R7-W1 this
      // emitted NO edge — a false-safe. Now the variable's declared objectType
      // is the write target; the fields are NOT enumerable, so we emit only the
      // object-level edge and disclose that.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Insert Cases</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <variables>
        <name>newCaseVar</name>
        <dataType>SObject</dataType>
        <isCollection>false</isCollection>
        <objectType>Case</objectType>
    </variables>
    <recordCreates>
        <name>Insert_Case</name>
        <inputReference>newCaseVar</inputReference>
    </recordCreates>
</Flow>`;
      const { dir, path } = await writeTempXml('InsertCases.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const flowId = 'Flow:InsertCases';
        const writes = result.value.edges.filter((e) => e.edgeType === 'writesTo');
        // ONE object-level edge, no field-level edges (whole-record write).
        expect(writes).toEqual([
          {
            fromId: flowId,
            toId: 'CustomObject:Case',
            edgeType: 'writesTo',
            confidence: 'declared',
            source: 'flow-extractor',
            properties: {
              operation: 'recordCreate',
              inputReferenceKind: 'recordVariable',
              inputReference: 'newCaseVar',
              wholeRecord: true,
              fieldsEnumerable: false,
              disclosure:
                'whole-record write; individual fields not enumerable from a record-variable DML',
            },
          },
        ]);
        // No fabricated per-field edges.
        expect(
          result.value.edges.filter((e) => e.toId.startsWith('CustomField:')),
        ).toEqual([]);
        // No skip warning — it resolved.
        expect(
          result.value.nodes[0]?.properties['flowExtractionWarnings'],
        ).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits declared readsFrom + writesTo for a recordUpdate on a record variable, with sourceObject provenance from a populating lookup', async () => {
      // "Update Records → use the IDs and all field values from a record
      // collection variable" that was populated by an earlier Get Records:
      // object-level edges only, declared, with object-level lookup provenance.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Update Fetched Accounts</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <variables>
        <name>fetchedAccount</name>
        <dataType>SObject</dataType>
        <isCollection>false</isCollection>
        <objectType>Account</objectType>
    </variables>
    <recordLookups>
        <name>Get_Account</name>
        <object>Account</object>
        <getFirstRecordOnly>true</getFirstRecordOnly>
        <outputReference>fetchedAccount</outputReference>
    </recordLookups>
    <recordUpdates>
        <name>Update_Account</name>
        <inputReference>fetchedAccount</inputReference>
    </recordUpdates>
</Flow>`;
      const { dir, path } = await writeTempXml('UpdateFetched.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const writeEdge = result.value.edges.find(
          (e) =>
            e.edgeType === 'writesTo' &&
            e.toId === 'CustomObject:Account' &&
            e.properties?.['operation'] === 'recordUpdate',
        );
        expect(writeEdge?.confidence).toBe('declared');
        // The write edge carries the verbatim whole-record disclosure AND the
        // object-level lookup provenance (Get_Account populated the variable).
        expect(writeEdge?.properties).toEqual({
          operation: 'recordUpdate',
          inputReferenceKind: 'recordVariable',
          inputReference: 'fetchedAccount',
          wholeRecord: true,
          fieldsEnumerable: false,
          sourceObject: 'Account',
          disclosure:
            'whole-record write; individual fields not enumerable from a record-variable DML',
        });
        // A readsFrom to Account exists (the read is represented). The
        // recordLookup readsFrom (operation: recordLookup) and the recordUpdate
        // readsFrom (operation: recordUpdate) now differ in the operation
        // dimension of the dedup key, so BOTH survive as distinct edges — the
        // recordLookup read is no longer masked by the update read.
        const accountReads = result.value.edges.filter(
          (e) => e.edgeType === 'readsFrom' && e.toId === 'CustomObject:Account',
        );
        expect(
          accountReads.map((e) => e.properties?.['operation']).sort(),
        ).toEqual(['recordLookup', 'recordUpdate']);
        // No fabricated field-level writes.
        expect(
          result.value.edges.filter(
            (e) => e.edgeType === 'writesTo' && e.toId.startsWith('CustomField:'),
          ),
        ).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a declared writesTo with the disclosure for a recordDelete on a record variable', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Delete Contacts</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <variables>
        <name>staleContacts</name>
        <dataType>SObject</dataType>
        <isCollection>true</isCollection>
        <objectType>Contact</objectType>
    </variables>
    <recordDeletes>
        <name>Delete_Contacts</name>
        <inputReference>staleContacts</inputReference>
    </recordDeletes>
</Flow>`;
      const { dir, path } = await writeTempXml('DeleteContacts.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([
          {
            fromId: 'Flow:DeleteContacts',
            toId: 'CustomObject:Contact',
            edgeType: 'writesTo',
            confidence: 'declared',
            source: 'flow-extractor',
            properties: {
              operation: 'recordDelete',
              inputReferenceKind: 'recordVariable',
              inputReference: 'staleContacts',
              wholeRecord: true,
              fieldsEnumerable: false,
              disclosure:
                'whole-record write; individual fields not enumerable from a record-variable DML',
            },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves the $Record trigger-record inputReference path unchanged (heuristic, no whole-record props)', async () => {
      // Regression guard: the existing $Record update path (bug 17) must NOT
      // gain any R7-W1 whole-record props — that would break the golden.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Before Save Stamp</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Widget__c</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <recordUpdates>
        <name>Stamp_Fields</name>
        <inputReference>$Record</inputReference>
        <inputAssignments>
            <field>Verified_Flag__c</field>
            <value><stringValue>Verified</stringValue></value>
        </inputAssignments>
    </recordUpdates>
</Flow>`;
      const { dir, path } = await writeTempXml('BeforeSaveStamp.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const objEdges = result.value.edges.filter(
          (e) =>
            e.toId === 'CustomObject:Widget__c' &&
            e.properties?.['operation'] === 'recordUpdate',
        );
        for (const e of objEdges) {
          expect(e.confidence).toBe('heuristic');
          // Byte-identical to pre-R7: only { operation }.
          expect(e.properties).toEqual({ operation: 'recordUpdate' });
        }
        // The inputAssignment field write is still emitted (fields ARE
        // enumerable for a $Record update).
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'writesTo' &&
              e.toId === 'CustomField:Widget__c.Verified_Flag__c',
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('R7-W2 — before-save $Record.<Field> assignment writes', () => {
    it('emits a declared FIELD-level writesTo for a before-save $Record.<Field> literal assignment', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Stamp Status</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Case</object>
        <recordTriggerType>Create</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <assignments>
        <name>Set_Status</name>
        <assignmentItems>
            <assignToReference>$Record.Status</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>New</stringValue></value>
        </assignmentItems>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('StampStatus.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fieldWrite = result.value.edges.find(
          (e) =>
            e.edgeType === 'writesTo' &&
            e.toId === 'CustomField:Case.Status',
        );
        expect(fieldWrite).toEqual({
          fromId: 'Flow:StampStatus',
          toId: 'CustomField:Case.Status',
          edgeType: 'writesTo',
          confidence: 'declared',
          source: 'flow-extractor',
          properties: {
            operation: 'beforeSaveFieldAssignment',
            assignedValue: 'New',
            assignedValueKind: 'literal',
          },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('traces a before-save $Record.<Field> reference assignment to its source field and emits the symmetric dataflow readsFrom', async () => {
      // $Record.Combined_Name__c = {!$Record.Given_Part__c} — a reference-valued
      // assignment. The write is declared; the value traces to Given_Part__c
      // (declared) and a symmetric readsFrom(dataflowSource) is emitted so
      // field_lineage walks THROUGH the flow. Also exercises the {! } wrapper.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Copy Name</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Contact</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <assignments>
        <name>Copy</name>
        <assignmentItems>
            <assignToReference>{!$Record.Combined_Name__c}</assignToReference>
            <operator>Assign</operator>
            <value><elementReference>$Record.Given_Part__c</elementReference></value>
        </assignmentItems>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('CopyName.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const flowId = 'Flow:CopyName';
        const write = result.value.edges.find(
          (e) =>
            e.edgeType === 'writesTo' &&
            e.toId === 'CustomField:Contact.Combined_Name__c',
        );
        expect(write?.confidence).toBe('declared');
        expect(write?.properties).toEqual({
          operation: 'beforeSaveFieldAssignment',
          assignedValue: '$Record.Given_Part__c',
          assignedValueKind: 'reference',
          sourceFields: ['Contact.Given_Part__c'],
          sourceFieldConfidence: ['declared'],
          unresolvedSourceCount: 0,
        });
        // Symmetric dataflow readsFrom on the source field.
        const readEdge = result.value.edges.find(
          (e) =>
            e.edgeType === 'readsFrom' &&
            e.toId === 'CustomField:Contact.Given_Part__c',
        );
        expect(readEdge).toEqual({
          fromId: flowId,
          toId: 'CustomField:Contact.Given_Part__c',
          edgeType: 'readsFrom',
          confidence: 'declared',
          source: 'flow-extractor',
          properties: {
            operation: 'dataflowSource',
            targetFields: ['Contact.Combined_Name__c'],
          },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('demotes the traced source confidence to heuristic for a non-Assign ($Record) operator', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Accumulate</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Account</object>
        <recordTriggerType>Update</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <assignments>
        <name>Add_Amount</name>
        <assignmentItems>
            <assignToReference>$Record.Running_Total__c</assignToReference>
            <operator>Add</operator>
            <value><elementReference>$Record.Increment__c</elementReference></value>
        </assignmentItems>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('Accumulate.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const write = result.value.edges.find(
          (e) =>
            e.edgeType === 'writesTo' &&
            e.toId === 'CustomField:Account.Running_Total__c',
        );
        // The WRITE is still declared (it definitely happens); the SOURCE trace
        // is demoted to heuristic (Add is not a clean copy).
        expect(write?.confidence).toBe('declared');
        expect(write?.properties?.['sourceFieldConfidence']).toEqual([
          'heuristic',
        ]);
        const readEdge = result.value.edges.find(
          (e) =>
            e.edgeType === 'readsFrom' &&
            e.toId === 'CustomField:Account.Increment__c',
        );
        expect(readEdge?.confidence).toBe('heuristic');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does NOT emit a write for an after-save $Record assignment; discloses it as in-memory only', async () => {
      // Salesforce semantics: in an AFTER-save flow, assigning $Record.<Field>
      // mutates only the in-memory copy — it does NOT persist without an
      // explicit Update Records on $Record. So no writesTo, but disclosed.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>After Save Set</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Case</object>
        <recordTriggerType>Create</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <assignments>
        <name>Set_Field</name>
        <assignmentItems>
            <assignToReference>$Record.Status</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>New</stringValue></value>
        </assignmentItems>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('AfterSaveSet.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // No field write to Case.Status.
        expect(
          result.value.edges.some(
            (e) => e.toId === 'CustomField:Case.Status',
          ),
        ).toBe(false);
        const warnings =
          (result.value.nodes[0]?.properties['flowExtractionWarnings'] as
            | readonly string[]
            | undefined) ?? [];
        expect(
          warnings.some(
            (w) =>
              w.includes('RecordAfterSave') &&
              w.includes('in-memory only') &&
              w.includes('no writesTo edge emitted'),
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('skips $Record__Prior and relationship-traversal assignment targets, disclosing the count', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Odd Targets</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Contact</object>
        <recordTriggerType>Update</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <assignments>
        <name>Odd</name>
        <assignmentItems>
            <assignToReference>$Record.Account.Name</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>x</stringValue></value>
        </assignmentItems>
        <assignmentItems>
            <assignToReference>$Record.Email</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>a@b.co</stringValue></value>
        </assignmentItems>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('OddTargets.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Only the direct Email write is emitted.
        const fieldWrites = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo' && e.toId.startsWith('CustomField:'),
        );
        expect(fieldWrites.map((e) => e.toId)).toEqual([
          'CustomField:Contact.Email',
        ]);
        const warnings =
          (result.value.nodes[0]?.properties['flowExtractionWarnings'] as
            | readonly string[]
            | undefined) ?? [];
        expect(
          warnings.some(
            (w) =>
              w.includes('relationship path') &&
              w.includes('not direct trigger-record field writes'),
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('discloses when a before-save flow assigns $Record fields but <start> has no <object>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>No Object</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <assignments>
        <name>Set</name>
        <assignmentItems>
            <assignToReference>$Record.Status</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>New</stringValue></value>
        </assignmentItems>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('NoObject.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some((e) => e.toId.startsWith('CustomField:')),
        ).toBe(false);
        const warnings =
          (result.value.nodes[0]?.properties['flowExtractionWarnings'] as
            | readonly string[]
            | undefined) ?? [];
        expect(
          warnings.some(
            (w) =>
              w.includes('trigger object unknown') &&
              w.includes('no field writesTo edge emitted'),
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no extra edges for a before-save flow with neither an inputReference DML nor a $Record assignment', async () => {
      // Control: a before-save flow that only does a decision — the R7
      // productions must add nothing.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Just Decide</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Lead</object>
        <recordTriggerType>Create</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <assignments>
        <name>Set_Local</name>
        <assignmentItems>
            <assignToReference>localVar</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>x</stringValue></value>
        </assignmentItems>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('JustDecide.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // A local-variable assignment ($Record NOT involved) produces no field
        // writes and no disclosure.
        expect(
          result.value.edges.filter((e) => e.edgeType === 'writesTo'),
        ).toEqual([]);
        expect(
          result.value.nodes[0]?.properties['flowExtractionWarnings'],
        ).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('BUG-3 — after-save $Record persistence gating', () => {
    // The precondition the pre-fix code named in its warning but never checked:
    // in an AFTER-save flow an in-memory `$Record.<Field>` assignment persists
    // ONLY when the flow ALSO runs an explicit Update Records on $Record. With
    // that recordUpdates present the field write is emitted at HEURISTIC
    // confidence; without it, NO edge is emitted and the skip is disclosed.
    const afterSaveXml = (withUpdate: boolean): string => `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Persist After Save</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Ns__Obj__c</object>
        <recordTriggerType>Create</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <assignments>
        <name>Set_Field</name>
        <assignmentItems>
            <assignToReference>$Record.My_Field__c</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>Done</stringValue></value>
        </assignmentItems>
    </assignments>${
      withUpdate
        ? `
    <recordUpdates>
        <name>Save_Record</name>
        <inputReference>$Record</inputReference>
    </recordUpdates>`
        : ''
    }
</Flow>`;

    it('(a) emits a HEURISTIC field write when an after-save flow updates $Record downstream', async () => {
      const { dir, path } = await writeTempXml(
        'PersistAfterSave.flow-meta.xml',
        afterSaveXml(true),
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fieldWrite = result.value.edges.find(
          (e) =>
            e.edgeType === 'writesTo' &&
            e.toId === 'CustomField:Ns__Obj__c.My_Field__c',
        );
        expect(fieldWrite).toBeDefined();
        expect(fieldWrite?.confidence).toBe('heuristic');
        expect(fieldWrite?.properties?.['operation']).toBe(
          'beforeSaveFieldAssignment',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('(b) emits NO field write and discloses "in-memory only" when the after-save flow does NOT update $Record', async () => {
      const { dir, path } = await writeTempXml(
        'NoPersistAfterSave.flow-meta.xml',
        afterSaveXml(false),
      );
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some(
            (e) => e.toId === 'CustomField:Ns__Obj__c.My_Field__c',
          ),
        ).toBe(false);
        const warnings =
          (result.value.nodes[0]?.properties['flowExtractionWarnings'] as
            | readonly string[]
            | undefined) ?? [];
        expect(
          warnings.some(
            (w) =>
              w.includes('RecordAfterSave') &&
              w.includes('in-memory only') &&
              w.includes('no writesTo edge emitted'),
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('(c) still emits a DECLARED field write on the before-save path (no downstream update needed)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Before Save Stamp</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Ns__Obj__c</object>
        <recordTriggerType>Create</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <assignments>
        <name>Set_Field</name>
        <assignmentItems>
            <assignToReference>$Record.My_Field__c</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>Done</stringValue></value>
        </assignmentItems>
    </assignments>
</Flow>`;
      const { dir, path } = await writeTempXml('BeforeSaveStamp.flow-meta.xml', xml);
      try {
        const result = await extractFlow(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fieldWrite = result.value.edges.find(
          (e) =>
            e.edgeType === 'writesTo' &&
            e.toId === 'CustomField:Ns__Obj__c.My_Field__c',
        );
        expect(fieldWrite).toBeDefined();
        expect(fieldWrite?.confidence).toBe('declared');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

// CUSTOM-LABEL-USAGES-MISS-FLOW-LABEL-REFS: `$Label.{ApiName}` refs in Active
// flow formulas were invisible to the graph, so CustomLabel usages / the change
// gate read the label as unused. extractFlow must now emit Flow → CustomLabel.
describe('extractFlow — $Label references → CustomLabel edges (CUSTOM-LABEL-USAGES-MISS-FLOW-LABEL-REFS)', () => {
  it('emits a heuristic references edge to each Custom Label a formula references', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Sample Case Flow</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <formulas>
        <name>SampleRtId</name>
        <dataType>String</dataType>
        <expression>{!$Label.Sample_Label}</expression>
    </formulas>
    <formulas>
        <name>SampleRtIdTwo</name>
        <dataType>String</dataType>
        <expression>{!$Label.Sample_Label_Two}</expression>
    </formulas>
</Flow>`;
    const { dir, path } = await writeTempXml('Sample_Case_Flow.flow-meta.xml', xml);
    try {
      const result = await extractFlow(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const flowId = 'Flow:Sample_Case_Flow';
      const labelEdges = result.value.edges.filter(
        (e) => e.edgeType === 'references' && e.toId.startsWith('CustomLabel:'),
      );
      expect(labelEdges.map((e) => e.toId).sort()).toEqual([
        'CustomLabel:Sample_Label',
        'CustomLabel:Sample_Label_Two',
      ]);
      const one = labelEdges.find(
        (e) => e.toId === 'CustomLabel:Sample_Label',
      );
      expect(one?.fromId).toBe(flowId);
      expect(one?.confidence).toBe('heuristic');
      expect(one?.properties['referenceKind']).toBe('flowLabelRef');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits no CustomLabel edge for a flow with no $Label references', async () => {
    const { dir, path } = await writeTempXml('Plain.flow-meta.xml', VALID_XML);
    try {
      const result = await extractFlow(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.value.edges.some((e) => e.toId.startsWith('CustomLabel:')),
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
