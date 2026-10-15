---
title: "sf-intelligence 0.5.0: Sixteen Tools, Shorter Answers, MIT"
description: "sf-intelligence 0.5.0: 16 default tools instead of 25, far less fixed text in every answer, two wrong verdicts fixed on a real org, and a plain MIT license."
slug: /blog/sf-intelligence-0-5-0
targetQuery: "sf-intelligence 0.5.0 release salesforce mcp"
persona: "Salesforce admins, developers and architects who use Claude, Cursor or VS Code with their org"
datePublished: 2026-10-15
dateModified: 2026-10-15
faq:
  - q: "Do I need to do anything after upgrading to 0.5.0?"
    a: "No. Upgrade the package and restart your MCP client. A vault built by 0.4.0 keeps working; run a normal refresh when you want the new dead-code evidence, because custom-metadata records are read at refresh time."
  - q: "Why does my assistant see fewer tools now?"
    a: "By default it sees 16 instead of 25: the eight it needs to find its way around, and the eight that answer the questions on the package page. The other tools are still there through sfi.run_analysis, and SFI_TOOL_PROFILE=full shows all of them."
  - q: "Where did the long warning at the top of every answer go?"
    a: "It is one sentence now: which version built the vault, which version is running, how old the vault is, and the command to refresh. The full list of what newer versions add is on sfi.health_check."
  - q: "What changed in the dead-code answer?"
    a: "Two things. A class that only test classes call is now checked against the Apex source before it is called likely dead. And a custom-metadata record that names a class in a Class, Handler or ClassName field now counts as a reference to that class, so a handler wired through configuration is no longer reported dead."
  - q: "Is sf-intelligence open source now?"
    a: "Yes. 0.5.0 is licensed under the plain MIT license. Earlier releases carried a Commons Clause condition that forbade selling the software; it is gone."
  - q: "Where is the full list of changes?"
    a: "In the [CHANGELOG on GitHub](https://github.com/PranavNagrecha/Salesforce-Intelligence/blob/main/CHANGELOG.md)."
related:
  - /use-cases/what-breaks-if-you-delete-a-field
  - /how-to/find-what-is-updating-a-field
  - /how-to/pre-deployment-impact-review
  - /how-to/delete-picklist-value
section: blog
heading: "sf-intelligence 0.5.0: fewer tools, shorter answers, two real-org fixes, and MIT"
intro: "An outside reviewer installed 0.4.0 on a real production org and checked every answer by hand. The engine was right. The layer around it was too big and, twice, too confident. 0.5.0 is the response: a smaller default tool list, far less fixed text in each answer, the two wrong verdicts fixed, and a plain MIT license."
schemaType: Article
cta:
  question: "Which Apex is dead in this org?"
---
In early October an independent reviewer installed sf-intelligence from npm the way a stranger would, rebuilt a vault from a real production org of about 4,700 components, and checked every answer against the raw metadata. Where-used was right. Save order was right. Nine of nine classes called definitely dead were dead. Two answers were wrong, and the tool list and the answers were much bigger than they needed to be. This release fixes what the review found. The numbers below were measured on the built-in demo org and on the reviewer's org, with no names from that org in this post.

## 1. Sixteen tools by default, not twenty-five

Your AI host reads the tool list once per session, before your first question. In 0.4.0 the default list had 25 tools, and thirteen of them were plumbing: routing, synthesis, catalogs, an org card. The three tools the reviewer verified on the real org, where-used, dead code and the flow graph, were not on the list at all.

0.5.0 advertises 16 tools:

| Kind | Tools |
|---|---|
| Finding your way | resolve a name, search components, get a component, health check, list and describe analyses, run an analysis, live consent |
| Answering the advertised questions | where is this field used, what breaks if I delete it, what happens when I save, which Apex is dead, why can't this user see this record, who can edit this field, how does this flow work, give me a tour of this org |

The list is 20 KB on the wire, down from 33 KB. Every other tool is one call away through `sfi.run_analysis`, with identical output, and `SFI_TOOL_PROFILE=full` shows them all.

## 2. Answers that are mostly answer

The reviewer's phrase was "answers buried in caveats": a field with two references came back as twelve kilobytes. Three causes, three fixes.

- **The freshness warning.** Every answer from a vault older than the running version carried about 1,050 bytes listing every edge family added since. It is now one sentence of 94 bytes: built by, running, age, and the refresh command. The full list moved to `sfi.health_check`.
- **Concept reasoning.** Four high-traffic tools attached about five kilobytes of rule-based claims and their nested confidence blocks by default. They are now opt-in with `includeConceptReasoning: true`; the default answer says the block is available.
- **Descriptions.** The three newly listed tools had descriptions of about five kilobytes each, written as specifications. They are now contracts of about one kilobyte; the long form stays behind `sfi.describe_analysis` with `detail: 'full'`.

## 3. Two wrong verdicts, fixed

**A live class reported as likely dead.** The reviewer's org has an integration class that no Apex calls directly. A custom-metadata record names it, and a factory runs it by reflection. 0.4.0 said "likely dead, test-only". An admin who trusted that row could have deleted live code. Two changes in 0.5.0: a class reached only from tests is now checked against the Apex source before it is called likely dead, the same check that already protected the definitely-dead verdict; and a custom-metadata value whose field name ends in `Class__c`, `ClassName__c`, `Handler__c`, `HandlerClass__c` or `ApexClass__c` now counts as a reference to that class. On the reviewer's org the counts moved from 10 definitely dead, 3 likely dead and 79 uncertain to 9, 2 and 81. The class in question reads "uncertain, confirm the registration before deleting", which is the honest answer.

**A page launched only by a quick action looked unused.** Quick actions of the Visualforce type recorded their page under the wrong id prefix, so the reference never matched the page. Fixed; a test now asserts the correct prefix.

Six tools also had caveats that claimed blind spots the extractors already cover, such as workflow email alerts or static resources. Those caveats now say only what is true.

## 4. Plain MIT

sf-intelligence is now licensed under the MIT license. The Commons Clause condition that earlier releases carried, which forbade selling the software, is removed. Use it at work, on client orgs, in a product, in a service.

## 5. For contributors

`pnpm test` builds first, so a fresh clone no longer fails with stale build output. `CONTRIBUTING.md` names the real registration path for a tool and lists every file one touches. The privacy guard fails closed locally when the org blocklist is missing, instead of passing without checking.

## Upgrading

```bash
npm install -g sf-intelligence@0.5.0
```

Restart your MCP client. Nothing else is required. Run a normal `sfi refresh` when you want the custom-metadata references in dead-code answers; they are read at refresh time.
