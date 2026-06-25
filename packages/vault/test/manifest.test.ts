/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';

import { vaultPaths } from '../src/layout.js';
import {
  backfillCoverageInMemory,
  buildCoverageEntries,
  ENTERPRISE_NOT_MODELED_TYPES,
  loadManifest,
  readCoverageEntries,
  readSkippedDirectories,
  saveManifest,
  summarizeCoverage,
  type ExtendedVaultManifest,
} from '../src/manifest.js';

const sampleManifest = (): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 47, CustomField: 312 },
  edges: { parentOf: 312, usedInLayout: 580 },
  sourceTreeHash: 'sha256:abc123',
});

const makeVault = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-vault-'));

describe('saveManifest / loadManifest round-trip', () => {
  it('writes and reads back the same manifest data', async () => {
    const vault = await makeVault();
    try {
      const original = sampleManifest();
      const saved = await saveManifest(vault, original);
      expect(saved.ok).toBe(true);

      const loaded = await loadManifest(vault);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value).toEqual(original);
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe('saveManifest alphabetical key order', () => {
  it('sorts top-level keys alphabetically in the emitted JSON', async () => {
    const vault = await makeVault();
    try {
      // Insert keys in deliberately non-alphabetical insertion order.
      const unordered: VaultManifest = {
        version: '0.1.0',
        sourceTreeHash: 'sha256:zzz',
        refreshedAt: '2026-05-27T14:33:08Z',
        components: { CustomObject: 1 },
        edges: { parentOf: 1 },
        sourceOrg: 'me@example.com',
      };
      const saved = await saveManifest(vault, unordered);
      expect(saved.ok).toBe(true);

      const { manifest: manifestPath } = vaultPaths(vault);
      const text = await readFile(manifestPath, 'utf8');
      const keys = Array.from(text.matchAll(/^ {2}"([^"]+)":/gm), (m) => m[1]);
      const sorted = [...keys].sort();
      expect(keys).toEqual(sorted);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('sorts nested object keys alphabetically as well', async () => {
    const vault = await makeVault();
    try {
      const unordered: VaultManifest = {
        version: '0.1.0',
        refreshedAt: '2026-05-27T14:33:08Z',
        sourceOrg: 'me@example.com',
        components: { CustomObject: 1, CustomField: 2, ApexClass: 3 },
        edges: { usedInLayout: 5, parentOf: 4 },
        sourceTreeHash: 'sha256:abc',
      };
      const saved = await saveManifest(vault, unordered);
      expect(saved.ok).toBe(true);

      const { manifest: manifestPath } = vaultPaths(vault);
      const text = await readFile(manifestPath, 'utf8');
      const componentsKeys = Array.from(
        text.matchAll(/^ {4}"([^"]+)":/gm),
        (m) => m[1],
      );
      const sortedComponents = [...componentsKeys].sort();
      expect(componentsKeys).toEqual(sortedComponents);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe('saveManifest atomic write', () => {
  it('leaves no temp file behind on success', async () => {
    const vault = await makeVault();
    try {
      const saved = await saveManifest(vault, sampleManifest());
      expect(saved.ok).toBe(true);

      const { meta } = vaultPaths(vault);
      const entries = await readdir(meta);
      const tempFiles = entries.filter((name) => name.endsWith('.tmp'));
      expect(tempFiles).toEqual([]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('does not corrupt an existing manifest if a subsequent write fails', async () => {
    const vault = await makeVault();
    try {
      // First, write a known-good manifest.
      const first = sampleManifest();
      const saved = await saveManifest(vault, first);
      expect(saved.ok).toBe(true);

      // Now occupy the temp-file path with a *directory* so the next
      // saveManifest call's writeFile step fails. The canonical manifest
      // path must remain untouched.
      const { manifest: manifestPath } = vaultPaths(vault);
      const blocker = `${manifestPath}.tmp`;
      // The temp suffix is an internal contract; we mirror it here to
      // exercise the failure path without mocking fs.
      await mkdir(blocker);

      const second: VaultManifest = { ...first, sourceTreeHash: 'sha256:different' };
      const result = await saveManifest(vault, second);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('write-failed');
      }

      // Original manifest still loads correctly.
      const loaded = await loadManifest(vault);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value).toEqual(first);
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe('skippedDirectories field (architectural-bug-fix observability)', () => {
  it('round-trips the skippedDirectories field through save/load', async () => {
    const vault = await makeVault();
    try {
      const manifest: ExtendedVaultManifest = {
        ...sampleManifest(),
        skippedDirectories: { omniProcesses: 244, omniDataTransforms: 201 },
      };
      const saved = await saveManifest(vault, manifest);
      expect(saved.ok).toBe(true);

      const loaded = await loadManifest(vault);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.skippedDirectories).toEqual({
          omniProcesses: 244,
          omniDataTransforms: 201,
        });
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('treats a manifest missing skippedDirectories as the empty map (back-compat)', async () => {
    const vault = await makeVault();
    try {
      // Pre-bug-fix manifest shape — no `skippedDirectories` field at all.
      const legacy = sampleManifest();
      const saved = await saveManifest(vault, legacy);
      expect(saved.ok).toBe(true);

      const loaded = await loadManifest(vault);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        // The field is optional and absent in this fixture.
        expect(loaded.value.skippedDirectories).toBeUndefined();
        // `readSkippedDirectories` normalises to the empty map.
        expect(readSkippedDirectories(loaded.value)).toEqual({});
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('readSkippedDirectories returns empty for undefined / missing input', () => {
    expect(readSkippedDirectories(undefined)).toEqual({});
    expect(readSkippedDirectories(sampleManifest())).toEqual({});
  });
});

describe('coverage fields (enterprise trust contract)', () => {
  it('round-trips coverage through save/load', async () => {
    const vault = await makeVault();
    try {
      const manifest: ExtendedVaultManifest = {
        ...sampleManifest(),
        coverageComputedAt: '2026-05-29T12:00:00.000Z',
        coverage: [
          {
            type: 'CustomObject',
            requested: true,
            retrieved: 47,
            errored: false,
            neverModeled: false,
          },
          {
            type: 'Report',
            requested: true,
            retrieved: 0,
            errored: false,
            neverModeled: true,
          },
        ],
      };
      const saved = await saveManifest(vault, manifest);
      expect(saved.ok).toBe(true);

      const loaded = await loadManifest(vault);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.coverageComputedAt).toBe('2026-05-29T12:00:00.000Z');
        expect(readCoverageEntries(loaded.value)).toEqual(manifest.coverage);
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('does not inject phantom not-modeled rows when enterprise types are modeled', () => {
    const entries = buildCoverageEntries(sampleManifest());
    for (const type of ENTERPRISE_NOT_MODELED_TYPES) {
      expect(entries.some((entry) => entry.type === type && entry.neverModeled)).toBe(
        false,
      );
    }
  });

  it('lists each not-modeled type exactly once with a count — single registry, explicit wins over a skipped-dir mapping (P2-notModeled-registry)', () => {
    // A type can be reachable from BOTH an explicit coverage row AND a skipped
    // retrieve subdirectory (e.g. ListView). The registry must collapse them to
    // ONE entry (explicit wins), never a duplicate row; a type reachable only
    // from a skipped dir (CompactLayout) appears once with its retrieved count.
    const manifest: ExtendedVaultManifest = {
      ...sampleManifest(),
      skippedDirectories: { listViews: 84, compactLayouts: 11 },
      coverage: [
        {
          type: 'ListView',
          requested: true,
          retrieved: 84,
          errored: false,
          neverModeled: true,
        },
      ],
    };
    const entries = buildCoverageEntries(manifest);
    // Every type appears exactly once (no duplicate registry rows).
    const types = entries.map((entry) => entry.type);
    expect(types.length).toBe(new Set(types).size);
    // ListView (explicit + skipped dir) collapses to one entry, with its count.
    const listView = entries.filter((entry) => entry.type === 'ListView');
    expect(listView).toHaveLength(1);
    expect(listView[0]?.retrieved).toBe(84);
    expect(listView[0]?.neverModeled).toBe(true);
    // CompactLayout (skipped dir only) is present once, with its count.
    const compact = entries.filter((entry) => entry.type === 'CompactLayout');
    expect(compact).toHaveLength(1);
    expect(compact[0]?.retrieved).toBe(11);
    expect(compact[0]?.neverModeled).toBe(true);
  });

  it('summarizes requested partial and not-modeled coverage', () => {
    const manifest: ExtendedVaultManifest = {
      ...sampleManifest(),
      coverage: [
        {
          type: 'CustomObject',
          requested: true,
          retrieved: 47,
          errored: false,
          neverModeled: false,
        },
        {
          type: 'Flow',
          requested: true,
          retrieved: 0,
          errored: true,
          errorReason: 'retrieve failed',
          neverModeled: false,
        },
      ],
    };

    const summary = summarizeCoverage(manifest, ['CustomObject', 'Flow', 'Report']);
    expect(summary.coverageKnown).toBe(true);
    expect(summary.status).toBe('partial');
    expect(summary.coveredTypes).toEqual(['CustomObject']);
    expect(summary.partialTypes).toEqual(['Flow', 'Report']);
    expect(summary.notModeledTypes).toEqual([]);
    expect(summary.missingCoverage).toEqual(['Flow', 'Report']);
  });

  it('treats a requested empty type as NOT-RETRIEVED (partial), never complete (C2)', () => {
    // C2 / Systemic #1: a type that was requested but whose retrieve pulled
    // NOTHING (`retrieved: 0`, no error) is byte-identical on disk to "the org
    // genuinely has none of this type". The coverage data model cannot prove
    // "confirmed zero" vs "silently dropped", so the honest classification is
    // partial / not-confirmed — never a false "complete" + covered. (Used to
    // assert the bug: status 'complete', coveredTypes including the empty type.)
    const manifest: ExtendedVaultManifest = {
      ...sampleManifest(),
      coverage: [
        {
          type: 'CustomObject',
          requested: true,
          retrieved: 47,
          errored: false,
          neverModeled: false,
        },
        {
          type: 'Report',
          requested: true,
          retrieved: 0,
          errored: false,
          neverModeled: false,
        },
      ],
    };

    const summary = summarizeCoverage(manifest, ['CustomObject', 'Report']);
    expect(summary.status).toBe('partial');
    expect(summary.coveredTypes).toEqual(['CustomObject']);
    expect(summary.partialTypes).toEqual(['Report']);
    expect(summary.notModeledTypes).toEqual([]);
    expect(summary.missingCoverage).toContain('Report');
  });

  it('marks the live-repro shape (CustomObject covered, Role/SharingRule/LWC/Aura retrieved:0) as partial (C2)', () => {
    // The verified live repro: a vault with Roles/sharing-rules/LWC/Aura ON
    // DISK whose coverage rows nonetheless show retrieved:0 must NOT report
    // "complete". Each empty modeled family flows into partial + missingCoverage
    // and stays OUT of notModeledTypes (guards the a4 I3 notModeled-set check).
    const manifest: ExtendedVaultManifest = {
      ...sampleManifest(),
      coverage: [
        { type: 'CustomObject', requested: true, retrieved: 47, errored: false, neverModeled: false },
        { type: 'Role', requested: true, retrieved: 0, errored: false, neverModeled: false },
        { type: 'SharingRule', requested: true, retrieved: 0, errored: false, neverModeled: false },
        { type: 'LightningComponentBundle', requested: true, retrieved: 0, errored: false, neverModeled: false },
        { type: 'AuraDefinitionBundle', requested: true, retrieved: 0, errored: false, neverModeled: false },
      ],
    };

    const summary = summarizeCoverage(manifest, [
      'CustomObject',
      'Role',
      'SharingRule',
      'LightningComponentBundle',
      'AuraDefinitionBundle',
    ]);
    expect(summary.status).toBe('partial');
    expect(summary.coveredTypes).toEqual(['CustomObject']);
    expect([...summary.partialTypes].sort()).toEqual([
      'AuraDefinitionBundle',
      'LightningComponentBundle',
      'Role',
      'SharingRule',
    ]);
    expect(summary.notModeledTypes).toEqual([]);
    for (const t of ['Role', 'SharingRule', 'LightningComponentBundle', 'AuraDefinitionBundle']) {
      expect(summary.missingCoverage).toContain(t);
    }
  });

  it('returns status "unknown" (never complete or partial) when the manifest has no coverage array (back-compat)', () => {
    // Pre-v4 manifests carry no `coverage` array. summarizeCoverage must NOT
    // fabricate covered/partial rows for them: a missing field can never become
    // a false "complete", and the new emptyTypes bucket must not invent spurious
    // partial rows. backfillCoverageInMemory only ever synthesizes retrieved>0
    // rows, so a raw (un-backfilled) manifest stays `unknown`.
    const summary = summarizeCoverage(sampleManifest(), ['CustomObject', 'Report']);
    expect(summary.coverageKnown).toBe(false);
    expect(summary.status).toBe('unknown');
    expect(summary.coveredTypes).toEqual([]);
    expect(summary.partialTypes).toEqual([]);
  });

  it('does NOT report complete when a scoped --types refresh left types un-requested (B7)', () => {
    const manifest: ExtendedVaultManifest = {
      ...sampleManifest(),
      coverage: [
        {
          type: 'CustomObject',
          requested: true,
          retrieved: 47,
          errored: false,
          neverModeled: false,
        },
        // A `--types CustomObject` run: Flow is in the manifest but was not
        // requested, so it's genuinely absent from the vault.
        {
          type: 'Flow',
          requested: false,
          retrieved: 0,
          errored: false,
          neverModeled: false,
        },
      ],
    };

    const summary = summarizeCoverage(manifest);
    expect(summary.status).toBe('partial');
    expect(summary.missingCoverage).toContain('Flow');
    expect(summary.coveredTypes).toEqual(['CustomObject']);
  });

  it('puts a never-modeled type in notModeledTypes ONLY, never also in partialTypes', () => {
    const manifest: ExtendedVaultManifest = {
      ...sampleManifest(),
      coverage: [
        {
          type: 'CustomObject',
          requested: true,
          retrieved: 47,
          errored: false,
          neverModeled: false,
        },
        {
          type: 'ListView',
          requested: true,
          retrieved: 0,
          errored: false,
          neverModeled: true,
        },
      ],
    };

    const summary = summarizeCoverage(manifest, ['CustomObject', 'ListView']);
    // The bug: a never-modeled type used to be double-counted into partialTypes
    // (and thus reported as both "partial" and "not modeled" by health_check).
    expect(summary.notModeledTypes).toEqual(['ListView']);
    expect(summary.partialTypes).toEqual([]);
    expect(summary.coveredTypes).toEqual(['CustomObject']);
    // missingCoverage is the documented union — ListView still belongs there once.
    expect(summary.missingCoverage).toEqual(['ListView']);
  });
});

describe('backfillCoverageInMemory', () => {
  it('synthesizes coverage rows from component counts when coverage is absent', () => {
    // Coverage is deliberately absent (omitted, not `undefined` — the manifest
    // type uses exactOptionalPropertyTypes) so backfill has to synthesize it.
    const manifest: ExtendedVaultManifest = {
      ...sampleManifest(),
      components: { CustomObject: 3, ApexClass: 2 },
      skippedDirectories: { listViews: 4 },
    };
    const filled = backfillCoverageInMemory(manifest);
    expect(readCoverageEntries(filled).length).toBeGreaterThan(0);
    expect(summarizeCoverage(filled).coverageKnown).toBe(true);
    const listView = readCoverageEntries(filled).find((e) => e.type === 'ListView');
    expect(listView?.neverModeled).toBe(true);
    expect(listView?.retrieved).toBe(4);
  });

  it('flags ListView as neverModeled when listViews were skipped during refresh', () => {
    const entries = buildCoverageEntries({
      ...sampleManifest(),
      skippedDirectories: { listViews: 12 },
    });
    const listView = entries.find((e) => e.type === 'ListView');
    expect(listView?.neverModeled).toBe(true);
    expect(listView?.retrieved).toBe(12);
  });

  it('is a no-op when coverage already exists', () => {
    const manifest = sampleManifest();
    const withCoverage: ExtendedVaultManifest = {
      ...manifest,
      coverage: [
        {
          type: 'CustomObject',
          requested: true,
          retrieved: 1,
          errored: false,
          neverModeled: false,
        },
      ],
    };
    expect(backfillCoverageInMemory(withCoverage)).toBe(withCoverage);
  });

  it('surfaces every skipped retrieve subdirectory under its canonical ComponentType, never the raw dir name', () => {
    // Regression: backfill used to push raw retrieve subdirectory names
    // (`compactLayouts`, `fieldSets`, `indexes`, `webLinks`) as coverage `type`s —
    // none of which are real ComponentTypes — and duplicated `listViews` alongside
    // the mapped `ListView`. The coverage surface must only ever name ComponentTypes.
    const manifest: ExtendedVaultManifest = {
      ...sampleManifest(),
      components: { CustomObject: 3 },
      skippedDirectories: {
        compactLayouts: 2,
        fieldSets: 1,
        indexes: 1,
        listViews: 4,
        webLinks: 3,
      },
    };
    const entries = readCoverageEntries(backfillCoverageInMemory(manifest));
    const types = entries.map((e) => e.type);

    // No raw retrieve-subdirectory name leaks in as a coverage type.
    for (const rawDir of [
      'compactLayouts',
      'fieldSets',
      'indexes',
      'listViews',
      'webLinks',
    ]) {
      expect(types).not.toContain(rawDir);
    }
    // Each skipped family is surfaced under its canonical ComponentType, exactly once.
    for (const properType of [
      'CompactLayout',
      'FieldSet',
      'Index',
      'ListView',
      'WebLink',
    ]) {
      expect(types.filter((t) => t === properType)).toEqual([properType]);
      expect(entries.find((e) => e.type === properType)?.neverModeled).toBe(true);
    }
  });
});

describe('loadManifest missing-file handling', () => {
  it('returns err with kind "manifest-missing" when the file does not exist', async () => {
    const vault = await makeVault();
    try {
      const result = await loadManifest(vault);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('manifest-missing');
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('returns err with kind "parse-error" when the file is not valid JSON', async () => {
    const vault = await makeVault();
    try {
      const { manifest: manifestPath, meta } = vaultPaths(vault);
      await mkdir(meta, { recursive: true });
      await writeFile(manifestPath, 'not json {{{', 'utf8');

      const result = await loadManifest(vault);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('parse-error');
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
