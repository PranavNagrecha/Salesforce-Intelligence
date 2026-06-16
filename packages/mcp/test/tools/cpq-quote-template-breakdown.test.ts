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
import { cpqQuoteTemplateBreakdownHandler } from '../../src/tools/cpq-quote-template-breakdown.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 1,
    CpqQuoteTemplate: 1,
  },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:cpq-template-fixture',
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

// =============================================================================
// A CpqQuoteTemplate with the full top-level property set plus two
// SBQQ__Section__c-prefixed values that should surface as inferred
// section entries.
// =============================================================================

const TEMPLATE_TYPE_ID = 'CustomObject:SBQQ__QuoteTemplate__c';
const TEMPLATE_ID = 'CpqQuoteTemplate:SBQQ__QuoteTemplate__c.Standard';

const templateSeed: ExtractionResult = {
  nodes: [
    makeNode({
      id: TEMPLATE_TYPE_ID,
      type: 'CustomObject',
      apiName: 'SBQQ__QuoteTemplate__c',
    }),
    makeNode({
      id: TEMPLATE_ID,
      type: 'CpqQuoteTemplate',
      apiName: 'SBQQ__QuoteTemplate__c.Standard',
      label: 'Standard Template',
      parentId: TEMPLATE_TYPE_ID,
      properties: {
        active: true,
        defaultTemplate: true,
        templateContentReference: 'StandardTemplateContentRef',
        documentFormat: 'PDF',
        landscape: false,
        pageBreakBefore: null,
        recognitionConfidence: 'heuristic',
        values: [
          {
            field: 'SBQQ__Active__c',
            value: true,
            valueType: 'boolean',
            isMasked: false,
          },
          {
            field: 'SBQQ__Section__c__Cover',
            value: 'CoverPageSection',
            valueType: 'string',
            isMasked: false,
          },
          {
            field: 'SBQQ__Section__c__LineItems',
            value: 'LineItemsSection',
            valueType: 'string',
            isMasked: false,
          },
          {
            field: 'SomeOtherField__c',
            value: 'NotASection',
            valueType: 'string',
            isMasked: false,
          },
        ],
      },
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cpq-template-'));
  const dbPath = join(tempDir, 'cpq-template.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [templateSeed]);
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

describe('cpqQuoteTemplateBreakdownHandler', () => {
  it('returns top-level template configuration plus inferred sections', async () => {
    const result = await cpqQuoteTemplateBreakdownHandler(ctx, {
      templateId: TEMPLATE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.templateId).toBe(TEMPLATE_ID);
    expect(data.apiName).toBe('SBQQ__QuoteTemplate__c.Standard');
    expect(data.label).toBe('Standard Template');
    expect(data.active).toBe(true);
    expect(data.defaultTemplate).toBe(true);
    expect(data.templateContentReference).toBe(
      'StandardTemplateContentRef',
    );
    expect(data.documentFormat).toBe('PDF');
    expect(data.landscape).toBe(false);
    // Two SBQQ__Section__c-prefixed values surface as sections; the
    // SomeOtherField__c entry is excluded. Sort is alphabetical by
    // fieldName for deterministic emission.
    expect(data.sections.length).toBe(2);
    expect(data.sections[0]?.fieldName).toBe(
      'SBQQ__Section__c__Cover',
    );
    expect(data.sections[0]?.reference).toBe('CoverPageSection');
    expect(data.sections[1]?.fieldName).toBe(
      'SBQQ__Section__c__LineItems',
    );
  });

  it('surfaces the verbatim sub-record-limitation disclosure on every response', async () => {
    const result = await cpqQuoteTemplateBreakdownHandler(ctx, {
      templateId: TEMPLATE_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { disclosure } = result.value.data;
    expect(disclosure).toContain('SBQQ__TemplateSection__c');
    expect(disclosure).toContain('SBQQ__TemplateContent__c');
    expect(disclosure).toContain('CPQ Quote Template Editor');
  });

  it('returns invalid-query when the templateId carries a wrong prefix', async () => {
    const result = await cpqQuoteTemplateBreakdownHandler(ctx, {
      templateId: 'CpqPriceRule:SBQQ__PriceRule__c.SomeRule',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('CpqQuoteTemplate:');
  });

  it('returns component-not-found for an unknown template id with the right prefix', async () => {
    const result = await cpqQuoteTemplateBreakdownHandler(ctx, {
      templateId: 'CpqQuoteTemplate:SBQQ__QuoteTemplate__c.DoesNotExist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });
});
