/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  extractApexClass,
  extractApexTrigger,
  extractCustomField,
  extractCustomObject,
  extractFlow,
  extractOmniIntegrationProcedure,
  extractPermissionSet,
  extractPermissionSetGroup,
  extractValidationRule,
} from '@sf-intelligence/extractors';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { ip } from '../omni/omni-fixture.js';

/**
 * A synthetic data model (spec §13 item 7) — Acme names only — for the
 * record-delete impact of `Acme_Member__c`:
 *
 *   - Acme_Income__c   two lookups to the member: SetNull (ORPHANED) and
 *                      Cascade (DELETED_WITH_PARENT) → INCONSISTENT_CONSTRAINT
 *   - Acme_Asset__c    a lookup that declares no constraint → ORPHANED via the
 *                      platform default
 *   - Acme_Visit__c    Restrict → BLOCKS_DELETE
 *   - Acme_Case__c     a REQUIRED lookup with no constraint → UNKNOWN
 *   - Acme_Score__c    master-detail → DELETED_WITH_PARENT, whose own child
 *                      Acme_Score_Line__c (SetNull) is orphaned through the cascade
 *   - Acme_Household__c the member's master, with a COUNT roll-up over members
 *   - no delete trigger or delete flow on the member (an Obsolete delete flow
 *     and an active validation rule do not count) → NO_SERVER_GUARD
 *   - the clean twin Acme_Guarded__c: a SetNull child and a before-delete trigger
 *     → ORPHANED is `unknown`, no NO_SERVER_GUARD
 *   - who can delete: a portal permission set (Delete, in a group), an admin set
 *     (Modify All), a read-only set (not listed); Apex that queries and deletes
 *     members, a generic deleter (called from an IP Remote Action), a class
 *     deleting another object, a test class; an active IP Delete Action on the
 *     member (and an inactive version); an active Flow that deletes members.
 */

const xml = (root: string, body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n</${root}>\n`;

const objectXml = (label: string): string =>
  xml('CustomObject', `<deploymentStatus>Deployed</deploymentStatus>\n<label>${label}</label>\n<nameField><label>Name</label><type>Text</type></nameField>\n<pluralLabel>${label}s</pluralLabel>\n<sharingModel>ReadWrite</sharingModel>`);

const lookupXml = (o: { name: string; target: string; type?: 'Lookup' | 'MasterDetail'; constraint?: string; required?: boolean }): string =>
  xml(
    'CustomField',
    [
      `<fullName>${o.name}</fullName>`,
      ...(o.constraint === undefined ? [] : [`<deleteConstraint>${o.constraint}</deleteConstraint>`]),
      `<label>${o.name}</label>`,
      `<referenceTo>${o.target}</referenceTo>`,
      `<relationshipName>${o.name.replace(/__c$/, '')}s</relationshipName>`,
      ...(o.required === true ? ['<required>true</required>'] : []),
      `<type>${o.type ?? 'Lookup'}</type>`,
    ].join('\n'),
  );

const permissionSetXml = (label: string, perms: Record<string, boolean>): string =>
  xml(
    'PermissionSet',
    `<label>${label}</label>\n<objectPermissions>\n${Object.entries(perms)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('\n')}\n<object>Acme_Member__c</object>\n</objectPermissions>`,
  );

const MEMBER_SERVICE = `public with sharing class Acme_MemberService {
    // Removes one household member.
    @AuraEnabled
    public static void removeMember(Id memberId) {
        List<Acme_Member__c> rows = [SELECT Id FROM Acme_Member__c WHERE Id = :memberId];
        delete rows;
    }
    public static void closeVisits(Id visitId) {
        delete [SELECT Id FROM Acme_Visit__c WHERE Id = :visitId];
    }
}
`;

const UTILITY = `global without sharing class Acme_Utility {
    /* deletes whatever record id it is handed; mentions Acme_Member__c only in this comment */
    global static void deleteFromPayload(String recordId) {
        SObject rec = Id.valueOf(recordId).getSObjectType().newSObject(Id.valueOf(recordId));
        Database.delete(rec, AccessLevel.USER_MODE);
    }
}
`;

const MEMBER_TEST = `@isTest
private class Acme_MemberServiceTest {
    @isTest static void removes() {
        Acme_Member__c m = new Acme_Member__c();
        insert m;
        delete m;
    }
}
`;

const GUARD_TRIGGER = `trigger Acme_GuardedTrigger on Acme_Guarded__c (before delete) {
    for (Acme_Guarded__c g : Trigger.old) {
        g.addError('Remove the children first');
    }
}
`;

const classMeta = xml('ApexClass', '<apiVersion>60.0</apiVersion>\n<status>Active</status>');
const triggerMeta = xml('ApexTrigger', '<apiVersion>60.0</apiVersion>\n<status>Active</status>');

/** A built fixture vault. */
export interface DeleteFixture {
  readonly ctx: Context;
  readonly vaultRoot: string;
  readonly store: GraphStore;
  readonly cleanup: () => Promise<void>;
}

type Extract = (p: string) => Promise<{ ok: boolean; value?: ExtractionResult }>;

/** Write the synthetic source tree, extract it, and import it into a fresh graph. */
export const buildDeleteFixture = async (): Promise<DeleteFixture> => {
  const tmp = mkdtempSync(join(tmpdir(), 'sfi-delete-fixture-'));
  const vaultRoot = join(tmp, 'org-kb');
  const src = join(vaultRoot, 'source', 'main', 'default');
  const files: { path: string; body: string; extract: Extract | null }[] = [];
  const add = (rel: string, body: string, extract: Extract | null): void => {
    files.push({ path: join(src, rel), body, extract });
  };
  for (const o of ['Acme_Member__c', 'Acme_Income__c', 'Acme_Asset__c', 'Acme_Visit__c', 'Acme_Case__c', 'Acme_Score__c', 'Acme_Score_Line__c', 'Acme_Household__c', 'Acme_Guarded__c', 'Acme_Guarded_Child__c']) {
    add(`objects/${o}/${o}.object-meta.xml`, objectXml(o), extractCustomObject);
  }
  const field = (object: string, f: Parameters<typeof lookupXml>[0]): void =>
    add(`objects/${object}/fields/${f.name}.field-meta.xml`, lookupXml(f), extractCustomField);
  field('Acme_Income__c', { name: 'Acme_Member__c', target: 'Acme_Member__c', constraint: 'SetNull' });
  field('Acme_Income__c', { name: 'Acme_Joint_Member__c', target: 'Acme_Member__c', constraint: 'Cascade' });
  field('Acme_Asset__c', { name: 'Acme_Member__c', target: 'Acme_Member__c' });
  field('Acme_Visit__c', { name: 'Acme_Member__c', target: 'Acme_Member__c', constraint: 'Restrict' });
  field('Acme_Case__c', { name: 'Acme_Member__c', target: 'Acme_Member__c', required: true });
  field('Acme_Score__c', { name: 'Acme_Member__c', target: 'Acme_Member__c', type: 'MasterDetail' });
  field('Acme_Score_Line__c', { name: 'Acme_Score__c', target: 'Acme_Score__c', constraint: 'SetNull' });
  field('Acme_Member__c', { name: 'Acme_Household__c', target: 'Acme_Household__c', type: 'MasterDetail' });
  field('Acme_Guarded_Child__c', { name: 'Acme_Guarded__c', target: 'Acme_Guarded__c', constraint: 'SetNull' });
  add(
    'objects/Acme_Household__c/fields/Acme_Member_Count__c.field-meta.xml',
    xml('CustomField', '<fullName>Acme_Member_Count__c</fullName>\n<label>Members</label>\n<summaryForeignKey>Acme_Member__c.Acme_Household__c</summaryForeignKey>\n<summaryOperation>count</summaryOperation>\n<type>Summary</type>'),
    extractCustomField,
  );
  add(
    'objects/Acme_Member__c/validationRules/Acme_Name_Required.validationRule-meta.xml',
    xml('ValidationRule', '<fullName>Acme_Name_Required</fullName>\n<active>true</active>\n<errorConditionFormula>ISBLANK(Name)</errorConditionFormula>\n<errorMessage>Name is required</errorMessage>'),
    extractValidationRule,
  );
  add(
    'flows/Acme_Member_Before_Delete.flow-meta.xml',
    xml('Flow', '<apiVersion>60.0</apiVersion>\n<label>Acme Member Before Delete</label>\n<processType>AutoLaunchedFlow</processType>\n<start>\n<locationX>0</locationX>\n<locationY>0</locationY>\n<object>Acme_Member__c</object>\n<recordTriggerType>Delete</recordTriggerType>\n<triggerType>RecordBeforeDelete</triggerType>\n</start>\n<status>Obsolete</status>'),
    extractFlow,
  );
  add(
    'flows/Acme_Purge_Members.flow-meta.xml',
    xml('Flow', '<apiVersion>60.0</apiVersion>\n<label>Acme Purge Members</label>\n<processType>AutoLaunchedFlow</processType>\n<recordDeletes>\n<name>Delete_Members</name>\n<label>Delete Members</label>\n<locationX>0</locationX>\n<locationY>0</locationY>\n<filterLogic>and</filterLogic>\n<filters>\n<field>Id</field>\n<operator>EqualTo</operator>\n<value><elementReference>memberId</elementReference></value>\n</filters>\n<object>Acme_Member__c</object>\n</recordDeletes>\n<start>\n<locationX>0</locationX>\n<locationY>0</locationY>\n<connector><targetReference>Delete_Members</targetReference></connector>\n</start>\n<status>Active</status>'),
    extractFlow,
  );
  add('triggers/Acme_GuardedTrigger.trigger', GUARD_TRIGGER, extractApexTrigger);
  add('triggers/Acme_GuardedTrigger.trigger-meta.xml', triggerMeta, null);
  add('classes/Acme_MemberService.cls', MEMBER_SERVICE, extractApexClass);
  add('classes/Acme_MemberService.cls-meta.xml', classMeta, null);
  add('classes/Acme_Utility.cls', UTILITY, extractApexClass);
  add('classes/Acme_Utility.cls-meta.xml', classMeta, null);
  add('classes/Acme_MemberServiceTest.cls', MEMBER_TEST, extractApexClass);
  add('classes/Acme_MemberServiceTest.cls-meta.xml', classMeta, null);
  add(
    'permissionsets/Acme_Portal_User.permissionset-meta.xml',
    permissionSetXml('Acme Portal User', { allowCreate: true, allowDelete: true, allowEdit: true, allowRead: true, modifyAllRecords: false, viewAllRecords: false }),
    extractPermissionSet,
  );
  add(
    'permissionsets/Acme_Admin.permissionset-meta.xml',
    permissionSetXml('Acme Admin', { allowCreate: true, allowDelete: true, allowEdit: true, allowRead: true, modifyAllRecords: true, viewAllRecords: true }),
    extractPermissionSet,
  );
  add(
    'permissionsets/Acme_Reader.permissionset-meta.xml',
    permissionSetXml('Acme Reader', { allowCreate: false, allowDelete: false, allowEdit: false, allowRead: true, modifyAllRecords: false, viewAllRecords: false }),
    extractPermissionSet,
  );
  add(
    'permissionsetgroups/Acme_Portal_Group.permissionsetgroup-meta.xml',
    xml('PermissionSetGroup', '<label>Acme Portal Group</label>\n<permissionSets>Acme_Portal_User</permissionSets>\n<status>Updated</status>'),
    extractPermissionSetGroup,
  );
  const removeMember = (version: number, active: boolean): string =>
    ip({
      type: 'Acme',
      subType: 'RemoveMember',
      version,
      active,
      elements: [
        {
          name: 'DeleteMember',
          type: 'Delete Action',
          cfg: { deleteSObject: [{ Type: 'Acme_Member__c', Id: '%memberId%', AllOrNone: false, rowId: 1 }], failOnStepError: true },
        },
      ],
    });
  // A generic delete reached from OmniStudio: an IP Remote Action on the generic deleter.
  add(
    'omniIntegrationProcedures/Acme_PurgeRow_English_1.oip-meta.xml',
    ip({ type: 'Acme', subType: 'PurgeRow', version: 1, active: true, elements: [{ name: 'Purge', type: 'Remote Action', cfg: { remoteClass: 'Acme_Utility', remoteMethod: 'deleteFromPayload' } }] }),
    extractOmniIntegrationProcedure,
  );
  add('omniIntegrationProcedures/Acme_RemoveMember_English_1.oip-meta.xml', removeMember(1, false), extractOmniIntegrationProcedure);
  add('omniIntegrationProcedures/Acme_RemoveMember_English_2.oip-meta.xml', removeMember(2, true), extractOmniIntegrationProcedure);

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
    refreshedAt: '2026-10-02T00:00:00Z',
    sourceOrg: 'fixture@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:delete-fixture',
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
