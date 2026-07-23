### Added

- `sfi.review_change` — opt-in `checkAccessParity` flag adds an additive
  `accessParity` grant-completeness ("ships for nobody") section: each
  ADDED/MODIFIED CustomField / CustomObject that resolves to ZERO modeled grants
  (no Profile/PermissionSet `grantedBy` conferring FLS/CRUD, no
  ViewAllData/ModifyAllData system-perm holder, and not a standard default-access
  component) is flagged as a candidate feature that would deploy invisible — did
  the release ship the permissions, or was a permission set forgotten? The
  "ships for NOBODY" (zero-grant) direction only; the "ships for everybody"
  breadth (how many users hold a granting permission set) is deferred to the live
  plane (`sfi.live_permset_holders`). Every verdict is stamped with the vault's
  last-refresh time and framed as a candidate to verify, not a proof.

### Changed

- `sfi.review_change` default output is byte-for-byte unchanged — the parity
  section is present only when `checkAccessParity: true` is passed. Router,
  funnel utterances, and the tool description gain access-parity phrasings ("does
  this release ship the permissions", "ships for nobody", "did I forget the
  permission set").
