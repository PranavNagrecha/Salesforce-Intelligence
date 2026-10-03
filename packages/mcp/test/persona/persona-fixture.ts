/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  extractApexClass,
  extractCustomField,
  extractCustomObject,
  extractOmniDataTransform,
  extractOmniIntegrationProcedure,
  extractOmniScript,
  extractPermissionSet,
} from '@sf-intelligence/extractors';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { dm, ip, script } from '../omni/omni-fixture.js';

/**
 * A synthetic portal persona (spec §13 item 8) — Acme names only. The
 * permission set `Acme_Portal` grants:
 *
 *   Acme_Order__c         C/E   written by a DataMapper Load the portal screen
 *                               saves through                       → USED
 *   Acme_Log__c           C     inserted by the logger an IP's Try Catch
 *                               block calls                         → USED (a real use)
 *   Acme_Batch_Status__c  C/E   written only by a batch class nothing
 *                               the persona runs calls              → UNUSED
 *   Acme_Audit__c         C     inserted only `as system`           → USED_ONLY_IN_SYSTEM_MODE
 *   Acme_Note__c          E     a reachable generic helper is handed
 *                               records of a runtime type, and
 *                               reachable code names this object    → UNKNOWN
 *   Acme_Signal__e        C     published with EventBus.publish     → USED
 */

const xml = (root: string, body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n</${root}>\n`;

const objectXml = (label: string): string =>
  xml('CustomObject', `<deploymentStatus>Deployed</deploymentStatus>\n<label>${label}</label>\n<nameField><label>Name</label><type>Text</type></nameField>\n<pluralLabel>${label}s</pluralLabel>\n<sharingModel>ReadWrite</sharingModel>`);

const textField = (name: string): string => xml('CustomField', `<fullName>${name}</fullName>\n<label>${name}</label>\n<length>80</length>\n<type>Text</type>`);

const perm = (object: string, flags: { c?: boolean; e?: boolean; d?: boolean }): string =>
  `<objectPermissions>\n<allowCreate>${flags.c === true}</allowCreate>\n<allowDelete>${flags.d === true}</allowDelete>\n<allowEdit>${flags.e === true}</allowEdit>\n<allowRead>true</allowRead>\n<modifyAllRecords>false</modifyAllRecords>\n<object>${object}</object>\n<viewAllRecords>false</viewAllRecords>\n</objectPermissions>`;

const fieldPerm = (field: string): string => `<fieldPermissions>\n<editable>true</editable>\n<field>${field}</field>\n<readable>true</readable>\n</fieldPermissions>`;

const LOGGER = `public with sharing class Acme_Logger {
    public static void log(String message) {
        Acme_Log__c entry = new Acme_Log__c(Name = message);
        insert entry;
        Acme_AuditService.record(message);
    }
}
`;

const AUDIT = `public without sharing class Acme_AuditService {
    public static void record(String message) {
        insert as system new Acme_Audit__c(Name = message);
    }
}
`;

const NOTES = `public with sharing class Acme_Notes {
    // Saves whatever record the caller identifies; Acme_Note__c is one of them.
    public static void save(Id recordId) {
        SObject rec = recordId.getSObjectType().newSObject(recordId);
        Acme_GenericDml.saveAny(new List<SObject>{ rec });
        List<Acme_Note__c> recent = [SELECT Id FROM Acme_Note__c LIMIT 1];
    }
}
`;

const GENERIC = `public with sharing class Acme_GenericDml {
    public static void saveAny(List<SObject> rows) {
        update rows;
    }
}
`;

const SIGNALS = `public with sharing class Acme_Signals {
    public static void raise(String detail) {
        Acme_Signal__e signal = new Acme_Signal__e(Detail__c = detail);
        EventBus.publish(signal);
    }
}
`;

const BATCH = `public with sharing class Acme_StatusBatch implements Database.Batchable<SObject> {
    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator('SELECT Id FROM Acme_Batch_Status__c');
    }
    public void execute(Database.BatchableContext bc, List<Acme_Batch_Status__c> scope) {
        update scope;
    }
    public void finish(Database.BatchableContext bc) {}
}
`;

const classMeta = xml('ApexClass', '<apiVersion>60.0</apiVersion>\n<status>Active</status>');

/** A built fixture vault. */
export interface PersonaFixture {
  readonly ctx: Context;
  readonly vaultRoot: string;
  readonly store: GraphStore;
  readonly cleanup: () => Promise<void>;
}

type Extract = (p: string) => Promise<{ ok: boolean; value?: ExtractionResult }>;

export const buildPersonaFixture = async (): Promise<PersonaFixture> => {
  const tmp = mkdtempSync(join(tmpdir(), 'sfi-persona-fixture-'));
  const vaultRoot = join(tmp, 'org-kb');
  const src = join(vaultRoot, 'source', 'main', 'default');
  const files: { path: string; body: string; extract: Extract | null }[] = [];
  const add = (rel: string, body: string, extract: Extract | null): void => {
    files.push({ path: join(src, rel), body, extract });
  };
  for (const o of ['Acme_Order__c', 'Acme_Log__c', 'Acme_Batch_Status__c', 'Acme_Audit__c', 'Acme_Note__c']) {
    add(`objects/${o}/${o}.object-meta.xml`, objectXml(o), extractCustomObject);
  }
  add('objects/Acme_Signal__e/Acme_Signal__e.object-meta.xml', xml('CustomObject', '<deploymentStatus>Deployed</deploymentStatus>\n<eventType>HighVolume</eventType>\n<label>Acme Signal</label>\n<pluralLabel>Acme Signals</pluralLabel>\n<publishBehavior>PublishAfterCommit</publishBehavior>'), extractCustomObject);
  for (const f of ['Acme_Status__c', 'Acme_Qty__c', 'Acme_Internal_Code__c']) {
    add(`objects/Acme_Order__c/fields/${f}.field-meta.xml`, textField(f), extractCustomField);
  }
  add(
    'permissionsets/Acme_Portal.permissionset-meta.xml',
    xml(
      'PermissionSet',
      [
        fieldPerm('Acme_Order__c.Acme_Status__c'),
        fieldPerm('Acme_Order__c.Acme_Qty__c'),
        fieldPerm('Acme_Order__c.Acme_Internal_Code__c'),
        '<label>Acme Portal</label>',
        perm('Acme_Order__c', { c: true, e: true }),
        perm('Acme_Log__c', { c: true }),
        perm('Acme_Batch_Status__c', { c: true, e: true }),
        perm('Acme_Audit__c', { c: true }),
        perm('Acme_Note__c', { e: true }),
        perm('Acme_Signal__e', { c: true }),
      ].join('\n'),
    ),
    extractPermissionSet,
  );
  for (const [name, body] of [
    ['Acme_Logger', LOGGER],
    ['Acme_AuditService', AUDIT],
    ['Acme_Notes', NOTES],
    ['Acme_GenericDml', GENERIC],
    ['Acme_Signals', SIGNALS],
    ['Acme_StatusBatch', BATCH],
  ] as const) {
    add(`classes/${name}.cls`, body, extractApexClass);
    add(`classes/${name}.cls-meta.xml`, classMeta, null);
  }
  add(
    'omniDataTransforms/AcmeSaveOrder_1.rpt-meta.xml',
    dm({
      name: 'AcmeSaveOrder',
      type: 'Load',
      items: [
        { inputFieldName: 'Order:Status', outputFieldName: 'Acme_Status__c', outputObjectName: 'Acme_Order__c' },
        { inputFieldName: 'Order:Qty', outputFieldName: 'Acme_Qty__c', outputObjectName: 'Acme_Order__c' },
      ],
    }),
    extractOmniDataTransform,
  );
  add(
    'omniIntegrationProcedures/Acme_PortalSave_English_1.oip-meta.xml',
    ip({
      type: 'Acme',
      subType: 'PortalSave',
      version: 1,
      active: true,
      elements: [
        {
          name: 'TryBlock',
          type: 'Try Catch Block',
          cfg: { remoteClass: 'Acme_Logger', remoteMethod: 'log', failOnBlockError: true },
          children: [
            { name: 'SaveOrder', type: 'DataRaptor Post Action', cfg: { bundle: 'AcmeSaveOrder' } },
            { name: 'SaveNote', type: 'Remote Action', cfg: { remoteClass: 'Acme_Notes', remoteMethod: 'save' } },
            { name: 'Signal', type: 'Remote Action', cfg: { remoteClass: 'Acme_Signals', remoteMethod: 'raise' } },
          ],
        },
      ],
    }),
    extractOmniIntegrationProcedure,
  );
  add(
    'omniScripts/Acme_PortalIntake_English_1.os-meta.xml',
    script({
      type: 'Acme',
      subType: 'PortalIntake',
      language: 'English',
      version: 1,
      active: true,
      elements: [
        { name: 'OrderStep', type: 'Step', children: [{ name: 'Status', type: 'Text' }] },
        { name: 'Save', type: 'Integration Procedure Action', cfg: { integrationProcedureKey: 'Acme_PortalSave' } },
      ],
    }),
    extractOmniScript,
  );

  const results: ExtractionResult[] = [];
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.body, 'utf-8');
  }
  for (const f of files) {
    if (f.extract === null) continue;
    const r = await f.extract(f.path);
    if (!r.ok || r.value === undefined) throw new Error(`fixture extraction failed for ${f.path}: ${JSON.stringify(r)}`);
    results.push(r.value);
  }
  mkdirSync(join(vaultRoot, 'graph'), { recursive: true });
  const opened = await openGraph(join(vaultRoot, 'graph', 'graph.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const imported = await importExtractionResults(store, results);
  if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
  const manifest: VaultManifest = {
    version: '0.3.3',
    refreshedAt: '2026-10-03T00:00:00Z',
    sourceOrg: 'fixture@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:persona-fixture',
  };
  const ctx = { vaultRoot, manifest, graph: store } as unknown as Context;
  return {
    ctx,
    vaultRoot,
    store,
    cleanup: async () => {
      await closeGraph(store);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
};
