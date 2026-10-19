# Release report: 0.8.0 (2026-10-19)

Anonymized. No customer org, class, field or vault name appears here. Counts come from re-extracting a copy of a real sandbox (a managed-package org with a trigger framework) and a real OmniStudio sandbox with the release build, and from the bundled demo org.

## What shipped

No new tools. The release makes the answers people already ask for more correct and more honest, and removes the one part of the product that second-guessed the assistant.

- **"What happens when I save this record?" is right on a managed-package org.** Handler classes a trigger framework registers in data are listed as conditional steps, and every flow step shows the flow's real entry criteria (or says plainly that it has none and lists its decisions) instead of its first inner decision. On the test org, 5 of 9 flow steps had shown a decision as the gate; now 0 do. This was the one question plain Claude Code answered better than the product on release candidate 1.
- **"Can I safely delete this field?" stops inventing confidence.** Lightning page visibility rules and component placements, report-type and field-set columns, dynamically loaded classes and Change Data Capture subscriptions are real references now, so a field or class used only there is no longer called dead. A custom field's verdict is never `definitely_dead` on heuristic evidence; it caps at `likely_dead` and names the referrer families the vault did not check. Every usage row carries its referrer's status, so an obsolete flow never reads as a second live writer.
- **"Who can see these records?" shows the rule.** Sharing-rule filters render from their criteria items through one shared formatter. On the test org the placeholder `(predicate not extracted)` appeared 13 times in one answer; now 0.
- **Caveats print only when the check could not run.** The save-order tools count Process Builder processes, approvals and time triggers before mentioning them; the permission-risk report reads the org's security and session settings into its evidence instead of warning that they might exist; the usage tools say "no layout references" only when the vault has none.
- **Summaries are computed from their rows.** "19 of 20 remote sites are active" comes from the rows, not from a fixed sentence; the grounding tool refuses to call an empty input grounded; ids with spaces are cited whole.
- **No invented component ids.** Calls to platform classes no longer mint edges to classes the vault can never hold (236 such edges on the test org, now 0); workflow field updates are nodes; report-type columns reach the field they name (2,590 dangling references on the test org, now 0).
- **The host model routes.** The 7,854-line regex router, its offline mode and its "every tool reachable" test are gone. The semantic funnel advises a shortlist, stops only on real ambiguity, labels weak evidence low, tolerates a one-letter typo, and finds the custom-metadata and deletion tools for the questions that ask for them. The analysis catalog matches any word of a question instead of all of them.
- **First-run fixes from a stranger's walk-through.** `sfi init` writes a relative vault root (a copied project refreshes), ignores the org-data files under `org-kb/meta/` and `snapshots/`, and its `.gitignore` is a deny-list. Next actions name a command (`sfi refresh`), not a Claude slash command. The doctor speaks plainly. A dependency advisory is gone. The README quickstart registers the demo correctly.

## Measured

| Measurement | Before | After |
|---|---|---|
| Flow steps on the test org's busiest update save whose gate was an inner decision | 5 of 9 | 0 of 9 |
| `(predicate not extracted)` in one who-can-access answer on the test org | 13 | 0 |
| Dangling report-type → field references on the test org | 2,590 | 0 |
| `callsApex` edges to platform classes on the test org | 236 | 0 |
| Custom fields called `definitely_dead` on heuristic evidence (test org, one page) | 72 | 0 |
| Core `tools/list` bytes (16 default tools) | 18,481 | 18,473 |
| Median demo answer bytes | 6,660 | 6,538 |
| Plain Claude Code vs with sf-intelligence, same eight questions on the test org | 8/8 vs 6/8 (save order wrong) | 8/8 vs 8/8 |
| Median seconds per question, with sf-intelligence vs plain | — | 46 vs 61 |

Incremental refresh stayed byte-identical to a cold rebuild (upsert, delete, staged) on the OmniStudio sandbox. The product-versus-plain comparison ran on Claude Code with Opus as the host; both arms answered every question correctly, with no fabrications in either. The product's edge on that org is speed, cited component ids, verdict words and quantified coverage ("499 of 14,018 reports retrieved"), not correctness.

## Upgrade note

Refresh once: the new references (Lightning pages, report-type columns, dynamic dispatch, Change Data Capture, workflow field updates) are read at refresh time, and the platform-class edges are removed then. If an integration read `route_question`'s `route.intent`, it must read `toolCandidates` instead. See the [upgrading guide](../guides/upgrading.md).
