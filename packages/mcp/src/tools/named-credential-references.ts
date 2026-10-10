/**
 * Named Credential reference counting, shared by `sfi.endpoint_catalog` and
 * `sfi.integration_map` so the two tools can never grade the same credential
 * differently.
 *
 * A credential's references are its inbound `references` graph edges (an
 * ExternalService binding it, an OmniStudio IP's `callout:` alias, an Apex
 * `callout:Name` literal). NC-DYNAMIC-CALLOUT-ORPHANED: a shared helper that
 * builds the endpoint as `'callout:' + name` leaves NO literal for the graph
 * to link, so every credential handed to it read `orphaned: true`. When (and
 * only when) such a dynamic callout exists, a credential with no graph
 * referrer is looked up as a quoted NAME literal in Apex source
 * (`Util.send('POST', 'My_NC', …)`) and as a value on a custom-metadata
 * record (the endpoint-registry pattern) — a heuristic `name-literal`
 * reference. Found nowhere ⇒ still orphaned, with a caveat naming the
 * dynamic callers (the name may be runtime data). An OmniStudio IP Rest
 * Action declaring the credential counts too (`via: 'omni-rest'`).
 */
import { readFile } from 'node:fs/promises';

import type { Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

import { familyWasExtracted } from './absence-disclosure.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';

/**
 * A bare `'callout:'` literal (`'callout:' + name`, or a constant holding the
 * scheme that is concatenated later): the credential name is a runtime value.
 */
const DYNAMIC_CALLOUT = /'callout:'/;
const REFERENCED_BY_CAP = 10;

export interface NamedCredentialReferences {
  /** Graph referrer edges + name-literal referrers. `0` ⇒ orphaned. */
  readonly referenceCount: number;
  /** Who references it (capped); `via: 'name-literal'` is heuristic. */
  readonly referencedBy: readonly {
    readonly componentId: string;
    readonly via: 'graph' | 'omni-rest' | 'name-literal';
  }[];
  /** Present when orphaned while some Apex builds a callout endpoint at runtime. */
  readonly orphanedCaveat?: string;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface DynamicCalloutScan {
  readonly dynamicCallers: readonly string[];
  readonly literalHits: (name: string) => readonly string[];
}

const scanDynamicCallouts = async (ctx: Context): Promise<Result<DynamicCalloutScan, string>> => {
  const apex = await scanAllNodesOfTypes(ctx.graph, ['ApexClass', 'ApexTrigger']);
  if (!apex.ok) return err(apex.error.message);
  const sources: { readonly id: string; readonly text: string }[] = [];
  const dynamicCallers: string[] = [];
  for (const node of apex.value.nodes as readonly Node[]) {
    if (node.sourcePath === null || node.sourcePath.length === 0) continue;
    let text: string;
    try {
      text = await readFile(resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath), 'utf-8');
    } catch {
      continue;
    }
    // Comment-stripped so a commented-out call is neither evidence nor trigger.
    const code = text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
    sources.push({ id: node.id, text: code });
    if (DYNAMIC_CALLOUT.test(code)) dynamicCallers.push(node.id);
  }
  if (dynamicCallers.length === 0) return ok({ dynamicCallers, literalHits: () => [] });
  const records = await scanAllNodesOfTypes(ctx.graph, ['CustomMetadataRecord']);
  if (!records.ok) return err(records.error.message);
  const recordValues = (records.value.nodes as readonly Node[]).map((n) => ({
    id: n.id,
    text: JSON.stringify(n.properties),
  }));
  return ok({
    dynamicCallers: dynamicCallers.sort(),
    literalHits: (name: string): readonly string[] => {
      const quoted = new RegExp(`'${escapeRegExp(name)}'`, 'i');
      const value = new RegExp(`"${escapeRegExp(name)}"`, 'i');
      return [
        ...sources.filter((src) => quoted.test(src.text)).map((src) => src.id),
        ...recordValues.filter((r) => value.test(r.text)).map((r) => r.id),
      ].sort();
    },
  });
};

/**
 * Reference facts for each NamedCredential node, keyed by node id. The source
 * scan runs at most once per call, and only when some credential has no graph
 * referrer.
 */
/**
 * OmniStudio Integration Procedures whose Rest Action steps declare a
 * credential (`restEndpoints[].namedCredential`, the extractor's decoded
 * `propertySetConfig`). The IP extractor records the alias on the node but
 * mints no edge, so the catalog listed the alias under `omniRestEndpoints`
 * while the credential itself read `orphaned`. Keyed by lowercased name.
 */
const omniRestReferrers = async (ctx: Context): Promise<Result<ReadonlyMap<string, readonly string[]>, string>> => {
  const ips = await scanAllNodesOfTypes(ctx.graph, ['OmniIntegrationProcedure']);
  if (!ips.ok) return err(ips.error.message);
  const byName = new Map<string, Set<string>>();
  for (const ip of ips.value.nodes as readonly Node[]) {
    // An IP built before Rest Action decoding carries no `restEndpoints` at
    // all; presence (not emptiness) decides whether the family was read.
    const props = ip.properties;
    if (!familyWasExtracted(props, 'restEndpoints') || !Array.isArray(props['restEndpoints'])) continue;
    for (const step of props['restEndpoints'] as readonly unknown[]) {
      const nc = (step as { namedCredential?: unknown } | null)?.namedCredential;
      if (typeof nc !== 'string' || nc.length === 0) continue;
      const key = nc.replace(/^callout:/i, '').toLowerCase();
      const set = byName.get(key) ?? new Set<string>();
      set.add(ip.id);
      byName.set(key, set);
    }
  }
  return ok(new Map([...byName].map(([k, v]) => [k, [...v].sort()])));
};

export const namedCredentialReferences = async (
  ctx: Context,
  nodes: readonly Pick<Node, 'id' | 'apiName'>[],
): Promise<Result<ReadonlyMap<string, NamedCredentialReferences>, string>> => {
  const out = new Map<string, NamedCredentialReferences>();
  if (nodes.length === 0) return ok(out);
  const omni = await omniRestReferrers(ctx);
  if (!omni.ok) return err(omni.error);
  let dynamicScan: DynamicCalloutScan | null = null;
  for (const node of nodes) {
    const inbound = await listEdges(ctx.graph, node.id, { direction: 'in', edgeType: 'references' });
    if (!inbound.ok) return err(inbound.error.message);
    const graphRefs = [...new Set(inbound.value.map((e) => e.fromId as string))].sort();
    const graphRefSet = new Set(graphRefs);
    const omniRefs = (omni.value.get(node.apiName.toLowerCase()) ?? []).filter((id) => !graphRefSet.has(id));
    let literalRefs: readonly string[] = [];
    let orphanedCaveat: string | undefined;
    if (graphRefs.length === 0 && omniRefs.length === 0) {
      if (dynamicScan === null) {
        const scanned = await scanDynamicCallouts(ctx);
        if (!scanned.ok) return err(scanned.error);
        dynamicScan = scanned.value;
      }
      if (dynamicScan.dynamicCallers.length > 0) {
        literalRefs = dynamicScan.literalHits(node.apiName);
        if (literalRefs.length === 0) {
          orphanedCaveat = `${dynamicScan.dynamicCallers.length} Apex component(s) build a 'callout:' endpoint at runtime (${dynamicScan.dynamicCallers.slice(0, 3).join(', ')}); this credential's name may come from data, so orphaned covers modeled references only.`;
        }
      }
    }
    out.set(node.id, {
      referenceCount: inbound.value.length + omniRefs.length + literalRefs.length,
      referencedBy: [
        ...graphRefs.map((componentId) => ({ componentId, via: 'graph' as const })),
        ...omniRefs.map((componentId) => ({ componentId, via: 'omni-rest' as const })),
        ...literalRefs.map((componentId) => ({ componentId, via: 'name-literal' as const })),
      ].slice(0, REFERENCED_BY_CAP),
      ...(orphanedCaveat !== undefined ? { orphanedCaveat } : {}),
    });
  }
  return ok(out);
};
