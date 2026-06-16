/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendAnnotationEvent, readAnnotations, vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';

/**
 * P13-ANNOT-store — the refresh-time ORPHAN report: annotations whose
 * component vanished from the fresh graph surface in the pulse; annotations
 * on live components do not. Annotation-free vaults add nothing.
 */

let cwd: string;
let vaultRoot: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'sfi-annot-orphan-'));
  vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  const dir = join(paths.source, 'main', 'default', 'classes');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'Alpha.cls'), 'public class Alpha {}', 'utf8');
  await writeFile(
    join(dir, 'Alpha.cls-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`,
    'utf8',
  );
  await writeFile(
    paths.config,
    JSON.stringify({
      targetOrg: 'test',
      vaultRoot,
      version: '0.1.0',
      snapshotOnRefresh: false,
      createdAt: '2026-06-04T00:00:00.000Z',
    }),
    'utf8',
  );
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const annotate = async (componentId: string, key: 'note' | 'owner', value: string): Promise<void> => {
  await appendAnnotationEvent(vaultRoot, {
    componentId,
    key,
    value,
    author: 'test',
    source: 'human',
    confirmed: true,
    at: '2026-06-10T00:00:00.000Z',
    op: 'set',
  });
};

describe('refresh-time annotation orphan report', () => {
  it('reports vanished annotated ids in the pulse — live ones excluded; annotations survive', async () => {
    await annotate('ApexClass:Alpha', 'owner', 'Platform');
    await annotate('CustomObject:Vanished__c', 'note', 'was decommissioned');
    const r = await runRefresh({ cwd, noPull: true });
    expect(r.status).toBe('success');
    expect(r.pulse?.annotationOrphans).toEqual(['CustomObject:Vanished__c']);
    expect(
      r.pulse?.highlights.some((h) => h.includes('CustomObject:Vanished__c') && h.includes('annotation')),
    ).toBe(true);
    // the overlay itself is untouched by the refresh — annotations survive
    const after = await readAnnotations(vaultRoot);
    expect(after.length).toBe(2);
  });

  it('an annotation-free vault produces a pulse with NO annotationOrphans key (byte-stable)', async () => {
    const r = await runRefresh({ cwd, noPull: true });
    expect(r.status).toBe('success');
    expect(r.pulse).toBeDefined();
    expect('annotationOrphans' in (r.pulse ?? {})).toBe(false);
  });

  it('all-live annotations produce no orphan key either', async () => {
    await annotate('ApexClass:Alpha', 'note', 'core class');
    const r = await runRefresh({ cwd, noPull: true });
    expect(r.status).toBe('success');
    expect('annotationOrphans' in (r.pulse ?? {})).toBe(false);
  });
});
