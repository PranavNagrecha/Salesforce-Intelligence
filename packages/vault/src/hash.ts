import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';

/**
 * The error variants `computeSourceTreeHash` can return.
 *
 *   - `directory-not-found`: the source root does not exist or is not a directory.
 *   - `read-failed`: a file or directory entry could not be read during the walk.
 */
export interface HashError {
  readonly kind: 'directory-not-found' | 'read-failed';
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}

/** Null-byte separator between path and bytes in the canonical hash stream. */
const RECORD_SEPARATOR = Buffer.from([0x00]);
/** Newline terminator between file records in the canonical hash stream. */
const RECORD_TERMINATOR = Buffer.from([0x0a]);

/**
 * Compute a deterministic sha256 over the contents of a directory tree.
 *
 * Canonicalization (must match across macOS and Linux):
 *   1. Walk the tree depth-first; at every directory, process entries
 *      in alphabetical order.
 *   2. Skip any entry whose name begins with `.` (this covers `.DS_Store`,
 *      `.gitkeep`, `.git`, and friends).
 *   3. For each regular file, feed into the hash: the POSIX-normalized
 *      relative path, one null byte (`\x00`), the file bytes, then a
 *      newline (`\n`).
 *   4. Output the 64-char lowercase hex digest.
 *
 * The hash is intended as a staleness signal for the vault: when the
 * source tree changes, the digest changes, and downstream consumers know
 * to refresh.
 *
 * @example
 *   const r = await computeSourceTreeHash('/path/to/org-kb/source');
 *   if (r.ok) console.log(r.value); // 'abc123...' (64 hex chars)
 */
export const computeSourceTreeHash = async (
  sourceRoot: string,
): Promise<Result<string, HashError>> => {
  try {
    const rootStat = await stat(sourceRoot);
    if (!rootStat.isDirectory()) {
      return err({
        kind: 'directory-not-found',
        message: `source root is not a directory: ${sourceRoot}`,
        path: sourceRoot,
      });
    }
  } catch (cause) {
    return err({
      kind: 'directory-not-found',
      message: `source root does not exist: ${sourceRoot}`,
      path: sourceRoot,
      cause,
    });
  }

  const hash = createHash('sha256');
  const walked = await walkAndHash(sourceRoot, sourceRoot, hash);
  if (!walked.ok) {
    return walked;
  }
  return ok(hash.digest('hex'));
};

/**
 * Recursively walk `currentDir`, feeding each regular file into `hash` in
 * alphabetical order. Returns `Result<void, HashError>` so a single read
 * failure aborts the whole computation rather than producing a partial
 * (and therefore non-determinism-poisoning) digest.
 */
const walkAndHash = async (
  rootDir: string,
  currentDir: string,
  hash: ReturnType<typeof createHash>,
): Promise<Result<void, HashError>> => {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (cause) {
    return err({
      kind: 'read-failed',
      message: `failed to read directory: ${currentDir}`,
      path: currentDir,
      cause,
    });
  }

  const sorted = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of sorted) {
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkAndHash(rootDir, absolutePath, hash);
      if (!sub.ok) {
        return sub;
      }
    } else if (entry.isFile()) {
      const fileResult = await hashFile(rootDir, absolutePath, hash);
      if (!fileResult.ok) {
        return fileResult;
      }
    }
  }
  return ok(undefined);
};

/**
 * Read a single regular file and update `hash` with the canonical record:
 * relative-path + NUL + bytes + LF. Returns `read-failed` on read errors so
 * the caller can short-circuit the walk.
 */
const hashFile = async (
  rootDir: string,
  absolutePath: string,
  hash: ReturnType<typeof createHash>,
): Promise<Result<void, HashError>> => {
  const rawRel = relative(rootDir, absolutePath);
  // Normalize platform separators to `/` so the hash matches across OSes.
  const relPath = sep === '/' ? rawRel : rawRel.split(sep).join('/');
  let bytes;
  try {
    bytes = await readFile(absolutePath);
  } catch (cause) {
    return err({
      kind: 'read-failed',
      message: `failed to read file: ${absolutePath}`,
      path: absolutePath,
      cause,
    });
  }
  hash.update(Buffer.from(relPath, 'utf8'));
  hash.update(RECORD_SEPARATOR);
  hash.update(bytes);
  hash.update(RECORD_TERMINATOR);
  return ok(undefined);
};
