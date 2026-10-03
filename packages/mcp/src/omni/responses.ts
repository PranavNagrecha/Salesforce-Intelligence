import { omnistudio } from '@sf-intelligence/extractors';

import type { IpModel, IpStep } from './ip-model.js';
import { buildIpModel } from './ip-model.js';
import { buildMapperModel } from './mapper-model.js';
import {
  buildScriptModel,
  type Producer,
  type ScriptAction,
  type ScriptModel,
} from './script-model.js';
import type { LoadedProcess, OmniWorld } from './world.js';

/**
 * What an Integration Procedure RETURNS to its caller, as data-key paths —
 * the keys a screen action's response merges into the screen's data JSON
 * (at `responseJSONNode`, or the root). Prefill, success flags and error
 * messages all arrive this way.
 *
 * Modeled from the IP's Response Action:
 *   - `additionalOutput` keys are returned as written;
 *   - `sendJSONPath` returns the subtree at that path — known when it is the
 *     output of a DataMapper step (its items' output paths) or a Set Values
 *     step (its keys); otherwise that part is unmodeled;
 *   - `returnOnlyAdditionalOutput` drops everything else;
 *   - `returnFullDataJSON`, or no Response Action at all, returns the whole
 *     data JSON — unmodeled.
 * `complete` is true only when every returned part is modeled.
 */

/** One returned key with where it comes from. */
export interface ReturnedKey {
  readonly path: readonly string[];
  /** The IP step that produces it (Response Action entry, DataMapper, Set Values). */
  readonly source: string;
  /** For DataMapper-sourced keys: the item that maps it, and the field an Extract reads. */
  readonly mapperItem?: string;
  readonly readsField?: string;
}

/** The modeled response of one IP. */
export interface IpResponse {
  readonly ipId: string;
  readonly keys: readonly ReturnedKey[];
  readonly complete: boolean;
  readonly unmodeled: readonly string[];
}

const names = (raw: string): readonly string[] => omnistudio.segmentNames(omnistudio.parseKeyPath(raw));

/** Keys a step leaves under its output root, when modelable. */
const stepOutputKeys = async (
  world: OmniWorld,
  ip: IpModel,
  step: IpStep,
): Promise<{ keys: ReturnedKey[]; complete: boolean }> => {
  if (step.role === 'setValues') {
    return {
      keys: step.valueMap.map((v) => ({ path: names(v.key), source: `${ip.uniqueName}#${step.el.idPath}` })),
      complete: true,
    };
  }
  if (step.role === 'dataMapper' && step.bundle !== null) {
    const r = world.resolveBundle(step.bundle);
    if (r.node === null) return { keys: [], complete: false };
    const loaded = await world.loadMapper(r.node);
    if (!loaded.ok) return { keys: [], complete: false };
    const mm = buildMapperModel(loaded.value);
    if (mm.kind === 'Load') return { keys: [], complete: false };
    const keys: ReturnedKey[] = [];
    for (const it of mm.items) {
      if (it.output === null || !it.jsonOutput) continue;
      // An Extract step row's output is its alias (an intermediate), not a returned key.
      if (it.item.inputObjectName !== null) continue;
      let readsField: string | undefined;
      if ((mm.kind === 'Extract' || mm.kind === 'Turbo Extract') && it.input !== null && it.input.length >= 2) {
        const object = mm.aliases.get(it.input[0] as string);
        if (object !== undefined) readsField = `CustomField:${object}.${it.input.slice(1).join('.')}`;
      }
      keys.push({
        path: it.output,
        source: `${ip.uniqueName}#${step.el.idPath}`,
        mapperItem: `DataMapperItem:${mm.uniqueName}#${it.item.index}`,
        ...(readsField === undefined ? {} : { readsField }),
      });
    }
    return { keys, complete: true };
  }
  return { keys: [], complete: false };
};

/** Model what `ip` returns. */
export const modelIpResponse = async (world: OmniWorld, ip: IpModel): Promise<IpResponse> => {
  const responses = ip.steps.filter((s) => s.role === 'response');
  if (responses.length === 0) {
    return { ipId: ip.componentId, keys: [], complete: false, unmodeled: ['no Response Action: the whole data JSON is returned'] };
  }
  const keys: ReturnedKey[] = [];
  const unmodeled: string[] = [];
  for (const r of responses) {
    for (const e of r.additionalOutput) keys.push({ path: names(e.key), source: `${ip.uniqueName}#${r.el.idPath}.additionalOutput` });
    if (r.returnOnlyAdditionalOutput) continue;
    if (r.returnFullDataJSON) {
      unmodeled.push(`${r.el.idPath} returns the full data JSON`);
      continue;
    }
    if (r.sendPath !== null && r.sendPath.length > 0) {
      const root = r.sendPath[0] as string;
      const producer = ip.steps.find((s) => (s.outputRoot[0] ?? s.el.name) === root && s.order < r.order);
      if (producer === undefined) {
        unmodeled.push(`${r.el.idPath} returns ${r.sendPath.join(':')}, which no earlier step produces`);
        continue;
      }
      const out = await stepOutputKeys(world, ip, producer);
      if (!out.complete) unmodeled.push(`${r.el.idPath} returns the output of ${producer.el.idPath} (${producer.el.type}), which is not modeled`);
      const rest = r.sendPath.slice(1);
      for (const k of out.keys) {
        const full = [...producer.outputRoot.slice(1), ...k.path];
        if (!omnistudio.isPrefixOf(rest, full)) continue;
        keys.push({ ...k, path: [...(r.sendNode ?? []), ...full.slice(rest.length)] });
      }
      continue;
    }
    if (r.additionalOutput.length === 0) unmodeled.push(`${r.el.idPath} returns its whole input`);
  }
  return { ipId: ip.componentId, keys, complete: unmodeled.length === 0, unmodeled };
};

/**
 * Producers contributed by the responses of a script's IP actions, and the
 * actions whose responses are fully modeled (they no longer write
 * undeclared keys).
 */
export const responseProducers = async (
  world: OmniWorld,
  script: ScriptModel,
): Promise<{ producers: Producer[]; modeled: Set<ScriptAction>; responses: Map<ScriptAction, IpResponse> }> => {
  const producers: Producer[] = [];
  const modeled = new Set<ScriptAction>();
  const responses = new Map<ScriptAction, IpResponse>();
  const cache = new Map<string, IpResponse | null>();
  for (const a of script.actions) {
    if (a.kind !== 'ipAction' || a.ipKey === null) continue;
    const t = world.resolveIpKey(a.ipKey);
    if (t.node === null) continue;
    let resp = cache.get(t.node.id);
    if (resp === undefined) {
      const loaded = await world.loadProcess(t.node);
      resp = loaded.ok ? await modelIpResponse(world, buildIpModel(loaded.value)) : null;
      cache.set(t.node.id, resp);
    }
    if (resp === null) continue;
    responses.set(a, resp);
    if (resp.complete) modeled.add(a);
    for (const k of resp.keys) {
      let path = k.path;
      if (a.responsePath !== null) {
        if (!omnistudio.isPrefixOf(a.responsePath, path)) continue;
        path = path.slice(a.responsePath.length);
      }
      producers.push({
        path: [...(a.responseNode ?? []), ...path],
        kind: 'response',
        element: null,
        confidence: 'parsed',
        via: a.element.el.idPath,
      });
    }
  }
  return { producers, modeled, responses };
};

/**
 * Build a script model that knows what its IP actions' responses put back on
 * the screen: response keys become producers, and an action whose response is
 * fully modeled no longer counts as a writer of undeclared keys.
 */
export const buildScriptModelWithResponses = async (
  world: OmniWorld,
  loaded: LoadedProcess,
): Promise<ScriptModel> => {
  const base = { customLwcOutputs: world.config.customLwcOutputs, launchParameters: world.config.launchParameters };
  const first = buildScriptModel(loaded, base);
  const { producers, modeled } = await responseProducers(world, first);
  return buildScriptModel(loaded, {
    ...base,
    extraProducers: producers,
    modeledResponseActions: new Set([...modeled].map((a) => a.element.el.idPath)),
  });
};
