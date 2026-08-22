### Fixed

- **Four tools reported Apex types as Salesforce fields.** The Apex scanner keys
  its `readsFrom` / `writesTo` edges on the TEXTUAL receiver, and the shared
  guard in `apex-receiver.ts` split that receiver lexically and verified nothing
  against the graph. It caught a lowercase local (`acc.Status__c`) and an Apex
  `this`/`super` member and nothing else — so any receiver that merely LOOKED
  like an SObject (`PascalCase`, `Thing__c`, `ns__Thing__c`) was emitted as a
  real component id no matter what it named. An Apex class, an inner DTO, a
  `__r` relationship traversal and a describe token (`Contact.fields`) all
  reached resolved object / field lists, some at `parsed` confidence — the top
  tier — naming components that do not exist. Measured on one real 129-object
  vault: 13.8% of emitted object rows and 16.9% of emitted field rows were not
  Salesforce components, and 172 of the bad rows carried `confidence: "parsed"`.

  Verification now lives in `apex-receiver.ts`, where the split does: ONE
  batched `listNodesByIds` answers what each receiver token IS (`sobject` /
  `apex-type` / `not-in-vault`), and a target is claimed ONLY when its receiver
  names an SObject node in the vault. Everything else is a RAW TOKEN with a
  typed reason — `unresolved-receiver`, `apex-type-receiver`,
  `relationship-traversal`, `describe-token`, `receiver-not-in-vault` — the same
  vocabulary `sfi.apex_structure` emits, shared rather than restated so the two
  cannot drift. A demoted row is never dropped silently, and a FAILED
  verification query is reported as `checked: false` with a stated reason and a
  sixth `receiver-not-verified` tier: it never falls back to the lexical guess,
  because that fallback is the defect.

  Per tool:

  - `sfi.explain_apex_method` — `fieldAccess` claims only verified fields;
    demotions land in `unresolvedFieldAccess` with a parallel
    `unresolvedFieldAccessReasons`, and a `receiverVerification` block whose
    `demoted` census makes an empty list read as CHECKED rather than unchecked.
    On one real class, `fieldAccess` fell from 18 rows (14 of them not
    components) to 4 verified rows.
  - `sfi.what_happens_on_save` / `sfi.order_of_execution` — the artifacts these
    used to `continue` past in `buildActions` are now DECIDED once per
    composition against the vault and DISCLOSED: each losing step carries
    `unresolvedActionsOmitted`, and one response-level `receiverVerification`
    carries the raw tokens plus the complete per-reason census. The lexical
    local-variable `callsApex` / `dispatchesAsync` drop is surfaced there too,
    instead of deleting rows with no trace. One batched query per composition,
    so the pinned "query count does not scale with object fan-out" budget is
    unchanged.
  - `sfi.get_impact` — a `CustomField:` root has its receiver checked before the
    walk. A receiver that names an Apex class/trigger node here, or a describe
    token, is refused as `invalid-query` naming what it actually is; previously
    such an id answered with a dependent slice and the disclosure called the
    missing definition "a PHANTOM … typically a standard or managed-package
    component" while an `ApexClass` node of that exact name sat in the vault. A
    receiver nothing here names, and a `__r` traversal, still ANSWER —
    `receiver-not-in-vault` genuinely mixes an unretrieved standard SObject with
    an Apex system type and nothing in the vault separates them — but
    `rootReceiverVerification` and the disclosure say the id is not a confirmed
    field, so the referrers read as "what references this token", never as "what
    breaks if you change this field".

  Honesty over recall throughout: a receiver the vault does not carry is named
  as unresolved rather than claimed, which is a deliberate recall cost on
  standard objects a refresh never retrieved.
