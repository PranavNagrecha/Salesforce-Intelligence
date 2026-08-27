/**
 * Portable path primitives — one home for "split a path" and "render a path".
 *
 * ## Why this module exists
 *
 * The same three lines were written six different ways across five packages:
 * `p.split('/')`, `p.replace(/\\/g,'/')`, `` abs.startsWith(`${root}/`) ``,
 * `rel.split(sep).join('/')`, `p.split(/[\\/]+/)`. Each spelling was correct
 * for the path its author had in mind and wrong for the ones they did not, and
 * nothing tied them together except comments asserting that some upstream
 * boundary had already normalised the input. On Windows those assertions were
 * false and the failures were silent rather than loud:
 *
 * - `extractors/path-utils.ts` split a native path on `'/'`, so **every**
 *   EmailTemplate became `malformed-input` and the vault held zero of them —
 *   the refresh still reported `partial` and moved on.
 * - `cli/refresh-pipeline.ts` split on a hardcoded `sep`, so `review-change`
 *   found no path segments, dropped every finding, and printed
 *   `overallVerdict: 'safe'` — a deploy gate that passes because it parsed
 *   nothing is worse than one that fails.
 * - `mcp/tool-dispatch.ts` tested `` startsWith(`${home}/`) ``, so the `~`
 *   redaction never fired and every response carried `C:\Users\<name>\…`.
 *
 * The rule this module encodes: **the number of correct spellings is one, and
 * it lives here.** `scripts/check-portability.mjs` fails the build if a new
 * hand-rolled copy appears in any package source tree.
 *
 * ## Two normalisations that look identical and are not
 *
 * {@link toPosixPath} is **unconditional**: it rewrites backslashes on every
 * platform. Use it for a string that may carry FOREIGN separators — a path
 * that arrived from somewhere else and must be stored in one canonical form.
 *
 * {@link toRelativePosix} is **gated** on the host separator. Use it to render
 * a HOST path relative to a host root. The distinction is load-bearing: a
 * POSIX filename may legally contain a literal backslash, and
 * `packages/vault/src/hash.ts` feeds its relative paths into the digest that
 * becomes `manifest.sourceTreeHash`. Rewriting such a filename would change
 * that digest and make **every existing vault report stale** on its next
 * freshness check. Merging these two functions is a data-integrity bug, not a
 * simplification.
 *
 * This module imports only `node:path` — no I/O, no `os` — so `core` keeps its
 * charter of sitting at the bottom of the dependency graph. That is why
 * {@link collapseHome} takes `home` as a parameter instead of calling
 * `homedir()` itself.
 */

import {
  isAbsolute as nodeIsAbsolute,
  posix,
  relative as nodeRelative,
  sep,
} from 'node:path';

/**
 * Matches a run of either separator.
 *
 * Deliberately NOT global: a shared `/g` regex carries `lastIndex` between
 * `.test()` calls, so every second call against the same pattern would answer
 * incorrectly. `String.split` ignores the flag anyway.
 */
export const PATH_SEPARATORS = /[\\/]+/;

/**
 * Rewrite backslashes to forward slashes, unconditionally, on every platform.
 *
 * For strings that may carry foreign separators and must be stored canonically
 * (graph `source_path`, vault-relative ids). See the module note on why this is
 * NOT interchangeable with {@link toRelativePosix}.
 */
export const toPosixPath = (p: string): string => p.replace(/\\/g, '/');

/**
 * Segments of a path written with EITHER separator, empty segments dropped.
 *
 * Accepting both is the point: the input may be a native Windows path, a
 * forward-slash metadata path from a `package.xml`, or a git diff line (git
 * emits forward slashes on every platform).
 *
 * Note the one behaviour change on POSIX: a directory whose NAME contains a
 * literal backslash now splits into two segments. That is vanishingly unlikely
 * in Salesforce metadata and is the accepted cost of accepting both separators;
 * it is documented here rather than silently absorbed.
 */
export const splitPathSegments = (p: string): readonly string[] =>
  p.split(PATH_SEPARATORS).filter((s) => s.length > 0);

/**
 * Render `abs` relative to `root`, in posix form, for a HOST path.
 *
 * Gated on the host separator (see the module note). Falls back to the
 * posix-rendered absolute path when `abs` is not under `root` — an escape
 * (`..`) or a different Windows drive letter — so a caller never silently
 * receives a traversal it did not ask for.
 */
export const toRelativePosix = (root: string, abs: string): string => {
  const rel = nodeRelative(root, abs);
  if (rel === '' || rel.startsWith('..') || nodeIsAbsolute(rel)) {
    return toPosixPath(abs);
  }
  return sep === posix.sep ? rel : rel.split(sep).join(posix.sep);
};

/**
 * Collapse a path under the user's home directory to a `~/…` disclosure.
 *
 * This is the username-redaction invariant stamped onto every MCP response, not
 * a cosmetic: without it a vault path leaks the operator's account name to
 * whatever consumes the response.
 *
 * Deliberately does NOT delegate to {@link toRelativePosix}: when the path IS
 * the home directory, `relative()` returns `''`, and `toRelativePosix` maps
 * that to the absolute path — which would leak exactly the string this function
 * exists to hide. That case maps to a bare `~`.
 *
 * Free correctness win over the `startsWith` form it replaces: `relative()` is
 * case-insensitive on win32, so `c:\users\alice` now collapses against
 * `C:\Users\alice`.
 *
 * @param home the user's home directory; pass `''` to disable collapsing.
 */
export const collapseHome = (abs: string, home: string): string => {
  if (home.length === 0) return abs;
  const rel = nodeRelative(home, abs);
  if (rel === '') return '~';
  if (rel.startsWith('..') || nodeIsAbsolute(rel)) return abs;
  return `~/${toPosixPath(rel)}`;
};

/**
 * True when `child` IS `parent` or lies underneath it — the one correct
 * spelling of the `abs.startsWith(`${root}/`)` test the module doc names.
 *
 * Boundary-aware in both directions, which the hand-rolled form is not:
 * `/a/orgkb` is NOT within `/a/org` (a bare `startsWith` says it is), and a
 * trailing separator on either argument is not a difference. EITHER separator
 * counts as the boundary, on every platform, for the same reason
 * {@link splitPathSegments} accepts both: the caller may hold a native Windows
 * path while the host `sep` is `/`.
 *
 * Purely lexical — it compares the strings it is GIVEN and does no I/O, so it
 * neither case-folds nor resolves symlinks. A caller that needs those (a safety
 * rail deciding whether a write lands inside a directory it must not) is
 * responsible for feeding it the extra spellings and refusing if ANY of them
 * reports containment; `packages/cli/src/commands/vault-anonymize.ts` does
 * exactly that and documents why one of those spellings may never be dropped.
 *
 * Both arguments are expected to be absolute and already `resolve()`d; an empty
 * `parent` therefore contains everything, which is the honest reading of `''`
 * as a prefix rather than a case worth a silent special-case.
 */
export const isPathWithin = (parent: string, child: string): boolean => {
  const p = parent.replace(/[\\/]+$/, '');
  const c = child.replace(/[\\/]+$/, '');
  if (p === c) return true;
  if (!c.startsWith(p)) return false;
  const boundary = c.charAt(p.length);
  return boundary === '/' || boundary === '\\';
};

/**
 * True when `run` appears as CONSECUTIVE segments of `p`.
 *
 * For shapes where adjacency is the meaning — `main/default` in a Salesforce DX
 * tree is a canonical-layout marker, whereas a `main` somewhere and a `default`
 * elsewhere is not.
 */
export const hasAdjacentSegments = (
  p: string,
  run: readonly string[],
): boolean => {
  const segs = splitPathSegments(p);
  for (let i = 0; i + run.length <= segs.length; i += 1) {
    if (run.every((r, j) => segs[i + j] === r)) return true;
  }
  return false;
};

/** True when any segment of `p` is one of `names`. Membership, not adjacency. */
export const hasAnySegment = (p: string, names: readonly string[]): boolean =>
  splitPathSegments(p).some((s) => names.includes(s));
