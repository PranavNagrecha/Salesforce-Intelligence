import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tryReadComponentDoc } from '../../src/tools/component-doc-fallback.js';

const DOC = `---
id: ValidationRule:Lead.My_Rule
type: ValidationRule
---
The rule body.
`;

const SECRET = `---
id: not-a-vault-file
---
SENSITIVE-HOST-FILE-CONTENTS
`;

/**
 * COMPONENT-DOC-FALLBACK-TRAVERSAL.
 *
 * `sfi.get_component` passes its caller-supplied `input.id` straight into
 * {@link tryReadComponentDoc}, which parsed it by splitting on the first `.`
 * and handed both halves to `componentPath`'s `join` without rejecting
 * anything. The segments could therefore climb out of the vault, and the
 * relative-path computation on the way back out returned the ABSOLUTE path on
 * exactly the inputs that escaped — disclosing the host's filesystem layout
 * even when the read itself failed.
 *
 * Defect predates the 0.3 line: present in 0.3.0, 0.3.1 and 0.3.2.
 */
describe('tryReadComponentDoc — vault containment', () => {
  /**
   * The payload has to survive the parser to be a real test. `indexOf('.')`
   * splits on the FIRST dot and rejects `dot <= 0`, so a leading `..` is
   * refused for the wrong reason and proves nothing. `a/../../../../../x.y`
   * puts a harmless segment first, which makes the split land where we want and
   * leaves the climb intact.
   */
  it('FAIL-BEFORE/PASS-AFTER: refuses an id whose segments climb out of the vault', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-doc-traversal-'));
    try {
      const vaultRoot = join(cwd, 'vault');
      await mkdir(join(vaultRoot, 'components', 'ValidationRule'), { recursive: true });
      // Planted OUTSIDE the vault, one level up. Well-formed frontmatter, so
      // nothing downstream would have rejected it had the read succeeded.
      await writeFile(join(cwd, 'secret.leak.md'), SECRET, 'utf8');

      const escaped = await tryReadComponentDoc(
        vaultRoot,
        'ValidationRule:a/../../../../../secret.leak',
      );

      expect(escaped).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('still reads a legitimate component doc inside the vault', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-doc-ok-'));
    try {
      const vaultRoot = join(cwd, 'vault');
      const dir = join(vaultRoot, 'components', 'ValidationRule', 'Lead');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'My_Rule.md'), DOC, 'utf8');

      const doc = await tryReadComponentDoc(vaultRoot, 'ValidationRule:Lead.My_Rule');

      expect(doc).not.toBeNull();
      expect(doc?.type).toBe('ValidationRule');
      expect(doc?.body).toContain('The rule body.');
      // Never absolute — the returned path is the disclosure surface.
      expect(isAbsolute(doc?.path ?? '')).toBe(false);
      expect(doc?.path).toBe(join('components', 'ValidationRule', 'Lead', 'My_Rule.md'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('never returns an absolute path, whatever the id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sfi-doc-abs-'));
    try {
      const vaultRoot = join(cwd, 'vault');
      await mkdir(join(vaultRoot, 'components', 'ValidationRule'), { recursive: true });
      await writeFile(join(cwd, 'secret.leak.md'), SECRET, 'utf8');

      for (const id of [
        'ValidationRule:a/../../../../../secret.leak',
        'ValidationRule:a/../../..\\..\\..\\secret.leak',
        'ValidationRule:Lead.Missing_Rule',
      ]) {
        const doc = await tryReadComponentDoc(vaultRoot, id);
        if (doc !== null) expect(isAbsolute(doc.path)).toBe(false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
