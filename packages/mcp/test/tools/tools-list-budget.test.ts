/// <reference types="vitest/globals" />

/**
 * TOOLS-LIST BUDGET.
 *
 * A host pays for `tools/list` and the `initialize` instructions before the
 * user's first question, on every session. The default `core` profile cost
 * ~116 KB of tool definitions, because each tool's `description` was carrying
 * three jobs: the host contract, the funnel's retrieval document, and the full
 * long-form reference. The long form now lives in `reference` (served by
 * `sfi.describe_analysis {detail:'full'}` and indexed by the funnel), and the
 * advertised `description` is the contract only.
 *
 * Nothing measured this before, so the size could only grow. These assertions
 * are the tripwire: measured over the REAL server through a real MCP client, so
 * a field added to tools/list (an outputSchema, an annotation) is counted too.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { VaultManifest } from '@sf-intelligence/contracts';
import { saveManifest, vaultPaths } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { SERVER_INSTRUCTIONS, buildContext, createServer, shutdown } from '../../src/server.js';
import { oneLiner } from '../../src/tools/catalog-gateway.js';
import { V01_TOOLS, advertisedTools } from '../../src/tools/index.js';

/** Default-profile tools/list `tools[]`, compact JSON bytes. Measured 31.4 KB. */
const CORE_TOOLS_LIST_MAX_BYTES = 40_000;
/** Longest core description (route_question) measured 1.4 KB. */
const CORE_DESCRIPTION_MAX_BYTES = 1_600;
/** `initialize` instructions; measured 3.0 KB. */
const INSTRUCTIONS_MAX_BYTES = 3_500;

/** Build-history vocabulary a host cannot act on: milestone ids and change narration. */
const MILESTONE_ID = /\b(R\d+-\w+|P\d+(-\w+)?|v\d\.\d+[a-z]|Finding #\d+|B\d{2}|AUDIT-F\d+|MCP-\d+)\b/;
const HISTORY_WORDS = /\b(previously|no longer|used to|now)\b/i;

const bytes = (value: unknown): number =>
  Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

const manifest = (): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
});

describe('core tools/list stays inside its token budget', () => {
  let vault = '';
  let ctx: Context | null = null;
  let client: Client;

  beforeAll(async () => {
    vault = await mkdtemp(join(tmpdir(), 'sfi-tools-budget-'));
    await mkdir(vaultPaths(vault).graph, { recursive: true });
    const saved = await saveManifest(vault, manifest());
    if (!saved.ok) throw new Error(saved.error.message);
    const built = await buildContext(vault);
    if (!built.ok) throw new Error(built.error.message);
    ctx = built.value;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(ctx).connect(serverSide);
    client = new Client({ name: 'budget-test', version: '1' }, { capabilities: {} });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client?.close();
    if (ctx !== null) await shutdown(ctx);
    await rm(vault, { recursive: true, force: true });
  });

  it(`advertises the core roster in at most ${CORE_TOOLS_LIST_MAX_BYTES} bytes`, async () => {
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.outputSchema !== undefined)).toBe(false);
    // Corpus is real: the budget over an empty list proves nothing.
    expect(tools.length).toBe(advertisedTools('core').length);
    expect(tools.length).toBeGreaterThan(20);
    expect(bytes(tools)).toBeLessThanOrEqual(CORE_TOOLS_LIST_MAX_BYTES);
  });

  it(`keeps the initialize instructions under ${INSTRUCTIONS_MAX_BYTES} bytes`, () => {
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(bytes(SERVER_INSTRUCTIONS)).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES);
    // Load-bearing rules must survive any further trimming.
    for (const rule of ['sfi.resolve', 'sfi.run_analysis', 'sfi.route_question', 'sfi.live_consent', 'Empty is not none']) {
      expect(SERVER_INSTRUCTIONS).toContain(rule);
    }
  });

  it.each(advertisedTools('core').map((t) => [t.name, t] as const))(
    '%s: a short, history-free contract',
    (_name, tool) => {
      expect(bytes(tool.description)).toBeLessThanOrEqual(CORE_DESCRIPTION_MAX_BYTES);
      expect(tool.description).not.toMatch(MILESTONE_ID);
      expect(tool.description).not.toMatch(HISTORY_WORDS);
      // The first sentence is the list_analyses / route_question one-liner, so
      // it must stand alone: an "e.g." would cut it mid-thought.
      expect(oneLiner(tool.description)).not.toContain('e.g.');
    },
  );

  it('every shortened core tool keeps its long form as `reference`', () => {
    for (const tool of advertisedTools('core')) {
      if (tool.reference === undefined) continue;
      expect(tool.reference.length, tool.name).toBeGreaterThan(0);
      expect(tool.reference, tool.name).not.toBe(tool.description);
    }
    // At least the shortened half of the roster carries one; a split that
    // silently dropped every reference would otherwise pass the loop above.
    expect(advertisedTools('core').filter((t) => t.reference !== undefined).length).toBe(
      advertisedTools('core').length,
    );
  });

  it("FAIL-BEFORE/PASS-AFTER: describe_analysis detail:'full' serves the long-form reference", async () => {
    const tool = V01_TOOLS.find((t) => t.name === 'sfi.what_happens_on_save');
    expect(tool?.reference).toBeDefined();
    const result = await client.callTool({
      name: 'sfi.describe_analysis',
      arguments: { name: 'sfi.what_happens_on_save', detail: 'full' },
    });
    // Sent once, as text: a real SDK client accepted it with no outputSchema.
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as readonly { readonly text: string }[])[0]?.text ?? '';
    const data = (JSON.parse(text) as { data: Record<string, unknown> }).data;
    expect(data['description']).toBe(tool?.description);
    expect(data['reference']).toBe(tool?.reference);
  });
});
