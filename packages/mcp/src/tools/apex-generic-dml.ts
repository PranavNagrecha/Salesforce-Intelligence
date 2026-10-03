/**
 * Generic Apex DML helpers — methods that insert / update / delete whatever
 * SObjects they are handed (`DataAccessUtil.insertObjects(SObjectType t,
 * List<SObject> rows)`, `GenericUpsert.upsertRecords(records, objectApiName)`).
 * Almost every enterprise org has them; reading them as "writes anything"
 * makes every grant look possibly-used, reading them as "writes nothing" makes
 * real writes invisible. This module resolves them at their CALL SITES:
 *
 *   1. Which helper methods do the given callers actually invoke? The callers'
 *      `callsApex` edges name target methods (AST edges carry `methods[]`); the
 *      helper's own overload / delegation chain (a method calling another by
 *      name) is followed inside the class.
 *   2. At each invocation `Helper.method(args)` in a caller's source, which
 *      object does it pass? An argument `X.SObjectType` / `Schema.X.SObjectType`,
 *      a string literal naming a vault object, or an argument whose declared
 *      type is the object (`List<X> rows`) — the first that resolves.
 *   3. OmniStudio callers pass the object as a literal argument the extractor
 *      already recorded (`callSites[].objectArgs`).
 *
 * Result: `not-reached` (no caller invokes the DML method — only when every
 * caller edge names its methods; otherwise reachability is assumed), `closed`
 * (every invocation resolved: the helper writes exactly these objects for these
 * callers), or `open` (some invocation did not resolve — the helper may write
 * anything). Every answer is `inferred`.
 */

import { readFile } from 'node:fs/promises';

import type { ComponentId, Edge, Node } from '@sf-intelligence/contracts';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { type ApexMethodNode, parseApexStructure } from '@sf-intelligence/parsers';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

import { type ApexDmlFact, operandTypeNames, stripApexComments } from './apex-dml-index.js';

/** How a generic DML site resolves for a set of callers. */
export interface GenericDmlResolution {
  readonly status: 'not-reached' | 'closed' | 'open';
  /** Objects the resolved invocations pass (sorted). */
  readonly objects: readonly string[];
  /** Invocations seen / resolved. */
  readonly sites: number;
  readonly resolvedSites: number;
  /** Why the status is `open` (first few unresolved invocations). */
  readonly unresolved: readonly string[];
}

/** True for an Apex class that runs on its own (platform-invoked), whatever calls it. */
export const isApexEntryClass = (node: Node): boolean =>
  node.type === 'ApexTrigger' ||
  ['isBatchable', 'isSchedulable', 'isQueueable', 'hasAuraEnabledMethod', 'hasInvocableMethod', 'isRestResource'].some(
    (k) => node.properties[k] === true,
  );

interface ClassSource {
  readonly text: string;
  readonly methods: readonly ApexMethodNode[];
}

const sourceCache = new Map<string, Promise<ClassSource | null>>();

const loadClass = (ctx: Context, node: Node): Promise<ClassSource | null> => {
  const key = `${ctx.vaultRoot}|${ctx.manifest.refreshedAt}|${node.id}`;
  const hit = sourceCache.get(key);
  if (hit !== undefined) return hit;
  const p = (async (): Promise<ClassSource | null> => {
    if (node.sourcePath === null || node.sourcePath.length === 0) return null;
    let raw: string;
    try {
      raw = await readFile(resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath), 'utf-8');
    } catch {
      return null;
    }
    const parsed = await parseApexStructure(raw, { kind: node.type === 'ApexTrigger' ? 'trigger' : 'class' });
    return { text: stripApexComments(raw), methods: parsed.structure?.methods ?? [] };
  })();
  sourceCache.set(key, p);
  if (sourceCache.size > 400) sourceCache.delete(sourceCache.keys().next().value as string);
  return p;
};

/** Split a call's argument list (text after `(`) at depth-0 commas, up to the closing `)`. */
const splitArgs = (text: string): string[] => {
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (inString) {
      cur += c;
      if (c === '\\') {
        cur += text[i + 1] ?? '';
        i += 1;
      } else if (c === "'") inString = false;
      continue;
    }
    if (c === "'") {
      inString = true;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        if (cur.trim().length > 0) args.push(cur.trim());
        return args;
      }
      depth -= 1;
    }
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  return args;
};

/** The vault object an argument names, or null. */
const objectOfArg = (
  arg: string,
  textBefore: string,
  fileText: string,
  objectByLower: ReadonlyMap<string, string>,
): string | null => {
  const a = arg.trim();
  // `X.SObjectType`, `Schema.X.SObjectType`
  const sobjectType = /^(?:Schema\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*sObjectType$/i.exec(a);
  if (sobjectType !== null) return objectByLower.get((sobjectType[1] as string).toLowerCase()) ?? null;
  // A string literal naming the object.
  const literal = /^'([A-Za-z_][A-Za-z0-9_]*)'$/.exec(a);
  if (literal !== null) return objectByLower.get((literal[1] as string).toLowerCase()) ?? null;
  // A field token `X.Field__c` (an SObjectField, e.g. an upsert key) names its object.
  const fieldToken = /^(?:Schema\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)$/.exec(a);
  if (fieldToken !== null) {
    const hit = objectByLower.get((fieldToken[1] as string).toLowerCase());
    if (hit !== undefined) return hit;
  }
  // A collection literal of generic SObjects: type its elements.
  const collection = /^new\s+(?:List|Set)\s*<\s*SObject\s*>\s*\{([\s\S]*)\}$/i.exec(a);
  if (collection !== null) {
    for (const element of splitArgs(`${collection[1] as string})`)) {
      const hit = objectOfArg(element, textBefore, fileText, objectByLower);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const t of operandTypeNames(a, textBefore, fileText)) {
    const hit = objectByLower.get(t.toLowerCase());
    if (hit !== undefined) return hit;
    // Typed as an SObject the vault does not hold (a standard object not
    // retrieved): still that object, never "unresolved".
    if (SOBJECT_NAME.test(t) && !APEX_TYPES.has(t.toLowerCase())) return t;
  }
  return null;
};

/** A plausible SObject api name (PascalCase or a custom suffix). */
const SOBJECT_NAME = /^(?:[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9_]*__(?:c|e|mdt|x|b|kav|ka))$/;

/** Apex types that are never SObjects. */
const APEX_TYPES = new Set([
  'sobject', 'string', 'id', 'integer', 'long', 'decimal', 'double', 'boolean', 'date', 'datetime', 'time',
  'blob', 'object', 'list', 'set', 'map', 'database', 'schema', 'system', 'type', 'exception', 'json',
]);

/**
 * Invocations of any of `names` inside the body of `entry` (a routed method
 * of the helper), each resolved to the object it passes — how a routed
 * OmniStudio call that carries no literal object is resolved inside the class.
 */
const resolveInsideMethod = (
  helper: ClassSource,
  entry: string,
  names: ReadonlySet<string>,
  objectByLower: ReadonlyMap<string, string>,
): { readonly objects: string[]; readonly unresolved: number } | null => {
  const m = helper.methods.find((x) => x.name.toLowerCase() === entry.toLowerCase());
  if (m === undefined) return null;
  const lines = helper.text.split('\n');
  const body = lines.slice(m.line, m.endLine).join('\n');
  const offset = lines.slice(0, m.line).join('\n').length + 1;
  const others = [...names].filter((n) => n !== entry.toLowerCase());
  if (others.length === 0) return null;
  const re = new RegExp(`\\b(${others.join('|')})\\s*\\(`, 'gi');
  const objects: string[] = [];
  let unresolved = 0;
  for (const call of body.matchAll(re)) {
    const at = (call.index ?? 0) + call[0].length;
    const args = splitArgs(body.slice(at));
    const before = helper.text.slice(0, offset + (call.index ?? 0));
    const hit = args.map((a) => objectOfArg(a, before, helper.text, objectByLower)).find((o) => o !== null) ?? null;
    if (hit !== null) objects.push(hit);
    else unresolved += 1;
  }
  return objects.length === 0 && unresolved === 0 ? null : { objects, unresolved };
};

/** Method names of the helper class that (transitively) delegate to `method` — its overloads and wrappers. */
const delegatingMethods = (helper: ClassSource, method: string): Set<string> => {
  const names = new Set<string>([method.toLowerCase()]);
  const lines = helper.text.split('\n');
  // A method's body, without its own declaration line (which names itself).
  const bodyOf = (m: ApexMethodNode): string => lines.slice(m.line, m.endLine).join('\n');
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of helper.methods) {
      const name = m.name.toLowerCase();
      if (names.has(name)) continue;
      const body = bodyOf(m);
      if ([...names].some((target) => new RegExp(`\\b${target}\\s*\\(`, 'i').test(body))) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
};

/**
 * Resolve one generic DML fact for the given callers (component ids that can
 * reach the helper class: reachable Apex, OmniStudio components).
 */
export const resolveGenericDml = async (
  ctx: Context,
  fact: ApexDmlFact,
  /** The callers that count; `null` = every caller except test classes. */
  callers: ReadonlySet<string> | null,
  objectByLower: ReadonlyMap<string, string>,
): Promise<GenericDmlResolution> => {
  const helperNode = await getNodeById(ctx.graph, fact.componentId as ComponentId);
  if (!helperNode.ok || helperNode.value === null || fact.method === null) {
    return { status: 'open', objects: [], sites: 0, resolvedSites: 0, unresolved: ['the DML is not inside a named method'] };
  }
  const helper = await loadClass(ctx, helperNode.value);
  if (helper === null) return { status: 'open', objects: [], sites: 0, resolvedSites: 0, unresolved: ['the helper source is unreadable'] };
  const names = delegatingMethods(helper, fact.method);
  const className = helperNode.value.apiName;
  const incoming = await listEdges(ctx.graph, fact.componentId as ComponentId, { direction: 'in', edgeType: 'callsApex' });
  let edges: Edge[] = incoming.ok ? incoming.value.filter((e) => e.fromId !== fact.componentId && (callers === null || callers.has(e.fromId))) : [];
  if (callers === null) {
    const kept: Edge[] = [];
    for (const e of edges) {
      const n = await getNodeById(ctx.graph, e.fromId as ComponentId);
      if (n.ok && n.value !== null && n.value.properties['isTest'] === true) continue;
      kept.push(e);
    }
    edges = kept;
  }
  const objects = new Set<string>();
  const unresolved: string[] = [];
  let sites = 0;
  let resolvedSites = 0;
  let anyEdgeWithoutMethods = false;
  let reached = false;
  for (const e of edges) {
    const methods = Array.isArray(e.properties['methods']) ? (e.properties['methods'] as string[]).map((m) => m.toLowerCase()) : null;
    if (e.properties['entryVia'] === 'omnistudio-remote') {
      // OmniStudio enters through invokeMethod / call; the ROUTED name selects
      // the path, so only a routed method on the DML method's delegation chain
      // reaches it.
      const callSites = Array.isArray(e.properties['callSites']) ? (e.properties['callSites'] as Record<string, unknown>[]) : [];
      for (const s of callSites) {
        const routed = typeof s['remoteMethod'] === 'string' ? (s['remoteMethod'] as string).trim() : '';
        // A routed name that IS another method of the class takes that path, not
        // this one. A routed name that is no method name (invokeMethod dispatches
        // on the string) may reach it — counted, conservatively.
        const routedIsMethod = helper.methods.some((x) => x.name.toLowerCase() === routed.toLowerCase());
        if (routedIsMethod && !names.has(routed.toLowerCase())) continue;
        reached = true;
        sites += 1;
        const args = Array.isArray(s['objectArgs']) ? (s['objectArgs'] as string[]) : [];
        const resolved = args.map((a) => objectByLower.get(a.toLowerCase())).filter((o): o is string => o !== undefined);
        if (resolved.length > 0) {
          resolvedSites += 1;
          for (const o of resolved) objects.add(o);
          continue;
        }
        // No literal object: resolve inside the routed method, where it calls the chain.
        const inside = resolveInsideMethod(helper, routed, names, objectByLower);
        if (inside !== null && inside.unresolved === 0) {
          resolvedSites += 1;
          for (const o of inside.objects) objects.add(o);
        } else {
          unresolved.push(`${e.fromId} → ${routed} passes no literal object${inside === null ? '' : ' and the routed method does not show one'}`);
        }
      }
      continue;
    }
    if (methods === null || methods.length === 0) {
      anyEdgeWithoutMethods = true;
    } else if (!methods.some((m) => names.has(m))) {
      continue; // this caller invokes other methods of the helper
    }
    const callerNode = await getNodeById(ctx.graph, e.fromId as ComponentId);
    if (!callerNode.ok || callerNode.value === null) continue;
    const caller = await loadClass(ctx, callerNode.value);
    if (caller === null) {
      unresolved.push(`${e.fromId}: source unreadable`);
      reached = true;
      continue;
    }
    const re = new RegExp(`\\b${className}\\s*\\.\\s*(${[...names].join('|')})\\s*\\(`, 'gi');
    for (const m of caller.text.matchAll(re)) {
      reached = true;
      sites += 1;
      const at = (m.index ?? 0) + m[0].length;
      const args = splitArgs(caller.text.slice(at));
      const before = caller.text.slice(0, m.index ?? 0);
      const hit = args.map((a) => objectOfArg(a, before, caller.text, objectByLower)).find((o) => o !== null) ?? null;
      if (hit !== null) {
        resolvedSites += 1;
        objects.add(hit);
      } else {
        const line = before.split('\n').length;
        unresolved.push(`${e.fromId} line ${line}: ${className}.${m[1] as string}(${args.join(', ').slice(0, 80)})`);
      }
    }
  }
  if (!reached) {
    // Only a call graph that names its methods can prove the DML method is not reached.
    if (anyEdgeWithoutMethods || edges.length === 0) {
      return edges.length === 0
        ? { status: 'not-reached', objects: [], sites: 0, resolvedSites: 0, unresolved: [] }
        : { status: 'open', objects: [], sites: 0, resolvedSites: 0, unresolved: ['a caller edge does not name the methods it calls'] };
    }
    return { status: 'not-reached', objects: [], sites: 0, resolvedSites: 0, unresolved: [] };
  }
  const status = unresolved.length === 0 && sites > 0 ? 'closed' : 'open';
  return { status, objects: [...objects].sort(), sites, resolvedSites, unresolved: unresolved.slice(0, 5) };
};
