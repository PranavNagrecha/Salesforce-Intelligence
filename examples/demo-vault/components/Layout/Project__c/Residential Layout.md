---
apiName: Residential Layout
apiVersion: null
id: Layout:Project__c.Residential Layout
label: Residential Layout
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Project__c
properties:
  customButtons: []
  fieldCount: 12
  relatedListFieldRefs:
    - fields:
        - Install_Date__c
        - Panels_Installed__c
      relatedListApiName: Installation__c.Project__c
  sectionCount: 2
  showInheritedColumns: false
  showSubmitAndAttach: false
sourcePath: source/main/default/layouts/Project__c-Residential Layout.layout-meta.xml
type: Layout
---

# Residential Layout

**API Name:** `Residential Layout`  
**Type:** Layout

## Properties

| Key | Value |
| --- | --- |
| customButtons | `` |
| fieldCount | `12` |
| relatedListFieldRefs | `[object Object]` |
| sectionCount | `2` |
| showInheritedColumns | `false` |
| showSubmitAndAttach | `false` |

## Incident edges

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Project__c` | declared | layout-extractor |

### usedInLayout (outgoing, 14)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Installation__c.Install_Date__c` | parsed | relationship-resolver |
| `CustomField:Installation__c.Panels_Installed__c` | parsed | relationship-resolver |
| `CustomField:Project__c.Account__c` | declared | layout-extractor |
| `CustomField:Project__c.Contract_Value__c` | declared | layout-extractor |
| `CustomField:Project__c.Expected_Completion__c` | declared | layout-extractor |
| `CustomField:Project__c.Is_Complete__c` | declared | layout-extractor |
| `CustomField:Project__c.Margin_Percent__c` | declared | layout-extractor |
| `CustomField:Project__c.Name` | declared | layout-extractor |
| `CustomField:Project__c.Opportunity__c` | declared | layout-extractor |
| `CustomField:Project__c.Permit_Approved__c` | declared | layout-extractor |
| `CustomField:Project__c.Risk_Score__c` | declared | layout-extractor |
| `CustomField:Project__c.Status__c` | declared | layout-extractor |
| `CustomField:Project__c.System_Size_kW__c` | declared | layout-extractor |
| `CustomField:Project__c.Total_Invoiced__c` | declared | layout-extractor |
