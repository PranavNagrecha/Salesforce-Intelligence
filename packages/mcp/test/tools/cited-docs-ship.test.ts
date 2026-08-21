/// <reference types="vitest/globals" />

/**
 * CITED-DOC-DOES-NOT-SHIP.
 *
 * `ApexQualitySemantics.md` was cited from 19 sites across 8 production files —
 * including the ADVERTISED description of `sfi.crud_fls_audit` ("the HIGH
 * false-positive rate inherited from ApexQualitySemantics.md §§ 6-7") and a
 * disclosure string emitted verbatim in `code_quality_audit`'s `boundaries[]`.
 * A host that reads either one can quote a section number at a user for a
 * document that does not ship, and neither the host nor the user can ever open
 * it to check.
 *
 * WHAT VERIFICATION FOUND. The document is not a phantom: it is a real 1201-line
 * spec that lives in the FROZEN BUILD HARNESS, one of 64 vendored
 * `docs/vendor/salesforce-metadata/*.md` files the shipped product deliberately
 * excludes. Its "§§ 6-7" is accurate — § 6 is `missing-crud-check`, § 7 is
 * `missing-fls-check`. So the defect is not a wrong citation; it is a citation
 * to a path that resolves for exactly one person on earth, published to every
 * host that installs the product.
 *
 * WHY REMOVAL RATHER THAN SHIPPING THE DOC. Copying 64 vendored specs into the
 * product would publish a second, unbound source of truth for behaviour that
 * already has one — the recognizer catalog IS the code — and nothing would keep
 * the two in step. The substance of each cited section is now stated inline
 * next to the code that implements it, where it cannot drift.
 *
 * These two tests pin the fix at the surface where it actually mattered: text a
 * HOST reads. Internal JSDoc still carries citations to the other vendored
 * specs; that is a known, larger cleanup and is deliberately NOT what this
 * guard asserts, because a dev comment misleads nobody outside the repo.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { V01_TOOLS } from '../../src/tools/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Walk up to the monorepo root — the first ancestor with a pnpm workspace file. */
const repoRoot = (): string => {
  let current = HERE;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('could not locate the monorepo root from the test file');
};

const ROOT = repoRoot();

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.pnpm-store', 'org-kb']);

/** Every markdown basename that actually ships in this repository. */
const shippedMarkdownBasenames = (): ReadonlySet<string> => {
  const found = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full, depth + 1);
      else if (entry.endsWith('.md')) found.add(entry);
    }
  };
  walk(ROOT, 0);
  return found;
};

/** A `.md` filename token, ignoring anything that is part of a URL. */
const MD_TOKEN = /(?<![\w/.-])([A-Za-z0-9][A-Za-z0-9_.-]*\.md)\b/g;

describe('a document cited to a HOST must ship', () => {
  it('no advertised tool description cites a .md that is not in this repo', () => {
    const shipped = shippedMarkdownBasenames();
    // Sanity: the walk found something, so an empty set cannot make this vacuous.
    expect(shipped.size).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const tool of V01_TOOLS) {
      const description = tool.description ?? '';
      for (const match of description.matchAll(MD_TOKEN)) {
        const cited = match[1] as string;
        if (!shipped.has(cited)) offenders.push(`${tool.name} cites ${cited}`);
      }
    }
    expect(
      offenders,
      `advertised descriptions cite documents this repo does not ship:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the removed ApexQualitySemantics citation stays removed', () => {
    // A targeted pin: this exact citation reached hosts through BOTH a tool
    // description and an emitted `boundaries[]` string, so it gets its own
    // regression guard rather than relying on the generic scan above (which
    // covers descriptions only).
    const roots = [
      join(ROOT, 'packages', 'mcp', 'src'),
      join(ROOT, 'packages', 'patterns', 'src'),
      join(ROOT, '.claude', 'skills'),
    ];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|md)$/.test(entry)) continue;
        if (full === resolve(HERE, 'cited-docs-ship.test.ts')) continue;
        if (readFileSync(full, 'utf-8').includes('ApexQualitySemantics')) {
          offenders.push(full.slice(ROOT.length + 1));
        }
      }
    };
    for (const root of roots) walk(root);
    expect(
      offenders,
      `ApexQualitySemantics.md does not ship; these files cite it again:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
