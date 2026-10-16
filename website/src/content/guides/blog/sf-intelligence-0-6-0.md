---
title: "sf-intelligence 0.6.0: More Right, Not More"
description: "sf-intelligence 0.6.0 adds no tools. Flow screens, non-Apex flow actions, component markup and related-list columns now count as use; a build scorecard stops regressions."
slug: /blog/sf-intelligence-0-6-0
targetQuery: "sf-intelligence 0.6.0 release notes"
persona: "Salesforce admins, developers and architects who use Claude, Cursor or VS Code with their org"
datePublished: 2026-10-16
dateModified: 2026-10-16
faq:
  - q: "Do I need to refresh my vault after upgrading to 0.6.0?"
    a: "Yes, once. The new references (flow screen fields, non-Apex flow actions, component markup bindings, related-list columns) are read at refresh time. Run sfi refresh and the where-used and dead-code answers pick them up."
  - q: "Why did a field that was 'definitely dead' in 0.5.0 become 'uncertain' or 'in use'?"
    a: "Because 0.6.0 sees more of your org. A field shown only in a related-list column on a page layout, or edited only on a flow screen, had no reference before. Now it does. The verdict was wrong before, not now."
  - q: "What is the scorecard?"
    a: "A step in the project's build gate that measures the default tool count, the size of the tool list, the median answer size on the demo org, verdict counts on real orgs, the number of allowlisted test failures and the number of 'keep in sync' comments in the code. A change that makes any of them worse fails the build."
  - q: "Were any tools added?"
    a: "No. 0.6.0 adds no tools and no new way to ask anything. Every change makes an existing answer more correct or smaller."
  - q: "Where is the full list of changes?"
    a: "In the [CHANGELOG on GitHub](https://github.com/PranavNagrecha/Salesforce-Intelligence/blob/main/CHANGELOG.md)."
related:
  - /use-cases/what-breaks-if-you-delete-a-field
  - /how-to/find-what-is-updating-a-field
  - /how-to/pre-deployment-impact-review
  - /how-to/delete-picklist-value
section: blog
heading: "sf-intelligence 0.6.0: no new tools, more right answers, and a build that cannot go backwards"
intro: "0.5.0 cut the product down to what works. 0.6.0 makes what works more right: four kinds of metadata that silently never counted as use now do, two pairs of tools that disagreed now agree, and a scorecard in the build gate fails any change that makes an answer bigger or a verdict worse."
schemaType: Article
cta:
  question: "Where is Project__c.Risk_Score__c used?"
---
0.5.0 was about size: sixteen default tools instead of twenty-five, and answers that were mostly answer. 0.6.0 is about being right. Nothing was added. Every item either removed a second copy of a decision or made an existing answer more correct, and the build gate now measures both.

## 1. Four kinds of metadata that never counted as use

A "zero references" answer licenses a delete, so an element the extractor never reads is dangerous. Four of the largest were closed, each verified by re-extracting a real org and comparing counts against the previous release:

| What now counts as a reference | Measured on a real sandbox org |
|---|---|
| Fields on flow screens (dynamic forms), and components placed on screens | 16 new screen edges on a flow; one screen-only field found that had no reference before |
| Flow actions that are not Apex: email alerts, quick actions, external services, subflows called as actions | every such action is a reference to what it invokes |
| Field bindings in Lightning web component and Aura markup | no org on hand uses them with an object scope; verified to mint nothing when it cannot resolve the object |
| Related-list columns on Classic page layouts | fields with a layout reference 115 → 184 of 206; 11 fields no longer "definitely dead" |

The rule applied to all four, learned the hard way during the work: never build a component id by splitting a token on a dot. A flow screen's `objectFieldReference` starts with a variable name, not an object; a Classic related list is named `ChildObject.LookupField`, not a relationship. Each is resolved through what the metadata declares, and when it does not resolve, nothing is minted and the token is recorded on the node.

## 2. Two pairs of tools that disagreed now agree

The two save-order tools shared a 2,451-character disclosure byte for byte but only one carried the "this trigger may be switched off" warning; they now share one annotator. The two test-selection tools walked the graph differently; they now share one walk, with direct coverers and trigger-mediated candidates kept in separate tiers so the merge did not merge their blind spots. Coverage and health agreed on what the vault does not model. A security-audit question that bound an object id into an Apex-only tool now runs, and the argument it could not use is disclosed rather than dropped.

## 3. A build that cannot go backwards

Every problem the October review found had one shape: the project measured items closed and nothing measured the global cost. 0.6.0 adds a scorecard to the build gate, with 0.5.0 as the baseline:

| Measure | 0.5.0 | 0.6.0 |
|---|---|---|
| Default tools | 16 | 16 |
| Tool list on the wire | 18.5 KB | 18.5 KB |
| Median answer on the demo org | 8,294 bytes | 8,038 bytes |
| Allowlisted gate failures | 4 | 0 |
| "Keep in sync" comments in source | 626 | 626 |

A change that makes any number worse fails the build. The next release is expected to move the last row and the first.

## 4. For contributors

Twenty-three more extractor gaps are written up as self-contained jobs in `docs/contributing/extractor-gaps.md`, each with the file, the element, the edge to mint, the rule for the unresolvable case and the test to write, plus an issue template. The README now opens with what the tool answers and one cited demo answer instead of the architecture; and every public surface says the same thing about the license: MIT.

## Upgrading

```bash
npm install -g sf-intelligence@0.6.0
sfi refresh
```

The refresh is what makes the new references appear. Nothing else changes.
