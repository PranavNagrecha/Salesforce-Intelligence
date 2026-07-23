### Fixed
- ApprovalProcess extractor: a name-less `userHierarchyField` step approver now
  resolves the custom hierarchy field designated at
  `<nextAutomatedApprover><userHierarchyField>` (a user-lookup field on `User`,
  e.g. an `*_Approver__c` field) instead of dropping it as the implicit standard
  Manager. The approver summary carries the field API name (was `{ name: null }`)
  and a `User`-scoped `references` edge to the `CustomField` is emitted
  (`CustomField:User.{field}`, `viaNextAutomatedApprover: true`, `declared`) so
  the "who approves" reference is no longer silently lost. The built-in standard
  `Manager` field (and an absent `<nextAutomatedApprover>`) stays the edgeless
  implicit-Manager approver.
