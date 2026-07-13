/// <reference types="vitest/globals" />

/**
 * Registration-parity invariant for MCP tool handlers.
 *
 * The recurring bug this guards against: a tool is fully built — Zod input
 * schema + handler, sometimes with its own tests — but is never imported
 * into `tools/index.ts` and never wired into `dispatchTool`'s switch, so
 * `sfi.<tool>` is permanently unreachable dead code. At least eight
 * instances of this exact class have shipped (SamlSsoConfig extractor,
 * live_setup_audit_trail, apex_api_version_audit, flow_fault_audit,
 * org_scorecard, record_creation_paths, live_data_skew,
 * live_security_exposure).
 *
 * This test enumerates every `export const <name>Handler` / `<name>Input-
 * Schema` in `packages/mcp/src/tools/*.ts` (excluding `index.ts` itself)
 * and asserts each one is both (a) imported by `tools/index.ts` and (b)
 * referenced inside the `dispatchTool` switch body — unless it is listed
 * in `KNOWN_UNREGISTERED_HANDLERS` below, a deliberate, reviewed
 * exception ledger rather than a silent gap. Adding a new built-but-
 * unwired handler makes this test fail; the fix is either to wire it in
 * or to add a ledger entry with a comment explaining why it stays dark.
 *
 * Detection is textual but statement-scoped rather than line-based: it
 * parses each `import { ... } from './x.js';` block as a unit (bounded
 * by `[^{}]*` so one match can never swallow multiple import statements)
 * and isolates the `dispatchTool` switch body by brace-counting from
 * `switch (toolName) {`, so both checks are robust to reformatting,
 * import reordering, and multi-line wrapping.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'tools',
);
// R7-F2: handler imports and dispatchTool switch now live in tool-dispatch.ts.
// The parity checks (import coverage + dispatch switch body) point there.
const INDEX_PATH = join(TOOLS_DIR, 'tool-dispatch.ts');

/**
 * Fully built handlers/schemas that are deliberately not wired into
 * `dispatchTool` yet. Each entry is a conscious, tracked exception — not
 * an accident — and must name the symbol exactly as exported. Removing a
 * stale entry (once wired or deleted) is enforced by the second `it`
 * below.
 */
const KNOWN_UNREGISTERED_HANDLERS: ReadonlySet<string> = new Set([
  // CTO ledger W-1/W-2 resolved: apexApiVersionAudit + orgScorecard were
  // deleted; flowFaultAudit, recordCreationPaths, liveDataSkew, and
  // liveSecurityExposure were wired into dispatchTool. No dark handlers
  // remain — keep this ledger empty until the next deliberate exception.
]);

interface ExportedSymbol {
  readonly file: string;
  readonly symbol: string;
}

/** Every tool source file, excluding the dispatcher itself and any test files. */
const listToolSourceFiles = (): readonly string[] =>
  readdirSync(TOOLS_DIR)
    .filter(
      (f) =>
        f.endsWith('.ts') &&
        f !== 'index.ts' &&
        f !== 'tool-dispatch.ts' &&
        f !== 'roster.ts' &&
        !f.endsWith('.test.ts'),
    )
    .sort();

/** Top-level `export const <name>` declarations, whatever their type annotation or initializer shape. */
const exportedConstNames = (source: string): readonly string[] => {
  const names: string[] = [];
  const re = /^export const (\w+)\b/gm;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- standard exec-loop idiom
  while ((m = re.exec(source))) {
    const name = m[1];
    if (name) names.push(name);
  }
  return names;
};

/** Every `*Handler` / `*InputSchema` export across all tool source files. */
const findHandlerAndSchemaExports = (): readonly ExportedSymbol[] => {
  const out: ExportedSymbol[] = [];
  for (const file of listToolSourceFiles()) {
    const source = readFileSync(join(TOOLS_DIR, file), 'utf8');
    for (const name of exportedConstNames(source)) {
      if (/Handler$/.test(name) || /InputSchema$/.test(name)) {
        out.push({ file, symbol: name });
      }
    }
  }
  return out;
};

/**
 * Every local binding name imported via a relative `./*.js` import in
 * `tools/index.ts`. Each import block is matched with `[^{}]*` for its
 * specifier body — never `[\s\S]*?` — so a match can't run past the
 * block's own closing brace into a later, unrelated import statement (a
 * lazy `[\s\S]*?` would happily skip over intermediate `} from '@pkg';`
 * clauses that don't end the pattern and glob everything up to the
 * *first* relative import in the whole file).
 */
const importedSymbols = (indexSource: string): ReadonlySet<string> => {
  const symbols = new Set<string>();
  const importBlockRe =
    /import\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*'\.\/[^']+\.js';/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- standard exec-loop idiom
  while ((m = importBlockRe.exec(indexSource))) {
    for (const raw of (m[1] ?? '').split(',')) {
      const spec = raw.trim();
      if (!spec) continue;
      const aliasParts = spec.split(' as ');
      const local = (
        aliasParts.length > 1 ? aliasParts[aliasParts.length - 1] : spec
      )?.trim();
      if (local) symbols.add(local.replace(/^type\s+/, ''));
    }
  }
  return symbols;
};

/**
 * The body of the `dispatchTool` switch statement, isolated by
 * brace-counting from `switch (toolName) {` to its matching close. Using
 * brace balance (rather than e.g. `default:` as a sentinel) survives
 * reordering of cases and insertion of nested blocks inside a case.
 */
const dispatchSwitchBody = (indexSource: string): string => {
  const marker = 'switch (toolName) {';
  const start = indexSource.indexOf(marker);
  if (start === -1) {
    throw new Error(
      'registration-parity: could not locate `switch (toolName) {` in ' +
        'tools/index.ts — the dispatch shape changed, update this test',
    );
  }
  let depth = 0;
  let i = start + marker.length - 1; // position at the opening brace
  for (; i < indexSource.length; i++) {
    const ch = indexSource[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    throw new Error(
      'registration-parity: unbalanced braces while isolating the ' +
        'dispatchTool switch body',
    );
  }
  return indexSource.slice(start, i + 1);
};

describe('registration parity — MCP tool handlers', () => {
  const indexSource = readFileSync(INDEX_PATH, 'utf8');
  const imported = importedSymbols(indexSource);
  const dispatchBody = dispatchSwitchBody(indexSource);
  const exportedSymbols = findHandlerAndSchemaExports();

  it('scans a non-trivial number of handler/schema exports (sanity guard against a silently-empty glob)', () => {
    const handlerCount = exportedSymbols.filter((s) =>
      /Handler$/.test(s.symbol),
    ).length;
    expect(handlerCount).toBeGreaterThan(100);
  });

  it.each(exportedSymbols)(
    '$symbol ($file) is imported + dispatched by tools/index.ts, or is an explicit KNOWN_UNREGISTERED exception',
    ({ file, symbol }) => {
      if (KNOWN_UNREGISTERED_HANDLERS.has(symbol)) {
        // A ledger entry that's actually reachable is stale — prove the
        // ledger doesn't silently rot into a lie.
        expect(
          imported.has(symbol),
          `${symbol} (${file}) is listed in KNOWN_UNREGISTERED_HANDLERS ` +
            'but IS imported by tools/index.ts — remove the stale ledger entry',
        ).toBe(false);
        return;
      }

      expect(
        imported.has(symbol),
        `${symbol} (${file}) is exported but never imported by ` +
          'tools/index.ts — wire it into dispatchTool, or add it to ' +
          'KNOWN_UNREGISTERED_HANDLERS with a ledger comment',
      ).toBe(true);

      expect(
        dispatchBody.includes(symbol),
        `${symbol} (${file}) is imported but never referenced inside the ` +
          'dispatchTool switch — add a case for it, or add it to ' +
          'KNOWN_UNREGISTERED_HANDLERS with a ledger comment',
      ).toBe(true);
    },
  );

  it('KNOWN_UNREGISTERED_HANDLERS has no stale entries (every listed symbol still exists as an export)', () => {
    const allSymbols = new Set(exportedSymbols.map((s) => s.symbol));
    for (const known of KNOWN_UNREGISTERED_HANDLERS) {
      expect(
        allSymbols.has(known),
        `${known} is listed in KNOWN_UNREGISTERED_HANDLERS but no longer ` +
          'exists as an export anywhere in tools/*.ts — remove the stale entry',
      ).toBe(true);
    }
  });
});
