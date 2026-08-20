### Added

- **Platform access oracle (`sfi.live_access_oracle`).** Proves the offline
  permission engine right or wrong instead of asking you to trust it. Asks
  Salesforce for its OWN verdict on a user's per-object access (Tooling API
  `UserEntityAccess`) and diffs it against what `sfi.effective_permissions`
  computes offline, per object per verb: **AGREE**, **OFFLINE UNDERSTATES**
  (the known bug class — `computeEffectiveGrants` never expands permission
  dependencies, and blanket ViewAllData/ModifyAllData is invisible to
  per-object grant edges), **OFFLINE OVERSTATES** (the dangerous direction,
  listed explicitly and never folded into a count), and **UNKNOWN** with a
  named reason. Live plane, `users` scope, per-session query budget honoured.
  The offline path is untouched and still answers with no org connection.

  The verb mapping is deliberately incomplete and says so:
  `read`/`create`/`edit`/`delete` map 1:1 to
  `IsReadable`/`IsCreatable`/`IsEditable`/`IsDeletable`, while `undelete` and
  `IsFlsUpdatable` have no offline equivalent and `viewAllRecords`/
  `modifyAllRecords` have no platform column — all four stay UNKNOWN rather
  than being mapped onto a near-miss flag to make the diff look clean.
  `UserEntityAccess` cannot be paged, so every call is a bounded spot-check of
  caller-named objects; an object not named — or named but returned with no
  row — is "not checked"/"not answered", never "no access".

- **Profile Id ↔ API-name map, built at refresh.** SOQL exposes a `ProfileId`
  and a mutable profile LABEL; every offline surface keys Profile nodes by the
  metadata API name, which SOQL never returns, and nothing bridged them.
  `sfi refresh` now joins `sf org list metadata -m Profile` (`fullName` = API
  name) against `SELECT Id, Name FROM Profile` on the 15-char Id and persists
  the result in the vault (gitignored). `sfi refresh --no-pull` makes neither
  org call.

  **Resolution is keyed on `ProfileId`, never on the label.** Labels are mutable
  and re-usable: rename a profile between refreshes, or free a label and
  re-apply it to a different profile, and a label-keyed lookup silently resolves
  to the WRONG profile — diffing a user against a container bundle that is not
  theirs and reporting it as a permission finding, indistinguishable from a real
  one. `ProfileId` is stable, always populated, and free (the `Profile.Name`
  traversal already walks it). The label is kept as a human echo and as a
  cross-check: a profile renamed since the refresh still resolves and the rename
  is disclosed via `labelChangedSinceRefresh`.

  Everything fails closed. An absent map is never treated as an empty one; a
  missing `ProfileId`, an unknown id, or a corrupt artifact all produce a loud,
  actionable `invalid-query` naming `profileId` as the escape hatch. There is no
  name-match fallback anywhere.

  The join defends itself rather than assuming. A row carrying a name but no Id
  (the documented `listMetadata` empty-`id` quirk, whose effect on STANDARD
  profiles is unverified) is DISCLOSED as unjoinable rather than silently
  skipped, and one Id arriving with two conflicting names — which a 15-char
  truncation should not be able to produce, but could if a source ever
  case-folded an Id — is detected, excluded, and disclosed. Both make the
  affected profiles unresolvable, which fails closed. The SOQL half is retained
  even though resolution no longer needs the label, because it is what makes the
  gap countable. The whole mechanism sits behind ONE function
  (`bridgeProfileToApiName`) so it can be replaced without touching the tool.

### Changed

- **`objectPermissions` flag vocabulary moved to `@sf-intelligence/contracts`**
  as `OBJECT_PERMISSION_FLAGS`. It is Salesforce platform vocabulary, not MCP
  vocabulary, and it had drifted into two byte-identical private copies —
  `OBJECT_FLAGS` (the max-wins union) and `MUTING_OBJECT_FLAGS` (the muting
  subtractor). Both now alias the single list, so the union and the
  subtraction cannot iterate different flags. Existing import paths are
  unchanged.

- **CLI bundle size ceiling raised 5,750,000 → 5,900,000 bytes.** The soft
  backstop had run down to ~9.6 KB of headroom, so the next tool added would
  have tripped it regardless of content. The precise grammar-re-inline guard
  (`MAX_ANTLR_REFS`) is untouched and still reports 5 of an allowed 80.
