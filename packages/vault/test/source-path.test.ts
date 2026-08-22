/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
