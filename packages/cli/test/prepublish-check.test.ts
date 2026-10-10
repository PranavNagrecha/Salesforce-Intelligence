import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(cliDir, '../../..');

describe('prepublishOnly hook', () => {
  it('wires npm publish to monorepo prepublish-check', () => {
    const pkg = JSON.parse(
      readFileSync(join(cliDir, '../package.json'), 'utf8')
    ) as { scripts?: { prepublishOnly?: string } };
    expect(pkg.scripts?.prepublishOnly).toContain('prepublish-check.mjs');
  });

  it('prepublish-check script exists at repo root', () => {
    const script = join(repoRoot, 'scripts/prepublish-check.mjs');
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('scan-org-leaks.mjs');
    expect(text).toContain('release-guard.mjs');
    expect(text).toContain('check-version-consistency.mjs');
    expect(text).toContain('check-cli-bundle.mjs');
    expect(text).toContain('check-pack-allowlist.mjs');
  });
});

describe('version-consistency check (R8-VERSION-RECONCILE)', () => {
  it('script exists and documents SoT + exemption flag', () => {
    const script = join(repoRoot, 'scripts/check-version-consistency.mjs');
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('packages/cli/package.json');
    expect(text).toContain('--metadata-only');
    expect(text).toContain('resolveServerVersion');
  });

  it('passes on the current tree (cli == server.json == CHANGELOG)', () => {
    const r = spawnSync(process.execPath, ['scripts/check-version-consistency.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stdout).toMatch(/version-consistency: OK/);
  });
});

// KO-c follow-up — FAIL-BEFORE/PASS-AFTER: the publish workflow deleted the
// materialized blocklist right after its own scans, so the `npm publish`
// prepublishOnly hook (scan-org-leaks --strict + release guard, both
// fail-closed under CI) ran with NO blocklist and aborted every release.
describe('publish workflow keeps the org blocklist through npm publish', () => {
  const yml = readFileSync(join(repoRoot, '.github/workflows/publish.yml'), 'utf8');
  it('removes the blocklist only after `npm publish`, in an always() step', () => {
    const publishAt = yml.indexOf('npm publish --provenance');
    const removals = [...yml.matchAll(/rm -f scripts\/forbidden-names\.local\.json/g)].map((m) => m.index ?? -1);
    expect(publishAt).toBeGreaterThan(0);
    expect(removals.length).toBeGreaterThan(0);
    for (const at of removals) expect(at).toBeGreaterThan(publishAt);
    const cleanup = yml.slice(publishAt, removals[0]);
    expect(cleanup).toMatch(/if: always\(\)/);
  });
});

describe('release guard fails closed cleanly and checks every org pattern', () => {
  const guard = join(repoRoot, 'scripts/release-guard.mjs');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-guard-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // FAIL-BEFORE: the CI assertion threw at import — an uncaught exception
  // with a stack trace (exit 1) instead of scan-org-leaks' clean exit 2.
  it('a missing blocklist under CI exits 2 with a one-line FAILED message', () => {
    const r = spawnSync(process.execPath, [guard], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', SFI_ALLOW_NO_BLOCKLIST: '', SFI_FORBIDDEN_NAMES_PATH: join(dir, 'absent.json') },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Release privacy guard: FAILED — VACUOUS');
    expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
  });

  // FAIL-BEFORE: the guard read only `patterns`, so a blocklist that used
  // `scannerPatterns` (as the committed example does) made it check zero org
  // names while printing "loaded N scanner pattern(s)".
  it('checks scannerPatterns too, so the printed count is the count checked', () => {
    const file = join(dir, 'fn.json');
    writeFileSync(file, JSON.stringify({ scannerPatterns: ['\\bZzSyntheticOrg\\b'], patterns: [] }));
    const probe =
      `const g = await import(${JSON.stringify(pathToFileURL(guard).href)});` +
      `console.log(g.scanMessages([{ sha: 'abcdef0123', body: 'mentions ZzSyntheticOrg' }]).length);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, SFI_FORBIDDEN_NAMES_PATH: file },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });
});

// FAIL-BEFORE/PASS-AFTER: `pnpm publish --dry-run` exports npm_config_dry_run
// to the prepublishOnly hook, and check-pack-allowlist's own `npm pack`
// inherited it — so pack wrote no tarball and the check died with "found 0
// .tgz". The internal pack must ignore an inherited dry-run (any spelling)
// while the allowlist check itself stays byte-for-byte the same.
describe('check-pack-allowlist ignores an inherited npm dry-run', () => {
  const script = join(repoRoot, 'scripts/check-pack-allowlist.mjs');
  const dist = join(repoRoot, 'packages/cli/dist/index.js');

  it.each([
    ['npm_config_dry_run', 'true'],
    ['NPM_CONFIG_DRY_RUN', 'true'],
    ['npm_config_dry-run', 'true'],
  ])('passes with %s=%s in the environment', (key, value) => {
    if (!existsSync(dist)) {
      throw new Error('packages/cli/dist/index.js missing — run `pnpm -r build` before this test');
    }
    const r = spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, [key]: value },
    });
    expect(r.stderr).not.toMatch(/found 0/);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    expect(r.stderr).toMatch(/check-pack-allowlist: PASS/);
  }, 120_000);

  it('still strips only the dry-run key from the child env', async () => {
    const mod = (await import(pathToFileURL(join(repoRoot, 'scripts/lib/pack-child-env.mjs')).href)) as {
      packChildEnv: (env: Record<string, string | undefined>) => Record<string, string | undefined>;
    };
    const out = mod.packChildEnv({
      npm_config_dry_run: 'true',
      NPM_CONFIG_DRY_RUN: 'true',
      'npm_config_dry-run': '1',
      npm_config_registry: 'https://registry.example.invalid/',
      PATH: '/bin',
    });
    expect(out).toEqual({ npm_config_registry: 'https://registry.example.invalid/', PATH: '/bin' });
  });
});
