/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
  historyTrackingGapsHandler,
  historyTrackingGapsInputSchema,
} from '../../src/tools/history-tracking-gaps.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-11T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 4,
    CustomField: 6,
  },
  edges: { parentOf: 6 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper — mirrors `pii-inventory.test.ts`. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Industry__c',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { dataType: 'Text' },
  ...overrides,
});

// =============================================================================
// Seed data — one object per scenario from the handoff spec:
//   Contact (history ENABLED): an untracked PII field (GAP) + a tracked PII
//     field (not a gap) + a non-PII untracked field (not a gap).
//   Patient__c (history DISABLED): an untracked PII field — a HIGHER-severity
//     object-history-disabled gap.
//   Empty__c (history ENABLED, zero fields): fail-soft, no fabrication.
//   Unmodeled parent (Legacy__c): a PII field whose CustomObject node was
//     NEVER retrieved — objectHistoryEnabled must read null (unknown).
// =============================================================================

const CONTACT_ID = 'CustomObject:Contact';
const PATIENT_ID = 'CustomObject:Patient__c';
const EMPTY_ID = 'CustomObject:Empty__c';

const GAP_SSN = 'CustomField:Contact.SSN__c'; // pii, trackHistory false -> GAP (field-not-tracked)
const TRACKED_EMAIL = 'CustomField:Contact.PersonalEmail__c'; // pii, trackHistory TRUE -> not a gap
const UNTRACKED_PUBLIC = 'CustomField:Contact.Industry__c'; // public, trackHistory false -> not a gap
const GAP_DIAGNOSIS = 'CustomField:Patient__c.Diagnosis__c'; // sensitive, object history DISABLED -> higher-severity GAP
const GAP_UNMODELED = 'CustomField:Legacy__c.SSN__c'; // pii, parent CustomObject never retrieved -> objectHistoryEnabled null

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CONTACT_ID,
      type: 'CustomObject',
      apiName: 'Contact',
      properties: { enableHistory: true },
    }),
    makeNode({
      id: PATIENT_ID,
      type: 'CustomObject',
      apiName: 'Patient__c',
      properties: { enableHistory: false },
    }),
    makeNode({
      id: EMPTY_ID,
      type: 'CustomObject',
      apiName: 'Empty__c',
      properties: { enableHistory: true },
    }),
    makeNode({
      id: GAP_SSN,
      apiName: 'SSN__c',
      parentId: CONTACT_ID,
      properties: { dataType: 'Text', trackHistory: false },
    }),
    makeNode({
      id: TRACKED_EMAIL,
      apiName: 'PersonalEmail__c',
      parentId: CONTACT_ID,
      properties: { dataType: 'Text', trackHistory: true },
    }),
    makeNode({
      id: UNTRACKED_PUBLIC,
      apiName: 'Industry__c',
      parentId: CONTACT_ID,
      properties: { dataType: 'Text', trackHistory: false },
    }),
    makeNode({
      id: GAP_DIAGNOSIS,
      apiName: 'Diagnosis__c',
      parentId: PATIENT_ID,
      properties: { dataType: 'Text', trackHistory: false },
    }),
    // No `CustomField:Legacy__c.*` parent CustomObject node was seeded — the
    // vault never retrieved Legacy__c's own metadata (a partial/scoped refresh).
    makeNode({
      id: GAP_UNMODELED,
      apiName: 'SSN__c',
      parentId: 'CustomObject:Legacy__c',
      properties: { dataType: 'Text', trackHistory: false },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-history-gaps-'));
  const opened = await openGraph(join(tempDir, 'history-gaps.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('historyTrackingGapsHandler', () => {
  it('flags an untracked PII field on a history-enabled object as field-not-tracked/high', async () => {
    const result = await historyTrackingGapsHandler(ctx, { objectApiName: 'Contact' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contactGroup = result.value.data.groups.find((g) => g.objectApiName === 'Contact');
    expect(contactGroup).toBeDefined();
    expect(contactGroup?.objectHistoryEnabled).toBe(true);
    const ssn = contactGroup?.fields.find((f) => f.id === GAP_SSN);
    expect(ssn).toBeDefined();
    expect(ssn?.classification).toBe('pii');
    expect(ssn?.gapKind).toBe('field-not-tracked');
    expect(ssn?.severity).toBe('high');
  });

  it('does NOT flag a PII field whose trackHistory is true', async () => {
    const result = await historyTrackingGapsHandler(ctx, { objectApiName: 'Contact' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.groups.flatMap((g) => g.fields.map((f) => f.id));
    expect(ids).not.toContain(TRACKED_EMAIL);
  });

  it('does NOT flag a non-PII (public) field even when untracked', async () => {
    const result = await historyTrackingGapsHandler(ctx, { objectApiName: 'Contact' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.groups.flatMap((g) => g.fields.map((f) => f.id));
    expect(ids).not.toContain(UNTRACKED_PUBLIC);
  });

  it('flags an untracked sensitive field on a history-DISABLED object as object-history-disabled/critical', async () => {
    const result = await historyTrackingGapsHandler(ctx, { objectApiName: 'Patient__c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patientGroup = result.value.data.groups.find((g) => g.objectApiName === 'Patient__c');
    expect(patientGroup).toBeDefined();
    expect(patientGroup?.objectHistoryEnabled).toBe(false);
    const diag = patientGroup?.fields.find((f) => f.id === GAP_DIAGNOSIS);
    expect(diag).toBeDefined();
    expect(diag?.classification).toBe('sensitive');
    expect(diag?.gapKind).toBe('object-history-disabled');
    expect(diag?.severity).toBe('critical');
    expect(result.value.data.summary.objectsWithHistoryDisabled).toBeGreaterThanOrEqual(1);
  });

  it('reports objectHistoryEnabled: null (never assumed) when the parent CustomObject was never retrieved', async () => {
    const result = await historyTrackingGapsHandler(ctx, { objectApiName: 'Legacy__c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const legacyGroup = result.value.data.groups.find((g) => g.objectApiName === 'Legacy__c');
    expect(legacyGroup).toBeDefined();
    expect(legacyGroup?.objectModeled).toBe(false);
    expect(legacyGroup?.objectHistoryEnabled).toBeNull();
    // Unknown history-enablement must NOT be elevated to the disabled severity.
    const ssn = legacyGroup?.fields.find((f) => f.id === GAP_UNMODELED);
    expect(ssn?.gapKind).toBe('field-not-tracked');
    expect(ssn?.severity).toBe('high');
    expect(result.value.data.trust.completeness.status).toBe('partial');
  });

  it('fails soft (empty groups, no error, no fabrication) on an object with zero fields', async () => {
    const result = await historyTrackingGapsHandler(ctx, { objectApiName: 'Empty__c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.groups).toEqual([]);
    expect(result.value.data.summary.totalGapFields).toBe(0);
    expect(result.value.data.scope).toEqual({
      mode: 'object',
      objectApiName: 'Empty__c',
      objectModeled: true,
      fieldsScanned: 0,
    });
  });

  it('scans org-wide (no objectApiName) and surfaces every object with a gap', async () => {
    const result = await historyTrackingGapsHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const objectNames = result.value.data.groups.map((g) => g.objectApiName).sort();
    expect(objectNames).toEqual(['Contact', 'Legacy__c', 'Patient__c']);
    expect(result.value.data.scope).toEqual({ mode: 'org-wide', fieldsScanned: 5 });
    // 3 gaps total: SSN__c (Contact), Diagnosis__c (Patient__c), SSN__c (Legacy__c).
    expect(result.value.data.summary.totalGapFields).toBe(3);
    expect(result.value.data.summary.byClassification).toEqual({ pii: 2, sensitive: 1 });
    expect(result.value.data.summary.byGapKind).toEqual({
      'object-history-disabled': 1,
      'field-not-tracked': 2,
    });
  });

  it('emits the fixed confidenceAxis and heuristic-confidence trust', async () => {
    const result = await historyTrackingGapsHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.confidenceAxis).toEqual({
      piiClassification: 'heuristic',
      trackHistoryReadout: 'declared',
    });
    expect(result.value.data.trust.confidence).toBe('heuristic');
    expect(result.value.data.trust.provenance).toBe('offline_snapshot');
    expect(result.value.data.trust.limitations.length).toBeGreaterThan(0);
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('groups are sorted by objectApiName ASC and carry a real CustomObject node id', async () => {
    const result = await historyTrackingGapsHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.data.groups.map((g) => g.objectApiName);
    expect(names).toEqual([...names].sort());
    for (const g of result.value.data.groups) {
      expect(g.objectId).toBe(`CustomObject:${g.objectApiName}`);
    }
  });
});

// =============================================================================
// HISTORY-TRACKING-GAPS-UNRESOLVED-OBJECT-SCOPE. Pre-fix, `objectApiName` was
// glued into `CustomObject:{name}` and handed straight to the case-sensitive
// field-scope filter with no existence check — a made-up (or merely
// wrong-case) object name silently matched zero fields and came back
// `{groups: [], summary.totalGapFields: 0}`, an UNCHECKED zero
// indistinguishable from "every PII field on this object is tracked". Fixed
// by resolving + verifying the object first via the shared
// `resolveExistingObjectScope`, falling back to the tool's own pre-existing
// field-parent signal for the Legacy__c-shaped "object referenced by fields
// but never itself retrieved" case (which must NOT start refusing).
// =============================================================================

describe('historyTrackingGapsHandler — object scope honesty', () => {
  it('FAIL-BEFORE/PASS-AFTER: refuses an objectApiName absent from the vault, never a silent zero', async () => {
    const result = await historyTrackingGapsHandler(ctx, {
      objectApiName: 'Zzz_Nonexistent_Object_9x7__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toMatch(/no object named 'Zzz_Nonexistent_Object_9x7__c'/i);
  });

  it('a real object typed in the wrong case still answers, corrected to the vault casing', async () => {
    const lower = await historyTrackingGapsHandler(ctx, { objectApiName: 'contact' });
    const exact = await historyTrackingGapsHandler(ctx, { objectApiName: 'Contact' });
    expect(lower.ok && exact.ok).toBe(true);
    if (!lower.ok || !exact.ok) return;
    expect(lower.value.data.scope).toEqual(exact.value.data.scope);
    expect(lower.value.data.groups).toEqual(exact.value.data.groups);
    expect(lower.value.data.scope).toMatchObject({ mode: 'object', objectApiName: 'Contact' });
  });

  // The Legacy__c shape (a REAL object whose fields were retrieved but whose
  // own CustomObject metadata was not) must keep answering — it is a
  // pre-existing, deliberate honesty feature, not the defect this fix closes.
  // The main describe block above already pins its `objectModeled: false`
  // behavior in detail; this re-confirms it survives the scope-resolution fix.
  it('an object referenced only by its fields (never itself retrieved) still answers, not refused', async () => {
    const result = await historyTrackingGapsHandler(ctx, { objectApiName: 'Legacy__c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.scope).toEqual({
      mode: 'object',
      objectApiName: 'Legacy__c',
      objectModeled: false,
      fieldsScanned: 1,
    });
  });

  it('BARE CALL: the org-wide (no-scope) path is unaffected by the scope fix', async () => {
    const result = await historyTrackingGapsHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.scope).toEqual({ mode: 'org-wide', fieldsScanned: 5 });
  });
});

describe('historyTrackingGapsInputSchema', () => {
  it('accepts an empty input (org-wide default)', () => {
    expect(historyTrackingGapsInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts objectApiName and limit', () => {
    expect(
      historyTrackingGapsInputSchema.safeParse({ objectApiName: 'Contact', limit: 50 }).success,
    ).toBe(true);
  });

  it('normalizes a CustomObject:-prefixed objectApiName to the bare api name', () => {
    const parsed = historyTrackingGapsInputSchema.safeParse({ objectApiName: 'CustomObject:Contact' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.objectApiName).toBe('Contact');
  });

  it('accepts the objectId alias', () => {
    const parsed = historyTrackingGapsInputSchema.safeParse({ objectId: 'Contact' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.objectApiName).toBe('Contact');
  });

  it('rejects a limit above the max', () => {
    expect(historyTrackingGapsInputSchema.safeParse({ limit: 5000 }).success).toBe(false);
  });

  it('rejects a negative offset', () => {
    expect(historyTrackingGapsInputSchema.safeParse({ offset: -1 }).success).toBe(false);
  });
});

// =============================================================================
// Pagination + byte budget — mirrors `pii_inventory`'s B25 suite.
// =============================================================================

/** Mirrors `MAX_RESPONSE_BYTES` (the global dispatch guard in index.ts). */
const GLOBAL_RESPONSE_GUARD_BYTES = 45_000;

const makeBulkyGapField = (i: number): Node =>
  makeNode({
    id: `CustomField:Bulk__c.SSN_${i}__c`,
    apiName: `SSN_${i}__c`,
    parentId: 'CustomObject:Bulk__c',
    // "SSN" name token guarantees a pii classification for every field; the
    // label padding (echoed verbatim into HistoryGapField.label) makes each
    // row ~2 KB so the byte budget — not the row-count limit — is what trips.
    label: `SSN Field ${i} ${'x'.repeat(2000)}`,
    properties: {
      dataType: 'Text',
      trackHistory: false,
    },
  });

describe('historyTrackingGapsHandler — pagination + byte budget', () => {
  const BULK_COUNT = 120;
  let bulkDir: string;
  let bulkStore: GraphStore;
  let bulkCtx: Context;

  beforeAll(async () => {
    bulkDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-history-gaps-bulk-'));
    const opened = await openGraph(join(bulkDir, 'bulk.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    bulkStore = opened.value;
    const bulkSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomObject:Bulk__c',
          type: 'CustomObject',
          apiName: 'Bulk__c',
          properties: { enableHistory: true },
        }),
        ...Array.from({ length: BULK_COUNT }, (_unused, i) => makeBulkyGapField(i)),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(bulkStore, [bulkSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    bulkCtx = { vaultRoot: bulkDir, manifest: FIXTURE_MANIFEST, graph: bulkStore };
  });

  afterAll(async () => {
    await closeGraph(bulkStore);
    rmSync(bulkDir, { recursive: true, force: true });
  });

  it('keeps a default (no-arg) response under the global ~45 KB guard, byte-trimmed with a cursor', async () => {
    const result = await historyTrackingGapsHandler(bulkCtx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bytes = Buffer.byteLength(JSON.stringify(result.value), 'utf8');
    expect(bytes).toBeLessThanOrEqual(GLOBAL_RESPONSE_GUARD_BYTES);
    const { summary, truncated, nextOffset, note } = result.value.data;
    expect(summary.totalGapFields).toBe(BULK_COUNT);
    const fieldCount = result.value.data.groups.flatMap((g) => g.fields).length;
    expect(fieldCount).toBeGreaterThan(0);
    expect(fieldCount).toBeLessThan(BULK_COUNT);
    expect(truncated).toBe(true);
    expect(nextOffset).toBe(fieldCount);
    expect(note).toMatch(/45 KB/);
  });

  it('walks the full gap set via the offset cursor and terminates with no dupes/gaps', async () => {
    const seen = new Set<string>();
    let offset = 0;
    let guard = 0;
    for (;;) {
      const result = await historyTrackingGapsHandler(bulkCtx, { offset });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.value.data;
      for (const g of data.groups) for (const f of g.fields) seen.add(f.id);
      if (!data.truncated) break;
      expect(data.nextOffset).toBeGreaterThan(offset);
      offset = data.nextOffset as number;
      if (++guard > 1000) throw new Error('cursor did not terminate');
    }
    expect(seen.size).toBe(BULK_COUNT);
  });

  it('emits a nextCursor on the byte-trimmed page and walking it covers every gap exactly once', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const result = await historyTrackingGapsHandler(
        bulkCtx,
        cursor === undefined ? {} : { cursor },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.value.data;
      for (const g of data.groups) for (const f of g.fields) seen.add(f.id);
      if (!data.truncated) {
        expect('nextCursor' in data).toBe(false);
        break;
      }
      expect(typeof data.nextCursor).toBe('string');
      cursor = data.nextCursor as string;
      if (++guard > 1000) throw new Error('cursor did not terminate');
    }
    expect(seen.size).toBe(BULK_COUNT);
  });
});

// =============================================================================
// Untrackable-by-type segregation — HISTORY-TRACKING-GAPS-FLAGS-UNTRACKABLE-FORMULAS.
// Salesforce cannot field-history-track formula / roll-up-summary / auto-number /
// synthesized-system fields regardless of the declared flags, so they must NOT be
// emitted as remediation-shaped `field-not-tracked` gaps. They are segregated into
// `untrackable[]` (severity none), excluded from `groups` and `summary.totalGapFields`.
// =============================================================================

const UNTRACK_OBJ = 'CustomObject:Untrackable__c';
const FORMULA_ONLY_OBJ = 'CustomObject:FormulaOnly__c';

const STORED_PII_GAP = 'CustomField:Untrackable__c.SSN_Stored__c'; // stored Text PII, untracked -> ACTIONABLE gap
const FORMULA_PII = 'CustomField:Untrackable__c.SSN_Formula__c'; // isFormula -> untrackable
const ROLLUP_PII = 'CustomField:Untrackable__c.SSN_Rollup__c'; // dataType Summary -> untrackable
const AUTONUM_PII = 'CustomField:Untrackable__c.SSN_AutoNum__c'; // dataType AutoNumber -> untrackable
const SYSTEM_PII = 'CustomField:Untrackable__c.SSN_System__c'; // system: true -> untrackable
const FORMULA_ONLY_PII = 'CustomField:FormulaOnly__c.SSN_Faculty__c'; // object whose ONLY gap is a formula

const untrackableSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: UNTRACK_OBJ,
      type: 'CustomObject',
      apiName: 'Untrackable__c',
      properties: { enableHistory: true },
    }),
    makeNode({
      id: FORMULA_ONLY_OBJ,
      type: 'CustomObject',
      apiName: 'FormulaOnly__c',
      properties: { enableHistory: true },
    }),
    makeNode({
      id: STORED_PII_GAP,
      apiName: 'SSN_Stored__c',
      parentId: UNTRACK_OBJ,
      properties: { dataType: 'Text', trackHistory: false },
    }),
    makeNode({
      id: FORMULA_PII,
      apiName: 'SSN_Formula__c',
      parentId: UNTRACK_OBJ,
      // DX-source stores a formula's RETURN type in <type>, not "Formula";
      // isFormula is the authoritative computed-field signal.
      properties: { dataType: 'Text', trackHistory: false, isFormula: true },
    }),
    makeNode({
      id: ROLLUP_PII,
      apiName: 'SSN_Rollup__c',
      parentId: UNTRACK_OBJ,
      properties: { dataType: 'Summary', trackHistory: false },
    }),
    makeNode({
      id: AUTONUM_PII,
      apiName: 'SSN_AutoNum__c',
      parentId: UNTRACK_OBJ,
      properties: { dataType: 'AutoNumber', trackHistory: false },
    }),
    makeNode({
      id: SYSTEM_PII,
      apiName: 'SSN_System__c',
      parentId: UNTRACK_OBJ,
      properties: { dataType: 'Text', trackHistory: false, system: true },
    }),
    makeNode({
      id: FORMULA_ONLY_PII,
      apiName: 'SSN_Faculty__c',
      parentId: FORMULA_ONLY_OBJ,
      properties: { dataType: 'Text', trackHistory: false, isFormula: true },
    }),
  ],
  edges: [],
};

describe('historyTrackingGapsHandler — untrackable-by-type segregation', () => {
  let dir: string;
  let s: GraphStore;
  let c: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-history-gaps-untrackable-'));
    const opened = await openGraph(join(dir, 'untrackable.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    s = opened.value;
    const imported = await importExtractionResults(s, [untrackableSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    c = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT emit formula / roll-up / auto-number / system PII fields as field-not-tracked gaps', async () => {
    const result = await historyTrackingGapsHandler(c, { objectApiName: 'Untrackable__c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gapIds = result.value.data.groups.flatMap((g) => g.fields.map((f) => f.id));
    expect(gapIds).not.toContain(FORMULA_PII);
    expect(gapIds).not.toContain(ROLLUP_PII);
    expect(gapIds).not.toContain(AUTONUM_PII);
    expect(gapIds).not.toContain(SYSTEM_PII);
    // The stored Text PII field is still a real, fixable gap.
    expect(gapIds).toContain(STORED_PII_GAP);
    expect(result.value.data.summary.totalGapFields).toBe(1);
    expect(result.value.data.summary.byGapKind).toEqual({
      'object-history-disabled': 0,
      'field-not-tracked': 1,
    });
  });

  it('segregates untrackable-by-type fields into untrackable[] with severity none and a reason', async () => {
    const result = await historyTrackingGapsHandler(c, { objectApiName: 'Untrackable__c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.value.data.untrackable.map((u) => [u.id, u]));
    expect(byId.get(FORMULA_PII)?.reason).toBe('formula');
    expect(byId.get(ROLLUP_PII)?.reason).toBe('roll-up-summary');
    expect(byId.get(AUTONUM_PII)?.reason).toBe('auto-number');
    expect(byId.get(SYSTEM_PII)?.reason).toBe('system-field');
    for (const u of result.value.data.untrackable) {
      expect(u.severity).toBe('none');
      expect(u.classification).toBe('pii');
    }
    expect(result.value.data.summary.untrackableFields).toBe(4);
    expect(result.value.data.summary.byUntrackableReason).toEqual({
      formula: 1,
      'roll-up-summary': 1,
      'auto-number': 1,
      'system-field': 1,
    });
    expect(result.value.data.untrackableTruncated).toBe(false);
  });

  it('reports 0 ACTIONABLE gaps for an object whose only gap is an untrackable formula (the Evaluation witness shape)', async () => {
    const result = await historyTrackingGapsHandler(c, { objectApiName: 'FormulaOnly__c' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.groups).toEqual([]);
    expect(result.value.data.summary.totalGapFields).toBe(0);
    expect(result.value.data.summary.untrackableFields).toBe(1);
    expect(result.value.data.untrackable.map((u) => u.id)).toEqual([FORMULA_ONLY_PII]);
    expect(result.value.data.untrackable[0]?.reason).toBe('formula');
  });
});
