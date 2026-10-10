---
title: "sf-intelligence 0.4.0: Is This Salesforce Deployment Risky?"
description: "sf-intelligence 0.4.0 answers four new questions: is this deployment risky, what sets a field to X, why a flow runs twice, and how to explain an object."
slug: /blog/sf-intelligence-0-4-0
targetQuery: "sf-intelligence salesforce deployment risk review ai"
persona: "Salesforce admins, developers and architects who use Claude, Cursor or VS Code with their org"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "Do I need to do anything after upgrading to 0.4.0?"
    a: "Run one normal refresh (sfi refresh) against your org. A vault built by 0.3.3 has no saved copy of the org's standard-field list, so an offline-only refresh would drop fields like Account.BillingCity until you do."
  - q: "Does sf-intelligence 0.4.0 write anything to my Salesforce org?"
    a: "No. It reads metadata during a refresh and answers every question from a copy on your computer. Nothing in 0.4.0 changes that. An offline refresh (--no-pull) now contacts the org zero times."
  - q: "Can I paste a package.xml or git diff and get a go / no-go?"
    a: "Yes. Paste a package.xml, a destructiveChanges.xml, a list of changed files, or git diff --name-status output. You get no-go, review-first or go, with the reasons. It never says go while part of the change set was not checked."
  - q: "Will my AI host behave differently after the upgrade?"
    a: "It should answer faster and use less of its context, because the tool list it reads at start-up is about 70% smaller. The answers it gets back are the same as before. Only scripts that read the MCP structuredContent field need a change."
  - q: "Can I try 0.4.0 without connecting a Salesforce org?"
    a: "Yes. Run npx -y sf-intelligence demo. It serves a built-in demo org for a solar company with projects, invoices, permits and installations. No login and no Salesforce CLI needed."
  - q: "Where is the full list of changes?"
    a: "In the [CHANGELOG on GitHub](https://github.com/PranavNagrecha/Salesforce-Intelligence/blob/main/CHANGELOG.md)."
related:
  - /how-to/pre-deployment-impact-review
  - /how-to/find-what-is-updating-a-field
  - /errors/maximum-trigger-depth-exceeded
  - /how-to/delete-picklist-value
  - /use-cases/what-breaks-if-you-delete-a-field
section: blog
heading: "sf-intelligence 0.4.0: four new questions your AI can answer about your org"
intro: "sf-intelligence 0.4.0 lets Claude, Cursor or VS Code answer four new questions about your Salesforce org: is this deployment risky, what sets this field to a value, why did my flow run twice, and explain this object to a new hire. Your AI also reads about 70% less at start-up. It is still free, read-only and offline."
schemaType: Article
cta:
  question: "Is it risky to delete Project__c.Risk_Score__c?"
---
Every example below is real output from the built-in demo org, a solar installer called Verdant. We trimmed long responses. We did not change any values.

## 1. "Is this deployment risky?"

Paste what you have: a `package.xml`, a `destructiveChanges.xml`, a list of changed files, or `git diff --name-status` output. You get **go**, **review-first** or **no-go**, the reasons, and the tests to run.

**You paste:**

```text
M  force-app/main/default/classes/ProjectTriggerHandler.cls
D  force-app/main/default/objects/Project__c/fields/Risk_Score__c.field-meta.xml
A  force-app/main/default/classes/NewHelper.cls
M  README.md
```

**The answer (demo org):** **no-go**.

| Change | Verdict | Why |
|---|---|---|
| Delete `Project__c.Risk_Score__c` | blocking | Used by `ProjectTriggerHandler`, its test class and the Residential layout |
| Edit `ProjectTriggerHandler` | risky | `ProjectTrigger` calls it. Two tests cover it. |
| Add `NewHelper` | safe to add, but untested | Nothing depends on it yet. No existing test reaches it. |

Run `PaymentServiceTest` and `ProjectTriggerHandlerTest`. `README.md` was not reviewed, because it is not metadata.

<details class="tool-call">
<summary>For developers: the raw answer</summary>

```text
decision: no-go
reasons:
  - 1 blocking change(s): CustomField:Project__c.Risk_Score__c (3 dependent(s))
  - 1 risky change(s) with firm dependents: ApexClass:ProjectTriggerHandler
  - 1 added Apex class(es)/trigger(s) reached by no test the vault knows
    (ApexClass:NewHelper) ... a production deploy needs every trigger
    covered and 75% overall
tests to run: PaymentServiceTest, ProjectTriggerHandlerTest
not reviewed: README.md
```

</details>

It is never **go** while part of the change set was left unchecked, such as a name it could not match or a wildcard. The coverage rule (75% overall, every trigger tested) is from Salesforce's [Understanding Testing in Apex](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_testing_intro.htm). Deletions read the standard [destructiveChanges.xml](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_deploy_deleting_files.htm) format.

## 2. "What sets Project Status to Complete?"

Now you can name the value. Each writer lands in one group: definitely sets it, may set it, or cannot set it.

**You ask:** what sets Status on Project to Complete?

<div class="found-card">

**What it found**

- **Definitely sets it:** the `Installation_On_Complete` Flow. It runs after an Installation is created or updated, when the Installation's Status is Completed.
- **May set it:** `ProjectTriggerHandlerTest`, an Apex test class that can't run in production. The value Apex assigns is not captured, so the answer tells you to read the code.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

```text
definitelySets:
  Flow:Installation_On_Complete
  firesWhen: after-save Flow on Installation__c create or update;
             entry criteria: Status__c EqualTo Completed
maySet:
  ApexClass:ProjectTriggerHandlerTest (runnable: false)
  why: Apex write — the vault does not capture the value Apex assigns
```

</details>

So a project is set to Complete when its installation is marked Completed. The test class is marked not runnable, because data a test creates or changes is never saved ([Testing Apex](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_testing.htm)).

**Ask about "Approved" instead** and nothing definitely sets it. The installation flow moves to “cannot set”, because it only ever writes "Complete". No running automation the tool can see sets Approved. If records still end up Approved, look at people, integrations and data loads. The answer says an empty list is not proof and names what it can't see: managed packages, dynamic Apex, integrations and manual edits.

## 3. "Why did my flow run twice?"

Save-order answers now list the steps that write back to the record being saved, and quote the Salesforce rule for what runs again. The answer also names what it can't follow, such as changes made inside subflows.

**You ask:** what happens when an Opportunity is updated, and does anything run twice?

<div class="found-card">

**What it found**

- **One step writes back to the Opportunity:** the `High_Value_Flag` workflow rule (when Amount > 100000) updates Description.
- **Salesforce's rule for that case:** the record is updated again and before-update and after-update triggers run one more time. Custom validation rules, flows, duplicate rules, processes and escalation rules do not run again.
- **No Opportunity triggers exist** in the demo org, so nothing runs a second time.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

```text
writeBacks:
  WorkflowRule:Opportunity.High_Value_Flag  (when Amount > 100000)
  mechanism: workflow-field-update   fields: Description
rule: if workflow field updates change the record, it is updated again,
  system validations re-run, and before-update and after-update triggers
  run one more time (only once) ... Custom validation rules, flows,
  duplicate rules, processes and escalation rules do not run again.
rerunOnUpdate: triggers: []
```

</details>

The rule is quoted from Salesforce's [Triggers and Order of Execution](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm).

The answer also lists saves that spill onto other records. Ask the same question about an Installation and you see that its flow updates the parent Project, where 2 more active automations run.

## 4. "Explain the Project object to a new hire"

You get one page in Markdown: key fields, picklist values, record types, parents and children, what runs on save, who has access, and risk signals. Two sections from the demo org's Project page:

<div class="found-card">

**What runs when a record is saved** (4 active components in 5 steps, in order)

- **Before triggers:** `ProjectTrigger`, on insert and update.
- **Validation rules:** `Complete_Requires_Permit`, on insert and update. It blocks with "You cannot set Status to Complete until the permit is approved (Permit Approved must be checked)."
- *The record is written to the database.*
- **After triggers:** `ProjectTrigger`, on update.
- **After-save flows:** `Project_On_Approve`, on insert and update.
- **Approval processes:** `Project__c.Discount_Approval`, on insert and update.

**Risk signals** (2)

- 1 active validation rule can block a save. Its message is listed above.
- 11 of 11 custom fields have neither a description nor help text.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

The same two sections as the tool returns them:

```text
## What runs when a record is saved (4 active component(s) in 5 step(s), in order)
- **Before triggers** (1): `ProjectTrigger` [insert+update]
- **Validation rules** (1): `Complete_Requires_Permit` [insert+update] — blocks with
  "You cannot set Status to Complete until the permit is approved
  (Permit Approved must be checked)."
- — the record is written to the database —
- **After triggers** (1): `ProjectTrigger` [update]
- **After-save flows** (1): `Project_On_Approve` [insert+update]
- **Approval processes** (1): `Project__c.Discount_Approval` [insert+update]

## Risk signals (2)
- 1 active validation rule(s) can block a save — their messages are listed above.
- 11 of 11 custom field(s) have neither a description nor help text.
```

</details>

## Your AI reads about 70% less to get started

When your AI client starts the server, it reads the tool list first. In 0.4.0 the 25 main tools say what they answer, what they need and when to use another tool. The full manual is fetched only when needed.

| Measure | 0.3.3 | 0.4.0 |
|---|---|---|
| Tool list on a real org | 116 KB | 33.6 KB |
| Tool list on the demo org (we measured) | 112 KB | 34 KB |
| Server instructions | 4.7 KB | 3.0 KB |

That leaves more room in the conversation for your org's answers. Each answer the server sends back is also half the size, because it no longer carries a second copy of the same data.

## What got more accurate

**Delete safety**
- A field name inside a dynamic SOQL string or an OmniStudio path now moves "safe" to "review", with the file and line.
- Every check is listed as found, none found or not checked, so "didn't look" never reads as "found nothing".
- Reports that filter or sort on the field, sharing rule criteria and a validation rule's error field now count as uses.
- An Apex reference now blocks the delete, because Salesforce won't delete a field that Apex code uses ([Validating sObjects and Fields](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/langCon_apex_SObjects_field_validation.htm)). Running OmniStudio components count as blockers too, because they would break.

**Who changes a field**
- Each writer shows the value it sets.
- A flow that writes `Status__c` on Task is no longer reported as a writer of the Case field.
- Rollups from Declarative Lookup Rollup Summaries (DLRS), time-based workflow updates and approval-step updates now count as writers.

**Save order**
- Flows that only run on a scheduled path are no longer listed as part of the save.
- Trigger answers now follow the handler class up to 3 calls deep and list its field writes.
- Inactive automations are named, not just counted.
- A long list of validation rules no longer pushes triggers and after-save flows out of the answer.

**Permissions**
- "Who can edit Project?" returns one row per profile or permission set. It also says who it left out. On the demo org, 2 read-only profiles.
- A profile with field Edit but only object Read is no longer called an editor.
- View All or Modify All held through an external or guest license is now rated critical and listed first.

**Picking the right tool**
- Questions like "remove 'Approved' from the Status picklist" or "who can see the Invoice object" go to the right tool the first time, with the inputs filled in.

## Upgrade notes

1. **Update the package.** If you installed it globally, run `npm install -g sf-intelligence@latest`. If your AI client starts it with `npx`, restart the client. `npx` can keep using a copy it saved earlier, so if you still get 0.3.3 answers, change the package in that command to `sf-intelligence@latest`.
2. **Refresh your vault once, with a pull.** Run this in your Salesforce project:

   ```bash
   sfi refresh
   ```

   No global install? Run `npx -y sf-intelligence@latest refresh` instead. Until you do this once, an offline refresh drops standard fields such as `Account.BillingCity`. The pull also picks up new references, like report filters.
3. **Offline refresh is now fully offline.** `sfi refresh --no-pull` no longer contacts the org at all.
4. **For scripts only.** Responses no longer include `structuredContent`, and tools no longer declare an `outputSchema`. Read the same JSON from `content[0].text`. Claude, Cursor and VS Code need no change.
