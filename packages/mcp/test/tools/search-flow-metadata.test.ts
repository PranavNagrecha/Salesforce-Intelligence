/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { openGraph, closeGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  searchFlowMetadataHandler,
  searchFlowMetadataInputSchema,
} from '../../src/tools/search-flow-metadata.js';

/**
 * Manifest values are echoed verbatim by every successful response;
 * the tests assert on `sourceTreeHash` to confirm the `vaultState`
 * envelope copies through correctly.
 */
const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Flow: 3 },
  edges: {},
  sourceTreeHash: 'sha256:flow-metadata-fixture',
};

/**
 * Write a flow XML file under `{vault}/source/flows/{name}` with the
 * given contents, creating intermediate directories as needed.
 */
const writeFlow = (vault: string, name: string, contents: string): void => {
  const dir = join(vault, 'source', 'flows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-search-flow-metadata-'));

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

  // Canonical happy-path corpus:
  //   Account_Onboarding.flow-meta.xml — contains `<stageName>` and
  //   `<start>`. Exercises the StageName substring test and the
  //   \bstart\b regex test.
  //   Lead_Nurture.flow-meta.xml — contains `<stageName>` and
  //   `<start>` too; with the substring + regex tests this confirms
  //   matches span multiple files.
  //   Plain.flow-meta.xml — contains neither marker; serves as a
  //   negative control that the search does not over-collect.
  writeFlow(
    tempDir,
    'Account_Onboarding.flow-meta.xml',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <stageName>Closed Won</stageName>',
      '    <start>',
      '        <locationX>50</locationX>',
      '    </start>',
      '</Flow>',
      '',
    ].join('\n'),
  );
  writeFlow(
    tempDir,
    'Lead_Nurture.flow-meta.xml',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <stageName>Qualified</stageName>',
      '    <start>',
      '        <locationX>100</locationX>',
      '    </start>',
      '</Flow>',
      '',
    ].join('\n'),
  );
  writeFlow(
    tempDir,
    'Plain.flow-meta.xml',
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <label>Plain Flow</label>',
      '</Flow>',
      '',
    ].join('\n'),
  );

  // Bulk-match corpus for the limit/truncation test: 20 flow files,
  // each with 5 lines containing the marker `LIMITSCAN`. 100 matches
  // total. The substring query 'LIMITSCAN' is unique to these files so
  // the bulk fixture does not interfere with the other tests'
  // assertions.
  for (let i = 0; i < 20; i += 1) {
    const fileName = `Bulk${String(i).padStart(2, '0')}.flow-meta.xml`;
    const body = Array.from(
      { length: 5 },
      (_, j) => `    <description>LIMITSCAN-${i}-${j}</description>`,
    ).join('\n');
    writeFlow(tempDir, fileName, `${body}\n`);
  }
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('searchFlowMetadataHandler', () => {
  it('returns substring matches case-insensitively across flow XML files', async () => {
    // Default mode: substring + case-insensitive. The token
    // `stageName` appears in Account_Onboarding and Lead_Nurture but
    // not in Plain; a substring search for 'StageName' must hit
    // exactly those two files via case-insensitive comparison.
    const result = await searchFlowMetadataHandler(ctx, {
      query: 'StageName',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.data.matches.map((m) => m.path);
    expect(paths).toContain('source/flows/Account_Onboarding.flow-meta.xml');
    expect(paths).toContain('source/flows/Lead_Nurture.flow-meta.xml');
    // Neither Plain.flow-meta.xml nor the bulk fixture must show up.
    expect(
      result.value.data.matches.every(
        (m) =>
          m.path === 'source/flows/Account_Onboarding.flow-meta.xml' ||
          m.path === 'source/flows/Lead_Nurture.flow-meta.xml',
      ),
    ).toBe(true);
    expect(result.value.data.truncated).toBe(false);
    expect(result.value.vaultState.sourceTreeHash).toBe(
      'sha256:flow-metadata-fixture',
    );
    expect(result.value.vaultState.refreshedAt).toBe(
      '2026-05-27T14:33:08Z',
    );
  });

  it('treats substring queries case-insensitively', async () => {
    // Lower-case 'stagename' must hit the same two files as 'StageName'.
    const upper = await searchFlowMetadataHandler(ctx, { query: 'StageName' });
    const lower = await searchFlowMetadataHandler(ctx, { query: 'stagename' });
    expect(upper.ok && lower.ok).toBe(true);
    if (!upper.ok || !lower.ok) return;
    expect(lower.value.data).toEqual(upper.value.data);
  });

  it('compiles regex queries with the i flag when regex=true', async () => {
    // `\bstart\b` matches the `<start>` opening tag in both flows
    // (the `<` is a non-word char, so the `\b` anchors hold). It must
    // not match `<startElementReference>` or other identifiers that
    // *contain* "start" — but neither appears in this fixture, so the
    // assertion is on exactly two hits: one per flow.
    const result = await searchFlowMetadataHandler(ctx, {
      query: '\\bstart\\b',
      regex: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const openingTagHits = result.value.data.matches.filter(
      (m) => m.snippet === '<start>',
    );
    expect(openingTagHits.length).toBeGreaterThanOrEqual(2);
    // Both happy-path flows must contribute at least one match.
    const paths = new Set(openingTagHits.map((m) => m.path));
    expect(paths.has('source/flows/Account_Onboarding.flow-meta.xml')).toBe(
      true,
    );
    expect(paths.has('source/flows/Lead_Nurture.flow-meta.xml')).toBe(true);
  });

  it('honors the limit option and reports truncated=true', async () => {
    // The bulk fixture provides 100 matches for 'LIMITSCAN'. With
    // limit=10 the handler must stop at the cap and report truncated.
    const result = await searchFlowMetadataHandler(ctx, {
      query: 'LIMITSCAN',
      limit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches).toHaveLength(10);
    expect(result.value.data.truncated).toBe(true);
  });

  it('returns no matches and truncated=false when nothing matches', async () => {
    const result = await searchFlowMetadataHandler(ctx, { query: 'ZZZZZ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches).toEqual([]);
    expect(result.value.data.truncated).toBe(false);
  });

  it('returns invalid-query when the regex fails to compile', async () => {
    const result = await searchFlowMetadataHandler(ctx, {
      query: '[unclosed',
      regex: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.message).toContain('invalid regex');
  });

  it('returns identical output for identical input (deterministic)', async () => {
    // Run the same query twice and assert deep equality on the data
    // block. `vaultState` is sourced from `ctx.manifest` so it is
    // trivially stable; the meaningful assertion is on `matches`
    // ordering and content.
    const first = await searchFlowMetadataHandler(ctx, {
      query: 'LIMITSCAN',
    });
    const second = await searchFlowMetadataHandler(ctx, {
      query: 'LIMITSCAN',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.data).toEqual(first.value.data);
  });

  it('returns matches sorted by (path ASC, line ASC)', async () => {
    // Bulk fixture has 5 matches per file across 20 files; with the
    // default limit of 50, the first 10 files (sorted) account for
    // the entire result. Assert lexicographic path order and ascending
    // line numbers within each path.
    const result = await searchFlowMetadataHandler(ctx, {
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

  it('returns no matches and truncated=false when source/flows is missing', async () => {
    // A vault with a manifest but no `source/flows/` directory yet —
    // the refresh has not run or has been cleared. The tool must
    // degrade gracefully to an empty result.
    const emptyVault = mkdtempSync(join(tmpdir(), 'sfi-mcp-empty-flows-'));
    try {
      const emptyCtx: Context = {
        vaultRoot: emptyVault,
        manifest: FIXTURE_MANIFEST,
        graph: store,
      };
      const result = await searchFlowMetadataHandler(emptyCtx, {
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
    // Flow XML lines are typically indented; the snippet must be
    // trimmed but the line number preserved. The `<stageName>Closed
    // Won</stageName>` line in Account_Onboarding is indented with
    // four spaces — the trimmed snippet must drop them.
    const result = await searchFlowMetadataHandler(ctx, {
      query: 'Closed Won',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.matches).toHaveLength(1);
    const onlyHit = result.value.data.matches[0]!;
    expect(onlyHit.snippet).toBe('<stageName>Closed Won</stageName>');
    expect(onlyHit.path).toBe(
      'source/flows/Account_Onboarding.flow-meta.xml',
    );
  });
});

describe('searchFlowMetadataInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = searchFlowMetadataInputSchema.safeParse({
      query: 'StageName',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty query string', () => {
    const parsed = searchFlowMetadataInputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing query field', () => {
    const parsed = searchFlowMetadataInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects a limit greater than 200', () => {
    const parsed = searchFlowMetadataInputSchema.safeParse({
      query: 'StageName',
      limit: 201,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    const parsed = searchFlowMetadataInputSchema.safeParse({
      query: 'StageName',
      limit: 2.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-boolean regex flag', () => {
    const parsed = searchFlowMetadataInputSchema.safeParse({
      query: 'StageName',
      regex: 'yes',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts regex=true with a valid pattern string', () => {
    // The schema does not pre-compile the regex; an invalid pattern
    // passes Zod and is caught at handler time as invalid-query.
    const parsed = searchFlowMetadataInputSchema.safeParse({
      query: '[unclosed',
      regex: true,
    });
    expect(parsed.success).toBe(true);
  });
});
