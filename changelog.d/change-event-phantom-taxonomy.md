### Fixed

- **The refresh asked the org for Change Events forever.** The channel-member
  extractor emits `references` → `CustomObject:{selectedEntity}`, and an Apex CDC
  trigger emits `triggersOn` to the same shape; both edge types are in
  `AUTOMATION_EDGE_TYPES`, so `objectsToExpandManifest` named
  `AccountChangeEvent`-style entities in the B29 second-pass retrieve on EVERY
  refresh. A Change Event is never a retrievable CustomObject, so the request
  could not create the node, the phantom could not converge, and the next
  refresh re-requested the same entity and logged the same warning — with no
  terminating condition. Change Event targets are now excluded from the
  expansion manifest.

- **A Change Event phantom was reported as a coverage gap with an impossible
  remedy.** `classifyPhantom` had no bucket for it, so `AccountChangeEvent` came
  out `standard-field-phantom` ("treat it as standard") and
  `Order__ChangeEvent` on an automation edge came out `automation-critical` —
  i.e. a demand-retrieve candidate — while `phantomAwareNotFoundMessage` ended
  with *"Run `sfi refresh` if it should be retrievable"*. None of those can ever
  succeed. A new `change-event-stream` classification leads the precedence
  order, is never `demandRetrievable`, and carries a remedy that states the
  absence as STRUCTURAL rather than as a gap a refresh can close, pointing at the
  parent object and `sfi.cdc_subscribers` instead. The CDC name-pattern rule now
  has a single source of truth in `@sf-intelligence/graph`, shared by the
  classifier, the refresh gate, and the CDC tools, so the surface that reports a
  Change Event cannot drift from the surface that tries to retrieve one.
