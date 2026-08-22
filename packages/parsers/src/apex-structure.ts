/**
 * Parser-grade STRUCTURE projection of one Apex class or trigger.
 *
 * The sibling of {@link ./apex-ast-edges.js} — that module answers "what does
 * this file REFER TO" (graph edges); this one answers "what IS this file":
 * its members with their real signatures, the annotations that make it an
 * entry point, the sharing keyword it declares, and every SOQL / SOSL / DML /
 * callout / async-dispatch / dynamic-Apex SITE with a line number and whether
 * it sits inside a loop BODY.
 *
 * Both run on the same ANTLR grammar (`@apexdevtools/apex-parser`), which is
 * imported DYNAMICALLY here: the grammar is ~5 MB and the CLI bundle keeps it
 * external (INFRA-11), so a static import would make every `sfi` command pay
 * its module-init cost even when nothing asks for Apex structure. The import
 * happens on the first call and never at load time — hence the async entry
 * point.
 *
 * HONESTY FLOOR — this is a parser, not a compiler, and the difference is not
 * cosmetic:
 *
 *   - **Single file.** Nothing about a superclass, an implemented interface, or
 *     a called helper is known here. A method that delegates its DML to a
 *     helper class shows ZERO dml sites.
 *   - **No type inference across files.** Callout detection resolves an `Http`
 *     receiver only when the variable is declared `Http` IN THIS FILE (or the
 *     call is `new Http().send(...)`); a wrapper (`RestClient.post(...)`) is
 *     invisible.
 *   - **Dynamic Apex is opaque by construction.** `Database.query(s)`,
 *     `sObject.get('F')`, `Type.forName(n)` — the STRING is the program, and a
 *     static reader cannot see through it. Sites are REPORTED (so a caller can
 *     disclose the blind spot) but never resolved.
 *   - **A parse failure yields `structure: null`, never an empty structure.**
 *     "The parser could not read this file" and "this file declares nothing"
 *     are different facts and must never render the same.
 *
 * Every value in the projection is READ from the source. Nothing is defaulted
 * into existence: an absent access modifier is `visibilityDeclared: false`
 * (with the Apex language default reported separately), an unreadable SOQL
 * `FROM` name is an EMPTY `objects` list on a site that still exists, and a
 * trigger's object is `null` rather than a guess when the grammar did not
 * yield one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- ANTLR contexts are
   generated classes reached reflectively; the module's public surface is fully
   typed and this alias is confined to the walker helpers. */
type Ctx = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** One declared parameter of a method or constructor. */
export interface ApexParam {
  readonly name: string;
  /** Declared type verbatim (generics preserved, e.g. `Map<Id,Account>`). */
  readonly type: string;
}

/** Visibility as Apex models it. `null` is never emitted — see `declared`. */
export type ApexVisibility = 'global' | 'public' | 'protected' | 'private';

/** One method or constructor declared in the file (inner types included). */
export interface ApexMethodNode {
  readonly name: string;
  /** Rendered declaration, e.g. `public static void run(List<Account> rows)`. */
  readonly signature: string;
  /**
   * Declared return type verbatim, `'void'` when the `void` keyword is
   * present, or `null` for a CONSTRUCTOR — which has no return type to read.
   */
  readonly returnType: string | null;
  readonly params: readonly ApexParam[];
  /**
   * The visibility in force. When `visibilityDeclared` is false NO access
   * modifier was written and this is the Apex language default (`private`),
   * reported as a language rule — not as a modifier that was read.
   */
  readonly visibility: ApexVisibility;
  readonly visibilityDeclared: boolean;
  readonly isStatic: boolean;
  readonly isVirtual: boolean;
  readonly isAbstract: boolean;
  readonly isOverride: boolean;
  readonly isTestMethod: boolean;
  readonly isWebService: boolean;
  readonly isConstructor: boolean;
  /** Annotation source text including arguments, e.g. `@AuraEnabled(cacheable=true)`. */
  readonly annotations: readonly string[];
  /** Declaring type path — `MyClass` or `MyClass.InnerBuilder`. */
  readonly ownerType: string;
  readonly line: number;
  readonly endLine: number;
  /** False for an interface method or an `abstract` declaration — no body exists. */
  readonly hasBody: boolean;
}

/** One field or property declared on the type. */
export interface ApexMemberNode {
  readonly name: string;
  readonly type: string;
  readonly memberKind: 'field' | 'property';
  readonly visibility: ApexVisibility;
  readonly visibilityDeclared: boolean;
  readonly isStatic: boolean;
  readonly isFinal: boolean;
  readonly isTransient: boolean;
  readonly annotations: readonly string[];
  readonly ownerType: string;
  readonly line: number;
}

/** One nested type declared inside the file. */
export interface ApexInnerType {
  readonly name: string;
  readonly kind: 'class' | 'interface' | 'enum';
  readonly ownerType: string;
  readonly modifiers: readonly string[];
  readonly line: number;
  readonly methodCount: number;
}

/** Where a site sits relative to the enclosing method and any loop body. */
interface SiteContext {
  /**
   * Enclosing method / constructor name, or `null` when the site is in a
   * static / instance initializer or directly in a trigger body — absence
   * means "no enclosing method", never an unattributed guess.
   */
  readonly inMethod: string | null;
  /** True only when the site is inside a loop's BODY, not its control clause. */
  readonly inLoopBody: boolean;
  /** Line of the innermost enclosing loop whose body holds this site. */
  readonly loopLine: number | null;
}

/** One inline SOQL (`[SELECT …]`) or SOSL (`[FIND …]`) site. */
export interface ApexQuerySite extends SiteContext {
  readonly line: number;
  /**
   * Objects named in the query's `FROM` / `RETURNING` clause. EMPTY when the
   * grammar yielded no name — the site is still reported; the object is not
   * invented.
   */
  readonly objects: readonly string[];
  /**
   * True when the query's result is assigned straight to a NON-collection,
   * NON-primitive variable (`Account a = [SELECT …];`) — the shape that throws
   * `System.QueryException` on zero rows. False when it is assigned to a
   * `List`/`Set`/`Map`, to a primitive (a `COUNT()` query), or to nothing this
   * parser could tie to a declaration.
   */
  readonly assignedToSingleSObject: boolean;
}

/** DML operations the projection recognises. */
export type ApexDmlOperation =
  | 'insert'
  | 'update'
  | 'upsert'
  | 'delete'
  | 'undelete'
  | 'merge';

/** One DML site — a DML statement, or a `Database.<op>(…)` method call. */
export interface ApexDmlSite extends SiteContext {
  readonly line: number;
  readonly operation: ApexDmlOperation;
  readonly form: 'statement' | 'database-method';
  /**
   * `Database.<op>` only: true when the call is an expression statement, so
   * the returned `SaveResult[]` is discarded. `null` for the `statement` form,
   * which returns nothing and therefore has no result to discard.
   */
  readonly resultDiscarded: boolean | null;
  /**
   * `Database.<op>` only: the literal `allOrNone` argument when one was
   * written (`Database.insert(rows, false)` → `false`). `null` when the
   * argument is absent or not a literal — never defaulted to the platform's
   * `true`, because the point of the flag is that it was WRITTEN.
   */
  readonly allOrNone: boolean | null;
}

/** One recognised call site (callout, async dispatch, dynamic Apex). */
export interface ApexCallSite extends SiteContext {
  readonly line: number;
  /** The call expression, truncated to keep payloads bounded. */
  readonly expression: string;
  readonly kind: string;
}

/** One `catch` clause with the size of its block. */
export interface ApexCatchClause extends SiteContext {
  readonly line: number;
  readonly exceptionType: string | null;
  /** Statements in the catch block. 0 = the exception is swallowed. */
  readonly statementCount: number;
}

/** The parsed structure of one Apex file. */
export interface ApexTypeStructure {
  readonly kind: 'class' | 'interface' | 'enum' | 'trigger';
  readonly name: string;
  /** Declaration modifiers, normalised (`['public', 'with sharing']`). */
  readonly modifiers: readonly string[];
  /** Type-level annotation source text including arguments. */
  readonly annotations: readonly string[];
  /**
   * The sharing keyword actually written on the declaration, or `null` when
   * NONE was written. Never defaulted — "no keyword" is a distinct and
   * consequential state in Apex, not a synonym for `without sharing`.
   */
  readonly sharing: 'with sharing' | 'without sharing' | 'inherited sharing' | null;
  readonly superclass: string | null;
  readonly interfaces: readonly string[];
  /** Trigger only: the SObject and DML events. `null` for a class. */
  readonly trigger: {
    readonly object: string | null;
    readonly events: readonly string[];
  } | null;
  readonly methods: readonly ApexMethodNode[];
  readonly members: readonly ApexMemberNode[];
  readonly innerTypes: readonly ApexInnerType[];
  readonly soqlSites: readonly ApexQuerySite[];
  readonly soslSites: readonly ApexQuerySite[];
  readonly dmlSites: readonly ApexDmlSite[];
  readonly calloutSites: readonly ApexCallSite[];
  readonly asyncDispatchSites: readonly ApexCallSite[];
  readonly dynamicApexSites: readonly ApexCallSite[];
  readonly catchClauses: readonly ApexCatchClause[];
  readonly loopCount: number;
  readonly statementCount: number;
}

/** Outcome of one structure parse. */
export interface ApexStructureParse {
  readonly parsed: boolean;
  /** First few syntax errors (capped) when `parsed` is false; empty otherwise. */
  readonly parseErrors: readonly string[];
  /** `null` when the file did not parse — an empty structure would be a lie. */
  readonly structure: ApexTypeStructure | null;
  readonly parseMs: number;
}

export interface ParseApexStructureOptions {
  /**
   * Parse entry point. Pass it from the FILE EXTENSION — content sniffing
   * misreads a trigger that opens with a comment (see apex-ast-edges).
   */
  readonly kind?: 'class' | 'trigger';
}

const ERROR_CAP = 3;
const EXPRESSION_TEXT_CAP = 120;

const LOOP_CONTEXTS: ReadonlySet<string> = new Set([
  'ForStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

const METHOD_CONTEXTS: ReadonlySet<string> = new Set([
  'MethodDeclaration',
  'ConstructorDeclaration',
  'InterfaceMethodDeclaration',
]);

const TYPE_CONTEXTS: ReadonlySet<string> = new Set([
  'ClassDeclaration',
  'InterfaceDeclaration',
  'EnumDeclaration',
]);

const DML_STATEMENTS: Readonly<Record<string, ApexDmlOperation>> = {
  InsertStatement: 'insert',
  UpdateStatement: 'update',
  UpsertStatement: 'upsert',
  DeleteStatement: 'delete',
  UndeleteStatement: 'undelete',
  MergeStatement: 'merge',
};

/** `Database.<name>` calls that perform DML, lowercased name → operation. */
const DATABASE_DML_METHODS: Readonly<Record<string, ApexDmlOperation>> = {
  insert: 'insert',
  insertimmediate: 'insert',
  update: 'update',
  updateimmediate: 'update',
  upsert: 'upsert',
  delete: 'delete',
  deleteimmediate: 'delete',
  undelete: 'undelete',
  merge: 'merge',
};

/**
 * Dynamic-Apex constructs — the ones whose OPERAND is a runtime string, so no
 * static reader can follow them. Keyed by the fully-dotted call prefix.
 */
const DYNAMIC_APEX_CALLS: Readonly<Record<string, string>> = {
  'database.query': 'dynamic-soql',
  'database.querywithbinds': 'dynamic-soql',
  'database.countquery': 'dynamic-soql',
  'database.countquerywithbinds': 'dynamic-soql',
  'database.getquerylocator': 'dynamic-soql',
  'database.getquerylocatorwithbinds': 'dynamic-soql',
  'type.forname': 'reflective-type',
  'schema.getglobaldescribe': 'reflective-describe',
};

/** Async-dispatch calls that hand work to a SEPARATE transaction. */
const ASYNC_DISPATCH_CALLS: Readonly<Record<string, string>> = {
  'system.enqueuejob': 'queueable-enqueue',
  'database.executebatch': 'batch-execute',
  'system.schedule': 'schedulable-schedule',
  'system.schedulebatch': 'batch-schedule',
};

const kids = (n: Ctx): Ctx[] =>
  Array.from(
    { length: (n?.getChildCount?.() as number) ?? 0 },
    (_, i) => n.getChild(i) as Ctx,
  );

const ctxName = (n: Ctx): string =>
  String(n?.constructor?.name ?? '').replace(/Context$/, '');

const findAll = (n: Ctx, want: string, out: Ctx[] = []): Ctx[] => {
  if (ctxName(n) === want) out.push(n);
  for (const c of kids(n)) findAll(c, want, out);
  return out;
};

const directChild = (n: Ctx, want: string): Ctx | undefined =>
  kids(n).find((k) => ctxName(k) === want);

const textOf = (n: Ctx | undefined): string =>
  typeof n?.getText === 'function' ? String(n.getText()) : '';

const lineOf = (n: Ctx): number => Number(n?.start?.line ?? 0);
const endLineOf = (n: Ctx): number => Number(n?.stop?.line ?? n?.start?.line ?? 0);

const truncate = (text: string, cap = EXPRESSION_TEXT_CAP): string =>
  text.length <= cap ? text : `${text.slice(0, cap)}…`;

/**
 * Render a modifier as written. An annotation modifier keeps its `@Name(args)`
 * text; a keyword modifier joins its terminals with a space so `with sharing`
 * survives ANTLR's whitespace-free `getText()` (which yields `withsharing`).
 */
const modifierText = (m: Ctx): string => {
  const annotation = directChild(m, 'Annotation');
  if (annotation !== undefined) return textOf(annotation);
  return kids(m)
    .map((k) => textOf(k))
    .filter((t) => t.length > 0)
    .join(' ')
    .toLowerCase();
};

/**
 * The `Modifier` contexts that decorate `decl`. A member declaration hangs off
 * `MemberDeclaration → ClassBodyDeclaration`, whose children carry the
 * modifiers; a top-level type hangs off `TypeDeclaration`; an interface method
 * carries its own `modifier_list`. Returns `[]` when no holder is found rather
 * than throwing on an unexpected shape.
 */
const modifierContexts = (decl: Ctx): Ctx[] => {
  const own = kids(decl).filter((k) => ctxName(k) === 'Modifier');
  if (own.length > 0) return own;
  let holder: Ctx | undefined = decl?.parentCtx as Ctx | undefined;
  if (holder !== undefined && ctxName(holder) === 'MemberDeclaration') {
    holder = holder.parentCtx as Ctx | undefined;
  }
  if (holder === undefined || holder === null) return [];
  return kids(holder).filter((k) => ctxName(k) === 'Modifier');
};

interface ParsedModifiers {
  readonly all: readonly string[];
  readonly annotations: readonly string[];
  readonly keywords: ReadonlySet<string>;
  readonly visibility: ApexVisibility | null;
  readonly sharing: ApexTypeStructure['sharing'];
}

const readModifiers = (decl: Ctx): ParsedModifiers => {
  const all: string[] = [];
  const annotations: string[] = [];
  const keywords = new Set<string>();
  let visibility: ApexVisibility | null = null;
  let sharing: ApexTypeStructure['sharing'] = null;
  for (const m of modifierContexts(decl)) {
    const text = modifierText(m);
    if (text.length === 0) continue;
    all.push(text);
    if (text.startsWith('@')) {
      annotations.push(text);
      continue;
    }
    keywords.add(text);
    if (
      text === 'global' ||
      text === 'public' ||
      text === 'protected' ||
      text === 'private'
    ) {
      visibility = text;
    }
    if (
      text === 'with sharing' ||
      text === 'without sharing' ||
      text === 'inherited sharing'
    ) {
      sharing = text;
    }
  }
  return { all, annotations, keywords, visibility, sharing };
};

/**
 * The innermost enclosing declared type, as a dotted path (`Outer.Inner`).
 * Falls back to `fallback` when the node has no type ancestor — a trigger
 * body, where the "owner" is the trigger itself.
 */
const ownerTypePath = (node: Ctx, fallback: string): string => {
  const parts: string[] = [];
  let cur: Ctx | undefined = node?.parentCtx as Ctx | undefined;
  while (cur !== undefined && cur !== null) {
    if (TYPE_CONTEXTS.has(ctxName(cur))) {
      const id = directChild(cur, 'Id');
      if (id !== undefined) parts.unshift(textOf(id));
    }
    cur = cur.parentCtx as Ctx | undefined;
  }
  return parts.length === 0 ? fallback : parts.join('.');
};

/**
 * Site context: the enclosing method (or `null`) and whether the node sits in
 * a loop's BODY.
 *
 * The body test is load-bearing. `for (Account a : [SELECT … ])` puts a SOQL
 * literal syntactically INSIDE a `ForStatement`, but that query runs ONCE — it
 * is the loop's source, not a query per iteration. Only a node reached through
 * the loop's `Statement` child is in the body. The walk continues past a
 * control-clause loop, because an inner loop's control clause nested in an
 * OUTER loop's body still executes once per outer iteration.
 */
const siteContextOf = (node: Ctx): SiteContext => {
  let inMethod: string | null = null;
  let inLoopBody = false;
  let loopLine: number | null = null;
  let child: Ctx = node;
  let cur: Ctx | undefined = node?.parentCtx as Ctx | undefined;
  while (cur !== undefined && cur !== null) {
    const name = ctxName(cur);
    if (
      !inLoopBody &&
      LOOP_CONTEXTS.has(name) &&
      ctxName(child) === 'Statement'
    ) {
      inLoopBody = true;
      loopLine = lineOf(cur);
    }
    if (inMethod === null && METHOD_CONTEXTS.has(name)) {
      inMethod =
        name === 'ConstructorDeclaration'
          ? textOf(directChild(cur, 'QualifiedName'))
          : textOf(directChild(cur, 'Id'));
      if (inMethod.length === 0) inMethod = null;
    }
    child = cur;
    cur = cur.parentCtx as Ctx | undefined;
  }
  return { inMethod, inLoopBody, loopLine };
};

/** Read the declared parameters of a method / constructor declaration. */
const readParams = (decl: Ctx): readonly ApexParam[] => {
  const formals = directChild(decl, 'FormalParameters');
  if (formals === undefined) return [];
  return findAll(formals, 'FormalParameter').map((fp) => ({
    name: textOf(directChild(fp, 'Id')),
    type: textOf(directChild(fp, 'TypeRef')),
  }));
};

const renderSignature = (
  mods: ParsedModifiers,
  returnType: string | null,
  name: string,
  params: readonly ApexParam[],
): string => {
  const parts: string[] = [];
  for (const kw of ['global', 'public', 'protected', 'private']) {
    if (mods.keywords.has(kw)) parts.push(kw);
  }
  if (mods.keywords.has('static')) parts.push('static');
  if (mods.keywords.has('abstract')) parts.push('abstract');
  if (mods.keywords.has('virtual')) parts.push('virtual');
  if (mods.keywords.has('override')) parts.push('override');
  if (returnType !== null) parts.push(returnType);
  const args = params.map((p) => `${p.type} ${p.name}`.trim()).join(', ');
  return `${parts.join(' ')} ${name}(${args})`.trim();
};

const buildMethod = (
  decl: Ctx,
  fallbackOwner: string,
  isConstructor: boolean,
): ApexMethodNode | null => {
  const name = isConstructor
    ? textOf(directChild(decl, 'QualifiedName'))
    : textOf(directChild(decl, 'Id'));
  if (name.length === 0) return null;
  const mods = readModifiers(decl);
  const returnType = isConstructor
    ? null
    : (() => {
        const typeRef = directChild(decl, 'TypeRef');
        return typeRef === undefined ? 'void' : textOf(typeRef);
      })();
  const params = readParams(decl);
  return {
    name,
    signature: renderSignature(mods, returnType, name, params),
    returnType,
    params,
    visibility: mods.visibility ?? 'private',
    visibilityDeclared: mods.visibility !== null,
    isStatic: mods.keywords.has('static'),
    isVirtual: mods.keywords.has('virtual'),
    isAbstract: mods.keywords.has('abstract'),
    isOverride: mods.keywords.has('override'),
    isTestMethod:
      mods.keywords.has('testmethod') ||
      mods.annotations.some((a) => /^@istest\b/i.test(a)),
    isWebService: mods.keywords.has('webservice'),
    isConstructor,
    annotations: mods.annotations,
    ownerType: ownerTypePath(decl, fallbackOwner),
    line: lineOf(decl),
    endLine: endLineOf(decl),
    hasBody: directChild(decl, 'Block') !== undefined,
  };
};

const buildMembers = (tree: Ctx, fallbackOwner: string): readonly ApexMemberNode[] => {
  const members: ApexMemberNode[] = [];
  for (const fd of findAll(tree, 'FieldDeclaration')) {
    const mods = readModifiers(fd);
    const type = textOf(directChild(fd, 'TypeRef'));
    const owner = ownerTypePath(fd, fallbackOwner);
    for (const vd of findAll(fd, 'VariableDeclarator')) {
      const name = textOf(directChild(vd, 'Id'));
      if (name.length === 0) continue;
      members.push({
        name,
        type,
        memberKind: 'field',
        visibility: mods.visibility ?? 'private',
        visibilityDeclared: mods.visibility !== null,
        isStatic: mods.keywords.has('static'),
        isFinal: mods.keywords.has('final'),
        isTransient: mods.keywords.has('transient'),
        annotations: mods.annotations,
        ownerType: owner,
        line: lineOf(vd),
      });
    }
  }
  for (const pd of findAll(tree, 'PropertyDeclaration')) {
    const mods = readModifiers(pd);
    const name = textOf(directChild(pd, 'Id'));
    if (name.length === 0) continue;
    members.push({
      name,
      type: textOf(directChild(pd, 'TypeRef')),
      memberKind: 'property',
      visibility: mods.visibility ?? 'private',
      visibilityDeclared: mods.visibility !== null,
      isStatic: mods.keywords.has('static'),
      isFinal: mods.keywords.has('final'),
      isTransient: mods.keywords.has('transient'),
      annotations: mods.annotations,
      ownerType: ownerTypePath(pd, fallbackOwner),
      line: lineOf(pd),
    });
  }
  return members.sort((a, b) => a.line - b.line);
};

/** Objects named in a query's `FROM` clause (SOQL) or `RETURNING` (SOSL). */
const queryObjects = (queryCtx: Ctx): readonly string[] => {
  const names: string[] = [];
  for (const list of findAll(queryCtx, 'FromNameList')) {
    for (const idCtx of findAll(list, 'SoqlId')) {
      const text = textOf(idCtx);
      if (text.length > 0 && !names.includes(text)) names.push(text);
    }
    if (names.length === 0) {
      const raw = textOf(list);
      if (raw.length > 0) names.push(raw);
    }
  }
  for (const returning of findAll(queryCtx, 'FieldSpec')) {
    const first = findAll(returning, 'SoslId')[0];
    const text = textOf(first);
    if (text.length > 0 && !names.includes(text)) names.push(text);
  }
  return names;
};

/** Apex primitives a query result can land in without a zero-row exception. */
const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'integer',
  'long',
  'decimal',
  'double',
  'string',
  'boolean',
  'id',
  'date',
  'datetime',
  'time',
  'object',
  'blob',
]);

/**
 * True when a query literal is the initializer of a declaration whose type is
 * a single sObject — `Account a = [SELECT …];`, which throws
 * `System.QueryException` on zero rows and cannot be defended with a null
 * check. Only the DECLARATION-initializer shape is recognised; a re-assignment
 * to an already-declared variable needs a type table this single-pass reader
 * does not build, and is deliberately reported false rather than guessed.
 */
const isAssignedToSingleSObject = (query: Ctx): boolean => {
  let cur: Ctx | undefined = query?.parentCtx as Ctx | undefined;
  let declarator: Ctx | undefined;
  while (cur !== undefined && cur !== null) {
    const name = ctxName(cur);
    if (name === 'VariableDeclarator') {
      declarator = cur;
      break;
    }
    if (name === 'Statement' || name === 'Block' || METHOD_CONTEXTS.has(name)) {
      return false;
    }
    cur = cur.parentCtx as Ctx | undefined;
  }
  if (declarator === undefined) return false;
  let decl: Ctx | undefined = declarator.parentCtx as Ctx | undefined;
  while (
    decl !== undefined &&
    decl !== null &&
    ctxName(decl) !== 'LocalVariableDeclaration' &&
    ctxName(decl) !== 'FieldDeclaration'
  ) {
    decl = decl.parentCtx as Ctx | undefined;
  }
  if (decl === undefined || decl === null) return false;
  const declaredType = textOf(directChild(decl, 'TypeRef')).trim();
  if (declaredType.length === 0) return false;
  if (/^(?:list|set|map)\s*</i.test(declaredType)) return false;
  if (declaredType.endsWith('[]')) return false;
  return !PRIMITIVE_TYPES.has(declaredType.toLowerCase());
};

/**
 * The receiver expression of a dotted call. `DotMethodCall`'s parent is a
 * `DotExpression` whose first child is the receiver.
 */
const dotReceiverText = (dotMethodCall: Ctx): string => {
  const parent = dotMethodCall?.parentCtx as Ctx | undefined;
  if (parent === undefined || ctxName(parent) !== 'DotExpression') return '';
  return textOf(kids(parent)[0]);
};

/** Lowercased `receiver.method` for a dotted call, e.g. `database.query`. */
const dottedCallKey = (dotMethodCall: Ctx): string => {
  const receiver = dotReceiverText(dotMethodCall);
  const method = textOf(directChild(dotMethodCall, 'AnyId'));
  if (receiver.length === 0 || method.length === 0) return '';
  return `${receiver}.${method}`.toLowerCase();
};

/**
 * True when the call's value is thrown away — its nearest statement ancestor
 * is an expression statement and nothing between consumes the result.
 */
const isResultDiscarded = (call: Ctx): boolean => {
  let cur: Ctx | undefined = call?.parentCtx as Ctx | undefined;
  while (cur !== undefined && cur !== null) {
    const name = ctxName(cur);
    if (
      name === 'AssignExpression' ||
      name === 'VariableDeclarator' ||
      name === 'LocalVariableDeclaration' ||
      name === 'ReturnStatement' ||
      name === 'Arguments' ||
      name === 'ExpressionList' ||
      name === 'IfStatement' ||
      name === 'ForControl'
    ) {
      return false;
    }
    if (name === 'ExpressionStatement') return true;
    if (name === 'Statement' || name === 'Block') return false;
    cur = cur.parentCtx as Ctx | undefined;
  }
  return false;
};

/**
 * The literal `allOrNone` argument of a `Database.<op>` call, when written.
 *
 * `DotMethodCall` carries its `expressionList` DIRECTLY (only the bare
 * `MethodCall` form wraps it in `Arguments`), so both shapes are tried — a
 * miss here would silently report `null` for every `Database.insert(rows,
 * false)` in the org and quietly disable the partial-success check that
 * depends on it.
 *
 * Returns `null` when the argument is absent or is not a literal
 * `true`/`false`. It is never defaulted to the platform's `true`: the whole
 * point of the flag is that somebody WROTE it.
 */
const readAllOrNone = (dotMethodCall: Ctx): boolean | null => {
  const args = directChild(dotMethodCall, 'Arguments');
  const list =
    directChild(dotMethodCall, 'ExpressionList') ??
    (args === undefined ? undefined : directChild(args, 'ExpressionList'));
  if (list === undefined) return null;
  const exprs = kids(list).filter((k) => textOf(k) !== ',');
  const second = exprs[1];
  if (second === undefined) return null;
  const text = textOf(second).toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
};

/** Normalise a trigger case (`beforeinsert` → `before insert`). */
const triggerCaseText = (c: Ctx): string =>
  kids(c)
    .map((k) => textOf(k))
    .filter((t) => t.length > 0)
    .join(' ')
    .toLowerCase();

/**
 * Parse one Apex source into its structural projection.
 *
 * Never throws: a grammar failure, a runtime failure inside the parser, and a
 * failure to load the grammar itself all surface as `parsed: false` with
 * `structure: null` and the reason in `parseErrors`.
 *
 * @example
 *   const r = await parseApexStructure(src, { kind: 'class' });
 *   if (r.structure !== null) console.log(r.structure.methods.length);
 */
export const parseApexStructure = async (
  source: string,
  options: ParseApexStructureOptions = {},
): Promise<ApexStructureParse> => {
  const started = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e6;

  // The generated ANTLR classes are PascalCase; hold them in camelCase locals so
  // the naming-convention rule is satisfied without disabling it.
  let parserFactory: Ctx;
  let errorListenerBase: Ctx;
  try {
    // Lazy: the ~5 MB ANTLR grammar must not load on `sfi` startup.
    const grammar = await import('@apexdevtools/apex-parser');
    parserFactory = grammar.ApexParserFactory;
    errorListenerBase = grammar.ApexErrorListener;
  } catch (cause) {
    return {
      parsed: false,
      parseErrors: [
        `apex grammar unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
      structure: null,
      parseMs: elapsed(),
    };
  }

  const errors: string[] = [];
  class Collecting extends errorListenerBase {
    public apexSyntaxError(line: number, column: number, message: string): void {
      if (errors.length < ERROR_CAP) errors.push(`${line}:${column} ${message}`);
    }
  }

  const kind = options.kind ?? 'class';
  let tree: Ctx;
  try {
    const parser = parserFactory.createParser(source);
    parser.removeErrorListeners();
    parser.addErrorListener(new Collecting());
    tree = kind === 'trigger' ? parser.triggerUnit() : parser.compilationUnit();
  } catch (cause) {
    return {
      parsed: false,
      parseErrors: [
        `parser runtime failure: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
      structure: null,
      parseMs: elapsed(),
    };
  }
  if (errors.length > 0) {
    return { parsed: false, parseErrors: errors, structure: null, parseMs: elapsed() };
  }

  // ---- type identity -------------------------------------------------------
  const triggerUnit = findAll(tree, 'TriggerUnit')[0];
  const typeDecls = [
    ...findAll(tree, 'ClassDeclaration'),
    ...findAll(tree, 'InterfaceDeclaration'),
    ...findAll(tree, 'EnumDeclaration'),
  ].sort((a, b) => lineOf(a) - lineOf(b));

  let structureKind: ApexTypeStructure['kind'] = 'class';
  let name = '';
  let modifiers: readonly string[] = [];
  let annotations: readonly string[] = [];
  let sharing: ApexTypeStructure['sharing'] = null;
  let superclass: string | null = null;
  let interfaces: readonly string[] = [];
  let triggerInfo: ApexTypeStructure['trigger'] = null;
  let rootDecl: Ctx | undefined;

  if (triggerUnit !== undefined) {
    structureKind = 'trigger';
    const ids = findAll(triggerUnit, 'Id');
    name = textOf(ids[0]);
    // The grammar's `id ON id` shape: the SECOND id is the SObject. When the
    // grammar yields only one, the object is UNKNOWN — reported as null.
    const objectId = ids[1];
    triggerInfo = {
      object: objectId === undefined ? null : textOf(objectId),
      events: findAll(triggerUnit, 'TriggerCase')
        .map(triggerCaseText)
        .filter((t) => t.length > 0),
    };
  } else {
    rootDecl = typeDecls[0];
    if (rootDecl === undefined) {
      return {
        parsed: false,
        parseErrors: ['no class, interface, enum, or trigger declaration found'],
        structure: null,
        parseMs: elapsed(),
      };
    }
    const declName = ctxName(rootDecl);
    structureKind =
      declName === 'InterfaceDeclaration'
        ? 'interface'
        : declName === 'EnumDeclaration'
          ? 'enum'
          : 'class';
    name = textOf(directChild(rootDecl, 'Id'));
    const mods = readModifiers(rootDecl);
    modifiers = mods.all;
    annotations = mods.annotations;
    sharing = mods.sharing;
    const typeRef = directChild(rootDecl, 'TypeRef');
    superclass = typeRef === undefined ? null : textOf(typeRef);
    const typeList = directChild(rootDecl, 'TypeList');
    interfaces =
      typeList === undefined
        ? []
        : kids(typeList)
            .filter((k) => ctxName(k) === 'TypeRef')
            .map((k) => textOf(k));
    // An interface declaration's `extends` also lands in `typeList`; keep it
    // there rather than inventing a superclass for it.
    if (structureKind === 'interface') superclass = null;
  }

  const fallbackOwner = name.length > 0 ? name : '(unnamed)';

  // ---- members -------------------------------------------------------------
  const methods: ApexMethodNode[] = [];
  for (const md of findAll(tree, 'MethodDeclaration')) {
    const built = buildMethod(md, fallbackOwner, false);
    if (built !== null) methods.push(built);
  }
  for (const md of findAll(tree, 'InterfaceMethodDeclaration')) {
    const built = buildMethod(md, fallbackOwner, false);
    if (built !== null) methods.push(built);
  }
  for (const cd of findAll(tree, 'ConstructorDeclaration')) {
    const built = buildMethod(cd, fallbackOwner, true);
    if (built !== null) methods.push(built);
  }
  methods.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

  const innerTypes: ApexInnerType[] = [];
  for (const decl of typeDecls) {
    if (rootDecl !== undefined && decl === rootDecl) continue;
    const declName = ctxName(decl);
    const innerName = textOf(directChild(decl, 'Id'));
    if (innerName.length === 0) continue;
    const owner = ownerTypePath(decl, fallbackOwner);
    innerTypes.push({
      name: innerName,
      kind:
        declName === 'InterfaceDeclaration'
          ? 'interface'
          : declName === 'EnumDeclaration'
            ? 'enum'
            : 'class',
      ownerType: owner,
      modifiers: readModifiers(decl).all,
      line: lineOf(decl),
      methodCount: methods.filter(
        (m) => m.ownerType === `${owner}.${innerName}` || m.ownerType === innerName,
      ).length,
    });
  }
  innerTypes.sort((a, b) => a.line - b.line);

  // ---- data-access sites ---------------------------------------------------
  const soqlSites: ApexQuerySite[] = findAll(tree, 'SoqlLiteral').map((q) => ({
    line: lineOf(q),
    objects: queryObjects(q),
    assignedToSingleSObject: isAssignedToSingleSObject(q),
    ...siteContextOf(q),
  }));
  const soslSites: ApexQuerySite[] = findAll(tree, 'SoslLiteral').map((q) => ({
    line: lineOf(q),
    objects: queryObjects(q),
    // A SOSL literal always yields a `List<List<SObject>>`; the single-row
    // exception shape does not exist for it.
    assignedToSingleSObject: false,
    ...siteContextOf(q),
  }));

  const dmlSites: ApexDmlSite[] = [];
  for (const [contextName, operation] of Object.entries(DML_STATEMENTS)) {
    for (const stmt of findAll(tree, contextName)) {
      dmlSites.push({
        line: lineOf(stmt),
        operation,
        form: 'statement',
        resultDiscarded: null,
        allOrNone: null,
        ...siteContextOf(stmt),
      });
    }
  }

  const calloutSites: ApexCallSite[] = [];
  const asyncDispatchSites: ApexCallSite[] = [];
  const dynamicApexSites: ApexCallSite[] = [];

  // Locals / fields declared with type `Http` — the only receivers a
  // single-file reader can PROVE issue an HTTP callout via `.send(…)`.
  const httpReceivers = new Set<string>();
  for (const decl of [
    ...findAll(tree, 'LocalVariableDeclaration'),
    ...findAll(tree, 'FieldDeclaration'),
  ]) {
    if (textOf(directChild(decl, 'TypeRef')).toLowerCase() !== 'http') continue;
    for (const vd of findAll(decl, 'VariableDeclarator')) {
      const varName = textOf(directChild(vd, 'Id'));
      if (varName.length > 0) httpReceivers.add(varName.toLowerCase());
    }
  }

  for (const call of findAll(tree, 'DotMethodCall')) {
    const key = dottedCallKey(call);
    if (key.length === 0) continue;
    const site = siteContextOf(call);
    const parent = call.parentCtx as Ctx | undefined;
    const expression = truncate(textOf(parent ?? call));
    const line = lineOf(call);

    const dynamicKind = DYNAMIC_APEX_CALLS[key];
    if (dynamicKind !== undefined) {
      dynamicApexSites.push({ line, expression, kind: dynamicKind, ...site });
    }
    const asyncKind = ASYNC_DISPATCH_CALLS[key];
    if (asyncKind !== undefined) {
      asyncDispatchSites.push({ line, expression, kind: asyncKind, ...site });
    }
    const [receiver = '', method = ''] = key.split('.');
    if (receiver === 'database') {
      const operation = DATABASE_DML_METHODS[method];
      if (operation !== undefined) {
        dmlSites.push({
          line,
          operation,
          form: 'database-method',
          resultDiscarded: isResultDiscarded(call),
          allOrNone: readAllOrNone(call),
          ...site,
        });
      }
    }
    if (
      method === 'send' &&
      (httpReceivers.has(receiver) || /^newhttp\(\)$/.test(receiver))
    ) {
      calloutSites.push({ line, expression, kind: 'http-send', ...site });
    }
    if (receiver === 'webservicecallout' && method === 'invoke') {
      calloutSites.push({ line, expression, kind: 'webservice-callout', ...site });
    }
  }
  dmlSites.sort((a, b) => a.line - b.line || a.operation.localeCompare(b.operation));

  const catchClauses: ApexCatchClause[] = findAll(tree, 'CatchClause').map((c) => {
    const block = directChild(c, 'Block');
    const qualified = directChild(c, 'QualifiedName');
    return {
      line: lineOf(c),
      exceptionType: qualified === undefined ? null : textOf(qualified),
      statementCount: block === undefined ? 0 : findAll(block, 'Statement').length,
      ...siteContextOf(c),
    };
  });

  const loopCount = [...LOOP_CONTEXTS].reduce(
    (total, ctx) => total + findAll(tree, ctx).length,
    0,
  );

  return {
    parsed: true,
    parseErrors: [],
    structure: {
      kind: structureKind,
      name,
      modifiers,
      annotations,
      sharing,
      superclass,
      interfaces,
      trigger: triggerInfo,
      methods,
      members: buildMembers(tree, fallbackOwner),
      innerTypes,
      soqlSites,
      soslSites,
      dmlSites,
      calloutSites,
      asyncDispatchSites,
      dynamicApexSites,
      catchClauses,
      loopCount,
      statementCount: findAll(tree, 'Statement').length,
    },
    parseMs: elapsed(),
  };
};
