/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge } from '@sf-intelligence/contracts';

import { extractOmniIntegrationProcedure } from '../src/omni-integration-procedure.js';
import { extractOmniUiCard } from '../src/omni-ui-card.js';
import { extractOmniScript } from '../src/omniscript.js';
import { apexRemoteTarget } from '../src/omnistudio/remote.js';
import { readStaticSoql } from '../src/omnistudio/soql.js';

/**
 * OmniStudio → Apex / record coupling, the same rule in every OmniStudio
 * extractor: ANY element naming a `remoteClass` runs that Apex class (one
 * aggregated `callsApex` edge per class), ANY element naming a DataMapper
 * `bundle` dispatches it, an IP Delete Action deletes records of the object it
 * names, and a FlexCard SOQL data source reads its object and fields.
 * Synthetic Acme names only.
 */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const write = async (filename: string, content: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-omni-coupling-'));
  dirs.push(dir);
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return path;
};

const psc = (o: unknown): string => JSON.stringify(o).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const el = (name: string, type: string, cfg: unknown, children = ''): string => `
        <omniProcessElements>${children}
            <isActive>true</isActive>
            <level>0.0</level>
            <name>${name}</name>
            <propertySetConfig>${psc(cfg)}</propertySetConfig>
            <sequenceNumber>1.0</sequenceNumber>
            <type>${type}</type>
        </omniProcessElements>`;

const child = (name: string, type: string, cfg: unknown): string => `
            <childElements>
                <isActive>true</isActive>
                <level>1.0</level>
                <name>${name}</name>
                <propertySetConfig>${psc(cfg)}</propertySetConfig>
                <sequenceNumber>1.0</sequenceNumber>
                <type>${type}</type>
            </childElements>`;

const byType = (edges: readonly Edge[], type: string): Edge[] => edges.filter((e) => e.edgeType === type);

describe('apexRemoteTarget', () => {
  it('trims, maps ns.Class to the ns__Class component, and refuses non-names', () => {
    expect(apexRemoteTarget('Acme_Service')).toEqual({ apiName: 'Acme_Service', raw: 'Acme_Service', namespace: null });
    expect(apexRemoteTarget(' Acme_Service ')).toEqual({ apiName: 'Acme_Service', raw: ' Acme_Service ', namespace: null });
    expect(apexRemoteTarget('acmens.QuoteService')).toEqual({ apiName: 'acmens__QuoteService', raw: 'acmens.QuoteService', namespace: 'acmens' });
    // A namespace may hold single underscores — the managed OmniStudio packages do.
    expect(apexRemoteTarget('vlocity_cmt.DRGlobal')).toEqual({ apiName: 'vlocity_cmt__DRGlobal', raw: 'vlocity_cmt.DRGlobal', namespace: 'vlocity_cmt' });
    expect(apexRemoteTarget('bad__ns.X')).toBeNull();
    expect(apexRemoteTarget('%dynamicClass%')).toBeNull();
    expect(apexRemoteTarget('')).toBeNull();
    expect(apexRemoteTarget(42)).toBeNull();
  });
});

describe('readStaticSoql', () => {
  it('reads the FROM object, the SELECT / WHERE / ORDER BY fields, and leaves paths for the import', () => {
    expect(
      readStaticSoql("select Acme_Retry__c, toLabel(Acme_Status__c) st, Owner.Name, (SELECT Id FROM Notes__r) from Acme_Case__c where Acme_Region__c = 'East' and Id = :recordId order by CreatedDate desc limit 5"),
    ).toEqual({
      object: 'Acme_Case__c',
      fields: ['Acme_Retry__c', 'Acme_Status__c', 'Acme_Region__c', 'Id', 'CreatedDate'],
      traversals: ['Owner.Name'],
    });
  });
  it('returns null for text that is not a static query', () => {
    expect(readStaticSoql('{Parent.Query}')).toBeNull();
    expect(readStaticSoql(undefined)).toBeNull();
  });
});

describe('Integration Procedure coupling', () => {
  it('records a callout under every spelling of the HTTP action, nested or not', async () => {
    const path = await write(
      'Acme_Sync_English_1.oip-meta.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>true</isIntegrationProcedure>
    <language>English</language>
    <name>Acme Sync</name>
    ${el('CallRest', 'Rest Action', { restPath: '/services/acme/v1/rest', restMethod: 'GET', namedCredential: 'Acme_NC' })}
    ${el('CallHttp', 'HTTP Action', { httpUrl: '/services/acme/v1/http', restMethod: 'POST' })}
    ${el('Guard', 'Conditional Block', {}, child('LoadIt', 'Data Mapper Load Action', { bundle: 'AcmeLoad' }))}
    <omniProcessKey>Acme_Sync</omniProcessKey>
    <omniProcessType>Integration Procedure</omniProcessType>
    <subType>Sync</subType>
    <type>Acme</type>
    <uniqueName>Acme_Sync_English_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniIntegrationProcedure>`,
    );
    const r = await extractOmniIntegrationProcedure(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rest = r.value.nodes[0]?.properties['restEndpoints'] as Array<{ stepName: string; path: string }>;
    expect(rest.map((x) => [x.stepName, x.path]).sort()).toEqual([
      ['CallHttp', '/services/acme/v1/http'],
      ['CallRest', '/services/acme/v1/rest'],
    ]);
    expect(byType(r.value.edges, 'dispatchesOmniAction').map((e) => [e.toId, e.properties['stepType']])).toEqual([
      ['OmniDataTransform:AcmeLoad', 'Data Mapper Load Action'],
    ]);
  });

  it('aggregates every remoteClass (Remote Action, Try Catch handler) into one callsApex edge per class, and emits Delete Action deletes', async () => {
    const path = await write(
      'Acme_SaveOrder_English_1.oip-meta.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>true</isIntegrationProcedure>
    <language>English</language>
    <name>Acme SaveOrder</name>
    <omniProcessKey>Acme_SaveOrder</omniProcessKey>
    ${el(
      'TryBlock',
      'Try Catch Block',
      { remoteClass: 'Acme_Logger ', remoteMethod: 'logError', failOnBlockError: true },
      child('UpsertOrder', 'Remote Action', { remoteClass: 'Acme_GenericUpsert', remoteMethod: 'upsertRecords', additionalInput: { records: '%Lines%', objectApiName: 'Acme_Order__c' } }) +
        child('PriceIt', 'Remote Action', { remoteClass: 'acmens.PricingService', remoteMethod: 'price' }) +
        child('RemoveLine', 'Delete Action', { deleteSObject: [{ Type: 'Acme_Order_Line__c', Id: '%lineId%', AllOrNone: false }] }),
    )}
    ${el('Notify', 'Remote Action', { remoteClass: 'Acme_GenericUpsert', remoteMethod: 'notify' })}
    <subType>SaveOrder</subType>
    <type>Acme</type>
    <uniqueName>Acme_SaveOrder_English_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniIntegrationProcedure>`,
    );
    const r = await extractOmniIntegrationProcedure(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const apex = byType(r.value.edges, 'callsApex');
    expect(apex.map((e) => [e.toId, e.properties['methods'], e.properties['targetRawName'] ?? null])).toEqual([
      ['ApexClass:Acme_GenericUpsert', ['notify', 'upsertRecords'], null],
      ['ApexClass:Acme_Logger', ['logError'], 'Acme_Logger '],
      ['ApexClass:acmens__PricingService', ['price'], 'acmens.PricingService'],
    ]);
    expect(apex[0]?.properties['callSites']).toEqual([
      { site: 'Notify', siteType: 'Remote Action', remoteMethod: 'notify' },
      { site: 'UpsertOrder', siteType: 'Remote Action', remoteMethod: 'upsertRecords', objectArgs: ['Acme_Order__c'] },
    ]);
    expect(apex[1]?.properties['callSites']).toEqual([{ site: 'TryBlock', siteType: 'Try Catch Block', remoteMethod: 'logError' }]);
    expect(apex.every((e) => e.properties['entryVia'] === 'omnistudio-remote' && e.confidence === 'parsed')).toBe(true);
    const deletes = byType(r.value.edges, 'writesTo');
    expect(deletes.map((e) => [e.toId, e.properties['operation'], e.properties['steps'], e.properties['recordIds']])).toEqual([
      ['CustomObject:Acme_Order_Line__c', 'recordDelete', ['RemoveLine'], ['%lineId%']],
    ]);
  });
});

describe('OmniScript coupling', () => {
  it('dispatches a DataRaptor Post Action, and calls Apex from Remote Action and File elements', async () => {
    const path = await write(
      'Acme_Intake_English_1.os-meta.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>false</isIntegrationProcedure>
    <language>English</language>
    <name>Acme Intake</name>
    ${el(
      'IntakeStep',
      'Step',
      {},
      child('SaveDirect', 'DataRaptor Post Action', { bundle: 'AcmeSaveIntake' }) +
        child('LookupThing', 'Remote Action', { remoteClass: 'Acme_IntakeService', remoteMethod: 'lookup' }) +
        child('Attachment', 'File', { remoteClass: 'Acme_FileService', remoteMethod: 'upload' }),
    )}
    <subType>Intake</subType>
    <type>Acme</type>
    <uniqueName>Acme_Intake_English_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniScript>`,
    );
    const r = await extractOmniScript(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(byType(r.value.edges, 'dispatchesOmniAction').map((e) => [e.toId, e.properties['stepType']])).toEqual([
      ['OmniDataTransform:AcmeSaveIntake', 'DataRaptor Post Action'],
    ]);
    expect(byType(r.value.edges, 'callsApex').map((e) => [e.toId, e.properties['methods']])).toEqual([
      ['ApexClass:Acme_FileService', ['upload']],
      ['ApexClass:Acme_IntakeService', ['lookup']],
    ]);
  });
});

describe('FlexCard SOQL data source', () => {
  it('reads the queried object and fields; a relationship path waits for the import', async () => {
    const path = await write(
      'AcmeCaseCard_Developer_1.ouc-meta.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<OmniUiCard xmlns="http://soap.sforce.com/2006/04/metadata">
    <authorName>Developer</authorName>
    <isActive>true</isActive>
    <name>AcmeCaseCard</name>
    <omniUiCardType>Parent</omniUiCardType>
    <dataSourceConfig>${psc({ dataSource: { type: 'Query', value: { query: 'select Acme_Status__c, Owner.Name from Acme_Case__c where Id = :recordId' } } })}</dataSourceConfig>
    <propertySetConfig>${psc({ states: [] })}</propertySetConfig>
    <versionNumber>1</versionNumber>
</OmniUiCard>`,
    );
    const r = await extractOmniUiCard(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(byType(r.value.edges, 'readsFrom').map((e) => e.toId)).toEqual([
      'CustomField:Acme_Case__c.Acme_Status__c',
      'CustomField:Acme_Case__c.Id',
      'CustomObject:Acme_Case__c',
    ]);
    expect(r.value.nodes[0]?.properties['unresolvedTraversalRefs']).toEqual([
      { object: 'Acme_Case__c', path: 'Owner.Name', access: 'read' },
    ]);
  });
});
