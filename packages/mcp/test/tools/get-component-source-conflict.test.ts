/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import { componentPath } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { getComponentHandler } from '../../src/tools/get-component.js';

/**
 * DUPLICATE-SOURCE end-to-end, at the surface a user actually reads.
 *
 * The vault holds one profile twice: an older flat copy that grants a step-up
 * auth bypass, and the current Salesforce DX copy that does not. `get_component`
 * must (a) answer from the DX copy, and (b) say out loud that a second copy
 * exists and was NOT merged — because if the flat copy were in fact the newer
 * one, the answer would be a false DENIAL, and the reader has to be able to see
 * that possibility rather than be handed a settled-looking answer.
 *
 * Names are invented; nothing here comes from a real org.
 */
const PROFILE_ID = 'Profile:Depot_Supervisor';
const DX_PATH = 'source/main/default/profiles/Depot_Supervisor.profile-meta.xml';
const FLAT_PATH = 'source/profiles/Depot_Supervisor.profile-meta.xml';
const BYPASS_PERMISSION = 'SkipStepUpAuthOnUi';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Profile: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const profileNode = (sourcePath: string, userPermissions: readonly string[]): Node => ({
  id: PROFILE_ID,
  type: 'Profile',
  apiName: 'Depot_Supervisor',
  label: 'Depot_Supervisor',
  parentId: null,
  sourcePath,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { userPermissions },
});

const currentCopy: ExtractionResult = {
  nodes: [profileNode(DX_PATH, ['ViewDepotRoutes'])],
  edges: [],
};
const staleCopy: ExtractionResult = {
  nodes: [profileNode(FLAT_PATH, [BYPASS_PERMISSION, 'ViewDepotRoutes'])],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-source-conflict-'));
  const opened = await openGraph(join(tempDir, 'source-conflict.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  // Walk order on a real vault: `main/` sorts before `profiles/`, so the STALE
  // flat copy is the LAST writer. That ordering is what let it win before.
  const imported = await importExtractionResults(store, [currentCopy, staleCopy]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };

  const full = componentPath(tempDir, 'Profile', null, 'Depot_Supervisor');
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    ['---', `id: ${PROFILE_ID}`, 'type: Profile', '---', '', '# Depot_Supervisor', ''].join('\n'),
  );
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('get_component with a duplicated source tree', () => {
  it('does not report a permission the current retrieval no longer declares', async () => {
    const result = await getComponentHandler(ctx, { id: PROFILE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.properties['userPermissions']).toEqual(['ViewDepotRoutes']);
  });

  it('discloses the second copy at the TOP LEVEL of the response', async () => {
    const result = await getComponentHandler(ctx, { id: PROFILE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const conflict = result.value.data.sourceConflict;
    expect(conflict).toBeDefined();
    expect(conflict?.['paths']).toEqual([DX_PATH, FLAT_PATH]);
    expect(conflict?.['chosenPath']).toBe(DX_PATH);
    expect(String(conflict?.['disclosure'])).toContain('NOT merged');
  });

  it('keeps the disclosure on the metadata-probe path, where properties get dropped', async () => {
    // `maxBodyBytes: 0` builds a bounded projection that omits large property
    // entries. The one property that must never be the omitted one is this.
    const result = await getComponentHandler(ctx, { id: PROFILE_ID, maxBodyBytes: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.metadataOnly).toBe(true);
    expect(result.value.data.sourceConflict).toBeDefined();
  });
});
