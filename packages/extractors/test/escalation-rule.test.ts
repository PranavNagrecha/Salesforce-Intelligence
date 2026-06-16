/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractEscalationRule } from '../src/escalation-rule.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

const HARNESS_ROOT = findHarnessRoot() ?? '';
const CASE_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/escalationRules/Case.escalationRules-meta.xml';
const CASE_GOLDEN_REL = 'tests/golden/extractor-escalation-rule/Case.json';

const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-escalation-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractEscalationRule', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Case (3 actions including a notify-only)', async () => {
      // Golden's sourcePath is harness-relative; the extractor records
      // the absolute path. Patch to match before deep-equal.
      const fixtureAbsPath = resolve(HARNESS_ROOT, CASE_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CASE_GOLDEN_REL);

      const result = await extractEscalationRule(fixtureAbsPath);
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

      // Spot-check: the third action is notify-only (no assignedTo) —
      // it must NOT produce a references edge but must produce a
      // sendsEmail edge.
      const refs = result.value.edges.filter(
        (e) => e.edgeType === 'references',
      );
      const sends = result.value.edges.filter(
        (e) => e.edgeType === 'sendsEmail',
      );
      expect(refs).toHaveLength(2);
      expect(sends).toHaveLength(3);
      expect(sends[2]!.properties.actionIndex).toBe(2);
      expect(sends[2]!.toId).toBe(
        'EmailTemplate:Support.CaseEscalatedDirector',
      );
    });
  });

  describe('happy paths without errors', () => {
    it('produces zero nodes/edges for an empty <EscalationRules> root', async () => {
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata"/>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a node and parentOf only for a rule with zero <ruleEntry> children', async () => {
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>Empty_Rule</fullName>
    <active>false</active>
  </escalationRule>
</EscalationRules>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        expect(result.value.nodes[0]!.properties).toEqual({
          active: false,
          ruleEntryCount: 0,
          actionCount: 0,
          // v2.0a — empty mirror when no rule entries are present.
          conditions: [],
        });
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]!.edgeType).toBe('parentOf');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits only sendsEmail (no references) for a notify-only escalation action', async () => {
      // Per EscalationRule.md, an action with <minutesToEscalation> but
      // no <assignedTo> is a documented happy path — "page a manager
      // but don't re-route ownership". Only the sendsEmail edge fires.
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>Notify_Only</fullName>
    <active>true</active>
    <ruleEntry>
      <escalationAction>
        <minutesToEscalation>30</minutesToEscalation>
        <notifyTo>mgr@example.com</notifyTo>
        <notifyToTemplate>Support/Ping</notifyToTemplate>
      </escalationAction>
    </ruleEntry>
  </escalationRule>
</EscalationRules>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        const sends = result.value.edges.filter(
          (e) => e.edgeType === 'sendsEmail',
        );
        expect(refs).toHaveLength(0);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.toId).toBe('EmailTemplate:Support.Ping');
        expect(sends[0]!.properties.notifyTo).toBe('mgr@example.com');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('v2.0a — ConditionalContext extraction', () => {
    it('emits one ConditionalContext per <ruleEntry> carrying criteria', async () => {
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>P1_Escalation</fullName>
    <active>true</active>
    <ruleEntry>
      <criteriaItems>
        <field>Case.Priority</field>
        <operation>equals</operation>
        <value>High</value>
      </criteriaItems>
      <escalationAction>
        <minutesToEscalation>60</minutesToEscalation>
        <assignedTo>Tier2</assignedTo>
        <assignedToType>Queue</assignedToType>
      </escalationAction>
    </ruleEntry>
  </escalationRule>
</EscalationRules>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const conditionNode = result.value.nodes.find(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNode!.id).toBe(
          'ConditionalContext:EscalationRule:Case.P1_Escalation.condition-0',
        );
        expect(conditionNode!.properties.kind).toBe('criteria');
        const firesWhen = result.value.edges.find(
          (e) => e.edgeType === 'firesWhen',
        );
        expect(firesWhen!.confidence).toBe('declared');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no ConditionalContext for entries with neither criteria nor formula', async () => {
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>Default_Escalation</fullName>
    <active>true</active>
    <ruleEntry>
      <escalationAction>
        <minutesToEscalation>120</minutesToEscalation>
        <assignedTo>SupportTeam</assignedTo>
        <assignedToType>Queue</assignedToType>
      </escalationAction>
    </ruleEntry>
  </escalationRule>
</EscalationRules>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.nodes.filter((n) => n.type === 'ConditionalContext'),
        ).toHaveLength(0);
        expect(
          result.value.edges.filter((e) => e.edgeType === 'firesWhen'),
        ).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.escalationRules-meta.xml';
      const result = await extractEscalationRule(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        '<?xml version="1.0"?><EscalationRules><escalationRule></wrongClose></EscalationRules>',
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <EscalationRules>', async () => {
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <EscalationRules> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a ruleEntry has no <escalationAction>', async () => {
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>NoActions</fullName>
    <active>true</active>
    <ruleEntry>
      <criteriaItems>
        <field>Case.Priority</field>
        <operation>equals</operation>
        <value>Low</value>
      </criteriaItems>
    </ruleEntry>
  </escalationRule>
</EscalationRules>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <escalationAction>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <minutesToEscalation> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>NoMinutes</fullName>
    <active>true</active>
    <ruleEntry>
      <escalationAction>
        <assignedTo>Q1</assignedTo>
        <assignedToType>Queue</assignedToType>
      </escalationAction>
    </ruleEntry>
  </escalationRule>
</EscalationRules>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <minutesToEscalation>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <assignedTo> is set without <assignedToType>', async () => {
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>NoType</fullName>
    <active>true</active>
    <ruleEntry>
      <escalationAction>
        <minutesToEscalation>60</minutesToEscalation>
        <assignedTo>Q1</assignedTo>
      </escalationAction>
    </ruleEntry>
  </escalationRule>
</EscalationRules>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <assignedToType>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts the real escalationStartTime enum values (CaseCreation / CaseLastModified)', async () => {
      for (const startTime of ['CaseCreation', 'CaseLastModified']) {
        const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>GoodStart</fullName>
    <active>true</active>
    <ruleEntry>
      <escalationStartTime>${startTime}</escalationStartTime>
      <escalationAction>
        <minutesToEscalation>60</minutesToEscalation>
      </escalationAction>
    </ruleEntry>
  </escalationRule>
</EscalationRules>`;
        const { dir, path } = await writeTempXml(
          'Case.escalationRules-meta.xml',
          xml,
        );
        try {
          const result = await extractEscalationRule(path);
          expect(result.ok).toBe(true);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    });

    it('returns malformed-input when <escalationStartTime> is out of enum', async () => {
      const xml = `<?xml version="1.0"?>
<EscalationRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <escalationRule>
    <fullName>BadStart</fullName>
    <active>true</active>
    <ruleEntry>
      <escalationStartTime>WheneverBoss</escalationStartTime>
      <escalationAction>
        <minutesToEscalation>60</minutesToEscalation>
      </escalationAction>
    </ruleEntry>
  </escalationRule>
</EscalationRules>`;
      const { dir, path } = await writeTempXml(
        'Case.escalationRules-meta.xml',
        xml,
      );
      try {
        const result = await extractEscalationRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'invalid escalationStartTime: WheneverBoss',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
