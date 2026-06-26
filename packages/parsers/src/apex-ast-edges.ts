/**
 * P13-AST-edges — parser-grade Apex edge extraction (flag-gated).
 *
 * Two passes over the ANTLR tree the spike vendored:
 *   1. SYMBOLS — field/local/parameter/for-each declarations (name → type),
 *      own + inner class names, method names, the extends target.
 *   2. RESOLUTION — dot-chains resolve their receiver through the symbol
 *      table: SObject-typed receivers yield field reads/writes (assignment
 *      LHS = write, everything else = read), class-typed receivers yield
 *      method calls; bare calls matching own methods are self-calls; SOQL
 *      blocks (inline AND constant-string `Database.query` /
 *      `getQueryLocator` literals) yield field-level reads.
 *
 * Validated against the 30-class golden corpus (100% — the gate's
 * `harness:ast-goldens` judges this module on every run). Like the spike,
 * this is a DELIBERATE subpath module: the refresh wires it only behind
 * `--apex-ast` via a lazy import, so the default bundle and behavior are
 * byte-identical. A parse failure never throws — callers fall back to the
 * regex scanner per file.
 */

import {
  ApexErrorListener,
  ApexParserFactory,
} from '@apexdevtools/apex-parser';

/** Edge sets extracted from one Apex file. */
export interface ApexAstEdges {
  /** Cross-class method calls as `Class.method` (system calls allowlisted: Database.*, Type.forName, System.enqueueJob/schedule, Http.send). */
  readonly calls: readonly string[];
  /** Field reads as `Object.Field[...]` (dot chains kept verbatim after the root type). */
  readonly reads: readonly string[];
  /** Field writes as `Object.Field` (assignment left-hand sides). */
  readonly writes: readonly string[];
  /** First syntax error when the file did not parse — caller falls back to the scanner. */
  readonly parseError?: string;
  /**
   * INNER class names declared in this file (P14-USAGE-scanner-fp-downgrade):
   * the AST proves these receivers are class types, not sObjects — the
   * heuristic scanner's `CustomField:{InnerType}.{prop}` edges keyed on them
   * are typed false positives the import dedupe drops.
   */
  readonly innerTypes?: readonly string[];
}

export interface ApexAstOptions {
  /** Known user class names (the vault's Apex roster) — receivers resolving to these become calls. */
  readonly knownClasses?: ReadonlySet<string>;
  /**
   * Parse entry point. Pass it from the FILE EXTENSION (.trigger) — content
   * sniffing fails on trigger files that open with a comment (half the
   * real-org triggers we measured do; generated dlrs triggers always do),
   * sending them down the class grammar and into a needless scanner
   * fallback.
   */
  readonly kind?: 'class' | 'trigger';
}

const SYSTEM_TYPES = new Set([
  'String', 'Integer', 'Decimal', 'Double', 'Long', 'Boolean', 'Id', 'Date',
  'Datetime', 'Time', 'Blob', 'Object', 'List', 'Map', 'Set', 'Math', 'JSON',
  'Test', 'Schema', 'UserInfo', 'Limits', 'EncodingUtil', 'Pattern', 'Matcher',
  'Url', 'PageReference', 'Exception', 'AggregateResult', 'SObject',
  'HttpRequest', 'HttpResponse', 'QueueableContext', 'SchedulableContext',
  'Savepoint', 'System', 'Database', 'Type', 'Http', 'Trigger',
]);

const SYSTEM_CALL_ALLOW: Readonly<Record<string, ReadonlySet<string> | '*'>> = {
  Database: '*',
  Type: new Set(['forName']),
  System: new Set(['enqueueJob', 'schedule', 'scheduleBatch']),
  Http: new Set(['send']),
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const kids = (n: Ctx): Ctx[] =>
  Array.from({ length: (n.getChildCount?.() as number) ?? 0 }, (_, i) => n.getChild(i));
const ctxName = (n: Ctx): string => String(n.constructor.name).replace(/Context$/, '');
const findAll = (n: Ctx, want: string, out: Ctx[] = []): Ctx[] => {
  if (ctxName(n) === want) out.push(n);
  for (const c of kids(n)) findAll(c, want, out);
  return out;
};

/**
 * Walk `node` upward via the ANTLR `parentCtx` link until `pred` matches an
 * ancestor (returned) or the walk crosses one of the `stopAt` rule names
 * (returns null — the boundary's own node is checked first so a stop name can
 * also be the match). Guards a missing parent link to avoid an infinite loop.
 */
const ancestorWhere = (
  node: Ctx,
  pred: (ctx: Ctx) => boolean,
  stopAt: ReadonlySet<string> = new Set(),
): Ctx | null => {
  let cur: Ctx | undefined = node.parentCtx as Ctx | undefined;
  while (cur !== undefined && cur !== null) {
    if (pred(cur)) return cur;
    if (stopAt.has(ctxName(cur))) return null;
    cur = cur.parentCtx as Ctx | undefined;
  }
  return null;
};

class Collecting extends ApexErrorListener {
  public readonly errors: string[] = [];
  public apexSyntaxError(line: number, column: number, message: string): void {
    if (this.errors.length < 3) this.errors.push(`${line}:${column} ${message}`);
  }
}

/**
 * Extract parsed-confidence edges from one Apex source.
 *
 * @example
 *   const e = extractApexAstEdges(src, 'AccountService', { knownClasses });
 *   if (e.parseError) fallBackToScanner();
 */
export const extractApexAstEdges = (
  source: string,
  className: string,
  options: ApexAstOptions = {},
): ApexAstEdges => {
  const known = options.knownClasses ?? new Set<string>();
  const listener = new Collecting();
  let tree: Ctx;
  try {
    const parser = ApexParserFactory.createParser(source);
    parser.removeErrorListeners();
    parser.addErrorListener(listener);
    const kind =
      options.kind ??
      (source.trimStart().toLowerCase().startsWith('trigger') ? 'trigger' : 'class');
    tree = kind === 'trigger' ? parser.triggerUnit() : parser.compilationUnit();
  } catch (cause) {
    return {
      calls: [], reads: [], writes: [],
      parseError: `parser runtime failure: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (listener.errors.length > 0) {
    return { calls: [], reads: [], writes: [], parseError: listener.errors[0] as string };
  }

  // ---- pass 1: symbols -----------------------------------------------------
  const varTypes = new Map<string, string>();
  const ownMethods = new Set<string>();
  const innerClasses = new Map<string, string>();
  let extendsType: string | null = null;

  findAll(tree, 'ClassDeclaration').forEach((cd, idx) => {
    const cname = findAll(cd, 'Id')[0]?.getText() as string | undefined;
    if (idx > 0 && cname !== undefined) innerClasses.set(cname, `${className}.${cname}`);
    const kidList = kids(cd);
    const ext = kidList.findIndex((k) => k.getText?.() === 'extends');
    if (idx === 0 && ext >= 0) extendsType = (kidList[ext + 1]?.getText() as string) ?? null;
  });
  for (const md of findAll(tree, 'MethodDeclaration')) {
    const id = kids(md).find((k) => ctxName(k) === 'Id')?.getText() as string | undefined;
    if (id !== undefined) ownMethods.add(id.toLowerCase());
  }
  const declareVar = (typeText: string | undefined, varName: string | undefined): void => {
    if (typeText === undefined || varName === undefined || typeText.length === 0) return;
    varTypes.set(varName.toLowerCase(), typeText.trim());
  };
  for (const fd of findAll(tree, 'FieldDeclaration')) {
    const t = kids(fd)[0]?.getText() as string | undefined;
    for (const vd of findAll(fd, 'VariableDeclarator')) declareVar(t, findAll(vd, 'Id')[0]?.getText());
  }
  for (const lv of findAll(tree, 'LocalVariableDeclaration')) {
    const t = (kids(lv).find((k) => ctxName(k) === 'TypeRef')?.getText() ?? kids(lv)[0]?.getText()) as string | undefined;
    for (const vd of findAll(lv, 'VariableDeclarator')) declareVar(t, findAll(vd, 'Id')[0]?.getText());
  }
  for (const fp of findAll(tree, 'FormalParameter')) {
    const ks = kids(fp);
    declareVar(ks[ks.length - 2]?.getText(), ks[ks.length - 1]?.getText());
  }
  for (const fc of findAll(tree, 'EnhancedForControl')) {
    const ks = kids(fc);
    declareVar(ks[0]?.getText(), ks[1]?.getText());
  }
  for (const pd of findAll(tree, 'PropertyDeclaration')) {
    declareVar(kids(pd)[0]?.getText(), findAll(pd, 'Id')[0]?.getText());
  }

  const calls = new Set<string>();
  const reads = new Set<string>();
  const writes = new Set<string>();

  const resolveType = (t: string): string => innerClasses.get(t) ?? t;
  const isSObjectish = (t: string | null | undefined): t is string =>
    t !== null && t !== undefined && !SYSTEM_TYPES.has(t) && !innerClasses.has(t) &&
    t !== className && !/[<>]/.test(t) && /^[A-Z]/.test(t) && !known.has(t);
  const isUserClass = (t: string): boolean =>
    t === className || innerClasses.has(t) || t === extendsType || known.has(t);
  const allowSystemCall = (cls: string, method: string): boolean => {
    const rule = SYSTEM_CALL_ALLOW[cls];
    if (rule === undefined) return false;
    return rule === '*' || rule.has(method);
  };

  // ---- SOQL (inline + constant-string) --------------------------------------
  //
  // Scope-aware, per-query-level attribution. A SOQL statement is a tree of
  // query scopes — the outer Query plus any SubQuery nodes — and a SELECT-list
  // field belongs to the NEAREST enclosing scope, keyed by THAT scope's FROM
  // object, never the textually-first FROM. Three field classes are dropped
  // (honest degradation — a heuristic parser cannot resolve them to a real
  // sObject.field, so emitting a parsed-confidence edge would be a phantom):
  //   1. FROM identifiers at any level (object/relationship names are not fields).
  //   2. Every field of a CHILD-relationship subquery `(SELECT .. FROM Contacts)`
  //      — its FROM names a relationship, not an sObject API name.
  //   3. Every field of a polymorphic `TYPEOF .. END` clause — the WHEN tokens
  //      are sObject type names and the THEN/ELSE fields belong to the
  //      unresolvable polymorphic target.
  // SEMI-JOIN subqueries `WHERE Id IN (SELECT .. FROM Contact)` keep their own
  // scope (their FROM is a real sObject), so their fields attribute to that
  // inner object, not the outer one. This mirrors the regex scanner's already-
  // correct SOQL oracle (apex-scanner.ts collectSoqlFroms).
  const FROM_OBJ = (scopeCtx: Ctx): string | undefined => {
    // Direct grammar accessor returns this scope's OWN outermost FROM; fall
    // back to a findAll filtered to NOT-under-a-nested-SubQuery for robustness
    // on contexts where the accessor is unexpectedly absent.
    const direct = scopeCtx.fromNameList?.() as Ctx | undefined;
    const list =
      direct ??
      findAll(scopeCtx, 'FromNameList').find(
        (fl) => (ancestorWhere(fl, (c) => ctxName(c) === 'SubQuery', new Set(['Query'])) ?? scopeCtx) === scopeCtx,
      );
    if (list === undefined || list === null) return undefined;
    const txt = findAll(list, 'FieldName')[0]?.getText() as string | undefined;
    return txt === undefined || txt.length === 0 ? undefined : txt;
  };

  const soqlFrom = (queryCtx: Ctx): void => {
    const SCOPE = new Set(['Query', 'SubQuery']);
    for (const fn of findAll(queryCtx, 'FieldName')) {
      // A FROM identifier (this field is itself inside a FromNameList) names an
      // object/relationship, never a field — skip at every level.
      if (ancestorWhere(fn, (c) => ctxName(c) === 'FromNameList', SCOPE) !== null) continue;
      // Polymorphic TYPEOF: WHEN type names + THEN/ELSE target fields are
      // unresolvable — drop the whole clause's fields.
      if (ancestorWhere(fn, (c) => ctxName(c) === 'TypeOf', SCOPE) !== null) continue;
      // Nearest enclosing scope: stop at the first SubQuery/Query boundary.
      const scope = ancestorWhere(fn, (c) => SCOPE.has(ctxName(c))) ?? queryCtx;
      if (ctxName(scope) === 'SubQuery') {
        // A CHILD-relationship subquery (the clause directly enclosing it is a
        // SELECT entry) cannot map its relationship FROM to an sObject — drop by
        // STRUCTURE, regardless of whether the FROM token happens to look like
        // an sObject. Only a subquery whose NEAREST enclosing clause is a WHERE
        // is a semi-join over a real sObject. Stop at the parent SubQuery/Query
        // boundary so a child-sub nested inside a semi-join's SELECT is not
        // misread as a semi-join via the outer WHERE.
        const semiJoin = ancestorWhere(
          scope,
          (c) => ctxName(c) === 'WhereClause',
          new Set(['Query', 'SubQuery']),
        );
        if (semiJoin === null) continue;
      }
      const obj = FROM_OBJ(scope);
      if (obj === undefined) continue;
      reads.add(`${obj}.${fn.getText()}`);
    }
  };
  for (const q of findAll(tree, 'Query')) soqlFrom(q);
  for (const lit of findAll(tree, 'LiteralPrimary')) {
    const t = lit.getText() as string;
    if (/^'\s*select\s/i.test(t)) {
      try {
        const qp = ApexParserFactory.createParser(t.slice(1, -1));
        qp.removeErrorListeners();
        const c = new Collecting();
        qp.addErrorListener(c);
        const qt = qp.query();
        if (c.errors.length === 0) soqlFrom(qt);
      } catch {
        // not a parseable constant query — runtime-dynamic; scanner territory
      }
    }
  }

  // ---- assignments (writes) --------------------------------------------------
  interface DotSeg { root: string; rootNode: Ctx; path: string[] }
  const dotSegments = (dot: Ctx): DotSeg | null => {
    const path: string[] = [];
    let cur: Ctx = dot;
    while (cur !== undefined && ctxName(cur) === 'DotExpression') {
      const ks = kids(cur);
      const tail = ks[ks.length - 1];
      if (ctxName(tail) === 'DotMethodCall') {
        const id = (findAll(tail, 'AnyId')[0]?.getText() ?? findAll(tail, 'Id')[0]?.getText()) as string | undefined;
        path.unshift(id ?? '');
      } else {
        path.unshift(tail.getText() as string);
      }
      cur = ks[0];
    }
    if (cur === undefined) return null;
    return { root: cur.getText() as string, rootNode: cur, path };
  };

  const writeRoots = new Set<Ctx>();
  for (const asg of findAll(tree, 'AssignExpression')) {
    const lhs = kids(asg)[0];
    if (lhs !== undefined && ctxName(lhs) === 'DotExpression') {
      writeRoots.add(lhs);
      const seg = dotSegments(lhs);
      if (seg !== null) {
        const t = varTypes.get(seg.root.toLowerCase());
        if (isSObjectish(t) && seg.path.length > 0) writes.add(`${t}.${seg.path.join('.')}`);
      }
    }
  }

  // ---- dot chains (reads + calls) ---------------------------------------------
  const allDots = findAll(tree, 'DotExpression');
  const nestedDots = new Set<Ctx>();
  for (const d of allDots) for (const c of kids(d)) if (ctxName(c) === 'DotExpression') nestedDots.add(c);

  for (const dot of allDots) {
    if (nestedDots.has(dot)) continue;
    const seg = dotSegments(dot);
    if (seg === null) continue;
    const rootLower = seg.root.toLowerCase();
    const tailIsCall = ctxName(kids(dot)[kids(dot).length - 1]) === 'DotMethodCall';
    const last = seg.path[seg.path.length - 1] ?? '';

    let recvType: string | null;
    if (/^new\s*/i.test(seg.root) || ctxName(seg.rootNode) === 'NewExpression') {
      recvType = seg.root.replace(/^new\s*/i, '').replace(/\(.*\)$/, '').replace(/[<>].*$/, '');
    } else if (rootLower === 'this') {
      recvType = className;
    } else if (rootLower === 'super') {
      recvType = extendsType;
    } else {
      recvType = varTypes.get(rootLower) ?? null;
    }

    if (tailIsCall) {
      if (recvType !== null) {
        if (isUserClass(recvType)) calls.add(`${resolveType(recvType)}.${last}`);
        else if (allowSystemCall(recvType, last)) calls.add(`${recvType}.${last}`);
      } else if (!varTypes.has(rootLower) && /^[A-Z]/.test(seg.root) && seg.path.length === 1) {
        if (allowSystemCall(seg.root, last)) calls.add(`${seg.root}.${last}`);
        else if (isUserClass(seg.root)) calls.add(`${resolveType(seg.root)}.${last}`);
      }
      if (isSObjectish(recvType) && seg.path.length > 1) {
        reads.add(`${recvType}.${seg.path.slice(0, -1).join('.')}`);
      }
    } else if (isSObjectish(recvType) && !writeRoots.has(dot)) {
      reads.add(`${recvType}.${seg.path.join('.')}`);
    }
  }

  // ---- bare calls (own methods / recursion) ------------------------------------
  for (const mc of findAll(tree, 'MethodCallExpression')) {
    const id = findAll(mc, 'Id')[0]?.getText() as string | undefined;
    if (id !== undefined && ownMethods.has(id.toLowerCase())) calls.add(`${className}.${id}`);
  }

  return {
    calls: [...calls].sort(),
    reads: [...reads].sort(),
    writes: [...writes].sort(),
    innerTypes: [...innerClasses.keys()].sort(),
  };
};
