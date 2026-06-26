import { appendFileSync } from 'node:fs';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * One per-call observability metric for a tool invocation. Records timing,
 * outcome, and serialized payload size — never arg values or any org content
 * (those can carry PII; the metric is "how a call performed," not "what it
 * asked"). Mirrors {@link import('./audit.js').AuditEntry}'s no-PII contract.
 */
export interface ToolMetric {
  /** ISO 8601 timestamp of when the call completed. */
  readonly ts: string;
  readonly tool: string;
  /** True when the serialized body has no top-level `error` key. */
  readonly ok: boolean;
  /** Wall-clock duration of the dispatch, milliseconds. */
  readonly durationMs: number;
  /** UTF-8 byte length of the already-serialized response text. */
  readonly payloadBytes: number;
}

/**
 * Whether per-call observability is enabled. Opt-in: true only when
 * `SFI_METRICS_LOG` points at a (writable) path. Mirrors the audit-log idiom
 * (`SF_INTELLIGENCE_AUDIT_LOG`) so both governance sinks share one shape:
 * unset means total silence and zero work beyond a single env lookup.
 */
export const observabilityEnabled = (): boolean => {
  const path = process.env['SFI_METRICS_LOG'];
  return path !== undefined && path !== '';
};

/**
 * Append one JSON line of per-call metrics. No-op unless `SFI_METRICS_LOG`
 * points at a writable file; writes one JSON line per call. Best-effort: a
 * metrics-write failure must NEVER break the underlying tool call, so all
 * errors are swallowed. When the flag is unset, this does zero work beyond a
 * single env lookup.
 *
 * @example
 *   emitToolMetric({ ts: new Date().toISOString(), tool: 'sfi.resolve',
 *     ok: true, durationMs: 12, payloadBytes: 345 });
 */
export const emitToolMetric = (metric: ToolMetric): void => {
  const path = process.env['SFI_METRICS_LOG'];
  if (path === undefined || path === '') return;
  try {
    appendFileSync(path, `${JSON.stringify(metric)}\n`, 'utf8');
  } catch {
    // Observability is best-effort; never fail the tool call.
  }
};

/**
 * The first text part of a {@link CallToolResult}, or `''` when absent.
 * Every `jsonResult`-produced result has exactly one text part, so this
 * reads the already-serialized body without re-serializing.
 */
const resultText = (result: CallToolResult): string => {
  const first = result.content?.[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
};

/**
 * Whether a serialized response body lacks a top-level `error` key. A parse
 * failure (non-JSON text) is treated as ok — the metric must never throw and
 * never mislabel a normal response as an error.
 */
const bodyIsOk = (text: string): boolean => {
  try {
    const body = JSON.parse(text) as unknown;
    return !(
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      'error' in body &&
      (body as { readonly error?: unknown }).error != null
    );
  } catch {
    return true;
  }
};

/**
 * The single per-call observability seam. Wraps a `dispatch` thunk, returns
 * its {@link CallToolResult} UNCHANGED (byte-identical to calling `dispatch`
 * directly), and — only when {@link observabilityEnabled} — emits one metric
 * with timing, ok/error, and payload bytes derived from the already-serialized
 * response text. The flag is read once up front: when off, the only extra work
 * is that single env lookup, so a metrics-disabled call behaves exactly as
 * today. Call this from the `tools/call` handler so it sees exactly the
 * client-facing seam (not the `dispatchTool` recursion or CLI-internal calls).
 *
 * @example
 *   return instrumentDispatch(name, () => dispatchTool(ctx, name, args));
 */
export const instrumentDispatch = async (
  tool: string,
  dispatch: () => Promise<CallToolResult>,
): Promise<CallToolResult> => {
  if (!observabilityEnabled()) return dispatch();
  const start = Date.now();
  const result = await dispatch();
  const text = resultText(result);
  emitToolMetric({
    ts: new Date().toISOString(),
    tool,
    ok: bodyIsOk(text),
    durationMs: Date.now() - start,
    payloadBytes: Buffer.byteLength(text, 'utf8'),
  });
  return result;
};
