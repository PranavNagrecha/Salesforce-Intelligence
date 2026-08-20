/**
 * The PURE transitive-closure engine over the platform's permission
 * dependency graph.
 *
 * Salesforce's `PermissionDependency` object states, for each user
 * permission, which other permissions it REQUIRES — the platform will not
 * save a profile or permission set that grants the former without the
 * latter. So a container declaring `ManageUsers` really confers
 * `ManageUsers` PLUS everything reachable from it: on a real org that is 14
 * direct requirements (ResetPasswords, ViewAllUsers, FreezeUsers,
 * ManageProfilesPermissionsets, AssignPermissionSets, ManageRoles,
 * ManageIpAddresses, ManageSharing, …) closing to 15 permissions total.
 * Union the DECLARED grants alone and you understate access by 14.
 *
 * This module is the reasoning half of that fix, and it is deliberately
 * ONLY reasoning: no I/O, no graph query, no clock, no knowledge of the
 * vault. It takes a set of directly-granted permission names plus an edge
 * list and returns the effective set with, for every added permission, the
 * PATH that added it — because a claim the caller cannot cite is a claim it
 * must not make.
 *
 * ## Cycle safety
 *
 * The platform's own graph should be acyclic, but "should" is not a
 * guarantee we control: a future release, a beta permission, or a mangled
 * capture could introduce `A → B → A`, and a naive DFS would hang the MCP
 * server. The walk is breadth-first over a global visited set, so every
 * permission is expanded AT MOST ONCE — a cycle terminates by construction
 * rather than by a depth cap that would silently truncate a legitimately
 * deep chain. Cycles that ARE present are reported in
 * {@link PermissionClosureResult.cyclesDetected} rather than swallowed.
 *
 * ## What the closure does NOT mean
 *
 * Dependency is not risk. Verified against a real org, `ModifyAllData` and
 * `ViewAllData` — the two most dangerous permissions in Salesforce — have
 * ZERO dependency edges and therefore expand to NOTHING. An empty closure
 * says "this permission requires nothing else", never "this permission is
 * harmless". Any consumer that ranks by closure size is measuring the
 * wrong thing.
 *
 * ## Two KINDS of permission live in this graph
 *
 * Names are carried VERBATIM, and they are not all user permissions.
 * Measured against a real org, `PermissionType` / `RequiredPermissionType`
 * have a closed TWO-value domain — the literals `'User Permission'` and
 * `'Object Permission'` (note the space) — and the graph is dominated by
 * the object-typed kind: roughly 9 in 10 sampled rows required an
 * OBJECT-level permission, encoded `Name<verb>` (`Account<create>`,
 * `Contract<viewAllRecords>`; observed verbs include `create`, `update`,
 * `read`, `viewAllRecords`).
 *
 * The declared TYPE FIELD is therefore the authoritative discriminator and
 * {@link buildPermissionDependencyGraph} classifies on it. The name-syntax
 * check ({@link isObjectPermissionToken}) is retained as a CONSISTENCY
 * CHECK, not as the primary signal: when the two disagree, or when a THIRD
 * type label ever appears, the graph counts it so the consumer can disclose
 * it. Neither is silently trusted over the other.
 *
 * Partitioning the closure OUTPUT by kind is still the consumer's job —
 * only the consumer knows which surface it is about to present them on —
 * but it no longer has to guess the kind from the string.
 */

/**
 * The platform's label for a user permission, measured verbatim from a
 * real org's `PermissionType` / `RequiredPermissionType` columns. The
 * space is part of the value.
 */
export const USER_PERMISSION_TYPE = 'User Permission';

/** The platform's label for an object-level permission. The space is part of the value. */
export const OBJECT_PERMISSION_TYPE = 'Object Permission';

/**
 * What KIND of thing a permission name refers to.
 *
 * `unknown` is a real, reportable state — a capture that predates the type
 * columns, or a THIRD label the platform introduces later. It is never
 * quietly folded into `user`, because presenting an unclassified name among
 * user permissions is the exact misstatement this distinction exists to
 * prevent.
 */
export type PermissionKind = 'user' | 'object' | 'unknown';

/**
 * True when a permission NAME uses Salesforce's object-level
 * angle-bracket encoding (`Account<create>`,
 * `Contract<viewAllRecords>`) rather than being a bare user permission
 * (`ManageUsers`).
 *
 * This is the CONSISTENCY CHECK, not the primary discriminator: the
 * platform's `PermissionType` column is authoritative and has a closed
 * two-value domain (see {@link classifyPermissionKind}). The syntactic
 * check exists so a disagreement between the declared type and the name
 * shape can be COUNTED and disclosed rather than silently resolved.
 *
 * @example
 *   isObjectPermissionToken('Account<create>'); // true
 *   isObjectPermissionToken('ManageUsers');     // false
 */
export const isObjectPermissionToken = (name: string): boolean =>
  name.endsWith('>') && name.includes('<');

/**
 * Split an object-level token into its object and flag halves, or `null`
 * when the name is not object-encoded. The flag keeps the platform's own
 * spelling (`create`, `viewAllRecords`) and is NOT mapped onto the vault's
 * `allowCreate` / `viewAllRecords` flag vocabulary here — that mapping is
 * a modelling decision the consuming surface owns.
 *
 * @example
 *   parseObjectPermissionToken('Contract<viewAllRecords>');
 *   // => { object: 'Contract', flag: 'viewAllRecords' }
 */
export const parseObjectPermissionToken = (
  name: string,
): { readonly object: string; readonly flag: string } | null => {
  if (!isObjectPermissionToken(name)) return null;
  const open = name.indexOf('<');
  const object = name.slice(0, open);
  const flag = name.slice(open + 1, name.length - 1);
  if (object.length === 0 || flag.length === 0) return null;
  return { object, flag };
};

/**
 * Classify one permission by the platform's DECLARED type label, using the
 * name syntax only as a cross-check.
 *
 * Precedence is deliberate and not symmetric:
 *   - A known label (`'User Permission'` / `'Object Permission'`) WINS. It
 *     is the platform's own statement about its own data.
 *   - An absent or unrecognised label falls back to the name syntax, and
 *     reports `unknownLabel` so the caller can disclose that it guessed.
 *   - When a known label DISAGREES with the name syntax (a
 *     `'User Permission'` called `Account<create>`, say), the label still
 *     wins but `disagrees` is set — the caller counts it and discloses. We
 *     never silently pick a side on contradictory platform data.
 *
 * @example
 *   classifyPermissionKind('Account<create>', 'Object Permission');
 *   // => { kind: 'object', disagrees: false, unknownLabel: null }
 *   classifyPermissionKind('ManageUsers', '');
 *   // => { kind: 'user', disagrees: false, unknownLabel: '' }  (syntax fallback)
 */
export const classifyPermissionKind = (
  name: string,
  declaredType?: string,
): {
  readonly kind: PermissionKind;
  readonly disagrees: boolean;
  readonly unknownLabel: string | null;
} => {
  const syntaxKind: PermissionKind = isObjectPermissionToken(name) ? 'object' : 'user';
  if (declaredType === USER_PERMISSION_TYPE) {
    return { kind: 'user', disagrees: syntaxKind !== 'user', unknownLabel: null };
  }
  if (declaredType === OBJECT_PERMISSION_TYPE) {
    return { kind: 'object', disagrees: syntaxKind !== 'object', unknownLabel: null };
  }
  // No label, or a THIRD value the platform introduced after this was
  // written. Fall back to the syntax but SAY SO — an unrecognised label is
  // a disclosure, never a silent default.
  return { kind: syntaxKind, disagrees: false, unknownLabel: declaredType ?? '' };
};

/** One directed edge: `permission` requires `requiredPermission`. */
export interface PermissionDependencyEdgeInput {
  readonly permission: string;
  readonly requiredPermission: string;
  /**
   * The platform's declared type for `permission` — `'User Permission'` or
   * `'Object Permission'`. Optional: a capture taken before the columns
   * were recorded has none, and the graph then falls back to name syntax
   * and reports the fallback.
   */
  readonly permissionType?: string;
  /** The platform's declared type for `requiredPermission`. */
  readonly requiredPermissionType?: string;
}

/**
 * The adjacency index the closure walks. Built once per request by
 * {@link buildPermissionDependencyGraph} and reusable across many
 * expansions.
 */
export interface PermissionDependencyGraph {
  /** permission -> the permissions it DIRECTLY requires, sorted, deduped. */
  readonly requires: ReadonlyMap<string, readonly string[]>;
  /**
   * The REVERSE index: permission -> the permissions that directly require
   * IT, sorted, deduped.
   *
   * Kept because the two directions answer different questions and the
   * safety-relevant one is usually the reverse. "What does `ViewAllData`
   * require?" is a statement about its prerequisites; "what would CONFER
   * `ViewAllData`?" is a statement about how a user might end up holding
   * it. A surface that reports only the forward direction, and phrases it
   * as "has no dependencies", leaves the second question unanswered while
   * sounding like it answered both.
   */
  readonly requiredBy: ReadonlyMap<string, readonly string[]>;
  /** Distinct edges the graph holds (after dedupe / self-loop drops). */
  readonly edgeCount: number;
  /**
   * TRUE when the capture this graph was built from was incomplete (server
   * row ceiling, page budget, mid-walk stop). Propagated verbatim onto
   * every {@link PermissionClosureResult.partial} so a partial input can
   * never produce an answer that reads as complete.
   */
  readonly truncated: boolean;
  /** Self-referential edges (`A` requires `A`) dropped at build time. */
  readonly selfLoopsDropped: number;
  /**
   * permission name -> the KIND the platform declared for it. Built from
   * the type columns, cross-checked against the name syntax. Consumers
   * partition closure output with THIS rather than re-parsing names.
   */
  readonly kindOf: ReadonlyMap<string, PermissionKind>;
  /**
   * How many distinct edges REQUIRE each kind of permission. On a real org
   * the object-typed share dominates (~9 in 10 sampled rows), which is why
   * a consumer that reports object requirements separately must disclose
   * the PROPORTION, not merely their existence.
   */
  readonly requiredKindCounts: {
    readonly user: number;
    readonly object: number;
    readonly unknown: number;
  };
  /**
   * Permission names whose DECLARED type contradicted their name syntax.
   * Expected empty; non-empty means the platform disagrees with itself and
   * the consumer should disclose rather than quietly trust one signal.
   */
  readonly typeDisagreements: readonly string[];
  /**
   * Distinct UNRECOGNISED type labels seen (anything that is neither
   * `'User Permission'` nor `'Object Permission'`, including the empty
   * string for a capture with no type columns). Sorted. Non-empty means
   * classification fell back to name syntax for those rows.
   */
  readonly unknownTypeLabels: readonly string[];
}

/** One permission the closure ADDED — never one that was directly granted. */
export interface ImpliedPermission {
  /** The permission the closure added. */
  readonly permission: string;
  /**
   * The DIRECTLY-granted permission whose dependency chain reaches it. On
   * a tie (two grants reach it at the same hop count) the
   * lexicographically smaller root wins, so the output is deterministic.
   */
  readonly rootPermission: string;
  /**
   * The full chain `rootPermission → … → permission`, inclusive of both
   * ends, so the addition is citable. Shortest such path (the walk is
   * breadth-first).
   */
  readonly path: readonly string[];
  /** Hops from the root; 1 means "directly required by the root". */
  readonly depth: number;
}

/** Output of {@link expandPermissionClosure}. */
export interface PermissionClosureResult {
  /**
   * The directly-granted names, sorted. Echoed so a consumer can diff
   * declared-vs-effective without keeping the input around.
   */
  readonly granted: readonly string[];
  /**
   * Permissions the closure ADDED, sorted by name. Disjoint from
   * {@link granted} by construction: a directly-granted permission the
   * closure happens to reach is NOT re-reported as implied, because
   * presenting it as implied would misattribute a real grant.
   */
  readonly implied: readonly ImpliedPermission[];
  /** `granted` ∪ `implied`, sorted — the effective permission set. */
  readonly effective: readonly string[];
  /**
   * Cycles encountered during the walk, each as the repeating segment with
   * the entry node repeated at both ends (`['A','B','A']`). Deduped and
   * sorted. Non-empty means the captured graph is not a DAG — surfaced
   * rather than swallowed, because a cycle in the platform's own data is a
   * fact the operator should hear about.
   */
  readonly cyclesDetected: readonly (readonly string[])[];
  /**
   * TRUE when the graph this closure ran over was a truncated capture. The
   * effective set is then a LOWER BOUND: more permissions may be implied
   * that the capture never saw. Consumers MUST disclose this.
   */
  readonly partial: boolean;
}

/**
 * Build the adjacency index.
 *
 * Duplicate edges collapse; self-loops (`A` requires `A`) are dropped and
 * counted — they add nothing to a closure and would otherwise register as
 * a one-node "cycle" on every expansion. Neighbour lists are sorted so the
 * breadth-first walk and therefore the whole result are deterministic.
 *
 * @example
 *   const graph = buildPermissionDependencyGraph(
 *     [{ permission: 'EmailMass', requiredPermission: 'EmailSingle' }],
 *     { truncated: false },
 *   );
 */
export const buildPermissionDependencyGraph = (
  edges: readonly PermissionDependencyEdgeInput[],
  options?: { readonly truncated?: boolean },
): PermissionDependencyGraph => {
  const sets = new Map<string, Set<string>>();
  const kindOf = new Map<string, PermissionKind>();
  const disagreements = new Set<string>();
  const unknownLabels = new Set<string>();
  const requiredKindCounts = { user: 0, object: 0, unknown: 0 };
  let edgeCount = 0;
  let selfLoopsDropped = 0;

  // Classify a name once and remember it. A name appears on many edges; the
  // FIRST classification wins so the map is order-stable, and any later
  // contradiction is already captured by `disagreements`.
  const noteKind = (name: string, declaredType: string | undefined): PermissionKind => {
    const existing = kindOf.get(name);
    const classified = classifyPermissionKind(name, declaredType);
    if (classified.disagrees) disagreements.add(name);
    if (classified.unknownLabel !== null) unknownLabels.add(classified.unknownLabel);
    if (existing !== undefined) return existing;
    kindOf.set(name, classified.kind);
    return classified.kind;
  };

  for (const edge of edges) {
    const from = edge?.permission;
    const to = edge?.requiredPermission;
    if (typeof from !== 'string' || from.length === 0) continue;
    if (typeof to !== 'string' || to.length === 0) continue;
    noteKind(from, edge.permissionType);
    const toKind = noteKind(to, edge.requiredPermissionType);
    if (from === to) {
      selfLoopsDropped += 1;
      continue;
    }
    let bucket = sets.get(from);
    if (bucket === undefined) {
      bucket = new Set<string>();
      sets.set(from, bucket);
    }
    if (bucket.has(to)) continue;
    bucket.add(to);
    edgeCount += 1;
    requiredKindCounts[toKind] += 1;
  }

  const requires = new Map<string, readonly string[]>();
  for (const [from, bucket] of sets) {
    requires.set(from, [...bucket].sort());
  }
  const reverseSets = new Map<string, Set<string>>();
  for (const [from, bucket] of sets) {
    for (const to of bucket) {
      let rev = reverseSets.get(to);
      if (rev === undefined) {
        rev = new Set<string>();
        reverseSets.set(to, rev);
      }
      rev.add(from);
    }
  }
  const requiredBy = new Map<string, readonly string[]>();
  for (const [to, bucket] of reverseSets) {
    requiredBy.set(to, [...bucket].sort());
  }
  return {
    requires,
    requiredBy,
    edgeCount,
    truncated: options?.truncated === true,
    selfLoopsDropped,
    kindOf,
    requiredKindCounts,
    typeDisagreements: [...disagreements].sort(),
    unknownTypeLabels: [...unknownLabels].sort(),
  };
};

/**
 * Expand a set of directly-granted permissions through the dependency
 * graph.
 *
 * Multi-source breadth-first: every directly-granted name starts at depth
 * 0 already visited, so the first time the frontier reaches a new
 * permission it does so by a SHORTEST path, and that path is what gets
 * cited. Roots are seeded in sorted order and neighbours are already
 * sorted, so ties resolve to the lexicographically smaller root and the
 * result is fully deterministic.
 *
 * Terminates on ANY input, cyclic or not: the visited set bounds the walk
 * to the number of distinct permissions in the graph.
 *
 * @example
 *   const r = expandPermissionClosure(['ManageUsers'], graph);
 *   r.effective.length;              // 15 on a real org
 *   r.implied[0]?.path;              // ['ManageUsers', 'ResetPasswords']
 *   expandPermissionClosure(['ModifyAllData'], graph).implied; // [] — zero deps
 */
export const expandPermissionClosure = (
  directlyGranted: Iterable<string>,
  graph: PermissionDependencyGraph,
): PermissionClosureResult => {
  const granted: string[] = [];
  const grantedSet = new Set<string>();
  for (const name of directlyGranted) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (grantedSet.has(name)) continue;
    grantedSet.add(name);
    granted.push(name);
  }
  granted.sort();

  // `visited` holds both the roots and everything already reached, so a
  // permission is expanded at most once — this is what makes the walk
  // cycle-safe without a depth cap.
  const visited = new Set<string>(grantedSet);
  const implied = new Map<string, ImpliedPermission>();
  const cycleKeys = new Set<string>();
  const cyclesDetected: (readonly string[])[] = [];

  interface Frontier {
    readonly permission: string;
    readonly rootPermission: string;
    /** Path root → … → permission, inclusive. Doubles as the cycle probe. */
    readonly path: readonly string[];
  }

  let frontier: Frontier[] = granted.map((permission) => ({
    permission,
    rootPermission: permission,
    path: [permission],
  }));

  while (frontier.length > 0) {
    const next: Frontier[] = [];
    for (const current of frontier) {
      const neighbours = graph.requires.get(current.permission);
      if (neighbours === undefined) continue;
      for (const neighbour of neighbours) {
        if (visited.has(neighbour)) {
          // Already accounted for. If it is on the path we walked to get
          // here, the graph contains a cycle — record the repeating
          // segment once, then move on (never re-expand).
          const at = current.path.indexOf(neighbour);
          if (at >= 0) {
            const cycle = [...current.path.slice(at), neighbour];
            const key = cycle.join('\x00');
            if (!cycleKeys.has(key)) {
              cycleKeys.add(key);
              cyclesDetected.push(Object.freeze(cycle));
            }
          }
          continue;
        }
        visited.add(neighbour);
        const path = [...current.path, neighbour];
        implied.set(neighbour, {
          permission: neighbour,
          rootPermission: current.rootPermission,
          path: Object.freeze(path),
          depth: path.length - 1,
        });
        next.push({
          permission: neighbour,
          rootPermission: current.rootPermission,
          path,
        });
      }
    }
    frontier = next;
  }

  const impliedList = [...implied.values()].sort((a, b) =>
    a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0,
  );
  const effective = [...granted, ...impliedList.map((i) => i.permission)].sort();
  cyclesDetected.sort((a, b) => {
    const ja = a.join('\x00');
    const jb = b.join('\x00');
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });

  return {
    granted,
    implied: impliedList,
    effective,
    cyclesDetected,
    partial: graph.truncated,
  };
};
