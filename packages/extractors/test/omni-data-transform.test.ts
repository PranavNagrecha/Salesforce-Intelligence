/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractOmniDataTransform } from '../src/omni-data-transform.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const SAMPLE_FIXTURE_REL =
  'tests/fixtures/synthetic-v3.2/omniDataTransforms/SampleExtractMapper_1.rpt-meta.xml';

/**
 * Write `content` to a `.rpt-meta.xml` file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute
 * file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-omni-data-transform-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractOmniDataTransform', () => {
  describe('happy path (synthetic fixture)', () => {
    itHarness('extracts identity and per-type properties from SampleExtractMapper_1', async () => {
      const fixturePath = resolve(HARNESS_ROOT, SAMPLE_FIXTURE_REL);
      const result = await extractOmniDataTransform(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes).toHaveLength(1);
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      // Canonical id: `OmniDataTransform:{uniqueName}` (filename stem,
      // matching the Salesforce metadata API's fullName).
      expect(node.id).toBe('OmniDataTransform:SampleExtractMapper_1');
      expect(node.type).toBe('OmniDataTransform');
      expect(node.apiName).toBe('SampleExtractMapper_1');
      expect(node.parentId).toBeNull();
      expect(node.sourcePath).toBe(fixturePath);
      // Label prefers description over name.
      expect(node.label).toBe(
        'Synthetic v3.2 R2c fixture — extracts a single Contact by Id to a JSON payload, exercising the colon-prefix alias convention plus the SObject-element edge surface.',
      );
      // Per-type properties documented in PLAN-v3.2 §3 + the vendored
      // OmniDataTransform.md.
      expect(node.properties['name']).toBe('SampleExtractMapper');
      expect(node.properties['uniqueName']).toBe('SampleExtractMapper_1');
      expect(node.properties['active']).toBe(true);
      expect(node.properties['inputType']).toBe('JSON');
      expect(node.properties['outputType']).toBe('JSON');
      // <interfaceClass> is absent in this fixture; the extractor
      // falls back to <type> so the canonical key is never null when
      // the org-vintage uses the alternate element name.
      expect(node.properties['interfaceClass']).toBe('Extract');
      expect(node.properties['operationType']).toBe('Extract');
      expect(node.properties['transformItemCount']).toBe(3);
      expect(node.properties['assignmentRulesUsed']).toBe(false);
      expect(node.properties['nullInputsIncludedInOutput']).toBe(false);
      expect(node.properties['sourceObject']).toBe('Contact');
      expect(node.properties['versionNumber']).toBe(1.0);
      // expectedInputJson / expectedOutputJson absent in this fixture.
      expect(node.properties['expectedInputJson']).toBeNull();
      expect(node.properties['expectedOutputJson']).toBeNull();
    });

    itHarness('emits references edges to source/target SObjects via the colon-prefix convention and direct elements', async () => {
      const fixturePath = resolve(HARNESS_ROOT, SAMPLE_FIXTURE_REL);
      const result = await extractOmniDataTransform(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edges = result.value.edges;
      // Expected distinct (toId, confidence, role) triples for the
      // SampleExtractMapper fixture:
      //   - Contact via <sourceObject> (declared, sourceObject)
      //   - Contact via item-level <inputObjectName> (declared, inputObject)
      //   - Contact via the `ContactInput:` alias, which the QueryContact
      //     extract step binds to Contact (parsed, inputPathAlias) — the
      //     alias itself is NOT an object and mints no `CustomObject:ContactInput`
      //   - nothing from `ContactOutput:` — a JSON output path's prefix is a
      //     JSON node, not an SObject.
      // Output-object-names of `json` are filtered (NON_SOBJECT_OBJECT_NAMES).
      expect(edges).toHaveLength(3);
      // All edges originate at this DataRaptor.
      for (const edge of edges) {
        expect(edge.fromId).toBe('OmniDataTransform:SampleExtractMapper_1');
        expect(edge.edgeType).toBe('references');
        expect(edge.source).toBe('omni-data-transform');
      }
      const byKey = new Map(
        edges.map((e) => [
          `${e.toId}|${e.confidence}|${(e.properties as { role?: string }).role ?? ''}`,
          e,
        ]),
      );
      expect(byKey.has('CustomObject:Contact|declared|sourceObject')).toBe(true);
      expect(byKey.has('CustomObject:Contact|declared|inputObject')).toBe(true);
      expect(byKey.has('CustomObject:Contact|parsed|inputPathAlias')).toBe(true);
      expect(byKey.has('CustomObject:ContactInput|parsed|inputPathAlias')).toBe(false);
      expect(byKey.has('CustomObject:ContactOutput|parsed|outputPathAlias')).toBe(false);
    });

    itHarness('does NOT emit dispatchesOmniAction edges (DataRaptors are leaf-of-the-chain)', async () => {
      const fixturePath = resolve(HARNESS_ROOT, SAMPLE_FIXTURE_REL);
      const result = await extractOmniDataTransform(fixturePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const dispatchEdges = result.value.edges.filter(
        (e) => e.edgeType === 'dispatchesOmniAction',
      );
      expect(dispatchEdges).toEqual([]);
    });
  });

  describe('Load-variant SObject output edges', () => {
    it('emits a declared references edge per distinct SObject in <outputObjectName> (Load DataRaptor)', async () => {
      // A Load DataRaptor: outputObjectName names a real SObject, NOT
      // `json`. Per OmniDataTransform.md, this is how Load variants
      // declare their target SObject; the extractor surfaces it as a
      // declared `outputObject` reference. The fixture below also
      // exercises:
      //   - <inputType>JSON</inputType>
      //   - A `Formula` output row (filtered out — not a real SObject)
      //   - Two real SObject output rows pointing at the same target
      //     (deduped to one edge)
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <inputType>JSON</inputType>
    <name>LoadTransactions</name>
    <omniDataTransformItem>
        <disabled>false</disabled>
        <formulaExpression>SERIALIZE(%payload%)</formulaExpression>
        <name>FormulaRow</name>
        <outputFieldName>Formula</outputFieldName>
        <outputObjectName>Formula</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <disabled>false</disabled>
        <inputFieldName>payload</inputFieldName>
        <name>MapBody</name>
        <outputFieldName>ACME_Transaction__c</outputFieldName>
        <outputObjectName>ACME_Transaction__c</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <disabled>true</disabled>
        <name>DisabledIdRow</name>
        <outputFieldName>Id</outputFieldName>
        <outputObjectName>ACME_Transaction__c</outputObjectName>
    </omniDataTransformItem>
    <type>Load</type>
    <uniqueName>LoadTransactions_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`;
      const { dir, path } = await writeTempXml(
        'LoadTransactions_1.rpt-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['interfaceClass']).toBe('Load');
        expect(node.properties['transformItemCount']).toBe(3);
        // One object-level reference — `Formula` filtered as a non-SObject
        // placeholder, duplicate `ACME_Transaction__c` deduped.
        const refs = result.value.edges.filter((e) => e.edgeType === 'references');
        expect(refs).toHaveLength(1);
        const edge = refs[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe('CustomObject:ACME_Transaction__c');
        expect(edge.confidence).toBe('declared');
        expect(edge.edgeType).toBe('references');
        expect(edge.properties).toEqual({ role: 'outputObject' });
        // Field-level: the enabled row writes its field; the disabled Id row
        // writes nothing, so the object write is a create, not an upsert.
        const writes = result.value.edges.filter((e) => e.edgeType === 'writesTo');
        expect(writes.map((e) => [e.toId, e.properties['operation'] ?? null])).toEqual([
          ['CustomField:ACME_Transaction__c.ACME_Transaction__c', null],
          ['CustomObject:ACME_Transaction__c', 'recordCreate'],
        ]);
        expect(writes[0]?.properties['inputFieldNames']).toEqual(['payload']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('field-level reads and writes', () => {
    const fieldEdges = async (filename: string, xml: string) => {
      const { dir, path } = await writeTempXml(filename, xml);
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return { edges: [], node: undefined };
        return {
          edges: result.value.edges
            .filter((e) => e.edgeType !== 'references')
            .map((e) => ({ type: e.edgeType, toId: e.toId, props: e.properties })),
          node: result.value.nodes[0],
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };

    it('an Extract reads its filter field and every alias-mapped field; a relationship path waits for the import', async () => {
      const { edges, node } = await fieldEdges(
        'AcmeGetOrders_1.rpt-meta.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>AcmeGetOrders</name>
    <omniDataTransformItem>
        <filterOperator>=</filterOperator>
        <filterValue>orderId</filterValue>
        <inputFieldName>Id</inputFieldName>
        <inputObjectName>Acme_Order__c</inputObjectName>
        <outputFieldName>ord</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>ord:Acme_Status__c</inputFieldName>
        <outputFieldName>Order:Status</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>ord:Acme_Account__r.Name</inputFieldName>
        <outputFieldName>Order:AccountName</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <disabled>true</disabled>
        <inputFieldName>ord:Acme_Old__c</inputFieldName>
        <outputFieldName>Order:Old</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <type>Extract</type>
    <uniqueName>AcmeGetOrders_1</uniqueName>
</OmniDataTransform>`,
      );
      expect(edges.map((e) => [e.type, e.toId, e.props['roles']])).toEqual([
        ['readsFrom', 'CustomField:Acme_Order__c.Acme_Status__c', ['mapping']],
        ['readsFrom', 'CustomField:Acme_Order__c.Id', ['filter']],
      ]);
      expect(node?.properties['unresolvedTraversalRefs']).toEqual([
        { object: 'Acme_Order__c', path: 'Acme_Account__r.Name', access: 'read' },
      ]);
    });

    it('a Load that maps Id writes its object as an upsert', async () => {
      const { edges } = await fieldEdges(
        'AcmeSaveOrder_1.rpt-meta.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>AcmeSaveOrder</name>
    <omniDataTransformItem>
        <inputFieldName>Order:RecId</inputFieldName>
        <outputFieldName>Id</outputFieldName>
        <outputObjectName>Acme_Order__c</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>Order:Status</inputFieldName>
        <outputFieldName>Acme_Status__c</outputFieldName>
        <outputObjectName>Acme_Order__c</outputObjectName>
    </omniDataTransformItem>
    <type>Load</type>
    <uniqueName>AcmeSaveOrder_1</uniqueName>
</OmniDataTransform>`,
      );
      expect(edges.map((e) => [e.toId, e.props['operation'] ?? null])).toEqual([
        ['CustomField:Acme_Order__c.Acme_Status__c', null],
        ['CustomField:Acme_Order__c.Id', null],
        ['CustomObject:Acme_Order__c', 'recordUpsert'],
      ]);
      expect(edges.every((e) => e.type === 'writesTo')).toBe(true);
    });

    it('a Transform emits no field edges', async () => {
      const { edges } = await fieldEdges(
        'AcmeShape_1.rpt-meta.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>AcmeShape</name>
    <omniDataTransformItem>
        <inputFieldName>A:B</inputFieldName>
        <outputFieldName>C:D</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <type>Transform</type>
    <uniqueName>AcmeShape_1</uniqueName>
</OmniDataTransform>`,
      );
      expect(edges).toEqual([]);
    });
  });

  describe('one-item edge case', () => {
    it('handles a single <omniDataTransformItem> entry (scalar, not array, in fast-xml-parser)', async () => {
      // fast-xml-parser parses one occurrence of <omniDataTransformItem>
      // as a scalar object, two or more as an array. Confirm the
      // `toArray` helper handles both shapes.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <inputType>JSON</inputType>
    <name>OneItemTransform</name>
    <omniDataTransformItem>
        <disabled>false</disabled>
        <inputFieldName>InputAlias:Field</inputFieldName>
        <name>SingleMapping</name>
        <outputFieldName>OutputAlias:Field</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <type>Transform</type>
    <uniqueName>OneItemTransform_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`;
      const { dir, path } = await writeTempXml(
        'OneItemTransform_1.rpt-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['transformItemCount']).toBe(1);
        expect(node.properties['interfaceClass']).toBe('Transform');
        // Zero edges. A Transform reads and writes JSON, so `InputAlias:` and
        // `OutputAlias:` are JSON nodes, not SObjects — minting
        // `CustomObject:InputAlias` / `CustomObject:OutputAlias` from them
        // fabricated a phantom object per JSON container.
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits zero edges when no SObject surfaces are present and all paths lack a colon', async () => {
      // A no-edge happy path: no <sourceObject>, no <inputObjectName>,
      // output-object-name is `json`, and field paths have no colon
      // (so colonAlias returns null). Result: zero references edges.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <inputType>JSON</inputType>
    <name>FlatPathsOnly</name>
    <omniDataTransformItem>
        <disabled>false</disabled>
        <inputFieldName>flatInput</inputFieldName>
        <name>FlatMapping</name>
        <outputFieldName>flatOutput</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <type>Transform</type>
    <uniqueName>FlatPathsOnly_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`;
      const { dir, path } = await writeTempXml(
        'FlatPathsOnly_1.rpt-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('colon-prefix paths only name SObjects where they address records', () => {
    const run = async (
      filename: string,
      xml: string,
    ): Promise<readonly { toId: string; role: string; confidence: string }[]> => {
      const { dir, path } = await writeTempXml(filename, xml);
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return [];
        // Object-level `references` edges only; field-level reads / writes
        // have their own tests below.
        return result.value.edges
          .filter((e) => e.edgeType === 'references')
          .map((e) => ({
            toId: e.toId,
            role: String((e.properties as { role?: string }).role ?? ''),
            confidence: e.confidence,
          }));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };

    it('a Transform with JSON input mints no CustomObject from its Edit Block input node', async () => {
      const edges = await run(
        'AcmeCartTransform_1.rpt-meta.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <inputType>JSON</inputType>
    <name>AcmeCartTransform</name>
    <omniDataTransformItem>
        <inputFieldName>CartLineEditBlock:Acme_Quantity__c</inputFieldName>
        <name>AcmeCartTransform</name>
        <outputFieldName>CartLineEditBlock:Acme_Quantity__c</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <outputType>JSON</outputType>
    <type>Transform</type>
    <uniqueName>AcmeCartTransform_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`,
      );
      expect(edges).toEqual([]);
    });

    it('an Extract alias resolves to the SObject its extract step binds, not to the alias', async () => {
      const edges = await run(
        'AcmeGetOrders_1.rpt-meta.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <inputType>JSON</inputType>
    <name>AcmeGetOrders</name>
    <omniDataTransformItem>
        <filterOperator>=</filterOperator>
        <filterValue>orderId</filterValue>
        <inputFieldName>Id</inputFieldName>
        <inputObjectName>Acme_Order__c</inputObjectName>
        <name>AcmeGetOrders</name>
        <outputFieldName>ord</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>ord:Acme_Status__c</inputFieldName>
        <name>AcmeGetOrders</name>
        <outputFieldName>Order:Status</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>unbound:Name</inputFieldName>
        <name>AcmeGetOrders</name>
        <outputFieldName>Order:Name</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <outputType>JSON</outputType>
    <type>Extract</type>
    <uniqueName>AcmeGetOrders_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`,
      );
      expect(edges).toEqual([
        { toId: 'CustomObject:Acme_Order__c', role: 'inputObject', confidence: 'declared' },
        { toId: 'CustomObject:Acme_Order__c', role: 'inputPathAlias', confidence: 'parsed' },
      ]);
    });

    it('an Extract alias bound to two different objects is ambiguous and emits no alias edge', async () => {
      const edges = await run(
        'AcmeAmbiguous_1.rpt-meta.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <name>AcmeAmbiguous</name>
    <omniDataTransformItem>
        <inputFieldName>Id</inputFieldName>
        <inputObjectName>Acme_Order__c</inputObjectName>
        <name>AcmeAmbiguous</name>
        <outputFieldName>rec</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>Id</inputFieldName>
        <inputObjectName>Acme_Invoice__c</inputObjectName>
        <name>AcmeAmbiguous</name>
        <outputFieldName>rec</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>rec:Name</inputFieldName>
        <name>AcmeAmbiguous</name>
        <outputFieldName>Name</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <type>Extract</type>
    <uniqueName>AcmeAmbiguous_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`,
      );
      expect(edges.filter((e) => e.role === 'inputPathAlias')).toEqual([]);
    });

    it('recognizes the class-form interfaceClass as an Extract', async () => {
      const edges = await run(
        'AcmeClassForm_1.rpt-meta.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <interfaceClass>omnistudio.DataRaptorExtract</interfaceClass>
    <name>AcmeClassForm</name>
    <omniDataTransformItem>
        <inputFieldName>Id</inputFieldName>
        <inputObjectName>Acme_Order__c</inputObjectName>
        <name>AcmeClassForm</name>
        <outputFieldName>o</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>o:Name</inputFieldName>
        <name>AcmeClassForm</name>
        <outputFieldName>Name</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <uniqueName>AcmeClassForm_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`,
      );
      expect(edges).toContainEqual({
        toId: 'CustomObject:Acme_Order__c',
        role: 'inputPathAlias',
        confidence: 'parsed',
      });
    });
  });

  describe('interfaceClass precedence', () => {
    it('prefers <interfaceClass> over <type> when both are present', async () => {
      // Per OmniDataTransform.md, `interfaceClass` is the canonical
      // discriminant; `<type>` is a fallback for orgs that emit the
      // operation kind under the alternate element name. When both
      // are present, the canonical key wins.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <inputType>SObject</inputType>
    <interfaceClass>omnistudio.DataRaptorExtract</interfaceClass>
    <name>BothClassAndType</name>
    <omniDataTransformItem>
        <disabled>false</disabled>
        <inputFieldName>Foo</inputFieldName>
        <name>Row</name>
        <outputFieldName>Bar</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <type>Extract</type>
    <uniqueName>BothClassAndType_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`;
      const { dir, path } = await writeTempXml(
        'BothClassAndType_1.rpt-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['interfaceClass']).toBe(
          'omnistudio.DataRaptorExtract',
        );
        // Raw <type> still surfaced under operationType so consumers
        // can disambiguate.
        expect(node.properties['operationType']).toBe('Extract');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.rpt-meta.xml';
      const result = await extractOmniDataTransform(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Bad.rpt-meta.xml',
        '<?xml version="1.0"?><OmniDataTransform><name>X</wrongClose></OmniDataTransform>',
      );
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <OmniDataTransform>', async () => {
      const { dir, path } = await writeTempXml(
        'Wrong.rpt-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <OmniDataTransform> root',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <name> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
  <active>true</active>
  <inputType>JSON</inputType>
</OmniDataTransform>`;
      const { dir, path } = await writeTempXml(
        'NoName.rpt-meta.xml',
        xml,
      );
      try {
        const result = await extractOmniDataTransform(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <name>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
