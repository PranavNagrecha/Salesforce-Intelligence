import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findBrokenRelativeLinks } from '../scripts/lib/doc-links.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const linkingFile = join(repoRoot, 'docs/README.md');

describe('findBrokenRelativeLinks', () => {
  it('reports a relative link whose target file does not exist', () => {
    const failures = findBrokenRelativeLinks(
      'See [release report](./reports/missing-fixture.md).',
      linkingFile,
      { exists: () => false },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].linkingFile).toBe(linkingFile);
    expect(failures[0].linkText).toBe('release report');
    expect(failures[0].resolvedPath).toBe(
      join(dirname(linkingFile), 'reports/missing-fixture.md'),
    );
  });

  it('ignores existing targets, anchor-only links, and https URLs', () => {
    const resolved = join(dirname(linkingFile), 'reports/exists.md');
    const exists = (path: string) => path === resolved;
    const content = [
      '[ok](./reports/exists.md)',
      '[same-page](#section)',
      '[site](https://example.com/doc)',
    ].join('\n');
    expect(findBrokenRelativeLinks(content, linkingFile, { exists })).toEqual([]);
  });
});
