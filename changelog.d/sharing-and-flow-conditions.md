### Fixed

- **`sfi.explain_apex_method` reported the wrong sharing model for every class
  that declares one.** The extractor splits an Apex class header into
  `properties.modifiers` (access / abstract / virtual) and
  `properties.sharingModel` (the sharing keyword) — the keyword is NOT in
  `modifiers`. The tool read only `modifiers`, so a
  `public without sharing class` came back as `modifiers: ["public"]`,
  `declared: null`, `effectiveModel: "inherits-caller"` with a note explaining
  that a no-keyword class inherits its caller's context — about a class that
  declares a keyword. Measured on two real vaults: **60 of 190** classes (9
  `without sharing`, 46 `with sharing`, 5 `inherited sharing`) and **57 of 186**
  classes (8 / 48 / 1) got a false verdict; after the fix, **0**. The
  `without sharing` classes are the security-relevant direction — a reviewer
  auditing sharing bypass was told the class inherits the caller's context when
  it does not. `sfi.apex_structure` read the same declaration correctly, so the
  two tools contradicted each other on every one of those classes; they now
  agree on all 376.

  Two related answers came with it. An **ApexTrigger** now gets the trigger
  answer (`effectiveModel: 'system-context'`, `sharingSource:
  'trigger-system-context'`) instead of `inherits-caller`: a trigger cannot
  declare the keyword and the platform runs it in system context, so it is
  never told it inherits a caller it does not have. And a node carrying
  NEITHER `sharingModel` nor a keyword-bearing `modifiers` now reports the
  third state `effectiveModel: 'not-read'` (with `runsAsSystem: null` when the
  async classifiers are absent too) rather than asserting `inherits-caller` —
  a `without sharing` class on such a node presents identically, so no
  enforcement model is asserted. Both states use `sfi.apex_structure`'s
  existing vocabulary.

- **`sfi.explain_flow` reported a flow's DECISION rules as its entry
  criteria.** `triggerInfo.conditions` dumped every `firesWhen`
  ConditionalContext into the answer to "when does this flow run?", and
  `decisions` dumped the same set back out — so a record-triggered flow whose
  `<start>` names ONE field returned SIX entry conditions (five of them
  decision branches from elsewhere in the flow), and its record-trigger
  criterion appeared in the decision list under a synthetic `condition-N`
  name. On another flow the reported entry criteria omitted a field the
  `<start>` block filters on and named one it does not mention. The graph has
  always separated the two on `ConditionalContext.properties.kind`
  (`flow-recordtrigger` vs `flow-decision`); nothing read it. Entry criteria
  now come only from `flow-recordtrigger` contexts and decisions only from
  `flow-decision` ones. Across two vaults the trigger axis dropped from
  584 → 55 and 769 → 217 rows, every one of the 160 filter-based sets matching
  `sfi.flow_graph`'s `start.filters` exactly.

  Absences are now readable rather than empty. `triggerInfo.conditionsState`
  distinguishes `entry-criteria`, `not-applicable` (not a record-triggered
  flow — a CHECKED zero), `not-determined` (record-triggered but the vault
  holds no record-trigger context, so the empty list must NOT be read as "runs
  on every save"), and `unclassified` (a context carries no `kind`, so the two
  could not be separated — those rows are surfaced verbatim in
  `unclassifiedConditions` rather than guessed into either list).
  `conditionsNote` states the reason and a `coverageCaveat` attaches, merging
  every condition-axis gap so one never hides another.

### Changed

- **`sfi.explain_flow` decision rows no longer invent a name.**
  `decisionName` was falling back to the synthetic ConditionalContext id
  (`Flow:X.condition-0`) — a graph handle, not a name the flow author would
  recognise — which made an unrecorded name indistinguishable from a recorded
  one. It is now `string | null`, the handle moved to its own
  `conditionContextId` field, and a `coverageCaveat` names how many decisions
  are unnamed and why. On a vault whose builder records `sourceName`, 487 of
  497 decision names match `sfi.flow_graph`'s `<decisions><rules>` names.
