#!/usr/bin/env node
/**
 * Generate a CycloneDX SBOM for the published CLI package (AUDIT-F10 / Wave 4).
 *
 * WHAT THIS HAS TO BE HONEST ABOUT
 * --------------------------------
 * SECURITY.md promises a real SBOM on the GitHub Release. What a user actually
 * receives from `npm i sf-intelligence` is `dist/index.js` (an esbuild bundle of
 * the @sf-intelligence/* workspace packages) PLUS the full transitive install of
 * packages/cli's `dependencies` block — every third-party package is external to
 * the bundle (see packages/cli/build.mjs EXTERNAL_PACKAGES). So the SBOM must
 * carry that whole runtime closure, not the direct manifest entries.
 *
 * It previously carried 19 components and an EMPTY dependency graph, because
 * cdxgen was pointed at `packages/cli`, which has no `pnpm-lock.yaml`. With no
 * lockfile to resolve, cdxgen's pnpm collector falls back to reading
 * package.json alone: 7 runtime deps + 10 workspace devDeps + esbuild + vitest,
 * zero transitives, zero edges. Pointing it at the workspace root — where
 * pnpm-lock.yaml lives — makes it resolve the real graph.
 *
 * HOW THIS SCRIPT BUILDS THE ANSWER
 * ---------------------------------
 *  1. cdxgen scans the workspace ROOT, so it resolves from pnpm-lock.yaml.
 *     That yields the whole workspace (runtime + dev, ~546 components).
 *  2. cdxgen 11.6.0's pnpm collector emits edges for a snapshot's
 *     `dependencies` but NOT its `optionalDependencies`, which silently drops
 *     every platform-specific native binary (@duckdb/node-bindings-*) — npm DOES
 *     install the matching one on the user's machine, and native binaries are
 *     the part of the tree an SBOM is most needed for. Those edges are read
 *     straight out of pnpm-lock.yaml and merged in.
 *  3. The graph is walked from packages/cli's `dependencies` block only, so
 *     devDependencies are excluded by construction (correct: they never ship).
 *  4. The result is re-rooted on the published package identity and emitted with
 *     a populated `dependencies` graph.
 *
 * Fails closed: missing / empty / unparseable artifact, zero components, a
 * component count too low to be a real closure, an empty or flat dependency
 * graph, or a dangling graph reference all exit non-zero.
 *
 *   node scripts/generate-sbom.mjs
 *   node scripts/generate-sbom.mjs --out sbom.cdx.json
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * Plausibility floors. The bug this replaces produced 19 components and 0 edges,
 * so both floors are set to catch that shape rather than to track the exact
 * current number (which moves with every dependency bump).
 *
 * The real runtime closure is ~137 components. The single largest subtree is
 * @modelcontextprotocol/sdk (92 of them); dropping it entirely would still leave
 * ~40. MIN_COMPONENTS is set at that level: comfortably above any
 * manifest-only regression (<= 19) and below any plausible dependency churn.
 */
const MIN_COMPONENTS = 40;
/** A manifest-only BOM has zero linked nodes; a real closure has dozens. */
const MIN_LINKED_NODES = 10;

const cdxgenPkg = '@cyclonedx/cdxgen@11.6.0';
const lockPath = join(root, 'pnpm-lock.yaml');
const cliPkgPath = join(root, 'packages/cli/package.json');

const fail = (message) => {
  console.error(`generate-sbom: ${message}`);
  process.exit(1);
};

if (!existsSync(lockPath)) {
  fail(`no pnpm-lock.yaml at ${lockPath} — cannot resolve a real dependency graph`);
}
if (!existsSync(cliPkgPath)) {
  fail(`no published-package manifest at ${cliPkgPath}`);
}

const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'));
const runtimeDeps = Object.keys(cliPkg.dependencies ?? {});
if (runtimeDeps.length === 0) {
  fail(`${cliPkgPath} declares no dependencies — refusing to emit an empty SBOM`);
}

// ---------------------------------------------------------------------------
// pnpm-lock.yaml: the optionalDependencies edges cdxgen drops.
// ---------------------------------------------------------------------------

const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, '');
/** pnpm suffixes snapshot keys with their peer resolution: `foo@1.0.0(bar@2.0.0)`. */
const stripPeerSuffix = (value) => value.replace(/\(.*\)$/, '');

/**
 * Read `packages:` peerDependencies and `snapshots:` optionalDependencies out of
 * pnpm-lock.yaml.
 *
 * Deliberately NOT a general YAML parser — it walks the fixed two-space-indented
 * shape pnpm writes and ignores everything else, so a lockfile format change
 * degrades to "found nothing" (caught by the assertion at the call site) rather
 * than to silently wrong edges.
 *
 * Both sections are needed because pnpm records an auto-installed optional PEER
 * under `optionalDependencies` too (this workspace sets `autoInstallPeers`).
 * `@inquirer/prompts` -> `@types/node` looks identical to
 * `@duckdb/node-bindings` -> `@duckdb/node-bindings-darwin-arm64` at the
 * snapshot level. Only the first is a peer, and npm does NOT install optional
 * peers for a consumer — so peers are filtered back out and real
 * optionalDependencies are kept.
 */
function readLockfileSections(text) {
  const peersOf = new Map();
  const optionalOf = new Map();
  let section = null;
  let pkgKey = null;
  let subKey = null;

  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      section = line.split(':')[0];
      pkgKey = null;
      subKey = null;
      continue;
    }
    if (section !== 'packages' && section !== 'snapshots') continue;

    let match;
    if ((match = line.match(/^ {2}(\S.*?):\s*$/))) {
      pkgKey = stripPeerSuffix(unquote(match[1]));
      subKey = null;
      continue;
    }
    if ((match = line.match(/^ {4}(\S.*?):\s*$/))) {
      subKey = unquote(match[1]);
      continue;
    }
    if ((match = line.match(/^ {6}(\S.*?):\s*(\S.*)$/))) {
      if (!pkgKey) continue;
      const child = unquote(match[1]);
      if (section === 'packages' && subKey === 'peerDependencies') {
        if (!peersOf.has(pkgKey)) peersOf.set(pkgKey, new Set());
        peersOf.get(pkgKey).add(child);
      } else if (section === 'snapshots' && subKey === 'optionalDependencies') {
        const version = stripPeerSuffix(unquote(match[2]));
        if (!optionalOf.has(pkgKey)) optionalOf.set(pkgKey, []);
        optionalOf.get(pkgKey).push({ name: child, version });
      }
    }
  }
  return { peersOf, optionalOf };
}

const lockText = readFileSync(lockPath, 'utf8');
const { peersOf, optionalOf } = readLockfileSections(lockText);
if (lockText.includes('\n    optionalDependencies:') && optionalOf.size === 0) {
  fail(
    'pnpm-lock.yaml declares optionalDependencies but none were parsed — ' +
      'the lockfile reader is out of date with the lockfile format',
  );
}

// ---------------------------------------------------------------------------
// cdxgen: resolve the workspace from the lockfile.
// ---------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), 'sfi-sbom-'));
const rawPath = join(workDir, 'workspace.cdx.json');
// `fail()` calls process.exit, which does NOT unwind through a finally block —
// an exit hook is the only cleanup that runs on every path.
process.on('exit', () => rmSync(workDir, { recursive: true, force: true }));

const args = [
  'dlx',
  cdxgenPkg,
  '-t',
  'pnpm',
  '-o',
  rawPath,
  '--spec-version',
  '1.5',
  '--no-babel',
  // cdxgen otherwise runs `pnpm install` inside the scanned directory. The
  // lockfile is what it actually reads, node_modules is already installed in CI
  // and locally, and a surprise install is a side effect a generator should not
  // have.
  '--no-install-deps',
  // Scan the workspace ROOT: this is the directory that holds pnpm-lock.yaml,
  // and without it cdxgen resolves nothing but the direct manifest entries.
  root,
];

console.log(`Generating CycloneDX SBOM via pnpm ${args.join(' ')}`);
const result = spawnSync('pnpm', args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    CDXGEN_DEBUG_MODE: process.env.CDXGEN_DEBUG_MODE ?? 'false',
  },
});

if (result.status !== 0) {
  fail(`cdxgen exited ${result.status}`);
}
if (!existsSync(rawPath) || statSync(rawPath).size < 64) {
  fail(`missing or empty cdxgen output at ${rawPath}`);
}

let raw;
try {
  raw = JSON.parse(readFileSync(rawPath, 'utf8'));
} catch (error) {
  fail(`invalid JSON from cdxgen at ${rawPath}: ${error.message}`);
}

const rawComponents = Array.isArray(raw.components) ? raw.components : [];
if (rawComponents.length === 0) {
  fail('cdxgen returned zero components for the workspace');
}

// -------------------------------------------------------------------------
// Index, then merge the lockfile's optionalDependencies edges.
// -------------------------------------------------------------------------

const fullName = (component) =>
  (component.group ? `${component.group}/` : '') + component.name;
const byRef = new Map();
const refByNameVersion = new Map();
for (const component of rawComponents) {
  const ref = component['bom-ref'];
  if (!ref) continue;
  byRef.set(ref, component);
  refByNameVersion.set(`${fullName(component)}@${component.version}`, ref);
}

const edges = new Map();
for (const entry of Array.isArray(raw.dependencies) ? raw.dependencies : []) {
  if (entry?.ref) {
    edges.set(entry.ref, new Set(entry.dependsOn ?? []));
  }
}

/** parentRef -> childRef pairs recovered from the lockfile, for reporting. */
const mergedOptionalEdges = new Set();
for (const [parentKey, children] of optionalOf) {
  const parentRef = refByNameVersion.get(parentKey);
  if (!parentRef) continue;
  const peers = peersOf.get(parentKey) ?? new Set();
  for (const child of children) {
    // An optional PEER is a pnpm autoInstallPeers artifact, not something a
    // consumer's npm install pulls down. Only real optionalDependencies ship.
    if (peers.has(child.name)) continue;
    const childRef = refByNameVersion.get(`${child.name}@${child.version}`);
    // Never invent a component: an edge is only added when both ends already
    // exist in the cdxgen output.
    if (!childRef) continue;
    if (!edges.has(parentRef)) edges.set(parentRef, new Set());
    if (!edges.get(parentRef).has(childRef)) {
      edges.get(parentRef).add(childRef);
      mergedOptionalEdges.add(`${parentRef}|${childRef}`);
    }
  }
}

// -------------------------------------------------------------------------
// Walk the runtime closure of the published package.
// -------------------------------------------------------------------------

const publishedRef = `pkg:npm/${cliPkg.name}@${cliPkg.version}`;
const publishedEdges = edges.get(publishedRef);
if (!publishedEdges) {
  fail(
    `cdxgen produced no dependency node for ${publishedRef} — ` +
      'cannot determine what the published package installs',
  );
}

// Keep only the `dependencies` block: workspace packages and build tooling are
// devDependencies of packages/cli and never reach a user's node_modules.
const wanted = new Set(runtimeDeps);
const seeds = [];
const seenNames = new Set();
for (const ref of publishedEdges) {
  const component = byRef.get(ref);
  if (!component) continue;
  const name = fullName(component);
  if (!wanted.has(name)) continue;
  seeds.push(ref);
  seenNames.add(name);
}
const unresolved = runtimeDeps.filter((name) => !seenNames.has(name));
if (unresolved.length > 0) {
  fail(
    `these runtime dependencies did not resolve in the workspace graph: ${unresolved.join(', ')}`,
  );
}

const closure = new Set(seeds);
const queue = [...seeds];
while (queue.length > 0) {
  const ref = queue.shift();
  for (const next of edges.get(ref) ?? []) {
    if (!byRef.has(next)) continue; // workspace-only refs carry no component
    if (closure.has(next)) continue;
    closure.add(next);
    queue.push(next);
  }
}

const components = [...closure]
  .map((ref) => byRef.get(ref))
  .sort((a, b) => fullName(a).localeCompare(fullName(b)));

const dependencies = [
  { ref: publishedRef, dependsOn: [...seeds].sort() },
  ...components.map((component) => ({
    ref: component['bom-ref'],
    dependsOn: [...(edges.get(component['bom-ref']) ?? [])]
      .filter((ref) => closure.has(ref))
      .sort(),
  })),
];

// -------------------------------------------------------------------------
// Re-root the document on the published package.
// -------------------------------------------------------------------------

const externalReferences = [];
if (cliPkg.homepage) {
  externalReferences.push({ type: 'website', url: cliPkg.homepage });
}
if (cliPkg.repository?.url) {
  externalReferences.push({ type: 'vcs', url: cliPkg.repository.url });
}
if (cliPkg.bugs?.url) {
  externalReferences.push({ type: 'issue-tracker', url: cliPkg.bugs.url });
}

const doc = {
  bomFormat: 'CycloneDX',
  specVersion: raw.specVersion ?? '1.5',
  serialNumber: raw.serialNumber,
  version: 1,
  metadata: {
    ...raw.metadata,
    component: {
      type: 'application',
      'bom-ref': publishedRef,
      name: cliPkg.name,
      version: cliPkg.version,
      description: cliPkg.description,
      purl: publishedRef,
      ...(cliPkg.license ? { licenses: [{ expression: cliPkg.license }] } : {}),
      ...(externalReferences.length > 0 ? { externalReferences } : {}),
    },
    properties: [
      ...(Array.isArray(raw.metadata?.properties) ? raw.metadata.properties : []),
      {
        name: 'sfi:sbom:scope',
        value:
          'Transitive runtime closure of the published npm package. ' +
          'devDependencies (including the bundled @sf-intelligence/* workspace ' +
          'packages and build tooling) are excluded: they do not reach a user.',
      },
      {
        name: 'sfi:sbom:resolved-from',
        value: `pnpm-lock.yaml via ${cdxgenPkg} (workspace-root scan), plus optionalDependencies edges read from the lockfile`,
      },
    ],
  },
  components,
  dependencies,
};

// -------------------------------------------------------------------------
// Fail closed.
// -------------------------------------------------------------------------

if (components.length === 0) {
  fail('runtime closure is empty — refusing empty SBOM');
}
if (components.length < MIN_COMPONENTS) {
  fail(
    `runtime closure has only ${components.length} components (floor ${MIN_COMPONENTS}). ` +
      'That is the signature of a manifest-only resolve, not a real transitive ' +
      'closure — refusing to ship an SBOM that under-reports what users install.',
  );
}
if (dependencies.length === 0) {
  fail('dependency graph is empty — refusing to ship a graphless SBOM');
}
const linkedNodes = dependencies.filter(
  (entry) => (entry.dependsOn ?? []).length > 0,
).length;
if (linkedNodes < MIN_LINKED_NODES) {
  fail(
    `dependency graph has only ${linkedNodes} linked nodes (floor ${MIN_LINKED_NODES}) — ` +
      'the graph is flat, so transitive edges were not resolved',
  );
}
const knownRefs = new Set([publishedRef, ...closure]);
for (const entry of dependencies) {
  for (const ref of entry.dependsOn ?? []) {
    if (!knownRefs.has(ref)) {
      fail(`dependency graph references unknown component ${ref}`);
    }
  }
}

writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
if (!existsSync(outPath) || statSync(outPath).size < 64) {
  fail(`missing or empty SBOM at ${outPath}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      outPath,
      bomFormat: doc.bomFormat,
      specVersion: doc.specVersion,
      componentCount: components.length,
      directRuntimeDeps: seeds.length,
      dependencyGraphNodes: dependencies.length,
      linkedNodes,
      // Scoped to the shipped closure. Many more optional edges are merged into
      // the workspace graph (esbuild, sharp, …), but those hang off
      // devDependencies and are correctly never walked.
      optionalEdgesRecoveredInClosure: [...mergedOptionalEdges].filter((pair) => {
        const [parent, child] = pair.split('|');
        return closure.has(parent) && closure.has(child);
      }).length,
      workspaceComponentsScanned: rawComponents.length,
      bytes: statSync(outPath).size,
    },
    null,
    2,
  ),
);
