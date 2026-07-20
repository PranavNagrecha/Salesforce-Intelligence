### Added
- **`sfi.flow_graph` — lossless structural projection of a Flow.** Returns every
  element by its real name, the full connector graph (from -> to -> kind: default,
  rule, fault, loop next-value/no-more-values, scheduled path, go-to), decision
  rules, assignment items, formula expressions, variable declarations, record-op
  filters, and the `<start>` element including scheduled paths. No inference, no
  summarization — honest gaps surface in `unmodeled[]` rather than being dropped
  silently. Accepts a Flow ID *or* API Name through a shared resolver that fails
  closed (rather than guessing) when given a bare 15/18-char record id without an
  id-to-API-name index.
- **`sfi.flow_trace` — walks a Flow's declared logic over a caller-supplied
  record-value map.** Evaluates decisions, assignments, formulas, and
  loops-over-supplied-collections, returning the executed path and the field
  writes it performs. Every un-evaluable node (Apex actions, subflows, callouts,
  dynamic references) is marked `unevaluated` with a reason rather than simulated
  or guessed — this is a projection of declared logic, not a Flow execution engine.
- **Roster: +2 MCP tools.** Advertised roster grows from 196 to **198**; registered
  roster (advertised + hidden back-compat aliases) grows from 200 to **202**.

### Changed
- `sfi.explain_flow` now cross-references `sfi.flow_graph` for full connector-level
  structure and drops its prior false-completeness footer; it keeps its own
  narrative role and removes no routing.
