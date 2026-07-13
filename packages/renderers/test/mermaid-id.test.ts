/// <reference types="vitest/globals" />

import { buildSafeMermaidIdMap, safeMermaidLabel } from '../src/mermaid-id.js';

describe('buildSafeMermaidIdMap', () => {
  it('sanitizes colons and dots out of canonical component ids', () => {
    const map = buildSafeMermaidIdMap(['CustomField:Account.Discount__c']);
    const code = map.get('CustomField:Account.Discount__c');
    expect(code).toBeDefined();
    expect(code).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  it('gives every distinct input a distinct code even when sanitization would collide', () => {
    const map = buildSafeMermaidIdMap(['Foo-Bar', 'Foo.Bar', 'Foo_Bar']);
    const codes = [...map.values()];
    expect(new Set(codes).size).toBe(3);
  });

  it('is deterministic: the same input array always yields the same map', () => {
    const values = ['Account', 'Contact__c', 'ns__Object__c'];
    const mapA = buildSafeMermaidIdMap(values);
    const mapB = buildSafeMermaidIdMap(values);
    expect([...mapA.entries()]).toEqual([...mapB.entries()]);
  });

  it('guards against a leading digit (mermaid identifiers should not start with one)', () => {
    const map = buildSafeMermaidIdMap(['2026_Snapshot']);
    const code = map.get('2026_Snapshot');
    expect(code?.startsWith('_')).toBe(true);
  });

  it('maps the same raw value to the same code every time it appears', () => {
    const map = buildSafeMermaidIdMap(['Account', 'Account', 'Contact']);
    expect(map.size).toBe(2);
  });
});

describe('safeMermaidLabel', () => {
  it('collapses newlines to a single space', () => {
    expect(safeMermaidLabel('line one\nline two')).toBe('line one line two');
  });

  it('replaces an embedded double-quote with a single quote so it cannot close the mermaid label early', () => {
    expect(safeMermaidLabel('Say "hello"')).toBe("Say 'hello'");
  });

  it('leaves a clean label byte-identical', () => {
    expect(safeMermaidLabel('Account')).toBe('Account');
  });
});
