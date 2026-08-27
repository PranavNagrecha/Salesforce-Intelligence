import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INTEGRATION_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to `examples/demo-vault` — the ONLY fully-built vault that is
 * committed to this repository.
 *
 * Everything the MCP server needs is git-tracked: `graph/graph.duckdb`,
 * `graph/resolve-index.json`, `meta/manifest.json`, the rendered `components/`
 * tree and `truth/manifest.json`. `buildContext` opens it directly — no
 * refresh, no Salesforce CLI, no maintainer credentials, no 45 MB fixture
 * copy. That is what lets the honesty sweep run in CI, which cannot run
 * `end-to-end.test.ts` at all (its edu-org fixture lives in the separate
 * `sf-intelligence-builder` harness — see `fixture-paths.ts`).
 *
 * DELIBERATELY THROWS rather than exporting a nullable path. A gate that
 * quietly skips when its fixture is missing is the `scan:leaks` failure mode:
 * it "passes" while asserting nothing.
 */
export const resolveDemoVaultRoot = (): string => {
  const root = resolve(INTEGRATION_DIR, '..', '..', 'examples', 'demo-vault');
  if (!existsSync(resolve(root, 'graph', 'graph.duckdb'))) {
    throw new Error(
      `demo vault not found at ${root} (expected graph/graph.duckdb). ` +
        `The honesty sweep asserts against it and must NOT be skipped — ` +
        `a skipped honesty gate is indistinguishable from a passing one.`,
    );
  }
  return root;
};

/** Path to the independent ground-truth manifest shipped with the demo vault. */
export const demoVaultTruthManifest = (): string =>
  resolve(resolveDemoVaultRoot(), 'truth', 'manifest.json');
