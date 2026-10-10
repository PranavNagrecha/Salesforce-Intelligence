---
title: "Where Is This Standard Field Used in Salesforce?"
description: "Salesforce's Where is this used? button only covers custom fields. How to find where a standard field like Opportunity Amount is used across Flows and code."
slug: /how-to/standard-field-where-used
targetQuery: "salesforce where is this used standard field"
persona: "Salesforce admins and developers changing or retiring a standard field"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "Why is there no 'Where is this used?' button on standard fields?"
    a: "Salesforce documents the button for custom fields, and standard field detail pages do not show it. For standard fields you have to search your metadata, query the Dependency API, or use a tool that indexes your org."
  - q: "Can I use MetadataComponentDependency for standard fields?"
    a: "You can try it. It is a beta Tooling API object, a single Tooling API query returns at most 2,000 rows, and reports are only included through Bulk API 2.0. Its coverage of standard fields is not documented as complete, so treat an empty result with care."
  - q: "Can I delete a standard field?"
    a: "No. You can remove it from page layouts, hide it with field-level security, and stop automation from using it. That is why knowing where it is used matters: you are retiring it, not deleting it."
  - q: "Do profiles and permission sets count as 'used'?"
    a: "No. Field access in a profile or permission set says who can see the field, not what depends on it. List access separately from usage."
related:
  - /use-cases/where-is-a-field-used
  - /how-to/find-what-is-updating-a-field
  - /how-to/delete-picklist-value
  - /use-cases/what-breaks-if-you-delete-a-field
  - /how-to/where-is-apex-class-used
section: how-to
heading: "Where is this standard field used? (When \"Where is this used?\" doesn't help)"
answer: "Salesforce's \"Where is this used?\" button is documented for custom fields only. For a standard field like Opportunity Amount or Account Billing City, you have to search yourself: retrieve your metadata and search it, query the beta Dependency API, and check reports separately. Expect references to be spelled differently in formulas, Flows and Apex."
schemaType: HowTo
steps:
  - "Retrieve your org's metadata and search for the field in every spelling it can take."
  - "Optionally query the Dependency API, knowing its limits."
  - "Check reports, report types and list views separately."
  - "Check page layouts and Lightning pages."
  - "Keep access (profiles, permission sets) on a separate list from usage."
cta:
  question: "Where is Opportunity Amount used?"
---
## The short version

1. Retrieve your org's metadata and search for the field in every spelling it can take.
2. Optionally query the Dependency API, knowing its limits.
3. Check reports, report types and list views separately.
4. Check page layouts and Lightning pages.
5. Keep access (profiles, permission sets) on a separate list from usage.

## The platform gap

Salesforce's help article [Find Where a Field Is Used](https://help.salesforce.com/s/articleView?id=sf.fields_references.htm&language=en_US&type=5) describes the button on a custom field's detail page. Open a standard field such as Opportunity Amount in Object Manager and the button is not there.

That leaves the standard fields that most automation depends on, like Stage, Amount, Close Date, Status and Owner, without a native "who uses this" answer.

## The Dependency API and its limits

The Tooling API object [MetadataComponentDependency](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_metadatacomponentdependency.htm) returns "component A depends on component B" rows. It is the closest thing to a native answer, with limits worth knowing:

| Limit | What it means for you |
|---|---|
| It is a beta feature | Salesforce does not guarantee it or its coverage |
| A Tooling API query returns at most 2,000 rows | In a larger org you will hit the cap |
| Reports are only included through Bulk API 2.0 | A Tooling query alone misses report usage |
| Several query features are not supported | You often pull rows and filter them yourself |
| Standard-field coverage is not documented as complete | An empty answer is not proof the field is unused |

To try it from the Salesforce CLI:

```bash
sf data query --use-tooling-api --query "SELECT MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency LIMIT 2000"
```

Then search the output for your object and field.

## Manual workarounds

### 1. Search retrieved metadata, in every spelling

The same field is written differently depending on where it is used:

| Where | How Opportunity Amount usually appears |
|---|---|
| Formula or validation rule on Opportunity | `Amount` |
| Formula on a child object | `Opportunity__r.Amount` or `Opportunity.Amount` |
| Flow XML | `<field>Amount</field>` inside an element on Opportunity |
| Apex | `opp.Amount`, or `Amount` inside a SOQL string |
| Workflow rule | `Opportunity.Amount` in rule criteria, `Amount` in a rule formula |

```bash
sf project retrieve start --metadata Flow ApexClass ApexTrigger Workflow CustomObject Layout FlexiPage
grep -rnw "Amount" force-app/main/default
```

A short name like `Amount` matches many unrelated things. Check each hit is on the right object.

### 2. Check reports separately

Reports are not in the retrieve above, and you cannot retrieve every report with a wildcard. Search report types for the object, and check reports and dashboards that filter or group by the field.

### 3. Check layouts and Lightning pages

Search the retrieved page layouts for the field, or open each layout in the editor. Lightning pages can also use the field in component visibility rules, which the layout editor does not show.

### 4. Keep access on its own list

A profile or permission set that grants access to the field is not "using" it. Removing usage and removing access are separate tasks.

## With sf-intelligence

sf-intelligence reads your org's metadata once, keeps a copy on your computer, and lets your AI assistant answer from it. It never writes to the org. It records references to standard fields the same way it records references to custom ones. These are real answers from the built-in demo org, a solar installer called Verdant.

**Ask: "Where is Opportunity Amount used?"** It finds one user:

<div class="found-card">

**What it found**

- **`High_Value_Flag`** (workflow rule on Opportunity) reads Amount in its condition `Amount > 100000`.
- The field's own definition is not in the demo's saved metadata, so the answer says so (more on that below).

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

From the `find_component_usages` tool (output trimmed):

```json
"target": { "componentId": "CustomField:Opportunity.Amount", "retrieved": false },
"graphReferrers": [{ "referrerType": "ConditionalContext", "count": 1,
  "sample": [{ "referrerId": "ConditionalContext:WorkflowRule:Opportunity.High_Value_Flag.condition-0",
               "viaEdge": "readsFrom" }] }],
"summary": { "distinctReferrerCount": 1, "referrerTypes": ["ConditionalContext"] }
```

</details>

**Ask: "Where is Opportunity Description used?"** It finds the same workflow rule, this time as a writer of the field. The rule's field update stamps "HIGH VALUE - " and the amount into Description. A search for the word "Description" would have drowned in noise.

**Ask: "Can I delete Opportunity Amount?"** The answer is **review**, with this reason: "NOT proven safe to delete: a standard field cannot be deleted via metadata, and a not-modeled field cannot be fully assessed."

The answer also lists what was not checked for fields, such as roll-up summary sources and Flow decision and filter conditions. Check those by hand.

### Why the demo says the field definition is missing

The demo org has no saved copy of the Opportunity field list, so the field's own details (type, help text, picklist values) are missing. The usage list still works, because it comes from the components that mention the field, and the answer says plainly that the definition is missing.

In your own org, a normal refresh saves the field list for 14 standard objects: Account, Contact, Opportunity, Lead, Case, Task, Event, Campaign, Contract, Asset, Order, Product2, Pricebook2 and User. Questions about those fields then work the way they do for custom fields.

### Upgrade note for 0.4.0

A vault built by 0.3.3 has no saved copy of that standard field list. After upgrading, run one normal refresh before using the offline option:

```bash
sfi refresh
# or, to stay offline for everything else:
sfi refresh --no-pull --with-describe
```

Until you do, answers about those fields say the field may still exist instead of guessing.
