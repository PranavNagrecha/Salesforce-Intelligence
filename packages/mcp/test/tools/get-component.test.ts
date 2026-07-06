/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  Edge,
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

/**
 * Real-org-shape ValidationRule fixture. Properties match the structure
 * emitted by the validation-rule extractor (active, errorConditionFormula,
 * conditions with fieldRefs, errorMessage, errorDisplayField). Neutral names —
 * no real org tokens.
 */
const VALIDATION_RULE_PROPERTIES = {
  active: true,
  errorConditionFormula: 'End_Time__c < Start_Time__c',
  errorDisplayField: 'CustomField:TestObj__c.End_Time__c',
  errorMessage: 'End time must be after start time.',
  description: 'Validates that end time is after start time.',
  conditions: [
    {
      conditionContextId:
        'ConditionalContext:ValidationRule:TestObj__c.EndAfterStart.condition-0',
      expression: 'End_Time__c < Start_Time__c',
      kind: 'formula',
      fieldRefs: [
        'CustomField:TestObj__c.End_Time__c',
        'CustomField:TestObj__c.Start_Time__c',
      ],
    },
  ],
};

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
    // Used by the structured-grounding (u6) test: a ValidationRule with real-
    // org-shape properties and outgoing references edges.
    makeNode({
      id: 'ValidationRule:TestObj__c.EndAfterStart',
      type: 'ValidationRule',
      apiName: 'EndAfterStart',
      label: 'EndAfterStart',
      parentId: 'CustomObject:TestObj__c',
      sourcePath:
        'objects/TestObj__c/validationRules/EndAfterStart.validationRule-meta.xml',
      properties: VALIDATION_RULE_PROPERTIES,
    }),
    // Referenced field nodes (needed so listEdges returns real target ids).
    makeNode({
      id: 'CustomField:TestObj__c.End_Time__c',
      type: 'CustomField',
      apiName: 'End_Time__c',
      label: 'End Time',
      parentId: 'CustomObject:TestObj__c',
      sourcePath: 'objects/TestObj__c/fields/End_Time__c.field-meta.xml',
    }),
    makeNode({
      id: 'CustomField:TestObj__c.Start_Time__c',
      type: 'CustomField',
      apiName: 'Start_Time__c',
      label: 'Start Time',
      parentId: 'CustomObject:TestObj__c',
      sourcePath: 'objects/TestObj__c/fields/Start_Time__c.field-meta.xml',
    }),
  ],
  edges: [
    // ValidationRule → CustomField references (formula-tokenizer edges)
    {
      fromId: 'ValidationRule:TestObj__c.EndAfterStart',
      toId: 'CustomField:TestObj__c.End_Time__c',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: {},
    } as Edge,
    {
      fromId: 'ValidationRule:TestObj__c.EndAfterStart',
      toId: 'CustomField:TestObj__c.Start_Time__c',
      edgeType: 'references',
      confidence: 'parsed',
      source: 'formula-tokenizer',
      properties: {},
    } as Edge,
  ],
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

  // ValidationRule fixture for u6-structured-grounding test. Uses real-org-shape
  // frontmatter (active, errorConditionFormula, conditions, errorMessage) and
  // outgoing `references` edges to two CustomFields. Node index 6 in the seed.
  writeMarkdown(
    tempDir,
    seed.nodes[6]!,
    [
      '---',
      'apiName: EndAfterStart',
      'id: ValidationRule:TestObj__c.EndAfterStart',
      'parentId: CustomObject:TestObj__c',
      'properties:',
      '  active: true',
      '  errorConditionFormula: End_Time__c < Start_Time__c',
      '  errorDisplayField: CustomField:TestObj__c.End_Time__c',
      '  errorMessage: End time must be after start time.',
      '  description: Validates that end time is after start time.',
      '  conditions:',
      '    - conditionContextId: ConditionalContext:ValidationRule:TestObj__c.EndAfterStart.condition-0',
      '      expression: End_Time__c < Start_Time__c',
      '      kind: formula',
      '      fieldRefs:',
      '        - CustomField:TestObj__c.End_Time__c',
      '        - CustomField:TestObj__c.Start_Time__c',
      'type: ValidationRule',
      '---',
      '',
      '# EndAfterStart',
      '',
      '**Type:** ValidationRule',
      '',
      'Validates that end time is after start time.',
      '',
      '## References (outgoing, 2)',
      '',
      '| Target | Confidence |',
      '| --- | --- |',
      '| `CustomField:TestObj__c.End_Time__c` | parsed |',
      '| `CustomField:TestObj__c.Start_Time__c` | parsed |',
      '',
    ].join('\n'),
  );
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

  it('renders Profile loginIpRanges structurally and respects the body size limit', async () => {
    // A Profile whose graph node carries `loginIpRanges` (the profile-extractor
    // shape) must surface those ranges as structured `data.properties` while a
    // large rendered body is still bounded by `maxBodyBytes`.
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-getcomp-iprange-'));
    const opened = await openGraph(join(localDir, 'iprange.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;

    const loginIpRanges = [
      { startAddress: '10.0.0.1', endAddress: '10.0.0.255' },
      { startAddress: '192.168.1.0', endAddress: '192.168.1.255' },
    ];
    const profileNode = makeNode({
      id: 'Profile:IpRestricted',
      type: 'Profile',
      apiName: 'IpRestricted',
      label: 'IP Restricted',
      sourcePath: 'profiles/IpRestricted.profile-meta.xml',
      properties: {
        loginIpRanges,
        userPermissions: ['ActivateContracts', 'AllowUniversalSearch'],
      },
    });
    const imp = await importExtractionResults(localStore, [
      { nodes: [profileNode], edges: [] },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };

    // Render a body that exceeds the cap so truncation metadata is exercised.
    const largeBody = 'x'.repeat(25_000);
    writeMarkdown(
      localDir,
      profileNode,
      [
        '---',
        'id: Profile:IpRestricted',
        'type: Profile',
        'apiName: IpRestricted',
        '---',
        '',
        '# IP Restricted',
        '',
        largeBody,
        '',
      ].join('\n'),
    );

    const result = await getComponentHandler(localCtx, {
      id: 'Profile:IpRestricted',
      maxBodyBytes: 5_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      await closeGraph(localStore);
      rmSync(localDir, { recursive: true, force: true });
      return;
    }
    const { data } = result.value;

    // Body was truncated to the cap.
    expect(data.bodyTruncated).toBe(true);
    expect(data.returnedBodyBytes).toBeLessThanOrEqual(5_000);
    expect(data.omittedBodyBytes).toBeGreaterThan(0);
    expect(data.maxBodyBytes).toBe(5_000);

    // loginIpRanges surfaces as the structured array from the graph node
    // (not re-parsed from the truncated YAML string).
    expect(data.properties['loginIpRanges']).toEqual(loginIpRanges);

    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('u6-structured-grounding: ValidationRule returns data.properties with formula and referenceIds as canonical ids (not empty grounding)', async () => {
    // This test verifies the fix for the durable-hardening bug (u6): before
    // the fix, data.properties was absent and data.referenceIds did not exist,
    // so synthesize_answer had no structured facts to ground answers on —
    // resulting in empty grounding + false hallucination flags on real ids.
    // After the fix both fields must be present and populated.
    const result = await getComponentHandler(ctx, {
      id: 'ValidationRule:TestObj__c.EndAfterStart',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data } = result.value;

    // --- Backward-compat: existing string fields must still be present ---
    expect(typeof data.frontmatter).toBe('string');
    expect(data.frontmatter.length).toBeGreaterThan(0);
    expect(typeof data.body).toBe('string');

    // --- NEW: data.properties must be a real object with typed ValidationRule fields ---
    expect(data.properties).toBeDefined();
    expect(typeof data.properties).toBe('object');
    // active flag (boolean in the graph node)
    expect(data.properties['active']).toBe(true);
    // errorConditionFormula must be present as a string value
    expect(typeof data.properties['errorConditionFormula']).toBe('string');
    expect(data.properties['errorConditionFormula']).toContain('End_Time__c');
    // errorMessage must be a string
    expect(typeof data.properties['errorMessage']).toBe('string');
    // description must surface structurally (get_component exposes properties.description
    // so a caller answering "does this component have a description?" reads it directly
    // rather than parsing markdown prose) AND render into the markdown body.
    expect(data.properties['description']).toBe(
      'Validates that end time is after start time.',
    );
    expect(data.body).toContain('Validates that end time is after start time.');

    // --- NEW: data.referenceIds must be canonical component ids (not empty) ---
    expect(Array.isArray(data.referenceIds)).toBe(true);
    expect(data.referenceIds.length).toBe(2);
    // Both referenced field ids must appear (sorted)
    expect(data.referenceIds).toContain('CustomField:TestObj__c.End_Time__c');
    expect(data.referenceIds).toContain('CustomField:TestObj__c.Start_Time__c');
    // Sorted order
    expect(data.referenceIds[0]).toBe('CustomField:TestObj__c.End_Time__c');
    expect(data.referenceIds[1]).toBe('CustomField:TestObj__c.Start_Time__c');
  });

  it('u6-structured-grounding: existing CustomObject returns empty properties and referenceIds without regression', async () => {
    // Regression check: a node with properties:{} and no outgoing edges must
    // return properties as {} and referenceIds as [] — not missing or undefined.
    const result = await getComponentHandler(ctx, {
      id: 'CustomObject:Account',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // properties must be present (may be empty for objects with no typed props)
    expect(result.value.data.properties).toBeDefined();
    expect(typeof result.value.data.properties).toBe('object');
    // referenceIds must be an array (empty for a node with no outgoing edges)
    expect(Array.isArray(result.value.data.referenceIds)).toBe(true);
    // frontmatter still present and byte-identical
    expect(result.value.data.frontmatter).toBe(
      'id: CustomObject:Account\ntype: CustomObject\napiName: Account',
    );
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
