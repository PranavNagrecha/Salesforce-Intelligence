/// <reference types="vitest/globals" />

/**
 * Tests for the `sfi.datatransform_field_map` MCP tool (v3.2 R3c).
 *
 * Coverage:
 *   - happy path: per-row mapping table reflects XML row order, the
 *     metadata block carries the v3.2-R2c extractor fields verbatim,
 *     and both honesty disclosures surface in `boundaries[]`.
 *   - per-row confidence axis: rows whose source/target paths use the
 *     `{ObjectAlias}:{fieldPath}` convention surface as `parsed`; rows
 *     whose paths arrive as flat names surface as `declared`. The two
 *     confidence levels coexist in one response so consumers see the
 *     load-bearing honesty axis.
 *   - operation-type fallback: when `<interfaceClass>` is absent but
 *     `<type>` is present, `metadata.interfaceClass` falls back to the
 *     `<type>` value AND `operationType` pins the raw `<type>` element.
 *     This mirrors the v3.2-R2c extractor's behavior per journal 0167.
 *   - `sourceObject` and `targetObject` surface the top-level source
 *     SObject and the best-effort target (first non-`json`
 *     `outputObjectName`); `targetObject` is null when every row's
 *     output container is `json`.
 *   - `inputSampleJson` / `outputSampleJson` surface verbatim when
 *     `<expectedInputJson>` / `<expectedOutputJson>` are present.
 *   - `invalid-query` for a wrong id prefix (refuse canonically).
 *   - `component-not-found` for a missing but well-formed id.
 *   - `component-not-found` when the id resolves to a non-
 *     OmniDataTransform node (cross-type confusion at the id boundary).
 *   - source-file-missing surfaces as `internal` rather than crashing.
 *   - Native-vs-Vlocity disclosure verbatim on every response.
 *
 * The Native-vs-Vlocity disclosure pin: the verbatim phrase from
 * PLAN-v3.2 §4 honesty axis 1 MUST appear in `boundaries[]` on every
 * response. The per-row-confidence disclosure pin mirrors the
 * `OmniDataTransform.md` §"Field-name path conventions" axis — both
 * pins are load-bearing.
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
import { datatransformFieldMapHandler } from '../../src/tools/datatransform-field-map.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    OmniDataTransform: 3,
  },
  edges: {},
  sourceTreeHash: 'sha256:datatransform-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'OmniDataTransform',
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
// Fixtures: three DataRaptor variants exercising the per-row confidence
// axis, the operation-type fallback, and the missing-source axis.
//
//   1. EXTRACT_ID — Extract variant. Two rows with colon-prefix aliases
//      (`parsed` confidence) + one row with flat-name fields
//      (`declared` confidence). Output is `json` so `targetObject` is
//      null. `<interfaceClass>` absent — `<type>Extract</type>` is the
//      operation-type fallback per journal 0167.
//   2. LOAD_ID — Load variant. All rows have colon-prefix aliases; one
//      row's `<outputObjectName>` names a real SObject (`Account`).
//      `<interfaceClass>Load</interfaceClass>` is present.
//      `<expectedInputJson>` / `<expectedOutputJson>` are populated so
//      the sample-JSON axis is exercised.
//   3. MISSING_SOURCE_ID — Source path is set to a non-existent file
//      so the read-file failure path is exercised.
// =============================================================================

const EXTRACT_ID = 'OmniDataTransform:ExtractContactMapper_1';
const LOAD_ID = 'OmniDataTransform:LoadAccountMapper_1';
const MISSING_SOURCE_ID = 'OmniDataTransform:NoSuchSource_1';
const NON_DT_ID = 'OmniDataTransform:NotADt_1';

const EXTRACT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
  <active>true</active>
  <assignmentRulesUsed>false</assignmentRulesUsed>
  <description>Test fixture exercising the parsed/declared confidence axis.</description>
  <inputType>JSON</inputType>
  <name>ExtractContactMapper</name>
  <nullInputsIncludedInOutput>false</nullInputsIncludedInOutput>
  <omniDataTransformItem>
    <disabled>false</disabled>
    <inputFieldName>ContactInput:Id</inputFieldName>
    <name>MapId</name>
    <outputFieldName>ContactOutput:Id</outputFieldName>
    <outputObjectName>json</outputObjectName>
    <requiredForUpsert>false</requiredForUpsert>
    <upsertKey>false</upsertKey>
  </omniDataTransformItem>
  <omniDataTransformItem>
    <disabled>false</disabled>
    <inputFieldName>ContactInput:Email</inputFieldName>
    <name>MapEmail</name>
    <outputFieldName>ContactOutput:Email</outputFieldName>
    <outputObjectName>json</outputObjectName>
    <requiredForUpsert>false</requiredForUpsert>
    <upsertKey>false</upsertKey>
  </omniDataTransformItem>
  <omniDataTransformItem>
    <disabled>true</disabled>
    <inputFieldName>FlatId</inputFieldName>
    <name>FlatMap</name>
    <outputFieldName>FlatOut</outputFieldName>
    <outputObjectName>json</outputObjectName>
    <requiredForUpsert>false</requiredForUpsert>
    <upsertKey>false</upsertKey>
  </omniDataTransformItem>
  <omniDataTransformItem>
    <disabled>false</disabled>
    <name>FormulaSerial</name>
    <outputFieldName>Formula</outputFieldName>
    <outputObjectName>Formula</outputObjectName>
    <formulaResultPath>LoopBlock1:SerialList:PBC</formulaResultPath>
    <formulaSequence>1.0</formulaSequence>
    <requiredForUpsert>false</requiredForUpsert>
    <upsertKey>false</upsertKey>
  </omniDataTransformItem>
  <sourceObject>Contact</sourceObject>
  <type>Extract</type>
  <uniqueName>ExtractContactMapper_1</uniqueName>
  <versionNumber>1.0</versionNumber>
</OmniDataTransform>`;

const LOAD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
  <active>true</active>
  <assignmentRulesUsed>true</assignmentRulesUsed>
  <description>Load mapper with sample JSON payloads.</description>
  <expectedInputJson>{"AccountIn":{"Name":"Acme"}}</expectedInputJson>
  <expectedOutputJson>{"AccountOut":{"Id":"001..."}}</expectedOutputJson>
  <inputType>JSON</inputType>
  <interfaceClass>Load</interfaceClass>
  <name>LoadAccountMapper</name>
  <nullInputsIncludedInOutput>true</nullInputsIncludedInOutput>
  <omniDataTransformItem>
    <disabled>false</disabled>
    <inputFieldName>AccountIn:Name</inputFieldName>
    <name>MapName</name>
    <outputFieldName>AccountOut:Name</outputFieldName>
    <outputObjectName>Account</outputObjectName>
    <requiredForUpsert>true</requiredForUpsert>
    <upsertKey>true</upsertKey>
  </omniDataTransformItem>
  <omniDataTransformItem>
    <disabled>false</disabled>
    <inputFieldName>AccountIn:Industry</inputFieldName>
    <name>MapIndustry</name>
    <outputFieldName>AccountOut:Industry</outputFieldName>
    <outputObjectName>Account</outputObjectName>
    <requiredForUpsert>false</requiredForUpsert>
    <upsertKey>false</upsertKey>
  </omniDataTransformItem>
  <type>Load</type>
  <uniqueName>LoadAccountMapper_1</uniqueName>
  <versionNumber>1.0</versionNumber>
</OmniDataTransform>`;

let tempDir: string;
let store: GraphStore;
let ctx: Context;
let extractPath: string;
let loadPath: string;
let nonDtPath: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-datatransform-'));
  extractPath = join(tempDir, 'ExtractContactMapper_1.rpt-meta.xml');
  loadPath = join(tempDir, 'LoadAccountMapper_1.rpt-meta.xml');
  // Used for the cross-type confusion test; the file does not need to
  // be valid OmniDataTransform XML because the handler rejects on type
  // before re-reading.
  nonDtPath = join(tempDir, 'not-a-datatransform.xml');
  await writeFile(extractPath, EXTRACT_XML, 'utf8');
  await writeFile(loadPath, LOAD_XML, 'utf8');
  await writeFile(nonDtPath, '<xml/>', 'utf8');

  const dbPath = join(tempDir, 'datatransform.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;

  const seed: ExtractionResult = {
    nodes: [
      makeNode({
        id: EXTRACT_ID,
        type: 'OmniDataTransform',
        apiName: 'ExtractContactMapper_1',
        label: 'Test fixture exercising the parsed/declared confidence axis.',
        sourcePath: extractPath,
        properties: {
          name: 'ExtractContactMapper',
          uniqueName: 'ExtractContactMapper_1',
          inputType: 'JSON',
          interfaceClass: 'Extract',
          operationType: 'Extract',
          active: true,
          sourceObject: 'Contact',
        },
      }),
      makeNode({
        id: LOAD_ID,
        type: 'OmniDataTransform',
        apiName: 'LoadAccountMapper_1',
        label: 'Load mapper with sample JSON payloads.',
        sourcePath: loadPath,
        properties: {
          name: 'LoadAccountMapper',
          uniqueName: 'LoadAccountMapper_1',
          inputType: 'JSON',
          interfaceClass: 'Load',
          operationType: 'Load',
          active: true,
        },
      }),
      makeNode({
        id: MISSING_SOURCE_ID,
        type: 'OmniDataTransform',
        apiName: 'NoSuchSource_1',
        sourcePath: join(tempDir, 'no-such-file.rpt-meta.xml'),
        properties: { name: 'NoSuchSource' },
      }),
      // A non-OmniDataTransform node sharing the prefix-look. Used for
      // the cross-type confusion test — the handler must reject on
      // `node.type !== 'OmniDataTransform'`.
      makeNode({
        id: NON_DT_ID,
        type: 'CustomObject',
        apiName: 'NotADt_1',
        sourcePath: nonDtPath,
        properties: {},
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

describe('datatransformFieldMapHandler', () => {
  it('returns the per-row mapping table in XML document order for the Extract fixture', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: EXTRACT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.dataTransformId).toBe(EXTRACT_ID);
    expect(data.apiName).toBe('ExtractContactMapper_1');
    expect(data.mappings).toHaveLength(4);
    // Row order matches the XML — designer-controlled, not normalized.
    expect(data.mappings.map((m) => m.name)).toEqual([
      'MapId',
      'MapEmail',
      'FlatMap',
      'FormulaSerial',
    ]);
    // sourceField / targetField are surfaced verbatim including the
    // colon-prefix alias convention; downstream tools can split on `:`.
    expect(data.mappings[0]?.sourceField).toBe('ContactInput:Id');
    expect(data.mappings[0]?.targetField).toBe('ContactOutput:Id');
  });

  it('uses the real formulaResultPath as targetField for formula rows, not the literal "Formula" placeholder', async () => {
    // Formula rows carry `<outputFieldName>Formula</outputFieldName>` as a
    // placeholder; the real computed-output location is in
    // `<formulaResultPath>`. Surfacing the placeholder collapses every
    // distinct formula output into an identical, useless `targetField:
    // 'Formula'` row (observed on a real org's DataRaptors).
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: EXTRACT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mappings = result.value.data.mappings;
    const formulaRow = mappings.find((m) => m.name === 'FormulaSerial');
    expect(formulaRow).toBeDefined();
    expect(formulaRow?.targetField).toBe('LoopBlock1:SerialList:PBC');
    // Formula rows have no input field.
    expect(formulaRow?.sourceField).toBe('');
    // The useless literal "Formula" must never surface as a target.
    expect(mappings.some((m) => m.targetField === 'Formula')).toBe(false);
  });

  it('classifies per-row confidence based on the colon-prefix alias convention', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: EXTRACT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mappings = result.value.data.mappings;
    // Rows 1 + 2 use `ContactInput:` / `ContactOutput:` colon-prefix
    // aliases — `parsed` per the v3.2-R2c edge confidence axis.
    expect(mappings[0]?.confidence).toBe('parsed');
    expect(mappings[1]?.confidence).toBe('parsed');
    // Row 3 uses flat names (`FlatId` / `FlatOut`) — `declared`
    // because there is no designer-controlled alias to infer.
    expect(mappings[2]?.confidence).toBe('declared');
  });

  it('surfaces both honesty disclosures verbatim on every response', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: EXTRACT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.boundaries;
    // The Native-vs-Vlocity disclosure (PLAN-v3.2 §4 honesty axis 1).
    expect(
      boundaries.some((b) =>
        b.includes(
          'v3.2 recognizes Industries Native XML shapes',
        ),
      ),
    ).toBe(true);
    expect(
      boundaries.some((b) =>
        b.includes('Vlocity-managed-package'),
      ),
    ).toBe(true);
    // The per-row confidence disclosure (load-bearing for this tool).
    expect(
      boundaries.some((b) =>
        b.includes('Per-mapping confidence'),
      ),
    ).toBe(true);
    expect(
      boundaries.some((b) => b.includes('colon-prefix alias')),
    ).toBe(true);
  });

  it('falls back to the <type> element for the operation-type discriminant when <interfaceClass> is absent', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: EXTRACT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    // EXTRACT_XML has no <interfaceClass>; <type>Extract</type> is the
    // fallback. The extractor's behavior (journal 0167) — surface both.
    expect(data.metadata.interfaceClass).toBe('Extract');
    expect(data.operationType).toBe('Extract');
  });

  it('surfaces sourceObject and a null targetObject for an Extract-to-json variant', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: EXTRACT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.sourceObject).toBe('Contact');
    // Every row's outputObjectName is `json` — no SObject target.
    expect(result.value.data.targetObject).toBeNull();
  });

  it('returns the first non-json outputObjectName as targetObject for a Load variant', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: LOAD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.targetObject).toBe('Account');
    // LOAD_XML has no <sourceObject> element — null surfaces honestly.
    expect(data.sourceObject).toBeNull();
    // <interfaceClass> present in the XML so it wins; <type> still
    // pinned separately.
    expect(data.metadata.interfaceClass).toBe('Load');
    expect(data.operationType).toBe('Load');
  });

  it('surfaces upsertKey, requiredForUpsert, and disabled per-row verbatim', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: LOAD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mappings = result.value.data.mappings;
    expect(mappings[0]?.upsertKey).toBe(true);
    expect(mappings[0]?.requiredForUpsert).toBe(true);
    expect(mappings[0]?.disabled).toBe(false);
    expect(mappings[1]?.upsertKey).toBe(false);
    expect(mappings[1]?.requiredForUpsert).toBe(false);
  });

  it('surfaces expectedInputJson and expectedOutputJson verbatim when present', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: LOAD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.inputSampleJson).toBe('{"AccountIn":{"Name":"Acme"}}');
    expect(data.outputSampleJson).toBe('{"AccountOut":{"Id":"001..."}}');
  });

  it('returns null sample-JSON when the source XML does not carry expectedInputJson / expectedOutputJson', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: EXTRACT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.inputSampleJson).toBeNull();
    expect(result.value.data.outputSampleJson).toBeNull();
  });

  it('refuses with invalid-query when the prefix is not OmniDataTransform:', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('dataTransformId');
  });

  it('refuses with component-not-found when the id is well-formed but unknown to the vault', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: 'OmniDataTransform:NoSuchTransform_99',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('refuses with component-not-found when the id resolves to a non-OmniDataTransform node', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: NON_DT_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toContain('not an OmniDataTransform');
  });

  it('returns an internal error when the source XML file is missing on disk', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: MISSING_SOURCE_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    expect(result.error.message).toContain('OmniDataTransform source');
  });

  it('echoes the vaultState envelope from the manifest', async () => {
    const result = await datatransformFieldMapHandler(ctx, {
      dataTransformId: EXTRACT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:datatransform-fixture',
    );
    expect(result.value.vaultState.refreshedAt).toBe(
      '2026-05-28T14:33:08Z',
    );
  });
});
