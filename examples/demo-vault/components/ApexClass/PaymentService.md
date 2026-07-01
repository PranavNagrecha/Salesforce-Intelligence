---
apiName: PaymentService
apiVersion: 61
id: ApexClass:PaymentService
label: PaymentService
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
  lineCount: 44
  modifiers:
    - public
  qualityIssues:
    - confidence: heuristic
      explanation: SOQL query without WITH SECURITY_ENFORCED / USER_MODE — field-level security not enforced on the result. Add the clause or check Schema.sObjectType.X.fields.Y.isAccessible() before reading.
      location: line 17
      rule: missing-fls-check
      severity: high
    - confidence: heuristic
      explanation: "DML 'insert payment' executes without a preceding object-level CRUD check. Add Schema.sObjectType.X.is{Createable|Updateable|Deletable}(), run the DML in user mode (`insert x as user` / `Database.insert(x, AccessLevel.USER_MODE)`), or strip with Security.stripInaccessible. NOTE: a SOQL `WITH SECURITY_ENFORCED` / `USER_MODE` clause enforces READ FLS on the query and does NOT authorize this write."
      location: line 30
      rule: missing-crud-check
      severity: high
    - confidence: heuristic
      explanation: "DML 'update invoice' executes without a preceding object-level CRUD check. Add Schema.sObjectType.X.is{Createable|Updateable|Deletable}(), run the DML in user mode (`update x as user` / `Database.update(x, AccessLevel.USER_MODE)`), or strip with Security.stripInaccessible. NOTE: a SOQL `WITH SECURITY_ENFORCED` / `USER_MODE` clause enforces READ FLS on the query and does NOT authorize this write."
      location: line 39
      rule: missing-crud-check
      severity: high
  sharingModel: with sharing
  sourceBytes: 1487
  status: Active
  superclass: null
sourcePath: source/main/default/classes/PaymentService.cls
type: ApexClass
---

# PaymentService

**API Name:** `PaymentService`  
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
| lineCount | `44` |
| modifiers | `public` |
| qualityIssues | `[object Object],[object Object],[object Object]` |
| sharingModel | `with sharing` |
| sourceBytes | `1487` |
| status | `Active` |
| superclass | `null` |

## Source

```apex
/**
 * Applies payments against invoices. Updates the invoice's running paid total
 * (Invoice__c.Total_Paid__c is a roll-up of Payment__c.Amount__c) and marks the
 * invoice Paid when fully covered.
 */
public with sharing class PaymentService {

    /**
     * Apply a payment to an invoice.
     *
     * @param invoiceId the invoice receiving the payment
     * @param amount    the payment amount (Payment__c.Amount__c)
     * @param method    the payment method picklist value
     * @return the inserted Payment__c record
     */
    public static Payment__c applyPayment(Id invoiceId, Decimal amount, String method) {
        Invoice__c invoice = [
            SELECT Id, Amount__c, Total_Paid__c, Status__c
            FROM Invoice__c
            WHERE Id = :invoiceId
            LIMIT 1
        ];

        Payment__c payment = new Payment__c(
            Invoice__c = invoiceId,
            Amount__c = amount,
            Payment_Date__c = Date.today(),
            Method__c = method
        );
        insert payment;

        // Total_Paid__c is maintained by the roll-up, but we read it here to
        // decide whether the invoice is now fully paid.
        Decimal priorPaid = invoice.Total_Paid__c == null ? 0 : invoice.Total_Paid__c;
        Decimal newPaid = priorPaid + amount;

        if (invoice.Amount__c != null && newPaid >= invoice.Amount__c) {
            invoice.Status__c = 'Paid';
            update invoice;
        }

        return payment;
    }
}

```

## Incident edges

### callsApex (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:PaymentServiceTest` | parsed | apex-ast |

### readsFrom (outgoing, 5)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Invoice__c.Amount__c` | parsed | apex-ast |
| `CustomField:Invoice__c.Id` | parsed | apex-ast |
| `CustomField:Invoice__c.Status__c` | parsed | apex-ast |
| `CustomField:Invoice__c.Total_Paid__c` | parsed | apex-ast |
| `CustomObject:Invoice__c` | heuristic | apex-scanner |

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:Payment__c` | heuristic | apex-scanner |

### writesTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Invoice__c.Status__c` | parsed | apex-ast |
