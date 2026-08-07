/// <reference types="vitest/globals" />

import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../src/live-capability.js';
import {
  LIVE_TOOL_REQUIRED_SCOPES,
  grantLiveConsent,
  orgIdsMatch,
  requiredScopesForTool,
} from '../src/live-consent.js';
import type { Context } from '../src/server.js';
import { V01_TOOLS } from '../src/tools/index.js';
import {
  assertSoqlWithinLiveScopes,
  liveCountHandler,
  liveSampleHandler,
  resolveLiveAccess,
  soqlFromObjects,
} from '../src/tools/live-plane.js';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-scope-'));
  storePath = join(dir, 'live-consent.json');
  process.env.SFI_CONSENT_PATH = storePath;
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  process.env.SFI_LIVE_SKIP_IDENTITY_VERIFY = '1';
});

afterEach(() => {
  delete process.env.SFI_CONSENT_PATH;
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  process.env.SFI_LIVE_SKIP_IDENTITY_VERIFY = '1';
  rmSync(dir, { recursive: true, force: true });
});

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'scope-org',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const ctxFor = (toolName: string): Context =>
  ({
    manifest: FIXTURE_MANIFEST,
    liveCapability: mintLiveCapability('primary'),
    liveToolName: toolName,
  }) as Context;

const queryExec: ExecCommand = async (_cmd, args) => {
  if (args.includes('org') && args.includes('display')) {
    return {
      stdout: JSON.stringify({
        status: 0,
        result: {
          id: '00D000000000001AAA',
          username: 'scope@example.com',
          accessToken: 'tok',
          instanceUrl: 'https://example.my.salesforce.com',
          apiVersion: '67.0',
        },
      }),
      stderr: '',
    };
  }
  return {
    stdout: JSON.stringify({
      result: { totalSize: 1, records: [{ Id: '005xx' }] },
    }),
    stderr: '',
  };
};

describe('3.1 live_sample cannot bypass users scope via SOQL', () => {
  it('parses FROM targets including subqueries', () => {
    expect(soqlFromObjects('SELECT Id FROM Account')).toEqual(['Account']);
    expect(
      soqlFromObjects(
        'SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Id IN (SELECT AccountId FROM Contact)',
      ),
    ).toEqual(['Contacts', 'Account', 'Contact']);
  });

  it('refuses identity FROM without users scope', () => {
    const r = assertSoqlWithinLiveScopes('SELECT Id, Email FROM User LIMIT 5', {
      grantId: 'g',
      orgId: '00D000000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate', 'sample'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      source: 'consent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/users/i);
  });

  it('allows identity FROM when users scope is present', () => {
    const r = assertSoqlWithinLiveScopes('SELECT Id FROM User LIMIT 5', {
      grantId: 'g',
      orgId: '00D000000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['users'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      source: 'consent',
    });
    expect(r.ok).toBe(true);
  });

  it('live_sample handler refuses User SOQL under sample-only grant', async () => {
    await grantLiveConsent('scope-org', {
      orgId: '00D000000000001AAA',
      principalUsername: 'scope@example.com',
      scopes: ['aggregate', 'sample'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const r = await liveSampleHandler(
      ctxFor('sfi.live_sample'),
      { soql: 'SELECT Id, Username, Email FROM User' },
      queryExec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/users/i);
  });

  it('live_count refuses COUNT() FROM User under aggregate-only grant', async () => {
    await grantLiveConsent('scope-org', {
      orgId: '00D000000000001AAA',
      principalUsername: 'scope@example.com',
      scopes: ['aggregate'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const r = await liveCountHandler(
      ctxFor('sfi.live_count'),
      { soql: 'SELECT COUNT() FROM User' },
      queryExec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/users/i);
  });

  it('fails closed when FROM cannot be parsed', () => {
    const r = assertSoqlWithinLiveScopes('SELECT Id', {
      grantId: 'g',
      orgId: '00D000000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['sample', 'users'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      source: 'consent',
    });
    expect(r.ok).toBe(false);
  });
});

describe('3.2 requiredScopesForTool is an explicit allowlist', () => {
  it('maps every registered sfi.live_* tool', () => {
    const liveTools = V01_TOOLS.map((t) => t.name).filter((n) =>
      n.startsWith('sfi.live_'),
    );
    const missing = liveTools.filter((n) => !(n in LIVE_TOOL_REQUIRED_SCOPES));
    expect(missing).toEqual([]);
  });

  it('denies unmapped tools (no aggregate default)', async () => {
    expect(requiredScopesForTool('sfi.live_brand_new_tool')).toBeNull();
    const decision = await resolveLiveAccess(
      'scope-org',
      undefined,
      mintLiveCapability('primary'),
      null,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denial).toBe('unmapped-tool');
  });

  it('setup_audit_trail requires users, not aggregate', () => {
    expect(requiredScopesForTool('sfi.live_setup_audit_trail')).toEqual(['users']);
  });
});

describe('3.3 OrgId binding enforced at use time', () => {
  it('normalizes 15- vs 18-char OrgIds', () => {
    expect(orgIdsMatch('00D000000000001', '00D000000000001AAA')).toBe(true);
    expect(orgIdsMatch('00D000000000001AAA', '00D000000000002AAA')).toBe(false);
  });

  it('refuses when authenticated OrgId differs from the grant', async () => {
    // Call the verifier directly (do not toggle process-wide SKIP — parallel
    // vitest workers share env and would race other live-plane tests).
    const { verifyGrantIdentity } = await import('../src/tools/live-plane.js');
    const prev = process.env.SFI_LIVE_SKIP_IDENTITY_VERIFY;
    delete process.env.SFI_LIVE_SKIP_IDENTITY_VERIFY;
    try {
      const r = await verifyGrantIdentity(
        'scope-org',
        {
          grantId: 'g',
          orgId: '00DOTHERORG00001AAA',
          principalUsername: 'scope@example.com',
          scopes: ['aggregate', 'sample'],
          expiresAt: '2099-01-01T00:00:00.000Z',
          source: 'consent',
        },
        queryExec,
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toMatch(/different Salesforce OrgId|re-grant/i);
    } finally {
      process.env.SFI_LIVE_SKIP_IDENTITY_VERIFY = prev ?? '1';
    }
  });
});

describe('3.5 consent store file modes', () => {
  it('writes the consent file as 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    await grantLiveConsent('mode-org', {
      orgId: '00D000000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    // Force a too-open mode then reload to prove harden-on-read.
    chmodSync(storePath, 0o644);
    await grantLiveConsent('mode-org-2', {
      orgId: '00D000000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const mode = statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
