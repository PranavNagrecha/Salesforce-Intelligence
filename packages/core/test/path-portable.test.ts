/// <reference types="vitest/globals" />

import { sep } from 'node:path';

import {
  collapseHome,
  hasAdjacentSegments,
  hasAnySegment,
  isPathWithin,
  PATH_SEPARATORS,
  splitPathSegments,
  toPosixPath,
  toRelativePosix,
} from '../src/path-portable.js';

/**
 * Most of this module is pure string logic, so the Windows behaviour is fully
 * provable on a POSIX host by feeding it backslash input — which is exactly the
 * shape the real defects took (`dir.split('/')` on a native Windows path).
 *
 * The two functions that call `node:path` (`toRelativePosix`, `collapseHome`)
 * are bound to the host flavour and cannot be proven for win32 here: stubbing
 * `process.platform` does NOT change `path.sep` or `path.relative`, which are
 * fixed at module load. Those get their host-behaviour assertions below and
 * their win32 binding is proven by the Windows CI job.
 */

describe('splitPathSegments — accepts either separator', () => {
  it('splits a POSIX path', () => {
    expect(splitPathSegments('force-app/main/default/classes/Foo.cls')).toEqual([
      'force-app',
      'main',
      'default',
      'classes',
      'Foo.cls',
    ]);
  });

  it('splits a native Windows path — the case that annihilated EmailTemplates', () => {
    // `dir.split('/')` returned ONE segment here, so the extractor saw no
    // folder structure, returned `malformed-input`, and the vault ended up with
    // zero EmailTemplate nodes while the refresh still reported partial success.
    expect(
      splitPathSegments('force-app\\main\\default\\email\\Marketing\\Welcome.email'),
    ).toEqual(['force-app', 'main', 'default', 'email', 'Marketing', 'Welcome.email']);
  });

  it('splits a mixed path', () => {
    expect(splitPathSegments('a\\b/c\\d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops empty segments from leading, trailing and doubled separators', () => {
    expect(splitPathSegments('/a//b/')).toEqual(['a', 'b']);
    expect(splitPathSegments('\\\\server\\share\\')).toEqual(['server', 'share']);
  });

  it('returns nothing for a path that is only separators', () => {
    expect(splitPathSegments('/')).toEqual([]);
    expect(splitPathSegments('\\')).toEqual([]);
    expect(splitPathSegments('')).toEqual([]);
  });
});

describe('PATH_SEPARATORS', () => {
  it('is not global — a /g regex would carry lastIndex between .test() calls', () => {
    // A shared global regex answers incorrectly on every second call. This is a
    // real bug class, so pin the flag rather than trusting the declaration.
    expect(PATH_SEPARATORS.global).toBe(false);
    expect(PATH_SEPARATORS.test('a/b')).toBe(true);
    expect(PATH_SEPARATORS.test('a/b')).toBe(true);
  });
});

describe('toPosixPath — unconditional', () => {
  it('rewrites backslashes on every platform', () => {
    expect(toPosixPath('C:\\Devs\\alice\\org-kb')).toBe('C:/Devs/alice/org-kb');
  });

  it('leaves a POSIX path untouched', () => {
    expect(toPosixPath('a/b/c')).toBe('a/b/c');
  });
});

describe('toRelativePosix', () => {
  it('renders a path under the root, posix-style', () => {
    const root = ['', 'srv', 'vault'].join(sep) || '/srv/vault';
    expect(toRelativePosix('/srv/vault', '/srv/vault/components/CustomObject/Account.md')).toBe(
      'components/CustomObject/Account.md',
    );
    expect(root).toBeDefined();
  });

  it('maps the root itself to the posix-rendered absolute path, not an empty string', () => {
    // Callers render this into a wire field; an empty string would read as "the
    // vault root has no path" rather than "this IS the root".
    expect(toRelativePosix('/srv/vault', '/srv/vault')).toBe('/srv/vault');
  });

  it('does not silently return a traversal for a path outside the root', () => {
    expect(toRelativePosix('/srv/vault', '/etc/passwd')).toBe('/etc/passwd');
  });

  it('is NOT the same function as toPosixPath — the hash digest depends on it', () => {
    // packages/vault/src/hash.ts feeds this into manifest.sourceTreeHash. On a
    // POSIX host a filename may legally contain a backslash; rewriting it would
    // change the digest and make EVERY existing vault report stale. So on POSIX
    // the backslash must survive.
    if (sep === '/') {
      expect(toRelativePosix('/srv/vault', '/srv/vault/od\\d.cls')).toBe('od\\d.cls');
      // toPosixPath, by contrast, rewrites it — that is the whole distinction.
      expect(toPosixPath('od\\d.cls')).toBe('od/d.cls');
    }
  });
});

describe('collapseHome — the username-redaction invariant', () => {
  const home = sep === '\\' ? 'C:\\Devs\\alice' : '/home/alice';
  const under = [home, 'code', 'demo', 'org-kb'].join(sep);

  it('collapses a path under home and renders it posix', () => {
    expect(collapseHome(under, home)).toBe('~/code/demo/org-kb');
  });

  it('maps home ITSELF to `~`, never to the absolute path', () => {
    // The regression this guards: delegating to toRelativePosix returns the
    // absolute path when relative() is '' — leaking exactly the string this
    // function exists to hide.
    expect(collapseHome(home, home)).toBe('~');
    expect(collapseHome(home, home)).not.toContain('alice');
  });

  it('leaves a path outside home alone', () => {
    const outside = sep === '\\' ? 'D:\\vault' : '/srv/vault';
    expect(collapseHome(outside, home)).toBe(outside);
  });

  it('disables collapsing when home is empty rather than mangling the path', () => {
    expect(collapseHome(under, '')).toBe(under);
  });

  it('never emits a bare backslash-joined tail', () => {
    expect(collapseHome(under, home)).not.toContain('\\');
  });
});

describe('hasAdjacentSegments — adjacency is the meaning', () => {
  it('accepts main/default written with either separator', () => {
    expect(hasAdjacentSegments('force-app/main/default/classes/Foo.cls', ['main', 'default'])).toBe(true);
    expect(hasAdjacentSegments('force-app\\main\\default\\classes\\Foo.cls', ['main', 'default'])).toBe(true);
  });

  it('rejects the segments when they are present but NOT adjacent', () => {
    // The reason this is not `hasAnySegment`: a `main` somewhere and a
    // `default` elsewhere is not a DX canonical layout.
    expect(hasAdjacentSegments('main/x/default/classes/Foo.cls', ['main', 'default'])).toBe(false);
  });

  it('rejects a run that would fall off the end', () => {
    expect(hasAdjacentSegments('force-app/main', ['main', 'default'])).toBe(false);
  });
});

describe('hasAnySegment — membership', () => {
  it('matches a directory name in either separator style', () => {
    expect(hasAnySegment('a/lwc/foo.js', ['lwc', 'aura'])).toBe(true);
    expect(hasAnySegment('a\\aura\\foo.cmp', ['lwc', 'aura'])).toBe(true);
  });

  it('does not match a partial segment', () => {
    // `lwc` must be a whole segment, not a substring of `my-lwc-thing`.
    expect(hasAnySegment('a/my-lwc-thing/foo.js', ['lwc'])).toBe(false);
  });
});

describe('isPathWithin — containment with a real separator boundary', () => {
  it('treats a path as within itself', () => {
    expect(isPathWithin('/a/org-kb', '/a/org-kb')).toBe(true);
  });

  it('matches a nested child, at any depth', () => {
    expect(isPathWithin('/a/org-kb', '/a/org-kb/shared')).toBe(true);
    expect(isPathWithin('/a/org-kb', '/a/org-kb/shared/deep/file.json')).toBe(true);
  });

  it('does NOT match a sibling that merely shares a prefix', () => {
    // The whole reason this is not `startsWith`: `/a/orgkb` and `/a/org-kb-2`
    // are different directories that a bare prefix test calls contained.
    expect(isPathWithin('/a/org', '/a/orgkb')).toBe(false);
    expect(isPathWithin('/a/org-kb', '/a/org-kb-2')).toBe(false);
  });

  it('ignores trailing separators on either side', () => {
    expect(isPathWithin('/a/org-kb/', '/a/org-kb')).toBe(true);
    expect(isPathWithin('/a/org-kb', '/a/org-kb/')).toBe(true);
    expect(isPathWithin('/a/org-kb//', '/a/org-kb/shared/')).toBe(true);
  });

  it('is directional — a parent is not within its child', () => {
    expect(isPathWithin('/a/org-kb/shared', '/a/org-kb')).toBe(false);
  });

  it('returns false for unrelated paths', () => {
    expect(isPathWithin('/a/org-kb', '/tmp/somewhere-else')).toBe(false);
  });

  it('handles the filesystem root as a parent', () => {
    expect(isPathWithin('/', '/a')).toBe(true);
    expect(isPathWithin('/', '/')).toBe(true);
  });

  it('handles a Windows drive-letter pair on a POSIX host', () => {
    // Bound to the string, not to `path.sep`: the caller may hold a native
    // Windows path while the host separator is `/`.
    expect(isPathWithin('C:\\Proj\\org-kb', 'C:\\Proj\\org-kb\\shared')).toBe(true);
    expect(isPathWithin('C:\\', 'C:\\Proj')).toBe(true);
    expect(isPathWithin('C:\\Proj\\org', 'C:\\Proj\\orgkb')).toBe(false);
    expect(isPathWithin('C:\\Proj', 'D:\\Proj\\org-kb')).toBe(false);
  });

  it('does NOT case-fold or resolve symlinks — that is the caller\'s job', () => {
    // Documented boundary: the vault-anonymize rail feeds it canonicalized and
    // case-folded spellings itself precisely because this stays lexical.
    expect(isPathWithin('/a/ORG-KB', '/a/org-kb/shared')).toBe(false);
  });
});
