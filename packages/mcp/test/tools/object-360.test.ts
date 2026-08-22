/// <reference types="vitest/globals" />
/**
 * Unit tests for `sfi.object_360`.
 *
 * The tool ANALYSES an object and never adjudicates it, so the tests that
 * matter pin the FACTS and the HONESTY, not a verdict:
 *
 *  - there is no verdict, no blocker vocabulary, and no field that says whether
 *    anything can be deleted;
 *  - what the object OWNS is separated from what points AT it from outside;
 *  - field-tier edges whose target has NO node (platform/audit fields, list-view
 *    column tokens, case-variant spellings) are COUNTED, not silently dropped —
 *    the 20.1% org-wide under-count this build closes;
 *  - a boolean the source XML never declared is `null` with a reason, never
 *    `false`; `externalSharingModel` is always `null` + reason;
 *  - ReportType referrers land on child FIELDS, so an object-tier-only filter
 *    returned an empty list for every object in the org;
 *  - a folded report BOOLEAN with no folded NAMES yields `distinctReports: null`
 *    plus a named boundary, never a counted zero;
 *  - profiles are counted and NAMED per CRUD verb, separately from permission
 *    sets, so an ascending id list can no longer hide every Profile behind the
 *    `PermissionSet:` prefix — in BOTH grant tiers, including the field-level
 *    one that was left as a single ascending list and named zero Profiles;
 *  - a `maxRowsPerSection` the byte budget cannot honour is reported as a
 *    REFUSAL that prescribes `includeSections`, never the knob just refused;
 *  - a name that differs only by CASE resolves (api names are case-insensitive)
 *    and a name that resolves to nothing gets the near-misses NAMED;
 *  - every capped list flips `truncated` and reports its true total;
 *  - the widest object fits the response byte budget at `maxRowsPerSection: 100`;
 *  - empty-because-not-modeled never renders as empty-because-none;
 *  - the RECORD-DATA questions are refused, verbatim, on every response.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExtendedVaultManifest } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { object360Handler } from '../../src/tools/object-360.js';

/**
 * Coverage rows matter: `RecordType` / `SharingRule` are RETRIEVED (an empty
 * result means "checked, none"), `Report` is requested-but-pending, and
 * `SharingSet` has no row at all (never modeled). The three read differently and
 * the tool must say which is which.
 */
const MANIFEST: ExtendedVaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2, CustomField: 3 },
  edges: { references: 3 },
  sourceTreeHash: 'sha256:fixture',
  coverage: [
    { type: 'CustomObject', requested: true, retrieved: 3, errored: false, neverModeled: false },
    { type: 'RecordType', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'SharingRule', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'FlexiPage', requested: true, retrieved: 1, errored: false, neverModeled: false },
    { type: 'Report', requested: true, retrieved: 0, errored: false, neverModeled: false, pending: true },
  ],
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const OBJ = 'CustomObject:Widget__c';
/** Field ids are `CustomField:<Object>.<Field>` — the real vault's shape. */
const FLD = 'CustomField:Widget__c';
const STANDARD = 'CustomObject:Contact';
const MANAGED = 'CustomObject:ns__Thing__c';

/**
 * `Widget__c`, built to exercise every defect at once:
 *   - 2 declared fields + 1 SYNTHETIC field;
 *   - a Flow that BOTH `triggersOn` the object and writes a field (the
 *     de-duplication case) and is `status: Active`;
 *   - a ValidationRule reaching only the FIELD tier (invisible to an
 *     object-node walk);
 *   - a ListView child with a `parentId` and NO `parentOf` edge;
 *   - TWO field-tier edges whose targets have NO node — `Widget__c.OwnerId`
 *     (a platform field) and `WIDGET__C.NAME` (a case-variant column token);
 *   - a ReportType edge landing on a child FIELD, never on the object;
 *   - 2 Profiles and 2 PermissionSets whose ids interleave under an ascending
 *     sort, with real CRUD flags;
 *   - a RecordType, a SharingRule, a FlexiPage, a lookup in each direction and
 *     a formula field on ANOTHER object resolving onto this one.
 */
const seed: ExtractionResult = {
  nodes: [
    node({
      id: OBJ,
      type: 'CustomObject',
      apiName: 'Widget__c',
      label: 'Widget',
      // `enableHistory` declared true; `enableReports` / `enableActivities`
      // land as `false` exactly the way the extractor writes an ABSENT element.
      properties: {
        sharingModel: 'Private',
        enableHistory: true,
        enableReports: false,
        enableActivities: false,
      },
    }),
    node({ id: `${FLD}.Name__c`, type: 'CustomField', apiName: 'Name__c', parentId: OBJ }),
    node({
      id: `${FLD}.Amount__c`,
      type: 'CustomField',
      apiName: 'Amount__c',
      parentId: OBJ,
      properties: { usedInReport: true, usedInReports: ['Rev_By_Region', 'Rev_By_Month'] },
    }),
    node({ id: `${FLD}.CreatedById`, type: 'CustomField', apiName: 'CreatedById', parentId: OBJ, properties: { synthetic: true } }),
    // parentId set, NO parentOf edge — the ListView shape the real vault has.
    node({ id: 'ListView:Widget__c.All', type: 'ListView', apiName: 'All', parentId: OBJ }),
    node({ id: 'Layout:Widget__c.Default', type: 'Layout', apiName: 'Default', parentId: OBJ }),
    node({ id: 'RecordType:Widget__c.Standard', type: 'RecordType', apiName: 'Standard', label: 'Standard', parentId: OBJ, properties: { active: true } }),
    node({ id: 'RecordType:Widget__c.Retired', type: 'RecordType', apiName: 'Retired', label: 'Retired', parentId: OBJ, properties: { active: false } }),
    node({
      id: 'SharingRule:Widget__c.Team_Read',
      type: 'SharingRule',
      apiName: 'Team_Read',
      parentId: OBJ,
      properties: { ruleType: 'criteria', accessLevel: 'Read', sharedToType: 'role', sharedToName: 'Ops' },
    }),
    node({ id: 'Flow:WidgetSave', type: 'Flow', apiName: 'WidgetSave', properties: { status: 'Active' } }),
    node({ id: 'Flow:WidgetRetired', type: 'Flow', apiName: 'WidgetRetired', properties: { status: 'Obsolete' } }),
    node({ id: 'ValidationRule:Widget__c.AmountPositive', type: 'ValidationRule', apiName: 'AmountPositive', parentId: OBJ, properties: { active: true } }),
    node({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    node({ id: 'Profile:ReadOnly', type: 'Profile', apiName: 'ReadOnly' }),
    node({ id: 'PermissionSet:Alpha', type: 'PermissionSet', apiName: 'Alpha' }),
    node({ id: 'PermissionSet:Beta', type: 'PermissionSet', apiName: 'Beta' }),
    // A lookup INTO Widget__c, carrying the declared relationship metadata.
    node({
      id: 'CustomField:Order__c.Widget__c',
      type: 'CustomField',
      apiName: 'Widget__c',
      parentId: 'CustomObject:Order__c',
      properties: { referenceTo: 'Widget__c', relationshipName: 'Widgets', dataType: 'Lookup' },
    }),
    // A formula field on ANOTHER object whose token resolved onto Widget__c.
    node({
      id: 'CustomField:Order__c.WidgetAmount__c',
      type: 'CustomField',
      apiName: 'WidgetAmount__c',
      parentId: 'CustomObject:Order__c',
      properties: { formula: 'Widgets__r.Amount__c', dataType: 'Formula' },
    }),
    // Widget__c's OWN outbound relationship — declared on the child field.
    node({
      id: `${FLD}.Account__c`,
      type: 'CustomField',
      apiName: 'Account__c',
      parentId: OBJ,
      properties: { referenceTo: 'Account', relationshipName: 'Widgets', dataType: 'Lookup' },
    }),
    node({ id: 'Queue:WidgetQueue', type: 'Queue', apiName: 'WidgetQueue' }),
    node({ id: 'ReportType:Widget_Metrics', type: 'ReportType', apiName: 'Widget_Metrics' }),
    node({ id: 'FlexiPage:Widget_Record', type: 'FlexiPage', apiName: 'Widget_Record', properties: { pageType: 'RecordPage', sobjectType: 'Widget__c' } }),
  ],
  edges: [
    edge({ fromId: OBJ, toId: `${FLD}.Name__c`, edgeType: 'parentOf' }),
    edge({ fromId: OBJ, toId: `${FLD}.Amount__c`, edgeType: 'parentOf' }),
    edge({ fromId: OBJ, toId: `${FLD}.CreatedById`, edgeType: 'parentOf' }),
    // ONE referrer that reaches BOTH tiers.
    edge({ fromId: 'Flow:WidgetSave', toId: OBJ, edgeType: 'triggersOn' }),
    edge({ fromId: 'Flow:WidgetSave', toId: `${FLD}.Amount__c`, edgeType: 'writesTo' }),
    // An INACTIVE flow bound to the object — counted, and NOT called active.
    edge({ fromId: 'Flow:WidgetRetired', toId: OBJ, edgeType: 'triggersOn' }),
    // FIELD-TIER ONLY — invisible to an object-node walk.
    edge({ fromId: 'ValidationRule:Widget__c.AmountPositive', toId: `${FLD}.Amount__c`, edgeType: 'references', source: 'enterprise-metadata' }),
    // PHANTOM TARGETS — no node exists for either id. The old build dropped both.
    edge({ fromId: 'Layout:Widget__c.Default', toId: `${FLD}.OwnerId`, edgeType: 'references', source: 'layout-extractor' }),
    edge({ fromId: 'ListView:Widget__c.All', toId: 'CustomField:WIDGET__C.NAME', edgeType: 'references', source: 'enterprise-metadata' }),
    // ReportType lands on a child FIELD, never on the object node.
    edge({ fromId: 'ReportType:Widget_Metrics', toId: `${FLD}.Amount__c`, edgeType: 'references', source: 'enterprise-metadata' }),
    // Access is NOT usage. Ids interleave so an ascending sort would cut Profiles.
    edge({ fromId: 'Profile:Admin', toId: OBJ, edgeType: 'grantedBy', properties: { allowCreate: true, allowRead: true, allowEdit: true, allowDelete: true, viewAllRecords: true, modifyAllRecords: true } }),
    edge({ fromId: 'Profile:ReadOnly', toId: OBJ, edgeType: 'grantedBy', properties: { allowCreate: false, allowRead: true, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false } }),
    edge({ fromId: 'PermissionSet:Alpha', toId: OBJ, edgeType: 'grantedBy', properties: { allowCreate: true, allowRead: true, allowEdit: true, allowDelete: false, viewAllRecords: false, modifyAllRecords: false } }),
    edge({ fromId: 'PermissionSet:Beta', toId: OBJ, edgeType: 'grantedBy', properties: { allowCreate: false, allowRead: true, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false } }),
    edge({ fromId: 'Profile:Admin', toId: `${FLD}.Amount__c`, edgeType: 'grantedBy', properties: { readable: true } }),
    // Relationship in, sharing in, page in.
    edge({ fromId: 'CustomField:Order__c.Widget__c', toId: OBJ, edgeType: 'lookupTo', source: 'custom-field-extractor', properties: { relationshipType: 'Lookup' } }),
    edge({ fromId: 'Queue:WidgetQueue', toId: OBJ, edgeType: 'sharedWith', properties: { relationship: 'queueOwner' } }),
    edge({ fromId: 'FlexiPage:Widget_Record', toId: OBJ, edgeType: 'references', source: 'flexipage-extractor' }),
    // A formula field on ANOTHER object resolving onto one of THIS object's fields.
    edge({ fromId: 'CustomField:Order__c.WidgetAmount__c', toId: `${FLD}.Amount__c`, edgeType: 'references', source: 'formula-tokenizer' }),
  ],
};

/** A standard object and a managed object — provenance, not a gate. */
const gateSeed: ExtractionResult = {
  nodes: [
    node({ id: STANDARD, type: 'CustomObject', apiName: 'Contact' }),
    node({ id: MANAGED, type: 'CustomObject', apiName: 'ns__Thing__c' }),
  ],
  edges: [],
};

/**
 * A deliberately WIDE object: enough referrers, fields and children to push the
 * assembled response past the byte budget, so the byte-fit pass is exercised on
 * a fixture rather than only on a real vault.
 */
const WIDE = 'CustomObject:Wide__c';
const wideSeed: ExtractionResult = (() => {
  const nodes: Node[] = [node({ id: WIDE, type: 'CustomObject', apiName: 'Wide__c', properties: { sharingModel: 'Private' } })];
  const edges: Edge[] = [];
  const referrerTypes = ['Flow', 'ApexClass', 'ValidationRule', 'Layout', 'ListView', 'FieldSet', 'QuickAction', 'WebLink'] as const;
  for (let f = 0; f < 120; f += 1) {
    const fieldId = `CustomField:Wide__c.Field_${String(f).padStart(3, '0')}__c`;
    nodes.push(node({ id: fieldId, type: 'CustomField', apiName: `Field_${f}__c`, parentId: WIDE }));
    for (const t of referrerTypes) {
      const rid = `${t}:WideRef_${t}_${String(f % 30).padStart(3, '0')}`;
      if (f < 30) nodes.push(node({ id: rid, type: t, apiName: `WideRef_${t}_${f}` }));
      edges.push(edge({ fromId: rid, toId: fieldId, edgeType: 'references', source: 'enterprise-metadata' }));
    }
  }
  // 120 granters (60 Profiles + 60 PermissionSets): enough that `maxRowsPerSection:
  // 100` cannot be honoured, which is the case the refusal note exists for.
  for (let p = 0; p < 120; p += 1) {
    const pid = `${p % 2 === 0 ? 'Profile' : 'PermissionSet'}:WideGrant_${String(p).padStart(3, '0')}`;
    nodes.push(node({ id: pid, type: p % 2 === 0 ? 'Profile' : 'PermissionSet', apiName: `WideGrant_${p}` }));
    edges.push(edge({ fromId: pid, toId: WIDE, edgeType: 'grantedBy', properties: { allowCreate: true, allowRead: true, allowEdit: true, allowDelete: false, viewAllRecords: false, modifyAllRecords: false } }));
    // FIELD-level grants from the SAME granters — the tier the real vault makes
    // the LARGER of the two. Every `PermissionSet:` id sorts ahead of every
    // `Profile:` id, so one ascending list capped at anything below 30 named
    // ZERO Profiles here, exactly as it did on the real vault's widest object.
    for (let f = 0; f < 8; f += 1) {
      edges.push(
        edge({
          fromId: pid,
          toId: `CustomField:Wide__c.Field_${String(f).padStart(3, '0')}__c`,
          edgeType: 'grantedBy',
          properties: { readable: true, editable: p % 4 === 0 },
        }),
      );
    }
  }
  for (let l = 0; l < 80; l += 1) {
    nodes.push(node({ id: `ListView:Wide__c.LV_${String(l).padStart(3, '0')}`, type: 'ListView', apiName: `LV_${l}`, parentId: WIDE }));
  }
  return { nodes, edges };
})();

let store: GraphStore;
let tempDir: string;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-object-360-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed, gateSeed, wideSeed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

/** Narrow the untyped section bag the handler returns. */
const sectionOf = (data: Readonly<Record<string, unknown>>, name: string): Record<string, unknown> =>
  data[name] as Record<string, unknown>;

/** Run the handler for `Widget__c` and return its `data`, failing loudly otherwise. */
const widget = async (
  extra: Record<string, unknown> = {},
): Promise<Readonly<Record<string, unknown>>> => {
  const r = await object360Handler(ctx, { objectApiName: 'Widget__c', ...extra });
  if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`);
  return r.value.data;
};

describe('object360Handler — no verdict, ever', () => {
  it('emits no deleteAssessment, no blockers and no blocking vocabulary', async () => {
    const data = await widget();
    expect(data['deleteAssessment']).toBeUndefined();
    expect(data['blockers']).toBeUndefined();
    const serialized = JSON.stringify(data);
    for (const banned of [
      'no-blockers-found',
      'cannot-delete-standard-object',
      'cannot-delete-managed-object',
      'blockingReferences',
      '"blockers"',
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('reports a null verdict with a stated reason instead of adjudicating', async () => {
    const summary = (await widget())['summary'] as Record<string, unknown>;
    expect(summary['verdict']).toBeNull();
    expect(String(summary['verdictNote'])).toContain('never adjudicates');
  });

  it('does not gate a STANDARD or MANAGED object — it describes provenance', async () => {
    const std = await object360Handler(ctx, { objectApiName: 'Contact' });
    expect(std.ok).toBe(true);
    if (!std.ok) return;
    expect(sectionOf(std.value.data, 'identity')['objectKind']).toBe('standard');
    expect(std.value.data['deleteAssessment']).toBeUndefined();

    const managed = await object360Handler(ctx, { objectApiName: 'ns__Thing__c' });
    expect(managed.ok).toBe(true);
    if (!managed.ok) return;
    const identity = sectionOf(managed.value.data, 'identity');
    expect(identity['objectKind']).toBe('managed');
    expect(identity['namespace']).toBe('ns');
  });
});

describe('object360Handler — owns vs usage', () => {
  it('separates what the object CONTAINS from what points AT it', async () => {
    const data = await widget();
    const owns = sectionOf(data, 'owns');
    const usage = sectionOf(data, 'usage');
    // 4 fields + list view + layout + 2 record types + sharing rule + VR = 10.
    expect(owns['totalComponents']).toBe(10);
    expect((owns['byType'] as Record<string, number>)['ListView']).toBe(1);
    expect(String(owns['framing'])).toContain('CONTAINED');
    expect(String(usage['framing'])).toContain('OUTSIDE');
    // neither side is called blocking
    expect(JSON.stringify(owns)).not.toContain('block');
  });

  it('counts a ListView child that has a parentId and NO parentOf edge', async () => {
    const owns = sectionOf(await widget(), 'owns');
    expect((owns['byType'] as Record<string, number>)['ListView']).toBe(1);
  });

  it('de-duplicates a referrer that reaches BOTH tiers in `combined`', async () => {
    const usage = sectionOf(await widget(), 'usage');
    const objectLevel = usage['objectLevel'] as Record<string, number>;
    const combined = usage['combined'] as Record<string, number>;
    // object tier: 2 Flows + CustomField lookup + Queue + FlexiPage = 5.
    expect(objectLevel['distinctReferrers']).toBe(5);
    // The active Flow is in both tiers, so the union is smaller than the sum.
    expect(combined['distinctReferrers']).toBeLessThan(
      objectLevel['distinctReferrers']! +
        (usage['fieldLevel'] as Record<string, number>)['distinctReferrers']!,
    );
  });

  it('excludes access grants and containment from BOTH usage tiers', async () => {
    const data = await widget();
    const usage = sectionOf(data, 'usage');
    const objectByEdge = (usage['objectLevel'] as Record<string, Record<string, number>>)['byEdgeType']!;
    const fieldByEdge = (usage['fieldLevel'] as Record<string, Record<string, number>>)['byEdgeType']!;
    expect(objectByEdge['grantedBy']).toBeUndefined();
    expect(objectByEdge['parentOf']).toBeUndefined();
    expect(fieldByEdge['grantedBy']).toBeUndefined();
    expect(fieldByEdge['parentOf']).toBeUndefined();
    const permissions = sectionOf(data, 'permissions');
    expect((permissions['fieldLevelGrants'] as Record<string, number>)['edges']).toBe(1);
  });
});

describe('object360Handler — DEFECT 1: field-tier edges to un-noded targets', () => {
  it('COUNTS an edge whose target field id has no node (platform field)', async () => {
    const fieldLevel = (sectionOf(await widget(), 'usage')['fieldLevel']) as Record<string, unknown>;
    // Amount__c: writesTo + VR references + ReportType + formula = 4;
    // plus the two phantom targets (OwnerId, WIDGET__C.NAME) = 6.
    // Enumerating from `listChildren` alone yields 4 and drops the last two.
    expect(fieldLevel['edges']).toBe(6);
    expect(fieldLevel['unresolvedTargetEdges']).toBe(2);
    expect(fieldLevel['unresolvedTargets']).toBe(2);
  });

  it('matches the object segment CASE-INSENSITIVELY so a column token is not lost', async () => {
    const fieldLevel = (sectionOf(await widget(), 'usage')['fieldLevel']) as Record<string, unknown>;
    const sample = fieldLevel['unresolvedTargetsSample'] as readonly string[];
    expect(sample).toContain('CustomField:WIDGET__C.NAME');
    expect(sample).toContain('CustomField:Widget__c.OwnerId');
  });

  it('keeps un-noded targets OUT of the declared-field totals', async () => {
    const data = await widget();
    const fieldLevel = (sectionOf(data, 'usage')['fieldLevel']) as Record<string, number>;
    const fields = sectionOf(data, 'identity')['fields'] as Record<string, number>;
    expect(fieldLevel['declaredFieldsTotal']).toBe(4);
    expect(fields['total']).toBe(4);
    expect(fields['unresolvedReferencedTargets']).toBe(2);
    // only Amount__c among the DECLARED fields is referenced
    expect(fieldLevel['declaredFieldsReferenced']).toBe(1);
  });

  it('states the un-counted tier exactly rather than reporting a clean total', async () => {
    const fieldLevel = (sectionOf(await widget(), 'usage')['fieldLevel']) as Record<string, unknown>;
    const note = String(fieldLevel['unresolvedNote']);
    expect(note).toContain('2 of the 6 field-tier edge(s)');
    expect(note).toContain('NOT in `declaredFieldsReferenced`');
  });

  it('says "nothing to resolve" rather than "none dropped" when no field edge exists', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Contact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fieldLevel = (sectionOf(r.value.data, 'usage')['fieldLevel']) as Record<string, unknown>;
    expect(String(fieldLevel['unresolvedNote'])).toContain('nothing to resolve');
  });
});

describe('object360Handler — DEFECT 2: absent is null, never false', () => {
  it('reports an UNDECLARED boolean as null with a reason, not as false', async () => {
    const identity = sectionOf(await widget(), 'identity');
    const reports = identity['enableReports'] as Record<string, unknown>;
    expect(reports['value']).toBeNull();
    expect(reports['value']).not.toBe(false);
    expect(String(reports['unavailableReason'])).toContain('indistinguishable');
    const activities = identity['enableActivities'] as Record<string, unknown>;
    expect(activities['value']).toBeNull();
  });

  it('keeps a DECLARED true as true', async () => {
    const identity = sectionOf(await widget(), 'identity');
    expect((identity['enableHistory'] as Record<string, unknown>)['value']).toBe(true);
  });

  it('never asserts externalSharingModel, which the extractor does not capture', async () => {
    const data = await widget();
    const external = sectionOf(data, 'identity')['externalSharingModel'] as Record<string, unknown>;
    expect(external['value']).toBeNull();
    expect(String(external['unavailableReason'])).toContain('never captures it');
    // and the same object is reachable from the sharing section
    const owd = sectionOf(data, 'sharing')['orgWideDefault'] as Record<string, unknown>;
    expect((owd['external'] as Record<string, unknown>)['value']).toBeNull();
    expect(owd['internal']).toBe('Private');
  });
});

describe('object360Handler — DEFECT 3: analytics that contradicted itself', () => {
  it('finds a ReportType referrer that lands on a child FIELD, not the object', async () => {
    const analytics = sectionOf(await widget(), 'analytics');
    const reportTypes = analytics['reportTypes'] as Record<string, unknown>;
    // The object node carries ZERO ReportType edges — an object-tier-only
    // filter (the old build) returned [] here for every object in the org.
    expect(reportTypes['objectTierReferrers']).toBe(0);
    expect(reportTypes['total']).toBe(1);
    expect(reportTypes['reportTypes']).toContain('ReportType:Widget_Metrics');
  });

  it('names reports when the fold carries NAMES', async () => {
    const analytics = sectionOf(await widget(), 'analytics');
    expect(analytics['fieldsUsedInReports']).toBe(1);
    expect(analytics['distinctReports']).toBe(2);
    expect(analytics['reports']).toEqual(['Rev_By_Month', 'Rev_By_Region']);
    expect(analytics['reportNameAvailability']).toBeUndefined();
  });

  it('emits distinctReports NULL — never a counted zero — when only the BOOLEAN is folded', async () => {
    const local = mkdtempSync(join(tmpdir(), 'sfi-o360-bool-'));
    const opened = await openGraph(join(local, 'g.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const boolSeed: ExtractionResult = {
      nodes: [
        node({ id: 'CustomObject:Bool__c', type: 'CustomObject', apiName: 'Bool__c' }),
        // usedInReport true, but NO usedInReports name array — the real vault shape.
        node({ id: 'CustomField:Bool__c.A__c', type: 'CustomField', apiName: 'A__c', parentId: 'CustomObject:Bool__c', properties: { usedInReport: true } }),
        node({ id: 'CustomField:Bool__c.B__c', type: 'CustomField', apiName: 'B__c', parentId: 'CustomObject:Bool__c', properties: { usedInReport: true } }),
      ],
      edges: [],
    };
    const imp = await importExtractionResults(opened.value, [boolSeed]);
    expect(imp.ok).toBe(true);
    const localCtx: Context = { vaultRoot: local, manifest: MANIFEST, graph: opened.value };
    const r = await object360Handler(localCtx, { objectApiName: 'Bool__c' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const analytics = sectionOf(r.value.data, 'analytics');
      expect(analytics['fieldsUsedInReports']).toBe(2);
      expect(analytics['distinctReports']).toBeNull();
      expect(analytics['distinctReports']).not.toBe(0);
      const availability = analytics['reportNameAvailability'] as Record<string, unknown>;
      expect(String(availability['reason'])).toContain('2 field(s)');
      expect(String(availability['reason'])).toContain('sfi refresh --with-reports');
    }
    await closeGraph(opened.value);
    rmSync(local, { recursive: true, force: true });
  });

  it('discloses that report AUTHORSHIP is a permanent privacy boundary', async () => {
    const data = await widget();
    const reportNodes = sectionOf(data, 'analytics')['reportNodes'] as Record<string, unknown>;
    expect(String(reportNodes['folderNote'])).toContain('AUTHOR');
    expect(String((reportNodes['availability'] as Record<string, unknown>)['note'])).toContain('NOT "no report references this object"');
    expect((data['dataNotAvailable'] as readonly string[]).join(' ')).toContain('report-authorship');
  });
});

describe('object360Handler — DEFECT 4: which profiles can create / edit', () => {
  it('counts and NAMES profiles per CRUD verb, separately from permission sets', async () => {
    const objectCrud = sectionOf(await widget(), 'permissions')['objectCrud'] as Record<string, unknown>;
    const profiles = objectCrud['profiles'] as Record<string, unknown>;
    const permsets = objectCrud['permissionSets'] as Record<string, unknown>;
    expect(profiles['granters']).toBe(2);
    expect(profiles['canCreate']).toBe(1);
    expect(profiles['canRead']).toBe(2);
    expect(profiles['canEdit']).toBe(1);
    expect(profiles['canDelete']).toBe(1);
    const names = profiles['names'] as Record<string, readonly string[]>;
    expect(names['allowCreate']).toEqual(['Profile:Admin']);
    expect(names['allowRead']).toEqual(['Profile:Admin', 'Profile:ReadOnly']);
    // separate axis, not merged into one ascending id list
    expect(permsets['granters']).toBe(2);
    expect((permsets['names'] as Record<string, readonly string[]>)['allowCreate']).toEqual(['PermissionSet:Alpha']);
  });

  it('never drops Profiles behind `PermissionSet:` in an ascending id sort', async () => {
    // The old build sorted ALL granters into one list; `PermissionSet:` sorts
    // before `Profile:`, so a cap smaller than the granter count named zero
    // Profiles. A per-type list cannot express that failure.
    const objectCrud = sectionOf(await widget({ maxRowsPerSection: 1 }), 'permissions')['objectCrud'] as Record<string, unknown>;
    const names = (objectCrud['profiles'] as Record<string, unknown>)['names'] as Record<string, readonly string[]>;
    expect(names['allowRead']!.length).toBeGreaterThan(0);
    expect(names['allowRead']![0]).toMatch(/^Profile:/);
  });

  it('surfaces the headline counts in the brief and points at the detail', async () => {
    const brief = sectionOf(await widget(), 'brief');
    const who = brief['whoCanReachIt'] as Record<string, unknown>;
    expect(who['profilesGranted']).toBe(2);
    expect(who['profilesThatCanCreate']).toBe(1);
    expect(who['profilesThatCanEdit']).toBe(1);
    expect(who['detailIn']).toBe('permissions');
  });

  it('says container counts are never a user headcount and names the PSG tool', async () => {
    const note = String(sectionOf(await widget(), 'permissions')['note']);
    expect(note).toContain('CONTAINERS, not users');
    expect(note).toContain('sfi.object_access_audit');
  });
});

describe('object360Handler — DEFECT 5: the documented escape hatch fits the budget', () => {
  // The dispatcher's default response budget; the tool must fit UNDER it at the
  // very cap its own truncation note tells a caller to raise to.
  const DISPATCH_BUDGET = 40_000;

  it('returns the widest fixture object under budget at maxRowsPerSection: 100', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Buffer.byteLength(JSON.stringify(r.value))).toBeLessThan(DISPATCH_BUDGET);
  });

  it('fits at every cap from 1 to 100 without ever erroring', async () => {
    for (const capValue of [1, 20, 50, 100]) {
      const r = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: capValue });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(Buffer.byteLength(JSON.stringify(r.value))).toBeLessThan(DISPATCH_BUDGET);
    }
  });

  it('discloses the effective cap when the byte budget forced a smaller one', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scope = r.value.data['appliedScope'] as Record<string, unknown>;
    expect(scope['maxRowsPerSection']).toBe(100);
    if (scope['effectiveMaxRowsPerSection'] !== undefined) {
      expect(Number(scope['effectiveMaxRowsPerSection'])).toBeLessThanOrEqual(100);
      expect(String(r.value.data['truncationNote'])).toContain('effectiveMaxRowsPerSection');
    }
  });

  it('keeps every AGGREGATE exact regardless of the cap that was applied', async () => {
    const tight = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: 1 });
    const wide = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: 100 });
    expect(tight.ok && wide.ok).toBe(true);
    if (!tight.ok || !wide.ok) return;
    const aggregatesOf = (d: Readonly<Record<string, unknown>>): unknown => {
      const s = d['summary'] as Record<string, unknown>;
      const u = sectionOf(d, 'usage');
      return {
        summary: s,
        objectEdges: (u['objectLevel'] as Record<string, unknown>)['edges'],
        fieldEdges: (u['fieldLevel'] as Record<string, unknown>)['edges'],
        combined: u['combined'],
      };
    };
    expect(aggregatesOf(tight.value.data)).toEqual(aggregatesOf(wide.value.data));
  });
});

describe('object360Handler — DEFECT 6: truncated never lies', () => {
  it('flips `truncated` and reports a TRUE total whenever any list was capped', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data['truncated']).toBe(true);
    const truncation = r.value.data['truncation'] as ReadonlyArray<Record<string, number>>;
    expect(truncation.length).toBeGreaterThan(0);
    for (const row of truncation) {
      expect(row['total']).toBeGreaterThan(row['shown']!);
    }
    // the usage samples and the owns rows are among the capped lists — both
    // capped SILENTLY in the old build, which only recorded two sites.
    const sections = truncation.map((t) => String(t['section']));
    expect(sections.some((s) => s.startsWith('usage.'))).toBe(true);
    expect(sections.some((s) => s.startsWith('owns.'))).toBe(true);
  });

  it('reports `truncated: false` only when nothing was capped', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Widget__c', maxRowsPerSection: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data['truncated']).toBe(false);
    expect(r.value.data['truncation']).toBeUndefined();
  });

  it('never names a truncated list from a section the caller filtered out', async () => {
    const r = await object360Handler(ctx, {
      objectApiName: 'Wide__c',
      maxRowsPerSection: 1,
      includeSections: ['identity'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const truncation = (r.value.data['truncation'] ?? []) as ReadonlyArray<Record<string, unknown>>;
    for (const row of truncation) expect(String(row['section']).startsWith('identity')).toBe(true);
  });
});

describe('object360Handler — DEFECT 7: messages that read as English', () => {
  it('builds a component-not-found message from a TYPE label, not a sentence', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'NotHere__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    // the old call passed a whole sentence as the `kindLabel` argument, giving
    // "no no object matches `X` in this vault with id X".
    expect(r.error.message).not.toContain('no object matches');
    expect(r.error.message).toContain('no CustomObject with id CustomObject:NotHere__c');
  });

  it('does not claim "referenced by the edges below" for an object with no edges', async () => {
    // `Contact` here has a node but no edges and no children.
    const r = await object360Handler(ctx, { objectApiName: 'Contact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.value.data)).not.toContain('referenced by the edges below');
  });

  it('says a zero field count means NOT RETRIEVED for an object with no node', async () => {
    const local = mkdtempSync(join(tmpdir(), 'sfi-o360-phantom-'));
    const opened = await openGraph(join(local, 'g.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const phantomSeed: ExtractionResult = {
      nodes: [node({ id: 'Profile:P', type: 'Profile', apiName: 'P' })],
      edges: [edge({ fromId: 'Profile:P', toId: 'CustomObject:Solution', edgeType: 'grantedBy', properties: { allowRead: true } })],
    };
    const imp = await importExtractionResults(opened.value, [phantomSeed]);
    expect(imp.ok).toBe(true);
    const localCtx: Context = { vaultRoot: local, manifest: MANIFEST, graph: opened.value };
    const r = await object360Handler(localCtx, { objectApiName: 'Solution' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const identity = sectionOf(r.value.data, 'identity');
      expect(identity['retrieved']).toBe(false);
      const note = String(identity['notRetrievedNote']);
      expect(note).toContain('NOT RETRIEVED, never "no fields"');
      // the grant is reported as ACCESS, and never counted as usage
      expect(note).toContain('1 access grant(s)');
      expect((sectionOf(r.value.data, 'usage')['objectLevel'] as Record<string, number>)['edges']).toBe(0);
    }
    await closeGraph(opened.value);
    rmSync(local, { recursive: true, force: true });
  });
});

describe('object360Handler — the sections the owner asked for', () => {
  it('dates the last METADATA change and refuses to call it activity', async () => {
    const change = sectionOf(await widget(), 'brief')['lastMetadataChange'] as Record<string, unknown>;
    expect(change['scope']).toBe('SCHEMA-DEFINITION');
    const def = change['objectDefinition'] as Record<string, unknown>;
    expect(def['lastModifiedDate']).toBeNull();
    expect(String(def['unavailableReason'])).toContain('--with-tooling-api');
    expect(String(def['unavailableReason'])).toContain('NOT CAPTURED');
    expect(String(change['warning'])).toContain('NOT activity');
  });

  it('lists record types with their activation state', async () => {
    const recordTypes = sectionOf(await widget(), 'recordTypes');
    expect(recordTypes['total']).toBe(2);
    expect(recordTypes['active']).toBe(1);
    expect(recordTypes['inactive']).toBe(1);
    expect((recordTypes['availability'] as Record<string, unknown>)['modeled']).toBe(true);
  });

  it('lists sharing rules and says SharingSet is NOT MODELED rather than empty', async () => {
    const sharing = sectionOf(await widget(), 'sharing');
    const rules = sharing['sharingRules'] as Record<string, unknown>;
    expect(rules['total']).toBe(1);
    expect((rules['byAccessLevel'] as Record<string, number>)['Read']).toBe(1);
    const sets = sharing['sharingSets'] as Record<string, unknown>;
    expect(sets['modeled']).toBe(false);
    expect(sets['total']).toBe(0);
    const note = String((sets['availability'] as Record<string, unknown>)['note']);
    expect(note).toContain('NOT MODELED');
    expect(note).toContain('NOTHING was checked');
    expect(note).toContain('must NOT be read as "this object is in no sharing set"');
  });

  it('reports related objects in BOTH directions from declared metadata', async () => {
    const rel = sectionOf(await widget(), 'relationships');
    const out = rel['toOtherObjects'] as Record<string, unknown>;
    const inbound = rel['fromOtherObjects'] as Record<string, unknown>;
    expect(out['relationshipFields']).toBe(1);
    expect((out['targets'] as Record<string, number>)['Account']).toBe(1);
    expect(inbound['relationshipFields']).toBe(1);
    expect((inbound['objects'] as Record<string, number>)['Order__c']).toBe(1);
    expect(inbound['lookup']).toBe(1);
  });

  it('finds a formula field on ANOTHER object and bounds what it cannot see', async () => {
    const formula = sectionOf(await widget(), 'relationships')['usedInFormulaFields'] as Record<string, unknown>;
    expect(formula['onOtherObjects']).toBe(1);
    expect(formula['fields']).toContain('CustomField:Order__c.WidgetAmount__c');
    const boundary = String(formula['boundaryNote']);
    expect(boundary).toContain('NEVER "no formula elsewhere reads this object"');
    expect(boundary).toContain('sfi.find_formula_references');
  });

  it('lists Lightning record pages and discloses that Experience sites are not modeled', async () => {
    const pages = sectionOf(await widget(), 'recordPages');
    const lightning = pages['lightningRecordPages'] as Record<string, unknown>;
    expect(lightning['total']).toBe(1);
    expect((lightning['byPageType'] as Record<string, number>)['RecordPage']).toBe(1);
    const community = pages['communityRecordPages'] as Record<string, unknown>;
    expect(community['total']).toBe(0);
    expect(String((community['experienceSiteModeling'] as Record<string, unknown>)['note'])).toContain('NOT MODELED');
    expect((pages['classicLayouts'] as Record<string, unknown>)['total']).toBe(1);
  });

  it('splits automation into ACTIVE and INACTIVE and never assumes activation', async () => {
    const automations = sectionOf(await widget(), 'automations');
    const flows = (automations['firesOnSave'] as ReadonlyArray<Record<string, unknown>>).find(
      (r) => r['referrerType'] === 'Flow',
    );
    expect(flows?.['count']).toBe(2);
    expect(flows?.['active']).toBe(1);
    expect(flows?.['inactive']).toBe(1);
    expect(automations['activeBoundToObject']).toBe(1);
    expect(String(automations['firesOnSaveNote'])).toContain('NOT assumed active');
  });

  it('refuses every RECORD-DATA ask with a null and names the live tool', async () => {
    const recordData = sectionOf(await widget(), 'recordData');
    for (const key of ['recordCount', 'lastRecordCreated', 'topRecordOwner', 'topRecordCreator', 'fieldPopulation']) {
      expect(recordData[key]).toBeNull();
    }
    const answeredBy = recordData['answeredBy'] as Record<string, string>;
    expect(answeredBy['recordCount']).toBe('sfi.live_count');
    expect(answeredBy['lastRecordCreated']).toBe('sfi.live_recent_activity');
    expect(answeredBy['topRecordOwner']).toBe('sfi.live_owner_breakdown');
    expect(String(recordData['liveNote'])).toContain('never calls the live plane');
  });
});

describe('object360Handler — honesty surfaces', () => {
  it('keeps the two original RECORD-DATA refusals byte-identical and adds the rest', async () => {
    const data = await widget();
    const dna = data['dataNotAvailable'] as readonly string[];
    expect(dna.length).toBeGreaterThanOrEqual(7);
    expect(dna[0]).toContain('field-population');
    expect(dna[0]).toContain('sfi.unused_fields_deep');
    expect(dna[1]).toContain('record-recency');
    expect(dna[1]).toContain('sfi.live_count');
    const joined = dna.join(' ');
    for (const topic of ['last-record-created', 'record-count', 'top-record-owner', 'report-authorship', 'last-used']) {
      expect(joined).toContain(topic);
    }
  });

  it('emits dataNotAvailable OUTSIDE includeSections filtering', async () => {
    const full = await widget();
    const narrowed = await widget({ includeSections: ['identity'] });
    expect(narrowed['dataNotAvailable']).toEqual(full['dataNotAvailable']);
    expect(narrowed['usage']).toBeUndefined();
    expect(narrowed['boundaries']).toBeDefined();
  });

  it('states BOTH tier counts in a tierNote repeated in the boundaries', async () => {
    const data = await widget();
    const tierNote = String(sectionOf(data, 'usage')['tierNote']);
    expect(tierNote).toContain('FURTHER 6 inbound usage edge(s)');
    expect((data['boundaries'] as string[]).join(' ')).toContain('FURTHER 6 inbound usage edge(s)');
  });

  it('leads the boundaries with the refusal to adjudicate', async () => {
    const boundaries = (await widget())['boundaries'] as readonly string[];
    expect(boundaries[0]).toContain('does NOT adjudicate');
  });

  it('attaches a coverage caveat only when BOTH usage tiers came back empty', async () => {
    const withUsage = await widget();
    expect(withUsage['coverageCaveat']).toBeUndefined();
    const empty = await object360Handler(ctx, { objectApiName: 'Contact' });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.value.data['coverageCaveat']).toBeDefined();
  });
});

describe('object360Handler — QA-1: the field tier named zero Profiles', () => {
  /**
   * The block's own note claimed the two kinds were "listed SEPARATELY so a
   * shared ascending id list cannot drop every Profile behind the
   * `PermissionSet:` prefix" — and the field tier, the LARGER of the two, was
   * still one ascending list. On the probe vault's widest object that meant 82
   * granters, 52 of them Profiles, and not one Profile named by a DEFAULT call.
   */
  it('names at least one Profile in the DEFAULT call\'s field-level granters', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Wide__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flg = sectionOf(r.value.data, 'permissions')['fieldLevelGrants'] as Record<string, unknown>;
    const profiles = flg['profiles'] as Record<string, unknown>;
    const names = profiles['names'] as readonly string[];
    expect(names.length).toBeGreaterThan(0);
    for (const id of names) expect(id).toMatch(/^Profile:/);
    // and the permission sets are on their own axis, not competing for the cap
    const permsets = flg['permissionSets'] as Record<string, unknown>;
    const psNames = permsets['names'] as readonly string[];
    expect(psNames.length).toBeGreaterThan(0);
    for (const id of psNames) expect(id).toMatch(/^PermissionSet:/);
  });

  it('carries per-kind distinct counts that decompose the blended total', async () => {
    const flg = sectionOf(await widget(), 'permissions')['fieldLevelGrants'] as Record<string, unknown>;
    const profiles = flg['profiles'] as Record<string, unknown>;
    const permsets = flg['permissionSets'] as Record<string, unknown>;
    // Widget__c: ONE field grant, from a Profile, readable only.
    expect(flg['distinctGranters']).toBe(1);
    expect(profiles['granters']).toBe(1);
    expect(profiles['canReadSomeField']).toBe(1);
    expect(profiles['canEditSomeField']).toBe(0);
    expect(profiles['names']).toEqual(['Profile:Admin']);
    // a CHECKED zero on the other axis, and the note says which kind of zero
    expect(permsets['granters']).toBe(0);
    expect(permsets['names']).toEqual([]);
    expect(String(flg['note'])).toContain('Both zeros are CHECKED');
  });

  it('flips a per-list truncation flag carrying the TRUE total on each axis', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flg = sectionOf(r.value.data, 'permissions')['fieldLevelGrants'] as Record<string, unknown>;
    for (const kind of ['profiles', 'permissionSets']) {
      const axis = flg[kind] as Record<string, unknown>;
      expect(axis['namesTruncated']).toBe(true);
      expect(axis['namesTotal']).toBe(axis['granters']);
      expect(Number(axis['namesTotal'])).toBeGreaterThan((axis['names'] as readonly string[]).length);
    }
  });

  it('says NOT CHECKED, not zero, when the vault holds no field id for the object', async () => {
    const local = mkdtempSync(join(tmpdir(), 'sfi-o360-nofields-'));
    const opened = await openGraph(join(local, 'g.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const bareSeed: ExtractionResult = {
      nodes: [node({ id: 'CustomObject:Bare__c', type: 'CustomObject', apiName: 'Bare__c' })],
      edges: [],
    };
    expect((await importExtractionResults(opened.value, [bareSeed])).ok).toBe(true);
    const r = await object360Handler(
      { vaultRoot: local, manifest: MANIFEST, graph: opened.value },
      { objectApiName: 'Bare__c' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const flg = sectionOf(r.value.data, 'permissions')['fieldLevelGrants'] as Record<string, unknown>;
      expect(flg['distinctGranters']).toBe(0);
      expect(String(flg['note'])).toContain('NOTHING WAS CHECKED');
      expect(String(flg['note'])).not.toContain('Both zeros are CHECKED');
    }
    await closeGraph(opened.value);
    rmSync(local, { recursive: true, force: true });
  });
});

describe('object360Handler — QA-2: a refused cap is not re-prescribed', () => {
  /**
   * `maxRowsPerSection: 100` stopped ERRORING on the widest object but never
   * started WORKING: the byte fit refuses it and returns the default response.
   * The note then told the caller to "Raise `maxRowsPerSection` (max 100)" —
   * the knob that had just been refused — sending them round a loop that
   * returns a byte-identical answer.
   */
  const refusedNote = async (): Promise<string> => {
    const r = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return '';
    const scope = r.value.data['appliedScope'] as Record<string, unknown>;
    // the fixture must actually refuse the raise, or this test proves nothing
    expect(scope['maxRowsPerSectionHonoured']).toBe(false);
    return String(r.value.data['truncationNote']);
  };

  it('prescribes `includeSections` and NOT another raise of the refused knob', async () => {
    const note = await refusedNote();
    expect(note).toContain('includeSections');
    expect(note).not.toContain('Raise `maxRowsPerSection`');
    expect(note).toContain('could NOT be honoured');
    // and it says WHY a higher cap cannot help, rather than leaving the caller
    // to discover it by re-sending and getting the same bytes back.
    expect(note).toContain('CANNOT CHANGE THIS RESPONSE');
  });

  it('names a concrete `includeSections` call before any other remedy', async () => {
    const note = await refusedNote();
    expect(note).toContain('"includeSections":[');
    expect(note).toContain('"objectApiName":"Wide__c"');
    expect(note.indexOf('includeSections')).toBeLessThan(note.indexOf('truncatedTotal'));
  });

  it('flags the refusal machine-readably in appliedScope', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Wide__c', maxRowsPerSection: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scope = r.value.data['appliedScope'] as Record<string, unknown>;
    expect(scope['maxRowsPerSectionHonoured']).toBe(false);
    expect(scope['remedy']).toBe('includeSections');
    expect(Number(scope['effectiveMaxRowsPerSection'])).toBeLessThan(100);
    expect(Number(scope['effectiveSampleCap'])).toBeLessThan(25);
  });

  it('keeps the plain raise-or-narrow note when nothing was refused', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Widget__c', maxRowsPerSection: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scope = r.value.data['appliedScope'] as Record<string, unknown>;
    expect(scope['maxRowsPerSectionHonoured']).toBeUndefined();
    expect(String(r.value.data['truncationNote'])).toContain('Raise `maxRowsPerSection`');
  });
});

describe('object360Handler — QA-3/4: resolution courtesies', () => {
  it('resolves an api name that differs only by CASE and echoes what it profiled', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'widget__C' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scope = r.value.data['appliedScope'] as Record<string, unknown>;
    expect(scope['componentId']).toBe('CustomObject:Widget__c');
    expect(scope['object']).toBe('Widget__c');
    expect(scope['resolvedFrom']).toBe('CustomObject:widget__C');
    expect(String(scope['resolutionNote'])).toContain('CASE-INSENSITIVE');
    // and the answer is the SAME object's answer, not a thinner one
    expect(sectionOf(r.value.data, 'owns')['totalComponents']).toBe(10);
  });

  it('does not add a resolution note when the id was already exact', async () => {
    const scope = (await widget())['appliedScope'] as Record<string, unknown>;
    expect(scope['resolvedFrom']).toBeUndefined();
    expect(scope['resolutionNote']).toBeUndefined();
  });

  it('names the closest CustomObject names on a component-not-found', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'Widgt__c' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain('Closest CustomObject names in this vault:');
    expect(r.error.message).toContain('CustomObject:Widget__c');
  });

  it('offers NO suggestion rather than noise when nothing resembles the name', async () => {
    const r = await object360Handler(ctx, { objectApiName: 'zzqqxx' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain('Closest CustomObject names');
  });
});

describe('object360Handler — input contract', () => {
  it('names the missing argument instead of scanning the whole org', async () => {
    const r = await object360Handler(ctx, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('objectApiName');
    expect(r.error.message).toContain('not a report that the org has no objects');
  });

  it('refuses disagreeing object selectors rather than picking a winner', async () => {
    const r = await object360Handler(ctx, {
      objectApiName: 'Widget__c',
      componentId: 'CustomObject:Contact',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('disagree');
  });

  it('rejects a non-CustomObject prefix as invalid-query', async () => {
    const r = await object360Handler(ctx, { componentId: 'Flow:WidgetSave' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});
