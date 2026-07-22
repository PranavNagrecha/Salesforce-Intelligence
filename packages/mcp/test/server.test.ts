/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
} from '@sf-intelligence/graph';
import { saveManifest, vaultPaths } from '@sf-intelligence/vault';

import type { Context } from '../src/server.js';
import { buildContext, createServer, shutdown } from '../src/server.js';
import { V01_TOOLS, advertisedTools, dispatchTool, toolProfile } from '../src/tools/index.js';

const sampleManifest = (): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
});

const makeVaultDir = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'sfi-mcp-server-'));

/**
 * Stage a minimum-viable vault on disk: write a manifest and pre-create
 * the `graph/` directory so `openGraph` can `CREATE` the DuckDB file
 * inside it (DuckDB does not auto-`mkdir`).
 */
const seedVault = async (vault: string): Promise<void> => {
  const paths = vaultPaths(vault);
  await mkdir(paths.graph, { recursive: true });
  const saved = await saveManifest(vault, sampleManifest());
  if (!saved.ok) throw new Error(`saveManifest failed: ${saved.error.message}`);
};

describe('buildContext', () => {
  it('returns ok with a Context when vault is well-formed', async () => {
    const vault = await makeVaultDir();
    let ctx: Context | null = null;
    try {
      await seedVault(vault);
      const result = await buildContext(vault);
      expect(result.ok).toBe(true);
      if (result.ok) {
        ctx = result.value;
        expect(ctx.vaultRoot).toBe(vault);
        expect(ctx.manifest.sourceTreeHash).toBe('sha256:fixture');
        expect(ctx.graph.connection).toBeDefined();
        expect(ctx.graph.instance).toBeDefined();
      }
    } finally {
      if (ctx !== null) await shutdown(ctx);
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('opens an existing vault graph READ-ONLY so the server cannot write it (P5-duckdb-readonly)', async () => {
    const vault = await makeVaultDir();
    let ctx: Context | null = null;
    try {
      const paths = vaultPaths(vault);
      await mkdir(paths.graph, { recursive: true });
      const saved = await saveManifest(vault, sampleManifest());
      if (!saved.ok) throw new Error(saved.error.message);
      // Pre-build a REAL graph file (so the read-only open path is taken,
      // not the read-write create-fallback).
      const opened = await openGraph(paths.graphDb);
      if (!opened.ok) throw new Error(opened.error.message);
      const seed: ExtractionResult = {
        nodes: [
          {
            id: 'CustomObject:Account',
            type: 'CustomObject',
            apiName: 'Account',
            label: 'Account',
            parentId: null,
            sourcePath: 'x',
            lastModifiedDate: null,
            lastModifiedBy: null,
            apiVersion: null,
            properties: {},
          },
        ],
        edges: [],
      };
      const imp = await importExtractionResults(opened.value, [seed]);
      if (!imp.ok) throw new Error(imp.error.message);
      await closeGraph(opened.value);

      const result = await buildContext(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      ctx = result.value;
      // The server graph handle is read-only — a write must be rejected.
      await expect(
        ctx.graph.connection.run(
          "INSERT INTO nodes VALUES ('CustomObject:X','CustomObject','X',null,null,'x',null,null,null,'{}')",
        ),
      ).rejects.toThrow();
    } finally {
      if (ctx !== null) await shutdown(ctx);
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('returns vault-missing when no manifest exists', async () => {
    const vault = await makeVaultDir();
    try {
      const result = await buildContext(vault);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('vault-missing');
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe('createServer', () => {
  it('returns a Server instance without throwing', async () => {
    const vault = await makeVaultDir();
    let ctx: Context | null = null;
    try {
      await seedVault(vault);
      const built = await buildContext(vault);
      if (!built.ok) throw new Error(built.error.message);
      ctx = built.value;
      const server = createServer(ctx);
      expect(server).toBeDefined();
      // The Server class exposes setRequestHandler; presence is a smoke
      // signal that the registration plumbing wired through cleanly.
      expect(typeof server.setRequestHandler).toBe('function');
    } finally {
      if (ctx !== null) await shutdown(ctx);
      await rm(vault, { recursive: true, force: true });
    }
  });
});

describe('dispatchTool', () => {
  // The known/unknown branches need a Context but never touch its
  // contents in v0.1, so a bare `as Context` keeps the test free of
  // filesystem setup.
  const fakeCtx = {} as Context;

  // Tools whose `mcp-tool-*` task has landed and replaced the stub. Each
  // such tool ships its own dedicated test file alongside its handler, so
  // the sweep below restricts itself to the tools still routed to the
  // not-implemented branch of `dispatchTool`.
  const IMPLEMENTED_TOOLS = new Set<string>([
    'sfi.search_components',
    'sfi.resolve',
    'sfi.capabilities',
    'sfi.list_analyses',
    'sfi.describe_analysis',
    'sfi.run_analysis',
    'sfi.synthesize_answer',
    'sfi.route_question',
    'sfi.org_pulse',
    'sfi.org_card',
    'sfi.fleet_find',
    'sfi.fleet_drift_ranking',
    'sfi.get_component',
    'sfi.limit_headroom_report',
    'sfi.list_components',
    'sfi.get_edges',
    'sfi.get_subgraph',
    'sfi.query_graph',
    'sfi.search_apex_source',
    'sfi.search_flow_metadata',
    'sfi.get_naming_convention_report',
    'sfi.get_manifest',
    'sfi.coverage_report',
    'sfi.retrieve_blindspot_report',
    'sfi.health_check',
    'sfi.baseline_acknowledge',
    'sfi.baseline_status',
    'sfi.churn',
    'sfi.trend',
    'sfi.live_describe',
    'sfi.live_stale_check',
    'sfi.live_count',
    'sfi.live_sample',
    'sfi.live_field_population',
    'sfi.live_group_count',
    'sfi.live_stale_records',
    'sfi.live_recent_activity',
    'sfi.live_aggregate',
    'sfi.live_duplicate_check',
    'sfi.live_owner_breakdown',
    'sfi.live_record_access',
    'sfi.live_record_shares',
    'sfi.live_scheduled_jobs',
    'sfi.live_field_history',
    'sfi.live_storage_by_object',
    'sfi.live_org_limits',
    // decision 5 — wired the dark live pair (data-skew + security-exposure).
    'sfi.live_data_skew',
    'sfi.live_security_exposure',
    'sfi.live_inactive_users',
    'sfi.live_permset_holders',
    'sfi.live_zombie_accounts',
    'sfi.live_group_members',
    'sfi.live_user_permsets',
    'sfi.live_setup_audit_trail',
    'sfi.live_license_usage',
    'sfi.live_consent',
    'sfi.live_report_usage',
    'sfi.live_folder_access',
    'sfi.live_email_template_usage',
    'sfi.live_org_health',
    'sfi.live_automation_fired',
    'sfi.live_budget',
    'sfi.live_picklist_usage',
    'sfi.org_risk_report',
    'sfi.field_cleanup_candidates',
    'sfi.automation_risk_report',
    'sfi.permission_risk_report',
    'sfi.release_readiness_report',
    'sfi.get_impact',
    'sfi.blast_radius_live',
    'sfi.find_formula_references',
    'sfi.find_apex_usages',
    'sfi.effective_permissions',
    'sfi.who_can_run',
    'sfi.who_can_access_object',
    'sfi.guest_exposure_report',
    'sfi.why_cant_user_see_record',
    'sfi.layout_for_user',
    'sfi.user_ability',
    'sfi.profile_security',
    'sfi.lightning_pages',
    'sfi.list_view_sharing',
    'sfi.app_access',
    'sfi.tab_availability',
    'sfi.lifecycle_process',
    'sfi.layout_assignments',
    'sfi.integration_map',
    'sfi.event_subscribers',
    'sfi.guidance',
    'sfi.find_code_usages',
    'sfi.lookup_record',
    'sfi.explain_field',
    'sfi.safe_to_delete_field',
    'sfi.unused_components',
    'sfi.find_dependency_cycles',
    'sfi.apex_test_coverage',
    'sfi.automation_build_advisor',
    'sfi.automation_collisions',
    'sfi.ai_exposure_report',
    'sfi.apex_build_advisor',
    'sfi.field_change_advisor',
    'sfi.what_if_change_field_value',
    'sfi.value_change_audit',
    'sfi.live_drift_check',
    'sfi.org_history',
    'sfi.what_changed_since_refresh',
    'sfi.diff_snapshots',
    'sfi.compare_components',
    'sfi.export_manifest',
    'sfi.pii_inventory',
    'sfi.field_access_audit',
    'sfi.object_access_audit',
    'sfi.recordtype_availability',
    'sfi.org_overview',
    'sfi.domain_clusters',
    'sfi.changed_since',
    'sfi.last_modified',
    'sfi.what_happens_on_save',
    'sfi.why_field_changed',
    'sfi.order_of_execution',
    // decision 5 — wired the dark record-provenance + flow-fault-hygiene tools.
    'sfi.record_creation_paths',
    'sfi.explain_flow',
    'sfi.flow_graph',
    'sfi.flow_bulkification_audit',
    'sfi.flow_trace',
    'sfi.flow_fault_audit',
    'sfi.explain_apex_method',
    'sfi.explain_formula',
    'sfi.unused_fields_deep',
    'sfi.process_builder_migration_candidates',
    'sfi.unassigned_permission_sets',
    'sfi.empty_queues_and_groups',
    'sfi.tech_debt_score',
    // v2.1 R3 — code-quality composer tools.
    'sfi.code_quality_audit',
    'sfi.governor_limit_risks',
    'sfi.find_hardcoded_values',
    'sfi.crud_fls_audit',
    'sfi.test_coverage_gaps',
    // v2.3 R2a — what-if field-level tools.
    'sfi.what_if_change_field_type',
    'sfi.what_if_remove_picklist_value',
    'sfi.what_if_make_field_required',
    // v2.3 R2b — what-if component-level tools.
    'sfi.what_if_deactivate_flow',
    'sfi.what_if_disable_trigger',
    'sfi.what_if_change_method_signature',
    // v2.3 R2c — what-if profile-level tools.
    'sfi.what_if_merge_profiles',
    'sfi.what_if_split_profile',
    // R7-C1 — what-if permission-set delta tools.
    'sfi.what_if_assign_permset',
    'sfi.what_if_revoke_permset',
    // v2.5 — documentation-generation tier.
    'sfi.generate_data_dictionary',
    'sfi.generate_admin_handbook',
    'sfi.generate_architecture_overview',
    'sfi.generate_sharing_summary',
    'sfi.generate_compliance_report',
    'sfi.generate_onboarding_doc',
    // v2.7 R2 — deep code understanding tier (class granularity).
    'sfi.call_graph',
    'sfi.downstream_effects',
    'sfi.test_coverage_for_method',
    'sfi.meaningful_test_audit',
    'sfi.method_reachability',
    // tests-for-change — smart test selection (test-impact analysis).
    'sfi.tests_for_change',
    // R6-16 — pre-deploy change-review gate.
    'sfi.review_change',
    // v2.8 R2 — async + integration deep tier.
    'sfi.cdc_subscribers',
    'sfi.async_chain_depth',
    'sfi.scheduled_job_catalog',
    'sfi.outbound_message_catalog',
    'sfi.endpoint_catalog',
    // v2.9 R4 — vocabulary + semantic-disambiguation tier.
    'sfi.field_meaning',
    'sfi.disambiguate_concepts',
    'sfi.field_provenance',
    // v2.2 R2 — universal find-anywhere + discovery surface.
    'sfi.find_field_anywhere',
    'sfi.find_semantic_field',
    'sfi.find_hardcoded_values_anywhere',
    'sfi.find_clone_patterns',
    'sfi.find_dead_code',
    // package_impact — managed-package boundary surface.
    'sfi.package_impact',
    // v3.0 — unified field forensics synthesis tier.
    'sfi.field_360',
    'sfi.field_lineage',
    // CPQ specialty tier.
    'sfi.cpq_rule_chain',
    'sfi.cpq_quote_template_breakdown',
    'sfi.cpq_dependency_map',
    // v3.1 — cross-org / sandbox-vs-prod comparison tier.
    'sfi.compare_vaults',
    'sfi.promotion_readiness',
    'sfi.compare_object_across_vaults',
    'sfi.compare_profile_across_vaults',
    'sfi.field_mapping_between_objects',
    // v3.2 — OmniStudio composition tier (DataRaptor field-mapping table).
    'sfi.datatransform_field_map',
    // v3.2 — OmniStudio declarative-process tier (DecisionTable browse).
    'sfi.decision_table_browse',
    // v3.2 R3b — OmniStudio "walk this IP's action chain" Q177 surface.
    'sfi.integration_procedure_chain',
    // v3.2 R3a — OmniStudio "walk this OmniScript end-to-end" surface.
    'sfi.omniscript_flow',
    // v3.2 R3d — OmniStudio "what's inside this FlexCard" surface.
    'sfi.omniuicard_widget_breakdown',
    // 0.1.8 — universal usage dispatcher + installed-package catalog.
    'sfi.find_component_usages',
    'sfi.installed_package_catalog',
    // P13-ANNOT-tools — curated annotations overlay (read + AI propose).
    'sfi.annotations',
    'sfi.propose_annotation',
    // R8-ANNOTATION-REVIEW — MCP review/confirm/reject loop.
    'sfi.review_annotations',
    'sfi.confirm_annotation',
    'sfi.reject_annotation',
    // P13-GITHIST-tools — vault git history consumers.
    'sfi.component_history',
    'sfi.component_change_attribution',
    'sfi.component_as_of',
    // R6-09 — error-to-source decoder.
    'sfi.explain_error',
    // Finding #40 — debug-log / governor-limit runtime decoder.
    'sfi.explain_debug_log',
    // R7-W7 — field-history-tracking compliance-gap composer.
    'sfi.history_tracking_gaps',
    // R7-C6 — fleet digest across the vault registry.
    'sfi.generate_fleet_report',
    // RM-wire — deterministic reasoning-engine surface.
    'sfi.interpret',
  ]);

  it('returns the not-implemented envelope for every stubbed tool name', async () => {
    for (const tool of V01_TOOLS) {
      if (IMPLEMENTED_TOOLS.has(tool.name)) continue;
      const result = await dispatchTool(fakeCtx, tool.name, {});
      expect(result.content[0]?.type).toBe('text');
      const body = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      ) as { error: string; toolName: string };
      expect(body.error).toBe('not-implemented');
      expect(body.toolName).toBe(tool.name);
    }
  });

  it('returns the unknown-tool envelope for an unregistered name', async () => {
    const result = await dispatchTool(fakeCtx, 'sfi.does_not_exist', {});
    expect(result.content[0]?.type).toBe('text');
    const body = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { error: string; toolName: string };
    expect(body.error).toBe('unknown-tool');
    expect(body.toolName).toBe('sfi.does_not_exist');
  });

  it('serializes a Zod schema rejection as a concise human invalid-query message (not the raw issues JSON)', async () => {
    // `sfi.test_coverage_for_method` requires `classApiName`; dispatching
    // with `{}` trips the Zod parse in `runTool`. The serialized message
    // must be a short human string, NOT the pretty-printed `issues` JSON
    // array (the ~2.4 KB blob `error.message` used to return).
    // dispatchTool reads `ctx.manifest.sourceTreeHash` for its audit log
    // BEFORE it validates args, so a registered tool needs a ctx with a
    // manifest (the shared `fakeCtx` is `{}`). The handler is never reached —
    // the Zod parse fails first, which is exactly what this test exercises.
    const ctxWithManifest = {
      manifest: { sourceTreeHash: 'sha256:test' },
    } as unknown as Context;
    const result = await dispatchTool(
      ctxWithManifest,
      'sfi.test_coverage_for_method',
      {},
    );
    expect(result.content[0]?.type).toBe('text');
    const body = JSON.parse(
      (result.content[0] as { type: 'text'; text: string }).text,
    ) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe('invalid-query');
    // Human message references the offending field path and is concise.
    expect(body.error.message).toContain('classApiName');
    // Must NOT be the raw Zod issues JSON array.
    expect(body.error.message.trimStart().startsWith('[')).toBe(false);
    expect(body.error.message).not.toContain('"code":');
  });

  it('R6-27: sfi.live_setup_audit_trail is REGISTERED — dispatches to the real handler, not unknown-tool/not-implemented', async () => {
    // Regression pin for the exact bug this task fixes: the handler + schema
    // existed in live-plane.ts but the tool was never added to the
    // tools/index.ts roster, so a live probe against a real vault returned
    // `unknown-tool`. Dispatching through the REAL switch statement (not the
    // handler directly) is the only way to catch that class of gap.
    // Isolate the consent store so this dispatch is hermetic — never let the
    // real ~/.sf-intelligence/live-consent.json leak in (would defeat the
    // fail-closed assertion below) and never crash on a missing sourceOrg.
    const prevConsentPath = process.env.SFI_CONSENT_PATH;
    process.env.SFI_CONSENT_PATH = join(
      tmpdir(),
      `sfi-consent-server-test-${process.pid}-never.json`,
    );
    try {
      const ctxWithManifest = {
        manifest: { sourceTreeHash: 'sha256:test', sourceOrg: 'test-org' },
      } as unknown as Context;
      const result = await dispatchTool(ctxWithManifest, 'sfi.live_setup_audit_trail', {});
      expect(result.content[0]?.type).toBe('text');
      const body = JSON.parse(
        (result.content[0] as { type: 'text'; text: string }).text,
      ) as { error?: { kind?: string; message?: string } | string; toolName?: string };
      expect(body.error).not.toBe('unknown-tool');
      expect(body.error).not.toBe('not-implemented');
      // No consent/liveEnabled passed — the registered handler still fails
      // CLOSED (gateLive), never silently substituting a vault answer.
      const err = body.error as { kind?: string; message?: string };
      expect(err.kind).toBe('invalid-query');
      expect(err.message).toMatch(/live org plane is not enabled/i);
    } finally {
      if (prevConsentPath === undefined) delete process.env.SFI_CONSENT_PATH;
      else process.env.SFI_CONSENT_PATH = prevConsentPath;
    }
  });
});

describe('tool profiles (P13-GW-profiles)', () => {
  afterEach(() => {
    delete process.env['SFI_TOOL_PROFILE'];
  });

  it('defaults to the FULL roster minus hidden aliases — zero behavior change without the env', () => {
    delete process.env['SFI_TOOL_PROFILE'];
    expect(toolProfile()).toBe('full');
    // `advertisedTools()` excludes hidden back-compat aliases; equal to the full
    // roster with hidden filtered out (identical to V01_TOOLS when none hidden).
    expect(advertisedTools()).toEqual(V01_TOOLS.filter((t) => !t.hidden));
  });

  it('core advertises exactly the 18 core schemas, in V01 order', () => {
    process.env['SFI_TOOL_PROFILE'] = 'core';
    expect(toolProfile()).toBe('core');
    const names = advertisedTools().map((t) => t.name);
    expect(names).toHaveLength(18);
    // V01 order preserved (filter, not re-sort):
    const fullOrder = V01_TOOLS.map((t) => t.name).filter((n) => names.includes(n));
    expect(names).toEqual(fullOrder);
    // The gateway + orientation backbone is all present:
    for (const must of [
      'sfi.resolve', 'sfi.route_question', 'sfi.org_card', 'sfi.capabilities',
      'sfi.list_analyses', 'sfi.describe_analysis', 'sfi.run_analysis',
      'sfi.health_check', 'sfi.synthesize_answer',
    ]) {
      expect(names).toContain(must);
    }
  });

  it('an unknown profile value falls back to full (never an empty roster)', () => {
    process.env['SFI_TOOL_PROFILE'] = 'tiny';
    expect(toolProfile()).toBe('full');
    expect(advertisedTools()).toHaveLength(
      V01_TOOLS.filter((t) => !t.hidden).length,
    );
  });
});

describe('V01_TOOLS', () => {
  it('advertises the 10 v0.1, 2 v0.2 architect, 1 v0.3 developer, 1 v1.1 admin, 1 v1.2 admin, 2 v1.5 architect, 1 v1.4 developer, 2 v1.6 business-user, 2 v2.0b composition, 2 v2.0c snapshot/compare, 2 v2.0d compliance/privacy, 2 v2.0g org-tour, 2 v1.7 freshness, 3 v2.0e lifecycle-narrator, 3 v2.0f explainer, 5 v2.4 hygiene, 5 v2.1 R3 code-quality composer, 3 v2.3 R2a what-if field-level, 2 value-change (what_if_change_field_value, value_change_audit), 3 v2.3 R2b what-if component-level, 2 v2.3 R2c what-if profile-level, 6 v2.5 documentation-generation, 5 v2.7 R2 deep code, 1 tests-for-change selection, 1 review-change deploy gate, 5 v2.8 R2 async/integration deep, 3 v2.9 R4 vocabulary, 5 v2.2 R2 find-anywhere, 1 package-impact boundary surface, 4 v3.1 cross-org, 5 v3.2 OmniStudio composer (datatransform-field-map, decision-table-browse, integration-procedure-chain, omniscript-flow, omniuicard-widget-breakdown), 1 capabilities self-description, 1 synthesize-answer answer-layer tool, 1 guidance knowledge-plane tool, 2 fleet/pulse tools (org-pulse, fleet-find), 1 universal usage dispatcher (find-component-usages), 1 installed-package catalog (installed-package-catalog), 1 automation-collision detector (automation-collisions), 1 live setup-audit-trail tool (live_setup_audit_trail, R6-27), 1 AI-exposure audit (ai-exposure-report), 1 guest-exposure report (guest-exposure-report), and 1 history-tracking-gaps compliance audit (R7-W7), and 1 interpret reasoning-engine surface (RM-wire), and 1 limit-headroom report (limit_headroom_report, org-ops)', () => {
    const names = V01_TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      'sfi.search_components',
      'sfi.resolve',
      'sfi.capabilities',
      'sfi.list_analyses',
      'sfi.describe_analysis',
      'sfi.run_analysis',
      'sfi.synthesize_answer',
      'sfi.route_question',
      'sfi.org_pulse',
      'sfi.org_card',
      'sfi.fleet_find',
      'sfi.fleet_drift_ranking',
      'sfi.generate_fleet_report',
      'sfi.get_component',
      'sfi.limit_headroom_report',
      'sfi.list_components',
      'sfi.get_edges',
      'sfi.get_subgraph',
      'sfi.query_graph',
      'sfi.search_apex_source',
      'sfi.search_flow_metadata',
      'sfi.get_naming_convention_report',
      'sfi.get_manifest',
      'sfi.coverage_report',
      'sfi.retrieve_blindspot_report',
      'sfi.health_check',
      'sfi.baseline_acknowledge',
      'sfi.baseline_status',
      'sfi.live_describe',
      'sfi.live_stale_check',
      'sfi.live_count',
      'sfi.live_sample',
      'sfi.live_field_population',
      'sfi.live_group_count',
      'sfi.live_stale_records',
      'sfi.live_recent_activity',
      'sfi.live_aggregate',
      'sfi.live_duplicate_check',
      'sfi.live_owner_breakdown',
      'sfi.live_record_access',
      'sfi.live_record_shares',
      'sfi.live_scheduled_jobs',
      'sfi.live_field_history',
      'sfi.live_storage_by_object',
      'sfi.live_org_limits',
      'sfi.live_data_skew',
      'sfi.live_security_exposure',
      'sfi.live_inactive_users',
      'sfi.live_permset_holders',
      'sfi.live_zombie_accounts',
      'sfi.live_group_members',
      'sfi.live_user_permsets',
      'sfi.live_setup_audit_trail',
      'sfi.live_license_usage',
      'sfi.live_consent',
      'sfi.live_report_usage',
      'sfi.live_folder_access',
      'sfi.live_email_template_usage',
      'sfi.live_org_health',
      'sfi.live_automation_fired',
      'sfi.live_picklist_usage',
      'sfi.live_budget',
      'sfi.org_risk_report',
      'sfi.field_cleanup_candidates',
      'sfi.automation_risk_report',
      'sfi.permission_risk_report',
      'sfi.release_readiness_report',
      'sfi.get_impact',
      'sfi.blast_radius_live',
      'sfi.find_formula_references',
      'sfi.find_apex_usages',
      'sfi.effective_permissions',
      'sfi.who_can_run',
      'sfi.who_can_access_object',
      'sfi.guest_exposure_report',
      'sfi.why_cant_user_see_record',
      'sfi.layout_for_user',
      'sfi.user_ability',
      'sfi.profile_security',
      'sfi.lightning_pages',
      'sfi.list_view_sharing',
      'sfi.app_access',
      'sfi.tab_availability',
      'sfi.lifecycle_process',
      'sfi.layout_assignments',
      'sfi.integration_map',
      'sfi.event_subscribers',
      'sfi.guidance',
      'sfi.find_code_usages',
      'sfi.lookup_record',
      'sfi.explain_field',
      'sfi.safe_to_delete_field',
      'sfi.unused_components',
      'sfi.find_dependency_cycles',
      'sfi.apex_test_coverage',
      'sfi.automation_build_advisor',
      'sfi.automation_collisions',
      'sfi.ai_exposure_report',
      'sfi.apex_build_advisor',
      'sfi.field_change_advisor',
      'sfi.what_if_change_field_value',
      'sfi.value_change_audit',
      'sfi.live_drift_check',
      'sfi.what_changed_since_refresh',
      'sfi.org_history',
      'sfi.diff_snapshots',
      'sfi.churn',
      'sfi.trend',
      'sfi.compare_components',
      'sfi.export_manifest',
      'sfi.pii_inventory',
      'sfi.field_access_audit',
      'sfi.object_access_audit',
      'sfi.recordtype_availability',
      'sfi.org_overview',
      'sfi.domain_clusters',
      'sfi.changed_since',
      'sfi.last_modified',
      'sfi.what_happens_on_save',
      'sfi.why_field_changed',
      'sfi.order_of_execution',
      'sfi.record_creation_paths',
      'sfi.explain_flow',
      'sfi.flow_graph',
      'sfi.flow_bulkification_audit',
      'sfi.flow_trace',
      'sfi.flow_fault_audit',
      'sfi.explain_apex_method',
      'sfi.explain_formula',
      'sfi.unused_fields_deep',
      'sfi.process_builder_migration_candidates',
      'sfi.unassigned_permission_sets',
      'sfi.empty_queues_and_groups',
      'sfi.tech_debt_score',
      'sfi.code_quality_audit',
      'sfi.governor_limit_risks',
      'sfi.find_hardcoded_values',
      'sfi.crud_fls_audit',
      'sfi.test_coverage_gaps',
      'sfi.what_if_change_field_type',
      'sfi.what_if_remove_picklist_value',
      'sfi.what_if_make_field_required',
      'sfi.what_if_deactivate_flow',
      'sfi.what_if_disable_trigger',
      'sfi.what_if_change_method_signature',
      'sfi.what_if_merge_profiles',
      'sfi.what_if_split_profile',
      'sfi.what_if_assign_permset',
      'sfi.what_if_revoke_permset',
      'sfi.generate_data_dictionary',
      'sfi.generate_admin_handbook',
      'sfi.generate_architecture_overview',
      'sfi.generate_sharing_summary',
      'sfi.generate_compliance_report',
      'sfi.generate_onboarding_doc',
      'sfi.call_graph',
      'sfi.downstream_effects',
      'sfi.test_coverage_for_method',
      'sfi.meaningful_test_audit',
      'sfi.method_reachability',
      'sfi.tests_for_change',
      'sfi.review_change',
      'sfi.cdc_subscribers',
      'sfi.async_chain_depth',
      'sfi.scheduled_job_catalog',
      'sfi.outbound_message_catalog',
      'sfi.endpoint_catalog',
      'sfi.field_meaning',
      'sfi.disambiguate_concepts',
      'sfi.field_provenance',
      'sfi.interpret',
      'sfi.find_field_anywhere',
      'sfi.find_semantic_field',
      'sfi.find_hardcoded_values_anywhere',
      'sfi.find_clone_patterns',
      'sfi.find_dead_code',
      'sfi.package_impact',
      'sfi.cpq_rule_chain',
      'sfi.cpq_quote_template_breakdown',
      'sfi.cpq_dependency_map',
      'sfi.field_360',
      'sfi.field_lineage',
      'sfi.compare_vaults',
      'sfi.promotion_readiness',
      'sfi.compare_object_across_vaults',
      'sfi.compare_profile_across_vaults',
      'sfi.field_mapping_between_objects',
      'sfi.datatransform_field_map',
      'sfi.decision_table_browse',
      'sfi.integration_procedure_chain',
      'sfi.omniscript_flow',
      'sfi.omniuicard_widget_breakdown',
      'sfi.find_component_usages',
      'sfi.installed_package_catalog',
      'sfi.annotations',
      'sfi.propose_annotation',
      'sfi.review_annotations',
      'sfi.confirm_annotation',
      'sfi.reject_annotation',
      'sfi.component_history',
      'sfi.component_change_attribution',
      'sfi.component_as_of',
      'sfi.explain_error',
      'sfi.explain_debug_log',
      'sfi.history_tracking_gaps',
    ]);
  });
});
