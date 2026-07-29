# sf-intelligence 0.3.0 — release notes (PREPARED, NOT SHIPPED)

**Status: staged locally. Nothing pushed, nothing published, no tag cut.** Awaiting owner approval.

---

## What this release is

A field-deletion release. It adds the method as a first-class product surface — skill, subagents, slash command, MCP prompt — and, in the course of building it, closes **four ways `sfi.safe_to_delete_field` could tell you a field was safe when the platform refuses to delete it**.

The second part matters more than the first. Every one of those four gaps sat inside a metadata family the refresh had *fully retrieved*, so no `coverageCaveat` fired and the verdict presented as clean rather than hedged. A tool can only warn you about the gaps it knows it has.

## Headline: what was wrong

| Gap | Symptom | Real-vault impact |
|---|---|---|
| Roll-up coupling was a node property, never an edge | The hardest blocker on an object returned no reasons | 98 edges |
| Condition field refs were a property, never edges | A field used only in a Flow entry criterion read "layout only" | 1,488 edges |
| Formula `__r` traversals were skipped | A field read only via `Parent__r.Field__c` showed zero referrers | 242 edges |
| FlexiPage `relatedListFieldAliases` unparsed | A field shown twice on a record page had zero referencers | 101 edges |

**85 fields on the reference org had zero dependency evidence before this release and have some now.**

## Then the fixes had bugs, and those were found too

An adversarial sweep of this branch found four further defects, all introduced by the work above:

1. **The resolver ran only in the cold import.** A `sfi refresh --incremental-graph` deleted all 343 resolver edges, silently returning fields to "no referrers". Worse than never adding them.
2. **Fixing that opened a second deletion path.** Mirroring the pass into the incremental reconcile armed a prune conjunct that then deleted the FlexiPage-sourced edges on `sfi refresh --types CustomField`.
3. **A fabricated citation on 127 fields.** Every resolved formula traversal was reported as a roll-up summary and the user told to "delete or repoint the roll-up first" for a component that does not exist. Right verdict, invented evidence.
4. **280 phantom edges.** Condition `fieldRefs` promoted to edges dragged Flow variable names, choice names and `$Record` into the graph as `CustomField:` ids — and the phantom taxonomy labelled a bare Flow variable a *standard field*.

All four are fixed, each with a FAIL-BEFORE/PASS-AFTER regression test.

## Behaviour change — read this before upgrading

**`safe` is harder to reach on a coverage-degraded vault.** `USAGE_SOURCE_FAMILIES.CustomField` now attests `ApprovalProcess`, `AssignmentRule`, `AutoResponseRule` and `EscalationRule` — 4 of the 7 condition firers this release wires up. If those families were not retrieved, a `condition` blocker could hide behind the gap while the verdict read clean. Fields that previously returned `safe` on such a vault will now return `review`.

This is the honest direction, and it is deliberate: shipping a release that closes false-`safe` paths while leaving another open would be incoherent.

## New surfaces

- **`salesforce-field-audit`** — 26th plugin skill. The full method: checklist, trap catalogue, reporting contract.
- **`salesforce-field-auditor` / `salesforce-field-refuter`** — the plugin's first subagents. Separate on purpose: the method's verification pass requires refuters that cannot see each other's reasoning. In the engagement the method comes from, that pass reverted a third of its own corrections.
- **`/sfi-field-audit <Object>`** — orchestrates scout → fan-out → three-lens adversarial verification (2-of-3 majority) → single-threaded synthesis.
- **`sfi.field_audit`** — the same method as an MCP prompt, for hosts that are not Claude Code.
- **`field_360.rollups`** — new section surfacing parent roll-up coupling.

Counts: **26 skills · 5 slash commands · 2 subagents · 203 tools**.

## Known limitation (pre-existing, documented not fixed)

The refresh manifest's per-edge-type tally is derived from the Markdown render rather than the graph, so it counts only edges whose `from_id` type is in `SUPPORTED_TYPES`. `ConditionalContext` is not, so **1,768 of 3,967 `readsFrom` edges (45%) are invisible to `manifest.edges`**, and the refresh Pulse can report "0 edges since the last refresh" while hundreds changed. No tool answer, verdict or query reads `manifest.edges` — the blast radius is the org-card total, the manifest diff signal and pulse/history. Fixing it will produce a one-time step change in those numbers.

## Verification performed

- **9,600+ unit tests**, full build, lint, and every release-guard gate green.
- **Real-org verification on all three refresh paths** — cold import, `--incremental-graph`, and scoped `--types` prune — confirming the new edges survive each.
- **Concept Model join checked**: the new edges feed `sfi.interpret` correctly, adding 16 grounded structural interpretations, with both contamination risks (roll-up edges firing formula rules; condition edges double-counting the RM-loop property) explicitly measured at zero.

## Not verified

- The subagents have not been dispatched end to end — agent types resolve at session start, so that needs a fresh session with the plugin installed.
- No live-plane run: population, recency and config-stored-as-data checks are untested against a real org.
- The reference vault retrieved **zero** Reports/Dashboards/WorkflowRules, so no report-filter evidence exercised the analytics path.

## Release checklist (none of this has been done)

- [ ] Owner approval
- [ ] Push branch, open PR, CI green
- [ ] Merge to `main` (squash — privacy rule)
- [ ] Tag `v0.3.0` → OIDC Trusted Publishing to npm
- [ ] GitHub release from these notes
- [ ] Website auto-deploys from `main`
- [ ] Re-run `scan:leaks:history` before publishing
