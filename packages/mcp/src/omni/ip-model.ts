import { omnistudio } from '@sf-intelligence/extractors';

import { classifyPayload, type PayloadEntry } from './payload.js';
import type { LoadedProcess } from './world.js';

/**
 * The Integration Procedure model: every step in EXECUTION order with what it
 * reads, where its output lands, and when it runs.
 *
 * Data-flow semantics (spec §2.4):
 *   - the IP's input JSON is what the caller sent;
 *   - a step's input is its `additionalInput` map, plus — unless
 *     `sendOnlyAdditionalInput` — the data JSON (or the `sendJSONPath`
 *     subtree, wrapped under `sendJSONNode`);
 *   - a step's output lands under the STEP NAME (`%StepName:…%`), or under
 *     `responseJSONNode` when set, keeping only the `responseJSONPath`
 *     subtree when that is set;
 *   - block steps (Conditional / Try Catch / Cache / Loop) run their children;
 *     their `executionConditionalFormula` gates every child.
 */

/** One IP step in context. */
export interface IpStep {
  readonly el: omnistudio.OmniTreeElement;
  readonly role: omnistudio.IpStepRole;
  readonly parent: IpStep | null;
  /** Position in execution (pre-order over the runtime tree). */
  readonly order: number;
  /** Non-empty `executionConditionalFormula`s of the ancestors and the step, outermost first. */
  readonly conditions: readonly { readonly step: string; readonly formula: string }[];
  /** `failOnStepError` (null when not declared). False = a failure here is swallowed. */
  readonly failOnStepError: boolean | null;
  /** Where the output lands (names). */
  readonly outputRoot: readonly string[];
  /** `responseJSONPath`: the output subtree kept, or null for all of it. */
  readonly responsePath: readonly string[] | null;
  readonly onlyAdditional: boolean;
  readonly sendPath: readonly string[] | null;
  readonly sendNode: readonly string[] | null;
  readonly additional: readonly PayloadEntry[];
  readonly valueMap: readonly PayloadEntry[];
  readonly additionalOutput: readonly PayloadEntry[];
  readonly returnOnlyAdditionalOutput: boolean;
  readonly returnFullDataJSON: boolean;
  readonly bundle: string | null;
  readonly remoteClass: string | null;
  readonly remoteMethod: string | null;
  readonly nestedIpKey: string | null;
  /** Loop Block: the list it iterates (names). */
  readonly loopList: readonly string[] | null;
  /** List Merge Action: the lists it merges (names each). */
  readonly mergeLists: readonly (readonly string[])[];
}

/** The built model. */
export interface IpModel {
  readonly loaded: LoadedProcess;
  readonly componentId: string;
  readonly uniqueName: string;
  readonly sourcePath: string;
  /** Every step, in execution order. */
  readonly steps: readonly IpStep[];
  readonly byIdPath: ReadonlyMap<string, IpStep>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);

/**
 * A path-valued property (`sendJSONPath`, `responseJSONPath`, `loopList`, …)
 * as names. Designers write it bare (`Step:Node`) or as a merge field
 * (`%Step:Node%`); both name the same path.
 */
const names = (raw: string | null): readonly string[] | null => {
  if (raw === null) return null;
  const t = raw.trim();
  const inner = /^%([^%]+)%$/.exec(t)?.[1] ?? t;
  return omnistudio.segmentNames(omnistudio.parseKeyPath(inner));
};

const bool = (v: unknown): boolean => v === true || v === 'true';

/** Build the model of one loaded Integration Procedure. */
export const buildIpModel = (loaded: LoadedProcess): IpModel => {
  const steps: IpStep[] = [];
  const byIdPath = new Map<string, IpStep>();
  const visit = (el: omnistudio.OmniTreeElement, parent: IpStep | null): void => {
    const cfg = el.config ?? {};
    // A Remote Action on the managed runtime's IntegrationProcedureService
    // runs the IP its method names: a nested IP call, not Apex.
    const service = omnistudio.runtimeServiceCall(omnistudio.apexRemoteTarget(cfg['remoteClass']), cfg['remoteMethod']);
    const role = service === null ? omnistudio.ipStepRole(el.canonicalType) : 'nestedIp';
    const own = str(cfg['executionConditionalFormula']);
    const fail = cfg['failOnStepError'];
    const mergeOrder = cfg['mergeListsOrder'];
    const step: IpStep = {
      el,
      role,
      parent,
      order: steps.length,
      conditions: [...(parent?.conditions ?? []), ...(own === null ? [] : [{ step: el.idPath, formula: own }])],
      failOnStepError: typeof fail === 'boolean' ? fail : null,
      outputRoot: names(str(cfg['responseJSONNode'])) ?? [el.name],
      responsePath: names(str(cfg['responseJSONPath'])),
      onlyAdditional: bool(cfg['sendOnlyAdditionalInput']),
      sendPath: names(str(cfg['sendJSONPath'])),
      sendNode: names(str(cfg['sendJSONNode'])),
      additional: classifyPayload(cfg['additionalInput']),
      valueMap: classifyPayload(cfg['elementValueMap']),
      additionalOutput: classifyPayload(cfg['additionalOutput']),
      returnOnlyAdditionalOutput: bool(cfg['returnOnlyAdditionalOutput']),
      returnFullDataJSON: bool(cfg['returnFullDataJSON']),
      bundle: str(cfg['bundle'])?.trim() ?? null,
      remoteClass: str(cfg['remoteClass']),
      remoteMethod: str(cfg['remoteMethod']),
      nestedIpKey: service?.key ?? str(cfg['integrationProcedureKey'])?.trim() ?? null,
      loopList: names(str(cfg['loopList'])),
      mergeLists: Array.isArray(mergeOrder)
        ? mergeOrder.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => names(x) as readonly string[])
        : [],
    };
    steps.push(step);
    byIdPath.set(el.idPath, step);
    for (const c of el.children) visit(c, step);
  };
  for (const r of loaded.doc.roots) visit(r, null);
  return {
    loaded,
    componentId: loaded.node.id,
    uniqueName: loaded.doc.header.uniqueName ?? loaded.node.apiName,
    sourcePath: loaded.node.sourcePath,
    steps,
    byIdPath,
  };
};

/** True for a step whose output is the response returned to the caller. */
export const isResponseStep = (step: IpStep): boolean => step.role === 'response';
