### Fixed

- **`sfi.guest_exposure_report` dropped unattributable guest sharing rules in
  silence.** A guest rule is matched to a community against a three-key name set
  — the CustomSite api name, the site label, and any modeled Network api name.
  A rule matching none of them, or declaring no `siteName` at all, was discarded
  with no finding, no bucket and no disclosure, while the mirror case (a Network
  naming a CustomSite this vault does not model) already emitted an
  `orphanNetworks` disclosure. A guest sharing rule is a declared record-level
  grant to unauthenticated visitors; dropping one quietly is the worst place in
  the tool to conflate "checked and found nothing" with "did not check".

  Unattributed rules now land in an `orphanGuestRules` bucket — rule id, declared
  `siteName` (or null), object, and `accessLevel` — with a disclosure modelled on
  `orphanNetworks` that states plainly they are NOT counted in any community's
  `findingCount` and that their absence from `findings` must never be read as "no
  exposure". The bucket honours the object scope exactly as `findings` do, and is
  present only when non-empty, so a vault whose every guest rule matched is
  unchanged.

  Two paths that still dropped every rule are closed with it. The SharingRule
  scan now runs ABOVE the fail-closed "no Experience Cloud surface in the vault"
  return, so a vault holding guest rules but no CustomSite/Network node — exactly
  the "vault predates the Experience Cloud extraction" case that return's own
  disclosure names — reports each rule as an orphan instead of answering
  `findings: []` with no bucket at all. And the bucket is emitted under a
  `communityId` scope too: an unattributable rule belongs to NO community, so it
  may well belong to the scoped one (a site-label mismatch is exactly how a rule
  becomes unattributable), and suppressing it restored full silence for the rules
  most likely to be in scope. Those rules stay OUT of `findings` and out of the
  community's `findingCount`, and the scoped disclosure says so. Attribution is
  now judged against every modeled community rather than the scoped subset, so
  another community's rule is never reported as a false orphan.

  The bucket pages on its OWN axis. It shipped with no cap and no marker: on a
  synthetic vault holding 600 guest sharing rules and no community surface it
  emitted 500 rows plus a 28,463-character disclosure naming every id, ~102 KB
  against a 40 KB response budget. The global envelope guard then tail-trimmed
  the array to 62 rows while the disclosure still claimed all 500 were "listed in
  `orphanGuestRules`", and the dropped grants were unreachable from any call —
  `limit`/`offset` page `findings`, not this bucket. Now the bucket is capped per
  response, the disclosure names N of M explicitly with a capped id sample, an
  `orphanGuestRulesPage` marker carries `totalCount` / `returnedCount` /
  `offset` / `hasMore` / `nextOffset`, and a new `orphanOffset` input walks the
  bucket to its end. The orphan rows are also charged against the `findings`
  byte budget, so the two lists share one envelope without inviting the guard to
  trim either. Same vault, same call: ~9 KB, no guard truncation, counts and rows
  in agreement.

  A Network the vault holds is attributable even when its CustomSite is not.
  Network keys were collected by walking modeled sites, so a Network whose
  `<site>` names an unmodeled CustomSite contributed no key — and a guest rule
  declaring that Network was reported as matching "no ... Network api name in
  this vault" in the same payload that named it under "N Network(s) reference a
  CustomSite not modeled in this vault". Every modeled Network api name is now a
  key. The remedy text follows the evidence too: when the response already names
  Networks whose CustomSite is missing, it points at that retrieve gap instead of
  sending the operator to confirm each rule's site in Setup.

  Note for anyone re-verifying: the probe org cannot exercise these paths — it
  holds 31 SharingRule nodes and all 31 are `criteria` rules, zero guest rules —
  so the behaviour is proved on synthetic vaults built with the real refresh
  pipeline (`sfi refresh --no-pull`) and driven through the shipped MCP server,
  as well as in unit tests.
