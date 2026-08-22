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
  lookupRecordHandler,
  lookupRecordInputSchema,
} from '../../src/tools/lookup-record.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    CustomMetadataRecord: 3,
    CustomSettingRecord: 1,
  },
  edges: { parentOf: 4 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/properties. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Marketo_Api_Setting__mdt',
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
// Seed 1: A CustomMetadataRecord with the full v1.6 R2 shape — label,
// protected flag, parent type, valuesCount, values array. Mirrors the
// synthetic-v1.6 `Marketo_Api_Setting__mdt.Default` fixture.
// =============================================================================

const MARKETO_TYPE_ID = 'CustomObject:Marketo_Api_Setting__mdt';
const MARKETO_DEFAULT_ID =
  'CustomMetadataRecord:Marketo_Api_Setting__mdt.Default';

const marketoDefaultSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: MARKETO_TYPE_ID,
      type: 'CustomObject',
      apiName: 'Marketo_Api_Setting__mdt',
      label: 'Marketo Api Setting',
      properties: {},
    }),
    makeNode({
      id: MARKETO_DEFAULT_ID,
      type: 'CustomMetadataRecord',
      apiName: 'Marketo_Api_Setting__mdt.Default',
      label: 'Default Settings',
      parentId: MARKETO_TYPE_ID,
      properties: {
        label: 'Default Settings',
        protected: false,
        recordName: 'Default',
        typeApiName: 'Marketo_Api_Setting__mdt',
        valuesCount: 3,
        values: [
          {
            field: 'Number_Of_Retries__c',
            value: 3,
            valueType: 'number',
            isMasked: false,
          },
          {
            field: 'Notifications_On__c',
            value: 'Both',
            valueType: 'string',
            isMasked: false,
          },
          {
            field: 'Who_Should_be_notified__c',
            value: 'admin@example.com',
            valueType: 'string',
            isMasked: false,
          },
        ],
        hasMaskedValues: false,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 2: A CustomMetadataRecord whose values include a masked value (the
// managed-package `***` literal collapsed to `{ value: null, isMasked: true }`).
// Mirrors the synthetic-v1.6 `Clinical_Instruction__mdt.Module_2` fixture.
// =============================================================================

const CLINICAL_TYPE_ID = 'CustomObject:Clinical_Instruction__mdt';
const CLINICAL_MODULE_2_ID =
  'CustomMetadataRecord:Clinical_Instruction__mdt.Module_2';

const clinicalModule2Seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CLINICAL_TYPE_ID,
      type: 'CustomObject',
      apiName: 'Clinical_Instruction__mdt',
      label: 'Clinical Instruction',
      properties: {},
    }),
    makeNode({
      id: CLINICAL_MODULE_2_ID,
      type: 'CustomMetadataRecord',
      apiName: 'Clinical_Instruction__mdt.Module_2',
      label: 'Module 2 Schedule',
      parentId: CLINICAL_TYPE_ID,
      properties: {
        label: 'Module 2 Schedule',
        protected: true,
        recordName: 'Module_2',
        typeApiName: 'Clinical_Instruction__mdt',
        valuesCount: 3,
        values: [
          // The masked entry — `value: null, isMasked: true` is the v1.6
          // honesty-axis shape for the managed-package `***` literal.
          {
            field: 'Weekend__c',
            value: null,
            valueType: 'string',
            isMasked: true,
          },
          {
            field: 'Weekend_Begins__c',
            value: 12,
            valueType: 'number',
            isMasked: false,
          },
          {
            field: 'Weekend_Ends__c',
            value: 14,
            valueType: 'number',
            isMasked: false,
          },
        ],
        hasMaskedValues: true,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 3: An empty-values CustomMetadataRecord. Used to verify the empty
// list path returns an empty `values` array without erroring.
// =============================================================================

const EMPTY_TYPE_ID = 'CustomObject:Empty_Type__mdt';
const EMPTY_RECORD_ID = 'CustomMetadataRecord:Empty_Type__mdt.Bare';

const emptyValuesSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: EMPTY_TYPE_ID,
      type: 'CustomObject',
      apiName: 'Empty_Type__mdt',
      properties: {},
    }),
    makeNode({
      id: EMPTY_RECORD_ID,
      type: 'CustomMetadataRecord',
      apiName: 'Empty_Type__mdt.Bare',
      label: 'Bare Record',
      parentId: EMPTY_TYPE_ID,
      properties: {
        label: 'Bare Record',
        protected: false,
        recordName: 'Bare',
        typeApiName: 'Empty_Type__mdt',
        valuesCount: 0,
        values: [],
        hasMaskedValues: false,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 4: A CustomSettingRecord — the second of the two record-typed nodes
// the tool accepts. Mirrors the synthetic-v1.6
// `Marketo_Api_Settings__c.SystemDefault` shape.
// =============================================================================

const SETTING_TYPE_ID = 'CustomObject:Marketo_Api_Settings__c';
const SETTING_RECORD_ID =
  'CustomSettingRecord:Marketo_Api_Settings__c.SystemDefault';

const customSettingSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: SETTING_TYPE_ID,
      type: 'CustomObject',
      apiName: 'Marketo_Api_Settings__c',
      label: 'Marketo Api Settings',
      properties: {},
    }),
    makeNode({
      id: SETTING_RECORD_ID,
      type: 'CustomSettingRecord',
      apiName: 'Marketo_Api_Settings__c.SystemDefault',
      label: 'SystemDefault',
      parentId: SETTING_TYPE_ID,
      properties: {
        label: 'SystemDefault',
        protected: false,
        recordName: 'SystemDefault',
        typeApiName: 'Marketo_Api_Settings__c',
        valuesCount: 2,
        values: [
          {
            field: 'Endpoint__c',
            value: 'https://marketo.example.com',
            valueType: 'string',
            isMasked: false,
          },
          {
            field: 'Active__c',
            value: true,
            valueType: 'boolean',
            isMasked: false,
          },
        ],
        hasMaskedValues: false,
      },
    }),
  ],
  edges: [],
};

// One shared graph store + Context across the suite. All seeds use distinct
// ids so there is no cross-test interference.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-lookup-record-'));
  const dbPath = join(tempDir, 'lookup-record.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    marketoDefaultSeed,
    clinicalModule2Seed,
    emptyValuesSeed,
    customSettingSeed,
  ]);
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

describe('lookupRecordHandler', () => {
  it('returns the full record shape for a happy-path CustomMetadataRecord', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: MARKETO_DEFAULT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { recordId, type, typeApiName, label, protected: isProtected, values } =
      result.value.data;
    expect(recordId).toBe(MARKETO_DEFAULT_ID);
    expect(type).toBe('CustomMetadataRecord');
    expect(typeApiName).toBe('Marketo_Api_Setting__mdt');
    expect(label).toBe('Default Settings');
    expect(isProtected).toBe(false);
    expect(values.length).toBe(3);
    // First value carries through with its full per-field shape.
    expect(values[0]).toEqual({
      field: 'Number_Of_Retries__c',
      value: 3,
      valueType: 'number',
      isMasked: false,
    });
    // None of the happy-path values are masked.
    expect(values.every((v) => v.isMasked === false)).toBe(true);
    // vaultState carries the manifest hash and timestamp.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('passes through masked values verbatim without fabricating the underlying value', async () => {
    // The honesty-axis test: Module_2's Weekend__c value was the
    // managed-package literal `***`, which the extractor collapsed to
    // `{ value: null, isMasked: true }`. The handler MUST surface that
    // shape verbatim.
    const result = await lookupRecordHandler(ctx, {
      recordId: CLINICAL_MODULE_2_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { protected: isProtected, values } = result.value.data;
    expect(isProtected).toBe(true);
    // The masked entry comes through as null + isMasked=true; the other
    // two carry their typed values normally.
    const weekend = values.find((v) => v.field === 'Weekend__c');
    expect(weekend?.value).toBeNull();
    expect(weekend?.isMasked).toBe(true);
    expect(weekend?.valueType).toBe('string');
    const begins = values.find((v) => v.field === 'Weekend_Begins__c');
    expect(begins?.value).toBe(12);
    expect(begins?.isMasked).toBe(false);
  });

  it('returns an empty values array when the record has no fields', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: EMPTY_RECORD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { values, label, protected: isProtected } = result.value.data;
    expect(values).toEqual([]);
    expect(label).toBe('Bare Record');
    expect(isProtected).toBe(false);
  });

  it('returns the full shape for a CustomSettingRecord', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: SETTING_RECORD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { recordId, type, typeApiName, label, values } = result.value.data;
    expect(recordId).toBe(SETTING_RECORD_ID);
    expect(type).toBe('CustomSettingRecord');
    // Suffix is `__c` for CustomSettingRecord — the suffix is preserved
    // verbatim per the v1.6 R2 extractor contract.
    expect(typeApiName).toBe('Marketo_Api_Settings__c');
    expect(label).toBe('SystemDefault');
    expect(values.length).toBe(2);
    // Verify the boolean value type round-trips correctly.
    const active = values.find((v) => v.field === 'Active__c');
    expect(active?.value).toBe(true);
    expect(active?.valueType).toBe('boolean');
  });

  it('returns component-not-found for an unknown record id with a valid prefix', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: 'CustomMetadataRecord:Does_Not_Exist__mdt.Nope',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe(
      'CustomMetadataRecord:Does_Not_Exist__mdt.Nope',
    );
  });

  it('returns invalid-query when the recordId does not start with a record-type prefix', async () => {
    // CustomField is a real ComponentType but not a record type — the
    // tool rejects it explicitly so a typo cannot silently return a
    // mis-shaped result.
    const result = await lookupRecordHandler(ctx, {
      recordId: 'CustomField:Account.Industry',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('CustomMetadataRecord:');
    expect(result.error.message).toContain('CustomSettingRecord:');
    expect(result.error.path).toBe('recordId');
  });

  it('returns invalid-query for a recordId with no prefix at all', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: 'just-a-bare-string',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });
});

describe('lookupRecordInputSchema', () => {
  it('accepts a minimal well-formed CustomMetadataRecord input', () => {
    const parsed = lookupRecordInputSchema.safeParse({
      recordId: 'CustomMetadataRecord:Some_Type__mdt.Some_Record',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a minimal well-formed CustomSettingRecord input', () => {
    const parsed = lookupRecordInputSchema.safeParse({
      recordId: 'CustomSettingRecord:Some_Type__c.Some_Record',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a recordId whose prefix is wrong — invalid-query is a handler concern, not a Zod concern', () => {
    // The prefix constraint is not expressible at the Zod layer, so
    // Zod accepts any non-empty string. The handler is the gate.
    const parsed = lookupRecordInputSchema.safeParse({
      recordId: 'CustomField:Account.Industry',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty recordId string', () => {
    const parsed = lookupRecordInputSchema.safeParse({ recordId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing recordId', () => {
    const parsed = lookupRecordInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

/**
 * FIX 12 — the scope-echo contract.
 *
 * The non-strict input schema STRIPPED `objectApiName`, so a caller who scoped
 * the question to the wrong object got a confident answer about a different
 * one. CLAUDE.md's scope-honesty rule already specified the behaviour; this
 * tool did not implement it.
 */
describe('lookupRecordHandler — scope honesty (FIX 12)', () => {
  it('refuses a WRONG objectApiName instead of answering about another object', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: MARKETO_DEFAULT_ID,
      objectApiName: 'Clinical_Instruction__mdt',
    });
    // Pre-fix: a successful answer — the key was silently dropped.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toBe(
      '`objectApiName` names `Clinical_Instruction__mdt`, but record `CustomMetadataRecord:Marketo_Api_Setting__mdt.Default` belongs to `Marketo_Api_Setting__mdt`. Pass the matching object api name, or omit `objectApiName` — the record id already determines the scope.',
    );
  });

  it('accepts a MATCHING objectApiName and echoes appliedScope', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: MARKETO_DEFAULT_ID,
      objectApiName: 'Marketo_Api_Setting__mdt',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.appliedScope).toEqual({
      objectApiName: 'Marketo_Api_Setting__mdt',
      source: 'objectApiName',
    });
  });

  it('treats a case-only difference as AGREEMENT and echoes canonical casing', async () => {
    // Salesforce api names are case-insensitive; refusing on case would be a
    // new false negative.
    const result = await lookupRecordHandler(ctx, {
      recordId: MARKETO_DEFAULT_ID,
      objectApiName: 'marketo_api_setting__MDT',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.appliedScope.objectApiName).toBe(
      'Marketo_Api_Setting__mdt',
    );
  });

  it('derives appliedScope from the record id when no selector is passed', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: MARKETO_DEFAULT_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.appliedScope).toEqual({
      objectApiName: 'Marketo_Api_Setting__mdt',
      source: 'recordId',
    });
  });

  it('refuses an unrecognized argument rather than ignoring it', () => {
    const parsed = lookupRecordInputSchema.safeParse({
      recordId: MARKETO_DEFAULT_ID,
      objectApiName2: 'Whatever__mdt',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe(
      'Unrecognized argument(s): `objectApiName2`. `sfi.lookup_record` accepts: recordId, objectApiName. A mistyped argument is refused rather than ignored, so the answer is never about a question you did not ask.',
    );
  });

  it('refuses disagreeing objectApiName / typeApiName selectors', async () => {
    const result = await lookupRecordHandler(ctx, {
      recordId: MARKETO_DEFAULT_ID,
      objectApiName: 'Marketo_Api_Setting__mdt',
      typeApiName: 'Clinical_Instruction__mdt',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain(
      'object selectors name different targets',
    );
  });
});
