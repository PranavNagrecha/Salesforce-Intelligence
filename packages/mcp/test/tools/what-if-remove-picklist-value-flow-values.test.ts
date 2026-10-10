/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER — `what_if_remove_picklist_value` misses every Flow
 * condition and Flow write that uses the value.
 *
 * Flow / workflow criteria render UNQUOTED (`Status__c EqualTo Paid`), and the
 * tool matched only `'Paid'` / `"Paid"`; it also walked only edges FROM a Flow,
 * while a Flow's conditions reach the field through their ConditionalContext.
 * Result on real vaults: `impacts: []` for values that active record-triggered
 * flows filter on. Record types and criteria sharing rules that list the value
 * were never consulted, and nothing said which families went unchecked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { whatIfRemovePicklistValueHandler } from '../../src/tools/what-if-remove-picklist-value.js';

const OBJ = 'CustomObject:Invoice__c';
const FIELD = 'CustomField:Invoice__c.Status__c';

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const cc = (flow: string, index: number, props: Record<string, unknown>): Node =>
  node({
    id: `ConditionalContext:${flow}.condition-${index}`,
    type: 'ConditionalContext',
    apiName: `${flow}.condition-${index}`,
    parentId: flow,
    properties: props,
  });

const statusItem = (operator: string, value: string, valueKind = 'literal') => ({
  field: 'Status__c',
  fieldId: FIELD,
  operator,
  value,
  valueKind,
});


const visibilityPage = (sobject: string): string => `<FlexiPage>
    <flexiPageRegions><itemInstances><componentInstance>
        <componentName>flexipage:fieldSection</componentName>
        <visibilityRule><criteria>
            <leftValue>{!Record.Status__c}</leftValue>
            <operator>EQUAL</operator>
            <rightValue>Paid</rightValue>
        </criteria></visibilityRule>
    </componentInstance></itemInstances></flexiPageRegions>
    <sobjectType>${sobject}</sobjectType>
</FlexiPage>`;
const relatedListPage = (relationship: string): string => `<FlexiPage>
    <flexiPageRegions><itemInstances><componentInstance>
        <componentInstanceProperties>
            <name>adminFilters</name>
            <valueList><valueListItems>
                <value>Status__c|EQUALS|[&quot;Paid&quot;]</value>
            </valueListItems></valueList>
        </componentInstanceProperties>
        <componentInstanceProperties>
            <name>relatedListApiName</name>
            <value>${relationship}</value>
        </componentInstanceProperties>
        <componentName>lst:dynamicRelatedList</componentName>
    </componentInstance></itemInstances></flexiPageRegions>
    <sobjectType>Account</sobjectType>
</FlexiPage>`;
/** Lightning pages: none has an edge to the field (the real-vault shape). */
const PAGES: Record<string, string> = {
  Invoice_Record_Page: visibilityPage('Invoice__c'),
  Project_Record_Page: visibilityPage('Project__c'),
  Account_Record_Page: relatedListPage('Invoices__r'),
  Account_Projects_Page: relatedListPage('Projects__r'),
};

const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Invoice__c' }),
    node({
      id: FIELD,
      type: 'CustomField',
      apiName: 'Status__c',
      parentId: OBJ,
      properties: { dataType: 'Picklist', restricted: true, picklistValues: ['Paid', 'Paid Late', 'Void', 'Open', 'Draft', 'Cancelled'] },
    }),
    node({ id: 'Flow:Entry_Flow', type: 'Flow', apiName: 'Entry_Flow', properties: { status: 'Active' } }),
    cc('Flow:Entry_Flow', 0, {
      kind: 'flow-recordtrigger',
      expression: 'Status__c EqualTo Paid OR Status__c EqualTo Void',
      entryRequiresRecordChange: true,
      conditionItems: [statusItem('EqualTo', 'Paid'), statusItem('EqualTo', 'Void')],
    }),
    node({ id: 'Flow:Legacy_Vault_Flow', type: 'Flow', apiName: 'Legacy_Vault_Flow', properties: { status: 'Active' } }),
    // Built before conditionItems existed: only the prose expression.
    cc('Flow:Legacy_Vault_Flow', 0, {
      kind: 'flow-decision',
      expression: 'Status__c EqualTo Paid AND Amount__c GreaterThan 0',
    }),
    node({ id: 'Flow:Near_Miss_Flow', type: 'Flow', apiName: 'Near_Miss_Flow', properties: { status: 'Active' } }),
    cc('Flow:Near_Miss_Flow', 0, {
      kind: 'flow-decision',
      expression: 'Status__c EqualTo Paid Late',
      conditionItems: [statusItem('EqualTo', 'Paid Late')],
    }),
    node({ id: 'Flow:Ref_Flow', type: 'Flow', apiName: 'Ref_Flow', properties: { status: 'Active' } }),
    cc('Flow:Ref_Flow', 0, {
      kind: 'flow-decision',
      expression: 'Status__c EqualTo Paid',
      conditionItems: [statusItem('EqualTo', 'Paid', 'reference')],
    }),
    node({ id: 'Flow:Retired_Flow', type: 'Flow', apiName: 'Retired_Flow', properties: { status: 'Obsolete' } }),
    cc('Flow:Retired_Flow', 0, {
      kind: 'flow-recordtrigger',
      expression: 'Status__c NotEqualTo Paid',
      conditionItems: [statusItem('NotEqualTo', 'Paid')],
    }),
    node({ id: 'Flow:Lookup_Flow', type: 'Flow', apiName: 'Lookup_Flow', properties: { status: 'Active' } }),
    node({ id: 'Flow:Writer_Flow', type: 'Flow', apiName: 'Writer_Flow', properties: { status: 'Active' } }),
    node({
      id: 'RecordType:Invoice__c.Standard',
      type: 'RecordType',
      apiName: 'Invoice__c.Standard',
      parentId: OBJ,
      properties: { picklists: [{ field: 'Status__c', values: ['Open', 'Paid', 'Draft'] }] },
    }),
    // Uses 'Cancelled' only, and does not run.
    node({ id: 'Flow:Parked_Flow', type: 'Flow', apiName: 'Parked_Flow', properties: { status: 'Draft' } }),
    cc('Flow:Parked_Flow', 0, {
      kind: 'flow-decision',
      expression: 'Status__c EqualTo Cancelled',
      conditionItems: [statusItem('EqualTo', 'Cancelled')],
    }),
    // Tests the value only inside a `<formulas>` resource: no edge to the field.
    node({
      id: 'Flow:Formula_Flow',
      type: 'Flow',
      apiName: 'Formula_Flow',
      properties: {
        status: 'Active',
        formulaValueRefs: [{ name: 'fIsPaid', fields: ['Invoice__c.Status__c'], literals: ['Paid'] }],
        formulaComparisons: [{ formula: 'fIsPaid', field: 'Invoice__c.Status__c', value: 'Paid' }],
      },
    }),
    // Same field name and value on ANOTHER object: never a match.
    node({
      id: 'Flow:Other_Object_Formula_Flow',
      type: 'Flow',
      apiName: 'Other_Object_Formula_Flow',
      properties: {
        status: 'Active',
        formulaValueRefs: [{ name: 'fProjectPaid', fields: ['Project__c.Status__c'], literals: ['Paid'] }],
        formulaComparisons: [{ formula: 'fProjectPaid', field: 'Project__c.Status__c', value: 'Paid' }],
      },
    }),
    node({
      id: 'SharingRule:Invoice__c.Share_Settled',
      type: 'SharingRule',
      apiName: 'Invoice__c.Share_Settled',
      parentId: OBJ,
      properties: { criteriaItems: [{ field: 'Status__c', operation: 'equals', value: 'Paid,Void' }] },
    }),
    // The child relationship an Account page's related list uses.
    node({
      id: 'CustomField:Invoice__c.Account__c',
      type: 'CustomField',
      apiName: 'Account__c',
      parentId: OBJ,
      properties: { dataType: 'Lookup', relationshipName: 'Invoices' },
    }),
    ...Object.keys(PAGES).map((name) =>
      node({ id: `FlexiPage:${name}`, type: 'FlexiPage', apiName: name, sourcePath: `pages/${name}.flexipage-meta.xml` }),
    ),
  ],
  edges: [
    edge({ fromId: OBJ, toId: FIELD, edgeType: 'parentOf' }),
    ...['Entry_Flow', 'Legacy_Vault_Flow', 'Near_Miss_Flow', 'Ref_Flow', 'Retired_Flow', 'Parked_Flow'].flatMap((f) => [
      edge({ fromId: `Flow:${f}`, toId: `ConditionalContext:Flow:${f}.condition-0`, edgeType: 'firesWhen' }),
      edge({
        fromId: `ConditionalContext:Flow:${f}.condition-0`,
        toId: FIELD,
        edgeType: 'readsFrom',
        properties: { firerId: `Flow:${f}` },
      }),
    ]),
    edge({
      fromId: 'Flow:Lookup_Flow',
      toId: FIELD,
      edgeType: 'readsFrom',
      confidence: 'parsed',
      properties: {
        operation: 'recordFilter',
        element: 'recordLookup',
        filterOperator: 'EqualTo',
        filterValue: 'Paid',
        filterValueKind: 'literal',
      },
    }),
    // First write sets 'Open'; the merged second write sets 'Paid'.
    edge({
      fromId: 'Flow:Writer_Flow',
      toId: FIELD,
      edgeType: 'writesTo',
      confidence: 'parsed',
      properties: {
        operation: 'recordUpdate',
        assignedValue: 'Open',
        assignedValueKind: 'literal',
        literalValues: ['Open', 'Paid'],
      },
    }),
  ],
};

const manifest: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-01-01T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-rpv-flow-'));
  mkdirSync(join(tempDir, 'pages'));
  for (const [name, xml] of Object.entries(PAGES)) {
    writeFileSync(join(tempDir, 'pages', `${name}.flexipage-meta.xml`), xml, 'utf-8');
  }
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const run = async (value = 'Paid') => {
  const r = await whatIfRemovePicklistValueHandler(ctx, { fieldId: FIELD, value });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.data;
};

describe('FAIL-BEFORE/PASS-AFTER: picklist removal sees every Flow use of the value', () => {
  it('attributes an unquoted entry-criteria match to the Flow, naming where it is used', async () => {
    const data = await run();
    const hit = data.impacts.find((i) => i.componentId === 'Flow:Entry_Flow');
    expect(hit?.category).toBe('metadata-blocker');
    expect(hit?.where?.[0]).toContain("Status__c EqualTo 'Paid'");
    expect(hit?.where?.[0]).toContain('only when a save changes the record');
    expect(data.verdict).toBe('blocking');
  });

  it('falls back to the prose expression on a vault without structured items', async () => {
    const data = await run();
    expect(data.impacts.map((i) => i.componentId)).toContain('Flow:Legacy_Vault_Flow');
  });

  it('does not match a different value that merely starts with it, nor a reference comparison', async () => {
    const ids = (await run()).impacts.map((i) => i.componentId);
    expect(ids).not.toContain('Flow:Near_Miss_Flow');
    expect(ids).not.toContain('Flow:Ref_Flow');
  });

  it('lists an inactive Flow as informational, never as an impact', async () => {
    const data = await run();
    expect(data.impacts.map((i) => i.componentId)).not.toContain('Flow:Retired_Flow');
    const hit = data.informational.find((i) => i.componentId === 'Flow:Retired_Flow');
    expect(hit?.status).toBe('Obsolete');
    expect(hit?.explanation).toContain('does not run');
  });

  it('finds a Get Records filter and a second (merged) literal write, and says a restricted write fails', async () => {
    const data = await run();
    expect(data.restricted).toBe(true);
    expect(data.impacts.find((i) => i.componentId === 'Flow:Lookup_Flow')?.where?.[0]).toContain('filter');
    const writer = data.impacts.find((i) => i.componentId === 'Flow:Writer_Flow');
    expect(writer?.where?.[0]).toContain('RESTRICTED');
  });

  it('reports record types (informational) and criteria sharing rules that list the value', async () => {
    const data = await run();
    expect(data.impacts.map((i) => i.componentId)).not.toContain('RecordType:Invoice__c.Standard');
    expect(data.informational.map((i) => i.componentId)).toContain('RecordType:Invoice__c.Standard');
    expect(data.impacts.find((i) => i.componentId === 'SharingRule:Invoice__c.Share_Settled')?.category).toBe(
      'invisible-risk',
    );
  });

  it('finds Lightning page visibility rules and related-list filters that carry no edge, scoped to the object', async () => {
    const data = await run();
    const page = (n: string) => data.impacts.find((i) => i.componentId === `FlexiPage:${n}`);
    expect(page('Invoice_Record_Page')?.where).toEqual(['Lightning page component visibility rule']);
    expect(page('Account_Record_Page')?.where).toEqual(['Lightning page related-list filter']);
    // Same field name on ANOTHER object: never a match.
    expect(page('Project_Record_Page')).toBeUndefined();
    expect(page('Account_Projects_Page')).toBeUndefined();
  });

  it('names the families it did not check instead of implying "none"', async () => {
    const data = await run();
    expect(data.notChecked.join(' ')).toContain('report');
    expect(data.trust.limitations?.join(' ')).toContain('Not checked');
  });
});

describe('FAIL-BEFORE/PASS-AFTER: holding a value is not breaking it', () => {
  // Before: a record type that lists the value was a configuration-only
  // impact, so compatibility went 'breaking', the verdict 'risky', and the
  // explanation said removal "will break this reference" — false: the value
  // is just dropped from the record type.
  it('a value used only by record types returns review, with the record type informational', async () => {
    const data = await run('Draft');
    expect(data.impacts).toEqual([]);
    expect(data.compatibility).toBe('review');
    expect(data.verdict).toBe('review');
    const rt = data.informational.find((i) => i.componentId === 'RecordType:Invoice__c.Standard');
    expect(rt?.explanation).toContain('nothing breaks');
    expect(rt?.explanation).not.toContain('break this reference');
  });

  it('a value used only by a Flow that does not run returns review', async () => {
    const data = await run('Cancelled');
    expect(data.impacts).toEqual([]);
    expect(data.compatibility).toBe('review');
    expect(data.verdict).toBe('review');
    expect(data.informational.map((i) => i.componentId)).toEqual(['Flow:Parked_Flow']);
  });
});

describe('FAIL-BEFORE/PASS-AFTER: Flow formula resources are checked', () => {
  // Before: a value tested only in a `<formulas>` resource
  // (`ISPICKVAL({!$Record.Status__c}, 'Paid')`) carries no edge to the field
  // and was silently absent, while the disclosure said Flows were checked.
  it('attributes a formula-resource comparison to its Flow, scoped to the object', async () => {
    const data = await run();
    const hit = data.impacts.find((i) => i.componentId === 'Flow:Formula_Flow');
    expect(hit?.category).toBe('metadata-blocker');
    expect(hit?.where).toEqual(["formula resource fIsPaid: compares this field to 'Paid'"]);
    expect(data.impacts.map((i) => i.componentId)).not.toContain('Flow:Other_Object_Formula_Flow');
  });

  it('names Flows built before formula resources were extracted, and the families never read', async () => {
    const data = await run();
    const notChecked = data.notChecked.join(' | ');
    expect(notChecked).toMatch(/Flow formula resources in \d+ Flow\(s\) built before/);
    expect(notChecked).toContain('screen-component visibility rules and text templates');
  });
});
