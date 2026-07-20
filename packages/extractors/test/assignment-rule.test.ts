/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractAssignmentRule } from '../src/assignment-rule.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const LEAD_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/assignmentRules/Lead.assignmentRules-meta.xml';
const LEAD_GOLDEN_REL = 'tests/golden/extractor-assignment-rule/Lead.json';
const CASE_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/assignmentRules/Case.assignmentRules-meta.xml';
const CASE_GOLDEN_REL = 'tests/golden/extractor-assignment-rule/Case.json';

/**
 * Write `content` to an `.assignmentRules-meta.xml` file under a fresh
 * temp directory. Returns the temp-dir root (for cleanup) and the
 * absolute file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-assignment-rule-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractAssignmentRule', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Lead (2 rules, Queue + User + template)', async () => {
      // The golden's `sourcePath` is harness-relative; vitest's cwd is
      // the package directory, so the extractor's actual `sourcePath`
      // is absolute. Patch the golden's `sourcePath` to match before
      // deep-equality. Deep-equality on every other field still proves
      // correctness.
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEAD_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, LEAD_GOLDEN_REL);

      const result = await extractAssignmentRule(fixtureAbsPath);
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

      // Spot-check the rule count and a per-entry sendsEmail edge.
      // v2.0a — each rule's `<ruleEntry>` may add a synthetic
      // ConditionalContext node; the per-rule count below filters
      // to `AssignmentRule` so the assertion remains stable.
      expect(
        result.value.nodes.filter((n) => n.type === 'AssignmentRule'),
      ).toHaveLength(2);
      const sendsEmailEdges = result.value.edges.filter(
        (e) => e.edgeType === 'sendsEmail',
      );
      expect(sendsEmailEdges).toHaveLength(1);
      expect(sendsEmailEdges[0]!.toId).toBe(
        'EmailTemplate:Sales.LeadAssignedNotification',
      );
    });

    itHarness('produces the golden output for Case (1 rule, Queue target with multi-criteria)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, CASE_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CASE_GOLDEN_REL);

      const result = await extractAssignmentRule(fixtureAbsPath);
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
      // criteriaItemCount: 2 because the rule has two <criteriaItems>.
      const refEdges = result.value.edges.filter(
        (e) => e.edgeType === 'references',
      );
      expect(refEdges).toHaveLength(1);
      expect(refEdges[0]!.properties.criteriaItemCount).toBe(2);
    });
  });

  describe('happy paths without errors', () => {
    it('produces zero nodes/edges for an empty <AssignmentRules> root', async () => {
      // Per AssignmentRule.md: a scaffold file with no rules is the
      // documented happy path, not an error.
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata"/>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a node but no per-entry edges for a rule with zero <ruleEntry> children', async () => {
      // Per AssignmentRule.md: a rule with zero rule entries is also
      // not an error. The node carries ruleEntryCount: 0 and
      // targetCount: 0.
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>Empty_Rule</fullName>
    <active>true</active>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        expect(result.value.nodes[0]!.properties).toEqual({
          active: true,
          ruleEntryCount: 0,
          targetCount: 0,
          // v2.0a — empty mirror when the rule has no condition surface.
          conditions: [],
        });
        // parentOf only — no per-entry edges.
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]!.edgeType).toBe('parentOf');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('skips <description>/<editable> on rule entries without erroring', async () => {
      // Per AssignmentRule.md, these may appear in some org versions
      // and must be silently ignored.
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>R1</fullName>
    <active>true</active>
    <ruleEntry>
      <description>ignored</description>
      <editable>true</editable>
      <assignedTo>Q1</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.toId).toBe('Queue:Q1');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('deduplicates targetCount when two entries reference the same target', async () => {
      // Per AssignmentRule.md, duplicate target references emit
      // separate edges but the targetCount is deduplicated at node
      // level.
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>Dup_Targets</fullName>
    <active>true</active>
    <ruleEntry>
      <assignedTo>QShared</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
    <ruleEntry>
      <assignedTo>QShared</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]!.properties).toEqual({
          active: true,
          ruleEntryCount: 2,
          targetCount: 1,
          // v2.0a — neither entry carried criteria/formula, so the
          // condition mirror is empty.
          conditions: [],
        });
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(2);
        expect(refs[0]!.properties.entryIndex).toBe(0);
        expect(refs[1]!.properties.entryIndex).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('v2.0a — ConditionalContext extraction', () => {
    it('emits one ConditionalContext per <ruleEntry> carrying criteria', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>Geo_Routing</fullName>
    <active>true</active>
    <ruleEntry>
      <criteriaItems>
        <field>Lead.Country</field>
        <operation>equals</operation>
        <value>USA</value>
      </criteriaItems>
      <assignedTo>SalesUS</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
    <ruleEntry>
      <criteriaItems>
        <field>Lead.Country</field>
        <operation>equals</operation>
        <value>UK</value>
      </criteriaItems>
      <assignedTo>SalesEMEA</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const conditionNodes = result.value.nodes.filter(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNodes).toHaveLength(2);
        expect(conditionNodes[0]!.id).toBe(
          'ConditionalContext:AssignmentRule:Lead.Geo_Routing.condition-0',
        );
        expect(conditionNodes[1]!.id).toBe(
          'ConditionalContext:AssignmentRule:Lead.Geo_Routing.condition-1',
        );
        const firesWhen = result.value.edges.filter(
          (e) => e.edgeType === 'firesWhen',
        );
        expect(firesWhen).toHaveLength(2);
        // The rule's property mirror lists both entries.
        const ruleNode = result.value.nodes.find(
          (n) => n.type === 'AssignmentRule',
        );
        expect(
          (ruleNode!.properties.conditions as readonly unknown[]).length,
        ).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no ConditionalContext for entries with neither criteria nor formula', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>Default_Route</fullName>
    <active>true</active>
    <ruleEntry>
      <assignedTo>SalesDefault</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
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
      const path = '/nonexistent/Missing.assignmentRules-meta.xml';
      const result = await extractAssignmentRule(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        '<?xml version="1.0"?><AssignmentRules><assignmentRule></wrongClose></AssignmentRules>',
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <AssignmentRules>', async () => {
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <AssignmentRules> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a rule is missing <fullName>', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <active>true</active>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
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

    it('returns malformed-input when a rule is missing <active>', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>NoActive</fullName>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
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

    it('returns malformed-input when <assignedToType> is present without <assignedTo>', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>R1</fullName>
    <active>true</active>
    <ruleEntry>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <assignedTo>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts a criteria-only ruleEntry with no assignee (real-org Case shape)', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>FilterOnly</fullName>
    <active>true</active>
    <ruleEntry>
      <criteriaItems>
        <field>Case.RecordTypeId</field>
        <operation>equals</operation>
        <value>Priority Review</value>
      </criteriaItems>
    </ruleEntry>
    <ruleEntry>
      <assignedTo>Support_Queue</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Case.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const ruleNodes = result.value.nodes.filter((n) => n.type === 'AssignmentRule');
        expect(ruleNodes).toHaveLength(1);
        expect(ruleNodes[0]?.properties?.ruleEntryCount).toBe(2);
        // Criteria-only entry still emits ConditionalContext (v2.0a).
        expect(
          result.value.nodes.filter((n) => n.type === 'ConditionalContext'),
        ).toHaveLength(1);
        // The assignee reference edge still resolves.
        expect(
          result.value.edges.some(
            (e) => e.edgeType === 'references' && e.toId === 'Queue:Support_Queue',
          ),
        ).toBe(true);
        // ASSIGNMENT-RULE-OMITS-RECORDTYPE-VALUE-EDGE: the RecordTypeId
        // criterion now also wires the named RecordType.
        expect(
          result.value.edges.some(
            (e) =>
              e.edgeType === 'references' &&
              e.toId === 'RecordType:Case.Priority_Review',
          ),
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('ASSIGNMENT-RULE-OMITS-RECORDTYPE-VALUE-EDGE: edges a RecordTypeId criterion to RecordType:{Object}.{DeveloperName}', async () => {
      // Red pre-fix: a criterion comparing Case.RecordTypeId to a record-type
      // label produced only the CustomField:Case.RecordTypeId fieldRef — the
      // named RecordType was never edged, so RT retirement/blast-radius and
      // "why did this Case land in the ADA queue?" missed the AssignmentRule.
      // Green post-fix: a heuristic references edge whose developer name is
      // derived from the label (spaces -> underscores).
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>Priority_Routing</fullName>
    <active>true</active>
    <ruleEntry>
      <criteriaItems>
        <field>Case.RecordTypeId</field>
        <operation>equals</operation>
        <value>Priority Review</value>
      </criteriaItems>
      <assignedTo>Priority_Queue</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Case.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const ruleId = 'AssignmentRule:Case.Priority_Routing';
        const rtEdge = result.value.edges.find(
          (e) =>
            e.edgeType === 'references' &&
            e.fromId === ruleId &&
            e.toId === 'RecordType:Case.Priority_Review',
        );
        expect(rtEdge).toBeDefined();
        expect(rtEdge!.confidence).toBe('heuristic');
        expect(rtEdge!.properties).toMatchObject({
          referenceKind: 'assignmentRecordTypeCriteria',
          criteriaField: 'Case.RecordTypeId',
          criteriaValue: 'Priority Review',
          derivedFrom: 'label',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('ASSIGNMENT-RULE-OMITS-RECORDTYPE-VALUE-EDGE: takes RecordType.DeveloperName value verbatim and splits multi-value', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>DevName_Routing</fullName>
    <active>true</active>
    <ruleEntry>
      <criteriaItems>
        <field>Case.RecordType.DeveloperName</field>
        <operation>equals</operation>
        <value>First_RT,Second_RT</value>
      </criteriaItems>
      <assignedTo>Some_Queue</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Case.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const rtTargets = result.value.edges
          .filter(
            (e) =>
              e.edgeType === 'references' &&
              e.properties['referenceKind'] === 'assignmentRecordTypeCriteria',
          )
          .map((e) => e.toId);
        expect(rtTargets).toEqual([
          'RecordType:Case.First_RT',
          'RecordType:Case.Second_RT',
        ]);
        const first = result.value.edges.find(
          (e) => e.toId === 'RecordType:Case.First_RT',
        );
        expect(first!.properties['derivedFrom']).toBe('developerName');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('ASSIGNMENT-RULE-OMITS-RECORDTYPE-VALUE-EDGE: a non-RecordType criterion mints no RecordType edge', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>Status_Routing</fullName>
    <active>true</active>
    <ruleEntry>
      <criteriaItems>
        <field>Case.Status</field>
        <operation>equals</operation>
        <value>New</value>
      </criteriaItems>
      <assignedTo>Some_Queue</assignedTo>
      <assignedToType>Queue</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Case.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some((e) => e.toId.startsWith('RecordType:')),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <assignedToType> is outside {Queue, User, Role}', async () => {
      const xml = `<?xml version="1.0"?>
<AssignmentRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <assignmentRule>
    <fullName>R1</fullName>
    <active>true</active>
    <ruleEntry>
      <assignedTo>Foo</assignedTo>
      <assignedToType>Group</assignedToType>
    </ruleEntry>
  </assignmentRule>
</AssignmentRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.assignmentRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAssignmentRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid assignedToType: Group');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
