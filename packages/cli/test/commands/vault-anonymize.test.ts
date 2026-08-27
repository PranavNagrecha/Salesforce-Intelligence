/// <reference types="vitest/globals" />

/**
 * Tests for `sfi vault anonymize` (R6-20).
 *
 * Covers the pure transform functions (identity scrub, pseudonym mapping
 * determinism, mapping-table separation), an integration test against a tiny
 * synthetic org-kb fixture (built here, not read from any real vault),
 * out-dir safety, and a source-vault-untouched assertion.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  anonymizeVault,
  applyReplacements,
  assertMappingPathOutsideOut,
  buildIdentityReplacements,
  buildPseudonymMapping,
  collectVaultIdentities,
  extendedScrubText,
  PSEUDONYMIZE_NOT_IMPLEMENTED_MESSAGE,
  pseudonymFor,
  residualLeakScan,
  validateOutDir,
  writeMappingTable,
} from '../../src/commands/vault-anonymize.js';

// =============================================================================
// Pure transform functions
// =============================================================================

describe('extendedScrubText', () => {
  it('scrubs an email address', () => {
    expect(extendedScrubText('contact admin@example.com for help')).toBe(
      'contact [email] for help',
    );
  });

  it('scrubs a URL', () => {
    expect(extendedScrubText('see https://example.com/path?x=1')).toBe('see [url]');
  });

  it('scrubs a 15/18-char Salesforce record id', () => {
    expect(extendedScrubText('record 003AAAAAAAAAAAAAAA is stale')).toBe('record [id] is stale');
  });

  it('scrubs a phone number', () => {
    expect(extendedScrubText('call 555-867-5309 today')).toBe('call [phone] today');
    expect(extendedScrubText('call (555) 867-5309 today')).toBe('call [phone] today');
  });

  it('leaves ordinary component API names alone', () => {
    expect(extendedScrubText('Custom_Field__c and Account.Industry')).toBe(
      'Custom_Field__c and Account.Industry',
    );
  });
});

describe('buildIdentityReplacements', () => {
  it('maps a single identity to the fixed placeholder redacted-org', () => {
    const map = buildIdentityReplacements(['acme-prod']);
    expect(map.get('acme-prod')).toBe('redacted-org');
  });

  it('maps multiple distinct identities to indexed placeholders in sorted order', () => {
    const map = buildIdentityReplacements(['zeta-org', 'alpha-org']);
    expect(map.get('alpha-org')).toBe('redacted-org-1');
    expect(map.get('zeta-org')).toBe('redacted-org-2');
  });

  it('deduplicates repeated identities', () => {
    const map = buildIdentityReplacements(['acme-prod', 'acme-prod']);
    expect(map.size).toBe(1);
  });

  it('drops empty-string identities', () => {
    const map = buildIdentityReplacements(['', 'acme-prod']);
    expect(map.size).toBe(1);
  });

  it('is deterministic regardless of input order', () => {
    const a = buildIdentityReplacements(['zeta-org', 'alpha-org']);
    const b = buildIdentityReplacements(['alpha-org', 'zeta-org']);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

describe('applyReplacements', () => {
  it('replaces every literal occurrence of an identity string', () => {
    const map = buildIdentityReplacements(['acme-prod']);
    const out = applyReplacements('org=acme-prod; alias also acme-prod here', map);
    expect(out).toBe('org=redacted-org; alias also redacted-org here');
  });

  it('does not touch text containing no identity match', () => {
    const map = buildIdentityReplacements(['acme-prod']);
    expect(applyReplacements('nothing to see here', map)).toBe('nothing to see here');
  });

  it('is case-sensitive (an alias\'s casing is part of its identity)', () => {
    const map = buildIdentityReplacements(['Acme-Prod']);
    expect(applyReplacements('acme-prod stays; Acme-Prod goes', map)).toBe(
      'acme-prod stays; redacted-org goes',
    );
  });
});

describe('validateOutDir', () => {
  it('rejects --out equal to the source vault', () => {
    const r = validateOutDir('/a/org-kb', '/a/org-kb');
    expect(r.ok).toBe(false);
  });

  it('rejects --out nested inside the source vault', () => {
    const r = validateOutDir('/a/org-kb', '/a/org-kb/shared');
    expect(r.ok).toBe(false);
  });

  it('rejects --out that CONTAINS the source vault (the reverse mistake)', () => {
    const r = validateOutDir('/a/org-kb', '/a');
    expect(r.ok).toBe(false);
  });

  it('accepts a sibling directory', () => {
    const r = validateOutDir('/a/org-kb', '/a/shared-copy');
    expect(r.ok).toBe(true);
  });

  it('accepts a completely unrelated directory', () => {
    const r = validateOutDir('/a/org-kb', '/tmp/somewhere-else');
    expect(r.ok).toBe(true);
  });
});

// The `validateOutDir` block above compares IDENTICAL spellings on both sides,
// which is why the suite stayed green while both rails failed OPEN on a
// case-insensitive filesystem. The three suites below pin the two ways a rail
// can be wrong in opposite directions: too LOOSE (case drift walks past it) and
// too TIGHT (canonicalizing both sides through realpath stops seeing a
// SYMLINKED vault). The fix must be both at once, so both are asserted here.

// -----------------------------------------------------------------------------
// A. The symlinked-vault layout. `realpathSync` resolves symlinks as well as
// case, so a rail built on canonicalization ALONE flips the reverse check from
// REFUSE to ALLOW: canonical(out) = `Proj/`, canonical(src) = `/real/vault/`,
// no prefix relation left to see. Both spellings have to be tested.
// -----------------------------------------------------------------------------
describe('validateOutDir — symlinked vault (the rail canonicalization alone destroys)', () => {
  let root: string;
  let vault: string; // the SYMLINK, which is how the CLI is handed a vault root

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sfi-anon-symlink-'));
    mkdirSync(join(root, 'real', 'vault'), { recursive: true });
    writeFileSync(join(root, 'real', 'vault', 'config.json'), '{}');
    mkdirSync(join(root, 'Proj'), { recursive: true });
    symlinkSync(join(root, 'real', 'vault'), join(root, 'Proj', 'org-kb'), 'dir');
    vault = join(root, 'Proj', 'org-kb');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses an --out that CONTAINS the vault symlink (`sfi vault anonymize --out .`)', () => {
    // THE case. `--out` is the directory holding the symlink; the redacted
    // "shareable" tree would land next to the real unredacted vault.
    const r = validateOutDir(vault, join(root, 'Proj'));
    expect(r.ok).toBe(false);
  });

  it('refuses an --out nested inside the vault symlink', () => {
    expect(validateOutDir(vault, join(vault, 'redacted')).ok).toBe(false);
  });

  it('refuses an --out that contains the symlink TARGET', () => {
    // Nothing lexical connects `Proj/org-kb` to `real/`; only the canonicalized
    // family sees this one.
    expect(validateOutDir(vault, join(root, 'real')).ok).toBe(false);
  });

  it('still accepts a genuine sibling that does not exist yet', () => {
    expect(validateOutDir(vault, join(root, 'elsewhere')).ok).toBe(true);
  });

  it('mirrors all four through assertMappingPathOutsideOut', () => {
    const mappingUnderVault = join(vault, 'mapping.json');
    expect(() => assertMappingPathOutsideOut(mappingUnderVault, join(root, 'Proj'))).toThrow(
      /must be OUTSIDE/,
    );
    expect(() =>
      assertMappingPathOutsideOut(join(vault, 'redacted', 'mapping.json'), join(vault, 'redacted')),
    ).toThrow(/must be OUTSIDE/);
    // Resolves to `real/vault/mapping.json`, i.e. inside `--out`.
    expect(() => assertMappingPathOutsideOut(mappingUnderVault, join(root, 'real'))).toThrow(
      /must be OUTSIDE/,
    );
    expect(() =>
      assertMappingPathOutsideOut(mappingUnderVault, join(root, 'elsewhere')),
    ).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
// B. The shape above, stated as the general rule, because it is the layout THIS
// repo ships: `org-kb` in the working tree is a symlink to the real vault, so
// `--out .` from the project root is the everyday spelling of the mistake.
// -----------------------------------------------------------------------------
describe('validateOutDir — a vault reached through a symlink is still contained by its parent', () => {
  it('refuses --out = the symlink’s parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'sfi-anon-repo-shape-'));
    try {
      mkdirSync(join(root, 'elsewhere', 'the-real-vault'), { recursive: true });
      mkdirSync(join(root, 'project'), { recursive: true });
      symlinkSync(join(root, 'elsewhere', 'the-real-vault'), join(root, 'project', 'org-kb'), 'dir');
      expect(validateOutDir(join(root, 'project', 'org-kb'), join(root, 'project')).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// C. Case divergence — the defect itself. `vaultRoot` comes from the stored
// config while `--out` is resolved against the current cwd, so the two can
// differ in CASE, and both NTFS and default APFS are case-INSENSITIVE.
// -----------------------------------------------------------------------------
const caseProbeRoot = mkdtempSync(join(tmpdir(), 'sfi-anon-case-'));
mkdirSync(join(caseProbeRoot, 'Proj', 'org-kb'), { recursive: true });
/** True on APFS/NTFS; false on a case-sensitive ext4 CI runner. */
const caseInsensitiveFs = existsSync(join(caseProbeRoot, 'proj', 'ORG-KB'));

afterAll(async () => {
  await rm(caseProbeRoot, { recursive: true, force: true });
});

describe('validateOutDir — case-divergent spellings', () => {
  const vault = join(caseProbeRoot, 'Proj', 'org-kb');
  const vaultOtherCase = join(caseProbeRoot, 'proj', 'ORG-KB');

  it.skipIf(!caseInsensitiveFs)('refuses an --out that IS the vault in another case', () => {
    expect(validateOutDir(vault, vaultOtherCase).ok).toBe(false);
  });

  it.skipIf(!caseInsensitiveFs)('refuses an --out nested in the vault spelled in another case', () => {
    expect(validateOutDir(vault, join(vaultOtherCase, 'redacted')).ok).toBe(false);
  });

  it.skipIf(!caseInsensitiveFs)(
    'refuses a mapping table inside --out spelled in another case',
    () => {
      expect(() =>
        assertMappingPathOutsideOut(join(vaultOtherCase, 'mapping.json'), vault),
      ).toThrow(/must be OUTSIDE/);
    },
  );

  it('still rejects the same-case nesting and equality, and allows a sibling', () => {
    expect(validateOutDir(vault, join(vault, 'redacted')).ok).toBe(false);
    expect(validateOutDir(vault, vault).ok).toBe(false);
    expect(validateOutDir(vault, join(caseProbeRoot, 'redacted-out')).ok).toBe(true);
    expect(() =>
      assertMappingPathOutsideOut(join(caseProbeRoot, 'mapping.json'), vault),
    ).not.toThrow();
  });

  // The fold-case backstop, asserted UNCONDITIONALLY: these paths do not exist,
  // so `realpathSync` cannot canonicalize them and the case-folded family is
  // the only thing left holding the rail. Same situation as EACCES on an
  // ancestor, or a case-insensitive mount on a case-sensitive OS.
  it('refuses case-variant containment even where realpath cannot help', () => {
    expect(validateOutDir('/a/ORG-KB', '/a/org-kb/redacted').ok).toBe(false);
    expect(validateOutDir('/a/org-kb', '/a/ORG-KB').ok).toBe(false);
    expect(validateOutDir('/a/org-kb', '/A').ok).toBe(false);
    expect(() => assertMappingPathOutsideOut('/a/org-kb/mapping.json', '/a/ORG-KB')).toThrow(
      /must be OUTSIDE/,
    );
  });

  // The documented cost of that backstop, pinned so it is a decision and not a
  // surprise: on a case-SENSITIVE filesystem two directories differing only in
  // case are refused as if they were one. Refusing costs "pick another
  // directory"; allowing writes a redacted-but-real vault into the live vault.
  it('accepts the false positive that costs on a case-sensitive filesystem', () => {
    expect(validateOutDir('/a/org-kb', '/a/ORG-KB/shared').ok).toBe(false);
  });
});

// =============================================================================
// pseudonymize building blocks — NOT wired end-to-end (see module doc), but
// the deterministic transform functions are built + tested here.
// =============================================================================

describe('pseudonymFor', () => {
  it('produces the illustrative Custom_Field_0042__c shape for a __c field', () => {
    expect(pseudonymFor('Some_Real_Field__c', 42)).toBe('Custom_Field_0042__c');
  });

  it('labels custom metadata, platform event, big object, and external object suffixes distinctly', () => {
    expect(pseudonymFor('Some__mdt', 1)).toBe('Custom_Metadata_0001__mdt');
    expect(pseudonymFor('Some__e', 2)).toBe('Custom_Event_0002__e');
    expect(pseudonymFor('Some__b', 3)).toBe('Custom_Big_Object_0003__b');
    expect(pseudonymFor('Some__x', 4)).toBe('Custom_External_0004__x');
  });

  it('falls back to a generic label for a suffix-less custom component (e.g. a Flow name)', () => {
    expect(pseudonymFor('My_Flow', 0)).toBe('Custom_Component_0000');
  });
});

describe('buildPseudonymMapping', () => {
  it('is deterministic regardless of input order (same SET of names)', () => {
    const a = buildPseudonymMapping(['Zeta__c', 'Alpha__c', 'Mid__c']);
    const b = buildPseudonymMapping(['Alpha__c', 'Mid__c', 'Zeta__c']);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('assigns distinct pseudonyms to distinct names, sorted before indexing', () => {
    const map = buildPseudonymMapping(['Zeta__c', 'Alpha__c']);
    expect(map.get('Alpha__c')).toBe('Custom_Field_0000__c');
    expect(map.get('Zeta__c')).toBe('Custom_Field_0001__c');
  });

  it('deduplicates repeated names', () => {
    const map = buildPseudonymMapping(['Same__c', 'Same__c']);
    expect(map.size).toBe(1);
  });
});

describe('assertMappingPathOutsideOut / writeMappingTable — mapping-table separation', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sfi-anon-mapping-'));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('throws when the mapping path is INSIDE --out', () => {
    const outDir = join(tempDir, 'shared-out');
    expect(() => assertMappingPathOutsideOut(join(outDir, 'mapping.json'), outDir)).toThrow(
      /must be OUTSIDE/,
    );
  });

  it('throws when the mapping path equals --out itself', () => {
    const outDir = join(tempDir, 'shared-out-2');
    expect(() => assertMappingPathOutsideOut(outDir, outDir)).toThrow(/must be OUTSIDE/);
  });

  it('does not throw for a mapping path outside --out', () => {
    const outDir = join(tempDir, 'shared-out-3');
    expect(() =>
      assertMappingPathOutsideOut(join(tempDir, 'owner-only', 'mapping.json'), outDir),
    ).not.toThrow();
  });

  it('writeMappingTable writes sorted, deterministic JSON to a path outside --out', async () => {
    const outDir = join(tempDir, 'shared-out-4');
    const mappingPath = join(tempDir, 'owner-only-4', 'mapping.json');
    const mapping = buildPseudonymMapping(['Zeta__c', 'Alpha__c']);
    await writeMappingTable(mapping, mappingPath, outDir);
    const raw = await readFile(mappingPath, 'utf8');
    const parsed = JSON.parse(raw) as { mode: string; entries: { original: string; pseudonym: string }[] };
    expect(parsed.mode).toBe('pseudonymize');
    expect(parsed.entries.map((e) => e.original)).toEqual(['Alpha__c', 'Zeta__c']);
    // The mapping file must never land under outDir.
    expect(existsSync(join(outDir, 'mapping.json'))).toBe(false);
  });

  it('writeMappingTable rejects a mapping path inside --out (defense in depth)', async () => {
    const outDir = join(tempDir, 'shared-out-5');
    await mkdir(outDir, { recursive: true });
    const mapping = buildPseudonymMapping(['Alpha__c']);
    await expect(
      writeMappingTable(mapping, join(outDir, 'mapping.json'), outDir),
    ).rejects.toThrow(/must be OUTSIDE/);
  });
});

// =============================================================================
// Integration: a tiny synthetic org-kb fixture
// =============================================================================

const ORG_ALIAS = 'unit-test-org';

/** Build a minimal but realistic org-kb tree under `root/org-kb`. Returns the vault root path. */
const seedSyntheticVault = async (root: string): Promise<string> => {
  const vaultRoot = join(root, 'org-kb');
  await mkdir(join(vaultRoot, 'meta'), { recursive: true });
  await mkdir(join(vaultRoot, 'components', 'CustomField', 'Account'), { recursive: true });
  await mkdir(join(vaultRoot, 'docs'), { recursive: true });
  await mkdir(join(vaultRoot, 'source', 'main', 'default', 'classes'), { recursive: true });
  await mkdir(join(vaultRoot, 'graph'), { recursive: true });
  await mkdir(join(vaultRoot, 'snapshots', 'weekly'), { recursive: true });

  await writeFile(
    join(vaultRoot, 'meta', 'config.json'),
    JSON.stringify({
      createdAt: '2026-01-01T00:00:00.000Z',
      targetOrg: ORG_ALIAS,
      vaultRoot,
      version: '0.1.26',
      snapshotOnRefresh: true,
    }),
    'utf8',
  );
  await writeFile(
    join(vaultRoot, 'meta', 'manifest.json'),
    JSON.stringify({
      version: '0.1.26',
      refreshedAt: '2026-01-01T00:00:00.000Z',
      sourceOrg: ORG_ALIAS,
      components: { CustomField: 1 },
      edges: {},
      sourceTreeHash: 'sha256:fixture',
    }),
    'utf8',
  );
  await writeFile(
    join(vaultRoot, 'meta', 'org-card.json'),
    JSON.stringify({
      generatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'org-card',
      targetOrg: ORG_ALIAS,
      totals: { components: 1, edges: 0 },
    }),
    'utf8',
  );
  await writeFile(join(vaultRoot, 'meta', 'version.txt'), '0.1.26', 'utf8');
  await writeFile(
    join(vaultRoot, 'meta', 'history.jsonl'),
    `${JSON.stringify({ refreshedAt: '2026-01-01T00:00:00.000Z', totalComponents: 1 })}\n`,
    'utf8',
  );

  // A component file whose description contains the org alias, an email, and
  // a phone number — exercises both the identity replacement AND the generic
  // scrub in one file, mirroring how a real vault's rendered markdown looks.
  await writeFile(
    join(vaultRoot, 'components', 'CustomField', 'Account', 'Notes__c.md'),
    [
      '---',
      'apiName: Notes__c',
      `description: Set up by admin@${ORG_ALIAS}.example.com for the ${ORG_ALIAS} rollout, call 555-201-3040`,
      '---',
      '',
      `# Notes__c — deployed for ${ORG_ALIAS}, see https://${ORG_ALIAS}.my.salesforce.com/setup`,
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(vaultRoot, 'docs', 'org-card.md'),
    `# Org card — ${ORG_ALIAS}\n\nGenerated for ${ORG_ALIAS}.\n`,
    'utf8',
  );

  await writeFile(
    join(vaultRoot, 'source', 'main', 'default', 'classes', 'Notes.cls'),
    `// deployed to ${ORG_ALIAS} by admin@${ORG_ALIAS}.example.com\npublic class Notes {}\n`,
    'utf8',
  );

  // A fake binary asset — must be EXCLUDED, not scrubbed.
  await writeFile(
    join(vaultRoot, 'source', 'main', 'default', 'classes', 'logo.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );

  // graph/ + snapshots/ — must NEVER be copied, regardless of content.
  await writeFile(join(vaultRoot, 'graph', 'graph.duckdb'), 'not-a-real-duckdb-file-but-should-never-copy', 'utf8');
  await writeFile(join(vaultRoot, 'snapshots', 'weekly', 'nodes.json'), `${ORG_ALIAS}`, 'utf8');

  return vaultRoot;
};

describe('collectVaultIdentities', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sfi-anon-identities-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('errors when org-kb/meta/config.json is missing (not a valid vault)', async () => {
    const r = await collectVaultIdentities(join(root, 'not-a-vault'));
    expect(r.ok).toBe(false);
  });

  it('collects the org alias from config.json / manifest.json / org-card.json', async () => {
    const vaultRoot = await seedSyntheticVault(root);
    const r = await collectVaultIdentities(vaultRoot);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([ORG_ALIAS]);
  });
});

describe('anonymizeVault (integration, synthetic fixture)', () => {
  let root: string;
  let vaultRoot: string;
  let outDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sfi-anon-integration-'));
    vaultRoot = await seedSyntheticVault(root);
    outDir = join(root, 'shared-copy');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses --mode pseudonymize with the documented not-yet-implemented message', async () => {
    const r = await anonymizeVault({ vaultRoot, outDir: join(root, 'pseudo-out'), mode: 'pseudonymize' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(PSEUDONYMIZE_NOT_IMPLEMENTED_MESSAGE);
    // No output directory should have been created for a refused mode.
    expect(existsSync(join(root, 'pseudo-out'))).toBe(false);
  });

  it('refuses an --out inside the source vault before writing anything', async () => {
    const r = await anonymizeVault({
      vaultRoot,
      outDir: join(vaultRoot, 'shared'),
      mode: 'redact',
    });
    expect(r.ok).toBe(false);
  });

  it('copies components/docs/source, scrubbing identity + free text; never copies graph/ or snapshots/', async () => {
    const r = await anonymizeVault({ vaultRoot, outDir, mode: 'redact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // graph/ and snapshots/ must be absent entirely.
    expect(existsSync(join(outDir, 'graph'))).toBe(false);
    expect(existsSync(join(outDir, 'snapshots'))).toBe(false);

    // The component file: identity replaced, email/phone/url scrubbed, API
    // name (Notes__c) KEPT (redact mode).
    const componentOut = await readFile(
      join(outDir, 'components', 'CustomField', 'Account', 'Notes__c.md'),
      'utf8',
    );
    expect(componentOut).not.toContain(ORG_ALIAS);
    expect(componentOut).toContain('redacted-org');
    expect(componentOut).toContain('Notes__c');
    expect(componentOut).toContain('[email]');
    expect(componentOut).toContain('[phone]');
    expect(componentOut).toContain('[url]');

    // docs/ scrubbed the same way.
    const docsOut = await readFile(join(outDir, 'docs', 'org-card.md'), 'utf8');
    expect(docsOut).not.toContain(ORG_ALIAS);
    expect(docsOut).toContain('redacted-org');

    // source/ scrubbed too (redact mode keeps this tree — see module doc).
    const sourceOut = await readFile(
      join(outDir, 'source', 'main', 'default', 'classes', 'Notes.cls'),
      'utf8',
    );
    expect(sourceOut).not.toContain(ORG_ALIAS);
    expect(sourceOut).toContain('redacted-org');
    expect(sourceOut).toContain('[email]');
    expect(sourceOut).toContain('public class Notes {}');

    // The binary asset was excluded, not copied verbatim.
    expect(existsSync(join(outDir, 'source', 'main', 'default', 'classes', 'logo.png'))).toBe(false);
    expect(r.value.filesSkipped.some((f) => f.path.endsWith('logo.png'))).toBe(true);

    // meta/ identity fields structurally replaced.
    const configOut = JSON.parse(
      await readFile(join(outDir, 'meta', 'config.json'), 'utf8'),
    ) as { targetOrg: string; vaultRoot: string };
    expect(configOut.targetOrg).toBe('redacted-org');
    expect(configOut.vaultRoot).toBe('.');
    const manifestOut = JSON.parse(
      await readFile(join(outDir, 'meta', 'manifest.json'), 'utf8'),
    ) as { sourceOrg: string };
    expect(manifestOut.sourceOrg).toBe('redacted-org');
    const orgCardOut = JSON.parse(
      await readFile(join(outDir, 'meta', 'org-card.json'), 'utf8'),
    ) as { targetOrg: string };
    expect(orgCardOut.targetOrg).toBe('redacted-org');

    // A README is generated.
    const readme = await readFile(join(outDir, 'README.md'), 'utf8');
    expect(readme).toContain('mode: redact');
    expect(readme).toContain('graph/');

    // The residual scan finds nothing left over.
    expect(r.value.residualScan.findings).toEqual([]);
  });

  it('leaves the SOURCE vault completely untouched', async () => {
    // Re-run against a FRESH outDir to avoid interference with the prior test.
    const secondOut = join(root, 'shared-copy-2');
    const before = (await readdir(join(vaultRoot, 'components', 'CustomField', 'Account'))).sort();
    const beforeContent = await readFile(
      join(vaultRoot, 'components', 'CustomField', 'Account', 'Notes__c.md'),
      'utf8',
    );
    const r = await anonymizeVault({ vaultRoot, outDir: secondOut, mode: 'redact' });
    expect(r.ok).toBe(true);
    const after = (await readdir(join(vaultRoot, 'components', 'CustomField', 'Account'))).sort();
    const afterContent = await readFile(
      join(vaultRoot, 'components', 'CustomField', 'Account', 'Notes__c.md'),
      'utf8',
    );
    expect(after).toEqual(before);
    expect(afterContent).toBe(beforeContent);
    expect(afterContent).toContain(ORG_ALIAS); // still the REAL alias — source untouched
  });
});

describe('residualLeakScan', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sfi-anon-residual-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports 0 findings for a fully-scrubbed tree', async () => {
    const dir = join(root, 'clean');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), 'redacted-org, nothing identifying here', 'utf8');
    const result = await residualLeakScan(dir, ['acme-real-org']);
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  it('flags a file where the original identity string survived', async () => {
    const dir = join(root, 'leaky-identity');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), 'still mentions acme-real-org here', 'utf8');
    const result = await residualLeakScan(dir, ['acme-real-org']);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.pattern === 'identity-literal')).toBe(true);
  });

  it('flags a file with an un-scrubbed email (generic-pattern idempotency check)', async () => {
    const dir = join(root, 'leaky-email');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), 'contact person@example.com', 'utf8');
    const result = await residualLeakScan(dir, []);
    expect(result.findings.some((f) => f.pattern === 'generic-pii-pattern')).toBe(true);
  });

  it('discloses 0 local org-name patterns checked when no local config path is given', async () => {
    const dir = join(root, 'no-local-config');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.md'), 'redacted-org', 'utf8');
    const result = await residualLeakScan(dir, []);
    expect(result.localOrgNamePatternsChecked).toBe(0);
  });
});
