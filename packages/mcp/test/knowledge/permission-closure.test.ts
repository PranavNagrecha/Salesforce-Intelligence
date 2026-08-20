/// <reference types="vitest/globals" />

/**
 * Unit tests for the pure permission-dependency closure.
 *
 * Proves the four things the engine is load-bearing for:
 *   1. Closure CORRECTNESS — transitive chains, shortest citable paths,
 *      and the `ManageUsers` → 15 shape observed on a real org.
 *   2. CYCLE SAFETY — a cyclic graph terminates and reports the cycle
 *      rather than hanging or silently swallowing it.
 *   3. `ModifyAllData` / `ViewAllData` expand to NOTHING — dependency is
 *      not risk, and the engine must not invent edges for the two most
 *      dangerous permissions in Salesforce.
 *   4. A closure-added permission is never confused with a granted one.
 *
 * Fully hermetic: the engine has no I/O, so the graph is handed in.
 */

import {
  buildPermissionDependencyGraph,
  classifyPermissionKind,
  expandPermissionClosure,
  isObjectPermissionToken,
  OBJECT_PERMISSION_TYPE,
  parseObjectPermissionToken,
  USER_PERMISSION_TYPE,
  type PermissionDependencyEdgeInput,
} from '../../src/knowledge/permission-closure.js';

const e = (
  permission: string,
  requiredPermission: string,
): PermissionDependencyEdgeInput => ({ permission, requiredPermission });

/**
 * The real-org `ManageUsers` shape: 14 DIRECT requirements, closing to 15
 * permissions total (the root plus its 14). Names are Salesforce's own
 * documented user-permission names — nothing org-identifying.
 */
const MANAGE_USERS_REQUIREMENTS = [
  'ResetPasswords',
  'ViewAllUsers',
  'FreezeUsers',
  'ManageProfilesPermissionsets',
  'AssignPermissionSets',
  'ManageRoles',
  'ManageIpAddresses',
  'ManageSharing',
  'ManageInternalUsers',
  'ManagePasswordPolicies',
  'ManageLoginAccessPolicies',
  'ViewSetup',
  'ManageUnlistedGroups',
  'ManageCustomPermissions',
] as const;

const manageUsersGraph = () =>
  buildPermissionDependencyGraph(
    MANAGE_USERS_REQUIREMENTS.map((required) => e('ManageUsers', required)),
  );

describe('buildPermissionDependencyGraph', () => {
  it('dedupes repeated edges and sorts neighbours for determinism', () => {
    const graph = buildPermissionDependencyGraph([
      e('A', 'C'),
      e('A', 'B'),
      e('A', 'B'),
    ]);
    expect(graph.edgeCount).toBe(2);
    expect(graph.requires.get('A')).toEqual(['B', 'C']);
  });

  it('drops (and counts) self-loops so they never register as a cycle', () => {
    const graph = buildPermissionDependencyGraph([e('A', 'A'), e('A', 'B')]);
    expect(graph.selfLoopsDropped).toBe(1);
    expect(graph.edgeCount).toBe(1);
    const r = expandPermissionClosure(['A'], graph);
    expect(r.cyclesDetected).toEqual([]);
    expect(r.effective).toEqual(['A', 'B']);
  });

  it('ignores rows missing either endpoint', () => {
    const graph = buildPermissionDependencyGraph([
      e('', 'B'),
      e('A', ''),
      e('A', 'B'),
    ]);
    expect(graph.edgeCount).toBe(1);
  });

  it('carries the truncation flag through to every closure it produces', () => {
    const graph = buildPermissionDependencyGraph([e('A', 'B')], { truncated: true });
    expect(graph.truncated).toBe(true);
    expect(expandPermissionClosure(['A'], graph).partial).toBe(true);
  });
});

describe('expandPermissionClosure — correctness', () => {
  it('expands ManageUsers to the 15-permission effective set observed on a real org', () => {
    const r = expandPermissionClosure(['ManageUsers'], manageUsersGraph());
    expect(r.granted).toEqual(['ManageUsers']);
    expect(r.implied).toHaveLength(14);
    expect(r.effective).toHaveLength(15);
    expect(r.effective).toContain('ManageUsers');
    for (const required of MANAGE_USERS_REQUIREMENTS) {
      expect(r.effective).toContain(required);
    }
    // Every added permission cites the chain that added it, at depth 1.
    for (const imp of r.implied) {
      expect(imp.rootPermission).toBe('ManageUsers');
      expect(imp.depth).toBe(1);
      expect(imp.path).toEqual(['ManageUsers', imp.permission]);
    }
  });

  it('follows a TRANSITIVE chain and cites the full path', () => {
    // Real shape: EmailMass -> EmailSingle -> EditTask.
    const graph = buildPermissionDependencyGraph([
      e('EmailMass', 'EmailSingle'),
      e('EmailSingle', 'EditTask'),
    ]);
    const r = expandPermissionClosure(['EmailMass'], graph);
    expect(r.effective).toEqual(['EditTask', 'EmailMass', 'EmailSingle']);
    const editTask = r.implied.find((i) => i.permission === 'EditTask');
    expect(editTask?.depth).toBe(2);
    expect(editTask?.path).toEqual(['EmailMass', 'EmailSingle', 'EditTask']);
    expect(editTask?.rootPermission).toBe('EmailMass');
  });

  it('never re-reports a DIRECTLY granted permission as implied', () => {
    const graph = buildPermissionDependencyGraph([
      e('EmailMass', 'EmailSingle'),
      e('EmailSingle', 'EditTask'),
    ]);
    // EmailSingle is granted outright as well as required by EmailMass.
    const r = expandPermissionClosure(['EmailMass', 'EmailSingle'], graph);
    expect(r.granted).toEqual(['EmailMass', 'EmailSingle']);
    expect(r.implied.map((i) => i.permission)).toEqual(['EditTask']);
    expect(r.effective).toEqual(['EditTask', 'EmailMass', 'EmailSingle']);
  });

  it('is deterministic across grant ORDER and dedupes repeated grants', () => {
    const graph = buildPermissionDependencyGraph([
      e('ExportReport', 'RunReports'),
      e('EmailMass', 'EmailSingle'),
    ]);
    const a = expandPermissionClosure(['ExportReport', 'EmailMass'], graph);
    const b = expandPermissionClosure(['EmailMass', 'ExportReport', 'EmailMass'], graph);
    expect(a).toEqual(b);
    expect(b.granted).toEqual(['EmailMass', 'ExportReport']);
  });

  it('attributes a shared requirement to the SHALLOWEST root, ties broken lexically', () => {
    // Zulu reaches Shared in one hop; Alpha needs two — the 1-hop root wins.
    const graph = buildPermissionDependencyGraph([
      e('Alpha', 'Middle'),
      e('Middle', 'Shared'),
      e('Zulu', 'Shared'),
    ]);
    const r = expandPermissionClosure(['Alpha', 'Zulu'], graph);
    const shared = r.implied.find((i) => i.permission === 'Shared');
    expect(shared?.rootPermission).toBe('Zulu');
    expect(shared?.depth).toBe(1);
  });

  it('returns an empty closure for an empty grant set', () => {
    const r = expandPermissionClosure([], manageUsersGraph());
    expect(r.granted).toEqual([]);
    expect(r.implied).toEqual([]);
    expect(r.effective).toEqual([]);
    expect(r.partial).toBe(false);
  });
});

describe('expandPermissionClosure — dependency is NOT risk', () => {
  // Verified against a real org: the two most dangerous permissions in
  // Salesforce carry ZERO dependency edges. An empty closure must never be
  // read as "harmless", and the engine must not invent edges to fill it.
  it('expands ModifyAllData and ViewAllData to NOTHING', () => {
    const graph = buildPermissionDependencyGraph([
      ...MANAGE_USERS_REQUIREMENTS.map((required) => e('ManageUsers', required)),
    ]);
    const r = expandPermissionClosure(['ModifyAllData', 'ViewAllData'], graph);
    expect(r.implied).toEqual([]);
    expect(r.effective).toEqual(['ModifyAllData', 'ViewAllData']);
  });
});

describe('expandPermissionClosure — cycle safety', () => {
  it('terminates on a two-node cycle and reports it', () => {
    const graph = buildPermissionDependencyGraph([e('A', 'B'), e('B', 'A')]);
    const r = expandPermissionClosure(['A'], graph);
    expect(r.effective).toEqual(['A', 'B']);
    expect(r.implied.map((i) => i.permission)).toEqual(['B']);
    expect(r.cyclesDetected).toEqual([['A', 'B', 'A']]);
  });

  it('terminates on a longer cycle reached from outside it', () => {
    const graph = buildPermissionDependencyGraph([
      e('Root', 'A'),
      e('A', 'B'),
      e('B', 'C'),
      e('C', 'A'),
    ]);
    const r = expandPermissionClosure(['Root'], graph);
    expect(r.effective).toEqual(['A', 'B', 'C', 'Root']);
    expect(r.cyclesDetected).toEqual([['A', 'B', 'C', 'A']]);
    // Each permission is expanded exactly once — depths are the shortest paths.
    expect(r.implied.map((i) => `${i.permission}@${i.depth}`)).toEqual([
      'A@1',
      'B@2',
      'C@3',
    ]);
  });

  it('terminates on a fully connected clique (every node requires every other)', () => {
    const names = ['P1', 'P2', 'P3', 'P4', 'P5'];
    const edges: PermissionDependencyEdgeInput[] = [];
    for (const from of names) for (const to of names) if (from !== to) edges.push(e(from, to));
    const graph = buildPermissionDependencyGraph(edges);
    const r = expandPermissionClosure(['P1'], graph);
    expect(r.effective).toEqual(names);
    expect(r.cyclesDetected.length).toBeGreaterThan(0);
  });
});

describe('reverse index (the safety-relevant direction)', () => {
  // "What does X require?" and "what would CONFER X?" are different questions.
  // A surface reporting only the forward direction, phrased as "has no
  // dependencies", leaves the second unanswered while sounding complete.
  it('indexes both directions independently', () => {
    const graph = buildPermissionDependencyGraph([
      e('EmailMass', 'EmailSingle'),
      e('ExportReport', 'RunReports'),
      e('ScheduleReports', 'RunReports'),
    ]);
    expect(graph.requires.get('EmailMass')).toEqual(['EmailSingle']);
    expect(graph.requiredBy.get('EmailSingle')).toEqual(['EmailMass']);
    // Two different permissions both require RunReports.
    expect(graph.requiredBy.get('RunReports')).toEqual(['ExportReport', 'ScheduleReports']);
    // A leaf requires nothing; a root is required by nothing.
    expect(graph.requires.get('RunReports')).toBeUndefined();
    expect(graph.requiredBy.get('EmailMass')).toBeUndefined();
  });

  it('distinguishes "requires nothing" from "nothing confers it"', () => {
    // ModifyAllData with zero edges in EITHER direction, versus a permission
    // that requires nothing but IS conferred by something else.
    const graph = buildPermissionDependencyGraph([e('SomeAdminPerm', 'ViewAllData')]);
    expect(graph.requires.get('ModifyAllData')).toBeUndefined();
    expect(graph.requiredBy.get('ModifyAllData')).toBeUndefined();
    expect(graph.requires.get('ViewAllData')).toBeUndefined();
    expect(graph.requiredBy.get('ViewAllData')).toEqual(['SomeAdminPerm']);
  });
});

describe('permission KIND classification (declared type is authoritative)', () => {
  it('recognises the platform angle-bracket encoding as a consistency check', () => {
    expect(isObjectPermissionToken('Account<create>')).toBe(true);
    expect(isObjectPermissionToken('Contract<viewAllRecords>')).toBe(true);
    expect(isObjectPermissionToken('ManageUsers')).toBe(false);
    expect(isObjectPermissionToken('EmailSingle')).toBe(false);
  });

  it('splits a token into object + platform-spelled verb', () => {
    expect(parseObjectPermissionToken('Contract<viewAllRecords>')).toEqual({
      object: 'Contract',
      flag: 'viewAllRecords',
    });
    expect(parseObjectPermissionToken('ManageUsers')).toBeNull();
    expect(parseObjectPermissionToken('<create>')).toBeNull();
    expect(parseObjectPermissionToken('Account<>')).toBeNull();
  });

  it('classifies on the DECLARED type label, which is the authoritative signal', () => {
    expect(classifyPermissionKind('Account<create>', OBJECT_PERMISSION_TYPE)).toEqual({
      kind: 'object',
      disagrees: false,
      unknownLabel: null,
    });
    expect(classifyPermissionKind('ManageUsers', USER_PERMISSION_TYPE)).toEqual({
      kind: 'user',
      disagrees: false,
      unknownLabel: null,
    });
  });

  it('lets the declared label WIN over the name shape but FLAGS the disagreement', () => {
    const r = classifyPermissionKind('Account<create>', USER_PERMISSION_TYPE);
    expect(r.kind).toBe('user');
    expect(r.disagrees).toBe(true);
  });

  it('falls back to name shape for an absent or THIRD label, and says it guessed', () => {
    const absent = classifyPermissionKind('ManageUsers', undefined);
    expect(absent.kind).toBe('user');
    expect(absent.unknownLabel).toBe('');
    const third = classifyPermissionKind('Account<create>', 'Field Permission');
    expect(third.kind).toBe('object');
    expect(third.unknownLabel).toBe('Field Permission');
  });

  it('exposes the measured literal values, space included', () => {
    expect(USER_PERMISSION_TYPE).toBe('User Permission');
    expect(OBJECT_PERMISSION_TYPE).toBe('Object Permission');
  });
});

describe('graph-level kind accounting', () => {
  // Real observed rows. `ImportPersonal` is a USER permission whose actual
  // requirements are OBJECT-level — the motivating case for reporting the
  // object share honestly rather than as a footnote.
  const realRows: PermissionDependencyEdgeInput[] = [
    {
      permission: 'ImportPersonal',
      permissionType: USER_PERMISSION_TYPE,
      requiredPermission: 'Contact<create>',
      requiredPermissionType: OBJECT_PERMISSION_TYPE,
    },
    {
      permission: 'ImportPersonal',
      permissionType: USER_PERMISSION_TYPE,
      requiredPermission: 'Contact<update>',
      requiredPermissionType: OBJECT_PERMISSION_TYPE,
    },
    {
      permission: 'ImportPersonal',
      permissionType: USER_PERMISSION_TYPE,
      requiredPermission: 'Account<create>',
      requiredPermissionType: OBJECT_PERMISSION_TYPE,
    },
    {
      permission: 'ImportPersonal',
      permissionType: USER_PERMISSION_TYPE,
      requiredPermission: 'Account<update>',
      requiredPermissionType: OBJECT_PERMISSION_TYPE,
    },
    {
      permission: 'EmailMass',
      permissionType: USER_PERMISSION_TYPE,
      requiredPermission: 'EmailSingle',
      requiredPermissionType: USER_PERMISSION_TYPE,
    },
  ];

  it('counts required edges by KIND so a consumer can disclose the proportion', () => {
    const graph = buildPermissionDependencyGraph(realRows);
    expect(graph.requiredKindCounts).toEqual({ user: 1, object: 4, unknown: 0 });
    expect(graph.edgeCount).toBe(5);
  });

  it('maps every name to its declared kind', () => {
    const graph = buildPermissionDependencyGraph(realRows);
    expect(graph.kindOf.get('ImportPersonal')).toBe('user');
    expect(graph.kindOf.get('Account<create>')).toBe('object');
    expect(graph.kindOf.get('EmailSingle')).toBe('user');
  });

  it('reports type/name disagreements instead of silently picking a side', () => {
    const graph = buildPermissionDependencyGraph([
      {
        permission: 'Weird<create>',
        permissionType: USER_PERMISSION_TYPE,
        requiredPermission: 'AlsoWeird',
        requiredPermissionType: OBJECT_PERMISSION_TYPE,
      },
    ]);
    expect(graph.typeDisagreements).toEqual(['AlsoWeird', 'Weird<create>']);
  });

  it('reports UNRECOGNISED type labels rather than defaulting silently', () => {
    const graph = buildPermissionDependencyGraph([
      {
        permission: 'ManageUsers',
        permissionType: 'Field Permission',
        requiredPermission: 'ResetPasswords',
        requiredPermissionType: USER_PERMISSION_TYPE,
      },
    ]);
    expect(graph.unknownTypeLabels).toEqual(['Field Permission']);
    // Fallback still classifies by shape, so the graph stays usable.
    expect(graph.kindOf.get('ManageUsers')).toBe('user');
  });

  it('treats a capture with NO type columns as unknown-labelled, not as user-typed truth', () => {
    const graph = buildPermissionDependencyGraph([
      { permission: 'EmailMass', requiredPermission: 'EmailSingle' },
    ]);
    expect(graph.unknownTypeLabels).toEqual(['']);
    expect(graph.kindOf.get('EmailSingle')).toBe('user');
  });

  it('expands the real ImportPersonal chain to its OBJECT-level requirements', () => {
    const graph = buildPermissionDependencyGraph(realRows);
    const r = expandPermissionClosure(['ImportPersonal'], graph);
    expect(r.implied.map((i) => i.permission)).toEqual([
      'Account<create>',
      'Account<update>',
      'Contact<create>',
      'Contact<update>',
    ]);
    // Every one is object-kinded, so a consumer must not show them as
    // system permissions.
    for (const imp of r.implied) {
      expect(graph.kindOf.get(imp.permission)).toBe('object');
    }
  });
});
