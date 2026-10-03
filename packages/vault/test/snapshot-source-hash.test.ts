/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sourceFileHash } from '../src/snapshot.js';

/**
 * The snapshot source hash is what `omni_changed_since` compares. A metadata
 * file is one file; a Vlocity DataPack is a folder whose sibling JSON files
 * hold the component's large fields — editing one changes the component, so it
 * must change the hash. Synthetic Acme names.
 */

let vaultRoot: string;

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'sfi-source-hash-'));
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

const write = (rel: string, body: string): void => {
  const abs = join(vaultRoot, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body, 'utf8');
};

describe('sourceFileHash', () => {
  it('hashes a metadata file by its own bytes', async () => {
    write('source/main/default/omniScripts/Acme_Intake_English_1.os-meta.xml', '<OmniScript/>');
    const a = await sourceFileHash(vaultRoot, 'source/main/default/omniScripts/Acme_Intake_English_1.os-meta.xml');
    write('source/main/default/omniScripts/Other.os-meta.xml', '<OmniScript>other</OmniScript>');
    const b = await sourceFileHash(vaultRoot, 'source/main/default/omniScripts/Acme_Intake_English_1.os-meta.xml');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // A neighbouring file is another component — it does not move this hash.
    expect(b).toBe(a);
  });

  it('covers every file of a DataPack folder, so a sibling edit changes the hash', async () => {
    const main = 'source/vlocity/OmniScript/Acme_Intake_English/Acme_Intake_English_DataPack.json';
    write(main, '{"Name":"Acme Intake"}');
    write('source/vlocity/OmniScript/Acme_Intake_English/Acme_Intake_English_PropertySet.json', '{"a":1}');
    const before = await sourceFileHash(vaultRoot, main);
    write('source/vlocity/OmniScript/Acme_Intake_English/Acme_Intake_English_PropertySet.json', '{"a":2}');
    const after = await sourceFileHash(vaultRoot, main);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    // Deterministic: the same folder hashes the same.
    expect(await sourceFileHash(vaultRoot, main)).toBe(after);
  });

  it('returns undefined for a missing source rather than a hash of nothing', async () => {
    expect(await sourceFileHash(vaultRoot, 'source/vlocity/OmniScript/Gone/Gone_DataPack.json')).toBeUndefined();
    expect(await sourceFileHash(vaultRoot, '')).toBeUndefined();
  });
});
