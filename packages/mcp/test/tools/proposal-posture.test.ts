/// <reference types="vitest/globals" />
/**
 * Finding #35 — POSTURE GATE for the proposal-artifact family (R1, the
 * existential risk).
 *
 * The whole trust thesis is that a "proposal" writes LOCAL files only and never
 * touches Salesforce. This gate makes that structural, not aspirational: it
 * walks the transitive VALUE-import graph of `proposal-artifact.ts` and fails if
 * it can reach ANY org-connect / deploy / live-plane seam — and it scans the
 * module source for the forbidden runtime primitives (`sf` CLI, `child_process`,
 * `execFile`, live-plane helpers). If a future edit makes a proposal builder
 * import a deploy or live-read path, THIS test is what catches it.
 *
 * Mirrors the `plane-import-guard.test.ts` philosophy: simple string-level
 * import parsing, VALUE imports only (a `import type { … }` is erased and
 * creates no runtime edge), following relative `./x.js` specifiers within
 * `packages/mcp/src` and `@sf-intelligence/*` package roots.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const TOOLS_DIR = join(MCP_SRC_DIR, 'tools');
const PACKAGES_DIR = join(MCP_SRC_DIR, '..', '..');
const PROPOSAL_FILE = resolve(TOOLS_DIR, 'proposal-artifact.ts');

/**
 * Basenames of the org-connect / live-plane / deploy seam. If the proposal
 * module's VALUE-import closure reaches any of these, a proposal path can issue
 * a live read or a deploy — exactly what the posture forbids.
 */
const FORBIDDEN_SEAM_BASENAMES: ReadonlySet<string> = new Set([
  'live-plane.ts',
  'live-session.ts',
  'live-consent.ts',
  'live-population-check.ts',
]);

/** Any reachable file under this package is an org I/O surface — forbidden. */
const FORBIDDEN_PACKAGE_SEGMENT = `${join('packages', 'tooling-api')}`;

const importStatementRe =
  /import\s+(type\s+)?\{([^{}]*)\}\s*from\s*'((?:\.[^']+\.js)|(?:@sf-intelligence\/[a-zA-Z0-9_-]+))';/g;

interface ParsedImport {
  readonly wholeStatementTypeOnly: boolean;
  readonly specifiers: readonly string[];
  readonly moduleSpecifier: string;
}

const parseImports = (source: string): readonly ParsedImport[] => {
  const out: ParsedImport[] = [];
  const re = new RegExp(importStatementRe.source, 'g');
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign -- standard exec-loop idiom
  while ((m = re.exec(source))) {
    const specifiers = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out.push({
      wholeStatementTypeOnly: Boolean(m[1]),
      specifiers,
      moduleSpecifier: m[3] ?? '',
    });
  }
  return out;
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const resolveSpecifier = (fromFile: string, moduleSpecifier: string): string | null => {
  let base: string;
  if (moduleSpecifier.startsWith('@sf-intelligence/')) {
    const pkgName = moduleSpecifier.slice('@sf-intelligence/'.length).split('/')[0];
    if (!pkgName) return null;
    base = join(PACKAGES_DIR, pkgName, 'src', 'index');
  } else if (moduleSpecifier.startsWith('.')) {
    const withoutExt = moduleSpecifier.endsWith('.js')
      ? moduleSpecifier.slice(0, -'.js'.length)
      : moduleSpecifier;
    base = resolve(dirname(fromFile), withoutExt);
  } else {
    return null;
  }
  const asFile = `${base}.ts`;
  if (isFile(asFile)) return asFile;
  const asIndex = join(base, 'index.ts');
  if (isFile(asIndex)) return asIndex;
  return null;
};

/** BFS the VALUE-import closure of `PROPOSAL_FILE`. */
const importClosure = (): ReadonlySet<string> => {
  const seen = new Set<string>();
  const queue: string[] = [PROPOSAL_FILE];
  for (;;) {
    const current = queue.shift();
    if (current === undefined) break;
    if (seen.has(current)) continue;
    seen.add(current);
    let source: string;
    try {
      source = readFileSync(current, 'utf8');
    } catch {
      continue;
    }
    for (const imp of parseImports(source)) {
      if (imp.wholeStatementTypeOnly) continue; // erased at compile time
      const hasValueSpecifier = imp.specifiers.some((s) => !/^type\s+/.test(s));
      if (!hasValueSpecifier) continue; // every specifier is `type X` — also erased
      const target = resolveSpecifier(current, imp.moduleSpecifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
};

describe('Finding #35 — proposal-artifact posture gate (LOCAL-file-only, zero org I/O)', () => {
  const closure = importClosure();

  it('resolves a non-trivial import closure (sanity — the resolver works)', () => {
    expect(closure.has(PROPOSAL_FILE)).toBe(true);
    expect(closure.has(resolve(TOOLS_DIR, 'export-manifest.ts'))).toBe(true);
  });

  it('never transitively imports an org-connect / live-plane / deploy seam', () => {
    const hits = [...closure].filter(
      (f) =>
        FORBIDDEN_SEAM_BASENAMES.has(basename(f)) ||
        f.includes(FORBIDDEN_PACKAGE_SEGMENT),
    );
    expect(
      hits,
      `proposal-artifact.ts reaches a forbidden org-I/O seam: ${hits.join(', ')} — ` +
        'a proposal builder MUST stay a pure local-file transform. Sever the import.',
    ).toEqual([]);
  });

  it('proposal-artifact.ts source contains no exec / shell-out / live-read primitive', () => {
    // Actually deploying / connecting to the org REQUIRES one of these runtime
    // primitives (shelling to `sf`, or a live-plane helper). The human-facing
    // disclosure text is ALLOWED to name "sf project deploy" — that is the whole
    // point of the artifact (the tool a human feeds it to) — so this scan
    // deliberately targets the CALL primitives, not the string mention. The
    // import-closure gate above is the structural backstop for the live/tooling
    // seam.
    const source = readFileSync(PROPOSAL_FILE, 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const forbidden = [
      'child_process',
      'execFile',
      'execSync',
      'spawn(',
      'resolveLiveAccess',
      'probeLiveAccess',
      'computeLivePopulation',
    ];
    for (const token of forbidden) {
      expect(
        code.includes(token),
        `proposal-artifact.ts references '${token}' — proposals must never deploy, ` +
          'shell out, or read the live org.',
      ).toBe(false);
    }
  });
});
