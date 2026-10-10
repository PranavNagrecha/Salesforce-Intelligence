/**
 * SOE-TRIGGER-EFFECTS — what a handler-pattern trigger actually does on save.
 *
 * Most production triggers are one line: `Dispatcher.run(new XHandler())`. The
 * trigger's own out-edges therefore name only the dispatcher and the handler, so
 * a save-order answer built from them shows an "active trigger with unknown
 * effects". This module follows the trigger into the Apex it calls (callsApex /
 * references to an ApexClass, up to {@link HANDLER_WALK_DEPTH} hops) and:
 *
 *   1. folds the field writes reached that way into the trigger step's
 *      `actions`, each marked `via` the class that performs it;
 *   2. detects a BYPASS SWITCH — a custom metadata type or custom setting read by
 *      the trigger chain whose name (or a field read on it) looks like an on/off
 *      switch — and reports the vaulted record for this object, if any, with the
 *      flags it sets. Whether the Apex honours those flags is NOT evaluated; the
 *      response says so.
 *
 * ONE shared module so `what_happens_on_save` and `order_of_execution` cannot
 * drift. Query count is constant in fan-out: one batched edge query per hop
 * level plus at most two for bypass records.
 */

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';
import { type GraphStore, listEdgesForNodes, listNodesByIds } from '@sf-intelligence/graph';

import { familyWasExtracted } from './absence-disclosure.js';
import { isUnresolvedApexCallTarget } from './apex-receiver.js';

/** Hops followed from the trigger into Apex (trigger → dispatcher/handler → helper → …). */
export const HANDLER_WALK_DEPTH = 3;
/** Max via-handler write actions folded into one step (the byte budget trims further). */
const MAX_VIA_ACTIONS_PER_STEP = 40;
/** Max classes recorded in a step's `handlerChain`. */
const MAX_CHAIN_LISTED = 8;

/** Name fragments that mark a custom metadata type / setting / field as an on-off switch. */
const BYPASS_NAME_RE = /bypass|disabl|skip|kill_?switch|deactivat|turn_?off|switch_?off|suppress/i;

export interface SoeBypassSwitch {
  /** The switch type read by the trigger chain, e.g. `CustomObject:Trigger_Switch__mdt`. */
  readonly switchType: ComponentId;
  readonly kind: 'custom-metadata' | 'custom-setting';
  /** The Apex (or trigger) that reads it. */
  readonly readBy: ComponentId;
  /** The vaulted record that names this object, when one exists. */
  readonly recordId: ComponentId | null;
  /** Checkbox fields set TRUE on that record (bypass-named ones first). */
  readonly trueFlags: readonly string[];
  /**
   * `flags-set-not-evaluated`: TRUE flags exist but none is bypass-named (e.g.
   * per-context `Before_Insert__c`); what they switch is not evaluated.
   * `values-not-in-vault`: the record's field values were not extracted.
   */
  readonly status:
    | 'bypass-flag-set'
    | 'flags-set-not-evaluated'
    | 'record-present-no-bypass-flag'
    | 'no-record-for-object'
    | 'values-not-in-vault';
}

export interface SoeHandlerEffects {
  /** Apex classes reached from the trigger (first {@link MAX_CHAIN_LISTED}). */
  readonly handlerChain: readonly ComponentId[];
  readonly handlerChainTotal: number;
  readonly bypassSwitches?: readonly SoeBypassSwitch[];
}

interface ActionLike {
  readonly kind: string;
  readonly targetId?: ComponentId;
  readonly description: string;
  readonly via?: ComponentId;
}

interface TriggerStepLike {
  readonly componentId: ComponentId;
  readonly componentType: string;
  actions: readonly ActionLike[];
  handlerEffects?: SoeHandlerEffects;
}

/** One-line disclosure, emitted once per response that enriched a trigger step. */
export const SOE_HANDLER_EFFECTS_NOTE =
  'Trigger steps include field writes reached through the handler/dispatcher Apex the trigger calls (marked `via`, up to 3 hops). They are class-level: which trigger context (before/after, insert/update) performs each write is not resolved. bypassSwitches name a custom metadata/setting switch the chain reads and the record values for this object; whether the Apex honours them (and for which users) is not evaluated.';

const isApexClassId = (id: string): boolean => id.startsWith('ApexClass:');

/** `CustomField:Foo__mdt.Bar__c` / `CustomObject:Foo__mdt` → `Foo__mdt` (null otherwise). */
const switchTypeOf = (toId: string): string | null => {
  if (toId.startsWith('CustomObject:')) return toId.slice('CustomObject:'.length);
  if (toId.startsWith('CustomField:')) {
    const rest = toId.slice('CustomField:'.length);
    const dot = rest.indexOf('.');
    return dot > 0 ? rest.slice(0, dot) : null;
  }
  return null;
};

const fieldNameOf = (toId: string): string | null => {
  if (!toId.startsWith('CustomField:')) return null;
  const dot = toId.indexOf('.');
  return dot > 0 ? toId.slice(dot + 1) : null;
};

const normalise = (s: string): string => s.toLowerCase().replace(/__c$/, '').replace(/_/g, '');

/**
 * Does `record` name `objectApiName`? Matches the record's developer name or
 * any string value (e.g. an `Object_Name__c` column), case/underscore-insensitive.
 */
/**
 * The record's extracted field values, or `null` when the `values` family was
 * never extracted on it — "not extracted" is not "no flags" (typed absence).
 */
const asList = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const recordValues = (record: Node): readonly unknown[] | null =>
  familyWasExtracted(record.properties, 'values') ? asList(record.properties['values']) : null;

const recordNamesObject = (record: Node, objectApiName: string): boolean => {
  const target = normalise(objectApiName);
  const recordName = record.properties['recordName'];
  if (typeof recordName === 'string' && normalise(recordName) === target) return true;
  return (recordValues(record) ?? []).some(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as { value?: unknown }).value === 'string' &&
      normalise((v as { value: string }).value) === target,
  );
};

/** TRUE checkbox flags on the record; `null` when its values were not extracted. */
const trueFlagsOf = (record: Node): string[] | null => {
  const values = recordValues(record);
  if (values === null) return null;
  const flags: string[] = [];
  for (const v of values) {
    if (typeof v !== 'object' || v === null) continue;
    const { field, value } = v as { field?: unknown; value?: unknown };
    if (typeof field === 'string' && (value === true || value === 'true')) flags.push(field);
  }
  // Bypass-named flags first so a reader sees the switch before the event columns.
  return flags.sort(
    (a, b) => Number(BYPASS_NAME_RE.test(b)) - Number(BYPASS_NAME_RE.test(a)) || a.localeCompare(b),
  );
};

/**
 * Enrich every ApexTrigger step IN PLACE with the writes its handler chain
 * performs and any bypass switch it reads. Returns true when any step changed
 * (callers emit {@link SOE_HANDLER_EFFECTS_NOTE} once). A failed graph query
 * leaves the steps untouched — nothing is claimed that was not read.
 */
export const enrichTriggerStepsWithHandlerEffects = async (
  graph: GraphStore,
  steps: readonly TriggerStepLike[],
  objectApiName: string,
): Promise<boolean> => {
  const triggerSteps = steps.filter((s) => s.componentType === 'ApexTrigger');
  if (triggerSteps.length === 0) return false;
  const triggerIds = [...new Set(triggerSteps.map((s) => s.componentId))];

  // BFS from every trigger at once. `reachedBy` maps class → triggers reaching it.
  const reachedBy = new Map<ComponentId, Set<ComponentId>>();
  const chainOrder = new Map<ComponentId, ComponentId[]>(triggerIds.map((t) => [t, []]));
  const outEdges = new Map<ComponentId, readonly Edge[]>();
  let frontier: ComponentId[] = [...triggerIds];
  const owners = new Map<ComponentId, Set<ComponentId>>(triggerIds.map((t) => [t, new Set([t])]));
  for (let depth = 0; depth <= HANDLER_WALK_DEPTH && frontier.length > 0; depth += 1) {
    const r = await listEdgesForNodes(graph, frontier, { direction: 'out' });
    if (!r.ok) return false;
    const next: ComponentId[] = [];
    for (const [from, edges] of r.value) {
      outEdges.set(from, edges);
      if (depth === HANDLER_WALK_DEPTH) continue;
      const fromOwners = owners.get(from) ?? new Set<ComponentId>();
      for (const e of edges) {
        if (e.edgeType !== 'callsApex' && e.edgeType !== 'references') continue;
        if (!isApexClassId(e.toId) || triggerIds.includes(e.toId)) continue;
        // A scanner artifact (an untyped local such as `oldItems`) is not a class.
        if (isUnresolvedApexCallTarget(e.toId)) continue;
        let set = reachedBy.get(e.toId);
        const isNew = set === undefined;
        if (set === undefined) {
          set = new Set();
          reachedBy.set(e.toId, set);
        }
        for (const t of fromOwners) {
          if (!set.has(t)) {
            set.add(t);
            chainOrder.get(t)?.push(e.toId);
          }
        }
        owners.set(e.toId, set);
        if (isNew) next.push(e.toId);
      }
    }
    frontier = next;
  }

  // Bypass-switch candidates: a switch type read anywhere in a trigger's chain.
  interface Candidate {
    readonly type: string;
    readonly readBy: ComponentId;
    readonly fields: Set<string>;
  }
  const candidatesByTrigger = new Map<ComponentId, Map<string, Candidate>>();
  for (const t of triggerIds) {
    const members = [t, ...(chainOrder.get(t) ?? [])];
    const byType = new Map<string, Candidate>();
    for (const m of members) {
      for (const e of outEdges.get(m) ?? []) {
        if (e.edgeType !== 'readsFrom') continue;
        const type = switchTypeOf(e.toId);
        if (type === null || !(type.endsWith('__mdt') || type.endsWith('__c'))) continue;
        const c = byType.get(type) ?? { type, readBy: m, fields: new Set<string>() };
        const f = fieldNameOf(e.toId);
        if (f !== null) c.fields.add(f);
        byType.set(type, c);
      }
    }
    const bypassLike = new Map<string, Candidate>();
    for (const [type, c] of byType) {
      if (BYPASS_NAME_RE.test(type) || [...c.fields].some((f) => BYPASS_NAME_RE.test(f))) {
        bypassLike.set(type, c);
      }
    }
    if (bypassLike.size > 0) candidatesByTrigger.set(t, bypassLike);
  }

  // Resolve switch kinds + records in two batched queries.
  const switchTypes = [
    ...new Set([...candidatesByTrigger.values()].flatMap((m) => [...m.keys()])),
  ];
  const kindByType = new Map<string, SoeBypassSwitch['kind']>();
  const recordsByType = new Map<string, Node[]>();
  if (switchTypes.length > 0) {
    const typeNodeIds = switchTypes.map((t) => `CustomObject:${t}` as ComponentId);
    const typeNodes = await listNodesByIds(graph, typeNodeIds);
    const settingTypes = new Set<string>();
    if (typeNodes.ok) {
      for (const n of typeNodes.value) {
        if (n.properties['customSettingsType'] !== undefined) settingTypes.add(n.apiName);
      }
    }
    for (const t of switchTypes) {
      if (t.endsWith('__mdt')) kindByType.set(t, 'custom-metadata');
      else if (settingTypes.has(t)) kindByType.set(t, 'custom-setting');
    }
    // CMDT records hang off `CustomObject:<Type>` (no `__mdt`) or the suffixed id.
    const parentIds = switchTypes
      .filter((t) => t.endsWith('__mdt'))
      .flatMap((t) => [`CustomObject:${t}`, `CustomObject:${t.slice(0, -5)}`] as ComponentId[]);
    if (parentIds.length > 0) {
      const parentEdges = await listEdgesForNodes(graph, parentIds, {
        direction: 'out',
        edgeTypes: ['parentOf'],
      });
      if (parentEdges.ok) {
        const recordIds: ComponentId[] = [];
        const typeOfRecord = new Map<ComponentId, string>();
        for (const [parent, edges] of parentEdges.value) {
          const base = parent.slice('CustomObject:'.length).replace(/__mdt$/, '');
          for (const e of edges) {
            if (!e.toId.startsWith('CustomMetadataRecord:')) continue;
            recordIds.push(e.toId);
            typeOfRecord.set(e.toId, `${base}__mdt`);
          }
        }
        const recs = await listNodesByIds(graph, recordIds);
        if (recs.ok) {
          for (const n of recs.value) {
            const type = typeOfRecord.get(n.id);
            if (type === undefined) continue;
            const list = recordsByType.get(type) ?? [];
            list.push(n);
            recordsByType.set(type, list);
          }
        }
      }
    }
  }

  let changed = false;
  for (const step of triggerSteps) {
    const chain = chainOrder.get(step.componentId) ?? [];
    const existing = new Set(step.actions.map((a) => `${a.kind}|${a.targetId ?? ''}`));
    const via: ActionLike[] = [];
    for (const cls of chain) {
      for (const e of outEdges.get(cls) ?? []) {
        if (e.edgeType !== 'writesTo') continue;
        const key = `writesTo|${e.toId}`;
        if (existing.has(key)) continue;
        existing.add(key);
        via.push({ kind: 'writesTo', targetId: e.toId, description: `writesTo ${e.toId} (via ${cls})`, via: cls });
      }
    }
    const switches: SoeBypassSwitch[] = [];
    for (const c of candidatesByTrigger.get(step.componentId)?.values() ?? []) {
      const kind = kindByType.get(c.type);
      if (kind === undefined) continue; // a plain __c object read, not a switch
      if (kind === 'custom-setting') {
        switches.push({
          switchType: `CustomObject:${c.type}` as ComponentId,
          kind,
          readBy: c.readBy,
          recordId: null,
          trueFlags: [],
          status: 'values-not-in-vault',
        });
        continue;
      }
      const record = (recordsByType.get(c.type) ?? []).find((r) => recordNamesObject(r, objectApiName));
      const flags = record === undefined ? [] : trueFlagsOf(record);
      const trueFlags = flags ?? [];
      switches.push({
        switchType: `CustomObject:${c.type}` as ComponentId,
        kind,
        readBy: c.readBy,
        recordId: record?.id ?? null,
        trueFlags,
        status:
          record === undefined
            ? 'no-record-for-object'
            : flags === null
              ? 'values-not-in-vault'
              : trueFlags.some((f) => BYPASS_NAME_RE.test(f))
                ? 'bypass-flag-set'
                : trueFlags.length > 0
                  ? 'flags-set-not-evaluated'
                  : 'record-present-no-bypass-flag',
      });
    }
    if (chain.length === 0 && switches.length === 0) continue;
    changed = true;
    step.actions = [...step.actions, ...via.slice(0, MAX_VIA_ACTIONS_PER_STEP)];
    step.handlerEffects = {
      handlerChain: chain.slice(0, MAX_CHAIN_LISTED),
      handlerChainTotal: chain.length,
      ...(switches.length > 0 ? { bypassSwitches: switches } : {}),
    };
  }
  return changed;
};

/**
 * Short top-level warnings for trigger steps whose bypass record sets a
 * bypass-named flag — the case where the save order may not run the trigger at all.
 */
export const bypassWarnings = (steps: readonly TriggerStepLike[]): string[] => {
  const out = new Set<string>();
  for (const s of steps) {
    for (const b of s.handlerEffects?.bypassSwitches ?? []) {
      if (b.recordId === null) continue;
      if (b.status === 'bypass-flag-set') {
        const flags = b.trueFlags.filter((f) => BYPASS_NAME_RE.test(f));
        out.add(
          `${s.componentId} may be switched OFF: ${b.readBy} reads ${b.switchType} and ${b.recordId} sets ${flags.join(', ')} = true. Check the Apex gate before saying this trigger runs.`,
        );
      } else if (b.status === 'flags-set-not-evaluated') {
        // Per-context flags (Before_Insert__c = true) can be a bypass for that
        // context; the name alone cannot say which way they switch.
        out.add(
          `${s.componentId} may be switched off for some contexts: ${b.readBy} reads ${b.switchType} and ${b.recordId} sets ${b.trueFlags.slice(0, 5).join(', ')} = true (meaning not evaluated). Check the Apex gate.`,
        );
      }
    }
  }
  return [...out];
};
