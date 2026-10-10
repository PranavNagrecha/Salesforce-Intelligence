/// <reference types="vitest/globals" />

/**
 * Code-reference edges (sprint workstream "apexedges"). Each block pins one
 * edge family that previously dropped real callers / references:
 *
 *   - MEMBER-IDENTITY-DEDUPE: two imports of one Apex class from one LWC
 *     bundle collapsed to ONE callsApex edge naming only the first method.
 *   - AURA-SERVER-ACTION-CALLS: an Aura bundle's `controller="X"` +
 *     `component.get('c.m')` produced no callsApex edge at all.
 *   - APEX-LABEL-UNGRAPHED: `System.Label.X` / `Label.X` in Apex produced no
 *     edge to the CustomLabel (only a hidden `CustomField:Label.X` phantom).
 *
 * Every fixture is synthetic.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge } from '@sf-intelligence/contracts';

import { buildApexScannerEdges, mergeAndSortEdges } from '../src/apex-edges.js';
import { extractAuraDefinitionBundle } from '../src/aura-definition-bundle.js';
import { extractLightningComponentBundle } from '../src/lightning-component-bundle.js';

const LWC_META = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>60.0</apiVersion>
    <isExposed>true</isExposed>
</LightningComponentBundle>`;

const AURA_META = `<?xml version="1.0" encoding="UTF-8"?>
<AuraDefinitionBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
</AuraDefinitionBundle>`;

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'sfi-code-refs-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const writeBundle = async (name: string, files: Record<string, string>): Promise<string> => {
  const dir = join(tempDir, name);
  await mkdir(dir);
  for (const [file, body] of Object.entries(files)) await writeFile(join(dir, file), body, 'utf-8');
  return dir;
};

const callsApex = (edges: readonly Edge[], toId: string): readonly Edge[] =>
  edges.filter((e) => e.edgeType === 'callsApex' && e.toId === toId);

describe('LWC callsApex keeps EVERY imported method (MEMBER-IDENTITY-DEDUPE)', () => {
  it('FAIL-BEFORE/PASS-AFTER: two imports of one class surface both methods on the one edge', async () => {
    const dir = await writeBundle('invoicePanel', {
      'invoicePanel.js-meta.xml': LWC_META,
      'invoicePanel.js': [
        "import { LightningElement, wire } from 'lwc';",
        "import getInvoices from '@salesforce/apex/InvoiceService.getInvoices';",
        "import voidInvoice from '@salesforce/apex/InvoiceService.voidInvoice';",
        "import getProjects from '@salesforce/apex/ProjectService.getProjects';",
        'export default class InvoicePanel extends LightningElement {}',
      ].join('\n'),
    });
    const result = await extractLightningComponentBundle(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const toInvoice = callsApex(result.value.edges, 'ApexClass:InvoiceService');
    expect(toInvoice).toHaveLength(1);
    expect(toInvoice[0]?.properties['methods']).toEqual(['getInvoices', 'voidInvoice']);
    expect(toInvoice[0]?.confidence).toBe('declared');
    // A single-import target keeps the same shape (one method on methods[]).
    expect(callsApex(result.value.edges, 'ApexClass:ProjectService')[0]?.properties['methods']).toEqual([
      'getProjects',
    ]);
  });

  it('mergeAndSortEdges folds Apex static-field members onto fields[] instead of dropping them', () => {
    const base = { fromId: 'ApexTrigger:InvoiceTrigger', toId: 'ApexClass:RecursionGuard', edgeType: 'references', confidence: 'heuristic', source: 'apex-scanner' } as const;
    const merged = mergeAndSortEdges([
      { ...base, properties: { mechanism: 'apexStaticField', field: 'runBefore', offset: 1, length: 2 } },
      { ...base, properties: { mechanism: 'apexStaticField', field: 'runAfter', offset: 9, length: 2 } },
    ] as Edge[]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.properties['fields']).toEqual(['runAfter', 'runBefore']);
    expect(merged[0]?.properties['offset']).toBe(1);
  });

  it('a duplicate with no member identity leaves the kept edge byte-identical', () => {
    const e = { fromId: 'A:x', toId: 'B:y', edgeType: 'references', confidence: 'declared', source: 's', properties: { role: 'r' } } as Edge;
    const merged = mergeAndSortEdges([e, { ...e, properties: { role: 'other' } }]);
    expect(merged).toEqual([e]);
  });
});

describe('Aura controller + c.method → callsApex (AURA-SERVER-ACTION-CALLS)', () => {
  it('FAIL-BEFORE/PASS-AFTER: component.get("c.m") calls on the declared controller become one method-level callsApex edge', async () => {
    const dir = await writeBundle('ProjectViewer', {
      'ProjectViewer.cmp-meta.xml': AURA_META,
      'ProjectViewer.cmp':
        '<aura:component controller="ProjectViewerController" implements="force:hasRecordId">\n  <aura:handler name="init" value="{!this}" action="{!c.doInit}"/>\n</aura:component>\n',
      'ProjectViewerController.js':
        '({\n  doInit : function(component, event, helper) {\n    var action = component.get("c.getProjectForUser");\n    $A.enqueueAction(action);\n  }\n})\n',
      'ProjectViewerHelper.js':
        "({\n  save : function(cmp) {\n    var a = cmp.get('c.saveProject');\n    $A.enqueueAction(a);\n  }\n})\n",
    });
    const result = await extractAuraDefinitionBundle(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edges = callsApex(result.value.edges, 'ApexClass:ProjectViewerController');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.properties['methods']).toEqual(['getProjectForUser', 'saveProject']);
    // Honest tier: the method names come from a regex over JS strings.
    expect(edges[0]?.confidence).toBe('heuristic');
    // The declared controller binding stays.
    expect(
      result.value.edges.some(
        (e) => e.edgeType === 'references' && e.toId === 'ApexClass:ProjectViewerController' && e.confidence === 'declared',
      ),
    ).toBe(true);
  });

  it('server actions with NO declared controller mint no edge and are disclosed on the node', async () => {
    const dir = await writeBundle('ChildPanel', {
      'ChildPanel.cmp-meta.xml': AURA_META,
      'ChildPanel.cmp': '<aura:component extends="c:BasePanel"></aura:component>\n',
      'ChildPanelController.js': "({ init : function(cmp) { var a = cmp.get('c.loadRows'); } })\n",
    });
    const result = await extractAuraDefinitionBundle(dir);
    if (!result.ok) throw new Error('extract failed');
    expect(result.value.edges.filter((e) => e.edgeType === 'callsApex')).toEqual([]);
    expect(result.value.nodes[0]?.properties['unresolvedServerActions']).toEqual(['loadRows']);
  });

  it('a markup {!c.clientAction} is a CLIENT action — never an Apex call', async () => {
    const dir = await writeBundle('ButtonBar', {
      'ButtonBar.cmp-meta.xml': AURA_META,
      'ButtonBar.cmp': '<aura:component controller="ButtonBarController"><lightning:button onclick="{!c.handleClick}"/></aura:component>\n',
    });
    const result = await extractAuraDefinitionBundle(dir);
    if (!result.ok) throw new Error('extract failed');
    expect(result.value.edges.filter((e) => e.edgeType === 'callsApex')).toEqual([]);
  });
});

describe('Apex Custom Label references → CustomLabel (APEX-LABEL-UNGRAPHED)', () => {
  const SRC = [
    'public class InvoiceMailer {',
    '  public static String subject() {',
    '    String a = System.Label.Invoice_Subject;',
    '    String b = Label.Invoice_Footer + system.label.Invoice_Subject;',
    '    String c = Label.acme.Partner_Banner;',
    "    String d = 'Label.Not_A_Ref';",
    '    // Label.Commented_Out',
    '    Schema.DescribeFieldResult f = Invoice__c.Amount__c.getDescribe();',
    '    String e = f.getLabel() + f.Label.length();',
    '    return a + b + c + d + e;',
    '  }',
    '}',
  ].join('\n');

  it('FAIL-BEFORE/PASS-AFTER: System.Label.X / Label.X become references edges to CustomLabel', () => {
    const { edges } = buildApexScannerEdges(SRC, 'ApexClass:InvoiceMailer');
    const labelTargets = edges
      .filter((e) => e.toId.startsWith('CustomLabel:'))
      .map((e) => [e.toId, e.edgeType, e.confidence, e.properties['referenceKind']]);
    expect(labelTargets).toEqual([
      ['CustomLabel:Invoice_Footer', 'references', 'heuristic', 'apexLabel'],
      ['CustomLabel:Invoice_Subject', 'references', 'heuristic', 'apexLabel'],
      ['CustomLabel:acme__Partner_Banner', 'references', 'heuristic', 'apexLabel'],
    ]);
  });

  it('no CustomField:Label.* / CustomField:System.* phantom remains', () => {
    const { edges } = buildApexScannerEdges(SRC, 'ApexClass:InvoiceMailer');
    expect(edges.filter((e) => /^CustomField:(Label|System)\./i.test(e.toId))).toEqual([]);
  });
});
