/**
 * Opt-in read-only live org plane (v4.0 R5).
 *
 * Disabled unless `SFI_LIVE_PLANE_ENABLED=1` or the caller passes
 * `liveEnabled: true`. Never falls back to vault data on failure.
 */

import type { McpError, McpResponse, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import {
  mdTable,
  renderFieldPopulationMarkdown,
  renderInactiveUsersMarkdown,
  renderLiveCountMarkdown,
  renderTrustFooter,
} from '../answer-render.js';
import {
  grantLiveConsent,
  hasLiveConsent,
  listConsentedOrgs,
  revokeLiveConsent,
} from '../live-consent.js';
import type { Context } from '../server.js';

import { renderHybridStalenessWarning, type HybridStaleness } from './hybrid-trust.js';
// CR-09 leaf extraction: the raw execution primitives moved to live-exec.ts (a
// dependency-free leaf) so live-session.ts can import them WITHOUT pulling in
// this handler module — breaking the would-be live-plane <-> live-session cycle
// and letting THIS module import the budgeted seam (runLiveQuery / runLiveRest)
// from live-session.ts below. Re-exported from here so every existing import
// path (`runSfJson`/`apiPath`/`redactSecrets`/... FROM './live-plane.js') and
// the public barrel keep resolving unchanged.
// Only the leaf symbols this module's body still references are imported; the
// rest (apiPath/getLiveAuth/restGet/runSfJson) are re-exported below for
// back-compat without being pulled into scope (avoids unused-import lint).
import { LIVE_PLANE_DISCLOSURE, nodeExecFile, redactSecrets } from './live-exec.js';
// The single budgeted/consented/cached seam. Importing it here (now acyclic via
// the leaf above) is what routes EVERY live read in this module through the
// per-session query budget (CR-09).
import { runLiveQuery, runLiveRest } from './live-session.js';
import {
  scanSoqlForPicklistMismatches,
  type PicklistLiteralMismatch,
} from './picklist-literal-check.js';

// Re-export the leaf primitives so every existing import path that pulls them
// FROM './live-plane.js' (live-session.ts, the public barrel, the test suites)
// keeps resolving unchanged after the CR-09 leaf extraction.
export {
  apiPath,
  getLiveAuth,
  LIVE_PLANE_DISCLOSURE,
  redactSecrets,
  restGet,
  runSfJson,
} from './live-exec.js';

const MAX_SAMPLE_ROWS = 200;
/** Trim sampled records so the serialized response stays under the global
 *  MAX_RESPONSE_BYTES (~45 KB) guard. The caller controls the projection width
 *  (a wide SELECT × 200 rows can serialize to hundreds of KB), so a row cap
 *  alone can't bound bytes — this byte budget can. */
const SAMPLE_BYTE_BUDGET = 36_000;

/**
 * Row cap for the human-readable markdown table a live tool renders in its
 * `rendered` field — the structured `data` always carries the FULL set, the
 * table is just a preview. Was an inline `slice(0, 50)` repeated across eight
 * live handlers (stale_records, recent_activity, duplicate_check,
 * owner_breakdown, folder_access, email_template_usage, group_count,
 * org_history); named here so the preview cap has one source of truth (P10-B1).
 */
const LIVE_TABLE_ROW_CAP = 50;

const liveEnabledSchema = z.object({
  liveEnabled: z.boolean().optional(),
});

export const isLivePlaneEnabled = (input?: boolean): boolean => {
  if (input === true) return true;
  const env = process.env.SFI_LIVE_PLANE_ENABLED;
  return env === '1' || env === 'true';
};

const liveTrust = (queriedAt: string): TrustSummary => ({
  provenance: 'live_org',
  confidence: 'declared',
  freshness: { liveQueriedAt: queriedAt },
  completeness: { status: 'unknown' },
  limitations: [LIVE_PLANE_DISCLOSURE],
});

const resolveOrg = (ctx: Context, orgAlias?: string): string =>
  orgAlias?.trim() || ctx.manifest.sourceOrg;

/** Why the live plane is (or isn't) allowed to run for an org. */
export type LiveAccessSource = 'param' | 'env' | 'consent' | 'none';

export interface LiveAccessDecision {
  readonly allowed: boolean;
  readonly source: LiveAccessSource;
}

/**
 * Decide whether the read-only live plane may run for `org`. Three ways in,
 * checked in order: an explicit per-call `liveEnabled: true`, the
 * `SFI_LIVE_PLANE_ENABLED` env, or standing one-time consent persisted for the
 * org. Fail-closed — no match means not allowed; never auto-grants.
 */
export const resolveLiveAccess = async (
  org: string,
  inputLiveEnabled?: boolean,
): Promise<LiveAccessDecision> => {
  // P13-REMOTE-http: over HTTP the live plane is HARD-DISABLED regardless of
  // params, env, or the HOST machine's standing consent — a remote caller
  // must never spend the host's Salesforce API budget or reach its org.
  // Pinned by test, not by documentation.
  if (process.env['SFI_TRANSPORT'] === 'http') return { allowed: false, source: 'none' };
  if (inputLiveEnabled === true) return { allowed: true, source: 'param' };
  if (isLivePlaneEnabled()) return { allowed: true, source: 'env' };
  if (await hasLiveConsent(org)) return { allowed: true, source: 'consent' };
  return { allowed: false, source: 'none' };
};

/** Structured fail-closed error naming the org + the one-time grant path. */
const liveConsentRequiredError = (org: string): McpError => ({
  kind: 'invalid-query',
  message:
    `Live org plane is not enabled for '${org}'. It is read-only, but it queries your live ` +
    `org, so it needs explicit one-time consent. Grant it with sfi.live_consent { grant: true } ` +
    `(persists for future sessions; still read-only), pass liveEnabled: true for a single call, ` +
    `or set SFI_LIVE_PLANE_ENABLED=1.`,
});

/**
 * Resolve the target org and confirm the live plane may run for it. Replaces
 * the old "isLivePlaneEnabled then resolveOrg" pair at the top of every live
 * handler, so per-org consent is honored uniformly and fail-closed.
 */
export const gateLive = async (
  ctx: Context,
  input: {
    readonly liveEnabled?: boolean | undefined;
    readonly orgAlias?: string | undefined;
  },
): Promise<Result<string, McpError>> => {
  const org = resolveOrg(ctx, input.orgAlias);
  const access = await resolveLiveAccess(org, input.liveEnabled);
  if (!access.allowed) return err(liveConsentRequiredError(org));
  return ok(org);
};

// ---------------------------------------------------------------------------
// sfi.live_describe
// ---------------------------------------------------------------------------

export const liveDescribeInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  orgAlias: z.string().min(1).optional(),
});

export type LiveDescribeInput = z.infer<typeof liveDescribeInputSchema>;

export interface LiveDescribeOutput {
  readonly objectApiName: string;
  readonly describe: unknown;
  readonly trust: TrustSummary;
}

export const liveDescribeHandler = async (
  ctx: Context,
  input: LiveDescribeInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveDescribeOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = resolveOrg(ctx, input.orgAlias);
  const queriedAt = new Date().toISOString();
  // CR-09: budgeted/cached describe read (one unit per org call / cache miss).
  const parsed = await runLiveQuery(
    org,
    ['sobject', 'describe', '--sobject', input.objectApiName],
    exec,
  );
  if (!parsed.ok) return parsed;
  const payload = parsed.value.value as { result?: unknown };
  return ok({
    data: {
      objectApiName: input.objectApiName,
      describe: payload.result ?? payload,
      trust: liveTrust(queriedAt),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.live_count
// ---------------------------------------------------------------------------

export const liveCountInputSchema = liveEnabledSchema.extend({
  // Either `soql` (a SELECT COUNT() query) OR `objectApiName` (count every row
  // of that object). Both optional at the schema level; the handler requires
  // exactly one and turns objectApiName into `SELECT COUNT() FROM <object>`.
  soql: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveCountInput = z.infer<typeof liveCountInputSchema>;

/** Salesforce object API name: a letter then letters/digits/underscores (covers `__c`/`__mdt`). */
const OBJECT_API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Resolve the COUNT() SOQL to run: the caller's `soql` verbatim, or one built
 * from `objectApiName`. Errors when neither is supplied, or when a supplied
 * objectApiName isn't a safe API name (guards SOQL interpolation).
 */
const resolveCountSoql = (input: LiveCountInput): Result<string, McpError> => {
  if (input.soql !== undefined) return ok(input.soql);
  if (input.objectApiName !== undefined) {
    if (!OBJECT_API_NAME_RE.test(input.objectApiName)) {
      return err({
        kind: 'invalid-query',
        message: `objectApiName "${input.objectApiName}" is not a valid Salesforce object API name.`,
        path: 'objectApiName',
      });
    }
    return ok(`SELECT COUNT() FROM ${input.objectApiName}`);
  }
  return err({
    kind: 'invalid-query',
    message:
      'live_count needs either `soql` (a SELECT COUNT() query) or `objectApiName`.',
    path: 'soql',
  });
};

export interface LiveCountOutput {
  readonly count: number;
  readonly soql: string;
  readonly trust: TrustSummary;
  readonly rendered: string;
  /**
   * Present when a WHERE picklist literal does not match any DEFINED picklist
   * value on its field. A count of 0 (or any count) filtered on a non-existent
   * value is a VALUE MISMATCH, not proof those records do not exist — these
   * notes name the real values and near-match suggestions so the caller never
   * reads the artifact count as ground truth. Absent when every literal matches.
   */
  readonly picklistMismatches?: readonly PicklistLiteralMismatch[];
}

const assertCountSoql = (soql: string): Result<string, McpError> => {
  const normalized = soql.trim().replace(/\s+/g, ' ');
  if (!/^select\s+count\s*\(/i.test(normalized)) {
    return err({
      kind: 'invalid-query',
      message: 'live_count accepts only SELECT COUNT() SOQL queries.',
      path: 'soql',
    });
  }
  return ok(normalized);
};

/** Pull the FROM object API name from a SELECT statement, or `null`. */
const fromObjectOf = (soql: string): string | null => {
  const m = /\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(soql);
  return m === null || m[1] === undefined ? null : m[1];
};

/**
 * Pre-validate the WHERE picklist literals in a live SOQL against the vault's
 * known picklist values. A literal that matches no DEFINED value on its field
 * makes a determinate 0 count (or empty sample) a VALUE MISMATCH artifact, not
 * evidence of zero matching records — so we surface the real values and
 * near-match suggestions as disclosures. Offline + best-effort: only fields on
 * the statement's single FROM object are checked (no relationship traversal),
 * and a field absent from the vault or without an inline picklist definition is
 * silently skipped. Never blocks the query; only augments the result.
 */
const collectPicklistMismatches = async (
  ctx: Context,
  soql: string,
): Promise<readonly PicklistLiteralMismatch[]> => {
  // No graph wired (e.g. a count-only context) ⇒ nothing to validate against.
  if (ctx.graph === undefined || ctx.graph === null) return [];
  const fromObject = fromObjectOf(soql);
  if (fromObject === null) return [];
  return scanSoqlForPicklistMismatchesSync(ctx, soql, fromObject);
};

/**
 * Synchronous-friendly wrapper: gather every referenced field's picklist values
 * up front (one graph read per distinct field), then run the pure scanner.
 */
const scanSoqlForPicklistMismatchesSync = async (
  ctx: Context,
  soql: string,
  fromObject: string,
): Promise<readonly PicklistLiteralMismatch[]> => {
  const cache = new Map<string, unknown>();
  // Collect each referenced direct field once (skip relationship paths — only a
  // direct `Object.Field` picklist can be resolved from the vault here).
  const fieldRefs = new Set<string>();
  const eqRe = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\bIN\b)/gi;
  for (let m = eqRe.exec(soql); m !== null; m = eqRe.exec(soql)) {
    const ref = m[1];
    if (ref !== undefined && !ref.includes('.')) fieldRefs.add(ref);
  }
  for (const field of fieldRefs) {
    const r = await getNodeById(ctx.graph, `CustomField:${fromObject}.${field}`);
    cache.set(field, r.ok && r.value ? r.value.properties['picklistValues'] : null);
  }
  return scanSoqlForPicklistMismatches(soql, (ref) =>
    ref.includes('.') ? null : cache.get(ref) ?? null,
  );
};

export const liveCountHandler = async (
  ctx: Context,
  input: LiveCountInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveCountOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const soqlResult = resolveCountSoql(input);
  if (!soqlResult.ok) return soqlResult;
  const soqlCheck = assertCountSoql(soqlResult.value);
  if (!soqlCheck.ok) return soqlCheck;
  const org = resolveOrg(ctx, input.orgAlias);
  const queriedAt = new Date().toISOString();
  // CR-09: budgeted/cached count read (one unit per org call / cache miss).
  const parsed = await runLiveQuery(
    org,
    ['data', 'query', '--query', soqlCheck.value],
    exec,
  );
  if (!parsed.ok) return parsed;
  const payload = parsed.value.value as {
    result?: { totalSize?: number; records?: readonly { expr0?: number }[] };
  };
  const count =
    payload.result?.totalSize ??
    payload.result?.records?.[0]?.expr0 ??
    0;
  const mismatches = await collectPicklistMismatches(ctx, soqlCheck.value);
  const countData = {
    count,
    soql: soqlCheck.value,
    trust: liveTrust(queriedAt),
  };
  const baseRendered = renderLiveCountMarkdown(countData);
  const rendered =
    mismatches.length > 0
      ? `${baseRendered}\n\n${mismatches.map((m) => `> ⚠️ ${m.disclosure}`).join('\n')}`
      : baseRendered;
  return ok({
    data: {
      ...countData,
      rendered,
      ...(mismatches.length > 0 ? { picklistMismatches: mismatches } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.live_stale_check  (P5-stale-detection)
// ---------------------------------------------------------------------------

export const liveStaleCheckInputSchema = liveEnabledSchema.extend({
  orgAlias: z.string().min(1).optional(),
});

export type LiveStaleCheckInput = z.infer<typeof liveStaleCheckInputSchema>;

/**
 * Metadata types queried for "modified since the vault refresh" staleness.
 * All are Tooling-API-queryable with a `LastModifiedDate`. A type the org's
 * Tooling API rejects (rare) is skipped into `erroredTypes` rather than failing
 * the whole check.
 */
/**
 * The Tooling-API-queryable types the staleness check compares against the
 * vault's `refreshedAt`. Exported so the fleet drift sweep
 * (`fleet_drift_ranking`) runs the SAME set of checks per org as
 * `live_stale_check` does for one org, without drift.
 */
export const STALE_CHECK_TYPES = [
  'ApexClass',
  'ApexTrigger',
  'ValidationRule',
  'Layout',
  'Flow',
  'CustomField',
  // P13-WATCH-sweep widening — closes the permission-drift hole (a Profile or
  // PermissionSet edited in the org silently invalidated access answers) and
  // covers the UI/record-type surfaces. A type the org's Tooling API rejects
  // lands in erroredTypes honestly, never fatal.
  'CustomObject',
  'Profile',
  'PermissionSet',
  'PermissionSetGroup',
  'SharingRules',
  'FlexiPage',
  'RecordType',
  'CustomApplication',
  'CustomTab',
] as const;

/** Strict ISO-8601 UTC timestamp guard for the SOQL datetime literal. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface LiveStaleCheckOutput {
  readonly refreshedAt: string;
  /** True when ANY checked type has a component modified after the vault refresh. */
  readonly orgAheadOfVault: boolean;
  readonly totalChangedSinceRefresh: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly checkedTypes: readonly string[];
  /** Types whose Tooling-API query errored (skipped, not counted). */
  readonly erroredTypes: readonly string[];
  readonly interpretation: string;
  readonly trust: TrustSummary;
  readonly boundaries: readonly string[];
}

const LIVE_STALE_BOUNDARIES: readonly string[] = Object.freeze([
  'Compares the vault\'s refreshedAt against a LIVE Tooling-API query for components modified since; requires the live plane (SFI_LIVE_PLANE_ENABLED or liveEnabled:true). Read-only; does not mutate the org or the vault.',
  'Counts modifications for the Tooling-queryable types (ApexClass, ApexTrigger, ValidationRule, Layout, Flow, CustomField, CustomObject, Profile, PermissionSet, PermissionSetGroup, SharingRules, FlexiPage, RecordType, CustomApplication, CustomTab — types the org rejects land in erroredTypes). Other metadata families are NOT checked, so orgAheadOfVault:false means "none of the checked types drifted", not "nothing in the org changed". Run /sfi-refresh when staleness matters.',
]);

/** The staleness counts plus the per-type detail the `live_stale_check` tool surfaces. */
export interface VaultStalenessResult extends HybridStaleness {
  readonly byType: Readonly<Record<string, number>>;
  /** Types whose Tooling-API query errored (skipped, not counted). */
  readonly erroredTypes: readonly string[];
}

/**
 * P6-stale-guard-hybrid — the reusable "is the org ahead of the vault?" check,
 * factored out of {@link liveStaleCheckHandler} so any HYBRID answer can lead
 * with a drift warning instead of silently narrating a fresh live count against
 * a stale vault structure. Counts, per type, the components with a
 * `LastModifiedDate` after the vault's `refreshedAt` via the Tooling API. The
 * caller is responsible for the consent gate; this function only queries.
 *
 * Returns a {@link HybridStaleness} (with `warning` pre-rendered) plus the
 * per-type detail. A type the org's Tooling API rejects is recorded in
 * `erroredTypes` and skipped, never fatal.
 */
export const checkVaultStaleness = async (
  org: string,
  refreshedAt: string,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<VaultStalenessResult, McpError>> => {
  if (typeof refreshedAt !== 'string' || !ISO_TIMESTAMP_RE.test(refreshedAt)) {
    return err({
      kind: 'internal',
      message: `vault manifest refreshedAt is missing or not an ISO timestamp ('${String(refreshedAt)}') — cannot build the staleness query.`,
    });
  }
  // SOQL accepts a datetime literal without milliseconds; trim them.
  const sinceLiteral = refreshedAt.replace(/\.\d+Z$/, 'Z');

  const byType: Record<string, number> = {};
  const checkedTypes: string[] = [];
  const erroredTypes: string[] = [];
  let total = 0;
  for (const type of STALE_CHECK_TYPES) {
    const soql = `SELECT Id FROM ${type} WHERE LastModifiedDate > ${sinceLiteral}`;
    // CR-09: budgeted/cached per-type Tooling read (the `--use-tooling-api` flag
    // is part of the args vector, so it is preserved AND keys the cache distinctly
    // from a non-Tooling query of the same SOQL). A failure — including a
    // budget-exhausted stop mid-loop — records the type into erroredTypes (the
    // existing graceful per-type degrade) instead of aborting the whole check.
    const parsed = await runLiveQuery(
      org,
      ['data', 'query', '--query', soql, '--use-tooling-api'],
      exec,
    );
    if (!parsed.ok) {
      erroredTypes.push(type);
      continue;
    }
    const totalSize =
      (parsed.value.value as { result?: { totalSize?: number } }).result?.totalSize ?? 0;
    byType[type] = totalSize;
    checkedTypes.push(type);
    total += totalSize;
  }

  const core = { vaultStale: total > 0, driftCount: total, checkedTypes };
  return ok({
    ...core,
    warning: renderHybridStalenessWarning({ ...core, warning: null }),
    byType,
    erroredTypes,
  });
};

/**
 * `sfi.live_stale_check` — Tooling-API "is the org ahead of the vault?"
 * detection (P5-stale-detection). For each checked type, counts components with
 * `LastModifiedDate` after the vault's `refreshedAt`. A non-zero total means the
 * vault is stale relative to the org for that type.
 */
export const liveStaleCheckHandler = async (
  ctx: Context,
  input: LiveStaleCheckInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveStaleCheckOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = resolveOrg(ctx, input.orgAlias);
  const refreshedAt = ctx.manifest.refreshedAt;
  const queriedAt = new Date().toISOString();

  const stale = await checkVaultStaleness(org, refreshedAt, exec);
  if (!stale.ok) return stale;
  const { byType, checkedTypes, erroredTypes, driftCount: total } = stale.value;

  const orgAheadOfVault = stale.value.vaultStale;
  // CR-09: each of the 15 STALE_CHECK_TYPES is now ONE budgeted live query, so a
  // type can land in erroredTypes either because the org rejected the Tooling
  // query OR because the per-session live-query budget ran out mid-loop. Name
  // the un-checked types explicitly so a skipped type is never read as
  // "not drifted". (The interpretation reports the REAL checkedTypes count
  // rather than a hard-coded 6, which understated the 15 actually checked.)
  const erroredNote =
    erroredTypes.length > 0
      ? ` ${erroredTypes.length} type(s) were not checked (${erroredTypes.join(', ')}) — the org rejected those Tooling queries, or the live-query budget ran out mid-check (raise SFI_LIVE_QUERY_BUDGET or start a new session and re-run).`
      : '';
  const interpretation = orgAheadOfVault
    ? `Org is AHEAD of the vault: ${total} component(s) across ${checkedTypes.length} checked type(s) were modified after the last refresh (${refreshedAt}). The vault — and any answer grounded in it — may be stale. Run /sfi-refresh.${erroredNote}`
    : `No drift detected for the ${checkedTypes.length} checked type(s) since ${refreshedAt}; other metadata families are not checked.${erroredNote}`;

  return ok({
    data: {
      refreshedAt,
      orgAheadOfVault,
      totalChangedSinceRefresh: total,
      byType,
      checkedTypes,
      erroredTypes,
      interpretation,
      trust: liveTrust(queriedAt),
      boundaries: LIVE_STALE_BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.live_sample
// ---------------------------------------------------------------------------

export const liveSampleInputSchema = liveEnabledSchema.extend({
  soql: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_SAMPLE_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveSampleInput = z.infer<typeof liveSampleInputSchema>;

export interface LiveSampleOutput {
  readonly records: readonly unknown[];
  readonly soql: string;
  readonly rowCount: number;
  readonly capped: boolean;
  readonly trust: TrustSummary;
  /** Present only when rows were dropped to keep the response under the size
   *  limit (a wide projection), distinct from the SOQL row cap. */
  readonly note?: string;
  /**
   * Present when a WHERE picklist literal does not match any DEFINED picklist
   * value on its field — an empty sample filtered on a non-existent value is a
   * VALUE MISMATCH, not proof those records do not exist. Absent when every
   * literal matches. See {@link LiveCountOutput.picklistMismatches}.
   */
  readonly picklistMismatches?: readonly PicklistLiteralMismatch[];
}

const capSampleSoql = (
  soql: string,
  limit: number,
): string => {
  const trimmed = soql.trim().replace(/;\s*$/, '');
  if (/\blimit\s+\d+/i.test(trimmed)) {
    return trimmed.replace(/\blimit\s+\d+/i, `LIMIT ${limit}`);
  }
  return `${trimmed} LIMIT ${limit}`;
};

export const liveSampleHandler = async (
  ctx: Context,
  input: LiveSampleInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveSampleOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const limit = input.limit ?? MAX_SAMPLE_ROWS;
  const org = resolveOrg(ctx, input.orgAlias);
  const queriedAt = new Date().toISOString();
  const soql = capSampleSoql(input.soql, limit);
  // CR-09: budgeted/cached sample read (one unit per org call / cache miss).
  const parsed = await runLiveQuery(org, ['data', 'query', '--query', soql], exec);
  if (!parsed.ok) return parsed;
  const payload = parsed.value.value as {
    result?: { records?: readonly unknown[]; totalSize?: number };
  };
  const fetched = payload.result?.records ?? [];
  const trust = liveTrust(queriedAt);
  // The caller controls the projection width, so the SOQL row cap can't bound
  // bytes — a wide SELECT (e.g. FIELDS(STANDARD)) at the cap serializes to
  // hundreds of KB and would trip the global response guard (a hard failure).
  // Drop trailing rows until the serialized response fits the byte budget.
  const fits = (rows: readonly unknown[]): boolean =>
    Buffer.byteLength(
      JSON.stringify({ records: rows, soql, rowCount: rows.length, capped: true, trust }),
      'utf8',
    ) <= SAMPLE_BYTE_BUDGET;
  let records: readonly unknown[] = fetched;
  let byteTrimmed = false;
  while (records.length > 0 && !fits(records)) {
    records = records.slice(0, Math.floor(records.length * 0.8));
    byteTrimmed = true;
  }
  const mismatches = await collectPicklistMismatches(ctx, soql);
  const data: LiveSampleOutput = {
    records,
    soql,
    rowCount: records.length,
    capped: true,
    trust,
    ...(byteTrimmed
      ? {
          note:
            `Response trimmed to ${records.length} of ${fetched.length} fetched ` +
            `rows to stay within the size limit — narrow the SELECT (fewer fields) ` +
            `or lower \`limit\` to sample more rows at a time.`,
        }
      : {}),
    ...(mismatches.length > 0 ? { picklistMismatches: mismatches } : {}),
  };
  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.live_field_population
// ---------------------------------------------------------------------------

export const liveFieldPopulationInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  fieldApiName: z.string().min(1),
  orgAlias: z.string().min(1).optional(),
});

export type LiveFieldPopulationInput = z.infer<
  typeof liveFieldPopulationInputSchema
>;

export interface LiveFieldPopulationOutput {
  readonly objectApiName: string;
  readonly fieldApiName: string;
  readonly totalCount: number;
  readonly populatedCount: number;
  readonly nullCount: number;
  readonly populationRate: number;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveFieldPopulationHandler = async (
  ctx: Context,
  input: LiveFieldPopulationInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveFieldPopulationOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  resolveOrg(ctx, input.orgAlias);
  // Validate the interpolated names BEFORE building SOQL. This handler hands a
  // raw `soql` string to liveCountHandler, which trusts a provided `soql`
  // verbatim (it only asserts the SELECT COUNT() shape, not the names). Without
  // these checks objectApiName/fieldApiName would reach the query unvalidated —
  // every sibling live handler validates with assertSoqlIdentifier; this one did
  // not (B5 SOQL-injection audit gap).
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const fieldCheck = assertSoqlIdentifier(input.fieldApiName, 'fieldApiName');
  if (!fieldCheck.ok) return fieldCheck;
  const queriedAt = new Date().toISOString();
  const objectName = objectCheck.value;
  const field = fieldCheck.value;

  const totalResult = await liveCountHandler(
    ctx,
    {
      liveEnabled: true,
      soql: `SELECT COUNT() FROM ${objectName}`,
      orgAlias: input.orgAlias,
    },
    exec,
  );
  if (!totalResult.ok) return totalResult;
  const totalCount = totalResult.value.data.count;

  const nullResult = await liveCountHandler(
    ctx,
    {
      liveEnabled: true,
      soql: `SELECT COUNT() FROM ${objectName} WHERE ${field} = null`,
      orgAlias: input.orgAlias,
    },
    exec,
  );
  if (!nullResult.ok) return nullResult;
  const nullCount = nullResult.value.data.count;
  const populatedCount = Math.max(0, totalCount - nullCount);
  const populationRate =
    totalCount === 0 ? 0 : Math.round((populatedCount / totalCount) * 1000) / 1000;

  const popData = {
    objectApiName: objectName,
    fieldApiName: field,
    totalCount,
    populatedCount,
    nullCount,
    populationRate,
    trust: liveTrust(queriedAt),
  };
  return ok({
    data: { ...popData, rendered: renderFieldPopulationMarkdown(popData) },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.live_org_limits
// ---------------------------------------------------------------------------

export const liveOrgLimitsInputSchema = liveEnabledSchema.extend({
  orgAlias: z.string().min(1).optional(),
});

export type LiveOrgLimitsInput = z.infer<typeof liveOrgLimitsInputSchema>;

export interface LiveOrgLimitsOutput {
  readonly limits: unknown;
  readonly trust: TrustSummary;
}

export const liveOrgLimitsHandler = async (
  ctx: Context,
  input: LiveOrgLimitsInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveOrgLimitsOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = resolveOrg(ctx, input.orgAlias);
  const queriedAt = new Date().toISOString();
  // CR-09: a USER-invoked REST limits read counts against the budget (one unit).
  // (The INTERNAL budget cross-check in liveBudgetHandler stays on raw runSfJson
  // so a budget CHECK never spends budget — see live-session.ts.)
  const limitsResult = await runLiveRest(org, '/limits', exec);
  if (!limitsResult.ok) return limitsResult;
  return ok({
    data: {
      limits: limitsResult.value.value,
      trust: liveTrust(queriedAt),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.live_inactive_users
// ---------------------------------------------------------------------------
//
// Reference question Q4 — "who hasn't logged in 30 days?" — the license-
// reclamation / dormant-account question. LastLoginDate is runtime state that
// lives ONLY in the org, never in the offline vault, so this is inherently a
// live-plane capability. Active users only by default (an inactive user already
// can't log in), Standard (human) user type by default (integration/system
// users never "log in" and would be noise), both overridable.
//
// Size: the response ships BOTH the structured `users[]` and a `rendered`
// markdown table (which re-serializes every row), so a wide page costs roughly
// double. The default detail page is therefore well below the hard cap, and a
// per-response byte budget trims the slice further so the result never trips the
// global ~45 KB MCP response guard. `totalInactive` is always the true count, so
// a trimmed page never understates it.

const MAX_INACTIVE_USER_ROWS = 500;
const DEFAULT_INACTIVE_USER_ROWS = 100;
/** Keep the serialized `data` (structured rows + rendered table) under the
 *  global MAX_RESPONSE_BYTES (~45 KB) guard, with headroom for the wrapper. */
const INACTIVE_USERS_BYTE_BUDGET = 36_000;
const DEFAULT_INACTIVE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export const liveInactiveUsersInputSchema = liveEnabledSchema.extend({
  /** Inactivity threshold in days (default 30). A user is "inactive" if their
   *  last login is older than this — or they have never logged in. */
  days: z.number().int().min(1).max(3650).optional(),
  /** Include non-Standard user types (integration/system/etc.). Default false
   *  → only human (Standard) users, the usual intent of "who hasn't logged in". */
  includeAllUserTypes: z.boolean().optional(),
  /** Max detail rows returned (default 100, hard cap 500); a per-response byte
   *  budget may trim the page further. The TOTAL count is always reported
   *  separately, so a capped/trimmed list never understates the count. */
  limit: z.number().int().min(1).max(MAX_INACTIVE_USER_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveInactiveUsersInput = z.infer<
  typeof liveInactiveUsersInputSchema
>;

/** One dormant active user. `daysSinceLogin` is null when they never logged in. */
export interface InactiveUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly profileName: string | null;
  readonly userType: string;
  readonly lastLoginDate: string | null;
  readonly neverLoggedIn: boolean;
  readonly daysSinceLogin: number | null;
}

export interface LiveInactiveUsersOutput {
  /** ISO datetime; users whose last login is before this (or null) are inactive. */
  readonly cutoff: string;
  readonly days: number;
  readonly userTypeFilter: 'Standard' | 'all';
  /** TRUE total of matching inactive users (not just the returned rows). */
  readonly totalInactive: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly users: readonly InactiveUser[];
  readonly trust: TrustSummary;
  readonly rendered: string;
  /** Present only when the detail page was trimmed for response size (not just
   *  by `limit`); `totalInactive` remains the true count. */
  readonly note?: string;
}

interface UserRow {
  readonly Id?: string;
  readonly Name?: string;
  readonly Username?: string;
  readonly UserType?: string;
  readonly LastLoginDate?: string | null;
  readonly Profile?: { readonly Name?: string } | null;
}

/** SOQL datetime literal (no quotes, no millis): `2026-04-29T00:00:00Z`. */
const soqlDateTime = (d: Date): string =>
  d.toISOString().replace(/\.\d{3}Z$/, 'Z');

type InactiveUsersBase = Pick<
  LiveInactiveUsersOutput,
  'cutoff' | 'days' | 'userTypeFilter' | 'totalInactive' | 'trust'
>;

/** Trim the detail rows so the fully-serialized `data` (the structured `users[]`
 *  AND the `rendered` markdown table, which re-serializes each row) stays under
 *  INACTIVE_USERS_BYTE_BUDGET. The true total is reported separately, so a
 *  byte-trimmed page never understates the count — it only shows fewer rows. */
const fitInactiveUsers = (
  base: InactiveUsersBase,
  allUsers: readonly InactiveUser[],
): {
  returned: number;
  capped: boolean;
  users: readonly InactiveUser[];
  rendered: string;
  byteTrimmed: boolean;
} => {
  let slice: readonly InactiveUser[] = allUsers;
  let byteTrimmed = false;
  for (;;) {
    const returned = slice.length;
    const capped = base.totalInactive > returned;
    const rendered = renderInactiveUsersMarkdown({ ...base, returned, capped, users: slice });
    const bytes = Buffer.byteLength(
      JSON.stringify({ ...base, returned, capped, users: slice, rendered }),
      'utf8',
    );
    if (bytes <= INACTIVE_USERS_BYTE_BUDGET || slice.length <= 1) {
      return { returned, capped, users: slice, rendered, byteTrimmed };
    }
    slice = slice.slice(0, Math.max(1, Math.floor(slice.length * 0.85)));
    byteTrimmed = true;
  }
};

export const liveInactiveUsersHandler = async (
  ctx: Context,
  input: LiveInactiveUsersInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveInactiveUsersOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = resolveOrg(ctx, input.orgAlias);
  const queriedAt = new Date().toISOString();
  const days = input.days ?? DEFAULT_INACTIVE_DAYS;
  const limit = input.limit ?? DEFAULT_INACTIVE_USER_ROWS;
  const nowMs = Date.now();
  const cutoff = soqlDateTime(new Date(nowMs - days * MS_PER_DAY));
  const userTypeClause = input.includeAllUserTypes
    ? ''
    : " AND UserType = 'Standard'";
  const where = `IsActive = true AND (LastLoginDate < ${cutoff} OR LastLoginDate = null)${userTypeClause}`;

  // True total first (honest count even when the detail list is capped).
  const countResult = await liveCountHandler(
    ctx,
    {
      liveEnabled: true,
      soql: `SELECT COUNT() FROM User WHERE ${where}`,
      orgAlias: input.orgAlias,
    },
    exec,
  );
  if (!countResult.ok) return countResult;
  const totalInactive = countResult.value.data.count;

  // Detail rows, oldest-dormant first (nulls — never logged in — first).
  const detailSoql =
    `SELECT Id, Name, Username, UserType, Profile.Name, LastLoginDate ` +
    `FROM User WHERE ${where} ` +
    `ORDER BY LastLoginDate ASC NULLS FIRST LIMIT ${limit}`;
  // CR-09: route the detail read through the budget too — the count above already
  // routes via liveCountHandler, so this tool decrements by exactly 2 (count +
  // detail), no residual bypass and no double-count.
  const parsed = await runLiveQuery(org, ['data', 'query', '--query', detailSoql], exec);
  if (!parsed.ok) return parsed;
  const payload = parsed.value.value as { result?: { records?: readonly UserRow[] } };
  const rows = payload.result?.records ?? [];

  const users: InactiveUser[] = rows.map((r) => {
    const lastLoginDate = r.LastLoginDate ?? null;
    const daysSinceLogin =
      lastLoginDate === null
        ? null
        : Math.floor((nowMs - Date.parse(lastLoginDate)) / MS_PER_DAY);
    return {
      id: String(r.Id ?? ''),
      name: String(r.Name ?? ''),
      username: String(r.Username ?? ''),
      profileName: r.Profile?.Name ?? null,
      userType: String(r.UserType ?? ''),
      lastLoginDate,
      neverLoggedIn: lastLoginDate === null,
      daysSinceLogin,
    };
  });

  const base: InactiveUsersBase = {
    cutoff,
    days,
    userTypeFilter: (input.includeAllUserTypes ? 'all' : 'Standard') as 'Standard' | 'all',
    totalInactive,
    trust: liveTrust(queriedAt),
  };
  const fit = fitInactiveUsers(base, users);
  const data: LiveInactiveUsersOutput = {
    ...base,
    returned: fit.returned,
    capped: fit.capped,
    users: fit.users,
    rendered: fit.rendered,
    ...(fit.byteTrimmed
      ? {
          note:
            `Detail rows trimmed to ${fit.returned} to stay within the response ` +
            `size limit; totalInactive (${totalInactive}) is the true count.`,
        }
      : {}),
  };
  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.live_license_usage
// ---------------------------------------------------------------------------
//
// License / cost optimization — "which paid licenses are provisioned but
// unused, and which seats are reclaimable?". Three live reads, all runtime
// state that lives only in the org:
//   1. UserLicense — provisioned vs used per license type (over-provisioning).
//   2. PermissionSetLicense — same, for PSLs.
//   3. Reclaimable seats — active Standard users dormant past `inactiveDays`,
//      grouped by their user license (the money question: paid seats nobody
//      is using). Reuses the inactive-users proxy, defaulting to a more
//      conservative 90-day window because deprovisioning is irreversible.
// Read-only: this tool NEVER deprovisions or changes a license assignment.

const DEFAULT_LICENSE_INACTIVE_DAYS = 90;
const MAX_RECLAIM_ROWS = 200;

export const LICENSE_USAGE_DISCLOSURE =
  'License counts are live UserLicense / PermissionSetLicense state. "Reclaimable seats" is a PROXY — it groups active users who have not logged in within the window by their license; it does NOT measure actual feature usage, and some dormant seats are held intentionally (seasonal staff, service/integration accounts mis-typed as Standard, compliance holds). Per-feature-license usage (Marketing User, Knowledge User, etc.) is NOT covered. This tool is READ-ONLY: it never deprovisions or reassigns a license — verify each seat before reclaiming it.';

export const liveLicenseUsageInputSchema = liveEnabledSchema.extend({
  /** Dormancy window for reclaimable seats, in days (default 90). */
  inactiveDays: z.number().int().min(1).max(3650).optional(),
  /** Max reclaimable-seat groups returned (default + hard cap 200). */
  limit: z.number().int().min(1).max(MAX_RECLAIM_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveLicenseUsageInput = z.infer<typeof liveLicenseUsageInputSchema>;

/** Per-license utilization. `available`/`utilizationPct` are null when the
 *  license is unlimited (`total` < 0 — Salesforce reports -1 for unlimited). */
export interface LicenseUtilization {
  readonly name: string;
  readonly status: string | null;
  readonly total: number;
  readonly used: number;
  readonly available: number | null;
  readonly utilizationPct: number | null;
  readonly unlimited: boolean;
}

/** Inactive active users holding one license — a reclamation candidate group. */
export interface ReclaimableSeatGroup {
  readonly license: string;
  readonly inactiveUserCount: number;
}

export interface LiveLicenseUsageOutput {
  readonly inactiveDays: number;
  /** ISO datetime; users whose last login is before this (or null) are dormant. */
  readonly cutoff: string;
  readonly licenseUtilization: readonly LicenseUtilization[];
  readonly permissionSetLicenseUtilization: readonly LicenseUtilization[];
  readonly reclaimableSeats: readonly ReclaimableSeatGroup[];
  readonly totalReclaimableInactiveUsers: number;
  readonly disclosure: string;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

interface LicenseRow {
  readonly Name?: string;
  readonly MasterLabel?: string;
  readonly Status?: string | null;
  readonly TotalLicenses?: number | null;
  readonly UsedLicenses?: number | null;
}

interface ReclaimRow {
  readonly licenseName?: string | null;
  readonly seats?: number | null;
}

const toUtilization = (
  rows: readonly LicenseRow[],
  nameKey: 'Name' | 'MasterLabel',
): LicenseUtilization[] =>
  rows.map((r) => {
    const total = Number(r.TotalLicenses ?? 0);
    const used = Number(r.UsedLicenses ?? 0);
    const unlimited = total < 0;
    return {
      name: String(r[nameKey] ?? ''),
      status: r.Status ?? null,
      total,
      used,
      available: unlimited ? null : total - used,
      utilizationPct: unlimited || total <= 0 ? null : Math.round((used / total) * 100),
      unlimited,
    };
  });

const renderLicenseUsageMarkdown = (
  data: Omit<LiveLicenseUsageOutput, 'rendered'>,
): string => {
  const lines: string[] = ['### License usage'];
  const utilRows = (u: readonly LicenseUtilization[]) =>
    u.map((l) => [
      l.name,
      l.used,
      l.unlimited ? '∞' : l.total,
      l.available ?? '—',
      l.utilizationPct === null ? '—' : `${l.utilizationPct}%`,
    ]);
  if (data.licenseUtilization.length > 0) {
    lines.push('', '**User licenses**', '');
    lines.push(
      mdTable(['License', 'Used', 'Total', 'Available', 'Util'], utilRows(data.licenseUtilization)),
    );
  }
  if (data.permissionSetLicenseUtilization.length > 0) {
    lines.push('', '**Permission-set licenses**', '');
    lines.push(
      mdTable(
        ['PSL', 'Used', 'Total', 'Available', 'Util'],
        utilRows(data.permissionSetLicenseUtilization),
      ),
    );
  }
  lines.push(
    '',
    `**Reclaimable seats** (active users dormant > ${data.inactiveDays}d): ${data.totalReclaimableInactiveUsers}`,
    '',
  );
  if (data.reclaimableSeats.length > 0) {
    lines.push(
      mdTable(
        ['License', 'Inactive users'],
        data.reclaimableSeats.map((s) => [s.license, s.inactiveUserCount]),
      ),
    );
  }
  lines.push('', renderTrustFooter(data.trust));
  return lines.join('\n');
};

export const liveLicenseUsageHandler = async (
  ctx: Context,
  input: LiveLicenseUsageInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveLicenseUsageOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = resolveOrg(ctx, input.orgAlias);
  const queriedAt = new Date().toISOString();
  const inactiveDays = input.inactiveDays ?? DEFAULT_LICENSE_INACTIVE_DAYS;
  const limit = input.limit ?? MAX_RECLAIM_ROWS;
  const cutoff = soqlDateTime(new Date(Date.now() - inactiveDays * MS_PER_DAY));

  // CR-09: all three license reads route through the budget (decrements 3).
  const licRes = await runLiveQuery(
    org,
    ['data', 'query', '--query', 'SELECT Name, Status, TotalLicenses, UsedLicenses FROM UserLicense ORDER BY Name'],
    exec,
  );
  if (!licRes.ok) return licRes;
  const licPayload = licRes.value.value as { result?: { records?: readonly LicenseRow[] } };
  const licenseUtilization = toUtilization(licPayload.result?.records ?? [], 'Name');

  const pslRes = await runLiveQuery(
    org,
    ['data', 'query', '--query', 'SELECT MasterLabel, Status, TotalLicenses, UsedLicenses FROM PermissionSetLicense ORDER BY MasterLabel'],
    exec,
  );
  if (!pslRes.ok) return pslRes;
  const pslPayload = pslRes.value.value as { result?: { records?: readonly LicenseRow[] } };
  const permissionSetLicenseUtilization = toUtilization(
    pslPayload.result?.records ?? [],
    'MasterLabel',
  );

  // Reclaimable seats: dormant active Standard users grouped by user license.
  const reclaimSoql =
    `SELECT Profile.UserLicense.Name licenseName, COUNT(Id) seats ` +
    `FROM User ` +
    `WHERE IsActive = true AND UserType = 'Standard' ` +
    `AND (LastLoginDate < ${cutoff} OR LastLoginDate = null) ` +
    `GROUP BY Profile.UserLicense.Name ORDER BY COUNT(Id) DESC`;
  const reclaimRes = await runLiveQuery(org, ['data', 'query', '--query', reclaimSoql], exec);
  if (!reclaimRes.ok) return reclaimRes;
  const reclaimPayload = reclaimRes.value.value as {
    result?: { records?: readonly ReclaimRow[] };
  };
  const reclaimRows = reclaimPayload.result?.records ?? [];
  const reclaimableSeats: ReclaimableSeatGroup[] = reclaimRows
    .slice(0, limit)
    .map((r) => ({
      license: r.licenseName === null || r.licenseName === undefined || r.licenseName === ''
        ? 'unknown'
        : String(r.licenseName),
      inactiveUserCount: Number(r.seats ?? 0),
    }));
  const totalReclaimableInactiveUsers = reclaimRows.reduce(
    (sum, r) => sum + Number(r.seats ?? 0),
    0,
  );

  const core = {
    inactiveDays,
    cutoff,
    licenseUtilization,
    permissionSetLicenseUtilization,
    reclaimableSeats,
    totalReclaimableInactiveUsers,
    disclosure: LICENSE_USAGE_DISCLOSURE,
    trust: liveTrust(queriedAt),
  };
  return ok({
    data: { ...core, rendered: renderLicenseUsageMarkdown(core) },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.live_consent
// ---------------------------------------------------------------------------
//
// One-time, per-org opt-in for the read-only live plane. Granting writes a
// local user-level preference (it never touches the org); it is the explicit,
// auditable gate that flips sfi.live_* from fail-closed to allowed for an org.
// The DEFAULT action is to REPORT status — granting requires grant: true and
// revoking requires revoke: true — so a bare call never silently enables
// anything. This is the "one-time consent, never auto-enable" decision in code.

export const liveConsentInputSchema = z.object({
  /** Org alias/username; defaults to the vault's source org. */
  orgAlias: z.string().min(1).optional(),
  /** Grant standing consent for the org (persists across sessions). */
  grant: z.boolean().optional(),
  /** Revoke standing consent for the org. */
  revoke: z.boolean().optional(),
});

export type LiveConsentInput = z.infer<typeof liveConsentInputSchema>;

export interface LiveConsentOutput {
  readonly org: string;
  readonly consented: boolean;
  readonly action: 'granted' | 'revoked' | 'status';
  /** All orgs that currently hold standing consent (normalized keys). */
  readonly consentedOrgs: readonly string[];
  /** Whether SFI_LIVE_PLANE_ENABLED would also enable live regardless of consent. */
  readonly envEnabled: boolean;
  readonly note: string;
  readonly trust: TrustSummary;
}

const consentTrust = (): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'declared',
  freshness: {},
  completeness: { status: 'complete' },
  limitations: [
    'Consent is a local, user-level preference; it never reads or writes the Salesforce org.',
  ],
});

export const liveConsentHandler = async (
  ctx: Context,
  input: LiveConsentInput,
): Promise<Result<McpResponse<LiveConsentOutput>, McpError>> => {
  const org = resolveOrg(ctx, input.orgAlias);

  if (input.grant === true && input.revoke === true) {
    return err({
      kind: 'invalid-query',
      message: 'Pass either grant: true or revoke: true, not both.',
    });
  }

  let action: 'granted' | 'revoked' | 'status' = 'status';
  if (input.grant === true) {
    const granted = await grantLiveConsent(org);
    if (!granted.ok) return err({ kind: 'internal', message: granted.error.message });
    action = 'granted';
  } else if (input.revoke === true) {
    const revoked = await revokeLiveConsent(org);
    if (!revoked.ok) return err({ kind: 'internal', message: revoked.error.message });
    action = 'revoked';
  }

  const consented = await hasLiveConsent(org);
  const consentedOrgs = await listConsentedOrgs();
  const envEnabled = isLivePlaneEnabled();
  const note =
    action === 'granted'
      ? `Live plane enabled for '${org}'. Future sessions can run sfi.live_* against it without re-asking. Still strictly read-only; revoke any time with sfi.live_consent { revoke: true }.`
      : action === 'revoked'
        ? `Live plane consent removed for '${org}'. sfi.live_* fail-closed for it until re-granted.`
        : consented
          ? `Live plane is enabled for '${org}' (one-time consent on file).`
          : envEnabled
            ? `Live plane is enabled globally via SFI_LIVE_PLANE_ENABLED; no per-org consent on file for '${org}'.`
            : `Live plane is NOT enabled for '${org}'. To allow read-only live queries, grant one-time consent with sfi.live_consent { grant: true } — it persists and never mutates the org.`;

  return ok({
    data: { org, consented, action, consentedOrgs, envEnabled, note, trust: consentTrust() },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ===========================================================================
// Wave 1 — operational-analytics live tools (the owner's gap catalog + health).
// Each is read-only and RESILIENT: a sub-query against an object the org does
// not expose (Report/EmailTemplate/FlowInterview vary by edition/feature) is
// reported as "unavailable", never propagated as an internal error — so the
// regression net never sees a BUG.
// ===========================================================================

interface LiveQueryResult {
  readonly available: boolean;
  readonly records: readonly Record<string, unknown>[];
  readonly total: number;
  readonly reason?: string;
}

/**
 * Run a SOQL query, converting any failure into `available:false` (never throws).
 *
 * CR-09: routes through the budgeted/cached seam {@link runLiveQuery}, so every
 * one of the ~31 Wave-1 sites that flow through this helper (group_count,
 * stale_records, recent_activity, aggregate, duplicate_check, owner_breakdown,
 * report_usage, folder_access, email_template_usage, org_health SOQL signals,
 * data_skew, setup_audit_trail, security_exposure) decrements the per-session
 * budget exactly once per org query / cache miss. A budget-exhausted stop is
 * surfaced as a normal `available:false` with the budget reason, so the existing
 * per-signal graceful-degrade (org_health/security_exposure) and the hard-fail
 * handlers (which wrap the reason in UNAVAILABLE_ERROR) stay legible rather than
 * 500-ing. The {available, records, total, reason} shape is byte-identical to
 * before.
 */
const liveQuery = async (
  org: string,
  soql: string,
  exec: ExecCommand,
): Promise<LiveQueryResult> => {
  const r = await runLiveQuery(org, ['data', 'query', '--query', soql], exec);
  if (!r.ok) return { available: false, records: [], total: 0, reason: r.error.message };
  const p = r.value.value as {
    result?: { records?: Record<string, unknown>[]; totalSize?: number };
  };
  return {
    available: true,
    records: p.result?.records ?? [],
    total: p.result?.totalSize ?? 0,
  };
};

const MAX_DETAIL_ROWS = 500;
const daysAgoSoql = (days: number): string =>
  new Date(Date.now() - days * MS_PER_DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
const daysSince = (iso: string | null): number | null =>
  iso === null ? null : Math.floor((Date.now() - Date.parse(iso)) / MS_PER_DAY);

const livePlaneVaultState = (ctx: Context) => ({
  sourceTreeHash: ctx.manifest.sourceTreeHash,
  refreshedAt: ctx.manifest.refreshedAt,
});

const UNAVAILABLE_ERROR = (object: string, org: string, reason?: string): McpError => ({
  kind: 'invalid-query',
  message:
    `The ${object} object is not queryable in '${org}' (it may be disabled for this edition/feature). ` +
    (reason ? `Underlying: ${redactSecrets(reason).slice(0, 120)}` : ''),
});

/**
 * CR-09 budget legibility: detect a per-session budget-exhaustion reason coming
 * back from a graceful `liveQuery` (available:false). A multi-signal tool
 * (org_health, security_exposure) swallows available:false into null/n-a, which
 * would otherwise make a budget STOP indistinguishable from "object not
 * queryable for this edition". When this returns true the tool must name the
 * budget in a distinct boundary signal rather than silently dropping the signal.
 * The probe matches the actionable phrase budgetExceededError emits.
 */
const isBudgetExhaustedReason = (reason?: string): boolean =>
  reason !== undefined && /live-query budget exhausted/i.test(reason);

/** The user-facing boundary line for a mid-tool budget stop in a graceful tool. */
const BUDGET_SIGNAL =
  'Live-query budget exhausted mid-read — one or more signals were skipped (shown as n/a, NOT zero). Raise SFI_LIVE_QUERY_BUDGET or start a new session, then re-run.';

/** Reject SOQL injection — only simple unqualified API names (Object, Field__c). */
export const assertSoqlIdentifier = (
  name: string,
  label: string,
): Result<string, McpError> => {
  const trimmed = name.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
    return err({
      kind: 'invalid-query',
      message: `${label} must be a simple Salesforce API name (letters, digits, underscores).`,
      path: label,
    });
  }
  return ok(trimmed);
};

const soqlLiteral = (value: string | number | boolean): string => {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  // Escape backslash BEFORE the quote: order matters — a trailing `\` would make
  // the escaped quote (`\'`) terminate the literal and inject SOQL (backslash-first).
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
};

const MAX_GROUP_BUCKETS = 200;
const DEFAULT_STALE_DAYS = 90;
const DEFAULT_RECENT_DAYS = 7;

// ---------------------------------------------------------------------------
// sfi.live_group_count — value distribution / breakdown on any object+field
// ---------------------------------------------------------------------------
//
// Covers hundreds of "how many X by Y?" questions (Cases by Status, Accounts
// by Industry, Opportunities by Stage) without exposing arbitrary SOQL.

export const liveGroupCountInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  groupByField: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_GROUP_BUCKETS).optional(),
  filterField: z.string().min(1).optional(),
  filterValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveGroupCountInput = z.infer<typeof liveGroupCountInputSchema>;

export interface GroupCountBucket {
  readonly value: string | null;
  readonly count: number;
}
export interface LiveGroupCountOutput {
  readonly objectApiName: string;
  readonly groupByField: string;
  readonly totalRecords: number;
  readonly distinctValues: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly buckets: readonly GroupCountBucket[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveGroupCountHandler = async (
  ctx: Context,
  input: LiveGroupCountInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveGroupCountOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const fieldCheck = assertSoqlIdentifier(input.groupByField, 'groupByField');
  if (!fieldCheck.ok) return fieldCheck;
  if (input.filterField !== undefined) {
    const filterCheck = assertSoqlIdentifier(input.filterField, 'filterField');
    if (!filterCheck.ok) return filterCheck;
    if (input.filterValue === undefined) {
      return err({
        kind: 'invalid-query',
        message: 'filterValue is required when filterField is set.',
        path: 'filterValue',
      });
    }
  }
  const queriedAt = new Date().toISOString();
  const objectName = objectCheck.value;
  const groupField = fieldCheck.value;
  const limit = input.limit ?? 50;
  const whereClause =
    input.filterField !== undefined && input.filterValue !== undefined
      ? ` WHERE ${input.filterField} = ${soqlLiteral(input.filterValue)}`
      : '';

  const totalQ = await liveQuery(org, `SELECT COUNT() FROM ${objectName}${whereClause}`, exec);
  if (!totalQ.available) return err(UNAVAILABLE_ERROR(objectName, org, totalQ.reason));

  const detailQ = await liveQuery(
    org,
    `SELECT ${groupField}, COUNT(Id) cnt FROM ${objectName}${whereClause} GROUP BY ${groupField} ORDER BY COUNT(Id) DESC LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR(objectName, org, detailQ.reason));

  const buckets: GroupCountBucket[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    const raw = r[groupField];
    const countRaw = r.cnt ?? r.expr0;
    return {
      value: raw === undefined || raw === null ? null : String(raw),
      count: Number(countRaw ?? 0),
    };
  });
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    [groupField, 'Count'],
    buckets.map((b) => [b.value ?? '(null)', b.count]),
  );
  const rendered =
    `**${totalQ.total.toLocaleString('en-US')}** ${objectName} records` +
    (whereClause ? ' (filtered)' : '') +
    ` — **${buckets.length}** distinct ${groupField} values shown` +
    (totalQ.total > buckets.reduce((s, b) => s + b.count, 0) ? ' (partial — capped)' : '') +
    `.\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      objectApiName: objectName,
      groupByField: groupField,
      totalRecords: totalQ.total,
      distinctValues: buckets.length,
      returned: buckets.length,
      capped: buckets.length >= limit,
      buckets,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_stale_records — records untouched for N days on any object
// ---------------------------------------------------------------------------

export const liveStaleRecordsInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  staleDays: z.number().int().min(1).max(3650).optional(),
  dateField: z.string().min(1).optional(),
  includeNeverSet: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_SAMPLE_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveStaleRecordsInput = z.infer<typeof liveStaleRecordsInputSchema>;

export interface StaleRecordEntry {
  readonly id: string;
  readonly name: string | null;
  readonly dateValue: string | null;
  readonly daysSinceDate: number | null;
}
export interface LiveStaleRecordsOutput {
  readonly objectApiName: string;
  readonly dateField: string;
  readonly staleDays: number;
  readonly cutoff: string;
  readonly totalStale: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly records: readonly StaleRecordEntry[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveStaleRecordsHandler = async (
  ctx: Context,
  input: LiveStaleRecordsInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveStaleRecordsOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const dateField = input.dateField?.trim() || 'LastModifiedDate';
  const dateCheck = assertSoqlIdentifier(dateField, 'dateField');
  if (!dateCheck.ok) return dateCheck;
  const queriedAt = new Date().toISOString();
  const staleDays = input.staleDays ?? DEFAULT_STALE_DAYS;
  const limit = input.limit ?? MAX_SAMPLE_ROWS;
  const cutoff = daysAgoSoql(staleDays);
  const objectName = objectCheck.value;
  const includeNever = input.includeNeverSet !== false;
  const staleWhere = includeNever
    ? `${dateField} < ${cutoff} OR ${dateField} = null`
    : `${dateField} < ${cutoff}`;

  const totalQ = await liveQuery(
    org,
    `SELECT COUNT() FROM ${objectName} WHERE ${staleWhere}`,
    exec,
  );
  if (!totalQ.available) return err(UNAVAILABLE_ERROR(objectName, org, totalQ.reason));

  const detailQ = await liveQuery(
    org,
    `SELECT Id, Name, ${dateField} FROM ${objectName} WHERE ${staleWhere} ORDER BY ${dateField} ASC NULLS FIRST LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR(objectName, org, detailQ.reason));

  const records: StaleRecordEntry[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    const dateValue = r[dateField] === null || r[dateField] === undefined ? null : String(r[dateField]);
    const d = dateValue === null ? null : daysSince(dateValue);
    return {
      id: String(r.Id ?? ''),
      name: r.Name === undefined || r.Name === null ? null : String(r.Name),
      dateValue,
      daysSinceDate: d,
    };
  });
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Record', dateField, 'Days'],
    records.slice(0, LIVE_TABLE_ROW_CAP).map((r) => [r.name ?? r.id, r.dateValue ?? 'never', r.daysSinceDate ?? '—']),
  );
  const rendered =
    `**${totalQ.total.toLocaleString('en-US')}** ${objectName} records stale ` +
    `(no ${dateField} touch in ${staleDays}+ days${includeNever ? ' or never set' : ''}).\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      objectApiName: objectName,
      dateField,
      staleDays,
      cutoff,
      totalStale: totalQ.total,
      returned: records.length,
      capped: totalQ.total > records.length,
      records,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_recent_activity — recently created or modified records
// ---------------------------------------------------------------------------

export const liveRecentActivityInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  days: z.number().int().min(1).max(365).optional(),
  activity: z.enum(['created', 'modified', 'both']).optional(),
  limit: z.number().int().min(1).max(MAX_SAMPLE_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveRecentActivityInput = z.infer<typeof liveRecentActivityInputSchema>;

export interface RecentActivityEntry {
  readonly id: string;
  readonly name: string | null;
  readonly createdDate: string | null;
  readonly lastModifiedDate: string | null;
}
export interface LiveRecentActivityOutput {
  readonly objectApiName: string;
  readonly days: number;
  readonly activity: 'created' | 'modified' | 'both';
  readonly totalMatching: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly records: readonly RecentActivityEntry[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveRecentActivityHandler = async (
  ctx: Context,
  input: LiveRecentActivityInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveRecentActivityOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const queriedAt = new Date().toISOString();
  const days = input.days ?? DEFAULT_RECENT_DAYS;
  const activity = input.activity ?? 'modified';
  const limit = input.limit ?? 50;
  const objectName = objectCheck.value;
  const whereClause =
    activity === 'created'
      ? `CreatedDate = LAST_N_DAYS:${days}`
      : activity === 'modified'
        ? `LastModifiedDate = LAST_N_DAYS:${days}`
        : `(CreatedDate = LAST_N_DAYS:${days} OR LastModifiedDate = LAST_N_DAYS:${days})`;
  const orderField = activity === 'created' ? 'CreatedDate' : 'LastModifiedDate';

  const totalQ = await liveQuery(
    org,
    `SELECT COUNT() FROM ${objectName} WHERE ${whereClause}`,
    exec,
  );
  if (!totalQ.available) return err(UNAVAILABLE_ERROR(objectName, org, totalQ.reason));

  const detailQ = await liveQuery(
    org,
    `SELECT Id, Name, CreatedDate, LastModifiedDate FROM ${objectName} WHERE ${whereClause} ORDER BY ${orderField} DESC LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR(objectName, org, detailQ.reason));

  const records: RecentActivityEntry[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.Id ?? ''),
      name: r.Name === undefined || r.Name === null ? null : String(r.Name),
      createdDate: r.CreatedDate === undefined || r.CreatedDate === null ? null : String(r.CreatedDate),
      lastModifiedDate:
        r.LastModifiedDate === undefined || r.LastModifiedDate === null ? null : String(r.LastModifiedDate),
    };
  });
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Record', 'Created', 'Modified'],
    records.slice(0, LIVE_TABLE_ROW_CAP).map((r) => [r.name ?? r.id, r.createdDate ?? '—', r.lastModifiedDate ?? '—']),
  );
  const rendered =
    `**${totalQ.total.toLocaleString('en-US')}** ${objectName} records with ${activity} activity in the last ${days} days.\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      objectApiName: objectName,
      days,
      activity,
      totalMatching: totalQ.total,
      returned: records.length,
      capped: totalQ.total > records.length,
      records,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

const buildEqualityWhere = (
  filterField?: string,
  filterValue?: string | number | boolean,
): Result<string, McpError> => {
  if (filterField === undefined) return ok('');
  const filterCheck = assertSoqlIdentifier(filterField, 'filterField');
  if (!filterCheck.ok) return filterCheck;
  if (filterValue === undefined) {
    return err({
      kind: 'invalid-query',
      message: 'filterValue is required when filterField is set.',
      path: 'filterValue',
    });
  }
  return ok(` WHERE ${filterField} = ${soqlLiteral(filterValue)}`);
};

const aggregateCountFromRow = (row: Record<string, unknown>, keys: readonly string[]): number => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null) return Number(v);
  }
  return 0;
};

// ---------------------------------------------------------------------------
// sfi.live_aggregate — MIN/MAX/AVG/SUM on one numeric field
// ---------------------------------------------------------------------------

export const liveAggregateInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  fieldApiName: z.string().min(1),
  filterField: z.string().min(1).optional(),
  filterValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveAggregateInput = z.infer<typeof liveAggregateInputSchema>;

export interface LiveAggregateOutput {
  readonly objectApiName: string;
  readonly fieldApiName: string;
  readonly recordCount: number;
  readonly nonNullCount: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly sum: number | null;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveAggregateHandler = async (
  ctx: Context,
  input: LiveAggregateInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveAggregateOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const fieldCheck = assertSoqlIdentifier(input.fieldApiName, 'fieldApiName');
  if (!fieldCheck.ok) return fieldCheck;
  const whereResult = buildEqualityWhere(input.filterField, input.filterValue);
  if (!whereResult.ok) return whereResult;
  const queriedAt = new Date().toISOString();
  const objectName = objectCheck.value;
  const field = fieldCheck.value;
  const whereClause = whereResult.value;

  const totalQ = await liveQuery(org, `SELECT COUNT() FROM ${objectName}${whereClause}`, exec);
  if (!totalQ.available) return err(UNAVAILABLE_ERROR(objectName, org, totalQ.reason));

  const aggQ = await liveQuery(
    org,
    `SELECT MIN(${field}) minVal, MAX(${field}) maxVal, AVG(${field}) avgVal, SUM(${field}) sumVal, COUNT(${field}) nonNullCnt FROM ${objectName}${whereClause}`,
    exec,
  );
  if (!aggQ.available) return err(UNAVAILABLE_ERROR(objectName, org, aggQ.reason));

  const row = (aggQ.records[0] ?? {}) as Record<string, unknown>;
  const nonNullCount = aggregateCountFromRow(row, ['nonNullCnt', 'expr4']);
  const toNum = (v: unknown): number | null =>
    v === undefined || v === null ? null : Number(v);
  const min = toNum(row.minVal ?? row.expr0);
  const max = toNum(row.maxVal ?? row.expr1);
  const avgRaw = toNum(row.avgVal ?? row.expr2);
  const avg = avgRaw === null ? null : Math.round(avgRaw * 1000) / 1000;
  const sum = toNum(row.sumVal ?? row.expr3);
  const trust = liveTrust(queriedAt);
  const rendered =
    `**${field}** on ${objectName} (${totalQ.total.toLocaleString('en-US')} rows` +
    (whereClause ? ', filtered' : '') +
    `, ${nonNullCount.toLocaleString('en-US')} non-null):\n` +
    `- MIN: **${min ?? 'n/a'}**\n` +
    `- MAX: **${max ?? 'n/a'}**\n` +
    `- AVG: **${avg ?? 'n/a'}**\n` +
    `- SUM: **${sum ?? 'n/a'}**\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      objectApiName: objectName,
      fieldApiName: field,
      recordCount: totalQ.total,
      nonNullCount,
      min,
      max,
      avg,
      sum,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_duplicate_check — duplicate values on one field
// ---------------------------------------------------------------------------

const MAX_DUPLICATE_GROUPS = 100;

export const liveDuplicateCheckInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  fieldApiName: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_DUPLICATE_GROUPS).optional(),
  filterField: z.string().min(1).optional(),
  filterValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveDuplicateCheckInput = z.infer<typeof liveDuplicateCheckInputSchema>;

export interface DuplicateGroup {
  readonly value: string;
  readonly count: number;
  readonly excessRecords: number;
}
export interface LiveDuplicateCheckOutput {
  readonly objectApiName: string;
  readonly fieldApiName: string;
  readonly duplicateGroups: number;
  readonly excessRecords: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly groups: readonly DuplicateGroup[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveDuplicateCheckHandler = async (
  ctx: Context,
  input: LiveDuplicateCheckInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveDuplicateCheckOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const fieldCheck = assertSoqlIdentifier(input.fieldApiName, 'fieldApiName');
  if (!fieldCheck.ok) return fieldCheck;
  const whereResult = buildEqualityWhere(input.filterField, input.filterValue);
  if (!whereResult.ok) return whereResult;
  const queriedAt = new Date().toISOString();
  const objectName = objectCheck.value;
  const field = fieldCheck.value;
  const limit = input.limit ?? 50;
  const baseWhere = whereResult.value;
  const nullGuard = baseWhere ? `${baseWhere} AND ${field} != null` : ` WHERE ${field} != null`;

  const detailQ = await liveQuery(
    org,
    `SELECT ${field}, COUNT(Id) cnt FROM ${objectName}${nullGuard} GROUP BY ${field} HAVING COUNT(Id) > 1 ORDER BY COUNT(Id) DESC LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR(objectName, org, detailQ.reason));

  const groups: DuplicateGroup[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    const count = Number(r.cnt ?? r.expr1 ?? 0);
    return {
      value: String(r[field] ?? ''),
      count,
      excessRecords: Math.max(0, count - 1),
    };
  });
  const excessRecords = groups.reduce((s, g) => s + g.excessRecords, 0);
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    [field, 'Count', 'Excess'],
    groups.slice(0, LIVE_TABLE_ROW_CAP).map((g) => [g.value, g.count, g.excessRecords]),
  );
  const rendered =
    `**${groups.length}** duplicate ${field} value(s) on ${objectName}` +
    ` (${excessRecords.toLocaleString('en-US')} excess records beyond unique values).\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      objectApiName: objectName,
      fieldApiName: field,
      duplicateGroups: groups.length,
      excessRecords,
      returned: groups.length,
      capped: groups.length >= limit,
      groups,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_owner_breakdown — record counts by OwnerId with user names
// ---------------------------------------------------------------------------

const MAX_OWNER_BUCKETS = 100;

export const liveOwnerBreakdownInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_OWNER_BUCKETS).optional(),
  filterField: z.string().min(1).optional(),
  filterValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveOwnerBreakdownInput = z.infer<typeof liveOwnerBreakdownInputSchema>;

export interface OwnerBreakdownEntry {
  readonly ownerId: string;
  readonly ownerName: string | null;
  readonly count: number;
}
export interface LiveOwnerBreakdownOutput {
  readonly objectApiName: string;
  readonly totalRecords: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly owners: readonly OwnerBreakdownEntry[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveOwnerBreakdownHandler = async (
  ctx: Context,
  input: LiveOwnerBreakdownInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveOwnerBreakdownOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const whereResult = buildEqualityWhere(input.filterField, input.filterValue);
  if (!whereResult.ok) return whereResult;
  const queriedAt = new Date().toISOString();
  const objectName = objectCheck.value;
  const limit = input.limit ?? 50;
  const whereClause = whereResult.value;

  const totalQ = await liveQuery(org, `SELECT COUNT() FROM ${objectName}${whereClause}`, exec);
  if (!totalQ.available) return err(UNAVAILABLE_ERROR(objectName, org, totalQ.reason));

  const detailQ = await liveQuery(
    org,
    `SELECT OwnerId, COUNT(Id) cnt FROM ${objectName}${whereClause} GROUP BY OwnerId ORDER BY COUNT(Id) DESC LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR(objectName, org, detailQ.reason));

  const ownerIds = detailQ.records
    .map((row) => String((row as Record<string, unknown>).OwnerId ?? ''))
    .filter((id) => id.length > 0);
  const nameById = new Map<string, string>();
  // CR-09: the two count queries above hard-fail (their budget reason surfaces
  // through UNAVAILABLE_ERROR). The name-resolution queries below degrade
  // silently to ownerId-only — track a budget stop so it is named, not hidden.
  let nameResolutionBudgetStopped = false;
  if (ownerIds.length > 0) {
    const inList = ownerIds.map((id) => soqlLiteral(id)).join(',');
    const userQ = await liveQuery(org, `SELECT Id, Name FROM User WHERE Id IN (${inList})`, exec);
    if (userQ.available) {
      for (const row of userQ.records) {
        const r = row as Record<string, unknown>;
        nameById.set(String(r.Id ?? ''), String(r.Name ?? ''));
      }
    } else if (isBudgetExhaustedReason(userQ.reason)) {
      nameResolutionBudgetStopped = true;
    }
    const unresolved = ownerIds.filter((id) => !nameById.has(id));
    if (unresolved.length > 0) {
      const groupIn = unresolved.map((id) => soqlLiteral(id)).join(',');
      const groupQ = await liveQuery(org, `SELECT Id, Name FROM Group WHERE Id IN (${groupIn})`, exec);
      if (groupQ.available) {
        for (const row of groupQ.records) {
          const r = row as Record<string, unknown>;
          nameById.set(String(r.Id ?? ''), String(r.Name ?? ''));
        }
      } else if (isBudgetExhaustedReason(groupQ.reason)) {
        nameResolutionBudgetStopped = true;
      }
    }
  }

  const owners: OwnerBreakdownEntry[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    const ownerId = String(r.OwnerId ?? '');
    return {
      ownerId,
      ownerName: nameById.get(ownerId) ?? null,
      count: Number(r.cnt ?? r.expr1 ?? 0),
    };
  });
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Owner', 'Records'],
    owners.slice(0, LIVE_TABLE_ROW_CAP).map((o) => [o.ownerName ?? o.ownerId, o.count]),
  );
  const rendered =
    `**${totalQ.total.toLocaleString('en-US')}** ${objectName} records across **${owners.length}** owners (top shown).` +
    (nameResolutionBudgetStopped ? `\n\n> ${BUDGET_SIGNAL} Owner names show as IDs.` : '') +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      objectApiName: objectName,
      totalRecords: totalQ.total,
      returned: owners.length,
      capped: owners.length >= limit,
      owners,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_report_usage — "how many reports are useless?" (Report.LastRunDate)
// ---------------------------------------------------------------------------

const DEFAULT_REPORT_STALE_DAYS = 90;

export const liveReportUsageInputSchema = liveEnabledSchema.extend({
  staleDays: z.number().int().min(1).max(3650).optional(),
  limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveReportUsageInput = z.infer<typeof liveReportUsageInputSchema>;

interface ReportRow {
  readonly Id?: string;
  readonly Name?: string;
  readonly FolderName?: string;
  readonly Format?: string;
  readonly LastRunDate?: string | null;
}
export interface ReportUsageEntry {
  readonly id: string;
  readonly name: string;
  readonly folderName: string | null;
  readonly format: string | null;
  readonly lastRunDate: string | null;
  readonly daysSinceRun: number | null;
  readonly stale: boolean;
}
export interface LiveReportUsageOutput {
  readonly totalReports: number;
  readonly staleReports: number;
  readonly staleDays: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly reports: readonly ReportUsageEntry[];
  readonly trust: TrustSummary;
  /**
   * CR-P3-7: true when the live-query budget ran out on the stale-count or
   * detail query (after the gated COUNT succeeded). When true the staleReports
   * count is a partial floor, not an authoritative verdict, and `rendered`
   * surfaces the stop instead of a false clean "0 of N are stale".
   */
  readonly budgetStopped: boolean;
  readonly rendered: string;
}

export const liveReportUsageHandler = async (
  ctx: Context,
  input: LiveReportUsageInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveReportUsageOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const staleDays = input.staleDays ?? DEFAULT_REPORT_STALE_DAYS;
  const limit = input.limit ?? 100;
  const cutoff = daysAgoSoql(staleDays);

  const totalQ = await liveQuery(org, 'SELECT COUNT() FROM Report', exec);
  if (!totalQ.available) return err(UNAVAILABLE_ERROR('Report', org, totalQ.reason));
  const staleQ = await liveQuery(
    org,
    `SELECT COUNT() FROM Report WHERE LastRunDate < ${cutoff} OR LastRunDate = null`,
    exec,
  );
  const detailQ = await liveQuery(
    org,
    `SELECT Id, Name, FolderName, Format, LastRunDate FROM Report ORDER BY LastRunDate ASC NULLS FIRST LIMIT ${limit}`,
    exec,
  );
  const rows = detailQ.records as readonly ReportRow[];
  const reports: ReportUsageEntry[] = rows.map((r) => {
    const lastRunDate = r.LastRunDate ?? null;
    const d = daysSince(lastRunDate);
    return {
      id: String(r.Id ?? ''),
      name: String(r.Name ?? ''),
      folderName: r.FolderName ?? null,
      format: r.Format ?? null,
      lastRunDate,
      daysSinceRun: d,
      stale: lastRunDate === null || (d !== null && d >= staleDays),
    };
  });
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Report', 'Folder', 'Last run', 'Days', 'Stale'],
    reports.map((r) => [r.name, r.folderName ?? '—', r.lastRunDate ?? 'never', r.daysSinceRun ?? '—', r.stale ? 'yes' : '']),
  );
  // CR-P3-7: the stale-count (verdict) and detail queries are NOT gated like
  // totalQ; a mid-tool budget stop returns total:0 with the budget reason, which
  // would otherwise render a FALSE CLEAN "0 of N are stale". Detect the stop on
  // either un-gated query and qualify the headline accordingly.
  const budgetStopped =
    isBudgetExhaustedReason(staleQ.reason) ||
    isBudgetExhaustedReason(detailQ.reason);
  // When the budget stopped before the stale count completed, the count is NOT a
  // clean zero — render it as `n/a` (partial), never a literal authoritative 0
  // (which would contradict BUDGET_SIGNAL's own "shown as n/a, NOT zero").
  const staleHeadline = budgetStopped
    ? `Stale-report count is **n/a** (partial) of ${totalQ.total.toLocaleString('en-US')} reports`
    : `**${staleQ.total.toLocaleString('en-US')}** of ${totalQ.total.toLocaleString('en-US')} reports are stale`;
  const rendered =
    `${staleHeadline} (not run in ${staleDays} days, or never).` +
    (budgetStopped
      ? `\n\n> ${BUDGET_SIGNAL} The stale-report count is a partial floor, not a clean zero — the budget stopped before the count query completed.`
      : '') +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      totalReports: totalQ.total,
      staleReports: staleQ.total,
      staleDays,
      returned: reports.length,
      capped: totalQ.total > reports.length,
      reports,
      trust,
      budgetStopped,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_folder_access — "what folders do people have access to?" (Folder)
// ---------------------------------------------------------------------------

export const liveFolderAccessInputSchema = liveEnabledSchema.extend({
  folderType: z.enum(['Report', 'Dashboard', 'Email', 'Document', 'all']).optional(),
  limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveFolderAccessInput = z.infer<typeof liveFolderAccessInputSchema>;

interface FolderRow {
  readonly Name?: string;
  readonly DeveloperName?: string;
  readonly Type?: string;
  readonly AccessType?: string;
}
export interface FolderAccessEntry {
  readonly name: string;
  readonly developerName: string | null;
  readonly type: string;
  readonly accessType: string;
  readonly isPublic: boolean;
}
export interface LiveFolderAccessOutput {
  readonly totalFolders: number;
  readonly publicFolders: number;
  readonly byAccessType: Readonly<Record<string, number>>;
  readonly returned: number;
  readonly capped: boolean;
  readonly folders: readonly FolderAccessEntry[];
  readonly trust: TrustSummary;
  /**
   * CR-P3-8: true when the live-query budget ran out on the (un-gated) total
   * COUNT after the gated detail query succeeded. The folder total then falls
   * back to the returned-set size (an understatement); `rendered` names the stop.
   */
  readonly budgetStopped: boolean;
  readonly rendered: string;
}

export const liveFolderAccessHandler = async (
  ctx: Context,
  input: LiveFolderAccessInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveFolderAccessOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const limit = input.limit ?? 200;
  const typeClause =
    input.folderType && input.folderType !== 'all'
      ? ` WHERE Type = '${input.folderType}'`
      : ` WHERE Type IN ('Report','Dashboard','Email','Document')`;
  const detailQ = await liveQuery(
    org,
    `SELECT Name, DeveloperName, Type, AccessType FROM Folder${typeClause} ORDER BY Type, Name LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR('Folder', org, detailQ.reason));
  const totalQ = await liveQuery(org, `SELECT COUNT() FROM Folder${typeClause}`, exec);
  // CR-P3-8: totalQ is NOT gated; a mid-tool budget stop makes totalQ.total=0,
  // silently understating the universe (the verdict publicFolders is from the
  // gated detail rows and stays correct). Surface the stop.
  const budgetStopped = isBudgetExhaustedReason(totalQ.reason);

  const rows = detailQ.records as readonly FolderRow[];
  const byAccessType: Record<string, number> = {};
  let publicFolders = 0;
  const folders: FolderAccessEntry[] = rows.map((r) => {
    const accessType = String(r.AccessType ?? 'Unknown');
    byAccessType[accessType] = (byAccessType[accessType] ?? 0) + 1;
    const isPublic = /public/i.test(accessType);
    if (isPublic) publicFolders += 1;
    return {
      name: String(r.Name ?? ''),
      developerName: r.DeveloperName ?? null,
      type: String(r.Type ?? ''),
      accessType,
      isPublic,
    };
  });
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Folder', 'Type', 'Access'],
    folders.slice(0, LIVE_TABLE_ROW_CAP).map((f) => [f.name, f.type, f.accessType]),
  );
  const rendered =
    `${(totalQ.total || folders.length).toLocaleString('en-US')} folders — ` +
    `**${publicFolders}** in the returned set are publicly accessible.` +
    (budgetStopped
      ? `\n\n> ${BUDGET_SIGNAL} Folder total is the returned set only, not the full count.`
      : '') +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      totalFolders: totalQ.total || folders.length,
      publicFolders,
      byAccessType,
      returned: folders.length,
      capped: (totalQ.total || folders.length) > folders.length,
      folders,
      trust,
      budgetStopped,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_email_template_usage — "what templates are used / legacy?" (EmailTemplate)
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATE_STALE_DAYS = 180;
const CLASSIC_TEMPLATE_TYPES = new Set(['text', 'html', 'custom', 'visualforce']);

export const liveEmailTemplateUsageInputSchema = liveEnabledSchema.extend({
  staleDays: z.number().int().min(1).max(3650).optional(),
  limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveEmailTemplateUsageInput = z.infer<typeof liveEmailTemplateUsageInputSchema>;

interface TemplateRow {
  readonly Name?: string;
  readonly FolderName?: string;
  readonly TemplateType?: string;
  readonly IsActive?: boolean;
  readonly TimesUsed?: number;
  readonly LastUsedDate?: string | null;
}
export interface TemplateUsageEntry {
  readonly name: string;
  readonly folderName: string | null;
  readonly templateType: string;
  readonly isClassic: boolean;
  readonly isActive: boolean;
  readonly timesUsed: number;
  readonly lastUsedDate: string | null;
  readonly daysSinceUse: number | null;
  readonly migrationCandidate: boolean;
}
export interface LiveEmailTemplateUsageOutput {
  readonly totalTemplates: number;
  readonly classicTemplates: number;
  readonly migrationCandidates: number;
  readonly staleDays: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly templates: readonly TemplateUsageEntry[];
  readonly trust: TrustSummary;
  /**
   * CR-P3-8: true when the live-query budget ran out on the (un-gated) total
   * COUNT after the gated detail query succeeded. The template total then falls
   * back to the returned-set size; `rendered` names the stop.
   */
  readonly budgetStopped: boolean;
  readonly rendered: string;
}

export const liveEmailTemplateUsageHandler = async (
  ctx: Context,
  input: LiveEmailTemplateUsageInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveEmailTemplateUsageOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const staleDays = input.staleDays ?? DEFAULT_TEMPLATE_STALE_DAYS;
  const limit = input.limit ?? 200;

  const detailQ = await liveQuery(
    org,
    `SELECT Name, FolderName, TemplateType, IsActive, TimesUsed, LastUsedDate FROM EmailTemplate ORDER BY LastUsedDate ASC NULLS FIRST LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR('EmailTemplate', org, detailQ.reason));
  const totalQ = await liveQuery(org, 'SELECT COUNT() FROM EmailTemplate', exec);
  // CR-P3-8: totalQ is NOT gated; a mid-tool budget stop makes totalQ.total=0,
  // understating the total (classic/migration verdicts come from the gated
  // detail rows and stay correct). Surface the stop.
  const budgetStopped = isBudgetExhaustedReason(totalQ.reason);

  const rows = detailQ.records as readonly TemplateRow[];
  let classicTemplates = 0;
  let migrationCandidates = 0;
  const templates: TemplateUsageEntry[] = rows.map((r) => {
    const templateType = String(r.TemplateType ?? 'unknown').toLowerCase();
    const isClassic = CLASSIC_TEMPLATE_TYPES.has(templateType);
    if (isClassic) classicTemplates += 1;
    const lastUsedDate = r.LastUsedDate ?? null;
    const d = daysSince(lastUsedDate);
    const timesUsed = Number(r.TimesUsed ?? 0);
    // Migration candidate = Classic + never/long-unused.
    const migrationCandidate =
      isClassic && (timesUsed === 0 || lastUsedDate === null || (d !== null && d >= staleDays));
    if (migrationCandidate) migrationCandidates += 1;
    return {
      name: String(r.Name ?? ''),
      folderName: r.FolderName ?? null,
      templateType,
      isClassic,
      isActive: Boolean(r.IsActive ?? false),
      timesUsed,
      lastUsedDate,
      daysSinceUse: d,
      migrationCandidate,
    };
  });
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Template', 'Type', 'Used', 'Last used', 'Migrate?'],
    templates.slice(0, LIVE_TABLE_ROW_CAP).map((t) => [t.name, t.templateType, t.timesUsed, t.lastUsedDate ?? 'never', t.migrationCandidate ? 'yes' : '']),
  );
  const rendered =
    `${(totalQ.total || templates.length).toLocaleString('en-US')} email templates — ` +
    `**${classicTemplates}** Classic, **${migrationCandidates}** are migration candidates ` +
    `(Classic + unused/stale > ${staleDays}d).` +
    (budgetStopped
      ? `\n\n> ${BUDGET_SIGNAL} Template total is the returned set only.`
      : '') +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      totalTemplates: totalQ.total || templates.length,
      classicTemplates,
      migrationCandidates,
      staleDays,
      returned: templates.length,
      capped: (totalQ.total || templates.length) > templates.length,
      templates,
      trust,
      budgetStopped,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_org_health — "is my org on fire?" (failed jobs, paused flows, limits)
// ---------------------------------------------------------------------------

const DEFAULT_HEALTH_DAYS = 7;
const LIMIT_RISK_THRESHOLD = 0.8; // 80%+ used = at risk

export const liveOrgHealthInputSchema = liveEnabledSchema.extend({
  days: z.number().int().min(1).max(90).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveOrgHealthInput = z.infer<typeof liveOrgHealthInputSchema>;

export interface LimitAtRisk {
  readonly name: string;
  readonly max: number;
  readonly remaining: number;
  readonly usedPct: number;
}
export interface LiveOrgHealthOutput {
  readonly days: number;
  readonly failedAsyncJobs: number | null;
  readonly pendingAsyncJobs: number | null;
  readonly pausedFlowInterviews: number | null;
  readonly limitsAtRisk: readonly LimitAtRisk[];
  readonly signals: readonly string[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveOrgHealthHandler = async (
  ctx: Context,
  input: LiveOrgHealthInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveOrgHealthOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const days = input.days ?? DEFAULT_HEALTH_DAYS;

  // Each signal is independent + resilient: an unavailable object yields null.
  const failedQ = await liveQuery(
    org,
    `SELECT COUNT() FROM AsyncApexJob WHERE Status = 'Failed' AND CreatedDate = LAST_N_DAYS:${days}`,
    exec,
  );
  const pendingQ = await liveQuery(
    org,
    `SELECT COUNT() FROM AsyncApexJob WHERE Status IN ('Queued','Preparing','Processing')`,
    exec,
  );
  const pausedQ = await liveQuery(
    org,
    `SELECT COUNT() FROM FlowInterview WHERE InterviewStatus = 'Paused'`,
    exec,
  );

  // Governor limits via REST — CR-09: budgeted (one unit) and resilient. A
  // budget-exhausted REST read just skips the limits signal (like an auth
  // failure already does) and is flagged below, never a hard 500.
  const limitsAtRisk: LimitAtRisk[] = [];
  const limitsRest = await runLiveRest(org, '/limits', exec);
  const limitsBudgetStopped = !limitsRest.ok && /live-query budget exhausted/i.test(limitsRest.error.message);
  if (limitsRest.ok && limitsRest.value.value && typeof limitsRest.value.value === 'object') {
    for (const [name, v] of Object.entries(limitsRest.value.value as Record<string, unknown>)) {
      const lv = v as { Max?: number; Remaining?: number };
      if (typeof lv.Max === 'number' && typeof lv.Remaining === 'number' && lv.Max > 0) {
        const usedPct = (lv.Max - lv.Remaining) / lv.Max;
        if (usedPct >= LIMIT_RISK_THRESHOLD) {
          limitsAtRisk.push({ name, max: lv.Max, remaining: lv.Remaining, usedPct: Math.round(usedPct * 1000) / 1000 });
        }
      }
    }
    limitsAtRisk.sort((a, b) => b.usedPct - a.usedPct);
  }

  const failedAsyncJobs = failedQ.available ? failedQ.total : null;
  const pendingAsyncJobs = pendingQ.available ? pendingQ.total : null;
  const pausedFlowInterviews = pausedQ.available ? pausedQ.total : null;

  // CR-09: a budget stop on ANY signal must be legible, not a silent null/skip.
  const budgetStopped =
    limitsBudgetStopped ||
    isBudgetExhaustedReason(failedQ.reason) ||
    isBudgetExhaustedReason(pendingQ.reason) ||
    isBudgetExhaustedReason(pausedQ.reason);

  const signals: string[] = [];
  if (budgetStopped) signals.push(BUDGET_SIGNAL);
  if (failedAsyncJobs && failedAsyncJobs > 0) signals.push(`${failedAsyncJobs} failed async job(s) in the last ${days} days`);
  if (pausedFlowInterviews && pausedFlowInterviews > 0) signals.push(`${pausedFlowInterviews} paused flow interview(s)`);
  for (const l of limitsAtRisk.slice(0, 5)) signals.push(`${l.name} at ${Math.round(l.usedPct * 100)}% of limit`);
  if (signals.length === 0) signals.push('No failed jobs, paused flows, or near-limit governors detected.');

  const trust = liveTrust(queriedAt);
  const limitsTable = mdTable(
    ['Limit', 'Used %', 'Remaining', 'Max'],
    limitsAtRisk.slice(0, 8).map((l) => [l.name, `${Math.round(l.usedPct * 100)}%`, l.remaining, l.max]),
  );
  const rendered =
    `### Org health (last ${days} days)\n` +
    `- Failed async jobs: **${failedAsyncJobs ?? 'n/a'}**\n` +
    `- Pending async jobs: **${pendingAsyncJobs ?? 'n/a'}**\n` +
    `- Paused flow interviews: **${pausedFlowInterviews ?? 'n/a'}**\n` +
    `- Governors at/over ${Math.round(LIMIT_RISK_THRESHOLD * 100)}%: **${limitsAtRisk.length}**\n` +
    (limitsTable ? `\n${limitsTable}\n` : '') +
    `\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      days,
      failedAsyncJobs,
      pendingAsyncJobs,
      pausedFlowInterviews,
      limitsAtRisk,
      signals,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_storage_by_object — "what's eating our storage?" (REST recordCount)
// ---------------------------------------------------------------------------

export const liveStorageByObjectInputSchema = liveEnabledSchema.extend({
  limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
  objectApiNames: z.array(z.string().min(1)).max(80).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveStorageByObjectInput = z.infer<typeof liveStorageByObjectInputSchema>;

export interface ObjectRecordCount {
  readonly name: string;
  readonly count: number;
}
export interface LiveStorageByObjectOutput {
  readonly totalRecords: number;
  readonly objectCount: number;
  readonly returned: number;
  readonly objects: readonly ObjectRecordCount[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveStorageByObjectHandler = async (
  ctx: Context,
  input: LiveStorageByObjectInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveStorageByObjectOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const limit = input.limit ?? 50;
  // CR-09: a USER-invoked REST recordCount read counts against the budget (one
  // unit). A budget-exhausted stop surfaces its reason through UNAVAILABLE_ERROR
  // so the user sees "budget", not a bare "not queryable".
  const result = await runLiveRest(org, '/limits/recordCount', exec);
  if (!result.ok) return err(UNAVAILABLE_ERROR('record count', org, result.error.message));
  const payload = result.value.value as { sObjects?: { name?: string; count?: number }[] };
  let all = (payload.sObjects ?? [])
    .map((o) => ({ name: String(o.name ?? ''), count: Number(o.count ?? 0) }))
    .filter((o) => o.name.length > 0);
  if (input.objectApiNames !== undefined && input.objectApiNames.length > 0) {
    const allow = new Set<string>();
    for (const name of input.objectApiNames) {
      const check = assertSoqlIdentifier(name, 'objectApiName');
      if (!check.ok) return check;
      allow.add(check.value);
    }
    all = all.filter((o) => allow.has(o.name));
  }
  all.sort((a, b) => b.count - a.count);
  const totalRecords = all.reduce((s, o) => s + o.count, 0);
  const objects = all.slice(0, limit);
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Object', 'Records'],
    objects.map((o) => [o.name, o.count.toLocaleString('en-US')]),
  );
  const rendered =
    `**${totalRecords.toLocaleString('en-US')}** records across ${all.length} counted objects ` +
    `(top ${objects.length} by volume).\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: { totalRecords, objectCount: all.length, returned: objects.length, objects, trust, rendered },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_data_skew — ownership / lookup skew (GROUP BY ... HAVING)
// ---------------------------------------------------------------------------

const DEFAULT_SKEW_THRESHOLD = 10_000;

export const liveDataSkewInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  ownerField: z.string().min(1).optional(),
  threshold: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveDataSkewInput = z.infer<typeof liveDataSkewInputSchema>;

export interface SkewGroup {
  readonly groupId: string;
  readonly count: number;
}
export interface LiveDataSkewOutput {
  readonly objectApiName: string;
  readonly groupField: string;
  readonly threshold: number;
  readonly skewDetected: boolean;
  readonly maxConcentration: number;
  readonly returned: number;
  readonly skewedGroups: readonly SkewGroup[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveDataSkewHandler = async (
  ctx: Context,
  input: LiveDataSkewInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveDataSkewOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const fieldCheck = assertSoqlIdentifier(input.ownerField ?? 'OwnerId', 'ownerField');
  if (!fieldCheck.ok) return fieldCheck;
  const objectName = objectCheck.value;
  const groupField = fieldCheck.value;
  const threshold = input.threshold ?? DEFAULT_SKEW_THRESHOLD;
  const limit = input.limit ?? 50;
  const queriedAt = new Date().toISOString();
  const q = await liveQuery(
    org,
    `SELECT ${groupField}, COUNT(Id) total FROM ${objectName} GROUP BY ${groupField} HAVING COUNT(Id) > ${threshold} ORDER BY COUNT(Id) DESC LIMIT ${limit}`,
    exec,
  );
  if (!q.available) return err(UNAVAILABLE_ERROR(objectName, org, q.reason));
  const skewedGroups: SkewGroup[] = q.records.map((row) => {
    const r = row as Record<string, unknown>;
    return { groupId: String(r[groupField] ?? r['Id'] ?? ''), count: Number(r['total'] ?? 0) };
  });
  const maxConcentration = skewedGroups[0]?.count ?? 0;
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    [groupField, 'Records'],
    skewedGroups.slice(0, LIVE_TABLE_ROW_CAP).map((g) => [g.groupId, g.count.toLocaleString('en-US')]),
  );
  const rendered =
    (skewedGroups.length > 0
      ? `**${skewedGroups.length}** ${groupField} value(s) on \`${objectName}\` exceed ${threshold.toLocaleString('en-US')} records (skew risk; max ${maxConcentration.toLocaleString('en-US')}).`
      : `No \`${objectName}\` ${groupField} concentration above ${threshold.toLocaleString('en-US')} records — no skew detected.`) +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      objectApiName: objectName,
      groupField,
      threshold,
      skewDetected: skewedGroups.length > 0,
      maxConcentration,
      returned: skewedGroups.length,
      skewedGroups,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_setup_audit_trail — "who changed what in Setup?" (SetupAuditTrail)
// ---------------------------------------------------------------------------

const DEFAULT_AUDIT_DAYS = 30;

export const liveSetupAuditTrailInputSchema = liveEnabledSchema.extend({
  days: z.number().int().min(1).max(180).optional(),
  limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveSetupAuditTrailInput = z.infer<typeof liveSetupAuditTrailInputSchema>;

export interface SetupChange {
  readonly action: string;
  readonly section: string | null;
  readonly createdDate: string | null;
  readonly by: string | null;
  readonly display: string | null;
}
export interface LiveSetupAuditTrailOutput {
  readonly days: number;
  readonly totalChanges: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly changes: readonly SetupChange[];
  readonly trust: TrustSummary;
  /**
   * CR-P3-8: true when the live-query budget ran out on the (un-gated) detail
   * query after the gated COUNT succeeded. The change table is then silently
   * empty while totalChanges is exact; `rendered` names the partial.
   */
  readonly budgetStopped: boolean;
  readonly rendered: string;
}

export const liveSetupAuditTrailHandler = async (
  ctx: Context,
  input: LiveSetupAuditTrailInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveSetupAuditTrailOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const days = input.days ?? DEFAULT_AUDIT_DAYS;
  const limit = input.limit ?? 100;
  const queriedAt = new Date().toISOString();
  const totalQ = await liveQuery(
    org,
    `SELECT COUNT() FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:${days}`,
    exec,
  );
  if (!totalQ.available) return err(UNAVAILABLE_ERROR('SetupAuditTrail', org, totalQ.reason));
  const detailQ = await liveQuery(
    org,
    `SELECT Action, Section, CreatedDate, Display, CreatedBy.Name FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:${days} ORDER BY CreatedDate DESC LIMIT ${limit}`,
    exec,
  );
  // CR-P3-8: detailQ is NOT gated; a mid-tool budget stop yields zero rows so
  // the change TABLE is silently empty while totalChanges (from the gated count)
  // is non-zero. Surface the partial.
  const budgetStopped = isBudgetExhaustedReason(detailQ.reason);
  const changes: SetupChange[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    const by = r['CreatedBy'] as { Name?: string } | null | undefined;
    return {
      action: String(r['Action'] ?? ''),
      section: r['Section'] === undefined || r['Section'] === null ? null : String(r['Section']),
      createdDate: r['CreatedDate'] === undefined || r['CreatedDate'] === null ? null : String(r['CreatedDate']),
      by: by?.Name ?? null,
      display: r['Display'] === undefined || r['Display'] === null ? null : String(r['Display']),
    };
  });
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['When', 'Who', 'Section', 'Action'],
    changes.slice(0, LIVE_TABLE_ROW_CAP).map((c) => [c.createdDate ?? '—', c.by ?? '—', c.section ?? '—', c.action]),
  );
  const rendered =
    `**${totalQ.total.toLocaleString('en-US')}** Setup changes in the last ${days} days.` +
    (budgetStopped
      ? `\n\n> ${BUDGET_SIGNAL} The change table is partial; the count is exact.`
      : '') +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      days,
      totalChanges: totalQ.total,
      returned: changes.length,
      capped: totalQ.total > changes.length,
      changes,
      trust,
      budgetStopped,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_security_exposure — live ModifyAll/ViewAll/AuthorApex grants
// ---------------------------------------------------------------------------

export const liveSecurityExposureInputSchema = liveEnabledSchema.extend({
  orgAlias: z.string().min(1).optional(),
});
export type LiveSecurityExposureInput = z.infer<typeof liveSecurityExposureInputSchema>;

export interface LiveSecurityExposureOutput {
  readonly modifyAllGrants: number | null;
  readonly viewAllGrants: number | null;
  readonly authorApexGrants: number | null;
  readonly usersWithModifyAll: number | null;
  readonly activeUsers: number | null;
  readonly signals: readonly string[];
  readonly trust: TrustSummary;
  readonly rendered: string;
}

export const liveSecurityExposureHandler = async (
  ctx: Context,
  input: LiveSecurityExposureInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveSecurityExposureOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  // Each signal independent + resilient — an unavailable object yields null.
  const modifyAllQ = await liveQuery(org, `SELECT COUNT() FROM PermissionSet WHERE PermissionsModifyAllData = true`, exec);
  const viewAllQ = await liveQuery(org, `SELECT COUNT() FROM PermissionSet WHERE PermissionsViewAllData = true`, exec);
  const authorApexQ = await liveQuery(org, `SELECT COUNT() FROM PermissionSet WHERE PermissionsAuthorApex = true`, exec);
  const usersModifyAllQ = await liveQuery(org, `SELECT COUNT() FROM PermissionSetAssignment WHERE PermissionSet.PermissionsModifyAllData = true`, exec);
  const activeUsersQ = await liveQuery(org, `SELECT COUNT() FROM User WHERE IsActive = true`, exec);

  const modifyAllGrants = modifyAllQ.available ? modifyAllQ.total : null;
  const viewAllGrants = viewAllQ.available ? viewAllQ.total : null;
  const authorApexGrants = authorApexQ.available ? authorApexQ.total : null;
  const usersWithModifyAll = usersModifyAllQ.available ? usersModifyAllQ.total : null;
  const activeUsers = activeUsersQ.available ? activeUsersQ.total : null;

  // CR-09: a budget stop on ANY of the 5 signals must be legible — otherwise a
  // null reads as "PermissionSet not queryable" and silently understates risk.
  const budgetStopped =
    isBudgetExhaustedReason(modifyAllQ.reason) ||
    isBudgetExhaustedReason(viewAllQ.reason) ||
    isBudgetExhaustedReason(authorApexQ.reason) ||
    isBudgetExhaustedReason(usersModifyAllQ.reason) ||
    isBudgetExhaustedReason(activeUsersQ.reason);

  const signals: string[] = [];
  if (budgetStopped) signals.push(BUDGET_SIGNAL);
  if (modifyAllGrants) signals.push(`${modifyAllGrants} permission set(s) grant Modify All Data`);
  if (usersWithModifyAll) signals.push(`${usersWithModifyAll} user assignment(s) carry Modify All Data`);
  if (viewAllGrants) signals.push(`${viewAllGrants} permission set(s) grant View All Data`);
  if (authorApexGrants) signals.push(`${authorApexGrants} permission set(s) grant Author Apex`);
  if (signals.length === 0) signals.push('No live ModifyAll/ViewAll/AuthorApex grants detected (or PermissionSet not queryable).');

  const trust = liveTrust(queriedAt);
  const rendered =
    `### Live security exposure\n` +
    `- Modify All Data grants: **${modifyAllGrants ?? 'n/a'}** (assigned to **${usersWithModifyAll ?? 'n/a'}** user assignments)\n` +
    `- View All Data grants: **${viewAllGrants ?? 'n/a'}**\n` +
    `- Author Apex grants: **${authorApexGrants ?? 'n/a'}**\n` +
    `- Active users: **${activeUsers ?? 'n/a'}**\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: { modifyAllGrants, viewAllGrants, authorApexGrants, usersWithModifyAll, activeUsers, signals, trust, rendered },
    vaultState: livePlaneVaultState(ctx),
  });
};
