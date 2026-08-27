/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 `sfi.compare_profile_across_vaults` MCP tool.
 *
 * The Q169 anchor — System Administrator's Discount__c read/edit
 * permissions drift between sandbox and prod.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import {
  registerVault,
  saveManifest,
  vaultPaths,
} from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import {
  canonicalJson,
  compareProfileAcrossVaultsHandler,
  compareProfileAcrossVaultsInputSchema,
} from '../../src/tools/compare-profile-across-vaults.js';
import { toolLocalPayloadBudgetBytes } from '../../src/tools/response-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Profile: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Profile',
  apiName: 'System Administrator',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const PROFILE_ID = 'Profile:System Administrator';
const ACCOUNT_ID = 'CustomObject:Account';
const DISCOUNT_FIELD_ID = 'CustomField:Account.Discount__c';
const BILLING_CLASS_ID = 'ApexClass:BillingService';

/**
 * A `grantedBy` edge in the shape the Profile extractor emits: one edge per
 * `<objectPermissions>` / `<fieldPermissions>` / `<classAccesses>` entry, flags
 * carried in `properties`.
 */
const makeGrantEdge = (
  toId: string,
  properties: Readonly<Record<string, unknown>>,
  fromId: string = PROFILE_ID,
): Edge => ({
  fromId,
  toId,
  edgeType: 'grantedBy',
  confidence: 'declared',
  source: 'test-fixture',
  properties,
});

/** The three grant targets, seeded in BOTH vaults so no edge is `targetMissing`. */
const grantTargetNodes: readonly Node[] = [
  makeNode({ id: ACCOUNT_ID, type: 'CustomObject', apiName: 'Account' }),
  makeNode({
    id: DISCOUNT_FIELD_ID,
    type: 'CustomField',
    apiName: 'Account.Discount__c',
  }),
  makeNode({ id: BILLING_CLASS_ID, type: 'ApexClass', apiName: 'BillingService' }),
];

let rootDir: string;
let vaultAPath: string;
let vaultBPath: string;
let storeA: GraphStore;
let storeB: GraphStore;
let ctx: Context;

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-v31-compare-profile-'));
  vaultAPath = join(rootDir, 'acme-prod');
  vaultBPath = join(rootDir, 'acme-sandbox');
  await mkdir(join(vaultAPath, 'graph'), { recursive: true });
  await mkdir(join(vaultBPath, 'graph'), { recursive: true });
  await saveManifest(vaultAPath, FIXTURE_MANIFEST);
  await saveManifest(vaultBPath, FIXTURE_MANIFEST);

  const openedA = await openGraph(vaultPaths(vaultAPath).graphDb);
  if (!openedA.ok) throw new Error(openedA.error.message);
  storeA = openedA.value;
  const openedB = await openGraph(vaultPaths(vaultBPath).graphDb);
  if (!openedB.ok) throw new Error(openedB.error.message);
  storeB = openedB.value;

  // G3-permission-truth: both vaults are seeded the way the REAL Profile
  // extractor writes a profile — grant COUNTS (+ a plain `string[]` of user
  // permissions) on the node, and the grants themselves as outgoing `grantedBy`
  // EDGES. The previous fixture hand-seeded `properties.objectPermissions` /
  // `.fieldPermissions` / `.apexClassAccesses`, a shape NO extractor produces;
  // it is why this suite stayed green while the tool reported a fabricated
  // "0 drift" on every real vault.
  //
  // Vault A — editable:true on Account.Discount__c, an Apex class grant, and
  // the extra `ViewAllData` user permission.
  const seedA: ExtractionResult = {
    nodes: [
      ...grantTargetNodes,
      makeNode({
        id: PROFILE_ID,
        properties: {
          description: null,
          userLicense: 'Salesforce',
          custom: false,
          objectGrantCount: 1,
          fieldGrantCount: 1,
          classGrantCount: 1,
          userPermissions: ['ApiEnabled', 'ViewAllData'],
        },
      }),
    ],
    edges: [
      makeGrantEdge(ACCOUNT_ID, {
        allowCreate: false,
        allowDelete: true,
        allowEdit: true,
        allowRead: true,
        modifyAllRecords: false,
        viewAllRecords: false,
      }),
      makeGrantEdge(DISCOUNT_FIELD_ID, { editable: true, readable: true }),
      makeGrantEdge(BILLING_CLASS_ID, { enabled: true }),
    ],
  };
  // Vault B — same profile: identical object grant, editable:false on
  // Account.Discount__c, NO Apex class grant, and no `ViewAllData`.
  const seedB: ExtractionResult = {
    nodes: [
      ...grantTargetNodes,
      makeNode({
        id: PROFILE_ID,
        properties: {
          description: null,
          userLicense: 'Salesforce',
          custom: false,
          objectGrantCount: 1,
          fieldGrantCount: 1,
          classGrantCount: 0,
          userPermissions: ['ApiEnabled'],
        },
      }),
    ],
    edges: [
      makeGrantEdge(ACCOUNT_ID, {
        allowCreate: false,
        allowDelete: true,
        allowEdit: true,
        allowRead: true,
        modifyAllRecords: false,
        viewAllRecords: false,
      }),
      makeGrantEdge(DISCOUNT_FIELD_ID, { editable: false, readable: true }),
    ],
  };

  await importExtractionResults(storeA, [seedA]);
  await importExtractionResults(storeB, [seedB]);
  await registerVault(rootDir, 'acme-prod', vaultAPath);
  await registerVault(rootDir, 'acme-sandbox', vaultBPath);

  ctx = {
    vaultRoot: vaultAPath,
    manifest: FIXTURE_MANIFEST,
    graph: storeA,
  };
  process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
});

afterAll(async () => {
  delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  await closeGraph(storeA);
  await closeGraph(storeB);
  await rm(rootDir, { recursive: true, force: true });
});

describe('compareProfileAcrossVaultsHandler', () => {
  it('parses valid input via the Zod schema', () => {
    const parsed = compareProfileAcrossVaultsInputSchema.safeParse({
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(parsed.success).toBe(true);
  });

  it('Q169 — surfaces Account.Discount__c field-permission drift', async () => {
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The target is the canonical component id — the `grantedBy` edge target,
    // which is what the grants are actually keyed by.
    const drift = r.value.data.grantDiffs.fieldPermissions.find(
      (d) => d.targetId === DISCOUNT_FIELD_ID,
    );
    expect(drift).toBeDefined();
    expect(drift?.side).toBe('both');
  });

  it('G3 — reads object / field / Apex grants from `grantedBy` edges, not absent node properties', async () => {
    // The defect: the tool read `properties.objectPermissions` /
    // `.fieldPermissions` / `.apexClassAccesses`, three keys `buildProperties`
    // never writes, so all three reported a measured-looking 0 on real vaults.
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { perCategoryDriftCount, notEvaluatedCategories } = r.value.data.summary;
    // read↔edit LEVEL drift on the field grant (edge properties compared, not
    // just grant presence).
    expect(perCategoryDriftCount['fieldPermissions']).toBe(1);
    // The Apex class grant exists in A only.
    expect(perCategoryDriftCount['apexClassAccesses']).toBe(1);
    expect(
      r.value.data.grantDiffs.apexClassAccesses.map((d) => [d.targetId, d.side]),
    ).toEqual([[BILLING_CLASS_ID, 'A']]);
    // The object grant is byte-identical — a REAL measured zero.
    expect(perCategoryDriftCount['objectPermissions']).toBe(0);
    expect(notEvaluatedCategories).not.toContain('objectPermissions');
    expect(notEvaluatedCategories).not.toContain('fieldPermissions');
    expect(notEvaluatedCategories).not.toContain('apexClassAccesses');
  });

  it('G3 — compares `userPermissions` as a plain string[] set difference', async () => {
    // `extractGrantMap`'s `typeof entry === 'object'` guard dropped every
    // string, so the map was `{}` and the count was hard-wired to 0.
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.perCategoryDriftCount['userPermissions']).toBe(1);
    expect(
      r.value.data.grantDiffs.userPermissions.map((d) => [d.targetId, d.side]),
    ).toEqual([['ViewAllData', 'A']]);
    expect(r.value.data.summary.notEvaluatedCategories).not.toContain(
      'userPermissions',
    );
    // field(1) + apexClass(1) + userPermissions(1); object contributes 0.
    expect(r.value.data.summary.totalDriftCount).toBe(3);
  });

  it('G3 — a small comparison fits the budget and emits NO paging keys', async () => {
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.nextCursor).toBeUndefined();
    expect(r.value.data.pageInfo).toBeUndefined();
    // `counts` still publishes the true totals, and every row is on this page.
    expect(r.value.data.counts['fieldPermissions']).toEqual({
      total: 1,
      returnedOnThisPage: 1,
    });
    expect(r.value.data.reconciliation.balanced).toBe(true);
    expect(r.value.data.reconciliation.rowsNotOnThisPage).toBe(0);
  });

  it('surfaces the profile-edition-rollup disclosure verbatim', async () => {
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('cannot reliably detect Salesforce edition'),
      ),
    ).toBe(true);
  });

  it('summary.totalDriftCount counts at least one drift entry', async () => {
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.totalDriftCount).toBeGreaterThanOrEqual(1);
  });

  it('discloses tabVisibilities as not-evaluated when a vault predates the P11 extraction', async () => {
    // P11-UI-tabvis-consumer-bug: the fixture profiles carry no
    // `tabVisibilities` property (a pre-P11 / stale vault), so the tool must
    // NOT report a fabricated "0 tab drift" — it must disclose the gap.
    // P12-HONESTY-stale-disclosures: the extractor DOES emit tabVisibilities
    // since P11, so the disclosure blames the stale vault, not the product.
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.notEvaluatedCategories).toContain(
      'tabVisibilities',
    );
    // Excluded from the drift counts (not a false "0 drift").
    expect(
      Object.prototype.hasOwnProperty.call(
        r.value.data.summary.perCategoryDriftCount,
        'tabVisibilities',
      ),
    ).toBe(false);
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('predates the P11 app/tab visibility extraction'),
      ),
    ).toBe(true);
  });

  it('errors (not a false negative) for an unknown alias', async () => {
    // Regression: an unresolved vault must NOT come back as
    // `ok({ profileExistsInA: false })`. It must be a structured error
    // carrying the verbatim register-vault directive.
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'no-such-vault',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain("'no-such-vault' is not registered");
  });
});

/**
 * G3 objection-1 acceptance test — UNBOUNDED FANOUT WITH NO ESCAPE HATCH.
 *
 * Reading grants from `grantedBy` edges made these arrays real for the first
 * time. The CTO's measurement against the real vault (read-only, counts only):
 * the top five Profiles carry 2921 / 2218 / 1701 / 1696 / 1669 `grantedBy`
 * edges. This suite seeds a fanout of that ORDER and asserts the payload FITS
 * the DERIVED tool-local budget, that the summary counts stay COMPLETE, and
 * that the dropped tail is REACHABLE — walking `nextCursor` to exhaustion
 * reproduces the total exactly, with no gap and no duplicate.
 *
 * FANOUT is 900, not the real vault's 2 921. Seeding 2 921 + 200 rows AND
 * their edges into TWO DuckDB vaults ran the `beforeAll` past vitest's 20 s
 * hook budget under the shared thread pool — green when this file was run
 * alone, red on `vitest run`, which is what CI executes. The property under
 * test is cursor closure over a fanout far larger than one page; 900 rows
 * still spans multiple pages at every budget this suite uses, so the assertion
 * is unchanged in kind. The hook budget is stated explicitly below rather than
 * left to the default, so a future increase fails loudly instead of flaking.
 */
describe('compareProfileAcrossVaultsHandler — high grant fanout is paged, not truncated', () => {
  const FANOUT = 900;
  /**
   * A second, smaller profile in the SAME vaults. At `SFI_MAX_RESPONSE_BYTES=6000`
   * the derived tool-local cap is 3 976 bytes and a page holds ONE row, so
   * exhausting the 2 921-row profile there would be 2 921 round trips; this one
   * proves the same closure property in a test-sized number of pages.
   */
  const SMALL_FANOUT = 200;
  let fanRoot: string;
  let fanStoreA: GraphStore;
  let fanStoreB: GraphStore;
  let fanCtx: Context;

  // Seeding two DuckDB vaults is the slowest hook in this package; state the
  // budget instead of inheriting the 20 s default that this suite once blew.
  beforeAll(async () => {
    fanRoot = await mkdtemp(join(tmpdir(), 'sfi-compare-profile-fanout-'));
    const aPath = join(fanRoot, 'prod');
    const bPath = join(fanRoot, 'sandbox');
    await mkdir(join(aPath, 'graph'), { recursive: true });
    await mkdir(join(bPath, 'graph'), { recursive: true });
    await saveManifest(aPath, FIXTURE_MANIFEST);
    await saveManifest(bPath, FIXTURE_MANIFEST);
    const oa = await openGraph(vaultPaths(aPath).graphDb);
    if (!oa.ok) throw new Error(oa.error.message);
    fanStoreA = oa.value;
    const ob = await openGraph(vaultPaths(bPath).graphDb);
    if (!ob.ok) throw new Error(ob.error.message);
    fanStoreB = ob.value;

    // Every field grant is editable in A and read-only in B, so ALL of them
    // drift ('both' rows) — the worst case for payload size.
    const fieldIdsFor = (prefix: string, n: number): string[] =>
      Array.from(
        { length: n },
        (_v, i) => `CustomField:Account.${prefix}_${String(i).padStart(5, '0')}__c`,
      );
    const bigFieldIds = fieldIdsFor('Fanout', FANOUT);
    const smallFieldIds = fieldIdsFor('Small', SMALL_FANOUT);
    const SMALL_PROFILE_ID = 'Profile:Support Agent';
    const fieldNodes = [...bigFieldIds, ...smallFieldIds].map((id) =>
      makeNode({ id, type: 'CustomField', apiName: id.slice('CustomField:'.length) }),
    );
    const profileNode = (id: string, grants: number): Node =>
      makeNode({
        id,
        apiName: id.slice('Profile:'.length),
        properties: {
          userLicense: 'Salesforce',
          fieldGrantCount: grants,
          objectGrantCount: 0,
          classGrantCount: 0,
          userPermissions: ['ApiEnabled'],
        },
      });
    const seedFor = (editable: boolean): ExtractionResult => ({
      nodes: [
        ...fieldNodes,
        profileNode(PROFILE_ID, FANOUT),
        profileNode(SMALL_PROFILE_ID, SMALL_FANOUT),
      ],
      edges: [
        ...bigFieldIds.map((id) =>
          makeGrantEdge(id, { editable, readable: true }),
        ),
        ...smallFieldIds.map((id) =>
          makeGrantEdge(id, { editable, readable: true }, SMALL_PROFILE_ID),
        ),
      ],
    });
    await importExtractionResults(fanStoreA, [seedFor(true)]);
    await importExtractionResults(fanStoreB, [seedFor(false)]);
    await registerVault(fanRoot, 'prod', aPath);
    await registerVault(fanRoot, 'sandbox', bPath);
    fanCtx = { vaultRoot: aPath, manifest: FIXTURE_MANIFEST, graph: fanStoreA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = fanRoot;
  }, 60_000);

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(fanStoreA);
    await closeGraph(fanStoreB);
    // Windows and a busy macOS runner can both still hold a DuckDB sidecar for
    // a moment after close, which surfaced here as ENOTEMPTY; retry rather than
    // fail a passing suite in teardown.
    await rm(fanRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const bytesOfData = (data: unknown): number =>
    Buffer.byteLength(JSON.stringify(data), 'utf8');

  /** Walk `nextCursor` to exhaustion, returning every targetId in page order. */
  const walkAll = async (
    profileName: string,
    expected: number,
  ): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard <= expected; guard += 1) {
      const r = await compareProfileAcrossVaultsHandler(fanCtx, {
        profileName,
        vaultA: 'prod',
        vaultB: 'sandbox',
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error.message);
      // Every page, not just the first, must fit the derived budget.
      expect(bytesOfData(r.value.data)).toBeLessThanOrEqual(
        toolLocalPayloadBudgetBytes(),
      );
      expect(r.value.data.section).toBe('fieldPermissions');
      seen.push(...r.value.data.grantDiffs.fieldPermissions.map((d) => d.targetId));
      const next = r.value.data.nextCursor;
      if (next === undefined) return seen;
      cursor = next;
    }
    throw new Error('cursor walk did not terminate');
  };

  it('fits the DERIVED tool-local budget while keeping the drift count COMPLETE', async () => {
    const r = await compareProfileAcrossVaultsHandler(fanCtx, {
      profileName: 'System Administrator',
      vaultA: 'prod',
      vaultB: 'sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const budget = toolLocalPayloadBudgetBytes();
    expect(bytesOfData(r.value.data)).toBeLessThanOrEqual(budget);
    // The COUNT is the full population (listEdges takes no limit)...
    expect(r.value.data.summary.perCategoryDriftCount['fieldPermissions']).toBe(
      FANOUT,
    );
    expect(r.value.data.counts['fieldPermissions']?.total).toBe(FANOUT);
    // ...while the ARRAY is one page of it, and says so.
    expect(
      r.value.data.grantDiffs.fieldPermissions.length,
    ).toBeLessThan(FANOUT);
    expect(r.value.data.counts['fieldPermissions']?.returnedOnThisPage).toBe(
      r.value.data.grantDiffs.fieldPermissions.length,
    );
    expect(r.value.data.reconciliation.rowsNotOnThisPage).toBeGreaterThan(0);
    expect(r.value.data.hasMore).toBe(true);
    expect(typeof r.value.data.nextCursor).toBe('string');
  });

  it('walking `nextCursor` to exhaustion reproduces the full total — no gap, no duplicate', async () => {
    const seen = await walkAll('System Administrator', FANOUT);
    expect(seen.length).toBe(FANOUT);
    expect(new Set(seen).size).toBe(FANOUT);
    // Page order is the handler's sorted total order.
    expect([...seen].sort()).toEqual(seen);
  });

  it('holds at SFI_MAX_RESPONSE_BYTES=6000 — the budget is DERIVED, not a constant', async () => {
    const prior = process.env['SFI_MAX_RESPONSE_BYTES'];
    process.env['SFI_MAX_RESPONSE_BYTES'] = '6000';
    try {
      const tight = toolLocalPayloadBudgetBytes();
      expect(tight).toBeLessThan(6_000);
      const r = await compareProfileAcrossVaultsHandler(fanCtx, {
        profileName: 'System Administrator',
        vaultA: 'prod',
        vaultB: 'sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(bytesOfData(r.value.data)).toBeLessThanOrEqual(tight);
      expect(r.value.data.summary.perCategoryDriftCount['fieldPermissions']).toBe(
        FANOUT,
      );
      // Exhaust the SMALL profile at the tight budget: the walk still closes
      // on the exact total, only with far more, far smaller pages (at 3 976
      // bytes the prose boundaries alone leave room for a single row).
      const seen = await walkAll('Support Agent', SMALL_FANOUT);
      expect(seen.length).toBe(SMALL_FANOUT);
      expect(new Set(seen).size).toBe(SMALL_FANOUT);
    } finally {
      if (prior === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
      else process.env['SFI_MAX_RESPONSE_BYTES'] = prior;
    }
  });

  it('a non-designated category is EMPTY on the page and disclosed as such, never as "no drift"', async () => {
    const r = await compareProfileAcrossVaultsHandler(fanCtx, {
      profileName: 'System Administrator',
      vaultA: 'prod',
      vaultB: 'sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grantDiffs.objectPermissions).toEqual([]);
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('that is a paging artifact, NOT "no drift"'),
      ),
    ).toBe(true);
  });
});

/**
 * G3 objection-3 acceptance test — THE GATE IS BOTH-SIDES, NOT EITHER-SIDE.
 *
 * Vault A is freshly refreshed (grant-count properties + grant edges); vault B
 * predates them. An OR gate would call the category "extracted" and emit one
 * fabricated "drift, side A only" row per grant. The BOTH-SIDES gate reports it
 * as not-evaluated, names the deficient vault, and emits NO rows.
 */
describe('compareProfileAcrossVaultsHandler — source present on ONE side only', () => {
  const ONE_SIDED_GRANTS = 40;
  let oneRoot: string;
  let oneStoreA: GraphStore;
  let oneStoreB: GraphStore;
  let oneCtx: Context;

  beforeAll(async () => {
    oneRoot = await mkdtemp(join(tmpdir(), 'sfi-compare-profile-onesided-'));
    const aPath = join(oneRoot, 'fresh');
    const bPath = join(oneRoot, 'stale');
    await mkdir(join(aPath, 'graph'), { recursive: true });
    await mkdir(join(bPath, 'graph'), { recursive: true });
    await saveManifest(aPath, FIXTURE_MANIFEST);
    await saveManifest(bPath, FIXTURE_MANIFEST);
    const oa = await openGraph(vaultPaths(aPath).graphDb);
    if (!oa.ok) throw new Error(oa.error.message);
    oneStoreA = oa.value;
    const ob = await openGraph(vaultPaths(bPath).graphDb);
    if (!ob.ok) throw new Error(ob.error.message);
    oneStoreB = ob.value;

    const fieldIds = Array.from(
      { length: ONE_SIDED_GRANTS },
      (_v, i) => `CustomField:Account.Only_${String(i).padStart(3, '0')}__c`,
    );
    await importExtractionResults(oneStoreA, [
      {
        nodes: [
          ...fieldIds.map((id) =>
            makeNode({
              id,
              type: 'CustomField',
              apiName: id.slice('CustomField:'.length),
            }),
          ),
          makeNode({
            id: PROFILE_ID,
            properties: {
              userLicense: 'Salesforce',
              fieldGrantCount: ONE_SIDED_GRANTS,
              tabVisibilities: [{ tab: 'Account', visibility: 'DefaultOn' }],
            },
          }),
        ],
        edges: fieldIds.map((id) =>
          makeGrantEdge(id, { editable: true, readable: true }),
        ),
      } as ExtractionResult,
    ]);
    // Vault B: same profile, refreshed BEFORE those properties existed.
    await importExtractionResults(oneStoreB, [
      {
        nodes: [
          makeNode({
            id: PROFILE_ID,
            properties: { userLicense: 'Salesforce', custom: false },
          }),
        ],
        edges: [],
      } as ExtractionResult,
    ]);
    await registerVault(oneRoot, 'fresh', aPath);
    await registerVault(oneRoot, 'stale', bPath);
    oneCtx = { vaultRoot: aPath, manifest: FIXTURE_MANIFEST, graph: oneStoreA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = oneRoot;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(oneStoreA);
    await closeGraph(oneStoreB);
    await rm(oneRoot, { recursive: true, force: true });
  });

  it('reports the category as not-evaluated, names the deficient vault, and emits NO drift rows', async () => {
    const r = await compareProfileAcrossVaultsHandler(oneCtx, {
      profileName: 'System Administrator',
      vaultA: 'fresh',
      vaultB: 'stale',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { notEvaluatedCategories, perCategoryDriftCount, totalDriftCount } =
      r.value.data.summary;
    // FAIL-BEFORE (the rejected OR gate): 40 fabricated "side A only" rows and
    // `fieldPermissions` absent from notEvaluatedCategories.
    expect(notEvaluatedCategories).toContain('fieldPermissions');
    expect(r.value.data.grantDiffs.fieldPermissions).toEqual([]);
    expect(
      Object.prototype.hasOwnProperty.call(perCategoryDriftCount, 'fieldPermissions'),
    ).toBe(false);
    expect(totalDriftCount).toBe(0);
    // The pre-existing one-sided `tabVisibilities` hole closes with it.
    expect(notEvaluatedCategories).toContain('tabVisibilities');
    expect(r.value.data.grantDiffs.tabVisibilities).toEqual([]);
    // The boundary NAMES the vault that lacks the source — and ONLY that vault
    // for this category (vault A does carry `fieldGrantCount`).
    expect(
      r.value.data.boundaries.some((b) =>
        b.includes(
          "`fieldPermissions` (source `fieldGrantCount`) missing in 'stale'",
        ),
      ),
    ).toBe(true);
    // A category absent on BOTH sides names both vaults, so the naming is not
    // a constant string.
    expect(
      r.value.data.boundaries.some((b) =>
        b.includes(
          "`objectPermissions` (source `objectGrantCount`) missing in 'fresh' and 'stale'",
        ),
      ),
    ).toBe(true);
  });
});

/**
 * G3 — an OLD vault on BOTH sides: no grant-count properties anywhere. Every
 * category is disclosed as not-evaluated rather than contributing a
 * measured-looking 0.
 */
describe('compareProfileAcrossVaultsHandler — an old vault with no grant-count properties', () => {
  let oldRoot: string;
  let oldStoreA: GraphStore;
  let oldStoreB: GraphStore;
  let oldCtx: Context;

  beforeAll(async () => {
    oldRoot = await mkdtemp(join(tmpdir(), 'sfi-old-vault-grants-'));
    const aPath = join(oldRoot, 'prod');
    const bPath = join(oldRoot, 'sandbox');
    await mkdir(join(aPath, 'graph'), { recursive: true });
    await mkdir(join(bPath, 'graph'), { recursive: true });
    await saveManifest(aPath, FIXTURE_MANIFEST);
    await saveManifest(bPath, FIXTURE_MANIFEST);
    const oa = await openGraph(vaultPaths(aPath).graphDb);
    if (!oa.ok) throw new Error(oa.error.message);
    oldStoreA = oa.value;
    const ob = await openGraph(vaultPaths(bPath).graphDb);
    if (!ob.ok) throw new Error(ob.error.message);
    oldStoreB = ob.value;
    const oldSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: PROFILE_ID,
          properties: { description: null, userLicense: 'Salesforce', custom: false },
        }),
      ],
      edges: [],
    };
    await importExtractionResults(oldStoreA, [oldSeed]);
    await importExtractionResults(oldStoreB, [oldSeed]);
    await registerVault(oldRoot, 'prod', aPath);
    await registerVault(oldRoot, 'sandbox', bPath);
    oldCtx = { vaultRoot: aPath, manifest: FIXTURE_MANIFEST, graph: oldStoreA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = oldRoot;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(oldStoreA);
    await closeGraph(oldStoreB);
    await rm(oldRoot, { recursive: true, force: true });
  });

  it('discloses every grant category as not-evaluated instead of reporting 0 drift', async () => {
    const r = await compareProfileAcrossVaultsHandler(oldCtx, {
      profileName: 'System Administrator',
      vaultA: 'prod',
      vaultB: 'sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { notEvaluatedCategories, perCategoryDriftCount, totalDriftCount } =
      r.value.data.summary;
    expect([...notEvaluatedCategories].sort()).toEqual([
      'apexClassAccesses',
      'fieldPermissions',
      'objectPermissions',
      'tabVisibilities',
      'userPermissions',
    ]);
    // No fabricated zeros: an un-evaluated category has NO count key at all.
    expect(Object.keys(perCategoryDriftCount)).toEqual([]);
    expect(Object.keys(r.value.data.counts)).toEqual([]);
    expect(totalDriftCount).toBe(0);
    expect(
      r.value.data.boundaries.some((b) =>
        b.includes('no grant-source property on this profile'),
      ),
    ).toBe(true);
  });
});

// Self-heal: once the extractor populates `properties.tabVisibilities`,
// the category leaves notEvaluatedCategories and is compared normally.
describe('compareProfileAcrossVaultsHandler — tabVisibilities self-heal', () => {
  let healRoot: string;
  let healStoreA: GraphStore;
  let healStoreB: GraphStore;
  let healCtx: Context;

  beforeAll(async () => {
    healRoot = await mkdtemp(join(tmpdir(), 'sfi-tabvis-heal-'));
    const aPath = join(healRoot, 'prod');
    const bPath = join(healRoot, 'sandbox');
    await mkdir(join(aPath, 'graph'), { recursive: true });
    await mkdir(join(bPath, 'graph'), { recursive: true });
    await saveManifest(aPath, FIXTURE_MANIFEST);
    await saveManifest(bPath, FIXTURE_MANIFEST);
    const oa = await openGraph(vaultPaths(aPath).graphDb);
    if (!oa.ok) throw new Error(oa.error.message);
    healStoreA = oa.value;
    const ob = await openGraph(vaultPaths(bPath).graphDb);
    if (!ob.ok) throw new Error(ob.error.message);
    healStoreB = ob.value;
    await importExtractionResults(healStoreA, [
      {
        nodes: [
          makeNode({
            id: 'Profile:System Administrator',
            properties: {
              tabVisibilities: [{ tab: 'Account', visibility: 'DefaultOn' }],
            },
          }),
        ],
        edges: [],
      } as ExtractionResult,
    ]);
    await importExtractionResults(healStoreB, [
      {
        nodes: [
          makeNode({
            id: 'Profile:System Administrator',
            properties: {
              tabVisibilities: [{ tab: 'Account', visibility: 'Hidden' }],
            },
          }),
        ],
        edges: [],
      } as ExtractionResult,
    ]);
    await registerVault(healRoot, 'prod', aPath);
    await registerVault(healRoot, 'sandbox', bPath);
    healCtx = { vaultRoot: aPath, manifest: FIXTURE_MANIFEST, graph: healStoreA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = healRoot;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(healStoreA);
    await closeGraph(healStoreB);
    await rm(healRoot, { recursive: true, force: true });
  });

  it('compares tabVisibilities when extracted and counts the drift', async () => {
    const r = await compareProfileAcrossVaultsHandler(healCtx, {
      profileName: 'System Administrator',
      vaultA: 'prod',
      vaultB: 'sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.notEvaluatedCategories).not.toContain(
      'tabVisibilities',
    );
    expect(r.value.data.summary.perCategoryDriftCount['tabVisibilities']).toBe(1);
    expect(
      r.value.data.grantDiffs.tabVisibilities.some((d) => d.targetId === 'Account'),
    ).toBe(true);
  });
});

/**
 * C-3 (finding 28) regression — `canonicalJson(undefined)` crash-class
 * sweep. `diffCategory`'s `inA`/`inB` presence guards mean no reachable
 * end-to-end fixture built from real (JSON-round-tripped) vault data can
 * trigger the `undefined` branch today (matching the audit's "latent, not
 * live" classification), so this exercises the exported helper directly —
 * proving the fix without waiting for a future caller to hit the landmine.
 */
describe('canonicalJson — C-3 (finding 28) regression', () => {
  it('returns a string sentinel for undefined instead of the raw JS `undefined` value', () => {
    const result = canonicalJson(undefined);
    expect(typeof result).toBe('string');
    expect(result).toBe('\0undefined\0');
  });

  it('the undefined sentinel does not collide with any real JSON value', () => {
    expect(canonicalJson(undefined)).not.toBe(canonicalJson(null));
    expect(canonicalJson(undefined)).not.toBe(canonicalJson('undefined'));
    expect(canonicalJson(undefined)).not.toBe(canonicalJson('\0undefined\0'));
  });

  it('an object with an explicit undefined property value does not throw', () => {
    const withUndefined = { a: 1, b: undefined as unknown };
    expect(() => canonicalJson(withUndefined)).not.toThrow();
    // `b`'s value canonicalizes to the sentinel, not the bare word `undefined`.
    expect(canonicalJson(withUndefined)).toContain('\0undefined\0');
  });
});
