/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractWorkflowRule } from '../src/workflow-rule.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const ACCOUNT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/workflows/Account.workflow-meta.xml';
const ACCOUNT_GOLDEN_REL =
  'tests/golden/extractor-workflow-rule/Account.json';
const OPPORTUNITY_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/workflows/Opportunity.workflow-meta.xml';
const OPPORTUNITY_GOLDEN_REL =
  'tests/golden/extractor-workflow-rule/Opportunity.json';

/**
 * Write `content` to a `{stem}.workflow-meta.xml` file under a fresh
 * temp directory. Returns the temp-dir root (for cleanup) and the
 * absolute file path.
 */
const writeTempWorkflowXml = async (
  stem: string,
  content: string,
): Promise<{ readonly dir: string; readonly path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-workflow-rule-'));
  const path = join(dir, `${stem}.workflow-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractWorkflowRule', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Account (multi-rule with alert + field-update)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, ACCOUNT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, ACCOUNT_GOLDEN_REL);

      const result = await extractWorkflowRule(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
      // The Account fixture has 2 rules; sanity-check edge mix.
      // v2.0a — also filter to `WorkflowRule` nodes because each
      // rule produces a sibling synthetic `ConditionalContext` node.
      expect(
        result.value.nodes.filter((n) => n.type === 'WorkflowRule'),
      ).toHaveLength(2);
      expect(
        result.value.edges.filter((e) => e.edgeType === 'parentOf'),
      ).toHaveLength(2);
      expect(
        result.value.edges.filter((e) => e.edgeType === 'triggersOn'),
      ).toHaveLength(2);
      expect(
        result.value.edges.filter((e) => e.edgeType === 'sendsEmail'),
      ).toHaveLength(1);
    });

    itHarness('produces the golden output for Opportunity (single rule, no alerts)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, OPPORTUNITY_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, OPPORTUNITY_GOLDEN_REL);

      const result = await extractWorkflowRule(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
      // Opportunity is the minimal case: 1 rule node + 1 synthetic
      // ConditionalContext (the rule has a formula). The base
      // parentOf + triggersOn pair is the same as before; the
      // firesWhen edge is the new arrival.
      expect(
        result.value.nodes.filter((n) => n.type === 'WorkflowRule'),
      ).toHaveLength(1);
      expect(
        result.value.nodes.filter((n) => n.type === 'ConditionalContext'),
      ).toHaveLength(1);
      expect(result.value.edges).toHaveLength(3);
    });
  });

  describe('action resolution and edge emission', () => {
    it('emits callsApex (not references) for Apex action targets', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Run_Apex</fullName>
    <actions>
      <name>MyHandler</name>
      <type>Apex</type>
    </actions>
    <active>true</active>
    <triggerType>onCreateOnly</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const apexEdges = result.value.edges.filter(
          (e) => e.edgeType === 'callsApex',
        );
        expect(apexEdges).toHaveLength(1);
        expect(apexEdges[0]!.toId).toBe('ApexClass:MyHandler');
        // No `references` edge to an ApexClass; just `callsApex`.
        expect(
          result.value.edges.filter(
            (e) => e.edgeType === 'references' && e.toId.startsWith('ApexClass:'),
          ),
        ).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('omits sendsEmail when the alert action references a non-existent alert', async () => {
      // Per WorkflowRule.md: a rule's Alert action whose `<name>` is not
      // present in `<alerts>` produces a dangling `references` to
      // `WorkflowAlert:...` and NO `sendsEmail` edge.
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Dangling_Alert</fullName>
    <actions>
      <name>Deleted_Alert</name>
      <type>Alert</type>
    </actions>
    <active>true</active>
    <triggerType>onCreateOnly</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const alertRefs = result.value.edges.filter(
          (e) => e.edgeType === 'references' && e.toId.startsWith('WorkflowAlert:'),
        );
        expect(alertRefs).toHaveLength(1);
        expect(alertRefs[0]!.toId).toBe('WorkflowAlert:Account.Deleted_Alert');
        expect(
          result.value.edges.filter((e) => e.edgeType === 'sendsEmail'),
        ).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('deduplicates duplicate (rule, target, edgeType) action triples', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Dup_Actions</fullName>
    <actions>
      <name>Run_FU</name>
      <type>FieldUpdate</type>
    </actions>
    <actions>
      <name>Run_FU</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fuRefs = result.value.edges.filter(
          (e) => e.toId === 'WorkflowFieldUpdate:Account.Run_FU',
        );
        expect(fuRefs).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('silently ignores deprecated Send actions and unknown action types', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Mixed_Actions</fullName>
    <actions>
      <name>Old_Send</name>
      <type>Send</type>
    </actions>
    <actions>
      <name>Unknown_Action</name>
      <type>SomeNewTypeNotInTable</type>
    </actions>
    <actions>
      <name>Real_FU</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Only the FieldUpdate produces a `references` edge — Send and
        // unknown variants are silently dropped per the doc.
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.toId).toBe('WorkflowFieldUpdate:Account.Real_FU');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('happy-path empty file', () => {
    it('returns zero nodes and edges when <Workflow> has no <rules>', async () => {
      // Per WorkflowRule.md, a `<Workflow>` root with only orphan
      // `<alerts>` / `<fieldUpdates>` collections is the documented
      // happy path — the extractor returns zero nodes and zero edges.
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <alerts>
    <fullName>Orphan_Alert</fullName>
    <template>Sales/Template</template>
  </alerts>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(0);
        expect(result.value.edges).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('CR-05 — FieldUpdate field-level writesTo edge', () => {
    it('emits a field-level writesTo to the CustomField a FieldUpdate sets (KEEP references + ADD writesTo)', async () => {
      // A rule's <actions><name> names a field-update; the target field
      // lives in the sibling top-level <fieldUpdates> collection. The
      // extractor must resolve the join and emit BOTH the existing
      // `references` -> WorkflowFieldUpdate scaffolding node AND a new
      // field-level `writesTo` -> CustomField:{Object}.{field}.
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Foo</fullName>
    <field>Foo__c</field>
    <name>Set Foo</name>
    <operation>Literal</operation>
  </fieldUpdates>
  <rules>
    <fullName>Set_Foo_Rule</fullName>
    <actions>
      <name>Set_Foo</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The new field-level writesTo edge.
        const writesTo = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo',
        );
        expect(writesTo).toHaveLength(1);
        expect(writesTo[0]).toEqual({
          fromId: 'WorkflowRule:Account.Set_Foo_Rule',
          toId: 'CustomField:Account.Foo__c',
          edgeType: 'writesTo',
          confidence: 'parsed',
          source: 'workflow-rule-extractor',
          properties: { operation: 'Literal' },
        });
        // CO-EXISTENCE: the existing references edge to the scaffolding
        // node is STILL present (KEEP + ADD contract). Exactly two
        // FieldUpdate-derived edges from the rule.
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.toId).toBe('WorkflowFieldUpdate:Account.Set_Foo');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('object-scopes a bare same-object field name (standard field)', async () => {
      // A bare <field> (e.g. a standard field like Description) is
      // object-scoped to the rule's object; a dangling/targetMissing
      // edge to a not-modeled standard field is harmless by design.
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Stamp_Desc</fullName>
    <field>Description</field>
    <operation>Formula</operation>
  </fieldUpdates>
  <rules>
    <fullName>Stamp_Desc_Rule</fullName>
    <actions>
      <name>Stamp_Desc</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onCreateOnly</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const writesTo = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo',
        );
        expect(writesTo).toHaveLength(1);
        expect(writesTo[0]!.toId).toBe('CustomField:Account.Description');
        expect(writesTo[0]!.properties).toEqual({ operation: 'Formula' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('takes a dotted field name verbatim (does not double-scope)', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Pkg</fullName>
    <field>ns__Target__c.Bar__c</field>
    <operation>Literal</operation>
  </fieldUpdates>
  <rules>
    <fullName>Set_Pkg_Rule</fullName>
    <actions>
      <name>Set_Pkg</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const writesTo = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo',
        );
        expect(writesTo).toHaveLength(1);
        expect(writesTo[0]!.toId).toBe('CustomField:ns__Target__c.Bar__c');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('CR-P3-5: SKIPS the writesTo for a cross-object FieldUpdate (<targetObject> present), keeping only references', async () => {
      // Real Salesforce cross-object format: a BARE <field> (the leaf field on
      // the RELATED object) plus <targetObject> (the relationship reference). The
      // relationship→object map is not resolvable offline, so minting any
      // CustomField id here would be a relationship-scoped phantom. The honest
      // result is NO writesTo — but the references edge to the WorkflowFieldUpdate
      // scaffolding node STILL emits, so the action is not silently dropped.
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Stamp_Parent</fullName>
    <field>Total__c</field>
    <targetObject>Contact</targetObject>
    <operation>Formula</operation>
  </fieldUpdates>
  <rules>
    <fullName>Stamp_Parent_Rule</fullName>
    <actions>
      <name>Stamp_Parent</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // No writesTo — no phantom CustomField for the cross-object target.
        const writesTo = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo',
        );
        expect(writesTo).toHaveLength(0);
        // The references edge to the scaffolding node still emits.
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.toId).toBe('WorkflowFieldUpdate:Account.Stamp_Parent');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('CR-P3-5: same-object FieldUpdate (no <targetObject>) still emits the object-scoped writesTo', async () => {
      // Regression guard: the cross-object skip must NOT touch the same-object
      // path — a bare <field> with no <targetObject> stays object-scoped.
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Local</fullName>
    <field>Foo__c</field>
    <operation>Literal</operation>
  </fieldUpdates>
  <rules>
    <fullName>Set_Local_Rule</fullName>
    <actions>
      <name>Set_Local</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const writesTo = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo',
        );
        expect(writesTo).toHaveLength(1);
        expect(writesTo[0]!.toId).toBe('CustomField:Account.Foo__c');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits NO writesTo when the FieldUpdate has no matching <fieldUpdates> entry or no <field>', async () => {
      // Two failure modes: (a) action names a field-update with no
      // matching <fieldUpdates> entry; (b) the matching entry lacks a
      // <field>. Both yield only the references edge, no writesTo —
      // mirrors flow.ts skip-on-missing-field.
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>No_Field_FU</fullName>
    <operation>Null</operation>
  </fieldUpdates>
  <rules>
    <fullName>Missing_Rule</fullName>
    <actions>
      <name>Not_In_Collection</name>
      <type>FieldUpdate</type>
    </actions>
    <actions>
      <name>No_Field_FU</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter((e) => e.edgeType === 'writesTo'),
        ).toHaveLength(0);
        // The references edges to the scaffolding nodes still emit.
        expect(
          result.value.edges.filter((e) => e.edgeType === 'references'),
        ).toHaveLength(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits ONE writesTo when a rule lists the same FieldUpdate twice (per-rule dedup)', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Foo</fullName>
    <field>Foo__c</field>
    <operation>Literal</operation>
  </fieldUpdates>
  <rules>
    <fullName>Dup_FU_Rule</fullName>
    <actions>
      <name>Set_Foo</name>
      <type>FieldUpdate</type>
    </actions>
    <actions>
      <name>Set_Foo</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter((e) => e.edgeType === 'writesTo'),
        ).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits two writesTo edges when two distinct rules reference the same fieldUpdate', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Foo</fullName>
    <field>Foo__c</field>
    <operation>Literal</operation>
  </fieldUpdates>
  <rules>
    <fullName>Rule_A</fullName>
    <actions>
      <name>Set_Foo</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
  <rules>
    <fullName>Rule_B</fullName>
    <actions>
      <name>Set_Foo</name>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const writesTo = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo',
        );
        expect(writesTo).toHaveLength(2);
        const fromIds = writesTo.map((e) => e.fromId).sort();
        expect(fromIds).toEqual([
          'WorkflowRule:Account.Rule_A',
          'WorkflowRule:Account.Rule_B',
        ]);
        // Both land on the same field.
        expect(
          writesTo.every((e) => e.toId === 'CustomField:Account.Foo__c'),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('v2.8 — OutboundMessage promotion', () => {
    it('promotes each <outboundMessages> child to an OutboundMessage node + parentOf edge', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <outboundMessages>
    <fullName>Send_Order_To_Warehouse</fullName>
    <endpointUrl>https://warehouse.example.com/inbound</endpointUrl>
    <includeSessionId>true</includeSessionId>
    <useDeadLetterQueue>false</useDeadLetterQueue>
    <integrationUser>integration@example.com</integrationUser>
    <fields>Id</fields>
    <fields>Name</fields>
    <fields>Amount</fields>
  </outboundMessages>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const omNodes = result.value.nodes.filter(
          (n) => n.type === 'OutboundMessage',
        );
        expect(omNodes).toHaveLength(1);
        const node = omNodes[0]!;
        expect(node.id).toBe('OutboundMessage:Account.Send_Order_To_Warehouse');
        expect(node.apiName).toBe('Account.Send_Order_To_Warehouse');
        expect(node.label).toBe('Send_Order_To_Warehouse');
        expect(node.parentId).toBe('CustomObject:Account');
        expect(node.properties.name).toBe('Send_Order_To_Warehouse');
        expect(node.properties.endpointUrl).toBe(
          'https://warehouse.example.com/inbound',
        );
        expect(node.properties.includeSessionId).toBe(true);
        expect(node.properties.useDeadLetterQueue).toBe(false);
        expect(node.properties.integrationUser).toBe('integration@example.com');
        expect(node.properties.fields).toEqual(['Id', 'Name', 'Amount']);
        // parentOf edge emitted from CustomObject to the OutboundMessage.
        const parentEdges = result.value.edges.filter(
          (e) =>
            e.edgeType === 'parentOf' &&
            e.fromId === 'CustomObject:Account' &&
            e.toId === 'OutboundMessage:Account.Send_Order_To_Warehouse',
        );
        expect(parentEdges).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('promotes multiple <outboundMessages> children in one file', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <outboundMessages>
    <fullName>One</fullName>
    <endpointUrl>https://one.example.com</endpointUrl>
  </outboundMessages>
  <outboundMessages>
    <fullName>Two</fullName>
    <endpointUrl>https://two.example.com</endpointUrl>
  </outboundMessages>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Contact', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const omNodes = result.value.nodes.filter(
          (n) => n.type === 'OutboundMessage',
        );
        expect(omNodes).toHaveLength(2);
        const ids = omNodes.map((n) => n.id);
        expect(ids).toContain('OutboundMessage:Contact.One');
        expect(ids).toContain('OutboundMessage:Contact.Two');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('silently skips <outboundMessages> entries lacking a <fullName>', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <outboundMessages>
    <endpointUrl>https://nameless.example.com</endpointUrl>
  </outboundMessages>
  <outboundMessages>
    <fullName>HasName</fullName>
    <endpointUrl>https://has-name.example.com</endpointUrl>
  </outboundMessages>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Lead', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const omNodes = result.value.nodes.filter(
          (n) => n.type === 'OutboundMessage',
        );
        expect(omNodes).toHaveLength(1);
        expect(omNodes[0]?.id).toBe('OutboundMessage:Lead.HasName');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits an OutboundMessage even when the file has no <rules>', async () => {
      // A workflow file with only an `<outboundMessages>` collection is
      // the v2.8 orphan-collection happy path — the extractor now
      // promotes the outbound message regardless of whether any rule
      // consumes it.
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <outboundMessages>
    <fullName>Standalone</fullName>
    <endpointUrl>https://standalone.example.com</endpointUrl>
  </outboundMessages>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Opportunity', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const omNodes = result.value.nodes.filter(
          (n) => n.type === 'OutboundMessage',
        );
        expect(omNodes).toHaveLength(1);
        expect(omNodes[0]?.id).toBe('OutboundMessage:Opportunity.Standalone');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults missing boolean and integrationUser properties to false / null', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <outboundMessages>
    <fullName>Minimal</fullName>
    <endpointUrl>https://minimal.example.com</endpointUrl>
  </outboundMessages>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes.find(
          (n) => n.type === 'OutboundMessage',
        );
        expect(node?.properties.includeSessionId).toBe(false);
        expect(node?.properties.useDeadLetterQueue).toBe(false);
        expect(node?.properties.integrationUser).toBeNull();
        expect(node?.properties.fields).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a rule OutboundMessage action references edge to the promoted node id', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <outboundMessages>
    <fullName>Send_Order_To_Warehouse</fullName>
    <endpointUrl>https://warehouse.example.com/inbound</endpointUrl>
  </outboundMessages>
  <rules>
    <fullName>NotifyWarehouseOnOrder</fullName>
    <active>true</active>
    <triggerType>onCreateOnly</triggerType>
    <actions>
      <name>Send_Order_To_Warehouse</name>
      <type>OutboundMessage</type>
    </actions>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const omId = 'OutboundMessage:Account.Send_Order_To_Warehouse';
        const ruleId = 'WorkflowRule:Account.NotifyWarehouseOnOrder';
        const actionEdge = result.value.edges.find(
          (e) =>
            e.edgeType === 'references' &&
            e.fromId === ruleId &&
            e.toId === omId,
        );
        expect(actionEdge).toBeDefined();
        expect(actionEdge!.properties.actionType).toBe('OutboundMessage');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('v2.0a — ConditionalContext extraction', () => {
    it('emits a ConditionalContext + firesWhen edge for a criteria-based rule', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Tier1_Watcher</fullName>
    <active>true</active>
    <criteriaItems>
      <field>Account.Type</field>
      <operation>equals</operation>
      <value>Tier 1</value>
    </criteriaItems>
    <triggerType>onCreateOnly</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const ruleNode = result.value.nodes.find(
          (n) => n.type === 'WorkflowRule',
        );
        expect(ruleNode).toBeDefined();
        // Property mirror is populated. The mirror carries the
        // canonical `fieldRefs` ComponentId list per
        // ConditionalContextSemantics.md — the same array surfaced on
        // the ConditionalContext node's properties.
        expect(ruleNode!.properties.conditions).toEqual([
          {
            kind: 'criteria',
            conditionContextId:
              'ConditionalContext:WorkflowRule:Account.Tier1_Watcher.condition-0',
            expression: 'Account.Type equals Tier 1',
            fieldRefs: ['CustomField:Account.Type'],
          },
        ]);
        // ConditionalContext node emitted.
        const conditionNode = result.value.nodes.find(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNode).toBeDefined();
        expect(conditionNode!.id).toBe(
          'ConditionalContext:WorkflowRule:Account.Tier1_Watcher.condition-0',
        );
        // firesWhen edge emitted, declared confidence for criteria.
        const firesWhen = result.value.edges.find(
          (e) => e.edgeType === 'firesWhen',
        );
        expect(firesWhen).toBeDefined();
        expect(firesWhen!.fromId).toBe('WorkflowRule:Account.Tier1_Watcher');
        expect(firesWhen!.toId).toBe(conditionNode!.id);
        expect(firesWhen!.confidence).toBe('declared');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a formula-kind ConditionalContext with parsed confidence', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Formula_Rule</fullName>
    <active>true</active>
    <formula>AND(Amount &gt; 100000, IsClosed = false)</formula>
    <triggerType>onCreateOrTriggeringUpdate</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Opportunity', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const firesWhen = result.value.edges.find(
          (e) => e.edgeType === 'firesWhen',
        );
        expect(firesWhen).toBeDefined();
        expect(firesWhen!.confidence).toBe('parsed');
        expect(firesWhen!.properties.kind).toBe('formula');
        const conditionNode = result.value.nodes.find(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNode!.properties.fieldRefs).toEqual([
          'CustomField:Opportunity.Amount',
          'CustomField:Opportunity.IsClosed',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no ConditionalContext for a rule with neither criteria nor formula', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Always_Fires</fullName>
    <active>true</active>
    <triggerType>onCreateOnly</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.nodes.filter((n) => n.type === 'ConditionalContext'),
        ).toHaveLength(0);
        expect(
          result.value.edges.filter((e) => e.edgeType === 'firesWhen'),
        ).toHaveLength(0);
        const ruleNode = result.value.nodes.find(
          (n) => n.type === 'WorkflowRule',
        );
        expect(ruleNode!.properties.conditions).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.workflow-meta.xml';
      const result = await extractWorkflowRule(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempWorkflowXml(
        'Account',
        '<?xml version="1.0"?><Workflow><rules></wrong></Workflow>',
      );
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <Workflow>', async () => {
      const { dir, path } = await writeTempWorkflowXml(
        'Account',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <Workflow> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a rule is missing <fullName>', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <active>true</active>
    <triggerType>onCreateOnly</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <fullName>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a rule has an invalid triggerType', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Bad_Trigger</fullName>
    <active>true</active>
    <triggerType>onSometimesMaybe</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'invalid triggerType: onSometimesMaybe',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when an action is missing <name>', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Headless_Action</fullName>
    <actions>
      <type>FieldUpdate</type>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <name>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when an action is missing <type>', async () => {
      const xml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <rules>
    <fullName>Typeless_Action</fullName>
    <actions>
      <name>SomeName</name>
    </actions>
    <active>true</active>
    <triggerType>onAllChanges</triggerType>
  </rules>
</Workflow>`;
      const { dir, path } = await writeTempWorkflowXml('Account', xml);
      try {
        const result = await extractWorkflowRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <type>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
