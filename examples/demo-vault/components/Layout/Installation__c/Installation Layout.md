---
apiName: Installation Layout
apiVersion: null
id: Layout:Installation__c.Installation Layout
label: Installation Layout
lastModifiedBy: null
lastModifiedDate: null
parentId: CustomObject:Installation__c
properties:
  fieldCount: 6
  sectionCount: 1
  showInheritedColumns: false
  showSubmitAndAttach: false
sourcePath: source/main/default/layouts/Installation__c-Installation Layout.layout-meta.xml
type: Layout
---

# Installation Layout

**API Name:** `Installation Layout`  
**Type:** Layout

## Properties

| Key | Value |
| --- | --- |
| fieldCount | `6` |
| sectionCount | `1` |
| showInheritedColumns | `false` |
| showSubmitAndAttach | `false` |

## Incident edges

### parentOf (incoming, 1)

| Source | Confidence | Producer |
| --- | --- | --- |
| `CustomObject:Installation__c` | declared | layout-extractor |

### usedInLayout (outgoing, 6)

| Target | Confidence | Producer |
| --- | --- | --- |
| `CustomField:Installation__c.Crew_Lead__c` | declared | layout-extractor |
| `CustomField:Installation__c.Install_Date__c` | declared | layout-extractor |
| `CustomField:Installation__c.Name` | declared | layout-extractor |
| `CustomField:Installation__c.Panels_Installed__c` | declared | layout-extractor |
| `CustomField:Installation__c.Project__c` | declared | layout-extractor |
| `CustomField:Installation__c.Status__c` | declared | layout-extractor |
