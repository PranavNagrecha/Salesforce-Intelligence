/// <reference types="vitest/globals" />

/**
 * ENGINE-ARC §2b — sfi.live_group_members contract pins.
 *
 * All fixtures are SYNTHETIC (Jane Doe / Test_Queue / Nested_Test_Group) — no
 * real org strings. Injected ExecCommand fakes; consent store isolated per
 * test via SFI_CONSENT_PATH + resetLiveSession (live-automation-fired
 * pattern); a real DuckDB vault seeds the drift cross-check.
 *
 * The load-bearing pins:
 *  1. Polymorphic GroupMember split — `005` ids resolve to Users, `00G` ids to
 *     nested Groups, and Role/RoleAndSubordinates proxy groups surface as ROLE
 *     entries (UserRole name) that are NEVER expanded to users.
 *  2. Fail-closed nested expansion — default OFF; expandNested expands exactly
 *     ONE level and stamps expansion 'partial-one-level' with the unexpanded
 *     remainder counted, never presented as full effective membership.
 *  3. Vault drift — vaultDeclaredMemberCount (declared metadata) vs
 *     liveDirectMemberCount with a drift boolean: the measured retirement of
 *     the old "runtime membership not reflected" disclosure.
 *  4. QueueSobject — supportedObjects answers "can the queue own Case".
 *  5. Byte-trim invariance — totalDirectMembers is never understated.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import type { Context } from '../../src/server.js';
import { liveGroupMembersHandler } from '../../src/tools/live-plane.js';
import { resetLiveSession } from '../../src/tools/live-session.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test-org',
  components: { Queue: 1 },
  edges: { hasMember: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const QUEUE_ID = '00G0x00000000Q1AAA';
const PUBLIC_GROUP_ID = '00G0x00000000P1AAA';
const NESTED_GROUP_ID = '00G0x00000000N1AAA';
const NESTED_NESTED_ID = '00G0x00000000N2AAA';
const ROLE_GROUP_ID = '00G0x00000000R1AAA';
const ROLE_ID = '00E0x00000000E1AAA';
const USER_1 = '0050x0000000001AAA';
const USER_2 = '0050x0000000002AAA';
const USER_3 = '0050x0000000003AAA';

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

// Vault: the queue DECLARES 2 members in metadata (live will say 4 → drift).
// The public group is deliberately ABSENT from the vault (null cross-check).
const seed: ExtractionResult = {
  nodes: [
    node({
      id: 'Queue:Test_Queue',
      type: 'Queue',
      apiName: 'Test_Queue',
      properties: { memberCount: 2 },
    }),
  ],
  edges: [],
};

const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });

/** Canned `sf data query` fake covering the full Test_Queue scenario; records
 *  every SOQL it sees so tests can pin query shapes. */
const makeQueueExec = (queries: string[]): ExecCommand => async (_bin, args) => {
  const soql = String(args[args.indexOf('--query') + 1] ?? '');
  queries.push(soql);
  if (soql.includes('FROM Group WHERE (DeveloperName')) {
    if (soql.includes("'Test_Queue'")) {
      return respond({
        result: {
          records: [
            { Id: QUEUE_ID, Name: 'Test Queue', DeveloperName: 'Test_Queue', Type: 'Queue' },
          ],
          totalSize: 1,
        },
      });
    }
    if (soql.includes("'Test_Public_Group'")) {
      return respond({
        result: {
          records: [
            {
              Id: PUBLIC_GROUP_ID,
              Name: 'Test Public Group',
              DeveloperName: 'Test_Public_Group',
              Type: 'Regular',
            },
          ],
          totalSize: 1,
        },
      });
    }
    return respond({ result: { records: [], totalSize: 0 } });
  }
  if (soql.startsWith('SELECT COUNT() FROM GroupMember')) {
    return respond({ result: { records: [], totalSize: 4 } });
  }
  if (soql.includes('FROM GroupMember WHERE GroupId IN')) {
    // One-level expansion page: nested group has 1 user + 1 deeper group.
    return respond({
      result: {
        records: [
          { GroupId: NESTED_GROUP_ID, UserOrGroupId: USER_3 },
          { GroupId: NESTED_GROUP_ID, UserOrGroupId: NESTED_NESTED_ID },
        ],
        totalSize: 2,
      },
    });
  }
  if (soql.includes('FROM GroupMember WHERE GroupId =')) {
    return respond({
      result: {
        records: [
          { Id: '0110x0000000001AAA', UserOrGroupId: USER_1 },
          { Id: '0110x0000000002AAA', UserOrGroupId: USER_2 },
          { Id: '0110x0000000003AAA', UserOrGroupId: NESTED_GROUP_ID },
          { Id: '0110x0000000004AAA', UserOrGroupId: ROLE_GROUP_ID },
        ],
        totalSize: 4,
      },
    });
  }
  if (soql.includes('FROM Group WHERE Id IN')) {
    return respond({
      result: {
        records: [
          {
            Id: NESTED_GROUP_ID,
            Name: 'Nested Test Group',
            DeveloperName: 'Nested_Test_Group',
            Type: 'Regular',
            RelatedId: null,
          },
          {
            Id: ROLE_GROUP_ID,
            Name: 'Role Proxy',
            DeveloperName: 'Role_Proxy',
            Type: 'RoleAndSubordinates',
            RelatedId: ROLE_ID,
          },
        ],
        totalSize: 2,
      },
    });
  }
  if (soql.includes('FROM UserRole')) {
    return respond({
      result: { records: [{ Id: ROLE_ID, Name: 'Test Role' }], totalSize: 1 },
    });
  }
  if (soql.includes('FROM User WHERE Id IN')) {
    const users = [
      { Id: USER_1, Name: 'Jane Doe', Username: 'jane.doe@example.test', IsActive: true },
      { Id: USER_2, Name: 'John Roe', Username: 'john.roe@example.test', IsActive: true },
      { Id: USER_3, Name: 'Ann Poe', Username: 'ann.poe@example.test', IsActive: false },
    ].filter((u) => soql.includes(u.Id));
    return respond({ result: { records: users, totalSize: users.length } });
  }
  if (soql.includes('FROM QueueSobject')) {
    return respond({
      result: {
        records: [{ SobjectType: 'Case' }, { SobjectType: 'Lead' }],
        totalSize: 2,
      },
    });
  }
  return respond({ result: { records: [], totalSize: 0 } });
};

let dir: string;
let store: GraphStore;
let ctx: Context;
let consentDir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-members-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error('openGraph failed');
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error('seed failed');
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetLiveSession();
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-members-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  delete process.env.SFI_LIVE_QUERY_BUDGET;
});
afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  rmSync(consentDir, { recursive: true, force: true });
});

describe('liveGroupMembersHandler — consent gate', () => {
  it('fails closed without consent (no liveEnabled, no env, no standing grant)', async () => {
    const r = await liveGroupMembersHandler(ctx, { name: 'Test_Queue' }, makeQueueExec([]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/live org plane is not enabled/i);
  });
});

describe('liveGroupMembersHandler — polymorphic 005/00G split + role non-expansion (contract pin)', () => {
  it('splits users / nested groups / roles, resolves the UserRole name, and never expands roles', async () => {
    const queries: string[] = [];
    const r = await liveGroupMembersHandler(
      ctx,
      { name: 'Test_Queue', liveEnabled: true },
      makeQueueExec(queries),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.group).toEqual({
      id: QUEUE_ID,
      name: 'Test Queue',
      developerName: 'Test_Queue',
      type: 'Queue',
    });
    expect(d.users.map((u) => u.name)).toEqual(['Jane Doe', 'John Roe']);
    expect(d.nestedGroups).toHaveLength(1);
    expect(d.nestedGroups[0]?.name).toBe('Nested_Test_Group');
    // Default OFF: the nested group is LISTED, not expanded.
    expect(d.nestedGroups[0]?.members).toBeUndefined();
    expect(d.expansion).toBe('none');
    expect(queries.some((q) => q.includes('GroupId IN'))).toBe(false);
    // The Role proxy group surfaces as a ROLE entry by UserRole name…
    expect(d.roles).toHaveLength(1);
    expect(d.roles[0]?.roleName).toBe('Test Role');
    expect(d.roles[0]?.includesSubordinates).toBe(true);
    // …and is never expanded to users (no GroupMember query for its id).
    expect(queries.some((q) => q.includes(ROLE_GROUP_ID) && q.includes('FROM GroupMember'))).toBe(
      false,
    );
    expect(d.totalDirectMembers).toBe(4);
    expect(d.trust.provenance).toBe('live_org');
    expect(d.rendered).toContain('Test Role');
  });

  it('answers "can the queue own X" via QueueSobject supportedObjects', async () => {
    const r = await liveGroupMembersHandler(
      ctx,
      { name: 'Test_Queue', liveEnabled: true },
      makeQueueExec([]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.supportedObjects).toEqual(['Case', 'Lead']);
    expect(r.value.data.rendered).toContain('Can own');
  });
});

describe('liveGroupMembersHandler — vault drift cross-check (contract pin)', () => {
  it('reports vault-declared vs live-direct counts with a drift boolean', async () => {
    const r = await liveGroupMembersHandler(
      ctx,
      { name: 'Test_Queue', liveEnabled: true },
      makeQueueExec([]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // Vault declared 2 members in metadata; live GroupMember says 4.
    expect(d.vaultDeclaredMemberCount).toBe(2);
    expect(d.liveDirectMemberCount).toBe(4);
    expect(d.drift).toBe(true);
    expect(d.rendered).toMatch(/drift: YES/);
  });

  it('a group absent from the vault cross-checks to null (never invented), drift false', async () => {
    const queries: string[] = [];
    const r = await liveGroupMembersHandler(
      ctx,
      { name: 'Test_Public_Group', groupType: 'Regular', liveEnabled: true },
      makeQueueExec(queries),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.group.type).toBe('Regular');
    expect(d.vaultDeclaredMemberCount).toBeNull();
    expect(d.drift).toBe(false);
    // Public groups have no QueueSobject rows to ask for.
    expect(d.supportedObjects).toBeUndefined();
    expect(queries.some((q) => q.includes('FROM QueueSobject'))).toBe(false);
  });
});

describe('liveGroupMembersHandler — fail-closed one-level expansion (contract pin)', () => {
  it("expandNested expands exactly ONE level, stamps 'partial-one-level', and counts the unexpanded remainder", async () => {
    const queries: string[] = [];
    const r = await liveGroupMembersHandler(
      ctx,
      { name: 'Test_Queue', expandNested: true, liveEnabled: true },
      makeQueueExec(queries),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.expansion).toBe('partial-one-level');
    const nested = d.nestedGroups[0];
    expect(nested?.members?.map((u) => u.name)).toEqual(['Ann Poe']);
    // The nested group ALSO contains a deeper group — NOT expanded, counted.
    expect(nested?.unexpandedNestedCount).toBe(1);
    // The deeper group's own membership is never queried (one-level limit)…
    expect(
      queries.some((q) => q.includes(NESTED_NESTED_ID) && q.includes('FROM GroupMember')),
    ).toBe(false);
    // …and the disclosure says a partial expansion is not effective membership.
    expect(d.disclosure).toMatch(/never treat this as the full effective membership/i);
    expect(d.rendered).toMatch(/NOT expanded/);
  });
});

describe('liveGroupMembersHandler — honest resolution (never a guess)', () => {
  it('returns component-not-found naming the probe when nothing matches', async () => {
    const r = await liveGroupMembersHandler(
      ctx,
      { name: 'No_Such_Group', liveEnabled: true },
      makeQueueExec([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain('No_Such_Group');
  });

  it('refuses an ambiguous name shared by a queue and a public group', async () => {
    const exec: ExecCommand = async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      if (soql.includes('FROM Group WHERE (DeveloperName')) {
        return respond({
          result: {
            records: [
              { Id: QUEUE_ID, Name: 'Shared Name', DeveloperName: 'Shared_Q', Type: 'Queue' },
              { Id: PUBLIC_GROUP_ID, Name: 'Shared Name', DeveloperName: 'Shared_G', Type: 'Regular' },
            ],
            totalSize: 2,
          },
        });
      }
      return respond({ result: { records: [], totalSize: 0 } });
    };
    const r = await liveGroupMembersHandler(ctx, { name: 'Shared Name', liveEnabled: true }, exec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/refusing to guess/i);
    expect(r.error.message).toContain('groupType');
  });
});

describe('liveGroupMembersHandler — byte-trim invariance (contract pin)', () => {
  it('trims the user page but NEVER understates totalDirectMembers', async () => {
    const BIG_TOTAL = 9_000;
    const bigExec: ExecCommand = async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      if (soql.includes('FROM Group WHERE (DeveloperName')) {
        return respond({
          result: {
            records: [
              { Id: PUBLIC_GROUP_ID, Name: 'Big Group', DeveloperName: 'Big_Group', Type: 'Regular' },
            ],
            totalSize: 1,
          },
        });
      }
      if (soql.startsWith('SELECT COUNT() FROM GroupMember')) {
        return respond({ result: { records: [], totalSize: BIG_TOTAL } });
      }
      if (soql.includes('FROM GroupMember WHERE GroupId =')) {
        const rows = Array.from({ length: 500 }, (_, i) => ({
          Id: `0110x${String(i).padStart(10, '0')}AAA`,
          UserOrGroupId: `0050x${String(i).padStart(10, '0')}AAA`,
        }));
        return respond({ result: { records: rows, totalSize: rows.length } });
      }
      if (soql.includes('FROM User WHERE Id IN')) {
        const m = soql.match(/'005[^']+'/g) ?? [];
        const rows = m.map((idLit, i) => ({
          Id: idLit.slice(1, -1),
          Name: `Synthetic Member Number ${i} With A Deliberately Long Display Name`,
          Username: `synthetic.member.${i}.with.a.long.address@example.test`,
          IsActive: true,
        }));
        return respond({ result: { records: rows, totalSize: rows.length } });
      }
      return respond({ result: { records: [], totalSize: 0 } });
    };
    const r = await liveGroupMembersHandler(
      ctx,
      { name: 'Big_Group', groupType: 'Regular', limit: 500, liveEnabled: true },
      bigExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.users.length).toBeLessThan(500); // byte budget bit
    expect(d.totalDirectMembers).toBe(BIG_TOTAL); // the invariant
    expect(d.capped).toBe(true);
    expect(d.note).toMatch(/true count/i);
    const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
    expect(bytes).toBeLessThanOrEqual(45_000);
  });
});

describe('liveGroupMembersHandler — budget exhaustion is an honest stop', () => {
  it('surfaces the budget error instead of returning zeros', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    const r = await liveGroupMembersHandler(
      ctx,
      { name: 'Test_Queue', liveEnabled: true },
      makeQueueExec([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/budget/i);
  });
});
