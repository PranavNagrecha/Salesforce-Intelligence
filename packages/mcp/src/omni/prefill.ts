import { omnistudio } from '@sf-intelligence/extractors';

import type { IpModel } from './ip-model.js';
import { buildMapperModel } from './mapper-model.js';
import { modelIpResponse } from './responses.js';
import type { SaveTraceRow } from './save-report.js';
import type { ScriptAction, ScriptModel } from './script-model.js';
import { branchTruth, type Fact, SaveTracer } from './trace.js';
import type { OmniCitation, OmniConfidence, OmniFinding } from './types.js';
import type { OmniWorld } from './world.js';

/**
 * Prefill trace (spec F2): for every answer the save trace shows reaching a
 * field, does a prefill bring that field BACK to the same screen key?
 *
 * A prefill is an Integration Procedure (or a DataRaptor Extract action) whose
 * response merges into the screen's data JSON. Values are followed FORWARD
 * from each Extract item (which reads `Object.Field` into a JSON path), through
 * the IP's Transforms / Set Values / list merges, to the Response Action —
 * then re-rooted at the calling action's `responseJSONNode` / `responseJSONPath`.
 *
 *   - PREFILLED        — the saved field returns at exactly the element's key;
 *   - NEVER_PREFILLED  — it returns at a DIFFERENT key (the screen shows the
 *                        answer empty, and the next save may overwrite it), or
 *                        no modeled prefill returns it at all;
 *   - UNKNOWN          — a prefill response the model cannot see into (Apex,
 *                        a full-data-JSON return) could carry it.
 */

/** Prefill row status. */
export type PrefillStatus = 'PREFILLED' | 'NEVER_PREFILLED' | 'UNKNOWN';

/** One place a saved field comes back. */
export interface ReturnedField {
  readonly field: string;
  /** Where it lands in the screen's data JSON. */
  readonly screenKey: string;
  readonly action: string;
  readonly ip: string | null;
  readonly conditional: boolean;
  /** `inferred` when the value comes from a recognized-but-unconfigured fetch (its field set is not analysed). */
  readonly confidence: OmniConfidence;
}

/** One prefill row. */
export interface PrefillRow {
  readonly element: string;
  readonly elementPath: string;
  readonly producedKey: string;
  readonly savedTo: readonly string[];
  readonly status: PrefillStatus;
  readonly prefilledBy?: readonly ReturnedField[];
  readonly returnedElsewhere?: readonly ReturnedField[];
  readonly unknownReason?: string;
  readonly citations: readonly OmniCitation[];
  readonly confidence: OmniConfidence;
}

const lower = (s: string): string => s.toLowerCase();

/**
 * Seed facts for a "generic fetch" — a Remote Action that returns records keyed
 * by object (`<step>:records:<Object>` rows of field API names). Declared in
 * config (`genericFetchAdapters`, `parsed`), or recognized because later steps
 * read `<step>:<recordsNode>:<Object>` for a vaulted object (`inferred`). Every
 * vaulted field of that object is seeded; the trace keeps only those the IP
 * actually maps.
 */
const fetchSeeds = async (world: OmniWorld, ip: IpModel): Promise<Fact[]> => {
  const out: Fact[] = [];
  for (const step of ip.steps) {
    if (step.role !== 'remote') continue;
    const configured = world.config.genericFetchAdapters.find(
      (a) => step.remoteClass !== null && step.remoteMethod !== null && a.remoteClass.trim() === step.remoteClass.trim() && a.remoteMethod.trim() === step.remoteMethod.trim(),
    );
    const root = step.outputRoot;
    const recordsNode = configured?.recordsNode ?? 'records';
    const objects = new Set<string>();
    for (const other of ip.steps) {
      if (other.order <= step.order) continue;
      for (const site of omnistudio.stringSites(other.el.config ?? {})) {
        for (const ref of omnistudio.scanPercentRefs(site.value).refs) {
          const n = omnistudio.segmentNames(ref.path);
          if (n.length >= root.length + 2 && omnistudio.isPrefixOf(root, n) && n[root.length] === recordsNode) objects.add(n[root.length + 1] as string);
        }
      }
    }
    for (const object of [...objects].sort()) {
      const fields = await world.fieldsOf(object);
      if (fields.length === 0) continue;
      for (const f of fields) {
        const path = [...root, recordsNode, object, f.apiName];
        out.push({
          path,
          trail: [path],
          createdAt: step.order,
          specific: true,
          derived: false,
          conditions: [],
          silent: [],
          hops: [`${step.remoteClass ?? '?'}.${step.remoteMethod ?? '?'} returns ${object} records (${configured !== undefined ? 'configured fetch adapter' : 'recognized from how later steps read its output'})`],
          citations: [{ componentId: ip.componentId, sourcePath: ip.sourcePath, elementPath: step.el.idPath, ...(step.el.line === null ? {} : { line: step.el.line }) }],
          confidence: configured !== undefined ? 'parsed' : 'inferred',
          origin: f.id,
        });
      }
    }
  }
  return out;
};

/** Seed one fact per Extract item that reads a field into JSON. */
const extractSeeds = async (world: OmniWorld, ip: IpModel): Promise<Fact[]> => {
  const out: Fact[] = [...(await fetchSeeds(world, ip))];
  for (const step of ip.steps) {
    if (step.role !== 'dataMapper' || step.bundle === null) continue;
    const r = world.resolveBundle(step.bundle);
    if (r.node === null) continue;
    const loaded = await world.loadMapper(r.node);
    if (!loaded.ok) continue;
    const mm = buildMapperModel(loaded.value);
    if (mm.kind !== 'Extract' && mm.kind !== 'Turbo Extract') continue;
    const turboObject = mm.items.find((i) => i.item.inputObjectName !== null)?.item.inputObjectName ?? null;
    for (const it of mm.items) {
      if (it.input === null || it.output === null || !it.jsonOutput || it.item.inputObjectName !== null && mm.kind === 'Extract') continue;
      let object: string | null = null;
      let fieldPath: readonly string[] = [];
      if (mm.kind === 'Extract') {
        object = mm.aliases.get(it.input[0] as string) ?? null;
        fieldPath = it.input.slice(1);
      } else {
        object = turboObject;
        fieldPath = it.input;
      }
      if (object === null || fieldPath.length !== 1) continue;
      const st = await world.fieldStatus(object, fieldPath[0] as string);
      const field = st.fieldId ?? `CustomField:${object}.${fieldPath[0] as string}`;
      let outPath = it.output;
      if (step.responsePath !== null) {
        if (!omnistudio.isPrefixOf(step.responsePath, outPath)) continue;
        outPath = outPath.slice(step.responsePath.length);
      }
      const path = [...step.outputRoot, ...outPath];
      out.push({
        path,
        trail: [path],
        createdAt: step.order,
        specific: true,
        derived: false,
        conditions: [],
        silent: [],
        hops: [`${mm.componentId} item ${it.item.index} reads ${field}`],
        citations: [{ componentId: mm.componentId, sourcePath: mm.sourcePath, elementPath: `item[${it.item.index}]`, ...(it.item.line === null ? {} : { line: it.item.line }) }],
        confidence: 'parsed',
        origin: field,
      });
    }
  }
  return out;
};

/** Every field value the script's calls bring back, and the calls whose response is not fully modeled. */
export const collectReturnedFields = async (
  world: OmniWorld,
  script: ScriptModel,
  tracer: SaveTracer,
): Promise<{ returned: ReturnedField[]; unmodeled: string[] }> => {
  const returned: ReturnedField[] = [];
  const unmodeled: string[] = [];
  const reroot = (a: ScriptAction, r: readonly string[]): readonly string[] | null => {
    let p = r;
    if (a.responsePath !== null) {
      if (!omnistudio.isPrefixOf(a.responsePath, p)) return null;
      p = p.slice(a.responsePath.length);
    }
    return [...(a.responseNode ?? []), ...p];
  };
  for (const a of script.actions) {
    if (a.kind === 'ipAction' && a.ipKey !== null) {
      const t = world.resolveIpKey(a.ipKey);
      if (t.node === null) continue;
      const ip = await tracer.ipModel(t.node.id);
      if (ip === null) continue;
      const resp = await modelIpResponse(world, ip);
      const seeds = await extractSeeds(world, ip);
      if (seeds.length === 0) {
        if (!resp.complete) unmodeled.push(`${a.element.el.idPath} → ${ip.componentId} (${resp.unmodeled.join('; ')})`);
        continue;
      }
      if (!resp.complete) unmodeled.push(`${a.element.el.idPath} → ${ip.componentId} (${resp.unmodeled.join('; ')})`);
      const constants = SaveTracer.constantsOf(a);
      for (const o of await tracer.traceIp(ip, seeds, 0, { collectResponses: true })) {
        if (o.kind !== 'returned' || o.origin === undefined) continue;
        // Conditions evaluated with the call's payload constants only.
        const truth = branchTruth(
          o.conditions
            .filter((c): c is Extract<typeof c, { kind: 'formula' }> => c.kind === 'formula')
            .map((c) => ({
              kind: 'formula' as const,
              source: c.source,
              text: c.formula,
              truth: omnistudio.evaluateFormula(c.formula, (raw) => {
                const k = omnistudio.segmentNames(omnistudio.parseKeyPath(raw)).join(':');
                return constants.has(k) ? { known: true, value: constants.get(k) } : { known: false };
              }).truth,
            })),
        );
        if (truth === 'false') continue;
        const key = reroot(a, o.responsePath);
        if (key === null) continue;
        returned.push({ field: o.origin, screenKey: key.join(':'), action: a.element.el.idPath, ip: ip.componentId, conditional: truth !== 'true', confidence: o.confidence });
      }
    } else if (a.kind === 'dataMapperAction' && a.bundle !== null) {
      const r = world.resolveBundle(a.bundle);
      if (r.node === null) continue;
      const loaded = await world.loadMapper(r.node);
      if (!loaded.ok) continue;
      const mm = buildMapperModel(loaded.value);
      if (mm.kind !== 'Extract') continue;
      for (const it of mm.items) {
        if (it.input === null || it.output === null || !it.jsonOutput || it.item.inputObjectName !== null) continue;
        const object = mm.aliases.get(it.input[0] as string);
        if (object === undefined || it.input.length !== 2) continue;
        const st = await world.fieldStatus(object, it.input[1] as string);
        const key = reroot(a, it.output);
        if (key === null) continue;
        returned.push({ field: st.fieldId ?? `CustomField:${object}.${it.input[1] as string}`, screenKey: key.join(':'), action: a.element.el.idPath, ip: null, conditional: a.visibility.length > 0, confidence: 'parsed' });
      }
    }
  }
  return { returned, unmodeled };
};

/** Build prefill rows for the saved answers of a script. */
export const buildPrefillTrace = async (
  world: OmniWorld,
  script: ScriptModel,
  saveRows: readonly SaveTraceRow[],
): Promise<{ rows: PrefillRow[]; findings: OmniFinding[]; unmodeled: string[]; returnedCount: number }> => {
  const tracer = new SaveTracer(world, script);
  const { returned, unmodeled } = await collectReturnedFields(world, script, tracer);
  const rows: PrefillRow[] = [];
  const findings: OmniFinding[] = [];
  const roleOf = new Map(script.elements.map((e) => [e.el.idPath, e.role] as const));
  const containerOf = (key: string): string => key.split(':').slice(0, -1).join(':');
  for (const s of saveRows) {
    if (s.status !== 'SAVED' && s.status !== 'SAVED_CONDITIONALLY') continue;
    // Only answers the user enters are prefilled; Formulas recompute.
    if (s.derivedVia !== undefined || roleOf.get(s.elementPath) !== 'input') continue;
    const fields = (s.savedTo ?? []).map((x) => x.field).filter((f) => !/\.Id$/i.test(f));
    if (fields.length === 0) continue;
    const container = containerOf(s.producedKey);
    const inContainer = returned.filter((r) => containerOf(r.screenKey) === container);
    const mineHere = inContainer.filter((r) => fields.some((f) => lower(f) === lower(r.field)));
    const exact = mineHere.filter((r) => r.screenKey === s.producedKey);
    const otherKey = mineHere.filter((r) => r.screenKey !== s.producedKey);
    let status: PrefillStatus;
    let unknownReason: string | undefined;
    let defect = false;
    let why = '';
    if (exact.length > 0) status = 'PREFILLED';
    else if (otherKey.length > 0) {
      status = 'NEVER_PREFILLED';
      defect = true;
      why = `the prefill returns ${fields.join(', ')} into this container as ${[...new Set(otherKey.map((r) => r.screenKey))].join(', ')} — never at the key this element displays`;
    } else if (inContainer.length > 0) {
      status = 'NEVER_PREFILLED';
      defect = true;
      why = `this container is prefilled (${inContainer.length} value(s)), but not with ${fields.join(', ')}`;
    } else if (unmodeled.length > 0) {
      status = 'UNKNOWN';
      unknownReason = `a prefill response is not fully modeled: ${unmodeled.slice(0, 3).join('; ')}${unmodeled.length > 3 ? ` (+${unmodeled.length - 3} more)` : ''}`;
    } else status = 'NEVER_PREFILLED';
    const row: PrefillRow = {
      element: s.element,
      elementPath: s.elementPath,
      producedKey: s.producedKey,
      savedTo: fields,
      status,
      ...(exact.length > 0 ? { prefilledBy: exact } : {}),
      ...(otherKey.length > 0 ? { returnedElsewhere: otherKey } : {}),
      ...(unknownReason === undefined ? {} : { unknownReason }),
      citations: s.citations.slice(0, 1),
      confidence: status === 'UNKNOWN' || exact.some((r) => r.confidence === 'inferred') ? 'inferred' : 'parsed',
    };
    rows.push(row);
    if (defect) {
      findings.push({
        code: 'NEVER_PREFILLED',
        verdict: 'defect',
        componentId: script.componentId,
        sourcePath: script.sourcePath,
        elementPath: s.elementPath,
        line: s.line,
        message: `${s.producedKey} is saved to ${fields.join(', ')}, but ${why}`,
        confidence: otherKey.concat(exact).some((r) => r.conditional) ? 'inferred' : 'parsed',
        evidence: {
          savedTo: fields,
          returnedElsewhere: otherKey,
          nearMiss: omnistudio.nearMisses(s.producedKey, otherKey.map((r) => r.screenKey), { prefixVariants: world.config.prefixVariants }),
        },
        citations: row.citations,
      });
    }
  }
  return { rows, findings, unmodeled, returnedCount: returned.length };
};

