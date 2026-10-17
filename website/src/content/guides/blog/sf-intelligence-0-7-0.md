---
title: "sf-intelligence 0.7.0: Finish the Review"
description: "sf-intelligence 0.7.0 adds no tools: OmniScript save patterns count as field writes, Flow screen components link to real components, and the demo org shows its work."
slug: /blog/sf-intelligence-0-7-0
targetQuery: "sf-intelligence 0.7.0 release notes"
persona: "Salesforce admins, developers and architects who use Claude, Cursor or VS Code with their org"
datePublished: 2026-11-03
dateModified: 2026-11-03
faq:
  - q: "Do I need to refresh my vault after upgrading to 0.7.0?"
    a: "Once, if your org uses OmniStudio save-for-later or Flow screen components. Both new references are read at refresh time. Orgs without either see no change in their answers."
  - q: "What was wrong with Flow screen components before 0.7.0?"
    a: "0.6.0 added a reference from a Flow screen to the Lightning web component placed on it, but kept the component's c: namespace prefix in the id. The reference pointed at an id no component had, so a component used only on a screen still showed zero usages. 0.7.0 builds the id the same way the component extractor does."
  - q: "Were any tools added?"
    a: "No. 0.7.0 adds no tools and no new way to ask anything. Every change closes a defect a user or reviewer could see, or a gap in the build itself."
  - q: "Does the field-audit command need the two agents?"
    a: "Not any more. It checks whether they are installed and otherwise runs the audit and the three refutation passes inline, telling you once. Copying the two agent files from the repository into your project restores the parallel path."
  - q: "Where is the full list of changes?"
    a: "In the [CHANGELOG on GitHub](https://github.com/PranavNagrecha/Salesforce-Intelligence/blob/main/CHANGELOG.md)."
related:
  - /use-cases/what-breaks-if-you-delete-a-field
  - /how-to/find-what-is-updating-a-field
  - /how-to/pre-deployment-impact-review
  - /blog/sf-intelligence-0-6-0
section: blog
heading: "sf-intelligence 0.7.0: the last review finding closed, one dangling reference found and fixed, and a demo org that shows its work"
intro: "An external review in October found two wrong verdicts on a real org. 0.5.0 fixed the first; 0.7.0 fixes the second, OmniScript save-for-later patterns that never counted as field writes. Rebuilding the demo org with current code exposed a reference 0.6.0 had been minting into thin air; that is fixed too. No new tools."
schemaType: Article
cta:
  question: "Where is Project__c.Expected_Completion__c used?"
---
0.6.0 made four kinds of metadata count as use and put a scorecard in the build. 0.7.0 finishes what the October review started and cleans up what the first real rebuild of the demo org revealed. Nothing was added. Each item closes something a person could see.

## 1. OmniScript save-for-later patterns are field writes

An OmniScript with save-for-later enabled declares `saveURLPatterns` in its settings: each key is a field on the object the script saves to, and the value is the URL pattern filled from it. Before 0.7.0 those fields had no reference from the script, so a where-used or safe-to-delete answer for one of them could say "nothing uses this" while a live script wrote it on every save. This was the second of the two verdict defects the external reviewer found in October.

Now each pattern key that names a field on the declared save object becomes a `writesTo` reference from the script to that field. When a script declares patterns but no save object, nothing is guessed: the patterns are listed on the script as unresolved, with the reason. On the real OmniStudio sandbox used to verify this, two scripts carry non-empty patterns and neither declares a save object, so both now show the disclosure and neither invented an edge; the resolved path is proven on the bundled fixtures.

## 2. Flow screen components reference the component that exists

0.6.0 added a `references` edge from a Flow screen to the Lightning web component placed on it. Rebuilding the demo org with current code showed the edge pointing at `LightningComponentBundle:c:projectSummaryCard` while the component's own id is `LightningComponentBundle:projectSummaryCard`. The `c:` default-namespace prefix had been kept, the id matched nothing, and a component used only on a Flow screen still showed zero usages. Both extractors now build the bundle id through one helper, so the two cannot drift apart again, and the demo org's truth file pins the edge.

## 3. The field audit runs without its agents

`/sfi-field-audit` used to spawn two agents that the plugin does not ship. From 0.7.0 the command's first step is to check whether they are available; without them it runs the per-field audit and the three refutation lenses (data loss, hidden dependency, future need) itself, one pass after another, and says so once. The method and the output are the same; only the parallelism is lost. The two maintainer-only agents moved to their own folder so a future decision to ship agents ships only the two that matter.

## 4. A demo org that shows its work

The bundled demo org (Verdant Energy, a fictional residential solar installer) had none of the metadata 0.6.0 learned to read, so neither the website nor a first-run user could see those answers. It now has a screen flow with object-provided fields, a component with `lightning-record-form` bindings and a layout related list with column fields, and three demo questions whose answers cite them:

| Ask | The answer cites |
|---|---|
| Where is `Project__c.Expected_Completion__c` used? | the Residential layout and the `Project_Site_Survey` screen flow |
| Which components show `Project__c.Utility_Provider__c` on a form? | only the `projectSummaryCard` component |
| What shows Installation fields on the Project page? | the Residential layout's Installations related list, two columns |

The tracked demo vault had last been rebuilt in June with 0.1.12. It is now built with the current code, so what you see in `sfi demo` is what the current extractors produce.

## 5. Smaller things that were wrong

The 0.6.0 release report was linked from the docs index but never published: a years-old ignore rule kept release reports out of the repository. The rule is gone, the 0.5.0 and 0.6.0 reports are in, and the build now fails on any relative link in the public docs that points at nothing. Nested `sfi <command> <subcommand> --help` turned out to work already; a test keeps it that way. About 2,700 internal planning labels left the code comments and test names. The host guide and the README cover Cline.

## Upgrading

```bash
npm install -g sf-intelligence@0.7.0
sfi refresh
```

The refresh matters only if your org uses OmniStudio save-for-later or Flow screen components. Nothing else changes; there is no envelope or argument change in this release.
