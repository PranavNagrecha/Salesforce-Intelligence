### Fixed

- **A metadata type whose shared retrieve container came back without its member
  file reported as COVERED.** `summarizeCoverage` reads `{requested: true,
  retrieveConfirmed: true, retrieved: 0}` as "the describe confirmed the type and
  the clean retrieve returned zero members, so the org genuinely has none". That
  reading is only sound when the type's own file was among what came back.
  `SessionSettings` and `FieldServiceSettings` are dispatched by exact filename
  out of the shared `settings/` container, and every other file in that container
  is walked past into `skippedDirectories` — 139 of them on the probe org. So the
  vault was reporting two planes complete while simultaneously listing `settings`
  in `topUncoveredFamilies` as retrieved-but-not-modeled.

  Coverage now carries a third honesty state, `retrievedNotParsedTypes`. It is
  excluded from `coveredTypes`, folded into `missingCoverage` (the set every
  absence caveat and every `dependsOnCoverage` hedge reads), and kept OUT of
  `partialTypes` — the two have opposite remedies, and telling an operator to
  re-retrieve a container that already came back sends them in a circle.
  `sfi.coverage_report` gains a `retrievedNotParsed` bucket plus a disclosure
  naming the state; `sfi.health_check` raises its own issue line; and
  `sfi.interpret` stops reporting `complete` over the unread plane — measured on
  the probe vault, an interpret call scoped to
  `concept:session-security-posture` went from
  `trust.completeness: {"status":"complete"}` with no caveat to
  `{"status":"partial","missingCoverage":["SessionSettings"]}` with
  `coverageCaveat: "coverage is partial — not fully modeled: SessionSettings."`

  **The disclosure names the gap and refuses to name its cause.** What the vault
  proves is bounded: the container WAS requested (both types already alias onto
  `Settings` in the retrieve manifest), the org DID return it, the refresh DOES
  dispatch both filenames to shipped extractors, and the type's own member file
  was not in what came back — so nothing was read for it. WHY it was not is
  undecidable offline, because two causes leave identical evidence: the org does
  not have the feature enabled (it then emits no such file, and "the org has
  none" is the true reading), or the file exists and did not come back. An
  earlier cut of this disclosure denied the first cause outright for BOTH types —
  "`retrieved: 0` is a BUILD outcome, not 'the org has none'" — with a proof for
  neither, and on the probe vault that is probably backwards for
  `FieldServiceSettings`: it models no ServiceAppointment, ServiceTerritory,
  WorkOrder or OperatingHours object at all, i.e. Field Service is simply not on.
  The shipped wording therefore states the gap, states that the two causes cannot
  be separated from the vault, and instructs the reader to treat the plane as NOT
  CHECKED. A cause is named only where a type-specific proof exists:
  `SessionSettings` can never arrive, because Salesforce emits no
  `Session.settings-meta.xml` at all — session settings are a nested
  `<sessionSettings>` element inside `Security.settings-meta.xml`, which IS in
  the vault — so closing that one is a product change, not an operator action.

  Scoped by an explicit table, not a blanket demotion: only types dispatched out
  of a shared container that returned other members qualify. The other ten
  confirmed-empty types on the probe org were checked one by one and their zeroes
  are honest — `AutoResponseRule`, `EscalationRule` and `WorkflowRule` each have
  their files on disk and those files declare zero rules. A vault whose
  containers were all dispatched serialises byte-identically: the new key is
  absent, not empty.
