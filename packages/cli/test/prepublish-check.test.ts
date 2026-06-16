import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const cliDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(cliDir, '../../..');

describe('prepublishOnly hook', () => {
  it('wires npm publish to monorepo prepublish-check', () => {
    const pkg = JSON.parse(
      readFileSync(join(cliDir, '../package.json'), 'utf8')
    ) as { scripts?: { prepublishOnly?: string } };
    expect(pkg.scripts?.prepublishOnly).toContain('prepublish-check.mjs');
  });

  it('prepublish-check script exists at repo root', () => {
    const script = join(repoRoot, 'scripts/prepublish-check.mjs');
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('scan-org-leaks.mjs');
    expect(text).toContain('release-guard.mjs');
  });
});
