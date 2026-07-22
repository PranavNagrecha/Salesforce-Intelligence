/// <reference types="vitest/globals" />

/**
 * Unit tests for the PURE core of `sfi.doc_coverage_report`.
 *
 * Every input here is a SYNTHETIC `DocNodeInput` — no vault, no DuckDB, no org
 * identifiers (only generic `Account` / placeholder `__c` names). The core
 * (`rollupDocCoverage` / `rankGroupsWorstFirst` / `rankImpactByDegree` /
 * `paginateDocCoverage`) is exercised directly, which is the whole point of
 * factoring it out of the handler: the axis math + worst-first ranking + the
 * degree weighting + the "not measurable ≠ undocumented" honesty rule are
 * testable without any I/O.
 *
 * Coverage:
 *   - an object with mostly-undocumented high-degree fields ranks WORST;
 *   - a fully-documented object scores 100%;
 *   - a NOT-MEASURABLE type is EXCLUDED from the gap count (disclosed via
 *     `notMeasurableCount`, never counted as undocumented) — the honesty case;
 *   - standard / managed-package nodes are OUT OF SCOPE, not a gap;
 *   - description and inlineHelpText are DISTINCT axes;
 *   - degree weighting puts a high-degree undocumented field above a low-degree one;
 *   - the cursor equals the served count on a byte-budget-trimmed page.
 */

import {
  paginateDocCoverage,
  rankImpactByDegree,
  rollupDocCoverage,
  type DocNodeInput,
  type GroupDocCoverage,
  type ImpactComponent,
} from '../src/tools/doc-coverage-report.js';

/** Build a CUSTOM FIELD input with defaults; override any axis/degree. */
const field = (
  over: Partial<DocNodeInput> & Pick<DocNodeInput, 'componentId' | 'group'>,
): DocNodeInput => ({
  apiName: over.componentId.split('.').pop() ?? over.componentId,
  type: 'CustomField',
  degree: 0,
  orgOwned: true,
  descriptionMeasurable: true,
  hasDescription: false,
  helpTextMeasurable: true,
  hasHelpText: false,
  ...over,
});

/** Build a CUSTOM OBJECT input (measurable for description, NOT for help text). */
const object = (
  over: Partial<DocNodeInput> & Pick<DocNodeInput, 'componentId' | 'group'>,
): DocNodeInput => ({
  apiName: over.group,
  type: 'CustomObject',
  degree: 0,
  orgOwned: true,
  descriptionMeasurable: true,
  hasDescription: false,
  helpTextMeasurable: false,
  hasHelpText: false,
  ...over,
});

describe('doc_coverage_report pure core', () => {
  it('ranks a mostly-undocumented high-degree object WORST and a fully-documented one 100%', () => {
    const inputs: DocNodeInput[] = [
      // ObjWorst__c — 1 documented field, 2 undocumented HIGH-degree fields.
      field({ componentId: 'CustomField:ObjWorst__c.A__c', group: 'ObjWorst__c', degree: 20, hasDescription: true, hasHelpText: true }),
      field({ componentId: 'CustomField:ObjWorst__c.B__c', group: 'ObjWorst__c', degree: 30 }),
      field({ componentId: 'CustomField:ObjWorst__c.C__c', group: 'ObjWorst__c', degree: 40 }),
      // ObjBest__c — object + 2 fields, all documented on every measurable axis.
      object({ componentId: 'CustomObject:ObjBest__c', group: 'ObjBest__c', hasDescription: true, degree: 5 }),
      field({ componentId: 'CustomField:ObjBest__c.X__c', group: 'ObjBest__c', hasDescription: true, hasHelpText: true }),
      field({ componentId: 'CustomField:ObjBest__c.Y__c', group: 'ObjBest__c', hasDescription: true, hasHelpText: true }),
    ];

    const rollup = rollupDocCoverage(inputs);
    const worst = rollup.groups[0];
    const best = rollup.groups[rollup.groups.length - 1];

    expect(worst?.group).toBe('ObjWorst__c');
    // 2 undocumented fields * 2 axes = 4 gaps; 1 field * 2 axes = 2 documented.
    // combined = 2 / 6 = 33.3%.
    expect(worst?.combinedCoveragePct).toBe(33.3);
    // Debt weight = sum of degree over the undocumented members (B + C).
    expect(worst?.undocumentedDegreeWeight).toBe(70);

    expect(best?.group).toBe('ObjBest__c');
    expect(best?.combinedCoveragePct).toBe(100);
    expect(best?.description.coveragePct).toBe(100);
    expect(best?.helpText.coveragePct).toBe(100);
    expect(best?.description.undocumented).toBe(0);
    expect(best?.helpText.undocumented).toBe(0);
    // The object node id is surfaced on its group.
    expect(best?.componentId).toBe('CustomObject:ObjBest__c');
  });

  it('EXCLUDES a not-measurable type from the gap count (disclosed, not counted) — the honesty case', () => {
    const inputs: DocNodeInput[] = [
      // A real, measurable custom field that IS undocumented.
      field({ componentId: 'CustomField:Account.Region__c', group: 'Account', degree: 3 }),
      // A NOT-MEASURABLE node (its extractor captures no description/help text):
      // org-owned, but neither axis is measurable. It must NOT read as a gap.
      {
        componentId: 'Layout:Account-Account Layout',
        apiName: 'Account-Account Layout',
        type: 'Layout',
        group: 'Account',
        degree: 99,
        orgOwned: true,
        descriptionMeasurable: false,
        hasDescription: false,
        helpTextMeasurable: false,
        hasHelpText: false,
      },
    ];

    const rollup = rollupDocCoverage(inputs);

    // The not-measurable node is disclosed as excluded, never as undocumented.
    expect(rollup.totals.notMeasurableCount).toBe(1);
    // Only the real field counts toward the gap — the Layout is NOT in it.
    expect(rollup.totals.description.measurable).toBe(1);
    expect(rollup.totals.description.undocumented).toBe(1);
    expect(rollup.totals.helpText.measurable).toBe(1);
    // Despite its degree of 99, the not-measurable node never surfaces as impact.
    expect(rollup.topUndocumented.map((c) => c.componentId)).not.toContain(
      'Layout:Account-Account Layout',
    );
    expect(rollup.topUndocumented.map((c) => c.type)).not.toContain('Layout');
    // The group still exists (its one measurable field), and carries the tally.
    const group = rollup.groups.find((g) => g.group === 'Account');
    expect(group?.notMeasurableCount).toBe(1);
    expect(group?.memberCount).toBe(1);
  });

  it('treats standard / managed-package nodes as OUT OF SCOPE, not a gap', () => {
    const inputs: DocNodeInput[] = [
      // Standard field (org does not own its documentation).
      field({ componentId: 'CustomField:Account.Industry', group: 'Account', apiName: 'Industry', orgOwned: false, degree: 50 }),
      // Managed-package field.
      field({ componentId: 'CustomField:Account.ns__Thing__c', group: 'Account', apiName: 'ns__Thing__c', orgOwned: false, degree: 8 }),
    ];

    const rollup = rollupDocCoverage(inputs);

    expect(rollup.totals.outOfScopeCount).toBe(2);
    expect(rollup.totals.description.measurable).toBe(0);
    expect(rollup.totals.description.undocumented).toBe(0);
    expect(rollup.topUndocumented).toHaveLength(0);
    // A group with zero measurable org-owned members is not ranked.
    expect(rollup.groups).toHaveLength(0);
  });

  it('keeps description and inlineHelpText as DISTINCT axes', () => {
    const inputs: DocNodeInput[] = [
      // Description present, help text MISSING.
      field({ componentId: 'CustomField:Account.A__c', group: 'Account', hasDescription: true, hasHelpText: false, degree: 1 }),
    ];

    const rollup = rollupDocCoverage(inputs);
    const group = rollup.groups[0];

    expect(group?.description.documented).toBe(1);
    expect(group?.description.undocumented).toBe(0);
    expect(group?.helpText.documented).toBe(0);
    expect(group?.helpText.undocumented).toBe(1);
    // The impact entry flags exactly which axis is missing.
    const impact = rollup.topUndocumented[0];
    expect(impact?.missingDescription).toBe(false);
    expect(impact?.missingHelpText).toBe(true);
  });

  it('degree-weights the highest-impact list: a high-degree undocumented field outranks a low-degree one', () => {
    const inputs: DocNodeInput[] = [
      field({ componentId: 'CustomField:Account.Low__c', group: 'Account', degree: 2 }),
      field({ componentId: 'CustomField:Account.High__c', group: 'Account', degree: 40 }),
      field({ componentId: 'CustomField:Account.Mid__c', group: 'Account', degree: 15 }),
    ];

    const rollup = rollupDocCoverage(inputs);
    expect(rollup.topUndocumented.map((c) => c.apiName)).toEqual([
      'High__c',
      'Mid__c',
      'Low__c',
    ]);
    expect(rollup.topUndocumented[0]?.degree).toBe(40);
  });

  it('rankImpactByDegree is a deterministic total order (degree desc, id asc tiebreak)', () => {
    const impact: ImpactComponent[] = [
      { componentId: 'CustomField:Account.B__c', apiName: 'B__c', type: 'CustomField', group: 'Account', degree: 5, missingDescription: true, missingHelpText: false },
      { componentId: 'CustomField:Account.A__c', apiName: 'A__c', type: 'CustomField', group: 'Account', degree: 5, missingDescription: true, missingHelpText: false },
      { componentId: 'CustomField:Account.C__c', apiName: 'C__c', type: 'CustomField', group: 'Account', degree: 9, missingDescription: true, missingHelpText: false },
    ];
    // Equal degree (5) breaks by componentId ASC → A before B; C (9) leads.
    expect(rankImpactByDegree(impact).map((c) => c.apiName)).toEqual(['C__c', 'A__c', 'B__c']);
  });

  it('cursor equals the served count on a byte-budget-trimmed page (no silent drop)', () => {
    // Build enough distinct groups that a tiny byte budget must trim the page.
    const groups: GroupDocCoverage[] = Array.from({ length: 12 }, (_, i) => ({
      group: `Obj${String(i).padStart(2, '0')}__c`,
      componentId: `CustomObject:Obj${String(i).padStart(2, '0')}__c`,
      description: { measurable: 3, documented: 0, undocumented: 3, coveragePct: 0 },
      helpText: { measurable: 3, documented: 0, undocumented: 3, coveragePct: 0 },
      combinedCoveragePct: 0,
      undocumentedDegreeWeight: 10 * i,
      memberCount: 3,
      notMeasurableCount: 0,
      outOfScopeCount: 0,
    }));

    // A small budget forces a byte-trimmed page well below `limit`.
    const first = paginateDocCoverage(groups, 0, 100, 400);
    expect(first.byteTrimmed).toBe(true);
    expect(first.truncated).toBe(true);
    // THE INVARIANT: the advertised advance is EXACTLY the served count.
    expect(first.nextOffset).toBe(0 + first.page.length);
    expect(first.page.length).toBeGreaterThan(0);

    // Full cursor walk drops nothing and never skips.
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const pageResult = paginateDocCoverage(groups, offset, 100, 400);
      expect(pageResult.nextOffset).toBe(offset + pageResult.page.length);
      for (const g of pageResult.page) seen.push(g.group);
      offset = pageResult.nextOffset;
      if (!pageResult.truncated) break;
    }
    expect(seen).toEqual(groups.map((g) => g.group));
    expect(new Set(seen).size).toBe(groups.length);
  });
});
