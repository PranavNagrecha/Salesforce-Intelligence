/**
 * Apex DML index — every DML site in the vault's Apex, with the objects its
 * enclosing method names.
 *
 * The Apex structure parse (`parseApexStructure`) finds each DML statement and
 * `Database.<op>(…)` call with its line and enclosing method, but not the
 * SObject type it acts on: that needs type resolution the single-file parse
 * does not do. This index attributes a site to an object the honest way the
 * source allows — the object api names that appear in the ENCLOSING METHOD
 * (comments stripped; string literals kept, since a dynamic SOQL string is real
 * evidence) and the objects its inline SOQL selects from. Attribution is
 * therefore `inferred`, never `parsed`: a method that names two objects and
 * deletes one is attributed to both.
 *
 * A site whose method names no object but handles records generically
 * (`SObject`, `getSObjectType()`, `newSObject(…)`, `Schema.getGlobalDescribe()`)
 * is marked `generic`: it acts on whatever records it is handed, so it can act
 * on ANY object — the caller reports it as `unknown`, never as "does not touch X".
 *
 * Test classes are skipped (their DML builds fixtures, it is not a runtime
 * path). The index is built once per vault refresh and operation set and
 * cached in-process.
 */

import { readFile } from 'node:fs/promises';

import type { Node } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { type ApexDmlOperation, type ApexMethodNode, parseApexStructure } from '@sf-intelligence/parsers';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import type { Context } from '../server.js';

import { scanAllNodesOfTypes } from './scan-all-nodes.js';

/** One DML site, attributed to the objects its enclosing method names. */
export interface ApexDmlFact {
  readonly componentId: string;
  readonly componentType: 'ApexClass' | 'ApexTrigger';
  readonly sourcePath: string;
  readonly line: number;
  readonly operation: ApexDmlOperation;
  /** `event-publish`: `EventBus.publish(…)` — publishing a platform event is an insert of that event. */
  readonly form: 'statement' | 'database-method' | 'event-publish';
  /** Enclosing method or constructor; `null` in a trigger body or an initializer. */
  readonly method: string | null;
  /** The enclosing method's annotations (`@AuraEnabled`, `@InvocableMethod`, …). */
  readonly methodAnnotations: readonly string[];
  readonly methodVisibility: string | null;
  /** The sharing keyword written on the class (`null` when none was written). */
  readonly sharing: string | null;
  /** The statement text (first line, trimmed, at most 160 characters). */
  readonly statement: string;
  /** Vault objects named in the enclosing method (whole file when there is none), sorted. */
  readonly objectsNamed: readonly string[];
  /** Objects the enclosing method's inline SOQL selects from, sorted. */
  readonly objectsQueried: readonly string[];
  /**
   * The object the DML OPERAND is typed as, when the source shows it: a
   * variable declared `X v` / `List<X> v` / `X[] v` / `Map<…, X> v` (operand
   * `v` or `v.values()`), `new X(…)`, or an inline `[SELECT … FROM X]`. The
   * strongest attribution the single-file parse allows; empty when the
   * operand's type is not visible (or is not a vault object).
   */
  readonly objectsTyped: readonly string[];
  /** True when the operand is typed as a generic `SObject` (or a collection of them). */
  readonly operandGeneric: boolean;
  /** Names no object but handles records generically: it can act on any object. */
  readonly generic: boolean;
  /** The access level written on the operation (the parser's `ApexDmlSite.accessLevel`). */
  readonly accessLevel: 'user' | 'system' | null;
  /** Trigger only: the object the trigger is on. */
  readonly triggerObject: string | null;
  /** `method` when attribution used the enclosing method's text, `file` when it fell back to the whole file. */
  readonly attributionScope: 'method' | 'file';
}

/** The built index. */
export interface ApexDmlIndex {
  readonly facts: readonly ApexDmlFact[];
  /** Apex classes and triggers scanned (test classes excluded). */
  readonly scanned: number;
  /** Of those, how many contained one of the operations and were parsed. */
  readonly parsed: number;
  /** Components whose source could not be read. */
  readonly unreadable: readonly string[];
  /** Components whose source did not parse — their DML is invisible here. */
  readonly unparsed: readonly string[];
  /** True when the node scan hit its cap — some Apex was not scanned. */
  readonly scanIncomplete: boolean;
}

const OPERATION_WORDS: Readonly<Record<ApexDmlOperation, string>> = {
  insert: 'insert',
  update: 'update',
  upsert: 'upsert',
  delete: 'delete',
  undelete: 'undelete',
  merge: 'merge',
};

const GENERIC_MARKERS = /\bSObject\b|getSObjectType\s*\(|newSObject\s*\(|getGlobalDescribe\s*\(/i;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Blank out `//` and `/* *\/` comments, keeping every newline (line numbers stay
 * valid) and every string literal (Apex strings are single-quoted with `\`
 * escapes).
 */
export const stripApexComments = (src: string): string => {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'" && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i += 1) out += src[i] === '\n' ? '\n' : ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
};

/** The statement starting at `line`, up to its `;` (at most five lines). */
const statementAt = (lines: readonly string[], line: number): string => {
  const parts: string[] = [];
  for (let i = line - 1; i < Math.min(lines.length, line + 4); i += 1) {
    const l = lines[i] ?? '';
    const semi = l.indexOf(';');
    parts.push(semi === -1 ? l : l.slice(0, semi + 1));
    if (semi !== -1) break;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

const DML_STATEMENT_OPERAND = /^\s*(?:insert|update|upsert|delete|undelete|merge)\s+(?:as\s+(?:user|system)\s+)?(.+?)\s*;?\s*$/i;
const DATABASE_OPERAND = /\bDatabase\s*\.\s*(?:insert|update|upsert|delete|undelete|merge)\s*\(\s*(.+)$/i;

/** The DML operand expression of a statement (`insert rows;` → `rows`), or null. */
export const dmlOperand = (statement: string, form: 'statement' | 'database-method'): string | null => {
  if (form === 'statement') {
    const m = DML_STATEMENT_OPERAND.exec(statement);
    if (m === null) return null;
    // `upsert rows External_Id__c;` — the operand is the first token.
    const operand = (m[1] ?? '').trim();
    return operand.startsWith('[') || operand.startsWith('new ') ? operand : (operand.split(/\s+/)[0] ?? null);
  }
  const m = DATABASE_OPERAND.exec(statement);
  if (m === null) return null;
  // First argument: up to the first comma / closing parenthesis at depth 0.
  const rest = m[1] ?? '';
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    if (c === '(' || c === '[' || c === '{' || c === '<') depth += 1;
    else if (c === ')' || c === ']' || c === '}' || c === '>') {
      if (depth === 0) return rest.slice(0, i).trim();
      depth -= 1;
    } else if (c === ',' && depth === 0) return rest.slice(0, i).trim();
  }
  return rest.trim();
};

/** The first argument of `EventBus.publish(…)` in a statement, or null. */
const publishOperand = (statement: string): string | null => {
  const m = /\bEventBus\s*\.\s*publish\s*\(\s*(.+)$/i.exec(statement);
  if (m === null) return null;
  return dmlOperand(`Database.insert(${m[1] as string}`, 'database-method');
};

/**
 * The type names a DML operand is declared as, read from the surrounding code:
 * `new X(…)` / `new List<X>{…}` / `new X[]{…}`, an inline `[SELECT … FROM X]`,
 * or the declaration of the operand variable (`X v`, `List<X> v`, `Set<X> v`,
 * `X[] v`, `Map<K, X> v` for `v.values()`). Returns raw type names.
 */
export const operandTypeNames = (operand: string, scopeText: string, fileText: string): string[] => {
  const op = operand.trim();
  const newForm = /^new\s+(?:List\s*<\s*([\w.]+)\s*>|([\w.]+)\s*\[\s*\]|([\w.]+)\s*\()/i.exec(op);
  if (newForm !== null) return [newForm[1] ?? newForm[2] ?? newForm[3] ?? ''].filter((t) => t.length > 0);
  const soql = /^\[\s*select\b[\s\S]*?\bfrom\s+([\w.]+)/i.exec(op);
  if (soql !== null) return [soql[1] as string];
  const ident = /^(?:this\.)?([A-Za-z_][A-Za-z0-9_]*)(\.values\(\))?$/.exec(op);
  if (ident === null) return [];
  const v = ident[1] as string;
  const isValues = ident[2] !== undefined;
  const esc = v.replace(/[$]/g, '\\$&');
  const decls = isValues
    ? [new RegExp(`\\bMap\\s*<\\s*[\\w.]+\\s*,\\s*([\\w.]+)\\s*>\\s+${esc}\\b`, 'i')]
    : [
        new RegExp(`\\b(?:List|Set)\\s*<\\s*([\\w.]+)\\s*>\\s+${esc}\\b`, 'i'),
        new RegExp(`\\b([\\w.]+)\\s*\\[\\s*\\]\\s+${esc}\\b`, 'i'),
        new RegExp(`\\b([A-Za-z_][\\w.]*)\\s+${esc}\\s*(?:=|;|,|\\))`, 'i'),
      ];
  for (const text of [scopeText, fileText]) {
    for (const re of decls) {
      const global = new RegExp(re.source, 'gi');
      for (const m of text.matchAll(global)) {
        const t = m[1] ?? '';
        if (!NOT_A_TYPE.test(t)) return [t];
      }
    }
  }
  return [];
};

/** Words the declaration patterns can capture that are not type names. */
const NOT_A_TYPE = /^(return|new|else|throw|insert|update|upsert|delete|undelete|merge|as|user|system|final|static|transient|public|private|protected|global)$/i;

const enclosingMethod = (methods: readonly ApexMethodNode[], name: string | null, line: number): ApexMethodNode | null => {
  if (name === null) return null;
  let best: ApexMethodNode | null = null;
  for (const m of methods) {
    if (m.name !== name || m.line > line || m.endLine < line) continue;
    if (best === null || m.line > best.line) best = m;
  }
  return best;
};

/**
 * Does this DML site act on `object`? `typed` when the operand is declared as
 * the object (strongest); `named` when the operand's type is not visible and the
 * enclosing method names or queries the object (weaker); `generic` when the site
 * acts on whatever records it is handed (it may act on the object); `no`
 * otherwise. Every answer is `inferred` — the parse does not type-check.
 */
export const dmlActsOn = (fact: ApexDmlFact, object: string): 'typed' | 'named' | 'generic' | 'no' => {
  const lower = object.toLowerCase();
  if (fact.objectsTyped.length > 0) return fact.objectsTyped.some((o) => o.toLowerCase() === lower) ? 'typed' : 'no';
  if (fact.operandGeneric || fact.generic) return 'generic';
  return [...fact.objectsNamed, ...fact.objectsQueried].some((o) => o.toLowerCase() === lower) ? 'named' : 'no';
};

const cache = new Map<string, Promise<Result<ApexDmlIndex, { message: string }>>>();

/**
 * Build (or reuse) the DML index for the given operations. The prefilter reads
 * every Apex file but parses only those whose text contains one of the
 * operation words.
 */
export const buildApexDmlIndex = (
  ctx: Context,
  operations: readonly ApexDmlOperation[],
): Promise<Result<ApexDmlIndex, { message: string }>> => {
  const ops = [...new Set(operations)].sort();
  const key = `${ctx.vaultRoot}|${ctx.manifest.refreshedAt}|${ctx.manifest.sourceTreeHash}|${ops.join(',')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const built = build(ctx, ops);
  cache.set(key, built);
  if (cache.size > 8) cache.delete(cache.keys().next().value as string);
  return built;
};

const build = async (
  ctx: Context,
  ops: readonly ApexDmlOperation[],
): Promise<Result<ApexDmlIndex, { message: string }>> => {
  const scan = await scanAllNodesOfTypes(ctx.graph, ['ApexClass', 'ApexTrigger', 'CustomObject']);
  if (!scan.ok) return scan;
  const objectByLower = new Map<string, string>();
  const apex: Node[] = [];
  for (const n of scan.value.nodes) {
    if (n.type === 'CustomObject') objectByLower.set(n.apiName.toLowerCase(), n.apiName);
    else if (n.properties['isTest'] !== true) apex.push(n);
  }
  apex.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const wanted = new Set<string>(ops);
  const prefilter = new RegExp(`\\b(${ops.map((o) => OPERATION_WORDS[o]).join('|')})\\b${ops.includes('insert') ? '|EventBus\\s*\\.\\s*publish' : ''}`, 'i');

  const facts: ApexDmlFact[] = [];
  const unreadable: string[] = [];
  const unparsed: string[] = [];
  let parsed = 0;
  for (const node of apex) {
    if (node.sourcePath === null || node.sourcePath.length === 0) {
      unreadable.push(node.id);
      continue;
    }
    let source: string;
    try {
      source = await readFile(resolveVaultSourcePath(ctx.vaultRoot, node.sourcePath), 'utf-8');
    } catch {
      unreadable.push(node.id);
      continue;
    }
    if (!prefilter.test(source)) continue;
    const kind = node.type === 'ApexTrigger' ? 'trigger' : 'class';
    const result = await parseApexStructure(source, { kind });
    if (!result.parsed || result.structure === null) {
      unparsed.push(node.id);
      continue;
    }
    parsed += 1;
    const structure = result.structure;
    // A class whose own declaration says @isTest is a test even when the node
    // property was not recorded.
    if (structure.annotations.some((a) => /^@istest\b/i.test(a))) continue;
    const code = stripApexComments(source);
    const lines = code.split('\n');
    const rawLines = source.split('\n');
    const namesIn = (text: string): string[] => {
      const found = new Set<string>();
      for (const m of text.matchAll(IDENT)) {
        const hitName = objectByLower.get(m[0].toLowerCase());
        if (hitName !== undefined) found.add(hitName);
      }
      return [...found].sort();
    };
    // `EventBus.publish(…)` publishes a platform event: an insert of that event type.
    const publishSites: typeof structure.dmlSites = wanted.has('insert')
      ? [...code.matchAll(/\bEventBus\s*\.\s*publish\s*\(/gi)].map((m) => {
          const line = code.slice(0, m.index ?? 0).split('\n').length;
          const owner = structure.methods.find((x) => x.line <= line && x.endLine >= line && x.hasBody !== false) ?? null;
          return {
            line,
            operation: 'insert' as const,
            form: 'database-method' as const,
            resultDiscarded: null,
            allOrNone: null,
            accessLevel: null,
            inMethod: owner?.name ?? null,
            inLoopBody: false,
            loopLine: null,
          };
        })
      : [];
    const publishSet = new Set<object>(publishSites);
    for (const site of [...structure.dmlSites, ...publishSites]) {
      if (!wanted.has(site.operation)) continue;
      const isPublish = publishSet.has(site);
      const method = enclosingMethod(structure.methods, site.inMethod, site.line);
      const scopeText = method === null ? code : lines.slice(method.line - 1, method.endLine).join('\n');
      const objectsNamed = namesIn(scopeText);
      const objectsQueried = [
        ...new Set(
          structure.soqlSites
            .filter((q) => (method === null ? q.inMethod === null : q.line >= method.line && q.line <= method.endLine))
            .flatMap((q) => q.objects)
            .map((o) => objectByLower.get(o.toLowerCase()) ?? o),
        ),
      ].sort();
      const statement = statementAt(lines, site.line);
      const operand = isPublish ? publishOperand(statement) : dmlOperand(statement, site.form);
      const typeNames = operand === null ? [] : operandTypeNames(operand, scopeText, code);
      const operandGeneric = typeNames.some((t) => /^sobject$/i.test(t));
      const objectsTyped = [
        ...new Set(typeNames.map((t) => objectByLower.get(t.toLowerCase())).filter((t): t is string => t !== undefined)),
      ].sort();
      facts.push({
        componentId: node.id,
        componentType: node.type === 'ApexTrigger' ? 'ApexTrigger' : 'ApexClass',
        sourcePath: node.sourcePath,
        line: site.line,
        operation: site.operation,
        form: isPublish ? 'event-publish' : site.form,
        method: site.inMethod,
        methodAnnotations: method?.annotations ?? [],
        methodVisibility: method?.visibility ?? null,
        sharing: structure.sharing,
        statement: (statementAt(rawLines, site.line) || statement).slice(0, 160),
        objectsNamed,
        objectsQueried,
        objectsTyped,
        operandGeneric,
        generic:
          operandGeneric ||
          (objectsTyped.length === 0 && objectsNamed.length === 0 && objectsQueried.length === 0 && GENERIC_MARKERS.test(scopeText)),
        accessLevel: site.accessLevel,
        triggerObject: structure.trigger?.object ?? null,
        attributionScope: method === null ? 'file' : 'method',
      });
    }
  }
  facts.sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : a.line - b.line));
  return ok({
    facts,
    scanned: apex.length,
    parsed,
    unreadable: unreadable.sort(),
    unparsed: unparsed.sort(),
    scanIncomplete: scan.value.incompleteTypes.length > 0,
  });
};
