/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractOmniUiCard } from '../src/omni-ui-card.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const SYNTHETIC_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v3.2/omniUiCard/SampleLinkingIntro_Developer_1.ouc-meta.xml';

/**
 * Write a `.ouc-meta.xml` file under a fresh temp directory. Returns the
 * temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempCardXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-omni-ui-card-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Serialize an object to the HTML-entity-escaped JSON shape Salesforce
 * writes into `<dataSourceConfig>` / `<propertySetConfig>` — only `"` is
 * encoded as `&quot;` (the production exporter's convention, which
 * fast-xml-parser's entity processor decodes before the extractor sees
 * the blob). Nested stringified-JSON values (e.g. a DataAction's
 * `message`) round-trip because their backslash-escaped quotes survive:
 * `\"` -> `\&quot;` -> (decoded) `\"`. Test inputs must avoid raw
 * `<`, `>`, and `&` so the result stays valid XML text.
 */
const esc = (obj: unknown): string =>
  JSON.stringify(obj).replace(/"/g, '&quot;');

describe('extractOmniUiCard', () => {
  describe('happy path on synthetic fixture', () => {
    itHarness('emits a Node with the expected identity and shape', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes).toHaveLength(1);
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('OmniUiCard:SampleLinkingIntro_Developer_1');
      expect(node.type).toBe('OmniUiCard');
      expect(node.apiName).toBe('SampleLinkingIntro_Developer_1');
      expect(node.label).toBe('SampleLinkingIntro');
      expect(node.parentId).toBeNull();
      expect(node.sourcePath).toBe(fixtureAbsPath);
    });

    itHarness('surfaces the top-level XML properties verbatim', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.properties['omniUiCardType']).toBe('Parent');
      expect(node.properties['authorName']).toBe('Developer');
      expect(node.properties['versionNumber']).toBe(1);
      expect(node.properties['isActive']).toBe(true);
      expect(node.properties['isManagedUsingStdDesigner']).toBe(false);
      expect(node.properties['name']).toBe('SampleLinkingIntro');
    });

    itHarness('parses the propertySetConfig JSON for state and widget counts', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      // Two states: Introduction + Confirmation.
      expect(node.properties['stateCount']).toBe(2);
      // Introduction has 3 widgets (Text, Block + nested Action),
      // Confirmation has 2 widgets (two Action widgets). Total = 5.
      expect(node.properties['widgetCount']).toBe(5);
      // No embedded omniscripts in the synthetic fixture.
      expect(node.properties['embeddedScriptCount']).toBe(0);
    });

    itHarness('parses the dataSourceConfig JSON for data source metadata', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.properties['dataSourceType']).toBe('DataRaptor');
      expect(node.properties['dataSourceContextVariables']).toEqual([
        'recordId',
        'card',
      ]);
    });

    itHarness('emits zero warnings for clean input', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.properties['omniUiCardExtractionWarnings']).toEqual([]);
    });
  });

  describe('dispatchesOmniAction edges', () => {
    itHarness('emits one edge per Action widget with an OmniScript or IP target', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The synthetic fixture has:
      //   - State 0 (Introduction): one OmniScript Action nested in a Block.
      //   - State 1 (Confirmation): one IP Action + one Web Page Action.
      // Web Page actions emit no edge. The card may additionally emit a
      // `dataSource`->`OmniDataTransform` DataRaptor edge (the fixture's
      // dataSource is a DataRaptor), so scope this assertion to the
      // OmniScript / Integration Procedure Action-widget edges the test
      // is about. Expected: 2 such edges.
      const osIpEdges = result.value.edges.filter(
        (e) =>
          e.toId.startsWith('OmniScript:') ||
          e.toId.startsWith('OmniIntegrationProcedure:'),
      );
      expect(osIpEdges).toHaveLength(2);
    });

    itHarness('emits an OmniScript edge with the verbatim omniType.Name as the target', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const osEdge = result.value.edges.find(
        (e) => e.toId === 'OmniScript:Sample/Linking/English',
      );
      expect(osEdge).toBeDefined();
      if (!osEdge) return;
      expect(osEdge.fromId).toBe('OmniUiCard:SampleLinkingIntro_Developer_1');
      expect(osEdge.edgeType).toBe('dispatchesOmniAction');
      expect(osEdge.confidence).toBe('parsed');
      expect(osEdge.source).toBe('omni-ui-card');
      expect(osEdge.properties['stateName']).toBe('Introduction');
      expect(osEdge.properties['stateIndex']).toBe(0);
      expect(osEdge.properties['widgetLabel']).toBe(
        'Block-1-Action-StartLinking',
      );
      expect(osEdge.properties['actionListIndex']).toBe(0);
      expect(osEdge.properties['actionType']).toBe('OmniScript');
      expect(osEdge.properties['targetRawName']).toBe(
        'Sample/Linking/English',
      );
    });

    itHarness('emits an IP edge with the verbatim integrationProcedureKey as the target', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ipEdge = result.value.edges.find(
        (e) =>
          e.toId === 'OmniIntegrationProcedure:SampleConfirmation_Procedure',
      );
      expect(ipEdge).toBeDefined();
      if (!ipEdge) return;
      expect(ipEdge.fromId).toBe('OmniUiCard:SampleLinkingIntro_Developer_1');
      expect(ipEdge.edgeType).toBe('dispatchesOmniAction');
      expect(ipEdge.confidence).toBe('parsed');
      expect(ipEdge.source).toBe('omni-ui-card');
      expect(ipEdge.properties['stateName']).toBe('Confirmation');
      expect(ipEdge.properties['stateIndex']).toBe(1);
      expect(ipEdge.properties['actionType']).toBe('Integration Procedure');
      expect(ipEdge.properties['targetRawName']).toBe(
        'SampleConfirmation_Procedure',
      );
    });

    itHarness('does NOT emit an edge for Web Page / Custom actions', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The synthetic fixture has a Custom-typed "Back Home" Action
      // widget; no edge should land for it (a Custom action carries no
      // OmniStudio dispatch target).
      const noEdge = result.value.edges.find(
        (e) => String(e.toId).includes('/home'),
      );
      expect(noEdge).toBeUndefined();
      // Every emitted edge targets a known OmniStudio node type. A
      // DataRaptor dispatch (the card's own DataRaptor dataSource, or a
      // DataAction widget loading a DataRaptor) targets `OmniDataTransform:`;
      // OmniScript / Integration Procedure Action widgets target theirs.
      for (const edge of result.value.edges) {
        expect(
          edge.toId.startsWith('OmniScript:') ||
            edge.toId.startsWith('OmniIntegrationProcedure:') ||
            edge.toId.startsWith('OmniDataTransform:'),
        ).toBe(true);
      }
    });

    // --- DataRaptor dispatch edges (the v3.3 consistency fix) -------------
    // A FlexCard depends on a DataRaptor in two real ways, both of which
    // the OmniScript / Integration Procedure extractors already model as
    // `dispatchesOmniAction` -> `OmniDataTransform:{bundle}`:
    //   1. its own `dataSource` (type `DataRaptor`, the card's passive
    //      data-load when it renders), and
    //   2. a `DataAction` Action widget whose stringified-JSON `message`
    //      wraps a DataRaptor load.
    // These tests are fixture-free (plain `it`) so they run in the
    // published product copy too. Real-world shapes are taken verbatim
    // from a real state-agency org recon (openPdfPOC_Developer_2 ->
    // IEEGetDocContentVersion via dataSource; IEEClientSearchResultChildFC
    // _Developer_7 -> IEEUpdateContactInfoforMA21 via a DataAction).

    it('emits a dispatchesOmniAction edge to OmniDataTransform when the card dataSource is a DataRaptor', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <isActive>true</isActive>
    <name>DrDataSourceCard</name>
    <omniUiCardType>Parent</omniUiCardType>
    <dataSourceConfig>${esc({
      dataSource: {
        type: 'DataRaptor',
        value: { bundle: 'DR_GetDocContent', bundleType: '' },
        contextVariables: [{ name: 'recordId', val: 'x', id: 1 }],
      },
    })}</dataSourceConfig>
    <propertySetConfig>${esc({ states: [] })}</propertySetConfig>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;
      const { dir, path } = await writeTempCardXml(
        'DrDataSourceCard_Developer_1.ouc-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniUiCard(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The card's DataRaptor dataSource is the only dispatch here.
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe('OmniDataTransform:DR_GetDocContent');
        expect(edge.fromId).toBe('OmniUiCard:DrDataSourceCard_Developer_1');
        expect(edge.edgeType).toBe('dispatchesOmniAction');
        expect(edge.confidence).toBe('parsed');
        expect(edge.source).toBe('omni-ui-card');
        expect(edge.properties['dispatchSource']).toBe('dataSource');
        expect(edge.properties['dataSourceType']).toBe('DataRaptor');
        expect(edge.properties['targetRawName']).toBe('DR_GetDocContent');
        // The node still surfaces the dataSourceType property unchanged.
        expect(result.value.nodes[0]?.properties['dataSourceType']).toBe(
          'DataRaptor',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does NOT emit a dataSource edge for IntegrationProcedures / ApexRemote / Custom data sources (deferred or out of scope)', async () => {
      // These are real card dependencies too, but card->IP and card->Apex
      // are deliberately not modeled in the DataRaptor-scoped v3.3 change
      // (see the omni-ui-card.ts "Edge emission rules" disclosure).
      for (const dataSource of [
        { type: 'IntegrationProcedures', value: { ipMethod: 'Acme_GetData' } },
        {
          type: 'ApexRemote',
          value: { remoteClass: 'FooController', remoteMethod: 'bar' },
        },
        { type: 'Custom', value: {} },
      ]) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <isActive>true</isActive>
    <name>NonDrCard</name>
    <omniUiCardType>Parent</omniUiCardType>
    <dataSourceConfig>${esc({ dataSource })}</dataSourceConfig>
    <propertySetConfig>${esc({ states: [] })}</propertySetConfig>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;
        const { dir, path } = await writeTempCardXml(
          'NonDrCard_Developer_1.ouc-meta.xml',
          xml,
        );
        try {
          const result = await extractOmniUiCard(path);
          expect(result.ok).toBe(true);
          if (!result.ok) continue;
          expect(result.value.edges).toHaveLength(0);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    });

    it('emits a DataRaptor edge for a DataAction widget while its Apex/Web Page/Custom siblings stay silent', async () => {
      // One Action widget with four actionList entries: a DataAction that
      // loads a DataRaptor (emits one edge), a DataAction that calls Apex
      // (silent), a Web Page navigate (silent), and a Custom action (silent).
      const propertySetConfig = {
        states: [
          {
            name: 'S0',
            components: {
              'layer-0': {
                children: [
                  {
                    name: 'Action',
                    elementLabel: 'MixedActions',
                    property: {
                      actionList: [
                        {
                          stateAction: {
                            type: 'DataAction',
                            targetType: 'Web Page',
                            message: JSON.stringify({
                              type: 'DataRaptor',
                              value: { bundle: 'DR_LoadThing', bundleType: 'Load' },
                            }),
                          },
                        },
                        {
                          stateAction: {
                            type: 'DataAction',
                            message: JSON.stringify({
                              type: 'ApexRemote',
                              value: { remoteClass: 'FooController' },
                            }),
                          },
                        },
                        {
                          stateAction: {
                            type: 'Web Page',
                            'Web Page': { targetName: '/home' },
                          },
                        },
                        { stateAction: { type: 'Custom' } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      };
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <isActive>true</isActive>
    <name>DataActionCard</name>
    <omniUiCardType>Parent</omniUiCardType>
    <propertySetConfig>${esc(propertySetConfig)}</propertySetConfig>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;
      const { dir, path } = await writeTempCardXml(
        'DataActionCard_Developer_1.ouc-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniUiCard(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Exactly one edge: the DataAction -> DataRaptor.
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe('OmniDataTransform:DR_LoadThing');
        expect(edge.edgeType).toBe('dispatchesOmniAction');
        expect(edge.confidence).toBe('parsed');
        expect(edge.source).toBe('omni-ui-card');
        expect(edge.properties['actionType']).toBe('DataAction');
        expect(edge.properties['dataActionType']).toBe('DataRaptor');
        expect(edge.properties['targetRawName']).toBe('DR_LoadThing');
        expect(edge.properties['widgetLabel']).toBe('MixedActions');
        // No edge for the Apex / Web Page / Custom siblings.
        expect(
          result.value.edges.find((e) => String(e.toId).includes('/home')),
        ).toBeUndefined();
        expect(
          result.value.edges.find((e) =>
            String(e.toId).includes('FooController'),
          ),
        ).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('sorts edges by toId then edgeType for stable byte-equal output', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.edges.map((e) => e.toId);
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });

    itHarness('finds Action widgets nested inside Block container children', async () => {
      // The first state's only Action lives inside a Block. The edge
      // count test above implicitly covers nesting, but assert the
      // widget's containing label explicitly to keep the recursion
      // contract pinned.
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_PATH_REL);
      const result = await extractOmniUiCard(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const nestedEdge = result.value.edges.find(
        (e) => e.toId === 'OmniScript:Sample/Linking/English',
      );
      expect(nestedEdge).toBeDefined();
      if (!nestedEdge) return;
      expect(nestedEdge.properties['widgetLabel']).toBe(
        'Block-1-Action-StartLinking',
      );
    });
  });

  describe('warning collection on best-effort JSON parsing', () => {
    it('records a warning when propertySetConfig JSON is malformed', async () => {
      // propertySetConfig holds invalid JSON (single quote instead of
      // double). The extractor should not fail; it should record a
      // warning and produce a node with stateCount = 0.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <isActive>false</isActive>
    <name>BadJsonCard</name>
    <omniUiCardType>Parent</omniUiCardType>
    <propertySetConfig>{not valid json}</propertySetConfig>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;
      const { dir, path } = await writeTempCardXml(
        'BadJsonCard_Developer_1.ouc-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniUiCard(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['stateCount']).toBe(0);
        expect(node.properties['widgetCount']).toBe(0);
        const warnings = node.properties[
          'omniUiCardExtractionWarnings'
        ] as readonly string[];
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.some((w) => w.includes('propertySetConfig'))).toBe(
          true,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('records a warning when an OmniScript action has no omniType.Name', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <isActive>true</isActive>
    <name>DanglingCard</name>
    <omniUiCardType>Parent</omniUiCardType>
    <propertySetConfig>{&quot;states&quot;:[{&quot;name&quot;:&quot;S0&quot;,&quot;components&quot;:{&quot;layer-0&quot;:{&quot;children&quot;:[{&quot;name&quot;:&quot;Action&quot;,&quot;elementLabel&quot;:&quot;NoOmni&quot;,&quot;stateIndex&quot;:0,&quot;property&quot;:{&quot;actionList&quot;:[{&quot;stateAction&quot;:{&quot;type&quot;:&quot;OmniScript&quot;}}]}}]}}}]}</propertySetConfig>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;
      const { dir, path } = await writeTempCardXml(
        'DanglingCard_Developer_1.ouc-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniUiCard(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // No edge should land — the missing target name is a dangling
        // dispatch, not an edge.
        expect(result.value.edges).toHaveLength(0);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        const warnings = node.properties[
          'omniUiCardExtractionWarnings'
        ] as readonly string[];
        expect(warnings.some((w) => w.includes('omniType.Name'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.ouc-meta.xml';
      const result = await extractOmniUiCard(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempCardXml(
        'Bad.ouc-meta.xml',
        '<?xml version="1.0"?><OmniUiCard><name>X</wrongClose></OmniUiCard>',
      );
      try {
        const result = await extractOmniUiCard(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <OmniUiCard>', async () => {
      const { dir, path } = await writeTempCardXml(
        'Wrong.ouc-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractOmniUiCard(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <OmniUiCard> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('produces a node with null label when <name> is absent', async () => {
      // <name> missing entirely; the extractor should produce a node
      // and surface label as null. Other identity fields default per
      // the optional-string helpers.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;
      const { dir, path } = await writeTempCardXml(
        'NoName_Developer_1.ouc-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniUiCard(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.label).toBeNull();
        expect(node.apiName).toBe('NoName_Developer_1');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
