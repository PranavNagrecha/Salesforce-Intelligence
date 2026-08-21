### Added

- **Debug logs are READ now, not name-scraped (`parseApexDebugLog` +
  `sfi.trace_debug_log`).** `sfi.explain_debug_log` regexed class and trigger
  names plus one governor-limit phrase out of pasted text and resolved them to
  graph nodes. Of the four questions people actually open a log to answer —
  what happened when, where the time went, which automation fired in what
  order, what each limit consumed — it answered none. On a 9 KB log with three
  trigger contexts, two validation rules, a workflow evaluation, two flow
  interviews with seven elements, six SOQL spans, two DML spans, a callout, a
  truncation marker and a 13-row limit table, it returned two candidate
  component ids and nothing else.

  `packages/parsers/src/apex-debug-log.ts` is the missing primitive: a debug
  log is a line-oriented EVENT STREAM (`timestamp (nanos)|EVENT|payload`) under
  a header declaring the log LEVEL per category. It becomes a typed, ordered,
  depth-tracked stream plus paired FRAMES — `CODE_UNIT`, `METHOD`,
  `CONSTRUCTOR`, `SOQL`/`SOSL`, `DML`, `CALLOUT`, flow interview, flow element,
  workflow evaluation, validation rule — reconstructed by pairing entry/exit on
  the nanosecond offsets already on every line. Pure function of the text: no
  I/O, no org access, no graph.

  `sfi.trace_debug_log` projects it: the execution timeline; time attribution
  per unit with `soqlMs` / `dmlMs` / `calloutMs` SUBTRACTED so `cpuEstimateMs`
  means CPU and not database wait; hot spots ranked by EXCLUSIVE wall time;
  the automation firing order with each flow's element sequence; consumption by
  phase (before-save triggers / validation rules / after-save triggers /
  workflow rules / flows), where a nested span is attributed to its outermost
  phase so nothing is double counted; and the actual/allowed `pctUsed` table
  straight from `CUMULATIVE_LIMIT_USAGE`, per namespace.

  Honesty is structural here, not a footnote. A log records only the categories
  its DebugLevel enabled, so `capture.notLogged[]` names every category at NONE
  and the events that were therefore never written: the SAME transaction
  captured with `WORKFLOW=NONE` returns zero flows and says
  *"NOT LOGGED … not that nothing of that kind happened"*, and an empty limit
  table under `APEX_PROFILING=NONE` says so rather than reading as zero
  consumption. `componentResolution[].identity` separates three different kinds
  of "no id": `not-in-vault` (looked up, absent — a refresh could close it),
  `not-a-component` (a flow ELEMENT or a `WF_RULE_EVAL` header is never its own
  component in any org — nothing to resolve, ever), and `unresolvable` (the log
  gives only a Salesforce record id, which is never stored offline, so no
  refresh on any org can close it). Flow identity comes from
  `FLOW_START_INTERVIEW_BEGIN`, which carries a MasterLabel rather than an API
  name, so it is matched by exact label and typed `heuristic`, never
  `declared`; a validation rule's object is inferred from the log's sole
  trigger object and typed `heuristic` with the inference stated. Truncation
  (a skipped-bytes marker or the 20 MB ceiling) makes every count a FLOOR, and
  a span that never closed reports a null duration instead of a guessed one.

  How logs are CREATED is answered as a boundary rather than omitted: neither
  `TraceFlag` nor `DebugLevel` is a ComponentType this product extracts, so
  `logCreation` says which users are monitored, which trace flags are live and
  which logs exist are all unknown here, and quotes the platform rules
  explicitly labelled as platform documentation, not readings from the org.

### Fixed

- **`sfi.explain_debug_log` no longer asserts a clean bill from page 1 of a
  paged audit.** It called `governor_limit_risks` with no arguments — which
  returns the FIRST 100 classes plus `truncated` / `nextOffset` — never read
  either flag, and then stated *"The Apex named in the log has no static
  soql/dml-in-loop finding"*. For any class past #100 that affirmative was
  confidently wrong. The cross-reference is now SCOPED per resolved class via
  the audit's own `componentId` argument, so there is no pagination to misread.

- **`sfi.explain_debug_log` reported `unresolvedApex: []` on a log naming a
  class that is not in the vault.** Identifiers were harvested from stack
  frames and `CODE_UNIT_STARTED` units only, so a helper that appears solely as
  a `METHOD_ENTRY` was invisible and its absence read as "everything in this
  log resolved". `METHOD_ENTRY` / `METHOD_EXIT` units are now harvested too
  (leftmost segment, because `Outer.Inner.method()` is one component).

- **A PASTED debug log is no longer refused as unreadable runtime telemetry.**
  The `runtime-analytics` gate fired on "read this debug log …" and returned an
  HONEST GAP disclosure. Fetching a log from the org is still a genuine gap —
  no tool retrieves logs — but reading one the user supplies is now exactly
  what the product does, so that trigger carries an excluder for the pasted-log
  frame (demonstratives, "here's the log", or actual event markers in the
  text). Retrieval phrasings ("pull the debug log from yesterday's batch run")
  still refuse.
