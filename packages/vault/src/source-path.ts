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
  /**
   * Called once per vault-relative path the walk could NOT read — a directory
   * whose `readdir` failed, or an entry whose `stat` failed so it could be
   * neither descended into nor classified as a file.
   *
   * Without this the walk swallows both failures and returns a smaller-but-
   * clean file list, which every grep-based caller then certifies as a complete
   * corpus: one unreadable `classes/` directory turns "the only file holding
   * your match was never opened" into "checked, no matches". Callers MUST fold
   * these paths into whatever partially-read disclosure they already carry.
   *
   * Paths arrive AFTER the walk, sorted and deduplicated, so the disclosure is
   * deterministic regardless of directory-entry order. A fully readable tree
   * never calls it, and a `source/` root that simply does not exist is NOT
   * reported — absent and unreadable are different answers.
   */
  readonly onUnreadablePath?: (vaultRelativePath: string) => void;
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
 * The Salesforce DX package root, matched only on a whole path SEGMENT. Both
 * `isDxCanonicalPath` and `logicalSourceKey` are derived from this one pattern:
 * they previously spelled the same idea twice — an anchored regex here and a
 * bare `indexOf('main/default/')` there — and disagreed for every package
 * directory whose name merely ENDS in `main` (`force-app-main/default/…` is an
 * ordinary DX spelling). `logicalSourceKey` folded such a path onto an
 * unrelated flat file's key while `isDxCanonicalPath` denied it was DX, so the
 * deduplicator dropped one of two genuinely different files from the corpus.
 * No `g` flag: these call sites must not share a `lastIndex`.
 */
const DX_PACKAGE_ROOT = /(?:^|\/)main\/default\//;

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
  DX_PACKAGE_ROOT.test(path);

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
  const dx = DX_PACKAGE_ROOT.exec(vaultRelativePath);
  if (dx !== null) return vaultRelativePath.slice(dx.index + dx[0].length);
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

const byVaultRelativePath = (a: VaultSourceFile, b: VaultSourceFile): number =>
  a.vaultRelativePath < b.vaultRelativePath
    ? -1
    : a.vaultRelativePath > b.vaultRelativePath
      ? 1
      : 0;

const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : undefined
    : undefined;

/**
 * A `source/` root that is simply not there is a DIFFERENT answer from one the
 * process cannot read: the first means the retrieve wrote no source tree (the
 * callers' `corpus-absent` case), the second means the tree exists and we are
 * blind to it. Only the root gets this exemption — a nested directory that
 * vanishes mid-walk still leaves a hole in the corpus, so it is reported.
 */
const isRootSimplyAbsent = (err: unknown): boolean => {
  const code = errorCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
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
 *
 * UNREADABLE PARTS: a directory whose `readdir` fails, or an entry whose `stat`
 * fails, cannot be enumerated — it is a hole in the corpus, never an empty one.
 * Those paths are reported through `opts.onUnreadablePath` so callers can
 * degrade their answer instead of certifying a corpus they never fully read.
 */
export const collectVaultSourceFiles = async (
  vaultRoot: string,
  opts: CollectVaultSourceFilesOptions,
): Promise<readonly VaultSourceFile[]> => {
  const sourceRoot = vaultPaths(vaultRoot).source;
  const found: VaultSourceFile[] = [];
  const unreadable = new Set<string>();

  const walk = async (dir: string, isRoot: boolean): Promise<void> => {
    let entries: readonly string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      // The root's absence is disclosed by the caller as an ABSENT corpus; any
      // other failure means the tree is there and we could not read it.
      if (!(isRoot && isRootSimplyAbsent(err))) {
        unreadable.add(toVaultRelativePosix(vaultRoot, dir));
      }
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = await stat(abs);
      } catch {
        // Listed by its parent but unclassifiable — it could be a directory of
        // matching files. Skipping it silently would shrink the corpus without
        // saying so.
        unreadable.add(toVaultRelativePosix(vaultRoot, abs));
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs, false);
      } else if (st.isFile() && matchesAnySuffix(name, opts.suffixes)) {
        found.push({
          absolutePath: abs,
          vaultRelativePath: toVaultRelativePosix(vaultRoot, abs),
        });
      }
    }
  };

  await walk(sourceRoot, true);

  if (opts.onUnreadablePath !== undefined && unreadable.size > 0) {
    for (const path of [...unreadable].sort()) opts.onUnreadablePath(path);
  }

  return dedupeDuplicateLayouts(found.sort(byVaultRelativePath));
};
