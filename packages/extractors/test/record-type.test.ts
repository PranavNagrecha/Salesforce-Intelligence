/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractRecordType } from '../src/record-type.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FACULTY_FIXTURE_REL =
  'tests/fixtures/edu-org/source/main/default/objects/Faculty_List__c/recordTypes/Course.recordType-meta.xml';
const FACULTY_GOLDEN_REL =
  'tests/golden/extractor-record-type/Faculty_List__c__Course.json';
const CASE_LOG_FIXTURE_REL =
  'tests/fixtures/edu-org/source/main/default/objects/Case_Log__c/recordTypes/Advising_Case_Log.recordType-meta.xml';
const CASE_LOG_GOLDEN_REL =
  'tests/golden/extractor-record-type/Case_Log__c__Advising_Case_Log.json';

/**
 * Create an `objects/{Object}/recordTypes/{Name}.recordType-meta.xml`
 * skeleton inside a temp directory and write `content` to that file.
 * Returns the temp-dir root (for cleanup) and the absolute record-type
 * path. Used by the cross-reference and error-case suites.
 */
const writeNestedRecordTypeXml = async (
  objectName: string,
  recordTypeName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-record-type-'));
  const rtDir = join(dir, 'objects', objectName, 'recordTypes');
  await mkdir(rtDir, { recursive: true });
  const path = join(rtDir, `${recordTypeName}.recordType-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Write XML at an arbitrary path under a temp directory — used for the
 * path-layout error case where the file is NOT under a `recordTypes/`
 * parent.
 */
const writeXmlAtPath = async (
  relativePath: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-record-type-bad-path-'));
  const path = join(dir, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractRecordType', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Faculty_List__c.Course fixture', async () => {
      // The extractor accepts the path verbatim and stores it as
      // `sourcePath`. The golden's `sourcePath` is the harness-rooted
      // relative path. Because vitest's cwd is the package directory (not
      // the harness root), we call the extractor with the absolute path
      // and patch the golden's `sourcePath` to match — deep-equality on
      // every other field still proves correctness.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FACULTY_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, FACULTY_GOLDEN_REL);

      const result = await extractRecordType(fixtureAbsPath);
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

    itHarness('produces the golden output for the Case_Log__c.Advising_Case_Log fixture (multi picklist)', async () => {
      // Case_Log__c.Advising_Case_Log has 2 `<picklistValues>` groups
      // (Result__c and Subject__c). `properties.picklistFieldCount` must
      // equal 2 — the extractor counts the groups, not the values inside.
      const fixtureAbsPath = resolve(HARNESS_ROOT, CASE_LOG_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CASE_LOG_GOLDEN_REL);

      const result = await extractRecordType(fixtureAbsPath);
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

  describe('cross-reference to BusinessProcess', () => {
    it('emits a references edge to BusinessProcess when <businessProcess> is set', async () => {
      // Per RecordType.md "Edges": when `<businessProcess>` is present
      // and non-empty, emit a `references` edge from the RecordType to
      // `BusinessProcess:{ObjectApiName}.{BusinessProcessName}`. The
      // BusinessProcess node may or may not exist — dangling edges are
      // tolerated.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise</fullName>
    <active>true</active>
    <label>Enterprise</label>
    <businessProcess>Sales_Process</businessProcess>
</RecordType>`;
      const { dir, path } = await writeNestedRecordTypeXml(
        'Opportunity',
        'Enterprise',
        xml,
      );
      try {
        const result = await extractRecordType(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(2);
        const refEdge = result.value.edges.find(
          (e) => e.edgeType === 'references',
        );
        expect(refEdge).toBeDefined();
        if (refEdge === undefined) return;
        expect(refEdge.fromId).toBe('RecordType:Opportunity.Enterprise');
        expect(refEdge.toId).toBe('BusinessProcess:Opportunity.Sales_Process');
        expect(refEdge.confidence).toBe('declared');
        expect(refEdge.source).toBe('record-type-extractor');
        expect(refEdge.properties).toEqual({});
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.businessProcess).toBe('Sales_Process');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('emits exactly one parentOf edge and no references edge when <businessProcess> is absent', async () => {
      // Per RecordType.md, a RecordType without `<businessProcess>` is
      // the documented happy path — only the `parentOf` edge fires.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FACULTY_FIXTURE_REL);
      const result = await extractRecordType(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(1);
      expect(result.value.edges[0]?.edgeType).toBe('parentOf');
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.properties.businessProcess).toBeNull();
    });
  });

  describe('picklist values payload (RECORD-TYPE-OMITS-PICKLIST-VALUES)', () => {
    // The record type counted <picklistValues> blocks (picklistFieldCount) but
    // dropped every value. Support "which values can users pick on this record
    // type?" could not be answered from the node. Emit a `picklists` payload —
    // per field: the values, and which one is default. The shape is depth-4
    // frontmatter-safe (scalar fields + one inner scalar array), so it renders
    // in the component markdown without tripping the yaml-frontmatter limit.
    it('emits a picklists payload with per-field values and the default value', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Partner</fullName>
    <active>true</active>
    <label>Partner</label>
    <picklistValues>
        <picklist>Region__c</picklist>
        <values>
            <fullName>North</fullName>
            <default>false</default>
        </values>
        <values>
            <fullName>South</fullName>
            <default>true</default>
        </values>
    </picklistValues>
    <picklistValues>
        <picklist>Tier__c</picklist>
        <values>
            <fullName>Gold</fullName>
            <default>false</default>
        </values>
    </picklistValues>
</RecordType>`;
      const { dir, path } = await writeNestedRecordTypeXml(
        'Account',
        'Partner',
        xml,
      );
      try {
        const result = await extractRecordType(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        // Count semantics unchanged.
        expect(node.properties['picklistFieldCount']).toBe(2);
        // New payload: the values every field can take, plus the default.
        expect(node.properties['picklists']).toEqual([
          { field: 'Region__c', defaultValue: 'South', values: ['North', 'South'] },
          { field: 'Tier__c', defaultValue: null, values: ['Gold'] },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits picklists: [] when there are no <picklistValues> blocks', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Plain</fullName>
    <active>true</active>
    <label>Plain</label>
</RecordType>`;
      const { dir, path } = await writeNestedRecordTypeXml('Account', 'Plain', xml);
      try {
        const result = await extractRecordType(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]!.properties['picklists']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('properties defaults', () => {
    it('defaults missing optionals to null and picklistFieldCount=0 when <picklistValues> absent', async () => {
      // Per RecordType.md, a minimal valid file has no description, no
      // businessProcess, and no picklistValues — all default per the
      // node properties map.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Minimal</fullName>
    <active>false</active>
    <label>Minimal</label>
</RecordType>`;
      const { dir, path } = await writeNestedRecordTypeXml(
        'Account',
        'Minimal',
        xml,
      );
      try {
        const result = await extractRecordType(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('RecordType:Account.Minimal');
        expect(node.label).toBe('Minimal');
        expect(node.parentId).toBe('CustomObject:Account');
        expect(node.properties).toEqual({
          fullName: 'Minimal',
          label: 'Minimal',
          active: false,
          description: null,
          businessProcess: null,
          picklistFieldCount: 0,
          picklists: [],
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      // The non-existent file is under a recordTypes/ dir so the
      // path-layout check passes and the read attempt surfaces ENOENT.
      const path =
        '/nonexistent/objects/Account/recordTypes/Missing.recordType-meta.xml';
      const result = await extractRecordType(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      // Mismatched closing tag — fails XMLValidator.validate strictly.
      const { dir, path } = await writeNestedRecordTypeXml(
        'Account',
        'Bad',
        '<?xml version="1.0"?><RecordType><active>true</wrongClose></RecordType>',
      );
      try {
        const result = await extractRecordType(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <RecordType>', async () => {
      const { dir, path } = await writeNestedRecordTypeXml(
        'Account',
        'Wrong',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractRecordType(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <RecordType> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <fullName> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <label>Has Label</label>
</RecordType>`;
      const { dir, path } = await writeNestedRecordTypeXml(
        'Account',
        'NoFullName',
        xml,
      );
      try {
        const result = await extractRecordType(path);
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

    it('returns malformed-input when <label> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>NoLabel</fullName>
    <active>true</active>
</RecordType>`;
      const { dir, path } = await writeNestedRecordTypeXml(
        'Account',
        'NoLabel',
        xml,
      );
      try {
        const result = await extractRecordType(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <active> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>NoActive</fullName>
    <label>No Active</label>
</RecordType>`;
      const { dir, path } = await writeNestedRecordTypeXml(
        'Account',
        'NoActive',
        xml,
      );
      try {
        const result = await extractRecordType(path);
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

    it('returns malformed-input when the path is not under a recordTypes/ dir', async () => {
      // File placed directly under the temp root — no `recordTypes/`
      // parent — so the extractor cannot derive an ObjectApiName.
      const xml = `<?xml version="1.0"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Stray</fullName>
    <active>true</active>
    <label>Stray</label>
</RecordType>`;
      const { dir, path } = await writeXmlAtPath(
        'Stray.recordType-meta.xml',
        xml,
      );
      try {
        const result = await extractRecordType(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'cannot resolve parent object from path',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
