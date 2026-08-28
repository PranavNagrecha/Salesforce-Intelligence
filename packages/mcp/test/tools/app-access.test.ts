/// <reference types="vitest/globals" />

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { appAccessHandler, type AppAccessGranterOutput, type AppAccessOutput } from '../../src/tools/app-access.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

const APP = 'CustomApplication:Sales';
const seed: ExtractionResult = {
  nodes: [
    node({ id: APP, type: 'CustomApplication', apiName: 'Sales', label: 'Sales', properties: { navType: 'Standard' } }),
    node({ id: 'CustomTab:Account', type: 'CustomTab', apiName: 'Account' }),
    node({ id: 'CustomTab:Deals__c', type: 'CustomTab', apiName: 'Deals__c' }),
    node({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin', properties: {
      applicationVisibilities: [{ application: 'Sales', default: true, visible: true }],
    } }),
    node({ id: 'Profile:NoSales', type: 'Profile', apiName: 'NoSales', properties: {
      applicationVisibilities: [{ application: 'Sales', default: false, visible: false }],
    } }),
    node({ id: 'PermissionSet:SalesPS', type: 'PermissionSet', apiName: 'SalesPS', properties: {
      applicationVisibilities: [{ application: 'Sales', default: false, visible: true }],
    } }),
  ],
  edges: [
    edge({ fromId: 'CustomTab:Deals__c', toId: APP, edgeType: 'belongsToApp', properties: { ordinal: 1 } }),
    edge({ fromId: 'CustomTab:Account', toId: APP, edgeType: 'belongsToApp', properties: { ordinal: 0 } }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-app-access-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('appAccessHandler', () => {
  it('rejects an id outside the app/granter contract', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'Flow:Nope' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('invalid-query');
  });

  // P14-APP-default-reverse — the INVERSE direction.
  it('answers a Profile id with its openable apps and default app', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'Profile:Admin' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessGranterOutput;
    expect(d.granterType).toBe('Profile');
    expect(d.openableApps).toEqual(['CustomApplication:Sales']);
    expect(d.defaultApp).toBe('CustomApplication:Sales');
  });

  it('a visible:false entry is NOT openable; no default → null', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'Profile:NoSales' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessGranterOutput;
    expect(d.openableApps).toEqual([]);
    expect(d.defaultApp).toBeNull();
  });

  it('a granter WITHOUT the extracted property answers "not modeled", never a verified empty', async () => {
    await importExtractionResults(store, [{
      nodes: [node({ id: 'Profile:Legacy', type: 'Profile', apiName: 'Legacy', properties: {} })],
      edges: [],
    }]);
    const r = await appAccessHandler(ctx, { componentId: 'Profile:Legacy' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessGranterOutput;
    expect(d.openableApps).toEqual([]);
    expect(d.boundaryNote).toMatch(/not modeled/i);
  });

  it('rejects a PermissionSetGroup id with the honest union explanation', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'PermissionSetGroup:Sales_PSG' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/UNION of its member permission sets/);
  });
  it('returns component-not-found for an unknown app', async () => {
    const r = await appAccessHandler(ctx, { componentId: 'CustomApplication:Nope' });
    expect(r.ok).toBe(false); if (r.ok) return; expect(r.error.kind).toBe('component-not-found');
  });
  it('returns navType, tabs (ordinal order), who can open + who defaults', async () => {
    const r = await appAccessHandler(ctx, { componentId: APP });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessOutput;
    expect(d.navType).toBe('Standard');
    expect(d.tabs).toEqual(['CustomTab:Account', 'CustomTab:Deals__c']); // ordinal 0,1
    // Admin + SalesPS can open (visible:true); NoSales cannot (visible:false).
    expect(d.canOpen.map((g) => g.granterId).sort()).toEqual(['PermissionSet:SalesPS', 'Profile:Admin']);
    expect(d.defaultedBy).toEqual(['Profile:Admin']);
    expect(d.summary.tabs).toBe(2);
  });

  it('does NOT flag scanTruncated when the scan fits under the cap (P12-HONESTY-scan-cap-disclosure)', async () => {
    const r = await appAccessHandler(ctx, { componentId: APP });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect((r.value.data as AppAccessOutput).scanTruncated).toBe(false);
    expect(r.value.data.boundaryNote).not.toMatch(/Scan capped/);
  });

  // CR-22 B3: a low cap no longer drops the scan tail — it windows the scan and
  // still reaches every grantor, including ones in the SECOND scanned type.
  it('FAIL-BEFORE/PASS-AFTER: a cap of 1 still reaches a grantor in the SECOND scanned type', async () => {
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await appAccessHandler(ctx, { componentId: APP, limit: 500 });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const d = r.value.data as AppAccessOutput;
      // Both grantors found even at cap 1 — PermissionSet:SalesPS lives in the
      // SECOND scanned type (the pre-B3 unreachable tail).
      expect(d.canOpen.map((g) => g.granterId).sort()).toEqual([
        'PermissionSet:SalesPS',
        'Profile:Admin',
      ]);
      // The completed full scan does NOT claim INCOMPLETE.
      expect(d.scanTruncated).toBe(false);
      expect(d.boundaryNote).not.toMatch(/Scan capped/);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });

  it('SFI_NODE_SCAN_LIMIT > 500 no longer hard-errors (RV10-style clamp while touched)', async () => {
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '600';
    try {
      const r = await appAccessHandler(ctx, { componentId: APP });
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect((r.value.data as AppAccessOutput).summary.canOpen).toBe(2);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });

  // CR-22 output cursor.
  it('whole-fits no-cursor call omits nextCursor/pageInfo (byte-identical)', async () => {
    const r = await appAccessHandler(ctx, { componentId: APP });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await appAccessHandler(ctx, { componentId: APP, limit: 500 });
    expect(all.ok).toBe(true); if (!all.ok) return;
    const fullOrder = (all.value.data as AppAccessOutput).canOpen.map((g) => g.granterId);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await appAccessHandler(
        ctx,
        cursor !== undefined ? { componentId: APP, limit: 1, cursor } : { componentId: APP, limit: 1 },
      );
      expect(page.ok).toBe(true); if (!page.ok) return;
      const d = page.value.data as AppAccessOutput;
      for (const g of d.canOpen) seen.push(g.granterId);
      if (d.nextCursor === undefined) break;
      cursor = d.nextCursor;
      guard += 1;
      if (guard > 20) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  // APP-ACCESS-REJECTS-NATURAL-ARGS — the router ranks app_access #1 for
  // "who can use the Sales app?" but the host had no natural app-name arg.
  it('accepts a natural `apiName` alias ≡ explicit CustomApplication componentId (byte-identical payload + appliedScope)', async () => {
    const canonical = await appAccessHandler(ctx, { componentId: APP });
    const alias = await appAccessHandler(ctx, { apiName: 'Sales' });
    expect(canonical.ok && alias.ok).toBe(true);
    if (!canonical.ok || !alias.ok) return;
    const c = canonical.value.data as AppAccessOutput;
    const a = alias.value.data as AppAccessOutput;
    // Canonical path carries NO appliedScope (byte-identical).
    expect('appliedScope' in (c as unknown as Record<string, unknown>)).toBe(false);
    // Alias path resolves the SAME app and echoes how it got there.
    expect(a.appliedScope).toEqual({ componentId: APP, resolvedFrom: 'apiName', matched: 'Sales' });
    // The access payload MINUS appliedScope is identical to the canonical call.
    const { appliedScope: _drop, ...aCore } = a as AppAccessOutput & Record<string, unknown>;
    expect(aCore).toEqual(c);
  });

  it('accepts `app` / `application` aliases too', async () => {
    for (const input of [{ app: 'Sales' }, { application: 'Sales' }]) {
      const r = await appAccessHandler(ctx, input);
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect((r.value.data as AppAccessOutput).componentId).toBe(APP);
    }
  });

  it('accepts a fuzzy `nameContains` app-label search (case/separator-insensitive)', async () => {
    const r = await appAccessHandler(ctx, { nameContains: 'sale' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessOutput;
    expect(d.componentId).toBe(APP);
    expect(d.appliedScope?.resolvedFrom).toBe('nameContains');
  });

  it('an ambiguous name returns an honest pick list, never a silent pick', async () => {
    await importExtractionResults(store, [{
      nodes: [
        node({ id: 'CustomApplication:Sales_Console', type: 'CustomApplication', apiName: 'Sales_Console', label: 'Sales Console', properties: { navType: 'Console' } }),
      ],
      edges: [],
    }]);
    // "sale" substring-matches BOTH apps but exact-matches neither → ambiguous.
    const r = await appAccessHandler(ctx, { nameContains: 'sale' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/matches 2 apps/);
    expect(r.error.message).toMatch(/CustomApplication:Sales\b/);
    expect(r.error.message).toMatch(/CustomApplication:Sales_Console/);
  });

  it('an unresolvable natural name returns a NAMED component-not-found (not "componentId Required")', async () => {
    const r = await appAccessHandler(ctx, { apiName: 'DefinitelyNotAnApp' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toMatch(/DefinitelyNotAnApp/);
  });

  it('no selector at all refuses with a named invalid-query, not a bare Zod "Required"', async () => {
    const r = await appAccessHandler(ctx, {});
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/name the app/);
  });

  it('rejects a cursor minted for a DIFFERENT app (argsFingerprint bind)', async () => {
    const first = await appAccessHandler(ctx, { componentId: APP, limit: 1 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const cursor = (first.value.data as AppAccessOutput).nextCursor;
    if (typeof cursor !== 'string') return; // only one grantor → no cursor
    const replay = await appAccessHandler(ctx, { componentId: 'CustomApplication:Other', cursor });
    expect(replay.ok).toBe(false); if (replay.ok) return;
    // Either component-not-found (decode happens after node lookup) or
    // invalid-query (cursor rejected) — both prove the token can't cross apps.
    expect(['invalid-query', 'component-not-found']).toContain(replay.error.kind);
  });
});

/**
 * R1 — PARTIAL extraction of `applicationVisibilities`.
 *
 * The pre-fix handler decided the boundaryNote from a whole-corpus OR
 * (`anyGranterHadAppVis`): one granter carrying the property was enough to
 * select the CONFIDENT wording, while every granter that did NOT carry it was
 * silently `continue`d out of the scan. On a vault where most containers were
 * extracted and one was not, the missing one contributes nothing to `canOpen`
 * and the note still asserts the list was computed from
 * `applicationVisibilities` — a missed grant in a security tool.
 *
 * Own store: the shared fixture above mutates as tests run (one case imports a
 * property-less Profile into it), so the partial/whole cases are isolated here.
 */
describe('appAccessHandler — partial applicationVisibilities extraction (R1)', () => {
  const APP2 = 'CustomApplication:Finance';
  let dir2: string; let store2: GraphStore; let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-app-access-partial-'));
    const o = await openGraph(join(dir2, 'g.db')); if (!o.ok) throw new Error(o.error.message);
    store2 = o.value;
    const i = await importExtractionResults(store2, [{
      nodes: [
        node({ id: APP2, type: 'CustomApplication', apiName: 'Finance', label: 'Finance', properties: { navType: 'Standard' } }),
        // Extracted AND grants — the container that makes the whole-corpus OR true.
        node({ id: 'Profile:Extracted', type: 'Profile', apiName: 'Extracted', properties: {
          applicationVisibilities: [{ application: 'Finance', default: false, visible: true }],
        } }),
        // Extracted and CLEAN — a real verified "cannot open".
        node({ id: 'Profile:ExtractedClean', type: 'Profile', apiName: 'ExtractedClean', properties: {
          applicationVisibilities: [],
        } }),
        // NEVER extracted — the blind spot. Its real grants are unknown.
        node({ id: 'Profile:NeverExtracted', type: 'Profile', apiName: 'NeverExtracted', properties: {} }),
        node({ id: 'PermissionSet:NeverExtractedPS', type: 'PermissionSet', apiName: 'NeverExtractedPS', properties: {} }),
      ],
      edges: [],
    }]);
    if (!i.ok) throw new Error(i.error.message);
    ctx2 = { vaultRoot: dir2, manifest: MANIFEST, graph: store2 };
  });
  afterAll(async () => { await closeGraph(store2); rmSync(dir2, { recursive: true, force: true }); });

  it('PARTIAL extraction is disclosed and ENUMERATES the un-extracted containers', async () => {
    const r = await appAccessHandler(ctx2, { componentId: APP2 });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessOutput;
    // The one extracted grant is still returned...
    expect(d.canOpen.map((g) => g.granterId)).toEqual(['Profile:Extracted']);
    // ...but the answer must NOT be presented as a complete who-can-open list.
    expect(d.boundaryNote).toMatch(/App visibility was NOT checked/);
    expect(d.boundaryNote).toContain('Profile:NeverExtracted');
    expect(d.boundaryNote).toContain('PermissionSet:NeverExtractedPS');
    expect(d.boundaryNote).toMatch(/not modeled/i);
    // The container that WAS extracted and holds none is a verified empty and
    // must NOT be named as a blind spot.
    expect(d.boundaryNote).not.toContain('Profile:ExtractedClean');
    // The confident sentence still explains how the shown rows were computed.
    expect(d.boundaryNote).toMatch(/computed from profile\/permission-set applicationVisibilities/);
  });

  it('a container whose property is present but GARBLED is a blind spot, not a silent skip', async () => {
    const i = await importExtractionResults(store2, [{
      nodes: [node({ id: 'Profile:Garbled', type: 'Profile', apiName: 'Garbled', properties: {
        applicationVisibilities: 'not-an-array',
      } })],
      edges: [],
    }]);
    expect(i.ok).toBe(true);
    const r = await appAccessHandler(ctx2, { componentId: APP2 });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect((r.value.data as AppAccessOutput).boundaryNote).toContain('Profile:Garbled');
  });
});

/**
 * R1 — the FULLY-extracted vault must stay confident (no false alarm).
 */
describe('appAccessHandler — fully extracted vault stays confident (R1)', () => {
  const APP3 = 'CustomApplication:Ops';
  let dir3: string; let store3: GraphStore; let ctx3: Context;
  beforeAll(async () => {
    dir3 = mkdtempSync(join(tmpdir(), 'sfi-app-access-full-'));
    const o = await openGraph(join(dir3, 'g.db')); if (!o.ok) throw new Error(o.error.message);
    store3 = o.value;
    const i = await importExtractionResults(store3, [{
      nodes: [
        node({ id: APP3, type: 'CustomApplication', apiName: 'Ops', label: 'Ops', properties: { navType: 'Standard' } }),
        node({ id: 'Profile:A', type: 'Profile', apiName: 'A', properties: {
          applicationVisibilities: [{ application: 'Ops', default: true, visible: true }],
        } }),
        node({ id: 'Profile:B', type: 'Profile', apiName: 'B', properties: { applicationVisibilities: [] } }),
      ],
      edges: [],
    }]);
    if (!i.ok) throw new Error(i.error.message);
    ctx3 = { vaultRoot: dir3, manifest: MANIFEST, graph: store3 };
  });
  afterAll(async () => { await closeGraph(store3); rmSync(dir3, { recursive: true, force: true }); });

  it('no container is named as a blind spot when every container carries the property', async () => {
    const r = await appAccessHandler(ctx3, { componentId: APP3 });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessOutput;
    expect(d.canOpen.map((g) => g.granterId)).toEqual(['Profile:A']);
    expect(d.boundaryNote).not.toMatch(/NOT checked/);
    expect(d.boundaryNote).not.toMatch(/not modeled,/);
    expect(d.boundaryNote).toMatch(/computed from profile\/permission-set applicationVisibilities/);
  });
});

/**
 * R6 — the two hand-rolled case-1 wordings named in `absence-disclosure.ts`'s
 * own header ("`app-access.ts` ×2") must be DELETED, not reworded. A deny-list
 * drift guard modelled on `full-scan-adoption.test.ts`: the remediation
 * sentence may only come from the shared builder, so it must not appear as a
 * literal in this file at all.
 */
describe('app-access absence-disclosure adoption (R6 drift guard)', () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/tools/app-access.ts'),
    'utf8',
  );

  it('imports the shared case-1 builders', () => {
    expect(SRC).toMatch(/from '\.\/absence-disclosure\.js'/);
    expect(SRC).toContain('familyWasExtracted');
    expect(SRC).toContain('notExtractedFamilyDisclosure');
  });

  it('carries no hand-rolled case-1 sentence', () => {
    expect(/never a verified empty/i.test(SRC)).toBe(false);
    expect(/sfi-refresh/i.test(SRC)).toBe(false);
  });

  it('does not decide extraction from Array.isArray on applicationVisibilities', () => {
    expect(/anyGranterHadAppVis/.test(SRC)).toBe(false);
    expect(/const hasVis = Array\.isArray/.test(SRC)).toBe(false);
  });
});

/**
 * R6 — the INVERSE (granter) direction's own hand-rolled case-1 sentence.
 * It had drifted from its sibling at the app path (it named a version cutoff
 * the other did not) and enumerated no container id. It must now render the
 * shared builder's fixed template, naming the granter it is talking about.
 */
describe('appAccessHandler — granter direction uses the shared case-1 builder (R6)', () => {
  let dir4: string; let store4: GraphStore; let ctx4: Context;
  beforeAll(async () => {
    dir4 = mkdtempSync(join(tmpdir(), 'sfi-app-access-granter-'));
    const o = await openGraph(join(dir4, 'g.db')); if (!o.ok) throw new Error(o.error.message);
    store4 = o.value;
    const i = await importExtractionResults(store4, [{
      nodes: [
        node({ id: 'Profile:NoProp', type: 'Profile', apiName: 'NoProp', properties: {} }),
        node({ id: 'PermissionSet:Clean', type: 'PermissionSet', apiName: 'Clean', properties: { applicationVisibilities: [] } }),
      ],
      edges: [],
    }]);
    if (!i.ok) throw new Error(i.error.message);
    ctx4 = { vaultRoot: dir4, manifest: MANIFEST, graph: store4 };
  });
  afterAll(async () => { await closeGraph(store4); rmSync(dir4, { recursive: true, force: true }); });

  it('a granter with NO property renders the shared template and names itself', async () => {
    const r = await appAccessHandler(ctx4, { componentId: 'Profile:NoProp' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessGranterOutput;
    expect(d.openableApps).toEqual([]);
    expect(d.boundaryNote).toMatch(/App visibility was NOT checked/);
    expect(d.boundaryNote).toContain('Profile:NoProp');
    expect(d.boundaryNote).toMatch(/not modeled/i);
  });

  it('a granter that WAS extracted and holds none is a verified empty, not a blind spot', async () => {
    const r = await appAccessHandler(ctx4, { componentId: 'PermissionSet:Clean' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data as AppAccessGranterOutput;
    expect(d.openableApps).toEqual([]);
    expect(d.boundaryNote).not.toMatch(/NOT checked/);
  });
});
