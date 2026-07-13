import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
