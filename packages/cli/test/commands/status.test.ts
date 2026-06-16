/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { computeSourceTreeHash } from '@sf-intelligence/vault';

import {
  ageInDays,
  DEFAULT_STALE_AGE_DAYS,
  formatAge,
  isStaleByAge,
  renderSkippedTable,
  renderStatusTable,
  runStatus,
  type StatusOutput,
} from '../../src/commands/status.js';

const makeTempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-status-'));

/** Helper: lay down the canonical vault tree under `${cwd}/org-kb` with the
 *  given config/manifest contents. `manifest === null` skips manifest.json. */
const writeVault = async (
  cwd: string,
  opts: { readonly manifest: VaultManifest | null; readonly sourceFiles: ReadonlyArray<readonly [string, string]> },
): Promise<{ readonly vaultRoot: string }> => {
  const vaultRoot = join(cwd, 'org-kb');
  for (const sub of ['source', 'components', 'graph', 'meta']) {
    await mkdir(join(vaultRoot, sub), { recursive: true });
  }
  await writeFile(
    join(vaultRoot, 'meta', 'config.json'),
    JSON.stringify({ targetOrg: 'test', vaultRoot, version: '0.1.0', createdAt: '2026-05-27T00:00:00.000Z' }),
    'utf8',
  );
  await writeFile(join(vaultRoot, 'meta', 'version.txt'), '0.1.0\n', 'utf8');
  for (const [relPath, content] of opts.sourceFiles) {
    const full = join(vaultRoot, 'source', relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  if (opts.manifest !== null) {
    await writeFile(
      join(vaultRoot, 'meta', 'manifest.json'),
      JSON.stringify(opts.manifest, null, 2),
      'utf8',
    );
  }
  return { vaultRoot };
};

const baseManifest = (sourceTreeHash: string): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T10:00:00.000Z',
  sourceOrg: 'test-org',
  components: { CustomObject: 3, CustomField: 12 },
  edges: { parentOf: 12 },
  sourceTreeHash,
});

describe('runStatus', () => {
  it('returns no-vault when no config.json exists', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await runStatus({ cwd });
      expect(result.kind).toBe('no-vault');
      expect(result.message).toContain('sfi init');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns no-manifest when config exists but manifest does not', async () => {
    const cwd = await makeTempCwd();
    try {
      await writeVault(cwd, { manifest: null, sourceFiles: [] });
      const result = await runStatus({ cwd });
      expect(result.kind).toBe('no-manifest');
      expect(result.message).toContain('sfi refresh');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns fresh when the manifest hash matches the actual source hash', async () => {
    const cwd = await makeTempCwd();
    try {
      // Stage source files first, then compute the real hash and write the
      // manifest with that hash — guarantees fresh.
      const sourceFiles: ReadonlyArray<readonly [string, string]> = [
        ['objects/Account/Account.object-meta.xml', '<xml/>\n'],
        ['objects/Contact/Contact.object-meta.xml', '<xml/>\n'],
      ];
      const { vaultRoot } = await writeVault(cwd, { manifest: null, sourceFiles });
      const hashResult = await computeSourceTreeHash(join(vaultRoot, 'source'));
      expect(hashResult.ok).toBe(true);
      if (!hashResult.ok) return;
      const manifest = baseManifest(hashResult.value);
      await writeFile(join(vaultRoot, 'meta', 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const result = await runStatus({ cwd });
      expect(result.kind).toBe('fresh');
      expect(result.manifest?.sourceOrg).toBe('test-org');
      expect(result.manifest?.components['CustomObject']).toBe(3);
      expect(result.currentSourceHash).toBe(hashResult.value);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns stale when the manifest hash differs from the actual source hash', async () => {
    const cwd = await makeTempCwd();
    try {
      // Manifest claims a hash that won't match anything plausible.
      const manifest = baseManifest('deadbeef'.repeat(8));
      await writeVault(cwd, {
        manifest,
        sourceFiles: [['objects/Account/Account.object-meta.xml', '<xml/>\n']],
      });
      const result = await runStatus({ cwd });
      expect(result.kind).toBe('stale');
      expect(result.message).toContain('STALE');
      expect(result.currentSourceHash).not.toBe(manifest.sourceTreeHash);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('StatusOutput is JSON-round-trip-stable for table mode', async () => {
    const cwd = await makeTempCwd();
    try {
      const manifest = baseManifest('cafefeed'.repeat(8));
      await writeVault(cwd, {
        manifest,
        sourceFiles: [['x.xml', 'hi\n']],
      });
      const result = await runStatus({ cwd });
      // `--json` writes JSON.stringify(result, null, 2); we verify the same
      // result round-trips through that serialiser without information loss.
      const json = JSON.stringify(result, null, 2);
      const parsed = JSON.parse(json) as StatusOutput;
      expect(parsed.kind).toBe(result.kind);
      expect(parsed.message).toBe(result.message);
      expect(parsed.manifest?.sourceOrg).toBe(manifest.sourceOrg);
      expect(parsed.manifest?.sourceTreeHash).toBe(manifest.sourceTreeHash);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('formatAge', () => {
  it('formats seconds, minutes, hours, days', () => {
    const now = new Date('2026-05-27T12:00:00Z');
    expect(formatAge('2026-05-27T11:59:30Z', now)).toBe('30 seconds ago');
    expect(formatAge('2026-05-27T11:55:00Z', now)).toBe('5 minutes ago');
    expect(formatAge('2026-05-27T11:00:00Z', now)).toBe('1 hour ago');
    expect(formatAge('2026-05-25T12:00:00Z', now)).toBe('2 days ago');
  });

  it('falls back to the raw string on unparseable input', () => {
    expect(formatAge('not-a-date')).toBe('not-a-date');
  });
});

describe('ageInDays / isStaleByAge (FRESH-01 time-based staleness)', () => {
  const now = new Date('2026-05-27T12:00:00Z');

  it('ageInDays counts whole days, floors partials, and clamps negatives to 0', () => {
    expect(ageInDays('2026-05-12T12:00:00Z', now)).toBe(15);
    expect(ageInDays('2026-05-27T00:00:00Z', now)).toBe(0); // < 1 day
    expect(ageInDays('2026-06-01T12:00:00Z', now)).toBe(0); // future → clamped
    expect(ageInDays('not-a-date', now)).toBeNull();
  });

  it('isStaleByAge warns only past the threshold; default is 14 days', () => {
    expect(DEFAULT_STALE_AGE_DAYS).toBe(14);
    // 20 days old → stale; 3 days old → fresh.
    expect(isStaleByAge('2026-05-07T12:00:00Z', now)).toBe(true);
    expect(isStaleByAge('2026-05-24T12:00:00Z', now)).toBe(false);
    // Exactly at the threshold is NOT yet stale (strictly greater-than).
    expect(isStaleByAge('2026-05-13T12:00:00Z', now)).toBe(false);
    // A custom threshold is honored.
    expect(isStaleByAge('2026-05-24T12:00:00Z', now, 2)).toBe(true);
    // Unparseable timestamps never raise a false alarm.
    expect(isStaleByAge('not-a-date', now)).toBe(false);
  });
});

describe('renderSkippedTable (architectural-bug-fix observability)', () => {
  it('renders only the message when no manifest is present', () => {
    const out: StatusOutput = { kind: 'no-vault', message: 'No vault. Run init.' };
    const rendered = renderSkippedTable(out);
    expect(rendered).toBe('No vault. Run init.\n');
  });

  it('reports the all-covered case when the manifest carries an empty skip map', () => {
    const manifest = {
      ...baseManifest('abc'.repeat(22).slice(0, 64)),
      skippedDirectories: {},
    };
    const out: StatusOutput = { kind: 'fresh', message: 'Vault is fresh.', manifest };
    const rendered = renderSkippedTable(out);
    expect(rendered).toContain('No skipped directories');
  });

  it('handles older manifests lacking skippedDirectories as the empty case (back-compat)', () => {
    const manifest = baseManifest('abc'.repeat(22).slice(0, 64));
    const out: StatusOutput = { kind: 'fresh', message: 'Vault is fresh.', manifest };
    const rendered = renderSkippedTable(out);
    expect(rendered).toContain('No skipped directories');
  });

  it('renders the skip inventory sorted by descending count, with total', () => {
    const manifest = {
      ...baseManifest('abc'.repeat(22).slice(0, 64)),
      skippedDirectories: {
        omniProcesses: 244,
        omniDataTransforms: 201,
        weirdType: 11,
      },
    };
    const out: StatusOutput = { kind: 'fresh', message: 'Vault is fresh.', manifest };
    const rendered = renderSkippedTable(out);
    expect(rendered).toContain('Vault skipped 456 files in 3 directory types');
    // Top entry is the highest-count one.
    const lines = rendered.split('\n');
    const omniProcLine = lines.findIndex((l) => l.startsWith('omniProcesses'));
    const omniDTLine = lines.findIndex((l) => l.startsWith('omniDataTransforms'));
    const weirdLine = lines.findIndex((l) => l.startsWith('weirdType'));
    expect(omniProcLine).toBeGreaterThan(0);
    expect(omniProcLine).toBeLessThan(omniDTLine);
    expect(omniDTLine).toBeLessThan(weirdLine);
    expect(rendered).toContain('244 files');
    expect(rendered).toContain('11 files');
  });

  it('uses the singular form for single-file directories', () => {
    const manifest = {
      ...baseManifest('abc'.repeat(22).slice(0, 64)),
      skippedDirectories: { loneDir: 1 },
    };
    const out: StatusOutput = { kind: 'fresh', message: 'Vault is fresh.', manifest };
    const rendered = renderSkippedTable(out);
    expect(rendered).toContain('1 directory type');
    expect(rendered).toContain('1 file');
    // The plural form should NOT appear in the inventory body.
    expect(rendered).not.toContain('1 files');
  });
});

describe('renderStatusTable', () => {
  it('renders the message only when no manifest is present', () => {
    const out: StatusOutput = { kind: 'no-vault', message: 'No vault. Run init.' };
    const rendered = renderStatusTable(out);
    expect(rendered).toBe('No vault. Run init.\n');
  });

  it('renders header rows, components, and edges when a manifest is present', () => {
    const now = new Date('2026-05-27T12:00:00Z');
    const manifest = baseManifest('abc12345abc12345abc12345abc12345abc12345abc12345abc12345abc12345');
    const out: StatusOutput = {
      kind: 'fresh',
      message: 'Vault is fresh.',
      manifest,
      currentSourceHash: manifest.sourceTreeHash,
    };
    const rendered = renderStatusTable(out, now);
    expect(rendered).toContain('Vault state');
    expect(rendered).toContain('test-org');
    expect(rendered).toContain('abc12345abc1...');
    expect(rendered).toContain('CustomObject:');
    expect(rendered).toContain('parentOf:');
    expect(rendered).toContain('Vault is fresh.');
  });
});
