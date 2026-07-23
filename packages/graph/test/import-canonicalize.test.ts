/// <reference types="vitest/globals" />

import type { Edge, Node } from '@sf-intelligence/contracts';

import {
  canonicalizeActivityPolymorphicFieldEdgeTargets,
  canonicalizeApexCallEdgeTargets,
  canonicalizeFieldEdgeTargets,
  canonicalizeLabelEdgeTargets,
  canonicalizeObjectEdgeTargets,
  canonicalizeResourceEdgeTargets,
  mintPolymorphicActivityFieldEdges,
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
 * D2 — polymorphic Activity-base field alias. Salesforce Activity CUSTOM
 * fields live on the `Activity` object and are SHARED by its polymorphic
 * children `Task`/`Event`. When Apex writes `someTask.Foo__c = …`, the write
 * edge is keyed on the RECEIVER type (`Task`), projecting to a dangling
 * `CustomField:Task.Foo__c` that never attaches to the real
 * `CustomField:Activity.Foo__c`. The case-only remap can't bridge it
 * (`task` ≠ `activity`), so `safe_to_delete_field` reads the Activity field as
 * unreferenced and a blocking `writesTo` flips to a false "safe to delete".
 */
describe('canonicalizeActivityPolymorphicFieldEdgeTargets — D2', () => {
  it('remaps a dangling CustomField:Task.<field> writesTo onto the shared Activity field', () => {
    const nodes = [makeField('Activity', 'Foo__c'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Foo__c', 'writesTo', 'apex-ast'),
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Activity.Foo__c');
  });

  it('remaps a dangling CustomField:Event.<field> readsFrom onto the shared Activity field', () => {
    const nodes = [makeField('Activity', 'Foo__c'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:Event.Foo__c', 'readsFrom', 'apex-ast'),
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Activity.Foo__c');
  });

  it('remaps BOTH writesTo and readsFrom to the Activity field in one pass', () => {
    const nodes = [makeField('Activity', 'Foo__c'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Foo__c', 'writesTo', 'apex-ast'),
      fieldEdge('CustomField:Event.Foo__c', 'readsFrom', 'apex-ast'),
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Activity.Foo__c');
    expect(edges[1]?.toId).toBe('CustomField:Activity.Foo__c');
  });

  it('PRECISION: a dangling Task field with NO matching Activity field is NOT remapped (stays as-is)', () => {
    // Bar__c exists on Activity nowhere in the graph, so the "Activity node
    // exists" guard keeps the Task-own field target untouched — a standard
    // Task field is never mis-attributed to Activity.
    const nodes = [makeField('Activity', 'Foo__c'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Bar__c', 'writesTo', 'apex-ast'),
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Task.Bar__c');
  });

  it('does NOT remap a Task field target that resolves to a real Task node (exact match is final)', () => {
    // A genuine Task-own custom field modeled as its own node must win over the
    // Activity alias — only DANGLING targets are ever remapped.
    const nodes = [
      makeField('Activity', 'Foo__c'),
      makeField('Task', 'Foo__c'),
      makeClass('Q'),
    ];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Foo__c', 'writesTo', 'apex-ast'),
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Task.Foo__c');
  });

  it('leaves a non-Activity dangling field (Account) untouched', () => {
    const nodes = [makeField('Activity', 'Foo__c'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:Account.Foo__c', 'writesTo', 'apex-ast'),
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Account.Foo__c');
  });

  it('matches the Task/Event object and field case-insensitively', () => {
    const nodes = [makeField('Activity', 'Foo__c'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:TASK.foo__c', 'writesTo', 'apex-scanner'),
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Activity.Foo__c');
  });

  it('drops an ambiguous Activity case collision — never guesses', () => {
    // Impossible on real metadata (field API names are case-insensitive unique
    // per object) but guarded defensively.
    const nodes = [
      makeField('Activity', 'Foo__c'),
      makeField('Activity', 'FOO__c'),
      makeClass('Q'),
    ];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.foo__c', 'writesTo', 'apex-ast'),
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Task.foo__c');
  });

  it('preserves edge properties verbatim on rewrite (the raw receiver-path evidence stays)', () => {
    const nodes = [makeField('Activity', 'Foo__c'), makeClass('Q')];
    const edges: Edge[] = [
      {
        ...fieldEdge('CustomField:Task.Foo__c', 'writesTo', 'apex-ast'),
        properties: { path: 'someTask.Foo__c', receiver: 'Task' },
      },
    ];
    canonicalizeActivityPolymorphicFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Activity.Foo__c');
    expect(edges[0]?.properties).toEqual({
      path: 'someTask.Foo__c',
      receiver: 'Task',
    });
  });

  it('is applied by canonicalizeFieldEdgeTargets (the import entry point) after the case-fold pass', () => {
    const nodes = [makeField('Activity', 'Foo__c'), makeClass('Q')];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Foo__c', 'writesTo', 'apex-ast'),
    ];
    canonicalizeFieldEdgeTargets(nodes, edges);
    expect(edges[0]?.toId).toBe('CustomField:Activity.Foo__c');
  });
});

/**
 * D2 — polymorphic Activity-field MIRROR. When an activity custom field is
 * sourced from the offline `sobject describe` snapshot there is NO `Activity`
 * base node: the same field is materialized as BOTH `CustomField:Task.<field>`
 * and `CustomField:Event.<field>`. Apex writing it through a `Task` receiver
 * attaches its `writesTo` only to the Task sibling, so querying the Event
 * sibling walks zero dependencies and reads a false safe. The mirror mints the
 * missing edge onto the other existing sibling(s).
 */
describe('mintPolymorphicActivityFieldEdges — D2 (describe-snapshot siblings)', () => {
  it('mirrors a Task-sibling writesTo onto the Event sibling of the same shared field', () => {
    // Both siblings exist, NO Activity base node — the describe-snapshot shape.
    const nodes = [
      makeField('Task', 'Foo__c'),
      makeField('Event', 'Foo__c'),
      makeClass('Writer'),
    ];
    const edges: Edge[] = [
      {
        fromId: 'ApexClass:Writer',
        toId: 'CustomField:Task.Foo__c' as Edge['toId'],
        edgeType: 'writesTo',
        confidence: 'parsed',
        source: 'apex-ast',
        properties: { path: 'someTask.Foo__c' },
      },
    ];
    mintPolymorphicActivityFieldEdges(nodes, edges);
    // The original Task edge is untouched; a mirrored Event edge is minted.
    expect(edges).toHaveLength(2);
    const mirrored = edges.find((e) => e.toId === 'CustomField:Event.Foo__c');
    expect(mirrored).toBeDefined();
    expect(mirrored?.fromId).toBe('ApexClass:Writer');
    expect(mirrored?.edgeType).toBe('writesTo');
    expect(mirrored?.confidence).toBe('heuristic');
    expect(mirrored?.source).toBe('graph-activity-polymorphic');
    expect(mirrored?.properties['polymorphicMirror']).toBe(true);
    expect(mirrored?.properties['mirroredFrom']).toBe('CustomField:Task.Foo__c');
    // The original edge is left exactly as-is (raw evidence preserved).
    expect(edges[0]?.toId).toBe('CustomField:Task.Foo__c');
    expect(edges[0]?.confidence).toBe('parsed');
  });

  it('mirrors across all three representations when Activity, Task and Event all exist', () => {
    const nodes = [
      makeField('Activity', 'Foo__c'),
      makeField('Task', 'Foo__c'),
      makeField('Event', 'Foo__c'),
      makeClass('Writer'),
    ];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Foo__c', 'writesTo', 'apex-ast'),
    ];
    mintPolymorphicActivityFieldEdges(nodes, edges);
    const targets = new Set(edges.map((e) => e.toId));
    expect(targets).toContain('CustomField:Activity.Foo__c');
    expect(targets).toContain('CustomField:Event.Foo__c');
    expect(edges).toHaveLength(3); // original Task + Activity + Event
  });

  it('PRECISION: does NOT mirror a field that exists on only ONE polymorphic representation', () => {
    // A Task-own field (no Event / Activity sibling) is never treated as shared.
    const nodes = [makeField('Task', 'Bar__c'), makeClass('Writer')];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Bar__c', 'writesTo', 'apex-ast'),
    ];
    mintPolymorphicActivityFieldEdges(nodes, edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.toId).toBe('CustomField:Task.Bar__c');
  });

  it('does not mirror grantedBy or parentOf (per-sibling edges, not shared references)', () => {
    const nodes = [
      makeField('Task', 'Foo__c'),
      makeField('Event', 'Foo__c'),
      { ...makeClass('PS'), id: 'PermissionSet:PS', type: 'PermissionSet' as const, apiName: 'PS' },
    ];
    const edges: Edge[] = [
      {
        fromId: 'PermissionSet:PS',
        toId: 'CustomField:Task.Foo__c' as Edge['toId'],
        edgeType: 'grantedBy',
        confidence: 'declared',
        source: 'permission-set-extractor',
        properties: {},
      },
    ];
    mintPolymorphicActivityFieldEdges(nodes, edges);
    expect(edges).toHaveLength(1); // grantedBy is not mirrored
  });

  it('does not duplicate an edge the Event sibling already has', () => {
    const nodes = [
      makeField('Task', 'Foo__c'),
      makeField('Event', 'Foo__c'),
      makeClass('Writer'),
    ];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Foo__c', 'writesTo', 'apex-ast'),
      // The Event sibling already carries an equivalent write from the same class.
      fieldEdge('CustomField:Event.Foo__c', 'writesTo', 'apex-ast'),
    ];
    mintPolymorphicActivityFieldEdges(nodes, edges);
    // No new edge minted — both real edges already exist (dedup on from/to/type).
    expect(edges).toHaveLength(2);
    expect(edges.filter((e) => e.source === 'graph-activity-polymorphic')).toHaveLength(0);
  });

  it('is idempotent — re-running mints no additional edges', () => {
    const nodes = [
      makeField('Task', 'Foo__c'),
      makeField('Event', 'Foo__c'),
      makeClass('Writer'),
    ];
    const edges: Edge[] = [
      fieldEdge('CustomField:Task.Foo__c', 'writesTo', 'apex-ast'),
    ];
    mintPolymorphicActivityFieldEdges(nodes, edges);
    const afterFirst = edges.length;
    mintPolymorphicActivityFieldEdges(nodes, edges);
    expect(edges.length).toBe(afterFirst);
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
