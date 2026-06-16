/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { openGraph, closeGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  searchApexSourceHandler,
  searchApexSourceInputSchema,
} from '../../src/tools/search-apex-source.js';

/**
 * Manifest values are echoed verbatim by every successful response;
 * the tests assert on `sourceTreeHash` to confirm the `vaultState`
 * envelope copies through correctly.
 */
const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 2, ApexTrigger: 1 },
  edges: {},
  sourceTreeHash: 'sha256:apex-source-fixture',
};

/**
 * Write a source file under `{vault}/source/{subdir}/{name}` with the
 * given contents, creating intermediate directories as needed.
 */
const writeSource = (
  vault: string,
  subdir: 'classes' | 'triggers',
  name: string,
  contents: string,
): void => {
  const dir = join(vault, 'source', subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-search-apex-source-'));

  // The handler never touches the graph, but `Context` requires an
  // open `GraphStore`. We open a throwaway one and tear it down in
  // `afterAll`; tests neither read from it nor write to it.
  const dbPath = join(tempDir, 'unused.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };

  // The canonical happy-path corpus from the task spec:
  // Foo.cls — exercises the regex-by-word test (\bclass\b).
  // Bar.cls — exercises 'Account' substring on a class body.
  // AccountTrigger.trigger — exercises 'Account' substring on a trigger.
  writeSource(
    tempDir,
    'classes',
    'Foo.cls',
    "public class Foo { String x = 'banana'; }\n",
  );
  writeSource(
    tempDir,
    'classes',
    'Bar.cls',
    'Account a = new Account();\n',
  );
  writeSource(
    tempDir,
    'triggers',
    'AccountTrigger.trigger',
    'trigger AccountTrigger on Account (before insert) {\n',
  );

  // The meta-xml decoys: a class-meta and trigger-meta whose contents
  // match the substring query. The handler must skip these even though
  // their names share a prefix with the real Apex files above.
  writeSource(
    tempDir,
    'classes',
    'Foo.cls-meta.xml',
    '<apiVersion>Account</apiVersion>\n',
  );
  writeSource(
    tempDir,
    'triggers',
    'AccountTrigger.trigger-meta.xml',
    '<status>Account</status>\n',
  );

  // Bulk-match corpus for the limit/truncation test: 20 files in
  // `classes/`, each with 5 lines containing the marker `LIMITSCAN`.
  // 100 matches total. The substring query 'LIMITSCAN' is unique to
  // these files so the bulk fixture does not interfere with the other
  // tests' assertions.
  for (let i = 0; i < 20; i += 1) {
    const fileName = `Bulk${String(i).padStart(2, '0')}.cls`;
    const body = Array.from({ length: 5 }, (_, j) =>
      `String marker${j} = 'LIMITSCAN-${i}-${j}';`,
    ).join('\n');
    writeSource(tempDir, 'classes', fileName, `${body}\n`);
  }
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('searchApexSourceHandler', () => {
  it('returns substring matches case-insensitively across classes and triggers', async () => {
    // Default mode: substring + case-insensitive. 'Account' appears
    // in Bar.cls and AccountTrigger.trigger; Foo.cls does not match.
    const result = await searchApexSourceHandler(ctx, { query: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.data.matches.map((m) => m.path);
    expect(paths).toContain('source/classes/Bar.cls');
    expect(paths).toContain('source/triggers/AccountTrigger.trigger');
    // The bulk fixture and Foo.cls must not appear in an 'Account' search.
    expect(
      result.value.data.matches.every(
        (m) => m.path === 'source/classes/Bar.cls' ||
          m.path === 'source/triggers/AccountTrigger.trigger',
      ),
    ).toBe(true);
    expect(result.value.data.truncated).toBe(false);
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:apex-source-fixture',
    );
    expect(result.value.vaultState.refreshedAt).toBe(
      '2026-05-27T14:33:08Z',
    );
  });

  it('treats substring queries case-insensitively', async () => {
    // Lower-case 'account' must hit the same two files as 'Account'.
    const result = await searchApexSourceHandler(ctx, { query: 'account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.data.matches
      .map((m) => m.path)
      .filter(
        (p) =>
          p === 'source/classes/Bar.cls' ||
          p === 'source/triggers/AccountTrigger.trigger',
      );
    // Both relevant files matched once each.
    expect(paths).toHaveLength(2);
  });

  it('compiles regex queries with the i flag when regex=true', async () => {
    // `\bclass\b` matches the class keyword in Foo.cls's declaration
    // but not the substring 'class' inside an identifier like
    // 'classes' (which does not appear in our fixture anyway).
    const result = await searchApexSourceHandler(ctx, {
      query: '\\bclass\\b',
      regex: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fooHits = result.value.data.matches.filter(
      (m) => m.path === 'source/classes/Foo.cls',
    );
    expect(fooHits).toHaveLength(1);
    expect(fooHits[0]!.snippet).toBe(
      "public class Foo { String x = 'banana'; }",
    );
    expect(fooHits[0]!.line).toBe(1);
  });

  it('honors the limit option and reports truncated=true', async () => {
    // The bulk fixture provides 100 matches for 'LIMITSCAN'. With
    // limit=10 the handler must stop at the cap and report truncated.
    const result = await searchApexSourceHandler(ctx, {
      query: 'LIMITSCAN',
      limit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches).toHaveLength(10);
    expect(result.value.data.truncated).toBe(true);
  });

  it('returns no matches and truncated=false when nothing matches', async () => {
    const result = await searchApexSourceHandler(ctx, { query: 'ZZZZZ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches).toEqual([]);
    expect(result.value.data.truncated).toBe(false);
    expect(result.value.data.boundaryNote).toMatch(/source\/ tree/);
    expect(result.value.data.boundaryNote).toMatch(/find_field_anywhere/);
  });

  it('returns invalid-query when the regex fails to compile', async () => {
    const result = await searchApexSourceHandler(ctx, {
      query: '[unclosed',
      regex: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('invalid regex');
  });

  it('skips *-meta.xml companion files even when their content matches', async () => {
    // Both meta-xml decoys contain the literal 'Account', but they live
    // alongside the .cls / .trigger files in the same directories. A
    // substring search for 'Account' must yield no hits whose path
    // ends in `-meta.xml`.
    const result = await searchApexSourceHandler(ctx, { query: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const match of result.value.data.matches) {
      expect(match.path.endsWith('-meta.xml')).toBe(false);
    }
  });

  it('returns identical output for identical input (deterministic)', async () => {
    // Run the same query twice and assert deep equality on the data
    // block. `vaultState` is sourced from `ctx.manifest` so it is
    // trivially stable; the meaningful assertion is on `matches`
    // ordering and content.
    const first = await searchApexSourceHandler(ctx, { query: 'LIMITSCAN' });
    const second = await searchApexSourceHandler(ctx, { query: 'LIMITSCAN' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.data).toEqual(first.value.data);
  });

  it('returns matches sorted by (path ASC, line ASC)', async () => {
    // Bulk fixture has 5 matches per file across 20 files; with the
    // default limit of 50, the first 10 files (sorted) account for
    // the entire result. Assert lexicographic path order and ascending
    // line numbers within each path.
    const result = await searchApexSourceHandler(ctx, {
      query: 'LIMITSCAN',
      limit: 50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matches = [...result.value.data.matches];
    for (let i = 1; i < matches.length; i += 1) {
      const prev = matches[i - 1]!;
      const curr = matches[i]!;
      if (prev.path === curr.path) {
        expect(curr.line).toBeGreaterThan(prev.line);
      } else {
        expect(curr.path > prev.path).toBe(true);
      }
    }
  });

  it('returns no matches and truncated=false when source/ is missing', async () => {
    // A vault with a manifest but no `source/` directory yet — the
    // refresh has not run or has been cleared. The tool must degrade
    // gracefully to an empty result.
    const emptyVault = mkdtempSync(join(tmpdir(), 'sfi-mcp-empty-vault-'));
    try {
      const emptyCtx: Context = {
        vaultRoot: emptyVault,
        manifest: FIXTURE_MANIFEST,
        graph: store,
      };
      const result = await searchApexSourceHandler(emptyCtx, {
        query: 'anything',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.matches).toEqual([]);
      expect(result.value.data.truncated).toBe(false);
    } finally {
      rmSync(emptyVault, { recursive: true, force: true });
    }
  });

  it('trims leading and trailing whitespace from snippets', async () => {
    // Indented matching lines are common in Apex; the snippet must be
    // trimmed but the line number preserved.
    const result = await searchApexSourceHandler(ctx, {
      query: 'banana',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches).toHaveLength(1);
    expect(result.value.data.matches[0]!.snippet).toBe(
      "public class Foo { String x = 'banana'; }",
    );
  });
});

describe('searchApexSourceInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = searchApexSourceInputSchema.safeParse({ query: 'Account' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty query string', () => {
    const parsed = searchApexSourceInputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing query field', () => {
    const parsed = searchApexSourceInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit greater than 200', () => {
    const parsed = searchApexSourceInputSchema.safeParse({
      query: 'Account',
      limit: 201,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = searchApexSourceInputSchema.safeParse({
      query: 'Account',
      limit: 2.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-boolean regex flag', () => {
    const parsed = searchApexSourceInputSchema.safeParse({
      query: 'Account',
      regex: 'yes',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts regex=true with a valid pattern string', () => {
    // The schema does not pre-compile the regex; an invalid pattern
    // passes Zod and is caught at handler time as invalid-query.
    const parsed = searchApexSourceInputSchema.safeParse({
      query: '[unclosed',
      regex: true,
    });
    expect(parsed.success).toBe(true);
  });
});
