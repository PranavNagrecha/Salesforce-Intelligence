/// <reference types="vitest/globals" />

import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { extractApexAstEdges } from '@sf-intelligence/parsers/apex-ast';

import {
  apexAstWorkerCount,
  parseApexAstInPool,
  resolveApexAstWorkerPath,
} from '../src/apex-ast-pool.js';

/**
 * INFRA-05 — AST-only worker pool: order preservation + serial baseline parity.
 */

const orderProbeWorker = fileURLToPath(
  new URL('./fixtures/order-probe-worker.mjs', import.meta.url),
);

describe('apexAstWorkerCount', () => {
  it('is availableParallelism() - 1 floored at 1', () => {
    expect(apexAstWorkerCount()).toBe(Math.max(1, availableParallelism() - 1));
  });
});

describe('resolveApexAstWorkerPath', () => {
  it('resolves a worker entry that exists on disk', () => {
    const path = resolveApexAstWorkerPath();
    expect(path.length).toBeGreaterThan(0);
    expect(path.endsWith('apex-ast-worker.mjs') || path.endsWith('apex-ast-worker.js')).toBe(
      true,
    );
  });
});

describe('parseApexAstInPool order preservation', () => {
  it('returns results in INPUT order even when workers finish reverse-order', async () => {
    const n = 8;
    const jobs = Array.from({ length: n }, (_, index) => ({
      index,
      source: `src-${index}`,
      apiName: `Class${index}`,
      kind: 'class' as const,
    }));
    const results = await parseApexAstInPool(jobs, new Set(), {
      workerCount: 4,
      workerPath: orderProbeWorker,
      workerData: { n },
    });
    expect(results.map((r) => r.calls[0])).toEqual(
      Array.from({ length: n }, (_, i) => `job-${i}`),
    );
  });
});

describe('parseApexAstInPool serial baseline', () => {
  const fixtures = [
    {
      apiName: 'Alpha',
      source: `public class Alpha {
  public void run(Account a) {
    a.Name = 'x';
    String n = a.Industry;
    Beta b = new Beta();
    b.help(n);
  }
}`,
    },
    {
      apiName: 'Beta',
      source: `public class Beta {
  public void help(String s) { System.debug(s); }
}`,
    },
    {
      apiName: 'Gamma',
      source: `public class Gamma {
  public void run() {
    for (Contact c : [SELECT Id, Email FROM Contact WHERE Email != null]) {}
    Alpha a = new Alpha();
    a.run(new Account());
  }
}`,
    },
    {
      apiName: 'Delta',
      source: `public class Delta {
  public void m1() { Beta b = new Beta(); b.help('a'); }
  public void m2() { Beta b = new Beta(); b.help('b'); }
}`,
    },
    {
      apiName: 'Broken',
      source: `public class Broken { this is not valid apex %%% }`,
    },
  ] as const;

  it('matches serial extractApexAstEdges for a multi-file fixture set', async () => {
    const knownClasses = new Set(fixtures.map((f) => f.apiName));
    const jobs = fixtures.map((f, index) => ({
      index,
      source: f.source,
      apiName: f.apiName,
      kind: 'class' as const,
    }));

    const serial = fixtures.map((f) =>
      extractApexAstEdges(f.source, f.apiName, {
        knownClasses,
        kind: 'class',
      }),
    );
    const parallel = await parseApexAstInPool(jobs, knownClasses, {
      workerCount: Math.min(3, fixtures.length),
    });

    expect(parallel).toHaveLength(serial.length);
    for (let i = 0; i < serial.length; i += 1) {
      expect(parallel[i]).toEqual(serial[i]);
    }
    // Sanity: real edges + a parse failure are present in the fixture set.
    expect(serial.some((e) => e.parseError !== undefined)).toBe(true);
    expect(serial.some((e) => e.calls.length > 0 || e.reads.length > 0 || e.writes.length > 0)).toBe(
      true,
    );
  });
});
