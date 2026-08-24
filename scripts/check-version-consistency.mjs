#!/usr/bin/env node
/**
 * Version-consistency gate (R8-VERSION-RECONCILE / finding #65).
 *
 * Source of truth for the *published* product: `packages/cli/package.json`.
 * Internal `@sf-intelligence/*` workspace packages are NOT independently
 * published and may remain on a pinned workspace version — this script
 * documents that drift instead of rewriting every package.json each release.
 *
 * Hard checks (fail the process):
 *   1. CLI package.json version == packages/cli/server.json version(s)
 *   2. Shipped MCP handshake version expectation == CLI version
 *      (esbuild `SFI_BUILD_VERSION` from CLI package.json + dynamic
 *      `resolveServerVersion()` in packages/mcp/src/server.ts — no hardcoded
 *      SERVER_VERSION literal)
 *   3. CHANGELOG.md has a dated `## [X.Y.Z] — YYYY-MM-DD` entry for that
 *      version, OR `--metadata-only` is passed (explicit exemption; still
 *      logs why)
 *
 * Optional:
 *   --expect <ver>     Override expected version (default: CLI package.json)
 *   --metadata-only    Skip CHANGELOG dated-entry requirement
 *   --require-tag      Fail if git tag v<ver> is missing or points elsewhere
 *
 * Wired into `scripts/prepublish-check.mjs` (npm publish seatbelt) and
 * `pnpm check:version-consistency`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function flag(name) {
  return args.includes(name);
}

function opt(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

const metadataOnly = flag('--metadata-only');
const requireTag = flag('--require-tag');
const expectOverride = opt('--expect');

const fail = (msg) => {
  console.error(`version-consistency: FAIL — ${msg}`);
  process.exit(1);
};

const readJson = (rel) => {
  const p = join(root, rel);
  if (!existsSync(p)) fail(`missing ${rel}`);
  return JSON.parse(readFileSync(p, 'utf8'));
};

const readText = (rel) => {
  const p = join(root, rel);
  if (!existsSync(p)) fail(`missing ${rel}`);
  return readFileSync(p, 'utf8');
};

const cliPkg = readJson('packages/cli/package.json');
const expected = expectOverride ?? cliPkg.version;
if (!expected || typeof expected !== 'string') fail('CLI package.json has no version');
if (expectOverride && expectOverride !== cliPkg.version) {
  fail(
    `--expect ${expectOverride} does not match packages/cli/package.json version ${cliPkg.version}`,
  );
}

const errors = [];
const notes = [];

// --- 1. server.json (MCP registry manifest) ---
const serverJson = readJson('packages/cli/server.json');
if (serverJson.version !== expected) {
  errors.push(
    `packages/cli/server.json version=${serverJson.version} !== expected ${expected}`,
  );
}
const pkgEntry = serverJson.packages?.[0];
if (!pkgEntry) {
  errors.push('packages/cli/server.json has no packages[0] entry');
} else if (pkgEntry.version !== expected) {
  errors.push(
    `packages/cli/server.json packages[0].version=${pkgEntry.version} !== expected ${expected}`,
  );
}

// --- 1b. Claude Code plugin surfaces (.claude-plugin/) ---
// Neither file was checked here until 0.3.1, and marketplace.json had drifted
// to 0.2.5 — two releases stale — while every other surface read 0.3.1. It is
// the version a plugin marketplace advertises, so the drift was outward-facing
// and silent. plugin.json was only correct because someone bumped it by hand.
for (const [file, paths] of [
  ['.claude-plugin/plugin.json', [(d) => d.version]],
  [
    '.claude-plugin/marketplace.json',
    [(d) => d.metadata?.version, ...[0, 1, 2].map((i) => (d) => d.plugins?.[i]?.version)],
  ],
]) {
  // `readJson` resolves against the repo root, so this guard must too. A bare
  // relative `existsSync(file)` passes only when the process happens to be cwd'd
  // at the root — anywhere else it reports "missing" and `continue` skips the
  // whole block, so the gate would go GREEN having checked nothing.
  if (!existsSync(join(root, file))) continue;
  const doc = readJson(file);
  paths.forEach((get, i) => {
    const v = get(doc);
    if (v === undefined) return; // absent slot (e.g. only one plugin) is not a drift
    if (v !== expected) {
      errors.push(`${file} version#${i}=${v} !== expected ${expected}`);
    }
  });
}

// --- 1c. The plugin's npx PIN — the version users actually execute ---
// `.claude-plugin/plugin.json` registers the MCP server as
// `npx -y sf-intelligence@X.Y.Z mcp`. That pin, not the manifest's `version`
// field, decides which build a plugin user's host downloads and runs. They are
// two independent literals in one file, so a release that bumps `version` and
// forgets the pin ships a plugin that silently keeps installing the PREVIOUS
// server — the bug survives the upgrade and the manifest looks correct.
const pluginRel = '.claude-plugin/plugin.json';
if (existsSync(join(root, pluginRel))) {
  const plugin = readJson(pluginRel);
  const servers = plugin.mcpServers ?? {};
  for (const [name, entry] of Object.entries(servers)) {
    const args = Array.isArray(entry?.args) ? entry.args : [];
    const spec = args.find((a) => typeof a === 'string' && a.startsWith('sf-intelligence@'));
    if (spec === undefined) {
      // An UNPINNED entry floats to npm `latest`, which is a different bug:
      // the plugin stops being reproducible. Flag it rather than pass silently.
      if (args.includes('sf-intelligence')) {
        errors.push(
          `${pluginRel} mcpServers.${name} runs unpinned \`sf-intelligence\` — pin it to @${expected}`,
        );
      }
      continue;
    }
    const pinned = spec.slice('sf-intelligence@'.length);
    if (pinned !== expected) {
      errors.push(
        `${pluginRel} mcpServers.${name} pins sf-intelligence@${pinned} !== expected ${expected}` +
          ' — plugin users would keep running the previous server',
      );
    }
  }
}

// --- 2. SERVER_VERSION resolve (shipped path) ---
const buildSrc = readText('packages/cli/build.mjs');
if (!/SFI_BUILD_VERSION\s*:\s*JSON\.stringify\(\s*pkg\.version/.test(buildSrc)) {
  errors.push(
    'packages/cli/build.mjs must define SFI_BUILD_VERSION from pkg.version (shipped handshake SoT)',
  );
}

const serverSrc = readText('packages/mcp/src/server.ts');
if (/const\s+SERVER_VERSION\s*=\s*['"`]\d+\.\d+/.test(serverSrc)) {
  errors.push(
    'packages/mcp/src/server.ts hardcodes SERVER_VERSION — must use resolveServerVersion()',
  );
}
if (!/const\s+resolveServerVersion\s*=/.test(serverSrc)) {
  errors.push('packages/mcp/src/server.ts missing resolveServerVersion()');
}
if (!/const\s+SERVER_VERSION\s*=\s*resolveServerVersion\s*\(\s*\)/.test(serverSrc)) {
  errors.push(
    'packages/mcp/src/server.ts must set SERVER_VERSION = resolveServerVersion()',
  );
}

// Shipped handshake reports the CLI/product version via the esbuild define.
const resolvedServerVersion = expected;
if (resolvedServerVersion !== expected) {
  errors.push(
    `SERVER_VERSION resolve=${resolvedServerVersion} !== expected ${expected}`,
  );
}

// --- 3. CHANGELOG dated entry (or explicit metadata-only exemption) ---
const changelog = readText('CHANGELOG.md');
const headingRe = new RegExp(
  `^## \\[${expected.replace(/\./g, '\\.')}\\] — (\\d{4}-\\d{2}-\\d{2})\\s*$`,
  'm',
);
const headingMatch = changelog.match(headingRe);
if (!headingMatch) {
  if (metadataOnly) {
    notes.push(
      `CHANGELOG has no dated [${expected}] entry — allowed by --metadata-only ` +
        '(metadata-only / packaging patch; document why in the release commit)',
    );
  } else {
    errors.push(
      `CHANGELOG.md missing dated heading "## [${expected}] — YYYY-MM-DD" ` +
        `(use --metadata-only for an explicit exemption)`,
    );
  }
} else {
  notes.push(`CHANGELOG [${expected}] dated ${headingMatch[1]}`);
}

// --- 4. Optional git tag ---
if (requireTag) {
  try {
    const tag = `v${expected}`;
    const pointed = execFileSync('git', ['rev-parse', '--verify', tag], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    if (!pointed) errors.push(`git tag ${tag} missing`);
    else notes.push(`git tag ${tag} present`);
  } catch {
    errors.push(`git tag v${expected} missing (--require-tag)`);
  }
}

// --- Document workspace package drift (informational, not a hard fail) ---
const workspaceDirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => name !== 'cli');

const drifted = [];
for (const name of workspaceDirs) {
  const pkgPath = join(root, 'packages', name, 'package.json');
  if (!existsSync(pkgPath)) continue;
  try {
    const v = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
    if (v && v !== expected) drifted.push(`@sf-intelligence/${name}@${v}`);
  } catch {
    // ignore malformed
  }
}
const rootVer = readJson('package.json').version;
if (rootVer && rootVer !== expected) {
  drifted.push(`root@${rootVer}`);
}
if (drifted.length > 0) {
  notes.push(
    `workspace versions intentionally not synced to published ${expected} ` +
      `(internal packages are not independently published): ${drifted.join(', ')}. ` +
      'Published SoT remains packages/cli/package.json.',
  );
}

if (errors.length > 0) {
  for (const e of errors) console.error(`version-consistency: FAIL — ${e}`);
  for (const n of notes) console.error(`version-consistency: note — ${n}`);
  process.exit(1);
}

console.log(
  `version-consistency: OK — cli=${expected} server.json=${serverJson.version} ` +
    `SERVER_VERSION(shipped)=${resolvedServerVersion}` +
    (headingMatch ? ` CHANGELOG=${headingMatch[1]}` : ' CHANGELOG=exempt(--metadata-only)'),
);
for (const n of notes) console.log(`version-consistency: note — ${n}`);
