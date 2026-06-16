/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInit } from '../../src/commands/init.js';

const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-init-'));

describe('runInit', () => {
  it('creates the vault directory tree, config, version.txt, and .gitignore on happy path', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await runInit({
        cwd,
        targetOrg: 'foo',
        vaultRoot: 'org-kb',
        force: false,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const root = join(cwd, 'org-kb');
      // All five vault directories exist and are directories.
      for (const sub of ['', 'source', 'components', 'graph', 'meta']) {
        const entry = sub === '' ? root : join(root, sub);
        const stats = await stat(entry);
        expect(stats.isDirectory()).toBe(true);
      }

      // config.json structure.
      const config = JSON.parse(await readFile(join(root, 'meta', 'config.json'), 'utf8')) as {
        targetOrg: string;
        vaultRoot: string;
        version: string;
        createdAt: string;
      };
      expect(config.targetOrg).toBe('foo');
      expect(config.vaultRoot).toBe(root);
      expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof config.createdAt).toBe('string');
      // ISO-8601 timestamp ends with `Z`.
      expect(config.createdAt.endsWith('Z')).toBe(true);

      // version.txt content.
      const versionTxt = await readFile(join(root, 'meta', 'version.txt'), 'utf8');
      expect(versionTxt).toMatch(/^\d+\.\d+\.\d+\n$/);
      expect(versionTxt).toBe(`${config.version}\n`);

      // .gitignore created with the two entries.
      const gitignore = await readFile(join(cwd, '.gitignore'), 'utf8');
      expect(gitignore).toContain('org-kb/source/');
      expect(gitignore).toContain('org-kb/graph/');
      expect(result.value.gitignoreUpdated).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('scaffolds a usable DX project (sfdx-project.json + package dir) so refresh works out of the box', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await runInit({ cwd, targetOrg: 'foo', vaultRoot: 'org-kb', force: false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.dxProjectScaffolded).toBe(true);
      const project = JSON.parse(await readFile(join(cwd, 'sfdx-project.json'), 'utf8')) as {
        packageDirectories: { path: string; default: boolean }[];
        sourceApiVersion: string;
      };
      expect(project.packageDirectories[0]?.path).toBe('force-app');
      expect(typeof project.sourceApiVersion).toBe('string');
      // The default package directory must exist on disk; `sf project retrieve` refuses otherwise.
      expect((await stat(join(cwd, 'force-app'))).isDirectory()).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('respects an existing sfdx-project.json instead of overwriting it', async () => {
    const cwd = await makeTempCwd();
    try {
      const existing = JSON.stringify({ packageDirectories: [{ path: 'src', default: true }] }, null, 2);
      await writeFile(join(cwd, 'sfdx-project.json'), existing, 'utf8');

      const result = await runInit({ cwd, targetOrg: 'foo', vaultRoot: 'org-kb', force: false });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.dxProjectScaffolded).toBe(false);
      const after = await readFile(join(cwd, 'sfdx-project.json'), 'utf8');
      expect(after).toBe(existing);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing vault when force is false', async () => {
    const cwd = await makeTempCwd();
    try {
      // Pre-create org-kb/.
      await mkdir(join(cwd, 'org-kb'), { recursive: true });

      const result = await runInit({
        cwd,
        targetOrg: 'foo',
        vaultRoot: 'org-kb',
        force: false,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('already-exists');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('overwrites an existing vault when force is true', async () => {
    const cwd = await makeTempCwd();
    try {
      // Pre-create org-kb/ with an old config.
      await mkdir(join(cwd, 'org-kb', 'meta'), { recursive: true });
      await writeFile(
        join(cwd, 'org-kb', 'meta', 'config.json'),
        JSON.stringify({ targetOrg: 'old', vaultRoot: 'x', version: '0.0.1', createdAt: 'old' }),
        'utf8',
      );

      const result = await runInit({
        cwd,
        targetOrg: 'new',
        vaultRoot: 'org-kb',
        force: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const config = JSON.parse(
        await readFile(join(cwd, 'org-kb', 'meta', 'config.json'), 'utf8'),
      ) as { targetOrg: string };
      expect(config.targetOrg).toBe('new');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not duplicate a .gitignore entry that is already present', async () => {
    const cwd = await makeTempCwd();
    try {
      // Pre-populate .gitignore with one of the entries plus unrelated lines.
      await writeFile(
        join(cwd, '.gitignore'),
        ['node_modules/', 'org-kb/source/', 'dist/'].join('\n') + '\n',
        'utf8',
      );

      const result = await runInit({
        cwd,
        targetOrg: 'foo',
        vaultRoot: 'org-kb',
        force: false,
      });

      expect(result.ok).toBe(true);

      const gitignore = await readFile(join(cwd, '.gitignore'), 'utf8');
      const occurrencesOfSource = gitignore.split('org-kb/source/').length - 1;
      const occurrencesOfGraph = gitignore.split('org-kb/graph/').length - 1;
      expect(occurrencesOfSource).toBe(1);
      expect(occurrencesOfGraph).toBe(1);
      // Pre-existing unrelated lines preserved.
      expect(gitignore).toContain('node_modules/');
      expect(gitignore).toContain('dist/');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('creates .gitignore with the entries when no .gitignore exists', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await runInit({
        cwd,
        targetOrg: 'foo',
        vaultRoot: 'org-kb',
        force: false,
      });

      expect(result.ok).toBe(true);

      const gitignore = await readFile(join(cwd, '.gitignore'), 'utf8');
      expect(gitignore.split('\n')).toContain('org-kb/source/');
      expect(gitignore.split('\n')).toContain('org-kb/graph/');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
