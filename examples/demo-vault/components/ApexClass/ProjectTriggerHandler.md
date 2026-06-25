---
apiName: ProjectTriggerHandler
apiVersion: 61
id: ApexClass:ProjectTriggerHandler
label: ProjectTriggerHandler
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  annotations: []
  description: null
  hasAuraEnabledMethod: false
  hasFutureMethod: false
  hasInvocableMethod: false
  implements: []
  isBatchable: false
  isQueueable: false
  isRestResource: false
  isSchedulable: false
  isTest: false
  lineCount: 60
  modifiers:
    - public
  qualityIssues: []
  sharingModel: with sharing
  sourceBytes: 2019
  status: Active
  superclass: null
sourcePath: source/main/default/classes/ProjectTriggerHandler.cls
type: ApexClass
---

# ProjectTriggerHandler

**API Name:** `ProjectTriggerHandler`  
**Type:** ApexClass

## Properties

| Key | Value |
| --- | --- |
| annotations | `` |
| hasAuraEnabledMethod | `false` |
| hasFutureMethod | `false` |
| hasInvocableMethod | `false` |
| implements | `` |
| isBatchable | `false` |
| isQueueable | `false` |
| isRestResource | `false` |
| isSchedulable | `false` |
| isTest | `false` |
| lineCount | `60` |
| modifiers | `public` |
| qualityIssues | `` |
| sharingModel | `with sharing` |
| sourceBytes | `2019` |
| status | `Active` |
| superclass | `null` |

## Source

```apex
/**
 * Handler for ProjectTrigger. Derives Risk_Score__c on Project__c from the
 * project's Status__c and Contract_Value__c, and propagates status changes.
 */
public with sharing class ProjectTriggerHandler {

    /**
     * Before insert/update: derive a 0-100 risk score for each project.
     * Higher contract values and unstarted/cancelled statuses raise risk.
     */
    public static void handleBeforeSave(List<Project__c> projects) {
        for (Project__c proj : projects) {
            proj.Risk_Score__c = computeRiskScore(proj);
        }
    }

    /**
     * After update: when a project is moved to Cancelled, log the change.
     * Kept simple for the demo; no DML on related records here.
     */
    public static void handleAfterUpdate(List<Project__c> projects, Map<Id, Project__c> oldMap) {
        for (Project__c proj : projects) {
            Project__c prior = oldMap.get(proj.Id);
            if (prior != null && prior.Status__c != proj.Status__c && proj.Status__c == 'Cancelled') {
                System.debug(LoggingLevel.INFO, 'Project ' + proj.Id + ' moved to Cancelled');
            }
        }
    }

    /**
     * Risk model: base on status, then scale by contract value.
     */
    private static Decimal computeRiskScore(Project__c proj) {
        Decimal score = 0;
        String status = proj.Status__c;
        if (status == 'Draft') {
            score = 40;
        } else if (status == 'Approved' || status == 'Permitting') {
            score = 25;
        } else if (status == 'Installing') {
            score = 15;
        } else if (status == 'Complete') {
            score = 5;
        } else if (status == 'Cancelled') {
            score = 80;
        }

        Decimal value = proj.Contract_Value__c == null ? 0 : proj.Contract_Value__c;
        if (value > 100000) {
            score += 20;
        } else if (value > 50000) {
            score += 10;
        }

        if (score > 100) {
            score = 100;
        }
        return score;
    }
}

```

## Incident edges

### callsApex (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexTrigger:ProjectTrigger` | parsed | apex-ast |

### readsFrom (outgoing, 4)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:LoggingLevel.INFO` | heuristic | apex-scanner |
| `CustomField:Project__c.Contract_Value__c` | parsed | apex-ast |
| `CustomField:Project__c.Id` | parsed | apex-ast |
| `CustomField:Project__c.Status__c` | parsed | apex-ast |

### writesTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Risk_Score__c` | parsed | apex-ast |
