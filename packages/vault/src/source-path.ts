import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';

import { vaultPaths } from './layout.js';

/**
 * One file under `{vaultRoot}/source/` discovered by `collectVaultSourceFiles`.
 */
export interface VaultSourceFile {
  /** Absolute path suitable for `readFile`. */
  readonly absolutePath: string;
  /** Path relative to `vaultRoot`, posix separators (client-facing). */
  readonly vaultRelativePath: string;
}

export interface CollectVaultSourceFilesOptions {
  /** File name must end with one of these suffixes (e.g. `.cls`, `.flow-meta.xml`). */
  readonly suffixes: readonly string[];
}

/**
 * Resolve a graph node's `sourcePath` to an absolute filesystem path for reads.
 *
 * `sourcePath` is stored vault-relative after import (`source/main/default/...`).
 * When a base dir is supplied, join against `vaultRoot`; absolute paths pass through.
 *
 * @example
 *   resolveVaultSourcePath('/org-kb', 'source/main/default/classes/Foo.cls');
 *   // => '/org-kb/source/main/default/classes/Foo.cls'
 */
export const resolveVaultSourcePath = (
  vaultRoot: string,
  sourcePath: string,
): string => {
  if (isAbsolute(sourcePath)) {
    return sourcePath;
  }
  return join(vaultRoot, sourcePath);
};

const toVaultRelativePosix = (vaultRoot: string, fileAbsPath: string): string => {
  const rel = relative(vaultRoot, fileAbsPath);
  return sep === posix.sep ? rel : rel.split(sep).join(posix.sep);
};

const matchesAnySuffix = (name: string, suffixes: readonly string[]): boolean =>
  suffixes.some((suffix) => name.endsWith(suffix));

/**
 * Recursively enumerate files under `{vaultRoot}/source/` whose names end with
 * any of `opts.suffixes`. Supports both flat layouts (`source/classes/`) and
 * Salesforce DX (`source/main/default/classes/`).
 *
 * Returns paths sorted by vault-relative path for deterministic tool output.
 * A missing `source/` directory yields an empty array.
 */
export const collectVaultSourceFiles = async (
  vaultRoot: string,
  opts: CollectVaultSourceFilesOptions,
): Promise<readonly VaultSourceFile[]> => {
  const sourceRoot = vaultPaths(vaultRoot).source;
  const found: VaultSourceFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: readonly string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs);
      } else if (st.isFile() && matchesAnySuffix(name, opts.suffixes)) {
        found.push({
          absolutePath: abs,
          vaultRelativePath: toVaultRelativePosix(vaultRoot, abs),
        });
      }
    }
  };

  await walk(sourceRoot);
  return found.sort((a, b) =>
    a.vaultRelativePath < b.vaultRelativePath
      ? -1
      : a.vaultRelativePath > b.vaultRelativePath
        ? 1
        : 0,
  );
};
