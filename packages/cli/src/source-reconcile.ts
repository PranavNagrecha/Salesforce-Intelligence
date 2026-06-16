import { cp, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { ComponentType } from '@sf-intelligence/contracts';

import { componentTypeFromSourcePath } from './refresh-pipeline.js';

/** Salesforce DX bundle parent directories (LWC, Aura). */
const BUNDLE_PARENT_DIRS = new Set<string>(['lwc', 'aura']);

/** Sidecar suffixes covered by a sibling primary extractor (mirrors refresh-pipeline). */
const KNOWN_SIDECAR_SUFFIXES: readonly string[] = [
  '.cls-meta.xml',
  '.trigger-meta.xml',
  '.page-meta.xml',
  '.component-meta.xml',
];

const isKnownSidecar = (fileName: string): boolean =>
  KNOWN_SIDECAR_SUFFIXES.some((suffix) => fileName.endsWith(suffix));

/** Map a sidecar path to the primary source path the extractor reads. */
const primaryRelPathForSidecar = (relPath: string, fileName: string): string | null => {
  if (fileName.endsWith('.cls-meta.xml')) return relPath.replace(/\.cls-meta\.xml$/, '.cls');
  if (fileName.endsWith('.trigger-meta.xml')) {
    return relPath.replace(/\.trigger-meta\.xml$/, '.trigger');
  }
  if (fileName.endsWith('.page-meta.xml')) return relPath.replace(/\.page-meta\.xml$/, '.page');
  if (fileName.endsWith('.component-meta.xml')) {
    return relPath.replace(/\.component-meta\.xml$/, '.component');
  }
  return null;
};

interface SourceEntry {
  readonly absPath: string;
  readonly relPath: string;
  readonly type: ComponentType;
  readonly isDirectory: boolean;
}

const walkSourceEntries = async (
  sourceRoot: string,
  found: SourceEntry[],
): Promise<void> => {
  const walkDir = async (currentDir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const isBundleParent = BUNDLE_PARENT_DIRS.has(basename(currentDir));
    for (const entry of sorted) {
      const abs = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (isBundleParent) {
          const type = componentTypeFromSourcePath(sourceRoot, abs, true);
          if (type !== null) {
            found.push({
              absPath: abs,
              relPath: relative(sourceRoot, abs),
              type,
              isDirectory: true,
            });
          }
        } else {
          await walkDir(abs);
        }
      } else if (entry.isFile()) {
        const relPath = relative(sourceRoot, abs);
        const fileName = entry.name;
        let type = componentTypeFromSourcePath(sourceRoot, abs, false);
        if (type === null && isKnownSidecar(fileName)) {
          const primaryRel = primaryRelPathForSidecar(relPath, fileName);
          if (primaryRel !== null) {
            type = componentTypeFromSourcePath(
              sourceRoot,
              join(sourceRoot, primaryRel),
              false,
            );
          }
        }
        if (type !== null) {
          found.push({
            absPath: abs,
            relPath,
            type,
            isDirectory: false,
          });
        }
      }
    }
  };
  await walkDir(sourceRoot);
};

const authoritativePathSet = async (authoritativeRoot: string): Promise<Set<string>> => {
  const entries: SourceEntry[] = [];
  await walkSourceEntries(authoritativeRoot, entries);
  return new Set(entries.map((entry) => entry.relPath));
};

export interface SourceReconcileResult {
  readonly deletedPaths: readonly string[];
  readonly deletedCount: number;
}

/**
 * Drop `sourceDir` files for `typesToReconcile` that are absent from the
 * authoritative retrieve output. Only touches paths the dispatcher recognises —
 * unknown retrieve noise is left alone.
 */
export const reconcileSourceDeletions = async (
  sourceDir: string,
  authoritativeDir: string,
  typesToReconcile: ReadonlySet<ComponentType>,
): Promise<SourceReconcileResult> => {
  if (typesToReconcile.size === 0) {
    return { deletedPaths: [], deletedCount: 0 };
  }

  const authoritative = await authoritativePathSet(authoritativeDir);
  const sourceEntries: SourceEntry[] = [];
  await walkSourceEntries(sourceDir, sourceEntries);

  const deletedPaths: string[] = [];
  const deletedBundleDirs = new Set<string>();

  for (const entry of sourceEntries) {
    if (!typesToReconcile.has(entry.type)) continue;
    const fileName = basename(entry.absPath);
    const primaryRel = primaryRelPathForSidecar(entry.relPath, fileName);
    const authoritativeKey = primaryRel ?? entry.relPath;
    if (authoritative.has(authoritativeKey) || authoritative.has(entry.relPath)) continue;

    if (entry.isDirectory) {
      deletedBundleDirs.add(entry.absPath);
      deletedPaths.push(entry.relPath);
      continue;
    }

    // Bundle child files are not walked; skip if parent bundle is already gone.
    const parentBundle = [...deletedBundleDirs].find((dir) => entry.absPath.startsWith(`${dir}${sep}`));
    if (parentBundle !== undefined) continue;

    await rm(entry.absPath, { force: true });
    deletedPaths.push(entry.relPath);
  }

  for (const bundleDir of deletedBundleDirs) {
    await rm(bundleDir, { recursive: true, force: true });
  }

  return { deletedPaths, deletedCount: deletedPaths.length };
};

/**
 * Merge an authoritative retrieve directory into the live source tree after
 * stale deletions are reconciled.
 */
export const syncAuthoritativeRetrieveIntoSource = async (
  sourceDir: string,
  authoritativeDir: string,
): Promise<void> => {
  try {
    await stat(authoritativeDir);
  } catch {
    return;
  }
  await cp(authoritativeDir, sourceDir, { recursive: true, force: true });
};
