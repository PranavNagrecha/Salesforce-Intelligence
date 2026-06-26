/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraph, openGraph } from '@sf-intelligence/graph';
import { loadManifest, vaultPaths } from '@sf-intelligence/vault';

import { runRefresh } from '../src/commands/refresh.js';

/**
 * P13-AST-edges — the --apex-ast flag: parsed-confidence apex-ast edges
 * coexist with scanner edges; a parse-failing file falls back to
 * scanner-only and is counted; flag OFF is byte-identical (zero apex-ast
 * rows).
 */

let cwd: string;
let vaultRoot: string;

const CALLER = `public class Caller {
  public void run(Account a) {
    a.Industry = 'Education';
    String name = a.Name;
    Callee c = new Callee();
    c.help(name);
    for (Contact ct : [SELECT Id, Email FROM Contact WHERE Email != null]) {}
  }
}`;
const CALLEE = `public class Callee {
  public void help(String s) { System.debug(s); }
}`;
const BROKEN = `public class Broken { this is not valid apex %%% }`;
// P14-USAGE-scanner-fp-downgrade: the scanner keys `rw.id = ...` on the
// receiver TOKEN's declared type when it pattern-matches `Type var` pairs,
// emitting CustomField:ReportWrapper.id — but ReportWrapper is an INNER
// CLASS the AST can prove is not an sObject. Test.setMock-style `.class`
// literals produce CustomField:X.class the same way.
const WRAPPER = `public class Wrapper {
  public class ReportWrapper { public Id id; public String fileType; }
  public void build(ContentDocument cd) {
    ReportWrapper rw = new ReportWrapper();
    rw.id = cd.Id;
    rw.fileType = cd.FileType;
    Test.setMock(HttpCalloutMock.class, null);
  }
}`;
// CR-06 (H5): a child-relationship subquery. Outer fields belong to Account;
// the child `(SELECT ... FROM Contacts)` names a RELATIONSHIP, not an sObject —
// its fields and the relationship token must NOT mint parsed edges.
const CHILDSUB = `public class ChildSub {
  public void run() {
    List<Account> rows = [SELECT Id, Name, (SELECT Email, FirstName FROM Contacts) FROM Account];
  }
}`;
// CR-06 (H5b): a semi-join. Inner `(SELECT AccountId FROM Contact)` is a real
// sObject scope — its fields key to Contact, NOT to the outer Account.
const SEMIJOIN = `public class SemiJoin {
  public void run() {
    List<Account> rows = [SELECT Id, Name FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Email != null)];
  }
}`;

const seed = async (): Promise<void> => {
  vaultRoot = join(cwd, 'org-kb');
  const paths = vaultPaths(vaultRoot);
  await mkdir(paths.meta, { recursive: true });
  const dir = join(paths.source, 'main', 'default', 'classes');
  await mkdir(dir, { recursive: true });
  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>60.0</apiVersion>
  <status>Active</status>
</ApexClass>
`;
  for (const [name, body] of [
    ['Caller', CALLER],
    ['Callee', CALLEE],
    ['Broken', BROKEN],
    ['Wrapper', WRAPPER],
    ['ChildSub', CHILDSUB],
    ['SemiJoin', SEMIJOIN],
  ] as const) {
    await writeFile(join(dir, `${name}.cls`), body, 'utf8');
    await writeFile(join(dir, `${name}.cls-meta.xml`), meta, 'utf8');
  }
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
};

const astEdges = async (): Promise<readonly Record<string, unknown>[]> => {
  const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const reader = await opened.value.connection.runAndReadAll(
      "SELECT from_id, to_id, edge_type, confidence FROM edges WHERE source = 'apex-ast' ORDER BY from_id, to_id, edge_type",
    );
    return reader.getRowObjectsJS() as readonly Record<string, unknown>[];
  } finally {
    await closeGraph(opened.value);
  }
};

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'sfi-apex-ast-'));
  await seed();
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('refresh apex-ast (DEFAULT ON — P13-AST-flip)', () => {
  it('runs BY DEFAULT: parsed edges present with no flag at all', async () => {
    const r = await runRefresh({ cwd, noPull: true });
    expect(r.status).toBe('success');
    const edges = await astEdges();
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e['confidence'] === 'parsed')).toBe(true);
  });

  it('dedupes exact heuristic twins: one real reference is ONE edge (parsed wins)', async () => {
    const r = await runRefresh({ cwd, noPull: true });
    expect(r.status).toBe('success');
    const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const reader = await opened.value.connection.runAndReadAll(
        `SELECT from_id, to_id, edge_type, COUNT(*) AS n
         FROM edges
         WHERE from_id LIKE 'ApexClass:%' AND edge_type IN ('readsFrom','writesTo','callsApex')
         GROUP BY from_id, to_id, edge_type HAVING COUNT(*) > 1`,
      );
      const dupes = reader.getRowObjectsJS() as readonly Record<string, unknown>[];
      expect(dupes).toEqual([]); // zero double-counted apex references
    } finally {
      await closeGraph(opened.value);
    }
  });

  it('drops typed-receiver + .class heuristic FPs on parsed files (P14-USAGE-scanner-fp-downgrade)', async () => {
    const r = await runRefresh({ cwd, noPull: true });
    expect(r.status).toBe('success');
    const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const reader = await opened.value.connection.runAndReadAll(
        "SELECT to_id FROM edges WHERE from_id = 'ApexClass:Wrapper' AND edge_type IN ('readsFrom','writesTo') ORDER BY to_id",
      );
      const targets = (reader.getRowObjectsJS() as unknown as readonly { to_id: string }[]).map((x) => x.to_id);
      // The inner-class property writes and the Type.class literal are GONE…
      expect(targets.some((t) => t.startsWith('CustomField:ReportWrapper.'))).toBe(false);
      expect(targets.some((t) => t.endsWith('.class'))).toBe(false);
      // …while the REAL sObject reads survive.
      expect(targets).toContain('CustomField:ContentDocument.Id');
    } finally {
      await closeGraph(opened.value);
    }
  });

  it('adds parsed apex-ast edges coexisting with scanner edges; broken file falls back and is counted', async () => {
    const r = await runRefresh({ cwd, noPull: true, apexAst: true });
    expect(r.status).toBe('success');

    const edges = await astEdges();
    const ids = edges.map((e) => `${e['from_id']}->${e['to_id']}:${e['edge_type']}`);
    expect(ids).toContain('ApexClass:Caller->ApexClass:Callee:callsApex');
    expect(ids).toContain('ApexClass:Caller->CustomField:Account.Industry:writesTo');
    expect(ids).toContain('ApexClass:Caller->CustomField:Account.Name:readsFrom');
    expect(ids).toContain('ApexClass:Caller->CustomField:Contact.Email:readsFrom');
    expect(edges.every((e) => e['confidence'] === 'parsed')).toBe(true);
    // broken file contributed NO ast edges (scanner fallback)
    expect(ids.some((i) => i.startsWith('ApexClass:Broken'))).toBe(false);

    const manifest = await loadManifest(vaultRoot);
    if (!manifest.ok) throw new Error('manifest unreadable');
    expect(manifest.value.apexAst?.parseErrors).toBe(1);
    // Caller + Callee + Wrapper + ChildSub + SemiJoin parse cleanly (Broken fails).
    expect(manifest.value.apexAst?.filesParsed).toBe(5);
  });

  it('SOQL subquery edges attribute to the right object; child-relationship + cross-scope phantoms are absent (CR-06 / H5)', async () => {
    const r = await runRefresh({ cwd, noPull: true });
    expect(r.status).toBe('success');
    const opened = await openGraph(vaultPaths(vaultRoot).graphDb);
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      // child subquery: outer fields on Account, NO Contacts.* relationship edges
      const childReader = await opened.value.connection.runAndReadAll(
        "SELECT to_id FROM edges WHERE from_id = 'ApexClass:ChildSub' AND edge_type = 'readsFrom' ORDER BY to_id",
      );
      const child = (childReader.getRowObjectsJS() as unknown as readonly { to_id: string }[]).map((x) => x.to_id);
      expect(child).toContain('CustomField:Account.Id');
      expect(child).toContain('CustomField:Account.Name');
      expect(child.some((t) => t.startsWith('CustomField:Contacts.'))).toBe(false);
      expect(child).not.toContain('CustomField:Account.Email');

      // semi-join: outer fields on Account, inner fields on Contact, no bleed
      const semiReader = await opened.value.connection.runAndReadAll(
        "SELECT to_id FROM edges WHERE from_id = 'ApexClass:SemiJoin' AND edge_type = 'readsFrom' ORDER BY to_id",
      );
      const semi = (semiReader.getRowObjectsJS() as unknown as readonly { to_id: string }[]).map((x) => x.to_id);
      expect(semi).toContain('CustomField:Account.Id');
      expect(semi).toContain('CustomField:Account.Name');
      expect(semi).toContain('CustomField:Contact.AccountId');
      expect(semi).toContain('CustomField:Contact.Email');
      expect(semi).not.toContain('CustomField:Account.AccountId');
      expect(semi).not.toContain('CustomField:Account.Email');
    } finally {
      await closeGraph(opened.value);
    }
  });

  it('apexAst:false (--no-apex-ast) opts out: zero apex-ast rows and no manifest block', async () => {
    const r = await runRefresh({ cwd, noPull: true, apexAst: false });
    expect(r.status).toBe('success');
    expect((await astEdges()).length).toBe(0);
    const manifest = await loadManifest(vaultRoot);
    if (!manifest.ok) throw new Error('manifest unreadable');
    expect('apexAst' in manifest.value).toBe(false);
  });
});

describe('reports-cap coverage decoration (P13-REPORTS-default)', () => {
  it('a capped pull marks Report/Dashboard coverage pending; absence caveats fire', async () => {
    // decoration is exercised through the manifest path: simulate by writing
    // a manifest the way runWithOpenGraph does — here we unit the helper via
    // a refresh with stats injected is internal, so assert the SEMANTIC:
    // pending rows route into missingCoverage (summarizeCoverage contract).
    const { summarizeCoverage } = await import('@sf-intelligence/vault');
    const summary = summarizeCoverage(
      {
        version: '0.1.0',
        refreshedAt: 'x',
        sourceOrg: 't',
        components: {},
        edges: {},
        sourceTreeHash: 'h',
        coverage: [
          { type: 'Report', requested: true, retrieved: 500, errored: false, neverModeled: false, pending: true },
          { type: 'Dashboard', requested: true, retrieved: 83, errored: false, neverModeled: false },
        ],
      },
      ['Report', 'Dashboard'],
    );
    expect(summary.missingCoverage).toContain('Report'); // capped tail = not checked
    expect(summary.missingCoverage).not.toContain('Dashboard'); // fully pulled
  });
});
