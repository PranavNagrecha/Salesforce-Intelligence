/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import { importExtractionResults } from '../src/import.js';
import { countNodesByType } from '../src/queries.js';
import {
  compileGraphQuery,
  runGraphQuery,
  QUERY_GRAPH_MAX_CONDITIONS,
  QUERY_GRAPH_MAX_IN_VALUES,
  QUERY_GRAPH_MAX_LIMIT,
} from '../src/query-graph.js';
import { initSchema } from '../src/schema.js';
import { openGraphServeReadOnly } from '../src/serve-readonly.js';
import { openGraph, openGraphReadOnly } from '../src/store.js';
import { closeGraph, type GraphStore } from '../src/store.js';

let tempDir: string;
let dbPath: string;
let store: GraphStore;

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
  label: 'Account',
  parentId: null,
  sourcePath: 'objects/Account/Account.object-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId'>,
): Edge => ({
  edgeType: 'parentOf',
  confidence: 'declared',
  source: 'extractor:custom-object',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
    makeNode({
      id: 'CustomObject:Opportunity',
      apiName: 'Opportunity',
      label: 'Opportunity',
    }),
    makeNode({
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
      lastModifiedBy: 'someone',
      properties: { dataType: 'Picklist' },
    }),
    makeNode({
      id: 'CustomField:Account.Region__c',
      type: 'CustomField',
      apiName: 'Region__c',
      label: 'Region',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Region__c.field-meta.xml',
      properties: { dataType: 'Text', length: 80 },
    }),
    makeNode({
      id: 'CustomField:Opportunity.Stage__c',
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: 'CustomObject:Opportunity',
      sourcePath: 'objects/Opportunity/fields/Stage__c.field-meta.xml',
      properties: { dataType: 'Picklist' },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
    }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Region__c',
    }),
    makeEdge({
      fromId: 'CustomObject:Opportunity',
      toId: 'CustomField:Opportunity.Stage__c',
    }),
    makeEdge({
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'triggersOn',
      confidence: 'heuristic',
      source: 'extractor:fictional',
      properties: { targetMissing: true },
    }),
  ],
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-graph-query-graph-'));
  dbPath = join(tempDir, 'query-graph.db');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  const initResult = await initSchema(connection);
  if (!initResult.ok) throw new Error(`initSchema failed: ${initResult.error.message}`);
  store = { connection, instance };
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
});

afterAll(() => {
  store.connection.disconnectSync();
  store.instance.closeSync();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// compileGraphQuery — pure, allowlist enforcement
// ---------------------------------------------------------------------------

describe('compileGraphQuery — allowlist + shape', () => {
  it('compiles a scalar-equality node query to a SELECT-only, single statement', () => {
    const r = compileGraphQuery({
      select: 'nodes',
      where: [{ column: 'type', op: '=', value: 'CustomObject' }],
      limit: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sql.startsWith('SELECT ')).toBe(true);
    // A single statement: no embedded semicolon, no stacked query.
    expect(r.value.sql.includes(';')).toBe(false);
    // Value + limit are BOUND, not interpolated.
    expect(r.value.sql).toContain('type = ?');
    expect(r.value.sql.trimEnd().endsWith('LIMIT ?')).toBe(true);
    expect(r.value.params).toEqual(['CustomObject', 10]);
    expect(r.value.displayParams).toEqual(['CustomObject']);
  });

  it('binds a property filter through json_extract_string with a bound JSON path', () => {
    const r = compileGraphQuery({
      select: 'nodes',
      where: [{ column: 'property:dataType', op: '=', value: 'Picklist' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sql).toContain('json_extract_string(properties_json, ?) = ?');
    // The JSON path is param #1 (internal), the value is param #2, limit last.
    expect(r.value.params).toEqual(['$.dataType', 'Picklist', 50]);
    // The internal JSON path is NOT surfaced to the caller.
    expect(r.value.displayParams).toEqual(['Picklist']);
  });

  it('compiles IN to N bound placeholders', () => {
    const r = compileGraphQuery({
      select: 'edges',
      where: [{ column: 'edgeType', op: 'IN', value: ['parentOf', 'triggersOn'] }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sql).toContain('edge_type IN (?, ?)');
    expect(r.value.params).toEqual(['parentOf', 'triggersOn', 50]);
  });

  it('compiles IS NULL / IS NOT NULL with no value', () => {
    const r = compileGraphQuery({
      select: 'nodes',
      where: [{ column: 'lastModifiedBy', op: 'IS NULL' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sql).toContain('last_modified_by IS NULL');
    // Only the limit is bound.
    expect(r.value.params).toEqual([50]);
  });

  it('rejects an unknown column (fail-closed, names the allowlist)', () => {
    const r = compileGraphQuery({
      select: 'nodes',
      where: [{ column: 'properties_json', op: '=', value: 'x' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/unknown column/);
    expect(r.error.message).toMatch(/Allowed columns/);
  });

  it('rejects an edge column used on a node query (per-table allowlist)', () => {
    const r = compileGraphQuery({
      select: 'nodes',
      where: [{ column: 'fromId', op: '=', value: 'x' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown operator', () => {
    const r = compileGraphQuery({
      select: 'nodes',
      // deliberately smuggle a disallowed op past the type system
      where: [{ column: 'type', op: 'OR' as never, value: 'x' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/unknown operator/);
  });

  it('rejects a malformed property key (SQL/path escape attempt)', () => {
    for (const bad of [
      "property:a' OR '1'='1",
      'property:a; DROP TABLE nodes',
      'property:a.b',
      'property:',
      'property:$.a',
    ]) {
      const r = compileGraphQuery({
        select: 'nodes',
        where: [{ column: bad, op: '=', value: 'x' }],
      });
      expect(r.ok, `expected ${bad} to be rejected`).toBe(false);
    }
  });

  it('rejects an over-cap limit, over-cap conditions, and bad IN lists', () => {
    expect(
      compileGraphQuery({ select: 'nodes', limit: QUERY_GRAPH_MAX_LIMIT + 1 }).ok,
    ).toBe(false);
    expect(compileGraphQuery({ select: 'nodes', limit: 0 }).ok).toBe(false);
    expect(compileGraphQuery({ select: 'nodes', limit: 1.5 }).ok).toBe(false);
    expect(
      compileGraphQuery({
        select: 'nodes',
        where: Array.from({ length: QUERY_GRAPH_MAX_CONDITIONS + 1 }, () => ({
          column: 'type' as const,
          op: '=' as const,
          value: 'x',
        })),
      }).ok,
    ).toBe(false);
    expect(
      compileGraphQuery({
        select: 'edges',
        where: [{ column: 'edgeType', op: 'IN', value: [] }],
      }).ok,
    ).toBe(false);
    expect(
      compileGraphQuery({
        select: 'edges',
        where: [
          {
            column: 'edgeType',
            op: 'IN',
            value: Array.from({ length: QUERY_GRAPH_MAX_IN_VALUES + 1 }, (_, i) => `v${i}`),
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it('rejects a scalar op given an array, and a nullary op given a value', () => {
    expect(
      compileGraphQuery({
        select: 'nodes',
        where: [{ column: 'type', op: '=', value: ['a', 'b'] }],
      }).ok,
    ).toBe(false);
    expect(
      compileGraphQuery({
        select: 'nodes',
        where: [{ column: 'type', op: 'IS NULL', value: 'x' }],
      }).ok,
    ).toBe(false);
    expect(
      compileGraphQuery({ select: 'bogus' as never }).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runGraphQuery — correct rows against a real store
// ---------------------------------------------------------------------------

describe('runGraphQuery — correct rows', () => {
  it('lists nodes of a type with an exact total', async () => {
    const r = await runGraphQuery(store, {
      select: 'nodes',
      where: [{ column: 'type', op: '=', value: 'CustomField' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totalCount).toBe(3);
    expect(r.value.rows.map((n) => (n as Node).apiName).sort()).toEqual([
      'Industry__c',
      'Region__c',
      'Stage__c',
    ]);
    expect(r.value.hasMore).toBe(false);
    expect(r.value.compiledSql.startsWith('SELECT ')).toBe(true);
  });

  it('filters nodes by a JSON property', async () => {
    const r = await runGraphQuery(store, {
      select: 'nodes',
      where: [{ column: 'property:dataType', op: '=', value: 'Picklist' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rows.map((n) => (n as Node).apiName).sort()).toEqual([
      'Industry__c',
      'Stage__c',
    ]);
  });

  it('lists edges by kind and by an IN filter', async () => {
    const byKind = await runGraphQuery(store, {
      select: 'edges',
      where: [{ column: 'edgeType', op: '=', value: 'parentOf' }],
    });
    expect(byKind.ok).toBe(true);
    if (!byKind.ok) return;
    expect(byKind.value.totalCount).toBe(3);
    const byIn = await runGraphQuery(store, {
      select: 'edges',
      where: [{ column: 'confidence', op: 'IN', value: ['heuristic'] }],
    });
    expect(byIn.ok).toBe(true);
    if (!byIn.ok) return;
    expect(byIn.value.totalCount).toBe(1);
    expect((byIn.value.rows[0] as Edge).edgeType).toBe('triggersOn');
  });

  it('LIKE matches a substring; IS NOT NULL filters populated columns', async () => {
    const like = await runGraphQuery(store, {
      select: 'nodes',
      where: [{ column: 'id', op: 'LIKE', value: 'CustomField:Account.%' }],
    });
    expect(like.ok).toBe(true);
    if (!like.ok) return;
    expect(like.value.totalCount).toBe(2);

    const notNull = await runGraphQuery(store, {
      select: 'nodes',
      where: [{ column: 'lastModifiedBy', op: 'IS NOT NULL' }],
    });
    expect(notNull.ok).toBe(true);
    if (!notNull.ok) return;
    expect(notNull.value.totalCount).toBe(1);
  });

  it('caps returned rows at the limit and reports hasMore honestly', async () => {
    const r = await runGraphQuery(store, {
      select: 'nodes',
      where: [{ column: 'type', op: '=', value: 'CustomField' }],
      limit: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.returnedCount).toBe(1);
    expect(r.value.totalCount).toBe(3);
    expect(r.value.hasMore).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL — injection / DDL / DML must never execute
// ---------------------------------------------------------------------------

describe('runGraphQuery — adversarial (the crux)', () => {
  const INJECTIONS: readonly string[] = [
    "'; DROP TABLE nodes; --",
    "1 OR 1=1",
    "' OR '1'='1",
    "1); DELETE FROM edges; --",
    "x' UNION SELECT * FROM nodes --",
    "'; ATTACH 'evil.db' AS evil; --",
    "'; PRAGMA database_list; --",
    "\\'; DROP TABLE nodes; --",
  ];

  it('binds every injection payload as an inert value — matches nothing, mutates nothing', async () => {
    const nodesBefore = await countNodesByType(store, 'CustomObject');
    const fieldsBefore = await countNodesByType(store, 'CustomField');
    expect(nodesBefore.ok && fieldsBefore.ok).toBe(true);

    for (const payload of INJECTIONS) {
      // As an equality value.
      const eq = await runGraphQuery(store, {
        select: 'nodes',
        where: [{ column: 'apiName', op: '=', value: payload }],
      });
      expect(eq.ok, `eq payload ${payload}`).toBe(true);
      if (eq.ok) expect(eq.value.returnedCount).toBe(0);

      // As a LIKE value (the highest-risk substring path).
      const like = await runGraphQuery(store, {
        select: 'nodes',
        where: [{ column: 'apiName', op: 'LIKE', value: payload }],
      });
      expect(like.ok, `like payload ${payload}`).toBe(true);
      if (like.ok) expect(like.value.returnedCount).toBe(0);

      // As an IN element.
      const inList = await runGraphQuery(store, {
        select: 'edges',
        where: [{ column: 'source', op: 'IN', value: [payload] }],
      });
      expect(inList.ok, `in payload ${payload}`).toBe(true);
      if (inList.ok) expect(inList.value.returnedCount).toBe(0);

      // As a bound JSON property VALUE.
      const prop = await runGraphQuery(store, {
        select: 'nodes',
        where: [{ column: 'property:dataType', op: '=', value: payload }],
      });
      expect(prop.ok, `prop payload ${payload}`).toBe(true);
      if (prop.ok) expect(prop.value.returnedCount).toBe(0);
    }

    // The tables are intact — nothing was dropped/deleted/attached.
    const nodesAfter = await countNodesByType(store, 'CustomObject');
    const fieldsAfter = await countNodesByType(store, 'CustomField');
    expect(nodesAfter.ok && fieldsAfter.ok).toBe(true);
    if (nodesBefore.ok && nodesAfter.ok) expect(nodesAfter.value).toBe(nodesBefore.value);
    if (fieldsBefore.ok && fieldsAfter.ok) expect(fieldsAfter.value).toBe(fieldsBefore.value);
  });

  it('rejects injection aimed at the COLUMN or OPERATOR slot at compile time', async () => {
    const badColumn = await runGraphQuery(store, {
      select: 'nodes',
      where: [{ column: "id FROM nodes; DROP TABLE nodes; --", op: '=', value: 'x' }],
    });
    expect(badColumn.ok).toBe(false);
    if (badColumn.ok) return;
    expect(badColumn.error.kind).toBe('invalid-query');

    const badOp = await runGraphQuery(store, {
      select: 'nodes',
      where: [{ column: 'id', op: 'UNION SELECT' as never, value: 'x' }],
    });
    expect(badOp.ok).toBe(false);
    if (badOp.ok) return;
    expect(badOp.error.kind).toBe('invalid-query');
  });
});

// ---------------------------------------------------------------------------
// READ-ONLY — a write through the served handle must error
// ---------------------------------------------------------------------------

describe('read-only enforcement', () => {
  it('the read-only connection (the served handle) rejects a write', async () => {
    // A DuckDB read-write opener holds an EXCLUSIVE lock, so a read-only open of
    // the shared `dbPath` would conflict. Seed a fresh file, close the writer,
    // then open it exactly the way the MCP server does (access_mode READ_ONLY).
    const roDbPath = join(tempDir, 'query-graph-ro.db');
    const wInstance = await DuckDBInstance.create(roDbPath);
    const wConnection = await wInstance.connect();
    const initR = await initSchema(wConnection);
    if (!initR.ok) throw new Error(`initSchema failed: ${initR.error.message}`);
    const wStore: GraphStore = { connection: wConnection, instance: wInstance };
    const imp = await importExtractionResults(wStore, [seed]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    await closeGraph(wStore);

    const roResult = await openGraphReadOnly(roDbPath);
    expect(roResult.ok).toBe(true);
    if (!roResult.ok) return;
    const ro = roResult.value;
    try {
      // A structured query still works read-only...
      const read = await runGraphQuery(ro, {
        select: 'nodes',
        where: [{ column: 'type', op: '=', value: 'CustomObject' }],
      });
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.totalCount).toBe(2);
      // ...but ANY write on the same handle is rejected at the DuckDB level.
      await expect(
        ro.connection.run(
          "INSERT INTO nodes (id, type, api_name, source_path, properties_json) VALUES ('x', 'y', 'z', 'p', '{}')",
        ),
      ).rejects.toThrow();
    } finally {
      await closeGraph(ro);
    }
  });
});

// ---------------------------------------------------------------------------
// ENGINE-LEVEL EXTERNAL-ACCESS BACKSTOP — file-exfil ops must be inert on the
// ACTUAL served connection, not just absent from the compiler. This is the
// belt-and-suspenders for `sfi.query_graph`: even if a future SQL path emitted
// `read_csv`/`read_parquet`/`ATTACH`/`COPY`, DuckDB refuses it at the engine
// level because `store.ts` opens every handle with `enable_external_access:
// 'false'`.
// ---------------------------------------------------------------------------

/**
 * Seed a fresh vault file through the REAL product open path (`openGraph`,
 * which applies the external-access-disabled config + runs migrations), import
 * the shared seed, and close the writer so the file can be reopened.
 */
const seedFreshVault = async (name: string): Promise<string> => {
  const p = join(tempDir, name);
  const opened = await openGraph(p);
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const imp = await importExtractionResults(opened.value, [seed]);
  if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
  await closeGraph(opened.value);
  return p;
};

/**
 * Assert every external-file / attach / copy operation is refused on `conn`.
 * The paths do not exist, but DuckDB rejects at the config gate BEFORE touching
 * the filesystem, so a non-existent path is fine (and proves it is the config,
 * not a missing-file error — the read_csv assertion pins the exact reason).
 */
const expectExternalAccessRefused = async (
  conn: GraphStore['connection'],
): Promise<void> => {
  const csv = join(tempDir, 'exfil.csv');
  const parquet = join(tempDir, 'exfil.parquet');
  const attachTarget = join(tempDir, 'exfil-attach.db');
  const copyTarget = join(tempDir, 'exfil-copy.csv');
  // read_csv: pin the exact refusal reason — the engine config, not a missing file.
  await expect(
    conn.run(`SELECT * FROM read_csv('${csv}')`),
  ).rejects.toThrow(/disabled by configuration/i);
  await expect(conn.run(`SELECT * FROM read_parquet('${parquet}')`)).rejects.toThrow();
  await expect(conn.run(`ATTACH '${attachTarget}' AS exfil`)).rejects.toThrow();
  await expect(conn.run(`COPY (SELECT 1 AS a) TO '${copyTarget}'`)).rejects.toThrow();
};

describe('external-access backstop — served + fallback handles', () => {
  it('served handle (openGraphServeReadOnly) answers queries but refuses file-exfil + writes', async () => {
    const p = await seedFreshVault('serve-ext.db');
    // The ACTUAL path the MCP server serves query_graph through — not a
    // hand-opened openGraphReadOnly.
    const served = await openGraphServeReadOnly(p);
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    try {
      // A structured query still works on the served handle.
      const read = await runGraphQuery(served.value, {
        select: 'nodes',
        where: [{ column: 'type', op: '=', value: 'CustomObject' }],
      });
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value.totalCount).toBe(2);
      // File-exfil / attach / copy are refused at the DuckDB engine level.
      await expectExternalAccessRefused(served.value.connection);
      // And a write is refused (this served handle is read-only mode).
      await expect(
        served.value.connection.run(
          "INSERT INTO nodes (id, type, api_name, source_path, properties_json) VALUES ('x', 'y', 'z', 'p', '{}')",
        ),
      ).rejects.toThrow();
    } finally {
      await closeGraph(served.value);
    }
  });

  it('read-WRITE fallback handle (openGraph) still refuses file-exfil, even though it can write', async () => {
    // openGraphServeReadOnly can fall back to this read-WRITE handle (stale-schema
    // migrate / probe-fail / RO-open-fail). The external-access backstop must hold
    // there too — otherwise the file-exfil class would reopen in exactly the
    // fallback branches. Proven directly on the fallback target: writes succeed
    // (it is genuinely read-write) but external access is still refused.
    const p = await seedFreshVault('fallback-ext.db');
    const rw = await openGraph(p);
    expect(rw.ok).toBe(true);
    if (!rw.ok) return;
    try {
      // Genuinely writable — this is NOT a read-only handle.
      await expect(
        rw.value.connection.run(
          "INSERT INTO nodes (id, type, api_name, source_path, properties_json) VALUES ('rw-probe', 'CustomObject', 'RwProbe', 'p', '{}')",
        ),
      ).resolves.toBeDefined();
      // ...yet file-exfil / attach / copy are STILL refused by the engine config.
      await expectExternalAccessRefused(rw.value.connection);
    } finally {
      await closeGraph(rw.value);
    }
  });
});
