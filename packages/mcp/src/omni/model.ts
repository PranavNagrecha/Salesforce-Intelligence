import { omnistudio } from '@sf-intelligence/extractors';

import type { IpModel } from './ip-model.js';
import type { MapperModel } from './mapper-model.js';
import type { ScriptModel } from './script-model.js';
import {
  dataMapperItemId,
  type OmniConfidence,
  omniDataKeyId,
  omniElementId,
  omniIpStepId,
  type OmniModelEdge,
  type OmniModelEdgeKind,
  type OmniModelNode,
} from './types.js';
import type { OmniWorld } from './world.js';

/**
 * The F1 model as nodes and edges (spec §3.1–3.2), for ONE component at a
 * time: an OmniScript's elements and data keys, an Integration Procedure's
 * steps, a DataMapper's items — and the edges that connect them, including
 * across components (a screen action → the IP input key it fills, an IP step
 * → the DataMapper it runs, a Load item → the field it writes).
 *
 * Ids are stable and citable:
 *   OmniElement:<uniqueName>#<Step>/<Block>/…/<name>
 *   OmniIpStep:<ipUniqueName>#<path>
 *   OmniDataKey:<owner>#<raw path>
 *   DataMapperItem:<dmUniqueName>#<index>
 */

/** The model slice for one component. */
export interface OmniModelSlice {
  readonly nodes: readonly OmniModelNode[];
  readonly edges: readonly OmniModelEdge[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0 && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null);

/** `{name, value}` options → `{stored, label}` (name is what is stored; value is the label shown). */
const optionsOf = (cfg: Readonly<Record<string, unknown>> | null): { stored: string; label: string }[] | null => {
  const raw = cfg?.['options'];
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => ({ stored: String(o['name'] ?? ''), label: String(o['value'] ?? '') }));
};

class SliceBuilder {
  readonly nodes = new Map<string, OmniModelNode>();
  readonly edges: OmniModelEdge[] = [];
  readonly #edgeKeys = new Set<string>();

  node(n: OmniModelNode): void {
    if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
  }

  key(owner: string, rawPath: string, sourcePath: string, extra: Record<string, unknown> = {}): string {
    const id = omniDataKeyId(owner, rawPath);
    const path = omnistudio.parseKeyPath(rawPath);
    this.node({
      id,
      kind: 'OmniDataKey',
      owner,
      sourcePath,
      line: null,
      properties: {
        rawPath,
        hasEdgeWhitespace: omnistudio.pathHasEdgeWhitespace(path),
        segments: path.segments.map((s) => (s.row === 'none' ? s.name : `${s.name}|${s.row === 'current' ? 'n' : s.row}`)),
        ...extra,
      },
    });
    return id;
  }

  edge(from: string, to: string, kind: OmniModelEdgeKind, confidence: OmniConfidence, sourcePath: string, properties: Record<string, unknown> = {}): void {
    const k = `${from}\u0000${to}\u0000${kind}\u0000${JSON.stringify(properties)}`;
    if (this.#edgeKeys.has(k)) return;
    this.#edgeKeys.add(k);
    this.edges.push({ from, to, kind, confidence, sourcePath, properties });
  }

  result(): OmniModelSlice {
    const nodes = [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const edges = [...this.edges].sort((a, b) =>
      a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
    );
    return { nodes, edges };
  }
}

/** The F1 slice of an OmniScript. */
export const scriptSlice = (world: OmniWorld, script: ScriptModel): OmniModelSlice => {
  const b = new SliceBuilder();
  const owner = script.componentId;
  const sp = script.sourcePath;
  const isActive = script.loaded.doc.header.isActive;
  for (const e of script.elements) {
    const cfg = e.el.config;
    const id = omniElementId(script.uniqueName, e.el.idPath);
    const editBlock = e.el.canonicalType === 'Edit Block' && cfg !== null
      ? {
          allowNew: bool(cfg['allowNew']),
          allowEdit: bool(cfg['allowEdit']),
          allowDelete: bool(cfg['allowDelete']),
          deleteIPKey: str(cfg['deleteIPKey']),
          deleteIPExtraPayload: cfg['deleteIPExtraPayload'] ?? null,
          saveIPKey: str(cfg['saveIPKey']),
          saveIPExtraPayload: cfg['saveIPExtraPayload'] ?? null,
          mode: str(cfg['mode']),
          uniqueKey: str(cfg['uniqueKey']),
        }
      : undefined;
    b.node({
      id,
      kind: 'OmniElement',
      owner,
      sourcePath: sp,
      line: e.el.line,
      properties: {
        type: e.el.type,
        role: e.role,
        name: e.el.name,
        path: e.el.idPath,
        level: e.el.level,
        sequence: e.el.sequence,
        dataKey: e.role === 'input' || e.role === 'formula' || e.role === 'container' || e.role === 'customLwc' ? e.dataPath.join(':') : null,
        inRepeat: e.repeatingContainer !== null,
        required: bool(cfg?.['required']),
        readOnly: bool(cfg?.['readOnly']),
        mask: str(cfg?.['mask']),
        pattern: str(cfg?.['pattern']),
        maxLength: num(cfg?.['maxLength']),
        minLength: num(cfg?.['minLength']),
        ptrnErrText: str(cfg?.['ptrnErrText']),
        options: optionsOf(cfg),
        optionSource: cfg?.['optionSource'] ?? null,
        labelKey: str(cfg?.['label']),
        show: cfg?.['show'] ?? null,
        ...(editBlock === undefined ? {} : { editBlock }),
        isActiveVersion: isActive,
        ...(e.el.configError === null ? {} : { configError: e.el.configError }),
      },
    });
    b.edge(e.parent === null ? owner : omniElementId(script.uniqueName, e.parent.el.idPath), id, 'containsElement', 'parsed', sp);
  }
  // producesKey
  for (const p of script.producers) {
    if (p.element === null) continue;
    const keyId = b.key(owner, p.path.join(':'), sp, { producerKind: p.kind });
    b.edge(omniElementId(script.uniqueName, p.element.el.idPath), keyId, 'producesKey', p.confidence, sp, { producerKind: p.kind });
  }
  // readsKey: show-rule fields and merge references in every config string.
  for (const e of script.elements) {
    const id = omniElementId(script.uniqueName, e.el.idPath);
    const cfg = e.el.config;
    if (cfg === null) continue;
    const show = omnistudio.parseShowRule(cfg['show']);
    for (const c of omnistudio.ruleConditions(show)) {
      const names = omnistudio.segmentNames(omnistudio.parseKeyPath(c.field));
      const r = script.resolveRef(names, e);
      const keyId = r.producers[0] === undefined ? b.key(owner, c.field, sp, { resolved: false }) : b.key(owner, r.producers[0].path.join(':'), sp);
      b.edge(id, keyId, 'readsKey', 'parsed', sp, { via: `show.${c.at}`, raw: c.field, resolution: r.how });
    }
    for (const site of omnistudio.stringSites(cfg)) {
      if (site.prop.startsWith('show.')) continue;
      for (const ref of omnistudio.scanPercentRefs(site.value).refs) {
        const r = script.resolveRef(omnistudio.segmentNames(ref.path), e);
        const keyId = r.producers[0] === undefined ? b.key(owner, ref.raw, sp, { resolved: false }) : b.key(owner, r.producers[0].path.join(':'), sp);
        b.edge(id, keyId, 'readsKey', 'parsed', sp, { via: site.prop, raw: ref.raw, resolution: r.how });
      }
    }
  }
  // sendsToIp / deletesVia
  for (const a of script.actions) {
    const from = omniElementId(script.uniqueName, a.element.el.idPath);
    if (a.ipKey === null) continue;
    const t = world.resolveIpKey(a.ipKey);
    const ipOwner = t.node?.id ?? `OmniIntegrationProcedure:${a.ipKey}`;
    for (const entry of a.entries) {
      const keyId = b.key(ipOwner, entry.key, t.node?.sourcePath ?? '', { inputKey: true });
      b.edge(from, keyId, 'sendsToIp', 'parsed', sp, { expression: entry.value, entryKind: entry.kind, payloadProp: a.payloadProp, targetResolution: t.resolution });
    }
    if (a.base.kind !== 'none') {
      const keyId = b.key(ipOwner, (a.sendNode ?? []).join(':') || '<data JSON>', t.node?.sourcePath ?? '', { inputKey: true });
      b.edge(from, keyId, 'sendsToIp', a.baseConfidence, sp, {
        base: a.base.kind === 'row' ? `row of ${a.base.container.el.idPath}` : a.base.kind === 'path' ? `path ${a.base.path.join(':')}` : 'whole data JSON',
        targetResolution: t.resolution,
      });
    }
    if (a.kind === 'editBlockDeleteKey' || a.editBlockButton === 'Delete') {
      const eb = a.kind === 'editBlockDeleteKey' ? a.element : a.element.parent;
      if (eb !== null) {
        b.edge(omniElementId(script.uniqueName, eb.el.idPath), ipOwner, 'deletesVia', 'parsed', sp, {
          mechanism: a.kind === 'editBlockDeleteKey' ? 'deleteIPKey' : 'deleteChildAction',
          via: a.element.el.idPath,
          targetResolution: t.resolution,
        });
      }
    }
  }
  return b.result();
};

/** The F1 slice of an Integration Procedure. */
export const ipSlice = (world: OmniWorld, ip: IpModel): OmniModelSlice => {
  const b = new SliceBuilder();
  const owner = ip.componentId;
  const sp = ip.sourcePath;
  for (const s of ip.steps) {
    const id = omniIpStepId(ip.uniqueName, s.el.idPath);
    const cfg = s.el.config ?? {};
    b.node({
      id,
      kind: 'OmniIpStep',
      owner,
      sourcePath: sp,
      line: s.el.line,
      properties: {
        type: s.el.type,
        role: s.role,
        name: s.el.name,
        path: s.el.idPath,
        order: s.order,
        executionConditionalFormula: str(cfg['executionConditionalFormula']),
        failOnStepError: s.failOnStepError,
        failOnBlockError: bool(cfg['failOnBlockError']),
        chainOnStep: bool(cfg['chainOnStep']),
        bundle: s.bundle,
        remoteClass: s.remoteClass,
        remoteMethod: s.remoteMethod,
        integrationProcedureKey: s.nestedIpKey,
        additionalInput: cfg['additionalInput'] ?? null,
        elementValueMap: cfg['elementValueMap'] ?? null,
        sendJSONPath: str(cfg['sendJSONPath']),
        sendJSONNode: str(cfg['sendJSONNode']),
        sendOnlyAdditionalInput: s.onlyAdditional,
        responseJSONPath: str(cfg['responseJSONPath']),
        responseJSONNode: str(cfg['responseJSONNode']),
        outputRoot: s.outputRoot.join(':'),
      },
    });
    b.edge(s.parent === null ? owner : omniIpStepId(ip.uniqueName, s.parent.el.idPath), id, 'containsElement', 'parsed', sp);
    if (s.role !== 'block' && s.role !== 'loop') {
      b.edge(id, b.key(owner, s.outputRoot.join(':'), sp, { stepOutput: true }), 'stepOutputs', 'parsed', sp);
    }
    for (const site of omnistudio.stringSites(cfg)) {
      for (const ref of omnistudio.scanPercentRefs(site.value).refs) {
        b.edge(id, b.key(owner, ref.raw, sp), 'readsKey', 'parsed', sp, { via: site.prop, raw: ref.raw });
      }
    }
    if (s.role === 'dataMapper' && s.bundle !== null) {
      const t = world.resolveBundle(s.bundle);
      if (t.node !== null) {
        b.edge(id, t.node.id, 'readsKey', 'parsed', sp, { via: 'bundle', runs: true, targetResolution: t.resolution });
      }
    }
  }
  return b.result();
};

/** The F1 slice of a DataMapper. */
export const mapperSlice = (mm: MapperModel, fieldIdOf: (object: string, field: string) => string): OmniModelSlice => {
  const b = new SliceBuilder();
  const owner = mm.componentId;
  const sp = mm.sourcePath;
  for (const it of mm.loaded.doc.items) {
    const id = dataMapperItemId(mm.uniqueName, it.index);
    b.node({
      id,
      kind: 'DataMapperItem',
      owner,
      sourcePath: sp,
      line: it.line,
      properties: {
        index: it.index,
        inputFieldName: it.inputFieldName,
        outputFieldName: it.outputFieldName,
        outputObjectName: it.outputObjectName,
        inputObjectName: it.inputObjectName,
        filterOperator: it.filterOperator,
        filterValue: it.filterValue,
        upsertKey: it.upsertKey,
        requiredForUpsert: it.requiredForUpsert,
        disabled: it.disabled,
        defaultValue: it.defaultValue,
        formulaExpression: it.formulaExpression,
        formulaResultPath: it.formulaResultPath,
      },
    });
    b.edge(owner, id, 'containsElement', 'parsed', sp);
    if (it.disabled) continue;
    if (it.inputFieldName !== null && it.inputObjectName === null) {
      b.edge(id, b.key(owner, it.inputFieldName, sp, { side: 'input' }), 'dmReads', 'parsed', sp);
    }
    if (it.outputFieldName !== null) {
      if (omnistudio.isJsonOutputObject(it.outputObjectName)) {
        b.edge(id, b.key(owner, `out:${it.outputFieldName}`, sp, { side: 'output' }), 'dmWrites', 'parsed', sp);
      } else if (it.outputObjectName !== null) {
        b.edge(id, fieldIdOf(it.outputObjectName, it.outputFieldName), 'writesField', 'parsed', sp, { mechanism: 'load' });
      }
    }
  }
  return b.result();
};
