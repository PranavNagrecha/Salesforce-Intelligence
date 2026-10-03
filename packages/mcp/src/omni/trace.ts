import { omnistudio } from '@sf-intelligence/extractors';

import { matchesCallSite } from './config.js';
import { buildIpModel, type IpModel, type IpStep } from './ip-model.js';
import {
  buildMapperModel,
  extractFilterUses,
  itemInputForms,
  mapperHits,
  type MapperModel,
} from './mapper-model.js';
import { classifyPayload, type PayloadEntry } from './payload.js';
import type { ScriptAction, ScriptElement, ScriptModel } from './script-model.js';
import type { OmniCitation, OmniConfidence } from './types.js';
import type { FieldStatus, OmniWorld } from './world.js';

/**
 * The save-trace engine (spec F2): follow one screen key — the answer an
 * element stores — through every server call the script makes, into the
 * Integration Procedure, through its DataMappers and Apex adapters, to a field
 * write, a drop, or a place the trace cannot see into.
 *
 * Every hop is a metadata fact (a payload entry, an `additionalInput`, a
 * mapper item); every outcome cites where it happened. Conditions met on the
 * way (an action's show rule, a step's `executionConditionalFormula`) are
 * evaluated three-valued with what is KNOWN — payload constants, the
 * element's own visibility, "the container carrying the answer is not blank" —
 * so a branch that cannot run for this answer is pruned, one that may run is
 * CONDITIONAL, and nothing is guessed.
 */

/** A place an outcome happened at. */
export interface TracePlace {
  readonly componentId: string;
  readonly sourcePath: string;
  readonly elementPath: string | null;
  readonly line: number | null;
}

/** One condition met on a branch, with its evaluated truth. */
export interface TraceCondition {
  readonly kind: 'show' | 'formula';
  /** e.g. `action SaveCart show rule`, `IP step Acme_Save_English_2#Try/Transform`. */
  readonly source: string;
  readonly text: string;
  readonly truth: omnistudio.Tri;
}

/** A near-miss: an item key that almost equals the dropped key, and what it feeds. */
export interface NearMissFeed {
  readonly key: string;
  readonly rule: omnistudio.NearMissRule;
  readonly feeds: readonly string[];
}

interface OutcomeBase {
  /** True when the answer was routed here explicitly (not swept along in a whole-JSON send). */
  readonly specific: boolean;
  /** Conditions met on the branch, evaluated once the branch ends. */
  readonly conditions: readonly PendingCondition[];
  /** Steps on the branch whose `failOnStepError` is false — a failure there is silent. */
  readonly silent: readonly string[];
  readonly hops: readonly string[];
  readonly citations: readonly OmniCitation[];
  /** `inferred` when a hop rests on an inferred runtime semantic. */
  readonly confidence: OmniConfidence;
  /** A tag carried from the seeded value (prefill: the field an Extract read). */
  readonly origin?: string;
}

/** Where one branch of the answer ended. */
export type TraceOutcome =
  | (OutcomeBase & {
      readonly kind: 'write';
      readonly object: string;
      readonly field: string;
      readonly fieldId: string | null;
      readonly fieldStatus: FieldStatus;
      readonly mechanism: 'load' | 'adapter';
      readonly place: TracePlace;
    })
  | (OutcomeBase & {
      readonly kind: 'drop';
      readonly place: TracePlace;
      readonly reason: string;
      readonly dataMapper: string | null;
      readonly inputKey: string;
      readonly nearMiss: readonly NearMissFeed[];
    })
  | (OutcomeBase & { readonly kind: 'unknown'; readonly place: TracePlace; readonly reason: string })
  | (OutcomeBase & { readonly kind: 'consumed'; readonly place: TracePlace; readonly reason: string })
  | (OutcomeBase & {
      readonly kind: 'returned';
      readonly place: TracePlace;
      /** Where the value sits in the IP's response. */
      readonly responsePath: readonly string[];
    });

/** A value — one screen answer — living at a path in an IP's data JSON. */
export interface Fact {
  readonly path: readonly string[];
  /** Every path the answer has occupied in this IP (its carriers are non-blank). */
  readonly trail: readonly (readonly string[])[];
  /** The step after which it exists (-1: the IP's input). */
  readonly createdAt: number;
  readonly specific: boolean;
  readonly derived: boolean;
  readonly conditions: readonly PendingCondition[];
  readonly silent: readonly string[];
  readonly hops: readonly string[];
  readonly citations: readonly OmniCitation[];
  readonly confidence: OmniConfidence;
  readonly origin?: string;
}

/** A condition recorded on a branch, evaluated once the branch ends. */
export type PendingCondition =
  | { readonly kind: 'show'; readonly source: string; readonly rule: omnistudio.ShowRule }
  | {
      readonly kind: 'formula';
      readonly source: string;
      readonly formula: string;
      /** Every path the answer occupied when the condition was met (their carriers are non-blank). */
      readonly carry: readonly (readonly string[])[];
    };

/** Evaluation context for one action's branches. */
interface Bindings {
  /** IP-root constants from the action's literal payload entries. */
  readonly constants: ReadonlyMap<string, unknown>;
  /** Field → value the element's own visibility guarantees (AND-only `=` rules). */
  readonly visibleWhen: ReadonlyMap<string, unknown>;
  /** Normalised rules (and AND-conjuncts) the element's visibility already guarantees. */
  readonly implied: ReadonlySet<string>;
  /** True when a show-rule field names a container that holds the answer (so it is not null). */
  readonly isCarrier: (field: string) => boolean;
}

/** A canonical string for a rule, for implication checks. */
const ruleKey = (rule: omnistudio.ShowRule): string =>
  rule.kind === 'cond'
    ? `c|${rule.field}|${rule.condition}|${JSON.stringify(rule.data ?? null)}`
    : `g|${rule.operator}|${rule.rules.map(ruleKey).join(',')}`;

/** Every rule the visibility chain guarantees: each rule and, through AND groups, each conjunct. */
export const impliedRules = (chain: readonly omnistudio.ShowRule[]): ReadonlySet<string> => {
  const out = new Set<string>();
  const walk = (r: omnistudio.ShowRule): void => {
    out.add(ruleKey(r));
    if (r.kind === 'group' && (r.operator === 'AND' || r.rules.length === 1)) r.rules.forEach(walk);
  };
  chain.forEach(walk);
  return out;
};

/** Evaluate a show rule knowing which rules are already guaranteed. */
const evaluateImplied = (
  rule: omnistudio.ShowRule,
  b: Bindings,
): omnistudio.Tri => {
  if (b.implied.has(ruleKey(rule))) return 'true';
  if (rule.kind === 'group') {
    const parts = rule.rules.map((r) => evaluateImplied(r, b));
    return rule.operator === 'OR' ? omnistudio.triOr(parts) : omnistudio.triAnd(parts);
  }
  const empty = rule.data === null || rule.data === undefined || rule.data === '';
  if (b.isCarrier(rule.field) && empty) {
    if (rule.condition === '<>' || rule.condition === '!=') return 'true';
    if (rule.condition === '=' || rule.condition === '==') return 'false';
  }
  return omnistudio.evaluateShowRule(rule, (field) => {
    if (b.visibleWhen.has(field)) return { known: true, value: b.visibleWhen.get(field) };
    const last = keyNames(field).at(-1) ?? field;
    for (const [k, v] of b.visibleWhen) if ((keyNames(k).at(-1) ?? k) === last) return { known: true, value: v };
    return { known: false };
  });
};

/** Residual cap on values traced through one IP (a fetch can seed every field of an object). */
export const MAX_FACTS_PER_IP = 20_000;
const MAX_IP_DEPTH = 4;

const keyNames = (raw: string): readonly string[] => omnistudio.segmentNames(omnistudio.parseKeyPath(raw));

/** Functions that keep the records of their single input (filter / wrap / null-guard). */
const STRUCTURE_PRESERVING = /^(IF|ISNOTBLANK|ISBLANK|LIST|FILTER|SORTBY|NULL|TRUE|FALSE)$/;

/**
 * If a derived payload value reads ONE path and only filters / wraps /
 * null-guards it — `=FILTER(LIST(%X%), "…")`, `=IF(ISNOTBLANK(%X%),LIST(%X%),null)`
 * — the records at that path flow through with their keys intact. Returns that
 * path's names, else null (a real computation).
 */
export const structurePreservingSource = (entry: PayloadEntry): readonly string[] | null => {
  if (entry.kind !== 'derived' || typeof entry.value !== 'string' || entry.refs.length === 0 || entry.malformed.length > 0) return null;
  const forms = new Set(entry.refs.map((r) => omnistudio.segmentNames(r.path).join(':')));
  if (forms.size !== 1) return null;
  const rest = entry.value
    .trim()
    .replace(/^=/, '')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/%[^%]*%/g, ' ');
  const tokens = rest.split(/[\s,()]+/).filter((t) => t.length > 0);
  if (!tokens.every((t) => STRUCTURE_PRESERVING.test(t.toUpperCase()))) return null;
  return omnistudio.segmentNames((entry.refs[0] as omnistudio.MergeRef).path);
};

const weaker = (a: OmniConfidence, b: OmniConfidence): OmniConfidence => {
  const rank: Record<OmniConfidence, number> = { declared: 3, parsed: 2, inferred: 1 };
  return rank[a] <= rank[b] ? a : b;
};

/** Conditions an element's own visibility guarantees: every `=` rule in an all-AND chain. */
export const visibilityBindings = (rules: readonly omnistudio.ShowRule[]): ReadonlyMap<string, unknown> => {
  const out = new Map<string, unknown>();
  const walk = (r: omnistudio.ShowRule): void => {
    if (r.kind === 'cond') {
      if (r.condition === '=' || r.condition === '==') out.set(r.field, r.data);
      return;
    }
    if (r.operator === 'AND') r.rules.forEach(walk);
  };
  rules.forEach(walk);
  return out;
};

/** True when every use of `%raw%` in `formula` is inside ISBLANK( ) / ISNOTBLANK( ). */
const onlyBlankChecked = (formula: string, raw: string): boolean => {
  const token = `%${raw}%`;
  let i = formula.indexOf(token);
  if (i === -1) return false;
  while (i !== -1) {
    const before = formula.slice(0, i).replace(/\s+$/, '');
    const after = formula.slice(i + token.length).replace(/^\s+/, '');
    if (!/IS(NOT)?BLANK\($/i.test(before) || !after.startsWith(')')) return false;
    i = formula.indexOf(token, i + token.length);
  }
  return true;
};

/** Evaluate the recorded conditions of a branch. */
const evaluateConditions = (pending: readonly PendingCondition[], b: Bindings): TraceCondition[] =>
  pending.map((c) => {
    if (c.kind === 'show') {
      return { kind: 'show' as const, source: c.source, text: describeRule(c.rule), truth: evaluateImplied(c.rule, b) };
    }
    const r = omnistudio.evaluateFormula(c.formula, (raw) => {
      const names = keyNames(raw);
      const k = names.join(':');
      if (b.constants.has(k)) return { known: true, value: b.constants.get(k) };
      if (c.carry.some((p) => omnistudio.isPrefixOf(names, p)) && onlyBlankChecked(c.formula, raw)) {
        return { known: true, value: { carriesTheAnswer: true } };
      }
      return { known: false };
    });
    return { kind: 'formula' as const, source: c.source, text: c.formula, truth: r.truth };
  });

/** A compact human rendering of a show rule. */
export const describeRule = (rule: omnistudio.ShowRule): string => {
  if (rule.kind === 'cond') return `${rule.field} ${rule.condition} ${JSON.stringify(rule.data)}`;
  return `(${rule.rules.map(describeRule).join(` ${rule.operator} `)})`;
};

/** Combined truth of a branch's evaluated conditions. */
export const branchTruth = (conds: readonly TraceCondition[]): omnistudio.Tri =>
  omnistudio.triAnd(conds.map((c) => c.truth));

/** An outcome after its conditions were evaluated. */
export type EvaluatedOutcome = TraceOutcome & { readonly evaluated: readonly TraceCondition[]; readonly truth: omnistudio.Tri };

/** The heuristic generic-upsert recognizer (spec §2.9): `records` + a literal object name. */
const heuristicAdapter = (step: IpStep): { recordsKey: string; object: string } | null => {
  const records = step.additional.filter((e) => /^records?$/i.test(e.key.trim()) && e.kind === 'move');
  const objects = step.additional.filter(
    (e) => /object(ApiName|Name|Type)/i.test(e.key.trim()) && e.kind === 'literal' && typeof e.value === 'string',
  );
  if (records.length !== 1 || objects.length !== 1) return null;
  return { recordsKey: (records[0] as PayloadEntry).key, object: String((objects[0] as PayloadEntry).value).trim() };
};

/** The save tracer for one script. Caches IP and mapper models across elements. */
export class SaveTracer {
  readonly #world: OmniWorld;
  readonly #script: ScriptModel;
  readonly #ipModels = new Map<string, Promise<IpModel | null>>();
  readonly #mapperModels = new Map<string, Promise<MapperModel | null>>();

  constructor(world: OmniWorld, script: ScriptModel) {
    this.#world = world;
    this.#script = script;
  }

  /** Load (cached) the IP model for a node id. */
  async ipModel(nodeId: string): Promise<IpModel | null> {
    let p = this.#ipModels.get(nodeId);
    if (p === undefined) {
      p = (async () => {
        const node = this.#world.nodeById(nodeId);
        if (node === null) return null;
        const loaded = await this.#world.loadProcess(node);
        return loaded.ok ? buildIpModel(loaded.value) : null;
      })();
      this.#ipModels.set(nodeId, p);
    }
    return p;
  }

  /** Load (cached) the mapper model for a bundle name. */
  async mapperModel(bundle: string): Promise<MapperModel | null> {
    let p = this.#mapperModels.get(bundle);
    if (p === undefined) {
      p = (async () => {
        const r = this.#world.resolveBundle(bundle);
        if (r.node === null) return null;
        const loaded = await this.#world.loadMapper(r.node);
        return loaded.ok ? buildMapperModel(loaded.value) : null;
      })();
      this.#mapperModels.set(bundle, p);
    }
    return p;
  }

  /** Where else a screen key lives: moved by a script Set Values (one hop). */
  screenLocations(key: readonly string[]): readonly (readonly string[])[] {
    const out: (readonly string[])[] = [key];
    for (const e of this.#script.elements) {
      if (e.role !== 'setValues') continue;
      for (const v of classifyPayload(e.el.config?.['elementValueMap'])) {
        if (v.kind !== 'move' || v.from === null) continue;
        for (const loc of this.#script.resolveRef(omnistudio.segmentNames(v.from), e).producers) {
          if (omnistudio.isPrefixOf(loc.path, key)) out.push([...keyNames(v.key), ...key.slice(loc.path.length)]);
        }
      }
    }
    return out;
  }

  /** Map a screen key into an action's callee input. */
  mapIntoCallee(
    action: ScriptAction,
    key: readonly string[],
  ): readonly { readonly path: readonly string[]; readonly specific: boolean; readonly derived: boolean; readonly hop: string; readonly confidence: OmniConfidence }[] {
    const out: { path: readonly string[]; specific: boolean; derived: boolean; hop: string; confidence: OmniConfidence }[] = [];
    const node = action.sendNode ?? [];
    const label = action.element.el.idPath;
    for (const loc of this.screenLocations(key)) {
      switch (action.base.kind) {
        case 'all':
          out.push({ path: [...node, ...loc], specific: false, derived: false, hop: `${label} sends the whole data JSON`, confidence: action.baseConfidence });
          break;
        case 'path':
          if (omnistudio.isPrefixOf(action.base.path, loc)) {
            out.push({ path: [...node, ...loc.slice(action.base.path.length)], specific: action.base.path.length > 0, derived: false, hop: `${label} sendJSONPath ${action.base.path.join(':')}`, confidence: action.baseConfidence });
          }
          break;
        case 'row':
          if (omnistudio.isPrefixOf(action.base.container.dataPath, loc)) {
            out.push({ path: [...node, ...loc.slice(action.base.container.dataPath.length)], specific: true, derived: false, hop: `${label} sends the card's row`, confidence: action.baseConfidence });
          }
          break;
        default:
          break;
      }
      for (const entry of action.entries) {
        if (entry.kind === 'move' && entry.from !== null) {
          for (const p of this.#script.resolveRef(omnistudio.segmentNames(entry.from), action.element).producers) {
            if (omnistudio.isPrefixOf(p.path, loc)) {
              out.push({ path: [...keyNames(entry.key), ...loc.slice(p.path.length)], specific: true, derived: false, hop: `${label} ${action.payloadProp}.${entry.key} = ${String(entry.value)}`, confidence: 'parsed' });
            }
          }
        } else if (entry.kind === 'derived') {
          for (const r of entry.refs) {
            for (const p of this.#script.resolveRef(omnistudio.segmentNames(r.path), action.element).producers) {
              if (omnistudio.isPrefixOf(p.path, loc)) {
                out.push({ path: keyNames(entry.key), specific: true, derived: true, hop: `${label} ${action.payloadProp}.${entry.key} derives from it`, confidence: 'inferred' });
              }
            }
          }
        }
      }
    }
    // De-duplicate identical callee paths, keeping the most specific.
    const seen = new Map<string, (typeof out)[number]>();
    for (const o of out) {
      const k = o.path.join('\u0000');
      const prev = seen.get(k);
      if (prev === undefined || (o.specific && !prev.specific)) seen.set(k, o);
    }
    return [...seen.values()];
  }

  /** Literal payload entries of an action, as IP-root constants. */
  static constantsOf(action: ScriptAction): ReadonlyMap<string, unknown> {
    const m = new Map<string, unknown>();
    for (const e of action.entries) if (e.kind === 'literal' || e.kind === 'other') m.set(keyNames(e.key).join(':'), e.value);
    return m;
  }

  /** Trace one element's answer through every server call. */
  async traceElement(element: ScriptElement, key: readonly string[] = element.dataPath): Promise<readonly EvaluatedOutcome[]> {
    const results: EvaluatedOutcome[] = [];
    const sharedVisibility = new Set(element.visibility);
    const bindingsBase = visibilityBindings(element.visibility);
    const implied = impliedRules(element.visibility);
    const isCarrier = (field: string): boolean =>
      this.#script
        .resolveRef(keyNames(field), element)
        .producers.some((p) => p.kind === 'container' && omnistudio.isPrefixOf(p.path, key));
    for (const action of this.#script.actions) {
      if (action.kind === 'editBlockDeleteKey' || action.editBlockButton === 'Delete') continue;
      const mapped = this.mapIntoCallee(action, key);
      if (mapped.length === 0) continue;
      const showConds: PendingCondition[] = action.visibility
        .filter((r) => !sharedVisibility.has(r))
        .map((rule) => ({ kind: 'show' as const, source: `action ${action.element.el.idPath} show rule`, rule }));
      const bindings: Bindings = { constants: SaveTracer.constantsOf(action), visibleWhen: bindingsBase, implied, isCarrier };
      const actionCite: OmniCitation = this.#cite(action.element);
      const raw: TraceOutcome[] = [];
      if (action.kind === 'ipAction' || action.kind === 'editBlockSaveKey') {
        const target = this.#world.resolveIpKey(action.ipKey ?? '');
        if (target.node === null) {
          for (const m of mapped) {
            raw.push({
              kind: 'unknown',
              place: this.#place(action.element),
              reason: `calls Integration Procedure ${action.ipKey ?? '?'}, which is not in the vault`,
              specific: m.specific,
              conditions: showConds,
              silent: [],
              hops: [m.hop],
              citations: [actionCite],
              confidence: 'inferred',
            });
          }
        } else {
          const ip = await this.ipModel(target.node.id);
          if (ip === null) {
            raw.push(this.#unreadable(action, target.node.id, showConds, mapped[0]?.specific ?? false));
          } else {
            const facts: Fact[] = mapped.map((m) => ({
              path: m.path,
              trail: [m.path],
              createdAt: -1,
              specific: m.specific,
              derived: m.derived,
              conditions: showConds,
              silent: [],
              hops: [m.hop, `→ ${ip.componentId}`],
              citations: [actionCite, { componentId: ip.componentId, sourcePath: ip.sourcePath }],
              confidence: m.confidence,
            }));
            const inside = await this.traceIp(ip, facts, 0);
            raw.push(...inside);
            const survives = inside.some((o) => branchTruth(evaluateConditions(o.conditions, bindings)) !== 'false');
            if (!survives && mapped.some((m) => m.specific)) {
              // The answer reaches the IP but no step reads it. Name what the
              // steps that run for THIS call expect and do not receive — the
              // usual cause is a payload key renamed on one side only.
              const expects = missingInputs(ip, action, SaveTracer.constantsOf(action), mapped.map((m) => m.path));
              const specific = mapped.some((m) => m.specific);
              for (const m of mapped.filter((x) => x.specific)) {
                raw.push({
                  kind: 'drop',
                  place: { componentId: ip.componentId, sourcePath: ip.sourcePath, elementPath: null, line: null },
                  reason:
                    `reaches ${ip.componentId} as ${m.path.join(':')}, but no step of it reads that key` +
                    (expects.length > 0 ? `; the steps that run for this call read ${expects.join(', ')}, which it does not send` : ''),
                  dataMapper: null,
                  inputKey: m.path.join(':'),
                  nearMiss: [],
                  specific,
                  conditions: showConds,
                  silent: [],
                  hops: [m.hop, `→ ${ip.componentId}`],
                  citations: [actionCite, { componentId: ip.componentId, sourcePath: ip.sourcePath }],
                  confidence: m.confidence,
                });
              }
            }
          }
        }
      } else if (action.kind === 'remoteAction') {
        for (const m of mapped) {
          raw.push({
            kind: 'unknown',
            place: this.#place(action.element),
            reason: `sent to Apex ${action.remoteClass ?? '?'}.${action.remoteMethod ?? '?'} from the screen, which is not analysed`,
            specific: m.specific,
            conditions: showConds,
            silent: [],
            hops: [m.hop],
            citations: [actionCite],
            confidence: 'inferred',
          });
        }
      } else if (action.kind === 'dataMapperAction' && action.bundle !== null) {
        const mm = await this.mapperModel(action.bundle);
        if (mm !== null && mm.kind === 'Load') {
          for (const m of mapped) {
            for (const hit of mapperHits(mm, m.path).filter((h) => !h.item.jsonOutput)) {
              raw.push(await this.#write(hit.item.item.outputObjectName ?? '?', hit.item.item.outputFieldName ?? '?', 'load', this.#mapperPlace(mm, hit.item.item.index, hit.item.item.line), {
                specific: true,
                conditions: showConds,
                silent: [],
                hops: [m.hop, `→ ${mm.componentId} item ${hit.item.item.index}`],
                citations: [actionCite, this.#mapperCite(mm, hit.item.item.index, hit.item.item.line)],
                confidence: m.confidence,
              }));
            }
          }
        }
      }
      for (const o of raw) {
        const evaluated = evaluateConditions(o.conditions, bindings);
        results.push({ ...o, evaluated, truth: branchTruth(evaluated) });
      }
    }
    return results;
  }

  /**
   * Trace facts through one IP. Returns the outcomes (conditions still
   * pending). With `collectResponses`, a value reaching a Response Action (its
   * `sendJSONPath` subtree, or an `additionalOutput` entry that moves it) is
   * reported as a `returned` outcome — the prefill direction.
   */
  async traceIp(
    ip: IpModel,
    input: readonly Fact[],
    depth: number,
    opts: { readonly collectResponses?: boolean } = {},
  ): Promise<TraceOutcome[]> {
    const facts: Fact[] = [...input];
    const outcomes: TraceOutcome[] = [];
    for (const step of ip.steps) {
      if (step.role === 'block' || step.role === 'loop') continue;
      const live = facts.filter((f) => f.createdAt < step.order);
      for (const f of live) {
        const pending: PendingCondition[] = [
          ...f.conditions,
          ...step.conditions.map((c) => ({
            kind: 'formula' as const,
            source: `IP step ${ip.uniqueName}#${c.step}`,
            formula: c.formula,
            carry: f.trail,
          })),
        ];
        const silent = step.failOnStepError === false ? [...f.silent, `${ip.uniqueName}#${step.el.idPath}`] : f.silent;
        const stepCite = this.#stepCite(ip, step);
        const base = {
          conditions: pending,
          silent,
          citations: [...f.citations, stepCite],
        };
        const add = (path: readonly string[], hop: string, extra: Partial<Pick<Fact, 'derived' | 'specific' | 'confidence'>> = {}): void => {
          if (facts.length >= MAX_FACTS_PER_IP) return;
          facts.push({
            path,
            trail: [...f.trail, path],
            ...(f.origin === undefined ? {} : { origin: f.origin }),
            createdAt: step.order,
            specific: extra.specific ?? f.specific,
            derived: f.derived || (extra.derived ?? false),
            conditions: pending,
            silent,
            hops: [...f.hops, hop],
            citations: base.citations,
            confidence: extra.confidence === undefined ? f.confidence : weaker(f.confidence, extra.confidence),
          });
        };

        if (step.role === 'setValues') {
          for (const v of step.valueMap) {
            if (v.kind === 'move' && v.from !== null) {
              const from = omnistudio.segmentNames(v.from);
              if (omnistudio.isPrefixOf(from, f.path)) {
                add([...step.outputRoot, ...keyNames(v.key), ...f.path.slice(from.length)], `${step.el.idPath}.${v.key} = ${String(v.value)}`);
              }
            } else if (v.kind === 'derived') {
              const keep = structurePreservingSource(v);
              if (keep !== null && omnistudio.isPrefixOf(keep, f.path)) {
                add([...step.outputRoot, ...keyNames(v.key), ...f.path.slice(keep.length)], `${step.el.idPath}.${v.key} keeps its records (${String(v.value).slice(0, 80)})`, { derived: true, confidence: 'inferred' });
              } else if (v.refs.some((r) => omnistudio.isPrefixOf(omnistudio.segmentNames(r.path), f.path))) {
                add([...step.outputRoot, ...keyNames(v.key)], `${step.el.idPath}.${v.key} derives from it`, { derived: true, confidence: 'inferred' });
              }
            }
          }
          continue;
        }
        if (step.role === 'listMerge') {
          for (const list of step.mergeLists) {
            if (omnistudio.isPrefixOf(list, f.path)) add([...step.outputRoot, ...f.path.slice(list.length)], `${step.el.idPath} merges ${list.join(':')}`);
          }
          continue;
        }
        if (step.role === 'response') {
          if (opts.collectResponses === true) {
            const returned: (readonly string[])[] = [];
            if (step.sendPath !== null && step.sendPath.length > 0 && omnistudio.isPrefixOf(step.sendPath, f.path)) {
              returned.push([...(step.sendNode ?? []), ...f.path.slice(step.sendPath.length)]);
            }
            for (const e of step.additionalOutput) {
              const from = e.kind === 'move' && e.from !== null ? omnistudio.segmentNames(e.from) : structurePreservingSource(e);
              if (from === null) continue;
              if (omnistudio.isPrefixOf(from, f.path)) returned.push([...keyNames(e.key), ...f.path.slice(from.length)]);
            }
            for (const r of returned) {
              outcomes.push({
                kind: 'returned',
                place: this.#stepPlace(ip, step),
                responsePath: r,
                specific: true,
                conditions: pending,
                silent,
                hops: [...f.hops, `${step.el.idPath} returns it as ${r.join(':')}`],
                citations: base.citations,
                confidence: f.confidence,
                ...(f.origin === undefined ? {} : { origin: f.origin }),
              });
            }
          }
          continue;
        }

        for (const inp of stepInputs(step, f)) {
          const common = {
            specific: inp.specific,
            conditions: pending,
            silent,
            hops: [...f.hops, inp.hop],
            citations: base.citations,
            confidence: f.confidence,
            ...(f.origin === undefined ? {} : { origin: f.origin }),
          };
          switch (step.role) {
            case 'dataMapper': {
              const mm = step.bundle === null ? null : await this.mapperModel(step.bundle);
              if (mm === null) {
                outcomes.push({ ...common, kind: 'unknown', place: this.#stepPlace(ip, step), reason: `DataMapper ${step.bundle ?? '?'} is not in the vault (or unreadable)` });
                break;
              }
              if (mm.kind === 'Transform') {
                const hits = mapperHits(mm, inp.q);
                if (hits.length === 0) {
                  outcomes.push({
                    ...common,
                    specific: inp.specific || readsSiblings(mm, inp.q),
                    kind: 'drop',
                    place: this.#stepPlace(ip, step),
                    reason: 'no item reads this key (Transform is a whitelist)',
                    dataMapper: mm.componentId,
                    inputKey: inp.q.join(':'),
                    nearMiss: await this.#nearMissFeeds(ip, step, mm, inp.q),
                    citations: [...base.citations, { componentId: mm.componentId, sourcePath: mm.sourcePath }],
                  });
                } else {
                  for (const h of hits) {
                    const out = filterResponse(step, h.out);
                    if (out === null) continue;
                    add([...step.outputRoot, ...out], `${mm.componentId} item ${h.item.item.index}: ${h.item.item.inputFieldName ?? '?'} → ${h.item.item.outputFieldName ?? '?'}`, {
                      specific: true,
                      derived: h.via === 'formula',
                    });
                  }
                }
              } else if (mm.kind === 'Load') {
                const hits = mapperHits(mm, inp.q).filter((h) => !h.item.jsonOutput);
                if (hits.length === 0) {
                  outcomes.push({
                    ...common,
                    specific: inp.specific || readsSiblings(mm, inp.q),
                    kind: 'drop',
                    place: this.#stepPlace(ip, step),
                    reason: 'no Load item maps this key',
                    dataMapper: mm.componentId,
                    inputKey: inp.q.join(':'),
                    nearMiss: await this.#loadNearMissFeeds(mm, inp.q),
                    citations: [...base.citations, { componentId: mm.componentId, sourcePath: mm.sourcePath }],
                  });
                }
                for (const h of hits) {
                  outcomes.push(await this.#write(h.item.item.outputObjectName ?? '?', h.item.item.outputFieldName ?? '?', 'load', this.#mapperPlace(mm, h.item.item.index, h.item.item.line), {
                    ...common,
                    specific: true,
                    hops: [...common.hops, `${mm.componentId} item ${h.item.item.index}`],
                    citations: [...base.citations, this.#mapperCite(mm, h.item.item.index, h.item.item.line)],
                  }));
                }
              } else if (mm.kind === 'Extract' || mm.kind === 'Turbo Extract') {
                if (extractFilterUses(mm, inp.q).length > 0) {
                  outcomes.push({ ...common, kind: 'consumed', place: this.#stepPlace(ip, step), reason: `filters the records ${mm.componentId} reads` });
                }
              } else {
                outcomes.push({ ...common, kind: 'unknown', place: this.#stepPlace(ip, step), reason: `DataMapper ${mm.componentId} has an unrecognised type` });
              }
              break;
            }
            case 'remote': {
              const cfg = this.#world.config;
              if (matchesCallSite(cfg.loggers, step.remoteClass, step.remoteMethod)) {
                outcomes.push({ ...common, kind: 'consumed', place: this.#stepPlace(ip, step), reason: 'passed to a configured logger' });
                break;
              }
              if (cfg.completionMarkers.some((m) => 'remoteClass' in m && matchesCallSite([m], step.remoteClass, step.remoteMethod))) {
                outcomes.push({ ...common, kind: 'consumed', place: this.#stepPlace(ip, step), reason: 'passed to a configured completion marker' });
                break;
              }
              const configured = cfg.genericUpsertAdapters.find((a) => matchesCallSite([a], step.remoteClass, step.remoteMethod));
              const adapter = configured !== undefined
                ? (() => {
                    const rec = step.additional.find((e) => e.key.trim() === configured.recordsParam.trim() && e.kind === 'move');
                    const obj = step.additional.find((e) => e.key.trim() === configured.objectParam.trim() && e.kind === 'literal');
                    return rec !== undefined && obj !== undefined ? { recordsKey: rec.key, object: String(obj.value).trim(), confidence: 'parsed' as OmniConfidence } : null;
                  })()
                : (() => {
                    const h = heuristicAdapter(step);
                    return h === null ? null : { ...h, confidence: 'inferred' as OmniConfidence };
                  })();
              if (adapter !== null && inp.q[0] === adapter.recordsKey) {
                const rest = inp.q.slice(1);
                if (rest.length === 1) {
                  outcomes.push(await this.#write(adapter.object, rest[0] as string, 'adapter', this.#stepPlace(ip, step), {
                    ...common,
                    specific: true,
                    hops: [...common.hops, `${step.remoteClass ?? '?'}.${step.remoteMethod ?? '?'} writes each row key as a ${adapter.object} field (${configured !== undefined ? 'configured adapter' : 'heuristic adapter'})`],
                    confidence: weaker(f.confidence, adapter.confidence),
                  }));
                } else {
                  outcomes.push({ ...common, kind: 'unknown', place: this.#stepPlace(ip, step), reason: `reaches the generic upsert ${step.remoteClass ?? '?'}.${step.remoteMethod ?? '?'} nested inside a record row` });
                }
                break;
              }
              outcomes.push({
                ...common,
                kind: 'unknown',
                place: this.#stepPlace(ip, step),
                reason: `enters Apex ${step.remoteClass ?? '?'}.${step.remoteMethod ?? '?'}, which is not analysed`,
              });
              break;
            }
            case 'rest':
              outcomes.push({ ...common, kind: 'unknown', place: this.#stepPlace(ip, step), reason: 'sent to an external REST endpoint' });
              break;
            case 'nestedIp': {
              const t = step.nestedIpKey === null ? null : this.#world.resolveIpKey(step.nestedIpKey);
              if (t === null || t.node === null || depth >= MAX_IP_DEPTH) {
                outcomes.push({ ...common, kind: 'unknown', place: this.#stepPlace(ip, step), reason: t?.node === null ? `calls Integration Procedure ${step.nestedIpKey ?? '?'}, which is not in the vault` : 'nested Integration Procedure depth limit reached' });
                break;
              }
              const nested = await this.ipModel(t.node.id);
              if (nested === null) {
                outcomes.push({ ...common, kind: 'unknown', place: this.#stepPlace(ip, step), reason: `${t.node.id} is unreadable` });
                break;
              }
              outcomes.push(
                ...(await this.traceIp(
                  nested,
                  [{ path: inp.q, trail: [inp.q], createdAt: -1, specific: inp.specific, derived: f.derived, conditions: pending, silent, hops: [...common.hops, `→ ${nested.componentId}`], citations: [...base.citations, { componentId: nested.componentId, sourcePath: nested.sourcePath }], confidence: f.confidence }],
                  depth + 1,
                  opts,
                )),
              );
              break;
            }
            case 'delete':
              outcomes.push({ ...common, kind: 'consumed', place: this.#stepPlace(ip, step), reason: 'read by a Delete Action' });
              break;
            default:
              outcomes.push({ ...common, kind: 'unknown', place: this.#stepPlace(ip, step), reason: `read by a ${step.el.type}, which is not analysed` });
              break;
          }
        }
      }
    }
    return outcomes;
  }

  /** Follow an item output forward to the fields it eventually writes (for near-miss `feeds`). */
  async feedsFrom(ip: IpModel, step: IpStep, path: readonly string[]): Promise<readonly string[]> {
    const fact: Fact = { path, trail: [path], createdAt: step.order, specific: true, derived: false, conditions: [], silent: [], hops: [], citations: [], confidence: 'parsed' };
    const outs = await this.traceIp(ip, [fact], 0);
    const fields = new Set<string>();
    for (const o of outs) if (o.kind === 'write') fields.add(o.fieldId ?? `CustomField:${o.object}.${o.field}`);
    return [...fields].sort();
  }

  async #nearMissFeeds(ip: IpModel, step: IpStep, mm: MapperModel, q: readonly string[]): Promise<NearMissFeed[]> {
    const out: NearMissFeed[] = [];
    for (const n of nearMissesFor(mm, q, this.#world)) {
      const item = mm.items.find((i) => i.input !== null && i.input.join(':') === n.candidate);
      let feeds: readonly string[] = [];
      if (item?.output != null) {
        const outPath = filterResponse(step, item.output);
        if (outPath !== null) feeds = await this.feedsFrom(ip, step, [...step.outputRoot, ...outPath]);
      }
      out.push({ key: n.candidate, rule: n.rule, feeds });
    }
    return out;
  }

  /** A Load near-miss feeds exactly the fields its own item writes. */
  async #loadNearMissFeeds(mm: MapperModel, q: readonly string[]): Promise<NearMissFeed[]> {
    const out: NearMissFeed[] = [];
    for (const n of nearMissesFor(mm, q, this.#world)) {
      const fields = new Set<string>();
      for (const i of mm.items) {
        if (i.input === null || i.jsonOutput || i.input.join(':') !== n.candidate) continue;
        const object = i.item.outputObjectName?.trim() ?? '';
        const field = i.item.outputFieldName?.trim() ?? '';
        if (object === '' || field === '') continue;
        const st = await this.#world.fieldStatus(object, field);
        fields.add(st.fieldId ?? `CustomField:${object}.${field}`);
      }
      out.push({ key: n.candidate, rule: n.rule, feeds: [...fields].sort() });
    }
    return out;
  }

  async #write(
    object: string,
    field: string,
    mechanism: 'load' | 'adapter',
    place: TracePlace,
    base: Omit<OutcomeBase, never>,
  ): Promise<TraceOutcome> {
    const st = await this.#world.fieldStatus(object, field);
    return {
      ...base,
      kind: 'write',
      object: object.trim(),
      field: field.trim(),
      fieldId: st.fieldId,
      fieldStatus: st.status,
      mechanism,
      place,
      citations: st.fieldId === null ? base.citations : [...base.citations, { componentId: st.fieldId, sourcePath: '' }],
    };
  }

  #unreadable(action: ScriptAction, id: string, conds: readonly PendingCondition[], specific: boolean): TraceOutcome {
    return { kind: 'unknown', place: this.#place(action.element), reason: `${id} is unreadable`, specific, conditions: conds, silent: [], hops: [], citations: [this.#cite(action.element)], confidence: 'inferred' };
  }

  #place(e: ScriptElement): TracePlace {
    return { componentId: this.#script.componentId, sourcePath: this.#script.sourcePath, elementPath: e.el.idPath, line: e.el.line };
  }

  #cite(e: ScriptElement): OmniCitation {
    return { componentId: this.#script.componentId, sourcePath: this.#script.sourcePath, elementPath: e.el.idPath, ...(e.el.line === null ? {} : { line: e.el.line }) };
  }

  #stepPlace(ip: IpModel, step: IpStep): TracePlace {
    return { componentId: ip.componentId, sourcePath: ip.sourcePath, elementPath: step.el.idPath, line: step.el.line };
  }

  #stepCite(ip: IpModel, step: IpStep): OmniCitation {
    return { componentId: ip.componentId, sourcePath: ip.sourcePath, elementPath: step.el.idPath, ...(step.el.line === null ? {} : { line: step.el.line }) };
  }

  #mapperPlace(mm: MapperModel, index: number, line: number | null): TracePlace {
    return { componentId: mm.componentId, sourcePath: mm.sourcePath, elementPath: `item[${index}]`, line };
  }

  #mapperCite(mm: MapperModel, index: number, line: number | null): OmniCitation {
    return { componentId: mm.componentId, sourcePath: mm.sourcePath, elementPath: `item[${index}]`, ...(line === null ? {} : { line }) };
  }
}

/**
 * Root keys the IP's steps read, for steps whose conditions do not evaluate
 * FALSE with this call's constants, that the call does not send and no
 * earlier step produces. Deterministic (sorted).
 */
const missingInputs = (
  ip: IpModel,
  action: ScriptAction,
  constants: ReadonlyMap<string, unknown>,
  sentPaths: readonly (readonly string[])[],
): string[] => {
  const sent = new Set<string>(sentPaths.map((p) => p[0] ?? ''));
  for (const e of action.entries) sent.add(keyNames(e.key)[0] ?? e.key);
  if (action.base.kind === 'all' && action.sendNode === null) return [];
  const produced = new Set<string>();
  for (const st of ip.steps) produced.add(st.outputRoot[0] ?? st.el.name);
  const wanted = new Set<string>();
  for (const st of ip.steps) {
    const truth = omnistudio.triAnd(
      st.conditions.map((c) =>
        omnistudio.evaluateFormula(c.formula, (raw) => {
          const k = keyNames(raw).join(':');
          return constants.has(k) ? { known: true, value: constants.get(k) } : { known: false };
        }).truth,
      ),
    );
    if (truth === 'false') continue;
    const reads: (readonly string[])[] = [];
    for (const e of [...st.additional, ...st.valueMap]) {
      for (const r of e.refs) reads.push(omnistudio.segmentNames(r.path));
    }
    for (const c of st.conditions) for (const r of omnistudio.scanPercentRefs(c.formula).refs) reads.push(omnistudio.segmentNames(r.path));
    for (const r of reads) {
      const root = r[0];
      if (root === undefined || sent.has(root) || produced.has(root)) continue;
      wanted.add(root);
    }
  }
  return [...wanted].sort();
};

/** How a fact enters a step's input. */
const stepInputs = (
  step: IpStep,
  f: Fact,
): readonly { readonly q: readonly string[]; readonly specific: boolean; readonly hop: string }[] => {
  const out: { q: readonly string[]; specific: boolean; hop: string }[] = [];
  for (const e of step.additional) {
    if (e.kind === 'move' && e.from !== null) {
      const from = omnistudio.segmentNames(e.from);
      if (omnistudio.isPrefixOf(from, f.path)) {
        out.push({ q: [...keyNames(e.key), ...f.path.slice(from.length)], specific: true, hop: `${step.el.idPath}.additionalInput.${e.key} = ${String(e.value)}` });
      }
    } else if (e.kind === 'derived') {
      const keep = structurePreservingSource(e);
      if (keep !== null && omnistudio.isPrefixOf(keep, f.path)) {
        out.push({ q: [...keyNames(e.key), ...f.path.slice(keep.length)], specific: true, hop: `${step.el.idPath}.additionalInput.${e.key} keeps its records` });
      } else if (e.refs.some((r) => omnistudio.isPrefixOf(omnistudio.segmentNames(r.path), f.path))) {
        out.push({ q: keyNames(e.key), specific: true, hop: `${step.el.idPath}.additionalInput.${e.key} derives from it` });
      }
    }
  }
  if (!step.onlyAdditional) {
    const node = step.sendNode ?? [];
    if (step.sendPath !== null) {
      if (omnistudio.isPrefixOf(step.sendPath, f.path)) {
        out.push({ q: [...node, ...f.path.slice(step.sendPath.length)], specific: step.sendPath.length > 0 && f.specific, hop: `${step.el.idPath} sendJSONPath ${step.sendPath.join(':')}` });
      }
    } else {
      out.push({ q: [...node, ...f.path], specific: false, hop: `${step.el.idPath} receives the whole data JSON` });
    }
  }
  return out;
};

/** Keep only the `responseJSONPath` subtree of a step output, re-rooted. */
const filterResponse = (step: IpStep, out: readonly string[]): readonly string[] | null => {
  if (step.responsePath === null) return out;
  return omnistudio.isPrefixOf(step.responsePath, out) ? out.slice(step.responsePath.length) : null;
};

/** True when the mapper reads OTHER keys of the container `q` sits in (a drop there is deliberate-looking, not incidental). */
const readsSiblings = (mm: MapperModel, q: readonly string[]): boolean => {
  if (q.length < 2) return false;
  const parent = q.slice(0, -1);
  return mm.items.some((i) => i.input !== null && i.input.length === q.length && omnistudio.isPrefixOf(parent, i.input));
};

const nearMissesFor = (mm: MapperModel, q: readonly string[], world: OmniWorld): readonly omnistudio.NearMiss[] =>
  omnistudio.nearMisses(q.join(':'), itemInputForms(mm), { prefixVariants: world.config.prefixVariants });
