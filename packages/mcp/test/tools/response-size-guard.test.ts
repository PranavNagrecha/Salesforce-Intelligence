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
  it('passes an under-budget success body through with contentPolicy + estimatedPayloadBytes', () => {
    const body: McpResponse<{ readonly rows: readonly number[] }> = {
      data: { rows: [1, 2, 3] },
      vaultState: VAULT_STATE,
    };
    const text = envelopeText(jsonResult(body));
    const parsed = JSON.parse(text) as {
      readonly data: unknown;
      readonly contentPolicy: {
        readonly orgMetadata: string;
        readonly disclosure: string;
      };
      readonly estimatedPayloadBytes: number;
    };
    expect(parsed.data).toEqual(body.data);
    expect(parsed.contentPolicy.orgMetadata).toBe('untrusted-data');
    expect(parsed.contentPolicy.disclosure).toContain('untrusted DATA');
    // estimatedPayloadBytes is the stamped payload (incl. contentPolicy), not
    // the bare handler body — contentPolicy alone is ~286 bytes.
    const stampedWithoutEstimate = {
      ...body,
      contentPolicy: parsed.contentPolicy,
    };
    expect(parsed.estimatedPayloadBytes).toBe(
      bytesOf(JSON.stringify(stampedWithoutEstimate)),
    );
    expect(parsed.estimatedPayloadBytes).toBeGreaterThan(
      bytesOf(JSON.stringify(body)),
    );
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
 * SOE-omission honesty at the GLOBAL budget seam
 * (WHAT-HAPPENS-ON-SAVE-TRUNCATION-DROPS-LATER-PHASES / W5.1 GLOBAL residual).
 *
 * When `jsonResult` tail-truncates a composed-SOE `data.soe` to fit the byte
 * budget, it must recompute + stamp `phasesOmitted` (via the ONE shared
 * `computePhasesOmitted`) so a globally-trimmed payload can never silently
 * contradict its own `summary.phaseCounts` — a host must never read a trimmed
 * `soe` as "no duplicate rules fire on save". These lock the seam directly on
 * `jsonResult` (the full end-to-end fixture lives in what-happens-on-save.test).
 */
describe('jsonResult SOE phase-omission at the global budget seam', () => {
  const soeStep = (
    phase: string,
    i: number,
  ): Record<string, unknown> => ({
    phase,
    stepIndex: i,
    componentId: `ValidationRule:SeamObj.${phase}_${String(i).padStart(3, '0')}`,
    componentType: phase === 'duplicate-rules' ? 'DuplicateRule' : 'ValidationRule',
    apiName: `${phase}_${String(i).padStart(3, '0')}`,
    actions: [],
  });

  // A composed-SOE data shape: 60 early pre-save-validation steps (the head that
  // survives) followed by 3 duplicate-rules at the tail (dropped first).
  const soeData = (
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const soe: Record<string, unknown>[] = [];
    let idx = 0;
    for (let i = 0; i < 60; i += 1) soe.push(soeStep('pre-save-validation', idx++));
    for (let i = 0; i < 3; i += 1) soe.push(soeStep('duplicate-rules', idx++));
    return {
      objectApiName: 'SeamObj',
      soe,
      summary: {
        totalSteps: soe.length,
        phaseCounts: { 'pre-save-validation': 60, 'duplicate-rules': 3 },
      },
      ...extra,
    };
  };

  it('recomputes phasesOmitted naming every dropped non-zero phase after the global soe tail-truncation', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const body = { data: soeData(), vaultState: VAULT_STATE };
    const text = envelopeText(jsonResult(body));
    expect(bytesOf(text)).toBeLessThanOrEqual(8000);
    const parsed = JSON.parse(text) as {
      readonly data: {
        readonly soe: readonly { readonly phase: string }[];
        readonly phasesOmitted?: readonly {
          readonly phase: string;
          readonly declared: number;
          readonly present: number;
        }[];
      };
      readonly responseBudget: { readonly truncated?: boolean };
    };
    // The tail-truncation really fired and dropped the duplicate-rules tail.
    expect(parsed.responseBudget.truncated).toBe(true);
    expect(parsed.data.soe.some((s) => s.phase === 'duplicate-rules')).toBe(false);
    // …and the payload NAMES it rather than lying by omission.
    const byPhase = new Map(
      (parsed.data.phasesOmitted ?? []).map((o) => [o.phase, o]),
    );
    expect(byPhase.get('duplicate-rules')).toEqual({
      phase: 'duplicate-rules',
      declared: 3,
      present: 0,
    });
  });

  // FIX 3 (4), THIRD SITE. This pinned the global-trim backstop SKIPPING a
  // phase-filtered payload. The invariant it was really guarding is intact and
  // still asserted below: a phase-filtered `soe` is an intentional subset, so
  // the deliberately-absent OTHER phases must never be reported as omissions.
  //
  // What was wrong was the ACTION. Skipping meant a phase-filtered payload
  // trimmed by the GLOBAL budget lost steps with nothing saying so — the defect
  // surviving in the very path that exists to catch it. A phase filter chooses
  // WHICH phase comes back; it never consents to getting a partial one
  // silently. So the comparison NARROWS to the requested phase instead.
  it('stamps a globally-trimmed phase-filtered SOE payload, scoped to the REQUESTED phase only', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const body = {
      data: soeData({ appliedPhaseFilter: 'pre-save-validation' }),
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly data: {
        readonly phasesOmitted?: readonly {
          readonly phase: string;
          readonly declared: number;
          readonly present: number;
        }[];
      };
      readonly responseBudget: { readonly truncated?: boolean };
    };
    expect(parsed.responseBudget.truncated).toBe(true);
    const omitted = parsed.data.phasesOmitted ?? [];
    // THE PRESERVED INVARIANT: only the requested phase is ever named. The
    // other phases are absent on purpose and are not omissions.
    expect(omitted.map((o) => o.phase)).toEqual(['pre-save-validation']);
    // …and the shortfall it names is real.
    const only = omitted[0];
    expect(only?.present).toBeLessThan(only?.declared ?? 0);
  });

  // S2 — the reconciler owns `phasesOmitted` AND the prose that quotes it.
  it('restates the phase-filtered shortfall PROSE from the reconciled count, not the handler-time one', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    // The handler baked "…59 fitted in this response." from the step count it
    // could see; the global trim then cuts `soe` further. Pre-fix the sentence
    // kept saying 59 while `phasesOmitted` said something smaller — two numbers
    // for one fact.
    const body = {
      data: soeData({
        appliedPhaseFilter: 'pre-save-validation',
        phasesOmitted: [
          { phase: 'pre-save-validation', declared: 60, present: 59 },
        ],
        disclosure:
          'Base disclosure. You asked for the pre-save-validation phase, which holds 60 step(s); 59 fitted in this response. This is a byte-budget cut, not a smaller phase — narrow further with limit/offset, or pass includeConceptReasoning: false.',
      }),
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly data: {
        readonly disclosure: string;
        readonly phasesOmitted?: readonly {
          readonly phase: string;
          readonly declared: number;
          readonly present: number;
        }[];
      };
    };
    const only = parsed.data.phasesOmitted?.[0];
    expect(only).toBeDefined();
    expect(only?.present).toBeLessThan(59);
    expect(parsed.data.disclosure).toContain(
      `which holds 60 step(s); ${only?.present} fitted in this response.`,
    );
    // The stale number is GONE, not merely joined by a second sentence.
    expect(parsed.data.disclosure).not.toContain('59 fitted in this response');
    expect(
      parsed.data.disclosure.match(/fitted in this response/g),
    ).toHaveLength(1);
  });

  it('excises the "every save-order STEP is present" claim once the global trim dropped steps', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    // `enforceSoeByteBudget` runs with `allowStepDrop: false`, so its own note
    // truthfully claims every STEP survived. The global reducer then cuts `soe`
    // and the claim becomes false — measured on a real object at 27 of 109
    // steps, `truncatedPaths: ["soe"]`, under a sentence asserting every step
    // was present.
    const body = {
      data: soeData({
        disclosure:
          'Base disclosure. Response trimmed to fit the ~40 KB MCP response budget: every save-order STEP is present and in order, but 224 per-step action edge(s) across the heaviest steps were omitted (see each step’s `actionsOmitted`). Query a single object/event for full detail.',
      }),
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly data: {
        readonly soe: readonly unknown[];
        readonly disclosure: string;
        readonly phasesOmitted?: readonly unknown[];
      };
    };
    expect((parsed.data.phasesOmitted ?? []).length).toBeGreaterThan(0);
    expect(parsed.data.disclosure).not.toContain(
      'every save-order STEP is present and in order',
    );
    // The rest of the sentence survives — only the falsified clause is cut, and
    // what remains is exactly the shape the step-drop branch already emits.
    expect(parsed.data.disclosure).toContain(
      'Response trimmed to fit the ~40 KB MCP response budget 224 per-step action edge(s)',
    );
  });

  it('APPENDS the cross-phase shortfall prose when only the global trim created one', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    // The tool-local guard runs `allowStepDrop: false`, so on the cross-phase
    // path the handler usually bakes NO shortfall sentence at all — the global
    // trim is what drops the steps. `phasesOmitted` was stamped and the prose
    // stayed silent about it.
    const body = {
      data: soeData({ disclosure: 'Base disclosure.' }),
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly data: {
        readonly disclosure: string;
        readonly phasesOmitted?: readonly {
          readonly phase: string;
          readonly declared: number;
          readonly present: number;
        }[];
      };
    };
    const omitted = parsed.data.phasesOmitted ?? [];
    expect(omitted.length).toBeGreaterThan(0);
    expect(parsed.data.disclosure).toContain('Base disclosure.');
    for (const o of omitted) {
      expect(parsed.data.disclosure).toContain(
        `${o.phase} (${o.present}/${o.declared} shown)`,
      );
    }
    expect(parsed.data.disclosure).toContain(
      'truncated out of the returned sequence',
    );
  });

  it('does NOT stamp phasesOmitted on a non-SOE payload that merely has a same-named array (no summary.phaseCounts)', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const soe = Array.from({ length: 400 }, (_, i) => ({
      id: `Row:${i}`,
      label: `row number ${i} with some padding text`,
    }));
    const body = {
      data: { objectApiName: 'NotSoe', soe, summary: { totalSteps: 80 } },
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly data: { readonly phasesOmitted?: unknown };
      readonly responseBudget: { readonly truncated?: boolean };
    };
    // Global trim still fires on the big array, but nothing SOE-shaped ⇒ no stamp.
    expect(parsed.responseBudget.truncated).toBe(true);
    expect(parsed.data.phasesOmitted).toBeUndefined();
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
    const secret = 'org-secret-value user@example.edu';
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
    expect(text).not.toContain('user@example.edu');
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

/**
 * FIX 8 Half A — the pass-1 guard descends ONE level into direct child objects
 * of `data`.
 *
 * Before this change `truncateDataArrays` read only `Object.keys(data)`, so a
 * tool that nests its lists (`sfi.field_lineage` puts them at
 * `data.upstream.sources` / `data.downstream.effects`) presented the guard with
 * no array to cut: nothing was trimmed and the whole response fell through to
 * the opaque pass-3 `oversize` error. The class matters more than the instance
 * — every nested-list tool was in the same hole.
 */
describe('jsonResult nested-list truncation (FIX 8 Half A)', () => {
  it('trims a nested data list instead of falling through to an opaque oversize error', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const body = {
      data: {
        upstream: {
          sources: Array.from({ length: 1000 }, (_, i) => ({
            id: `CustomField:Widget_Session__c.Source_${i}__c`,
            role: 'formula-input',
          })),
          sourceCount: 1000,
        },
      },
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly error?: { readonly kind: string };
      readonly data?: {
        readonly upstream: { readonly sources: readonly unknown[] };
      };
      readonly responseBudget?: {
        readonly truncated?: boolean;
        readonly droppedCount?: number;
        readonly truncatedPaths?: readonly string[];
        readonly note?: string;
      };
    };
    // Pre-fix this was `{ error: { kind: 'oversize' } }` with no `data` at all.
    expect(parsed.error).toBeUndefined();
    expect(parsed.responseBudget?.truncated).toBe(true);
    expect(parsed.responseBudget?.truncatedPaths).toEqual([
      'upstream.sources',
    ]);
    expect(parsed.responseBudget?.droppedCount).toBeGreaterThan(0);
    // The invariant this pins is that a nested cut is NAMED. The sentence used
    // to add "Their published counts are the TRUE totals" — a claim about a
    // count NEITHER trimmed list is obliged to publish (`trust.limitations`
    // and `coverageCaveat.missingCoverage` publish none at all). The note now
    // states only what is always true: a prefix is present, and any count that
    // IS published describes the full list.
    expect(parsed.responseBudget?.note).toContain(
      'Lists trimmed from the tail: upstream.sources. Only a leading prefix of each is present; a count published elsewhere in this response describes the FULL list, not the rows shown.',
    );
    expect(parsed.responseBudget?.note).not.toContain('TRUE totals');
    expect(parsed.data?.upstream.sources.length).toBeGreaterThan(0);
    expect(parsed.data?.upstream.sources.length).toBeLessThan(1000);
  });

  it('is a no-op for an under-budget nested payload', () => {
    const body = {
      data: {
        upstream: { sources: [{ id: 'CustomField:Widget_Session__c.A__c' }] },
        downstream: { effects: [{ id: 'Flow:Widget_Session_Router' }] },
      },
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly data: unknown;
      readonly responseBudget?: unknown;
    };
    expect(parsed.data).toEqual(body.data);
    expect(parsed.responseBudget).toBeUndefined();
  });

  it('still names a trimmed TOP-LEVEL list without the nested sentence', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const body = {
      data: {
        matches: Array.from({ length: 1000 }, (_, i) => ({
          id: `CustomField:Widget_Session__c.Flat_${i}__c`,
        })),
      },
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly responseBudget?: {
        readonly truncatedPaths?: readonly string[];
        readonly note?: string;
      };
    };
    expect(parsed.responseBudget?.truncatedPaths).toEqual(['matches']);
    expect(parsed.responseBudget?.note).not.toContain(
      'Lists trimmed from the tail',
    );
  });
});

/**
 * B6 — the trimmer must never shorten a DISCLOSURE list.
 *
 * Pass 1 descending one level into direct children of `data` made
 * `data.trust` and `data.coverageCaveat` — present on every analysis tool —
 * reachable, so `trust.limitations` and `coverageCaveat.missingCoverage`
 * became trim candidates for the first time. Both are "here is what I did NOT
 * check" lists and neither publishes a count, so a silent tail cut left a host
 * reading a SHORTER blind-spot roster as the complete one: the one direction a
 * trim must never fail in.
 *
 * Measured pre-fix at `SFI_MAX_RESPONSE_BYTES=6000`:
 *   truncatedPaths: ["trust.limitations","coverageCaveat.missingCoverage"]
 *   limitations kept 10 of 24   missingCoverage kept 10 of 18
 * under a note asserting "Their published counts are the TRUE totals".
 */
describe('jsonResult never trims a disclosure list (B6)', () => {
  const limitationsOf = (n: number): readonly string[] =>
    Array.from(
      { length: n },
      (_, i) =>
        `Limitation ${i}: metadata family number ${i} was not retrieved into this vault, so any reference it could hold to the target is invisible to the graph this tool walks.`,
    );

  it('cuts a sibling DATA list instead, even when the disclosure list is the largest array', () => {
    // Sized so the disclosure list is the largest array in the payload:
    // pre-fix the byte-descending sort reached `trust.limitations` FIRST and
    // stopped there — `truncatedPaths: ["trust.limitations"]`, limitations cut
    // 24 -> 12, `findings` untouched at 150. Post-fix the only candidate is
    // `findings`, and the disclosure comes back whole.
    process.env['SFI_MAX_RESPONSE_BYTES'] = '7024';
    const limitations = limitationsOf(24);
    const body = {
      data: {
        verdict: 'safe',
        findings: Array.from({ length: 150 }, (_, i) => ({ id: `Finding:${i}` })),
        trust: {
          provenance: 'snapshot',
          confidence: 'medium',
          freshness: {},
          completeness: { status: 'partial' },
          limitations,
        },
      },
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(
      envelopeText(jsonResult(body, { knobs: ['limit'] })),
    ) as {
      readonly error?: unknown;
      readonly data?: {
        readonly findings: readonly unknown[];
        readonly trust: { readonly limitations: readonly string[] };
      };
      readonly responseBudget?: { readonly truncatedPaths?: readonly string[] };
    };
    expect(parsed.error).toBeUndefined();
    // The whole point: the disclosure survives intact, byte-for-byte.
    expect(parsed.data?.trust.limitations).toEqual(limitations);
    expect(parsed.responseBudget?.truncatedPaths).toEqual(['findings']);
    expect(parsed.data?.findings.length).toBeLessThan(150);
  });

  it('refuses with a structured oversize error rather than shipping a shortened blind-spot roster', () => {
    // The review's exact reproduction. The ONLY oversized lists here are
    // disclosures, so there is nothing left to cut — and an honest refusal
    // naming the tool's narrowing knobs beats a quietly truncated
    // "what I did not check" list.
    process.env['SFI_MAX_RESPONSE_BYTES'] = '6000';
    const limitations = limitationsOf(24).map(
      (l) => `${l} Treat its absence as "not checked", never as "none".`,
    );
    const missingCoverage = Array.from(
      { length: 18 },
      (_, i) =>
        `MetadataFamily_${i} (not retrieved for Widget_Session__c and 41 other objects)`,
    );
    const body = {
      data: {
        verdict: 'safe',
        findings: Array.from({ length: 8 }, (_, i) => ({
          id: `Finding:${i}`,
          pad: 'x'.repeat(120),
        })),
        trust: {
          provenance: 'snapshot',
          confidence: 'medium',
          freshness: {},
          completeness: { status: 'partial' },
          limitations,
        },
        coverageCaveat: {
          status: 'partial',
          missingCoverage,
          message:
            'usage cannot be confirmed because the vault has incomplete coverage.',
        },
      },
      vaultState: VAULT_STATE,
    };
    const text = envelopeText(jsonResult(body, { knobs: ['limit'] }));
    const parsed = JSON.parse(text) as {
      readonly error?: { readonly kind: string; readonly message: string };
      readonly data?: unknown;
      readonly responseBudget?: { readonly truncatedPaths?: readonly string[] };
    };
    // Pre-fix: no error, `data` present, and BOTH disclosure lists silently
    // cut to 10 with `truncatedPaths` naming them.
    expect(parsed.responseBudget?.truncatedPaths).toBeUndefined();
    expect(parsed.error?.kind).toBe('oversize');
    expect(parsed.error?.message).toContain('limit');
    expect(bytesOf(text)).toBeLessThanOrEqual(6000);
  });

  it('exempts every disclosure key at BOTH levels, including a top-level one', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '4000';
    const boundaries = limitationsOf(30);
    const blindSpots = Array.from({ length: 20 }, (_, i) => ({
      plane: `Plane_${i}`,
      kind: 'extractor-blind',
    }));
    const body = {
      data: {
        boundaries,
        coverageCaveat: { status: 'partial', blindSpots },
        rows: Array.from({ length: 40 }, (_, i) => ({ id: `Row:${i}` })),
      },
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(envelopeText(jsonResult(body))) as {
      readonly error?: { readonly kind: string };
      readonly responseBudget?: { readonly truncatedPaths?: readonly string[] };
      readonly data?: {
        readonly boundaries: readonly string[];
        readonly coverageCaveat: { readonly blindSpots: readonly unknown[] };
      };
    };
    // Whatever else happens to this payload, no disclosure path is ever named
    // as trimmed, and neither list comes back short.
    expect(parsed.responseBudget?.truncatedPaths ?? []).not.toContain(
      'boundaries',
    );
    expect(parsed.responseBudget?.truncatedPaths ?? []).not.toContain(
      'coverageCaveat.blindSpots',
    );
    if (parsed.data !== undefined) {
      expect(parsed.data.boundaries).toHaveLength(30);
      expect(parsed.data.coverageCaveat.blindSpots).toHaveLength(20);
    }
  });
});

/**
 * B7 — `nextOffset` must index the list the caller is actually paging.
 *
 * Before pass 1 descended, `dropped > 0` implied a TOP-LEVEL cut. Afterwards a
 * nested cut satisfied it too, and the emitted `nextOffset` was that nested
 * list's kept length. Measured pre-fix: `truncatedPaths: ["upstream.sources"]`,
 * `matches` untouched at 12, `sources` cut 400 -> 50, `nextOffset: 50`. A host
 * replaying `offset=50` against a 12-row list reads the empty page as the tail.
 */
describe('jsonResult nextOffset indexes the paged list (B7)', () => {
  const nestedBody = {
    data: {
      matches: Array.from({ length: 12 }, (_, i) => ({ id: `Match:${i}` })),
      upstream: {
        sources: Array.from({ length: 400 }, (_, i) => ({
          id: `CustomField:Widget_Session__c.Source_${i}__c`,
          role: 'formula-input',
        })),
        sourceCount: 400,
      },
    },
    vaultState: VAULT_STATE,
  };

  it('omits nextOffset when only a NESTED list was trimmed, and says the tail is unresumable', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const parsed = JSON.parse(
      envelopeText(
        jsonResult(nestedBody, {
          args: { offset: 0 },
          knobs: ['limit', 'offset'],
        }),
      ),
    ) as {
      readonly data?: { readonly matches: readonly unknown[] };
      readonly responseBudget?: {
        readonly truncatedPaths?: readonly string[];
        readonly nextOffset?: number;
        readonly note?: string;
      };
    };
    expect(parsed.responseBudget?.truncatedPaths).toEqual(['upstream.sources']);
    // Pre-fix this was 50 — the nested list's kept length, replayed against a
    // 12-row `matches`.
    expect(parsed.responseBudget?.nextOffset).toBeUndefined();
    expect(parsed.data?.matches).toHaveLength(12);
    expect(parsed.responseBudget?.note).toContain(
      'the dropped tail cannot be resumed from this response',
    );
  });

  it('omits nextOffset when SEVERAL lists were trimmed — which one it indexes would be a guess', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '6000';
    const body = {
      data: {
        matches: Array.from({ length: 200 }, (_, i) => ({
          id: `CustomField:Widget_Session__c.Match_${i}__c`,
        })),
        skipped: Array.from({ length: 200 }, (_, i) => ({
          id: `CustomField:Widget_Session__c.Skipped_${i}__c`,
        })),
      },
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(
      envelopeText(
        jsonResult(body, { args: { offset: 0 }, knobs: ['limit', 'offset'] }),
      ),
    ) as {
      readonly responseBudget?: {
        readonly truncatedPaths?: readonly string[];
        readonly nextOffset?: number;
      };
    };
    expect((parsed.responseBudget?.truncatedPaths ?? []).length).toBeGreaterThan(
      1,
    );
    expect(parsed.responseBudget?.nextOffset).toBeUndefined();
  });

  it('still emits nextOffset for the single-top-level-list case it was built for', () => {
    process.env['SFI_MAX_RESPONSE_BYTES'] = '8000';
    const body = {
      data: {
        rows: Array.from({ length: 400 }, (_, i) => ({
          id: `Row:${i}`,
          label: `row number ${i} with some padding text`,
        })),
      },
      vaultState: VAULT_STATE,
    };
    const parsed = JSON.parse(
      envelopeText(
        jsonResult(body, { args: { offset: 40 }, knobs: ['limit', 'offset'] }),
      ),
    ) as {
      readonly data: { readonly rows: readonly unknown[] };
      readonly responseBudget: { readonly nextOffset: number };
    };
    expect(parsed.responseBudget.nextOffset).toBe(40 + parsed.data.rows.length);
  });
});
