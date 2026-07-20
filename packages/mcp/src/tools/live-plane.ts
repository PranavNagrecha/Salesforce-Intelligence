/**
 * Opt-in read-only live org plane (v4.0 R5).
 *
 * Disabled unless `SFI_LIVE_PLANE_ENABLED=1` or the caller passes
 * `liveEnabled: true`. Never falls back to vault data on failure.
 */

import type { ComponentId, McpError, McpResponse, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listNodesByType } from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import {
  mdTable,
  renderFieldPopulationMarkdown,
  renderInactiveUsersMarkdown,
  renderLiveCountMarkdown,
  renderTrustFooter,
} from '../answer-render.js';
import type { LiveCapability } from '../live-capability.js';
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
  scanSoqlForValidationGaps,
  type PicklistLiteralMismatch,
  type PicklistValidationGap,
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
 * Decide whether the read-only live plane may run for `org`.
 *
 * INFRA-12-DEEP: a {@link LiveCapability} token (minted from the invoked tool's
 * registry `livePlane` tag and threaded on `Context`) is REQUIRED before any
 * path — param, env, or ambient standing consent — can allow live. A `never`
 * tool (no capability) fail-closes even when consent is on file. Prefer
 * {@link probeLiveAccess} / {@link gateLive} from tool handlers; this function
 * is the sanctioned seam that alone may call {@link hasLiveConsent}.
 *
 * Three ways in once capability is present, checked in order: an explicit
 * per-call `liveEnabled: true`, the `SFI_LIVE_PLANE_ENABLED` env, or standing
 * one-time consent persisted for the org. Fail-closed — no match means not
 * allowed; never auto-grants.
 */
export const resolveLiveAccess = async (
  org: string,
  inputLiveEnabled?: boolean,
  capability?: LiveCapability,
): Promise<LiveAccessDecision> => {
  // P13-REMOTE-http: over HTTP the live plane is HARD-DISABLED regardless of
  // params, env, or the HOST machine's standing consent — a remote caller
  // must never spend the host's Salesforce API budget or reach its org.
  // Pinned by test, not by documentation.
  if (process.env['SFI_TRANSPORT'] === 'http') return { allowed: false, source: 'none' };
  // INFRA-12-DEEP: no registry capability → cannot read ambient consent (or
  // honor param/env). Structural guard against offline handlers going live.
  if (!capability) return { allowed: false, source: 'none' };
  if (inputLiveEnabled === true) return { allowed: true, source: 'param' };
  if (isLivePlaneEnabled()) return { allowed: true, source: 'env' };
  if (await hasLiveConsent(org)) return { allowed: true, source: 'consent' };
  return { allowed: false, source: 'none' };
};

/**
 * Soft live-access probe for opt-in / primary tools. Reads the capability from
 * `ctx.liveCapability` (set by `dispatchTool`). Returns `{ allowed: false }`
 * when the top-level tool is `livePlane: 'never'` — composed sub-handlers
 * inherit that refusal rather than independently consulting standing consent.
 */
export const probeLiveAccess = async (
  ctx: Context,
  input?: {
    readonly liveEnabled?: boolean | undefined;
    readonly orgAlias?: string | undefined;
  },
): Promise<LiveAccessDecision & { readonly org: string }> => {
  const org = resolveOrg(ctx, input?.orgAlias);
  const access = await resolveLiveAccess(
    org,
    input?.liveEnabled,
    ctx.liveCapability,
  );
  return { ...access, org };
};

/** Structured fail-closed error naming the org + the one-time grant path. */
const liveConsentRequiredError = (org: string): McpError => ({
  kind: 'invalid-query',
  message:
    `Live org plane is not enabled for '${org}' — record counts and live data values ` +
    `require querying the live org and are not available offline. Grant read-only access with ` +
    `sfi.live_consent { grant: true }, pass liveEnabled: true for one call, or set ` +
    `SFI_LIVE_PLANE_ENABLED=1.`,
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
  const probed = await probeLiveAccess(ctx, input);
  if (!probed.allowed) return err(liveConsentRequiredError(probed.org));
  return ok(probed.org);
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

export const liveCountInputSchema = liveEnabledSchema
  .extend({
    // Either `soql` (a SELECT COUNT() query) OR `objectApiName` (count every row
    // of that object). Both optional at the schema level; the handler requires
    // exactly one and turns objectApiName into `SELECT COUNT() FROM <object>`.
    soql: z.string().min(1).optional(),
    objectApiName: z.string().min(1).optional(),
    /**
     * Optional filter applied ONLY when counting via `objectApiName`; becomes
     * the `WHERE <whereClause>` of the built `SELECT COUNT() FROM <object>`. Use
     * it instead of hand-building `soql` for a simple filtered count. It is the
     * caller's responsibility to write valid SOQL here. It MUST NOT be combined
     * with a full `soql` (which already carries its own WHERE) — see the handler.
     */
    whereClause: z.string().min(1).optional(),
    orgAlias: z.string().min(1).optional(),
  })
  // STRICT: reject unrecognized keys. A caller passing a filter under a NAME the
  // tool does not accept (e.g. `filter`, `where`, `criteria`) must get a loud
  // error — not have the param silently stripped by Zod and then run an
  // unfiltered `SELECT COUNT() FROM <object>` that returns the FULL row count as
  // if it were the filtered answer (the live-count "silently ignored a filter"
  // bug). `.strict()` turns the dropped param into a surfaced invalid-query.
  .strict();

export type LiveCountInput = z.infer<typeof liveCountInputSchema>;

/** Salesforce object API name: a letter then letters/digits/underscores (covers `__c`/`__mdt`). */
const OBJECT_API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Resolve the COUNT() SOQL to run: the caller's `soql` verbatim, or one built
 * from `objectApiName` (optionally with `whereClause`). Errors when neither is
 * supplied, when a supplied objectApiName isn't a safe API name (guards SOQL
 * interpolation), or when `whereClause` is given alongside a full `soql` (where
 * honoring it is ambiguous, so we refuse rather than silently drop the filter).
 */
const resolveCountSoql = (input: LiveCountInput): Result<string, McpError> => {
  if (input.soql !== undefined) {
    if (input.whereClause !== undefined) {
      // The filter would be silently dropped (soql already has its own WHERE).
      // Refuse loudly per "either honor it or error".
      return err({
        kind: 'invalid-query',
        message:
          'live_count: `whereClause` applies only when counting via `objectApiName`; ' +
          'it cannot be combined with a full `soql` (put the filter inside the soql WHERE instead).',
        path: 'whereClause',
      });
    }
    return ok(input.soql);
  }
  if (input.objectApiName !== undefined) {
    if (!OBJECT_API_NAME_RE.test(input.objectApiName)) {
      return err({
        kind: 'invalid-query',
        message: `objectApiName "${input.objectApiName}" is not a valid Salesforce object API name.`,
        path: 'objectApiName',
      });
    }
    const base = `SELECT COUNT() FROM ${input.objectApiName}`;
    // Honor the filter: it MUST appear in the emitted SOQL, never be dropped.
    return ok(
      input.whereClause !== undefined
        ? `${base} WHERE ${input.whereClause}`
        : base,
    );
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
  /**
   * Present when a WHERE equality field could NOT be picklist-pre-validated
   * because it is absent from the vault (a managed-package field the refresh did
   * not retrieve, or a relationship path). When present, a count of 0 must NOT
   * be read as "zero records exist" — the literal might be an undetected value
   * mismatch. Absent when every equality field was resolvable offline.
   */
  readonly picklistValidationGaps?: readonly PicklistValidationGap[];
  /** When true, do not treat `count` as an answer to a filtered data question. */
  readonly cannotAnswer?: boolean;
  readonly coverageCaveat?: string;
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

/** Outcome of the offline picklist pre-validation pass for one live SOQL. */
interface PicklistValidationResult {
  /** Literals that match no DEFINED picklist value on a vault-KNOWN field. */
  readonly mismatches: readonly PicklistLiteralMismatch[];
  /** Equality fields the vault does NOT know (managed-package / not-modeled /
   *  relationship path), so pre-validation could not run — a 0 there is not
   *  proof those records do not exist. */
  readonly validationGaps: readonly PicklistValidationGap[];
}

const NO_VALIDATION: PicklistValidationResult = Object.freeze({
  mismatches: [],
  validationGaps: [],
});

/**
 * Pre-validate the WHERE picklist literals in a live SOQL against the vault's
 * known picklist values. A literal that matches no DEFINED value on its field
 * makes a determinate 0 count (or empty sample) a VALUE MISMATCH artifact, not
 * evidence of zero matching records — so we surface the real values and
 * near-match suggestions as disclosures. Offline + best-effort: only fields on
 * the statement's single FROM object are checked (no relationship traversal).
 *
 * Crucially, a field ABSENT from the vault (a managed-package field the refresh
 * did not retrieve, e.g. `hed__Application_Status__c`, or a relationship path)
 * is NOT silently skipped — it is reported as a validation GAP so the caller
 * discloses that picklist pre-validation was unavailable rather than letting a
 * 0 count read as ground truth. Never blocks the query; only augments the result.
 */
const collectPicklistMismatches = async (
  ctx: Context,
  soql: string,
): Promise<PicklistValidationResult> => {
  // No graph wired (e.g. a count-only context) ⇒ nothing to validate against.
  if (ctx.graph === undefined || ctx.graph === null) return NO_VALIDATION;
  const fromObject = fromObjectOf(soql);
  if (fromObject === null) return NO_VALIDATION;
  return scanSoqlForPicklistMismatchesSync(ctx, soql, fromObject);
};

/**
 * Synchronous-friendly wrapper: gather every referenced field's vault node up
 * front (one graph read per distinct field), then run the pure scanners. A
 * direct field present in the vault feeds the mismatch scanner; a direct field
 * absent from the vault (or a relationship path, never resolvable offline) feeds
 * the validation-gap scanner.
 */
const scanSoqlForPicklistMismatchesSync = async (
  ctx: Context,
  soql: string,
  fromObject: string,
): Promise<PicklistValidationResult> => {
  const picklistCache = new Map<string, unknown>();
  // Which direct fields the vault KNOWS (node exists), regardless of whether
  // they carry an inline picklist definition. A known non-picklist field is a
  // benign skip; an UNKNOWN field is a pre-validation gap to disclose.
  const knownFields = new Set<string>();
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
    const present = r.ok && r.value !== null;
    if (present) {
      knownFields.add(field);
      picklistCache.set(field, r.value!.properties['picklistValues']);
    }
  }
  const mismatches = scanSoqlForPicklistMismatches(soql, (ref) =>
    ref.includes('.') ? null : picklistCache.get(ref) ?? null,
  );
  // A relationship path is never resolvable offline; a direct field is a gap
  // only when its vault node is absent (managed-package / not-modeled).
  const validationGaps = scanSoqlForValidationGaps(soql, (ref) =>
    ref.includes('.') ? false : knownFields.has(ref),
  );
  return { mismatches, validationGaps };
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
  const { mismatches, validationGaps } = await collectPicklistMismatches(
    ctx,
    soqlCheck.value,
  );
  const countData = {
    count,
    soql: soqlCheck.value,
    trust: liveTrust(queriedAt),
  };
  const baseRendered = renderLiveCountMarkdown(countData);
  const caveats = [
    ...mismatches.map((m) => `> ⚠️ ${m.disclosure}`),
    ...validationGaps.map((g) => `> ⚠️ ${g.disclosure}`),
  ];
  const cannotAnswer = validationGaps.length > 0;
  const coverageCaveat =
    cannotAnswer
      ? 'Record count filtered on field values that could not be validated offline ' +
        '(managed-package field or live org data required) — this count cannot answer ' +
        'the question without querying live data.'
      : undefined;
  if (coverageCaveat !== undefined) {
    caveats.push(`> ⚠️ ${coverageCaveat}`);
  }
  const rendered =
    caveats.length > 0 ? `${baseRendered}\n\n${caveats.join('\n')}` : baseRendered;
  if (cannotAnswer && coverageCaveat !== undefined) {
    const filterHint =
      input.objectApiName !== undefined
        ? ` object=${input.objectApiName}` +
          (input.whereClause !== undefined ? ` filter=${input.whereClause}` : '')
        : '';
    return err({
      kind: 'invalid-query',
      message:
        `${coverageCaveat}${filterHint} Query: ${soqlCheck.value} ` +
        `Live query returned count=${count} but that cannot answer the filtered question.`,
      path: 'soql',
    });
  }
  return ok({
    data: {
      ...countData,
      rendered,
      ...(mismatches.length > 0 ? { picklistMismatches: mismatches } : {}),
      ...(validationGaps.length > 0
        ? { picklistValidationGaps: validationGaps }
        : {}),
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
  /**
   * Present when a WHERE equality field could NOT be picklist-pre-validated
   * because it is absent from the vault (a managed-package field the refresh did
   * not retrieve, or a relationship path). An empty sample then is NOT proof
   * those records do not exist. See {@link LiveCountOutput.picklistValidationGaps}.
   */
  readonly picklistValidationGaps?: readonly PicklistValidationGap[];
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
  const { mismatches, validationGaps } = await collectPicklistMismatches(ctx, soql);
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
    ...(validationGaps.length > 0
      ? { picklistValidationGaps: validationGaps }
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
// Optional `nameContains` (Name LIKE '%...%') / `folderName` (FolderName = ...)
// scope the total, stale-count, AND detail queries so a targeted question
// ("is one named report used?") is answered scoped, not with the
// org-wide stale dump; `appliedScope` echoes what was applied and the schema is
// STRICT so a mis-named filter is a loud invalid-query
// (LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE).
// ---------------------------------------------------------------------------

const DEFAULT_REPORT_STALE_DAYS = 90;

export const liveReportUsageInputSchema = liveEnabledSchema
  .extend({
    staleDays: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
    /** Case-sensitive substring match on the report Name (`Name LIKE '%...%'`). */
    nameContains: z.string().min(1).optional(),
    /** Exact match on the report's FolderName (`FolderName = '...'`). */
    folderName: z.string().min(1).optional(),
    orgAlias: z.string().min(1).optional(),
  })
  // STRICT: reject unrecognized keys. A support request like "is one named
  // report used?" that passes a scoping filter under a NAME the tool does
  // not accept (`query`, `folder`, `report`, `name`) must get a loud
  // invalid-query — not have the param silently stripped by Zod and then receive
  // the org-wide stale dump as if it were the scoped answer
  // (LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE).
  .strict();
export type LiveReportUsageInput = z.infer<typeof liveReportUsageInputSchema>;

/** The filters actually applied to the live query — echoed so a host never mistakes an unfiltered stale dump for a scoped answer. */
export interface ReportUsageScope {
  readonly nameContains: string | null;
  readonly folderName: string | null;
  readonly staleDays: number;
  readonly limit: number;
}

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
  /** The name/folder scope applied to ALL of the total, stale-count, and detail queries (LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE). */
  readonly appliedScope: ReportUsageScope;
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

  // Build a SOQL WHERE from the name/folder scope, applied to the total, stale,
  // AND detail queries so a scoped call (e.g. "is one named report
  // used?") never returns the org-wide stale dump. Values are escaped via
  // soqlLiteral (LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE).
  const scopeConditions: string[] = [];
  if (input.nameContains !== undefined) {
    scopeConditions.push(`Name LIKE ${soqlLiteral(`%${input.nameContains}%`)}`);
  }
  if (input.folderName !== undefined) {
    scopeConditions.push(`FolderName = ${soqlLiteral(input.folderName)}`);
  }
  const whereSql = scopeConditions.length > 0 ? ` WHERE ${scopeConditions.join(' AND ')}` : '';
  // The stale predicate is parenthesized before the scope is ANDed on, so a
  // scoped stale count means "stale AND in scope", not "stale OR in scope".
  const stalePredicate = `(LastRunDate < ${cutoff} OR LastRunDate = null)`;
  const staleWhere = ` WHERE ${[stalePredicate, ...scopeConditions].join(' AND ')}`;

  const totalQ = await liveQuery(org, `SELECT COUNT() FROM Report${whereSql}`, exec);
  if (!totalQ.available) return err(UNAVAILABLE_ERROR('Report', org, totalQ.reason));
  const staleQ = await liveQuery(org, `SELECT COUNT() FROM Report${staleWhere}`, exec);
  const detailQ = await liveQuery(
    org,
    `SELECT Id, Name, FolderName, Format, LastRunDate FROM Report${whereSql} ORDER BY LastRunDate ASC NULLS FIRST LIMIT ${limit}`,
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
  const scopeParts: string[] = [];
  if (input.nameContains !== undefined) scopeParts.push(`name contains "${input.nameContains}"`);
  if (input.folderName !== undefined) scopeParts.push(`folder = "${input.folderName}"`);
  const scopeLine = scopeParts.length > 0 ? ` Scoped to ${scopeParts.join(' AND ')}.` : '';
  const rendered =
    `${staleHeadline} (not run in ${staleDays} days, or never).${scopeLine}` +
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
      appliedScope: {
        nameContains: input.nameContains ?? null,
        folderName: input.folderName ?? null,
        staleDays,
        limit,
      },
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
// Optional `nameContains` (Name LIKE '%...%') scopes BOTH the detail and count
// queries (alongside the existing `folderType`) so "one named folder's
// privileges" is answered scoped, not with the org-wide first page;
// `appliedScope` echoes what was applied and the schema is STRICT so a mis-named
// filter (e.g. `folderNameContains`) is a loud invalid-query
// (LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE).
// ---------------------------------------------------------------------------

export const liveFolderAccessInputSchema = liveEnabledSchema
  .extend({
    folderType: z.enum(['Report', 'Dashboard', 'Email', 'Document', 'all']).optional(),
    limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
    /** Case-sensitive substring match on the folder Name (`Name LIKE '%...%'`). */
    nameContains: z.string().min(1).optional(),
    orgAlias: z.string().min(1).optional(),
  })
  // STRICT: a name filter under an unsupported key (`folderNameContains`,
  // `query`, `name`, `folder`) must get a loud invalid-query, not be stripped
  // and answered with the org-wide first page
  // (LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE).
  .strict();
export type LiveFolderAccessInput = z.infer<typeof liveFolderAccessInputSchema>;

/** The filters actually applied to the live query — echoed so a host never mistakes an unfiltered first page for a scoped answer. */
export interface FolderAccessScope {
  readonly nameContains: string | null;
  readonly folderType: string;
  readonly limit: number;
}

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
  /** The name/type scope applied to BOTH the detail and count queries (LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE). */
  readonly appliedScope: FolderAccessScope;
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
  // Type condition (Zod enum, so the literal is injection-safe) plus an optional
  // name substring — combined and applied to BOTH the detail and count queries
  // so "one named folder's privileges" scopes instead of returning the org-wide
  // first page (LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE).
  const conditions: string[] = [
    input.folderType && input.folderType !== 'all'
      ? `Type = '${input.folderType}'`
      : `Type IN ('Report','Dashboard','Email','Document')`,
  ];
  if (input.nameContains !== undefined) {
    conditions.push(`Name LIKE ${soqlLiteral(`%${input.nameContains}%`)}`);
  }
  const whereClause = ` WHERE ${conditions.join(' AND ')}`;
  const detailQ = await liveQuery(
    org,
    `SELECT Name, DeveloperName, Type, AccessType FROM Folder${whereClause} ORDER BY Type, Name LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR('Folder', org, detailQ.reason));
  const totalQ = await liveQuery(org, `SELECT COUNT() FROM Folder${whereClause}`, exec);
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
  const scopeParts: string[] = [];
  if (input.nameContains !== undefined) scopeParts.push(`name contains "${input.nameContains}"`);
  if (input.folderType !== undefined && input.folderType !== 'all') {
    scopeParts.push(`type = "${input.folderType}"`);
  }
  const scopeLine = scopeParts.length > 0 ? ` Scoped to ${scopeParts.join(' AND ')}.` : '';
  const rendered =
    `${(totalQ.total || folders.length).toLocaleString('en-US')} folders — ` +
    `**${publicFolders}** in the returned set are publicly accessible.${scopeLine}` +
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
      appliedScope: {
        nameContains: input.nameContains ?? null,
        folderType: input.folderType ?? 'all',
        limit,
      },
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

export const liveEmailTemplateUsageInputSchema = liveEnabledSchema
  .extend({
    staleDays: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).optional(),
    /** Case-sensitive substring match on the template Name (`Name LIKE '%...%'`). */
    nameContains: z.string().min(1).optional(),
    /** Exact match on the template's FolderName (`FolderName = '...'`). */
    folderName: z.string().min(1).optional(),
    orgAlias: z.string().min(1).optional(),
  })
  // STRICT: reject unrecognized keys. A release manager asking "is the ADA
  // template used?" who passes a filter under a NAME the tool does not accept
  // (`query`, `folder`, `template`, `name`) must get a loud invalid-query — not
  // have the param silently stripped by Zod and then receive the org-wide
  // never-used leaderboard as if it were the scoped answer
  // (LIVE-EMAIL-TEMPLATE-USAGE-NO-NAME-SCOPE).
  .strict();
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
/** The filters actually applied to the live query — echoed so a host never mistakes an unfiltered leaderboard for a scoped answer. */
export interface EmailTemplateUsageScope {
  readonly nameContains: string | null;
  readonly folderName: string | null;
  readonly staleDays: number;
  readonly limit: number;
}
export interface LiveEmailTemplateUsageOutput {
  readonly totalTemplates: number;
  readonly classicTemplates: number;
  readonly migrationCandidates: number;
  readonly staleDays: number;
  readonly returned: number;
  readonly capped: boolean;
  /** The name/folder scope applied to BOTH the detail and total-count queries (LIVE-EMAIL-TEMPLATE-USAGE-NO-NAME-SCOPE). */
  readonly appliedScope: EmailTemplateUsageScope;
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

  // Build a SOQL WHERE from the name/folder scope, applied to BOTH the detail
  // and total-count queries so a scoped call (e.g. "is the ADA template used?")
  // never returns the org-wide never-used leaderboard. Values are escaped via
  // soqlLiteral (LIVE-EMAIL-TEMPLATE-USAGE-NO-NAME-SCOPE).
  const scopeConditions: string[] = [];
  if (input.nameContains !== undefined) {
    scopeConditions.push(`Name LIKE ${soqlLiteral(`%${input.nameContains}%`)}`);
  }
  if (input.folderName !== undefined) {
    scopeConditions.push(`FolderName = ${soqlLiteral(input.folderName)}`);
  }
  const whereSql = scopeConditions.length > 0 ? ` WHERE ${scopeConditions.join(' AND ')}` : '';

  const detailQ = await liveQuery(
    org,
    `SELECT Name, FolderName, TemplateType, IsActive, TimesUsed, LastUsedDate FROM EmailTemplate${whereSql} ORDER BY LastUsedDate ASC NULLS FIRST LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR('EmailTemplate', org, detailQ.reason));
  const totalQ = await liveQuery(org, `SELECT COUNT() FROM EmailTemplate${whereSql}`, exec);
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
  const scopeParts: string[] = [];
  if (input.nameContains !== undefined) scopeParts.push(`name contains "${input.nameContains}"`);
  if (input.folderName !== undefined) scopeParts.push(`folder = "${input.folderName}"`);
  const scopeLine = scopeParts.length > 0 ? ` Scoped to ${scopeParts.join(' AND ')}.` : '';
  const rendered =
    `${(totalQ.total || templates.length).toLocaleString('en-US')} email templates — ` +
    `**${classicTemplates}** Classic, **${migrationCandidates}** are migration candidates ` +
    `(Classic + unused/stale > ${staleDays}d).${scopeLine}` +
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
      appliedScope: {
        nameContains: input.nameContains ?? null,
        folderName: input.folderName ?? null,
        staleDays,
        limit,
      },
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

// ---------------------------------------------------------------------------
// sfi.live_permset_holders — WHO HOLDS permission set / PSG / profile X
// ---------------------------------------------------------------------------
//
// ENGINE-ARC §2a. Assignment rosters are runtime state (PermissionSetAssignment
// / User rows), deliberately absent from the vault (the facts PII pin keeps the
// vault to counts only), so "who has the X permission set" is inherently a
// live-plane capability. Three kinds behind one contract:
//   - permissionSet      → PSA rows, direct AND via permission set groups
//   - permissionSetGroup → PSA rows assigned through the group
//   - profile            → User rows (the profile-roster gap, finally answered
//                          name-by-name)
//
// THE PSG TRAP (the classic wrong answer): direct holders of set X
// (`PermissionSetId = :id AND PermissionSetGroupId = null`) MISS every user who
// receives X through a PermissionSetGroup containing X. With the default
// `includeViaGroups: true` the handler queries PermissionSetGroupComponent for
// the groups containing X, then PSA rows assigned via those groups, and reports
// `directHolders` / `viaGroupHolders` / deduped `effectiveTotal` separately.
// This separation is pinned by test — it is what makes the tool audit-grade
// instead of confidently wrong.

const MAX_HOLDER_ROWS = 500;
const DEFAULT_HOLDER_ROWS = 100;
/** Keep the serialized `data` (structured rows + rendered table) under the
 *  global MAX_RESPONSE_BYTES (~45 KB) guard, with headroom for the wrapper. */
const HOLDERS_BYTE_BUDGET = 36_000;
const MAX_HOLDER_BUCKETS = 50;

/** Verbatim disclosure (ENGINE-ARC §2a) — tool description + rendered footer. */
export const PERMSET_HOLDERS_DISCLOSURE =
  'Read-only; point-in-time as of queriedAt — never cached beyond the live-session TTL; roster is CURRENT org state, unlike vault answers.';

export const livePermsetHoldersInputSchema = liveEnabledSchema.extend({
  /** PermissionSet.Name / PSG DeveloperName / Profile.Name (labels accepted). */
  name: z.string().min(1),
  /** What `name` names. Default 'auto': probe PermissionSet → PermissionSetGroup
   *  → Profile by exact name/label; no-match or ambiguity is an honest error,
   *  never a guess. */
  kind: z.enum(['permissionSet', 'permissionSetGroup', 'profile', 'auto']).optional(),
  /** Include inactive assignees (default false — active users only). */
  includeInactiveAssignees: z.boolean().optional(),
  /** For kind 'permissionSet': also count holders who receive the set through a
   *  PermissionSetGroup containing it (default TRUE — see the PSG trap above). */
  includeViaGroups: z.boolean().optional(),
  /** Aggregation buckets for the headline (default 'profile'). */
  groupBy: z.enum(['none', 'profile']).optional(),
  /** Max detail rows (default 100, hard cap 500); a ~36 KB byte budget may trim
   *  the page further. `totalAssignees` is always the TRUE deduped count. */
  limit: z.number().int().min(1).max(MAX_HOLDER_ROWS).optional(),
  /** Keyset paging: return rows with Id > afterId (use `nextAfterId`). */
  afterId: z.string().optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LivePermsetHoldersInput = z.infer<typeof livePermsetHoldersInputSchema>;

export type PermsetHolderKind = 'permissionSet' | 'permissionSetGroup' | 'profile';

/** One holder. For kind 'profile' the rows are User rows (`assignmentId` null);
 *  otherwise PermissionSetAssignment rows. `viaGroup` names the PSG the holder
 *  received the set through (null = direct assignment). */
export interface PermsetHolder {
  readonly assignmentId: string | null;
  readonly userId: string;
  readonly name: string;
  readonly username: string;
  readonly isActive: boolean;
  readonly profileName: string | null;
  readonly expirationDate: string | null;
  readonly viaGroup: string | null;
}

export interface ViaGroupHolders {
  readonly groupName: string;
  readonly holders: readonly PermsetHolder[];
}

export interface HolderProfileBucket {
  readonly profileId: string | null;
  readonly profileName: string | null;
  readonly holders: number;
}

export interface LivePermsetHoldersOutput {
  readonly target: {
    readonly kind: PermsetHolderKind;
    readonly name: string;
    readonly id: string;
  };
  /** TRUE deduped count of matching assignees (COUNT_DISTINCT AssigneeId), never
   *  understated by row caps or byte trimming. */
  readonly totalAssignees: number;
  readonly activeAssignees: number;
  /** PSA rows excluded because ExpirationDate has passed (0 for kind 'profile'). */
  readonly expiredExcluded: number;
  readonly returned: number;
  readonly capped: boolean;
  /** Keyset token: pass as `afterId` to fetch the next page. */
  readonly nextAfterId?: string;
  readonly buckets?: readonly HolderProfileBucket[];
  readonly directHolders: readonly PermsetHolder[];
  readonly viaGroupHolders?: readonly ViaGroupHolders[];
  readonly trust: TrustSummary;
  readonly rendered: string;
  readonly note?: string;
}

interface ResolvedHolderTarget {
  readonly kind: PermsetHolderKind;
  readonly id: string;
  readonly name: string;
}

interface PsaRow {
  readonly Id?: string;
  readonly AssigneeId?: string;
  readonly ExpirationDate?: string | null;
  readonly PermissionSetGroupId?: string | null;
  readonly PermissionSetGroup?: { readonly DeveloperName?: string } | null;
  readonly Assignee?: {
    readonly Name?: string;
    readonly Username?: string;
    readonly IsActive?: boolean;
    readonly Profile?: { readonly Name?: string } | null;
  } | null;
}

interface HolderUserRow {
  readonly Id?: string;
  readonly Name?: string;
  readonly Username?: string;
  readonly IsActive?: boolean;
  readonly Profile?: { readonly Name?: string } | null;
}

const holderNotFoundError = (name: string, probed: readonly string[]): McpError => ({
  kind: 'component-not-found',
  message:
    `No exact match for '${name}' — probed ${probed.join(', ')} by exact name/label ` +
    `in the live org. Check the API name (sfi.resolve can fix typos against the vault), ` +
    `or pass \`kind\` explicitly.`,
});

const holderAmbiguousError = (name: string, kind: string, count: number): McpError => ({
  kind: 'invalid-query',
  message:
    `'${name}' matches ${count}+ ${kind} records in the live org — refusing to guess. ` +
    `Use the exact API name (Name/DeveloperName), not a label shared by several.`,
});

/** Probe PermissionSet → PermissionSetGroup → Profile (or just the explicit
 *  kind) by EXACT name/label. 1–3 budgeted queries; never guesses. */
const resolveHolderTarget = async (
  org: string,
  name: string,
  kind: LivePermsetHoldersInput['kind'],
  exec: ExecCommand,
): Promise<Result<ResolvedHolderTarget, McpError>> => {
  const lit = soqlLiteral(name);
  const probes: ReadonlyArray<{ kind: PermsetHolderKind; soql: string; nameField: string }> = [
    {
      kind: 'permissionSet',
      // IsOwnedByProfile = false: every Profile owns a system permission set
      // with a matching name — matching one here would silently answer the
      // PROFILE question under the permissionSet kind.
      soql:
        `SELECT Id, Name FROM PermissionSet ` +
        `WHERE (Name = ${lit} OR Label = ${lit}) AND IsOwnedByProfile = false LIMIT 2`,
      nameField: 'Name',
    },
    {
      kind: 'permissionSetGroup',
      soql:
        `SELECT Id, DeveloperName FROM PermissionSetGroup ` +
        `WHERE (DeveloperName = ${lit} OR MasterLabel = ${lit}) LIMIT 2`,
      nameField: 'DeveloperName',
    },
    {
      kind: 'profile',
      soql: `SELECT Id, Name FROM Profile WHERE Name = ${lit} LIMIT 2`,
      nameField: 'Name',
    },
  ];
  const wanted = kind === undefined || kind === 'auto' ? probes : probes.filter((p) => p.kind === kind);
  const probedKinds: string[] = [];
  for (const probe of wanted) {
    probedKinds.push(probe.kind);
    const q = await liveQuery(org, probe.soql, exec);
    if (!q.available) {
      return err({
        kind: 'invalid-query',
        message: `Could not probe ${probe.kind} for '${name}': ${redactSecrets(q.reason ?? 'query failed').slice(0, 160)}`,
      });
    }
    if (q.records.length > 1) return err(holderAmbiguousError(name, probe.kind, q.records.length));
    if (q.records.length === 1) {
      const row = q.records[0] as Record<string, unknown>;
      return ok({
        kind: probe.kind,
        id: String(row.Id ?? ''),
        name: String(row[probe.nameField] ?? name),
      });
    }
  }
  return err(holderNotFoundError(name, probedKinds));
};

const toPermsetHolder = (r: PsaRow): PermsetHolder => ({
  assignmentId: String(r.Id ?? ''),
  userId: String(r.AssigneeId ?? ''),
  name: String(r.Assignee?.Name ?? ''),
  username: String(r.Assignee?.Username ?? ''),
  isActive: r.Assignee?.IsActive === true,
  profileName: r.Assignee?.Profile?.Name ?? null,
  expirationDate: r.ExpirationDate ?? null,
  viaGroup: r.PermissionSetGroupId ? (r.PermissionSetGroup?.DeveloperName ?? r.PermissionSetGroupId) : null,
});

const renderPermsetHoldersMarkdown = (
  data: Omit<LivePermsetHoldersOutput, 'rendered' | 'returned' | 'capped'> & {
    readonly returned: number;
    readonly capped: boolean;
  },
): string => {
  const kindLabel: Record<PermsetHolderKind, string> = {
    permissionSet: 'permission set',
    permissionSetGroup: 'permission set group',
    profile: 'profile',
  };
  const direct = data.directHolders.length;
  const viaGroups = (data.viaGroupHolders ?? []).reduce((n, g) => n + g.holders.length, 0);
  const lines: string[] = [
    `### Holders of ${kindLabel[data.target.kind]} \`${data.target.name}\``,
    '',
    `**${data.totalAssignees.toLocaleString('en-US')}** ${data.target.kind === 'profile' ? 'users hold this profile' : 'distinct users hold this'}` +
      (data.target.kind === 'permissionSet'
        ? ` (${direct} direct row(s), ${viaGroups} via-group row(s) on this page)`
        : '') +
      (data.expiredExcluded > 0 ? `; ${data.expiredExcluded} expired assignment(s) excluded` : '') +
      '.',
  ];
  if (data.buckets !== undefined && data.buckets.length > 0) {
    lines.push(
      '',
      '**By profile**',
      '',
      mdTable(
        ['Profile', 'Holders'],
        data.buckets.map((b) => [b.profileName ?? b.profileId ?? '(none)', b.holders]),
      ),
    );
  }
  const holderRows = (holders: readonly PermsetHolder[]) =>
    mdTable(
      ['User', 'Username', 'Profile', 'Active', 'Expires'],
      holders.map((h) => [
        h.name,
        h.username,
        h.profileName ?? '—',
        h.isActive ? 'yes' : 'no',
        h.expirationDate ?? '—',
      ]),
    );
  if (data.directHolders.length > 0) {
    lines.push('', data.target.kind === 'permissionSet' ? '**Direct holders**' : '**Holders**', '', holderRows(data.directHolders));
  }
  for (const g of data.viaGroupHolders ?? []) {
    if (g.holders.length > 0) {
      lines.push('', `**Via group \`${g.groupName}\`**`, '', holderRows(g.holders));
    }
  }
  if (data.capped) {
    lines.push(
      '',
      `Showing ${data.returned} of ${data.totalAssignees} holder(s)` +
        (data.nextAfterId !== undefined ? ` — pass \`afterId: "${data.nextAfterId}"\` for the next page.` : '.'),
    );
  }
  lines.push('', PERMSET_HOLDERS_DISCLOSURE, '', renderTrustFooter(data.trust));
  return lines.join('\n');
};

/** Parse the single aggregate row of a `SELECT COUNT_DISTINCT(...) alias` query. */
const aggregateNumber = (records: readonly Record<string, unknown>[], alias: string): number => {
  const row = records[0];
  if (row === undefined) return 0;
  return Number(row[alias] ?? row['expr0'] ?? 0);
};

export const livePermsetHoldersHandler = async (
  ctx: Context,
  input: LivePermsetHoldersInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LivePermsetHoldersOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const limit = input.limit ?? DEFAULT_HOLDER_ROWS;
  const groupBy = input.groupBy ?? 'profile';
  const includeViaGroups = input.includeViaGroups ?? true;
  const nowLiteral = soqlDateTime(new Date());

  const resolved = await resolveHolderTarget(org, input.name, input.kind, exec);
  if (!resolved.ok) return resolved;
  const target = resolved.value;

  // Keyset paging guard: afterId is interpolated into SOQL — require a plain
  // Salesforce Id shape so it cannot inject.
  if (input.afterId !== undefined && !/^[a-zA-Z0-9]{15,18}$/.test(input.afterId)) {
    return err({
      kind: 'invalid-query',
      message: 'afterId must be a Salesforce record Id (the `nextAfterId` from the previous page).',
      path: 'afterId',
    });
  }
  const afterClause = input.afterId !== undefined ? ` AND Id > '${input.afterId}'` : '';

  if (target.kind === 'profile') {
    // Profile roster = User rows (no PSA involved). This is the perm-set-less
    // half of the old profile-user-roster gap, answered name-by-name.
    const activeClause = input.includeInactiveAssignees ? '' : ' AND IsActive = true';
    const where = `ProfileId = '${target.id}'${activeClause}`;
    const totalQ = await liveQuery(org, `SELECT COUNT() FROM User WHERE ${where}`, exec);
    if (!totalQ.available) return err(UNAVAILABLE_ERROR('User', org, totalQ.reason));
    const totalAssignees = totalQ.total;
    let activeAssignees = totalAssignees;
    if (input.includeInactiveAssignees) {
      const activeQ = await liveQuery(
        org,
        `SELECT COUNT() FROM User WHERE ProfileId = '${target.id}' AND IsActive = true`,
        exec,
      );
      if (!activeQ.available) return err(UNAVAILABLE_ERROR('User', org, activeQ.reason));
      activeAssignees = activeQ.total;
    }
    const detailQ = await liveQuery(
      org,
      `SELECT Id, Name, Username, IsActive, Profile.Name FROM User ` +
        `WHERE ${where}${afterClause} ORDER BY Id LIMIT ${limit}`,
      exec,
    );
    if (!detailQ.available) return err(UNAVAILABLE_ERROR('User', org, detailQ.reason));
    const holders: PermsetHolder[] = (detailQ.records as readonly HolderUserRow[]).map((r) => ({
      assignmentId: null,
      userId: String(r.Id ?? ''),
      name: String(r.Name ?? ''),
      username: String(r.Username ?? ''),
      isActive: r.IsActive === true,
      profileName: r.Profile?.Name ?? null,
      expirationDate: null,
      viaGroup: null,
    }));
    return ok({
      data: fitPermsetHolders(
        {
          target,
          totalAssignees,
          activeAssignees,
          expiredExcluded: 0,
          trust: liveTrust(queriedAt),
        },
        holders,
        [],
        undefined,
      ),
      vaultState: livePlaneVaultState(ctx),
    });
  }

  // PSA-based kinds: permissionSet (direct + via groups) or permissionSetGroup.
  let viaGroups: ReadonlyArray<{ id: string; name: string }> = [];
  if (target.kind === 'permissionSet' && includeViaGroups) {
    const psgcQ = await liveQuery(
      org,
      `SELECT PermissionSetGroupId, PermissionSetGroup.DeveloperName ` +
        `FROM PermissionSetGroupComponent WHERE PermissionSetId = '${target.id}'`,
      exec,
    );
    if (!psgcQ.available) {
      return err(UNAVAILABLE_ERROR('PermissionSetGroupComponent', org, psgcQ.reason));
    }
    viaGroups = psgcQ.records.map((r) => {
      const row = r as PsaRow;
      return {
        id: String(row.PermissionSetGroupId ?? ''),
        name: String(row.PermissionSetGroup?.DeveloperName ?? row.PermissionSetGroupId ?? ''),
      };
    });
  }
  const scope =
    target.kind === 'permissionSetGroup'
      ? `PermissionSetGroupId = '${target.id}'`
      : viaGroups.length > 0
        ? `((PermissionSetId = '${target.id}' AND PermissionSetGroupId = null) OR ` +
          `PermissionSetGroupId IN (${viaGroups.map((g) => `'${g.id}'`).join(', ')}))`
        : `(PermissionSetId = '${target.id}' AND PermissionSetGroupId = null)`;
  const activeClause = input.includeInactiveAssignees ? '' : ' AND Assignee.IsActive = true';
  // Expired assignments are excluded from totals and the page, and disclosed.
  const notExpiredClause = ` AND (ExpirationDate = null OR ExpirationDate >= ${nowLiteral})`;
  const where = `${scope}${activeClause}${notExpiredClause}`;

  // TRUE deduped headline first (a user holding the set directly AND via a
  // group is one assignee, not two).
  const totalQ = await liveQuery(
    org,
    `SELECT COUNT_DISTINCT(AssigneeId) total FROM PermissionSetAssignment WHERE ${where}`,
    exec,
  );
  if (!totalQ.available) return err(UNAVAILABLE_ERROR('PermissionSetAssignment', org, totalQ.reason));
  const totalAssignees = aggregateNumber(totalQ.records, 'total');

  let activeAssignees = totalAssignees;
  if (input.includeInactiveAssignees) {
    const activeQ = await liveQuery(
      org,
      `SELECT COUNT_DISTINCT(AssigneeId) total FROM PermissionSetAssignment ` +
        `WHERE ${scope} AND Assignee.IsActive = true${notExpiredClause}`,
      exec,
    );
    if (!activeQ.available) return err(UNAVAILABLE_ERROR('PermissionSetAssignment', org, activeQ.reason));
    activeAssignees = aggregateNumber(activeQ.records, 'total');
  }

  const expiredQ = await liveQuery(
    org,
    `SELECT COUNT() FROM PermissionSetAssignment WHERE ${scope}${activeClause} AND ExpirationDate < ${nowLiteral}`,
    exec,
  );
  const expiredExcluded = expiredQ.available ? expiredQ.total : 0;

  let buckets: HolderProfileBucket[] | undefined;
  if (groupBy === 'profile') {
    const bucketQ = await liveQuery(
      org,
      `SELECT Assignee.ProfileId pid, MAX(Assignee.Profile.Name) pname, COUNT(Id) holders ` +
        `FROM PermissionSetAssignment WHERE ${where} ` +
        `GROUP BY Assignee.ProfileId ORDER BY COUNT(Id) DESC LIMIT ${MAX_HOLDER_BUCKETS}`,
      exec,
    );
    // Buckets are a convenience aggregate — degrade gracefully when the org
    // rejects the aggregate (the roster itself still answers).
    if (bucketQ.available) {
      buckets = bucketQ.records.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          profileId: row.pid === undefined || row.pid === null ? null : String(row.pid),
          profileName: row.pname === undefined || row.pname === null ? null : String(row.pname),
          holders: Number(row.holders ?? row.expr1 ?? 0),
        };
      });
    }
  }

  const detailQ = await liveQuery(
    org,
    `SELECT Id, AssigneeId, Assignee.Name, Assignee.Username, Assignee.IsActive, ` +
      `Assignee.Profile.Name, ExpirationDate, PermissionSetGroupId, PermissionSetGroup.DeveloperName ` +
      `FROM PermissionSetAssignment WHERE ${where}${afterClause} ORDER BY Id LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR('PermissionSetAssignment', org, detailQ.reason));
  const rows = (detailQ.records as readonly PsaRow[]).map(toPermsetHolder);

  return ok({
    data: fitPermsetHolders(
      {
        target,
        totalAssignees,
        activeAssignees,
        expiredExcluded,
        trust: liveTrust(queriedAt),
      },
      rows,
      viaGroups.map((g) => g.name),
      buckets,
    ),
    vaultState: livePlaneVaultState(ctx),
  });
};

type PermsetHoldersBase = Pick<
  LivePermsetHoldersOutput,
  'target' | 'totalAssignees' | 'activeAssignees' | 'expiredExcluded' | 'trust'
>;

/** Split rows into direct / via-group buckets. */
const splitHolders = (
  rows: readonly PermsetHolder[],
  groupNames: readonly string[],
): { direct: PermsetHolder[]; via: ViaGroupHolders[] } => {
  const direct = rows.filter((h) => h.viaGroup === null);
  const byGroup = new Map<string, PermsetHolder[]>();
  for (const h of rows) {
    if (h.viaGroup === null) continue;
    const list = byGroup.get(h.viaGroup) ?? [];
    list.push(h);
    byGroup.set(h.viaGroup, list);
  }
  // Preserve the PSGC-declared group order, then any groups only seen in rows.
  const ordered = [
    ...groupNames.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !groupNames.includes(g)),
  ];
  return {
    direct,
    via: ordered.map((g) => ({ groupName: g, holders: byGroup.get(g) ?? [] })),
  };
};

/** Byte-fit loop (liveInactiveUsers invariant): trim detail rows until the
 *  serialized output fits HOLDERS_BYTE_BUDGET. `totalAssignees` is never
 *  touched, so a trimmed page never understates the count; `nextAfterId` is
 *  recomputed from the LAST KEPT row so keyset paging stays correct. */
const fitPermsetHolders = (
  base: PermsetHoldersBase,
  allRows: readonly PermsetHolder[],
  groupNames: readonly string[],
  buckets: readonly HolderProfileBucket[] | undefined,
): LivePermsetHoldersOutput => {
  let slice: readonly PermsetHolder[] = allRows;
  let byteTrimmed = false;
  for (;;) {
    const returned = slice.length;
    const distinctReturned = new Set(slice.map((h) => h.userId)).size;
    const capped = byteTrimmed || base.totalAssignees > distinctReturned;
    const last = slice[slice.length - 1];
    const nextAfterId =
      capped && last !== undefined ? (last.assignmentId ?? last.userId) : undefined;
    const { direct, via } = splitHolders(slice, groupNames);
    const shape: Omit<LivePermsetHoldersOutput, 'rendered'> = {
      ...base,
      returned,
      capped,
      ...(nextAfterId !== undefined ? { nextAfterId } : {}),
      ...(buckets !== undefined ? { buckets } : {}),
      directHolders: direct,
      ...(groupNames.length > 0 || via.length > 0 ? { viaGroupHolders: via } : {}),
      ...(byteTrimmed
        ? {
            note:
              `Detail rows trimmed to ${returned} to stay within the response size ` +
              `limit; totalAssignees (${base.totalAssignees}) is the true count — ` +
              `page on with afterId.`,
          }
        : {}),
    };
    const rendered = renderPermsetHoldersMarkdown(shape);
    const bytes = Buffer.byteLength(JSON.stringify({ ...shape, rendered }), 'utf8');
    if (bytes <= HOLDERS_BYTE_BUDGET || slice.length <= 1) {
      return { ...shape, rendered };
    }
    slice = slice.slice(0, Math.max(1, Math.floor(slice.length * 0.85)));
    byteTrimmed = true;
  }
};

// ---------------------------------------------------------------------------
// sfi.live_zombie_accounts — login access, no permission-set assignments
// ---------------------------------------------------------------------------
//
// ENGINE-ARC §2c. Explicit DELTA over sfi.live_inactive_users (which covers
// dormancy only): this is the User × PermissionSetAssignment ANTI-JOIN — active
// users with NO permission-set/PSG assignments at all, the perm-set-less
// variant of the access-hygiene sweep. The `PermissionSet.IsOwnedByProfile =
// false` filter is LOAD-BEARING: every user has a system PSA row for their
// profile-owned permission set, so without the filter the answer is always
// empty. Pinned by test.

const MAX_ZOMBIE_ROWS = 500;
const DEFAULT_ZOMBIE_ROWS = 100;
const ZOMBIE_BYTE_BUDGET = 36_000;
/** Bounded scan size for the disclosed client-diff fallback. */
const ZOMBIE_CLIENT_DIFF_CAP = 2000;

/** Verbatim honesty note (ENGINE-ARC §2c) — without it the tool invites a
 *  dangerous misread. */
export const ZOMBIE_ACCOUNTS_DISCLOSURE =
  'A "zombie" here still holds every permission its PROFILE grants — this tool reports "no permission-set/PSG assignments", NOT "no access". Read-only; point-in-time as of queriedAt.';

export const liveZombieAccountsInputSchema = liveEnabledSchema.extend({
  /** Additionally require last login older than N days (default 0 = ignore
   *  login age; dormancy alone is sfi.live_inactive_users' job). */
  minDaysInactive: z.number().int().min(0).max(3650).optional(),
  /** Include non-Standard user types (default false — Standard/human only). */
  includeAllUserTypes: z.boolean().optional(),
  /** Max detail rows (default 100, hard cap 500); byte budget may trim further.
   *  `totalZombies` is always the true count. */
  limit: z.number().int().min(1).max(MAX_ZOMBIE_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveZombieAccountsInput = z.infer<typeof liveZombieAccountsInputSchema>;

export interface ZombieUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly profileName: string | null;
  readonly lastLoginDate: string | null;
  readonly neverLoggedIn: boolean;
}

export interface LiveZombieAccountsOutput {
  readonly criteria: {
    readonly minDaysInactive: number;
    /** ISO cutoff when minDaysInactive > 0, else null. */
    readonly cutoff: string | null;
    readonly userTypeFilter: 'Standard' | 'all';
  };
  /** TRUE total of matching users (never understated by caps/trimming). Under
   *  method 'client-diff' it is bounded by the disclosed scan caps. */
  readonly totalZombies: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly users: readonly ZombieUser[];
  /** 'anti-join' = single NOT IN SOQL; 'client-diff' = disclosed fallback (two
   *  bounded queries diffed client-side) when the org rejects the anti-join. */
  readonly method: 'anti-join' | 'client-diff';
  readonly disclosure: string;
  readonly trust: TrustSummary;
  readonly rendered: string;
  readonly note?: string;
}

const toZombieUser = (r: HolderUserRow & { LastLoginDate?: string | null }): ZombieUser => ({
  id: String(r.Id ?? ''),
  name: String(r.Name ?? ''),
  username: String(r.Username ?? ''),
  profileName: r.Profile?.Name ?? null,
  lastLoginDate: r.LastLoginDate ?? null,
  neverLoggedIn: (r.LastLoginDate ?? null) === null,
});

type ZombieBase = Pick<LiveZombieAccountsOutput, 'criteria' | 'totalZombies' | 'method' | 'disclosure' | 'trust'>;

const renderZombieAccountsMarkdown = (
  data: Omit<LiveZombieAccountsOutput, 'rendered'>,
): string => {
  const head =
    `**${data.totalZombies.toLocaleString('en-US')}** active ` +
    `${data.criteria.userTypeFilter === 'Standard' ? 'Standard ' : ''}user(s) have login access ` +
    `but ZERO permission-set/PSG assignments` +
    (data.criteria.cutoff !== null
      ? ` and no login within ${data.criteria.minDaysInactive} days`
      : '') +
    '.';
  const table =
    data.users.length === 0
      ? ''
      : `\n\n${mdTable(
          ['User', 'Username', 'Profile', 'Last login'],
          data.users.map((u) => [
            u.name,
            u.username,
            u.profileName ?? '—',
            u.neverLoggedIn ? 'never' : (u.lastLoginDate ?? '—'),
          ]),
        )}`;
  const cappedLine = data.capped ? `\n\nShowing ${data.returned} of ${data.totalZombies}.` : '';
  const methodLine =
    data.method === 'client-diff'
      ? `\n\nMethod: client-diff — the org rejected the single anti-join SOQL, so this was computed by diffing two bounded queries (scan cap ${ZOMBIE_CLIENT_DIFF_CAP} rows each).`
      : '';
  return `${head}${table}${cappedLine}${methodLine}\n\n${data.disclosure}\n\n${renderTrustFooter(data.trust)}`;
};

const fitZombieUsers = (
  base: ZombieBase,
  allUsers: readonly ZombieUser[],
  extraNote: string | undefined,
): LiveZombieAccountsOutput => {
  let slice: readonly ZombieUser[] = allUsers;
  let byteTrimmed = false;
  for (;;) {
    const returned = slice.length;
    const capped = byteTrimmed || base.totalZombies > returned;
    const noteText = [
      ...(extraNote !== undefined ? [extraNote] : []),
      ...(byteTrimmed
        ? [
            `Detail rows trimmed to ${returned} to stay within the response size limit; ` +
              `totalZombies (${base.totalZombies}) is the true count.`,
          ]
        : []),
    ].join(' ');
    const shape: Omit<LiveZombieAccountsOutput, 'rendered'> = {
      ...base,
      returned,
      capped,
      users: slice,
      ...(noteText.length > 0 ? { note: noteText } : {}),
    };
    const rendered = renderZombieAccountsMarkdown(shape);
    const bytes = Buffer.byteLength(JSON.stringify({ ...shape, rendered }), 'utf8');
    if (bytes <= ZOMBIE_BYTE_BUDGET || slice.length <= 1) {
      return { ...shape, rendered };
    }
    slice = slice.slice(0, Math.max(1, Math.floor(slice.length * 0.85)));
    byteTrimmed = true;
  }
};

export const liveZombieAccountsHandler = async (
  ctx: Context,
  input: LiveZombieAccountsInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveZombieAccountsOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const minDaysInactive = input.minDaysInactive ?? 0;
  const limit = input.limit ?? DEFAULT_ZOMBIE_ROWS;
  const cutoff = minDaysInactive > 0 ? daysAgoSoql(minDaysInactive) : null;
  const userTypeClause = input.includeAllUserTypes ? '' : ` AND UserType = 'Standard'`;
  const loginClause =
    cutoff !== null ? ` AND (LastLoginDate < ${cutoff} OR LastLoginDate = null)` : '';
  const baseWhere = `IsActive = true${userTypeClause}${loginClause}`;
  // THE LOAD-BEARING FILTER: IsOwnedByProfile = false. Every user carries a
  // system PSA row for their profile-owned permission set — without this filter
  // the anti-join matches nobody, ever, and the tool is silently useless.
  const antiJoin =
    ` AND Id NOT IN (SELECT AssigneeId FROM PermissionSetAssignment ` +
    `WHERE PermissionSet.IsOwnedByProfile = false)`;
  const criteria = {
    minDaysInactive,
    cutoff,
    userTypeFilter: (input.includeAllUserTypes ? 'all' : 'Standard') as 'Standard' | 'all',
  };
  const detailSelect = `SELECT Id, Name, Username, Profile.Name, LastLoginDate FROM User`;

  // Primary path: single anti-join SOQL, true count first.
  const countQ = await liveQuery(org, `SELECT COUNT() FROM User WHERE ${baseWhere}${antiJoin}`, exec);
  if (countQ.available) {
    const detailQ = await liveQuery(
      org,
      `${detailSelect} WHERE ${baseWhere}${antiJoin} ` +
        `ORDER BY LastLoginDate ASC NULLS FIRST LIMIT ${limit}`,
      exec,
    );
    if (!detailQ.available) return err(UNAVAILABLE_ERROR('User', org, detailQ.reason));
    const users = (detailQ.records as readonly (HolderUserRow & { LastLoginDate?: string | null })[]).map(
      toZombieUser,
    );
    return ok({
      data: fitZombieUsers(
        {
          criteria,
          totalZombies: countQ.total,
          method: 'anti-join',
          disclosure: ZOMBIE_ACCOUNTS_DISCLOSURE,
          trust: liveTrust(queriedAt),
        },
        users,
        undefined,
      ),
      vaultState: livePlaneVaultState(ctx),
    });
  }

  // A budget stop is a STOP, not a reason to spend three more queries.
  if (isBudgetExhaustedReason(countQ.reason)) {
    return err({ kind: 'invalid-query', message: redactSecrets(countQ.reason ?? 'live-query budget exhausted') });
  }

  // Disclosed fallback: the org rejected the anti-join (some orgs/API versions
  // refuse semi-join filters on PermissionSetAssignment). Two bounded queries,
  // diffed client-side, disclosed as method:'client-diff'.
  const usersQ = await liveQuery(
    org,
    `${detailSelect} WHERE ${baseWhere} ORDER BY LastLoginDate ASC NULLS FIRST LIMIT ${ZOMBIE_CLIENT_DIFF_CAP}`,
    exec,
  );
  if (!usersQ.available) return err(UNAVAILABLE_ERROR('User', org, usersQ.reason));
  const assigneesQ = await liveQuery(
    org,
    `SELECT AssigneeId FROM PermissionSetAssignment ` +
      `WHERE PermissionSet.IsOwnedByProfile = false GROUP BY AssigneeId LIMIT ${ZOMBIE_CLIENT_DIFF_CAP}`,
    exec,
  );
  if (!assigneesQ.available) {
    return err(UNAVAILABLE_ERROR('PermissionSetAssignment', org, assigneesQ.reason));
  }
  const assigneeIds = new Set(
    assigneesQ.records.map((r) => String((r as Record<string, unknown>).AssigneeId ?? '')),
  );
  const zombies = (usersQ.records as readonly (HolderUserRow & { LastLoginDate?: string | null })[])
    .map(toZombieUser)
    .filter((u) => !assigneeIds.has(u.id) && !assigneeIds.has(u.id.slice(0, 15)));
  const scanBounded =
    usersQ.records.length >= ZOMBIE_CLIENT_DIFF_CAP ||
    assigneesQ.records.length >= ZOMBIE_CLIENT_DIFF_CAP;
  const extraNote =
    `Anti-join SOQL was rejected by the org (${redactSecrets(countQ.reason ?? 'unknown').slice(0, 120)}); ` +
    `fell back to a client-side diff of two bounded queries.` +
    (scanBounded
      ? ` One scan hit its ${ZOMBIE_CLIENT_DIFF_CAP}-row cap, so totalZombies may UNDERCOUNT — treat it as a lower bound.`
      : '');
  return ok({
    data: fitZombieUsers(
      {
        criteria,
        totalZombies: zombies.length,
        method: 'client-diff',
        disclosure: ZOMBIE_ACCOUNTS_DISCLOSURE,
        trust: liveTrust(queriedAt),
      },
      zombies.slice(0, limit),
      extraNote,
    ),
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_group_members — who's in queue / public group X
// ---------------------------------------------------------------------------
//
// ENGINE-ARC §2b. Queue/group membership is runtime `GroupMember` data —
// metadata XML only carries the DECLARED members (most orgs manage membership
// through Setup, so the vault's `properties.memberCount` is routinely 0 while
// the live org has members). This tool measures that drift instead of
// disclaiming it: `vaultDeclaredMemberCount` (vault) vs `liveDirectMemberCount`
// (live) with a `drift` boolean.
//
// `GroupMember.UserOrGroupId` is POLYMORPHIC: `005` → User, `00G` → a nested
// Group — which itself may be a Role / RoleAndSubordinates proxy group. Role
// entries are surfaced by UserRole name and NEVER expanded to users (the role
// hierarchy is not enumerable in one budgeted call). Nested public groups are
// listed, not expanded, unless `expandNested: true` — which expands exactly ONE
// level and stamps `expansion: 'partial-one-level'`. Fail-closed: a partial
// expansion is never presented as the full effective membership.

const MAX_MEMBER_ROWS = 500;
const DEFAULT_MEMBER_ROWS = 100;
const MEMBERS_BYTE_BUDGET = 36_000;
/** IN-clause chunk size for batched User/Group id resolution. */
const MEMBER_ID_CHUNK = 200;

/** Verbatim disclosure (ENGINE-ARC §2b) — tool description + rendered footer. */
export const GROUP_MEMBERS_DISCLOSURE =
  'Direct membership only by default — nested public groups and role entries are listed but NOT expanded to users. expandNested: true expands exactly ONE level of nested public groups (stamped expansion: "partial-one-level"); deeper nesting and role-hierarchy subordinates are not enumerated — never treat this as the full effective membership. Read-only; point-in-time as of queriedAt.';

export const liveGroupMembersInputSchema = liveEnabledSchema.extend({
  /** Group.DeveloperName or Group.Name (label) — exact match, never a guess. */
  name: z.string().min(1),
  /** What kind of Group `name` names. Default 'auto' matches both Queue and
   *  Regular (public group); an ambiguous name across both is an honest error. */
  groupType: z.enum(['Queue', 'Regular', 'auto']).optional(),
  /** Expand exactly ONE level of nested public groups (default false). Role
   *  entries are never expanded. */
  expandNested: z.boolean().optional(),
  /** Max direct GroupMember rows fetched (default 100, hard cap 500); a ~36 KB
   *  byte budget may trim the user page further. `totalDirectMembers` is
   *  always the TRUE count. */
  limit: z.number().int().min(1).max(MAX_MEMBER_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveGroupMembersInput = z.infer<typeof liveGroupMembersInputSchema>;

export interface GroupMemberUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly isActive: boolean;
}

export interface NestedGroupEntry {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Present only under expandNested — ONE level of this group's own users. */
  readonly members?: readonly GroupMemberUser[];
  /** Under expandNested: how many of this group's own members are THEMSELVES
   *  groups/roles that were NOT expanded (the fail-closed remainder). */
  readonly unexpandedNestedCount?: number;
}

export interface GroupRoleEntry {
  readonly id: string;
  /** UserRole.Name when resolvable, else null (never invented). */
  readonly roleName: string | null;
  readonly type: string;
  readonly includesSubordinates: boolean;
}

export interface LiveGroupMembersOutput {
  readonly group: {
    readonly id: string;
    readonly name: string;
    readonly developerName: string;
    readonly type: 'Queue' | 'Regular';
  };
  /** Queues only: the sObject types this queue can own (QueueSobject). */
  readonly supportedObjects?: readonly string[];
  /** TRUE total of direct GroupMember rows (never understated by caps). */
  readonly totalDirectMembers: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly users: readonly GroupMemberUser[];
  readonly nestedGroups: readonly NestedGroupEntry[];
  readonly roles: readonly GroupRoleEntry[];
  readonly expansion: 'none' | 'partial-one-level';
  /** Declared member count from the vault node (Queue/Group properties.memberCount),
   *  null when the group is not in the vault or carries no count. */
  readonly vaultDeclaredMemberCount: number | null;
  /** Same value as totalDirectMembers — named to pair with the vault count. */
  readonly liveDirectMemberCount: number;
  /** true when the vault DECLARED count disagrees with live DIRECT membership —
   *  the measured form of the old "runtime membership not reflected" disclosure. */
  readonly drift: boolean;
  readonly disclosure: string;
  readonly trust: TrustSummary;
  readonly rendered: string;
  readonly note?: string;
}

interface LiveGroupRow {
  readonly Id?: string;
  readonly Name?: string;
  readonly DeveloperName?: string;
  readonly Type?: string;
  readonly RelatedId?: string | null;
}

/** Chunk `ids` into IN-clause literals of MEMBER_ID_CHUNK. */
const idChunks = (ids: readonly string[]): string[][] => {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += MEMBER_ID_CHUNK) {
    chunks.push(ids.slice(i, i + MEMBER_ID_CHUNK));
  }
  return chunks;
};

/** Batch-resolve User rows by id (IN-chunks of 200). Hard-fails so a budget
 *  stop is an honest error, never a silently-empty roster. */
const resolveMemberUsers = async (
  org: string,
  ids: readonly string[],
  exec: ExecCommand,
): Promise<Result<Map<string, GroupMemberUser>, McpError>> => {
  const byId = new Map<string, GroupMemberUser>();
  for (const chunk of idChunks(ids)) {
    const inList = chunk.map((id) => soqlLiteral(id)).join(', ');
    const q = await liveQuery(
      org,
      `SELECT Id, Name, Username, IsActive FROM User WHERE Id IN (${inList})`,
      exec,
    );
    if (!q.available) return err(UNAVAILABLE_ERROR('User', org, q.reason));
    for (const r of q.records) {
      const row = r as { Id?: string; Name?: string; Username?: string; IsActive?: boolean };
      const id = String(row.Id ?? '');
      byId.set(id, {
        id,
        name: String(row.Name ?? ''),
        username: String(row.Username ?? ''),
        isActive: row.IsActive === true,
      });
    }
  }
  return ok(byId);
};

type GroupMembersBase = Pick<
  LiveGroupMembersOutput,
  | 'group'
  | 'totalDirectMembers'
  | 'nestedGroups'
  | 'roles'
  | 'expansion'
  | 'vaultDeclaredMemberCount'
  | 'liveDirectMemberCount'
  | 'drift'
  | 'disclosure'
  | 'trust'
> & { readonly supportedObjects?: readonly string[] };

const renderGroupMembersMarkdown = (data: Omit<LiveGroupMembersOutput, 'rendered'>): string => {
  const kind = data.group.type === 'Queue' ? 'queue' : 'public group';
  const lines: string[] = [
    `### Members of ${kind} \`${data.group.developerName}\``,
    '',
    `**${data.totalDirectMembers.toLocaleString('en-US')}** direct member entr${data.totalDirectMembers === 1 ? 'y' : 'ies'} ` +
      `(${data.users.length} user(s), ${data.nestedGroups.length} nested group(s), ${data.roles.length} role(s) on this page).`,
  ];
  if (data.supportedObjects !== undefined) {
    lines.push(
      '',
      data.supportedObjects.length > 0
        ? `**Can own:** ${data.supportedObjects.join(', ')}`
        : '**Can own:** (no QueueSobject rows — this queue supports no objects)',
    );
  }
  if (data.users.length > 0) {
    lines.push(
      '',
      '**Users**',
      '',
      mdTable(
        ['User', 'Username', 'Active'],
        data.users.map((u) => [u.name, u.username, u.isActive ? 'yes' : 'no']),
      ),
    );
  }
  for (const g of data.nestedGroups) {
    lines.push('', `**Nested group \`${g.name}\`** (${g.type}${g.members === undefined ? ' — not expanded' : ''})`);
    if (g.members !== undefined) {
      lines.push(
        '',
        g.members.length > 0
          ? mdTable(
              ['User', 'Username', 'Active'],
              g.members.map((u) => [u.name, u.username, u.isActive ? 'yes' : 'no']),
            )
          : '(no direct users)',
      );
      if ((g.unexpandedNestedCount ?? 0) > 0) {
        lines.push(
          '',
          `${g.unexpandedNestedCount} nested group/role member(s) inside \`${g.name}\` were NOT expanded (one-level limit).`,
        );
      }
    }
  }
  if (data.roles.length > 0) {
    lines.push(
      '',
      '**Roles** (never expanded to users)',
      '',
      mdTable(
        ['Role', 'Includes subordinates'],
        data.roles.map((r) => [r.roleName ?? r.id, r.includesSubordinates ? 'yes' : 'no']),
      ),
    );
  }
  lines.push(
    '',
    data.vaultDeclaredMemberCount === null
      ? 'Vault cross-check: no declared member count in the vault for this group (membership is runtime data).'
      : `Vault cross-check: vault declared **${data.vaultDeclaredMemberCount}** member(s) at last refresh vs **${data.liveDirectMemberCount}** live direct member(s) — drift: ${data.drift ? 'YES' : 'no'}.`,
  );
  if (data.capped) {
    lines.push('', `Showing ${data.returned} of ${data.totalDirectMembers} direct member(s).`);
  }
  lines.push('', data.disclosure, '', renderTrustFooter(data.trust));
  return lines.join('\n');
};

/** Byte-fit loop (liveInactiveUsers invariant): trim the direct-user page until
 *  the serialized output fits; totalDirectMembers is never touched. */
const fitGroupMembers = (
  base: GroupMembersBase,
  allUsers: readonly GroupMemberUser[],
  pageEntryCount: number,
  extraNote: string | undefined,
): LiveGroupMembersOutput => {
  let slice: readonly GroupMemberUser[] = allUsers;
  let byteTrimmed = false;
  for (;;) {
    const returned = pageEntryCount - (allUsers.length - slice.length);
    const capped = byteTrimmed || base.totalDirectMembers > pageEntryCount;
    const noteText = [
      ...(extraNote !== undefined ? [extraNote] : []),
      ...(byteTrimmed
        ? [
            `User rows trimmed to ${slice.length} to stay within the response size limit; ` +
              `totalDirectMembers (${base.totalDirectMembers}) is the true count.`,
          ]
        : []),
    ].join(' ');
    const shape: Omit<LiveGroupMembersOutput, 'rendered'> = {
      ...base,
      returned,
      capped,
      users: slice,
      ...(noteText.length > 0 ? { note: noteText } : {}),
    };
    const rendered = renderGroupMembersMarkdown(shape);
    const bytes = Buffer.byteLength(JSON.stringify({ ...shape, rendered }), 'utf8');
    if (bytes <= MEMBERS_BYTE_BUDGET || slice.length <= 1) {
      return { ...shape, rendered };
    }
    slice = slice.slice(0, Math.max(1, Math.floor(slice.length * 0.85)));
    byteTrimmed = true;
  }
};

export const liveGroupMembersHandler = async (
  ctx: Context,
  input: LiveGroupMembersInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveGroupMembersOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const limit = input.limit ?? DEFAULT_MEMBER_ROWS;
  const lit = soqlLiteral(input.name);
  const typeClause =
    input.groupType === undefined || input.groupType === 'auto'
      ? `Type IN ('Queue', 'Regular')`
      : `Type = '${input.groupType}'`;

  const resolveQ = await liveQuery(
    org,
    `SELECT Id, Name, DeveloperName, Type FROM Group ` +
      `WHERE (DeveloperName = ${lit} OR Name = ${lit}) AND ${typeClause} LIMIT 3`,
    exec,
  );
  if (!resolveQ.available) return err(UNAVAILABLE_ERROR('Group', org, resolveQ.reason));
  if (resolveQ.records.length === 0) {
    return err({
      kind: 'component-not-found',
      message:
        `No queue or public group named '${input.name}' in the live org (probed Group by exact ` +
        `DeveloperName/Name${input.groupType && input.groupType !== 'auto' ? `, Type ${input.groupType}` : ''}). ` +
        `Check the API name — sfi.resolve can fix typos against the vault.`,
    });
  }
  if (resolveQ.records.length > 1) {
    const kinds = resolveQ.records.map((r) => String((r as LiveGroupRow).Type ?? '?')).join(' + ');
    return err({
      kind: 'invalid-query',
      message:
        `'${input.name}' matches ${resolveQ.records.length} Group records in the live org (${kinds}) — ` +
        `refusing to guess. Pass groupType ('Queue' | 'Regular') or the exact DeveloperName.`,
    });
  }
  const groupRow = resolveQ.records[0] as LiveGroupRow;
  const group = {
    id: String(groupRow.Id ?? ''),
    name: String(groupRow.Name ?? groupRow.DeveloperName ?? input.name),
    developerName: String(groupRow.DeveloperName ?? input.name),
    type: (groupRow.Type === 'Queue' ? 'Queue' : 'Regular') as 'Queue' | 'Regular',
  };

  // TRUE direct-member count first.
  const countQ = await liveQuery(
    org,
    `SELECT COUNT() FROM GroupMember WHERE GroupId = '${group.id}'`,
    exec,
  );
  if (!countQ.available) return err(UNAVAILABLE_ERROR('GroupMember', org, countQ.reason));
  const totalDirectMembers = countQ.total;

  const membersQ = await liveQuery(
    org,
    `SELECT Id, UserOrGroupId FROM GroupMember WHERE GroupId = '${group.id}' ORDER BY Id LIMIT ${limit}`,
    exec,
  );
  if (!membersQ.available) return err(UNAVAILABLE_ERROR('GroupMember', org, membersQ.reason));
  const memberIds = membersQ.records.map((r) =>
    String((r as { UserOrGroupId?: string }).UserOrGroupId ?? ''),
  );
  const directUserIds = memberIds.filter((id) => id.startsWith('005'));
  const nestedGroupIds = memberIds.filter((id) => id.startsWith('00G'));
  const unclassified = memberIds.filter((id) => !id.startsWith('005') && !id.startsWith('00G'));

  // Nested `00G` members: fetch their Group rows to split public groups from
  // Role / RoleAndSubordinates proxy groups (RelatedId → UserRole).
  let nestedRows: LiveGroupRow[] = [];
  if (nestedGroupIds.length > 0) {
    for (const chunk of idChunks(nestedGroupIds)) {
      const inList = chunk.map((id) => soqlLiteral(id)).join(', ');
      const q = await liveQuery(
        org,
        `SELECT Id, Name, DeveloperName, Type, RelatedId FROM Group WHERE Id IN (${inList})`,
        exec,
      );
      if (!q.available) return err(UNAVAILABLE_ERROR('Group', org, q.reason));
      nestedRows = nestedRows.concat(q.records as readonly LiveGroupRow[]);
    }
  }
  const roleRows = nestedRows.filter((r) => String(r.Type ?? '').startsWith('Role'));
  const publicNestedRows = nestedRows.filter((r) => !String(r.Type ?? '').startsWith('Role'));

  // Role names via UserRole (graceful degrade to null — a missing name is
  // shown as the raw id, never invented).
  const roleNameById = new Map<string, string>();
  const relatedIds = roleRows
    .map((r) => String(r.RelatedId ?? ''))
    .filter((id) => id.length > 0);
  if (relatedIds.length > 0) {
    const inList = relatedIds.map((id) => soqlLiteral(id)).join(', ');
    const q = await liveQuery(org, `SELECT Id, Name FROM UserRole WHERE Id IN (${inList})`, exec);
    if (!q.available && isBudgetExhaustedReason(q.reason)) {
      return err({ kind: 'invalid-query', message: redactSecrets(q.reason ?? 'live-query budget exhausted') });
    }
    if (q.available) {
      for (const r of q.records) {
        const row = r as { Id?: string; Name?: string };
        roleNameById.set(String(row.Id ?? ''), String(row.Name ?? ''));
      }
    }
  }
  const roles: GroupRoleEntry[] = roleRows.map((r) => {
    const relatedId = String(r.RelatedId ?? '');
    return {
      id: String(r.Id ?? ''),
      roleName: roleNameById.get(relatedId) ?? null,
      type: String(r.Type ?? 'Role'),
      includesSubordinates: String(r.Type ?? '').startsWith('RoleAndSubordinates'),
    };
  });

  // One-level nested expansion (opt-in, fail-closed).
  const expandNested = input.expandNested === true;
  const nestedMembersByGroup = new Map<string, string[]>();
  if (expandNested && publicNestedRows.length > 0) {
    const inList = publicNestedRows.map((r) => soqlLiteral(String(r.Id ?? ''))).join(', ');
    const q = await liveQuery(
      org,
      `SELECT GroupId, UserOrGroupId FROM GroupMember WHERE GroupId IN (${inList}) ORDER BY Id LIMIT ${MAX_MEMBER_ROWS}`,
      exec,
    );
    if (!q.available) return err(UNAVAILABLE_ERROR('GroupMember', org, q.reason));
    for (const r of q.records) {
      const row = r as { GroupId?: string; UserOrGroupId?: string };
      const gid = String(row.GroupId ?? '');
      const list = nestedMembersByGroup.get(gid) ?? [];
      list.push(String(row.UserOrGroupId ?? ''));
      nestedMembersByGroup.set(gid, list);
    }
  }

  // ONE batched User resolution across direct + expanded-nested user ids.
  const nestedUserIds = [...nestedMembersByGroup.values()]
    .flat()
    .filter((id) => id.startsWith('005'));
  const allUserIds = [...new Set([...directUserIds, ...nestedUserIds])];
  const usersR = await resolveMemberUsers(org, allUserIds, exec);
  if (!usersR.ok) return usersR;
  const userById = usersR.value;
  const toUser = (id: string): GroupMemberUser =>
    userById.get(id) ??
    userById.get(id.slice(0, 15)) ?? { id, name: '', username: '', isActive: false };

  const nestedGroups: NestedGroupEntry[] = publicNestedRows.map((r) => {
    const id = String(r.Id ?? '');
    const base = {
      id,
      name: String(r.DeveloperName ?? r.Name ?? id),
      type: String(r.Type ?? 'Regular'),
    };
    if (!expandNested) return base;
    const memberIdsOfGroup = nestedMembersByGroup.get(id) ?? [];
    const userMembers = memberIdsOfGroup.filter((m) => m.startsWith('005')).map(toUser);
    const unexpanded = memberIdsOfGroup.length - userMembers.length;
    return {
      ...base,
      members: userMembers,
      ...(unexpanded > 0 ? { unexpandedNestedCount: unexpanded } : {}),
    };
  });

  // Queues: which sObject types the queue can own (q267). Graceful degrade —
  // but a budget stop is an honest stop, not a silent omission.
  let supportedObjects: string[] | undefined;
  if (group.type === 'Queue') {
    const q = await liveQuery(
      org,
      `SELECT SobjectType FROM QueueSobject WHERE QueueId = '${group.id}'`,
      exec,
    );
    if (!q.available && isBudgetExhaustedReason(q.reason)) {
      return err({ kind: 'invalid-query', message: redactSecrets(q.reason ?? 'live-query budget exhausted') });
    }
    if (q.available) {
      supportedObjects = q.records
        .map((r) => String((r as { SobjectType?: string }).SobjectType ?? ''))
        .filter((s) => s.length > 0)
        .sort();
    }
  }

  // Vault cross-check: DECLARED metadata member count (Queue:/Group: node).
  // Absent vault / absent node / unreadable graph all degrade to null — the
  // live answer never depends on the vault.
  let vaultDeclaredMemberCount: number | null = null;
  if (ctx.graph !== undefined && ctx.graph !== null) {
    const vaultId = `${group.type === 'Queue' ? 'Queue' : 'Group'}:${group.developerName}`;
    const nodeR = await getNodeById(ctx.graph, vaultId);
    if (nodeR.ok && nodeR.value !== null) {
      const declared = nodeR.value.properties['memberCount'];
      if (typeof declared === 'number') vaultDeclaredMemberCount = declared;
    }
  }
  const drift =
    vaultDeclaredMemberCount !== null && vaultDeclaredMemberCount !== totalDirectMembers;

  const extraNote =
    unclassified.length > 0
      ? `${unclassified.length} GroupMember row(s) carry an id prefix that is neither User (005) nor Group (00G) — listed in no bucket, but counted in totalDirectMembers.`
      : undefined;

  return ok({
    data: fitGroupMembers(
      {
        group,
        ...(supportedObjects !== undefined ? { supportedObjects } : {}),
        totalDirectMembers,
        nestedGroups,
        roles,
        expansion: expandNested ? 'partial-one-level' : 'none',
        vaultDeclaredMemberCount,
        liveDirectMemberCount: totalDirectMembers,
        drift,
        disclosure: GROUP_MEMBERS_DISCLOSURE,
        trust: liveTrust(queriedAt),
      },
      directUserIds.map(toUser),
      memberIds.length,
      extraNote,
    ),
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_user_permsets — WHAT does USER X hold (reverse of permset_holders)
// ---------------------------------------------------------------------------
//
// ENGINE-ARC §3. A SEPARATE contract from sfi.live_permset_holders: input is a
// USER, output is the grantors they hold (profile + direct permission sets +
// permission set groups, with expirations). Folding this into permset_holders
// as a `direction` flag would bloat one Zod schema with two disjoint shapes —
// separate tool, same file, shared query helpers.
//
// Dual-provenance pairing: this tool answers WHICH grantors the user holds
// (live, point-in-time); vault sfi.effective_permissions answers WHAT those
// grantors grant. Neither substitutes for the other.
//
// The PSA query pins `PermissionSet.IsOwnedByProfile = false` — every user
// carries a system PSA row for their profile-owned permission set, and without
// the filter that system row would masquerade as a direct assignment. The
// profile is reported from User.Profile.Name instead, labeled as the profile.

const MAX_USER_PERMSET_ROWS = 500;
const DEFAULT_USER_PERMSET_ROWS = 200;
const USER_PERMSETS_BYTE_BUDGET = 36_000;

/** Verbatim disclosure (ENGINE-ARC §3) — tool description + rendered footer. */
export const USER_PERMSETS_DISCLOSURE =
  'Live = WHICH grantors this user holds right now (point-in-time as of queriedAt); vault sfi.effective_permissions = WHAT those grantors grant — pair them for a dual-provenance answer. The PROFILE grants permissions too: it is named here but its contents are not enumerated. Read-only.';

export const liveUserPermsetsInputSchema = liveEnabledSchema.extend({
  /** Exact Username (preferred — unique) or exact User.Name. An ambiguous name
   *  returns an honest candidate list, never a guess. */
  user: z.string().min(1),
  /** Max assignment rows (default 200, hard cap 500); a ~36 KB byte budget may
   *  trim further. `totalAssignments` is always the TRUE count. */
  limit: z.number().int().min(1).max(MAX_USER_PERMSET_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveUserPermsetsInput = z.infer<typeof liveUserPermsetsInputSchema>;

export interface UserPermsetGrant {
  readonly assignmentId: string;
  readonly permissionSetName: string;
  readonly permissionSetLabel: string | null;
  readonly expirationDate: string | null;
}

export interface UserPermsetsViaGroup {
  readonly groupName: string;
  readonly permsets: readonly UserPermsetGrant[];
}

export interface LiveUserPermsetsOutput {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly username: string;
    readonly isActive: boolean;
    /** The profile grantor — named, not enumerated (see disclosure). */
    readonly profileName: string | null;
  };
  /** TRUE count of non-expired, non-profile-owned PSA rows for this user. */
  readonly totalAssignments: number;
  /** PSA rows excluded because ExpirationDate has passed — disclosed, not dropped. */
  readonly expiredExcluded: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly directPermsets: readonly UserPermsetGrant[];
  readonly viaGroups: readonly UserPermsetsViaGroup[];
  readonly disclosure: string;
  readonly trust: TrustSummary;
  readonly rendered: string;
  readonly note?: string;
}

interface UserPsaRow {
  readonly Id?: string;
  readonly ExpirationDate?: string | null;
  readonly PermissionSetGroupId?: string | null;
  readonly PermissionSetGroup?: { readonly DeveloperName?: string } | null;
  readonly PermissionSet?: { readonly Name?: string; readonly Label?: string } | null;
}

/** A PSA row, tagged with the PSG it arrived through (null = direct). */
interface TaggedUserGrant extends UserPermsetGrant {
  readonly viaGroup: string | null;
}

type UserPermsetsBase = Pick<
  LiveUserPermsetsOutput,
  'user' | 'totalAssignments' | 'expiredExcluded' | 'disclosure' | 'trust'
>;

const renderUserPermsetsMarkdown = (data: Omit<LiveUserPermsetsOutput, 'rendered'>): string => {
  const direct = data.directPermsets.length;
  const via = data.viaGroups.reduce((n, g) => n + g.permsets.length, 0);
  const lines: string[] = [
    `### Live permission-set holdings for ${data.user.name} (\`${data.user.username}\`)`,
    '',
    `Profile: **${data.user.profileName ?? '(none)'}**${data.user.isActive ? '' : ' — user is INACTIVE'}.`,
    '',
    `**${data.totalAssignments.toLocaleString('en-US')}** assignment(s)` +
      ` (${direct} direct, ${via} via group(s) on this page)` +
      (data.expiredExcluded > 0 ? `; ${data.expiredExcluded} expired assignment(s) excluded` : '') +
      '.',
  ];
  const grantRows = (grants: readonly UserPermsetGrant[]) =>
    mdTable(
      ['Permission set', 'Label', 'Expires'],
      grants.map((g) => [g.permissionSetName, g.permissionSetLabel ?? '—', g.expirationDate ?? '—']),
    );
  if (data.directPermsets.length > 0) {
    lines.push('', '**Direct permission sets**', '', grantRows(data.directPermsets));
  }
  for (const g of data.viaGroups) {
    lines.push('', `**Via permission set group \`${g.groupName}\`**`, '', grantRows(g.permsets));
  }
  if (data.capped) {
    lines.push('', `Showing ${data.returned} of ${data.totalAssignments} assignment(s).`);
  }
  lines.push('', data.disclosure, '', renderTrustFooter(data.trust));
  return lines.join('\n');
};

/** Byte-fit loop: trim assignment rows until the output fits; totalAssignments
 *  is never touched, so a trimmed page never understates the holdings. */
const fitUserPermsets = (
  base: UserPermsetsBase,
  allRows: readonly TaggedUserGrant[],
): LiveUserPermsetsOutput => {
  let slice: readonly TaggedUserGrant[] = allRows;
  let byteTrimmed = false;
  for (;;) {
    const returned = slice.length;
    const capped = byteTrimmed || base.totalAssignments > returned;
    const direct: UserPermsetGrant[] = [];
    const byGroup = new Map<string, UserPermsetGrant[]>();
    for (const row of slice) {
      const { viaGroup, ...grant } = row;
      if (viaGroup === null) {
        direct.push(grant);
      } else {
        const list = byGroup.get(viaGroup) ?? [];
        list.push(grant);
        byGroup.set(viaGroup, list);
      }
    }
    const shape: Omit<LiveUserPermsetsOutput, 'rendered'> = {
      ...base,
      returned,
      capped,
      directPermsets: direct,
      viaGroups: [...byGroup.entries()].map(([groupName, permsets]) => ({ groupName, permsets })),
      ...(byteTrimmed
        ? {
            note:
              `Assignment rows trimmed to ${returned} to stay within the response size limit; ` +
              `totalAssignments (${base.totalAssignments}) is the true count.`,
          }
        : {}),
    };
    const rendered = renderUserPermsetsMarkdown(shape);
    const bytes = Buffer.byteLength(JSON.stringify({ ...shape, rendered }), 'utf8');
    if (bytes <= USER_PERMSETS_BYTE_BUDGET || slice.length <= 1) {
      return { ...shape, rendered };
    }
    slice = slice.slice(0, Math.max(1, Math.floor(slice.length * 0.85)));
    byteTrimmed = true;
  }
};

export const liveUserPermsetsHandler = async (
  ctx: Context,
  input: LiveUserPermsetsInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveUserPermsetsOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const limit = input.limit ?? DEFAULT_USER_PERMSET_ROWS;
  const lit = soqlLiteral(input.user);
  const nowLiteral = soqlDateTime(new Date());
  const userSelect = `SELECT Id, Name, Username, IsActive, Profile.Name FROM User`;

  // Resolve: exact Username first (unique in an org), then exact Name.
  let userRow: (HolderUserRow & { Profile?: { Name?: string } | null }) | undefined;
  const byUsername = await liveQuery(org, `${userSelect} WHERE Username = ${lit} LIMIT 2`, exec);
  if (!byUsername.available) return err(UNAVAILABLE_ERROR('User', org, byUsername.reason));
  if (byUsername.records.length === 1) {
    userRow = byUsername.records[0] as HolderUserRow;
  } else {
    const byName = await liveQuery(org, `${userSelect} WHERE Name = ${lit} LIMIT 5`, exec);
    if (!byName.available) return err(UNAVAILABLE_ERROR('User', org, byName.reason));
    if (byName.records.length === 0) {
      return err({
        kind: 'component-not-found',
        message:
          `No user with exact Username or Name '${input.user}' in the live org. ` +
          `Usernames are unique — prefer the full Username.`,
      });
    }
    if (byName.records.length > 1) {
      const candidates = byName.records
        .map((r) => String((r as HolderUserRow).Username ?? ''))
        .filter((u) => u.length > 0)
        .join(', ');
      return err({
        kind: 'invalid-query',
        message:
          `'${input.user}' matches ${byName.records.length} users in the live org — refusing to guess. ` +
          `Pass the exact Username. Candidates: ${candidates}.`,
      });
    }
    userRow = byName.records[0] as HolderUserRow;
  }
  const user = {
    id: String(userRow.Id ?? ''),
    name: String(userRow.Name ?? ''),
    username: String(userRow.Username ?? ''),
    isActive: userRow.IsActive === true,
    profileName: userRow.Profile?.Name ?? null,
  };

  // THE FILTER (see module note): IsOwnedByProfile = false keeps the user's
  // profile-owned system PSA row from masquerading as a direct assignment.
  const scope =
    `AssigneeId = '${user.id}' AND PermissionSet.IsOwnedByProfile = false`;
  const notExpiredClause = ` AND (ExpirationDate = null OR ExpirationDate >= ${nowLiteral})`;

  const countQ = await liveQuery(
    org,
    `SELECT COUNT() FROM PermissionSetAssignment WHERE ${scope}${notExpiredClause}`,
    exec,
  );
  if (!countQ.available) {
    return err(UNAVAILABLE_ERROR('PermissionSetAssignment', org, countQ.reason));
  }
  const totalAssignments = countQ.total;

  const expiredQ = await liveQuery(
    org,
    `SELECT COUNT() FROM PermissionSetAssignment WHERE ${scope} AND ExpirationDate < ${nowLiteral}`,
    exec,
  );
  const expiredExcluded = expiredQ.available ? expiredQ.total : 0;

  // ORDER BY Id, NOT `ORDER BY PermissionSet.Name` — probe-verified on a real
  // org (2026-07-02): ordering by the relationship field silently DROPS PSA
  // rows whose permission set is license-backed (e.g. `CodeBuilderUserPsl`),
  // so the roster would enumerate 42 rows while honestly counting 43 — and
  // the missing grantor could never appear on ANY page. Ordering by Id keeps
  // every row enumerable; the page is sorted by name client-side below.
  const detailQ = await liveQuery(
    org,
    `SELECT Id, PermissionSet.Name, PermissionSet.Label, PermissionSetGroupId, ` +
      `PermissionSetGroup.DeveloperName, ExpirationDate FROM PermissionSetAssignment ` +
      `WHERE ${scope}${notExpiredClause} ORDER BY Id LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) {
    return err(UNAVAILABLE_ERROR('PermissionSetAssignment', org, detailQ.reason));
  }
  const rows: TaggedUserGrant[] = (detailQ.records as readonly UserPsaRow[])
    .map((r) => ({
      assignmentId: String(r.Id ?? ''),
      permissionSetName: String(r.PermissionSet?.Name ?? ''),
      permissionSetLabel: r.PermissionSet?.Label ?? null,
      expirationDate: r.ExpirationDate ?? null,
      viaGroup: r.PermissionSetGroupId
        ? (r.PermissionSetGroup?.DeveloperName ?? String(r.PermissionSetGroupId))
        : null,
    }))
    .sort((a, b) => a.permissionSetName.localeCompare(b.permissionSetName));

  return ok({
    data: fitUserPermsets(
      {
        user,
        totalAssignments,
        expiredExcluded,
        disclosure: USER_PERMSETS_DISCLOSURE,
        trust: liveTrust(queriedAt),
      },
      rows,
    ),
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_record_access — a user's EFFECTIVE access to ONE record (live)
// ---------------------------------------------------------------------------
//
// UserRecordAccess is a runtime-only object: it answers "can user U read / edit
// / delete / transfer / fully-control THIS specific record R right now?" from
// the org's live sharing calculation. This is the exact question
// sfi.why_cant_user_see_record can only answer `unknown` for offline — manual
// shares, account/opportunity teams, Apex managed sharing, and criteria sharing
// evaluated over record FIELD VALUES are all record-level state the vault never
// holds. This tool RESOLVES that unknown against the live org. Read-only.

/** A Salesforce 15- or 18-char record/user Id. */
const RECORD_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

/**
 * Validate a Salesforce record/user Id shape before it reaches SOQL. The value
 * is ALSO bound through {@link soqlLiteral} at the call site (belt and
 * suspenders) — this check fails fast on garbage with a legible message rather
 * than shipping a malformed literal to the org.
 */
const assertRecordId = (raw: string, label: string): Result<string, McpError> => {
  const trimmed = raw.trim();
  if (!RECORD_ID_RE.test(trimmed)) {
    return err({
      kind: 'invalid-query',
      message: `${label} must be a 15- or 18-character Salesforce record Id.`,
      path: label,
    });
  }
  return ok(trimmed);
};

/** The reusable descriptor for a record-scoped sibling object. */
export interface SiblingObject {
  /** The `{Object}Share` / `{Object}History` sibling API name. */
  readonly object: string;
  /** The field on the sibling that points at the parent record's Id. */
  readonly parentField: string;
  /** True when the base object is a custom object (`__c`). */
  readonly isCustom: boolean;
}

/**
 * Derive a record-scoped sibling object (`{Object}Share` / `{Object}History`)
 * and its parent-Id field from a base object API name, following Salesforce's
 * standard-vs-custom naming rule — the SHARED SOQL builder for the record-shares
 * (CR-CAP-L2) and field-history (R6-14) tools:
 *   - Standard object `Account` → `Account{Suffix}`, parent field `AccountId`.
 *   - Custom object `Widget__c`  → `Widget__{Suffix}`, parent field `ParentId`.
 *
 * Returns null when the base name is not a safe API name (SOQL-injection guard;
 * the caller surfaces the invalid-name error). The derivation follows the
 * documented convention — a non-conforming object simply produces a sibling name
 * the org will reject as not-queryable, which the caller reports honestly rather
 * than as a match.
 */
export const deriveSiblingObject = (
  objectApiName: string,
  suffix: 'Share' | 'History',
): SiblingObject | null => {
  const trimmed = objectApiName.trim();
  if (!OBJECT_API_NAME_RE.test(trimmed)) return null;
  if (/__c$/.test(trimmed)) {
    const base = trimmed.replace(/__c$/, '');
    return { object: `${base}__${suffix}`, parentField: 'ParentId', isCustom: true };
  }
  return { object: `${trimmed}${suffix}`, parentField: `${trimmed}Id`, isCustom: false };
};

/**
 * Resolve the object API name for a record Id from the org's GLOBAL describe
 * (`/sobjects`), matching the 3-char key prefix. Read-only, budgeted (one REST
 * unit). Refuses to guess: a prefix that maps to zero or MULTIPLE objects is an
 * honest error asking for an explicit `objectApiName` rather than a wrong match.
 */
const resolveObjectFromRecordId = async (
  org: string,
  recordId: string,
  exec: ExecCommand,
): Promise<Result<string, McpError>> => {
  const prefix = recordId.slice(0, 3);
  const rest = await runLiveRest(org, '/sobjects', exec);
  if (!rest.ok) return rest;
  const body = rest.value.value as {
    sobjects?: readonly { name?: string; keyPrefix?: string | null }[];
  };
  const matches = (body.sobjects ?? [])
    .filter((s) => s.keyPrefix === prefix)
    .map((s) => String(s.name ?? ''))
    .filter((n) => n.length > 0);
  if (matches.length === 1) return ok(matches[0] as string);
  if (matches.length === 0) {
    return err({
      kind: 'invalid-query',
      message: `Could not derive the object for record Id prefix '${prefix}' from the org describe — pass objectApiName explicitly.`,
      path: 'recordId',
    });
  }
  return err({
    kind: 'invalid-query',
    message: `Record Id prefix '${prefix}' maps to multiple objects (${matches.join(', ')}) — pass objectApiName explicitly.`,
    path: 'objectApiName',
  });
};

export const liveRecordAccessInputSchema = liveEnabledSchema.extend({
  /** The record whose access is being checked (15- or 18-char Id). */
  recordId: z.string().min(1),
  /** The user to check, by Id. Provide this OR `username` (userId wins). */
  userId: z.string().min(1).optional(),
  /** The user to check, by exact Username (resolved to an Id via a capped
   *  lookup). Provide this OR `userId`. */
  username: z.string().min(1).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveRecordAccessInput = z.infer<typeof liveRecordAccessInputSchema>;

export interface LiveRecordAccessUser {
  readonly id: string;
  readonly name: string | null;
  readonly username: string | null;
}
export interface LiveRecordAccessOutput {
  readonly recordId: string;
  readonly user: LiveRecordAccessUser;
  readonly hasReadAccess: boolean;
  readonly hasEditAccess: boolean;
  readonly hasDeleteAccess: boolean;
  readonly hasTransferAccess: boolean;
  readonly hasAllAccess: boolean;
  /**
   * True when the org returned NO UserRecordAccess row for this (user, record)
   * pair — the record does not exist, is not visible to the QUERYING user, or
   * the id is wrong. Every access flag is then false and MUST NOT be read as an
   * authoritative "no access"; it is "could not determine".
   */
  readonly noAccessRow: boolean;
  readonly disclosure: string;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

/** Verbatim disclosure — tool description + rendered footer. */
export const LIVE_RECORD_ACCESS_DISCLOSURE =
  "Live effective record access from the org's runtime sharing calculation " +
  '(UserRecordAccess) as of queriedAt — it reflects manual shares, teams, Apex ' +
  'managed sharing, and criteria sharing evaluated over record field values, ' +
  'none of which the offline vault can see. Point-in-time; not cached beyond the ' +
  'live-session TTL. An empty result (noAccessRow) means the org returned no ' +
  'access row for this user+record (record missing, wrong id, or invisible to ' +
  'the querying user) — treat it as "could not determine", NOT a confirmed deny.';

export const liveRecordAccessHandler = async (
  ctx: Context,
  input: LiveRecordAccessInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveRecordAccessOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const recordCheck = assertRecordId(input.recordId, 'recordId');
  if (!recordCheck.ok) return recordCheck;
  const recordId = recordCheck.value;
  if (input.userId === undefined && input.username === undefined) {
    return err({
      kind: 'invalid-query',
      message:
        'Provide userId or username — UserRecordAccess is evaluated for a specific user.',
      path: 'userId',
    });
  }
  const queriedAt = new Date().toISOString();

  // Resolve the user: an explicit userId is authoritative (name resolved
  // best-effort, degrading to null); a username MUST resolve to exactly one Id.
  let user: LiveRecordAccessUser;
  if (input.userId !== undefined) {
    const uc = assertRecordId(input.userId, 'userId');
    if (!uc.ok) return uc;
    const userId = uc.value;
    const uq = await liveQuery(
      org,
      `SELECT Id, Name, Username FROM User WHERE Id = ${soqlLiteral(userId)} LIMIT 1`,
      exec,
    );
    const r = uq.available ? (uq.records[0] as Record<string, unknown> | undefined) : undefined;
    user = {
      id: userId,
      name: r?.Name != null ? String(r.Name) : null,
      username: r?.Username != null ? String(r.Username) : null,
    };
  } else {
    const username = input.username as string;
    const uq = await liveQuery(
      org,
      `SELECT Id, Name, Username FROM User WHERE Username = ${soqlLiteral(username)} LIMIT 2`,
      exec,
    );
    if (!uq.available) return err(UNAVAILABLE_ERROR('User', org, uq.reason));
    if (uq.records.length === 0) {
      return err({
        kind: 'component-not-found',
        message: `No user with exact Username '${username}' in the live org. Usernames are unique — pass the exact Username or a userId.`,
      });
    }
    if (uq.records.length > 1) {
      return err({
        kind: 'invalid-query',
        message: `'${username}' matches multiple users in the live org — pass the exact Username or a userId.`,
      });
    }
    const r = uq.records[0] as Record<string, unknown>;
    user = {
      id: String(r.Id ?? ''),
      name: r.Name != null ? String(r.Name) : null,
      username: r.Username != null ? String(r.Username) : null,
    };
  }

  const accessQ = await liveQuery(
    org,
    `SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess, HasTransferAccess, HasAllAccess ` +
      `FROM UserRecordAccess WHERE UserId = ${soqlLiteral(user.id)} AND RecordId = ${soqlLiteral(recordId)}`,
    exec,
  );
  if (!accessQ.available) return err(UNAVAILABLE_ERROR('UserRecordAccess', org, accessQ.reason));
  const row = accessQ.records[0] as Record<string, unknown> | undefined;
  const noAccessRow = row === undefined;
  const flag = (k: string): boolean => row?.[k] === true;
  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Right', 'Granted'],
    [
      ['Read', flag('HasReadAccess') ? 'yes' : 'no'],
      ['Edit', flag('HasEditAccess') ? 'yes' : 'no'],
      ['Delete', flag('HasDeleteAccess') ? 'yes' : 'no'],
      ['Transfer', flag('HasTransferAccess') ? 'yes' : 'no'],
      ['Full (All)', flag('HasAllAccess') ? 'yes' : 'no'],
    ],
  );
  const who = user.name ?? user.username ?? user.id;
  const rendered =
    (noAccessRow
      ? `> No UserRecordAccess row for **${who}** on record \`${recordId}\` — could NOT determine access (record missing, wrong id, or invisible to the querying user), NOT a confirmed deny.\n\n`
      : `Effective access for **${who}** on record \`${recordId}\`:\n\n`) +
    `${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      recordId,
      user,
      hasReadAccess: flag('HasReadAccess'),
      hasEditAccess: flag('HasEditAccess'),
      hasDeleteAccess: flag('HasDeleteAccess'),
      hasTransferAccess: flag('HasTransferAccess'),
      hasAllAccess: flag('HasAllAccess'),
      noAccessRow,
      disclosure: LIVE_RECORD_ACCESS_DISCLOSURE,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_record_shares — the explicit share rows on ONE record (live)
// ---------------------------------------------------------------------------
//
// The `{Object}Share` table is runtime sharing state the vault never holds:
// each row is a UserOrGroupId + AccessLevel + RowCause (why the share exists —
// Owner, Manual, a sharing Rule, a Team, Apex managed sharing, etc.). This is
// the shares-of-a-record complement to sfi.live_record_access (a user's
// effective access): it enumerates WHO the record is explicitly shared with and
// WHY. Objects whose OWD is Public Read/Write have no Share table at all — that
// is reported honestly, not as an error. Read-only.

const MAX_SHARE_ROWS = 500;
const DEFAULT_SHARE_ROWS = 200;

export const liveRecordSharesInputSchema = liveEnabledSchema.extend({
  /** The record whose explicit shares are being listed (15- or 18-char Id). */
  recordId: z.string().min(1),
  /** The record's object API name. Optional — when omitted it is derived from
   *  the Id's key prefix via the org's global describe (an ambiguous or unknown
   *  prefix is an honest error asking for this field). */
  objectApiName: z.string().min(1).optional(),
  /** Max share rows (default 200, hard cap 500). `totalShares` is the true count. */
  limit: z.number().int().min(1).max(MAX_SHARE_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveRecordSharesInput = z.infer<typeof liveRecordSharesInputSchema>;

export interface RecordShareEntry {
  readonly userOrGroupId: string;
  readonly userOrGroupName: string | null;
  readonly accessLevel: string;
  readonly rowCause: string | null;
}
export interface LiveRecordSharesOutput {
  readonly recordId: string;
  readonly objectApiName: string;
  readonly shareObject: string;
  /**
   * False when the `{Object}Share` object could not be queried — the record's
   * OWD is likely Public Read/Write (rows are implicitly shared, so there is NO
   * Share table) OR the object is not sharable / not exposed for this edition.
   * When false, `shares` is empty and the ABSENCE is disclosed, never read as
   * "no one has access".
   */
  readonly shareTableQueryable: boolean;
  readonly totalShares: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly shares: readonly RecordShareEntry[];
  readonly disclosure: string;
  readonly trust: TrustSummary;
  /** Present when `shareTableQueryable` is false — explains the absence. */
  readonly note?: string;
  readonly rendered: string;
}

/** Verbatim disclosure — tool description + rendered footer. */
export const LIVE_RECORD_SHARES_DISCLOSURE =
  'Live explicit sharing rows from the runtime `{Object}Share` table as of ' +
  'queriedAt — each row is a UserOrGroupId + AccessLevel + RowCause (Owner / ' +
  'Manual / a sharing Rule / a Team / Apex managed sharing). This is runtime ' +
  'state the offline vault never holds. IMPORTANT: an object whose OWD is ' +
  'Public Read/Write has NO Share table (rows are implicitly shared) — an empty ' +
  'or non-queryable result there means "no explicit shares apply", NOT "no one ' +
  'has access". Point-in-time; not cached beyond the live-session TTL; read-only.';

export const liveRecordSharesHandler = async (
  ctx: Context,
  input: LiveRecordSharesInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveRecordSharesOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const recordCheck = assertRecordId(input.recordId, 'recordId');
  if (!recordCheck.ok) return recordCheck;
  const recordId = recordCheck.value;

  // Resolve the object: explicit objectApiName wins; else derive from the Id
  // key prefix via the global describe (refuses to guess on ambiguity).
  let objectApiName: string;
  if (input.objectApiName !== undefined) {
    const objCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
    if (!objCheck.ok) return objCheck;
    objectApiName = objCheck.value;
  } else {
    const resolved = await resolveObjectFromRecordId(org, recordId, exec);
    if (!resolved.ok) return resolved;
    objectApiName = resolved.value;
  }

  const sibling = deriveSiblingObject(objectApiName, 'Share');
  if (sibling === null) {
    return err({
      kind: 'invalid-query',
      message: `objectApiName "${objectApiName}" is not a valid Salesforce object API name.`,
      path: 'objectApiName',
    });
  }
  const queriedAt = new Date().toISOString();
  const limit = input.limit ?? DEFAULT_SHARE_ROWS;
  const trust = liveTrust(queriedAt);

  const detailQ = await liveQuery(
    org,
    `SELECT UserOrGroupId, AccessLevel, RowCause FROM ${sibling.object} ` +
      `WHERE ${sibling.parentField} = ${soqlLiteral(recordId)} ORDER BY RowCause LIMIT ${limit}`,
    exec,
  );
  // A non-queryable Share object is the OWD-Public / non-sharable case: report
  // it honestly as "no Share table" rather than a hard failure. A budget stop is
  // the ONE non-queryable reason that IS a hard fail (a partial answer would be
  // silently wrong), so surface it through UNAVAILABLE_ERROR.
  if (!detailQ.available) {
    if (isBudgetExhaustedReason(detailQ.reason)) {
      return err(UNAVAILABLE_ERROR(sibling.object, org, detailQ.reason));
    }
    const note =
      `The ${sibling.object} object could not be queried — ${objectApiName}'s OWD is ` +
      `likely Public Read/Write (no explicit shares exist) or the object is not sharable / ` +
      `not exposed for this edition. Absence of a Share table is NOT "no access".` +
      (detailQ.reason ? ` Underlying: ${redactSecrets(detailQ.reason).slice(0, 120)}` : '');
    const rendered =
      `> ${note}\n\n${renderTrustFooter(trust)}`;
    return ok({
      data: {
        recordId,
        objectApiName,
        shareObject: sibling.object,
        shareTableQueryable: false,
        totalShares: 0,
        returned: 0,
        capped: false,
        shares: [],
        disclosure: LIVE_RECORD_SHARES_DISCLOSURE,
        note,
        trust,
        rendered,
      },
      vaultState: livePlaneVaultState(ctx),
    });
  }

  const totalQ = await liveQuery(
    org,
    `SELECT COUNT() FROM ${sibling.object} WHERE ${sibling.parentField} = ${soqlLiteral(recordId)}`,
    exec,
  );
  const totalShares = totalQ.available ? totalQ.total : detailQ.records.length;

  // Resolve UserOrGroupId → names (User 005 or Group 00G), degrading silently to
  // the raw id and naming a budget stop rather than hiding it.
  const ids = detailQ.records
    .map((row) => String((row as Record<string, unknown>).UserOrGroupId ?? ''))
    .filter((id) => id.length > 0);
  const nameById = new Map<string, string>();
  let nameResolutionBudgetStopped = false;
  if (ids.length > 0) {
    const inList = [...new Set(ids)].map((id) => soqlLiteral(id)).join(',');
    const userQ = await liveQuery(org, `SELECT Id, Name FROM User WHERE Id IN (${inList})`, exec);
    if (userQ.available) {
      for (const row of userQ.records) {
        const r = row as Record<string, unknown>;
        nameById.set(String(r.Id ?? ''), String(r.Name ?? ''));
      }
    } else if (isBudgetExhaustedReason(userQ.reason)) {
      nameResolutionBudgetStopped = true;
    }
    const unresolved = [...new Set(ids)].filter((id) => !nameById.has(id));
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

  const shares: RecordShareEntry[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    const id = String(r.UserOrGroupId ?? '');
    return {
      userOrGroupId: id,
      userOrGroupName: nameById.get(id) ?? null,
      accessLevel: String(r.AccessLevel ?? ''),
      rowCause: r.RowCause === undefined || r.RowCause === null ? null : String(r.RowCause),
    };
  });
  const table = mdTable(
    ['Shared with', 'Access', 'Reason'],
    shares
      .slice(0, LIVE_TABLE_ROW_CAP)
      .map((s) => [s.userOrGroupName ?? s.userOrGroupId, s.accessLevel, s.rowCause ?? '—']),
  );
  const rendered =
    `**${totalShares.toLocaleString('en-US')}** explicit share row(s) on ${objectApiName} record \`${recordId}\` (via ${sibling.object}).` +
    (nameResolutionBudgetStopped ? `\n\n> ${BUDGET_SIGNAL} Names show as IDs.` : '') +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      recordId,
      objectApiName,
      shareObject: sibling.object,
      shareTableQueryable: true,
      totalShares,
      returned: shares.length,
      capped: totalShares > shares.length,
      shares,
      disclosure: LIVE_RECORD_SHARES_DISCLOSURE,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_scheduled_jobs — the RUNTIME schedule registry (live)
// ---------------------------------------------------------------------------
//
// The live half of the offline sfi.scheduled_job_catalog. The catalog lists
// Schedulable-CAPABLE Apex classes from metadata (schedule-capable, not
// necessarily currently scheduled — the actual schedule is runtime state). This
// tool reads the CronTrigger registry (with CronJobDetail.Name / JobType) — what
// is ACTUALLY scheduled right now — plus an optional recent AsyncApexJob status
// summary. Read-only.

const MAX_CRON_ROWS = 500;
const DEFAULT_CRON_ROWS = 200;
const DEFAULT_ASYNC_SUMMARY_DAYS = 7;
/** CronJobDetail.JobType code for Scheduled Apex (per Salesforce docs). Used
 *  ONLY for the count-only cross-reference against the static catalog; the raw
 *  JobType is always surfaced so a code-map drift never hides a row. */
const SCHEDULED_APEX_JOBTYPE = '7';

export const liveScheduledJobsInputSchema = liveEnabledSchema.extend({
  /** Max CronTrigger rows (default 200, hard cap 500). `totalCronJobs` is the
   *  true count. */
  limit: z.number().int().min(1).max(MAX_CRON_ROWS).optional(),
  /** Include a recent AsyncApexJob status summary (default true). */
  includeAsyncApexJobs: z.boolean().optional(),
  /** Window (days) for the AsyncApexJob summary (default 7). */
  asyncDays: z.number().int().min(1).max(90).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveScheduledJobsInput = z.infer<typeof liveScheduledJobsInputSchema>;

export interface ScheduledJobEntry {
  readonly id: string;
  readonly name: string | null;
  readonly jobType: string | null;
  readonly state: string | null;
  readonly cronExpression: string | null;
  readonly nextFireTime: string | null;
  readonly previousFireTime: string | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly timesTriggered: number | null;
}
export interface AsyncApexJobStatusCount {
  readonly status: string;
  readonly count: number;
}
export interface LiveScheduledJobsOutput {
  readonly totalCronJobs: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly jobs: readonly ScheduledJobEntry[];
  /** Count-only cross-reference (see disclosure): schedulable-CAPABLE Apex
   *  classes the vault knows vs live cron jobs registered as Scheduled Apex.
   *  `null` when the vault could not be read. Capped at 500. */
  readonly staticSchedulableClassCount: number | null;
  /** ORG-WIDE count of cron registrations of Scheduled-Apex type (a dedicated
   *  COUNT query, NOT limited to the returned page — the page cap would badly
   *  understate it on large orgs). Falls back to the returned-page count only if
   *  the count query is unavailable. */
  readonly liveScheduledApexCount: number;
  /** Recent AsyncApexJob status counts (omitted when not requested / not
   *  queryable). */
  readonly asyncApexJobSummary?: {
    readonly days: number;
    readonly byStatus: readonly AsyncApexJobStatusCount[];
    readonly total: number;
  };
  readonly disclosure: string;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

/** Verbatim disclosure — tool description + rendered footer. */
export const LIVE_SCHEDULED_JOBS_DISCLOSURE =
  'Live runtime schedule registry (CronTrigger + CronJobDetail) as of queriedAt. ' +
  'The static sfi.scheduled_job_catalog lists Schedulable-CAPABLE Apex classes ' +
  '(metadata — schedule-capable, not necessarily scheduled); THIS tool lists what ' +
  'is ACTUALLY scheduled in the org. The two measure DIFFERENT things and ' +
  'routinely differ — a Schedulable class may not currently be scheduled, and a ' +
  'cron job may run managed-package or non-Apex work (Data Export, Dashboard ' +
  'Refresh) that no catalog class covers. The class-vs-cron cross-reference is ' +
  'COUNT-ONLY (JobType matching is best-effort); do not pair a specific class to a ' +
  'specific cron row from these counts. Read-only; point-in-time.';

export const liveScheduledJobsHandler = async (
  ctx: Context,
  input: LiveScheduledJobsInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveScheduledJobsOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const queriedAt = new Date().toISOString();
  const limit = input.limit ?? DEFAULT_CRON_ROWS;
  const includeAsync = input.includeAsyncApexJobs ?? true;
  const asyncDays = input.asyncDays ?? DEFAULT_ASYNC_SUMMARY_DAYS;

  const totalQ = await liveQuery(org, 'SELECT COUNT() FROM CronTrigger', exec);
  if (!totalQ.available) return err(UNAVAILABLE_ERROR('CronTrigger', org, totalQ.reason));

  const detailQ = await liveQuery(
    org,
    `SELECT Id, CronJobDetail.Name, CronJobDetail.JobType, State, CronExpression, ` +
      `NextFireTime, PreviousFireTime, StartTime, EndTime, TimesTriggered FROM CronTrigger ` +
      `ORDER BY NextFireTime NULLS LAST LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR('CronTrigger', org, detailQ.reason));

  const jobs: ScheduledJobEntry[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    const detail = r.CronJobDetail as { Name?: string; JobType?: string } | null | undefined;
    const num = (v: unknown): number | null => (v === undefined || v === null ? null : Number(v));
    const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
    return {
      id: String(r.Id ?? ''),
      name: detail?.Name != null ? String(detail.Name) : null,
      jobType: detail?.JobType != null ? String(detail.JobType) : null,
      state: str(r.State),
      cronExpression: str(r.CronExpression),
      nextFireTime: str(r.NextFireTime),
      previousFireTime: str(r.PreviousFireTime),
      startTime: str(r.StartTime),
      endTime: str(r.EndTime),
      timesTriggered: num(r.TimesTriggered),
    };
  });
  // ORG-WIDE Scheduled-Apex cron count via a dedicated COUNT (the returned page
  // is capped at `limit`, so counting within it would understate the total on a
  // large org — verified live at ~15k cron rows). Falls back to the page count
  // only if the filtered COUNT is unavailable.
  const apexCountQ = await liveQuery(
    org,
    `SELECT COUNT() FROM CronTrigger WHERE CronJobDetail.JobType = '${SCHEDULED_APEX_JOBTYPE}'`,
    exec,
  );
  const liveScheduledApexCount = apexCountQ.available
    ? apexCountQ.total
    : jobs.filter((j) => j.jobType === SCHEDULED_APEX_JOBTYPE).length;

  // Count-only cross-reference against the static catalog (vault Schedulable
  // classes). Degrades to null (never fabricates) if the vault graph read fails
  // or is unavailable — a null count is disclosed as "not checked", never 0.
  let staticSchedulableClassCount: number | null = null;
  try {
    const schedRes = await listNodesByType(ctx.graph, 'ApexClass', {
      propertyEquals: { isSchedulable: true },
      limit: 500,
    });
    staticSchedulableClassCount = schedRes.ok ? schedRes.value.length : null;
  } catch {
    staticSchedulableClassCount = null;
  }

  let asyncSummary: LiveScheduledJobsOutput['asyncApexJobSummary'];
  if (includeAsync) {
    const asyncQ = await liveQuery(
      org,
      `SELECT Status, COUNT(Id) cnt FROM AsyncApexJob WHERE CreatedDate = LAST_N_DAYS:${asyncDays} GROUP BY Status`,
      exec,
    );
    if (asyncQ.available) {
      const byStatus: AsyncApexJobStatusCount[] = asyncQ.records.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          status: String(r.Status ?? ''),
          count: aggregateCountFromRow(r, ['cnt', 'expr0']),
        };
      });
      asyncSummary = {
        days: asyncDays,
        byStatus,
        total: byStatus.reduce((n, s) => n + s.count, 0),
      };
    }
  }

  const trust = liveTrust(queriedAt);
  const table = mdTable(
    ['Job', 'Type', 'State', 'Next fire', 'Cron'],
    jobs
      .slice(0, LIVE_TABLE_ROW_CAP)
      .map((j) => [j.name ?? j.id, j.jobType ?? '—', j.state ?? '—', j.nextFireTime ?? '—', j.cronExpression ?? '—']),
  );
  const crossRef =
    staticSchedulableClassCount === null
      ? ''
      : `\n\nCross-reference (count-only): vault knows **${staticSchedulableClassCount}** Schedulable-capable Apex class(es); **${liveScheduledApexCount}** live cron job(s) are registered as Scheduled Apex.`;
  const asyncLine = asyncSummary
    ? `\n\nAsyncApexJob (last ${asyncSummary.days}d): **${asyncSummary.total}** total — ` +
      asyncSummary.byStatus.map((s) => `${s.status}: ${s.count}`).join(', ')
    : '';
  const rendered =
    `**${totalQ.total.toLocaleString('en-US')}** scheduled cron job(s) registered right now.` +
    crossRef +
    asyncLine +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      totalCronJobs: totalQ.total,
      returned: jobs.length,
      capped: totalQ.total > jobs.length,
      jobs,
      staticSchedulableClassCount,
      liveScheduledApexCount,
      ...(asyncSummary ? { asyncApexJobSummary: asyncSummary } : {}),
      disclosure: LIVE_SCHEDULED_JOBS_DISCLOSURE,
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};

// ---------------------------------------------------------------------------
// sfi.live_field_history — WHO changed a field on a record, and to what (live)
// ---------------------------------------------------------------------------
//
// Queries the `{Object}History` table (Field, OldValue, NewValue, CreatedBy.Name,
// CreatedDate). This is the ONE live tool family that returns runtime RECORD
// DATA (OldValue/NewValue are actual field values), so rows are capped HARD and
// the default page is small.
//
// PRECONDITION COMPOSITION (R6-14): field history only exists when tracking is
// enabled. The vault already knows per-field `trackHistory` (CustomField) and
// per-object `enableHistory` (CustomObject), so we check the vault FIRST:
//   - Vault says tracking is OFF for the field/object  → FAIL CLOSED with a
//     precise "history tracking is not enabled … (per last refresh)" reason,
//     instead of a cryptic INVALID_TYPE SOQL error.
//   - Vault says tracking is ON                        → proceed, `trackingState:
//     'enabled'`.
//   - Vault holds NO metadata for the object/field (a scoped refresh, a managed
//     object the refresh skipped, or the graph is unavailable) → we do NOT fail
//     closed. We proceed with the live probe and DISCLOSE `trackingState:
//     'unknown'` ("vault has no field/object metadata; proceeding with a live
//     query — zero rows must NOT be read as 'no changes' if tracking is off").
//     Justification: failing closed on missing vault data would make the tool
//     useless on exactly the scoped/partial vaults where a live probe is most
//     valuable; the honest disclosure keeps a zero result from being misread.

const MAX_HISTORY_ROWS = 200;
const DEFAULT_HISTORY_ROWS = 20;
/** Keep the serialized `data` (record values can be long text) under the global
 *  ~45 KB response guard. Trailing rows are trimmed and disclosed. */
const HISTORY_BYTE_BUDGET = 36_000;
/** Cap a single OldValue/NewValue preview so one long-text field cannot blow the
 *  budget on its own; the trim is disclosed via `valueTruncated`. */
const HISTORY_VALUE_MAX_LEN = 255;

type HistoryTrackingState = 'enabled' | 'disabled' | 'unknown';

interface HistoryPreconditionResult {
  readonly state: HistoryTrackingState;
  /** Human reason — the fail-closed message (disabled) or the disclosure note
   *  (unknown). Empty when enabled. */
  readonly reason: string;
}

/**
 * Compose the field-history precondition from the vault. Field-level
 * `trackHistory` is the specific signal; when a field is named but not modeled,
 * a KNOWN object-level `enableHistory === false` still fails closed (object
 * history off ⇒ no field is tracked). Missing metadata (or an unavailable graph)
 * is `unknown` — proceed with disclosure, never a fabricated verdict.
 */
const readVaultHistoryTracking = async (
  ctx: Context,
  objectApiName: string,
  fieldApiName?: string,
): Promise<HistoryPreconditionResult> => {
  const objectEnableHistory = async (): Promise<boolean | null> => {
    const objNode = await getNodeById(ctx.graph, `CustomObject:${objectApiName}` as ComponentId);
    if (!objNode.ok || objNode.value === null) return null;
    const en = objNode.value.properties['enableHistory'];
    return en === true ? true : en === false ? false : null;
  };
  try {
    if (fieldApiName !== undefined) {
      const fieldNode = await getNodeById(
        ctx.graph,
        `CustomField:${objectApiName}.${fieldApiName}` as ComponentId,
      );
      if (fieldNode.ok && fieldNode.value !== null) {
        const track = fieldNode.value.properties['trackHistory'];
        if (track === false) {
          return {
            state: 'disabled',
            reason: `history tracking is not enabled for the field ${objectApiName}.${fieldApiName} (per the last vault refresh)`,
          };
        }
        if (track === true) return { state: 'enabled', reason: '' };
      }
      // Field not modeled (or trackHistory unknown): a KNOWN object-off still
      // fails closed; otherwise the field state is unknown.
      if ((await objectEnableHistory()) === false) {
        return {
          state: 'disabled',
          reason: `history tracking is not enabled for the object ${objectApiName} (per the last vault refresh), so no field on it is tracked`,
        };
      }
      return {
        state: 'unknown',
        reason: `the vault holds no history-tracking metadata for ${objectApiName}.${fieldApiName} (last refresh) — proceeding with a live probe; zero rows must NOT be read as "no changes" if tracking is off`,
      };
    }
    const objState = await objectEnableHistory();
    if (objState === false) {
      return {
        state: 'disabled',
        reason: `history tracking is not enabled for the object ${objectApiName} (per the last vault refresh)`,
      };
    }
    if (objState === true) return { state: 'enabled', reason: '' };
    return {
      state: 'unknown',
      reason: `the vault holds no history-tracking metadata for the object ${objectApiName} (last refresh) — proceeding with a live probe; zero rows must NOT be read as "no changes" if tracking is off`,
    };
  } catch {
    return {
      state: 'unknown',
      reason: 'the vault graph is unavailable, so history-tracking state was not checked — proceeding with a live probe',
    };
  }
};

export const liveFieldHistoryInputSchema = liveEnabledSchema.extend({
  objectApiName: z.string().min(1),
  /** Restrict to one field (History.Field equals the field API name). */
  fieldApiName: z.string().min(1).optional(),
  /** Restrict to one record (the {Object}History parent-Id field). */
  recordId: z.string().min(1).optional(),
  /** Only changes in the last N days (CreatedDate = LAST_N_DAYS:N). */
  days: z.number().int().min(1).max(3650).optional(),
  /** Max history rows (default 20, HARD cap 200 — these are record values). */
  limit: z.number().int().min(1).max(MAX_HISTORY_ROWS).optional(),
  orgAlias: z.string().min(1).optional(),
});
export type LiveFieldHistoryInput = z.infer<typeof liveFieldHistoryInputSchema>;

export interface FieldHistoryEntry {
  readonly field: string | null;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly changedBy: string | null;
  readonly changedDate: string | null;
  /** True when oldValue/newValue was truncated to the preview length. */
  readonly valueTruncated?: boolean;
}
export interface LiveFieldHistoryOutput {
  readonly objectApiName: string;
  readonly fieldApiName: string | null;
  readonly recordId: string | null;
  readonly historyObject: string;
  readonly days: number | null;
  readonly returned: number;
  readonly capped: boolean;
  /** Vault-derived precondition state (enabled / disabled short-circuits before
   *  the live query / unknown = proceeded with disclosure). Here it is always
   *  'enabled' or 'unknown' (a 'disabled' precondition returns an error). */
  readonly trackingState: Exclude<HistoryTrackingState, 'disabled'>;
  readonly entries: readonly FieldHistoryEntry[];
  readonly disclosure: string;
  /** Present for the unknown-tracking disclosure and/or byte-trim note. */
  readonly note?: string;
  readonly trust: TrustSummary;
  readonly rendered: string;
}

/** Verbatim disclosure — tool description + rendered footer. */
export const LIVE_FIELD_HISTORY_DISCLOSURE =
  'Live field-change history from the `{Object}History` table as of queriedAt. ' +
  'THIS IS RUNTIME RECORD DATA — OldValue/NewValue are actual field values, the ' +
  'only live tool family that returns them; rows are capped hard and the default ' +
  'page is small. History exists only where tracking is enabled: the vault ' +
  'per-field `trackHistory` / per-object `enableHistory` state is checked FIRST ' +
  '(a known-off state fails closed with a precise reason; missing vault metadata ' +
  'proceeds with `trackingState: unknown` and this disclosure). A zero result ' +
  'under unknown tracking must NOT be read as "no changes". Read-only; ' +
  'point-in-time; never falls back to vault data.';

export const liveFieldHistoryHandler = async (
  ctx: Context,
  input: LiveFieldHistoryInput,
  exec: ExecCommand = nodeExecFile,
): Promise<Result<McpResponse<LiveFieldHistoryOutput>, McpError>> => {
  const gate = await gateLive(ctx, input);
  if (!gate.ok) return gate;
  const org = gate.value;
  const objectCheck = assertSoqlIdentifier(input.objectApiName, 'objectApiName');
  if (!objectCheck.ok) return objectCheck;
  const objectApiName = objectCheck.value;
  let fieldApiName: string | null = null;
  if (input.fieldApiName !== undefined) {
    const fieldCheck = assertSoqlIdentifier(input.fieldApiName, 'fieldApiName');
    if (!fieldCheck.ok) return fieldCheck;
    fieldApiName = fieldCheck.value;
  }
  let recordId: string | null = null;
  if (input.recordId !== undefined) {
    const recCheck = assertRecordId(input.recordId, 'recordId');
    if (!recCheck.ok) return recCheck;
    recordId = recCheck.value;
  }

  const sibling = deriveSiblingObject(objectApiName, 'History');
  if (sibling === null) {
    return err({
      kind: 'invalid-query',
      message: `objectApiName "${objectApiName}" is not a valid Salesforce object API name.`,
      path: 'objectApiName',
    });
  }

  // PRECONDITION: consult the vault BEFORE spending a live query. A known-off
  // state fails closed with a precise reason; missing metadata proceeds with a
  // disclosure (see readVaultHistoryTracking / this tool's JSDoc).
  const precondition = await readVaultHistoryTracking(
    ctx,
    objectApiName,
    fieldApiName ?? undefined,
  );
  if (precondition.state === 'disabled') {
    return err({
      kind: 'invalid-query',
      message:
        `Cannot query field history: ${precondition.reason}. ` +
        `Enable Set History Tracking on the field/object (or refresh the vault if it was recently enabled).`,
      path: fieldApiName !== null ? 'fieldApiName' : 'objectApiName',
    });
  }

  const days = input.days ?? null;
  const limit = input.limit ?? DEFAULT_HISTORY_ROWS;
  const clauses: string[] = [];
  if (fieldApiName !== null) clauses.push(`Field = ${soqlLiteral(fieldApiName)}`);
  if (recordId !== null) clauses.push(`${sibling.parentField} = ${soqlLiteral(recordId)}`);
  if (days !== null) clauses.push(`CreatedDate = LAST_N_DAYS:${days}`);
  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const queriedAt = new Date().toISOString();

  const detailQ = await liveQuery(
    org,
    `SELECT Field, OldValue, NewValue, CreatedBy.Name, CreatedDate FROM ${sibling.object}${whereClause} ` +
      `ORDER BY CreatedDate DESC LIMIT ${limit}`,
    exec,
  );
  if (!detailQ.available) return err(UNAVAILABLE_ERROR(sibling.object, org, detailQ.reason));

  const clampValue = (v: unknown): { value: string | null; truncated: boolean } => {
    if (v === undefined || v === null) return { value: null, truncated: false };
    const s = String(v);
    return s.length > HISTORY_VALUE_MAX_LEN
      ? { value: s.slice(0, HISTORY_VALUE_MAX_LEN), truncated: true }
      : { value: s, truncated: false };
  };
  let entries: FieldHistoryEntry[] = detailQ.records.map((row) => {
    const r = row as Record<string, unknown>;
    const by = r['CreatedBy'] as { Name?: string } | null | undefined;
    const oldV = clampValue(r['OldValue']);
    const newV = clampValue(r['NewValue']);
    const truncated = oldV.truncated || newV.truncated;
    return {
      field: r['Field'] === undefined || r['Field'] === null ? null : String(r['Field']),
      oldValue: oldV.value,
      newValue: newV.value,
      changedBy: by?.Name ?? null,
      changedDate: r['CreatedDate'] === undefined || r['CreatedDate'] === null ? null : String(r['CreatedDate']),
      ...(truncated ? { valueTruncated: true } : {}),
    };
  });
  const trust = liveTrust(queriedAt);

  // Byte-budget trim: record values can be large even at the row cap. Drop
  // trailing rows until the serialized data fits, disclosed via the note.
  const fits = (rows: readonly FieldHistoryEntry[]): boolean =>
    Buffer.byteLength(JSON.stringify({ entries: rows, trust }), 'utf8') <= HISTORY_BYTE_BUDGET;
  let byteTrimmed = false;
  const fetched = entries.length;
  while (entries.length > 1 && !fits(entries)) {
    entries = entries.slice(0, Math.floor(entries.length * 0.8));
    byteTrimmed = true;
  }

  const noteParts: string[] = [];
  if (precondition.state === 'unknown') noteParts.push(precondition.reason);
  if (byteTrimmed) {
    noteParts.push(
      `Response trimmed to ${entries.length} of ${fetched} fetched rows to stay within the size limit — lower \`limit\` or narrow with fieldApiName/recordId/days.`,
    );
  }
  const note = noteParts.length > 0 ? noteParts.join(' ') : undefined;

  const table = mdTable(
    ['When', 'Who', 'Field', 'Old', 'New'],
    entries
      .slice(0, LIVE_TABLE_ROW_CAP)
      .map((e) => [e.changedDate ?? '—', e.changedBy ?? '—', e.field ?? '—', e.oldValue ?? '∅', e.newValue ?? '∅']),
  );
  const scope =
    (fieldApiName !== null ? ` field \`${fieldApiName}\`` : '') +
    (recordId !== null ? ` on record \`${recordId}\`` : '') +
    (days !== null ? ` in the last ${days} days` : '');
  const rendered =
    `**${entries.length}** ${objectApiName} history row(s)${scope} (via ${sibling.object}).` +
    (precondition.state === 'unknown' ? `\n\n> ${precondition.reason}` : '') +
    `\n\n${table}\n\n${renderTrustFooter(trust)}`;
  return ok({
    data: {
      objectApiName,
      fieldApiName,
      recordId,
      historyObject: sibling.object,
      days,
      returned: entries.length,
      capped: fetched > entries.length,
      trackingState: precondition.state,
      entries,
      disclosure: LIVE_FIELD_HISTORY_DISCLOSURE,
      ...(note !== undefined ? { note } : {}),
      trust,
      rendered,
    },
    vaultState: livePlaneVaultState(ctx),
  });
};
