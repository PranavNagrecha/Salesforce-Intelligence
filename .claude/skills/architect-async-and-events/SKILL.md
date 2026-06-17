---
name: architect-async-and-events
description: |
  Answers Salesforce architect async + event-driven topology questions
  that v2.8 surfaces beyond the v1.5 integration tier. Triggers:
  "who subscribes to CDC events on Account", "what change-data-capture
  subscribers do we have", "what's the async chain depth from this
  Queueable", "show me every scheduled job", "what outbound messages
  does this org send", "give me every endpoint URL in one place".
  Drives the v2.8 cascade: `cdc_subscribers` (Change Data Capture
  subscribers via name-pattern detection), `async_chain_depth`
  (transitive `dispatchesAsync` walk; chainAsync NOT persisted),
  `scheduled_job_catalog` (cron-driven jobs from `System.schedule`
  detection), `outbound_message_catalog` (the new v2.8 OutboundMessage
  ComponentType promoted from WorkflowRule dangling refs),
  `endpoint_catalog` (unified URL view across REST exposes /
  OutboundMessage / ExternalDataSource / NamedCredential). Discloses
  v2.8 boundaries verbatim: URL-not-validated, name-pattern detection
  for CDC, depth-cap of 10, Tooling API gap for actual cron
  registration. Extends `architect-integration-topology` rather than
  replacing it; defer there for the v1.5 declared-integration tier.
---

# Architect async and events

## Overview

This skill is the v2.8 EXTENSION to the architect persona's
integration-topology skill (`architect-integration-topology`). Where
v1.5 ships the declared integration tier (`integration_map`,
`event_subscribers`, the async / API-surface property booleans), v2.8
adds the async-deep tier covering four categories v1.5 EXCLUDED:

1. **Change Data Capture (CDC) subscription detection.** v1.5's
   `event_subscribers` is scoped to Platform Events (`__e` suffix
   on the ApiName); CDC events use a different name pattern
   (`{ObjectName}ChangeEvent` for standard objects,
   `{Object}__ChangeEvent` for custom objects). v2.8's
   `sfi.cdc_subscribers` recognizes both shapes via name pattern.
2. **Async chain depth analysis.** v1.5 emits one-hop
   `dispatchesAsync` edges (Queueable / Schedulable / Batchable /
   @future caller → job). v2.8's `sfi.async_chain_depth` walks the
   transitive chain — a job that queues another job that queues
   another job, surfacing the depth, every branch point, and any
   cycles.
3. **Scheduled job catalog.** v1.5 detects
   `System.schedule(name, cron, instance)` invocations but does
   not promote the schedule itself to a first-class catalog
   surface. v2.8's `sfi.scheduled_job_catalog` walks every
   ApexClass with `isSchedulable: true` AND every
   `dispatchesAsync` edge with `dispatchMechanism: 'schedule'`,
   producing the cron-driven topology in one shot.
4. **OutboundMessage promotion.** v1.3 left
   WorkflowRule `<outboundMessages>` as dangling-by-design
   references. v2.8 promotes each entry to a real
   `OutboundMessage` node (the new v2.8 ComponentType), so the
   admin can catalog every SOAP outbound destination separately
   from the WorkflowRule that fires it.

Plus a fifth, unified surface:

5. **Endpoint catalog.** `sfi.endpoint_catalog` returns every URL
   the org touches in one structured response — inbound (REST
   `exposes` synthetic ids) + outbound (OutboundMessage
   endpointUrl + ExternalDataSource endpoint + NamedCredential
   url). This is the URL-axis sibling of `sfi.integration_map`
   (which surfaces NODES + their wiring) and
   `sfi.outbound_message_catalog` (which surfaces ONE category in
   depth).

The boundary that matters for architects: **v2.8 does NOT probe,
validate, or confirm any endpoint URL.** The cataloged URLs are
verbatim from metadata XML or Apex source — runtime registration
(a NamedCredential resolved via custom metadata at runtime) may
carry a stored URL that differs from the actual production
destination. The architect verifies separately.

The v2.8 cdcEnabled boundary: CDC subscription detection is
**name-pattern only.** v2.8 recognizes `{Object}ChangeEvent` and
`*__ChangeEvent` shapes but does NOT extract the
`*.platformEventChannelMember-meta.xml` per-channel filter
expressions, does NOT detect programmatic
`EventBus.subscribe(...)` registrations, and does NOT extract CDC
membership from `*.platformEventChannel-meta.xml` files (an
enrichment pass populates `isCdcEnabled` on CustomObject nodes but
the pattern-match runs against the channel registration).

The v2.8 `chainAsync` non-persistence: the transitive chain edge
is composed AT QUERY TIME by `sfi.async_chain_depth`. The
architect cannot query `sfi.get_edges` for `chainAsync` — only
this tool surfaces the transitive shape. State this when
explaining why a chain-walk question can't be answered via
`get_edges` directly.

The v2.8 cron-parse-failure axis: the v2.8 ScheduledJob synthetic
node carries `parsedCron` (when `cron-parser` parses cleanly) or
`null` (when the cron uses Salesforce-specific tokens `L`, `W`,
`#`, `LAST_FRIDAY`, etc.). When `parsedCron` is `null`, the
ScheduledJob node's `confidence` is `'declared'` (the schedule IS
declared by `System.schedule`) and the verbatim per-entry
fallback disclosure surfaces.

## When to fire

Fire this skill on async / event / scheduled-job / outbound-message
/ endpoint-catalog phrasing. Concrete triggers:

### CDC subscription shape

- **"Who subscribes to CDC events on `Account`?"** /
  **"What's the CDC topology for `Account`?"** —
  Use `sfi.cdc_subscribers` with
  `sObjectFilter: 'Account'`.
- **"What change-data-capture subscribers do we have?"** /
  **"Audit our CDC subscribers."** — Use `sfi.cdc_subscribers`
  with no filter.
- **"Who listens to `AccountChangeEvent`?"** — Same; v2.8
  recognizes the event-name pattern.

### Async chain depth shape

- **"What's the async chain depth from
  `ApexClass:AccountIndexer`?"** /
  **"Walk the async chain rooted at this Queueable."** —
  Use `sfi.async_chain_depth` with
  `rootApexClassId: 'ApexClass:AccountIndexer'`.
- **"How deep does this Queueable chain go?"** —
  Same; default `maxDepth: 10`.
- **"Are there cycles in our async dispatch graph?"** /
  **"Show me where Queueables enqueue themselves."** — Use
  `sfi.async_chain_depth` on each suspected root; surface the
  `cyclesDetected[]` array.

### Scheduled job shape

- **"Show me every scheduled job in this org."** /
  **"Audit our cron-driven Apex."** /
  **"What runs on a schedule?"** — Use
  `sfi.scheduled_job_catalog`.
- **"What's the cron for `NightlyAccountsRefresh`?"** /
  **"Decode this scheduled job."** — Same; surface the
  `rawCronExpression` + `parsedCron` per entry.

### Outbound message shape

- **"What outbound messages does this org send?"** /
  **"Catalog our SOAP outbound messages."** — Use
  `sfi.outbound_message_catalog`.
- **"What's the outbound destination from `Account` workflow
  rules?"** — Use `sfi.outbound_message_catalog` with
  `objectFilter: 'Account'`.
- **"Which WorkflowRule fires `Notify_Marketing_Automation`?"** —
  Same; the catalog entry surfaces `invokedByWorkflowRules`.

### Unified endpoint catalog shape

- **"Show me every URL this org touches."** /
  **"Give me the endpoint inventory."** /
  **"Audit our endpoint footprint."** — Use
  `sfi.endpoint_catalog`.

## When NOT to fire

Defer to another skill when:

- **The user asks "what subscribes to `Account_Change__e`?"** (a
  Platform Event, `__e` suffix). That's v1.5's
  `sfi.event_subscribers` shape; defer to
  `architect-integration-topology`. CDC and Platform Events are
  separate axes.
- **The user asks for the broad integration map** ("draw me our
  integration map", "what auth providers / named credentials /
  external data sources do we have"). That's v1.5's
  `sfi.integration_map`; defer to
  `architect-integration-topology`.
- **The user asks for one-hop async dispatch info** ("what calls
  `enqueueJob(new AccountIndexer())`?", "find every `@future`
  method"). v1.5 covers one-hop; defer to
  `architect-integration-topology`. v2.8's
  `sfi.async_chain_depth` is for the TRANSITIVE walk specifically.
- **The user asks "what breaks if I disable this trigger?"** That's
  v2.3 what-if; defer to `developer-impact-and-reachability` →
  `sfi.what_if_disable_trigger`.
- **The user asks for code-level reachability** ("where is
  `AccountIndexer` reachable from?"). That's v2.7
  `sfi.call_graph` over `callsApex` edges; defer to
  `developer-impact-and-reachability`. `sfi.async_chain_depth`
  walks `dispatchesAsync` only.
- **The user wants live data** ("how many times did
  `NightlyAccountsRefresh` run last week?"). v2.8 is offline; the
  Tooling API gap means the actual scheduled job registration
  is invisible. Tell the user to query Setup → Scheduled Jobs.
- **The user names an Experience Cloud / Sites surface.** v2.8
  doesn't cover that; v1.5's boundary applies.

## The cascade

Five tools, five distinct surfaces. Pick the right entry point.

### 1. `sfi.cdc_subscribers` — Change Data Capture subscribers

Walks `listensTo` edges WHOSE TARGET MATCHES the CDC name
pattern: `{ObjectName}ChangeEvent` for standard objects,
`*__ChangeEvent` for custom objects.

```json
{ "sObjectFilter": "Account" }   // narrow to one object
{}                                // every CDC-subscribed object
```

When `sObjectFilter` is supplied, resolves the synthetic
ChangeEvent id from the filter (e.g., `Account` →
`AccountChangeEvent`; `Order__c` → `Order__ChangeEvent`) and
scans incoming `listensTo` edges for that single event. When
omitted, walks every CustomObject whose apiName matches the CDC
name pattern and aggregates their incoming `listensTo` edges.

Subscribers are restricted to ApexTrigger, ApexClass, Flow — the
three v1.5 R3 `listensTo` producers.

Fire this when the user asks about CDC topology. Surface the
verbatim disclosure: CDC subscription detection here recognizes
by NAME PATTERN only. Programmatic `EventBus.subscribe(...)`
registration is INVISIBLE.

For the v2.8 `properties.isCdcEnabled` flag on CustomObject (the
parent-side classifier — was this object enabled for CDC in the
channel registration?), use `sfi.get_component` on the parent
CustomObject and read `properties.isCdcEnabled`. The
`cdc_subscribers` tool answers the subscriber-side question; the
isCdcEnabled flag answers the producer-side question.

### 2. `sfi.async_chain_depth` — transitive `dispatchesAsync` walk

BFS from `rootApexClassId` over outgoing `dispatchesAsync`
edges. Each edge is recorded as a `(fromId, toId, depth)` tuple
so the renderer can draw the chain.

```json
{ "rootApexClassId": "ApexClass:AccountIndexer", "maxDepth": 10 }
```

The depth cap is 10. Chains deeper than 10 hops are TRUNCATED
(the `truncated` flag flips true). This is the v2.8 honesty axis
— runtime async chains can be arbitrarily long, but the v2.8
contract caps the static walk to keep the answer bounded.

Cycle detection: a frontier node whose id was already visited
flips `cyclesDetected: true`. The walk does NOT abort on cycles
— it continues to surface every reachable node — but the flag is
the honest signal that the chain has a loop. The most common
cycle is the self-enqueueing Queueable
(`AccountIndexer.execute()` ending with
`System.enqueueJob(new AccountIndexer())` for chunking).

Branch points: a class with more than one outgoing
`dispatchesAsync` edge to DIFFERENT targets is a branch. The
response surfaces every class with `branchCount >= 2` in the
`branchPoints` array.

Note the `chainAsync` non-persistence: the transitive chain edge
is composed AT QUERY TIME; it's NOT in the graph. State this when
the user asks why the chain doesn't show up in `sfi.get_edges`.

### 3. `sfi.scheduled_job_catalog` — cron-driven Apex topology

Walks the graph for two distinct signals:

1. **ApexClass nodes with `properties.isSchedulable === true`.**
   These are classes implementing the `Schedulable` interface;
   they are schedule-CAPABLE but not necessarily currently
   scheduled (the actual schedule lives in `CronTrigger` /
   `AsyncApexJob`, which v2.8 does NOT query in the offline
   path).
2. **`dispatchesAsync` edges with
   `properties.dispatchMechanism === 'schedule'`.** The v1.5 R3
   producer's `System.schedule(...)` call sites the Apex
   scanner detected; each edge names the target class plus the
   caller.

```json
{}
```

Catalog is per-class — one entry per Schedulable class. Classes
that are Schedulable but lack any `System.schedule(...)` call
site surface with empty `scheduledByCalls[]` arrays (they exist
on disk as Schedulable but no Apex source actually schedules
them — usually scheduled via the UI or external tooling).

Surface the verbatim honesty axis: scanning for
`System.schedule(...)` invocations is heuristic; the actual
runtime schedule lives in the `CronTrigger` / `AsyncApexJob`
Tooling API surface and is invisible to the offline DX-source
scanner. A class flagged "schedulable" may NOT be currently
scheduled — the schedule is a runtime registration.

When the `parsedCron` is `null` on a catalog entry, the cron
expression uses a Salesforce-specific token (`L`, `W`, `#`,
`LAST_FRIDAY`, etc.) the v2.8 `cron-parser` doesn't support.
Surface the verbatim per-entry fallback disclosure:

> The cron expression `{rawCron}` did not parse cleanly; the raw
> string is shown verbatim. Verify the schedule's meaning
> manually before relying on this entry for refactor decisions.

### 4. `sfi.outbound_message_catalog` — SOAP outbound destination catalog

Walks the `OutboundMessage` node family v2.8 promotes from
WorkflowRule dangling references into real nodes.

```json
{}                              // every OutboundMessage
{ "objectFilter": "Account" }   // narrow to one parent object
```

Each catalog entry carries:
- Identity (`id`, `apiName`, `name`).
- Four endpoint properties (`endpointUrl`,
  `includeSessionId`, `useDeadLetterQueue`,
  `integrationUser`).
- `fields[]` (the SOAP body's payload shape — array of field API
  names in source order).
- Parent CustomObject id.
- `invokedByWorkflowRules[]` — every WorkflowRule with an
  `<actions>` reference to this outbound message (the v1.3
  reference shape preserved by the v2.8 promotion).

Surface the URL-not-probed disclosure: the endpoint URL is
captured verbatim — v2.8 does NOT probe the URL, does NOT
validate the destination exists, and does NOT confirm the
message is actually invoked at runtime. The architect verifies
destination reachability separately.

### 5. `sfi.endpoint_catalog` — unified URL inventory

The URL-axis composite. Composes four categories into one
response:

| Category | Source | Direction |
|---|---|---|
| `inboundApis` | v1.5 `exposes` edges → `ExternalApi:{kind}/{path}` synthetic targets (REST / Aura / Invocable) | inbound |
| `outboundMessages` | OutboundMessage `endpointUrl` properties | outbound |
| `externalDataSources` | ExternalDataSource `endpoint` properties (v1.5 R2) | outbound |
| `namedCredentials` | NamedCredential `url` properties (v0.2) | outbound |

```json
{}
```

Takes no arguments. Each entry carries `endpointKind`
discriminator, `direction`, `sourceComponentId`, and `url`.

Use this when the architect asks the URL-centric question ("show
me every URL"); use `sfi.integration_map` (v1.5) when they ask
the topology question ("how is this org wired"); use
`sfi.outbound_message_catalog` when they want the per-message
invokers.

Surface the verbatim disclosure: URLs are captured verbatim —
v2.8 does NOT probe, does NOT validate, and does NOT confirm any
destination exists or is reachable. Runtime registrations (e.g.,
a NamedCredential resolved via custom metadata at runtime) may
carry a stored URL that differs from the actual production
destination.

## Honesty axes

### v2.8 universal — URL not validated (verbatim)

> v2.8 captures endpoint URLs verbatim from metadata XML and Apex
> source. v2.8 does NOT probe any URL, does NOT validate the
> destination exists, and does NOT confirm the integration is
> actually invoked at runtime. Runtime registrations (e.g., a
> NamedCredential resolved via custom metadata at runtime) may
> carry a stored URL that differs from the actual production
> destination. The architect verifies destination reachability
> separately.

### `sfi.cdc_subscribers` — name-pattern detection (verbatim)

> CDC subscription detection here recognizes by NAME PATTERN
> only. The recognized shapes are `{ObjectName}ChangeEvent` (for
> standard objects) and `*__ChangeEvent` (for custom objects with
> the `__c` suffix replaced). The programmatic
> `EventBus.subscribe(...)` registration path is invisible —
> runtime registration is not a declaration. CDC channel filter
> expressions in `*.platformEventChannelMember-meta.xml` are not
> extracted; subscribers in the catalog appear as "subscribed to
> all `{Object}ChangeEvent` events" rather than "subscribed to
> filtered events."

### `sfi.async_chain_depth` — depth cap + heuristic edges (verbatim)

> The walk is capped at depth 10. Chains deeper than 10 hops are
> truncated; the `truncated` flag flips true and any
> frontier-at-depth-10 nodes are NOT walked further. The
> underlying `dispatchesAsync` edges are produced by the v0.3
> Apex scanner; reflective async dispatch
> (`Type.forName(...).newInstance()`) and helper-wrapper dispatch
> are invisible to the scanner, so the walked chain may
> UNDERSTATE the real runtime chain depth.
>
> The `chainAsync` transitive edge is NOT persisted to the graph
> — v2.8 composes it at query time. The architect cannot query
> `sfi.get_edges` for `chainAsync`; this tool is the only
> surface.

### `sfi.scheduled_job_catalog` — Tooling API gap (verbatim)

> Scanning for `System.schedule(...)` invocations is heuristic;
> the actual runtime schedule lives in the `CronTrigger` /
> `AsyncApexJob` Tooling API surface and is invisible to the
> offline DX-source scanner. A class flagged `Schedulable` may
> NOT be currently scheduled — the schedule is a runtime
> registration. Conversely, a class with no
> `System.schedule(...)` call site may still be scheduled via
> the Salesforce UI or external tooling; surface as "schedulable
> but no detected scheduling call" in the response.

### `sfi.scheduled_job_catalog` — cron-parse-failure fallback (verbatim, per-entry)

> The cron expression `{rawCron}` did not parse cleanly; the raw
> string is shown verbatim. Salesforce-specific tokens (`L`, `W`,
> `#`, `LAST_FRIDAY`) are NOT supported by the v2.8 cron parser.
> Verify the schedule's meaning manually before relying on this
> entry for refactor decisions.

### `sfi.outbound_message_catalog` — URL-not-probed (verbatim)

> The endpoint URL is captured verbatim — v2.8 does NOT probe the
> URL, does NOT validate the destination exists, and does NOT
> confirm the message is actually invoked at runtime. The
> architect verifies destination reachability separately.

### `sfi.endpoint_catalog` — universal URL disclaimer (verbatim)

> URLs are captured verbatim across four categories
> (`inboundApis`, `outboundMessages`, `externalDataSources`,
> `namedCredentials`). v2.8 does NOT probe, does NOT validate,
> and does NOT confirm any destination exists or is reachable.

## Worked example

User: *"Walk the async chain from `ApexClass:AccountIndexer`.
How deep does it go?"*

Claude's flow:

1. **Classify** → async chain depth shape.
2. **Fire** `sfi.async_chain_depth` with
   `{ "rootApexClassId": "ApexClass:AccountIndexer", "maxDepth": 10 }`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "rootApexClassId": "ApexClass:AccountIndexer",
    "maxDepthObserved": 4,
    "truncated": false,
    "cyclesDetected": [
      { "cycleStartClassId": "ApexClass:AccountIndexer", "cycleEndClassId": "ApexClass:AccountIndexer", "cycleLength": 1 }
    ],
    "branchPoints": [
      { "classId": "ApexClass:AccountIndexer", "branchCount": 2 }
    ],
    "chain": [
      { "fromId": "ApexClass:AccountIndexer", "toId": "ApexClass:AccountIndexer", "depth": 1, "dispatchMechanism": "queueable", "confidence": "declared", "note": "self-enqueue (chunking pattern)" },
      { "fromId": "ApexClass:AccountIndexer", "toId": "ApexClass:AccountIndexNotifier", "depth": 1, "dispatchMechanism": "queueable", "confidence": "declared" },
      { "fromId": "ApexClass:AccountIndexNotifier", "toId": "ApexClass:EmailSender", "depth": 2, "dispatchMechanism": "future", "confidence": "heuristic" },
      { "fromId": "ApexClass:EmailSender", "toId": "ApexClass:EmailLogger", "depth": 3, "dispatchMechanism": "queueable", "confidence": "declared" },
      { "fromId": "ApexClass:EmailLogger", "toId": "ApexClass:RetryHandler", "depth": 4, "dispatchMechanism": "queueable", "confidence": "declared" }
    ],
    "disclosure": "The walk is capped at depth 10... [URL-not-validated + chain-depth verbatim disclosure]"
  }
}
```

4. **Respond:**

> Async chain from `ApexClass:AccountIndexer`:
>
> - **Max depth observed:** 4 (truncation: false).
> - **Branch points:** 1 (the root, `ApexClass:AccountIndexer`,
>   has 2 outgoing `dispatchesAsync` edges).
> - **Cycles:** 1 (a self-enqueue at the root — chunking pattern).
>
> **Chain edges (5):**
>
> | Depth | From | To | Mechanism | Confidence |
> |---|---|---|---|---|
> | 1 | `ApexClass:AccountIndexer` | `ApexClass:AccountIndexer` | queueable (self) | `declared` |
> | 1 | `ApexClass:AccountIndexer` | `ApexClass:AccountIndexNotifier` | queueable | `declared` |
> | 2 | `ApexClass:AccountIndexNotifier` | `ApexClass:EmailSender` | future | `heuristic` |
> | 3 | `ApexClass:EmailSender` | `ApexClass:EmailLogger` | queueable | `declared` |
> | 4 | `ApexClass:EmailLogger` | `ApexClass:RetryHandler` | queueable | `declared` |
>
> The chunking self-enqueue at the root is the textbook Queueable
> pattern (processes one batch, then enqueues itself for the next
> batch) — NOT a bug. The walker reports it as a cycle of length 1
> for completeness.
>
> The depth-2 edge from `AccountIndexNotifier` to `EmailSender` is
> `confidence: heuristic` (the `@future` dispatch mechanism). The
> v0.3 Apex scanner heuristically tags `@future` callers; verify
> the actual call site before treating as authoritative.
>
> **Important v2.8 boundaries (verbatim disclosure):**
>
> - The walk is capped at `maxDepth: 10`; chains deeper than 10
>   would surface `truncated: true` but yours fits within 4.
> - The `dispatchesAsync` edges are produced by the v0.3 Apex
>   scanner. Reflective async dispatch
>   (`Type.forName(...).newInstance()`) and helper-wrapper
>   dispatch are INVISIBLE. If your chain has a hop via a custom
>   `AsyncDispatcher.enqueue(...)` helper, the chain depth here
>   may UNDERSTATE reality.
> - The `chainAsync` transitive edge is NOT persisted to the
>   graph — v2.8 composes it at query time. You can't query
>   `sfi.get_edges` for `chainAsync`; this tool is the only
>   surface.
>
> Follow-up suggestions:
>
> 1. To see the one-hop dispatch sources from
>    `ApexClass:AccountIndexer` (who enqueues IT?), use
>    `sfi.get_edges` with `edgeType: 'dispatchesAsync'`,
>    `direction: 'in'`.
> 2. To audit all scheduled jobs in this org (a sibling concern),
>    run `sfi.scheduled_job_catalog`.
> 3. To check if `EmailLogger` or `RetryHandler` end up calling
>    out to an external system, follow up with
>    `sfi.endpoint_catalog` and cross-reference the
>    `outboundMessages` / `namedCredentials` arrays.

The response leads with the depth + branch + cycle summary, surfaces
the chain edges as a table with per-edge `dispatchMechanism` +
`confidence`, calls out the self-enqueue chunking pattern explicitly
(distinguishing it from a "real" cycle), and appends the verbatim
v2.8 disclosure with the depth-cap + reflective-dispatch + chainAsync
non-persistence notes.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Treating an `sfi.async_chain_depth` self-enqueue cycle as "the architecture is broken". | Self-enqueueing Queueables are the textbook chunking pattern: process one batch, enqueue self for next batch. Surface the cycle's length explicitly (length 1) and explain its purpose; don't editorialize. |
| Calling `sfi.cdc_subscribers` against a non-CDC event id. | The tool validates the name pattern (`{Object}ChangeEvent` / `*__ChangeEvent`); a Platform Event (`*__e`) would belong to v1.5's `sfi.event_subscribers`. Re-route to the right tool, don't retry. |
| Treating an empty `cdc_subscribers` response as "no CDC topology in this org". | The v2.8 `EventBus.subscribe(...)` registration path is invisible. An org with programmatic CDC subscribers will return empty here. Surface the disclosure and suggest the architect check Setup → Change Data Capture. |
| Treating an `sfi.scheduled_job_catalog` `Schedulable` class with no `scheduledByCalls[]` as "not scheduled". | The Tooling API gap means the actual `CronTrigger` / `AsyncApexJob` registration is invisible. A class with no detected call site may still be scheduled via the UI. Surface the verbatim Tooling API gap disclosure. |
| Treating a `parsedCron: null` entry as "the schedule is broken". | `parsedCron: null` means the cron uses a Salesforce-specific token (`L`, `W`, `#`, `LAST_FRIDAY`) the v2.8 parser doesn't support — NOT that the schedule is invalid. Surface the verbatim per-entry fallback. |
| Calling `sfi.endpoint_catalog` when the user asked "draw me the integration topology". | The endpoint catalog is the URL-axis composite; the integration map is the topology composite. Defer to `architect-integration-topology` for the topology question. |
| Surfacing an `outbound_message_catalog` endpoint URL as "this URL is reachable". | v2.8 does NOT probe. The URL is captured verbatim; verify reachability separately. State the v2.8 disclaimer. |
| Confusing CDC events with Platform Events. | They're separate axes. Platform Events: `__e` suffix, `sfi.event_subscribers` (v1.5). CDC events: `{Object}ChangeEvent` / `*__ChangeEvent` pattern, `sfi.cdc_subscribers` (v2.8). Different name shapes, different tools. |
| Treating the `chainAsync` non-persistence as a bug. | It's a deliberate scope decision (per `AsyncTopologySemantics.md`). The transitive edge would explode the graph size for queries that don't need it; `sfi.async_chain_depth` composes it at query time. State this when explaining why the chain doesn't appear in `sfi.get_edges` results. |
| Treating `confidence: heuristic` on an async edge (typically `@future` dispatch) as authoritative. | The v0.3 Apex scanner heuristically tags `@future` callers because the dispatch mechanism is a method-level annotation rather than a `System.X(...)` call. Cite confidence and recommend verification. |
| Skipping the URL-not-validated boundary on an endpoint-catalog response. | The disclosure is the architect's protection against treating a catalog URL as a confirmed integration. ALWAYS surface, even when the catalog is short. |

## See also

- `architect-integration-topology` — for v1.5's declared
  integration tier. Use that skill for `integration_map`,
  `event_subscribers` (Platform Events, `__e` suffix), and
  one-hop async dispatch via the v1.5 property booleans.
  v2.8 EXTENDS but does not replace; the two skills are
  complementary.
- `architect-impact-analysis` — for "what breaks if I delete this
  ExternalDataSource / NamedCredential / outbound message".
  v0.2's `sfi.get_impact` walks every incoming edge; v2.8 surfaces
  the cataloged URL but doesn't predict the impact.
- `developer-impact-and-reachability` — for `sfi.call_graph`
  (transitive `callsApex` walk) and `sfi.what_if_disable_trigger`
  (what-if disabling a trigger that subscribes to a Platform Event
  or CDC channel). `sfi.async_chain_depth` walks the
  `dispatchesAsync` axis specifically; `sfi.call_graph` walks the
  `callsApex` axis.
- `admin-documentation-generators` — for the v2.5 architecture-
  overview generator that COMPOSES `sfi.integration_map` + the
  v2.8 endpoint catalog into one document. The doc surfaces both
  axes; this skill is the deep drill-in.

## Verification

Before sending a response, confirm:

- [ ] I classified the question into one of the five shapes (CDC
      subscribers / async chain depth / scheduled jobs / outbound
      messages / unified endpoint catalog) and fired the right
      tool.
- [ ] For CDC questions, I verified the user's event reference is
      a CDC name pattern (`{Object}ChangeEvent` /
      `*__ChangeEvent`), NOT a Platform Event (`*__e`). I
      re-routed to `architect-integration-topology` if it's a
      Platform Event.
- [ ] I surfaced the verbatim per-tool disclosure (URL-not-
      validated, name-pattern detection for CDC, depth-cap of 10,
      Tooling API gap for cron registration, cron-parse-failure
      fallback when `parsedCron` is null).
- [ ] For `async_chain_depth` results, I surfaced
      `maxDepthObserved`, `truncated`, `cyclesDetected[]`, and
      `branchPoints[]` with per-edge `dispatchMechanism` +
      `confidence`.
- [ ] For self-enqueue cycles in `async_chain_depth`, I called
      out the chunking pattern explicitly rather than treating
      it as a defect.
- [ ] For `scheduled_job_catalog` entries with
      `parsedCron: null`, I surfaced the verbatim per-entry
      fallback disclosure.
- [ ] For `outbound_message_catalog` entries, I cited each
      `invokedByWorkflowRules[]` reference with its canonical id.
- [ ] For `endpoint_catalog` results, I split the response by
      `direction` (inbound vs outbound) and `endpointKind`.
- [ ] I cited every canonical id in backticks
      (`ChangeEvent:AccountChangeEvent`,
      `ScheduledJob:NightlyAccountsRefresh`,
      `OutboundMessage:Lead.Notify_Marketing`,
      `ApexClass:`, `Flow:`, etc.).
- [ ] I did NOT confuse Platform Events with CDC events, did NOT
      treat empty results as "no topology" without surfacing the
      invisibility disclosure, and did NOT treat the `chainAsync`
      non-persistence as a bug.
- [ ] When the question was about v1.5's broader integration
      surface (auth providers, named credentials, OData sources
      generally), I deferred to `architect-integration-topology`
      cleanly.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
