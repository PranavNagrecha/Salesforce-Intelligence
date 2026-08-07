#!/usr/bin/env node
/**
 * Generate a CycloneDX SBOM for the published CLI package (AUDIT-F10 / Wave 4).
 *
 * Uses @cyclonedx/cdxgen against the pnpm workspace (not `npm sbom`, which is
 * unavailable / empty under pnpm). Fails closed if the artifact is missing,
 * empty, or has no components.
 *
 *   node scripts/generate-sbom.mjs
 *   node scripts/generate-sbom.mjs --out sbom.cdx.json
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outIdx = process.argv.indexOf('--out');
const outPath = resolve(
  root,
  outIdx >= 0 && process.argv[outIdx + 1]
    ? process.argv[outIdx + 1]
    : 'sbom.cdx.json',
);

const cdxgenPkg = '@cyclonedx/cdxgen@11.6.0';
const args = [
  'dlx',
  cdxgenPkg,
  '-t',
  'pnpm',
  '-o',
  outPath,
  '--spec-version',
  '1.5',
  '--no-babel',
  join(root, 'packages/cli'),
];

console.log(`Generating CycloneDX SBOM via pnpm ${args.join(' ')}`);
const result = spawnSync('pnpm', args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    // cdxgen is network-capable; CI already has registry access.
    CDXGEN_DEBUG_MODE: process.env.CDXGEN_DEBUG_MODE ?? 'false',
  },
});

if (result.status !== 0) {
  console.error(`generate-sbom: cdxgen exited ${result.status}`);
  process.exit(result.status ?? 1);
}

if (!existsSync(outPath) || statSync(outPath).size < 64) {
  console.error(`generate-sbom: missing or empty SBOM at ${outPath}`);
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(readFileSync(outPath, 'utf8'));
} catch (error) {
  console.error(`generate-sbom: invalid JSON at ${outPath}: ${error.message}`);
  process.exit(1);
}

const components = Array.isArray(doc.components) ? doc.components : [];
if (components.length === 0) {
  console.error(
    `generate-sbom: ${outPath} has zero components — refusing empty SBOM`,
  );
  process.exit(1);
}

const bomFormat = doc.bomFormat ?? doc.bomformat;
if (bomFormat !== 'CycloneDX') {
  console.error(
    `generate-sbom: expected bomFormat CycloneDX, got ${String(bomFormat)}`,
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      outPath,
      bomFormat,
      specVersion: doc.specVersion ?? null,
      componentCount: components.length,
      bytes: statSync(outPath).size,
    },
    null,
    2,
  ),
);
