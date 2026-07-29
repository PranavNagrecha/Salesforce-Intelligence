### Fixed

- **`safe_to_delete_field` could return `safe` for a field the platform refuses to delete.** Four independent modelling gaps each produced a live field with zero incoming edges. All four sat inside metadata families the refresh had *fully retrieved*, so no `coverageCaveat` fired and the verdict presented as clean rather than hedged.
  - **Roll-up summary coupling** is now a graph edge, not just a node property. A roll-up declares `summarizedField`, `summaryForeignKey` and `summaryFilterItems` on the **parent** object, so an incoming-edge walk from the child field never reached it. Each is emitted as a `references` edge and classified `blocking` under the new `rollup` category.
  - **Condition field references** are now `readsFrom` edges. A `ConditionalContext` resolved the fields its condition tested but stored them only as a node property, and the `firesWhen` edge runs firer → context — so a field used only in a Flow entry criterion returned "layout only". Covers Flow entry criteria and decisions, workflow-rule criteria, validation-rule conditions and the rule-entry firers, classified `blocking` under the new `condition` category.
  - **Formula `__r` traversals** now resolve. Cross-object dotted paths were skipped to avoid minting dangling ids; a field read only through `Parent__r.Field__c` therefore showed no referrers at all. A new import-time pass resolves single- and multi-hop traversals against a relationship map built from every vaulted lookup.
  - **FlexiPage `relatedListFieldAliases`** now resolve. Dynamic related-list columns are *bare* field names on the **related** object — invisible to the whole-XML dotted sweep, and wrong to attribute to the page's own `sobjectType`. They resolve through the same relationship map.

### Added

- `sfi.field_audit` — a curated MCP prompt carrying the field-deletion audit method (calibrate before trusting a zero; formula fields have no population figure; record role rather than count; a deleted report *filter* fails the report **open**, silently widening it). Gives non-Claude MCP hosts the discipline the plugin skill gives Claude Code.
- `salesforce-field-audit` — the 26th Claude Code plugin skill. Decides Keep / Review / Deprecate-then-Remove / Remove with full dependency tracing, and validates an existing field-cleanup analysis.
- **Subagents.** The plugin now ships agents (`"agents"` in the manifest; first two): `salesforce-field-auditor` batches 4–8 fields into structured verdict records, and `salesforce-field-refuter` attacks one verdict from one assigned lens. They are separate agents because the method's verification pass requires refuters that cannot see each other's reasoning — in the reference run it reverted a third of its own corrections.
- `/sfi-field-audit <Object>` — orchestrates the run: scout inline (never parallelised, since a divergent evidence base silently invalidates every downstream comparison), fan out auditors, three independent refuters per contested verdict with a 2-of-3 majority, then single-threaded synthesis. Decides Keep / Review / Deprecate-then-Remove / Remove with full dependency tracing, and validates an existing field-cleanup analysis.

### Changed

- The relationship resolver drops what it cannot resolve rather than guessing: an unresolvable hop, a traversal into an unretrieved object, and an ambiguous child-relationship name all mint **no** edge, and only targets matching a real vaulted `CustomField` are emitted. A dangling id would present as evidence of a referrer that does not exist.
- Roll-up and condition reasoning notes state the standing honesty axis explicitly — conditions are **listed, never evaluated**; sfi does not know whether a runtime record satisfies them.
