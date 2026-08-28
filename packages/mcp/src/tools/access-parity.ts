/**
 * Grant-completeness ("ships for nobody") resolver for `sfi.review_change`.
 *
 * The additive access-parity check `review_change` folds in when
 * `checkAccessParity` is set: for each ADDED / MODIFIED CustomField or
 * CustomObject in the changeset, resolve whether ANY grant gives a user access
 * to it, and flag the ones that resolve to ZERO grants as "ships for nobody" —
 * a feature that would deploy invisible because no permission set / profile
 * grants it. This is the gap the DEFAULT `review_change` deliberately excludes
 * (its dependent scan omits `grantedBy`, because a Profile / PermissionSet FLS
 * grant is ACCESS, not a breakage dependency).
 *
 * ## What "granted" means (reusing the field/object access model)
 *
 * A component is considered GRANTED — and therefore NOT flagged — when any of:
 *
 *   1. an inbound `grantedBy` edge from a Profile / PermissionSet confers access
 *      (the FLS `readable` / `editable` flags for a field, the CRUD
 *      `allowRead` / `allowCreate` / `allowEdit` / `allowDelete` /
 *      `viewAllRecords` / `modifyAllRecords` flags for an object — the exact
 *      flags `field_access_audit` / `object_access_audit` read). A grant added
 *      IN the changeset counts too: if its granting Profile / PermissionSet was
 *      refreshed into the vault, its edge is here; a brand-new permission set in
 *      the same changeset whose body was NOT yet extracted is disclosed as a
 *      boundary, not silently assumed absent.
 *   2. a system permission — ViewAllData (read) or ModifyAllData (read + edit) —
 *      held by any Profile / PermissionSet in the vault confers blanket access.
 *      This is the PRECISION guard: an org whose admin holds ModifyAllData does
 *      not ship a field "for nobody", so it must NOT be false-flagged.
 *   3. the component is a STANDARD (non-`__c`) field / object, which carries
 *      default access — again a precision guard against false positives.
 *
 * Only a CUSTOM field / object with ZERO explicit grants AND no system-perm
 * holder is flagged, and even then it is a CANDIDATE ("no modeled grant found —
 * verify"), never a proven "nobody can see this": the grant graph is the MODELED
 * one of the last refresh.
 *
 * ## Honesty axes
 *
 *   - Freshness: every verdict is stamped with the vault's last-refresh time
 *     (`stamp`). A STALE grant graph must not mint a false "invisible" alarm.
 *   - "Ships for EVERYBODY" is OUT OF SCOPE offline: how many users actually
 *     hold a granting permission set / profile is per-user LIVE assignment data
 *     the vault cannot answer, deferred to `sfi.live_permset_holders`. Only the
 *     "ships for nobody" (zero-grant) direction is resolved here.
 *   - Confidence is `declared` — grants are declared Profile / PermissionSet
 *     metadata.
 *   - This is changeset grant COMPLETENESS (did the release ship the
 *     permissions), NOT `sfi.crud_fls_audit` (whether Apex enforces CRUD/FLS).
 */

import type {
  ComponentId,
  ConfidenceLevel,
  McpError,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByIds } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import type { ChangeKind } from './review-change.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

/** Types the parity check applies to — a field's FLS / an object's CRUD grants. */
const PARITY_TYPES: ReadonlySet<string> = new Set(['CustomField', 'CustomObject']);

/** The grantor node types whose `grantedBy` edge carries an access grant. */
const GRANTOR_TYPES: ReadonlySet<string> = new Set(['Profile', 'PermissionSet']);

/**
 * The node types walked by the org-wide system-perm scan, in scan order.
 *
 * The scan is EXHAUSTIVE (`scanAllNodesOfTypes`), not a single capped page: the
 * precision guard it feeds ("no Profile / PermissionSet holds ViewAllData /
 * ModifyAllData") is a claim about the WHOLE org, and a single
 * `listNodesByType` page is served as `ORDER BY id ASC LIMIT 500 OFFSET 0` — so
 * in an org with more than 500 grantors the alphabetical tail was never read
 * and a sole ModifyAllData holder past node 500 minted a false "ships for
 * nobody" alarm.
 */
const GRANTOR_SCAN_TYPES = ['Profile', 'PermissionSet'] as const;

/** One added/modified field or object that resolves to ZERO modeled grants. */
export interface AccessParityFinding {
  readonly id: ComponentId;
  readonly type: string;
  readonly apiName: string;
  readonly changeKind: ChangeKind;
  /** Why it is a candidate — a WARNING to verify, not a proof. */
  readonly reason: string;
}

/**
 * Count of ViewAllData / ModifyAllData holders across all Profiles /
 * PermissionSets, or `null` per count when the org-wide scan NEVER RAN.
 *
 * The scan is lazy — it fires only when some component reaches the zero-explicit-
 * grant branch. A changeset whose every entry is explicitly granted (or is a
 * standard component) therefore never scans, and `null` says so. `0` is reserved
 * for a CHECKED zero: the org WAS scanned and holds no blanket-access grantor.
 * The two cannot share a value — a bare `0` reads as the security fact "nobody
 * in this org holds ModifyAllData", which nothing established.
 */
export interface SystemPermHolders {
  readonly viewAllData: number | null;
  readonly modifyAllData: number | null;
}

/** The org-wide grantor scan's outcome: the counts plus its residual-cap honesty. */
interface SystemPermScan {
  readonly holders: SystemPermHolders;
  /** Grantor types whose exhaustive walk stopped at the residual full-scan cap. */
  readonly incompleteTypes: readonly string[];
}

/** The additive `accessParity` section `review_change` emits when asked. */
export interface AccessParityResult {
  /**
   * Added/modified CUSTOM fields & objects that resolved to ZERO grants — the
   * candidate "ships for nobody" set (a feature invisible because no permission
   * set / profile grants it). Sorted by id. A WARNING to verify, not a proof.
   */
  readonly shipsForNobody: readonly AccessParityFinding[];
  /** How many changeset components were in scope (added/modified field/object). */
  readonly checked: number;
  /** NOT flagged — an explicit Profile / PermissionSet grant confers access. */
  readonly explicitlyGranted: number;
  /** NOT flagged — a ViewAllData / ModifyAllData holder confers blanket access. */
  readonly systemPermCovered: number;
  /** NOT flagged — a STANDARD (non-`__c`) field/object with default access. */
  readonly standardDefault: number;
  /**
   * ViewAllData / ModifyAllData holder counts (informational precision context).
   * Each count is `null` when the lazy org-wide scan never ran — NOT-CHECKED,
   * not a checked zero. See {@link SystemPermHolders}.
   */
  readonly systemPermHolders: SystemPermHolders;
  /**
   * True when the org-wide grantor walk stopped at the residual full-scan cap
   * with grantors still behind it — the "no blanket-access holder" precision
   * guard is then NOT PROVEN and a `shipsForNobody` entry is correspondingly
   * weaker. False both when the walk exhausted every grantor AND when the lazy
   * scan never ran (nothing depended on it).
   */
  readonly scanTruncated: boolean;
  /** Vault last-refresh timestamp — a stale grant graph must not mint a false alarm. */
  readonly stamp: string;
  /** Grants are declared Profile / PermissionSet metadata. */
  readonly confidence: ConfidenceLevel;
  readonly disclosure: string;
  readonly boundaries: readonly string[];
}

/** Verbatim honesty disclosure surfaced on every parity result. */
export const ACCESS_PARITY_DISCLOSURE =
  'Access parity flags each ADDED/MODIFIED custom field/object that resolves to ZERO modeled grants — "ships for nobody" (a feature that would deploy invisible because no permission set / profile grants it). "Granted" reuses the field/object access model: an inbound `grantedBy` edge from a Profile/PermissionSet that confers FLS (field readable/editable) or CRUD (object allowRead/allowCreate/allowEdit/allowDelete/viewAllRecords/modifyAllRecords), OR a ViewAllData/ModifyAllData system-perm holder, OR standard-object default access. It is the "ships for NOBODY" direction ONLY — the "ships for everybody" half (how many users actually HOLD a granting permission set) is per-user LIVE assignment data deferred to `sfi.live_permset_holders`. Every verdict is stamped with the vault last-refresh time; a "ships for nobody" entry is a CANDIDATE to verify ("no modeled grant found"), NOT a proven "nobody can see this" — a grant may live in a Profile/PermissionSet not retrieved, a brand-new permission set in this same changeset whose body was not extracted offline, a sharing rule, or standard default access. This is changeset grant COMPLETENESS, not the crud_fls_audit Apex-security heuristic. Confidence: declared.';

/** Verbatim boundary lines for the parity result. */
export const ACCESS_PARITY_BOUNDARIES: readonly string[] = [
  'Access parity is computed over the MODELED grant graph — the `grantedBy` edges plus Profile / PermissionSet nodes of the LAST VAULT REFRESH. A field/object could still be reachable via a Profile / PermissionSet not retrieved into the vault, a brand-new permission set in this same changeset whose body was not extracted offline, a sharing rule, or standard default access, so a "ships for nobody" entry is a CANDIDATE to verify ("no modeled grant found"), NOT a proven "nobody can see this".',
  'Every parity verdict is stamped with the vault last-refresh time (`stamp`): a STALE grant graph must not mint a false "invisible" alarm — re-run `sfi refresh` before trusting a "ships for nobody" flag.',
  'Precision guards against false positives: a component is NOT flagged when any Profile / PermissionSet holds ViewAllData (read) or ModifyAllData (read + edit) — a system perm conferring blanket access — or when it is a STANDARD (non-`__c`) field/object with default access. System-perm coverage is a declared-metadata heuristic (field-level security can still narrow a ViewAll/ModifyAll holder), so confirm the intended business audience regardless.',
  'This is the "ships for NOBODY" (zero-grant) direction ONLY. The "ships for EVERYBODY" question — how many users actually HOLD a granting permission set / profile — is per-user LIVE assignment data the offline vault cannot answer; it is deferred to the live plane (`sfi.live_permset_holders`).',
  'The ViewAllData / ModifyAllData precision guard scans EVERY Profile and PermissionSet in the vault (the walk pages the graph offset forward until each type is exhausted); if it ever stops at the residual full-scan cap, `scanTruncated` is true and an extra boundary line says so — a zero holder count is then "not fully scanned", not proven "none".',
  '`systemPermHolders` is `null` per count when the org-wide ViewAllData / ModifyAllData scan NEVER RAN — the scan is lazy and fires only when some component reaches the zero-explicit-grant branch, so a changeset whose every entry is explicitly granted never pays for it. `0` means the org WAS scanned and holds no blanket-access grantor; `null` means NOTHING WAS CHECKED. Do not read a `null` as "nobody in this org holds ModifyAllData".',
  'Absence of a grant is only as strong as the coverage behind Profile / PermissionSet retrieval: if those families were not fully retrieved, a zero-grant result is "not checked", not proven "none" — cross-check `sfi.coverage_report`.',
  'This is a changeset grant-COMPLETENESS check (did the release ship the permissions), NOT the `sfi.crud_fls_audit` Apex-security heuristic (whether Apex enforces CRUD/FLS) — they answer different questions.',
];

/** True when a field api name (`Object.Field__c`) is a CUSTOM field. */
const isCustomField = (apiName: string): boolean => apiName.endsWith('__c');

/** True when an object api name is a CUSTOM object (`Thing__c`). */
const isCustomObject = (apiName: string): boolean => apiName.endsWith('__c');

/**
 * Whether a `grantedBy` edge to a CustomField confers ANY access. An explicit
 * positive flag (`readable` / `editable`, or the older `read` / `edit`) grants;
 * an edge where those flags are all present-and-false is an explicit DENY (no
 * grant); an edge carrying NONE of the flags is an unknown-level grant the
 * extractor did not populate — counted as a grant (the conservative direction,
 * so an unpopulated edge never mints a false "ships for nobody").
 */
const fieldEdgeConfersAccess = (props: Readonly<Record<string, unknown>>): boolean => {
  if (
    props['readable'] === true ||
    props['editable'] === true ||
    props['read'] === true ||
    props['edit'] === true
  ) {
    return true;
  }
  const flagKeys = ['readable', 'editable', 'read', 'edit'];
  const anyPresent = flagKeys.some((k) => k in props);
  return !anyPresent; // present-but-false => deny; absent => unknown-grant.
};

/**
 * Whether a `grantedBy` edge to a CustomObject confers ANY access. Same
 * present-but-false = deny / absent = unknown-grant rule as fields, over the
 * object CRUD + View/Modify-All flags.
 */
const objectEdgeConfersAccess = (props: Readonly<Record<string, unknown>>): boolean => {
  const flagKeys = [
    'allowRead',
    'allowCreate',
    'allowEdit',
    'allowDelete',
    'viewAllRecords',
    'modifyAllRecords',
  ];
  if (flagKeys.some((k) => props[k] === true)) return true;
  const anyPresent = flagKeys.some((k) => k in props);
  return !anyPresent;
};

/**
 * Count ViewAllData / ModifyAllData holders across EVERY Profile + PermissionSet
 * in the vault, by adopting the shared full-scan helper
 * (`scanAllNodesOfTypes`), which windows the SQL `OFFSET` forward until each
 * type is exhausted. Its residual `FULL_SCAN_MAX_NODES` cap is returned as
 * `incompleteTypes` rather than hidden, so a scan that genuinely stopped short
 * is disclosed instead of being read as "no holder exists".
 */
const scanSystemPermHolders = async (
  ctx: Context,
): Promise<Result<SystemPermScan, McpError>> => {
  const scan = await scanAllNodesOfTypes(ctx.graph, [...GRANTOR_SCAN_TYPES]);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  let viewAllData = 0;
  let modifyAllData = 0;
  for (const node of scan.value.nodes) {
    const perms = node.properties['userPermissions'];
    if (!Array.isArray(perms)) continue;
    // ModifyAllData implies read+edit on all data; count each holder once.
    if (perms.includes('ModifyAllData')) modifyAllData += 1;
    if (perms.includes('ViewAllData')) viewAllData += 1;
  }
  return ok({
    holders: { viewAllData, modifyAllData },
    incompleteTypes: scan.value.incompleteTypes,
  });
};

/**
 * Whether the component has at least one inbound `grantedBy` edge from a
 * Profile / PermissionSet that CONFERS access (per the field/object flag rules).
 */
const hasExplicitGrant = async (
  ctx: Context,
  id: ComponentId,
  type: string,
): Promise<Result<boolean, McpError>> => {
  const edgesRes = await listEdges(ctx.graph, id, { direction: 'in', edgeType: 'grantedBy' });
  if (!edgesRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${edgesRes.error.message}` });
  }
  const grantEdges = edgesRes.value;
  if (grantEdges.length === 0) return ok(false);

  // Resolve grantor node types in ONE batched fetch (drop sparse / non-grantor
  // edges — a `grantedBy` from something other than Profile/PermissionSet is
  // outside the grant model).
  const grantorsRes = await listNodesByIds(ctx.graph, grantEdges.map((e) => e.fromId));
  if (!grantorsRes.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${grantorsRes.error.message}` });
  }
  const grantorById = new Map<ComponentId, Node>(grantorsRes.value.map((n) => [n.id, n]));

  const confers = type === 'CustomField' ? fieldEdgeConfersAccess : objectEdgeConfersAccess;
  for (const edge of grantEdges) {
    const grantor = grantorById.get(edge.fromId);
    if (grantor === undefined || !GRANTOR_TYPES.has(grantor.type)) continue;
    if (confers(edge.properties)) return ok(true);
  }
  return ok(false);
};

/**
 * Resolve the grant-completeness ("ships for nobody") parity check over a
 * changeset, against the graph on `ctx` (the current vault, or the against-vault
 * shadow context in cross-vault mode). Only ADDED / MODIFIED CustomField /
 * CustomObject entries are in scope; everything else is ignored. See the module
 * JSDoc for what "granted" means and the honesty axes.
 */
export const resolveAccessParity = async (
  ctx: Context,
  components: readonly { readonly type: string; readonly apiName: string; readonly changeKind: ChangeKind }[],
): Promise<Result<AccessParityResult, McpError>> => {
  const inScope = components.filter(
    (c) => c.changeKind !== 'deleted' && PARITY_TYPES.has(c.type),
  );

  let explicitlyGranted = 0;
  let systemPermCovered = 0;
  let standardDefault = 0;
  const shipsForNobody: AccessParityFinding[] = [];

  // System-perm holders are scanned at most ONCE, and only when a component
  // actually reaches the zero-explicit-grant branch (lazy — a changeset whose
  // every field is explicitly granted never pays for the org-wide scan).
  let systemPermHolders: SystemPermHolders | null = null;
  let scanIncompleteTypes: readonly string[] = [];
  const ensureHolders = async (): Promise<Result<SystemPermHolders, McpError>> => {
    if (systemPermHolders !== null) return ok(systemPermHolders);
    const res = await scanSystemPermHolders(ctx);
    if (!res.ok) return res;
    systemPermHolders = res.value.holders;
    scanIncompleteTypes = res.value.incompleteTypes;
    return ok(systemPermHolders);
  };

  for (const change of inScope) {
    const id = `${change.type}:${change.apiName}` as ComponentId;
    const isCustom =
      change.type === 'CustomField'
        ? isCustomField(change.apiName)
        : isCustomObject(change.apiName);
    if (!isCustom) {
      // Standard field/object — default access; a precision guard, not flagged.
      standardDefault += 1;
      continue;
    }

    const grantedRes = await hasExplicitGrant(ctx, id, change.type);
    if (!grantedRes.ok) return grantedRes;
    if (grantedRes.value) {
      explicitlyGranted += 1;
      continue;
    }

    // Zero explicit grants — is a blanket system perm (ViewAllData /
    // ModifyAllData) held by anyone? If so it is covered, not "for nobody".
    const holdersRes = await ensureHolders();
    if (!holdersRes.ok) return holdersRes;
    const { viewAllData, modifyAllData } = holdersRes.value;
    // Reached only via ensureHolders(), so both counts are CHECKED numbers here.
    if ((viewAllData ?? 0) > 0 || (modifyAllData ?? 0) > 0) {
      systemPermCovered += 1;
      continue;
    }

    shipsForNobody.push({
      id,
      type: change.type,
      apiName: change.apiName,
      changeKind: change.changeKind,
      reason:
        `No modeled Profile / PermissionSet grant found in the last vault refresh, and no ViewAllData / ModifyAllData holder confers blanket access — this ${change.type} would deploy with access to NOBODY (invisible to every user). ` +
        'VERIFY before shipping: a grant may live in a Profile/PermissionSet not retrieved into the vault, or in a brand-new permission set in THIS changeset whose body was not extracted offline. Add it to the intended permission set(s), or confirm the grant exists in a plane the vault does not model.',
    });
  }

  // If nothing reached the zero-grant branch the org-wide scan was SKIPPED —
  // publish the NOT-CHECKED sentinel (`null` per count), never a checked zero:
  // `{ viewAllData: 0, modifyAllData: 0 }` reads as the security fact "no
  // container in this org holds ViewAllData / ModifyAllData", which nothing
  // established.
  const holders: SystemPermHolders =
    systemPermHolders ?? { viewAllData: null, modifyAllData: null };
  const scanTruncated = scanIncompleteTypes.length > 0;

  return ok({
    shipsForNobody: [...shipsForNobody].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    checked: inScope.length,
    explicitlyGranted,
    systemPermCovered,
    standardDefault,
    systemPermHolders: holders,
    scanTruncated,
    stamp: ctx.manifest.refreshedAt,
    confidence: 'declared',
    disclosure: ACCESS_PARITY_DISCLOSURE,
    boundaries: scanTruncated
      ? [...ACCESS_PARITY_BOUNDARIES, fullScanTruncationNote(scanIncompleteTypes)]
      : ACCESS_PARITY_BOUNDARIES,
  });
};
