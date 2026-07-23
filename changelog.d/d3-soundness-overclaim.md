### Fixed

- `sfi.get_impact` no longer reports `soundness.complete: true` / `staticCoverage: 'full'`
  for a `CustomField` / `CustomObject` root. Whole classes of referrer are
  structurally NOT modeled as incoming graph edges — roll-up source coupling
  (`summaryForeignKey` is a field property), layout placement (Layout sections /
  related-lists), flow decision/filter reads (a `firesWhen` edge to a
  `ConditionalContext`, never a `readsFrom` onto the field), and tab/app
  membership (`CustomTab` / `CustomApplication` are not traversed) — so an
  edge-walking impact analysis is blind to them. The soundness envelope now
  carries an `unwalked-referrer-class` blind spot naming those classes verbatim
  in `referrerClasses[]` (and the prose `disclosure` names them), so "no
  referrers found" is never presented as certainty. Non-field/object roots and
  the Apex reachability tools are unchanged.
- `sfi.field_360` no longer reports `readers: 0` for a field that one or more
  Flows filter on. Flow decision / record-trigger filter reads (which carry no
  `readsFrom` edge — only a `firesWhen` edge to a `ConditionalContext` whose
  `fieldRefs` name the field) are reconstructed from the extracted graph and
  surfaced in `readers` as disclosed, heuristic-confidence rows
  (`source: flow-condition-reads-scan:*`), deduped against real `readsFrom`
  readers. The reconstruction pages EVERY `ConditionalContext` node (via the
  shared full-window scan), not just the first 500 — so a field whose sole
  flow-condition reader lives past node 500 is no longer silently missed. When
  the scan hits its `SFI_CONDITION_SCAN_MAX` residual ceiling, `boundaries[]`
  discloses `CAPPED at N of M ConditionalContext nodes` so a tail miss is
  surfaced, never silent. `boundaries[]` also discloses the reconstruction and
  names the referrer classes still not composed into any section (roll-up source
  coupling, layout related-list placement).
