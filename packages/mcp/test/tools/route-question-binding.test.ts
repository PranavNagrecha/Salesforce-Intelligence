/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { bindQuestionLiterals } from '../../src/tools/entity-arg-binding.js';
import { routeQuestionHandler } from '../../src/tools/route-question.js';

/**
 * ROUTE-01 / FR-04 / DEV-02 / DEV-03 / ROUTE-07 / ROUTE-10 — FAIL-BEFORE/PASS-AFTER.
 *
 * route_question resolved the named component (entityEvidence 'exact') and then
 * handed the host every recommended call with EMPTY args (or the raw label
 * 'Invoice' instead of Invoice__c, or junk like 'figure' as the object), so the
 * first call failed invalid-query. A `Class.method` reference raised a false
 * PREMISE CHECK. These pin the first-turn contract: the resolved component is
 * bound under each tool's own declared key, never junk, never `resolve {}`.
 */

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'binding-fixture',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:binding-fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
  type: 'CustomObject',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Invoice__c', apiName: 'Invoice__c', label: 'Invoice' }),
    node({
      id: 'CustomField:Invoice__c.Amount__c',
      type: 'CustomField',
      apiName: 'Amount__c',
      label: 'Amount',
      parentId: 'CustomObject:Invoice__c',
    }),
    node({
      id: 'CustomField:Invoice__c.Billing_Stage__c',
      type: 'CustomField',
      apiName: 'Billing_Stage__c',
      label: 'Billing Stage',
      parentId: 'CustomObject:Invoice__c',
    }),
    node({ id: 'CustomObject:Project__c', apiName: 'Project__c', label: 'Project' }),
    node({ id: 'ApexClass:InvoiceService', type: 'ApexClass', apiName: 'InvoiceService' }),
    node({ id: 'ApexTrigger:InvoiceTrigger', type: 'ApexTrigger', apiName: 'InvoiceTrigger' }),
    node({ id: 'Flow:Invoice_Approval', type: 'Flow', apiName: 'Invoice_Approval', label: 'Invoice Approval' }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;
const prevLive = process.env['SFI_LIVE_PLANE_ENABLED'];

beforeAll(async () => {
  delete process.env['SFI_LIVE_PLANE_ENABLED'];
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-route-bind-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  if (prevLive !== undefined) process.env['SFI_LIVE_PLANE_ENABLED'] = prevLive;
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

type Data = Awaited<ReturnType<typeof routeQuestionHandler>> extends infer R
  ? R extends { ok: true; value: { data: infer D } }
    ? D
    : never
  : never;

const route = async (question: string): Promise<Data> => {
  const r = await routeQuestionHandler(ctx, { question, logGap: false });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.data;
};

const argsFor = (d: Data, tool: string): Readonly<Record<string, unknown>> | undefined =>
  d.toolCandidates?.find((c) => c.tool === tool)?.suggestedArgs;

const invokeArgsFor = (d: Data, tool: string): Readonly<Record<string, unknown>> | undefined => {
  for (const step of d.invoke ?? []) {
    if (step.tool === tool) return step.args;
    const inner = step.args as { readonly name?: string; readonly args?: Record<string, unknown> };
    if (step.tool === 'sfi.run_analysis' && inner.name === tool) return inner.args;
  }
  return undefined;
};

describe('route_question binds the resolved entity on the first turn', () => {
  it('binds the exact field into safe_to_delete_field (fieldId) and never emits resolve {}', async () => {
    const d = await route('can I safely delete Invoice__c.Amount__c?');
    expect(d.entityEvidence?.disposition).toBe('exact');
    expect(argsFor(d, 'sfi.safe_to_delete_field')).toMatchObject({
      fieldId: 'CustomField:Invoice__c.Amount__c',
    });
    expect(invokeArgsFor(d, 'sfi.safe_to_delete_field')).toMatchObject({
      fieldId: 'CustomField:Invoice__c.Amount__c',
    });
    expect(
      (d.invoke ?? []).some((s) => s.tool === 'sfi.resolve' && Object.keys(s.args).length === 0),
    ).toBe(false);
  });

  it('a label-named object binds its API name, not the label (FR-04)', async () => {
    const d = await route('What happens when I save an Invoice?');
    const args = argsFor(d, 'sfi.what_happens_on_save') ?? invokeArgsFor(d, 'sfi.what_happens_on_save');
    expect(args?.['objectApiName']).toBe('Invoice__c');
    // "save" is insert OR update — not update only.
    expect(args?.['event']).toBe('upsert');
  });

  it('never binds a prose word as the object (A01 "figure", DEV-02 "same")', async () => {
    const d = await route('what all runs when an invoice gets saved? trying to figure out the order');
    for (const c of d.toolCandidates ?? []) {
      expect(c.suggestedArgs?.['objectApiName']).not.toBe('figure');
    }
    expect(d.route.suggestedArgs?.['objectApiName']).not.toBe('figure');
  });

  it('Class.method resolves the class (no false PREMISE CHECK) and binds the method (DEV-03)', async () => {
    const d = await route('Who calls InvoiceService.calculateTotals?');
    expect(d.route.reason).not.toContain('PREMISE CHECK');
    expect(d.entityEvidence?.candidates[0]?.componentId).toBe('ApexClass:InvoiceService');
    expect(argsFor(d, 'sfi.call_graph')).toMatchObject({
      rootId: 'ApexClass:InvoiceService',
      method: 'calculateTotals',
    });
  });

  it('binds a trigger under the tool’s own key (triggerId)', async () => {
    const d = await route('what if I turn off the InvoiceTrigger trigger');
    const args =
      argsFor(d, 'sfi.what_if_disable_trigger') ?? invokeArgsFor(d, 'sfi.what_if_disable_trigger');
    expect(args).toMatchObject({ triggerId: 'ApexTrigger:InvoiceTrigger' });
  });

  it('an object never lands in a field-only tool’s id slot', async () => {
    const d = await route('who can see the Invoice__c object');
    const fieldAudit = argsFor(d, 'sfi.field_access_audit');
    expect(fieldAudit?.['componentId']).toBeUndefined();
    expect(fieldAudit?.['fieldId']).toBeUndefined();
  });

  it('a required arg it could not bind is named, not silently empty', async () => {
    const d = await route('what breaks if I remove a value from a picklist');
    const row = d.toolCandidates?.find((c) => c.tool === 'sfi.what_if_remove_picklist_value');
    if (row !== undefined) expect(row.missingArgs).toEqual(expect.arrayContaining(['fieldId']));
  });
});

describe('type-correct binding and routing', () => {
  it('a junk regex object never raises a false premise check; the vault finds the real object', async () => {
    const d = await route('what all runs when an invoice gets saved? trying to figure out the order');
    expect(d.route.reason).not.toContain("'figure'");
    expect(d.route.suggestedArgs?.['objectApiName']).toBe('Invoice__c');
  });

  it('a tool whose name names another family never gets the entity in its generic id', async () => {
    const d = await route('explain the Invoice_Approval flow');
    for (const c of d.toolCandidates ?? []) {
      if (/^sfi\.app_|^sfi\.omni/.test(c.tool)) {
        expect(c.suggestedArgs?.['componentId']).toBeUndefined();
      }
    }
    expect(argsFor(d, 'sfi.explain_flow')).toMatchObject({ flowId: 'Flow:Invoice_Approval' });
  });

  it('an object-access question swaps the field-only audit for object access tools (ROUTE-04)', async () => {
    const d = await route('who can see the Invoice__c object');
    if (d.route.tools.length > 0 && d.route.intent === 'field-access') {
      expect(d.route.tools).not.toContain('sfi.field_access_audit');
      expect(d.route.tools).toContain('sfi.who_can_access_object');
    }
    expect(argsFor(d, 'sfi.who_can_access_object')).toMatchObject({
      componentId: 'CustomObject:Invoice__c',
    });
  });
});

describe('ranking hygiene', () => {
  it('with the live plane off, no live-only tool leads the shortlist (ROUTE-07)', async () => {
    const d = await route('list all the scheduled apex jobs');
    const cands = d.toolCandidates ?? [];
    const firstLive = cands.findIndex((c) => c.liveRequired);
    const lastVault = cands.map((c) => c.liveRequired).lastIndexOf(false);
    if (firstLive !== -1) expect(firstLive).toBeGreaterThan(lastVault);
  });

  it('the no-arg refresh delta outranks changed_since, which needs `since` (ROUTE-11)', async () => {
    const d = await route('what changed since the last refresh');
    const tools = (d.toolCandidates ?? []).map((c) => c.tool);
    const delta = tools.indexOf('sfi.what_changed_since_refresh');
    expect(delta).not.toBe(-1);
    const since = tools.indexOf('sfi.changed_since');
    if (since !== -1) expect(delta).toBeLessThan(since);
    expect(d.route.tools).toContain('sfi.diff_snapshots');
  });

  it('a stacked complement never outranks a high-confidence route primary (ROUTE-02)', async () => {
    const d = await route('can I safely delete Invoice__c.Amount__c?');
    const cands = d.toolCandidates ?? [];
    const primary = d.route.tools.find((t) => t !== 'sfi.resolve');
    if (d.route.confidence === 'high' && primary !== undefined) {
      const p = cands.findIndex((c) => c.tool === primary);
      const interp = cands.findIndex((c) => c.tool === 'sfi.interpret');
      if (p !== -1 && interp !== -1) expect(p).toBeLessThan(interp);
    }
  });
});

/**
 * ROUTE-06 — FAIL-BEFORE/PASS-AFTER. The generic impact rule (/what breaks|impact/)
 * matched first and swallowed specific what-if questions; "the X picklist" yielded
 * no entity at all; and the quoted value / target type the user stated was never
 * bound, so even a correctly ranked what-if tool failed invalid-query.
 */
describe('specific what-if questions route and bind (ROUTE-06)', () => {
  it('removing a quoted value from a named picklist binds fieldId + value', async () => {
    const d = await route("what breaks if I remove 'Former Member' from the Billing Stage picklist on invoice");
    expect(d.route.intent).toBe('what-if-remove-picklist-value');
    expect(d.entityEvidence?.candidates[0]?.componentId).toBe('CustomField:Invoice__c.Billing_Stage__c');
    expect(argsFor(d, 'sfi.what_if_remove_picklist_value')).toMatchObject({
      fieldId: 'CustomField:Invoice__c.Billing_Stage__c',
      value: 'Former Member',
    });
  });

  it('a from-<type>-to-<type> change routes to the field-type what-if and binds newType', async () => {
    const d = await route('impact of changing Invoice__c.Amount__c from currency to number');
    expect(d.route.intent).toBe('what-if-change-field-type');
    expect(argsFor(d, 'sfi.what_if_change_field_type')).toMatchObject({
      fieldId: 'CustomField:Invoice__c.Amount__c',
      newType: 'Number',
    });
  });

  it('literal binding is schema-derived and unsure means unbound', () => {
    const tool = 'sfi.what_if_remove_picklist_value';
    // an apostrophe never opens a literal
    expect(bindQuestionLiterals(tool, {}, "what's the impact of removing 'Gold' from it")).toEqual({ value: 'Gold' });
    // two literals: ambiguous, left unbound
    expect(bindQuestionLiterals(tool, {}, "remove 'Gold' and 'Silver'")['value']).toBeUndefined();
    // a quoted COMPONENT name ("the 'Tier' picklist") is not a value
    expect(bindQuestionLiterals(tool, {}, "remove a value from the 'Tier' picklist")['value']).toBeUndefined();
    // never overwrites a caller-set arg
    expect(bindQuestionLiterals(tool, { value: 'X' }, "remove 'Gold'")).toEqual({ value: 'X' });
    // enum: exactly one stated target type
    expect(bindQuestionLiterals('sfi.what_if_change_field_type', {}, 'change it to long text area')['newType']).toBe('LongTextArea');
    expect(bindQuestionLiterals('sfi.what_if_change_field_type', {}, 'change it')['newType']).toBeUndefined();
  });

  it('FAIL-BEFORE/PASS-AFTER: a quoted literal binds only a REQUIRED value arg, never a write-side annotation', () => {
    // lifecycle_process declares an OPTIONAL value — a stray quote must not scope it.
    expect(bindQuestionLiterals('sfi.lifecycle_process', {}, "how does the 'Gold' tier move")['value']).toBeUndefined();
    // propose_annotation is a write — never pre-fill what it would record.
    expect(bindQuestionLiterals('sfi.propose_annotation', {}, "mark it 'deprecated'")['value']).toBeUndefined();
  });
});

/**
 * A04 / ROUTE-08 — FAIL-BEFORE/PASS-AFTER. "what does Class.method do?" matched
 * no rule: the class resolved exact and the method was parsed, yet the host got
 * an EMPTY shortlist. The tools that take a method (derived from their schemas)
 * are now offered, bound, at low confidence.
 */
describe('an unrouted Class.method question still gets bound method tools', () => {
  it('offers explain_apex_method bound to the class + method', async () => {
    const d = await route('what does InvoiceService.calculateTotals do?');
    expect(d.route.reason).not.toContain('PREMISE CHECK');
    expect(d.toolCandidates?.length ?? 0).toBeGreaterThan(0);
    expect(argsFor(d, 'sfi.explain_apex_method')).toMatchObject({
      classApiName: 'InvoiceService',
      methodName: 'calculateTotals',
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: its invoke is the bound method tools, not the generic fallback (ROUTE-09)', async () => {
    const d = await route('what does InvoiceService.calculateTotals do?');
    expect(d.route.intent).toBe('unrouted');
    expect(invokeArgsFor(d, 'sfi.explain_apex_method')).toMatchObject({
      classApiName: 'InvoiceService',
      methodName: 'calculateTotals',
    });
    expect((d.invoke ?? []).some((s) => s.tool === 'sfi.capabilities')).toBe(false);
  });
});

/**
 * ROUTE-09 / ROUTE-04 — FAIL-BEFORE/PASS-AFTER. `invoke` is documented as the
 * calls to run, yet a step whose required args were never bound carried no
 * signal; and the field-only access audit came back through the funnel, unscoped,
 * on an object-access question.
 */
describe('invoke and candidates never pose as runnable when they are not', () => {
  it('an invoke step missing a required arg names it in missingArgs', async () => {
    const d = await route("what breaks if I remove 'Gold' from a picklist");
    const step = (d.invoke ?? []).find((s) => {
      const inner = s.args as { readonly name?: string };
      return s.tool === 'sfi.what_if_remove_picklist_value' || inner.name === 'sfi.what_if_remove_picklist_value';
    });
    expect(step).toBeDefined();
    expect(step?.missingArgs).toEqual(expect.arrayContaining(['fieldId']));
  });

  it('an object-access question never offers field_access_audit as a candidate', async () => {
    const d = await route('who can edit the Invoice__c object');
    expect((d.toolCandidates ?? []).map((c) => c.tool)).not.toContain('sfi.field_access_audit');
  });
});
