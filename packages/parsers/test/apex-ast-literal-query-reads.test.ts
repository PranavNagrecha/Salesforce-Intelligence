/// <reference types="vitest/globals" />

import { extractApexAstEdges } from '../src/apex-ast-edges.js';

/**
 * A field named only inside a SOQL string literal is parsed but not
 * compiler-checked: Salesforce lets the field be deleted and the query fails
 * at runtime. Such reads are reported apart (`literalQueryReads`) so delete
 * safety does not call them compile-time references. Synthetic source.
 */
describe('extractApexAstEdges — literalQueryReads', () => {
  it('FAIL-BEFORE/PASS-AFTER: a read found only in a string literal is listed in literalQueryReads', () => {
    const r = extractApexAstEdges(
      `public class InvoiceQueries {
        public static final String Q = 'SELECT Id, Status__c FROM Invoice__c';
        public void run() { List<SObject> rows = Database.query(Q); }
      }`,
      'InvoiceQueries',
      {},
    );
    expect(r.reads).toContain('Invoice__c.Status__c');
    expect(r.literalQueryReads).toEqual(['Invoice__c.Id', 'Invoice__c.Status__c']);
  });

  it('a field also read by static SOQL is not literal-only', () => {
    const r = extractApexAstEdges(
      `public class InvoiceQueries {
        public void run() {
          List<Invoice__c> a = [SELECT Status__c FROM Invoice__c];
          List<SObject> b = Database.query('SELECT Id, Status__c FROM Invoice__c');
        }
      }`,
      'InvoiceQueries',
      {},
    );
    expect(r.literalQueryReads).toEqual(['Invoice__c.Id']);
  });
});
