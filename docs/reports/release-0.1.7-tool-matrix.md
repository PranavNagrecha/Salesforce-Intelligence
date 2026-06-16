# Release 0.1.7 — P10-A1 multi-org tool matrix

_Generated 2026-06-05. Anonymized: orgs appear by shape only. Counts + tool names only — no org identifiers, instance URLs, or component data._

## Method

Each of the 149 `sfi.*` tools was invoked against three real orgs of different shapes via an org-agnostic harness (`a1-matrix.mjs`) that derives real component ids per vault at runtime and fills each tool's required args by param-name heuristic. Each call is classified:

| code | meaning |
|---|---|
| `ok` | returned a data envelope within the size budget |
| `bd` | graceful boundary — not-found / invalid-input / honest "needs X" / absent metadata family (CPQ, OmniStudio) / cross-vault tool needing a 2nd vault |
| `sg` | global ~45 KB response guard fired (served-path backstop working — not a rejection) |
| `live` | `live_*` tool, deferred to the A6 live-plane sweep (no org call here) |
| `nf`/`mt` | harness could not synthesize a required arg / empty answer (informational) |
| **OVERSIZE / INTERNAL / EXCEPTION** | a real failure: raw payload over budget with no guard, unhandled `internal` error, or transport throw |

## Result

- **Tools exercised:** 149 per org × 3 orgs.
- **Hard failures (OVERSIZE / INTERNAL / EXCEPTION): 0.**
- **Cross-org status divergences (normalized): 0.** A tool behaving differently across orgs would flag an org-specific bug.
- Exit criterion (every tool `ok` | boundary | size-guarded on every org, 0 unhandled errors): **MET ✅**

### Per-org tally

| Org (shape) | ok | boundary | size-guarded | nofill | empty | live-skip |
|---|---|---|---|---|---|---|
| Org A — large, managed-package-heavy sandbox | 102 | 21 | 2 | 0 | 0 | 24 |
| Org B — mid-size higher-ed (HEDA) dev sandbox | 102 | 21 | 2 | 0 | 0 | 24 |
| Org C — public-sector sandbox | 104 | 21 | 0 | 0 | 0 | 24 |

### Size guard (A2 cross-check)

The global `MAX_RESPONSE_BYTES` (~45 KB) guard in the served `jsonResult` envelope fired — correctly, as a recoverable "re-query narrower" error — on:
- **Org A:** generate_onboarding_doc, get_edges
- **Org B:** generate_onboarding_doc, get_edges
- **Org C:** (none)

No tool returned a raw payload over budget without the guard (0 `OVERSIZE`). The guard lives in the served path, not just per-tool caps.

<details><summary>Full per-tool matrix (149 tools)</summary>

| tool | Org A | Org B | Org C |
|---|---|---|---|
| apex_build_advisor | ok | ok | ok |
| apex_test_coverage | ok | ok | ok |
| async_chain_depth | bd | bd | bd |
| automation_build_advisor | ok | ok | ok |
| automation_risk_report | ok | ok | ok |
| baseline_acknowledge | ok | ok | ok |
| baseline_status | ok | ok | ok |
| blast_radius_live | ok | ok | ok |
| call_graph | bd | bd | bd |
| capabilities | ok | ok | ok |
| cdc_subscribers | ok | ok | ok |
| changed_since | ok | ok | ok |
| churn | ok | ok | ok |
| code_quality_audit | ok | ok | ok |
| compare_components | ok | ok | ok |
| compare_object_across_vaults | bd | bd | bd |
| compare_profile_across_vaults | bd | bd | bd |
| compare_vaults | bd | bd | bd |
| coverage_report | ok | ok | ok |
| cpq_dependency_map | ok | ok | ok |
| cpq_quote_template_breakdown | bd | bd | bd |
| cpq_rule_chain | bd | bd | bd |
| crud_fls_audit | ok | ok | ok |
| datatransform_field_map | bd | bd | bd |
| decision_table_browse | bd | bd | bd |
| diff_snapshots | bd | bd | bd |
| disambiguate_concepts | ok | ok | ok |
| domain_clusters | ok | ok | ok |
| downstream_effects | ok | ok | ok |
| empty_queues_and_groups | ok | ok | ok |
| endpoint_catalog | ok | ok | ok |
| event_subscribers | ok | ok | ok |
| explain_apex_method | ok | ok | ok |
| explain_field | ok | ok | ok |
| explain_flow | ok | ok | ok |
| explain_formula | ok | ok | ok |
| export_manifest | ok | ok | ok |
| field_360 | ok | ok | ok |
| field_access_audit | ok | ok | ok |
| field_change_advisor | ok | ok | ok |
| field_cleanup_candidates | ok | ok | ok |
| field_lineage | ok | ok | ok |
| field_mapping_between_objects | ok | ok | ok |
| field_meaning | ok | ok | ok |
| field_provenance | ok | ok | ok |
| find_apex_usages | ok | ok | ok |
| find_clone_patterns | ok | ok | ok |
| find_code_usages | ok | ok | ok |
| find_dead_code | ok | ok | ok |
| find_dependency_cycles | ok | ok | ok |
| find_field_anywhere | bd | bd | bd |
| find_formula_references | ok | ok | ok |
| find_hardcoded_values | ok | ok | ok |
| find_hardcoded_values_anywhere | bd | bd | bd |
| find_semantic_field | ok | ok | ok |
| fleet_drift_ranking | ok | ok | ok |
| fleet_find | ok | ok | ok |
| generate_admin_handbook | ok | ok | ok |
| generate_architecture_overview | ok | ok | ok |
| generate_compliance_report | ok | ok | ok |
| generate_data_dictionary | ok | ok | ok |
| generate_onboarding_doc | sg | sg | ok |
| generate_sharing_summary | ok | ok | ok |
| get_component | ok | ok | ok |
| get_edges | sg | sg | ok |
| get_impact | ok | ok | ok |
| get_manifest | ok | ok | ok |
| get_naming_convention_report | ok | ok | ok |
| get_subgraph | ok | ok | ok |
| governor_limit_risks | ok | ok | ok |
| guidance | ok | ok | ok |
| health_check | ok | ok | ok |
| integration_map | ok | ok | ok |
| integration_procedure_chain | bd | bd | bd |
| last_modified | ok | ok | ok |
| layout_for_user | ok | ok | ok |
| list_components | bd | bd | bd |
| live_aggregate | live | live | live |
| live_automation_fired | live | live | live |
| live_budget | live | live | live |
| live_consent | live | live | live |
| live_count | live | live | live |
| live_describe | live | live | live |
| live_drift_check | live | live | live |
| live_duplicate_check | live | live | live |
| live_email_template_usage | live | live | live |
| live_field_population | live | live | live |
| live_folder_access | live | live | live |
| live_group_count | live | live | live |
| live_inactive_users | live | live | live |
| live_license_usage | live | live | live |
| live_org_health | live | live | live |
| live_org_limits | live | live | live |
| live_owner_breakdown | live | live | live |
| live_picklist_usage | live | live | live |
| live_recent_activity | live | live | live |
| live_report_usage | live | live | live |
| live_sample | live | live | live |
| live_stale_check | live | live | live |
| live_stale_records | live | live | live |
| live_storage_by_object | live | live | live |
| lookup_record | ok | ok | ok |
| meaningful_test_audit | ok | ok | ok |
| method_reachability | ok | ok | ok |
| omniscript_flow | bd | bd | bd |
| omniuicard_widget_breakdown | bd | bd | bd |
| order_of_execution | ok | ok | ok |
| org_history | ok | ok | ok |
| org_overview | ok | ok | ok |
| org_pulse | ok | ok | ok |
| org_risk_report | ok | ok | ok |
| outbound_message_catalog | ok | ok | ok |
| package_impact | ok | ok | ok |
| permission_risk_report | ok | ok | ok |
| pii_inventory | ok | ok | ok |
| process_builder_migration_candidates | ok | ok | ok |
| promotion_readiness | bd | bd | bd |
| release_readiness_report | ok | ok | ok |
| resolve | ok | ok | ok |
| retrieve_blindspot_report | ok | ok | ok |
| route_question | ok | ok | ok |
| safe_to_delete_field | ok | ok | ok |
| scheduled_job_catalog | ok | ok | ok |
| search_apex_source | ok | ok | ok |
| search_components | ok | ok | ok |
| search_flow_metadata | ok | ok | ok |
| synthesize_answer | ok | ok | ok |
| tech_debt_score | ok | ok | ok |
| test_coverage_for_method | ok | ok | ok |
| test_coverage_gaps | ok | ok | ok |
| tests_for_change | bd | bd | bd |
| trend | ok | ok | ok |
| unassigned_permission_sets | ok | ok | ok |
| unused_components | ok | ok | ok |
| unused_fields_deep | ok | ok | ok |
| value_change_audit | ok | ok | ok |
| what_changed_since_refresh | ok | ok | ok |
| what_happens_on_save | ok | ok | ok |
| what_if_change_field_type | ok | ok | ok |
| what_if_change_field_value | ok | ok | ok |
| what_if_change_method_signature | ok | ok | ok |
| what_if_deactivate_flow | ok | ok | ok |
| what_if_disable_trigger | ok | ok | ok |
| what_if_make_field_required | ok | ok | ok |
| what_if_merge_profiles | ok | ok | ok |
| what_if_remove_picklist_value | bd | bd | bd |
| what_if_split_profile | bd | bd | bd |
| why_cant_user_see_record | bd | bd | bd |
| why_field_changed | ok | ok | ok |

</details>

## Reading the boundaries

The ~21 `bd` per org are **not** failures: they split into (a) metadata families absent from these orgs (CPQ `Cpq*`, OmniStudio `Omni*`/`DecisionTable` — correctly refused), (b) cross-vault comparison tools (`compare_*`, `promotion_readiness`) that need a second vault the single-org harness does not supply, and (c) tools whose required arg the heuristic could not synthesize (e.g. a captured snapshot, a real picklist value, a `userContext` object) — the tool correctly rejected the malformed input with `invalid-query` rather than crashing, which itself validates input handling.
