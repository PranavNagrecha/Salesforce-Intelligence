/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSfRetrieveObjects,
  runSfRetrieveFolderedReports,
  runSfRetrieveSmartReports,
  runSf,
} from '../src/commands/refresh.js';

/**
 * P1 (InvalidProjectWorkspaceError): the three ON-DEMAND retrieve helpers used
 * to invoke `sf project retrieve start` with NO `cwd`, so `sf` resolved the
 * project from `process.cwd()` (the repo root, which has no `sfdx-project.json`)
 * and failed every on-demand pull with `InvalidProjectWorkspaceError` — silently,
 * since all three are best-effort. The fix runs each from an isolated throwaway
 * project root (its own `sfdx-project.json`) via `cwd`.
 *
 * P2: this file previously also asserted that `--output-dir` STAYS the absolute
 * vault source. That assertion pinned a form modern `sf` refuses outright, so it
 * was encoding the bug rather than guarding against it. Both explicit targets are
 * rejected:
 *   --output-dir <vault>/source        -> OutputDirOutsideProjectError
 *   --output-dir <project>/force-app   -> RetrieveTargetDirOverlapsPackageError
 * The only accepted form — and the one `retrieveTypeBatch` has always used — is
 * to name NO output dir, letting `sf` write into the project's default package
 * directory, after which the helper copies the result into the vault source.
 * Every on-demand pull failed for the entire life of the old assertion; the
 * tests passed because they checked the argv, not whether `sf` accepted it.
 *
 * These tests inject a `runSf` spy and assert, FOR THE RETRIEVE CALL:
 *   - `project retrieve start` is invoked,
 *   - `opts.cwd` is set, is a real directory, and is NOT `process.cwd()`,
 *   - that `cwd` contains an `sfdx-project.json` AT CALL TIME (the helper
 *     rm-rf's it in `finally`, so the assertion must run inside the spy),
 *   - NO `--output-dir` is passed.
 */

type RunSfArgs = Parameters<typeof runSf>;

interface RetrieveProbe {
  readonly sawRetrieve: boolean;
  readonly cwd: string | undefined;
  readonly cwdIsDir: boolean;
  readonly cwdHasProjectJson: boolean;
  readonly cwdIsProcessCwd: boolean;
  readonly outputDir: string | undefined;
}

/**
 * Build a `runSf` spy. SOQL calls (`data query`) return a canned empty result;
 * the retrieve call records its `cwd`/project-root state (read synchronously
 * within the call, before the helper's `finally` deletes the throwaway dir).
 */
const makeSpy = (
  reportRows: Record<string, readonly Record<string, unknown>[]> = {},
): { readonly runSfFn: typeof runSf; readonly probe: RetrieveProbe } => {
  const probe: { -readonly [K in keyof RetrieveProbe]: RetrieveProbe[K] } = {
    sawRetrieve: false,
    cwd: undefined,
    cwdIsDir: false,
    cwdHasProjectJson: false,
    cwdIsProcessCwd: false,
    outputDir: undefined,
  };
  const runSfFn = (async (
    args: RunSfArgs[0],
    options: RunSfArgs[1],
  ): Promise<{ stdout: string; stderr: string }> => {
    const argv = [...args];
    if (argv[0] === 'data' && argv[1] === 'query') {
      // Map the FROM clause to a canned row set so the manifest builder runs.
      const q = argv[argv.indexOf('--query') + 1] ?? '';
      let rows: readonly Record<string, unknown>[] = [];
      if (/FROM Folder/.test(q)) rows = reportRows['Folder'] ?? [];
      else if (/FROM Report/.test(q)) rows = reportRows['Report'] ?? [];
      else if (/FROM Dashboard/.test(q)) rows = reportRows['Dashboard'] ?? [];
      return { stdout: JSON.stringify({ result: { records: rows, totalSize: rows.length } }), stderr: '' };
    }
    if (argv[0] === 'project' && argv[1] === 'retrieve' && argv[2] === 'start') {
      probe.sawRetrieve = true;
      probe.cwd = options.cwd;
      const outIdx = argv.indexOf('--output-dir');
      probe.outputDir = outIdx >= 0 ? argv[outIdx + 1] : undefined;
      if (typeof options.cwd === 'string') {
        probe.cwdIsProcessCwd = options.cwd === process.cwd();
        try {
          probe.cwdIsDir = (await stat(options.cwd)).isDirectory();
        } catch {
          probe.cwdIsDir = false;
        }
        try {
          await readFile(join(options.cwd, 'sfdx-project.json'), 'utf8');
          probe.cwdHasProjectJson = true;
        } catch {
          probe.cwdHasProjectJson = false;
        }
      }
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }) as unknown as typeof runSf;
  return { runSfFn, probe };
};

const assertIsolatedProjectRoot = (probe: RetrieveProbe): void => {
  expect(probe.sawRetrieve).toBe(true);
  expect(probe.cwd).toBeDefined();
  expect(probe.cwdIsProcessCwd).toBe(false);
  expect(probe.cwdIsDir).toBe(true);
  expect(probe.cwdHasProjectJson).toBe(true);
  // No --output-dir at all: `sf` rejects both an outside-the-project target and
  // one overlapping a package dir, so the retrieve must inherit the project's
  // default package directory and be copied into the vault afterwards.
  expect(probe.outputDir).toBeUndefined();
};

/**
 * Seed a real CustomObject source file (recognised by `componentTypeFromSourcePath`
 * → `CustomObject`) representing source for a type the narrow on-demand member
 * subset does NOT name. The relative path is returned so a survival check can
 * re-stat it after the helper runs.
 */
const seedSentinelObjectSource = async (sourceDir: string): Promise<string> => {
  const relPath = join('objects', 'Sentinel__c', 'Sentinel__c.object-meta.xml');
  const abs = join(sourceDir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(
    abs,
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"/>\n',
    'utf8',
  );
  return relPath;
};

/** True iff `relPath` still exists under `sourceDir` (the sentinel survived). */
const sentinelSurvives = async (sourceDir: string, relPath: string): Promise<boolean> => {
  try {
    await stat(join(sourceDir, relPath));
    return true;
  } catch {
    return false;
  }
};

describe('on-demand retrieves run from an isolated project root (P1)', () => {
  it('runSfRetrieveObjects retrieves with cwd = a temp dir holding sfdx-project.json', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-src-obj-'));
    const { runSfFn, probe } = makeSpy();
    try {
      const r = await runSfRetrieveObjects('myorg', sourceDir, ['Foo__c'], runSfFn);
      expect(r.ok).toBe(true);
      assertIsolatedProjectRoot(probe);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('runSfRetrieveFolderedReports retrieves with cwd = a temp dir holding sfdx-project.json', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-src-fr-'));
    const { runSfFn, probe } = makeSpy({
      Folder: [{ Name: 'Sales Reports', DeveloperName: 'Sales_Reports' }],
      Report: [{ DeveloperName: 'Won_Deals', FolderName: 'Sales Reports' }],
      Dashboard: [],
    });
    try {
      const r = await runSfRetrieveFolderedReports('myorg', sourceDir, runSfFn);
      expect(r.ok).toBe(true);
      assertIsolatedProjectRoot(probe);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('runSfRetrieveSmartReports retrieves with cwd = a temp dir holding sfdx-project.json', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-src-sr-'));
    const { runSfFn, probe } = makeSpy({
      Folder: [{ Name: 'Sales Reports', DeveloperName: 'Sales_Reports' }],
      Report: [{ DeveloperName: 'Won_Deals', FolderName: 'Sales Reports' }],
      Dashboard: [],
    });
    try {
      const r = await runSfRetrieveSmartReports('myorg', sourceDir, 100, runSfFn);
      expect(r.ok).toBe(true);
      assertIsolatedProjectRoot(probe);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

/**
 * P1 additivity contract: the three on-demand pulls are narrow member subsets
 * that MUST NOT run `reconcileSourceDeletions` / `syncAuthoritativeRetrieveIntoSource`
 * (unlike `retrieveTypeBatch`). Those two are module-level imports — the cli
 * suite injects via the `runSf` seam rather than `vi.mock`, so additivity is
 * proven BEHAVIOURALLY: seed a `CustomObject` source file for a type the narrow
 * subset never names, run the helper (whose injected `sf` writes nothing new),
 * and assert the sentinel survives.
 *
 * COUNTERFACTUAL: if a helper had mirrored `retrieveTypeBatch` and called
 * `reconcileSourceDeletions(sourceDir, throwawayDir, { CustomObject })`, the
 * sentinel — a `CustomObject` entry absent from the empty throwaway authoritative
 * tree — would be `rm`'d, and `sentinelSurvives` would be false. So this is the
 * additive mechanism, not a stub that passes regardless.
 */
describe('on-demand retrieves are additive — no reconcile/sync of unrelated source (P1)', () => {
  it('runSfRetrieveObjects does not delete source for an object outside its member subset', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-add-obj-'));
    const sentinel = await seedSentinelObjectSource(sourceDir);
    const { runSfFn } = makeSpy();
    try {
      // The narrow subset names only `Foo__c` — never `Sentinel__c`.
      const r = await runSfRetrieveObjects('myorg', sourceDir, ['Foo__c'], runSfFn);
      expect(r.ok).toBe(true);
      expect(await sentinelSurvives(sourceDir, sentinel)).toBe(true);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('runSfRetrieveFolderedReports does not delete unrelated CustomObject source', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-add-fr-'));
    const sentinel = await seedSentinelObjectSource(sourceDir);
    const { runSfFn } = makeSpy({
      Folder: [{ Name: 'Sales Reports', DeveloperName: 'Sales_Reports' }],
      Report: [{ DeveloperName: 'Won_Deals', FolderName: 'Sales Reports' }],
      Dashboard: [],
    });
    try {
      const r = await runSfRetrieveFolderedReports('myorg', sourceDir, runSfFn);
      expect(r.ok).toBe(true);
      expect(await sentinelSurvives(sourceDir, sentinel)).toBe(true);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('runSfRetrieveSmartReports does not delete unrelated CustomObject source', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-add-sr-'));
    const sentinel = await seedSentinelObjectSource(sourceDir);
    const { runSfFn } = makeSpy({
      Folder: [{ Name: 'Sales Reports', DeveloperName: 'Sales_Reports' }],
      Report: [{ DeveloperName: 'Won_Deals', FolderName: 'Sales Reports' }],
      Dashboard: [],
    });
    try {
      const r = await runSfRetrieveSmartReports('myorg', sourceDir, 100, runSfFn);
      expect(r.ok).toBe(true);
      expect(await sentinelSurvives(sourceDir, sentinel)).toBe(true);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

/**
 * Best-effort / non-fatal contract: a retrieve failure inside an on-demand pull
 * is captured (returned as an `err` Result), never thrown — so the caller can
 * log-and-continue. Inject an `sf` that throws on `project retrieve start`.
 */
describe('on-demand retrieves swallow retrieve failures (best-effort)', () => {
  const throwingRetrieveSpy = (
    reportRows: Record<string, readonly Record<string, unknown>[]> = {},
  ): typeof runSf =>
    (async (args: RunSfArgs[0]): Promise<{ stdout: string; stderr: string }> => {
      const argv = [...args];
      if (argv[0] === 'data' && argv[1] === 'query') {
        const q = argv[argv.indexOf('--query') + 1] ?? '';
        let rows: readonly Record<string, unknown>[] = [];
        if (/FROM Folder/.test(q)) rows = reportRows['Folder'] ?? [];
        else if (/FROM Report/.test(q)) rows = reportRows['Report'] ?? [];
        else if (/FROM Dashboard/.test(q)) rows = reportRows['Dashboard'] ?? [];
        return { stdout: JSON.stringify({ result: { records: rows, totalSize: rows.length } }), stderr: '' };
      }
      if (argv[0] === 'project' && argv[1] === 'retrieve' && argv[2] === 'start') {
        throw new Error('InvalidProjectWorkspaceError: simulated');
      }
      return { stdout: '', stderr: '' };
    }) as unknown as typeof runSf;

  it('runSfRetrieveObjects returns err (not throw) when the retrieve fails', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-err-obj-'));
    try {
      const r = await runSfRetrieveObjects('myorg', sourceDir, ['Foo__c'], throwingRetrieveSpy());
      expect(r.ok).toBe(false);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('runSfRetrieveFolderedReports returns err (not throw) when the retrieve fails', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'sfi-err-fr-'));
    try {
      const r = await runSfRetrieveFolderedReports(
        'myorg',
        sourceDir,
        throwingRetrieveSpy({
          Folder: [{ Name: 'Sales Reports', DeveloperName: 'Sales_Reports' }],
          Report: [{ DeveloperName: 'Won_Deals', FolderName: 'Sales Reports' }],
          Dashboard: [],
        }),
      );
      expect(r.ok).toBe(false);
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});
