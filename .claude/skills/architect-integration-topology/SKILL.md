---
name: architect-integration-topology
description: |
  Answers Salesforce architect integration questions: "draw me our
  integration map", "what subscribes to this platform event", "who
  calls this REST API", "which classes are queueable / batchable",
  "what runs async in this org", "where does this external data
  source connect", "what is our external API surface", "which
  external services use this named credential", "audit our auth
  providers". Call `sfi.run_analysis` with `{ "name": "sfi.integration_map", "args": { … } }` (organized map of auth +
  endpoints + APIs + access lists) and `sfi.event_subscribers`
  (given a platform event, return all Apex/Flow subscribers). Plus
  `sfi.list_components` with the property filters
  (isQueueable, isSchedulable, isBatchable, hasFutureMethod,
  hasInvocableMethod, isRestResource, hasAuraEnabledMethod) for
  async/job and API surface questions. Discloses the honesty axis:
  some patterns are heuristic (dispatchesAsync via reflection, LWC
  fetch URL correlation, CDC subscription detection) and require
  manual verification.
---

# Architect integration topology

## Overview

This skill is the architect persona's companion to the two
headline tools, `sfi.integration_map` and `sfi.event_subscribers`,
plus the property filters on `sfi.list_components`. The
architect's first-line question is almost always one of four
shapes — "draw me our integration map", "who subscribes to this
event", "what runs async", or "what does this org expose as an
API" — and the honest answer is to route to the right tool, render
the structured response in a way an architect can read top-down,
and disclose what the metadata-XML + Apex-header model
deliberately does not see.

The integration tier has three edge producers and two
EdgeTypes of its own. The edges are **`exposes`** (an `ApexClass`
declares it serves an external API surface via `@RestResource`,
`@AuraEnabled`, or `@InvocableMethod` — the `toId` is a
**synthetic id** `ExternalApi:{kind}/{path}` rather than a real
graph node) and **`dispatchesAsync`** (an `ApexClass` enqueues,
schedules, or batches another `ApexClass`). The unlocked edge is
**`listensTo`** — reserved-and-empty and now produced
from `apex-trigger` (the `on {Event}__e` clause), `apex-class`
(the `implements Triggerable<{Event}__e>` clause), and `flow`
(the `<triggerType>PlatformEvent</triggerType>` start). sf-intelligence also
extends `ApexClass.properties` with seven new boolean flags
(`isQueueable`, `isSchedulable`, `isBatchable`, `hasFutureMethod`,
`hasInvocableMethod`, `isRestResource`, `hasAuraEnabledMethod`)
that drive the async / API-surface classifier questions.

The integration tier is **declared-first** — almost every
edge and property is read straight from metadata XML or an Apex
annotation. The single `heuristic` exception is the
`dispatchesAsync` edge when the dispatched job class is resolved
from a named local variable (the constructor is visible to the
scanner but the dispatch site is one hop away). The boundary
that matters for architects: **sf-intelligence captures the declared /
configured integration surface, not the runtime topology.**
Outbound HTTP calls from LWC source, programmatic
`EventBus.subscribe` registrations, CDC subscriptions on
`AccountChangeEvent`-shaped events, reflective async dispatch
via `Type.forName(...).newInstance()`, virtual sObjects
projected from Salesforce Connect, and Connected App → Profile
linkage all return as either omitted or as `unknown` boundary
notes; the architect verifies in Salesforce Setup before acting.

This is the first architect-persona skill in the bundle — the
direct sibling of `architect-impact-analysis` ("what breaks
if I change X") and the architect-tier inverse of
`admin-sharing-troubleshooting` ("why can't user X see Y").
The architect surface differs from the impact analysis in
that answers organized "what's wired to what" questions, not
"what depends on this single node" questions. The tool routing
below makes that distinction concrete.

## When to fire

Fire on architect-integration phrasing. Concrete triggers, by
question category:

### Topology map shape

- **"Draw me our integration map"** — "draw me our integration
  map", "show me how this org integrates", "what's our outbound
  surface", "where are our external connections".
- **"Where does this external data source connect?"** — "what
  endpoint does `ExternalDataSource:Orders_OData` hit", "show me
  every OData binding", "list all Salesforce Connect data
  sources".
- **"Which external services use this named credential?"** —
  "what calls `NamedCredential:OrdersApi`", "where is
  `NamedCredential:WeatherService` referenced", inversion
  questions on a Named Credential.
- **"Audit our auth providers"** — "list all auth providers",
  "what OAuth providers does this org use", "show me the SSO
  registrations".

### Event subscriber shape

- **"What subscribes to this platform event?"** — "what
  subscribes to `Account_Change__e`", "who listens to this
  Platform Event", "find every subscriber for
  `CustomObject:Order_Placed__e`".
- **"Event subscriber for Account_Change__e"** — terse phrasing
  of the same shape.
- **"Which flows fire on a platform event?"** — narrowed
  inversion; surface only the `Flow` subscribers from the
  result.

### Async / job classifier shape

- **"Which classes are queueable?"** — "list all queueable
  classes", "show me the `implements Queueable` classes".
- **"What runs async?"** — "what runs async in this org", "show
  me every async-dispatching class", "what are my async
  surfaces".
- **"List all batchable classes"** — "list all
  `Database.Batchable<sObject>` implementations".
- **"What are my scheduled jobs?"** — "list every Schedulable",
  "show me the cron-driven Apex".
- **"Find future methods"** — "find every `@future` method",
  "where do we use `@future(callout=true)`".
- **"Who enqueues `ApexClass:MyJob`?"** — inversion via incoming
  `dispatchesAsync` edges on a Queueable / Schedulable / Batchable
  class.

### API surface shape

- **"What is our external API surface?"** — "what does this org
  expose as an API", "show me every external endpoint".
- **"Who calls this REST API?"** — "list all `@RestResource`
  classes", "where are our REST endpoints", "what REST endpoints
  does the org expose".
- **"Where do we expose @AuraEnabled methods?"** — "find every
  AuraEnabled method", "list LWC-callable Apex".
- **"What invocable methods do we have?"** — "list every
  `@InvocableMethod`", "what can Flow / Process Builder call".

## When NOT to fire

Defer to another skill when:

- **"What breaks if I change `ApexClass:OrderService`?"** — that's
  cross-component impact analysis, not integration topology.
  Defer to `architect-impact-analysis` → `sfi.get_impact` (via `sfi.run_analysis`).
- **"Where is `OrderService` used in Apex / LWC code?"** — that's
  a code-side reference question. Defer to
  `developer-apex-refactor` → `sfi.find_code_usages` (via `sfi.run_analysis`) or
  `sfi.find_code_usages`.
- **"Why can't user X see this Connected App?"** — that's a
  visibility question. Defer to `admin-sharing-troubleshooting` →
  `sfi.why_cant_user_see_record`.
- **"Which page layout does the System Administrator profile see
  for Account?"** — that's layout routing. Defer to
  `admin-page-layout-routing` → `sfi.layout_for_user` (via `sfi.run_analysis`).
- **"What workflow rule routes Cases?"** / **"Which approval
  process is active on Opportunity?"** — that's legacy automation,
  not integration topology. Defer to `admin-legacy-automation` →
  `sfi.get_impact` / `sfi.get_edges` over WorkflowRule /
  ApprovalProcess / AssignmentRule.
- **The user wants live data** ("how many callouts did
  `NamedCredential:OrdersApi` make today?"). sf-intelligence is offline.
  Tell them to query their org directly.
- **The user wants to modify metadata** ("disable this auth
  provider for me"). sf-intelligence is read-only.
- **The user names a Network (Experience Cloud Site) — NOT
  NetworkAccess.** sf-intelligence covers the IP-range trust list
  (`NetworkAccess`), not the Experience Cloud Site (`Network` /
  `ExperienceBundle`) metadata family. Say so; offer
  `NetworkAccess` if that's what they meant.

## Steps

Walk these in order. Each step has a definite output that feeds
the next.

### Step 1 — Classify the question into one of 4 categories

The four categories map to four tool-routing decisions; getting
the classification wrong burns the user's first turn. Read the
question and bucket it:

1. **Topology map** — phrasing that asks for an organized
   *picture* of integration surfaces. Routes to
   `sfi.integration_map`.
2. **Event subscribers** — phrasing that names a Platform Event
   (a `__e`-suffixed CustomObject) and asks who listens. Routes
   to `sfi.event_subscribers`.
3. **Async / job classifier** — phrasing that asks for a *list of
   classes by capability* (Queueable / Schedulable / Batchable /
   `@future` / `@InvocableMethod`). Routes to
   `sfi.list_components` with `type: 'ApexClass'` plus client-side
   filtering on the property booleans.
4. **API surface** — phrasing that asks where the org *exposes*
   an external API. Routes to `sfi.list_components` with
   `type: 'ApexClass'` plus client-side filtering on
   `isRestResource` / `hasAuraEnabledMethod` /
   `hasInvocableMethod`, then walks outgoing `exposes` edges to
   render the synthetic `ExternalApi:` ids.

When the question straddles categories (e.g., "draw me our
integration map AND list every Queueable") split the work into
two separate tool calls and present the results in two sections.
Don't try to coerce a multi-shape question into one tool call.

### Step 2 — Call the appropriate tool

#### Category (a): `sfi.integration_map`

Default invocation (full sweep):

```json
{ "filter": "all" }
```

Filtered invocations by architect mental cut:

```json
{ "filter": "auth" }       // AuthProvider + ConnectedApp
{ "filter": "sites" }      // RemoteSiteSetting + CspTrustedSite + NetworkAccess
{ "filter": "sources" }    // ExternalDataSource + ExternalService
{ "filter": "services" }   // synonym for "sources"
{ "filter": "access" }     // NamedCredential + AuthProvider + NetworkAccess
```

The response shape:

```json
{
  "data": {
    "authProviders":       [ /* AuthProvider node summaries */ ],
    "namedCredentials":    [ /* NamedCredential node summaries */ ],
    "remoteSiteSettings":  [ /* RemoteSiteSetting node summaries */ ],
    "cspTrustedSites":     [ /* CspTrustedSite node summaries */ ],
    "externalDataSources": [ /* ExternalDataSource node summaries */ ],
    "externalServices":    [ /* ExternalService node summaries */ ],
    "connectedApps":       [ /* ConnectedApp node summaries */ ],
    "networkAccesses":     [ /* NetworkAccess node summaries */ ],
    "references":          [ /* cross-type references edges */ ]
  }
}
```

Categories the caller scoped out via `filter` arrive as empty
arrays — the shape is stable, not conditional. The `references`
array is the connected sub-graph: an `ExternalDataSource → AuthProvider`
edge lands; an `ExternalDataSource → CustomField` edge does not
(only edges between two integration-type nodes are surfaced, to
keep the map a coherent picture rather than an unbounded
fan-out). Use `limit` only when the architect explicitly asks
for a slice; the default of 100 (12 per category) is the right
ceiling for almost every real org.

#### Category (b): `sfi.event_subscribers`

Default invocation:

```json
{ "eventId": "CustomObject:Account_Change__e" }
```

The response shape:

```json
{
  "data": {
    "eventId": "CustomObject:Account_Change__e",
    "subscribers": [
      { "subscriberId": "ApexTrigger:AccountChangeSubscriber", "subscriberType": "ApexTrigger", "subscriberSource": "apex-trigger-extractor", "confidence": "declared", "properties": { /* edge-level metadata */ } },
      { "subscriberId": "ApexClass:AccountChangeHandler",      "subscriberType": "ApexClass",   "subscriberSource": "apex-class-extractor",   "confidence": "declared", "properties": { /* edge-level metadata */ } },
      { "subscriberId": "Flow:AccountChangeNotifier",          "subscriberType": "Flow",        "subscriberSource": "flow-extractor",         "confidence": "declared", "properties": { /* edge-level metadata */ } }
    ]
  }
}
```

The tool **errors** with `invalid-query` if the `eventId` is
not a `CustomObject:` whose ApiName ends in `__e`. The error
message names the boundary explicitly — for non-event subscribers
(e.g., a trigger on a standard sObject) the architect uses
`sfi.get_edges` with `edgeType: 'triggersOn'`, not this tool.
Do **not** retry on an invalid id; recover by re-classifying
the question.

#### Category (c): async / job classifier

sf-intelligence does **not** yet ship server-side property filters on
`sfi.list_components`. Walk the full ApexClass list and filter
client-side. Default invocation:

```json
{ "type": "ApexClass", "limit": 500 }
```

Then filter the returned nodes by the relevant property boolean:

| Architect question | Property to check (client-side) |
|---|---|
| "which classes are Queueable" | `properties.isQueueable === true` |
| "list all Schedulable classes" | `properties.isSchedulable === true` |
| "list all batchable classes" | `properties.isBatchable === true` |
| "find every `@future` method" | `properties.hasFutureMethod === true` |
| "list every `@InvocableMethod`" | `properties.hasInvocableMethod === true` |
| "what runs async (broad)" | any of the four above |

Note this limit explicitly in the response: "sf-intelligence doesn't
yet support server-side property filters on `sfi.list_components`;
this is a client-side filter over the full ApexClass list. A
follow-up server-side filter is a possible later extension."

For the "who enqueues this Queueable" follow-up question, call
`sfi.get_edges` with the Queueable class id, `direction: 'in'`,
`edgeType: 'dispatchesAsync'` — every caller that constructs
and enqueues the target class appears as an incoming edge.

#### Category (d): API surface

Same client-side filter shape as Category (c). Default
invocation:

```json
{ "type": "ApexClass", "limit": 500 }
```

Filter by:

| Architect question | Property to check (client-side) |
|---|---|
| "what REST endpoints does this org expose" | `properties.isRestResource === true` |
| "where do we expose `@AuraEnabled` methods" | `properties.hasAuraEnabledMethod === true` |
| "what invocable methods do we have" | `properties.hasInvocableMethod === true` |

For each matching class, call `sfi.run_analysis` with `{ "name": "sfi.get_edges", "args": { … } }` with the class id,
`direction: 'out'`, `edgeType: 'exposes'` — the `toId` of each
edge is a **synthetic id** `ExternalApi:{kind}/{path}` (see
*Synthetic ids* below) that surfaces the actual external API path
in the response. Do **not** attempt to resolve the synthetic id to
a real node; the renderer recognizes the `ExternalApi:` prefix
and prints the path as-is.

### Step 3 — Present the result as a structured architect-friendly view

Each category has its natural presentation shape. Pick the one
that matches the tool you called:

#### For `sfi.integration_map`: categorized list with cross-references

Render the response as a top-down map, one section per category,
each section listing the nodes by canonical id with their
identifying property (endpoint URL, principal type, IP range,
etc.). After the category sections, render a "Cross-type
references" section that walks `references[]` and pairs each
edge's `(fromId, toId, role)`. Skip empty categories silently
when the architect filtered them out; surface empty categories
explicitly when the filter was `'all'` ("no `RemoteSiteSetting`
nodes — this org uses Named Credentials exclusively"). The
emptiness IS information.

#### For `sfi.event_subscribers`: flat list grouped by subscriber type

Render the response as a flat list, grouped by `subscriberType`
(ApexTrigger first, then ApexClass, then Flow). Within each
group, cite the canonical id, the `subscriberSource` (which
extractor emitted the edge), and the edge's `confidence` (always
`declared` for `listensTo` edges). The architect's natural
follow-up is "what does each subscriber do?" — point them at
`sfi.get_component` for the per-subscriber detail.

#### For Category (c) — async / job classifier: capability-buckets

Render the filtered ApexClass list as a flat list, sorted by
canonical id. State the capability the bucket represents (e.g.,
"Queueable classes (`implements Queueable`)") and the count.
When the architect asked for a single capability, present only
that bucket; when the question was broad ("what runs async"),
render four buckets (Queueable, Schedulable, Batchable,
hasFutureMethod). Surface the client-side-filter limit
verbatim in the response: "sf-intelligence does not yet support server-side
property filters; this list is filtered client-side."

#### For Category (d) — API surface: API-surface table with synthetic ids

Render the filtered ApexClass list with one row per outgoing
`exposes` edge. Each row: `(class id, synthetic API id, edge
confidence)`. The synthetic id IS the architect-readable rendering
of the external API path (`ExternalApi:rest/Accounts`,
`ExternalApi:aura/AccountService.getAccounts`,
`ExternalApi:invocable/AccountActions.bulkSnooze`); surface it
verbatim. Do **not** try to convert it to a fake `ApexClass:`
form or drop the prefix.

### Step 4 — Cite canonical IDs and edge confidence

Every component named in the response gets its canonical ID in
backticks. Every cross-type reference cites the edge's
`confidence` — always `declared` for the integration tier
except for the single heuristic case of `dispatchesAsync` with
a named-local-variable dispatch site.

Canonical id formats for the integration tier:

- **`AuthProvider:{Name}`** — e.g.,
  `AuthProvider:Salesforce_OAuth`.
- **`NamedCredential:{Name}`** — e.g.,
  `NamedCredential:OrdersApi`.
- **`RemoteSiteSetting:{Name}`** — e.g.,
  `RemoteSiteSetting:Salesforce_Reports`.
- **`CspTrustedSite:{Name}`** — e.g.,
  `CspTrustedSite:CdnAssets`.
- **`ExternalDataSource:{Name}`** — e.g.,
  `ExternalDataSource:Orders_OData`.
- **`ExternalService:{Name}`** — e.g.,
  `ExternalService:WeatherService`.
- **`ConnectedApp:{Name}`** — e.g.,
  `ConnectedApp:MarketingSync`.
- **`NetworkAccess:{Name}`** — e.g., `NetworkAccess:OfficeRange`.
- **`CustomObject:{Name}__e`** — Platform Event, e.g.,
  `CustomObject:Account_Change__e` (a ComponentType
  variant — `__e` suffix on the ApiName is the Platform Event
  discriminator).
- **`ApexClass:{ClassName}`**, **`ApexTrigger:{TriggerName}`**,
  **`Flow:{ApiName}`** — for the subscriber and dispatcher
  side.

#### Synthetic ids — render verbatim

The `exposes` edge is the only integration-tier edge whose `toId` is **not**
a real graph node. The synthetic id format is
`ExternalApi:{kind}/{path}` where `{kind}` is one of `rest`,
`aura`, or `invocable`:

| Source annotation | Synthetic id |
|---|---|
| `@RestResource(urlMapping='/Accounts')` | `ExternalApi:rest/Accounts` |
| `@AuraEnabled` on a method | `ExternalApi:aura/{ClassName}.{methodName}` |
| `@InvocableMethod(label='...')` | `ExternalApi:invocable/{ClassName}.{methodName}` |

The synthetic id is **information**, not a graph node. Surface
it in the response verbatim — never try to resolve it to a real
component, never drop the `ExternalApi:` prefix, never paraphrase
the path. The architect reads the synthetic id and immediately
understands what's exposed.

### Step 5 — Disclose the boundary

This step is non-optional. After the category-specific report,
append a short disclosure that names the coverage gaps.
**Always** — even when the result is large — the architect needs
to know what *isn't* in the answer.

Standard disclosure paragraph:

> The integration topology captures the **declared / configured**
> surface — metadata XML for the six new integration types
> (AuthProvider, RemoteSiteSetting, CspTrustedSite,
> ExternalDataSource, ExternalService, NetworkAccess) and the
> Apex-header annotation set for `listensTo` / `exposes` /
> `dispatchesAsync` / the seven new property booleans. It does
> **not** model: outbound HTTP correlation from LWC source
> (`fetch('https://...')`), outbound-message destination
> correlation from WorkflowRule, virtual sObjects projected from Salesforce
> Connect (`Customer__x`), Change Data Capture subscriptions
> (`AccountChangeEvent` shapes), reflective async dispatch
> (`Type.forName(...).newInstance()`), Connected App → Profile /
> Permission Set linkage (Connected Apps surface as stand-alone
> nodes; `<profileName>` / `<permissionSetName>` are captured
> as bare strings, not edges), the `@AuraEnabled(label='...')`
> argument or any other annotation-argument body, and Sites /
> Experience Cloud (`Network` / `ExperienceBundle`) inbound
> surfaces. Runtime invocation behavior, per-callout traces, and
> live event-publication counts need the Salesforce UI or
> Setup — the offline knowledge base does not have them.

For Category (c) and Category (d), also note the client-side
filter limit:

> sf-intelligence doesn't yet ship server-side property filters on
> `sfi.list_components`; this list is filtered client-side over
> the full ApexClass enumeration. Server-side property filters
> are a possible later extension.

## Reporting format

Worked example for the integration-map happy path. Use the
synthetic fixture conventions
(`AuthProvider:Salesforce_OAuth`,
`NamedCredential:OrdersApi`,
`ExternalDataSource:Orders_OData`,
`ExternalService:WeatherService`,
`RemoteSiteSetting:Salesforce_Reports`,
`CspTrustedSite:CdnAssets`,
`NetworkAccess:OfficeRange`,
`ConnectedApp:MarketingSync`).

User: *"Draw me our integration map."*

Claude's flow:

1. **Classify** → Category (a), topology map.
2. **Call** `sfi.run_analysis` with `{ "name": "sfi.integration_map", "args": { … } }` with `{ filter: 'all' }`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "authProviders": [
      { "id": "AuthProvider:Salesforce_OAuth", "type": "AuthProvider", "apiName": "Salesforce_OAuth", "label": "Salesforce OAuth", "properties": { "providerType": "OpenIdConnect", "executionUser": "integration@example.com" } }
    ],
    "namedCredentials": [
      { "id": "NamedCredential:OrdersApi", "type": "NamedCredential", "apiName": "OrdersApi", "label": "Orders API", "properties": { "endpoint": "https://orders.example.com/api", "principalType": "NamedUser" } }
    ],
    "remoteSiteSettings": [
      { "id": "RemoteSiteSetting:Salesforce_Reports", "type": "RemoteSiteSetting", "apiName": "Salesforce_Reports", "label": "", "properties": { "url": "https://reports.salesforce.com", "isActive": true } }
    ],
    "cspTrustedSites": [
      { "id": "CspTrustedSite:CdnAssets", "type": "CspTrustedSite", "apiName": "CdnAssets", "label": "", "properties": { "endpointUrl": "https://cdn.example.com", "context": "All", "isActive": true } }
    ],
    "externalDataSources": [
      { "id": "ExternalDataSource:Orders_OData", "type": "ExternalDataSource", "apiName": "Orders_OData", "label": "Orders OData", "properties": { "endpoint": "https://odata.example.com/Orders", "type": "OData4", "isWritable": false } }
    ],
    "externalServices": [
      { "id": "ExternalService:WeatherService", "type": "ExternalService", "apiName": "WeatherService", "label": "Weather Service", "properties": { "schemaType": "OpenApi3", "schemaUrl": "https://weather.example.com/openapi.json" } }
    ],
    "connectedApps": [
      { "id": "ConnectedApp:MarketingSync", "type": "ConnectedApp", "apiName": "MarketingSync", "label": "Marketing Sync", "properties": {} }
    ],
    "networkAccesses": [
      { "id": "NetworkAccess:OfficeRange", "type": "NetworkAccess", "apiName": "OfficeRange", "label": "", "properties": { "startAddress": "10.0.0.0", "endAddress": "10.0.0.255" } }
    ],
    "references": [
      { "fromId": "ExternalDataSource:Orders_OData", "toId": "AuthProvider:Salesforce_OAuth", "edgeType": "references", "role": "authProvider" },
      { "fromId": "ExternalService:WeatherService", "toId": "NamedCredential:OrdersApi",      "edgeType": "references", "role": "namedCredential" }
    ]
  }
}
```

4. **Respond:**

> Integration map for this org (filter: `all`).
>
> **Auth providers (1)**
> - `AuthProvider:Salesforce_OAuth` — providerType `OpenIdConnect`,
>   executionUser `integration@example.com`.
>
> **Named credentials (1)**
> - `NamedCredential:OrdersApi` — endpoint
>   `https://orders.example.com/api`, principal `NamedUser`.
>
> **Remote site settings (1)**
> - `RemoteSiteSetting:Salesforce_Reports` — url
>   `https://reports.salesforce.com`, active.
>
> **CSP trusted sites (1)**
> - `CspTrustedSite:CdnAssets` — endpointUrl
>   `https://cdn.example.com`, context `All`, active.
>
> **External data sources (1)**
> - `ExternalDataSource:Orders_OData` — endpoint
>   `https://odata.example.com/Orders`, type `OData4`, read-only.
>
> **External services (1)**
> - `ExternalService:WeatherService` — schemaType `OpenApi3`,
>   schemaUrl `https://weather.example.com/openapi.json`.
>
> **Connected apps (1)**
> - `ConnectedApp:MarketingSync` — OAuth client (stand-alone in
> no edge into Profile / PermissionSet).
>
> **Network access (1)**
> - `NetworkAccess:OfficeRange` — `10.0.0.0 - 10.0.0.255`.
>
> **Cross-type references (2)**
> - `ExternalDataSource:Orders_OData` → `AuthProvider:Salesforce_OAuth`
>   (`references`, role `authProvider`, `confidence: declared`).
> - `ExternalService:WeatherService` → `NamedCredential:OrdersApi`
>   (`references`, role `namedCredential`, `confidence: declared`).
>
> The integration topology captures the declared / configured
> surface from metadata XML and Apex-header annotations. It does
> **not** model outbound `fetch('https://...')` from LWC source,
> outbound-message destinations from WorkflowRule, virtual
> sObjects projected from Salesforce Connect,
> reflective async dispatch, Connected App → Profile /
> Permission Set linkage, annotation-argument bodies (e.g.,
> `@AuraEnabled(label='...')`), and Sites / Experience Cloud
> (`Network` / `ExperienceBundle`) inbound surfaces. Runtime
> invocation behavior needs the Salesforce UI.

Every category appears (empty ones too, so the architect knows
the map is complete). Every cross-type reference cites
canonical IDs, role, and confidence. The boundary disclosure is
verbatim.

## Boundary disclosure

The integration topology has well-defined gaps. Surface this
list whenever the architect is about to act on the report
(audit, deprecation, refactor), and **always** when the result
hits one of the boundaries below:

- **Sites / Experience Cloud (`Network` metadata type).** sf-intelligence
  covers `NetworkAccess` (the IP-range trust list) — NOT the
  `Network` Experience Cloud Site metadata family (a separate
  family that also includes `ExperienceBundle`). The naming
  collision is unfortunate; the metadata types are unrelated.
  If the architect needs Sites / Experience Cloud coverage,
  refuse honestly; deferred if architect demand
  surfaces.
- **Event publishers are PARTLY modeled — under a different edge
  name.** There is no `publishesTo` EdgeType and there never was; the
  graph model is `writesTo` = emits/publishes, `listensTo` =
  receives/subscribes, and the two are mutually exclusive.
  `sfi.event_subscribers` in single-event mode (with an `eventId`)
  returns a `publishers[]` group built from those inbound `writesTo`
  edges. So "what publishes `Account_Change__e`?" is NOT a refusal —
  run it. But split the answer by source:
  - **Flow publishers: modeled.** A Flow `<recordCreates>` on the
    event mints an object-level `writesTo` edge, and those appear.
  - **Apex `EventBus.publish(...)`: NOT modeled.** Despite what the
    tool's own publisher disclosure says, no scanner in
    `packages/parsers/src` or `packages/extractors/src` detects
    `EventBus.publish` — the Apex scanner detects `EventBus.subscribe`
    (heuristic `listensTo`) and nothing on the publish side. An Apex
    class that publishes the event will NOT appear in `publishers[]`.
  So an empty `publishers[]` is not proof nothing publishes the event
  — it is compatible with "every publisher here is Apex". Say that
  rather than reporting the event as unpublished.
- **LWC `fetch()` URL correlation to `RemoteSiteSetting` /
  `CspTrustedSite`.** An LWC bundle that does
  `fetch('https://my-api.example.com/x')` is invisible to
  the integration map. The LWC scanner is regex-based
  and was scoped to field-access / Apex-import patterns; URL
  detection in JS source would require an additional pass with
  a high noise floor (any URL-shaped string in JS looks like
  an integration point). Deferred.
- **Outbound-message destination correlation.** WorkflowRule
  nodes carry `outboundMessages` properties with the endpoint
  URL as a string; sf-intelligence does NOT emit an edge from the
  WorkflowRule to the destination endpoint (adding it would
  require synthesizing an `ExternalEndpoint:` synthetic-id
  family, which this tier explicitly does not introduce). The
  integration map is scoped to first-party, named outbound
  surfaces. The architect verifies the destination in the
  WorkflowRule node's properties directly.
- **Connected App → Profile / Permission Set linkage.** The
  ConnectedApp extractor surfaces `<profileName>` and
  `<permissionSetName>` as bare strings in the node's
  properties; sf-intelligence does NOT promote them to edges. The
  integration map shows Connected Apps as stand-alone surfaces.
  Architects auditing who can use a Connected App's OAuth
  client check the bare-string properties or run
  `sfi.get_component` on the Connected App node.
- **Virtual sObjects from Salesforce Connect (`Customer__x`).**
  An `ExternalDataSource` of type `OData4` projects external
  data as virtual sObjects with names ending in `__x`; sf-intelligence
  records the data source itself but does NOT create
  CustomObject nodes for the virtual sObjects it projects
  (extraction would require querying the external schema, a
  network call the offline posture cannot make). Deferred.
- **Change Data Capture (CDC) subscription detection.** CDC
  events have names like `AccountChangeEvent` (no `__e`
  suffix) and are subscribed via the Streaming API channel
  paths, not the Platform Event mechanism. `listensTo`
  rules pin to `__e` shapes; CDC subscribers are NOT modeled.
  Deferred.
- **Reflective async dispatch
  (`Type.forName(...).newInstance()`).** The dispatch site
  passes a constructed instance whose type is a string
  expression the scanner cannot resolve. The
  `dispatchesAsync` edge is **not** emitted for this pattern;
  the architect verifies the dispatch source code manually.
- **Programmatic event subscription
  (`EventBus.subscribe(...)`).** An Apex class that registers a
  subscriber at runtime is invisible to the extractor — subscription is
  a runtime registration, not a declaration. The
  `listensTo` rules pin to declared subscriber shapes
  (trigger, `Triggerable<>`, Flow start). Deferred.
- **`@AuraEnabled(label='...')` argument extraction.** The
  synthetic id for AuraEnabled exposes is
  `ExternalApi:aura/{ClassName}.{methodName}`; the
  annotation's `label` / `cacheable` / other named arguments
  are NOT captured into the synthetic path or edge properties.
  Consumers needing the label walk the Apex source.
- **Per-step approval-process notifications.** ApprovalProcess
  step-level email / notification routing is the
  `admin-legacy-automation` skill's surface, not this one. If
  the architect's question is about notification topology
  *inside* an approval process, defer; the integration
  topology skill is scoped to the org's *external* surface.
- **`dispatchesAsync` for unresolvable dispatch sites.** When
  the dispatched Queueable / Schedulable / Batchable is passed
  via a variable whose constructor the scanner cannot resolve
  (helper-wrapper dispatch, interface-typed parameter,
  method-return-typed local), zero edges are emitted. This is
  the Q45 honesty anchor — the architect sees a
  declared-but-untraced relationship rather than a fabricated
  link. Documented in
  `docs/vendor/salesforce-metadata/IntegrationTopologySemantics.md`.
- **Platform Event channel routing.** Platform Events routed
  through dedicated channels for tenant isolation are
  subscribed via the same `on {Event}__e` / `Triggerable<>` /
  `<triggerType>PlatformEvent</triggerType>` shapes; sf-intelligence
  emits the `listensTo` edge but does NOT carry the channel
  binding as edge metadata. The channel is documented in the
  ApexClass source comment, not the metadata XML.

Treat a `dispatchesAsync` edge with `confidence: heuristic` as a
flag for source-side verification, not as a denial of the
relationship. Treat the empty case (zero outgoing
`dispatchesAsync` edges from a class the architect *knows*
dispatches async work) as the helper-wrapper / reflective-
dispatch boundary above. Treat every `declared` edge as the
metadata IS the declaration.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Confusing `NetworkAccess` (IP range trust list) with `Network` (Experience Cloud Site). | They are distinct, unrelated metadata families with a confusing naming collision. sf-intelligence covers `NetworkAccess` only; `Network` / `ExperienceBundle` are inbound site surfaces not modeled. Refuse the Experience Cloud question and name the boundary. |
| Treating `dispatchesAsync` heuristic results as declared. | The `heuristic` confidence is load-bearing: the scanner inferred the dispatch from a callee annotation (the `@future` case) or a named local variable. The architect makes a refactor decision and skips the manual source check if the confidence is paraphrased away. Always cite confidence. |
| Presenting `integration_map` output as exhaustive. | The map lists only what's extracted. LWC `fetch()` calls, outbound-message destinations, CDC subscribers, virtual sObjects, and `EventBus.publish` are all invisible. The architect making an "audit our outbound surface" decision based on the map alone misses real callouts; the boundary disclosure paragraph is the protection. Always disclose. |
| Querying `sfi.event_subscribers` on a non-`__e` id and expecting an error rather than empty result. | The tool actively errors with `invalid-query` when the eventId is not a `CustomObject:` whose ApiName ends in `__e` — this is the  contract pinning the input axis to Platform Events. Don't retry on the same id; recover by classifying to `sfi.get_edges` with `edgeType: 'triggersOn'` for standard sObject subscriptions. |
| Resolving the synthetic `ExternalApi:` id to a fake `ApexClass:` form. | The synthetic id IS the architect-readable rendering. Don't paraphrase it, don't drop the prefix, don't substitute the source class for the API path. The architect needs `ExternalApi:rest/Accounts` verbatim to recognize the REST mapping. |
| Walking outgoing `references` edges from an integration node and surfacing every target (e.g., `CustomField` rows). | `sfi.integration_map` already filters to cross-type integration edges. Don't pad the response by walking edges into non-integration targets; the architect's question is "what does this org *integrate* with", not "what does the integration touch internally". |
| Firing this skill on a impact question. | "What breaks if I delete `NamedCredential:OrdersApi`?" is `architect-impact-analysis` shape (`sfi.get_impact`). `sfi.integration_map` answers "what's wired"; `sfi.get_impact` answers "what depends on this". Defer correctly. |
| Skipping the boundary disclosure on a non-empty integration map. | The disclosure is the architect's protection against the wrong mental model. A populated integration map still has to coexist with un-modeled LWC `fetch()` URLs, outbound message destinations, and Connected App linkages. Always disclose. |
| Silently filtering empty integration categories from the report when `filter: 'all'`. | An empty `remoteSiteSettings` array IS information — it tells the architect this org uses Named Credentials exclusively. Surface the empty category with a one-line note rather than dropping it. |
| Confidently answering "is this Connected App used by Profile X" from the integration map. | sf-intelligence does NOT model Connected App → Profile / Permission Set linkage. The Connected App's `<profileName>` / `<permissionSetName>` are bare strings in the node's properties, not edges. Refuse the question; offer `sfi.get_component` on the Connected App for the raw property list. |
| Treating an `unknown` boundary note as `not used`. | Every `unknown` is "sf-intelligence can't tell from declared metadata". For LWC `fetch()` and `EventBus.publish` patterns, the actual integration may exist in source code that the scanner doesn't extract. Never collapse an `unknown` boundary into a definitive negative. |

## Example interactions

### Happy path — integration map for the whole org

User: *"Draw me our integration map."*

Claude's flow:

1. **Classify** → Category (a), topology map.
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.integration_map", "args": { … } }` with `{ filter: 'all' }`.
3. **Receive** the populated 8-category response (see
   *Reporting format* above for the full transcript).
4. **Present** the eight categorized sections + cross-type
   references section, citing canonical IDs and edge
   confidences.
5. **Boundary disclosure** — verbatim (LWC fetch, outbound message,
   virtual sObjects, reflective dispatch, AuraEnabled label,
   approval notifications, helper-wrapper `dispatchesAsync`,
   Platform Event channel).

### Event-subscriber lookup — who subscribes to a Platform Event

User: *"Who subscribes to `Account_Change__e`?"*

Claude's flow:

1. **Classify** → Category (b), event subscribers.
2. **Translate** the user's phrasing to the canonical event id:
   `CustomObject:Account_Change__e`. Validate the `__e` suffix
   before firing.
3. **Fire** `sfi.run_analysis` with `{ "name": "sfi.event_subscribers", "args": { … } }` with
   `{ eventId: 'CustomObject:Account_Change__e' }`.
4. **Receive** (illustrative):

```json
{
  "data": {
    "eventId": "CustomObject:Account_Change__e",
    "subscribers": [
      { "subscriberId": "ApexTrigger:AccountChangeSubscriber", "subscriberType": "ApexTrigger", "subscriberSource": "apex-trigger-extractor", "confidence": "declared", "properties": { "triggerEvents": ["after insert"] } },
      { "subscriberId": "ApexClass:AccountChangeHandler",      "subscriberType": "ApexClass",   "subscriberSource": "apex-class-extractor",   "confidence": "declared", "properties": { "interfaceMatch": "Triggerable<Account_Change__e>" } },
      { "subscriberId": "Flow:AccountChangeNotifier",          "subscriberType": "Flow",        "subscriberSource": "flow-extractor",         "confidence": "declared", "properties": { "triggerType": "PlatformEvent" } }
    ]
  }
}
```

5. **Respond:**

> Subscribers to `CustomObject:Account_Change__e` (3):
>
> **Apex triggers (1)**
> - `ApexTrigger:AccountChangeSubscriber` —
>   `listensTo` from the trigger's `on Account_Change__e
>   (after insert)` clause. Source: `apex-trigger-extractor`,
>   `confidence: declared`.
>
> **Apex classes (1)**
> - `ApexClass:AccountChangeHandler` — `listensTo` from the
>   `implements Triggerable<Account_Change__e>` clause.
>   Source: `apex-class-extractor`, `confidence: declared`.
>
> **Flows (1)**
> - `Flow:AccountChangeNotifier` — `listensTo` from the
>   Flow's `<start>` element with `<triggerType>PlatformEvent</triggerType>`
>   and `<object>Account_Change__e</object>`. Source:
>   `flow-extractor`, `confidence: declared`.
>
> All three subscribers are `declared`-confidence — sf-intelligence reads
> the subscription declaration directly from the source.
>
> sf-intelligence captures the declared subscriber surface. Apex
> `EventBus.subscribe(...)` is now recognized heuristically
> (static/resolvable channel args only); dynamically-built
> subscriptions and managed-package listeners remain invisible. CDC
> subscribers are a separate axis — CDC uses `AccountChangeEvent`-shaped
> channel names, not `__e` Platform Events, and
> `sfi.event_topology` covers them (it also covers the Platform Event
> half, and names the events the org references but the vault never
> retrieved).
>
> For what PUBLISHES `Account_Change__e`, call
> `sfi.event_subscribers` with the `eventId` — its `publishers[]`
> group is built from inbound `writesTo` edges. There is no
> `publishesTo` edge; `writesTo` is the publish-side edge. Coverage is
> partial and asymmetric: **Flow** publishers (a `<recordCreates>` on
> the event) ARE modeled; **Apex `EventBus.publish(...)` is NOT** —
> no scanner detects it, so an Apex publisher never appears. An empty
> `publishers[]` therefore means "no modeled Flow publisher", never
> "nothing publishes this event".

### Async classifier — list all queueable classes

User: *"List all queueable classes."*

Claude's flow:

1. **Classify** → Category (c), async / job classifier.
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.list_components", "args": { … } }` with
   `{ type: 'ApexClass', limit: 500 }`.
3. **Filter client-side** for nodes where
   `properties.isQueueable === true`.
4. **Respond:**

> Queueable classes in this org (3, filtered client-side over
> the full ApexClass enumeration):
>
> - `ApexClass:AccountIndexer` — `implements Queueable`. Enqueued
>   by `ApexClass:AccountTriggerHandler` via `System.enqueueJob(new
>   AccountIndexer(...))` (one incoming `dispatchesAsync` edge,
>   `confidence: declared`).
> - `ApexClass:OrderRefresh` — `implements Queueable,
>   Database.AllowsCallouts`. No incoming `dispatchesAsync` edges
>   detected — either nothing enqueues it, or the enqueue site
> uses a pattern the scanner can't resolve (helper wrapper,
>   reflective dispatch). Verify manually.
> - `ApexClass:WeatherSync` — `implements Queueable`. Enqueued by
>   `ApexClass:WeatherScheduler` via the chain `System.schedule(...)
>   → WeatherScheduler.execute() → System.enqueueJob(new
>   WeatherSync())` (one incoming `dispatchesAsync` edge,
>   `confidence: declared`).
>
> sf-intelligence does not yet ship server-side property filters on
> `sfi.list_components`; this list is filtered client-side over
> the full ApexClass enumeration (server-side property filters
> are a possible later extension). The `isQueueable` property is
> emitted by the `parseApexHeader` extension and is
> `declared`-confidence — the `implements Queueable` clause IS
> the declaration.
>
> Follow-up: if you want to walk the call site for any of these
> classes, point me at the canonical id and I'll run
> `sfi.search_apex_source` against the surrounding context.
> Outgoing `dispatchesAsync` edges from these Queueable classes
> (e.g., a Queueable that itself enqueues another Queueable) are
> walked the same way — incoming `dispatchesAsync` for "who
> enqueues this", outgoing for "what does this enqueue".

### Honest refusal — LWC fetch URL correlation

User: *"What URL does the LWC `accountDashboard` fetch from?"*

Claude's flow:

1. **Classify** — this is a topology-shape question, but the
   target is an LWC outbound HTTP call, NOT a modeled
   integration surface.
2. **Stop.** Do not fire `sfi.run_analysis` with `{ "name": "sfi.integration_map", "args": { … } }` or
   `sfi.list_components` — the answer isn't in the graph.
3. **Respond:**

> sf-intelligence doesn't correlate LWC `fetch('https://...')` URLs to
> `RemoteSiteSetting` / `CspTrustedSite` entries — the LWC
> scanner was scoped to field-access and Apex-import patterns,
> and URL detection in JS source would have a high noise floor
> (any URL-shaped string in JS looks like an integration point).
>
> To answer "what URL does the LWC `accountDashboard` fetch
> from":
>
> - **Read the LWC source** — the bundle's `.js` controller
>   carries the `fetch(...)` call. Use `sfi.get_component({ id:
>   'LightningComponentBundle:accountDashboard' })` for the
>   structured component metadata, then read the source files
>   listed in the response.
> - **Cross-check against `RemoteSiteSetting` /
>   `CspTrustedSite`** — call `sfi.integration_map({ filter:
>   'sites' })` to surface the allowed outbound URL list; an
>   LWC fetching a URL not in that list will fail at runtime
>   (CSP block).
>
> LWC URL correlation is a possible later extension. For now,
> sf-intelligence can map the *allowed* outbound surface but not the
> *actual* LWC outbound calls.

The response names the boundary, points to two concrete
in-scope alternatives, and offers the next-milestone roadmap.

### Recovery — `event_subscribers` on a non-event id

User: *"Who subscribes to `Account` records being updated?"*

Claude's flow:

1. **Classify** → looks like Category (b), event subscribers —
   but `Account` is a standard sObject, not a Platform Event.
2. **Translate** the user's phrasing: they mean "who has a
   trigger on Account updates", not "who subscribes to a
   Platform Event named Account".
3. **Stop.** `sfi.event_subscribers` would reject this with
   `invalid-query` — the eventId `CustomObject:Account` doesn't
   end in `__e`.
4. **Respond:**

> `Account` is a standard sObject, not a Platform Event.
> `sfi.event_subscribers` is scoped to Platform Events
> (`CustomObject:` ids ending in `__e`); standard sObject
> trigger subscriptions use the `triggersOn` edge family, not
> `listensTo`.
>
> If you want every Apex trigger / Flow that fires on Account
> updates, that's `sfi.get_edges` with
> `{ targetId: 'CustomObject:Account', edgeType: 'triggersOn',
> direction: 'in' }` — this surfaces ApexTrigger nodes with `on
> Account (after update)` clauses and Flows with
> `<triggerType>RecordAfterSave</triggerType>` / `<object>Account</object>`
> start elements.
>
> Want me to run that instead? Or did you mean a Platform Event
> like `Account_Change__e` (the Change Data Capture name is
> `AccountChangeEvent` — sf-intelligence doesn't model CDC subscribers
> either; that's a separate roadmap item)?

The response refuses cleanly, names the contract boundary
explicitly, and offers the in-scope alternative.

## Verification

Before sending a response, confirm:

- [ ] I classified the question into one of the four
      categories (topology map, event subscribers, async / job
      classifier, API surface) before firing any tool.
- [ ] For a topology question, I called `sfi.run_analysis` for `sfi.integration_map`
      with the right `filter` value (`all` / `auth` / `sites` /
      `sources` / `services` / `access`).
- [ ] For an event-subscribers question, I validated the
      `eventId` is `CustomObject:` with `__e` suffix BEFORE
      firing — non-event ids surface as `invalid-query`,
      which I recover from rather than retry.
- [ ] For an async / job classifier question, I called
      `sfi.list_components({ type: 'ApexClass' })` and filtered
      client-side on the  boolean property (`isQueueable`,
      `isSchedulable`, `isBatchable`, `hasFutureMethod`,
      `hasInvocableMethod`), and surfaced the client-side
      filter limit explicitly.
- [ ] For an API-surface question, I called
      `sfi.list_components({ type: 'ApexClass' })` and filtered
      on `isRestResource` / `hasAuraEnabledMethod` /
      `hasInvocableMethod`, then walked outgoing `exposes`
      edges and rendered the synthetic
      `ExternalApi:{kind}/{path}` ids verbatim.
- [ ] I cited canonical IDs (`AuthProvider:`,
      `NamedCredential:`, `RemoteSiteSetting:`,
      `CspTrustedSite:`, `ExternalDataSource:`,
      `ExternalService:`, `ConnectedApp:`, `NetworkAccess:`,
      `CustomObject:{Name}__e`, `ApexClass:`, `ApexTrigger:`,
      `Flow:`) for every component named.
- [ ] I cited every cross-type reference edge's
      `confidence` (`declared` for the  integration tier,
      `heuristic` only for the named-local-variable
      `dispatchesAsync` case).
- [ ] I did NOT confuse `NetworkAccess` (IP range trust list)
      with `Network` (Experience Cloud Site).
- [ ] I did NOT resolve a synthetic `ExternalApi:` id to a fake
      real-node form.
- [ ] I appended the boundary disclosure — LWC fetch
      correlation, outbound message destinations,
      virtual sObjects, reflective dispatch, AuraEnabled label
      argument, Connected App → Profile linkage, helper-wrapper
      `dispatchesAsync`, Platform Event channel routing, Sites /
      Experience Cloud, approval-step notifications.
- [ ] I did NOT claim a `publishesTo` edge exists — the publish-side
      edge is `writesTo`, surfaced in
      `event_subscribers.publishers[]`. I ran that tool rather than
      refusing the publisher question, and I split the answer:
      Flow publishers are modeled, Apex `EventBus.publish(...)` is
      not detected by any scanner, so an empty `publishers[]` is
      never "nothing publishes this event".
- [ ] If the question was about a Network / Experience Cloud
      Site, LWC fetch URL, CDC subscriber, or event publisher,
      I refused honestly and named the boundary verbatim.
- [ ] I did not present an `unknown` boundary note as `not
      used`, and I did not fabricate an integration when the tool
      couldn't tell.

---

**Grounding & routing (shared contract).** For a vague or broad ask, run `sfi.route_question` through `sfi.run_analysis` first — it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer` (via `sfi.run_analysis`), which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
