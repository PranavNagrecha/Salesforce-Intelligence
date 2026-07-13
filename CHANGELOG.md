# Changelog

All notable changes to **sf-intelligence** are documented here. This project
adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.2.0] — 2026-07-12

> **Tool roster — the integrated totals.** 0.2.0 adds **24 new MCP tools**,
> taking the roster from 176 advertised tools in 0.1.26 to **200 registered /
> 196 advertised**: 4 pre-existing tools (`sfi.field_cleanup_candidates`,
> `sfi.release_readiness_report`, `sfi.find_apex_usages`, `sfi.churn`) were
> retired into hidden back-compat aliases — each folded into a surviving tool,
> still dispatchable by name, but no longer occupying a `tools/list` schema
> slot. Any per-entry running tool count below reflects the parallel branch it
> was written on, not the integrated release; these totals are authoritative.

### Added
- **R7-F1 — Changelog fragment workflow.** Introduces `changelog.d/` for per-item
  Keep-a-Changelog fragments. `scripts/assemble-changelog.mjs` merges all fragments
  into `CHANGELOG.md` under `[Unreleased]` idempotently; `scripts/check-changelog-fragments.mjs`
  fails CI when a `packages/**` or `scripts/**` diff ships without a matching fragment.
  Wired as `pnpm changelog:assemble` / `pnpm changelog:check`; enforced in the QA
  commit-gate as `ci:changelog-fragments` (fast + full).
- **`sfi.generate_fleet_report` — the "state of my orgs" digest across every registered vault (R7-C6).**
  A single `GeneratedDocument` composed from the existing fleet/pulse tools instead of a new analysis:
  per-vault manifest facts (component counts, product version, source org, last-refresh timestamp) via
  `@sf-intelligence/vault`'s `listRegisteredVaults` + `loadManifest` (the same registry read
  `sfi.fleet_find` / `sfi.fleet_drift_ranking` use), and a per-vault "org-pulse digest" (freshness
  coverage % + top contributor) reusing `@sf-intelligence/graph`'s `freshnessSummary` /
  `contributorsSummary` — the exact functions `sfi.org_pulse` calls — against each OTHER vault's graph
  store opened read-only via the same `openVaultReadOnly` helper `sfi.compare_vaults` uses. A
  fleet-level Executive Summary names the total component count and which vault is "most behind" (an
  OFFLINE age proxy — oldest `refreshedAt`, with a never-refreshed/unreadable vault ranked worst of
  all) plus a Notable Divergences section (extractor-version splits, generalizing `sfi.compare_vaults`'s
  pairwise `extractorVersionCaveat` to the whole fleet; component-count spread). Optional `limit`
  (1..25, default 10) caps how many registered vaults get the graph-opening pulse digest — the
  manifest-level Per-Org Inventory always covers every registered vault regardless. LIVE DRIFT IS
  SKIPPED, NEVER SILENTLY SUBSTITUTED: the tool takes no org/consent arguments and makes no
  Tooling-API calls; a dedicated Live Drift section discloses the skip and points at
  `sfi.fleet_drift_ranking` (per-org consent) for the real live comparison. Fails closed with zero
  registered vaults (a document saying so, never a fabricated "fleet is healthy"); a vault whose
  manifest is unreadable, or whose graph store can't be opened for the pulse digest, is disclosed by
  name, never dropped silently. Registered end to end: descriptor + JSON schema + dispatch case
  (`tools/index.ts` — one of the 24 tools new in 0.2.0; see the roster note at
  the top of this release), the `docs` capability category, a varied funnel-utterance
  corpus, and a regenerated embedding index (only the new tool's vector added, existing vectors
  re-synced to current descriptions). Follows the sibling `sfi.fleet_find` precedent of shipping
  without a dedicated deterministic-router regex intent — its phrasing overlaps
  `fleet_drift_ranking` / `generate_architecture_overview` too closely to hand-tune safely without
  the eval harness — reachable instead via the semantic funnel and `sfi.capabilities`. It stays
  grandfathered in the router↔roster CI contract: the R7-W6 router-v2 pass (below) wired 9 other
  deferred tools but deliberately left this one un-routed pending eval-harness-informed tuning.

- **`sfi.query_graph` — advanced, guard-railed graph query surface (R7-C4).**
  A new power-user MCP tool that answers ad-hoc questions the purpose-built
  tools do not expose, WITHOUT accepting raw SQL. The caller supplies a
  STRUCTURED query — `select` (`'nodes'` | `'edges'`), an optional `where`
  list of `{ column, op, value }` conditions (AND-ed), and an optional
  `limit` — which the graph layer (`@sf-intelligence/graph`'s
  `compileGraphQuery` / `runGraphQuery`) compiles into a single allowlisted,
  parameterized, SELECT-only statement:
  - **Columns** are a fixed per-table allowlist (nodes: `id`, `type`,
    `apiName`, `label`, `parentId`, `sourcePath`, `lastModifiedDate`,
    `lastModifiedBy`, `apiVersion`; edges: `fromId`, `toId`, `edgeType`,
    `confidence`, `source`) plus `property:<key>` JSON access through the
    same BOUND `json_extract_string(properties_json, ?)` idiom the rest of
    the query layer uses (the `<key>` validated to a bare identifier). A
    caller-supplied column name never reaches the SQL as text.
  - **Operators** are a fixed allowlist (`=`, `!=`, `LIKE`, `ILIKE`, `IN`
    (array, ≤50 values), `IS NULL`, `IS NOT NULL`) — each yields a hardcoded
    SQL fragment; user text never becomes an operator.
  - **Every value is a BOUND parameter**, never interpolated. An injection
    payload aimed at a value (`'; DROP TABLE nodes; --`, `1 OR 1=1`,
    `UNION SELECT …`, `ATTACH …`) is bound as an inert literal that matches
    no row; one aimed at a column/operator is rejected fail-closed with the
    allowlist named. The statement is always a single `SELECT` with a fixed
    `ORDER BY` and a hard-capped bound `LIMIT` (default 50, max 500) — no
    DDL/DML/PRAGMA/ATTACH/COPY, no semicolon, no second statement — and runs
    on the server's READ-ONLY graph handle (`access_mode: READ_ONLY`), so
    even a hypothetical escape could not write.
  - **Honest output:** the response echoes the exact compiled SQL + bound
    values (so the caller sees what ran) and carries a `disclosure` that this
    is a RAW graph view — ids/edges exactly as stored, per-edge `confidence`,
    NO synthesis/grounding/coverage reconciliation, and an absent row on a
    partially-refreshed vault is not proof the org lacks it. Output is
    byte-budgeted (fat node properties slimmed to an `{__omitted}` marker,
    rows tail-trimmed) so a wide result cannot trip the MCP response limit.
    Advertised in the `find` capability category and reachable via the
    hybrid-mode semantic funnel; a deterministic regex route is deliberately
    absent (it would steal phrasings from the grounded `get_edges` /
    `list_components`) — the R7-W6 router-v2 pass kept it grandfathered as a
    power-user escape hatch, not a primary answer to any natural question.
    One of the 24 tools new in 0.2.0 (see the roster note at the top of this
    release).

- **Cross-vault deploy review — `sfi.review_change` `againstVault` /
  `sfi review-change --against <alias|path>` (R7-C2).** The release-manager
  question the default review could not answer: *"will this changeset break
  anything in PROD?"* — the impact must be computed against prod's dependency
  graph, not the sandbox's. `review_change` gains an optional `againstVault` (a
  registered vault alias OR a path to an `org-kb`); the CLI gains `--against`.
  When supplied, the tool opens that vault READ-ONLY via the existing
  cross-vault machinery (`openVaultReadOnly`, the same helper `compare_vaults`
  uses — never a second writer lock) and computes EVERY signal — dependents,
  verdict, selected tests, coverage caveat — against ITS graph. Composes R6-16
  (review_change) with R6-12 (cross-vault registry + extractor-version caveat).
  New disclosures, all absent in the default path (which stays byte-for-byte
  unchanged): a prominent `disclosure` prefix + `againstVault` field naming the
  target and its last refresh ("impact is against that vault, NOT the current
  one"); `absentInAgainstVault` — changeset ids labelled modified/deleted that
  are ABSENT from the target (relative to it they would be ADDED, so nothing
  there depends on them, and their OWN forward references are not analysed); and
  `extractorVersionCaveat` when the two vaults' product versions differ (a
  verdict difference may reflect an EXTRACTOR change, not a real org difference).
  The CLI keeps the exit-1 CI-gate semantics — now blocking on breakage in the
  NAMED vault. `sfi.route_question` continues to route "review this deploy
  against prod" / "will my changeset break production" / "cross-vault deploy
  review" to `review_change`.

- **`edgeDrift` axis wired into `sfi.compare_object_across_vaults` (R7-W10).**
  R6-12 added the `edgeDrift` axis (outgoing-edge-set diff, capped, with an
  `extractorVersionCaveat` when the two vaults' product versions differ) to
  `sfi.compare_vaults` but explicitly left `sfi.compare_object_across_vaults`
  out — a separate diff code path. This closes that follow-up: the object
  node itself (when present in both vaults) plus every field paired by
  api-name (present in both vaults, independent of whether its own
  properties matched) now gets the SAME `edgesAdded[]` / `edgesRemoved[]`
  treatment, same comparison identity (`edgeType` + `toId` + `referenceKind`
  when present), same caps (200 components / 50 rows), same
  `extractorVersionCaveat` discipline. The diff primitive itself is REUSED,
  not re-implemented: `EdgeDiffEntry` / `ComponentEdgeDrift` / `EdgeDriftOutput`,
  `loadEdgesByFrom`, `buildEdgeDrift`, and `buildExtractorVersionCaveat` were
  extracted from `compare-vaults.ts` into a new shared
  `packages/mcp/src/tools/cross-vault-edge-drift.ts` module — `compare-vaults.ts`
  now imports from it too (zero observable behavior change; its full 26-test
  suite passes unchanged, confirming the extraction is byte-for-byte
  equivalent). New response fields: `edgeDrift` (always present) and
  `extractorVersionCaveat` (present only on a version mismatch). New
  `boundaries[]` entry: the edge-drift scope disclosure. `architect-cross-org-compare`
  skill and the tool description updated; the stale "does NOT share this axis
  yet" note removed from `sfi.compare_vaults`'s own description.

- **`sfi.history_tracking_gaps` — field-history-tracking compliance audit
  (R7-W7).** "Which sensitive fields have no field-history tracking enabled?"
  — a pure composition over the SAME classification engine that backs
  `sfi.pii_inventory` (regulated-data recognizer over CustomField API name /
  data type / description) with the extractors' own declared `trackHistory`
  (CustomField) / `enableHistory` (CustomObject) booleans — no new
  extraction, no live org read. Enumerates every CustomField (optionally
  scoped to one `objectApiName`), classifies each `pii` / `sensitive` /
  `public`, and flags a GAP: a regulated field whose declared `trackHistory`
  is `false` or absent. Every gap additionally names whether its PARENT
  OBJECT has history enabled at all — `enableHistory: false` means NO field
  on it can be tracked, so that case is a DISTINCT, higher-severity
  `gapKind: 'object-history-disabled'` (severity `critical`) finding rather
  than an indistinguishable `field-not-tracked` (severity `high`) one.
  Results are GROUPED by object (`groups[]`), each carrying a real
  `CustomObject:` node id, `objectModeled`, and `objectHistoryEnabled`
  (`true` / `false` / `null` when the object's own metadata was never
  retrieved — UNKNOWN, never assumed). **Honesty axis:** the regulated-data
  classification is HEURISTIC (same shape as `pii_inventory`'s); the
  `trackHistory` / `enableHistory` readout is DECLARED (read verbatim, not
  inferred); Salesforce does not support history tracking on every field
  type regardless of the declared flags (formula fields hold no stored
  value; some platform system/audit fields are never trackable) — such
  fields can still appear in `gaps`, flagged via `isFormula` / `isSystem` so
  the caller can filter rather than being silently dropped. Fails soft on an
  object with zero fields or an unmodeled object (empty `groups`, no error).
  `limit` (default 200, max 500) + `offset`/`cursor` CR-22 continuation
  paginate the flattened field set with a ~45 KB byte-budget trim, mirroring
  `pii_inventory` exactly. Registered in the `govern` capability category and
  the funnel utterance corpus (surgical embedding-index append — the
  quantized ONNX model is not bit-stable, so a full regeneration would
  perturb every unrelated vector); deterministic-router wiring remains
  deferred — its phrasing ("history tracking", "audit trail", "compliance
  gap") overlaps the vocabulary the regex router already routes toward
  `sfi.pii_inventory`, so the R7-W6 router-v2 pass (below) deliberately kept
  it grandfathered pending eval-harness-informed tuning, even as that pass
  wired `automation_collisions` and 8 other previously-deferred tools.


- **Deterministic router intents for 8 grandfathered R6/R6B tools (R7-W6).**
  `sfi.explain_error`, `sfi.automation_collisions`, `sfi.review_change`,
  `sfi.ai_exposure_report`, `sfi.live_record_access`, `sfi.live_record_shares`,
  `sfi.live_scheduled_jobs`, and `sfi.live_field_history` each gain a dedicated
  `intent-router.ts` rule (`explain-error`, `automation-collisions`,
  `review-change`, `ai-exposure`, `live-record-access`, `live-record-shares`,
  `live-scheduled-jobs`, `live-field-history`) anchored on vocabulary that does
  not collide with the neighboring intent each was previously deferred against
  (automation-risk, why-cant-see / sharing-model, scheduled-jobs,
  why-field-changed / runtime-audit-trail, release-readiness, pii-inventory).
  `sfi.live_setup_audit_trail` also gains a rule (`live-setup-audit-trail`);
  wiring it surfaced two now-stale `runtime-analytics` refusal-gate arms in
  `refusal-gates.ts` ("setup audit trail" bare, and "who changed
  FLS/sharing-settings/OWD/session-settings/password-policy/MFA") that
  pre-dated the tool and refused questions it can now answer — both REMOVED
  (documented in the "NON-triggers that HAVE tools are deliberately absent"
  list, matching the existing pattern for live_inactive_users etc.). All 9
  tools are removed from `intent-router.test.ts`'s `GRANDFATHERED_NON_ROUTABLE`
  allowlist. `sfi.guest_exposure_report` was found to already have a
  deterministic `guest-exposure` intent from R6-17 — no change needed there.
  Three pre-existing broad rules (`sample-records`'s bare-record-ID pattern,
  `recent-activity`'s "modified…recently" pattern, and `value-change`'s
  "changed…value" pattern) gained narrow negative-lookahead carve-outs so they
  stop shadowing the new record-access/share and field-history intents.
  Harness (as measured when R7-W6 landed; the shared goldset has grown since):
  27 additive gold rows in `sf-intelligence-qa/fixtures/router-goldset.json`
  (2-3 varied phrasings per tool) — `router-goldset.mjs` 187/187 (100%, no
  regression), `router-recall.mjs` 171/187 recall@8 (no regression, every new
  tool reachable), `funnel-generalization.mjs` 900/1000 (no regression),
  `router-collisions.mjs` clean.

- **Flow record-variable `<inputReference>` DML edges (R7-W1).** A Flow
  `recordCreate` / `recordUpdate` / `recordDelete` whose payload is a WHOLE
  record VARIABLE (`<inputReference>myVar</inputReference>`, not per-field
  `<inputAssignments>`) now emits an OBJECT-level `writesTo` edge from the Flow
  to `CustomObject:{Object}` — resolving the variable to its declared
  `<variables><objectType>` at `declared` confidence. Previously this whole-
  record write produced NO edges at all (a false-safe: a field written via a
  record variable read as unwritten to `get_impact` / `what_if_deactivate_flow`).
  The specific fields are NOT enumerable from a bare record-variable DML, so the
  edge carries `wholeRecord: true` + a `disclosure` property rather than any
  fabricated per-field edges; when the variable was populated by an earlier
  single-record `Get Records`, the edge notes the object-level `sourceObject`
  provenance. (`$Record` inputReference remains the separate heuristic
  trigger-record path, unchanged.)
- **Flow before-save `$Record.<Field>` assignment writes (R7-W2).** In a
  before-save record-triggered flow (`RecordBeforeSave`), an `<assignments>`
  item that sets `$Record.<Field>` (and `{!$Record.<Field>}`) now emits a
  FIELD-level `writesTo` edge to `CustomField:{TriggerObject}.{Field}` at
  `declared` confidence — the classic "before-save flow sets a field" pattern,
  previously invisible to impact/lineage. The assigned value is traced through
  the R6-11 dataflow index (so `field_lineage` walks THROUGH the write to its
  input fields, with the symmetric `readsFrom` dataflow-source edge); a
  non-`Assign` operator demotes the traced SOURCE confidence to `heuristic`
  while the write stays `declared`. After-save / before-delete `$Record`
  assignments do NOT persist without an explicit Update Records and are DISCLOSED
  (never emitted as a write); `$Record__Prior` and relationship-traversal targets
  are likewise disclosed, not guessed. `explain_flow`'s record-writes axis is now
  object-granular (field-level writes are excluded from it — a `field_lineage` /
  `field_360` concern) so the new field write is not misclassified as an object
  row.

- **`sfi.what_if_assign_permset` / `sfi.what_if_revoke_permset` — permission-set
  what-if delta tools (R7-C1).** The permission-set siblings of the profile
  merge/split what-ifs answer "if I assign/revoke permission set X to/from a user
  (a baseline of `{ profileId?, permissionSetIds?[] }`), what access do they GAIN
  / LOSE?". Both compose the SAME effective-permissions engine as
  `sfi.effective_permissions` — now factored into an exported
  `computeEffectiveGrants` (profile + permission-set max-wins union with
  group-scoped R6-06 muting subtraction) — TWICE, once WITH and once WITHOUT the
  target set, and diff the two muting-applied EFFECTIVE grant sets. The whole
  value is NET-CHANGE correctness under max-wins: a permission the baseline
  ALSO holds via its profile or another assigned permission set is never counted
  as gained (assign) or lost (revoke, the user keeps it). Muting composes
  automatically — assigning a group member DIRECTLY re-confers a perm the group's
  muting set had denied. Delta classes surfaced: object CRUD, per-field FLS,
  system (`<userPermissions>`), custom permissions, and record-type visibility;
  `summary.*` counts are complete, the detail lists paginate under a byte budget
  with a CR-22 cursor. Revoking a set not in the baseline (and assigning one
  already in it) is a disclosed no-op. Full `WhatIfEnvelope` (verdict/trust/
  coverage-caveat/disclosure): `safe` when no net change, else `review`. Two
  of the 24 tools new in 0.2.0 (see the roster note at the top of this
  release).
- **CSV export for the tabular tools (R6-21).** A new shared RFC 4180 CSV
  encoder (`@sf-intelligence/renderers`'s `csv.ts` — `encodeCsvField` /
  `encodeCsvRow` / `renderCsv` / `renderCsvWithDisclosures` /
  `fitCsvRowsToBudget`) backs `format: 'csv'` on three tools:
  - `sfi.generate_data_dictionary` gains an optional `format: 'markdown' |
    'csv'` (mirrors `generate_architecture_overview`'s `format` plumbing —
    the only other doc-generator with an alternate export format; the
    module's own comments referencing a data-dictionary `format: 'html'`
    precedent were aspirational, not existing code). `format: 'csv'` ADDS a
    `csv` field (one row per field: `objectApiName,label,apiName,dataType,
    formula,description,required`) alongside the always-returned
    `document`, fitted independently under the response budget (rows
    dropped tail-first with a `# truncated: …` comment, never silently
    corrupted by the global guard's blunt string-slimming).
  - `sfi.pii_inventory` and `sfi.unused_fields_deep` gain an optional
    `format: 'json' | 'csv'` (default `'json'`, unchanged). `format: 'csv'`
    REPLACES `fields` (which becomes `[]`) with a `csv` string carrying the
    SAME already-paginated page of rows — never both encodings of the same
    data in one response. `unused_fields_deep`'s eight-tier `checks` object
    flattens into `checks_*` columns. `summary`/`totalCount`/`truncated`/
    `nextOffset`/pagination fields are unchanged.
  - Every csv path embeds its disclosures (freshness timestamp,
    heuristic-recognizer caveats, truncation notes) as `#`-prefixed comment
    lines at the top of the CSV text itself, so they survive even when only
    the `.csv` file is saved and the rest of the MCP envelope is discarded.
- **`sfi vault anonymize` — redacted vault export for external sharing (R6-20).**
  New `sfi vault anonymize --out <dir> [--mode redact|pseudonymize]` subcommand
  under the existing `sfi vault` group. `--mode redact` (default, SHIPPED):
  copies `components/`, `docs/`, and `source/` (every text file; binary files
  such as images/fonts/static-resource archives are excluded, never scrubbed)
  plus an allowlisted subset of `meta/`, running each file through (1) org
  identity replacement — the `targetOrg`/`sourceOrg` alias found in
  `config.json`/`manifest.json`/`org-card.json` swapped everywhere it appears
  as literal text for a stable placeholder — then (2) an extended `scrubText`
  (the `sfi feedback export` precedent, now also catching phone numbers).
  Component/field API names are KEPT in this mode; the generated `README.md`
  in `--out` discloses that residual risk prominently. `graph/` (the binary
  DuckDB dependency graph) and `snapshots/` are NEVER copied — a copied binary
  db would carry the original un-redacted strings; the README points at
  `sfi refresh --no-pull` inside `--out` to rebuild locally from the scrubbed
  source. `--mode pseudonymize` (custom API names ALSO replaced with a stable,
  non-reversible mapping kept in a separate file outside `--out`) is **not
  shipped** — the command refuses it with a message explaining why (renaming
  consistently across the DuckDB graph needs either a full re-extraction run
  or an in-place binary rewrite, both real projects) rather than half-doing
  it; the deterministic mapping primitives it will build on
  (`buildPseudonymMapping`, `writeMappingTable`) are already built and tested.
  Safety rails: `--out` must be outside the source vault (validated before any
  write), the source vault is opened read-only, and a residual-leak scan of
  the OUTPUT runs before the CLI exits (identity-literal check + a generic
  email/URL/id/phone idempotency check + an optional maintainer-local
  org-name-pattern check when `scripts/forbidden-names.local.json` exists).

- **Mermaid ERD + impact-subgraph diagrams (R6-19).** Renderers were
  markdown-only, with three generic mermaid fences total across the
  product. Two additions, both inside existing ```` ```mermaid ``` ````
  fences (rendered client-side or read as text, matching the product's
  stated dual-consumption posture):
  - **`buildErDiagram`** — a new `packages/renderers` module
    (`erd-mermaid.ts`, plus a shared `mermaid-id.ts` collision-safe id
    sanitizer) that turns Lookup/Master-Detail relationships into a
    `mermaid erDiagram` fence: Lookup renders `||--o{`, Master-Detail
    `||--|{`; api names are sanitized into mermaid-safe entity ids via
    a collision-safe map (two different names that would sanitize to
    the same code get distinct codes) while labels carry the real
    names. `sfi.generate_data_dictionary` now includes an Entity
    Relationship Diagram section per object (its own outgoing
    Lookup/Master-Detail fields PLUS every other object's inbound
    `lookupTo` reference to it — both directions are "direct"
    relationships of the object), capped at 40 relationships.
    `sfi.generate_architecture_overview` now includes an
    org-wide ERD of the top 12 objects by Lookup/Master-Detail
    relationship DEGREE (a ranking distinct from the existing Org
    Structure diagram's inbound-reference-count ranking), showing only
    relationships whose BOTH endpoints made the cut. Both cases
    disclose the cap honestly (`ERD_SCOPE_DISCLOSURE` shared between
    the two generators, plus a per-cap disclosure when truncated).
  - **`sfi.get_impact`** now returns `diagram` — a `mermaid graph TD`
    fence of the (already-capped) impact slice, root rendered as a
    circle and every other node a box labeled
    `{ComponentType}: {apiName}`, edges labeled by `edgeType` — when
    the slice is at or under 30 nodes. Above that, `diagram` is OMITTED
    (never a silently-partial diagram) and `diagramOmittedReason` names
    the actual node count. The diagram mirrors exactly what
    `impact.nodes`/`impact.edges` already contain — no separate,
    uncapped query.
  - The HTML export path (`html-document.ts`) needed no changes — it
    already renders every ```` ```mermaid ``` ```` fence in a document's
    body generically, verified for the new ERD section specifically.
  - Tool descriptions (`sfi.generate_data_dictionary`,
    `sfi.generate_architecture_overview`, `sfi.get_impact`) and the
    `admin-documentation-generators` / `architect-impact-analysis`
    skills updated to disclose the new fences and their caps.

- **`edgeDrift` axis in `sfi.compare_vaults` (R6-12).** Cross-vault
  comparison previously paired components by api-name and diffed a
  SHA-256 property hash — EDGES were never compared, so dependency
  drift between two vaults (a Flow that starts referencing a new
  field, a validation rule that drops one) was invisible whenever the
  node's own properties matched. `edgeDrift` closes that gap: for
  every component present in BOTH vaults (independent of whether its
  node hash matched), it diffs the two vaults' OUTGOING edge sets and
  reports per-component `edgesAdded[]` / `edgesRemoved[]`. The
  comparison identity is deliberately narrow — `edgeType` + `toId` +
  the `referenceKind` property when present — mirroring the node-side
  volatile-property exclusion, so a `referenceKind` change on an
  otherwise-identical edge appears as one removed + one added row, not
  a single "modified" row. Capped at 200 drifted components / 50 rows
  per component (`summary` holds the true totals), with a verbatim
  `edgeDrift` scope disclosure always in `boundaries[]`. Also adds
  `extractorVersionCaveat`: when the two vaults' manifests report
  different sf-intelligence product versions, the response names both
  versions so a drift is never silently attributed to the org when it
  might reflect an EXTRACTOR change between versions. Reuses the
  existing cross-vault registry/open mechanics (`cross-vault-open.ts`,
  `@sf-intelligence/vault`'s registry) — no new infrastructure.
  `sfi.compare_object_across_vaults` is a SEPARATE diff code path (it
  does not import from `compare-vaults.ts`) and did not share this
  axis at the time; that follow-up was closed later in this release by
  R7-W10 (above). `architect-cross-org-compare`
  skill updated with the new axis and disclosure text.


- **Experience Cloud community modeling + `sfi.guest_exposure_report` — the
  unauthenticated guest-user exposure audit (R6-17).** The community family was
  previously excluded entirely (the v1.5 `NetworkAccess` note explicitly scoped
  it out); it is now modeled by three cooperating ComponentTypes and audited by
  a dedicated tool.
  - **Extraction:** `Network` (`networks/*.network-meta.xml`, the community
    definition + the security posture — `status`, `selfRegistration` (the
    critical self-signup switch), and the guest-access switches present in the
    XML: `enableGuestFileAccess`/`enableGuestChatter`/
    `enableGuestMemberVisibility`/`allowInternalUserLogin`, each tri-state so an
    absent switch reads `null`, never a fabricated `false`), which emits
    DECLARED `references` edges to its `CustomSite` (`<site>`) and
    `ExperienceBundle` (`<picassoSite>`); `CustomSite`
    (`sites/*.site-meta.xml`), which emits ONE HEURISTIC `references` edge to
    the site's auto-provisioned guest profile `Profile:{Site Label} Profile` (a
    Salesforce NAMING CONVENTION — the XML carries no `<guestProfile>` pointer —
    so the edge is `heuristic`); and `ExperienceBundle`
    (`experiences/{Name}.site-meta.xml`, top-level meta only: `label`/`type`/
    `urlPathPrefix` + a best-effort `pageCount`). The bundle's JSON page tree
    (hundreds of files) is DELIBERATELY out of scope and is suppressed from the
    refresh coverage skip-counter (mirroring the `staticresources` precedent), so
    it never reads as a false coverage gap. Guest sharing rules already parse
    (CR-CAP-16 `SharingRule` `ruleType:'guest'`) — no new extraction there.
  - **`sfi.guest_exposure_report`** (`access` category): for each modeled
    community with an identifiable guest profile, COMPOSES the existing engine —
    the guest profile's object CRUD (`grantedBy` edges), FLS on PII-classified
    fields (reusing `pii_inventory`'s classifier, gated on the guest also having
    object read), Apex-class access, and the community's guest sharing rules —
    into RANKED findings (public write on an object carrying guest-readable PII =
    `critical`). Every finding carries a REAL vault node id and per-claim
    confidence: the CRUD/FLS/apex GRANT is `declared`, but the guest-profile
    identity is `heuristic` (the naming convention), so the report confidence is
    `heuristic` and each finding carries `guestLinkageConfidence:'heuristic'`.
    FAILS CLOSED with no modeled surface ("no Experience Cloud surface in the
    vault — re-run `/sfi-refresh`"), never "no exposure". Discloses that object
    CRUD+FLS is the declared grant while record visibility also needs OWD + guest
    sharing rules, and that Visualforce-page guest access (`<pageAccesses>`) is
    not in the offline model. Byte-budgeted + paginated; carries a `TrustSummary`.
  - **Vault-rebuild note:** the community family populates only on a fresh
    `sfi refresh`; an existing vault answers `guest_exposure_report` as
    "no Experience Cloud surface" until refreshed.

- **`sfi.review_change` + `sfi review-change` — the pre-deploy change-review
  gate (R6-16).** Turns the offline engine into a daily deploy gate. Given a
  CHANGE SET (`components: [{ type, apiName, changeKind }]` a host assembles
  from a PR / package.xml / `git diff`), the new MCP tool returns a per-component
  risk verdict, its direct dependents, and the tests to run — ordered
  most-dangerous first. It COMPOSES three existing signals (it reimplements
  none): (a) IMPACT — the direct INCOMING-edge query `get_impact` /
  `promotion_readiness` build on, EXCLUDING `grantedBy` (a Profile/PermissionSet
  FLS grant is ACCESS, not a breakage dependency) and `parentOf` (structural) per
  the access≠usage rule; (b) TESTS — the covering set from
  `sfi.tests_for_change` (Apex only); (c) VERDICT from the shared
  blocking/risky/review/safe vocabulary + coverage-caveat machinery. A DELETED
  component with ANY dependent is `blocking` (a heuristic-only dependent still
  blocks — a false positive fails CLOSED, the safe direction for a gate); a
  MODIFIED component with firm dependents is `risky`, with heuristic-only readers
  `review`; an ADDED component absent from the vault is `safe` (its own forward
  references are NOT analysed — only name-collision + tests), an ADDED id that
  already exists is `review`. A zero-dependent change in a family the vault does
  not fully cover reads "not checked" (surfaced as a coverageCaveat, nudging an
  otherwise-`safe` verdict to `review`). The new `sfi review-change` CLI command
  assembles the change set from `--manifest <package.xml>` (change kinds are
  UNKNOWN from a manifest, so every member is reviewed `modified` with a
  disclosure) or `--diff <base> --project <dir>` (mapping `git diff
  --name-status` paths → component ids by REUSING the refresh pipeline's
  `componentTypeFromSourcePath` dispatcher), resolves against the current vault,
  and **exits 1 when any component is `blocking`** — a drop-in CI gate. Honesty
  axis (verbatim in the disclosure and printed on every CLI run): the analysis is
  against the LAST VAULT REFRESH of the TARGET org, which may drift from what is
  deployed — re-refresh before trusting a `safe`; dependents are DIRECT
  (single-hop), the full transitive blast radius is `sfi.get_impact`; SELECTION ≠
  VALIDATION.

- **Agentforce / Einstein GenAI extraction — the org's own AI surface, now
  modeled (R6-13).** The product positions itself as "the backend your
  Salesforce AI can trust", yet it could not see the org's OWN generative-AI
  configuration — zero coverage. Four GenAI metadata families are now
  first-class ComponentTypes with dedicated extractors: `GenAiFunction` (an
  Agentforce action; captures `invocationTarget`/`invocationTargetType` and
  emits a declared `references` edge to the `ApexClass`/`Flow` it invokes),
  `GenAiPlugin` (an agent topic; emits a declared `references` edge per member
  `functionName` to its `GenAiFunction`s), `GenAiPlannerBundle` (an agent /
  planner definition; emits declared `references` edges to the `GenAiPlugin`
  topics and loose `GenAiFunction` knowledge actions it orchestrates), and
  `GenAiPromptTemplate` (a prompt template; the privacy-critical grounding
  surface — emits declared `references` edges for the object/field data the
  prompt feeds an LLM: `<relatedEntity>`/`<relatedField>`, grounding
  merge-fields `{!$Input:Ref.Field}` resolved via the template's declared
  SObject `<inputs>`, and `{!$Flow:..}`/`{!$Apex:..}`/`flow://`/`apex://` data
  providers). All edges REUSE the generic `references` EdgeType tagged with a
  `properties.referenceKind` discriminator — no new EdgeType. Folders/suffixes
  (`genAiFunctions/`, `genAiPlugins/`, `genAiPlannerBundles/` nested
  folder-per-agent, `genAiPromptTemplates/`) were verified against a live
  Agentforce dev org's `sf org list metadata-types` describe. **Honesty axis:**
  a grounding merge-field resolves to a real `CustomField:{Object}.{Field}` id
  ONLY when its input is a DECLARED SObject input — a merge-field whose input is
  undeclared, a primitive, or a relationship traversal is disclosed in
  `properties.unresolvedGroundingRefs`, never minted as a phantom field edge;
  and every edge is DECLARED wiring, not a runtime execution trace (which topic
  the planner selects, whether a grounded field is populated). Legacy Einstein
  `Bot`/`BotVersion` were deliberately out of scope at this stage (the
  verification org has Einstein Bots disabled, and Bot's nested folder-per-bot
  layout does not fit the flat pattern) — that leftover was closed later in
  this release by the R7-C7 Bot/BotVersion extraction (below). **Retrieval notes:** `GenAiPlannerBundle` surfaces in the
  org describe at Metadata API v64.0+ (it replaced `GenAiPlanner` at v63.0)
  but only actually retrieves at v65.0+, and the refresh manifest is
  pinned at 62.0 (see the profile-grant-safety fix below), so `GenAiPlannerBundle`
  is NOT retrieved by default — it drops gracefully via `selectManifestTypes`, and
  the extractor models it only when a vault already contains it. The rest of the
  Agentforce surface (`GenAiFunction` v60.0+, `GenAiPlugin` v62.0+,
  `GenAiPromptTemplate`) does retrieve at 62.0. **Vault-rebuild note:** these types
  populate only on a fresh `sfi refresh` — an existing vault carries no GenAI nodes
  until refreshed.
- **`sfi.ai_exposure_report` — the AI-exposure audit (R6-13 flagship).**
  "What data can my org's OWN AI see?" — the audit "the backend your Salesforce
  AI can trust" always implied but could not answer until the GenAI extraction
  tier landed. It COMPOSES the extracted Agentforce surface (GenAiPromptTemplate
  grounding fields, and the agent action tree GenAiPlannerBundle → GenAiPlugin →
  GenAiFunction → the ApexClass/Flow it invokes and the fields THAT code
  reads/writes, plus any prompt template an action invokes) with the SAME
  `pii-detection` recognizer that backs `sfi.pii_inventory`, run over every
  exposed field. Returns `surfaces[]` (per AI surface: the object/fields it
  exposes, each with its heuristic PII classification, category, and the `via`
  mechanism) and — the actionable headline — `piiExposures[]`, the
  (surface, field) pairs classified pii/sensitive ("your Reservation agent's
  prompt template grounds on Contact.SSN__c — PII"). No args audits org-wide;
  `objectApiName` narrows to one object; `limit` (default 50, max 200) caps each
  list with a truncation note. **Fail-closed:** when the vault carries ZERO
  GenAI nodes the disposition is `no-ai-surface-modeled` with a message naming
  BOTH possibilities (the org has none, OR the vault predates GenAI extraction —
  re-run /sfi-refresh); it never implies an empty org. **Honesty axis:** the
  AI-surface wiring is DECLARED metadata, NOT a runtime trace; PII
  classification is HEURISTIC (a no-signal field reads `public`); a field the
  vault does not model (a standard field, or an object not retrieved) is
  `unknown`, never silently "not PII"; indirect exposure via an action's Apex is
  heuristic static analysis; legacy Einstein Bot/BotVersion metadata is
  extracted (R7-C7, below) but not yet composed into this report.
  Registered in the `govern` capability category and the funnel utterance
  corpus (surgical embedding-index append — the quantized ONNX model is not
  bit-stable, so a full regeneration would perturb every unrelated vector);
  deterministic-router wiring, initially deferred because the GenAI vocabulary
  was brand-new to the regex router, landed later in this release: the R7-W6
  router-v2 pass (above) added the dedicated `ai-exposure` intent.

- **Legacy Einstein Bot / Agentforce agent extraction (R7-C7).** The R6-13
  leftover — Bot's nested folder-per-bot layout that didn't fit the flat
  generic pattern. Two new ComponentTypes: `Bot` (`bots/{BotName}/{BotName}.bot-meta.xml`
  — the agent definition; label/description/type/agentType/agentTemplate/
  botSource/botUser/richContentEnabled/sessionTimeout/a `contextVariableCount`/
  `botMlDomain`) and `BotVersion` (`bots/{BotName}/{fullName}.botVersion-meta.xml`
  — one version; a `dialogCount`/`intentCount`, `entryDialog`, `toneType`, and
  the `<conversationDefinitionPlanners><genAiPlannerName>` targets). Verified
  against a real scoped retrieve (`sf project retrieve start --metadata Bot`)
  from a production-scale university sandbox (5 Bots / 15 BotVersions), which
  corrected two assumptions against ground truth rather than shipping a
  documentation guess: neither type carries a `status`/`active`/
  `versionNumber` element in real files, and a modern Agentforce-template
  BotVersion carries ZERO `<botIntents>` and instead references a
  `GenAiPlannerBundle` — the real, verified link between this legacy metadata
  type and the R6-13 GenAI tier, now wired as a declared `references` edge
  (`referenceKind: 'botVersionPlanner'`). `BotVersion`'s apiName is
  directory-disambiguated (`{BotName}.{fileBasename}`, matching Salesforce's
  own manifest `fullName` for the type exactly) because real files are named
  bare (`v1.botVersion-meta.xml`) — the basename alone collides across every
  bot in the org. Emits a declared `parentOf` edge `Bot -> BotVersion`. Full
  dialog/message trees and per-contextVariable field mappings are
  deliberately NOT extracted — counted only. `sfi.ai_exposure_report`'s
  "Bot/BotVersion not modeled" disclosure is corrected to "not yet composed
  into this report" (composing Bot's own field exposure in is a follow-up,
  not wired here). **Vault-rebuild note:** these types populate only on a
  fresh `sfi refresh`.

- **`PresenceUserConfig` — Omni-Channel presence configuration (R7-C7).** The
  R6-18 leftover — the `<assignments><users>` sub-block had no `User`
  ComponentType to target. New ComponentType
  `presenceUserConfigs/{fullName}.presenceUserConfig-meta.xml`; carries
  `label`/`capacity`/the enable* toggles. Real retrieves (a production-scale
  university sandbox and a small services org) confirm the shape: one
  `<assignments>` block wrapping optional `<profiles><profile>` (repeatable)
  and optional `<users><user>` (repeatable) — either, both, or neither may be
  present (an org-default config in both verification orgs carries no
  `<assignments>` block at all). `<profiles><profile>` names a real `Profile`
  node — emits a declared `references` edge (`referenceKind:
  'presenceProfileAssignment'`). `<users><user>` names a username with no
  corresponding ComponentType — captured VERBATIM (every occurrence, not
  just the first, via a new generic `arrayProperties` extractor-config
  mechanism) as the `assignedUsernames` property array with NO edge minted,
  matching `QueueRoutingConfig.userOverflowAssignee`'s existing precedent of
  never fabricating a `User:` node/edge from an unconfirmed id shape.

- **Per-milestone `minutesToComplete` on `EntitlementProcess` (R7-C7).** The
  R6-18 trap the original extractor explicitly avoided: the generic
  `extractEnterpriseMetadata` scanner's `extraProperties` reads only the
  FIRST occurrence of a repeated element, so a flat read of
  `minutesToComplete` across a file with 2+ `<milestones>` blocks would
  silently misattribute one milestone's target minutes to a different
  milestone. A new dedicated block-scoped parser
  (`extractMilestoneDetails`) now captures a `milestones` property array —
  `{ milestoneName, minutesToComplete, useCriteriaStartTime }` per
  `<milestones>` block, each read scoped to ITS OWN block, in file order —
  alongside the pre-existing deduplicated `milestoneName` list and
  `references` edges (unchanged). Verified against a real retrieve (a small
  services org's `standard case` EntitlementProcess: three milestones at
  240/1440/5760 minutes respectively, each captured correctly and
  distinctly — the repeated-element correctness proof). `<timeTriggers>`
  and `<exitCriteriaFilterItems>` remain out of scope (disclosed, not
  silently dropped). Corrects the now-stale "target minutes … unmodeled"
  disclosure text in `sfi.what_happens_on_save` / `sfi.order_of_execution`
  (both the JSDoc and the byte-identical `DISCLOSURE` strings) — target
  minutes ARE now modeled; only live per-record on-track/breached status
  remains unmodeled.

- **Reader-facing "showing N of M" disclosures for two JSDoc-only caps (CR-22-B6).**
  `sfi.generate_architecture_overview`'s two mermaid diagrams cap their node
  count (Org Structure: top 5 CustomObjects by inbound references;
  Integration Topology: first 20 integration surfaces) — an org exceeding
  either cap now gets an inline "showing the top/first N of M" line under
  the affected diagram AND a matching `document.boundaries` entry, present
  only when the cap actually truncated something. The Integration Topology
  Type/Count table is untouched (it was never capped — only the diagram's
  node list was). `sfi.governor_limit_risks`'s per-class `entryPaths`
  entry-point-path walk (bounded depth 6, `ENTRY_PATH_MAX_PATHS`=12) now
  carries `entryPathsTruncated: true` on a class whose real fan-in of
  callers exceeds what the walk explored (present only when true), plus a
  response-level `boundaries` disclosure when any class in the result hit
  the cap — previously silent since the walk's own early-exit guards keep
  the collected array itself bounded (a naive post-hoc length check could
  never have detected the gap; the fix tracks the cap hit at its two actual
  trigger sites during the walk). Byte-drop/hop-cursor pagination for a
  many-thousand-object org's architecture overview is a separate, larger
  concern and stays explicitly OUT of scope for this fix.
  **Note on scope:** this item's constant `ENTRY_PATH_MAX_PATHS` lives in
  `governor-limit-risks.ts`, not `generate-architecture-overview.ts` (which
  has no governor-limit-risks composition) — fixed in the file the constant
  actually lives in rather than silently skipped or force-fit into the
  wrong module.
- **`sfi.generate_sharing_summary` discloses its object-scan cap (CR-RV12).**
  The `OBJECT_SCAN_CAP = 50` slice (an architect-tier convention capping how
  many CustomObjects get a full per-object sharing entry built) previously
  had NO reader-facing disclosure — a >50-object org's summary silently read
  as complete. The response now carries `scanTruncated: true` +
  `totalMatchingObjects` (the TRUE matching-object count) whenever the cap
  actually truncated the scan (present only then, so a ≤50-object org's
  response is byte-identical), mirrors `unassigned-permission-sets.ts`'s
  established `scanTruncated` shape. The disclosure also surfaces inline for
  a document reader: the Overview line reads "Scanned objects: 50 of 312
  matching (capped at 50 — narrow with `objectFilter`...)" and
  `document.boundaries` gets a verbatim "Object scan capped: showing the
  first 50 of N..." entry recommending `objectFilter` (or a per-object
  `who_can_access_object` call) for the objects the cap dropped.
- **Live population cross-check on field-cleanup verdicts (CR-CAP-L5).**
  `sfi.safe_to_delete_field` and `sfi.unused_fields_deep` each compute a
  STATIC "this field looks unused" verdict from the offline vault graph — a
  field with zero static references can still hold real production data
  written by dynamic Apex, an integration, or another blind spot the scanner
  cannot see. Both tools now cross-check a would-be-clean verdict against the
  field's LIVE production population before trusting it: pass `liveEnabled:
  true` (or grant consent). `safe_to_delete_field`'s `safe` verdict
  DOWNGRADES to `review` when `populatedCount > 0`, attaching a
  `livePopulation` evidence block (`objectApiName`/`fieldApiName`/
  `totalCount`/`populatedCount`/`populationRate`/`liveQueriedAt`); a
  zero-population result leaves `safe` standing but still attaches the
  evidence, confirming the cross-check ran, and the response's `trust`
  becomes `hybrid` (via the shared `hybridTrust` builder). `unused_fields_deep`
  applies the same check to every `confidence: 'high'` field ON THE RETURNED
  PAGE (never the full unfiltered scan, so live-query cost tracks `limit`) —
  a populated field downgrades from `high` to `medium` (the tier `medium`
  already meant "no static evidence, but a blind spot could hide a
  reference"; this is now its first real producer). `byConfidence` /
  `totalCount` stay the STATIC pre-cross-check totals regardless, disclosed
  in `boundaries` when a downgrade occurs. The live plane is NEVER a hard
  dependency: when it is off, unavailable, or a query errors (budget
  exhausted, org unreachable), the response fails soft to the disclosed
  static verdict with a `'static-only verdict; live population not checked'`
  line (`trust.limitations` for safe_to_delete_field, `boundaries` for
  unused_fields_deep) — offline stays fully functional. New shared module
  `live-population-check.ts` (the `computeLivePopulation` primitive, reused
  by both tools) reuses the exact availability check the live tools use
  (`resolveLiveAccess`) and the shared session query budget/cache
  (`liveCount`), mirroring `what-if-make-field-required.ts`'s established
  `computeLiveNullRate` pattern.
- **`sfi.live_setup_audit_trail` registered on the tool roster (R6-27).** The
  handler and schema (SOQL over `SetupAuditTrail` — the runtime "who changed
  what in Setup" question: profile/permission-set edits, field changes,
  org-wide-default flips, and every other tracked configuration change) had
  been built but never wired into `tools/index.ts`, so a live probe against a
  real vault returned `unknown-tool`. Now registered end-to-end: schema entry,
  dispatch case, and `sfi.capabilities` `live` category + `INTELLIGENCE_PLANES`
  live plane, plus a synthetic ask-phrasing corpus in `funnel-utterances.ts`
  ("who changed what in setup", "recent setup changes", "setup audit trail
  for the last week", "who modified this in setup last month", and others)
  so the tool is reachable via the hybrid-mode semantic funnel. The dedicated
  deterministic-router rule, initially deferred (grandfathered in
  `intent-router.test.ts`), landed later in this release: the R7-W6 router-v2
  pass (above) added the `live-setup-audit-trail` intent and removed the
  grandfathering. `days` bounds the
  SetupAuditTrail window (default 30, max 180 — Salesforce's own retention
  ceiling); `limit` (default 100, max 500) pages the detail rows. CR-P3-8
  honesty axis carries over unchanged: the (un-gated) detail query can
  budget-stop mid-tool while the gated count stays exact — `budgetStopped`
  discloses the partial rather than reading it as zero changes. Opt-in live
  plane, read-only.

- **`sfi.live_field_history` — WHO changed a field on a record, live (R6-14).**
  Queries the `{Object}History` table (Field, OldValue, NewValue,
  CreatedBy.Name, CreatedDate) with optional `fieldApiName` / `recordId` /
  `days` filters, reusing the `deriveSiblingObject` builder for the
  standard-vs-custom `{Object}History` / parent-Id naming. This is the ONE live
  tool family that returns runtime RECORD DATA (OldValue/NewValue are actual
  field values), so rows are capped HARD (default 20, max 200) with a byte
  budget and per-value length clamp, and the disclosure says so verbatim.
  PRECONDITION COMPOSITION: field history only exists where tracking is enabled,
  so the vault's per-field `trackHistory` (CustomField) and per-object
  `enableHistory` (CustomObject) are checked FIRST — a vault-KNOWN off state
  fails closed with a precise "history tracking is not enabled … (per last
  refresh)" reason instead of a cryptic INVALID_TYPE SOQL error, while MISSING
  vault metadata (a scoped refresh, a skipped managed object, or an unavailable
  graph) proceeds with a live probe and discloses `trackingState: 'unknown'` (a
  zero result then must NOT be read as "no changes"). Justification: failing
  closed on missing vault data would make the tool useless on exactly the
  scoped/partial vaults where a live probe is most valuable. Opt-in live plane,
  read-only, fail-closed without consent; provenance `live_org`.
- **`sfi.live_scheduled_jobs` — the RUNTIME schedule registry, live
  (CR-CAP-L7).** Reads CronTrigger (with `CronJobDetail.Name` / `JobType`,
  `State`, `CronExpression`, `NextFireTime`, `TimesTriggered`) — what is
  ACTUALLY scheduled in the org right now — plus an optional recent
  `AsyncApexJob` status summary (`GROUP BY Status`, default 7-day window). This
  is the live half of the offline `sfi.scheduled_job_catalog`, which lists
  Schedulable-CAPABLE Apex classes from metadata. Honesty axis: the two measure
  DIFFERENT things and routinely differ — a Schedulable class may not currently
  be scheduled, and a cron job may run managed-package or non-Apex work (Data
  Export, Dashboard Refresh) no catalog class covers — so the cross-reference is
  COUNT-ONLY (`staticSchedulableClassCount`, from the vault, vs
  `liveScheduledApexCount`, an ORG-WIDE dedicated COUNT of Scheduled-Apex cron
  registrations rather than the returned page), never a per-class-to-cron
  pairing, and JobType matching is best-effort (the raw JobType is always
  surfaced). True count first
  (`totalCronJobs`); capped detail (default 200, max 500). Opt-in live plane,
  read-only, fail-closed without consent; provenance `live_org`.
- **`sfi.live_record_shares` — the explicit share rows on ONE record, live
  (CR-CAP-L2).** Given `{ recordId }` (and optionally `objectApiName`), queries
  the runtime `{Object}Share` table and returns each share row's UserOrGroupId
  (resolved to a User/Group name), AccessLevel, and RowCause (Owner / Manual / a
  sharing Rule / a Team / Apex managed sharing) — runtime sharing state the
  offline vault never holds, complementing `sfi.live_record_access` (a user's
  effective access) with the shares themselves. When `objectApiName` is omitted
  it is derived from the record Id's key prefix via the org's global describe
  (an ambiguous or unknown prefix is an honest error, never a guess). New shared,
  reusable SOQL builder `deriveSiblingObject(objectApiName, 'Share' | 'History')`
  encodes the standard-vs-custom naming rule (`AccountShare`/`AccountId` vs
  `Widget__Share`/`ParentId`) and is the foundation for the field-history tool.
  Honesty axis: an object whose OWD is Public Read/Write has NO Share table — a
  non-queryable result is reported as `shareTableQueryable: false` with a note
  ("no explicit shares apply", NOT "no one has access"), while a budget stop
  stays a hard fail so a partial roster is never shown as complete. True count
  first (`totalShares`); capped detail (default 200, max 500). Opt-in live plane,
  read-only, fail-closed without consent; provenance `live_org`.
- **`sfi.live_record_access` — a user's EFFECTIVE access to ONE record, live
  (CR-CAP-L1).** Given `{ recordId, userId | username }`, queries the org's
  runtime sharing calculation (`UserRecordAccess`) and returns the Read / Edit /
  Delete / Transfer / Full (All) flags for that user on that record. A
  `username` resolves to an Id via a capped exact-Username lookup (ambiguity or
  no-match is an honest error, never a guess); both ids are shape-validated and
  bound through the existing `soqlLiteral` escaper. This is the RUNTIME resolver
  for the offline `sfi.why_cant_user_see_record`: when that vault cascade returns
  `unknown` (manual shares, account/opportunity teams, Apex managed sharing, and
  criteria sharing evaluated over record field VALUES are record-level state the
  vault never holds), the metadata answer now carries a `boundaryNote` pointing
  at this live tool, which answers definitively. Honesty axis: an empty result
  (`noAccessRow: true` — record missing, wrong id, or invisible to the querying
  user) is reported as "could not determine", NEVER a confirmed deny. Opt-in
  live plane, read-only, fail-closed without consent; provenance `live_org`,
  point-in-time as of `queriedAt`, never falls back to vault data.

- **Field-level dataflow through Flows (R6-11) — `sfi.field_lineage` chains
  end-to-end through declarative automation.** The flow extractor now parses
  `<assignments>`, `<variables>`, `<formulas>`, `<recordLookups>` outputs, and
  `<loops>` as dataflow plumbing and traces each DML `<inputAssignments>`
  reference value back to the record fields it derives from. The trace lands
  in two places: (1) the existing FIELD-level `writesTo` edges gain
  `sourceFields` / `sourceFieldConfidence` (parallel arrays; `declared` =
  direct `$Record`/single-record-lookup chains including clean single-`Assign`
  variable hops, `heuristic` = through formulas/loops/non-`Assign` operators)
  plus `unresolvedSourceCount` (ambiguous reassigned variables, relationship
  traversals, action/screen/subflow outputs, and chains past the 5-hop trace
  depth cap are DISCLOSED as a count — never guessed; `sourceTraceDepthCapped`
  flags a capped chain); and (2) new FIELD-level `readsFrom` edges
  (`operation: 'dataflowSource'`, `targetFields[]`) from the Flow to each
  resolved source field — the same shape the apex-scanner emits for Apex field
  reads, so field-usage consumers see flow reads too. `sfi.field_lineage`'s
  upstream walk follows the trace: a Flow writer no longer dead-ends — its
  input fields surface as `flow-input-field` sources one hop past the flow and
  are recursed into, so a field written by Flow A from a field written by
  Flow B chains to Flow B's inputs (upstream of F1 reaches F3). Downstream is
  symmetric via the new `flow-field-write` effect kind (`targetFields[]`; the
  walk continues into each written field). The upstream payload's new
  `flowDataflow { inputFieldsTraced, unresolvedInputCount,
  untracedFlowWriteEdges }` and a new boundary line disclose exactly what the
  trace could and could not resolve; write edges from a vault refreshed with a
  pre-tracer extractor are counted as untraced with a re-refresh nudge.
  `sfi.explain_flow` filters the new dataflow read edges out of its
  record-lookup rows (they are lineage plumbing, not lookups).
  **Vault-rebuild note:** the trace properties and dataflow read edges are
  populated only on a fresh `sfi refresh`.

- **SOE disclosure additions beyond R6-07/R6-18 (R6-23).** `sfi.what_happens_on_save`
  and `sfi.order_of_execution`'s (byte-identical, per their own doc contract)
  `DISCLOSURE` constant now gives criteria-based sharing recalculation — the
  FINAL step in Salesforce's documented order-of-execution, evaluated after
  every phase modeled here including `post-save-async` — its own explicit
  sentence (previously a terser clause lumped together with the
  entitlement-milestone one that R6-18 had just split out), naming its
  position and its practical consequence (a save that newly matches/un-matches
  a criteria-based sharing rule triggers a recalculation this composition
  never surfaces). Both tool descriptions in `index.ts` and the
  `what-happens-on-save.ts` JSDoc honesty-axis bullet list were updated to
  match. **New (`sfi.what_happens_on_save` only):** a light informational
  `entitlementProcessNotes` rider — when the target object carries at least
  one ACTIVE `EntitlementProcess` (R6-18), the response now names it
  (`componentId`, `apiName`, a fixed message, `confidence: 'declared'`) —
  a disclosure-PLUS-pointer, explicitly NOT a simulated order-of-execution
  phase; milestone evaluation itself remains unmodeled per `DISCLOSURE`.
  Capped at 20 entries (`entitlementProcessNotesTruncated` when hit); omitted
  entirely when the object has none. Verified against the real gate vault:
  `sfi.what_happens_on_save({objectApiName:'Case', event:'insert'})` returns
  ok with the full disclosure text (both new sentences present) and no
  `entitlementProcessNotes` key (the vault predates an R6-18 refresh, so it
  legitimately holds zero `EntitlementProcess` nodes — the honest "omitted
  when absent" path); `sfi.order_of_execution` on a lighter real custom
  object returned the disclosure fully intact, while the same call on the
  much busier `Case` object showed the pre-existing global response-size
  guard (`responseBudget.applied`) trimming the (already-2.3KB) disclosure
  string — confirmed via a byte-length check this trimming threshold predates
  R6-23 and is not a regression it introduced.
- **Certificate + TransactionSecurityPolicy security-surface extractors
  (R6-22, 2 of 3 — `CustomSite` tracked separately).** Two new ComponentTypes,
  wired end-to-end (contracts union, `SUPPORTED_TYPES`, `EXTRACTORS` map,
  `dispatchFile` route) via the shared `extractEnterpriseMetadata` pattern:
  - `Certificate` (`certs/*.crt-meta.xml`) — `caSigned`, `expirationDate`,
    `keySize`, `label` = `masterLabel`. The Metadata API always retrieves a
    Certificate as TWO files — this metadata sidecar and a separate `.crt`
    content file carrying the actual PEM/DER certificate or exported key
    material. Only the sidecar is ever parsed: the dispatcher matches
    strictly on `.crt-meta.xml`, so the `.crt` content file never reaches an
    extractor (falls through to the walk's existing skip-and-count path,
    same as any unrecognized file). Verified LIVE against a production-scale
    sandbox (`sf project retrieve start --metadata Certificate`) — all 4 real
    certificates extracted with zero errors, confirming the two-file shape.
  - `TransactionSecurityPolicy` (`transactionSecurityPolicies/*.transactionSecurityPolicy-meta.xml`)
    — `eventName`, `active`, and `action` (boolean-flag summary:
    `block`/`endSession`/`freezeUser`/`twoFactorAuthentication` +
    `notificationCount` — never the notification recipients, which are
    specific admin usernames rather than org-structural metadata). Emits a
    `declared`-confidence `references` edge (`referenceKind: 'conditionClass'`)
    to `ApexClass:{apexClass}` when `<apexClass>` is present — the class
    implementing `TxnSecurity.PolicyCondition`/`EventCondition` that decides
    whether the policy fires. Folder/suffix verified against the Metadata API
    Developer Guide; NOT verified against a live org — TransactionSecurityPolicy
    requires Salesforce Shield/Event Monitoring, unavailable in every
    accessible sandbox in the fleet (`sf project retrieve start` returned
    "Entity type 'TransactionSecurityPolicy' is not available in this
    organization" for the same sandbox that yielded the real Certificates).
    Verified end-to-end against synthetic fixtures instead, matching the
    R6-01 SamlSsoConfig precedent for a type absent from every reachable org.

  **Consumer check (as scoped):** `integration_map` was checked for an
  additive slot — it does NOT have one. Its eight-bucket design
  (`INTEGRATION_TYPES`, one dedicated output field + JSDoc paragraph per
  type, a `filter` enum that maps each bucket to an architectural cut) is
  about OUTBOUND integration topology (callout targets, auth mechanisms);
  Certificate/TransactionSecurityPolicy are inbound-security surfaces (key
  material, event-triggered policy) that don't fit that concept, and adding
  them would mean two new output fields, a renumbered "eight" JSDoc, and new
  `filter` semantics — not a small additive change. `org_risk_report` was
  also checked — it composes OTHER tools' summaries (health/tech-debt/
  permission-risk/PII) rather than enumerating a ComponentType roster, so
  there is no list to append to; surfacing "certificate expiring soon" or
  "policy with no configured action" as a risk finding would be a new
  capability, not a wiring change. Both noted as follow-ups rather than
  force-fit. `list_components`'s curated `COMPONENT_TYPES` enum and
  `org_overview`'s curated `OVERVIEW_COMPONENT_TYPES` were left untouched for
  the same reason (out of this tier's explicit consumer scope) — mirrors how
  `SamlSsoConfig` was NOT added to either.

- **Report structural depth beyond column identity (R6-24).** `extractReport`
  now parses a Report's `<filter>` criteria (`field`/`operator`/`hasValue` —
  the literal filter value is NEVER captured; a report filter value is
  record-level data, and this product never vaults record data),
  `booleanFilter` (the AND/OR logic string), `groupingsDown`/`groupingsAcross`
  (`groupings[]`: field + `dateGranularity` + axis), `buckets[]` (bucket field
  identity + label + source field — also emits a `declared`-confidence
  `references` edge, `referenceKind: 'bucketSource'`, to the source field),
  `crossFilters[]` (related object + operation + condition presence, same
  value-omission rule), `chart` (type + summary-axis presence), and `format`
  (Tabular/Summary/Matrix/…) onto the Report node's `properties`. Each list
  property is capped at 100 entries with the drop count disclosed in
  `properties.truncatedCounts` (a joined report's blocks can carry hundreds).
  Report-only (`reportDetail` config flag) — Dashboard/ReportType/ListView are
  unaffected. Verified error-free against 499 real report files from a
  production-scale gate vault (492 carried filters, 476 groupings, 59
  buckets, 26 crossFilters, 45 charts). **Boundary note:** the refresh
  pipeline still folds every Report/Dashboard node into the field's
  `usedInReport`/`usedInDashboard` boolean and drops the per-report node
  (volume), so this richer shape does not yet reach `field_360`/
  `field_lineage` composition — filter/grouping LOGIC is no longer entirely
  unparsed, but per-field "which report filters on this, and how" stays a
  `dataNotAvailable` boundary. Corrected the `developer-field-deep-dive`
  skill's Q165 anchor wording that previously implied report filters were
  wholly unextracted.
- **Service Cloud entitlement/SLA metadata — `EntitlementProcess` +
  `MilestoneType` (R6-18).** Closed an eval-refused gap: "what's the SLA on
  this case?" previously got a blanket honest refusal because neither
  ComponentType existed. New `EntitlementProcess`
  (`entitlementProcesses/{fullName}.entitlementProcess-meta.xml`) captures
  `SObjectType`, `active`, `businessHours` (name only), `versionNumber`/
  `versionMaster`/`isVersionDefault`/`versionNotes`, `entryStartDateField`,
  `description`, and the top-level `<name>` label — folder/suffix verified
  against a real scoped retrieve from a live services org. **Versioning
  honesty**: a process can have multiple files (one per version); each is
  modeled as its own node keyed by that file's own `fullName`, never merged.
  Its repeated `<milestones><milestoneName>` children are promoted to
  `references` edges to `MilestoneType:{Name}` (`referenceKind:
  'entitlementMilestone'`, declared) via the generic `childRefs` mechanism.
  New `MilestoneType` (`milestoneTypes/{fullName}.milestoneType-meta.xml`)
  captures `description` and `recurrenceType` — real org files carry no
  `<name>` element at all, so the node's own `apiName` is the display name.
  **Deliberately NOT captured at this stage**: per-milestone `minutesToComplete` /
  `timeTriggers` (the generic extractor's flat property reader only sees the
  FIRST of 2+ repeated `<milestones>` blocks, which would misattribute one
  milestone's target minutes to another — a correct capture needs a bespoke
  nested parser, deferred rather than shipped wrong; that parser landed later
  in this release as R7-C7's block-scoped `extractMilestoneDetails`, above —
  `minutesToComplete` IS now captured, `timeTriggers` remains out of scope)
  and, more importantly,
  ANY live/record-level milestone status: whether a specific case is
  currently on-track or breached is per-record timer data this offline
  vault cannot hold. `sfi.lifecycle_process` / `sfi.what_happens_on_save` /
  `sfi.order_of_execution`'s honesty-axis disclosure has been corrected —
  it previously claimed entitlement milestones were entirely unmodeled;
  it now says the metadata IS modeled but the SOE phase / live status is
  not. The `business-user-orientation` skill's SLA/entitlement intent moved
  from a blanket honest refusal to a partial-answer-plus-honest-refusal
  pattern (mirroring the existing process-explanation intent).
- **Omni-Channel routing metadata — `ServiceChannel` + `QueueRoutingConfig`
  (R6-18).** Closes the companion eval-refused "how are cases routed to
  agents?" gap. New `ServiceChannel`
  (`serviceChannels/{fullName}.serviceChannel-meta.xml`) captures `label`,
  `relatedEntityType`, and `capacityModel` — verified against real retrieves
  from two live orgs, which corrected an initial assumption that the
  related-object field was named `salesforceObject`; the real Metadata API
  field is `relatedEntityType`. New `QueueRoutingConfig`
  (`queueRoutingConfigs/{fullName}.queueRoutingConfig-meta.xml`) captures
  `routingModel`, `routingPriority`, `capacityWeight`, `capacityType`,
  `pushTimeout`, and `isAttributeBased`, and emits a `references` edge to
  `Queue:{Name}` for a set `<queueOverflowAssignee>` (verified against a
  real file: the element holds a Queue DEVELOPER NAME, not the opaque
  record id the Metadata API Developer Guide's prose describes).
  Additionally, the pre-existing `queue.ts` extractor already read
  `<queueRoutingConfig>` into a bare string property but never turned it
  into an edge — it now also emits a declared `Queue -> QueueRoutingConfig`
  `references` edge, verified against a real Queue file from a live org.
  "How are cases routed to agents?" is now answerable end-to-end: Queue →
  QueueRoutingConfig (routing model/capacity/overflow) and ServiceChannel
  (which object routes through Omni-Channel). Real-time agent
  presence/capacity remains live-only and unmodeled.
- **Duplicate rules + roll-up recalculation in the save simulation (R6-07).**
  `sfi.what_happens_on_save` and `sfi.order_of_execution` gained two new SOE
  phases: `duplicate-rules` (DuplicateRules parented to the object, positioned
  after before-triggers and validation, BEFORE the save — per Salesforce's own
  documented order-of-execution numbering; evaluates on insert/update only,
  each step surfacing `duplicateRuleOperations` (the effective
  `Allow`/`Block`/`Alert`/`Report` set for the DML event), a derived
  `blocksOnSave` boolean, and the referenced `MatchingRule` ids) and
  `post-save-rollup-recalc` (parent Summary/roll-up-summary CustomFields that
  aggregate the saved object, positioned after post-save-approval; fires on
  EVERY DML event — insert/update/delete/undelete alike — capped to ONE level
  and does not expand the recalculated parent's own automation, both disclosed
  verbatim). `sfi.lifecycle_process` inherits both phases automatically (it
  composes `order_of_execution`); its stale "excludes roll-up recalculation"
  disclosure has been corrected. New shared modules `soe-duplicate-rules.ts`
  and `soe-rollup-recalc.ts` keep the two SOE tools in lockstep, matching the
  existing `soe-active.ts` / `soe-admission.ts` / `soe-payload-bounds.ts`
  pattern.
- **CustomField extractor captures roll-up-summary source metadata.** A
  `type: Summary` CustomField now carries `summarizedField` (omitted for a
  `count` operation, which aggregates no source field), `summaryForeignKey`
  (the child-object master-detail field the rollup traces — the anchor the new
  `post-save-rollup-recalc` phase matches against), and `summaryOperation`
  (`count`/`sum`/`min`/`max`) in `properties`, following the existing
  OMIT-when-null convention (every other CustomField stays byte-identical).
  **Vault-rebuild note:** this metadata is populated only on a fresh
  `sfi refresh` — an existing vault answers `post-save-rollup-recalc` as empty
  for objects with real roll-up parents until refreshed.

- **`sfi.automation_collisions` — field-level write-collision + save-recursion
  cycle detector for ONE object.** `automation_build_advisor` only flags
  OBJECT-level automation hazards (multiple Flows, mixed Apex+Flow); this new
  tool looks at what those automations actually WRITE. Given `{ object,
  limit? }`, it walks the same `triggersOn` firer set (record-triggered Flow,
  ApexTrigger, WorkflowRule) plus each firer's `writesTo` edges: `collisions[]`
  lists fields with 2+ DISTINCT writers (a silent last-writer-wins fight
  Salesforce does not arbitrate), each writer carrying its componentType,
  active flag, edge confidence (`parsed` for declared Flow/WorkflowRule XML,
  `heuristic` for the Apex scanner), and firing timing; a finding's
  `weakestConfidence` is the weakest across its writers. `cycles[]` is a
  depth-capped (4 hops) walk for a write path that returns to the queried
  object — `self-write` for the classic same-object after-trigger /
  workflow-field-update re-trigger, `multi-object` for an A-writes-B /
  B-writes-A loop, each with the full real-node `path`. Honesty axis:
  conditions are NOT evaluated (mutually exclusive writers still collide in
  this report); Salesforce's own recursion guards (a Flow's "do not
  re-trigger" setting, workflow re-evaluation limits) are not modeled by the
  extractors and are NOT evaluated here — a listed cycle is a POTENTIAL loop,
  not proof it fires; a same-object write from a BEFORE-save automation is
  excluded from cycle detection (it folds into the single pending save, not a
  second one); ApprovalProcess field updates and Apex writes performed by a
  helper class the trigger calls (rather than the trigger itself) are out of
  scope for this v1. `limit` (default 50, max 200) caps each list
  independently with a truncation disclosure. Registered in the `automation`
  capability category and the funnel utterance corpus; deterministic-router
  wiring, initially deferred pending disambiguation from the existing
  org-wide `automation-risk` intent, landed later in this release: the R7-W6
  router-v2 pass (above) added the dedicated `automation-collisions` intent,
  anchored on vocabulary that does not collide with `automation-risk`.

### Fixed
- **`canonicalJson(undefined)` crash-class sweep across the cross-vault diff
  tools (R7-W9).** R6-12's real-vault verification found a real crash in
  `sfi.compare_vaults`: `JSON.stringify(undefined)` returns the JS value
  `undefined` (not a string), so `canonicalJson`'s primitive-fallthrough
  branch silently returned a non-string whenever a diffed property existed
  on only one side, and the byte-capping `boundValue` helper then threw
  calling `.length` on it — fixed there with an explicit `undefined` branch
  that canonicalizes to a sentinel string, plus a regression test. That fix
  flagged the IDENTICAL `canonicalJson` implementation copy-pasted into
  `compare-object-across-vaults.ts` and `diff-snapshots.ts` as a follow-up.
  Both now carry the same defensive branch, with a regression test each:
  `compare-object-across-vaults.ts`'s `collectDrift` has the same
  key-union-produces-`undefined` shape as `compare-vaults.ts` (traced and
  confirmed it does not currently crash — no byte-capping step exists in
  this file — but the same latent bug pattern is closed pre-emptively);
  `diff-snapshots.ts`'s two `canonicalJson` call sites are not reachable
  with an `undefined` value via any public code path today (`JSON.parse`
  never produces `undefined`), so `canonicalJson` is now exported and
  unit-tested directly. Also fixes a pre-existing vault-registry
  misconfiguration R6-12 worked around rather than fixed: a registered
  alias that named the `org-kb` PARENT directory (the project root) instead
  of the vault itself (`{parent}/org-kb`, which `sfi init` creates by
  default) resolved to a path with no `meta/manifest.json`, silently
  reading as "never refreshed" instead of "wrong path". `resolveVault` /
  `getVaultRef` / `listRegisteredVaults` in `@sf-intelligence/vault` now
  normalize via a new `normalizeVaultRootPath` helper — an alias resolves
  correctly whether or not the registered path included the `org-kb`
  suffix, with no re-registration required for already-mis-registered
  aliases.

- **`why_cant_user_see_record` no longer OVERSTATES access when a
  PermissionSetGroup mutes the object-CRUD precondition (R7-W4).** R6-06 made
  `effective_permissions` subtract a group's muting permission set from its
  member union, but `why_cant_user_see_record` still composed
  profile ∪ permsets ∪ PSG WITHOUT subtracting muting — so its yes/no verdict
  could say a user CAN see (or edit / delete / create) a record when a group's
  muting set had actually removed the object CRUD that the operation requires.
  For a security-diagnostic tool, overstating access is the wrong direction. The
  operation-aware object-CRUD **precondition** (plane A) now composes the SAME
  shared kernel R6-06 factored out (`expandPermissionSetGroup` +
  `loadMutingPermissions`): each assigned PermissionSetGroup's grant is
  `union(members) MINUS muting` (group-scoped — a grant from the profile or a
  permission set assigned OUTSIDE the group is never muted), across object CRUD
  flags AND the `ViewAllData`/`ModifyAllData` system perms, for read / edit /
  delete / create. When muting flips a would-be "can access" into a
  precondition failure the verdict is `restricted`, and both the `PermissionGrant`
  reasoning step and a new top-level `mutedBy` name the muting set(s) so an
  auditor sees WHY. Only the modeled permission classes a muting node carries are
  subtracted; a muting node from a vault refreshed before the R6-06 extractor
  (no muted-perm data) or referenced-but-absent CANNOT be subtracted and is
  DISCLOSED as a possible overstatement (re-run `/sfi-refresh`), never silently
  treated as "mutes nothing". Muting is NOT subtracted from the record-visibility
  BYPASS stages (object/system View/Modify All) — use `effective_permissions` for
  the full net grant. The record-level `unknown` stages
  (RoleHierarchy/CriteriaSharing/Territory/ManualSharing) are unchanged.

- **`unused_fields_deep` live cross-check no longer times out composites or a
  large consented org (release-blocking perf).** The CR-CAP-L5 live-population
  cross-check auto-fired ~2 live `SELECT COUNT()` reads per high-confidence
  unused field WHENEVER the org had standing live consent — even with no
  `liveEnabled` passed. On a production-scale org (hundreds of high-confidence
  fields) that was hundreds of SERIAL live queries (~126 s measured, ≈9 s per
  large-object COUNT) — past the MCP SDK's 60s client timeout, so the tool
  hard-failed. Worse, three composites called the full handler and DISCARDED
  the live data (they read only the static `totalCount`): `tech_debt_score`,
  and `org_risk_report` / `release_readiness_report` which compose it — so all
  transitively fired the discarded live storm and timed out. Two bounds fix it:
  (A) `tech_debt_score` now passes an internal `staticOnly` guard so the whole
  composition stays offline (ZERO live queries) — byte-identical output, since
  the cross-check never changes `totalCount` / `byConfidence` / `byParentObject`;
  (B) the direct tool caps the cross-check at the first `LIVE_CROSS_CHECK_CAP`
  (3) high-confidence fields per page — sized from the measured ~9 s worst-case
  per-read cost so the worst case stays well under 60 s — and discloses "live
  population checked for the first N of M high-confidence fields on this page …"
  when the page holds more. The user-facing `field_cleanup_candidates` keeps its
  live enrichment (now bounded by the same cap). The eight-tier static logic,
  confidence tiers, pagination, byte budget, CSV path, and other disclosures are
  unchanged. This is a regression introduced by CR-CAP-L5; before it these paths
  were pure-offline.
- **`tech_debt_score` / `org_risk_report` / `release_readiness_report` no longer
  blow the 60s MCP client timeout on a large org (release-blocking perf).** On a
  production-scale gate vault (thousands of CustomFields) these three composites
  exceeded the MCP SDK's 60s default client timeout and crashed real hosts with
  `-32001`. Root cause was an N+1 query pattern in three composed hygiene
  handlers: each issued one DuckDB `listEdges` round-trip *per node* to read
  incoming edges — the composite chain fired ~17k separate queries (≈4-5 ms
  each on a cold 90 MB+ graph = 70-85 s). The fix routes every one of those
  incoming-edge reads through the existing batched `listEdgesForNodes` primitive
  (one `IN (...)` round-trip for the whole scan instead of one per node):
  - `unused_components` now batches each type's incoming edges (was one
    `listEdges` per scanned node — thousands on the CustomField scan).
  - `unused_fields_deep` fetches every matching field's incoming edges once and
    computes all three incoming-edge tiers (structural, LWC/Aura/VF `references`,
    integration `exposes`) in memory (was THREE `listEdges` per field).
  - `pii_inventory` batches the formula-source `references` lookups, and
    `collectPiiInventoryFields` (the composer path) classifies the corpus a
    SINGLE time rather than re-fetching and re-classifying the whole org on every
    output page. Every verdict is an existence / first-match check that does not
    depend on edge order, so output is byte-identical (the full mcp suite passes
    unchanged). Measured on the gate vault: `tech_debt_score` 9 978 → 410
    queries (~7.9 s → ~0.9 s), `org_risk_report` / `release_readiness_report`
    ~14 s → ~2 s end-to-end — an order of magnitude under the 60s budget.
- **`org_risk_report` / `release_readiness_report` residual grantedBy N+1
  batched (completes the perf fix above).** After the incoming-edge batching
  landed, a SECOND N+1 remained in `permission_risk_report`'s org-wide
  over-privilege scan (composed into both report tools): it looped over every
  Profile / PermissionSet node and issued one `listEdges` round-trip *per node*
  to read its outgoing `grantedBy` edges (object-level View All / Modify All).
  On a production-scale gate vault (thousands of permission containers) that was
  thousands of serial DuckDB queries, still pushing the two composites past the
  60s budget (~70-74 s measured). The scan now collects every container id up
  front and reads all their `grantedBy` edges through a SINGLE
  `listEdgesForNodes` `IN (...)` round-trip, then accumulates per node over the
  grouped edges in the SAME node-iteration → edge order as before. Because
  `listEdgesForNodes` preserves the same `(to_id, edge_type, from_id, source)`
  order `listEdges` returned and every verdict / roster / example is an
  existence-or-capped-push check that does not depend on edge order, the report
  output is byte-identical (the full mcp suite passes unchanged). A regression
  guard spies the DuckDB connection and asserts the grantedBy scan issues a
  bounded (O(1)) number of edge queries regardless of container count. The
  single-profile `profileFilter` path is already O(1) (one already-resolved
  node) and is left unbatched by design.
- **`unused_fields_deep` corpus lower-casing hoisted out of the per-field loop
  (completes the release-blocking perf fix — the residual cost was JS CPU, not
  queries).** With the DuckDB round-trips batched (above), the first COLD
  `unused_fields_deep` call — and therefore `tech_debt_score` / `org_risk_report`
  / `release_readiness_report`, which compose it — still ran ~68 s on a
  production-scale gate vault (hundreds of fields), tripping the 60s client
  timeout. The remaining cost was an O(fields × corpus) `toLowerCase()` blowup:
  the eight-tier text checks are case-insensitive, and each re-lower-cased every
  (large) corpus string — Apex `soqlStrings` / `unresolvedFieldReferences`,
  formula / validation-rule / workflow-rule text, layout placements,
  conditional-context expressions — once PER candidate field, so every corpus
  string was lower-cased ~N times for N fields. The scan now lower-cases each
  corpus string EXACTLY ONCE, before the field loop (a new `buildLoweredCorpora`
  pass: a lower-cased `Set` for the exact-equality layout tier → O(1) membership,
  pre-lowered string arrays for the substring tiers); the per-field check then
  lower-cases only the short apiName token and matches it against the pre-lowered
  corpus. Because lower-casing is idempotent and these are order-independent
  existence checks, the output is BYTE-IDENTICAL (verified by SHA over the full
  `unused_fields_deep` and `org_risk_report` responses on the gate vault before /
  after; the tool's unit suite passes unchanged). Measured cold on the gate
  vault: `unused_fields_deep` ~68 s → ~2 s, and all four composed tools now
  return in well under the 60s budget. A regression guard spies
  `String.prototype.toLowerCase` and asserts the call count stays O(fields +
  corpus), far below the O(fields × corpus) a re-introduced per-field
  lower-casing would produce.
- **Muting permission sets are now SUBTRACTED in `effective_permissions`
  (security-correctness).** Previously a `PermissionSetGroup` was expanded to the
  UNION of its member permission sets, but its muting permission set was only
  DISCLOSED — never netted out — so the tool could OVERSTATE access ("says the
  user can when they can't"). The `MutingPermissionSet` extractor now captures the
  permissions each muting set DENIES (object CRUD, field-level security,
  system/user permissions, custom permissions, Apex-class access) as node
  properties (`extractMutingPermissionSet` moved to
  `packages/extractors/src/muting-permission-set.ts`; a `true` flag means DENIED,
  mirroring the permission-set XML with inverted semantics). `effective_permissions`
  computes each group's grant as `union(members) MINUS its muting set(s)`, per
  modeled class, BEFORE the containers union max-wins — muting is **group-scoped**,
  so a grant conferred by the profile or a permission set assigned OUTSIDE the
  group is never muted. Surviving attribution rows gain a `mutedBy` annotation
  (which muting set(s) denied a would-be group grant); a grant no container
  confers is removed and counted in the disclosure. A muting node from a vault
  refreshed before this change (no muted-perm data), or referenced-but-absent,
  CANNOT be subtracted and is DISCLOSED as a possible overstatement (re-run
  `/sfi-refresh`) — never silently treated as "mutes nothing". Record-type
  visibility is not mutable and is never subtracted. The shared PSG helper gains
  `loadMutingPermissions` so other access tools can adopt the same subtraction;
  `object_access_audit`, `why_cant_user_see_record`, and the god-mode roster in
  `permission_risk_report` still show raw grant paths but now point at
  `effective_permissions` for the muting-correct net grant.

  > **Upgrade note:** muted permissions are captured at extraction time, so run
  > `sfi refresh` once to model muting in an existing vault; until then those
  > groups are disclosed as "muting not applied — possible overstatement".
- **`sfi mcp` startup's `sf org list` probe can no longer hang forever
  (CR-RV3b).** `defaultListOrgs` (the best-effort "which orgs are you
  authenticated to?" probe that builds the no-vault hint's org list) shelled
  out via a bare `promisify(execFile)` with no timeout — a wedged `sf`
  subprocess (e.g. stuck on an interactive re-auth prompt) could hang `sfi
  mcp` startup indefinitely; the existing try/catch degraded gracefully on a
  *failed* exec but never fired on one that simply never returned. The probe
  now routes through `execHelper` (`@sf-intelligence/core`), the shared
  cross-platform `sf` exec seam already used by refresh/init/auth/live-exec:
  it carries a `SFI_SF_EXEC_TIMEOUT_MS`-backed timeout (10-min default) with
  a SIGTERM→SIGKILL escalation, so a hung process is force-killed and the
  existing catch block degrades to an empty org list exactly as it does for
  any other exec failure — same graceful-degrade contract, now with an upper
  bound. Also gets Windows `sf.cmd` shim support for free (previously
  `execFile('sf', …)` could not launch a `.cmd` shim at all on win32; caught
  by the same try/catch, but silently, as a permanent empty-list result).
- **GlobalValueSet values now carry honest per-value `isActive`/`label`/`default`
  (CR-10b), instead of a bare fullName string.** The extractor's
  `properties.values` was `string[]` — no activation status, no label, no
  default flag — so `explain_field` had to wrap every GlobalValueSet-resolved
  picklist value as `isActive: true` **UNVERIFIED** (a deactivated GVS value
  could appear as selectable). `extractGlobalValueSet` now reads each
  `<customValue>` into the SAME H10 object shape the CustomField inline
  picklist and StandardValueSet extractors already emit — `{value, isActive,
  label?, default?}` — with `<isActive>` absent defaulting to `true`
  (Salesforce DX omits the element for active values, matching
  `custom-field.ts`'s `coerceIsActiveDefaultTrue`). Deactivated values are
  **RETAINED, never filtered**: dropping them would be the one inconsistent
  exception to this vault's retain-and-mark rule for picklist-shaped values,
  would lose the answer to "what values used to be in this set" for a value
  existing records may still hold, and confirmed real (a production-scale
  org's `GlobalValueSet` source carries deactivated entries side-by-side with
  active ones). `explain_field`'s `resolveGlobalValueSetValues` now routes
  through the shared `normalizePicklistValues` normalizer instead of a
  bare-string map, so a GVS-resolved picklist value's `isActive` is honest
  (matching an inline definition) and the `picklistValuesNote` UNVERIFIED
  disclosure no longer fires for the resolved case — it still fires when
  resolution fails (pre-0.1.10 vault or unretrieved value set). Back-compat:
  a pre-CR-10b vault's bare-string `values` still normalizes correctly
  (`{value, isActive: true}`) via the same shared normalizer.
- **`escapeMarkdownInline` now correctly handles a value containing a
  backtick (CR-16d).** The helper backslash-escaped an embedded backtick
  before returning inner text for a caller-supplied single-backtick fence —
  but per CommonMark, backslash escapes are inert INSIDE a code span (a span
  closes at the next backtick run of the same length as its opening run,
  full stop), so a value with an embedded backtick would still split the
  span early despite the backslash. Latent in practice (every current caller
  feeds a backtick-free Salesforce identifier), but the JSDoc's claim that
  the backslash "closes the span early... never" was wrong. The helper now
  OWNS the fence instead of assuming a fixed one: it picks a fence one
  backtick longer than the longest backtick run already in the value (so
  nothing in the value can match the fence length and close it early), and
  pads with a single leading/trailing space when the value starts or ends
  with a backtick (per CommonMark). A backtick-free value still gets the
  minimal one-backtick fence with no padding, so existing SF-identifier
  output is byte-identical. All five call sites (`component-markdown.ts`,
  `apex-markdown.ts`, `flow-markdown.ts` ×2, `org-card.ts` ×2) updated to
  stop wrapping the return value in their own literal backticks, since the
  helper now supplies the fence itself.

- **`componentTypeFromSourcePath` now resolves LWC/Aura bundle DIRECTORY paths
  (R6-29).** The exported dispatcher used by coverage reporting and by `sfi
  review-change`'s `git diff` path mapper computed `dirSegments` differently
  for `isDirectory: true` than `walkAndExtract`'s own internal call site: it
  kept the bundle's own basename (e.g. `orderCard`) as the last `dirSegments`
  entry instead of stripping it, so `dispatchFile`'s bundle branch — which
  reads the LAST segment expecting the PARENT dir name (`lwc`/`aura`) — always
  missed and returned `null` for every LWC/Aura bundle directory passed
  through the public dispatcher. `sfi review-change --diff` worked around this
  with its own hardcoded `lwc`/`aura` → type map rather than reusing the
  dispatcher (see below); the underlying dispatcher was otherwise silently
  wrong for any other caller passing a bundle directory. `fileName`/
  `dirSegments` are now derived identically regardless of `isDirectory` (last
  path segment is always the dispatch unit's basename, matching the walker),
  so `lwc/{bundle}/` -> `LightningComponentBundle` and `aura/{bundle}/` ->
  `AuraDefinitionBundle` resolve correctly from either call shape.
- **`sfi review-change --diff`'s bundle path mapping now reuses the fixed
  dispatcher instead of a hand-maintained type map (completes R6-29).** The
  `deriveComponentFromPath` bundle short-circuit previously duplicated the
  `lwc`/`aura` → `ComponentType` mapping locally (a workaround for the
  dispatcher bug above, landed with R6-16). It now truncates the changed-file
  path to the bundle directory and calls the now-working
  `componentTypeFromSourcePath(..., isDirectory: true)`, so the two bundle
  types are resolved from ONE source of truth instead of two. `BUNDLE_PARENT_DIRS`
  (`lwc`/`aura`) is exported from the refresh pipeline so this caller — and any
  future one — shares the canonical list rather than hand-maintaining a copy.
  Verified against real LWC and Aura bundle directories copied from a
  production-scale gate vault's retrieved source tree (not committed).
- **Retrieve manifest API version pinned at 62.0 (profile-grant safety).**
  During 0.2.0 development the manifest version was briefly raised to 64.0 to
  pick up `GenAiPlannerBundle` (R6-30), but a real-org retrieve proved that
  unsafe: at 64.0 the org describe surfaces the v65-gated `GenAiPlannerBundle`
  type, `selectManifestTypes` puts it in the combined manifest, and its
  `UNSUPPORTED_API_VERSION` failure trips the retrieve's binary-split
  fallback — which separates `Profile` (and the object-child types
  `ListView` / `ValidationRule` / `RecordType` / `WebLink` / `FieldSet`) from
  the `CustomObject` / `CustomField` / `ApexClass` members they must be
  co-retrieved with, so Salesforce returns profiles stripped of their
  `objectPermissions` / `fieldPermissions` / `classAccesses`. The version is
  therefore kept at **62.0**, which keeps the version-gated GenAI type out of
  the combined manifest so it stays whole and every co-listing-dependent type
  retrieves fully. `GenAiPlannerBundle` support is deferred to a future
  split-manifest pass (everything at 62.0 plus an isolated v65+ pass for the
  GenAI types alone, so a version-gated type can never poison the main
  retrieve). Verified on a real org — profile grants and object children fully
  populate after a refresh. `buildPackageXml` is exported and version-floor-tested.
- **Refresh manifest prunes standard objects the org lacks.**
  `manifestMembersForType` now intersects the modeled standard-object list with
  the org's describe-global, so a named-but-absent standard object (e.g. a Field
  Service object in an org without FSL) can no longer make the `CustomObject`
  retrieve fragile.

### Added
- **StandardValueSet extraction (R6-08).** Standard picklists (`Industry`,
  `LeadSource`, `OpportunityStage`, `CaseStatus`, …) were entirely unmodeled —
  zero `ComponentType`, zero extraction, no way to answer "what values does
  the standard Industry picklist allow?" or feed
  `what_if_remove_picklist_value` for a standard field. New `StandardValueSet`
  `ComponentType` (edge-less; a standard field's binding to its value set is
  implicit in Salesforce's own field typing, not a declared metadata pointer
  an extractor can read — emitting a fabricated edge would be a guess, not a
  parsed fact) with a generic extractor (`extractStandardValueSet`, mirroring
  `GlobalValueSet`'s shape) capturing `sorted`, `valueCount`, and
  `values: { apiName, active }[]` per entry — the Metadata API's
  `StandardValue` has no separate `label` field (verified against the
  Metadata API Developer Guide's field reference), unlike GlobalValueSet's
  `customValue`, so `apiName` (the `fullName`) doubles as the display value.
  Wired into `SUPPORTED_TYPES` + the extractor map + a `dispatchFile` route
  for `standardValueSets/*.standardValueSet-meta.xml` (folder/suffix verified
  against the same guide: "StandardValueSet components have the suffix
  `.standardValueSet` and are stored in the `standardValueSets` folder").
  **Known retrieval gap, disclosed rather than papered over:**
  `StandardValueSet` does NOT support the `*` wildcard Salesforce uses for
  every other metadata type in this pipeline's manifest — the Metadata API
  requires each standard value set to be named individually, and Salesforce's
  published name list runs into the hundreds and varies by which Industries
  clouds are installed. This change does NOT hardcode that list (an
  unverifiable or org-inapplicable name risks a worse failure — a malformed
  manifest entry can abort the whole retrieve, not just skip the one type)
  — see the `manifestMembersForType` doc in `refresh.ts` for the full
  disclosure. The extractor and dispatch are real, tested, and ready; a
  normal `sfi refresh` will request the type but come back with zero files
  until the manifest enumeration is built as a separate follow-up. No org in
  the gate-vault fleet retrieves `standardValueSets/` today, so this is
  verified against a synthetic fixture, not a live vault.

### Fixed
- **SamlSsoConfig never actually retrieved or extracted (R6-01).** The
  `SamlSsoConfig` extractor and `ComponentType` were written and exported, and
  `value-change-risk.ts` / `value-change-audit.ts` already queried
  `listNodesByType(ctx.graph, 'SamlSsoConfig', ...)` to gate the
  `FederationIdentifier` value-change verdict — but the type was never added
  to the refresh pipeline's `SUPPORTED_TYPES`, so it was never requested in
  the retrieve manifest, and the dispatcher had no `samlssoconfigs/` route,
  so even a manually-added file would have been silently skipped. The result:
  the SSO value-change logic always saw zero `SamlSsoConfig` nodes, regardless
  of whether the org had SSO configured. Fixed by adding `SamlSsoConfig` to
  `SUPPORTED_TYPES` + the extractor map + a `dispatchFile` route for
  `samlssoconfigs/*.samlssoconfig-meta.xml` in `refresh-pipeline.ts`. Suffix
  verified against the Metadata API Developer Guide ("SamlSsoConfig
  components have the suffix `.samlssoconfig` and are stored in the
  `samlssoconfigs` folder") — confirms the extractor's existing (lowercase,
  not camelCase) suffix expectation was already correct. No `METADATA_API_NAME`
  alias needed (the internal type name already matches the Metadata API
  `xmlName`). No org in the maintainer's gate-vault fleet has SAML SSO
  configured, so this is verified against a synthetic fixture mirroring a
  real Entra ID SSO config shape, not a live vault — flagged honestly rather
  than claimed as real-org-verified.
- **ListView legacy dotted addressing minted phantom field edges (R6-04).**
  `ListView` `<columns>`/`<filters>` field-identity extraction (CR-CAP-13 /
  CR-CAP-13b) was already shipped, but real gate-vault data from a large university org (580
  ListView files) surfaced a real, systematic gap: Salesforce's legacy
  dotted SOAP-style column addressing (`CONTACT.EMAIL`, `ACCOUNT.NAME`,
  `CASES.STATUS`, `CORE.USERS.ALIAS`, `CORE.PROFILE.NAME`, and 91 more
  distinct real tokens) slipped past the `<columns>` guard and minted
  `references` edges to `CustomField:` ids that can never resolve (the real
  node id is `CustomField:Contact.Email`, not `CustomField:CONTACT.EMAIL`).
  The `<filters>` guard already excluded these correctly via its existing
  blanket all-uppercase-no-`__` rule; only the `<columns>` guard
  (`isWellFormedColumnField`), which deliberately omits that blanket rule to
  keep real bare-uppercase standard fields (`NAME`/`TITLE`/`ABSTRACT`),
  needed the narrower dotted-only version of it. New shared
  `isLegacyDottedAddress` predicate skips (never guesses) these tokens on
  both sweeps and the skip is now disclosed via a new
  `properties.legacyAddressingRefsSkipped` count on the `ListView` node
  (omitted when zero). Verified against all 580 real ListView files in that gate vault:
  378 nodes (65%) carried at least one legacy token, 1,717 skipped in total,
  zero phantom-shaped edges remain among the 3,730 `references` edges
  produced, zero extraction failures. `field-lineage.ts`'s `list-view-filters`
  `dataNotAvailable` entry and `safe-to-delete-field.ts`'s `ListView` →
  `analytics`/`blocking` classification were already correct (verified, not
  changed) — the former honestly scopes the *runtime predicate evaluation*
  gap (not field identity, which is now composed), the latter classifies by
  `fromType` alone so it already covers the (now-cleaner) edges.

### Fixed
- **Flow→flow subflow edges — closing a false-"safe" deactivation verdict
  (R6-02).** The Flow extractor previously scoped out `<subflows>` entirely, so
  NO flow→flow edge existed. A subflow called by N parent flows therefore had
  zero surfaced dependents: `what_if_deactivate_flow` on that subflow read
  `safe` to deactivate (a wrong, destructive verdict) and `get_impact` saw no
  incoming callers. The extractor (`packages/extractors/src/flow.ts`) now emits
  one `references` edge per `<subflows>` element to the target `Flow:{flowName}`
  with `confidence: 'declared'` and `properties.referenceKind: 'subflow'` (plus
  the calling element name). A subflow target not in the vault (managed /
  uncaptured) is dangling-by-design — the edge is still emitted, exactly as
  `callsApex` emits to a possibly-absent `ApexClass:{name}`; nothing is
  fabricated.

### Changed
- **`what_if_deactivate_flow` now surfaces the INCOMING side.** Parent Flows
  that invoke a Flow as a subflow are BROKEN CALLERS on its deactivation,
  surfaced as a distinct `broken-caller` impact category. An **Active** parent
  forces the verdict to `blocking` (a subflow with active parents must not read
  `safe`); parents that are all inactive (Draft / Obsolete) are still surfaced
  but stop at `risky`. Only `references` edges with `referenceKind: 'subflow'`
  count — a FlexiPage that merely embeds the flow, or any `grantedBy` / `parentOf`
  edge, is access/structure, not a broken subflow caller (access ≠ usage). The
  OUTGOING subflow calls a Flow makes are also now surfaced (`metadata-blocker`).
  Disclosure updated: the Apex `Flow.Interview` / `@InvocableMethod` invocation
  path and non-metadata launch points remain invisible.
- **`explain_flow` now models subflow calls.** A new `subflowCalls[]` axis lists
  the declared `<subflows>` this Flow invokes, each naming the target
  `Flow:{flowName}` and whether it `resolved` in the vault (a dangling
  managed/uncaptured subflow surfaces `resolved: false`, never fabricated).
  Previously subflow calls were unmodeled and thus invisible to the narrative.

> **Upgrade note:** subflow edges are minted at extraction time, so run
> `sfi refresh` once to backfill flow→flow subflow edges into an existing vault.

### Added
- **`sfi.explain_error` — decode a pasted Salesforce error to its source
  component.** Support's first-line question ("a user got this error saving a
  record — what caused it?") had no tool: the vault already holds every
  `ValidationRule.errorMessage`, every Flow, every Apex class/trigger name, and
  every `DuplicateRule`, but nothing mapped an error TEXT back to its source
  node. The new tool takes `{ errorText, object? }` and runs ranked, **heuristic**
  match strategies, each candidate carrying its own `confidence` + a `why`:
  (1) validation rule — the message segment (after
  `FIELD_CUSTOM_VALIDATION_EXCEPTION`, or a bare pasted banner) is compared to
  every `ValidationRule.errorMessage`; an EXACT trimmed equality is `declared`,
  a normalized/substring match is `heuristic`; returns the rule id, object,
  `active` flag, and `errorConditionFormula`. (2) flow fault — recognizes
  fault-email shapes ("An error occurred at element X", "Flow API Name: Y") and
  resolves the flow API name to a real `Flow:` node (`declared`); the element
  name is echoed and cross-checked against the flow's action calls but is not
  fabricated as a node (flow elements are not separate graph nodes offline).
  (3) apex — recognizes stack frames ("Class.X.method: line N",
  "Trigger.T: line N", "System.XException") and resolves the class/trigger to a
  real node (`declared`); the offending line is not resolvable offline.
  (4) duplicate rules — "duplicate" phrasing + an `object` hint lists the ACTIVE
  `DuplicateRule` nodes on that object (`heuristic` listing). (5) status-code
  taxonomy — recognizes common REST/API statusCodes (`REQUIRED_FIELD_MISSING`,
  `UNABLE_TO_LOCK_ROW`, `INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY`,
  `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`, …) and explains the CATEGORY + which
  component TYPES produce it — clearly category-level, never a specific match;
  automation-abort codes cross-reference the triggers/flows declared on the
  hinted object (`triggersOn`). `disposition` mirrors `sfi.resolve`
  (`matched` / `ambiguous` / `none`) and FAILS CLOSED — a source is never
  fabricated; on `none`, `triedStrategies` + `nextSteps` guide the next move
  (e.g. `sfi.what_happens_on_save`). Matching is against DECLARED metadata, not
  a runtime trace — every candidate confidence and a verbatim `disclosure` say
  so; the candidate list is byte-budgeted. Discoverable via the semantic funnel
  (new utterance band in `funnel-utterances.ts`) and the `understand` capability
  category.

### Fixed
- **Case-variant SOQL/Apex field references no longer dangle off the graph
  (R6-03).** Apex and SOQL are case-insensitive, so `[select id from account
  where custom_flag__c = true]` emitted parsed AST edges targeting
  `CustomField:account.custom_flag__c` — a dangling id the exact-match edge
  walk could never attach to the vaulted `CustomField:Account.Custom_Flag__c`
  node. Edge-only consumers (`safe_to_delete_field`, `unused_fields_deep`
  tier 1, `find_dead_code`) then read the field as unreferenced — a false
  "safe" on a destructive verdict. A new import-time
  `canonicalizeFieldEdgeTargets` pass (graph `import.ts`, mirrored on the
  incremental `computeChangeSet` path) remaps a DANGLING `CustomField:` edge
  target onto the vaulted field id when it matches case-insensitively —
  producer-agnostic (apex-ast, apex-scanner, frontend scanners). Honesty
  invariants: exact-id matches are final, an unknown field stays dangling
  (absence preserved, never invented), a synthetic case-collision drops the
  key (ambiguity is never guessed), and edge `properties` keep the verbatim
  source-text casing as raw evidence.

### Changed
- **Inline-SOQL field-usage disclosures narrowed to the real blind spot
  (R6-03).** The default-on Apex AST pass already resolves fields referenced
  inside inline static SOQL (SELECT / WHERE / ORDER BY / GROUP BY / HAVING,
  aggregate and date-function arguments) and CONSTANT-string
  `Database.query` literals into `confidence: 'parsed'` field-level
  readsFrom edges — but `unused_fields_deep`, `safe_to_delete_field`, and
  the `developer-apex-refactor` / `developer-code-quality` skills still
  disclosed ALL SOQL field usage as invisible. Disclosures now state
  honestly: inline static SOQL is resolved at parsed confidence;
  string-BUILT dynamic SOQL (`Database.query('SELECT ' + f + ...)`) remains
  the disclosed blind spot; files the AST failed to parse fall back to the
  regex scanner (counted in the manifest `apexAst` block). New parser tests
  pin the clause-by-clause contract, including that concatenated dynamic
  SOQL emits NO edges.

### Docs

- **Fixed Apex analysis documentation drift.** The parser-grade Apex AST pass
  runs by default on every refresh (since P13-AST-flip), emitting `confidence:
  parsed` edges for resolved field reads/writes and cross-class calls; the
  regex/token scanner backfills with `confidence: heuristic` edges (parse
  failures, recall gaps). Updated CLAUDE.md (boundary disclosure), README.md
  trust glossary (already accurate), developer-code-quality skill (clarified
  that the quality recognizer is heuristic, but Apex extraction uses AST),
  and architect-impact-analysis skill (split Apex edge tiers into parsed and
  heuristic rows in the confidence table, updated disclosures). All changes
  are markdown-only; no product code or tool descriptions modified.

### Fixed

- **`get_component` no longer refuses `maxBodyBytes: 0` on a huge node
  (R6-31 — recovers the agent-eval grounding metric).** `maxBodyBytes`
  historically bounded only `body`; `frontmatter` (the raw rendered YAML)
  and `properties`/`referenceIds` (the graph node's own data) were always
  returned in full. Fine for an average component, but a Profile with
  thousands of `fieldPermissions`/`objectPermissions` renders a frontmatter
  blob and a `properties` object each well past the ~40 KB global MCP
  response budget on their own — so a caller passing `maxBodyBytes: 0` to
  probe "does this component exist, what does it look like" (the grounding
  pattern used by `synthesize_answer` and QA harnesses) got the global
  `oversize` refusal instead of an answer, even though the one field it
  asked to skip (`body`) was never the problem. This was the sole cause of
  ~8 of 9 new ungrounded citations in the agent-eval harness
  (`groundedClaimRate` 0.921 < 0.95) — every answer citing a large Profile
  lost its grounding probe. When `maxBodyBytes` is `0` or small (below the
  new `METADATA_PROBE_MAX_BODY_BYTES` threshold), the handler now builds
  the response from a bounded metadata PROJECTION instead: `frontmatter`
  capped the same way `body` already was, `properties` reduced to whichever
  entries fit a small fixed budget (in practice the scalar fields survive
  and the huge arrays/objects are the ones dropped), and `referenceIds`
  capped to a fixed budget with the true total disclosed via the new
  `referenceCount` field. `data.metadataOnly` and a new `data.disclosure`
  string name exactly what was omitted, so the response stays honest —
  never a silent subset. This guarantees `maxBodyBytes: 0` never produces
  the global `oversize` error again. The default call (no `maxBodyBytes`)
  and any explicit value at/above the threshold are UNCHANGED — full
  `frontmatter`/`properties`/`referenceIds`, exactly as before. Verified on
  a production-scale gate vault: `get_component({ id: 'Profile:Admin',
  maxBodyBytes: 0 })` went from `error.kind: 'oversize'` (230-byte error
  envelope) to `ok` with a 5 336-byte metadata envelope disclosing 4 of 15
  properties and 2 404 of 2 456 outgoing edges not expanded.

- **Case-variant SOQL/Apex object references no longer dangle off the graph
  (R7-W3).** Mirrors R6-03 on the object side of the same problem: `[select
  id from account]` emitted a heuristic `readsFrom` edge targeting
  `CustomObject:account` — a dangling id the exact-match edge walk could
  never attach to the vaulted `CustomObject:Account` node. Any
  `CustomObject:`-prefixed target is susceptible (SOQL FROM, platform-event
  `listensTo`, trigger `on Object`, lookup/master-detail declarations), and
  every object variant (CustomObject / CustomSetting / CustomMetadataType /
  PlatformEvent / BigObject / KnowledgeArticle) shares the node type
  `CustomObject` regardless of its declared variant, so a single check covers
  all of them. A new `canonicalizeObjectEdgeTargets` pass (graph `import.ts`,
  mirrored on the incremental `computeChangeSet` path) remaps a DANGLING
  `CustomObject:` edge target onto the vaulted object id when it matches
  case-insensitively. It shares its remap engine
  (`canonicalizeEdgeTargetsByCase`) with the R6-03 `canonicalizeFieldEdgeTargets`
  fix — same honesty invariants: exact-id matches are final, an unknown
  object stays dangling (absence preserved, never invented), a synthetic
  case-collision drops the key (ambiguity is never guessed), a namespaced id
  (`ns__Obj__c`) is case-folded as one unit, and edge `properties` keep the
  verbatim source-text casing as raw evidence. `canonicalizeFieldEdgeTargets`'s
  observable behavior is unchanged (regression-tested).

## [0.1.26] — 2026-07-10

### Changed
- **Metadata-only npm patch.** Homepage now points at the canonical domain
  `https://sfi.auditforce.cloud` (migrated off the prior Pages URL). No product
  code changed since 0.1.25 — only the publishable package metadata.

## [0.1.25] — 2026-07-02

Headline: **the org's `<description>` text is now captured and queryable.** Four
metadata types silently dropped their descriptions; now every type that carries
one keeps it, and a new `missingDescription` filter answers "which reports /
objects / permission sets are undocumented?" — previously an honest gap.

> **Upgrade note:** the description is captured at extraction time, so run
> `sfi refresh` once on 0.1.25 to backfill descriptions into an existing vault.

### Added
- **Description capture across every metadata type that carries one.** The
  org's top-level `<description>` is now extracted into `node.properties.description`
  for the four generic metadata types that previously dropped it — `Report`,
  `Dashboard`, `ReportType`, and `PermissionSetGroup` (`extractReport`,
  `extractDashboard`, `extractReportType`, `extractPermissionSetGroup` in
  `enterprise-metadata.ts` now pass `extraProperties: ['description']`). The
  seven custom extractors (`CustomObject`, `CustomField`, `PermissionSet`,
  `Profile`, `Flow`, `ValidationRule`, `RecordType`) plus `CustomTab` and
  `CustomApplication` already captured it. The description renders as a paragraph
  in the component markdown (unchanged renderer). Verified offline against a real
  ~1,300-object source tree: captured counts match the source's
  files-with-`<description>` ground truth exactly for every generic type (Report
  221, Dashboard 17, PermissionSetGroup 16, plus CustomField 1315, ValidationRule
  306, PermissionSet 159, RecordType 86, CustomObject 75). Only the genuine
  top-level `<description>` is captured — nested element-level descriptions (e.g.
  a Flow decision's own `<description>`) are intentionally excluded, and Profiles
  capture their single real top-level description with no fabrication.
- **`list_components` documentation-coverage filter.** New `missingDescription`
  / `hasDescription` boolean flags answer "which reports / objects / permission
  sets / validation rules have no description?" — previously an honest gap. Backed
  by a `descriptionPresence: 'present' | 'absent'` narrow in the graph layer
  (`queries.ts`) that folds key-absent, JSON-null, and empty-string all into one
  honest "absent" bucket via `coalesce(json_extract_string(...,'$.description'),'')`.
  The narrow is applied to both the page query and the authoritative
  `countNodesByType` total; the two flags are mutually exclusive (invalid-query
  guard). **Honesty caveat, disclosed in the tool description:** for a type whose
  source carries no `<description>` element at all (`ListView`, `CustomPermission`,
  `MutingPermissionSet`, `CustomMetadata`), `missingDescription` matches *every*
  node — the answer means "no description in this metadata type", not "left blank".

## [0.1.24] — 2026-07-02

Headline: **assignment-data engine + router honesty R4 + experimental embeddings.**
Three simultaneous workstreams: four new live tools close the "who holds X / who's in
Y" honest-gap family; the router's fourth honesty round adds write-evasion hardening,
forecast/authorship gaps, narrowed clarification, and show-me candidate coverage; and
an opt-in RRF hybrid embeddings layer sits behind a feature gate for early adopters.
Tool count 172 → 176.

**Measured on the maintainer's two real-org suites (2,000 + 2,995 primary
questions, 12,352 turns, 0 route errors), 0.1.23 → 0.1.24:** honesty rose on
both — declined-correctly 82.9 → 83.8% (2K) and **57.2 → 66.9% (3K, +9.7)** —
while over-routing *fell* on both (2K 89 → 88; **3K 229 → 185, −44**), reversing
the eagerness regression 0.1.23 introduced. The injection/write-evasion family
dropped from 8 leaks to 1 (a read-only report with execution skipped, unchanged
since 0.1.23); the curated write-execution set is 24/24 refused. Answer-recall
held (2K 82.9%, 3K 80.2%), recall@3 61.1, needs-live 76.9 → 78.1%. The recall
gain came from *precision* this round, not more eagerness — the opposite of the
0.1.23 trade.

### Added
- **`sfi.live_permset_holders`** — who HOLDS a permission set, permission set
  group, or profile (`kind: permissionSet | permissionSetGroup | profile |
  auto`), answered from the live org. PSG-trap-aware: direct holders and
  via-group holders (`PermissionSetGroupComponent`) are reported separately
  with a deduped `effectiveTotal`, so the count is audit-grade instead of
  confidently understated. True count first, expired assignments excluded and
  disclosed, 500-row cap with byte-fit that never understates totals, keyset
  paging (`afterId`/`nextAfterId`), optional per-profile buckets. This also
  answers the name-by-name **profile roster** family.
- **`sfi.live_user_permsets`** — the REVERSE direction: what a named USER
  holds. Direct permission sets vs via-PSG assignments (with expirations),
  profile named; `PermissionSet.IsOwnedByProfile = false` is pinned into every
  assignment query so the system profile-owned row never masquerades as a
  direct assignment. Pairs with vault `sfi.effective_permissions` for a
  dual-provenance answer (live = which grantors; vault = what they grant).
- **`sfi.live_group_members`** — who is IN a queue / public group right now:
  users, nested groups (expanded at most ONE level, fail-closed and stamped
  `expansion: 'partial-one-level'`), role-based members surfaced as ROLE
  entries (never silently expanded), queue `supportedObjects` ("can this queue
  own Case"), and a measured `vaultDeclaredMemberCount` vs
  `liveDirectMemberCount` drift check.
- **`sfi.live_zombie_accounts`** — active users with login access but ZERO
  permission-set/PSG assignments (single anti-join on
  `PermissionSet.IsOwnedByProfile = false`; disclosed bounded client-diff
  fallback when an org rejects the anti-join). Output states verbatim that a
  "zombie" still holds everything its PROFILE grants. Optional
  `minDaysInactive` / `includeAllUserTypes`. Dormancy-only questions stay on
  `sfi.live_inactive_users`.
- All four follow the live-plane contract: consent-gated (`sfi.live_consent` /
  `SFI_LIVE_PLANE_ENABLED` / `liveEnabled`), budgeted
  (`SFI_LIVE_QUERY_BUDGET`, budget exhaustion is an honest error, never a
  silent fallback), read-only SOQL, `provenance: live_org` point-in-time
  stamps. No user identifiers land in the vault — the counts-only facts pin
  is untouched.
- **`sfi.coverage_report` `assignmentData` section** — runtime assignment
  data (User / PermissionSetAssignment / GroupMember) is reported as
  "not in vault **by design**" (a runtime data object, not a retrieve gap),
  naming the four live tools, current live-consent state, and the counts-only
  facts snapshot presence/timestamp. `sfi.health_check` carries the same
  block informationally — it never degrades status; a >30-day-old counts
  snapshot earns an advisory only.

### Changed
- **Router retargets (same change as the tools — no contradictory gates):**
  `permset-user-roster` ("which users have permission set X") flips from
  honest-gap refusal to `sfi.live_permset_holders`; `profile-user-roster`
  drops its partial-answer gap (the name-by-name roster is now built);
  `unassigned-permset-groups` and `permset-group-grants` flip partially to
  `sfi.live_permset_holders` (per-PSG zero-holder check and PSG containment —
  the enumerate-all-PSGs sweep and the 2-hop "which PSG grants custom
  permission X" chain remain disclosed gaps); NEW `queue-group-member-roster`
  arm ("who's in the Support queue") routes `sfi.live_group_members`; NEW
  `user-permset-holdings` arm ("what permission sets does Jane have") routes
  `sfi.live_user_permsets` + `sfi.effective_permissions` as an ordered
  dual-provenance pair; `empty-queues-groups` keeps the vault scan primary and
  appends `sfi.live_group_members` for runtime verification.
- The vault-side assignment disclosures (`object_access_audit`,
  `who_can_access_object`, and friends) now name the concrete live tools
  ("answerable via the live plane: …") instead of a generic "run the live org
  plane" pointer.
- **Router R4 — honesty + candidate coverage:**
  Injection/write-evasion hardening (indirect re-delegation attempts and
  tool-self-capability asks refused with a read-side alternative);
  forecast/authorship honest-gaps (predictive "how will X change by…" and
  authorship/attribution asks return honest gaps naming the nearest real reads);
  narrow clarification re-introduced for genuine same-name collisions that
  the R2b rebalance over-suppressed; show-me candidate coverage (visual/UI
  render requests clarify to the relevant read tool rather than silently
  mis-routing).

### Experimental
- **Embeddings hybrid (`SFI_EMBEDDINGS=1`, off by default)** — an opt-in
  RRF hybrid layer that fuses the existing lexical TF-IDF candidates with a
  locally cached neural sentence-embedding model (`Xenova/all-MiniLM-L6-v2`,
  ~23 MB, downloaded once on first use from HuggingFace Hub into
  `.sfi-embed-cache/`). Affects candidate ranking only — the honesty/refusal
  decision and the `route.tools` deterministic plan are untouched.
  Graceful lexical fallback when the model is absent or the embed fails;
  `allowRemoteModels` is disabled, so the funnel can never phone home at
  query time. Requires `npm i @huggingface/transformers` in your project (not
  bundled). See `docs/configuration.md §Embeddings` for full opt-in details.

## [0.1.23] — 2026-07-02

Headline: **80% crossed — candidate generation and honesty seams in the same
release.** Two eval-driven rounds on 0.1.22's architecture. Measured on the
same 2,000-question real-org bank: answer-clean **77.6% → 80.5%** raw
(**81.0%** relabeled), honesty over-routes **down** 97 → 89 with **zero false
refusals**, funnel-blind recall@8 **57.3% → 69.8%**, follow-ups with host
context 67.0%. Three-release trend on the same bank: 62.9 → 72.0 → 77.6 →
**80.5%**.

### Added
- **Runtime-analytics honest-gap arms** — the refusal gate now recognizes the
  unmodeled telemetry families and discloses the gap (naming the nearest real
  reads) instead of routing: per-user login events/sessions/last-login
  rosters, automation execution traces and aggregate run counts, run/failure
  forensics ("the error message from the last time X failed"), CPU/heap
  profiling, debug-log retrieval, SOQL execution plans, message delivery
  counts and sent-message content, site/community click analytics,
  record-level before/after field history, and record-access audit events
  ("who accessed…"). Precision-guarded: dormancy questions still reach
  `live_inactive_users`, login IP ranges still reach `profile_security`,
  `System.debug` code searches still reach `search_apex_source`, static
  reference counts and save-order questions route unchanged.
- **Run-imperative refusal** — "run the X flow against test data for me" /
  "execute the batch job" is refused as `refused-write` (executing automation
  mutates the org) with a read-side alternative describing what the
  executable WOULD do (`explain_flow`, `scheduled_job_catalog`,
  `what_happens_on_save` by target). Permission/hypothetical frames ("who can
  run…", "what happens if I run…", "how do I run…") route normally.
- **Privilege-escalation injection arm** — "sudo …" and grant-to-self asks
  ("give me full/admin access") land `refused-injection`; READ delivery asks
  ("give me the FLS grant list…") are unaffected.
- **`permset-group-grants` capability gap** — "which PSG grants the X custom
  permission / the Y role" discloses that PermissionSetGroup composition is
  not modeled instead of advisory-routing to permission tools that cannot
  answer it; PSG→permission-set REFERENCE reads stay routed.
- **Gap detection before context continuation** — a follow-up that is itself
  gap-shaped (judgment, delivery/export, tool-self-capability,
  deployment-status) never inherits `previous.tool`; it returns a
  non-executable `context-gap-followup` route with an honest disclosure.
  Legitimate continuations ("is it safe to delete?", "what about on
  Contact?") are unchanged, and a gap-shaped question WITHOUT context routes
  exactly as before.
- **Business-user register corpus** — the funnel utterance corpus grew a
  non-technical phrasing band ("what business process does this flow
  support", "the 10,000-foot view", "which automation is Salesforce going to
  sunset", "a reference sheet for the business team", "who's been making the
  most changes lately") plus matching synonym/idiom bridges (sunset→retire,
  flips→transition, grade→health, "kicks in"→fires, "big picture"→overview).
  Business-user recall on the additions-tuning set rose 60.9% → 76.1% with
  zero regressions.
- **`component-type` intent** — "is <Name> a flow or a trigger?", "…has
  'Trigger' in the name but is it actually a test class?", "what type is
  that?" now routes resolve-first with both family explainers; a same-name
  cross-type collision is treated as the ANSWER (resolve enumerates it), not
  an ambiguity block. Type-confusion trap family: 52.2% → 91.3%.
- **Type-confusion premise disclosure** — when a type-scoped resolve finds
  nothing ("the X permission set") the premise check now retries UNSCOPED
  before declaring nonexistence: a strong match under a different family
  discloses "TYPE CHECK: X exists as <realType>, not as a <statedType>" and
  keeps routing on the component that actually exists. Pure ghosts still get
  the existence PREMISE CHECK and still never advisory-route.
- **Genuine-tie clarifications restored (post-P4 rebalance)** — quoted bare
  labels ("the 'Status' field") now reach entity resolution; a question that
  itself asserts a same-name family ("three different things called Status")
  always clarifies; a bare label the resolver silently picked one of several
  identical same-name parents for ("the 'Concentration' field" ×3 parents)
  clarifies; and a compound vault+live ask ("what breaks AND is it actually
  running in production") returns a two-plane tool-choice clarification.
  Additions-tuning clarify 3/13 → 9/13; the P4 junk-tie suppression is
  unchanged (no previously-clean answer question started blocking).
- **CI self-recall gate** — new test (`funnel-self-recall.test.ts`): every
  candidate-eligible tool must retrieve itself in the pure-funnel top-8 for
  ≥70% of its own utterances, so a tool invisible to the funnel is a CI
  failure forever (measured floor at landing: 77.8%).

### Fixed
- **Write-gate impact carve-out** — "can you deactivate X safely? I need to
  know what depends on it" is a what-if impact ask, not a mutation
  instruction: `safely?` and explicit dependency/breakage questions now
  excuse the write-imperative refusal. Bare imperatives still refuse.
- **Shield event-monitoring log retrieval** — "show me the event monitoring
  log from last Tuesday" now lands the same runtime-telemetry honest-gap as
  debug-log retrieval (additions-tuning honest-gap 16/16).
- **`website/recalibrate.mjs` stale-count bug** — the capabilities.html
  rewrite rules were spacing/markup-sensitive and silently no-opped when the
  page copy reflowed (the shipped stale "171 tools"). Rules are now
  whitespace- and markup-tolerant, and a post-rewrite tripwire warns on any
  surviving tool-count string that disagrees with the registry.

## [0.1.22] — 2026-07-02

Headline: **the router now advises — it does not decide.** This release
completes the advisory architecture the router has been moving toward since
hybrid mode became the default (0.1.10): `sfi.route_question` is a
grounded, fail-closed advisory layer — it surfaces ranked tool candidates plus
explicit disclosures (refusals, premise checks, clarifications, context
application) and the **host LLM decides** which tools to run. Questions that
should never execute are now refused *by shape* before any scoring; questions
no deterministic rule covers get an honest advisory route instead of a dead
`unrouted`; and terse follow-ups resolve through a host-passed context param
with zero server-side conversation state. All numbers below were measured on a
2,000-question evaluation against a real production-scale org vault (plus a
separate 500-question routing sweep), compared against the 0.1.21 baseline.

### Added
- **Refusal-shape gates** — score-independent detectors that run on the raw
  question BEFORE intent matching, in both router modes. Write imperatives
  aimed at the agent ("delete the X field for me") return `refused-write` with
  empty tools and a **read-only alternative** by verb family
  (`safe_to_delete_field`, `what_if_merge_profiles`, `get_impact`, …);
  prompt-injection / record-value exfiltration returns `refused-injection`
  with candidates and guidance suppressed; runtime telemetry no tool models
  returns `honest-gap-runtime` naming the nearest real reads; non-Salesforce
  asks return `out-of-scope`. Every refusal is non-executable by construction
  (`tools: []`, structured `route.refusal`), and legitimate permission /
  hypothetical reads ("am I allowed to edit…", "is it safe to…") are explicit
  excluders that route normally.
- **Funnel-primary advisory routing.** When no deterministic intent matches
  and nothing else stopped the route (no clarification, clean premise), a
  pure-cosine top candidate scoring ≥ 0.26 (floor calibrated 0.30 → 0.26 in
  the Phase-7 harness re-run; over-route and sweep-blocked tripwires held)
  upgrades the dead `unrouted` to
  intent `funnel-advisory`: top-3 funnel tools, confidence `low` by
  construction, reason flagged FUNNEL-DERIVED — an advisory pick for the host
  to verify, never a command. Candidate rows now also carry `cosine`, the raw
  pre-fusion semantic score, so a host can tell semantic support from regex
  assertion.
- **Funnel recall: per-tool utterance corpus + weighted synonym expansion.**
  A generated corpus of 1,125 synthetic question phrasings across the full
  tool registry (registry-parity tested) now feeds the semantic funnel, and
  synonym expansion is weighted (originals weigh 1, expansions 0.5, never
  downgrading) with the generic-Salesforce synonym table grown 54 → 146 keys.
- **Conversation context (`context.previous`)** on `sfi.route_question` —
  stateless, host-passed, nothing stored server-side. Enables pronoun/ellipsis
  entity substitution (exact-id, never fuzzy), advisory tool continuation
  (confidence capped at `medium`; plane always from the live tool registry;
  type-gated), re-parameterization ("what about on Contact?"), and
  ordinal/descriptor clarification picks ("the second one") that re-dispatch
  through the existing clarification contract. Refusal gates run before any
  context logic; a self-contained question ignores context (omitting the param
  keeps behavior identical); when context changes the route the response
  discloses it in `route.contextApplied`. Host contract documented in
  `docs/routing.md`.
- **`docs/routing.md`** — the host-developer contract for advisory routing,
  refusal gates, clarifications, premise checks, and the context param.

### Fixed
- **Clarification hygiene + qualified-entity auto-resolve.** Clarifications
  are a last resort: an object word next to a same-named field, a type word
  after a name ("the X object/flow"), or a literal API name in the question
  auto-resolves instead of blocking; fuzzy acronym-graze rivals and
  far-below-top junk no longer appear as options; complementary readings stack
  their tools in one route instead of asking which-first; a vault-vs-live
  near-tie is decided by the question's own runtime-data language (only the
  destructive-vs-read-only tie still blocks).
- **Live-plane reachability.** Runtime-data questions (picklist usage,
  record-level automation activity, counts/aggregates phrased informally) now
  reach the `sfi.live_*` roster instead of dead-ending on vault tools — with
  the guard in the other direction verified (schema questions never get
  hijacked to live).
- **Code-literal searches route to source grep.** "Which class handles the
  System.debug output…" routes to `search_apex_source` instead of the
  audit-trail read.
- **`route_question` advertised-schema drift.** The `mode` parameter was
  accepted by the handler but missing from the advertised input schema; both
  `mode` and the new `context` are now advertised, with a test pinning
  Zod↔advertised-schema key/enum parity.

### Changed
- **Positioning.** README, npm README, and docs now state the architecture
  plainly: sf-intelligence is a grounded, fail-closed backend for AI
  assistants working in one Salesforce org — not a standalone chatbot. The
  funnel advises (candidates + disclosures + advisory routes); the host LLM
  decides; the engine grounds every answer in the vault and fails closed.
- **False premises block advisory upgrades.** The premise check now runs
  before funnel-primary: a question naming a component the resolver cannot
  find keeps its premise disclosure and never earns a `funnel-advisory` route.

### Measured (2,000-question real-org evaluation, vs 0.1.21)
- **Over-confident routes on honesty-labeled questions: 69 → 11**, with
  **zero false refusals** — all 64 questions independently relabeled as
  genuinely answerable still route.
- **Blocked-by-clarification misses: 115 → 11**; each surviving clarification
  was individually verified to be a genuine same-name ambiguity.
- **Misses whose correct tool was already a candidate, now routing clean to
  it: 0 → 85 of 271.**
- **Funnel-blind recall@8: 0 → 57.3%** (146/255 misses whose correct tool was
  absent from the candidate shortlist now surface it in the top 8).
- **Live-plane reachability: 92 → 125 of 161** needs-live questions (~78%),
  with zero previously-passing routes regressed.
- **500-question routing sweep: clean 387 → 414, blocked 33 → 8**, zero
  errors.
- **Follow-up turns (with host-passed context): 21.7% → 66.7%** of a
  previously-failing follow-up cohort now routes executable; 41/41
  self-contained follow-ups return identical output with context present vs
  absent, and a previously-passing cohort is 59/60 verdict-unchanged.

## [0.1.21] — 2026-07-01

Headline: **routing reach + two correctness fixes**, driven by a 500-question
stress test against a real org. The knowledge base was already accurate; the
router was under-delivering — over-clarifying answerable questions, latching
onto qualifier words, and hard-erroring when a resolved Flow hit an Apex-only
tool. This release closes those gaps and fixes two tools that returned nothing.

### Fixed
- **`list_components` now lists grant-heavy types fully.** Profile /
  PermissionSet rows carry tens of KB of declarative grants; the page-size
  budget measured the full row, so a 59-profile org returned **one profile per
  page**. Oversized rows are now slimmed to identity + scalar flags (marked
  `propertiesTruncated`, top-level `propertiesSlimmed`) before the budget check —
  all 59 fit one page; use `get_component` for a row's full detail.
- **`field_mapping_between_objects` works in a single-vault install.** `vault`
  was required and resolved through a registry that is empty in a normal
  `sfi mcp` session, so it returned `fieldCount: 0` for both objects — no working
  invocation existed. `vault` is now optional and defaults to the served vault.
- **Router — an exact name wins over a superset.** A uniquely-named component
  (e.g. a flow whose api-name is also a substring of a longer flow's name) is now
  resolved as an exact match instead of blocking with a "which did you mean?"
  menu; genuine same-name collisions still clarify.
- **Router — spurious over-clarification.** A bare schema noun in the question
  ("trigger", "profile", "field", "object") was promoted to a fuzzy entity
  lookup and blocked with a menu of unrelated components — even when the object
  was already given or the resolver returned an exact match. Schema nouns are now
  intent signals, and an exact disposition is honored over the inline extractor.
- **Router — Flow entities no longer hard-error.** A question whose entity
  resolves to a Flow routed to Apex-only tools (`call_graph`,
  `explain_apex_method`) that fail closed. A type-guard now substitutes the
  Flow-appropriate tools (`explain_flow`, `who_can_run`, `get_impact`).
- **Router — qualifier words no longer hijack intent.** "bulk"/"load",
  "integration"/vendor-sync, "seats"/"license", "compliance", "best practice" no
  longer outrank the head-noun intent (save-order, field-access, test-coverage,
  what-if).
- **Router — wrong-plane fixes + what-if routing.** Coverage asks route to the
  coverage tools, API-version asks to `tech_debt_score`, empty-object asks to the
  live plane; disable/deactivate asks route to `what_if_disable_trigger` /
  `what_if_deactivate_flow` (permission-set deactivation routes to
  `permission_risk_report` with a disclosure that no dedicated simulator exists).
- **`find_component_usages` reverse custom-permission lookup.** A
  `CustomPermission` target now surfaces the permission sets that grant it in a
  `grantedBy` section (grants stay separate from usages).
- **`effective_permissions` now unions `recordTypeVisibilities`** across the
  profile + permission sets, with per-container attribution.

### Changed
- **False-premise questions are downgraded, not asserted.** When a named entity
  can't be found, the route carries a `PREMISE CHECK` disclosure and low
  confidence instead of routing clean+confident (the fail-closed tools still
  back-stop it).
- **Lifecycle phrasing coverage.** "What runs automatically when a Lead is
  converted?" and "What runs on Lead conversion?" now route to
  `lifecycle_process`.

### Added
- **Router reach — ~110 previously-unreachable questions now route.** A
  500-question real-org stress test found a large class of questions where a
  capable tool existed but no routing rule reached it (named-flow narration,
  whole-transaction save order, granter-specific access asks, field forensics,
  what-if deactivation, CDC/async, discovery/meta). High-precision rules now
  route them — each anchored on an unambiguous shape so it cannot steal a
  question that already routed correctly.

### Measured (same 500-question bank, before → after)
- routed-and-clean **269 → 387**, unrouted **188 → 80**, spurious blocks
  **43 → 33**, with **zero** clean-question regressions. Remaining unrouted are
  predominantly genuine capability gaps (which the router now discloses) rather
  than reachable-but-missed tools. The engine's honesty and fail-closed
  behavior are unchanged — and remain the trust backbone.

## [0.1.20] — 2026-07-01

Headline: **privacy hardening.** No functional changes — a clean rebuild plus a
stronger guard. `0.1.19` is deprecated in favour of this release.

### Fixed
- **Scrubbed a placeholder object name from the bundled build.** A generic
  example name used in a JSDoc snippet was renamed to a neutral placeholder, so
  the shipped `dist` carries no real-org-shaped identifiers. Pure rename, no
  behaviour change.

### Changed
- **The release guard now scans commit messages, not just file contents.**
  `pnpm guard` previously inspected only tracked file text; an identifier in a
  commit *message* could pass unseen. It now scans every commit message
  reachable from `HEAD` and fails with the offending commit, closing that blind
  spot. Test data that used real-org-shaped names was also renamed to generic
  placeholders.

## [0.1.19] — 2026-07-01

Headline: **the access surface, made honest and complete.** A 100-question permissions
sweep on a real org surfaced a cluster of gaps: custom permissions were *retrieved but
unreachable*, permission sets under-modeled record-type visibility, two questions drew
confidently-wrong routes, and Windows couldn't shell out to `sf` at all. All fixed in one
release — plus an opt-out update check that nudges you when a newer sf-intelligence, or a
stale vault, is behind.

### Added
- **Update notifier (on by default, opt-out)** — two independent nudges:
  1. An **npm check on `sfi mcp` startup.** When a newer `sf-intelligence` is published it
     prints a one-line "upgrade, then `/sfi-refresh`" notice on stderr (stdout stays reserved
     for JSON-RPC). Opt out with `SFI_NO_UPDATE_CHECK=1`; auto-disabled under CI; 24-hour
     cache in `~/.sf-intelligence/`; fail-silent on any network/timeout error; reads only the
     registry `dist-tags.latest` (no version list, no telemetry, no org data ever leaves the
     machine).
  2. An **entirely offline vault-version nudge in `health_check`.** It compares the plugin
     version that BUILT the vault (`manifest.version`) against the running plugin and, when
     the plugin is newer, advises `/sfi-refresh` — so a vault built by an older version that
     lacked newer extractors (e.g. the CustomPermission / permission-set record-type work in
     this release) surfaces as a re-refresh prompt rather than a silent gap. No network.

  Documented in `docs/configuration.md`.
- **`CustomPermission` is a first-class listable type.** `list_components({ type:
  'CustomPermission' })` now returns them — previously rejected at the schema enum, so the
  custom permissions a refresh retrieved were *retrieved but unreachable*. Validated on a
  real 8,068-component org: 15 records list, `resolve` matches them exactly, and
  `effective_permissions.customPermissions` surfaces the real grant chain
  (permission-set → custom permission, with `targetMissing` attributed).
- **`profile_security` tool + Session Settings tier.** A new extractor and tool surface
  profile / session security settings as a refresh-gated tier.

### Fixed
- **Permission-set `recordTypeVisibilities` parity.** The permission-set extractor now
  models record-type visibility exactly as the profile extractor does (same
  `collectRecordTypeVisibilities` logic, including `visible: null` handling), closing a
  blind spot where a permission set could grant a record type with no trace in the vault.
  Found by real-org QA (a permission set that granted record types with no trace in the
  vault) and validated end-to-end against a real refresh: permission sets carrying
  record-type visibility went from none to fully modeled, byte-for-byte matching the source.
- **Two confidently-wrong routes + template gaps.** The intent router returned confident but
  wrong tool routes for a pair of permission questions and left template gaps for others; the
  access-surface rules were tightened and backed by a regression fixture
  (`eval/access-surface.cases.json`).
- **Resolver false positives.** Two candidate-ranking fixes: (a) a short acronym query
  (e.g. `SSN`) no longer rides a substring hit into unrelated compound field names
  (`MSN` / `ASN` / `BSN`); (b) a bare generic type-word query (`Profile`, `Permission Set`)
  no longer force-clarifies against a component literally named that. Backed by the
  "Bug 1 / Bug 2" resolver regression tests.
- **Windows `sf` execution.** The refresh, live-plane, auth, and init paths could not invoke
  `sf` on Windows — Node cannot exec a `.cmd` shim without a shell, and the codebase
  deliberately avoids `shell: true` for injection safety. A shared cross-platform exec helper
  now runs Windows commands via `cmd.exe /d /s /c` with per-argument escaping (cross-spawn
  style) and `windowsVerbatimArguments` — no `shell: true`, so the no-injection guarantee is
  preserved. Non-Windows execution is unchanged.
- **Margin-gate false-fire on confident routes.** The I6 margin-based clarification gate could
  suppress an executable route when a newly-added tool perturbed the semantic catalog; it now
  fires only on genuine funnel-primary ties (`confidence !== 'high'`), restoring direct
  execution for confidently-resolved questions.

## [0.1.18] — 2026-07-01

Headline: **lifecycle routing + an honest conversion caveat.** "What *runs* when a Lead is
converted?" fell through to an unrouted gap while "what *happens* when…" routed fine — a verb
asymmetry, not a missing capability. Fixed, and `lifecycle_process` now discloses that a
conversion is a distinct action it only partly models.

### Fixed
- **Router verb symmetry.** The lifecycle-transition rule matched only `what happens when …`;
  it now also matches `runs` / `fires`, so "what runs when a Lead is converted" routes to
  `lifecycle_process` (like the "happens" phrasing already did) instead of logging an
  unrouted gap. The DML-event save-order rule is unchanged (disjoint value sets — no overlap).
- **`lifecycle_process` honesty caveat.** It models a transition as an insert/update, so a
  distinct record ACTION — Lead Convert, Approval submission, Activation — is only partly
  captured. It now discloses that the action's own automation (Convert field mapping,
  matching / duplicate rules, managed-package auto-convert, approval / activation routing) is
  outside the insert/update view, so a conversion answer isn't read as the whole operation.
  (Found by end-user QA on a real org with package-level auto-convert.)

## [0.1.17] — 2026-07-01

Headline: **the grounding gate now fails closed.** `sfi.synthesize_answer` exists to stop a
host from asserting something the vault never said — but when a `draft` was handed in with
no evidence (an empty or missing `input`), it silently returned `grounded: true` instead of
refusing. It now fails closed.

### Fixed
- **`synthesize_answer` fail-closed grounding.** A `draft` supplied with an empty or missing
  `input` now returns `grounded: false` plus a `GROUNDING NOT VERIFIED` caveat, instead of
  rubber-stamping the draft as grounded. Absence of evidence is not evidence of grounding —
  the same `empty ≠ none` rule the tool enforces for the host, now applied to its own input.
  Found by end-user QA: a false *"safe to delete, nothing references it"* draft with no
  `input` came back `grounded: true`, 0 citations. JSDoc + tool description updated to match.

## [0.1.16] — 2026-07-01

Headline: **release consolidation.** The same product as 0.1.15 — the honest funnel-primary
routing and the ~20 Tier-4 modeling capabilities — promoted to a clean, tagged release
merged to `main` and cut on GitHub. The published package (the `sfi` CLI + MCP server) is
unchanged from 0.1.15; the only change since is a website fix.

### Fixed
- Website: corrected a stale automated-test count (`3,500` → `4,700`) on the trust page,
  `llms.txt`/`llms-full.txt`, and the homepage, and hardened `recalibrate.mjs` so the
  headline numbers stay in sync with source on every rebuild.

## [0.1.15] — 2026-07-01

Headline: **honest routing, and a big jump in admin-question accuracy.** Building on
0.1.12's funnel-primary router, `sfi.route_question` now makes every candidate
self-describing (which plane it needs, how confident the match is), drops the last hard
regex override, and — on a genuinely ambiguous, high-consequence tie — asks the user
instead of guessing. A broad honesty pass stops tools from reading an empty result as a
confident "none." Paired with ~20 deeper org-modeling capabilities, the maintainer's
admin-question differential-QA battery went from **48.6% → ~88%** passing. Tool count is
unchanged (171); no new commands.

### Changed — routing (funnel refinement)
- **Every `toolCandidate` now carries `plane` (`vault` | `live` | `hybrid`),
  `liveRequired`, and a `confidence` band.** The host can see, per candidate, whether a
  tool needs the live org and how strong the match is — instead of inferring it.
- **The hard `0.96` regex "pin" is gone.** A regex hit no longer forces a route; it is
  fused into a single bounded score alongside the semantic cosine, so regex *advises* and
  the host LLM still *decides*. The regex engine is kept (it backs the offline route and
  the fused score) — 16 recall-crutch rules that only papered over ranking gaps were
  removed.
- **Meta-tools de-noised and the confidence band recalibrated** so the shortlist leads
  with the tool that actually answers the question.

### Added — honest clarification & absence-awareness
- **Margin-based clarification (`executionBlocked`).** When the top two fused candidates
  are within `0.05` *and* diverge on a high-consequence axis — vault-vs-live plane, or a
  destructive `what_if_*` / `safe_to_delete` verdict vs. an informational `get_impact` /
  `find_*_usages` — `route_question` blocks and returns a clarification so the host asks
  rather than silently committing to the wrong tool. Tight by design; offline mode never
  blocks.
- **`route_question` now discloses the live plane + consent step** in its guidance, so a
  question that needs live data names `sfi.live_consent` instead of quietly answering from
  a stale vault.
- **`empty != none`.** Graph-traversal tools attach a coverage caveat when a family they
  depend on wasn't retrieved, so "no references found" is qualified rather than presented
  as certainty.
- **Absence-aware `synthesize_answer`.** A grounded guard keeps a correct "nothing
  depends on this" cascade from being flattened into a hollow, over-confident answer.

### Added — deeper org modeling (no new tools)
Twenty modeling improvements *inside existing tools* that make impact, sharing, and
automation answers more complete:
- **CustomPermission** definitions + grants from profiles / permission sets.
- **PlatformEventChannel** topology with per-channel filters, plus event publishers /
  subscribers.
- **ListView filter** predicate fields composed into `field_360`.
- **Workflow time-triggers** (`workflowTimeTriggers`) and remaining workflow-action counts
  on the save cascade.
- **Class-granular `@future` `dispatchesAsync` edges** and caller-side method attribution
  on AST `callsApex` edges.
- **Standard-object field snapshots** for all 14 modeled objects; **guest / territory
  sharing-rule** extraction; **public-Group membership** edges; ApprovalProcess
  `FieldUpdate → CustomField writesTo`.
- `what_if_make_field_required` now credits WorkflowRule + ApprovalProcess populators;
  `coverage_report` ranks the top uncovered metadata families.

### Fixed
- Routing-accuracy fixes across the admin-question surface (layouts, reports, permission
  sets, validation-rule save behavior, save-order steps, EncryptedText).
- `explain_flow` fault-rollback verdicts corrected (async / screen / scheduled); non-Apex
  action calls and `AsyncAfterCommit` scheduled paths surfaced.
- `what_happens_on_save` / `order_of_execution` stop under-counting after-save flows;
  inactive triggers excluded from active steps.
- `outbound_message_catalog`, `find_dead_code`, `scheduled_job_catalog`, and
  `test_coverage_for_method` report determinate negatives, async dead code, and
  mock-backed coverage more honestly.

### Engineering & trust
- **Admin-question pass rate 48.6% → ~88%** on the maintainer's differential-QA battery
  (the driver for this work); router goldset 128/128; ~3,180 unit tests green; CI green.
- Leak/privacy guards unchanged and green: the published tarball carries only the
  synthetic **Verdant** demo org — no customer metadata.

## [0.1.14] — 2026-06-25

Headline: **listed on the official MCP Registry.** A metadata-only patch that corrects the
`mcpName` namespace casing so `sf-intelligence` validates and lists on the official Model
Context Protocol registry (and the directories that mirror it). No product behavior changes.

### Changed
- `mcpName` / `server.json` namespace corrected to the exact GitHub-login case
  (`io.github.PranavNagrecha/sf-intelligence`) — the registry reads it case-sensitively.
- `server.json` description shortened to the registry's 100-character limit.

## [0.1.13] — 2026-06-25

Headline: **try it with no Salesforce org.** A new `sfi demo` command builds and serves a
bundled synthetic "Verdant Energy" org over MCP — `npx -y sf-intelligence demo` is a full,
offline, zero-setup trial. Plus registry-readiness, a clarified license, and a measured moat.

### Added
- **`sfi demo`** — builds the bundled synthetic org into a cached vault on first run
  (`~/.sf-intelligence/demo`) and serves it read-only over MCP; no org, no `sf` CLI required.
- A committed, queryable synthetic demo vault (`examples/demo-vault`) + curated demo
  questions (`examples/demo-questions.md`).
- npm registry metadata: `mcpName` + a `server.json` MCP-registry manifest + `repository` /
  `bugs` URLs + agent-era keywords (claude, claude-code, cursor, cline, mcp-server, ai-agent).
- A `workflow_dispatch` trigger + a CI status badge.

### Changed
- **License clarified** to the canonical Commons Clause: free to use (including at work);
  a commercial license is only needed to *Sell* it (resell / host / SaaS / support-for-fee).
  Plain-English `NOTICE` added; README + website updated. (Previously read as noncommercial-only.)

### Engineering & trust
- **Scale certified to 50,000 components** (import 40.5 s, resolve ~73 ms/query;
  `pnpm eval:scale:cert`, `docs/reports/scale-certification.md`).
- **SAST accuracy measured** on a labeled synthetic corpus: 100% precision / 90% recall
  (`pnpm eval:sast-accuracy`, `docs/reports/sast-accuracy-report.md`).
- New CI + pre-commit "public-interface" guard: public artifacts may reference only in-repo
  synthetic vaults, and no un-allowlisted raster images (screenshot-leak defense).

## [0.1.12] — 2026-06-17

Headline: **funnel-primary routing (CAE)**. `sfi.route_question` now leads with an
offline semantic funnel — it surfaces a meaning-ranked shortlist of the `sfi.*`
tools that answer a question and the host LLM picks which to run; the deterministic
regex route is demoted to a non-authoritative hint. `SFI_ROUTER_MODE=offline`
restores the fully deterministic route for no-LLM / CI / air-gapped hosts. Adds the
`mode` ('ask' | 'plan' | 'assessment') output shaping. README refreshed with an
architecture diagram and accurate stats. See the detailed entries below.

## [0.1.10]

Development line for the gap-closure milestone: close every pre-existing
product gap so the first public release is correct, routable, and honestly
bounded. Four arcs: router moat (unrouted/misroute closure and a goldset
ratchet), usage & honesty (evidence tiers on usage answers and dead-code
false positives), the truth layer (MCP descriptions, skills, and capability
docs brought back in sync with shipped reality), and the bug hunter
(adversarial batteries, an agent-eval gate, and ratcheted eval minimums).
Entries accrue below as changes land.

### Funnel-primary routing; regex demoted to a hint (CAE-03b)

- **`sfi.route_question` now leads with the semantic funnel.** In the default
  hybrid mode it attaches `toolCandidates` (the meaning-ranked shortlist) + a
  `guidance` planner line to **every** routable question — not just `unrouted` /
  low-confidence ones — and the host LLM decides which tool(s) to run. The
  deterministic regex `route` still travels with the response but is now a
  **non-authoritative hint** (suggested tool order, resolved entity, suggestedArgs),
  not the answer.
- **New `SFI_ROUTER_MODE=offline`** restores the deterministic Design-A route for
  no-LLM / CI / air-gapped hosts: the regex route is authoritative and candidates
  are omitted. Default (unset) is `hybrid`.
- The regex engine is **kept, not deleted** — it backs both the hint and the
  offline fallback — so all existing routing gates stay green. Tool description,
  server instructions, and trust limitations updated to match.

### Ask / Plan / Assessment output modes (CAE-04)

- **`sfi.route_question` gains an optional `mode` ('ask' | 'plan' | 'assessment')**
  that tailors how the host LLM should answer and reranks the funnel candidates
  toward that mode's tool family. **Plan** mode favors the `what_if_*` / `get_impact`
  / `safe_to_delete` tools and asks for an ordered, dependency-sequenced change plan
  with per-step risk; **Assessment** favors the `*_risk_report` / `release_readiness`
  / `coverage` tools and asks for findings + severity + recommended actions; **Ask**
  is a quick grounded answer. When a mode is set, `toolCandidates` + a mode-specific
  `guidance` line are always attached (regardless of route confidence), so the same
  question can be answered three ways. dx0-parity UX, built on the funnel. Guards:
  `route-question.test.ts` (each mode's guidance + the plan-family-leads rerank).

### Funnel recall ratchet ~80% → ~90% (CAE-05)

- **Funnel recall@8 lifted from ~80% to ~90%** (103/115 on the labeled gold-set)
  via a small, bounded **per-tool keyword overlay** — funnel-internal, NOT
  user-facing. A handful of tools whose name + description don't echo how people
  phrase the question: most importantly `list_components` (the generic "enumerate
  every X" tool, which shared no words with "what omniscripts do we have" /
  "approval process steps"), plus `who_can_access_object`, `live_sample`,
  `governor_limit_risks`, `live_folder_access`, `live_group_count`,
  `what_if_change_method_signature`, etc. The `router-recall` gate floor is raised
  to 87% and its baseline re-recorded at 103/115. Remaining misses are mostly
  single-label artifacts (the funnel surfaces a valid alternative — e.g. a
  resolve/find tool) or the one empty-token meta-question "what can you do". This
  ratchet brings the funnel close to the bar for safely deleting the regex engine
  (CAE-03b, still user-gated).
- **New harness eval: funnel generalization on ~1000 FRESH questions** — a far
  harder, harder-to-overfit bar than the 115-question gold-set. It generates real
  Salesforce-user questions across admin/dev/architect/business/live personas with
  phrasings deliberately unlike the gold-set, each tagged with the tool family it
  should reach, and reports recall@8 (deterministic, vault-independent, wired into
  the gate). It immediately earned its keep: it showed the tuned 90% gold-set
  number was optimistic — the funnel actually generalized at **~75%**. Adding
  **intent-verb synonyms** (touches/relies/falls-over → impact, dump/inventory →
  list, blow → governor-limit) — which transfer to unseen phrasings, unlike
  tool-specific keywords — lifted fresh-question recall to **~81%** while holding
  the gold-set at 90% (no overfit). This generalization eval, not the gold-set, is
  now the real bar for the funnel.

### Funnel recall lift + validation net (CAE-03a)

- **Funnel recall lifted from ~59% to ~80%** on the labeled router gold-set. The
  tokenizer now splits snake_case (`object_access_audit` → object / access / audit)
  and light plurals (apps → app); each tool's **name is indexed** (it encodes the
  intent — `live_count`, `find_component_usages`); and the Salesforce synonym layer
  expanded (usage / references / depends, how-many → count, create/read/edit/delete
  → access, changed → modified, …). `semanticCandidates` is now exported from the
  package so the gate can score it directly.
- **New deterministic gate net — candidate-recall@K** (harness): for each gold
  question, assert the correct tool is in the funnel's top-8 (the floor that lets
  the host LLM reach it). Vault-independent, no MCP server, reproducible, with a
  baseline regression guard. It pairs with the existing **agent-eval** net
  (end-to-end answer quality): recall-fail = funnel gap; recall-pass-but-agent-fail
  = LLM-pick gap. **The net's verdict: at 80% the funnel is not yet good enough to
  delete regex** — that deletion (CAE-03b) is gated on recall ratcheting higher.
  Building the net first is what surfaced this.

### Router funnel becomes advisor-primary + planner contract (CAE-02)

- **`sfi.route_question` now surfaces `toolCandidates` on weak routes too, not
  only `unrouted`.** Whenever the deterministic router is unsure
  (`confidence: 'low'`), the host LLM gets the funnel's meaning-ranked shortlist —
  so a question that *barely* matched a rule still gets a second, semantic
  opinion to plan from.
- **A `guidance` field states the loop the LLM owns.** Alongside `toolCandidates`,
  the response now carries a one-line planner contract: *the candidates are an
  advisory shortlist, not a route — read them → `sfi.resolve` named components →
  pick/sequence the tool(s) → run → ground with `sfi.synthesize_answer`.* The
  capability map's routing guidance is updated to match (it previously told hosts
  to say "capability not built" exactly when candidates are now offered). Regex is
  still in place (it is removed in CAE-03); this only changes how the funnel's
  advice is presented. Guards: `route-question.test.ts` (guidance present with
  candidates, absent for gibberish).

### Semantic router funnel — candidates for unrouted questions (CAE-01)

- **`sfi.route_question` now returns `toolCandidates` when it cannot place a
  question.** The deterministic router used to give up on any phrasing it had no
  rule for (`intent: 'unrouted'`) — e.g. "where does <user> have access to". It
  now attaches a meaning-ranked shortlist of candidate tools: an **offline TF-IDF
  index** over the capability map (each tool's description + the example questions
  of the capability categories it belongs to), cosine-ranked, with a small
  Salesforce synonym layer (access ↔ permission / sharing / visibility). **No
  neural model is bundled and no network is used** — fully offline, deterministic,
  zero added package weight. The shortlist is an **advisor for the host LLM to
  choose from, not a route**, so an unrouted question still reaches the right
  tools; the rendered markdown surfaces the candidates too. This is the funnel of
  the Design-B conversational answer engine; the regex engine is unchanged here
  and slated for removal in a later step. Guards: `semantic-funnel.test.ts`
  (recall@8 incl. the access case, gibberish → none, determinism) +
  `route-question.test.ts` wiring cases.

### Refresh resilience: isolated retrieve + visible errors (real-org bug)

- **`sfi refresh` now retrieves into an isolated throwaway SFDX project instead of
  a bare temp `--output-dir`.** Run from inside the vault, `sf project retrieve`
  inherited the vault's `.sf` source tracking, which on a large multi-type retrieve
  reconciled against stale temp paths and failed the ENTIRE pull —
  `UnsafeFilepathError`, or `MetadataTransferError: … does not contain a valid
  Salesforce DX project`. Refresh now retrieves into a fresh per-batch project (its
  own `sfdx-project.json` + package directory, with `sf` run from inside it), so
  source tracking cannot bleed across runs and the combined retrieve lands.
  Verified by a full with-pull refresh on four real orgs (4.6k–8.2k components).
- **The real `sf` error is surfaced instead of `Command failed`.** Retrieve
  failures collapsed to Node's generic `Command failed: <cmd>` wrapper, hiding the
  actual cause; the salient `sf` line (e.g. `Error (UnsafeFilepathError): …`,
  `INVALID_TYPE`) is now shown. Guard: `retrieve-fallback.test.ts`.
- **A transient network/timeout on a multi-type retrieve now binary-splits instead
  of aborting.** Only auth / no-DX-project / no-target-org failures are terminal; a
  load-induced timeout shrinks the batch until it lands. Guard:
  `retrieve-fallback.test.ts`.

### What-if impact completeness & truncation honesty (bugs 13, 14)

- **`what_if_change_field_type` discloses forward-compatible references it
  suppresses (bug 13).** A `forward-compatible` type change intentionally keeps
  layout / flow / config-only references out of `impacts` to keep the breaking-
  change signal clean — but that made the field look like it had far fewer
  references than it does. The response now carries `forwardCompatibleReferences`
  ({count, note, sample}) listing those suppressed references and pointing at
  `sfi.find_component_usages` for the complete list. Guard:
  `what-if-change-field-type.test.ts`.
- **`get_impact` promotes the truncation caveat into a structured summary field
  (bug 14).** When a hub's impact slice is capped (node / edge cap or payload
  budget), the caveat was only in the prose `disclosure`. A new
  `truncationReason` ({reason, nodeCap, edgeCap, payloadByteBudget,
  returnedNodes, returnedEdges, remedy}) is present whenever `truncated` is true,
  so a caller reading the summary still learns the slice is partial and how to
  widen it. Guard: `get-impact.test.ts`.

### Reporting honesty (bugs 22, 23, 25, 26, 27)

- **`object_access_audit` distinguishes rows from actors (bug 22).** A granter
  that grants through more than one path appeared in multiple rows, so the row
  count overstated the number of actors. The summary now carries
  `distinctGranters` (unique Profile/PermissionSet count) alongside `granters`
  (row count), plus a `note` when they differ. Guard:
  `object-access-audit.test.ts`.
- **`integration_map` discloses the Apex-callout boundary (bug 23).** The map
  covers DECLARED integration metadata + OmniStudio callouts but not Apex
  `Http.request` callouts (including hardcoded endpoints). An always-present
  `apexCalloutDisclosure` names the gap and points to `find_code_usages` /
  `search_apex_source`, so an Apex-only integration no longer reads as "no
  integrations".
- **`tech_debt_score` surfaces hardcoded-ID debt (bug 25).** The score now
  carries `hardcodedIdCount` sourced from `find_hardcoded_values_anywhere` (and
  a boundary when > 0), so "0 dead code" is not misread as "0 code debt". The
  count is disclosed, not folded into the weighted score. Guard:
  `tech-debt-score.test.ts`.
- **`domain_clusters` labels zero-edge clusters honestly (bug 26).** A cluster
  whose members share only a common neighbour (no edges among themselves) now
  carries `cohesion: 'external-anchor'` and a "co-located, no internal edges"
  suggested name, instead of reading as a cohesive dependency domain.
  `cohesion: 'connected'` marks real internal-edge clusters. Guard:
  `domain-clusters.test.ts`.
- **`generate_architecture_overview` states its scope (bug 27).** A boundary now
  declares it a structured tour (org_overview + domain_clusters +
  integration_map), not a deep call-chain / lineage / sharing analysis, and
  points to `call_graph` / `get_subgraph` / `field_lineage` /
  `generate_sharing_summary` for depth.
- (Bug 28 — `org_overview` 0-counts for un-retrieved types — was already
  disclosed via `coverage.frontendRetrieved` + the v4.0 boundary axis; verified,
  no change needed.)

### PII propagation through formula lineage (bug 11)

- **`pii_inventory` inherits PII from a formula's source field.** A formula
  field with no PII signal in its own name/type (e.g. `Masked_SSN__c = a formula
  over Student_SSN__c`) was classified `public` because detection was name/
  label/type only. The inventory now follows a formula field's outgoing
  `references` edges and, when a source field is `pii`/`sensitive`, propagates
  that classification (and category) to the derived field with an explanatory
  reason. `field_access_audit` and `generate_compliance_report` inherit the fix
  via the shared paginator. Guard: `pii-inventory.test.ts` formula-derived case.
  (Bugs 8 and 10 — divergent classifiers and checkbox/contact false positives —
  were already closed in the prior batch; verified.)

### What-if second-hop coverage (bugs 15, 16)

- **`what_if_deactivate_flow` surfaces platform-event subscribers (bug 15).**
  When the flow publishes a platform event (a `writesTo` edge to a `__e`
  object), deactivating it stops that event — so every flow / trigger that
  `listensTo` the event loses its trigger. Those subscribers sit one hop past
  the event object and were invisible to the single outgoing-edge walk; they
  are now emitted as `metadata-blocker` impacts. Guard:
  `what-if-deactivate-flow.test.ts` publish→subscribe case.
- **`what_if_make_field_required` surfaces ListView dependencies (bug 16).** A
  ListView that references the field (filter or column) can change which
  records appear, or show blank values, once the field is required. The walk
  now follows the field's incoming `references` edges and flags any ListView
  source as `configuration-only`. Guard: `what-if-make-field-required.test.ts`
  ListView case.

### Sharing verdict: object-CRUD hard gate (bug 21)

- **`why_cant_user_see_record` no longer returns `unknown` when object access is
  definitively denied.** Object Read/Edit/Delete permission is a pre-condition
  for record access; record-level sharing (OWD, role hierarchy, sharing rules,
  territory, manual shares, sharing sets, account teams) can only grant record
  visibility on top of an object permission, never the permission itself. When a
  **profile** is supplied and both the `PermissionGrant` and `SystemPermission`
  stages deny, the aggregate verdict is now `restricted` instead of being demoted
  to `unknown` by the downstream record-level `unknown` stages. A role/group/
  permission-set-only context (where those stages report `restricted` merely
  because no profile was supplied) still yields `unknown`. Guard:
  `why-cant-user-see-record.test.ts` hard-gate case.

### Flow before-save `$Record` extraction (bug 17)

- **`<recordUpdates>` / `<recordDeletes>` that target `$Record` now resolve to
  the trigger object.** The dominant before-save record-triggered pattern mutates
  `$Record` (the triggering record) via `<inputReference>` with no `<object>`
  element, and was previously skipped — so `explain_flow` returned no operations
  and the flow appeared to do nothing. `$Record` / `$Record__Prior` now resolves
  to the `<start><object>` of a record-triggered flow, emitting the same
  read/write + per-field `writesTo` edges at `heuristic` confidence. A non-
  `$Record` inputReference (a loop/collection variable) is still skipped. Re-
  refresh to rebuild. Guard: `flow.test.ts` `$Record` resolution + non-resolvable
  skip cases.

### Trigger→helper call visibility (bugs 18–20)

- **Apex scanner redirects instance-local calls to the constructed class.** A
  helper invoked via `Helper h = new Helper(); h.run()` (the dominant
  trigger→helper / handler pattern) previously minted a phantom
  `callsApex ApexClass:h` against the local-variable name (`targetMissing`),
  while the real class relationship survived only as a `references` edge. The
  three `callsApex`-only consumers — `call_graph`, `apex_test_coverage`,
  `governor_limit_risks` (trigger context) — therefore could not see the
  helper. The scanner now resolves a local whose declared type was constructed
  with `new Type(...)` in the same body and emits the real
  `callsApex ApexClass:Type` edge (one per method), removing the phantom. A
  built-in SObject instance method on a `new SObject()` local (`addError`,
  `put`, `get`, …) is excluded so it never mints an `ApexClass:<SObject>` call.
  Verified on `CourseOfferingTrigger` → `CourseOfferingTriggerHelper`
  (`populateCompensation` / `createPaymentsAfterUpdate` /
  `validateCompensationAmount`). Re-refresh the vault to rebuild affected
  edges. Guard: `apex-scanner.test.ts` redirect / SObject-method / not-
  constructed cases.

### Org risk synthesis and tech-debt honesty (bugs 19–21)

- **`org_risk_report` synthesis.** Composes `permission_risk_report` (over-privilege findings + roster), `pii_inventory` (regulated-field exposure headline), vault health, coverage gaps, and tech-debt score — not a thin `tech_debt_score` wrapper. Surfaces assignment-unknown permission sets when tooling enrichment did not run.
- **`tech_debt_score` excluded-category nulls.** When a category is excluded (`extractor-not-run`), `rawCount` and unmeasured `details` values are `null` instead of `0`; `unknownAssignmentPermissionSetsCount` is always surfaced. Removes `deprecatedApiVersionApexCount` from `legacyAutomation.details` (lives under `apiVersions` only).

### PII, compliance, and access-consistency fixes (bugs 1–14)

- **`objectId` scope for PII and dead-code inventories.** `sfi.pii_inventory` and `sfi.find_dead_code` honor `objectId` / `objectApiName` (were silently ignored).
- **Unified PII classifier.** `EncryptedText` is always `pii`; `Student_SSN__c`, `First_Name__c` / `Last_Name__c` detected; venue/location organizational fields suppressed (`OA_Location__c`, `Web_address_for_the_event__c`). `field_access_audit` and `pii_inventory` share `detectPiiClassificationWithReason`.
- **`generate_compliance_report` pagination + frontmatter.** Walks full `pii_inventory` via `collectPiiInventoryFields`; `frontmatter.componentIds` lists only PII/sensitive fields; new **Object + FLS Exposure** section flags principals with both parent-object access and FLS read on regulated fields.
- **Access vs usage edge counts.** `field_360.summary.totalIncomingEdges` excludes `grantedBy` (usage only); `flsGrantCount` added. `safe_to_delete_field` excludes FLS grants from verdict (aligns with `unused_fields_deep`).
- **Parameter aliases.** `get_component` (`componentId`→`id`), `find_hardcoded_values_anywhere` (`query`→`value`). `search_apex_source` empty-result boundary + field token variants.

### Tool parameter UX (TSB-12)

- **Input alias normalization across 13 misnamed tool calls.** LLM hosts often guess sibling param names (`componentId`, `objectId`, `query`). Affected tools now accept documented aliases in Zod preprocess without breaking canonical keys: `find_semantic_field` (`query`→`description`), `call_graph` (`componentId`→`rootId`), `who_can_access_object` (`objectId`/`objectApiName`), `field_lineage` (`direction` defaults to `both`; `componentId`→`fieldId`), `lifecycle_process` (`objectId`), `downstream_effects` / `explain_apex_method` (`componentId`/`classId`), `async_chain_depth` (`componentId`), `layout_assignments` (`layoutId`), `tab_availability` / `recordtype_availability` (`profileId`/`permissionSetId`), `get_component` (`componentId`→`id`), `find_hardcoded_values_anywhere` (`query`→`value`). `promotion_readiness` returns an explicit two-vault registration message when `sandbox`/`prod` are missing. Live-plane sf CLI failures append an actionable `sf update` hint. `search_apex_source` tries common field token variants and surfaces an empty-result boundary naming the Apex source corpus searched. `org_card` absent remedy names full refresh (no special flag). Guard: `input-aliases.test.ts` + schema alias cases.
- **`objectId` scope for PII and dead-code inventories.** `sfi.pii_inventory` and `sfi.find_dead_code` now honor `objectId` / `objectApiName` — previously silently ignored, returning org-wide results. CustomField scans narrow to one parent object; Apex/Flow dead-code types are unchanged when scoped.
- **PII recognizer: EncryptedText, SSN, and personal names.** `EncryptedText` (and `encryptedstring` spellings) now unconditionally classifies as `pii`. Name tokens cover `First_Name__c` / `Last_Name__c` and `Student_SSN__c`-style identifiers. Guard: `pii-detection.test.ts`, `pii-inventory.test.ts`.
- **`field_360` usage vs access edge counts.** `summary.totalIncomingEdges` now excludes `grantedBy` FLS grants (usage only); grants surface separately as `summary.flsGrantCount`. Aligns with `find_dead_code` access-is-not-usage semantics. Guard: `field-360.test.ts`.

### Vault observability & adoption

- **Phantom manifest summary (P15-VAULT-phantom-manifest-summary).** Complete refreshes write `phantomSummary` bucket counts into `manifest.json` (ADR-004 — no stub nodes). Guard: `phantom-bucket-summary.test.ts` matches on-demand `classifyPhantom`.
- **Vault git adoption nudge (P15-VAULT-git-adoption-nudge).** `sfi.health_check` reports `vaultHistory.enabled` + enable hint; `sfi doctor` INFO when disabled; post-refresh progress line names `sfi vault git enable`. Guard: `health-check.test.ts`, `doctor.test.ts`.
- **Multi-vault registry discovery (P15-VAULT-registry-discovery).** `sfi doctor` INFO when `registry.json` lists 2+ vaults, pointing at fleet tools and `docs/configuration.md`. Guard: `doctor.test.ts` + `verify-doc-sync.mjs` configuration.md phrase pins.

### Graph & MCP response bounds

- **Persisted resolve index (P15-GRAPH-resolve-index-persist).** `sfi refresh` writes `{graphDir}/resolve-index.json` beside `graph.duckdb` after a complete graph publish; `sfi.resolve` loads it on cold MCP start via `graphDbPath` so the first resolve skips an in-memory rebuild. Node-count guard rejects stale artifacts. Guard: `resolve-index-persist.test.ts`; `eval/benchmark-scale.mjs` passes `graphDbPath`.
- **Method-level composite tools (P15-GRAPH-method-level-composites).** `sfi.downstream_effects` accepts optional `method` to narrow the root's direct outgoing `callsApex` edges via P4-C5 `methods[]` — e.g. a class with separate `save` and `deleteRecord` callees surfaces only the matching downstream field-write path. Shared helper: `calls-apex-methods.ts`. Guard: `downstream-effects.test.ts` two-method fixture.
- **High-fanout enumeration roster audit (P15-GRAPH-oversize-roster-audit).** Audited inventory of 60 graph enumeration handlers (`packages/mcp/src/oversize-enumeration.ts`) with bound-kind validation (paginated / graph-payload-budget / handler-capped / global-response-budget). Harness gate `check-oversize-enumeration.mjs` fails when a new limit tool or inventory entry lacks a real-org `HIGH_FANOUT` probe; `tool-smoke.mjs` replays every probe under the ~45 KB transport ceiling.

### Refresh integrity

- **Enumeration tools surface manifest coverage gaps (P15-VAULT-partial-coverage-enum).** `sfi.list_components` now attaches a structured `coverageCaveat` whenever manifest coverage for the requested `type` is not `complete` — including on non-empty pages after a scoped refresh, so a partial inventory is never read as authoritative. Empty-page `retrievalHint` (FRESH-02) unchanged. Guard: `list-components.test.ts` scoped-coverage fixture.
- **Pulled refresh reconciles org-deleted metadata (P15-VAULT-a7b-source-delete).** `sfi refresh` (with pull) now retrieves into a temp directory, drops `org-kb/source/` files absent from that authoritative set for the types retrieved this run, merges the fresh retrieve in, and prunes graph rows for reconciled types with zero extractor failures — a full clean pull uses the same `fullRebuild` path as `--no-pull`. Scoped pulls and types with parse errors stay upsert-only for everything else. Unit guard: `source-reconcile.test.ts`.
- **Incremental apply matches cold rebuild for Apex call-edge casing (TSB-01 / FINDINGS TEST-SANDBOX-A7-DIVERGENCE).** `computeChangeSet` now runs `canonicalizeApexCallEdgeTargets` before edge dedupe, mirroring cold `importExtractionResults`. Real-vault A7 trio byte-identical on `test-sandbox-vault`.

### Test-sandbox FINDINGS batch (TSB-01…11)

- **Inactive automation honesty (TSB-02).** `what_happens_on_save` / `order_of_execution` filter Draft/Obsolete Flows and inactive rules; inactive-but-configured surfaces in `inactiveConfigured`.
- **Approval + assignment + sharing extractors (TSB-03/08).** Approval-process keeps processes when nested hook actions omit `<name>`; assignment rules accept criteria-only entries without `<assignedTo>`; sharing rules accept `<portalRole>` targets; `sharingReasons` skips are labeled as not modeled.
- **Router + resolver first-user (TSB-06/07).** Intent router covers live count/sample, vault freshness, capabilities, inactive flows, standard schema/report-type enumeration, picklist phrasing, object-access disambiguation, and permission-vs-count collisions; resolver boosts explicit type tokens over `ConditionalContext` / child-field noise.
- **Freshness UX + version stamp (TSB-04).** `sfi status` says locally consistent; doctor route-gap history is INFO/WARN with machine-global scope; init/refresh stamp real CLI semver in manifest/`version.txt`.
- **Standard schema describe enrich (TSB-05).** Describe overlay enriches stub standard-field metadata (picklist values) instead of skipping existing ids; runs on `--no-pull` refresh (read-only `sobject describe`, no metadata retrieve).
- **Router battery-wrong (TSB-06).** Record-count patterns exclude non-SF platforms (SAP, Workday, Oracle, etc.) so out-of-scope questions stay `unknown`.
- **Honesty tools.** Standard-object field lists and phantom paths no longer claim "none in org"; `field_360` on object ids returns field-list suggestions (FLD-02).

### Usage & honesty

- **Transactional side-builds preserve live facts and publish from the installed graph.** A staged/lock-avoidance refresh used to create a fresh replacement database with an empty `facts` table, then write the live manifest and generated docs before the replacement graph was installed. Side-build phase one now copies every existing fact and mutates only the replacement graph; only after the atomic graph swap does phase two render and publish graph-dependent live-vault artifacts.

- **Permission-holder facts require proof of complete capture before serving factual zeros.** Holder aggregates now drain both Profile and PermissionSet queries completely, enumerate every graph container beyond the old 500-row cap, and atomically replace the prior scope with explicit zero rows plus a completion sentinel. A failed, budget-truncated, legacy, or mixed-stamp capture is treated as unknown instead of becoming a false zero.

- **Five cross-layer honesty bugs closed (P14 gap inventory).** (1) `unused_fields_deep` and `process_builder_migration_candidates` no longer read the never-emitted `properties.criteriaItems` on WorkflowRule nodes — they use the shipped `criteriaItemCount` and `properties.conditions` mirror (`expression` + `fieldRefs`). (2) WorkflowRule OutboundMessage actions now emit `references` edges to the promoted `OutboundMessage:{Object}.{Name}` node id (not the dangling `WorkflowOutboundMessage:` prefix), so `outbound_message_catalog.invokedByWorkflowRules` works on real vaults; approval-process actions follow the same rule. (3) `list_components` accepts the v4.x decomposed child metadata types (`CompactLayout`, `WebLink`, `FieldSet`, `Index`, `InstalledPackage`). (4) Report/dashboard/list-view consumer strings updated for P13-REPORTS-default and ListView extraction — `REPORT_DASHBOARD_USAGE_CAVEAT`, `FIELD_360_Q165_DISCLOSURE`, `field_lineage` boundaries, and related MCP descriptions no longer claim those surfaces are "not extracted" or "off by default only with `--with-reports`". (5) `sendsEmail` EdgeType docs list all five declarative emitters (AssignmentRule + EscalationRule added).

- **Skills + verify-doc-sync truth pass (P14-DOC-skills-boundary-audit / verify-stale-phrases).** Skills now document `health_check` as `healthy|degraded|unhealthy` with `freshness.stale` (not `status: stale|missing`); `business-user-orientation` reports/dashboards/list-view boundaries match the default capped pull + ListView extraction reality. `verify-doc-sync.mjs` pins stale-phrase guards across skills, docs, and MCP honesty constants.

- **The smart reports pull discloses what actually landed, not just what it asked for (P14-USAGE-reports-retrieve-fidelity).** A foldered Report/Dashboard retrieve can silently deliver fewer files than the manifest requested (a live run landed 78 of 83 requested dashboards — members deleted between the ranking query and the pull, folder mismatches, or drops the Metadata API never surfaces as errors). The refresh now runs a membership check of the requested `Folder/Name` members against the pulled tree (leftover files from earlier pulls cannot inflate the count), records `requested` alongside the landed `retrieved` in the manifest's `reportsCap` block, names the dropped members in the refresh output, and prints a per-type `landed/requested (org total)` block in the summary. Because `retrieved` is now the landed count, the existing `total > retrieved` coverage rule keeps the row `pending` whenever members were dropped — a report the retrieve never delivered was *not checked*, and absence claims about it stay qualified.

- **`app_access` answers in both directions — "what apps can this profile open, and which is its default?" (P14-APP-default-reverse).** The tool answered app → granters; the inverse question (a top baseline-300 unrouted cluster: "what apps are visible to the Marketing profile?") had no surface. Pass a `Profile:` or `PermissionSet:` id and the response comes from the granter's OWN `applicationVisibilities` — `openableApps[]` (visible: true) and `defaultApp` (or null), one node read instead of a roster scan. A granter without the extracted property answers "not modeled", never a verified empty; `PermissionSetGroup:` ids are refused with the honest union explanation (PSG visibility = union of member permission sets, not directly extracted). New router patterns route the visible-apps and default-app phrasings; live-verified on a real profile (26 openable apps + default). Unit-pinned both directions; goldset grows to 93.

- **Scanner false positives the AST can disprove are dropped at import (P14-USAGE-scanner-fp-downgrade).** Investigating the differential's "IN-COMMENT" false-positive class found the adjudicator's own locator was lying — it quoted the FIRST raw line containing a symbol, so a javadoc mention above real code labeled CODE edges as comments (the scanner has always stripped comments AND strings; the locator now searches stripped source and only a symbol appearing NOWHERE in code is truthfully comment-only). The REAL droppable class is typed receivers: the scanner keys `rw.id = …` on the receiver token and emits `CustomField:ReportWrapper.id` even when `ReportWrapper` is an inner wrapper class — which the parser-grade pass can PROVE is not an sObject. On successfully parsed files, the import dedupe now also drops heuristic field edges whose receiver is an AST-proven class type (inner classes + the class itself) and `Type.class` literal "fields" (a reserved word, never a real field). Real-vault differential: scanner-only edges 1,228 → 1,132; zero true-edge losses by construction (drops only on AST-proven types). Unit-pinned end-to-end (wrapper fixture: inner-class writes and `.class` gone, the real `ContentDocument.Id` read survives).

- **The impact skill stops activating on usage questions (P14-USAGE-impact-skill-split).** The `architect-impact-analysis` skill's body has carried the §C3 verb split for a while ("what BREAKS" → `get_impact`; "where is X USED" → `find_component_usages`), but its activating description still claimed the usage phrasings ("what touches", "which components reference", "show me everything that uses") — so the impact skill fired for usage questions and led with the wrong tool. The description now routes by verb explicitly, and its boundary line drops the pre-AST "heuristic Apex analysis" framing. Applied with the user's skill-edit authorization, alongside the deferred `business-user-orientation` field-meaning row (the `explain_field` enumeration now covers `picklistValues` / `picklistValuesSource` / the GVS-resolution semantics).

- **Parse-artifact "components" can no longer masquerade as a blast radius (P14-PHANTOM-edges, closes FINDINGS P-PHANTOM-EDGES).** The heuristic Apex scanner keys edges on textual receiver tokens, so an un-type-resolved local variable leaves phantom ids like `CustomField:app.Id` in the graph (kept deliberately, for recall). The save-order and method-explain tools already segregated them; the two residual holes are closed: `get_impact` now REFUSES such an id as its root with an honest parse-artifact explanation (instead of dressing the artifact's incoming parse edges up as real dependents), and the phantom taxonomy stops mislabeling lowercase localvar ids as standard-field phantoms with a "treat it as standard" remedy (a standard object is always PascalCase; they classify `unknown`). The parser-grade AST emitter was audited structurally clean — reads/writes emit only through symbol-table-resolved types — and a unit pin enforces that an undeclared dot-chain root emits nothing. Live-verified on a real vault; the a3 cross-tool consistency battery re-ran with zero divergences. This empties the open-findings ledger.

- **An empty `downstream_effects` list says "no MODELED effects" — never "side-effect-free" (P14-USAGE-downstream-effects-honesty).** The tool's three effect categories (field writes, async dispatch, declarative email) leave Apex email (`Messaging.sendEmail`), HTTP callouts, and DML deletes invisible — so a class doing any of those reports zero effects. The generic disclosure already named those holes, but an EMPTY result now additionally carries the explicit empty-meaning framing ("read the class source before concluding it is side-effect-free"), unit-pinned both ways (present on empty, absent when effects exist) and verified on a real effect-free class. The tool description states the empty semantics too.

- **Dead-code disclosures catch up with the AST flip — the inverted "Apex refs are NOT modeled" claim is gone (P14-USAGE-dead-code-false-positive).** Before 0.1.9 the CustomField dead-detection disclosure correctly warned that Apex/Flow/SOQL field references were not graph edges; once the parser-grade Apex pass became the default, that same text became a lie in the OPPOSITE direction — telling users a modeled reference class wasn't modeled. Three disclosures rewritten to the post-flip truth: `find_dead_code` (Apex field reads/writes incl. field-level SOQL are PARSED edges; the REMAINING blind spots are named — Flow formula text, report tails beyond the usage-ranked pull, list-view filters, dynamic SOQL, reflection), `find_apex_usages`, and `find_code_usages` (referrers come from the parsed pass plus the heuristic recall scanner, not "the heuristic scanner" alone). Unit-pinned (the inverted phrase asserted ABSENT); real-vault verified: 0 of 40 sampled dead-listed fields carry Apex references — the false-dead class the old disclosure apologized for no longer occurs.

- **The list-views route stops claiming ListView "is not graph-modeled" — it has been modeled for two minor versions (P14-USAGE-listview-general).** The router's reason text still carried the pre-G2 claim that ListView is "retrieved but not graph-modeled"; in reality ListView nodes carry outgoing field-reference edges (a field used only in a list-view filter shows the ListView among its referrers), and `list_view_sharing` covers who can see one — verified live against a real vault. The canonical ListView usage path is now documented in the route itself: inventory via `list_components`/`get_component`, its filter-field references via outgoing edges, visibility via `list_view_sharing`. And since nothing references a list view, ListView joins the per-family empty-result notes: an empty incoming-referrer list is the EXPECTED consumer shape (user pinning/last-viewed is runtime data the vault never sees), not evidence it is unused.

- **Zero-usage answers for Flows, objects, record types, and validation rules name their family's specific blind spot (P14-USAGE-flow-object-boundaries).** `find_component_usages` already disclosed the generic "no static evidence ≠ unused" boundary, but the four families the §C3 audit flagged each have a KNOWN hole that a generic line doesn't name — and now does, uniformly: a Flow with no referrers may still be launched daily (screen-flow launch points — quick actions, buttons, utility bar, Experience pages — are mostly invisible); an "unused" CustomObject may live in reports beyond the usage-ranked pull, list-view filters, and email templates; a RecordType with no usage referrers may be actively ASSIGNED (assignments are access, which usage deliberately excludes — `recordtype_availability` is the assignment surface); and a ValidationRule's empty incoming-referrer list is the EXPECTED shape, not evidence of inactivity. Unit-pinned per family; the gate's A4 I2b absence invariant grows from 3 to 7 usage probes covering these types.

- **The `usesValueSet` edge exists now — GlobalValueSets stop reading as unused, and GVS-driven picklists answer "what values?" (P14-USAGE-gvs-edge, closes FINDINGS P-GVS-EDGE).** The edge type was declared in the contracts, described in the GlobalValueSet extractor's docs, and cited by `unused_components`' user-facing advice for two minor versions — while NO code emitted it: `<valueSetName>` appeared nowhere in the codebase, every GlobalValueSet looked unused (false delete advice), and a GVS-driven picklist's `null` values were indistinguishable from "no values". Three closures: the custom-field extractor reads `<valueSet><valueSetName>` and emits the `declared` `usesValueSet` edge (storing `valueSetName` on the field); the GlobalValueSet extractor surfaces per-value `fullName`s as `properties.values` (it only stored a count — the values themselves were unretrievable from the vault); and `explain_field` follows the edge for GVS-driven picklists, returning the declared values with `picklistValuesSource` citing the value-set id (the "not inline" disclosure now fires only when the link cannot resolve — older vault or unretrieved value set). Real-source verified on the org carrying 38 GVS-driven fields; edges land on vaults refreshed at 0.1.10+.

- **`feedback export` scopes to the current vault — one export can no longer bundle every org's question text (P14-FEEDBACK-gaplog-scope, closes FINDINGS P-GAPLOG-GLOBAL).** The route-gap log file is machine-global (`~/.sf-intelligence/question-gaps.jsonl`), and question text routinely names org-specific components — so on a multi-org machine, the old whole-log export was a cross-org privacy hazard (the P14 clean-room test caught a fresh no-vault install exporting 43k gaps from this machine's history). Every gap is now stamped with the vault it was asked against; `sfi feedback export` exports only the current vault's gaps by default, EXCLUDES other vaults' and unstamped pre-0.1.10 entries, and reports the excluded count in the file (`routeGapsExcludedByScope`) so a small export never reads as "that's everything". `--all` restores the whole-machine export with a review-before-share hint. Ratings stay unscoped (`feedback mark` is deliberate and user-authored), and doctor's local gap triage stays whole-machine on purpose — it is never shared. Cross-vault isolation is unit-pinned; live-proven against this machine's real 43,343-entry log.

- **Frontend references to labels, static resources, and custom settings become GRAPH EDGES (P14-USAGE-label-static-graph).** The frontend scanner now extracts `resourceRefs` — LWC `@salesforce/label/c.X` and `@salesforce/resourceUrl/X` imports (emitted as `confidence: declared` — an import statement is declarative), Aura `$Label.c.X` / `$Resource.X` value-provider tokens, and Visualforce `$Label.X` / `$Resource.X` / `$Setup.X__c` tokens (emitted `heuristic`) — and all four frontend extractors map them to `references` edges: `CustomLabel:X`, `StaticResource:X`, and for `$Setup` reads the setting's `CustomObject` node. Until now these references were grep-only leads; after a refresh on this version they participate in the graph tier — `find_component_usages`, `get_impact`, and `unused_components` see them as first-class referrers (namespaced/managed-package label imports are deliberately not captured). The grep-reliant boundary text now says exactly which half is modeled: frontend refs are edges on 0.1.10+ vaults; Apex references (`System.Label.X`, `getInstance()` config reads) remain grep-only. Verified against real org source: real Visualforce pages produce label + static-resource edges through the new pipeline.

- **The usage grep tier covers frontend source — CustomLabel and StaticResource stop reading falsely unused (P14-USAGE-grep-frontend).** `find_component_usages`' grep supplement only walked Apex (`.cls`/`.trigger`), so a label referenced from an LWC `@salesforce/label` import, an Aura `$Resource` expression, or a Visualforce page read as having zero static evidence. The tier now also greps LWC/Aura/Visualforce bundle source (`.js`/`.html`/`.cmp`/`.app`/`.evt`/`.page`/`.component`), bounded to the bundle directories so an unzipped static resource's own payload can never flood the matches as fake "usages". Live-verified: a real StaticResource that previously showed Apex-only matches now surfaces its Visualforce/frontend references. Boundary text and the tool description say what the tier covers; the `text-match` over/under-match honesty is unchanged. (Graph EDGES for these references are the separate `P14-USAGE-label-static-graph` item — this widens the lead-generating grep tier.)

### Truth layer

- **Five tool descriptions stop denying the shipped P11 visibility extraction (P14-DOC-mcp-stale-p11).** The app/tab visibility extraction has shipped — Profile `<tabVisibilities>` and PermissionSet `<tabSettings>` land on `properties.tabVisibilities`, `applicationVisibilities` and `<flowAccesses>` grant edges are emitted at every refresh — but five consumer-facing texts still described the pre-P11 world: `app_access`, `tab_availability`, and `user_ability` said they "need" an extraction that exists; `compare_profile_across_vaults` and `what_if_merge_profiles` claimed "no extractor populates `properties.tabVisibilities`" and that tab drift is always excluded (both tools actually gate dynamically and compare it whenever present). All five now state the truth: the properties are extracted at every refresh, only a vault refreshed *before* P11 answers "not modeled" / "not evaluated", and the remedy is `/sfi-refresh`. The merge tool's runtime disclosure text — shown to users whenever a stale vault is compared — carried the same lie and is rewritten too. The scoped item named three tools; the sweep for the same stale-claim class found the other two.

### Ship mechanics

- **npm package metadata no longer links to the private GitHub repository.** The `repository` field (and the npm-derived Issues link) pointed at a private repo, so both links returned 404 for everyone except the maintainer — a dead end on the package's main trust path. The npm listing now carries only links that resolve publicly: the homepage (website) and the package itself. Feedback routes through the website. (User decision 2026-06-10: the source repository stays private; npm + website are the public surfaces.)

- **README + first-refresh guide brought back in sync with the shipped surface (P14-SHIP-readme-quickstart).** The guided `sfi quickstart` path is now the documented first step; refresh timings are honest under the 0.1.9 defaults (a production-scale org runs ~10–12 minutes end-to-end; the usage-ranked top-500 reports pull and the parser-grade Apex pass are each called out with their cost and opt-out flags; `--staged` is the documented time-to-first-insight path); the false "later refreshes are incremental" claim is corrected (re-extraction by default, `--incremental` is the opt-in cache with identical results); `sfi serve --http` and `sfi vault git enable` get quickstart sections (remote read-only posture and the vault-history surface); the trust glossary reflects the post-AST reality (the parser-grade Apex pass is the default `parsed` producer; the regex scanner supplements for recall); and the roadmap drops the already-shipped stale-vault-detection entry. Verified clean-room: `npm pack` → sterile install → README commands run verbatim (version, doctor triage, quickstart help, honest no-vault errors). The clean-room run also CAUGHT a real finding: the route-gap log is machine-global (`~/.sf-intelligence/`), so one `feedback export` bundles every org's question text — disclosed in the README's feedback section, filed as FINDINGS P-GAPLOG-GLOBAL with backlog item `P14-FEEDBACK-gaplog-scope`.

### Router moat

- **Goldset 92 cases (≥90 target met) — and the last two grandfathered question-shaped tools route (P14-ROUTER-goldset-expand).** Five top baseline-300 unrouted clusters now answer: "when did X change" → `component_history` (the vault-git timeline; de-grandfathered; placed before the org-wide history rule whose bare history/timeline pattern would steal it), "who owns X" → `annotations` (curated stewardship; de-grandfathered; the metadata-noun anchor keeps "who owns the most Account records" on the live owner breakdown), "what is the help text for X" → `explain_field` (the inline help bubble is its surface), "what is the relationship between X and Y" / "child objects of X" → schema, "which validation rules reference X" → `find_formula_references` (VR formulas produce the same `references` edges), and "what permissions does the X profile have" → `effective_permissions`. Guards pin last-modified, history-change, owner-breakdown, and noun-final component-usage phrasings. The gate's intent-gold-coverage floor ratchets down 7 (66 → 59 grandfathered-uncovered): a newly covered intent can never silently lose its gold again, and a NEW intent cannot ship without one.

- **The 20 stress-bank `route_only` rows all answer now — the kill-criterion row goes 20 → 0 against a ≤5 target (P14-ROUTER-stress-20).** Two product gaps and one harness artifact. Product: `search_flow_metadata` REQUIRES a query but the `flow-search` intent never suggested one, so every routed call died on the missing arg — the router now derives the grep text by stripping routing scaffolding words ("Marketo applicant status sync flows" → query "marketo applicant status sync"); and "churn since last vault refresh" routed to `diff_snapshots`, whose required from/to labels are never derivable from that phrasing — a refresh-anchored intent now lands on `what_changed_since_refresh` (no-arg, compares the live source hash against the manifest; the tool leaves the grandfather list). "What changed since…" phrasings stay with the established `history-change` route. Harness: the stress rows hard-coded `followUps: []`, scoring `route_only` structurally no matter how well they routed — they now execute the route like every other bank row (resolve-first intents exercise the resolver; first tools run with `suggestedArgs`).

- **The long safe-to-delete question reaches the delete-verdict tool (P14-ROUTER-safe-delete-misroute).** A compound admin ask ("…is unused legacy text… Before deleting it… every layout, validation rule, flow, formula field, and permission set that still references it… would the platform block deletion… What is the safe-to-delete verdict?") enumerates so many nouns that the FIRST broad noun rule in array order won — `unassigned-permsets` ("unused … permission set" across two sentences), and after bounding that, `explain-validation-rule`, then `flow-search`. Three fixes: the cross-clause gaps in `unassigned-permsets` and `explain-validation-rule` are clause-bounded (the third and fourth instances of this overreach class), and the unambiguous PRODUCT-vocabulary cues — hyphenated "safe-to-delete", "block deletion", "before deleting" — get an early precision rule that outranks every noun enumeration. The question now routes to `safe_to_delete_field` (verified on a real org vault: verdict `review` with reasoning categories); plain phrasings for permsets/validation-rules/flows/impact keep their intents, pinned in tests. One gallery expectation moved with the earlier formula-vs-usage item ("used in formulas" → the formula specialist) — caught manually because the gallery is not gate-wired yet; that hole is the W5 gallery-gate item's job.

- **A compound community-security question no longer lands on the live email tool (P14-ROUTER-community-security-compound).** A long go-live hardening ask ("…which profiles and permission sets grant access to application templates and educational history child objects, and whether any named credentials used by the community run in user mode…") was routed to `email-template-usage` — a `liveRequired` hybrid tool — because `templates … used` matched ACROSS clauses with an unbounded gap; after that fix it fell onto `app-access` because the bare `\bapp` prefix matched "**app**lication templates". Both patterns are now clause-bounded, and "application" used attributively (application templates/records/object/history) is excluded from the app intent — it names a business object, not a Salesforce app. The question lands in the vault ACCESS family (`field-access`, `liveRequired: false`, verified against a real org vault); real email-template asks ("which email templates are unused") and real app asks ("who can open the Service Console application") keep their intents, pinned by collision golds.

- **Method-signature changes reach their specialist simulator (P14-ROUTER-method-signature-impact).** "What breaks if I change the signature of a method in OpportunityService?" was swallowed by the generic blast-radius rule onto `get_impact` (class-granular), and "is it safe to change the signature of X.y" fell through unrouted — while `what_if_change_method_signature`, the tool built for exactly this, sat router-unreachable on the grandfather list. A signature-anchored intent now sits before `impact-analysis` (the phrase is unambiguous) and routes to resolve → `what_if_change_method_signature`; the tool leaves the grandfather list (the stale-entry test enforces it). Non-signature blast-radius asks keep `impact-analysis` (guards pinned). Live-verified: the simulator returns its verdict envelope (callingClasses, testClassesNeedingUpdate) on a real class.

- **"What references X in formulas or validation rules?" reaches the formula tool, not the generic usage tool (P14-ROUTER-formula-vs-usage).** The `formula-references` patterns only matched formulas-first phrasings ("what formulas use X"); the verb-first form put "references" before "formulas", so the later `component-usage` rule stole it onto `find_component_usages`. A verb-first pattern (`references/uses … in formulas/validation rules`) now lands on `find_formula_references` — incoming `references` edges, which formula fields and validation-rule formulas both produce. Collision golds pin the neighbors: "what references the Amount_Required validation rule" (no "in" tail) stays `component-usage`, and generic "where is X used" phrasings keep their routes.

- **Temporal record counts route to the live plane — and the gallery battery hits 10/10 (P14-ROUTER-live-count-temporal).** "How many open applications do we have right now?" was unrouted: the `record-count` noun list (accounts, contacts, cases, …) can never name every object, so any unlisted noun fell through. A temporal qualifier ("right now", "currently", "today", "at the moment", "as of now") now cues the live plane regardless of the noun — `record-count` → `live_count`, `liveRequired: true`, which FAILS CLOSED without consent (verified live: the no-consent call refuses). Metadata nouns still win ("how many validation rules do we have right now" stays the vault metadata count — earlier rule), and fired/ran/logged forms are excluded so automation and login-activity questions don't collapse into a bare record count. With this, the 10-probe routing gallery — the Phase-14 kill criterion that opened at 7/10 — passes 10/10.

- **"Who can create an Account record?" now routes (P14-ROUTER-object-create-access).** The `object-access` intent's patterns required a second CRUD verb or a "records of/in" tail, so the single-verb form — the most natural way to ask — fell through unrouted (a gallery-probe miss). Single-verb create/insert/delete asks now route to resolve → `object_access_audit` (create and delete are OBJECT-level permissions; fields carry read/edit FLS only). Guards pin the neighbors: field-level edit stays `field-access`, record-level see/edit stays `who-can-access-object`, and past-tense "who deleted the opportunity" keeps the runtime audit-trail route. Also folded in: the suffix-dropped CMDT phrasing ("what values are in Status_Processor_Rule …" — users omit `__mdt`) now reaches `cmdt-record-values` via a snake-case cue that excludes `__c` field tokens. Gallery probes: 7/10 at the Phase-14 baseline → 9/10 (the last miss is the live-temporal item, next in the queue).

- **CMDT / Custom Setting record-value questions now route — and `lookup_record` leaves the grandfather list (P14-ROUTER-cmdt-record-values).** A new `cmdt-record-values` intent routes configured-record phrasings ("what is the Default record of Marketo_Api_Setting__mdt set to", "what values does the US record hold", "look up the Default record of …") to resolve → `lookup_record` → `explain_field`; they were unrouted before (a gallery-probe miss), and `sfi.lookup_record` — the tool that has answered these since v1.6 — was unreachable through the router. Two collision edges fixed along the way: (1) regex word boundaries never fire inside suffixed api names (`Region_Config__mdt` has no `\b` at the underscores), so the mdt anchors match the suffix form; (2) `sample-records` used to swallow "show the values in the X__mdt records" onto the LIVE plane — CMDT/Custom Setting records are vault data, so that phrasing class is carved out of the live sampler and a guard pins real sample asks ("show me 5 sample Account records") to stay live.

- **"What values are in the X picklist?" now routes — and `explain_field` actually answers it (P14-ROUTER-picklist-values).** A new `picklist-values` intent routes declared-value-set questions ("what values are in the Status picklist", "list the picklist values for Case Status", "what are the possible values for the Payment Status field") to resolve → `explain_field` → `get_component`; the phrasings were unrouted before (a gallery-probe miss). Rule order keeps the specialists in charge: cross-record-type value diffs stay on `record-type-picklist`, removal simulations stay on `what_if_remove_picklist_value`, and live-USAGE phrasings ("which values are actually used") deliberately do not match — that is a live-plane question. To make the routed tool answer rather than redirect, `sfi.explain_field` now surfaces `picklistValues` — the declared value set from the field's inline value-set definition — with an honesty edge: a picklist whose value set is NOT inline (commonly a GlobalValueSet reference) returns `null` plus a `picklistValuesNote` saying the values live on the GlobalValueSet component, so `null` never reads as "no values" (an empty array is a real zero-value inline definition). Found while building this: the `usesValueSet` edge (CustomField → GlobalValueSet) is declared in the contracts and described in docs/tool text, but NO extractor emits it — GlobalValueSet-driven fields don't link to their value set, and every GlobalValueSet reads as unused. Filed as FINDINGS P-GVS-EDGE with a follow-up backlog item; the disclosure above is honest about that boundary today.

## [0.1.9] (unreleased)

Development line for the "AI-consumer" milestone: the consumer of this product
is an LLM with a context window, so this cycle focuses on context economics
(global response budgets, an org card, a catalog gateway), liveness
(data-shape facts, staleness watch, staged refresh), meaning (annotations,
vault history), and depth & reach (parser-grade Apex edges behind a flag,
remote read-only serving). Entries accrue below as changes land.

### Remote serving

- **20-parallel-client soak with a live refresh underneath — green, and it redesigned the server (P13-REMOTE-soak).** The battery (20 concurrent HTTP clients × 18 rounds against a real-org vault while `refresh --no-pull` rebuilds it mid-soak) caught the real flaw the unit tests could not: per-request graph opens left gaps where the refresh grabbed the write lock — half the soak's calls came back 503. The HTTP server now holds a PERSISTENT read-only context (which structurally forces a concurrent refresh into its side-build + atomic-rename path), swaps it on refresh-epoch change behind a serialized chain, and closes the old connection after a grace period so in-flight requests finish against the old (unlinked) file. Final battery: 360/360 served, zero corrupt responses, zero 503s, zero connection resets, refresh completed mid-soak, post-refresh requests immediately healthy. Results: qa `results/remote-soak.json`.

- **`sfi serve --http` — the same server, read-only, over the wire (P13-REMOTE-http).** The MCP server now serves over the streamable-HTTP transport with a remote-grade posture: bearer token required on every request (SHA-256 + `timingSafeEqual` — neither content nor length leaks; 401 with `WWW-Authenticate` otherwise; `--generate-token` prints one once), loopback bind by default (a non-loopback `--host` warns AND requires a token), and the LIVE PLANE HARD-DISABLED over HTTP — `resolveLiveAccess` refuses before params, env, or the host's standing consent are even consulted, so a remote caller can never spend the host's Salesforce API budget (pinned by test with `SFI_LIVE_PLANE_ENABLED=1` + `liveEnabled: true` both set — and verified over the wire against a real-org vault). Stateless transport (a fresh read-only context per request — a refresh underneath is visible on the very next request, no session fixation surface). stdio↔HTTP parity is byte-identical (unit-pinned, volatile backfill stamp masked); responses leak no absolute host paths (unit-pinned); e2e gains an HTTP scenario (401 + served health_check).

### Depth & reach (Apex AST track — flag-gated; scanner stays default)

- **Reports and dashboards are pulled BY DEFAULT — the top 500 by actual usage (P13-REPORTS-default — user decision 2026-06-10).** The folder-based types Salesforce never expands under `<members>*</members>` (the false-"unused" trap: a field used only in a report read as dead) are now part of every full refresh: read-only SOQL ranks Reports by `LastRunDate` and Dashboards by `LastViewedDate` (falling back to `LastModifiedDate`), the top `SFI_REPORTS_CAP` (default 500) are retrieved, and their field references are folded onto the referenced fields — no per-report node bloat. HONESTY when capped: an org holding more than the cap gets `pending` Report/Dashboard coverage rows (the un-pulled tail was NOT checked — absence claims stay qualified through the same machinery as staged builds; unit-pinned via summarizeCoverage) plus a `reportsCap` manifest block with org totals vs retrieved. `--with-reports` remains the uncapped full pull; `--no-reports` skips; scoped `--types` refreshes never surprise-pull. Verified live against the 4,296-report org.
- **AST is now the DEFAULT (P13-AST-flip — user decision 2026-06-10).** Every refresh runs the parser-grade Apex pass; `--no-apex-ast` opts out. Two default-grade fixes landed WITH the flip rather than shipping behind it: (1) exact-duplicate heuristic scanner edges are dropped at import when a parsed twin exists — one real reference is ONE edge (the myserv differential's 905 agreeing twins now resolve to single parsed edges; scanner-only edges are kept for recall; a zero-double-count invariant is unit-pinned), and (2) parsed `callsApex` edges aggregate per target class carrying the scanner's `methods` array convention (per-method edges collided on the edge PK and surfaced empty method lists in `call_graph`). Visible quality shift on the golden fixture: `find_dead_code` rescued 6 classes from false-dead (their real callers are now parsed-visible), and Apex edges across 29 consumer snapshots upgraded heuristic→parsed (re-recorded in-commit). All five flip criteria were measured green before the decision: goldens 100% (gate-enforced), parse coverage 100% on 498 real-org files, evals ≥ baseline, every sentinel verdict flip conservative, differential adjudicated.
- **`refresh --apex-ast` — parser-grade Apex edges land, flag-gated (P13-AST-edges).** The two-pass extractor (symbol table → resolution) built on the vendored ANTLR grammar emits `confidence: 'parsed'`, `source: 'apex-ast'` edges that COEXIST with the regex scanner's heuristic edges via the edge PK's source column: resolved field reads/writes (assignment LHS = write), cross-class calls through declared receiver types (`this`/`super`/`new`/locals/params/for-each vars; inner classes qualified), bare-call self-references, SOQL FIELD-LEVEL reads (select + where, aliases excluded), and constant-string `Database.query`/`getQueryLocator` literals sub-parsed as SOQL. A file that fails to parse falls back to scanner-only and is counted in the manifest's `apexAst` block. The extractor passes the 30-class golden corpus at 100% — now enforced on every gate run (`harness:ast-goldens` judges the real module). Real-org differential (myserv): 1,330 parsed edges — 905 corroborate the scanner, 425 are AST-only finds (mostly field-level SOQL the regex can't see), 1,228 scanner-only heuristics queued for the P13-AST-differential adjudication. Flag OFF is byte-identical (golden 171/171; unit-pinned zero `apex-ast` rows). Shipping the flag costs +1.29 MB in the CLI bundle (the spike's recorded delta); the grammar loads lazily only when the flag runs. The scanner stays the default ALL of Phase 13 — flipping is the user-gated P13-AST-flip.
- **AST spike — parser-grade Apex measured before it's wired (P13-AST-spike).** Vendored `@apexdevtools/apex-parser` 5.0.0 (the apex-dev-tools ANTLR grammar; pure JS via the antlr4 runtime, esbuild-bundleable) behind one spike function (`parseApexSpike`) that NOTHING in the product imports — it is a deliberate subpath module, so the shipped CLI bundle is byte-identical (verified: 2,585,779 bytes before and after). The measurements the flip decision needs are recorded: bundle delta would be +1.28 MB unminified if index-exported (2.59 → 3.87 MB; ~524 KB minified standalone — the eventual P13-AST-edges wiring should lazy-import), and parse coverage on REAL org code is **100% across all three gate vaults** (498 .cls/.trigger files: 204 + 147 + 147; zero failures; p95 ≤ 51 ms, max 5.4 s total per vault). Modern-syntax units pin `??`, safe-navigation, user-mode DML (`insert as user`), `WITH USER_MODE` SOQL, trigger units, and the parse-or-fallback contract (garbage → `ok: false` with capped errors, never a throw). Report: qa `docs/reports/ast-spike-report.md`.

### Meaning

- **History becomes queryable — 2 new tools (169 → 171) over the vault's own git (P13-GITHIST-tools).** `sfi.component_history` returns a component's change timeline (`git log --follow` over its source file — one entry per source-changing refresh) merged with the org-declared metadata lastModified stamps, plus an optional capped unified diff of the most recent change. `sfi.component_as_of` answers "what did this look like before": `git show <ref>:<sourcePath>` re-run through the SAME extractor the refresh uses for that type (Apex class/trigger sidecars fetched from the same ref) → declared properties-as-of; types without a wired as-of extractor return capped raw historical content with `extracted: false`, honestly. Non-git vaults answer `available: false` with the enable hint — never an error (golden-pinned on the non-git fixture vault); hostile refs are rejected; an unknown ref fails structured with a history-coverage note. Verified against a real-org vault copy end-to-end.
- **`sfi vault git enable` — the vault becomes its own history (P13-GITHIST-enable).** Git already is a versioned property store, so instead of building one: enabling inits a repo INSIDE org-kb with a generated `.gitignore` (graph db, snapshots, caches, transient meta — the rebuildable surfaces stay out), takes an initial snapshot, and from then on every refresh whose source tree ACTUALLY changed auto-commits `source/ + components/ + manifest + history` with a per-type delta message (an unchanged-source refresh commits nothing). Best-effort by contract — a git failure never fails a refresh — and non-enabled vaults see zero change (the hook is gated on `org-kb/.git`). The NAMED safety test is pinned: the sourceTreeHash walk ignores `.git` even when planted inside `source/`, so enabling history never perturbs hash stability or refresh-integrity. Verified on a real-org vault: enable → initial snapshot; unchanged refresh → no commit; a real source edit → refresh → delta auto-commit carrying the changed component's markdown + history line. `sfi vault git status` reports state + last commit. The history-consuming tools land next (P13-GITHIST-tools).
- **"The SSN field" now resolves — confirmed glossary annotations feed the resolver (P13-ANNOT-glossary-resolve).** `sfi.resolve` consults the curated overlay: a query whose normalized text equals a CONFIRMED `glossary` annotation's value resolves to that component, marked `matchKind: 'glossary-alias'` with the synonym + author in the evidence. The two safety invariants hold STRUCTURALLY: the alias layer only activates when the base resolver found no exact api-name match (adversarially pinned — an alias pointing the literal name of a real component elsewhere loses to the real component), and a synonym shared by two components yields `ambiguous` + the standard clarification envelope, never a silent pick. Unconfirmed AI glossary proposals never resolve; aliases to vanished components are skipped (the orphan report owns them). The base (graph-layer) resolver is byte-untouched — the full resolver harness re-ran green: strict retrieval eval, router goldset, 1000Q regression, baseline-300.
- **Annotations go live — 2 new tools (167 → 169), CLI, consumer embedding, and an anti-laundering check (P13-ANNOT-tools).** `sfi.annotations` reads the curated overlay; `sfi.propose_annotation` records AI PROPOSALS — written ALWAYS as `source: 'ai', confirmed: false` (confirmation is a human act) with a session rate-cap of 20. The human side is `sfi annotate <id> --key owner|status|glossary|domain|note --value …` (human sets are confirmed by definition), `sfi annotate confirm` (promotes an AI proposal), `list`, and `orphans` (distinct exit code for scripts). Consumers embed the knowledge where questions land: `get_component`, `field_360`, `explain_field`, `explain_flow`, and `explain_apex_method` attach an `annotations` block with provenance **`annotation`** — curated, never derived — absent when the component has none (annotation-free vaults stay byte-identical; golden 167 unchanged + 2 new snapshots). And `synthesize_answer` now runs an anti-LAUNDERING check: a draft claiming "X is deprecated" grounds ONLY when a matching annotation exists in the source — otherwise the claim lands in `ungroundedAnnotationClaims` with a propose-and-confirm remedy ('.' inside canonical ids taught the sentence splitter a lesson). The provenance roll-up keeps `annotation` distinct from `offline_snapshot` (`mixed`, never collapsed — the a4 invariant). Glossary→resolver aliases land next (P13-ANNOT-glossary-resolve).
- **Annotations overlay — the event store lands (P13-ANNOT-store).** New `meta/annotations.jsonl`: an append-only, event-sourced overlay for the meaning the org's metadata cannot carry — ownership, lifecycle status (deprecated/…), glossary synonyms, domain grouping, notes. Events are `set`/`unset` with author, `source: human | ai`, and a `confirmed` flag (confirmation is a HUMAN act — AI proposals are born unconfirmed); materialization is last-write-wins per `(componentId, key)`, corrupt/invalid lines are skipped, and concurrent writers are safe by construction. Annotations are keyed by component id, so they SURVIVE every refresh — and when their subject vanishes from the fresh graph, the refresh pulse now carries an `annotationOrphans` report (verified on a real-org vault: a live component's annotation stayed silent, a decommissioned id was reported, both survived). Annotation-free vaults are byte-identical everywhere. The read/propose MCP tools, CLI, and the resolver/synthesis integrations land next (P13-ANNOT-tools / -glossary-resolve).

### Liveness

- **Demand queue — phantom hits become targeted retrieves (P13-STAGED-demand-queue).** When `sfi.get_component` is asked for an AUTOMATION-CRITICAL phantom (a component real automation references but the vault never retrieved), the hit is now recorded in `meta/demand-queue.jsonl` — an append-only event log folded at read time, so N hits on one id are ONE queued entry, concurrent writers are safe, and a re-drain is a no-op. `sfi refresh --drain-demand-queue` drains the queue through the existing demand-retrieve gate (grant-only / managed / standard / blindspot ids refused with the reason; only automation-critical CustomObjects pulled), and every processed id is marked with its outcome (`retrieved` / `already-present` / `refused`); a NEW hit after a drain re-queues. The watch daemon gains `--drain-demand-queue` (throttled to once an hour, failure logs and the watcher continues). Verified end-to-end on real org data: a real phantom in a production-shaped vault (an admissions-package object referenced by 2 real triggers) was hit → queued → drained live from the org (read-only single-object retrieve) → marked `drained/retrieved` → now a full L3 node — which also retires the long-open "demand-retrieve stub→L3 live spot-check unrun" caveat.
- **`unused_components` and `find_dead_code` now qualify their absence claims (P13-STAGED-absence-battery).** The new mid-staged-build adversarial battery (it pauses a REAL staged refresh after tier 1, then probes every absence-prone tool against the half-built vault) caught both tools asserting unqualified absence: "unused" / "dead" with no caveat while the very families that could hold the reference (Reports, Dashboards, LWC, Aura, FlexiPages, …) were still queued. Both now carry the shared `coverageCaveat` whenever any REFERRER/CALLER family has incomplete coverage — errored retrieve, scoped refresh, or an in-progress staged build — and `unused_components` gains a full `trust` block; "unused" now explicitly means "no RETRIEVED metadata references it". The battery (9 probes + a self-test that proves the checker goes red on a doctored unqualified claim) is a permanent gate step, so this bug class cannot return silently. The rest of the roster (safe_to_delete_field, the what_if_* family, field_cleanup_candidates, unused_fields_deep) already qualified correctly via the coverage-trust machinery. New tiered build for first-time (and rebuilding) vaults: T0 writes a skeleton in seconds — ~5 read-only COUNT queries become a `partial: true` org card with approximate scale (live-verified on a real org: 5 GETs, ~3 s) plus an all-`pending` coverage manifest; T1 retrieves the 10 priority families behind most questions (objects, fields, validation rules, Flows, Apex, layouts, record types, Profiles, PermissionSets), deferring the Markdown render; T2 is a full monolithic refresh through a TRANSACTIONAL side-build (built beside the live graph, renamed over it only on success — a mid-T2 death leaves the T1 vault byte-untouched and servable, proven by failure injection); optional T3 runs the `--with-reports` folder pass. Honesty mid-build is structural: the manifest carries a `staged` tier marker, queued types are `pending` coverage rows that COUNT AS MISSING coverage (`summarizeCoverage` routes them into `missingCoverage`, so absence-claim caveats keep firing — "no Flows reference X" can never be asserted unqualified before Flows arrive), `sfi.health_check` reports `degraded (building tier i/n)`, and `sfi.coverage_report` gains `pending` + `stagedBuild` fields. Resumable via `meta/staged-refresh.json` (a re-run skips completed tiers; the file clears on success). Because the final tier IS a monolithic refresh, the staged end state converges to the single-pass end state by construction — and the A7 refresh-integrity battery now proves it byte-identically (graph digest + marker/pending cleared) on real-org source. Two adjacent fixes landed with the transactional plumbing: a failed side-build refresh no longer renames its partial graph over the live one (pre-existing hole in the locked-fallback path), and the refresh-epoch is re-bumped AFTER the rename so a server that reopened mid-window can no longer pin the pre-swap file.
- **`sfi watch --auto-refresh incremental` — drift heals itself, at most once an hour (P13-WATCH-auto-refresh).** When a watcher tick's sweep reports org drift, the daemon triggers an incremental refresh automatically — throttled to one per hour (further drifted ticks log a throttle skip), lock-safe by construction (the epoch side-build means an open server never blocks it and reopens onto the result), and failure-resilient (a failed refresh logs non-fatally; the watcher and the vault are untouched). Off unless the flag is passed. The trigger/throttle/resilience machinery is unit-proven with injectable clocks; the live with-pull cycle awaits a supervised window (flagged).
- **Refresh while the server is open — no restart, no pkill (P13-WATCH-epoch).** Two halves retire the stale-loaded-vault class. (1) `sfi refresh` now survives an open MCP server: when the serving process holds the vault's DuckDB file (which blocks any writer), the refresh rebuilds into a side file and atomically renames it over the target — the server's old handle keeps the unlinked previous file. (2) Every refresh bumps `meta/refresh-epoch`, and the server checks it per call: on a bump it closes the old connection and rebuilds its context, so the very NEXT answer reads the new vault (a transient rebuild failure mid-refresh keeps the old context and retries — never a dead server). Proven end-to-end in the e2e: a live server, refreshed underneath cross-process, served the new component on its next call. The lock-error guidance and concurrency docs now describe the automatic path instead of advising `pkill`.
- **Org-drift badges on affected answers (P13-WATCH-badges).** When a RECENT stale-sweep (within 2× the watcher interval) shows the org has moved since the vault was built, responses whose payload involves a drifted type carry a top-level `orgDrift` badge — the sweep stamp, the intersecting types and counts, and the refresh hint. Three silences by design: a stale sweep (yesterday's drift presented as current is exactly the lie this product exists to prevent), an absent sweep (byte-identical pre-badge behavior — vaults without the watcher are untouched), and a non-intersecting drift (a PermissionSet edit does not nag a pure Apex answer). The badge never mutates trust/provenance — an offline answer stays `offline_snapshot` (gate-asserted invariant). Verified live: after a fresh sweep on a drifted org, a permission answer carried the badge naming its 3 drifted PermissionSets while an Apex answer stayed silent.
- **`sfi watch` — a boring little drift daemon (P13-WATCH-daemon).** Runs one read-only stale-sweep tick per interval (default 15m, floor 5m, ±10% jitter so a fleet of watchers never synchronizes against one org) as a detached process, keeping `meta/staleness.json` current for the upcoming trust drift badges. Single-instance per vault via a pidfile with a liveness probe — a stale pidfile from a dead process is recovered, never fatal; `sfi watch status` / `stop` manage it; `sfi doctor` reports the watcher state as an informational line. A SEPARATE daily tick budget (`SFI_WATCH_DAILY_TICKS`, default 96) makes a misconfigured tight interval degrade to idling rather than API hammering, and a failing tick logs and continues. Verified: 8 lifecycle/budget/soak units (incl. a 20-tick flat-RSS soak) plus a real start → status → double-start-refused → stop cycle against a live vault.
- **`sfi stale-sweep` — one org-drift tick, persisted for the watch surfaces (P13-WATCH-sweep).** Counts components modified in the org since the vault's refresh and writes `meta/staleness.json` (the contract the upcoming watch daemon and trust badges read). Strategy: a single SourceMember Tooling query on source-tracked orgs (covers every type), falling back to a per-type sweep over a roster WIDENED from 6 to 15 types — now including Profile, PermissionSet, PermissionSetGroup, SharingRules, FlexiPage, and RecordType, closing the hole where a permission edit in the org silently invalidated access answers (live-verified: a real org's first widened sweep found 6 drifted components, ALL of them permission containers the old roster ignored). Types the org's Tooling API rejects land in `erroredTypes` honestly; a drifted org is an answer, not an error; read-only by construction. `live_stale_check` inherits the widened roster and its disclosure names every checked type.
- **Permission-holder counts — "held by N active users" lands in access answers (P13-PSA-counts).** `refresh --with-data-shape` now also captures two org-wide aggregates (active assignees per PermissionSet, active users per Profile — COUNTS ONLY: the queries never select assignee ids or usernames, pinned by a PII grep test). Three consumers serve them as stamped `data_snapshot` holders blocks: `unassigned_permission_sets` upgrades absence-from-the-aggregate to a FACTUAL zero (the container had no active assignments at the capture stamp — not just a metadata inference), `who_can_access_object` annotates each Profile/PermissionSet granter with its active-holder count, and `permission_risk_report` holder-weights the god-mode roster. Cross-tool consistency is gate-asserted (holders blocks must match the stored facts exactly; a held container may never read as factually zero), and 5 captured permission sets cross-checked exactly against independent per-container SOQL counts on a real org. No-capture vaults stay byte-identical.
- **Captured facts now surface in answers — as stamped snapshots, never as live claims (P13-FACTS-consumers).** `field_360` embeds the field's sampled fill rate, `org_overview` the top objects' approximate record counts, `safe_to_delete_field` / `what_if_make_field_required` the field's fill rate as context, and the org card gains a data-shape section — each as a uniform `dataShape` block carrying `provenance: data_snapshot`, the capture stamp + method, a read-side TTL freshness verdict (stale blocks stay visible as `fresh: false` rather than vanishing), and a sampling disclosure (`recent-sample` figures are sampled, not measured; counts are storage-level). Two invariants hold by construction and by test: a facts block NEVER claims `live_org` (the tool's own trust stays `offline_snapshot` — dual freshness), and a destructive verdict NEVER moves toward safe because of a sampled observation (the with-facts output equals the no-facts output everywhere except the block; adversarial units seed a 0.0 fill rate against `safe_to_delete_field` and a 1.0 fill rate against `what_if_make_field_required` and assert identical verdicts). A new cross-tool consistency pair asserts `field_360`'s block equals the stored fact row exactly. Fact-less vaults are byte-identical to before.
- **`refresh --with-data-shape` — budgeted, consent-gated record-data capture (P13-FACTS-capture).** One REST call captures approximate per-object record counts for every graph-known object (`method: rest-recordcount`; these are STORAGE-level figures — for Task/Event they include archived activities, so they can legitimately exceed a plain SOQL `COUNT()`, a semantic verified live and documented), plus recent-sample field fill rates for the top-centrality objects (one SOQL each over the most recently modified rows; `exact-sample` when the whole population fit in the sample). Opt-in twice over — the flag AND live consent (`sfi.live_consent` / `SFI_LIVE_PLANE_ENABLED`); without consent the capture skips with an honest reason and the refresh stays fully offline. Hard budget `SFI_DATA_SHAPE_BUDGET` (default 60 API calls) with a disclosed partial capture when exhausted; read-only by construction; capture failure never fails the refresh. Verified on a real org: 6 API calls captured 98 record counts + 100 fill rates, and 10 independent SOQL `COUNT()` cross-checks all landed within ±10% (most exact).
- **New `facts` store — record-data observations get their own table, outside the metadata graph (P13-FACTS-store).** The graph's `nodes`/`edges` describe what metadata DECLARES and rebuild byte-identically from source (the refresh-integrity invariant). Facts — approximate record counts, field fill rates, automation-fired tallies, captured by the opt-in live plane — describe what the org's DATA looked like at a moment, so they now live in a dedicated DuckDB `facts` table keyed by `(subject, metric, source)` with `captured_at` + `method` stamps: refresh imports never touch it, facts writes never change the graph (both unit-asserted), and refresh-integrity digests stay byte-identical by construction. Freshness is a read-side TTL policy with an injectable clock. Groundwork: nothing captures facts yet — `refresh --with-data-shape` (next) writes them; consumers will disclose them as `data_snapshot` provenance, never `live_org`.

### Context economics

- **Global escalating response budget — every tool response now fits the client, or fails structured (P13-GUARD-global-size).** MCP clients reject a tool result above their token limit OUTRIGHT (~55 KB observed live): the whole response is dropped and the model sees an opaque harness error. The old global guard converted that into a clear error at ~45 KB — but still an error. The dispatch layer now RESCUES oversized success payloads in escalating passes before giving up: (1) the largest top-level `data` arrays are truncated from the tail (`responseBudget.truncated` / `droppedCount`, plus `nextOffset` when the call is offset-paginated, so the caller can fetch the remainder); (2) long strings are slimmed to a head + `…[+N bytes trimmed]` marker; (3) only if it STILL cannot fit does the caller get a structured `oversize` error (new `McpError` kind, replacing the mislabeled `internal`) that names the tool's OWN narrowing knobs read from its input schema (`limit`, `offset`, `hops`, filters, …). Every response — success or error — now carries a top-level `estimatedPayloadBytes`. Under-budget payloads pass through byte-identical apart from that field (proven by an identity property test and the byte-exact golden corpus). The budget is `SFI_MAX_RESPONSE_BYTES` (default 40 000, floor 2 000); per-tool budgets (e.g. the 28 KB graph slices) stay primary — this is the backstop that retires the oversize-rejection bug class for every tool at once, including the previously affected `compare_vaults`, `what_if_merge_profiles`, and `get_component` on a very large Profile. Truncation only ever trims lists or trims string tails — it never changes a verdict field (kill-criterion unit test).
- **Org card at refresh — a ≤16 KB orientation document an AI loads before its first question (P13-CARD-render).** Every refresh now renders `docs/org-card.md` (+ machine twin `meta/org-card.json`) beside the onboarding handbook: identity & freshness, coverage and blind spots UP FRONT, scale by type, the org's gravity (top objects by inbound dependency edges, structural containment excluded), automation density, permissions posture (profile/permission-set counts + god-mode holders), integration surface, observed naming conventions, and a five-line "how to ask" footer. Every number is derived from the graph/manifest by the same canonical helpers the tools use (re-derivability is unit-asserted); the body is a deterministic function of the graph — the wall-clock stamp lives in frontmatter only — and a fixed-order trim keeps very large orgs under the 16 KB hard cap with an explicit disclosure. Best-effort: a card failure never fails the refresh. Verified ×3 byte-identical on three real-org vaults (~4 KB cards).
- **New `sfi.org_card` — serve the refresh-time org card in one cheap call (P13-CARD-tool).** The orientation snapshot above is now tool-addressable: a pure cache read of `meta/org-card.json` (never recomputed — a regenerated card would carry a render-time stamp that contradicts its refresh-time provenance), routed via the new `org-card` intent ("show me the org card"). A vault refreshed by an older version returns an honest `available: false` with the refresh remedy instead of an error. Tool count 163 → 164.
- **Skills now orient with one call (P13-CARD-skills).** The `salesforce-org-context` silent preloader and the `using-sf-intelligence` entry skill load `sfi.org_card` FIRST — one cache read replaces the old `get_manifest` + `list_components` two-call warm-up — falling back to the old pair (with the refresh hint) on a vault that predates the card.
- **Catalog gateway — navigate 160+ analyses without loading 160+ schemas (P13-GW-meta-tools).** Three new meta-tools: `sfi.list_analyses` (paginated name + one-liner + coarse category index of the whole roster), `sfi.describe_analysis` (one tool's full description + input schema, on demand, prefix-optional), and `sfi.run_analysis` (execute any analysis by name — a THIN dispatcher into the same handler table as a direct call, returning the target's response envelope VERBATIM: identical payload, byte budget, and trust block, proven by a byte-identity sweep across every roster tool on the fixture vault and live on a real org). `args` is accepted as an object or a JSON-encoded string (a known client quirk); self-dispatch is refused; unknown names return an honest pointer back to the catalog. Groundwork for the boot-time `SFI_TOOL_PROFILE=core` roster (next item) where clients see ~18 schemas and reach everything else through the gateway. Tool count 164 → 167.
- **`SFI_TOOL_PROFILE=core` — an 18-schema roster for context-constrained clients (P13-GW-profiles).** Advertising 160+ schemas costs tens of thousands of tokens in MCP clients that do not defer tool definitions. The new boot-time profile advertises only the core roster (orientation, resolve/route, universal graph reads, and the catalog gateway, through which every other analysis stays reachable with byte-identical output). Fixed at server boot — never dynamic (`list_changed` client support is uneven); dispatch is never narrowed, so direct calls to non-advertised tools still work. Default `full`: zero behavior change.
- **`route_question` emits executable gateway envelopes under the core profile (P13-GW-router-envelope).** When the server runs `SFI_TOOL_PROFILE=core`, the route response gains `invoke[]`: every routed tool as a ready-to-execute call — core-roster tools directly, everything else wrapped as the byte-identical `sfi.run_analysis` envelope, with the route's `suggestedArgs` threaded to the primary answering tool (never to the resolve preamble). Routing itself is profile-independent (the 64-question goldset routes identically under both profiles, asserted per-gate), and under the default full profile the response is unchanged.
- **`synthesize_answer` discloses budget-truncated inputs (P13-GUARD-synth-caveat).** When the JSON handed to the answer-layer grounding pass carries a `responseBudget` truncation block (see above), the synthesis now carries an explicit caveat with the dropped/trimmed counts — "a row absent from this synthesis may still exist in the org" — instead of silently summarizing reduced data. The composed caveat replaces the block's generic note (no double-carry); untruncated inputs are unaffected.

## [0.1.8] (unreleased)

### Usage & discovery

- **Inline SOQL `FROM {object}` now mints an object-level `readsFrom` edge — usage that was grep-only is lifted into the dependency graph (P13-EXTRACT-usage-graph-edges).** The Apex scanner already survived string-stripping for inline SOQL (`[SELECT ... FROM Account]` is bracket-delimited, not a string), but nothing read its `FROM` clause — so an Apex class that QUERIES an object without touching any `acc.Field` had no graph edge to it, and `find_component_usages` saw it only via the grep tier (if at all). The scanner now captures the PRIMARY (paren-depth-0) `FROM` object of each inline query — plus each SEMI-JOIN subquery's object (`WHERE Id IN (SELECT AccountId FROM Contact)` genuinely reads `Contact`; `NOT IN` and nested semi-joins included) — and the extractor projects each to `ApexClass → CustomObject` `readsFrom` (`confidence: heuristic`, `properties.mechanism: 'soql'`), DISTINCT from the existing field-level `readsFrom` (which targets a `CustomField`). Child-relationship subqueries (`(SELECT Id FROM Contacts)` — an opener NOT after `IN`) are deliberately skipped (their `FROM` names a relationship, not an SObject). Dynamic SOQL built from strings stays invisible (the documented blind spot, still covered by the grep tier + the dynamic-apex soundness flag). An object name that doesn't resolve to a real node is tagged `targetMissing` at import and hidden, exactly like the existing `new Account()` heuristic edge. No new edge type (reuses `readsFrom`). Verified on a real-org vault: a `--no-pull` re-extract baked 187 SOQL edges (39 resolving to real objects), and `find_component_usages` on a queried object now lists its 6 Apex SOQL readers in the graph tier while keeping the grep supplement + boundaries intact. New scanner + extractor unit tests; extraction change → A7 refresh-integrity.
- **New `sfi.find_component_usages` — one "where is this used?" answer for ANY component type.** Instead of fanning out across `find_field_anywhere` / `find_code_usages` / `get_impact` / manual grep, this dispatcher takes any canonical `componentId` and composes two evidence tiers into one payload: (1) GRAPH — incoming dependency edges grouped by referrer type, each with edge `confidence`, EXCLUDING access grants (`grantedBy`) and structural `parentOf` (access is not usage); (2) GREP supplement (`text-match` tier) — a literal api-name search of Apex source that catches references the graph doesn't model (dynamic SOQL, CustomMetadataType / CustomLabel / StaticResource refs). The honesty anchor: empty graph + empty grep is disclosed as "no static evidence in the vault", never "nothing uses this". Phantom-aware. Specialized tools stay for deeper single-family answers; this unifies the common case (the §C3 universal usage & discovery contract). Tool count 162→163. Real-org verified: an Apex class resolved 1 graph referrer + 3 grep matches; a non-canonical id → `invalid-query`; a nonexistent id with no referrers → `component-not-found`.

### Org inventory

- **New `InstalledPackage` extraction + `sfi.installed_package_catalog` tool — "what packages are installed?".** The refresh now retrieves `InstalledPackage` metadata (always, it is tiny) and emits one `InstalledPackage:<namespace>` node per managed/unlocked package with `properties.namespace` (the prefix its components carry — `hed__Course__c` → `hed`) and `properties.versionNumber` (the installed version). The new tool lists them sorted by namespace with `summary.count`, at `declared` confidence; an empty catalog is disclosed as "not modeled", not a verified "no packages". This grounds the managed-extension taxonomy with REAL version + namespace data instead of inferring the namespace from component prefixes. Routed via the existing `package-inventory` intent (now led by `installed_package_catalog`). Component-type count 72→73, tool count 161→162. **Real-org verified on a sandbox:** a scoped `refresh --types InstalledPackage` pulled 28 packages (e.g. `APXTConga4@8.293`) as a clean additive upsert (+28 nodes, 0 other changes); the tool returned all 28 with versions.

### Static-analysis soundness

- **Static-analysis tools now carry a uniform `soundness` envelope so they never imply a completeness they can't have (P12-soundness-envelope).** `get_impact`, `find_dead_code`, `method_reachability`, `governor_limit_risks`, and `test_coverage_for_method` each return `soundness: { complete, blindSpots[], staticCoverage }`. It reads the already-persisted v2.1 `dynamic-apex` signal (a class that builds object/field/type references at runtime via dynamic SOQL, reflective describe, `Type.forName`, or untyped JSON) from each node's `properties.qualityIssues[]` — no runtime, no re-scan. When any class in scope is flagged, `complete` is `false`, `staticCoverage` is `partial`, and a `dynamic-apex` blind spot lists the flagged classes (canonical `componentIds`) with a note to verify by reading the source. A clean result is `complete: true`. Verified on a real-org vault: `get_impact` / `method_reachability` / `test_coverage_for_method` / `governor_limit_risks` all return `complete: false` on a dynamic-Apex class (governor flagged 37 such classes org-wide) and `complete: true` on a clean class. New shared helper + unit-test matrix.

### Sharing & access

- **Restriction-rule honesty now reaches real orgs — RestrictionRule / ScopingRule gain their parent object from `<targetEntity>`.** These rules retrieve into a TOP-LEVEL `restrictionRules/` folder (no object in the file path), so the extractor left `parentId` null — and every parentId-keyed restriction caveat silently never fired on real metadata (`why_cant_user_see_record`'s RestrictionRule / ScopingRule stages always reported "no restriction rules"). The extractor now derives the parent from the XML `<targetEntity>` (path-based derivation for nested families unchanged; no targetEntity → parentId stays null). Two sibling-consistency fixes ride along: `who_can_access_object`'s god-mode rows (`ViewAllData`/`ModifyAllData`, scope `all-records`) now carry a narrowing caveat + a `blindSpots` entry when the object has restriction rules — matching `why_cant_user_see_record`'s `unknown` god-mode verdict on restricted objects (clean objects unchanged); and `field_access_audit.update.canUpdate` now counts the `ModifyAllData` system permission as object-edit (it implies object-edit on every object WITHOUT an explicit CRUD row — but does NOT bypass FLS, so only FLS-edit holders qualify), agreeing with `why_cant_user_see_record`'s edit model. Verified against the real rule files in a sandbox vault (one targets a retrieved standard object, so the caveat goes live on the next re-extract); extractor + tool unit tests updated — the old tests had asserted the broken `parentId: null` as expected.
- **Sharing summaries and the record-access cascade now DISCLOSE the sharing dimensions they don't model (P11-G5, honesty).** `generate_sharing_summary` covered OWD + owner/criteria sharing rules + role hierarchy + grants, but silently omitted territory sharing rules, guest (Experience Cloud) sharing rules, sharing sets, account/opportunity/case teams, and manual & Apex sharing — so an "owner + criteria only" report could read as the complete access model. It now carries an explicit boundary that those dimensions are NOT modeled (absence ≠ none) and points to `why_cant_user_see_record` for a per-user verdict. `why_cant_user_see_record` gains a matching tail stage `TerritoryAndGuestRules` (always `unknown`) — the extractor skips `<sharingTerritoryRules>` / `<sharingGuestRules>`, so their absence is disclosed rather than read as "no access" (joining the existing ManualSharing / SharingSets / AccountTeams not-modeled stages). Modelling territory/guest rules + sharing sets at extraction is deferred (no such metadata in the retrieved orgs to verify against), so this is the honest-disclosure path. JSDoc + MCP descriptions + unit tests updated.
- **New `sfi.effective_permissions` — a user's EFFECTIVE access: the UNION of a profile + assigned permission sets, max-wins, with per-container attribution.** `why_cant_user_see_record` evaluates one record question against a bundle you supply; nothing rolled the containers up into a single combined ability — this does. Given a `profileId` and/or `permissionSetIds[]`, it composes each container's `grantedBy` edges (object + field + apex) and `userPermissions` (system perms): `objectPermissions[]` carries the OR'd CRUD + View/Modify-All per object plus `grantedBy` (which containers contribute), `systemPermissions[]` lists each user-permission with its grantors, and `summary` reports object / field-with-FLS / apex / system-perm counts. The object list pages (`limit`/`offset`). `declared` confidence; `disclosures` is explicit that permission-set GROUP membership/muting is not modeled (pass the member sets), app/tab visibility is not extracted, field detail is summarised (use `field_access_audit`), and object permission is not record access. Missing containers are ignored with a disclosure. Tool count 153 → 154. Verified on a real-org vault (a profile + two permission sets unioned to 33 objects — more than the profile alone — with shared objects correctly cited to both granting containers).
- **New `sfi.who_can_access_object` — the reverse of `why_cant_user_see_record`: "WHO can see/edit this object's records".** `why_cant` is single-user and forward; this enumerates which profiles / permission sets / roles / groups statically gain access to an object's records, and how. It composes the four statically-knowable sources: a public OWD (`owdGrantsAllInternalUsers`), object permissions (`allowRead`/`allowEdit` = records via OWD+sharing, `viewAllRecords`/`modifyAllRecords` = ALL records), system god-mode (`ViewAllData`/`ModifyAllData`), and sharing-rule `sharedWith` targets (criteria rules cite the predicate). Each granter row carries `via`, `access` (`read`/`edit`/`all`), and `scope` (`all-records` vs `shared-records`); the list pages (`limit`/`offset`) while `summary` stays complete. `declared` confidence, and `blindSpots` always discloses what a static view cannot enumerate — record ownership + the role hierarchy above each owner, which records match a criteria predicate, manual/Apex-managed sharing, account-teams, and sharing sets — so absence is never overstated. Tool count 152 → 153. Verified on a real-org vault (a Private standard object resolved to 70 access granters across object-permission, view/modify-all, and god-mode paths).
- **`why_cant_user_see_record` now answers "who can CREATE a record" (`accessLevel: 'create'`).** Create is a different model from read/edit/delete: it does NOT flow through OWD / sharing rules / role hierarchy (you don't need access to existing records to create one). The create level short-circuits the sharing cascade and is `visible` only when the user has object Create permission (`allowCreate`, or object/system Modify-All) AND — if the object has record types — at least one VISIBLE record type. A new `RecordType` stage reads `recordTypeVisibilities` and the object's record types; its verdict is ANDed onto the permission gate, so a Create grant with no selectable record type is `restricted` (not a false `visible`), and an object with no record types is not record-type-gated. `unknown` when the object has record types but the supplied profile/permission set carries no visibility data. JSON schema enum, JSDoc, MCP description, and 6 unit tests updated; verified on a real-org vault (an object with record types resolved to a `visible` create with its real creatable record types listed; a managed object with none resolved via Modify-All Data). The tool-smoke gate now probes the create level against a real org.
- **New `sfi.recordtype_availability` — "what record types can a user create / see".** Given a Profile or PermissionSet, it reads `recordTypeVisibilities` and reports, per object, the visible record types (a visible record type is one the user can pick when creating a record) and the default. This is the record-type half of "who can create a record" — it pairs with `object_access_audit`'s Create permission. `declared` confidence. Live-probed against a real-org vault in the smoke harness (an admin profile resolved 18 objects / 74 visible record types).
- **`sfi.field_access_audit` now answers "who can UPDATE this field"** via a new `update` block. FLS-edit on a field is not enough to change a value — the same Profile/PermissionSet also needs EDIT on the parent object, and the field must be type-writable. `update.canUpdate` lists the grantors that hold BOTH (FLS-edit ∩ object-edit); `update.fieldUpdatable` is false for formula / auto-number / roll-up-summary fields (value is derived); `update.recordEditDependency` notes that edit access to the specific record is also required (`why_cant_user_see_record` with `accessLevel: 'edit'`). The field tool is now also exercised live against a real vault in the smoke harness.
- **New `sfi.object_access_audit` — "who can create / read / edit / delete this object".** The object-level counterpart to `field_access_audit`: given a `CustomObject`, it enumerates every Profile and PermissionSet's CRUD grant (`allowCreate`/`allowRead`/`allowEdit`/`allowDelete`) plus object-level View All / Modify All, with summary tallies, at `declared` confidence. There was previously no tool for object CRUD-by-user (`crud_fls_audit` is an Apex security-check audit, not this). It's OBJECT permissions, not record visibility — it composes with `why_cant_user_see_record` (object grant here AND record access there). Phantom-aware for not-retrieved objects. Tool count 149 → 150.
- **`why_cant_user_see_record` answers edit & delete, not just view** (`accessLevel: 'read' | 'edit' | 'delete'`, default `read`). The cascade previously mapped `Read`/`ReadWrite`/`FullAccess` all to `visible`, so it only ever answered "can they view". Now every stage is raised to the requested operation: a Read OWD/grant/`ViewAllData` is **not** edit-capable; edit needs a ReadWrite OWD or an `allowEdit`/`ModifyAll`(`ModifyAllData`) grant; delete needs FullAccess or `allowDelete`/`ModifyAll`/ownership, and **sharing rules never grant delete**. So "who can edit/delete this record" is now a real, correct answer. JSDoc, JSON schema, MCP description + 3 unit tests updated.

- **`why_cant_user_see_record` now honors the `View All Data` / `Modify All Data` system permissions (god-mode).** These org-wide system perms bypass OWD and ALL record sharing for every object, but the access cascade never consulted them — so a user whose profile/permission set grants `ViewAllData` was wrongly reported `restricted` on a Private object. A new **SystemPermission** stage (after PermissionGrant) reads `properties.userPermissions` and returns `visible`. Honesty caveat: an active **RestrictionRule** can still filter even a View-All-Data user, so when the object carries one the stage reports `unknown` (with the caveat) rather than a possibly-wrong `visible`. Distinct from the object-level View All/Modify All already handled in PermissionGrant. (First of several access-model completeness fixes.)
- **`generate_sharing_summary` now surfaces criteria-based sharing rules and their predicate.** The per-object Sharing Rules table gained `Type` (criteria / owner) and `Criteria` columns, so a criteria-based access path is no longer hidden behind a bare rule name — it shows the `booleanFilter` predicate (the same description `why_cant_user_see_record` uses). The predicate is a declared rule definition; evaluating whether a given record matches still needs record-level data.

### Automation

- **New `sfi.lifecycle_process` — "what happens when {Object}.{field} becomes {value}".** A value / stage LIFECYCLE view, not a bare DML-event view: `order_of_execution` and `what_happens_on_save` answer "what runs on an insert/update", but nothing stitched the parts into the JOURNEY of a specific transition (Opportunity → Closed Won, a Case status flip). This composes `order_of_execution` for the transition's event (default `update`; `event: 'insert'` for creation) — so the chain always agrees with that tool — and annotates each step with `coupledToField` (its entry condition references the transition field) and `coupledToValue` (the condition expression mentions the value literal). `process[]` is the ordered, paginated chain; `coupledAutomation[]` is the complete subset gated on the transition (the value-add); `summary` tallies total / coupled / field-coupled / value-coupled. `confidence: 'parsed'`, with explicit `disclosures`: conditions are listed not evaluated (matching a record needs record data), value coupling is a literal expression match (can miss formula-encoded values), and the chain excludes manual actions, the runtime audit trail, roll-up/cross-object recalculation, and callouts. Tool count 154 → 155. Verified on a real-org vault — e.g. a Case → Closed transition surfaces the "Resolution Code required on closed case" validation rule coupled to both the field and the value.
- **`what_happens_on_save` and `order_of_execution` now model before-save record-triggered flows as the leading `before-save-flows` phase.** The SOE phase model started at `pre-save-triggers`, but before-save record-triggered flows (Spring '22) run BEFORE before-triggers — a whole leading phase was missing, so the order of execution was wrong for any org using them. Both tools now split record-triggered flows by the `triggersOn` edge's `triggerType`: `RecordBeforeSave` flows emit first in the new `before-save-flows` phase (insert/update only — they don't fire on delete), while `RecordAfterSave` flows stay in `post-save-flows`. The disclosure also now notes that workflow field updates can re-fire before/after-update triggers (a second pass) — the composition lists each automation once. JSDoc, MCP descriptions, and the verbatim disclosure updated in lockstep across both sibling tools; unit tests assert the new phase ordering. Verified on a real-org vault.

### User ability

- **New `sfi.user_ability` — "what can this profile / permission set RUN or DO" (beyond record CRUD).** The extractor now emits `flowAccesses` as `grantedBy` edges to `Flow` (a `flowAccess` marker, mirroring the `classAccesses`→ApexClass grant) and captures profile login restrictions (`loginIpRanges`, `loginHoursDefined`). The tool surfaces `runnableFlows` (Flows the container grants run access to, paginated), `loginRestrictions` (IP-range count + whether login hours are set — Profile-only, `applies:false` for a permission set), and `actionPermissions` (the run/export/transfer/convert/mass-edit class of system permissions present, filtered from `userPermissions`). `declared` confidence; discloses runtime assignment + flow-active dependency. Tool count 158 → 159. Extraction change → A7 refresh-integrity. Verified on a real-org vault (a guest permission set resolved to 2 runnable flows; an admin profile to 16 action permissions).
- **New `sfi.who_can_run` — the reverse: "which profiles / permission sets grant run access to THIS Flow".** Given a `Flow:` id it walks the incoming `grantedBy` edges filtered to the `flowAccess` marker and returns the granters (paginated, `granterId` / `granterType` / `granterLabel`). Phantom-aware: a Flow that exists only as the target of run grants (no node of its own) is still answerable. Rejects a non-`Flow:` id with an `invalid-query` that points to `sfi.app_access` (apps) and the live plane (report/dashboard folders). `declared` confidence; the always-present `boundaryNote` discloses that real access also needs the user assigned the profile/permission set (runtime) and that this is `flowAccesses` only — app and folder run-surfaces live elsewhere. No extraction change — reads the `flowAccess` edges `sfi.user_ability` already added → A7 skips. Tool count 159 → 160. Verified on a real-org vault (a managed-package flow resolved to the guest permission set that grants run access to it).

### Extraction — UI visibility

- **Lightning record pages (FlexiPage) are no longer bare nodes — new `sfi.lightning_pages` tool.** The extractor now captures a FlexiPage's `sobjectType` (which object), `pageType` (RecordPage / AppPage / HomePage — picked from the page-type set, since `<type>` is also used by regions/components), and `masterLabel`, and emits a `references` edge FlexiPage → `CustomObject:{sobjectType}`. `sfi.lightning_pages` reads both directions: `CustomObject:X` → the Lightning pages for the object; `FlexiPage:X` → the page's object / kind / label. **Honesty axis** (`activationDisclosure`, always present): which profile / record type / app / form factor ACTIVATES a page is NOT in the retrieved FlexiPage metadata (it's a separate Lightning App Builder assignment) — so the tool reports the pages that EXIST for an object, never which one a given user is served. This is the honest scope after confirming against real-org metadata that activations aren't retrievable. Tool count 157 → 158. Verified on a real-org vault (an object resolved to 4 Lightning record pages; the reverse resolved the page's object). Extraction change → A7 refresh-integrity.
- **New `sfi.app_access` — "what's in this app, who can open it, who defaults to it".** `CustomApplication` was extracted but no tool was app-centric. Given a CustomApplication it returns `navType`, `tabs` (the app's `CustomTab` ids in document order, from `belongsToApp` edges), `canOpen` (the Profiles/PermissionSets whose `applicationVisibilities` mark it `visible`, paginated) and `defaultedBy` (the granters defaulting to it). `declared` confidence; discloses that real access also needs the user to be assigned the profile/permission set (runtime). Tool count 155 → 156. Verified on a real-org vault (an app resolved to 11 tabs, 9 profiles able to open it, 7 defaulting to it).
- **New `sfi.tab_availability` — "what tabs can this profile / permission set see".** Reads the newly-extracted `tabVisibilities` and reports each tab's verbatim visibility enum plus a normalised `available` flag, tallied (available vs hidden), paginated. `declared` confidence; discloses that a visible tab is not object access and that assignment is runtime. Tool count 156 → 157. Verified on a real-org vault (an admin profile resolved to 59 tabs — 54 available, 5 hidden).
- **Profiles and permission sets now extract `applicationVisibilities` and `tabVisibilities`.** The extractor captured `layoutAssignments` + `recordTypeVisibilities` but not which apps a profile can open / defaults to, nor which tabs it sees — so "what apps can this user open", "what's their default app", and "what tabs does this profile see" were unanswerable at the data level. `profile.ts` now emits `properties.applicationVisibilities` (`{application, default, visible}`) and `properties.tabVisibilities` (`{tab, visibility}` — the verbatim `DefaultOn`/`DefaultOff`/`Hidden` enum); `permission-set.ts` emits the same (reading the permission-set `<tabSettings>` element as well as `<tabVisibilities>`). Both arrays are always emitted (`[]` when absent) so tools can distinguish "extracted, none" from "never extracted". This **self-heals the earlier tab-visibility honesty fix**: `compare_profile_across_vaults` and `what_if_merge_profiles` now compare real tab data and drop `tabVisibilities` from `notEvaluatedCategories`. Unblocks the new app/tab tools. Unit-tested; verified by a real-org re-extraction (a profile resolved to 40 application + 59 tab visibilities, and the merge tool's `notEvaluatedCategories` went empty).
- **List view `<sharedTo>` visibility is now modeled — new `visibleTo` edge + `sfi.list_view_sharing` tool.** A list view was a bare node: "who is this list view shared with" was unanswerable. The `ListView` extractor now reads the `<sharedTo>` scope (groups / roles / synthetic groups like AllInternalUsers, including the `roleAndSubordinates` hierarchy markers) and the `<filterScope>`, mirrors them onto `properties.sharedTo` / `properties.filterScope`, and emits a **new `visibleTo` edge** (ListView → Group/Role) — edge-type count 21 → 22. `visibleTo` is deliberately DISTINCT from `sharedWith` (record access): it grants visibility of the saved VIEW, not the records, so record-access tools never read it. The `<sharedTo>` variant→id table is shared with the sharing-rule extractor so the two never drift. `sfi.list_view_sharing` reads both directions: `CustomObject:X` → all of the object's list views + their sharing scope (paginated); `ListView:X.Y` → one view. `declared` confidence; the always-present `boundaryNote` discloses that this is view visibility NOT record access, that `filterScope` is a separate record-filter axis, and that a view with no `<sharedTo>` is visible to all who can see the object (absence is never "private"). Tool count 160 → 161. **Real-org oversize caught by the real-org probe:** an object with 146 list views overflowed the MCP response limit (~47 KB) at the old page size, so the page is capped at 120 rows (~40 KB) with `hasMore`/`offset` walking the rest. Extraction change → A7 refresh-integrity. Verified on a real-org vault (366 `visibleTo` edges baked in; Contact resolved to 146 list views, 82 shared to roles/groups; a single view resolved to a role-and-subordinates target).

### First run & onboarding

- **First-run hardening sweep — exit codes, empty exports, temp hygiene, honest doctor telemetry.** Four fixes from an adversarial clean-machine review: (1) `sfi selftest` exited **0** when the vault could not open at all — a missing/corrupt vault read as success in CI; it now exits 1 (new `selftestExitCode` seam + tests). (2) `sfi feedback export` with nothing logged wrote a meaningless all-zero file and reported success; it now says "nothing to export yet" and writes nothing — and a write failure (unwritable path) prints an actionable message with `exitCode 1` instead of a stack trace. (3) `sfi refresh` wrote a temp `package.xml` per retrieve (main + B29 expansion + `--with-reports`) and never deleted any of them — all three sites now clean up in a `finally`. (4) `sfi doctor`'s Route-gaps line said "no route gaps logged" for a machine whose MCP server had never logged anything, indistinguishable from a clean audit; an absent log now reads "no route-gap log yet (the MCP server has not logged routing on this machine)". All four verified live on a clean temp machine against the built CLI.
- **New `sfi quickstart` — a guided "where am I and what's next" for a fresh checkout (P12-FIRSTRUN-quickstart).** Instead of making a newcomer guess the `init → refresh → ask` arc, `sfi quickstart` reports each step's state (sf CLI present, vault initialised, refreshed, MCP-ready) and points at the single next action. Once the vault is built it seeds a few starter questions drawn from the user's OWN components (preferring the least-namespaced custom objects), so the first thing they try is grounded in their org, not a generic example.
- **New `sfi selftest` — "does my vault actually answer questions?" (P12-FIRSTRUN-selftest).** After a refresh, `sfi selftest` runs 6 real queries against the freshly built vault (schema listing, coverage, org overview, `field_360`, `get_impact`, and a `find_component_usages` USAGE probe on one of the user's own components) and reports "your vault answers N of M question types" — a confidence signal, not just "refresh complete". A vault that can list components but can't answer a usage question is surfaced, not hidden. No vault → an actionable `sfi init` / `sfi refresh` message.
- **`sfi refresh` warns before a large-org pull (P12-FIRSTRUN-refresh-preflight).** A first refresh against a big org can retrieve for a long time with no signal. A preflight (`assessRefreshSize`) now reads the prior refresh's component count and, above a large-org threshold, prints a heads-up that the pull may take a while (and that `--no-pull` recomputes from existing source) before shelling out to `sf project retrieve` — so a long retrieve is expected, not mistaken for a hang.
- **`sfi doctor` is now a real first-run triage (P12-FIRSTRUN-failure-ux, P12-ROUTER-confusion-report).** Two gaps filled beyond the existing sf-CLI / auth / vault / freshness checks: (1) a new **Vault contents** check FAILS a vault that exists but modeled 0 components (a silent empty refresh) with a re-refresh / widen-scope fix, instead of a false all-green; and (2) a healthy setup now ends with the one failure `doctor` itself can't probe — the MCP client may not be connected — pointing at `sfi mcp` / `sfi quickstart`. It also surfaces a **Route gaps** line (informational, never blocking health) that counts logged `unknown`-route questions and the top category from the local gap log, so you can see what the router couldn't answer.

### Product experience

- **`sfi init` ends with a loud, one-screen "what this does (and does NOT) do to your org" guarantee — mirrored on the website (P12-TRUST-firstrun).** The first question an enterprise tester asks before pointing a new tool at production is "what is this going to DO to my org?" `sfi init` now prints a boxed notice with the five standing guarantees: READ-ONLY (no write/deploy/delete path — only `sf project retrieve`), OFFLINE by default (answers come from the local vault, the org is touched only on `sfi refresh`), LOCAL & never uploaded (no telemetry, no phone-home; feedback stays local), the live plane is OFF until you explicitly enable it (and even then read-only, curated roster, never arbitrary SOQL), and the npm package ships NO org data (a `files` whitelist keeps the vault out, and every public version has been grepped clean — the leak audit). Each line is a guarantee the codebase actually enforces. The website gains a matching `#org-safety` section so the same promise is the first thing a visitor reads. Shared `TRUST_GUARANTEES` constant + unit tests pin the five guarantees; `scan:leaks` clean.
- **New `sfi feedback` command + a visible feedback channel, all local (P12-FEEDBACK-loop).** A weak/wrong/unrouted answer is the highest-signal thing a user can return, but there was nowhere to put it. `sfi feedback mark "<question>" --wrong|--weak` records the rating to a LOCAL log (`~/.sf-intelligence/feedback.jsonl`, override `SFI_FEEDBACK_LOG_PATH`); `sfi feedback export` bundles that plus the already-local route-gap log into one scrubbed `sfi-feedback.json` — emails, URLs, and Salesforce record ids are redacted while component/api names (the actual routing signal) are kept. Nothing phones home: both the marking and the export are pure local file I/O, and the export only ever names the issues URL for the user to share by hand. The issues link is now surfaced in three places — `sfi doctor`'s footer, the README (`## Feedback`), and the website footer — so feedback has a home. Verified end-to-end: a `mark` then `export` produced a scrubbed file (gaps + ratings) with org PII stripped; unit tests cover the scrubber and the empty-log path.
- **`sfi.synthesize_answer` returns a grounded action skeleton — Finding → Evidence → Cause → Fix → Risk → Next-action (P12-UX-synth-next-action).** Beyond the citation-grounded summary/bullets, it now emits an `evidence` block: `finding` (the headline fact), `evidence` (the cited ids), `likelyCause`, `recommendedFix`, `risk`, and `nextAction`. Every field is lifted VERBATIM from the source tool output (a `reason` / `recommendation` / `nextStep` / caveat field) and is `null` when the source carried nothing for it — so the recommended action is **never fabricated**; `nextAction` falls back to the recommended fix (also from the source). `orphanComponentIds` flags any canonical id mentioned inside a cause/fix/next string that is not independently cited (an ungrounded reference), reusing the no-hallucination guard. Verified on a real-org vault (a delete-safety result produced a grounded `risk` from its own disclosure, with `likelyCause`/`nextAction` correctly `null`).
- **`sfi.capabilities` now leads with persona QUESTION PATHS, not a flat tool list (P12-UX-capabilities-personas).** The `personas` grouping grew from 3 roles to 5 — added **release-manager** (is the org safe to deploy / what changed / change risk / which tests to run) and **support** (why can't a user see a record / value-stage lifecycle effects / who can run a flow / the runtime "what happened" boundary). Each persona's old `exampleQuestions` string list is upgraded to `questionPaths` — every entry is an operational question PLUS the ordered `sfi.*` tools that answer it (e.g. "What breaks if I change this field's type?" → `resolve` → `what_if_change_field_type` → `get_impact`). A unit test pins every path tool to a real `V01_TOOLS` entry, so a renamed/removed tool fails the build instead of advertising a dead path. Reframes the pitch from "161 tools" to the operational questions admins / developers / architects / release managers / support actually ask. Verified on a real-org vault (all 5 personas render with 4 grounded question paths each).

### Honesty fixes

- **Plural field/value phrasings now reach the live `field-population` route.** The `field-population` patterns matched `\b(field|value)\b` only, so "which Account **fields** are empty" / "how many Contact **fields** are blank" missed the hybrid live-data intent and fell through to `metadata-count` — a vault METADATA count answering a live DATA question. The patterns now accept `fields?`/`values?`. Verified live: four plural phrasings route to `field-population` (hybrid) while the guard questions hold their routes ("how many custom fields are on Account" stays `metadata-count`, "empty queues and groups" stays `empty-queues-groups`). Router unit tests cover the plurals.
- **`route_question` now routes runtime audit-trail questions to an honest disclosure instead of fabricating or going dead-`unknown`.** "Who changed this record", "field history", "Setup Audit Trail", "who deleted X", "debug logs", "what happened to this account" are RUNTIME audit data the offline vault cannot hold. A new `runtime-audit-trail` router intent catches them and points to the metadata-side fallbacks (`last_modified` / `changed_since`) with a `gap` note that names the boundary — and clarifies that `why_field_changed` is metadata causality (which automation writes a field), not who edited a record. It is placed ahead of the broad `history-change` matcher so "field history" is no longer mis-read as a metadata diff; metadata questions ("what changed since the last refresh", "why did the Status field change") are unaffected. Router unit tests + a harness battery family cover it.
- **CI gate: a tool can no longer ship without a router entry (P12-ROUTER-intent-coverage).** The 11 Phase-11 access/UI tools were unreachable from `route_question` for a release because nothing failed the build when a tool had no router intent. A new router↔roster contract test now asserts every `V01_TOOLS` tool is either router-reachable (`allRoutableTools()`) or on an explicit, documented grandfather list of intentionally-not-router-primary tools (meta/front-door, opt-in live-plane helpers, sub-tools reached via a bundle) — a NEW tool that is neither fails the build; and a companion test fails if a now-routable tool is left stale on the grandfather list. (Subsumes the legacy product-surface-gate.)
- **Router reaches OmniStudio component + managed-package-extension questions (P12-ROUTER-omni-cpq, P12-ROUTER-extension-first).** "what omniscript**s** do we have" and "what **data raptors** exist" went `unrouted` — the omnistudio pattern matched `\bomniscript\b` (not the plural) and `dataraptors?` (not the two-word "data raptor"); widened to plurals + optional spaces (+ decision tables). And "what components **extend** the X package" now routes to `package_impact` (its extension-first surface — your customizations grafted onto a managed package's objects) instead of falling through. "find dead code" already routed to the one canonical `find_dead_code` (P12-ROUTER-dead-code verified). Router unit tests cover the new phrasings.
- **Router near-miss disambiguation — three collapsed distinctions fixed (P12-ROUTER-disambiguation).** (1) "governor limit **risks**" routed to `live_org_limits` (org telemetry) instead of `governor_limit_risks` (static Apex risk) — the org-limits negative-lookahead matched `\brisk\b` (singular) but not "risk**s**"; widened to `\brisks?\b`. (2) "what if I change a field **to a text field**" (a field-TYPE what-if) fell to generic `impact-analysis`/`get_impact` — the `if I change …` blast-radius pattern now excludes the field-type / `field type` / `picklist value` / `required` phrasing so it reaches `what-if-field`. (3) Added the `who-can-access-object` intent (reverse of `why-cant-see`): "who can see / view all **Account records**" routed to `field_access_audit` (a field tool) — now `who_can_access_object`, anchored to "records" so it never steals a field question. A new near-miss collision bank (forward-vs-reverse access, field-type-vs-blast-radius-vs-value-change, apex-governor-vs-org-limits, vault-diff-vs-runtime, runnable-flows-vs-save-order) asserts each pair routes to its correct DISTINCT intent and is wired into the gate.
- **`route_question` now reaches the P11 access/UI tools — 11 tools that were unrouted or routed to the WRONG tool are now selected correctly (P12 router MOAT).** The Phase-11 access/UI tools shipped without router entries, so natural-language questions for them either went `unrouted` (`who_can_run`, `app_access`, `tab_availability`, `effective_permissions`, `object_access_audit`, `lifecycle_process`) or were stolen by a broader intent and routed to the WRONG tool — `list_view_sharing`/`recordtype_availability` fell to `list_components`, `lightning_pages` to `list_components`, and "what flows can this user run" mis-routed to `what_happens_on_save`. Added nine new router intents (`user-ability`, `who-can-run`, `app-access`, `tab-availability`, `list-view-sharing`, `recordtype-availability`, `effective-permissions`, `object-access`, `lifecycle-process`) placed at the top of the access cluster so a tool-specific question wins, each anchored to its tool's NOUN so it never steals the generic field/record/layout questions; and pointed the existing `flexipage` intent at `lightning_pages`. Verified on a real org (17/17: 11 new tools route correctly + 6 regression guards hold) and against the 1000-question regression bank (0 routes stolen). Router unit tests cover all 11.
- **`route_question` recognises folder-gated ACCESS questions and discloses the offline boundary (P11-UI-folder-access).** Who can see a report / dashboard / document is the *folder's* share settings (FolderShare) — runtime Folder metadata the offline vault does not retrieve (it has only the names). The existing `folder-access` intent matched only the literal word "folder", so "who can see this dashboard" / "who can access the Pipeline report" fell through. Its patterns now catch the access phrasing without "folder", and it carries a structured `gap` disclosing that folder shares are not in the offline plane (use the live plane / `live_folder_access`) — explicitly distinct from list-view sharing (offline, `list_view_sharing`) and record access (`object_access_audit` / `why_cant_user_see_record`). Modelling FolderShare at extraction is deferred (the retrieved metadata carries no folder shares to verify against), so this is the honest disclosure path, not a fabricated offline answer. Router unit tests cover the new patterns + the disclosure.
- **Greenfield architecture / strategy questions now route to the guidance knowledge plane, not a descriptive org tool (P12-ROUTER-architect-synthesis).** "What should I know before building a new integration", "when designing a new org…", a prescriptive-modal + greenfield frame is a *guidance* question, not a "describe my org" question — but it fell through to a descriptive tool or `unknown`. A high-precision router rule (placed first) recognises the prescriptive modal + greenfield framing (`greenfield` / `new org` / `before building a new` / `when designing a new` / `for a new project`) and routes to the `knowledge` plane (`sfi.guidance`). It is deliberately narrow — descriptive org questions ("what automation runs on Contact", "what should I know before building **on** Contact") are unaffected. Router unit tests + a gold case cover it.
- **Capped enumerations now DISCLOSE truncation instead of implying a complete list (P12-HONESTY-scan-cap-disclosure).** `who_can_access_object`, `layout_assignments`, and `app_access` scan nodes per metadata type, and `listNodesByType` caps a scan at 500 — so on a very large org the enumeration could silently stop short and read as the whole answer. A shared `scan-cap` helper (`nodeScanLimit`, env-overridable via `SFI_NODE_SCAN_LIMIT`, `scanHitCap`, `scanTruncationNote`) now sets `scanTruncated` + a `boundaryNote` on each tool when a per-type scan hits the cap, so a partial enumeration is labelled partial. Neither gate vault reaches the cap, so the truncated path is proven via the env override (`SFI_NODE_SCAN_LIMIT=1` against a 2-profile fixture) rather than a 500-node org. MCP descriptions + unit tests updated.

- **`compare_profile_across_vaults` and `what_if_merge_profiles` no longer report a fabricated "no tab-visibility drift / no tab conflicts".** Both tools compared `properties.tabVisibilities`, but no extractor populates that property — so the comparison always ran over an empty map and silently claimed parity, a false negative that asserted a capability the data doesn't back. Both now DISCLOSE the gap instead: `tabVisibilities` is listed in `summary.notEvaluatedCategories` (excluded from the drift counts / `agreed`), with a boundary disclosure, rather than counted as zero drift. The gate is data-driven and self-heals — once `properties.tabVisibilities` is extracted, the category is compared normally and drops out of `notEvaluatedCategories`. Verified on a real-org vault (the category now discloses rather than false-passing). JSDoc, MCP descriptions, and unit tests (including a self-heal case) updated.

### API consistency

- **The response-consistency guard now also covers the OUTPUT surface (ADR-007 phase 2).** Phase 1 was static — it read declared *input* schemas. Tools declare no output schema, so the output shape can only be observed by running each tool: `tool-smoke` now records every tool's output ROW keys, and a new `analyzeOutputShape` (pure, unit-tested in `response-consistency.ts`) plus the harness `check-output-shape.mjs` guard (gate step `harness:output-shape`) flag the same canonical-id drift on the output side that phase 1 catches on the input side — a NEW tool emitting a non-canonical id key (`id` / `fieldId` …) in its rows instead of `componentId`. Additive, detect-only, baseline-grandfathered (today's output id keys — `profileId`, `recordTypeId`, `settingId`, `toId`, … — are recorded so only new drift fails). Dev/CI only — no runtime change.
- **A detect-only gate guard now contains MCP response-surface drift (ADR-007).** Programmatic consumers hit several spellings of "the component a tool targets" (`componentId` / `fieldId` / bare `id`) and growing. Renaming is breaking (0.1.7 is published), so this is *additive*: `componentId` is declared the canonical input key, today's usage is grandfathered in a committed baseline, and `pnpm check:response-consistency` (gate step `ci:response-consistency`) fails only when a NEW tool introduces a non-canonical id key — steering new tools to `componentId` without changing anything shipped. Pure analysis in `response-consistency.ts`, unit-tested; ADR-007 records the canonical `{data, vaultState}` envelope policy. Output-shape unification (verdict placement, output-row keys) is tracked as a phase-2 follow-up. Dev/CI only — no runtime change.

### Skills

- **Every coaching skill now carries the grounding & routing contract.** An audit found only 2 of the 25 skills referenced all three of `sfi.route_question` (route a vague ask first), the `sfi.*` tool cascade, and `sfi.synthesize_answer` (ground the answer, flag `hallucinatedIds`). A consistent shared-contract footer was added to the other 23, so a specialist skill that loads on its own still reinforces "route → tools → ground, never invent ids" — the same discipline the entry skill teaches. Documentation only.

### Tools

- **`sfi.capabilities` now groups its capability map by persona (admin / developer / architect).** Alongside the existing category map, the response carries a `personas[]` array: each persona has a title, a description, the `categoryIds` most relevant to its job, and a few questions it literally asks — so an agent can orient a user by their role ("I'm an admin") instead of the product's internal taxonomy. Admin → access / automation / govern / find / docs; developer → impact / automation / integration / understand / find; architect → integration / impact / docs / govern / understand. Curated and additive (no behavior change); a unit test pins every persona `categoryId` to a real category so the grouping can't drift.
- **New `sfi.layout_assignments` — the reverse of `layout_for_user`: "what is this page layout assigned to".** Given a page Layout canonical id, it enumerates every (Profile × RecordType) assignment that targets it — the question an admin asks before editing or deleting a layout. It reads the same `properties.layoutAssignments` surface `layout_for_user` routes through, so the forward and reverse tools agree by construction (it imports the forward tool's matching helpers rather than re-deriving the format). `summary` reports distinct profiles + total assignments (complete); the inline list PAGES (`limit`/`offset`/`hasMore`/`truncated`) because a widely-shared standard-object layout is assigned by every profile × record type — hundreds of rows past the response limit. `declared` confidence. Honesty axis: classic page-layout assignments via Profiles only (Lightning record pages and the org-wide default assign differently, disclosed in `boundaryNote`); if no profile carries an extracted `layoutAssignments` property the result is disclosed as "not modeled", never a false "no assignments". Tool count 151 → 152. Verified on a real-org vault (an org-wide Account layout resolved to 50 profiles / 295 assignments, paged under the limit).
- **`sfi.generate_architecture_overview` can now export a self-contained HTML page (`format: 'html'`).** The default still returns the structured markdown `document`; with `format: 'html'` the response ALSO carries an `html` string — one standalone file that renders the markdown and its mermaid diagrams (org structure, domain clustering, integration topology) client-side, and degrades to the readable raw markdown when offline. Write it to `architecture.html` to share the overview outside an MCP client. The renderer (`renderHtmlDocument`) is pure, escapes all embedded text, and is unit-tested.

### Hardening — onboarding smoke

- **A CI smoke now drives the real new-user onboarding chain end to end — `sfi init` → `sfi refresh --no-pull` → `sfi doctor` → sample MCP queries — on a self-contained synthetic fixture, with no live org and no `sf` CLI.** The existing end-to-end smoke builds its vault at the graph level, so it never exercises `init`/`refresh`; this one proves the *commands a new user actually runs* produce a queryable vault. It asserts the refresh modeled every metadata type in the fixture, that `doctor`'s vault-side checks (Vault / Freshness / Graph) pass — tolerating the Org-auth failure a fixture legitimately can't avoid — and that the spawned `sfi mcp` server answers `health_check` / `list_components` / `resolve` / `get_component` against the freshly-built vault. Wired into the commit gate; run it directly with `pnpm onboard:smoke`. Dev/CI only — no change to the shipped product.
- **A CI guard now enforces parity between the `/sfi-*` slash commands and the `sfi` CLI.** Each slash command (`.claude/commands/sfi-*.md`) is a thin wrapper that tells the agent to run `sfi <subcommand>`; the guard fails the gate if any referenced subcommand is not a registered CLI command (the silent break when a command is renamed) and if a slash file's own name maps to neither a CLI command nor an allow-listed composite wizard (`/sfi-onboard`). It also reports CLI commands with no slash wrapper for visibility. Run it with `pnpm check:slash-parity`. Dev/CI only.

### Docs

- **The installation guide now opens §2 with an at-a-glance table of the three install modes** — `npx` (zero-install, used for the MCP server registration), a global `npm install -g` (a short `sfi` for everyday CLI use), and a repo-local `npm install` (version-pinned per repo, resolved by `npx` with no re-download) — so the trade-off between them is one read instead of scattered across the section.
- **The onboarding guide now explains reloading the MCP server after a refresh.** The server opens the vault read-only once at startup and holds it for its lifetime (so multiple instances can share a vault), which means a `sfi refresh` is not reflected in an already-running server until it is reloaded, and a running server's shared lock can block the refresh's exclusive write (the `locked` error). The new section gives the reason and the per-client reload steps (Claude Code / Cursor / Claude Desktop).

## [0.1.7] — Publish safety (unreleased)

A trust-and-publish-safety release. The headline is **honesty under the hood**:
the router now answers vague discovery questions in one hop, phantom (referenced-
but-not-retrieved) objects and empty results explain *why* they're empty instead
of reading as "nothing here", `sfi doctor` warns when the vault has aged, and the
grounding cascade (tools → `synthesize_answer` → prose, flagging any orphan id)
is enforced in capabilities, the skills, and CI. A latent extractor bug that made
ApprovalProcess step counts `0` on every real org is fixed. Quality gates met:
1000Q **97.8%** effective (0 hard errors, 0 route_gap), complex-long **72/75**,
baseline-300 **83%**, and the `release/0.1.7` git history is leak-free.

### Graph — precision: resolve Apex local / loop-variable receiver types

- **Field accesses through a typed local or loop variable now resolve to the real object (`CustomField:Account.Status__c`, not the alias `CustomField:a.Status__c`):** the heuristic Apex scanner already tracked declared locals to suppress phantom `callsApex` edges, but field accesses kept the *alias* as the object — so `for (Account a : accs) { a.Status__c = ...; }` minted a meaningless `CustomField:a.Status__c` edge instead of the real `CustomField:Account.Status__c`. The scanner now captures each local/parameter's declared type and resolves the receiver, both **removing the alias phantom** and **adding the correct `apex → field` edge the graph was missing** — so `find_apex_usages` / `field_360` / `get_impact` now see Apex that touches a field only through a loop variable. Conservative by construction: only a single, consistent, SObject-ish PascalCase type is resolved; a local declared with conflicting types, a `var`, or a collection type (`List<Account>`) keeps its alias, and two aliases of the same type collapse to one edge. Extraction-time — takes effect on the next `sfi refresh`. This closes the general loop-variable case that the trigger-context cleanup below had deferred.

### Graph — precision: drop unresolvable trigger-context phantom edges

- **The Apex scanner no longer emits dangling `ApexClass:newMap` / `CustomField:trigger.*` phantom edges:** `Trigger.newMap` / `Trigger.oldMap` parse as a bare `newMap` / `oldMap` receiver, and `trigger` / `Trigger` / `this` / `super` are context handles, not objects — so the heuristic scanner was creating `callsApex` edges to a non-existent `ApexClass:newMap` and `readsFrom` edges to `CustomField:trigger.newMap`, which surfaced as garbage in `what_happens_on_save` / `explain_apex_method` / `get_impact` output. The edge builder now skips these unresolvable receivers / pseudo-classes. (The general loop-variable receiver case is now handled — see the local / loop-variable type-resolution entry above.) Extraction-time — takes effect on the next `sfi refresh`.

### Graph — relationship edges (new moat capability)

- **Lookup / Master-Detail relationships are now first-class graph edges (`lookupTo`):** previously a relationship field's target object lived only in the field's `referenceTo` property — *not* a traversable edge — so dependency walks couldn't see the data model (`get_impact` on an object did not list the inbound lookups pointing at it). The custom-field extractor now emits a `lookupTo` edge from each Lookup / Master-Detail field to the `CustomObject` it references, with `properties.relationshipType` ("Lookup" / "MasterDetail"); a polymorphic lookup emits one edge per target. The new edge type flows automatically into `get_edges` / `get_impact` (the Zod enums derive from the contract's `EDGE_TYPES`). Extraction-time — takes effect on the next `sfi refresh`. On a real org this adds ~126 relationship edges (93 Lookup + 33 Master-Detail) that were previously invisible to the graph. (Consumer wiring — inbound-relationship answers, traversal opt-in — follows.)

### Hardening (Phase 10 — testing)

- **Architecture Decision Records for the load-bearing decisions (`docs/decisions/`):** six ADRs now record the *why* behind the decisions a maintainer must not break unknowingly — the confidence-tier trust model (ADR-001), the offline-vault vs opt-in read-only live-plane boundary (ADR-002), the closed `EdgeType` union with `targetMissing` dangling refs (ADR-003), the six-bucket phantom taxonomy computed on demand (ADR-004), the global MCP response byte budget + per-family sub-budgets (ADR-005), and READ-ONLY DuckDB access for query consumers (ADR-006). Descriptive of decisions already in force, recorded retroactively so the context lives in the tree instead of commit messages and memory. Doc-only.
- **`@sf-intelligence/core` now carries module-level JSDoc:** `core` was the only package entrypoint without a top-of-file doc. Added one stating what it owns — the project-wide `ok`/`err`/`Result` error-handling convention (`err()` for recoverable failures vs `throw` for invariant violations) — and its place at the bottom of the dependency graph (depends only on `contracts`, no I/O). The other entrypoints and the non-obvious internals (graph edge tagging, the shape-gotcha extractors, live-plane consent/budget/SOQL, the router) were already documented; this fills the lone gap. Doc-only.
- **A full `refresh --no-pull` now reflects deletions — a component removed from `source/` is dropped from the graph, not orphaned:** the default graph import is upsert-only (`INSERT OR REPLACE`), so a component whose source file was removed used to ORPHAN as a stale node (it lingered in the vault claiming to exist). A **full, clean, no-pull** refresh now does a truncate + re-import (`fullRebuild`) so the graph mirrors the authoritative source — byte-identical to the prior result when nothing was deleted (verified by the P10-A7 incremental==cold work), and correctly dropping what was. Tightly gated so it can never wipe live data: it requires `--no-pull` (the source is user-controlled — there is no `sf project retrieve` that could flakily return fewer types), a FULL refresh (no `--types` scope — a scoped run only extracted some types), and zero extraction failures (a parse error must not delete a node). A scoped, pulled, or partial refresh stays upsert-only (preserve). +2 tests (a removed class is dropped; a scoped refresh preserves untouched types). **Known limitation (tracked):** a component deleted in the ORG is not yet auto-dropped by a default `sfi refresh` — `sf project retrieve` does not clean `source/`, so the stale file lingers and is re-extracted; to drop it today, remove its file from `org-kb/source/` (or re-`/sfi-init`) and run `sfi refresh --no-pull`. Found via the P10-A7 refresh-integrity review.
- **`tech_debt_score` now cites the heuristic tier when its codeQuality axis contributes:** the codeQuality category is built from the heuristic Apex scanner (regex/token, not a compiler), but the score's `boundaries[]` disclosed direction, weighting, and excluded axes without ever noting that the codeQuality input carries `confidence: heuristic`. A composite score that blends a heuristic signal must cite the tier (the product's trust contract — "always cite the confidence tier"), so a caller doesn't read the codeQuality contribution as exact. The disclosure surfaces only when codeQuality actually contributes (the axis ran and was not excluded). Found via the Phase-10 A4 honesty-invariants battery.
- **Flow `$Record` condition references now resolve to the real field, not a phantom `CustomField:$Record.*`:** a record-triggered Flow's decision/condition refers to the triggering record as `$Record.<field>` (and the before-image as `$Record__Prior.<field>`), but the condition extractor minted a phantom `CustomField:$Record.<field>` id — `$Record` is the flow's start object, not a real object — and `what_happens_on_save`, `order_of_execution`, AND `get_impact` surfaced those phantom ids verbatim in their `conditional.fieldRefs` / `conditions[].fieldRefs`. The extractor now resolves `$Record.`/`$Record__Prior.` to the flow's start object (already threaded as `parentObjectApiName`): on an Account-triggered flow `$Record.Status__c` becomes the real `CustomField:Account.Status__c`; a multi-hop `$Record.Parent__r.Name` anchors on the object (`CustomField:Account.Parent__r.Name`, consistent with how every other cross-object dotted ref is handled). Other globals (`$User`, `$Organization`, `$Setup`, …) are NOT the flow's object and stay verbatim. Applied to both the criteria and formula-tokenizer resolution paths. Extraction-time — takes effect on the next `sfi refresh`; verified on a real org (re-extracted: `CustomField:$Record.*` count 0, the ex-phantoms now resolve to real fields). The standard `<start><object>` was already extracted; this just stops `$Record` from masquerading as an object. (The matching v2.0a-era "the narrator can re-resolve `$Record` at render time" comment described a re-resolution that was never wired — now done at extraction.) Found via the Phase-10 A3 cross-tool consistency battery.
- **`get_edges` is now paginated, so a hub node no longer dead-ends on the response guard:** `get_edges` returned EVERY incident edge, so a standard object with hundreds of edges (e.g. Account: 300+) overflowed the global ~45 KB response guard — and the guard's advice ("re-query with pagination") was un-actionable because the tool had no `limit`/`offset`, only `edgeType`/`direction`/`confidence` filters. Added `limit` (default 200, max 1000) + `offset` with `totalCount` (the unpaged total), `hasMore`, and `nextOffset` to page the full set, plus a per-response ~38 KB byte-budget trim (with a `note`) for edges carrying wide `properties`. The paging lives in the `get_edges` handler, NOT in the shared `listEdges` graph query — the analysis tools (`find_dead_code`, `unused_components`, …) depend on the complete edge set, so capping there would starve them. Verified on real orgs: an Account `get_edges` that previously tripped the guard now returns 184–186 of 300+ edges at ~38 KB with `hasMore`/`nextOffset` to walk the rest. Found via the Phase-10 A1 multi-org matrix (the only tool that hit the guard with no pagination recourse).
- **`route_question` rescues a bare component reference to `sfi.resolve` instead of dead `unknown` (router gap batch 4 — closes the last 3):** a short phrase that merely NAMES a component with no question ("payment object", "the status picklist", "evaluation status") used to route to `unknown` — technically honest (the fallback already said "resolve any named component"), but a caller reading the contract was told "I don't have that capability" for something the org clearly has. The `route_question` *handler* (not the pure router, which stays I/O-free) now applies a vault-gated fallback: when the deterministic router can't place a phrase, AND the phrase is short (≤3 tokens), AND it resolves to a real vault component (`sfi.resolve` disposition `exact`/`ambiguous`), it routes to the `vault` plane with `sfi.resolve` (intent `component-lookup`) rather than `unknown`. Gated tight on BOTH the token cap and a confident resolve so out-of-scope phrases stay `unknown` — the fuzzy resolver returns `ambiguous` for 4-token noise like "query my MongoDB collections", so the cap, not just the resolve gate, is load-bearing. Right-question routing 80/83 → **83/83**; the 36-question out-of-scope/nonsense battery still routes entirely to `unknown` (no fabrication). Found + closed during Phase-10 A5 router hardening.
- **RestrictionRule / ScopingRule are now actually extracted (real `.rule-meta.xml` layout):** both "supported" types were configured for a `.restrictionRule-meta.xml` / `.scopingRule-meta.xml` suffix nested under an object — but Salesforce stores them as **top-level** `restrictionRules/{Name}.rule-meta.xml` / `scopingRules/{Name}.rule-meta.xml`. The refresh walker's directory→type detector and the extractor configs both used the wrong suffix + layout, so these files matched nothing and were silently skipped as an "unknown directory" — the types never extracted on real metadata. Corrected the detector + both extractor configs to the real `.rule-meta.xml` top-level layout, and added extractor tests (there were none). Found via a grounded real-org refresh during Phase-10 hardening (a real org's `restrictionRules` were skipped).
- **Sharing rules no longer drop community/partner sharing on `<allPartnerUsers>`:** the `<sharedTo>` variant table recognized `allCustomerPortalUsers` but not `allPartnerUsers` — Salesforce's real element for sharing to *All Partner Users* (the table carried a wrong-guessed `partnerUsers` instead). So any criteria/owner sharing rule sharing to all partner users was rejected as `malformed-input` and the **whole `*.sharingRules` file was dropped** (observed on DocumentTemplate / OmniDataTransform / OmniProcess in a real Experience-Cloud org). Added the `allPartnerUsers` variant. Found via a grounded real-org refresh during Phase-10 hardening.
- **`sfi refresh --with-reports` pulls folder-based Reports/Dashboards + folds their field usage onto fields (P11-G2b):** the default retrieve's `<members>*</members>` only pulls *unfiled* reports, so a field used only in a report column/filter or dashboard component was invisible — and read as unused. The opt-in `--with-reports` flag enumerates report/dashboard folders via SOQL, retrieves each `Folder/Name` explicitly, and folds the field usage onto the referenced `CustomField` as `usedInReport` / `usedInDashboard` (no per-report node — folder-based metadata is high-volume). `safe_to_delete_field` now reports such a field as `analytics`/blocking (never `safe`), `find_field_anywhere` surfaces the usage, and `unused_fields_deep` excludes it; each carries the honesty caveat when the vault was refreshed without it. Off by default (slow on large orgs — enumerates folders + pulls every report/dashboard). Live-verified on a large real org: 3,373 reports + 83 dashboards → usage folded onto 991 fields, zero report nodes. (Propagation to `find_dead_code` / `field_cleanup_candidates` / `field_360` follows.)
- **`unused_fields_deep` stops treating report/dashboard-only fields as deletion candidates (usage modeling + honesty floor):** a field whose only use is a report column/filter or a dashboard component had no graph signal, so it surfaced as "high-confidence unused." The refresh now folds report/dashboard field usage onto the referenced `CustomField` as `usedInReport` / `usedInDashboard` (a post-pass that drops the folder-based, high-volume report/dashboard nodes — usage on the field, no per-report node bloat), and `unused_fields_deep` excludes any field carrying that signal. Because reports/dashboards are off by default (folder-based, expensive to pull), the tool now also discloses the gap in its `boundaries`: without the opt-in report/dashboard pull, a report-only field can still appear — so an "unused" verdict reads as "no static evidence" rather than "definitely unused." (The opt-in `--with-reports` retrieve that performs the folder enumeration + pull, and propagation to `find_dead_code` / `field_cleanup_candidates`, follow.)
- **Report/dashboard usage now honored across every field-deletion / dead-field tool (`find_dead_code`, `field_cleanup_candidates`, `field_360`):** completing the `--with-reports` cluster, the folded `usedInReport` / `usedInDashboard` signal is read by the remaining consumers so a report/dashboard-backed field is never mislabelled dead or suggested for cleanup. `find_dead_code` excludes such a field from the dead set (the usage is a node property, not an edge, so the in-degree CTE can't see it — it's resolved in SQL via `json_extract_string`) and discloses the `--with-reports` caveat alongside the CustomField disclosure; `field_cleanup_candidates` inherits the exclusion from `unused_fields_deep` and now surfaces the caveat in its `disclosure` so the list isn't mistaken for a safe-to-delete set; `field_360` surfaces folded usage as a positive *in-use* signal (replacing the now-inaccurate static "report/dashboard references NOT extracted" boundary lines, which `--with-reports` invalidated) and otherwise discloses the caveat. The SOQL→`package.xml` member builder behind the retrieve was extracted to a pure `buildFolderedReportManifest()` and unit-tested (filed-member format, unfiled/personal skip, empty→no-retrieve).
- **EscalationRule no longer rejects valid `escalationStartTime` values:** the extractor's allowed-enum was guessed as `SinceCaseCreation` / `SinceModified`, but the real Salesforce metadata values are `CaseCreation` / `CaseLastModified` — so every Case escalation rule that escalates from case creation was rejected as `malformed-input`, and the **whole `Case.escalationRules` file was dropped from the vault**. Corrected the enum to the real values. Found via a grounded real-org refresh during Phase-10 hardening — a fresh org's escalation rules surfaced it on the first refresh.
- **`get_impact` + `CLAUDE.md` no longer claim lookup relationships are unmodeled (G1 follow-through):** G1 made Lookup / Master-Detail relationships first-class `lookupTo` edges, but two consumer-facing boundary claims still said the opposite — `get_impact`'s object-target disclosure stated lookups are "not modeled as graph edges, so inbound lookup fields … are NOT included in this impact slice," and `CLAUDE.md` listed relationship edges under what the product does *not* do. Both are false on a refreshed vault: `lookupTo` points field→object, so an object's inbound-edge impact walk now includes the lookup fields that point at it. The `get_impact` disclosure now states lookups are modeled as `lookupTo` and inbound lookups appear when the vault has them, with a freshness caveat (the edges are extraction-time — re-refresh if an object shows none); `CLAUDE.md` moves relationship edges into the covered surface. Found during Phase-10 boundary-doc-truth review (a stale consumer disclosure a graph feature left behind).
- **`retrieve_blindspot_report` no longer claims lookup targets are excluded (G1 follow-through):** its disclosure said lookup `referenceTo` targets are "field properties, not edges, and are not yet included" — but G1's `lookupTo` edges flow through the generic dangling-edge walk, so a lookup pointing at an unretrieved object is already surfaced (in the automation-and-code bucket). The disclosure + tool description now say so; no logic change (the tool already included them). Found during the Phase-10 boundary-doc-truth sibling sweep after the `get_impact` fix.
- **ps-diff no longer reports vault-derived grant counts as changes:** `compare_components(format: 'ps-diff')` excluded the `objectGrantCount` / `fieldGrantCount` node properties from its deploy-oriented diff. Those are vault-computed grant-edge counts (`objectEdges.length` / `fieldEdges.length`), redundant with the actual object/field permission changes the diff already lists and not deployable metadata — so they were non-actionable noise that also inflated the `changed` count with their own categories. Found on real PermissionSets during Phase-10 hardening; the grant changes themselves were already correct.
- **`live_inactive_users` no longer overflows the MCP response limit on large orgs:** the tool defaulted its detail page to the 500-row hard cap and shipped both the structured `users[]` and a `rendered` markdown table (which re-serializes every row), so an org with hundreds of dormant users produced a ~143 KB response that the global ~45 KB guard rejected outright — the tool failed instead of answering. The default detail page is now 100 (hard cap still 500), and a per-response ~36 KB byte budget trims the page further when a wide page would still overflow, adding a `note` when it does. `totalInactive` remains the true count, so a trimmed page never understates it. Found on a real org during Phase-10 hardening.
- **`live_sample` no longer fails on a wide projection:** the caller supplies the SOQL, so the row cap (default + max 200) couldn't bound the response size — a wide `SELECT` (e.g. `FIELDS(STANDARD)`) at the cap serialized to hundreds of KB (~363 KB observed on a real org) and tripped the global ~45 KB guard, so the tool errored instead of returning a sample. A per-response ~36 KB byte budget now trims trailing rows until the response fits; `rowCount` reflects the rows actually returned and a `note` explains the trim (narrow the SELECT or lower `limit` to sample more). A narrow projection at the cap is unaffected. Found on a real org during Phase-10 hardening.
- **`what_if_change_field_type` no longer reports field-level-security grants as type-change impacts:** the impact walk emitted a `configuration-only` entry for every Profile / PermissionSet `grantedBy` (FLS) edge on the field — e.g. a Picklist→Text change on a field visible to 9 profiles listed all 9 as "may require updating this reference." FLS grants access by API name and are unaffected by a field's *type* (the grant keeps applying), so these were false positives that also inflated the verdict above `safe` for a field whose only references are grants. The walk now skips `grantedBy` edges (as it already skips `parentOf`), matching the usage-vs-access split `field_360` makes — access stays the domain of `safe_to_delete_field` (deletion drops the grant) and `field_access_audit`. Found via cross-tool consistency on a real org during Phase-10 hardening.
- **`route_question` covers more common phrasings (router gap batch 3):** closed the remaining clear gaps from the question battery — schema/enumeration "show me the objects" / "show Evaluation fields" / "list the flows" ("show"/"list" with the noun anywhere after); field-meaning "what does Status__c mean" (the field is named with its api name, not the literal word "field"); tech-debt "what should we clean up" (general cleanup vs the fields-only route); and user-count "how many active users". Right-question routing is now 80/83 (the 3 remaining were bare component references like "evaluation status" left `unknown`; the router-gap-batch-4 entry above now rescues those to `sfi.resolve`). 144 router unit tests pass; the nonsense battery still routes entirely to `unknown` (no fabrication).
- **`route_question` covers more common phrasings (router gap batch 2):** continuing the question-battery-driven router fixes — added a dedicated **vault-health** route (`health_check` had no route at all, so "is the vault healthy" / "how fresh is the data" / "what is covered in this vault" all returned `unknown`), routed test-QUALITY phrasings to `meaningful_test_audit` ("fake assertions", "tests with no real assertions"), and broadened pii ("which fields hold personal data"), governor ("performance risks in apex"), field-required ("make Contact.Email required" without the literal word "field"), field-access ("field access audit for X"), field-population ("field population for X" — the noun vs the adjective "populated"), and flow ("explain the flow**s**" plural). Right-question gaps 20 → 9; 144 router unit tests pass; the nonsense battery still routes to `unknown`.
- **`route_question` covers more common phrasings (router gap batch 1):** a question battery found that several valid questions routed to `unknown` even though the tool exists, because the intent patterns were a near-miss on the phrasing. Broadened four routes (additively, no regression): order-of-execution now matches present-tense "what happens **when I save** an X" (not just past-tense "saved"); over-privilege now matches "over-**privileged**" (not only "over-permission"); sharing now matches "how is **Account** shared" and "sharing **summary**"; onboarding now matches "onboard**ing** doc" (`\bonboard\b` had missed the "-ing"). The 144 router unit tests still pass and the out-of-scope/nonsense set still routes to `unknown` (no fabrication). More phrasing gaps are being closed in follow-up batches.
- **`domain_clusters` no longer overflows the MCP response limit:** each cluster listed its full member set inline, so one large domain pushed the default response to ~63 KB and the global ~45 KB guard rejected it. Each cluster now lists at most 40 `members` with the true `memberCount` + a `membersTruncated` flag, and a per-response ~36 KB byte budget trims the cluster count further if still needed (with a `note`). Found by the Workstream-B tool-coverage battery; the battery now reports zero anomalies across 289 adversarial calls / 149 tools.
- **`unused_fields_deep` no longer overflows the MCP response limit:** it capped rows by `limit` (default 100) but had no byte budget, and each entry carries the full eight-tier detail — so on a real org the default page was ~118 KB and the global ~45 KB guard rejected it. A per-response ~36 KB byte budget now trims the page below the row limit when needed (`truncated` + a `note`), while `totalCount` / `byParentObject` / `byConfidence` keep the unfiltered counts so the trim never understates how many unused fields exist. Found by the Workstream-B tool-coverage battery; verified live (118 KB → 31 KB, totalCount preserved at 105).
- **`field_cleanup_candidates` no longer overflows the MCP response limit:** the tool shipped the full eight-tier `unused_fields_deep` detail for up to 100 candidates with no byte budget, so on a real org the default response was ~191 KB and the global ~45 KB guard rejected it — the tool failed outright. A per-response ~36 KB byte budget now trims the candidate list (findings + fields stay parallel) until it fits, adding a `note` pointing at paginated `unused_fields_deep` for the full detail. Found by the Workstream-B tool-coverage battery (adversarial inputs across every tool); verified live (191 KB → 32 KB).
- **`meaningful_test_audit` density metric is no longer always zero:** the tool reads `properties.assertionCount` (real `System.assert*` frequency) to compute its assertions-per-KB density, but nothing ever wrote that property — the Apex extractor produced `qualityIssues` (including `fake-assertion`) but never counted total assertions. So every test class reported `assertionCount: 0` / `density: 0`, and the documented "rank by density alone when fake-assertion data is absent" fallback was dead. The extractor now counts `System.assert*` invocations (comments / strings stripped) and writes `assertionCount` on test-class nodes. Extraction-time fix — takes effect on classes refreshed after this ships. Found during Phase-10 hardening (a read-but-never-written property, like the `explain_apex_method` qualityIssues fix).
- **`meaningful_test_audit` now counts the modern `Assert.*` class, not just `System.assert*`:** the assertion counter (the density input) matched only the legacy `System.assert*` family, so a test class written with Salesforce's recommended `Assert` class (`Assert.areEqual`, `Assert.isTrue`, `Assert.isNotNull`, … — the idiom since Spring '22) reported `assertionCount: 0` and was falsely ranked as a sparse, no-assertion test. The counter (renamed `countSystemAssertions` → `countAssertions`) now recognizes both the `System.assert*` family and the `Assert.*` class, bare or `System.Assert.*`-qualified, with comments / strings stripped. The separate fake-assertion recognizer that flags *meaningless* asserts stays scoped to `System.assertEquals` shapes — so an `Assert.areEqual(x, x)` self-equal is now counted but not yet flagged fake — and the tool's disclosure states this split. Extraction-time — takes effect on classes refreshed after this ships. Found during Phase-10 hardening (the `Assert.*` blind spot the prior `assertionCount` entry flagged).
- **`generate_data_dictionary` accepts a bare object api name (doc-generator consistency):** it required a `CustomObject:`-prefixed `objectId` and rejected a bare name (`Account`) with `invalid-query` — but the sibling `generate_sharing_summary` takes a bare api name, so a caller (or the router) that learned one convention hit a confusing error on the other. `objectId` now coerces a bare name to the canonical id (matching the established short-form pattern used by `field_lineage` / `what_if_deactivate_flow`); the canonical id still works unchanged and a wrong-type prefix (`ApexClass:Foo`) is still rejected with a clearer message. Purely additive — no existing caller breaks. Found during Phase-10 hardening; verified live.
- **Phantom classifier no longer mislabels non-schema ids as "standard field":** `classifyPhantom` returned `standard-field-phantom` for any referenced-but-unretrieved id whose object part had no `__` — regardless of component type. So a phantom `ApexClass:newMap` (a `Trigger.newMap` parse artifact), or a phantom `Flow` / `RecordType`, was tagged a standard field with a "treat it as standard, it stays a stub" remedy, even though that bucket means "a standard object or a field on one." It's now guarded to schema ids (`CustomField` / `CustomObject`); other types fall through to the functional-reference buckets (`automation-critical` / `unknown`) with an honest remedy. Demand-retrieve behavior is unchanged (these stay non-retrievable). Found during Phase-10 hardening; verified live (`ApexClass:newMap`: `standard-field-phantom` → `unknown`).
- **`soql-in-loop` / `dml-in-loop` recognizers no longer double-count nested loops:** the loop recognizers scan each loop body independently, so a SOQL/DML statement nested N loops deep was reported N times — identical `rule` + `location`, inflating `governor_limit_risks` / `code_quality_audit` / `automation_risk_report` / `tech_debt_score` counts (a real class showed `dml-in-loop` at one line three times). Each recognizer now dedupes by the statement's absolute source offset, so a nested statement is reported once while two genuinely distinct statements on the same line are both kept. Extraction-time fix — takes effect on classes refreshed after this ships. Found during Phase-10 hardening.
- **`explain_apex_method` now surfaces code-quality findings (was always empty):** the handler read `properties.qualityIssues[]` with a string-array reader (`.filter(v => typeof v === 'string')`), but quality findings are OBJECTS (`{rule, severity, location, explanation}` — the shape `governor_limit_risks` / `code_quality_audit` emit). Every finding was silently filtered out, so the documented "v2.1 R2 quality-issue property mirror" reported `qualityIssues: []` for every class even when the recognizer had fired. It now reads and surfaces the structured findings (validated element-by-element, malformed entries dropped). On a real org `explain_apex_method` went from `[]` to 6–9 findings per flagged class. Found via cross-tool consistency (`explain_apex_method` showed `[]` while `governor_limit_risks` reported `dml-in-loop` findings for the same class) during Phase-10 hardening.
- **`unused_components` and `unused_fields_deep` no longer count permission grants as usage:** both classified a component as "used" the moment it had any non-`parentOf` incoming edge — including `grantedBy` (Profile / PermissionSet access grants: Apex class access, field FLS). So an Apex class or field that nothing references but that a profile grants access to was hidden from the unused list, and in `unused_fields_deep` (whose verdict ANDs all eight tiers) a single FLS grant suppressed the unused flag entirely. Both now skip `grantedBy` alongside `parentOf` — access is not usage, the same split the dead-code / what-if tools make. On a real org `unused_components({types:['ApexClass']})` went from **0** to **10** flagged classes (7 of them reachable only by profile grants). Same bug class as the `find_dead_code` / `what_if_change_field_type` grant fixes. Found via cross-tool consistency (`find_dead_code` flagged classes `definitely_dead` that `unused_components` reported as used) during Phase-10 hardening.
- **`find_dead_code` no longer counts permission grants as usage:** the dead-code reachability scan excluded only `parentOf` edges, so `grantedBy` (Profile / PermissionSet access grants — Apex class access, field FLS) counted as "reach." A class reached only by its own test class plus a few profile grants was hidden as `uncertain` instead of surfaced as `likely_dead`, and a class or field whose *only* incoming edges are access grants never reached `definitely_dead` — access is not usage. The scan now also excludes `grantedBy`, matching the access-vs-usage split the field / what-if tools make. On a real org this surfaced **19** previously-masked candidates (7 `definitely_dead` + 12 `likely_dead`) that had all been reported as `uncertain`. Found via cross-tool consistency (`method_reachability` vs `find_dead_code`) during Phase-10 hardening.
- **`what_if_change_field_type` now rejects computed (Formula / Roll-Up Summary) fields:** those fields have no stored column to re-coerce — their type is *derived* (a formula's return type, a roll-up's aggregate), so "change the field type" is not a valid operation. Because a formula field's `dataType` is its return type, the tool silently analysed it as a normal field and emitted a misleading data-coercion verdict (e.g. a Text-returning formula reported as a "breaking" change to Number). It now returns `invalid-query` with a clear reason, matching the sibling `what_if_make_field_required` guard (same `formula` / `Summary` detection) so the what_if family is consistent. Found via sibling-consistency on a real org during Phase-10 hardening.
- **`architect-impact-analysis` skill boundary disclosures reconciled to current behavior (P10-B7):** the skill body still described the impact graph in `v0.2`/`v0.3` terms — "records nine edge types", "no `heuristic` edges in v0.2", "Apex method bodies stored as text only", and a coverage table marking Apex `readsFrom`/`writesTo`, the Apex call graph, and LWC/Aura references as "no (v0.3, PMD AST)". All false now: the graph records ~two dozen edge types, the heuristic regex/token Apex + frontend scanners emit `readsFrom`/`writesTo`/`callsApex`/`references` edges that **do** enter the impact graph (the two "a heuristic edge here is a bug, flag it" red-flag rules contradicted shipped behavior), `$Record` Flow refs resolve, and only dynamic SOQL/SOSL strings, reflective access, and cross-method dataflow precision remain true blind spots. Rewrote the intro, the edge-coverage table (now `heuristic`-tier rows with the real blind-spot set), the confidence vocabulary, three rationalizations, and two red flags; routed the method-precise case to `call_graph` / `method_reachability` and the missing-type case to `coverage_report`. The `description:` frontmatter (routing trigger) was already corrected in P10-cleanup-uncommitted-wip. `verify-doc-sync.mjs` now also guards the resolved phrases (`arrives in v0.3`, `never enter the impact graph`) alongside `no LWC/Aura references`, so the boundary-doc-truth is machine-checked against regression in the instructional surface (README / CLAUDE / skills); CHANGELOG.md is exempt from the stale-phrase scan since it legitimately quotes removed phrasings. CLAUDE.md and the tool descriptions were swept and already accurate (the `v0.3 apex-scanner` mentions are scanner-version labels paired with the correct `heuristic` confidence). Doc-only.

### Phase 9 — Proactive intelligence

- **P9-weekly-pulse (docs) — how to schedule a recurring refresh so the pulse becomes a weekly digest:** A new "Scheduling a recurring refresh (the weekly pulse)" section in the installation guide explains that each refresh now writes a pulse (`org-kb/meta/pulse.json`), logs the tech-debt score (`org-kb/meta/risk-scores.jsonl`), and regenerates the onboarding handbook — and shows how to put that on a cadence: a weekly `cron` example, a one-line read of the pulse, and the Claude Code `/schedule` routine pattern for an agent-driven digest. Documentation only — no product code; everything stays under the gitignored `org-kb/` and never touches the org.
- **P9-auto-onboarding-doc — every refresh regenerates the onboarding handbook:** A completed `sfi refresh` now regenerates the onboarding handbook from the freshly-built graph (running `generate_onboarding_doc` against the already-open graph — no second open) and writes it to the gitignored `org-kb/docs/onboarding.md`, prefixed with a generated-at / source-hash provenance line. So a new hire always has a current handbook without anyone remembering to regenerate it. Best-effort, like the pulse / risk-score writes: a generator or write failure never affects the refresh, and the file lives under the gitignored `org-kb/` (never committed).
- **P9-risk-delta — `tech_debt_score` reports the signed change in tech-debt vs the prior refresh:** Because the read-only MCP server can't persist a score and hash-based snapshots can't be re-scored on demand (they store property *hashes*, not the properties the scorer reads), the score is captured **at refresh time** when the full graph is in hand: a completed `sfi refresh` runs the real tech-debt scorer against the just-built graph (reusing the already-open graph — no second open, no lock) and appends the 0-100 score to the gitignored `org-kb/meta/risk-scores.jsonl`, best-effort. `sfi.tech_debt_score` then reads that log and, when a prior refresh's score from an earlier org state is present, adds `scoreDelta` / `previousScore` / `previousRefreshedAt` to its response (positive = debt grew since the last refresh; no-op re-refreshes of the same source are skipped). On a first refresh (or a pre-existing vault with no log) the delta is simply absent — the score stands on its own. The scorer-at-refresh is fully best-effort: a scoring or write failure never affects the refresh.
- **P9-refresh-pulse — every refresh ends with a "what changed, what to watch" pulse:** When a refresh completes, `sfi refresh` now emits a `Pulse` block (and the `RefreshResult` carries a structured `pulse`): the graph growth/shrink headline followed by per-domain watch-lines added only for the domains that actually moved — new/changed Flows route to `sfi.explain_flow` / `sfi.what_happens_on_save`, added CustomFields flag "new fields can carry PII → `sfi.pii_inventory`", and Apex/Flow growth flags "check governor headroom → `sfi.governor_limit_risks`". It composes the `ChangeSummary` (no new analysis — count-level, since node-level "which Flow" needs the prior graph the refresh has already overwritten) and is also written best-effort to the gitignored `org-kb/meta/pulse.json` so a scheduled digest can read the last refresh's headline. Best-effort, like the history-log / snapshot writes: a pulse failure never flips the refresh status.
- **P9-regression-on-refresh — every `sfi refresh` reports the graph's top-line growth/shrink vs the prior refresh:** The `ChangeSummary` a refresh computes already broke the change down per type (`componentDeltas` / `edgeDeltas`); it now also carries `graphMetrics` — the headline total component and total edge counts N vs N-1, each as `{ previous, current, delta }`. The refresh output gains a one-line `Graph: N components (+X), M edges (+Y)` headline above the per-type detail, so an operator immediately sees whether the org grew or shrank and by how much (the total-edge metric is new — the refresh history previously tracked only total components). Computed in `computeChangeSummary` from the two manifests; this is the regression signal the refresh pulse builds on.

### Phase 8 — Change workflows (propose, never deploy)

- **P8-destructive-checklist — `safe_to_delete_field(format: 'checklist')` renders a "before you delete X" Markdown checklist:** Pass `format: 'checklist'` to `sfi.safe_to_delete_field` and the response gains a `checklist` — a rendered Markdown checklist over the verdict + reasoning the tool already computes: the `coverageCaveat` is surfaced FIRST (a leading warning block, never footnoted — per the coverage-honesty rule), then the verdict, then a `- [ ]` removal checklist ordered most-severe-first (so a `blocking` Flow dependency ranks above a `review` layout), followed by a detail table (category / severity / count / example referrers via the shared `mdTable`). It carries every dependent and FLS grant the verdict is based on, so an admin sees exactly what to resolve — and in what order — before deleting. Wired as a thin post-processing wrapper so all three verdict paths (the main reasoning path, system-field, and not-modeled-field) carry the checklist consistently; the default (`format: 'json'`) response is unchanged. It PROPOSES a checklist for a human and never deletes or writes to the org.
- **P8-manifest-export — `sfi.export_manifest` turns a set of component ids into a deployable `package.xml` snippet:** A new tool that takes `componentIds` (a non-empty array of canonical `Type:Member` ids — exactly what `get_impact`, `list_components`, the diff tools, etc. return) and an optional `apiVersion` (default 62.0), and returns a well-formed `<Package>`: members de-duplicated and sorted per type, the `<name>` mapped to the deployable metadata-type name (so `WorkflowRule`→`Workflow`, `VisualforcePage`→`ApexPage`, the rule families→their plural container, `CustomMetadataRecord`→`CustomMetadata` — the same mapping the retrieve manifest uses), and XML special characters escaped so the output parses. It also returns a `summary` (typeCount / memberCount / per-type rollup) and a `skipped` list (malformed ids and synthetic graph nodes like `ConditionalContext`, with the reason). It PROPOSES a manifest for a human to feed Gearset / Copado / `sf project deploy` — it never deploys, writes to the org, or even verifies the ids exist (it packages exactly what you pass; see the `disclosure`). +1 MCP tool.
- **P8-draft-vr — `explain_formula(format: 'vr-draft')` scaffolds a before/after Validation-Rule edit:** Pass `format: 'vr-draft'` to `sfi.explain_formula` and the response gains a `vrDraft` — a structured before/after edit scaffold around the formula you pass (the VR's `errorConditionFormula`): `before` carries that formula **verbatim**, `after` is the optional `proposedExpression` (also verbatim) or a copy of `before` for a human to edit, and an optional `errorMessage` is echoed into both sides. The verbatim before/after is the deploy tool's source of truth for the change, and the existing function / field-reference analysis comes along to guide the edit. Default (`format: 'json'`) responses are unchanged; `vrDraft` appears only when requested (on both the success and `parseError` paths). Propose-only and offline: it does not fetch the VR from the org, validate the formula against the org, or deploy — feed the `after` to Gearset/Copado yourself (see the `vrDraft` `disclosure`). Tool description + MCP input schema (`format` / `proposedExpression` / `errorMessage`) updated.
- **P8-draft-ps-diff — `compare_components(format: 'ps-diff')` emits a deploy-tool-friendly Permission-Set / Profile grant diff:** Pass `format: 'ps-diff'` to `sfi.compare_components` and the response gains a `psDiff` field — a reshaped, grant-oriented view of the same diff a deploy tool (Gearset / Copado) reasons about: added / removed object, field, and class grants (from `grantedBy` edge presence, keyed by the target's type), added / removed system permissions (set-differenced from the `userPermissions` property array), and any other scalar property change as `changed` (with `valueA` → `valueB`). It carries a `summary` with per-category counts and `bothPermissionLike` (true only when both ids are a PermissionSet / Profile). Pure reshaping over the buckets the tool already computes — no new graph reads — so the default (`format: 'json'`) response is unchanged and `psDiff` appears only when requested. The shape is published as a JSON Schema at [`docs/schemas/ps-diff.schema.json`](docs/schemas/ps-diff.schema.json) (a unit test validates the output against it). Honest about the one blind spot in its `disclosure`: an existing grant's read↔edit LEVEL change is not surfaced — the vault models object/field/class grants as edges and skips all-false grants, so this diff sees grant presence, not the edge flags. It PROPOSES a diff for a human to feed a deployment tool; it never deploys or writes to the org.
- **P8-what-if-suite — one shared verdict + envelope across all nine `what_if_*` tools:** The change-impact family had drifted: each tool redeclared its own `Verdict` type — some with `review` but not `unknown`, others the reverse — so the same headline meant different things tool to tool, and three tools (`what_if_change_field_value`, `what_if_merge_profiles`, `what_if_split_profile`) didn't carry a `verdict` at all. There is now a single `Verdict` vocabulary (`safe` / `review` / `risky` / `blocking` / `unknown`) and a shared `WhatIfEnvelope` (`verdict` + optional `coverageCaveat` + `trust` + `disclosure`) in `coverage-trust.js` that every tool's output conforms to. The six already-aligned tools widen to the shared type (a pure type-level change — no tool emitted a value outside its old set, so runtime output is unchanged); `what_if_change_field_value` gains a `verdict` mapped from its 5-level `overallSeverity` (critical→blocking, high→risky, medium/low→review, info→safe, downgraded safe→review under partial coverage like the rest of the family) while keeping `overallSeverity`; and `what_if_merge_profiles` / `what_if_split_profile` now build the same envelope through the shared `attachCoverageToWhatIf` helper (merge: `safe` when the profiles agree everywhere else `review`; split: `safe` when nothing is left unassigned else `review`). Conformance is enforced at build time — a new test asserts every `*Output` is assignable to `WhatIfEnvelope` and that each tool requires its canonical-id target param — so a future what-if that drifts fails CI.

### Phase 7 — Multi-org, drift, fleet

- **P7-demand-retrieve — `sfi refresh --components <ids>` pulls ONLY automation-critical phantoms:** A new CLI flag for targeted, user-invoked retrieval — the safe model for a vault-mutating pull (you type the command; the agent never auto-mutates the vault). It classifies each requested id against the current vault with the GATE-0 taxonomy (the classifier now lives in `@sf-intelligence/graph`, shared by the MCP stub path and this gate), pulls ONLY automation-critical CustomObject phantoms from the live org via the existing B29 retrieve path (`runSfRetrieveObjects`), then re-extracts so they become L3 nodes. grant-only / managed-extension / standard-field-phantom / blindspot-manifest / unknown ids are refused with their classification reason — a targeted pull never bloats the vault with the 700+ grant-only trap. The automatic B29 batch path (a plain `sfi refresh`) is unchanged. The classification gate is unit-tested and verified on the gate vault: it selects exactly that org's real automation-critical CustomObject phantoms and refuses grant / managed / standard. (The retrieve + re-extract reuse the production-proven `runSfRetrieveObjects` + `runRefresh`; the one-shot end-to-end live stub→L3 pull is the remaining manual spot-check — run against a config-rewritten throwaway copy, never the gate vault.)
- **P7-reference-stub-nodes — a lookup on a phantom returns a CLASSIFIED stub, not a bare not-found:** When `sfi.get_component` (and any `component-not-found` path) hits a referenced-but-unretrieved id, the error now carries a structured `ReferenceStub` — `{ classification, tier: 'stub', referenceCount, edgeKinds, namespace?, demandRetrievable, remedy }` — classified ON DEMAND into the GATE-0 six-bucket taxonomy (automation-critical / blindspot-manifest / managed-extension / standard-field-phantom / grant-only / unknown). So a consumer gets an honest insufficient-knowledge signal with a concrete remedy (grant-only → "stays a stub"; automation-critical → "demand-retrieve candidate"; blindspot-manifest → "widen the manifest") instead of a silent-looking not-found. Deliberately NOT materialized into the graph: inserting stub nodes would make the dangling edges resolve and break the `targetMissing` / `retrieve_blindspot_report` / taxonomy semantics that depend on those edges staying dangling — on-demand classification delivers the same user value without that blast radius. The classifier reproduces `docs/reports/phantom-taxonomy-audit.md` exactly on the gate vault (ORG_D: 66 automation-critical, 1458 grant-only, 3647 managed-extension, 4424 standard-field-phantom, 95 blindspot-manifest, 1598 unknown).
- **P7-phantom-taxonomy-audit ⭐ (GATE 0) — measured what the "phantom" graph actually is, before building stubs:** A real-org analysis classifies every referenced-but-unretrieved id + manifest gap into automation-critical / blindspot-manifest / managed-extension / standard-field-phantom / grant-only / unknown, with counts and an estimated absence-failure-fix share, checked in (counts-only, anonymized — org labels `ORG_D` / `ORG_M`, generic ComponentType names) at `docs/reports/phantom-taxonomy-audit.md`. The evidence is decisive: on a managed-package-heavy org, managed + standard + grant-only make up **84% of missing ids** and grant-only adds **0% functional value** (the "700+ object" bulk-retrieve trap, confirmed), while automation-critical — the only demand-retrieve target — is just **66 ids**. This is the gate for the Cluster-B knowledge-completeness slice: stubs for the bulk (grant / managed / standard), demand-retrieve for the tiny automation-critical set, manifest-widening for the blindspot-manifest types. Per the gate rule, no stub / retrieve product code lands before this report; every Cluster-B commit cites a row.
- **P7-snapshot-trend — the trend line is verified over 3+ snapshots:** `sfi.trend` already builds a time-series of `{ label, createdAt, componentCount, edgeCount }` points across every persisted snapshot, sorted by time. A new test locks in the 3+-snapshot case the prior test didn't cover: three snapshots persisted OUT of chronological order come back time-ordered ascending, with the component-count series (1 → 2 → 3) tracked across all of them. No product code change — the trend handler already behaves; this pins the multi-snapshot contract.
- **P7-cross-org-diff — the compare_* family reads vaults read-only (so it works against a SERVED vault), and is DRY:** The three cross-vault comparison tools (`compare_vaults`, `compare_object_across_vaults`, `compare_profile_across_vaults`) — and `promotion_readiness`, which composes the first — previously opened the OTHER vault read-WRITE, which took the exclusive DuckDB writer lock and therefore FAILED to compare a vault that was being served by a running `sfi mcp` server (or held by a concurrent refresh). They now open read-ONLY through one shared `openVaultReadOnly` helper that mirrors `server.ts#openServerGraph`: open read-only, probe it, and fall back to read-write only for a missing file or a stale schema that needs migrating (which still surfaces the actionable `locked` error). So a fleet operator can diff sandbox vs prod while an IDE serves one of them. Three byte-identical `openVault` copies collapse into the one helper. A cross-process regression test holds a vault read-only in a real child process and confirms `compare_vaults` succeeds — it failed `locked` before.
- **P7-vault-registry — the multi-root registry, documented and its resolution pinned:** The configuration guide now documents the `registry.json` end to end — the `SF_INTELLIGENCE_REGISTRY_PATH` location precedence (existing directory → its `registry.json`; any other value → that exact path verbatim; unset → walk up, else the co-resident default), the `sfi register-vault` / `sfi list-vaults` CLI, and the on-disk shape (alias → absolute path, with per-vault freshness read from each vault's own manifest, never duplicated) — using `/path/to/vault` samples only. New hardening tests pin the `findRegistryFile` / `findRegistryRoot` resolution contract directly (previously only exercised indirectly through the cross-vault tools), so the directory-vs-file-vs-walk-up behavior every fleet tool and CLI command depends on can't silently drift.
- **P7-promotion-readiness — what a sandbox→prod deploy must add, ordered by what depends on it:** A focused lens on `compare_vaults(sandbox → prod)`, not a new diff engine. The new `sfi.promotion_readiness` takes the sandbox-ONLY set (present in the sandbox vault, absent from prod — exactly what a deploy must ADD) and enriches each component with how many OTHER sandbox components depend on it (distinct inbound edges in the sandbox graph, read read-only), ranking the list most-depended-on first so you deploy the foundations before their dependents. Each `promotionItems[]` entry carries `inboundDependencyCount` + a `dependedOnBy` sample; `byType` buckets the set and `summary.sandboxOnlyCount` is the true total (the inlined list caps at 200). Honest about its limits: the dependency count is a deploy-ORDER priority hint, not a strict topological order (a dependent may already be in prod or be sandbox-only itself); it is a vault-only structural diff over each vault's last refresh and does NOT deploy or validate against the live org; it compares presence, not field/permission shape drift (use `compare_vaults` shapeModified for that); a renamed component reads as remove+add. `provenance: offline_snapshot`.
- **P7-fleet-find — verified multi-org discovery, including the found-in-both case:** Locked in `sfi.fleet_find`'s cross-vault discovery with a test for a component present in MORE THAN ONE registered vault (`foundIn` lists every alias that matched, not just the first) — the prior tests only covered found-in-one and the no-/single-registry honesty notes. Verified on a real two-vault registry (a query resolves across both orgs). The CLI smoke is the harness tool-smoke, which spawns the `sfi mcp` server (the CLI bin) and exercises `fleet_find` from its dynamically-enumerated tool roster; `fleet_find` stays MCP-first, consistent with `sfi.resolve` (no standalone subcommand).
- **P7-compare-vaults-ui — a Markdown drift dashboard over `compare_vaults`:** `sfi.compare_vaults` now accepts `format: 'markdown'`, which adds a rendered `markdown` field to the response: a summary count table (added / removed / shape-modified / unchanged), then `added` / `removed` component tables and a per-component shape-modified section with a per-property `A → B` drift table. Pure presentation over the buckets the tool already computes — no new analysis — so it inherits the same size caps and renders the truncation disclosure inline. Default (`format: 'json'`) responses are unchanged; the `markdown` field is present only when requested. Built on the shared `mdTable` renderer (pipe/newline-safe).
- **P7-fleet-drift-ranking ⭐ — across all your orgs, which vault is most behind — i.e. which to refresh first:** `sfi.live_stale_check` answers "is THIS vault behind its org?" for one org; the new `sfi.fleet_drift_ranking` answers it across the whole vault registry and ranks the vaults by drift descending, with a `mostDrifted` + a "refresh this one first" recommendation. Three safeties make a fleet sweep honest and bounded: **(1) per-org consent** — each vault's `sourceOrg` is gated independently, and a vault whose org has no live consent is an honest `no-consent` *skip*, never an error and never a silent live call; **(2) the shared P6 session budget** — every staleness query routes through `runLiveQuery`, so N orgs × 6 Tooling queries decrement the same per-session live-query budget that bounds the hybrid plane, and a vault the budget can't cover degrades to a `budget-exhausted` skip instead of overrunning the org's API limits (raise `SFI_LIVE_QUERY_BUDGET` or pass a `vaults` subset); **(3) roll-up provenance** — each ranked row is its own `live_org` read at its own `liveQueriedAt`, and the aggregate is a fleet roll-up, so one org's freshness never implies another's. Only the 6 Tooling-queryable types drift-count (ApexClass / ApexTrigger / ValidationRule / Layout / Flow / CustomField); read-only. New router intent `fleet-drift-ranking` ("which org should I refresh first?"). Verified live on a real multi-vault registry.
- **P7-retrieve-blindspot-report ⭐ — the honest backing for absence answers: what the org references but the vault never retrieved:** Where `coverage_report` says what the retrieve manifest *requested and returned*, the new `sfi.retrieve_blindspot_report` says what the graph *references but never retrieved* — every edge whose target id resolves to no node. It separates the genuine blind spots (an automation / Apex / integration component that depends on an unretrieved component — a trigger that fires on an object the vault never pulled, a workflow alert that sends an unretrieved email template, an Apex call to a managed class) from the documented noise that a naive "pull everything referenced" would drown in: permission-set grants on managed/standard objects (the 700+ grant-only-object trap — measured 23k grant edges on a real org), layout field decoration, and unresolved Apex-scanner phantoms, all rolled up as counts rather than enumerated (`includeLowSignal: true` to expand them). Each blind spot is grouped by target type, tagged with its coverage status (`notModeled` / `absent` = a whole-type manifest gap; `covered` = specific managed/community components outside the retrieve scope), and carries a concrete remedy. So an absence-based answer ("X is unused", "nothing references X", "X is safe to delete") about a listed target now carries a known-coverage caveat instead of a silent blind spot; `cleanVault: true` means every reference resolves. New router intent `retrieve-blindspot`; `provenance: offline_snapshot`. Lookup `referenceTo` targets are field properties, not edges, and are not yet included.
- **P7-readonly-fleet-serving ⭐ — many readers, one writer: serve one vault from several `sfi mcp` instances at once:** The MCP server opens the vault read-only (P5), which takes a *shared* DuckDB lock — so an IDE's server, a CI / eval harness, and a fleet dashboard can all serve the SAME vault concurrently, retiring the old "stop every server before a harness run" friction. This release locks that contract in with a cross-process test (a child-process vault holder): a separate process serves the vault read-only while this one does, and a `refresh` (an exclusive write open) attempted while the vault is served fails fast with the actionable `locked` error that names the holder and the remedy, instead of a raw DuckDB message. Documented in the configuration guide under "Concurrent read-only serving (the vault lock)".
- **P7-incremental-graph-update — `sfi refresh --incremental-graph` re-imports ONLY the changed nodes/edges, provably byte-identical to a cold rebuild:** The deep-infra follow-on to P5-incremental-refresh (which cached the per-file *parse* but still rebuilt the *graph* in full — the step that bounded the end-to-end win). With the new opt-in flag, a refresh against a prior non-empty graph computes a `ChangeSet` — the full id reconciliation between the freshly-extracted source and the current graph (`@sf-intelligence/graph` `computeChangeSet`) — and applies it in ONE all-or-nothing transaction (`applyChangeSet`): upsert changed/added rows, delete vanished ones, re-stamp every edge whose target's presence flipped. Two invariants are the whole point and are pinned by tests: **(1) byte-identical to a cold rebuild** — the apply reconciles to the exact desired row-set a cold rebuild would produce (node upserts are last-writer-wins, edge upserts first-writer-wins, matching the cold path's `INSERT OR REPLACE` / `INSERT OR IGNORE`, and a node delete cascades to the cold-equivalent `targetMissing` phantom edges automatically); **(2) consistency under a mid-import failure** — any error, including the post-apply row-count self-check, rolls the whole transaction back, so a half-applied graph is never observable. The cold serializer is shared (`nodeRowParams` / `edgeRowParams`) so equivalence holds by construction. The incremental path falls back to a full batched rebuild on an empty/largely-changed graph (over the `INCREMENTAL_DELTA_CAP`) or any apply error, so the full path stays the source of truth; the default refresh is unchanged. Independent of `--incremental` (the parse cache) — combine both for the largest win. Verified on a real org (7,117 nodes / 99,923 edges): deleting 5 classes yielded 5 node + 67 edge deletes and 8 `targetMissing`-flip edge upserts, and the incremental-applied graph was byte-identical (sha256 over every ordered row) to a cold rebuild of the modified source — while skipping the full ~100k-edge re-import.

### Phase 6 — Hybrid metadata + live data

- **P6-hybrid-trust — one trust block for answers that fuse vault structure with live record magnitude:** Phase 6 introduces *hybrid* answers — the offline vault says WHAT depends on a field, and an opt-in live query says HOW MUCH is at stake. A single `hybridTrust` builder stamps every such answer the same way: `provenance: 'hybrid'`, freshness carrying BOTH the vault's `snapshotRefreshedAt` and the live `liveQueriedAt`, and a fused `confidence` that collapses to the *weaker* of the two planes (live counts are exact `declared`, so the result tracks the static-analysis plane — a hybrid answer is only as trustworthy as the analysis that decided what is at stake). The block carries a verbatim disclosure that one plane's freshness never implies the other's, plus an optional staleness sub-block (see P6-stale-guard-hybrid). `HybridTrust extends TrustSummary`, so existing trust consumers keep working unchanged.
- **P6-stale-guard-hybrid — a hybrid answer leads with a vault-staleness warning when the org is ahead:** The honesty gap a hybrid answer creates is that a *fresh* live count, narrated against *stale* vault structure, can read as more current than it is. The P5 `live_stale_check` counting loop is now factored into a reusable `checkVaultStaleness` that any hybrid tool runs (behind the same consent it already holds): it returns whether the org is ahead of the vault and by how many components, with a pre-rendered lead-with warning. The hybrid trust block carries that as a `staleness { vaultStale, driftCount, checkedTypes, warning }` sub-block, so a fused answer leads with "⚠️ Vault is STALE: N components changed in the org after the last refresh — run /sfi-refresh" instead of silently presenting the live number as proof of current structure. `live_stale_check` itself is unchanged (it now delegates to the shared function).
- **P6-live-automation-fired — does this record-triggered automation actually run?:** A new `sfi.live_automation_fired` tool gives a heuristic "effectively never runs" signal by fusing the vault with live activity. It resolves an ApexTrigger / record-triggered Flow / WorkflowRule's trigger object (the `triggersOn` edge) and, when consented, checks whether that object has any records and whether any changed in the window — flagging `likelyNeverRuns: true` when the object is empty (cannot have fired) or has only stale records. It is honest about the proxy: `confidence: 'heuristic'` (record activity is necessary, not sufficient — entry criteria may still filter every record, and execution isn't observed without debug logs), non-record-triggered automation is reported `applicable: false`, and without consent it returns just the resolved trigger object.
- **P6-live-docs / P6-why-cant-see-record / P6-live-report-usage — docs + gating polish:** The configuration reference now documents the hybrid plane end to end: the new live tools, a "Hybrid answers (vault + live)" section (provenance `hybrid`, the staleness lead, never blocking the static answer on the live plane), and the live-plane cost controls (`SFI_LIVE_QUERY_BUDGET`, `SFI_LIVE_CACHE_TTL_MS`, `SFI_BLAST_RADIUS_MAX_LIVE`). `why_cant_user_see_record` now spells out its required params (`componentId` + a non-empty `userContext` carrying at least one of profile / permission-set / role / group ids) and that it is an offline tool you feed the ids to. `live_report_usage` gained a unit test proving it fails closed without consent (a clear error, zero org calls), with its description updated to say so.
- **P6-live-picklist-usage — which picklist values are actually used in production:** A new `sfi.live_picklist_usage` tool answers "which of this picklist's values do records actually carry?" The vault knows the values a picklist defines; only the live org knows which are used. It runs a live `GROUP BY` over the field's distribution and cross-references the vault's value set: `usage` (each value with its live count), `unusedDefinedValues` (values the picklist defines that no record uses — cleanup / restrict-to-active candidates), `undefinedUsedValues` (values records carry that the picklist no longer defines), and a blank count. It is honestly empty when the object has no records or the field is never populated, splits MultiselectPicklist combos with an overlap note, and without consent returns the defined values with a caveat. `provenance: 'hybrid'` when consented.
- **P6-live-advisor-wire — the field-change briefing cites live record population, not just vault structure:** `field_change_advisor` synthesises the make-required / delete / change-type angles into one briefing. With the live plane enabled it now threads consent into its make-required sub-analysis, so the `makeRequired` block carries the field's live production null-rate and the recommendations cite the live record population alongside the vault verdict ("Live: N of M records have this null today" next to "affects K create paths") — and lead with a staleness warning when the org is ahead of the vault. Without the live plane the briefing is unchanged.
- **P6-required-field-whatif — "make this field required" now shows the production null-rate (the goal example):** `what_if_make_field_required` answered which create paths break when a field is made required, but not how much existing data is at odds with the change. With the live plane enabled (`liveEnabled: true` or consent) it now adds a `liveNullRate` block — how many existing records have the field null today, the populated fraction, and a plain-language reading: "no existing record populates this field" vs "X% are null; existing records aren't retroactively forced, but every new or edited record (and any automation that creates one) will require a value." It leads with the vault-staleness warning when the org is ahead and stamps `trust.provenance: 'hybrid'`. Without the live plane the offline verdict is unchanged.
- **P6-blast-radius-live ⭐ — "what breaks if I change X, and how much is at stake?":** The flagship hybrid answer. Static dependency analysis (`get_impact`) names WHAT breaks when you change a field or object; the new `sfi.blast_radius_live` tool pairs each record-bearing dependency with a LIVE count of records affected — a CustomField with its non-null record count ("847 records hold a value here"), a CustomObject with its total rows — so you see not just the dependency list but the magnitude behind each one. Code and config dependencies (Flows, Apex, validation rules, layouts, permissions) are listed without a count: they break too, but "records affected" is not their unit. It leads with a vault-staleness warning when the org is ahead of the vault, stamps `provenance: 'hybrid'` carrying both planes' freshness, and routes every live query through the session cache + per-session budget so a wide impact set stays cheap and bounded (`maxLiveCounts` caps it, marking the answer `partial` rather than over-spending). Crucially, the static answer is never blocked on the live plane: without consent it returns the full impact set with a caveat (`provenance: 'offline_snapshot'`). Counts only — no record row is ever read or stored.
- **P6-live-result-cache + P6-live-budget-guard — the live plane is safe to lean on for many-query hybrid answers:** A blast-radius answer issues one live COUNT per impacted dependency, so the hybrid plane needs two safeties. A **session-scoped result cache** (in-process, keyed on org + query, TTL via `SFI_LIVE_CACHE_TTL_MS`, default 90s) means a repeated identical live query inside one conversation issues exactly one org query — the rest are served from cache, stamped `cached: true` and carrying the *original* read time so a cached value is never passed off as fresh. It is memory-only and never persisted (no record data on disk). A **per-session live-query budget** (`SFI_LIVE_QUERY_BUDGET`, default 50) decrements per actual org query (a cache hit is free) and fails *closed* with an actionable message when spent, so the live plane can never exhaust the org's API limits. A new **`sfi.live_budget`** tool discloses the remaining budget and cache state (session-local, no consent needed) and, when the live plane is enabled, cross-checks the org's real `DailyApiRequests` headroom so the cap is visibly a tiny fraction of what the org can serve.

### Phase 4 — Static analysis moat

- **P4-test-reachability — a changed method names the tests that cover IT:** `test_coverage_for_method` took a `methodName` but only echoed it — coverage was class-level. Now that the call graph carries which methods each edge invokes (P4-C5), the upstream test-coverage walk propagates an `exercisesMethod` flag, so when you pass a method it reports which covering tests actually exercise that method (and a `methodCoveringCount`), not just which tests touch the class. So "I changed `Service.recalculate` — which tests cover it?" gets a method-precise answer. It is heuristic and shortest-path, and falls back to class-level matching on vaults predating the method-level call graph. Verified live against a real class and method.
- **P4-graph-sast — governor-limit findings cite the entry path that reaches them:** `governor_limit_risks` flagged loop SOQL/DML per class with only its direct trigger callers. Each risky class now also carries `entryPaths` — the entry-point paths (`[entryPoint, …, thisClass]`) that reach it, walked backwards over the call graph to a trigger or Flow entry point (or the top of the chain). So a finding cites *where it runs from*, which changes how you triage it: a SOQL-in-loop reachable only from a test class is far lower real-world risk than one sitting on a trigger's hot path. On a real org this immediately distinguished test-only findings from production-reachable ones.
- **P4-formula-chains — surface cross-object formula chain depth:** `field_lineage` walks a field's formula references upstream, but the depth of a multi-hop formula→formula chain was left implicit. The upstream payload now carries a `formulaChain { maxDepth, crossesObject }` summary: a `maxDepth` of 2 or more means the field's formula depends on another formula (a recompute cascade where changing a base field ripples through every formula above it), and `crossesObject` flags when the chain reaches a formula on a different object. Verified live on a real formula field.
- **P4-flow-conditions — Flow decision conditions carry a runtime-evaluation flag:** `explain_flow` already surfaced a Flow's decision and trigger conditions (each with its logic expression and the fields it references), but nothing told the reader those are *declared* criteria rather than a runtime trace. A `conditionsRuntimeNote` now flags that explicitly — the conditions are the statically-declared rules (heuristic), and whether a given branch actually executes is data-dependent and is not evaluated — so a host never reads a declared condition as proof the path runs.
- **P4-dynamic-patterns — flag dynamic Apex so the static blind spot is visible:** Dynamic SOQL (`Database.query`), `Schema.getGlobalDescribe`, `Type.forName`, and `JSON.deserializeUntyped` build object/field/type references at runtime that the static scanner cannot see — so impact, usage, and dead-code results for a class that uses them can be incomplete. A new `dynamic-apex` recognizer surfaces that honestly as an `info` finding (one per construct kind per class), turning a silent blind spot into a visible caveat in `code_quality_audit`. It's a signal, not a defect. Over a real org's Apex it flagged roughly a fifth of the classes as using one or more of these constructs.
- **P4-dead-code-depth — the router sends every dead-code phrasing to one canonical tool:** Asking about dead code in different words used to scatter: "is there dead code?" found `find_dead_code`, but "which Apex classes are never called or unused?" went unrouted, and "find unreachable methods in our code" mis-routed to the name resolver. The dead-code, unused-components, and unused-fields intents are reconciled into clean, non-overlapping scopes: any dead/unused/unreachable/never-called phrasing about Apex code (in either word order) routes to the single canonical `find_dead_code`; the broader "unused components" scope routes to `unused_components`; and "unused fields" routes to `unused_fields_deep` — with the code patterns scoped so they can't steal the field or component intents.
- **P4-hardcoded-scan — flag hardcoded endpoint URLs, domain-aware:** The hardcoded-value recognizer already caught IDs, emails, usernames, and sandbox test data, but not URLs. A new `hardcoded-url` rule flags external endpoint URLs baked into Apex — which break the sandbox→production promotion path and hide the integration from the org's external surface — and recommends a Named Credential / Remote Site Setting. It is namespace/domain-aware: URLs on Salesforce platform domains (My Domain, Sites, Visualforce, the API host) are skipped, so only genuine third-party endpoints surface. The new rule and a `url` category flow through `find_hardcoded_values` and `find_hardcoded_values_anywhere`. Running the recognizer over a real org's Apex flagged a real external integration endpoint that belongs in a Named Credential, with the platform URLs correctly ignored.
- **P4-clone-patterns — find near-duplicate Apex clusters across the whole org:** `find_clone_patterns` could only answer "what's like THIS one?" from a seed. It gains a seedless **cluster mode**: omit the seed and it fingerprints every component of a type (`ApexClass` by default, or `ApexTrigger`/`Flow`), scores all pairs, and groups everything scoring above the threshold into clusters via union-find — each with a stable `clusterId`, its members, and its tightest pair. So "where are the copy-pasted classes?" is a single call. It's O(n²), capped at 800 nodes with a disclosure, and every result stays `heuristic`. On a real org it surfaced genuine copy-paste: a six-member cluster of near-identical batch test classes, the self-registration controller pair, and known near-twin batch classes — each with a cluster id.
- **P4-interface-impl — list every Batchable / Queueable / Schedulable / RestResource implementer:** The Apex async/interface classifiers (`isBatchable`, `isQueueable`, `isSchedulable`, `isRestResource`, `hasFutureMethod`, `hasInvocableMethod`, `hasAuraEnabledMethod`, `isTest`) were already extracted and surfaced per class, but `list_components` had no way to filter by them — there was no "show me all the Batchable classes" surface. The graph's node query gains a DB-layer boolean-property filter (a parameterised `json_extract_string` over the stored properties, so pagination stays correct and the key can't inject), and `list_components` exposes those eight booleans for `ApexClass`. Live MCP testing against the org surfaced a robustness bug — hosts pass the flag as the string `"true"` — so the filters now coerce `"true"`/`"false"`. Verified live: `list_components { type: 'ApexClass', isBatchable: true }` returns the org's Batchable classes (each one declaring `Database.Batchable`).
- **P4-trigger-dispatch — trigger → handler-method dispatch edges:** The trigger extractor runs the same Apex scanner, so a trigger that dispatches to a handler now records which handler methods it calls: the `callsApex` edge from `AccountTrigger` to `AccountTriggerHandler` carries `methods: ['afterInsert', 'afterUpdate']` rather than just a class-level link. Locked with a fixture-trigger test. (Realised by the P4-C5 method-level work below.)
- **P4-C5-method-level — method-level Apex call graph:** The Apex call graph was class-granular — an `A → B` `callsApex` edge said "A calls B at least once", not which method. The scanner already captured each call's target method, but the edge builder pushed one edge per `(class, method)` and the `(from, to, type)` dedup kept only the first, so a caller of both `Handler.save` and `Handler.deleteRecord` surfaced a single method and dropped the rest. The edge builder now aggregates every call site to the same target class into one edge carrying the complete `methods[]` (the scalar `methodName` is kept for back-compat). This fixes a real correctness bug in `what_if_change_method_signature`, which filtered incoming callers by a single `methodName` and so missed callers that invoke multiple methods of the target — it now matches against `methods[]` (with a scalar fallback for older vaults). `call_graph` surfaces `methods[]` on every edge and gains an optional `method` filter, so `direction: 'upstream'` + `method: 'deleteRecord'` answers "who calls `Handler.deleteRecord`"; its disclosure is rewritten to state method-level call *targets* are now surfaced while the caller-side method (which method of the source does the calling) remains unpartitioned pending real AST analysis. `get_impact` already returns full edge objects, so the method information flows through to its callers view. Verified across 186 real Apex classes (all 261 `callsApex` edges now carry `methods[]`; 83 aggregate more than one method — relationships that were previously lossy) and end-to-end through `call_graph`'s method filter.

### Phase 5 — Freshness & refresh UX

- **P5-incremental-refresh — an opt-in per-file extraction cache skips re-parsing unchanged source:** `sfi refresh --incremental` (off by default) loads a `meta/extract-cache.json` sidecar written by the previous incremental run and reuses the cached extraction for any source file whose modified-time and size are unchanged, instead of re-parsing it. The graph is still rebuilt in full from the combined reused-plus-freshly-extracted results, so an incremental refresh is byte-identical to a cold one — only faster: it short-circuits the expensive per-file parse, never the correctness-critical import and render. The cache is invalidated automatically whenever the extractor shape or the package version changes, so a reused entry always came from the same extractor; it lives under the gitignored vault directory and is never committed. Verified on a real 2249-file org source: the second run reused all 2249 files and produced an identical source-tree hash and graph. (The end-to-end wall-clock win is bounded by the extraction fraction, since the full graph rebuild and render still run; a true incremental-graph update is future work.)
- **P5-duckdb-readonly — the MCP server opens the vault read-only so instances coexist:** The server never writes the graph while serving (every tool is read-only — confirmed, including the naming-convention recognizer, which only reads and returns observations). It now opens the DuckDB graph read-only, which takes a shared lock instead of the single-writer exclusive lock — so multiple `sfi mcp` instances (an IDE's server plus a QA-harness server) and other read-only consumers can serve the same vault at once, instead of having to stop one before running the other. It falls back to a read-write open (which creates the file and runs migrations) when there is no graph yet or the vault is at a stale schema, and that fallback surfaces the actionable lock error if a refresh is holding the vault. Verified live: the read-only server answers health and naming-convention queries with no write errors.
- **P5-churn-snapshot — churn and snapshot diff both report a non-empty diff after a change:** Locked the contract that a metadata change between two snapshots surfaces from both freshness surfaces — `churn` (which compares the latest snapshot pair) and `diff_snapshots` (which diffs two named snapshots) — with a test that adds a single field between two snapshots and confirms both report exactly that one added component.
- **P5-what-changed — `sfi.what_changed_since_refresh` lists the types your last refresh changed:** A focused, offline tool over the continuous-learning store that answers "since my last refresh, which component types changed?" — returning the per-type added/removed counts from the most recent refresh, plus a plain-language summary. It's honest about what it knows: these are the changes the *last refresh* pulled into the vault versus the prior snapshot, not what has changed in the live org since — for that it points at `sfi.live_stale_check`. A vault with no recorded history reports that plainly instead of guessing.
- **P5-stale-detection — `sfi.live_stale_check` detects when the org is ahead of the vault:** A new opt-in live-plane tool answers "is my vault stale?" against the source of truth: for each Tooling-queryable type (ApexClass, ApexTrigger, ValidationRule, Layout, Flow, CustomField) it counts the components modified *after* the vault's last refresh via the Tooling API, and reports `orgAheadOfVault`, the total and per-type change counts, and a plain-language interpretation. It's read-only, fail-closed without live consent, and a type the org's Tooling API can't query is skipped (not fatal) rather than failing the whole check. `health_check`'s stale freshness nudge now points at it for the real drift count. Verified against a live org, where it correctly reported the org well ahead of an old snapshot.
- **P5-scoped-refresh-honesty — a scoped `--types` refresh is never reported as complete coverage (B8):** Confirmed and locked end-to-end the honesty contract that a partial-scope refresh can't read as a whole-org scan. The refresh writes a coverage row for every supported type, marking the ones a scoped run didn't ask for as `requested: false`, and the coverage summary buckets those into `missingCoverage` and forces `partial` — so `org_overview`, `health_check`, and `coverage_report` (all of which read that summary) never claim `complete`. Added an end-to-end test that runs a real `--types CustomObject` refresh and asserts the manifest marks the un-requested types `requested: false` and the summary is `partial`, complementing the existing unit-level coverage test.
- **P5-live-drift — the freshness/drift workflow is documented:** Added a "Keeping the vault current" section to the installation guide covering the two freshness surfaces — `sfi.health_check`'s `freshness` nudge (the offline yellow flag) and `sfi.live_drift_check` (the live offline↔org comparison that flags fields the snapshot has but the org no longer returns, the high-signal stale indicator) — including the live-plane consent the latter requires, so a reader knows exactly when and how to confirm drift before re-pulling.
- **P5-doctor-sf-path — `sfi doctor` passes when `sf` is on PATH at any location (B9):** Confirmed and locked the existing behavior with a test: doctor probes `sf --version` via PATH first and only falls back to the hardcoded install locations (`/usr/local/bin/sf`, `/opt/homebrew/bin/sf`) when the PATH probe throws, so a `sf` installed in a non-standard location (an nvm/asdf shim, a Windows install) still passes as long as it is reachable on PATH — and the absolute fallbacks are never consulted in that case.
- **P5-duckdb-lock — a locked vault gives an actionable error, not a raw DuckDB string:** DuckDB allows only one writer of a vault database at a time, so a `sfi refresh` (or a second `sfi mcp`) launched while the MCP server holds the vault failed with a baffling "IO Error: Could not set lock on file …: Conflicting lock is held in …" message. `openGraph` / `openGraphReadOnly` now detect that lock conflict and return a dedicated `locked` error whose message names the likely culprit (a running `sfi mcp` server / your IDE's MCP integration, or a concurrent refresh), the concrete remedy (stop the other process — e.g. `pkill -f 'sfi.js mcp'` — and retry; an MCP server reloads the rebuilt vault automatically on its next call), and appends the underlying DuckDB error for diagnostics. `sfi mcp` prints it to stderr; `sfi refresh` surfaces it as the fatal error. (Verified cross-process against a real held lock. The alternative read-only-MCP coexistence path was deferred — the server's naming-convention recognizer writes to the graph, and read-only open skips migrations, so it needs its own careful change.)
- **P5-refresh-progress — `sfi refresh` streams per-type progress to stderr:** A multi-minute refresh used to render the whole vault behind a single "Rendering Markdown vault..." line. `renderVault` now takes an optional per-type callback that fires the moment each component type is fully drained, and the refresh pipeline wires it to the existing stderr progress sink — so the render phase streams a `  ComponentType: N` line per non-empty type (counts matching the final manifest tally), giving a live sense of the org's shape instead of a silent wait. Empty types are skipped to avoid noise, and the stream is opt-in via the callback so `--json` callers and tests stay quiet.
- **P5-health-nudge — `sfi.health_check` carries a freshness yellow flag:** The health payload now includes an always-present `freshness` block — the vault's `refreshedAt`, its `ageDays`, a `stale` flag (age ≥ 7 days), what the most recent refresh changed (`lastRefresh { available, componentsChanged }`, read from the `meta/history.jsonl` continuous-learning store), and a human `nudge`. The nudge is the offline yellow flag so a host never narrates a stale snapshot as current: it fires when the vault is old (pointing at `/sfi-refresh`, and at `sfi.live_drift_check` for true org-side drift) or when the local source has drifted from the vault (pointing at `sfi refresh --no-pull`). It is honest by construction — "changed AT the last refresh", never "changed in the org SINCE" (an offline vault can't know the latter) — and purely advisory: it never changes the `status` or `checks` verdict, so a merely-aged vault still reads `healthy`.

### Phase 3 — Answer layer & agent contract

- **P3-confidence-glossary — a trust glossary in the README and capabilities:** Added a consolidated trust & confidence glossary to the README and a structured `trustGlossary` to the `sfi.capabilities` payload, keyed by the verbatim runtime value (confidence declared/parsed/heuristic, provenance offline_snapshot/live_org/hybrid, completeness complete/partial/unknown) so it can never drift from the tags the tools emit — a host orienting via capabilities gets the trust vocabulary inline.
- **P3-synthesize-trust — synthesize_answer carries a provenance stamp, and grounding survives a string input:** The grounding tool now returns `provenance { stamp, sources }` rolling the source output(s) trust provenance up (`offline_snapshot` / `live_org` / `hybrid` when fused / `mixed` / `null`) so the host can stamp the answer's origin and never let a vault claim read as a live one. Live testing also caught a real bug: a host handing the prior tool output as a JSON STRING rather than a parsed object broke the entire grounding pass — every id read as ungrounded (false hallucinations) and provenance was lost; the handler now parses a JSON-string input first, so grounding + provenance work whether the host passes an object or a string.

### Phase 2 — Graph completeness (vault trust)

- **P2-B29-retrieve — refresh auto-pulls the objects your automation references but the wildcard excluded:** A trigger/flow/Apex reference can target a CustomObject that `<members>*</members>` skips (a managed object, or a single-underscore-prefixed custom object such as an admissions-template package), leaving it a phantom. `runRefresh` now runs a best-effort second retrieve for exactly those automation-referenced-but-missing objects (`objectsToExpandManifest`) and re-extracts, so analysis isn't left with a hole. Deliberately scoped to automation/code edges — NOT blanket permission grants: a Profile grants object permissions on hundreds of obscure platform/system + managed objects, and auto-pulling every grant target would bloat the vault by 700+ objects (the phantom disclosure handles those). Verified end-to-end on a real org: the automation-referenced phantom objects retrieved and modeled cleanly.
- **P2-BL-06-full — layout_for_user routes by the profile's default record type when there's no master layout assignment:** Asking which layout a profile sees for an object WITHOUT naming a record type, when the object has no `recordType: null` ("master") layout assignment, used to give up (`unknown`). Salesforce routes such a user by their DEFAULT record type, so the cascade now reads the profile's `recordTypeVisibilities`, finds the default record type for the object, and resolves THAT record type's layout assignment — only ever converting a former `unknown` into a match, never changing an existing resolution. (The cascade also already resolves the Lightning FlexiPage stage beyond the original v1.2 classic-only boundary.)
- **P2-B27-heda — package_impact inventory surfaces a managed package even when its own objects are phantoms:** A managed package whose objects come down as phantom references (HEDA `hed`, where you add layouts/fields to `hed__*` objects but the objects themselves were never retrieved) was reported as absent — inventory only detected a namespace from a node's OWN apiName, so it returned "no packages" for a HEDA org while IMPACT mode found 15 hed extensions. Inventory now also detects a package via the parent namespace and reports `extensionCount` (your components grafted onto the package's objects); a package present only via extensions surfaces with `componentCount` 0 and `extensionCount` > 0. (Managed-package fields themselves remain phantoms with the honest "not retrieved" caveat from the field tools.)
- **P2-B20-matchstatus — a failed-activation matching rule no longer drops every other rule on the object:** The matching-rule `ruleStatus` enum was missing `ActivationFailed` (the status a rule reports when its async activation failed). One such rule made the extractor reject the whole `{Object}.matchingRule-meta.xml` file, dropping every other valid matching rule on that object (seen on real Account / Contact rules once the B20 fix retrieved them). Added the missing status; malformed/unknown statuses are still rejected.
- **P2-METADATA-aliases (B20) — assignment / auto-response / escalation / matching / workflow rules now actually retrieve:** The refresh manifest aliases each internal `ComponentType` to the Metadata API `xmlName` the org describe reports, then drops any type the describe lacks. Only `SharingRule → SharingRules` was aliased, so the four sibling aggregate-rule families (and workflow rules) defaulted to their singular name — which the org does NOT expose — and were silently dropped from every retrieve, never reaching the vault. Added `AssignmentRule → AssignmentRules`, `AutoResponseRule → AutoResponseRules`, `EscalationRule → EscalationRules`, `MatchingRule → MatchingRules`, and `WorkflowRule → Workflow`. Confirmed against a real org's `list metadata-types` (the singular names absent, the plural/container names present) and an end-to-end retrieve that pulled real rule files for all five. (`DuplicateRule` is exposed singular and is unchanged.)
- **P2-layout-edges — the layout extractor now sees the Highlights Panel and mini layout, not just the detail body:** A field can be placed only in the Highlights Panel (`summaryLayout > summaryLayoutItems`) or the mini layout (`miniLayout > fields`) and nowhere in the detail body; before, those placements produced no `usedInLayout` edge, so the field read as "not on any layout" for FLS / "is this field visible here" questions. The extractor now unions all three field-bearing regions (deduplicated). Related-list columns remain excluded — they're fields of the *related* object, so a `CustomField:{thisObj}.X` edge would be wrong. (Takes effect on the next `/sfi-refresh`.)
- **P2-get_component-phantom — the phantom message is uniform across the component-tool surface:** `get_component` already explained a referenced-but-not-retrieved component ("referenced by N … never retrieved … run `sfi refresh` / treat as external"); 15 more component-id tools that emitted a bare `no X with id` now share that exact message via the same helper — `explain_apex_method`, `method_reachability`, `downstream_effects`, `test_coverage_for_method`, `what_if_deactivate_flow`, `what_if_disable_trigger`, `generate_data_dictionary`, `omniscript_flow`, `integration_procedure_chain`, `datatransform_field_map`, `decision_table_browse`, `omniuicard_widget_breakdown`, `cpq_quote_template_breakdown`, `cpq_rule_chain`, `cpq_dependency_map`. The compound `null || wrong-type` guards were split so a genuinely wrong-type id still gets the plain "no X with id" while a phantom (null node, inbound edges) gets the honest disclosure. Verified live: `generate_data_dictionary` on a managed object referenced 18× now reports the phantom instead of "no object with id".
- **P2-B12 — field tools speak one "phantom" language for standard / managed-package fields:** Asking nine field tools (`field_360`, `field_lineage`, `field_provenance`, `why_field_changed`, `field_meaning`, and the `what_if_change_field_type` / `make_field_required` / `remove_picklist_value` / `change_field_value` family) about a field whose own definition was not retrieved — a standard field like `Contact.Email`, or a managed-package field — returned a bare `no field with id …` that reads as "this field does not exist". They now return the phantom-aware message ("referenced by N other component(s) … its own definition was never retrieved … run `sfi refresh`, or treat it as external"), matching `explain_field`, `field_access_audit`, and `safe_to_delete_field`. A genuinely-unknown id (no node, no inbound edges) still gets the bare kind-specific message. Verified live: `Contact.Email` (referenced 22×) now reports the phantom uniformly across the whole family.

### Phase 1 — Publish safety

- **P1-CI-cli-bundle — CONTRIBUTING documents the CLI rebuild after MCP edits:** Added step 6 to "Adding or changing MCP tools": an MCP/`intent-router.ts` change is not live in `sfi mcp` (or the QA harness) until `pnpm --filter sf-intelligence build` re-bundles `packages/cli/dist/index.js`. CI's `pnpm -r build` already covers it; the doc reasserts the fast path so stale-dist never masks a change.
- **P1-BL-05 — resolver no longer fakes `exact` on a prefix-only placeholder:** A single-token query whose top match is a much-shorter strict *prefix* (e.g. `OpportunityTrigger` → `Opportunity`, where "trigger" names a different component the user likely meant) was reported `disposition: exact` and auto-picked. It now downgrades to `ambiguous` (with a clarification prompt) when the matched name covers less than 70% of the query token and the match isn't a clean exact-token hit. Typos (`paymnet`→`Payment`, same length) and true exact names are unaffected. Validated zero-regression: 1000Q 97.8%, router suite, and baseline-300 (83%) all unchanged.
- **P1-SYNTH-03 — CI test: grounding holds on a real tool chain:** A golden multi-tool → `synthesize_answer` chain runs in CI (`synthesize-answer.test.ts`): a real graph-backed tool (`get_edges`) produces ids, a draft built only from that output yields **empty `hallucinatedIds`**, and a draft with an injected orphan `Flow:`/`ApexClass:` id is flagged. CI now fails if the grounding guard ever stops catching an orphan id.
- **P1-SYNTH-02 — skills make grounding mandatory:** The entry skill (`using-sf-intelligence`) gains a "Step 8 — ground the answer (MANDATORY)" — build prose only from tool output, run it through `sfi.synthesize_answer`, and strip any `hallucinatedIds` before answering. The `answering-org-questions` verification checklist gains the matching gate. So the skill layer, not just the capabilities payload, enforces tools → synthesize → prose.
- **P1-SYNTH-01 — `sfi.capabilities` teaches the grounding cascade:** Both the conversational and routing guidance now carry a `groundAnswer` step — after the tools return, build prose ONLY from their output and pass it through `sfi.synthesize_answer { question, draft }`, which flags `hallucinatedIds` (canonical ids in the draft that no tool returned). So a host that orients via `sfi.capabilities` is told tools → synthesize_answer → prose, never to narrate an orphan id.
- **P1-CL — complex-long quality gate met (72/75):** After the extractor fixes (NI-2 approval steps, the vault refreshed to bake them in) and the B29 phantom-disclosure work, the complex-long scenario battery reaches the 72/75 ship gate (was 68). Four scenarios had been failing on harness bugs rather than product gaps (a phantom tool call, a stale `triggerInfo` field path, a dead-code judge that demanded dead *Apex* in an org whose dead code is unused fields, and a phantom-objects judge that should accept the honest B29 `targetMissing` disclosure). The remaining 3 are genuine boundaries (a class present only as its test — a phantom — , a standard field with no formula references, and a not-retrieved community login flow).
- **P1-SYNTH-04 — `sfi doctor` surfaces the grounding rule:** The doctor report now ends with a grounding reminder — build org answers from `sfi.*` tool output and pass them through `sfi.synthesize_answer`, which flags any canonical id in the prose that no tool returned (`hallucinatedIds`). Keeps the "never invent ids" contract in front of operators.
- **P1-FRESH-02 — empty `list_components` results explain themselves:** An empty first page from `sfi.list_components({ type })` was a silent `[]` a caller could read as "the org has none". It now carries a `retrievalHint` that uses the manifest coverage to say which of three things is true: **none in the org** (the type was retrieved, nothing found), **not retrieved** (a scoped refresh skipped the type — run `/sfi-refresh`, widen `--types`), or **not modeled** (no extractor — "not analyzed", never "none"). Populated only on an empty first page.
- **P1-FRESH-01 — `sfi doctor` warns when the vault is old even if local source is unchanged:** The freshness check was source-hash-only — if `org-kb/source/` matched the manifest it reported "fresh", regardless of how long ago the org was retrieved. But an unchanged local source says nothing about the *live org*, which may have drifted. `doctor` now computes the vault age from `refreshedAt` and raises a `warn` (with the age and a re-pull fix) past a 14-day threshold; otherwise the "fresh" line now includes a human age ("refreshed 3 days ago"). Exposed `ageInDays` / `isStaleByAge` / `DEFAULT_STALE_AGE_DAYS` helpers (alongside the existing `formatAge`); `sfi status` already shows the age.
- **P1-NI-2 — ApprovalProcess `stepCount` (and approver edges) were silently 0 on every real org:** The extractor read the plural `<approvalSteps>` element, but Salesforce Metadata API ApprovalProcess uses the singular `<approvalStep>` (repeated once per step). On real metadata the plural key was always `undefined`, so `stepCount` came out `0` and no per-step approver `references` edges were emitted — `get_component`'s Properties table (which already renders `stepCount`) showed `0` for multi-step processes. The extractor now reads `<approvalStep>` (the plural is kept as a defensive fallback). After the next `/sfi-refresh`, `get_component` on an ApprovalProcess shows the true step count and approver chain. (Vaults built before this fix need a refresh to update the stored count.) Reading real steps also surfaced a strictness regression — a name-less hierarchy approver (`<type>userHierarchyField</type>` with no `<name>`, i.e. the implicit standard Manager) made the whole process fail extraction; such approvers are now skipped (no edge — there is no named target) while the node + `stepCount` survive. Verified on a real vault: all 25 ApprovalProcesses now extract (4 previously errored to nothing).
- **P1-B29-complete — phantom CustomObjects in `generate_sharing_summary`:** Filtering the sharing summary to an object that was *referenced* (lookup fields, permission grants, code) but whose own CustomObject definition was never retrieved no longer returns a silent "_(no CustomObjects matched the filter)_" that reads as "this object has no sharing". The response now carries a structured `targetMissing { id, referencedBy }` and the body + boundaries disclose "**not retrieved**" — distinguishing a phantom (managed-package / outside-retrieve-scope object) from a genuinely-unknown name, so an FLS/sharing review is never handed an empty answer. Field-level FLS (`field_access_audit`) was already phantom-aware.
- **P1-B14-exec — `route_question` `suggestedArgs` for discovery questions:** The router now hands the first tool the argument it needs so a plain discovery question executes instead of erroring on a required id. Schema enumerations derive the `list_components` `type` it requires (e.g. "duplicate rules on Lead" → `{ type: 'DuplicateRule' }`, "what record types do we have" → `RecordType`, "list all flows" → `Flow`); OmniStudio discovery leads with `list_components` and the sub-family type (OmniScript / OmniIntegrationProcedure / OmniDataTransform / OmniUiCard); CPQ discovery leads with the org-wide `cpq_dependency_map` (no id needed). Shapes that need a parent (e.g. "what fields does Account have") still omit the hint. Rebuild the **`sf-intelligence` CLI** after MCP router edits (`pnpm --filter sf-intelligence build`) so the bundled `dist/index.js` picks up the change.
- **P1-Q-prepublish:** `prepublishOnly` on the npm `sf-intelligence` package runs `scripts/prepublish-check.mjs` (`scan:leaks` + release guard) so `npm publish` aborts if private org identifiers are present in the shipping tree.
- **P1-SCRUB-04 / 04b / 07 / 08 — `release/0.1.7` history scrub:** The publish branch's git history is rewritten free of private org identifiers — `scan-org-leaks --strict --git-history` finds **0 blocklist hits across `release/0.1.7`'s own 82 commits**. Vault artifacts (`org-kb/`, DuckDB, QA result JSON) are untracked, and the leak scanner excludes its own skip-listed tooling from `git log -S` so its detection patterns are not self-flagged. The unscrubbed legacy `main` and feature branches remain a **documented exception**, reconciled later via PR (not rewritten in place without explicit ack).

## [0.1.6] — Router, search, and async-chain fixes

- **`search_components` / `searchNodes`:** `api_name` prefix matches rank above substring contains, so partial flow names prefer the closest Flow apiName over unrelated substring hits (B22).
- **`async_chain_depth`:** Accepts `rootId` with a `Flow:` or `ApexClass:` root. Flow roots walk `callsApex` entry points, then continue over `dispatchesAsync` (INT-28).
- **Router (B21):** Expanded NL patterns for field locate (`where is`), layout inventory, save-order (`what runs on X insert`), flow what-if deactivate, automation risk, platform-event catalog, LWC dependencies, subgraph, explicit tool-name invokes, and admissions/integration phrasing. Rebuild **`sf-intelligence` CLI** after MCP router edits (`pnpm --filter sf-intelligence build`) so the bundled `dist/index.js` picks up router changes.
- **Router:** `release-readiness`, `package-inventory`, layout-per-profile metadata counts, unused-apex → `find_dead_code`.
- **`generate_sharing_summary`:** `objectApiName` alias for `objectFilter` (NI-3).
- **Leak scanner:** `scripts/scan-org-leaks.mjs` and `npm run scan:leaks` for org-identifier hygiene before publish.

## [0.1.4] — Phantom-component disclosure

Includes 0.1.2 and 0.1.3 (never published to npm).

- **Referenced-but-not-retrieved components are now disclosed honestly.** Asking
  what breaks if you change a method on a class that only exists as an edge
  target (its own definition was never retrieved — a managed-package class, or
  one outside the retrieve scope, e.g. when only its Test class came down) now
  says so and points at `sfi refresh`, instead of a bare "no ApexClass". This
  generalizes the save-order phantom-object disclosure (0.1.1) to Apex.

## [0.1.3] — Guarantee save-order tools fit the response budget

Includes everything in 0.1.2 (which was never published to npm).

- **`order_of_execution` no longer fails on the busiest objects.** Its
  four-event view on a Contact with dozens of record-triggered flows reached
  ~120 KB — past the budget even after slimming actions and conditionals,
  because the bloat is the sheer step count. As a final step, the heaviest
  event's trailing steps are dropped (the early pre-save phases are kept;
  `summary.totalSteps` still reports the true total and `stepsOmitted` says how
  many were dropped), so the tool returns a usable, honest answer instead of a
  hard rejection. Use `what_happens_on_save` per event for the complete list.

## [0.1.2] — Resolver ranking & save-order size follow-ups

Follow-ups from the v0.1.1 re-test. Offline, read-only, backward compatible.

- **Resolver ranks the field on the named object first.** "Who can edit Contact
  Email?" now puts `Contact.Email` above the like-named `Account.Contact_Email__c`
  even when the decoy is more heavily referenced — parent-object match is a
  ranking key, not just a score nudge — and a field on the named object is
  always surfaced as a contender, so a like-named decoy is never the confident
  pick.
- **`what_happens_on_save` / `order_of_execution` fit the response budget on
  heavily-automated objects.** When trimming per-step actions isn't enough
  (e.g. a Contact with dozens of record-triggered flows), the heaviest step
  *conditions* are slimmed too — the `conditionContextId` stays (fetch the full
  condition with `get_component`), the verbose expression/fieldRefs drop, and
  the step is flagged `conditionalTruncated`. Every step stays present and in
  order.

## [0.1.1] — First-QA bug fixes

Fixes from the first external QA pass against a real org. All offline,
read-only, and backward compatible — no API or vault-format changes.

### Retrieve & extraction

- **Sharing rules and custom-metadata records now retrieve.** Their internal
  type names were intersected against the org describe by the wrong Metadata
  API `xmlName` (`SharingRule`/`CustomMetadataRecord` instead of
  `SharingRules`/`CustomMetadata`) and silently dropped. The skip message now
  shows the checked xmlName so a real absence is distinguishable from a mapping
  miss.
- **Classic apps** that omit `<navType>` and **Flow-type quick actions** no
  longer fail extraction — they were being dropped from the vault entirely.
- **Standard fields** that omit `<type>` infer their reserved fixed type
  (Email, Phone, the audit DateTime fields, …) instead of `Unknown`.

### Answers & tools

- **Resolver** weights the parent object, so "Email on Contact" finds
  `Contact.Email` rather than a field merely named `Contact_Email__c`.
- **`what_happens_on_save` / `order_of_execution`** stay under the MCP response
  budget on heavily-automated objects (per-step action lists are trimmed with
  an honest count; every step is preserved).
- **`explain_flow`** points at the real component when a name is actually a
  trigger/class (e.g. `AccountTrigger`).
- **Save-order on a managed-package / un-retrieved object** explains it is
  referenced-but-not-modeled instead of a bare "not found".
- **Parameter ergonomics:** `get_edges` accepts `incoming`/`outgoing`,
  `what_happens_on_save` accepts trigger-style events ("after update"),
  `get_naming_convention_report` accepts a scope without the trailing `.*`, and
  `live_count` accepts an `objectApiName`.
- **Router** handles "which flows run when X is created" and permission-set
  read questions that previously went unrouted.

### CLI & coverage

- **`doctor`** resolves `sf` from common install dirs (`/usr/local/bin`,
  `/opt/homebrew/bin`) when it isn't on the PATH an IDE/MCP subprocess inherits.
- **`refresh`** emits per-phase progress so a multi-minute run isn't a silent
  wait.
- A scoped `--types` refresh no longer reports coverage `complete`.

## [0.1.0] — First public release

The first public, free, open-source cut. Read-only and offline by design.

### Conversational front door

- **Typo-tolerant resolver** (`sfi.resolve`) — turns messy or misspelled
  natural-language phrasing into ranked candidate components with a disposition
  (`exact` / `ambiguous` / `none`) and per-candidate evidence. Always heuristic;
  never silently commits to a guess.
- **Clarifying questions** — on an ambiguous match it returns a ready-to-ask
  question instead of guessing; on no match it offers to pull fresh metadata or
  stop, naming the last-refresh time so you can judge staleness.
- **Self-description** (`sfi.capabilities`) — a no-argument capability map with
  example questions, the live tool count, and the read-only/offline boundary.
- **Deterministic router** (`sfi.route_question`) — maps each question to the
  plane that answers it (offline vault, opt-in live org, or hybrid) and to the
  exact tools to run, so you never type a tool name.

### Knowledge base

- **Offline-first vault** — one `sf project retrieve` builds a local Markdown
  vault (`org-kb/`) and a DuckDB dependency graph. Vault answers are served
  locally with no network egress.
- **Broad metadata coverage** — schema (objects, fields, record types, value
  sets), validation rules, Flows, Apex, layouts, permission sets & profiles,
  sharing, legacy automation, frontend (LWC / Aura / Visualforce), the
  integration surface, and OmniStudio — connected by typed, confidence-tagged
  edges (`declared` / `parsed` / `heuristic`).
- **Composed analyses** — impact / what-if change analysis, heuristic
  code-quality recognizers, documentation generators, and cross-vault
  comparison.

### Trust & honesty

- **Coverage report** (`sfi.coverage_report`) — lists which metadata families a
  refresh actually retrieved and modeled; a type that wasn't checked is reported
  as such, never as "none".
- **Trust blocks** — analysis tools carry `provenance` / `confidence` /
  `completeness`; destructive verdicts (`safe_to_delete_field`, the `what_if_*`
  family) surface a `coverageCaveat` when the families they depend on aren't
  fully covered.
- **Longitudinal** — baseline acknowledgement and trend / churn tools track how
  the org changes across refreshes.

### Live read-only plane (opt-in)

- Curated read-only tools (`sfi.live_count`, `sfi.live_sample`,
  `sfi.live_describe`, and others) can query the org when explicitly enabled
  (standing consent, `SFI_LIVE_PLANE_ENABLED=1`, or a per-call flag). Offline
  remains the default; there is no generic SOQL tool and no write path.

### Packaging

- Distributed as a single npm package, **`sf-intelligence`** — an MCP server
  plus the `sfi` CLI (`init` / `refresh` / `status` / `doctor` / `mcp`).
- Ships as a Claude Code plugin layer (skills + slash commands) on top of the
  same package.
- MIT + Commons Clause licensed.

[0.1.0]: https://github.com/PranavNagrecha/Salesforce-Intelligence/releases/tag/v0.1.0
