# Demo questions — the "Verdant Energy" synthetic org

These are curated questions to try against the bundled demo org (a fictional
residential solar installer) with **no Salesforce org of your own**:

```bash
npx -y sf-intelligence demo        # or: sfi mcp --vault examples/demo-vault
```

Each question is grounded in the demo org's real (synthetic) metadata and
exercises a different part of the engine. The tool each one leans on is noted
in `()` — you don't need to name it; the funnel routes for you.

## Change safety — "what breaks if I…?"

- **What breaks if I delete `Invoice__c.Amount__c`?** — it's summed by a roll-up
  (`Project__c.Total_Invoiced__c`), feeds a formula (`Invoice__c.Balance__c`),
  and is written by Apex. *(get_impact)*
- **Is it safe to delete `Project__c.Risk_Score__c`?** *(safe_to_delete_field)*
- **What happens if I change `Payment__c.Amount__c` from Currency to Text?**
  *(what_if_change_field_type)*
- **What if I make `Permit__c.Approved_Date__c` required?** *(what_if_make_field_required)*
- **What breaks if I deactivate the `Installation_On_Complete` flow?** *(what_if_deactivate_flow)*

## Order of execution — "what runs when I save?"

- **What happens when I save a Project?** — validation rule, the
  `Project_On_Approve` flow, the trigger, and the discount approval process.
  *(what_happens_on_save)*
- **Show me the order of execution for `Installation__c` on update.** *(order_of_execution)*

## Sharing & permissions — "who can see / do what?"

- **Why can't a `Verdant_Installer` see an Invoice?** — Invoice is Private and
  the Installer profile has no access path. *(why_cant_user_see_record)*
- **Who can access the `Payment__c` object?** *(who_can_access_object)*
- **What can the `Verdant_Read_Only` profile actually do?** *(effective_permissions)*
- **Which sharing rules touch `Project__c`?** *(generate_sharing_summary)*

## Code quality — "where's the risk?"

- **Which Apex has governor-limit risk?** — `IncentiveBatch` runs a SOQL query
  inside a loop. *(governor_limit_risks)*
- **Find hardcoded IDs in the Apex.** — `IncentiveBatch` hardcodes a record Id.
  *(find_hardcoded_values)*
- **Which test classes don't really assert anything?** *(meaningful_test_audit)*

## Schema & fields — "explain this to me"

- **Explain the `Project__c.Margin_Percent__c` formula.** *(explain_formula / explain_field)*
- **What fields does the Project object have?** *(list_components / field_360)*
- **Where is `Invoice__c.Amount__c` used across the org?** *(find_field_anywhere)*

## OmniStudio & CPQ

- **Walk the `Customer_Intake` OmniScript step by step.** *(omniscript_flow)*
- **What's the OmniStudio + CPQ footprint of this org?** *(integration_map / list_components)*

## Front door — resolve & orient

- **Where's the `paymnet` object?** — typo-tolerant; resolves to `Payment__c`. *(resolve)*
- **Give me an overview of this org.** *(org_overview)*
- **What can I ask you?** *(capabilities)*
