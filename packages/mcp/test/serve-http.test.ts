/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ExtractionResult, Node } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';
import { readAnnotations } from '@sf-intelligence/vault';

import {
  generateToken,
  loadTokensFile,
  matchTokenEntry,
  resolveBearerAuth,
  startHttpServer,
  tokenEquals,
  type RunningHttpServer,
} from '../src/serve-http.js';
import { bindCallerIdentity, buildContext, shutdown } from '../src/server.js';
import {
  proposeAnnotationHandler,
  resetProposalSessionCap,
} from '../src/tools/annotations.js';
import { dispatchTool } from '../src/tools/index.js';

/**
 * P13-REMOTE-http — bearer auth (401s, constant-time compare), the live
 * plane HARD-DISABLED over HTTP even with env enablement (a TEST, not a doc
 * line), stdio↔HTTP parity, and the no-absolute-paths leak check.
 */

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id' | 'type'>): Node => ({
  apiName: overrides.id.slice(overrides.id.indexOf(':') + 1),
  label: null,
  parentId: null,
  sourcePath: 'source/x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

let vaultRoot: string;
let server: RunningHttpServer;
let token: string;

const httpClient = async (bearer?: string): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/`),
    bearer === undefined
      ? undefined
      : { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } },
  );
  const client = new Client({ name: 'serve-http-test', version: '1' }, { capabilities: {} });
  await client.connect(transport as never);
  return client;
};

beforeAll(async () => {
  vaultRoot = mkdtempSync(join(tmpdir(), 'sfi-serve-http-'));
  mkdirSync(join(vaultRoot, 'meta'), { recursive: true });
  mkdirSync(join(vaultRoot, 'graph'), { recursive: true });
  writeFileSync(
    join(vaultRoot, 'meta', 'manifest.json'),
    JSON.stringify({
      version: '0.1.0',
      refreshedAt: '2026-06-10T00:00:00.000Z',
      sourceOrg: 'test',
      components: { ApexClass: 1 },
      edges: {},
      sourceTreeHash: 'sha256:serve-http-fixture',
    }),
    'utf8',
  );
  const opened = await openGraph(join(vaultRoot, 'graph', 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  const seed: ExtractionResult = {
    nodes: [makeNode({ id: 'ApexClass:Alpha', type: 'ApexClass' })],
    edges: [],
  };
  const imp = await importExtractionResults(opened.value, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  await closeGraph(opened.value);

  token = generateToken();
  server = await startHttpServer({ vaultRoot, port: 0, host: '127.0.0.1', token });
});

afterAll(async () => {
  await server.close();
  delete process.env['SFI_TRANSPORT'];
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('tokenEquals (constant-time)', () => {
  it('accepts equal, rejects different and different-length tokens', () => {
    expect(tokenEquals('abc123', 'abc123')).toBe(true);
    expect(tokenEquals('abc124', 'abc123')).toBe(false);
    expect(tokenEquals('abc', 'abc123')).toBe(false);
    expect(tokenEquals('', 'abc123')).toBe(false);
  });
});

describe('bearer auth', () => {
  it('401 without a token and with a wrong token', async () => {
    for (const bearer of [undefined, 'wrong-token']) {
      const r = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('Bearer');
    }
  });

  it('a valid token serves real tool calls', async () => {
    const client = await httpClient(token);
    try {
      const r = await client.callTool({ name: 'sfi.get_manifest', arguments: {} });
      const body = JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
      expect(body.data.sourceOrg).toBe('test');
    } finally {
      await client.close();
    }
  });
});

describe('live plane HARD-DISABLED over HTTP (the test, not a doc line)', () => {
  it('fails closed even with SFI_LIVE_PLANE_ENABLED=1 and liveEnabled:true', async () => {
    process.env['SFI_LIVE_PLANE_ENABLED'] = '1';
    const client = await httpClient(token);
    try {
      const r = await client.callTool({
        name: 'sfi.live_count',
        arguments: { objectApiName: 'Account', liveEnabled: true },
      });
      const body = JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
      expect(body.data).toBeUndefined();
      expect(body.error?.message ?? '').toContain('Live org plane is not enabled');
    } finally {
      delete process.env['SFI_LIVE_PLANE_ENABLED'];
      await client.close();
    }
  });
});

describe('stdio↔HTTP parity + leak check', () => {
  it('the same tool over HTTP returns byte-identical data to in-process dispatch', async () => {
    const ctxResult = await buildContext(vaultRoot);
    if (!ctxResult.ok) throw new Error(ctxResult.error.message);
    const direct = await dispatchTool(ctxResult.value, 'sfi.get_manifest', {});
    await shutdown(ctxResult.value);
    const directBody = (direct.content as { text: string }[])[0]?.text ?? '';

    const client = await httpClient(token);
    try {
      const r = await client.callTool({ name: 'sfi.get_manifest', arguments: {} });
      const httpBody = (r.content as { text: string }[])[0]?.text ?? '';
      // coverageComputedAt is the in-memory backfill's wall-clock stamp —
      // per-context, documented volatile (same mask rule as the golden
      // corpus). Everything else must be byte-identical.
      const mask = (t: string): string =>
        t.replace(/"coverageComputedAt":"[^"]+"/, '"coverageComputedAt":"<PIN>"');
      expect(mask(httpBody)).toBe(mask(directBody));
    } finally {
      await client.close();
    }
  });

  it('responses leak no absolute host paths', async () => {
    const client = await httpClient(token);
    try {
      for (const [name, args] of [
        ['sfi.get_manifest', {}],
        ['sfi.health_check', {}],
        ['sfi.capabilities', {}],
        ['sfi.resolve', { query: 'alpha' }],
      ] as const) {
        const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
        const text = (r.content as { text: string }[])[0]?.text ?? '';
        expect(text.includes(vaultRoot)).toBe(false);
        expect(text.includes(tmpdir())).toBe(false);
      }
    } finally {
      await client.close();
    }
  });
});

describe('per-caller tokens (R8-PERCALLER-TOKENS)', () => {
  const SYNTH_ALICE = 'synth-token-alice-aaaaaaaaaaaaaaaa';
  const SYNTH_BOB = 'synth-token-bob-bbbbbbbbbbbbbbbbbb';

  it('loadTokensFile accepts array or {tokens}; rejects duplicates/empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-tokens-file-'));
    try {
      const arrPath = join(dir, 'tokens.json');
      writeFileSync(
        arrPath,
        JSON.stringify([
          { token: SYNTH_ALICE, id: 'alice', label: 'Alice Synth' },
          { token: SYNTH_BOB, id: 'bob' },
        ]),
        'utf8',
      );
      const loaded = loadTokensFile(arrPath);
      expect(loaded).toHaveLength(2);
      expect(loaded[0]?.label).toBe('Alice Synth');

      const wrapped = join(dir, 'wrapped.json');
      writeFileSync(
        wrapped,
        JSON.stringify({ tokens: [{ token: SYNTH_ALICE, id: 'alice' }] }),
        'utf8',
      );
      expect(loadTokensFile(wrapped)).toHaveLength(1);

      const dup = join(dir, 'dup.json');
      writeFileSync(
        dup,
        JSON.stringify([
          { token: SYNTH_ALICE, id: 'alice' },
          { token: SYNTH_ALICE, id: 'alice-2' },
        ]),
        'utf8',
      );
      expect(() => loadTokensFile(dup)).toThrow(/duplicate token/);
      expect(() => loadTokensFile(join(dir, 'missing.json'))).toThrow(/cannot read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveBearerAuth maps tokens to identities; solo token has none', () => {
    const entries = [
      { token: SYNTH_ALICE, id: 'alice', label: 'Alice Synth' },
      { token: SYNTH_BOB, id: 'bob' },
    ] as const;
    expect(resolveBearerAuth(SYNTH_ALICE, { tokens: entries })).toEqual({
      ok: true,
      identity: { id: 'alice', label: 'Alice Synth' },
    });
    expect(resolveBearerAuth(SYNTH_BOB, { tokens: entries })).toEqual({
      ok: true,
      identity: { id: 'bob' },
    });
    expect(resolveBearerAuth('wrong', { tokens: entries }).ok).toBe(false);
    expect(resolveBearerAuth(SYNTH_ALICE, { token: SYNTH_ALICE })).toEqual({
      ok: true,
      identity: undefined,
    });
    expect(matchTokenEntry(SYNTH_ALICE, entries)?.id).toBe('alice');
  });

  it('HTTP tokens map authenticates distinct callers; wrong token 401s', async () => {
    const mapped = await startHttpServer({
      vaultRoot,
      port: 0,
      host: '127.0.0.1',
      tokens: [
        { token: SYNTH_ALICE, id: 'alice', label: 'Alice Synth' },
        { token: SYNTH_BOB, id: 'bob' },
      ],
    });
    try {
      const bad = await fetch(`http://127.0.0.1:${mapped.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          Authorization: 'Bearer wrong-synth-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(bad.status).toBe(401);

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${mapped.port}/`),
        { requestInit: { headers: { Authorization: `Bearer ${SYNTH_ALICE}` } } },
      );
      const client = new Client({ name: 'tokens-map-test', version: '1' }, { capabilities: {} });
      await client.connect(transport as never);
      try {
        const r = await client.callTool({ name: 'sfi.get_manifest', arguments: {} });
        const body = JSON.parse((r.content as { text: string }[])[0]?.text ?? '{}');
        expect(body.data.sourceOrg).toBe('test');
      } finally {
        await client.close();
      }
    } finally {
      await mapped.close();
    }
  });

  it('bindCallerIdentity overlays identity for annotation attribution without mutating shared ctx', async () => {
    resetProposalSessionCap();
    const ctxResult = await buildContext(vaultRoot);
    if (!ctxResult.ok) throw new Error(ctxResult.error.message);
    try {
      const shared = ctxResult.value;
      expect(shared.callerIdentity).toBeUndefined();
      const alice = bindCallerIdentity(shared, { id: 'alice', label: 'Alice Synth' });
      expect(shared.callerIdentity).toBeUndefined();
      expect(alice.callerIdentity?.id).toBe('alice');
      const proposed = await proposeAnnotationHandler(alice, {
        componentId: 'ApexClass:Alpha',
        key: 'note',
        value: 'from alice',
      });
      expect(proposed.ok).toBe(true);
      const stored = await readAnnotations(vaultRoot);
      expect(stored.some((a) => a.author === 'Alice Synth' && a.value === 'from alice')).toBe(true);
    } finally {
      await shutdown(ctxResult.value);
    }
  });
});
