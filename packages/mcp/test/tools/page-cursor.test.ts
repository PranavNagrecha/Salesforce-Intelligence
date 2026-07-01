/// <reference types="vitest/globals" />

import type { PageCursorToken } from '@sf-intelligence/contracts';

import {
  DEFAULT_PAGE_BYTE_BUDGET,
  DEFAULT_PAGE_LIMIT,
  MAX_CURSOR_RAW_BYTES,
  PAGE_CURSOR_VERSION,
  type ScanTypeCount,
  decodeCursor,
  decodeScanOffset,
  defaultItemSlim,
  encodeCursor,
  encodeScanOffset,
  hasHandlerCursor,
  paginate,
  paginateSection,
  totalScanCount,
} from '../../src/tools/page-cursor.js';

const TOOL = 'sfi.get_edges';
const VAULT = 'sha256-deadbeef';

const baseToken = (over: Partial<PageCursorToken> = {}): PageCursorToken => ({
  v: PAGE_CURSOR_VERSION,
  t: TOOL,
  h: VAULT,
  o: 200,
  ...over,
});

/** Hand-mint a raw base64url token from an arbitrary object (forgery helper). */
const mint = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

describe('encodeCursor / decodeCursor round-trip', () => {
  it('round-trips a minimal token', () => {
    const token = baseToken();
    const raw = encodeCursor(token);
    const decoded = decodeCursor(raw, { tool: TOOL, vaultHash: VAULT });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(token);
  });

  it('round-trips a full token (k, s, q, listId)', () => {
    const token = baseToken({
      o: 500,
      k: 'Edge:42',
      s: 1000,
      q: 'fp-abc',
      listId: 'object',
    });
    const raw = encodeCursor(token);
    const decoded = decodeCursor(raw, {
      tool: TOOL,
      vaultHash: VAULT,
      argsFingerprint: 'fp-abc',
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(token);
  });

  it('produces an opaque base64url blob (no raw JSON braces)', () => {
    const raw = encodeCursor(baseToken());
    expect(raw).not.toContain('{');
    expect(raw).not.toContain('"');
    expect(/^[A-Za-z0-9_-]+$/.test(raw)).toBe(true);
  });
});

describe('decodeCursor hardening', () => {
  it('rejects a non-string / empty raw token', () => {
    for (const bad of [undefined, null, 42, '', {}, []]) {
      const r = decodeCursor(bad, { tool: TOOL, vaultHash: VAULT });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('invalid-query');
    }
  });

  it('rejects an oversized raw token BEFORE parsing (>512 bytes)', () => {
    // A token whose raw length exceeds the cap — even if it would decode fine.
    const huge = baseToken({ k: 'x'.repeat(MAX_CURSOR_RAW_BYTES * 2) });
    const raw = encodeCursor(huge);
    expect(raw.length).toBeGreaterThan(MAX_CURSOR_RAW_BYTES);
    const r = decodeCursor(raw, { tool: TOOL, vaultHash: VAULT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('rejects malformed base64 / non-JSON payloads', () => {
    // base64url of the literal "not json at all"
    const notJson = Buffer.from('not json at all', 'utf8').toString('base64url');
    const r = decodeCursor(notJson, { tool: TOOL, vaultHash: VAULT });
    expect(r.ok).toBe(false);
  });

  it('rejects a JSON array / primitive payload (not a plain object)', () => {
    for (const shape of [[1, 2, 3], 42, 'string', true, null]) {
      const r = decodeCursor(mint(shape), { tool: TOOL, vaultHash: VAULT });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a version mismatch', () => {
    const r = decodeCursor(mint(baseToken({ v: 99 })), {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a negative offset', () => {
    const r = decodeCursor(mint({ ...baseToken(), o: -1 }), {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-integer offset', () => {
    const r = decodeCursor(mint({ ...baseToken(), o: 3.5 }), {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a huge / unsafe offset (> MAX_SAFE_INTEGER)', () => {
    const r = decodeCursor(mint({ ...baseToken(), o: Number.MAX_SAFE_INTEGER + 2 }), {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a NaN / Infinity offset', () => {
    // NaN/Infinity don't survive JSON.stringify (become null) — assert null is rejected.
    const r = decodeCursor(mint({ ...baseToken(), o: null }), {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a negative / non-integer scanOffset (s)', () => {
    for (const s of [-1, 2.5, 'x']) {
      const r = decodeCursor(mint({ ...baseToken(), s }), {
        tool: TOOL,
        vaultHash: VAULT,
      });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a non-string t / h / k / q / listId', () => {
    const fields: (keyof PageCursorToken)[] = ['t', 'h', 'k', 'q', 'listId'];
    for (const field of fields) {
      const r = decodeCursor(mint({ ...baseToken(), [field]: 123 }), {
        tool: TOOL,
        vaultHash: VAULT,
      });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects a forged token minted for tool A replayed at tool B', () => {
    const raw = encodeCursor(baseToken({ t: 'sfi.list_components' }));
    const r = decodeCursor(raw, { tool: 'sfi.get_edges', vaultHash: VAULT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('rejects a token minted against a different vault hash', () => {
    const raw = encodeCursor(baseToken({ h: 'sha256-OLDVAULT' }));
    const r = decodeCursor(raw, { tool: TOOL, vaultHash: 'sha256-NEWVAULT' });
    expect(r.ok).toBe(false);
  });

  it('rejects a fingerprint mismatch (both directions)', () => {
    // Token has fp, call expects a different fp.
    const withFp = encodeCursor(baseToken({ q: 'fp-1' }));
    expect(
      decodeCursor(withFp, { tool: TOOL, vaultHash: VAULT, argsFingerprint: 'fp-2' }).ok,
    ).toBe(false);
    // Token has fp, call expects NO fp.
    expect(decodeCursor(withFp, { tool: TOOL, vaultHash: VAULT }).ok).toBe(false);
    // Token has NO fp, call expects a fp.
    const noFp = encodeCursor(baseToken());
    expect(
      decodeCursor(noFp, { tool: TOOL, vaultHash: VAULT, argsFingerprint: 'fp-1' }).ok,
    ).toBe(false);
  });

  it('accepts a matching fingerprint', () => {
    const raw = encodeCursor(baseToken({ q: 'fp-match' }));
    const r = decodeCursor(raw, {
      tool: TOOL,
      vaultHash: VAULT,
      argsFingerprint: 'fp-match',
    });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// paginate (flat single list)
// ---------------------------------------------------------------------------

interface Row {
  readonly id: string;
  readonly blob: string;
}

const row = (i: number, size = 8): Row => ({
  id: `Edge:${i}`,
  blob: 'x'.repeat(size),
});

const binding = { tool: TOOL, vaultHash: VAULT };

describe('paginate (flat)', () => {
  it('returns the whole list with no cursor when it fits under limit and budget', () => {
    const items = Array.from({ length: 5 }, (_, i) => row(i));
    const r = paginate(items, { binding, limit: DEFAULT_PAGE_LIMIT });
    expect(r.items).toHaveLength(5);
    expect(r.pageInfo.totalCount).toBe(5);
    expect(r.pageInfo.returnedCount).toBe(5);
    expect(r.pageInfo.hasMore).toBe(false);
    expect(r.pageInfo.nextCursor).toBeNull();
    expect(r.byteTrimmed).toBe(false);
  });

  it('emits a cursor when the page is truncated over limit', () => {
    const items = Array.from({ length: 50 }, (_, i) => row(i));
    const r = paginate(items, { binding, limit: 20 });
    expect(r.items).toHaveLength(20);
    expect(r.pageInfo.hasMore).toBe(true);
    expect(r.pageInfo.nextCursor).not.toBeNull();
    const decoded = decodeCursor(r.pageInfo.nextCursor!, {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.o).toBe(20);
  });

  it('resumes from the cursor offset (no dup, no skip)', () => {
    const items = Array.from({ length: 50 }, (_, i) => row(i));
    const first = paginate(items, { binding, limit: 20 });
    const decoded = decodeCursor(first.pageInfo.nextCursor!, {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(decoded.ok).toBe(true);
    const offset = decoded.ok ? decoded.value.o : 0;
    const second = paginate(items, { binding, limit: 20, offset });
    expect(second.items[0]!.id).toBe('Edge:20');
    expect(second.items).toHaveLength(20);
    // Combined the two pages cover 0..39 with no overlap.
    const ids = new Set([...first.items, ...second.items].map((x) => x.id));
    expect(ids.size).toBe(40);
  });

  it('exhausts cleanly: final page has hasMore=false and null cursor', () => {
    const items = Array.from({ length: 30 }, (_, i) => row(i));
    const r = paginate(items, { binding, limit: 20, offset: 20 });
    expect(r.items).toHaveLength(10);
    expect(r.pageInfo.hasMore).toBe(false);
    expect(r.pageInfo.nextCursor).toBeNull();
  });

  it('offset past the end yields an empty exhausted page', () => {
    const items = Array.from({ length: 5 }, (_, i) => row(i));
    const r = paginate(items, { binding, limit: 20, offset: 99 });
    expect(r.items).toHaveLength(0);
    expect(r.pageInfo.hasMore).toBe(false);
    expect(r.pageInfo.nextCursor).toBeNull();
  });

  it('stamps the total-order key (k) onto the cursor when keyOf is given', () => {
    const items = Array.from({ length: 50 }, (_, i) => row(i));
    const r = paginate(items, { binding, limit: 20, keyOf: (x) => x.id });
    const decoded = decodeCursor(r.pageInfo.nextCursor!, { tool: TOOL, vaultHash: VAULT });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.k).toBe('Edge:19');
  });

  it('stamps the fingerprint so a resume can verify it', () => {
    const items = Array.from({ length: 50 }, (_, i) => row(i));
    const r = paginate(items, {
      binding: { ...binding, argsFingerprint: 'fp-x' },
      limit: 20,
    });
    const decoded = decodeCursor(r.pageInfo.nextCursor!, {
      tool: TOOL,
      vaultHash: VAULT,
      argsFingerprint: 'fp-x',
    });
    expect(decoded.ok).toBe(true);
  });

  it('byte-trims a page that fits the limit but overflows the budget', () => {
    // Each row ~2 KB; a 200-limit page would be ~400 KB; tiny budget forces trim.
    const items = Array.from({ length: 200 }, (_, i) => row(i, 2_000));
    const r = paginate(items, { binding, limit: 200, byteBudget: 10_000 });
    expect(r.byteTrimmed).toBe(true);
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.items.length).toBeLessThan(200);
    expect(
      Buffer.byteLength(JSON.stringify(r.items), 'utf8'),
    ).toBeLessThanOrEqual(10_000);
    expect(r.pageInfo.hasMore).toBe(true);
    expect(r.pageInfo.nextCursor).not.toBeNull();
  });
});

describe('paginate forward-progress (a single >budget row)', () => {
  it('a single row exceeding the budget yields a 1-item SLIMMED page, never empty', () => {
    const fat: Row = { id: 'Edge:huge', blob: 'A'.repeat(DEFAULT_PAGE_BYTE_BUDGET * 2) };
    const items = [fat, row(1), row(2)];
    const r = paginate(items, { binding, limit: 200 });
    // Exactly one item kept (the fat one), and slimmed below budget.
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.id).toBe('Edge:huge');
    expect(r.byteTrimmed).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(r.items), 'utf8'),
    ).toBeLessThanOrEqual(DEFAULT_PAGE_BYTE_BUDGET);
    // The slimmed blob carries the trim marker.
    expect(r.items[0]!.blob).toContain('bytes trimmed]');
  });

  it('advances the cursor by 1 so a resume makes progress (no infinite loop)', () => {
    const fat: Row = { id: 'Edge:huge', blob: 'A'.repeat(DEFAULT_PAGE_BYTE_BUDGET * 2) };
    const items = [fat, row(1), row(2)];
    const r = paginate(items, { binding, limit: 200 });
    expect(r.pageInfo.hasMore).toBe(true);
    const decoded = decodeCursor(r.pageInfo.nextCursor!, { tool: TOOL, vaultHash: VAULT });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.o).toBe(1);
    // Resume yields the next rows, terminating.
    const next = paginate(items, { binding, limit: 200, offset: 1 });
    expect(next.items.map((x) => x.id)).toEqual(['Edge:1', 'Edge:2']);
    expect(next.pageInfo.hasMore).toBe(false);
  });

  it('forward progress when the fat row is the LAST remaining row (no skip)', () => {
    const fat: Row = { id: 'Edge:huge', blob: 'A'.repeat(DEFAULT_PAGE_BYTE_BUDGET * 2) };
    const items = [row(0), fat];
    // Page from offset 1 where only the fat row remains.
    const r = paginate(items, { binding, limit: 200, offset: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.id).toBe('Edge:huge');
    expect(r.pageInfo.hasMore).toBe(false);
    expect(r.pageInfo.nextCursor).toBeNull();
  });

  it('a many-long-strings row is progressively slimmed to fit the budget (1-item page <= budget)', () => {
    // 100 fields each a 5 KB string ≈ 500 KB raw. A single 1024-char-keep pass
    // (~100 * 1 KB ≈ 100 KB) would STILL blow a 38 KB budget; progressive
    // keep-length shrink must rescue it.
    const wide: Record<string, unknown> = { id: 'Edge:wide' };
    for (let i = 0; i < 100; i++) wide[`f${i}`] = 'A'.repeat(5_000);
    const items = [wide as unknown as Row, row(1)];
    const r = paginate(items, { binding, limit: 200 });
    expect(r.items).toHaveLength(1);
    expect(r.byteTrimmed).toBe(true);
    expect(r.oversizedRowUnslimmable).toBe(false);
    expect(
      Buffer.byteLength(JSON.stringify(r.items), 'utf8'),
    ).toBeLessThanOrEqual(DEFAULT_PAGE_BYTE_BUDGET);
    // Forward progress still holds.
    expect(r.pageInfo.hasMore).toBe(true);
    expect(r.pageInfo.nextCursor).not.toBeNull();
  });

  it('an unslimmable big NON-string structure ships flagged (oversizedRowUnslimmable), still forward-progressing', () => {
    // A 60k-number array can't be reduced by long-string trimming — the 1-item
    // page will exceed the budget, so the row is shipped FLAGGED for the global
    // guard to convert, but the page is non-empty and the cursor advances by 1.
    const blob = { id: 'Edge:bignum', nums: Array.from({ length: 60_000 }, (_, i) => i) };
    const items = [blob as unknown as Row, row(1)];
    const r = paginate(items, { binding, limit: 200 });
    expect(r.items).toHaveLength(1);
    expect(r.byteTrimmed).toBe(true);
    expect(r.oversizedRowUnslimmable).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(r.items), 'utf8'),
    ).toBeGreaterThan(DEFAULT_PAGE_BYTE_BUDGET);
    // Forward progress: page is non-empty and the cursor advances by exactly 1.
    expect(r.pageInfo.hasMore).toBe(true);
    const decoded = decodeCursor(r.pageInfo.nextCursor!, { tool: TOOL, vaultHash: VAULT });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.o).toBe(1);
  });
});

describe('defaultItemSlim', () => {
  it('trims long strings, leaves short ones, and never mutates the input', () => {
    const input = { id: 'x', long: 'A'.repeat(5_000), short: 'ok', n: 1 };
    const out = defaultItemSlim(input);
    expect(out.short).toBe('ok');
    expect(out.n).toBe(1);
    expect(out.long).toContain('bytes trimmed]');
    expect(out.long.length).toBeLessThan(5_000);
    // original untouched
    expect(input.long.length).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// paginateSection (multi-list / section variant)
// ---------------------------------------------------------------------------

describe('paginateSection (multi-list)', () => {
  const sections = [
    { listId: 'object', items: Array.from({ length: 50 }, (_, i) => row(i)) },
    { listId: 'system', items: Array.from({ length: 7 }, (_, i) => row(100 + i)) },
  ];

  it('pages the designated section and discloses the others honestly', () => {
    const r = paginateSection(sections, 'object', { binding, limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.listId).toBe('object');
    expect(r.value.items).toHaveLength(20);
    expect(r.value.pageInfo.totalCount).toBe(50);
    expect(r.value.otherSections).toEqual([{ listId: 'system', totalCount: 7 }]);
  });

  it('stamps the listId onto the minted cursor', () => {
    const r = paginateSection(sections, 'object', { binding, limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const decoded = decodeCursor(r.value.pageInfo.nextCursor!, {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.listId).toBe('object');
      expect(decoded.value.o).toBe(20);
    }
  });

  it('resumes the SAME section from the cursor listId+offset', () => {
    const first = paginateSection(sections, 'object', { binding, limit: 20 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const decoded = decodeCursor(first.value.pageInfo.nextCursor!, {
      tool: TOOL,
      vaultHash: VAULT,
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const second = paginateSection(sections, decoded.value.listId!, {
      binding,
      limit: 20,
      offset: decoded.value.o,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.items[0]!.id).toBe('Edge:20');
  });

  it('a small designated section exhausts with no cursor while others are disclosed', () => {
    const r = paginateSection(sections, 'system', { binding, limit: 20 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(7);
    expect(r.value.pageInfo.hasMore).toBe(false);
    expect(r.value.pageInfo.nextCursor).toBeNull();
    expect(r.value.otherSections).toEqual([{ listId: 'object', totalCount: 50 }]);
  });

  it('rejects a cursor naming a section that no longer exists', () => {
    const r = paginateSection(sections, 'ghost-section', { binding, limit: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('forward-progress holds inside a section (single >budget row → 1-item page)', () => {
    const fat: Row = { id: 'Edge:huge', blob: 'A'.repeat(DEFAULT_PAGE_BYTE_BUDGET * 2) };
    const withFat = [
      { listId: 'object', items: [fat, row(1)] },
      { listId: 'system', items: [row(100)] },
    ];
    const r = paginateSection(withFat, 'object', { binding, limit: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(1);
    expect(r.value.pageInfo.hasMore).toBe(true);
    expect(r.value.pageInfo.nextCursor).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasHandlerCursor (the jsonResult seam detector)
// ---------------------------------------------------------------------------

describe('hasHandlerCursor', () => {
  it('detects a pageInfo.nextCursor block', () => {
    expect(hasHandlerCursor({ pageInfo: { nextCursor: 'abc', hasMore: true } })).toBe(true);
    expect(hasHandlerCursor({ pageInfo: { nextCursor: null, hasMore: false } })).toBe(true);
  });

  it('detects a bare nextCursor', () => {
    expect(hasHandlerCursor({ nextCursor: 'abc' })).toBe(true);
    expect(hasHandlerCursor({ nextCursor: null })).toBe(true);
  });

  it('returns false for a legacy offset-shaped payload (no cursor)', () => {
    expect(hasHandlerCursor({ edges: [], totalCount: 3, hasMore: true, nextOffset: 2 })).toBe(
      false,
    );
  });

  it('returns false for null / non-object', () => {
    expect(hasHandlerCursor(null)).toBe(false);
    expect(hasHandlerCursor(42)).toBe(false);
    expect(hasHandlerCursor('s')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// multi-type scan-resume encoding (B3 scan axis) — the protocol gate
// ---------------------------------------------------------------------------

describe('decodeScanOffset / encodeScanOffset — multi-type scan resume', () => {
  // Three types: ApexClass=600, ApexTrigger=10, Flow=50 (global span = 660).
  const counts: readonly ScanTypeCount[] = [
    { type: 'ApexClass', count: 600 },
    { type: 'ApexTrigger', count: 10 },
    { type: 'Flow', count: 50 },
  ];

  it('totalScanCount sums every type', () => {
    expect(totalScanCount(counts)).toBe(660);
  });

  it('global offset 0 lands at the first type, offset 0', () => {
    expect(decodeScanOffset(0, counts)).toEqual({
      typeIndex: 0,
      withinTypeOffset: 0,
      complete: false,
    });
  });

  it('decodes an offset inside the first type', () => {
    expect(decodeScanOffset(500, counts)).toEqual({
      typeIndex: 0,
      withinTypeOffset: 500,
      complete: false,
    });
  });

  it('crosses a type boundary cleanly (no dup / no skip)', () => {
    // 600 = exactly the first node of the SECOND type.
    expect(decodeScanOffset(600, counts)).toEqual({
      typeIndex: 1,
      withinTypeOffset: 0,
      complete: false,
    });
    // 605 = the 6th node of the second type.
    expect(decodeScanOffset(605, counts)).toEqual({
      typeIndex: 1,
      withinTypeOffset: 5,
      complete: false,
    });
    // 610 = exactly the first node of the THIRD type.
    expect(decodeScanOffset(610, counts)).toEqual({
      typeIndex: 2,
      withinTypeOffset: 0,
      complete: false,
    });
  });

  it('marks the scan complete at and past the global end', () => {
    expect(decodeScanOffset(660, counts)).toEqual({
      typeIndex: counts.length,
      withinTypeOffset: 0,
      complete: true,
    });
    expect(decodeScanOffset(9999, counts).complete).toBe(true);
  });

  it('encodeScanOffset is the exact inverse of decodeScanOffset', () => {
    for (const g of [0, 1, 599, 600, 609, 610, 659]) {
      const pos = decodeScanOffset(g, counts);
      expect(encodeScanOffset(pos.typeIndex, pos.withinTypeOffset, counts)).toBe(g);
    }
  });

  it('encodeScanOffset of a past-end typeIndex is the grand total', () => {
    expect(encodeScanOffset(counts.length, 0, counts)).toBe(660);
    expect(encodeScanOffset(99, 0, counts)).toBe(660);
  });

  it('round-trips through the cursor token codec (s stays exact)', () => {
    const g = 605;
    const token = encodeCursor({
      v: PAGE_CURSOR_VERSION,
      t: 'sfi.code_quality_audit',
      h: 'sha256:fixture',
      o: 0,
      s: g,
    });
    const decoded = decodeCursor(token, {
      tool: 'sfi.code_quality_audit',
      vaultHash: 'sha256:fixture',
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.s).toBe(g);
    expect(decodeScanOffset(decoded.value.s ?? 0, counts)).toEqual({
      typeIndex: 1,
      withinTypeOffset: 5,
      complete: false,
    });
  });

  it('clamps a negative / non-integer global offset to 0 (defensive)', () => {
    expect(decodeScanOffset(-5, counts).withinTypeOffset).toBe(0);
    expect(decodeScanOffset(3.7, counts).withinTypeOffset).toBe(0);
  });

  it('handles a single-type scan (degenerate multi-type)', () => {
    const single: readonly ScanTypeCount[] = [{ type: 'Profile', count: 800 }];
    expect(decodeScanOffset(500, single)).toEqual({
      typeIndex: 0,
      withinTypeOffset: 500,
      complete: false,
    });
    expect(decodeScanOffset(800, single).complete).toBe(true);
  });

  it('skips an empty type without consuming offset', () => {
    // Middle type has zero nodes — offset 600 must land at the THIRD type.
    const withEmpty: readonly ScanTypeCount[] = [
      { type: 'ApexClass', count: 600 },
      { type: 'ApexTrigger', count: 0 },
      { type: 'Flow', count: 50 },
    ];
    expect(decodeScanOffset(600, withEmpty)).toEqual({
      typeIndex: 2,
      withinTypeOffset: 0,
      complete: false,
    });
  });
});
