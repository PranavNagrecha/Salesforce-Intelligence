### Fixed

- **The product's central honesty sentence was ungrammatical.** Every coverage
  caveat is composed as `"<subject> cannot be confirmed because …"`, which
  requires `subject` to be a noun phrase. That contract was implicit, and the
  graph-traversal caller passed a two-sentence blob ending in a verb, so
  `find_component_usages`, `get_impact`, `get_edges` and `get_subgraph` rendered,
  verbatim, on *every* empty result: *"… can only be asserted for the dependency
  families the vault actually retrieved cannot be confirmed because the vault has
  incomplete coverage for: …"*. The composer now takes explicit `preamble` /
  `subject` slots, and the whole rendered sentence is pinned per caller.

- **`safe_to_delete_field` answered `unknown` for a custom button or link.** The
  shared deletion vocabulary (`model/edge-semantics.yaml`) had no `WebLink` row
  under `references`, so a button whose URL or JavaScript names a field fell
  through to `{unknown, risky}` — 79 such edges over 32 fields on one real vault.
  `WebLink` now maps to `{layout, risky}`, matching `QuickAction`, the equivalent
  UI-placement surface. The `layout` category note names custom buttons/links.

- **A Flow scan capped at 500 with no way to say so.** The supplemental Flow
  field-writer scan read one `listNodesByType('Flow', { limit: 500 })` page and
  returned a bare array, so on an org with more than 500 Flows a writer past the
  cap was silently missing and neither caller could disclose it. It now pages
  every Flow and reports `truncated` / `scannedCount` / `totalCount`, matching
  its sibling condition-reader scan. `field_360` adds a boundary line and
  `why_field_changed` gains `supplementalScanTruncation`; a graph error yields a
  TRUNCATED empty result, never a clean "no supplemental writers".

- **`get_subgraph` deleted every edge of a phantom root and called it complete.**
  Edges whose endpoint has no node row are dropped to keep the slice
  self-contained — correct, but invisible: `truncated` stayed `false` and the
  disclosure opened *"Complete subgraph within 1 hop(s)"*. Measured on a real
  vault: a walk rooted on a never-retrieved standard object returned 15 nodes,
  0 edges, "complete". The graph layer now reports `droppedEndpointEdges`
  (count, phantom vs node-cap cause, and the missing endpoint ids), `truncated`
  is true whenever any edge was dropped, and the disclosure says PARTIAL and
  names the phantom root.

### Changed

- **`who_can_access_object` no longer answers "which profiles?" with half of
  them.** Rows were sorted by `granterId`, which sorts by type prefix first, so
  the default page was one contiguous alphabetical block: on a real vault, 120 of
  218 rows = 98 PermissionSet + 18 Profile + 4 Group, cut mid-alphabet, with none
  of the 3 Role rows. The page is now interleaved round-robin across granter
  kinds — a permutation of the same list, so `offset`/`limit` still enumerate
  every row exactly once — and `summary.byGranterType` carries each kind's true
  row/principal counts, how many landed on this page, and a named sample of each.

- **Corrected two impact-analysis doc claims and the `get_impact` description.**
  The architect skill told the reader to skip the existence check because an
  unknown id returns an empty impact set — which is exactly why it must NOT be
  skipped: that response is byte-identical to a real "nothing depends on this".
  It also claimed `impact.nodes` always includes the root, which is false for a
  phantom root (a real probe returned 14 nodes, none of them the root, under the
  words "Complete impact slice"). Both now describe what the code does, and the
  MCP description names the same two ambiguities.
