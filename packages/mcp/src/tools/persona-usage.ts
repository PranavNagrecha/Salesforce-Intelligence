/**
 * What a persona's reachable automation actually does with records — the
 * evidence side of "which grants does this kind of user have that nothing they
 * run uses?" (spec F6). Shared: any tool that needs "what can this persona's
 * screens and code write?" reads it.
 *
 * Reachable = what the persona can set running:
 *   - every ACTIVE OmniScript, Integration Procedure and FlexCard (inside the
 *     vault's OmniStudio `appScope` when one is configured), and what they
 *     dispatch: IPs, DataMappers, embedded OmniScripts;
 *   - Apex entered from those (`callsApex`), from Lightning components the
 *     persona has Apex access to, and granted classes with UI- or flow-callable
 *     methods (`@AuraEnabled`, `@InvocableMethod`, REST) — then everything that
 *     Apex calls (`walkDownstreamApex`);
 *   - the triggers and record-triggered flows on the objects those write (they
 *     run in the same transaction), to a fixed point.
 *
 * Uses come from the graph (DataMapper Loads, IP Delete Actions, flow writes,
 * Apex field writes) and the shared Apex DML index (type-aware attribution).
 * A GENERIC Apex writer (it writes whatever SObject it is handed) is attributed
 * to the objects OmniStudio passes it as literal `objectApiName` arguments when
 * every reachable caller does so; otherwise it stays OPEN and the caller must
 * report the affected grants as UNKNOWN, never as unused.
 */

import { readFile } from 'node:fs/promises';

import type { ComponentId, McpError, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdgesForNodes } from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import { loadOmniConfig } from '../omni/config.js';
import type { Context } from '../server.js';

import { type ApexDmlFact, buildApexDmlIndex, stripApexComments } from './apex-dml-index.js';
import { resolveGenericDml } from './apex-generic-dml.js';
import { walkDownstreamApex } from './apex-reachability.js';
import type { EffectiveGrantSet } from './effective-permissions.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { isActiveSoeFirer } from './soe-active.js';

/** An object-level operation a grant allows. */
export type GrantOp = 'create' | 'edit' | 'delete';

/** One piece of evidence that a persona's reachable automation performs `op` on `object`. */
export interface UseEvidence {
  readonly op: GrantOp;
  readonly object: string;
  /** What performs it: `DataMapper Load`, `Apex insert`, `IP Delete Action`, `record-triggered Flow`, … */
  readonly via: string;
  readonly componentId: string;
  readonly detail: string | null;
  readonly confidence: 'declared' | 'parsed' | 'inferred';
  /** Apex evidence only: the access level written on the DML (`system` needs no user grant). */
  readonly accessLevel?: 'user' | 'system' | null;
}

/** The computed usage of one persona. */
export interface PersonaUsage {
  readonly reachableOmniStudio: number;
  readonly entryApex: readonly string[];
  readonly reachableApex: ReadonlySet<string>;
  /** `${object}|${op}` (object lower-cased) → evidence. */
  readonly uses: ReadonlyMap<string, readonly UseEvidence[]>;
  /** `Object.Field` (lower-cased) → evidence of a field write. */
  readonly fieldWrites: ReadonlyMap<string, readonly UseEvidence[]>;
  /** object (lower-cased) → writers whose field set is not visible (Apex DML, generic adapters). */
  readonly fieldOpaqueWriters: ReadonlyMap<string, readonly string[]>;
  /** op → generic Apex writers reachable without attribution (`Class.method`). */
  readonly openGeneric: ReadonlyMap<GrantOp, readonly string[]>;
  /** Objects (lower-cased) named by reachable Apex or OmniStudio configuration. */
  readonly mentioned: ReadonlySet<string>;
  /** object (lower-cased) → Lightning components / pages that reference it directly. */
  readonly uiReferences: ReadonlyMap<string, readonly string[]>;
  /** object (lower-cased) → active flows that write it but are not reached through the persona's automation. */
  readonly otherFlowWriters: ReadonlyMap<string, readonly string[]>;
  readonly limitations: readonly string[];
}

const OMNI_UI = new Set(['OmniScript', 'OmniUiCard', 'OmniIntegrationProcedure']);
const UI_COMPONENT_PREFIXES = ['LightningComponentBundle:', 'AuraDefinitionBundle:'];
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

const opsOf = (operation: string): GrantOp[] => {
  switch (operation) {
    case 'insert':
      return ['create'];
    case 'update':
      return ['edit'];
    case 'upsert':
      return ['create', 'edit'];
    case 'delete':
      return ['delete'];
    case 'merge':
      return ['edit', 'delete'];
    default:
      return [];
  }
};

const objectOfId = (id: string): string | null => {
  if (id.startsWith('CustomObject:')) return id.slice('CustomObject:'.length);
  if (id.startsWith('CustomField:')) return id.slice('CustomField:'.length).split('.')[0] ?? null;
  return null;
};

/** Compute what the persona's reachable automation does. */
export const computePersonaUsage = async (
  ctx: Context,
  grants: EffectiveGrantSet,
): Promise<Result<PersonaUsage, McpError>> => {
  const limitations: string[] = [];
  const uses = new Map<string, UseEvidence[]>();
  const fieldWrites = new Map<string, UseEvidence[]>();
  const fieldOpaque = new Map<string, Set<string>>();
  const openGeneric = new Map<GrantOp, Set<string>>();
  const mentioned = new Set<string>();
  const addUse = (e: UseEvidence): void => {
    const key = `${e.object.toLowerCase()}|${e.op}`;
    uses.set(key, [...(uses.get(key) ?? []), e]);
  };
  const addFieldWrite = (fieldKey: string, e: UseEvidence): void => {
    const key = fieldKey.toLowerCase();
    fieldWrites.set(key, [...(fieldWrites.get(key) ?? []), e]);
  };
  const addOpaque = (object: string, writer: string): void => {
    const key = object.toLowerCase();
    fieldOpaque.set(key, new Set([...(fieldOpaque.get(key) ?? []), writer]));
  };

  const scan = await scanAllNodesOfTypes(ctx.graph, [
    'OmniScript',
    'OmniIntegrationProcedure',
    'OmniUiCard',
    'OmniDataTransform',
    'ApexClass',
    'ApexTrigger',
    'Flow',
    'CustomObject',
  ]);
  if (!scan.ok) return err({ kind: 'internal', message: `graph scan failed: ${scan.error.message}` });
  if (scan.value.scanIncomplete) limitations.push('A node scan stopped at its residual cap; some components were not considered.');
  const byId = new Map<string, Node>(scan.value.nodes.map((n) => [n.id, n]));
  const objectByLower = new Map<string, string>();
  for (const n of scan.value.nodes) if (n.type === 'CustomObject') objectByLower.set(n.apiName.toLowerCase(), n.apiName);

  // --- OmniStudio reach --------------------------------------------------------
  const { config } = await loadOmniConfig(ctx.vaultRoot);
  const prefixes = config.appScope.namePrefixes;
  const inScope = (n: Node): boolean => prefixes.length === 0 || prefixes.some((p) => n.apiName.startsWith(p));
  const omniReached = new Set<string>();
  let frontier = scan.value.nodes
    .filter((n) => OMNI_UI.has(n.type) && n.properties['isActive'] === true && inScope(n))
    .map((n) => n.id)
    .sort();
  for (const id of frontier) omniReached.add(id);
  while (frontier.length > 0) {
    const batch = await listEdgesForNodes(ctx.graph, frontier as ComponentId[], { direction: 'out', edgeTypes: ['dispatchesOmniAction'] });
    if (!batch.ok) return err({ kind: 'internal', message: batch.error.message });
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of batch.value.get(id as ComponentId) ?? []) {
        const target = byId.get(e.toId);
        if (target === undefined || omniReached.has(target.id)) continue;
        // A versioned OmniScript / IP target runs only when active; a DataMapper always runs.
        if (target.type !== 'OmniDataTransform' && target.properties['isActive'] !== true) continue;
        omniReached.add(target.id);
        next.push(target.id);
      }
    }
    frontier = next.sort();
  }
  const omniIds = [...omniReached].sort() as ComponentId[];
  const omniOut = await listEdgesForNodes(ctx.graph, omniIds, { direction: 'out', edgeTypes: ['writesTo', 'readsFrom', 'callsApex'] });
  if (!omniOut.ok) return err({ kind: 'internal', message: omniOut.error.message });
  const entryApex = new Set<string>();
  for (const id of omniIds) {
    const node = byId.get(id);
    for (const e of omniOut.value.get(id) ?? []) {
      const obj = objectOfId(e.toId);
      if (obj !== null) mentioned.add(obj.toLowerCase());
      if (e.edgeType === 'callsApex') {
        entryApex.add(e.toId);
        const sites = Array.isArray(e.properties['callSites']) ? (e.properties['callSites'] as Record<string, unknown>[]) : [];
        for (const s of sites) for (const o of (Array.isArray(s['objectArgs']) ? s['objectArgs'] : []) as string[]) mentioned.add(o.toLowerCase());
        continue;
      }
      if (e.edgeType !== 'writesTo' || obj === null) continue;
      const base = { componentId: id, confidence: e.confidence === 'declared' ? ('declared' as const) : ('parsed' as const) };
      const op = e.properties['operation'];
      if (e.toId.startsWith('CustomField:')) {
        addFieldWrite(e.toId.slice('CustomField:'.length), { ...base, op: 'edit', object: obj, via: node?.type === 'OmniDataTransform' ? 'DataMapper Load' : `${node?.type ?? 'OmniStudio'} write`, detail: e.toId });
      } else if (op === 'recordCreate') {
        addUse({ ...base, op: 'create', object: obj, via: 'DataMapper Load (create)', detail: null });
      } else if (op === 'recordUpsert') {
        addUse({ ...base, op: 'create', object: obj, via: 'DataMapper Load (upsert)', detail: null });
        addUse({ ...base, op: 'edit', object: obj, via: 'DataMapper Load (upsert)', detail: null });
      } else if (op === 'recordDelete') {
        addUse({ ...base, op: 'delete', object: obj, via: 'Integration Procedure Delete Action', detail: Array.isArray(e.properties['steps']) ? (e.properties['steps'] as string[]).join(', ') : null });
      }
    }
  }
  // A DataMapper field write implies the object is edited (or created) by that Load.
  for (const [, evs] of fieldWrites) {
    for (const ev of evs) {
      if (!uses.has(`${ev.object.toLowerCase()}|edit`) && !uses.has(`${ev.object.toLowerCase()}|create`)) {
        addUse({ ...ev, op: 'edit', detail: 'writes fields of this object' });
      }
    }
  }

  // --- Apex entry points ----------------------------------------------------------
  const granted = new Set([...grants.apexClasses].map((c) => c.toLowerCase()));
  const uiCalls = await listEdgesForNodes(
    ctx.graph,
    scan.value.nodes.filter((n) => n.type === 'ApexClass').map((n) => n.id) as ComponentId[],
    { direction: 'in', edgeTypes: ['callsApex'] },
  );
  if (!uiCalls.ok) return err({ kind: 'internal', message: uiCalls.error.message });
  for (const n of scan.value.nodes) {
    if (n.type !== 'ApexClass' || n.properties['isTest'] === true) continue;
    const isGranted = granted.has(n.apiName.toLowerCase());
    if (!isGranted) continue;
    const callable =
      n.properties['hasAuraEnabledMethod'] === true || n.properties['hasInvocableMethod'] === true || n.properties['isRestResource'] === true;
    const calledFromUi = (uiCalls.value.get(n.id as ComponentId) ?? []).some((e) => UI_COMPONENT_PREFIXES.some((p) => e.fromId.startsWith(p)));
    if (callable || calledFromUi) entryApex.add(n.id);
  }

  // --- reach, DML, triggers and flows to a fixed point ----------------------------------
  const index = await buildApexDmlIndex(ctx, ['insert', 'update', 'upsert', 'delete', 'merge']);
  if (!index.ok) limitations.push(`The Apex DML scan failed: ${index.error.message}`);
  else if (index.value.unparsed.length > 0) limitations.push(`${index.value.unparsed.length} Apex file(s) did not parse; their DML is not seen.`);
  const facts: readonly ApexDmlFact[] = index.ok ? index.value.facts : [];
  let reachable: ReadonlyMap<ComponentId, unknown> = new Map();
  const triggerEntries = new Set<string>();
  const flowSeen = new Set<string>();
  for (let round = 0; round < 4; round += 1) {
    const walk = await walkDownstreamApex(ctx, [...entryApex, ...triggerEntries] as ComponentId[], { maxDepth: 12 });
    if (!walk.ok) return err({ kind: 'internal', message: walk.error });
    reachable = walk.value;
    const before = uses.size;
    for (const f of facts) {
      if (!reachable.has(f.componentId as ComponentId)) continue;
      const ops = opsOf(f.operation);
      const where = `${f.componentId}${f.method === null ? '' : `.${f.method}`} line ${f.line}${f.accessLevel === null ? '' : ` (${f.accessLevel} mode)`}`;
      if (f.objectsTyped.length > 0) {
        for (const o of f.objectsTyped) {
          for (const op of ops) addUse({ op, object: o, via: `Apex ${f.operation}`, componentId: f.componentId, detail: where, confidence: 'inferred', accessLevel: f.accessLevel });
          addOpaque(o, f.componentId);
        }
        continue;
      }
      if (f.operandGeneric || f.generic) {
        // A generic helper: resolve it at the call sites of the persona's reachable code.
        const callers: ReadonlySet<string> = new Set<string>([...reachable.keys(), ...omniReached]);
        const res = await resolveGenericDml(ctx, f, callers, objectByLower);
        if (res.status === 'not-reached') continue;
        for (const o of res.objects) {
          for (const op of ops) {
            addUse({ op, object: o, via: `generic Apex ${f.operation} (object resolved at the call site)`, componentId: f.componentId, detail: where, confidence: 'inferred', accessLevel: f.accessLevel });
          }
          addOpaque(o, f.componentId);
        }
        if (res.status === 'open') {
          for (const op of ops) openGeneric.set(op, new Set([...(openGeneric.get(op) ?? []), `${f.componentId}${f.method === null ? '' : `.${f.method}`}`]));
        }
        continue;
      }
      for (const o of [...new Set([...f.objectsNamed, ...f.objectsQueried])]) {
        for (const op of ops) addUse({ op, object: o, via: `Apex ${f.operation} (operand type not visible; the method names the object)`, componentId: f.componentId, detail: where, confidence: 'inferred', accessLevel: f.accessLevel });
        addOpaque(o, f.componentId);
      }
    }
    // Apex field writes of reachable classes.
    const apexOut = await listEdgesForNodes(ctx.graph, [...reachable.keys()], { direction: 'out', edgeTypes: ['writesTo'] });
    if (apexOut.ok) {
      for (const [id, edges] of apexOut.value) {
        for (const e of edges) {
          if (!e.toId.startsWith('CustomField:')) continue;
          const obj = objectOfId(e.toId);
          if (obj === null) continue;
          addFieldWrite(e.toId.slice('CustomField:'.length), { op: 'edit', object: obj, via: 'Apex field assignment', componentId: id, detail: null, confidence: 'inferred' });
        }
      }
    }
    // Triggers and record-triggered flows on written objects run in the same transaction.
    const written = new Set([...uses.keys()].map((k) => k.split('|')[0] as string));
    const objectIds = [...written].map((o) => `CustomObject:${objectByLower.get(o) ?? o}`) as ComponentId[];
    const firers = await listEdgesForNodes(ctx.graph, objectIds, { direction: 'in', edgeTypes: ['triggersOn'] });
    if (!firers.ok) return err({ kind: 'internal', message: firers.error.message });
    for (const [, edges] of firers.value) {
      for (const e of edges) {
        const firer = byId.get(e.fromId);
        if (firer === undefined || !isActiveSoeFirer(firer)) continue;
        if (firer.type === 'ApexTrigger') triggerEntries.add(firer.id);
        if (firer.type === 'Flow' && !flowSeen.has(firer.id)) {
          flowSeen.add(firer.id);
          const fw = await listEdgesForNodes(ctx.graph, [firer.id as ComponentId], { direction: 'out', edgeTypes: ['writesTo'] });
          for (const w of fw.ok ? (fw.value.get(firer.id as ComponentId) ?? []) : []) {
            const obj = objectOfId(w.toId);
            if (obj === null) continue;
            const flowOp = w.properties['operation'];
            const op: GrantOp | null = flowOp === 'recordCreate' ? 'create' : flowOp === 'recordUpdate' ? 'edit' : flowOp === 'recordDelete' ? 'delete' : null;
            if (op !== null) addUse({ op, object: obj, via: 'record-triggered Flow', componentId: firer.id, detail: null, confidence: 'parsed' });
            if (w.toId.startsWith('CustomField:')) {
              addFieldWrite(w.toId.slice('CustomField:'.length), { op: 'edit', object: obj, via: 'record-triggered Flow', componentId: firer.id, detail: null, confidence: 'parsed' });
            }
          }
        }
      }
    }
    if (uses.size === before && round > 0) break;
  }

  // --- mentions: objects named by reachable Apex source ------------------------------
  for (const id of reachable.keys()) {
    const node = byId.get(id);
    if (node === undefined || node.sourcePath === null || node.sourcePath.length === 0) continue;
    let text: string;
    try {
      text = await readFile(resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath), 'utf-8');
    } catch {
      continue;
    }
    for (const m of stripApexComments(text).matchAll(IDENT)) {
      const hit = objectByLower.get(m[0].toLowerCase());
      if (hit !== undefined) mentioned.add(hit.toLowerCase());
    }
  }

  // --- direct UI references and other flows ---------------------------------------------
  const uiReferences = new Map<string, Set<string>>();
  const otherFlowWriters = new Map<string, Set<string>>();
  const uiNodes = scan.value.nodes.filter((n) => n.type === 'Flow');
  const uiOut = await listEdgesForNodes(
    ctx.graph,
    uiNodes.map((n) => n.id) as ComponentId[],
    { direction: 'out', edgeTypes: ['writesTo'] },
  );
  if (uiOut.ok) {
    for (const [id, edges] of uiOut.value) {
      const flow = byId.get(id);
      if (flow === undefined || flowSeen.has(id) || !isActiveSoeFirer(flow)) continue;
      for (const e of edges) {
        const obj = objectOfId(e.toId);
        if (obj === null) continue;
        otherFlowWriters.set(obj.toLowerCase(), new Set([...(otherFlowWriters.get(obj.toLowerCase()) ?? []), id]));
      }
    }
  }
  const lwcIds = [...new Set((await allUiComponentIds(ctx)) ?? [])] as ComponentId[];
  const lwcOut = await listEdgesForNodes(ctx.graph, lwcIds, { direction: 'out' });
  if (lwcOut.ok) {
    for (const [id, edges] of lwcOut.value) {
      for (const e of edges) {
        const obj = objectOfId(e.toId);
        if (obj === null) continue;
        uiReferences.set(obj.toLowerCase(), new Set([...(uiReferences.get(obj.toLowerCase()) ?? []), id]));
      }
    }
  }

  const freeze = <V>(m: Map<string, Set<V>>): ReadonlyMap<string, readonly V[]> => new Map([...m].map(([k, v]) => [k, [...v].sort()]));
  return ok({
    reachableOmniStudio: omniReached.size,
    entryApex: [...entryApex].sort(),
    reachableApex: new Set([...reachable.keys()]),
    uses,
    fieldWrites,
    fieldOpaqueWriters: freeze(fieldOpaque),
    openGeneric: new Map([...openGeneric].map(([k, v]) => [k, [...v].sort()])),
    mentioned,
    uiReferences: freeze(uiReferences),
    otherFlowWriters: freeze(otherFlowWriters),
    limitations,
  });
};

/** Every Lightning Web Component / Aura bundle id in the vault. */
const allUiComponentIds = async (ctx: Context): Promise<string[] | null> => {
  const scan = await scanAllNodesOfTypes(ctx.graph, ['LightningComponentBundle', 'AuraDefinitionBundle']);
  return scan.ok ? scan.value.nodes.map((n) => n.id) : null;
};
