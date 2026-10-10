/// <reference types="vitest/globals" />
/**
 * Drift test (KO-c): the org-blocklist loader exists twice — the repo script
 * `scripts/lib/forbidden-names.mjs` (scan-org-leaks + release-guard) and the
 * bundled TS port `src/forbidden-names.ts` (vault anonymize). Both must
 * accept, reject, and split the same inputs identically. Also pins the
 * fail-closed contract: FAIL-BEFORE, a malformed file was silently treated as
 * "no patterns" by all three original copies.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadForbiddenNames, parseForbiddenNames } from '../src/forbidden-names.js';

interface ScriptLoader {
  parseForbiddenNames: (text: string, path?: string) => unknown;
  loadForbiddenNames: (path: string) => { status: string };
  assertBlocklistPresent: (cfg: unknown, opts: { strict: boolean; allowNoBlocklist: boolean }) => void;
}

const scriptUrl = pathToFileURL(join(__dirname, '..', '..', '..', 'scripts', 'lib', 'forbidden-names.mjs')).href;

const INPUTS: readonly string[] = [
  '{}',
  '{"patterns":["A\\\\bcorp"]}',
  '{"scannerPatterns":["x"],"patterns":["y"],"historyTerms":["z"]}',
  '{"patterns":"not-an-array"}',
  '{"patterns":[1]}',
  '{"scannerPatterns":["("]}',
  '{"patterns": [',
  '[]',
  'null',
  '',
];

const outcome = (fn: () => unknown): unknown => {
  try {
    return { ok: fn() };
  } catch {
    return { threw: true };
  }
};

describe('forbidden-names loader parity (script vs bundled port)', () => {
  let script: ScriptLoader;
  beforeAll(async () => {
    script = (await import(scriptUrl)) as ScriptLoader;
  });

  it.each(INPUTS)('agrees on %j', (text) => {
    expect(outcome(() => parseForbiddenNames(text))).toEqual(outcome(() => script.parseForbiddenNames(text)));
  });

  it('rejects malformed JSON instead of returning zero patterns', () => {
    expect(() => parseForbiddenNames('{"patterns": [')).toThrow(/not valid JSON/);
    expect(() => script.parseForbiddenNames('{"patterns": [')).toThrow(/not valid JSON/);
  });

  it('agrees on missing / empty / broken / loaded file status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-fn-parity-'));
    try {
      const cases: Record<string, string | undefined> = {
        missing: undefined,
        empty: '{}',
        broken: '{',
        loaded: '{"patterns":["x"]}',
      };
      for (const [name, body] of Object.entries(cases)) {
        const p = join(dir, `${name}.json`);
        if (body !== undefined) writeFileSync(p, body, 'utf8');
        const ts = loadForbiddenNames(p).status;
        const js = outcome(() => script.loadForbiddenNames(p).status);
        // The script THROWS on a broken file; the port returns status 'broken'.
        expect(ts).toBe(name);
        expect(js).toEqual(name === 'broken' ? { threw: true } : { ok: name });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strict mode refuses a missing blocklist unless explicitly allowed', () => {
    const missing = { status: 'missing', path: '/nope', guardPatterns: [], scannerPatterns: [], historyTerms: [] };
    expect(() => script.assertBlocklistPresent(missing, { strict: true, allowNoBlocklist: false })).toThrow(/VACUOUS/);
    expect(() => script.assertBlocklistPresent(missing, { strict: true, allowNoBlocklist: true })).not.toThrow();
    expect(() => script.assertBlocklistPresent(missing, { strict: false, allowNoBlocklist: false })).not.toThrow();
  });
});
