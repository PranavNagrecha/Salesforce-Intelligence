### Fixed

- **`sfi.event_subscribers` told you "no subscribers" about Platform Events it
  had never retrieved.** `validateEventId` is a pure `__e`-suffix SYNTAX check,
  so single-event mode went straight from "that id looks like an event" to the
  edge walk. An event this org's own metadata NAMES but whose definition was
  never pulled — a managed-package event, or one outside the retrieve scope —
  answered with an empty subscriber list and the tool's detection-blind-spot
  disclosure, which says nothing about the event being absent. On a real vault
  reporting 1 Platform Event while its metadata named 9, eight events answered
  that way. The handler now resolves the event node first: a missing one sets
  `eventRetrieved: false` and LEADS `boundaries` with the phantom-aware
  not-retrieved verdict, while still returning the edge-derived subscriber,
  publisher, and channel lists (a subscriber's edge can exist even when the
  event node does not). A retrieved event's response is unchanged.

- **Catalog mode reported a partial event inventory as if it were the whole
  one.** `events[]` lists RETRIEVED event nodes only. It now also carries
  `referencedNotRetrievedEventCount` / `referencedNotRetrievedEvents` and a
  matching boundary whenever the org names `__e` ids the vault lacks; both are
  omitted when every referenced event was retrieved.

### Changed

- **`sfi.cdc_subscribers` now scans the Change Events that actually exist, and
  reads the edge an Apex CDC trigger really emits.** Two defects, one cause —
  a `{X}ChangeEvent` is synthesised by the platform and the Metadata API emits
  no component for it, so it is never a node on any org. Org-wide mode built its
  scan set from `listNodesByType('CustomObject')`, which therefore yielded ZERO
  Change Events on every real vault, and the tool still reported
  `totalSubscribers: 0` — a "did not check" presented as "checked and found
  nothing". The scan set is now built from Change Event edge TARGETS, and
  `summary.scannedChangeEvents` reports the denominator so the two answers are
  distinguishable; an empty scan set says so explicitly, and a scoped miss says
  the stream is referenced by nothing rather than implying CDC was checked.

  Separately, `apex-trigger.ts` emits `triggersOn` unconditionally and gates the
  extra `listensTo` edge on the `__e` Platform Event suffix, so
  `trigger X on AccountChangeEvent` has a `triggersOn` edge and NO `listensTo`
  edge at all. Reading only `listensTo` made every Apex CDC trigger invisible.
  Both edge families are now read; rows found through `triggersOn` carry
  `subscriptionEdge: 'triggersOn'`, and `listensTo` rows are unchanged.
