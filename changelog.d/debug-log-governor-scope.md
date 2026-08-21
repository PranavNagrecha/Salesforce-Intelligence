### Fixed

- **`sfi.explain_debug_log` no longer certifies an Apex class it never looked
  at.** The governor-limit cross-reference called `sfi.governor_limit_risks` in
  ORG-WIDE mode and built its lookup from `data.classes` — a PAGE, capped at 100
  classes — without ever reading `truncated`, `nextOffset`, or `nextCursor`. A
  class named in the log that sorted past that boundary was simply absent from
  the lookup, and the tool then emitted *"The Apex named in the log has no static
  soql/dml-in-loop finding"*: a confident clean verdict produced by not looking.

  Each Apex class or trigger named in the log now gets its OWN scoped
  `governor_limit_risks` query (`componentId`), so a scoped call returns at most
  that one class and there is no page to fall off. It is also cheaper than the
  org-wide scan it replaces — one node fetch per named class instead of a full
  ApexClass + ApexTrigger walk.

  The affirmative itself is now auditable rather than anonymous.
  `governorRiskCrossRef.scannedComponents` names exactly which components the
  scan covered, and the note names them too, so a reader can tell whether the
  class they care about was reached. A named class whose scoped scan cannot run
  is listed in `uncheckedComponents` and described as UNKNOWN — never folded
  into the clean verdict.
