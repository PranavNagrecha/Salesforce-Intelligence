/**
 * INFRA-05 — worker_threads pool for the Apex AST parse stage.
 *
 * Fans pure `extractApexAstEdges` calls across `availableParallelism() - 1`
 * workers (min 1). Results are collected by INPUT index, not completion
 * order, so edge merge + vault output stay byte-stable.
 */
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/** One file to parse. `index` is the dense 0..n-1 slot in the returned array. */
export type ApexAstWorkerJob = {
  readonly index: number;
  readonly source: string;
  readonly apiName: string;
  readonly kind: 'class' | 'trigger';
};

/** Mirrors `@sf-intelligence/parsers` ApexAstEdges (kept local to avoid a hard type dep from the pool). */
export type ApexAstWorkerEdges = {
  readonly calls: readonly string[];
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly parseError?: string;
  readonly innerTypes?: readonly string[];
  readonly callSites?: readonly {
    readonly callee: string;
    readonly callerMethod: string;
  }[];
};

type WorkerResponse = {
  readonly index: number;
  readonly result: ApexAstWorkerEdges;
};

export type ParseApexAstPoolOptions = {
  readonly workerCount?: number;
  readonly workerPath?: string;
  /** Extra `workerData` merged with `knownClasses` (tests use this for delay probes). */
  readonly workerData?: Readonly<Record<string, unknown>>;
};

/** Worker count: one below available parallelism, floored at 1. */
export const apexAstWorkerCount = (): number =>
  Math.max(1, availableParallelism() - 1);

/**
 * Resolve the worker entry: published sibling of `dist/index.js`, else the
 * monorepo `workers/apex-ast-worker.mjs` used by vitest.
 */
export const resolveApexAstWorkerPath = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'apex-ast-worker.js'),
    join(here, '../workers/apex-ast-worker.mjs'),
    join(here, '../../workers/apex-ast-worker.mjs'),
    join(here, '../dist/apex-ast-worker.js'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    `INFRA-05: apex-ast worker not found (tried: ${candidates.join(', ')})`,
  );
};

/**
 * Parse Apex sources across a worker_threads pool.
 * Returned array is indexed by each job's `index` (input order).
 */
export const parseApexAstInPool = async (
  jobs: readonly ApexAstWorkerJob[],
  knownClasses: ReadonlySet<string>,
  options: ParseApexAstPoolOptions = {},
): Promise<readonly ApexAstWorkerEdges[]> => {
  if (jobs.length === 0) return [];

  const workerPath = options.workerPath ?? resolveApexAstWorkerPath();
  const workerCount = Math.max(
    1,
    Math.min(options.workerCount ?? apexAstWorkerCount(), jobs.length),
  );

  const results: ApexAstWorkerEdges[] = new Array(jobs.length);
  let nextJob = 0;
  let completed = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let draining = false;
    const workers: Worker[] = [];

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      for (const w of workers) void w.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const succeed = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const pump = (worker: Worker): void => {
      if (nextJob >= jobs.length) return;
      const job = jobs[nextJob];
      if (job === undefined) return;
      nextJob += 1;
      worker.postMessage({
        index: job.index,
        source: job.source,
        apiName: job.apiName,
        kind: job.kind,
      });
    };

    for (let i = 0; i < workerCount; i += 1) {
      const worker = new Worker(workerPath, {
        // Vitest / tsx put loader flags on process.execArgv; workers inherit
        // them by default and then fail to boot. Keep the worker argv clean.
        execArgv: [],
        workerData: {
          ...(options.workerData ?? {}),
          knownClasses: [...knownClasses],
        },
      });
      workers.push(worker);

      worker.on('message', (msg: WorkerResponse) => {
        if (
          typeof msg?.index !== 'number' ||
          msg.index < 0 ||
          msg.index >= jobs.length ||
          msg.result === undefined
        ) {
          fail(new Error('apex-ast worker returned a malformed message'));
          return;
        }
        results[msg.index] = msg.result;
        completed += 1;
        if (completed === jobs.length) {
          // Mark draining before terminate(): Worker.exit can report code 1
          // during teardown and must not race-fail a successful pool run.
          draining = true;
          Promise.all(workers.map((w) => w.terminate()))
            .then(() => succeed())
            .catch(fail);
          return;
        }
        pump(worker);
      });
      worker.on('error', fail);
      worker.on('exit', (code) => {
        if (settled || draining) return;
        if (code !== 0) {
          fail(new Error(`apex-ast worker exited with code ${code}`));
        }
      });
      pump(worker);
    }
  });

  return results;
};
