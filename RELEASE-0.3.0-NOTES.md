# sf-intelligence 0.3.0 — release notes (PREPARED, NOT SHIPPED)

**Status: staged locally. Nothing pushed, nothing published, no tag cut.** Awaiting owner approval.

---

## What this release is

A field-deletion release. It adds the method as a first-class product surface — skill, subagents, slash command, MCP prompt — and, in the course of building it, closes **four ways `sfi.safe_to_delete_field` could tell you a field was safe when the platform refuses to delete it**.

The second part matters more than the first. Every one of those four gaps sat inside a metadata family the refresh had *fully retrieved*, so no `coverageCaveat` fired and the verdict presented as clean rather than hedged. A tool can only warn you about the gaps it knows it has.

## Headline: what was wrong

Edge counts are from the reference vault's graph (`org-kb/graph/graph.duckdb`), counted by `source`:

| Gap | Symptom | Real-vault impact |
|---|---|---|
| Roll-up coupling was a node property, never an edge | The hardest blocker on an object returned no reasons | **98** `references` edges (`rollup-summary`) |
| Condition field refs were a property, never edges | A field used only in a Flow entry criterion read "layout only" | **1,488** `readsFrom` edges (`condition-extractor`), off 941 `ConditionalContext` nodes |
| Formula `__r` traversals were skipped | A field read only via `Parent__r.Field__c` showed zero referrers | **240** `references` edges (`relationship-resolver`, `CustomField` source) |
| FlexiPage `relatedListFieldAliases` unparsed | A field shown twice on a record page had zero referencers | **103** `references` edges (`relationship-resolver`, `FlexiPage` source) |

**85 CustomField nodes on the reference vault gained their first functional dependency edge from this release.** Precisely: 85 vaulted fields whose only incoming edges were ownership (`parentOf`), field-level security (`grantedBy`) or layout placement (`usedInLayout`) — the exact shape that renders as "layout only" — now carry an edge from one of the three new sources. By source: 44 from the relationship resolver, 28 from conditions, 14 from roll-up coupling (86, not 85, because one field gained edges from two of them).

**The entry-criteria number is a floor, not a total.** The graph above was built before the `<start><filters>` dialect fix landed, so it contains condition edges only for the `<decisions>` dialect and for formula-mode entry criteria. On the reference retrieval, **160 of 275 flow files carry structured `<start><filters>` entry criteria — 449 filter triplets naming 177 distinct `Object.Field` pairs, 174 of which resolve to a vaulted `CustomField`**, and none of them minted an edge in the graph measured here. **17 of those 174 have no other functional incoming edge at all**, so today `safe_to_delete_field` sees them as unreferenced while a record-triggered flow gates on them. Re-derive both the 1,488 and the 85 after the next vault rebuild; both go up.

## Then the fixes had bugs, and those were found too

An adversarial sweep of this branch found four further defects, all introduced by the work above:

1. **The resolver ran only in the cold import.** A `sfi refresh --incremental-graph` deleted all 343 resolver edges, silently returning fields to "no referrers". Worse than never adding them.
2. **Fixing that opened a second deletion path.** Mirroring the pass into the incremental reconcile armed a prune conjunct that then deleted the FlexiPage-sourced edges on `sfi refresh --types CustomField`.
3. **A fabricated citation on 127 fields.** Every resolved formula traversal was reported as a roll-up summary and the user told to "delete or repoint the roll-up first" for a component that does not exist — all 240 `CustomField`-sourced resolver edges, across 127 distinct target fields. Right verdict, invented evidence.
4. **280 phantom edges.** Condition `fieldRefs` promoted to edges dragged Flow variable names, choice names and `$Record` into the graph as `CustomField:` ids — and the phantom taxonomy labelled a bare Flow variable a *standard field*. Removing them is why `readsFrom` totals 3,687 rather than 3,967.

All four are fixed, each with a FAIL-BEFORE/PASS-AFTER regression test.

## Behaviour change — read this before upgrading

**`safe` is harder to reach on a coverage-degraded vault.** `USAGE_SOURCE_FAMILIES.CustomField` now attests `ApprovalProcess`, `AssignmentRule`, `AutoResponseRule` and `EscalationRule` — 4 of the 7 condition firers this release wires up.

The blast radius is exactly one predicate, not a general tightening. A verdict changes from `safe` to `review` **only** when every CustomField referrer family attested before this release is `complete` **and** at least one of `ApprovalProcess` / `AssignmentRule` / `AutoResponseRule` / `EscalationRule` is not. Any vault where one of the previously-attested families is already incomplete was hedging before and still hedges; any vault where all four new families are complete returns exactly what it returned before. The changed set is vaults that retrieved everything else but skipped a rule family — where a `condition` blocker could hide behind the gap while the verdict read clean.

This is the honest direction, and it is deliberate: shipping a release that closes false-`safe` paths while leaving another open would be incoherent.

## New surfaces

- **`salesforce-field-audit`** — 26th plugin skill. The full method: checklist, trap catalogue, reporting contract.
- **`salesforce-field-auditor` / `salesforce-field-refuter`** — the plugin's first subagents. Separate on purpose: the method's verification pass requires refuters that cannot see each other's reasoning. In the engagement the method comes from, that pass reverted a third of its own corrections.
- **`/sfi-field-audit <Object>`** — orchestrates scout → fan-out → three-lens adversarial verification (2-of-3 majority) → single-threaded synthesis.
- **`sfi.field_audit`** — the same method as an MCP prompt, for hosts that are not Claude Code.
- **`field_360.rollups`** — new section surfacing parent roll-up coupling.

Counts, from `.claude/` on disk and `website/src/data/site-data.json`: **26 skills · 5 slash commands · 2 subagents · 203 tools**.

## Known limitation (pre-existing, documented not fixed)

The refresh manifest's per-edge-type tally is derived from the Markdown render rather than the graph, so it counts only edges whose `from_id` type is in `SUPPORTED_TYPES`. `ConditionalContext` is not, so **1,488 of 3,687 `readsFrom` edges (40%) are invisible to `manifest.edges`**, and the refresh Pulse can report "0 edges since the last refresh" while hundreds changed. No tool answer, verdict or query reads `manifest.edges` — the blast radius is the org-card total, the manifest diff signal and pulse/history. Fixing it will produce a one-time step change in those numbers.

## Verification performed

- **7,813 test cases across 447 files in 10 packages**, full build, lint, and every release-guard gate green.
- **Real-org verification on all three refresh paths** — cold import, `--incremental-graph`, and scoped `--types` prune — confirming the new edges survive each.
- **Concept Model join checked**: the new edges feed `sfi.interpret` correctly, with both contamination risks (roll-up edges firing formula rules; condition edges double-counting the RM-loop property) explicitly measured at zero.

## Not verified

- The subagents have not been dispatched end to end — agent types resolve at session start, so that needs a fresh session with the plugin installed.
- No live-plane run: population, recency and config-stored-as-data checks are untested against a real org.
- **The reference vault modelled zero Reports, Dashboards and WorkflowRules** — `manifest.coverage` reports `retrieved: 0` for all three even though `org-kb/source/` holds 3,076 report files, 78 dashboards and 10 workflow files. So no report-filter evidence exercised the analytics path, and the condition work is untested against the WorkflowRule firer on real data.
- The `<start><filters>` entry-criteria edges themselves: the fix has unit coverage, but no vault in this tree has been rebuilt with it (see the floor note above).

## Release checklist (none of this has been done)

- [ ] Owner approval
- [ ] Rebuild the reference vault and re-derive the condition-edge and 85-field figures above
- [ ] Push branch, open PR, CI green
- [ ] Merge to `main` (squash — privacy rule)
- [ ] Tag `v0.3.0` → OIDC Trusted Publishing to npm
- [ ] GitHub release from these notes
- [ ] Website auto-deploys from `main`
- [ ] Re-run `scan:leaks:history` before publishing
