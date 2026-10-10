---
title: "Which Flow or Trigger Is Updating This Salesforce Field?"
description: "Find which Flow, trigger or workflow field update is changing a Salesforce field, and which one sets it to a specific value. Manual methods and a faster way."
slug: /how-to/find-what-is-updating-a-field
targetQuery: "salesforce find which flow is updating a field"
persona: "Salesforce admins and developers debugging a field that changes on its own"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "How do I see which Flow updated a field in Salesforce?"
    a: "Field History shows when the value changed and whose save did it, but not which automation. To name the Flow, reproduce the save with a debug log running, or list every Flow, trigger and workflow field update that writes the field and narrow from there."
  - q: "Does 'Where is this used?' show which automation writes a field?"
    a: "Not directly. It lists components that reference a custom field, but it does not say which ones write to it, which value they write, or when they run. You still have to open each one."
  - q: "Can a Flow on another object change my field?"
    a: "Yes. A record-triggered Flow on a child object can update its parent record. That update runs the parent's own save, including its triggers and validation rules. These cross-object writers are the easiest ones to miss."
  - q: "Why does the field change when no automation sets that value?"
    a: "The change may come from something outside your org's metadata: an integration user, a data load, a managed package, or Apex that builds the value at runtime. Check the Last Modified By user and the time of the change first."
related:
  - /errors/maximum-trigger-depth-exceeded
  - /blog/salesforce-order-of-execution
  - /use-cases/where-is-a-field-used
  - /how-to/delete-picklist-value
  - /how-to/standard-field-where-used
section: how-to
heading: "Which Flow or trigger is updating this field, and which one sets it to X?"
answer: "Salesforce has no single screen that lists everything that writes to a field. Use Field History to learn when the value changed and whose save did it. Use a debug log to catch the automation in the act. Then list every Flow, trigger and workflow field update that can write the field, and keep only the ones that write the value you saw."
schemaType: HowTo
steps:
  - "Turn on Field History for the field (if it is not already on) and note the time and user of the change."
  - "Reproduce the change with a debug log running for that user."
  - "List every automation that writes the field, including automation on other objects."
  - "Narrow that list to the writers that set the exact value you saw."
  - "If nothing matches, look outside metadata: integrations, data loads and managed packages."
cta:
  question: "What sets Project Status to Complete?"
---
## The short version

1. Turn on Field History for the field (if it is not already on) and note the time and user of the change.
2. Reproduce the change with a debug log running for that user.
3. List every automation that writes the field, including automation on other objects.
4. Narrow that list to the writers that set the exact value you saw.
5. If nothing matches, look outside metadata: integrations, data loads and managed packages.

## Manual methods compared

| Method | What it tells you | What it misses |
|---|---|---|
| Field History Tracking | Old value, new value, date, and the user whose save made the change | Which Flow or trigger did it. Only covers changes after you turn it on, and only up to 20 fields per object by default |
| Debug log | The exact Flow, trigger and field update that ran in one save | You must reproduce the save. Logs are long, and trace flags expire |
| “Where is this used?” | Components that reference a custom field | Whether each one reads or writes, which value it writes, and when it runs |
| Search retrieved metadata | Every place the field name appears in Flow XML, Apex and workflow files | Writes made through a variable, and cross-object paths like a child Flow updating its parent |
| Setup, Workflow field updates | Legacy field updates that set the field | Flows, Apex and anything newer |

Salesforce documents the history limits in its [Field Audit Trail guide](https://developer.salesforce.com/docs/platform/field-history-retention/guide/field-audit-trail.html) and the button in [Find Where a Field Is Used](https://help.salesforce.com/s/articleView?id=sf.fields_references.htm&language=en_US&type=5).

## Why "Where is this used?" is not enough

The button answers "what mentions this field." Your question is "what changes this field, and to what." Those are different lists. A validation rule and a report both mention the field but never change it. A Flow on a child object can change it without appearing anywhere on the parent's setup pages.

It also cannot answer the value question. If Status keeps flipping to Complete, you need the writers that set Complete, not every component that touches Status.

## Step by step, by hand

### 1. Check Field History

Open a record where the change happened and look at the history related list. Write down the time, the old and new values, and the user. If the user is an integration user or an automated process user, skip ahead to step 5.

### 2. Catch it in a debug log

In Setup, open Debug Logs and add a trace flag for the user who makes the save. Repeat the action that triggers the change. In the log, search for the field's API name and for Flow and workflow entries. The order follows Salesforce's [order of execution](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm): before-save Flows, before triggers, validation rules, after triggers, workflow, then after-save Flows.

### 3. List every writer

Retrieve your automation and search it:

```bash
sf project retrieve start --metadata Flow ApexClass ApexTrigger Workflow
grep -rl "Status__c" force-app/main/default/flows force-app/main/default/classes force-app/main/default/triggers force-app/main/default/workflows
```

For each Flow hit, check that the Update Records or Create Records element targets the right object. Another object can have its own field called `Status__c`. Also check Flows on child objects that update their parent record.

### 4. Narrow to the value

In Flow XML, a literal write looks like `<stringValue>Complete</stringValue>` next to the field. Workflow field updates show the literal in Setup. Apex and Flow formulas often build the value at runtime, so you have to read the code.

### 5. Look outside metadata

Integrations, Data Loader jobs, managed packages and manual edits never show up in your Flow or Apex files. The Last Modified By user on the record is the fastest clue.

## With sf-intelligence

sf-intelligence reads your org's metadata once, keeps a copy on your computer, and lets your AI assistant answer from it. It never writes to the org. These examples are real answers from the built-in demo org, a solar installer called Verdant.

**Ask: "What writes Project Status?"** It finds two writers:

<div class="found-card">

**What it found**

- **`Installation_On_Complete`** (active Flow, runs in production) sets Project Status to Complete. It runs after an Installation is created or updated, when the Installation's Status is Completed.
- **`ProjectTriggerHandlerTest`** (Apex test class) writes the field too, but it is test-only and cannot run in production.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

From the `why_field_changed` tool (output trimmed):

```json
"writers": [
  { "id": "ApexClass:ProjectTriggerHandlerTest", "runnable": false, "status": "test-only" },
  { "id": "Flow:Installation_On_Complete", "runnable": true, "status": "Active",
    "assignedValues": ["Complete"], "operation": "recordUpdate",
    "conditional": { "expression": "Status__c EqualTo Completed" } }
]
```

</details>

So the only live writer is a Flow on a different object: when an Installation's status becomes Completed, it marks the parent Project Complete.

**Ask: "What sets Project Status to Complete?"** Passing a value splits the writers into three groups:

<div class="found-card">

**What it found**

- **Definitely sets Complete:** the `Installation_On_Complete` Flow, after an Installation is created or updated with Status Completed.
- **May set Complete:** `ProjectTriggerHandlerTest`. It is Apex, and the value Apex assigns is not captured, so read the code. It cannot run in production anyway.
- **Cannot set Complete:** none.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

```json
"valueFilter": {
  "value": "Complete",
  "definitelySets": [{ "id": "Flow:Installation_On_Complete", "runnable": true,
    "firesWhen": "after-save Flow on Installation__c create or update; entry criteria: Status__c EqualTo Completed" }],
  "maySet": [{ "id": "ApexClass:ProjectTriggerHandlerTest", "runnable": false,
    "why": "Apex write — the vault does not capture the value Apex assigns (read the code)" }],
  "cannotSet": []
}
```

</details>

**Ask: "What sets Project Status to Approved?"** Nothing in the org's automation does. The Flow is listed under “cannot set” because it only ever writes Complete. The answer also notes that every other writer cannot run in production. So Approved most likely comes from a person, an integration, a data load or a managed package.

If you ask about a value the field does not have, such as "Done", you get the real list back instead of a guess: "Declared values: Draft, Approved, Permitting, Installing, Complete, Cancelled."

### A catch the demo exposes

Asking the same question about Permit Approved returns no writers at all. That matters because the validation rule `Complete_Requires_Permit` blocks Status = Complete unless Permit Approved is checked. The Installation Flow updates the Project, which runs the Project's validation rules. So completing an Installation on a project without an approved permit fails, unless the Flow handles the error. Two questions surface it before a user hits the error.

## What it does not see

Every answer says what it could not check. The main gaps:

- Managed-package code and automation
- Apex that builds field names or values at runtime
- Integrations, API loads and data imports
- Manual edits by users

For Apex writers, it tells you the class writes the field but not the value. Open the code for those.
