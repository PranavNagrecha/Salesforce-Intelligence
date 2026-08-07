/// <reference types="vitest/globals" />

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const {
  findDirectInvokeViolations,
  isCoreTool,
  rewriteDirectInvokes,
} = await import(
  pathToFileURL(join(repoRoot, 'scripts/lib/skill-gateway.mjs')).href
);

describe('skill gateway contract (Decision 2=C)', () => {
  it('treats run_analysis as core and coverage_report as non-core', () => {
    expect(isCoreTool('sfi.run_analysis')).toBe(true);
    expect(isCoreTool('sfi.coverage_report')).toBe(false);
  });

  it('flags direct Call/Fire of non-core tools', () => {
    const md = '### Step 2 — Call `sfi.coverage_report`\n\nFire `sfi.last_modified`.';
    const hits = findDirectInvokeViolations(md);
    expect(hits.map((h: { tool: string }) => h.tool).sort()).toEqual([
      'sfi.coverage_report',
      'sfi.last_modified',
    ]);
  });

  it('allows core Call lines and run_analysis-wrapped lines', () => {
    const md = [
      'Call `sfi.resolve` first.',
      'Call `sfi.run_analysis` with `{ "name": "sfi.coverage_report", "args": {} }`.',
    ].join('\n');
    expect(findDirectInvokeViolations(md)).toEqual([]);
  });

  it('rewrites Call/Fire lines to the gateway form', () => {
    const out = rewriteDirectInvokes(
      'Call `sfi.why_cant_user_see_record` with the user id.\nFire `sfi.health_check`.',
    );
    expect(out).toContain('sfi.run_analysis');
    expect(out).toContain('"name": "sfi.why_cant_user_see_record"');
    expect(out).toContain('Fire `sfi.health_check`');
    expect(findDirectInvokeViolations(out)).toEqual([]);
  });
});
