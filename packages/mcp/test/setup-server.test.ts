/// <reference types="vitest/globals" />

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
  cwd: '/Users/someone/Documents',
  expectedVaultRoot: '/Users/someone/Documents/org-kb',
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

  it('names the authed orgs so the user can pick one', () => {
    const data = setupStatusPayload(baseState()).data as Record<string, unknown>;
    expect(data['authenticatedOrgs']).toEqual(['Acme-Prod', 'Acme-UAT']);
    // The first alias is threaded into the copy-pasteable command rather than a
    // placeholder the user has to decode.
    expect((data['nextSteps'] as readonly string[]).join('\n')).toContain(
      'Acme-Prod',
    );
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
    expect(text).toContain('/Users/someone/Documents');
  });

  it('omits the cwd trap when the vault was pinned explicitly', () => {
    const data = setupStatusPayload(
      baseState({ bindSource: '--vault' }),
    ).data as Record<string, unknown>;
    const text = (data['nextSteps'] as readonly string[]).join('\n');
    expect(text).not.toContain('resolved `./org-kb`');
  });

  it('gives the env-var syntax for the shell the user is actually in', () => {
    const data = setupStatusPayload(baseState()).data as Record<string, unknown>;
    const expected =
      process.platform === 'win32'
        ? "$env:SFI_VAULT = '/Users/someone/Documents/org-kb'"
        : "export SFI_VAULT='/Users/someone/Documents/org-kb'";
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
