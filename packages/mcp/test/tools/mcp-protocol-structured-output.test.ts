/**
 * Text-only tool results: no `outputSchema` on any tool, no `structuredContent`
 * on any result.
 *
 * Every result used to carry the envelope twice: as JSON text and as an
 * identical `structuredContent` object, with one generic `outputSchema` stamped
 * on every tool. Each host puts ONE of the two copies in front of its model, so
 * the second copy only doubled the wire bytes, and the schema added ~19.5 KB to
 * the default tools/list while describing nothing tool-specific.
 *
 * The two must go TOGETHER. The MCP TypeScript SDK client caches each tool's
 * outputSchema from tools/list and THROWS on a non-error result that lacks
 * `structuredContent` ("has an output schema but did not return structured
 * content"). Dropping only `structuredContent` would break every such client.
 * These tests pin both halves so the half-state cannot come back.
 */
import type { McpResponse } from '@sf-intelligence/contracts';
import { describe, expect, it } from 'vitest';

import {
  V01_TOOLS,
  advertisedTools,
  jsonResult,
} from '../../src/tools/index.js';

const VAULT_STATE = {
  sourceTreeHash: 'a'.repeat(64),
  refreshedAt: '2026-05-30T00:00:00.000Z',
} as const;

describe('text-only results (no outputSchema, no structuredContent)', () => {
  it('no roster tool carries an outputSchema', () => {
    expect(V01_TOOLS.length).toBeGreaterThan(0);
    for (const tool of V01_TOOLS) {
      expect('outputSchema' in tool, tool.name).toBe(false);
    }
  });

  it('no advertised tool carries an outputSchema, under either profile', () => {
    for (const profile of ['core', 'full'] as const) {
      const tools = advertisedTools(profile);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect('outputSchema' in tool, `${profile}:${tool.name}`).toBe(false);
      }
    }
  });

  it('FAIL-BEFORE/PASS-AFTER: a success envelope is sent once, as text', () => {
    const body: McpResponse<{ readonly rows: readonly number[] }> = {
      data: { rows: [1, 2, 3] },
      vaultState: VAULT_STATE,
    };
    const out = jsonResult(body);
    expect('structuredContent' in out).toBe(false);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]?.type).toBe('text');
    const parsed = JSON.parse((out.content[0] as { readonly text: string }).text) as Record<
      string,
      unknown
    >;
    expect(parsed).toMatchObject({ data: { rows: [1, 2, 3] }, vaultState: VAULT_STATE });
    expect(typeof parsed['estimatedPayloadBytes']).toBe('number');
  });

  it('an error envelope is sent once, as text', () => {
    const out = jsonResult({
      error: { kind: 'invalid-query', message: 'bad args' },
    });
    expect('structuredContent' in out).toBe(false);
    const text = (out.content[0] as { readonly text: string }).text;
    expect(JSON.parse(text)).toMatchObject({
      error: { kind: 'invalid-query', message: 'bad args' },
    });
  });

  it('a non-object body is sent once, as raw JSON text', () => {
    const out = jsonResult([1, 2]);
    expect('structuredContent' in out).toBe(false);
    expect((out.content[0] as { readonly text: string }).text).toBe('[1,2]');
  });
});
