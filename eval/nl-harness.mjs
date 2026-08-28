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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { buildContext, shutdown } from '../packages/mcp/dist/src/server.js';
import { dispatchTool, V01_TOOLS } from '../packages/mcp/dist/src/tools/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const productManifestIdentity = () => {
  try {
    const m = JSON.parse(
      readFileSync(join(repoRoot, 'eval/product-manifest.json'), 'utf8'),
    );
    return {
      identityHash: m.identityHash ?? null,
      catalogHash: m.catalogHash ?? null,
      toolCount: m.tools?.total ?? V01_TOOLS.length,
      conceptCount: m.conceptModel?.concepts ?? null,
      conceptRuleCount: m.conceptModel?.rules ?? null,
    };
  } catch {
    return {
      identityHash: null,
      catalogHash: null,
      toolCount: V01_TOOLS.length,
      conceptCount: null,
      conceptRuleCount: null,
    };
  }
};

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

/**
 * THE HARNESS WAS MEASURING ITSELF, NOT THE PRODUCT.
 *
 * `sfi.route_question` returns `suggestedArgs` — the arguments its own `reason`
 * tells the host to supply ("what_happens_on_save needs an explicit DML event —
 * default to 'update' … when none is stated", and it hands back
 * `{event: 'insert'}` for "What happens when a Case is created?"). This function
 * ignored them and synthesized args from the tool's advertised `required` list
 * instead, so eight of the sixteen offline questions in the battery executed
 * WITHOUT the argument the router had just supplied, came back `invalid-query`,
 * and were tallied as product failures.
 *
 * Measured against a real 9,264-node org: those same eight questions ANSWER when
 * called the way the router instructs. The routing was never the problem — the
 * hand-off in this file was. A gate that under-reports is as dishonest as one
 * that over-reports, and this one was telling the owner half his front-page
 * questions did not work.
 *
 * Router-supplied args WIN over synthesized ones: the router read the question,
 * the synthesizer only read the schema.
 */
/**
 * THE OTHER HALF OF THE HAND-OFF: `route.needsResolve`.
 *
 * The router does not only suggest args — it says "resolve the named component
 * first" and lists `sfi.resolve` as step one of its plan. This harness executed
 * the CONCRETE tool and skipped that step, so a question that names an object
 * ("What happens when a Case is created?") reached a tool that had never been
 * told which object, and answered `invalid-query`. The product was fine; the
 * question was being asked with the subject removed.
 *
 * This resolves the subject the way a host does: find the vault component the
 * question actually names, then fill whichever selector the tool advertises.
 * Deliberately conservative — it fills ONLY a selector the tool advertises and
 * that nothing has already supplied, so it can add a subject and never override
 * the router's own judgement or a live-safe fixture.
 */
const SELECTOR_ORDER = [
  'objectApiName',
  'objectId',
  'componentId',
  'rootId',
  'fieldId',
  'nodeId',
  'id',
];

const subjectFromQuestion = (question, comps) => {
  // Punctuation-insensitive: the first cut matched on ` term ` and so missed
  // "…of Account?" — the question mark. A whole class of question ends in one.
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
  let best = null;
  for (const c of comps) {
    for (const term of [c.apiName, c.label]) {
      if (typeof term !== 'string' || term.length < 3) continue;
      const t = term.toLowerCase().replace(/[^a-z0-9_]+/g, ' ');
      if (!q.includes(` ${t} `) && !q.includes(` ${t}s `)) continue;
      // Prefer the longest match, and an object over a field of the same name.
      const score = t.length + (c.type === 'CustomObject' ? 100 : 0);
      if (best === null || score > best.score) best = { comp: c, score };
    }
  }
  return best?.comp ?? null;
};

const withResolvedSubject = (question, tool, comps, args) => {
  const props = tool.inputSchema?.properties ?? {};
  const already = SELECTOR_ORDER.find((k) => args[k] !== undefined);
  if (already !== undefined) return args;
  const slot = SELECTOR_ORDER.find((k) => props[k] !== undefined);
  if (slot === undefined) return args;
  const subject = subjectFromQuestion(question, comps);
  if (subject === null) return args;
  const value = slot === 'objectApiName' ? subject.apiName : subject.id;
  if (value === undefined || value === null) return args;
  return { ...args, [slot]: value };
};

const realizeArgs = (route, tool, sample, comps = []) => {
  const suggested = route.suggestedArgs ?? {};
  if (tool.name === 'sfi.list_components') {
    return { type: LIST_TYPE_BY_INTENT[route.intent] ?? 'CustomObject', limit: 50, ...suggested };
  }
  if (tool.name in LIVE_SAFE_ARGS) {
    return { ...LIVE_SAFE_ARGS[tool.name], ...suggested, liveEnabled: LIVE };
  }
  const args = { ...synthArgs(tool, sample), ...suggested };
  if (tool.name.startsWith('sfi.live')) args.liveEnabled = LIVE;
  return route.needsResolve === true
    ? withResolvedSubject(route.question ?? '', tool, comps, args)
    : args;
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
        const args = realizeArgs(route, tool, sample, comps);
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
    const manifest = productManifestIdentity();
    console.log(
      `product-manifest: tools=${manifest.toolCount}` +
        (manifest.conceptCount != null
          ? ` concepts=${manifest.conceptCount}/${manifest.conceptRuleCount}`
          : '') +
        (manifest.identityHash ? ` identity=${manifest.identityHash}` : '') +
        (manifest.catalogHash ? ` catalog=${manifest.catalogHash}` : ''),
    );
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

  const manifest = productManifestIdentity();
  console.log('\n==== SUMMARY ====');
  console.log(
    `product-manifest: tools=${manifest.toolCount}` +
      (manifest.identityHash ? ` identity=${manifest.identityHash}` : ''),
  );
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
