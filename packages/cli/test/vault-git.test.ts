/// <reference types="vitest/globals" />

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeSourceTreeHash, vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';
import {
  autoCommitVaultGit,
  enableVaultGit,
  runGit,
  vaultGitEnabled,
  VAULT_GITIGNORE,
} from '../src/commands/vault-git.js';

/**
 * P13-GITHIST-enable — vault git history: enable (init + .gitignore +
 * initial commit), refresh auto-commit on sourceTreeHashChanged, the
 * NAMED hash-stability test (.git ignored by the source-tree walk), and
 * the zero-change guarantee for non-enabled vaults.
 */

let cwd: string;
let vaultRoot: string;

const seedVault = async (): Promise<void> => {
  vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  const dir = join(paths.source, 'main', 'default', 'classes');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'Alpha.cls'), 'public class Alpha {}', 'utf8');
  await writeFile(
    join(dir, 'Alpha.cls-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
    'utf8',
  );
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test',
      vaultRoot,
      version: '0.1.0',
      snapshotOnRefresh: false,
      createdAt: '2026-06-04T00:00:00.000Z',
    }),
    'utf8',
  );
};

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'sfi-vault-git-'));
  await seedVault();
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('enableVaultGit', () => {
  it('inits the repo, writes the generated .gitignore, makes the initial commit; idempotent', async () => {
    const r = await enableVaultGit(vaultRoot);
    expect(r.ok).toBe(true);
    expect(vaultGitEnabled(vaultRoot)).toBe(true);
    expect(existsSync(join(vaultRoot, '.gitignore'))).toBe(true);
    expect(VAULT_GITIGNORE).toContain('graph/');
    expect(VAULT_GITIGNORE).toContain('snapshots/');
    expect(VAULT_GITIGNORE).toContain('extract-cache');
    const log = runGit(vaultRoot, ['log', '--oneline']);
    expect(log.ok).toBe(true);
    expect(log.output).toContain('initial vault history snapshot');

    const again = await enableVaultGit(vaultRoot);
    expect(again.ok).toBe(true);
    expect(again.message).toContain('already enabled');
  });
});

describe('NAMED TEST: sourceTreeHash walk ignores .git', () => {
  it('a .git directory (even inside source/) never changes the source-tree hash', async () => {
    const paths = vaultPaths(vaultRoot);
    const before = await computeSourceTreeHash(paths.source);
    if (!before.ok) throw new Error(before.error.message);
    // adversarial: junk .git INSIDE source/ (enable puts it beside, but the
    // walk must be robust to either)
    await mkdir(join(paths.source, '.git', 'objects'), { recursive: true });
    await writeFile(join(paths.source, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
    const after = await computeSourceTreeHash(paths.source);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value).toBe(before.value);
  });
});

describe('refresh auto-commit (P13-GITHIST-enable)', () => {
  it('commits on sourceTreeHashChanged with a delta message; no commit when unchanged; resilient', async () => {
    await enableVaultGit(vaultRoot);
    const r1 = await runRefresh({ cwd, noPull: true });
    expect(r1.status).toBe('success');
    const log1 = runGit(vaultRoot, ['log', '--oneline']);
    const commits1 = log1.output.split('\n').filter((l) => l.trim().length > 0);
    expect(commits1.length).toBe(2); // initial + first refresh (hash changed from none)
    expect(commits1[0]).toContain('refresh');

    // unchanged source → no new commit
    const r2 = await runRefresh({ cwd, noPull: true });
    expect(r2.status).toBe('success');
    const log2 = runGit(vaultRoot, ['log', '--oneline']);
    expect(log2.output.split('\n').filter((l) => l.trim().length > 0).length).toBe(2);

    // changed source → exactly one more commit, naming the delta
    const dir = join(vaultPaths(vaultRoot).source, 'main', 'default', 'classes');
    await writeFile(join(dir, 'Beta.cls'), 'public class Beta {}', 'utf8');
    await writeFile(
      join(dir, 'Beta.cls-meta.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
      'utf8',
    );
    const r3 = await runRefresh({ cwd, noPull: true });
    expect(r3.status).toBe('success');
    const log3 = runGit(vaultRoot, ['log', '--oneline']);
    const commits3 = log3.output.split('\n').filter((l) => l.trim().length > 0);
    expect(commits3.length).toBe(3);
    expect(commits3[0]).toMatch(/ApexClass/);
  });

  it('a NON-enabled vault sees zero git artifacts and an unchanged refresh', async () => {
    const r = await runRefresh({ cwd, noPull: true });
    expect(r.status).toBe('success');
    expect(existsSync(join(vaultRoot, '.git'))).toBe(false);
    expect(existsSync(join(vaultRoot, '.gitignore'))).toBe(false);
  });

  it('autoCommitVaultGit is best-effort: not enabled → no-op detail', () => {
    const out = autoCommitVaultGit(vaultRoot, 'msg');
    expect(out.committed).toBe(false);
    expect(out.detail).toBe('not enabled');
  });
});
