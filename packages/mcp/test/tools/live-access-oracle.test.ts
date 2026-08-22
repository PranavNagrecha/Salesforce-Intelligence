/// <reference types="vitest/globals" />

/**
 * PLATFORM-ACCESS-ORACLE — end-to-end contract pins for `sfi.live_access_oracle`.
 *
 * Hermetic: injected `ExecCommand` fakes for every `sf` call, an isolated
 * consent store, and a real (temp) DuckDB graph seeded with SYNTHETIC
 * containers and objects. No org, no network.
 *
 * The load-bearing pins:
 *  1. Fail-closed without consent, and registered in LIVE_TOOL_REQUIRED_SCOPES
 *     under `users` (an unmapped tool is dead on arrival by design).
 *  2. Every Tooling statement it issues is bounded (`LIMIT` + `IN (...)`) and
 *     routed with `--use-tooling-api`.
 *  3. "Platform confirmed" vs "platform not consulted" stay distinguishable in
 *     the output.
 *  4. A requested object the platform did not answer for is `unanswered`,
 *     never "no access".
 *  5. The profile LABEL is bridged to the vault API name through the
 *     refresh-built map — and every way that bridge can fail (map absent,
 *     label unknown, label ambiguous) REFUSES rather than guessing by name.
 *  6. The offline path is untouched: `effective_permissions` answers the same
 *     with the live plane fully revoked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { buildProfileNameMap, saveProfileNameMap } from '@sf-intelligence/vault';

import { mintLiveCapability } from '../../src/live-capability.js';
import {
  requiredScopesForTool,
  revokeLiveConsent,
} from '../../src/live-consent.js';
import type { Context } from '../../src/server.js';
import { effectivePermissionsHandler } from '../../src/tools/effective-permissions.js';
import { liveAccessOracleHandler } from '../../src/tools/live-access-oracle.js';
import { resetLiveSession } from '../../src/tools/live-session.js';
import { grantTestLiveAccess } from '../helpers/live-test-grant.js';

const ORG = 'test-org';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: ORG,
  components: { CustomObject: 3 },
  edges: { grantedBy: 2 },
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...o,
});

/**
 * Offline model: the profile grants Account read+edit and CLAIMS Account
 * create; nothing grants anything on Contact. The platform (below) will
 * confirm read+edit, DENY create (→ OVERSTATES) and GRANT Contact read
 * (→ UNDERSTATES). Ghost__c is modeled offline but the platform answers
 * nothing for it (→ UNKNOWN, not "no access").
 */
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'Profile:Std_User_Profile', type: 'Profile', apiName: 'Std_User_Profile' }),
    node({ id: 'PermissionSet:PS_Test', type: 'PermissionSet', apiName: 'PS_Test' }),
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
    node({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
    node({ id: 'CustomObject:Ghost__c', type: 'CustomObject', apiName: 'Ghost__c' }),
  ],
  edges: [
    edge({
      fromId: 'Profile:Std_User_Profile',
      toId: 'CustomObject:Account',
      edgeType: 'grantedBy',
      properties: { allowRead: true, allowEdit: true, allowCreate: true },
    }),
    edge({
      fromId: 'PermissionSet:PS_Test',
      toId: 'CustomObject:Ghost__c',
      edgeType: 'grantedBy',
      properties: { allowRead: true },
    }),
  ],
};

const USER_ID = '0050x0000000001AAA';
/** Invented Profile Id — the map join key. Belongs to no org. */
const PROFILE_ID = '00e0x0000000001AAA';
const JANE = {
  Id: USER_ID,
  Name: 'Jane Doe',
  Username: 'jane.doe@example.test',
  IsActive: true,
  // ProfileId is the RESOLUTION key. The label deliberately DIFFERS from the
  // vault API name ('Std_User_Profile'), so a passing test proves the map did
  // the work and could not have been a lucky exact-name match.
  ProfileId: PROFILE_ID,
  Profile: { Name: 'Standard Widget User' },
};

const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });

/** The REAL observed sandbox shape: R/E/Undel/FLS true, C/D false. */
const observedRow = (entity: string) => ({
  EntityDefinitionId: entity,
  IsReadable: true,
  IsCreatable: false,
  IsEditable: true,
  IsDeletable: false,
  IsUndeletable: true,
  IsFlsUpdatable: true,
});

interface ExecOptions {
  /** Objects the platform will answer for. Anything else comes back empty. */
  readonly answers?: readonly string[];
  /** Override the live profile LABEL the User query reports (echo only). */
  readonly profileName?: string | null;
  /** Override the live ProfileId — the actual resolution key. */
  readonly profileId?: string | null;
  /** Make the Tooling batch fail. */
  readonly toolingFails?: boolean;
}

interface RecordedExec {
  readonly exec: ExecCommand;
  readonly soqls: string[];
  readonly toolingSoqls: string[];
}

const makeExec = (opts: ExecOptions = {}): RecordedExec => {
  const answers = new Set(opts.answers ?? ['Account', 'Contact']);
  const soqls: string[] = [];
  const toolingSoqls: string[] = [];
  const exec: ExecCommand = async (_bin, args) => {
    const soql = String(args[args.indexOf('--query') + 1] ?? '');
    soqls.push(soql);
    if (args.includes('--use-tooling-api')) {
      toolingSoqls.push(soql);
      if (opts.toolingFails === true) throw new Error('sf CLI failed: Tooling 400');
      const inClause = /IN \(([^)]*)\)/.exec(soql)?.[1] ?? '';
      const requested = inClause
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter((s) => s.length > 0);
      const records = requested.filter((o) => answers.has(o)).map(observedRow);
      return respond({ result: { records, totalSize: records.length } });
    }
    if (soql.includes('FROM User WHERE Username =')) {
      const profileName =
        opts.profileName === undefined ? JANE.Profile.Name : opts.profileName;
      const row = {
        ...JANE,
        ProfileId: opts.profileId === undefined ? JANE.ProfileId : opts.profileId,
        Profile: profileName === null ? null : { Name: profileName },
      };
      return soql.includes("'jane.doe@example.test'")
        ? respond({ result: { records: [row], totalSize: 1 } })
        : respond({ result: { records: [], totalSize: 0 } });
    }
    if (soql.includes('FROM User WHERE Name =')) {
      return respond({ result: { records: [], totalSize: 0 } });
    }
    if (soql.includes('FROM PermissionSetAssignment')) {
      return respond({
        result: {
          records: [
            {
              PermissionSet: { Name: 'PS_Test' },
              PermissionSetGroupId: null,
              PermissionSetGroup: null,
            },
          ],
          totalSize: 1,
        },
      });
    }
    return respond({ result: { records: [], totalSize: 0 } });
  };
  return { exec, soqls, toolingSoqls };
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;
let consentDir: string;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-oracle-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = {
    vaultRoot: tempDir,
    manifest: MANIFEST,
    graph: store,
    liveCapability: mintLiveCapability('primary'),
    liveToolName: 'sfi.live_access_oracle',
  } as Context;
  // The refresh-built bridge: live LABEL 'Standard Widget User' -> vault API
  // name 'Std_User_Profile'. Invented profile, invented Id.
  await saveProfileNameMap(
    tempDir,
    buildProfileNameMap(
      [{ id: PROFILE_ID, fullName: 'Std_User_Profile' }],
      [{ Id: PROFILE_ID, Name: 'Standard Widget User' }],
      '2026-08-20T00:00:00.000Z',
    ),
  );
});

/** A second vault with NO profile-name map — the absent-bridge case. */
let noMapDir: string;
let noMapStore: GraphStore;
let noMapCtx: Context;

beforeAll(async () => {
  // Same graph, but the vault has NO profile-name map written into it.
  noMapDir = mkdtempSync(join(tmpdir(), 'sfi-oracle-nomap-'));
  const opened = await openGraph(join(noMapDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  noMapStore = opened.value;
  const imported = await importExtractionResults(noMapStore, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  noMapCtx = {
    vaultRoot: noMapDir,
    manifest: MANIFEST,
    graph: noMapStore,
    liveCapability: mintLiveCapability('primary'),
    liveToolName: 'sfi.live_access_oracle',
  } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  await closeGraph(noMapStore);
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(noMapDir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetLiveSession();
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-oracle-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  await grantTestLiveAccess(ORG);
});

afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  rmSync(consentDir, { recursive: true, force: true });
});

describe('consent + scope registration (fail-closed by design)', () => {
  it('is registered in LIVE_TOOL_REQUIRED_SCOPES under `users`, not aggregate', () => {
    expect(requiredScopesForTool('sfi.live_access_oracle')).toEqual(['users']);
  });

  it('fails closed with no standing grant and issues ZERO org queries', async () => {
    await revokeLiveConsent(ORG);
    const { exec, soqls } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/live org plane is not enabled/i);
    expect(soqls).toHaveLength(0);
    // FIX 9: the shared offline refusal is rendered for EVERY sfi.live_* tool,
    // so it must not name one tool's payload class. This oracle adjudicates a
    // user's object access via UserEntityAccess — it returns neither a record
    // count nor a live data value, so "record counts and live data values
    // require querying the live org" described the wrong tool entirely.
    expect(r.error.message).not.toContain('record counts');
    expect(r.error.message).toContain('this tool reads from the live Salesforce org');
    // The prefix two serve-http pins assert must survive verbatim.
    expect(r.error.message).toContain('Live org plane is not enabled');
  });

  it('refuses an aggregate-only grant (the users step-up is required)', async () => {
    await revokeLiveConsent(ORG);
    await grantTestLiveAccess(ORG, ['aggregate']);
    const { exec } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message.toLowerCase()).toContain('users');
  });
});

describe('the platform read is bounded and routed through Tooling', () => {
  it('issues LIMIT + IN(...) Tooling statements only — never an unbounded query', async () => {
    const { exec, toolingSoqls } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account', 'Contact'] },
      exec,
    );
    expect(r.ok).toBe(true);
    expect(toolingSoqls.length).toBeGreaterThan(0);
    for (const soql of toolingSoqls) {
      expect(soql).toMatch(/\bLIMIT \d+$/);
      expect(soql).toMatch(/EntityDefinitionId IN \('/);
      expect(soql).toContain('FROM UserEntityAccess');
    }
  });

  it('records the exact SOQL it asked, and that the platform WAS consulted', async () => {
    const { exec } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account', 'Contact'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.platformRead.consulted).toBe(true);
    expect(r.value.data.platformRead.batchCount).toBe(1);
    expect(r.value.data.platformRead.queries[0]).toContain('FROM UserEntityAccess');
    expect(r.value.data.trust.provenance).toBe('hybrid');
  });
});

describe('the diff', () => {
  it('reports OVERSTATES, UNDERSTATES and AGREE distinctly against the real flag shape', async () => {
    const { exec } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account', 'Contact'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value.data.parity;
    // Offline claims Account create; the platform says IsCreatable=false.
    expect(p.overstatements).toEqual([
      { object: 'Account', verb: 'create', offline: true, platform: false },
    ]);
    // Nothing grants Contact offline; the platform grants read + edit.
    expect(p.understatements.map((d) => `${d.object}.${d.verb}`).sort()).toEqual([
      'Contact.edit',
      'Contact.read',
    ]);
    expect(p.counts.agree).toBeGreaterThan(0);
    expect(r.value.data.interpretation).toMatch(/OVERSTATES/);
  });

  it('an unanswered object is UNKNOWN and named as unanswered — never "no access"', async () => {
    const { exec } = makeExec({ answers: ['Account'] });
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account', 'Ghost__c'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.platformRead.unanswered).toEqual(['Ghost__c']);
    expect(d.platformRead.complete).toBe(false);
    const ghost = d.parity.objects.find((o) => o.object === 'Ghost__c');
    expect(ghost?.platformAnswered).toBe(false);
    expect(ghost?.verbs.every((v) => v.verdict === 'unknown')).toBe(true);
    // Offline says Ghost__c is readable; the silence must NOT become an
    // overstatement, and must not be counted as a confirmed denial either.
    expect(d.parity.overstatements.some((x) => x.object === 'Ghost__c')).toBe(false);
    expect(d.rendered).toMatch(/NOT ANSWERED/);
  });

  it('states plainly that it CANNOT catch silence (unnamed objects are invisible)', async () => {
    // The structural blind spot: UserEntityAccess cannot be enumerated, so an
    // overstatement on an object nobody named can never surface. A clean report
    // must never read as "the offline engine is verified".
    const { exec } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.boundaries.some((b) => /CANNOT CATCH SILENCE/.test(b))).toBe(true);
    expect(d.boundaries.some((b) => /invisible to this tool/i.test(b))).toBe(true);
    expect(d.disclosure).toMatch(/cannot be enumerated/i);
    // And the envelope refuses to claim absence.
    expect(d.evidenceEnvelope.absence?.status).toBe('not-checked');
  });

  it('carries the verdict / unknown-reason glossary once, not per row', async () => {
    const { exec } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value.data.glossary.verdicts).sort()).toEqual([
      'agree',
      'offline-overstates',
      'offline-understates',
      'unknown',
    ]);
    expect(r.value.data.glossary.unknownReasons['platform-returned-no-row']).toMatch(
      /NOT evidence/i,
    );
  });

  it('emits an EvidenceEnvelope v2 whose coverage is partial while anything is unadjudicated', async () => {
    const { exec } = makeExec({ answers: ['Account'] });
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account', 'Ghost__c'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const env = r.value.data.evidenceEnvelope;
    expect(env.envelopeVersion).toBe(2);
    expect(env.coverage.status).toBe('partial');
    expect(env.coverage.missingCoverage).toContain('platform-no-row:Ghost__c');
    expect(env.absence?.status).toBe('not-checked');
    expect(env.trust.provenance).toBe('hybrid');
  });
});

describe('the offline grant bundle', () => {
  it('derives profile + permission sets from the live assignment by default', async () => {
    const { exec } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.offlineContainers;
    expect(c.source).toBe('derived-from-live-assignment');
    expect(c.requested).toEqual(['Profile:Std_User_Profile', 'PermissionSet:PS_Test']);
    expect(c.missingFromVault).toEqual([]);
  });

  it('bridges the live LABEL to the vault API name via the refresh-built map', async () => {
    // The fixture's live label ('Standard Widget User') is NOT the vault node
    // name ('Std_User_Profile'), so this can only pass through the map.
    const { exec } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.value.data.offlineContainers;
    expect(c.requested[0]).toBe('Profile:Std_User_Profile');
    expect(c.profileResolution).toEqual({
      label: 'Standard Widget User',
      profileId15: PROFILE_ID.slice(0, 15),
      mappedLabel: 'Standard Widget User',
      labelChangedSinceRefresh: false,
      apiName: 'Std_User_Profile',
      source: 'vault-profile-name-map',
      mapBuiltAt: '2026-08-20T00:00:00.000Z',
      mapEntries: 1,
      mapGaps: 0,
    });
  });

  it('REFUSES when the vault has NO profile-name map — never guesses by name', async () => {
    const { exec, toolingSoqls } = makeExec();
    const r = await liveAccessOracleHandler(
      noMapCtx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/no Profile Id<->API-name map/i);
    expect(r.error.message).toMatch(/sfi refresh/);
    expect(r.error.message).toMatch(/profileId/);
    // Refused BEFORE spending a Tooling batch on a diff it would not trust.
    expect(toolingSoqls).toHaveLength(0);
  });

  it('REFUSES a ProfileId the map does not carry (profile newer than the refresh)', async () => {
    const { exec, toolingSoqls } = makeExec({
      profileId: '00e0x0000000099AAA',
      profileName: 'Brand New Profile',
    });
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/not in this vault's Profile Id<->API-name map/i);
    expect(toolingSoqls).toHaveLength(0);
  });

  it('a RENAMED profile still resolves correctly and DISCLOSES the rename', async () => {
    // End-to-end proof that the resolution key is the id: the org has renamed
    // the profile since the refresh, and the oracle still lands on the right
    // container instead of silently diffing against someone else's bundle.
    const { exec } = makeExec({ profileName: 'Renamed Since Refresh' });
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.value.data.offlineContainers.profileResolution;
    expect(res?.apiName).toBe('Std_User_Profile');
    expect(res?.labelChangedSinceRefresh).toBe(true);
    expect(res?.mappedLabel).toBe('Standard Widget User');
  });

  it('REFUSES when the org returns no ProfileId — never falls back to the label', async () => {
    const { exec, toolingSoqls } = makeExec({ profileId: null });
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/no ProfileId/i);
    expect(toolingSoqls).toHaveLength(0);
  });

  it('asks the org for ProfileId (the stable key), not just the mutable label', async () => {
    const { exec, soqls } = makeExec();
    await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account'] },
      exec,
    );
    const userQuery = soqls.find((q) => q.includes('FROM User'));
    expect(userQuery).toContain('ProfileId');
  });

  it('accepts caller-supplied containers and labels the source honestly', async () => {
    const { exec } = makeExec({ profileName: 'System Administrator' });
    const r = await liveAccessOracleHandler(
      ctx,
      {
        user: 'jane.doe@example.test',
        objects: ['Account'],
        profileId: 'Std_User_Profile',
      },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.offlineContainers.source).toBe('caller-supplied');
    expect(r.value.data.offlineContainers.present).toEqual(['Profile:Std_User_Profile']);
    // The caller named the container, so no bridge was crossed — and the tool
    // says so rather than implying a resolution it never performed.
    expect(r.value.data.offlineContainers.profileResolution).toBeNull();
  });

  it('caller-supplied containers work even with NO map in the vault (the escape hatch)', async () => {
    const { exec } = makeExec();
    const r = await liveAccessOracleHandler(
      noMapCtx,
      {
        user: 'jane.doe@example.test',
        objects: ['Account'],
        profileId: 'Std_User_Profile',
      },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.offlineContainers.source).toBe('caller-supplied');
  });
});

describe('partial failure', () => {
  it('surfaces a failed Tooling batch as unanswered objects plus a trust limitation', async () => {
    const { exec } = makeExec({ toolingFails: true });
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ['Account', 'Contact'] },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.platformRead.failures).toHaveLength(1);
    expect(d.platformRead.unanswered).toEqual(['Account', 'Contact']);
    expect(d.platformRead.complete).toBe(false);
    expect(d.parity.overstatements).toEqual([]);
    expect(d.parity.understatements).toEqual([]);
    expect(d.parity.fullAgreement).toBe(false);
    expect(d.trust.limitations.some((l) => /batch\(es\) FAILED/.test(l))).toBe(true);
  });
});

describe('input validation', () => {
  it('refuses a malformed object name before touching the org', async () => {
    const { exec, soqls } = makeExec();
    const r = await liveAccessOracleHandler(
      ctx,
      { user: 'jane.doe@example.test', objects: ["Account' OR Id != null--"] },
      exec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(soqls).toHaveLength(0);
  });
});

describe('additivity — the offline path is untouched', () => {
  it('effective_permissions answers identically with the live plane fully revoked', async () => {
    const before = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:Std_User_Profile',
    });
    await revokeLiveConsent(ORG);
    const after = await effectivePermissionsHandler(ctx, {
      profileId: 'Profile:Std_User_Profile',
    });
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(JSON.stringify(after.value.data)).toBe(JSON.stringify(before.value.data));
    const account = after.value.data.objectPermissions.find((o) => o.object === 'Account');
    // Still the offline engine's OWN (overstating) answer — the oracle reports
    // the disagreement, it never silently corrects the offline surface.
    expect(account?.allowCreate).toBe(true);
  });
});
