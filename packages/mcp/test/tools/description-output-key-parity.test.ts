/// <reference types="vitest/globals" />

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { V01_TOOLS } from '../../src/tools/roster.js';

/**
 * DESCRIPTION-PROMISES-AN-OUTPUT-KEY-THE-HANDLER-NEVER-EMITS.
 *
 * ## The measured defect
 *
 * Twelve tool descriptions carried the identical sentence
 *
 *     "A scoped call echoes `appliedScope` so the result cannot be read as org-wide."
 *
 * and for TWO of them it was false. `sfi.ai_exposure_report` echoes
 * `scope: { mode, objectApiName }`; `sfi.value_change_audit` echoes the resolved
 * object as the output `object` key. Neither emits `appliedScope` anywhere.
 *
 * That sentence is not decoration — it is an instruction to a host LLM about how
 * to tell a scoped answer from an org-wide one. A host that follows it reads
 * `undefined` and cannot make the distinction, which is the EXACT confusion the
 * sentence claims to prevent. So the description did not merely fail to help; it
 * actively produced the misreading.
 *
 * ## Why a gate rather than two edits
 *
 * The sentence was copy-pasted twelve times. That is this codebase's root cause
 * in one line: a promise duplicated by hand, correct in ten places and false in
 * two, with nothing measuring the difference. Fixing the two without this test
 * leaves the thirteenth copy free to be wrong.
 *
 * ## VACUITY RISK — read before editing
 *
 * (a) A tool whose source file cannot be located is an ERROR, never a skip. The
 *     silent-skip is how a gate stops measuring: one unmappable name and the
 *     whole tool drops out of coverage looking exactly like a pass.
 * (b) The corpus size is asserted. A roster import that returned `[]` would
 *     otherwise satisfy every assertion over nothing — the way `scan:leaks`
 *     passed for months without its gitignored config.
 * (c) A key nothing promises proves nothing. `PROMISED_OUTPUT_KEYS` is asserted
 *     to be exercised: if no description mentions a key, that entry is dead and
 *     must be removed rather than left as apparent coverage.
 */
const TOOLS_DIR = fileURLToPath(new URL('../../src/tools/', import.meta.url));

/**
 * Output keys a description may name, which the handler must therefore emit.
 *
 * Deliberately a SHORT list of keys that carry a promise about how to read the
 * answer, not every key in every payload. Add one when a description starts
 * telling a caller to look for something.
 */
const PROMISED_OUTPUT_KEYS = ['appliedScope'] as const;

/**
 * Tools whose handler does not live at the filename their name derives from.
 * Each entry is an ASSERTION that must stay true — an alias resolved to the
 * wrong file would silently check the wrong source.
 */
const ALIAS_SOURCE: ReadonlyMap<string, string> = new Map([
  // Three synthesis reports share one handler module; only this one's name does
  // not match a file. Verified: `automationRiskReport` is exported from
  // synthesis-reports.ts and dispatched at tool-dispatch.ts's
  // `case 'sfi.automation_risk_report'`.
  ['sfi.automation_risk_report', 'synthesis-reports.ts'],
]);

/** `sfi.ai_exposure_report` -> `ai-exposure-report.ts`. */
const sourceFileFor = (toolName: string): string => {
  const alias = ALIAS_SOURCE.get(toolName);
  if (alias !== undefined) return alias;
  return `${toolName.replace(/^sfi\./, '').replace(/_/g, '-')}.ts`;
};

describe('a tool description never promises an output key its handler does not emit', () => {
  const files = new Set(readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts')));

  it('the corpus is real — an empty roster must not pass every assertion over nothing', () => {
    expect(V01_TOOLS.length).toBeGreaterThan(200);
    expect(files.size).toBeGreaterThan(200);
  });

  it('every tool naming a promised key resolves to a handler source that exists', () => {
    const unmappable: string[] = [];
    for (const tool of V01_TOOLS) {
      const description = String(tool.description ?? '');
      if (!PROMISED_OUTPUT_KEYS.some((k) => description.includes(k))) continue;
      const file = sourceFileFor(tool.name);
      if (!files.has(file)) unmappable.push(`${tool.name} -> ${file}`);
    }
    expect(
      unmappable,
      'These tools promise an output key but their handler source could not be located, so the ' +
        'parity check below would silently skip them — which looks identical to a pass. Add an ' +
        'ALIAS_SOURCE entry naming the real file:\n  ' +
        unmappable.join('\n  '),
    ).toEqual([]);
  });

  it('FAIL-BEFORE/PASS-AFTER: no description promises a key its handler never emits', () => {
    const broken: string[] = [];
    for (const tool of V01_TOOLS) {
      const description = String(tool.description ?? '');
      const file = sourceFileFor(tool.name);
      if (!files.has(file)) continue; // already an error above; do not double-report
      const source = readFileSync(TOOLS_DIR + file, 'utf8');
      for (const key of PROMISED_OUTPUT_KEYS) {
        if (description.includes(key) && !source.includes(key)) {
          broken.push(`${tool.name} promises \`${key}\` but ${file} never emits it`);
        }
      }
    }
    expect(
      broken,
      'A description that names an output key is telling a host LLM what to read. When the handler ' +
        'does not emit it the host reads undefined, which is worse than saying nothing — it is the ' +
        'misreading the sentence claimed to prevent:\n  ' +
        broken.join('\n  '),
    ).toEqual([]);
  });

  it('every entry in PROMISED_OUTPUT_KEYS is actually exercised', () => {
    // A key no description mentions is not coverage, it is a dead row that makes
    // the gate look broader than it is.
    for (const key of PROMISED_OUTPUT_KEYS) {
      const promisers = V01_TOOLS.filter((t) => String(t.description ?? '').includes(key));
      expect(
        promisers.length,
        `no tool description mentions \`${key}\` — remove it from PROMISED_OUTPUT_KEYS rather than ` +
          'leaving a row that checks nothing',
      ).toBeGreaterThan(0);
    }
  });
});
