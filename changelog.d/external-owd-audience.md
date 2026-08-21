### Fixed

- **`sfi.why_cant_user_see_record` evaluated the INTERNAL org-wide default for
  EXTERNAL users.** Salesforce keeps two OWD columns per object —
  `sharingModel` for internal users, `externalSharingModel` for Experience Cloud
  / portal / guest users — and applies them to disjoint audiences. The OWD stage
  ranked only the internal column, so on any object whose internal OWD outranks
  its external one a community profile holding object Read short-circuited the
  cascade to a confident `visible`. On the probe org 40 objects rank internal
  strictly above external (34× `ReadWrite`|`Private`, 3× `Read`|`Private`, plus
  `ReadWriteTransfer`|`Private`, `FullAccess`|`Private` and `ReadWrite`|`Read`),
  and profiles on a Customer Community Login and a Guest User licence hold
  object Read on several of them — a wrong "yes, they can see it" in a security
  answer.

  The OWD stage is now audience-aware. It resolves the supplied profile's
  `userLicense` and, for an EXTERNAL licence, ranks `externalSharingModel`; the
  internal column is not consulted for that user at all, and an absent or
  unrecognised external value is `unknown` rather than a fallback to internal.
  When the audience cannot be established — no profile supplied, the profile is
  not in the vault, it carries no `userLicense`, or the licence name is not one
  this build classifies — the stage is `unknown` and names what each column
  would have given, instead of presenting a coin flip as a fact. That `unknown`
  does NOT truncate the cascade the way a no-OWD entity variant does: every
  later stage is still evaluated, because a View All Data bypass is
  audience-independent.

  Materiality is the gate, so nothing else moves: when the two columns would
  give the same verdict for the requested operation — or the object declares no
  external column — the internal path runs and the response is byte-identical,
  reason string included.

### Added

- **`sfi.why_cant_user_see_record` discloses the external-OWD assumption.** Any
  verdict that consulted or weighed the external column now states that the org
  switch putting that column in force
  (`SharingSettings.enableExternalSharingModel`) was ASSUMED, not checked — it
  is retrieved into the vault's `settings/` container but not parsed by this
  build. Purely internal answers carry no such note.
