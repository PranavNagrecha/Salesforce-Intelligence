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
