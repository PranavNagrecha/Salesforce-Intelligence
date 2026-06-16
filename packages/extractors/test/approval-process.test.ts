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
});
