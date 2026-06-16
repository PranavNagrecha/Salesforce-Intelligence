/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractPathAssistant } from '../src/path-assistant.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';

// Synthetic fixtures follow the REAL Salesforce PathAssistant file
// convention: the basename is the path's own developer name (NO `{Object}.`
// prefix), and the bound object lives in `<entityName>` inside the XML body.
// `Sales_Process` is a record-type-specific path (its `<recordTypeName>` names
// a custom record type); `Default_Opportunity` is an object-level default path
// (its `<recordTypeName>` is the `__MASTER__` sentinel), mirroring the real
// mass.gov `Default_Opportunity.pathAssistant-meta.xml`.
const SALES_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/pathAssistants/Sales_Process.pathAssistant-meta.xml';
const SALES_GOLDEN_REL =
  'tests/golden/extractor-path-assistant/Opportunity__Sales_Process.json';
const DEFAULT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/pathAssistants/Default_Opportunity.pathAssistant-meta.xml';
const DEFAULT_GOLDEN_REL =
  'tests/golden/extractor-path-assistant/Opportunity__Default_Opportunity.json';

/**
 * Write `content` to a `{stem}.pathAssistant-meta.xml` file under a fresh
 * pathAssistants/ directory inside a temp directory. Returns the temp-dir
 * root (for cleanup) and the absolute file path. The `stem` is the path's
 * developer name — note it carries NO object prefix, matching how Salesforce
 * actually names these files.
 */
const writeTempPathAssistantXml = async (
  stem: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-path-assistant-'));
  const subdir = join(dir, 'pathAssistants');
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, `${stem}.pathAssistant-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/** A record-type-specific path: `<recordTypeName>` names a real record type. */
const RECORD_TYPE_SPECIFIC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <entityName>Opportunity</entityName>
    <fieldName>StageName</fieldName>
    <masterLabel>Enterprise Path</masterLabel>
    <pathAssistantSteps>
        <fieldNames>Amount</fieldNames>
        <info>Qualify the deal.</info>
        <picklistValueName>Prospecting</picklistValueName>
    </pathAssistantSteps>
    <recordTypeName>Enterprise</recordTypeName>
</PathAssistant>`;

/**
 * An object-level default path shaped exactly like the real mass.gov
 * `Default_Opportunity.pathAssistant-meta.xml`: the object lives in
 * `<entityName>`, the picklist driver in `<fieldName>`, and the record type is
 * the `__MASTER__` sentinel (meaning "no specific record type").
 */
const MASTER_DEFAULT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <entityName>Opportunity</entityName>
    <fieldName>StageName</fieldName>
    <masterLabel>Default</masterLabel>
    <pathAssistantSteps>
        <fieldNames>Amount</fieldNames>
        <picklistValueName>Closed Won</picklistValueName>
    </pathAssistantSteps>
    <recordTypeName>__MASTER__</recordTypeName>
</PathAssistant>`;

describe('extractPathAssistant', () => {
  describe('node identity (object from <entityName>, devName from basename)', () => {
    it('derives the object from <entityName>, NOT the filename', async () => {
      // The crux of the fix: the filename `Default_Opportunity` has no object
      // prefix and no dot. The bound object MUST come from `<entityName>`. The
      // old filename-dot-split model errored on this file; the new model
      // extracts it. This is the real mass.gov shape.
      const { dir, path } = await writeTempPathAssistantXml(
        'Default_Opportunity',
        MASTER_DEFAULT_XML,
      );
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // id = PathAssistant:{entityName}.{devName}
        expect(node.id).toBe('PathAssistant:Opportunity.Default_Opportunity');
        // apiName is the object-qualified form (mirrors RecordType), so the
        // vault renderer never collides two objects' same-named paths.
        expect(node.apiName).toBe('Opportunity.Default_Opportunity');
        expect(node.type).toBe('PathAssistant');
        expect(node.label).toBe('Default');
        expect(node.properties.entityName).toBe('Opportunity');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('uses the basename verbatim as the devName (no dot-splitting)', async () => {
      // A dot in the basename is NOT a {Object}.{RecordType} separator under
      // the corrected model — the whole basename is the path devName and the
      // object still comes from <entityName>.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <entityName>Account</entityName>
    <masterLabel>Odd.Name</masterLabel>
</PathAssistant>`;
      const { dir, path } = await writeTempPathAssistantXml('Odd.Name', xml);
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('PathAssistant:Account.Odd.Name');
        expect(node.apiName).toBe('Account.Odd.Name');
        expect(node.properties.entityName).toBe('Account');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('record type is optional', () => {
    it('treats the __MASTER__ sentinel as no record type (object-level path)', async () => {
      const { dir, path } = await writeTempPathAssistantXml(
        'Default_Opportunity',
        MASTER_DEFAULT_XML,
      );
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // __MASTER__ collapses to null: there is no specific record type.
        expect(node.properties.recordTypeName).toBeNull();
        // An object-level default path parents to the CustomObject, NOT a
        // (non-existent) master RecordType node.
        expect(node.parentId).toBe('CustomObject:Opportunity');
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.fromId).toBe('CustomObject:Opportunity');
        expect(edge.toId).toBe('PathAssistant:Opportunity.Default_Opportunity');
        expect(edge.edgeType).toBe('parentOf');
        expect(edge.confidence).toBe('declared');
        expect(edge.source).toBe('path-assistant-extractor');
        expect(edge.properties).toEqual({});
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('treats an absent <recordTypeName> as no record type (object-level path)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <entityName>Lead</entityName>
    <fieldName>Status</fieldName>
    <masterLabel>Default</masterLabel>
</PathAssistant>`;
      const { dir, path } = await writeTempPathAssistantXml('Default', xml);
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('PathAssistant:Lead.Default');
        expect(node.properties.recordTypeName).toBeNull();
        expect(node.parentId).toBe('CustomObject:Lead');
        const edge = result.value.edges[0];
        expect(edge?.fromId).toBe('CustomObject:Lead');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('keeps a real <recordTypeName> and parents to that RecordType', async () => {
      const { dir, path } = await writeTempPathAssistantXml(
        'Enterprise_Path',
        RECORD_TYPE_SPECIFIC_XML,
      );
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('PathAssistant:Opportunity.Enterprise_Path');
        expect(node.properties.recordTypeName).toBe('Enterprise');
        // A record-type-specific path parents to the RecordType, which is
        // reachable transitively to the CustomObject.
        expect(node.parentId).toBe('RecordType:Opportunity.Enterprise');
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.fromId).toBe('RecordType:Opportunity.Enterprise');
        expect(edge.toId).toBe('PathAssistant:Opportunity.Enterprise_Path');
        expect(edge.edgeType).toBe('parentOf');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('treats an empty <recordTypeName> as no record type', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <entityName>Case</entityName>
    <masterLabel>Support Path</masterLabel>
    <recordTypeName></recordTypeName>
</PathAssistant>`;
      const { dir, path } = await writeTempPathAssistantXml('Support_Path', xml);
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.properties.recordTypeName).toBeNull();
        expect(node?.parentId).toBe('CustomObject:Case');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('properties', () => {
    it('surfaces fieldName, stepCount, masterLabel, and active from the body', async () => {
      const { dir, path } = await writeTempPathAssistantXml(
        'Default_Opportunity',
        MASTER_DEFAULT_XML,
      );
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).toEqual({
          masterLabel: 'Default',
          active: true,
          entityName: 'Opportunity',
          recordTypeName: null,
          fieldName: 'StageName',
          stepCount: 1,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults fieldName to null and stepCount to 0 when absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <entityName>Opportunity</entityName>
    <masterLabel>Renewal Path</masterLabel>
</PathAssistant>`;
      const { dir, path } = await writeTempPathAssistantXml('Renewal_Path', xml);
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.fieldName).toBeNull();
        expect(node.properties.stepCount).toBe(0);
        expect(node.properties.active).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('counts multiple <pathAssistantSteps> entries', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <entityName>Lead</entityName>
    <fieldName>Status</fieldName>
    <masterLabel>Default</masterLabel>
    <pathAssistantSteps><picklistValueName>New</picklistValueName></pathAssistantSteps>
    <pathAssistantSteps><picklistValueName>Working</picklistValueName></pathAssistantSteps>
    <pathAssistantSteps><picklistValueName>Qualified</picklistValueName></pathAssistantSteps>
</PathAssistant>`;
      const { dir, path } = await writeTempPathAssistantXml('Default', xml);
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties.stepCount).toBe(3);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path =
        '/nonexistent/pathAssistants/Default_Opportunity.pathAssistant-meta.xml';
      const result = await extractPathAssistant(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempPathAssistantXml(
        'Bad',
        '<?xml version="1.0"?><PathAssistant><active>true</wrongClose></PathAssistant>',
      );
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <PathAssistant>', async () => {
      const { dir, path } = await writeTempPathAssistantXml(
        'Wrong',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <PathAssistant> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <active> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <entityName>Opportunity</entityName>
    <masterLabel>No Active</masterLabel>
</PathAssistant>`;
      const { dir, path } = await writeTempPathAssistantXml('No_Active', xml);
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <active>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <masterLabel> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <entityName>Opportunity</entityName>
</PathAssistant>`;
      const { dir, path } = await writeTempPathAssistantXml('No_Label', xml);
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <masterLabel>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <entityName> is missing (object is unresolvable)', async () => {
      // The object is no longer recoverable from the filename, so a path
      // without <entityName> cannot be identified — this is the documented
      // failure that the old filename-dot-split model never had to make.
      const xml = `<?xml version="1.0"?>
<PathAssistant xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <masterLabel>No Entity</masterLabel>
</PathAssistant>`;
      const { dir, path } = await writeTempPathAssistantXml('No_Entity', xml);
      try {
        const result = await extractPathAssistant(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <entityName>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // Golden-output regression locks. Skipped in the published product copy
  // (no harness fixtures); run from the build harness. The fixtures use the
  // corrected real-file convention (devName basename + <entityName> body).
  describe('golden output', () => {
    itHarness(
      'produces the golden output for the record-type-specific Sales_Process fixture',
      async () => {
        const fixtureAbsPath = resolve(HARNESS_ROOT, SALES_FIXTURE_REL);
        const goldenAbsPath = resolve(HARNESS_ROOT, SALES_GOLDEN_REL);

        const result = await extractPathAssistant(fixtureAbsPath);
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
      },
    );

    itHarness(
      'produces the golden output for the object-level Default_Opportunity fixture (__MASTER__, no record type)',
      async () => {
        const fixtureAbsPath = resolve(HARNESS_ROOT, DEFAULT_FIXTURE_REL);
        const goldenAbsPath = resolve(HARNESS_ROOT, DEFAULT_GOLDEN_REL);

        const result = await extractPathAssistant(fixtureAbsPath);
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
      },
    );
  });
});
