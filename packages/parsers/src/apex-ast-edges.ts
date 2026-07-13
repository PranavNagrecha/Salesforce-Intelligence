/**
 * P13-AST-edges — parser-grade Apex edge extraction (flag-gated).
 *
 * Two passes over the ANTLR tree the spike vendored:
 *   1. SYMBOLS — class fields/properties (file-wide); method params / locals /
 *      for-each vars scoped per MethodDeclaration (params shadow fields);
 *      own-method return types; own + inner class names; extends target.
 *   2. RESOLUTION — dot-chains resolve their receiver through the scoped
 *      symbol table: SObject-typed receivers yield field reads/writes
 *      (assignment LHS = write, everything else = read), class-typed
 *      receivers yield method calls; own-method return types propagate
 *      through same-file call chains (`getAccount().Name`,
 *      `this.getAccount().Industry`); bare calls matching own methods are
 *      self-calls; SOQL blocks (inline AND constant-string `Database.query`
 *      / `getQueryLocator` literals) yield field-level reads.
 *
 * AST ≠ compiler (honesty floor — never over-claim):
 *   - Single-file only; cross-file inheritance fields/methods unresolved
 *     beyond the `knownClasses` name set + same-file `extends` token.
 *   - Own-method return types only (no cross-class return-type table;
 *     overloads collapse to last declaration).
 *   - Dynamic SOQL, reflection (`get`/`put`), and Type.forName dispatch
 *     remain invisible by design.
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
  /**
   * CR-CAP-06: per-call-site CALLER-method attribution. Each entry pairs a
   * cross-class (or self) `callee` (`Class.method`, the same string as in
   * `calls`) with the NAME of the enclosing `MethodDeclaration` that contains
   * the call-site (`callerMethod`, ORIGINAL case for display). A call-site with
   * NO enclosing method (field/static initializer, trigger body) carries
   * `callerMethod: ''` — the aggregator drops it (absent === unknown caller,
   * never a wrong attribution). ADDITIVE + AST-PATH-ONLY: the heuristic scanner
   * has no enclosing-method awareness and emits nothing here. Sorted by
   * `(callee, callerMethod)` for golden stability.
   */
  readonly callSites?: readonly {
    readonly callee: string;
    readonly callerMethod: string;
  }[];
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
  // Fields/properties are file-wide. Params + locals + for-each vars are
  // scoped per MethodDeclaration so `Account rec` in a() cannot collide with
  // `Contact rec` in b() (CTO #7 — file-global table was minting wrong
  // parsed-confidence field edges). Locals outside any method (static /
  // instance initializers) land in orphanLocals.
  const fieldTypes = new Map<string, string>();
  const methodLocals = new Map<Ctx, Map<string, string>>();
  const orphanLocals = new Map<string, string>();
  const ownMethods = new Set<string>();
  /** Own-method return types (lowercase name → type). Overloads: last wins. */
  const methodReturnTypes = new Map<string, string>();
  const innerClasses = new Map<string, string>();
  let extendsType: string | null = null;

  findAll(tree, 'ClassDeclaration').forEach((cd, idx) => {
    const cname = findAll(cd, 'Id')[0]?.getText() as string | undefined;
    if (idx > 0 && cname !== undefined) innerClasses.set(cname, `${className}.${cname}`);
    const kidList = kids(cd);
    const ext = kidList.findIndex((k) => k.getText?.() === 'extends');
    if (idx === 0 && ext >= 0) extendsType = (kidList[ext + 1]?.getText() as string) ?? null;
  });

  const scopeFor = (node: Ctx): Map<string, string> => {
    const md = ancestorWhere(node, (c) => ctxName(c) === 'MethodDeclaration');
    if (md === null) return orphanLocals;
    let scope = methodLocals.get(md);
    if (scope === undefined) {
      scope = new Map<string, string>();
      methodLocals.set(md, scope);
    }
    return scope;
  };
  const declareVar = (
    typeText: string | undefined,
    varName: string | undefined,
    scope: Map<string, string>,
  ): void => {
    if (typeText === undefined || varName === undefined || typeText.length === 0) return;
    scope.set(varName.toLowerCase(), typeText.trim());
  };

  for (const md of findAll(tree, 'MethodDeclaration')) {
    const id = kids(md).find((k) => ctxName(k) === 'Id')?.getText() as string | undefined;
    if (id === undefined) continue;
    ownMethods.add(id.toLowerCase());
    const ret = kids(md).find((k) => ctxName(k) === 'TypeRef')?.getText() as string | undefined;
    if (ret !== undefined && ret.length > 0) {
      methodReturnTypes.set(id.toLowerCase(), ret.trim());
    }
  }
  for (const fd of findAll(tree, 'FieldDeclaration')) {
    const t = kids(fd)[0]?.getText() as string | undefined;
    for (const vd of findAll(fd, 'VariableDeclarator')) {
      declareVar(t, findAll(vd, 'Id')[0]?.getText(), fieldTypes);
    }
  }
  for (const pd of findAll(tree, 'PropertyDeclaration')) {
    declareVar(kids(pd)[0]?.getText(), findAll(pd, 'Id')[0]?.getText(), fieldTypes);
  }
  for (const lv of findAll(tree, 'LocalVariableDeclaration')) {
    const t = (kids(lv).find((k) => ctxName(k) === 'TypeRef')?.getText() ?? kids(lv)[0]?.getText()) as string | undefined;
    for (const vd of findAll(lv, 'VariableDeclarator')) {
      declareVar(t, findAll(vd, 'Id')[0]?.getText(), scopeFor(lv));
    }
  }
  for (const fp of findAll(tree, 'FormalParameter')) {
    const typeText =
      (kids(fp).find((k) => ctxName(k) === 'TypeRef')?.getText() as string | undefined) ??
      (kids(fp)[kids(fp).length - 2]?.getText() as string | undefined);
    const varName =
      (kids(fp).find((k) => ctxName(k) === 'Id')?.getText() as string | undefined) ??
      (kids(fp)[kids(fp).length - 1]?.getText() as string | undefined);
    declareVar(typeText, varName, scopeFor(fp));
  }
  for (const fc of findAll(tree, 'EnhancedForControl')) {
    const ks = kids(fc);
    declareVar(ks[0]?.getText(), ks[1]?.getText(), scopeFor(fc));
  }

  /** Resolve a variable at a use-site: method locals/params shadow fields. */
  const resolveVarType = (name: string, at: Ctx): string | null => {
    const lower = name.toLowerCase();
    const md = ancestorWhere(at, (c) => ctxName(c) === 'MethodDeclaration');
    if (md !== null) {
      const scope = methodLocals.get(md);
      if (scope?.has(lower)) return scope.get(lower) ?? null;
    } else if (orphanLocals.has(lower)) {
      return orphanLocals.get(lower) ?? null;
    }
    return fieldTypes.get(lower) ?? null;
  };

  const calls = new Set<string>();
  const reads = new Set<string>();
  const writes = new Set<string>();
  // CR-CAP-06: parallel collector — keep `calls` byte-stable (dedupe /
  // innerTypes / scanner-fallback logic depends on it), record the enclosing
  // caller method per call-site separately. The enclosing method NAME is read
  // with the SAME accessor as the ownMethods seed (the first child `Id` of the
  // nearest `MethodDeclaration` ancestor), in ORIGINAL case for display.
  const callSites: { callee: string; callerMethod: string }[] = [];
  const recordCall = (callee: string, node: Ctx): void => {
    calls.add(callee);
    const md = ancestorWhere(node, (c) => ctxName(c) === 'MethodDeclaration');
    const cm =
      md === null
        ? undefined
        : (kids(md).find((k) => ctxName(k) === 'Id')?.getText() as string | undefined);
    callSites.push({ callee, callerMethod: cm ?? '' });
  };

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
  interface PathSeg { name: string; isCall: boolean }
  interface DotSeg { root: string; rootNode: Ctx; path: PathSeg[] }
  const dotSegments = (dot: Ctx): DotSeg | null => {
    const path: PathSeg[] = [];
    let cur: Ctx = dot;
    while (cur !== undefined && ctxName(cur) === 'DotExpression') {
      const ks = kids(cur);
      const tail = ks[ks.length - 1];
      if (ctxName(tail) === 'DotMethodCall') {
        const id = (findAll(tail, 'AnyId')[0]?.getText() ?? findAll(tail, 'Id')[0]?.getText()) as string | undefined;
        path.unshift({ name: id ?? '', isCall: true });
      } else {
        path.unshift({ name: tail.getText() as string, isCall: false });
      }
      cur = ks[0];
    }
    if (cur === undefined) return null;
    return { root: cur.getText() as string, rootNode: cur, path };
  };

  /**
   * Resolve the root of a dot-chain to a type name. Own-method call roots
   * (`getAccount().Name`) use the return-type table; variables use the
   * scoped symbol table.
   */
  const resolveRootType = (seg: DotSeg): string | null => {
    const rootLower = seg.root.toLowerCase();
    if (/^new\s*/i.test(seg.root) || ctxName(seg.rootNode) === 'NewExpression') {
      return seg.root.replace(/^new\s*/i, '').replace(/\(.*\)$/, '').replace(/[<>].*$/, '');
    }
    if (rootLower === 'this') return className;
    if (rootLower === 'super') return extendsType;
    if (ctxName(seg.rootNode) === 'MethodCallExpression') {
      const mid = findAll(seg.rootNode, 'Id')[0]?.getText() as string | undefined;
      if (mid === undefined || !ownMethods.has(mid.toLowerCase())) return null;
      return methodReturnTypes.get(mid.toLowerCase()) ?? null;
    }
    return resolveVarType(seg.root, seg.rootNode);
  };

  /**
   * Walk leading call segments. Same-file own-class receivers advance through
   * `methodReturnTypes`; cross-class / unknown receivers stop honestly (no
   * invented return type). When `record` is true, emits call edges for every
   * resolved call segment — including mid-chain calls that older code skipped
   * because they lived under a nested DotExpression.
   */
  const advanceCalls = (
    startType: string | null,
    path: PathSeg[],
    at: Ctx,
    record: boolean,
  ): { type: string | null; fieldStart: number } => {
    let type = startType;
    let i = 0;
    for (; i < path.length; i++) {
      const seg = path[i];
      if (seg === undefined || !seg.isCall) break;
      const method = seg.name;
      if (type === null) break;
      if (isUserClass(type)) {
        if (record) recordCall(`${resolveType(type)}.${method}`, at);
        // Only `className` has a return-type table in this file.
        if (type === className || resolveType(type) === className) {
          type = methodReturnTypes.get(method.toLowerCase()) ?? null;
        } else {
          type = null; // cross-class: no return-type table
        }
      } else if (allowSystemCall(type, method)) {
        if (record) recordCall(`${type}.${method}`, at);
        type = null;
      } else {
        type = null;
      }
    }
    return { type, fieldStart: i };
  };

  /**
   * Peel own-class instance fields (`this.mine.Name` → Account.Name). Only
   * `className`'s fieldTypes table is known — cross-file parent fields via
   * `super.x` stay unresolved (AST ≠ compiler).
   */
  const peelOwnFields = (
    startType: string | null,
    path: PathSeg[],
    from: number,
  ): { type: string | null; fieldStart: number } => {
    let type = startType;
    let i = from;
    while (i < path.length) {
      const seg = path[i];
      if (seg === undefined || seg.isCall) break;
      if (type !== className) break;
      const ft = fieldTypes.get(seg.name.toLowerCase());
      if (ft === undefined) break;
      type = ft;
      i += 1;
    }
    return { type, fieldStart: i };
  };

  const resolveChain = (
    rootType: string | null,
    path: PathSeg[],
    at: Ctx,
    record: boolean,
  ): { type: string | null; fieldStart: number } => {
    const afterCalls = advanceCalls(rootType, path, at, record);
    return peelOwnFields(afterCalls.type, path, afterCalls.fieldStart);
  };

  const writeRoots = new Set<Ctx>();
  for (const asg of findAll(tree, 'AssignExpression')) {
    const lhs = kids(asg)[0];
    if (lhs !== undefined && ctxName(lhs) === 'DotExpression') {
      writeRoots.add(lhs);
      const seg = dotSegments(lhs);
      if (seg !== null) {
        const rootType = resolveRootType(seg);
        // record=false: the read/call pass below owns callSites (avoids dupes).
        const { type, fieldStart } = resolveChain(rootType, seg.path, lhs, false);
        const fieldPath = seg.path.slice(fieldStart).filter((p) => !p.isCall).map((p) => p.name);
        if (isSObjectish(type) && fieldPath.length > 0) {
          writes.add(`${type}.${fieldPath.join('.')}`);
        }
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
    const rootType = resolveRootType(seg);

    // Static Class.method() with no prior receiver type (Database.query, etc.)
    const tailIsCall =
      seg.path.length > 0 && (seg.path[seg.path.length - 1]?.isCall === true);
    if (
      rootType === null &&
      resolveVarType(seg.root, seg.rootNode) === null &&
      /^[A-Z]/.test(seg.root) &&
      seg.path.length === 1 &&
      tailIsCall
    ) {
      const last = seg.path[0]?.name ?? '';
      if (allowSystemCall(seg.root, last)) recordCall(`${seg.root}.${last}`, dot);
      else if (isUserClass(seg.root)) recordCall(`${resolveType(seg.root)}.${last}`, dot);
      continue;
    }

    const { type, fieldStart } = resolveChain(rootType, seg.path, dot, true);
    const fieldPath = seg.path.slice(fieldStart).filter((p) => !p.isCall).map((p) => p.name);

    if (fieldPath.length > 0 && isSObjectish(type) && !writeRoots.has(dot)) {
      reads.add(`${type}.${fieldPath.join('.')}`);
    }

    // SObject receiver with a trailing method (e.g. acc.Parent.clone()) — keep
    // prior behavior: field path before the call is a read.
    if (
      isSObjectish(rootType) &&
      tailIsCall &&
      seg.path.length > 1 &&
      seg.path.slice(0, -1).every((p) => !p.isCall)
    ) {
      const before = seg.path.slice(0, -1).map((p) => p.name);
      if (before.length > 0) reads.add(`${rootType}.${before.join('.')}`);
    }
  }

  // ---- bare calls (own methods / recursion) ------------------------------------
  for (const mc of findAll(tree, 'MethodCallExpression')) {
    const id = findAll(mc, 'Id')[0]?.getText() as string | undefined;
    if (id !== undefined && ownMethods.has(id.toLowerCase())) recordCall(`${className}.${id}`, mc);
  }

  return {
    calls: [...calls].sort(),
    reads: [...reads].sort(),
    writes: [...writes].sort(),
    innerTypes: [...innerClasses.keys()].sort(),
    callSites: [...callSites].sort((a, b) =>
      a.callee < b.callee
        ? -1
        : a.callee > b.callee
          ? 1
          : a.callerMethod < b.callerMethod
            ? -1
            : a.callerMethod > b.callerMethod
              ? 1
              : 0,
    ),
  };
};
