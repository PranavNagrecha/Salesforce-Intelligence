### Fixed

- **Host-facing text no longer cites documents this repository does not ship.**
  `ApexQualitySemantics.md` was referenced from 19 sites across 8 production
  files, including the advertised description of `sfi.crud_fls_audit` ("the HIGH
  false-positive rate inherited from ApexQualitySemantics.md §§ 6-7") and a
  disclosure emitted verbatim in `sfi.code_quality_audit`'s `boundaries[]`. A
  host reading either one can quote a section number at a user for a document
  neither of them can ever open.

  The document is not a phantom — it is a real 1201-line spec that lives in the
  frozen build harness, one of 64 vendored `docs/vendor/salesforce-metadata/*.md`
  files the shipped product deliberately excludes, and its "§§ 6-7" is accurate
  (§ 6 `missing-crud-check`, § 7 `missing-fls-check`). Copying those 64 specs
  into the product would publish a second, unbound source of truth for behaviour
  that already has one: the recognizer catalog IS the code. So every citation is
  removed and the substance of each cited section is stated inline next to the
  code that implements it, where it cannot drift.

  The sweep also cleared the other dangling citations that reached a host —
  `Formula.md`, `WhatIfSemantics.md`, `SemanticSearchSemantics.md`,
  `SnapshotSemantics.md`, `AsyncTopologySemantics.md` — from tool descriptions,
  emitted disclosures, and the shipped skills.

### Added

- **A guard test on the invariant**: no advertised tool description may cite a
  `.md` that does not ship in this repository, plus a targeted regression pin on
  the `ApexQualitySemantics` citation. Verified fail-before / pass-after.

### Known limitation

- Internal JSDoc still carries roughly fifty citations to the other vendored
  specs (`WhatIfSemantics.md`, `ConditionalContextSemantics.md`,
  `SemanticSearchSemantics.md`, the per-type `*.md` reference pages, and the
  `PLAN-v*.md` build docs). Those are developer comments inside the repo and
  mislead nobody outside it, so the guard deliberately does not assert on them.
  Recorded as a larger cleanup, not done here.
