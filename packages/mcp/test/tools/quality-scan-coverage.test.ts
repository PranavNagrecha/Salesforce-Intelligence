/// <reference types="vitest/globals" />

/**
 * QUALITY-SCAN-SKIPS-TRIGGERS-AND-FLOWS.
 *
 * `sfi.crud_fls_audit` and `sfi.code_quality_audit` compose over the
 * `properties.qualityIssues[]` mirror and advertised walking "every ApexClass /
 * ApexTrigger". Measured on a real vault: **ApexClass 192/192, ApexTrigger 0 of
 * 22, Flow 0 of 275** — and a CRUD/FLS audit scoped to a trigger with four
 * unguarded SOQL queries and an unguarded `update` returned
 * `{ classes: [], totalFindingCount: 0, boundaries: [] }`.
 *
 * Two absences that must never be reported the same way, and this file pins the
 * difference:
 *
 *  - A vault built before the trigger extractor scanned triggers holds nodes
 *    with NO `qualityIssues` key. That is "not checked" and a `sfi refresh`
 *    closes it.
 *  - `Flow` is not Apex. No refresh on any org can ever make an Apex recognizer
 *    fire on a Flow, so it is named permanently in `notCheckedTypes` and is no
 *    longer scanned as if it might contribute.
 *
 * And the third state, the one that must stay quiet: a node that WAS scanned
 * and is clean carries an empty array, emits nothing, and its response is
 * byte-identical to before any of this existed.
 */

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
  type GraphStore,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { codeQualityAuditHandler } from '../../src/tools/code-quality-audit.js';
import { crudFlsAuditHandler } from '../../src/tools/crud-fls-audit.js';
import {
  buildNotCheckedTypesNote,
  buildUnscannedNodesNote,
  censusQualityScanCoverage,
  NOT_APEX_TYPES,
} from '../../src/tools/quality-scan-coverage.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 1, ApexTrigger: 2 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: 62,
  properties: {},
  ...overrides,
});

const CRUD_FINDING = {
  rule: 'missing-crud-check',
  severity: 'high',
  location: 'line 7',
  explanation: 'DML executes without a preceding object-level CRUD check.',
};

/**
 * `qualityIssues: undefined` OMITS the key — the shape a vault built before the
 * type was scanned holds, and the shape that must never read as clean.
 */
const apexNode = (
  id: string,
  type: 'ApexClass' | 'ApexTrigger',
  qualityIssues: unknown[] | undefined,
): Node =>
  makeNode({
    id,
    type,
    apiName: id.slice(id.indexOf(':') + 1),
    properties: {
      status: 'Active',
      ...(qualityIssues === undefined ? {} : { qualityIssues }),
    },
  });

const seed: ExtractionResult = {
  nodes: [
    // Scanned and dirty.
    apexNode('ApexClass:ScannedDirty', 'ApexClass', [CRUD_FINDING]),
    // Scanned and genuinely clean — the empty array is the whole point.
    apexNode('ApexTrigger:ScannedClean', 'ApexTrigger', []),
    // Never scanned: this vault predates the trigger extractor change.
    apexNode('ApexTrigger:NeverScanned', 'ApexTrigger', undefined),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-quality-coverage-'));
  const opened = await openGraph(join(tempDir, 'graph.db'));
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

describe('censusQualityScanCoverage', () => {
  it('counts the KEY, not the findings — an empty array IS a scan', () => {
    expect(censusQualityScanCoverage(seed.nodes)).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 1 },
      { type: 'ApexTrigger', nodes: 2, scanned: 1 },
    ]);
  });

  it('emits no note when every node was scanned', () => {
    const allScanned = [
      apexNode('ApexClass:A', 'ApexClass', []),
      apexNode('ApexTrigger:B', 'ApexTrigger', [CRUD_FINDING]),
    ];
    expect(
      buildUnscannedNodesNote(censusQualityScanCoverage(allScanned)),
    ).toBeUndefined();
  });

  it('names the gap and the fix when a node was never scanned', () => {
    const note = buildUnscannedNodesNote(censusQualityScanCoverage(seed.nodes));
    expect(note).toContain('1 of 2 ApexTrigger');
    expect(note).toContain('not checked');
    expect(note).toContain('sfi refresh');
    // It must never name the fully-scanned type as a gap.
    expect(note).not.toContain('ApexClass');
  });
});

describe('the two absences are different answers', () => {
  it('Flow is named as structurally out of reach, not as a refresh gap', () => {
    const note = buildNotCheckedTypesNote(NOT_APEX_TYPES) ?? '';
    expect(NOT_APEX_TYPES.map((t) => t.type)).toEqual(['Flow']);
    // The load-bearing distinction: no refresh closes this one.
    expect(note).toContain('on any vault after any refresh');
    expect(note).not.toContain('sfi refresh');
    // And it points at the tools that DO answer the flow-quality question.
    expect(note).toContain('sfi.flow_bulkification_audit');
  });
});

describe('crud_fls_audit — a trigger this vault never scanned', () => {
  it('FAIL-BEFORE/PASS-AFTER: says NOT CHECKED instead of returning a bare zero', async () => {
    const result = await crudFlsAuditHandler(ctx, {
      componentId: 'ApexTrigger:NeverScanned',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The finding count is still zero — the tool cannot invent findings from a
    // property that is not there. What changed is that the zero is explained.
    expect(result.value.data.totalFindingCount).toBe(0);
    expect(result.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexTrigger', nodes: 1, scanned: 0 },
    ]);
    expect(result.value.data.boundaries.join(' ')).toContain('NOT SCANNED IN THIS VAULT');
  });

  it('stays SILENT for a trigger that was scanned and is clean', async () => {
    // The byte-identity guarantee for a healthy vault: a clean scan emits
    // neither the coverage block nor the boundary.
    const result = await crudFlsAuditHandler(ctx, {
      componentId: 'ApexTrigger:ScannedClean',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.totalFindingCount).toBe(0);
    expect(result.value.data.qualityScanCoverage).toBeUndefined();
    expect(result.value.data.boundaries).toEqual([]);
  });

  it('names the unscanned nodes on the ORG-WIDE path too', async () => {
    const result = await crudFlsAuditHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coverage = result.value.data.qualityScanCoverage ?? [];
    expect(coverage).toContainEqual({ type: 'ApexTrigger', nodes: 2, scanned: 1 });
    expect(coverage).toContainEqual({ type: 'ApexClass', nodes: 1, scanned: 1 });
    expect(result.value.data.boundaries.join(' ')).toContain('1 of 2 ApexTrigger');
  });
});

describe('code_quality_audit — what it does not cover', () => {
  it('names Flow in notCheckedTypes on the org-wide path', async () => {
    const result = await codeQualityAuditHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.notCheckedTypes?.map((t) => t.type)).toEqual(['Flow']);
    expect(result.value.data.boundaries.join(' ')).toContain('NOT CHECKED BY DESIGN');
    expect(result.value.data.boundaries.join(' ')).toContain('NOT SCANNED IN THIS VAULT');
  });

  it('reports the per-type scan census on the org-wide path', async () => {
    const result = await codeQualityAuditHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.qualityScanCoverage).toContainEqual({
      type: 'ApexTrigger',
      nodes: 2,
      scanned: 1,
    });
  });

  it('omits BOTH on a class-scoped call — the caller did not ask about Flows', async () => {
    const result = await codeQualityAuditHandler(ctx, {
      componentId: 'ApexClass:ScannedDirty',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.notCheckedTypes).toBeUndefined();
    expect(result.value.data.qualityScanCoverage).toBeUndefined();
    // A scoped call on a SCANNED node emits no unscanned boundary either.
    expect(result.value.data.boundaries.join(' ')).not.toContain(
      'NOT SCANNED IN THIS VAULT',
    );
  });

  it('still explains a scoped call on a node this vault never scanned', async () => {
    const result = await codeQualityAuditHandler(ctx, {
      componentId: 'ApexTrigger:NeverScanned',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.totalCount).toBe(0);
    expect(result.value.data.boundaries.join(' ')).toContain('NOT SCANNED IN THIS VAULT');
  });
});
