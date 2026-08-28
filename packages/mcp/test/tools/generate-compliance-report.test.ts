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
  generateComplianceReportHandler,
  generateComplianceReportInputSchema,
} from '../../src/tools/generate-compliance-report.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 3 },
  edges: { parentOf: 3, grantedBy: 4 },
  sourceTreeHash: 'sha256:compliance-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: 'CustomField:Account.SSN__c',
      type: 'CustomField',
      apiName: 'SSN__c',
      label: 'SSN',
      parentId: 'CustomObject:Account',
      properties: {
        label: 'SSN',
        dataType: 'Text',
        description: 'Social security number',
      },
    }),
    makeNode({
      id: 'CustomField:Account.Email__c',
      type: 'CustomField',
      apiName: 'Email__c',
      label: 'Email',
      parentId: 'CustomObject:Account',
      properties: { label: 'Email', dataType: 'Email' },
    }),
    makeNode({
      id: 'CustomField:Account.Notes__c',
      type: 'CustomField',
      apiName: 'Notes__c',
      label: 'Notes',
      parentId: 'CustomObject:Account',
      properties: { label: 'Notes', dataType: 'LongTextArea' },
    }),
    makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    makeNode({ id: 'Profile:Standard', type: 'Profile', apiName: 'Standard' }),
    makeNode({ id: 'Profile:Marketing', type: 'Profile', apiName: 'Marketing' }),
    makeNode({ id: 'PermissionSet:Bonus', type: 'PermissionSet', apiName: 'Bonus' }),
  ],
  edges: [
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.SSN__c',
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Email__c',
      edgeType: 'parentOf',
    }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Notes__c',
      edgeType: 'parentOf',
    }),
    // SSN__c gets 3 read grants — should trigger risk flags.
    makeEdge({
      fromId: 'Profile:Admin',
      toId: 'CustomField:Account.SSN__c',
      edgeType: 'grantedBy',
      properties: { read: true, edit: true },
    }),
    makeEdge({
      fromId: 'Profile:Standard',
      toId: 'CustomField:Account.SSN__c',
      edgeType: 'grantedBy',
      properties: { read: true },
    }),
    makeEdge({
      fromId: 'Profile:Marketing',
      toId: 'CustomField:Account.SSN__c',
      edgeType: 'grantedBy',
      properties: { read: true },
    }),
    makeEdge({
      fromId: 'PermissionSet:Bonus',
      toId: 'CustomField:Account.Email__c',
      edgeType: 'grantedBy',
      properties: { read: true },
    }),
  ],
};

let tempDir: string;

const makeFreshCtx = async (
  dbName: string,
): Promise<{ ctx: Context; store: GraphStore }> => {
  const opened = await openGraph(join(tempDir, dbName));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const ctx: Context = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
  return { ctx, store };
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-compliance-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('generateComplianceReportHandler (empty graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('empty.db');
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a minimal valid document with zero PII counts', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('Compliance Posture Report');
    expect(doc.body).toContain('Total classified fields: 0');
  });
});

describe('generateComplianceReportHandler (seeded graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a valid frontmatter with title and source-tree hash', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.frontmatter.title).toBe('Compliance Posture Report');
    expect(doc.frontmatter.sourceTreeHash).toBe('sha256:compliance-fixture');
  });

  it('componentIds lists only PII/sensitive fields — not public Notes__c', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.data.document.frontmatter.componentIds;
    expect(ids).toContain('CustomField:Account.SSN__c');
    expect(ids).toContain('CustomField:Account.Email__c');
    expect(ids).not.toContain('CustomField:Account.Notes__c');
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('emits all required H2 sections', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Executive Summary');
    expect(body).toContain('## PII Inventory by Category');
    expect(body).toContain('## Field Access Audit');
    expect(body).toContain('## Sharing Model Exposure');
    expect(body).toContain('## Risk Flags');
    expect(body).toContain('## Object + FLS Exposure');
  });

  it('classifies SSN__c as PII and surfaces it in the inventory', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('SSN');
  });

  it('surfaces the Account sharing model in the Sharing Model Exposure section', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Private');
  });

  it('raises a risk flag for SSN__c with 3 read grants', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    const riskIdx = body.indexOf('## Risk Flags');
    expect(riskIdx).toBeGreaterThan(0);
    const riskSection = body.slice(riskIdx);
    expect(riskSection).toContain('SSN__c');
  });

  it('populates sectionConfidence with PII inventory at heuristic confidence', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conf = result.value.data.document.sectionConfidence;
    expect(conf['PII Inventory by Category']).toBe('heuristic');
    expect(conf['Risk Flags']).toBe('heuristic');
  });

  it('always surfaces the recognizer-heuristic + dynamic-Apex boundary disclosures', async () => {
    const result = await generateComplianceReportHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.document.boundaries;
    const joined = boundaries.join('\n');
    expect(joined).toContain('offline vault');
    expect(joined).toContain('PII classifications inherit');
    expect(joined).toContain('Dynamic Apex');
  });
});

// =============================================================================
// F4 / R2-2 (HIGH): org-wide god-mode (ModifyAllData / ViewAllData) stored on
// Profile/PermissionSet `properties.userPermissions` must be folded into the
// Object + FLS exposure section. A SysAdmin with ModifyAllData + FLS edit on a
// regulated field but NO explicit object-permission edge was MISSED, and the
// section printed the all-clear sentence (security false-negative).
// =============================================================================

const STUDENT = 'CustomObject:Student__c';
const SSN_ENC = 'CustomField:Student__c.Student_SSN__c';
const SYSADMIN = 'Profile:SysAdmin';
const VIEWER = 'Profile:Viewer';
const MAD_NO_FLS = 'Profile:MadNoFls';
const EDGE_PROFILE = 'Profile:EdgeProfile';

const godModeSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: STUDENT,
      type: 'CustomObject',
      apiName: 'Student__c',
      label: 'Student',
      properties: { sharingModel: 'Private' },
    }),
    // EncryptedText → ALWAYS classified pii → regulated.
    makeNode({
      id: SSN_ENC,
      type: 'CustomField',
      apiName: 'Student_SSN__c',
      label: 'Student SSN',
      parentId: STUDENT,
      properties: { label: 'Student SSN', dataType: 'EncryptedText' },
    }),
    // SysAdmin: ModifyAllData god-mode + FLS edit, NO object-permission edge.
    makeNode({
      id: SYSADMIN,
      type: 'Profile',
      apiName: 'SysAdmin',
      label: 'System Administrator',
      properties: { userPermissions: ['ModifyAllData'] },
    }),
    // Viewer: ViewAllData god-mode + FLS read, NO object-permission edge.
    makeNode({
      id: VIEWER,
      type: 'Profile',
      apiName: 'Viewer',
      label: 'Read-Only Viewer',
      properties: { userPermissions: ['ViewAllData'] },
    }),
    // MadNoFls: ModifyAllData but NO FLS grant on the field → must NOT appear.
    makeNode({
      id: MAD_NO_FLS,
      type: 'Profile',
      apiName: 'MadNoFls',
      label: 'Mad No FLS',
      properties: { userPermissions: ['ModifyAllData'] },
    }),
    // EdgeProfile: ordinary object-permission edge path (existing behavior).
    makeNode({
      id: EDGE_PROFILE,
      type: 'Profile',
      apiName: 'EdgeProfile',
      label: 'Edge Profile',
      properties: {},
    }),
  ],
  edges: [
    makeEdge({ fromId: STUDENT, toId: SSN_ENC, edgeType: 'parentOf' }),
    makeEdge({ fromId: SYSADMIN, toId: SSN_ENC, edgeType: 'grantedBy', properties: { readable: true, editable: true } }),
    makeEdge({ fromId: VIEWER, toId: SSN_ENC, edgeType: 'grantedBy', properties: { readable: true, editable: false } }),
    // EdgeProfile: FLS read on the field + object-level read edge on the object.
    makeEdge({ fromId: EDGE_PROFILE, toId: SSN_ENC, edgeType: 'grantedBy', properties: { readable: true, editable: false } }),
    makeEdge({ fromId: EDGE_PROFILE, toId: STUDENT, edgeType: 'grantedBy', properties: { allowRead: true } }),
    // NOTE: MadNoFls has NO grantedBy edge to the field at all (over-report guard).
  ],
};

describe('generateComplianceReportHandler — god-mode in Object+FLS (F4/R2-2)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('godmode.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [godModeSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('lists a ModifyAllData profile with FLS but NO object edge (fails before fix)', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).not.toContain('no profile/perm-set holds both object-level read');
    expect(body).toContain('System Administrator');
    expect(body).toContain('ModifyAllData (system)');
  });

  it('maps ViewAllData to a read-level system label', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('Read-Only Viewer');
    expect(body).toContain('ViewAllData (system)');
  });

  it('does NOT over-report a ModifyAllData profile that lacks FLS on the field', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).not.toContain('Mad No FLS');
  });

  it('still lists the ordinary object-edge exposure path', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('Edge Profile');
  });

  it('discloses the PSG/muting god-mode gap in boundaries', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const boundaries = r.value.data.document.boundaries.join('\n');
    expect(boundaries).toMatch(/Permission Set Group|muting/i);
    expect(boundaries).toMatch(/ModifyAllData|ViewAllData|god-mode/i);
  });
});

// =============================================================================
// R1 (CRITICAL): a FAILED graph read inside the Object + FLS exposure pass must
// NOT be laundered into "no exposure". `findObjectFlsExposures` used to
// `return []` on a failed `listEdges` and `continue` on a failed
// `getNodeById`, so a graph error rendered the all-clear sentence
// ("_(no profile/perm-set holds object-level access ...)_") plus
// "Object+FLS exposure pairs: 0" in the Executive Summary — a CLEAN BILL OF
// HEALTH for a state that was never checked. Every sibling read in the same
// handler (the sharing-model `getNodeById`, the per-field access audit)
// propagates `err({ kind: 'internal' })`; only the pass that decides whether a
// read-only principal can see an EncryptedText identifier failed OPEN.
//
// NOTE ON ISOLATION: all FLS grants below are READ-ONLY (`editable: false`) on
// purpose. `field-access-audit` only issues its own parent-object
// `grantedBy` scan when the field has FLS-EDIT grantors, so with read-only
// grants the ONLY (objectId, 'grantedBy') edge query in the whole handler is
// the one on line 144 — the injected failure cannot be absorbed by an
// upstream tool and pass for the wrong reason.
// =============================================================================

const VENDOR = 'CustomObject:Vendor__c';
const TAX_ID = 'CustomField:Vendor__c.Tax_Id__c';
const EDGE_READER = 'Profile:EdgeReader';
const GOD_READER = 'Profile:GodReader';

const failOpenSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: VENDOR,
      type: 'CustomObject',
      apiName: 'Vendor__c',
      label: 'Vendor',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: TAX_ID,
      type: 'CustomField',
      apiName: 'Tax_Id__c',
      label: 'Tax Id',
      parentId: VENDOR,
      properties: { label: 'Tax Id', dataType: 'EncryptedText' },
    }),
    // Reaches records through an explicit object-permission edge.
    makeNode({
      id: EDGE_READER,
      type: 'Profile',
      apiName: 'EdgeReader',
      label: 'Edge Reader',
      properties: {},
    }),
    // Reaches records through org-wide ViewAllData, no object edge.
    makeNode({
      id: GOD_READER,
      type: 'Profile',
      apiName: 'GodReader',
      label: 'God Reader',
      properties: { userPermissions: ['ViewAllData'] },
    }),
  ],
  edges: [
    makeEdge({ fromId: VENDOR, toId: TAX_ID, edgeType: 'parentOf' }),
    makeEdge({
      fromId: EDGE_READER,
      toId: TAX_ID,
      edgeType: 'grantedBy',
      properties: { readable: true, editable: false },
    }),
    makeEdge({
      fromId: EDGE_READER,
      toId: VENDOR,
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
    makeEdge({
      fromId: GOD_READER,
      toId: TAX_ID,
      edgeType: 'grantedBy',
      properties: { readable: true, editable: false },
    }),
  ],
};

describe('generateComplianceReportHandler — exposure pass must not fail open (R1)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('failopen.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [failOpenSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  /**
   * Wrap the live store so a chosen read throws. `failEdgeScanFor` kills ONLY
   * the `(objectId, 'grantedBy')` edge query; `failNodeReadForAfterEdgeScan`
   * kills node reads for one grantor id but ONLY once that edge query has
   * already run — i.e. exactly the `getNodeById` calls made INSIDE
   * `findObjectFlsExposures`, never the identical read `field-access-audit`
   * performs earlier.
   */
  const withInjectedFailure = (
    real: GraphStore,
    opts: {
      readonly failEdgeScanFor?: string;
      readonly failNodeReadForAfterEdgeScan?: string;
      readonly emptyNodeReadForAfterEdgeScan?: string;
      readonly edgeScanGate?: string;
    },
  ): GraphStore => {
    let edgeScanSeen = false;
    const connection = new Proxy(real.connection, {
      get(target, prop) {
        if (prop === 'runAndReadAll') {
          return async (sql: string, params: readonly unknown[] = []) => {
            const isGrantedByEdgeScan =
              sql.includes('FROM edges') && params.includes('grantedBy');
            if (
              isGrantedByEdgeScan &&
              opts.failEdgeScanFor !== undefined &&
              params.includes(opts.failEdgeScanFor)
            ) {
              throw new Error('injected object-grant scan failure');
            }
            if (
              isGrantedByEdgeScan &&
              opts.edgeScanGate !== undefined &&
              params.includes(opts.edgeScanGate)
            ) {
              edgeScanSeen = true;
            }
            if (
              edgeScanSeen &&
              sql.includes('FROM nodes') &&
              opts.failNodeReadForAfterEdgeScan !== undefined &&
              params.includes(opts.failNodeReadForAfterEdgeScan)
            ) {
              throw new Error('injected grantor node-read failure');
            }
            if (
              edgeScanSeen &&
              sql.includes('FROM nodes') &&
              opts.emptyNodeReadForAfterEdgeScan !== undefined &&
              params.includes(opts.emptyNodeReadForAfterEdgeScan)
            ) {
              // A SUCCESSFUL read that finds no row — the sparse-graph case.
              // Distinct from a throw; the handler must NOT treat it as an error.
              return { getRowObjectsJS: () => [] };
            }
            return await (
              target as never as {
                runAndReadAll: (s: string, p: readonly unknown[]) => Promise<unknown>;
              }
            ).runAndReadAll(sql, params);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return { connection, instance: real.instance } as GraphStore;
  };

  it('BASELINE: with no injected failure both exposure paths are reported', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('Edge Reader');
    expect(body).toContain('God Reader');
    expect(body).toContain('Object+FLS exposure pairs: 2');
  });

  it('propagates a FAILED object-grant edge scan instead of printing the all-clear', async () => {
    const failing = {
      ...ctx,
      graph: withInjectedFailure(store, { failEdgeScanFor: VENDOR }),
    } as Context;
    const r = await generateComplianceReportHandler(failing, {});
    if (r.ok) {
      // Surface the exact false clean-bill-of-health in the failure message.
      const body = r.value.data.document.body;
      const exec = /Object\+FLS exposure pairs: \d+/.exec(body)?.[0] ?? '(missing)';
      const allClear = body.includes('no profile/perm-set holds object-level access');
      expect(
        `ok=true rendered "${exec}" allClearSentence=${String(allClear)}`,
      ).toBe('err({ kind: "internal" }) — an unchecked read is not a clean bill of health');
      return;
    }
    expect(r.error.kind).toBe('internal');
    expect(r.error.message).toContain('graph query failed');
  });

  it('propagates a FAILED grantor node read on the object-edge exposure path', async () => {
    const failing = {
      ...ctx,
      graph: withInjectedFailure(store, {
        edgeScanGate: VENDOR,
        failNodeReadForAfterEdgeScan: EDGE_READER,
      }),
    } as Context;
    const r = await generateComplianceReportHandler(failing, {});
    expect(r.ok).toBe(false);
    if (r.ok) {
      expect(r.value.data.document.body).toContain('Edge Reader');
      return;
    }
    expect(r.error.kind).toBe('internal');
    expect(r.error.message).toContain('graph query failed');
  });

  it('propagates a FAILED grantor node read on the god-mode exposure path', async () => {
    const failing = {
      ...ctx,
      graph: withInjectedFailure(store, {
        edgeScanGate: VENDOR,
        failNodeReadForAfterEdgeScan: GOD_READER,
      }),
    } as Context;
    const r = await generateComplianceReportHandler(failing, {});
    expect(r.ok).toBe(false);
    if (r.ok) {
      expect(r.value.data.document.body).toContain('God Reader');
      return;
    }
    expect(r.error.kind).toBe('internal');
    expect(r.error.message).toContain('graph query failed');
  });

  it('a missing grantor ROW (sparse graph) is still tolerated — NOT an error', async () => {
    // Guard against OVER-correcting the fail-open bug. Absence of a node row is
    // a SUCCESSFUL read that found nothing — the documented sparse-graph case
    // every sibling tool `continue`s past. Only `!ok` (the read itself failed)
    // may propagate. Collapsing the two would turn a tolerable sparse graph
    // into a hard internal error, so this asserts the exact opposite of the
    // two node-read cases above using the exact same injection point.
    const sparse = {
      ...ctx,
      graph: withInjectedFailure(store, {
        edgeScanGate: VENDOR,
        emptyNodeReadForAfterEdgeScan: GOD_READER,
      }),
    } as Context;
    const r = await generateComplianceReportHandler(sparse, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    // The god-mode row is dropped (its node vanished) but the edge path — and
    // the report itself — survive.
    expect(body).toContain('Edge Reader');
    expect(body).not.toContain('God Reader');
    expect(body).toContain('Object+FLS exposure pairs: 1');
  });
});

// =============================================================================
// REAL-ORG (HIGH + MEDIUM): the report answered a question it never scoped, and
// then printed a remedy it could not honour.
//
// (1) SCOPE SWALLOWED. `generateComplianceReportInputSchema` was `z.object({})`
//     — non-strict — so zod STRIPPED every narrowing key a caller passed and
//     the handler signature took `_input`. Asking for one object's compliance
//     posture returned the ORG-WIDE document, unlabelled, with no
//     `appliedScope`, and a name that exists in no vault returned that same
//     confident org-wide answer instead of refusing.
//
// (2) UNREACHABLE REMEDY. With every regulated field rendered into one
//     document, a real org blew the per-document byte budget and the shared
//     fitter dropped EVERY readable section — PII Inventory, Field Access
//     Audit, Sharing Model Exposure, Risk Flags, Object + FLS Exposure — i.e.
//     every section that could carry a finding. What survived was a six-line
//     summary plus a generic note telling the reader to "re-run with a narrower
//     scope (`objectFilter` / `objectApiName`) or pagination" — four knobs the
//     tool did not have. The tool was structurally incapable of emitting a
//     single compliance finding.
//
// The fix makes the analysis actually cover what it claims (a verified object
// scope via the shared `resolveExistingObjectScope`, and a paged inventory via
// the shared `paginate`, so the document always fits and the tail is
// REACHABLE), and makes the remaining certification true (page window named in
// the Executive Summary, a resume pointer in `pageInfo`, boundaries that name
// only knobs that exist).
// =============================================================================

const OBJ_A = 'CustomObject:Obj_A__c';
const OBJ_B = 'CustomObject:Obj_B__c';
const FIELD_A = 'CustomField:Obj_A__c.Secret_A__c';
const FIELD_B = 'CustomField:Obj_B__c.Secret_B__c';

const twoObjectSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: OBJ_A, type: 'CustomObject', apiName: 'Obj_A__c', label: 'Obj A', properties: { sharingModel: 'Private' } }),
    makeNode({ id: OBJ_B, type: 'CustomObject', apiName: 'Obj_B__c', label: 'Obj B', properties: { sharingModel: 'ReadWrite' } }),
    makeNode({
      id: FIELD_A,
      type: 'CustomField',
      apiName: 'Secret_A__c',
      label: 'Secret A',
      parentId: OBJ_A,
      properties: { label: 'Secret A', dataType: 'EncryptedText' },
    }),
    makeNode({
      id: FIELD_B,
      type: 'CustomField',
      apiName: 'Secret_B__c',
      label: 'Secret B',
      parentId: OBJ_B,
      properties: { label: 'Secret B', dataType: 'EncryptedText' },
    }),
  ],
  edges: [
    makeEdge({ fromId: OBJ_A, toId: FIELD_A, edgeType: 'parentOf' }),
    makeEdge({ fromId: OBJ_B, toId: FIELD_B, edgeType: 'parentOf' }),
  ],
};

describe('generateComplianceReportHandler — object scope is honoured, not swallowed', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('scope.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [twoObjectSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('narrows the document to the named object and echoes appliedScope', async () => {
    const r = await generateComplianceReportHandler(ctx, { objectApiName: 'Obj_B__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('Secret_B__c');
    // FAIL-BEFORE: the org-wide document was returned, so the OTHER object's
    // regulated field was in the answer to a question about this one.
    expect(body).not.toContain('Secret_A__c');
    expect(r.value.data.appliedScope?.object).toBe(OBJ_B);
  });

  it('a REAL object typed in the wrong case still scopes (not a confident org-wide answer)', async () => {
    const r = await generateComplianceReportHandler(ctx, { objectApiName: 'obj_b__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope?.object).toBe(OBJ_B);
    expect(r.value.data.document.body).not.toContain('Secret_A__c');
  });

  it('honours the `objectFilter` alias the truncation remedy names', async () => {
    const r = await generateComplianceReportHandler(ctx, { objectFilter: 'Obj_A__c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope?.object).toBe(OBJ_A);
    expect(r.value.data.document.body).not.toContain('Secret_B__c');
  });

  it('REFUSES an object that is not in the vault instead of answering org-wide', async () => {
    const r = await generateComplianceReportHandler(ctx, {
      objectApiName: 'Zz_Not_In_This_Vault__c',
    });
    // FAIL-BEFORE: ok(true) with the full org-wide report, labelled as the
    // answer for an object that does not exist.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('a bare call stays org-wide and omits appliedScope', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toBeUndefined();
    expect(r.value.data.document.body).toContain('Secret_A__c');
    expect(r.value.data.document.body).toContain('Secret_B__c');
  });
});

describe('generateComplianceReportInputSchema — the advertised argument channel', () => {
  it('accepts the object-scope keys a caller is told to pass', () => {
    for (const key of ['objectApiName', 'object', 'objectId', 'objectFilter', 'componentId']) {
      const parsed = generateComplianceReportInputSchema.safeParse({ [key]: 'Obj_A__c' });
      expect(parsed.success).toBe(true);
      // FAIL-BEFORE: `z.object({})` is non-strict, so zod STRIPPED the key and
      // the handler never saw it — the scope vanished with no error.
      if (parsed.success) {
        expect((parsed.data as Record<string, unknown>)[key]).toBe('Obj_A__c');
      }
    }
  });

  it('accepts the paging knobs that make the dropped tail reachable', () => {
    const parsed = generateComplianceReportInputSchema.safeParse({ limit: 10, offset: 5 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)['limit']).toBe(10);
      expect((parsed.data as Record<string, unknown>)['offset']).toBe(5);
    }
  });

  it('REFUSES an unknown key rather than silently swallowing it', () => {
    // A silently ignored argument is worse than a refusal: the caller has no
    // signal that the narrowing they asked for did not apply.
    for (const bad of [{ personaFocus: 'compliance' }, { format: 'html' }]) {
      expect(generateComplianceReportInputSchema.safeParse(bad).success).toBe(false);
    }
  });
});

// A vault whose regulated-field population is large enough that rendering all
// of it into one document blows the per-document byte budget — the real-org
// shape, where the fitter dropped every readable section.
const BIG_OBJ = 'CustomObject:Obj_Big__c';
const BIG_FIELD_COUNT = 320;
const bigSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: BIG_OBJ,
      type: 'CustomObject',
      apiName: 'Obj_Big__c',
      label: 'Obj Big',
      properties: { sharingModel: 'Private' },
    }),
    ...Array.from({ length: BIG_FIELD_COUNT }, (_unused, i) => {
      const n = String(i).padStart(3, '0');
      return makeNode({
        id: `CustomField:Obj_Big__c.Placeholder_Email_Address_${n}__c`,
        type: 'CustomField',
        apiName: `Placeholder_Email_Address_${n}__c`,
        label: `Placeholder Email Address ${n}`,
        parentId: BIG_OBJ,
        properties: {
          label: `Placeholder Email Address ${n}`,
          dataType: 'Email',
          description: `Placeholder contact-email field number ${n}, sized to match a production org's regulated-field population.`,
        },
      });
    }),
  ],
  edges: Array.from({ length: BIG_FIELD_COUNT }, (_unused, i) =>
    makeEdge({
      fromId: BIG_OBJ,
      toId: `CustomField:Obj_Big__c.Placeholder_Email_Address_${String(i).padStart(3, '0')}__c`,
      edgeType: 'parentOf',
    }),
  ),
};

describe('generateComplianceReportHandler — the report must be able to emit a finding', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('big.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [bigSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('renders its readable sections instead of dropping every one of them', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    // FAIL-BEFORE: the whole readable body was a six-line summary plus a
    // generic Truncation Note; every section that could carry a finding was
    // dropped tail-first by the shared fitter.
    expect(body).not.toContain('## Truncation Note');
    expect(body).toContain('## PII Inventory by Category');
    expect(body).toContain('## Field Access Audit');
    expect(body).toContain('## Object + FLS Exposure');
  });

  it('carries a resume pointer, so the tail the note points at is REACHABLE', async () => {
    const first = await generateComplianceReportHandler(ctx, {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const pageInfo = first.value.data.pageInfo;
    expect(pageInfo?.totalCount).toBe(BIG_FIELD_COUNT);
    expect(pageInfo?.hasMore).toBe(true);
    expect(typeof pageInfo?.nextCursor).toBe('string');

    const second = await generateComplianceReportHandler(ctx, {
      cursor: pageInfo?.nextCursor ?? '',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // The second page is a DIFFERENT slice — no dup, no empty page.
    expect(second.value.data.document.body).not.toBe(first.value.data.document.body);
    const firstIds = first.value.data.document.frontmatter.componentIds;
    const secondIds = second.value.data.document.frontmatter.componentIds;
    expect(secondIds.length).toBeGreaterThan(0);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('does not certify a page-bounded zero as an org-wide checked zero', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    // FAIL-BEFORE: "Object+FLS exposure pairs: 0" and "Risk flags raised: N"
    // were computed over the first 25 of 305 regulated fields and printed bare,
    // reading as an org-wide finding.
    expect(body).toMatch(/Object\+FLS exposure pairs: 0 \(/);
    expect(body).toMatch(/Risk flags raised: 0 \(/);
    expect(body).toContain(`of ${String(BIG_FIELD_COUNT)} regulated`);
  });

  it('boundaries name the resume knob that exists, and the regenerate hint is constructible', async () => {
    const r = await generateComplianceReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.document.boundaries.join('\n');
    expect(joined).toContain('cursor');
    expect(r.value.data.document.body).toContain('objectApiName');
  });
});
