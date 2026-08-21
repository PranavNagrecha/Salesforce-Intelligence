/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
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
import {
  collectApexIdentifiers,
  explainDebugLogHandler,
  explainDebugLogInputSchema,
  isDebugLog,
  parseGovernorLimit,
} from '../../src/tools/explain-debug-log.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

// Fixtures shaped like real graph rows. AccountHandler carries a soql-in-loop
// governor-risk finding (the `qualityIssues` shape governor_limit_risks reads).
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({
      id: 'ApexClass:AccountHandler',
      type: 'ApexClass',
      apiName: 'AccountHandler',
      label: 'AccountHandler',
      properties: {
        qualityIssues: [
          {
            rule: 'soql-in-loop',
            severity: 'high',
            location: 'AccountHandler.recalc line 12',
            explanation: 'SOQL query inside a for-loop; risks the 100-SOQL governor limit.',
          },
        ],
      },
    }),
    // A class with NO governor-risk finding — resolves, but no correlation.
    node({ id: 'ApexClass:QuietService', type: 'ApexClass', apiName: 'QuietService' }),
    node({
      id: 'ApexTrigger:AccountTrigger',
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: { triggerObject: 'Account', status: 'Active' },
    }),
    node({
      id: 'Flow:Account_After_Save',
      type: 'Flow',
      apiName: 'Account_After_Save',
      label: 'Account After Save',
      properties: { status: 'Active', triggerObject: 'Account' },
    }),
  ],
  edges: [
    edge({ fromId: 'ApexTrigger:AccountTrigger', toId: 'CustomObject:Account', edgeType: 'triggersOn' }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-explain-debug-log-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('isDebugLog', () => {
  it('recognizes pipe-delimited debug-log event markers', () => {
    expect(isDebugLog('16:20:01.0 (12345)|CODE_UNIT_STARTED|[EXTERNAL]|AccountHandler.recalc()')).toBe(true);
    expect(isDebugLog('12:00:00.1 (9)|LIMIT_USAGE_FOR_NS|(default)|')).toBe(true);
    expect(isDebugLog('explain this debug log for me')).toBe(true);
  });
  it('does NOT treat a plain save-error banner as a debug log', () => {
    expect(isDebugLog('FIELD_CUSTOM_VALIDATION_EXCEPTION, Close date is required')).toBe(false);
  });
});

describe('parseGovernorLimit', () => {
  it('classifies a SOQL LimitException and extracts the count', () => {
    const p = parseGovernorLimit('FATAL_ERROR|System.LimitException: Too many SOQL queries: 101');
    expect(p?.limitType).toBe('soql');
    expect(p?.actual).toBe(101);
  });
  it('classifies a DML LimitException', () => {
    const p = parseGovernorLimit('System.LimitException: Too many DML statements: 151');
    expect(p?.limitType).toBe('dml');
    expect(p?.actual).toBe(151);
  });
  it('classifies a CPU-time exception with no trailing count', () => {
    const p = parseGovernorLimit('System.LimitException: Apex CPU time limit exceeded');
    expect(p?.limitType).toBe('cpu');
    expect(p?.actual).toBeNull();
  });
  it('classifies a heap exception', () => {
    expect(parseGovernorLimit('System.LimitException: Apex heap size too large: 7000000')?.limitType).toBe('heap');
  });
  it('reads an exceeding LIMIT_USAGE block (out of)', () => {
    const p = parseGovernorLimit('Number of SOQL queries: 101 out of 100');
    expect(p?.limitType).toBe('soql');
    expect(p?.actual).toBe(101);
    expect(p?.allowed).toBe(100);
  });
  it('returns null when there is no governor-limit signal', () => {
    expect(parseGovernorLimit('just some ordinary text about accounts')).toBeNull();
  });
});

describe('collectApexIdentifiers', () => {
  it('harvests classes and triggers from stack frames and event units', () => {
    const log = [
      '16:20:01.0 (1)|CODE_UNIT_STARTED|[EXTERNAL]|AccountTrigger on Account trigger event BeforeInsert|__sfdc_trigger/AccountTrigger',
      '16:20:01.1 (2)|CODE_UNIT_STARTED|[EXTERNAL]|AccountHandler.recalc()',
      'Class.AccountHandler.recalc: line 12, column 1',
      'Trigger.AccountTrigger: line 3, column 1',
    ].join('\n');
    const ids = collectApexIdentifiers(log);
    expect(ids).toContainEqual({ kind: 'ApexClass', name: 'AccountHandler' });
    expect(ids).toContainEqual({ kind: 'ApexTrigger', name: 'AccountTrigger' });
  });
  it('de-duplicates repeated identities', () => {
    const ids = collectApexIdentifiers('Class.Foo.a: line 1\nClass.Foo.b: line 2');
    expect(ids.filter((i) => i.name === 'Foo').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe('explainDebugLogHandler', () => {
  it('cross-references a fired SOQL limit to a resolved class with a soql-in-loop finding', async () => {
    const logText = [
      '16:20:01.0 (1000)|EXCEPTION_THROWN|[12]|System.LimitException: Too many SOQL queries: 101',
      '16:20:01.0 (1001)|FATAL_ERROR|System.LimitException: Too many SOQL queries: 101',
      'Class.AccountHandler.recalc: line 12, column 1',
    ].join('\n');
    const r = await explainDebugLogHandler(ctx, { logText });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).toBe('matched');
    expect(d.logKind).toBe('debug-log');
    expect(d.detectedLimit?.limitType).toBe('soql');
    // The class resolved AND carries the matched governor risk.
    expect(d.candidates[0]?.componentId).toBe('ApexClass:AccountHandler');
    expect(d.candidates[0]?.confidence).toBe('declared');
    expect(d.governorRiskCrossRef?.limitType).toBe('soql');
    const ref = d.governorRiskCrossRef?.classesWithRisks.find((c) => c.componentId === 'ApexClass:AccountHandler');
    expect(ref?.matchedRisks[0]?.rule).toBe('soql-in-loop');
  });

  it('resolves an apex identity even with no static risk, and notes the gap', async () => {
    const logText = 'System.LimitException: Too many SOQL queries: 101\nClass.QuietService.run: line 5, column 1';
    const r = await explainDebugLogHandler(ctx, { logText });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.candidates.some((c) => c.componentId === 'ApexClass:QuietService')).toBe(true);
    // No class carried a matched loop-risk → the cross-ref note explains why.
    expect(d.governorRiskCrossRef?.classesWithRisks.every((c) => c.matchedRisks.length === 0)).toBe(true);
    expect(d.governorRiskCrossRef?.note).toBeTruthy();
  });

  it('reports an unresolved apex name without fabricating a match', async () => {
    const r = await explainDebugLogHandler(ctx, {
      logText: 'System.LimitException: Too many DML statements: 200\nClass.GhostClass.go: line 1, column 1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unresolvedApex).toContain('ApexClass:GhostClass');
    expect(r.value.data.candidates.every((c) => c.componentId !== 'ApexClass:GhostClass')).toBe(true);
  });

  it('resolves a flow named in a fault embedded in the log', async () => {
    const r = await explainDebugLogHandler(ctx, {
      logText: 'FLOW_START_INTERVIEWS|An error occurred. Flow API Name: Account_After_Save',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.candidates.some((c) => c.componentId === 'Flow:Account_After_Save')).toBe(true);
  });

  it('fails closed with actionable next steps when nothing resolves', async () => {
    const r = await explainDebugLogHandler(ctx, { logText: 'System.LimitException: Apex CPU time limit exceeded' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).toBe('none');
    expect(d.candidates).toHaveLength(0);
    expect(d.nextSteps.length).toBeGreaterThan(0);
    // A recognized limit still classifies at the category level.
    expect(d.detectedLimit?.limitType).toBe('cpu');
    expect(d.disclosure.length).toBeGreaterThan(0);
  });

  it('carries the shared status-code taxonomy through (reused detectStatusCode)', async () => {
    const r = await explainDebugLogHandler(ctx, {
      logText: 'FATAL_ERROR|System.DmlException: Update failed. First exception on row 0; UNABLE_TO_LOCK_ROW',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.detectedStatusCode).toBe('UNABLE_TO_LOCK_ROW');
  });
});

// ---------------------------------------------------------------------------
// Natural input aliases (EXPLAIN-DEBUG-LOG-REJECTS-TEXT-ALIAS): a host that
// pasted the log under `debugLog` / `log` / `text` / `content` is resolved to
// the same answer as canonical `logText`; canonical wins on a collision; a
// genuinely-empty input fails closed with a named invalid-query.
// ---------------------------------------------------------------------------

describe('explain_debug_log — natural input aliases', () => {
  const CANON =
    'System.LimitException: Too many SOQL queries: 101\nClass.AccountHandler.recalc: line 12, column 1';

  const runVia = async (raw: Record<string, unknown>) => {
    const parsed = explainDebugLogInputSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('schema rejected a valid alias input');
    const r = await explainDebugLogHandler(ctx, parsed.data);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('handler failed');
    return r.value.data;
  };

  it('debugLog / log / text / content resolve byte-identically to canonical logText', async () => {
    const canonical = await runVia({ logText: CANON });
    for (const key of ['debugLog', 'log', 'text', 'content']) {
      const viaAlias = await runVia({ [key]: CANON });
      expect(viaAlias).toEqual(canonical);
    }
  });

  it('canonical logText wins when both logText and an alias are present', () => {
    const parsed = explainDebugLogInputSchema.safeParse({
      logText: CANON,
      text: 'unrelated log zzz',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.logText).toBe(CANON);
  });

  it('empty input (no canonical, no alias) fails closed with a named logText invalid-query', () => {
    const parsed = explainDebugLogInputSchema.safeParse({ object: 'Account' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.path.join('.') === 'logText')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EXPLAIN-DEBUG-LOG-CLEAN-VERDICT-FROM-PAGE-ONE
//
// The governor cross-reference used to call `governorLimitRisksHandler(ctx, {})`
// — ORG-WIDE mode, whose `classes` array is a PAGE (default limit 100) whose
// `truncated` / `nextOffset` / `nextCursor` were never read. A class named in
// the log that sorted PAST that page boundary was simply absent from the lookup,
// and the handler then emitted the affirmative "has no static soql/dml-in-loop
// finding" — a clean verdict produced by not looking.
//
// The invariant asserted here is scale-INDEPENDENT: the verdict for a named
// class must not depend on how many OTHER risky classes sort ahead of it. The
// fixture seeds strictly more risky classes than the page holds and names the
// one that sorts last, so a reintroduced page-one lookup fails hard.
// ---------------------------------------------------------------------------

/** Classes that must precede the target under the engine's id-ASC ordering. */
const CROWD_SIZE = 120;
/** Sorts after every `ApexClass:Crowd###` id, and after `ApexClass:` letters A-Y. */
const LATE_CLASS_ID = 'ApexClass:zzTailEscalationService';

const riskyIssue = (line: number) => ({
  rule: 'soql-in-loop',
  severity: 'critical',
  location: `line ${line.toString()}`,
  explanation: 'SOQL query inside a loop body.',
});

const crowdedSeed = (): ExtractionResult => {
  const nodes: Node[] = [];
  for (let i = 0; i < CROWD_SIZE; i += 1) {
    const name = `Crowd${String(i).padStart(3, '0')}`;
    nodes.push(
      node({
        id: `ApexClass:${name}`,
        type: 'ApexClass',
        apiName: name,
        properties: { qualityIssues: [riskyIssue(i + 1)] },
      }),
    );
  }
  nodes.push(
    node({
      id: LATE_CLASS_ID,
      type: 'ApexClass',
      apiName: 'zzTailEscalationService',
      properties: { qualityIssues: [riskyIssue(5)] },
    }),
    // A second late-sorting class with NO findings — the clean-verdict subject.
    node({ id: 'ApexClass:zzQuietService', type: 'ApexClass', apiName: 'zzQuietService' }),
  );
  return { nodes, edges: [] };
};

const crowdedLog = (className: string): string =>
  [
    '61.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;DB,INFO;SYSTEM,DEBUG',
    '09:00:00.1 (1000000)|EXECUTION_STARTED',
    `09:00:00.1 (1200000)|CODE_UNIT_STARTED|[EXTERNAL]|${className}.run()`,
    `09:00:00.1 (1900000)|METHOD_ENTRY|[5]|${className}.run()`,
    '09:00:00.2 (21000000)|SOQL_EXECUTE_BEGIN|[5]|Aggregations:0|SELECT Id FROM Case',
    '09:00:00.2 (24000000)|SOQL_EXECUTE_END|[5]|Rows:3',
    '09:00:00.9 (900000000)|LIMIT_USAGE_FOR_NS|(default)|',
    '  Number of SOQL queries: 101 out of 100',
    `09:00:00.9 (901000000)|METHOD_EXIT|[5]|${className}.run()`,
    '09:00:00.9 (902000000)|FATAL_ERROR|System.LimitException: Too many SOQL queries: 101',
    '',
    `Class.${className}.run: line 5, column 1`,
    '09:00:00.9 (903000000)|EXECUTION_FINISHED',
  ].join('\n');

describe('explainDebugLogHandler — governor cross-reference scope (page-boundary honesty)', () => {
  let crowdedDir: string;
  let crowdedStore: GraphStore;
  let crowdedCtx: Context;

  beforeAll(async () => {
    crowdedDir = mkdtempSync(join(tmpdir(), 'sfi-explain-debug-log-crowd-'));
    const o = await openGraph(join(crowdedDir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    crowdedStore = o.value;
    const i = await importExtractionResults(crowdedStore, [crowdedSeed()]);
    if (!i.ok) throw new Error(i.error.message);
    crowdedCtx = { vaultRoot: crowdedDir, manifest: MANIFEST, graph: crowdedStore };
  });
  afterAll(async () => {
    await closeGraph(crowdedStore);
    rmSync(crowdedDir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: reports the named class’s finding even when it sorts past the org-wide page', async () => {
    // Margin, not a magic number: strictly MORE risky classes exist than the
    // engine's default page holds, and the named one sorts after all of them.
    expect(CROWD_SIZE).toBeGreaterThan(100);

    const result = await explainDebugLogHandler(crowdedCtx, {
      logText: crowdedLog('zzTailEscalationService'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const xref = result.value.data.governorRiskCrossRef;
    expect(xref).not.toBeNull();
    if (xref === null) return;

    expect(xref.classesWithRisks.map((c) => c.componentId)).toContain(LATE_CLASS_ID);
    expect(
      xref.classesWithRisks.find((c) => c.componentId === LATE_CLASS_ID)?.matchedRisks,
    ).not.toHaveLength(0);
    // The affirmative "clean" note must NOT be emitted for a class that has one.
    expect(xref.note).toBeNull();
  });

  it('names exactly the components the scan covered — never a claim about unscanned classes', async () => {
    const result = await explainDebugLogHandler(crowdedCtx, {
      logText: crowdedLog('zzQuietService'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const xref = result.value.data.governorRiskCrossRef;
    expect(xref).not.toBeNull();
    if (xref === null) return;

    // The clean verdict covers ONLY the resolved component the log named — not
    // the 120 other risky classes in the vault, which were never queried.
    expect(xref.scannedComponents).toEqual(['ApexClass:zzQuietService']);
    expect(xref.uncheckedComponents).toBeUndefined();
    expect(xref.classesWithRisks).toHaveLength(0);
    expect(xref.note).not.toBeNull();
    // An affirmative must NAME its subject, so a reader can tell whether the
    // scan reached the class they care about.
    expect(xref.note).toContain('ApexClass:zzQuietService');
    expect(xref.note).toMatch(/per-component scope/i);
  });

  it('an unresolved name is reported as unresolved, never folded into the clean verdict', async () => {
    const result = await explainDebugLogHandler(crowdedCtx, {
      logText: crowdedLog('NotInThisVaultService'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.unresolvedApex).toContain('ApexClass:NotInThisVaultService');
    const xref = result.value.data.governorRiskCrossRef;
    expect(xref?.scannedComponents).toEqual([]);
  });
});
