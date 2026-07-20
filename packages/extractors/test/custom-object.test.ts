/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractCustomObject } from '../src/custom-object.js';
import { deriveEntityVariant } from '../src/path-utils.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/dx/objects/CustomerProject__c/CustomerProject__c.object-meta.xml';
const GOLDEN_PATH_REL = 'tests/golden/extractor-custom-object/CustomerProject__c.json';
const SMOKE_FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/objects/Budget__c/Budget__c.object-meta.xml';

// Real-fixture golden pairs added in pass-2: each variant whose XML
// shape matches what the doc declares the extractor should accept.
const MDT_FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/objects/Clinical_Instruction__mdt/Clinical_Instruction__mdt.object-meta.xml';
const MDT_GOLDEN_PATH_REL =
  'tests/golden/extractor-custom-object/Clinical_Instruction__mdt.json';
const E_FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/objects/Application_Event__e/Application_Event__e.object-meta.xml';
const E_GOLDEN_PATH_REL =
  'tests/golden/extractor-custom-object/Application_Event__e.json';
const B_FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/objects/SyncTable_DegreeProgram__b/SyncTable_DegreeProgram__b.object-meta.xml';
const B_GOLDEN_PATH_REL =
  'tests/golden/extractor-custom-object/SyncTable_DegreeProgram__b.json';
const KAV_FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/objects/Knowledge__kav/Knowledge__kav.object-meta.xml';
const KAV_GOLDEN_PATH_REL =
  'tests/golden/extractor-custom-object/Knowledge__kav.json';
// Pass-3 recovery: CustomSetting now accepts missing <nameField>, so
// this real fixture (which omits it) is a positive golden, not a
// dropped case. See CustomObject.md "Conditionally required elements".
const CUSTOM_SETTING_FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/objects/Related_List_Settings__c/Related_List_Settings__c.object-meta.xml';
const CUSTOM_SETTING_GOLDEN_PATH_REL =
  'tests/golden/extractor-custom-object/Related_List_Settings__c.json';

const VALID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Test Object</label>
    <nameField>
        <label>Test Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Test Objects</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;

/**
 * Write content to a freshly-created temp file and return its absolute path.
 * Caller is responsible for cleanup; tests typically delete the parent dir.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-custom-object-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Build a synthetic `.object-meta.xml` for variant-detection tests. The
 * helper writes `<label>` plus whatever the caller passes in `innerXml`.
 * `<deploymentStatus>`, `<sharingModel>`, `<nameField>`, `<pluralLabel>`,
 * and `<visibility>` are all caller-controlled because their
 * conditionally-required matrix varies by variant per the vendored
 * `CustomObject.md`.
 */
const buildVariantXml = (
  innerXml: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Variant Label</label>
${innerXml}
</CustomObject>`;

describe('extractCustomObject', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the CustomerProject__c fixture', async () => {
      // The extractor accepts the path verbatim and stores it as
      // `sourcePath`. The golden's `sourcePath` is the harness-rooted
      // relative path. Because vitest's cwd is the package directory (not
      // the harness root) and `process.chdir` is unsupported in vitest's
      // worker pool, we call the extractor with the absolute path and
      // patch the golden's `sourcePath` to match — deep-equality on
      // every other field still proves correctness.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractCustomObject(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('sharing model enum', () => {
    it('accepts ReadSelect / ReadWriteTransfer / ControlledByCampaign OWD values', async () => {
      // All valid Salesforce SharingModel enum values the extractor wrongly
      // rejected: ReadSelect (the STANDARD Pricebook2 object — failed a real-org
      // extraction with 'invalid sharingModel: ReadSelect'), ReadWriteTransfer
      // (Lead/Case/Opportunity transfer OWD), ControlledByCampaign
      // (CampaignMember). The consumer why_cant_user_see_record already knows
      // the latter two; the producer extractor must too.
      for (const model of [
        'ReadSelect',
        'ReadWriteTransfer',
        'ControlledByCampaign',
      ]) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Test Object</label>
    <nameField>
        <label>Test Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Test Objects</pluralLabel>
    <sharingModel>${model}</sharingModel>
</CustomObject>`;
        const { dir, path } = await writeTempXml('Test__c.object-meta.xml', xml);
        try {
          const result = await extractCustomObject(path);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.nodes[0]?.properties['sharingModel']).toBe(model);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const result = await extractCustomObject('/this/path/does/not/exist.object-meta.xml');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe('/this/path/does/not/exist.object-meta.xml');
    });

    it('returns parse-error for malformed XML', async () => {
      // Mismatched closing tag — fails XMLValidator.validate strictly.
      const { dir, path } = await writeTempXml(
        'Bad__c.object-meta.xml',
        '<?xml version="1.0"?><CustomObject><label>Hi</wrongClose></CustomObject>',
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <CustomObject>', async () => {
      const { dir, path } = await writeTempXml(
        'Wrong__c.object-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <CustomObject> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a required element (<label>) is missing', async () => {
      const xml = `<?xml version="1.0"?>
<CustomObject>
  <pluralLabel>Things</pluralLabel>
  <nameField><label>Name</label><type>Text</type></nameField>
  <deploymentStatus>Deployed</deploymentStatus>
  <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;
      const { dir, path } = await writeTempXml('NoLabel__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('models a STANDARD object (no custom suffix), defaulting label to the API name', async () => {
      // Salesforce serializes standard objects WITHOUT the custom-object-only
      // elements (<label>/<deploymentStatus>/<sharingModel>/<nameField>/<pluralLabel>).
      // We still produce a node so automation tools can anchor on Account/Contact.
      const xml = `<?xml version="1.0"?>
<CustomObject>
  <enableFeeds>false</enableFeeds>
</CustomObject>`;
      const { dir, path } = await writeTempXml('Account.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.id).toBe('CustomObject:Account');
        expect(node?.label).toBe('Account');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('synthesizes platform-universal system fields for a STANDARD object (flagged synthetic)', async () => {
      const xml = `<?xml version="1.0"?>
<CustomObject>
  <enableFeeds>false</enableFeeds>
</CustomObject>`;
      const { dir, path } = await writeTempXml('Account.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Object node first, then the synthesized system fields.
        expect(result.value.nodes[0]?.id).toBe('CustomObject:Account');
        const fields = result.value.nodes.filter((n) => n.type === 'CustomField');
        const names = fields.map((f) => f.apiName);
        // Universal audit fields are present...
        expect(names).toContain('CreatedById');
        expect(names).toContain('LastModifiedDate');
        expect(names).toContain('SystemModstamp');
        // ...but NOT a non-universal Name (no <nameField> was serialized).
        expect(names).not.toContain('Name');
        // Every synthesized field is flagged so callers never treat it as a
        // real extracted field or imply the standard-field list is complete.
        for (const f of fields) {
          expect(f.properties['synthetic']).toBe(true);
          expect(f.properties['system']).toBe(true);
          expect(f.properties['provenance']).toBe('platform-standard');
        }
        // Each system field has a parentOf edge from the object, flagged synthetic.
        const edge = result.value.edges.find(
          (e) => e.toId === 'CustomField:Account.CreatedDate',
        );
        expect(edge?.fromId).toBe('CustomObject:Account');
        expect(edge?.edgeType).toBe('parentOf');
        expect(edge?.properties['synthetic']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does NOT synthesize system fields for a CUSTOM object (real fields are extracted from source)', async () => {
      const { dir, path } = await writeTempXml('Widget__c.object-meta.xml', VALID_XML);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes.every((n) => n.type === 'CustomObject')).toBe(true);
        expect(result.value.nodes.filter((n) => n.type === 'CustomField')).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when deploymentStatus is not in the allowed set', async () => {
      const xml = VALID_XML.replace(
        '<deploymentStatus>Deployed</deploymentStatus>',
        '<deploymentStatus>Bogus</deploymentStatus>',
      );
      const { dir, path } = await writeTempXml('BadStatus__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid deploymentStatus: Bogus');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when sharingModel is not in the allowed set', async () => {
      const xml = VALID_XML.replace(
        '<sharingModel>ReadWrite</sharingModel>',
        '<sharingModel>Nope</sharingModel>',
      );
      const { dir, path } = await writeTempXml('BadSharing__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid sharingModel: Nope');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('conditional required-element rules (per variant)', () => {
    // Standard __c still requires nameField + pluralLabel; the other
    // four suffixes (__mdt, __e, __b, __kav) treat them as optional
    // per CustomObject.md.
    it('standard __c still requires <nameField> (regression against pass-3 relaxation)', async () => {
      // Pass-3 relaxed <nameField> for CustomSetting (__c with
      // <customSettingsType>) only. The canonical CustomObject variant
      // — __c without <customSettingsType> — must still surface a
      // missing <nameField> as `malformed-input`.
      const xml = `<?xml version="1.0"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>No Name Field</label>
    <pluralLabel>No Name Fields</pluralLabel>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;
      const { dir, path } = await writeTempXml('NoNameField__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <nameField>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('standard __c still requires <pluralLabel>', async () => {
      const xml = `<?xml version="1.0"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>No Plural Label</label>
    <nameField><label>Name</label><type>Text</type></nameField>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;
      const { dir, path } = await writeTempXml('NoPlural__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <pluralLabel>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__mdt variant accepts missing <nameField>; nameFieldLabel/Type are null', async () => {
      // __mdt: deploymentStatus and sharingModel are both inapplicable;
      // their absence is a documented happy path. pluralLabel is
      // required.
      const xml = buildVariantXml('    <pluralLabel>My Settings</pluralLabel>');
      const { dir, path } = await writeTempXml('My_Setting__mdt.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomObject:My_Setting__mdt');
        expect(node.properties['nameFieldLabel']).toBeNull();
        expect(node.properties['nameFieldType']).toBeNull();
        expect(node.properties['pluralLabel']).toBe('My Settings');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__e (Platform Event) variant accepts missing <nameField>', async () => {
      // __e requires deploymentStatus; sharingModel is inapplicable.
      const xml = buildVariantXml(
        '    <deploymentStatus>Deployed</deploymentStatus>\n' +
          '    <pluralLabel>My Events</pluralLabel>',
      );
      const { dir, path } = await writeTempXml('My_Event__e.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomObject:My_Event__e');
        expect(node.properties['nameFieldLabel']).toBeNull();
        expect(node.properties['nameFieldType']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__b (Big Object) variant accepts missing <nameField>', async () => {
      const xml = buildVariantXml(
        '    <deploymentStatus>Deployed</deploymentStatus>\n' +
          '    <pluralLabel>My Bigs</pluralLabel>',
      );
      const { dir, path } = await writeTempXml('My_Big__b.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomObject:My_Big__b');
        expect(node.properties['nameFieldLabel']).toBeNull();
        expect(node.properties['nameFieldType']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__kav (Knowledge) variant accepts missing <nameField>', async () => {
      const xml = buildVariantXml(
        '    <deploymentStatus>Deployed</deploymentStatus>\n' +
          '    <pluralLabel>My Articles</pluralLabel>',
      );
      const { dir, path } = await writeTempXml('My_Article__kav.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomObject:My_Article__kav');
        expect(node.properties['nameFieldLabel']).toBeNull();
        expect(node.properties['nameFieldType']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__c Custom Setting (List) defaults pluralLabel to <label> when absent', async () => {
      // CustomSetting: nameField required; deploymentStatus and
      // sharingModel are inapplicable; pluralLabel optional.
      const xml = buildVariantXml(
        '    <customSettingsType>List</customSettingsType>\n' +
          '    <nameField><label>Name</label><type>Text</type></nameField>',
      );
      const { dir, path } = await writeTempXml(
        'My_List_Setting__c.object-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomObject:My_List_Setting__c');
        // pluralLabel falls back to the <label> value for CustomSetting
        // when <pluralLabel> is absent.
        expect(node.properties['pluralLabel']).toBe('Variant Label');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__c Custom Setting (Hierarchy) defaults pluralLabel to <label> when absent', async () => {
      const xml = buildVariantXml(
        '    <customSettingsType>Hierarchy</customSettingsType>\n' +
          '    <nameField><label>Name</label><type>Text</type></nameField>',
      );
      const { dir, path } = await writeTempXml(
        'My_Hier_Setting__c.object-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomObject:My_Hier_Setting__c');
        expect(node.properties['pluralLabel']).toBe('Variant Label');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__c Custom Setting accepts missing <nameField>; nameFieldLabel/Type are null', async () => {
      // Pass-3 relaxation: per the vendored CustomObject.md, the
      // CustomSetting variant treats <nameField> as optional. Salesforce
      // supplies the default Name field implicitly and does not
      // serialize <nameField> in DX source.
      const xml = buildVariantXml(
        '    <customSettingsType>List</customSettingsType>',
      );
      const { dir, path } = await writeTempXml(
        'No_NameField_Setting__c.object-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomObject:No_NameField_Setting__c');
        expect(node.properties['nameFieldLabel']).toBeNull();
        expect(node.properties['nameFieldType']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('conditional deploymentStatus / sharingModel rules', () => {
    it('__mdt accepts missing <deploymentStatus> and <sharingModel>', async () => {
      const xml = buildVariantXml('    <pluralLabel>Configs</pluralLabel>');
      const { dir, path } = await writeTempXml(
        'Config__mdt.object-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['deploymentStatus']).toBeNull();
        expect(node.properties['sharingModel']).toBeNull();
        expect(node.properties['visibility']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('CustomSetting accepts missing <deploymentStatus> and <sharingModel>; pluralLabel defaults to label', async () => {
      const xml = buildVariantXml(
        '    <customSettingsType>List</customSettingsType>\n' +
          '    <nameField><label>Name</label><type>Text</type></nameField>',
      );
      const { dir, path } = await writeTempXml(
        'My_Setting__c.object-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['deploymentStatus']).toBeNull();
        expect(node.properties['sharingModel']).toBeNull();
        expect(node.properties['pluralLabel']).toBe('Variant Label');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__e accepts missing <sharingModel>; sharingModel is null', async () => {
      const xml = buildVariantXml(
        '    <deploymentStatus>Deployed</deploymentStatus>\n' +
          '    <pluralLabel>Events</pluralLabel>',
      );
      const { dir, path } = await writeTempXml('Some_Event__e.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['sharingModel']).toBeNull();
        expect(node.properties['deploymentStatus']).toBe('Deployed');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('__e requires <deploymentStatus>; missing -> malformed-input', async () => {
      const xml = buildVariantXml('    <pluralLabel>Events</pluralLabel>');
      const { dir, path } = await writeTempXml(
        'No_Status_Event__e.object-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <deploymentStatus>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('standard __c still requires <deploymentStatus>', async () => {
      const xml = `<?xml version="1.0"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>No Status</label>
    <pluralLabel>No Statuses</pluralLabel>
    <nameField><label>Name</label><type>Text</type></nameField>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;
      const { dir, path } = await writeTempXml('NoStatus__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <deploymentStatus>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('standard __c still requires <sharingModel>', async () => {
      const xml = `<?xml version="1.0"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>No Sharing</label>
    <pluralLabel>No Sharings</pluralLabel>
    <nameField><label>Name</label><type>Text</type></nameField>
    <deploymentStatus>Deployed</deploymentStatus>
</CustomObject>`;
      const { dir, path } = await writeTempXml('NoSharing__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <sharingModel>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('invalid present <deploymentStatus> is rejected regardless of variant (__mdt)', async () => {
      // A malformed value is always a malformed value, even on variants
      // where the element is optional.
      const xml = buildVariantXml(
        '    <deploymentStatus>NotARealStatus</deploymentStatus>\n' +
          '    <pluralLabel>Bad</pluralLabel>',
      );
      const { dir, path } = await writeTempXml('Bad_Mdt__mdt.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'invalid deploymentStatus: NotARealStatus',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('invalid present <sharingModel> is rejected regardless of variant (__e)', async () => {
      const xml = buildVariantXml(
        '    <deploymentStatus>Deployed</deploymentStatus>\n' +
          '    <sharingModel>NotARealSharing</sharingModel>\n' +
          '    <pluralLabel>Events</pluralLabel>',
      );
      const { dir, path } = await writeTempXml(
        'Bad_Event__e.object-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid sharingModel: NotARealSharing');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('<externalSharingModel> reading', () => {
    // Real-org shape: OA_Communication_Request__c has both <sharingModel>ReadWrite
    // and <externalSharingModel>Private — the two OWDs are independent. Before
    // this fix, externalSharingModel was silently dropped; properties.externalSharingModel
    // was always undefined.
    it('extracts externalSharingModel=Private when present alongside sharingModel=ReadWrite', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <enableActivities>true</enableActivities>
    <enableHistory>true</enableHistory>
    <enableReports>true</enableReports>
    <enableSearch>true</enableSearch>
    <externalSharingModel>Private</externalSharingModel>
    <label>Communication Request</label>
    <nameField>
        <label>Communication Request Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Communication Request</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;
      const { dir, path } = await writeTempXml(
        'OA_Communication_Request__c.object-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // Internal OWD still reads correctly.
        expect(node.properties['sharingModel']).toBe('ReadWrite');
        // External OWD must now be surfaced (was undefined/missing before fix).
        expect(node.properties['externalSharingModel']).toBe('Private');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('stores externalSharingModel=null when the element is absent (standard objects, non-sharing variants)', async () => {
      // Standard custom object with no <externalSharingModel> element —
      // the property must be present in the map as null, not undefined.
      const { dir, path } = await writeTempXml('Widget__c.object-meta.xml', VALID_XML);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['externalSharingModel']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts externalSharingModel=ReadWrite when present', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <externalSharingModel>ReadWrite</externalSharingModel>
    <label>Portal Object</label>
    <nameField>
        <label>Portal Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Portal Objects</pluralLabel>
    <sharingModel>Private</sharingModel>
</CustomObject>`;
      const { dir, path } = await writeTempXml('Portal__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['sharingModel']).toBe('Private');
        expect(node.properties['externalSharingModel']).toBe('ReadWrite');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('<visibility> reading', () => {
    it('maps <visibility> to properties.visibility when present', async () => {
      const xml = buildVariantXml(
        '    <pluralLabel>Things</pluralLabel>\n' +
          '    <visibility>Protected</visibility>',
      );
      const { dir, path } = await writeTempXml('Visible__mdt.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['visibility']).toBe('Protected');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults properties.visibility to null when the element is absent', async () => {
      const xml = buildVariantXml('    <pluralLabel>Things</pluralLabel>');
      const { dir, path } = await writeTempXml('Hidden__mdt.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['visibility']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('real-fixture golden output (variant goldens)', () => {
    // Each test patches the golden's `sourcePath` to the resolved
    // absolute path, since the extractor records the path verbatim and
    // vitest's cwd is the package directory rather than the harness
    // root.
    itHarness('produces the golden for the Clinical_Instruction__mdt fixture', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, MDT_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, MDT_GOLDEN_PATH_REL);
      const result = await extractCustomObject(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden for the Application_Event__e fixture', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, E_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, E_GOLDEN_PATH_REL);
      const result = await extractCustomObject(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden for the SyncTable_DegreeProgram__b fixture', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, B_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, B_GOLDEN_PATH_REL);
      const result = await extractCustomObject(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden for the Knowledge__kav fixture', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, KAV_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, KAV_GOLDEN_PATH_REL);
      const result = await extractCustomObject(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden for the Related_List_Settings__c CustomSetting fixture', async () => {
      // Pass-3 recovery: the vendored CustomObject.md now lists
      // <nameField> as optional for the CustomSetting variant
      // (Salesforce supplies the default Name field implicitly and does
      // not serialize it in DX source). This fixture omits <nameField>,
      // <deploymentStatus>, <sharingModel>, and <pluralLabel>; per the
      // doc all four are inapplicable to CustomSetting, so the
      // extractor populates the properties map with the documented
      // defaults (nameFieldLabel/Type = null; deploymentStatus = null;
      // sharingModel = null; pluralLabel = value of <label>).
      const fixtureAbsPath = resolve(HARNESS_ROOT, CUSTOM_SETTING_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CUSTOM_SETTING_GOLDEN_PATH_REL);
      const result = await extractCustomObject(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('secondary smoke', () => {
    itHarness('successfully extracts a CustomObject from the edu-org fixture set', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SMOKE_FIXTURE_PATH_REL);
      const result = await extractCustomObject(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes).toHaveLength(1);
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.type).toBe('CustomObject');
      expect(node.id).toBe('CustomObject:Budget__c');
      expect(node.apiName).toBe('Budget__c');
      expect(result.value.edges).toEqual([]);
    });
  });

  describe('listViewButtons WebLink edge (OBJECT-SEARCHLAYOUT-LISTVIEWBUTTONS-UNGRAPHED)', () => {
    // An object's `<searchLayouts><listViewButtons>` names the custom List
    // Button (a WebLink) placed on its list views. Before the fix the extractor
    // emitted no edge for it, so a WebLink referenced ONLY as a list-view button
    // read as orphaned and `unused_components` flagged it deletable — deleting it
    // removes a live list-view button.
    it('emits a declared references edge CustomObject -> WebLink per listViewButton', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Widget</label>
    <nameField>
        <label>Widget Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Widgets</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
    <searchLayouts>
        <listViewButtons>My_Button</listViewButtons>
        <searchResultsAdditionalFields>NAME</searchResultsAdditionalFields>
    </searchLayouts>
</CustomObject>`;
      const { dir, path } = await writeTempXml('Widget__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const buttonEdge = result.value.edges.find(
          (e) => e.toId === 'WebLink:Widget__c.My_Button',
        );
        // RED pre-fix: no such edge exists (the placement was ungraphed).
        expect(buttonEdge).toBeDefined();
        if (!buttonEdge) return;
        expect(buttonEdge.fromId).toBe('CustomObject:Widget__c');
        expect(buttonEdge.edgeType).toBe('references');
        expect(buttonEdge.confidence).toBe('declared');
        expect(buttonEdge.source).toBe('custom-object-extractor');
        expect(buttonEdge.properties).toEqual({
          via: 'listViewButtons',
          targetKind: 'listViewButton',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('dedupes repeated listViewButtons and emits none for an absent/empty block', async () => {
      const withDupes = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Widget</label>
    <nameField>
        <label>Widget Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Widgets</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
    <searchLayouts>
        <listViewButtons>My_Button</listViewButtons>
        <listViewButtons>My_Button</listViewButtons>
    </searchLayouts>
</CustomObject>`;
      const a = await writeTempXml('Widget__c.object-meta.xml', withDupes);
      try {
        const result = await extractCustomObject(a.path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter(
            (e) => e.toId === 'WebLink:Widget__c.My_Button',
          ),
        ).toHaveLength(1);
      } finally {
        await rm(a.dir, { recursive: true, force: true });
      }
      // No searchLayouts block at all -> no listViewButton edges.
      const b = await writeTempXml('Widget__c.object-meta.xml', VALID_XML);
      try {
        const result = await extractCustomObject(b.path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some((e) => e.toId.startsWith('WebLink:')),
        ).toBe(false);
      } finally {
        await rm(b.dir, { recursive: true, force: true });
      }
    });
  });

  describe('compactLayoutAssignment CompactLayout edge (COMPACT-LAYOUT-ASSIGNMENT-UNGRAPHED)', () => {
    // An object's `<compactLayoutAssignment>` names its PRIMARY compact layout —
    // the one users see in the Lightning highlights panel. Before the fix the
    // extractor emitted no edge for it, so an assigned compact layout carried no
    // inbound usage edge, read as orphaned, and `unused_components` flagged it
    // deletable — deleting it removes the layout users actually see.
    it('emits a declared references edge CustomObject -> CompactLayout for a named assignment', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <compactLayoutAssignment>My_Compact_Layout</compactLayoutAssignment>
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Widget</label>
    <nameField>
        <label>Widget Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Widgets</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;
      const { dir, path } = await writeTempXml('Widget__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const clEdge = result.value.edges.find(
          (e) => e.toId === 'CompactLayout:Widget__c.My_Compact_Layout',
        );
        // RED pre-fix: no such edge exists (the assignment was ungraphed).
        expect(clEdge).toBeDefined();
        if (!clEdge) return;
        expect(clEdge.fromId).toBe('CustomObject:Widget__c');
        expect(clEdge.edgeType).toBe('references');
        expect(clEdge.confidence).toBe('declared');
        expect(clEdge.source).toBe('custom-object-extractor');
        expect(clEdge.properties).toEqual({ via: 'compactLayoutAssignment' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('skips the reserved SYSTEM default (never mints a CompactLayout phantom)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <compactLayoutAssignment>SYSTEM</compactLayoutAssignment>
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Widget</label>
    <nameField>
        <label>Widget Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Widgets</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`;
      const { dir, path } = await writeTempXml('Widget__c.object-meta.xml', xml);
      try {
        const result = await extractCustomObject(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some((e) => e.toId.startsWith('CompactLayout:')),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('deriveEntityVariant', () => {
  it('maps __mdt to CustomMetadataType', () => {
    expect(deriveEntityVariant('Country__mdt', false)).toBe('CustomMetadataType');
  });

  it('maps __e to PlatformEvent', () => {
    expect(deriveEntityVariant('Application_Event__e', false)).toBe('PlatformEvent');
  });

  it('maps __b to BigObject', () => {
    expect(deriveEntityVariant('SyncTable__b', false)).toBe('BigObject');
  });

  it('maps __kav to KnowledgeArticle', () => {
    expect(deriveEntityVariant('Knowledge__kav', false)).toBe('KnowledgeArticle');
  });

  it('maps __c with customSettingsType to CustomSetting', () => {
    expect(deriveEntityVariant('Marketo_Api_Settings__c', true)).toBe('CustomSetting');
  });

  it('maps __c without customSettingsType to CustomObject', () => {
    expect(deriveEntityVariant('CustomerProject__c', false)).toBe('CustomObject');
  });

  it('treats a missing suffix as StandardObject (out of v0.1 extractor scope)', () => {
    // The extractor never runs on standard objects in v0.1; this branch
    // exists only so the type covers the full match-precedence table.
    expect(deriveEntityVariant('Account', false)).toBe('StandardObject');
  });
});
