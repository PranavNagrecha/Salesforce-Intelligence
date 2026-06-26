/// <reference types="vitest/globals" />

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';
import { z } from 'zod';

import type { Context } from '../../src/server.js';
import {
  MAX_RESPONSE_BYTES,
  RESPONSE_BUDGET_DEFAULT_BYTES,
  jsonResult,
  responseBudgetBytes,
  runTool,
} from '../../src/tools/index.js';

/**
 * Unit tests for the GLOBAL escalating response budget in `jsonResult`
 * (P13-GUARD-global-size) — the single serialization seam every tool response
 * flows through. An MCP client rejects a tool result above its token limit
 * OUTRIGHT (~55 KB observed live), so every oversized envelope is rescued
 * in escalating passes (array truncation → string slimming → structured
 * `oversize` error) instead of being handed to the client as a cryptic harness
 * rejection. Under-budget payloads pass through byte-identical apart from the
 * added `estimatedPayloadBytes`.
 */

/** The text payload a `jsonResult` envelope carries in its single block. */
const envelopeText = (result: ReturnType<typeof jsonResult>): string =>
  (result.content[0] as { readonly text: string }).text;

const VAULT_STATE = {
  sourceTreeHash: 'a'.repeat(64),
  refreshedAt: '2026-05-30T00:00:00.000Z',
} as const;

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

afterEach(() => {
  delete process.env['SFI_MAX_RESPONSE_BYTES'];
});

describe('responseBudgetBytes', () => {
  it('defaults to 40 000 and sits under the hard ceiling', () => {
    expect(responseBudgetBytes()).toBe(RESPONSE_BUDGET_DEFAULT_BYTES);
    expect(RESPONSE_BUDGET_DEFAULT_BYTES).toBeLessThan(MAX_RESPONSE_BYTES);
  });

  it('honors SFI_MAX_RESPONSE_BYTES, clamps it to the hard ceiling, and rejects invalid values', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    expect(responseBudgetBytes()).toBe(8000);
    process.env['SFI_MAX_RESPONSE_BYTES'] = '90000';
    expect(responseBudgetBytes()).toBe(MAX_RESPONSE_BYTES);
    process.env['SFI_MAX_RESPONSE_BYTES'] = '500'; // below the 2 000 floor
    expect(responseBudgetBytes()).toBe(RESPONSE_BUDGET_DEFAULT_BYTES);
    process.env['SFI_MAX_RESPONSE_BYTES'] = 'not-a-number';
    expect(responseBudgetBytes()).toBe(RESPONSE_BUDGET_DEFAULT_BYTES);
  });
});

describe('jsonResult global response budget', () => {
  it('passes an under-budget success body through byte-identical apart from estimatedPayloadBytes', () => {
    const body: McpResponse<{ readonly rows: readonly number[] }> = {
      data: { rows: [1, 2, 3] },
      vaultState: VAULT_STATE,
    };
    const text = envelopeText(jsonResult(body));
    const expected = JSON.stringify({
      ...body,
      estimatedPayloadBytes: bytesOf(JSON.stringify(body)),
    });
    expect(text).toBe(expected); // identity property — proves no behavior change
  });

  it('bounds oversized error envelopes while preserving their error kind', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '4000';
    const body = {
      error: { kind: 'component-not-found', message: 'x'.repeat(50_000) },
    };
    const text = envelopeText(jsonResult(body));
    const parsed = JSON.parse(text) as {
      readonly error: { readonly message: string };
      readonly estimatedPayloadBytes: number;
    };
    expect(bytesOf(text)).toBeLessThanOrEqual(4000);
    expect(parsed.error.message).toContain('bytes trimmed]');
    expect(parsed.estimatedPayloadBytes).toBeGreaterThan(50_000);
  });

  it('passes small string-form error envelopes through with their original shape', () => {
    const unknownTool = {
      error: 'unknown-tool',
      message: "no tool registered with name 'sfi.nope'",
      toolName: 'sfi.nope',
    };
    const parsed = JSON.parse(envelopeText(jsonResult(unknownTool))) as Record<
      string,
      unknown
    >;
    expect(parsed['error']).toBe('unknown-tool');
    expect(typeof parsed['estimatedPayloadBytes']).toBe('number');
  });

  it('bounds oversized primitive responses with a structured oversize error', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '2000';
    const text = envelopeText(jsonResult('x'.repeat(50_000)));
    const parsed = JSON.parse(text) as {
      readonly error: { readonly kind: string };
      readonly estimatedPayloadBytes: number;
    };
    expect(bytesOf(text)).toBeLessThanOrEqual(2000);
    expect(parsed.error.kind).toBe('oversize');
    expect(parsed.estimatedPayloadBytes).toBeGreaterThan(50_000);
  });

  it('keeps the compact fallback bounded when error kinds and narrowing knobs are adversarially long', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '2000';
    const body = {
      error: {
        kind: 'kind-'.repeat(400),
        details: Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [`field-${i}`, i]),
        ),
      },
    };
    const text = envelopeText(
      jsonResult(body, { knobs: Array.from({ length: 8 }, () => 'k'.repeat(500)) }),
    );
    expect(bytesOf(text)).toBeLessThanOrEqual(2000);
    expect(
      (JSON.parse(text) as { readonly error: { readonly kind: string } }).error
        .kind,
    ).toBe('oversize');
  });

  it('pass 1: truncates the largest data array from the tail, fits the cap, and emits pagination hints', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: `Row:${i}`,
      label: `row number ${i} with some padding text`,
    }));
    const body = {
      data: { verdict: 'risky', rows },
      vaultState: VAULT_STATE,
    };
    const text = envelopeText(
      jsonResult(body, { args: { offset: 40 }, knobs: ['limit', 'offset'] }),
    );
    expect(bytesOf(text)).toBeLessThanOrEqual(8000);
    const parsed = JSON.parse(text) as {
      readonly data: {
        readonly verdict: string;
        readonly rows: readonly unknown[];
      };
      readonly responseBudget: {
        readonly truncated: boolean;
        readonly droppedCount: number;
        readonly nextOffset: number;
      };
      readonly estimatedPayloadBytes: number;
    };
    // kill criterion: truncation may trim LISTS, never flip a verdict
    expect(parsed.data.verdict).toBe('risky');
    expect(parsed.responseBudget.truncated).toBe(true);
    expect(parsed.responseBudget.droppedCount).toBeGreaterThan(0);
    expect(parsed.responseBudget.nextOffset).toBe(40 + parsed.data.rows.length);
    expect(parsed.data.rows.length + parsed.responseBudget.droppedCount).toBe(
      400,
    );
    // surviving rows are intact, not sliced or mangled
    expect(parsed.data.rows[0]).toEqual(rows[0]);
  });

  it('pass 2: slims long strings to a head + trim marker when arrays alone cannot fit', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const body = {
      data: { verdict: 'safe', blob: 'y'.repeat(20_000) },
      vaultState: VAULT_STATE,
    };
    const text = envelopeText(jsonResult(body));
    expect(bytesOf(text)).toBeLessThanOrEqual(8000);
    const parsed = JSON.parse(text) as {
      readonly data: { readonly verdict: string; readonly blob: string };
      readonly responseBudget: { readonly stringsSlimmed: number };
    };
    expect(parsed.data.verdict).toBe('safe');
    expect(parsed.data.blob).toContain('bytes trimmed]');
    expect(parsed.responseBudget.stringsSlimmed).toBeGreaterThanOrEqual(1);
  });

  it("pass 3: emits a structured oversize error naming the tool's own narrowing knobs when nothing fits", () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '2000';
    // Unfittable by construction: thousands of small distinct keys — no
    // arrays to truncate, no single long string to slim.
    const wide: Record<string, number> = {};
    for (let i = 0; i < 3000; i += 1) wide[`k${i}`] = i;
    const body = { data: wide, vaultState: VAULT_STATE };
    const text = envelopeText(
      jsonResult(body, { knobs: ['limit', 'typeFilter'] }),
    );
    expect(bytesOf(text)).toBeLessThan(2000);
    const parsed = JSON.parse(text) as {
      readonly error: { readonly kind: string; readonly message: string };
      readonly estimatedPayloadBytes: number;
    };
    expect(parsed.error.kind).toBe('oversize');
    expect(parsed.error.message).toContain('limit, typeFilter');
    expect(parsed.estimatedPayloadBytes).toBeGreaterThan(2000);
  });

  it("never mutates the handler's returned object (escalation works on a clone)", () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: i,
      pad: 'p'.repeat(40),
    }));
    const body = { data: { rows }, vaultState: VAULT_STATE };
    Object.freeze(body.data.rows);
    Object.freeze(body.data);
    Object.freeze(body);
    expect(() => jsonResult(body)).not.toThrow();
    expect(body.data.rows).toHaveLength(400);
  });

  it('property: random nested payloads always fit the cap or fail structured, and never throw', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '4000';
    // Deterministic LCG so the suite is reproducible.
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const randomValue = (depth: number): unknown => {
      const r = rand();
      if (depth >= 3 || r < 0.3) return 'v'.repeat(Math.floor(rand() * 4000));
      if (r < 0.55) return Math.floor(rand() * 1e6);
      if (r < 0.8) {
        return Array.from({ length: Math.floor(rand() * 80) }, () =>
          randomValue(depth + 1),
        );
      }
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rand() * 12) + 1; i += 1) {
        obj[`f${i}`] = randomValue(depth + 1);
      }
      return obj;
    };
    for (let i = 0; i < 50; i += 1) {
      const body = {
        data: { payload: randomValue(0) },
        vaultState: VAULT_STATE,
      };
      const text = envelopeText(jsonResult(body));
      const parsed = JSON.parse(text) as {
        readonly error?: { readonly kind: string };
        readonly estimatedPayloadBytes: number;
      };
      if (parsed.error) {
        expect(parsed.error.kind).toBe('oversize');
        expect(bytesOf(text)).toBeLessThan(4000);
      } else {
        expect(bytesOf(text)).toBeLessThanOrEqual(4000);
      }
      expect(typeof parsed.estimatedPayloadBytes).toBe('number');
    }
  });
});

/**
 * Unit tests for `runTool`'s defensive try/catch (CR-14, Systemic #5). The
 * sole tool-handler call site previously had NO try/catch: a thrown handler
 * (a renderer that throws by design, a `JSON.stringify` TypeError on a
 * BigInt/circular value, any unexpected error) escaped the
 * structured-envelope + byte-budget contract and surfaced as a RAW, UNSIZED
 * JSON-RPC error — crashing the turn, bypassing the size guard, and leaking
 * the raw `error.message` (which can embed org content or a stack trace) to
 * the client. The fix converts an escaped throw into a sized `internal`-kind
 * envelope with a fixed generic message BEFORE the SDK ever sees it.
 */
describe('runTool defensive throw handling', () => {
  // The handler is synthetic in these tests and never reads the Context, so a
  // bare cast keeps the harness free of vault fixtures (mirrors server.test's
  // `fakeCtx = {} as Context`).
  const fakeCtx = {} as Context;
  const emptySchema = z.object({}).passthrough();

  it('converts a handler throw into a bounded internal-error envelope and leaks neither the message nor a stack', async () => {
    const secret = 'org-secret-value exampleuser@example.edu';
    const thrown = `boom ${secret}`;
    // Before the fix this rejected (no try/catch) — asserting it resolves at
    // all is itself a kill criterion.
    const out = await runTool(fakeCtx, {}, emptySchema, async () => {
      throw new Error(thrown);
    });
    const text = (out.content[0] as { readonly text: string }).text;
    const parsed = JSON.parse(text) as {
      readonly error: { readonly kind: string; readonly message: string };
    };

    // ok:false shape with a known, distinguishable kind.
    expect(parsed.error.kind).toBe('internal');
    // The client-facing message is the fixed generic literal.
    expect(parsed.error.message).toBe(
      'An internal error occurred while handling this tool. The server logged the details.',
    );
    // LEAK INVARIANTS: nothing from the throw reaches the client.
    expect(text).not.toContain('boom');
    expect(text).not.toContain('org-secret-value');
    expect(text).not.toContain('exampleuser@example.edu');
    expect(text).not.toContain(' at '); // no stack-frame markers
    // Bounded by the same byte budget as every other envelope.
    expect(bytesOf(text)).toBeLessThanOrEqual(responseBudgetBytes());
  });

  it('also catches a serialize throw (BigInt) the handler returns inside a successful Result', async () => {
    // A handler can return a value `JSON.stringify` itself throws on
    // (a BigInt). That throw originates inside `jsonResult`'s serialize step,
    // which is INSIDE the try — so it must be caught too, not escape.
    const out = await runTool(fakeCtx, {}, emptySchema, async () =>
      ok({
        data: { b: 10n },
        vaultState: VAULT_STATE,
      } as unknown as McpResponse<unknown>),
    );
    const text = (out.content[0] as { readonly text: string }).text;
    const parsed = JSON.parse(text) as {
      readonly error: { readonly kind: string };
    };
    expect(parsed.error.kind).toBe('internal');
    expect(bytesOf(text)).toBeLessThanOrEqual(responseBudgetBytes());
  });

  it('leaves a normal ok response transparent (try wrapper changes nothing on the happy path)', async () => {
    const body: McpResponse<{ readonly rows: readonly number[] }> = {
      data: { rows: [1, 2, 3] },
      vaultState: VAULT_STATE,
    };
    const out = await runTool(fakeCtx, {}, emptySchema, async () => ok(body));
    const text = (out.content[0] as { readonly text: string }).text;
    const parsed = JSON.parse(text) as {
      readonly data: { readonly rows: readonly number[] };
      readonly estimatedPayloadBytes: number;
      readonly error?: unknown;
    };
    expect(parsed.error).toBeUndefined();
    expect(parsed.data.rows).toEqual([1, 2, 3]);
    expect(typeof parsed.estimatedPayloadBytes).toBe('number');
  });

  it('does NOT double-wrap a structural err — a returned McpError keeps its own kind', async () => {
    const out = await runTool(fakeCtx, {}, emptySchema, async () =>
      err({
        kind: 'component-not-found',
        message: 'X',
      } satisfies McpError),
    );
    const text = (out.content[0] as { readonly text: string }).text;
    const parsed = JSON.parse(text) as {
      readonly error: { readonly kind: string };
    };
    // The catch fires only on a THROW; a returned err flows the normal path.
    expect(parsed.error.kind).toBe('component-not-found');
    expect(parsed.error.kind).not.toBe('internal');
  });
});
