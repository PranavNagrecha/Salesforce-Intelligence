/// <reference types="vitest/globals" />

/**
 * P7-vault-registry — hardening tests for the multi-root REGISTRY-LOCATION
 * contract (`findRegistryFile` / `findRegistryRoot`). These pin the
 * `SF_INTELLIGENCE_REGISTRY_PATH` precedence (existing directory → its
 * `registry.json`; any other value → that exact path verbatim; unset → walk up
 * for a `registry.json`, else the co-resident default) that every cross-vault
 * tool and the CLI resolve through.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { findRegistryFile, findRegistryRoot, registryPath } from '../src/registry.js';

const ENV = 'SF_INTELLIGENCE_REGISTRY_PATH';
let saved: string | undefined;
let dir: string;

beforeEach(() => {
  saved = process.env[ENV];
  delete process.env[ENV];
  dir = mkdtempSync(join(tmpdir(), 'sfi-reg-res-'));
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('findRegistryFile — SF_INTELLIGENCE_REGISTRY_PATH precedence', () => {
  it('env set to an existing DIRECTORY → the registry.json inside it', () => {
    process.env[ENV] = dir; // a real directory
    expect(findRegistryFile(join(dir, 'some', 'vault'))).toBe(join(dir, 'registry.json'));
  });

  it('env set to a FILE path → that exact path verbatim (even a non-registry.json name)', () => {
    const file = join(dir, 'single-registry.json');
    writeFileSync(file, '{}');
    process.env[ENV] = file;
    // Must NOT be rewritten to <dir>/registry.json — the eval harness points the
    // env var at a specific file whose name may not be `registry.json`.
    expect(findRegistryFile(join(dir, 'vault'))).toBe(file);
  });

  it('env set to a not-yet-existing path → that exact path verbatim', () => {
    const file = join(dir, 'will-create.json');
    process.env[ENV] = file;
    expect(findRegistryFile(join(dir, 'vault'))).toBe(file);
  });

  it('env unset → walks UP from the vault root to the nearest registry.json', () => {
    const reg = registryPath(dir);
    writeFileSync(reg, '{}');
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    expect(findRegistryFile(join(dir, 'a', 'b'))).toBe(reg);
  });

  it('env unset + no registry.json on the walk → co-resident default beside the vault parent', () => {
    const vault = join(dir, 'org-kb');
    expect(findRegistryFile(vault)).toBe(registryPath(dirname(vault)));
  });
});

describe('findRegistryRoot', () => {
  it('is the containing directory of findRegistryFile', () => {
    process.env[ENV] = dir;
    expect(findRegistryRoot(join(dir, 'vault'))).toBe(dir);
  });
});
