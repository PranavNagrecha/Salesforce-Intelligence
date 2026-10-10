# Invoice (`Invoice__c`) — object brief

## What it is
- Custom object, plural label "Invoices".
- Description: An invoice billed against a Project for solar installation work. Child of Project via master-detail.
- Org-wide default: internal `ControlledByParent`, external `not captured`.

## Key fields (6 of 6: 6 custom, 0 standard)
Ranked: declared required / external id / unique first (1 / 0 / 0), then by how many components reference the field.
- `Amount__c` "Amount" (Currency; required) — 3 referencing component(s). Total amount billed on this invoice before payments are applied.
- `Status__c` "Status" (Picklist) — 2 referencing component(s). Lifecycle status of the invoice.
- `Total_Paid__c` "Total Paid" (Summary) — 2 referencing component(s). Sum of all Payment amounts applied to this invoice.
- `Project__c` "Project" (MasterDetail; → `Project__c`) — 1 referencing component(s)
- `Balance__c` "Balance" (Currency; formula) — 0 referencing component(s). Outstanding balance on the invoice: amount billed minus total payments applied.
- `Due_Date__c` "Due Date" (Date) — 0 referencing component(s). Date by which the invoice balance is due.

## Picklists (1 of 1, most-referenced first)
- `Status__c`: 4 active value(s) — Draft · Sent · Paid · Overdue

## Record types (0 total, 0 active)
- None: `RecordType` was retrieved by the last refresh and none is attached to this object — this empty result means "this object has no record types".

## Relationships (1 lookup field(s) to parents, 1 child object(s) pointing here, among retrieved fields)
Parents (fields on this object):
- `Project__c` → `Project__c` (MasterDetail)
Children (fields on other objects that point here):
- `Payment__c` via `Invoice__c` (1 master-detail — deletes cascade)
- A child appears only when its lookup field is in this vault with a captured target; a standard child whose lookup was not captured (e.g. a polymorphic activity lookup) is not listed.

## What runs when a record is saved (1 active component(s) in 1 step(s), in order)
Tags show which events each step fires on. Entry conditions are listed by the save tool, not evaluated here.
- — the record is written to the database —
- **Parent roll-up summaries recalculated** (1): `Total_Invoiced__c` [insert+update]
- Not in the sequence above — delete: 1 step(s) from 1 component(s) (`Total_Invoiced__c`); undelete: 1 step(s) from 1 component(s) (`Total_Invoiced__c`) (`sfi.what_happens_on_save` {"event":"delete"}).
- Other components that write this object's fields (not part of the sequence above): 1 ApexClass (`sfi.why_field_changed` per field).

## Who can access it (2 profile(s), 1 permission set(s) grant at least one object permission)
- Read: 2 profile(s) (`Verdant_Read_Only`, `Verdant_Sales_Rep`), 1 permission set(s) (`Finance_Team`)
- Create: 1 profile(s) (`Verdant_Sales_Rep`), 1 permission set(s) (`Finance_Team`)
- Edit: 1 profile(s) (`Verdant_Sales_Rep`), 1 permission set(s) (`Finance_Team`)
- Delete: none declared.
- View All: 0 profile(s), 1 permission set(s) (`Finance_Team`)
- Modify All: none declared.
- These are permission containers, not users; permission set groups are not expanded here (`sfi.object_access_audit` does that). Record-level visibility also depends on sharing.

## Integrations touching it (0)
- None found among outbound messages, named credentials/external services/connected apps that reference it, Apex REST resources that read or write it, and Change Data Capture channel members.
- Apex callouts are not attributed to an object in the vault; `sfi.endpoint_catalog` / `sfi.integration_map` list them org-wide.

## Risk signals (1)
- 1 of 6 custom field(s) have neither a description nor help text.

## Where to look next (non-core tools run through `sfi.run_analysis`)
- `sfi.what_happens_on_save` {"objectApiName":"Invoice__c","event":"update"} — the full ordered save with conditions and actions
- `sfi.object_access_audit` {"componentId":"CustomObject:Invoice__c"} — every grant incl. permission set groups
- `sfi.generate_data_dictionary` {"objectId":"CustomObject:Invoice__c"} — every field
- `sfi.field_360` {"fieldId":"CustomField:Invoice__c.Amount__c"} — everything about one field
- `sfi.object_360` {"objectApiName":"Invoice__c"} — full usage accounting (reports, pages, code)

_Reference counts read MODELED edges of mixed confidence: metadata declarations are `declared`, Apex references `parsed` or `heuristic`. Dynamic SOQL, reflective access and runtime integration payloads are invisible, so a small or zero count is never proof of disuse._

_Metadata only: counts here are components, never records. Record counts, owners and recency need the live tools (`sfi.live_count`, `sfi.live_recent_activity`). `required` is the field's declared flag; platform- and layout-required fields are not visible in field metadata._
