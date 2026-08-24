/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults, relativizeSourcePath } from '../src/import.js';
import { getNodeById } from '../src/queries.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

describe('relativizeSourcePath', () => {
  it('strips an absolute vault path to vault-relative (the real leak case)', () => {
    expect(
      relativizeSourcePath(
        '/home/dev/proj/org-kb/source/main/default/classes/X.cls',
      ),
    ).toBe('source/main/default/classes/X.cls');
  });

  it('falls back to the DX source/ marker when there is no org-kb segment', () => {
    expect(relativizeSourcePath('/home/ci/work/source/main/default/objects/A.object-meta.xml')).toBe(
      'source/main/default/objects/A.object-meta.xml',
    );
  });

  it('normalizes Windows separators', () => {
    expect(
      relativizeSourcePath('C:\\Users\\me\\proj\\org-kb\\source\\main\\default\\classes\\X.cls'),
    ).toBe('source/main/default/classes/X.cls');
  });

  it('leaves an already-relative path unchanged', () => {
    expect(relativizeSourcePath('source/main/default/classes/X.cls')).toBe(
      'source/main/default/classes/X.cls',
    );
  });

  it('does not contain an absolute home path after relativizing', () => {
    const out = relativizeSourcePath(
      '/home/dev/myorg/org-kb/source/main/default/flows/F.flow-meta.xml',
    );
    expect(out.includes('/home/')).toBe(false);
    expect(out.startsWith('/')).toBe(false);
  });

  it('returns the empty string unchanged', () => {
    expect(relativizeSourcePath('')).toBe('');
  });
});

describe('importExtractionResults — path sanitization', () => {
  let tempDir: string;
  let store: GraphStore;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-relativize-'));
    const instance = await DuckDBInstance.create(join(tempDir, 'r.db'));
    const connection = await instance.connect();
    const init = await initSchema(connection);
    if (!init.ok) throw new Error(init.error.message);
    store = { connection, instance };
    const seed: ExtractionResult = {
      nodes: [
        {
          id: 'ApexClass:X',
          type: 'ApexClass',
          apiName: 'X',
          label: 'X',
          parentId: null,
          sourcePath:
            '/home/dev/proj/org-kb/source/main/default/classes/X.cls',
          lastModifiedDate: null,
          lastModifiedBy: null,
          apiVersion: null,
          properties: {},
        } satisfies Node,
      ],
      edges: [],
    };
    const imp = await importExtractionResults(store, [seed]);
    if (!imp.ok) throw new Error(imp.error.message);
  });

  afterAll(() => {
    store.connection.disconnectSync();
    store.instance.closeSync();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('persists a vault-relative sourcePath, never the absolute local path', async () => {
    const r = await getNodeById(store, 'ApexClass:X');
    expect(r.ok).toBe(true);
    if (!r.ok || r.value === null) return;
    expect(r.value.sourcePath).toBe('source/main/default/classes/X.cls');
    expect(r.value.sourcePath.includes('/home/')).toBe(false);
  });
});
