/**
 * Handler for `sfi.component_change_attribution` (#39).
 *
 * Correlates persisted SetupAuditTrail rows (`meta/setup-audit-trail.jsonl`,
 * written by `sfi refresh --with-audit-trail`) to a component via heuristic
 * text-matching on `Display` / `Section` against the component's API name.
 * OFFLINE — never touches the live org. Complements `sfi.component_history`
 * (vault git / refresh-granularity) and `sfi.live_setup_audit_trail` (live,
 * 180-day org retention ceiling).
 *
 * Honesty axis (non-negotiable):
 *   (a) coverage starts only when `--with-audit-trail` was first enabled;
 *   (b) correlation is heuristic text-matching, not a declared join;
 *   (c) SetupAuditTrail does not log every category of org change.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { McpError, McpResponse, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { vaultPaths } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { resolveExistingObjectScope } from './input-aliases.js';

/** Same filename the CLI persist pass writes. */
export const SETUP_AUDIT_TRAIL_FILENAME = 'setup-audit-trail.jsonl';

const ENABLE_HINT =
  'This vault has no persisted SetupAuditTrail — run `sfi refresh --with-audit-trail` once (requires an authenticated target org); subsequent refreshes with the flag append new rows, and coverage accrues from that point.';

export const ATTRIBUTION_DISCLOSURE =
  'Coverage starts only when `sfi refresh --with-audit-trail` was first enabled — there is no retroactive history before that. Correlation is HEURISTIC text-matching of SetupAuditTrail Display/Section against the component API name (not a declared join; confidence is always `heuristic`). SetupAuditTrail itself does not cover every category of org change (e.g. many record-data edits are not logged there). For live / last-180-days Setup reads use `sfi.live_setup_audit_trail`; for vault-git refresh-granularity history use `sfi.component_history`.';

export const componentChangeAttributionInputSchema = z
  .object({
    componentId: z.string().min(1).optional(),
    /** Object API name (e.g. `Account`, `Invoice__c`) when correlating by object rather than a single component. */
    objectApiName: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .refine((v) => v.componentId !== undefined || v.objectApiName !== undefined, {
    message: 'Provide componentId and/or objectApiName',
  });

export type ComponentChangeAttributionInput = z.infer<
  typeof componentChangeAttributionInputSchema
>;

export interface AttributedSetupChange {
  readonly id: string;
  readonly action: string;
  readonly section: string | null;
  readonly createdDate: string;
  readonly display: string | null;
  readonly createdByName: string | null;
  readonly capturedAt: string;
  /** Always `heuristic` — SetupAuditTrail text is free-form, not a canonical id. */
  readonly confidence: 'heuristic';
  /** Which needle matched (apiName / object / etc.). */
  readonly matchedOn: string;
}

export interface ComponentChangeAttributionOutput {
  readonly available: boolean;
  readonly componentId: string | null;
  readonly objectApiName: string | null;
  readonly apiName: string | null;
  readonly changes: readonly AttributedSetupChange[];
  readonly totalMatched: number;
  readonly totalPersisted: number;
  readonly confidence: 'heuristic';
  readonly remedy?: string;
  readonly disclosure: string;
}

interface PersistedRow {
  readonly id: string;
  readonly action: string;
  readonly section: string | null;
  readonly createdDate: string;
  readonly display: string | null;
  readonly createdByName: string | null;
  readonly capturedAt: string;
}

/** Parse JSONL; skip corrupt lines. Exported for unit tests. */
export const parsePersistedAuditRows = (raw: string): PersistedRow[] => {
  const out: PersistedRow[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const o = JSON.parse(trimmed) as Partial<PersistedRow>;
      if (typeof o.id !== 'string' || o.id.length === 0) continue;
      if (typeof o.createdDate !== 'string') continue;
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      out.push({
        id: o.id,
        action: typeof o.action === 'string' ? o.action : '',
        section: typeof o.section === 'string' ? o.section : null,
        createdDate: o.createdDate,
        display: typeof o.display === 'string' ? o.display : null,
        createdByName: typeof o.createdByName === 'string' ? o.createdByName : null,
        capturedAt: typeof o.capturedAt === 'string' ? o.capturedAt : o.createdDate,
      });
    } catch {
      // defensive skip
    }
  }
  return out;
};

/**
 * Build search needles from a component / object. Longer needles first so
 * `Account.Status_Required` beats bare `Account` when both could match.
 */
export const attributionNeedles = (args: {
  readonly apiName: string | null;
  readonly objectApiName: string | null;
  readonly type?: string | null;
}): readonly { readonly needle: string; readonly matchedOn: string }[] => {
  const needles: { needle: string; matchedOn: string }[] = [];
  const push = (needle: string, matchedOn: string): void => {
    const t = needle.trim();
    if (t.length < 2) return;
    if (needles.some((n) => n.needle.toLowerCase() === t.toLowerCase())) return;
    needles.push({ needle: t, matchedOn });
  };

  if (args.apiName) {
    push(args.apiName, 'apiName');
    // CustomField / ValidationRule style `Object.Name` → also try the leaf.
    const dot = args.apiName.lastIndexOf('.');
    if (dot > 0 && dot < args.apiName.length - 1) {
      push(args.apiName.slice(dot + 1), 'apiNameLeaf');
      push(args.apiName.slice(0, dot), 'apiNameObject');
    }
  }
  if (args.objectApiName) {
    push(args.objectApiName, 'objectApiName');
  }
  // Prefer longer needles first (more specific).
  return [...needles].sort((a, b) => b.needle.length - a.needle.length);
};

/**
 * Heuristic correlation: case-insensitive substring match of any needle against
 * Display or Section. Exported for unit tests.
 */
export const correlateAuditRows = (
  rows: readonly PersistedRow[],
  needles: readonly { readonly needle: string; readonly matchedOn: string }[],
  limit: number,
): readonly AttributedSetupChange[] => {
  if (needles.length === 0) return [];
  const matched: AttributedSetupChange[] = [];
  // Newest first for the admin "who changed this recently" ask.
  const ordered = [...rows].sort((a, b) => (a.createdDate < b.createdDate ? 1 : -1));
  for (const row of ordered) {
    const haystack = `${row.display ?? ''}\n${row.section ?? ''}`.toLowerCase();
    let hit: { readonly needle: string; readonly matchedOn: string } | null = null;
    for (const n of needles) {
      if (haystack.includes(n.needle.toLowerCase())) {
        hit = n;
        break;
      }
    }
    if (hit === null) continue;
    matched.push({
      id: row.id,
      action: row.action,
      section: row.section,
      createdDate: row.createdDate,
      display: row.display,
      createdByName: row.createdByName,
      capturedAt: row.capturedAt,
      confidence: 'heuristic',
      matchedOn: hit.matchedOn,
    });
    if (matched.length >= limit) break;
  }
  return matched;
};

const loadNode = async (
  ctx: Context,
  componentId: string,
): Promise<Result<Node, McpError>> => {
  const node = await getNodeById(ctx.graph, componentId as never);
  if (!node.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${node.error.message}` });
  }
  if (node.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no component '${componentId}' in this vault`,
      path: componentId,
    });
  }
  return ok(node.value);
};

/**
 * `sfi.component_change_attribution` — offline SetupAuditTrail attribution.
 *
 * @example
 *   const r = await componentChangeAttributionHandler(ctx, {
 *     componentId: 'ValidationRule:Account.Status_Required',
 *   });
 */
export const componentChangeAttributionHandler = async (
  ctx: Context,
  input: ComponentChangeAttributionInput,
): Promise<Result<McpResponse<ComponentChangeAttributionOutput>, McpError>> => {
  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };
  const limit = input.limit ?? 50;

  let apiName: string | null = null;
  let objectApiName: string | null = input.objectApiName ?? null;
  let componentId: string | null = input.componentId ?? null;
  let type: string | null = null;

  if (input.componentId !== undefined) {
    const nodeResult = await loadNode(ctx, input.componentId);
    if (!nodeResult.ok) return nodeResult;
    const node = nodeResult.value;
    apiName = node.apiName;
    type = node.type;
    componentId = node.id;
    // Prefer an explicit objectApiName; else derive from Object.Name apiNames.
    if (objectApiName === null && apiName.includes('.')) {
      objectApiName = apiName.slice(0, apiName.indexOf('.'));
    }
  }

  const trailPath = join(vaultPaths(ctx.vaultRoot).meta, SETUP_AUDIT_TRAIL_FILENAME);
  let raw: string;
  try {
    raw = await readFile(trailPath, 'utf8');
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') {
      return ok({
        data: {
          available: false,
          componentId,
          objectApiName,
          apiName,
          changes: [],
          totalMatched: 0,
          totalPersisted: 0,
          confidence: 'heuristic',
          remedy: ENABLE_HINT,
          disclosure: ATTRIBUTION_DISCLOSURE,
        },
        vaultState,
      });
    }
    return err({
      kind: 'internal',
      message: `failed to read ${SETUP_AUDIT_TRAIL_FILENAME}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  // COMPONENT-CHANGE-ATTRIBUTION-UNRESOLVED-OBJECT-SCOPE: a CALLER-supplied
  // `objectApiName` used to be handed straight to the heuristic needle-builder
  // below with no existence check — a made-up object name silently matched
  // zero SetupAuditTrail rows and came back `{available: true, changes: [],
  // totalMatched: 0}`, an UNCHECKED zero indistinguishable from "this real
  // object has no correlated changes". Resolve + verify it via the shared
  // object-scope resolver (mirrors flow_fault_audit /
  // flow_bulkification_audit): an unresolvable object REFUSES, and a real
  // object typed in the wrong case is corrected to the vault's exact casing
  // before it is used as a needle. Deliberately placed AFTER the missing-JSONL
  // early return above: that disposition is honest ("cannot check anything —
  // the feature was never enabled") regardless of the object's validity, so it
  // must not require a graph node either. An `objectApiName` DERIVED from a
  // validated `componentId` (below, when the caller omits `objectApiName`) is
  // already grounded in real vault data and is left unvalidated here.
  if (input.objectApiName !== undefined) {
    const scopeResult = await resolveExistingObjectScope(ctx.graph, {
      objectApiName: input.objectApiName,
    });
    if (!scopeResult.ok) return err(scopeResult.error);
    if (scopeResult.value !== null) objectApiName = scopeResult.value.object;
  }

  const rows = parsePersistedAuditRows(raw);
  const needles = attributionNeedles({ apiName, objectApiName, type });
  const changes = correlateAuditRows(rows, needles, limit);

  return ok({
    data: {
      available: true,
      componentId,
      objectApiName,
      apiName,
      changes,
      totalMatched: changes.length,
      totalPersisted: rows.length,
      confidence: 'heuristic',
      disclosure: ATTRIBUTION_DISCLOSURE,
    },
    vaultState,
  });
};
