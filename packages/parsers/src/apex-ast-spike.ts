/**
 * P13-AST-spike — parser-grade Apex parsing, measured before it is wired.
 *
 * Wraps `@apexdevtools/apex-parser` (the ANTLR grammar maintained by the
 * apex-dev-tools project; pure JS via the antlr4 runtime, esbuild-bundleable)
 * behind one function. NOTHING in the product imports this module yet — the
 * spike exists to measure parse coverage + timing on real-org code and the
 * bundle-size delta BEFORE any graph change (P13-AST-edges wires it behind
 * `refresh --apex-ast` later; the regex scanner stayed the default all of
 * Phase 13).
 *
 * Failure posture mirrors the future production posture: a parse error never
 * throws — it reports `ok: false` so the caller can fall back to the scanner
 * per file.
 */

import {
  ApexErrorListener,
  ApexParserFactory,
} from '@apexdevtools/apex-parser';

/** One syntax error with its location, capped by the caller. */
export interface ApexParseError {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** Outcome of one spike parse. */
export interface ApexSpikeParseResult {
  /** True when the file parsed with zero syntax errors. */
  readonly ok: boolean;
  readonly errorCount: number;
  /** First few errors (cap 5) — enough to triage, never the whole flood. */
  readonly errors: readonly ApexParseError[];
  /** Wall-clock parse time in milliseconds. */
  readonly parseMs: number;
}

const ERROR_CAP = 5;

class CollectingListener extends ApexErrorListener {
  public readonly collected: ApexParseError[] = [];

  public apexSyntaxError(line: number, column: number, message: string): void {
    if (this.collected.length < ERROR_CAP) {
      this.collected.push({ line, column, message });
    }
  }
}

/**
 * Parse one Apex source (class or trigger body) with the ANTLR grammar.
 * Never throws: grammar-level failures surface as `ok: false` with the
 * first errors; an unexpected runtime failure is reported the same way.
 *
 * @example
 *   const r = parseApexSpike('public class A { void f(String y) { String x = y ?? "d"; } }');
 *   if (!r.ok) fallBackToScanner(r.errors);
 */
export const parseApexSpike = (
  source: string,
  kind: 'class' | 'trigger' = 'class',
): ApexSpikeParseResult => {
  const listener = new CollectingListener();
  const started = process.hrtime.bigint();
  let errorCount = 0;
  try {
    const parser = ApexParserFactory.createParser(source);
    parser.removeErrorListeners();
    parser.addErrorListener(listener);
    if (kind === 'trigger') {
      parser.triggerUnit();
    } else {
      parser.compilationUnit();
    }
    errorCount = listener.collected.length;
  } catch (cause) {
    listener.collected.push({
      line: 0,
      column: 0,
      message: `parser runtime failure: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    errorCount = listener.collected.length;
  }
  const parseMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    ok: errorCount === 0,
    errorCount,
    errors: listener.collected,
    parseMs,
  };
};
