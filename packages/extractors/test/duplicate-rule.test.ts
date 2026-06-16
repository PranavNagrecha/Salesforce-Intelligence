/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractDuplicateRule } from '../src/duplicate-rule.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const LEAD_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/duplicateRules/Lead.Standard_Duplicate.duplicateRule-meta.xml';
const LEAD_GOLDEN_REL =
  'tests/golden/extractor-duplicate-rule/Lead.Standard_Duplicate.json';
const ACCOUNT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/duplicateRules/Account.Standard_Duplicate.duplicateRule-meta.xml';
const ACCOUNT_GOLDEN_REL =
  'tests/golden/extractor-duplicate-rule/Account.Standard_Duplicate.json';

/**
 * Write `content` to a `{stem}.duplicateRule-meta.xml` file under a fresh
 * `duplicateRules/` subdirectory inside a temp directory. Returns the
 * temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempDuplicateRuleXml = async (
  stem: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-duplicate-rule-'));
  const subdir = join(dir, 'duplicateRules');
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, `${stem}.duplicateRule-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractDuplicateRule', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Lead.Standard_Duplicate (2 matchers)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEAD_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, LEAD_GOLDEN_REL);

      const result = await extractDuplicateRule(fixtureAbsPath);
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
      // Cross-reference: 2 references edges to Lead's matching rules.
      const refs = result.value.edges.filter((e) => e.edgeType === 'references');
      expect(refs).toHaveLength(2);
      expect(refs[0]!.toId).toBe('MatchingRule:Lead.Lead_Match_Email');
      expect(refs[1]!.toId).toBe('MatchingRule:Lead.Lead_Match_Phone');
    });

    itHarness('produces the golden output for Account.Standard_Duplicate (single matcher with objectMapping)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, ACCOUNT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, ACCOUNT_GOLDEN_REL);

      const result = await extractDuplicateRule(fixtureAbsPath);
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
      // objectMappingCount surfaces on the references edge.
      const ref = result.value.edges.find((e) => e.edgeType === 'references');
      expect(ref).toBeDefined();
      if (!ref) return;
      expect(ref.properties['objectMappingCount']).toBe(1);
    });
  });

  describe('operations and alert text', () => {
    it('parses repeated <operationsOnInsert>/<operationsOnUpdate> as enum lists with a top-level <alertText> (real Salesforce shape)', async () => {
      // The real Salesforce shape: <operationsOnInsert> repeats as a list of
      // DuplicateRuleOperation enum strings (NOT a container with <allowSave>),
      // and <alertText> is a single top-level element. This mirrors the
      // mass.gov Standard_*_Duplicate_Rule files that the old container model
      // rejected.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <actionOnInsert>Allow</actionOnInsert>
  <actionOnUpdate>Allow</actionOnUpdate>
  <alertText>You are creating a duplicate record. We recommend you use an existing record instead.</alertText>
  <isActive>false</isActive>
  <masterLabel>Standard Account Duplicate Rule</masterLabel>
  <operationsOnInsert>Alert</operationsOnInsert>
  <operationsOnInsert>Report</operationsOnInsert>
  <operationsOnUpdate>Report</operationsOnUpdate>
  <securityOption>EnforceSharingRules</securityOption>
  <sortOrder>1</sortOrder>
  <duplicateRuleMatchRules>
    <matchRuleSObjectType>Account</matchRuleSObjectType>
    <matchingRule>Standard_Account_Match_Rule_v1_0</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Account.Standard_Account_Duplicate_Rule',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]!.properties;
        expect(props['operationsOnInsert']).toEqual(['Alert', 'Report']);
        expect(props['operationsOnUpdate']).toEqual(['Report']);
        expect(props['alertText']).toBe(
          'You are creating a duplicate record. We recommend you use an existing record instead.',
        );
        // The legacy per-operation properties from the wrong container model
        // must be gone.
        expect(props).not.toHaveProperty('allowSaveOnInsert');
        expect(props).not.toHaveProperty('allowSaveOnUpdate');
        expect(props).not.toHaveProperty('alertTextOnInsert');
        expect(props).not.toHaveProperty('alertTextOnUpdate');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts every DuplicateRuleOperation enum value (Allow, Block, Alert, Report)', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>All Ops</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Allow</operationsOnInsert>
  <operationsOnInsert>Block</operationsOnInsert>
  <operationsOnInsert>Alert</operationsOnInsert>
  <operationsOnInsert>Report</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml('Lead.All_Ops', xml);
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]!.properties['operationsOnInsert']).toEqual([
          'Allow',
          'Block',
          'Alert',
          'Report',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults operations to empty lists and alertText to null when the elements are absent', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Minimal</masterLabel>
  <isActive>true</isActive>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml('Lead.Minimal', xml);
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]!.properties;
        expect(props['operationsOnInsert']).toEqual([]);
        expect(props['operationsOnUpdate']).toEqual([]);
        expect(props['alertText']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('matcher resolution', () => {
    it('resolves <matchRuleSObjectType> as the target object when present (cross-object)', async () => {
      // A Lead duplicate rule referencing an Account matching rule via
      // explicit <matchRuleSObjectType>: the edge's toId reflects the
      // explicit target, not the rule's parent.
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Cross Object</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchingRule>Cross_Account_Match</matchingRule>
    <matchRuleSObjectType>Account</matchRuleSObjectType>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.Cross_Object',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.toId).toBe('MatchingRule:Account.Cross_Account_Match');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('falls back to the parent object when <matchRuleSObjectType> is absent', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Same Object</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.Same_Object',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.toId).toBe('MatchingRule:Lead.Lead_Match');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('deduplicates identical matcher references while preserving original matcherIndex', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Dup</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.Dup_Matcher',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // matchingRuleCount counts XML entries (not deduplicated targets).
        expect(result.value.nodes[0]!.properties['matchingRuleCount']).toBe(2);
        // But the references edges are deduplicated by (rule, toId).
        const refs = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]!.properties['matcherIndex']).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reports objectMappingCount 0 for a <objectMapping xsi:nil="true"/> (no real mapping)', async () => {
      // Real Salesforce emits an empty mapping as a nil self-closing
      // element. With `ignoreAttributes: true` the parser collapses it to
      // the empty string `""`, which is NOT a real object mapping — so the
      // count must be 0, not 1. (The real mass.gov
      // Standard_*_Duplicate_Rule files all carry this nil form.)
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <masterLabel>Nil Mapping</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchRuleSObjectType>Account</matchRuleSObjectType>
    <matchingRule>Standard_Account_Match_Rule_v1_0</matchingRule>
    <objectMapping xsi:nil="true"/>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Account.Nil_Mapping',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const ref = result.value.edges.find(
          (e) => e.edgeType === 'references',
        );
        expect(ref).toBeDefined();
        if (!ref) return;
        expect(ref.properties['objectMappingCount']).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('counts only the real mapping when a matcher mixes a nil and a real <objectMapping>', async () => {
      // A single matcher carrying both a nil (`""`) and a real
      // (object-shaped) <objectMapping>: only the real one counts, so the
      // count is 1 — not 2 (the nil must be dropped).
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <masterLabel>Mixed Mapping</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchRuleSObjectType>Account</matchRuleSObjectType>
    <matchingRule>Standard_Account_Match_Rule_v1_0</matchingRule>
    <objectMapping xsi:nil="true"/>
    <objectMapping>
      <inputObject>Account</inputObject>
      <mappingFields>
        <inputField>Name</inputField>
        <outputField>Name</outputField>
      </mappingFields>
      <outputObject>Account</outputObject>
    </objectMapping>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Account.Mixed_Mapping',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const ref = result.value.edges.find(
          (e) => e.edgeType === 'references',
        );
        expect(ref).toBeDefined();
        if (!ref) return;
        expect(ref.properties['objectMappingCount']).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Lead.Missing.duplicateRule-meta.xml';
      const result = await extractDuplicateRule(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
    });

    it('returns malformed-input when the filename has no dot to split on', async () => {
      // The filename is just `Onename` (no dot), so the dot-split fails
      // before any XML parsing.
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>X</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchingRule>Y</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml('Onename', xml);
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'cannot split filename into object and rule name',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <DuplicateRule>', async () => {
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.Bad_Root',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <DuplicateRule> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <duplicateRuleMatchRules> is absent', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>No Matchers</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Alert</operationsOnInsert>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.No_Matchers',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'DuplicateRule must reference at least one MatchingRule',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when an <operationsOnInsert> value is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Bad Op Insert</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Frobnicate</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.Bad_Op_Insert',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid operationsOnInsert: Frobnicate');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when an <operationsOnUpdate> value is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Bad Op Update</masterLabel>
  <isActive>true</isActive>
  <operationsOnUpdate>Warn</operationsOnUpdate>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.Bad_Op_Update',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid operationsOnUpdate: Warn');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <actionOnInsert> is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Bad Action</masterLabel>
  <isActive>true</isActive>
  <actionOnInsert>WarnAndBlock</actionOnInsert>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.Bad_Action',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid actionOnInsert: WarnAndBlock');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <securityOption> is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Bad Security</masterLabel>
  <isActive>true</isActive>
  <securityOption>IgnoreSharing</securityOption>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchingRule>Lead_Match</matchingRule>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.Bad_Security',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid securityOption: IgnoreSharing');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a matcher entry is missing <matchingRule>', async () => {
      const xml = `<?xml version="1.0"?>
<DuplicateRule xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>No Matcher Name</masterLabel>
  <isActive>true</isActive>
  <operationsOnInsert>Alert</operationsOnInsert>
  <duplicateRuleMatchRules>
    <matchRuleSObjectType>Account</matchRuleSObjectType>
  </duplicateRuleMatchRules>
</DuplicateRule>`;
      const { dir, path } = await writeTempDuplicateRuleXml(
        'Lead.No_Matcher_Name',
        xml,
      );
      try {
        const result = await extractDuplicateRule(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <matchingRule>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
