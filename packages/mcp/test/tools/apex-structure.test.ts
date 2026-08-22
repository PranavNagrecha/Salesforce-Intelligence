/// <reference types="vitest/globals" />

/**
 * Unit tests for the `sfi.apex_structure` MCP tool.
 *
 * A real DuckDB fixture graph seeds ApexClass / ApexTrigger nodes whose
 * `sourcePath` points at SYNTHETIC `.cls` / `.trigger` files written into a temp
 * vault, so the handler's on-demand `readFile(join(vaultRoot, sourcePath))`
 * resolves exactly as it does against a real vault. Every identifier in this
 * file is invented — zero org identifiers.
 *
 * The suite is organised around the CLAIMS, because the claims are the product:
 *
 *   - composition — the sharing block, entry points and covering tests come
 *     from the tools that already own them, not from a second implementation;
 *   - the eight AST-only review checks, each with a fixture that fires it AND
 *     (where the check is easy to get wrong) one that must NOT fire it;
 *   - the honesty spine — `structure: null` on a parse failure, `null` with a
 *     reason instead of `false`/`0`, `checked` on every zero-able section, the
 *     dynamic-Apex boundary, parsed-vs-heuristic confidence, and capped lists
 *     that keep their TRUE total through narrowing;
 *   - the strict input schema and the four error shapes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
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
  apexStructureHandler,
  apexStructureInputSchema,
  type ApexStructureOutput,
} from '../../src/tools/apex-structure.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.2.0',
  refreshedAt: '2026-06-01T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 6, ApexTrigger: 1 },
  edges: {},
  sourceTreeHash: 'sha256:apex-structure-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: 60,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'parsed',
  source: 'apex',
  properties: {},
  ...overrides,
});

/** The v1.5 async / API-surface classifier bag every real ApexClass node carries. */
const CLASSIFIERS = {
  isQueueable: false,
  isSchedulable: false,
  isBatchable: false,
  hasFutureMethod: false,
  hasInvocableMethod: false,
  hasAuraEnabledMethod: false,
  isRestResource: false,
};

// ---------------------------------------------------------------------------
// synthetic sources
// ---------------------------------------------------------------------------

/**
 * The main fixture: an `@AuraEnabled` class with NO sharing keyword, a callout
 * and an async dispatch inside a loop body, DML before a callout, a discarded
 * partial-success result, an inline query assigned to a single sObject, dynamic
 * SOQL, and an inner class. One file, seven of the eight AST checks.
 */
const WIDGET_SERVICE_SRC = `public class WidgetService {
    public class Payload {
        public String name;
    }

    private static final Integer MAX = 5;

    @AuraEnabled(cacheable=true)
    public static List<Widget__c> lookup(String term) {
        Widget__c seed = [SELECT Id FROM Widget__c LIMIT 1];
        List<SObject> dyn = Database.query('SELECT Id FROM Widget__c');
        return null;
    }

    public static void fanOut(List<Id> ids, HttpRequest req) {
        for (Id i : ids) {
            Http h = new Http();
            HttpResponse res = h.send(req);
            System.enqueueJob(new WidgetJob(i));
        }
    }

    public static void saveThenCall(List<Widget__c> rows, HttpRequest req) {
        Database.insert(rows, false);
        Http client = new Http();
        HttpResponse res = client.send(req);
    }
}
`;

/** A clean class: `with sharing`, one bulk query, one bulk DML, no findings. */
const CLEAN_SERVICE_SRC = `public with sharing class CleanService {
    public static void run(List<Id> ids) {
        List<Widget__c> rows = [SELECT Id FROM Widget__c WHERE Id IN :ids];
        for (Widget__c w : rows) {
            w.Name = 'x';
        }
        update rows;
    }
}
`;

/** A trigger that does its own SOQL and DML instead of calling a handler. */
const WIDGET_TRIGGER_SRC = `trigger WidgetTrigger on Widget__c (after insert, after update) {
    List<Widget__c> rows = [SELECT Id FROM Widget__c WHERE Id IN :Trigger.newMap.keySet()];
    update rows;
}
`;

/** A trigger that delegates — the same rule must NOT fire here. */
const CLEAN_TRIGGER_SRC = `trigger CleanTrigger on Widget__c (after insert) {
    CleanService.run(new List<Id>(Trigger.newMap.keySet()));
}
`;

/** Deliberately unparseable — the `structure: null` path. */
const BROKEN_SRC = `public class BrokenService { public void go( { }
`;

/** A `without sharing` class with an @AuraEnabled method. */
const EXPOSED_SERVICE_SRC = `public without sharing class ExposedService {
    @AuraEnabled
    public static String peek() { return 'x'; }
}
`;

/** A large class used to prove the byte budget trims rather than blowing up. */
const HUGE_SERVICE_SRC = `public class HugeService {
${Array.from(
  { length: 300 },
  (_, i) =>
    `    public static String methodNumber${String(i)}(String argumentOne${String(i)}, Integer argumentTwo${String(i)}) { return argumentOne${String(i)}; }`,
).join('\n')}
}
`;

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexClass:WidgetService',
      apiName: 'WidgetService',
      sourcePath: 'source/classes/WidgetService.cls',
      properties: {
        ...CLASSIFIERS,
        hasAuraEnabledMethod: true,
        status: 'Active',
        isTest: false,
        lineCount: 28,
        sourceBytes: 900,
        modifiers: ['public'],
        qualityIssues: [
          {
            rule: 'dynamic-apex',
            severity: 'info',
            location: 'line 11',
            explanation: 'Uses dynamic SOQL (Database.query).',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    makeNode({
      id: 'ApexClass:CleanService',
      apiName: 'CleanService',
      sourcePath: 'source/classes/CleanService.cls',
      properties: {
        ...CLASSIFIERS,
        status: 'Active',
        isTest: false,
        lineCount: 9,
        sourceBytes: 200,
        modifiers: ['public', 'with sharing'],
        qualityIssues: [],
      },
    }),
    makeNode({
      id: 'ApexClass:ExposedService',
      apiName: 'ExposedService',
      sourcePath: 'source/classes/ExposedService.cls',
      properties: {
        ...CLASSIFIERS,
        hasAuraEnabledMethod: true,
        status: 'Active',
        isTest: false,
        modifiers: ['public', 'without sharing'],
        qualityIssues: [],
      },
    }),
    makeNode({
      id: 'ApexClass:BrokenService',
      apiName: 'BrokenService',
      sourcePath: 'source/classes/BrokenService.cls',
      properties: { ...CLASSIFIERS, status: 'Active', isTest: false },
    }),
    makeNode({
      id: 'ApexClass:HugeService',
      apiName: 'HugeService',
      sourcePath: 'source/classes/HugeService.cls',
      properties: { ...CLASSIFIERS, status: 'Active', isTest: false },
    }),
    // A pre-classifier vault node: no isQueueable/... keys at all.
    makeNode({
      id: 'ApexClass:LegacyService',
      apiName: 'LegacyService',
      sourcePath: 'source/classes/CleanService.cls',
      apiVersion: null,
      properties: {},
    }),
    makeNode({
      id: 'ApexClass:CleanServiceTest',
      apiName: 'CleanServiceTest',
      sourcePath: 'source/classes/CleanService.cls',
      properties: { ...CLASSIFIERS, isTest: true, status: 'Active' },
    }),
    makeNode({
      id: 'ApexTrigger:WidgetTrigger',
      type: 'ApexTrigger',
      apiName: 'WidgetTrigger',
      sourcePath: 'source/triggers/WidgetTrigger.trigger',
      properties: {
        ...CLASSIFIERS,
        status: 'Active',
        isTest: false,
        triggerObject: 'Widget__c',
        events: ['after insert', 'after update'],
      },
    }),
    makeNode({
      id: 'ApexTrigger:CleanTrigger',
      type: 'ApexTrigger',
      apiName: 'CleanTrigger',
      sourcePath: 'source/triggers/CleanTrigger.trigger',
      properties: {
        ...CLASSIFIERS,
        status: 'Active',
        isTest: false,
        triggerObject: 'Widget__c',
        events: ['after insert'],
      },
    }),
    makeNode({
      id: 'CustomField:Widget__c.Name',
      type: 'CustomField',
      apiName: 'Name',
      parentId: 'CustomObject:Widget__c',
      sourcePath: 'source/objects/Widget__c/fields/Name.field-meta.xml',
      properties: {},
    }),
  ],
  edges: [
    // A test class and a trigger reach CleanService.
    makeEdge({
      fromId: 'ApexClass:CleanServiceTest',
      toId: 'ApexClass:CleanService',
      edgeType: 'callsApex',
    }),
    makeEdge({
      fromId: 'ApexTrigger:CleanTrigger',
      toId: 'ApexClass:CleanService',
      edgeType: 'callsApex',
    }),
    // CleanService writes a field — the touches axis.
    makeEdge({
      fromId: 'ApexClass:CleanService',
      toId: 'CustomField:Widget__c.Name',
      edgeType: 'writesTo',
    }),
    // A heuristic edge whose receiver never resolved — must be segregated.
    makeEdge({
      fromId: 'ApexClass:CleanService',
      toId: 'CustomField:this.scratch',
      edgeType: 'readsFrom',
      confidence: 'heuristic',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-apex-structure-'));
  mkdirSync(join(tempDir, 'source/classes'), { recursive: true });
  mkdirSync(join(tempDir, 'source/triggers'), { recursive: true });
  const write = (rel: string, body: string): void =>
    writeFileSync(join(tempDir, rel), body, 'utf-8');
  write('source/classes/WidgetService.cls', WIDGET_SERVICE_SRC);
  write('source/classes/CleanService.cls', CLEAN_SERVICE_SRC);
  write('source/classes/ExposedService.cls', EXPOSED_SERVICE_SRC);
  write('source/classes/BrokenService.cls', BROKEN_SRC);
  write('source/classes/HugeService.cls', HUGE_SERVICE_SRC);
  write('source/triggers/WidgetTrigger.trigger', WIDGET_TRIGGER_SRC);
  write('source/triggers/CleanTrigger.trigger', CLEAN_TRIGGER_SRC);

  const opened = await openGraph(join(tempDir, 'apex-structure.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const run = async (
  input: Parameters<typeof apexStructureHandler>[1],
): Promise<ApexStructureOutput> => {
  const r = await apexStructureHandler(ctx, input);
  if (!r.ok) throw new Error(`handler failed: ${r.error.kind} ${r.error.message}`);
  return r.value.data;
};

const rules = (out: ApexStructureOutput): readonly string[] =>
  out.review.findings.items.map((f) => f.rule);

// ---------------------------------------------------------------------------

describe('apexStructureHandler — resolution', () => {
  it('resolves a bare name to an ApexClass and echoes the resolution', async () => {
    const d = await run({ classRef: 'WidgetService' });
    expect(d.classRef).toEqual({
      requested: 'WidgetService',
      resolvedForm: 'api-name',
      componentId: 'ApexClass:WidgetService',
      apiName: 'WidgetService',
      type: 'ApexClass',
    });
  });

  it('resolves a bare name that is a TRIGGER, not a class', async () => {
    const d = await run({ classRef: 'WidgetTrigger' });
    expect(d.classRef.componentId).toBe('ApexTrigger:WidgetTrigger');
    expect(d.classRef.type).toBe('ApexTrigger');
  });

  it('accepts a canonical id and reports resolvedForm accordingly', async () => {
    const d = await run({ classRef: 'ApexClass:CleanService' });
    expect(d.classRef.resolvedForm).toBe('canonical-id');
  });

  it('refuses a non-Apex Type: prefix as invalid-query, naming the right tool', async () => {
    const r = await apexStructureHandler(ctx, { classRef: 'Flow:Some_Flow' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('sfi.flow_graph');
  });

  it('returns component-not-found for an unknown name and names near misses', async () => {
    const r = await apexStructureHandler(ctx, { classRef: 'WidgetServic' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    // Disclosure over guessing: candidates are NAMED, never silently picked.
    expect(r.error.message).toContain('ApexClass:WidgetService');
  });
});

describe('apexStructureHandler — composed sections', () => {
  it('composes the sharing block, and reports NO keyword as null (not "without sharing")', async () => {
    const d = await run({ classRef: 'WidgetService' });
    expect(d.meta.sharing.declared).toBeNull();
    expect(d.meta.sharing.effectiveModel).toBe('inherits-caller');
    expect(d.meta.sharing.note).toContain('does NOT default to `without sharing`');
    expect(d.meta.sharingSource).toBe('parsed-source');
  });

  it('reads the declared sharing keyword from source when there is one', async () => {
    const d = await run({ classRef: 'CleanService' });
    expect(d.meta.sharing.declared).toBe('with sharing');
    expect(d.meta.sharing.effectiveModel).toBe('with sharing');
  });

  it('surfaces the declared entry-point surface from the parsed annotations', async () => {
    const d = await run({ classRef: 'WidgetService' });
    const kinds = d.entryPoints.declared.items.map((e) => e.kind);
    expect(kinds).toContain('aura-enabled');
    const aura = d.entryPoints.declared.items.find((e) => e.kind === 'aura-enabled')!;
    expect(aura.viaMember).toBe('lookup');
    expect(aura.confidence).toBe('parsed');
  });

  it('names a trigger entry point with its object and events', async () => {
    const d = await run({ classRef: 'WidgetTrigger' });
    const trig = d.entryPoints.declared.items.find((e) => e.kind === 'trigger')!;
    expect(trig.detail).toContain('Widget__c');
    expect(trig.detail).toContain('after insert');
    expect(d.meta.trigger).toEqual({
      object: 'Widget__c',
      events: ['after insert', 'after update'],
    });
  });

  it('composes covering tests and inbound callers from the graph', async () => {
    const d = await run({ classRef: 'CleanService' });
    expect(d.tests.checked).toBe(true);
    expect(d.tests.coveringTestClasses.items.map((t) => t.apiName)).toContain(
      'CleanServiceTest',
    );
    expect(d.entryPoints.inbound.items.map((c) => c.id)).toContain(
      'ApexTrigger:CleanTrigger',
    );
    expect(d.entryPoints.reachabilityVerdict).toBe('entry-point-reachable');
  });

  it('reports objects and fields touched, segregating an unresolved receiver', async () => {
    const d = await run({ classRef: 'CleanService' });
    expect(d.touches.checked).toBe(true);
    expect(d.touches.objects.items).toEqual([
      { object: 'Widget__c', access: 'write', fieldCount: 1 },
    ]);
    expect(d.touches.fields.items[0]?.confidence).toBe('parsed');
    // `this.scratch` is a raw token, never a component.
    expect(d.touches.unresolvedFieldAccess.items).toEqual(['this.scratch']);
  });

  it('mirrors the recognizer catalog verbatim, as heuristic, alongside parsed checks', async () => {
    const d = await run({ classRef: 'WidgetService' });
    const mirrored = d.review.findings.items.find((f) => f.rule === 'dynamic-apex')!;
    expect(mirrored.confidence).toBe('heuristic');
    expect(mirrored.source).toBe('code-quality-patterns');
    expect(mirrored.line).toBe(11);
    // And the tool's own checks are labelled differently.
    const own = d.review.findings.items.find((f) => f.rule === 'callout-in-loop')!;
    expect(own.confidence).toBe('parsed');
    expect(own.source).toBe('apex_structure');
    expect(d.review.summary.heuristic).toBeGreaterThan(0);
    expect(d.review.summary.parsed).toBeGreaterThan(0);
  });
});

describe('apexStructureHandler — the eight AST-only checks', () => {
  it('fires callout-in-loop, async-dispatch-in-loop, dml-before-callout, database-partial-result-discarded and soql-assigned-to-single-sobject', async () => {
    const found = rules(await run({ classRef: 'WidgetService' }));
    expect(found).toContain('callout-in-loop');
    expect(found).toContain('async-dispatch-in-loop');
    expect(found).toContain('dml-before-callout');
    expect(found).toContain('database-partial-result-discarded');
    expect(found).toContain('soql-assigned-to-single-sobject');
  });

  it('fires no-sharing-declared-on-entry-point when an entry point declares none', async () => {
    const found = rules(await run({ classRef: 'WidgetService' }));
    expect(found).toContain('no-sharing-declared-on-entry-point');
    expect(found).not.toContain('without-sharing-external-entry-point');
  });

  it('fires without-sharing-external-entry-point on a `without sharing` Aura class', async () => {
    const d = await run({ classRef: 'ExposedService' });
    const f = d.review.findings.items.find(
      (x) => x.rule === 'without-sharing-external-entry-point',
    )!;
    expect(f.severity).toBe('high');
    expect(f.confidence).toBe('declared');
    expect(f.explanation).toContain('aura-enabled');
  });

  it('fires trigger-logic-in-trigger-body only for the trigger that does its own work', async () => {
    expect(rules(await run({ classRef: 'WidgetTrigger' }))).toContain(
      'trigger-logic-in-trigger-body',
    );
    expect(rules(await run({ classRef: 'CleanTrigger' }))).not.toContain(
      'trigger-logic-in-trigger-body',
    );
  });

  it('fires NOTHING on a clean class, and says so as CHECKED rather than silent', async () => {
    const d = await run({ classRef: 'CleanService' });
    expect(d.review.findings.items).toEqual([]);
    expect(d.review.checked).toBe(true);
    expect(d.review.completeness).toBe('checked');
    // An empty list is only readable because the checks are NAMED.
    expect(d.review.rulesEvaluatedHere).toHaveLength(8);
    expect(d.review.rulesEvaluatedHere).toContain('callout-in-loop');
  });

  it('does not treat a bulk query + bulk DML class as a loop offender', async () => {
    const d = await run({ classRef: 'CleanService' });
    const soql = d.structure!.dataAccess.soql.items[0]!;
    expect(soql.inLoopBody).toBe(false);
    expect(d.structure!.dataAccess.dml.items[0]!.inLoopBody).toBe(false);
  });
});

describe('apexStructureHandler — the honesty spine', () => {
  it('yields structure: null on a parse failure, with a reason — never an empty structure', async () => {
    const d = await run({ classRef: 'BrokenService' });
    expect(d.parse.status).toBe('parse-failed');
    expect(d.structure).toBeNull();
    expect(d.parse.reason).toContain('structure is null rather than empty');
    expect(d.parse.errors.length).toBeGreaterThan(0);
    // The parse reason is also a stated boundary, not just a field.
    expect(d.boundaries.some((b) => b.includes('structure is null'))).toBe(true);
  });

  it('reports an absent vault fact as null with a reason, NEVER as false or 0', async () => {
    const d = await run({ classRef: 'LegacyService' });
    // The node carries no classifier keys at all.
    expect(d.entryPoints.runsInSeparateTransaction).toBeNull();
    expect(d.entryPoints.note).toContain('NOT CHECKED');
    expect(d.entryPoints.note).toContain('It was not reported false.');
    // …and no lineCount / status / apiVersion.
    expect(d.meta.lineCount).toBeNull();
    expect(d.meta.sourceBytes).toBeNull();
    expect(d.meta.status).toBeNull();
    expect(d.meta.apiVersion).toBeNull();
  });

  it('reports a KNOWN transaction shape as a boolean, so null really means unchecked', async () => {
    const d = await run({ classRef: 'CleanService' });
    expect(d.entryPoints.runsInSeparateTransaction).toBe(false);
    expect(d.entryPoints.asyncBoundaries).toEqual([]);
  });

  it('labels a CHECKED-and-empty test list distinctly from an unchecked one', async () => {
    const d = await run({ classRef: 'WidgetService' });
    expect(d.tests.checked).toBe(true);
    expect(d.tests.coveringTestClasses.items).toEqual([]);
    expect(d.tests.note).toContain('CHECKED and empty');
    expect(d.tests.note).toContain('not "0% coverage"');
  });

  it('states the dynamic-Apex blind spot verbatim and drops completeness to partial', async () => {
    const d = await run({ classRef: 'WidgetService' });
    expect(d.structure!.dataAccess.dynamicApex.total).toBeGreaterThan(0);
    expect(
      d.boundaries.some((b) => b.startsWith('This code uses dynamic Apex')),
    ).toBe(true);
    expect(d.review.completeness).toBe('partial');
  });

  it('always states the single-file boundary', async () => {
    const d = await run({ classRef: 'CleanService' });
    expect(d.boundaries[0]).toContain('Single-file parse');
    expect(d.disclosure).toContain('NOT a compiler and NOT cross-file');
  });

  it('keeps the TRUE total when a section is emptied by include-narrowing', async () => {
    const full = await run({ classRef: 'WidgetService' });
    const narrowed = await run({ classRef: 'WidgetService', include: ['review'] });
    expect(narrowed.review.findings.items.length).toBeGreaterThan(0);
    // The emptied section must NOT read as "this class has no methods".
    expect(narrowed.structure!.methods.items).toEqual([]);
    expect(narrowed.structure!.methods.total).toBe(full.structure!.methods.total);
    expect(narrowed.structure!.methods.truncated).toBe(true);
    expect(narrowed.narrowing?.omittedSections).toContain('methods');
    expect(narrowed.narrowing?.recoverWith).toContain('without `include`');
  });

  it('narrows to one method, keeps that method\'s sites, and discloses what it dropped', async () => {
    const d = await run({ classRef: 'WidgetService', method: 'fanOut' });
    expect(d.structure!.methods.items.map((m) => m.name)).toEqual(['fanOut']);
    for (const site of d.structure!.dataAccess.callouts.items) {
      expect(site.inMethod).toBe('fanOut');
    }
    expect(d.narrowing?.applied).toBe('method');
    // Class-level findings are NOT in a method-scoped list, and it says so.
    expect(d.review.note).toContain('class-level findings');
  });

  it('refuses an unknown method by naming the ones that ARE declared', async () => {
    const r = await apexStructureHandler(ctx, {
      classRef: 'WidgetService',
      method: 'nope',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('lookup');
  });

  it('trims a huge class to fit the budget, keeping the true totals and disclosing it', async () => {
    const d = await run({ classRef: 'HugeService' });
    const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
    expect(bytes).toBeLessThan(40_000);
    expect(d.structure!.methods.total).toBe(300);
    expect(d.structure!.methods.items.length).toBeLessThan(300);
    expect(d.structure!.methods.truncated).toBe(true);
    expect(d.narrowing?.truncated).toBe(true);
    expect(d.narrowing?.recoverWith).toContain('method:');
  });
});

describe('apexStructureInputSchema — strict', () => {
  it('rejects an unknown key instead of silently dropping it', () => {
    const r = apexStructureInputSchema.safeParse({
      classRef: 'WidgetService',
      methodName: 'lookup',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown include section', () => {
    expect(
      apexStructureInputSchema.safeParse({
        classRef: 'WidgetService',
        include: ['connectors'],
      }).success,
    ).toBe(false);
  });

  it('accepts the documented shape', () => {
    expect(
      apexStructureInputSchema.safeParse({
        classRef: 'ApexClass:WidgetService',
        include: ['methods', 'review'],
        method: 'lookup',
      }).success,
    ).toBe(true);
  });
});

describe('apexStructureHandler — a trigger is not a class', () => {
  it('does NOT tell a trigger it inherits its caller\'s sharing context', async () => {
    const d = await run({ classRef: 'WidgetTrigger' });
    // FAIL-BEFORE: reusing the class-shaped helper reported `inherits-caller`,
    // which is a wrong SECURITY answer — a trigger has no Apex caller and the
    // platform runs it in system context.
    expect(d.meta.sharing.effectiveModel).toBe('system-context');
    expect(d.meta.sharing.runsAsSystem).toBe(true);
    expect(d.meta.sharingSource).toBe('trigger-system-context');
    expect(d.meta.sharing.note).toContain('CANNOT declare a sharing keyword');
    expect(d.meta.sharing.note).not.toContain('INHERITS THE CALLER');
  });

  it('keeps the class answer for a class', async () => {
    const d = await run({ classRef: 'WidgetService' });
    expect(d.meta.sharing.effectiveModel).toBe('inherits-caller');
    expect(d.meta.sharingSource).toBe('parsed-source');
  });
});

describe('apexStructureHandler — every null carries its reason', () => {
  it('names each meta fact the vault did not record, and why', async () => {
    const d = await run({ classRef: 'LegacyService' });
    const fields = d.meta.absent.map((a) => a.field);
    expect(fields).toEqual(
      expect.arrayContaining(['status', 'apiVersion', 'lineCount', 'sourceBytes', 'isTest']),
    );
    for (const entry of d.meta.absent) {
      expect(entry.reason).toContain('UNKNOWN, not false / 0 / empty');
    }
  });

  it('lists nothing as absent when every fact was recorded', async () => {
    const d = await run({ classRef: 'WidgetService' });
    expect(d.meta.absent).toEqual([]);
  });

  it('attributes an unparsed class\'s unknown declaration facts to the parse failure', async () => {
    const d = await run({ classRef: 'BrokenService' });
    const kind = d.meta.absent.find((a) => a.field === 'kind')!;
    expect(kind.reason).toContain('the source did not parse');
  });
});

describe('apexStructureHandler — a trigger transaction shape is a language fact', () => {
  it('reports runsInSeparateTransaction: false for a trigger, not null', async () => {
    const d = await run({ classRef: 'WidgetTrigger' });
    // The trigger node carries no async classifiers (no real vault writes them
    // for ApexTrigger), but the answer is knowable WITHOUT the vault, so `null`
    // would hide a fact rather than protect one.
    expect(d.entryPoints.runsInSeparateTransaction).toBe(false);
    expect(d.entryPoints.note).toContain('platform rule, not a vault reading');
    expect(d.entryPoints.note).toContain('asyncDispatch');
  });
});
