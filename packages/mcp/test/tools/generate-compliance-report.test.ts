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
