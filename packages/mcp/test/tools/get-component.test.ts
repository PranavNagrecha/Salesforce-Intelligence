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

/**
 * R6-31 fixture: mirrors the real-world shape that broke `maxBodyBytes: 0`
 * — a Profile whose graph node carries thousands of `fieldPermissions`/
 * `objectPermissions` entries alongside a few small scalar fields. The
 * frontmatter written to disk for this node (below) is ALSO oversized on
 * its own, standing in for a large rendered permissions block, so the fix
 * has to bound both `properties` and `frontmatter`, not just `body`.
 */
const HUGE_PROFILE_PROPERTIES = {
  description: 'A profile with many permission grants.',
  userLicense: 'Salesforce',
  custom: false,
  fieldPermissions: Array.from({ length: 1_500 }, (_, i) => ({
    field: `CustomField:TestObj__c.Field_${i}__c`,
    readable: true,
    editable: i % 2 === 0,
  })),
  objectPermissions: Array.from({ length: 500 }, (_, i) => ({
    object: `CustomObject:HugeTarget_${i}__c`,
    allowRead: true,
    allowEdit: false,
    allowCreate: false,
    allowDelete: false,
  })),
};

/** Outgoing `grantedBy` edges from the huge profile — enough to exercise `referenceIds` truncation. */
const HUGE_PROFILE_EDGES: Edge[] = Array.from({ length: 150 }, (_, i) => ({
  fromId: 'Profile:HugeProfile',
  toId: `CustomObject:HugeTarget_${i}__c`,
  edgeType: 'grantedBy',
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
})) as Edge[];

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
    // R6-31 fixture: huge node used by the metadata-probe regression tests.
    makeNode({
      id: 'Profile:HugeProfile',
      type: 'Profile',
      apiName: 'HugeProfile',
      label: 'Huge Profile',
      sourcePath: 'profiles/HugeProfile.profile-meta.xml',
      properties: HUGE_PROFILE_PROPERTIES,
    }),
    // CONDITIONAL-CONTEXT-PHANTOM-COMPONENT: a synthetic, file-less node type.
    // Appended LAST so it never shifts the index-based `writeMarkdown` calls in
    // beforeAll; intentionally gets no file (like CustomObject:Orphan), so
    // get_component must render it on the fly instead of `vault-file-missing`.
    makeNode({
      id: 'ConditionalContext:ValidationRule:TestObj__c.EndAfterStart.condition-0',
      type: 'ConditionalContext',
      apiName: 'ValidationRule:TestObj__c.EndAfterStart.condition-0',
      label: 'EndAfterStart condition-0',
      parentId: 'ValidationRule:TestObj__c.EndAfterStart',
      properties: {
        expression: 'End_Time__c < Start_Time__c',
        kind: 'formula',
      },
    }),
  ],
  edges: [
    ...HUGE_PROFILE_EDGES,
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

  // R6-31 fixture: a HUGE node whose on-disk frontmatter is ALSO oversized
  // (standing in for a real Profile's rendered permissions block — see the
  // real-vault numbers in the handoff). Node index 9 in the seed. Before the
  // fix, `getComponentHandler(ctx, { id, maxBodyBytes: 0 })` on a node like
  // this would still serialize the full frontmatter + full `properties` +
  // full `referenceIds`, which the caller explicitly asked to skip.
  writeMarkdown(
    tempDir,
    seed.nodes[9]!,
    [
      '---',
      'id: Profile:HugeProfile',
      'type: Profile',
      // Stand-in for a large rendered permissions block: real Profile
      // frontmatter for a big org runs tens of KB past the response budget.
      `renderedPermissionsBlob: ${'x'.repeat(60_000)}`,
      '---',
      '',
      '# Huge Profile',
      '',
      'Body content.',
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

  // UNRESOLVED-PROFILE-GET-MISFRAMED-AS-RETRIEVE-GAP: an `UnresolvedProfile:{id}`
  // target minted by a RestrictionRule `<userCriteria>` Profile-Id edge is a
  // DELIBERATE stub — a Profile Id the vault could not resolve to an api name.
  // It must NOT be framed as a manifest blindspot ("widen the retrieve
  // manifest"); its honest remedy is a Profile Id→apiName index / live Tooling.
  // A DIFFERENT referenced-but-missing id still gets the generic
  // widen-manifest remedy, byte-identical — proving the change is scoped.
  it('classifies an UnresolvedProfile-from-RestrictionRule id as unresolved-profile-id and does NOT recommend widening the manifest', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-getcomp-unresprof-'));
    const opened = await openGraph(join(localDir, 'phantom.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    // SYNTHETIC Profile-shaped Id — never a real org Id.
    const synProfileId = '00e000000000000AAA';
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'RestrictionRule:Gate_Access',
            type: 'RestrictionRule',
            apiName: 'Gate_Access',
          }),
        ],
        edges: [
          // The exact shape enterprise-metadata.ts mints for a userCriteria
          // Profile Id: heuristic `references` edge to the UnresolvedProfile
          // stub, provenance carried in properties.referenceKind.
          {
            fromId: 'RestrictionRule:Gate_Access',
            toId: `UnresolvedProfile:${synProfileId}`,
            edgeType: 'references',
            confidence: 'heuristic',
            source: 'unit-test',
            properties: {
              referenceKind: 'restrictionUserProfileUnresolved',
              unresolvedProfileId: synProfileId,
              idBasedTarget: true,
            },
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
      id: `UnresolvedProfile:${synProfileId}`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    const stub = r.error.stub;
    expect(stub).toBeDefined();
    if (stub === undefined) return;
    // Classified as an unresolved Profile Id — NOT blindspot-manifest.
    expect(stub.classification).toBe('unresolved-profile-id');
    expect(stub.demandRetrievable).toBe(false);
    // Honest remedy: points at the Id→apiName enrichment path.
    expect(stub.remedy).toMatch(/Id→apiName/);
    expect(stub.remedy).toMatch(/Tooling API/);
    // Must NOT emit the generic blindspot "Widen the retrieve manifest" remedy.
    expect(stub.remedy).not.toMatch(/Widen the retrieve manifest/);
    // UNRESOLVED-PROFILE-GET-MISFRAMED-AS-RETRIEVE-GAP (real-vault gap): the
    // PRIMARY human-facing `message` — the field a host reads first — must ALSO
    // avoid the generic retrieve-widen / managed-package framing, not just the
    // structured `stub.remedy`. On the real vault the stub was correct while the
    // message still said "typically a managed-package component … Run `sfi
    // refresh`". Lock the message to the Id-enrichment framing here.
    expect(r.error.message).toMatch(/Profile Id/);
    expect(r.error.message).toMatch(/could not resolve to a Profile api name/);
    expect(r.error.message).toMatch(/Id→apiName/);
    expect(r.error.message).not.toMatch(/managed-package component or one outside the retrieve scope/);
    expect(r.error.message).not.toMatch(/if it should be retrievable/);

    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('keeps the generic widen-manifest remedy byte-identical for a different referenced-but-missing id', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-getcomp-blindspot-'));
    const opened = await openGraph(join(localDir, 'phantom.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    // A genuinely retrievable-but-not-retrieved component (its ComponentType
    // has no manifest coverage entry → 'absent' → blindspot-manifest).
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'Flow:Order_Router',
            type: 'Flow',
            apiName: 'Order_Router',
          }),
        ],
        edges: [
          {
            fromId: 'Flow:Order_Router',
            toId: 'CustomObject:PlainMissing__c',
            edgeType: 'references',
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
      id: 'CustomObject:PlainMissing__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const stub = r.error.stub;
    expect(stub).toBeDefined();
    if (stub === undefined) return;
    expect(stub.classification).toBe('blindspot-manifest');
    // Byte-identical to the pre-change generic remedy.
    expect(stub.remedy).toBe(
      'Its ComponentType was never retrieved (a manifest gap). Widen the retrieve manifest and run /sfi-refresh; see sfi.retrieve_blindspot_report.',
    );
    // The message override is scoped ONLY to `unresolved-profile-id`: every
    // other referenced-but-missing id keeps the generic phantom message
    // verbatim (the retrieve-widen framing is correct for a genuine manifest
    // gap like this one).
    expect(r.error.message).toMatch(
      /typically a managed-package component or one outside the retrieve scope/,
    );
    expect(r.error.message).toMatch(/Run `sfi refresh` if it should/);

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

  it('renders a file-less ConditionalContext node on the fly instead of vault-file-missing (CONDITIONAL-CONTEXT-PHANTOM-COMPONENT)', async () => {
    // The graph has this synthetic node but renderVault never wrote it a file.
    // Pre-fix the read ENOENTs and the handler returns component-not-found /
    // 'vault file missing'; post-fix it is served from the graph via an
    // on-the-fly render. A file-backed type with a missing file (Orphan, above)
    // still returns vault-file-missing — the fallback is scoped to synthetic
    // file-less types only.
    const result = await getComponentHandler(ctx, {
      id: 'ConditionalContext:ValidationRule:TestObj__c.EndAfterStart.condition-0',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.type).toBe('ConditionalContext');
    expect(result.value.data.id).toBe(
      'ConditionalContext:ValidationRule:TestObj__c.EndAfterStart.condition-0',
    );
    expect(result.value.data.frontmatter).toContain('ConditionalContext');
    expect(result.value.data.body.length).toBeGreaterThan(0);
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

  it('propagates a failed outgoing-edge query as `internal` instead of silently emptying referenceIds (R1-539)', async () => {
    // `listEdges(ctx.graph, node.id, { direction: 'out' })` on the normal
    // (non-metadata-probe) path used `.ok ? ... : []` — a genuine graph query
    // failure (DB gone away, corrupted index, etc.) reads identically to "this
    // node has zero outgoing edges". That is a grounding claim
    // (`data.referenceIds: []`), not a blank: synthesize_answer and any LLM
    // caller reads it as "checked, nothing referenced" rather than "not
    // checked". Every OTHER graph failure in this handler (getNodeById, the
    // node-not-found path) propagates as `internal` — this one alone was
    // swallowed. Reproduce by making the `edges` query fail while the `nodes`
    // query (getNodeById) keeps succeeding on the SAME store.
    const realRunAndReadAll = store.connection.runAndReadAll.bind(store.connection);
    const failingConnection = {
      runAndReadAll: async (sql: string, params: unknown) => {
        if (sql.includes('FROM edges')) {
          throw new Error('simulated edge query failure');
        }
        return realRunAndReadAll(sql, params as never);
      },
    } as unknown as GraphStore['connection'];
    const failingCtx: Context = {
      ...ctx,
      graph: { ...store, connection: failingConnection } as GraphStore,
    };

    const result = await getComponentHandler(failingCtx, {
      id: 'CustomObject:Account',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal');
    expect(result.error.message).toContain('listEdges');
  });

  describe('R6-31: metadata-probe mode (maxBodyBytes 0 / small)', () => {
    it('maxBodyBytes: 0 on a huge node returns ok with a bounded metadata envelope (was oversize before the fix)', async () => {
      const result = await getComponentHandler(ctx, {
        id: 'Profile:HugeProfile',
        maxBodyBytes: 0,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { data } = result.value;

      expect(data.metadataOnly).toBe(true);

      // body fully omitted, as before.
      expect(data.body).toBe('');
      expect(data.bodyTruncated).toBe(true);

      // frontmatter (the ~60 KB rendered blob) is ALSO bounded now, not just body.
      expect(data.frontmatter).toBe('');
      expect(data.frontmatterTruncated).toBe(true);
      expect(data.frontmatterBytes).toBeGreaterThan(50_000);
      expect(data.returnedFrontmatterBytes).toBe(0);

      // properties: scalars survive, the two huge arrays are dropped and named.
      expect(data.properties['description']).toBe(
        'A profile with many permission grants.',
      );
      expect(data.properties['userLicense']).toBe('Salesforce');
      expect(data.properties['fieldPermissions']).toBeUndefined();
      expect(data.properties['objectPermissions']).toBeUndefined();
      expect(data.omittedPropertyKeys).toContain('fieldPermissions');
      expect(data.omittedPropertyKeys).toContain('objectPermissions');

      // referenceIds: bounded subset, true total disclosed separately.
      expect(data.referenceCount).toBe(150);
      expect(data.referenceIds.length).toBeLessThan(150);
      expect(data.omittedReferenceCount).toBe(
        150 - data.referenceIds.length,
      );

      // Honest disclosure names what was omitted.
      expect(data.disclosure).toBeDefined();
      expect(data.disclosure).toContain('maxBodyBytes=0');
      expect(data.disclosure).toContain('fieldPermissions');
      expect(data.disclosure).toContain('objectPermissions');

      // The whole point: the envelope now fits comfortably under the global
      // MCP response budget (40 000 bytes) — before the fix, unbounded
      // frontmatter/properties/referenceIds alone blew well past it even
      // with maxBodyBytes: 0.
      const { RESPONSE_BUDGET_DEFAULT_BYTES } = await import(
        '../../src/tools/index.js'
      );
      expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThan(
        RESPONSE_BUDGET_DEFAULT_BYTES,
      );
    });

    it('maxBodyBytes: 0 never trips the global oversize guard (full jsonResult stack)', async () => {
      const result = await getComponentHandler(ctx, {
        id: 'Profile:HugeProfile',
        maxBodyBytes: 0,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { jsonResult } = await import('../../src/tools/index.js');
      const wrapped = jsonResult(result.value);
      const text = (wrapped.content[0] as { readonly text: string }).text;
      const parsed = JSON.parse(text) as {
        readonly error?: { readonly kind?: string };
        readonly data?: { readonly metadataOnly?: boolean };
      };
      expect(parsed.error).toBeUndefined();
      expect(parsed.data?.metadataOnly).toBe(true);
    });

    it('a small positive maxBodyBytes (metadata-probe range) also truncates properties/referenceIds with disclosure', async () => {
      const result = await getComponentHandler(ctx, {
        id: 'Profile:HugeProfile',
        maxBodyBytes: 500,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { data } = result.value;

      expect(data.metadataOnly).toBe(true);
      expect(data.maxBodyBytes).toBe(500);
      expect(data.returnedBodyBytes).toBeLessThanOrEqual(500);
      expect(data.returnedFrontmatterBytes).toBeLessThanOrEqual(500);
      expect(data.omittedPropertyKeys).toContain('fieldPermissions');
      expect(data.disclosure).toContain('maxBodyBytes=500');
    });

    it('the default call (no maxBodyBytes) on the same huge node is UNCHANGED — full properties and referenceIds', async () => {
      const result = await getComponentHandler(ctx, { id: 'Profile:HugeProfile' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { data } = result.value;

      expect(data.metadataOnly).toBeUndefined();
      expect(data.disclosure).toBeUndefined();
      expect(data.omittedPropertyKeys).toBeUndefined();
      // Full fidelity: both huge arrays present, full length.
      expect(
        (data.properties['fieldPermissions'] as readonly unknown[]).length,
      ).toBe(1_500);
      expect(
        (data.properties['objectPermissions'] as readonly unknown[]).length,
      ).toBe(500);
      // Full referenceIds — all 150 edges, none dropped.
      expect(data.referenceIds.length).toBe(150);
    });

    it('existing maxBodyBytes:128 / maxBodyBytes:5000 regression tests are unaffected by entering metadata-probe mode', async () => {
      // Profile:LargeProfile / Profile:IpRestricted have small-or-empty
      // properties, so metadata-probe mode (now entered for maxBodyBytes:128,
      // since 128 <= METADATA_PROBE_MAX_BODY_BYTES) is a no-op for them —
      // this test just pins that down explicitly alongside the pre-existing
      // assertions in the tests above.
      const result = await getComponentHandler(ctx, {
        id: 'Profile:LargeProfile',
        maxBodyBytes: 128,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.data.metadataOnly).toBe(true);
      expect(result.value.data.properties).toEqual({});
      expect(result.value.data.referenceIds).toEqual([]);
    });
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
