/**
 * Minimal happy/edge/refusal axes for v4.0 tools not yet expanded in the
 * deep-smoke PLAN tables. Keeps the drift sentinel green when the roster grows.
 */
export interface ToolPlan {
  readonly tool: string;
  readonly happy: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly edge: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly refusal: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly expectedRefusalKinds?: ReadonlyArray<string>;
}

export const V4_TOOL_PLANS: ReadonlyArray<ToolPlan> = [
  { tool: 'sfi.resolve', happy: [{ query: 'budget' }], edge: [], refusal: [{ query: '' }] },
  { tool: 'sfi.capabilities', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.route_question', happy: [{ question: 'how many accounts' }], edge: [{ question: 'meaning of life' }], refusal: [{ question: '' }] },
  { tool: 'sfi.org_pulse', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.fleet_find', happy: [{ query: 'budget' }], edge: [], refusal: [{ query: '' }] },
  { tool: 'sfi.coverage_report', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.baseline_acknowledge', happy: [{ fingerprint: 'test-fp' }], edge: [], refusal: [] },
  { tool: 'sfi.baseline_status', happy: [{}], edge: [], refusal: [] },
  {
    tool: 'sfi.live_describe',
    happy: [{ objectApiName: 'Account' }],
    edge: [],
    refusal: [{ objectApiName: '' }],
  },
  {
    tool: 'sfi.live_count',
    happy: [{ soql: 'SELECT COUNT() FROM Account' }],
    edge: [],
    refusal: [{ soql: '' }],
  },
  {
    tool: 'sfi.live_sample',
    happy: [{ soql: 'SELECT Id FROM Account LIMIT 1' }],
    edge: [],
    refusal: [{ soql: '' }],
  },
  {
    tool: 'sfi.live_field_population',
    happy: [{ objectApiName: 'Account', fieldApiName: 'Name' }],
    edge: [],
    refusal: [{ objectApiName: '', fieldApiName: '' }],
  },
  { tool: 'sfi.live_org_limits', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.org_risk_report', happy: [{ limit: 5 }], edge: [], refusal: [] },
  { tool: 'sfi.field_cleanup_candidates', happy: [{ limit: 5 }], edge: [], refusal: [] },
  { tool: 'sfi.automation_risk_report', happy: [{ limit: 5 }], edge: [], refusal: [] },
  { tool: 'sfi.permission_risk_report', happy: [{ limit: 5 }], edge: [], refusal: [] },
  { tool: 'sfi.release_readiness_report', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.churn', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.trend', happy: [{}], edge: [], refusal: [] },
  // Drift backfill: tools added to V01_TOOLS that lacked a plan entry. The
  // deep-smoke sentinel only requires every tool to be PLANNED (structured
  // errors are acceptable for these minimal axes).
  { tool: 'sfi.find_dependency_cycles', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.apex_test_coverage', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.apex_build_advisor', happy: [{}], edge: [], refusal: [] },
  { tool: 'sfi.org_history', happy: [{}], edge: [], refusal: [] },
  {
    tool: 'sfi.automation_build_advisor',
    happy: [{ objectApiName: 'Account' }],
    edge: [],
    refusal: [{ objectApiName: '' }],
    expectedRefusalKinds: ['invalid-query', 'component-not-found'],
  },
  {
    tool: 'sfi.field_change_advisor',
    happy: [{ fieldId: 'CustomField:Account.Name' }],
    edge: [],
    refusal: [{ fieldId: '' }],
    expectedRefusalKinds: ['invalid-query', 'invalid-id', 'component-not-found'],
  },
  {
    tool: 'sfi.live_drift_check',
    happy: [{ objectApiName: 'Account' }],
    edge: [],
    refusal: [{ objectApiName: '' }],
    expectedRefusalKinds: ['invalid-query'],
  },
  { tool: 'sfi.live_inactive_users', happy: [{ days: 30 }], edge: [], refusal: [] },
  { tool: 'sfi.live_consent', happy: [{}], edge: [], refusal: [] },
  {
    tool: 'sfi.live_group_count',
    happy: [{ objectApiName: 'Account', groupByField: 'Industry', liveEnabled: true }],
    edge: [],
    refusal: [{ objectApiName: '', groupByField: 'Industry' }],
    expectedRefusalKinds: ['invalid-query'],
  },
  {
    tool: 'sfi.live_stale_records',
    happy: [{ objectApiName: 'Account', staleDays: 90, liveEnabled: true }],
    edge: [],
    refusal: [{ objectApiName: '' }],
    expectedRefusalKinds: ['invalid-query'],
  },
  {
    tool: 'sfi.live_recent_activity',
    happy: [{ objectApiName: 'Account', days: 7, liveEnabled: true }],
    edge: [],
    refusal: [{ objectApiName: '' }],
    expectedRefusalKinds: ['invalid-query'],
  },
  { tool: 'sfi.live_report_usage', happy: [{ liveEnabled: true }], edge: [], refusal: [] },
  { tool: 'sfi.live_folder_access', happy: [{ liveEnabled: true }], edge: [], refusal: [] },
  { tool: 'sfi.live_email_template_usage', happy: [{ liveEnabled: true }], edge: [], refusal: [] },
  { tool: 'sfi.live_org_health', happy: [{ liveEnabled: true }], edge: [], refusal: [] },
  {
    tool: 'sfi.live_aggregate',
    happy: [{ objectApiName: 'Opportunity', fieldApiName: 'Amount', liveEnabled: true }],
    edge: [],
    refusal: [{ objectApiName: '', fieldApiName: 'Amount' }],
    expectedRefusalKinds: ['invalid-query'],
  },
  {
    tool: 'sfi.live_duplicate_check',
    happy: [{ objectApiName: 'Contact', fieldApiName: 'Email', liveEnabled: true }],
    edge: [],
    refusal: [{ objectApiName: '', fieldApiName: 'Email' }],
    expectedRefusalKinds: ['invalid-query'],
  },
  {
    tool: 'sfi.live_owner_breakdown',
    happy: [{ objectApiName: 'Account', liveEnabled: true }],
    edge: [],
    refusal: [{ objectApiName: '' }],
    expectedRefusalKinds: ['invalid-query'],
  },
  { tool: 'sfi.live_storage_by_object', happy: [{ liveEnabled: true }], edge: [], refusal: [] },
  // v4.0 roster additions — package boundary, smart test selection, license usage.
  { tool: 'sfi.package_impact', happy: [{}], edge: [{ namespace: 'SBQQ' }], refusal: [] },
  {
    tool: 'sfi.tests_for_change',
    happy: [{ changedComponents: ['ApexClass:ContactServices'] }],
    edge: [{ changedComponents: ['ApexClass:NoSuchClass_ZZZ'] }],
    refusal: [{ changedComponents: [] }],
    expectedRefusalKinds: ['invalid-query'],
  },
  { tool: 'sfi.live_license_usage', happy: [{ liveEnabled: true }], edge: [], refusal: [] },
];
