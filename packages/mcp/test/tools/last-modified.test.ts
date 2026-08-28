/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  LAST_MODIFIED_ENRICHED_DISCLOSURE,
  LAST_MODIFIED_UNENRICHED_DISCLOSURE,
  lastModifiedHandler,
  lastModifiedInputSchema,
} from '../../src/tools/last-modified.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 3, CustomField: 1, Flow: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'src/path.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

// Seed:
//   - ApexClass:FullyEnriched — properties carry every freshness field
//     (lastModifiedDate, lastModifiedBy: { id, name }, apiVersion).
//     The happy v1.7-enrichment path.
//   - ApexClass:LegacyOnly — top-level lastModifiedDate + legacy string
//     lastModifiedBy + top-level apiVersion populated, no properties
//     overlay. Backward-compat: a pre-v1.7 vault that already had
//     freshness from the DX-source extractor still resolves to
//     enriched: true.
//   - ApexClass:Unenriched — every freshness field null. The default
//     offline-vault state until the Tooling API enricher runs.
//   - Flow:PartiallyEnriched — properties.lastModifiedDate populated,
//     no lastModifiedBy or apiVersion. Partial presence still counts
//     as enriched: true (the user-facing question is "do we know
//     anything?", not "do we know everything?").
//   - CustomField:Account.Hybrid — properties.lastModifiedDate AND
//     a top-level lastModifiedDate (different values). The properties
//     overlay must win — that's the precedence the changed-since
//     handler also uses.
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexClass:FullyEnriched',
      type: 'ApexClass',
      apiName: 'FullyEnriched',
      properties: {
        lastModifiedDate: '2026-05-15T12:00:00.000Z',
        lastModifiedBy: { id: '005xxAA', name: 'Alice' },
        apiVersion: 62.0,
      },
    }),
    makeNode({
      id: 'ApexClass:LegacyOnly',
      type: 'ApexClass',
      apiName: 'LegacyOnly',
      lastModifiedDate: '2026-04-01T00:00:00.000Z',
      lastModifiedBy: '005xxBB',
      apiVersion: 60.0,
    }),
    makeNode({
      id: 'ApexClass:Unenriched',
      type: 'ApexClass',
      apiName: 'Unenriched',
    }),
    makeNode({
      // The shape a REAL un-enriched vault produces for every component
      // whose own metadata file ships an `<apiVersion>` element: the
      // version is known, the two Tooling-API-only axes are not. This
      // was the certified-unchecked-zero case — `enriched: true` plus
      // "Freshness fields populated" over two nulls nothing had asked
      // about.
      id: 'ApexClass:Class_C',
      type: 'ApexClass',
      apiName: 'Class_C',
      apiVersion: 63.0,
    }),
    makeNode({
      id: 'Flow:PartiallyEnriched',
      type: 'Flow',
      apiName: 'PartiallyEnriched',
      properties: {
        lastModifiedDate: '2026-05-20T00:00:00.000Z',
      },
    }),
    makeNode({
      id: 'CustomField:Account.Hybrid',
      type: 'CustomField',
      apiName: 'Hybrid',
      lastModifiedDate: '2026-01-01T00:00:00.000Z',
      properties: {
        lastModifiedDate: '2026-05-12T00:00:00.000Z',
        lastModifiedBy: { id: '005xxDD', name: 'Dave' },
      },
    }),
  ],
  edges: [] as readonly Edge[],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-last-modified-'));
  const dbPath = join(tempDir, 'last-modified.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('lastModifiedInputSchema', () => {
  it('accepts a non-empty componentId string', () => {
    const r = lastModifiedInputSchema.safeParse({
      componentId: 'ApexClass:FullyEnriched',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty componentId string', () => {
    const r = lastModifiedInputSchema.safeParse({ componentId: '' });
    expect(r.success).toBe(false);
  });

  it('rejects missing componentId', () => {
    const r = lastModifiedInputSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe('lastModifiedHandler — unknown component', () => {
  it('returns component-not-found for an id no node carries', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'CustomObject:NoSuchObject',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomObject:NoSuchObject');
  });
});

describe('lastModifiedHandler — fully enriched node', () => {
  it('emits every freshness field from the v1.7 properties overlay', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:FullyEnriched',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = result.value;
    expect(data.componentId).toBe('ApexClass:FullyEnriched');
    expect(data.enriched).toBe(true);
    expect(data.lastModifiedDate).toBe('2026-05-15T12:00:00.000Z');
    expect(data.lastModifiedBy).toEqual({ id: '005xxAA', name: 'Alice' });
    expect(data.apiVersion).toBe(62.0);
    expect(data.disclosure).toBe(LAST_MODIFIED_ENRICHED_DISCLOSURE);
  });
});

describe('lastModifiedHandler — legacy-only node (backward-compat)', () => {
  it('reads from the top-level fields when properties carries nothing', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:LegacyOnly',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = result.value;
    expect(data.enriched).toBe(true);
    expect(data.lastModifiedDate).toBe('2026-04-01T00:00:00.000Z');
    // Legacy string-only lastModifiedBy surfaces with empty name.
    expect(data.lastModifiedBy).toEqual({ id: '005xxBB', name: '' });
    expect(data.apiVersion).toBe(60.0);
    expect(data.disclosure).toBe(LAST_MODIFIED_ENRICHED_DISCLOSURE);
  });
});

describe('lastModifiedHandler — unenriched node', () => {
  it('returns enriched: false with null freshness fields and the verbatim disclosure', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:Unenriched',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = result.value;
    expect(data.enriched).toBe(false);
    expect(data.lastModifiedDate).toBeNull();
    expect(data.lastModifiedBy).toBeNull();
    expect(data.apiVersion).toBeNull();
    expect(data.disclosure).toBe(LAST_MODIFIED_UNENRICHED_DISCLOSURE);
    // Verbatim spot-check: the disclosure must name the CLI command.
    expect(data.disclosure).toContain('sfi refresh --with-tooling-api');
  });
});

describe('lastModifiedHandler — partial enrichment (only date present)', () => {
  it('flags enriched: true when at least one freshness axis is populated', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'Flow:PartiallyEnriched',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = result.value;
    expect(data.enriched).toBe(true);
    expect(data.lastModifiedDate).toBe('2026-05-20T00:00:00.000Z');
    expect(data.lastModifiedBy).toBeNull();
    expect(data.apiVersion).toBeNull();
  });
});

describe('lastModifiedHandler — properties take precedence over top-level legacy', () => {
  it('returns the properties overlay date when both sources are present', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'CustomField:Account.Hybrid',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = result.value;
    expect(data.lastModifiedDate).toBe('2026-05-12T00:00:00.000Z');
    expect(data.lastModifiedBy).toEqual({ id: '005xxDD', name: 'Dave' });
    expect(data.enriched).toBe(true);
  });
});

describe('lastModifiedHandler — vault-state envelope', () => {
  it('copies the manifest sourceTreeHash + refreshedAt into the response envelope', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:FullyEnriched',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(
      FIXTURE_MANIFEST.sourceTreeHash,
    );
    expect(result.value.vaultState.refreshedAt).toBe(
      FIXTURE_MANIFEST.refreshedAt,
    );
  });
});

describe('R6 — freshness field extraction is sourced from a shared module', () => {
  // Census finding: extractLastModifiedDate/extractLastModifiedBy live as a
  // SECOND private copy in changed-since.ts, held in sync only by a JSDoc
  // comment ("mirrors the equivalent helper in changed-since.ts"). A comment
  // is not a guard — the fix is a shared leaf module (freshness-fields.ts,
  // same shape as field-properties.ts in this shard) that last-modified.ts
  // imports its extractors from, rather than defining its own copies.
  it('exports extractLastModifiedDate / extractLastModifiedBy / extractApiVersion from freshness-fields.ts', async () => {
    const shared = await import('../../src/tools/freshness-fields.js');
    expect(typeof shared.extractLastModifiedDate).toBe('function');
    expect(typeof shared.extractLastModifiedBy).toBe('function');
    expect(typeof shared.extractApiVersion).toBe('function');
  });

  it('the shared extractLastModifiedDate prefers properties over the legacy field', async () => {
    const { extractLastModifiedDate } = await import('../../src/tools/freshness-fields.js');
    expect(
      extractLastModifiedDate('2020-01-01T00:00:00.000Z', {
        lastModifiedDate: '2026-05-12T00:00:00.000Z',
      }),
    ).toBe('2026-05-12T00:00:00.000Z');
    expect(extractLastModifiedDate('2020-01-01T00:00:00.000Z', {})).toBe(
      '2020-01-01T00:00:00.000Z',
    );
    expect(extractLastModifiedDate(null, {})).toBeNull();
  });

  it('the shared extractLastModifiedBy prefers the properties {id,name} object over the legacy string', async () => {
    const { extractLastModifiedBy } = await import('../../src/tools/freshness-fields.js');
    expect(
      extractLastModifiedBy('005xxBB', { lastModifiedBy: { id: '005xxAA', name: 'Alice' } }),
    ).toEqual({ id: '005xxAA', name: 'Alice' });
    expect(extractLastModifiedBy('005xxBB', {})).toEqual({ id: '005xxBB', name: '' });
    expect(extractLastModifiedBy(null, {})).toBeNull();
  });

  it('the shared extractApiVersion prefers properties.apiVersion over the legacy number', async () => {
    const { extractApiVersion } = await import('../../src/tools/freshness-fields.js');
    expect(extractApiVersion(60.0, { apiVersion: 62.0 })).toBe(62.0);
    expect(extractApiVersion(60.0, {})).toBe(60.0);
    expect(extractApiVersion(null, {})).toBeNull();
  });
});

describe('lastModifiedHandler — disclosure invariants', () => {
  it('always emits a non-empty disclosure string regardless of enrichment state', async () => {
    const enriched = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:FullyEnriched',
    });
    const unenriched = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:Unenriched',
    });
    expect(enriched.ok).toBe(true);
    expect(unenriched.ok).toBe(true);
    if (!enriched.ok || !unenriched.ok) return;
    expect(enriched.value.data.disclosure.length).toBeGreaterThan(0);
    expect(unenriched.value.data.disclosure.length).toBeGreaterThan(0);
    // The two disclosures must be distinct shapes — the consumer
    // distinguishes by content, not by enriched flag alone.
    expect(enriched.value.data.disclosure).not.toBe(
      unenriched.value.data.disclosure,
    );
  });
});


describe('R6 adoption — the TOOL reads its freshness through the shared module', () => {
  // The previous revision of this file asserted only on freshness-fields.ts
  // in isolation, so every case stayed green with last-modified.ts's private
  // copies restored. A test that passes with the fix reverted measures
  // nothing. These sentinels are observable ONLY through the handler: they
  // are values no fixture node carries and no private copy could invent.
  const SENTINEL_DATE = '1999-12-31T23:59:59.000Z';
  const SENTINEL_BY = { id: 'SENTINEL', name: 'reached-only-via-shared-module' };
  const SENTINEL_API_VERSION = 1.1;

  afterEach(() => {
    vi.doUnmock('../../src/tools/freshness-fields.js');
    vi.resetModules();
  });

  it('routes every freshness axis through freshness-fields.ts, so re-privatising the extractors is observable', async () => {
    vi.resetModules();
    vi.doMock('../../src/tools/freshness-fields.js', () => ({
      extractLastModifiedDate: () => SENTINEL_DATE,
      extractLastModifiedBy: () => SENTINEL_BY,
      extractApiVersion: () => SENTINEL_API_VERSION,
    }));
    const { lastModifiedHandler: handlerUnderTest } = await import(
      '../../src/tools/last-modified.js'
    );
    // The UNENRICHED node: a handler carrying its own private copy of the
    // precedence logic resolves every axis to null here, whatever the
    // shared module says. Only a handler that CALLS the shared module can
    // return the sentinels.
    const result = await handlerUnderTest(ctx, {
      componentId: 'ApexClass:Unenriched',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.lastModifiedDate).toBe(SENTINEL_DATE);
    expect(result.value.data.lastModifiedBy).toEqual(SENTINEL_BY);
    expect(result.value.data.apiVersion).toBe(SENTINEL_API_VERSION);
    // And the derived honesty fields follow the shared module too.
    expect(result.value.data.enrichmentState).toBe('complete');
    expect(result.value.data.missingAxes).toEqual([]);
  });

  it('passes the node\'s legacy field AND its properties bag to the shared module (both precedence inputs)', async () => {
    vi.resetModules();
    const dateCalls: unknown[][] = [];
    vi.doMock('../../src/tools/freshness-fields.js', () => ({
      extractLastModifiedDate: (...args: unknown[]) => {
        dateCalls.push(args);
        return null;
      },
      extractLastModifiedBy: () => null,
      extractApiVersion: () => null,
    }));
    const { lastModifiedHandler: handlerUnderTest } = await import(
      '../../src/tools/last-modified.js'
    );
    const result = await handlerUnderTest(ctx, {
      componentId: 'CustomField:Account.Hybrid',
    });
    expect(result.ok).toBe(true);
    expect(dateCalls).toHaveLength(1);
    // Legacy top-level value first, properties overlay second — a handler
    // that only forwarded one of the two could not resolve the precedence.
    expect(dateCalls[0]?.[0]).toBe('2026-01-01T00:00:00.000Z');
    expect(dateCalls[0]?.[1]).toMatchObject({
      lastModifiedDate: '2026-05-12T00:00:00.000Z',
    });
  });
});

describe('lastModifiedHandler — a partial answer is not certified as populated', () => {
  // Real-vault reproduction: on a vault where the Tooling API enricher has
  // never run, every component whose metadata file ships an `<apiVersion>`
  // resolved to `enriched: true` + the ENRICHED disclosure ("Freshness
  // fields populated. lastModifiedDate / lastModifiedBy reflect the Tooling
  // API at enrichment time") while both of those axes were null and nothing
  // had asked the Tooling API. A certified unchecked zero.
  it('an apiVersion-only node reports enrichmentState: partial and NAMES the unchecked axes', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:Class_C',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = result.value;
    expect(data.apiVersion).toBe(63.0);
    expect(data.lastModifiedDate).toBeNull();
    expect(data.lastModifiedBy).toBeNull();
    // The typed field a machine consumer cannot skip.
    expect(data.enrichmentState).toBe('partial');
    expect(data.missingAxes).toEqual(['lastModifiedDate', 'lastModifiedBy']);
    // The prose a host reads aloud must NOT be the populated-certification.
    expect(data.disclosure).not.toBe(LAST_MODIFIED_ENRICHED_DISCLOSURE);
    expect(data.disclosure).toContain('PARTIAL');
    expect(data.disclosure).toContain('UNCHECKED');
    expect(data.disclosure).toContain('lastModifiedDate');
    expect(data.disclosure).toContain('lastModifiedBy');
    expect(data.disclosure).toContain('sfi refresh --with-tooling-api');
  });

  it('the partial disclosure is DERIVED from missingAxes, so prose and typed field cannot drift', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'Flow:PartiallyEnriched',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = result.value;
    expect(data.enrichmentState).toBe('partial');
    expect(data.missingAxes).toEqual(['lastModifiedBy', 'apiVersion']);
    // Imported dynamically so reverting the source fix fails THIS case on
    // its own assertion rather than breaking the whole file's module link.
    const { lastModifiedPartialDisclosure } = await import(
      '../../src/tools/last-modified.js'
    );
    expect(data.disclosure).toBe(
      lastModifiedPartialDisclosure(['lastModifiedBy', 'apiVersion']),
    );
    // The axis that IS known must not be named as unchecked.
    expect(data.disclosure).not.toContain('lastModifiedDate,');
  });

  it('a fully-populated node keeps enrichmentState: complete with an EMPTY missingAxes', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:FullyEnriched',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.enrichmentState).toBe('complete');
    expect(result.value.data.missingAxes).toEqual([]);
    expect(result.value.data.disclosure).toBe(LAST_MODIFIED_ENRICHED_DISCLOSURE);
  });

  it('a node with nothing reports none and names ALL THREE axes — empty missingAxes never stands in for "we did not look"', async () => {
    const result = await lastModifiedHandler(ctx, {
      componentId: 'ApexClass:Unenriched',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data } = result.value;
    expect(data.enrichmentState).toBe('none');
    expect(data.missingAxes).toEqual([
      'lastModifiedDate',
      'lastModifiedBy',
      'apiVersion',
    ]);
    expect(data.disclosure).toBe(LAST_MODIFIED_UNENRICHED_DISCLOSURE);
  });

  it('missingAxes is empty for EVERY fixture node if and only if enrichmentState is complete', async () => {
    const ids = [
      'ApexClass:FullyEnriched',
      'ApexClass:LegacyOnly',
      'ApexClass:Unenriched',
      'ApexClass:Class_C',
      'Flow:PartiallyEnriched',
      'CustomField:Account.Hybrid',
    ];
    for (const componentId of ids) {
      const result = await lastModifiedHandler(ctx, { componentId });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const { data } = result.value;
      expect(data.missingAxes.length === 0).toBe(
        data.enrichmentState === 'complete',
      );
      // And the enumerated axes must agree with the reported values.
      expect(data.missingAxes.includes('lastModifiedDate')).toBe(
        data.lastModifiedDate === null,
      );
      expect(data.missingAxes.includes('lastModifiedBy')).toBe(
        data.lastModifiedBy === null,
      );
      expect(data.missingAxes.includes('apiVersion')).toBe(
        data.apiVersion === null,
      );
    }
  });
});
