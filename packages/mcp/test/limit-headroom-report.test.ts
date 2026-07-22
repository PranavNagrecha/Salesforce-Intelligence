/// <reference types="vitest/globals" />

/**
 * Unit tests for the PURE core of `sfi.limit_headroom_report`.
 *
 * Every input here is a SYNTHETIC `HeadroomInput` — no vault, no DuckDB, no org
 * identifiers (only generic `Account` / `Contact` / placeholder names). The core
 * (`buildHeadroomRows` / `rankWorstFirst` / `scoreHeadroomRow` / `resolveLimit`)
 * is exercised directly, which is the whole point of factoring it out of the
 * handler: the cap-table math + ranking + edition-assumption labeling is testable
 * without any I/O.
 *
 * Coverage:
 *   - a near-cap object ranks WORST-first;
 *   - headroom% math is exact;
 *   - an edition-dependent row is labeled `assumed-edition` + `editionAssumed`
 *     when the caller passes no edition (and NOT assumed when they do);
 *   - a family with 0 retrieved coverage is DISCLOSED (`consumedIsFloor`), not
 *     asserted as a real "0 consumed";
 *   - the cap table exposes only GENERAL Salesforce limits (no org identifiers).
 */

import {
  buildHeadroomRows,
  capFor,
  DEFAULT_ASSUMED_EDITION,
  packToByteBudget,
  rankWorstFirst,
  resolveLimit,
  SALESFORCE_LIMITS,
  scoreHeadroomRow,
  worstHeadroomOf,
  type HeadroomInput,
} from '../src/tools/limit-headroom-report.js';

describe('limit_headroom_report pure core', () => {
  it('computes exact headroom% for a general (non-edition) cap', () => {
    // validationRules cap is general = 100. 90 consumed → 10% headroom.
    const row = scoreHeadroomRow(
      { scope: 'object', metric: 'validationRules', subject: 'Account', consumed: 90 },
      undefined,
    );
    expect(row).toBeDefined();
    expect(row?.limit).toBe(100);
    expect(row?.headroomPct).toBe(10);
    expect(row?.remaining).toBe(10);
    expect(row?.overLimit).toBe(false);
    expect(row?.limitBasis).toBe('general');
    expect(row?.editionApplied).toBeNull();
    expect(row?.editionAssumed).toBe(false);
  });

  it('ranks a near-cap object row WORST-first', () => {
    // Enterprise custom-field cap = 800.
    const inputs: HeadroomInput[] = [
      // Account: 790/800 → 1.25% headroom (tightest).
      { scope: 'object', metric: 'customFields', subject: 'Account', consumed: 790 },
      // Contact: 100/800 → 87.5% headroom.
      { scope: 'object', metric: 'customFields', subject: 'Contact', consumed: 100 },
      // Order: 400/800 → 50% headroom.
      { scope: 'object', metric: 'customFields', subject: 'Order', consumed: 400 },
    ];
    const ranked = rankWorstFirst(buildHeadroomRows(inputs, 'enterprise'));
    expect(ranked.map((r) => r.subject)).toEqual(['Account', 'Order', 'Contact']);
    expect(ranked[0]?.headroomPct).toBe(1.3); // 10/800 = 1.25 → round1 = 1.3
  });

  it('flags an over-limit row and sorts it first (negative headroom)', () => {
    const inputs: HeadroomInput[] = [
      { scope: 'object', metric: 'validationRules', subject: 'Account', consumed: 120 }, // over 100
      { scope: 'object', metric: 'validationRules', subject: 'Contact', consumed: 50 },
    ];
    const ranked = rankWorstFirst(buildHeadroomRows(inputs, undefined));
    expect(ranked[0]?.subject).toBe('Account');
    expect(ranked[0]?.overLimit).toBe(true);
    expect(ranked[0]?.headroomPct).toBe(-20); // (100-120)/100*100
    expect(ranked[0]?.remaining).toBe(-20);
  });

  it('labels an edition-dependent row as ASSUMED when no edition is given', () => {
    const row = scoreHeadroomRow(
      { scope: 'object', metric: 'customFields', subject: 'Account', consumed: 10 },
      undefined,
    );
    expect(row?.limitBasis).toBe('assumed-edition');
    expect(row?.editionAssumed).toBe(true);
    expect(row?.editionApplied).toBe(DEFAULT_ASSUMED_EDITION);
    expect(row?.limit).toBe(800); // enterprise default
  });

  it('does NOT mark editionAssumed when the caller supplies an edition', () => {
    const row = scoreHeadroomRow(
      { scope: 'object', metric: 'customFields', subject: 'Account', consumed: 10 },
      'unlimited',
    );
    expect(row?.limitBasis).toBe('assumed-edition');
    expect(row?.editionAssumed).toBe(false);
    expect(row?.editionApplied).toBe('unlimited');
    expect(row?.limit).toBe(900); // unlimited edition
  });

  it('resolves an unlimited edition cap to null limit / null headroom (ranks last)', () => {
    // customTabs is unlimited for the `unlimited` edition.
    const resolved = resolveLimit(capFor('org', 'customTabs')!, 'unlimited');
    expect(resolved.limit).toBeNull();
    const rows = buildHeadroomRows(
      [
        { scope: 'org', metric: 'customTabs', subject: 'org', consumed: 999 },
        { scope: 'org', metric: 'customObjects', subject: 'org', consumed: 199 }, // 0.5% headroom
      ],
      'unlimited',
    );
    const ranked = rankWorstFirst(rows);
    // The numeric-headroom row sorts before the unlimited (null) one.
    expect(ranked[0]?.metric).toBe('customObjects');
    expect(ranked[1]?.metric).toBe('customTabs');
    expect(ranked[1]?.headroomPct).toBeNull();
  });

  it('DISCLOSES a zero-coverage family as a floor, not an asserted 0', () => {
    // A family the refresh did not retrieve reads as 0 consumed — the handler
    // marks it `consumedIsFloor`. The core must pass the flag through so a 0 is
    // never presented as a proven "none".
    const floorRow = scoreHeadroomRow(
      {
        scope: 'object',
        metric: 'recordTypes',
        subject: 'Account',
        consumed: 0,
        consumedIsFloor: true,
      },
      undefined,
    );
    expect(floorRow?.consumed).toBe(0);
    expect(floorRow?.consumedIsFloor).toBe(true);
    expect(floorRow?.headroomPct).toBe(100); // looks empty…
    // …but the floor flag is what stops "100% headroom" from being read as fact.

    const realRow = scoreHeadroomRow(
      { scope: 'object', metric: 'recordTypes', subject: 'Account', consumed: 0 },
      undefined,
    );
    expect(realRow?.consumedIsFloor).toBe(false);
  });

  it('marks field consumption as approximate when the input says so', () => {
    const row = scoreHeadroomRow(
      {
        scope: 'object',
        metric: 'customFields',
        subject: 'Account',
        consumed: 12,
        consumedIsApproximate: true,
        detail: { geolocationFields: 2, namespacedExcluded: 5 },
      },
      'enterprise',
    );
    expect(row?.consumedIsApproximate).toBe(true);
    expect(row?.detail?.['namespacedExcluded']).toBe(5);
  });

  it('drops unmodeled metrics rather than fabricating a limit', () => {
    const rows = buildHeadroomRows(
      [{ scope: 'object', metric: 'notARealMetric', subject: 'Account', consumed: 5 }],
      undefined,
    );
    expect(rows).toEqual([]);
  });

  it('worstHeadroomOf ignores unlimited rows and returns the tightest', () => {
    // enterprise: customObjects cap 200 → 150/200 = 25% headroom (numeric);
    // customApps cap 25 → 5/25 = 80% headroom; neither is unlimited here.
    const enterpriseRows = buildHeadroomRows(
      [
        { scope: 'org', metric: 'customApps', subject: 'org', consumed: 5 }, // 80%
        { scope: 'org', metric: 'customObjects', subject: 'org', consumed: 150 }, // 25%
      ],
      'enterprise',
    );
    expect(worstHeadroomOf(enterpriseRows)).toBe(25);

    // unlimited edition: customTabs → null (unlimited, ignored); customObjects
    // cap 2000 → 150/2000 = 92.5% is the only numeric row.
    const unlimitedRows = buildHeadroomRows(
      [
        { scope: 'org', metric: 'customTabs', subject: 'org', consumed: 5 }, // null → ignored
        { scope: 'org', metric: 'customObjects', subject: 'org', consumed: 150 }, // 92.5%
      ],
      'unlimited',
    );
    expect(worstHeadroomOf(unlimitedRows)).toBe(92.5);
  });

  it('packToByteBudget: cursor equals SERVED count on a budget-trimmed page (no silent drop)', () => {
    // 50 items, each 1000 bytes; requested limit 100 but the budget only fits 3.
    const items = Array.from({ length: 50 }, (_, i) => ({ i }));
    const sizeOf = (): number => 1000;
    const res = packToByteBudget(items, 0, 100, 3500, sizeOf);
    expect(res.page.length).toBe(3); // 3*1000=3000 ≤ 3500; a 4th (4000) would exceed
    expect(res.nextOffset).toBe(0 + res.page.length); // THE invariant: cursor == served
    expect(res.truncated).toBe(true);
    expect(res.byteTrimmed).toBe(true); // trimmed below the requested limit for bytes
  });

  it('packToByteBudget: a full cursor walk reaches EVERY item with no skip', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ i }));
    const sizeOf = (): number => 1000;
    const seen: number[] = [];
    let offset = 0;
    for (let guard = 0; guard < 1000; guard += 1) {
      const p = packToByteBudget(items, offset, 100, 3500, sizeOf);
      // The cursor NEVER overstates the advance.
      expect(p.nextOffset).toBe(offset + p.page.length);
      for (const it of p.page) seen.push(it.i);
      if (!p.truncated) break;
      offset = p.nextOffset;
    }
    // Every rank 0..49 reached exactly once, in order — no silent drop.
    expect(seen).toEqual(items.map((x) => x.i));
  });

  it('packToByteBudget: forward progress — a single over-budget item is still served (cursor +1)', () => {
    const items = [{ big: 'x' }, { big: 'y' }];
    const res = packToByteBudget(items, 0, 100, 10, (): number => 5000);
    expect(res.page.length).toBe(1); // one item shipped despite exceeding the budget
    expect(res.nextOffset).toBe(1); // cursor advances by exactly one — never empty-with-cursor
    expect(res.truncated).toBe(true);
    expect(res.byteTrimmed).toBe(true);
  });

  it('packToByteBudget: an offset at/after the end is an empty page, nextOffset == offset, not truncated', () => {
    const items = [{ a: 1 }, { a: 2 }];
    const res = packToByteBudget(items, 2, 100, 10_000, (): number => 100);
    expect(res.page.length).toBe(0);
    expect(res.nextOffset).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.byteTrimmed).toBe(false);
  });

  it('packToByteBudget: a whole-fit page is not flagged truncated/byteTrimmed', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ i }));
    const res = packToByteBudget(items, 0, 100, 1_000_000, (): number => 100);
    expect(res.page.length).toBe(5);
    expect(res.nextOffset).toBe(5);
    expect(res.truncated).toBe(false);
    expect(res.byteTrimmed).toBe(false);
  });

  it('cap table carries GENERAL Salesforce limits with source notes and no org identifiers', () => {
    expect(SALESFORCE_LIMITS.length).toBeGreaterThanOrEqual(8);
    for (const cap of SALESFORCE_LIMITS) {
      expect(cap.sourceNote.toLowerCase()).toContain('general salesforce');
      if (cap.basis === 'assumed-edition') {
        expect(cap.editionLimits).toBeDefined();
      } else {
        // generalLimit may be a number or null (unlimited), but the key exists.
        expect(Object.prototype.hasOwnProperty.call(cap, 'generalLimit')).toBe(true);
      }
    }
  });
});
