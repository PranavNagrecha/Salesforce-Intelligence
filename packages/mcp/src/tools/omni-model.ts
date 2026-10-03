/**
 * Handler for `sfi.omni_model` (spec F1) — the inside of one OmniStudio
 * component as nodes and edges: an OmniScript's elements and the data keys
 * they produce and read, the server calls they make (and the IP input keys
 * those fill), an Integration Procedure's steps and outputs, a DataMapper's
 * items and the fields a Load writes.
 *
 * OmniScript / IP: the ACTIVE version unless `version` pins one explicitly
 * (the version diff and audits of retired versions need that). DataMappers
 * are not version-switched at runtime; the selector's own node is used.
 */

import type { McpError, McpResponse, Node, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { buildIpModel } from '../omni/ip-model.js';
import { buildMapperModel } from '../omni/mapper-model.js';
import { ipSlice, mapperSlice, type OmniModelSlice, scriptSlice } from '../omni/model.js';
import { buildScriptModel } from '../omni/script-model.js';
import type { OmniModelEdge, OmniModelNode } from '../omni/types.js';
import type { OmniWorld } from '../omni/world.js';
import type { Context } from '../server.js';

import { buildWorldOrError, configEcho, OMNI_MODEL_BOUNDARIES, omniTrust, resolveOmniTarget } from './omni-common.js';
import { argsFingerprint, decodeCursor, paginate } from './page-cursor.js';

const TOOL = 'sfi.omni_model';
const NODE_KINDS = ['OmniElement', 'OmniIpStep', 'OmniDataKey', 'DataMapperItem'] as const;
const EDGE_KINDS = [
  'containsElement',
  'producesKey',
  'readsKey',
  'sendsToIp',
  'stepOutputs',
  'dmReads',
  'dmWrites',
  'writesField',
  'deletesVia',
  'prefillsKey',
] as const;

export const omniModelInputSchema = z.object({
  componentId: z.string().min(1),
  version: z.number().int().min(0).optional(),
  include: z.enum(['nodes', 'edges']).optional(),
  nodeKinds: z.array(z.enum(NODE_KINDS)).min(1).optional(),
  edgeKinds: z.array(z.enum(EDGE_KINDS)).min(1).optional(),
  elementPath: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

export type OmniModelInput = z.infer<typeof omniModelInputSchema>;

/** Response payload. */
export interface OmniModelOutput {
  readonly appliedScope: {
    readonly requested: string;
    readonly componentId: string;
    readonly componentType: string;
    readonly versionNumber: number | null;
    readonly isActiveVersion: boolean | null;
    readonly redirectedFrom?: string;
  };
  readonly config: { readonly status: string; readonly path: string };
  readonly counts: { readonly nodes: Readonly<Record<string, number>>; readonly edges: Readonly<Record<string, number>> };
  readonly include: 'nodes' | 'edges';
  readonly nodes?: readonly OmniModelNode[];
  readonly edges?: readonly OmniModelEdge[];
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const countBy = <T>(xs: readonly T[], key: (x: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
};

const versionOf = (n: Node): number | null => {
  const v = n.properties['versionNumber'];
  return typeof v === 'number' ? v : null;
};

/** Find the component: OmniScript / IP (active or pinned version) or DataMapper. */
const locate = (
  world: OmniWorld,
  selector: string,
  version: number | undefined,
): Result<{ node: Node; redirectedFrom?: string }, McpError> => {
  const sel = selector.trim();
  const dm = sel.startsWith('OmniDataTransform:')
    ? world.nodeById(sel)
    : world.mappers.find((n) => n.apiName === sel || n.properties['uniqueName'] === sel) ??
      world.resolveBundle(sel).node;
  const kinds: ('OmniScript' | 'OmniIntegrationProcedure')[] = sel.startsWith('OmniScript:')
    ? ['OmniScript']
    : sel.startsWith('OmniIntegrationProcedure:')
      ? ['OmniIntegrationProcedure']
      : sel.startsWith('OmniDataTransform:')
        ? []
        : ['OmniScript', 'OmniIntegrationProcedure'];
  const processHits = kinds.flatMap((k) => world.resolveProcessSelector(sel, k));
  if (dm !== null && dm !== undefined && processHits.length === 0) return ok({ node: dm });
  if (processHits.length === 0) {
    return err({ kind: 'component-not-found', message: `no OmniScript, Integration Procedure or DataMapper answers to '${sel}'`, path: 'componentId' });
  }
  const kindsHit = new Set(processHits.map((n) => n.type));
  if (kindsHit.size > 1 || (dm !== null && dm !== undefined)) {
    return err({ kind: 'invalid-query', message: `'${sel}' names more than one OmniStudio component type; pass the canonical id`, path: 'componentId' });
  }
  const first = processHits[0] as Node;
  if (version !== undefined) {
    const pinned = world.familyOf(first).find((n) => versionOf(n) === version);
    if (pinned === undefined) {
      return err({ kind: 'component-not-found', message: `${first.id}'s family has no version ${version} (versions: ${world.familyOf(first).map((n) => versionOf(n)).join(', ')})`, path: 'version' });
    }
    return ok({ node: pinned });
  }
  const target = resolveOmniTarget(world, first.type as 'OmniScript' | 'OmniIntegrationProcedure', { componentId: sel }, 'componentId');
  if (!target.ok) return target;
  return ok({ node: target.value.node, ...(target.value.scope.redirectedFrom === undefined ? {} : { redirectedFrom: target.value.scope.redirectedFrom }) });
};

/** The `sfi.omni_model` handler. */
export const omniModelHandler = async (
  ctx: Context,
  input: OmniModelInput,
): Promise<Result<McpResponse<OmniModelOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  const located = locate(world, input.componentId, input.version);
  if (!located.ok) return located;
  const node = located.value.node;
  let slice: OmniModelSlice;
  if (node.type === 'OmniDataTransform') {
    const loaded = await world.loadMapper(node);
    if (!loaded.ok) return err({ kind: 'component-not-found', message: `${node.id}: ${loaded.reason}`, path: node.sourcePath });
    slice = mapperSlice(buildMapperModel(loaded.value), (o, f) => `CustomField:${o}.${f}`);
  } else {
    const loaded = await world.loadProcess(node);
    if (!loaded.ok) return err({ kind: 'component-not-found', message: `${node.id}: ${loaded.reason}`, path: node.sourcePath });
    slice = node.type === 'OmniScript'
      ? scriptSlice(world, buildScriptModel(loaded.value, { customLwcOutputs: world.config.customLwcOutputs, launchParameters: world.config.launchParameters }))
      : ipSlice(world, buildIpModel(loaded.value));
  }
  const include = input.include ?? 'nodes';
  const pathFilter = input.elementPath;
  const nodeKinds = input.nodeKinds === undefined ? null : new Set<string>(input.nodeKinds);
  const edgeKinds = input.edgeKinds === undefined ? null : new Set<string>(input.edgeKinds);
  const inPath = (id: string): boolean => pathFilter === undefined || (id.split('#')[1] ?? '').startsWith(pathFilter);
  const nodes = slice.nodes.filter((n) => (nodeKinds === null || nodeKinds.has(n.kind)) && inPath(n.id));
  const edges = slice.edges.filter((e) => (edgeKinds === null || edgeKinds.has(e.kind)) && (inPath(e.from) || inPath(e.to)));
  const fingerprint = argsFingerprint({
    componentId: node.id,
    include,
    nodeKinds: input.nodeKinds ?? null,
    edgeKinds: input.edgeKinds ?? null,
    elementPath: pathFilter ?? null,
  });
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint });
    if (!decoded.ok) return decoded;
    offset = decoded.value.o;
  }
  const binding = { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint };
  const page =
    include === 'nodes'
      ? paginate(nodes, { offset, limit: input.limit ?? 200, byteBudget: 30_000, binding, keyOf: (n) => n.id })
      : paginate(edges, { offset, limit: input.limit ?? 200, byteBudget: 30_000, binding, keyOf: (e) => `${e.from}>${e.kind}>${e.to}` });
  const isActive = node.type === 'OmniDataTransform' ? null : node.properties['isActive'] === true;
  return ok({
    data: {
      appliedScope: {
        requested: input.componentId,
        componentId: node.id,
        componentType: node.type,
        versionNumber: versionOf(node),
        isActiveVersion: isActive,
        ...(located.value.redirectedFrom === undefined ? {} : { redirectedFrom: located.value.redirectedFrom }),
      },
      config: configEcho(world.configSource),
      counts: { nodes: countBy(slice.nodes, (n) => n.kind), edges: countBy(slice.edges, (e) => e.kind) },
      include,
      ...(include === 'nodes' ? { nodes: page.items as readonly OmniModelNode[] } : { edges: page.items as readonly OmniModelEdge[] }),
      pageInfo: page.pageInfo,
      boundaries: OMNI_MODEL_BOUNDARIES,
      trust: omniTrust(ctx, world, 'parsed'),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
