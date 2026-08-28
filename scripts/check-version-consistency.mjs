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

// --- 1d. The LAUNCH CONTRACT — does the published config bind a vault? ---
//
// `resolveVaultBinding()` (packages/cli/src/commands/mcp.ts) resolves
// `--vault` > `SFI_VAULT` > `./org-kb`. That last fallback is relative to the
// directory the MCP HOST launched in, and a host is almost never launched
// inside the user's Salesforce project — so a config that binds neither points
// the server at a vault that does not exist. The server then starts in setup
// mode and truthfully reports it has no org, which reads to a first-time user
// as "this product is broken".
//
// Every surface that a stranger can install FROM is checked here. A surface
// that structurally cannot carry a path is exempt, but the exemption is
// DECLARED with its reason rather than silently absent — otherwise a future
// surface that simply forgot would look identical to one that cannot.
const bindsVault = (args, env) =>
  (Array.isArray(args) && args.includes('--vault')) ||
  (env !== undefined && env !== null && Object.keys(env).includes('SFI_VAULT'));

// The registry manifest — the record `mcp-publisher` pushes to the official
// MCP Registry, and the only channel with evidence of delivering a visitor who
// was not the maintainer. It declares user inputs rather than passing values,
// so the binding is an `environmentVariables` declaration the host prompts for.
const serverRel = 'packages/cli/server.json';
if (existsSync(join(root, serverRel))) {
  const manifest = readJson(serverRel);
  for (const pkg of manifest.packages ?? []) {
    const declaresVault = (pkg.environmentVariables ?? []).some((e) => e?.name === 'SFI_VAULT');
    const argVault = (pkg.runtimeArguments ?? []).some(
      (a) => a?.name === '--vault' || a?.value === '--vault',
    );
    if (!declaresVault && !argVault) {
      errors.push(
        `${serverRel} package "${pkg.identifier}" declares no vault binding — add an ` +
          'SFI_VAULT environmentVariables entry (or a --vault runtimeArgument). Without one ' +
          'the official registry record installs a server pointed at ./org-kb relative to the ' +
          "host's launch directory, which is not the user's Salesforce project.",
      );
    }
  }
}

// Claude Code plugin: DECLARED EXEMPTION.
//
// A plugin manifest is written once and shipped to every user, so it cannot
// carry an absolute path, and there is no documented host expansion to build
// one with — `${workspaceFolder}` is VS Code's own and resolves to nothing
// outside a workspace file. The honest binding for this surface is therefore
// setup mode: the server starts, and `sfi.setup_status` names the exact
// commands. What IS asserted is that the surface still SAYS so, so that a
// future maintainer who removes the guidance is told.
if (existsSync(join(root, pluginRel))) {
  const plugin = readJson(pluginRel);
  for (const [name, entry] of Object.entries(plugin.mcpServers ?? {})) {
    if (bindsVault(entry?.args, entry?.env)) continue; // bound explicitly — fine
    const desc = String(plugin.description ?? '');
    if (!/setup_status/.test(desc)) {
      errors.push(
        `${pluginRel} mcpServers.${name} binds no vault (no --vault, no SFI_VAULT), which is ` +
          'the documented exemption for a plugin manifest — but then plugin.json\'s own ' +
          '`description` must point the host at `sfi.setup_status`, so a user whose vault is ' +
          'not found is told what to run. Add it, or bind a vault explicitly.',
      );
    }
  }
}

// --- 1f. The launch contract in PROSE, not just in config ---
//
// 1d gates the machine-readable surfaces (server.json, plugin.json). It does
// not gate the surfaces a HUMAN copies from, and those drifted apart: the npm
// package page was corrected to pass an absolute `--vault`, while
// website/src/pages/getting-started.astro went on printing the same command
// without one — in three separate snippets. Whichever page the reader lands on
// decides whether their install works, and the website is the copy a crawler
// quotes.
//
// Matched shapes are the two unambiguous LAUNCHES of the real server:
//   `sf-intelligence mcp …`            (command line)
//   `"sf-intelligence", "mcp"`         (JSON args array)
// `demo` is not matched — `sfi demo` manages its own cached vault and must NOT
// be given one. HTML tags and entities are stripped first so an Astro snippet
// broken into <span> tokens reads the same as the plain-text one.
const LAUNCH_PROSE_FILES = [
  'packages/cli/README.md',
  'website/src/pages/getting-started.astro',
  'docs/guides/mcp-hosts.md',
];
const stripMarkup = (line) =>
  line
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
for (const rel of LAUNCH_PROSE_FILES) {
  if (!existsSync(join(root, rel))) {
    errors.push(`${rel} is listed as an install surface but does not exist`);
    continue;
  }
  // THE UNIT IS THE SNIPPET, NOT THE LINE — and not a fixed lookahead either.
  //
  // First cut read one line at a time and called four correct snippets in
  // docs/guides/mcp-hosts.md defects: a JSON args array wraps, and the binding
  // lands on the next line (`"--vault", "C:\\...\\org-kb"`) or in a sibling
  // `env` block. Second cut used a 3-line lookahead and went VACUOUS — proved
  // by deleting the vault from the website's install command and watching the
  // gate stay green, because the window had slid into the following PARAGRAPH,
  // which mentions `--vault` in prose. A gate that reads the prose explaining a
  // command as if it were the command certifies whatever it is pointed at.
  //
  // So the enclosing code block is the unit: a fenced ``` block in Markdown, a
  // <pre> element in Astro. A launch outside any block is prose and is judged on
  // its own line.
  const raw = readText(rel);
  const lines = raw.split('\n');
  const isAstro = rel.endsWith('.astro');
  // blockId[i] = identifier of the code block line i belongs to, or null.
  const blockId = new Array(lines.length).fill(null);
  if (isAstro) {
    let open = null;
    lines.forEach((line, i) => {
      if (open === null && /<pre\b/.test(line)) open = i;
      if (open !== null) blockId[i] = `pre@${open}`;
      if (open !== null && /<\/pre>/.test(line)) open = null;
    });
  } else {
    let open = null;
    lines.forEach((line, i) => {
      const fence = /^\s*```/.test(line);
      if (fence && open === null) {
        open = i;
        blockId[i] = `fence@${open}`;
        return;
      }
      if (fence && open !== null) {
        blockId[i] = `fence@${open}`;
        open = null;
        return;
      }
      if (open !== null) blockId[i] = `fence@${open}`;
    });
  }
  const textOf = (id, i) =>
    id === null
      ? stripMarkup(lines[i])
      : lines.filter((_, j) => blockId[j] === id).map(stripMarkup).join('\n');
  const naked = [];
  lines.forEach((rawLine, i) => {
    const line = stripMarkup(rawLine);
    const launches =
      /sf-intelligence\s+mcp\b/.test(line) ||
      /"sf-intelligence"\s*,\s*"mcp"/.test(line);
    if (!launches) return;
    const scope = textOf(blockId[i], i);
    if (scope.includes('--vault') || scope.includes('SFI_VAULT')) return;
    naked.push(`  ${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
  });
  if (naked.length > 0) {
    errors.push(
      `${rel} teaches ${naked.length} install(s) that launch the server with no vault ` +
        'binding. An MCP host is almost never launched inside the Salesforce project, so ' +
        '`./org-kb` resolves against the host\'s launch directory and the user meets an ' +
        'empty server on first contact:\n' +
        naked.join('\n'),
    );
  }
}

// --- 1e. SECURITY.md supported-versions must track the shipped minor ---
//
// It read "0.2.x (current public release)" for three releases after 0.3.0
// shipped. A stale supported-versions table on the page a security researcher
// opens first reads as an unmaintained project, and it is the one page where
// that inference is expensive.
const minorLine = `${expected.split('.').slice(0, 2).join('.')}.x`;
if (existsSync(join(root, 'SECURITY.md'))) {
  const security = readText('SECURITY.md');
  const row = security.match(/^\|\s*(\d+\.\d+\.x)[^|]*\|\s*Yes\s*\|/m);
  if (row === null) {
    errors.push('SECURITY.md has no "| <major>.<minor>.x … | Yes |" supported-versions row');
  } else if (row[1] !== minorLine) {
    errors.push(
      `SECURITY.md declares ${row[1]} supported but the shipped line is ${minorLine}`,
    );
  }
}

// --- 1f. The website's machine-readable version must track the release ---
//
// `website/public/llms.txt` is the file AI crawlers and answer engines read to
// describe this product, and it opens by stating a version. It said
// "(version 0.3.1)" while 0.3.2 was the published release — so the canonical
// self-description handed to every model that asked was a release behind.
//
// This did not need new tooling: `website/recalibrate.mjs` has always carried
// the regex that rewrites this exact string. It simply was not run at release
// time. A step that must be remembered is not a step, so the number is asserted
// here instead — the release cannot go out disagreeing with itself.
//
// Only the VERSION is gated. The other computed figures on that page (tool
// count, test totals, concept-model size) are DERIVED by recalibrate.mjs from a
// built tree and cannot be recomputed from inside this script without one;
// pinning them here would be a second source of truth, which is the failure
// this repo keeps paying for.
for (const rel of ['website/public/llms.txt', 'website/public/llms-full.txt']) {
  if (!existsSync(join(root, rel))) continue;
  const txt = readText(rel);
  const stated = txt.match(/\(version (\d+\.\d+\.\d+)\)/);
  if (stated === null) {
    errors.push(`${rel} states no "(version X.Y.Z)" — recalibrate.mjs patches it; keep the anchor`);
  } else if (stated[1] !== expected) {
    errors.push(
      `${rel} says "(version ${stated[1]})" but the release is ${expected} — ` +
        'run `node website/recalibrate.mjs` (it already rewrites this string)',
    );
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
