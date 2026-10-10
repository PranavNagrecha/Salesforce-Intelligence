/// <reference types="vitest/globals" />
/**
 * FR-03 / FR-06 / FR-11 — FAIL-BEFORE/PASS-AFTER.
 *
 * FR-03: an unauthenticated / mistyped alias surfaced only sf's header line
 *   ("Error (NamedOrgNotFoundError): Parsing --target-org"), after the type
 *   probe and a full retrieve attempt. Now a local auth preflight fails fast
 *   with the fix, and salientErrorLine keeps the cause line sf prints next.
 * FR-06: every setup surface listed orgs with a connection check to every
 *   org; the shared reader now passes --skip-connection-status.
 * FR-11: a refresh that failed before extraction printed empty
 *   "Components (none) / Edges (none)" tables above the Fatal line.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authPreflight, formatRefreshSummary, runRefresh, salientErrorLine } from '../../src/commands/refresh.js';
import { listAuthenticatedOrgs, parseOrgList } from '../../src/sf-org-list.js';

const SF_ORG_LIST = JSON.stringify({
  status: 0,
  result: {
    nonScratchOrgs: [
      { alias: 'acme-dev', username: 'dev@acme.example', isDefaultUsername: true },
      { username: 'qa@acme.example' },
    ],
    scratchOrgs: [],
  },
});

describe('salientErrorLine keeps the sf cause after the header (FR-03)', () => {
  it('includes the detail line and a login remedy for NamedOrgNotFoundError', () => {
    const raw = [
      'Command failed: sf project retrieve start --target-org nosuch-alias',
      'Error (NamedOrgNotFoundError): Parsing --target-org',
      '    No authorization information found for nosuch-alias.',
      '',
      'Try this:',
      'Run sf org list to see your orgs.',
    ].join('\n');
    const line = salientErrorLine(raw);
    expect(line).toContain('No authorization information found for nosuch-alias.');
    expect(line).toContain('sf org login web');
    expect(line).not.toContain('Try this');
  });

  it('leaves a single-line error alone', () => {
    expect(salientErrorLine('Error (X): boom')).toBe('Error (X): boom');
  });
});

describe('shared org list (FR-06)', () => {
  it('asks sf for the LOCAL login list only (--skip-connection-status)', async () => {
    const run = vi.fn(async () => ({ stdout: SF_ORG_LIST }));
    const r = await listAuthenticatedOrgs({ run });
    expect(run).toHaveBeenCalledWith(['org', 'list', '--skip-connection-status', '--json'], expect.any(Number));
    expect(r.ok && r.orgs.map((o) => o.alias ?? o.username)).toEqual(['acme-dev', 'qa@acme.example']);
  });

  it('marks the default org and never throws on failure', async () => {
    expect(parseOrgList(SF_ORG_LIST)[0]?.isDefault).toBe(true);
    const r = await listAuthenticatedOrgs({ run: async () => Promise.reject(new Error('sf: not found')) });
    expect(r.ok).toBe(false);
  });
});

describe('refresh auth preflight (FR-03) + early-failure summary (FR-11)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'sfi-firstrun-'));
    await mkdir(join(cwd, 'org-kb', 'meta'), { recursive: true });
    await writeFile(
      join(cwd, 'org-kb', 'meta', 'config.json'),
      JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', targetOrg: 'typo-alias', vaultRoot: join(cwd, 'org-kb'), version: '0.0.0' }),
      'utf8',
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('fails fast, before any retrieve, naming the alias and the fix', async () => {
    const result = await runRefresh({
      cwd,
      noPull: false,
      listOrgs: async () => ({ ok: true, orgs: parseOrgList(SF_ORG_LIST) }),
    });
    expect(result.status).toBe('failed');
    expect(result.fatalError).toContain('`typo-alias` is not one of your authenticated sf orgs');
    expect(result.fatalError).toContain('sf org login web --alias typo-alias');
    const summary = formatRefreshSummary(result);
    expect(summary).not.toContain('(none)');
    expect(summary).toContain('Fatal:');
  });
});

describe('authPreflight (FR-03)', () => {
  const list = async () => ({ ok: true as const, orgs: parseOrgList(SF_ORG_LIST) });

  it('accepts an alias or a username, and never blocks on an unreadable list', async () => {
    expect(await authPreflight('acme-dev', list)).toBeNull();
    expect(await authPreflight('qa@acme.example', list)).toBeNull();
    expect(await authPreflight('typo', async () => ({ ok: false as const, reason: 'sf missing' }))).toBeNull();
  });

  it('SFI_SKIP_AUTH_PREFLIGHT=1 skips the check (auth the local list cannot see)', async () => {
    vi.stubEnv('SFI_SKIP_AUTH_PREFLIGHT', '1');
    try {
      const listOrgs = vi.fn(list);
      expect(await authPreflight('typo', listOrgs)).toBeNull();
      expect(listOrgs).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
