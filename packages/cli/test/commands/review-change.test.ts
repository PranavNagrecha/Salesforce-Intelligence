/// <reference types="vitest/globals" />

/**
 * Tests for the R6-16 `sfi review-change` CLI subcommand.
 *
 *   - `parseManifestComponents`: package.xml → change set (all `modified`,
 *     wildcards collected, not dropped).
 *   - `deriveComponentFromPath` / `parseDiffComponents`: git-diff path → id,
 *     REUSING the refresh dispatcher (the fixtures mirror
 *     `refresh-pipeline.test.ts`' classes/.cls, flows/.flow-meta.xml, and
 *     object-nested fields/.field-meta.xml shapes) + the status-to-changeKind map.
 *   - `runReviewChange` against a real synthetic vault: the `summary.blocking`
 *     count that drives the CI EXIT CODE (1 when blocking, else 0).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';
import { registerVault, saveManifest, vaultPaths } from '@sf-intelligence/vault';

import {
  deriveComponentFromPath,
  parseDiffComponents,
  parseManifestComponents,
  renderReviewChange,
  renderReviewChangeMarkdownComment,
  renderReviewChangeSarif,
  runReviewChange,
  type ReviewChangeCliPayload,
} from '../../src/commands/review-change.js';

// ===========================================================================
// package.xml parsing
// ===========================================================================

describe('parseManifestComponents', () => {
  const PACKAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>OrderService</members>
    <members>CheckoutController</members>
    <name>ApexClass</name>
  </types>
  <types>
    <members>Account.Industry__c</members>
    <name>CustomField</name>
  </types>
  <types>
    <members>*</members>
    <name>Flow</name>
  </types>
  <version>59.0</version>
</Package>`;

  it('maps every member to a modified change entry with type from <name>', () => {
    const { components } = parseManifestComponents(PACKAGE_XML);
    expect(components).toEqual([
      { type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' },
      { type: 'ApexClass', apiName: 'CheckoutController', changeKind: 'modified' },
      { type: 'CustomField', apiName: 'Account.Industry__c', changeKind: 'modified' },
    ]);
  });

  it('collects wildcard members instead of dropping them silently', () => {
    const { wildcardTypes } = parseManifestComponents(PACKAGE_XML);
    expect(wildcardTypes).toEqual(['Flow']);
  });

  it('handles a single-types manifest (fast-xml-parser scalar, not array)', () => {
    const xml =
      '<Package><types><members>Solo</members><name>ApexClass</name></types></Package>';
    const { components } = parseManifestComponents(xml);
    expect(components).toEqual([
      { type: 'ApexClass', apiName: 'Solo', changeKind: 'modified' },
    ]);
  });
});

// ===========================================================================
// git-diff path mapping (dispatcher reuse)
// ===========================================================================

describe('deriveComponentFromPath', () => {
  it('maps a class file to ApexClass:{Name}', () => {
    expect(deriveComponentFromPath('force-app/main/default/classes/OrderService.cls')).toEqual({
      type: 'ApexClass',
      apiName: 'OrderService',
    });
  });

  it('scopes a field to {Object}.{Field}', () => {
    expect(
      deriveComponentFromPath(
        'force-app/main/default/objects/Account/fields/Industry__c.field-meta.xml',
      ),
    ).toEqual({ type: 'CustomField', apiName: 'Account.Industry__c' });
  });

  it('maps a flow file to Flow:{Name}', () => {
    expect(
      deriveComponentFromPath('force-app/main/default/flows/My_Flow.flow-meta.xml'),
    ).toEqual({ type: 'Flow', apiName: 'My_Flow' });
  });

  it('maps an object file to CustomObject:{Object}', () => {
    expect(
      deriveComponentFromPath('force-app/main/default/objects/Account/Account.object-meta.xml'),
    ).toEqual({ type: 'CustomObject', apiName: 'Account' });
  });

  it('collapses an LWC bundle file to the bundle component', () => {
    expect(
      deriveComponentFromPath('force-app/main/default/lwc/orderCard/orderCard.js'),
    ).toEqual({ type: 'LightningComponentBundle', apiName: 'orderCard' });
  });

  it('collapses an Aura bundle file to the bundle component (R6-29)', () => {
    // Regression guard for the fixed dispatcher (R6-29): Aura bundles hit the
    // same bug as LWC bundles — both are exercised here since the prior
    // workaround hand-mapped `lwc`/`aura` separately and could have masked
    // one without the other.
    expect(
      deriveComponentFromPath('force-app/main/default/aura/orderForm/orderForm.cmp'),
    ).toEqual({ type: 'AuraDefinitionBundle', apiName: 'orderForm' });
  });

  it('returns null for a non-metadata path', () => {
    expect(deriveComponentFromPath('README.md')).toBeNull();
    expect(deriveComponentFromPath('sfdx-project.json')).toBeNull();
  });
});

describe('parseDiffComponents', () => {
  it('maps each name-status line to a change entry with the right change kind', () => {
    const diff = [
      'M\tforce-app/main/default/classes/OrderService.cls',
      'A\tforce-app/main/default/classes/NewService.cls',
      'D\tforce-app/main/default/flows/Old_Flow.flow-meta.xml',
    ].join('\n');
    expect(parseDiffComponents(diff)).toEqual([
      { type: 'ApexClass', apiName: 'OrderService', changeKind: 'modified' },
      { type: 'ApexClass', apiName: 'NewService', changeKind: 'added' },
      { type: 'Flow', apiName: 'Old_Flow', changeKind: 'deleted' },
    ]);
  });

  it('treats a rename (R###) as a modify of the NEW path', () => {
    const diff =
      'R100\tforce-app/main/default/classes/Old.cls\tforce-app/main/default/classes/New.cls';
    expect(parseDiffComponents(diff)).toEqual([
      { type: 'ApexClass', apiName: 'New', changeKind: 'modified' },
    ]);
  });

  it('dedupes multiple changed files in one LWC bundle to a single component', () => {
    const diff = [
      'M\tforce-app/main/default/lwc/orderCard/orderCard.js',
      'M\tforce-app/main/default/lwc/orderCard/orderCard.html',
    ].join('\n');
    expect(parseDiffComponents(diff)).toEqual([
      { type: 'LightningComponentBundle', apiName: 'orderCard', changeKind: 'modified' },
    ]);
  });

  it('drops unrecognised paths', () => {
    const diff = 'M\tREADME.md\nA\tscripts/deploy.sh';
    expect(parseDiffComponents(diff)).toEqual([]);
  });
});

// ===========================================================================
// runReviewChange against a real synthetic vault → the CI exit-code driver
// ===========================================================================

const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 3 },
  edges: { callsApex: 1 },
  sourceTreeHash: 'sha256:fixture-cli-review-change',
};

let vaultRoot: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sfi-cli-review-change-'));
  vaultRoot = join(root, 'org-kb');
  await mkdir(join(vaultRoot, 'graph'), { recursive: true });
  await saveManifest(vaultRoot, MANIFEST);

  const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  const store = opened.value;
  const seed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:OrderService', apiName: 'OrderService', properties: { isTest: false } }),
      makeNode({ id: 'ApexClass:CheckoutController', apiName: 'CheckoutController', properties: { isTest: false } }),
      makeNode({ id: 'ApexClass:LonelyService', apiName: 'LonelyService', properties: { isTest: false } }),
    ],
    edges: [
      // CheckoutController depends on OrderService (incoming edge to OrderService).
      {
        fromId: 'ApexClass:CheckoutController',
        toId: 'ApexClass:OrderService',
        edgeType: 'callsApex',
        confidence: 'declared',
        source: 'unit-test',
        properties: {},
      },
    ],
  };
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  // Close so buildContext (inside runReviewChange) can reopen without a lock.
  await closeGraph(store);
});

afterAll(async () => {
  await rm(join(vaultRoot, '..'), { recursive: true, force: true });
});

describe('runReviewChange (exit-code driver)', () => {
  it('reports summary.blocking >= 1 for a deleted component with dependents (drives exit 1)', async () => {
    const r = await runReviewChange({
      vaultRoot,
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary.blocking).toBe(1);
    expect(r.value.overallVerdict).toBe('blocking');
    // The command exits `summary.blocking > 0 ? 1 : 0`.
    expect(r.value.summary.blocking > 0 ? 1 : 0).toBe(1);
  });

  it('reports summary.blocking = 0 for a safe change (drives exit 0)', async () => {
    const r = await runReviewChange({
      vaultRoot,
      components: [{ type: 'ApexClass', apiName: 'LonelyService', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summary.blocking).toBe(0);
    expect(r.value.summary.blocking > 0 ? 1 : 0).toBe(0);
  });

  it('fails with empty-change-set when given no components', async () => {
    const r = await runReviewChange({ vaultRoot, components: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('empty-change-set');
  });

  it('renders a markdown report with the overall verdict, table, and boundaries', async () => {
    const r = await runReviewChange({
      vaultRoot,
      components: [{ type: 'ApexClass', apiName: 'OrderService', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const md = renderReviewChange(r.value as ReviewChangeCliPayload, ['a disclosure line']);
    expect(md).toMatch(/overall: BLOCKING/);
    expect(md).toMatch(/ApexClass:OrderService/);
    expect(md).toMatch(/Boundaries/);
    expect(md).toMatch(/a disclosure line/);
    expect(md).toMatch(/LAST VAULT REFRESH/);
  });
});

// ===========================================================================
// R7-C2 — `sfi review-change --against <alias|path>` (cross-vault)
// ===========================================================================

describe('runReviewChange --against (cross-vault)', () => {
  let againstRoot: string;
  let sandboxVault: string;
  let prodVault: string;

  beforeAll(async () => {
    againstRoot = await mkdtemp(join(tmpdir(), 'sfi-cli-against-'));
    sandboxVault = join(againstRoot, 'org-kb');
    prodVault = join(againstRoot, 'prod');

    // Sandbox (current): Shared has NO dependents.
    await mkdir(join(sandboxVault, 'graph'), { recursive: true });
    await saveManifest(sandboxVault, MANIFEST);
    const sOpened = await openGraph(vaultPaths(sandboxVault).graphDb);
    if (!sOpened.ok) throw new Error(sOpened.error.message);
    const sImp = await importExtractionResults(sOpened.value, [
      {
        nodes: [makeNode({ id: 'ApexClass:Shared', apiName: 'Shared', properties: { isTest: false } })],
        edges: [],
      },
    ]);
    if (!sImp.ok) throw new Error(sImp.error.message);
    await closeGraph(sOpened.value);

    // Prod: Shared IS depended on by ProdCaller (callsApex).
    await mkdir(join(prodVault, 'graph'), { recursive: true });
    await saveManifest(prodVault, MANIFEST);
    const pOpened = await openGraph(vaultPaths(prodVault).graphDb);
    if (!pOpened.ok) throw new Error(pOpened.error.message);
    const pImp = await importExtractionResults(pOpened.value, [
      {
        nodes: [
          makeNode({ id: 'ApexClass:Shared', apiName: 'Shared', properties: { isTest: false } }),
          makeNode({ id: 'ApexClass:ProdCaller', apiName: 'ProdCaller', properties: { isTest: false } }),
        ],
        edges: [
          {
            fromId: 'ApexClass:ProdCaller',
            toId: 'ApexClass:Shared',
            edgeType: 'callsApex',
            confidence: 'declared',
            source: 'unit-test',
            properties: {},
          },
        ],
      },
    ]);
    if (!pImp.ok) throw new Error(pImp.error.message);
    await closeGraph(pOpened.value);

    await registerVault(againstRoot, 'prod', prodVault);
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = againstRoot;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await rm(againstRoot, { recursive: true, force: true });
  });

  it('resolves the --against alias and blocks on a dependent that lives only in prod (exit 1)', async () => {
    const against = await runReviewChange({
      vaultRoot: sandboxVault,
      components: [{ type: 'ApexClass', apiName: 'Shared', changeKind: 'deleted' }],
      againstVault: 'prod',
    });
    expect(against.ok).toBe(true);
    if (!against.ok) return;
    expect(against.value.againstVault?.alias).toBe('prod');
    expect(against.value.againstVault?.resolvedFrom).toBe('alias');
    expect(against.value.summary.blocking).toBe(1);
    expect(against.value.summary.blocking > 0 ? 1 : 0).toBe(1);

    // The SAME changeset without --against is safe in the sandbox → exit 0.
    const local = await runReviewChange({
      vaultRoot: sandboxVault,
      components: [{ type: 'ApexClass', apiName: 'Shared', changeKind: 'deleted' }],
    });
    expect(local.ok).toBe(true);
    if (!local.ok) return;
    expect(local.value.summary.blocking).toBe(0);
    expect(local.value.againstVault).toBeUndefined();
  });

  it('renders the against-vault header in the markdown report', async () => {
    const r = await runReviewChange({
      vaultRoot: sandboxVault,
      components: [{ type: 'ApexClass', apiName: 'Shared', changeKind: 'deleted' }],
      againstVault: 'prod',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const md = renderReviewChange(r.value as ReviewChangeCliPayload);
    expect(md).toMatch(/AGAINST VAULT: 'prod'/);
    expect(md).toMatch(/overall: BLOCKING/);
  });
});

// ===========================================================================
// Finding #37 — `--format sarif` / `--format markdown-comment` (pure
// transforms over a `ReviewChangeCliPayload` fixture, no vault needed).
// ===========================================================================

/** A fixture payload spanning every verdict, incl. `unknown` (folds to `review`). */
const FIXTURE_PAYLOAD: ReviewChangeCliPayload = {
  reviewed: [
    {
      id: 'ApexClass:OrderService',
      type: 'ApexClass',
      apiName: 'OrderService',
      changeKind: 'deleted',
      verdict: 'blocking',
      reason: 'Deleting breaks 2 dependent(s): ApexClass:CheckoutController | ApexClass:RefundService',
      inVault: true,
      dependentCount: 2,
      dependents: ['ApexClass:CheckoutController', 'ApexClass:RefundService'],
      selectedTests: ['OrderServiceTest'],
      testCoverage: 'covered',
    },
    {
      id: 'Flow:My_Flow',
      type: 'Flow',
      apiName: 'My_Flow',
      changeKind: 'modified',
      verdict: 'risky',
      reason: 'Modified with 1 firm dependent.',
      inVault: true,
      dependentCount: 1,
      dependents: ['Flow:Parent_Flow'],
      selectedTests: [],
      testCoverage: 'not-applicable',
    },
    {
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Account.Industry__c',
      changeKind: 'modified',
      verdict: 'review',
      reason: 'Only heuristic dependents found — verify manually.',
      inVault: true,
      dependentCount: 1,
      dependents: ['ApexTrigger:AccountTrigger'],
      selectedTests: [],
      testCoverage: 'not-applicable',
    },
    {
      id: 'ApexClass:Weird',
      type: 'ApexClass',
      apiName: 'Weird',
      changeKind: 'modified',
      verdict: 'unknown',
      reason: 'Could not classify.',
      inVault: true,
      dependentCount: 0,
      dependents: [],
      selectedTests: [],
      testCoverage: 'uncovered',
    },
    {
      id: 'ApexClass:LonelyService',
      type: 'ApexClass',
      apiName: 'LonelyService',
      changeKind: 'modified',
      verdict: 'safe',
      reason: 'No dependents; family fully covered.',
      inVault: true,
      dependentCount: 0,
      dependents: [],
      selectedTests: ['LonelyServiceTest'],
      testCoverage: 'covered',
    },
  ],
  overallVerdict: 'blocking',
  summary: {
    total: 5,
    blocking: 1,
    risky: 1,
    review: 2,
    safe: 1,
    testsToRun: 2,
    uncoveredApex: 1,
    notInVault: 0,
    truncated: false,
  },
  selectedTests: ['OrderServiceTest', 'LonelyServiceTest'],
  recommendation: 'Do not deploy: 1 component is blocking.',
  disclosure: 'review_change is a pre-deploy gate over the LAST VAULT REFRESH…',
  boundaries: ['Dependents are DIRECT (single-hop) incoming edges only.'],
};

describe('renderReviewChangeSarif', () => {
  it('emits valid SARIF 2.1.0 shape: $schema, version, driver.rules, results', () => {
    const raw = renderReviewChangeSarif(FIXTURE_PAYLOAD, '0.2.0-test');
    const sarif = JSON.parse(raw) as {
      $schema: string;
      version: string;
      runs: Array<{
        tool: { driver: { name: string; version: string; rules: Array<{ id: string }> } };
        results: unknown[];
      }>;
    };
    expect(sarif.$schema).toContain('sarif-schema-2.1.0.json');
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0]?.tool.driver.name).toBe('sfi-review-change');
    expect(sarif.runs[0]?.tool.driver.version).toBe('0.2.0-test');
    expect(sarif.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual([
      'blocking',
      'risky',
      'review',
    ]);
  });

  it('emits one result per NON-safe component, folding `unknown` into the `review` rule', () => {
    const sarif = JSON.parse(renderReviewChangeSarif(FIXTURE_PAYLOAD, '0.2.0-test')) as {
      runs: Array<{
        results: Array<{ ruleId: string; level: string; message: { text: string } }>;
      }>;
    };
    const results = sarif.runs[0]?.results ?? [];
    // 5 reviewed, 1 `safe` — excluded, so 4 results.
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.ruleId)).toEqual(['blocking', 'risky', 'review', 'review']);
  });

  it('maps blocking -> error, risky -> warning, review/unknown -> note', () => {
    const sarif = JSON.parse(renderReviewChangeSarif(FIXTURE_PAYLOAD, '0.2.0-test')) as {
      runs: Array<{ results: Array<{ ruleId: string; level: string }> }>;
    };
    const byRule = Object.fromEntries(
      (sarif.runs[0]?.results ?? []).map((r) => [r.ruleId + ':' + r.level, true]),
    );
    expect(byRule['blocking:error']).toBe(true);
    expect(byRule['risky:warning']).toBe(true);
    expect(byRule['review:note']).toBe(true);
  });

  it('points each result location at the component id (type/apiName), and carries the reason verbatim', () => {
    const sarif = JSON.parse(renderReviewChangeSarif(FIXTURE_PAYLOAD, '0.2.0-test')) as {
      runs: Array<{
        results: Array<{
          message: { text: string };
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
          partialFingerprints: { sfiComponentId: string };
        }>;
      }>;
    };
    const first = sarif.runs[0]?.results[0];
    expect(first?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      'ApexClass/OrderService',
    );
    expect(first?.partialFingerprints.sfiComponentId).toBe('ApexClass:OrderService');
    expect(first?.message.text).toMatch(/Deleting breaks 2 dependent/);
  });

  it('carries the full summary (incl. the safe count) in runs[].properties even though safe is excluded from results', () => {
    const sarif = JSON.parse(renderReviewChangeSarif(FIXTURE_PAYLOAD, '0.2.0-test')) as {
      runs: Array<{ properties: { summary: { safe: number; total: number } } }>;
    };
    expect(sarif.runs[0]?.properties.summary.safe).toBe(1);
    expect(sarif.runs[0]?.properties.summary.total).toBe(5);
  });

  it('emits an empty (but valid) results array for an empty change set', () => {
    const empty: ReviewChangeCliPayload = {
      ...FIXTURE_PAYLOAD,
      reviewed: [],
      summary: { ...FIXTURE_PAYLOAD.summary, total: 0, blocking: 0, risky: 0, review: 0, safe: 0 },
    };
    const sarif = JSON.parse(renderReviewChangeSarif(empty, '0.2.0-test')) as {
      runs: Array<{ results: unknown[] }>;
    };
    expect(sarif.runs[0]?.results).toEqual([]);
  });
});

describe('renderReviewChangeMarkdownComment', () => {
  it('opens with the overall verdict and includes the recommendation', () => {
    const md = renderReviewChangeMarkdownComment(FIXTURE_PAYLOAD);
    expect(md).toMatch(/^### sfi review-change — BLOCKING/);
    expect(md).toMatch(/Do not deploy: 1 component is blocking\./);
  });

  it('includes a tally line and a table row per reviewed component with its verdict mark', () => {
    const md = renderReviewChangeMarkdownComment(FIXTURE_PAYLOAD);
    expect(md).toMatch(/\*\*1 blocking\*\*, 1 risky, 2 review, 1 safe \(5 total\)/);
    expect(md).toMatch(/2 test\(s\) to run/);
    expect(md).toMatch(/\| BLOCK \| `ApexClass:OrderService` \| deleted \|/);
    expect(md).toMatch(/\| RISKY \| `Flow:My_Flow` \| modified \|/);
    // `unknown` renders as REVIEW, same as VERDICT_MARK does for the human report.
    expect(md).toMatch(/\| REVIEW \| `ApexClass:Weird` \| modified \|/);
    expect(md).toMatch(/\| ok \| `ApexClass:LonelyService` \| modified \|/);
  });

  it('escapes a pipe character in a reason so it cannot break the markdown table', () => {
    const withPipe: ReviewChangeCliPayload = {
      ...FIXTURE_PAYLOAD,
      reviewed: [
        {
          ...FIXTURE_PAYLOAD.reviewed[0]!,
          reason: 'Breaks A | B | C',
        },
      ],
    };
    const md = renderReviewChangeMarkdownComment(withPipe);
    expect(md).toMatch(/Breaks A \\\| B \\\| C/);
  });

  it('folds extra disclosures + boundaries into a collapsed <details> block', () => {
    const md = renderReviewChangeMarkdownComment(FIXTURE_PAYLOAD, ['a diff-derived disclosure']);
    expect(md).toMatch(/<details><summary>Boundaries<\/summary>/);
    expect(md).toMatch(/- a diff-derived disclosure/);
    expect(md).toMatch(/- Dependents are DIRECT \(single-hop\) incoming edges only\./);
    expect(md).toMatch(/<\/details>/);
  });

  it('renders the against-vault line and the absent-in-against-vault section when present', () => {
    const against: ReviewChangeCliPayload = {
      ...FIXTURE_PAYLOAD,
      againstVault: {
        alias: 'prod',
        path: '/vaults/prod/org-kb',
        resolvedFrom: 'alias',
        lastRefreshedAt: '2026-07-01T00:00:00Z',
        sourceTreeHash: 'sha256:x',
      },
      absentInAgainstVault: ['ApexClass:NewOnlyInSandbox'],
    };
    const md = renderReviewChangeMarkdownComment(against);
    expect(md).toMatch(/_Against vault `prod` \(alias, last refresh 2026-07-01T00:00:00Z\)/);
    expect(md).toMatch(/\*\*Absent from the against-vault\*\*.*`ApexClass:NewOnlyInSandbox`/);
  });

  it('renders a clean empty-change-set summary without a table', () => {
    const empty: ReviewChangeCliPayload = {
      ...FIXTURE_PAYLOAD,
      reviewed: [],
      overallVerdict: 'safe',
      summary: { ...FIXTURE_PAYLOAD.summary, total: 0, blocking: 0, risky: 0, review: 0, safe: 0, testsToRun: 0 },
    };
    const md = renderReviewChangeMarkdownComment(empty);
    expect(md).toMatch(/### sfi review-change — SAFE/);
    expect(md).not.toMatch(/\| \| Component \| Change \| Reason \|/);
  });
});
