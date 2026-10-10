---
title: "Where Is This Apex Class Used? Find Unused Apex Classes"
description: "Find where a Salesforce Apex class is called from Apex, Flows, LWC, Aura and Visualforce, tell dead code from scheduled jobs, and delete unused classes safely."
slug: /how-to/where-is-apex-class-used
targetQuery: "find where apex class is used"
persona: "Salesforce developers and admins cleaning up Apex"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "How do I find where an Apex class is used in Salesforce?"
    a: "Search for the class name across Apex classes, triggers, Flows (Apex actions), Lightning Web Components, Aura components and Visualforce pages. Show Dependencies in Setup lists what the class uses, not who calls it."
  - q: "How do I find unused Apex classes?"
    a: "List classes with no callers outside test classes. Then remove from that list any batch, schedulable, queueable, REST or invocable class, because those can be started from outside your code. Check Scheduled Jobs and Apex Jobs for the rest."
  - q: "Is a class only called by its test class dead code?"
    a: "Probably, but confirm it. A class whose only caller is a test class has no production caller in your metadata. It could still be run from anonymous Apex or named in a string. If neither is true, delete the class and its test together."
  - q: "How do I delete an Apex class from production?"
    a: "Deploy a destructiveChanges.xml that lists the class, alongside an empty package.xml. Remove callers first, and run tests in a sandbox before you deploy to production."
related:
  - /how-to/standard-field-where-used
  - /how-to/find-what-is-updating-a-field
  - /blog/delete-unused-salesforce-fields
  - /use-cases/salesforce-dependency-analysis
section: how-to
heading: "Where is this Apex class used, and is it dead code?"
answer: "To find where an Apex class is used, search for its name in Apex, triggers, Flows, Lightning Web Components, Aura components and Visualforce pages. Show Dependencies in Setup lists what the class uses, not who calls it. A class with no callers is not always dead. Batch, schedulable, queueable and REST classes are started from outside your code."
schemaType: HowTo
steps:
  - "List every caller: Apex, triggers, Flows, LWC, Aura and Visualforce."
  - "Set aside callers that are only test classes."
  - "Check whether the class is built to be started from outside: batch, schedulable, queueable, REST, invocable or @AuraEnabled."
  - "For those, check Scheduled Jobs, Apex Jobs and external integrations."
  - "Delete only classes with no production caller and no outside entry point."
cta:
  question: "Is PaymentService dead code?"
---
## The short version

1. List every caller: Apex, triggers, Flows, LWC, Aura and Visualforce.
2. Set aside callers that are only test classes.
3. Check whether the class is built to be started from outside: batch, schedulable, queueable, REST, invocable or `@AuraEnabled`.
4. For those, check Scheduled Jobs, Apex Jobs and external integrations.
5. Delete only classes with no production caller and no outside entry point.

## Where callers hide

| Caller | How it calls the class | Where to look by hand |
|---|---|---|
| Apex class or trigger | `ClassName.method()` or `new ClassName()` | Search `.cls` and `.trigger` files |
| Flow | An Apex action on an `@InvocableMethod` | Flow XML, `actionCalls` with action type `apex` |
| Lightning Web Component | `import x from '@salesforce/apex/ClassName.method'` | LWC JavaScript files |
| Aura component | `controller="ClassName"` plus `c.methodName` in JavaScript | Aura `.cmp` and controller or helper `.js` files |
| Visualforce | `controller=` or `extensions=` | `.page` and `.component` files |
| REST or SOAP clients | `@RestResource` or `webservice` methods | Outside Salesforce. Ask the integration owners |
| Scheduled and batch jobs | `System.schedule`, `Database.executeBatch`, or Setup, Schedule Apex | Setup, Scheduled Jobs and Apex Jobs |
| Dynamic calls | `Type.forName('ClassName')`, custom metadata, strings | Search for the class name in quotes |

## Why Show Dependencies is not enough

Salesforce's [Show Dependencies page](https://help.salesforce.com/apex/HTViewHelpDoc?id=about_dependencies.htm) lists the components a class depends on, plus the objects it inserts, updates or deletes. That is the outbound direction. "Who calls this class?" is the inbound direction, and Setup has no button for it.

## Step by step, by hand

### 1. Search for the class name

```bash
sf project retrieve start --metadata ApexClass ApexTrigger Flow LightningComponentBundle AuraDefinitionBundle ApexPage ApexComponent
grep -rn "PaymentService" force-app/main/default
```

Ignore hits inside the class itself and inside comments. For each remaining hit, note which methods it calls.

### 2. Split test callers from real ones

A hit in a class marked `@isTest` only proves the test runs it. If every caller is a test class, nothing in production calls the class through your metadata.

### 3. Check how the class can be started

Open the class and look at its first lines:

- `implements Database.Batchable`, `Schedulable` or `Queueable`: it can be started by a scheduled job, by Setup, or by anonymous Apex. Scheduled jobs are records, not metadata, so a search never finds them.
- `@RestResource` or `webservice`: an outside system calls it.
- `@InvocableMethod`: a Flow may call it. Check Flows, including inactive ones you plan to reactivate.
- `@AuraEnabled`: an LWC or Aura component may call it.

### 4. Check the jobs pages

In Setup, open Scheduled Jobs and Apex Jobs. A batch class that ran last night is not dead, even if nothing in your code starts it.

### 5. Delete safely

Production Apex is removed with a deployment, not from Setup. Salesforce describes the process in [Deleting Components from an Organization](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_deploy_deleting_files.htm): a `destructiveChanges.xml` listing the class, plus a `package.xml` with no components.

```bash
sf project deploy start --manifest package.xml --post-destructive-changes destructiveChanges.xml --test-level RunLocalTests --dry-run
```

Delete the class and its test class together. The `--dry-run` flag validates the deployment and runs tests without saving. Deploy to a sandbox before production.

## Dead, probably dead, or unknown

| Verdict | What it means | What to do |
|---|---|---|
| Dead | No caller of any kind in your metadata, and not built to be started from outside | Search for its name in quotes, then delete it after a sandbox test |
| Probably dead | Only test classes call it | Confirm no anonymous Apex or string-based call, then delete it with its test |
| Unknown | No callers, but it is batch, schedulable, queueable, REST, invocable or `@AuraEnabled` | Check the jobs pages and integrations before you touch it |
| In use | A trigger, Flow, component or production class calls it | Keep it |

## With sf-intelligence

sf-intelligence reads your org's metadata once, keeps a copy on your computer, and lets your AI assistant answer from it. It never writes to the org. These are real answers from the built-in demo org, a solar installer called Verdant.

**Ask: "Who calls ProjectTriggerHandler?"** It finds one caller and names the methods:

<div class="found-card">

**What it found**

- **`ProjectTrigger`** (Apex trigger) calls `handleAfterUpdate` and `handleBeforeSave`.
- The class is reached from a trigger, so it is in use.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

From the `call_graph` tool (output trimmed). The `method_reachability` tool adds that the class is reached from a trigger.

```json
"edges": [{ "fromId": "ApexTrigger:ProjectTrigger", "toId": "ApexClass:ProjectTriggerHandler",
            "methods": ["handleAfterUpdate", "handleBeforeSave"] }]
```

</details>

**Ask: "Is PaymentService dead code?"** The answer is **likely dead**:

<div class="found-card">

**What it found**

- Only test classes call it. Nothing in a production path that the metadata shows uses it.

</div>

<details class="tool-call">
<summary>For developers: the raw answer</summary>

From the `find_dead_code` tool (output trimmed):

```json
{ "componentId": "ApexClass:PaymentService", "verdict": "likely_dead",
  "reasoning": "incoming edges only from test classes (isTest === true); not used in production paths visible to the graph" }
```

</details>

Asking who calls `applyPayment` shows the only caller is `PaymentServiceTest`, from its test methods `applyPaymentRuns` and `applyPartialPaymentRuns`. That makes it a candidate to delete together with its test, once you confirm nothing outside your metadata calls it.

**Ask: "Is IncentiveBatch unused?"** Nothing in the demo org starts it, but the answer is **uncertain**, not dead:

> "async-dispatch class (Queueable/Batchable/Schedulable). No dispatch site of any kind is visible in this vault — which is NOT evidence of death ... check Setup > Scheduled Jobs / Apex Jobs before deleting."

That is the right call. A job scheduled from Setup leaves no trace in metadata.

### Lightning and Aura callers in 0.4.0

The demo org has no Lightning Web Components or Aura components, so it cannot show this part. Two fixes in 0.4.0 change the answers you get in a real org:

- An LWC that imported several methods of one Apex class used to be recorded with only the first method. Every method is now kept, so callers of the other methods are no longer missed, and a method an LWC calls is no longer reported as test-only.
- Aura components that call their Apex controller through `component.get('c.method')` are now found, with each method listed. A component that inherits its controller from a parent component is flagged as unresolved instead of being skipped.

If your vault was built by an older version, refresh it after upgrading to pick these up.

### What it cannot see

Classes called only from managed-package code, from anonymous Apex, through `Type.forName`, or by an outside system through REST can look unused. The answers say so. Treat them as a short list to confirm, not an automatic delete list.
