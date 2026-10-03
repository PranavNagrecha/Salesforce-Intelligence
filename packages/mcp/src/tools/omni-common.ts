/**
 * Shared plumbing for the OmniStudio analysis tools (`sfi.omni_*`): resolving
 * the component a call is about to the version that RUNS, the trust block,
 * the boundary disclosures every response carries, and row pagination.
 *
 * Selector contract (natural selectors, `appliedScope` echo): a tool accepts
 * `componentId` (canonical) and the spec-named alias (`omniscript` / `ip`).
 * Either may be a canonical id, a unique name (`Type_SubType_Language_N`), a
 * `Type/SubType/Language` key (OmniScript) or a `Type_SubType` key (IP). Two
 * selectors naming different components are refused; a request for an
 * INACTIVE version is answered for the ACTIVE version of the same family and
 * says so — OmniScript / IP `isActive` is the runtime switch, and judging a
 * version that does not run would report defects users never hit.
 */

import type { McpError, Node, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import type { OmniConfigSource } from '../omni/config.js';
import { OmniWorld } from '../omni/world.js';
import type { Context } from '../server.js';

import { managedPackageLimitations } from './omni-disclosures.js';

/** The scope a call was actually answered for. */
export interface OmniAppliedScope {
  readonly requested: string;
  readonly componentId: string;
  readonly uniqueName: string;
  readonly versionNumber: number | null;
  readonly isActiveVersion: boolean;
  /** Present when the request named an inactive version and the active one was analysed. */
  readonly redirectedFrom?: string;
  /** Every version of the family, id-ASC. */
  readonly familyVersions: readonly string[];
}

const num = (node: Node, key: string): number | null => {
  const v = node.properties[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * Resolve a script / IP selector pair to the node to analyse (its active
 * version). Returns an `invalid-query` / `component-not-found` McpError the
 * handler returns verbatim.
 */
export const resolveOmniTarget = (
  world: OmniWorld,
  kind: 'OmniScript' | 'OmniIntegrationProcedure',
  selectors: { readonly componentId?: string | undefined; readonly alias?: string | undefined },
  aliasName: string,
): Result<{ node: Node; scope: OmniAppliedScope }, McpError> => {
  const given = [selectors.componentId, selectors.alias].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
  if (given.length === 0) {
    return err({ kind: 'invalid-query', message: `pass componentId (or ${aliasName}) naming the ${kind}`, path: 'componentId' });
  }
  const resolved = given.map((sel) => ({ sel, nodes: world.resolveProcessSelector(sel, kind) }));
  for (const r of resolved) {
    if (r.nodes.length === 0) {
      return err({
        kind: 'component-not-found',
        message: `no ${kind} in this vault answers to '${r.sel}' (tried canonical id, unique name and callable key)${world.scanIncomplete ? '; the OmniStudio node scan was incomplete, so absence is not proven' : ''}`,
        path: r.sel,
      });
    }
  }
  const families = resolved.map((r) => new Set(r.nodes.flatMap((n) => world.familyOf(n).map((f) => f.id))));
  if (families.length === 2) {
    const [a, b] = families as [Set<string>, Set<string>];
    if (![...a].some((id) => b.has(id))) {
      return err({
        kind: 'invalid-query',
        message: `componentId '${selectors.componentId ?? ''}' and ${aliasName} '${selectors.alias ?? ''}' name different ${kind}s; pass one`,
        path: 'componentId',
      });
    }
  }
  const first = resolved[0] as { sel: string; nodes: readonly Node[] };
  const requestedNode = first.nodes[0] as Node;
  const family = world.familyOf(requestedNode);
  const active = world.activeVersionOf(requestedNode);
  if (active === null) {
    return err({
      kind: 'invalid-query',
      message: `${kind} '${first.sel}' has no active version (${family.map((f) => f.id).join(', ')}): the runtime runs none of them, so there is nothing to judge — pass a specific version to omni_version_diff instead`,
      path: 'componentId',
    });
  }
  const uniqueName = typeof active.properties['uniqueName'] === 'string' ? active.properties['uniqueName'] : active.apiName;
  const scope: OmniAppliedScope = {
    requested: first.sel,
    componentId: active.id,
    uniqueName,
    versionNumber: num(active, 'versionNumber'),
    isActiveVersion: true,
    ...(first.nodes.length === 1 && requestedNode.id !== active.id ? { redirectedFrom: requestedNode.id } : {}),
    familyVersions: family.map((f) => f.id).sort(),
  };
  return ok({ node: active, scope });
};

/** Build the world or fail with an internal error. */
export const buildWorldOrError = async (
  ctx: Context,
): Promise<Result<OmniWorld, McpError>> => {
  const built = await OmniWorld.build(ctx);
  if (!built.ok) return err({ kind: 'internal', message: built.message });
  return ok(built.world);
};

/** Disclosures every OmniStudio analysis response carries. */
export const OMNI_MODEL_BOUNDARIES: readonly string[] = Object.freeze([
  'The OmniStudio model is built from the RETRIEVED metadata (element trees, payload maps, DataMapper items), re-parsed from the vault source on each call. It describes what the metadata wires, not a runtime trace.',
  'Only the ACTIVE version of an OmniScript / Integration Procedure is judged (`isActive` is the runtime switch). A DataMapper\'s `active` flag is NOT a runtime switch — inactive mappers run.',
  'Three-valued: a path that enters a custom Lightning Web Component, unanalysed Apex, a REST call or a component missing from the vault is UNKNOWN (with the reason), never OK and never a defect.',
  'Keys are compared RAW. A key with a stray space or one underscore too many is reported as a defect; near-misses are suggestions, never auto-matched.',
  'Runtime semantics the metadata does not state are marked `inferred`: an Edit Block `-New` / `-Edit` / `-Delete` action sends the card\'s row; an Edit Block `saveIPKey` / `deleteIPKey` is certain to send only its declared extra payload.',
]);

/** The trust block for an offline OmniStudio analysis. */
export const omniTrust = (
  ctx: Context,
  world: OmniWorld,
  confidence: TrustSummary['confidence'],
  extraLimitations: readonly string[] = [],
): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence,
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness: world.scanIncomplete
    ? { status: 'partial', missingCoverage: ['OmniStudio node scan stopped at its residual cap'] }
    : { status: 'complete' },
  limitations: [...configLimitations(world.configSource), ...managedPackageLimitations(world.managedPackage), ...extraLimitations],
});

/** Limitations that follow from the vault's OmniStudio config file. */
export const configLimitations = (source: OmniConfigSource): string[] => {
  if (source.status === 'loaded') return [];
  if (source.status === 'invalid') {
    return [`org-kb/config/omnistudio.json is INVALID (${source.error ?? 'unknown error'}); defaults were used — generic-upsert adapters, completion markers and loggers are recognized only heuristically.`];
  }
  return ['No org-kb/config/omnistudio.json: generic-upsert adapters are recognized heuristically (`inferred`), and no completion markers, loggers or prefix variants are configured.'];
};

/** Config echo carried on responses. */
export const configEcho = (source: OmniConfigSource): { readonly status: string; readonly path: string } => ({
  status: source.status,
  path: 'config/omnistudio.json',
});
