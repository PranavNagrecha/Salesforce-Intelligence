/// <reference types="vitest/globals" />

/**
 * GATE-HONESTY-EMPTY-GRAPH-EQUALS-SAFE — L1 RESIDUAL regression.
 *
 * The shipped L1 gate caveats only when a usage-source FAMILY was UN-RETRIEVED.
 * The residual this suite locks down: a family can be fully RETRIEVED yet the
 * extractor is KNOWN not to emit an edge for a reference shape inside it (a
 * `KNOWN_BLIND_EXTRACTOR_PLANE`). Before this fix a "0 inbound edges" destructive
 * verdict on such a covered-but-blind component floored to a false bare `safe`
 * with an EMPTY caveat.
 *
 * The guard the finding's acceptance bar demands: "a unit/integration test FAILS
 * if a new extractor miss restores false-safe without disclosure." Concretely —
 * a component whose referrer families are ALL COVERED but whose placement edge is
 * OMITTED (the extractor is blind to it) must NOT be bare `safe` / clean-unused;
 * it must carry a STRUCTURED `extractor-blind` blind spot. If a future change
 * unwires the blind-plane axis (or silently deletes the registry entry without
 * closing the extractor), these flip to `safe`/clean and FAIL.
 *
 * All three L1 tools share ONE contract (`assertUsageCompleteness`): this suite
 * exercises it directly (unit) and through `review_change` + `unused_components`
 * (integration). `package_impact` shares the same contract via
 * `buildUsageSourceCoverageCaveat` and is covered by its own suite.
 *
 * PUBLIC FIXTURES ONLY — every id here is synthetic and absent from any org.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
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
  assertUsageCompleteness,
  KNOWN_BLIND_EXTRACTOR_PLANES,
  knownBlindPlanesFor,
  usageSourceFamiliesFor,
} from '../../src/tools/coverage-trust.js';
import { reviewChangeHandler } from '../../src/tools/review-change.js';
import { unusedComponentsHandler } from '../../src/tools/unused-components.js';

// ---------------------------------------------------------------------------
// Coverage helpers. A covered row = retrieved:1; a partial row = retrieved:0.
// ---------------------------------------------------------------------------
const coveredRow = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 1,
  errored: false,
  neverModeled: false,
});

const manifestWith = (coverage: readonly CoverageEntry[] | undefined): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-29T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-blind-plane',
  ...(coverage !== undefined
    ? { coverage, coverageComputedAt: '2026-05-29T12:00:00.000Z' }
    : {}),
});

// A synthetic StaticResource with ZERO inbound usage edges (its only reference in
// the real org would be a dynamically-built LWC/Aura resourceUrl the extractor
// cannot follow — the omitted edge). A Layout with no known-blind plane is the
// calibration control. Both live under a synthetic object.
const HOST_OBJECT = 'CustomObject:Zzz_Blind_Host__c';
const BLIND_STATIC_RESOURCE = 'StaticResource:Zzz_Dynamic_Logo';
const CONTROL_LAYOUT = 'Layout:Zzz_Blind_Host__c.Zzz Layout';

const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const SEED: ExtractionResult = {
  nodes: [
    makeNode({ id: HOST_OBJECT, type: 'CustomObject', apiName: 'Zzz_Blind_Host__c' }),
    // 0 inbound edges — the covered-but-blind StaticResource.
    makeNode({ id: BLIND_STATIC_RESOURCE, type: 'StaticResource', apiName: 'Zzz_Dynamic_Logo' }),
    // 0 inbound edges — a Layout has no known-blind plane (calibration control).
    makeNode({
      id: CONTROL_LAYOUT,
      type: 'Layout',
      apiName: 'Zzz_Blind_Host__c.Zzz Layout',
      parentId: HOST_OBJECT,
    }),
  ],
  edges: [],
};

// A vault that FULLY covers every referrer family of both the blind
// StaticResource and the control Layout — so the ONLY thing that can flip a
// verdict is the EXTRACTOR-blind axis, never a retrieve gap. This is what makes
// the regression a true covered-family + omitted-edge proof.
const FULL_COVERAGE: readonly CoverageEntry[] = [
  ...new Set<string>([
    'StaticResource',
    'Layout',
    ...usageSourceFamiliesFor('StaticResource'),
    ...usageSourceFamiliesFor('Layout'),
  ]),
].map(coveredRow);

let dir: string;
let store: GraphStore;
const ctxWith = (coverage: readonly CoverageEntry[] | undefined): Context => ({
  vaultRoot: dir,
  manifest: manifestWith(coverage),
  graph: store,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-blind-plane-'));
  const opened = await openGraph(join(dir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// Contract unit — assertUsageCompleteness (the ONE shared L1 definition).
// ===========================================================================
describe('assertUsageCompleteness — extractor-blind axis (residual)', () => {
  it('covered-family + known-blind extractor plane ⇒ NOT complete, structured extractor-blind spot', () => {
    const r = assertUsageCompleteness(ctxWith(FULL_COVERAGE), {
      usageFamilies: usageSourceFamiliesFor('StaticResource'),
      blindPlaneTypes: ['StaticResource'],
      purpose: 'Whether the StaticResource is still referenced',
    });
    // Retrieve coverage is COMPLETE — so this cannot be a retrieve-gap caveat.
    expect(r.complete).toBe(false);
    expect(r.caveat).toBeDefined();
    // Every blind spot is extractor-blind (the family WAS retrieved) — the crux.
    expect(r.blindSpots.length).toBeGreaterThan(0);
    expect(r.blindSpots.every((s) => s.kind === 'extractor-blind')).toBe(true);
    expect(r.blindSpots.map((s) => s.plane)).toContain('LightningComponentBundle');
    // The structured spots ride ON the caveat so any host can cite them.
    expect(r.caveat?.blindSpots).toBeDefined();
    expect(r.caveat?.missingCoverage).toContain('LightningComponentBundle');
    expect(r.caveat?.message).toMatch(/not checked/);
  });

  it('CALIBRATED: a fully-covered type with NO known-blind plane ⇒ complete, no caveat', () => {
    const r = assertUsageCompleteness(ctxWith(FULL_COVERAGE), {
      usageFamilies: usageSourceFamiliesFor('Layout'),
      blindPlaneTypes: ['Layout'],
      purpose: 'Whether the Layout is still referenced',
    });
    expect(r.complete).toBe(true);
    expect(r.caveat).toBeUndefined();
    expect(r.blindSpots).toEqual([]);
  });

  it('entry-point type (empty usage sources, no blind plane) ⇒ complete', () => {
    const r = assertUsageCompleteness(ctxWith(FULL_COVERAGE), {
      usageFamilies: usageSourceFamiliesFor('DuplicateRule'), // []
      blindPlaneTypes: ['DuplicateRule'],
      purpose: 'unused',
    });
    expect(r.complete).toBe(true);
    expect(r.caveat).toBeUndefined();
  });

  it('GOLDEN-LOCK: a pure retrieve-gap caveat carries NO blindSpots key (byte-identical to pre-residual)', () => {
    // Layout with its CustomObject referrer plane un-retrieved: a retrieve gap,
    // no extractor-blind plane. The caveat must stay the legacy shape.
    const partial = FULL_COVERAGE.filter((row) => row.type !== 'CustomObject');
    const r = assertUsageCompleteness(ctxWith(partial), {
      usageFamilies: usageSourceFamiliesFor('Layout'),
      blindPlaneTypes: ['Layout'],
      purpose: 'Whether the Layout is still referenced',
      fireOnUnknownCoverage: true,
    });
    expect(r.complete).toBe(false);
    expect(r.caveat).toBeDefined();
    expect(r.caveat?.missingCoverage).toContain('CustomObject');
    // No extractor-blind spot ⇒ the caveat must NOT gain the blindSpots key.
    expect('blindSpots' in (r.caveat as object)).toBe(false);
    // …but the top-level structured list still names the not-retrieved plane.
    expect(r.blindSpots.every((s) => s.kind === 'not-retrieved')).toBe(true);
  });
});

// ===========================================================================
// Registry discipline — closed placement planes must NOT be registered (they
// would re-flag fully-modeled components and break the calibrated `safe`
// controls the placement kit earned).
// ===========================================================================
describe('KNOWN_BLIND_EXTRACTOR_PLANES — scope discipline', () => {
  it('registers the StaticResource dynamic-resourceUrl plane', () => {
    expect(knownBlindPlanesFor('StaticResource').length).toBeGreaterThan(0);
    expect(knownBlindPlanesFor('StaticResource').map((p) => p.referrerFamily)).toContain(
      'LightningComponentBundle',
    );
  });

  it('does NOT register the placement planes the kit already closed', () => {
    // VisualforcePage (site indexPage/template), CompactLayout (object
    // assignment), WebLink (listViewButtons) are edged now — registering them
    // would break fixtures F/G "STAYS SAFE" controls.
    for (const closed of ['VisualforcePage', 'CompactLayout', 'WebLink', 'QuickAction']) {
      expect(knownBlindPlanesFor(closed)).toEqual([]);
    }
  });

  it('every registered plane carries a reason and a ref shape (host-citable)', () => {
    for (const planes of Object.values(KNOWN_BLIND_EXTRACTOR_PLANES)) {
      for (const p of planes) {
        expect(p.reason.length).toBeGreaterThan(20);
        expect(p.refShape.length).toBeGreaterThan(5);
        expect(p.referrerFamily.length).toBeGreaterThan(0);
      }
    }
  });
});

// ===========================================================================
// Integration — review_change (destructive delete gate).
// ===========================================================================
describe('reviewChangeHandler — covered-family + omitted-extractor-edge (Fixture H)', () => {
  it('REGRESSION: deleting a StaticResource whose referrers are ALL covered is NOT bare-safe', async () => {
    const r = await reviewChangeHandler(ctxWith(FULL_COVERAGE), {
      components: [
        { type: 'StaticResource', apiName: 'Zzz_Dynamic_Logo', changeKind: 'deleted' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    // 0 inbound usage edges — the false-safe input.
    expect(c?.dependentCount).toBe(0);
    // Must NOT floor to bare `safe`: the extractor is blind to the placement plane.
    expect(c?.verdict).not.toBe('safe');
    expect(c?.verdict).toBe('review');
    // Structured, host-citable disclosure of the covered-but-blind plane.
    expect(c?.coverageCaveat).toBeDefined();
    expect(c?.coverageCaveat?.blindSpots).toBeDefined();
    expect(
      c?.coverageCaveat?.blindSpots?.some((s) => s.kind === 'extractor-blind'),
    ).toBe(true);
    expect(c?.coverageCaveat?.missingCoverage).toContain('LightningComponentBundle');
    // Proof it is the EXTRACTOR axis, not a retrieve gap: no not-retrieved spot.
    expect(
      c?.coverageCaveat?.blindSpots?.every((s) => s.kind === 'extractor-blind'),
    ).toBe(true);
    expect(r.value.data.overallVerdict).toBe('review');
  });

  it('CALIBRATED: deleting a Layout (no known-blind plane) on the SAME covered vault stays safe', async () => {
    const r = await reviewChangeHandler(ctxWith(FULL_COVERAGE), {
      components: [
        { type: 'Layout', apiName: 'Zzz_Blind_Host__c.Zzz Layout', changeKind: 'deleted' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.reviewed[0];
    expect(c?.dependentCount).toBe(0);
    expect(c?.verdict).toBe('safe');
    expect(c?.coverageCaveat).toBeUndefined();
  });
});

// ===========================================================================
// Integration — unused_components (clean-unused inventory gate).
// ===========================================================================
describe('unusedComponentsHandler — covered-family + omitted-extractor-edge', () => {
  // The full referrer union unused_components checks (UNUSED_REQUIRED_COVERAGE),
  // all covered — so any caveat can ONLY come from the extractor-blind axis.
  const UNUSED_FULL_COVERAGE: readonly CoverageEntry[] = [
    'ApexClass', 'ApexTrigger', 'AuraDefinitionBundle', 'CompactLayout',
    'CustomSite', 'CustomTab', 'Dashboard', 'EmailTemplate', 'FieldSet',
    'FlexiPage', 'Flow', 'Layout', 'LightningComponentBundle', 'ListView',
    'QuickAction', 'RecordType', 'Report', 'SharingRule', 'ValidationRule',
    'VisualforceComponent', 'VisualforcePage', 'WebLink', 'WorkflowRule',
  ].map(coveredRow);

  it('REGRESSION: scanning StaticResource on a fully-covered vault carries an extractor-blind blindSpot', async () => {
    const r = await unusedComponentsHandler(ctxWith(UNUSED_FULL_COVERAGE), {
      types: ['StaticResource'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The unused StaticResource is listed…
    expect(r.value.data.byType['StaticResource']).toBe(1);
    // …but never as CLEAN unused: the caveat discloses the blind placement plane.
    expect(r.value.data.coverageCaveat).toBeDefined();
    expect(r.value.data.coverageCaveat?.blindSpots).toBeDefined();
    expect(
      r.value.data.coverageCaveat?.blindSpots?.some((s) => s.kind === 'extractor-blind'),
    ).toBe(true);
    expect(r.value.data.coverageCaveat?.missingCoverage).toContain('LightningComponentBundle');
    expect(r.value.data.trust.completeness.status).toBe('partial');
  });

  it('CALIBRATED: scanning ApexClass (no known-blind plane) on the same covered vault has NO caveat', async () => {
    const r = await unusedComponentsHandler(ctxWith(UNUSED_FULL_COVERAGE), {
      types: ['ApexClass'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
    expect(r.value.data.trust.completeness.status).toBe('complete');
  });
});
