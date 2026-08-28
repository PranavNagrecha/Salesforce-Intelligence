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

      // REAL-SHAPE bundle: `extractLightningComponentBundle` /
      // `extractAuraDefinitionBundle` are handed the bundle DIRECTORY (they
      // `stat` it and refuse a non-directory) and persist it verbatim as
      // `sourcePath`, so a real vault stores `.../lwc/realWidget` — NOT a file
      // inside it. The two fixtures above use the file shape; this pair uses
      // the shape the extractor actually writes.
      mkdirSync(join(src, 'lwc', 'realWidget'), { recursive: true });
      writeFileSync(
        join(src, 'lwc', 'realWidget', 'realWidget.js'),
        '// realWidget internal\nexport default class RealWidget {}\n',
      );
      mkdirSync(join(src, 'lwc', 'realHost'), { recursive: true });
      writeFileSync(
        join(src, 'lwc', 'realHost', 'realHost.html'),
        "<!-- import realWidget from 'c/realWidget' -->\n",
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
          node({ id: 'LightningComponentBundle:realWidget', type: 'LightningComponentBundle', apiName: 'realWidget', sourcePath: 'source/main/default/lwc/realWidget' }),
          node({ id: 'LightningComponentBundle:realHost', type: 'LightningComponentBundle', apiName: 'realHost', sourcePath: 'source/main/default/lwc/realHost' }),
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

    /**
     * FIND-COMPONENT-USAGES-BUNDLE-DIR-SOURCEPATH — the SAME flat-directory
     * over-exclusion as the Visualforce case above, still live for LWC/Aura,
     * hidden because the fixtures used a file path the extractor never writes.
     *
     * `extractLightningComponentBundle` / `extractAuraDefinitionBundle` take
     * the bundle DIRECTORY, assert it IS a directory, and store it verbatim as
     * `sourcePath`. So a real node carries `source/main/default/lwc/realWidget`
     * with no file. Slicing that to its last `/` yields `.../lwc/` — the parent
     * of EVERY bundle in the org — and every genuine LWC/Aura caller was
     * dropped as "this component's own definition", pushing the tool to
     * "No static evidence of usage found in this vault" for a component another
     * bundle actively imports.
     */
    it('FAIL-BEFORE/PASS-AFTER: a caller in a SIBLING bundle survives when sourcePath is the bundle DIRECTORY (the real extractor shape)', async () => {
      const r = await findComponentUsagesHandler(ctx, { componentId: 'LightningComponentBundle:realWidget' });
      expect(r.ok).toBe(true); if (!r.ok) return;
      const d = r.value.data;
      const paths = d.grepSupplement.matches.map((m) => m.path);
      // The sibling bundle that imports it is a real caller...
      expect(paths.some((p) => p.includes('lwc/realHost/realHost.html'))).toBe(true);
      expect(d.summary.hasStaticEvidence).toBe(true);
      // ...while its OWN bundle directory is still excluded, so the
      // directory rule is narrowed, not dropped.
      expect(paths.some((p) => p.includes('lwc/realWidget/'))).toBe(false);
      expect(d.grepSupplement.selfMatchesExcluded).toBeGreaterThanOrEqual(1);
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

// FCU-WRONG-CASE-ID-READS-AS-ABSENT. The universal usage dispatcher receives
// whatever string a host LLM was handed — including a name read off a
// spreadsheet in the wrong case. Measured on a real vault: the exactly-cased id
// returned a full answer, the SAME id lower-cased returned
// `component-not-found` with a message and payload byte-identical to the one a
// FABRICATED one-character typo produced. A caller could not tell "you
// mis-typed the case of something real" from "this does not exist", and the
// natural host recovery is to report an ACTIVE component absent from the org.
// `sfi.resolve` resolves the same lower-cased string to `exact` on the same
// vault, so the product already held the resolver.
describe('findComponentUsagesHandler — wrong-CASE component id', () => {
  beforeAll(async () => {
    await importExtractionResults(store, [{
      nodes: [
        // Two nodes differing ONLY by case: case-insensitive RESOLUTION must
        // never become case-insensitive IDENTITY.
        node({ id: 'Flow:Dup_Case_Flow', type: 'Flow', apiName: 'Dup_Case_Flow' }),
        node({ id: 'Flow:dup_case_flow', type: 'Flow', apiName: 'dup_case_flow' }),
        // Same api name, DIFFERENT type — case folding must not cross types.
        node({ id: 'ApexClass:LeadConvert', type: 'ApexClass', apiName: 'LeadConvert' }),
      ],
      edges: [],
    }]);
  });

  it('answers a real component named in the wrong CASE instead of refusing it as absent', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'Flow:leadconvert', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.target.componentId).toBe('Flow:LeadConvert');
    expect(d.target.apiName).toBe('LeadConvert');
    // The correction is DISCLOSED — the answer is about a different id than
    // the caller passed, and a host must be able to say so.
    expect(d.target.resolvedFrom).toBe('Flow:leadconvert');
    expect(d.boundaries.join(' ')).toMatch(/case/i);
  });

  it('resolves a mis-cased TYPE PREFIX too (a SQL type filter is case-sensitive)', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'flow:LeadConvert', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.target.componentId).toBe('Flow:LeadConvert');
    // The type-driven behaviour below must key off the RESOLVED prefix.
    expect(r.value.data.target.type).toBe('Flow');
    expect(r.value.data.target.resolvedFrom).toBe('flow:LeadConvert');
  });

  it('does NOT fold across types — a same-named node of another type is not the answer', async () => {
    // `ApexClass:LeadConvert` exists; asking for `CustomObject:leadconvert`
    // must still refuse rather than answer about the class.
    const r = await findComponentUsagesHandler(ctx, { componentId: 'CustomObject:leadconvert', includeGrep: false });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  // The graph stores a CHILD-scoped node's `api_name` as the BARE leaf
  // (`CustomField:Object.Field__c` has `api_name` = `Field__c`; the object
  // lives in the id). A probe that searched the QUALIFIED name matched nothing
  // on a real vault, leaving every field / record type / validation rule / list
  // view immune to this repair while the flat families looked fixed.
  it('resolves a mis-cased CHILD-scoped id (CustomField), whose api_name is the bare leaf', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'customfield:account.industry__c', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.target.componentId).toBe(FIELD);
    expect(r.value.data.target.resolvedFrom).toBe('customfield:account.industry__c');
    // …and the corrected id gets the REAL answer, not an empty one.
    expect(r.value.data.summary.graphReferrerCount).toBe(2);
  });

  it('keeps refusing a fabricated typo, and the refusal SAYS case variants were checked', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'Flow:LeadConverx', includeGrep: false });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    // Distinguishable from the wrong-case case, which now answers.
    expect(r.error.message).toMatch(/case/i);
  });

  it('REFUSES rather than guesses when two vault ids differ only by case', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'Flow:DUP_CASE_FLOW', includeGrep: false });
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/differ only by CASE/i);
    expect(r.error.message).toContain('Flow:Dup_Case_Flow');
    expect(r.error.message).toContain('Flow:dup_case_flow');
  });

  it('calls a SATURATED probe inconclusive rather than reporting a checked absence', async () => {
    // The probe reads a bounded window of name matches. Seed enough same-leaf
    // components to fill it, with the real (differently-cased) target sorting
    // PAST the window — the refusal must say the probe could not rule a case
    // variant out, never that there is none.
    const satDir = mkdtempSync(join(tmpdir(), 'sfi-fcu-sat-'));
    try {
      const o = await openGraph(join(satDir, 'g.db'));
      expect(o.ok).toBe(true); if (!o.ok) return;
      const satStore = o.value;
      const decoys = Array.from({ length: 100 }, (_, i) => {
        const obj = `Obj_${String(i).padStart(3, '0')}__c`;
        return node({ id: `CustomField:${obj}.Shared_Leaf__c`, type: 'CustomField', apiName: 'Shared_Leaf__c' });
      });
      const i = await importExtractionResults(satStore, [{
        nodes: [
          ...decoys,
          // Sorts after every decoy by id, so it falls outside the window.
          node({ id: 'CustomField:Zzz_Obj__c.Shared_Leaf__c', type: 'CustomField', apiName: 'Shared_Leaf__c' }),
        ],
        edges: [],
      }]);
      expect(i.ok).toBe(true);
      const satCtx: Context = { vaultRoot: satDir, manifest: MANIFEST, graph: satStore };
      const r = await findComponentUsagesHandler(satCtx, {
        componentId: 'CustomField:zzz_obj__c.shared_leaf__c', includeGrep: false,
      });
      expect(r.ok).toBe(false); if (r.ok) return;
      expect(r.error.kind).toBe('component-not-found');
      expect(r.error.message).toMatch(/INCONCLUSIVE/);
      expect(r.error.message).not.toMatch(/is NOT a casing mismatch/);
      await closeGraph(satStore);
    } finally {
      rmSync(satDir, { recursive: true, force: true });
    }
  });

  it('leaves an exactly-cased id untouched (no correction disclosed)', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: FIELD, includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.target.resolvedFrom).toBeNull();
  });
});

// FCU-FLOW-FIELD-WRITERS-UNCONSULTED. A CustomField written by an ACTIVE Flow
// through an SObject-variable `assignToReference` (or a
// `recordCreates`/`recordUpdates` `<inputAssignments>` block) mints NO
// `writesTo` edge, so the graph tier is empty; the grep tier searches for the
// QUALIFIED `Object.Field` string, which Flow XML never writes. Measured on a
// real vault the dispatcher answered `graphReferrers: []`,
// `hasStaticEvidence: false`, `grepMatchCount: 0` and a `coverageCaveat` naming
// Dashboard + Report as THE reason the empty could be false — while
// `safe_to_delete_field` on the identical id returned `blocking` on an Active
// Flow, from a family the vault retrieved COMPLETELY. The caveat pointed the
// reader at the one place the answer was not hiding.
describe('findComponentUsagesHandler — supplemental Flow field-writer plane', () => {
  const OBJ = 'Obj_A__c';
  let fdir: string; let fstore: GraphStore; let fctx: Context;

  beforeAll(async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    fdir = mkdtempSync(join(tmpdir(), 'sfi-fcu-flowwriters-'));
    const flowsDir = join(fdir, 'source', 'main', 'default', 'flows');
    mkdirSync(flowsDir, { recursive: true });
    // A record-triggered Flow that writes the field through an SObject
    // VARIABLE, never through `$Record` — the shape that mints no edge.
    writeFileSync(
      join(flowsDir, 'Flow_B.flow-meta.xml'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
        '  <status>Active</status>',
        '  <variables>',
        '    <name>RecToUpdate</name>',
        '    <dataType>SObject</dataType>',
        `    <objectType>${OBJ}</objectType>`,
        '  </variables>',
        '  <assignments>',
        '    <assignmentItems>',
        '      <assignToReference>RecToUpdate.Field_A__c</assignToReference>',
        '    </assignmentItems>',
        '  </assignments>',
        // ONE Flow writing the SAME field from TWO branches — two ROWS, one
        // component. Quoting the row count as "2 flows write this" is the
        // over-count `graphReferrers.distinctReferrers` already exists to stop.
        '  <assignments>',
        '    <assignmentItems>',
        '      <assignToReference>RecToUpdate.Field_D__c</assignToReference>',
        '    </assignmentItems>',
        '    <assignmentItems>',
        '      <assignToReference>RecToUpdate.Field_D__c</assignToReference>',
        '    </assignmentItems>',
        '  </assignments>',
        '</Flow>',
        '',
      ].join('\n'),
    );
    const o = await openGraph(join(fdir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    fstore = o.value;
    const i = await importExtractionResults(fstore, [{
      nodes: [
        node({ id: `CustomField:${OBJ}.Field_A__c`, type: 'CustomField', apiName: `${OBJ}.Field_A__c` }),
        node({ id: `CustomField:${OBJ}.Field_C__c`, type: 'CustomField', apiName: `${OBJ}.Field_C__c` }),
        node({ id: `CustomField:${OBJ}.Field_D__c`, type: 'CustomField', apiName: `${OBJ}.Field_D__c` }),
        node({
          id: 'Flow:Flow_B', type: 'Flow', apiName: 'Flow_B',
          sourcePath: 'source/main/default/flows/Flow_B.flow-meta.xml',
        }),
      ],
      edges: [],
    }]);
    if (!i.ok) throw new Error(i.error.message);
    fctx = { vaultRoot: fdir, manifest: MANIFEST, graph: fstore };
  });
  afterAll(async () => { await closeGraph(fstore); rmSync(fdir, { recursive: true, force: true }); });

  it('finds the Active-Flow writer the graph never stamped, instead of a confident empty', async () => {
    const r = await findComponentUsagesHandler(fctx, {
      componentId: `CustomField:${OBJ}.Field_A__c`, includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.graphReferrers).toEqual([]);
    expect(d.supplementalFlowWriters?.count).toBe(1);
    expect(d.supplementalFlowWriters?.distinctWriters).toBe(1);
    expect(d.supplementalFlowWriters?.writers.map((w) => w.flowId)).toEqual(['Flow:Flow_B']);
    expect(d.supplementalFlowWriters?.writers[0]?.mechanism).toBe('assignToReference');
    expect(d.summary.supplementalFlowWriterCount).toBe(1);
    // The evidence is real, so the answer is no longer an empty result — and
    // the empty-result caveat that pointed at the wrong families is gone.
    expect(d.summary.hasStaticEvidence).toBe(true);
    expect('coverageCaveat' in d).toBe(false);
    expect(d.boundaries.join(' ')).toMatch(/flow-field-writers-scan/);
  });

  it('separates write-site ROWS from distinct writing FLOWS', async () => {
    const r = await findComponentUsagesHandler(fctx, {
      componentId: `CustomField:${OBJ}.Field_D__c`, includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.supplementalFlowWriters?.count).toBe(2);
    expect(d.supplementalFlowWriters?.distinctWriters).toBe(1);
    // The human-facing summary number is the COMPONENT count, not the rows.
    expect(d.summary.supplementalFlowWriterCount).toBe(1);
    expect(d.boundaries.join(' ')).toContain('1 Flow(s) write this field');
    expect(d.boundaries.join(' ')).toContain('2 write site(s)');
  });

  it('reports a CHECKED zero (not an unchecked one) when the scan runs clean', async () => {
    const r = await findComponentUsagesHandler(fctx, {
      componentId: `CustomField:${OBJ}.Field_C__c`, includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.hasStaticEvidence).toBe(false);
    expect(d.summary.supplementalFlowWriterCount).toBe(0);
    expect(d.supplementalFlowWriters?.truncated).toBe(false);
    expect(d.supplementalFlowWriters?.scannedFlows).toBe(1);
    expect(d.supplementalFlowWriters?.totalFlows).toBe(1);
  });

  it('marks the plane NOT CHECKED when a Flow source could not be read', async () => {
    // The shared fixture vault holds a Flow whose `sourcePath` points at
    // nothing on disk — the writer set is UNPROVEN, never a clean zero.
    const r = await findComponentUsagesHandler(ctx, {
      componentId: 'CustomField:Account.Orphan__c', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.supplementalFlowWriters?.truncated).toBe(true);
    expect(d.supplementalFlowWriters?.truncationCause).toBe('unreadable-sources');
    expect(d.summary.supplementalFlowWriterCount).toBeNull();
    expect(d.boundaries.join(' ')).toMatch(/could not be opened/i);
  });

  it('says WHICH string the grep tier searched, so a field zero is not read as corroboration', async () => {
    const r = await findComponentUsagesHandler(fctx, {
      componentId: `CustomField:${OBJ}.Field_C__c`,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.grepSupplement.matchCount).toBe(0);
    expect(d.boundaries.join(' ')).toContain(`QUALIFIED string \`${OBJ}.Field_C__c\``);
    expect(d.boundaries.join(' ')).toMatch(/WEAK evidence of absence/);
    // The Apex spelling it names is the BARE leaf, not the qualified string again.
    expect(d.boundaries.join(' ')).toContain('`record.Field_C__c`');
  });

  it('does NOT claim the plane for a non-CustomField target', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'Flow:LeadConvert', includeGrep: false });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect('supplementalFlowWriters' in r.value.data).toBe(false);
    expect(r.value.data.summary.supplementalFlowWriterCount).toBeNull();
  });
});

// FCU-INPUTASSIGNMENTS-IS-OBJECT-BLIND — the repair to the repair.
//
// The supplemental tier above adopted `flow-field-writers-scan`, whose
// `inputAssignments` mechanism matches a bare `<field>NAME</field>` inside ANY
// `<recordCreates>`/`<recordUpdates>` WITHOUT checking that DML's own object.
// In `sfi.safe_to_delete_field` that over-match is conservative (a phantom
// writer only makes the verdict `blocking`). HERE it points the other way: it
// would flip `hasStaticEvidence` false→true and DELETE the empty-result
// coverage caveat, turning a name collision into a named referrer. Measured on
// a real production vault, `CustomField:Contract.Name` collected TEN such
// "writers", the first of which never mentions Contract at all, and
// `CustomField:Case.IsVisibleInSelfService` collected a Flow that writes that
// field on a Task.
describe('findComponentUsagesHandler — inputAssignments object scoping', () => {
  const flowXml = (body: readonly string[]): string =>
    ['<?xml version="1.0" encoding="UTF-8"?>',
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '  <status>Active</status>', ...body, '</Flow>', ''].join('\n');
  const dml = (tag: string, scope: string, field: string): string[] => [
    `  <${tag}>`, `    <name>Dml_${field}</name>`, ...scope.split('\n').map((l) => `    ${l}`),
    '    <inputAssignments>', `      <field>${field}</field>`,
    '      <value><elementReference>x</elementReference></value>',
    '    </inputAssignments>', `  </${tag}>`,
  ];

  let sdir: string; let sstore: GraphStore; let sctx: Context;

  beforeAll(async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    sdir = mkdtempSync(join(tmpdir(), 'sfi-fcu-objscope-'));
    const flowsDir = join(sdir, 'source', 'main', 'default', 'flows');
    mkdirSync(flowsDir, { recursive: true });
    const flows: Record<string, string> = {
      // (1) writes `Name` on a DIFFERENT object — the real-vault false positive.
      Wrong_Object: flowXml(dml('recordCreates', '<object>Other__c</object>', 'Name')),
      // (2) writes `Name` on THIS object, declared inline.
      Right_Object: flowXml(dml('recordUpdates', '<object>Obj_B__c</object>', 'Name')),
      // (3) `$Record` — resolved through the record-triggered `<start>` object.
      Via_Record: flowXml([
        '  <start>', '    <object>Obj_B__c</object>', '  </start>',
        ...dml('recordUpdates', '<inputReference>$Record</inputReference>', 'Status__c'),
      ]),
      // (4) `$Record` on a start element for ANOTHER object — dropped.
      Via_Record_Other: flowXml([
        '  <start>', '    <object>Other__c</object>', '  </start>',
        ...dml('recordUpdates', '<inputReference>$Record</inputReference>', 'Status__c'),
      ]),
      // (5) an SObject `<variables>` entry — resolved through its objectType.
      Via_Variable: flowXml([
        '  <variables>', '    <name>Rec</name>', '    <dataType>SObject</dataType>',
        '    <objectType>Obj_B__c</objectType>', '  </variables>',
        ...dml('recordCreates', '<inputReference>Rec</inputReference>', 'Note__c'),
      ]),
      // (6) an `<inputReference>` naming NOTHING resolvable (a loop variable):
      //     UNKNOWN object, so a LEAD — never confirmed, never silently dropped.
      Via_Unknown: flowXml(
        dml('recordUpdates', '<inputReference>LoopVar</inputReference>', 'Note__c'),
      ),
      // (7) polymorphic Activity: a Task DML writes Activity's custom field.
      Task_Writer: flowXml(dml('recordUpdates', '<object>Task</object>', 'Poly__c')),
      // (8) the ONLY match for `Lead_Only__c` is unresolvable — the whole
      //     answer then rests on a lead, which must not read as evidence.
      Lead_Only: flowXml(
        dml('recordUpdates', '<inputReference>LoopVar</inputReference>', 'Lead_Only__c'),
      ),
    };
    // (9) MORE confirmed writers than the 25-row sample cap, so the section's
    //     row lists are cut and the payload-level `truncated` must say so.
    for (let i = 0; i < 26; i += 1) {
      flows[`Bulk_${String(i).padStart(2, '0')}`] = flowXml(
        dml('recordUpdates', '<object>Obj_B__c</object>', 'Bulk__c'),
      );
    }
    for (const [name, xml] of Object.entries(flows)) {
      writeFileSync(join(flowsDir, `${name}.flow-meta.xml`), xml);
    }
    const o = await openGraph(join(sdir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    sstore = o.value;
    const i = await importExtractionResults(sstore, [{
      nodes: [
        node({ id: 'CustomField:Obj_B__c.Name', type: 'CustomField', apiName: 'Obj_B__c.Name' }),
        node({ id: 'CustomField:Obj_B__c.Status__c', type: 'CustomField', apiName: 'Obj_B__c.Status__c' }),
        node({ id: 'CustomField:Obj_B__c.Note__c', type: 'CustomField', apiName: 'Obj_B__c.Note__c' }),
        node({ id: 'CustomField:Activity.Poly__c', type: 'CustomField', apiName: 'Activity.Poly__c' }),
        node({ id: 'CustomField:Obj_B__c.Lead_Only__c', type: 'CustomField', apiName: 'Obj_B__c.Lead_Only__c' }),
        node({ id: 'CustomField:Obj_B__c.Bulk__c', type: 'CustomField', apiName: 'Obj_B__c.Bulk__c' }),
        node({ id: 'CustomField:Obj_B__c.Untouched__c', type: 'CustomField', apiName: 'Obj_B__c.Untouched__c' }),
        ...Object.keys(flows).map((n) => node({
          id: `Flow:${n}`, type: 'Flow', apiName: n,
          sourcePath: `source/main/default/flows/${n}.flow-meta.xml`,
        })),
      ],
      edges: [],
    }]);
    if (!i.ok) throw new Error(i.error.message);
    sctx = { vaultRoot: sdir, manifest: MANIFEST, graph: sstore };
  });
  afterAll(async () => { await closeGraph(sstore); rmSync(sdir, { recursive: true, force: true }); });

  it('does NOT certify a same-named field written on a DIFFERENT object', async () => {
    const r = await findComponentUsagesHandler(sctx, {
      componentId: 'CustomField:Obj_B__c.Name', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    // `Right_Object` is a genuine writer; `Wrong_Object` is a name collision.
    expect(d.supplementalFlowWriters?.writers.map((w) => w.flowId)).toEqual(['Flow:Right_Object']);
    expect(d.supplementalFlowWriters?.otherObjectMatchesDropped).toBe(1);
    expect(d.supplementalFlowWriters?.objectUnverified.count).toBe(0);
    expect(d.summary.supplementalFlowWriterCount).toBe(1);
  });

  it('keeps hasStaticEvidence FALSE and the coverage caveat when every match is another object', async () => {
    const r = await findComponentUsagesHandler(sctx, {
      componentId: 'CustomField:Obj_B__c.Status__c', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    // `Via_Record` writes Status__c on Obj_B__c → confirmed;
    // `Via_Record_Other` writes it on Other__c → dropped.
    expect(d.supplementalFlowWriters?.writers.map((w) => w.flowId)).toEqual(['Flow:Via_Record']);
    expect(d.supplementalFlowWriters?.otherObjectMatchesDropped).toBe(1);
    expect(d.summary.hasStaticEvidence).toBe(true);
    expect(d.boundaries.join(' ')).toContain('resolves to a DIFFERENT object');
  });

  it('resolves the DML object through an SObject <variables> inputReference', async () => {
    const r = await findComponentUsagesHandler(sctx, {
      componentId: 'CustomField:Obj_B__c.Note__c', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.supplementalFlowWriters?.writers.map((w) => w.flowId)).toEqual(['Flow:Via_Variable']);
    expect(d.summary.supplementalFlowWriterCount).toBe(1);
  });

  it('routes an UNRESOLVABLE DML object to a LEADS bucket that never certifies', async () => {
    const r = await findComponentUsagesHandler(sctx, {
      componentId: 'CustomField:Obj_B__c.Note__c', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    const u = d.supplementalFlowWriters?.objectUnverified;
    expect(u?.writers.map((w) => w.flowId)).toEqual(['Flow:Via_Unknown']);
    expect(u?.count).toBe(1);
    expect(d.summary.supplementalFlowWriterUnverifiedCount).toBe(1);
    // The prose must name the mechanism's actual weakness, in the tool's own words.
    expect(d.boundaries.join(' ')).toContain('FIELD NAME ALONE');
    expect(d.boundaries.join(' ')).toContain("WITHOUT checking the enclosing DML's object");
  });

  it('a LEAD alone is NOT static evidence and does NOT suppress the coverage caveat', async () => {
    const r = await findComponentUsagesHandler(sctx, {
      componentId: 'CustomField:Obj_B__c.Lead_Only__c', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.supplementalFlowWriters?.count).toBe(0);
    expect(d.supplementalFlowWriters?.objectUnverified.count).toBe(1);
    // THE assertion this whole repair exists for: an unscoped name match must
    // never flip the evidence flag nor delete the empty-result hedge.
    expect(d.summary.hasStaticEvidence).toBe(false);
    expect(d.summary.supplementalFlowWriterCount).toBe(0);
    expect(d.summary.supplementalFlowWriterUnverifiedCount).toBe(1);
    expect(d.boundaries.join(' ')).toContain('NOT proof that nothing uses it');
    // The empty-result hedge is in EXACTLY the state it would be in with no
    // match at all — a lead never suppresses it.
    const control = await findComponentUsagesHandler(sctx, {
      componentId: 'CustomField:Obj_B__c.Untouched__c', includeGrep: false,
    });
    expect(control.ok).toBe(true); if (!control.ok) return;
    expect('coverageCaveat' in d).toBe('coverageCaveat' in control.value.data);
    expect(control.value.data.summary.hasStaticEvidence).toBe(false);
  });

  it('folds the writer sample cap into the payload-level truncated flag', async () => {
    const r = await findComponentUsagesHandler(sctx, {
      componentId: 'CustomField:Obj_B__c.Bulk__c', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.supplementalFlowWriters?.count).toBe(26);
    expect(d.supplementalFlowWriters?.writers.length).toBe(25);
    expect(d.supplementalFlowWriters?.sampleTruncated).toBe(true);
    // The scan itself was complete — WITHOUT the sample-cap term this payload
    // flag stayed FALSE while the list under it was 25 of 26.
    expect(d.supplementalFlowWriters?.truncated).toBe(false);
    expect(d.truncated).toBe(true);
    expect(d.boundaries.join(' ')).toContain('SAMPLES capped at 25 rows');
  });

  it('folds the SCAN truncation into the payload-level truncated flag too', async () => {
    // The shared fixture's Flow source is unreadable, so the writer scan is
    // admittedly incomplete while `graphTruncated` and `grepTruncated` are BOTH
    // false — before this change the payload said `truncated: false` on top of
    // an unproven scan, which is exactly the unchecked-zero shape this file is
    // being repaired for.
    const r = await findComponentUsagesHandler(ctx, {
      componentId: 'CustomField:Account.Orphan__c', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.supplementalFlowWriters?.truncated).toBe(true);
    expect(d.supplementalFlowWriters?.sampleTruncated).toBe(false);
    expect(d.truncated).toBe(true);
  });

  it('honours the Activity/Task/Event polymorphic alias instead of dropping it', async () => {
    const r = await findComponentUsagesHandler(sctx, {
      componentId: 'CustomField:Activity.Poly__c', includeGrep: false,
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    // Task and Event share Activity's custom fields — a literal object match
    // would have dropped this REAL writer, re-introducing the false empty.
    expect(d.supplementalFlowWriters?.writers.map((w) => w.flowId)).toEqual(['Flow:Task_Writer']);
    expect(d.supplementalFlowWriters?.otherObjectMatchesDropped).toBe(0);
    expect(d.summary.hasStaticEvidence).toBe(true);
  });
});
