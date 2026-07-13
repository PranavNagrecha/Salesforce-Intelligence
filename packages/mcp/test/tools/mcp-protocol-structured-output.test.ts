/**
 * MCP-01 (b) — shared outputSchema on every roster tool + structuredContent
 * on jsonResult envelopes (text content retained for backward compatibility).
 */
import type { McpResponse } from '@sf-intelligence/contracts';
import { describe, expect, it } from 'vitest';


import {
  MCP_TOOL_OUTPUT_SCHEMA,
  V01_TOOLS,
  advertisedTools,
  jsonResult,
} from '../../src/tools/index.js';

const VAULT_STATE = {
  sourceTreeHash: 'a'.repeat(64),
  refreshedAt: '2026-05-30T00:00:00.000Z',
} as const;

describe('MCP-01 (b) outputSchema + structuredContent', () => {
  it('stamps the shared MCP_TOOL_OUTPUT_SCHEMA on every V01_TOOLS entry', () => {
    expect(V01_TOOLS.length).toBeGreaterThan(0);
    expect(MCP_TOOL_OUTPUT_SCHEMA.type).toBe('object');
    for (const tool of V01_TOOLS) {
      expect(tool.outputSchema, tool.name).toBe(MCP_TOOL_OUTPUT_SCHEMA);
      expect(tool.outputSchema.type, tool.name).toBe('object');
    }
  });

  it('advertisedTools carries the same outputSchema', () => {
    for (const tool of advertisedTools()) {
      expect(tool.outputSchema).toBe(MCP_TOOL_OUTPUT_SCHEMA);
    }
  });

  it('jsonResult returns structuredContent matching the text envelope', () => {
    const body: McpResponse<{ readonly rows: readonly number[] }> = {
      data: { rows: [1, 2, 3] },
      vaultState: VAULT_STATE,
    };
    const out = jsonResult(body);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]?.type).toBe('text');
    const text = (out.content[0] as { readonly text: string }).text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(out.structuredContent).toEqual(parsed);
    expect(out.structuredContent).toMatchObject({
      data: { rows: [1, 2, 3] },
      vaultState: VAULT_STATE,
    });
    expect(typeof out.structuredContent?.['estimatedPayloadBytes']).toBe(
      'number',
    );
  });

  it('jsonResult keeps text for hosts that only read content', () => {
    const out = jsonResult({
      error: { kind: 'invalid-query', message: 'bad args' },
    });
    const text = (out.content[0] as { readonly text: string }).text;
    expect(text).toContain('"kind":"invalid-query"');
    expect(out.structuredContent?.['error']).toEqual({
      kind: 'invalid-query',
      message: 'bad args',
    });
  });
});
