---
apiName: IncentiveBatch
apiVersion: 61
id: ApexClass:IncentiveBatch
label: IncentiveBatch
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  annotations: []
  description: null
  hasAuraEnabledMethod: false
  hasFutureMethod: false
  hasInvocableMethod: false
  implements:
    - "Database.Batchable<SObject>"
  isBatchable: true
  isQueueable: false
  isRestResource: false
  isSchedulable: false
  isTest: false
  lineCount: 54
  modifiers:
    - public
  qualityIssues:
    - confidence: heuristic
      explanation: "Hardcoded Salesforce ID literal 'a01000000000001' — IDs differ between sandbox/production. Replace with a Custom Setting, Custom Metadata, or Schema.GlobalDescribe lookup."
      location: line 13
      rule: hardcoded-id
      severity: medium
    - confidence: heuristic
      explanation: "Uses dynamic SOQL (Database.query) — object/field/type references built at runtime are INVISIBLE to static dependency analysis. Impact, usage, and dead-code results for this class may be incomplete; verify by reading the source."
      location: line 16
      rule: dynamic-apex
      severity: info
    - confidence: heuristic
      explanation: SOQL query without WITH SECURITY_ENFORCED / USER_MODE — field-level security not enforced on the result. Add the clause or check Schema.sObjectType.X.fields.Y.isAccessible() before reading.
      location: line 16
      rule: missing-fls-check
      severity: high
    - confidence: heuristic
      explanation: SOQL query without WITH SECURITY_ENFORCED / USER_MODE — field-level security not enforced on the result. Add the clause or check Schema.sObjectType.X.fields.Y.isAccessible() before reading.
      location: line 28
      rule: missing-fls-check
      severity: high
    - confidence: heuristic
      explanation: SOQL query inside a loop body — risks the 100-SOQL-per-transaction governor limit. Move the query outside the loop and iterate the result set.
      location: line 28
      rule: soql-in-loop
      severity: critical
    - confidence: heuristic
      explanation: "DML 'update toUpdate' executes without a preceding CRUD check. Add Schema.sObjectType.X.is{Createable|Updateable|Deletable}() or use WITH SECURITY_ENFORCED / USER_MODE."
      location: line 47
      rule: missing-crud-check
      severity: high
  sharingModel: with sharing
  sourceBytes: 1863
  status: Active
  superclass: null
sourcePath: source/main/default/classes/IncentiveBatch.cls
type: ApexClass
---

# IncentiveBatch

**API Name:** `IncentiveBatch`  
**Type:** ApexClass

## Properties

| Key | Value |
| --- | --- |
| annotations | `` |
| hasAuraEnabledMethod | `false` |
| hasFutureMethod | `false` |
| hasInvocableMethod | `false` |
| implements | `Database.Batchable<SObject>` |
| isBatchable | `true` |
| isQueueable | `false` |
| isRestResource | `false` |
| isSchedulable | `false` |
| isTest | `false` |
| lineCount | `54` |
| modifiers | `public` |
| qualityIssues | `[object Object],[object Object],[object Object],[object Object],[object Object],[object Object]` |
| sharingModel | `with sharing` |
| sourceBytes | `1863` |
| status | `Active` |
| superclass | `null` |

## Source

```apex
/**
 * Batch job that reconciles incentives against their parent projects.
 *
 * NOTE: This class intentionally contains anti-patterns for the
 * sf-intelligence demo (governor_limit_risks + find_hardcoded_values):
 *   - a SOQL query INSIDE a for-loop, and
 *   - a hardcoded 15-char Salesforce Id literal.
 * Do not copy this style into real code.
 */
public with sharing class IncentiveBatch implements Database.Batchable<SObject> {

    // Hardcoded record Id literal (intentional anti-pattern for the demo).
    private static final Id FALLBACK_PROJECT_ID = 'a01000000000001';

    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator([
            SELECT Id, Project__c, Amount__c, Approved__c, Type__c
            FROM Incentive__c
            WHERE Approved__c = true
        ]);
    }

    public void execute(Database.BatchableContext bc, List<Incentive__c> scope) {
        List<Project__c> toUpdate = new List<Project__c>();

        for (Incentive__c inc : scope) {
            // INTENTIONAL: SOQL query inside a for-loop (governor-limit risk).
            List<Project__c> projects = [
                SELECT Id, Contract_Value__c, Status__c
                FROM Project__c
                WHERE Id = :inc.Project__c
                LIMIT 1
            ];

            Project__c proj;
            if (projects.isEmpty()) {
                // Fall back to the hardcoded Id (intentional anti-pattern).
                proj = new Project__c(Id = FALLBACK_PROJECT_ID);
            } else {
                proj = projects[0];
            }

            toUpdate.add(proj);
        }

        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug(LoggingLevel.INFO, 'IncentiveBatch finished.');
    }
}

```

## Incident edges

### readsFrom (outgoing, 11)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Incentive__c.Amount__c` | parsed | apex-ast |
| `CustomField:Incentive__c.Approved__c` | parsed | apex-ast |
| `CustomField:Incentive__c.Id` | parsed | apex-ast |
| `CustomField:Incentive__c.Project__c` | parsed | apex-ast |
| `CustomField:Incentive__c.Type__c` | parsed | apex-ast |
| `CustomField:LoggingLevel.INFO` | heuristic | apex-scanner |
| `CustomField:Project__c.Contract_Value__c` | parsed | apex-ast |
| `CustomField:Project__c.Id` | parsed | apex-ast |
| `CustomField:Project__c.Status__c` | parsed | apex-ast |
| `CustomObject:Incentive__c` | heuristic | apex-scanner |
| `CustomObject:Project__c` | heuristic | apex-scanner |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:Project__c` | heuristic | apex-scanner |
