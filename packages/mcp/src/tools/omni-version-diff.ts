/**
 * Handler for `sfi.omni_version_diff` (spec F3) — what changed between two
 * versions of one OmniScript / Integration Procedure: elements added,
 * removed and RENAMED (same type, parent and label key, new name) with every
 * reference in the newer version still using the old name, plus changes to
 * the settings that alter behaviour (show rules, payloads, masks, patterns,
 * conditions, delete / save wiring).
 *
 * Defaults: `to` = the active version, `from` = the highest version below it.
 */

import type { McpError, McpResponse, Node, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { diffVersions, type VersionDiff } from '../omni/version-diff.js';
import type { Context } from '../server.js';

import { buildWorldOrError, OMNI_MODEL_BOUNDARIES, omniTrust } from './omni-common.js';

export const omniVersionDiffInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  omniscript: z.string().min(1).optional(),
  ip: z.string().min(1).optional(),
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional(),
  /** Cap on the `changed` list (property changes can be numerous). */
  maxChanges: z.number().int().min(0).max(1000).optional(),
});

export type OmniVersionDiffInput = z.infer<typeof omniVersionDiffInputSchema>;

/** Response payload. */
export interface OmniVersionDiffOutput {
  readonly family: readonly { readonly componentId: string; readonly versionNumber: number | null; readonly isActive: boolean }[];
  readonly diff: VersionDiff;
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly renamed: number;
    readonly renamesWithStaleReferences: number;
    readonly changed: number;
    readonly changedShown: number;
  };
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const versionOf = (n: Node): number | null => {
  const v = n.properties['versionNumber'];
  return typeof v === 'number' ? v : null;
};

/** The `sfi.omni_version_diff` handler. */
export const omniVersionDiffHandler = async (
  ctx: Context,
  input: OmniVersionDiffInput,
): Promise<Result<McpResponse<OmniVersionDiffOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  const selector = input.componentId ?? input.omniscript ?? input.ip;
  if (selector === undefined) {
    return err({ kind: 'invalid-query', message: 'pass componentId (or omniscript / ip) naming the component', path: 'componentId' });
  }
  const kind = input.ip !== undefined || selector.startsWith('OmniIntegrationProcedure:') ? 'OmniIntegrationProcedure' : 'OmniScript';
  const hits = world.resolveProcessSelector(selector, kind);
  const first = hits[0];
  if (first === undefined) {
    return err({ kind: 'component-not-found', message: `no ${kind} answers to '${selector}'`, path: 'componentId' });
  }
  const family = [...world.familyOf(first)].sort((a, b) => (versionOf(a) ?? 0) - (versionOf(b) ?? 0));
  const byVersion = (v: number): Node | undefined => family.find((n) => versionOf(n) === v);
  const toNode = input.to !== undefined ? byVersion(input.to) : world.activeVersionOf(first) ?? family.at(-1);
  if (toNode === undefined) {
    return err({ kind: 'component-not-found', message: `version ${input.to ?? '?'} not found; versions: ${family.map(versionOf).join(', ')}`, path: 'to' });
  }
  const toV = versionOf(toNode) ?? 0;
  const fromNode = input.from !== undefined
    ? byVersion(input.from)
    : [...family].reverse().find((n) => (versionOf(n) ?? 0) < toV);
  if (fromNode === undefined) {
    return err({
      kind: 'component-not-found',
      message: input.from !== undefined ? `version ${input.from} not found; versions: ${family.map(versionOf).join(', ')}` : `no version earlier than ${toV} to diff against`,
      path: 'from',
    });
  }
  const [a, b] = await Promise.all([world.loadProcess(fromNode), world.loadProcess(toNode)]);
  if (!a.ok) return err({ kind: 'component-not-found', message: `${fromNode.id}: ${a.reason}`, path: fromNode.sourcePath });
  if (!b.ok) return err({ kind: 'component-not-found', message: `${toNode.id}: ${b.reason}`, path: toNode.sourcePath });
  const diff = diffVersions(a.value, b.value);
  const cap = input.maxChanges ?? 200;
  return ok({
    data: {
      family: family.map((n) => ({ componentId: n.id, versionNumber: versionOf(n), isActive: n.properties['isActive'] === true })),
      diff: { ...diff, changed: diff.changed.slice(0, cap) },
      summary: {
        added: diff.added.length,
        removed: diff.removed.length,
        renamed: diff.renamed.length,
        renamesWithStaleReferences: diff.renamed.filter((r) => r.staleReferences.length > 0).length,
        changed: diff.changed.length,
        changedShown: Math.min(cap, diff.changed.length),
      },
      boundaries: [
        ...OMNI_MODEL_BOUNDARIES,
        'A rename is inferred from shape (same type, parent and label key, different name, paired one-to-one); an element moved to another parent, or relabelled at the same time, shows as removed + added.',
      ],
      trust: omniTrust(ctx, world, 'parsed'),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
