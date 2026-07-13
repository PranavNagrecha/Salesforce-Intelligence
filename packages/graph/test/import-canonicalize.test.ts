/// <reference types="vitest/globals" />

import type { Edge, Node } from '@sf-intelligence/contracts';

import {
  canonicalizeApexCallEdgeTargets,
  canonicalizeFieldEdgeTargets,
  canonicalizeLabelEdgeTargets,
  canonicalizeObjectEdgeTargets,
  canonicalizeResourceEdgeTargets,
} from '../src/import.js';

const makeClass = (apiName: string): Node => ({
  id: `ApexClass:${apiName}`,
  type: 'ApexClass',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: 'x.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const makeField = (objectApi: string, fieldApi: string): Node => ({
  id: `CustomField:${objectApi}.${fieldApi}`,
  type: 'CustomField',
  apiName: fieldApi,
  label: fieldApi,
  parentId: `CustomObject:${objectApi}`,
  sourcePath: `objects/${objectApi}/fields/${fieldApi}.field-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const makeObject = (apiName: string): Node => ({
  id: `CustomObject:${apiName}`,
  type: 'CustomObject',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: `objects/${apiName}/${apiName}.object-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const makeLabel = (apiName: string): Node => ({
  id: `CustomLabel:${apiName}`,
  type: 'CustomLabel',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: `labels/CustomLabels.labels-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const makeResource = (apiName: string): Node => ({
  id: `StaticResource:${apiName}`,
  type: 'StaticResource',
  apiName,
  label: apiName,
  parentId: null,
  sourcePath: `staticresources/${apiName}.resource-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const fieldEdge = (
  toId: string,
  edgeType: Edge['edgeType'] = 'readsFrom',
  source = 'apex-ast',
): Edge => ({
  fromId: 'ApexClass:Q',
  toId: toId as Edge['toId'],
  edgeType,
  confidence: source === 'apex-ast' ? 'parsed' : 'heuristic',
  source,
  properties: {},
});

describe('canonicalizeApexCallEdgeTargets — GRF-01', () => {
  it('rewrites callsApex targets to the vaulted class id casing', () => {
    const nodes = [makeClass('pkb_Controller'), makeClass('Caller')];
    const edges: Edge[] = [
      {
        fromId: 'ApexClass:Caller',
        toId: 'ApexClass:pkb_controller',
        edgeType: 'callsApex',
        confidence: 'heuristic',
        source: 'apex-scanner',
        properties: {},
      },
    ];
    canonicalizeApexCallEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('ApexClass:pkb_Controller');
  });

  /**
   * C-2 (finding 25) — Visualforce `controller=`/`extensions=` attributes
   * are case-insensitive class names in Salesforce, but
   * `visualforce-page.ts` mints those as `edgeType: 'references'`, which
   * this canonicalizer used to hard-filter out (only `callsApex` /
   * `dispatchesAsync` were remapped). A VF page whose `controller="pkb_ctl"`
   * differs in case from the vaulted `ApexClass:pkb_Ctl` node dangled, and
   * `find_dead_code` would read the class as unreferenced.
   */
  it('rewrites a references-typed VF-controller edge to the vaulted class id casing', () => {
    const nodes = [makeClass('pkb_Ctl'), makeClass('Page')];
    const edges: Edge[] = [
      {
        fromId: 'VisualforcePage:MyPage',
        toId: 'ApexClass:pkb_ctl',
        edgeType: 'references',
        confidence: 'declared',
        source: 'visualforce-page',
        properties: { role: 'controller' },
      },
    ];
    canonicalizeApexCallEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('ApexClass:pkb_Ctl');
    // Properties are untouched by the remap — the raw evidence stays.
    expect(edges[0]?.properties).toEqual({ role: 'controller' });
  });

  it('leaves a references-typed edge to a non-Apex prefix untouched (no cross-prefix leakage)', () => {
    const nodes = [makeLabel('Foo'), makeClass('Page')];
    const edges: Edge[] = [
      {
        fromId: 'VisualforcePage:MyPage',
        toId: 'CustomLabel:foo',
        edgeType: 'references',
        confidence: 'heuristic',
        source: 'visualforce-page',
        properties: { resourceKind: 'label' },
      },
    ];
    canonicalizeApexCallEdgeTargets(nodes, edges);
    // canonicalizeApexCallEdgeTargets only remaps ApexClass:/ApexTrigger:
    // prefixes — CustomLabel: is out of scope for it (handled by
    // canonicalizeLabelEdgeTargets instead).
    expect(edges[0]?.toId).toBe('CustomLabel:foo');
  });
});

/**
 * R6-03 — CustomField edge-target case canonicalization. Apex and SOQL are
 * case-insensitive languages, so `[select id from account where
 * custom_flag__c = true]` yields parsed edges targeting
 * `CustomField:account.custom_flag__c` — a dangling id the exact-match edge
 * walk can never attach to the vaulted `CustomField:Account.Custom_Flag__c`
 * node. Edge-only consumers (`safe_to_delete_field`, `unused_fields_deep`
 * tier 1, `find_dead_code`) would then read the field as unreferenced — a
 * false "safe" on a destructive verdict.
 */
describe('canonicalizeFieldEdgeTargets — R6-03', () => {
  it('rewrites a case-variant SOQL-derived readsFrom target to the vaulted field id', () => {
    const nodes = [makeField('Account', 'Custom_Flag__c'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomField:account.custom_flag__c')];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Account.Custom_Flag__c');
  });

  it('rewrites writesTo and heuristic scanner edges too (producer-agnostic)', () => {
    const nodes = [makeField('Account', 'Industry__c'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:ACCOUNT.INDUSTRY__C', 'writesTo', 'apex-scanner'),
    ];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Account.Industry__c');
  });

  it('leaves an exact-match target untouched (no rewrite churn)', () => {
    const nodes = [makeField('Account', 'Industry__c'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomField:Account.Industry__c')];
    const before = edges[0];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]).toBe(before); // same object reference — not re-minted
  });

  it('leaves an unknown field dangling — absence is preserved, never guessed', () => {
    const nodes = [makeField('Account', 'Industry__c'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomField:Account.No_Such_Field__c')];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Account.No_Such_Field__c');
  });

  it('drops an ambiguous lower-key (two ids differing only by case) — never guesses', () => {
    // Impossible on the real platform (field API names are case-insensitive
    // unique per object) but guarded defensively: ambiguity means no remap.
    const nodes = [
      makeField('Account', 'Weird__c'),
      makeField('Account', 'WEIRD__c'),
      makeClass('Q'),
    ];
    const edges: Edge[] = [fieldEdge('CustomField:account.weird__c')];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:account.weird__c');
  });

  it('ignores non-CustomField targets', () => {
    const nodes = [makeField('Account', 'Industry__c'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomObject:account')];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomObject:account');
  });

  it('preserves edge properties verbatim on rewrite (the raw-case evidence stays)', () => {
    const nodes = [makeField('Account', 'Custom_Flag__c'), makeClass('Q')];
    const edges: Edge[] = [
      {
        ...fieldEdge('CustomField:account.Custom_Flag__c'),
        properties: { path: 'account.Custom_Flag__c', viaAst: true },
      },
    ];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Account.Custom_Flag__c');
    expect(edges[0]?.properties).toEqual({
      path: 'account.Custom_Flag__c',
      viaAst: true,
    });
  });
});

/**
 * R7-W3 — CustomObject edge-target case canonicalization. Mirrors R6-03 on
 * the object side: `[select id from account]` yields a heuristic `readsFrom`
 * edge targeting `CustomObject:account` — a dangling id the exact-match edge
 * walk can never attach to the vaulted `CustomObject:Account` node. Impact/
 * usage/deadness consumers that walk edges (not just declared parentOf) would
 * then miss the reference — a false-negative on impact analysis.
 */
describe('canonicalizeObjectEdgeTargets — R7-W3', () => {
  it('rewrites a lowercase SOQL-derived readsFrom target to the vaulted object id', () => {
    const nodes = [makeObject('Account'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomObject:account')];
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomObject:Account');
  });

  it('rewrites listensTo and other heuristic scanner edges too (producer-agnostic)', () => {
    const nodes = [makeObject('Order_Event__e'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomObject:ORDER_EVENT__E', 'listensTo', 'apex-scanner'),
    ];
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomObject:Order_Event__e');
  });

  it('leaves an exact-match target untouched (no rewrite churn)', () => {
    const nodes = [makeObject('Account'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomObject:Account')];
    const before = edges[0];
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]).toBe(before); // same object reference — not re-minted
  });

  it('leaves an unknown object dangling — absence is preserved, never guessed', () => {
    const nodes = [makeObject('Account'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomObject:No_Such_Object__c')];
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomObject:No_Such_Object__c');
  });

  it('drops an ambiguous lower-key (two ids differing only by case) — never guesses', () => {
    // Impossible on the real platform (object API names are case-insensitive
    // unique per org) but guarded defensively: ambiguity means no remap.
    const nodes = [makeObject('Weird__c'), makeObject('WEIRD__c'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomObject:weird__c')];
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomObject:weird__c');
  });

  it('case-folds a namespaced object id as one unit', () => {
    const nodes = [makeObject('ns__Order__c'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomObject:NS__order__c')];
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomObject:ns__Order__c');
  });

  it('does not fold a namespaced id onto a same-named bare object (whole-id case-fold, not per-segment)', () => {
    const nodes = [makeObject('Order__c'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomObject:NS__order__c')];
    canonicalizeObjectEdgeTargets(nodes, edges);
    // 'ns__order__c' !== 'order__c' as a whole lowercased string, so no remap.
    expect(edges[0]?.toId).toBe('CustomObject:NS__order__c');
  });

  it('ignores non-CustomObject targets', () => {
    const nodes = [makeObject('Account'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomField:account.industry__c')];
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:account.industry__c');
  });

  it('preserves edge properties verbatim on rewrite (the raw-case evidence stays)', () => {
    const nodes = [makeObject('Account'), makeClass('Q')];
    const edges: Edge[] = [
      {
        ...fieldEdge('CustomObject:account'),
        properties: { mechanism: 'soql', path: 'account' },
      },
    ];
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomObject:Account');
    expect(edges[0]?.properties).toEqual({ mechanism: 'soql', path: 'account' });
  });
});

/**
 * C-2 (finding 25) — CustomLabel edge-target case canonicalization.
 * `$Label.foo` is a case-insensitive value-provider token in Aura/VF
 * templates, but `buildResourceRefEdges` (apex-edges.ts) mints
 * `CustomLabel:{apiName}` verbatim from the frontend regex scanner's
 * source-text casing — a dangling id the exact-match edge walk can never
 * attach to the vaulted `CustomLabel:Foo` node. `find_dead_code`/
 * `unused_components` would then read the label as unreferenced — a false
 * "dead" verdict, the same failure class R6-03/R7-W3 were built to stop.
 */
describe('canonicalizeLabelEdgeTargets — C-2 (finding 25)', () => {
  it('rewrites a lowercase $Label-derived references target to the vaulted label id', () => {
    const nodes = [makeLabel('Welcome_Message'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomLabel:welcome_message', 'references', 'aura-definition-bundle'),
    ];
    canonicalizeLabelEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomLabel:Welcome_Message');
  });

  it('leaves an exact-match target untouched (no rewrite churn)', () => {
    const nodes = [makeLabel('Welcome_Message'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomLabel:Welcome_Message', 'references', 'aura-definition-bundle'),
    ];
    const before = edges[0];
    canonicalizeLabelEdgeTargets(nodes, edges);
    expect(edges[0]).toBe(before);
  });

  it('leaves an unknown label dangling — absence is preserved, never guessed', () => {
    const nodes = [makeLabel('Welcome_Message'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomLabel:No_Such_Label', 'references', 'aura-definition-bundle'),
    ];
    canonicalizeLabelEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomLabel:No_Such_Label');
  });

  it('ignores non-CustomLabel targets', () => {
    const nodes = [makeLabel('Welcome_Message'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomObject:account')];
    canonicalizeLabelEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomObject:account');
  });
});

/**
 * C-2 (finding 25) — StaticResource edge-target case canonicalization.
 * Mirrors the CustomLabel fix above for `$Resource.bar` tokens.
 */
describe('canonicalizeResourceEdgeTargets — C-2 (finding 25)', () => {
  it('rewrites a lowercase $Resource-derived references target to the vaulted resource id', () => {
    const nodes = [makeResource('CompanyLogo'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('StaticResource:companylogo', 'references', 'visualforce-page'),
    ];
    canonicalizeResourceEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('StaticResource:CompanyLogo');
  });

  it('leaves an exact-match target untouched (no rewrite churn)', () => {
    const nodes = [makeResource('CompanyLogo'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('StaticResource:CompanyLogo', 'references', 'visualforce-page'),
    ];
    const before = edges[0];
    canonicalizeResourceEdgeTargets(nodes, edges);
    expect(edges[0]).toBe(before);
  });

  it('leaves an unknown resource dangling — absence is preserved, never guessed', () => {
    const nodes = [makeResource('CompanyLogo'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('StaticResource:No_Such_Resource', 'references', 'visualforce-page'),
    ];
    canonicalizeResourceEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('StaticResource:No_Such_Resource');
  });

  it('drops an ambiguous lower-key (two ids differing only by case) — never guesses', () => {
    const nodes = [makeResource('Logo'), makeResource('LOGO'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('StaticResource:logo', 'references', 'visualforce-page'),
    ];
    canonicalizeResourceEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('StaticResource:logo');
  });
});

/**
 * R7-W3 regression — the two canonicalizers operate on disjoint id prefixes
 * and must not interfere when run in the same pipeline order as
 * `importExtractionResults`/`computeChangeSet` (field pass, then object
 * pass).
 */
describe('canonicalizeFieldEdgeTargets + canonicalizeObjectEdgeTargets — combined pipeline', () => {
  it('remaps a dangling field edge and a dangling object edge independently, in either order', () => {
    const nodes = [makeField('Account', 'Industry__c'), makeObject('Account'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:account.industry__c'),
      fieldEdge('CustomObject:account', 'readsFrom', 'apex-scanner'),
    ];
    canonicalizeFieldEdgeTargets(nodes, edges);
    canonicalizeObjectEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Account.Industry__c');
    expect(edges[1]?.toId).toBe('CustomObject:Account');
  });

  it('CustomField behavior is unchanged when a CustomObject node is also present (no cross-prefix leakage)', () => {
    const nodes = [makeField('Account', 'Custom_Flag__c'), makeObject('Account'), makeClass('Q')];
    const edges: Edge[] = [fieldEdge('CustomField:account.custom_flag__c')];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Account.Custom_Flag__c');
  });
});
