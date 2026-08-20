### Added

- **Reports and Dashboards are first-class graph nodes
  (REPORT-DASHBOARD-GRAPH-PERSISTENCE).** The refresh used to parse every
  Report and Dashboard — filters, boolean logic, groupings, buckets,
  cross-filters, charts — and then DELETE the nodes and edges, keeping only
  `usedInReport` / `usedInDashboard` booleans plus at most 50 report names per
  field. On a real org that collapsed 4,277 reports and 81 dashboards into a
  handful of retained names, so "what does this dashboard depend on?" and
  "which report type feeds this report?" were structurally unanswerable. Those
  nodes now persist as `Report:{LeafFolder}/{DeveloperName}` and
  `Dashboard:{LeafFolder}/{DeveloperName}` — one folder segment, the LEAF,
  which is the identity the retrieve `<members>` list and a dashboard's
  `<report>` reference both use however deep the retrieved folder tree is.
  (Qualifying by folder at all closes a real primary-key collision: the bare
  DeveloperName is not guaranteed unique across folders, so a second import row
  would silently overwrite the first.) They carry the parsed structure plus new
  DECLARED `references` edges: report -> its source object or custom report
  type, and dashboard -> each of its component reports. `list_components({
  type: 'Report' })`, `get_component`, and `get_edges` now answer on a report
  or dashboard id.

### Changed

- **Report / Dashboard field usage stays a folded node PROPERTY, not an edge.**
  Measured at real-org scale (4,277 reports), analytics -> `CustomField`
  reference edges were 64,155 of 68,513 persisted rows — 94% — costing roughly
  +20 MB of DuckDB and +90 s of import for an answer the folded
  `usedInReports` / `usedInDashboards` list already gives over EVERY extracted
  report. They are deliberately not persisted, so every existing consumer
  (`safe_to_delete_field`, `field_360`, `field_lineage`, `unused_fields_deep`,
  `find_dead_code`, `find_field_anywhere`, `get_impact`) reads exactly the
  signal it read before, unchanged. Measured marginal cost of what does ship:
  +1.8 MB DuckDB / +1.4 MB Markdown / +1.5 s import on a DEFAULT refresh
  (top-500 usage-ranked pull), and +3.4 MB / +11.4 MB / +46 s on an uncapped
  `--with-reports` pull of 4,277 reports.
- **A capped node capture discloses itself.** `SFI_REPORT_NODE_CAP` (default
  5,000 per type — a blow-up guard set above observed real-org scale, not an
  operating point; `0` restores the previous no-node behaviour) bounds how many
  Report / Dashboard nodes persist. When it bites, the manifest carries a
  `reportNodeCap` block, the refresh summary prints an explicit WARNING naming
  the shortfall, and those coverage rows go `pending` — so every tool that asks
  "were reports fully covered?" keeps hedging its absence claims. The folded
  field usage is computed BEFORE the cap, so the cap costs navigability, never
  usage recall.

### Security

- **Report and dashboard freeform text never reaches the graph or the rendered
  Markdown.** (Scoped deliberately: `org-kb/source/` still holds the raw
  retrieved `.report-meta.xml` / `.dashboard-meta.xml`, descriptions and
  `<runningUser>` included, and `sfi vault git enable` auto-commits that tree.
  That is pre-existing behaviour of the source mirror, not something this
  change introduces or fixes — but "never reaches the vault" would be false,
  so the claim is scoped to the surfaces this change actually controls.)
  Persisted
  Report / Dashboard properties pass an explicit ALLOW-LIST
  (`PERSISTED_REPORT_PROPERTY_KEYS` / `PERSISTED_DASHBOARD_PROPERTY_KEYS`) with
  per-item allow-lists on every nested list, so a key that is not named cannot
  persist. Filter `<value>` literals (a customer name, an email, an amount)
  remain reduced to a `hasValue` boolean; bucket bin boundaries and admin-typed
  bucket labels are dropped; `<description>` is captured as a
  `descriptionPresent` boolean instead of its text (so `list_components({
  missingDescription: true })` stays truthful without vaulting the prose); and
  a dashboard's `<runningUser>` — a real org username — is never read at all.
