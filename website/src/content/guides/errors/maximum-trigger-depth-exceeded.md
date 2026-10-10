---
title: "Maximum Trigger Depth Exceeded in Salesforce: Find the Loop"
description: "What 'maximum trigger depth exceeded' means, which saves Salesforce runs again, and how to find the trigger, flow or field update writing back to the record."
slug: /errors/maximum-trigger-depth-exceeded
targetQuery: "maximum trigger depth exceeded salesforce"
persona: "Salesforce developer or admin debugging a save that fails or a flow that runs twice"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "What is the trigger depth limit in Salesforce?"
    a: "16. Salesforce's governor limits set the total stack depth for any Apex invocation that recursively fires triggers through insert, update or delete statements at 16. Each save that fires a trigger from inside another trigger's save adds one level."
  - q: "Can a workflow field update cause an endless loop?"
    a: "Not on its own. When a workflow field update changes the record, Salesforce runs the before update and after update triggers one more time, and only one more time. Deep loops almost always involve Apex DML or a flow that updates records."
  - q: "Why does my before-save flow run twice?"
    a: "Something later in the same save did DML on the record, usually an after-save flow or Apex in an after trigger. Salesforce sends that record through the save again, and before-save flows, before triggers, validation rules and after triggers run again."
  - q: "Is a static Boolean recursion guard enough?"
    a: "It stops re-entry, but it can also skip work you wanted. A Boolean set on the first run is still set for later trigger runs in the same transaction. Tracking the record Ids you already processed, or comparing old and new values, is safer."
  - q: "Can I find the loop without a debug log?"
    a: "You can find the candidates by listing every automation that writes back to the object being saved. A debug log then confirms which one actually fires for a given record, because entry conditions depend on the data."
related:
  - /how-to/find-what-is-updating-a-field
  - /blog/salesforce-order-of-execution
  - /how-to/pre-deployment-impact-review
  - /use-cases/explain-a-salesforce-flow
section: errors
heading: "Maximum trigger depth exceeded: how to find the save loop"
answer: "\"Maximum trigger depth exceeded\" means one save kept causing another save until Apex hit its limit of 16 nested trigger runs. Somewhere in the chain, an automation writes back to a record that is already being saved. Find that write. Then remove it, move it into a before-save step, or stop it from running when nothing changed."
schemaType: TechArticle
cta:
  question: "What happens when I save an Installation?"
---
## What the error looks like

The message usually arrives inside a DML error. A typical form is:

```text
CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, AccountTrigger: maximum trigger depth exceeded
```

The trigger named before the colon is where the limit was reached. It is not always where the loop starts.

Some loops that run through flows report a different message, `MAX_DEPTH_IN_FLOW_EXECUTION: Maximum flow depth exceeded` ([reported in the Trailblazer Community](https://trailhead.salesforce.com/trailblazer-community/feed/0D54V00007T4U89SAF)). The cause and the fixes on this page are the same.

## Why it happens: Salesforce's re-run rules

Salesforce counts nested trigger runs. Its [Execution Governors and Limits](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm) page sets the "total stack depth for any Apex invocation that recursively fires triggers due to insert, update, or delete statements" at 16. The same page explains why: a trigger fired by DML starts a new Apex invocation, which costs more than a normal method call.

So the question is always: what sends the record back through a save? The [Triggers and Order of Execution](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm) page in the Apex Developer Guide (Winter '27, API 68.0) answers it:

| What writes back | What Salesforce runs again | Where it is documented |
|---|---|---|
| A workflow field update | The record is updated again and system validation re-runs. Before update and after update triggers run "one more time (and only one more time)". Custom validation rules, flows, duplicate rules, processes and escalation rules do not run again. | Order of execution, step 11 |
| A flow or process that does DML | “The affected record goes through the save procedure.” In this recursive save, Salesforce skips steps 9 to 17 (assignment rules through grandparent roll-ups). Before-save flows, before triggers, validation rules, duplicate rules and after triggers run again. | Order of execution, step 13 and the note at the top |
| Apex DML in a trigger | The saved records' own triggers fire in a new invocation. Each nested level counts toward the 16. | Governor limits, stack depth footnote |
| A roll-up summary field | The parent record goes through the save procedure, and then the grandparent if it has a roll-up too. | Order of execution, steps 16 and 17 |

Two practical points follow.

- A workflow field update alone re-runs triggers once. The deep loops come from Apex DML or flow DML.
- "My flow runs twice" is usually the second row. An after-save flow or after trigger updates the same record, and your before-save flow runs again in the recursive save.

## How to find the loop

1. **Reproduce it with a debug log.** Set a trace flag on the user, repeat the save, and open the log. Search for the trigger name from the error. Count how many times it starts, and note what ran just before each start.
2. **List every automation on the saved object.** Include before-save flows, Apex triggers, validation rules, after-save flows, workflow rules and processes. In Setup, Object Manager shows triggers per object and Flow Trigger Explorer shows record-triggered flows.
3. **Mark the ones that write back.** For each automation, ask one question: does it write to a record of the same object?
   - Apex: look for `update`, `insert` or `upsert` in after-trigger handlers and the classes they call.
   - Flow: look for Update Records or Create Records elements on the same object, including `$Record` updates in an after-save flow.
   - Workflow: look for field updates.
4. **Follow cross-object chains.** An Installation update can change a Project, and a Project trigger can update Installations. Neither automation looks recursive on its own.
5. **Check for a guard.** See whether the trigger or handler keeps track of what it already processed.
6. **Check roll-ups.** A child save that recalculates a parent roll-up re-saves the parent. If the parent's automation updates the children, you have a loop.

## Fix patterns

| Fix | When to use it | Watch out for |
|---|---|---|
| Set same-record fields in a before trigger or before-save flow | The automation only changes the record being saved | [Apex docs](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers.htm): "Before triggers are used to update or validate record values before they're saved to the database." No DML is needed, so no second save. |
| Run only when something changed | The write-back is needed, but only on a real change | In Apex, compare `Trigger.oldMap`. In a record-triggered flow, use the entry option that runs only when a record is updated to meet the conditions ([Trailhead](https://trailhead.salesforce.com/content/learn/modules/record-triggered-flows/build-a-record-triggered-flow)). |
| Add a recursion guard | Apex re-entry you cannot design away | Apex docs: "A recursive trigger can use the value of a class variable to determine when to exit the recursion" ([static variables](https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_classes_static.htm)). Track record Ids, not one Boolean. Static variables are not reset when partial-success DML retries fire triggers again. |
| Give one automation ownership of a field | Two objects keep updating each other | Pick the side that owns the value. Remove the write on the other side. |
| Move the work out of the save | The update is slow or reaches many records | Asynchronous work runs after commit, so the record is not part of the current save. |

## With sf-intelligence

sf-intelligence reads your org's metadata on your own computer. It lists, for an object, every step that writes back to it, plus what Salesforce's rules say runs again. Here it is on Verdant, the built-in demo org (a fictional solar installer).

Ask: *"What happens when I save an Installation, and does anything write back to it?"*

<div class="found-card">

**What it found**

- **Nothing writes back to the Installation**, so this save cannot loop on itself.
- One after-save flow, `Installation_On_Complete`, runs when `Status__c` equals Completed. It creates a Service Visit (no automation there) and updates the Project, which has 2 active automations.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

From the `what_happens_on_save` tool (trimmed):

```json
"reentry": {
  "writeBacks": [],
  "cascades": [
    { "step": 1, "componentId": "Flow:Installation_On_Complete",
      "object": "Service_Visit__c", "operation": "recordCreate", "targetAutomation": 0 },
    { "step": 1, "componentId": "Flow:Installation_On_Complete",
      "object": "Project__c", "operation": "recordUpdate", "targetAutomation": 2 }
  ]
}
```

</details>

Ask the same about Project and you get the next hop. `ProjectTrigger` sets `Risk_Score__c` in its before-update step, which needs no DML. Its after-update step only logs. The `Project_On_Approve` flow creates a Permit, which has no automation. Again, nothing writes back.

So the Verdant demo has no save loop to find. That is a real result, and each step is cited. One risk remains: the separate code-quality check (`code_quality_audit`) reports that `ProjectTrigger` "has no recognizable recursion guard". In an org with a loop, the answer lists each step that writes to the saved object, the fields it writes, and the quoted Salesforce rule for what runs again.

What it does not see, in its own words: "Conditions are not evaluated. Not listed: approval-process field updates, time-triggered workflow updates, Process Builder processes ... DML inside subflows or invocable actions." Managed-package code is also out of reach. Use the debug log to confirm what fires for a specific record.
