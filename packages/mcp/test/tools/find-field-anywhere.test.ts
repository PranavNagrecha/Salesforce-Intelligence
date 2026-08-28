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
  findFieldAnywhereHandler,
  findFieldAnywhereInputSchema,
} from '../../src/tools/find-field-anywhere.js';
import {
  responseBudgetBytes,
  responseReductionCap,
  toolLocalPayloadBudgetBytes,
} from '../../src/tools/response-budget.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-ffa',
};

const FIELD_ID = 'CustomField:Account.Industry__c';
/** A field node that EXISTS in the vault but is referenced by nothing. */
const UNREFERENCED_FIELD_ID = 'CustomField:Account.Unreferenced__c';
/** Referenced by an edge, but its own definition was never retrieved. */
const PHANTOM_FIELD_ID = 'CustomField:Account.Phantom__c';
/** Names no node and is referenced by nothing — a typo. */
const ABSENT_FIELD_ID = 'CustomField:Account.Nonexistant__c';

/**
 * The REAL-ORG SHAPE this suite was extended for.
 *
 * A field that EXISTS, whose only resolved incoming edges are FLS grants, and
 * whose real declarative referrers were minted by an extractor against a
 * RELATIONSHIP-ALIAS object id that resolves to no node. On the vault this was
 * measured against, 48 report types named the field and the tool answered
 * `totalCount: 5` (all grants) with `truncated: false` under a boundary
 * claiming a metadata-XML pattern pass had run.
 */
const ALIASED_FIELD_ID = 'CustomField:Obj_A.Field_A__c';
/** The relationship-alias spelling the extractor actually minted against. */
const ALIAS_TARGET_ID = 'CustomField:Rel_Alias__c.Field_A__c';
/** A second, CASE-VARIANT alias spelling of the same object token. */
const ALIAS_TARGET_ID_2 = 'CustomField:REL_ALIAS__C.Field_A__c';

/**
 * THE SCAN-CAP SHAPE. A field whose api name is carried by MORE unresolved ids
 * than the referrer walk enumerates.
 *
 * Measured on a real vault: the most common dangling field api name is carried
 * by 226 unresolvable `CustomField:` ids holding 568 referring edges. A count
 * taken from the WALKED subset alone reported 97 of those 568 — a 5.9x
 * understatement published under prose calling it a true total. The fixture
 * reproduces the shape at cap+10 ids so the >cap branch is executed.
 */
const WIDE_FIELD_ID = 'CustomField:Obj_B.Wide_Field__c';
/** cap (50) + 10, so exactly 10 ids fall outside the enumeration walk. */
const WIDE_ALIAS_COUNT = 60;
/** Two referrers per alias id → 120 edges, of which a 50-id walk sees 100. */
const WIDE_REFERRERS = ['ReportType:RT_W_One', 'ReportType:RT_W_Two'] as const;
const wideAliasId = (n: number): string =>
  `CustomField:Wide_Alias_${String(n).padStart(3, '0')}__c.Wide_Field__c`;

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
    }),
    makeNode({
      id: FIELD_ID,
      type: 'CustomField',
      apiName: 'Account.Industry__c',
      parentId: 'CustomObject:Account',
    }),
    // An EXISTING field that nothing references — the honest "scanned and
    // clean" case, which must stay distinguishable from a field that is not in
    // the vault at all.
    makeNode({
      id: UNREFERENCED_FIELD_ID,
      type: 'CustomField',
      apiName: 'Account.Unreferenced__c',
      parentId: 'CustomObject:Account',
    }),
    makeNode({
      id: 'ApexClass:AccountSvc',
      type: 'ApexClass',
      apiName: 'AccountSvc',
    }),
    makeNode({
      id: 'ApexClass:LegacyAccountFetcher',
      type: 'ApexClass',
      apiName: 'LegacyAccountFetcher',
    }),
    makeNode({
      id: 'Flow:Account_Update',
      type: 'Flow',
      apiName: 'Account_Update',
    }),
    makeNode({
      id: 'Layout:Account-Standard',
      type: 'Layout',
      apiName: 'Account-Standard',
    }),
    makeNode({
      id: 'ValidationRule:Account.Industry_Required',
      type: 'ValidationRule',
      apiName: 'Industry_Required',
      parentId: 'CustomObject:Account',
    }),
    // --- real-org shape: aliased-target field ---
    makeNode({ id: 'CustomObject:Obj_A', type: 'CustomObject', apiName: 'Obj_A' }),
    makeNode({
      id: ALIASED_FIELD_ID,
      type: 'CustomField',
      apiName: 'Obj_A.Field_A__c',
      parentId: 'CustomObject:Obj_A',
    }),
    makeNode({ id: 'ReportType:RT_One', type: 'ReportType', apiName: 'RT_One' }),
    makeNode({ id: 'ReportType:RT_Two', type: 'ReportType', apiName: 'RT_Two' }),
    makeNode({ id: 'PermissionSet:PS_One', type: 'PermissionSet', apiName: 'PS_One' }),
    makeNode({ id: 'Profile:Prof_One', type: 'Profile', apiName: 'Prof_One' }),
    // --- scan-cap shape: one real field, many unresolvable alias ids ---
    makeNode({ id: 'CustomObject:Obj_B', type: 'CustomObject', apiName: 'Obj_B' }),
    makeNode({
      id: WIDE_FIELD_ID,
      type: 'CustomField',
      apiName: 'Obj_B.Wide_Field__c',
      parentId: 'CustomObject:Obj_B',
    }),
    ...WIDE_REFERRERS.map((id) =>
      makeNode({ id, type: 'ReportType', apiName: id.slice('ReportType:'.length) }),
    ),
  ],
  edges: [
    // parentOf — should be filtered out by find_field_anywhere
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: FIELD_ID,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'custom-object-extractor',
    }),
    // Apex read
    makeEdge({
      fromId: 'ApexClass:AccountSvc',
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
    }),
    // Apex write
    makeEdge({
      fromId: 'ApexClass:AccountSvc',
      toId: FIELD_ID,
      edgeType: 'writesTo',
      source: 'apex-scanner',
    }),
    // Second Apex read from a different class
    makeEdge({
      fromId: 'ApexClass:LegacyAccountFetcher',
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
    }),
    // Flow read
    makeEdge({
      fromId: 'Flow:Account_Update',
      toId: FIELD_ID,
      edgeType: 'readsFrom',
      source: 'flow-extractor',
    }),
    // Layout placement
    makeEdge({
      fromId: 'Layout:Account-Standard',
      toId: FIELD_ID,
      edgeType: 'usedInLayout',
      confidence: 'declared',
      source: 'layout-extractor',
    }),
    // A reference to a field whose OWN definition was never retrieved
    // (managed package / out of retrieve scope). The edge exists, the node
    // does not.
    makeEdge({
      fromId: 'ApexClass:AccountSvc',
      toId: PHANTOM_FIELD_ID,
      edgeType: 'readsFrom',
      source: 'apex-scanner',
    }),
    // ValidationRule reference
    makeEdge({
      fromId: 'ValidationRule:Account.Industry_Required',
      toId: FIELD_ID,
      edgeType: 'references',
      confidence: 'declared',
      source: 'formula-tokenizer',
      properties: { tokenizedFromField: 'errorConditionFormula' },
    }),
    // --- real-org shape: the only edges that LAND on the canonical id are FLS
    // grants, so the edge walk certifies a "used by nothing else" zero ...
    makeEdge({
      fromId: 'CustomObject:Obj_A',
      toId: ALIASED_FIELD_ID,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'custom-field-extractor',
    }),
    makeEdge({
      fromId: 'PermissionSet:PS_One',
      toId: ALIASED_FIELD_ID,
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'permission-set-extractor',
    }),
    makeEdge({
      fromId: 'Profile:Prof_One',
      toId: ALIASED_FIELD_ID,
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'profile-extractor',
    }),
    // ... while the REAL declarative referrers sit on ids no node carries,
    // because the extractor only knew the section's relationship alias.
    makeEdge({
      fromId: 'ReportType:RT_One',
      toId: ALIAS_TARGET_ID,
      edgeType: 'references',
      source: 'enterprise-metadata-extractor',
      properties: { referenceKind: 'fieldRef', targetMissing: true },
    }),
    makeEdge({
      fromId: 'ReportType:RT_Two',
      toId: ALIAS_TARGET_ID_2,
      edgeType: 'references',
      source: 'enterprise-metadata-extractor',
      properties: { referenceKind: 'fieldRef', targetMissing: true },
    }),
    // PREDICATE-PARITY BAIT. The exact count comes from a SQL aggregate and the
    // rows from an edge walk; if the two disagree the section prints a count
    // beside rows that contradict it. Both must drop a `parentOf` edge and an
    // edge whose REFERRER node does not exist.
    makeEdge({
      fromId: 'CustomObject:Obj_A',
      toId: ALIAS_TARGET_ID,
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'custom-object-extractor',
    }),
    makeEdge({
      fromId: 'ApexClass:Never_Retrieved_Referrer',
      toId: ALIAS_TARGET_ID,
      edgeType: 'references',
      source: 'apex-scanner',
    }),
    // --- scan-cap shape: 60 unresolvable alias ids x 2 referrers = 120 edges,
    // of which a 50-id enumeration walk can only ever see 100.
    ...Array.from({ length: WIDE_ALIAS_COUNT }, (_unused, i) =>
      WIDE_REFERRERS.map((from) =>
        makeEdge({
          fromId: from,
          toId: wideAliasId(i + 1),
          edgeType: 'references',
          source: 'enterprise-metadata-extractor',
          properties: { referenceKind: 'fieldRef', targetMissing: true },
        }),
      ),
    ).flat(),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ffa-'));
  const opened = await openGraph(join(tempDir, 'ffa.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findFieldAnywhereHandler', () => {
  it('returns groups for every ComponentType that references the field', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const types = r.value.data.groups.map((g) => g.componentType).sort();
    expect(types).toEqual([
      'ApexClass',
      'Flow',
      'Layout',
      'ValidationRule',
    ]);
  });

  it('totalCount equals the number of non-parentOf incoming edges', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 3 apex (readsFrom AccountSvc + writesTo AccountSvc + readsFrom LegacyAccountFetcher)
    // + 1 flow + 1 layout + 1 validation rule = 6
    expect(r.value.data.totalCount).toBe(6);
  });

  it('filters out parentOf edges', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // CustomObject:Account would only have a parentOf edge to the field;
    // it must not appear as a referrer group.
    expect(
      r.value.data.groups.find((g) => g.componentType === 'CustomObject'),
    ).toBeUndefined();
  });

  it('byEdgeType tallies the edge-type distribution across the full set', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.byEdgeType['readsFrom']).toBe(3);
    expect(r.value.data.byEdgeType['writesTo']).toBe(1);
    expect(r.value.data.byEdgeType['usedInLayout']).toBe(1);
    expect(r.value.data.byEdgeType['references']).toBe(1);
  });

  it('surfaces the verbatim dynamic-SOQL boundary when matches exist', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('Dynamic SOQL');
    expect(joined).toContain('managed-package');
  });

  // The boundary used to open "the search uses pattern-matching over Apex
  // source, Flow XML, and metadata XML". This handler opens no file and runs no
  // text pass, so that sentence certified work that never happened — and a host
  // that read it aloud told the admin the metadata XML had been checked.
  it('NEVER claims a text/pattern pass it does not run', async () => {
    for (const id of [FIELD_ID, UNREFERENCED_FIELD_ID, ALIASED_FIELD_ID]) {
      const r = await findFieldAnywhereHandler(ctx, { targetId: id });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const joined = r.value.data.boundaries.join(' ');
      expect(joined).not.toContain('the search uses pattern-matching');
      expect(joined).toContain('EDGE WALK');
      expect(r.value.data.searchMethod).toBe('graph-edge-walk');
    }
  });

  // SPLIT (first time): this case used to be asserted against
  // `CustomField:Account.NoSuchField__c` — an id NO node in the fixture carries. It
  // therefore proved only that an ABSENT field returns a confident zero.
  //
  // REWRITTEN (this change): it then asserted `boundaries.length === 1`, with a
  // comment stating that "the static-graph / managed-package disclosures only
  // apply when there are actual references". That is the defect written down as
  // an expectation. The disclosures describe the METHOD, which does not change
  // with the result count, so gating them handed the emptiest and most dangerous
  // answer the LEAST disclosure. The honest assertion is that a zero carries MORE.
  it('a zero answer carries the method disclosures AND says the zero is a graph zero', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: UNREFERENCED_FIELD_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('EDGE WALK');
    expect(joined).toContain('managed-package');
    expect(joined).toContain('NO EXTRACTED EDGE LANDS ON THIS EXACT ID');
    // report/dashboard usage is only modeled with `--with-reports`, so the
    // original hedge must survive alongside the new ones.
    expect(joined).toContain('--with-reports');
  });

  // A zero that WAS checked must stay distinguishable from a zero that was not.
  it('an unreferenced field reports a SCANNED empty unresolved-id section', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: UNREFERENCED_FIELD_ID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    expect(u.scanned).toBe(true);
    expect(u.idsTotal).toBe(0);
    expect(u.referenceCount).toBe(0);
    expect(u.note).toContain('scanned zero, not a skipped section');
  });

  it('sorts references within a group by componentId ASC then edgeType ASC', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const apex = r.value.data.groups.find(
      (g) => g.componentType === 'ApexClass',
    );
    expect(apex).toBeDefined();
    if (apex === undefined) return;
    const ids = apex.references.map(
      (ref) => `${ref.componentId}|${ref.edgeType}`,
    );
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('groups are sorted alphabetically by component type', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const types = r.value.data.groups.map((g) => g.componentType);
    const sorted = [...types].sort();
    expect(types).toEqual(sorted);
  });

  it('truncates to limit and flips truncated=true', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: FIELD_ID,
      limit: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.truncated).toBe(true);
    // Per-group sum should be <= 2 (truncation across the total).
    let sum = 0;
    for (const g of r.value.data.groups) sum += g.references.length;
    expect(sum).toBeLessThanOrEqual(2);
  });

  it('returns invalid-query when targetId does not start with CustomField:', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: 'ApexClass:NotAField',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('targetId');
  });

  it('accepts `fieldId` as an alias for `targetId` (field-family parity)', async () => {
    const viaAlias = await findFieldAnywhereHandler(ctx, { fieldId: FIELD_ID });
    const viaCanonical = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(viaAlias.ok).toBe(true);
    expect(viaCanonical.ok).toBe(true);
    if (!viaAlias.ok || !viaCanonical.ok) return;
    // The alias resolves to the same field and the same result.
    expect(viaAlias.value.data.targetId).toBe(FIELD_ID);
    expect(viaAlias.value.data.totalCount).toBe(viaCanonical.value.data.totalCount);
  });

  it('returns invalid-query when NEITHER targetId nor fieldId is supplied', async () => {
    const r = await findFieldAnywhereHandler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('targetId');
  });

  it('preserves edge metadata (source, confidence, properties) on each reference', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vr = r.value.data.groups.find(
      (g) => g.componentType === 'ValidationRule',
    );
    expect(vr).toBeDefined();
    if (vr === undefined) return;
    const ref = vr.references[0];
    expect(ref).toBeDefined();
    expect(ref?.source).toBe('formula-tokenizer');
    expect(ref?.confidence).toBe('declared');
    expect(ref?.properties['tokenizedFromField']).toBe('errorConditionFormula');
  });

  it('filters by componentTypes when supplied', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: FIELD_ID,
      componentTypes: ['ApexClass'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.groups.length).toBe(1);
    expect(r.value.data.groups[0]?.componentType).toBe('ApexClass');
    // 2 reads + 1 write = 3 apex references
    expect(r.value.data.totalCount).toBe(3);
  });

  it("group's count field matches the unfiltered per-type total", async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const apex = r.value.data.groups.find(
      (g) => g.componentType === 'ApexClass',
    );
    expect(apex?.count).toBe(3);
  });

  it('returns componentType-filtered empty result when filter matches nothing', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: FIELD_ID,
      componentTypes: ['Profile'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.groups.length).toBe(0);
  });
});

describe('findFieldAnywhereHandler — references minted against an unresolvable id', () => {
  // THE REAL-ORG DEFECT. A field whose only edges landing on the CANONICAL id
  // are FLS grants answers `totalCount: 5` / `truncated: false` while its real
  // declarative referrers sit on `CustomField:{RelationshipAlias}.{Field}` ids
  // that resolve to no node. The sibling tools REDIRECT here for exactly those
  // surfaces, so the certified zero is produced at the end of the diligent path.
  it('does not fold api-name matches into totalCount (they are leads, not usages)', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: ALIASED_FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The resolved answer is unchanged: two grants, nothing else.
    expect(r.value.data.totalCount).toBe(2);
    expect(r.value.data.byEdgeType).toEqual({ grantedBy: 2 });
    expect(
      r.value.data.groups.some((g) => g.componentType === 'ReportType'),
    ).toBe(false);
  });

  it('RECOVERS the referrers hiding behind the alias ids into a typed section', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: ALIASED_FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    expect(u.scanned).toBe(true);
    expect(u.fieldApiName).toBe('Field_A__c');
    // BOTH alias spellings, including the case-variant one.
    expect(u.idsTotal).toBe(2);
    expect([...u.unresolvedTargetIds].sort()).toEqual(
      [ALIAS_TARGET_ID, ALIAS_TARGET_ID_2].sort(),
    );
    expect(u.referenceCount).toBe(2);
    expect(u.byComponentType).toEqual({ ReportType: 2 });
    expect(u.referrers.map((x) => x.componentId).sort()).toEqual([
      'ReportType:RT_One',
      'ReportType:RT_Two',
    ]);
    expect(u.truncated).toBe(false);
  });

  it('states the ambiguity in prose a host will read aloud', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: ALIASED_FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    // The recovered leads reach `boundaries`, not only the typed section — but
    // as a POINTER, not a duplicate of the long note (that duplication pushed a
    // real field's payload past the global hard ceiling).
    expect(joined).toContain('resolve to NO node here');
    expect(joined).toContain('NOT proven to be this field');
    expect(joined).toContain('unresolvedApiNameMatches');
    expect(joined).not.toContain(r.value.data.unresolvedApiNameMatches.note);
    // ... and the typed section must not overclaim them as proven usages.
    expect(r.value.data.unresolvedApiNameMatches.note).toContain('THE VAULT CANNOT');
    expect(r.value.data.unresolvedApiNameMatches.note).toContain('NOT proven to be this field');
  });

  it('a field with no alias-spelled twin reports a checked empty, not silence', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    expect(u.scanned).toBe(true);
    expect(u.referenceCount).toBe(0);
    expect(u.unresolvedTargetIds).toEqual([]);
  });

  // A new always-present section is not free. The global hard ceiling is 45 000
  // bytes and the widest field on a real vault already serialises past it on the
  // whole-fits path, so the section must give its enumeration back under budget
  // pressure — WITHOUT ever lowering the counts, which are the honest part.
  it('shrinks its enumeration under budget pressure but never its counts', async () => {
    const prev = process.env['SFI_MAX_RESPONSE_BYTES'];
    process.env['SFI_MAX_RESPONSE_BYTES'] = '2000'; // the module's floor
    try {
      const r = await findFieldAnywhereHandler(ctx, { targetId: ALIASED_FIELD_ID });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const u = r.value.data.unresolvedApiNameMatches;
      // enumeration surrendered ...
      expect(u.referrers.length).toBe(0);
      expect(u.unresolvedTargetIds.length).toBe(0);
      // ... claims intact, and the shrink is DISCLOSED rather than silent.
      expect(u.scanned).toBe(true);
      expect(u.referenceCount).toBe(2);
      expect(u.idsTotal).toBe(2);
      expect(u.byComponentType).toEqual({ ReportType: 2 });
      expect(u.truncated).toBe(true);
      expect(u.note).toContain('shrunk further to fit the response');
      // the boundary pointer still tells the host the blind spot exists.
      expect(r.value.data.boundaries.join(' ')).toContain('resolve to NO node here');
    } finally {
      if (prev === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
      else process.env['SFI_MAX_RESPONSE_BYTES'] = prev;
    }
  });

  // THE CAP DEFECT. `referenceCount` used to be `referrers.length` — a tally of
  // the edges found across the WALKED id subset — while the `note` closed with
  // "the COUNTS above are the true pre-cap totals" and the cap's own doc claimed
  // it "can never read as a smaller blind spot than the vault actually has".
  // Both were false the moment more ids matched than the walk enumerates.
  // Measured on a real vault: 97 emitted where the graph holds 568.
  it('reports the TRUE reference total when more ids match than the walk enumerates', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: WIDE_FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    expect(u.idsTotal).toBe(WIDE_ALIAS_COUNT);
    // the walk is capped ...
    expect(u.idsScanned).toBeLessThan(u.idsTotal);
    expect(u.truncated).toBe(true);
    // ... and the COUNT is nevertheless the whole-vault total, not the walked
    // subset's tally (which would be idsScanned * WIDE_REFERRERS.length).
    expect(u.referenceCount).toBe(WIDE_ALIAS_COUNT * WIDE_REFERRERS.length);
    expect(u.referenceCount).not.toBe(u.idsScanned * WIDE_REFERRERS.length);
    expect(u.byComponentType).toEqual({
      ReportType: WIDE_ALIAS_COUNT * WIDE_REFERRERS.length,
    });
  });

  // The count and the rows are produced by DIFFERENT mechanisms (a SQL
  // aggregate vs. an edge walk). When nothing is capped they must agree
  // exactly, including on what they DROP: a `parentOf` edge and an edge from a
  // referrer node the vault does not carry.
  it('count and rows agree exactly when nothing is capped (predicate parity)', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: ALIASED_FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    expect(u.idsScanned).toBe(u.idsTotal);
    expect(u.truncated).toBe(false);
    expect(u.referenceCount).toBe(u.referrers.length);
    // the parentOf edge and the unresolvable-referrer edge are dropped by BOTH.
    expect(u.referenceCount).toBe(2);
    expect(u.byComponentType).toEqual({ ReportType: 2 });
    expect(
      u.referrers.some((x) => x.componentId.startsWith('CustomObject:')),
    ).toBe(false);
    // and the tally sums to the count.
    expect(
      Object.values(u.byComponentType).reduce((a, b) => a + b, 0),
    ).toBe(u.referenceCount);
  });

  // THE IRREDUCIBLE FLOOR, STATED RATHER THAN HIDDEN. At a budget small enough
  // that even an empty enumeration does not fit, the section surrenders EVERY
  // row and the residual overflow is disclosure prose — the `note` plus the
  // method boundaries — which this tool will not drop to save bytes. Asserted
  // so the exception is a documented shape and not a silent violation of the
  // cap the tests above pin.
  it('at a sub-prose budget it surrenders every row and the residue is disclosure', async () => {
    const prev = process.env['SFI_MAX_RESPONSE_BYTES'];
    process.env['SFI_MAX_RESPONSE_BYTES'] = '6000';
    try {
      const r = await findFieldAnywhereHandler(ctx, { targetId: WIDE_FIELD_ID });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const u = r.value.data.unresolvedApiNameMatches;
      expect(u.referrers).toEqual([]);
      expect(u.unresolvedTargetIds.length).toBeLessThanOrEqual(1);
      // counts survive the near-total surrender of rows.
      expect(u.referenceCount).toBe(WIDE_ALIAS_COUNT * WIDE_REFERRERS.length);
      expect(u.idsTotal).toBe(WIDE_ALIAS_COUNT);
      expect(u.byComponentType).toEqual({
        ReportType: WIDE_ALIAS_COUNT * WIDE_REFERRERS.length,
      });
      expect(u.truncated).toBe(true);
      const bytes = Buffer.byteLength(JSON.stringify(r.value.data), 'utf8');
      const rows = Buffer.byteLength(
        JSON.stringify({ a: u.referrers, b: u.unresolvedTargetIds, c: r.value.data.groups }),
        'utf8',
      );
      // what is left is overwhelmingly prose, not enumeration.
      expect(rows).toBeLessThan(bytes / 20);
      // the note still names the blind spot rather than being trimmed away.
      expect(u.note).toContain('EXACT over all');
    } finally {
      if (prev === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
      else process.env['SFI_MAX_RESPONSE_BYTES'] = prev;
    }
  });

  // The count is exact, so the prose may not describe it as a pre-cap estimate
  // NOR certify the enumerated rows as complete. It must say which number is
  // exact and which list is a sample.
  it('says plainly that the counts are exact and the ENUMERATION is the sample', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: WIDE_FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    expect(u.note).not.toContain('true pre-cap totals');
    expect(u.note).toContain('exact');
    expect(u.note).toContain(`${String(u.idsScanned)} of ${String(u.idsTotal)}`);
    // the referrer list really is a sample of a larger set.
    expect(u.referrers.length).toBeLessThan(u.referenceCount);
  });

  // The count must follow the componentTypes filter too — an aggregate that
  // ignored the filter would re-introduce the mismatch in the other direction.
  it('the exact count honours the componentTypes filter', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: WIDE_FIELD_ID,
      componentTypes: ['Flow'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    expect(u.idsTotal).toBe(WIDE_ALIAS_COUNT);
    expect(u.referenceCount).toBe(0);
    expect(u.byComponentType).toEqual({});
    expect(u.referrers).toEqual([]);
  });

  // The alias in the case this tool actually recovers is the DOTTED PREFIX of a
  // ReportType column's `<field>` element. Ground truth on the real vault: of
  // 1 793 dotted `<field>` values, 1 793 have a prefix that DIFFERS from the
  // sibling `<table>` — zero match it. Naming `<table>` as the mechanism sent a
  // reader to the wrong element.
  it('names the dotted `<field>` prefix, not the section `<table>`, as the alias', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: ALIASED_FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    expect(u.note).toContain('<field>');
    expect(u.note).not.toContain('`<table>`');
    // SIGNAL QUALITY. For a common api name the anti-join is dominated by other
    // objects' same-named fields — measured on a real vault, one standard api
    // name matched 226 unresolved ids / 568 references across 13 unrelated
    // component types. The section is still emitted (a skipped section and an
    // empty one must stay distinguishable) but the prose must not let a host
    // read those rows as this field's footprint.
    expect(u.note).toContain('For a COMMON api name');
    expect(u.note).toContain("OTHER objects' same-named fields");
  });

  // THE CEILING THE GUARD ACTUALLY ENFORCES. `fitUnresolvedSection` fitted to
  // `responseBudgetBytes()` (40 000). Nothing is measured against that number —
  // `tool-dispatch` reduces against `responseBudgetBytes()` minus
  // `RESPONSE_ENVELOPE_RESERVE_BYTES` (38 976), on a body that also carries
  // `vaultState` / `contentPolicy` / `orgDrift` this handler never sees. So a
  // payload landing in the 38 976–40 000 window was certified "fits" and then
  // fell into the global array-truncation pass. Measured on a real vault: 3 of
  // the 300 widest fields newly crossed 38 976 because of this.
  for (const budget of ['9000', '13000']) {
    it(`fits the tool-local cap, not the raw budget (SFI_MAX_RESPONSE_BYTES=${budget})`, async () => {
      const prev = process.env['SFI_MAX_RESPONSE_BYTES'];
      process.env['SFI_MAX_RESPONSE_BYTES'] = budget;
      try {
        const r = await findFieldAnywhereHandler(ctx, { targetId: WIDE_FIELD_ID });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const bytes = Buffer.byteLength(JSON.stringify(r.value.data), 'utf8');
        // the shape is big enough that the fit actually has work to do ...
        expect(r.value.data.unresolvedApiNameMatches.truncated).toBe(true);
        // ... and it must land under the TOOL-LOCAL cap, which is strictly
        // below the reduction cap, which is strictly below the raw budget.
        expect(toolLocalPayloadBudgetBytes()).toBeLessThan(responseReductionCap());
        expect(responseReductionCap()).toBeLessThan(responseBudgetBytes());
        expect(bytes).toBeLessThanOrEqual(toolLocalPayloadBudgetBytes());
      } finally {
        if (prev === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
        else process.env['SFI_MAX_RESPONSE_BYTES'] = prev;
      }
    });
  }

  it('the componentTypes filter narrows the recovered leads too', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: ALIASED_FIELD_ID,
      componentTypes: ['Flow'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.value.data.unresolvedApiNameMatches;
    // The ids are still disclosed (the blind spot is real) but no ReportType
    // referrer is smuggled past a filter that excluded it.
    expect(u.idsTotal).toBe(2);
    expect(u.referenceCount).toBe(0);
    expect(u.referrers).toEqual([]);
  });
});

describe('findFieldAnywhereHandler — CR-22 section cursor', () => {
  it('whole-fits omits cursor block (byte-identical golden)', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('nextCursor' in r.value.data).toBe(false);
    expect('pageInfo' in r.value.data).toBe(false);
    expect('otherSections' in r.value.data).toBe(false);
    expect(r.value.data.truncated).toBe(false);
    // every group carries its full references on a whole-fits call.
    const apex = r.value.data.groups.find((g) => g.componentType === 'ApexClass');
    expect(apex?.references.length).toBe(3);
  });

  it('paging an overflowing section emits nextCursor + discloses the rest', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID, limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.truncated).toBe(true);
    expect(r.value.data.designatedList).toBe('ApexClass');
    expect(r.value.data.nextCursor).toBeDefined();
    const apex = r.value.data.groups.find((g) => g.componentType === 'ApexClass');
    expect(apex?.references.length).toBe(2); // page
    expect(apex?.count).toBe(3); // honest total
    // non-designated sections carry empty references but their honest count.
    const flow = r.value.data.groups.find((g) => g.componentType === 'Flow');
    expect(flow?.references.length).toBe(0);
    expect(flow?.count).toBe(1);
    const others = r.value.data.otherSections ?? [];
    expect(others.find((s) => s.listId === 'Flow')?.totalCount).toBe(1);
  });

  it('resume walks the designated ApexClass section then rolls forward', async () => {
    // page1: ApexClass[0..1]. page2 resumes ApexClass[2], then exhausted →
    // cursor rolls forward to the next non-empty section (Flow).
    const page1 = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID, limit: 2 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    const apex1 = page1.value.data.groups.find((g) => g.componentType === 'ApexClass');
    expect(apex1?.references.length).toBe(2);
    const cursor = page1.value.data.nextCursor!;
    const page2 = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID, limit: 2, cursor });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    const apex2 = page2.value.data.groups.find((g) => g.componentType === 'ApexClass');
    expect(apex2?.references.length).toBe(1); // the 3rd apex ref
    // no dup across pages.
    const ids = [
      ...(apex1?.references ?? []),
      ...(apex2?.references ?? []),
    ].map((ref) => `${ref.componentId}|${ref.edgeType}|${ref.source}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(3);
    // cursor rolled forward to the next non-empty section.
    expect(page2.value.data.designatedList).toBe('Flow');
  });

  it('rejects a cursor minted for a different field / componentTypes filter', async () => {
    const p1 = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID, limit: 2 });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const cursor = p1.value.data.nextCursor!;
    const stale = await findFieldAnywhereHandler(ctx, {
      targetId: FIELD_ID,
      limit: 2,
      cursor,
      componentTypes: ['ApexClass'],
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('invalid-query');
  });
});

describe('findFieldAnywhereHandler — existence gate (R4)', () => {
  it('REFUSES an id no node carries instead of answering a confident zero', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: ABSENT_FIELD_ID });
    if (r.ok) {
      throw new Error(
        `expected component-not-found; got a confident answer: totalCount=${String(
          r.value.data.totalCount,
        )} groups=${String(r.value.data.groups.length)} byEdgeType=${JSON.stringify(
          r.value.data.byEdgeType,
        )} truncated=${String(r.value.data.truncated)}`,
      );
    }
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.path).toBe(ABSENT_FIELD_ID);
  });

  it('REFUSES a wrong-CASE field id (ids are case-sensitive)', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: 'CustomField:account.industry__c',
    });
    if (r.ok) {
      throw new Error(
        `expected component-not-found for a miscased id; got a confident totalCount=${String(
          r.value.data.totalCount,
        )} — the truth is ${String(6)} references on the correctly-cased id`,
      );
    }
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('component-not-found');
    // The refusal message must not read as "this field is clean" — it names the
    // id that was not found. (Ranked `resolveSuggestions` are NOT asserted here:
    // the shared `fieldNotFoundError` scopes its resolve to a CASE-EXACT parent
    // object id, so a miscased field id gets zero suggestions from every tool
    // that uses it. Reported to the orchestrator; out of this file's scope.)
    expect(r.error.message).toContain('CustomField:account.industry__c');
  });

  it('refuses through the `fieldId` alias too (no back door)', async () => {
    const r = await findFieldAnywhereHandler(ctx, { fieldId: ABSENT_FIELD_ID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('a componentTypes filter does not smuggle an absent field past the gate', async () => {
    const r = await findFieldAnywhereHandler(ctx, {
      targetId: ABSENT_FIELD_ID,
      componentTypes: ['ApexClass'],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('STILL ANSWERS for a phantom field (edges exist, definition not retrieved) and says so', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: PHANTOM_FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The reference is real — refusing here would throw away a true answer.
    expect(r.value.data.totalCount).toBe(1);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toContain('never retrieved');
  });

  it('an EXISTING field with references is unaffected by the gate', async () => {
    const r = await findFieldAnywhereHandler(ctx, { targetId: FIELD_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(6);
    expect(r.value.data.boundaries.join(' ')).not.toContain('never retrieved');
  });
});

describe('findFieldAnywhereInputSchema', () => {
  it('accepts a valid CustomField id', () => {
    expect(
      findFieldAnywhereInputSchema.safeParse({ targetId: FIELD_ID }).success,
    ).toBe(true);
  });

  it('accepts the `fieldId` alias at the schema level', () => {
    expect(
      findFieldAnywhereInputSchema.safeParse({ fieldId: FIELD_ID }).success,
    ).toBe(true);
  });

  it('accepts {} at the schema level (one-of-required enforced in the handler)', () => {
    // targetId/fieldId are both optional in the schema so either alias parses;
    // the handler returns invalid-query when NEITHER is supplied (tested above).
    expect(findFieldAnywhereInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects limit above 500', () => {
    expect(
      findFieldAnywhereInputSchema.safeParse({
        targetId: FIELD_ID,
        limit: 501,
      }).success,
    ).toBe(false);
  });
});
