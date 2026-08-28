/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { phantomAwareNotFoundMessage } from '../../src/tools/phantom-node.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-27T12:00:00.000Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:phantom-node',
  coverageComputedAt: '2026-06-27T12:01:00.000Z',
  coverage: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-phantom-node-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  // Empty graph — every queried id has zero inbound edges, so the
  // `refs === 0` branch (the standard-field/standard-object disclosure)
  // is exercised, not the phantom-referenced branch.
  const imp = await importExtractionResults(store, []);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('phantomAwareNotFoundMessage — CR-CAP-17 standard-field disclosure', () => {
  it('returns the describe-conditional standard-field disclosure for a Task standard field (not a bare not-found)', async () => {
    const msg = await phantomAwareNotFoundMessage(
      ctx,
      'CustomField:Task.Subject' as ComponentId,
      'CustomField',
    );
    // Honesty: standard-object fields only materialize after a live
    // describe — the disclosure must say so, and must NOT imply offline
    // field data exists.
    expect(msg).toContain('standard-object field');
    expect(msg).toContain(
      'Metadata API retrieve does not emit uncustomized standard fields',
    );
    expect(msg).toContain('NOT proof the field is absent');
    // It must NOT collapse to the bare "no CustomField with id" message
    // (the pre-CR-CAP-17 fall-through for the 9 newly-added objects).
    expect(msg).not.toBe('no CustomField with id CustomField:Task.Subject');
  });

  it('also covers the other newly-added objects (Event/Order/User)', async () => {
    for (const id of [
      'CustomField:Event.Subject',
      'CustomField:Order.Status',
      'CustomField:User.Email',
    ]) {
      const msg = await phantomAwareNotFoundMessage(
        ctx,
        id as ComponentId,
        'CustomField',
      );
      expect(msg).toContain('standard-object field');
    }
  });

  it('still returns a bare not-found for a genuine custom field on an unknown object (no fabrication)', async () => {
    const msg = await phantomAwareNotFoundMessage(
      ctx,
      'CustomField:Widget__c.Color__c' as ComponentId,
      'CustomField',
    );
    expect(msg).toBe('no CustomField with id CustomField:Widget__c.Color__c');
  });
});

describe('phantomAwareNotFoundMessage — R1 query-failure honesty', () => {
  it('does NOT report a confident not-found when listEdges fails (query error, not zero references)', async () => {
    // A closed store makes any subsequent query throw inside listEdges,
    // which returns err(...) rather than ok([]) — this is the
    // query-FAILED case, distinct from a genuine zero-inbound-edges case.
    const failDir = mkdtempSync(join(tmpdir(), 'sfi-phantom-node-fail-'));
    const opened = await openGraph(join(failDir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const failStore = opened.value;
    await closeGraph(failStore);
    const failCtx: Context = { vaultRoot: failDir, manifest: MANIFEST, graph: failStore };

    const msg = await phantomAwareNotFoundMessage(
      failCtx,
      'ApexClass:Widget__c' as ComponentId,
      'ApexClass',
    );

    // The pre-fix code coerces a failed query to refs=0 and returns the
    // flat "no <kind> with id <id>" — the strongest possible false claim
    // that the component does not exist. A query failure must instead
    // say the check could not be performed.
    expect(msg).not.toBe('no ApexClass with id ApexClass:Widget__c');
    expect(msg.toLowerCase()).toContain('could not check');

    rmSync(failDir, { recursive: true, force: true });
  });
});

describe('phantomAwareNotFoundMessage — custom-suffix test must be case-INSENSITIVE', () => {
  // The custom-vs-standard decision is a pure SUFFIX test with no vault
  // lookup behind it. Written case-sensitively (`endsWith('__c')`) it calls
  // any `__C` / `__MDT` id on a standard parent object a "standard-object
  // field", which FABRICATES an authoritative-sounding property of a
  // component the vault never looked up — including for names that exist in
  // no org at all. Salesforce api names are case-insensitive, so the suffix
  // must be compared case-folded.
  const FABRICATION = 'is a standard-object field';

  it('does NOT claim an invented `__C` name on a standard parent is a standard field', async () => {
    const msg = await phantomAwareNotFoundMessage(
      ctx,
      'CustomField:Task.Zzz_Nope__C' as ComponentId,
      'CustomField',
    );
    expect(msg).not.toContain(FABRICATION);
    expect(msg).toBe('no CustomField with id CustomField:Task.Zzz_Nope__C');
  });

  it('folds every casing of the custom suffixes (__C / __c / __MDT / __mdt)', async () => {
    for (const suffix of ['__C', '__c', '__mDt', '__MDT', '__mdt']) {
      const id = `CustomField:Account.Zzz_Nope${suffix}` as ComponentId;
      const msg = await phantomAwareNotFoundMessage(ctx, id, 'CustomField');
      expect(msg, `suffix ${suffix}`).not.toContain(FABRICATION);
      expect(msg, `suffix ${suffix}`).toBe(`no CustomField with id ${id}`);
    }
  });

  it('CONTROL: the standard-field disclosure still fires for a real standard field (fold did not disable the branch)', async () => {
    const msg = await phantomAwareNotFoundMessage(
      ctx,
      'CustomField:Account.Industry' as ComponentId,
      'CustomField',
    );
    expect(msg).toContain(FABRICATION);
  });

  it('CONTROL: a wrong-CASE parent object stays a bare not-found (the object-name test must NOT be folded)', async () => {
    // Folding STANDARD_OBJECT_API_NAMES.has(objectApi) would route MORE ids
    // into the disclosure branch, which is the wrong direction for a
    // fabrication defect. Lock the current behaviour so a later "symmetry"
    // edit has to argue with a test.
    const msg = await phantomAwareNotFoundMessage(
      ctx,
      'CustomField:account.Industry' as ComponentId,
      'CustomField',
    );
    expect(msg).toBe('no CustomField with id CustomField:account.Industry');
  });
});
