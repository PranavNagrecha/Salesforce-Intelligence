/// <reference types="vitest/globals" />

/**
 * COVERSTEST-DECLARED-BUT-NEVER-PRODUCED — the declared-but-never-populated
 * tripwire.
 *
 * `coversTest` is a first-class member of `EdgeType` / `EDGE_TYPES`, is walked
 * by `sfi.what_if_change_method_signature`, and is exercised by that tool's
 * synthetic-fixture tests — yet NO extractor, graph-build mint, or Tooling-API
 * enricher in this product emits it. The consequence is the nastiest shape a
 * gap can take: the tests are green on hand-built fixtures while the tool
 * returns an empty walk on every real vault, and an empty
 * `testClassesNeedingUpdate` reads to a host as "no tests cover this class"
 * rather than "coverage mapping unavailable".
 *
 * The type is deliberately NOT deleted (that would silently drop a modeled
 * concept), so the honest contract is: keep it, and DISCLOSE that it is not
 * populated. This file is what stops that arrangement from rotting, in BOTH
 * directions:
 *
 *   - if someone lands a `coversTest` producer, `UNPRODUCED_EDGE_TYPES` no
 *     longer matches the scan and this fails — go delete the now-false
 *     disclosure;
 *   - if some OTHER edge type loses its last producer, this fails too — go add
 *     it to the list and disclose it at its consumers.
 *
 * The scan is a source-text scan on purpose. Emission sites are what matter,
 * and they are uniformly written as an `edgeType: '<Type>'` object literal, so
 * a producing package is exactly a package whose source contains one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EDGE_TYPES, UNPRODUCED_EDGE_TYPES } from '@sf-intelligence/contracts';
import { describe, expect, it } from 'vitest';

import { V01_TOOLS } from '../../src/tools/index.js';

/** packages/mcp/test/tools -> the repo's packages/ directory. */
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The packages that can PRODUCE graph edges: the offline extractors, the
 * graph-build layer that mints derived edges at import time, the opt-in
 * Tooling-API enricher, and the CLI refresh pipeline that drives them.
 * `mcp` is excluded — it is the read layer, and counting its consumer-side
 * `edgeType:` query filters as production is exactly the mistake that let this
 * gap hide.
 */
const PRODUCER_PACKAGES = [
  'extractors',
  'graph',
  'tooling-api',
  'cli',
  'patterns',
  'vault',
  'core',
] as const;

const collectSources = (dir: string, out: string[]): string[] => {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(readFileSync(full, 'utf8'));
    }
  }
  return out;
};

const producerSources = PRODUCER_PACKAGES.flatMap((pkg) =>
  collectSources(join(packagesDir, pkg, 'src'), []),
);

const producerCountFor = (edgeType: string): number =>
  producerSources.filter((src) => src.includes(`edgeType: '${edgeType}'`)).length;

describe('every declared EdgeType has a producer, or is disclosed as having none', () => {
  it('the scan actually found producer sources (guards a silently-empty scan)', () => {
    // Without this, a broken path would make every type look unproduced AND
    // make the assertions below vacuous in the other direction.
    expect(producerSources.length).toBeGreaterThan(50);
    expect(producerCountFor('references')).toBeGreaterThan(0);
  });

  it('the set of EdgeTypes with ZERO producers is exactly UNPRODUCED_EDGE_TYPES', () => {
    const unproduced = EDGE_TYPES.filter((t) => producerCountFor(t) === 0);
    expect([...unproduced].sort()).toEqual([...UNPRODUCED_EDGE_TYPES].sort());
  });

  it('coversTest is the unproduced one — declared, walked, never emitted', () => {
    expect(UNPRODUCED_EDGE_TYPES).toContain('coversTest');
    expect(producerCountFor('coversTest')).toBe(0);
    // It IS still a declared member of the contract: the fix is disclosure,
    // never a silent deletion of the type.
    expect(EDGE_TYPES).toContain('coversTest');
  });

  it('every OTHER declared EdgeType does have at least one producer', () => {
    for (const edgeType of EDGE_TYPES) {
      if ((UNPRODUCED_EDGE_TYPES as readonly string[]).includes(edgeType)) continue;
      expect(
        producerCountFor(edgeType),
        `${edgeType} has no producer but is not in UNPRODUCED_EDGE_TYPES`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('the consumer of an unproduced edge discloses the gap', () => {
  const description = V01_TOOLS.find(
    (t) => t.name === 'sfi.what_if_change_method_signature',
  )?.description;

  it('the tool that walks coversTest is still in the roster', () => {
    expect(description).toBeDefined();
  });

  it('names the gap instead of implying the walk is populated', () => {
    // FAIL-BEFORE: the description asserted test classes are found "by
    // coversTest edges" and by a "naming convention (className + 'Test'
    // suffix)" — the first walks an edge nothing emits, the second is not
    // implemented at all.
    expect(description).toMatch(/coversTest/);
    expect(description).toMatch(/NO extractor|no extractor/);
    expect(description).toMatch(/UNAVAILABLE/);
    expect(description).not.toMatch(/identified by @isTest \+ naming convention/);
  });

  it('tells the host that an empty result is "not checked", not "proven none"', () => {
    expect(description).toMatch(/never as .*no tests cover this class/);
  });
});
