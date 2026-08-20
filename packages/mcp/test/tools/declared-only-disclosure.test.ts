/// <reference types="vitest/globals" />

/**
 * The four siblings of `sfi.effective_permissions` answer from DECLARED
 * grants only — no dependency closure — so their system-permission answers
 * are LOWER BOUNDS and will disagree with `effective_permissions` on the
 * same containers.
 *
 * That divergence errs toward UNDER-stating access, the direction in which
 * a least-privilege reviewer approves a grant they would have blocked, and
 * it fails silently and plausibly. These tests pin the disclosure onto every
 * one of them, and pin the roster descriptions so a host LLM reading the
 * tool catalogue is told the same thing.
 *
 * They are deliberately STRUCTURAL (source + registry level) rather than
 * behavioural: the point is that no surface can quietly lose the disclosure
 * during an unrelated edit, which is exactly how the gap appeared.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildToolDocs } from '../../src/semantic-funnel.js';
import {
  declaredOnlyDependencyDisclosure,
  rosterDeclaredOnlyDisclosure,
  stripRosterDeclaredOnlyDisclosure,
} from '../../src/tools/declared-only-disclosure.js';
import { V01_TOOLS } from '../../src/tools/index.js';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools');

const source = (file: string): string => readFileSync(join(TOOLS_DIR, file), 'utf8');

/** Every handler that reads declared system permissions WITHOUT the closure. */
const DECLARED_ONLY_HANDLERS = [
  'what-if-permset.ts',
  'why-cant-user-see-record.ts',
  'user-ability.ts',
] as const;

describe('declaredOnlyDependencyDisclosure — the shared text', () => {
  it('names the gap, the direction, and the remedy', () => {
    const text = declaredOnlyDependencyDisclosure({ noun: 'system-permission delta' });
    expect(text).toContain('DEPENDENCY EXPANSION IS NOT APPLIED HERE');
    expect(text).toContain('DECLARED grants only');
    expect(text).toContain('UNDERSTATES effective access');
    expect(text).toContain('LOWER BOUND');
    expect(text).toContain('disagree on the same containers BY DESIGN');
    expect(text).toContain('sfi.effective_permissions');
  });

  it('labels the ManageUsers figure as ONE org, never a platform constant', () => {
    const text = declaredOnlyDependencyDisclosure({ noun: 'x' });
    // The graph is org-VARIABLE; quoting a per-org count as a constant is the
    // same unchecked-claim mistake this work exists to remove.
    expect(text).toContain('measured on ONE org, not a platform constant');
    expect(text).toContain('org-VARIABLE');
  });

  it('splices the per-tool noun and optional specifics', () => {
    const text = declaredOnlyDependencyDisclosure({
      noun: 'actionPermissions list',
      specifics: 'Tool-specific sentence.',
    });
    expect(text).toContain('its actionPermissions list is a LOWER BOUND');
    expect(text).toContain('Tool-specific sentence.');
    // Omitted specifics must not leave dangling whitespace artefacts.
    const bare = declaredOnlyDependencyDisclosure({ noun: 'x' });
    expect(bare).not.toContain('  ');
  });
});

describe('every declared-only handler emits the disclosure', () => {
  it.each(DECLARED_ONLY_HANDLERS)('%s calls the shared builder', (file) => {
    const text = source(file);
    expect(text).toContain("from './declared-only-disclosure.js'");
    expect(text).toContain('declaredOnlyDependencyDisclosure({');
  });

  // A tool that starts applying the closure should DELETE its call, not
  // reword it — so an inlined copy of the text is the drift this forbids.
  it.each(DECLARED_ONLY_HANDLERS)('%s does not inline its own copy of the text', (file) => {
    const text = source(file);
    expect(text).not.toContain('systematically UNDERSTATES effective access');
  });
});

describe('roster descriptions carry the same warning', () => {
  const roster = source('roster.ts');
  const byName = new Map(V01_TOOLS.map((t) => [t.name, t.description]));

  // Asserted on the RUNTIME description (what a host actually receives),
  // not on roster source text — the descriptions are composed at module load.
  it.each([
    'sfi.what_if_assign_permset',
    'sfi.what_if_revoke_permset',
    'sfi.user_ability',
    'sfi.why_cant_user_see_record',
  ])('%s is advertised as declared-only', (tool) => {
    const description = byName.get(tool);
    expect(description, `${tool} is not registered`).toBeDefined();
    expect(description).toContain('DEPENDENCY EXPANSION IS NOT APPLIED HERE');
    expect(description).toContain('LOWER BOUND');
    expect(description).toContain('sfi.effective_permissions');
  });

  // The old text told a host LLM the two tools ran the SAME engine and so
  // implicitly agreed. True of the engine, materially false of the ANSWER.
  it('no longer claims the what-if tools share the effective-permissions ENGINE', () => {
    expect(roster).not.toContain(
      'It composes the SAME effective-permissions engine as `sfi.effective_permissions`',
    );
    expect(roster).not.toContain('It composes the SAME effective-permissions engine TWICE');
    expect(roster).toContain('WITHOUT the dependency closure');
  });

  // One builder feeds both the roster text and the funnel stripper, so they
  // cannot drift into a state where the strip silently stops matching.
  it('composes the roster text from the shared builder, never an inlined copy', () => {
    expect(roster).toContain("import { rosterDeclaredOnlyDisclosure }");
    expect(roster.match(/rosterDeclaredOnlyDisclosure\('/g) ?? []).toHaveLength(4);
    expect(roster).not.toContain('systematically UNDERSTATES effective access');
  });
});

/**
 * The MCP `description` is dual-purpose: it is both the host-facing contract
 * AND the funnel's retrieval document (`buildToolDocs` indexes it verbatim,
 * and that file's own invariant warns that "any corpus edit shifts every
 * term's IDF"). The warning belongs in the first role and NOT the second —
 * measured: indexing it sank `sfi.org_card` self-recall to 66.7%, displaced
 * `sfi.interpret` from a top-5, and pushed `sfi.list_components` out of the
 * top-3 for "what custom permissions are defined?".
 */
describe('the disclosure reaches hosts but never the retrieval corpus', () => {
  const MARKER = 'DEPENDENCY EXPANSION IS NOT APPLIED HERE';

  it('is present in the advertised descriptions', () => {
    const carrying = V01_TOOLS.filter((t) => t.description.includes(MARKER));
    expect(carrying.map((t) => t.name).sort()).toEqual([
      'sfi.user_ability',
      'sfi.what_if_assign_permset',
      'sfi.what_if_revoke_permset',
      'sfi.why_cant_user_see_record',
    ]);
  });

  it('is absent from EVERY indexed funnel document', () => {
    for (const [tool, doc] of buildToolDocs()) {
      expect(doc, `${tool} leaked the disclosure into the funnel corpus`).not.toContain(
        MARKER,
      );
      // The distinctive tail must not survive either.
      expect(doc).not.toContain('on the same bundle for the expanded set');
    }
  });

  it('strips EXACTLY the appended text, leaving the rest of the description intact', () => {
    const base = 'Base description that ends here.';
    for (const noun of ['system-permission GAIN delta', '`actionPermissions` list']) {
      const full = base + rosterDeclaredOnlyDisclosure(noun);
      expect(full).toContain(MARKER);
      expect(stripRosterDeclaredOnlyDisclosure(full)).toBe(base);
    }
  });

  it('is a no-op on a description that never carried it', () => {
    const plain = 'A tool description with no disclosure appended.';
    expect(stripRosterDeclaredOnlyDisclosure(plain)).toBe(plain);
  });
});
