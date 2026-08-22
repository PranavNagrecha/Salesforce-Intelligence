---
name: architect-async-and-events
description: |
  Answers Salesforce architect async + event-driven topology questions
  that v2.8 surfaces beyond the v1.5 integration tier. Triggers:
  "who subscribes to CDC events on Account", "what change-data-capture
  subscribers do we have", "what's the async chain depth from this
  Queueable", "show me every scheduled job", "what outbound messages
  does this org send", "give me every endpoint URL in one place".
  Drives the cascade: `event_topology` (the event plane — Platform
  Events, Change Data Capture enablement, event channels, and the
  retrieval coverage behind each; it supersedes the retired
  `cdc_subscribers` alias), `async_chain_depth`
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

The CDC boundary, stated accurately (two older claims here were
overtaken by shipped work — do not repeat them):

- **CDC SUBSCRIBER detection is name-pattern only.** The tool
  recognizes `{Object}ChangeEvent` / `*__ChangeEvent` shapes on
  triggers, classes and Flows. That half of the disclosure still
  holds.
- **Per-channel filter expressions ARE extracted.** A dedicated
  `platformEventChannelMember` extractor reads
  `*.platformEventChannelMember-meta.xml` and emits the member node
  plus a `references` edge carrying the declared `filterExpression`
  verbatim. `cdc_subscribers` surfaces them as `channelMembers[]`
  (`memberId`, `channelId`, `channelType`, `selectedEntity`,
  `filterExpression`). The real boundary is narrower: the
  `filterExpression` is the DECLARED XML text, NOT runtime filter
  EVALUATION — which records actually flow through the channel needs
  record-level data the vault does not hold. Confidence is `declared`.
- **Apex `EventBus.subscribe(...)` remains invisible FOR CDC.** The
  Apex scanner does now resolve static `EventBus.subscribe` channel
  args into a `listensTo` edge — but it is gated on the `__e` suffix,
  so Platform Events are covered and CDC `*ChangeEvent` channels are
  deliberately SKIPPED. For CDC the "programmatic registration is
  invisible" disclosure still holds verbatim; for Platform Events
  (`sfi.event_subscribers`) it no longer does.

**There is no `isCdcEnabled` property.** Nothing in `packages/*/src`
writes it — no extractor, no enricher, no graph-build step. The
producer-side question ("is this object enabled for CDC?") is answered
by `sfi.event_topology`: `cdcEntities[]` lists the entities a
`PlatformEventChannelMember` SELECTS (that selection IS the enablement
declaration), each carrying the channel it is bound onto and the
declared `filterExpression`. An empty `cdcEntities` quotes the manifest
coverage row, so it reads as a CHECKED zero or as NOT CHECKED — never
as a bare "no CDC". Do not call
`sfi.get_component` on a CustomObject and read `properties.isCdcEnabled`
— it will be `undefined` for every object in every vault, and an
`undefined` read as "not CDC-enabled" is a fabricated negative.

The v2.8 `chainAsync` non-persistence: the transitive chain edge
is composed AT QUERY TIME by `sfi.async_chain_depth`. The
architect cannot query `sfi.get_edges` for `chainAsync` — only
this tool surfaces the transitive shape. State this when
explaining why a chain-walk question can't be answered via
`get_edges` directly.

**The cron expression is NOT available on the vault plane at all.**
There is no `parsedCron`, no `rawCronExpression`, and no cron parser
(`cron-parser` is not a dependency of this repo). `scheduled_job_catalog`
declares two cron-shaped fields — `cronExpressions[]` on an entry and
`cronExpression` on each `scheduledByCalls[]` row — and BOTH are read
defensively against a producer that does not exist: the Apex scanner's
`System.schedule(name, cron, new X())` regex captures only the CLASS
NAME and discards the cron argument, and the `dispatchesAsync` edge it
emits carries `{ dispatchMechanism, offset, length }` and nothing else.
So `cronExpressions` is `[]` and `cronExpression` is `null` on every
entry in every vault today. Read an empty cron as "cron UNAVAILABLE on
this plane", never as "this job has no schedule".

## When to fire

Fire this skill on async / event / scheduled-job / outbound-message
/ endpoint-catalog phrasing. Concrete triggers:

### CDC subscription shape

- **"Who subscribes to CDC events on `Account`?"** /
  **"What's the CDC topology for `Account`?"** —
  Use `sfi.event_topology` with
  `{ "objectApiName": "Account" }`.
- **"What change-data-capture subscribers do we have?"** /
  **"Audit our CDC subscribers."** — Use `sfi.event_topology`
  with `{ "filter": "cdc" }`.
- **"Who listens to `AccountChangeEvent`?"** — Same; the
  event-name pattern is recognized.

`sfi.cdc_subscribers` is a retired back-compat alias. It is not
advertised under the default `core` profile and is not directly
invokable there — reach it, if you must, through
`sfi.run_analysis { name: 'sfi.cdc_subscribers' }`. Prefer
`sfi.event_topology`.

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
  **"Decode this scheduled job."** — This is an HONEST GAP on the
  vault plane: the cron string is not extracted (see above).
  `sfi.scheduled_job_catalog` can tell you the class is Schedulable and
  which classes call `System.schedule` on it; it cannot tell you the
  expression. Say so, and offer `sfi.live_scheduled_jobs` (opt-in live
  plane) — it reads the actual `CronTrigger.CronExpression`,
  `State`, and `NextFireTime` from the org.

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

### 1. `sfi.event_topology` — the event plane (Platform Events + CDC)

**Start here for anything event-shaped.** One call returns the org's
Platform Events with their declared `eventType` / `publishBehavior`
and their publishers, subscribers and channel bindings; the entities
whose Change Data Capture stream a `PlatformEventChannelMember`
SELECTS (that selection IS the enablement declaration); the channels
carrying both; the events the org NAMES but the vault never retrieved;
and a `coverage` block naming the counts all of the above were computed
under.

```json
{}                                   // the whole event plane
{ "filter": "cdc" }                  // only the CDC half
{ "objectApiName": "Contact" }       // is CDC enabled for Contact?
```

Two boundaries to surface verbatim, because they are the ones a reader
gets wrong: an empty `cdcEntities` list quotes the manifest coverage
row, so it reads as a CHECKED zero or as NOT CHECKED — never as a bare
"no CDC"; and a permission grant naming a `*ChangeEvent` entity is NOT
CDC enablement (those entities exist on every org), so it appears only
under `referencedNotRetrieved`.

`sfi.cdc_subscribers` below is a RETIRED back-compat alias: still
dispatchable by name, no longer advertised. Prefer `event_topology`.

### 1b. `sfi.cdc_subscribers` (retired alias) — CDC subscribers only

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

Do not fire this by choice — `sfi.event_topology` returns the same
CDC facts alongside the platform-event half. It survives only for
callers that already name it. The disclosure it carries applies to
both: CDC subscription detection recognizes by NAME PATTERN only, and
programmatic `EventBus.subscribe(...)` registration is INVISIBLE.

There is **no** `properties.isCdcEnabled` flag on CustomObject — the
signal has zero producers in the codebase, so reading it returns
`undefined` for every object. The producer-side question ("is this
object bound onto a change-event channel?") belongs to
`sfi.event_topology`'s `cdcEntities[]`. This alias returns the same
binding as `channelMembers[]`, where a member whose `selectedEntity` is
the object IS the declared CDC binding, with its `channelId` /
`channelType` / `filterExpression`. An empty `channelMembers[]` means no
`*.platformEventChannelMember-meta.xml` bound the object in the
retrieved metadata — not proof CDC is off.

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

An entry's `cronExpressions[]` is empty and every
`scheduledByCalls[].cronExpression` is `null` — always, in every vault.
The scanner never captures the cron argument. Surface that as an
availability gap, not a finding:

> This catalog names the Schedulable classes and the `System.schedule`
> call sites that reference them. The cron EXPRESSION itself is not
> extracted — the scanner captures the scheduled class, not the
> schedule string. For the actual expression, next fire time, and
> whether the job is currently registered at all, use
> `sfi.live_scheduled_jobs` (opt-in live plane, reads `CronTrigger`).

Also surface `likelyUnscheduled` when it is true, with its own meaning:
a `System.schedule()` call site that lives ONLY inside an `@isTest`
class does not schedule anything at runtime.

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
> `EventBus.subscribe(...)` registration path is invisible for CDC —
> the scanner's subscribe heuristic is gated on the `__e` Platform
> Event suffix and skips `*ChangeEvent` channels. Per-member filter
> expressions in `*.platformEventChannelMember-meta.xml` ARE
> extracted and surface in `channelMembers[].filterExpression` — but
> as DECLARED XML text, never as runtime evaluation of which records
> actually flow.
>
> `channelMembers` is also the CDC ENABLEMENT signal: a member that
> selects a Change Event means CDC is on for that object even when no
> code subscribes. An empty `subscribers[]` with a non-empty
> `channelMembers[]` is "enabled, no modeled subscriber", NOT "CDC
> unused."

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

### `sfi.scheduled_job_catalog` — cron is UNAVAILABLE on this plane

There is no cron-parse-failure disclosure, because there is no cron
parser and no cron producer. `cronExpressions[]` is `[]` and each
`scheduledByCalls[]` row's `cronExpression` is `null` on every entry
in every vault — the Apex scanner's `System.schedule(name, cron, new
X())` regex captures the CLASS NAME and discards the cron argument.
Say "cron UNAVAILABLE on this plane"; never "this job has no
schedule", and never quote a cron string this tool did not return.
The live `CronTrigger` registration is a Tooling-API fact, outside the
offline vault.

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
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.async_chain_depth", "args": { … } }` with
   `{ "rootApexClassId": "ApexClass:AccountIndexer" }` (the input key
   is `rootApexClassId`; `componentId` / `rootId` are accepted
   aliases). Note the INPUT key and the OUTPUT key differ — the
   response echoes `rootClassId` / `rootFlowId`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "rootClassId": "ApexClass:AccountIndexer",
    "rootFlowId": null,
    "maxDepth": 4,
    "truncated": false,
    "cyclesDetected": true,
    "branchPoints": [
      { "classId": "ApexClass:AccountIndexer", "branchCount": 2 }
    ],
    "chains": [
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
> - **Max depth:** 4 (`maxDepth`; truncation: false).
> - **Branch points:** 1 (the root, `ApexClass:AccountIndexer`,
>   has 2 outgoing `dispatchesAsync` edges).
> - **Cycles:** `cyclesDetected: true` — a self-enqueue at the root
>   (chunking pattern). Note the field is a BOOLEAN, not a list: the
>   walker reports THAT a cycle exists, not which nodes formed it.
>   Find the cycle yourself by looking for a `chains[]` edge whose
>   `fromId === toId`, or a repeated pair.
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
>    run `sfi.run_analysis` with `{ "name": "sfi.scheduled_job_catalog", "args": { … } }`.
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
| Reporting an empty `cronExpressions[]` as "this job has no schedule". | The cron string is never extracted — the scanner captures the scheduled CLASS and discards the cron argument. Every entry in every vault has `cronExpressions: []` and `cronExpression: null`. That is an availability gap, not a finding. Route the actual expression to `sfi.live_scheduled_jobs`. |
| Reading `properties.isCdcEnabled`, `parsedCron`, `rawCronExpression`, or `maxDepthObserved`. | None of these exist — zero producers in `packages/*/src`. A read returns `undefined`, and `undefined` narrated as "not enabled" / "no schedule" / "depth 0" is a fabricated negative finding. The real keys are `channelMembers[].selectedEntity` (CDC binding), `cronExpressions[]` / `cronExpression` (both always empty), and `maxDepth`. |
| Calling `sfi.endpoint_catalog` when the user asked "draw me the integration topology". | The endpoint catalog is the URL-axis composite; the integration map is the topology composite. Defer to `architect-integration-topology` for the topology question. |
| Surfacing an `outbound_message_catalog` endpoint URL as "this URL is reachable". | v2.8 does NOT probe. The URL is captured verbatim; verify reachability separately. State the v2.8 disclaimer. |
| Confusing CDC events with Platform Events. | They're separate axes — `__e` suffix versus the `{Object}ChangeEvent` / `*__ChangeEvent` pattern — and `sfi.event_topology` is the front door for both, reporting each half separately. `sfi.event_subscribers` is the single-event detail view for a Platform Event; it covers neither CDC nor referenced-but-not-retrieved events. |
| Treating the `chainAsync` non-persistence as a bug. | It's a deliberate scope decision. The transitive edge would explode the graph size for queries that don't need it; `sfi.async_chain_depth` composes it at query time. State this when explaining why the chain doesn't appear in `sfi.get_edges` results. |
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
      Tooling API gap for cron registration).
- [ ] I did NOT read `parsedCron`, `rawCronExpression`,
      `isCdcEnabled`, or `maxDepthObserved` — none of those exist,
      and an absent signal read as a negative finding is the exact
      failure this skill is supposed to prevent.
- [ ] For `async_chain_depth` results, I surfaced `maxDepth`,
      `truncated`, `cyclesDetected` (a BOOLEAN), and
      `branchPoints[]`, and walked `chains[]` with per-edge
      `edgeType` / `async` / `depth`. I did not report a
      `maxDepthObserved` or a `cyclesDetected[]` list — neither
      exists.
- [ ] For self-enqueue cycles in `async_chain_depth`, I called
      out the chunking pattern explicitly rather than treating
      it as a defect.
- [ ] For `scheduled_job_catalog` entries I stated that the cron
      EXPRESSION is unavailable on the vault plane (it is never
      extracted), rather than reporting an empty
      `cronExpressions[]` as "this job has no schedule" — and I
      pointed at `sfi.live_scheduled_jobs` for the real registration.
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

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
