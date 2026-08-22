### Added

- **`sfi.event_topology` — one front door for the org's event plane.** Platform
  Events, Change Data Capture and the PlatformEventChannels that carry both,
  with inventory AND where-used, in a single call.

  The capability was not missing; it was split and over-confident. A
  deterministic `event-catalog` intent already routed *"what platform events
  are in this org and where are they used?"* — to `sfi.event_subscribers`
  alone, which answers the Platform Event half and silently drops the CDC half.
  On the probe vault it returned **one** event while the org's own permission
  metadata NAMES nine, with nothing said about the other eight. `sfi.event_topology`
  answers both halves and returns the retrieval coverage those answers were
  computed under.

  **Absence is typed, never flattened to zero.** Three distinct shapes, each
  with its own disclosure on the path that warrants it:

  - `referencedNotRetrieved[]` names every event id the org REFERENCES but the
    vault never retrieved — their subscribers are UNKNOWN, not zero. A
    namespaced id carries `closableByRefresh: false`, because a metadata
    retrieve never returns managed-package components: that is the
    `unproducedEdgeType` shape, a gap no refresh closes, distinct from a
    `coverageCaveat` a refresh does close.
  - An empty `cdcEntities` list quotes the manifest coverage row verbatim
    (via the existing `familyAbsence()`), so *"no object has change data
    capture enabled"* is legible as a CHECKED zero — and a vault that never
    requested `PlatformEventChannelMember` says `NOT CHECKED` instead.
  - `eventType` / `publishBehavior` read `null` on a vault built before the
    extractor stamped them, disclosed as **not extracted**, never as *"the org
    did not declare one"*.

  **A permission grant on a `*ChangeEvent` is NOT CDC enablement.** Those
  entities exist on every org whether or not CDC is selected; they surface only
  under `referencedNotRetrieved` and are excluded from `cdcEntities` by
  construction, with a boundary saying so.

  Code that reacts to a change stream is read from the `triggersOn` edge the
  trigger extractor ALREADY emits into `CustomObject:{X}ChangeEvent` — no new
  edge type, nothing name-matched into existence.

- **Platform-event facts on the graph.** The CustomObject extractor now reads
  `<eventType>` (HighVolume / StandardVolume) and `<publishBehavior>`
  (PublishAfterCommit / PublishImmediately) and stamps `isPlatformEvent: true`
  on the PlatformEvent variant, so a consumer can ask the graph whether a node
  IS a platform event instead of re-deriving it from the `__e` suffix. Emitted
  on that variant ONLY — every other object's properties map is byte-identical.
  `PlatformEventChannel` likewise gains its declared `<eventType>`
  (`custom` / `standard`).

### Changed

- **`sfi.cdc_subscribers` retired to a hidden back-compat alias.** Its CDC
  enablement and code-subscriber facts are returned by `sfi.event_topology`
  alongside the platform-event half. The handler stays dispatchable by name and
  through `sfi.run_analysis`; it no longer occupies a schema slot on
  `tools/list`, so the advertised roster is **net-flat across this
  consolidation** rather than growing for it.

- **`sfi.event_subscribers` narrowed to the single-event detail view.** Its
  org-wide catalog phrasings moved to `sfi.event_topology`; the catalog mode
  itself still answers for back-compat callers, and its description now says
  plainly that it covers neither CDC nor referenced-but-not-retrieved events.

### Fixed

- **The CDC enablement FRAME routed nowhere.** *"Which objects have change data
  capture enabled in this org?"* — the way the question is actually asked —
  matched no intent rule, fell through to `unrouted`, and the funnel's top pick
  blew the ~40 KB response budget, so the user got an `oversize` error and no
  answer at all. The SUBSCRIBER frame had been routing fine the whole time: the
  gap was the frame, not the capability. A new `cdc-enablement` intent (keyed on
  the STATE — "enabled", "turned on", "selected" — never the ACT, so the
  "will turning on CDC fan out?" question keeps its own route) and eighteen
  funnel utterances now put `sfi.event_topology` first for it, with no component
  to resolve. *"What event channels does this org have?"* was likewise unrouted
  and now lands on the same front door.
