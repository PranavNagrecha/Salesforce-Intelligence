import { omnistudio } from '@sf-intelligence/extractors';

import { matchesCallSite } from './config.js';
import type { IpModel, IpStep } from './ip-model.js';
import { modelIpResponse } from './responses.js';
import type { ScriptModel } from './script-model.js';
import type { OmniCitation, OmniConfidence, OmniFinding } from './types.js';
import type { OmniWorld } from './world.js';

/**
 * Completion audit (spec F4) — does "Complete" mean "saved"?
 *
 *   - COMPLETE_WITHOUT_SUCCESS   — the step that marks a section / step Complete
 *                                  runs with a condition that does not depend on
 *                                  the preceding write steps' output, while at
 *                                  least one of those writes swallows its failure
 *                                  (`failOnStepError: false`). A failed save
 *                                  still shows Complete.
 *   - SUCCESS_FLAG_NEVER_READ    — the IP returns a success / status / error key
 *                                  that no element of a calling script reads (a
 *                                  whitespace-broken read counts as not read), so
 *                                  the screen moves on even when the save failed.
 *   - ONLY_FIRST_RESULT_CHECKED  — a reader inspects only row 0 of a write
 *                                  step's result (`|0` / `[0]`): the other rows'
 *                                  outcome is never checked. `unknown` — the Apex
 *                                  result shape is not analysed.
 *
 * Completion markers come from `org-kb/config/omnistudio.json`
 * (`completionMarkers`); without it, a Remote Action whose method name reads
 * like a status update (`update…Status`, `markComplete`, …) is a heuristic
 * marker (`inferred`).
 */

const HEURISTIC_MARKER = /^(update\w*status|mark\w*complete|complete\w*(step|section)|set\w*status)$/i;
/** A returned key that reads like a success indicator: success / status / error / fail, or a `…Flag`. */
const SUCCESS_KEY = /(success|status|error|fail)|flag$/i;

const stepCite = (ip: IpModel, s: IpStep): OmniCitation => ({
  componentId: ip.componentId,
  sourcePath: ip.sourcePath,
  elementPath: s.el.idPath,
  ...(s.el.line === null ? {} : { line: s.el.line }),
});

/** Is this step a completion marker, and how certain is that? */
const markerKind = (world: OmniWorld, s: IpStep): OmniConfidence | null => {
  const markers = world.config.completionMarkers;
  if (s.role === 'remote') {
    if (markers.some((m) => 'remoteClass' in m && matchesCallSite([m], s.remoteClass, s.remoteMethod))) return 'parsed';
    if (s.remoteMethod !== null && HEURISTIC_MARKER.test(s.remoteMethod.trim())) return 'inferred';
  }
  if (s.role === 'nestedIp' && s.nestedIpKey !== null) {
    if (markers.some((m) => 'integrationProcedureKey' in m && m.integrationProcedureKey.trim() === s.nestedIpKey)) return 'parsed';
  }
  return null;
};

/** Does this step write records (a Load mapper, a generic upsert, a Delete)? */
const isWriteStep = (world: OmniWorld, s: IpStep, loadMappers: ReadonlySet<string>): boolean => {
  if (s.role === 'delete') return true;
  if (s.role === 'dataMapper' && s.bundle !== null) return loadMappers.has(s.bundle);
  if (s.role === 'remote') {
    if (world.config.genericUpsertAdapters.some((a) => matchesCallSite([a], s.remoteClass, s.remoteMethod))) return true;
    const records = s.additional.some((e) => /^records?$/i.test(e.key.trim()) && e.kind === 'move');
    const object = s.additional.some((e) => /object(ApiName|Name|Type)/i.test(e.key.trim()) && e.kind === 'literal');
    return records && object;
  }
  return false;
};

/** Audit one IP; `callers` are the active scripts that call it (for SUCCESS_FLAG_NEVER_READ). */
export const auditCompletion = async (
  world: OmniWorld,
  ip: IpModel,
  callers: readonly ScriptModel[],
): Promise<OmniFinding[]> => {
  const findings: OmniFinding[] = [];
  const loadMappers = new Set<string>();
  for (const s of ip.steps) {
    if (s.role !== 'dataMapper' || s.bundle === null) continue;
    const r = world.resolveBundle(s.bundle);
    if (r.node === null) continue;
    const loaded = await world.loadMapper(r.node);
    if (loaded.ok && loaded.value.doc.header.kind === 'Load') loadMappers.add(s.bundle);
  }

  // --- COMPLETE_WITHOUT_SUCCESS ------------------------------------------------
  for (const m of ip.steps) {
    const kind = markerKind(world, m);
    if (kind === null) continue;
    const writes = ip.steps.filter((w) => w.order < m.order && isWriteStep(world, w, loadMappers));
    if (writes.length === 0) continue;
    const reads = new Set<string>();
    for (const c of m.conditions) for (const r of omnistudio.scanPercentRefs(c.formula).refs) reads.add(omnistudio.segmentNames(r.path)[0] ?? '');
    for (const e of m.additional) for (const r of e.refs) reads.add(omnistudio.segmentNames(r.path)[0] ?? '');
    const dependsOnWrite = writes.some((w) => reads.has(w.outputRoot[0] ?? w.el.name));
    const silent = writes.filter((w) => w.failOnStepError === false);
    if (dependsOnWrite || silent.length === 0) continue;
    findings.push({
      code: 'COMPLETE_WITHOUT_SUCCESS',
      verdict: 'defect',
      componentId: ip.componentId,
      sourcePath: ip.sourcePath,
      elementPath: m.el.idPath,
      line: m.el.line,
      message: `${m.el.idPath} (${m.remoteClass ?? m.nestedIpKey ?? '?'}${m.remoteMethod === null ? '' : `.${m.remoteMethod}`}) marks completion ${m.conditions.length === 0 ? 'unconditionally' : `when ${m.conditions.map((c) => c.formula).join(' AND ')}`}, independent of ${writes.length} preceding write step(s), ${silent.length} of which swallow failures (failOnStepError: false): a failed save still shows Complete`,
      confidence: kind,
      evidence: {
        marker: m.el.idPath,
        markerRecognizedBy: kind === 'parsed' ? 'configured completionMarkers' : 'heuristic method name',
        markerConditions: m.conditions.map((c) => c.formula),
        writes: writes.map((w) => ({ step: w.el.idPath, failOnStepError: w.failOnStepError, conditions: w.conditions.map((c) => c.formula) })),
      },
      citations: [stepCite(ip, m), ...silent.map((w) => stepCite(ip, w))],
    });
  }

  // --- SUCCESS_FLAG_NEVER_READ ---------------------------------------------------
  const response = await modelIpResponse(world, ip);
  const flags = response.keys.filter((k) => SUCCESS_KEY.test(k.path.at(-1) ?? ''));
  for (const caller of callers) {
    for (const a of caller.actions) {
      if (a.ipKey === null || world.resolveIpKey(a.ipKey).node?.id !== ip.componentId) continue;
      for (const flag of flags) {
        const merged = [...(a.responseNode ?? []), ...flag.path];
        const read = caller.elements.some((e) => {
          const cfg = e.el.config;
          if (cfg === null) return false;
          const fields = omnistudio.ruleConditions(omnistudio.parseShowRule(cfg['show'])).map((c) => c.field);
          const merges = omnistudio.stringSites(cfg).flatMap((x) => omnistudio.scanPercentRefs(x.value).refs.map((r) => r.raw));
          return [...fields, ...merges].some((raw) => {
            const n = omnistudio.segmentNames(omnistudio.parseKeyPath(raw));
            return n.length > 0 && (n.join(':') === merged.join(':') || omnistudio.isSuffixOf(n, merged));
          });
        });
        if (read) continue;
        const brokenReads = caller.elements.filter((e) =>
          omnistudio.ruleConditions(omnistudio.parseShowRule(e.el.config?.['show'])).some(
            (c) => c.field !== c.field.trim() && c.field.trim().split(':').at(-1) === flag.path.at(-1),
          ),
        );
        findings.push({
          code: 'SUCCESS_FLAG_NEVER_READ',
          verdict: 'defect',
          componentId: caller.componentId,
          sourcePath: caller.sourcePath,
          elementPath: a.element.el.idPath,
          line: a.element.el.line,
          message: `${ip.componentId} returns '${flag.path.join(':')}' (merged at ${merged.join(':')}) to ${a.element.el.idPath}, but nothing in ${caller.componentId} reads it${brokenReads.length > 0 ? ` — ${brokenReads.length} read(s) are broken by a stray space` : ''}: the screen continues even when the call failed`,
          confidence: 'inferred',
          evidence: {
            returnedKey: flag.path.join(':'),
            mergedAt: merged.join(':'),
            returnedBy: flag.source,
            brokenReads: brokenReads.map((e) => e.el.idPath),
            classification: 'a returned key whose name reads like a success / status / error flag',
          },
          citations: [
            { componentId: caller.componentId, sourcePath: caller.sourcePath, elementPath: a.element.el.idPath, ...(a.element.el.line === null ? {} : { line: a.element.el.line }) },
            { componentId: ip.componentId, sourcePath: ip.sourcePath },
          ],
        });
      }
    }
  }

  // --- ONLY_FIRST_RESULT_CHECKED ---------------------------------------------------
  const writeRoots = new Set(ip.steps.filter((s) => isWriteStep(world, s, loadMappers)).map((s) => s.outputRoot[0] ?? s.el.name));
  for (const s of ip.steps) {
    for (const site of omnistudio.stringSites(s.el.config ?? {})) {
      for (const ref of omnistudio.scanPercentRefs(site.value).refs) {
        const segs = ref.path.segments;
        if (!writeRoots.has(segs[0]?.name ?? '')) continue;
        if (!segs.some((x) => x.row === 0)) continue;
        findings.push({
          code: 'ONLY_FIRST_RESULT_CHECKED',
          verdict: 'unknown',
          componentId: ip.componentId,
          sourcePath: ip.sourcePath,
          elementPath: s.el.idPath,
          line: s.el.line,
          message: `${s.el.idPath} reads only row 0 of write step ${segs[0]?.name ?? '?'}'s result (${ref.raw}) at ${site.prop}; the outcome of the other rows is never checked`,
          confidence: 'inferred',
          unknownReason: 'the shape of the write step\'s result (one entry per row?) comes from Apex, which is not analysed',
          evidence: { reference: ref.raw, via: site.prop },
          citations: [stepCite(ip, s)],
        });
      }
    }
  }
  return findings;
};
