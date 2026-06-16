import { err, ok, type Result } from '@sf-intelligence/core';

/**
 * The three frontend tiers the scanner family covers. `lwc` runs over
 * Lightning Web Component bundles (`.js`, `.html`), `aura` over Aura
 * bundles (`.cmp`, `.js`), and `vf` over Visualforce markup (`.page`,
 * `.component`).
 */
export type FrontendDialect = 'lwc' | 'aura' | 'vf';

/**
 * The categorical kinds of `scanFrontendSource` errors. The scanner is
 * fail-fast: the first detected structural problem wins.
 */
export type FrontendScannerErrorKind = 'empty-source' | 'unknown-dialect';

/**
 * The error shape `scanFrontendSource` returns on failure. `offset` is
 * the 0-indexed character offset in the original source.
 */
export interface FrontendScannerError {
  readonly kind: FrontendScannerErrorKind;
  readonly message: string;
  readonly offset: number;
}

/**
 * One field access detected by the heuristic frontend scanner.
 *
 * `object` is the literal text on the left side of the dotted path
 * (e.g., `record`, `Account`, `this.account`). The scanner performs
 * no symbol resolution; downstream extractors map `object` to an
 * SObject when they can (using `targetConfigs`, `standardController`,
 * or `aura:attribute` declarations).
 *
 * `offset` and `length` describe the span in the *original* source
 * (offsets are preserved across the comment/string-stripping pass).
 *
 * Schema-import reads emitted from LWC `@salesforce/schema/Obj.Field`
 * imports use the literal `Obj` as `object` — these are unambiguously
 * resolvable but the scanner still preserves the literal text and
 * leaves resolution to the extractor.
 */
export interface FrontendFieldAccess {
  readonly type: 'read' | 'write';
  readonly object: string;
  readonly field: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * One Apex method call detected by the heuristic frontend scanner.
 *
 * For LWC, `className` is the segment between `@salesforce/apex/` and
 * the trailing `.method` in an import path. For Aura, the inline
 * `component.get('c.method')` shape leaves `className` set to the
 * literal raw identifier `c` — the extractor resolves it against the
 * bundle's `controller="..."` attribute. For VF, `className` is the
 * literal identifier preceding `.method()` in `{!Class.method()}`.
 *
 * Note: VF root-attribute Apex bindings (`controller="..."`,
 * `extensions="..."`) are NOT extracted by this scanner — those live
 * in the markup root attributes and are parsed by the VF extractor
 * at wiring time, not by `scanFrontendSource`.
 */
export interface FrontendApexCall {
  readonly className: string;
  readonly methodName: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * One component reference detected by the heuristic frontend scanner.
 *
 * The `componentName` is the literal identifier as it appeared in the
 * source: LWC kebab-case `c-foo-bar` yields `foo-bar`; Aura
 * `c:fooBar` markup tag yields `fooBar`; Aura
 * `$A.get('e.c:caseUpdate')` event reference yields `caseUpdate`;
 * VF `<apex:include pageName="X" />` yields `X`; VF `<c:Footer />`
 * yields `Footer`. Resolution to canonical IDs happens in the
 * extractor.
 */
export interface FrontendComponentRef {
  readonly componentName: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * The structured success payload from `scanFrontendSource`.
 *
 * `fieldAccesses` is deduplicated by `(type, object, field)` —
 * first-occurrence wins (matching the apex-scanner convention).
 * `apexCalls` is deduplicated by `(className, methodName)`.
 * `componentRefs` is deduplicated by `componentName`.
 *
 * The same input always produces the same output (determinism),
 * including the order of entries within each list.
 */
/**
 * A reference from frontend source to a platform RESOURCE the graph can
 * model as an edge (P14-USAGE-label-static-graph): a CustomLabel
 * (`@salesforce/label/c.X` import, `$Label.c.X` / `$Label.X` token), a
 * StaticResource (`@salesforce/resourceUrl/X` import, `$Resource.X`
 * token), or — VF only — a hierarchy Custom Setting read
 * (`$Setup.X__c.Field__c`). Deduplicated by `(kind, apiName)`.
 */
export interface FrontendResourceRef {
  readonly kind: 'label' | 'staticResource' | 'customSetting';
  readonly apiName: string;
  readonly offset: number;
  readonly length: number;
}

export interface FrontendScannerOutput {
  readonly dialect: FrontendDialect;
  readonly fieldAccesses: readonly FrontendFieldAccess[];
  readonly apexCalls: readonly FrontendApexCall[];
  readonly componentRefs: readonly FrontendComponentRef[];
  readonly resourceRefs: readonly FrontendResourceRef[];
}

/**
 * JS comment / string-literal patterns (LWC + Aura `.js`).
 *
 * Covers `//` line comments, `/* ... *\/` block comments, single- and
 * double-quoted strings (honoring `\` escapes), and template literals
 * (backticks). The substitution preserves byte length and newlines.
 */
const JS_COMMENT_OR_STRING =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g;

/**
 * JS comment-only pattern. Used by LWC and Aura passes that need
 * string literals preserved (so `import ... from '@salesforce/...'`
 * and `$A.get('e.c:event')` regexes can match the literal path /
 * event name).
 */
const JS_COMMENT_ONLY = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * HTML / Aura markup comments (`<!-- ... -->`). Used by the Aura
 * scanner before the markup-tag and `$A.get` passes.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * VF comment forms: HTML comments AND Visualforce directive comments
 * (`<%-- ... --%>`).
 *
 * Note: VF markup attributes wrap expression bodies in HTML-style
 * quotes (`value="{!Account.Name}"`), so the VF scanner intentionally
 * does NOT strip quoted strings at the markup level — doing so would
 * blank the expression. The merge-token and Apex-call regexes are
 * anchored on `{! ... }` boundaries, so string-literal text outside
 * `{!}` expressions can't yield spurious matches (the regexes require
 * the `\{!` prefix). String literals INSIDE `{! ... }` (e.g.,
 * `{!IF(cond, 'fallback', X)}`) are not extracted because the
 * scanner only recognizes the outermost resolvable `{!Object.Field}`
 * and `{!Class.method()}` shapes — nested-expression parsing is a
 * documented limitation per `LwcAuraVfScannerSemantics.md`.
 */
const VF_COMMENT = /<!--[\s\S]*?-->|<%--[\s\S]*?--%>/g;

/**
 * LWC: `import method from '@salesforce/apex/Class.method'` — default
 * import. Captures (className, methodName). The trailing `[^'"]+` for
 * the method allows method names with arbitrary characters Salesforce
 * permits, but in practice these are identifiers.
 */
const LWC_APEX_IMPORT =
  /import\s+(?:\w+|\{[^}]+\})\s+from\s+['"]@salesforce\/apex\/([^./'"]+)\.([^'"]+)['"]/g;

/**
 * LWC: `import FOO from '@salesforce/schema/Object.Field'` — schema
 * import (a declared reference). Captures (objectName, fieldName).
 */
const LWC_SCHEMA_IMPORT =
  /import\s+(?:\w+|\{[^}]+\})\s+from\s+['"]@salesforce\/schema\/([^./'"]+)\.([^'"]+)['"]/g;

/**
 * LWC: `record.FieldName = X` and related assignment shapes. The
 * second IDENT must start with an uppercase letter — the LWC
 * convention for SObject field references (custom fields end in
 * `__c`, standard fields are PascalCase). Lowercase second IDENTs
 * are treated as property accesses (intra-component) per
 * `LwcAuraVfScannerSemantics.md`.
 *
 * The negative-lookbehind `(?<![A-Za-z_0-9])` (without `.`) anchors
 * the first IDENT to a non-identifier boundary while still allowing
 * dotted-chain matching: `this.account.Industry__c` matches as
 * `account.Industry__c` because the intermediate `this.account` pair
 * fails the uppercase-second-IDENT filter.
 */
const LWC_WRITE_PATTERN =
  /(?<![A-Za-z_0-9])([A-Za-z_][A-Za-z_0-9]*)\.([A-Z][A-Za-z_0-9]*)\s*(?:\+\+|--|<<=|>>>=|>>=|[+\-*/%|&^]=|=(?!=))/g;

/**
 * LWC: read-shape `record.FieldName` that is neither a write nor a
 * method call. The negative-lookahead pattern mirrors the apex
 * scanner's read pattern (`ApexSemantics.md`).
 */
const LWC_READ_PATTERN =
  /(?<![A-Za-z_0-9])([A-Za-z_][A-Za-z_0-9]*)\.([A-Z][A-Za-z_0-9]*)(?![A-Za-z_0-9])(?!\s*(?:\+\+|--|<<=|>>>=|>>=|[+\-*/%|&^]=|=(?!=)|\())/g;

/**
 * LWC: `getRecord({ ..., fields: ['Object.Field', 'Object.Field2'] })`
 * — wire pattern. The outer regex finds each `fields: [...]` literal
 * array; the inner regex (run over the captured group) extracts each
 * `'Object.Field'` string literal.
 *
 * Reactive `fields: '$fields'` is intentionally NOT matched (no
 * literal array syntax). This is the deliberate dynamic-access
 * boundary.
 */
const LWC_GETRECORD_FIELDS = /fields\s*:\s*\[([^\]]*)\]/g;
const LWC_FIELD_STRING = /['"]([A-Za-z_][A-Za-z_0-9]*)\.([A-Z][A-Za-z_0-9]*)['"]/g;

/**
 * LWC: `import X from '@salesforce/label/c.My_Label'` — an org
 * CustomLabel import (P14-USAGE-label-static-graph). Namespaced labels
 * (`@salesforce/label/ns.X`) belong to managed packages and are
 * intentionally NOT captured (the org vault never retrieves them).
 */
const LWC_LABEL_IMPORT =
  /import\s+(?:\w+|\{[^}]+\})\s+from\s+['"]@salesforce\/label\/c\.(\w+)['"]/g;

/**
 * LWC: `import X from '@salesforce/resourceUrl/myResource'` — a
 * StaticResource import.
 */
const LWC_RESOURCE_IMPORT =
  /import\s+(?:\w+|\{[^}]+\})\s+from\s+['"]@salesforce\/resourceUrl\/(\w+)['"]/g;

/**
 * Aura: `$Label.c.My_Label` — in markup (`{!$Label.c.X}`) or JS
 * (`$A.get("$Label.c.X")`); the `c.` namespace is the org-label form.
 */
const AURA_LABEL_REF = /\$Label\.c\.(\w+)/g;

/**
 * Aura / VF: `$Resource.myResource` global value provider token.
 */
const RESOURCE_TOKEN_REF = /\$Resource\.(\w+)/g;

/**
 * VF: `$Label.My_Label` — VF references org labels WITHOUT the `c.`
 * namespace (namespaced labels appear as `$Label.ns__Name`, which the
 * `\w+` capture keeps whole). The `(?!c\.)` guard keeps a stray
 * Aura-style `$Label.c.X` from capturing the bare `c`.
 */
const VF_LABEL_REF = /\$Label\.(?!c\.)(\w+)/g;

/**
 * VF: `$Setup.My_Setting__c.Field__c` — a hierarchy Custom Setting
 * read (VF-only global value provider). Captures the setting OBJECT
 * api name; custom settings are modeled as CustomObject nodes.
 */
const VF_SETUP_REF = /\$Setup\.(\w+__c)\b/g;

/**
 * Aura: `<c:ComponentName ...>` opening markup tag. Captures the
 * component name. Matches the standard Aura namespace convention.
 */
const AURA_COMPONENT_TAG = /<c:([A-Za-z_][A-Za-z_0-9]*)\b/g;

/**
 * Aura: `$A.get('e.c:eventName')` event reference. The `e.c:` prefix
 * is the Aura convention for application events.
 */
const AURA_EVENT_REF = /\$A\.get\(\s*['"]e\.c:([A-Za-z_][A-Za-z_0-9]*)['"]\s*\)/g;

/**
 * VF: `{!Object.Field}` merge token. The second IDENT must start with
 * an uppercase letter (the field-name convention for both standard
 * and custom fields). The pattern excludes the `(` lookahead so
 * `{!Class.method()}` invocations don't match here.
 */
const VF_MERGE_TOKEN =
  /\{!\s*([A-Za-z_][A-Za-z_0-9]*)\.([A-Z][A-Za-z_0-9]*)(?!\s*\()(?![A-Za-z_0-9])\s*\}/g;

/**
 * VF: `{!ClassName.method()}` Apex invocation. Captures (className,
 * methodName). The trailing `(` distinguishes from merge tokens.
 */
const VF_APEX_CALL =
  /\{!\s*([A-Za-z_][A-Za-z_0-9]*)\.([A-Za-z_][A-Za-z_0-9]*)\s*\(/g;

/**
 * VF: `<apex:include pageName="X" />` page reference.
 */
const VF_APEX_INCLUDE = /<apex:include\b[^>]*\bpageName\s*=\s*['"]([^'"]+)['"]/g;

/**
 * VF: `<c:Component ...>` markup tag.
 */
const VF_C_COMPONENT_TAG = /<c:([A-Za-z_][A-Za-z_0-9]*)\b/g;

/**
 * Replace every non-newline character with a space. Preserves byte
 * length and newline layout so caller-side offsets stay valid.
 */
const blankOut = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * Strip JS comments and string literals from LWC `.js` source.
 * Template literals are stripped wholesale (interpolations included)
 * — the v1.4 scanner doesn't model `${...}` substitutions.
 */
const stripJs = (source: string): string =>
  source.replace(JS_COMMENT_OR_STRING, blankOut);

/**
 * Strip HTML comments and JS-style comments from Aura source. String
 * literals are preserved here because Aura's `$A.get('e.c:eventName')`
 * pattern depends on the string content being intact. The component-tag
 * pattern (`<c:Foo>`) doesn't care about strings either way.
 */
const stripAura = (source: string): string =>
  source.replace(HTML_COMMENT, blankOut).replace(JS_COMMENT_ONLY, blankOut);

/**
 * Strip VF comment forms (`<!-- ... -->`, `<%-- ... --%>`). Quoted
 * strings are NOT stripped at the VF markup level — see the
 * `VF_COMMENT` JSDoc above for why.
 */
const stripVf = (source: string): string => source.replace(VF_COMMENT, blankOut);

/**
 * Internal shape returned by each per-dialect scanner. Identical to
 * `FrontendScannerOutput` minus the `dialect` field, which is added
 * by `scanFrontendSource` at the dispatch boundary.
 */
type ScannerLists = Omit<FrontendScannerOutput, 'dialect'>;

interface FieldAccessContext {
  readonly accesses: FrontendFieldAccess[];
  readonly seen: Set<string>;
}

interface ApexCallContext {
  readonly calls: FrontendApexCall[];
  readonly seen: Set<string>;
}

interface ComponentRefContext {
  readonly refs: FrontendComponentRef[];
  readonly seen: Set<string>;
}

interface ResourceRefContext {
  readonly refs: FrontendResourceRef[];
  readonly seen: Set<string>;
}

/**
 * Push a field access iff `(type, object, field)` hasn't been seen.
 * Returns the absolute offset so the caller can record write spans
 * for later read-pass exclusion.
 */
const emitFieldAccess = (
  ctx: FieldAccessContext,
  type: 'read' | 'write',
  object: string,
  field: string,
  offset: number,
  length: number,
): number => {
  const key = `${type}:${object}.${field}`;
  if (ctx.seen.has(key)) return offset;
  ctx.seen.add(key);
  ctx.accesses.push({ type, object, field, offset, length });
  return offset;
};

/**
 * Push an Apex call iff `(className, methodName)` hasn't been seen.
 */
const emitApexCall = (
  ctx: ApexCallContext,
  className: string,
  methodName: string,
  offset: number,
  length: number,
): void => {
  const key = `${className}.${methodName}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.calls.push({ className, methodName, offset, length });
};

/**
 * Push a resource reference iff `(kind, apiName)` hasn't been seen.
 */
const emitResourceRef = (
  ctx: ResourceRefContext,
  kind: FrontendResourceRef['kind'],
  apiName: string,
  offset: number,
  length: number,
): void => {
  const key = `${kind}:${apiName}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.refs.push({ kind, apiName, offset, length });
};

/**
 * Run a single-capture pattern over `source`, emitting each capture as
 * a resource reference of `kind`.
 */
const sweepResourcePattern = (
  ctx: ResourceRefContext,
  pattern: RegExp,
  kind: FrontendResourceRef['kind'],
  source: string,
): void => {
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    emitResourceRef(ctx, kind, name, m.index, m[0].length);
  }
};

/**
 * Push a component reference iff `componentName` hasn't been seen.
 */
const emitComponentRef = (
  ctx: ComponentRefContext,
  componentName: string,
  offset: number,
  length: number,
): void => {
  if (ctx.seen.has(componentName)) return;
  ctx.seen.add(componentName);
  ctx.refs.push({ componentName, offset, length });
};

/**
 * Strip JS comments but preserve string literals. Used by LWC's
 * import-pass (the import-path regexes match string content) and by
 * Aura's source-stripping path.
 */
const stripJsComments = (source: string): string =>
  source.replace(JS_COMMENT_ONLY, blankOut);

/**
 * LWC scanner: runs two passes over the source.
 *
 * 1. Import & wire patterns run over a *comment-only-stripped*
 *    source (string literals preserved), because the patterns
 *    themselves match string literals (`from '@salesforce/...'`,
 *    `fields: ['Account.Name']`).
 * 2. `record.Field` read/write patterns run over the *fully-stripped*
 *    source (comments AND strings blanked out), so identifier-shaped
 *    text inside ordinary string literals doesn't produce spurious
 *    matches.
 *
 * The two passes share the same dedup context, so the same
 * `(type, object, field)` tuple is emitted at most once even if a
 * schema import and a body read both reference the same pair.
 */
const scanLwc = (source: string): ScannerLists => {
  const fieldCtx: FieldAccessContext = { accesses: [], seen: new Set<string>() };
  const callCtx: ApexCallContext = { calls: [], seen: new Set<string>() };
  const refCtx: ComponentRefContext = { refs: [], seen: new Set<string>() };
  const resourceCtx: ResourceRefContext = { refs: [], seen: new Set<string>() };

  // Pass 1: imports and wire-style fields against a comments-only-
  // stripped source — strings still intact so the regexes can match
  // the literal `'@salesforce/...'` and `['Object.Field']` paths.
  const importPass = stripJsComments(source);

  LWC_APEX_IMPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LWC_APEX_IMPORT.exec(importPass)) !== null) {
    const className = m[1];
    const methodName = m[2];
    if (className === undefined || methodName === undefined) continue;
    emitApexCall(callCtx, className, methodName, m.index, m[0].length);
  }

  LWC_SCHEMA_IMPORT.lastIndex = 0;
  while ((m = LWC_SCHEMA_IMPORT.exec(importPass)) !== null) {
    const object = m[1];
    const field = m[2];
    if (object === undefined || field === undefined) continue;
    emitFieldAccess(fieldCtx, 'read', object, field, m.index, m[0].length);
  }

  // Label / static-resource imports (P14-USAGE-label-static-graph) — same
  // comments-only-stripped pass, because the patterns match import paths.
  sweepResourcePattern(resourceCtx, LWC_LABEL_IMPORT, 'label', importPass);
  sweepResourcePattern(resourceCtx, LWC_RESOURCE_IMPORT, 'staticResource', importPass);

  LWC_GETRECORD_FIELDS.lastIndex = 0;
  while ((m = LWC_GETRECORD_FIELDS.exec(importPass)) !== null) {
    const arrayBody = m[1] ?? '';
    const arrayBaseOffset = m.index + m[0].length - arrayBody.length - 1;
    LWC_FIELD_STRING.lastIndex = 0;
    let inner: RegExpExecArray | null;
    while ((inner = LWC_FIELD_STRING.exec(arrayBody)) !== null) {
      const object = inner[1];
      const field = inner[2];
      if (object === undefined || field === undefined) continue;
      emitFieldAccess(
        fieldCtx,
        'read',
        object,
        field,
        arrayBaseOffset + inner.index,
        inner[0].length,
      );
    }
  }

  // Pass 2: in-body reads/writes against the fully-stripped source —
  // strings blanked so e.g. `const sql = 'SELECT Foo FROM Account';`
  // doesn't yield a spurious access.
  const bodyPass = stripJs(source);

  const writeOffsets = new Set<number>();
  LWC_WRITE_PATTERN.lastIndex = 0;
  while ((m = LWC_WRITE_PATTERN.exec(bodyPass)) !== null) {
    const object = m[1];
    const field = m[2];
    if (object === undefined || field === undefined) continue;
    writeOffsets.add(
      emitFieldAccess(fieldCtx, 'write', object, field, m.index, m[0].length),
    );
  }

  LWC_READ_PATTERN.lastIndex = 0;
  while ((m = LWC_READ_PATTERN.exec(bodyPass)) !== null) {
    if (writeOffsets.has(m.index)) continue;
    const object = m[1];
    const field = m[2];
    if (object === undefined || field === undefined) continue;
    emitFieldAccess(fieldCtx, 'read', object, field, m.index, m[0].length);
  }

  return {
    fieldAccesses: fieldCtx.accesses,
    apexCalls: callCtx.calls,
    componentRefs: refCtx.refs,
    resourceRefs: resourceCtx.refs,
  };
};

/**
 * Aura scanner: sweeps a stripped Aura source for `<c:Component>`
 * markup tags, `$A.get('e.c:event')` event references, and
 * `$Label.c.X` / `$Resource.X` value-provider tokens.
 */
const scanAura = (stripped: string): ScannerLists => {
  const refCtx: ComponentRefContext = { refs: [], seen: new Set<string>() };
  const resourceCtx: ResourceRefContext = { refs: [], seen: new Set<string>() };

  AURA_COMPONENT_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AURA_COMPONENT_TAG.exec(stripped)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    emitComponentRef(refCtx, name, m.index, m[0].length);
  }

  AURA_EVENT_REF.lastIndex = 0;
  while ((m = AURA_EVENT_REF.exec(stripped)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    emitComponentRef(refCtx, name, m.index, m[0].length);
  }

  sweepResourcePattern(resourceCtx, AURA_LABEL_REF, 'label', stripped);
  sweepResourcePattern(resourceCtx, RESOURCE_TOKEN_REF, 'staticResource', stripped);

  return {
    fieldAccesses: [],
    apexCalls: [],
    componentRefs: refCtx.refs,
    resourceRefs: resourceCtx.refs,
  };
};

/**
 * VF scanner: sweeps a stripped VF source for `{!Object.Field}` merge
 * tokens, `{!Class.method()}` invocations, `<apex:include>` page
 * references, and `<c:Component>` markup tags.
 *
 * NOTE: VF root-attribute Apex bindings (`controller="..."`,
 * `extensions="..."` on `<apex:page>`) are NOT extracted here. Those
 * declarations live in the markup root and are parsed by the
 * VisualforcePage extractor at wiring time, not by `scanFrontendSource`.
 */
const scanVf = (stripped: string): ScannerLists => {
  const fieldCtx: FieldAccessContext = { accesses: [], seen: new Set<string>() };
  const callCtx: ApexCallContext = { calls: [], seen: new Set<string>() };
  const refCtx: ComponentRefContext = { refs: [], seen: new Set<string>() };
  const resourceCtx: ResourceRefContext = { refs: [], seen: new Set<string>() };

  VF_APEX_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VF_APEX_CALL.exec(stripped)) !== null) {
    const className = m[1];
    const methodName = m[2];
    if (className === undefined || methodName === undefined) continue;
    emitApexCall(callCtx, className, methodName, m.index, m[0].length);
  }

  VF_MERGE_TOKEN.lastIndex = 0;
  while ((m = VF_MERGE_TOKEN.exec(stripped)) !== null) {
    const object = m[1];
    const field = m[2];
    if (object === undefined || field === undefined) continue;
    emitFieldAccess(fieldCtx, 'read', object, field, m.index, m[0].length);
  }

  VF_APEX_INCLUDE.lastIndex = 0;
  while ((m = VF_APEX_INCLUDE.exec(stripped)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    emitComponentRef(refCtx, name, m.index, m[0].length);
  }

  VF_C_COMPONENT_TAG.lastIndex = 0;
  while ((m = VF_C_COMPONENT_TAG.exec(stripped)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    emitComponentRef(refCtx, name, m.index, m[0].length);
  }

  sweepResourcePattern(resourceCtx, VF_LABEL_REF, 'label', stripped);
  sweepResourcePattern(resourceCtx, RESOURCE_TOKEN_REF, 'staticResource', stripped);
  sweepResourcePattern(resourceCtx, VF_SETUP_REF, 'customSetting', stripped);

  return {
    fieldAccesses: fieldCtx.accesses,
    apexCalls: callCtx.calls,
    componentRefs: refCtx.refs,
    resourceRefs: resourceCtx.refs,
  };
};

/**
 * Scan a frontend source string (LWC JS, Aura markup/JS, or
 * Visualforce markup) for field accesses, Apex calls, and component
 * references. This is the v1.4 heuristic sibling of the v0.3
 * `scanApexSource` — pure pattern-matching, no AST, no symbol
 * resolution.
 *
 * Returns `empty-source` for whitespace-only input and
 * `unknown-dialect` if `dialect` isn't one of the three supported
 * values (a programmer-error guard; Zod validation at the boundary
 * should prevent this in practice).
 *
 * Output is deterministic: the same input always produces the same
 * output. `fieldAccesses` is deduplicated by `(type, object, field)`,
 * `apexCalls` by `(className, methodName)`, and `componentRefs` by
 * `componentName`. First-source-order occurrence wins in each case.
 *
 * The scanner is **fail-conservative**: edges are emitted only when
 * the recognized shape is unambiguous, and zero edges are emitted
 * for shapes the scanner cannot resolve (dynamic field access,
 * reactive wire references, nested VF expressions, indirect imports,
 * etc.). See `LwcAuraVfScannerSemantics.md` "Known limitations" for
 * the explicit catalogue.
 *
 * Important boundary note: VF root-attribute Apex bindings
 * (`<apex:page controller="X" extensions="Y,Z">`) are NOT extracted
 * by this scanner — the `controller` and `extensions` attributes are
 * parsed by the VisualforcePage extractor at wiring time, not here.
 * Similarly, LWC `targetConfigs` and Aura `aura:attribute`
 * declarations are extractor concerns, not scanner concerns.
 *
 * @example
 *   const result = scanFrontendSource(
 *     `import getAcc from '@salesforce/apex/AccountService.fetch';`,
 *     'lwc',
 *   );
 *   if (result.ok) {
 *     console.log(result.value.apexCalls[0]?.className); // 'AccountService'
 *   }
 */
export const scanFrontendSource = (
  source: string,
  dialect: FrontendDialect,
): Result<FrontendScannerOutput, FrontendScannerError> => {
  if (source.trim().length === 0) {
    return err({
      kind: 'empty-source',
      message: 'source is empty or whitespace-only',
      offset: 0,
    });
  }

  let lists: ScannerLists;
  if (dialect === 'lwc') {
    lists = scanLwc(source);
  } else if (dialect === 'aura') {
    lists = scanAura(stripAura(source));
  } else if (dialect === 'vf') {
    lists = scanVf(stripVf(source));
  } else {
    return err({
      kind: 'unknown-dialect',
      message: `unknown frontend dialect: ${String(dialect)}`,
      offset: 0,
    });
  }

  return ok({ dialect, ...lists });
};
