/// <reference types="vitest/globals" />

import { dmlOperand, operandTypeNames } from '../../src/tools/apex-dml-index.js';

describe('DML operand typing (apex-dml-index)', () => {
  it('reads the operand of a statement and of a Database call', () => {
    expect(dmlOperand('insert rows;', 'statement')).toBe('rows');
    expect(dmlOperand('upsert as user rows Acme_Key__c;', 'statement')).toBe('rows');
    expect(dmlOperand('delete [SELECT Id FROM Acme_Visit__c WHERE Id = :x];', 'statement')).toBe('[SELECT Id FROM Acme_Visit__c WHERE Id = :x]');
    expect(dmlOperand('Database.insert(rows, false, AccessLevel.USER_MODE);', 'database-method')).toBe('rows');
    expect(dmlOperand('List<Database.SaveResult> r = Database.update(new List<Acme_Order__c>{ o }, false);', 'database-method')).toBe('new List<Acme_Order__c>{ o }');
  });

  it('types the operand from its declaration, a constructor, or an inline query', () => {
    const method = `
      public static void save(Acme_Member__c member, List<Id> ids) {
        List<Acme_Asset__c> assets = [SELECT Id FROM Acme_Asset__c];
        Map<Id, Acme_Income__c> incomes = new Map<Id, Acme_Income__c>();
        SObject rec = Id.valueOf(ids[0]).getSObjectType().newSObject();
        insert assets;
      }`;
    expect(operandTypeNames('member', method, method)).toEqual(['Acme_Member__c']);
    expect(operandTypeNames('assets', method, method)).toEqual(['Acme_Asset__c']);
    expect(operandTypeNames('incomes.values()', method, method)).toEqual(['Acme_Income__c']);
    expect(operandTypeNames('rec', method, method)).toEqual(['SObject']);
    expect(operandTypeNames('new Acme_Note__c(Name = n)', method, method)).toEqual(['Acme_Note__c']);
    expect(operandTypeNames('[SELECT Id FROM Acme_Visit__c]', method, method)).toEqual(['Acme_Visit__c']);
    expect(operandTypeNames('unknownVar', method, method)).toEqual([]);
  });
});

describe('platform event publishes count as inserts', () => {
  it('reads the published operand through the same typing', async () => {
    const { operandTypeNames: typeNames } = await import('../../src/tools/apex-dml-index.js');
    const method = `
      public static void notify(Id docId) {
        Acme_Doc_Event__e eventObj = new Acme_Doc_Event__e(Doc_Id__c = docId);
        Database.SaveResult result = EventBus.publish(eventObj);
      }`;
    expect(typeNames('eventObj', method, method)).toEqual(['Acme_Doc_Event__e']);
  });
});
