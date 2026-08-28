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
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import { revokeLiveConsent } from '../../src/live-consent.js';
import type { Context } from '../../src/server.js';
import { livePicklistUsageHandler } from '../../src/tools/live-picklist-usage.js';
import { resetLiveSession } from '../../src/tools/live-session.js';
import { grantTestLiveAccess } from '../helpers/live-test-grant.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { CustomObject: 1, CustomField: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const baseNode = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const PICKLIST = 'CustomField:Case.Status__c';
const TEXT_FIELD = 'CustomField:Case.Notes__c';
// H10: a re-extracted (NEW-vault) picklist storing the object shape, including
// one DEACTIVATED value. readDefinedValues must read .value off objects (the
// old typeof==='string' filter emptied the defined set to []).
const OBJ_PICKLIST = 'CustomField:Case.Stage__c';
const MULTI_PICKLIST = 'CustomField:Case.Tags__c';
const seed: ExtractionResult = {
  nodes: [
    baseNode({ id: 'CustomObject:Case', type: 'CustomObject', apiName: 'Case' }),
    baseNode({
      id: PICKLIST,
      type: 'CustomField',
      apiName: 'Status__c',
      parentId: 'CustomObject:Case',
      properties: { dataType: 'Picklist', picklistValues: ['New', 'Working', 'Escalated', 'Closed'] },
    }),
    baseNode({
      id: OBJ_PICKLIST,
      type: 'CustomField',
      apiName: 'Stage__c',
      parentId: 'CustomObject:Case',
      properties: {
        dataType: 'Picklist',
        picklistValues: [
          { value: 'Open', isActive: true },
          { value: 'Retired', isActive: false },
        ],
      },
    }),
    baseNode({
      id: MULTI_PICKLIST,
      type: 'CustomField',
      apiName: 'Tags__c',
      parentId: 'CustomObject:Case',
      properties: { dataType: 'MultiselectPicklist', picklistValues: ['A', 'B', 'C'] },
    }),
    baseNode({
      id: TEXT_FIELD,
      type: 'CustomField',
      apiName: 'Notes__c',
      parentId: 'CustomObject:Case',
      properties: { dataType: 'Text' },
    }),
  ],
  edges: [],
};

// GROUP BY returns New=50, Working=30, Legacy=5 (undefined), null=10.
// 'Escalated' and 'Closed' are defined but unused.
const liveExec: ExecCommand = async (_bin, args) => {
  if (args.includes('--use-tooling-api')) {
    return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
  }
  return {
    stdout: JSON.stringify({
      result: {
        records: [
          { Status__c: 'New', cnt: 50 },
          { Status__c: 'Working', cnt: 30 },
          { Status__c: 'Legacy', cnt: 5 },
          { Status__c: null, cnt: 10 },
        ],
      },
    }),
    stderr: '',
  };
};

let dir: string;
let store: GraphStore;
let ctx: Context;
let consentDir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-pick-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error('openGraph failed');
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error('seed failed');
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store, liveCapability: mintLiveCapability('primary') } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetLiveSession();
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-pick-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  // AUDIT-F3: liveEnabled is not consent — seed a full-scope test grant.
  await grantTestLiveAccess('test');
});

afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  rmSync(consentDir, { recursive: true, force: true });
});

describe('livePicklistUsageHandler (P6-live-picklist-usage)', () => {
  it('rejects a non-picklist field', async () => {
    const r = await livePicklistUsageHandler(ctx, { fieldId: TEXT_FIELD, liveEnabled: true }, liveExec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('without consent returns defined values + caveat (offline_snapshot), no usage', async () => {
    await revokeLiveConsent('test');
    const r = await livePicklistUsageHandler(ctx, { fieldId: PICKLIST }, liveExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.trust.provenance).toBe('offline_snapshot');
    expect(r.value.data.usage).toBeNull();
    expect(r.value.data.definedValues).toEqual(['New', 'Working', 'Escalated', 'Closed']);
    expect(r.value.data.consentPresent).toBe(false);
  });

  it('H10: reads defined values off the NEW-vault object[] shape (would empty to [] under the old string filter)', async () => {
    const r = await livePicklistUsageHandler(ctx, { fieldId: OBJ_PICKLIST }, liveExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Both the active and the inactive defined value strings surface — an
    // inactive value can still appear in live data, so the cross-reference must
    // know about it. The pre-fix typeof==='string' filter returned [].
    expect(r.value.data.definedValues).toEqual(['Open', 'Retired']);
  });

  it('with consent fuses live usage with the defined value set', async () => {
    const r = await livePicklistUsageHandler(ctx, { fieldId: PICKLIST, liveEnabled: true }, liveExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.trust.provenance).toBe('hybrid');
    expect(d.blankCount).toBe(10);
    expect(d.totalRecords).toBe(95);
    // Usage ordered by count desc; defined flag set.
    expect(d.usage?.[0]).toEqual({ value: 'New', count: 50, defined: true });
    expect(d.usage?.find((u) => u.value === 'Legacy')?.defined).toBe(false);
    // Cross-reference: Escalated + Closed defined but unused; Legacy used but undefined.
    expect([...d.unusedDefinedValues].sort()).toEqual(['Closed', 'Escalated']);
    expect(d.undefinedUsedValues).toEqual(['Legacy']);
    expect(d.isEmpty).toBe(false);
  });

  it('honest empty when no records use the picklist', async () => {
    const emptyExec: ExecCommand = async (_b, args) => {
      if (args.includes('--use-tooling-api')) {
        return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };
    const r = await livePicklistUsageHandler(ctx, { fieldId: PICKLIST, liveEnabled: true }, emptyExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.isEmpty).toBe(true);
    expect(r.value.data.usage).toEqual([]);
    expect([...r.value.data.unusedDefinedValues].sort()).toEqual(
      ['Closed', 'Escalated', 'New', 'Working'],
    );
  });
  // ---------------------------------------------------------------------
  // R1 / CRITICAL — the GROUP BY is capped at `limit` distinct value-groups
  // ordered by count DESC. A defined value that falls BELOW the cutoff was
  // NEVER SCANNED; reporting it in `unusedDefinedValues` collapses
  // never-scanned into scanned-and-clean and vouches for it as a cleanup /
  // restrict-to-active candidate.
  // ---------------------------------------------------------------------

  /**
   * An exec that behaves like a real org: it has FOUR distinct groups, all of
   * them in active use, and honors whatever `LIMIT n` the handler asked for
   * (ordered by count desc). A handler that asks for fewer groups than exist
   * gets a truncated distribution — exactly what the org does.
   */
  const cappedExec = (
    seen: { soql: string | null },
    groups: readonly (readonly [string | null, number])[],
  ): ExecCommand => async (_b, args) => {
    if (args.includes('--use-tooling-api')) {
      return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
    }
    const soql = args[args.indexOf('--query') + 1] ?? '';
    seen.soql = soql;
    const m = /LIMIT (\d+)\s*$/.exec(soql);
    const n = m === null ? groups.length : Number(m[1]);
    const rows = [...groups]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([value, cnt]) => ({ Status__c: value, cnt }));
    return { stdout: JSON.stringify({ result: { records: rows } }), stderr: '' };
  };

  const ALL_USED = [
    ['New', 50],
    ['Working', 30],
    ['Escalated', 20],
    ['Closed', 10],
  ] as const;

  it('R1: a CAPPED distribution never reports below-cutoff defined values as unused', async () => {
    const seen = { soql: null as string | null };
    const r = await livePicklistUsageHandler(
      ctx,
      { fieldId: PICKLIST, liveEnabled: true, limit: 2 },
      cappedExec(seen, ALL_USED),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Escalated (20 records) and Closed (10 records) are BELOW the top-2 cutoff.
    // They were never scanned — they must NOT be vouched for as unused.
    expect(d.unusedDefinedValues).toEqual([]);
    expect([...d.undeterminedDefinedValues].sort()).toEqual(['Closed', 'Escalated']);
    expect(d.distributionCapped).toBe(true);
  });

  it('R1: a CAPPED distribution is completeness partial, not complete', async () => {
    const seen = { soql: null as string | null };
    const r = await livePicklistUsageHandler(
      ctx,
      { fieldId: PICKLIST, liveEnabled: true, limit: 2 },
      cappedExec(seen, ALL_USED),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.trust.completeness.status).toBe('partial');
    expect(d.trust.limitations.some((l) => /capped/i.test(l) && /INCOMPLETE/.test(l))).toBe(true);
    // totalRecords is the sum of the SURVIVING groups only — narrate it as a floor.
    expect(d.interpretation).toMatch(/at least/i);
  });

  it('R1: the cap probe asks for limit+1 so EXACTLY-limit groups is not a false cap', async () => {
    const seen = { soql: null as string | null };
    const r = await livePicklistUsageHandler(
      ctx,
      { fieldId: PICKLIST, liveEnabled: true, limit: 4 },
      cappedExec(seen, ALL_USED),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(seen.soql).toMatch(/LIMIT 5$/);
    expect(d.distributionCapped).toBe(false);
    expect(d.trust.completeness.status).toBe('complete');
    expect(d.usage?.length).toBe(4);
    expect(d.unusedDefinedValues).toEqual([]);
    expect(d.undeterminedDefinedValues).toEqual([]);
  });

  it('R1: a capped answer never returns MORE than `limit` groups (the probe row is trimmed)', async () => {
    const seen = { soql: null as string | null };
    const r = await livePicklistUsageHandler(
      ctx,
      { fieldId: PICKLIST, liveEnabled: true, limit: 3 },
      cappedExec(seen, ALL_USED),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.usage?.length).toBe(3);
    expect(r.value.data.usage?.map((u) => u.value)).toEqual(['New', 'Working', 'Escalated']);
    expect(r.value.data.distributionCapped).toBe(true);
  });

  it('R1: an uncapped answer still names the genuinely-unused defined values', async () => {
    const seen = { soql: null as string | null };
    const r = await livePicklistUsageHandler(
      ctx,
      { fieldId: PICKLIST, liveEnabled: true },
      cappedExec(seen, [
        ['New', 50],
        ['Working', 30],
        [null, 10],
      ] as const),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.distributionCapped).toBe(false);
    expect([...d.unusedDefinedValues].sort()).toEqual(['Closed', 'Escalated']);
    expect(d.undeterminedDefinedValues).toEqual([]);
    expect(d.trust.completeness.status).toBe('complete');
    expect(d.blankCount).toBe(10);
  });

  it('R1: the offline (no-consent) answer carries the typed cap fields too', async () => {
    await revokeLiveConsent('test');
    const r = await livePicklistUsageHandler(ctx, { fieldId: PICKLIST }, liveExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.distributionCapped).toBe(false);
    expect(r.value.data.undeterminedDefinedValues).toEqual([]);
  });
  it('R1: the MultiselectPicklist note says `limit` caps distinct COMBINATIONS, not values', async () => {
    // GROUP BY on a multiselect groups by the whole semicolon-joined combo, so
    // the cap bites on combinations — a value present only in a below-cutoff
    // combination is silently uncounted.
    const msExec: ExecCommand = async (_b, args) => {
      if (args.includes('--use-tooling-api')) {
        return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
      }
      return {
        stdout: JSON.stringify({ result: { records: [{ Tags__c: 'A;B', cnt: 7 }] } }),
        stderr: '',
      };
    };
    const r = await livePicklistUsageHandler(ctx, { fieldId: MULTI_PICKLIST, liveEnabled: true }, msExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.multiselectNote).toMatch(/COMBINATION/);
    expect(r.value.data.trust.limitations.some((l) => /COMBINATION/.test(l))).toBe(true);
  });
});
