import { omnistudio } from '@sf-intelligence/extractors';

import { buildIpModel } from './ip-model.js';
import type { ScriptAction, ScriptElement, ScriptModel } from './script-model.js';
import { SaveTracer } from './trace.js';
import { type OmniCitation, type OmniConfidence, type OmniFinding, omniElementId } from './types.js';
import type { OmniWorld } from './world.js';

/**
 * Edit Block audit (spec F4). An Edit Block lists saved rows as cards with
 * Add / Edit / Delete. `allowDelete: true` only SHOWS the Delete button; the
 * server delete is wired one of two ways (and this org uses both):
 *   (a) the block's `deleteIPKey` (+ `deleteIPExtraPayload`, e.g. `sObjectId: %Id%`);
 *   (b) a child Integration Procedure Action named `<EditBlockName>-Delete`.
 * Which one the runtime uses when both are present is not established from
 * metadata — both are recorded.
 *
 * Findings:
 *   - SCREEN_ONLY_DELETE        — Delete shown, no server delete wired: the card
 *                                 disappears, the record stays, prefill brings it back.
 *   - DELETE_KEY_NO_PAYLOAD     — `deleteIPKey` with no `deleteIPExtraPayload`:
 *                                 the delete IP receives no record id.
 *   - DELETE_TARGET_NOT_IN_VAULT — a delete IP the vault does not contain (not
 *                                 retrieved, or missing from the org) — `unknown`.
 *   - EDIT_INSERTS_DUPLICATE    — the card's save path never carries the row's
 *                                 record Id into a write, so editing a card inserts
 *                                 a new record and leaves the old one behind.
 */

/** One delete mechanism of an Edit Block. */
export interface DeleteMechanism {
  readonly mechanism: 'deleteIPKey' | 'deleteChildAction';
  readonly via: string;
  readonly ipKey: string;
  readonly targetId: string | null;
  readonly targetResolution: string;
  readonly payload: unknown;
  /** Where the deleted record's id comes from. */
  readonly idSource: {
    readonly status: 'parsed' | 'unknown';
    readonly expression?: string;
    readonly producedBy?: readonly string[];
    readonly reason?: string;
  };
}

/** One Edit Block's audit row. */
export interface EditBlockRow {
  readonly element: string;
  readonly elementPath: string;
  readonly line: number | null;
  readonly allowNew: boolean | null;
  readonly allowEdit: boolean | null;
  readonly allowDelete: boolean | null;
  readonly deleteMechanisms: readonly DeleteMechanism[];
  /** Does a save path carry the row's record Id into a write? null = no save path traced. */
  readonly recordIdentity: {
    readonly carried: boolean | null;
    readonly idWrites: readonly string[];
    readonly fieldsWritten: number;
    readonly idElements: readonly string[];
    /** Objects the card's save path writes — the rows' object, which a delete removes (`inferred`). */
    readonly objectsWritten: readonly string[];
  };
}

const bool = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

const cite = (script: ScriptModel, e: ScriptElement): OmniCitation => ({
  componentId: script.componentId,
  sourcePath: script.sourcePath,
  elementPath: e.el.idPath,
  ...(e.el.line === null ? {} : { line: e.el.line }),
});

/** Where a delete IP gets the record id, when the IP shows it. */
const deleteIdFromIp = async (world: OmniWorld, targetId: string | null): Promise<DeleteMechanism['idSource']> => {
  if (targetId === null) return { status: 'unknown', reason: 'the delete Integration Procedure is not in the vault' };
  const node = world.nodeById(targetId);
  if (node === null) return { status: 'unknown', reason: 'the delete Integration Procedure is not in the vault' };
  const loaded = await world.loadProcess(node);
  if (!loaded.ok) return { status: 'unknown', reason: `${targetId} is unreadable` };
  const ip = buildIpModel(loaded.value);
  const deletes = ip.steps.filter((s) => s.role === 'delete');
  if (deletes.length > 0) {
    const d = deletes[0] as (typeof deletes)[number];
    const refs = omnistudio.stringSites(d.el.config ?? {}).flatMap((x) => omnistudio.scanPercentRefs(x.value).refs.map((r) => r.raw));
    return { status: 'parsed', expression: refs.join(', '), producedBy: [`Delete Action ${ip.uniqueName}#${d.el.idPath}`] };
  }
  const remotes = ip.steps.filter((s) => s.role === 'remote' && !matchesLogger(world, s.remoteClass, s.remoteMethod));
  if (remotes.length > 0) {
    return {
      status: 'unknown',
      reason: `Apex ${remotes.map((r) => `${r.remoteClass ?? '?'}.${r.remoteMethod ?? '?'}`).join(', ')} decides what to delete from the payload (not analysed)`,
    };
  }
  return { status: 'unknown', reason: `${targetId} has no Delete Action or Remote Action step` };
};

const matchesLogger = (world: OmniWorld, c: string | null, m: string | null): boolean =>
  c !== null && m !== null && world.config.loggers.some((l) => l.remoteClass.trim() === c.trim() && l.remoteMethod.trim() === m.trim());

/** Audit every Edit Block of the script. */
export const auditEditBlocks = async (
  world: OmniWorld,
  script: ScriptModel,
): Promise<{ readonly rows: readonly EditBlockRow[]; readonly findings: readonly OmniFinding[] }> => {
  const rows: EditBlockRow[] = [];
  const findings: OmniFinding[] = [];
  const tracer = new SaveTracer(world, script);
  const blocks = script.elements.filter((e) => e.el.canonicalType === 'Edit Block');
  for (const eb of blocks) {
    const cfg = eb.el.config ?? {};
    const allowNew = bool(cfg['allowNew']);
    const allowEdit = bool(cfg['allowEdit']);
    const allowDelete = bool(cfg['allowDelete']);
    const mechanisms: DeleteMechanism[] = [];
    const deleteActions: ScriptAction[] = script.actions.filter(
      (a) => (a.kind === 'editBlockDeleteKey' && a.element === eb) || (a.editBlockButton === 'Delete' && a.element.parent === eb),
    );
    for (const a of deleteActions) {
      const t = world.resolveIpKey(a.ipKey ?? '');
      if (a.kind === 'editBlockDeleteKey') {
        const payload = cfg['deleteIPExtraPayload'] ?? null;
        const idEntry = a.entries.find((e) => e.kind === 'move');
        let idSource: DeleteMechanism['idSource'];
        if (idEntry?.from != null) {
          const r = script.resolveRef(omnistudio.segmentNames(idEntry.from), eb);
          idSource = r.producers.length > 0
            ? { status: 'parsed', expression: String(idEntry.value), producedBy: [...new Set(r.producers.map((p) => (p.element === null ? `${p.kind}${p.via === undefined ? '' : ` of ${p.via}`}` : `${p.kind} ${p.element.el.idPath}`)))].sort() }
            : { status: 'unknown', expression: String(idEntry.value), reason: 'no element or modeled response produces it (it may come from a prefill the model does not see)' };
        } else {
          idSource = { status: 'unknown', reason: 'deleteIPExtraPayload carries no record id' };
        }
        mechanisms.push({ mechanism: 'deleteIPKey', via: eb.el.idPath, ipKey: a.ipKey ?? '', targetId: t.node?.id ?? null, targetResolution: t.resolution, payload, idSource });
      } else {
        mechanisms.push({
          mechanism: 'deleteChildAction',
          via: a.element.el.idPath,
          ipKey: a.ipKey ?? '',
          targetId: t.node?.id ?? null,
          targetResolution: t.resolution,
          payload: { sendsRow: a.base.kind === 'row', extraPayload: a.element.el.config?.['extraPayload'] ?? {} },
          idSource: await deleteIdFromIp(world, t.node?.id ?? null),
        });
      }
    }

    // --- record identity on save ---------------------------------------------
    const inside = script.elements.filter(
      (e) => e !== eb && e.editBlock === eb && (e.role === 'input' || e.role === 'formula'),
    );
    const idWrites = new Set<string>();
    const fields = new Set<string>();
    const idElements: string[] = [];
    let confidence: OmniConfidence = 'parsed';
    const keys: { element: ScriptElement; key: readonly string[] }[] = [
      ...inside.map((e) => ({ element: e, key: e.dataPath })),
      // The row's own record Id (prefill puts `Id` on each saved row).
      { element: eb, key: [...eb.dataPath, 'Id'] },
    ];
    for (const { element, key } of keys) {
      const outs = await tracer.traceElement(element, key);
      for (const o of outs) {
        if (o.kind !== 'write' || o.truth === 'false') continue;
        fields.add(`${o.object}.${o.field}`);
        if (o.field.toLowerCase() === 'id') {
          idWrites.add(`${key.slice(eb.dataPath.length).join(':')} → ${o.object}.Id`);
          if (element !== eb) idElements.push(element.el.idPath);
          if (o.confidence === 'inferred') confidence = 'inferred';
        }
      }
    }
    const carried = fields.size === 0 ? null : idWrites.size > 0;
    rows.push({
      element: omniElementId(script.uniqueName, eb.el.idPath),
      elementPath: eb.el.idPath,
      line: eb.el.line,
      allowNew,
      allowEdit,
      allowDelete,
      deleteMechanisms: mechanisms,
      recordIdentity: {
        carried,
        idWrites: [...idWrites].sort(),
        fieldsWritten: fields.size,
        idElements: [...new Set(idElements)].sort(),
        objectsWritten: [...new Set([...fields].map((f) => f.slice(0, f.indexOf('.'))))].sort(),
      },
    });

    // --- findings ------------------------------------------------------------
    if (allowDelete === true && mechanisms.length === 0) {
      findings.push({
        code: 'SCREEN_ONLY_DELETE',
        verdict: 'defect',
        componentId: script.componentId,
        sourcePath: script.sourcePath,
        elementPath: eb.el.idPath,
        line: eb.el.line,
        message: `${eb.el.idPath} shows Delete but wires no server delete (no deleteIPKey, no ${eb.el.name}-Delete action): the card disappears, the record stays, and the next prefill brings it back`,
        confidence: 'parsed',
        evidence: { allowDelete, deleteIPKey: null, deleteChildAction: null },
        citations: [cite(script, eb)],
      });
    }
    for (const m of mechanisms) {
      if (m.mechanism === 'deleteIPKey' && (cfg['deleteIPExtraPayload'] === undefined || cfg['deleteIPExtraPayload'] === null || (typeof cfg['deleteIPExtraPayload'] === 'object' && Object.keys(cfg['deleteIPExtraPayload'] as object).length === 0))) {
        findings.push({
          code: 'DELETE_KEY_NO_PAYLOAD',
          verdict: 'defect',
          componentId: script.componentId,
          sourcePath: script.sourcePath,
          elementPath: eb.el.idPath,
          line: eb.el.line,
          message: `${eb.el.idPath} names deleteIPKey ${m.ipKey} but no deleteIPExtraPayload: the delete Integration Procedure is sent no record id`,
          confidence: 'parsed',
          evidence: { deleteIPKey: m.ipKey },
          citations: [cite(script, eb)],
        });
      }
      if (m.targetId === null) {
        findings.push({
          code: 'DELETE_TARGET_NOT_IN_VAULT',
          verdict: 'unknown',
          componentId: script.componentId,
          sourcePath: script.sourcePath,
          elementPath: eb.el.idPath,
          line: eb.el.line,
          message: `${eb.el.idPath} deletes through ${m.mechanism === 'deleteIPKey' ? 'deleteIPKey' : `${m.via}`} → Integration Procedure ${m.ipKey}, which is not in the vault`,
          confidence: 'inferred',
          unknownReason: 'the IP was not retrieved, or does not exist in the org — if it does not exist, this delete fails at runtime',
          evidence: { mechanism: m.mechanism, ipKey: m.ipKey, otherMechanisms: mechanisms.filter((x) => x !== m).map((x) => `${x.mechanism} → ${x.ipKey}${x.targetId === null ? ' (not in vault)' : ''}`) },
          citations: [cite(script, eb)],
        });
      }
    }
    if (allowEdit !== false && carried === false) {
      findings.push({
        code: 'EDIT_INSERTS_DUPLICATE',
        verdict: 'defect',
        componentId: script.componentId,
        sourcePath: script.sourcePath,
        elementPath: eb.el.idPath,
        line: eb.el.line,
        message: `${eb.el.idPath} saves ${fields.size} field(s) but no save path carries the card's record Id into the write: editing a card inserts a new record and leaves the old one behind`,
        confidence,
        evidence: {
          fieldsWritten: [...fields].sort(),
          idCandidates: inside.filter((e) => /RecId$|(^|[^a-z])Id$/.test(e.el.name)).map((e) => e.el.idPath),
        },
        citations: [cite(script, eb)],
      });
    }
  }
  return { rows, findings };
};
