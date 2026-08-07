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
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildProductManifest,
  toProductSurface,
} from './lib/build-product-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = await buildProductManifest(root);
const surface = toProductSurface(manifest);

if (process.argv.includes('--write')) {
  const surfacePath = join(root, 'eval/product-surface.json');
  const manifestPath = join(root, 'eval/product-manifest.json');
  writeFileSync(surfacePath, `${JSON.stringify(surface, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${surfacePath}`);
  console.log(`Wrote ${manifestPath}`);
} else {
  console.log(JSON.stringify(surface, null, 2));
}
