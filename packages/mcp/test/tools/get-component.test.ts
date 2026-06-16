/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
import { componentPath } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import {
  getComponentHandler,
  getComponentInputSchema,
} from '../../src/tools/get-component.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1, CustomField: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: 'Account',
  parentId: null,
  sourcePath: 'objects/Account/Account.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'CustomObject:Account',
      apiName: 'Account',
      label: 'Account',
    }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
    }),
    // Used by the file-missing test: the graph knows the node but no
    // markdown was rendered for it.
    makeNode({
      id: 'CustomObject:Orphan',
      apiName: 'Orphan',
      label: 'Orphan',
    }),
    // Used by the malformed-frontmatter test.
    makeNode({
      id: 'CustomObject:Malformed',
      apiName: 'Malformed',
      label: 'Malformed',
    }),
    // Used by the nested-dashes test.
    makeNode({
      id: 'CustomObject:Nested',
      apiName: 'Nested',
      label: 'Nested',
    }),
    // Used by the bounded-body regression test.
    makeNode({
      id: 'Profile:LargeProfile',
      type: 'Profile',
      apiName: 'LargeProfile',
      label: 'Large Profile',
      sourcePath: 'profiles/LargeProfile.profile-meta.xml',
    }),
  ],
  edges: [],
};

const writeMarkdown = (vaultRoot: string, node: Node, raw: string): string => {
  const parentApiName =
    node.parentId === null ? null : node.parentId.split(':')[1] ?? null;
  const full = componentPath(vaultRoot, node.type, parentApiName, node.apiName);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, raw);
  return full;
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-get-component-'));
  const dbPath = join(tempDir, 'get-component.db');
  const opened = await openGraph(dbPath);
  if (!opened.ok) {
    throw new Error(`openGraph failed: ${opened.error.message}`);
  }
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };

  // Happy-path file: CustomObject:Account.
  writeMarkdown(
    tempDir,
    seed.nodes[0]!,
    [
      '---',
      'id: CustomObject:Account',
      'type: CustomObject',
      'apiName: Account',
      '---',
      '',
      '# Account',
      '',
      'Top-level body content for the canonical fixture.',
      '',
    ].join('\n'),
  );

  // Malformed-frontmatter file: no `---` delimiters at all.
  writeMarkdown(
    tempDir,
    seed.nodes[3]!,
    '# Malformed\n\nThis file has no frontmatter delimiters.\n',
  );

  // Nested-dashes file: body contains a markdown horizontal rule on its
  // own line; the parser must end frontmatter at the first `\n---\n` and
  // leave the second one inside the body.
  writeMarkdown(
    tempDir,
    seed.nodes[4]!,
    [
      '---',
      'id: CustomObject:Nested',
      'type: CustomObject',
      '---',
      '',
      '# Nested',
      '',
      'Before the rule.',
      '',
      '---',
      '',
      'After the rule.',
      '',
    ].join('\n'),
  );

  writeMarkdown(
    tempDir,
    seed.nodes[5]!,
    [
      '---',
      'id: Profile:LargeProfile',
      'type: Profile',
      '---',
      '',
      '# Large Profile',
      '',
      'x'.repeat(50_000),
      '',
    ].join('\n'),
  );

  // Field file, used by the parent-segment path test. Lives next to the
  // happy-path fixture so each test only asserts, never sets up.
  writeMarkdown(
    tempDir,
    seed.nodes[1]!,
    ['---', 'id: CustomField:Account.Industry__c', '---', '', 'Body.', ''].join(
      '\n',
    ),
  );

  // Intentionally do NOT write a file for CustomObject:Orphan; it powers
  // the file-missing scenario.
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('getComponentHandler', () => {
  it('returns ok with frontmatter and body for an existing component', async () => {
    const result = await getComponentHandler(ctx, {
      id: 'CustomObject:Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.id).toBe('CustomObject:Account');
    expect(result.value.data.type).toBe('CustomObject');
    expect(result.value.data.path).toBe('components/CustomObject/Account.md');
    expect(result.value.data.frontmatter).toBe(
      'id: CustomObject:Account\ntype: CustomObject\napiName: Account',
    );
    expect(result.value.data.body).toBe(
      '# Account\n\nTop-level body content for the canonical fixture.\n',
    );
    // Vault state echoes the manifest verbatim so callers can diff.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
    expect(result.value.vaultState.refreshedAt).toBe('2026-05-27T14:33:08Z');
    // No annotations file → no block (annotation-free vaults byte-identical).
    expect('annotations' in result.value.data).toBe(false);
  });

  it('embeds the curated annotations block with provenance `annotation` when the subject has one (P13-ANNOT-tools)', async () => {
    const { appendAnnotationEvent } = await import('@sf-intelligence/vault');
    await appendAnnotationEvent(ctx.vaultRoot, {
      componentId: 'CustomObject:Account',
      key: 'owner',
      value: 'RevOps',
      author: 'pranav',
      source: 'human',
      confirmed: true,
      at: '2026-06-10T00:00:00.000Z',
      op: 'set',
    });
    try {
      const result = await getComponentHandler(ctx, { id: 'CustomObject:Account' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.annotations?.provenance).toBe('annotation');
      expect(result.value.data.annotations?.entries.map((e) => e.value)).toEqual(['RevOps']);
      expect(result.value.data.annotations?.disclosure).toContain('CURATED');
    } finally {
      rmSync(join(ctx.vaultRoot, 'meta', 'annotations.jsonl'), { force: true });
    }
  });

  it('returns component-not-found when the id is not in the graph', async () => {
    const result = await getComponentHandler(ctx, {
      id: 'CustomObject:DoesNotExist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.path).toBe('CustomObject:DoesNotExist');
    // A genuinely-unknown id (no inbound references) gets the plain message,
    // NOT the phantom disclosure.
    expect(result.error.message).not.toMatch(/referenced by/);
  });

  it('discloses a PHANTOM (referenced-but-not-retrieved) id instead of a silent not-found (B29)', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-getcomp-phantom-'));
    const opened = await openGraph(join(localDir, 'phantom.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    // A permission set grants an object whose own definition was never pulled
    // (managed-package / out-of-scope): the grant edge exists, the node does not.
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'PermissionSet:Granter',
            type: 'PermissionSet',
            apiName: 'Granter',
          }),
        ],
        edges: [
          {
            fromId: 'PermissionSet:Granter',
            toId: 'CustomObject:ManagedPkg__Thing__c',
            edgeType: 'grantedBy',
            confidence: 'declared',
            source: 'unit-test',
            properties: { targetMissing: true },
          },
        ],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await getComponentHandler(localCtx, {
      id: 'CustomObject:ManagedPkg__Thing__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    // Honest phantom disclosure: names the inbound references + the
    // not-retrieved reason, instead of a silent "doesn't exist".
    expect(r.error.message).toMatch(/referenced by 1 other component/);
    expect(r.error.message).toMatch(/never retrieved/);
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('queues an AUTOMATION-CRITICAL phantom hit in meta/demand-queue.jsonl — and only that class (P13-STAGED-demand-queue)', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-getcomp-queue-'));
    const opened = await openGraph(join(localDir, 'phantom.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({ id: 'ApexTrigger:AcmeTrig', type: 'ApexTrigger', apiName: 'AcmeTrig' }),
          makeNode({ id: 'PermissionSet:Granter', type: 'PermissionSet', apiName: 'Granter' }),
        ],
        edges: [
          // automation-critical: a DECLARED functional edge to a missing object
          {
            fromId: 'ApexTrigger:AcmeTrig',
            toId: 'CustomObject:Acme_Auto__c',
            edgeType: 'triggersOn',
            confidence: 'declared',
            source: 'unit-test',
            properties: { targetMissing: true },
          },
          // grant-only: must NOT be queued
          {
            fromId: 'PermissionSet:Granter',
            toId: 'CustomObject:GrantOnly__c',
            edgeType: 'grantedBy',
            confidence: 'declared',
            source: 'unit-test',
            properties: { targetMissing: true },
          },
        ],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: {
        ...FIXTURE_MANIFEST,
        // classifyPhantom needs CustomObject coverage = covered for the
        // automation-critical (vs blindspot-manifest) classification.
        coverage: [
          { type: 'CustomObject', requested: true, retrieved: 5, errored: false, neverModeled: false },
        ],
      },
      graph: localStore,
    };

    const auto = await getComponentHandler(localCtx, { id: 'CustomObject:Acme_Auto__c' });
    expect(auto.ok).toBe(false);
    const grant = await getComponentHandler(localCtx, { id: 'CustomObject:GrantOnly__c' });
    expect(grant.ok).toBe(false);
    // hit it twice — dedup at read time, hits counted
    const again = await getComponentHandler(localCtx, { id: 'CustomObject:Acme_Auto__c' });
    expect(again.ok).toBe(false);

    const { readDemandQueue } = await import('@sf-intelligence/vault');
    const queue = await readDemandQueue(localDir);
    expect(queue.length).toBe(1); // grant-only NOT queued
    expect(queue[0]?.id).toBe('CustomObject:Acme_Auto__c');
    expect(queue[0]?.classification).toBe('automation-critical');
    expect(queue[0]?.status).toBe('queued');
    expect(queue[0]?.hits).toBe(2);
    expect(queue[0]?.sources).toEqual(['get_component']);

    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('returns component-not-found with vault-file-missing when the markdown is absent', async () => {
    const result = await getComponentHandler(ctx, {
      id: 'CustomObject:Orphan',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
    expect(result.error.message).toBe('vault file missing');
    expect(result.error.path).toBe('components/CustomObject/Orphan.md');
  });

  it('returns internal when the markdown lacks frontmatter delimiters', async () => {
    const result = await getComponentHandler(ctx, {
      id: 'CustomObject:Malformed',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    expect(result.error.message).toContain('malformed frontmatter');
    expect(result.error.path).toBe('components/CustomObject/Malformed.md');
  });

  it('treats nested --- lines inside the body as body content, not frontmatter', async () => {
    const result = await getComponentHandler(ctx, {
      id: 'CustomObject:Nested',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Frontmatter ends at the FIRST `\n---\n` after the opening; the
    // horizontal rule on its own line lives inside the body.
    expect(result.value.data.frontmatter).toBe(
      'id: CustomObject:Nested\ntype: CustomObject',
    );
    expect(result.value.data.body).toContain('Before the rule.');
    expect(result.value.data.body).toContain('---');
    expect(result.value.data.body).toContain('After the rule.');
  });

  it('resolves CustomField paths through the parent-segment branch of componentPath', async () => {
    // Sanity check for nodes with parentId: the resolver must include the
    // parent's apiName in the on-disk path layout.
    const result = await getComponentHandler(ctx, {
      id: 'CustomField:Account.Industry__c',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.path).toBe(
      'components/CustomField/Account/Industry__c.md',
    );
    expect(result.value.data.type).toBe('CustomField');
  });

  it('bounds large component bodies and reports truncation metadata', async () => {
    const result = await getComponentHandler(ctx, {
      id: 'Profile:LargeProfile',
      maxBodyBytes: 128,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.body).toHaveLength(128);
    expect(result.value.data.bodyTruncated).toBe(true);
    expect(result.value.data.bodyBytes).toBeGreaterThan(50_000);
    expect(result.value.data.returnedBodyBytes).toBe(128);
    expect(result.value.data.omittedBodyBytes).toBe(
      result.value.data.bodyBytes - 128,
    );
    expect(result.value.data.maxBodyBytes).toBe(128);
  });
});

describe('getComponentInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    const parsed = getComponentInputSchema.safeParse({
      id: 'CustomObject:Account',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts componentId as an alias for id', () => {
    const parsed = getComponentInputSchema.safeParse({
      componentId: 'CustomObject:Account',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.id).toBe('CustomObject:Account');
    }
  });

  it('accepts an optional maxBodyBytes cap', () => {
    const parsed = getComponentInputSchema.safeParse({
      id: 'Profile:LargeProfile',
      maxBodyBytes: 128,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty id string', () => {
    const parsed = getComponentInputSchema.safeParse({ id: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing id field', () => {
    const parsed = getComponentInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('rejects maxBodyBytes above the response-safe ceiling', () => {
    const parsed = getComponentInputSchema.safeParse({
      id: 'Profile:LargeProfile',
      maxBodyBytes: 30_001,
    });
    expect(parsed.success).toBe(false);
  });
});
