import { cp, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { ComponentType } from '@sf-intelligence/contracts';
import { splitPathSegments } from '@sf-intelligence/core';

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

/**
 * Synthetic root used to re-run the dispatcher over a candidate path TAIL.
 * `componentTypeFromSourcePath` is a pure path function, so probing costs
 * nothing but string work — no file has to exist at this path.
 */
const DISPATCH_PROBE_ROOT = join(sep, '__sfi-reconcile-dispatch-probe__');

/**
 * Length (in trailing segments) of the shortest suffix of `segments` that still
 * resolves to a ComponentType, or `null` if no suffix does.
 */
const dispatchTailLength = (
  segments: readonly string[],
  isDirectory: boolean,
): number | null => {
  for (let length = 1; length <= segments.length; length += 1) {
    const tail = segments.slice(segments.length - length);
    const type = componentTypeFromSourcePath(
      DISPATCH_PROBE_ROOT,
      join(DISPATCH_PROBE_ROOT, ...tail),
      isDirectory,
    );
    if (type !== null) return length;
  }
  return null;
};

/**
 * Fallback wrapper strip for the (unexpected) case where no suffix dispatches:
 * drop a leading `main/default` pair, optionally preceded by one package-dir
 * segment (`force-app/main/default/...`). Bounded to the head so a component
 * that legitimately contains those names deeper in its path is left alone.
 */
const strippedDxWrapper = (segments: readonly string[]): readonly string[] => {
  for (let i = 0; i <= 1 && i + 1 < segments.length; i += 1) {
    if (segments[i] === 'main' && segments[i + 1] === 'default') return segments.slice(i + 2);
  }
  return segments;
};

/**
 * Layout-agnostic comparison key for a tree-relative path.
 *
 * WHY normalisation and not prefix matching: the vault's `source/` tree and the
 * authoritative retrieve output are written by two different `sf project
 * retrieve` invocations whose layouts have already diverged once. An older vault
 * is flat (`objects/Account/…`), while a retrieve into a throwaway SFDX project
 * lands at `<pkgDir>/main/default/objects/Account/…`. Comparing raw relative
 * paths made every pre-existing file look "deleted in the org", and the
 * reconcile rm'd the whole tree (8,641 -> 7,667 graph nodes in one refresh).
 * Special-casing the one prefix visible today (`main/default/`) would leave the
 * NEXT layout change free to do exactly the same thing silently, so the key is
 * DERIVED from the dispatcher instead: it is the shortest trailing run of
 * segments that still resolves to a ComponentType. Every leading segment that
 * plays no part in identifying the component — `force-app`, `main`, `default`,
 * or whatever wrapper a future retrieve introduces — falls off by construction,
 * because the dispatcher never looks at it. Keys use `/` so they compare equal
 * across platforms.
 */
const comparisonKey = (relPath: string, isDirectory: boolean): string => {
  const segments = splitPathSegments(relPath);
  const fileName = segments[segments.length - 1] ?? relPath;
  // A sidecar (`Foo.cls-meta.xml`) never dispatches on its own, so probe with
  // the primary basename; both live in the same directory, so the tail length
  // carries over unchanged.
  const primaryRel = primaryRelPathForSidecar(relPath, fileName);
  const probeSegments =
    primaryRel === null ? segments : splitPathSegments(primaryRel);
  const length = dispatchTailLength(probeSegments, isDirectory);
  const tail =
    length === null ? strippedDxWrapper(segments) : segments.slice(segments.length - length);
  return tail.join('/');
};

interface AuthoritativeIndex {
  readonly keys: ReadonlySet<string>;
  /** Entries whose type is in reconcile scope — the "the org answered" signal. */
  readonly inScopeCount: number;
}

const authoritativeIndex = async (
  authoritativeRoot: string,
  typesToReconcile: ReadonlySet<ComponentType>,
): Promise<AuthoritativeIndex> => {
  const entries: SourceEntry[] = [];
  await walkSourceEntries(authoritativeRoot, entries);
  const keys = new Set<string>();
  let inScopeCount = 0;
  for (const entry of entries) {
    keys.add(comparisonKey(entry.relPath, entry.isDirectory));
    if (typesToReconcile.has(entry.type)) inScopeCount += 1;
  }
  return { keys, inScopeCount };
};

/**
 * Share of the in-scope vault files a single reconcile may delete before it
 * refuses. A reconcile that concludes more than half of every reconciled type
 * vanished from the org at once is far more likely to be misreading the tree
 * layout than reporting a real org change: layout mismatch deletes ~100% of the
 * considered set, whereas real refresh-to-refresh churn is a handful of
 * components. Refusing costs a stale vault entry the caller can surface and
 * re-run; not refusing costs the org's metadata history.
 */
export const RECONCILE_MAX_DELETE_FRACTION = 0.5;

/**
 * Below this many in-scope files, the fraction rail is not applied: on a tiny
 * considered set (a vault holding two classes, one of which was really deleted)
 * a majority deletion is ordinary, and tripping there would break genuine
 * reconciliation for no safety gain. Wholesale mismatch on a small tree is still
 * caught by the "everything deleted while the retrieve returned components of
 * these very types" rail, which is size-independent.
 */
export const RECONCILE_GUARD_MIN_CONSIDERED = 20;

export interface SourceReconcileResult {
  readonly deletedPaths: readonly string[];
  readonly deletedCount: number;
  /** In-scope vault entries examined (the denominator of the safety rail). */
  readonly consideredCount: number;
  /** True when the safety rail refused to delete anything at all. */
  readonly refused: boolean;
  /** Operator-facing explanation; present only when `refused` is true. */
  readonly refusalReason?: string;
}

/**
 * Decide whether a proposed deletion set is too big to be believable, returning
 * the operator-facing reason to refuse, or `null` to proceed.
 *
 * Two shapes are rejected, because both are the fingerprint of comparing two
 * trees written in different layouts rather than of an org that lost metadata:
 *
 *   1. Total wipe with a non-empty answer — the retrieve DID return components
 *      of the reconciled types, yet not one of them matched anything already in
 *      the vault. Size-independent; this is the exact shape of the incident.
 *   2. Majority wipe on a large enough set — more than
 *      {@link RECONCILE_MAX_DELETE_FRACTION} of the considered files at once,
 *      once at least {@link RECONCILE_GUARD_MIN_CONSIDERED} files are in play
 *      (a partial layout divergence deletes most, not all, of the tree).
 */
const layoutMismatchRefusal = (
  deleteCount: number,
  consideredCount: number,
  authoritative: AuthoritativeIndex,
): string | null => {
  if (deleteCount === 0 || consideredCount === 0) return null;
  const reason = (detail: string): string =>
    `Refusing to reconcile source deletions: ${detail}. ` +
    `This is the signature of a source-layout mismatch between the vault tree and the ` +
    `authoritative retrieve output, not of components deleted in the org — a reconcile that ` +
    `misreads the layout finds nothing in common and proposes to delete everything. ` +
    `The vault was left untouched; re-run the refresh once the layouts agree, or delete the ` +
    `stale files deliberately if the org really did lose them.`;

  if (deleteCount === consideredCount && authoritative.inScopeCount > 0) {
    return reason(
      `all ${consideredCount} in-scope vault file(s) would be deleted even though the retrieve ` +
        `returned ${authoritative.inScopeCount} component file(s) of those same types`,
    );
  }
  if (
    consideredCount >= RECONCILE_GUARD_MIN_CONSIDERED &&
    deleteCount > consideredCount * RECONCILE_MAX_DELETE_FRACTION
  ) {
    return reason(
      `${deleteCount} of ${consideredCount} in-scope vault file(s) would be deleted, over the ` +
        `${Math.round(RECONCILE_MAX_DELETE_FRACTION * 100)}% ceiling for a single refresh`,
    );
  }
  return null;
};

/**
 * Drop `sourceDir` files for `typesToReconcile` that are absent from the
 * authoritative retrieve output. Only touches paths the dispatcher recognises —
 * unknown retrieve noise is left alone.
 *
 * Paths are compared through {@link comparisonKey}, so the two trees may sit in
 * different SFDX layouts. Candidates are collected in full BEFORE anything is
 * removed, because the safety rail has to see the whole deletion set to judge
 * it: a reconcile is only allowed to proceed once the shape of what it wants to
 * delete looks like org churn rather than a layout mismatch. When it refuses,
 * nothing is deleted and `refusalReason` carries the explanation for the caller.
 */
export const reconcileSourceDeletions = async (
  sourceDir: string,
  authoritativeDir: string,
  typesToReconcile: ReadonlySet<ComponentType>,
): Promise<SourceReconcileResult> => {
  if (typesToReconcile.size === 0) {
    return { deletedPaths: [], deletedCount: 0, consideredCount: 0, refused: false };
  }

  const authoritative = await authoritativeIndex(authoritativeDir, typesToReconcile);
  const sourceEntries: SourceEntry[] = [];
  await walkSourceEntries(sourceDir, sourceEntries);

  const considered = sourceEntries.filter((entry) => typesToReconcile.has(entry.type));
  const candidates: SourceEntry[] = [];
  const candidateBundleDirs = new Set<string>();

  for (const entry of considered) {
    const fileName = basename(entry.absPath);
    const primaryRel = primaryRelPathForSidecar(entry.relPath, fileName);
    const ownKey = comparisonKey(entry.relPath, entry.isDirectory);
    const primaryKey = primaryRel === null ? null : comparisonKey(primaryRel, entry.isDirectory);
    if (authoritative.keys.has(ownKey)) continue;
    if (primaryKey !== null && authoritative.keys.has(primaryKey)) continue;

    if (entry.isDirectory) candidateBundleDirs.add(entry.absPath);
    candidates.push(entry);
  }

  // Bundle child files are not walked as their own entries; a child that did get
  // picked up is covered by the recursive removal of its bundle dir.
  const doomed = candidates.filter(
    (entry) =>
      entry.isDirectory ||
      ![...candidateBundleDirs].some((dir) => entry.absPath.startsWith(`${dir}${sep}`)),
  );

  const refusalReason = layoutMismatchRefusal(doomed.length, considered.length, authoritative);
  if (refusalReason !== null) {
    return {
      deletedPaths: [],
      deletedCount: 0,
      consideredCount: considered.length,
      refused: true,
      refusalReason,
    };
  }

  const deletedPaths: string[] = [];
  for (const entry of doomed) {
    await rm(entry.absPath, { recursive: entry.isDirectory, force: true });
    deletedPaths.push(entry.relPath);
  }

  return {
    deletedPaths,
    deletedCount: deletedPaths.length,
    consideredCount: considered.length,
    refused: false,
  };
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
