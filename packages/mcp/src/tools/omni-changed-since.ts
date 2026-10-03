/**
 * Handler for `sfi.omni_changed_since` (spec §11.8 / §12) — what changed in
 * OmniStudio since a previous refresh, semantically: for every OmniScript,
 * Integration Procedure, FlexCard and DataMapper, which version was active
 * then and now, activation flips, versions added / removed, and — where the
 * active version changed — the element-level diff (elements added, removed,
 * renamed; behaviour-relevant settings changed: show rules, formulas, required,
 * patterns…) between the two versions, so a finding whose evidence changed can
 * be re-checked before it goes out.
 *
 * Every refresh keeps a graph snapshot (`snapshots/refresh-…`); snapshots
 * record each component's runtime switch (`isActive`). OmniStudio keeps old
 * versions as separate files, so the element-level diff between the version
 * active then and the one active now is computed from the current source. An
 * active version EDITED IN PLACE (same version, different content) is reported
 * with an UNKNOWN element-level detail: the snapshot holds a hash, not source.
 */

import type { McpError, McpResponse, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listSnapshots, loadSnapshot, type SnapshotNode } from '@sf-intelligence/vault';
import { z } from 'zod';

import { diffVersions } from '../omni/version-diff.js';
import { OmniWorld } from '../omni/world.js';
import type { Context } from '../server.js';

import { captureLiveSnapshot } from './diff-snapshots.js';
import { argsFingerprint, decodeCursor, paginate } from './page-cursor.js';

const TOOL = 'sfi.omni_changed_since';
const OMNI_TYPES = new Set(['OmniScript', 'OmniIntegrationProcedure', 'OmniUiCard', 'OmniDataTransform']);

export const omniChangedSinceInputSchema = z.object({
  /** A snapshot label (`sfi snapshot list`); default: the snapshot of the previous refresh. */
  snapshot: z.string().min(1).optional(),
  /** Only these component kinds. */
  kinds: z.array(z.enum(['OmniScript', 'OmniIntegrationProcedure', 'OmniUiCard', 'OmniDataTransform'])).min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

export type OmniChangedSinceInput = z.infer<typeof omniChangedSinceInputSchema>;

/** How one component changed. */
export type OmniChangeKind =
  | 'added'
  | 'removed'
  | 'active-version-changed'
  | 'activated'
  | 'deactivated'
  | 'active-edited-in-place'
  | 'versions-changed'
  | 'mapper-changed';

/** One changed component (all versions of one OmniStudio component). */
export interface OmniChangeRow {
  readonly kind: string;
  /** Component key: `Type_SubType_Language` for a process, the name for a FlexCard / DataMapper. */
  readonly key: string;
  readonly change: OmniChangeKind;
  readonly before: { readonly activeId: string | null; readonly versions: readonly string[]; readonly activeKnown: boolean };
  readonly now: { readonly activeId: string | null; readonly versions: readonly string[] };
  /** Element-level diff between the version active then and the one active now. */
  readonly semantic?: {
    readonly added: number;
    readonly removed: number;
    readonly renamed: number;
    readonly changed: number;
    readonly sample: readonly string[];
  };
  readonly unknownReason?: string;
}

/** Response payload. */
export interface OmniChangedSinceOutput {
  readonly snapshot: { readonly label: string; readonly createdAt: string; readonly runtimeRecorded: boolean; readonly sourceHashed: boolean };
  readonly refreshedAt: string;
  readonly summary: Readonly<Record<string, number>>;
  readonly changes: readonly OmniChangeRow[];
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'Compares a refresh snapshot (graph: ids, a content hash, and — on snapshots written by this version or later — each component\'s isActive) with the current vault. Snapshots written earlier lack isActive: which version was active then is UNKNOWN for them; content changes are still detected by hash.',
  'The element-level diff runs between the version active then and the version active now when both files are in the current vault (OmniStudio keeps old versions). An active version edited in place changes content without a new version: its element-level detail is UNKNOWN (the snapshot holds a hash, not source).',
  'Content changes are judged by a hash of each OmniStudio source file when both snapshots carry one (it moves only when the org\'s metadata changes); on older snapshots by the extracted-property hash, which a product upgrade can also move — such rows carry an unknownReason.',
  'Version keys are the component file names without the version suffix.',
]);

const keyOf = (apiName: string): string => apiName.replace(/_\d+$/, '');

interface Group {
  readonly kind: string;
  readonly key: string;
  readonly versions: SnapshotNode[];
}

const group = (nodes: readonly SnapshotNode[], kinds: ReadonlySet<string>): Map<string, Group> => {
  const out = new Map<string, Group>();
  for (const n of nodes) {
    if (!OMNI_TYPES.has(n.type) || !kinds.has(n.type)) continue;
    const k = `${n.type}|${keyOf(n.apiName)}`;
    const g = out.get(k) ?? { kind: n.type, key: keyOf(n.apiName), versions: [] };
    g.versions.push(n);
    out.set(k, g);
  }
  return out;
};

const activeOf = (g: Group | undefined): SnapshotNode | null => {
  if (g === undefined) return null;
  if (g.kind === 'OmniDataTransform') {
    // A DataMapper has no runtime switch; callers resolve the newest version.
    return [...g.versions].sort((a, b) => (a.runtime?.versionNumber ?? 0) - (b.runtime?.versionNumber ?? 0)).at(-1) ?? null;
  }
  return g.versions.find((v) => v.runtime?.isActive === true) ?? null;
};

/** The `sfi.omni_changed_since` handler. */
export const omniChangedSinceHandler = async (
  ctx: Context,
  input: OmniChangedSinceInput,
): Promise<Result<McpResponse<OmniChangedSinceOutput>, McpError>> => {
  const list = await listSnapshots(ctx.vaultRoot);
  if (!list.ok) return err({ kind: 'internal', message: list.error.message });
  let label = input.snapshot;
  if (label === undefined) {
    // The previous refresh: the newest snapshot of a DIFFERENT source tree.
    const prior = [...list.value]
      .filter((m) => m.sourceTreeHash !== ctx.manifest.sourceTreeHash)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .at(-1);
    if (prior === undefined) {
      return err({ kind: 'invalid-query', message: 'no earlier snapshot to compare with — every refresh writes one; pass `snapshot` (see `sfi snapshot list`) or refresh again later', path: 'snapshot' });
    }
    label = prior.label;
  }
  const before = await loadSnapshot(ctx.vaultRoot, label);
  if (!before.ok) {
    return err({ kind: 'invalid-query', message: `snapshot '${label}' could not be read: ${before.error.message}`, path: 'snapshot' });
  }
  const now = await captureLiveSnapshot(ctx.graph, ctx.manifest, ctx.vaultRoot);
  if (!now.ok) return now;
  const kinds = new Set<string>(input.kinds ?? [...OMNI_TYPES]);
  const was = group(before.value.nodes, kinds);
  const is = group(now.value.nodes, kinds);
  const runtimeRecorded = before.value.nodes.some((n) => OMNI_TYPES.has(n.type) && n.runtime !== undefined);
  const nowNode = new Map(now.value.nodes.map((n) => [n.id, n]));
  /** Did this version's content change? Source hash when both snapshots carry it; else the property hash (which also moves on a product upgrade). */
  const contentChanged = (v: SnapshotNode): boolean | null => {
    const cur = nowNode.get(v.id);
    if (cur === undefined) return null;
    if (v.runtime?.sourceHash !== undefined && cur.runtime?.sourceHash !== undefined) return v.runtime.sourceHash !== cur.runtime.sourceHash;
    return v.propertiesHash !== cur.propertiesHash;
  };
  const sourceHashed = before.value.nodes.some((n) => n.runtime?.sourceHash !== undefined);
  const world = await OmniWorld.build(ctx);

  const rows: OmniChangeRow[] = [];
  for (const k of [...new Set([...was.keys(), ...is.keys()])].sort()) {
    const b = was.get(k);
    const n = is.get(k);
    const kind = (b ?? n)?.kind ?? '';
    const key = (b ?? n)?.key ?? '';
    const bActive = activeOf(b);
    const nActive = activeOf(n);
    const bIds = (b?.versions ?? []).map((v) => v.id).sort();
    const nIds = (n?.versions ?? []).map((v) => v.id).sort();
    const beforeState = { activeId: runtimeRecorded || kind === 'OmniDataTransform' ? (bActive?.id ?? null) : null, versions: bIds, activeKnown: runtimeRecorded || kind === 'OmniDataTransform' };
    const nowState = { activeId: nActive?.id ?? null, versions: nIds };
    let change: OmniChangeKind | null = null;
    if (b === undefined) change = 'added';
    else if (n === undefined) change = 'removed';
    else if (beforeState.activeKnown && bActive?.id !== nActive?.id) {
      change = bActive === null ? 'activated' : nActive === null ? 'deactivated' : kind === 'OmniDataTransform' ? 'mapper-changed' : 'active-version-changed';
    } else if (nActive !== null && b.versions.some((v) => v.id === nActive.id && contentChanged(v) === true)) {
      change = kind === 'OmniDataTransform' ? 'mapper-changed' : 'active-edited-in-place';
    } else if (JSON.stringify(bIds) !== JSON.stringify(nIds) || b.versions.some((v) => contentChanged(v) === true)) {
      change = 'versions-changed';
    }
    if (change === null) continue;
    let semantic: OmniChangeRow['semantic'];
    let unknownReason: string | undefined;
    if (change === 'active-version-changed' && bActive !== null && nActive !== null && world.ok && (kind === 'OmniScript' || kind === 'OmniIntegrationProcedure')) {
      const older = world.world.nodeById(bActive.id);
      const newer = world.world.nodeById(nActive.id);
      if (older !== null && newer !== null) {
        const lo = await world.world.loadProcess(older);
        const ln = await world.world.loadProcess(newer);
        if (lo.ok && ln.ok) {
          const d = diffVersions(lo.value, ln.value);
          semantic = {
            added: d.added.length,
            removed: d.removed.length,
            renamed: d.renamed.length,
            changed: d.changed.length,
            sample: [
              ...d.renamed.slice(0, 3).map((r) => `renamed ${r.from.elementPath} → ${r.to.name}`),
              ...d.removed.slice(0, 3).map((e) => `removed ${e.elementPath}`),
              ...d.added.slice(0, 3).map((e) => `added ${e.elementPath}`),
              ...d.changed.slice(0, 3).map((c) => `changed ${c.elementPath} ${c.property}`),
            ].slice(0, 10),
          };
        }
      } else {
        unknownReason = `the version active then (${bActive.id}) is no longer in the vault; the element-level diff needs both versions`;
      }
    }
    if (change === 'active-edited-in-place' || change === 'mapper-changed' || change === 'versions-changed') {
      if (!sourceHashed) {
        unknownReason = 'the snapshot predates source hashing: the change is detected from extracted properties, which a product upgrade also changes — confirm against the org before re-checking findings';
      } else if (change === 'active-edited-in-place') {
        unknownReason = 'the active version changed in place (same version, different source); the snapshot keeps a hash, not source, so the element-level change is not reconstructed';
      }
    }
    if (!beforeState.activeKnown && kind !== 'OmniDataTransform') {
      unknownReason ??= `the snapshot was written before runtime switches were recorded, so which version was active then is unknown`;
    }
    rows.push({ kind, key, change, before: beforeState, now: nowState, ...(semantic === undefined ? {} : { semantic }), ...(unknownReason === undefined ? {} : { unknownReason }) });
  }

  const summary: Record<string, number> = {};
  for (const r of rows) summary[r.change] = (summary[r.change] ?? 0) + 1;
  const fingerprint = argsFingerprint({ snapshot: label, kinds: [...kinds].sort() });
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint });
    if (!decoded.ok) return decoded;
    offset = decoded.value.o;
  }
  const page = paginate(rows, {
    offset,
    limit: input.limit ?? 100,
    byteBudget: 24_000,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    keyOf: (r) => `${r.kind}|${r.key}`,
  });
  return ok({
    data: {
      snapshot: { label, createdAt: before.value.meta.createdAt, runtimeRecorded, sourceHashed },
      refreshedAt: ctx.manifest.refreshedAt,
      summary,
      changes: page.items,
      pageInfo: page.pageInfo,
      boundaries: BOUNDARIES,
      trust: {
        provenance: 'offline_snapshot',
        confidence: 'parsed',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: runtimeRecorded ? { status: 'complete' } : { status: 'partial', missingCoverage: ['the snapshot predates recorded runtime switches: active versions then are unknown'] },
        limitations: [],
      },
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
