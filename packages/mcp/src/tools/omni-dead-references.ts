/**
 * Handler for `sfi.omni_dead_references` (spec F3) — "does every rule, merge
 * field and payload key point at something that exists in the version that
 * runs?"
 *
 * Scope: one OmniScript (its active version, plus whitespace checks on the
 * Integration Procedures it calls), one Integration Procedure, or — with no
 * selector — every ACTIVE OmniScript and IP in the vault plus JSON-valued
 * custom metadata records. `org-kb/config/omnistudio.json` `appScope`
 * (`namePrefixes`) narrows the vault-wide sweep to the app's own components.
 *
 * Codes: DEAD_REFERENCE, WHITESPACE_KEY, UNRESOLVED_PLACEHOLDER,
 * LABEL_NOT_VALUE. Verdicts are three-valued: `defect`, or `unknown` with the
 * reason (an undeclared writer could supply the key). Defects only by default.
 */

import type { McpError, McpResponse, Node, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { buildIpModel } from '../omni/ip-model.js';
import { checkIpWhitespace, checkMetadataJsonKeys, checkScriptReferences } from '../omni/references.js';
import { buildScriptModelWithResponses } from '../omni/responses.js';
import { compareFindings, type OmniFinding } from '../omni/types.js';
import type { OmniWorld } from '../omni/world.js';
import type { Context } from '../server.js';

import {
  buildWorldOrError,
  configEcho,
  OMNI_MODEL_BOUNDARIES,
  type OmniAppliedScope,
  omniTrust,
  resolveOmniTarget,
} from './omni-common.js';
import { argsFingerprint, decodeCursor, paginate } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';

const TOOL = 'sfi.omni_dead_references';
const CODES = ['DEAD_REFERENCE', 'WHITESPACE_KEY', 'UNRESOLVED_PLACEHOLDER', 'LABEL_NOT_VALUE'] as const;

export const omniDeadReferencesInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  omniscript: z.string().min(1).optional(),
  ip: z.string().min(1).optional(),
  verdicts: z.array(z.enum(['defect', 'unknown'])).min(1).optional(),
  codes: z.array(z.enum(CODES)).min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

export type OmniDeadReferencesInput = z.infer<typeof omniDeadReferencesInputSchema>;

/** Response payload. */
export interface OmniDeadReferencesOutput {
  readonly appliedScope:
    | (OmniAppliedScope & { readonly mode: 'omniscript' | 'ip' })
    | { readonly mode: 'vault'; readonly scripts: number; readonly ips: number; readonly metadataRecords: number; readonly namePrefixes: readonly string[] };
  readonly config: { readonly status: string; readonly path: string };
  readonly refreshedAt: string;
  /** `CODE/verdict` → count, over every finding before the verdict / code filter. */
  readonly counts: Readonly<Record<string, number>>;
  readonly findings: readonly OmniFinding[];
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const REFERENCE_BOUNDARIES: readonly string[] = Object.freeze([
  'A key is PRODUCED by an element, a container, a Set Values key, a declared Custom LWC output, a runtime / launch key, or a MODELED response of an Integration Procedure the script calls. A reference to anything else is dead.',
  'DEAD_REFERENCE is a `defect` when nothing undeclared could supply the key, or when the referenced name was RENAMED between versions (same type, parent and label key — the reference was left behind). Otherwise it is `unknown`, naming the undeclared writers (Custom LWCs without declared outputs, actions whose response is not modeled) and any earlier version that produced it.',
  'A reference written with a stray space whose trimmed form resolves is reported once, as WHITESPACE_KEY. Whether the runtime trims Apex class / method names is not established from metadata — that runtime effect is `unknown`.',
]);

const inAppScope = (node: Node, prefixes: readonly string[]): boolean =>
  prefixes.length === 0 || prefixes.some((p) => node.apiName.startsWith(p));

/** The `sfi.omni_dead_references` handler. */
export const omniDeadReferencesHandler = async (
  ctx: Context,
  input: OmniDeadReferencesInput,
): Promise<Result<McpResponse<OmniDeadReferencesOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  let findings: OmniFinding[] = [];
  let appliedScope: OmniDeadReferencesOutput['appliedScope'];

  if (input.ip !== undefined && (input.omniscript !== undefined || input.componentId !== undefined)) {
    return err({ kind: 'invalid-query', message: 'pass ip OR omniscript / componentId, not both', path: 'ip' });
  }
  const componentIsIp = input.componentId?.startsWith('OmniIntegrationProcedure:') === true;
  if (input.ip !== undefined || componentIsIp) {
    const t = resolveOmniTarget(world, 'OmniIntegrationProcedure', { componentId: componentIsIp ? input.componentId : undefined, alias: input.ip }, 'ip');
    if (!t.ok) return t;
    findings = await checkOneIp(world, t.value.node);
    appliedScope = { ...t.value.scope, mode: 'ip' };
  } else if (input.omniscript !== undefined || input.componentId !== undefined) {
    const t = resolveOmniTarget(world, 'OmniScript', { componentId: input.componentId, alias: input.omniscript }, 'omniscript');
    if (!t.ok) return t;
    findings = await checkOneScript(world, t.value.node);
    appliedScope = { ...t.value.scope, mode: 'omniscript' };
  } else {
    const prefixes = world.config.appScope.namePrefixes;
    const scripts = world.scripts.filter((n) => n.properties['isActive'] === true && inAppScope(n, prefixes));
    const ips = world.ips.filter((n) => n.properties['isActive'] === true && inAppScope(n, prefixes));
    for (const n of scripts) findings.push(...(await checkOneScript(world, n, false)));
    for (const n of ips) findings.push(...(await checkOneIp(world, n)));
    const cmdt = await scanAllNodesOfTypes(ctx.graph, ['CustomMetadataRecord']);
    if (!cmdt.ok) return err({ kind: 'internal', message: `graph scan failed: ${cmdt.error.message}` });
    const records = cmdt.value.nodes
      .filter((n) => inAppScope(n, prefixes) || prefixes.length === 0 || prefixes.some((p) => String(n.properties['typeApiName'] ?? '').startsWith(p)))
      .map((n) => ({
        id: n.id,
        sourcePath: n.sourcePath,
        values: (Array.isArray(n.properties['values']) ? n.properties['values'] : [])
          .filter((v): v is { field: string; value: unknown } => typeof v === 'object' && v !== null && typeof (v as { field?: unknown }).field === 'string'),
      }));
    findings.push(...checkMetadataJsonKeys(records));
    appliedScope = { mode: 'vault', scripts: scripts.length, ips: ips.length, metadataRecords: records.length, namePrefixes: prefixes };
  }

  // De-duplicate (an IP called by several scripts is checked once per call site).
  const unique = new Map<string, OmniFinding>();
  for (const f of findings) unique.set(`${f.code}\u0000${f.componentId}\u0000${f.elementPath ?? ''}\u0000${f.message}`, f);
  const all = [...unique.values()].sort(compareFindings);
  const counts: Record<string, number> = {};
  for (const f of all) counts[`${f.code}/${f.verdict}`] = (counts[`${f.code}/${f.verdict}`] ?? 0) + 1;
  const verdicts = new Set<string>(input.verdicts ?? ['defect']);
  const codes = input.codes === undefined ? null : new Set<string>(input.codes);
  const selected = all.filter((f) => verdicts.has(f.verdict) && (codes === null || codes.has(f.code)));

  const fingerprint = argsFingerprint({
    scope: 'componentId' in appliedScope ? appliedScope.componentId : 'vault',
    verdicts: [...verdicts].sort(),
    codes: input.codes ?? null,
  });
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint });
    if (!decoded.ok) return decoded;
    offset = decoded.value.o;
  }
  const page = paginate(selected, {
    offset,
    limit: input.limit ?? 100,
    byteBudget: 26_000,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    keyOf: (f) => `${f.componentId}#${f.elementPath ?? ''}#${f.code}#${f.message}`,
  });
  return ok({
    data: {
      appliedScope,
      config: configEcho(world.configSource),
      refreshedAt: ctx.manifest.refreshedAt,
      counts,
      findings: page.items,
      pageInfo: page.pageInfo,
      boundaries: [...OMNI_MODEL_BOUNDARIES, ...REFERENCE_BOUNDARIES],
      trust: omniTrust(ctx, world, 'parsed'),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};

const checkOneScript = async (world: OmniWorld, node: Node, withCalledIps = true): Promise<OmniFinding[]> => {
  const loaded = await world.loadProcess(node);
  if (!loaded.ok) return [];
  const model = await buildScriptModelWithResponses(world, loaded.value);
  const out = await checkScriptReferences(world, model);
  if (withCalledIps) {
    const seen = new Set<string>();
    for (const a of model.actions) {
      if (a.ipKey === null) continue;
      const t = world.resolveIpKey(a.ipKey);
      if (t.node === null || seen.has(t.node.id)) continue;
      seen.add(t.node.id);
      out.push(...(await checkOneIp(world, t.node)));
    }
  }
  return out;
};

const checkOneIp = async (world: OmniWorld, node: Node): Promise<OmniFinding[]> => {
  const loaded = await world.loadProcess(node);
  if (!loaded.ok) return [];
  return checkIpWhitespace(buildIpModel(loaded.value));
};
