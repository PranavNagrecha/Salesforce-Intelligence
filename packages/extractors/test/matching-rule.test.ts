/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractMatchingRule } from '../src/matching-rule.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const LEAD_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/matchingRules/Lead.matchingRule-meta.xml';
const LEAD_GOLDEN_REL = 'tests/golden/extractor-matching-rule/Lead.json';
const ACCOUNT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/matchingRules/Account.matchingRule-meta.xml';
const ACCOUNT_GOLDEN_REL = 'tests/golden/extractor-matching-rule/Account.json';

/**
 * Write `content` to a `.matchingRule-meta.xml` file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute
 * file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-matching-rule-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractMatchingRule', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Lead (multi-rule, with description and booleanFilter)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEAD_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, LEAD_GOLDEN_REL);

      const result = await extractMatchingRule(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The golden's `sourcePath` is harness-relative; vitest's cwd is the
      // package directory, so the extractor's actual `sourcePath` is
      // absolute. Patch the golden to match before deep-equality.
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
      // Multi-rule: 1 file -> 2 nodes + 2 parentOf edges + one `references`
      // edge per DISTINCT compared field (Email, Phone, LastName)
      // — MATCHING-RULE-OMITS-FIELD-EDGES.
      expect(result.value.nodes).toHaveLength(2);
      const parentOfEdges = result.value.edges.filter(
        (e) => e.edgeType === 'parentOf',
      );
      const fieldEdges = result.value.edges.filter(
        (e) => e.edgeType === 'references',
      );
      expect(parentOfEdges).toHaveLength(2);
      expect(fieldEdges.map((e) => e.toId).sort()).toEqual([
        'CustomField:Lead.Email',
        'CustomField:Lead.LastName',
        'CustomField:Lead.Phone',
      ]);
    });

    itHarness('produces the golden output for Account (single rule)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, ACCOUNT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, ACCOUNT_GOLDEN_REL);

      const result = await extractMatchingRule(fixtureAbsPath);
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
    });
  });

  describe('property derivation', () => {
    itHarness('emits a CustomField references edge per compared field, no triggersOn edges', async () => {
      // MATCHING-RULE-OMITS-FIELD-EDGES: the matcher now wires each compared
      // field to its `CustomField:` node (`references`); it still emits no
      // `triggersOn` edge (the matcher does not fire on record events).
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEAD_FIXTURE_REL);
      const result = await extractMatchingRule(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const references = result.value.edges.filter(
        (e) => e.edgeType === 'references',
      );
      expect(references.length).toBeGreaterThan(0);
      expect(references.every((e) => e.toId.startsWith('CustomField:'))).toBe(
        true,
      );
      expect(
        result.value.edges.some((e) => e.edgeType === 'triggersOn'),
      ).toBe(false);
    });

    it('deduplicates matchingMethods while preserving evaluation order for fieldsCompared', async () => {
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <fullName>Dup_Methods</fullName>
    <label>Multiple Exact Fields</label>
    <ruleStatus>Active</ruleStatus>
    <matchingRuleItems>
      <fieldName>FirstName</fieldName>
      <matchingMethod>Exact</matchingMethod>
    </matchingRuleItems>
    <matchingRuleItems>
      <fieldName>LastName</fieldName>
      <matchingMethod>Exact</matchingMethod>
    </matchingRuleItems>
    <matchingRuleItems>
      <fieldName>Email</fieldName>
      <matchingMethod>Fuzzy:Person Name</matchingMethod>
    </matchingRuleItems>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Contact.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0]!;
        // fieldsCompared preserves item order verbatim.
        expect(node.properties['fieldsCompared']).toBe('FirstName,LastName,Email');
        // matchingMethods de-duplicates while preserving first-seen order.
        expect(node.properties['matchingMethods']).toBe('Exact,Fuzzy:Person Name');
        expect(node.properties['itemCount']).toBe(3);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('MATCHING-RULE-OMITS-FIELD-EDGES: emits one references edge per compared field to CustomField', async () => {
      // Red pre-fix: matching-rule emitted ONLY the inbound parentOf — the
      // compared fields lived in the `fieldsCompared` string with no graph
      // wiring, so "which fields does this matcher use?" / Email-retirement
      // blast-radius invented no MatchingRule dependents. Green post-fix:
      // one declared `references` edge per DISTINCT compared field.
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <fullName>Portal_Duplicates</fullName>
    <label>Portal Duplicate Matching</label>
    <ruleStatus>Active</ruleStatus>
    <matchingRuleItems>
      <fieldName>FirstName</fieldName>
      <matchingMethod>Exact</matchingMethod>
    </matchingRuleItems>
    <matchingRuleItems>
      <fieldName>LastName</fieldName>
      <matchingMethod>Exact</matchingMethod>
    </matchingRuleItems>
    <matchingRuleItems>
      <fieldName>Email</fieldName>
      <matchingMethod>Exact</matchingMethod>
    </matchingRuleItems>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Contact.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const ruleId = 'MatchingRule:Contact.Portal_Duplicates';
        const fieldEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references' && e.fromId === ruleId,
        );
        expect(fieldEdges.map((e) => e.toId)).toEqual([
          'CustomField:Contact.FirstName',
          'CustomField:Contact.LastName',
          'CustomField:Contact.Email',
        ]);
        expect(fieldEdges.every((e) => e.confidence === 'declared')).toBe(true);
        expect(fieldEdges[2]!.properties).toMatchObject({
          referenceKind: 'matchingField',
          fieldName: 'Email',
          matchingMethod: 'Exact',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('MATCHING-RULE-OMITS-FIELD-EDGES: deduplicates a field compared by two items into one edge', async () => {
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <fullName>Email_Twice</fullName>
    <label>Email compared two ways</label>
    <ruleStatus>Active</ruleStatus>
    <matchingRuleItems>
      <fieldName>Email</fieldName>
      <matchingMethod>Exact</matchingMethod>
    </matchingRuleItems>
    <matchingRuleItems>
      <fieldName>Email</fieldName>
      <matchingMethod>Fuzzy:Person Name</matchingMethod>
    </matchingRuleItems>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fieldEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(fieldEdges).toHaveLength(1);
        expect(fieldEdges[0]!.toId).toBe('CustomField:Lead.Email');
        // First-seen item's matching method wins.
        expect(fieldEdges[0]!.properties['matchingMethod']).toBe('Exact');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts a rule with zero <matchingRuleItems> (scaffolded matcher)', async () => {
      // Per MatchingRule.md, a rule with itemCount: 0 is the
      // scaffolded-but-unconfigured pattern, not an error.
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <fullName>Empty_Rule</fullName>
    <label>Empty Rule</label>
    <ruleStatus>Draft</ruleStatus>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Contact.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0]!;
        expect(node.properties['itemCount']).toBe(0);
        expect(node.properties['matchingMethods']).toBe('');
        expect(node.properties['fieldsCompared']).toBe('');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('produces zero nodes for an empty <MatchingRules> root', async () => {
      const xml =
        '<?xml version="1.0"?><MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata"/>';
      const { dir, path } = await writeTempXml(
        'Empty.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.matchingRule-meta.xml';
      const result = await extractMatchingRule(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Lead.matchingRule-meta.xml',
        '<?xml version="1.0"?><MatchingRules><matchingRules></wrongClose></MatchingRules>',
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <MatchingRules>', async () => {
      const { dir, path } = await writeTempXml(
        'Lead.matchingRule-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <MatchingRules> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a rule is missing <fullName>', async () => {
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <label>No Name</label>
    <ruleStatus>Active</ruleStatus>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
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

    it('returns malformed-input when <ruleStatus> is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <fullName>Bad_Status</fullName>
    <label>Bad Status</label>
    <ruleStatus>Disabled</ruleStatus>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid ruleStatus: Disabled');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts a rule whose async activation failed (ruleStatus ActivationFailed) without dropping its siblings (B20 real-org bug)', async () => {
      // A real org returns `ActivationFailed` for a matching rule whose async
      // activation failed. Rejecting that status aborted the WHOLE file and
      // dropped every other valid rule on the object — observed on real
      // Account/Contact matching rules surfaced by the B20 retrieve fix.
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <fullName>Failed_Rule</fullName>
    <label>Failed Rule</label>
    <matchingRuleItems>
      <fieldName>Name</fieldName>
      <matchingMethod>Exact</matchingMethod>
    </matchingRuleItems>
    <ruleStatus>ActivationFailed</ruleStatus>
  </matchingRules>
  <matchingRules>
    <fullName>Good_Rule</fullName>
    <label>Good Rule</label>
    <matchingRuleItems>
      <fieldName>Email</fieldName>
      <matchingMethod>Exact</matchingMethod>
    </matchingRuleItems>
    <ruleStatus>Active</ruleStatus>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // BOTH rules extract — the failed one no longer aborts the whole file.
        const statuses = result.value.nodes
          .map((n) => String(n.properties.ruleStatus))
          .sort();
        expect(statuses).toEqual(['ActivationFailed', 'Active']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a matchingRuleItems is missing <matchingMethod>', async () => {
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <fullName>Missing_Method</fullName>
    <label>Missing Method</label>
    <ruleStatus>Active</ruleStatus>
    <matchingRuleItems>
      <fieldName>Email</fieldName>
    </matchingRuleItems>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <matchingMethod>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <blankValueBehavior> is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<MatchingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <matchingRules>
    <fullName>Bad_Blank</fullName>
    <label>Bad Blank</label>
    <ruleStatus>Active</ruleStatus>
    <matchingRuleItems>
      <fieldName>Email</fieldName>
      <matchingMethod>Exact</matchingMethod>
      <blankValueBehavior>WhateverElse</blankValueBehavior>
    </matchingRuleItems>
  </matchingRules>
</MatchingRules>`;
      const { dir, path } = await writeTempXml(
        'Lead.matchingRule-meta.xml',
        xml,
      );
      try {
        const result = await extractMatchingRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'invalid blankValueBehavior: WhateverElse',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
