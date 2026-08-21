### Added

- **Salesforce actions modelled as chains (`sfi.action_chain`).** The product
  modelled exactly ONE action as a chain — the record save. Every other action
  was a flat component catalog, and `lifecycle_process` said so itself:
  *"Distinct record ACTIONS — Lead Convert (IsConverted), Approval submission,
  and Activation — are not plain field edits and are not modeled as save-order
  steps."* Its `LIFECYCLE_EVENTS` was only `['insert', 'update']`.

  Covers **Lead Convert** and **Approval**, instantiating the documented
  Salesforce sequence against THIS org's extracted automation. Convert composes
  the save-order engine rather than reimplementing it, so one conversion emits
  four real save orders (Account insert, Contact insert, Opportunity insert,
  Lead update). Approval maps every phase to a real `ApprovalProcess` XML
  element the extractor already lands on the node.

  Honesty is enforced at runtime, not by convention: three typed states with
  mandatory justification, and `familyAbsence()` grounds every "this org has
  none" against `manifest.coverage`, so a family that ERRORED, is PENDING, was
  never REQUESTED, or is `neverModeled` yields *unresolved* rather than a zero.
  "Hook list extracted and empty" is kept distinct from "hook-list property
  absent", so a vault predating the structured extraction cannot read as
  "no actions fire".

  Steps the vault cannot resolve are NAMED, never omitted: `LeadConvertSettings`
  field mapping, the Lead Settings validation-at-convert toggle, per-request
  owner, Apex `Database.convertLead` callers, step-level approval field-update
  targets, and `whenMultipleApprovers`. Flow-invoked convert IS grounded.

  A real-vault probe found the design broken where fixtures said it was fine —
  lead convert at 85,274 bytes and one approval at 214,801 against a 45,000 cap
  — fixed with a documented cheapest-loss-first budget. That budget then
  introduced its own honesty bug, caught in review: per-step guards check each
  surviving STEP, but trimming removes content BETWEEN steps, so a response that
  shed nine whole approval processes could still report `coverage: complete`.
  Omissions now emit structured rows and FORCE `coverage: partial` /
  `absence: not-checked`, because a dropped chain may be exactly the one that
  fires — the surviving steps' cleanliness proves nothing about the action.
