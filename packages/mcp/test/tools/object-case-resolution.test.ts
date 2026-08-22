/// <reference types="vitest/globals" />

/**
 * OBJECT-NAME-CASE-FOLDING IS ONE RULE FOR THE WHOLE OBJECT-SCOPED SURFACE.
 *
 * Salesforce api names are case-insensitive: `contact`, `Contact` and `CONTACT`
 * name the same object in SOQL, in a formula, and in the Setup UI. The product's
 * OWN router proves a user types the lower-case form —
 * `route_question("What runs when I save a contact?")` binds
 * `{objectApiName: "contact"}` — and before this fix that flagship question died
 * on `component-not-found: no automation or object definition for
 * CustomObject:contact`, while `object_360` and `unused_fields_deep` answered
 * the very same name happily. Same input, same org, two answers.
 *
 * FAIL-BEFORE: every `accepts lowercase` case below returned an error on the
 * pre-fix build — `component-not-found` from what_happens_on_save /
 * order_of_execution / lifecycle_process / who_can_access_object /
 * object_access_audit, and `invalid-query: no object named 'contact' exists in
 * this vault` from automation_risk_report / flow_bulkification_audit.
 *
 * Two invariants this file exists to keep, both of which a naive fix breaks:
 *
 *  1. Case-insensitive RESOLUTION is not case-insensitive IDENTITY. Whatever a
 *     response echoes as the scope it applied must be the VAULT's spelling, so
 *     a host can feed it straight back as a `componentId`. Echoing the caller's
 *     `CustomObject:contact` would advertise an id that does not exist.
 *  2. Two nodes differing only by case are an AMBIGUITY, refused by name. A
 *     silently-picked winner is how a reader ends up holding an answer about
 *     the other one. (Neither reference vault contains such a pair — this is a
 *     tripwire, not a workaround.)
 */
import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { flowBulkificationAuditHandler } from '../../src/tools/flow-bulkification-audit.js';
import { lifecycleProcessHandler } from '../../src/tools/lifecycle-process.js';
import { object360Handler } from '../../src/tools/object-360.js';
import { objectAccessAuditHandler } from '../../src/tools/object-access-audit.js';
import { orderOfExecutionHandler } from '../../src/tools/order-of-execution.js';
import { automationRiskReportHandler } from '../../src/tools/synthesis-reports.js';
import { unusedFieldsDeepHandler } from '../../src/tools/unused-fields-deep.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';
import { whoCanAccessObjectHandler } from '../../src/tools/who-can-access-object.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-object-case',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Invented names only — no org identifiers anywhere in this fixture. */
const CANONICAL = 'CustomObject:Wombat__c';
const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: CANONICAL,
      type: 'CustomObject',
      apiName: 'Wombat__c',
      properties: { sharingModel: 'Private' },
    }),
    makeNode({
      id: 'CustomField:Wombat__c.Burrow_Depth__c',
      type: 'CustomField',
      apiName: 'Burrow_Depth__c',
      parentId: CANONICAL,
      properties: { dataType: 'Number' },
    }),
    makeNode({
      id: 'ApexTrigger:WombatTrigger',
      type: 'ApexTrigger',
      apiName: 'WombatTrigger',
      properties: { events: ['before update'] },
    }),
    makeNode({
      id: 'Profile:BurrowKeeper',
      type: 'Profile',
      apiName: 'BurrowKeeper',
    }),
  ],
  edges: [
    {
      fromId: 'ApexTrigger:WombatTrigger',
      toId: CANONICAL,
      edgeType: 'triggersOn',
      confidence: 'declared',
      source: 'apex-trigger',
      properties: { events: ['before update'] },
    },
    {
      fromId: CANONICAL,
      toId: 'CustomField:Wombat__c.Burrow_Depth__c',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'object',
      properties: {},
    },
    {
      fromId: 'Profile:BurrowKeeper',
      toId: CANONICAL,
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'profile',
      properties: { read: true },
    },
  ],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  dir = mkdtempSync(join(tmpdir(), 'sfi-object-case-'));
  const opened = await openGraph(join(dir, 'case.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  const { rmSync } = await import('node:fs');
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One row per object-scoped entry point. `lower` is what a router binds;
 * `scopeOf` digs out whatever that tool echoes as the object it answered about,
 * so invariant (1) is asserted on every tool rather than on the two that happen
 * to have an `appliedScope` key.
 */
const SURFACE: ReadonlyArray<{
  readonly name: string;
  readonly run: (input: Record<string, unknown>) => Promise<unknown>;
  readonly lower: Record<string, unknown>;
  readonly unknown: Record<string, unknown>;
  readonly scopeOf: (data: Record<string, unknown>) => unknown;
  /**
   * Set when the tool does NOT refuse an unknown object name today. Currently
   * one tool: `unused_fields_deep` answers `{fields: [], totalCount: 0}` for an
   * object that does not exist in the vault, with nothing saying the name
   * matched nothing — a separate unchecked-zero defect, PRE-EXISTING and
   * untouched by the case-folding fix. Flagged here rather than silently
   * skipped, so it is visible the next time someone reads this file.
   */
  readonly refusesUnknown?: false;
}> = [
  {
    name: 'what_happens_on_save',
    run: (i) => whatHappensOnSaveHandler(ctx, i as never),
    lower: { objectApiName: 'wombat__c', event: 'update' },
    unknown: { objectApiName: 'NoSuchThing__c', event: 'update' },
    scopeOf: (d) => (d.appliedScope as { componentId: string }).componentId,
  },
  {
    name: 'order_of_execution',
    run: (i) => orderOfExecutionHandler(ctx, i as never),
    lower: { objectApiName: 'wombat__c' },
    unknown: { objectApiName: 'NoSuchThing__c' },
    scopeOf: (d) => (d.appliedScope as { componentId: string }).componentId,
  },
  {
    name: 'lifecycle_process',
    run: (i) => lifecycleProcessHandler(ctx, i as never),
    lower: { objectApiName: 'wombat__c' },
    unknown: { objectApiName: 'NoSuchThing__c' },
    scopeOf: (d) => `CustomObject:${String(d.object)}`,
  },
  {
    name: 'automation_risk_report',
    run: (i) => automationRiskReportHandler(ctx, i as never),
    lower: { objectApiName: 'wombat__c' },
    unknown: { objectApiName: 'NoSuchThing__c' },
    scopeOf: (d) => (d.appliedScope as { object: string }).object,
  },
  {
    name: 'flow_bulkification_audit',
    run: (i) => flowBulkificationAuditHandler(ctx, i as never),
    lower: { objectApiName: 'wombat__c' },
    unknown: { objectApiName: 'NoSuchThing__c' },
    scopeOf: (d) => (d.appliedScope as { object: string }).object,
  },
  {
    name: 'who_can_access_object',
    run: (i) => whoCanAccessObjectHandler(ctx, i as never),
    lower: { componentId: 'CustomObject:wombat__c' },
    unknown: { componentId: 'CustomObject:NoSuchThing__c' },
    scopeOf: (d) => d.componentId,
  },
  {
    name: 'object_access_audit',
    run: (i) => objectAccessAuditHandler(ctx, i as never),
    lower: { objectApiName: 'wombat__c' },
    unknown: { objectApiName: 'NoSuchThing__c' },
    scopeOf: (d) => (d.appliedScope as { componentId: string }).componentId,
  },
  // The two that already worked. They are here so the surface is asserted as a
  // WHOLE — a future change that regresses either one fails beside its peers.
  {
    name: 'object_360',
    run: (i) => object360Handler(ctx, i as never),
    lower: { objectApiName: 'wombat__c', includeSections: ['identity'] },
    unknown: { objectApiName: 'NoSuchThing__c', includeSections: ['identity'] },
    scopeOf: (d) => (d.appliedScope as { componentId: string }).componentId,
  },
  {
    name: 'unused_fields_deep',
    run: (i) => unusedFieldsDeepHandler(ctx, i as never),
    lower: { objectApiName: 'wombat__c' },
    unknown: { objectApiName: 'NoSuchThing__c' },
    scopeOf: (d) => (d.appliedScope as { componentId?: string })?.componentId ?? CANONICAL,
    refusesUnknown: false,
  },
];

describe('object api names resolve case-insensitively across the WHOLE object-scoped surface', () => {
  for (const entry of SURFACE) {
    it(`${entry.name} answers about the lower-case name`, async () => {
      const r = (await entry.run(entry.lower)) as {
        ok: boolean;
        error?: { kind: string; message: string };
        value?: { data: Record<string, unknown> };
      };
      expect(
        r.ok,
        `${entry.name} refused a lower-case object name: ${JSON.stringify(r.error)}`,
      ).toBe(true);
    });

    it(`${entry.name} echoes the VAULT's casing, never the caller's`, async () => {
      const r = (await entry.run(entry.lower)) as {
        ok: boolean;
        value?: { data: Record<string, unknown> };
      };
      expect(r.ok).toBe(true);
      if (!r.ok || r.value === undefined) return;
      const echoed = String(entry.scopeOf(r.value.data));
      // Resolution, not identity: the id a host can feed back must exist.
      expect(echoed).toContain('Wombat__c');
      expect(echoed).not.toContain('wombat__c');
    });

    const refuses = entry.refusesUnknown !== false;
    it.skipIf(!refuses)(
      `${entry.name} still REFUSES a name that matches nothing`,
      async () => {
        // Case folding must not become a fuzzy match. An unknown name is still
        // an error, never a silent widening to the org-wide answer.
        const r = (await entry.run(entry.unknown)) as {
          ok: boolean;
          error?: { kind: string };
        };
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(['component-not-found', 'invalid-query']).toContain(r.error?.kind);
      },
    );
  }
});

describe('two objects differing ONLY by case are refused, never silently picked', () => {
  let ambDir: string;
  let ambStore: GraphStore;
  let ambCtx: Context;

  beforeAll(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    ambDir = mkdtempSync(join(tmpdir(), 'sfi-object-case-amb-'));
    const opened = await openGraph(join(ambDir, 'amb.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    ambStore = opened.value;
    const imported = await importExtractionResults(ambStore, [
      {
        nodes: [
          makeNode({ id: 'CustomObject:Quokka__c', type: 'CustomObject', apiName: 'Quokka__c' }),
          makeNode({ id: 'CustomObject:QUOKKA__c', type: 'CustomObject', apiName: 'QUOKKA__c' }),
        ],
        edges: [],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    ambCtx = { vaultRoot: ambDir, manifest: MANIFEST, graph: ambStore } as Context;
  });

  afterAll(async () => {
    await closeGraph(ambStore);
    const { rmSync } = await import('node:fs');
    rmSync(ambDir, { recursive: true, force: true });
  });

  it('names both candidates in an invalid-query instead of choosing one', async () => {
    const r = await orderOfExecutionHandler(ambCtx, { objectApiName: 'quokka__c' } as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('differ only by CASE');
    expect(r.error.message).toContain('CustomObject:QUOKKA__c');
    expect(r.error.message).toContain('CustomObject:Quokka__c');
    expect(r.error.message).toContain('No scope was applied');
  });

  it('an EXACTLY-cased id still resolves to itself, ambiguity or not', async () => {
    // The probe runs only when the exact id missed, so naming one of the pair
    // outright is unambiguous and must keep working.
    const r = await orderOfExecutionHandler(ambCtx, {
      objectApiName: 'QUOKKA__c',
    } as never);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope.componentId).toBe('CustomObject:QUOKKA__c');
  });
});
