/// <reference types="vitest/globals" />

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

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

  // CR-06: new input combinations that were previously rejected.
  it('CR-06: accepts summarize=true without a query', () => {
    expect(
      searchFlowMetadataInputSchema.safeParse({ summarize: true }).success,
    ).toBe(true);
  });

  it('CR-06: accepts summarize=true combined with a query', () => {
    expect(
      searchFlowMetadataInputSchema.safeParse({
        summarize: true,
        query: 'Active',
      }).success,
    ).toBe(true);
  });

  it('CR-06: accepts triggerObject alone (with summarize=true)', () => {
    expect(
      searchFlowMetadataInputSchema.safeParse({
        summarize: true,
        triggerObject: 'Account',
      }).success,
    ).toBe(true);
  });

  it('CR-06: still rejects an empty object (no query AND no summarize)', () => {
    expect(searchFlowMetadataInputSchema.safeParse({}).success).toBe(false);
  });
});

// =============================================================================
// CR-06: summarize mode + triggerObject filter
// Uses a self-contained temp vault so these tests are independent of the
// shared fixture (which has no <status> elements in its flows).
// =============================================================================
const makeObjectNode = (id: string): Node => ({
  id,
  type: 'CustomObject',
  apiName: id.slice('CustomObject:'.length),
  label: null,
  parentId: null,
  sourcePath: 'unused.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

/** The three objects the CR-06 flow corpus declares in its `<object>` tags. */
const OBJECT_SEED: ExtractionResult = {
  nodes: [
    makeObjectNode('CustomObject:Account'),
    makeObjectNode('CustomObject:Contact'),
    makeObjectNode('CustomObject:Opportunity'),
  ],
  edges: [],
};

describe('searchFlowMetadataHandler — CR-06 summarize + triggerObject', () => {
  let cr06Dir: string;
  let cr06Store: GraphStore;
  let cr06Ctx: Context;

  beforeAll(async () => {
    cr06Dir = mkdtempSync(join(tmpdir(), 'sfi-sfm-cr06-'));
    const opened = await openGraph(join(cr06Dir, 'unused.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    cr06Store = opened.value;
    // R4: `triggerObject` is now VERIFIED against the vault before it is used,
    // so the object nodes the corpus references must exist in the graph. Note
    // the vault spells the object `Account` — the wrong-case test below passes
    // `account` and must still get the Account answer.
    const imported = await importExtractionResults(cr06Store, [OBJECT_SEED]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    cr06Ctx = { vaultRoot: cr06Dir, manifest: FIXTURE_MANIFEST, graph: cr06Store };

    // Helper: write a flow with a given <status> and optional <object>.
    const writeStatusFlow = (name: string, status: string, object?: string): void => {
      const dir = join(cr06Dir, 'source', 'flows');
      mkdirSync(dir, { recursive: true });
      const objectXml = object !== undefined ? `    <object>${object}</object>\n` : '';
      writeFileSync(
        join(dir, name),
        `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <status>${status}</status>\n${objectXml}</Flow>\n`,
      );
    };

    // Corpus:
    //   3 Active flows (2 on Account, 1 on Contact)
    //   2 Obsolete flows (1 on Account)
    //   1 Draft flow (on Opportunity)
    //   1 flow with no <status> element (counts as "other")
    writeStatusFlow('Act_Flow_A.flow-meta.xml', 'Active', 'Account');
    writeStatusFlow('Act_Flow_B.flow-meta.xml', 'Active', 'Account');
    writeStatusFlow('Act_Flow_C.flow-meta.xml', 'Active', 'Contact');
    writeStatusFlow('Obs_Flow_A.flow-meta.xml', 'Obsolete', 'Account');
    writeStatusFlow('Obs_Flow_B.flow-meta.xml', 'Obsolete');
    writeStatusFlow('Draft_Flow.flow-meta.xml', 'Draft', 'Opportunity');
    // No <status> tag — counts as "other"
    const noStatusDir = join(cr06Dir, 'source', 'flows');
    writeFileSync(
      join(noStatusDir, 'NoStatus_Flow.flow-meta.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <label>No status</label>\n</Flow>\n',
    );
  });

  afterAll(async () => {
    await closeGraph(cr06Store);
    rmSync(cr06Dir, { recursive: true, force: true });
  });

  it('CR-06 fail-before: {summarize:true} would have been rejected by the old schema (no query)', () => {
    // The OLD schema required query to be present; the new refine allows
    // summarize:true with no query. This test verifies the schema ACCEPTS it
    // (the fail-before assertion is: the old schema would have returned
    // parsed.success === false for {}; after the fix it returns true for
    // {summarize:true}).
    const parsed = searchFlowMetadataInputSchema.safeParse({ summarize: true });
    expect(parsed.success).toBe(true);
  });

  it('CR-06: summarize=true returns statusSummary with correct totals', async () => {
    const r = await searchFlowMetadataHandler(cr06Ctx, { summarize: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const summary = r.value.data.statusSummary;
    expect(summary).toBeDefined();
    if (summary === undefined) return;
    // 3 Active, 2 Obsolete, 1 Draft, 0 InvalidDraft, 1 other (no status tag), total 7.
    expect(summary.Active).toBe(3);
    expect(summary.Obsolete).toBe(2);
    expect(summary.Draft).toBe(1);
    expect(summary.InvalidDraft).toBe(0);
    expect(summary.other).toBe(1);
    expect(summary.total).toBe(7);
    // No query → no line matches.
    expect(r.value.data.matches).toHaveLength(0);
    expect(r.value.data.truncated).toBe(false);
  });

  it('CR-06: summarize=true with triggerObject=Account counts only Account flows', async () => {
    const r = await searchFlowMetadataHandler(cr06Ctx, {
      summarize: true,
      triggerObject: 'Account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const summary = r.value.data.statusSummary;
    expect(summary).toBeDefined();
    if (summary === undefined) return;
    // 2 Active on Account, 1 Obsolete on Account — total 3.
    expect(summary.Active).toBe(2);
    expect(summary.Obsolete).toBe(1);
    expect(summary.Draft).toBe(0);
    expect(summary.total).toBe(3);
  });

  it('CR-06: summarize=true plus query returns both summary and line matches', async () => {
    const r = await searchFlowMetadataHandler(cr06Ctx, {
      summarize: true,
      query: '<status>Active</status>',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Summary is present.
    expect(r.value.data.statusSummary).toBeDefined();
    // And line matches are also present (3 Active flows, 1 match per file).
    expect(r.value.data.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('CR-06: triggerObject filters line matches too (query + triggerObject)', async () => {
    const r = await searchFlowMetadataHandler(cr06Ctx, {
      query: 'status',
      triggerObject: 'Opportunity',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only Draft_Flow has <object>Opportunity</object>; only its status line matches.
    expect(r.value.data.matches.every((m) => m.path.includes('Draft_Flow'))).toBe(true);
    expect(r.value.data.matches.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// R4 — SEARCH-FLOW-METADATA-TRUSTS-AN-UNVERIFIED-TRIGGEROBJECT
// `triggerObject` was string-templated straight into a CASE-SENSITIVE regex and
// never checked against the vault, so a wrong-case name, a typo, and a
// regex-shaped value each produced a confident answer about the wrong set of
// flows: `{Active: 0, ..., total: 0}` reads identically to a checked
// "this object has no flows at all".
// =============================================================================
describe('searchFlowMetadataHandler — R4 triggerObject scope resolution', () => {
  let r4Dir: string;
  let r4Store: GraphStore;
  let r4Ctx: Context;

  beforeAll(async () => {
    r4Dir = mkdtempSync(join(tmpdir(), 'sfi-sfm-r4-'));
    const opened = await openGraph(join(r4Dir, 'unused.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    r4Store = opened.value;
    const imported = await importExtractionResults(r4Store, [OBJECT_SEED]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    r4Ctx = { vaultRoot: r4Dir, manifest: FIXTURE_MANIFEST, graph: r4Store };

    const dir = join(r4Dir, 'source', 'flows');
    mkdirSync(dir, { recursive: true });
    const write = (name: string, status: string, object: string): void => {
      writeFileSync(
        join(dir, name),
        `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <status>${status}</status>\n    <object>${object}</object>\n</Flow>\n`,
      );
    };
    // The vault spells the object with its canonical Salesforce casing.
    write('Acc_One.flow-meta.xml', 'Active', 'Account');
    write('Acc_Two.flow-meta.xml', 'Active', 'Account');
    write('Acc_Three.flow-meta.xml', 'Obsolete', 'Account');
    write('Con_One.flow-meta.xml', 'Active', 'Contact');
  });

  afterAll(async () => {
    await closeGraph(r4Store);
    rmSync(r4Dir, { recursive: true, force: true });
  });

  it('WRONG CASE: `account` must answer about Account, not report a confident zero', async () => {
    const r = await searchFlowMetadataHandler(r4Ctx, {
      summarize: true,
      triggerObject: 'account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const summary = r.value.data.statusSummary;
    expect(summary).toBeDefined();
    if (summary === undefined) return;
    // Salesforce api names are case-insensitive: `account` names Account.
    expect(summary.total).toBe(3);
    expect(summary.Active).toBe(2);
    expect(summary.Obsolete).toBe(1);
  });

  it('TYPO: an object absent from the vault is REFUSED, never answered with total 0', async () => {
    const r = await searchFlowMetadataHandler(r4Ctx, {
      summarize: true,
      triggerObject: 'Acount',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Acount');
  });

  it('METACHARACTERS: a regex-shaped triggerObject cannot silently over-match', async () => {
    const r = await searchFlowMetadataHandler(r4Ctx, {
      summarize: true,
      triggerObject: 'Account|Contact',
    });
    // Whatever the tool does, it must NOT quietly answer for BOTH objects as
    // though the caller had named one.
    if (r.ok) {
      expect(r.value.data.statusSummary?.total).not.toBe(4);
    } else {
      expect(r.error.kind).toBe('invalid-query');
    }
  });

  it('appliedScope: a scoped call echoes the canonical object id; a bare call omits it', async () => {
    const scoped = await searchFlowMetadataHandler(r4Ctx, {
      summarize: true,
      triggerObject: 'account',
    });
    const bare = await searchFlowMetadataHandler(r4Ctx, { summarize: true });
    expect(scoped.ok && bare.ok).toBe(true);
    if (!scoped.ok || !bare.ok) return;
    expect(scoped.value.data.appliedScope).toEqual({
      object: 'CustomObject:Account',
      mode: 'component',
    });
    expect('appliedScope' in bare.value.data).toBe(false);
  });
});

// =============================================================================
// R1 — SEARCH-FLOW-METADATA-SWALLOWS-UNREADABLE-FILES
// A flow file that fails to read was `continue`d: it contributed to nothing —
// not `statusSummary.total`, not `matches`, not any error or disclosure — so a
// partial tally was presented as the org's complete flow status.
// =============================================================================
describe('searchFlowMetadataHandler — R1 unreadable flow files', () => {
  let r1Dir: string;
  let r1Store: GraphStore;
  let r1Ctx: Context;
  let lockedPath: string;

  beforeAll(async () => {
    r1Dir = mkdtempSync(join(tmpdir(), 'sfi-sfm-r1-'));
    const opened = await openGraph(join(r1Dir, 'unused.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    r1Store = opened.value;
    r1Ctx = { vaultRoot: r1Dir, manifest: FIXTURE_MANIFEST, graph: r1Store };

    const dir = join(r1Dir, 'source', 'flows');
    mkdirSync(dir, { recursive: true });
    const body = (status: string): string =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n    <status>${status}</status>\n</Flow>\n`;
    writeFileSync(join(dir, 'Readable_A.flow-meta.xml'), body('Active'));
    writeFileSync(join(dir, 'Readable_B.flow-meta.xml'), body('Obsolete'));
    // A file that `stat`s as a regular file (so it IS collected) but cannot be
    // opened — the permissions / truncated-refresh / broken-mount case.
    lockedPath = join(dir, 'Unreadable_C.flow-meta.xml');
    writeFileSync(lockedPath, body('Active'));
    chmodSync(lockedPath, 0o000);
  });

  afterAll(async () => {
    chmodSync(lockedPath, 0o644);
    await closeGraph(r1Store);
    rmSync(r1Dir, { recursive: true, force: true });
  });

  it('DISCLOSES the unreadable file rather than dropping it from the tally in silence', async () => {
    const r = await searchFlowMetadataHandler(r1Ctx, { summarize: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    // The two readable files are tallied.
    expect(data.statusSummary?.total).toBe(2);
    // And the third is NAMED as never opened.
    expect(data.filesFound).toBe(3);
    expect(data.filesUnreadable).toBe(1);
    expect(data.unreadablePaths).toEqual([
      'source/flows/Unreadable_C.flow-meta.xml',
    ]);
    expect(data.coverageNote).toBeDefined();
    expect(data.coverageNote ?? '').toMatch(/not checked/i);
  });

  it('a fully readable vault reports zero unreadable files and NO coverage note', async () => {
    const r = await searchFlowMetadataHandler(ctx, { summarize: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.filesUnreadable).toBe(0);
    expect(r.value.data.unreadablePaths).toEqual([]);
    expect(r.value.data.coverageNote).toBeUndefined();
  });

  it('summarize-only mode does not present `matches: []` as a checked-empty search', async () => {
    const summaryOnly = await searchFlowMetadataHandler(r1Ctx, { summarize: true });
    const searched = await searchFlowMetadataHandler(r1Ctx, {
      summarize: true,
      query: 'status',
    });
    expect(summaryOnly.ok && searched.ok).toBe(true);
    if (!summaryOnly.ok || !searched.ok) return;
    // No query was supplied, so no line search ran — `matches: []` must not be
    // readable as "searched and found nothing".
    expect(summaryOnly.value.data.searched).toBe(false);
    expect(searched.value.data.searched).toBe(true);
  });
});
