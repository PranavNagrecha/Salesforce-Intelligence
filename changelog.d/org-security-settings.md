### Fixed

- **The org security settings file was on disk and unreadable to the product.**
  The refresh dispatcher matched `Session.settings-meta.xml` — a filename
  Salesforce **never emits** — and the extractor demanded a `<SessionSettings>`
  root that does not exist. Session settings are a NESTED `<sessionSettings>`
  block inside `settings/Security.settings-meta.xml` (root `<SecuritySettings>`),
  so on every org the file fell into the "unknown directory" skip bucket while
  the `SessionSettings` coverage row still read `retrieveConfirmed: true,
  retrieved: 0` and `list_components` said "the last refresh retrieved
  SessionSettings and found none — this is 'none in the org'". That is a
  confirmed-empty claim which is impossible for an org-level singleton. Both
  halves are fixed; `SessionSettings:default` now populates from the real file
  with no retrieval change.

- **`sessionTimeout` is a discrete ENUM STRING, not an integer.** The old
  extractor ran `parseInt` on `FourHours` and stored `null`, so
  `sfi.profile_security` reported `sessionTimeoutMinutes: null` on an org with a
  declared four-hour timeout. The raw enum is now kept verbatim in
  `sessionTimeout`, and `sessionTimeoutMinutes` is this product's OWN mapping,
  labelled by `sessionTimeoutMinutesDerivedFrom`. An enum this build does not
  know maps to `null`, never a guess.

  The two org-wide MFA concept rules (`mfaRequired`, `requiresStrongAuth`) were
  deliberately NOT "fixed" to fire: neither element name appears in a real
  `SecuritySettings` payload, so both properties stay `null` — the honest "not
  declared", not a fabricated `false`. The bug was the coverage claim, not the
  rules.

### Added

- **`SecuritySettings` ComponentType.** One source file now produces TWO
  org-level singletons: `SessionSettings:default` (the nested session block —
  52 leaf keys on a real org, including the four `enableClickjack*` switches,
  which live INSIDE `<sessionSettings>` and not at the top level) and
  `SecuritySettings:default` (password policy, `<networkAccess>` trusted-IP
  windows, single sign-on settings, and every top-level org toggle). Values are
  captured VERBATIM as the Metadata API's enum strings; a nested block no
  extractor reads is reported by name in `unmodeledBlocks` rather than dropped.
  `--types SessionSettings` still reaches the file through the new
  `CO_EMITTED_TYPES` map instead of silently extracting nothing.

- **`sfi.security_settings`.** One call returns every org security setting the
  product can see — `passwordPolicy`, `sessionSecurity` (raw `sessionTimeout`
  enum plus clickjack / CSRF / session-locking / referrer-policy switches),
  `networkAccess.trustedIpRanges[]`, `singleSignOn`, `orgToggles` — AND
  `notCovered[]`, the enumerated machine-readable list of what it CANNOT see.
  Each gap row carries `status` (`not-declared-in-this-org-file` /
  `not-modeled-by-this-build` / `not-metadata` / `not-in-vault`),
  `closableByRefresh`, `reason`, and `whereInstead`. Most rows are COMPUTED, not
  hardcoded: a property that is null because this org's file does not declare
  it, a nested block the extractor walked past, and the sibling
  `*.settings-meta.xml` files counted from the vault's own directory. Login
  history, per-user MFA enforcement, and password-expiry state are listed as
  `not-metadata` — record data no refresh of any depth can reach.

- **Routing.** New deterministic intents `org-security-settings` and
  `org-trusted-ip-security` (the latter ordered ahead of `profile-security`,
  because "Trusted IP Ranges" is the org network-access list while a profile's
  control is "Login IP Ranges"), plus a `FUNNEL_UTTERANCES` block. Every
  profile-scoped phrasing still routes to `sfi.profile_security`.
