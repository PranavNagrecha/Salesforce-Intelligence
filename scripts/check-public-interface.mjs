#!/usr/bin/env node
/**
 * Public-interface guard (Phase 21 / WS-E3).
 *
 * Codifies the rule "enhance only via the public interface" for the part that
 * matters most and is otherwise easy to break silently: the public CI + eval
 * pipeline must wire itself ONLY to in-repo, synthetic/public vaults — never
 * escape to the workspace root (where the maintainer's real org vaults live)
 * or to an absolute local path.
 *
 * This is blocklist-INDEPENDENT defense-in-depth on top of `scan-org-leaks`
 * (which catches real org NAMES anywhere in the tree). It is itself leak-safe:
 * it names no real vault. It is scoped to machine-config files (not prose), so
 * it does not false-positive on docs that legitimately discuss "vaults".
 *
 * Fails (exit 1) if a public CI/eval config contains a `../` parent-escape, an
 * absolute local path, or a registry vault `path` outside the allowed in-repo
 * public roots. Run: `pnpm check:public-interface`.
 */
import { existsSync, readFileSync } from 'node:fs';

/** Public CI/eval config files: the wiring that decides which vault CI runs on. */
const CONFIG_FILES = [
  '.github/workflows/ci.yml',
  'eval/registry.ci.json',
  'eval/cases.ci.json',
  'eval/cases.analytical.ci.json',
];

/** Registry vault `path` values must stay under one of these in-repo public roots. */
const ALLOWED_PATH_PREFIXES = ['eval/fixtures/', 'examples/demo-vault', 'org-kb'];

const ABSOLUTE_LOCAL_PATH = /\/(Users|home|private|var\/folders)\//;

const violations = [];

for (const file of CONFIG_FILES) {
  if (!existsSync(file)) continue;
  const isRegistry = /registry.*\.json$/.test(file);
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const n = i + 1;
      if (line.includes('../')) {
        violations.push(`${file}:${n}  parent-escape '../' — public CI/eval must stay in-repo: ${line.trim()}`);
      }
      if (ABSOLUTE_LOCAL_PATH.test(line)) {
        violations.push(`${file}:${n}  absolute local path — public CI/eval must be repo-relative: ${line.trim()}`);
      }
      // A vault path in the registry must point at an in-repo public vault.
      if (isRegistry) {
        const m = line.match(/"path"\s*:\s*"([^"]+)"/);
        if (m && !ALLOWED_PATH_PREFIXES.some((pre) => m[1].startsWith(pre))) {
          violations.push(
            `${file}:${n}  vault path '${m[1]}' is outside the allowed public roots (${ALLOWED_PATH_PREFIXES.join(', ')}): ${line.trim()}`,
          );
        }
      }
    });
}

if (violations.length > 0) {
  console.error(`check-public-interface: ${violations.length} violation(s) — public CI/eval must reference only in-repo synthetic vaults:`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    '\nThe maintainer real-org vaults live OUTSIDE this repo; public CI / eval / demo must never point at them. ' +
      'Use the in-repo fixture (eval/fixtures/ci-vault) or examples/demo-vault.',
  );
  process.exit(1);
}

console.log(`check-public-interface: OK — ${CONFIG_FILES.length} public CI/eval config(s) reference only in-repo public vaults.`);
