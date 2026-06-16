/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractInstalledPackage } from '../src/installed-package.js';

const REAL_SHAPE = `<?xml version="1.0" encoding="UTF-8"?>
<InstalledPackage xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <activateRSS xsi:nil="true"/>
    <versionNumber>8.293</versionNumber>
</InstalledPackage>`;

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'sfi-ip-ext-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const writeIp = async (namespace: string, body: string): Promise<string> => {
  const p = join(dir, `${namespace}.installedPackage-meta.xml`);
  await writeFile(p, body, 'utf8');
  return p;
};

describe('extractInstalledPackage', () => {
  it('extracts one node — id/namespace from the filename, version from the body (real-org metadata shape)', async () => {
    const path = await writeIp('APXTConga4', REAL_SHAPE);
    const r = await extractInstalledPackage(path);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.edges).toEqual([]);
    expect(r.value.nodes).toHaveLength(1);
    const n = r.value.nodes[0]!;
    expect(n.id).toBe('InstalledPackage:APXTConga4');
    expect(n.type).toBe('InstalledPackage');
    expect(n.apiName).toBe('APXTConga4');
    expect(n.properties['namespace']).toBe('APXTConga4');
    expect(n.properties['versionNumber']).toBe('8.293');
  });

  it('versionNumber is null (never fabricated) when the element is absent', async () => {
    const path = await writeIp('Beta', '<?xml version="1.0" encoding="UTF-8"?>\n<InstalledPackage xmlns="http://soap.sforce.com/2006/04/metadata"/>');
    const r = await extractInstalledPackage(path);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.nodes[0]!.properties['versionNumber']).toBeNull();
  });

  it('surfaces a malformed root as malformed-input', async () => {
    const path = await writeIp('Bad', '<?xml version="1.0" encoding="UTF-8"?>\n<NotAPackage><x>1</x></NotAPackage>');
    const r = await extractInstalledPackage(path);
    expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.error.kind).toBe('malformed-input');
  });
});
