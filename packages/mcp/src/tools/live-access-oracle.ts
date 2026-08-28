/**
 * `sfi.live_access_oracle` — PROVE the offline permission engine right or wrong.
 *
 * The offline engine (`sfi.effective_permissions` / `computeEffectiveGrants`)
 * reconstructs a user's effective object access from vault metadata by
 * re-implementing Salesforce's precedence rules. It works with no org
 * connection — that is the product's moat — and it has no way to know when it
 * is wrong. This tool asks Salesforce for its OWN final verdict
 * (`UserEntityAccess`, Tooling API) on the SAME user and the SAME objects, and
 * reports precisely where the two disagree.
 *
 * It does NOT replace the offline engine, and the offline path never learns
 * about this tool: `effective_permissions` answers exactly as it did before,
 * with or without an org connection. This is purely additive verification.
 *
 * ## What makes this honest
 *
 *   1. **"Platform confirmed" and "platform not consulted" are different
 *      states.** Every verb row carries which one it is. A verb the platform
 *      has no column for (`viewAllRecords`) is UNKNOWN forever, not a quiet
 *      agreement. An object the platform returned no row for is UNKNOWN, never
 *      "no access" — a missing row is silence, not denial.
 *   2. **The verb mapping refuses to invent equivalences.** Four verbs map 1:1;
 *      four deliberately do not and stay UNKNOWN with the reason attached. See
 *      `platform-access-parity.ts` for the table and the argument for each
 *      refusal.
 *   3. **The offline side is computed over the user's REAL grant bundle.**
 *      Diffing the platform's answer for user U against the offline answer for
 *      *some other* container set would produce meaningless disagreements, so
 *      containers are derived from the user's live assignment by default. When
 *      derivation cannot be trusted (see the profile-name gap below) the tool
 *      REFUSES rather than diffing against a partial bundle and emitting a
 *      flood of false "offline understates".
 *
 * ## The profile bridge (keyed on ProfileId, never on the label)
 *
 * SOQL exposes `User.ProfileId` and `User.Profile.Name`. The vault keys Profile
 * nodes by metadata API name, which SOQL never returns.
 *
 * `sfi refresh` builds the crossing: `sf org list metadata -m Profile` yields
 * `{ id, fullName }` (fullName IS the API name) and `SELECT Id, Name FROM
 * Profile` yields `{ Id, Name }`; joined on the 15-char Id. The result is a
 * vault artifact, read here through ONE swappable seam.
 *
 * Resolution is keyed on **ProfileId**. An earlier revision keyed it on the
 * LABEL and that was wrong in the worst way available on a security question:
 * labels are MUTABLE and RE-USABLE. Rename a profile between refreshes, or free
 * a label and re-apply it to a different profile, and a label-keyed lookup
 * silently resolves to the WRONG profile — the oracle would then diff the user
 * against a container bundle that is not theirs and report the mismatch as a
 * permission finding, indistinguishable from a real one. `ProfileId` is stable,
 * always populated, and free: the `Profile.Name` traversal already walks it.
 *
 * The label survives only as a human echo and as a cross-check — when it
 * differs from the label recorded at build time the profile was renamed since
 * the refresh, which is DISCLOSED (`labelChangedSinceRefresh`) and harmless,
 * because the id still resolves.
 *
 * All three failure modes REFUSE rather than degrade, and none falls back to
 * name-matching:
 *
 *   - map absent (vault never refreshed with an org connection),
 *   - no ProfileId returned for the user,
 *   - id not in the map (profile newer than the last refresh, or one of the
 *     disclosed join gaps: present in only one source, missing an Id from
 *     `listMetadata`, or colliding on one).
 *
 * `profileId` remains the always-available escape hatch and skips the bridge.
 *
 * Permission sets have no such gap: `PermissionSet.Name` IS the metadata API
 * name. Assignments that arrive through a permission set GROUP are contributed
 * as `PermissionSetGroup:{DeveloperName}` so the offline engine applies its
 * group-scoped MUTING, rather than as loose member sets (which would drop the
 * muting and overstate).
 *
 * ## Cost
 *
 * Up to four live reads per call: one User lookup, one PermissionSetAssignment
 * read (skipped when containers are supplied), and one Tooling batch per 50
 * objects. All of them go through the per-session live-query budget seam
 * (`runLiveQuery`), so an oracle call is bounded and cached like every other
 * live read. Scope: `users` — the query is keyed on a named individual's
 * UserId, which is exactly what that scope gates.
 */

import type {
  ComponentId,
  EvidenceClaimV2,
  EvidenceEnvelopeV2,
  EvidenceRefV2,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import {
  fetchUserEntityAccess,
  USER_ENTITY_ACCESS_CHUNK_SIZE,
  USER_ENTITY_ACCESS_QUERY_LIMIT,
  type ExecCommand,
  type UserEntityAccessBatchFailure,
  type UserEntityAccessClient,
} from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import { mdTable, renderTrustFooter } from '../answer-render.js';
import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { computeEffectiveGrants } from './effective-permissions.js';
import { assertEvidenceEnvelopeV2 } from './evidence-envelope.js';
import { LIVE_PLANE_DISCLOSURE, nodeExecFile, redactSecrets } from './live-exec.js';
import { getActiveLiveGrant } from './live-grant-context.js';
import { assertSoqlIdentifier, gateLive } from './live-plane.js';
import { runLiveQuery } from './live-session.js';
import {
  COMPARABLE_VERBS,
  diffAccessParity,
  PARITY_UNKNOWN_GLOSSARY,
  PARITY_VERDICT_GLOSSARY,
  type AccessParityReport,
  type OfflineObjectAccess,
} from './platform-access-parity.js';
import {
  bridgeProfileToApiName,
  type ProfileResolution,
} from './profile-name-bridge.js';

/**
 * Objects per call. Lower than the fetcher's own 100-object platform cap on
 * purpose: the per-object × per-verb detail this tool emits is what bounds the
 * response, not what the org will serve. Named separately so the two caps are
 * never confused for one another.
 */
export const ACCESS_ORACLE_MAX_OBJECTS = 25;

/** Response byte budget for the per-object detail, leaving envelope headroom. */
const ACCESS_ORACLE_BYTE_BUDGET = 32_000;

export const liveAccessOracleInputSchema = z.object({
  /** Exact Username (preferred — unique) or exact User.Name. */
  user: z.string().min(1),
  /** Object API names to adjudicate. Bounded: UserEntityAccess cannot be paged. */
  objects: z.array(z.string().min(1)).min(1).max(ACCESS_ORACLE_MAX_OBJECTS),
  /**
   * Offline Profile container override (`Profile:Admin` or bare `Admin`).
   * Required whenever the user's live profile LABEL is not also a vault Profile
   * node name — see the module header's profile-name gap.
   */
  profileId: z.string().min(1).optional(),
  /**
   * Offline PermissionSet / PermissionSetGroup container override. Supplying
   * either override switches the offline side to `caller-supplied` wholesale —
   * the tool never silently mixes derived and supplied containers.
   */
  permissionSetIds: z.array(z.string().min(1)).optional(),
  orgAlias: z.string().min(1).optional(),
  liveEnabled: z.boolean().optional(),
})
  // roster.ts advertises `additionalProperties: false` for this tool — a
  // security-parity check whose whole argument is REFUSE over silent
  // degrade (see module header). Without `.strict()`, zod strips an
  // unrecognized key (a typo'd `permissionSetId` singular, a mis-cased
  // `profileID`) instead of rejecting it, so a container-override typo is
  // silently dropped and the tool falls through to the derived bundle
  // rather than the one the caller asked to adjudicate against.
  .strict();

export type LiveAccessOracleInput = z.infer<typeof liveAccessOracleInputSchema>;

/** Where the offline grant bundle came from. */
export type ContainerSource = 'caller-supplied' | 'derived-from-live-assignment';

export interface OracleUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly isActive: boolean;
  /**
   * The user's ProfileId — the STABLE key the offline Profile container is
   * resolved by. Labels are mutable; this is not.
   */
  readonly profileId: string | null;
  /** The live profile LABEL (`Profile.Name`). Human echo only, never a key. */
  readonly profileName: string | null;
}

export type { ProfileResolution };

/** Internal result of the live-assignment derivation. */
interface DerivedContainers {
  readonly containers: readonly string[];
  readonly profileResolution: ProfileResolution;
}

export interface OfflineContainerResolution {
  readonly source: ContainerSource;
  /**
   * How the profile LABEL was bridged to an API name. `null` on the
   * `caller-supplied` path (no bridge needed — the caller named the container).
   */
  readonly profileResolution: ProfileResolution | null;
  /** Canonical container ids fed to `computeEffectiveGrants`, in order. */
  readonly requested: readonly string[];
  /** Containers resolved to a real vault node (they contributed grants). */
  readonly present: readonly string[];
  /**
   * Containers NOT in the vault. Every one is a grant the offline side is
   * blind to, so each is a probable source of "offline understates".
   */
  readonly missingFromVault: readonly string[];
  /** Permission-set groups whose muting could not be applied (disclosed). */
  readonly mutingNotApplied: readonly string[];
}

/** What the platform read actually did — the "was it consulted?" record. */
export interface PlatformReadReport {
  /** Always true on a successful call: this tool never answers without asking. */
  readonly consulted: boolean;
  readonly objectsRequested: number;
  readonly batchCount: number;
  readonly limitPerBatch: number;
  /** True when a batch hit its LIMIT — the read may be silently truncated. */
  readonly limitReached: boolean;
  /** Objects the platform returned no row for. Unanswered, NOT denied. */
  readonly unanswered: readonly string[];
  readonly failures: readonly UserEntityAccessBatchFailure[];
  /** True when every object got a row, no batch failed, and no limit was hit. */
  readonly complete: boolean;
  /** The exact SOQL issued, one per batch. */
  readonly queries: readonly string[];
}

export interface LiveAccessOracleOutput {
  readonly user: OracleUser;
  readonly objects: readonly string[];
  readonly offlineContainers: OfflineContainerResolution;
  readonly platformRead: PlatformReadReport;
  readonly parity: AccessParityReport;
  /** Long-form meaning of each verdict / UNKNOWN reason. Emitted once. */
  readonly glossary: {
    readonly verdicts: Readonly<Record<string, string>>;
    readonly unknownReasons: Readonly<Record<string, string>>;
  };
  /** Per-object detail dropped to stay inside the byte budget (full counts stand). */
  readonly detailTruncated: boolean;
  readonly interpretation: string;
  readonly disclosure: string;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
  readonly evidenceEnvelope: EvidenceEnvelopeV2;
  readonly rendered: string;
}

/** Verbatim honesty disclosure surfaced on every oracle result. */
export const ACCESS_ORACLE_DISCLOSURE =
  'This is a PARITY CHECK, not a replacement for the offline engine. It compares what `sfi.effective_permissions` computes OFFLINE from vault metadata against Salesforce\'s OWN verdict (Tooling API `UserEntityAccess`) for the same user and objects. Four verbs map 1:1 (read/create/edit/delete ↔ IsReadable/IsCreatable/IsEditable/IsDeletable); four deliberately DO NOT and are reported UNKNOWN with the reason attached (undelete and IsFlsUpdatable have no offline equivalent; viewAllRecords and modifyAllRecords have no platform column). "Platform confirmed agreement" and "platform not consulted" are DIFFERENT states and are never conflated — a verb with no mapping, and an object the platform returned no row for, are UNKNOWN, never a quiet AGREE and never "no access". OFFLINE OVERSTATES is the dangerous class (the product would claim access that does not exist) and is listed explicitly rather than folded into a count. The offline side is computed over the user\'s REAL grant bundle; when that bundle cannot be resolved the tool refuses rather than diffing against a partial one. The offline profile container is resolved by the user\'s stable ProfileId through the vault\'s refresh-built Profile Id<->API-name map, NEVER by profile name: labels are mutable and re-usable, so a name-match can silently resolve to a different profile and diff the user against a bundle that is not theirs. An absent or incomplete map REFUSES rather than guesses. It also CANNOT catch silence: only the objects you name are adjudicated, and UserEntityAccess cannot be enumerated, so an overstatement on an unnamed object is invisible by construction. Read-only; point-in-time as of queriedAt.';

/** Verbatim boundary lines. */
export const ACCESS_ORACLE_BOUNDARIES: readonly string[] = Object.freeze([
  'UserEntityAccess CANNOT be paged — an unbounded query fails with EXCEEDED_ID_LIMIT ("does not support queryMore()"). There is no "check every object" mode at any price. Every call is a bounded spot-check of caller-named objects; absence of an object from this report is "not checked", never "no access".',
  'THIS ORACLE CANNOT CATCH SILENCE. It adjudicates ONLY the objects you name. Because UserEntityAccess cannot be enumerated, there is no sweep and no sampling that would honestly stand in for one — so the offline engine OVERSTATING access on an object nobody thought to check is invisible to this tool, permanently and by construction. A clean report means "the objects you named agreed", never "the offline engine is verified".',
  'An object with NO returned row is UNANSWERED, not denied. The reason is not knowable from the response: the object may not exist, may not be visible to the AUTHENTICATED running user (not the subject user), may not be exposed through UserEntityAccess, or its batch may have failed.',
  'AGREEMENT is only as strong as the verb mapping. The four UNKNOWN verbs are genuinely unverified — `viewAllRecords` / `modifyAllRecords` are record-SCOPE permissions with no UserEntityAccess column (the platform answers record scope through UserRecordAccess, per-RECORD), and `undelete` / `IsFlsUpdatable` have no offline flag to compare against.',
  'This adjudicates OBJECT-level access only. Field-level security is NOT compared: IsFlsUpdatable is an entity-level roll-up while the offline engine models FLS per field, so mapping them would score a NEW inference of ours rather than the engine\'s output. Use `field_access_audit` for a specific field.',
  'Object permission is NOT record access. Neither side answers "can this user see THIS record" — that is OWD + sharing (`why_cant_user_see_record` offline, `sfi.live_record_access` live).',
  'A multi-batch read is NOT atomic: batches are separate point-in-time reads and the org can change between them. `batchCount` discloses how many were issued — with the 25-object per-call cap that is always 1 today, so this call IS a single point-in-time read; the disclosure exists because the underlying fetcher chunks at 50 and a wider caller would not be.',
  'The offline Profile container is resolved by ProfileId, not by profile name — labels are mutable and re-usable, so name-matching can silently misattribute a user to the wrong profile. A profile RENAMED since the last refresh still resolves correctly and is disclosed via `labelChangedSinceRefresh`; a profile CREATED since the last refresh is not in the map and is refused, not guessed.',
  'The offline side is only as good as the last vault refresh AND as the container bundle behind it. Any container in `missingFromVault` is a grant the offline engine is blind to and a probable source of false "offline understates" — re-run `sfi refresh` before trusting an understatement.',
]);

/** Salesforce 15/18-char record id. */
const RECORD_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

/** SOQL literal escape — backslash BEFORE quote (order prevents break-out). */
const soqlLiteral = (value: string): string =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** SOQL datetime literal (no fractional seconds). */
const soqlDateTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Mirrors live-plane's budget-exhaustion probe so a STOP stays legible. */
const isBudgetExhausted = (message: string): boolean =>
  /live-query budget exhausted/i.test(message);

interface LiveRows {
  readonly available: boolean;
  readonly records: readonly Record<string, unknown>[];
  readonly reason?: string;
}

/** Run one budgeted SOQL read, converting failure into `available:false`. */
const liveRows = async (
  org: string,
  soql: string,
  exec: ExecCommand,
): Promise<LiveRows> => {
  const r = await runLiveQuery(org, ['data', 'query', '--query', soql], exec);
  if (!r.ok) return { available: false, records: [], reason: r.error.message };
  const p = r.value.value as { result?: { records?: Record<string, unknown>[] } };
  return { available: true, records: p.result?.records ?? [] };
};

/**
 * A {@link UserEntityAccessClient} that routes Tooling reads through the
 * per-session budget/cache seam instead of opening its own HTTP client.
 *
 * This is why the fetcher takes a narrowed `Pick<ToolingApiClient, 'query'>`:
 * the MCP live plane must not bypass `runLiveQuery`, or an oracle call would
 * spend org API budget outside the one chokepoint that bounds it. The
 * `--use-tooling-api` flag is part of the args vector, so it also keys the
 * cache distinctly from a non-Tooling query of the same SOQL.
 */
const budgetedToolingClient = (
  org: string,
  exec: ExecCommand,
): UserEntityAccessClient => ({
  query: async <T>(soql: string) => {
    const r = await runLiveQuery(
      org,
      ['data', 'query', '--query', soql, '--use-tooling-api'],
      exec,
    );
    if (!r.ok) {
      return err({
        kind: 'query-failed' as const,
        message: redactSecrets(r.error.message),
      });
    }
    const p = r.value.value as { result?: { records?: readonly T[] } };
    return ok(p.result?.records ?? []);
  },
});

/** Trust block: hybrid — the answer fuses the offline vault and a live read. */
const oracleTrust = (
  ctx: Context,
  queriedAt: string,
  limitations: readonly string[],
): TrustSummary => {
  const grant = getActiveLiveGrant();
  const grantLine =
    grant === null
      ? null
      : `Live grant ${grant.grantId} (source=${grant.source}` +
        (grant.orgId !== null ? `; orgId=${grant.orgId}` : '') +
        `; scopes=${grant.scopes.join(',')}; expires=${grant.expiresAt}).`;
  return {
    provenance: 'hybrid',
    confidence: 'declared',
    freshness: {
      snapshotRefreshedAt: ctx.manifest.refreshedAt,
      liveQueriedAt: queriedAt,
      overall: 'mixed',
    },
    completeness: { status: 'partial' },
    limitations: [
      LIVE_PLANE_DISCLOSURE,
      ...(grantLine === null ? [] : [grantLine]),
      ...limitations,
    ],
  };
};

interface ResolvedUser {
  readonly user: OracleUser;
}

/** Resolve the subject user: exact Username first (unique), then exact Name. */
const resolveUser = async (
  org: string,
  raw: string,
  exec: ExecCommand,
): Promise<Result<ResolvedUser, McpError>> => {
  const lit = soqlLiteral(raw);
  // ProfileId is the RESOLUTION key (stable); Profile.Name is echo only
  // (labels are mutable/re-usable). The traversal already walks the Profile,
  // so adding the id costs no extra query.
  const select =
    'SELECT Id, Name, Username, IsActive, ProfileId, Profile.Name FROM User';
  const byUsername = await liveRows(org, `${select} WHERE Username = ${lit} LIMIT 2`, exec);
  if (!byUsername.available) {
    return err({
      kind: 'invalid-query',
      message: `Could not read the User object in '${org}': ${redactSecrets(byUsername.reason ?? '').slice(0, 160)}`,
    });
  }
  let row = byUsername.records[0];
  if (byUsername.records.length !== 1) {
    const byName = await liveRows(org, `${select} WHERE Name = ${lit} LIMIT 5`, exec);
    if (!byName.available) {
      return err({
        kind: 'invalid-query',
        message: `Could not read the User object in '${org}': ${redactSecrets(byName.reason ?? '').slice(0, 160)}`,
      });
    }
    if (byName.records.length === 0) {
      return err({
        kind: 'component-not-found',
        message:
          `No user with exact Username or Name '${raw}' in the live org. ` +
          'Usernames are unique — prefer the full Username.',
        path: 'user',
      });
    }
    if (byName.records.length > 1) {
      return err({
        kind: 'invalid-query',
        message:
          `'${raw}' matches ${byName.records.length} users in the live org — refusing to guess. ` +
          'Pass the exact Username.',
        path: 'user',
      });
    }
    row = byName.records[0];
  }
  const id = String(row?.['Id'] ?? '');
  if (!RECORD_ID_RE.test(id)) {
    return err({
      kind: 'internal',
      message: 'The User query returned no usable Id — cannot key UserEntityAccess.',
    });
  }
  const profile = row?.['Profile'] as { Name?: string } | null | undefined;
  return ok({
    user: {
      id,
      name: String(row?.['Name'] ?? ''),
      username: String(row?.['Username'] ?? ''),
      isActive: row?.['IsActive'] === true,
      profileId: typeof row?.['ProfileId'] === 'string' ? row['ProfileId'] : null,
      profileName: profile?.Name ?? null,
    },
  });
};

/**
 * Derive the offline container bundle from the user's LIVE assignment.
 *
 * `PermissionSet.IsOwnedByProfile = false` keeps the profile-owned system PSA
 * row from masquerading as a direct assignment (the same filter
 * `live_user_permsets` documents). A row that arrived through a permission set
 * GROUP contributes the GROUP id, not the member set, so the offline engine
 * applies its group-scoped muting instead of unioning members muting-free.
 */
const deriveContainers = async (
  org: string,
  user: OracleUser,
  vaultRoot: string,
  exec: ExecCommand,
): Promise<Result<DerivedContainers, McpError>> => {
  if (user.profileId === null) {
    return err({
      kind: 'invalid-query',
      message:
        'The live org returned no ProfileId for this user, so the offline grant bundle cannot be ' +
        'assembled. Pass `profileId` explicitly to name the vault Profile container.',
      path: 'profileId',
    });
  }

  // THE BRIDGE — one call, one seam. The user's PROFILE ID (stable) is crossed
  // to the vault's metadata API name; the label rides along as a human echo
  // only. Everything about HOW that gap is crossed, and every way it can fail,
  // lives in profile-name-bridge.ts, which is deliberately swappable. This tool
  // knows only "resolved, or refuse" — it has no fallback and must never grow
  // one: profile labels are mutable and re-usable, so a name-match can silently
  // resolve to a DIFFERENT profile and blame the offline engine for the diff.
  const bridged = await bridgeProfileToApiName(
    vaultRoot,
    user.profileId,
    user.profileName,
  );
  if (!bridged.ok) return err(bridged.error);

  const nowLit = soqlDateTime(new Date());
  const rows = await liveRows(
    org,
    'SELECT PermissionSet.Name, PermissionSetGroupId, PermissionSetGroup.DeveloperName ' +
      'FROM PermissionSetAssignment ' +
      `WHERE AssigneeId = ${soqlLiteral(user.id)} AND PermissionSet.IsOwnedByProfile = false ` +
      `AND (ExpirationDate = null OR ExpirationDate >= ${nowLit}) ORDER BY Id LIMIT 500`,
    exec,
  );
  if (!rows.available) {
    return err({
      kind: 'invalid-query',
      message:
        'Could not read PermissionSetAssignment, so the offline grant bundle cannot be assembled. ' +
        'Refusing to diff against a partial bundle (it would manufacture false "offline understates"). ' +
        `Underlying: ${redactSecrets(rows.reason ?? '').slice(0, 160)}`,
    });
  }

  const containers: string[] = [`Profile:${bridged.apiName}`];
  const seen = new Set(containers);
  for (const r of rows.records) {
    const psg = r['PermissionSetGroup'] as { DeveloperName?: string } | null | undefined;
    const ps = r['PermissionSet'] as { Name?: string } | null | undefined;
    const id =
      r['PermissionSetGroupId'] !== null && r['PermissionSetGroupId'] !== undefined
        ? `PermissionSetGroup:${psg?.DeveloperName ?? String(r['PermissionSetGroupId'])}`
        : `PermissionSet:${ps?.Name ?? ''}`;
    if (id.endsWith(':') || seen.has(id)) continue;
    seen.add(id);
    containers.push(id);
  }
  return ok({ containers, profileResolution: bridged.resolution });
};

/** Fold the parity result into an EvidenceEnvelope v2. */
const buildOracleEnvelope = (args: {
  readonly parity: AccessParityReport;
  readonly containers: OfflineContainerResolution;
  readonly platformRead: PlatformReadReport;
  readonly trust: TrustSummary;
}): EvidenceEnvelopeV2 => {
  const claims: EvidenceClaimV2[] = [];
  const evidence: EvidenceRefV2[] = [];
  const seen = new Set<string>();
  const cite = (id: string, role: string, note?: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    evidence.push({
      componentId: id as ComponentId,
      role,
      ...(note === undefined ? {} : { note }),
    });
  };
  for (const c of args.containers.present) cite(c, 'offline-container');

  for (const d of args.parity.overstatements) {
    const objectId = `CustomObject:${d.object}`;
    cite(objectId, 'overstated-object');
    claims.push({
      claim: `OFFLINE OVERSTATES ${d.verb} on ${d.object}: the offline engine says granted, the platform says NOT.`,
      groundedIn: [objectId as ComponentId],
      confidence: 'declared',
      coverageCaveat: null,
      ruleId: 'access-oracle:offline-overstates',
      concept: 'platform-access-parity',
    });
  }
  for (const d of args.parity.understatements) {
    const objectId = `CustomObject:${d.object}`;
    cite(objectId, 'understated-object');
    claims.push({
      claim: `OFFLINE UNDERSTATES ${d.verb} on ${d.object}: the platform grants it, the offline engine says no.`,
      groundedIn: [objectId as ComponentId],
      confidence: 'declared',
      coverageCaveat: null,
      ruleId: 'access-oracle:offline-understates',
      concept: 'platform-access-parity',
    });
  }
  if (args.parity.counts.agree > 0) {
    claims.push({
      claim:
        `Platform CONFIRMED ${args.parity.counts.agree} (object, verb) pair(s) across the ` +
        `${COMPARABLE_VERBS.length} 1:1-mapped verbs.`,
      groundedIn: args.parity.objects
        .filter((o) => o.platformAnswered)
        .map((o) => `CustomObject:${o.object}` as ComponentId),
      confidence: 'declared',
      coverageCaveat:
        args.platformRead.complete
          ? null
          : 'The platform read was incomplete — see platformRead.unanswered / failures.',
      ruleId: 'access-oracle:agree',
      concept: 'platform-access-parity',
    });
  }

  const missingCoverage = [
    ...args.parity.objectsPlatformDidNotAnswer.map((o) => `platform-no-row:${o}`),
    ...args.parity.objectsNotInVault.map((o) => `not-in-vault:${o}`),
    ...args.containers.missingFromVault.map((c) => `container-not-in-vault:${c}`),
  ];

  const envelope: EvidenceEnvelopeV2 = {
    envelopeVersion: 2,
    claims,
    evidence,
    coverage: {
      status: args.platformRead.complete && missingCoverage.length === 0 ? 'complete' : 'partial',
      ...(missingCoverage.length > 0 ? { missingCoverage } : {}),
      message:
        'Coverage is the set of (object, verb) pairs the platform actually ADJUDICATED. ' +
        'Anything else is UNKNOWN — never a quiet agreement and never "no access".',
    },
    freshness: args.trust.freshness,
    trust: args.trust,
    absence: {
      status: 'not-checked',
      note:
        'UserEntityAccess cannot be enumerated, so this report proves nothing about objects that ' +
        'were not named. An object absent from the request — or present but unanswered — is ' +
        '"not checked", NEVER "no access".',
    },
    disclosure: ACCESS_ORACLE_DISCLOSURE,
  };
  assertEvidenceEnvelopeV2(envelope);
  return envelope;
};

const renderOracleMarkdown = (
  data: Omit<LiveAccessOracleOutput, 'rendered'>,
): string => {
  const c = data.parity.counts;
  const lines: string[] = [
    `### Platform access oracle — ${data.user.name} (\`${data.user.username}\`)`,
    '',
    `Offline containers (${data.offlineContainers.source}): ` +
      `${data.offlineContainers.present.length} present` +
      (data.offlineContainers.missingFromVault.length > 0
        ? `, ${data.offlineContainers.missingFromVault.length} NOT in the vault`
        : '') +
      '.',
    '',
    `**${c.offlineOverstates}** offline OVERSTATES · **${c.offlineUnderstates}** offline UNDERSTATES · ` +
      `**${c.agree}** confirmed · **${c.unknown}** unknown.`,
  ];
  if (data.parity.overstatements.length > 0) {
    lines.push(
      '',
      '**OFFLINE OVERSTATES — the offline answer claims access the platform denies**',
      '',
      mdTable(
        ['Object', 'Verb'],
        data.parity.overstatements.map((d) => [d.object, d.verb]),
      ),
    );
  }
  if (data.parity.understatements.length > 0) {
    lines.push(
      '',
      '**OFFLINE UNDERSTATES — the platform grants access the offline answer misses**',
      '',
      mdTable(
        ['Object', 'Verb'],
        data.parity.understatements.map((d) => [d.object, d.verb]),
      ),
    );
  }
  if (data.platformRead.unanswered.length > 0) {
    lines.push(
      '',
      `NOT ANSWERED by the platform (this is silence, NOT "no access"): ${data.platformRead.unanswered.join(', ')}.`,
    );
  }
  lines.push('', data.interpretation, '', data.disclosure, '', renderTrustFooter(data.trust));
  return lines.join('\n');
};

/**
 * `sfi.live_access_oracle` — diff the offline permission engine against
 * Salesforce's own `UserEntityAccess` verdict for one user and a bounded set
 * of objects.
 */
export const liveAccessOracleHandler = async (
  ctx: Context,
  input: LiveAccessOracleInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveAccessOracleOutput>, McpError>> => {
  const gate = await gateLive(ctx, input, exec);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();

  // Validate object names BEFORE any org read — a malformed name must fail
  // loudly at the boundary, never reach a SOQL builder.
  const objects: string[] = [];
  const objectSeen = new Set<string>();
  for (const raw of input.objects) {
    const checked = assertSoqlIdentifier(raw, 'objects');
    if (!checked.ok) return err(checked.error);
    const key = checked.value.toLowerCase();
    if (objectSeen.has(key)) continue;
    objectSeen.add(key);
    objects.push(checked.value);
  }

  const resolved = await resolveUser(org, input.user, exec);
  if (!resolved.ok) return err(resolved.error);
  const user = resolved.value.user;

  // ---- offline side: resolve the container bundle -------------------------
  const callerSupplied =
    input.profileId !== undefined || input.permissionSetIds !== undefined;
  let rawContainers: readonly string[];
  let profileResolution: ProfileResolution | null = null;
  if (callerSupplied) {
    const supplied: string[] = [];
    if (input.profileId !== undefined) {
      supplied.push(coercePrefix(input.profileId, ['Profile:']));
    }
    for (const id of input.permissionSetIds ?? []) {
      supplied.push(coercePrefix(id, ['PermissionSet:']));
    }
    rawContainers = supplied;
  } else {
    const derived = await deriveContainers(org, user, ctx.vaultRoot, exec);
    if (!derived.ok) return err(derived.error);
    rawContainers = derived.value.containers;
    profileResolution = derived.value.profileResolution;
  }

  const grantsResult = await computeEffectiveGrants(ctx, rawContainers);
  if (!grantsResult.ok) return err(grantsResult.error);
  const grants = grantsResult.value;

  // Vault/org DRIFT, distinct from the label->API-name gap the map now closes:
  // the map resolved a real API name, but the vault holds no node for it (the
  // profile was created after the last refresh, or the retrieve dropped it). A
  // derived bundle missing its Profile understates nearly every verb, so refuse
  // rather than emit a diff that blames the offline engine for a stale vault.
  if (!callerSupplied) {
    const profileId = rawContainers[0] ?? '';
    if (grants.missingContainers.includes(profileId)) {
      return err({
        kind: 'invalid-query',
        message:
          `The user's profile resolved to '${profileId}' via this vault's Profile ` +
          'Id<->API-name map, but the vault holds NO node for it — the profile was likely ' +
          'created (or its metadata dropped from the retrieve) after the last refresh. Run ' +
          '`sfi refresh`, or pass `profileId` explicitly. Refusing to diff without the profile: ' +
          'a missing profile understates nearly every verb and would blame the offline engine ' +
          'for a stale vault.',
        path: 'profileId',
      });
    }
  }
  if (grants.presentContainers.length === 0) {
    return err({
      kind: 'component-not-found',
      message:
        `None of the offline containers exist in this vault: ${rawContainers.join(', ')}. ` +
        'Without a grant bundle there is nothing to compare the platform verdict against.',
      path: rawContainers[0] ?? '',
    });
  }

  const containers: OfflineContainerResolution = {
    source: callerSupplied ? 'caller-supplied' : 'derived-from-live-assignment',
    profileResolution,
    requested: rawContainers,
    present: grants.presentContainers,
    missingFromVault: grants.missingContainers,
    mutingNotApplied: [...grants.mutingNoData, ...grants.mutingMissing],
  };

  // ---- offline side: per-object answer + "does the vault model it?" -------
  const offlineAccess: OfflineObjectAccess[] = [];
  for (const object of objects) {
    const nodeResult = await getNodeById(
      ctx.graph,
      `CustomObject:${object}` as ComponentId,
    );
    if (!nodeResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${nodeResult.error.message}`,
      });
    }
    const accum = grants.objectMap.get(object);
    const flags = accum === undefined ? null : { ...accum.flags };
    offlineAccess.push({
      object,
      vaultHasObject: nodeResult.value !== null,
      flags,
      grantedBy: accum === undefined ? [] : [...accum.grantedBy].sort(),
    });
  }

  // ---- platform side ------------------------------------------------------
  const fetched = await fetchUserEntityAccess({
    client: budgetedToolingClient(org, exec),
    userId: user.id,
    objects,
    chunkSize: USER_ENTITY_ACCESS_CHUNK_SIZE,
    limitPerBatch: USER_ENTITY_ACCESS_QUERY_LIMIT,
  });
  if (!fetched.ok) {
    return err({
      kind: 'invalid-query',
      message: `${fetched.error.kind}: ${fetched.error.message}`,
      path: 'objects',
    });
  }
  const report = fetched.value;

  const platformRead: PlatformReadReport = {
    consulted: true,
    objectsRequested: report.requested.length,
    batchCount: report.batchCount,
    limitPerBatch: report.limitPerBatch,
    limitReached: report.limitReached,
    unanswered: report.missing,
    failures: report.failures,
    complete: report.complete,
    queries: report.queries,
  };

  const parity = diffAccessParity(offlineAccess, report.rows);

  // ---- honesty surfaces ---------------------------------------------------
  const limitations: string[] = [];
  if (report.failures.length > 0) {
    limitations.push(
      `${report.failures.length} platform batch(es) FAILED — every object in them is unanswered, not denied.`,
    );
    if (report.failures.some((f) => isBudgetExhausted(f.message))) {
      limitations.push(
        'The per-session live-query budget was exhausted mid-read. Raise SFI_LIVE_QUERY_BUDGET or start a new session, then re-run.',
      );
    }
  }
  if (report.limitReached) {
    limitations.push(
      'A platform batch returned exactly its LIMIT — the read may be TRUNCATED and the diff is not complete.',
    );
  }
  if (containers.missingFromVault.length > 0) {
    limitations.push(
      `${containers.missingFromVault.length} offline container(s) are NOT in the vault (${containers.missingFromVault.join(', ')}) — a probable source of false "offline understates". Re-run \`sfi refresh\`.`,
    );
  }
  if (containers.mutingNotApplied.length > 0) {
    limitations.push(
      `Muting could not be applied for ${containers.mutingNotApplied.length} permission set(s) — group-scoped denials may be missing from the offline side.`,
    );
  }
  if (!user.isActive) {
    limitations.push(
      'The subject user is INACTIVE. The platform still reports declared entity access; it is not a statement that the user can log in.',
    );
  }

  const c = parity.counts;
  const interpretation =
    c.offlineOverstates > 0
      ? `OFFLINE OVERSTATES on ${c.offlineOverstates} (object, verb) pair(s): the offline engine reports access the platform denies. This is the dangerous direction — treat the offline answer as WRONG for those pairs until the grant model is fixed. Also ${c.offlineUnderstates} understatement(s), ${c.agree} platform-confirmed, ${c.unknown} unknown.`
      : c.offlineUnderstates > 0
        ? `The offline engine UNDERSTATES on ${c.offlineUnderstates} (object, verb) pair(s): the platform grants access the offline answer misses. Expected — computeEffectiveGrants never expands permission dependencies, and blanket ViewAllData / ModifyAllData is invisible to per-object grant edges. No overstatements. ${c.agree} platform-confirmed, ${c.unknown} unknown.`
        : parity.fullAgreement
          ? `Platform CONFIRMED every one of the ${c.agree} adjudicated (object, verb) pair(s) across the ${COMPARABLE_VERBS.length} 1:1-mapped verbs. The ${c.unknown} unknown pair(s) were NOT confirmed — they were not comparable.`
          : `No disagreement found, but agreement is NOT complete: ${c.agree} pair(s) confirmed and ${c.unknown} unknown (unmapped verbs, objects the platform did not answer for, or objects the vault does not model). Do not read this as "the offline engine is verified".`;

  const trust = oracleTrust(ctx, queriedAt, limitations);

  const base: Omit<LiveAccessOracleOutput, 'rendered' | 'evidenceEnvelope'> = {
    user,
    objects,
    offlineContainers: containers,
    platformRead,
    parity,
    glossary: {
      verdicts: PARITY_VERDICT_GLOSSARY,
      unknownReasons: PARITY_UNKNOWN_GLOSSARY,
    },
    detailTruncated: false,
    interpretation,
    disclosure: ACCESS_ORACLE_DISCLOSURE,
    boundaries: ACCESS_ORACLE_BOUNDARIES,
    trust,
  };

  const evidenceEnvelope = buildOracleEnvelope({
    parity,
    containers,
    platformRead,
    trust,
  });

  // Byte guard, measured over the WHOLE payload (envelope included — a run
  // where every verb disagrees puts one claim per disagreement in there, which
  // is the same order of magnitude as the per-object detail). The COUNTS, the
  // two disagreement lists, the unanswered list and the verb-mapping table are
  // load-bearing and always survive; only the per-object verb detail is
  // droppable, and dropping it is DISCLOSED (`detailTruncated`), never silent.
  const withEnvelope: Omit<LiveAccessOracleOutput, 'rendered'> = {
    ...base,
    evidenceEnvelope,
  };
  const fitted: Omit<LiveAccessOracleOutput, 'rendered'> =
    Buffer.byteLength(JSON.stringify(withEnvelope), 'utf8') > ACCESS_ORACLE_BYTE_BUDGET
      ? {
          ...withEnvelope,
          parity: { ...parity, objects: [] },
          detailTruncated: true,
        }
      : withEnvelope;

  const data: LiveAccessOracleOutput = {
    ...fitted,
    rendered: renderOracleMarkdown(fitted),
  };

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
