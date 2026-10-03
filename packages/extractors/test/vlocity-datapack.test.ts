/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge } from '@sf-intelligence/contracts';

import { extractOmniDataTransform } from '../src/omni-data-transform.js';
import { extractOmniIntegrationProcedure } from '../src/omni-integration-procedure.js';
import { extractOmniUiCard } from '../src/omni-ui-card.js';
import { extractOmniScript } from '../src/omniscript.js';
import { parseDataMapperDataPack } from '../src/omnistudio/data-mapper.js';
import { dataPackComponentType, readDataPack } from '../src/omnistudio/datapack.js';
import { parseOmniProcessDataPack } from '../src/omnistudio/process.js';
import { apexRemoteTarget, runtimeServiceCall } from '../src/omnistudio/remote.js';

/**
 * Managed-package (Vlocity) OmniStudio from a Vlocity Build Tool export: a
 * DataPack enters the native extractors and parsers through the same code as
 * the Metadata API form, so it gets the same node, edges and element tree.
 * Synthetic Acme names; the record envelope follows the DataPack layout
 * (`%vlocity_namespace%` placeholder or a real prefix, inline or sibling-file
 * JSON, parent references as lookup objects or source keys).
 */

const P = '%vlocity_namespace%__';
let root: string;

const pack = async (kind: string, key: string, main: unknown, siblings: Record<string, unknown> = {}): Promise<string> => {
  const dir = join(root, 'vlocity', kind, key);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}_DataPack.json`), JSON.stringify(main, null, 4), 'utf-8');
  for (const [name, body] of Object.entries(siblings)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 4), 'utf-8');
  }
  return dir;
};

const el = (name: string, type: string, order: number, cfg: unknown, parent: unknown = '', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  [`${P}Active__c`]: true,
  [`${P}Level__c`]: parent === '' ? 0 : 1,
  [`${P}Order__c`]: order,
  [`${P}ParentElementId__c`]: parent,
  [`${P}PropertySet__c`]: cfg,
  [`${P}Type__c`]: type,
  Name: name,
  VlocityDataPackType: 'SObject',
  VlocityRecordSObjectType: `${P}Element__c`,
  ...extra,
});

const parentRef = (name: string): Record<string, unknown> => ({
  [`${P}OmniScriptId__c`]: { [`${P}Type__c`]: 'Acme', VlocityDataPackType: 'VlocityMatchingKeyObject' },
  Name: name,
  VlocityDataPackType: 'VlocityLookupMatchingKeyObject',
  VlocityLookupRecordSourceKey: `${P}Element__c/${P}OmniScript__c/Acme/Intake/English/${name}`,
  VlocityRecordSObjectType: `${P}Element__c`,
});

let scriptDir = '';
let ipDir = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sf-intel-datapack-'));
  scriptDir = await pack(
    'OmniScript',
    'Acme_Intake_English',
    {
      [`${P}Element__c`]: [
        el('IntakeStep', 'Step', 1, { label: 'Intake' }),
        el('Acme_Note__c', 'Text', 1, { label: 'Note', required: true }, parentRef('IntakeStep')),
        el('LoadPrefill', 'DataRaptor Extract Action', 0, { bundle: 'AcmeGetIntake' }),
        el('SaveIntake', 'Integration Procedure Action', 2, { integrationProcedureKey: 'Acme_SaveIntake' }),
        el('CallService', 'Remote Action', 3, { remoteClass: '%vlocity_namespace%.IntegrationProcedureService', remoteMethod: 'Acme_LookupThing' }),
        el('CallApex', 'Remote Action', 4, { remoteClass: 'Acme_IntakeService', remoteMethod: 'lookup' }),
      ],
      [`${P}IsActive__c`]: true,
      [`${P}IsProcedure__c`]: false,
      [`${P}Language__c`]: 'English',
      [`${P}PropertySet__c`]: 'Acme_Intake_English_PropertySet.json',
      [`${P}SubType__c`]: 'Intake',
      [`${P}Type__c`]: 'Acme',
      [`${P}Version__c`]: 2,
      Name: 'Acme Intake',
      VlocityDataPackType: 'SObject',
      VlocityRecordSObjectType: `${P}OmniScript__c`,
    },
    { 'Acme_Intake_English_PropertySet.json': { allowSaveForLater: true } },
  );
  // A real-prefix export (`vlocity_cmt__`), a source-key parent reference and a JSON-string property set.
  const V = 'vlocity_cmt__';
  const ipEl = (name: string, type: string, order: number, cfg: unknown, parent = ''): Record<string, unknown> => ({
    [`${V}Active__c`]: true,
    [`${V}Order__c`]: order,
    [`${V}ParentElementId__c`]: parent,
    [`${V}PropertySet__c`]: JSON.stringify(cfg),
    [`${V}Type__c`]: type,
    Name: name,
  });
  ipDir = await pack('IntegrationProcedure', 'Acme_SaveIntake', {
    [`${V}Element__c`]: [
      ipEl('SaveIt', 'DataRaptor Post Action', 1, { bundle: 'AcmeSaveIntake' }),
      ipEl('NotifyApex', 'Remote Action', 2, { remoteClass: 'Acme_Notifier', remoteMethod: 'notify' }),
      ipEl('DropOld', 'Delete Action', 3, { deleteSObject: [{ Type: 'Acme_Intake__c', Id: '%oldId%' }] }),
      ipEl('Guard', 'Conditional Block', 4, { executionConditionalFormula: '%go% == true' }),
      ipEl('HttpCall', 'Rest Action', 1, { restPath: '/services/acme/v1/sync' }, `${V}Element__c/${V}OmniScript__c/Acme/SaveIntake/Procedure/Guard`),
    ],
    [`${V}IsActive__c`]: true,
    [`${V}IsProcedure__c`]: true,
    [`${V}Language__c`]: 'Procedure',
    [`${V}SubType__c`]: 'SaveIntake',
    [`${V}Type__c`]: 'Acme',
    [`${V}Version__c`]: 1,
    Name: 'Acme/SaveIntake/Procedure',
    VlocityRecordSObjectType: `${V}OmniScript__c`,
  });
  await pack(
    'DataRaptor',
    'AcmeSaveIntake',
    { [`${P}DRMapItem__c`]: 'AcmeSaveIntake_Mappings.json', [`${P}Type__c`]: 'Load', [`${P}InputType__c`]: 'JSON', Name: 'AcmeSaveIntake', VlocityRecordSObjectType: `${P}DRBundle__c` },
    {
      'AcmeSaveIntake_Mappings.json': [
        { [`${P}InterfaceFieldAPIName__c`]: 'IntakeStep:Acme_Note__c', [`${P}DomainObjectAPIName__c`]: 'Acme_Intake__c', [`${P}DomainObjectFieldAPIName__c`]: 'Acme_Note__c', [`${P}DomainObjectCreationOrder__c`]: 1, Name: 'AcmeSaveIntake' },
        { [`${P}InterfaceFieldAPIName__c`]: 'intakeId', [`${P}DomainObjectAPIName__c`]: 'Acme_Intake__c', [`${P}DomainObjectFieldAPIName__c`]: 'Id', [`${P}IsUpsertKey__c`]: true, Name: 'AcmeSaveIntake' },
      ],
    },
  );
  await pack('DataRaptor', 'AcmeGetIntake', {
    [`${P}DRMapItem__c`]: [
      { [`${P}InterfaceObjectName__c`]: 'Acme_Intake__c', [`${P}InterfaceFieldAPIName__c`]: 'Id', [`${P}FilterOperator__c`]: '=', [`${P}FilterValue__c`]: 'intakeId', [`${P}DomainObjectFieldAPIName__c`]: 'intake', [`${P}InterfaceObjectLookupOrder__c`]: 1, Name: 'AcmeGetIntake' },
      { [`${P}InterfaceFieldAPIName__c`]: 'intake:Acme_Note__c', [`${P}DomainObjectAPIName__c`]: 'json', [`${P}DomainObjectFieldAPIName__c`]: 'IntakeStep:Acme_Note__c', Name: 'AcmeGetIntake' },
    ],
    [`${P}Type__c`]: 'Extract',
    Name: 'AcmeGetIntake',
    VlocityRecordSObjectType: `${P}DRBundle__c`,
  });
  await pack('VlocityCard', 'AcmeIntakeCard', {
    [`${P}Active__c`]: true,
    [`${P}Author__c`]: 'Acme',
    [`${P}Definition__c`]: { dataSource: { type: 'IntegrationProcedures', value: { ipMethod: 'Acme_SaveIntake' } }, states: [] },
    [`${P}IsChildCard__c`]: false,
    [`${P}Version__c`]: 1,
    Name: 'AcmeIntakeCard',
    VlocityRecordSObjectType: `${P}VlocityCard__c`,
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const byType = (edges: readonly Edge[], type: string): Edge[] => edges.filter((e) => e.edgeType === type);
const ids = (edges: readonly Edge[]): string[] => edges.map((e) => e.toId).sort();

describe('managed-package OmniScript DataPack', () => {
  it('extracts the same node and edges as the native form, marked as a DataPack', async () => {
    const r = await extractOmniScript(scriptDir);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const node = r.value.nodes[0];
    expect(node?.id).toBe('OmniScript:Acme_Intake_English_2');
    expect(node?.sourcePath).toBe(join(scriptDir, 'Acme_Intake_English_DataPack.json'));
    expect(node?.properties).toMatchObject({
      type: 'Acme',
      subType: 'Intake',
      language: 'English',
      versionNumber: 2,
      isActive: true,
      elementCount: 6,
      allowSaveForLater: true, // read from the sibling PropertySet file
      sourceFormat: 'vlocity-datapack',
      dataPackKey: 'Acme_Intake_English',
      managedPackageNamespace: null, // the placeholder names no namespace
    });
    expect(ids(byType(r.value.edges, 'dispatchesOmniAction'))).toEqual([
      'OmniDataTransform:AcmeGetIntake',
      'OmniIntegrationProcedure:Acme_LookupThing',
      'OmniIntegrationProcedure:Acme_SaveIntake',
    ]);
    // The runtime service runs an IP; it is never an Apex call to a package class.
    expect(ids(byType(r.value.edges, 'callsApex'))).toEqual(['ApexClass:Acme_IntakeService']);
    const svc = byType(r.value.edges, 'dispatchesOmniAction').find((e) => e.toId === 'OmniIntegrationProcedure:Acme_LookupThing');
    expect(svc?.properties).toMatchObject({ via: 'runtime-service', integrationProcedureKey: 'Acme_LookupThing', stepName: 'CallService' });
  });

  it('reads the same DataPack through its main file', async () => {
    const r = await extractOmniScript(join(scriptDir, 'Acme_Intake_English_DataPack.json'));
    expect(r.ok && r.value.nodes[0]?.id).toBe('OmniScript:Acme_Intake_English_2');
  });

  it('builds the element tree from parent references, with lines in the DataPack', async () => {
    const dp = await readDataPack(scriptDir);
    if (!dp.ok) throw new Error(dp.message);
    const parsed = parseOmniProcessDataPack(dp.value);
    if (!parsed.ok) throw new Error(parsed.message);
    const { doc } = parsed;
    expect(doc.header).toMatchObject({ kind: 'OmniScript', type: 'Acme', subType: 'Intake', versionNumber: 2, isActive: true });
    expect(doc.roots.map((e) => e.name)).toEqual(['LoadPrefill', 'IntakeStep', 'SaveIntake', 'CallService', 'CallApex']);
    const note = doc.elements.find((e) => e.name === 'Acme_Note__c');
    expect(note?.path).toEqual(['IntakeStep', 'Acme_Note__c']);
    expect(note?.config).toMatchObject({ required: true });
    const text = dp.value.mainText.split('\n');
    expect(text[(note?.line ?? 0) - 1]).toContain('"Name": "Acme_Note__c"');
  });

  it('refuses an Integration Procedure DataPack handed to the OmniScript extractor', async () => {
    const r = await extractOmniScript(ipDir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/an Integration Procedure DataPack, not an OmniScript/);
  });
});

describe('managed-package Integration Procedure DataPack', () => {
  it('reads a real-prefix export, nests by source-key parent, and emits the native edges', async () => {
    const r = await extractOmniIntegrationProcedure(ipDir);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const node = r.value.nodes[0];
    expect(node?.id).toBe('OmniIntegrationProcedure:Acme_SaveIntake_Procedure_1');
    expect(node?.properties).toMatchObject({ omniProcessKey: 'Acme_SaveIntake', managedPackageNamespace: 'vlocity_cmt', sourceFormat: 'vlocity-datapack' });
    const rest = node?.properties['restEndpoints'] as Array<{ stepName: string; path: string }>;
    expect(rest.map((x) => x.stepName)).toEqual(['HttpCall']); // nested inside Guard
    expect(ids(byType(r.value.edges, 'dispatchesOmniAction'))).toEqual(['OmniDataTransform:AcmeSaveIntake']);
    expect(ids(byType(r.value.edges, 'callsApex'))).toEqual(['ApexClass:Acme_Notifier']);
    const del = byType(r.value.edges, 'writesTo').find((e) => e.properties['operation'] === 'recordDelete');
    expect(del?.toId).toBe('CustomObject:Acme_Intake__c');
  });
});

describe('managed-package DataRaptor and Card DataPacks', () => {
  it('maps DRMapItem fields onto the native items: a Load writes fields, an Extract reads them', async () => {
    const load = await extractOmniDataTransform(join(root, 'vlocity', 'DataRaptor', 'AcmeSaveIntake'));
    if (!load.ok) throw new Error(JSON.stringify(load.error));
    expect(load.value.nodes[0]?.id).toBe('OmniDataTransform:AcmeSaveIntake');
    expect(ids(byType(load.value.edges, 'writesTo'))).toContain('CustomField:Acme_Intake__c.Acme_Note__c');
    const extract = await extractOmniDataTransform(join(root, 'vlocity', 'DataRaptor', 'AcmeGetIntake'));
    if (!extract.ok) throw new Error(JSON.stringify(extract.error));
    expect(ids(byType(extract.value.edges, 'readsFrom'))).toContain('CustomField:Acme_Intake__c.Acme_Note__c');
    const dp = await readDataPack(join(root, 'vlocity', 'DataRaptor', 'AcmeSaveIntake'));
    if (!dp.ok) throw new Error(dp.message);
    const doc = parseDataMapperDataPack(dp.value);
    expect(doc.ok && doc.doc.items.map((i) => [i.inputFieldName, i.outputObjectName, i.outputFieldName, i.upsertKey])).toEqual([
      ['IntakeStep:Acme_Note__c', 'Acme_Intake__c', 'Acme_Note__c', false],
      ['intakeId', 'Acme_Intake__c', 'Id', true],
    ]);
  });

  it('reads a Card definition as the native data source and states', async () => {
    const r = await extractOmniUiCard(join(root, 'vlocity', 'VlocityCard', 'AcmeIntakeCard'));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.nodes[0]?.id).toBe('OmniUiCard:AcmeIntakeCard_Acme_1');
    expect(r.value.nodes[0]?.properties).toMatchObject({ dataSourceType: 'IntegrationProcedures', omniUiCardType: 'Parent', sourceFormat: 'vlocity-datapack' });
    expect(ids(byType(r.value.edges, 'dispatchesOmniAction'))).toEqual(['OmniIntegrationProcedure:Acme_SaveIntake']);
  });
});

describe('DataPack paths and the runtime service', () => {
  it('maps a DataPack folder or main file to its component type, and nothing else', () => {
    expect(dataPackComponentType(['vlocity', 'OmniScript'], 'Acme_Intake_English', true)).toBe('OmniScript');
    expect(dataPackComponentType(['vlocity', 'DataRaptor', 'AcmeGetIntake'], 'AcmeGetIntake_DataPack.json', false)).toBe('OmniDataTransform');
    expect(dataPackComponentType(['vlocity', 'DataRaptor', 'AcmeGetIntake'], 'AcmeGetIntake_Mappings.json', false)).toBeNull();
    expect(dataPackComponentType(['vlocity', 'Product2'], 'Widget', true)).toBeNull();
    expect(dataPackComponentType(['main', 'default', 'omniScripts'], 'x', true)).toBeNull();
  });

  it('treats only a NAMESPACED IntegrationProcedureService with an IP key as the runtime service', () => {
    const call = (cls: string, method: unknown) => runtimeServiceCall(apexRemoteTarget(cls), method);
    expect(call('vlocity_cmt.IntegrationProcedureService', 'Acme_SaveIntake')).toEqual({ kind: 'integration-procedure', key: 'Acme_SaveIntake', service: 'vlocity_cmt.IntegrationProcedureService' });
    expect(call('%vlocity_namespace%.IntegrationProcedureService', ' Acme_SaveIntake ')?.key).toBe('Acme_SaveIntake');
    expect(call('omnistudio.IntegrationProcedureService', 'Acme_SaveIntake')?.key).toBe('Acme_SaveIntake');
    expect(call('IntegrationProcedureService', 'Acme_SaveIntake')).toBeNull(); // an org class of that name
    expect(call('vlocity_cmt.IntegrationProcedureService', '%dynamicKey%')).toBeNull();
    expect(call('vlocity_cmt.SomeOtherService', 'Acme_SaveIntake')).toBeNull();
  });
});
