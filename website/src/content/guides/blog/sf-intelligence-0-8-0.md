---
title: "sf-intelligence 0.8.0: Trust the Verdict"
description: "sf-intelligence 0.8.0 adds no tools: save-order answers are right on framework orgs, dead-code verdicts stop inventing confidence, and the regex router is gone."
slug: /blog/sf-intelligence-0-8-0
targetQuery: "sf-intelligence 0.8.0 release notes"
persona: "Salesforce admins, developers and architects who use Claude, Cursor or VS Code with their org"
datePublished: 2026-10-19
dateModified: 2026-10-19
faq:
  - q: "Do I need to refresh my vault after upgrading to 0.8.0?"
    a: "Yes, once. Lightning page references, report-type columns, dynamically loaded classes, Change Data Capture subscriptions and workflow field updates are read at refresh time, and the edges to platform classes are removed then. Until you refresh, where-used and safe-to-delete answers keep the old gaps."
  - q: "Why did my dead-code counts change?"
    a: "A custom field is never called definitely dead on heuristic evidence any more. It is likely dead, and the answer names the referrer families the vault did not check. Totals are the same; the confident bucket moved to the honest one."
  - q: "Were any tools added?"
    a: "No. 0.8.0 adds no tools and no new way to ask anything. Every change makes an existing answer more correct or more honest, or removes something that second-guessed your assistant."
  - q: "What happened to the router?"
    a: "The 7,854-line regex router is deleted. Your assistant decides which tool to call; the semantic funnel offers a shortlist and says when the question is genuinely ambiguous. A script that read route.intent must read toolCandidates instead."
  - q: "Where is the full list of changes?"
    a: "In the [CHANGELOG on GitHub](https://github.com/PranavNagrecha/Salesforce-Intelligence/blob/main/CHANGELOG.md)."
related:
  - /use-cases/what-breaks-if-you-delete-a-field
  - /how-to/find-what-is-updating-a-field
  - /how-to/pre-deployment-impact-review
  - /blog/sf-intelligence-0-7-0
section: blog
heading: "sf-intelligence 0.8.0: the save-order answer is right on framework orgs, dead-code verdicts stop inventing confidence, and the regex router is gone"
intro: "Before this release we asked plain Claude Code and Claude Code with sf-intelligence the same eight questions about a real org. Plain Claude got eight right; with the product, six. 0.8.0 closes that gap and removes the part of the product that second-guessed the assistant."
schemaType: Article
cta:
  question: "What happens when I save a Project__c record?"
---

0.7.0 finished an external review. 0.8.0 started with a harder test: a plain Claude Code session reading the raw metadata of a real university sandbox, against the same session with sf-intelligence attached, on eight questions an admin actually asks. Plain Claude answered all eight correctly. With the product, six. The two it lost were the product's own fault. This release fixes those, then fixes the same class of mistake everywhere else we could find it. Nothing was added.

## 1. "What happens when I save this record?" is right on a framework org

Many orgs run their triggers through a framework that registers handler classes in a custom metadata type or a custom object. The vault can see the classes but not the registration rows, so the save-order answer silently left them out. Now every class the framework could run is listed as a conditional step, with the reason. Separately, a flow step used to show the flow's first inner decision as if it were the condition for running at all. It now shows the flow's real entry criteria, or says plainly that there are none and counts the decisions inside. On the test org, five of nine flow steps had shown a decision as their gate; now none do.

Re-run after the fix: eight of eight, both arms, and the product answered the save question in 56 seconds against 91 for grep.

## 2. Dead-code and deletion verdicts stop inventing confidence

Four kinds of use were invisible: a field read by a Lightning page's visibility rule or placed on a record page, a field listed as a report-type or field-set column, a class loaded dynamically by name, and a trigger subscribed to Change Data Capture. Each is a real reference now. On the test org that removed 2,590 dangling report-type references and gave a field that drives two record pages' visibility its two referrers back.

The verdict itself changed too. A custom field is never `definitely_dead` on heuristic evidence; it is `likely_dead`, and the answer names what was not checked (reports the vault did not retrieve, formula text, dynamic queries). Every usage row carries its referrer's status, so an obsolete flow never reads as a second live writer. And the product no longer invents component ids: calls to `Type`, `ApexPages` or `Site` used to mint edges to classes the vault can never hold, 236 of them on the test org; they are gone.

## 3. Caveats only when the check could not run

A caveat is for what the vault truly cannot see. Several tools printed theirs unconditionally. The save-order tools now count Process Builder processes, approvals and time triggers before mentioning them. The permission-risk report reads the org's security and session settings into its evidence instead of warning that they might matter. "Who can see these records?" shows the sharing rule's actual filter; the placeholder `(predicate not extracted)` appeared 13 times in one answer on the test org and now appears zero times. Summary sentences such as "19 of 20 remote sites are active" are computed from the rows they summarise.

## 4. The assistant routes; the product advises

The regex router that tried to pick a tool from your wording is deleted: 7,854 lines, its offline mode and the test that kept every tool reachable through it. Your assistant already knows how to choose; what it needs is a good shortlist and honest signals. The semantic funnel gives both: it stops only on real ambiguity, labels weak evidence low, tolerates a one-letter typo, and finds the deletion and custom-metadata tools for the questions that ask for them. The analysis catalog matches any word of your question instead of all of them, which is why a nine-word question used to return nothing.

## 5. First-run fixes

A newcomer installed the package from a tarball and followed the README. What they hit is fixed: `sfi init` writes a relative vault root so a copied project refreshes, ignores the org-data files it should never have let into git, and its `.gitignore` is a deny-list; next actions name a command you can run (`sfi refresh`) rather than a slash command your editor may not have; the doctor speaks plainly; a dependency advisory on fresh installs is gone.

## Upgrading

```bash
npm install -g sf-intelligence@0.8.0
sfi refresh
```

The refresh matters this time: the new references are read when the vault is rebuilt. If a script of yours read `route_question`'s `route.intent`, read `toolCandidates` instead. Everything else keeps its shape.
