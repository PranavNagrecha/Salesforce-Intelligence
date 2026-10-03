/**
 * Handler for `sfi.omni_edit_block_audit` (spec F4) — for every Edit Block
 * (a list of cards with Add / Edit / Delete) of the active OmniScript, or of
 * every active OmniScript: is Delete wired to the server, where does the
 * deleted record's id come from, and does an edited card update its record or
 * insert a duplicate?
 */

import type { McpError, McpResponse, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { z } from 'zod';

import { auditEditBlocks, type EditBlockRow } from '../omni/edit-block-audit.js';
import { buildScriptModelWithResponses } from '../omni/responses.js';
import { compareFindings, type OmniFinding } from '../omni/types.js';
import type { Context } from '../server.js';

import { computeDeleteImpact, type DeleteImpactCore } from './delete-impact.js';
import {
  buildWorldOrError,
  configEcho,
  OMNI_MODEL_BOUNDARIES,
  type OmniAppliedScope,
  omniTrust,
  resolveOmniTarget,
} from './omni-common.js';
import { argsFingerprint, decodeCursor, paginate } from './page-cursor.js';

const TOOL = 'sfi.omni_edit_block_audit';

export const omniEditBlockAuditInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  omniscript: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

export type OmniEditBlockAuditInput = z.infer<typeof omniEditBlockAuditInputSchema>;

/** Response payload. */
export interface OmniEditBlockAuditOutput {
  readonly appliedScope: (OmniAppliedScope & { readonly mode: 'omniscript' }) | { readonly mode: 'vault'; readonly scripts: number };
  readonly config: { readonly status: string; readonly path: string };
  readonly refreshedAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly findings: readonly OmniFinding[];
  /** One row per Edit Block (paged). */
  readonly editBlocks: readonly (EditBlockRow & { readonly componentId: string })[];
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const EDIT_BLOCK_BOUNDARIES: readonly string[] = Object.freeze([
  'Two server-delete mechanisms exist in metadata — the Edit Block\'s `deleteIPKey` (+ `deleteIPExtraPayload`) and a child Integration Procedure Action named `<EditBlockName>-Delete` — and a block may carry both. Which one the runtime uses when both are present is not established from metadata; both are listed.',
  'A delete IP that decides what to delete in Apex (it receives the whole card) makes the record-id source `unknown` until that Apex is analysed.',
  'Record identity: a card keeps its record when some save path carries the row\'s record Id (a `…RecId` Formula, or the prefill-supplied `Id`) into a write of `Id`; otherwise an edit inserts a new record.',
  'DELETE_WITHOUT_GUARD takes the object a card\'s save path writes as the object its delete removes (`inferred`), then reads that object\'s relationship fields and delete automation the way `sfi.record_delete_impact` does.',
]);

/**
 * DELETE_WITHOUT_GUARD (spec F4, joins F7): an Edit Block whose delete removes
 * records of an object that has SetNull (orphaned) children. `defect` when the
 * object has no delete trigger or delete flow; `unknown` when it has one (it
 * may clean up or block — automation logic is not analysed) or when a trigger's
 * events were not recorded.
 */
const deleteWithoutGuard = async (
  ctx: Context,
  rows: readonly (EditBlockRow & { readonly componentId: string })[],
  sourcePathOf: ReadonlyMap<string, string>,
): Promise<OmniFinding[]> => {
  const impacts = new Map<string, DeleteImpactCore | null>();
  const findings: OmniFinding[] = [];
  for (const row of rows) {
    if (row.deleteMechanisms.length === 0) continue;
    for (const object of row.recordIdentity.objectsWritten) {
      if (!impacts.has(object)) {
        const r = await computeDeleteImpact(ctx, object);
        impacts.set(object, r.ok ? r.value : null);
      }
      const impact = impacts.get(object) ?? null;
      if (impact === null) continue;
      const orphaned = impact.children.filter((c) => c.depth === 1 && c.effect === 'ORPHANED');
      if (orphaned.length === 0) continue;
      const sourcePath = sourcePathOf.get(row.componentId) ?? '';
      const mechanisms = row.deleteMechanisms.map((m) => `${m.mechanism} → ${m.ipKey}`);
      const verdict = impact.guardStatus === 'none' ? 'defect' : 'unknown';
      findings.push({
        code: 'DELETE_WITHOUT_GUARD',
        verdict,
        componentId: row.componentId,
        sourcePath,
        elementPath: row.elementPath,
        line: row.line,
        message:
          `${row.elementPath} deletes ${object} records (the object its cards save) through ${mechanisms.join(', ')}; ` +
          `each delete leaves ${orphaned.length} relationship field(s) blank on surviving child records (${orphaned.map((c) => c.field.slice('CustomField:'.length)).join(', ')})` +
          (impact.guardStatus === 'none' ? `, and no delete trigger or delete flow on ${object} cleans up or blocks it` : ''),
        confidence: 'inferred',
        ...(verdict === 'unknown'
          ? {
              unknownReason:
                impact.guardStatus === 'present'
                  ? `delete automation runs on ${object} (${impact.guards.map((g) => g.componentId).join(', ')}); whether it removes or re-parents the children is not analysed`
                  : `an Apex trigger on ${object} has no recorded events, so a delete trigger cannot be ruled out`,
            }
          : {}),
        evidence: {
          object,
          orphanedFields: orphaned.map((c) => c.field),
          guards: impact.guards.map((g) => g.componentId),
          mechanisms,
          objectFrom: 'the objects the card\'s save path writes',
        },
        citations: [
          { componentId: row.componentId, sourcePath, elementPath: row.elementPath, ...(row.line === null ? {} : { line: row.line }) },
          ...orphaned.slice(0, 5).map((c) => ({ componentId: c.field, sourcePath: c.sourcePath ?? '', ...(c.line === null ? {} : { line: c.line }) })),
        ],
      });
    }
  }
  return findings;
};

/** The `sfi.omni_edit_block_audit` handler. */
export const omniEditBlockAuditHandler = async (
  ctx: Context,
  input: OmniEditBlockAuditInput,
): Promise<Result<McpResponse<OmniEditBlockAuditOutput>, McpError>> => {
  const worldR = await buildWorldOrError(ctx);
  if (!worldR.ok) return worldR;
  const world = worldR.value;
  let targets;
  let appliedScope: OmniEditBlockAuditOutput['appliedScope'];
  if (input.componentId !== undefined || input.omniscript !== undefined) {
    const t = resolveOmniTarget(world, 'OmniScript', { componentId: input.componentId, alias: input.omniscript }, 'omniscript');
    if (!t.ok) return t;
    targets = [t.value.node];
    appliedScope = { ...t.value.scope, mode: 'omniscript' };
  } else {
    const prefixes = world.config.appScope.namePrefixes;
    targets = world.scripts
      .filter((n) => n.properties['isActive'] === true && (prefixes.length === 0 || prefixes.some((p) => n.apiName.startsWith(p))))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    appliedScope = { mode: 'vault', scripts: targets.length };
  }
  const findings: OmniFinding[] = [];
  const rows: (EditBlockRow & { componentId: string })[] = [];
  const sourcePathOf = new Map<string, string>();
  for (const node of targets) {
    const loaded = await world.loadProcess(node);
    if (!loaded.ok) continue;
    const model = await buildScriptModelWithResponses(world, loaded.value);
    const r = await auditEditBlocks(world, model);
    findings.push(...r.findings);
    sourcePathOf.set(node.id, model.sourcePath);
    for (const row of r.rows) rows.push({ ...row, componentId: node.id });
  }
  findings.push(...(await deleteWithoutGuard(ctx, rows, sourcePathOf)));
  const counts: Record<string, number> = {};
  for (const f of findings) counts[`${f.code}/${f.verdict}`] = (counts[`${f.code}/${f.verdict}`] ?? 0) + 1;
  const fingerprint = argsFingerprint({ scope: 'componentId' in appliedScope ? appliedScope.componentId : 'vault' });
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint });
    if (!decoded.ok) return decoded;
    offset = decoded.value.o;
  }
  const page = paginate(rows, {
    offset,
    limit: input.limit ?? 50,
    byteBudget: 20_000,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    keyOf: (r) => r.element,
  });
  return ok({
    data: {
      appliedScope,
      config: configEcho(world.configSource),
      refreshedAt: ctx.manifest.refreshedAt,
      counts,
      findings: findings.sort(compareFindings),
      editBlocks: page.items,
      pageInfo: page.pageInfo,
      boundaries: [...OMNI_MODEL_BOUNDARIES, ...EDIT_BLOCK_BOUNDARIES],
      trust: omniTrust(ctx, world, findings.some((f) => f.confidence === 'inferred') ? 'heuristic' : 'parsed'),
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
