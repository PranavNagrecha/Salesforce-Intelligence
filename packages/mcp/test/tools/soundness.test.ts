/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ComponentId,
  ComponentType,
  ExtractionResult,
  Node,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import {
  soundnessForImpactWalk,
  soundnessForReachabilityWalk,
  soundnessFromIds,
  soundnessFromNodes,
  soundnessFromDynamicApexIds,
  UNWALKED_EDGE_TYPE_NOTE,
  UNWALKED_REFERRER_CLASSES,
} from '../../src/tools/soundness.js';

/** Minimal Apex node; `qualityIssues` carries the persisted dynamic-apex signal. */
const apexNode = (id: string, qualityIssues: unknown[]): Node => ({
  id: id as ComponentId,
  type: 'ApexClass' as ComponentType,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `src/${id}.cls`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { qualityIssues },
});

/** A minimal node of an arbitrary type (for the impact-walk root-type tests). */
const typedNode = (id: string, type: ComponentType): Node => ({
  id: id as ComponentId,
  type,
  apiName: id.split(':')[1] ?? id,
  label: null,
  parentId: null,
  sourcePath: `src/${id}`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const DYNAMIC_ISSUE = { rule: 'dynamic-apex', severity: 'info', location: 'line 4', explanation: 'x', confidence: 'heuristic' };
const SOQL_LOOP_ISSUE = { rule: 'soql-in-loop', severity: 'high', location: 'line 9', explanation: 'y', confidence: 'heuristic' };

describe('soundnessFromNodes', () => {
  it('is complete when no node carries the dynamic-apex signal', () => {
    const s = soundnessFromNodes([apexNode('ApexClass:Clean', [SOQL_LOOP_ISSUE]), apexNode('ApexClass:Bare', [])]);
    expect(s.complete).toBe(true);
    expect(s.blindSpots).toEqual([]);
    expect(s.staticCoverage).toBe('full');
  });

  it('is INCOMPLETE with a dynamic-apex blind spot when a node uses dynamic Apex', () => {
    const s = soundnessFromNodes([
      apexNode('ApexClass:Dyn', [DYNAMIC_ISSUE]),
      apexNode('ApexClass:Clean', [SOQL_LOOP_ISSUE]),
    ]);
    expect(s.complete).toBe(false);
    expect(s.staticCoverage).toBe('partial');
    expect(s.blindSpots).toHaveLength(1);
    expect(s.blindSpots[0]?.kind).toBe('dynamic-apex');
    expect(s.blindSpots[0]?.componentIds).toEqual(['ApexClass:Dyn']);
    expect(s.blindSpots[0]?.note).toMatch(/dynamic Apex/i);
  });

  it('lists every dynamic class, sorted + de-duplicated, with a canonical componentIds key', () => {
    const s = soundnessFromNodes([
      apexNode('ApexClass:Zed', [DYNAMIC_ISSUE]),
      apexNode('ApexClass:Abe', [DYNAMIC_ISSUE]),
      apexNode('ApexClass:Abe', [DYNAMIC_ISSUE]),
    ]);
    expect(s.blindSpots[0]?.componentIds).toEqual(['ApexClass:Abe', 'ApexClass:Zed']);
    // canonical id key only — never `id`/`classId`
    expect(Object.keys(s.blindSpots[0] ?? {})).toContain('componentIds');
  });

  /**
   * SOUNDNESS-UNSCANNED-READS-AS-CLEAN.
   *
   * This block previously asserted that a missing OR garbled `qualityIssues`
   * produced NO blind spot — "best-effort". Best-effort should mean "does not
   * crash", and it still does; it must not also mean "assume clean". The
   * recognizer's contract (`packages/extractors/src/apex-class.ts`) is that the
   * property is ALWAYS PRESENT on a scanned node, empty array included, so an
   * absent or unreadable value means the scan did not run — not that it ran and
   * found nothing.
   *
   * The same mistake already shipped against this property once:
   * QUALITY-SCAN-SKIPS-TRIGGERS records that ApexTriggers carried no
   * `qualityIssues`, so `crud_fls_audit` answered CLEAN for triggers.
   */
  it('FAIL-BEFORE/PASS-AFTER: an Apex node with NO qualityIssues is not-scanned, not clean', () => {
    const unscanned: Node = { ...apexNode('ApexClass:NeverScanned', []), properties: {} };
    const s = soundnessFromNodes([unscanned]);
    expect(s.complete).toBe(false);
    expect(s.staticCoverage).toBe('partial');
    expect(s.blindSpots.map((b) => b.kind)).toContain('quality-scan-not-run');
    expect(s.blindSpots.find((b) => b.kind === 'quality-scan-not-run')?.componentIds).toEqual([
      'ApexClass:NeverScanned',
    ]);
  });

  it('treats a GARBLED qualityIssues as unreadable — degrades, never crashes, never certifies', () => {
    const weird: Node = {
      ...apexNode('ApexClass:X', []),
      properties: { qualityIssues: 'not-an-array' },
    };
    // Best-effort still holds in the sense that matters: no throw.
    expect(() => soundnessFromNodes([weird])).not.toThrow();
    // But an unreadable signal is not a clean one.
    expect(soundnessFromNodes([weird]).complete).toBe(false);
  });

  /**
   * The over-correction guard. Only the types the recognizer actually runs over
   * can be "not scanned". A CustomField has no `qualityIssues` and never should,
   * so flagging its absence would be noise — and noise is how a real disclosure
   * gets ignored.
   */
  it('does NOT flag a non-Apex node that legitimately has no qualityIssues', () => {
    const field = typedNode('CustomField:Account.Status__c', 'CustomField');
    const s = soundnessFromNodes([field]);
    expect(s.complete).toBe(true);
    expect(s.staticCoverage).toBe('full');
  });
});

describe('soundnessFromDynamicApexIds', () => {
  it('empty → complete; non-empty → partial with those ids', () => {
    expect(soundnessFromDynamicApexIds([]).complete).toBe(true);
    const s = soundnessFromDynamicApexIds(['ApexClass:A' as ComponentId, 'ApexClass:A' as ComponentId]);
    expect(s.complete).toBe(false);
    expect(s.blindSpots[0]?.componentIds).toEqual(['ApexClass:A']);
  });
});

// D3-soundness-overclaim: an edge-walking impact analysis on a CustomField /
// CustomObject is structurally blind to referrer classes not modeled as edges —
// it must NOT report complete/full on their absence.
describe('soundnessForImpactWalk', () => {
  it('a CustomField root is NOT complete/full — carries an unwalked-referrer-class blind spot naming the classes verbatim', () => {
    const s = soundnessForImpactWalk([typedNode('CustomField:Account.Status__c', 'CustomField')], 'CustomField');
    expect(s.complete).toBe(false);
    expect(s.staticCoverage).toBe('partial');
    const referrer = s.blindSpots.find((b) => b.kind === 'unwalked-referrer-class');
    expect(referrer).toBeDefined();
    // Structural blind spot: no specific componentIds, names the classes instead.
    expect(referrer?.componentIds).toEqual([]);
    expect(referrer?.referrerClasses).toEqual([...UNWALKED_REFERRER_CLASSES]);
    // The four classes the walk cannot see, verbatim.
    expect(referrer?.referrerClasses).toContain('roll-up source coupling');
    expect(referrer?.referrerClasses).toContain('layout placement');
    expect(referrer?.referrerClasses).toContain('flow decision/filter reads');
    expect(referrer?.referrerClasses).toContain('tab/app membership');
    expect(referrer?.note).toMatch(/not checked/i);
  });

  it('a CustomObject root is also NOT complete/full', () => {
    const s = soundnessForImpactWalk([typedNode('CustomObject:Account', 'CustomObject')], 'CustomObject');
    expect(s.complete).toBe(false);
    expect(s.staticCoverage).toBe('partial');
    expect(s.blindSpots.some((b) => b.kind === 'unwalked-referrer-class')).toBe(true);
  });

  it('GUARD: a fully-walked non-field/object root (ApexClass) reports the strongest honest coverage (complete/full)', () => {
    const s = soundnessForImpactWalk([apexNode('ApexClass:Clean', [])], 'ApexClass');
    expect(s.complete).toBe(true);
    expect(s.staticCoverage).toBe('full');
    expect(s.blindSpots).toEqual([]);
  });

  it('null root type is byte-identical to soundnessFromNodes (Apex tools untouched)', () => {
    const nodes = [apexNode('ApexClass:Dyn', [DYNAMIC_ISSUE])];
    expect(soundnessForImpactWalk(nodes, null)).toEqual(soundnessFromNodes(nodes));
  });

  it('PRESERVES a dynamic-apex blind spot AND adds the referrer one on a field root (never weakens a true positive)', () => {
    const dyn = { ...apexNode('ApexClass:Dyn', [DYNAMIC_ISSUE]), type: 'ApexClass' as ComponentType };
    const field = typedNode('CustomField:Account.Status__c', 'CustomField');
    const s = soundnessForImpactWalk([dyn, field], 'CustomField');
    expect(s.complete).toBe(false);
    expect(s.blindSpots.some((b) => b.kind === 'dynamic-apex')).toBe(true);
    expect(s.blindSpots.some((b) => b.kind === 'unwalked-referrer-class')).toBe(true);
  });
});

describe('soundnessForReachabilityWalk', () => {
  const USAGE = ['callsApex', 'references', 'dispatchesAsync'] as const;

  it('NO-OP GUARANTEE: walking the FULL usage set is deep-equal to soundnessFromNodes', () => {
    const nodes = [apexNode('ApexClass:Clean', [SOQL_LOOP_ISSUE]), apexNode('ApexClass:Bare', [])];
    expect(soundnessForReachabilityWalk(nodes, USAGE, USAGE)).toEqual(soundnessFromNodes(nodes));
  });

  it('NO-OP GUARANTEE holds when a dynamic-apex blind spot is present', () => {
    const nodes = [apexNode('ApexClass:Dyn', [DYNAMIC_ISSUE])];
    expect(soundnessForReachabilityWalk(nodes, USAGE, USAGE)).toEqual(soundnessFromNodes(nodes));
  });

  it('a STRICT SUBSET walk is NOT complete and names both the walked and un-walked types', () => {
    const s = soundnessForReachabilityWalk([apexNode('ApexClass:Clean', [])], ['callsApex'], USAGE);
    expect(s.complete).toBe(false);
    expect(s.staticCoverage).toBe('partial');
    const spot = s.blindSpots.find((b) => b.kind === 'unwalked-edge-type');
    expect(spot).toBeDefined();
    expect(spot?.walkedEdgeTypes).toEqual(['callsApex']);
    expect(spot?.unwalkedEdgeTypes).toEqual(['references', 'dispatchesAsync']);
    expect(spot?.componentIds).toEqual([]);
    expect(spot?.note).toBe(UNWALKED_EDGE_TYPE_NOTE);
  });

  it('PRESERVES a dynamic-apex blind spot and ADDS the edge-type one (never substitutes)', () => {
    const s = soundnessForReachabilityWalk([apexNode('ApexClass:Dyn', [DYNAMIC_ISSUE])], ['callsApex'], USAGE);
    expect(s.blindSpots.some((b) => b.kind === 'dynamic-apex')).toBe(true);
    expect(s.blindSpots.some((b) => b.kind === 'unwalked-edge-type')).toBe(true);
  });
});

/**
 * The `soundnessFromIds` path, over a REAL graph store — this is the read
 * `sfi.find_dead_code` and `sfi.test_coverage_for_method` use (they hold ids,
 * not nodes). The same three-state predicate backs it, so a vault whose Apex
 * nodes were never scanned must NOT come back `complete: true` /
 * `staticCoverage: 'full'` on the tool that issues DELETE verdicts.
 */
describe('soundnessFromIds (real graph)', () => {
  const MANIFEST_NODE = (id: string, properties: Record<string, unknown>): Node => ({
    id: id as ComponentId,
    type: 'ApexClass' as ComponentType,
    apiName: id.split(':')[1] ?? id,
    label: null,
    parentId: null,
    sourcePath: `src/${id}.cls`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties,
  });

  const seed: ExtractionResult = {
    nodes: [
      // Scanned and clean: carries the KEY with an empty array.
      MANIFEST_NODE('ApexClass:ScannedClean', { qualityIssues: [] }),
      // Never scanned: the KEY is absent entirely (a pre-recognizer vault).
      MANIFEST_NODE('ApexClass:NeverScanned', {}),
      // Scanned and dynamic.
      MANIFEST_NODE('ApexClass:Dynamic', { qualityIssues: [DYNAMIC_ISSUE] }),
    ],
    edges: [],
  };

  let tempDir: string;
  let store: GraphStore;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-soundness-'));
    const opened = await openGraph(join(tempDir, 'soundness.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('a scanned-clean id is complete/full', async () => {
    const s = await soundnessFromIds(store, ['ApexClass:ScannedClean' as ComponentId]);
    expect(s.complete).toBe(true);
    expect(s.staticCoverage).toBe('full');
    expect(s.blindSpots).toEqual([]);
  });

  it('FAIL-BEFORE/PASS-AFTER: an id whose node carries NO qualityIssues KEY is quality-scan-not-run, never complete', async () => {
    const s = await soundnessFromIds(store, ['ApexClass:NeverScanned' as ComponentId]);
    expect(s.complete).toBe(false);
    expect(s.staticCoverage).toBe('partial');
    const spot = s.blindSpots.find((b) => b.kind === 'quality-scan-not-run');
    expect(spot).toBeDefined();
    expect(spot?.componentIds).toEqual(['ApexClass:NeverScanned']);
    expect(spot?.note).toMatch(/NOT proof they are clean/);
  });

  it('an unscanned id POISONS a mixed batch — one unchecked node is enough to lose full coverage', async () => {
    const s = await soundnessFromIds(store, [
      'ApexClass:ScannedClean' as ComponentId,
      'ApexClass:NeverScanned' as ComponentId,
    ]);
    expect(s.complete).toBe(false);
    expect(s.blindSpots.map((b) => b.kind)).toEqual(['quality-scan-not-run']);
  });

  it('reports BOTH blind spots when a batch mixes a dynamic node and an unscanned one', async () => {
    const s = await soundnessFromIds(store, [
      'ApexClass:Dynamic' as ComponentId,
      'ApexClass:NeverScanned' as ComponentId,
    ]);
    expect(s.blindSpots.map((b) => b.kind).sort()).toEqual([
      'dynamic-apex',
      'quality-scan-not-run',
    ]);
  });

  it('an id absent from the vault is skipped, not counted as unscanned', async () => {
    const s = await soundnessFromIds(store, ['ApexClass:DoesNotExist' as ComponentId]);
    expect(s.complete).toBe(true);
    expect(s.blindSpots).toEqual([]);
  });
});
