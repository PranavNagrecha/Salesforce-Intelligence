---
apiName: ProjectTriggerHandlerTest
apiVersion: 61
id: ApexClass:ProjectTriggerHandlerTest
label: ProjectTriggerHandlerTest
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  annotations:
    - "@isTest"
  assertionCount: 4
  description: null
  hasAuraEnabledMethod: false
  hasFutureMethod: false
  hasInvocableMethod: false
  implements: []
  isBatchable: false
  isQueueable: false
  isRestResource: false
  isSchedulable: false
  isTest: true
  lineCount: 80
  modifiers:
    - private
  qualityIssues: []
  sharingModel: null
  sourceBytes: 2120
  status: Active
  superclass: null
sourcePath: source/main/default/classes/ProjectTriggerHandlerTest.cls
type: ApexClass
---

# ProjectTriggerHandlerTest

**API Name:** `ProjectTriggerHandlerTest`  
**Type:** ApexClass

## Properties

| Key | Value |
| --- | --- |
| annotations | `@isTest` |
| assertionCount | `4` |
| hasAuraEnabledMethod | `false` |
| hasFutureMethod | `false` |
| hasInvocableMethod | `false` |
| implements | `` |
| isBatchable | `false` |
| isQueueable | `false` |
| isRestResource | `false` |
| isSchedulable | `false` |
| isTest | `true` |
| lineCount | `80` |
| modifiers | `private` |
| qualityIssues | `` |
| sharingModel | `null` |
| sourceBytes | `2120` |
| status | `Active` |
| superclass | `null` |

## Source

```apex
/**
 * Tests for ProjectTriggerHandler. This is a REAL test: it exercises the
 * risk-score derivation and asserts the expected outcomes (System.assert*).
 */
@isTest
private class ProjectTriggerHandlerTest {

    @isTest
    static void draftHighValueProjectGetsElevatedRisk() {
        Project__c proj = new Project__c(
            Status__c = 'Draft',
            Contract_Value__c = 120000
        );

        Test.startTest();
        insert proj;
        Test.stopTest();

        Project__c reloaded = [
            SELECT Id, Risk_Score__c
            FROM Project__c
            WHERE Id = :proj.Id
            LIMIT 1
        ];

        // Draft (40) + value > 100000 (20) = 60.
        System.assertEquals(60, reloaded.Risk_Score__c,
            'Draft high-value project should score 60');
    }

    @isTest
    static void completeLowValueProjectGetsLowRisk() {
        Project__c proj = new Project__c(
            Status__c = 'Complete',
            Contract_Value__c = 10000,
            Permit_Approved__c = true
        );

        Test.startTest();
        insert proj;
        Test.stopTest();

        Project__c reloaded = [
            SELECT Id, Risk_Score__c, Status__c
            FROM Project__c
            WHERE Id = :proj.Id
            LIMIT 1
        ];

        System.assertEquals('Complete', reloaded.Status__c,
            'Status should persist as Complete');
        System.assert(reloaded.Risk_Score__c < 20,
            'Complete low-value project should score under 20');
    }

    @isTest
    static void cancelledProjectGetsHighRisk() {
        Project__c proj = new Project__c(
            Status__c = 'Draft',
            Contract_Value__c = 5000
        );
        insert proj;

        proj.Status__c = 'Cancelled';

        Test.startTest();
        update proj;
        Test.stopTest();

        Project__c reloaded = [
            SELECT Id, Risk_Score__c
            FROM Project__c
            WHERE Id = :proj.Id
            LIMIT 1
        ];

        System.assert(reloaded.Risk_Score__c >= 80,
            'Cancelled project should score at least 80');
    }
}

```

## Incident edges

### readsFrom (outgoing, 4)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Id` | parsed | apex-ast |
| `CustomField:Project__c.Risk_Score__c` | parsed | apex-ast |
| `CustomField:Project__c.Status__c` | parsed | apex-ast |
| `CustomObject:Project__c` | heuristic | apex-scanner |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:Project__c` | heuristic | apex-scanner |

### writesTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Project__c.Status__c` | parsed | apex-ast |
