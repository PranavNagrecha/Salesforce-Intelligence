/// <reference types="vitest/globals" />

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  listEdges,
  openGraph,
  openGraphReadOnly,
  type GraphStore,
} from '@sf-intelligence/graph';
import { renderOrgCard } from '@sf-intelligence/renderers';

import { buildOrgCardInput } from '../src/org-card-input.js';

/**
 * P13-CARD-render — "every number re-derivable from graph/manifest": build a
 * small synthetic graph, assemble the card input, and re-derive each headline
 * number with direct queries. The card may never claim a number the graph
 * does not produce.
 */

const node = (
  id: string,
  type: string,
  apiName: string,
  properties: Record<string, unknown> = {},
): ExtractionResult['nodes'][number] =>
  ({
    id,
    type,
    apiName,
    label: apiName,
    parentId: null,
    sourcePath: `source/${type}/${apiName}`,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties,
  }) as never;

const edge = (
  fromId: string,
  toId: string,
  edgeType: string,
): NonNullable<ExtractionResult['edges']>[number] =>
  ({ fromId, toId, edgeType, confidence: 'declared', source: 'test', properties: {} }) as never;

const FIXTURE: ExtractionResult = {
  nodes: [
    node('CustomObject:Alpha__c', 'CustomObject', 'Alpha__c'),
    node('CustomObject:Beta__c', 'CustomObject', 'Beta__c'),
    node('CustomField:Alpha__c.Score__c', 'CustomField', 'Alpha__c.Score__c'),
    node('Flow:Active_Flow', 'Flow', 'Active_Flow', { status: 'Active' }),
    node('Flow:Draft_Flow', 'Flow', 'Draft_Flow', { status: 'Draft' }),
    node('ApexClass:AlphaService', 'ApexClass', 'AlphaService'),
    node('Profile:Root_Admin', 'Profile', 'Root_Admin', {
      userPermissions: ['ViewAllData', 'ApiEnabled'],
    }),
    node('PermissionSet:Read_Only', 'PermissionSet', 'Read_Only', {
      userPermissions: ['ApiEnabled'],
    }),
    node('NamedCredential:Billing_API', 'NamedCredential', 'Billing_API'),
  ],
  edges: [
    // Alpha gets two real inbound dependencies + one structural parentOf
    // (which centrality must EXCLUDE); Beta gets one.
    edge('ApexClass:AlphaService', 'CustomObject:Alpha__c', 'readsFrom'),
    edge('Flow:Active_Flow', 'CustomObject:Alpha__c', 'triggersOn'),
    edge('CustomObject:Alpha__c', 'CustomField:Alpha__c.Score__c', 'parentOf'),
    edge('Flow:Draft_Flow', 'CustomObject:Beta__c', 'triggersOn'),
  ],
} as never;

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  sourceOrg: 'card-input-fixture',
  components: {
    CustomObject: 2,
    CustomField: 1,
    Flow: 2,
    ApexClass: 1,
    Profile: 1,
    PermissionSet: 1,
    NamedCredential: 1,
  },
  edges: { readsFrom: 1, triggersOn: 2, parentOf: 1 },
  sourceTreeHash: 'sha256:card-input-fixture',
} as never;

let tempDir: string;
let store: GraphStore;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-org-card-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [FIXTURE]);
  if (!imported.ok) throw new Error(imported.error.message);
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('buildOrgCardInput', () => {
  it('derives every headline number from the graph/manifest (re-derivable)', async () => {
    const input = await buildOrgCardInput(MANIFEST, store, '2026-06-10T00:00:00.000Z');

    // Scale — straight from the manifest.
    expect(input.totalComponents).toBe(9);
    expect(input.totalEdges).toBe(4);
    expect(input.componentCounts[0]).toEqual(['CustomObject', 2]);

    // Centrality — re-derive Alpha's inbound count directly and compare:
    // 3 inbound edges minus the structural parentOf = 2.
    const alphaEdges = await listEdges(store, 'CustomObject:Alpha__c' as never, {
      direction: 'in',
    });
    expect(alphaEdges.ok).toBe(true);
    const expectedAlpha = alphaEdges.ok
      ? alphaEdges.value.filter((e) => e.edgeType !== 'parentOf').length
      : -1;
    expect(input.topObjects[0]).toEqual({ id: 'CustomObject:Alpha__c', inboundRefs: expectedAlpha });
    expect(expectedAlpha).toBe(2);
    expect(input.topObjects[1]).toEqual({ id: 'CustomObject:Beta__c', inboundRefs: 1 });
    expect(input.objectScanCount).toBe(2);

    // Automation density — Active_Flow counts, Draft_Flow does not.
    const flowRow = input.automation.find((a) => a.type === 'Flow');
    expect(flowRow).toEqual({ type: 'Flow', total: 2, active: 1 });

    // Permissions posture — exactly the Profile holds god-mode.
    expect(input.permissions).toEqual({
      profileCount: 1,
      permissionSetCount: 1,
      godModeContainers: 1,
      godModeScanCount: 2,
    });

    // Integration surface — the one NamedCredential, nothing invented.
    expect(input.integrations).toEqual([['NamedCredential', 1]]);

    // Stamps pass through untouched.
    expect(input.generatedAt).toBe('2026-06-10T00:00:00.000Z');
    expect(input.refreshedAt).toBe(MANIFEST.refreshedAt);
    expect(input.sourceTreeHash).toBe(MANIFEST.sourceTreeHash);
  });
});

/**
 * CR-RV15 — the committed demo org-card is a STATIC artifact: it is shipped in
 * `examples/demo-vault/meta/org-card.json` but generated from that vault's
 * graph + manifest. Nothing tied the two together, so the JSON could silently
 * drift from what the generator produces (e.g. a renderer/`buildOrgCardInput`
 * change lands without regenerating the demo card) and ship a stale,
 * misleading example.
 *
 * This guard re-runs the real generation pipeline (`buildOrgCardInput` →
 * `renderOrgCard(...).json`) over the demo vault's COMMITTED graph + manifest
 * and asserts it equals the committed `org-card.json` byte-for-byte, except the
 * wall-clock `generatedAt` stamp (neutralized — it is the only non-graph,
 * non-manifest field). When it fails, regenerate the demo card via
 * `sfi refresh` over the demo vault (or update the committed JSON to match).
 *
 * The committed graph is opened from a TEMP COPY in READ-ONLY mode so the test
 * can never mutate or lock the shipped artifact.
 */
describe('demo org-card.json drift guard (CR-RV15)', () => {
  // packages/cli/test → repo root is three levels up.
  const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
  const VAULT = join(REPO_ROOT, 'examples', 'demo-vault');
  const GRAPH = join(VAULT, 'graph', 'graph.duckdb');
  const MANIFEST_PATH = join(VAULT, 'meta', 'manifest.json');
  const CARD_PATH = join(VAULT, 'meta', 'org-card.json');

  it('committed demo card matches a fresh regeneration from the demo vault', async () => {
    // Fail loudly (not silently skip) if the demo vault is missing — the
    // committed example is part of the product surface.
    expect(existsSync(GRAPH)).toBe(true);
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    expect(existsSync(CARD_PATH)).toBe(true);

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as VaultManifest;
    const committed = JSON.parse(readFileSync(CARD_PATH, 'utf8')) as Record<string, unknown>;

    const tmp = mkdtempSync(join(tmpdir(), 'sfi-demo-card-'));
    try {
      // Copy then open READ-ONLY so the committed graph is never touched.
      const dbCopy = join(tmp, 'graph.duckdb');
      copyFileSync(GRAPH, dbCopy);
      const opened = await openGraphReadOnly(dbCopy);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const store = opened.value;
      try {
        // Inject the committed `generatedAt` so the ONLY wall-clock field is
        // identical by construction; every other field is graph/manifest-derived.
        const input = await buildOrgCardInput(
          manifest,
          store,
          committed['generatedAt'] as string,
        );
        const regenerated = renderOrgCard(input).json;

        // Canonical-JSON compare: identical key/value content regardless of
        // file whitespace. A drift in ANY derived field fails here.
        expect(regenerated).toEqual(committed);
      } finally {
        await closeGraph(store);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
