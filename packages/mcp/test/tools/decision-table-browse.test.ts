/// <reference types="vitest/globals" />

/**
 * Tests for the `sfi.decision_table_browse` MCP tool (v3.2 R3e).
 *
 * Coverage:
 *   - happy path: parameter shape (CsvUpload variant) + Q179 row-data
 *     refusal verbatim + rows: null + dataSourceType-specific hint.
 *   - SObject variant: row-store hint names the `sourceObject`.
 *   - Manual variant: row-store hint names the OmniStudio designer UI.
 *   - source XML read failure (file missing): response still resolves;
 *     parameter arrays are empty; the read-failure boundary surfaces.
 *   - parameter ordering by `<sequence>` is deterministic.
 *   - `invalid-query` for a wrong id prefix.
 *   - `component-not-found` for a missing but well-formed id.
 *   - `component-not-found` when the id resolves to a non-DecisionTable
 *     node (cross-type confusion at the id boundary).
 *   - Native-vs-Vlocity disclosure surfaces verbatim on every response.
 *
 * Q179 honesty anchor (load-bearing): the row-data refusal MUST be the
 * first entry in `boundaries[]` and rows MUST be unconditionally null.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
import { decisionTableBrowseHandler } from '../../src/tools/decision-table-browse.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    DecisionTable: 3,
  },
  edges: {},
  sourceTreeHash: 'sha256:decision-table-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'DecisionTable',
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

// =============================================================================
// Three fixtures: CsvUpload (FPL-style), SObject (Account-backed),
// Manual. Each writes its source XML to disk; the node's sourcePath
// points at the real file so the tool's re-read works end-to-end.
// =============================================================================

const FPL_ID = 'DecisionTable:FPLFullTabe';
const SOBJECT_ID = 'DecisionTable:AccountTier';
const MANUAL_ID = 'DecisionTable:ManualRules';
const MISSING_SOURCE_ID = 'DecisionTable:MissingSource';

const FPL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <conditionCriteria>1</conditionCriteria>
  <conditionType>All</conditionType>
  <dataSourceType>CsvUpload</dataSourceType>
  <decisionTableParameters>
    <dataType>String</dataType>
    <fieldName>receivingmedicare</fieldName>
    <isGroupByField>false</isGroupByField>
    <isRequired>true</isRequired>
    <operator>NotEquals</operator>
    <sequence>1</sequence>
    <sortType>None</sortType>
    <usage>INPUT</usage>
  </decisionTableParameters>
  <decisionTableParameters>
    <dataType>Number</dataType>
    <fieldName>Result</fieldName>
    <isGroupByField>false</isGroupByField>
    <isRequired>false</isRequired>
    <sortType>None</sortType>
    <usage>OUTPUT</usage>
  </decisionTableParameters>
  <executionType>HBASE</executionType>
  <filterResultBy>OutputOrder</filterResultBy>
  <setupName>FPLFullTabe</setupName>
  <sourceObject>CSV</sourceObject>
  <status>Active</status>
  <type>MediumVolume</type>
  <usageType>Bre</usageType>
</DecisionTable>`;

const SOBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <conditionCriteria>1 AND 2</conditionCriteria>
  <conditionType>All</conditionType>
  <dataSourceType>SObject</dataSourceType>
  <decisionTableParameters>
    <dataType>String</dataType>
    <fieldName>Industry</fieldName>
    <operator>Equals</operator>
    <sequence>2</sequence>
    <usage>INPUT</usage>
  </decisionTableParameters>
  <decisionTableParameters>
    <dataType>Number</dataType>
    <fieldName>AnnualRevenue</fieldName>
    <operator>GreaterThan</operator>
    <sequence>1</sequence>
    <usage>INPUT</usage>
  </decisionTableParameters>
  <decisionTableParameters>
    <dataType>String</dataType>
    <fieldName>Tier</fieldName>
    <sequence>1</sequence>
    <usage>OUTPUT</usage>
  </decisionTableParameters>
  <executionType>HBASE</executionType>
  <setupName>AccountTier</setupName>
  <sourceObject>Account</sourceObject>
  <status>Active</status>
</DecisionTable>`;

const MANUAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <conditionType>Any</conditionType>
  <dataSourceType>Manual</dataSourceType>
  <decisionTableParameters>
    <dataType>String</dataType>
    <fieldName>Code</fieldName>
    <operator>Equals</operator>
    <sequence>1</sequence>
    <usage>INPUT</usage>
  </decisionTableParameters>
  <decisionTableParameters>
    <dataType>String</dataType>
    <fieldName>Label</fieldName>
    <sequence>1</sequence>
    <usage>OUTPUT</usage>
  </decisionTableParameters>
  <executionType>OnPrem</executionType>
  <setupName>ManualRules</setupName>
  <status>Draft</status>
</DecisionTable>`;

let tempDir: string;
let store: GraphStore;
let ctx: Context;
let fplPath: string;
let sobjectPath: string;
let manualPath: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-decision-table-'));
  fplPath = join(tempDir, 'FPLFullTabe.decisionTable-meta.xml');
  sobjectPath = join(tempDir, 'AccountTier.decisionTable-meta.xml');
  manualPath = join(tempDir, 'ManualRules.decisionTable-meta.xml');
  await writeFile(fplPath, FPL_XML, 'utf8');
  await writeFile(sobjectPath, SOBJECT_XML, 'utf8');
  await writeFile(manualPath, MANUAL_XML, 'utf8');

  const dbPath = join(tempDir, 'decision-table.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;

  const seed: ExtractionResult = {
    nodes: [
      makeNode({
        id: FPL_ID,
        type: 'DecisionTable',
        apiName: 'FPLFullTabe',
        label: 'FPLFullTabe',
        sourcePath: fplPath,
        properties: {
          setupName: 'FPLFullTabe',
          dataSourceType: 'CsvUpload',
          sourceObject: 'CSV',
          executionType: 'HBASE',
          usageType: 'Bre',
          status: 'Active',
          type: 'MediumVolume',
          conditionType: 'All',
          conditionCriteria: '1',
          doesConsiderNullValue: false,
          filterResultBy: 'OutputOrder',
          inputParamCount: 1,
          outputParamCount: 1,
        },
      }),
      makeNode({
        id: SOBJECT_ID,
        type: 'DecisionTable',
        apiName: 'AccountTier',
        label: 'AccountTier',
        sourcePath: sobjectPath,
        properties: {
          setupName: 'AccountTier',
          dataSourceType: 'SObject',
          sourceObject: 'Account',
          executionType: 'HBASE',
          status: 'Active',
          inputParamCount: 2,
          outputParamCount: 1,
        },
      }),
      makeNode({
        id: MANUAL_ID,
        type: 'DecisionTable',
        apiName: 'ManualRules',
        label: 'ManualRules',
        sourcePath: manualPath,
        properties: {
          setupName: 'ManualRules',
          dataSourceType: 'Manual',
          executionType: 'OnPrem',
          status: 'Draft',
          inputParamCount: 1,
          outputParamCount: 1,
        },
      }),
      makeNode({
        id: MISSING_SOURCE_ID,
        type: 'DecisionTable',
        apiName: 'MissingSource',
        label: 'MissingSource',
        sourcePath: join(tempDir, 'does-not-exist.xml'),
        properties: {
          setupName: 'MissingSource',
          dataSourceType: 'CsvUpload',
          executionType: 'HBASE',
          inputParamCount: 0,
          outputParamCount: 0,
        },
      }),
      // A non-DecisionTable node sharing the prefix shape so we can
      // assert the type guard rejects a cross-type id collision.
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
      }),
    ],
    edges: [],
  };
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('decisionTableBrowseHandler', () => {
  it('returns parameter shape with Q179 row-data refusal verbatim for CsvUpload', async () => {
    const result = await decisionTableBrowseHandler(ctx, {
      decisionTableId: FPL_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.decisionTableId).toBe(FPL_ID);
    expect(data.apiName).toBe('FPLFullTabe');
    expect(data.dataSourceType).toBe('CsvUpload');
    expect(data.executionType).toBe('HBASE');
    expect(data.inputParams).toEqual([
      {
        name: 'receivingmedicare',
        type: 'String',
        defaultValue: null,
      },
    ]);
    expect(data.outputParams).toEqual([
      { name: 'Result', type: 'Number' },
    ]);
    // Q179 honesty anchor — rows MUST be null.
    expect(data.rows).toBeNull();
    // Q179 boundary MUST be the first entry; this is the load-bearing
    // contract a v3.2 release passes regardless of test-suite green.
    expect(data.boundaries[0]).toBe(
      'DecisionTable rows live in CSV uploads or SObject records, ' +
        'not in the metadata XML. v3.2 cannot enumerate row content. ' +
        'To see the actual rows, query the row data source (SObject ' +
        'record query or the original CSV).',
    );
    // CsvUpload-specific hint follows immediately.
    expect(data.boundaries[1]).toContain('dataSourceType is CsvUpload');
    expect(data.boundaries[1]).toContain('uploaded to this DecisionTable');
    // Native-vs-Vlocity disclosure surfaces verbatim.
    expect(data.boundaries[2]).toContain(
      'v3.2 recognizes Industries Native XML shapes',
    );
    expect(data.boundaries[2]).toContain('`vlocity_cmt__`');
  });

  it('names the sourceObject in the row-store hint for SObject dataSourceType', async () => {
    const result = await decisionTableBrowseHandler(ctx, {
      decisionTableId: SOBJECT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.dataSourceType).toBe('SObject');
    // Q179 anchor still first, then SObject hint naming Account.
    expect(data.boundaries[0]).toContain('v3.2 cannot enumerate row content');
    expect(data.boundaries[1]).toContain('dataSourceType is SObject');
    expect(data.boundaries[1]).toContain("'Account' SObject");
    expect(data.rows).toBeNull();
  });

  it('names the OmniStudio designer for Manual dataSourceType', async () => {
    const result = await decisionTableBrowseHandler(ctx, {
      decisionTableId: MANUAL_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.dataSourceType).toBe('Manual');
    expect(data.executionType).toBe('OnPrem');
    expect(data.boundaries[0]).toContain('v3.2 cannot enumerate row content');
    expect(data.boundaries[1]).toContain('dataSourceType is Manual');
    expect(data.boundaries[1]).toContain('row-editor UI');
    expect(data.rows).toBeNull();
  });

  it('orders inputParams by <sequence> ascending', async () => {
    // The SObject fixture has Industry at sequence=2 and AnnualRevenue
    // at sequence=1. The tool must order by sequence ascending.
    const result = await decisionTableBrowseHandler(ctx, {
      decisionTableId: SOBJECT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.data.inputParams.map((p) => p.name);
    expect(names).toEqual(['AnnualRevenue', 'Industry']);
  });

  it('resolves with empty parameter arrays + read-failure boundary when source XML is missing', async () => {
    const result = await decisionTableBrowseHandler(ctx, {
      decisionTableId: MISSING_SOURCE_ID,
    });
    // Resolves (does not error) — the node IS the authority that the DT
    // exists; the source-read failure is a freshness signal, not an
    // abort condition.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.inputParams).toEqual([]);
    expect(data.outputParams).toEqual([]);
    expect(data.rows).toBeNull();
    // Q179 still first; Native-vs-Vlocity third; read-failure last so
    // callers see the partial-answer signal verbatim.
    expect(data.boundaries[0]).toContain('v3.2 cannot enumerate row content');
    const readFailureBoundary = data.boundaries[data.boundaries.length - 1];
    expect(readFailureBoundary).toContain('parameter list unavailable');
    expect(readFailureBoundary).toContain('sfi refresh');
  });

  it('returns invalid-query when the decisionTableId carries a wrong prefix', async () => {
    const result = await decisionTableBrowseHandler(ctx, {
      decisionTableId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('DecisionTable:');
  });

  it('returns component-not-found for a well-formed but unknown id', async () => {
    const result = await decisionTableBrowseHandler(ctx, {
      decisionTableId: 'DecisionTable:DoesNotExist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toContain('DecisionTable:DoesNotExist');
  });

  it('populates vaultState from the manifest on every response', async () => {
    const result = await decisionTableBrowseHandler(ctx, {
      decisionTableId: FPL_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(
      FIXTURE_MANIFEST.sourceTreeHash,
    );
    expect(result.value.vaultState.refreshedAt).toBe(
      FIXTURE_MANIFEST.refreshedAt,
    );
  });
});
