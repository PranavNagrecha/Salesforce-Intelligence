/// <reference types="vitest/globals" />

/**
 * Tests for the `sfi.omniuicard_widget_breakdown` MCP tool (v3.2 R3d).
 *
 * Coverage:
 *   - happy path on a two-state FlexCard fixture with nested Block
 *     widgets and Action widgets that dispatch to an OmniScript + an
 *     Integration Procedure.
 *   - widget tree preserves the propertySetConfig JSON's declared
 *     order (matches the parsing-disclosure axis).
 *   - `widgetCount` is the recursive count (container Block widgets
 *     contribute their own count + their children's counts).
 *   - metadata fields (`omniUiCardType`, `authorName`,
 *     `versionNumber`, `isActive`, `isManagedUsingStdDesigner`) come
 *     from the v3.2 R2 extractor's node properties.
 *   - `dataSource.type` + `contextVariables[]` come from the
 *     extractor's parsed dataSourceConfig.
 *   - `dispatchedActions[]` come from the `dispatchesOmniAction`
 *     edge family the extractor emitted; sorted deterministically.
 *   - Verbatim boundary disclosures: propertySetConfig-parsing AND
 *     Native-vs-Vlocity-Legacy.
 *   - graceful degrade: source XML missing → states[] empty,
 *     metadata + boundaries still surface.
 *   - graceful degrade: source XML malformed JSON → states[] empty.
 *   - `invalid-query` for a wrong id prefix.
 *   - `component-not-found` for a well-formed but missing id.
 *   - `component-not-found` when the id resolves to a non-OmniUiCard
 *     node (cross-type confusion at the id boundary).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { omniuicardWidgetBreakdownHandler } from '../../src/tools/omniuicard-widget-breakdown.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    OmniUiCard: 2,
  },
  edges: { dispatchesOmniAction: 2 },
  sourceTreeHash: 'sha256:omniuicard-widget-breakdown-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'OmniUiCard',
  apiName: 'placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// =============================================================================
// Two-state FlexCard fixture. Introduction state has a Text widget +
// a Block containing one Action widget that dispatches to an
// OmniScript. Confirmation state has one Action that dispatches to an
// Integration Procedure plus one Custom (non-dispatchable) Action.
// The propertySetConfig JSON is HTML-entity-escaped exactly as
// Salesforce's exporter emits it.
// =============================================================================

const SAMPLE_CARD_ID = 'OmniUiCard:SampleLinkingIntro_Developer_1';
const MISSING_SOURCE_CARD_ID = 'OmniUiCard:MissingSource_Developer_1';
const MALFORMED_JSON_CARD_ID = 'OmniUiCard:MalformedJson_Developer_1';
// The source file vanished from the vault AFTER the refresh that stamped
// the aggregates: the node still says 3 states / 12 widgets.
const STALE_SOURCE_CARD_ID = 'OmniUiCard:StaleSource_Developer_1';
// XML that does not validate at all (unclosed element).
const MALFORMED_XML_CARD_ID = 'OmniUiCard:MalformedXml_Developer_1';
// Node built by a refresh that predates the v3.2 R2 OmniUiCard extractor:
// it carries NO `stateCount` property at all.
const PRE_EXTRACTOR_CARD_ID = 'OmniUiCard:PreExtractor_Developer_1';
// Same on-disk XML as the sample card, but the node's aggregates disagree
// with what is on disk now (the file changed after the refresh).
const DRIFTED_CARD_ID = 'OmniUiCard:Drifted_Developer_1';
// A card whose one state hangs its widgets off `layer-1`, which v3.2 does
// not walk.
const OTHER_LAYER_CARD_ID = 'OmniUiCard:OtherLayer_Developer_1';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <dataSourceConfig>{&quot;dataSource&quot;:{&quot;type&quot;:&quot;DataRaptor&quot;,&quot;value&quot;:{&quot;dataRaptorName&quot;:&quot;ExtractSampleMapper&quot;},&quot;orderBy&quot;:{},&quot;contextVariables&quot;:[&quot;recordId&quot;,&quot;card&quot;]}}</dataSourceConfig>
    <isActive>true</isActive>
    <isManagedUsingStdDesigner>false</isManagedUsingStdDesigner>
    <name>SampleLinkingIntro</name>
    <omniUiCardType>Parent</omniUiCardType>
    <propertySetConfig>{&quot;states&quot;:[{&quot;name&quot;:&quot;Introduction&quot;,&quot;isSmartAction&quot;:false,&quot;fields&quot;:[],&quot;conditions&quot;:{&quot;id&quot;:&quot;state-condition-object&quot;,&quot;isParent&quot;:true,&quot;group&quot;:[]},&quot;definedActions&quot;:{&quot;actions&quot;:[]},&quot;smartAction&quot;:{},&quot;styleObject&quot;:{},&quot;components&quot;:{&quot;layer-0&quot;:{&quot;children&quot;:[{&quot;name&quot;:&quot;Text&quot;,&quot;element&quot;:&quot;outputField&quot;,&quot;elementLabel&quot;:&quot;Text-0&quot;,&quot;type&quot;:&quot;text&quot;,&quot;stateIndex&quot;:0,&quot;property&quot;:{&quot;mergeField&quot;:&quot;Welcome&quot;},&quot;styleObject&quot;:{},&quot;datasourceKey&quot;:&quot;state0element0&quot;,&quot;uKey&quot;:&quot;key-0&quot;},{&quot;name&quot;:&quot;Block&quot;,&quot;element&quot;:&quot;block&quot;,&quot;elementLabel&quot;:&quot;Block-1&quot;,&quot;type&quot;:&quot;block&quot;,&quot;stateIndex&quot;:0,&quot;property&quot;:{&quot;label&quot;:&quot;Block&quot;,&quot;collapsible&quot;:false},&quot;styleObject&quot;:{},&quot;datasourceKey&quot;:&quot;state0element1&quot;,&quot;uKey&quot;:&quot;key-1&quot;,&quot;children&quot;:[{&quot;name&quot;:&quot;Action&quot;,&quot;element&quot;:&quot;action&quot;,&quot;elementLabel&quot;:&quot;Block-1-Action-StartLinking&quot;,&quot;type&quot;:&quot;element&quot;,&quot;stateIndex&quot;:0,&quot;property&quot;:{&quot;label&quot;:&quot;Start Linking&quot;,&quot;iconName&quot;:&quot;utility:new_window&quot;,&quot;actionList&quot;:[{&quot;stateAction&quot;:{&quot;id&quot;:&quot;flex-action-1&quot;,&quot;type&quot;:&quot;OmniScript&quot;,&quot;openUrlIn&quot;:&quot;Current Window&quot;,&quot;layoutType&quot;:&quot;lightning&quot;,&quot;omniType&quot;:{&quot;Name&quot;:&quot;Sample/Linking/English&quot;,&quot;Id&quot;:&quot;0jN000000000001AAA&quot;}},&quot;key&quot;:&quot;al-key-1&quot;,&quot;label&quot;:&quot;Action&quot;,&quot;actionIndex&quot;:0}],&quot;displayAsButton&quot;:true},&quot;styleObject&quot;:{},&quot;datasourceKey&quot;:&quot;state0element1action0&quot;,&quot;uKey&quot;:&quot;key-1-action-0&quot;}]}]}},&quot;childCards&quot;:[],&quot;actions&quot;:[],&quot;omniscripts&quot;:[],&quot;documents&quot;:[]},{&quot;name&quot;:&quot;Confirmation&quot;,&quot;isSmartAction&quot;:false,&quot;fields&quot;:[],&quot;conditions&quot;:{&quot;id&quot;:&quot;state-condition-object-2&quot;,&quot;isParent&quot;:true,&quot;group&quot;:[]},&quot;definedActions&quot;:{&quot;actions&quot;:[]},&quot;smartAction&quot;:{},&quot;styleObject&quot;:{},&quot;components&quot;:{&quot;layer-0&quot;:{&quot;children&quot;:[{&quot;name&quot;:&quot;Action&quot;,&quot;element&quot;:&quot;action&quot;,&quot;elementLabel&quot;:&quot;ConfirmIP&quot;,&quot;type&quot;:&quot;element&quot;,&quot;stateIndex&quot;:1,&quot;property&quot;:{&quot;label&quot;:&quot;Confirm via IP&quot;,&quot;iconName&quot;:&quot;utility:check&quot;,&quot;actionList&quot;:[{&quot;stateAction&quot;:{&quot;id&quot;:&quot;flex-action-2&quot;,&quot;type&quot;:&quot;Integration Procedure&quot;,&quot;openUrlIn&quot;:&quot;Current Window&quot;,&quot;layoutType&quot;:&quot;lightning&quot;,&quot;integrationProcedureKey&quot;:&quot;SampleConfirmation_Procedure&quot;},&quot;key&quot;:&quot;al-key-2&quot;,&quot;label&quot;:&quot;Action&quot;,&quot;actionIndex&quot;:0}],&quot;displayAsButton&quot;:true},&quot;styleObject&quot;:{},&quot;datasourceKey&quot;:&quot;state1element0&quot;,&quot;uKey&quot;:&quot;key-2-action-0&quot;},{&quot;name&quot;:&quot;Action&quot;,&quot;element&quot;:&quot;action&quot;,&quot;elementLabel&quot;:&quot;BackHome&quot;,&quot;type&quot;:&quot;element&quot;,&quot;stateIndex&quot;:1,&quot;property&quot;:{&quot;label&quot;:&quot;Back Home&quot;,&quot;iconName&quot;:&quot;utility:back&quot;,&quot;actionList&quot;:[{&quot;stateAction&quot;:{&quot;id&quot;:&quot;flex-action-3&quot;,&quot;type&quot;:&quot;Custom&quot;,&quot;targetType&quot;:&quot;Web Page&quot;,&quot;openUrlIn&quot;:&quot;Current Window&quot;,&quot;Web Page&quot;:{&quot;targetName&quot;:&quot;/home&quot;}},&quot;key&quot;:&quot;al-key-3&quot;,&quot;label&quot;:&quot;Action&quot;,&quot;actionIndex&quot;:0}]},&quot;styleObject&quot;:{},&quot;datasourceKey&quot;:&quot;state1element1&quot;,&quot;uKey&quot;:&quot;key-3-action-0&quot;}]}},&quot;childCards&quot;:[],&quot;actions&quot;:[],&quot;omniscripts&quot;:[],&quot;documents&quot;:[]}],&quot;dataSource&quot;:{&quot;type&quot;:&quot;DataRaptor&quot;,&quot;value&quot;:{&quot;dataRaptorName&quot;:&quot;ExtractSampleMapper&quot;},&quot;orderBy&quot;:{},&quot;contextVariables&quot;:[&quot;recordId&quot;,&quot;card&quot;]},&quot;title&quot;:&quot;SampleLinkingIntro&quot;,&quot;enableLwc&quot;:true,&quot;isFlex&quot;:true,&quot;theme&quot;:&quot;slds&quot;,&quot;selectableMode&quot;:&quot;Multi&quot;}</propertySetConfig>
    <stylingConfiguration>{}</stylingConfiguration>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;

// Malformed propertySetConfig JSON — the tool should degrade
// gracefully (empty states[]) rather than crash.
const MALFORMED_JSON_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <isActive>true</isActive>
    <name>MalformedJson</name>
    <omniUiCardType>Parent</omniUiCardType>
    <propertySetConfig>{&quot;states&quot;:[{&quot;name&quot;:&quot;Broken</propertySetConfig>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;

// XML that does not validate at all — the validator rejects it before the
// parser ever runs.
const MALFORMED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard>
    <name>MalformedXml</name>
`;

// A single state whose widgets hang off `layer-1`. v3.2 walks `layer-0`
// only, so the widget tree here is NEVER walked — which must not render
// as "this state has no widgets".
const OTHER_LAYER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <isActive>true</isActive>
    <name>OtherLayer</name>
    <omniUiCardType>Parent</omniUiCardType>
    <propertySetConfig>{"states":[{"name":"OnlyState","components":{"layer-1":{"children":[{"name":"Text","element":"outputField","elementLabel":"Text-0","type":"text"}]}}}]}</propertySetConfig>
    <versionNumber>1</versionNumber>
</OmniUiCard>`;

let tempDir: string;
let store: GraphStore;
let ctx: Context;
let samplePath: string;
let malformedPath: string;
let malformedXmlPath: string;
let otherLayerPath: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-omniuicard-'));
  samplePath = join(tempDir, 'SampleLinkingIntro_Developer_1.ouc-meta.xml');
  malformedPath = join(tempDir, 'MalformedJson_Developer_1.ouc-meta.xml');
  malformedXmlPath = join(tempDir, 'MalformedXml_Developer_1.ouc-meta.xml');
  otherLayerPath = join(tempDir, 'OtherLayer_Developer_1.ouc-meta.xml');
  await writeFile(samplePath, SAMPLE_XML, 'utf8');
  await writeFile(malformedPath, MALFORMED_JSON_XML, 'utf8');
  await writeFile(malformedXmlPath, MALFORMED_XML, 'utf8');
  await writeFile(otherLayerPath, OTHER_LAYER_XML, 'utf8');

  const dbPath = join(tempDir, 'omniuicard.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;

  const sampleEdges: Edge[] = [
    {
      fromId: SAMPLE_CARD_ID,
      toId: 'OmniScript:Sample/Linking/English',
      edgeType: 'dispatchesOmniAction',
      confidence: 'parsed',
      source: 'omni-ui-card',
      properties: {
        stateName: 'Introduction',
        stateIndex: 0,
        widgetLabel: 'Block-1-Action-StartLinking',
        actionListIndex: 0,
        actionType: 'OmniScript',
        targetRawName: 'Sample/Linking/English',
      },
    },
    {
      fromId: SAMPLE_CARD_ID,
      toId: 'OmniIntegrationProcedure:SampleConfirmation_Procedure',
      edgeType: 'dispatchesOmniAction',
      confidence: 'parsed',
      source: 'omni-ui-card',
      properties: {
        stateName: 'Confirmation',
        stateIndex: 1,
        widgetLabel: 'ConfirmIP',
        actionListIndex: 0,
        actionType: 'Integration Procedure',
        targetRawName: 'SampleConfirmation_Procedure',
      },
    },
  ];

  const seed: ExtractionResult = {
    nodes: [
      // A non-OmniUiCard sentinel so cross-type confusion tests can
      // assert the wrong-type branch refuses with `component-not-found`.
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
      }),
      makeNode({
        id: SAMPLE_CARD_ID,
        type: 'OmniUiCard',
        apiName: 'SampleLinkingIntro_Developer_1',
        label: 'SampleLinkingIntro',
        sourcePath: samplePath,
        properties: {
          omniUiCardType: 'Parent',
          authorName: 'Developer',
          versionNumber: 1,
          isActive: true,
          isManagedUsingStdDesigner: false,
          name: 'SampleLinkingIntro',
          stateCount: 2,
          widgetCount: 5,
          embeddedScriptCount: 0,
          dataSourceType: 'DataRaptor',
          dataSourceContextVariables: ['recordId', 'card'],
          omniUiCardExtractionWarnings: [],
        },
      }),
      makeNode({
        id: MISSING_SOURCE_CARD_ID,
        type: 'OmniUiCard',
        apiName: 'MissingSource_Developer_1',
        label: 'MissingSource',
        // Deliberately point at a non-existent file to exercise the
        // source-XML-missing degrade path.
        sourcePath: join(tempDir, 'does-not-exist.ouc-meta.xml'),
        properties: {
          omniUiCardType: 'Parent',
          authorName: 'Developer',
          versionNumber: 1,
          isActive: false,
          isManagedUsingStdDesigner: false,
          name: 'MissingSource',
          stateCount: 0,
          widgetCount: 0,
          embeddedScriptCount: 0,
          dataSourceType: null,
          dataSourceContextVariables: [],
          omniUiCardExtractionWarnings: [],
        },
      }),
      makeNode({
        id: MALFORMED_JSON_CARD_ID,
        type: 'OmniUiCard',
        apiName: 'MalformedJson_Developer_1',
        label: 'MalformedJson',
        sourcePath: malformedPath,
        properties: {
          omniUiCardType: 'Parent',
          authorName: 'Developer',
          versionNumber: 1,
          isActive: true,
          isManagedUsingStdDesigner: false,
          name: 'MalformedJson',
          stateCount: 0,
          widgetCount: 0,
          embeddedScriptCount: 0,
          dataSourceType: null,
          dataSourceContextVariables: [],
          omniUiCardExtractionWarnings: ['failed to parse propertySetConfig JSON'],
        },
      }),
      makeNode({
        id: STALE_SOURCE_CARD_ID,
        type: 'OmniUiCard',
        apiName: 'StaleSource_Developer_1',
        label: 'StaleSource',
        sourcePath: join(tempDir, 'vanished.ouc-meta.xml'),
        properties: {
          omniUiCardType: 'Parent',
          authorName: 'Developer',
          versionNumber: 1,
          isActive: true,
          isManagedUsingStdDesigner: false,
          name: 'StaleSource',
          // The refresh SAW three states and twelve widgets.
          stateCount: 3,
          widgetCount: 12,
          embeddedScriptCount: 0,
          dataSourceType: null,
          dataSourceContextVariables: [],
          omniUiCardExtractionWarnings: [],
        },
      }),
      makeNode({
        id: MALFORMED_XML_CARD_ID,
        type: 'OmniUiCard',
        apiName: 'MalformedXml_Developer_1',
        label: 'MalformedXml',
        sourcePath: malformedXmlPath,
        properties: {
          omniUiCardType: 'Parent',
          authorName: 'Developer',
          versionNumber: 1,
          isActive: true,
          isManagedUsingStdDesigner: false,
          name: 'MalformedXml',
          stateCount: 1,
          widgetCount: 4,
          embeddedScriptCount: 0,
          dataSourceType: null,
          dataSourceContextVariables: [],
          omniUiCardExtractionWarnings: [],
        },
      }),
      makeNode({
        id: PRE_EXTRACTOR_CARD_ID,
        type: 'OmniUiCard',
        apiName: 'PreExtractor_Developer_1',
        label: 'PreExtractor',
        sourcePath: join(tempDir, 'pre-extractor.ouc-meta.xml'),
        // No `stateCount` / `widgetCount` / warnings at all — this vault's
        // refresh predates the v3.2 R2 OmniUiCard extractor.
        properties: {
          omniUiCardType: 'Parent',
          authorName: 'Developer',
        },
      }),
      makeNode({
        id: DRIFTED_CARD_ID,
        type: 'OmniUiCard',
        apiName: 'Drifted_Developer_1',
        label: 'Drifted',
        sourcePath: samplePath,
        properties: {
          omniUiCardType: 'Parent',
          authorName: 'Developer',
          versionNumber: 1,
          isActive: true,
          isManagedUsingStdDesigner: false,
          name: 'Drifted',
          // On disk the same file carries 2 states / 5 widgets.
          stateCount: 9,
          widgetCount: 40,
          embeddedScriptCount: 0,
          dataSourceType: null,
          dataSourceContextVariables: [],
          omniUiCardExtractionWarnings: [],
        },
      }),
      makeNode({
        id: OTHER_LAYER_CARD_ID,
        type: 'OmniUiCard',
        apiName: 'OtherLayer_Developer_1',
        label: 'OtherLayer',
        sourcePath: otherLayerPath,
        properties: {
          omniUiCardType: 'Parent',
          authorName: 'Developer',
          versionNumber: 1,
          isActive: true,
          isManagedUsingStdDesigner: false,
          name: 'OtherLayer',
          // The extractor walks layer-0 only too, so its own aggregate
          // agrees at zero — the counts CANNOT catch this one.
          stateCount: 1,
          widgetCount: 0,
          embeddedScriptCount: 0,
          dataSourceType: null,
          dataSourceContextVariables: [],
          omniUiCardExtractionWarnings: [],
        },
      }),
    ],
    edges: sampleEdges,
  };

  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('omniuicardWidgetBreakdownHandler', () => {
  it('returns metadata sourced from the node properties', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: SAMPLE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.omniUiCardId).toBe(SAMPLE_CARD_ID);
    expect(data.apiName).toBe('SampleLinkingIntro_Developer_1');
    expect(data.metadata.omniUiCardType).toBe('Parent');
    expect(data.metadata.authorName).toBe('Developer');
    expect(data.metadata.versionNumber).toBe(1);
    expect(data.metadata.isActive).toBe(true);
    expect(data.metadata.isManagedUsingStdDesigner).toBe(false);
  });

  it('returns the parsed states with the recursive widget tree', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: SAMPLE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Two states from the propertySetConfig JSON.
    expect(data.states).toHaveLength(2);

    const intro = data.states[0];
    expect(intro?.name).toBe('Introduction');
    expect(intro?.stateIndex).toBe(0);
    // Introduction has 3 widgets recursively: Text + Block + nested
    // Action under Block. Mirrors the extractor's per-state count.
    expect(intro?.widgetCount).toBe(3);
    // The Block widget contains a single Action child.
    expect(intro?.widgets).toHaveLength(2);
    expect(intro?.widgets[0]?.name).toBe('Text');
    expect(intro?.widgets[0]?.element).toBe('outputField');
    expect(intro?.widgets[0]?.elementLabel).toBe('Text-0');
    expect(intro?.widgets[0]?.type).toBe('text');
    expect(intro?.widgets[0]?.children).toEqual([]);
    expect(intro?.widgets[1]?.name).toBe('Block');
    expect(intro?.widgets[1]?.children).toHaveLength(1);
    expect(intro?.widgets[1]?.children[0]?.name).toBe('Action');
    expect(intro?.widgets[1]?.children[0]?.elementLabel).toBe(
      'Block-1-Action-StartLinking',
    );

    const confirm = data.states[1];
    expect(confirm?.name).toBe('Confirmation');
    expect(confirm?.stateIndex).toBe(1);
    // Confirmation has 2 widgets (both Actions; neither container).
    expect(confirm?.widgetCount).toBe(2);
    expect(confirm?.widgets).toHaveLength(2);
    expect(confirm?.widgets[0]?.elementLabel).toBe('ConfirmIP');
    expect(confirm?.widgets[1]?.elementLabel).toBe('BackHome');
  });

  it('returns the declared dataSource from the node properties', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: SAMPLE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.dataSource.type).toBe('DataRaptor');
    expect(data.dataSource.contextVariables).toEqual(['recordId', 'card']);
  });

  it('returns the dispatchedActions list from outgoing edges', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: SAMPLE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.dispatchedActions).toHaveLength(2);

    // Sorted by (stateIndex, actionListIndex, targetId). State 0
    // Introduction → OmniScript first; state 1 Confirmation → IP
    // second.
    const osDispatch = data.dispatchedActions[0];
    expect(osDispatch?.stateName).toBe('Introduction');
    expect(osDispatch?.stateIndex).toBe(0);
    expect(osDispatch?.widgetLabel).toBe('Block-1-Action-StartLinking');
    expect(osDispatch?.actionListIndex).toBe(0);
    expect(osDispatch?.actionType).toBe('OmniScript');
    expect(osDispatch?.targetId).toBe('OmniScript:Sample/Linking/English');
    expect(osDispatch?.targetRawName).toBe('Sample/Linking/English');
    expect(osDispatch?.confidence).toBe('parsed');

    const ipDispatch = data.dispatchedActions[1];
    expect(ipDispatch?.stateName).toBe('Confirmation');
    expect(ipDispatch?.stateIndex).toBe(1);
    expect(ipDispatch?.actionType).toBe('Integration Procedure');
    expect(ipDispatch?.targetId).toBe(
      'OmniIntegrationProcedure:SampleConfirmation_Procedure',
    );
    expect(ipDispatch?.targetRawName).toBe('SampleConfirmation_Procedure');
    expect(ipDispatch?.confidence).toBe('parsed');
  });

  it('surfaces the verbatim propertySetConfig-parsing and Native-vs-Vlocity disclosures', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: SAMPLE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // First disclosure is the propertySetConfig-parsing axis;
    // second is the Native-vs-Vlocity-Legacy disclosure. Both are
    // load-bearing per PLAN-v3.2 §4 and the OmniUiCard.md verbatim
    // contract.
    expect(data.boundaries.length).toBe(2);
    expect(data.boundaries[0]).toContain('widget breakdown parses the propertySetConfig JSON blob');
    expect(data.boundaries[0]).toContain(
      "widget order in the breakdown follows the JSON's declared order, not the visual designer's drag-drop order.",
    );
    expect(data.boundaries[1]).toContain(
      'v3.2 recognizes Industries Native XML shapes',
    );
    expect(data.boundaries[1]).toContain('vlocity_cmt__');
    expect(data.boundaries[1]).toContain('Mid-migration orgs may show partial coverage.');
  });

  it('echoes the vault state for stale-detection round-trips', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: SAMPLE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(
      FIXTURE_MANIFEST.sourceTreeHash,
    );
    expect(result.value.vaultState.refreshedAt).toBe(
      FIXTURE_MANIFEST.refreshedAt,
    );
  });

  // ===========================================================================
  // Honesty: `states: []` has SIX distinct causes. A genuinely empty card and
  // a card whose XML was never read must NEVER render identically. These
  // cases were previously asserted as "degrades gracefully ... boundaries
  // .length === 2", which encoded the bug: the two constant boundaries
  // discuss widget ORDER and the Vlocity namespace and distinguish nothing.
  // ===========================================================================

  it('discloses a blind spot — not a clean zero — when the source XML is missing on disk', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: MISSING_SOURCE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // Metadata + the two constant boundaries still surface.
    expect(data.metadata.omniUiCardType).toBe('Parent');
    expect(data.states).toEqual([]);
    expect(data.dispatchedActions).toEqual([]);
    const blind = data.boundaries.filter((b) => b.includes('BLIND SPOT'));
    expect(blind).toHaveLength(1);
    expect(blind[0]).toContain('could not be read');
    expect(blind[0]).toContain('NEVER a verified');
    expect(blind[0]).toContain('/sfi-refresh');
    // The two verbatim contract disclosures are still present.
    expect(
      data.boundaries.some((b) =>
        b.includes('widget breakdown parses the propertySetConfig JSON blob'),
      ),
    ).toBe(true);
  });

  it('names the extractor aggregates the vault recorded when the source file vanished', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: STALE_SOURCE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.states).toEqual([]);
    const blind = data.boundaries.find((b) => b.includes('BLIND SPOT'));
    expect(blind).toBeDefined();
    // The node itself carries the answer the handler used to ignore.
    expect(blind).toContain('stateCount');
    expect(blind).toContain('3');
    expect(blind).toContain('12');
  });

  it('discloses a blind spot when the source XML does not validate', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: MALFORMED_XML_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.states).toEqual([]);
    const blind = data.boundaries.find((b) => b.includes('BLIND SPOT'));
    expect(blind).toBeDefined();
    expect(blind).toContain('not well-formed XML');
  });

  it('discloses a blind spot when the propertySetConfig JSON is unparseable', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: MALFORMED_JSON_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.metadata.authorName).toBe('Developer');
    expect(data.states).toEqual([]);
    const blind = data.boundaries.find((b) => b.includes('BLIND SPOT'));
    expect(blind).toBeDefined();
    expect(blind).toContain('propertySetConfig');
    // The extractor recorded its OWN parse failure at refresh time; the
    // handler must surface it rather than report a clean zero.
    expect(
      data.boundaries.some((b) =>
        b.includes('failed to parse propertySetConfig JSON'),
      ),
    ).toBe(true);
  });

  it('reports "not modeled" — not zero — when the node predates the OmniUiCard extractor', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: PRE_EXTRACTOR_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.states).toEqual([]);
    const notModeled = data.boundaries.find((b) => b.includes('NOT parsed'));
    expect(notModeled).toBeDefined();
    // The shared absence-disclosure wording, keyed on the sentinel property.
    expect(notModeled).toContain('stateCount');
    expect(notModeled).toContain('not modeled');
    expect(notModeled).toContain('/sfi-refresh');
  });

  it('discloses drift when the on-disk XML disagrees with the extractor aggregates', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: DRIFTED_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // The file parses; it just is not the file the refresh read.
    expect(data.states).toHaveLength(2);
    const drift = data.boundaries.find((b) => b.includes('DRIFT'));
    expect(drift).toBeDefined();
    expect(drift).toContain('9');
    expect(drift).toContain('2');
  });

  it('discloses states whose widgets hang off a layer other than layer-0', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: OTHER_LAYER_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.states).toHaveLength(1);
    // Empty widgets[] here means NOT WALKED, not "this state is empty" —
    // and the extractor's own aggregate agrees at zero, so the count
    // cross-check cannot catch this case.
    expect(data.states[0]?.widgets).toEqual([]);
    const layerNote = data.boundaries.find((b) => b.includes('layer-0'));
    expect(layerNote).toBeDefined();
    expect(layerNote).toContain('OnlyState');
    expect(layerNote).toContain('NOT walked');
  });

  it('adds no blind-spot boundary when the card genuinely parsed clean', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: SAMPLE_CARD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // A verified answer must not be hedged: over-disclosing is as
    // dishonest as under-disclosing.
    expect(data.boundaries).toHaveLength(2);
    expect(data.boundaries.some((b) => b.includes('BLIND SPOT'))).toBe(false);
    expect(data.boundaries.some((b) => b.includes('DRIFT'))).toBe(false);
  });

  it('returns invalid-query when the omniUiCardId carries a wrong prefix', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: 'OmniScript:SomeName',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('OmniUiCard:');
    expect(result.error.path).toBe('omniUiCardId');
  });

  it('returns component-not-found for an unknown OmniUiCard id', async () => {
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: 'OmniUiCard:DoesNotExist_Developer_1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toContain('OmniUiCard');
  });

  it('returns component-not-found when the id resolves to a non-OmniUiCard node', async () => {
    // Use the CustomObject:Account seed node id but with the
    // OmniUiCard: prefix substituted — the handler resolves the id
    // against the graph and refuses because the node's type is not
    // OmniUiCard.
    const result = await omniuicardWidgetBreakdownHandler(ctx, {
      omniUiCardId: 'OmniUiCard:Account',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });
});
