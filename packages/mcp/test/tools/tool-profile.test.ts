/// <reference types="vitest/globals" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { V01_TOOLS } from '../../src/tools/roster.js';
import {
  ADVERTISED_QUESTION_TOOLS,
  CORE_PROFILE_TOOLS,
  isDirectlyInvokable,
} from '../../src/tools/tool-profile.js';

/**
 * ROSTER-HIDES-THE-ADVERTISED-ANSWERS.
 *
 * The default profile advertised 19 of 217 tools, and among the hidden 198 were
 * the tools that answer the questions the npm package page invites the reader to
 * ask: `safe_to_delete_field`, `who_can_access_object`, `field_access_audit`,
 * `why_cant_user_see_record`, `what_happens_on_save`, `org_overview`.
 *
 * A schema-driven host reads `tools/list` and will not invent
 * `sfi.run_analysis`. So the product answered its own front-page questions only
 * for a caller who already knew the gateway existed — which a first-time user is
 * exactly not.
 *
 * These tests make the roster DERIVED rather than curated. A hand-picked "better
 * thirty" would drift from the docs the same way the nineteen did, silently.
 */
const README = fileURLToPath(
  new URL('../../../cli/README.md', import.meta.url),
);

/** Normalise for comparison against prose: quotes and case vary in copy. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

describe('core roster is derived from the questions the product advertises', () => {
  it('every advertised question names at least two tools that exist in the roster', () => {
    const registered = new Set(V01_TOOLS.map((t) => t.name));
    expect(ADVERTISED_QUESTION_TOOLS.size).toBeGreaterThan(0);
    for (const [question, tools] of ADVERTISED_QUESTION_TOOLS) {
      expect(tools.length, `"${question}" names no tools`).toBeGreaterThan(0);
      for (const name of tools) {
        expect(registered.has(name), `"${question}" names ${name}, which is not a registered tool`).toBe(
          true,
        );
      }
    }
  });

  it('FAIL-BEFORE/PASS-AFTER: every tool that answers an advertised question is DIRECTLY invokable', () => {
    const hidden: string[] = [];
    for (const [question, tools] of ADVERTISED_QUESTION_TOOLS) {
      for (const name of tools) {
        if (!isDirectlyInvokable(name, 'core')) hidden.push(`${name} (answers "${question}")`);
      }
    }
    expect(
      hidden,
      'These tools answer questions the product advertises, but a schema-driven host cannot see ' +
        'them in tools/list and will not invent sfi.run_analysis:\n  ' +
        hidden.join('\n  '),
    ).toEqual([]);
  });

  /**
   * The derivation is only real if the questions are the PUBLISHED ones. Without
   * this the map is just another hand-maintained list that happens to live in
   * code — and it would drift from the page the moment marketing copy changed,
   * which is precisely how the roster got here.
   */
  it('every advertised question actually appears on the npm package page', () => {
    const page = norm(readFileSync(README, 'utf8'));
    const missing = [...ADVERTISED_QUESTION_TOOLS.keys()].filter((q) => !page.includes(norm(q)));
    expect(
      missing,
      'These questions are declared as advertised in tool-profile.ts but do not appear in ' +
        'packages/cli/README.md. Either the page changed and the map is stale, or the map is ' +
        'claiming a promise the product does not actually make:\n  ' +
        missing.join('\n  '),
    ).toEqual([]);
  });

  it('the gateway and consent stay directly invokable — the roster must not strand its own escape hatches', () => {
    // Without these, a host that hits a non-core tool has no route to it and no
    // way to turn the live plane on. They are load-bearing regardless of which
    // questions are advertised.
    for (const name of ['sfi.run_analysis', 'sfi.describe_analysis', 'sfi.list_analyses', 'sfi.live_consent']) {
      expect(isDirectlyInvokable(name, 'core'), `${name} must be directly invokable`).toBe(true);
    }
  });

  it('core is still a strict subset — the fix must not become "advertise everything"', () => {
    // `SFI_TOOL_PROFILE=full` exists for that, and blowing tools/list is how a
    // server gets dropped by a host. The point was never a bigger number; it was
    // that the advertised set answers the advertised questions.
    expect(CORE_PROFILE_TOOLS.size).toBeLessThan(V01_TOOLS.length / 2);
    expect(isDirectlyInvokable('sfi.tech_debt_score', 'core')).toBe(false);
  });

  it('full profile still admits everything', () => {
    expect(isDirectlyInvokable('sfi.tech_debt_score', 'full')).toBe(true);
  });
});
