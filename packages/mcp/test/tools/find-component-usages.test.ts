/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { findComponentUsagesHandler } from '../../src/tools/find-component-usages.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0', refreshedAt: '2026-06-09T00:00:00Z', sourceOrg: 'me@example.com',
  components: {}, edges: {}, sourceTreeHash: 'sha256:fixture',
};
const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

const FIELD = 'CustomField:Account.Industry__c';
const seed: ExtractionResult = {
  nodes: [
    node({ id: FIELD, type: 'CustomField', apiName: 'Account.Industry__c' }),
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({ id: 'ApexClass:AccountSvc', type: 'ApexClass', apiName: 'AccountSvc' }),
    node({ id: 'Flow:LeadConvert', type: 'Flow', apiName: 'LeadConvert' }),
    node({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    node({ id: 'CustomField:Account.Orphan__c', type: 'CustomField', apiName: 'Account.Orphan__c' }),
  ],
  edges: [
    // usage edges (kept):
    edge({ fromId: 'ApexClass:AccountSvc', toId: FIELD, edgeType: 'readsFrom', confidence: 'heuristic' }),
    edge({ fromId: 'Flow:LeadConvert', toId: FIELD, edgeType: 'writesTo', confidence: 'parsed' }),
    // access + structural edges (MUST be excluded — access is not usage):
    edge({ fromId: 'Profile:Admin', toId: FIELD, edgeType: 'grantedBy' }),
    edge({ fromId: 'CustomObject:Account', toId: FIELD, edgeType: 'parentOf' }),
  ],
};

let dir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-fcu-'));
  const o = await openGraph(join(dir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(dir, { recursive: true, force: true }); });

describe('findComponentUsagesHandler', () => {
  it('returns graph referrers grouped by type, EXCLUDING access (grantedBy) + structural (parentOf) edges', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: FIELD, includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.graphReferrerCount).toBe(2); // readsFrom + writesTo only
    expect([...d.summary.referrerTypes].sort()).toEqual(['ApexClass', 'Flow']);
    expect(d.summary.hasStaticEvidence).toBe(true);
    // The Profile grant + Account parentOf must NOT appear.
    const allRefs = d.graphReferrers.flatMap((g) => g.sample.map((s) => s.referrerId));
    expect(allRefs).not.toContain('Profile:Admin');
    expect(allRefs).not.toContain('CustomObject:Account');
    // Edge confidence is surfaced.
    expect(d.graphReferrers.flatMap((g) => g.sample.map((s) => s.confidence))).toContain('heuristic');
  });

  it('discloses empty ≠ absent (no static evidence) instead of claiming nothing uses it', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomField:Account.Orphan__c', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.summary.hasStaticEvidence).toBe(false);
    expect(r.value.data.boundaries.join(' ')).toMatch(/no static evidence/i);
    expect(r.value.data.boundaries.join(' ')).not.toMatch(/nothing uses this/i);
  });

  it('rejects a non-canonical id with invalid-query', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'NotCanonical' });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns component-not-found for an id with no node AND no referrers', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomField:Ghost.Nope__c', includeGrep: false });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('answers a PHANTOM target (no node, but incoming edges) with a phantom boundary', async () => {
    // Add an edge pointing at a not-retrieved target.
    await importExtractionResults(store, [{
      nodes: [node({ id: 'ApexClass:Caller', type: 'ApexClass', apiName: 'Caller' })],
      edges: [edge({ fromId: 'ApexClass:Caller', toId: 'CustomObject:hed__Phantom__c', edgeType: 'readsFrom' })],
    }]);
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomObject:hed__Phantom__c', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.target.retrieved).toBe(false);
    expect(r.value.data.summary.graphReferrerCount).toBe(1);
    expect(r.value.data.boundaries.join(' ')).toMatch(/PHANTOM/);
  });

  // P14-USAGE-grep-frontend: the grep tier covers LWC/Aura/VF bundle source,
  // bounded to the bundle directories — an unzipped static resource's own
  // payload must never flood the matches.
  describe('frontend grep tier', () => {
    beforeAll(async () => {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const src = join(dir, 'source', 'main', 'default');
      mkdirSync(join(src, 'lwc', 'welcomeBanner'), { recursive: true });
      writeFileSync(
        join(src, 'lwc', 'welcomeBanner', 'welcomeBanner.js'),
        "import WELCOME from '@salesforce/label/c.Welcome_Message';\nexport default class WelcomeBanner {}\n",
      );
      mkdirSync(join(src, 'aura', 'brandHeader'), { recursive: true });
      writeFileSync(
        join(src, 'aura', 'brandHeader', 'brandHeader.cmp'),
        '<aura:component><img src="{!$Resource.BrandLogo}"/></aura:component>\n',
      );
      // An UNZIPPED static resource payload mentioning the same names — its
      // path is outside the bundle dirs and must be excluded.
      mkdirSync(join(src, 'staticresources', 'BrandLogoLib'), { recursive: true });
      writeFileSync(
        join(src, 'staticresources', 'BrandLogoLib', 'vendored.js'),
        '// BrandLogo Welcome_Message internals — not a usage\n',
      );
      await importExtractionResults(store, [{
        nodes: [
          node({ id: 'CustomLabel:Welcome_Message', type: 'CustomLabel', apiName: 'Welcome_Message' }),
          node({ id: 'StaticResource:BrandLogo', type: 'StaticResource', apiName: 'BrandLogo' }),
        ],
        edges: [],
      }]);
    });

    it('finds an LWC @salesforce/label import for a CustomLabel', async () => {
      const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomLabel:Welcome_Message' });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const d = r.value.data;
      const paths = d.grepSupplement.matches.map((m) => m.path);
      expect(paths.some((p) => p.includes('lwc/welcomeBanner/welcomeBanner.js'))).toBe(true);
      // The static-resource payload mentioning the label is NOT a usage.
      expect(paths.some((p) => p.includes('staticresources/'))).toBe(false);
      expect(d.summary.hasStaticEvidence).toBe(true);
      // The boundary names the widened tier.
      expect(d.boundaries.join(' ')).toMatch(/frontend bundle source/i);
    });

    it('finds an Aura $Resource reference for a StaticResource, excluding the resource payload itself', async () => {
      const r = await findComponentUsagesHandler(ctx, { componentId: 'StaticResource:BrandLogo' });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const paths = r.value.data.grepSupplement.matches.map((m) => m.path);
      expect(paths.some((p) => p.includes('aura/brandHeader/brandHeader.cmp'))).toBe(true);
      expect(paths.some((p) => p.includes('staticresources/'))).toBe(false);
    });
  });
});

// P14-USAGE-flow-object-boundaries: the four families the §C3 audit flagged
// get a UNIFORM type-specific blind-spot note on an empty result — the
// generic empty≠absent line alone doesn't name the family's known hole.
describe('type-specific empty boundaries', () => {
  const seeded = [
    ['Flow:Orphan_Flow', 'Flow', /launch points/i],
    ['CustomObject:Orphan_Object__c', 'CustomObject', /list-view filters|standard objects/i],
    ['RecordType:Account.Orphan_RT', 'RecordType', /assignments are access/i],
    ['ValidationRule:Account.Orphan_VR', 'ValidationRule', /expected shape/i],
    ['ListView:Account.Orphan_LV', 'ListView', /list_view_sharing/i],
  ] as const;

  beforeAll(async () => {
    await importExtractionResults(store, [{
      nodes: seeded.map(([id, type]) =>
        node({ id, type: type as Node['type'], apiName: id.split(':')[1] ?? id })),
      edges: [],
    }]);
  });

  for (const [id, type, notePattern] of seeded) {
    it(`appends the ${type} blind-spot note on a zero-usage result`, async () => {
      const r = await findComponentUsagesHandler(ctx, { componentId: id, includeGrep: false });
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.value.data.summary.hasStaticEvidence).toBe(false);
      const joined = r.value.data.boundaries.join(' ');
      expect(joined).toMatch(/no static evidence/i);
      expect(joined).toMatch(notePattern);
    });
  }

  it('does NOT append a type note for families outside the recipe map', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomField:Account.Orphan__c', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).not.toMatch(/launch points|assignments are access|expected shape/i);
  });
});
