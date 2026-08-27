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

  // FIND-COMPONENT-USAGES-SELF-MATCH: a component's own declaration/bundle
  // matches its own name just like a real caller would — measured on a real
  // vault, an ApexClass with ZERO graph referrers reported `grepMatchCount: 1`
  // and `hasStaticEvidence: true` off nothing but its own `public class …`
  // declaration line. Reproduced here with real files on disk (not a fixture
  // string) so the grep tier genuinely runs.
  describe('self-match exclusion (FIND-COMPONENT-USAGES-SELF-MATCH)', () => {
    beforeAll(async () => {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const src = join(dir, 'source', 'main', 'default');

      // A class with ZERO real referrers — its only grep hit is its own
      // declaration line, exactly the real-vault repro.
      mkdirSync(join(src, 'classes'), { recursive: true });
      writeFileSync(
        join(src, 'classes', 'Orphaned.cls'),
        'public class Orphaned {\n  public Orphaned() {}\n}\n',
      );

      // A class with a GENUINE external caller in a DIFFERENT file, plus a
      // self-instantiation inside its OWN file — the self-match must be
      // excluded while the real external reference survives.
      writeFileSync(
        join(src, 'classes', 'Used.cls'),
        'public class Used {\n  public Used() {}\n  public static Used self() { return new Used(); }\n}\n',
      );
      writeFileSync(
        join(src, 'classes', 'Caller.cls'),
        'public class Caller {\n  public void run() { Used u = new Used(); }\n}\n',
      );

      // An LWC bundle that references its OWN tag name inside its OWN
      // template (a different FILE, same bundle directory) — still its own
      // definition, not a caller.
      mkdirSync(join(src, 'lwc', 'selfWidget'), { recursive: true });
      writeFileSync(
        join(src, 'lwc', 'selfWidget', 'selfWidget.js'),
        'export default class SelfWidget {}\n',
      );
      writeFileSync(
        join(src, 'lwc', 'selfWidget', 'selfWidget.html'),
        '<template><!-- selfWidget renders selfWidget in dev tooling --></template>\n',
      );
      // A SEPARATE bundle that genuinely embeds selfWidget — a real caller.
      // (The grep tier is a literal api-name text match, not tag-name-aware,
      // so the reference has to spell the api name — an `import … from
      // 'c/selfWidget'` is exactly what a real LWC bundle contains.)
      mkdirSync(join(src, 'lwc', 'hostWidget'), { recursive: true });
      writeFileSync(
        join(src, 'lwc', 'hostWidget', 'hostWidget.html'),
        "<!-- import selfWidget from 'c/selfWidget' -->\n",
      );

      // Visualforce is NOT a bundle layout. `pages/` is FLAT — every page in
      // the org is a sibling in one directory — so "same directory" means
      // "different component", the exact opposite of what it means under
      // `lwc/` and `aura/`. CallerPage is a genuine external caller of
      // SelfPage that happens to live next to it.
      mkdirSync(join(src, 'pages'), { recursive: true });
      writeFileSync(
        join(src, 'pages', 'SelfPage.page'),
        '<apex:page>SelfPage body</apex:page>\n',
      );
      writeFileSync(
        join(src, 'pages', 'CallerPage.page'),
        '<apex:page><c:SelfPage /></apex:page>\n',
      );

      await importExtractionResults(store, [{
        nodes: [
          node({ id: 'ApexClass:Orphaned', type: 'ApexClass', apiName: 'Orphaned', sourcePath: 'source/main/default/classes/Orphaned.cls' }),
          node({ id: 'ApexClass:Used', type: 'ApexClass', apiName: 'Used', sourcePath: 'source/main/default/classes/Used.cls' }),
          node({ id: 'ApexClass:Caller', type: 'ApexClass', apiName: 'Caller', sourcePath: 'source/main/default/classes/Caller.cls' }),
          node({ id: 'LightningComponentBundle:selfWidget', type: 'LightningComponentBundle', apiName: 'selfWidget', sourcePath: 'source/main/default/lwc/selfWidget/selfWidget.js' }),
          node({ id: 'LightningComponentBundle:hostWidget', type: 'LightningComponentBundle', apiName: 'hostWidget', sourcePath: 'source/main/default/lwc/hostWidget/hostWidget.html' }),
          node({ id: 'VisualforcePage:SelfPage', type: 'VisualforcePage', apiName: 'SelfPage', sourcePath: 'source/main/default/pages/SelfPage.page' }),
          node({ id: 'VisualforcePage:CallerPage', type: 'VisualforcePage', apiName: 'CallerPage', sourcePath: 'source/main/default/pages/CallerPage.page' }),
        ],
        edges: [],
      }]);
    });

    it('FAIL-BEFORE/PASS-AFTER: a component with ZERO referrers does not report static evidence off its own declaration', async () => {
      const r = await findComponentUsagesHandler(ctx, { componentId: 'ApexClass:Orphaned' });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const d = r.value.data;
      // Pre-fix: matchCount 1 (its own `public class Orphaned {` line) and
      // hasStaticEvidence TRUE off nothing but that declaration.
      expect(d.grepSupplement.matchCount).toBe(0);
      expect(d.grepSupplement.selfMatchesExcluded).toBeGreaterThanOrEqual(1);
      expect(d.summary.grepMatchCount).toBe(0);
      expect(d.summary.hasStaticEvidence).toBe(false);
      // Distinguishes "grep ran and found only its own declaration" from
      // "grep did not run" — never a bare, unexplained false/zero.
      expect(d.grepSupplement.ran).toBe(true);
      expect(d.boundaries.join(' ')).toMatch(/OWN definition/i);
      expect(d.boundaries.join(' ')).toMatch(/no static evidence/i);
    });

    it('keeps a GENUINE external reference while excluding the self-instantiation in the same file', async () => {
      const r = await findComponentUsagesHandler(ctx, { componentId: 'ApexClass:Used' });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const d = r.value.data;
      expect(d.grepSupplement.selfMatchesExcluded).toBeGreaterThanOrEqual(1);
      const paths = d.grepSupplement.matches.map((m) => m.path);
      expect(paths.every((p) => !p.includes('Used.cls'))).toBe(true);
      expect(paths.some((p) => p.includes('Caller.cls'))).toBe(true);
      expect(d.summary.hasStaticEvidence).toBe(true);
    });

    /**
     * FIND-COMPONENT-USAGES-VF-FLAT-DIR — a regression introduced BY the
     * self-match fix above.
     *
     * `FRONTEND_DIR_RE` was doing two unrelated jobs with one pattern: bounding
     * the frontend grep WALK (where `pages`/`components` belong) and deciding
     * BUNDLE-ness for self-match exclusion (where they do not). `lwc/` and
     * `aura/` are genuine bundle layouts — `aura/MyCmp/MyCmp.cmp` — so "same
     * directory" means "same component". Visualforce is FLAT: every `.page` in
     * the org is a sibling in one `pages/` directory, so "same directory" means
     * "a DIFFERENT component".
     *
     * The consequence was that every real Visualforce caller was discarded as
     * a self-match, and the tool reported no static evidence — in the tool
     * people consult before deleting things. The 0.3.2 fix for over-counting
     * created an under-count.
     */
    it('FAIL-BEFORE/PASS-AFTER: a Visualforce caller in the SAME FLAT pages/ dir is a real referrer, not a self-match', async () => {
      const r = await findComponentUsagesHandler(ctx, { componentId: 'VisualforcePage:SelfPage' });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const d = r.value.data;
      const paths = d.grepSupplement.matches.map((m) => m.path);
      // The caller survives...
      expect(paths.some((p) => p.includes('CallerPage.page'))).toBe(true);
      expect(d.summary.hasStaticEvidence).toBe(true);
      // ...while the page's OWN file is still excluded. Both halves matter:
      // dropping the flat-directory rule entirely would resurrect the original
      // self-match bug for Visualforce.
      expect(paths.every((p) => !p.includes('SelfPage.page'))).toBe(true);
    });

    it('excludes a bundle self-reference from a DIFFERENT file in its OWN bundle directory', async () => {
      const r = await findComponentUsagesHandler(ctx, { componentId: 'LightningComponentBundle:selfWidget' });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const d = r.value.data;
      const paths = d.grepSupplement.matches.map((m) => m.path);
      // The mention inside selfWidget's OWN html (a different file, same
      // bundle dir) is excluded…
      expect(paths.some((p) => p.includes('lwc/selfWidget/'))).toBe(false);
      // …but the genuine embed from hostWidget survives.
      expect(paths.some((p) => p.includes('lwc/hostWidget/hostWidget.html'))).toBe(true);
      expect(d.summary.hasStaticEvidence).toBe(true);
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

// Access-grant section: grants stay OUT of graphReferrers (access is not
// usage), but a CustomPermission target — or a zero-usage target with incoming
// grantedBy edges — surfaces its granters SEPARATELY under `grantedBy`, so
// "which permission sets grant custom permission X?" stays answerable.
describe('grantedBy section (grants listed separately from usages)', () => {
  beforeAll(async () => {
    await importExtractionResults(store, [{
      nodes: [
        node({ id: 'CustomPermission:Bypass_Checks', type: 'CustomPermission', apiName: 'Bypass_Checks' }),
        node({ id: 'CustomPermission:Ungranted_Perm', type: 'CustomPermission', apiName: 'Ungranted_Perm' }),
        node({ id: 'PermissionSet:OpsAccess', type: 'PermissionSet', apiName: 'OpsAccess' }),
        node({ id: 'Profile:Support', type: 'Profile', apiName: 'Support' }),
        node({ id: 'ApexClass:ChecksSvc', type: 'ApexClass', apiName: 'ChecksSvc' }),
        node({ id: 'CustomField:Account.GrantOnly__c', type: 'CustomField', apiName: 'Account.GrantOnly__c' }),
      ],
      edges: [
        edge({ fromId: 'PermissionSet:OpsAccess', toId: 'CustomPermission:Bypass_Checks', edgeType: 'grantedBy' }),
        edge({ fromId: 'Profile:Support', toId: 'CustomPermission:Bypass_Checks', edgeType: 'grantedBy' }),
        // A code usage of the same custom permission — usage tier, not a grant.
        edge({ fromId: 'ApexClass:ChecksSvc', toId: 'CustomPermission:Bypass_Checks', edgeType: 'readsFrom', confidence: 'heuristic' }),
        // A field with ONLY a grant edge (zero usage) — the fallback trigger.
        edge({ fromId: 'Profile:Support', toId: 'CustomField:Account.GrantOnly__c', edgeType: 'grantedBy' }),
        // A granted-but-never-defined managed-package custom permission (phantom).
        edge({ fromId: 'PermissionSet:OpsAccess', toId: 'CustomPermission:Pkg_Only_Perm', edgeType: 'grantedBy' }),
      ],
    }]);
  });

  it('surfaces a CustomPermission\'s granting containers WITHOUT putting them in graphReferrers', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomPermission:Bypass_Checks', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.grantedBy).toEqual({
      count: 2,
      granters: [
        { id: 'PermissionSet:OpsAccess', type: 'PermissionSet' },
        { id: 'Profile:Support', type: 'Profile' },
      ],
    });
    // Grants never leak into the usage tier — only the Apex read is usage.
    const allRefs = d.graphReferrers.flatMap((g) => g.sample.map((s) => s.referrerId));
    expect(allRefs).toEqual(['ApexClass:ChecksSvc']);
    expect(allRefs).not.toContain('PermissionSet:OpsAccess');
    expect(allRefs).not.toContain('Profile:Support');
    expect(d.summary.graphReferrerCount).toBe(1);
    // The boundary explains grants are listed separately from usages.
    expect(d.boundaries.join(' ')).toMatch(/listed SEPARATELY/i);
  });

  it('surfaces grants for a zero-usage non-CustomPermission target (fallback trigger)', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomField:Account.GrantOnly__c', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.grantedBy).toEqual({
      count: 1,
      granters: [{ id: 'Profile:Support', type: 'Profile' }],
    });
    // Grants are NOT usage evidence — the empty≠absent honesty is unchanged.
    expect(d.summary.hasStaticEvidence).toBe(false);
    expect(d.boundaries.join(' ')).toMatch(/no static evidence/i);
  });

  it('OMITS the section when a non-CustomPermission target has usage edges (byte-identical to before)', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: FIELD, includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect('grantedBy' in r.value.data).toBe(false);
  });

  it('answers a granted-but-undefined (phantom) CustomPermission from its grant edges', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomPermission:Pkg_Only_Perm', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.target.retrieved).toBe(false);
    expect(d.grantedBy).toEqual({
      count: 1,
      granters: [{ id: 'PermissionSet:OpsAccess', type: 'PermissionSet' }],
    });
    expect(d.boundaries.join(' ')).toMatch(/PHANTOM/);
  });

  it('reports an explicit count-0 section for a CustomPermission nothing grants', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomPermission:Ungranted_Perm', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.grantedBy).toEqual({ count: 0, granters: [] });
    expect(r.value.data.summary.hasStaticEvidence).toBe(false);
  });
});

// FCU-EDGE-COUNT-READS-AS-REFERRER-COUNT. `graphReferrerCount` and each group's
// `count` are EDGE counts, but everything around them is named "referrer" and
// the sibling `grantedBy.count` in the SAME payload is a DISTINCT count — so
// the two numbers were not comparable despite reading the same. Measured on a
// real hub object: `{ referrerType: 'Flow', count: 77 }` where only 53 distinct
// Flows reference it (a 45% over-count), and the 25-row sample held just 20
// distinct flows because the cap is on rows.
describe('findComponentUsagesHandler — edge count vs distinct referrer count', () => {
  it('reports distinct referring COMPONENTS alongside the edge count', async () => {
    const multiDir = mkdtempSync(join(tmpdir(), 'sfi-fcu-multi-'));
    try {
      const o = await openGraph(join(multiDir, 'g.db'));
      expect(o.ok).toBe(true);
      if (!o.ok) return;
      const multiStore = o.value;
      const target = 'CustomObject:Widget__c';
      const i = await importExtractionResults(multiStore, [
        {
          nodes: [
            node({ id: target, type: 'CustomObject', apiName: 'Widget__c' }),
            node({ id: 'Flow:Busy', type: 'Flow', apiName: 'Busy' }),
            node({ id: 'Flow:Quiet', type: 'Flow', apiName: 'Quiet' }),
          ],
          edges: [
            // ONE flow, THREE relationships → 3 edges, 1 component.
            edge({ fromId: 'Flow:Busy', toId: target, edgeType: 'readsFrom' }),
            edge({ fromId: 'Flow:Busy', toId: target, edgeType: 'writesTo' }),
            edge({ fromId: 'Flow:Busy', toId: target, edgeType: 'triggersOn' }),
            edge({ fromId: 'Flow:Quiet', toId: target, edgeType: 'readsFrom' }),
          ],
        },
      ]);
      expect(i.ok).toBe(true);
      const multiCtx: Context = { vaultRoot: multiDir, manifest: MANIFEST, graph: multiStore };
      const r = await findComponentUsagesHandler(multiCtx, {
        componentId: target,
        includeGrep: false,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      // 4 edges…
      expect(d.summary.graphReferrerCount).toBe(4);
      const flows = d.graphReferrers.find((g) => g.referrerType === 'Flow');
      expect(flows?.count).toBe(4);
      // …from 2 distinct Flows. Quoting 4 to a human is the defect.
      expect(d.summary.distinctReferrerCount).toBe(2);
      expect(flows?.distinctReferrers).toBe(2);
      // And the response says so in prose, next to the numbers.
      expect(d.boundaries.join(' ')).toContain('EDGE counts, not component counts');
      expect(d.boundaries.join(' ')).toContain('4 edge(s) here come from 2 distinct');
      await closeGraph(multiStore);
    } finally {
      rmSync(multiDir, { recursive: true, force: true });
    }
  });
});
