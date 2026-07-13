# Fixture Vault — Public Synthetic Coverage

This directory (`examples/`) is the **public synthetic fixture vault** for
`sf-intelligence`. All files here are hand-authored synthetic XML — they are
**never** copied from any real Salesforce org.

## Fixture policy

| Rule | Details |
| --- | --- |
| **No real org data** | Zero org IDs, usernames, real API keys, or customer metadata. All names are fictional (Verdant Energy theme). |
| **Privacy sources** | NEVER copy from any private or real org vault; keep every fixture fully synthetic (the CI org-leak scan enforces this). |
| **Reuse** | Synthetic shapes are derived from extractor tests in `packages/extractors/test/` and public Metadata API Developer Guide examples only. |
| **API version** | Use `61.0` in any `-meta.xml` that requires `<apiVersion>`. |

## demo-vault — `examples/demo-vault/`

The primary fixture set. Powers `sfi demo` (offline refresh, no org required).

- **Org persona:** "Verdant Energy" — fictional residential solar + battery installer.
- **Build command:** `sfi refresh --no-pull` pointed at `examples/demo-vault/source/`.
- **Spec:** [`demo-vault/DEMO-ORG-SPEC.md`](demo-vault/DEMO-ORG-SPEC.md).

### Metadata families covered (R7-F5 state)

**Core / existing before R7-F5**

| Family | DX folder |
| --- | --- |
| ApexClass | `classes/` |
| ApexTrigger | `triggers/` |
| ApprovalProcess | `approvalProcesses/` |
| Flow | `flows/` |
| Group | `groups/` |
| Layout | `layouts/` |
| CustomObject + children | `objects/` |
| OmniDataTransform | `omniDataTransforms/` |
| OmniIntegrationProcedure | `omniIntegrationProcedures/` |
| OmniScript | `omniScripts/` |
| PermissionSet | `permissionsets/` |
| Profile | `profiles/` |
| Queue | `queues/` |
| Role | `roles/` |
| SharingRule | `sharingRules/` |
| WorkflowRule | `workflows/` |

**Added in R7-F5 (R6/R6B gap families)**

| Family | DX folder | Stub file |
| --- | --- | --- |
| SamlSsoConfig | `samlssoconfigs/` | `Verdant_Energy_SSO.samlssoconfig-meta.xml` |
| StandardValueSet | `standardValueSets/` | `Status__c.standardValueSet-meta.xml` |
| MutingPermissionSet | `mutingpermissionsets/` | `Sales_Muting.mutingpermissionset-meta.xml` |
| Network | `networks/` | `VerdantPortal.network-meta.xml` |
| CustomSite | `sites/` | `VerdantPortal.site-meta.xml` |
| ExperienceBundle | `experiences/` | `VerdantPortal1.site-meta.xml` |
| Bot | `bots/` | `Verdant_Support_Agent/Verdant_Support_Agent.bot-meta.xml` |
| BotVersion | `bots/` | `Verdant_Support_Agent/v1.botVersion-meta.xml` |
| GenAiPlannerBundle | `genAiPlannerBundles/` | `Verdant_Support_Agent_v1/Verdant_Support_Agent_v1.genAiPlannerBundle-meta.xml` |
| WaveDashboard | `wave/` | `Ops_Overview.wdash-meta.xml` |
| WaveXmd | `wave/` | `Project_Pipeline.xmd-meta.xml` |
| Skill | `skills/` | `Solar_Installation.skill-meta.xml` |
| TimeSheetTemplate | `timeSheetTemplates/` | `Field_Crew_Weekly.timeSheetTemplate-meta.xml` |
| AuthProvider | `authproviders/` | `Verdant_SSO_Provider.authprovider-meta.xml` |
| NamedCredential | `namedCredentials/` | `Verdant_Permitting_API.namedCredential-meta.xml` |
| ConnectedApp | `connectedApps/` | `Verdant_Marketing_Suite.connectedApp-meta.xml` |
| Certificate | `certs/` | `Verdant_Community.crt-meta.xml` |
| TransactionSecurityPolicy | `transactionSecurityPolicies/` | `Block_Suspicious_Login.transactionSecurityPolicy-meta.xml` |
| PlatformEventChannel | `platformEventChannels/` | `Verdant_Event_Channel__chn.platformEventChannel-meta.xml` |
| PlatformEventChannelMember | `platformEventChannelMembers/` | `Verdant_Event_Member__chn.platformEventChannelMember-meta.xml` |
| GlobalValueSet | `globalValueSets/` | `Solar_Equipment_Types.globalValueSet-meta.xml` |
| NetworkAccess | `networkAccesses/` | `Office_VPN.networkAccess-meta.xml` |

For the full coverage map including types still lacking stubs, see
[`demo-vault/DEMO-ORG-SPEC.md`](demo-vault/DEMO-ORG-SPEC.md).

## Adding new fixtures

1. Check `packages/cli/src/refresh-pipeline.ts` `SUPPORTED_TYPES` to confirm the
   extractor exists.
2. Copy the minimal XML shape from `packages/extractors/test/<type>.test.ts`.
3. Replace all real names with Verdant Energy / synthetic equivalents.
4. Drop the file under `examples/demo-vault/source/main/default/<folder>/`.
5. Update the coverage tables in this file and in `demo-vault/DEMO-ORG-SPEC.md`.
6. Run `sfi refresh --no-pull` (dry-run, no org) to confirm no extractor crash.
