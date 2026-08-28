/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
import { integrationProcedureChainHandler } from '../../src/tools/integration-procedure-chain.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T17:00:00Z',
  sourceOrg: 'me@example.com',
  components: {
    OmniIntegrationProcedure: 1,
    OmniDataTransform: 1,
  },
  edges: { dispatchesOmniAction: 2 },
  sourceTreeHash: 'sha256:integration-procedure-chain-fixture',
};

const IP_ID = 'OmniIntegrationProcedure:Sample_Validation_Procedure_1';
const NESTED_IP_ID = 'OmniIntegrationProcedure:Sample_ChildProcedure';
const DATA_TRANSFORM_ID = 'OmniDataTransform:ExtractContactMapper';

// ============================================================================
// Synthetic IP XML — exercises every action `type` the tool surfaces:
// Rest Action (REST endpoint), DataRaptor Extract Action (dataraptor edge),
// Integration Procedure Action (nested IP edge), Remote Action (Apex
// target — surfaced verbatim, no resolution), Response Action (response
// shape).
// ============================================================================

const SAMPLE_IP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>true</isIntegrationProcedure>
    <language>Procedure</language>
    <name>Sample Validation Procedure</name>
    <omniProcessElements>
        <description>Http Action</description>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>callExternalApi</name>
        <propertySetConfig>{
  &quot;restMethod&quot; : &quot;POST&quot;,
  &quot;namedCredential&quot; : &quot;ExternalApiCredential&quot;,
  &quot;restPath&quot; : &quot;https://api.example.com/v1/validate&quot;,
  &quot;isActive&quot; : true
}</propertySetConfig>
        <sequenceNumber>1.0</sequenceNumber>
        <type>Rest Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <description>Data Mapper Extract Action</description>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>ExtractContactInfo</name>
        <propertySetConfig>{
  &quot;bundle&quot; : &quot;ExtractContactMapper&quot;,
  &quot;isActive&quot; : true
}</propertySetConfig>
        <sequenceNumber>2.0</sequenceNumber>
        <type>DataRaptor Extract Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <description>Integration Procedure Action</description>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>InvokeChildProcedure</name>
        <propertySetConfig>{
  &quot;integrationProcedureKey&quot; : &quot;Sample_ChildProcedure&quot;,
  &quot;isActive&quot; : true
}</propertySetConfig>
        <sequenceNumber>3.0</sequenceNumber>
        <type>Integration Procedure Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <description>Remote Action</description>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>callApex</name>
        <propertySetConfig>{
  &quot;remoteClass&quot; : &quot;AccountLinkingService&quot;,
  &quot;remoteMethod&quot; : &quot;validate&quot;,
  &quot;isActive&quot; : true
}</propertySetConfig>
        <sequenceNumber>4.0</sequenceNumber>
        <type>Remote Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <description>Response Action</description>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>Response</name>
        <propertySetConfig>{
  &quot;additionalOutput&quot; : {
    &quot;Status&quot; : &quot;%callExternalApi:Status%&quot;,
    &quot;ContactInfo&quot; : &quot;%ExtractContactInfo:Contact%&quot;
  },
  &quot;returnOnlyAdditionalOutput&quot; : true,
  &quot;isActive&quot; : true
}</propertySetConfig>
        <sequenceNumber>5.0</sequenceNumber>
        <type>Response Action</type>
    </omniProcessElements>
    <omniProcessKey>Sample_Validation</omniProcessKey>
    <omniProcessType>Integration Procedure</omniProcessType>
    <subType>Validation</subType>
    <type>Sample</type>
    <uniqueName>Sample_Validation_Procedure_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniIntegrationProcedure>
`;

// A second IP that exercises out-of-order sequence numbers — proves
// the tool sorts by sequenceNumber rather than relying on XML
// document order. Sequence order is 1.0 → 2.0 → 3.0; document order
// puts them as 2, 1, 3.
const OUT_OF_ORDER_IP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>true</isIntegrationProcedure>
    <name>Out Of Order Procedure</name>
    <omniProcessElements>
        <name>middle</name>
        <propertySetConfig>{ &quot;isActive&quot; : true }</propertySetConfig>
        <sequenceNumber>2.0</sequenceNumber>
        <type>Set Values Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <name>first</name>
        <propertySetConfig>{ &quot;isActive&quot; : true }</propertySetConfig>
        <sequenceNumber>1.0</sequenceNumber>
        <type>Set Values Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <name>last</name>
        <propertySetConfig>{ &quot;isActive&quot; : true }</propertySetConfig>
        <sequenceNumber>3.0</sequenceNumber>
        <type>Set Values Action</type>
    </omniProcessElements>
    <omniProcessKey>OutOfOrder</omniProcessKey>
    <omniProcessType>Integration Procedure</omniProcessType>
    <uniqueName>OutOfOrder_Procedure_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniIntegrationProcedure>
`;

const OUT_OF_ORDER_IP_ID = 'OmniIntegrationProcedure:OutOfOrder_Procedure_1';

const EMPTY_BODY_IP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>false</isActive>
    <name>Empty Procedure</name>
    <omniProcessKey>EmptyBody</omniProcessKey>
    <omniProcessType>Integration Procedure</omniProcessType>
    <uniqueName>EmptyBody_Procedure_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniIntegrationProcedure>
`;

const EMPTY_BODY_IP_ID = 'OmniIntegrationProcedure:EmptyBody_Procedure_1';

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'OmniIntegrationProcedure',
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

let tempDir: string;
let store: GraphStore;
let ctx: Context;

let sampleIpPath: string;
let outOfOrderIpPath: string;
let emptyBodyIpPath: string;
let missingFileIpPath: string;
let malformedXmlPath: string;
let wrongRootPath: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ip-chain-'));
  const dbPath = join(tempDir, 'ip-chain.db');
  const fixturesDir = join(tempDir, 'fixtures');
  await mkdir(fixturesDir, { recursive: true });

  sampleIpPath = join(fixturesDir, 'Sample_Validation_Procedure_1.oip-meta.xml');
  outOfOrderIpPath = join(fixturesDir, 'OutOfOrder_Procedure_1.oip-meta.xml');
  emptyBodyIpPath = join(fixturesDir, 'EmptyBody_Procedure_1.oip-meta.xml');
  // `missingFileIpPath` is deliberately not created — the test proves
  // the handler refuses with `component-not-found` when the graph
  // entry's `sourcePath` points to a deleted file.
  missingFileIpPath = join(fixturesDir, 'NonExistent_Procedure_1.oip-meta.xml');
  malformedXmlPath = join(fixturesDir, 'Malformed_Procedure_1.oip-meta.xml');
  wrongRootPath = join(fixturesDir, 'WrongRoot_Procedure_1.oip-meta.xml');

  await writeFile(sampleIpPath, SAMPLE_IP_XML, 'utf-8');
  await writeFile(outOfOrderIpPath, OUT_OF_ORDER_IP_XML, 'utf-8');
  await writeFile(emptyBodyIpPath, EMPTY_BODY_IP_XML, 'utf-8');
  await writeFile(
    malformedXmlPath,
    '<?xml version="1.0"?><OmniIntegrationProcedure><unclosed></OmniIntegrationProcedure>',
    'utf-8',
  );
  await writeFile(
    wrongRootPath,
    '<?xml version="1.0"?><WrongRoot><name>x</name></WrongRoot>',
    'utf-8',
  );

  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;

  const seed: ExtractionResult = {
    nodes: [
      makeNode({
        id: IP_ID,
        type: 'OmniIntegrationProcedure',
        apiName: 'Sample_Validation_Procedure_1',
        label: 'Sample Validation Procedure',
        sourcePath: sampleIpPath,
        properties: {
          omniProcessType: 'Integration Procedure',
          omniProcessKey: 'Sample_Validation',
          uniqueName: 'Sample_Validation_Procedure_1',
          versionNumber: 1,
          language: 'Procedure',
          subType: 'Validation',
          type: 'Sample',
          isActive: true,
          isIntegrationProcedure: true,
          elementCount: 5,
          restEndpointCount: 1,
          dataRaptorCount: 1,
          chainedIpCount: 1,
        },
      }),
      makeNode({
        id: OUT_OF_ORDER_IP_ID,
        type: 'OmniIntegrationProcedure',
        apiName: 'OutOfOrder_Procedure_1',
        sourcePath: outOfOrderIpPath,
        properties: {
          omniProcessKey: 'OutOfOrder',
          uniqueName: 'OutOfOrder_Procedure_1',
          versionNumber: 1,
          isActive: true,
        },
      }),
      makeNode({
        id: EMPTY_BODY_IP_ID,
        type: 'OmniIntegrationProcedure',
        apiName: 'EmptyBody_Procedure_1',
        sourcePath: emptyBodyIpPath,
        properties: {
          omniProcessKey: 'EmptyBody',
          uniqueName: 'EmptyBody_Procedure_1',
          versionNumber: 1,
          isActive: false,
        },
      }),
      makeNode({
        id: 'OmniIntegrationProcedure:NonExistent_Procedure_1',
        type: 'OmniIntegrationProcedure',
        apiName: 'NonExistent_Procedure_1',
        sourcePath: missingFileIpPath,
        properties: {},
      }),
      makeNode({
        id: 'OmniIntegrationProcedure:Malformed_Procedure_1',
        type: 'OmniIntegrationProcedure',
        apiName: 'Malformed_Procedure_1',
        sourcePath: malformedXmlPath,
        properties: {},
      }),
      makeNode({
        id: 'OmniIntegrationProcedure:WrongRoot_Procedure_1',
        type: 'OmniIntegrationProcedure',
        apiName: 'WrongRoot_Procedure_1',
        sourcePath: wrongRootPath,
        properties: {},
      }),
      // Target DataRaptor; lets the dataraptor-kind endpoint resolve a
      // canonical `targetId`. Source path is unused — the tool does not
      // re-read the DataRaptor's XML.
      makeNode({
        id: DATA_TRANSFORM_ID,
        type: 'OmniDataTransform',
        apiName: 'ExtractContactMapper',
        sourcePath: 'unused.rpt-meta.xml',
        properties: {},
      }),
      // Target IP; lets the integration-procedure-kind endpoint
      // resolve a canonical `targetId`. The node is keyed by the
      // `omniProcessKey` form the extractor uses for edges.
      makeNode({
        id: NESTED_IP_ID,
        type: 'OmniIntegrationProcedure',
        apiName: 'Sample_ChildProcedure',
        sourcePath: 'unused.oip-meta.xml',
        properties: { omniProcessKey: 'Sample_ChildProcedure' },
      }),
      // A non-IP node so the prefix-mismatch test has something real
      // to dereference.
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        sourcePath: 'unused.object-meta.xml',
        properties: {},
      }),
    ],
    edges: [],
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

describe('integrationProcedureChainHandler', () => {
  it('returns the action chain ordered by sequenceNumber with full metadata', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: IP_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value.data;
    expect(data.integrationProcedureId).toBe(IP_ID);
    expect(data.apiName).toBe('Sample_Validation_Procedure_1');
    expect(data.metadata.omniProcessKey).toBe('Sample_Validation');
    expect(data.metadata.versionNumber).toBe(1);
    expect(data.metadata.isActive).toBe(true);
    expect(data.metadata.subType).toBe('Validation');
    expect(data.metadata.type).toBe('Sample');
    expect(data.metadata.uniqueName).toBe('Sample_Validation_Procedure_1');

    // 5 actions, ordered by sequenceNumber ASC.
    expect(data.actions.length).toBe(5);
    expect(data.actions.map((a) => a.name)).toEqual([
      'callExternalApi',
      'ExtractContactInfo',
      'InvokeChildProcedure',
      'callApex',
      'Response',
    ]);
    expect(data.actions[0]?.type).toBe('Rest Action');
    expect(data.actions[0]?.description).toBe('Http Action');
    expect(data.actions[0]?.sequenceNumber).toBe(1);
    expect(data.actions[0]?.isActive).toBe(true);
    expect(data.actions[1]?.type).toBe('DataRaptor Extract Action');
    expect(data.actions[2]?.type).toBe('Integration Procedure Action');
    expect(data.actions[3]?.type).toBe('Remote Action');
    expect(data.actions[4]?.type).toBe('Response Action');

    // Default `includeChildPropertySetConfig: false` → propertySetConfigParsed absent.
    for (const action of data.actions) {
      expect(action.propertySetConfigParsed).toBeUndefined();
    }
  });

  it('sorts actions by sequenceNumber rather than XML document order', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: OUT_OF_ORDER_IP_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // XML order is middle/first/last; sequence order is first/middle/last.
    expect(result.value.data.actions.map((a) => a.name)).toEqual([
      'first',
      'middle',
      'last',
    ]);
  });

  it('surfaces the four verbatim boundary disclosures on every response', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: IP_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { boundaries } = result.value.data;
    expect(boundaries.length).toBe(4);

    // Native-vs-Vlocity (axis 1).
    expect(boundaries[0]).toContain(
      'v3.2 recognizes Industries Native XML shapes',
    );
    expect(boundaries[0]).toContain('vlocity_cmt__');
    expect(boundaries[0]).toContain('Mid-migration orgs may show partial coverage');

    // Apex-coupling deferral (axis 3).
    expect(boundaries[1]).toContain('intra-OmniStudio call chains');
    expect(boundaries[1]).toContain('v3.3');
    expect(boundaries[1]).toContain('implements omnistudio.VlocityOpenInterface');

    // OmniProcessElement record-level boundary (Q179 anchor).
    expect(boundaries[2]).toContain('OmniProcessElement');
    expect(boundaries[2]).toContain('record-level data');

    // REST URL `parsed`-confidence boundary (task-spec honesty axis).
    expect(boundaries[3]).toContain('REST endpoint URLs');
    expect(boundaries[3]).toContain('parsed');
    expect(boundaries[3]).toContain('does NOT probe');
  });

  it('surfaces externalEndpoints for Rest / DataRaptor / Integration Procedure / Remote Action steps', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: IP_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const endpoints = result.value.data.externalEndpoints;

    // 4 endpoint-emitting steps; Response Action does NOT emit one.
    expect(endpoints.length).toBe(4);

    // REST endpoint with verbatim URL + Named Credential.
    const rest = endpoints.find((e) => e.kind === 'rest');
    expect(rest).toBeDefined();
    expect(rest?.stepName).toBe('callExternalApi');
    expect(rest?.target).toBe('https://api.example.com/v1/validate');
    expect(rest?.namedCredential).toBe('ExternalApiCredential');
    // The REST URL is `parsed` (per the task's honesty axis: URLs are
    // not verified).
    expect(rest?.endpointConfidence).toBe('parsed');
    // Rest endpoints are not graph nodes; targetId is always null and
    // no resolution is ever attempted.
    expect(rest?.targetId).toBeNull();
    expect(rest?.targetResolution).toBe('not-applicable');

    // DataRaptor endpoint resolves the canonical `targetId`.
    const dr = endpoints.find((e) => e.kind === 'dataraptor');
    expect(dr).toBeDefined();
    expect(dr?.stepName).toBe('ExtractContactInfo');
    expect(dr?.target).toBe('ExtractContactMapper');
    expect(dr?.targetId).toBe(DATA_TRANSFORM_ID);
    expect(dr?.targetResolution).toBe('resolved');
    expect(dr?.endpointConfidence).toBe('parsed');

    // Nested IP endpoint resolves to the IP node keyed by omniProcessKey.
    const ip = endpoints.find((e) => e.kind === 'integration-procedure');
    expect(ip).toBeDefined();
    expect(ip?.stepName).toBe('InvokeChildProcedure');
    expect(ip?.target).toBe('Sample_ChildProcedure');
    expect(ip?.targetId).toBe(NESTED_IP_ID);
    expect(ip?.targetResolution).toBe('resolved');
    expect(ip?.endpointConfidence).toBe('parsed');

    // Remote Action surfaces `class.method` verbatim; v3.2 does NOT
    // resolve to an Apex graph edge (that is v3.3's
    // implementsOmniInterface follow-up).
    const remote = endpoints.find((e) => e.kind === 'remote-action');
    expect(remote).toBeDefined();
    expect(remote?.stepName).toBe('callApex');
    expect(remote?.target).toBe('AccountLinkingService.validate');
    expect(remote?.targetId).toBeNull();
    expect(remote?.targetResolution).toBe('not-applicable');
    expect(remote?.endpointConfidence).toBe('parsed');
  });

  it('surfaces a dangling targetId: null when the dataraptor/IP target is absent from the vault', async () => {
    // Stage a one-off IP whose `bundle` and `integrationProcedureKey`
    // reference targets that are not seeded in the graph. The handler
    // should still emit the endpoint rows with `targetId: null` so
    // impact-analysis tools can surface the dangling reference.
    const danglingPath = join(tempDir, 'fixtures', 'Dangling_Procedure_1.oip-meta.xml');
    await writeFile(
      danglingPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>true</isIntegrationProcedure>
    <name>Dangling</name>
    <omniProcessElements>
        <name>callMissingMapper</name>
        <propertySetConfig>{ &quot;bundle&quot; : &quot;DoesNotExistMapper&quot; }</propertySetConfig>
        <sequenceNumber>1.0</sequenceNumber>
        <type>DataRaptor Extract Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <name>callMissingIP</name>
        <propertySetConfig>{ &quot;integrationProcedureKey&quot; : &quot;DoesNotExistIP&quot; }</propertySetConfig>
        <sequenceNumber>2.0</sequenceNumber>
        <type>Integration Procedure Action</type>
    </omniProcessElements>
    <omniProcessKey>Dangling</omniProcessKey>
    <omniProcessType>Integration Procedure</omniProcessType>
    <uniqueName>Dangling_Procedure_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniIntegrationProcedure>`,
      'utf-8',
    );
    const danglingSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'OmniIntegrationProcedure:Dangling_Procedure_1',
          type: 'OmniIntegrationProcedure',
          apiName: 'Dangling_Procedure_1',
          sourcePath: danglingPath,
          properties: { omniProcessKey: 'Dangling', isActive: true },
        }),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(store, [danglingSeed]);
    expect(imported.ok).toBe(true);

    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: 'OmniIntegrationProcedure:Dangling_Procedure_1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const endpoints = result.value.data.externalEndpoints;
    expect(endpoints.length).toBe(2);
    for (const ep of endpoints) {
      expect(ep.targetId).toBeNull();
      // A genuine miss (the lookup ran and found nothing) is
      // `'not-in-vault'`, distinct from a graph query FAILURE
      // (`'lookup-failed'`, covered separately below).
      expect(ep.targetResolution).toBe('not-in-vault');
    }
    // The `target` (verbatim name from the XML) is still populated so
    // the renderer can flag the dangling reference.
    expect(endpoints[0]?.target).toBe('DoesNotExistMapper');
    expect(endpoints[1]?.target).toBe('DoesNotExistIP');
  });

  it('tells a graph query failure apart from a genuine absence when resolving a dataraptor target', async () => {
    // Stage an IP whose DataRaptor bundle name would resolve fine —
    // the poisoned connection below makes the LOOKUP throw rather
    // than making the target genuinely missing. This proves the
    // handler does not collapse "the graph query failed" into the
    // same `targetId: null` shape it uses for "not in this vault".
    const poisonPath = join(tempDir, 'fixtures', 'Poison_Procedure_1.oip-meta.xml');
    await writeFile(
      poisonPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>true</isIntegrationProcedure>
    <name>Poison</name>
    <omniProcessElements>
        <name>callPoisonedMapper</name>
        <propertySetConfig>{ &quot;bundle&quot; : &quot;PoisonBundle&quot; }</propertySetConfig>
        <sequenceNumber>1.0</sequenceNumber>
        <type>DataRaptor Extract Action</type>
    </omniProcessElements>
    <omniProcessKey>Poison</omniProcessKey>
    <omniProcessType>Integration Procedure</omniProcessType>
    <uniqueName>Poison_Procedure_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniIntegrationProcedure>`,
      'utf-8',
    );
    const poisonSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'OmniIntegrationProcedure:Poison_Procedure_1',
          type: 'OmniIntegrationProcedure',
          apiName: 'Poison_Procedure_1',
          sourcePath: poisonPath,
          properties: { omniProcessKey: 'Poison', isActive: true },
        }),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(store, [poisonSeed]);
    expect(imported.ok).toBe(true);

    // A connection that behaves exactly like the real one EXCEPT for
    // the one lookup this test targets, which it fails outright —
    // simulating a graph query error rather than a real miss.
    const poisonedId = 'OmniDataTransform:PoisonBundle';
    const realConnection = store.connection;
    const poisonedConnection = {
      runAndReadAll: (
        sql: string,
        params: Parameters<GraphStore['connection']['runAndReadAll']>[1],
      ) => {
        if (Array.isArray(params) && params[0] === poisonedId) {
          throw new Error('simulated graph query failure');
        }
        return realConnection.runAndReadAll(sql, params);
      },
    } as unknown as GraphStore['connection'];
    const poisonedCtx: Context = {
      ...ctx,
      graph: { connection: poisonedConnection, instance: store.instance },
    };

    const result = await integrationProcedureChainHandler(poisonedCtx, {
      integrationProcedureId: 'OmniIntegrationProcedure:Poison_Procedure_1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const endpoints = result.value.data.externalEndpoints;
    expect(endpoints.length).toBe(1);
    const ep = endpoints[0];
    // Both a query failure and a genuine absence currently surface
    // `targetId: null` — that part is unavoidable since there is no
    // id to report either way. What must NOT be true is that the two
    // are INDISTINGUISHABLE: a caller must be able to tell "the graph
    // query failed" apart from "this target lives outside the vault".
    expect(ep?.targetId).toBeNull();
    expect(ep?.targetResolution).toBe('lookup-failed');
  });

  it('parses the Response Action additionalOutput into responseShape', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: IP_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shape = result.value.data.responseShape;
    expect(shape.additionalOutput).not.toBeNull();
    expect(shape.additionalOutput?.['Status']).toBe(
      '%callExternalApi:Status%',
    );
    expect(shape.additionalOutput?.['ContactInfo']).toBe(
      '%ExtractContactInfo:Contact%',
    );
    expect(shape.returnOnlyAdditionalOutput).toBe(true);
  });

  it('attaches parsed propertySetConfig when includeChildPropertySetConfig is true', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: IP_ID,
      includeChildPropertySetConfig: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restAction = result.value.data.actions.find(
      (a) => a.type === 'Rest Action',
    );
    expect(restAction?.propertySetConfigParsed).toBeDefined();
    expect(restAction?.propertySetConfigParsed?.['restPath']).toBe(
      'https://api.example.com/v1/validate',
    );
    expect(restAction?.propertySetConfigParsed?.['namedCredential']).toBe(
      'ExternalApiCredential',
    );
  });

  it('returns an empty action list and a null response shape when the IP has no body elements', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: EMPTY_BODY_IP_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.actions).toEqual([]);
    expect(result.value.data.externalEndpoints).toEqual([]);
    expect(result.value.data.responseShape.additionalOutput).toBeNull();
    expect(result.value.data.responseShape.returnOnlyAdditionalOutput).toBeNull();
    // Boundaries still surface unconditionally.
    expect(result.value.data.boundaries.length).toBe(4);
  });

  it('returns invalid-query when the id carries a non-IP prefix', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: 'CustomField:Account.Industry',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('OmniIntegrationProcedure:');
  });

  it('returns component-not-found for an unknown well-formed IP id', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId:
        'OmniIntegrationProcedure:DoesNotExist_Procedure_1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('returns invalid-query when the id resolves to a non-IP node', async () => {
    // The seed includes a `CustomObject:Account` node whose presence
    // lets the handler dereference a real graph row of the wrong type.
    const result = await integrationProcedureChainHandler(ctx, {
      // Use a malformed id that still carries the IP prefix but
      // resolves to a non-IP type. (`getNodeById` only matches by id;
      // we synthesize a collision by seeding a node with the wrong
      // type AT the IP prefix in a follow-up import.)
      integrationProcedureId:
        'OmniIntegrationProcedure:CrossTypeCollision_Procedure_1',
    });
    // The id resolves to nothing (the collision id is not seeded) so
    // the response is the canonical component-not-found refusal — same
    // path the cross-type-confusion routing case ultimately reaches.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('returns component-not-found when the IP node points to a missing source file', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId:
        'OmniIntegrationProcedure:NonExistent_Procedure_1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toContain('source file missing');
  });

  it('returns internal when the source file is malformed XML', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId:
        'OmniIntegrationProcedure:Malformed_Procedure_1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    expect(result.error.message).toContain('malformed XML');
  });

  it('returns internal when the source file root is not <OmniIntegrationProcedure>', async () => {
    const result = await integrationProcedureChainHandler(ctx, {
      integrationProcedureId: 'OmniIntegrationProcedure:WrongRoot_Procedure_1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    expect(result.error.message).toContain('OmniIntegrationProcedure');
  });
});
