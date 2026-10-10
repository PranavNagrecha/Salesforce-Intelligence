/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER (second review, WOW-12): a vault whose last refresh had
 * no org describe for a core standard object (an offline `--no-pull` with no
 * cached describe — every vault upgraded from 0.3.3) is missing that object's
 * describe-only standard fields. Only `health_check` said so. A field tool asked
 * about such a field answered component-not-found with "typically a
 * managed-package component … treat it as external", and object_360 reported
 * the field-node count with no hedge. Both now carry the per-object describe
 * disclosure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';
import type { ExtendedVaultManifest } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { object360Handler } from '../../src/tools/object-360.js';
import { phantomAwareNotFoundMessage } from '../../src/tools/phantom-node.js';

const BASE: ExtendedVaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-27T12:00:00.000Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:describe-gap',
  coverageComputedAt: '2026-06-27T12:01:00.000Z',
  coverage: [],
};
const DEGRADED: ExtendedVaultManifest = {
  ...BASE,
  standardFieldDescribe: { fromLive: [], fromCache: ['Contact'], skipped: ['Account'], offline: true },
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

const STD_FIELD = 'CustomField:Account.BillingCity' as ComponentId;

let dir: string;
let store: GraphStore;
const ctxWith = (manifest: ExtendedVaultManifest): Context => ({ vaultRoot: dir, manifest, graph: store });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-describe-gap-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [
    {
      nodes: [
        node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
        node({ id: 'CustomField:Account.Tier__c', type: 'CustomField', apiName: 'Tier__c', parentId: 'CustomObject:Account' }),
        node({ id: 'Layout:Account-Account Layout', type: 'Layout', apiName: 'Account-Account Layout' }),
      ],
      edges: [
        // A referrer to the un-noded standard field: the old message called it
        // "typically a managed-package component … treat it as external".
        edge({ fromId: 'Layout:Account-Account Layout', toId: STD_FIELD, edgeType: 'usedInLayout' }),
      ],
    },
  ]);
  if (!imp.ok) throw new Error(imp.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

describe('standard-field describe gap — not-found answers', () => {
  it('a standard field on a skipped object is NOT read as absent or external', async () => {
    const msg = await phantomAwareNotFoundMessage(ctxWith(DEGRADED), STD_FIELD, 'CustomField');
    expect(msg).toMatch(/NOT evidence it is absent/);
    expect(msg).toMatch(/Account's standard fields are incomplete/);
    expect(msg).toMatch(/--with-describe/);
    expect(msg).not.toMatch(/treat it as external/);
  });

  it('a vault with a describe keeps the existing message', async () => {
    const msg = await phantomAwareNotFoundMessage(ctxWith(BASE), STD_FIELD, 'CustomField');
    expect(msg).not.toMatch(/standard fields are incomplete/);
  });

  it('a custom field on a skipped object is not hedged by the describe gap', async () => {
    const msg = await phantomAwareNotFoundMessage(
      ctxWith(DEGRADED),
      'CustomField:Account.Missing__c' as ComponentId,
      'CustomField',
    );
    expect(msg).not.toMatch(/standard fields are incomplete/);
  });

  it('an object described from the cache is not hedged', async () => {
    const msg = await phantomAwareNotFoundMessage(
      ctxWith(DEGRADED),
      'CustomField:Contact.Department' as ComponentId,
      'CustomField',
    );
    expect(msg).not.toMatch(/standard fields are incomplete/);
  });
});

describe('standard-field describe gap — object_360 field counts', () => {
  it('names the gap in boundaries for a skipped object, and only then', async () => {
    const degraded = await object360Handler(ctxWith(DEGRADED), { objectApiName: 'Account' });
    if (!degraded.ok) throw new Error(degraded.error.message);
    const b = (degraded.value.data as { boundaries: readonly string[] }).boundaries;
    expect(b.some((s) => /Account's standard fields are incomplete.*lower bound/.test(s))).toBe(true);

    const clean = await object360Handler(ctxWith(BASE), { objectApiName: 'Account' });
    if (!clean.ok) throw new Error(clean.error.message);
    const cb = (clean.value.data as { boundaries: readonly string[] }).boundaries;
    expect(cb.some((s) => /standard fields are incomplete/.test(s))).toBe(false);
  });
});
