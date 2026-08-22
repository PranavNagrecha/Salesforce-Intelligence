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
 * True when `path` sits inside a Salesforce DX package directory
 * (`…/main/default/…`). Mirrors `isDxCanonicalPath` in
 * `@sf-intelligence/graph`'s duplicate-source detector — restated here rather
 * than imported because the vault package must not depend on the graph package.
 * The two MUST agree: the graph picks the DX copy for the node, and the grep
 * tools must read the SAME copy or a component's structured answer and its
 * text-match evidence would come from different retrievals.
 */
const isDxCanonicalPath = (path: string): boolean =>
  /(?:^|\/)main\/default\//.test(path);

/**
 * Strip the layout root from a vault-relative source path, leaving the logical
 * component tail. `source/profiles/X.profile-meta.xml` and
 * `source/main/default/profiles/X.profile-meta.xml` both reduce to
 * `profiles/X.profile-meta.xml`, which is what makes them recognisable as two
 * copies of one component.
 *
 * Only the two layouts the product itself produces are folded: the DX
 * `…/main/default/` prefix and a bare `source/` prefix. Anything else is left
 * alone, so an unusual tree can never have two genuinely different files
 * collapsed into one.
 */
const logicalSourceKey = (vaultRelativePath: string): string => {
  const dx = vaultRelativePath.indexOf('main/default/');
  if (dx !== -1) return vaultRelativePath.slice(dx + 'main/default/'.length);
  return vaultRelativePath.startsWith('source/')
    ? vaultRelativePath.slice('source/'.length)
    : vaultRelativePath;
};

/**
 * Collapse two copies of the same logical file to ONE, preferring the
 * Salesforce DX copy.
 *
 * A vault whose `source/` tree holds a legacy flat layout beside the DX layout
 * carries every file twice. Every grep-based tool built on this helper then
 * counts every match twice — including a class's own declaration line, which is
 * how "is this still used anywhere?" reported static evidence for a component
 * that only ever matched itself. Deduplicating here fixes all of those callers
 * at once, and uses the SAME precedence the graph importer uses so structured
 * and text-match answers describe the same copy.
 *
 * A vault with one layout has no collisions and is returned unchanged.
 */
const dedupeDuplicateLayouts = (
  files: readonly VaultSourceFile[],
): readonly VaultSourceFile[] => {
  const byLogicalKey = new Map<string, VaultSourceFile>();
  let collisions = 0;
  for (const file of files) {
    const key = logicalSourceKey(file.vaultRelativePath);
    const existing = byLogicalKey.get(key);
    if (existing === undefined) {
      byLogicalKey.set(key, file);
      continue;
    }
    collisions += 1;
    // DX wins; where neither (or both) is DX-canonical the lexicographically
    // first path wins, purely so repeated calls return the same file.
    const winner = isDxCanonicalPath(file.vaultRelativePath)
      ? file
      : isDxCanonicalPath(existing.vaultRelativePath)
        ? existing
        : file.vaultRelativePath < existing.vaultRelativePath
          ? file
          : existing;
    byLogicalKey.set(key, winner);
  }
  if (collisions === 0) return files;
  return [...byLogicalKey.values()].sort((a, b) =>
    a.vaultRelativePath < b.vaultRelativePath
      ? -1
      : a.vaultRelativePath > b.vaultRelativePath
        ? 1
        : 0,
  );
};

/**
 * Recursively enumerate files under `{vaultRoot}/source/` whose names end with
 * any of `opts.suffixes`. Supports both flat layouts (`source/classes/`) and
 * Salesforce DX (`source/main/default/classes/`).
 *
 * Returns paths sorted by vault-relative path for deterministic tool output.
 * A missing `source/` directory yields an empty array.
 *
 * DUPLICATE LAYOUTS: when a vault holds BOTH layouts for the same logical file
 * (a stale flat tree left beside the DX tree), only ONE copy is returned — the
 * DX one — so grep-based evidence is not double-counted. See
 * `dedupeDuplicateLayouts`.
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
  return dedupeDuplicateLayouts(
    found.sort((a, b) =>
      a.vaultRelativePath < b.vaultRelativePath
        ? -1
        : a.vaultRelativePath > b.vaultRelativePath
          ? 1
          : 0,
    ),
  );
};
