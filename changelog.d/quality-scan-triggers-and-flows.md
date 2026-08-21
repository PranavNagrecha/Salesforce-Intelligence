### Fixed

- **The tools that compose over `properties.qualityIssues` no longer answer
  CLEAN for Apex triggers.**
  `detectCodeQualityIssues` ran from the ApexClass extractor and nowhere else.
  Measured on a real vault: ApexClass 192/192 carried `qualityIssues`,
  **ApexTrigger 0 of 22, Flow 0 of 275** — while both audit tools advertised
  walking "every ApexClass / ApexTrigger". A CRUD/FLS audit scoped to a trigger
  with four unguarded SOQL queries and an unguarded `update` returned
  `{ classes: [], totalFindingCount: 0, boundaries: [] }`. Triggers are exactly
  where CRUD/FLS bugs live: a trigger does DML on `Trigger.new` in system
  context by default.

  The ApexTrigger extractor now runs the recognizers. All 17 were checked
  against trigger shape first: the class-shaped ones cannot false-fire
  (`without-sharing-no-comment` requires the literal `class` keyword;
  `fake-assertion` and `hardcoded-sandbox-test-data` are gated on `isTest`, and
  a trigger is never a test class), and one — `trigger-no-recursion-guard` — was
  dead code until now, because it can only ever match a `trigger X on` header.

### Changed

- **The two absences the quality audits report are now different answers.**
  - A vault built BEFORE triggers were scanned holds nodes with no
    `qualityIssues` key. Every tool that composes over that mirror —
    `sfi.crud_fls_audit`, `sfi.code_quality_audit`, `sfi.governor_limit_risks`,
    `sfi.find_hardcoded_values`, `sfi.find_hardcoded_values_anywhere` (apex
    scope), `sfi.tech_debt_score` and `sfi.test_coverage_gaps` (over the test
    classes whose `fake-assertion` findings drive its verdicts) — now carries
    `qualityScanCoverage` (nodes read vs nodes actually scanned, per type) and
    a `boundaries[]` entry saying
    NOT CHECKED rather than CLEAN, pointing at `sfi refresh`. It disappears once
    the vault is refreshed, and a node that was scanned and is clean emits
    nothing. `sfi.governor_limit_risks` additionally says that its `soundness`
    envelope reads the same property, so `complete: true` covers only the nodes
    it names as scanned.
  - `sfi.tech_debt_score` needed the note most and had it least: its only
    honesty hook fired when NO node anywhere carried the property, so a vault
    with 192-of-192 ApexClasses and 0-of-22 ApexTriggers scanned scored the
    `codeQuality` axis off part of the Apex surface and said nothing at all.
    Partial coverage is now disclosed, and `Flow` was dropped from its node
    fetch for the same reason it was dropped from the audits — 275 node reads
    for a property that cannot exist there.
  - `sfi.explain_apex_method` mirrors one component's findings rather than
    scanning, so it gets the same distinction in its `disclosure` instead of a
    census: a node with no `qualityIssues` KEY was never scanned, and its empty
    mirror now says NOT CHECKED rather than reading as clean.
    `sfi.meaningful_test_audit` already stated the absent case unconditionally
    in its verbatim disclosure and is unchanged.
  - `Flow` is not Apex. It was listed in `QUALITY_SCANNED_TYPES` as an
    aspiration and advertised as covered while contributing zero of 275 nodes,
    because every recognizer reads Apex syntax. It is no longer scanned for a
    property that cannot exist; instead `sfi.code_quality_audit` and
    `sfi.tech_debt_score` name it in `notCheckedTypes` — permanently, since no
    refresh on any org closes it — and point at `sfi.flow_bulkification_audit` /
    `sfi.flow_fault_audit`, which are the flow-quality surface.

  Every affected tool description was corrected to stop advertising what does
  not happen.
