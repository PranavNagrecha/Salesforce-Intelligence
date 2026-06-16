// NL question harness — routes a natural-language battery through the front
// door (sfi.route_question), EXECUTES the concrete tool the router picks, and
// compares routing + outcomes across BOTH sandboxes side by side. This is the
// "every question is built, harnessed, and answers compared" net: a question
// that BUGs, or routes differently on two orgs, is flagged by question text.
//
// Run (build first):
//   pnpm --filter @sf-intelligence/mcp build
//   STRESS_VAULTS="a=/abs/a/org-kb,b=/abs/b/org-kb" node eval/nl-harness.mjs
// Add NL_LIVE=1 to actually query the live org for live/hybrid routes (else
// live tools are expected to fail-closed, which still PASSES the routing check).
//
// No org identifiers or machine paths are committed here; a real run always sets
// STRESS_VAULTS / NL_VAULTS.

import { performance } from 'node:perf_hooks';

import { buildContext, shutdown } from '../packages/mcp/dist/src/server.js';
import { dispatchTool, V01_TOOLS } from '../packages/mcp/dist/src/tools/index.js';

// The battery — the owner's catalog + the reference questions. Each must route
// the same way on every org and never BUG.
const QUESTIONS = [
  'How many Accounts are in the org?',
  'How many Opportunities do we have in production?',
  "Who hasn't logged in in the last 30 days?",
  'Show me the dormant users',
  'Is the Industry field actually populated?',
  'How many Contacts have Email filled?',
  'What are the org limits right now?',
  'How much data storage are we using?',
  'Show me 5 sample Account records',
  'Does the vault match production?',
  'How many reports in the system are useless?',
  'What report types do we have?',
  'What folders do people have access to for reports?',
  'What email templates are used?',
  'Which legacy email templates should be moved?',
  'Who can edit the email field?',
  'Who has access to what fields?',
  'Who has access to the Account page layout?',
  'Who is over-permissioned with Modify All Data?',
  'What is the trigger order of Account?',
  'What happens when a Case is created?',
  'What breaks if I delete the status field?',
  'How many of our fields are actually used?',
  'Find every hardcoded record ID in Apex',
  'What custom objects do we have?',
  'What fields does Opportunity have?',
  'What calls the account service class?',
  'Which flows reference the status field?',
  "What's our naming convention for date fields?",
  'What changed in the org since last week?',
];

const DEFAULT_VAULTS = [
  { name: 'vault-a', path: './vault-a/org-kb' },
  { name: 'vault-b', path: './vault-b/org-kb' },
];
const vaults = process.env.NL_VAULTS
  ? process.env.NL_VAULTS.split(',').map((s) => { const [name, path] = s.split('='); return { name, path }; })
  : process.env.STRESS_VAULTS
    ? process.env.STRESS_VAULTS.split(',').map((s) => { const [name, path] = s.split('='); return { name, path }; })
    : DEFAULT_VAULTS;
const LIVE = process.env.NL_LIVE === '1';

const parse = (r) => { try { return JSON.parse(r.content?.[0]?.text ?? ''); } catch { return null; } };

const TYPES = ['CustomObject', 'CustomField', 'ApexClass', 'Flow', 'ApexTrigger', 'Profile', 'PermissionSet', 'Layout', 'Report', 'EmailTemplate'];
const gatherComponents = async (ctx) => {
  const out = [];
  for (const type of TYPES) {
    const r = parse(await dispatchTool(ctx, 'sfi.list_components', { type, limit: 500 }));
    for (const c of r?.data?.components ?? r?.data?.items ?? []) out.push({ ...c, type });
  }
  return out;
};

// Reused from the stress harness: a property->value sampler over real components.
const buildSampler = (comps) => {
  const byType = {};
  for (const c of comps) (byType[c.type] ??= []).push(c);
  const firstId = (type) => byType[type]?.[0]?.id;
  const firstApi = (type) => byType[type]?.[0]?.apiName;
  const obj = firstApi('CustomObject') ?? 'Account';
  const fieldId = firstId('CustomField');
  const apexId = firstId('ApexClass');
  const flowId = firstId('Flow');
  const anyId = comps[0]?.id;
  return (prop, schema) => {
    const p = prop.toLowerCase();
    if (schema?.type === 'boolean') return false;
    if (schema?.type === 'integer' || schema?.type === 'number') { if (p.includes('day')) return 30; return schema.minimum ?? 5; }
    if (p.includes('soql')) return 'SELECT COUNT() FROM Account';
    if (p === 'objectapiname' || p === 'objectname' || (p.includes('object') && p.includes('name'))) return obj;
    if (p.includes('field') && p.endsWith('id')) return fieldId;
    if (p === 'fieldapiname' || (p.includes('field') && p.includes('name'))) return firstApi('CustomField') ?? 'Name';
    if (p.includes('class') && p.endsWith('id')) return apexId;
    if (p.includes('method')) return 'execute';
    if (p.includes('flow') && p.endsWith('id')) return flowId;
    if (p === 'componentid' || p === 'nodeid' || p.endsWith('id')) return anyId;
    if (p === 'question') return 'how many accounts';
    if (p === 'query' || p === 'term' || p.includes('pattern') || p.includes('keyword') || p.includes('name')) return 'Account';
    if (p.includes('profile')) return firstApi('Profile') ?? 'Admin';
    if (p.includes('permissionset') || p.includes('permset')) return firstApi('PermissionSet') ?? 'X';
    if (p.includes('event')) return 'update';
    if (p.includes('type')) return 'CustomObject';
    return 'Account';
  };
};

const synthArgs = (tool, sample) => {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const args = {};
  for (const r of required) args[r] = sample(r, props[r]);
  if (props.limit !== undefined && args.limit === undefined) args.limit = 5;
  return args;
};

const toolByName = new Map(V01_TOOLS.map((t) => [t.name, t]));

// list_components needs a `type`, which is optional in its schema and so not
// produced by generic synthesis. The router knows the intent, so pick the right
// type per intent → the structural questions return real data to compare.
const LIST_TYPE_BY_INTENT = {
  schema: 'CustomObject',
  'layout-access': 'Layout',
  'reports-usage': 'Report',
  'folder-access': 'Report',
  'email-template-usage': 'EmailTemplate',
};

// Live tools get SAFE universal (standard-object) targets, so a LIVE run proves
// the live path executes without false BUGs from a mismatched object/field pair
// (e.g. an INVALID_FIELD from gluing a random CustomField onto a random object).
const LIVE_SAFE_ARGS = {
  'sfi.live_count': { soql: 'SELECT COUNT() FROM Account' },
  'sfi.live_sample': { soql: 'SELECT Id FROM Account', limit: 5 },
  'sfi.live_field_population': { objectApiName: 'Account', fieldApiName: 'Name' },
  'sfi.live_org_limits': {},
  'sfi.live_inactive_users': { days: 30 },
  'sfi.live_drift_check': { objectApiName: 'Account' },
};

const realizeArgs = (route, tool, sample) => {
  if (tool.name === 'sfi.list_components') {
    return { type: LIST_TYPE_BY_INTENT[route.intent] ?? 'CustomObject', limit: 50 };
  }
  if (tool.name in LIVE_SAFE_ARGS) {
    return { ...LIVE_SAFE_ARGS[tool.name], liveEnabled: LIVE };
  }
  const args = synthArgs(tool, sample);
  if (tool.name.startsWith('sfi.live')) args.liveEnabled = LIVE;
  return args;
};

const classifyOutcome = (r) => {
  if (!r) return { status: 'BUG', detail: 'no-parse' };
  if (r.error) {
    const kind = r.error.kind ?? 'unknown';
    const threw = String(r.error.message || '').startsWith('THREW');
    if (kind === 'internal' || threw) return { status: 'BUG', detail: `${kind}:${String(r.error.message).slice(0, 60)}` };
    return { status: 'ok-error', detail: kind };
  }
  if (r.data !== undefined) return { status: 'data', detail: '' };
  return { status: 'BUG', detail: 'no-envelope' };
};

// A short, comparable answer signature so a human can eyeball cross-org answers.
const answerSig = (r) => {
  const d = r?.data;
  if (!d || typeof d !== 'object') return '';
  if (d.count !== undefined) return `count=${d.count}`;
  if (d.totalInactive !== undefined) return `inactive=${d.totalInactive}`;
  if (d.populationRate !== undefined) return `pop=${Math.round(d.populationRate * 100)}%`;
  for (const k of ['components', 'items', 'results', 'candidates', 'rows', 'findings', 'edges']) {
    if (Array.isArray(d[k])) return `${k}=${d[k].length}`;
  }
  if (d.totalSize !== undefined) return `rows=${d.totalSize}`;
  return 'data';
};

const runVault = async ({ name, path }) => {
  const built = await buildContext(path);
  if (!built.ok) { console.log(`SKIP ${name}: ${built.error.message}`); return null; }
  const ctx = built.value;
  try {
    const comps = await gatherComponents(ctx);
    const sample = buildSampler(comps);
    const rows = [];
    for (const q of QUESTIONS) {
      const rr = parse(await dispatchTool(ctx, 'sfi.route_question', { question: q, logGap: false }));
      const route = rr?.data?.route;
      if (!route) { rows.push({ q, status: 'BUG', detail: 'route-failed', plane: '?', intent: '?', tool: '' }); continue; }
      const concrete = route.tools.find((t) => t !== 'sfi.resolve' && t !== 'sfi.capabilities');
      let exec = { status: 'routed-only', detail: '', sig: '' };
      if (concrete && toolByName.has(concrete)) {
        const tool = toolByName.get(concrete);
        const args = realizeArgs(route, tool, sample);
        const t0 = performance.now();
        const r = parse(await dispatchTool(ctx, concrete, args));
        const ms = +(performance.now() - t0).toFixed(0);
        exec = { ...classifyOutcome(r), sig: answerSig(r), ms };
        // A live tool that fail-closes without consent is EXPECTED, not a failure.
        if (concrete.startsWith('sfi.live') && !LIVE && exec.status === 'ok-error') {
          exec.status = 'live-closed';
        }
      }
      rows.push({ q, intent: route.intent, plane: route.plane, tool: concrete ?? '(none)', gap: route.gap?.category ?? '', needsResolve: route.needsResolve, ...exec });
    }
    return { name, comps: comps.length, rows };
  } finally {
    await shutdown(ctx);
  }
};

const main = async () => {
  // Routing-only gate (NL_ROUTING_ONLY=1): no vaults needed, so it runs in CI.
  // Asserts every question routes deterministically to REAL registered tools and
  // that no rule points at a dead tool name — catching router/roster drift.
  if (process.env.NL_ROUTING_ONLY === '1') {
    const { classifyQuestion, allRoutableTools } = await import('../packages/mcp/dist/src/intent-router.js');
    const registered = new Set(V01_TOOLS.map((t) => t.name));
    const dead = allRoutableTools().filter((t) => !registered.has(t));
    let bad = 0;
    for (const q of QUESTIONS) {
      const a = classifyQuestion(q);
      const b = classifyQuestion(q);
      const deterministic = a.intent === b.intent && a.plane === b.plane;
      const realTools = a.tools.every((t) => registered.has(t));
      if (!deterministic || !realTools) { bad++; console.log(`✗ ${q} -> ${a.intent}/${a.plane} [${a.tools.join(', ')}]`); }
    }
    console.log(`routing-only gate: ${QUESTIONS.length} questions · ${allRoutableTools().length} routable tools`);
    console.log(`dead router targets: ${dead.length}${dead.length ? ` (${dead.join(', ')})` : ''}`);
    console.log(`bad routes: ${bad}  ${bad === 0 && dead.length === 0 ? '✅' : '❌'}`);
    process.exit(bad === 0 && dead.length === 0 ? 0 : 1);
  }

  console.log(`NL harness — ${QUESTIONS.length} questions × ${vaults.length} vault(s); LIVE=${LIVE}\n`);
  const results = [];
  for (const v of vaults) {
    const res = await runVault(v);
    if (res) { console.log(`[${res.name}] ${res.comps} components`); results.push(res); }
  }
  if (results.length === 0) { console.log('No vaults available.'); process.exit(0); }

  // Per-question cross-org comparison.
  let bugs = 0, routingInconsistent = 0, gaps = 0, dataBoth = 0, liveClosed = 0;
  const unexpected = []; // non-live, non-gap tools that returned a structured error
  console.log('\nQUESTION → route, then per-vault outcome (sig):');
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    const perVault = results.map((res) => res.rows[i]);
    const planes = new Set(perVault.map((r) => `${r.plane}/${r.intent}`));
    const consistent = planes.size === 1;
    if (!consistent) routingInconsistent++;
    const r0 = perVault[0];
    if (r0?.gap) gaps++;
    const anyBug = perVault.some((r) => r.status === 'BUG');
    if (anyBug) bugs++;
    if (perVault.every((r) => r.status === 'data')) dataBoth++;
    if (perVault.some((r) => r.status === 'live-closed')) liveClosed++;
    // A structural (non-live, non-gap, non-resolve) tool returning ok-error is
    // worth a look. needsResolve intents legitimately ok-error here because the
    // harness feeds a synthetic entity instead of running the resolve step.
    if (!r0.gap && !r0.needsResolve && !String(r0.tool).startsWith('sfi.live') && perVault.some((r) => r.status === 'ok-error')) {
      unexpected.push(`${q}  (${r0.tool}: ${perVault.map((r) => r.detail).filter(Boolean).join('/')})`);
    }
    const flag = anyBug ? ' ❌BUG' : !consistent ? ' ⚠️ROUTE-DRIFT' : '';
    const outcomesByVault = perVault.map((r, vi) => `${results[vi].name}:${r.status}${r.sig ? `(${r.sig})` : ''}`).join('  ');
    console.log(`• ${q}\n    → ${r0.plane}/${r0.intent} via ${r0.tool}${r0.gap ? ` [gap:${r0.gap}]` : ''}${flag}\n    ${outcomesByVault}`);
  }

  console.log('\n==== SUMMARY ====');
  console.log(`questions: ${QUESTIONS.length} | vaults: ${results.length} | LIVE=${LIVE}`);
  console.log(`routing consistent across vaults: ${QUESTIONS.length - routingInconsistent}/${QUESTIONS.length}`);
  console.log(`returned data on every vault: ${dataBoth}/${QUESTIONS.length}`);
  console.log(`live routes fail-closed (expected when LIVE=0): ${liveClosed}`);
  console.log(`gap-flagged questions (no dedicated tool yet): ${gaps}`);
  if (unexpected.length > 0) {
    console.log(`\nunexpected structured errors (investigate):`);
    for (const u of unexpected) console.log(`  - ${u}`);
  }
  console.log(`\nBUGs (internal error / throw on any vault): ${bugs}  ${bugs === 0 ? '✅' : '❌'}`);
  process.exit(bugs === 0 && routingInconsistent === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
