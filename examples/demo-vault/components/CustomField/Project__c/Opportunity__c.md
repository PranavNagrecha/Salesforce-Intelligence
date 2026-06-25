---
apiName: Opportunity__c
apiVersion: null
id: CustomField:Project__c.Opportunity__c
label: Opportunity
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  dataType: Lookup
  defaultValue: null
  description: null
  externalId: false
  formula: null
  inlineHelpText: null
  label: Opportunity
  length: null
  picklistValues: null
  precision: null
  referenceTo: Opportunity
  relationshipName: Projects
  required: false
  scale: null
  trackHistory: false
  unique: false
sourcePath: source/main/default/objects/Project__c/fields/Opportunity__c.field-meta.xml
type: CustomField
---

# Opportunity

**API Name:** `Opportunity__c`  
**Type:** CustomField

## Properties

| Key | Value |
| --- | --- |
| dataType | `Lookup` |
| defaultValue | `null` |
| externalId | `false` |
| formula | `null` |
| inlineHelpText | `null` |
| length | `null` |
| picklistValues | `null` |
| precision | `null` |
| referenceTo | `Opportunity` |
| relationshipName | `Projects` |
| required | `false` |
| scale | `null` |
| trackHistory | `false` |
| unique | `false` |

## Incident edges

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `PermissionSet:Project_Manager` | declared | permission-set-extractor |
| `Profile:Verdant_Sales_Rep` | declared | profile-extractor |

### lookupTo (outgoing, 1)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Opportunity` | declared | custom-field-extractor |

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | custom-field-extractor |

### usedInLayout (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Layout:Project__c.Residential Layout` | declared | layout-extractor |
