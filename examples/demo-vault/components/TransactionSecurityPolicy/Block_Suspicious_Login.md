---
apiName: Block_Suspicious_Login
apiVersion: null
id: TransactionSecurityPolicy:Block_Suspicious_Login
label: null
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  action:
    block: true
    endSession: false
    freezeUser: false
    notificationCount: 1
    twoFactorAuthentication: false
  active: "true"
  apexClass:
    - SuspiciousLoginCondition
  eventName: LoginEvent
  fieldRefs: []
  rawReferenceCount: 0
sourcePath: source/main/default/transactionSecurityPolicies/Block_Suspicious_Login.transactionSecurityPolicy-meta.xml
type: TransactionSecurityPolicy
---

# Block_Suspicious_Login

**API Name:** `Block_Suspicious_Login`  
**Type:** TransactionSecurityPolicy

## Properties

| Key | Value |
| --- | --- |
| action | `[object Object]` |
| active | `true` |
| apexClass | `SuspiciousLoginCondition` |
| eventName | `LoginEvent` |
| fieldRefs | `` |
| rawReferenceCount | `0` |

## Incident edges

### references (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `ApexClass:SuspiciousLoginCondition` | declared | enterprise-metadata-extractor |
