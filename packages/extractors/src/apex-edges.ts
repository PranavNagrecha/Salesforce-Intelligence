import type { Edge } from '@sf-intelligence/contracts';
import { scanApexSource, type FrontendResourceRef } from '@sf-intelligence/parsers';

const SCANNER_SOURCE = 'apex-scanner';
const APEX_CLASS_SOURCE = 'apex-class-extractor';

/**
 * Receivers / pseudo-classes the heuristic scanner CANNOT resolve to a real
 * component, so any edge to them is noise. `Trigger.newMap` / `Trigger.oldMap`
 * parse as a bare `newMap` / `oldMap` receiver (no Apex class is named that —
 * camelCase is the variable convention), and `trigger` / `Trigger` / `this` /
 * `super` are context handles, not objects. Without this guard the scanner
 * emitted dangling `ApexClass:newMap` callsApex edges and `CustomField:trigger.new`
 * field-access edges that surfaced as garbage in SOE / explain / get_impact
 * output. The GENERAL loop-variable receiver case (`c.Id`, `contact.FirstName`)
 * needs full local-variable type resolution and stays deferred.
 */
const UNRESOLVABLE_FIELD_RECEIVERS: ReadonlySet<string> = new Set([
  'trigger',
  'Trigger',
  'this',
  'super',
]);
const UNRESOLVABLE_CALL_CLASSES: ReadonlySet<string> = new Set([
  'newMap',
  'oldMap',
  'new',
  'old',
  'this',
  'super',
]);

/**
 * A Salesforce sObject / custom-object API name carries a reserved metadata
 * suffix — `__c` (custom object / setting / custom-metadata record), `__mdt`
 * (custom metadata type), `__e` (platform event), `__b` (big object), `__x`
 * (external object). An Apex class name NEVER carries one, so a token ending in
 * a reserved suffix is an OBJECT reference, never an `ApexClass`.
 *
 * APEX-SOBJECT-REF-MINTED-AS-APEXCLASS: `Custom_Setting__c.getOrgDefaults()`,
 * `new Widget__c()`, and a SOQL field token like `Gadget_Calc__c` were
 * projected as `callsApex` / `references` to `ApexClass:{token}` phantoms while
 * the real `CustomObject:{token}` node stayed graph-orphan (its usages / delete
 * verdict read "unused / safe"). Recognising the suffix reroutes them to the
 * object node.
 */
const CUSTOM_OBJECT_SUFFIX = /__(?:c|mdt|e|b|x)$/;
const hasCustomObjectSuffix = (token: string): boolean =>
  CUSTOM_OBJECT_SUFFIX.test(token);

/**
 * A receiver token that looks like an Apex CLASS name: PascalCase (upper-initial)
 * and NOT an object-suffixed api name. camelCase receivers are locals the
 * heuristic scanner could not resolve; an object-suffixed receiver is an sObject.
 */
const looksLikeApexClassName = (token: string): boolean =>
  /^[A-Z]/.test(token) && !hasCustomObjectSuffix(token);

/**
 * A Salesforce FIELD api name is PascalCase (`Name`, `Industry`), custom
 * (`X__c`), or managed-namespaced (`ns__X__c`) — it always either starts
 * UPPERCASE or carries a `__` marker. An Apex static / instance field follows the
 * camelCase convention (`guardBefore`, `cachedValue`) — lowercase-initial with NO
 * `__`. Such a token can never be a schema field, so a `TypeName.camelField`
 * access is an Apex member reference, not an sObject field read/write.
 *
 * `class` is excluded: a `Type.class` literal is a reserved-word type token, not
 * a member field — it is left on its existing path (the AST/scanner merge already
 * downgrades the `CustomField:{Type}.class` FP on parsed files), so this change
 * introduces no churn for `.class` literals.
 *
 * APEX-STATIC-FIELD-CUSTOMFIELD-PHANTOMS: an Apex static boolean like
 * `WidgetGuard.guardBefore` / `.guardAfter` was minted as a
 * `CustomField:WidgetGuard.guardBefore` phantom, stealing the usage from the
 * real `ApexClass:WidgetGuard`.
 */
const isApexMemberFieldName = (field: string): boolean =>
  field !== 'class' && /^[a-z]/.test(field) && !field.includes('__');

/**
 * Strip Apex line / block comments and single-quoted string literals
 * from `source`, replacing them with same-length runs of spaces so
 * caller-side offsets stay valid. Mirrors the helper of the same name
 * in `apex-scanner.ts` — duplicated here so the v1.5
 * `dispatchesAsync` regex pass doesn't have to depend on the scanner's
 * private internals.
 */
const stripApexCommentsAndStrings = (source: string): string =>
  source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'/g,
    (match) => match.replace(/[^\n]/g, ' '),
  );

/**
 * Extract the generic argument from `Triggerable<{EventName}>` in the
 * given `implements` list entry. Returns `null` when the entry is not a
 * `Triggerable<...>` interface reference, or when the generic argument
 * is malformed / empty.
 *
 * The v1.5 apex-class extractor calls this against every entry of
 * `header.implements`. Whether the resulting event name is emitted as
 * a `listensTo` edge is decided at the call site (see
 * `buildClassListensToEdge` below) by checking the `__e` suffix:
 * PLAN-v1.5.md §3 reserves `listensTo` for Platform Event subscribers
 * specifically, mirroring the Salesforce convention that splits
 * `triggersOn` (sObject lifecycle) from `listensTo` (Platform Events).
 * `IntegrationTopologySemantics.md` Rule 2 has a more permissive
 * reading; the worker brief defers to PLAN-v1.5's stricter rule.
 *
 * @example
 *   triggerableEventFromImplements('Triggerable<Account_Change__e>')
 *   // => 'Account_Change__e'
 *   triggerableEventFromImplements('HttpCalloutMock')
 *   // => null
 */
export const triggerableEventFromImplements = (
  entry: string,
): string | null => {
  // Match `Triggerable<...>` with optional whitespace inside the
  // angle brackets. The captured group is the inner identifier; we
  // strip surrounding whitespace and validate it as a non-empty token.
  // The pre-class parser collapses whitespace inside generic arg
  // angle-brackets (see `readTypeRef`), so `Triggerable<X>` arrives
  // here without inner spaces — but tolerate the spaced form too.
  const match = /^Triggerable\s*<\s*([A-Za-z_][A-Za-z_0-9]*)\s*>$/.exec(
    entry,
  );
  return match?.[1] ?? null;
};

/**
 * Build a v1.5 `listensTo` edge from an `ApexClass` to the Platform
 * Event it subscribes to via `implements Triggerable<{Event}__e>`.
 * Carries `confidence: 'declared'` per
 * `IntegrationTopologySemantics.md` Rule 2 — the interface declaration
 * IS the subscription.
 *
 * Returns `null` when none of the entries in `implementsList` match
 * `Triggerable<...>`, or when the captured event name does not end in
 * `__e` (the apex-class extractor restricts production to Platform
 * Events; non-`__e` event names produce no edge so that the empty-
 * since-v1.0 `listensTo` slot stays semantically clean).
 *
 * Returns at most one edge — if the (unusual) case of multiple
 * `Triggerable<...>` entries on one class shows up, only the first is
 * emitted.
 */
export const buildClassListensToEdge = (
  ownerId: string,
  implementsList: readonly string[],
): Edge | null => {
  for (const entry of implementsList) {
    const eventName = triggerableEventFromImplements(entry);
    if (eventName === null) continue;
    // Per IntegrationTopologySemantics.md §"Rule 2", we restrict
    // production to `__e` events. A `Triggerable<Account>` would
    // be malformed Salesforce — letting it through would create a
    // listensTo edge to a non-Platform-Event CustomObject, which
    // breaks the `listensTo` / `triggersOn` separation v1.5
    // depends on.
    if (!eventName.endsWith('__e')) continue;
    return {
      fromId: ownerId,
      toId: `CustomObject:${eventName}`,
      edgeType: 'listensTo',
      confidence: 'declared',
      source: APEX_CLASS_SOURCE,
      properties: { eventName, mechanism: 'implementsTriggerable' },
    };
  }
  return null;
};

/**
 * Build the v1.5 `exposes` edges for the three API-surface annotations
 * the apex-class extractor recognizes:
 *
 *   - `@RestResource(urlMapping='/Foo')` → `ExternalApi:rest/Foo`
 *   - `@AuraEnabled` (any method) → `ExternalApi:aura/{Class}.{method}`
 *     — but since v1.5's parseApexHeader only captures bare
 *     annotation names (not method names), the synthetic-id for Aura
 *     and Invocable surfaces is the class-level
 *     `ExternalApi:aura/{Class}` form. Per
 *     `IntegrationTopologySemantics.md` §"Known limitations" #11, the
 *     v1.5 surface is per-class; method-level granularity is a
 *     v1.6+ extension.
 *   - `@InvocableMethod` (any method) → `ExternalApi:invocable/{Class}`
 *
 * All three carry `confidence: 'declared'`. The synthetic `toId` is
 * **not** a real graph node id — see `IntegrationTopologySemantics.md`
 * §"Synthetic-id pattern for `exposes`".
 *
 * Returns an empty array when none of the recognized patterns are
 * present.
 */
export const buildExposesEdges = (
  ownerId: string,
  className: string,
  restUrlMapping: string | null,
  methodAnnotationsSet: ReadonlySet<string>,
): readonly Edge[] => {
  const edges: Edge[] = [];
  if (restUrlMapping !== null) {
    // The `urlMapping` string IS the path; strip a single leading
    // slash so the synthetic id reads `rest/Accounts` not
    // `rest//Accounts`. A wildcard suffix (`'/Accounts/*'`) is
    // preserved as-is — the synthetic id `rest/Accounts/*` reflects
    // the source declaration.
    const path = restUrlMapping.startsWith('/')
      ? restUrlMapping.slice(1)
      : restUrlMapping;
    edges.push({
      fromId: ownerId,
      toId: `ExternalApi:rest/${path}`,
      edgeType: 'exposes',
      confidence: 'declared',
      source: APEX_CLASS_SOURCE,
      properties: { kind: 'rest', urlMapping: restUrlMapping },
    });
  }
  if (methodAnnotationsSet.has('AuraEnabled')) {
    edges.push({
      fromId: ownerId,
      toId: `ExternalApi:aura/${className}`,
      edgeType: 'exposes',
      confidence: 'declared',
      source: APEX_CLASS_SOURCE,
      properties: { kind: 'aura', className },
    });
  }
  if (methodAnnotationsSet.has('InvocableMethod')) {
    edges.push({
      fromId: ownerId,
      toId: `ExternalApi:invocable/${className}`,
      edgeType: 'exposes',
      confidence: 'declared',
      source: APEX_CLASS_SOURCE,
      properties: { kind: 'invocable', className },
    });
  }
  return edges;
};

/**
 * Build v1.5 `dispatchesAsync` edges for the three Apex-builtin
 * async-dispatch shapes the apex-class extractor recognizes in source:
 *
 *   - `System.enqueueJob(new X(...))` — Queueable dispatch.
 *   - `Database.executeBatch(new X(...), ...)` — Batchable dispatch.
 *   - `System.schedule(_, _, new X(...))` — Schedulable dispatch.
 *
 * All three emit `confidence: 'declared'` because the dispatch shape
 * unambiguously names the target class via the inline `new
 * {ClassName}(` constructor (see PLAN-v1.5.md §3 and
 * `IntegrationTopologySemantics.md` §"`dispatchesAsync` heuristic
 * patterns" Patterns 1-3).
 *
 * Pattern 4 (`@future`-method invocation, heuristic confidence)
 * requires a cross-class two-pass scan and is documented as a v1.6+
 * follow-up; the v1.5 producer does NOT emit those edges. The
 * `properties.hasFutureMethod: true` flag on each affected class is
 * the v1.5 surface for the architect's "what's async" question;
 * `dispatchesAsync` from the caller side waits for the resolver
 * upgrade.
 *
 * Source strings are stripped of comments and string literals before
 * the regex pass so a dispatch shape buried inside a quoted string or
 * a comment does not produce a false-positive edge.
 *
 * Edges are deduped by `(fromId, toId, edgeType)` and sorted by `toId`
 * ascending. Duplicates within a single source (the same caller
 * dispatching the same Queueable from multiple call sites) collapse to
 * one edge; the first occurrence wins (its properties span carries
 * the offset of the first dispatch).
 */
export const buildDispatchesAsyncEdges = (
  ownerId: string,
  source: string,
): readonly Edge[] => {
  const stripped = stripApexCommentsAndStrings(source);
  const raw: Edge[] = [];
  const PATTERNS: ReadonlyArray<{
    readonly regex: RegExp;
    readonly mechanism: 'enqueueJob' | 'executeBatch' | 'schedule';
  }> = [
    {
      regex:
        /\bSystem\s*\.\s*enqueueJob\s*\(\s*new\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(/g,
      mechanism: 'enqueueJob',
    },
    {
      regex:
        /\bDatabase\s*\.\s*executeBatch\s*\(\s*new\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(/g,
      mechanism: 'executeBatch',
    },
    {
      // `System.schedule(name, cron, new X())` — match through two
      // comma-separated arguments before the `new {ClassName}(` site.
      // The arguments themselves may contain method calls / arithmetic
      // / string concatenations; `[^,]+?` reluctantly consumes up to
      // the next comma at the outer level. This is the same simplification
      // documented in IntegrationTopologySemantics.md Pattern 3.
      regex:
        /\bSystem\s*\.\s*schedule\s*\(\s*[^,]+?,\s*[^,]+?,\s*new\s+([A-Za-z_][A-Za-z_0-9]*)\s*\(/g,
      mechanism: 'schedule',
    },
  ];
  for (const { regex, mechanism } of PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(stripped)) !== null) {
      const className = m[1];
      if (className === undefined || className.length === 0) continue;
      raw.push({
        fromId: ownerId,
        toId: `ApexClass:${className}`,
        edgeType: 'dispatchesAsync',
        confidence: 'declared',
        source: APEX_CLASS_SOURCE,
        properties: {
          dispatchMechanism: mechanism,
          offset: m.index,
          length: m[0].length,
        },
      });
    }
  }
  return mergeAndSortEdges(raw);
};

/**
 * Strip Apex line / block comments ONLY, replacing them with same-length runs
 * of spaces so caller-side offsets stay valid. Unlike
 * {@link stripApexCommentsAndStrings}, string literals are KEPT — the
 * `callout:{NamedCredential}` endpoint scheme lives INSIDE a string literal
 * (`req.setEndpoint('callout:My_NC/path')`), so blanking strings (as the
 * scanner and the async-dispatch pass do) is exactly why the callout was
 * invisible to the graph. A commented-out callout still mints no edge.
 */
const stripApexCommentsOnly = (source: string): string =>
  source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => match.replace(/[^\n]/g, ' '),
  );

/**
 * The `callout:{NamedCredential}` endpoint scheme. The Named Credential name is
 * the identifier run immediately after `callout:` — a leading `/path`, query
 * string, or `.` merge suffix terminates it. Runs on comment-stripped (but
 * string-KEPT) source, so a static `callout:Foo` in an endpoint literal is
 * captured while a dynamic `'callout:' + ncName` (variable concatenation) is
 * not — the char after `callout:` is `'`, matching nothing. Case-sensitive
 * lowercase `callout:` matches Salesforce's scheme literal.
 */
const CALLOUT_PATTERN = /callout:([A-Za-z0-9_]+)/g;

/**
 * NAMED-CREDENTIAL-APEX-CALLOUT-UNGRAPHED: build heuristic `references` edges
 * from an ApexClass / ApexTrigger (`ownerId`) to every Named Credential it
 * invokes via the `callout:{NamedCredential}` endpoint scheme.
 *
 * These references live INSIDE string literals, which every existing Apex pass
 * (the heuristic scanner AND `buildDispatchesAsyncEdges`) blanks before
 * scanning — so the callout produced NO graph edge even though
 * `find_component_usages` grep and `search_apex_source` surfaced it.
 * Downstream, `find_code_usages` returned empty, `integration_map` /
 * `endpoint_catalog` marked the credential `orphaned: true` /
 * `referenceCount: 0`, and `review_change` delete read `safe`. Emitting this
 * edge feeds all four graph-backed consumers from the same evidence the grep
 * tier already had.
 *
 * `confidence: 'heuristic'` — the endpoint is a runtime string, not a declared
 * metadata pointer. Edges are deduped by target at the call site via
 * {@link mergeAndSortEdges}; the first occurrence's offset/length is kept.
 */
export const buildApexCalloutEdges = (
  ownerId: string,
  source: string,
): readonly Edge[] => {
  const scanned = stripApexCommentsOnly(source);
  const raw: Edge[] = [];
  CALLOUT_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALLOUT_PATTERN.exec(scanned)) !== null) {
    const name = m[1];
    if (name === undefined || name.length === 0) continue;
    raw.push({
      fromId: ownerId,
      toId: `NamedCredential:${name}`,
      edgeType: 'references',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: {
        referenceKind: 'apexCallout',
        offset: m.index,
        length: m[0].length,
      },
    });
  }
  return raw;
};

/**
 * Result of running the heuristic Apex scanner and projecting its output
 * onto graph edges. `edges` is the deduped, sorted edge list ready to
 * merge into an extractor's `ExtractionResult.edges`. `warnings` is a
 * non-empty list when the scanner returned an error; the extractor
 * surfaces it as `node.properties.apexScannerWarnings` so consumers can
 * diagnose why no scanner edges were produced.
 *
 * Why warnings live on the Node (and not as edges with `kind: error`):
 * `flow.ts` set the precedent with `flowExtractionWarnings`, and the
 * graph layer only models real component relationships — parse failures
 * are diagnostics, not edges.
 */
export interface ApexEdgesResult {
  readonly edges: readonly Edge[];
  readonly warnings: readonly string[];
}

/**
 * Map the frontend scanner's `resourceRefs` to graph `references` edges
 * (P14-USAGE-label-static-graph): CustomLabel / StaticResource get their own
 * node types; a Custom Setting read targets the CustomObject node (custom
 * settings are modeled as CustomObject in the vault). The CALLER picks the
 * confidence: LWC refs come from declarative `import` statements
 * (`declared`); Aura/VF refs are regex value-provider tokens (`heuristic`).
 */
export const buildResourceRefEdges = (
  ownerId: string,
  refs: readonly FrontendResourceRef[],
  source: string,
  confidence: Edge['confidence'],
): Edge[] =>
  refs.map((ref) => ({
    fromId: ownerId,
    toId:
      ref.kind === 'label'
        ? `CustomLabel:${ref.apiName}`
        : ref.kind === 'staticResource'
          ? `StaticResource:${ref.apiName}`
          : `CustomObject:${ref.apiName}`,
    edgeType: 'references',
    confidence,
    source,
    properties: { resourceKind: ref.kind, offset: ref.offset, length: ref.length },
  }));

/**
 * Deduplicate by `(fromId, toId, edgeType)` and sort by `toId` ascending,
 * then `edgeType` ascending. Matches the precedent set by `flow.ts`'s
 * `dedupeAndSortEdges` so consumers see byte-stable edge order regardless
 * of how each edge was produced (declared trigger header vs heuristic
 * scanner). First occurrence wins on dedupe so the original
 * `properties` payload (offset/length spans) is preserved for hover and
 * diagnostic UIs.
 *
 * Use from `apex-trigger.ts` to merge the declared `triggersOn` edge
 * with the scanner edges into a single uniformly-sorted array.
 * `apex-class.ts` doesn't need it — `buildApexScannerEdges` already
 * returns its output sorted.
 *
 * @example
 *   const merged = mergeAndSortEdges([triggersOnEdge, ...scannerEdges]);
 *   // merged is sorted by toId asc, then edgeType asc; duplicates dropped.
 */
export const mergeAndSortEdges = (edges: readonly Edge[]): readonly Edge[] => {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const edge of edges) {
    const key = `${edge.fromId}|${edge.toId}|${edge.edgeType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  out.sort((a, b) => {
    if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
    if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
    return 0;
  });
  return out;
};

/**
 * Scan Apex source for field accesses and method calls via the v0.3
 * heuristic scanner and project the results onto `Edge` records owned by
 * `ownerId` (an `ApexClass:{name}` or `ApexTrigger:{name}` canonical ID).
 *
 * Edge shapes (every edge carries `confidence: 'heuristic'` and
 * `source: 'apex-scanner'`):
 *
 *   - `FieldAccess { type: 'read' }`  → `readsFrom` from `ownerId` to
 *     `CustomField:{object}.{field}` with
 *     `properties: { offset, length }`. EXCEPTION
 *     (APEX-STATIC-FIELD-CUSTOMFIELD-PHANTOMS): a camelCase-no-`__` member on a
 *     PascalCase class token (`WidgetGuard.guardBefore`) is an Apex
 *     static/instance field — it is emitted as `references` →
 *     `ApexClass:{object}` (`properties.mechanism: 'apexStaticField'`) instead of
 *     a `CustomField:{Class}.{field}` phantom.
 *   - `FieldAccess { type: 'write' }` → `writesTo`  from `ownerId` to
 *     `CustomField:{object}.{field}` with
 *     `properties: { offset, length }` (same static-field exception as reads).
 *   - `MethodCallSite`                → one `callsApex` from `ownerId` to
 *     `ApexClass:{className}` per target class, with
 *     `properties: { methods: string[], methodName, offset, length }` —
 *     `methods` is the complete sorted set of that target's methods this
 *     owner calls (P4-C5 method-level), `methodName` the first for
 *     back-compat, `offset`/`length` the span of the first call site.
 *     EXCEPTION (APEX-SOBJECT-REF-MINTED-AS-APEXCLASS): when `className` is an
 *     object-suffixed api name (`Custom_Setting__c.getOrgDefaults()`), the call
 *     is a static reference to that sObject / custom setting — emitted as
 *     `references` → `CustomObject:{className}`
 *     (`properties.mechanism: 'apexStaticObjectRef'`), NOT `callsApex ApexClass`.
 *   - `Instantiation`                 → `references` from `ownerId` to
 *     `ApexClass:{className}` with
 *     `properties: { mechanism: 'instantiation', offset, length }`.
 *     This is the generic `new ClassName(...)` dependency the
 *     `IDENT.IDENT(` method-call sweep is blind to (e.g. a `new X()`
 *     passed as a method argument). `references` is the right edge
 *     here: `dispatchesAsync` is async-only and `callsApex` would
 *     conflate constructor invocations with method calls. An object-suffixed
 *     `new Widget__c()` targets `CustomObject:{className}` instead of
 *     `ApexClass:` (APEX-SOBJECT-REF-MINTED-AS-APEXCLASS).
 *   - `SoqlFromObject`                → `readsFrom` from `ownerId` to
 *     `CustomObject:{object}` with
 *     `properties: { mechanism: 'soql', offset, length }` — the primary
 *     object queried by an inline SOQL `[SELECT ... FROM {object}]`. This
 *     is the OBJECT-level counterpart to the field-level `readsFrom` above;
 *     it surfaces SOQL usage that the field-access sweep alone misses (a
 *     `[SELECT Id FROM Account]` that touches no `acc.Field`).
 *   - `callout:{NamedCredential}` endpoint literal → `references` from
 *     `ownerId` to `NamedCredential:{name}` with
 *     `properties: { referenceKind: 'apexCallout', offset, length }`
 *     (heuristic). Read from the string-KEPT source (see
 *     {@link buildApexCalloutEdges}) — the one Apex reference that lives
 *     inside a string literal and is therefore invisible to the field/call
 *     sweeps, which blank strings.
 *
 * The scanner does no symbol resolution: `object` is a variable name as
 * it appears in source (e.g., `this`, `acc`, `mainMarketoSetting`). The
 * `toId` preserves that literal under the `CustomField:` prefix; a v0.4
 * resolver will rewrite to canonical SObject IDs once Apex AST analysis
 * lands. Until then these edges are intentionally noisy — the
 * `heuristic` label tells consumers to rank them lower than `parsed` or
 * `declared` edges.
 *
 * Scanner errors (`empty-source`, `no-class-or-trigger`,
 * `unbalanced-braces`) are non-fatal: the extractor still emits its Node
 * (and any declared edges like a trigger's `triggersOn`). This helper
 * returns `edges: []` and a single warning string in `warnings`.
 *
 * @example
 *   const result = buildApexScannerEdges(
 *     'public class Foo { void run() { acc.Industry__c = "X"; } }',
 *     'ApexClass:Foo',
 *   );
 *   // result.edges[0].edgeType === 'writesTo'
 *   // result.edges[0].toId    === 'CustomField:acc.Industry__c'
 *   // result.warnings.length === 0
 */
export const buildApexScannerEdges = (
  source: string,
  ownerId: string,
): ApexEdgesResult => {
  const scanResult = scanApexSource(source);
  if (!scanResult.ok) {
    const { kind, offset, message } = scanResult.error;
    return {
      // NAMED-CREDENTIAL-APEX-CALLOUT-UNGRAPHED: callout edges do not depend on
      // the brace-balanced scan succeeding (they are a raw string scan), so a
      // class the scanner rejects still surfaces its Named Credential callouts.
      edges: mergeAndSortEdges(buildApexCalloutEdges(ownerId, source)),
      // Format documented in v0.3 wiring spec; consumers parse this
      // by prefix to surface scanner failures in the vault UI.
      warnings: [`apex-scanner: ${kind} at offset ${offset}: ${message}`],
    };
  }

  const raw: Edge[] = [];
  // NAMED-CREDENTIAL-APEX-CALLOUT-UNGRAPHED: `callout:{NamedCredential}`
  // references (string-literal endpoints the scanner blanks) → heuristic
  // `references` edges to the Named Credential node.
  raw.push(...buildApexCalloutEdges(ownerId, source));
  for (const access of scanResult.value.fieldAccesses) {
    // Drop field accesses on unresolvable receivers (Trigger context / this / super).
    if (UNRESOLVABLE_FIELD_RECEIVERS.has(access.object)) continue;
    // APEX-STATIC-FIELD-CUSTOMFIELD-PHANTOMS: a camelCase-no-`__` member on a
    // PascalCase class token (`WidgetGuard.guardBefore`) is an Apex
    // static/instance field, not a schema field. Emit the real class dependency
    // (`references ApexClass:{Class}`) instead of a `CustomField:{Class}.{field}`
    // phantom that steals the usage from the actual class node. A non-class-shaped
    // receiver (a camelCase local, an object-suffixed token) falls through to the
    // existing CustomField path — this reroutes ONLY the static-field shape.
    if (
      isApexMemberFieldName(access.field) &&
      looksLikeApexClassName(access.object)
    ) {
      raw.push({
        fromId: ownerId,
        toId: `ApexClass:${access.object}`,
        edgeType: 'references',
        confidence: 'heuristic',
        source: SCANNER_SOURCE,
        properties: {
          mechanism: 'apexStaticField',
          field: access.field,
          offset: access.offset,
          length: access.length,
        },
      });
      continue;
    }
    raw.push({
      fromId: ownerId,
      toId: `CustomField:${access.object}.${access.field}`,
      edgeType: access.type === 'write' ? 'writesTo' : 'readsFrom',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: { offset: access.offset, length: access.length },
    });
  }
  // P4-C5 method-level: aggregate every call site to the same target class
  // into ONE `callsApex` edge that carries the COMPLETE set of called methods.
  // Previously one edge was pushed per `(className, methodName)` pair and
  // `mergeAndSortEdges` then deduped by `(from, to, edgeType)` — keeping only
  // the first `methodName`. So a caller invoking `Handler.deleteRecord` AND
  // `Handler.save` surfaced only ONE method, silently dropping method-level
  // callers (and making `what_if_change_method_signature` miss callers of the
  // dropped method). Grouping here preserves every method on a `methods[]`
  // property; `methodName` is kept (the alphabetically-first) for back-compat
  // with pre-P4-C5 readers.
  const callsByClass = new Map<
    string,
    { methods: Set<string>; offset: number; length: number }
  >();
  // APEX-SOBJECT-REF-MINTED-AS-APEXCLASS: a static call whose receiver is an
  // object-suffixed token (`Custom_Setting__c.getOrgDefaults()`,
  // `ns__Widget__c.foo()`) is a reference to that sObject / custom setting, NOT a
  // call to an Apex class. Route it to the object node (deduped by object; first
  // call site's span wins) instead of an `ApexClass:{__c}` phantom.
  const objectRefs = new Map<string, { offset: number; length: number }>();
  for (const call of scanResult.value.methodCalls) {
    // Drop calls on unresolvable pseudo-classes (Trigger.newMap → `newMap`, etc.).
    if (UNRESOLVABLE_CALL_CLASSES.has(call.className)) continue;
    if (hasCustomObjectSuffix(call.className)) {
      if (!objectRefs.has(call.className)) {
        objectRefs.set(call.className, {
          offset: call.offset,
          length: call.length,
        });
      }
      continue;
    }
    const existing = callsByClass.get(call.className);
    if (existing === undefined) {
      callsByClass.set(call.className, {
        methods: new Set([call.methodName]),
        offset: call.offset,
        length: call.length,
      });
    } else {
      existing.methods.add(call.methodName);
    }
  }
  for (const [objectName, span] of objectRefs) {
    raw.push({
      fromId: ownerId,
      toId: `CustomObject:${objectName}`,
      edgeType: 'references',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: {
        mechanism: 'apexStaticObjectRef',
        offset: span.offset,
        length: span.length,
      },
    });
  }
  for (const [className, agg] of callsByClass) {
    const methods = [...agg.methods].sort();
    raw.push({
      fromId: ownerId,
      toId: `ApexClass:${className}`,
      edgeType: 'callsApex',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: {
        methods,
        methodName: methods[0] ?? '',
        offset: agg.offset,
        length: agg.length,
      },
    });
  }
  for (const inst of scanResult.value.instantiations) {
    // APEX-SOBJECT-REF-MINTED-AS-APEXCLASS: `new Widget__c()` constructs an
    // sObject record, not an Apex class instance — route the reference to the
    // real `CustomObject:{name}` node instead of an `ApexClass:{__c}` phantom.
    // A standard-object / user-class instantiation (`new Account()`, `new
    // Handler()`) keeps the `ApexClass:` target (import-time targetMissing hides
    // the standard-object case, as before).
    const toId = hasCustomObjectSuffix(inst.className)
      ? `CustomObject:${inst.className}`
      : `ApexClass:${inst.className}`;
    raw.push({
      fromId: ownerId,
      toId,
      edgeType: 'references',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: {
        mechanism: 'instantiation',
        offset: inst.offset,
        length: inst.length,
      },
    });
  }
  // P13: the primary object of each inline SOQL `[SELECT ... FROM {obj}]` →
  // an OBJECT-level `readsFrom` edge (distinct from the field-level readsFrom
  // above, which targets a `CustomField`). This lifts SOQL-FROM usage out of
  // the grep-only tier into the dependency graph; an object name that does not
  // resolve to a real node is tagged `targetMissing` at import and hidden.
  for (const soql of scanResult.value.soqlFromObjects) {
    raw.push({
      fromId: ownerId,
      toId: `CustomObject:${soql.object}`,
      edgeType: 'readsFrom',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: {
        mechanism: 'soql',
        offset: soql.offset,
        length: soql.length,
      },
    });
  }
  // P3b: `EventBus.subscribe('X__e', ...)` → a heuristic `listensTo` edge to the
  // Platform Event node, REUSING the existing `listensTo` EdgeType (the same
  // slot `Triggerable<X__e>` and Flow PlatformEvent triggers fill). HONESTY:
  // emit ONLY when the scanner RESOLVED a static channel that names a real
  // Platform Event (`__e` suffix). A dynamic/computed channel arg
  // (`resolved: false`) mints NO edge — no phantom — mirroring the
  // EventBus.publish publisher honesty. Non-`__e` channels (e.g. CDC
  // `*ChangeEvent` streams) are skipped here so `listensTo` stays
  // Platform-Event-only, matching `buildClassListensToEdge`'s `__e` gate; CDC
  // subscription has its own `subscribesToChange` modeling path.
  for (const sub of scanResult.value.eventSubscriptions) {
    if (!sub.resolved) continue;
    if (!sub.channel.endsWith('__e')) continue;
    raw.push({
      fromId: ownerId,
      toId: `CustomObject:${sub.channel}`,
      edgeType: 'listensTo',
      confidence: 'heuristic',
      source: SCANNER_SOURCE,
      properties: {
        mechanism: 'eventBusSubscribe',
        eventName: sub.channel,
        offset: sub.offset,
        length: sub.length,
      },
    });
  }
  return { edges: mergeAndSortEdges(raw), warnings: [] };
};
