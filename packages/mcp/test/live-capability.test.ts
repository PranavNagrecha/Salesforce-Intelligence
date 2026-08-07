/// <reference types="vitest/globals" />

/**
 * INFRA-12-DEEP — registry livePlane completeness + sanctioned-seam lint +
 * capability-token behavior.
 *
 * Complements (does NOT replace) `plane-import-guard.test.ts`, the cheap
 * static import-graph gate. This suite is the deeper structural guard:
 * every tool is tagged, ambient consent is unreachable without a
 * LiveCapability, and resolveLiveAccess / hasLiveConsent stay inside the
 * sanctioned seam.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIVE_PLANE_OPT_IN_TOOLS,
  LIVE_PLANE_PRIMARY_EXTRA_TOOLS,
  livePlaneForTool,
  mintLiveCapability,
} from '../src/live-capability.js';
import { grantLiveConsent } from '../src/live-consent.js';
import type { Context } from '../src/server.js';
import { V01_TOOLS } from '../src/tools/index.js';
import {
  probeLiveAccess,
  resolveLiveAccess,
} from '../src/tools/live-plane.js';

const MCP_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const SANCTIONED_RESOLVE_LIVE_ACCESS = new Set([
  join(MCP_SRC_DIR, 'tools', 'live-plane.ts'),
  // Spec-sanctioned seam companion (budgeted session layer).
  join(MCP_SRC_DIR, 'tools', 'live-session.ts'),
]);

const SANCTIONED_HAS_LIVE_CONSENT = new Set([
  join(MCP_SRC_DIR, 'live-consent.ts'),
  join(MCP_SRC_DIR, 'tools', 'live-plane.ts'),
  // Barrel re-export for CLI data-shape capture — not a call site.
  join(MCP_SRC_DIR, 'index.ts'),
]);

const listSourceFiles = (dir: string): readonly string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};

describe('INFRA-12-DEEP — livePlane registry completeness', () => {
  it('tags every V01_TOOLS entry with never | opt-in | primary', () => {
    expect(V01_TOOLS.length).toBeGreaterThan(100);
    for (const tool of V01_TOOLS) {
      expect(
        tool.livePlane,
        `${tool.name} missing livePlane tag`,
      ).toMatch(/^(never|opt-in|primary)$/);
      expect(tool.livePlane).toBe(livePlaneForTool(tool.name));
    }
  });

  it('classifies sfi.live_* and primary-extra as primary', () => {
    for (const tool of V01_TOOLS) {
      if (
        tool.name.startsWith('sfi.live_') ||
        LIVE_PLANE_PRIMARY_EXTRA_TOOLS.has(tool.name)
      ) {
        expect(tool.livePlane, tool.name).toBe('primary');
      }
    }
  });

  it('classifies the audited opt-in set (coverage_report et al.) as opt-in', () => {
    for (const name of LIVE_PLANE_OPT_IN_TOOLS) {
      const tool = V01_TOOLS.find((t) => t.name === name);
      expect(tool, `${name} must be on the roster`).toBeDefined();
      expect(tool!.livePlane).toBe('opt-in');
    }
  });

  it('keeps ambient-composition offenders (health_check, tech_debt_score, synthesis reports) as never', () => {
    const mustStayNever = [
      'sfi.health_check',
      'sfi.tech_debt_score',
      'sfi.org_risk_report',
      'sfi.automation_risk_report',
      'sfi.permission_risk_report',
      'sfi.release_readiness_report',
    ];
    for (const name of mustStayNever) {
      const tool = V01_TOOLS.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.livePlane, name).toBe('never');
    }
  });
});

describe('INFRA-12-DEEP — sanctioned seam lint', () => {
  it('bans resolveLiveAccess( call sites outside live-plane.ts', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(MCP_SRC_DIR)) {
      if (SANCTIONED_RESOLVE_LIVE_ACCESS.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      // Call sites only — not the export declaration / import binding.
      if (/\bresolveLiveAccess\s*\(/.test(source)) {
        offenders.push(file.slice(MCP_SRC_DIR.length + 1));
      }
    }
    expect(
      offenders,
      'resolveLiveAccess( must stay inside live-plane.ts — use probeLiveAccess(ctx, …) from handlers',
    ).toEqual([]);
  });

  it('bans hasLiveConsent( call sites outside the sanctioned seam', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(MCP_SRC_DIR)) {
      if (SANCTIONED_HAS_LIVE_CONSENT.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      if (/\bhasLiveConsent\s*\(/.test(source)) {
        offenders.push(file.slice(MCP_SRC_DIR.length + 1));
      }
    }
    expect(
      offenders,
      'hasLiveConsent( must stay inside live-consent.ts / live-plane.ts',
    ).toEqual([]);
  });
});

describe('INFRA-12-DEEP — LiveCapability gates ambient consent', () => {
  const consentDir = mkdtempSync(join(tmpdir(), 'sfi-livecap-'));
  const consentPath = join(consentDir, 'live-consent.json');
  const savedConsent = process.env['SFI_CONSENT_PATH'];
  const savedLive = process.env['SFI_LIVE_PLANE_ENABLED'];
  const savedTransport = process.env['SFI_TRANSPORT'];

  beforeAll(async () => {
    process.env['SFI_CONSENT_PATH'] = consentPath;
    delete process.env['SFI_LIVE_PLANE_ENABLED'];
    delete process.env['SFI_TRANSPORT'];
    writeFileSync(consentPath, '{"version":2,"orgs":{}}\n', 'utf8');
    const granted = await grantLiveConsent('capability-test-org', {
      orgId: '00DCAPTEST000001AAA',
      principalUsername: 'cap@example.com',
      scopes: ['aggregate'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(granted.ok).toBe(true);
  });

  afterAll(() => {
    if (savedConsent === undefined) delete process.env['SFI_CONSENT_PATH'];
    else process.env['SFI_CONSENT_PATH'] = savedConsent;
    if (savedLive === undefined) delete process.env['SFI_LIVE_PLANE_ENABLED'];
    else process.env['SFI_LIVE_PLANE_ENABLED'] = savedLive;
    if (savedTransport === undefined) delete process.env['SFI_TRANSPORT'];
    else process.env['SFI_TRANSPORT'] = savedTransport;
    rmSync(consentDir, { recursive: true, force: true });
  });

  it('refuse ambient standing consent when capability is missing (never tool)', async () => {
    const decision = await resolveLiveAccess('capability-test-org');
    expect(decision).toMatchObject({ allowed: false, source: 'none' });
  });

  it('honors standing consent when capability is present (opt-in / primary)', async () => {
    const cap = mintLiveCapability('opt-in');
    expect(cap).toBeDefined();
    const decision = await resolveLiveAccess(
      'capability-test-org',
      undefined,
      cap,
    );
    expect(decision).toMatchObject({ allowed: true, source: 'consent' });
    expect(decision.grant?.orgId).toBe('00DCAPTEST000001AAA');
  });

  it('probeLiveAccess inherits Context.liveCapability (composed never stays closed)', async () => {
    const neverCtx = {
      vaultRoot: '/tmp',
      manifest: { sourceOrg: 'capability-test-org' },
      graph: {},
    } as unknown as Context;
    const neverProbe = await probeLiveAccess(neverCtx);
    expect(neverProbe.allowed).toBe(false);

    const optInCtx = {
      vaultRoot: '/tmp',
      manifest: { sourceOrg: 'capability-test-org' },
      graph: {},
      liveCapability: mintLiveCapability('opt-in'),
    } as unknown as Context;
    const optInProbe = await probeLiveAccess(optInCtx);
    expect(optInProbe).toMatchObject({
      allowed: true,
      source: 'consent',
      org: 'capability-test-org',
    });
  });

  it('mintLiveCapability(never) is undefined; opt-in/primary are branded tokens', () => {
    expect(mintLiveCapability('never')).toBeUndefined();
    expect(mintLiveCapability('opt-in')).toEqual({
      __brand: 'LiveCapability',
      tag: 'opt-in',
    });
    expect(mintLiveCapability('primary')?.tag).toBe('primary');
  });
});
