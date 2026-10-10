---
title: "Is This Salesforce Deployment Risky? Pre-Deploy Review"
description: "Review a Salesforce deployment before you run it: deletions, changed Apex and flows, automation on touched objects and tests to run, from package.xml or git."
slug: /how-to/pre-deployment-impact-review
targetQuery: "salesforce impact analysis before deployment"
persona: "Salesforce release manager, architect or developer about to deploy a change set or pull request"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "Isn't a validation deploy enough?"
    a: "It is necessary, not sufficient. A validation deploy proves the metadata compiles and the tests you chose pass. It does not tell you which flows, formulas or reports depend on what you changed, or which behavior will differ after the deploy."
  - q: "What makes a deployment a no-go?"
    a: "Deleting something another component depends on, or deleting an active trigger, record-triggered flow or validation rule that runs on every save. Fix the dependents first, or split the change."
  - q: "Can I review a git pull request instead of a package.xml?"
    a: "Yes. The list of changed files from git diff --name-status works as input. Lines starting with D are treated as deletions. Files that are not Salesforce metadata, such as a README, are listed and skipped."
  - q: "Which tests should I run?"
    a: "The tests that reach the Apex you changed. Run them with RunSpecifiedTests in a validation deploy. Production deploys still have to meet Salesforce's own test and coverage rules."
  - q: "Does the review use my latest org state?"
    a: "It uses the metadata as of your last refresh. Refresh right before a release review so the comparison is against what is actually deployed."
related:
  - /errors/maximum-trigger-depth-exceeded
  - /use-cases/what-breaks-if-you-delete-a-field
  - /use-cases/impact-analysis
  - /setup/vs-code-copilot
  - /compare/salesforce-mcp-servers
section: how-to
heading: "Is this Salesforce deployment risky? A pre-deployment impact review from package.xml or git diff"
answer: "A deployment is risky when it deletes something other components still use, changes code or automation that other parts of the org call, or touches an object where several automations already write the same fields. Review every changed component for what depends on it, list the tests that reach it, and do not call it safe while anything is unchecked."
schemaType: HowTo
steps:
  - "Get the change list. Use the shape you already have: a package.xml plus destructiveChanges.xml for deletions, the changed files from git diff --name-status, or a plain list of components marked added, modified or deleted."
  - "Mark the deletions. Deletions carry the most risk. Treat a renamed component as a deletion plus an addition."
  - "For each deletion, list what depends on it. Any dependent means the change is not ready."
  - "For each modified component, list its callers. Apex classes, triggers, flows and formulas that use it."
  - "Check the automation on each touched object. Look for two automations writing the same field, and for anything that saves the record again."
  - "Select the tests. Find the test classes that reach the changed Apex. Run them with --test-level RunSpecifiedTests --tests ... in a validation deploy."
  - "Check access for new fields and objects. Confirm a permission set grants each one."
  - "Write down what you could not check. Unresolved names, wildcard members (*) and metadata types you cannot inspect all keep the answer at \"review first\"."
cta:
  question: "Is this deployment risky?"
---
## What a pre-deployment review must cover

| Check | Why it matters | Native way to check |
|---|---|---|
| Deleted components | A field, class or flow that something still uses breaks it, or the deploy fails | “Where is this used?” on custom fields, the Dependency API |
| Modified Apex and flows | Callers and automation that rely on the old behavior can break | Read the callers by hand |
| Active automation being deleted or turned off | A trigger, record-triggered flow or validation rule runs on every save, even though nothing "references" it | Object Manager, Flow Trigger Explorer |
| Automation on the touched objects | Two automations writing the same field, or a save loop | Order of execution review, debug logs |
| Tests to run | You need the tests that exercise the changed code | Naming conventions, code search |
| Access for new fields | A new field that no profile or permission set grants is hidden from every user | Permission set review |
| Anything you could not check | An unchecked item is a risk you have not sized | Your own notes |

## The native tools, and what they leave out

**Validation deploy.** The Salesforce CLI command `sf project deploy validate` checks that a deployment would succeed without deploying it. It requires Apex tests, and it returns a job ID you can pass to `sf project deploy quick` within 10 days. Its help text says it is meant for production orgs. For a sandbox, it suggests `sf project deploy start --dry-run --test-level RunLocalTests`. Test levels are `RunAllTestsInOrg`, `RunLocalTests`, `RunSpecifiedTests` and `RunRelevantTests` (beta). Destructive manifests go in with `--pre-destructive-changes` or `--post-destructive-changes`.

A validation proves the change compiles and the chosen tests pass. It does not list what depends on what you changed. Compiling also does not check a field named inside a dynamic SOQL string. That fails only when the code runs, and only if a test happens to run it.

**Dependency API.** The Tooling API object [MetadataComponentDependency](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_metadatacomponentdependency.htm) lists dependencies between components. Salesforce's Tooling API guide (Winter '27) still labels it Beta and "for evaluation purposes only, not for production use". A Tooling API query returns at most 2,000 records and leaves out reports. Bulk API 2.0 raises that to 100,000 records and includes reports.

**By hand.** Open each flow and trigger on each touched object. This works for small changes. It does not scale to a 40-file pull request.

## Step by step

1. **Get the change list.** Use the shape you already have:
   - a `package.xml`, plus `destructiveChanges.xml` for deletions,
   - the changed files from `git diff --name-status main...HEAD`,
   - or a plain list of components, with "added", "modified" or "deleted" for each.
2. **Mark the deletions.** Deletions carry the most risk. Treat a renamed component as a deletion plus an addition.
3. **For each deletion, list what depends on it.** Any dependent means the change is not ready.
4. **For each modified component, list its callers.** Apex classes, triggers, flows and formulas that use it.
5. **Check the automation on each touched object.** Look for two automations writing the same field, and for anything that saves the record again.
6. **Select the tests.** Find the test classes that reach the changed Apex. Run them with `--test-level RunSpecifiedTests --tests ...` in a validation deploy.
7. **Check access for new fields and objects.** Confirm a permission set grants each one.
8. **Write down what you could not check.** Unresolved names, wildcard members (`*`) and metadata types you cannot inspect all keep the answer at "review first".

## How go, review first and no-go are decided

| Decision | When | What to do |
|---|---|---|
| **No-go** | A deleted component still has dependents. Or an active trigger, record-triggered flow or validation rule is being deleted. | Remove or update the dependents first, or split the deletion into a later release. |
| **Review first** | A modified component has callers. Or something could not be checked: a name that did not match, a wildcard, an uncovered metadata type, unknown test coverage, or new Apex no test reaches. | Look at each listed item. Run the selected tests. |
| **Go** | Every change is safe within what was checked, and nothing was left unchecked. | Still run the selected tests. The check reflects the last refresh. |

The rule that matters most: **never "go" while anything in the change set was left unreviewed.** A short list of problems is only good news if the list is complete.

## With sf-intelligence

sf-intelligence runs this review on your computer, from the metadata it retrieved from your org. Ask your AI assistant: *"Is this deployment risky?"* and paste the `package.xml` and `destructiveChanges.xml`, or the `git diff --name-status` output. The assistant runs the `review_change` analysis.

Here is a real review on Verdant, the built-in demo org. The change set modifies an Apex class and a flow, and deletes a field:

```xml
<!-- package.xml -->
<types><members>ProjectTriggerHandler</members><name>ApexClass</name></types>
<types><members>Installation_On_Complete</members><name>Flow</name></types>

<!-- destructiveChanges.xml -->
<types><members>Invoice__c.Amount__c</members><name>CustomField</name></types>
```

The decision is **no-go**. Here is why:

<div class="found-card">

**What it found**

- **Deleting `Invoice__c.Amount__c` blocks the release.** An Apex class, a formula field and a roll-up on Project all use it.
- **The trigger handler change is risky.** `ProjectTrigger` calls it. Two test classes were selected for it, so run those.
- **The flow needs a manual look.** Nothing references it, but the review says plainly that Lightning pages, quick actions and components were not fully retrieved, so "no dependents" is "not checked" there.
- **Automation on the touched objects** (Installation and Invoice) was checked. No field has two writers and no save loop was found.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

From the `review_change` tool (trimmed, not edited):

```json
"deployDecision": {
  "decision": "no-go",
  "reasons": [
    "1 blocking change(s): CustomField:Invoice__c.Amount__c (3 dependent(s))",
    "1 risky change(s) with firm dependents: ApexClass:ProjectTriggerHandler",
    "1 change(s) need manual review"
  ]
},
"reviewed": [
  { "id": "CustomField:Invoice__c.Amount__c", "changeKind": "deleted", "verdict": "blocking",
    "dependents": ["ApexClass:PaymentService", "CustomField:Invoice__c.Balance__c",
                   "CustomField:Project__c.Total_Invoiced__c"] },
  { "id": "ApexClass:ProjectTriggerHandler", "changeKind": "modified", "verdict": "risky",
    "dependents": ["ApexTrigger:ProjectTrigger"], "testCoverage": "covered",
    "selectedTests": ["ApexClass:PaymentServiceTest", "ApexClass:ProjectTriggerHandlerTest"] },
  { "id": "Flow:Installation_On_Complete", "changeKind": "modified", "verdict": "review" }
]
```

</details>

The same change as git paths gives the same decision. It also lists `README.md` as skipped, because it is not metadata:

```text
D	force-app/main/default/objects/Invoice__c/fields/Amount__c.field-meta.xml
M	force-app/main/default/classes/ProjectTriggerHandler.cls
M	README.md
```

Two more real results from the demo org:

- **A list of names with no change kind** gives `review-first`, with the reason that it was "reviewed as 'modified' because no change kind was given". A deletion in that list would be under-called, so say which items are deletions.
- **Adding a new field** gives `go`. With the access check turned on, the same answer also warns that the field "would deploy with access to NOBODY", because no permission set grants it. The decision stays `go`, so read the access warning too.

What it does not cover: changes made in the org since your last refresh, code inside managed packages, and fields named in string-built dynamic SOQL. It selects tests. It does not prove they test the right thing. The same review can also run in CI as a GitHub Action.
