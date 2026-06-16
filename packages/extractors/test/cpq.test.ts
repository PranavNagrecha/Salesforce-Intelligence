/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ExtractionResult, Node } from '@sf-intelligence/contracts';

import {
  extractCpqCustomMetadataRecord,
  specializeCpq,
} from '../src/cpq.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_BASE_REL =
  'tests/fixtures/synthetic-v2.6a/customMetadata';

const PRICE_RULE_FIXTURE_REL = `${FIXTURE_BASE_REL}/SBQQ__PriceRule__c.HighDiscountAlert.md-meta.xml`;
const PRODUCT_RULE_FIXTURE_REL = `${FIXTURE_BASE_REL}/SBQQ__ProductRule__c.LaptopMustHaveBattery.md-meta.xml`;
const QUOTE_TEMPLATE_FIXTURE_REL = `${FIXTURE_BASE_REL}/SBQQ__QuoteTemplate__c.StandardQuote.md-meta.xml`;
const LOOKUP_QUERY_FIXTURE_REL = `${FIXTURE_BASE_REL}/SBQQ__LookupQuery__c.DiscountThreshold.md-meta.xml`;
const CONFIG_ATTR_FIXTURE_REL = `${FIXTURE_BASE_REL}/SBQQ__ConfigurationAttribute__c.PurposeOfUse.md-meta.xml`;

/**
 * Write `content` to a `{stem}.md-meta.xml` file under a fresh
 * customMetadata/ directory. Returns the temp-dir root (for cleanup)
 * and the absolute file path. Mirrors the helper in
 * `custom-metadata-record.test.ts`.
 */
const writeTempCmdXml = async (
  stem: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-cpq-'));
  const subdir = join(dir, 'customMetadata');
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, `${stem}.md-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractCpqCustomMetadataRecord', () => {
  describe('SBQQ__ recognition heuristic', () => {
    itHarness('promotes SBQQ__PriceRule__c records to CpqPriceRule sibling nodes', async () => {
      const fixturePath = resolve(HARNESS_ROOT, PRICE_RULE_FIXTURE_REL);
      const result = await extractCpqCustomMetadataRecord(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Two sibling nodes: the underlying CMD record + the recognized
      // CpqPriceRule node. The original CMD node is NOT removed —
      // both coexist so v1.6 lookup surfaces keep working.
      expect(result.value.nodes.length).toBe(2);
      const cpqNode = result.value.nodes.find(
        (n) => n.type === 'CpqPriceRule',
      );
      expect(cpqNode).toBeDefined();
      if (!cpqNode) return;
      expect(cpqNode.id).toBe(
        'CpqPriceRule:SBQQ__PriceRule__c.HighDiscountAlert',
      );
      expect(cpqNode.apiName).toBe(
        'SBQQ__PriceRule__c.HighDiscountAlert',
      );
      expect(cpqNode.label).toBe('High Discount Alert');
      // The CPQ sibling shares parentId with the underlying record.
      expect(cpqNode.parentId).toBe('CustomObject:SBQQ__PriceRule__c');
      expect(cpqNode.properties['recognitionConfidence']).toBe(
        'heuristic',
      );
      expect(cpqNode.properties['underlyingRecordId']).toBe(
        'CustomMetadataRecord:SBQQ__PriceRule__c.HighDiscountAlert',
      );
    });

    itHarness('derives CpqPriceRule per-type properties from the values mirror', async () => {
      const fixturePath = resolve(HARNESS_ROOT, PRICE_RULE_FIXTURE_REL);
      const result = await extractCpqCustomMetadataRecord(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cpqNode = result.value.nodes.find(
        (n) => n.type === 'CpqPriceRule',
      );
      expect(cpqNode).toBeDefined();
      if (!cpqNode) return;
      // Boolean properties round-trip through; numeric properties
      // pass through verbatim (the v1.6 R2 extractor coerces them
      // via xsi:type, so the source-of-truth shape is preserved).
      expect(cpqNode.properties['active']).toBe(true);
      expect(cpqNode.properties['evaluationOrder']).toBe(10);
      expect(cpqNode.properties['conditionsMet']).toBe('All');
      expect(cpqNode.properties['calculatorEvaluationEvent']).toBe(
        'On Calculate',
      );
      expect(cpqNode.properties['evaluationScope']).toBe('Quote');
      expect(cpqNode.properties['lookupObject']).toBe(
        'SBQQ__Quote__c',
      );
    });

    itHarness('promotes SBQQ__ProductRule__c records to CpqProductRule', async () => {
      const fixturePath = resolve(HARNESS_ROOT, PRODUCT_RULE_FIXTURE_REL);
      const result = await extractCpqCustomMetadataRecord(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cpqNode = result.value.nodes.find(
        (n) => n.type === 'CpqProductRule',
      );
      expect(cpqNode).toBeDefined();
      if (!cpqNode) return;
      expect(cpqNode.id).toBe(
        'CpqProductRule:SBQQ__ProductRule__c.LaptopMustHaveBattery',
      );
      expect(cpqNode.properties['type']).toBe('Validation');
      expect(cpqNode.properties['lookupObject']).toBe(
        'SBQQ__ProductOption__c',
      );
      expect(cpqNode.properties['active']).toBe(true);
      expect(cpqNode.properties['evaluationOrder']).toBe(5);
    });

    itHarness('promotes SBQQ__QuoteTemplate__c records to CpqQuoteTemplate', async () => {
      const fixturePath = resolve(HARNESS_ROOT, QUOTE_TEMPLATE_FIXTURE_REL);
      const result = await extractCpqCustomMetadataRecord(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cpqNode = result.value.nodes.find(
        (n) => n.type === 'CpqQuoteTemplate',
      );
      expect(cpqNode).toBeDefined();
      if (!cpqNode) return;
      expect(cpqNode.id).toBe(
        'CpqQuoteTemplate:SBQQ__QuoteTemplate__c.StandardQuote',
      );
      expect(cpqNode.properties['templateContentReference']).toBe(
        'StandardQuoteTemplateRef',
      );
      expect(cpqNode.properties['defaultTemplate']).toBe(true);
      expect(cpqNode.properties['documentFormat']).toBe('PDF');
      expect(cpqNode.properties['landscape']).toBe(false);
    });

    itHarness('promotes SBQQ__LookupQuery__c records to CpqLookupQuery', async () => {
      const fixturePath = resolve(HARNESS_ROOT, LOOKUP_QUERY_FIXTURE_REL);
      const result = await extractCpqCustomMetadataRecord(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cpqNode = result.value.nodes.find(
        (n) => n.type === 'CpqLookupQuery',
      );
      expect(cpqNode).toBeDefined();
      if (!cpqNode) return;
      expect(cpqNode.properties['matchType']).toBe('GreaterThan');
      expect(cpqNode.properties['field']).toBe('SBQQ__Discount__c');
      expect(cpqNode.properties['value']).toBe('0.20');
      expect(cpqNode.properties['tested']).toBe(true);
    });

    itHarness('promotes SBQQ__ConfigurationAttribute__c records to CpqConfigurationAttribute', async () => {
      const fixturePath = resolve(HARNESS_ROOT, CONFIG_ATTR_FIXTURE_REL);
      const result = await extractCpqCustomMetadataRecord(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cpqNode = result.value.nodes.find(
        (n) => n.type === 'CpqConfigurationAttribute',
      );
      expect(cpqNode).toBeDefined();
      if (!cpqNode) return;
      expect(cpqNode.properties['targetField']).toBe(
        'SBQQ__Quote__c.SBQQ__BusinessPurpose__c',
      );
      expect(cpqNode.properties['position']).toBe('Top');
      expect(cpqNode.properties['displayOrder']).toBe(1);
      expect(cpqNode.properties['required']).toBe(true);
      expect(cpqNode.properties['product']).toBe('LaptopBundle');
    });
  });

  describe('parentOf edge emission', () => {
    itHarness('emits a parentOf edge from the SBQQ__ CustomObject to the CPQ node with heuristic confidence', async () => {
      const fixturePath = resolve(HARNESS_ROOT, PRICE_RULE_FIXTURE_REL);
      const result = await extractCpqCustomMetadataRecord(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Two parentOf edges total: one from the v1.6 extractor (declared
      // confidence, to the CMD record) and one from the v2.6a layer
      // (heuristic confidence, to the CpqPriceRule sibling).
      const cpqEdge = result.value.edges.find(
        (e) =>
          e.toId === 'CpqPriceRule:SBQQ__PriceRule__c.HighDiscountAlert',
      );
      expect(cpqEdge).toBeDefined();
      if (!cpqEdge) return;
      expect(cpqEdge.edgeType).toBe('parentOf');
      expect(cpqEdge.confidence).toBe('heuristic');
      expect(cpqEdge.source).toBe('cpq-extractor');
      expect(cpqEdge.fromId).toBe('CustomObject:SBQQ__PriceRule__c');
    });

    itHarness('preserves the original v1.6 CMD parentOf edge untouched', async () => {
      // The specialization layer ADDS — it never mutates or removes.
      // The original parentOf edge produced by the v1.6 extractor
      // continues to point to the CustomMetadataRecord node.
      const fixturePath = resolve(HARNESS_ROOT, PRICE_RULE_FIXTURE_REL);
      const result = await extractCpqCustomMetadataRecord(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const cmdEdge = result.value.edges.find(
        (e) =>
          e.toId ===
          'CustomMetadataRecord:SBQQ__PriceRule__c.HighDiscountAlert',
      );
      expect(cmdEdge).toBeDefined();
      if (!cmdEdge) return;
      expect(cmdEdge.edgeType).toBe('parentOf');
      // Confidence stays declared on the v1.6-emitted edge; only the
      // v2.6a edge carries heuristic confidence.
      expect(cmdEdge.confidence).toBe('declared');
      expect(cmdEdge.source).toBe('custom-metadata-record-extractor');
    });
  });

  describe('non-SBQQ__ records pass through unchanged', () => {
    it('emits no CPQ-typed nodes when the apiName has no SBQQ__ prefix', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <label>Plain Record</label>
    <protected>false</protected>
    <values>
        <field>Some_Field__c</field>
        <value xsi:type="xsd:string">value</value>
    </values>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml(
        'Plain_Type__mdt.Default',
        xml,
      );
      try {
        const result = await extractCpqCustomMetadataRecord(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Single node: the underlying CMD record. No CPQ sibling
        // because the apiName does not start with any of the five
        // recognition prefixes.
        expect(result.value.nodes.length).toBe(1);
        expect(result.value.nodes[0]?.type).toBe(
          'CustomMetadataRecord',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('preserves the underlying extractor errors verbatim (file-not-found)', async () => {
      const result = await extractCpqCustomMetadataRecord(
        '/nonexistent/customMetadata/Foo__mdt.Missing.md-meta.xml',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Recognition layer never introduces new error modes; the
      // underlying file-not-found surfaces verbatim.
      expect(result.error.kind).toBe('file-not-found');
    });
  });

  describe('property derivation honesty axis', () => {
    it('defaults missing boolean properties to false (not null)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <label>Minimal Price Rule</label>
    <protected>false</protected>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml(
        'SBQQ__PriceRule__c.Minimal',
        xml,
      );
      try {
        const result = await extractCpqCustomMetadataRecord(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const cpqNode = result.value.nodes.find(
          (n) => n.type === 'CpqPriceRule',
        );
        expect(cpqNode).toBeDefined();
        if (!cpqNode) return;
        // active is a Boolean property — defaults to false when
        // absent so the runtime "checkbox unset == false" semantic
        // round-trips cleanly.
        expect(cpqNode.properties['active']).toBe(false);
        // Non-boolean properties default to null when absent.
        expect(cpqNode.properties['evaluationOrder']).toBeNull();
        expect(cpqNode.properties['conditionsMet']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('collapses masked values to the default — does not fabricate the underlying value', async () => {
      // The CPQ specialization layer inherits v1.6's masked-value
      // honesty axis: any SBQQ field value that surfaces as
      // `isMasked: true` collapses to the per-type default rather
      // than passing the underlying value through.
      const underlyingNode: Node = {
        id: 'CustomMetadataRecord:SBQQ__PriceRule__c.Masked',
        type: 'CustomMetadataRecord',
        apiName: 'SBQQ__PriceRule__c.Masked',
        label: 'Masked Rule',
        parentId: 'CustomObject:SBQQ__PriceRule__c',
        sourcePath: 'unused.xml',
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {
          values: [
            {
              field: 'SBQQ__EvaluationOrder__c',
              value: null,
              valueType: 'number',
              isMasked: true,
            },
            {
              field: 'SBQQ__Active__c',
              value: null,
              valueType: 'boolean',
              isMasked: true,
            },
          ],
        },
      };
      const specialized = specializeCpq({
        nodes: [underlyingNode],
        edges: [],
      });
      const cpqNode = specialized.nodes.find(
        (n) => n.type === 'CpqPriceRule',
      );
      expect(cpqNode).toBeDefined();
      if (!cpqNode) return;
      // Both masked entries collapse to the default — boolean to
      // false, numeric to null. The underlying value is NOT
      // fabricated.
      expect(cpqNode.properties['active']).toBe(false);
      expect(cpqNode.properties['evaluationOrder']).toBeNull();
      // The values mirror preserves the mask flag so callers can
      // surface the masked status to the end user.
      const values = cpqNode.properties['values'] as ReadonlyArray<{
        readonly isMasked: boolean;
      }>;
      expect(values.every((v) => v.isMasked)).toBe(true);
    });
  });

  describe('specializeCpq direct invocation', () => {
    it('is a no-op for ExtractionResults with no CPQ-recognizable records', () => {
      const input: ExtractionResult = {
        nodes: [
          {
            id: 'CustomMetadataRecord:Plain__mdt.A',
            type: 'CustomMetadataRecord',
            apiName: 'Plain__mdt.A',
            label: null,
            parentId: 'CustomObject:Plain__mdt',
            sourcePath: 'x.xml',
            lastModifiedDate: null,
            lastModifiedBy: null,
            apiVersion: null,
            properties: { values: [] },
          },
        ],
        edges: [],
      };
      const output = specializeCpq(input);
      // Output equals input verbatim — no CPQ sibling node, no new edges.
      expect(output.nodes.length).toBe(1);
      expect(output.edges.length).toBe(0);
    });

    it('handles a mixed input — some recognized, some not — without affecting non-CPQ entries', () => {
      const input: ExtractionResult = {
        nodes: [
          {
            id: 'CustomMetadataRecord:Plain__mdt.Default',
            type: 'CustomMetadataRecord',
            apiName: 'Plain__mdt.Default',
            label: 'Plain',
            parentId: 'CustomObject:Plain__mdt',
            sourcePath: 'a.xml',
            lastModifiedDate: null,
            lastModifiedBy: null,
            apiVersion: null,
            properties: { values: [] },
          },
          {
            id: 'CustomMetadataRecord:SBQQ__LookupQuery__c.Q1',
            type: 'CustomMetadataRecord',
            apiName: 'SBQQ__LookupQuery__c.Q1',
            label: 'Lookup',
            parentId: 'CustomObject:SBQQ__LookupQuery__c',
            sourcePath: 'b.xml',
            lastModifiedDate: null,
            lastModifiedBy: null,
            apiVersion: null,
            properties: {
              values: [
                {
                  field: 'SBQQ__MatchType__c',
                  value: 'Equals',
                  valueType: 'string',
                  isMasked: false,
                },
              ],
            },
          },
        ],
        edges: [],
      };
      const output = specializeCpq(input);
      // The plain record passes through unchanged; the SBQQ__ record
      // gets a CpqLookupQuery sibling. Total nodes = 3.
      expect(output.nodes.length).toBe(3);
      const cpqNode = output.nodes.find(
        (n) => n.type === 'CpqLookupQuery',
      );
      expect(cpqNode).toBeDefined();
      if (!cpqNode) return;
      expect(cpqNode.properties['matchType']).toBe('Equals');
    });
  });
});
