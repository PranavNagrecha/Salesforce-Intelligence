#!/usr/bin/env node
/**
 * Generate eval/product-manifest.json from runtime registries.
 *
 *   node scripts/generate-product-manifest.mjs
 *   node scripts/generate-product-manifest.mjs --check   # exit 1 if drifted
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProductManifest,
  manifestDrift,
  stripVolatile,
} from './lib/build-product-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'eval/product-manifest.json');
const checkOnly = process.argv.includes('--check');

const manifest = await buildProductManifest(root);
const forCommit = stripVolatile(manifest);
const serialized = `${JSON.stringify(forCommit, null, 2)}\n`;

if (checkOnly) {
  if (!existsSync(outPath)) {
    console.error(
      `Missing ${outPath}. Run: node scripts/generate-product-manifest.mjs`,
    );
    process.exit(1);
  }
  const committed = JSON.parse(readFileSync(outPath, 'utf8'));
  const drift = manifestDrift(committed, manifest);
  if (drift) {
    console.error(
      `eval/product-manifest.json is stale vs runtime registries ` +
        `(committed content sha256:${drift.expectedHash}, live sha256:${drift.actualHash}` +
        (drift.changedKeys.length
          ? `; changed keys: ${drift.changedKeys.join(', ')}`
          : '') +
        `). Run: node scripts/generate-product-manifest.mjs`,
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        version: manifest.version,
        tools: manifest.tools.total,
        advertised: manifest.tools.advertised,
        concepts: manifest.conceptModel.concepts,
        rules: manifest.conceptModel.rules,
        identityHash: manifest.identityHash,
        generatedAt: manifest.generatedAt,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

writeFileSync(outPath, serialized);
console.log(
  `Wrote ${outPath} — ${manifest.tools.total} tools ` +
    `(${manifest.tools.advertised} advertised), ` +
    `${manifest.conceptModel.concepts} concepts / ${manifest.conceptModel.rules} rules, ` +
    `identity ${manifest.identityHash} (generatedAt ${manifest.generatedAt}, not committed)`,
);
