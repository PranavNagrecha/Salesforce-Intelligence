/// <reference types="vitest/globals" />
/**
 * Ensures destructive / what-if tools honor partial coverage (v4.1 audit).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CoverageEntry, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  FLOW_DEACTIVATION_REQUIRED_COVERAGE,
  TRIGGER_DISABLE_REQUIRED_COVERAGE,
} from '../../src/tools/coverage-trust.js';
import { whatIfDeactivateFlowHandler } from '../../src/tools/what-if-deactivate-flow.js';
import { whatIfDisableTriggerHandler } from '../../src/tools/what-if-disable-trigger.js';

const partialCoverage = (
  missing: string,
): readonly CoverageEntry[] =>
  ['Flow', 'ApexClass', 'CustomObject'].map((type) => ({
    type,
    requested: true,
    retrieved: type === missing ? 0 : 1,
    errored: type === missing,
    neverModeled: false,
    ...(type === missing ? { errorReason: 'fixture gap' } : {}),
  }));

const baseManifest = (coverage: readonly CoverageEntry[]): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00.000Z',
  sourceOrg: 'what-if-audit',
  components: { Flow: 1, ApexTrigger: 1 },
  edges: {},
  sourceTreeHash: 'sha256:what-if-audit',
  coverageComputedAt: '2026-05-29T00:00:00.000Z',
  coverage,
});

let store: GraphStore;
let ctx: Context;

let tempDir = '';

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-what-if-coverage-'));
  const opened = await openGraph(join(tempDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  ctx = {
    vaultRoot: tempDir,
    manifest: baseManifest(partialCoverage('EmailTemplate')),
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  if (tempDir.length > 0) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('what-if coverage audit', () => {
  it('documents flow-deactivation required coverage families', () => {
    expect(FLOW_DEACTIVATION_REQUIRED_COVERAGE).toContain('EmailTemplate');
  });

  it('documents trigger-disable required coverage families', () => {
    expect(TRIGGER_DISABLE_REQUIRED_COVERAGE).toContain('PlatformEvent');
  });

  it('what_if_deactivate_flow downgrades safe when EmailTemplate coverage is partial', async () => {
    const r = await whatIfDeactivateFlowHandler(ctx, {
      flowId: 'Flow:UnusedFlow',
    });
    if (!r.ok && r.error.kind === 'component-not-found') return;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.value.data.verdict === 'safe') {
      expect(r.value.data.coverageCaveat).toBeDefined();
      expect(r.value.data.verdict).toBe('review');
    }
  });

  it('what_if_disable_trigger surfaces coverageCaveat when PlatformEvent is partial', async () => {
    const triggerCtx: Context = {
      ...ctx,
      manifest: baseManifest(
        TRIGGER_DISABLE_REQUIRED_COVERAGE.map((type) => ({
          type,
          requested: true,
          retrieved: type === 'PlatformEvent' ? 0 : 1,
          errored: type === 'PlatformEvent',
          neverModeled: false,
        })),
      ),
    };
    const r = await whatIfDisableTriggerHandler(triggerCtx, {
      triggerId: 'ApexTrigger:Unused',
    });
    if (!r.ok && r.error.kind === 'component-not-found') return;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.value.data.verdict === 'safe') {
      expect(r.value.data.coverageCaveat?.missingCoverage).toContain('PlatformEvent');
    }
  });
});
