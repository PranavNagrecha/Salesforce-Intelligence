/// <reference types="vitest/globals" />

import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectVaultSourceFiles,
  resolveVaultSourcePath,
} from '../src/source-path.js';

const makeVault = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-vault-src-'));

describe('resolveVaultSourcePath', () => {
  it('joins vault-relative paths under vaultRoot', () => {
    const vault = '/org-kb';
    expect(
      resolveVaultSourcePath(vault, 'source/main/default/classes/Foo.cls'),
    ).toBe(join(vault, 'source/main/default/classes/Foo.cls'));
  });

  it('returns absolute paths unchanged', () => {
    const abs = join(tmpdir(), 'absolute.cls');
    expect(resolveVaultSourcePath('/org-kb', abs)).toBe(abs);
  });
});

describe('collectVaultSourceFiles', () => {
  it('finds flat source/classes and source/triggers layouts', async () => {
    const vault = await makeVault();
    try {
      await mkdir(join(vault, 'source', 'classes'), { recursive: true });
      await mkdir(join(vault, 'source', 'triggers'), { recursive: true });
      await writeFile(join(vault, 'source', 'classes', 'Bar.cls'), 'Account a;\n');
      await writeFile(
        join(vault, 'source', 'triggers', 'AccountTrigger.trigger'),
        'trigger AccountTrigger on Account (before insert) {}\n',
      );
      const files = await collectVaultSourceFiles(vault, {
        suffixes: ['.cls', '.trigger'],
      });
      expect(files.map((f) => f.vaultRelativePath)).toEqual([
        'source/classes/Bar.cls',
        'source/triggers/AccountTrigger.trigger',
      ]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('finds DX-nested source/main/default/classes', async () => {
    const vault = await makeVault();
    try {
      const clsDir = join(vault, 'source', 'main', 'default', 'classes');
      await mkdir(clsDir, { recursive: true });
      await writeFile(join(clsDir, 'MRK_ClearLogsBatch.cls'), 'public class MRK_ClearLogsBatch {}\n');
      const files = await collectVaultSourceFiles(vault, { suffixes: ['.cls'] });
      expect(files).toHaveLength(1);
      expect(files[0]?.vaultRelativePath).toBe(
        'source/main/default/classes/MRK_ClearLogsBatch.cls',
      );
      expect(files[0]?.absolutePath).toBe(join(clsDir, 'MRK_ClearLogsBatch.cls'));
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('collects flow-meta.xml under nested flows directories', async () => {
    const vault = await makeVault();
    try {
      const flowsDir = join(vault, 'source', 'main', 'default', 'flows');
      await mkdir(flowsDir, { recursive: true });
      await writeFile(
        join(flowsDir, 'My_Flow.flow-meta.xml'),
        '<?xml version="1.0"?><Flow/>',
      );
      const files = await collectVaultSourceFiles(vault, {
        suffixes: ['.flow-meta.xml'],
      });
      expect(files).toHaveLength(1);
      expect(files[0]?.vaultRelativePath).toContain('My_Flow.flow-meta.xml');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('returns empty when source/ is missing', async () => {
    const vault = await makeVault();
    try {
      const files = await collectVaultSourceFiles(vault, { suffixes: ['.cls'] });
      expect(files).toEqual([]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe('collectVaultSourceFiles — duplicated source layouts', () => {
  /**
   * A vault that was refreshed once into a flat layout and again into the
   * Salesforce DX layout, with nothing deleting the first tree, carries every
   * file twice. Grep-based tools built on this helper then count every match
   * twice — including a class's own declaration line, which is how "is this
   * still used anywhere?" reported static evidence for a component whose only
   * match was itself.
   */
  it('returns ONE copy per logical file, preferring the DX layout', async () => {
    const vault = await makeVault();
    try {
      await mkdir(join(vault, 'source', 'classes'), { recursive: true });
      await mkdir(join(vault, 'source', 'main', 'default', 'classes'), {
        recursive: true,
      });
      await writeFile(
        join(vault, 'source', 'classes', 'DepotRouter.cls'),
        'public class DepotRouter { }\n',
      );
      await writeFile(
        join(vault, 'source', 'main', 'default', 'classes', 'DepotRouter.cls'),
        'public class DepotRouter { }\n',
      );
      const files = await collectVaultSourceFiles(vault, { suffixes: ['.cls'] });
      expect(files.map((f) => f.vaultRelativePath)).toEqual([
        'source/main/default/classes/DepotRouter.cls',
      ]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  /**
   * `logicalSourceKey` located the DX prefix with a bare `indexOf('main/default/')`
   * while `isDxCanonicalPath` anchored it to a path segment — the two the file's
   * own comment says MUST agree. Any package directory whose name ENDS in `main`
   * (`force-app-main/default/…` is an ordinary DX spelling) therefore folded into
   * the same logical key as an unrelated flat file, and the deduplicator DROPPED
   * one of two genuinely different files from the corpus without a word.
   */
  it('does not fold a package dir merely ENDING in "main" into the DX prefix', async () => {
    const vault = await makeVault();
    try {
      const flat = join(vault, 'source', 'classes');
      const pkg = join(vault, 'source', 'force-app-main', 'default', 'classes');
      await mkdir(flat, { recursive: true });
      await mkdir(pkg, { recursive: true });
      await writeFile(join(flat, 'Foo.cls'), 'public class Foo { /* flat */ }\n');
      await writeFile(join(pkg, 'Foo.cls'), 'public class Foo { /* pkg */ }\n');
      const files = await collectVaultSourceFiles(vault, { suffixes: ['.cls'] });
      expect(files.map((f) => f.vaultRelativePath)).toEqual([
        'source/classes/Foo.cls',
        'source/force-app-main/default/classes/Foo.cls',
      ]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('keeps genuinely different files in the same layout', async () => {
    const vault = await makeVault();
    try {
      await mkdir(join(vault, 'source', 'main', 'default', 'classes'), {
        recursive: true,
      });
      await writeFile(
        join(vault, 'source', 'main', 'default', 'classes', 'DepotRouter.cls'),
        'public class DepotRouter { }\n',
      );
      await writeFile(
        join(vault, 'source', 'main', 'default', 'classes', 'DepotAudit.cls'),
        'public class DepotAudit { }\n',
      );
      const files = await collectVaultSourceFiles(vault, { suffixes: ['.cls'] });
      expect(files.map((f) => f.vaultRelativePath)).toEqual([
        'source/main/default/classes/DepotAudit.cls',
        'source/main/default/classes/DepotRouter.cls',
      ]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

/**
 * A directory under `source/` the process cannot read is a BLIND SPOT, not an
 * empty one. Swallowing the `readdir`/`stat` failure hands every grep-based
 * caller a smaller-but-clean file list, so `search_apex_source` certifies
 * "checked-empty / proven-none" for a query whose only true hit was never
 * opened. These cases pin the disclosure that makes that impossible.
 */
describe('collectVaultSourceFiles — unreadable parts of the tree', () => {
  /**
   * chmod cannot deny reads to root. Detect that once so the suite reports the
   * truth (skipped) instead of a green tick it did not earn.
   */
  const denialWorks = async (dir: string): Promise<boolean> => {
    await chmod(dir, 0o000);
    try {
      await readdir(dir);
      await chmod(dir, 0o700);
      return false;
    } catch {
      return true;
    }
  };

  it('DISCLOSES an unreadable directory instead of dropping it from the corpus in silence', async () => {
    const vault = await makeVault();
    const locked = join(vault, 'source', 'classes');
    try {
      await mkdir(locked, { recursive: true });
      await mkdir(join(vault, 'source', 'triggers'), { recursive: true });
      await writeFile(join(locked, 'Hit.cls'), 'SELECT Id FROM Account\n');
      await writeFile(
        join(vault, 'source', 'triggers', 'T.trigger'),
        'trigger T on Account (before insert) {}\n',
      );
      if (!(await denialWorks(locked))) return; // running as root: chmod denies nothing

      const unreadable: string[] = [];
      const files = await collectVaultSourceFiles(vault, {
        suffixes: ['.cls', '.trigger'],
        onUnreadablePath: (p) => unreadable.push(p),
      });

      // The readable half still comes back...
      expect(files.map((f) => f.vaultRelativePath)).toEqual([
        'source/triggers/T.trigger',
      ]);
      // ...but the half that was never opened is NAMED, so no caller can call
      // this corpus complete.
      expect(unreadable).toEqual(['source/classes']);
    } finally {
      await chmod(locked, 0o700).catch(() => undefined);
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('DISCLOSES an entry it cannot stat (dangling symlink) rather than skipping it', async () => {
    const vault = await makeVault();
    try {
      const dir = join(vault, 'source', 'classes');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'Real.cls'), 'public class Real {}\n');
      await symlink(join(vault, 'gone', 'Ghost.cls'), join(dir, 'Ghost.cls'));

      const unreadable: string[] = [];
      const files = await collectVaultSourceFiles(vault, {
        suffixes: ['.cls'],
        onUnreadablePath: (p) => unreadable.push(p),
      });

      expect(files.map((f) => f.vaultRelativePath)).toEqual([
        'source/classes/Real.cls',
      ]);
      expect(unreadable).toEqual(['source/classes/Ghost.cls']);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('reports an unreadable `source/` ROOT — the corpus is a blind spot, not absent', async () => {
    const vault = await makeVault();
    const root = join(vault, 'source');
    try {
      await mkdir(join(root, 'classes'), { recursive: true });
      await writeFile(join(root, 'classes', 'Hit.cls'), 'public class Hit {}\n');
      if (!(await denialWorks(root))) return;

      const unreadable: string[] = [];
      const files = await collectVaultSourceFiles(vault, {
        suffixes: ['.cls'],
        onUnreadablePath: (p) => unreadable.push(p),
      });
      expect(files).toEqual([]);
      expect(unreadable).toEqual(['source']);
    } finally {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('does NOT report a MISSING source/ as unreadable — absent and blind are different answers', async () => {
    const vault = await makeVault();
    try {
      const unreadable: string[] = [];
      const files = await collectVaultSourceFiles(vault, {
        suffixes: ['.cls'],
        onUnreadablePath: (p) => unreadable.push(p),
      });
      expect(files).toEqual([]);
      expect(unreadable).toEqual([]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('a fully readable tree discloses NOTHING — the signal is earned, not unconditional', async () => {
    const vault = await makeVault();
    try {
      await mkdir(join(vault, 'source', 'classes'), { recursive: true });
      await writeFile(
        join(vault, 'source', 'classes', 'Clean.cls'),
        'public class Clean {}\n',
      );
      const unreadable: string[] = [];
      const files = await collectVaultSourceFiles(vault, {
        suffixes: ['.cls'],
        onUnreadablePath: (p) => unreadable.push(p),
      });
      expect(files).toHaveLength(1);
      expect(unreadable).toEqual([]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
