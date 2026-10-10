/// <reference types="vitest/globals" />

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { McpResponse } from '@sf-intelligence/contracts';
import { ok } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../../src/server.js';
import { runTool } from '../../src/tools/index.js';

/**
 * `stampVaultDisclosure` runs at the single dispatch choke point every tool
 * response passes through (`runTool` on success), so a reader sees WHICH org /
 * WHICH on-disk vault / WHICH builder version produced the answer on the FIRST
 * call. It is exercised here through the exported `runTool` seam (the same
 * driver the response-size guard tests use with a synthetic `{} as Context`).
 *
 * Two invariants: the three disclosure fields are stamped from the ctx, and a
 * vaultRoot under $HOME is collapsed to `~` so the OS username never leaks
 * (critical over the HTTP transport). A minimal ctx stays byte-transparent.
 */
const emptySchema = z.object({}).passthrough();

const VAULT_STATE = {
  sourceTreeHash: 'a'.repeat(64),
  refreshedAt: '2026-05-30T00:00:00.000Z',
} as const;

const body: McpResponse<{ readonly ok: boolean }> = {
  data: { ok: true },
  vaultState: VAULT_STATE,
};

/** Drive `runTool` with `ctx` and a trivial ok handler; return the parsed envelope + raw text. */
const stamp = async (
  ctx: Context,
): Promise<{
  readonly text: string;
  readonly vaultState: Record<string, unknown>;
  readonly data: unknown;
}> => {
  const out = await runTool(ctx, {}, emptySchema, async () => ok(body));
  const text = (out.content[0] as { readonly text: string }).text;
  const parsed = JSON.parse(text) as {
    readonly vaultState: Record<string, unknown>;
    readonly data: unknown;
  };
  return { text, vaultState: parsed.vaultState, data: parsed.data };
};

describe('stampVaultDisclosure via runTool', () => {
  it('stamps targetOrg, builderVersion, and vaultPath from the ctx manifest + vaultRoot', async () => {
    const ctx = {
      vaultRoot: '/some/abs/org-kb',
      manifest: { sourceOrg: 'MyOrg', version: '9.9.9' },
    } as unknown as Context;
    const { vaultState } = await stamp(ctx);
    expect(vaultState['targetOrg']).toBe('MyOrg');
    expect(vaultState['builderVersion']).toBe('9.9.9');
    // Path is outside $HOME (a synthetic absolute) so it is disclosed as-is.
    expect(vaultState['vaultPath']).toBe('/some/abs/org-kb');
    // Pre-existing vaultState fields survive the stamp.
    expect(vaultState['sourceTreeHash']).toBe(VAULT_STATE.sourceTreeHash);
    expect(vaultState['refreshedAt']).toBe(VAULT_STATE.refreshedAt);
  });

  it('collapses a vaultRoot under $HOME to ~ and never leaks the home path', async () => {
    const home = homedir();
    const underHome = join(home, 'code', 'demo', 'org-kb');
    const ctx = {
      vaultRoot: underHome,
      manifest: { sourceOrg: 'MyOrg', version: '9.9.9' },
    } as unknown as Context;
    const { text, vaultState } = await stamp(ctx);
    const vaultPath = vaultState['vaultPath'] as string;
    expect(vaultPath.startsWith('~')).toBe(true);
    expect(vaultPath).not.toContain(home);
    // LEAK INVARIANT: the raw home prefix must never appear anywhere in the
    // serialized envelope handed to the client.
    expect(text).not.toContain(home);
  });

  it('stays byte-transparent for a minimal `{} as Context` (no disclosure fields, no throw)', async () => {
    const { vaultState, data } = await stamp({} as Context);
    expect(vaultState['targetOrg']).toBeUndefined();
    expect(vaultState['builderVersion']).toBeUndefined();
    expect(vaultState['vaultPath']).toBeUndefined();
    // The handler payload and pre-existing vaultState pass through untouched.
    expect(data).toEqual({ ok: true });
    expect(vaultState['sourceTreeHash']).toBe(VAULT_STATE.sourceTreeHash);
  });
});

/**
 * ARCH-02 / ADM-2 / DEV-09 (FAIL-BEFORE/PASS-AFTER): a vault built by an older
 * sf-intelligence used to be served silently — only safe_to_delete_field
 * warned, so get_impact / find_component_usages could report
 * `soundness.complete: true` while a current builder would find more. The
 * dispatcher now applies ONE shared freshness assessment to every response.
 */
describe('vault freshness stamp via runTool', () => {
  const PLUGIN_ENV = 'SFI_PLUGIN_VERSION';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[PLUGIN_ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[PLUGIN_ENV];
    else process.env[PLUGIN_ENV] = saved;
  });

  const impactBody = {
    data: {
      nodes: [],
      soundness: { complete: true, blindSpots: [], staticCoverage: 'full' },
      trust: {
        provenance: 'offline_snapshot',
        confidence: 'declared',
        freshness: {},
        completeness: { status: 'complete' },
        limitations: [],
      },
    },
    vaultState: VAULT_STATE,
  };

  const run = async (ctx: Context): Promise<Record<string, unknown>> => {
    const out = await runTool(ctx, {}, emptySchema, async () => ok(impactBody));
    return JSON.parse((out.content[0] as { readonly text: string }).text) as Record<string, unknown>;
  };

  it('downgrades completeness and names the drift when the builder is older than the running version', async () => {
    process.env[PLUGIN_ENV] = '0.3.3';
    const ctx = {
      vaultRoot: '/some/abs/org-kb',
      manifest: { version: '0.2.0', refreshedAt: new Date().toISOString() },
    } as unknown as Context;
    const env = await run(ctx);
    const data = env['data'] as {
      soundness: { complete: boolean; staticCoverage: string; blindSpots: { kind: string }[] };
      trust: { completeness: { status: string }; limitations: string[]; freshness: Record<string, unknown> };
    };
    expect(data.soundness.complete).toBe(false);
    expect(data.soundness.staticCoverage).toBe('partial');
    expect(data.soundness.blindSpots.map((b) => b.kind)).toContain('stale-builder');
    expect(data.trust.completeness.status).toBe('partial');
    expect(data.trust.limitations[0]).toContain('0.2.0');
    expect(data.trust.limitations[0]).toContain('sfi refresh');
    // The edge families added since the builder are named.
    expect(data.trust.limitations[0]).toContain('OmniStudio');
    // An empty trust.freshness is filled from the manifest.
    expect(data.trust.freshness['snapshotRefreshedAt']).toBeDefined();
    const vs = env['vaultState'] as { freshness?: { builderStale?: { builtBy: string; running: string } } };
    expect(vs.freshness?.builderStale).toEqual({ builtBy: '0.2.0', running: '0.3.3' });
  });

  it('FAIL-BEFORE/PASS-AFTER: a 0.3.3 vault served by a newer build names the edge families added since', async () => {
    process.env[PLUGIN_ENV] = '0.4.0';
    const ctx = {
      vaultRoot: '/some/abs/org-kb',
      manifest: { version: '0.3.3', refreshedAt: new Date().toISOString() },
    } as unknown as Context;
    const env = await run(ctx);
    const lim = (env['data'] as { trust: { limitations: string[] } }).trust.limitations[0];
    expect(lim).toContain('Apex Custom Label reference edges');
    expect(lim).toContain('method-level LWC/Aura -> Apex caller edges');
    // Families the 0.3.3 builder already extracted are not listed again.
    expect(lim).not.toContain('OmniStudio');
  });

  it('reports an old vault by age band, without touching completeness', async () => {
    process.env[PLUGIN_ENV] = '0.3.3';
    const ctx = {
      vaultRoot: '/some/abs/org-kb',
      manifest: { version: '0.3.3', refreshedAt: '2020-01-01T00:00:00.000Z' },
    } as unknown as Context;
    const env = await run(ctx);
    const data = env['data'] as {
      soundness: { complete: boolean };
      trust: { completeness: { status: string }; limitations: string[] };
    };
    expect(data.soundness.complete).toBe(true);
    expect(data.trust.completeness.status).toBe('complete');
    expect(data.trust.limitations[0]).toContain('>90d');
    expect((env['vaultState'] as { freshness?: { ageBand?: string } }).freshness?.ageBand).toBe('>90d');
  });

  it('leaves a fresh, current-builder answer untouched apart from naming its snapshot', async () => {
    process.env[PLUGIN_ENV] = '0.3.3';
    const refreshedAt = new Date().toISOString();
    const ctx = {
      vaultRoot: '/some/abs/org-kb',
      manifest: { version: '0.3.3', refreshedAt },
    } as unknown as Context;
    const env = await run(ctx);
    expect(env['data']).toEqual({
      ...impactBody.data,
      trust: { ...impactBody.data.trust, freshness: { snapshotRefreshedAt: refreshedAt } },
    });
    expect((env['vaultState'] as Record<string, unknown>)['freshness']).toBeUndefined();
  });
});
