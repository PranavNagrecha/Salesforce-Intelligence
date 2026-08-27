/// <reference types="vitest/globals" />

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import { loadManifest, summarizeCoverage } from '@sf-intelligence/vault';

import {
  buildAndSaveProfileNameMap,
  buildFolderedReportManifest,
  buildPackageXml,
  buildRefreshPulse,
  computeChangeSummary,
  countLandedReportMembers,
  formatRefreshSummary,
  formatReportsCapSummary,
  graphSwapFailureMessage,
  installSideBuildGraph,
  isLockedOpenFailure,
  loadVaultConfig,
  manifestMembersForType,
  objectsToExpandManifest,
  runRefresh,
  runSf,
  selectManifestTypes,
} from '../../src/commands/refresh.js';

const manifest = (over: Partial<VaultManifest>): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-01T00:00:00.000Z',
  sourceOrg: 'test',
  components: {},
  edges: {},
  sourceTreeHash: 'hash-a',
  ...over,
});

const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-refresh-'));

/** Write a vault `meta/config.json` under `${cwd}/org-kb/meta/`. */
const writeConfig = async (cwd: string, targetOrg: string): Promise<void> => {
  const metaDir = join(cwd, 'org-kb', 'meta');
  await mkdir(metaDir, { recursive: true });
  await writeFile(
    join(metaDir, 'config.json'),
    JSON.stringify({ targetOrg, vaultRoot: join(cwd, 'org-kb'), version: '0.1.0', createdAt: '2026-05-27T00:00:00.000Z' }),
    'utf8',
  );
};

/** Write a single source file under `${cwd}/org-kb/source/<relPath>`. */
const writeSource = async (cwd: string, relPath: string, content: string): Promise<void> => {
  const full = join(cwd, 'org-kb', 'source', relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
};

/** A minimal valid CustomObject XML body. */
const objectXml = (label: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>${label}</label>
    <nameField>
        <label>Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>${label}s</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
`;

/** A minimal valid CustomField XML body. */
const fieldXml = (label: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>${label}__c</fullName>
    <label>${label}</label>
    <type>Checkbox</type>
    <defaultValue>false</defaultValue>
</CustomField>
`;

/** A minimal valid Flow XML body. */
const flowXml = (label: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <label>${label}</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
</Flow>
`;

/** Seed the canonical 3-object / 5-field / 2-flow fixture under `${cwd}/org-kb/source/`. */
const seedSmallFixture = async (cwd: string): Promise<void> => {
  await writeSource(cwd, 'objects/Alpha__c/Alpha__c.object-meta.xml', objectXml('Alpha'));
  await writeSource(cwd, 'objects/Beta__c/Beta__c.object-meta.xml', objectXml('Beta'));
  await writeSource(cwd, 'objects/Gamma__c/Gamma__c.object-meta.xml', objectXml('Gamma'));
  await writeSource(cwd, 'objects/Alpha__c/fields/One__c.field-meta.xml', fieldXml('One'));
  await writeSource(cwd, 'objects/Alpha__c/fields/Two__c.field-meta.xml', fieldXml('Two'));
  await writeSource(cwd, 'objects/Beta__c/fields/Three__c.field-meta.xml', fieldXml('Three'));
  await writeSource(cwd, 'objects/Beta__c/fields/Four__c.field-meta.xml', fieldXml('Four'));
  await writeSource(cwd, 'objects/Gamma__c/fields/Five__c.field-meta.xml', fieldXml('Five'));
  await writeSource(cwd, 'flows/Flow_One.flow-meta.xml', flowXml('Flow One'));
  await writeSource(cwd, 'flows/Flow_Two.flow-meta.xml', flowXml('Flow Two'));
};

/** Return `true` if `path` exists. */
const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('runRefresh', () => {
  it('renders the full vault for a small fixture on the happy path', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await seedSmallFixture(cwd);

      const result = await runRefresh({ cwd, noPull: true });
      expect(result.status).toBe('success');
      expect(result.errors).toEqual([]);

      const root = join(cwd, 'org-kb');
      // 3 objects -> one markdown each
      for (const name of ['Alpha__c', 'Beta__c', 'Gamma__c']) {
        expect(await pathExists(join(root, 'components', 'CustomObject', `${name}.md`))).toBe(true);
      }
      // 5 fields -> nested under their parent
      for (const [parent, field] of [
        ['Alpha__c', 'One__c'],
        ['Alpha__c', 'Two__c'],
        ['Beta__c', 'Three__c'],
        ['Beta__c', 'Four__c'],
        ['Gamma__c', 'Five__c'],
      ] as const) {
        expect(await pathExists(join(root, 'components', 'CustomField', parent, `${field}.md`))).toBe(true);
      }
      // 2 flows
      expect(await pathExists(join(root, 'components', 'Flow', 'Flow_One.md'))).toBe(true);
      expect(await pathExists(join(root, 'components', 'Flow', 'Flow_Two.md'))).toBe(true);
      // Index
      expect(await pathExists(join(root, 'components', 'index.md'))).toBe(true);
      // Graph DB
      expect(await pathExists(join(root, 'graph', 'graph.duckdb'))).toBe(true);

      // Manifest counts
      const manifestRaw = await readFile(join(root, 'meta', 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as {
        components: Record<string, number>;
        edges: Record<string, number>;
        sourceOrg: string;
        sourceTreeHash: string;
      };
      expect(manifest.components['CustomObject']).toBe(3);
      expect(manifest.components['CustomField']).toBe(5);
      expect(manifest.components['Flow']).toBe(2);
      expect(manifest.sourceOrg).toBe('test-org');
      // Source-tree hash is the 64-char sha256 hex digest.
      expect(manifest.sourceTreeHash).toMatch(/^[0-9a-f]{64}$/);
      // parentOf edges from the 3 objects to their 5 fields.
      expect(manifest.edges['parentOf']).toBe(5);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes the P9 refresh hooks under org-kb (onboarding doc, pulse, risk-score)', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await seedSmallFixture(cwd);
      const result = await runRefresh({ cwd, noPull: true });
      expect(result.status).toBe('success');
      const root = join(cwd, 'org-kb');
      // P9-auto-onboarding-doc: handbook regenerated under the gitignored docs/.
      expect(await pathExists(join(root, 'docs', 'onboarding.md'))).toBe(true);
      const md = await readFile(join(root, 'docs', 'onboarding.md'), 'utf8');
      expect(md).toMatch(/onboarding handbook · generated/);
      // P9-refresh-pulse: pulse written under meta/.
      expect(await pathExists(join(root, 'meta', 'pulse.json'))).toBe(true);
      // P9-risk-delta: tech-debt score logged under meta/ for the delta.
      expect(await pathExists(join(root, 'meta', 'risk-scores.jsonl'))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports per-phase progress through the onProgress sink (B11)', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await seedSmallFixture(cwd);
      const messages: string[] = [];
      const result = await runRefresh({
        cwd,
        noPull: true,
        onProgress: (m) => messages.push(m),
      });
      expect(result.status).toBe('success');
      const joined = messages.join('\n');
      expect(joined).toMatch(/Extracting/);
      expect(joined).toMatch(/Rendering/);
      // noPull skips the retrieve phase, so there is no "Retrieving" line.
      expect(joined).not.toMatch(/Retrieving/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns status=partial and records the failure when one file is malformed', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await writeSource(cwd, 'objects/Good__c/Good__c.object-meta.xml', objectXml('Good'));
      // Broken: unclosed tag → fast-xml-parser's strict validator rejects.
      await writeSource(cwd, 'objects/Bad__c/Bad__c.object-meta.xml', '<?xml version="1.0"?><CustomObject><label>Hi</wrongClose></CustomObject>');

      const result = await runRefresh({ cwd, noPull: true });
      expect(result.status).toBe('partial');
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]?.path.endsWith('Bad__c.object-meta.xml')).toBe(true);
      // The good one was still rendered.
      expect(await pathExists(join(cwd, 'org-kb', 'components', 'CustomObject', 'Good__c.md'))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns status=failed with a clear message when no config.json exists', async () => {
    const cwd = await makeTempCwd();
    try {
      // Deliberately omit writeConfig.
      const result = await runRefresh({ cwd, noPull: true });
      expect(result.status).toBe('failed');
      expect(result.fatalError).toContain('config');
      expect(result.fatalError).toContain('sfi init');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('restricts the refresh to the listed metadata types', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await writeSource(cwd, 'objects/Only__c/Only__c.object-meta.xml', objectXml('Only'));
      await writeSource(cwd, 'objects/Only__c/fields/Skip__c.field-meta.xml', fieldXml('Skip'));
      await writeSource(cwd, 'flows/Skip_Flow.flow-meta.xml', flowXml('Skip Flow'));

      const result = await runRefresh({ cwd, noPull: true, types: 'CustomObject' });
      expect(result.status).toBe('success');

      const root = join(cwd, 'org-kb');
      expect(await pathExists(join(root, 'components', 'CustomObject', 'Only__c.md'))).toBe(true);
      expect(await pathExists(join(root, 'components', 'CustomField', 'Only__c', 'Skip__c.md'))).toBe(false);
      expect(await pathExists(join(root, 'components', 'Flow', 'Skip_Flow.md'))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('a scoped --types refresh is never reported as complete coverage (B8 honesty)', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await writeSource(cwd, 'objects/Only__c/Only__c.object-meta.xml', objectXml('Only'));
      await writeSource(cwd, 'flows/Skip_Flow.flow-meta.xml', flowXml('Skip Flow'));

      // Pull ONLY CustomObject — Flow et al. are deliberately left un-requested.
      const result = await runRefresh({ cwd, noPull: true, types: 'CustomObject' });
      expect(result.status).toBe('success');

      const loaded = await loadManifest(join(cwd, 'org-kb'));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;

      const byType = new Map(
        (loaded.value.coverage ?? []).map((e) => [e.type, e]),
      );
      // The requested type is covered; an un-requested modeled type is recorded
      // as requested:false (not silently absent).
      expect(byType.get('CustomObject')?.requested).toBe(true);
      expect(byType.get('Flow')?.requested).toBe(false);

      // The honesty contract: a partial-scope refresh must NEVER summarize as
      // `complete` — every coverage consumer (org_overview, health_check,
      // coverage_report) reads this, so the tour can't claim a whole-org scan.
      const summary = summarizeCoverage(loaded.value);
      expect(summary.status).toBe('partial');
      expect(summary.status).not.toBe('complete');
      expect(summary.missingCoverage).toContain('Flow');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records unknown DX directories in the manifest skippedDirectories map and prints a warning', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      // One known type (extracts cleanly) plus a synthetic OmniStudio-
      // shaped tree (the dispatcher doesn't know about it yet). The
      // architectural-bug-fix counter must surface the gap in the
      // manifest AND in the formatted CLI summary, replacing the
      // previous silent-skip.
      await writeSource(cwd, 'objects/Good__c/Good__c.object-meta.xml', objectXml('Good'));
      await writeSource(cwd, 'omniProcesses/A.xml', '<?xml version="1.0"?><foo/>');
      await writeSource(cwd, 'omniProcesses/B.xml', '<?xml version="1.0"?><foo/>');
      await writeSource(cwd, 'omniProcesses/C.xml', '<?xml version="1.0"?><foo/>');
      await writeSource(cwd, 'omniDataTransforms/D.xml', '<?xml version="1.0"?><foo/>');
      await writeSource(cwd, 'omniDataTransforms/E.xml', '<?xml version="1.0"?><foo/>');

      const result = await runRefresh({ cwd, noPull: true });
      expect(result.status).toBe('success');
      // The 3 + 2 unknown files surface in the in-memory result.
      expect(result.skippedDirectories).toEqual({
        omniProcesses: 3,
        omniDataTransforms: 2,
      });

      // The manifest carries the same map verbatim.
      const manifestRaw = await readFile(join(cwd, 'org-kb', 'meta', 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as { skippedDirectories?: Record<string, number> };
      expect(manifest.skippedDirectories).toEqual({
        omniProcesses: 3,
        omniDataTransforms: 2,
      });

      // The formatted summary includes the warning block + the
      // pointer to `sfi status --skipped` for the full list.
      const summary = formatRefreshSummary(result);
      expect(summary).toContain('WARNING');
      expect(summary).toContain('5 files');
      expect(summary).toContain('2 unknown directories');
      expect(summary).toContain('omniProcesses');
      expect(summary).toContain('omniDataTransforms');
      expect(summary).toContain('sfi status --skipped');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes an empty skippedDirectories map (not a missing field) when every file matches a dispatch', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await seedSmallFixture(cwd);

      const result = await runRefresh({ cwd, noPull: true });
      expect(result.status).toBe('success');
      expect(result.skippedDirectories).toEqual({});

      // The manifest still records the field — present-but-empty
      // means "the walker covered every file", which is a useful
      // signal distinct from "this vault predates the counter".
      const manifestRaw = await readFile(join(cwd, 'org-kb', 'meta', 'manifest.json'), 'utf8');
      const manifest = JSON.parse(manifestRaw) as { skippedDirectories?: Record<string, number> };
      expect(manifest.skippedDirectories).toEqual({});

      // The summary contains no warning block when the map is empty.
      const summary = formatRefreshSummary(result);
      expect(summary).not.toContain('WARNING');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('produces byte-identical component output across two runs over the same fixture', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await seedSmallFixture(cwd);

      const componentPaths = [
        join(cwd, 'org-kb', 'components', 'CustomObject', 'Alpha__c.md'),
        join(cwd, 'org-kb', 'components', 'CustomField', 'Alpha__c', 'One__c.md'),
        join(cwd, 'org-kb', 'components', 'Flow', 'Flow_One.md'),
        join(cwd, 'org-kb', 'components', 'index.md'),
      ];

      const r1 = await runRefresh({ cwd, noPull: true });
      expect(r1.status).toBe('success');
      const first = await Promise.all(componentPaths.map((p) => readFile(p, 'utf8')));

      const r2 = await runRefresh({ cwd, noPull: true });
      expect(r2.status).toBe('success');
      const second = await Promise.all(componentPaths.map((p) => readFile(p, 'utf8')));

      for (let i = 0; i < componentPaths.length; i++) {
        expect(second[i]).toBe(first[i]);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('selectManifestTypes', () => {
  it('drops types the org does not expose instead of asking for them (no INVALID_TYPE)', () => {
    const requested = new Set(['ApexTrigger', 'OmniScript', 'RecordType'] as const);
    const orgTypes = new Set(['ApexTrigger', 'RecordType', 'CustomObject']);
    const { included, dropped } = selectManifestTypes(requested, orgTypes);
    expect([...included].sort()).toEqual(['ApexTrigger', 'RecordType']);
    expect(dropped).toEqual(['OmniScript']);
  });

  it('passes candidates through unchanged when the org describe is unavailable', () => {
    const requested = new Set(['ApexClass', 'Flow'] as const);
    const { included, dropped } = selectManifestTypes(requested, null);
    expect([...included].sort()).toEqual(['ApexClass', 'Flow']);
    expect(dropped).toEqual([]);
  });

  it('maps Visualforce types to their Metadata API xmlName when matching the describe', () => {
    const requested = new Set(['VisualforcePage', 'VisualforceComponent'] as const);
    // The org describe reports the API names (ApexPage / ApexComponent), not the internal ones.
    const orgTypes = new Set(['ApexPage', 'ApexComponent']);
    const { included, dropped } = selectManifestTypes(requested, orgTypes);
    expect([...included].sort()).toEqual(['VisualforceComponent', 'VisualforcePage']);
    expect(dropped).toEqual([]);
  });

  it('includes sharing rules and custom-metadata records via their aggregate xmlNames (regression: dropped as "not present")', () => {
    // Regression for the metadata-API-name mismatch: the describe reports the
    // aggregate xmlNames `SharingRules` / `CustomMetadata`, but the internal
    // types are `SharingRule` / `CustomMetadataRecord`. Without the alias they
    // were intersected by identity, never matched, and were silently dropped
    // before retrieve — leaving sharing + CMDT records absent from every org.
    const requested = new Set(['SharingRule', 'CustomMetadataRecord'] as const);
    const orgTypes = new Set(['SharingRules', 'CustomMetadata']);
    const { included, dropped } = selectManifestTypes(requested, orgTypes);
    expect([...included].sort()).toEqual(['CustomMetadataRecord', 'SharingRule']);
    expect(dropped).toEqual([]);
  });

  it('still drops an aliased type when the org genuinely lacks its xmlName', () => {
    // The alias must not force-include: an org with no sharing rules at all
    // (describe omits `SharingRules`) should still drop `SharingRule`.
    const requested = new Set(['SharingRule', 'ApexClass'] as const);
    const orgTypes = new Set(['ApexClass']);
    const { included, dropped } = selectManifestTypes(requested, orgTypes);
    expect(included).toEqual(['ApexClass']);
    expect(dropped).toEqual(['SharingRule']);
  });

  it('includes the aggregate rule families via their plural xmlNames (B20: were dropped as "not present")', () => {
    // Confirmed against a real org `list metadata-types` describe: the singular
    // internal types (AssignmentRule, AutoResponseRule, EscalationRule,
    // MatchingRule, WorkflowRule) are ABSENT; the org exposes only the plural
    // aggregate containers (AssignmentRules … and `Workflow` for workflow
    // rules). Without the alias each was intersected by identity, never matched,
    // and silently dropped — so those rules never reached the vault.
    const requested = new Set([
      'AssignmentRule',
      'AutoResponseRule',
      'EscalationRule',
      'MatchingRule',
      'WorkflowRule',
    ] as const);
    const orgTypes = new Set([
      'AssignmentRules',
      'AutoResponseRules',
      'EscalationRules',
      'MatchingRules',
      'Workflow',
    ]);
    const { included, dropped } = selectManifestTypes(requested, orgTypes);
    expect([...included].sort()).toEqual([
      'AssignmentRule',
      'AutoResponseRule',
      'EscalationRule',
      'MatchingRule',
      'WorkflowRule',
    ]);
    expect(dropped).toEqual([]);
  });

  it('keeps DuplicateRule as its singular xmlName (the org exposes it singular — no alias needed)', () => {
    const requested = new Set(['DuplicateRule'] as const);
    const orgTypes = new Set(['DuplicateRule']);
    const { included, dropped } = selectManifestTypes(requested, orgTypes);
    expect(included).toEqual(['DuplicateRule']);
    expect(dropped).toEqual([]);
  });

  it('with no --types filter, intersects the full supported set with the org', () => {
    const orgTypes = new Set(['ApexClass', 'CustomObject']);
    const { included } = selectManifestTypes(null, orgTypes);
    expect([...included].sort()).toEqual(['ApexClass', 'CustomObject']);
  });

  it('includes GenAiPlannerBundle when the org describe reports it (R6-30)', () => {
    // The type-name intersection has no special-casing for GenAiPlannerBundle
    // (it maps to its own xmlName via the identity fallback in `toApiName`), so
    // it passes through selection like any other type once a describe lists it.
    // The version floor that makes the describe/retrieve actually SEE the type
    // is a separate manifest-generation concern: it needs Metadata API v65.0+,
    // which the pipeline pins BELOW (62.0) to keep Profile grants intact, so in
    // practice this type stays deferred until a split manifest exists.
    const requested = new Set(['GenAiPlannerBundle', 'ApexClass'] as const);
    const orgTypes = new Set(['GenAiPlannerBundle', 'ApexClass']);
    const { included, dropped } = selectManifestTypes(requested, orgTypes);
    expect([...included].sort()).toEqual(['ApexClass', 'GenAiPlannerBundle']);
    expect(dropped).toEqual([]);
  });
});

describe('buildPackageXml API version floor (profile-safe)', () => {
  it('stamps the profile-safe 62.0 floor into the generated manifest', () => {
    // Pinned at 62.0 to avoid a HIGH-severity vault regression the 64.0 bump
    // caused. NOT because v64 strips Profiles (a co-retrieved Profile is
    // identical at v62/v64) — but because at v64 the org describe surfaces
    // GenAiPlannerBundle, which is un-retrievable until v65 and fails the whole
    // combined retrieve; the fallback then binary-splits the types, separating
    // Profile (and object child types) from CustomObject/ApexClass, and those
    // grants only serialize when co-named — so the split bares them out. 62.0
    // keeps the poison type out of the manifest. See the SF_API_VERSION doc.
    const xml = buildPackageXml(['ApexClass']);
    expect(xml).toContain('<version>62.0</version>');
    expect(xml).not.toContain('<version>64.0</version>');
  });

  it('emits a <types> block for any requested type, stamped at the pinned version', () => {
    // buildPackageXml is version-agnostic XML formatting — it stamps whatever
    // types it is handed. GenAiPlannerBundle is still formatted here even though
    // it is not retrievable at 62.0 (selectManifestTypes drops it when the org
    // describe omits it); the deferral is a version concern, not a formatting one.
    const xml = buildPackageXml(['GenAiPlannerBundle']);
    expect(xml).toContain('<name>GenAiPlannerBundle</name>');
    expect(xml).toContain('<members>*</members>');
    expect(xml).toContain('<version>62.0</version>');
  });

  it('WORKFLOWRULE-RETRIEVED-ZERO: aliases WorkflowRule to the Workflow xmlName in package.xml', () => {
    // The org describe exposes `Workflow`, not `WorkflowRule`. Without the alias
    // selectManifestTypes drops the internal type and the retrieve plane never
    // lands — RM-A14 workflow concepts become un-witnessable / undisclosed.
    const xml = buildPackageXml(['WorkflowRule']);
    expect(xml).toContain('<name>Workflow</name>');
    expect(xml).not.toContain('<name>WorkflowRule</name>');
  });
});

describe('manifestMembersForType', () => {
  it('names standard objects for CustomObject so they get modeled (not just custom * objects)', () => {
    const members = manifestMembersForType('CustomObject');
    expect(members).toContain('*');
    expect(members).toContain('Account');
    expect(members).toContain('Contact');
    expect(members).toContain('Case');
  });

  it('uses only * for non-CustomObject types', () => {
    expect(manifestMembersForType('ApexClass')).toEqual(['*']);
    expect(manifestMembersForType('Flow')).toEqual(['*']);
  });

  it('prunes named standard objects the org lacks when a describeGlobal set is supplied (26c103e guard)', () => {
    // Regression guard: 26c103e named eleven Field Service objects (and `Order`
    // predates it) unconditionally. In an org without those features enabled
    // the object is ABSENT, and naming an absent member makes the CustomObject
    // retrieve fragile. With an org-object set the named list is intersected
    // with it — absent objects drop out, `*` and present objects stay.
    const orgObjects = new Set(['Account', 'Contact', 'Case', 'ServiceResource']);
    const members = manifestMembersForType('CustomObject', orgObjects);
    expect(members).toContain('*');
    expect(members).toContain('Account');
    expect(members).toContain('ServiceResource');
    // Absent (Field Service not enabled): must NOT be named.
    expect(members).not.toContain('WorkOrder');
    expect(members).not.toContain('Order');
    // Only `*` plus the four that exist — nothing the org lacks.
    expect(members).toEqual(['*', 'Account', 'Contact', 'Case', 'ServiceResource']);
  });

  it('names the full standard list when no describeGlobal set is supplied (legacy null-safe path)', () => {
    // Undefined/null orgObjects preserves the pre-guard behaviour so a
    // describe-blind refresh still models the common standard objects.
    const members = manifestMembersForType('CustomObject');
    expect(members).toContain('WorkOrder');
    expect(members).toContain('Order');
    expect(manifestMembersForType('CustomObject', null)).toEqual(members);
  });
});

describe('computeChangeSummary', () => {
  it('treats a null previous manifest as the first refresh', () => {
    const cs = computeChangeSummary(null, manifest({ components: { Flow: 3 } }));
    expect(cs.previousRefreshedAt).toBeNull();
    expect(cs.sourceTreeHashChanged).toBe(true);
  });

  it('reports no change when the source tree hash is identical', () => {
    const prev = manifest({ sourceTreeHash: 'same', components: { Flow: 10 } });
    const next = manifest({ sourceTreeHash: 'same', components: { Flow: 10 } });
    const cs = computeChangeSummary(prev, next);
    expect(cs.sourceTreeHashChanged).toBe(false);
    expect(cs.previousRefreshedAt).toBe(prev.refreshedAt);
  });

  it('computes signed per-type component and edge deltas, nonzero only', () => {
    const prev = manifest({
      sourceTreeHash: 'old',
      components: { Flow: 10, ApexClass: 5, Layout: 7 },
      edges: { callsApex: 100 },
    });
    const next = manifest({
      sourceTreeHash: 'new',
      components: { Flow: 13, ApexClass: 4, Layout: 7 },
      edges: { callsApex: 120, triggersOn: 4 },
    });
    const cs = computeChangeSummary(prev, next);
    expect(cs.sourceTreeHashChanged).toBe(true);
    expect(cs.componentDeltas).toEqual({ Flow: 3, ApexClass: -1 }); // Layout unchanged -> omitted
    expect(cs.edgeDeltas).toEqual({ callsApex: 20, triggersOn: 4 });
  });

  it('computes top-line graph metrics N vs N-1 with non-zero deltas after a change (P9-regression-on-refresh)', () => {
    const prev = manifest({
      sourceTreeHash: 'old',
      components: { Flow: 10, ApexClass: 5 }, // 15 total
      edges: { callsApex: 100 }, // 100 total
    });
    const next = manifest({
      sourceTreeHash: 'new',
      components: { Flow: 13, ApexClass: 4 }, // 17 total
      edges: { callsApex: 120, triggersOn: 4 }, // 124 total
    });
    const cs = computeChangeSummary(prev, next);
    expect(cs.graphMetrics.components).toEqual({ previous: 15, current: 17, delta: 2 });
    expect(cs.graphMetrics.edges).toEqual({ previous: 100, current: 124, delta: 24 });
    expect(cs.graphMetrics.components.delta).not.toBe(0);
    expect(cs.graphMetrics.edges.delta).not.toBe(0);
  });

  it('reports current totals against a zero baseline on the first refresh', () => {
    const cs = computeChangeSummary(
      null,
      manifest({ components: { Flow: 3 }, edges: { callsApex: 9 } }),
    );
    expect(cs.graphMetrics.components).toEqual({ previous: 0, current: 3, delta: 3 });
    expect(cs.graphMetrics.edges).toEqual({ previous: 0, current: 9, delta: 9 });
  });
});

describe('buildRefreshPulse (P9-refresh-pulse)', () => {
  it('emits a graph headline + flow / PII / governor watch-lines for the moved domains', () => {
    const prev = manifest({
      sourceTreeHash: 'old',
      components: { Flow: 5, CustomField: 100, ApexClass: 10 },
      edges: { callsApex: 50 },
    });
    const next = manifest({
      sourceTreeHash: 'new',
      components: { Flow: 8, CustomField: 112, ApexClass: 11, ApexTrigger: 2 },
      edges: { callsApex: 60 },
    });
    const pulse = buildRefreshPulse(computeChangeSummary(prev, next));
    const text = pulse.highlights.join('\n');
    expect(text).toMatch(/Graph .* components, .* edges/);
    expect(text).toMatch(/Flows \+3/);
    expect(text).toMatch(/CustomField \+12[^\n]*pii_inventory/i);
    expect(text).toMatch(/governor_limit_risks/);
    // total component delta = (8+112+11+2) - (5+100+10) = 133 - 115 = 18
    expect(pulse.graphMetrics.components.delta).toBe(18);
  });

  it('flags nothing review-worthy when no flows / fields / apex changed', () => {
    const prev = manifest({ sourceTreeHash: 'old', components: { Layout: 5 }, edges: {} });
    const next = manifest({
      sourceTreeHash: 'new',
      components: { Layout: 7 },
      edges: { usedInLayout: 3 },
    });
    const pulse = buildRefreshPulse(computeChangeSummary(prev, next));
    expect(pulse.highlights).toHaveLength(2);
    expect(pulse.highlights.join('\n')).toMatch(/nothing flagged/i);
  });
});

describe('objectsToExpandManifest (B29 auto-expansion)', () => {
  const mkNode = (id: string): Node => ({
    id,
    type: 'CustomObject',
    apiName: id.includes(':') ? id.slice(id.indexOf(':') + 1) : id,
    label: null,
    parentId: null,
    sourcePath: '',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  });
  const mkEdge = (edgeType: Edge['edgeType'], toId: string): Edge => ({
    fromId: 'ApexTrigger:T',
    toId,
    edgeType,
    confidence: 'declared',
    source: 'test',
    properties: {},
  });

  it('expands a CustomObject referenced by automation but not retrieved (dedup, sorted)', () => {
    const results: ExtractionResult[] = [
      {
        nodes: [mkNode('ApexTrigger:T'), mkNode('CustomObject:Retrieved__c')],
        edges: [
          mkEdge('triggersOn', 'CustomObject:Admissions_Template__c'), // phantom
          mkEdge('writesTo', 'CustomObject:Admissions_Template__c'), // dup -> once
          mkEdge('readsFrom', 'CustomObject:Demo_History__c'), // phantom
          mkEdge('triggersOn', 'CustomObject:Retrieved__c'), // has a node -> skip
        ],
      },
    ];
    expect(objectsToExpandManifest(results)).toEqual([
      'Admissions_Template__c',
      'Demo_History__c',
    ]);
  });

  it('does NOT expand objects referenced only by grants or containment (no platform-object bloat)', () => {
    const results: ExtractionResult[] = [
      {
        nodes: [mkNode('Profile:Admin')],
        edges: [
          mkEdge('grantedBy', 'CustomObject:Platform_System_Thing'), // grant-only
          mkEdge('parentOf', 'CustomObject:Some_Child__c'), // containment
        ],
      },
    ];
    expect(objectsToExpandManifest(results)).toEqual([]);
  });

  it('ignores automation edges that target fields, not objects', () => {
    const results: ExtractionResult[] = [
      {
        nodes: [mkNode('ApexClass:Svc')],
        edges: [mkEdge('readsFrom', 'CustomField:Demo__c.Field__c')],
      },
    ];
    expect(objectsToExpandManifest(results)).toEqual([]);
  });

  // CHANGEEVENT-EXPANSION-NEVER-CONVERGES. A Change Data Capture entity reaches
  // this gate on TWO automation edges — a channel member's `references` and an
  // Apex CDC trigger's `triggersOn` — but the platform synthesises it and the
  // Metadata API emits no component, so a retrieve can NEVER create the node.
  // Naming it meant every refresh re-requested the same entity and logged the
  // same warning, forever: the phantom could not converge.
  it('FAIL-BEFORE/PASS-AFTER: never expands a ChangeEvent entity (no refresh can retrieve one)', () => {
    const results: ExtractionResult[] = [
      {
        nodes: [mkNode('ApexTrigger:T')],
        edges: [
          // Standard CDC, via a channel member's declared reference.
          mkEdge('references', 'CustomObject:AccountChangeEvent'),
          // Custom CDC, via an Apex CDC trigger's declared object binding.
          mkEdge('triggersOn', 'CustomObject:Order__ChangeEvent'),
          // A managed CDC stream — same rule, namespaced.
          mkEdge('references', 'CustomObject:ns__Widget__ChangeEvent'),
          // A genuinely retrievable phantom must STILL be expanded.
          mkEdge('triggersOn', 'CustomObject:Admissions_Template__c'),
        ],
      },
    ];
    expect(objectsToExpandManifest(results)).toEqual(['Admissions_Template__c']);
  });

  it('CONVERGENCE: a vault whose only phantoms are ChangeEvents asks for nothing', () => {
    const results: ExtractionResult[] = [
      {
        nodes: [mkNode('ApexTrigger:T')],
        edges: [
          mkEdge('triggersOn', 'CustomObject:ContactChangeEvent'),
          mkEdge('references', 'CustomObject:CaseChangeEvent'),
        ],
      },
    ];
    // The invariant: the request set is EMPTY, so a second refresh over the same
    // extraction cannot re-request anything — the loop terminates.
    expect(objectsToExpandManifest(results)).toEqual([]);
    expect(objectsToExpandManifest(results)).toEqual(objectsToExpandManifest(results));
  });

  it('a real custom object whose name merely CONTAINS ChangeEvent is still expanded', () => {
    const results: ExtractionResult[] = [
      {
        nodes: [mkNode('ApexTrigger:T')],
        // `__c` makes it a retrievable custom object, not a CDC stream.
        edges: [mkEdge('triggersOn', 'CustomObject:ChangeEvent_Log__c')],
      },
    ];
    expect(objectsToExpandManifest(results)).toEqual(['ChangeEvent_Log__c']);
  });
});

describe('buildFolderedReportManifest', () => {
  const folders = [
    { Name: 'Sales Reports', DeveloperName: 'Sales_Reports' },
    { Name: 'Exec Dashboards', DeveloperName: 'Exec_Dashboards' },
  ];

  it('maps each filed record to a FolderDeveloperName/DeveloperName member', () => {
    const m = buildFolderedReportManifest({
      folders,
      reports: [{ DeveloperName: 'Pipeline', FolderName: 'Sales Reports' }],
      dashboards: [{ DeveloperName: 'KPIs', FolderName: 'Exec Dashboards' }],
    });
    expect(m.membersByType.Report).toEqual(['Sales_Reports/Pipeline']);
    expect(m.membersByType.Dashboard).toEqual(['Exec_Dashboards/KPIs']);
    expect(m.reports).toBe(1);
    expect(m.dashboards).toBe(1);
    // package.xml carries one <types> block per non-empty type, with the
    // explicit folder-qualified members and the metadata <name>.
    expect(m.manifestXml).toContain('<members>Sales_Reports/Pipeline</members>');
    expect(m.manifestXml).toContain('<name>Report</name>');
    expect(m.manifestXml).toContain('<members>Exec_Dashboards/KPIs</members>');
    expect(m.manifestXml).toContain('<name>Dashboard</name>');
    expect(m.manifestXml).toContain('<Package xmlns="http://soap.sforce.com/2006/04/metadata">');
  });

  it('skips records whose folder label maps to no retrievable folder (unfiled / personal)', () => {
    const m = buildFolderedReportManifest({
      folders,
      reports: [
        { DeveloperName: 'Pipeline', FolderName: 'Sales Reports' },
        { DeveloperName: 'MyPrivate', FolderName: 'My Personal Custom Reports' },
      ],
      dashboards: [],
    });
    // Only the filed report survives; the personal-folder one is dropped.
    expect(m.membersByType.Report).toEqual(['Sales_Reports/Pipeline']);
    expect(m.reports).toBe(1);
  });

  it('skips records missing DeveloperName or FolderName', () => {
    const m = buildFolderedReportManifest({
      folders,
      reports: [
        { FolderName: 'Sales Reports' }, // no DeveloperName
        { DeveloperName: 'Orphan' }, // no FolderName
      ],
      dashboards: [],
    });
    expect(m.membersByType.Report).toEqual([]);
    expect(m.reports).toBe(0);
  });

  it('emits only the non-empty <types> blocks', () => {
    const m = buildFolderedReportManifest({
      folders,
      reports: [{ DeveloperName: 'Pipeline', FolderName: 'Sales Reports' }],
      dashboards: [],
    });
    expect(m.manifestXml).toContain('<name>Report</name>');
    expect(m.manifestXml).not.toContain('<name>Dashboard</name>');
  });

  it('returns manifestXml=null when nothing resolves (no retrieve to run)', () => {
    const m = buildFolderedReportManifest({ folders: [], reports: [], dashboards: [] });
    expect(m.reports).toBe(0);
    expect(m.dashboards).toBe(0);
    expect(m.manifestXml).toBeNull();
  });
});

describe('countLandedReportMembers (P14-USAGE-reports-retrieve-fidelity)', () => {
  it('counts a requested member as landed only when its meta file exists', () => {
    const fidelity = countLandedReportMembers(
      { Report: ['Sales_Reports/Pipeline', 'Sales_Reports/Ghost'], Dashboard: [] },
      ['/vault/source/unpackaged/reports/Sales_Reports/Pipeline.report-meta.xml'],
    );
    expect(fidelity.Report.requested).toBe(2);
    expect(fidelity.Report.landed).toBe(1);
    // The dropped member is named, so the refresh can disclose WHAT was not checked.
    expect(fidelity.Report.missing).toEqual(['Sales_Reports/Ghost']);
  });

  it('does not let leftover files from earlier pulls inflate the landed count', () => {
    const fidelity = countLandedReportMembers(
      { Report: ['Sales_Reports/Pipeline'], Dashboard: [] },
      [
        '/vault/source/unpackaged/reports/Sales_Reports/Pipeline.report-meta.xml',
        // Lingers from a previous pull — NOT requested this run.
        '/vault/source/unpackaged/reports/Old_Folder/Stale.report-meta.xml',
      ],
    );
    expect(fidelity.Report.requested).toBe(1);
    expect(fidelity.Report.landed).toBe(1);
    expect(fidelity.Report.missing).toEqual([]);
  });

  it('keys nested Lightning folders relative to the reports/ segment', () => {
    const fidelity = countLandedReportMembers(
      { Report: ['Parent/Child/Quarterly'], Dashboard: [] },
      ['/vault/source/unpackaged/reports/Parent/Child/Quarterly.report-meta.xml'],
    );
    expect(fidelity.Report.landed).toBe(1);
  });

  it('keeps Report and Dashboard suffixes separate', () => {
    const fidelity = countLandedReportMembers(
      { Report: ['F/Same'], Dashboard: ['F/Same'] },
      ['/v/source/dashboards/F/Same.dashboard-meta.xml'],
    );
    // Only the dashboard landed — the report file is absent.
    expect(fidelity.Dashboard.landed).toBe(1);
    expect(fidelity.Report.landed).toBe(0);
    expect(fidelity.Report.missing).toEqual(['F/Same']);
  });
});

describe('formatReportsCapSummary (P14-USAGE-reports-retrieve-fidelity)', () => {
  it('surfaces silent per-member drops as "did not land — not checked"', () => {
    const lines = formatReportsCapSummary({
      reports: { total: 412, requested: 412, retrieved: 412 },
      dashboards: { total: 83, requested: 83, retrieved: 78 },
    });
    const text = lines.join('\n');
    expect(text).toContain('Dashboards: 78/83 requested landed (org total 83)');
    expect(text).toContain('5 requested member(s) did not land — not checked');
  });

  it('keeps the beyond-cap tail disclosure when the org exceeds the cap', () => {
    const lines = formatReportsCapSummary({
      reports: { total: 900, requested: 500, retrieved: 500 },
      dashboards: { total: 10, requested: 10, retrieved: 10 },
    });
    const text = lines.join('\n');
    expect(text).toContain('Reports: 500/500 requested landed (org total 900)');
    expect(text).toContain('400 beyond the usage cap stay pending');
    // A fully-delivered type carries no warning note.
    expect(text).toContain('Dashboards: 10/10 requested landed (org total 10)');
    expect(text).not.toContain('Dashboards: 10/10 requested landed (org total 10) —');
  });
});

describe('CR-01 / C1 — shell-injection hardening of the `sf` exec path', () => {
  // TEST B — the config-load chokepoint rejects a poisoned config.json.
  it('loadVaultConfig rejects a poisoned targetOrg before it can reach any `sf` call', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'x" ; rm -rf ~ ; "');
      const r = await loadVaultConfig(cwd);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('not a valid org alias');
        expect(r.error).toContain('config.json');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('loadVaultConfig still accepts a clean unusual-but-valid alias (no legitimate vault is broken)', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'me@my-sandbox.example.com');
      const r = await loadVaultConfig(cwd);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.targetOrg).toBe('me@my-sandbox.example.com');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // TEST C — even a metachar value reaches `sf` as ONE inert argv element, never
  // a shell. Drive runSf with a stub execFile and assert the argv shape.
  it('runSf spawns the bare `sf` binary with the raw value as a single argv element (never a shell)', async () => {
    const seen: { binary?: string; args?: readonly string[]; options?: unknown } = {};
    const stubExecFile = ((binary: string, args: readonly string[], options: unknown) => {
      seen.binary = binary;
      seen.args = args;
      seen.options = options;
      return Promise.resolve({ stdout: '{"result":{}}', stderr: '' });
    }) as unknown as Parameters<typeof runSf>[2];

    const payload = 'x" ; rm -rf ~ ; "';
    const result = await runSf(
      ['data', 'query', '--query', payload, '--target-org', 'legit', '--json'],
      { timeout: 1000 },
      stubExecFile,
    );
    expect(result.stdout).toBe('{"result":{}}');
    // The binary is exactly `sf` — no shell, no concatenated command string.
    expect(seen.binary).toBe('sf');
    // The metachar payload is one verbatim argv element — never split/interpreted.
    expect(seen.args).toContain(payload);
    // And it is NOT wrapped in quotes (that would corrupt the real arg under execFile).
    expect(seen.args).not.toContain(`"${payload}"`);
    // The timeout + SIGTERM kill signal ride along (H8).
    expect(seen.options).toMatchObject({ timeout: 1000, killSignal: 'SIGTERM' });
  });

  // TEST D — the H8 timeout tiers + env overrides are honored by runSf.
  it('runSf forwards the configured timeout + SIGTERM (H8) and never spawns a shell', async () => {
    const captured: { options?: { timeout?: number; killSignal?: string } } = {};
    const stubExecFile = ((_binary: string, _args: readonly string[], options: { timeout?: number; killSignal?: string }) => {
      captured.options = options;
      return Promise.resolve({ stdout: '', stderr: '' });
    }) as unknown as Parameters<typeof runSf>[2];

    await runSf(['org', 'list', '--json'], { timeout: 600_000 }, stubExecFile);
    expect(captured.options?.timeout).toBe(600_000);
    expect(captured.options?.killSignal).toBe('SIGTERM');
  });

  // TEST D (end-to-end kill proof) — Node actually kills a hung child at the
  // timeout, not just sets the option. Real spawn, tiny timeout.
  it('a real child exceeding the timeout is killed (proves the hung-process guard works)', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const started = Date.now();
    await expect(
      run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        timeout: 200,
        killSignal: 'SIGTERM',
      }),
    ).rejects.toMatchObject({ killed: true });
    // Killed within ~1s, nowhere near the child's 60s sleep.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  // TEST C (flag path) — a poisoned `--target-org` flag override is rejected by
  // runRefresh before any `sf` work (defense in depth on the flag seam).
  it('runRefresh rejects a poisoned `--target-org` flag override (defense in depth)', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'legit'); // config is clean; the FLAG is poisoned
      const result = await runRefresh({
        cwd,
        noPull: true,
        targetOrg: 'x" ; rm -rf ~ ; "',
      });
      expect(result.status).toBe('failed');
      expect(result.fatalError).toContain('Invalid Salesforce org alias');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});


describe('PLATFORM-ACCESS-ORACLE — Profile label <-> API-name map at refresh', () => {
  // PRIVACY: every profile below is INVENTED. The real artifact holds the org's
  // own profile names and lives ONLY inside the vault (gitignored) — it must
  // never reach a tracked file, fixture, or test.
  const PROFILE_ID = '00e0x0000000001AAA';

  /** Stub `sf`: answers the two map reads, records the argv it was handed. */
  const mapExec = (
    calls: string[][],
    over: { listed?: unknown; queried?: unknown; throwOn?: string } = {},
  ) =>
    (async (_bin: string, args: readonly string[]) => {
      calls.push([...args]);
      if (over.throwOn !== undefined && args.join(' ').includes(over.throwOn)) {
        throw new Error('sf CLI failed: boom');
      }
      if (args.includes('metadata') && args.includes('-m')) {
        return {
          stdout: JSON.stringify(
            over.listed ?? { result: [{ id: PROFILE_ID, fullName: 'Std_User_Profile' }] },
          ),
          stderr: '',
        };
      }
      return {
        stdout: JSON.stringify(
          over.queried ?? {
            result: { records: [{ Id: PROFILE_ID, Name: 'Standard Widget User' }] },
          },
        ),
        stderr: '',
      };
    }) as unknown as Parameters<typeof buildAndSaveProfileNameMap>[2];

  it('issues exactly the two documented org reads, as bare argv (never a shell)', async () => {
    const cwd = await makeTempCwd();
    try {
      const calls: string[][] = [];
      const r = await buildAndSaveProfileNameMap('test-org', join(cwd, 'org-kb'), mapExec(calls));
      expect(r.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual([
        'org', 'list', 'metadata', '-m', 'Profile', '--target-org', 'test-org', '--json',
      ]);
      expect(calls[1]).toEqual([
        'data', 'query', '--query', 'SELECT Id, Name FROM Profile',
        '--target-org', 'test-org', '--json',
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes the artifact INSIDE the vault (org profile names never leave it)', async () => {
    const cwd = await makeTempCwd();
    try {
      const vaultRoot = join(cwd, 'org-kb');
      await buildAndSaveProfileNameMap('test-org', vaultRoot, mapExec([]));
      const written = join(vaultRoot, 'meta', 'profile-name-map.json');
      expect(await pathExists(written)).toBe(true);
      const raw = await readFile(written, 'utf8');
      expect(raw).toContain('Std_User_Profile');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('is BEST-EFFORT: an org failure returns an error and writes nothing, never throws', async () => {
    const cwd = await makeTempCwd();
    try {
      const vaultRoot = join(cwd, 'org-kb');
      const r = await buildAndSaveProfileNameMap(
        'test-org',
        vaultRoot,
        mapExec([], { throwOn: 'list metadata' }),
      );
      expect(r.ok).toBe(false);
      // No half-written artifact: absent stays absent, and an absent map makes
      // every consumer refuse rather than guess.
      expect(await pathExists(join(vaultRoot, 'meta', 'profile-name-map.json'))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('tolerates an unexpected CLI envelope instead of throwing', async () => {
    const cwd = await makeTempCwd();
    try {
      const r = await buildAndSaveProfileNameMap(
        'test-org',
        join(cwd, 'org-kb'),
        mapExec([], { listed: { result: { unexpected: true } }, queried: { result: {} } }),
      );
      // Structurally empty is a legitimate outcome; it must not be a crash.
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.entries).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('a --no-pull refresh makes NO org call for the map (metadata-only stays offline)', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeConfig(cwd, 'test-org');
      await seedSmallFixture(cwd);
      const seen: string[] = [];
      const result = await runRefresh({
        cwd,
        noPull: true,
        onProgress: (m: string) => seen.push(m),
      });
      expect(result.status).toBe('success');
      // The guard, asserted behaviourally rather than by reading the source.
      expect(seen.some((m) => /Profile label/i.test(m))).toBe(false);
      expect(
        await pathExists(join(cwd, 'org-kb', 'meta', 'profile-name-map.json')),
      ).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// G1 — the side-build swap fails CLOSED, and touches no live-vault file
// =============================================================================

describe('installSideBuildGraph — forced rename failure', () => {
  /** A real, permission-forced rename failure needs a non-root POSIX runner. */
  const canForceEacces = process.platform !== 'win32' && process.getuid?.() !== 0;

  const sha = async (p: string): Promise<string> =>
    createHash('sha256').update(await readFile(p)).digest('hex');

  /** live db + live WAL + a finished `.rebuild` scratch, production layout. */
  const seedSwapFixture = async (
    dir: string,
  ): Promise<{ readonly live: string; readonly rebuild: string }> => {
    await mkdir(dir, { recursive: true });
    const live = join(dir, 'graph.duckdb');
    const rebuild = `${live}.rebuild`;
    await writeFile(live, 'PREVIOUS-BUILD-DATABASE', 'utf8');
    await writeFile(`${live}.wal`, 'COMMITTED-BUT-UNCHECKPOINTED', 'utf8');
    await writeFile(rebuild, 'REBUILT-GRAPH', 'utf8');
    await writeFile(`${rebuild}.wal`, 'REBUILT-GRAPH-WAL', 'utf8');
    return { live, rebuild };
  };

  it.skipIf(!canForceEacces)(
    'returns err and leaves the live database AND its WAL byte-identical',
    async () => {
      const root = await makeTempCwd();
      const dir = join(root, 'graph');
      const { live, rebuild } = await seedSwapFixture(dir);
      const before = { db: await sha(live), wal: await sha(`${live}.wal`) };
      try {
        // Deny writes on the containing directory: rename() fails EACCES, the
        // POSIX stand-in for the Windows holder that blocks the swap.
        await chmod(dir, 0o500);
        const result = await installSideBuildGraph({ liveDbPath: live, rebuildPath: rebuild });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toContain('EACCES');
        expect(result.error).toContain('was NOT replaced');
        expect(result.error).toContain('STALE, not broken');
        expect(result.error).toContain('discarded');
        expect(result.error).toContain('nothing was published');
        // The claim the rejected attempt made AFTER deleting the live WAL.
        expect(result.error).not.toContain('UNCHANGED');
        // The executable form of the message's central claim.
        expect(await sha(live)).toBe(before.db);
        expect(await sha(`${live}.wal`)).toBe(before.wal);
      } finally {
        await chmod(dir, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canForceEacces)(
    'a cleanup that cannot run does not escape the catch (no raw errno reaches the caller)',
    async () => {
      const root = await makeTempCwd();
      const dir = join(root, 'graph');
      const { live, rebuild } = await seedSwapFixture(dir);
      try {
        // The same 0o500 that broke the rename also blocks unlink(), so the
        // best-effort scratch cleanup throws. It must be swallowed.
        await chmod(dir, 0o500);
        const result = await installSideBuildGraph({ liveDbPath: live, rebuildPath: rebuild });
        expect(result.ok).toBe(false);
        expect(await pathExists(rebuild)).toBe(true); // honestly still there
      } finally {
        await chmod(dir, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!canForceEacces)(
    'cleanup removes ONLY the scratch this process created, never a live-vault file',
    async () => {
      const root = await makeTempCwd();
      const liveDir = join(root, 'live');
      const scratchDir = join(root, 'scratch');
      await mkdir(liveDir, { recursive: true });
      await mkdir(scratchDir, { recursive: true });
      const live = join(liveDir, 'graph.duckdb');
      const rebuild = join(scratchDir, 'graph.duckdb.rebuild');
      await writeFile(live, 'PREVIOUS-BUILD-DATABASE', 'utf8');
      await writeFile(`${live}.wal`, 'COMMITTED-BUT-UNCHECKPOINTED', 'utf8');
      await writeFile(rebuild, 'REBUILT-GRAPH', 'utf8');
      await writeFile(`${rebuild}.wal`, 'REBUILT-GRAPH-WAL', 'utf8');
      const before = { db: await sha(live), wal: await sha(`${live}.wal`) };
      try {
        // Only the DESTINATION directory is locked, so the rename still fails
        // but the scratch (in a writable directory) is removable.
        await chmod(liveDir, 0o500);
        const result = await installSideBuildGraph({ liveDbPath: live, rebuildPath: rebuild });
        expect(result.ok).toBe(false);
        expect(await pathExists(rebuild)).toBe(false);
        expect(await pathExists(`${rebuild}.wal`)).toBe(false);
        expect(await sha(live)).toBe(before.db);
        expect(await sha(`${live}.wal`)).toBe(before.wal);
      } finally {
        await chmod(liveDir, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  // Platform-independent forced failure (no chmod): a directory as the source
  // makes rename fail ENOTDIR while the live directory stays writable. This is
  // the shape in which the rejected attempt DELETED the live WAL and then
  // reported the vault "UNCHANGED".
  it('a rename failure in a writable directory still leaves the live WAL in place', async () => {
    const root = await makeTempCwd();
    const dir = join(root, 'graph');
    await mkdir(dir, { recursive: true });
    const live = join(dir, 'graph.duckdb');
    const rebuild = `${live}.rebuild`;
    await writeFile(live, 'PREVIOUS-BUILD-DATABASE', 'utf8');
    await writeFile(`${live}.wal`, 'COMMITTED-BUT-UNCHECKPOINTED', 'utf8');
    await mkdir(rebuild);
    try {
      const result = await installSideBuildGraph({ liveDbPath: live, rebuildPath: rebuild });
      expect(result.ok).toBe(false);
      expect(await pathExists(`${live}.wal`)).toBe(true);
      expect(await readFile(`${live}.wal`, 'utf8')).toBe('COMMITTED-BUT-UNCHECKPOINTED');
      expect(await readFile(live, 'utf8')).toBe('PREVIOUS-BUILD-DATABASE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the success path still swaps the file in', async () => {
    const root = await makeTempCwd();
    const dir = join(root, 'graph');
    const { live, rebuild } = await seedSwapFixture(dir);
    try {
      const result = await installSideBuildGraph({ liveDbPath: live, rebuildPath: rebuild });
      expect(result.ok).toBe(true);
      expect(await readFile(live, 'utf8')).toBe('REBUILT-GRAPH');
      expect(await pathExists(rebuild)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('graphSwapFailureMessage', () => {
  const CAUSE =
    "Error: EPERM: operation not permitted, rename '/v/org-kb/graph/graph.duckdb.rebuild' -> '/v/org-kb/graph/graph.duckdb'";
  const msg = graphSwapFailureMessage('/v/org-kb/graph/graph.duckdb', CAUSE, true);

  it('does not claim a discard when the scratch cleanup itself failed', () => {
    // The permission that broke the rename can break the cleanup too. Saying
    // "discarded" there names a file the user would then find on disk.
    const kept = graphSwapFailureMessage('/v/org-kb/graph/graph.duckdb', CAUSE, false);
    expect(kept).not.toContain('was discarded');
    expect(kept).toContain('graph.duckdb.rebuild');
    expect(msg).toContain('discarded');
  });

  it('names the resolve index as overwritten, and no longer asks for a manual delete', () => {
    // Still overwritten from the discarded build — the path is dirname-based,
    // so both builds collide in one directory. That fact is unchanged.
    expect(msg).toContain('resolve-index.json');
    // Never the original untruth: a blanket "this costs a rebuild, never a
    // wrong answer" was falsified by execution.
    expect(msg).not.toContain('never a wrong answer');
    // 0.3.3: the artifact now carries a fingerprint of the graph it was built
    // from, so a stale one is REJECTED rather than accepted on a matching node
    // count. The message must not keep telling the user to hand-delete a file
    // to avoid a wrong answer that can no longer happen — a stale remedy
    // teaches fragility the product does not have.
    expect(msg).not.toMatch(/Delete .*resolve-index\.json/i);
    expect(msg).toMatch(/no action is needed/i);
  });

  it('keeps the underlying cause and never names a discarded path as usable', () => {
    expect(msg).toContain('EPERM: operation not permitted');
    // The scratch is cleaned, so pointing the user at it would be a lie.
    expect(msg).not.toContain('.rebuild and will be');
  });

  // The remedy is DERIVED from the platform, so assert the branch this runner
  // actually took rather than stubbing `process.platform`.
  it.skipIf(process.platform !== 'win32')('tells a Windows user to close the MCP client', () => {
    expect(msg).toContain('close your MCP client');
  });

  it.skipIf(process.platform === 'win32')(
    'tells a POSIX user to stop the holder — never that the refresh recovers automatically',
    () => {
      expect(msg).toContain('stop it and re-run the refresh');
      // `lockConflictMessage`'s POSIX branch says the refresh "handles this
      // AUTOMATICALLY" — false where that automatic swap is what just failed.
      expect(msg).not.toContain('AUTOMATICALLY');
    },
  );
});

describe('side-build trigger classification', () => {
  const locked = (message: string) =>
    ({ ok: false, error: { kind: 'locked', message } }) as Parameters<
      typeof isLockedOpenFailure
    >[0];
  const openFailed = (message: string) =>
    ({ ok: false, error: { kind: 'open-failed', message } }) as Parameters<
      typeof isLockedOpenFailure
    >[0];

  it('routes on the kind store.ts assigned, not on the message text', () => {
    // The RAW Windows string, which the replaced regex did not match at all.
    const windowsRaw =
      'IO Error: Cannot open file "x": The process cannot access the file because it is being used by another process';
    expect(/locked|Conflicting lock/i.test(windowsRaw)).toBe(false);
    expect(isLockedOpenFailure(locked(windowsRaw))).toBe(true);
  });

  it('does not route a non-lock failure that merely contains the word "locked"', () => {
    const decoy = 'cannot open graph at /v/g.duckdb: file is locked by the OS installer';
    expect(/locked|Conflicting lock/i.test(decoy)).toBe(true); // the old rule fired
    expect(isLockedOpenFailure(openFailed(decoy))).toBe(false);
  });
});

describe('G1 source invariants (the CTO objection, pinned)', () => {
  const src = async (): Promise<string> =>
    readFile(new URL('../../src/commands/refresh.ts', import.meta.url), 'utf8');

  it('no second copy of the lock classifier survives in refresh.ts', async () => {
    const text = await src();
    expect(text).not.toContain('/locked|Conflicting lock/i');
    expect(text).toContain("error.kind === 'locked'");
  });

  it('refresh.ts never rm()s a LIVE vault WAL — only the .rebuild scratch it owns', async () => {
    const text = await src();
    // The exact line the CTO rejected.
    expect(text).not.toContain('${paths.graphDb}.wal');
    // And nothing else interpolates a WAL path that is not our own scratch.
    const interpolated = [...text.matchAll(/\$\{([A-Za-z.]+)\}\.wal/g)].map((m) => m[1]);
    expect(interpolated.length).toBeGreaterThan(0);
    expect([...new Set(interpolated)].sort()).toEqual(['graphTarget', 'rebuildPath']);
  });
});
