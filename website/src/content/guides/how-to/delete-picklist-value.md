---
title: "What Breaks When You Delete a Salesforce Picklist Value"
description: "Delete, deactivate or replace a Salesforce picklist value safely. What happens to records, reports, Flows, formulas and Apex, plus a checklist before you click."
slug: /how-to/delete-picklist-value
targetQuery: "what happens when you delete a picklist value in salesforce"
persona: "Salesforce admins cleaning up picklist values"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "What happens to records when you delete a picklist value?"
    a: "Salesforce asks you to replace the value on existing records with another value or a blank. Records that held it lose the original value. To keep it on old records, deactivate the value instead."
  - q: "Should I deactivate or delete a picklist value?"
    a: "Deactivate when old records should keep the value for reporting. Delete with a replacement when the old value should disappear from every record. Either way, update the automation that compares against it first."
  - q: "Does Salesforce stop me from deleting a value a Flow uses?"
    a: "Do not rely on it. Flows, formulas and validation rules that compare against the old value are not rewritten for you. A condition on a deleted value simply never matches again, so check them before you change the list."
  - q: "Is renaming a picklist value safe?"
    a: "Changing only the label keeps the API name, so automation that compares the API name keeps working. Salesforce notes that workflow rules and report filters using the old value may not behave as expected, and record history is not updated."
related:
  - /how-to/find-what-is-updating-a-field
  - /use-cases/what-breaks-if-you-delete-a-field
  - /how-to/standard-field-where-used
  - /use-cases/impact-analysis
section: how-to
heading: "What breaks when you delete, rename or deactivate a picklist value"
answer: "Deleting a picklist value makes you replace it on every existing record, or blank it. Deactivating keeps it on old records but hides it from new choices. Neither one updates the Flows, formulas, validation rules, sharing rules or Apex that compare against the value. Those keep checking for a value that no longer appears, so find them before you click."
schemaType: HowTo
steps:
  - "Decide between delete, deactivate, replace and relabel, using the table below."
  - "Find every component that compares against or writes the value."
  - "Update or retire that automation first."
  - "Check reports, list views and dashboards that filter on the value."
  - "Make the change in a sandbox, run your tests, then repeat in production."
cta:
  question: "What breaks if I remove 'Completed' from Installation Status?"
---
## The short version

1. Decide between delete, deactivate, replace and relabel, using the table below.
2. Find every component that compares against or writes the value.
3. Update or retire that automation first.
4. Check reports, list views and dashboards that filter on the value.
5. Make the change in a sandbox, run your tests, then repeat in production.

## Delete vs deactivate vs replace vs relabel

| What happens to | Delete | Deactivate | Replace | Change label only |
|---|---|---|---|---|
| Existing records | You are prompted to replace the value or leave it blank. The old value is gone | Keep the value | Get the new value, including records in the recycle bin | Unchanged. The API name stays the same |
| New and edited records | Cannot choose it | Cannot choose it | Cannot choose the old value | See the new label |
| Flows, formulas, validation rules | Conditions on the value never match again | Still match old records | Conditions on the old value never match again | Keep working when they compare the API name |
| Automation that writes the value | Unrestricted picklist: still saves the old text. Restricted picklist: the save fails | Same as delete | Same as delete | Unaffected |
| Report filters | Find nothing for the old value | Still find old records | Keep working | Salesforce warns they may not work as expected |
| Dependent picklists | Check the controlling-value matrix | Check the matrix | Replacing a controlling value removes its dependency | Unaffected |
| Record history | Not rewritten | Not rewritten | Not rewritten, but Last Modified changes | Not rewritten |

Sources: Salesforce Help articles on [keeping a value for historical records](https://help.salesforce.com/s/articleView?id=000384482&language=en_US&type=1), [renaming versus replacing](https://help.salesforce.com/s/articleView?id=000385717&language=en_US&type=1), and [replacing a picklist value](https://help.salesforce.com/s/articleView?id=sf.customize_replace.htm&language=en_US&type=5), plus Trailhead's [Manage Your Picklist Values](https://trailhead.salesforce.com/content/learn/modules/picklist_admin/picklist_admin_manage) and [picklist basics](https://trailhead.salesforce.com/content/learn/modules/picklist_admin/picklist_admin_start), which explain that only restricted picklists block values coming from the API and automation.

## Why the native tools only get you halfway

"Where is this used?" works per field, not per value. It tells you a Flow references Status. It does not tell you whether that Flow cares about Complete, Cancelled or neither. You have to open each component and read its conditions.

Value references also hide in places that are slow to open:

- Flow entry criteria, Decision outcomes and Get Records filters
- Formula fields and validation rules using `ISPICKVAL`
- Workflow and approval field updates that set the value
- Criteria-based sharing rules
- Apex that compares the field to a string
- Report filters, list views and Lightning page visibility rules

## Step by step, by hand

### 1. Search retrieved metadata for the value

```bash
sf project retrieve start --metadata Flow CustomObject ApexClass ApexTrigger Workflow SharingRules
grep -rn "Complete" force-app/main/default
```

Expect noise. A common word like "Complete" appears in labels, descriptions and other fields. Check each hit is about the right field on the right object.

### 2. Open each hit and classify it

Mark each one as "compares against the value" or "writes the value." Writers matter most on a restricted picklist, because their saves will start failing.

### 3. Check reports and list views

Reports are not in the search above. Open reports built on the object and look at their filters, or run a report grouped by the field to see how many records hold the value.

### 4. Decide what happens to existing records

If the value should survive on old records, deactivate it. If it should be merged into another value, replace it. Delete with a blank only when losing the value is fine.

## With sf-intelligence

sf-intelligence reads your org's metadata once, keeps a copy on your computer, and lets your AI assistant answer from it. It never writes to the org. These are real answers from the built-in demo org, a solar installer called Verdant.

**Ask: "What breaks if I remove 'Complete' from Project Status?"** The answer is **blocking**, with three things that depend on the value:

<div class="found-card">

**What it found**

- **`Is_Complete__c`** (formula field on Project) checks for Complete, so it would never be true again.
- **`Installation_On_Complete`** (Flow) writes Complete to the field. It would keep saving a value that is no longer in the list.
- **`Complete_Requires_Permit`** (validation rule) only fires when Status is Complete and the permit is not approved. It would stop firing.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

From the `what_if_remove_picklist_value` tool (output trimmed):

```json
"verdict": "blocking",
"impacts": [
  { "componentId": "CustomField:Project__c.Is_Complete__c", "category": "metadata-blocker" },
  { "componentId": "Flow:Installation_On_Complete", "category": "metadata-blocker",
    "where": ["writes this value (recordUpdate) — keeps saving a value no longer in the list"] },
  { "componentId": "ValidationRule:Project__c.Complete_Requires_Permit", "category": "metadata-blocker",
    "where": ["criteria: ISPICKVAL(Status__c,\"Complete\") && NOT(Permit_Approved__c)"] }
],
"restricted": false
```

</details>

**Ask: "What if I remove 'Approved'?"** One blocker: the `Project_On_Approve` Flow, which only starts when Status equals Approved. That Flow creates the Permit record, so permits would stop being created.

**Ask: "What if I remove 'Cancelled'?"** The answer is **risky**, and it names the `Share_Projects_To_Ops` sharing rule. That rule shares every project whose Status is not Cancelled with the Ops group. If you replace Cancelled with another value, the cancelled projects start being shared with Ops.

### What to check by hand, even with the tool

Each answer lists what it did not check. For this field it named report and dashboard filters, path assistants, Flow screen visibility rules, dependent-picklist matrices, and Apex that compares a variable or uses dynamic SOQL.

Apex needs a manual search. The demo's `ProjectTriggerHandler` copies Status into a variable and compares it to every value, including 'Complete', 'Approved' and 'Cancelled'. None of the answers above listed it, because a comparison through a variable is on the "not checked" list. Search your Apex for the value text before you change the list.

## Checklist before you change a picklist value

1. List every Flow, formula, validation rule, sharing rule and workflow that uses the value.
2. Search Apex for the value as a string.
3. Check reports, dashboards and list views that filter on it.
4. Check record types and dependent picklists that list it.
5. Decide: deactivate, replace or delete.
6. Update the automation first, then change the value, in a sandbox.
7. Run your Apex tests and walk through the affected Flows.
8. Repeat in production and tell report owners.
