/// <reference types="vitest/globals" />

import { extractApexAstEdges } from '../src/apex-ast-edges.js';

/**
 * Receiver resolution gaps in the parser-grade Apex pass (synthetic fixtures):
 *
 *   - DEV-04: `records[i].Field__c = x` (an indexed receiver) and
 *     `rows.get(i).Field__c` / `byId.get(id).Field__c` (a collection `get`)
 *     resolved to nothing, so 'which classes write field F' silently lost
 *     every writer that loops by index.
 *   - WOW-10: Apex type names are case-insensitive. `case cc = obj;` /
 *     `account a = new account();` were rejected as non-sObjects, so the
 *     class's real writes vanished (and the scanner minted
 *     `CustomField:cc.Status` phantoms instead).
 */
const KNOWN_OBJECTS = new Set(['Case', 'Account', 'Invoice__c', 'Project__c']);
const run = (src: string): ReturnType<typeof extractApexAstEdges> =>
  extractApexAstEdges(src, 'InvoiceJob', { knownClasses: new Set(['InvoiceJob']), knownObjects: KNOWN_OBJECTS });

describe('extractApexAstEdges — indexed / collection-get receivers (DEV-04)', () => {
  it('FAIL-BEFORE/PASS-AFTER: records[i].Field writes and reads resolve to the List element type', () => {
    const out = run(
      'public class InvoiceJob { public void run(List<Invoice__c> records) { for (Integer i = 0; i < records.size(); i++) { records[i].Amount__c = 5; String s = records[i].Status__c; } } }',
    );
    expect(out.parseError).toBeUndefined();
    expect(out.writes).toEqual(['Invoice__c.Amount__c']);
    expect(out.reads).toEqual(['Invoice__c.Status__c']);
  });

  it('FAIL-BEFORE/PASS-AFTER: an array-typed local (X[]) resolves too', () => {
    const out = run('public class InvoiceJob { public void run() { Invoice__c[] arr = new Invoice__c[1]; arr[0].Note__c = \'x\'; } }');
    expect(out.writes).toEqual(['Invoice__c.Note__c']);
  });

  it('FAIL-BEFORE/PASS-AFTER: List.get / Map.get chains resolve to the element / value type', () => {
    const out = run(
      'public class InvoiceJob { public void run(List<Invoice__c> rows, Map<Id, Project__c> byId, Id k) { rows.get(0).Amount__c = 1; byId.get(k).Total__c = 3; } }',
    );
    expect(out.writes).toEqual(['Invoice__c.Amount__c', 'Project__c.Total__c']);
  });

  it('an index into a NON-sObject collection mints nothing (no invented field)', () => {
    const out = run('public class InvoiceJob { public void run(List<String> names) { Integer n = names[0].length(); } }');
    expect(out.reads).toEqual([]);
    expect(out.writes).toEqual([]);
  });
});

describe('extractApexAstEdges — case-insensitive type names (WOW-10)', () => {
  it('FAIL-BEFORE/PASS-AFTER: `case cc = obj;` resolves cc to Case', () => {
    const out = run("public class InvoiceJob { public void close(Case obj) { case cc = obj; cc.Status = 'Closed'; update cc; } }");
    expect(out.parseError).toBeUndefined();
    expect(out.writes).toEqual(['Case.Status']);
  });

  it('FAIL-BEFORE/PASS-AFTER: lowercase declared + constructed types canonicalise against the object roster', () => {
    const out = run(
      "public class InvoiceJob { public void run() { account a = new account(); a.Name = 'x'; List<invoice__c> l = new List<invoice__c>(); l[0].Amount__c = 2; } }",
    );
    expect(out.writes).toEqual(['Account.Name', 'Invoice__c.Amount__c']);
  });

  it('exposes declared variable names so the scanner phantom on `cc.Status` can be dropped', () => {
    const out = run("public class InvoiceJob { public void close(Case obj) { case cc = obj; cc.Status = 'Closed'; } }");
    expect(out.variables).toEqual(expect.arrayContaining(['cc', 'obj']));
  });

  it('without a roster a lowercase type stays unresolved (no guessed canonical name)', () => {
    const out = extractApexAstEdges("public class InvoiceJob { public void run() { account a; a.Name = 'x'; } }", 'InvoiceJob');
    expect(out.writes).toEqual([]);
  });
});
