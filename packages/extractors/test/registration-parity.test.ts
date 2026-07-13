/// <reference types="vitest/globals" />

/**
 * Registration-parity invariant for metadata extractors.
 *
 * The recurring bug this guards against: an extractor is fully built —
 * and sometimes fully tested — but never wired into the refresh
 * pipeline's dispatch table (`EXTRACTORS` in
 * `packages/cli/src/refresh-pipeline.ts`), so it never runs during a
 * real refresh and its output never reaches the graph. The SamlSsoConfig
 * extractor shipped exactly this way before being wired in (see the
 * `SamlSsoConfig: extractSamlSsoConfig` entry and the "R6-01" comment
 * a few lines below it in refresh-pipeline.ts).
 *
 * This test enumerates every `extract<Type>`-shaped named export from
 * the extractors package barrel (`packages/extractors/src/index.ts`)
 * and asserts each one is referenced as a VALUE inside the `EXTRACTORS`
 * dispatch map in `refresh-pipeline.ts` — unless it is listed in
 * `KNOWN_UNREGISTERED_EXTRACTORS`, a deliberate, reviewed exception
 * ledger (e.g. a shared helper composed *by* other extractors rather
 * than a standalone per-metadata-type dispatcher) rather than a silent
 * gap.
 *
 * Detection is textual but statement-scoped: barrel export blocks are
 * parsed with `[^{}]*` so a match can't run past its own closing brace
 * into a later export statement, and the `EXTRACTORS` map body is
 * isolated by brace-counting from its declaration so the "is it
 * dispatched" check only looks inside the map itself, not anywhere else
 * in the (1000+ line) pipeline file.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const BARREL_PATH = join(PACKAGE_ROOT, 'src', 'index.ts');
const PIPELINE_PATH = join(
  REPO_ROOT,
  'packages',
  'cli',
  'src',
  'refresh-pipeline.ts',
);

/**
 * Extractors that are exported from the package barrel but are
 * deliberately NOT dispatched from the `EXTRACTORS` map — because they
 * are internal building blocks composed *by* other extractors, not
 * standalone per-metadata-type extractors themselves. Each entry names
 * the exact export symbol and explains why it is exempt.
 */
const KNOWN_INTERNAL_HELPER_EXTRACTORS: ReadonlySet<string> = new Set([
  // Shared condition-parsing helper consumed directly by seven other
  // extractors (workflow-rule, validation-rule, approval-process,
  // assignment-rule, auto-response-rule, escalation-rule, flow) — it has
  // no metadata type of its own to dispatch on. See
  // packages/extractors/test/condition-extractor.test.ts.
  'extractConditions',
]);

/**
 * Fully built extractors that are deliberately not wired into the
 * `EXTRACTORS` dispatch map yet. Each entry is a conscious, tracked
 * exception — not an accident.
 */
const KNOWN_UNREGISTERED_EXTRACTORS: ReadonlySet<string> = new Set([
  'extractCpqCustomMetadataRecord', // CTO ledger W-1/W-2 — scheduled for wiring or deletion
  'extractCpqCustomSettingRecord', // CTO ledger W-1/W-2 — scheduled for wiring or deletion
]);

/** Every `extract<Type>`-shaped named export from the extractors barrel. */
const barrelExtractorExports = (barrelSource: string): readonly string[] => {
  const names: string[] = [];
  const exportBlockRe = /export\s*\{([^{}]*)\}\s*from\s*'\.\/[^']+\.js';/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- standard exec-loop idiom
  while ((m = exportBlockRe.exec(barrelSource))) {
    for (const raw of (m[1] ?? '').split(',')) {
      const spec = raw.trim();
      if (!spec) continue;
      const aliasParts = spec.split(' as ');
      const finalName = (
        aliasParts.length > 1 ? aliasParts[aliasParts.length - 1] : spec
      )?.trim();
      if (finalName && /^extract[A-Z]/.test(finalName)) names.push(finalName);
    }
  }
  return names;
};

/**
 * The body of the `EXTRACTORS` dispatch map in refresh-pipeline.ts,
 * isolated by brace-counting from its declaration to its matching
 * close.
 */
const extractorsMapBody = (pipelineSource: string): string => {
  const marker =
    'const EXTRACTORS: Readonly<Record<SupportedType, Extractor>> = {';
  const start = pipelineSource.indexOf(marker);
  if (start === -1) {
    throw new Error(
      'registration-parity: could not locate the `EXTRACTORS` map ' +
        'declaration in refresh-pipeline.ts — the dispatch shape changed, ' +
        'update this test',
    );
  }
  let depth = 0;
  let i = start + marker.length - 1; // position at the opening brace
  for (; i < pipelineSource.length; i++) {
    const ch = pipelineSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(
      'registration-parity: unbalanced braces while isolating the ' +
        'EXTRACTORS map body',
    );
  }
  return pipelineSource.slice(start, i + 1);
};

/** Is `fnName` used as a value (`Key: fnName`) inside the EXTRACTORS map body? */
const isDispatchedAsValue = (mapBody: string, fnName: string): boolean =>
  new RegExp(`:\\s*${fnName}\\s*[,\\n}]`).test(mapBody);

describe('registration parity — metadata extractors', () => {
  const barrelSource = readFileSync(BARREL_PATH, 'utf8');
  const pipelineSource = readFileSync(PIPELINE_PATH, 'utf8');
  const mapBody = extractorsMapBody(pipelineSource);
  const extractorNames = barrelExtractorExports(barrelSource);

  it('scans a non-trivial number of extractXxx exports (sanity guard against a silently-empty glob)', () => {
    expect(extractorNames.length).toBeGreaterThan(50);
  });

  it.each(extractorNames)(
    '%s is dispatched from the EXTRACTORS map, or is an explicit KNOWN_UNREGISTERED / internal-helper exception',
    (fnName) => {
      if (KNOWN_INTERNAL_HELPER_EXTRACTORS.has(fnName)) {
        return;
      }
      if (KNOWN_UNREGISTERED_EXTRACTORS.has(fnName)) {
        // A ledger entry that's actually dispatched is stale — prove the
        // ledger doesn't silently rot into a lie.
        expect(
          isDispatchedAsValue(mapBody, fnName),
          `${fnName} is listed in KNOWN_UNREGISTERED_EXTRACTORS but IS ` +
            'dispatched from the EXTRACTORS map — remove the stale ledger entry',
        ).toBe(false);
        return;
      }

      expect(
        isDispatchedAsValue(mapBody, fnName),
        `${fnName} is exported from the extractors barrel but never ` +
          'dispatched from the EXTRACTORS map in refresh-pipeline.ts — wire ' +
          'it in, or add it to KNOWN_UNREGISTERED_EXTRACTORS / ' +
          'KNOWN_INTERNAL_HELPER_EXTRACTORS with a comment explaining why',
      ).toBe(true);
    },
  );

  it('KNOWN_UNREGISTERED_EXTRACTORS has no stale entries (every listed symbol still exists as a barrel export)', () => {
    const allNames = new Set(extractorNames);
    for (const known of KNOWN_UNREGISTERED_EXTRACTORS) {
      expect(
        allNames.has(known),
        `${known} is listed in KNOWN_UNREGISTERED_EXTRACTORS but no longer ` +
          'exists as a barrel export — remove the stale entry',
      ).toBe(true);
    }
  });
});
