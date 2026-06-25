---
apiName: Warranty_Claim__c
apiVersion: null
id: CustomObject:Warranty_Claim__c
label: Warranty Claim
lastModifiedBy: null
lastModifiedDate: null
parentId: null
properties:
  deploymentStatus: Deployed
  description: A warranty claim raised against a completed installation.
  enableActivities: true
  enableHistory: true
  enableReports: true
  enableSearch: false
  label: Warranty Claim
  nameFieldLabel: Warranty Claim Number
  nameFieldType: AutoNumber
  pluralLabel: Warranty Claims
  sharingModel: Private
  visibility: Public
sourcePath: source/main/default/objects/Warranty_Claim__c/Warranty_Claim__c.object-meta.xml
type: CustomObject
---

# Warranty Claim

**API Name:** `Warranty_Claim__c`  
**Type:** CustomObject

A warranty claim raised against a completed installation.

## Properties

| Key | Value |
| --- | --- |
| deploymentStatus | `Deployed` |
| enableActivities | `true` |
| enableHistory | `true` |
| enableReports | `true` |
| enableSearch | `false` |
| nameFieldLabel | `Warranty Claim Number` |
| nameFieldType | `AutoNumber` |
| pluralLabel | `Warranty Claims` |
| sharingModel | `Private` |
| visibility | `Public` |

## Incident edges

### grantedBy (incoming, 2)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Profile:Verdant_Installer` | declared | profile-extractor |
| `Profile:Verdant_Read_Only` | declared | profile-extractor |

### parentOf (outgoing, 4)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Warranty_Claim__c.Claim_Date__c` | declared | custom-field-extractor |
| `CustomField:Warranty_Claim__c.Installation__c` | declared | custom-field-extractor |
| `CustomField:Warranty_Claim__c.Issue__c` | declared | custom-field-extractor |
| `CustomField:Warranty_Claim__c.Status__c` | declared | custom-field-extractor |

### sharedWith (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `Queue:Warranty_Queue` | declared | queue-extractor |
