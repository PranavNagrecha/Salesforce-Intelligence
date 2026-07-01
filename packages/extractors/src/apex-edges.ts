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
 *     `properties: { offset, length }`.
 *   - `FieldAccess { type: 'write' }` → `writesTo`  from `ownerId` to
 *     `CustomField:{object}.{field}` with
 *     `properties: { offset, length }`.
 *   - `MethodCallSite`                → one `callsApex` from `ownerId` to
 *     `ApexClass:{className}` per target class, with
 *     `properties: { methods: string[], methodName, offset, length }` —
 *     `methods` is the complete sorted set of that target's methods this
 *     owner calls (P4-C5 method-level), `methodName` the first for
 *     back-compat, `offset`/`length` the span of the first call site.
 *   - `Instantiation`                 → `references` from `ownerId` to
 *     `ApexClass:{className}` with
 *     `properties: { mechanism: 'instantiation', offset, length }`.
 *     This is the generic `new ClassName(...)` dependency the
 *     `IDENT.IDENT(` method-call sweep is blind to (e.g. a `new X()`
 *     passed as a method argument). `references` is the right edge
 *     here: `dispatchesAsync` is async-only and `callsApex` would
 *     conflate constructor invocations with method calls.
 *   - `SoqlFromObject`                → `readsFrom` from `ownerId` to
 *     `CustomObject:{object}` with
 *     `properties: { mechanism: 'soql', offset, length }` — the primary
 *     object queried by an inline SOQL `[SELECT ... FROM {object}]`. This
 *     is the OBJECT-level counterpart to the field-level `readsFrom` above;
 *     it surfaces SOQL usage that the field-access sweep alone misses (a
 *     `[SELECT Id FROM Account]` that touches no `acc.Field`).
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
      edges: [],
      // Format documented in v0.3 wiring spec; consumers parse this
      // by prefix to surface scanner failures in the vault UI.
      warnings: [`apex-scanner: ${kind} at offset ${offset}: ${message}`],
    };
  }

  const raw: Edge[] = [];
  for (const access of scanResult.value.fieldAccesses) {
    // Drop field accesses on unresolvable receivers (Trigger context / this / super).
    if (UNRESOLVABLE_FIELD_RECEIVERS.has(access.object)) continue;
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
  for (const call of scanResult.value.methodCalls) {
    // Drop calls on unresolvable pseudo-classes (Trigger.newMap → `newMap`, etc.).
    if (UNRESOLVABLE_CALL_CLASSES.has(call.className)) continue;
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
    raw.push({
      fromId: ownerId,
      toId: `ApexClass:${inst.className}`,
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
