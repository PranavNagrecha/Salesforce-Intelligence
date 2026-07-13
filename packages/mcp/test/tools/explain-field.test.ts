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
  explainFieldHandler,
  explainFieldInputSchema,
} from '../../src/tools/explain-field.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 3,
    CustomField: 5,
    CustomMetadataRecord: 2,
  },
  edges: { parentOf: 9 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. Caller overrides id/type/apiName/properties. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomField',
  apiName: 'Industry__c',
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
// Seed 1: A plain CustomField on a non-`__mdt` parent (CustomObject:Account).
// Verifies the base shape — label, description, type, required — without the
// recordValues axis.
// =============================================================================

const ACCOUNT_ID = 'CustomObject:Account';
const ACCOUNT_INDUSTRY_ID = 'CustomField:Account.Industry';

const accountIndustrySeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: ACCOUNT_ID,
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      properties: {},
    }),
    makeNode({
      id: ACCOUNT_INDUSTRY_ID,
      type: 'CustomField',
      apiName: 'Industry',
      label: 'Industry',
      parentId: ACCOUNT_ID,
      properties: {
        label: 'Industry',
        dataType: 'Picklist',
        description: 'The industry the account operates in.',
        required: false,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 1b: A Picklist field with an INLINE value-set definition. Verifies
// `picklistValues` surfaces the declared values verbatim (the literal answer
// to "what values are in this picklist?" — P14-ROUTER-picklist-values).
// Mirrors the real Payment_Status__c shape the custom-field extractor emits.
// =============================================================================

const INLINE_PICKLIST_FIELD_ID = 'CustomField:Account.Payment_Status__c';

const inlinePicklistFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: INLINE_PICKLIST_FIELD_ID,
      type: 'CustomField',
      apiName: 'Payment_Status__c',
      label: 'Payment Status',
      parentId: ACCOUNT_ID,
      properties: {
        label: 'Payment Status',
        dataType: 'Picklist',
        description: null,
        required: false,
        picklistValues: ['Scheduled', 'Completed', 'Cancelled', 'Sent'],
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 1b2 (H10): A re-extracted (NEW-vault) picklist storing the object shape
// `{value,isActive,label?,default?}`, including one DEACTIVATED value. Verifies
// the consumer LISTS-and-marks the inactive value (never drops, never reports
// selectable). The object entries would be SILENTLY DROPPED by the old
// `typeof === 'string'` filter → empty list — the H10 back-compat break.
// =============================================================================

const NEW_VAULT_PICKLIST_FIELD_ID = 'CustomField:Account.Stage__c';

const newVaultPicklistFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NEW_VAULT_PICKLIST_FIELD_ID,
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: ACCOUNT_ID,
      properties: {
        label: 'Stage',
        dataType: 'Picklist',
        description: null,
        required: false,
        picklistValues: [
          { value: 'Scheduled', isActive: true, label: 'Scheduled', default: true },
          { value: 'Old', isActive: false, label: 'Old (retired)', default: false },
        ],
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 1c: A GlobalValueSet-DRIVEN picklist (P14-USAGE-gvs-edge): inline
// picklistValues null, but a usesValueSet edge leads to the GlobalValueSet
// node carrying the declared values — explain_field follows it. The GVS node
// carries pre-CR-10b bare-string `values` (a vault refreshed before the GVS
// extractor captured per-value isActive/label/default) to pin the back-compat
// path: normalizePicklistValues treats each bare string as an active value.
// =============================================================================

const GVS_FIELD_ID = 'CustomField:Account.Region__c';
const GVS_ID = 'GlobalValueSet:Region_Codes';

const gvsDrivenFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: GVS_FIELD_ID,
      type: 'CustomField',
      apiName: 'Region__c',
      label: 'Region',
      parentId: ACCOUNT_ID,
      properties: {
        label: 'Region',
        dataType: 'Picklist',
        description: null,
        required: false,
        picklistValues: null,
        valueSetName: 'Region_Codes',
      },
    }),
    makeNode({
      id: GVS_ID,
      type: 'GlobalValueSet',
      apiName: 'Region_Codes',
      label: 'Region Codes',
      properties: {
        masterLabel: 'Region Codes',
        valueCount: 3,
        values: ['EMEA', 'APAC', 'AMER'],
      },
    }),
  ],
  edges: [
    {
      fromId: GVS_FIELD_ID,
      toId: GVS_ID,
      edgeType: 'usesValueSet',
      confidence: 'declared',
      source: 'custom-field-extractor',
      properties: {},
    },
  ],
};

// =============================================================================
// Seed 1d (CR-10b): A GlobalValueSet-DRIVEN picklist whose GVS node carries
// the CURRENT extractor's rich per-value shape `{value, isActive, label,
// default}`, INCLUDING a deactivated entry — proves explain_field surfaces an
// honest isActive for a GVS-resolved value (retained, not filtered, not
// UNVERIFIED) end to end through the usesValueSet edge.
// =============================================================================

const GVS_RICH_FIELD_ID = 'CustomField:Account.Term_Year__c';
const GVS_RICH_ID = 'GlobalValueSet:Term_Year';

const gvsRichDrivenFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: GVS_RICH_FIELD_ID,
      type: 'CustomField',
      apiName: 'Term_Year__c',
      label: 'Term Year',
      parentId: ACCOUNT_ID,
      properties: {
        label: 'Term Year',
        dataType: 'Picklist',
        description: null,
        required: false,
        picklistValues: null,
        valueSetName: 'Term_Year',
      },
    }),
    makeNode({
      id: GVS_RICH_ID,
      type: 'GlobalValueSet',
      apiName: 'Term_Year',
      label: 'Term Year',
      properties: {
        masterLabel: 'Term Year',
        valueCount: 2,
        values: [
          { value: '2025', isActive: true, label: '2025', default: false },
          { value: '2017', isActive: false, label: '2017', default: false },
        ],
      },
    }),
  ],
  edges: [
    {
      fromId: GVS_RICH_FIELD_ID,
      toId: GVS_RICH_ID,
      edgeType: 'usesValueSet',
      confidence: 'declared',
      source: 'custom-field-extractor',
      properties: {},
    },
  ],
};

// =============================================================================
// Seed 2: A CustomField with no description. Verifies the null fallback.
// =============================================================================

const NO_DESC_FIELD_ID = 'CustomField:Account.Notes__c';

const noDescriptionFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: NO_DESC_FIELD_ID,
      type: 'CustomField',
      apiName: 'Notes__c',
      label: 'Notes',
      parentId: ACCOUNT_ID,
      properties: {
        label: 'Notes',
        dataType: 'TextArea',
        description: null,
        required: false,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 2b: A Currency FORMULA (computed) field. Verifies `formula` is
// surfaced so a consumer knows the field is read-only / derived rather than a
// writable Currency. Mirrors the real Earnings__c (a relabeled passthrough of
// Payment_Amount__c).
// =============================================================================

const FORMULA_FIELD_ID = 'CustomField:Account.Earnings__c';

const formulaFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: FORMULA_FIELD_ID,
      type: 'CustomField',
      apiName: 'Earnings__c',
      label: 'Earnings',
      parentId: ACCOUNT_ID,
      properties: {
        label: 'Earnings',
        dataType: 'Currency',
        description: null,
        required: false,
        formula: 'Payment_Amount__c',
        // description is null, so inlineHelpText is the ONLY human context —
        // mirrors the real CustomField:Payment__c.Earnings__c.
        inlineHelpText: 'Relabeled Payment Amount for Reporting',
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 2c: A Lookup (relationship) field. Verifies `referenceTo` — the TARGET
// object the field points at — is surfaced. Without it, a business-user asking
// "what does this field mean / point to?" gets a bare `type: "Lookup"` and no
// target. Mirrors the real CustomField:Payment__c.Sample_Connection__c, a
// Lookup to hed__Course_Enrollment__c.
// =============================================================================

const PAYMENT_ID = 'CustomObject:Payment__c';
const LOOKUP_FIELD_ID = 'CustomField:Payment__c.Sample_Connection__c';

const lookupFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: PAYMENT_ID,
      type: 'CustomObject',
      apiName: 'Payment__c',
      label: 'Payment',
      properties: {},
    }),
    makeNode({
      id: LOOKUP_FIELD_ID,
      type: 'CustomField',
      apiName: 'Sample_Connection__c',
      label: 'Course Connection',
      parentId: PAYMENT_ID,
      properties: {
        label: 'Course Connection',
        dataType: 'Lookup',
        description: null,
        required: false,
        referenceTo: 'hed__Course_Enrollment__c',
        relationshipName: 'Payments',
        inlineHelpText:
          'For Clinical Instructor On-Call Course Connection Payments.',
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 3: A CustomField on an `__mdt` parent with two CustomMetadataRecord
// children that hold values for the field. Verifies the recordValues axis
// fires when the parent is `__mdt`, projects each child's matching value,
// and surfaces masked entries as `{ value: null, isMasked: true }`.
// =============================================================================

const MDT_TYPE_ID = 'CustomObject:Marketo_Api_Setting__mdt';
const MDT_FIELD_ID =
  'CustomField:Marketo_Api_Setting__mdt.Number_Of_Retries__c';
const MDT_RECORD_DEFAULT_ID =
  'CustomMetadataRecord:Marketo_Api_Setting__mdt.Default';
const MDT_RECORD_PROD_ID =
  'CustomMetadataRecord:Marketo_Api_Setting__mdt.Production';

const mdtFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: MDT_TYPE_ID,
      type: 'CustomObject',
      apiName: 'Marketo_Api_Setting__mdt',
      label: 'Marketo Api Setting',
      properties: {},
    }),
    makeNode({
      id: MDT_FIELD_ID,
      type: 'CustomField',
      apiName: 'Number_Of_Retries__c',
      label: 'Number Of Retries',
      parentId: MDT_TYPE_ID,
      properties: {
        label: 'Number Of Retries',
        dataType: 'Number',
        description: 'How many times to retry a failing Marketo API call.',
        required: true,
      },
    }),
    makeNode({
      id: MDT_RECORD_DEFAULT_ID,
      type: 'CustomMetadataRecord',
      apiName: 'Marketo_Api_Setting__mdt.Default',
      label: 'Default Settings',
      parentId: MDT_TYPE_ID,
      properties: {
        label: 'Default Settings',
        protected: false,
        recordName: 'Default',
        typeApiName: 'Marketo_Api_Setting__mdt',
        valuesCount: 1,
        values: [
          {
            field: 'Number_Of_Retries__c',
            value: 3,
            valueType: 'number',
            isMasked: false,
          },
        ],
        hasMaskedValues: false,
      },
    }),
    makeNode({
      id: MDT_RECORD_PROD_ID,
      type: 'CustomMetadataRecord',
      apiName: 'Marketo_Api_Setting__mdt.Production',
      label: 'Production Settings',
      parentId: MDT_TYPE_ID,
      properties: {
        label: 'Production Settings',
        protected: false,
        recordName: 'Production',
        typeApiName: 'Marketo_Api_Setting__mdt',
        valuesCount: 1,
        values: [
          // A masked value for the same field — the explain_field
          // honesty axis must preserve the masked flag.
          {
            field: 'Number_Of_Retries__c',
            value: null,
            valueType: 'number',
            isMasked: true,
          },
        ],
        hasMaskedValues: true,
      },
    }),
  ],
  edges: [],
};

// =============================================================================
// Seed 4: A CustomField on an `__mdt` parent whose record children DO NOT
// hold a value for this specific field. Verifies the honesty axis: records
// without a matching value are omitted from `recordValues`, not surfaced
// with `value: null` (which would conflate "no value set" with a masked null).
// =============================================================================

const MDT_UNUSED_FIELD_ID =
  'CustomField:Marketo_Api_Setting__mdt.Unused_Field__c';

const mdtUnusedFieldSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: MDT_UNUSED_FIELD_ID,
      type: 'CustomField',
      apiName: 'Unused_Field__c',
      label: 'Unused Field',
      parentId: MDT_TYPE_ID,
      properties: {
        label: 'Unused Field',
        dataType: 'Text',
        description: null,
        required: false,
      },
    }),
  ],
  edges: [],
};

// One shared graph store + Context across the suite. All seeds use distinct
// ids; the MDT_TYPE_ID parent appears in two seeds but the import dedupes by
// id so the second insert is a no-op.
let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-explain-field-'));
  const dbPath = join(tempDir, 'explain-field.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [
    accountIndustrySeed,
    inlinePicklistFieldSeed,
    newVaultPicklistFieldSeed,
    gvsDrivenFieldSeed,
    gvsRichDrivenFieldSeed,
    noDescriptionFieldSeed,
    formulaFieldSeed,
    mdtFieldSeed,
    mdtUnusedFieldSeed,
    lookupFieldSeed,
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

describe('explainFieldHandler', () => {
  it('returns the base shape (no recordValues) for a field on a non-__mdt parent', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: ACCOUNT_INDUSTRY_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fieldId, label, description, type, required, recordValues } =
      result.value.data;
    expect(fieldId).toBe(ACCOUNT_INDUSTRY_ID);
    expect(label).toBe('Industry');
    expect(description).toBe('The industry the account operates in.');
    expect(type).toBe('Picklist');
    expect(required).toBe(false);
    // A stored (non-formula) field surfaces formula: null.
    expect(result.value.data.formula).toBeNull();
    // Industry carries no inline help text → null (not dropped/undefined).
    expect(result.value.data.inlineHelpText).toBeNull();
    // Non-`__mdt` parent: recordValues is omitted entirely.
    expect(recordValues).toBeUndefined();
    // vaultState carries the manifest hash and timestamp.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });

  it('surfaces the formula expression for a computed formula field', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: FORMULA_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { type, formula, inlineHelpText } = result.value.data;
    // `type` is the formula's RETURN type (Currency)...
    expect(type).toBe('Currency');
    // ...and the non-null `formula` flags it as a read-only computed field.
    expect(formula).toBe('Payment_Amount__c');
    // description is null, so the inline help text is the only human context
    // and must be surfaced, not dropped.
    expect(inlineHelpText).toBe('Relabeled Payment Amount for Reporting');
  });

  it('surfaces the referenceTo target for a lookup (relationship) field', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: LOOKUP_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { type, referenceTo } = result.value.data;
    // `type` alone says "Lookup" but not WHAT it points to. `referenceTo` is
    // the defining fact of a relationship field — the business-user "what does
    // this field mean?" answer must include the target object. Previously
    // dropped (only generate_data_dictionary surfaced this node property).
    expect(type).toBe('Lookup');
    expect(referenceTo).toBe('hed__Course_Enrollment__c');
  });

  it('returns null referenceTo for a non-relationship field', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: NO_DESC_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A plain TextArea has no target — referenceTo must be null, not fabricated.
    expect(result.value.data.referenceTo).toBeNull();
  });

  it('surfaces the declared picklistValues for an inline-value-set picklist field (H10 back-compat: bare-string OLD vault ⇒ active objects)', async () => {
    // This seed stores the LEGACY bare-string shape (a pre-CR-10 vault). The
    // normalizer must read it WITHOUT crashing or dropping, treating each
    // string as an ACTIVE value — never silently emptying to [].
    const result = await explainFieldHandler(ctx, {
      fieldId: INLINE_PICKLIST_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The declared value set, verbatim and in extractor order — each bare
    // string normalized to {value, isActive: true} (H10).
    expect(result.value.data.picklistValues).toEqual([
      { value: 'Scheduled', isActive: true },
      { value: 'Completed', isActive: true },
      { value: 'Cancelled', isActive: true },
      { value: 'Sent', isActive: true },
    ]);
    // Inline values present → no "not inline" disclosure.
    expect(result.value.data.picklistValuesNote).toBeUndefined();
  });

  it('H10: lists-and-marks an inactive value from a NEW-vault object[] picklist (not dropped, not selectable)', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: NEW_VAULT_PICKLIST_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both values LISTED — the deactivated one carried with isActive:false,
    // never dropped (existing records may hold it) and never presented as
    // selectable. label/default carried through.
    expect(result.value.data.picklistValues).toEqual([
      { value: 'Scheduled', isActive: true, label: 'Scheduled', default: true },
      { value: 'Old', isActive: false, label: 'Old (retired)', default: false },
    ]);
    expect(result.value.data.picklistValuesNote).toBeUndefined();
  });

  it('discloses a non-inline (GlobalValueSet-driven) picklist instead of letting null read as "no values"', async () => {
    // Account.Industry is dataType Picklist with NO picklistValues property —
    // exactly what the extractor emits when the value set is a GlobalValueSet
    // reference rather than an inline definition.
    const result = await explainFieldHandler(ctx, {
      fieldId: ACCOUNT_INDUSTRY_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.picklistValues).toBeNull();
    // The disclosure must say the values live elsewhere, not that there are none.
    expect(result.value.data.picklistValuesNote).toContain('GlobalValueSet');
    expect(result.value.data.picklistValuesNote).toContain('not inline');
  });

  it('resolves a GlobalValueSet-driven picklist through the usesValueSet edge (P14-USAGE-gvs-edge); back-compat with a pre-CR-10b bare-string GVS', async () => {
    const result = await explainFieldHandler(ctx, { fieldId: GVS_FIELD_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The declared values come from the LINKED GlobalValueSet, cited by id.
    // This GVS node's `values` are pre-CR-10b bare strings (an un-refreshed
    // vault) — normalizePicklistValues wraps each as {value, isActive: true}
    // for shape uniformity, same back-compat rule as the inline reader.
    expect(result.value.data.picklistValues).toEqual([
      { value: 'EMEA', isActive: true },
      { value: 'APAC', isActive: true },
      { value: 'AMER', isActive: true },
    ]);
    expect(result.value.data.picklistValuesSource).toBe(GVS_ID);
    // CR-10b: no disclosure note fires for a resolved GlobalValueSet anymore
    // — the "not inline" note only fires when resolution FAILS.
    expect(result.value.data.picklistValuesNote).toBeUndefined();
  });

  it('CR-10b: surfaces an honest isActive:false for a GVS-resolved deactivated value, never dropping it', async () => {
    const result = await explainFieldHandler(ctx, { fieldId: GVS_RICH_FIELD_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both values LISTED — the deactivated one carried with isActive:false,
    // label and default threaded through unchanged. Nothing filtered.
    expect(result.value.data.picklistValues).toEqual([
      { value: '2025', isActive: true, label: '2025', default: false },
      { value: '2017', isActive: false, label: '2017', default: false },
    ]);
    expect(result.value.data.picklistValuesSource).toBe(GVS_RICH_ID);
    expect(result.value.data.picklistValuesNote).toBeUndefined();
  });

  it('returns null picklistValues with NO note for a non-picklist field', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: NO_DESC_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A TextArea has no value set — null without the picklist disclosure
    // (the note is reserved for picklist-typed fields whose set isn't inline).
    expect(result.value.data.picklistValues).toBeNull();
    expect(result.value.data.picklistValuesNote).toBeUndefined();
  });

  it('returns null description for a field that has no description set', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: NO_DESC_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.description).toBeNull();
    expect(result.value.data.type).toBe('TextArea');
  });

  it('includes recordValues for a field on an __mdt parent, sorted by recordId ASC', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: MDT_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { recordValues } = result.value.data;
    expect(recordValues).toBeDefined();
    expect(recordValues?.length).toBe(2);
    // Sort: recordId ASC — Default < Production.
    expect(recordValues?.[0]?.recordId).toBe(MDT_RECORD_DEFAULT_ID);
    expect(recordValues?.[0]?.recordLabel).toBe('Default Settings');
    expect(recordValues?.[0]?.value).toBe(3);
    expect(recordValues?.[0]?.isMasked).toBe(false);
    // Production carries the masked value verbatim.
    expect(recordValues?.[1]?.recordId).toBe(MDT_RECORD_PROD_ID);
    expect(recordValues?.[1]?.value).toBeNull();
    expect(recordValues?.[1]?.isMasked).toBe(true);
  });

  it('omits records that lack a value for the field (honesty axis)', async () => {
    // Unused_Field__c is parented to Marketo_Api_Setting__mdt; the two
    // record children (Default + Production) do NOT carry a values
    // entry for this field. The handler must surface an empty
    // recordValues array rather than emit `value: null` for each.
    const result = await explainFieldHandler(ctx, {
      fieldId: MDT_UNUSED_FIELD_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { recordValues } = result.value.data;
    expect(recordValues).toBeDefined();
    expect(recordValues).toEqual([]);
  });

  it('suppresses recordValues when includeRecordValues: false even on an __mdt parent', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: MDT_FIELD_ID,
      includeRecordValues: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Explicit suppression — the property is absent entirely, not the
    // empty array.
    expect(result.value.data.recordValues).toBeUndefined();
    // The intrinsic field metadata still comes through.
    expect(result.value.data.label).toBe('Number Of Retries');
    expect(result.value.data.required).toBe(true);
  });

  it('forces an empty recordValues array when includeRecordValues: true on a non-__mdt parent', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: ACCOUNT_INDUSTRY_ID,
      includeRecordValues: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Forced on, but the parent is a regular CustomObject with no
    // CustomMetadataRecord children — the array is empty rather than
    // omitted, signalling "we looked and found nothing".
    expect(result.value.data.recordValues).toEqual([]);
  });

  it('returns component-not-found for an unknown field id', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: 'CustomField:Account.DoesNotExist__c',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomField:Account.DoesNotExist__c');
  });

  it('discloses a referenced-but-not-modeled (phantom) standard field, not a bare not-found (B12/B29)', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ef-phantom-'));
    const opened = await openGraph(join(localDir, 'ph.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    // Account.Industry is a STANDARD field: no node of its own, but a
    // permission set grants it (the grantedBy edge exists).
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'PermissionSet:Sales',
            type: 'PermissionSet',
            apiName: 'Sales',
          }),
        ],
        edges: [
          {
            fromId: 'PermissionSet:Sales',
            toId: 'CustomField:Account.Industry',
            edgeType: 'grantedBy',
            confidence: 'declared',
            source: 'unit-test',
            properties: { targetMissing: true },
          },
        ],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await explainFieldHandler(localCtx, {
      fieldId: 'CustomField:Account.Industry',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toMatch(/referenced by 1 other component/);
    expect(r.error.message).toMatch(/never retrieved/);
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('returns object field list suggestion when a CustomObject id is passed (FLD-02)', async () => {
    // Passing CustomObject:Account should return a helpful suggestion with the
    // object's field list rather than an invalid-query error (FLD-02).
    const result = await explainFieldHandler(ctx, {
      fieldId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data as unknown as Record<string, unknown>;
    expect(data['objectId']).toBe('CustomObject:Account');
    expect(data['objectApiName']).toBe('Account');
    expect(Array.isArray(data['fieldIds'])).toBe(true);
    expect(data['score']).toBe(1);
    expect(typeof data['message']).toBe('string');
    expect((data['message'] as string)).toContain('object id');
  });

  it('returns invalid-query when fieldId has an unrecognised non-CustomField prefix', async () => {
    const result = await explainFieldHandler(ctx, {
      fieldId: 'ApexClass:SomeThing',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('CustomField:');
    expect(result.error.path).toBe('fieldId');
  });
});

describe('explainFieldInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = explainFieldInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts includeRecordValues: true', () => {
    const parsed = explainFieldInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
      includeRecordValues: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts includeRecordValues: false', () => {
    const parsed = explainFieldInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
      includeRecordValues: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty fieldId string', () => {
    const parsed = explainFieldInputSchema.safeParse({ fieldId: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing fieldId', () => {
    const parsed = explainFieldInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-boolean includeRecordValues', () => {
    const parsed = explainFieldInputSchema.safeParse({
      fieldId: 'CustomField:Account.Industry',
      includeRecordValues: 'yes',
    });
    expect(parsed.success).toBe(false);
  });
});
