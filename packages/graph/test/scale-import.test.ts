/// <reference types="vitest/globals" />
/**
 * v4.0 R9 — scale proof: batched import of ~10k nodes stays within budget.
 *
 * Documents the tested ceiling for POSITIONING/README (not aspirational).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { initSchema } from '../src/schema.js';
import type { GraphStore } from '../src/store.js';

/** Documented v4.0 import budget (ms) for 10k nodes on CI hardware. */
export const SCALE_IMPORT_NODE_COUNT = 10_000;
export const SCALE_IMPORT_BUDGET_MS = Number(
  process.env.SCALE_IMPORT_BUDGET_MS ?? '90000',
);

const makeNode = (i: number): Node => ({
  id: `CustomField:ScaleObj.F_${i}__c`,
  type: 'CustomField',
  apiName: `F_${i}__c`,
  label: `Field ${i}`,
  parentId: 'CustomObject:ScaleObj',
  sourcePath: 'objects/ScaleObj/fields/F_' + i + '__c.field-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-scale-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('scale import (v4.0 R9)', () => {
  it(
    `imports ${SCALE_IMPORT_NODE_COUNT} nodes within ${SCALE_IMPORT_BUDGET_MS}ms`,
    async () => {
      const dbPath = join(tempDir, 'scale-10k.db');
      const instance = await DuckDBInstance.create(dbPath);
      const connection = await instance.connect();
      const initResult = await initSchema(connection);
      expect(initResult.ok).toBe(true);
      const store: GraphStore = { connection, instance };

      const nodes = Array.from({ length: SCALE_IMPORT_NODE_COUNT }, (_, i) =>
        makeNode(i),
      );
      const started = performance.now();
      const imported = await importExtractionResults(store, [{ nodes, edges: [] }]);
      const elapsed = performance.now() - started;

      connection.disconnectSync();
      instance.closeSync();

      expect(imported.ok).toBe(true);
      if (imported.ok) {
        expect(imported.value.nodesInserted).toBe(SCALE_IMPORT_NODE_COUNT);
      }
      expect(elapsed).toBeLessThan(SCALE_IMPORT_BUDGET_MS);
    },
    SCALE_IMPORT_BUDGET_MS + 30_000,
  );
});
