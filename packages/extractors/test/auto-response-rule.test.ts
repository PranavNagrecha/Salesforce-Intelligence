/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractAutoResponseRule } from '../src/auto-response-rule.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

const HARNESS_ROOT = findHarnessRoot() ?? '';
const LEAD_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/autoResponseRules/Lead.autoResponseRules-meta.xml';
const LEAD_GOLDEN_REL = 'tests/golden/extractor-auto-response-rule/Lead.json';

const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-auto-response-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractAutoResponseRule', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Lead (1 rule, 2 entries, EmailTemplate refs)', async () => {
      // Golden's `sourcePath` is harness-relative; the extractor sees
      // an absolute path. Patch the golden to match before deep-equal.
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEAD_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, LEAD_GOLDEN_REL);

      const result = await extractAutoResponseRule(fixtureAbsPath);
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

      // Spot-check: every ruleEntry must produce exactly one sendsEmail
      // edge per AutoResponseRule.md.
      const sendsEmailEdges = result.value.edges.filter(
        (e) => e.edgeType === 'sendsEmail',
      );
      expect(sendsEmailEdges).toHaveLength(2);
      expect(sendsEmailEdges[0]!.toId).toBe(
        'EmailTemplate:Sales.WebLeadWelcome',
      );
      expect(sendsEmailEdges[1]!.toId).toBe(
        'EmailTemplate:Sales.PartnerLeadWelcome',
      );
    });
  });

  describe('happy paths without errors', () => {
    it('produces zero nodes/edges for an empty <AutoResponseRules> root', async () => {
      const xml = `<?xml version="1.0"?>
<AutoResponseRules xmlns="http://soap.sforce.com/2006/04/metadata"/>`;
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAutoResponseRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a node but no per-entry edges for a rule with zero <ruleEntry> children', async () => {
      const xml = `<?xml version="1.0"?>
<AutoResponseRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <autoResponseRule>
    <fullName>Empty_Rule</fullName>
    <active>false</active>
  </autoResponseRule>
</AutoResponseRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAutoResponseRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        expect(result.value.nodes[0]!.properties).toEqual({
          active: false,
          ruleEntryCount: 0,
          templateCount: 0,
          // v2.0a — empty mirror when the rule has no condition surface.
          conditions: [],
        });
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]!.edgeType).toBe('parentOf');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('deduplicates templateCount when two entries share a template', async () => {
      // Per AutoResponseRule.md, duplicate template references emit
      // separate edges but templateCount is deduplicated at node level.
      const xml = `<?xml version="1.0"?>
<AutoResponseRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <autoResponseRule>
    <fullName>Dup_Templates</fullName>
    <active>true</active>
    <ruleEntry>
      <template>Sales/Common</template>
      <senderName>A</senderName>
    </ruleEntry>
    <ruleEntry>
      <template>Sales/Common</template>
      <senderName>B</senderName>
    </ruleEntry>
  </autoResponseRule>
</AutoResponseRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAutoResponseRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]!.properties).toEqual({
          active: true,
          ruleEntryCount: 2,
          templateCount: 1,
          // v2.0a — neither entry carried criteria/formula, so the
          // condition mirror is empty.
          conditions: [],
        });
        const sends = result.value.edges.filter(
          (e) => e.edgeType === 'sendsEmail',
        );
        expect(sends).toHaveLength(2);
        expect(sends[0]!.properties.entryIndex).toBe(0);
        expect(sends[0]!.properties.senderName).toBe('A');
        expect(sends[1]!.properties.entryIndex).toBe(1);
        expect(sends[1]!.properties.senderName).toBe('B');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('v2.0a — ConditionalContext extraction', () => {
    it('emits one ConditionalContext per <ruleEntry> carrying criteria', async () => {
      const xml = `<?xml version="1.0"?>
<AutoResponseRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <autoResponseRule>
    <fullName>Web_Source_Rule</fullName>
    <active>true</active>
    <ruleEntry>
      <criteriaItems>
        <field>Lead.LeadSource</field>
        <operation>equals</operation>
        <value>Web</value>
      </criteriaItems>
      <template>Sales/WebLeadWelcome</template>
      <senderName>Customer Service</senderName>
    </ruleEntry>
  </autoResponseRule>
</AutoResponseRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAutoResponseRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const conditionNode = result.value.nodes.find(
          (n) => n.type === 'ConditionalContext',
        );
        expect(conditionNode).toBeDefined();
        expect(conditionNode!.properties.kind).toBe('criteria');
        const firesWhen = result.value.edges.find(
          (e) => e.edgeType === 'firesWhen',
        );
        expect(firesWhen!.confidence).toBe('declared');
        const ruleNode = result.value.nodes.find(
          (n) => n.type === 'AutoResponseRule',
        );
        expect(
          (ruleNode!.properties.conditions as readonly unknown[]).length,
        ).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no ConditionalContext for entries with neither criteria nor formula', async () => {
      const xml = `<?xml version="1.0"?>
<AutoResponseRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <autoResponseRule>
    <fullName>Default_Response</fullName>
    <active>true</active>
    <ruleEntry>
      <template>Sales/DefaultEmail</template>
      <senderName>Service</senderName>
    </ruleEntry>
  </autoResponseRule>
</AutoResponseRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAutoResponseRule(path);
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
      const path = '/nonexistent/Missing.autoResponseRules-meta.xml';
      const result = await extractAutoResponseRule(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        '<?xml version="1.0"?><AutoResponseRules><autoResponseRule></wrongClose></AutoResponseRules>',
      );
      try {
        const result = await extractAutoResponseRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <AutoResponseRules>', async () => {
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractAutoResponseRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <AutoResponseRules> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a rule is missing <fullName>', async () => {
      const xml = `<?xml version="1.0"?>
<AutoResponseRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <autoResponseRule>
    <active>true</active>
  </autoResponseRule>
</AutoResponseRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAutoResponseRule(path);
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

    it('returns malformed-input when a ruleEntry is missing <template>', async () => {
      const xml = `<?xml version="1.0"?>
<AutoResponseRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <autoResponseRule>
    <fullName>R1</fullName>
    <active>true</active>
    <ruleEntry>
      <senderName>X</senderName>
    </ruleEntry>
  </autoResponseRule>
</AutoResponseRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAutoResponseRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <template>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a ruleEntry is missing <senderName>', async () => {
      const xml = `<?xml version="1.0"?>
<AutoResponseRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <autoResponseRule>
    <fullName>R1</fullName>
    <active>true</active>
    <ruleEntry>
      <template>Sales/X</template>
    </ruleEntry>
  </autoResponseRule>
</AutoResponseRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.autoResponseRules-meta.xml',
        xml,
      );
      try {
        const result = await extractAutoResponseRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <senderName>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
