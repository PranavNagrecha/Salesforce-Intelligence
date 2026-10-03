/// <reference types="vitest/globals" />

import { stripApexComments } from '../../src/tools/apex-dml-index.js';
import { recordDeleteImpactHandler } from '../../src/tools/record-delete-impact.js';

import { buildDeleteFixture, type DeleteFixture } from './delete-fixture.js';

let fx: DeleteFixture;

beforeAll(async () => {
  fx = await buildDeleteFixture();
}, 60_000);

afterAll(async () => {
  await fx.cleanup();
});

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
};

describe('sfi.record_delete_impact', () => {
  it('classifies every relationship to the object, following the cascade', async () => {
    const r = must(await recordDeleteImpactHandler(fx.ctx, { objectApiName: 'acme_member__c' }));
    expect(r.data.appliedScope).toEqual({ componentId: 'CustomObject:Acme_Member__c', object: 'Acme_Member__c' });
    expect(r.data.children.map((c) => [c.field, c.effect, c.constraintSource, c.depth])).toEqual([
      ['CustomField:Acme_Asset__c.Acme_Member__c', 'ORPHANED', 'platform-default', 1],
      ['CustomField:Acme_Case__c.Acme_Member__c', 'UNKNOWN', 'not-in-metadata', 1],
      ['CustomField:Acme_Income__c.Acme_Joint_Member__c', 'DELETED_WITH_PARENT', 'declared', 1],
      ['CustomField:Acme_Income__c.Acme_Member__c', 'ORPHANED', 'declared', 1],
      ['CustomField:Acme_Score__c.Acme_Member__c', 'DELETED_WITH_PARENT', 'platform-rule', 1],
      ['CustomField:Acme_Visit__c.Acme_Member__c', 'BLOCKS_DELETE', 'declared', 1],
      ['CustomField:Acme_Score_Line__c.Acme_Score__c', 'ORPHANED', 'declared', 2],
    ]);
    const line = r.data.children.find((c) => c.field === 'CustomField:Acme_Score_Line__c.Acme_Score__c');
    expect(line?.via).toEqual(['CustomField:Acme_Score__c.Acme_Member__c']);
    const setNull = r.data.children.find((c) => c.field === 'CustomField:Acme_Income__c.Acme_Member__c');
    expect(setNull?.line).toBe(4);
    expect(setNull?.sourcePath).toMatch(/Acme_Income__c\/fields\/Acme_Member__c\.field-meta\.xml$/);
    expect(r.data.children.find((c) => c.effect === 'UNKNOWN')?.unknownReason).toMatch(/required lookup/);
  });

  it('reports ORPHANED, INCONSISTENT_CONSTRAINT and NO_SERVER_GUARD', async () => {
    const r = must(await recordDeleteImpactHandler(fx.ctx, { objectApiName: 'Acme_Member__c' }));
    const by = (code: string): (string | null)[][] =>
      r.data.findings.filter((f) => f.code === code).map((f) => [f.componentId, f.verdict]);
    expect(by('ORPHANED')).toEqual([
      ['CustomField:Acme_Asset__c.Acme_Member__c', 'defect'],
      ['CustomField:Acme_Income__c.Acme_Member__c', 'defect'],
      ['CustomField:Acme_Score_Line__c.Acme_Score__c', 'defect'],
    ]);
    expect(by('INCONSISTENT_CONSTRAINT')).toEqual([['CustomObject:Acme_Income__c', 'defect']]);
    expect(by('NO_SERVER_GUARD')).toEqual([['CustomObject:Acme_Member__c', 'defect']]);
    expect(r.data.guards.status).toBe('none');
    expect(r.data.guards.inactive.map((g) => g.componentId)).toEqual(['Flow:Acme_Member_Before_Delete']);
    expect(r.data.guards.validationRulesNotRunOnDelete).toBe(1);
  });

  it('names the roll-up that recalculates and who can delete', async () => {
    const r = must(await recordDeleteImpactHandler(fx.ctx, { componentId: 'CustomObject:Acme_Member__c' }));
    expect(r.data.rollups.map((x) => [x.fieldId, x.becauseOf])).toEqual([['CustomField:Acme_Household__c.Acme_Member_Count__c', 'Acme_Member__c']]);
    expect(r.data.whoCanDelete.grants.map((g) => [g.granterId, g.via, g.inGroups.map((x) => x.groupId)])).toEqual([
      ['PermissionSet:Acme_Admin', 'modify-all-object', []],
      ['PermissionSet:Acme_Portal_User', 'object-delete', ['PermissionSetGroup:Acme_Portal_Group']],
    ]);
    expect(r.data.whoCanDelete.declaredDeletes.map((p) => [p.kind, p.componentId, p.steps])).toEqual([
      ['flow-delete', 'Flow:Acme_Purge_Members', []],
      ['ip-delete-action', 'OmniIntegrationProcedure:Acme_RemoveMember_English_2', ['DeleteMember']],
    ]);
    expect(r.data.whoCanDelete.declaredDeletes[1]?.detail['recordIds']).toEqual(['%memberId%']);
    expect(r.data.whoCanDelete.apex.map((s) => [s.componentId, s.method, s.line])).toEqual([['ApexClass:Acme_MemberService', 'removeMember', 6]]);
    // Typed attribution: `List<Acme_Member__c> rows` is the deleted operand.
    expect(r.data.whoCanDelete.apex[0]?.evidence).toMatch(/typed as Acme_Member__c/);
    expect(r.data.whoCanDelete.genericDeletes.map((s) => [s.componentId, s.method, s.accessLevel, s.sharing, s.calledBy])).toEqual([
      ['ApexClass:Acme_Utility', 'deleteFromPayload', 'user', 'without sharing', ['OmniIntegrationProcedure:Acme_PurgeRow_English_1']],
    ]);
    expect(r.data.trust.confidence).toBe('heuristic');
  });

  it('leaves orphans undecided when a delete trigger guards the object (clean twin)', async () => {
    const r = must(await recordDeleteImpactHandler(fx.ctx, { object: 'Acme_Guarded__c' }));
    expect(r.data.guards.status).toBe('present');
    expect(r.data.guards.active.map((g) => [g.componentId, g.when])).toEqual([['ApexTrigger:Acme_GuardedTrigger', ['before delete']]]);
    expect(r.data.findings.map((f) => [f.code, f.verdict])).toEqual([['ORPHANED', 'unknown']]);
    expect(r.data.findings[0]?.unknownReason).toMatch(/Acme_GuardedTrigger/);
  });

  it('refuses an object that is not in the vault', async () => {
    const r = await recordDeleteImpactHandler(fx.ctx, { objectApiName: 'Acme_Nope__c' });
    expect(r.ok).toBe(false);
  });

  it('skips the slower scans on request', async () => {
    const r = must(await recordDeleteImpactHandler(fx.ctx, { objectApiName: 'Acme_Member__c', includeApex: false, includeOmniStudio: false }));
    expect(r.data.whoCanDelete.apex).toEqual([]);
    expect(r.data.whoCanDelete.editBlocks).toEqual([]);
    // Declared deletes are graph reads, not a scan: always present.
    expect(r.data.whoCanDelete.declaredDeletesTotal).toBe(2);
    expect(r.data.whoCanDelete.grants).toHaveLength(2);
  });
});

describe('stripApexComments', () => {
  it('blanks comments, keeps strings and line numbers', () => {
    const src = "a = 'x // not a comment'; // gone\n/* two\nlines */ b = 1;";
    const out = stripApexComments(src);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain("'x // not a comment'");
    expect(out).not.toContain('gone');
    expect(out).not.toContain('two');
    expect(out).toContain('b = 1;');
  });
});
