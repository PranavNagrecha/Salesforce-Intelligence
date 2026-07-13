/// <reference types="vitest/globals" />

import {
  escapeMarkdownInline,
  renderValueAsBacktickedString,
} from '../src/markdown-table.js';

describe('renderValueAsBacktickedString', () => {
  it('renders login IP range arrays as comma-joined startAddress-endAddress pairs', () => {
    const ranges = [
      { startAddress: '10.0.0.1', endAddress: '10.0.0.255' },
      { startAddress: '192.168.1.0', endAddress: '192.168.1.255' },
    ];
    const result = renderValueAsBacktickedString(ranges);
    expect(result).toContain('10.0.0.1-10.0.0.255');
    expect(result).toContain('192.168.1.0-192.168.1.255');
    expect(result).not.toContain('[object Object]');
    // Wrapped in backticks for markdown table cell.
    expect(result).toMatch(/^`.*`$/);
  });

  it('renders a single IP range entry', () => {
    const ranges = [{ startAddress: '10.0.0.0', endAddress: '10.255.255.255' }];
    const result = renderValueAsBacktickedString(ranges);
    expect(result).toBe('`10.0.0.0-10.255.255.255`');
  });

  it('renders picklist value objects (backward compat), suffixing inactive entries', () => {
    const values = [
      { value: 'Active', isActive: true },
      { value: 'Inactive', isActive: false },
      'LegacyValue',
    ];
    const result = renderValueAsBacktickedString(values);
    expect(result).toContain('Active');
    expect(result).toContain('Inactive (inactive)');
    expect(result).toContain('LegacyValue');
    expect(result).not.toContain('[object Object]');
  });

  it('leaves an empty array on the String() path (no false IP-range / picklist match)', () => {
    // An empty array matches neither guard (both require length > 0), so it
    // falls through to String([]) === '' and renders as an empty backtick span.
    expect(renderValueAsBacktickedString([])).toBe('``');
  });

  it('renders booleans and null as their own literals', () => {
    expect(renderValueAsBacktickedString(true)).toBe('`true`');
    expect(renderValueAsBacktickedString(false)).toBe('`false`');
    expect(renderValueAsBacktickedString(null)).toBe('`null`');
  });

  it('does not treat a partial {startAddress}-only object array as an IP-range array', () => {
    // Every entry must carry BOTH startAddress and endAddress; a mixed/partial
    // shape falls through to String() (which yields [object Object]) — this
    // pins that the guard is conservative and does not silently mis-render.
    const partial = [{ startAddress: '10.0.0.1' }];
    const result = renderValueAsBacktickedString(partial);
    expect(result).toContain('[object Object]');
  });
});

describe('escapeMarkdownInline (CR-16d)', () => {
  it('wraps a clean value (no backticks) in the minimal single-backtick fence', () => {
    // Byte-identical to the old "caller wraps in one backtick" contract for
    // every current caller — all feed backtick-free SF identifiers.
    expect(escapeMarkdownInline('Account__c')).toBe('`Account__c`');
  });

  it('collapses newlines to a single space before fencing', () => {
    expect(escapeMarkdownInline('a\nb')).toBe('`a b`');
  });

  it('widens the fence to two backticks when the value contains a single embedded backtick', () => {
    // A fixed single-backtick fence cannot hold this value: per CommonMark, a
    // code span closes at the next backtick run of the SAME length as its
    // opening run, and backslash escapes are inert inside code spans — so
    // the fence must be wider than any backtick run in the content, not
    // backslash-escaped.
    expect(escapeMarkdownInline('Ev`il__c')).toBe('``Ev`il__c``');
  });

  it('widens the fence past the longest embedded backtick run', () => {
    // The value contains a run of two consecutive backticks, so a
    // two-backtick fence would itself be swallowed as the closer; the fence
    // must be longer than the longest run present (three, here).
    expect(escapeMarkdownInline('a``b')).toBe('```a``b```');
  });

  it('pads with a single space on each side when the value starts with a backtick', () => {
    // Without the padding, the fence and the value's own leading backtick
    // would visually (and per the CommonMark space-stripping rule,
    // structurally) fuse together.
    expect(escapeMarkdownInline('`leading')).toBe('`` `leading ``');
  });

  it('pads with a single space on each side when the value ends with a backtick', () => {
    expect(escapeMarkdownInline('trailing`')).toBe('`` trailing` ``');
  });
});
