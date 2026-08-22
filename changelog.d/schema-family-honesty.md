### Fixed

- **`sfi.find_formula_references` refuses a field it does not hold.** Four
  distinct causes produced a byte-identical `{ referencers: [], totalCount: 0 }`
  and three of them were lies: a miscased id, a typo'd id, a node of another
  type, and a real field that genuinely has no formula references. Only the last
  is an empty result. The tool now runs the same existence gate nine sibling
  field tools already pay for — `component-not-found` with typo-tolerant
  `resolveSuggestions`, and the phantom-aware wording that keeps a STANDARD
  field id from reading as "does not exist".

  **Behaviour change for callers:** an unknown id that used to return an empty
  list now returns an error envelope.

- **`find_formula_references`'s empty-result coverage caveat is reachable.**
  `FORMULA_REFERENCE_REQUIRED_COVERAGE` named two families (`CustomField`,
  `ValidationRule`) when eleven actually produce `references` edges into a
  field. It is now the observed producer set, censused from both reference
  vaults: `ListView`, `ReportType`, `FlexiPage`, `QuickAction`, `WebLink`,
  `ApprovalProcess`, `MatchingRule`, `CustomMetadataRecord`, and `Index` join
  the two. **This makes the caveat fire on more vaults** — that is the point:
  a zero from a vault missing `ListView` was never "none", it was "not checked".

- **The response-budget guard no longer goes blind on nested lists.** Pass 1
  read only the top-level keys of `data`, so a tool nesting its lists
  (`field_lineage`'s `data.upstream.sources`) offered it no array to cut and the
  whole response fell through to an opaque `oversize` error. It now descends one
  level and names the dotted paths it trimmed in `responseBudget.truncatedPaths`.
  Only payloads that were ALREADY over budget change; nothing under budget moves.
