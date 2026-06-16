/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  omniscriptFlowHandler,
  omniscriptFlowInputSchema,
} from '../../src/tools/omniscript-flow.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: { OmniScript: 2 },
  edges: { dispatchesOmniAction: 3 },
  sourceTreeHash: 'sha256:fixture-omniscript-flow',
};

/**
 * Synthetic OmniScript XML mirroring the v3.2 R2 extractor's expected
 * shape. Carries a top-level Step + nested CustomLWC child + DR Extract
 * Action + IP Action + Web-Page Navigate (no edge for Web Page). The
 * top-level identity elements match the canonical id
 * `OmniScript:Sample_Linking_English_1` from the synthetic-v3.2 fixture.
 */
const SAMPLE_LINKING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>false</isIntegrationProcedure>
    <isOmniScriptEmbeddable>true</isOmniScriptEmbeddable>
    <isWebCompEnabled>true</isWebCompEnabled>
    <language>English</language>
    <name>Sample Linking Flow</name>
    <omniProcessElements>
        <childElements>
            <isActive>true</isActive>
            <level>1.0</level>
            <name>CustomLWC1</name>
            <propertySetConfig>{&quot;lwcName&quot;:&quot;cfTest&quot;}</propertySetConfig>
            <sequenceNumber>0.0</sequenceNumber>
            <type>Custom Lightning Web Component</type>
        </childElements>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>FirstStep</name>
        <propertySetConfig>{&quot;label&quot;:&quot;First Step&quot;}</propertySetConfig>
        <sequenceNumber>0.0</sequenceNumber>
        <type>Step</type>
    </omniProcessElements>
    <omniProcessElements>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>extractContact</name>
        <propertySetConfig>{&quot;bundle&quot;:&quot;ExtractContactMapper&quot;}</propertySetConfig>
        <sequenceNumber>1.0</sequenceNumber>
        <type>DataRaptor Extract Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>callUserSearchIp</name>
        <propertySetConfig>{&quot;integrationProcedureKey&quot;:&quot;UserSearch_Existing&quot;}</propertySetConfig>
        <sequenceNumber>2.0</sequenceNumber>
        <type>Integration Procedure Action</type>
    </omniProcessElements>
    <omniProcessElements>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>goToHome</name>
        <propertySetConfig>{&quot;targetType&quot;:&quot;Web Page&quot;,&quot;targetUrl&quot;:&quot;/s&quot;}</propertySetConfig>
        <sequenceNumber>3.0</sequenceNumber>
        <type>Navigate Action</type>
    </omniProcessElements>
    <omniProcessType>OmniScript</omniProcessType>
    <subType>Linking</subType>
    <type>Sample</type>
    <uniqueName>Sample_Linking_English_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniScript>
`;

/**
 * Empty-flow synthetic — uniqueName matches but body has no steps. Used
 * to exercise the empty-step / no-edge tail of the handler.
 */
const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>false</isActive>
    <isIntegrationProcedure>false</isIntegrationProcedure>
    <isOmniScriptEmbeddable>false</isOmniScriptEmbeddable>
    <isWebCompEnabled>false</isWebCompEnabled>
    <language>English</language>
    <name>Empty Flow</name>
    <omniProcessType>OmniScript</omniProcessType>
    <uniqueName>Empty_Placeholder_English_1</uniqueName>
    <versionNumber>0.0</versionNumber>
</OmniScript>
`;

let tempDir: string;
let store: GraphStore;
let ctx: Context;
let samplePath: string;
let emptyPath: string;
let danglingPath: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-omniscript-flow-'));
  samplePath = join(tempDir, 'Sample_Linking_English_1.os-meta.xml');
  emptyPath = join(tempDir, 'Empty_Placeholder_English_1.os-meta.xml');
  danglingPath = join(tempDir, 'Dangling_English_1.os-meta.xml');
  writeFileSync(samplePath, SAMPLE_LINKING_XML, 'utf-8');
  writeFileSync(emptyPath, EMPTY_XML, 'utf-8');
  writeFileSync(
    danglingPath,
    SAMPLE_LINKING_XML.replace(
      'Sample_Linking_English_1',
      'Dangling_English_1',
    ).replace(
      'ExtractContactMapper',
      'MissingFromVaultMapper',
    ).replace(
      'UserSearch_Existing',
      'MissingFromVaultIP',
    ),
    'utf-8',
  );

  const opened = await openGraph(join(tempDir, 'osflow.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;

  const makeOmniScriptNode = (
    apiName: string,
    sourcePath: string,
    overrides: Partial<Node['properties']> = {},
  ): Node => ({
    id: `OmniScript:${apiName}`,
    type: 'OmniScript',
    apiName,
    label: 'Sample Linking Flow',
    parentId: null,
    sourcePath,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {
      omniProcessType: 'OmniScript',
      omniProcessKey: 'Sample_Linking',
      uniqueName: apiName,
      versionNumber: 1.0,
      language: 'English',
      subType: 'Linking',
      type: 'Sample',
      isActive: true,
      isWebCompEnabled: true,
      isOmniScriptEmbeddable: true,
      elementCount: 5,
      ...overrides,
    },
  });

  const seed: ExtractionResult = {
    nodes: [
      makeOmniScriptNode('Sample_Linking_English_1', samplePath),
      makeOmniScriptNode('Empty_Placeholder_English_1', emptyPath, {
        omniProcessType: 'OmniScript',
        omniProcessKey: null,
        uniqueName: 'Empty_Placeholder_English_1',
        versionNumber: 0.0,
        language: 'English',
        subType: null,
        type: null,
        isActive: false,
        isWebCompEnabled: false,
        elementCount: 0,
      }),
      makeOmniScriptNode('Dangling_English_1', danglingPath),
      // The vault knows about the IP/DR that Sample_Linking dispatches.
      {
        id: 'OmniIntegrationProcedure:UserSearch_Existing',
        type: 'OmniIntegrationProcedure',
        apiName: 'UserSearch_Existing',
        label: null,
        parentId: null,
        sourcePath: 'unused.xml',
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      },
      {
        id: 'OmniDataTransform:ExtractContactMapper',
        type: 'OmniDataTransform',
        apiName: 'ExtractContactMapper',
        label: null,
        parentId: null,
        sourcePath: 'unused.xml',
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      },
      // A non-OmniScript node to confirm prefix-validation path against
      // a real id collision (rare, but defensive).
      {
        id: 'ApexClass:NotAnOmniScript',
        type: 'ApexClass',
        apiName: 'NotAnOmniScript',
        label: null,
        parentId: null,
        sourcePath: 'unused.cls',
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      },
    ],
    edges: [
      // Sample_Linking dispatches to known IP + DR.
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
      } satisfies Edge,
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
      } satisfies Edge,
      // Dangling dispatches to IDs that don't exist in the vault.
      {
        fromId: 'OmniScript:Dangling_English_1',
        toId: 'OmniDataTransform:MissingFromVaultMapper',
        edgeType: 'dispatchesOmniAction',
        confidence: 'parsed',
        source: 'omniscript-extractor',
        properties: {
          stepName: 'extractContact',
          stepType: 'DataRaptor Extract Action',
          level: 0,
          sequenceNumber: 1,
          targetRawName: 'MissingFromVaultMapper',
        },
      } satisfies Edge,
    ],
  };

  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('omniscriptFlowHandler', () => {
  it('returns metadata + steps + dispatchedActions for a happy-path OmniScript', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Sample_Linking_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.apiName).toBe('Sample_Linking_English_1');
    expect(r.value.data.metadata.omniProcessType).toBe('OmniScript');
    expect(r.value.data.metadata.uniqueName).toBe(
      'Sample_Linking_English_1',
    );
    expect(r.value.data.metadata.versionNumber).toBe(1.0);
    expect(r.value.data.metadata.language).toBe('English');
    expect(r.value.data.metadata.subType).toBe('Linking');
    expect(r.value.data.metadata.type).toBe('Sample');
    expect(r.value.data.metadata.isActive).toBe(true);
    expect(r.value.data.metadata.isWebCompEnabled).toBe(true);
  });

  it('parses the omniProcessElements body into ordered steps including the nested child', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Sample_Linking_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Five elements expected: FirstStep, CustomLWC1 (nested), extractContact, callUserSearchIp, goToHome.
    expect(r.value.data.steps).toHaveLength(5);
    // Sort by level then sequenceNumber — top-level Step comes first.
    const firstStep = r.value.data.steps[0]!;
    expect(firstStep.name).toBe('FirstStep');
    expect(firstStep.type).toBe('Step');
    expect(firstStep.level).toBe(0);
    expect(firstStep.sequenceNumber).toBe(0);
    expect(firstStep.isActive).toBe(true);
    // The nested CustomLWC1 lands later (level 1).
    const customLwc = r.value.data.steps.find((s) => s.name === 'CustomLWC1');
    expect(customLwc).toBeDefined();
    expect(customLwc!.level).toBe(1);
  });

  it('surfaces dispatchedActions sourced from the dispatchesOmniAction edges', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Sample_Linking_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.dispatchedActions).toHaveLength(2);
    const ip = r.value.data.dispatchedActions.find(
      (d) => d.targetRawName === 'UserSearch_Existing',
    );
    expect(ip).toBeDefined();
    expect(ip!.stepType).toBe('Integration Procedure Action');
    expect(ip!.targetId).toBe(
      'OmniIntegrationProcedure:UserSearch_Existing',
    );
    expect(ip!.confidence).toBe('parsed');
    const dr = r.value.data.dispatchedActions.find(
      (d) => d.targetRawName === 'ExtractContactMapper',
    );
    expect(dr).toBeDefined();
    expect(dr!.stepType).toBe('DataRaptor Extract Action');
    expect(dr!.targetId).toBe(
      'OmniDataTransform:ExtractContactMapper',
    );
  });

  it('flags a dangling dispatch with targetId: null when the target is absent from the vault', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Dangling_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.dispatchedActions).toHaveLength(1);
    const dangling = r.value.data.dispatchedActions[0]!;
    expect(dangling.targetRawName).toBe('MissingFromVaultMapper');
    expect(dangling.targetId).toBeNull();
  });

  it('omits propertySetConfigParsed by default (compact response)', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Sample_Linking_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const step of r.value.data.steps) {
      expect(step.propertySetConfigParsed).toBeUndefined();
    }
  });

  it('attaches propertySetConfigParsed when includeChildPropertySetConfig: true', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Sample_Linking_English_1',
      includeChildPropertySetConfig: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dr = r.value.data.steps.find((s) => s.name === 'extractContact');
    expect(dr).toBeDefined();
    expect(dr!.propertySetConfigParsed).toBeDefined();
    expect(
      (dr!.propertySetConfigParsed as Record<string, unknown>)['bundle'],
    ).toBe('ExtractContactMapper');
  });

  it('returns an empty steps array and empty dispatchedActions for an OmniScript with no body', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Empty_Placeholder_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.steps).toEqual([]);
    expect(r.value.data.dispatchedActions).toEqual([]);
    // Empty OmniScript still surfaces the boundaries unconditionally.
    expect(r.value.data.boundaries).toHaveLength(3);
  });

  it('surfaces the three verbatim honesty boundaries on every response', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Sample_Linking_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries).toHaveLength(3);
    // Q180 Native-vs-Vlocity disclosure.
    expect(r.value.data.boundaries[0]).toMatch(
      /Industries Native XML shapes/,
    );
    expect(r.value.data.boundaries[0]).toMatch(/vlocity_cmt__/);
    // Q179 record-level boundary.
    expect(r.value.data.boundaries[1]).toMatch(/OmniProcessElement/);
    expect(r.value.data.boundaries[1]).toMatch(/record-level/);
    // Q180 v3.3 Apex-coupling deferral.
    expect(r.value.data.boundaries[2]).toMatch(
      /implements omnistudio\.VlocityOpenInterface/,
    );
    expect(r.value.data.boundaries[2]).toMatch(/v3\.3/);
  });

  it('rejects a non-OmniScript prefix with invalid-query', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'CustomObject:Account',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('omniScriptId');
  });

  it('returns component-not-found for a well-formed but unknown OmniScript id', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Nonexistent_Foo_English_99',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.path).toBe('OmniScript:Nonexistent_Foo_English_99');
    expect(r.error.message).toMatch(/no OmniScript/);
  });

  it('returns invalid-query when the id prefix matches but resolves to a non-OmniScript node', async () => {
    // A defensive check — id collision across types is rare but the
    // handler must refuse to render a non-OmniScript node as an OmniScript.
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:NotAnOmniScript',
    });
    // The graph has `ApexClass:NotAnOmniScript` but NOT
    // `OmniScript:NotAnOmniScript`; this is component-not-found.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('copies the manifest vaultState onto every successful response', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Sample_Linking_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vaultState.sourceTreeHash).toBe(
      FIXTURE_MANIFEST.sourceTreeHash,
    );
    expect(r.value.vaultState.refreshedAt).toBe(
      FIXTURE_MANIFEST.refreshedAt,
    );
  });

  it('sorts steps deterministically by (level, sequenceNumber, name)', async () => {
    const r = await omniscriptFlowHandler(ctx, {
      omniScriptId: 'OmniScript:Sample_Linking_English_1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seq = r.value.data.steps.map((s) => `${s.level}-${s.sequenceNumber}-${s.name}`);
    // Verify monotonic on (level, sequenceNumber).
    const sorted = [...seq].sort((a, b) => {
      const [la, sa] = a.split('-');
      const [lb, sb] = b.split('-');
      if (la !== lb) return Number(la) - Number(lb);
      return Number(sa) - Number(sb);
    });
    expect(seq).toEqual(sorted);
  });
});

describe('omniscriptFlowInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    expect(
      omniscriptFlowInputSchema.safeParse({
        omniScriptId: 'OmniScript:Foo_English_1',
      }).success,
    ).toBe(true);
  });

  it('accepts the optional includeChildPropertySetConfig boolean', () => {
    expect(
      omniscriptFlowInputSchema.safeParse({
        omniScriptId: 'OmniScript:Foo_English_1',
        includeChildPropertySetConfig: true,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty omniScriptId', () => {
    expect(
      omniscriptFlowInputSchema.safeParse({
        omniScriptId: '',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing omniScriptId', () => {
    expect(omniscriptFlowInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-boolean includeChildPropertySetConfig', () => {
    expect(
      omniscriptFlowInputSchema.safeParse({
        omniScriptId: 'OmniScript:Foo_English_1',
        includeChildPropertySetConfig: 'yes',
      }).success,
    ).toBe(false);
  });
});
