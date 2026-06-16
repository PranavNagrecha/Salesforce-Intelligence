import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/server.js';
import {
  baselineAcknowledgeHandler,
  baselineStatusHandler,
} from '../../src/tools/baseline-findings.js';

const manifest: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T12:00:00.000Z',
  sourceOrg: 'test',
  components: {},
  edges: {},
  sourceTreeHash: 'abc',
};

const makeCtx = (vaultRoot: string): Context => ({
  vaultRoot,
  manifest,
  graph: {} as Context['graph'],
});

describe('baseline findings tools', () => {
  it('acknowledges and lists a suppressed finding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-baseline-mcp-'));
    try {
      const ctx = makeCtx(root);
      const ack = await baselineAcknowledgeHandler(ctx, {
        tool: 'sfi.crud_fls_audit',
        rule: 'missing-crud-check',
        componentId: 'ApexClass:Foo',
        location: 'method bar',
        note: 'reviewed',
      });
      expect(ack.ok).toBe(true);
      const status = await baselineStatusHandler(ctx, {});
      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.value.data.totalSuppressed).toBe(1);
        expect(status.value.data.findings[0]?.note).toBe('reviewed');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
