/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractApprovalProcess } from '../src/approval-process.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const CREDIT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/approvalProcesses/Account.Credit_Review.approvalProcess-meta.xml';
const CREDIT_GOLDEN_REL =
  'tests/golden/extractor-approval-process/Account.Credit_Review.json';
const DISCOUNT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/approvalProcesses/Opportunity.Discount_Approval.approvalProcess-meta.xml';
const DISCOUNT_GOLDEN_REL =
  'tests/golden/extractor-approval-process/Opportunity.Discount_Approval.json';

/**
 * Write `content` to an `{stem}.approvalProcess-meta.xml` file under a
 * fresh `approvalProcesses/` subdirectory inside a temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempApprovalXml = async (
  stem: string,
  content: string,
): Promise<{ readonly dir: string; readonly path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-approval-process-'));
  const subdir = join(dir, 'approvalProcesses');
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, `${stem}.approvalProcess-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * CR-CAP-07 — write BOTH an `approvalProcesses/{stem}.approvalProcess-meta.xml`
 * AND a sibling `workflows/{objectApiName}.workflow-meta.xml` under ONE temp
 * root so the extractor's derived sibling path
 * (`dirname(dirname(approvalPath))/workflows/{Object}.workflow-meta.xml`)
 * resolves. The two subdirs are siblings under the same root, mirroring
 * `main/default/` in a real source tree.
 */
const writeTempApprovalWithWorkflow = async (
  stem: string,
  objectApiName: string,
  approvalContent: string,
  workflowContent: string,
): Promise<{ readonly dir: string; readonly path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-approval-process-'));
  const approvalSubdir = join(dir, 'approvalProcesses');
  const workflowSubdir = join(dir, 'workflows');
  await mkdir(approvalSubdir, { recursive: true });
  await mkdir(workflowSubdir, { recursive: true });
  const path = join(approvalSubdir, `${stem}.approvalProcess-meta.xml`);
  await writeFile(path, approvalContent, 'utf-8');
  await writeFile(
    join(workflowSubdir, `${objectApiName}.workflow-meta.xml`),
    workflowContent,
    'utf-8',
  );
  return { dir, path };
};

describe('extractApprovalProcess', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Account.Credit_Review (multi-step + hooks + emailTemplate)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, CREDIT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CREDIT_GOLDEN_REL);

      const result = await extractApprovalProcess(fixtureAbsPath);
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
      // v2.0a — Credit_Review has a multi-criteria top-level
      // `<entryCriteria>`, so the result includes 1 ApprovalProcess
      // node + 1 synthetic ConditionalContext node.
      expect(
        result.value.nodes.filter((n) => n.type === 'ApprovalProcess'),
      ).toHaveLength(1);
      // 1 parentOf + 3 approver references (Group, Role, Queue) +
      // 1 step notification sendsEmail + 1 default sendsEmail +
      // 1 Apex callsApex + 1 Alert references + 1 FieldUpdate references.
      expect(
        result.value.edges.filter((e) => e.edgeType === 'sendsEmail'),
      ).toHaveLength(2);
      expect(
        result.value.edges.filter((e) => e.edgeType === 'callsApex'),
      ).toHaveLength(1);
    });

    itHarness('produces the golden output for Opportunity.Discount_Approval (single-step, no templates)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, DISCOUNT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, DISCOUNT_GOLDEN_REL);

      const result = await extractApprovalProcess(fixtureAbsPath);
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
      // No sendsEmail (no notificationTemplate, no top-level
      // emailTemplate). One step → one approver reference.
      expect(
        result.value.edges.filter((e) => e.edgeType === 'sendsEmail'),
      ).toHaveLength(0);
    });
  });

  describe('approver chain semantics', () => {
    it('preserves stepIndex order and emits parallel approvers within one step (canonical singular <approvalStep>)', async () => {
      // Uses the real Salesforce shape (<approvalStep>, singular, repeated) so
      // the parallel-approver + stepIndex behavior is exercised on PRODUCTION
      // metadata, not the plural <approvalSteps> shape real orgs never emit (the
      // NI-2 fixture-shape class — see the legacy-plural fallback test below).
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>P</label>
  <active>true</active>
  <approvalStep>
    <name>step1</name>
    <assignedApprover>
      <approver><name>R1</name><type>role</type></approver>
    </assignedApprover>
  </approvalStep>
  <approvalStep>
    <name>step2</name>
    <assignedApprover>
      <approver><name>R2</name><type>role</type></approver>
      <approver><name>G2</name><type>group</type></approver>
    </assignedApprover>
  </approvalStep>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.Multi', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const approverEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(approverEdges).toHaveLength(3);
        expect(approverEdges[0]!.properties).toMatchObject({
          stepIndex: 0,
          approverType: 'role',
        });
        expect(approverEdges[0]!.toId).toBe('Role:R1');
        expect(approverEdges[1]!.properties).toMatchObject({
          stepIndex: 1,
          approverType: 'role',
        });
        expect(approverEdges[2]!.properties).toMatchObject({
          stepIndex: 1,
          approverType: 'group',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads the canonical singular <approvalStep> element (NI-2): real stepCount + approver edges', async () => {
      // Real Salesforce metadata uses <approvalStep> (singular, repeated) — the
      // extractor previously read the plural <approvalSteps>, so on every real
      // org stepCount was 0 and no approver edges were emitted. This fixture is
      // shaped like production metadata.
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Demo Approval</label>
  <active>true</active>
  <approvalStep>
    <label>Manager Approval</label>
    <name>Manager_Approval</name>
    <assignedApprover>
      <approver><name>Demo_Manager_Role</name><type>role</type></approver>
    </assignedApprover>
  </approvalStep>
  <approvalStep>
    <label>VP Approval</label>
    <name>VP_Approval</name>
    <assignedApprover>
      <approver><name>Demo_VP_Role</name><type>role</type></approver>
    </assignedApprover>
  </approvalStep>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.Demo_TwoStep', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes.find(
          (n) => n.type === 'ApprovalProcess',
        );
        // The whole point of NI-2: get_component surfaces this stepCount.
        expect(node?.properties.stepCount).toBe(2);
        const approverEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references' && e.properties.approverType === 'role',
        );
        expect(approverEdges).toHaveLength(2);
        expect(approverEdges.map((e) => e.properties.stepIndex)).toEqual([0, 1]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('still parses the legacy plural <approvalSteps> as a defensive fallback', async () => {
      // The extractor prefers the canonical singular <approvalStep> but keeps the
      // plural <approvalSteps> as a documented fallback (approval-process.ts).
      // This guards the fallback so converting the behavioral tests to the real
      // singular shape doesn't silently drop coverage of the plural path.
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Legacy Plural</label>
  <active>true</active>
  <approvalSteps>
    <name>only</name>
    <assignedApprover>
      <approver><name>R1</name><type>role</type></approver>
    </assignedApprover>
  </approvalSteps>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.LegacyPlural', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes.find(
          (n) => n.type === 'ApprovalProcess',
        );
        expect(node?.properties.stepCount).toBe(1);
        const approverEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references' && e.properties.approverType === 'role',
        );
        expect(approverEdges).toHaveLength(1);
        expect(approverEdges[0]!.toId).toBe('Role:R1');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('keeps the node (no edge) for a name-less userHierarchyField approver (NI-2 regression)', async () => {
      // Real metadata: a Manager-hierarchy step approves via <type>
      // userHierarchyField</type> with NO <name>. This must NOT abort the whole
      // ApprovalProcess extraction — the node + stepCount survive, just no edge.
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Manager Approval</label>
  <active>true</active>
  <approvalStep>
    <label>Manager Approval</label>
    <name>Manager_Approval</name>
    <assignedApprover>
      <approver><type>userHierarchyField</type></approver>
    </assignedApprover>
  </approvalStep>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.Hierarchy', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes.find(
          (n) => n.type === 'ApprovalProcess',
        );
        expect(node).toBeDefined();
        expect(node?.properties.stepCount).toBe(1);
        // No approver `references` edge — the implicit Manager hierarchy has no
        // named target component.
        const approverRefs = result.value.edges.filter(
          (e) => e.edgeType === 'references' && 'approverType' in e.properties,
        );
        expect(approverRefs).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits roleSubordinates with includeSubordinates: true', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>P</label>
  <active>true</active>
  <approvalSteps>
    <name>s</name>
    <assignedApprover>
      <approver><name>SalesRole</name><type>roleSubordinates</type></approver>
    </assignedApprover>
  </approvalSteps>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.WithSubs', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.toId).toBe('Role:SalesRole');
        expect(refs[0]!.properties).toMatchObject({
          stepIndex: 0,
          approverType: 'roleSubordinates',
          includeSubordinates: true,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('v2.0a — ConditionalContext extraction', () => {
    it('emits a criteria-kind ConditionalContext for a multi-item <entryCriteria>', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Tier1 Routing</label>
  <active>true</active>
  <entryCriteria>
    <criteriaItems>
      <field>Opportunity.Amount</field>
      <operation>greaterThan</operation>
      <value>1000000</value>
    </criteriaItems>
    <criteriaItems>
      <field>Opportunity.StageName</field>
      <operation>equals</operation>
      <value>Negotiation</value>
    </criteriaItems>
  </entryCriteria>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml(
        'Opportunity.Tier1_Routing',
        xml,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const processNode = result.value.nodes.find(
          (n) => n.type === 'ApprovalProcess',
        );
        expect(processNode!.properties.conditions).toEqual([
          {
            kind: 'criteria',
            conditionContextId:
              'ConditionalContext:ApprovalProcess:Opportunity.Tier1_Routing.condition-0',
            expression:
              'Opportunity.Amount greaterThan 1000000 AND Opportunity.StageName equals Negotiation',
            // Property mirror carries the canonical `fieldRefs` list
            // per ConditionalContextSemantics.md — the same array
            // surfaced on the ConditionalContext node's properties.
            fieldRefs: [
              'CustomField:Opportunity.Amount',
              'CustomField:Opportunity.StageName',
            ],
          },
        ]);
        const conditionNode = result.value.nodes.find(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNode).toBeDefined();
        const firesWhen = result.value.edges.find(
          (e) => e.edgeType === 'firesWhen',
        );
        expect(firesWhen!.confidence).toBe('declared');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a formula-kind ConditionalContext when entryCriteria has a <formula>', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Discount Routing</label>
  <active>true</active>
  <entryCriteria>
    <formula>Discount__c &gt; 0.15</formula>
  </entryCriteria>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml(
        'Opportunity.Discount_Approval',
        xml,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const firesWhen = result.value.edges.find(
          (e) => e.edgeType === 'firesWhen',
        );
        expect(firesWhen!.confidence).toBe('parsed');
        expect(firesWhen!.properties.kind).toBe('formula');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no ConditionalContext when <entryCriteria> is absent', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>No Criteria</label>
  <active>true</active>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml(
        'Account.No_Criteria',
        xml,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.nodes.filter((n) => n.type === 'ConditionalContext'),
        ).toHaveLength(0);
        expect(
          result.value.edges.filter((e) => e.edgeType === 'firesWhen'),
        ).toHaveLength(0);
        const processNode = result.value.nodes.find(
          (n) => n.type === 'ApprovalProcess',
        );
        expect(processNode!.properties.conditions).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('keeps the process when an adhoc approver omits <name> and a hook action is incomplete', async () => {
    const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>UAT Change Request</label>
  <active>true</active>
  <approvalStep>
    <label>Step 1</label>
    <name>Step_1</name>
    <assignedApprover>
      <approver>
        <type>adhoc</type>
      </approver>
    </assignedApprover>
  </approvalStep>
  <finalApprovalActions>
    <action>
      <type>FieldUpdate</type>
    </action>
  </finalApprovalActions>
</ApprovalProcess>`;
    const { dir, path } = await writeTempApprovalXml(
      'UML_SF_Change_Request__c.UAT_Change_Request',
      xml,
    );
    try {
      const result = await extractApprovalProcess(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes.some((n) => n.type === 'ApprovalProcess')).toBe(true);
      expect(result.value.edges.some((e) => e.edgeType === 'firesWhen')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('CR-CAP-07 — FieldUpdate writesTo via sibling workflow', () => {
    const APPROVAL_WITH_FIELD_UPDATE = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Credit Review</label>
  <active>true</active>
  <finalApprovalActions>
    <action>
      <name>Set_Reviewed</name>
      <type>FieldUpdate</type>
    </action>
  </finalApprovalActions>
</ApprovalProcess>`;

    it('emits writesTo to the real CustomField AND keeps the references scaffolding edge (KEEP+ADD)', async () => {
      // FAIL-BEFORE: today the FieldUpdate hook emits ONLY the `references` edge
      // to WorkflowFieldUpdate:Account.Set_Reviewed — no writesTo to the field
      // the update actually sets (which lives in the sibling workflow file).
      const workflowXml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Reviewed</fullName>
    <field>Reviewed__c</field>
    <operation>Literal</operation>
  </fieldUpdates>
</Workflow>`;
      const { dir, path } = await writeTempApprovalWithWorkflow(
        'Account.Credit_Review',
        'Account',
        APPROVAL_WITH_FIELD_UPDATE,
        workflowXml,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const writesTo = result.value.edges.filter(
          (e) => e.edgeType === 'writesTo',
        );
        expect(writesTo).toHaveLength(1);
        expect(writesTo[0]).toMatchObject({
          fromId: 'ApprovalProcess:Account.Credit_Review',
          toId: 'CustomField:Account.Reviewed__c',
          edgeType: 'writesTo',
          confidence: 'parsed',
          properties: { operation: 'Literal', hookType: 'finalApproval' },
        });

        // KEEP: the scaffolding `references` edge to WorkflowFieldUpdate node
        // STILL emits (consumers + the change-impact metadata branch rely on it).
        const refs = result.value.edges.filter(
          (e) =>
            e.edgeType === 'references' &&
            e.toId === 'WorkflowFieldUpdate:Account.Set_Reviewed',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.properties).toMatchObject({
          hookType: 'finalApproval',
          actionType: 'FieldUpdate',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('fail-soft: no sibling workflow file → no writesTo, but node + references survive (no phantom)', async () => {
      // A FieldUpdate action with NO sibling workflows/{Object}.workflow-meta.xml
      // is normal. Extraction must still succeed; only the writesTo is absent.
      const { dir, path } = await writeTempApprovalXml(
        'Account.Credit_Review',
        APPROVAL_WITH_FIELD_UPDATE,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.nodes.some((n) => n.type === 'ApprovalProcess'),
        ).toBe(true);
        expect(
          result.value.edges.filter((e) => e.edgeType === 'writesTo'),
        ).toHaveLength(0);
        // The references scaffolding edge still documents the action.
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'references' &&
              e.toId === 'WorkflowFieldUpdate:Account.Set_Reviewed',
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('fail-soft: malformed sibling workflow file → empty map, no writesTo, extraction still ok', async () => {
      const { dir, path } = await writeTempApprovalWithWorkflow(
        'Account.Credit_Review',
        'Account',
        APPROVAL_WITH_FIELD_UPDATE,
        '<Workflow><fieldUpdates><fullName>Set_Reviewed', // unterminated → parse-error
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter((e) => e.edgeType === 'writesTo'),
        ).toHaveLength(0);
        expect(
          result.value.nodes.some((n) => n.type === 'ApprovalProcess'),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('CR-P3-5: a cross-object field update (<targetObject>) emits NO writesTo (no relationship-scoped phantom)', async () => {
      const workflowXml = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Reviewed</fullName>
    <field>Reviewed__c</field>
    <operation>Literal</operation>
    <targetObject>Parent__r</targetObject>
  </fieldUpdates>
</Workflow>`;
      const { dir, path } = await writeTempApprovalWithWorkflow(
        'Account.Credit_Review',
        'Account',
        APPROVAL_WITH_FIELD_UPDATE,
        workflowXml,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter((e) => e.edgeType === 'writesTo'),
        ).toHaveLength(0);
        // The references edge is KEPT — the action is never silently dropped.
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'references' &&
              e.toId === 'WorkflowFieldUpdate:Account.Set_Reviewed',
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('W4.3 — Alert hook EmailTemplate references via sibling workflow', () => {
    const APPROVAL_WITH_ALERT = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Widget Approval</label>
  <active>true</active>
  <finalApprovalActions>
    <action>
      <name>My_Alert</name>
      <type>Alert</type>
    </action>
  </finalApprovalActions>
</ApprovalProcess>`;
    const WORKFLOW_WITH_ALERT = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <alerts>
    <fullName>My_Alert</fullName>
    <senderType>CurrentUser</senderType>
    <template>My_Folder/My_Template</template>
  </alerts>
</Workflow>`;

    it('emits a DIRECT `references` edge to the EmailTemplate the Alert hook sends AND keeps the WorkflowAlert reference (KEEP+ADD)', async () => {
      // Pre-W4.3 an Alert hook emitted ONLY the `references` to the
      // WorkflowAlert scaffolding node; the EmailTemplate the alert sends was
      // 2 hops away, so "safe to delete EmailTemplate X?" (a 1-hop referrer
      // check) missed this ApprovalProcess dependent. This asserts the new
      // DIRECT ApprovalProcess -> EmailTemplate edge (fails pre-fix).
      const { dir, path } = await writeTempApprovalWithWorkflow(
        'Widget__c.Approve',
        'Widget__c',
        APPROVAL_WITH_ALERT,
        WORKFLOW_WITH_ALERT,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const processId = 'ApprovalProcess:Widget__c.Approve';
        // KEEP: the WorkflowAlert scaffolding references edge still emits.
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'references' &&
              e.fromId === processId &&
              e.toId === 'WorkflowAlert:Widget__c.My_Alert',
          ),
        ).toBe(true);
        // ADD: the DIRECT EmailTemplate references edge.
        const templateRef = result.value.edges.find(
          (e) =>
            e.edgeType === 'references' &&
            e.fromId === processId &&
            e.toId === 'EmailTemplate:My_Folder.My_Template',
        );
        expect(templateRef).toBeDefined();
        expect(templateRef?.confidence).toBe('declared');
        expect(templateRef?.properties).toMatchObject({
          referenceKind: 'alertTemplate',
          viaAlert: 'My_Alert',
          hookType: 'finalApproval',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('fail-soft: no sibling workflow file → no EmailTemplate edge, WorkflowAlert reference survives', async () => {
      const { dir, path } = await writeTempApprovalXml(
        'Widget__c.Approve',
        APPROVAL_WITH_ALERT,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter((e) =>
            e.toId.startsWith('EmailTemplate:'),
          ),
        ).toHaveLength(0);
        expect(
          result.value.edges.some(
            (e) => e.toId === 'WorkflowAlert:Widget__c.My_Alert',
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('dedups the EmailTemplate edge when the same alert fires in multiple hooks', async () => {
      const approval = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Widget Approval</label>
  <active>true</active>
  <initialSubmissionActions>
    <action>
      <name>My_Alert</name>
      <type>Alert</type>
    </action>
  </initialSubmissionActions>
  <finalApprovalActions>
    <action>
      <name>My_Alert</name>
      <type>Alert</type>
    </action>
  </finalApprovalActions>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalWithWorkflow(
        'Widget__c.Approve',
        'Widget__c',
        approval,
        WORKFLOW_WITH_ALERT,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter(
            (e) => e.toId === 'EmailTemplate:My_Folder.My_Template',
          ),
        ).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/X.Y.approvalProcess-meta.xml';
      const result = await extractApprovalProcess(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns malformed-input when the filename has no dot', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>P</label>
  <active>true</active>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('NoDotInName', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'cannot split filename into object and process name',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <ApprovalProcess>', async () => {
      const { dir, path } = await writeTempApprovalXml(
        'Account.Foo',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <ApprovalProcess> root',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <label> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <active>true</active>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.NoLabel', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <label>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <active> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>P</label>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.NoActive', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <active>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when an approver has an invalid <type>', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>P</label>
  <active>true</active>
  <approvalSteps>
    <name>s</name>
    <assignedApprover>
      <approver><name>Foo</name><type>magicWand</type></approver>
    </assignedApprover>
  </approvalSteps>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.BadType', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'invalid approver type: magicWand',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when an approver is missing <name>', async () => {
      const xml = `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>P</label>
  <active>true</active>
  <approvalSteps>
    <name>s</name>
    <assignedApprover>
      <approver><type>role</type></approver>
    </assignedApprover>
  </approvalSteps>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Account.NoName', xml);
      try {
        const result = await extractApprovalProcess(path);
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
  });

  describe('record-lock and recall flags (real Payment__c V2 shape)', () => {
    // Fixture mirrors the exact Salesforce metadata shape from
    // org-kb/source/.../Payment__c.Payment_Requiring_Approval_V2.approvalProcess-meta.xml:
    //   allowRecall=false, finalApprovalRecordLock=true, finalRejectionRecordLock=false
    const PAYMENT_V2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <allowRecall>false</allowRecall>
    <allowedSubmitters>
        <submitter>Widget_Payment_Edit</submitter>
        <type>group</type>
    </allowedSubmitters>
    <allowedSubmitters>
        <type>owner</type>
    </allowedSubmitters>
    <approvalStep>
        <allowDelegate>false</allowDelegate>
        <assignedApprover>
            <approver>
                <name>Sample_Payment_Approval</name>
                <type>queue</type>
            </approver>
            <whenMultipleApprovers>FirstResponse</whenMultipleApprovers>
        </assignedApprover>
        <label>Step 1</label>
        <name>Step_1</name>
    </approvalStep>
    <description>Clone to remove entry criteria that is handled in flow</description>
    <enableMobileDeviceAccess>false</enableMobileDeviceAccess>
    <entryCriteria>
        <criteriaItems>
            <field>Payment__c.Approval_Status__c</field>
            <operation>equals</operation>
            <value>Required</value>
        </criteriaItems>
    </entryCriteria>
    <finalApprovalRecordLock>true</finalApprovalRecordLock>
    <finalRejectionRecordLock>false</finalRejectionRecordLock>
    <label>Payment Requiring Approval V2</label>
    <processOrder>1</processOrder>
    <recordEditability>AdminOnly</recordEditability>
    <showApprovalHistory>true</showApprovalHistory>
</ApprovalProcess>`;

    it('extracts allowRecall=false, finalApprovalRecordLock=true, finalRejectionRecordLock=false from the Payment V2 real-org XML shape', async () => {
      // FAILS BEFORE fix (properties block omitted all three fields, so they
      // defaulted to undefined rather than the parsed boolean values).
      const { dir, path } = await writeTempApprovalXml(
        'Payment__c.Payment_Requiring_Approval_V2',
        PAYMENT_V2_XML,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const processNode = result.value.nodes.find(
          (n) => n.type === 'ApprovalProcess',
        );
        expect(processNode).toBeDefined();
        expect(processNode!.id).toBe(
          'ApprovalProcess:Payment__c.Payment_Requiring_Approval_V2',
        );
        // Golden assertions per goldenAssertion in bundle spec
        expect(processNode!.properties.allowRecall).toBe(false);
        expect(processNode!.properties.finalApprovalRecordLock).toBe(true);
        expect(processNode!.properties.finalRejectionRecordLock).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults allowRecall and record-lock flags to false when elements are absent', async () => {
      // When the flags are not present in the XML (optional elements), the
      // extractor must not error — coerceBoolean returns false for undefined.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <label>Minimal Approval</label>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml(
        'Account.Minimal_Approval',
        xml,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const processNode = result.value.nodes.find(
          (n) => n.type === 'ApprovalProcess',
        );
        expect(processNode!.properties.allowRecall).toBe(false);
        expect(processNode!.properties.finalApprovalRecordLock).toBe(false);
        expect(processNode!.properties.finalRejectionRecordLock).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('allowedSubmitters extraction (real Payment__c V2 shape)', () => {
    // Real-org shape: allowedSubmitters uses <submitter> (not <name>) for the
    // target identifier and <type> for the discriminator. owner-type has no
    // <submitter> child. Mirrors the exact XML from Payment__c.Payment_Requiring_Approval_V2.
    const SUBMITTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <allowRecall>false</allowRecall>
    <allowedSubmitters>
        <submitter>Widget_Payment_Edit</submitter>
        <type>group</type>
    </allowedSubmitters>
    <allowedSubmitters>
        <type>owner</type>
    </allowedSubmitters>
    <allowedSubmitters>
        <submitter>Widget_Management</submitter>
        <type>role</type>
    </allowedSubmitters>
    <approvalStep>
        <assignedApprover>
            <approver>
                <name>Sample_Payment_Approval</name>
                <type>queue</type>
            </approver>
            <whenMultipleApprovers>FirstResponse</whenMultipleApprovers>
        </assignedApprover>
        <label>Step 1</label>
        <name>Step_1</name>
    </approvalStep>
    <finalApprovalRecordLock>true</finalApprovalRecordLock>
    <finalRejectionRecordLock>false</finalRejectionRecordLock>
    <label>Payment Requiring Approval V2</label>
</ApprovalProcess>`;

    it('populates properties.allowedSubmitters with the correct type+name pairs including null for owner', async () => {
      // FAILS BEFORE fix: allowedSubmitters was not read at all; the property
      // was absent from the node.
      const { dir, path } = await writeTempApprovalXml(
        'Payment__c.Payment_Requiring_Approval_V2',
        SUBMITTER_XML,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const processNode = result.value.nodes.find(
          (n) => n.type === 'ApprovalProcess',
        );
        expect(processNode).toBeDefined();
        const submitters = processNode!.properties
          .allowedSubmitters as Array<{ type: string; name: string | null }>;
        // group entry
        expect(submitters).toContainEqual({ type: 'group', name: 'Widget_Payment_Edit' });
        // owner entry: no <submitter> child → name is null
        expect(submitters).toContainEqual({ type: 'owner', name: null });
        // role entry
        expect(submitters).toContainEqual({ type: 'role', name: 'Widget_Management' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a references edge from the process to Group:Widget_Payment_Edit with referenceKind=allowedSubmitter', async () => {
      // goldenAssertion: a references edge exists from the process node to
      // Group:Widget_Payment_Edit with referenceKind='allowedSubmitter'.
      const { dir, path } = await writeTempApprovalXml(
        'Payment__c.Payment_Requiring_Approval_V2',
        SUBMITTER_XML,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const submitterEdges = result.value.edges.filter(
          (e) =>
            e.edgeType === 'references' &&
            (e.properties as Record<string, unknown>).referenceKind ===
              'allowedSubmitter',
        );
        // group + role = 2 named submitters; owner has no edge
        expect(submitterEdges).toHaveLength(2);
        const groupEdge = submitterEdges.find(
          (e) => e.toId === 'Group:Widget_Payment_Edit',
        );
        expect(groupEdge).toBeDefined();
        expect(groupEdge).toMatchObject({
          fromId: 'ApprovalProcess:Payment__c.Payment_Requiring_Approval_V2',
          toId: 'Group:Widget_Payment_Edit',
          edgeType: 'references',
          confidence: 'declared',
          properties: { referenceKind: 'allowedSubmitter', submitterType: 'group' },
        });
        const roleEdge = submitterEdges.find(
          (e) => e.toId === 'Role:Widget_Management',
        );
        expect(roleEdge).toBeDefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no allowedSubmitter edge for owner-type (name-less) entries', async () => {
      // owner entries in <allowedSubmitters> have no <submitter> child — the
      // extractor must not emit a dangling references edge for them.
      const ownerOnlyXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <allowedSubmitters>
        <type>owner</type>
    </allowedSubmitters>
    <approvalStep>
        <assignedApprover>
            <approver>
                <name>Queue_A</name>
                <type>queue</type>
            </approver>
            <whenMultipleApprovers>FirstResponse</whenMultipleApprovers>
        </assignedApprover>
        <label>Step 1</label>
        <name>Step_1</name>
    </approvalStep>
    <label>Owner Only</label>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml(
        'Account.Owner_Only',
        ownerOnlyXml,
      );
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const submitterEdges = result.value.edges.filter(
          (e) =>
            e.edgeType === 'references' &&
            (e.properties as Record<string, unknown>).referenceKind ===
              'allowedSubmitter',
        );
        expect(submitterEdges).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('structured step breakdown (APPROVAL-PROCESS-OMITS-STEP-APPROVER-BREAKDOWN)', () => {
    it('FAIL-BEFORE/PASS-AFTER: emits ordered steps with approvers + entry criteria + reject behavior, and structured final-rejection actions', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <label>Widget Approval</label>
    <finalApprovalActions>
        <action><name>Widget_Approved_Alert</name><type>Alert</type></action>
        <action><name>Widget_Status_Approved</name><type>FieldUpdate</type></action>
    </finalApprovalActions>
    <finalRejectionActions>
        <action><name>Widget_Rejected_Alert</name><type>Alert</type></action>
        <action><name>Widget_Status_Rejected</name><type>FieldUpdate</type></action>
    </finalRejectionActions>
    <approvalStep>
        <assignedApprover>
            <approver><name>first_reviewer</name><type>user</type></approver>
        </assignedApprover>
        <entryCriteria>
            <booleanFilter>1 OR 2</booleanFilter>
            <criteriaItems><field>Obj__c.CreatedBy</field><operation>equals</operation><value>Alice</value></criteriaItems>
            <criteriaItems><field>Obj__c.CreatedBy</field><operation>equals</operation><value>Bob</value></criteriaItems>
        </entryCriteria>
        <ifCriteriaNotMet>GotoNextStep</ifCriteriaNotMet>
        <label>First Reviewer</label>
        <name>First_Reviewer</name>
    </approvalStep>
    <approvalStep>
        <assignedApprover>
            <approver><name>second_reviewer</name><type>user</type></approver>
        </assignedApprover>
        <label>Second Reviewer</label>
        <name>Second_Reviewer</name>
        <rejectBehavior><type>RejectRequest</type></rejectBehavior>
    </approvalStep>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Obj__c.Widget_Approval', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]!.properties as {
          stepCount: number;
          steps: ReadonlyArray<{
            stepIndex: number;
            name: string | null;
            approvers: ReadonlyArray<{ name: string | null; type: string | null }>;
            entryCriteriaItemCount: number;
            ifCriteriaNotMet: string | null;
            rejectBehaviorType: string | null;
          }>;
          finalRejectionActions: ReadonlyArray<{ name: string | null; type: string | null }>;
          finalApprovalActions: ReadonlyArray<{ name: string | null; type: string | null }>;
        };

        // stepCount unchanged, but the per-step breakdown is now surfaced.
        expect(props.stepCount).toBe(2);
        expect(props.steps).toHaveLength(2);

        // Step 1: approver + entry criteria + GotoNextStep.
        expect(props.steps[0]?.name).toBe('First_Reviewer');
        expect(props.steps[0]?.approvers).toEqual([{ name: 'first_reviewer', type: 'user' }]);
        expect(props.steps[0]?.entryCriteriaItemCount).toBe(2);
        expect(props.steps[0]?.ifCriteriaNotMet).toBe('GotoNextStep');

        // Step 2: its reject behavior is structured (not just an alert name).
        expect(props.steps[1]?.approvers).toEqual([{ name: 'second_reviewer', type: 'user' }]);
        expect(props.steps[1]?.rejectBehaviorType).toBe('RejectRequest');

        // The reject path is answerable from facts: the Rejected alert + field update.
        expect(props.finalRejectionActions).toEqual([
          { name: 'Widget_Rejected_Alert', type: 'Alert' },
          { name: 'Widget_Status_Rejected', type: 'FieldUpdate' },
        ]);
        expect(props.finalApprovalActions).toEqual([
          { name: 'Widget_Approved_Alert', type: 'Alert' },
          { name: 'Widget_Status_Approved', type: 'FieldUpdate' },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits empty steps + action lists (not undefined) for a stepless process', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <label>Empty Approval</label>
</ApprovalProcess>`;
      const { dir, path } = await writeTempApprovalXml('Obj__c.Empty_Approval', xml);
      try {
        const result = await extractApprovalProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]!.properties as {
          stepCount: number;
          steps: readonly unknown[];
          finalRejectionActions: readonly unknown[];
        };
        expect(props.stepCount).toBe(0);
        expect(props.steps).toEqual([]);
        expect(props.finalRejectionActions).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
