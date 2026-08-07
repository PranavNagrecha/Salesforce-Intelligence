#!/usr/bin/env node
/**
 * End-to-end MCP smoke — the test the suite was missing. Builds a throwaway
 * vault, spawns the REAL `sfi mcp` server, and drives it over the REAL MCP
 * protocol (SDK client ↔ stdio). Asserts graph-backed queries actually return
 * data — i.e. the server keeps its DuckDB connection open for the process
 * lifetime. This is exactly the invariant the "graph closed at startup" bug
 * violated and that unit tests / direct-handler probes could never catch.
 *
 * Also asserts the no-vault path fails gracefully with an actionable message.
 *
 * Self-contained (no external fixtures) → CI-safe. Run: `pnpm e2e`.
 * Exit 0 = all assertions pass, 1 = a failure.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';
import { vaultPaths } from '@sf-intelligence/vault';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'cli', 'bin', 'sfi.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const callText = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content?.[0]?.text ?? JSON.stringify(r);
};

// --- build a throwaway vault ---
const buildVault = async () => {
  const root = mkdtempSync(join(tmpdir(), 'sfi-e2e-'));
  const vaultRoot = join(root, 'org-kb');
  const p = vaultPaths(vaultRoot);
  mkdirSync(p.meta, { recursive: true });
  mkdirSync(dirname(p.graphDb), { recursive: true });
  writeFileSync(
    p.config,
    JSON.stringify({ targetOrg: 'e2e', vaultRoot, version: '0.1.0', createdAt: '2026-05-28T00:00:00.000Z' }),
  );
  writeFileSync(
    join(p.meta, 'manifest.json'),
    JSON.stringify({
      version: '0.1.0',
      refreshedAt: '2026-05-28T00:00:00.000Z',
      sourceOrg: 'e2e',
      components: { CustomObject: 1 },
      edges: {},
      sourceTreeHash: 'sha256:e2e',
    }),
  );
  const g = await openGraph(p.graphDb);
  if (!g.ok) throw new Error(`openGraph: ${g.error.message}`);
  const imp = await importExtractionResults(g.value, [
    {
      nodes: [
        {
          id: 'CustomObject:Account',
          type: 'CustomObject',
          apiName: 'Account',
          label: 'Account',
          parentId: null,
          sourcePath: 'source/main/default/objects/Account/Account.object-meta.xml',
          lastModifiedDate: null,
          lastModifiedBy: null,
          apiVersion: null,
          properties: {},
        },
      ],
      edges: [],
    },
  ]);
  if (!imp.ok) throw new Error(`import: ${imp.error.message}`);
  await closeGraph(g.value);
  return { root, vaultParent: root };
};

const newClient = (cwd, env) => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [BIN, 'mcp'],
    cwd,
    stderr: 'pipe',
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  const client = new Client({ name: 'e2e', version: '1' }, { capabilities: {} });
  return { client, transport, getStderr: () => stderr };
};

console.log('e2e MCP smoke\n');

// === Scenario 1: WITH a vault — graph queries must return data ===
// Pin full here: default advertise profile is core (19 tools); the dedicated
// "# core profile" block below asserts that default. This block exercises the
// full roster + graph-backed tools that are not in core.
console.log('# with vault');
const { vaultParent } = await buildVault();
const a = newClient(vaultParent, { SFI_TOOL_PROFILE: 'full' });
try {
  await a.client.connect(a.transport);
  const tools = await a.client.listTools();
  check('tools/list returns the roster', tools.tools.length >= 50, `got ${tools.tools.length}`);

  // The `initialize` handshake must carry server-level instructions that
  // orient a fresh client (resolve-first + sfi.capabilities) — the one
  // routing channel that reaches a client before CLAUDE.md / skills load.
  const instructions = a.client.getInstructions() ?? '';
  check(
    'initialize returns server instructions teaching resolve-first',
    instructions.includes('sfi.resolve') &&
      instructions.includes('sfi.capabilities') &&
      instructions.includes('FIRST'),
    instructions ? instructions.slice(0, 80) : '(no instructions on initialize)',
  );

  const health = await callText(a.client, 'sfi.health_check', {});
  check('health_check reports graphReadable=true', health.includes('"graphReadable":true'), health.slice(0, 120));

  const list = await callText(a.client, 'sfi.list_components', { type: 'CustomObject' });
  check('list_components returns data (graph connection alive)', list.includes('CustomObject:Account') && !list.includes('connection disconnected'), list.slice(0, 120));

  const resolve = await callText(a.client, 'sfi.resolve', { query: 'acount' });
  check('resolve tolerates a typo (acount -> Account)', resolve.includes('CustomObject:Account'), resolve.slice(0, 120));
} catch (e) {
  check('with-vault scenario ran', false, e.message);
} finally {
  await a.client.close().catch(() => {});
}
// === Scenario 1b: core profile (AUDIT-F6) — 19 schemas advertised AND
// directly invokable; non-core tools only via sfi.run_analysis.
console.log('\n# core profile');
const cp = newClient(vaultParent, { SFI_TOOL_PROFILE: 'core' });
try {
  await cp.client.connect(cp.transport);
  const coreTools = await cp.client.listTools();
  check('core profile advertises exactly 19 schemas', coreTools.tools.length === 19, `got ${coreTools.tools.length}`);
  const denied = await callText(cp.client, 'sfi.org_overview', {});
  check(
    'non-advertised tool is NOT directly invokable under core',
    denied.includes('not directly invokable') || denied.includes('invalid-query'),
    denied.slice(0, 160),
  );
  const viaGateway = await callText(cp.client, 'sfi.run_analysis', { name: 'sfi.org_overview', args: {} });
  check('run_analysis reaches non-core tools under core', viaGateway.includes('"data"'), viaGateway.slice(0, 100));
  const full = newClient(vaultParent, { SFI_TOOL_PROFILE: 'full' });
  try {
    await full.client.connect(full.transport);
    const direct = await callText(full.client, 'sfi.org_overview', {});
    check('full profile allows direct non-core calls', direct.includes('"data"'), direct.slice(0, 100));
    const viaFullGw = await callText(full.client, 'sfi.run_analysis', { name: 'sfi.org_overview', args: {} });
    check('run_analysis byte-identical under full', viaFullGw === direct, viaFullGw.slice(0, 100));
  } finally {
    await full.client.close().catch(() => {});
  }
} catch (e) {
  check('core-profile scenario ran', false, e.message);
} finally {
  await cp.client.close().catch(() => {});
}

// === Scenario 1c: refresh epoch (P13-WATCH-epoch) — a refresh while the
// server is OPEN must be served on the NEXT call, no restart. The test
// process rewrites the graph (cross-process writer vs the child's read-only
// handle) and bumps meta/refresh-epoch; the SAME server must see the change.
console.log('\n# refresh epoch');
const ep = newClient(vaultParent);
try {
  await ep.client.connect(ep.transport);
  const before = await callText(ep.client, 'sfi.list_components', { type: 'CustomObject' });
  check('epoch: server serves the original vault', before.includes('CustomObject:Account'), before.slice(0, 100));

  // Mirror the refresh's locked-fallback exactly: the server's read-only
  // handle blocks an in-place writer (DuckDB), so the rebuild goes to a SIDE
  // file and is atomically renamed over the target, then the epoch is bumped.
  const vp = vaultPaths(join(vaultParent, 'org-kb'));
  const sidePath = `${vp.graphDb}.rebuild`;
  const g2 = await openGraph(sidePath);
  if (!g2.ok) throw new Error(`epoch side-build open: ${g2.error.message}`);
  const mk = (id, apiName) => ({
    id, type: 'CustomObject', apiName, label: apiName, parentId: null,
    sourcePath: `objects/${apiName}.object`, lastModifiedDate: null,
    lastModifiedBy: null, apiVersion: null, properties: {},
  });
  const imp2 = await importExtractionResults(g2.value, [
    { nodes: [mk('CustomObject:Account', 'Account'), mk('CustomObject:Epoch_Marker__c', 'Epoch_Marker__c')], edges: [] },
  ]);
  if (!imp2.ok) throw new Error(`epoch side-build import: ${imp2.error.message}`);
  await closeGraph(g2.value);
  renameSync(sidePath, vp.graphDb); // atomic — the open server keeps the old inode until reopen
  writeFileSync(join(vaultParent, 'org-kb', 'meta', 'refresh-epoch'), `${new Date().toISOString()}\n`);

  const after = await callText(ep.client, 'sfi.list_components', { type: 'CustomObject' });
  check(
    'epoch: the SAME open server serves the refreshed vault — no restart',
    after.includes('Epoch_Marker__c'),
    after.slice(0, 120),
  );
} catch (e) {
  check('refresh-epoch scenario ran', false, e.message);
} finally {
  await ep.client.close().catch(() => {});
}

// === Scenario: HTTP serving (P13-REMOTE-http) ===
console.log('\n# http serving');
try {
  const { startHttpServer, generateToken } = await import('./dist/src/serve-http.js');
  const { Client: HttpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const token = generateToken();
  const http = await startHttpServer({ vaultRoot: join(vaultParent, 'org-kb'), port: 0, host: '127.0.0.1', token });
  const noAuth = await fetch(`http://127.0.0.1:${http.port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  check('http: 401 without bearer token', noAuth.status === 401);
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const hc = new HttpClient({ name: 'e2e-http', version: '1' }, { capabilities: {} });
  await hc.connect(t);
  const hr = await hc.callTool({ name: 'sfi.health_check', arguments: {} });
  const htext = hr.content?.[0]?.text ?? '';
  check('http: health_check over HTTP with token', htext.includes('"graphReadable":true'), htext.slice(0, 100));
  await hc.close();
  await http.close();
} catch (e) {
  check('http scenario ran', false, e.message);
}

rmSync(vaultParent, { recursive: true, force: true });

// === Scenario 2: NO vault — graceful, actionable failure ===
console.log('\n# no vault');
const emptyDir = mkdtempSync(join(tmpdir(), 'sfi-e2e-empty-'));
const b = newClient(emptyDir);
let connected = false;
try {
  await b.client.connect(b.transport);
  connected = true;
} catch {
  /* expected */
}
await b.client.close().catch(() => {});
check('server refuses to start without a vault', !connected);
check('no-vault message is actionable (mentions `sfi init`)', b.getStderr().includes('sfi init'), b.getStderr().trim().slice(0, 120));
rmSync(emptyDir, { recursive: true, force: true });

// === Scenario 3: the SHIPPED demo vault — the public no-org front door (P21-DEMO-ci-eval) ===
// Proves the committed examples/demo-vault (synthetic "Verdant Energy" org) is queryable over
// the real MCP protocol, so every CI run / gate exercises the public demo on PUBLIC data — never
// a real org. This is the public-data counterpart to the maintainer-only real-vault tool-smoke.
console.log('\n# shipped demo vault (examples/demo-vault)');
const demoVault = join(here, '..', '..', 'examples', 'demo-vault');
if (!existsSync(join(demoVault, 'graph', 'graph.duckdb'))) {
  check('shipped demo vault is present (examples/demo-vault/graph/graph.duckdb)', false, 'missing — run the demo build');
} else {
  const demoTransport = new StdioClientTransport({
    command: 'node',
    args: [BIN, 'mcp', '--vault', demoVault],
    cwd: join(here, '..', '..'),
    stderr: 'pipe',
  });
  const demoClient = new Client({ name: 'e2e-demo', version: '1' }, { capabilities: {} });
  try {
    await demoClient.connect(demoTransport);
    const list = await callText(demoClient, 'sfi.list_components', { type: 'CustomObject' });
    check('demo vault serves the synthetic schema (Project__c)', list.includes('Project__c'), list.slice(0, 100));
    const res = await callText(demoClient, 'sfi.resolve', { query: 'paymnet' });
    check('demo vault resolves a typo (paymnet -> Payment__c)', res.includes('Payment__c'), res.slice(0, 100));
  } catch (e) {
    check('demo-vault scenario ran', false, e.message);
  } finally {
    await demoClient.close().catch(() => {});
  }
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
