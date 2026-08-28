/// <reference types="vitest/globals" />

/**
 * `composeApprovalProcessChain` — the approval-chain composer.
 *
 * Hermetic: a hand-built fixture graph, no org, no live plane.
 *
 * R6 finding under test: `readHookActions` decided whether a hook-list family
 * (`initialSubmissionActions` / `finalApprovalActions` / `finalRejectionActions`
 * / `recallActions`) was EXTRACTED with `key in node.properties` — the `in`
 * operator walks the whole prototype chain, not just the node's own keys. The
 * shared `familyWasExtracted` (`absence-disclosure.ts`) exists precisely
 * because that divergence already burned five other surfaces: a property
 * visible only via the object's prototype reads as "extracted" under `in`
 * even though the node itself never carried it, which is exactly the
 * NEVER-SCANNED-collapses-into-SCANNED-AND-CLEAN failure the typed-absence
 * law forbids.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { composeApprovalProcessChain } from '../../src/tools/action-chain-approval.js';

const PROCESS_ID = 'ApprovalProcess:Opportunity.Prototype_Poisoned';

const baseNode = (properties: Readonly<Record<string, unknown>>): Node => ({
  id: PROCESS_ID,
  type: 'ApprovalProcess',
  apiName: 'Opportunity.Prototype_Poisoned',
  label: null,
  parentId: 'CustomObject:Opportunity',
  sourcePath: 'x.approvalProcess-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-action-chain-approval-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  ctx = {
    vaultRoot: tempDir,
    manifest: {
      version: '0.1.0',
      refreshedAt: '2026-06-08T00:00:00Z',
      sourceOrg: 'me@example.com',
      components: {},
      edges: {},
      sourceTreeHash: 'sha256:fixture',
    },
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('composeApprovalProcessChain — hook-list extraction is decided by OWN property, never the prototype chain', () => {
  it('treats a hook-list key visible ONLY via the properties prototype as NOT extracted', async () => {
    // The node's own `properties` object never sets `initialSubmissionActions`
    // at all — the key is reachable only by walking the prototype, exactly
    // the shape `familyWasExtracted`'s hasOwnProperty check guards against.
    // (A hand-shared "defaults" prototype merged under real properties is a
    // realistic way for this to happen outside the DB's own JSON.parse path —
    // this composer takes a `Node` directly, it does not require callers to
    // route through the graph store.)
    const poisonedProto = { initialSubmissionActions: [] as const };
    const properties: Readonly<Record<string, unknown>> = Object.assign(
      Object.create(poisonedProto) as Record<string, unknown>,
      {
        active: true,
        allowRecall: false,
        recordEditability: 'AdminOnly',
        stepCount: 0,
        steps: [],
        // Deliberately NOT set as an own property: initialSubmissionActions.
        finalApprovalActions: [],
        finalRejectionActions: [],
        recallActions: [],
        allowedSubmitters: [],
      },
    );
    // Sanity check on the fixture itself: `in` sees the inherited key, an own
    // hasOwnProperty check does not. If this ever stops being true the test
    // fixture no longer exercises the divergence.
    expect('initialSubmissionActions' in properties).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(properties, 'initialSubmissionActions')).toBe(
      false,
    );

    const process = baseNode(properties);
    const result = await composeApprovalProcessChain(ctx, process, 'Opportunity', {
      outcome: 'all',
      nestedSaveDepth: 0,
      soeDisclosureSink: new Set(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const initial = result.value.chain.find((s) => s.phase === 'initial-submission-actions');
    expect(initial).toBeDefined();
    // Correct: this node was never extracted for this family — a COVERAGE
    // HOLE, not a declared org fact that no action fires.
    expect(initial?.resolution).toBe('unresolved');
    expect(initial?.unresolvedReason).toContain('COVERAGE HOLE');
    expect(initial?.absenceBasis).toBeUndefined();
  });

  it('still reports verified-none for a hook list genuinely OWNED and empty on the node', async () => {
    // Control case: the property IS the node's own key, just an empty array —
    // must stay 'verified-none', proving the fix does not flip the other axis.
    const properties: Readonly<Record<string, unknown>> = {
      active: true,
      allowRecall: false,
      recordEditability: 'AdminOnly',
      stepCount: 0,
      steps: [],
      initialSubmissionActions: [],
      finalApprovalActions: [],
      finalRejectionActions: [],
      recallActions: [],
      allowedSubmitters: [],
    };
    const process = baseNode(properties);
    const result = await composeApprovalProcessChain(ctx, process, 'Opportunity', {
      outcome: 'all',
      nestedSaveDepth: 0,
      soeDisclosureSink: new Set(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const initial = result.value.chain.find((s) => s.phase === 'initial-submission-actions');
    expect(initial?.resolution).toBe('verified-none');
    expect(initial?.absenceBasis).toContain('DECLARED absence read directly off the component');
  });
});
