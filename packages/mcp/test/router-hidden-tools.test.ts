/// <reference types="vitest/globals" />

import { allRoutableTools, classifyQuestion } from '../src/intent-router.js';
import { V01_TOOLS } from '../src/tools/roster.js';

/**
 * CH-5 — FAIL-BEFORE/PASS-AFTER: four intents still named retired HIDDEN alias
 * tools (cdc_subscribers, field_cleanup_candidates, churn, find_apex_usages),
 * which are absent from tools/list and not invocable under the core profile,
 * so the router's own plan pointed hosts at calls that fail. The router must
 * only ever name advertised tools.
 */
describe('router names only advertised (non-hidden) tools (CH-5)', () => {
  const hidden = new Set(V01_TOOLS.filter((t) => t.hidden === true).map((t) => t.name));

  it('no rule lists a hidden tool', () => {
    expect(allRoutableTools().filter((t) => hidden.has(t))).toEqual([]);
  });

  it('the four repointed intents name their survivors', () => {
    expect(classifyQuestion('which fields can we safely delete').tools).toEqual([
      'sfi.unused_fields_deep',
    ]);
    expect(classifyQuestion('show me the metadata churn digest').tools).toContain(
      'sfi.diff_snapshots',
    );
    expect(
      classifyQuestion('where is AccountService used in other apex code').tools,
    ).toContain('sfi.find_code_usages');
  });
});
