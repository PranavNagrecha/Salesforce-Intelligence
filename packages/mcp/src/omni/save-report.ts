import { omnistudio } from '@sf-intelligence/extractors';

import { buildIpModel, type IpModel } from './ip-model.js';
import { buildMapperModel, type MapperModel } from './mapper-model.js';
import type { ScriptElement, ScriptModel } from './script-model.js';
import {
  type EvaluatedOutcome,
  type NearMissFeed,
  SaveTracer,
  type TracePlace,
} from './trace.js';
import {
  type OmniCitation,
  type OmniConfidence,
  type OmniFinding,
  omniElementId,
} from './types.js';
import type { OmniWorld } from './world.js';

/**
 * Save-trace reporting (spec F2): one row per answer-holding element with its
 * status, and the findings an audit acts on.
 *
 * Statuses:
 *   - SAVED               — a branch writes a field that exists, unconditionally
 *                           for this answer (its conditions all evaluate true);
 *   - SAVED_CONDITIONALLY — every writing branch has a condition that cannot be
 *                           decided from metadata (listed);
 *   - NEVER_SAVED         — no branch writes it. A `defect` when it was routed
 *                           to a save path that DROPPED it (a whitelist mapper
 *                           that saves its siblings); otherwise a fact (e.g. a
 *                           search input that is never meant to be saved);
 *   - UNKNOWN             — it enters something the trace cannot see into
 *                           (unanalysed Apex, a REST call, a missing component);
 *   - NOT_INPUT           — display-only.
 */

/** Row status. */
export type SaveStatus = 'SAVED' | 'SAVED_CONDITIONALLY' | 'NEVER_SAVED' | 'UNKNOWN' | 'NOT_INPUT';

/** Where a value is written. */
export interface SavedTo {
  readonly field: string;
  readonly object: string;
  readonly fieldStatus: string;
  readonly mechanism: 'load' | 'adapter';
  readonly unconditional: boolean;
  readonly via: readonly string[];
}

/** One row of the save trace. */
export interface SaveTraceRow {
  readonly element: string;
  readonly elementPath: string;
  readonly elementType: string;
  readonly line: number | null;
  readonly producedKey: string;
  readonly inRepeat: boolean;
  readonly status: SaveStatus;
  /** True for a NEVER_SAVED that is a defect (dropped by a save path). */
  readonly defect: boolean;
  readonly savedTo?: readonly SavedTo[];
  readonly droppedAt?: {
    readonly dataMapper: string | null;
    readonly componentId: string;
    readonly elementPath: string | null;
    readonly line: number | null;
    readonly reason: string;
    readonly inputKey?: string;
  };
  readonly nearMiss?: readonly NearMissFeed[];
  /** Formula elements through which the answer reaches a save (it is saved in derived form). */
  readonly derivedVia?: readonly string[];
  readonly unknownReason?: string;
  readonly conditions: readonly string[];
  readonly silentFailureSteps: readonly string[];
  readonly caveats: readonly string[];
  readonly citations: readonly OmniCitation[];
  readonly confidence: OmniConfidence;
}

/** A write path that nothing on the screen feeds (reverse direction). */
export interface OrphanWrite {
  readonly dataMapperItem: string;
  readonly mapperInputKey: string;
  /** The screen key that would feed it. */
  readonly expectedScreenKey: string;
  readonly feeds: readonly string[];
  readonly nearMiss: readonly { readonly key: string; readonly rule: omnistudio.NearMissRule; readonly element: string | null }[];
  readonly via: string;
  readonly citations: readonly OmniCitation[];
}

const rank: Record<OmniConfidence, number> = { declared: 3, parsed: 2, inferred: 1 };
const weakest = (xs: readonly OmniConfidence[]): OmniConfidence =>
  xs.reduce<OmniConfidence>((a, b) => (rank[a] <= rank[b] ? a : b), 'declared');
const strongest = (xs: readonly OmniConfidence[]): OmniConfidence =>
  xs.reduce<OmniConfidence>((a, b) => (rank[a] >= rank[b] ? a : b), 'inferred');

const placeKey = (p: TracePlace): string => `${p.componentId}#${p.elementPath ?? ''}`;

const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** Roles whose element stores an answer worth tracing. */
const TRACED_ROLES: ReadonlySet<omnistudio.ElementRole> = new Set(['input', 'formula', 'customLwc']);

/** Summarise one element's outcomes into a row. */
export const summarizeElement = (
  script: ScriptModel,
  element: ScriptElement,
  outcomes: readonly EvaluatedOutcome[],
): SaveTraceRow => {
  const head = {
    element: omniElementId(script.uniqueName, element.el.idPath),
    elementPath: element.el.idPath,
    elementType: element.el.type,
    line: element.el.line,
    producedKey: element.dataPath.join(':'),
    inRepeat: element.repeatingContainer !== null,
  };
  const selfCite: OmniCitation = {
    componentId: script.componentId,
    sourcePath: script.sourcePath,
    elementPath: element.el.idPath,
    ...(element.el.line === null ? {} : { line: element.el.line }),
  };
  if (!TRACED_ROLES.has(element.role)) {
    return { ...head, status: 'NOT_INPUT', defect: false, conditions: [], silentFailureSteps: [], caveats: [], citations: [selfCite], confidence: 'parsed' };
  }
  const live = outcomes.filter((o) => o.truth !== 'false');
  const conditionsOf = (os: readonly EvaluatedOutcome[]): string[] =>
    uniqSorted(os.flatMap((o) => o.evaluated.map((c) => `${c.source}: ${c.text}${c.truth === 'true' ? '' : ` [${c.truth}]`}`)));
  const silentOf = (os: readonly EvaluatedOutcome[]): string[] => uniqSorted(os.flatMap((o) => o.silent));
  const citesOf = (os: readonly EvaluatedOutcome[]): OmniCitation[] => {
    const m = new Map<string, OmniCitation>();
    for (const c of [selfCite, ...os.flatMap((o) => o.citations)]) m.set(`${c.componentId}#${c.elementPath ?? ''}`, c);
    return [...m.values()];
  };

  const writes = live.filter((o): o is Extract<EvaluatedOutcome, { kind: 'write' }> => o.kind === 'write');
  const existing = writes.filter((w) => w.fieldStatus !== 'missing');
  if (existing.length > 0) {
    const unconditional = existing.filter((w) => w.truth === 'true');
    const chosen = unconditional.length > 0 ? unconditional : existing;
    const savedTo = new Map<string, SavedTo>();
    for (const w of existing) {
      const field = w.fieldId ?? `CustomField:${w.object}.${w.field}`;
      const prev = savedTo.get(field);
      const row: SavedTo = { field, object: w.object, fieldStatus: w.fieldStatus, mechanism: w.mechanism, unconditional: w.truth === 'true', via: w.hops };
      if (prev === undefined || (!prev.unconditional && row.unconditional)) savedTo.set(field, row);
    }
    const caveats = existing.some((w) => w.fieldStatus === 'unknown')
      ? ['a target field is not modelled in the vault (standard or unretrieved) — its existence is unconfirmed']
      : [];
    return {
      ...head,
      status: unconditional.length > 0 ? 'SAVED' : 'SAVED_CONDITIONALLY',
      defect: false,
      savedTo: [...savedTo.values()].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)),
      conditions: conditionsOf(chosen),
      silentFailureSteps: silentOf(chosen),
      caveats,
      citations: citesOf(chosen),
      confidence: strongest(chosen.map((w) => w.confidence)),
    };
  }
  if (writes.length > 0) {
    const w = writes[0] as Extract<EvaluatedOutcome, { kind: 'write' }>;
    return {
      ...head,
      status: 'NEVER_SAVED',
      defect: true,
      droppedAt: { dataMapper: null, componentId: w.place.componentId, elementPath: w.place.elementPath, line: w.place.line, reason: `writes ${w.object}.${w.field}, which does not exist` },
      conditions: conditionsOf(writes),
      silentFailureSteps: silentOf(writes),
      caveats: [],
      citations: citesOf(writes),
      confidence: weakest(writes.map((x) => x.confidence)),
    };
  }
  const specificUnknown = live.filter((o) => o.kind === 'unknown' && o.specific);
  const specificDrops = live.filter((o): o is Extract<EvaluatedOutcome, { kind: 'drop' }> => o.kind === 'drop' && o.specific);
  const incidentalUnknown = live.filter((o) => o.kind === 'unknown' && !o.specific);
  const reasonOf = (o: EvaluatedOutcome): string => ('reason' in o ? o.reason : '');
  if (specificUnknown.length > 0) {
    const sorted = [...specificUnknown].sort((a, b) => (placeKey(a.place) < placeKey(b.place) ? -1 : 1));
    return {
      ...head,
      status: 'UNKNOWN',
      defect: false,
      unknownReason: uniqSorted(sorted.map(reasonOf)).join('; '),
      conditions: conditionsOf(sorted),
      silentFailureSteps: silentOf(sorted),
      caveats: [],
      citations: citesOf(sorted),
      confidence: 'inferred',
    };
  }
  if (specificDrops.length > 0) {
    const sorted = [...specificDrops].sort((a, b) => {
      const an = a.nearMiss.length > 0 ? 0 : 1;
      const bn = b.nearMiss.length > 0 ? 0 : 1;
      if (an !== bn) return an - bn;
      return placeKey(a.place) < placeKey(b.place) ? -1 : 1;
    });
    const d = sorted[0] as Extract<EvaluatedOutcome, { kind: 'drop' }>;
    const nearMiss = new Map<string, NearMissFeed>();
    for (const x of sorted) for (const n of x.nearMiss) nearMiss.set(`${n.key}\u0000${n.rule}`, n);
    const isAnswer = element.role === 'input';
    const caveats = [
      ...(incidentalUnknown.length > 0 ? [`also passed incidentally to: ${uniqSorted(incidentalUnknown.map(reasonOf)).join('; ')}`] : []),
      ...(isAnswer ? [] : [`a computed ${element.el.type} element, usually a helper rather than an answer — not reported as a defect`]),
    ];
    return {
      ...head,
      status: 'NEVER_SAVED',
      defect: isAnswer,
      droppedAt: {
        dataMapper: d.dataMapper,
        componentId: d.place.componentId,
        elementPath: d.place.elementPath,
        line: d.place.line,
        reason: d.reason,
        inputKey: d.inputKey,
      },
      nearMiss: [...nearMiss.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      conditions: conditionsOf(sorted),
      silentFailureSteps: silentOf(sorted),
      caveats,
      citations: citesOf(sorted),
      confidence: incidentalUnknown.length > 0 ? 'inferred' : weakest(sorted.map((x) => x.confidence)),
    };
  }
  if (incidentalUnknown.length > 0) {
    return {
      ...head,
      status: 'UNKNOWN',
      defect: false,
      unknownReason: `reaches the server only inside a whole-data-JSON send: ${uniqSorted(incidentalUnknown.map(reasonOf)).join('; ')}`,
      conditions: [],
      silentFailureSteps: [],
      caveats: [],
      citations: citesOf(incidentalUnknown),
      confidence: 'inferred',
    };
  }
  const consumed = live.filter((o) => o.kind === 'consumed');
  return {
    ...head,
    status: 'NEVER_SAVED',
    defect: false,
    conditions: [],
    silentFailureSteps: [],
    caveats: consumed.length > 0 ? [`used, not saved: ${uniqSorted(consumed.map(reasonOf)).join('; ')}`] : ['not routed to any save path in this script'],
    citations: [selfCite],
    confidence: 'parsed',
  };
};

/** A Custom LWC whose written keys are undeclared: honestly UNKNOWN. */
const unknownLwcRow = (script: ScriptModel, e: ScriptElement): SaveTraceRow => ({
  element: omniElementId(script.uniqueName, e.el.idPath),
  elementPath: e.el.idPath,
  elementType: e.el.type,
  line: e.el.line,
  producedKey: e.dataPath.join(':'),
  inRepeat: e.repeatingContainer !== null,
  status: 'UNKNOWN',
  defect: false,
  unknownReason: `custom Lightning Web Component${typeof e.el.config?.['lwcName'] === 'string' ? ` ${e.el.config['lwcName']}` : ''}: the keys it writes are not declared (declare them in config customLwcOutputs)`,
  conditions: [],
  silentFailureSteps: [],
  caveats: [],
  citations: [
    {
      componentId: script.componentId,
      sourcePath: script.sourcePath,
      elementPath: e.el.idPath,
      ...(e.el.line === null ? {} : { line: e.el.line }),
    },
  ],
  confidence: 'inferred',
});

/**
 * An answer a Formula reads is saved in DERIVED form when that Formula (or a
 * Formula reading it, transitively) is saved — e.g. a member picker split
 * into the Id and name a mapper saves. Upgrade such NEVER_SAVED / UNKNOWN rows,
 * naming the formulas, at `inferred` confidence (the saved value is computed
 * from the answer, not the answer itself).
 */
const applyFormulaDerivations = (script: ScriptModel, rows: SaveTraceRow[]): void => {
  const byPath = new Map(rows.map((r, i) => [r.elementPath, i] as const));
  const dependents = new Map<string, string[]>();
  for (const f of script.elements) {
    if (f.role !== 'formula') continue;
    const expr = f.el.config?.['expression'];
    if (typeof expr !== 'string') continue;
    for (const ref of omnistudio.scanPercentRefs(expr).refs) {
      for (const p of script.resolveRef(omnistudio.segmentNames(ref.path), f).producers) {
        if (p.element === null || p.element === f) continue;
        const list = dependents.get(p.element.el.idPath) ?? [];
        if (!list.includes(f.el.idPath)) list.push(f.el.idPath);
        dependents.set(p.element.el.idPath, list);
      }
    }
  }
  const memo = new Map<string, { row: SaveTraceRow; via: string[] } | null>();
  const savedVia = (idPath: string, seen: Set<string>): { row: SaveTraceRow; via: string[] } | null => {
    if (memo.has(idPath)) return memo.get(idPath) ?? null;
    if (seen.has(idPath)) return null;
    seen.add(idPath);
    let best: { row: SaveTraceRow; via: string[] } | null = null;
    for (const dep of (dependents.get(idPath) ?? []).sort()) {
      const i = byPath.get(dep);
      const depRow = i === undefined ? undefined : rows[i];
      if (depRow === undefined) continue;
      const direct = depRow.status === 'SAVED' || depRow.status === 'SAVED_CONDITIONALLY' ? { row: depRow, via: [depRow.element] } : null;
      const viaDep = direct ?? (() => {
        const deeper = savedVia(dep, seen);
        return deeper === null ? null : { row: deeper.row, via: [depRow.element, ...deeper.via] };
      })();
      if (viaDep !== null && (best === null || (best.row.status !== 'SAVED' && viaDep.row.status === 'SAVED'))) best = viaDep;
    }
    memo.set(idPath, best);
    return best;
  };
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] as SaveTraceRow;
    if (r.status !== 'NEVER_SAVED' && r.status !== 'UNKNOWN') continue;
    if (r.unknownReason?.startsWith('custom Lightning Web Component') === true) continue;
    const hit = savedVia(r.elementPath, new Set());
    if (hit === null) continue;
    const { droppedAt, nearMiss: _nearMiss, unknownReason: _unknown, ...rest } = r;
    const ownFate = droppedAt === undefined
      ? []
      : [`its own key is dropped (${droppedAt.reason}${droppedAt.dataMapper === null ? '' : ` at ${droppedAt.dataMapper}`})`];
    rows[i] = {
      ...rest,
      status: hit.row.status,
      defect: false,
      ...(hit.row.savedTo === undefined ? {} : { savedTo: hit.row.savedTo }),
      derivedVia: hit.via,
      conditions: hit.row.conditions,
      silentFailureSteps: hit.row.silentFailureSteps,
      caveats: [
        ...r.caveats.filter((c) => !c.startsWith('not routed') && !c.startsWith('a computed')),
        ...ownFate,
        `saved in derived form through ${hit.via.join(' → ')}`,
      ],
      citations: [...r.citations, ...hit.row.citations.filter((c) => !r.citations.some((x) => x.componentId === c.componentId && x.elementPath === c.elementPath))],
      confidence: 'inferred',
    };
  }
};

/** Options for {@link buildSaveTrace}. */
export interface SaveTraceOptions {
  /** Restrict rows to elements under this step (element name). */
  readonly step?: string;
  /** Include display-only / container rows as NOT_INPUT. */
  readonly includeNonInputs?: boolean;
}

/** The full save-trace result for one script. */
export interface SaveTraceResult {
  readonly rows: readonly SaveTraceRow[];
  readonly orphanWrites: readonly OrphanWrite[];
  /** Write paths nothing on the screen feeds and no near-miss explains (likely prefill-fed). */
  readonly unfedWrites: readonly OrphanWrite[];
  readonly findings: readonly OmniFinding[];
  readonly statusCounts: Readonly<Record<SaveStatus, number>>;
}

/** Trace every answer of `script` and report. */
export const buildSaveTrace = async (
  world: OmniWorld,
  script: ScriptModel,
  options: SaveTraceOptions = {},
): Promise<SaveTraceResult> => {
  const tracer = new SaveTracer(world, script);
  const inStep = (e: ScriptElement): boolean => options.step === undefined || e.el.path[0] === options.step;
  const rows: SaveTraceRow[] = [];
  const undeclared = new Set(script.undeclaredWriters);
  for (const e of script.elements) {
    if (!inStep(e)) continue;
    if (!TRACED_ROLES.has(e.role) && options.includeNonInputs !== true) continue;
    if (e.role === 'customLwc' && undeclared.has(e)) {
      rows.push(unknownLwcRow(script, e));
      continue;
    }
    let outcomes: EvaluatedOutcome[] = [];
    if (e.role === 'customLwc') {
      // Declared outputs: trace each declared key.
      for (const p of script.producers) {
        if (p.element === e && p.confidence === 'declared') outcomes = [...outcomes, ...(await tracer.traceElement(e, p.path))];
      }
    } else if (TRACED_ROLES.has(e.role)) {
      outcomes = [...(await tracer.traceElement(e))];
    }
    rows.push(summarizeElement(script, e, outcomes));
  }
  applyFormulaDerivations(script, rows);
  const { orphans, unfed } = await findOrphanWrites(world, script, tracer, options.step);
  const findings: OmniFinding[] = [];
  for (const r of rows) {
    if (r.status !== 'NEVER_SAVED' || !r.defect) continue;
    findings.push({
      code: 'NEVER_SAVED',
      verdict: 'defect',
      componentId: script.componentId,
      sourcePath: script.sourcePath,
      elementPath: r.elementPath,
      line: r.line,
      message: `${r.producedKey} is never saved: ${r.droppedAt?.reason ?? 'dropped'}${r.droppedAt?.dataMapper ? ` at ${r.droppedAt.dataMapper}` : ''}`,
      confidence: r.confidence,
      evidence: { producedKey: r.producedKey, droppedAt: r.droppedAt, nearMiss: r.nearMiss ?? [], conditions: r.conditions, silentFailureSteps: r.silentFailureSteps, caveats: r.caveats },
      citations: r.citations,
    });
  }
  for (const o of orphans) {
    findings.push({
      code: 'ORPHAN_WRITE',
      verdict: 'defect',
      componentId: script.componentId,
      sourcePath: script.sourcePath,
      elementPath: null,
      line: null,
      message: `${o.dataMapperItem} writes ${o.feeds.join(', ') || 'a field'} from ${o.expectedScreenKey}, which no element produces`,
      confidence: 'parsed',
      evidence: { ...o },
      citations: o.citations,
    });
  }
  const statusCounts: Record<SaveStatus, number> = { SAVED: 0, SAVED_CONDITIONALLY: 0, NEVER_SAVED: 0, UNKNOWN: 0, NOT_INPUT: 0 };
  for (const r of rows) statusCounts[r.status] += 1;
  return { rows, orphanWrites: orphans, unfedWrites: unfed, findings, statusCounts };
};

/**
 * Reverse direction: for every mapper item on a save path whose output reaches
 * a write, map its input back to the screen key that would feed it. When no
 * element produces that key it is an orphan: a DEFECT when an element's key is
 * a near-miss of it (the naming slip that breaks the save), otherwise listed
 * as `unfed` (it may be fed by prefill, which is not an element).
 */
const findOrphanWrites = async (
  world: OmniWorld,
  script: ScriptModel,
  tracer: SaveTracer,
  step: string | undefined,
): Promise<{ orphans: OrphanWrite[]; unfed: OrphanWrite[] }> => {
  const orphans = new Map<string, OrphanWrite>();
  const unfed = new Map<string, OrphanWrite>();
  const elementKeys = script.producers.filter((p) => p.kind === 'element').map((p) => p.path.join(':'));
  for (const action of script.actions) {
    if (action.kind !== 'ipAction' && action.kind !== 'editBlockSaveKey') continue;
    if (action.editBlockButton === 'Delete') continue;
    if (step !== undefined && action.element.el.path[0] !== step && action.base.kind !== 'all') {
      // Keep actions outside the step only when they could carry its keys.
      const touches = action.entries.some((e) => e.kind === 'move' && e.from !== null && omnistudio.segmentNames(e.from)[0] === step);
      if (!touches) continue;
    }
    const target = world.resolveIpKey(action.ipKey ?? '');
    if (target.node === null) continue;
    const ip = await tracer.ipModel(target.node.id);
    if (ip === null) continue;
    for (const s of ip.steps) {
      if (s.role !== 'dataMapper' || s.bundle === null) continue;
      const mm = await tracer.mapperModel(s.bundle);
      if (mm === null || (mm.kind !== 'Transform' && mm.kind !== 'Load')) continue;
      for (const it of mm.items) {
        if (it.input === null || it.output === null) continue;
        const feeds = mm.kind === 'Load'
          ? (it.jsonOutput ? [] : [`CustomField:${it.item.outputObjectName ?? '?'}.${it.item.outputFieldName ?? '?'}`])
          : await tracer.feedsFrom(ip, s, [...s.outputRoot, ...it.output]);
        if (feeds.length === 0) continue;
        for (const screen of invertToScreen(script, action, ip, s, it.input)) {
          if (step !== undefined && screen[0] !== step) continue;
          if (script.producersAt(screen).length > 0) continue;
          const container = screen.slice(0, -1).join(':');
          const siblings = elementKeys.filter((k) => k.split(':').slice(0, -1).join(':') === container);
          const near = omnistudio.nearMisses(screen.join(':'), siblings, { prefixVariants: world.config.prefixVariants });
          const id = `DataMapperItem:${mm.uniqueName}#${it.item.index}`;
          const row: OrphanWrite = {
            dataMapperItem: id,
            mapperInputKey: it.input.join(':'),
            expectedScreenKey: screen.join(':'),
            feeds,
            nearMiss: near.map((n) => ({
              key: n.candidate,
              rule: n.rule,
              element: (() => {
                const p = script.producersAt(n.candidate.split(':'))[0];
                return p?.element === null || p === undefined ? null : omniElementId(script.uniqueName, p.element.el.idPath);
              })(),
            })),
            via: `${action.element.el.idPath} → ${ip.componentId}#${s.el.idPath} → ${mm.componentId}`,
            citations: [
              { componentId: script.componentId, sourcePath: script.sourcePath, elementPath: action.element.el.idPath, ...(action.element.el.line === null ? {} : { line: action.element.el.line }) },
              { componentId: ip.componentId, sourcePath: ip.sourcePath, elementPath: s.el.idPath, ...(s.el.line === null ? {} : { line: s.el.line }) },
              { componentId: mm.componentId, sourcePath: mm.sourcePath, elementPath: `item[${it.item.index}]`, ...(it.item.line === null ? {} : { line: it.item.line }) },
            ],
          };
          const key = `${id}\u0000${row.expectedScreenKey}`;
          if (near.length > 0) orphans.set(key, row);
          else unfed.set(key, row);
        }
      }
    }
  }
  const sort = (m: Map<string, OrphanWrite>): OrphanWrite[] =>
    [...m.values()].sort((a, b) => (a.dataMapperItem < b.dataMapperItem ? -1 : a.dataMapperItem > b.dataMapperItem ? 1 : a.expectedScreenKey < b.expectedScreenKey ? -1 : 1));
  return { orphans: sort(orphans), unfed: sort(unfed) };
};

/** Map a mapper item's input path back through the step and action bindings to screen keys. */
const invertToScreen = (
  script: ScriptModel,
  action: (ScriptModel['actions'])[number],
  _ip: IpModel,
  s: IpModel['steps'][number],
  input: readonly string[],
): readonly (readonly string[])[] => {
  const ipPaths: (readonly string[])[] = [];
  for (const e of s.additional) {
    if (e.kind !== 'move' || e.from === null) continue;
    const k = omnistudio.segmentNames(omnistudio.parseKeyPath(e.key));
    if (omnistudio.isPrefixOf(k, input)) ipPaths.push([...omnistudio.segmentNames(e.from), ...input.slice(k.length)]);
  }
  if (!s.onlyAdditional) {
    const node = s.sendNode ?? [];
    if (omnistudio.isPrefixOf(node, input)) ipPaths.push([...(s.sendPath ?? []), ...input.slice(node.length)]);
  }
  const screens: (readonly string[])[] = [];
  const sendNode = action.sendNode ?? [];
  for (const p of ipPaths) {
    for (const e of action.entries) {
      if (e.kind !== 'move' || e.from === null) continue;
      const k = omnistudio.segmentNames(omnistudio.parseKeyPath(e.key));
      if (!omnistudio.isPrefixOf(k, p)) continue;
      for (const loc of script.resolveRef(omnistudio.segmentNames(e.from), action.element).producers) {
        if (loc.kind === 'container' || loc.kind === 'element' || loc.kind === 'setValues') screens.push([...loc.path, ...p.slice(k.length)]);
      }
    }
    if (omnistudio.isPrefixOf(sendNode, p)) {
      const rest = p.slice(sendNode.length);
      if (action.base.kind === 'all') screens.push(rest);
      else if (action.base.kind === 'row') screens.push([...action.base.container.dataPath, ...rest]);
      else if (action.base.kind === 'path') screens.push([...action.base.path, ...rest]);
    }
  }
  // Only paths that land inside a container the script defines are screen keys.
  const containers = new Set(script.producers.filter((p) => p.kind === 'container').map((p) => p.path.join(':')));
  const seen = new Set<string>();
  const out: (readonly string[])[] = [];
  for (const sp of screens) {
    if (sp.length < 2 || !containers.has(sp.slice(0, -1).join(':'))) continue;
    const k = sp.join(':');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(sp);
  }
  return out;
};

// Re-exported for the IP chain tool, which shares the models.
export { buildIpModel, buildMapperModel };
export type { IpModel, MapperModel };
