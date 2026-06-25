---
apiName: SBQQ__ProductRule__c
apiVersion: null
id: CustomObject:SBQQ__ProductRule__c
label: Product Rule
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  deploymentStatus: Deployed
  description: CPQ product rule stub (synthetic) — present so the SBQQ__ heuristic CPQ detector fires for the demo org.
  enableActivities: false
  enableHistory: false
  enableReports: true
  enableSearch: false
  label: Product Rule
  nameFieldLabel: Product Rule Name
  nameFieldType: Text
  pluralLabel: Product Rules
  sharingModel: ReadWrite
  visibility: Public
sourcePath: source/main/default/objects/SBQQ__ProductRule__c/SBQQ__ProductRule__c.object-meta.xml
type: CustomObject
---

# Product Rule

**API Name:** `SBQQ__ProductRule__c`  
**Type:** CustomObject

CPQ product rule stub (synthetic) — present so the SBQQ__ heuristic CPQ detector fires for the demo org.

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `false` |
| enableHistory | `false` |
| enableReports | `true` |
| enableSearch | `false` |
| nameFieldLabel | `Product Rule Name` |
| nameFieldType | `Text` |
| pluralLabel | `Product Rules` |
| sharingModel | `ReadWrite` |
| visibility | `Public` |

## Incident edges

### parentOf (outgoing, 2)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:SBQQ__ProductRule__c.SBQQ__ErrorMessage__c` | declared | custom-field-extractor |
| `CustomField:SBQQ__ProductRule__c.SBQQ__Type__c` | declared | custom-field-extractor |
