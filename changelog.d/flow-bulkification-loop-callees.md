### Fixed

- **`sfi.flow_bulkification_audit` no longer reports a loop it never looked into
  as clean.** The detector iterated `projection.recordOps` and nothing else, so
  a `Loop → Subflow(DML)` or `Loop → Action(Apex DML)` flow — the most common
  real-world bulkification bug — returned zero risks with `soundness.complete:
  true` and `staticCoverage: 'full'`.

  Two rules close the detection half: `subflow-in-loop` and `action-in-loop`,
  both MEDIUM and both carrying the invoked `callee`. Severity is deliberately
  not HIGH: the per-iteration INVOCATION is proven, the DML inside the callee is
  not. This audit does not open a Subflow's target flow (read that flow's own
  entry here) and cannot see an invocable Action's body at all (audit the Apex
  class with `governor_limit_risks`), and each finding says so — it never claims
  the callee performs DML, and its absence never claims it does not.

### Added

- **`loopBodyCoverage` on every `sfi.flow_bulkification_audit` response** — how
  many Loop bodies were walked, and how many held a Subflow, an invocable
  Action, or a canvas element type the Flow projection does not model. That is
  what turns a zero risk count into a MEASURED zero instead of an unexamined
  one. An unmodeled element inside a loop body is named and downgrades
  `trust.completeness` to `partial` rather than being counted clean.
