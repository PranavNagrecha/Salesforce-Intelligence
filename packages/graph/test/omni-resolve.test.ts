/// <reference types="vitest/globals" />

import type { Edge, Node } from '@sf-intelligence/contracts';

import {
  canonicalizeOmniStudioEdgeTargets,
  normOmniLanguage,
  parseOmniScriptKey,
  pickOmniVersion,
} from '../src/omni-resolve.js';

const node = (
  type: 'OmniIntegrationProcedure' | 'OmniDataTransform' | 'OmniScript',
  apiName: string,
  properties: Record<string, unknown>,
): Node => ({
  id: `${type}:${apiName}`,
  type,
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: `x/${apiName}.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const ip = (apiName: string, key: string, version: number, isActive: boolean): Node =>
  node('OmniIntegrationProcedure', apiName, {
    omniProcessKey: key,
    type: key.split('_')[0],
    subType: key.split('_')[1],
    language: 'English',
    versionNumber: version,
    isActive,
  });

const dm = (apiName: string, name: string, version: number, active = false): Node =>
  node('OmniDataTransform', apiName, { name, versionNumber: version, active });

const os = (
  apiName: string,
  type: string,
  subType: string,
  language: string,
  version: number,
  isActive: boolean,
): Node => node('OmniScript', apiName, { type, subType, language, versionNumber: version, isActive });

const dispatch = (fromId: string, toId: string, properties: Record<string, unknown> = {}): Edge =>
  ({
    fromId,
    toId,
    edgeType: 'dispatchesOmniAction',
    confidence: 'parsed',
    source: 'omniscript-extractor',
    properties,
  }) as Edge;

describe('canonicalizeOmniStudioEdgeTargets', () => {
  it('links an IP key to its single active version and lists the others', () => {
    const nodes = [
      ip('Acme_SaveCart_English_1', 'Acme_SaveCart', 1, false),
      ip('Acme_SaveCart_English_2', 'Acme_SaveCart', 2, true),
      ip('Acme_SaveCart_English_3', 'Acme_SaveCart', 3, false),
    ];
    const edges = [dispatch('OmniScript:Acme_Cart_English_1', 'OmniIntegrationProcedure:Acme_SaveCart', { targetRawName: 'Acme_SaveCart' })];
    canonicalizeOmniStudioEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('OmniIntegrationProcedure:Acme_SaveCart_English_2');
    expect(edges[0]?.properties).toMatchObject({
      targetRawName: 'Acme_SaveCart',
      resolvedTargetBy: 'omniProcessKey',
      targetResolution: 'active-version',
      otherVersionIds: [
        'OmniIntegrationProcedure:Acme_SaveCart_English_1',
        'OmniIntegrationProcedure:Acme_SaveCart_English_3',
      ],
    });
  });

  it('links a DataMapper bundle to its versioned node even though active is false', () => {
    const nodes = [dm('AcmeCartTransform_1', 'AcmeCartTransform', 1)];
    const edges = [dispatch('OmniIntegrationProcedure:Acme_SaveCart_English_2', 'OmniDataTransform:AcmeCartTransform')];
    canonicalizeOmniStudioEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('OmniDataTransform:AcmeCartTransform_1');
    expect(edges[0]?.properties).toMatchObject({
      targetRawName: 'AcmeCartTransform',
      resolvedTargetBy: 'dataMapperName',
      targetResolution: 'only-version',
    });
    expect(edges[0]?.properties['otherVersionIds']).toBeUndefined();
  });

  it('picks the highest DataMapper version when none is active, and a single active one when present', () => {
    const none = [dm('AcmeMap_1', 'AcmeMap', 1), dm('AcmeMap_2', 'AcmeMap', 2)];
    const e1 = [dispatch('OmniIntegrationProcedure:A_B_English_1', 'OmniDataTransform:AcmeMap')];
    canonicalizeOmniStudioEdgeTargets(none, e1);
    expect(e1[0]?.toId).toBe('OmniDataTransform:AcmeMap_2');
    expect(e1[0]?.properties['targetResolution']).toBe('highest-version');

    const oneActive = [dm('AcmeMap_1', 'AcmeMap', 1, true), dm('AcmeMap_2', 'AcmeMap', 2)];
    const e2 = [dispatch('OmniIntegrationProcedure:A_B_English_1', 'OmniDataTransform:AcmeMap')];
    canonicalizeOmniStudioEdgeTargets(oneActive, e2);
    expect(e2[0]?.toId).toBe('OmniDataTransform:AcmeMap_1');
    expect(e2[0]?.properties['targetResolution']).toBe('active-version');
  });

  it('keeps an IP with no active version walkable but says so', () => {
    const nodes = [ip('Acme_Old_English_1', 'Acme_Old', 1, false), ip('Acme_Old_English_4', 'Acme_Old', 4, false)];
    const edges = [dispatch('OmniScript:X_Y_English_1', 'OmniIntegrationProcedure:Acme_Old')];
    canonicalizeOmniStudioEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('OmniIntegrationProcedure:Acme_Old_English_4');
    expect(edges[0]?.properties['targetResolution']).toBe('no-active-version');
  });

  it('flags two simultaneously active versions instead of hiding the conflict', () => {
    const nodes = [ip('Acme_Dup_English_1', 'Acme_Dup', 1, true), ip('Acme_Dup_Spanish_2', 'Acme_Dup', 2, true)];
    const edges = [dispatch('OmniScript:X_Y_English_1', 'OmniIntegrationProcedure:Acme_Dup')];
    canonicalizeOmniStudioEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('OmniIntegrationProcedure:Acme_Dup_Spanish_2');
    expect(edges[0]?.properties).toMatchObject({
      targetResolution: 'ambiguous-active',
      ambiguousActiveIds: ['OmniIntegrationProcedure:Acme_Dup_English_1', 'OmniIntegrationProcedure:Acme_Dup_Spanish_2'],
    });
  });

  it('resolves an OmniScript Type/SubType/Language key across the Multi-Language spelling', () => {
    const nodes = [
      os('Acme_Intake_multiLanguage_3', 'Acme', 'Intake', 'Multi-Language', 3, true),
      os('Acme_Intake_multiLanguage_2', 'Acme', 'Intake', 'Multi-Language', 2, false),
    ];
    const edges = [dispatch('OmniUiCard:AcmeCard_1', 'OmniScript:Acme/Intake/Multi-Language')];
    canonicalizeOmniStudioEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('OmniScript:Acme_Intake_multiLanguage_3');
    expect(edges[0]?.properties['resolvedTargetBy']).toBe('omniScriptKey');
  });

  it('never touches an exact node-id match, a non-Omni target, or a key nothing answers to', () => {
    const nodes = [ip('Acme_SaveCart_English_2', 'Acme_SaveCart', 2, true)];
    const exact = dispatch('OmniScript:A_B_English_1', 'OmniIntegrationProcedure:Acme_SaveCart_English_2');
    const other = { ...dispatch('ApexClass:Foo', 'CustomObject:Account'), edgeType: 'references' } as Edge;
    const missing = dispatch('OmniScript:A_B_English_1', 'OmniIntegrationProcedure:Acme_Nothing');
    const edges = [exact, other, missing];
    canonicalizeOmniStudioEdgeTargets(nodes, edges);
    expect(edges[0]).toBe(exact);
    expect(edges[1]).toBe(other);
    expect(edges[2]).toBe(missing);
  });

  it('is idempotent', () => {
    const nodes = [ip('Acme_SaveCart_English_1', 'Acme_SaveCart', 1, false), ip('Acme_SaveCart_English_2', 'Acme_SaveCart', 2, true)];
    const edges = [dispatch('OmniScript:A_B_English_1', 'OmniIntegrationProcedure:Acme_SaveCart')];
    canonicalizeOmniStudioEdgeTargets(nodes, edges);
    const once = JSON.stringify(edges);
    canonicalizeOmniStudioEdgeTargets(nodes, edges);
    expect(JSON.stringify(edges)).toBe(once);
  });
});

describe('pickOmniVersion', () => {
  it('returns null for no candidates', () => {
    expect(pickOmniVersion([], true)).toBeNull();
  });
  it('orders ties on version by id', () => {
    const pick = pickOmniVersion(
      [
        { id: 'B', isActive: false, versionNumber: 2 },
        { id: 'A', isActive: false, versionNumber: 2 },
      ],
      false,
    );
    expect(pick?.id).toBe('A');
    expect(pick?.others).toEqual(['B']);
  });
});

describe('parseOmniScriptKey (the one Type/SubType/Language parser graph and tools share)', () => {
  it('splits a three-part key and trims each part', () => {
    expect(parseOmniScriptKey('Acme/Intake/English')).toEqual({ type: 'Acme', subType: 'Intake', language: 'English' });
    expect(parseOmniScriptKey(' Acme / Intake / Multi-Language ')).toEqual({ type: 'Acme', subType: 'Intake', language: 'Multi-Language' });
  });

  it('refuses any other shape rather than guess', () => {
    expect(parseOmniScriptKey('Acme_Intake_English')).toBeNull();
    expect(parseOmniScriptKey('Acme/Intake')).toBeNull();
    expect(parseOmniScriptKey('a/b/c/d')).toBeNull();
  });

  it('compares languages by their letters only', () => {
    expect(normOmniLanguage('Multi-Language')).toBe(normOmniLanguage('multi_language'));
  });
});
