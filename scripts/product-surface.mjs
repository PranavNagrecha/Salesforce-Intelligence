#!/usr/bin/env node
/**
 * Product surface counts — thin wrapper over the ProductManifest builder.
 *
 * Emits a compact JSON count object to stdout (backward-compatible with
 * website/recalibrate.mjs and existing tests). Prefer
 * `node scripts/generate-product-manifest.mjs` for the full SSOT artifact.
 *
 * Run: node scripts/product-surface.mjs
 *      node scripts/product-surface.mjs --write
 *      node scripts/product-surface.mjs --check
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProductManifest,
  manifestDrift,
  stripVolatile,
  toProductSurface,
} from './lib/build-product-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const surfacePath = join(root, 'eval/product-surface.json');
const manifestPath = join(root, 'eval/product-manifest.json');
const write = process.argv.includes('--write');
const checkOnly = process.argv.includes('--check');

const manifest = await buildProductManifest(root);
const surface = toProductSurface(manifest);

if (checkOnly) {
  if (!existsSync(surfacePath)) {
    console.error(
      `Missing ${surfacePath}. Run: node scripts/product-surface.mjs --write`,
    );
    process.exit(1);
  }
  if (!existsSync(manifestPath)) {
    console.error(
      `Missing ${manifestPath}. Run: node scripts/generate-product-manifest.mjs`,
    );
    process.exit(1);
  }
  const committedSurface = stripVolatile(
    JSON.parse(readFileSync(surfacePath, 'utf8')),
  );
  const committedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const projected = toProductSurface(committedManifest);
  const vsManifest = manifestDrift(committedSurface, projected);
  if (vsManifest) {
    console.error(
      `eval/product-surface.json drifted from eval/product-manifest.json ` +
        `(surface sha256:${vsManifest.expectedHash}, projection sha256:${vsManifest.actualHash}` +
        (vsManifest.changedKeys.length
          ? `; changed keys: ${vsManifest.changedKeys.join(', ')}`
          : '') +
        `). Run: node scripts/product-surface.mjs --write`,
    );
    process.exit(1);
  }
  const vsLive = manifestDrift(committedSurface, surface);
  if (vsLive) {
    console.error(
      `eval/product-surface.json drifted from runtime registries ` +
        `(committed sha256:${vsLive.expectedHash}, live sha256:${vsLive.actualHash}` +
        (vsLive.changedKeys.length
          ? `; changed keys: ${vsLive.changedKeys.join(', ')}`
          : '') +
        `). Run: node scripts/product-surface.mjs --write`,
    );
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, ...surface }, null, 2));
  process.exit(0);
}

if (write) {
  writeFileSync(surfacePath, `${JSON.stringify(surface, null, 2)}\n`);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(stripVolatile(manifest), null, 2)}\n`,
  );
  console.log(`Wrote ${surfacePath}`);
  console.log(`Wrote ${manifestPath}`);
} else {
  console.log(JSON.stringify(surface, null, 2));
}
