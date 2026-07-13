/// <reference types="vitest/globals" />

import { buildErDiagram, type ErdRelationship } from '../src/erd-mermaid.js';

const lookup = (
  childObjectApiName: string,
  childFieldApiName: string,
  parentObjectApiName: string,
): ErdRelationship => ({
  childObjectApiName,
  childFieldApiName,
  parentObjectApiName,
  relationshipKind: 'Lookup',
});

const masterDetail = (
  childObjectApiName: string,
  childFieldApiName: string,
  parentObjectApiName: string,
): ErdRelationship => ({
  childObjectApiName,
  childFieldApiName,
  parentObjectApiName,
  relationshipKind: 'MasterDetail',
});

describe('buildErDiagram', () => {
  it('wraps output in a ```mermaid erDiagram fence', () => {
    const result = buildErDiagram([lookup('Contact', 'AccountId', 'Account')]);
    expect(result.mermaid.startsWith('```mermaid\nerDiagram\n')).toBe(true);
    expect(result.mermaid.endsWith('```')).toBe(true);
  });

  it('renders Lookup with the zero-or-more (o{) connector', () => {
    const result = buildErDiagram([lookup('Contact', 'ReportsToId', 'Contact')]);
    expect(result.mermaid).toContain('||--o{');
    expect(result.mermaid).toContain('Lookup (ReportsToId)');
  });

  it('renders Master-Detail with the one-or-more (|{) connector, distinct from Lookup', () => {
    const result = buildErDiagram([masterDetail('OrderItem__c', 'Order__c', 'Order__c')]);
    expect(result.mermaid).toContain('||--|{');
    expect(result.mermaid).not.toContain('||--o{');
    expect(result.mermaid).toContain('MasterDetail (Order__c)');
  });

  it('sanitizes api names carrying __c into mermaid-safe entity ids while keeping the real name in the label', () => {
    const result = buildErDiagram([lookup('Opportunity', 'Account__c', 'Account')]);
    // The real api name is never mangled inside the quoted label.
    expect(result.mermaid).toContain('"Account"');
    expect(result.mermaid).toContain('"Opportunity"');
    // The entity id (outside the label) has no stray colons/dots — it is a
    // plain identifier built from the sanitizer.
    const idLine = result.mermaid.split('\n').find((l) => l.includes('||--'));
    expect(idLine).toBeDefined();
    expect(idLine).toMatch(/^ {4}[A-Za-z_][A-Za-z0-9_]*\["Account"\] \|\|--o\{ [A-Za-z_][A-Za-z0-9_]*\["Opportunity"\]/);
  });

  it('gives two objects that would sanitize to the same code distinct entity ids', () => {
    const result = buildErDiagram([
      lookup('Foo-Bar', 'X__c', 'Account'),
      lookup('Foo.Bar', 'Y__c', 'Account'),
    ]);
    const ids = [...result.mermaid.matchAll(/(\w+)\["Foo[.-]Bar"\]/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it('an empty relationship list still returns a valid fence with a comment line, not an empty diagram', () => {
    const result = buildErDiagram([]);
    expect(result.mermaid).toContain('```mermaid');
    expect(result.mermaid).toContain('erDiagram');
    expect(result.mermaid).toContain('%%');
    expect(result.renderedRelationships).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('dedupes identical (parent, child, field) rows', () => {
    const rel = lookup('Contact', 'AccountId', 'Account');
    const result = buildErDiagram([rel, { ...rel }]);
    expect(result.totalRelationships).toBe(1);
  });

  it('caps at maxRelationships and discloses the truncation honestly, keeping the true total', () => {
    const relationships: ErdRelationship[] = [];
    for (let i = 0; i < 10; i += 1) {
      relationships.push(lookup(`Child_${i.toString()}__c`, `Parent_${i.toString()}__c`, `Parent_${i.toString()}`));
    }
    const result = buildErDiagram(relationships, { maxRelationships: 3 });
    expect(result.totalRelationships).toBe(10);
    expect(result.renderedRelationships).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.disclosure).toBeDefined();
    expect(result.disclosure).toContain('capped at 3 of 10');
  });

  it('under the cap: truncated is false and disclosure is absent', () => {
    const result = buildErDiagram([lookup('Contact', 'AccountId', 'Account')], { maxRelationships: 40 });
    expect(result.truncated).toBe(false);
    expect(result.disclosure).toBeUndefined();
  });

  it('renders deterministically regardless of input order (sorted by parent, child, field)', () => {
    const a = buildErDiagram([
      lookup('Contact', 'AccountId', 'Account'),
      lookup('Opportunity', 'AccountId', 'Account'),
    ]);
    const b = buildErDiagram([
      lookup('Opportunity', 'AccountId', 'Account'),
      lookup('Contact', 'AccountId', 'Account'),
    ]);
    expect(a.mermaid).toBe(b.mermaid);
  });

  it('escapes an embedded double-quote in an api name so it cannot break the mermaid label', () => {
    const result = buildErDiagram([lookup('Weird"Object__c', 'X__c', 'Account')]);
    expect(result.mermaid).not.toContain('"Weird"Object__c"');
    expect(result.mermaid).toContain("Weird'Object__c");
  });
});
