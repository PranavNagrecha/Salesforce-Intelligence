/// <reference types="vitest/globals" />

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DOCS_URL, FEEDBACK_ISSUES_URL } from '@sf-intelligence/core';

import {
  createSetupServer,
  setupStatusPayload,
  type SetupState,
} from '../src/setup-server.js';

/**
 * Setup mode is the answer to the product's worst onboarding failure: `sfi mcp`
 * used to `process.exit(1)` when it could not find a vault, which every MCP host
 * renders as "server failed to connect" with no explanation. The guidance went
 * to stderr, which the person in the chat cannot see.
 *
 * These tests pin the two properties that make the fix real:
 *   1. the server CONNECTS in the no-vault state (a dead server helps nobody);
 *   2. what it says is actionable and refuses to pretend it has org data.
 */

const baseState = (over: Partial<SetupState> = {}): SetupState => ({
  reason: 'no-vault',
  detail: 'No vault. Run `sfi init` followed by `sfi refresh`.',
  cwd: '/home/someone/Documents',
  expectedVaultRoot: '/home/someone/Documents/org-kb',
  bindSource: 'default ./org-kb',
  authedOrgs: ['Acme-Prod', 'Acme-UAT'],
  version: '0.3.2',
  ...over,
});

describe('setupStatusPayload', () => {
  it('states plainly that it cannot answer org questions', () => {
    const data = setupStatusPayload(baseState()).data as Record<string, unknown>;
    // The whole point of the mode: a host must not infer from a short tool list
    // that there is simply nothing to report about the org.
    expect(data['canAnswerOrgQuestions']).toBe(false);
    expect(data['status']).toBe('setup-required');
  });

  it('names the authed orgs so the user can pick one — but never picks one itself (FR-02)', () => {
    const data = setupStatusPayload(baseState()).data as Record<string, unknown>;
    expect(data['authenticatedOrgs']).toEqual(['Acme-Prod', 'Acme-UAT']);
    // FAIL-BEFORE: `authedOrgs[0]` (just the first row of `sf org list`) was
    // threaded into the init/refresh commands as if the user had chosen it.
    const text = (data['nextSteps'] as readonly string[]).join('\n');
    expect(text).not.toContain('Acme-Prod');
    expect(text).toContain('--target-org <your-org-alias>');
  });

  it('names the sf default org as a labelled hint, not a choice (FR-02)', () => {
    const data = setupStatusPayload(baseState({ defaultOrg: 'Acme-UAT' })).data as Record<string, unknown>;
    const text = (data['nextSteps'] as readonly string[]).join('\n');
    expect(text).toContain('--target-org <your-org-alias>');
    expect(text).toContain('your sf default org is `Acme-UAT`');
  });

  it('never suggests pinning the path it already searched (FR-02)', () => {
    // FAIL-BEFORE: launched from `/`, the fix offered was `--vault /org-kb` —
    // the exact path that had just failed.
    const data = setupStatusPayload(
      baseState({ cwd: '/', expectedVaultRoot: '/org-kb' }),
    ).data as Record<string, unknown>;
    const text = (data['nextSteps'] as readonly string[]).join('\n');
    expect(text).not.toContain('--vault /org-kb');
    expect(text).toContain('--vault <absolute path to your project>/org-kb');
    expect(String(data['pinVaultExample'])).not.toContain("'/org-kb'");
  });

  it('tells a typo\'d --vault apart from "build a new vault" (FR-02)', () => {
    const data = setupStatusPayload(
      baseState({ reason: 'vault-path-not-found', bindSource: '--vault', expectedVaultRoot: '/nonexistent/org-kb' }),
    ).data as Record<string, unknown>;
    const steps = data['nextSteps'] as readonly string[];
    expect(steps[0]).toContain('does not exist');
    expect(steps[0]).toContain('/nonexistent/org-kb');
    expect(String(data['summary'])).toMatch(/typo/);
  });

  it('does not claim the server restarts by itself (FR-02)', () => {
    const text = (setupStatusPayload(baseState()).data as Record<string, unknown>)['nextSteps'] as readonly string[];
    expect(text.join('\n')).toMatch(/does not reload by itself/);
  });

  it('tells a user with no vault to run init before refresh', () => {
    const steps = setupStatusPayload(baseState()).data as Record<
      string,
      unknown
    >;
    const text = (steps['nextSteps'] as readonly string[]).join('\n');
    expect(text).toContain('init');
    expect(text.indexOf('init')).toBeLessThan(text.indexOf('refresh'));
  });

  it('does NOT re-tell an already-initialised user to run init', () => {
    // `vault-missing` means config.json exists — init already ran, and telling
    // them to re-run it invites re-binding a repo that is already bound.
    const data = setupStatusPayload(
      baseState({ reason: 'vault-missing', authedOrgs: ['Acme-Prod'] }),
    ).data as Record<string, unknown>;
    const text = (data['nextSteps'] as readonly string[]).join('\n');
    expect(text).toContain('refresh');
    expect(text).not.toContain('sf-intelligence init');
  });

  it('surfaces the cwd trap when the vault was bound from the launch directory', () => {
    // The host picks the server's cwd, not the user. When `./org-kb` is what
    // resolved, a correct vault elsewhere on disk is the likeliest explanation,
    // and it is invisible from inside the chat unless we say so.
    const data = setupStatusPayload(baseState()).data as Record<string, unknown>;
    const text = (data['nextSteps'] as readonly string[]).join('\n');
    expect(text).toContain('--vault');
    expect(text).toContain('SFI_VAULT');
    expect(text).toContain('/home/someone/Documents');
  });

  it('omits the cwd trap when the vault was pinned explicitly', () => {
    const data = setupStatusPayload(
      baseState({ bindSource: '--vault' }),
    ).data as Record<string, unknown>;
    const text = (data['nextSteps'] as readonly string[]).join('\n');
    expect(text).not.toContain('resolved `./org-kb`');
  });

  /**
   * The failure surface has to offer a way to report the failure.
   *
   * This tool is where a stranger lands when the server started and found no
   * org — the moment a first run is most likely going wrong — and it carried a
   * docs link and nothing else. The repo has had issues open and unrestricted
   * since publication and has never received one.
   *
   * The second assertion is the point: the URL must be the SAME OBJECT as
   * `@sf-intelligence/core`'s, not an equal string. `packages/mcp` cannot
   * import `packages/cli` (cycle), and the cheap way out was a second literal
   * in the MCP tree — which is this repo's documented root cause. Comparing
   * against the shared constant is what stops that copy reappearing.
   */
  it('offers a feedback channel, derived from the one shared constant', () => {
    const data = setupStatusPayload(baseState()).data as Record<string, unknown>;
    const channel = String(data['ifTheseStepsDoNotWork'] ?? '');
    expect(channel).toContain(FEEDBACK_ISSUES_URL);
    expect(data['docs']).toBe(DOCS_URL);
  });

  it('gives the env-var syntax for the shell the user is actually in', () => {
    const data = setupStatusPayload(baseState()).data as Record<string, unknown>;
    const expected =
      process.platform === 'win32'
        ? "$env:SFI_VAULT = '<absolute path to your project>\\org-kb'"
        : "export SFI_VAULT='<absolute path to your project>/org-kb'";
    expect(data['pinVaultExample']).toBe(expected);
  });

  it('falls back to a placeholder rather than inventing an org alias', () => {
    const data = setupStatusPayload(baseState({ authedOrgs: [] })).data as Record<
      string,
      unknown
    >;
    expect((data['nextSteps'] as readonly string[]).join('\n')).toContain(
      '<your-org-alias>',
    );
  });
});

// FR-02 follow-up — FAIL-BEFORE/PASS-AFTER: for a mistyped explicit path,
// `detail` still said "Run `sfi init` followed by `sfi refresh`" and the
// handshake said "the knowledge base is not built yet", both contradicting
// nextSteps ("check it for a typo"); for vault-missing the refresh step said
// "in that project" with no project named earlier.
describe('setup guidance is consistent per reason', () => {
  const typo = baseState({
    reason: 'vault-path-not-found',
    bindSource: '--vault',
    expectedVaultRoot: '/srv/projects/acme/org-kb-typo',
  });

  it('a mistyped path gets a detail that does not tell the user to run init', () => {
    const data = setupStatusPayload(typo).data as Record<string, unknown>;
    expect(data['detail']).not.toMatch(/sfi init/);
    expect(data['detail']).toContain('/srv/projects/acme/org-kb-typo');
  });

  it('a mistyped path gets handshake instructions about the path, not "not built yet"', async () => {
    const server = createSetupServer(typo);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).not.toMatch(/not built yet/);
    expect(instructions).toContain('configured vault path does not exist');
    await client.close();
  });

  // FAIL-BEFORE/PASS-AFTER (second review): the redirect for any non-setup tool
  // and the setup tool's own description said "no knowledge base for this
  // project yet" for a mistyped path too — the "not built" story this
  // per-reason guidance exists to avoid.
  it('a mistyped path gets a tool-call redirect about the path, not "not built yet"', async () => {
    const server = createSetupServer(typo);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({ name: 'sfi.get_impact', arguments: {} });
    const text = (result.content as readonly { text: string }[])[0]!.text;
    expect(text).not.toMatch(/no knowledge base for this project yet/);
    expect(text).toContain('does not exist');
    const tools = await client.listTools();
    expect(tools.tools[0]?.description).not.toMatch(/for this project yet/);
    await client.close();
  });

  it('vault-missing names the project directory the refresh must run in', () => {
    const steps = (
      setupStatusPayload(baseState({ reason: 'vault-missing', expectedVaultRoot: '/srv/projects/acme/org-kb' }))
        .data as Record<string, unknown>
    )['nextSteps'] as readonly string[];
    const refresh = steps.find((s) => s.includes('sf-intelligence refresh')) ?? '';
    expect(refresh).not.toContain('in that project');
    expect(refresh).toContain('/srv/projects/acme');
  });
});

describe('createSetupServer over a real MCP transport', () => {
  const connect = async (
    state: SetupState = baseState(),
  ): Promise<Client> => {
    const server = createSetupServer(state);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'test', version: '1' },
      { capabilities: {} },
    );
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    return client;
  };

  it('CONNECTS instead of dying — the regression this mode exists to prevent', async () => {
    const client = await connect();
    // Before setup mode this state produced `process.exit(1)`, which a host
    // reports as "failed to connect" with the reason hidden on stderr.
    expect(client.getServerVersion()?.name).toBe('sf-intelligence');
    await client.close();
  });

  it('advertises setup guidance in the MCP instructions handshake', async () => {
    const client = await connect();
    // Hosts surface `instructions` without a tool call, so the model is told
    // not to guess even if it never thinks to ask.
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('sfi.setup_status');
    // FR-02: FAIL-BEFORE it promised 'this server restarts with the full tool set' — it has no watcher.
    expect(instructions).not.toMatch(/this server restarts/);
    expect(instructions).toMatch(/do not guess|Do not guess/);
    await client.close();
  });

  it('exposes exactly one read-only tool', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['sfi.setup_status']);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it('answers sfi.setup_status with the actionable payload', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'sfi.setup_status',
      arguments: {},
    });
    const body = JSON.parse(
      (result.content as readonly { text: string }[])[0]!.text,
    ) as { data: Record<string, unknown> };
    expect(body.data['status']).toBe('setup-required');
    expect(body.data['authenticatedOrgs']).toEqual(['Acme-Prod', 'Acme-UAT']);
    // Text-only, like the vault server: the envelope is sent once.
    expect(result.structuredContent).toBeUndefined();
    await client.close();
  });

  it('redirects any other tool call to setup_status instead of failing opaquely', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'sfi.get_impact',
      arguments: {},
    });
    // A host that optimistically calls a vault tool must be told WHY it cannot
    // work and what to call instead — not handed an unknown-tool error.
    expect(result.isError).toBe(true);
    const text = (result.content as readonly { text: string }[])[0]!.text;
    expect(text).toContain('sfi.setup_status');
    expect(text).toContain('sfi.get_impact');
    await client.close();
  });
});
