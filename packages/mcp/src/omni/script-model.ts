import { omnistudio } from '@sf-intelligence/extractors';

import { classifyPayload, type PayloadEntry } from './payload.js';
import type { OmniConfidence } from './types.js';
import type { LoadedProcess } from './world.js';

/**
 * The OmniScript model: every element with its role, the data-JSON path its
 * value lives at, its visibility chain, every key the script can hold (who
 * PRODUCES it) and every server call it makes (what PAYLOAD it sends).
 *
 * Data-JSON semantics (the runtime contract the whole engine rests on):
 *   - an element's value is stored under its NAME, nested by its container
 *     ancestors (Step, Block, Edit Block, Type Ahead Block):
 *     `Step:Block:Element`;
 *   - an Edit Block, and a Block with `repeat: true`, hold one row per entry;
 *     keys inside are per-row (`inRepeat`);
 *   - a Set Values element writes each `elementValueMap` key at that path
 *     (root-relative);
 *   - a Custom LWC may write any key — undeclared, so `inferred` / unknown.
 */

/** One element in its script context. */
export interface ScriptElement {
  readonly el: omnistudio.OmniTreeElement;
  readonly role: omnistudio.ElementRole;
  readonly parent: ScriptElement | null;
  /** Data path: container ancestors' names + own name. */
  readonly dataPath: readonly string[];
  /** Nearest repeating container, ancestor-or-self. */
  readonly repeatingContainer: ScriptElement | null;
  /** Nearest Edit Block, ancestor-or-self. */
  readonly editBlock: ScriptElement | null;
  /** Show rules of the ancestors and of the element itself, outermost first. */
  readonly visibility: readonly omnistudio.ShowRule[];
}

/** Who can put a value at a data path. */
export type ProducerKind = 'element' | 'container' | 'setValues' | 'customLwc' | 'runtime' | 'launch' | 'response';

/** One producer of a data key. */
export interface Producer {
  /** Names, row markers stripped. */
  readonly path: readonly string[];
  readonly kind: ProducerKind;
  readonly element: ScriptElement | null;
  readonly confidence: OmniConfidence;
  /** For `response`: the action whose response merges the key in. */
  readonly via?: string;
}

/** What one server call sends. */
export type BaseSend =
  | { readonly kind: 'none' }
  | { readonly kind: 'all' }
  | { readonly kind: 'row'; readonly container: ScriptElement }
  | { readonly kind: 'path'; readonly path: readonly string[] };

/** The kind of a server call made by the script. */
export type ScriptActionKind =
  | 'ipAction'
  | 'remoteAction'
  | 'dataMapperAction'
  | 'editBlockSaveKey'
  | 'editBlockDeleteKey';

/** One server call the script makes. */
export interface ScriptAction {
  readonly element: ScriptElement;
  readonly kind: ScriptActionKind;
  /** IP key (`Type_SubType`) for IP calls. */
  readonly ipKey: string | null;
  /** DataMapper bundle for DataRaptor actions. */
  readonly bundle: string | null;
  readonly remoteClass: string | null;
  readonly remoteMethod: string | null;
  /** `New` / `Edit` / `Delete` for an Edit Block child action. */
  readonly editBlockButton: 'New' | 'Edit' | 'Delete' | null;
  /** The base data sent before the extra payload is applied. */
  readonly base: BaseSend;
  /** `sendJSONNode`: the node the base is wrapped under in the callee. */
  readonly sendNode: readonly string[] | null;
  readonly entries: readonly PayloadEntry[];
  /** Which config property the entries came from. */
  readonly payloadProp: string;
  /** Visibility chain of the action (its own show rule and its ancestors'). */
  readonly visibility: readonly omnistudio.ShowRule[];
  /** Where the response merges: `responseJSONNode` (names) or null for the root. */
  readonly responseNode: readonly string[] | null;
  readonly responsePath: readonly string[] | null;
  /** How certain the base-send semantics are. */
  readonly baseConfidence: OmniConfidence;
}

/** How a reference resolved inside the script. */
export interface ResolvedRef {
  readonly how: 'exact' | 'relative' | 'suffix' | 'none';
  readonly producers: readonly Producer[];
}

/** The built model. */
export interface ScriptModel {
  readonly loaded: LoadedProcess;
  readonly componentId: string;
  readonly uniqueName: string;
  readonly sourcePath: string;
  readonly elements: readonly ScriptElement[];
  readonly byIdPath: ReadonlyMap<string, ScriptElement>;
  readonly producers: readonly Producer[];
  readonly actions: readonly ScriptAction[];
  /** Custom LWCs with no configured outputs, embedded scripts — they may write keys nobody declared. */
  readonly undeclaredWriters: readonly ScriptElement[];
  /** Element paths of actions whose response keys are fully modeled. */
  readonly responseModeled: ReadonlySet<string>;
  resolveRef(path: readonly string[], context: ScriptElement | null): ResolvedRef;
  producersAt(path: readonly string[]): readonly Producer[];
}

/**
 * Runtime keys an OmniScript holds without any element declaring them.
 * `inferred`: a published runtime convention, not metadata.
 */
export const OMNISCRIPT_RUNTIME_KEYS: readonly string[] = [
  'ContextId',
  'timeStamp',
  'userCurrencyCode',
  'userId',
  'userName',
  'userProfile',
  'userTimeZone',
];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

/** A path-valued property as names; `%Step:Node%` and `Step:Node` name the same path. */
const pathNames = (raw: string | null): readonly string[] | null => {
  if (raw === null) return null;
  const t = raw.trim();
  const inner = /^%([^%]+)%$/.exec(t)?.[1] ?? t;
  return omnistudio.segmentNames(omnistudio.parseKeyPath(inner));
};

const showOf = (el: omnistudio.OmniTreeElement): omnistudio.ShowRule | null =>
  omnistudio.parseShowRule(el.config?.['show']);

/** Options for {@link buildScriptModel}. */
export interface ScriptModelOptions {
  readonly customLwcOutputs?: Readonly<Record<string, readonly string[]>>;
  readonly launchParameters?: readonly string[];
  /** Producers learned elsewhere (IP responses merged into the script). */
  readonly extraProducers?: readonly Producer[];
  /** Element paths of actions whose responses are fully modeled. */
  readonly modeledResponseActions?: ReadonlySet<string>;
}

/** Build the model of one loaded OmniScript. */
export const buildScriptModel = (
  loaded: LoadedProcess,
  options: ScriptModelOptions = {},
): ScriptModel => {
  const doc = loaded.doc;
  const uniqueName = doc.header.uniqueName ?? loaded.node.apiName;
  const elements: ScriptElement[] = [];
  const byIdPath = new Map<string, ScriptElement>();

  const visit = (el: omnistudio.OmniTreeElement, parent: ScriptElement | null): void => {
    const role = omnistudio.elementRole(el.canonicalType);
    const parentData = parent === null ? [] : parent.role === 'container' ? parent.dataPath : parent.dataPath.slice(0, -1);
    const dataPath = [...parentData, el.name];
    const isRepeat = role === 'container' && omnistudio.isRepeating(el);
    const own = showOf(el);
    // A repeating container / Edit Block is its own nearest one; everything
    // else inherits the parent's (a parent that is one points at itself).
    const self = {
      el,
      role,
      parent,
      dataPath,
      repeatingContainer: parent?.repeatingContainer ?? null,
      editBlock: parent?.editBlock ?? null,
      visibility: own === null ? parent?.visibility ?? [] : [...(parent?.visibility ?? []), own],
    } as { -readonly [K in keyof ScriptElement]: ScriptElement[K] };
    if (isRepeat) self.repeatingContainer = self;
    if (el.canonicalType === 'Edit Block') self.editBlock = self;
    elements.push(self);
    byIdPath.set(el.idPath, self);
    for (const c of el.children) visit(c, self);
  };
  for (const r of doc.roots) visit(r, null);

  // ---- producers --------------------------------------------------------
  const producers: Producer[] = [];
  const undeclaredWriters: ScriptElement[] = [];
  for (const e of elements) {
    switch (e.role) {
      case 'container':
        producers.push({ path: e.dataPath, kind: 'container', element: e, confidence: 'parsed' });
        break;
      case 'input':
      case 'formula':
        producers.push({ path: e.dataPath, kind: 'element', element: e, confidence: 'parsed' });
        break;
      case 'setValues': {
        for (const entry of classifyPayload(e.el.config?.['elementValueMap'])) {
          const names = omnistudio.segmentNames(omnistudio.parseKeyPath(entry.key));
          producers.push({ path: names, kind: 'setValues', element: e, confidence: 'parsed' });
        }
        break;
      }
      case 'customLwc': {
        producers.push({ path: e.dataPath, kind: 'customLwc', element: e, confidence: 'inferred' });
        const lwcName = str(e.el.config?.['lwcName']);
        const declared = lwcName === null ? undefined : options.customLwcOutputs?.[lwcName];
        if (declared === undefined) undeclaredWriters.push(e);
        else for (const k of declared) producers.push({ path: omnistudio.segmentNames(omnistudio.parseKeyPath(k)), kind: 'customLwc', element: e, confidence: 'declared' });
        break;
      }
      case 'embedded':
        undeclaredWriters.push(e);
        break;
      default:
        break;
    }
  }
  for (const k of OMNISCRIPT_RUNTIME_KEYS) producers.push({ path: [k], kind: 'runtime', element: null, confidence: 'inferred' });
  for (const k of options.launchParameters ?? []) {
    producers.push({ path: omnistudio.segmentNames(omnistudio.parseKeyPath(k)), kind: 'launch', element: null, confidence: 'declared' });
  }
  for (const p of options.extraProducers ?? []) producers.push(p);

  const index = new Map<string, Producer[]>();
  const addToIndex = (p: Producer): void => {
    const k = p.path.join(':');
    const bucket = index.get(k);
    if (bucket === undefined) index.set(k, [p]);
    else bucket.push(p);
  };
  for (const p of producers) addToIndex(p);

  const producersAt = (path: readonly string[]): readonly Producer[] => index.get(path.join(':')) ?? [];

  const containerChain = (context: ScriptElement | null): ScriptElement[] => {
    const out: ScriptElement[] = [];
    let c = context;
    while (c !== null) {
      if (c.role === 'container') out.push(c);
      c = c.parent;
    }
    return out;
  };

  const resolveRef = (names: readonly string[], context: ScriptElement | null): ResolvedRef => {
    if (names.length === 0) return { how: 'none', producers: [] };
    const exact = producersAt(names);
    if (exact.length > 0) return { how: 'exact', producers: exact };
    for (const c of containerChain(context)) {
      const rel = producersAt([...c.dataPath, ...names]);
      if (rel.length > 0) return { how: 'relative', producers: rel };
    }
    const suffix = producers.filter((p) => omnistudio.isSuffixOf(names, p.path));
    if (suffix.length > 0) return { how: 'suffix', producers: suffix };
    return { how: 'none', producers: [] };
  };

  // ---- actions ------------------------------------------------------------
  const actions: ScriptAction[] = [];
  for (const e of elements) {
    const cfg = e.el.config;
    if (cfg === null) continue;
    const responseNode = pathNames(str(cfg['responseJSONNode']));
    const responsePath = pathNames(str(cfg['responseJSONPath']));
    const sendNode = pathNames(str(cfg['sendJSONNode']));
    const sendPath = pathNames(str(cfg['sendJSONPath']));
    const button = e.parent !== null && e.parent.el.canonicalType === 'Edit Block'
      ? omnistudio.editBlockActionKind(e.parent.el.name, e.el.name)
      : null;
    const baseFor = (onlyExtra: boolean): { base: BaseSend; confidence: OmniConfidence } => {
      if (onlyExtra) return { base: { kind: 'none' }, confidence: 'parsed' };
      if (sendPath !== null) return { base: { kind: 'path', path: sendPath }, confidence: 'parsed' };
      if (button !== null && e.parent !== null) {
        // An Edit Block's -New / -Edit / -Delete action sends the card's row.
        return { base: { kind: 'row', container: e.parent }, confidence: 'inferred' };
      }
      return { base: { kind: 'all' }, confidence: 'parsed' };
    };
    const onlyExtra = cfg['sendOnlyExtraPayload'] === true;

    if (e.el.canonicalType === 'Integration Procedure Action' || (e.role === 'action' && str(cfg['integrationProcedureKey']) !== null)) {
      const key = str(cfg['integrationProcedureKey']);
      if (key !== null) {
        const b = baseFor(onlyExtra);
        actions.push({
          element: e,
          kind: 'ipAction',
          ipKey: key.trim(),
          bundle: null,
          remoteClass: null,
          remoteMethod: null,
          editBlockButton: button,
          base: b.base,
          sendNode,
          entries: classifyPayload(cfg['extraPayload']),
          payloadProp: 'extraPayload',
          visibility: e.visibility,
          responseNode,
          responsePath,
          baseConfidence: b.confidence,
        });
        continue;
      }
    }
    if (e.el.canonicalType === 'Remote Action') {
      const b = baseFor(onlyExtra);
      const remoteClass = str(cfg['remoteClass']);
      const remoteMethod = str(cfg['remoteMethod']);
      // The managed runtime's IntegrationProcedureService runs the IP its
      // method names — an IP call the trace follows, not Apex.
      const service = omnistudio.runtimeServiceCall(omnistudio.apexRemoteTarget(remoteClass), remoteMethod);
      actions.push({
        element: e,
        kind: service === null ? 'remoteAction' : 'ipAction',
        ipKey: service?.key ?? null,
        bundle: null,
        remoteClass,
        remoteMethod,
        editBlockButton: button,
        base: b.base,
        sendNode,
        entries: classifyPayload(cfg['extraPayload']),
        payloadProp: 'extraPayload',
        visibility: e.visibility,
        responseNode,
        responsePath,
        baseConfidence: b.confidence,
      });
      continue;
    }
    if (/^DataRaptor .*Action$/.test(e.el.canonicalType) && str(cfg['bundle']) !== null) {
      const b = baseFor(false);
      actions.push({
        element: e,
        kind: 'dataMapperAction',
        ipKey: null,
        bundle: (str(cfg['bundle']) as string).trim(),
        remoteClass: null,
        remoteMethod: null,
        editBlockButton: button,
        base: b.base,
        sendNode,
        entries: [],
        payloadProp: 'dataRaptor Input Parameters',
        visibility: e.visibility,
        responseNode,
        responsePath,
        baseConfidence: b.confidence,
      });
      continue;
    }
    if (e.el.canonicalType === 'Edit Block') {
      for (const [prop, payloadProp, kind] of [
        ['saveIPKey', 'saveIPExtraPayload', 'editBlockSaveKey'],
        ['deleteIPKey', 'deleteIPExtraPayload', 'editBlockDeleteKey'],
      ] as const) {
        const key = str(cfg[prop]);
        if (key === null) continue;
        actions.push({
          element: e,
          kind,
          ipKey: key.trim(),
          bundle: null,
          remoteClass: null,
          remoteMethod: null,
          editBlockButton: null,
          // Only the declared extra payload is certain to be sent.
          base: { kind: 'none' },
          sendNode: null,
          entries: classifyPayload(cfg[payloadProp]),
          payloadProp,
          visibility: e.visibility,
          responseNode: null,
          responsePath: null,
          baseConfidence: 'inferred',
        });
      }
    }
  }

  return {
    loaded,
    componentId: loaded.node.id,
    uniqueName,
    sourcePath: loaded.node.sourcePath,
    elements,
    byIdPath,
    producers,
    actions,
    undeclaredWriters,
    responseModeled: options.modeledResponseActions ?? new Set<string>(),
    resolveRef,
    producersAt,
  };
};
