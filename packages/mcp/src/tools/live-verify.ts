/**
 * Handler for `sfi.live_verify` (spec F8) — confirm ONE claim against the live
 * org now, with the smallest read-only query that can, so a finding never rests
 * on a stale snapshot. Each claim kind maps to one query; the response returns
 * the live evidence, what the vault says, whether they agree, and the
 * timestamp. Read-only, consent-gated (`sfi.live_consent`), budgeted.
 *
 * Claim kinds:
 *   - `object-permission`   ObjectPermissions for a permission set / profile on an object
 *   - `omni-active-version` OmniProcess versions of a Type / SubType (which is active)
 *   - `validation-rules`    Tooling ValidationRule on an object (name, active)
 *   - `field-definition`    Tooling FieldDefinition (type, length, precision, scale)
 *   - `omniscript-compiled` Tooling LightningComponentBundle for an LWC OmniScript's
 *                           compiled component (`ACTIVE_BUT_NOT_COMPILED` when absent)
 */

import type { ComponentId, McpError, McpResponse, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { gateLive, liveTrust } from './live-plane.js';
import { runLiveQuery } from './live-session.js';

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/;
const safe = z.string().min(1).regex(SAFE_NAME, 'letters, digits, spaces, `_`, `.` and `-` only');

export const liveVerifyInputSchema = z.object({
  claim: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('object-permission'),
      /** Permission set or profile name (`Name`, not label). */
      container: safe,
      object: safe,
      permission: z.enum(['create', 'read', 'edit', 'delete', 'viewAll', 'modifyAll']).default('delete'),
    }),
    z.object({ kind: z.literal('omni-active-version'), type: safe, subType: safe, language: safe.optional() }),
    z.object({ kind: z.literal('validation-rules'), object: safe }),
    z.object({ kind: z.literal('field-definition'), object: safe, field: safe }),
    z.object({ kind: z.literal('omniscript-compiled'), type: safe, subType: safe, language: safe }),
  ]),
  orgAlias: z.string().min(1).optional(),
  liveEnabled: z.boolean().optional(),
});

export type LiveVerifyInput = z.infer<typeof liveVerifyInputSchema>;
type Claim = LiveVerifyInput['claim'];

/** The verdict on the claim. */
export type LiveVerdict = 'CONFIRMED' | 'REFUTED' | 'NOT_FOUND' | 'UNKNOWN';

/** Response payload. */
export interface LiveVerifyOutput {
  readonly claim: Claim;
  readonly verdict: LiveVerdict;
  /** One sentence: what the live org says. */
  readonly statement: string;
  /** Stable code for an audit finding raised by the verification, when one is (`ACTIVE_BUT_NOT_COMPILED`). */
  readonly code: string | null;
  readonly query: { readonly soql: string; readonly tooling: boolean };
  readonly liveEvidence: readonly Readonly<Record<string, unknown>>[];
  /** What the vault recorded for the same claim (null when the vault holds nothing comparable). */
  readonly vaultSays: Readonly<Record<string, unknown>> | null;
  /** Live and vault agree; null when there is nothing to compare. */
  readonly matchesVault: boolean | null;
  readonly queriedAt: string;
  readonly refreshedAt: string;
  readonly trust: TrustSummary;
}

/** The seams the handler needs (injectable for tests). */
export interface LiveVerifyDeps {
  readonly gate: (ctx: Context, input: { liveEnabled?: boolean | undefined; orgAlias?: string | undefined }) => Promise<Result<string, McpError>>;
  readonly query: (org: string, soql: string, tooling: boolean) => Promise<Result<readonly Record<string, unknown>[], McpError>>;
}

const DEFAULT_DEPS: LiveVerifyDeps = {
  gate: (ctx, input) => gateLive(ctx, input),
  query: async (org, soql, tooling) => {
    const r = await runLiveQuery(org, ['data', 'query', '--query', soql, ...(tooling ? ['--use-tooling-api'] : [])]);
    if (!r.ok) return r;
    const records = (r.value.value as { result?: { records?: Record<string, unknown>[] } }).result?.records ?? [];
    return ok(records.map(({ attributes: _a, ...rest }) => rest));
  },
};

const PERMISSION_FIELD: Readonly<Record<string, string>> = {
  create: 'PermissionsCreate',
  read: 'PermissionsRead',
  edit: 'PermissionsEdit',
  delete: 'PermissionsDelete',
  viewAll: 'PermissionsViewAllRecords',
  modifyAll: 'PermissionsModifyAllRecords',
};
const VAULT_FLAG: Readonly<Record<string, string>> = {
  create: 'allowCreate',
  read: 'allowRead',
  edit: 'allowEdit',
  delete: 'allowDelete',
  viewAll: 'viewAllRecords',
  modifyAll: 'modifyAllRecords',
};

const q = (v: string): string => v.replace(/'/g, "\\'");
const lcFirst = (s: string): string => (s.length === 0 ? s : `${s.charAt(0).toLowerCase()}${s.slice(1)}`);
const ucFirst = (s: string): string => (s.length === 0 ? s : `${s.charAt(0).toUpperCase()}${s.slice(1)}`);
const compact = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '');

/** The SOQL for a claim. */
export const claimQuery = (claim: Claim): { soql: string; tooling: boolean } => {
  switch (claim.kind) {
    case 'object-permission':
      return {
        soql: `SELECT Parent.Name, Parent.IsOwnedByProfile, Parent.Profile.Name, SobjectType, ${PERMISSION_FIELD[claim.permission]} FROM ObjectPermissions WHERE SobjectType = '${q(claim.object)}' AND (Parent.Name = '${q(claim.container)}' OR Parent.Profile.Name = '${q(claim.container)}')`,
        tooling: false,
      };
    case 'omni-active-version':
      return {
        soql: `SELECT Type, SubType, Language, VersionNumber, IsActive, IsIntegrationProcedure FROM OmniProcess WHERE Type = '${q(claim.type)}' AND SubType = '${q(claim.subType)}'${claim.language === undefined ? '' : ` AND Language = '${q(claim.language)}'`} ORDER BY VersionNumber`,
        tooling: false,
      };
    case 'validation-rules':
      return { soql: `SELECT ValidationName, Active FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${q(claim.object)}' ORDER BY ValidationName`, tooling: true };
    case 'field-definition':
      return {
        soql: `SELECT QualifiedApiName, DataType, Length, Precision, Scale FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${q(claim.object)}' AND QualifiedApiName = '${q(claim.field)}'`,
        tooling: true,
      };
    case 'omniscript-compiled':
      return {
        soql: `SELECT DeveloperName, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle WHERE DeveloperName LIKE '${q(lcFirst(compact(claim.type)))}${q(compact(claim.subType))}%' ORDER BY DeveloperName`,
        tooling: true,
      };
  }
};

/** Names an LWC OmniScript's compiled component may carry (Type + SubType + Language, camel-cased). */
export const compiledComponentNames = (type: string, subType: string, language: string): string[] => {
  const base = `${lcFirst(compact(type))}${compact(subType)}`;
  return [...new Set([`${base}${compact(language)}`, `${base}${ucFirst(compact(language))}`])];
};

const vaultFor = async (ctx: Context, claim: Claim): Promise<Readonly<Record<string, unknown>> | null> => {
  switch (claim.kind) {
    case 'object-permission': {
      for (const prefix of ['PermissionSet:', 'Profile:']) {
        const edges = await listEdges(ctx.graph, `${prefix}${claim.container}` as ComponentId, { direction: 'out', edgeType: 'grantedBy' });
        if (!edges.ok) continue;
        const e = edges.value.find((x) => x.toId.toLowerCase() === `customobject:${claim.object.toLowerCase()}`);
        if (e !== undefined) return { container: `${prefix}${claim.container}`, [claim.permission]: e.properties[VAULT_FLAG[claim.permission] as string] === true };
      }
      return null;
    }
    case 'omni-active-version':
    case 'omniscript-compiled': {
      const type = claim.kind === 'omni-active-version' ? 'OmniIntegrationProcedure' : 'OmniScript';
      const versions = [];
      for (const t of claim.kind === 'omni-active-version' ? ['OmniScript', type] : [type]) {
        const nodes = await listNodesByType(ctx.graph, t as never, { limit: 500 });
        if (!nodes.ok) continue;
        for (const n of nodes.value) {
          if (String(n.properties['type'] ?? '') !== claim.type || String(n.properties['subType'] ?? '') !== claim.subType) continue;
          if (claim.language !== undefined && String(n.properties['language'] ?? '') !== claim.language) continue;
          versions.push({ id: n.id, versionNumber: n.properties['versionNumber'] ?? null, isActive: n.properties['isActive'] === true, isWebCompEnabled: n.properties['isWebCompEnabled'] ?? null });
        }
      }
      return versions.length === 0 ? null : { versions };
    }
    case 'validation-rules': {
      const nodes = await listNodesByType(ctx.graph, 'ValidationRule', { parentId: `CustomObject:${claim.object}` as ComponentId, limit: 500 });
      if (!nodes.ok) return null;
      return { rules: nodes.value.map((n) => ({ name: n.apiName, active: n.properties['active'] ?? null })).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    case 'field-definition': {
      const n = await getNodeById(ctx.graph, `CustomField:${claim.object}.${claim.field}` as ComponentId);
      if (!n.ok || n.value === null) return null;
      return { dataType: n.value.properties['dataType'] ?? null, length: n.value.properties['length'] ?? null, precision: n.value.properties['precision'] ?? null, scale: n.value.properties['scale'] ?? null };
    }
  }
};

const judge = (
  claim: Claim,
  records: readonly Record<string, unknown>[],
  vault: Readonly<Record<string, unknown>> | null,
): { verdict: LiveVerdict; statement: string; matchesVault: boolean | null; code: string | null } => {
  switch (claim.kind) {
    case 'object-permission': {
      if (records.length === 0) return { verdict: 'NOT_FOUND', statement: `No ObjectPermissions row for ${claim.container} on ${claim.object}: it grants no access to the object.`, matchesVault: vault === null ? null : vault[claim.permission] === false, code: null };
      const field = PERMISSION_FIELD[claim.permission] as string;
      const granted = records.some((r) => r[field] === true);
      return {
        verdict: granted ? 'CONFIRMED' : 'REFUTED',
        statement: `${claim.container} ${granted ? 'grants' : 'does not grant'} ${claim.permission} on ${claim.object} in the live org.`,
        matchesVault: vault === null ? null : vault[claim.permission] === granted,
        code: null,
      };
    }
    case 'omni-active-version': {
      if (records.length === 0) return { verdict: 'NOT_FOUND', statement: `No OmniProcess ${claim.type}/${claim.subType} in the live org.`, matchesVault: vault === null ? null : false, code: null };
      const active = records.filter((r) => r['IsActive'] === true).map((r) => r['VersionNumber']);
      const vaultActive = vault === null ? null : (vault['versions'] as { versionNumber: unknown; isActive: boolean }[]).filter((v) => v.isActive).map((v) => Number(v.versionNumber));
      return {
        verdict: active.length > 0 ? 'CONFIRMED' : 'REFUTED',
        statement: active.length > 0 ? `Active live version(s) of ${claim.type}/${claim.subType}: ${active.join(', ')}.` : `${claim.type}/${claim.subType} exists live but no version is active.`,
        matchesVault: vaultActive === null ? null : JSON.stringify([...active.map(Number)].sort()) === JSON.stringify([...vaultActive].sort()),
        code: null,
      };
    }
    case 'validation-rules': {
      const live = records.map((r) => ({ name: String(r['ValidationName']), active: r['Active'] === true })).sort((a, b) => a.name.localeCompare(b.name));
      const vaultRules = (vault?.['rules'] as { name: string; active: unknown }[] | undefined) ?? null;
      return {
        verdict: live.length > 0 ? 'CONFIRMED' : 'NOT_FOUND',
        statement: `${live.length} validation rule(s) on ${claim.object} live (${live.filter((r) => r.active).length} active).`,
        matchesVault: vaultRules === null ? null : JSON.stringify(live) === JSON.stringify(vaultRules.map((r) => ({ name: r.name, active: r.active === true }))),
        code: null,
      };
    }
    case 'field-definition': {
      if (records.length === 0) return { verdict: 'NOT_FOUND', statement: `${claim.object}.${claim.field} does not exist live.`, matchesVault: vault === null ? null : false, code: null };
      const r = records[0] as Record<string, unknown>;
      return {
        verdict: 'CONFIRMED',
        statement: `${claim.object}.${claim.field} is ${String(r['DataType'])} live.`,
        matchesVault: vault === null ? null : vault['length'] === null || Number(vault['length']) === Number(r['Length']),
        code: null,
      };
    }
    case 'omniscript-compiled': {
      const expected = compiledComponentNames(claim.type, claim.subType, claim.language).map((n) => n.toLowerCase());
      const names = records.map((r) => String(r['DeveloperName']));
      const hit = names.find((n) => expected.includes(n.toLowerCase()));
      const vaultActive = vault === null ? null : (vault['versions'] as { isActive: boolean; isWebCompEnabled: unknown }[]).some((v) => v.isActive && v.isWebCompEnabled === true);
      if (hit !== undefined) return { verdict: 'CONFIRMED', statement: `The compiled component ${hit} exists live.`, matchesVault: null, code: null };
      if (names.length === 0) {
        return {
          verdict: 'REFUTED',
          statement: `No Lightning component named like ${compiledComponentNames(claim.type, claim.subType, claim.language).join(' / ')} exists live: an active LWC OmniScript with no compiled component fails to load ("Invalid Component").`,
          matchesVault: null,
          code: vaultActive === false ? null : 'ACTIVE_BUT_NOT_COMPILED',
        };
      }
      return { verdict: 'UNKNOWN', statement: `Components with the same prefix exist (${names.slice(0, 5).join(', ')}) but none matches the expected compiled name exactly.`, matchesVault: null, code: null };
    }
  }
};

/** The `sfi.live_verify` handler. */
export const liveVerifyHandler = async (
  ctx: Context,
  input: LiveVerifyInput,
  deps: LiveVerifyDeps = DEFAULT_DEPS,
): Promise<Result<McpResponse<LiveVerifyOutput>, McpError>> => {
  const gate = await deps.gate(ctx, { liveEnabled: input.liveEnabled, orgAlias: input.orgAlias });
  if (!gate.ok) return gate;
  const org = gate.value;
  const query = claimQuery(input.claim);
  const queriedAt = new Date().toISOString();
  const records = await deps.query(org, query.soql, query.tooling);
  if (!records.ok) return err(records.error);
  const vault = await vaultFor(ctx, input.claim);
  const j = judge(input.claim, records.value, vault);
  return ok({
    data: {
      claim: input.claim,
      verdict: j.verdict,
      statement: j.statement,
      code: j.code,
      query,
      liveEvidence: records.value.slice(0, 50),
      vaultSays: vault,
      matchesVault: j.matchesVault,
      queriedAt,
      refreshedAt: ctx.manifest.refreshedAt,
      trust: liveTrust(queriedAt),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
