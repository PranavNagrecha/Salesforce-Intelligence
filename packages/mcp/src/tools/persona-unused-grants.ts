/**
 * Handler for `sfi.persona_unused_grants` (spec F6) — "which object and field
 * permissions does this kind of user have that nothing they can run uses?"
 *
 * The persona (a profile + permission sets + permission set groups, from
 * `org-kb/config/personas.json` or inline) is composed by the effective-
 * permissions engine. Its reachable automation (`computePersonaUsage`: active
 * OmniStudio and what it dispatches, Apex entered from it / from Lightning
 * components / from UI-callable granted classes, plus triggers and
 * record-triggered flows on the objects written) supplies the uses.
 *
 * Per object the persona can create / edit / delete:
 *   - USED     — reachable automation performs the operation (evidence listed);
 *   - UNKNOWN  — nothing analysed performs it, but something unanalysed could:
 *                a generic Apex writer the persona reaches whose object comes at
 *                runtime (when reachable code names this object), a Lightning
 *                component that references the object directly, or an active
 *                flow not reached through the persona's automation;
 *   - UNUSED   — nothing reachable performs it (`UNUSED_CREATE` / `_EDIT` /
 *                `_DELETE`, verdict `defect`, confidence `inferred`).
 * Field edit grants on an object whose create / edit is used are checked against
 * the fields reachable writers write (`UNUSED_FIELD_EDIT`, one finding per
 * object; `unknown` when a writer's field set is not visible).
 */

import { readFile } from 'node:fs/promises';

import type { ComponentId, McpError, McpResponse, PageInfo, TrustSummary } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';
import { z } from 'zod';

import { compareFindings, type OmniFinding } from '../omni/types.js';
import type { Context } from '../server.js';

import { computeEffectiveGrants } from './effective-permissions.js';
import { argsFingerprint, decodeCursor, paginate } from './page-cursor.js';
import { resolvePersona, type ResolvedPersona } from './persona-config.js';
import { computePersonaUsage, type GrantOp, type PersonaUsage, type UseEvidence } from './persona-usage.js';

const TOOL = 'sfi.persona_unused_grants';
const OPS: readonly GrantOp[] = ['create', 'edit', 'delete'];
const FLAG_OF: Readonly<Record<GrantOp, 'allowCreate' | 'allowEdit' | 'allowDelete'>> = {
  create: 'allowCreate',
  edit: 'allowEdit',
  delete: 'allowDelete',
};
const CODE_OF: Readonly<Record<GrantOp, string>> = {
  create: 'UNUSED_CREATE',
  edit: 'UNUSED_EDIT',
  delete: 'UNUSED_DELETE',
};

export const personaUnusedGrantsInputSchema = z.object({
  /** A persona declared in org-kb/config/personas.json. */
  persona: z.string().min(1).optional(),
  /** Inline persona: a profile name or `Profile:` id. */
  profile: z.string().min(1).optional(),
  /** Inline persona: permission set (or group) names / ids. */
  permissionSets: z.array(z.string().min(1)).optional(),
  permissionSetGroups: z.array(z.string().min(1)).optional(),
  /** Only report these finding codes. */
  codes: z.array(z.enum(['UNUSED_CREATE', 'UNUSED_EDIT', 'UNUSED_DELETE', 'UNUSED_FIELD_EDIT', 'USED_ONLY_IN_SYSTEM_MODE'])).min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
});

export type PersonaUnusedGrantsInput = z.infer<typeof personaUnusedGrantsInputSchema>;

/** The verdict on one granted operation. */
export interface OpVerdict {
  readonly status: 'USED' | 'UNUSED' | 'UNKNOWN';
  readonly evidence: readonly UseEvidence[];
  readonly evidenceCount: number;
  readonly unknownReasons?: readonly string[];
  /**
   * USED only: every use is Apex DML written `as system` / `AccessLevel.SYSTEM_MODE`,
   * which does not check the running user's object permissions — the grant is
   * not what makes these writes work.
   */
  readonly systemModeOnly?: true;
}

/** One object the persona can create, edit or delete. */
export interface GrantRow {
  readonly object: string;
  readonly grantedBy: readonly string[];
  readonly ops: Readonly<Partial<Record<GrantOp, OpVerdict>>>;
  readonly modifyAllRecords: boolean;
  readonly fieldEdits: {
    readonly editable: number;
    readonly written: number;
    readonly status: 'USED' | 'UNUSED' | 'UNKNOWN' | 'NOT_CHECKED';
    readonly notWritten: readonly string[];
    readonly notWrittenCount: number;
  };
}

/** Response payload. */
export interface PersonaUnusedGrantsOutput {
  readonly appliedScope: ResolvedPersona;
  readonly refreshedAt: string;
  readonly summary: Readonly<Record<string, number>>;
  /** Objects on this page, sorted by name. */
  readonly objects: readonly GrantRow[];
  /** Findings for the objects on this page. */
  readonly findings: readonly OmniFinding[];
  readonly pageInfo: PageInfo;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'Reachable automation: every ACTIVE OmniScript, Integration Procedure and FlexCard (inside the OmniStudio appScope when configured) and what it dispatches; Apex entered from them, from Lightning components the persona has Apex access to, and from granted classes with @AuraEnabled / @InvocableMethod / REST methods, plus everything that Apex calls; the triggers and record-triggered flows on the objects written. Pages the persona can open are NOT narrowed further: a use anywhere in the active app counts, so UNUSED never depends on page-level routing.',
  'A write counts as a use whatever its access mode: a reachable logger inserting records `as system` is a real use, reported with its access level as evidence.',
  'Apex attribution is `inferred`: by the DML operand\'s declared type first, the enclosing method naming the object otherwise. A generic writer (it writes whatever SObject it is handed) is attributed to the literal object names OmniStudio passes it when every reachable caller does so; otherwise it is open, and grants on objects that reachable code names become UNKNOWN — never UNUSED.',
  'Lightning components that reference an object directly, and active flows not reached through the persona\'s automation, make that object\'s grants UNKNOWN: either may be how the persona uses them.',
  'Which users hold the persona\'s containers is not in the vault.',
]);

/** The line of `<object>X</object>` in a permission set / profile file, for the citation. */
const grantLine = async (ctx: Context, containerId: string, object: string): Promise<{ sourcePath: string; line: number | null }> => {
  const node = await getNodeById(ctx.graph, containerId as ComponentId);
  const sourcePath = node.ok && node.value !== null ? node.value.sourcePath ?? '' : '';
  if (sourcePath.length === 0) return { sourcePath, line: null };
  try {
    const text = await readFile(resolveVaultSourcePath(ctx.vaultRoot, sourcePath), 'utf-8');
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.includes(`<object>${object}</object>`));
    return { sourcePath, line: idx === -1 ? null : idx + 1 };
  } catch {
    return { sourcePath, line: null };
  }
};

const verdictFor = (usage: PersonaUsage, object: string, op: GrantOp): OpVerdict => {
  const key = object.toLowerCase();
  const evidence = usage.uses.get(`${key}|${op}`) ?? [];
  if (evidence.length > 0) {
    const systemModeOnly = evidence.every((e) => e.accessLevel === 'system');
    return { status: 'USED', evidence: evidence.slice(0, 1), evidenceCount: evidence.length, ...(systemModeOnly ? { systemModeOnly: true as const } : {}) };
  }
  const reasons: string[] = [];
  const generic = usage.openGeneric.get(op) ?? [];
  if (generic.length > 0 && usage.mentioned.has(key)) {
    reasons.push(`generic Apex writer(s) the persona reaches (${generic.slice(0, 3).join(', ')}${generic.length > 3 ? ', …' : ''}) take their object at runtime, and reachable code names ${object}`);
  }
  const ui = usage.uiReferences.get(key) ?? [];
  if (ui.length > 0) reasons.push(`Lightning component(s) reference ${object} directly (${ui.slice(0, 3).join(', ')}${ui.length > 3 ? ', …' : ''}) — a record form or the UI API can write it`);
  const flows = usage.otherFlowWriters.get(key) ?? [];
  if (flows.length > 0) reasons.push(`active flow(s) write ${object} (${flows.slice(0, 3).join(', ')}${flows.length > 3 ? ', …' : ''}); whether this persona runs them is not resolved`);
  if (reasons.length > 0) return { status: 'UNKNOWN', evidence: [], evidenceCount: 0, unknownReasons: reasons.map((r) => (r.length > 220 ? `${r.slice(0, 219)}…` : r)) };
  return { status: 'UNUSED', evidence: [], evidenceCount: 0 };
};

/** The `sfi.persona_unused_grants` handler. */
export const personaUnusedGrantsHandler = async (
  ctx: Context,
  input: PersonaUnusedGrantsInput,
): Promise<Result<McpResponse<PersonaUnusedGrantsOutput>, McpError>> => {
  if (input.persona === undefined && input.profile === undefined && (input.permissionSets ?? []).length === 0 && (input.permissionSetGroups ?? []).length === 0) {
    return err({ kind: 'invalid-query', message: 'name the persona — `persona` (org-kb/config/personas.json), or `profile` / `permissionSets` / `permissionSetGroups` inline', path: 'persona' });
  }
  const persona = await resolvePersona(ctx, input);
  if (!persona.ok) return err({ kind: 'invalid-query', message: persona.message, path: 'persona' });
  const grantsR = await computeEffectiveGrants(ctx, persona.value.containers);
  if (!grantsR.ok) return grantsR;
  const grants = grantsR.value;
  const usageR = await computePersonaUsage(ctx, grants);
  if (!usageR.ok) return usageR;
  const usage = usageR.value;

  const rows: GrantRow[] = [];
  const findings: OmniFinding[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string): void => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  const wanted = input.codes === undefined ? null : new Set<string>(input.codes);
  const objects = [...grants.objectMap.entries()]
    .filter(([, a]) => a.flags.allowCreate || a.flags.allowEdit || a.flags.allowDelete)
    .sort((a, b) => a[0].localeCompare(b[0]));
  for (const [object, accum] of objects) {
    const grantedBy = [...accum.grantedBy].sort();
    const ops: Partial<Record<GrantOp, OpVerdict>> = {};
    for (const op of OPS) {
      if (accum.flags[FLAG_OF[op]] !== true) continue;
      const v = verdictFor(usage, object, op);
      ops[op] = v;
      bump(`${op}:${v.status}`);
    }
    // Field edit grants on the object.
    const prefix = `${object.toLowerCase()}.`;
    const editable = [...grants.fieldMap.entries()].filter(([f, v]) => v.editable && f.toLowerCase().startsWith(prefix)).map(([f]) => f).sort();
    const written = editable.filter((f) => usage.fieldWrites.has(f.toLowerCase()));
    const notWritten = editable.filter((f) => !usage.fieldWrites.has(f.toLowerCase()));
    const objectWriteUsed = ops.create?.status === 'USED' || ops.edit?.status === 'USED';
    const opaque = usage.fieldOpaqueWriters.get(object.toLowerCase()) ?? [];
    const fieldStatus: GrantRow['fieldEdits']['status'] =
      editable.length === 0 || !objectWriteUsed ? 'NOT_CHECKED' : notWritten.length === 0 ? 'USED' : opaque.length > 0 ? 'UNKNOWN' : 'UNUSED';
    rows.push({
      object,
      grantedBy,
      ops,
      modifyAllRecords: accum.flags.modifyAllRecords === true,
      fieldEdits: { editable: editable.length, written: written.length, status: fieldStatus, notWritten: notWritten.slice(0, 25), notWrittenCount: notWritten.length },
    });
  }
  const page = (() => {
    const fingerprint = argsFingerprint({ containers: persona.value.containers, codes: input.codes ?? null });
    let offset = 0;
    if (input.cursor !== undefined) {
      const decoded = decodeCursor(input.cursor, { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint });
      if (!decoded.ok) return decoded;
      offset = decoded.value.o;
    }
    return ok(
      paginate(rows, {
        offset,
        limit: input.limit ?? 100,
        byteBudget: 14_000,
        binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
        keyOf: (r) => r.object,
      }),
    );
  })();
  if (!page.ok) return page;

  // Findings for the objects on this page (counts stay whole-set in `summary`).
  for (const row of page.value.items) {
    const grantor = row.grantedBy[0] ?? persona.value.containers[0] ?? '';
    const cite = await grantLine(ctx, grantor, row.object);
    for (const op of OPS) {
      const v = row.ops[op];
      if (v === undefined) continue;
      if (v.status === 'USED') {
        if (v.systemModeOnly !== true || (wanted !== null && !wanted.has('USED_ONLY_IN_SYSTEM_MODE'))) continue;
        const ev = v.evidence[0];
        findings.push({
          code: 'USED_ONLY_IN_SYSTEM_MODE',
          verdict: 'unknown',
          componentId: grantor,
          sourcePath: cite.sourcePath,
          elementPath: `objectPermissions/${row.object}`,
          line: cite.line,
          message: `The persona's ${op} grant on ${row.object} is used only by Apex written to run in system mode (${ev?.detail ?? ev?.componentId ?? '?'}${v.evidenceCount > 1 ? ` and ${v.evidenceCount - 1} more` : ''}); system-mode DML does not check the user's object permissions, so the grant is not what makes these writes work`,
          confidence: 'inferred',
          unknownReason: 'removing the grant is safe for these writes, but a path this analysis does not see could still need it',
          evidence: { object: row.object, op, grantedBy: row.grantedBy, uses: v.evidenceCount },
          citations: [
            { componentId: grantor, sourcePath: cite.sourcePath, ...(cite.line === null ? {} : { line: cite.line }) },
            ...(ev === undefined ? [] : [{ componentId: ev.componentId, sourcePath: '' }]),
          ],
        });
        continue;
      }
      const code = CODE_OF[op];
      if (wanted !== null && !wanted.has(code)) continue;
      findings.push({
        code,
        verdict: v.status === 'UNUSED' ? 'defect' : 'unknown',
        componentId: grantor,
        sourcePath: cite.sourcePath,
        elementPath: `objectPermissions/${row.object}`,
        line: cite.line,
        message:
          v.status === 'UNUSED'
            ? `The persona can ${op} ${row.object} records (granted by ${row.grantedBy.join(', ')}), but nothing it can run ${op === 'create' ? 'creates' : op === 'edit' ? 'edits' : 'deletes'} them`
            : `The persona can ${op} ${row.object} records (granted by ${row.grantedBy.join(', ')}); no analysed path ${op === 'create' ? 'creates' : op === 'edit' ? 'edits' : 'deletes'} them, but something unanalysed could`,
        confidence: 'inferred',
        ...(v.status === 'UNKNOWN' ? { unknownReason: (v.unknownReasons ?? []).join('; ') } : {}),
        evidence: { object: row.object, op, grantedBy: row.grantedBy, modifyAllRecords: row.modifyAllRecords, openGenericWriters: (usage.openGeneric.get(op) ?? []).slice(0, 3) },
        citations: [{ componentId: grantor, sourcePath: cite.sourcePath, ...(cite.line === null ? {} : { line: cite.line }) }],
      });
    }
    if ((row.fieldEdits.status === 'UNUSED' || row.fieldEdits.status === 'UNKNOWN') && (wanted === null || wanted.has('UNUSED_FIELD_EDIT'))) {
      findings.push({
        code: 'UNUSED_FIELD_EDIT',
        verdict: row.fieldEdits.status === 'UNUSED' ? 'defect' : 'unknown',
        componentId: grantor,
        sourcePath: cite.sourcePath,
        elementPath: `fieldPermissions/${row.object}`,
        line: null,
        message: `${row.fieldEdits.notWrittenCount} of ${row.fieldEdits.editable} editable ${row.object} field(s) are written by nothing the persona can run`,
        confidence: 'inferred',
        ...(row.fieldEdits.status === 'UNKNOWN'
          ? { unknownReason: `writers whose field set is not visible also write ${row.object}: ${(usage.fieldOpaqueWriters.get(row.object.toLowerCase()) ?? []).slice(0, 5).join(', ')}` }
          : {}),
        evidence: { object: row.object, notWrittenSample: row.fieldEdits.notWritten.slice(0, 10), notWrittenCount: row.fieldEdits.notWrittenCount },
        citations: [{ componentId: grantor, sourcePath: cite.sourcePath }],
      });
    }
  }
  findings.sort(compareFindings);

  const summary: Record<string, number> = {
    objectsGranted: rows.length,
    reachableOmniStudio: usage.reachableOmniStudio,
    entryApex: usage.entryApex.length,
    reachableApex: usage.reachableApex.size,
    ...counts,
    fieldEditUnused: rows.filter((r) => r.fieldEdits.status === 'UNUSED').length,
    fieldEditUnknown: rows.filter((r) => r.fieldEdits.status === 'UNKNOWN').length,
  };
  const limitations = [...usage.limitations, ...(persona.value.unresolved.length > 0 ? [`Not found in the vault and ignored: ${persona.value.unresolved.join(', ')}`] : [])];
  return ok({
    data: {
      appliedScope: persona.value,
      refreshedAt: ctx.manifest.refreshedAt,
      summary,
      objects: page.value.items,
      findings,
      pageInfo: page.value.pageInfo,
      boundaries: BOUNDARIES,
      trust: {
        provenance: 'offline_snapshot',
        confidence: 'heuristic',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: limitations.length === 0 ? { status: 'complete' } : { status: 'partial', missingCoverage: limitations },
        limitations,
      },
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
