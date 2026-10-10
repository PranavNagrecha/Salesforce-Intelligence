/// <reference types="vitest/globals" />

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { DEMAND_REEXTRACT_OPTIONS, describeRunsLive } from '../src/commands/refresh.js';

/**
 * FAIL-BEFORE/PASS-AFTER (second review): the re-extract after a demand
 * retrieve (`sfi watch`, `refresh --components`, the demand-queue drain) ran
 * `runRefresh({ noPull: true })`. WOW-12 made `--no-pull` replay the describe
 * cache only, so a standard object the demand retrieve had JUST brought in —
 * which has no cache entry — lost every describe-only field, on a run that
 * contacts the org anyway. The re-extract now runs the describe live.
 */
describe('demand-retrieve re-extract runs the standard-field describe live', () => {
  it('describeRunsLive: only a pulling refresh or --with-describe is live', () => {
    expect(describeRunsLive({})).toBe(true);
    expect(describeRunsLive({ noPull: true })).toBe(false);
    expect(describeRunsLive({ noPull: true, withDescribe: true })).toBe(true);
  });

  it('the demand re-extract options skip the second pull but describe live', () => {
    expect(DEMAND_REEXTRACT_OPTIONS.noPull).toBe(true);
    expect(describeRunsLive(DEMAND_REEXTRACT_OPTIONS)).toBe(true);
  });

  it('runDemandRetrieve re-extracts with those options, not a bare noPull', async () => {
    const src = await readFile(fileURLToPath(new URL('../src/commands/refresh.ts', import.meta.url)), 'utf8');
    const start = src.indexOf('export const runDemandRetrieve');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n};\n', start));
    const call = body.slice(body.indexOf('runRefresh({'));
    const callArgs = call.slice(0, call.indexOf('});'));
    expect(callArgs).toContain('...DEMAND_REEXTRACT_OPTIONS');
    expect(callArgs).not.toMatch(/noPull:\s*true/);
  });
});
