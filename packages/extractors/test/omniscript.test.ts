/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractOmniScript } from '../src/omniscript.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const SAMPLE_FIXTURE_REL =
  'tests/fixtures/synthetic-v3.2/omniScripts/Sample_Linking_English_1.os-meta.xml';
const NAV_FIXTURE_REL =
  'tests/fixtures/synthetic-v3.2/omniScripts/Sample_Navigation_English_1.os-meta.xml';
const EMPTY_FIXTURE_REL =
  'tests/fixtures/synthetic-v3.2/omniScripts/Empty_Placeholder_English_1.os-meta.xml';

/**
 * Write content to a fresh `.os-meta.xml` file under a fresh temp dir.
 * Returns the parent dir for cleanup and the absolute file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-omniscript-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractOmniScript', () => {
  describe('happy path — synthetic fixture with all edge-emitting element types', () => {
    itHarness('parses Sample_Linking_English_1 with header, elements, and dispatch edges', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SAMPLE_FIXTURE_REL);
      const result = await extractOmniScript(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.nodes).toHaveLength(1);
      const node = result.value.nodes[0]!;
      expect(node.id).toBe('OmniScript:Sample_Linking_English_1');
      expect(node.type).toBe('OmniScript');
      expect(node.apiName).toBe('Sample_Linking_English_1');
      expect(node.label).toBe('Sample Linking Flow');
      expect(node.parentId).toBeNull();
      expect(node.sourcePath).toBe(fixtureAbsPath);

      // Identity properties from top-level XML elements (per
      // OmniScript.md "Required" + "Optional top-level" tables).
      expect(node.properties.uniqueName).toBe('Sample_Linking_English_1');
      expect(node.properties.omniProcessType).toBe('OmniScript');
      expect(node.properties.versionNumber).toBe(1.0);
      expect(node.properties.language).toBe('English');
      expect(node.properties.subType).toBe('Linking');
      expect(node.properties.type).toBe('Sample');
      expect(node.properties.omniProcessKey).toBe('Sample_Linking');
      expect(node.properties.isActive).toBe(true);
      expect(node.properties.isWebCompEnabled).toBe(true);
      expect(node.properties.isOmniScriptEmbeddable).toBe(true);

      // Top-level propertySetConfig parsed for well-known UI keys.
      expect(node.properties.allowSaveForLater).toBe(true);
      expect(node.properties.enableKnowledge).toBe(false);
      expect(node.properties.currentLanguage).toBe('en_US');
      expect(node.properties.scrollBehavior).toBe('auto');
      expect(node.properties.stepChartPlacement).toBe('right');

      // Element count includes nested childElements (Step + nested
      // CustomLWC1 + DR Extract Action + IP Action + Navigate Action = 5).
      expect(node.properties.elementCount).toBe(5);
      expect(node.properties.omniScriptExtractionWarnings).toEqual([]);

      // Edges: one DR-extract, one IP, no edge for the Web-Page Navigate.
      // Sorted by toId ascending.
      expect(result.value.edges).toHaveLength(2);
      expect(result.value.edges).toEqual([
        {
          fromId: 'OmniScript:Sample_Linking_English_1',
          toId: 'OmniDataTransform:ExtractContactMapper',
          edgeType: 'dispatchesOmniAction',
          confidence: 'parsed',
          source: 'omniscript-extractor',
          properties: {
            stepName: 'extractContact',
            stepType: 'DataRaptor Extract Action',
            level: 0,
            sequenceNumber: 1,
            targetRawName: 'ExtractContactMapper',
          },
        },
        {
          fromId: 'OmniScript:Sample_Linking_English_1',
          toId: 'OmniIntegrationProcedure:UserSearch_Existing',
          edgeType: 'dispatchesOmniAction',
          confidence: 'parsed',
          source: 'omniscript-extractor',
          properties: {
            stepName: 'callUserSearchIp',
            stepType: 'Integration Procedure Action',
            level: 0,
            sequenceNumber: 2,
            targetRawName: 'UserSearch_Existing',
          },
        },
      ]);
    });
  });

  describe('Navigate Action edge cases', () => {
    itHarness('emits a dispatchesOmniAction edge when Navigate Action targetType is OmniScript', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, NAV_FIXTURE_REL);
      const result = await extractOmniScript(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.edges).toHaveLength(1);
      const edge = result.value.edges[0]!;
      expect(edge.toId).toBe('OmniScript:Sample_Linking_English_1');
      expect(edge.edgeType).toBe('dispatchesOmniAction');
      expect(edge.confidence).toBe('parsed');
      expect((edge.properties as Record<string, unknown>).stepType).toBe(
        'Navigate Action',
      );
      expect((edge.properties as Record<string, unknown>).targetRawName).toBe(
        'Sample_Linking_English_1',
      );
    });

    it('does NOT emit an edge for a Navigate Action with targetType=Web Page', async () => {
      // The Sample_Linking_English_1 fixture's goToHome Navigate is a Web
      // Page; we asserted above that result.edges has only the DR and IP
      // edges (length 2), implicitly confirming the Web-Page navigate
      // produced no edge. This test re-asserts via an isolated synthetic.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
  <isActive>true</isActive>
  <isIntegrationProcedure>false</isIntegrationProcedure>
  <language>English</language>
  <name>WebPage Only</name>
  <omniProcessElements>
    <isActive>true</isActive>
    <level>0.0</level>
    <name>navHome</name>
    <propertySetConfig>{&quot;targetType&quot;:&quot;Web Page&quot;,&quot;targetUrl&quot;:&quot;/s&quot;}</propertySetConfig>
    <sequenceNumber>0.0</sequenceNumber>
    <type>Navigate Action</type>
  </omniProcessElements>
  <omniProcessType>OmniScript</omniProcessType>
  <subType>Only</subType>
  <type>WebPage</type>
  <uniqueName>WebPage_Only_English_1</uniqueName>
  <versionNumber>1.0</versionNumber>
</OmniScript>`;
      const { dir, path } = await writeTempXml(
        'WebPage_Only_English_1.os-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniScript(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits a dispatchesOmniAction IP edge for a Step that invokes an IP on Next', async () => {
      // A non-"Integration Procedure Action" element can still invoke an IP:
      // the integrationProcedureKey lives in its propertySetConfig. Real shape:
      // example.gov AccountLinking_Existing has a "Next" Navigate Action whose
      // config carries integrationProcedureKey=AccountLiniking_MPPValidation,
      // which the type/targetType gate dropped. The dependency must surface for
      // ANY element carrying the key (a Step here, as the simplest isolated
      // case — Step is not in EDGE_EMITTING_TYPES at all).
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
  <isActive>true</isActive>
  <isIntegrationProcedure>false</isIntegrationProcedure>
  <language>English</language>
  <name>StepIP</name>
  <omniProcessElements>
    <isActive>true</isActive>
    <level>0.0</level>
    <name>MPPCodeScreen</name>
    <propertySetConfig>{&quot;label&quot;:&quot;Next&quot;,&quot;integrationProcedureKey&quot;:&quot;MyOrg_MPPValidation&quot;,&quot;useContinuation&quot;:false}</propertySetConfig>
    <sequenceNumber>0.0</sequenceNumber>
    <type>Step</type>
  </omniProcessElements>
  <omniProcessType>OmniScript</omniProcessType>
  <subType>IP</subType>
  <type>StepIP</type>
  <uniqueName>StepIP_English_1</uniqueName>
  <versionNumber>1.0</versionNumber>
</OmniScript>`;
      const { dir, path } = await writeTempXml(
        'StepIP_English_1.os-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniScript(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const ipEdges = result.value.edges.filter(
          (e) => e.edgeType === 'dispatchesOmniAction',
        );
        expect(ipEdges).toHaveLength(1);
        expect(ipEdges[0]?.toId).toBe(
          'OmniIntegrationProcedure:MyOrg_MPPValidation',
        );
        expect(ipEdges[0]?.properties['stepType']).toBe('Step');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('minimal / placeholder shapes', () => {
    itHarness('extracts an empty placeholder OmniScript with xsi:nil identity fields', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, EMPTY_FIXTURE_REL);
      const result = await extractOmniScript(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.nodes).toHaveLength(1);
      const node = result.value.nodes[0]!;
      expect(node.id).toBe('OmniScript:Empty_Placeholder_English_1');
      expect(node.apiName).toBe('Empty_Placeholder_English_1');
      // xsi:nil identity fields → null per toNullableString's
      // object-rejection branch.
      expect(node.properties.uniqueName).toBeNull();
      expect(node.properties.omniProcessType).toBeNull();
      expect(node.properties.type).toBeNull();
      expect(node.properties.subType).toBeNull();
      expect(node.properties.omniProcessKey).toBeNull();
      expect(node.properties.elementCount).toBe(0);
      expect(result.value.edges).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.os-meta.xml';
      const result = await extractOmniScript(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Bad.os-meta.xml',
        '<?xml version="1.0"?><OmniScript><name>X</wrongClose></OmniScript>',
      );
      try {
        const result = await extractOmniScript(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <OmniScript>', async () => {
      const { dir, path } = await writeTempXml(
        'Wrong.os-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractOmniScript(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <OmniScript> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the file declares isIntegrationProcedure=true', async () => {
      // OmniScript and OmniIntegrationProcedure share the <OmniScript>
      // root; an IP file declares <isIntegrationProcedure>true. The
      // sibling omni-integration-procedure extractor handles those;
      // this extractor refuses them defensively.
      const xml = `<?xml version="1.0"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
  <isActive>true</isActive>
  <isIntegrationProcedure>true</isIntegrationProcedure>
  <name>An IP not an OS</name>
  <omniProcessType>Integration Procedure</omniProcessType>
  <uniqueName>IP_Not_OS_1</uniqueName>
  <versionNumber>1.0</versionNumber>
</OmniScript>`;
      const { dir, path } = await writeTempXml('IP_Not_OS_1.os-meta.xml', xml);
      try {
        const result = await extractOmniScript(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toContain('isIntegrationProcedure');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('warning collection for malformed propertySetConfig blobs', () => {
    it('captures a warning when an element\'s propertySetConfig is not valid JSON', async () => {
      // The XML's propertySetConfig is literally not JSON — collect a
      // warning rather than crash the whole extraction (v3.2 honesty
      // axis: best-effort JSON parsing).
      const xml = `<?xml version="1.0"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
  <isActive>true</isActive>
  <isIntegrationProcedure>false</isIntegrationProcedure>
  <language>English</language>
  <name>Bad JSON</name>
  <omniProcessElements>
    <isActive>true</isActive>
    <level>0.0</level>
    <name>extractFoo</name>
    <propertySetConfig>not valid json at all</propertySetConfig>
    <sequenceNumber>0.0</sequenceNumber>
    <type>DataRaptor Extract Action</type>
  </omniProcessElements>
  <omniProcessType>OmniScript</omniProcessType>
  <subType>JSON</subType>
  <type>Bad</type>
  <uniqueName>Bad_JSON_English_1</uniqueName>
  <versionNumber>1.0</versionNumber>
</OmniScript>`;
      const { dir, path } = await writeTempXml('Bad_JSON_English_1.os-meta.xml', xml);
      try {
        const result = await extractOmniScript(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        const warnings = node.properties
          .omniScriptExtractionWarnings as readonly string[];
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain('failed to parse propertySetConfig');
        // No edge emitted because the JSON failed to parse — the bundle
        // name was never resolved.
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
