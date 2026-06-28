/// <reference types="vitest/globals" />

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  emitToolMetric,
  instrumentDispatch,
  observabilityEnabled,
} from '../src/observability.js';

let dir: string;
let prior: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-metrics-'));
  prior = process.env['SFI_METRICS_LOG'];
});

afterEach(() => {
  if (prior === undefined) delete process.env['SFI_METRICS_LOG'];
  else process.env['SFI_METRICS_LOG'] = prior;
  rmSync(dir, { recursive: true, force: true });
});

describe('observabilityEnabled', () => {
  it('is false when SFI_METRICS_LOG is unset', () => {
    delete process.env['SFI_METRICS_LOG'];
    expect(observabilityEnabled()).toBe(false);
  });

  it('is true when SFI_METRICS_LOG points at a path', () => {
    process.env['SFI_METRICS_LOG'] = join(dir, 'metrics.log');
    expect(observabilityEnabled()).toBe(true);
  });
});

describe('emitToolMetric', () => {
  it('writes one structured JSON line when enabled (fields typed, ok:true)', () => {
    const log = join(dir, 'metrics.log');
    process.env['SFI_METRICS_LOG'] = log;
    emitToolMetric({
      ts: '2026-06-26T00:00:00.000Z',
      tool: 'sfi.resolve',
      ok: true,
      durationMs: 12,
      payloadBytes: 345,
    });
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as {
      ts: string;
      tool: string;
      ok: boolean;
      durationMs: number;
      payloadBytes: number;
    };
    expect(parsed.ts).toBe('2026-06-26T00:00:00.000Z');
    expect(parsed.tool).toBe('sfi.resolve');
    expect(typeof parsed.ok).toBe('boolean');
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.durationMs).toBe('number');
    expect(typeof parsed.payloadBytes).toBe('number');
  });

  it('records ok:false for an error metric', () => {
    const log = join(dir, 'metrics.log');
    process.env['SFI_METRICS_LOG'] = log;
    emitToolMetric({
      ts: 'x',
      tool: 'sfi.get_component',
      ok: false,
      durationMs: 1,
      payloadBytes: 10,
    });
    const parsed = JSON.parse(
      readFileSync(log, 'utf8').trim(),
    ) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });

  it('is a no-op when SFI_METRICS_LOG is unset (no file written)', () => {
    delete process.env['SFI_METRICS_LOG'];
    const log = join(dir, 'metrics.log');
    emitToolMetric({
      ts: 'x',
      tool: 'sfi.resolve',
      ok: true,
      durationMs: 1,
      payloadBytes: 1,
    });
    expect(existsSync(log)).toBe(false);
  });

  it('never throws when the sink path is unwritable', () => {
    process.env['SFI_METRICS_LOG'] = join(dir, 'no-such-dir', 'metrics.log');
    expect(() =>
      emitToolMetric({
        ts: 'x',
        tool: 't',
        ok: true,
        durationMs: 1,
        payloadBytes: 1,
      }),
    ).not.toThrow();
  });
});

describe('instrumentDispatch', () => {
  const ok: CallToolResult = {
    content: [{ type: 'text', text: '{"data":{"hello":"world"}}' }],
  };
  const err: CallToolResult = {
    content: [{ type: 'text', text: '{"error":{"kind":"unknown-tool"}}' }],
  };

  it('returns the dispatch result byte-identical whether the flag is on or off', async () => {
    delete process.env['SFI_METRICS_LOG'];
    const off = await instrumentDispatch(
      'sfi.resolve',
      async () => ok,
    );
    process.env['SFI_METRICS_LOG'] = join(dir, 'metrics.log');
    const on = await instrumentDispatch('sfi.resolve', async () => ok);
    expect(off).toEqual(on);
    const offText =
      off.content[0]?.type === 'text' ? off.content[0].text : undefined;
    const onText =
      on.content[0]?.type === 'text' ? on.content[0].text : undefined;
    expect(offText).toBe(onText);
    expect(offText).toBe('{"data":{"hello":"world"}}');
  });

  it('emits one metric per call when enabled, with payloadBytes from the serialized text and ok:true', async () => {
    const log = join(dir, 'metrics.log');
    process.env['SFI_METRICS_LOG'] = log;
    const result = await instrumentDispatch('sfi.resolve', async () => ok);
    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : '';
    const parsed = JSON.parse(
      readFileSync(log, 'utf8').trim(),
    ) as { tool: string; ok: boolean; payloadBytes: number };
    expect(parsed.tool).toBe('sfi.resolve');
    expect(parsed.ok).toBe(true);
    expect(parsed.payloadBytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('marks ok:false when the serialized body carries a top-level error key', async () => {
    const log = join(dir, 'metrics.log');
    process.env['SFI_METRICS_LOG'] = log;
    await instrumentDispatch('sfi.get_component', async () => err);
    const parsed = JSON.parse(
      readFileSync(log, 'utf8').trim(),
    ) as { ok: boolean };
    expect(parsed.ok).toBe(false);
  });

  it('does no metric work and writes nothing when the flag is off', async () => {
    delete process.env['SFI_METRICS_LOG'];
    const log = join(dir, 'metrics.log');
    await instrumentDispatch('sfi.resolve', async () => ok);
    expect(existsSync(log)).toBe(false);
  });

  // CR-14 / CR-P3: a THROWN dispatch must still emit a metric (ok:false) and
  // re-throw — without a try/finally the throw skips the metric and skews the
  // ok/error ratio (errors silently absent).
  it('FAIL-BEFORE/PASS-AFTER: a thrown dispatch still emits an ok:false metric and re-throws', async () => {
    const log = join(dir, 'metrics.log');
    process.env['SFI_METRICS_LOG'] = log;
    await expect(
      instrumentDispatch('sfi.get_component', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(log)).toBe(true);
    const parsed = JSON.parse(readFileSync(log, 'utf8').trim()) as {
      tool: string;
      ok: boolean;
    };
    expect(parsed.tool).toBe('sfi.get_component');
    expect(parsed.ok).toBe(false);
  });

  it('a thrown dispatch with the flag OFF still re-throws and writes nothing', async () => {
    delete process.env['SFI_METRICS_LOG'];
    const log = join(dir, 'metrics.log');
    await expect(
      instrumentDispatch('sfi.resolve', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(log)).toBe(false);
  });

  // CR-P3: an SDK-style error result (`isError: true`) whose text body is not a
  // top-level `{error:...}` JSON must still log ok:false — checking the text's
  // top-level `error` key alone mislabels it ok:true.
  it('FAIL-BEFORE/PASS-AFTER: an isError:true result logs ok:false even with a non-error-shaped body', async () => {
    const log = join(dir, 'metrics.log');
    process.env['SFI_METRICS_LOG'] = log;
    const sdkError: CallToolResult = {
      content: [{ type: 'text', text: 'Internal error: something failed' }],
      isError: true,
    };
    await instrumentDispatch('sfi.get_component', async () => sdkError);
    const parsed = JSON.parse(readFileSync(log, 'utf8').trim()) as {
      ok: boolean;
    };
    expect(parsed.ok).toBe(false);
  });
});
