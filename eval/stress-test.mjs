#!/usr/bin/env node
// Stress + regression harness — fires 1000+ generated questions per vault at
// the resolver (and a sample of other tools), measuring latency, resolve
// disposition, and ACCURACY/recall against known-correct components.
//
// A "regression" = an EXACT real component apiName the resolver fails to surface
// (disposition none / not in candidates) — that is a genuine miss to fix.
//
// Usage:  node eval/stress-test.mjs   (after `pnpm --filter @sf-intelligence/mcp build`)
//   env STRESS_COMPONENTS=250  components sampled per vault (×~4 variants)
//   env STRESS_VAULTS="name=/abs/path/org-kb,name2=/abs/path2/org-kb"  override vaults

import { performance } from 'node:perf_hooks';

import { buildContext, shutdown } from '../packages/mcp/dist/src/server.js';
import { dispatchTool, V01_TOOLS } from '../packages/mcp/dist/src/tools/index.js';

// Tools that MUTATE state (write to the vault baseline) — excluded from the
// fire-everything regression sweep so the harness never alters the vault.
const WRITE_TOOLS = new Set(['sfi.baseline_acknowledge']);
// Error kinds that are a LEGITIMATE structured answer (bad/synthesized input,
// or the opt-in live plane being disabled) — NOT a bug. Anything else (internal
// errors, thrown exceptions) is a real regression the net must flag.
const OK_ERROR_KINDS = new Set([
  'invalid-query',
  'invalid-id',
  'invalid-scope',
  'component-not-found',
  'not-found',
  'unsupported',
  'invalid-argument',
]);

// Point the harness at your own vault(s) with the STRESS_VAULTS env var, e.g.
//   STRESS_VAULTS="orgA=/abs/path/orgA-vault/org-kb,orgB=/abs/path/orgB/org-kb"
// The example defaults below are relative placeholders (no real org names or
// machine paths committed); a real run always sets STRESS_VAULTS.
const DEFAULT_VAULTS = [
  { name: 'vault-a', path: './vault-a/org-kb' },
  { name: 'vault-b', path: './vault-b/org-kb' },
];
const vaults = process.env.STRESS_VAULTS
  ? process.env.STRESS_VAULTS.split(',').map((s) => { const [name, path] = s.split('='); return { name, path }; })
  : DEFAULT_VAULTS;
const SAMPLE = Number(process.env.STRESS_COMPONENTS ?? 250);

const TYPES = ['CustomObject', 'CustomField', 'ApexClass', 'Flow', 'ApexTrigger', 'ValidationRule', 'Profile', 'PermissionSet', 'Layout'];
const CONCEPTS = ['email', 'emale', 'phone', 'payment', 'paymnet', 'account', 'acount', 'contact', 'address', 'adress', 'status', 'amount', 'date', 'name', 'owner', 'user', 'case', 'task', 'approval', 'picklist', 'currency', 'record type', 'recrod type', 'transaction', 'transcation', 'enrollment', 'student', 'advisor'];

const parse = (r) => { try { return JSON.parse(r.content?.[0]?.text ?? ''); } catch { return null; } };

// Deterministic typo: swap two characters near the middle of the token's stem.
const typo = (s) => {
  const base = s.includes('.') ? s.split('.').pop() : s; // field stem
  const stem = base.replace(/__c$|__r$/i, '');
  if (stem.length < 4) return base;
  const i = Math.floor(stem.length / 2);
  return stem.slice(0, i - 1) + stem[i] + stem[i - 1] + stem.slice(i + 1);
};
const stem = (s) => (s.includes('.') ? s.split('.').pop() : s).replace(/__c$|__r$|__mdt$/i, '');

const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const gatherComponents = async (ctx) => {
  const all = [];
  for (const type of TYPES) {
    const r = parse(await dispatchTool(ctx, 'sfi.list_components', { type, limit: 500 }));
    const arr = r?.data?.components ?? r?.data?.nodes ?? [];
    for (const c of arr) all.push({ id: c.id, apiName: c.apiName, type });
  }
  return all;
};

// Round-robin sample across types so no single type dominates.
const sampleAcross = (comps, n) => {
  const byType = {};
  for (const c of comps) (byType[c.type] ??= []).push(c);
  const out = [];
  let added = true;
  while (out.length < n && added) {
    added = false;
    for (const t of TYPES) {
      const list = byType[t];
      if (list && list.length) { out.push(list.shift()); added = true; if (out.length >= n) break; }
    }
  }
  return out;
};

// Build a sampler that maps an input-schema PROPERTY NAME to a realistic value
// drawn from the vault's actual components, so every tool gets plausible args.
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
  // Resolve a value for one property by matching its (lowercased) name.
  return (prop, schema) => {
    const p = prop.toLowerCase();
    if (schema?.type === 'boolean') return p.includes('live') ? false : false;
    if (schema?.type === 'integer' || schema?.type === 'number') {
      if (p.includes('day')) return 30;
      return schema.minimum ?? 5;
    }
    if (p.includes('soql')) return 'SELECT COUNT() FROM Account';
    if (p === 'objectapiname' || p === 'objectname' || (p.includes('object') && p.includes('name'))) return obj;
    if (p.includes('field') && (p.endsWith('id') || p === 'fieldid')) return fieldId;
    if (p === 'fieldapiname' || (p.includes('field') && p.includes('name'))) return firstApi('CustomField') ?? 'Name';
    if (p.includes('class') && p.endsWith('id')) return apexId;
    if (p.includes('method')) return 'execute';
    if (p.includes('flow') && p.endsWith('id')) return flowId;
    if (p === 'componentid' || p.endsWith('id')) return anyId;
    if (p.includes('fingerprint')) return 'stress-fp';
    if (p === 'query' || p === 'term' || p.includes('pattern') || p.includes('keyword') || p.includes('name')) return 'budget';
    if (p.includes('profile')) return firstApi('Profile') ?? 'Admin';
    if (p.includes('permissionset') || p.includes('permset')) return firstApi('PermissionSet') ?? 'X';
    if (p.includes('event')) return 'update';
    if (p.includes('type')) return 'CustomObject';
    return 'budget'; // generic string fallback
  };
};

// Synthesize an args object for a tool from its JSON input schema.
const synthArgs = (tool, sample) => {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const args = {};
  for (const r of required) args[r] = sample(r, props[r]);
  // Add a couple of safe optional knobs when the tool accepts them.
  if (props.limit !== undefined && args.limit === undefined) args.limit = 5;
  return args;
};

// Fire every read-only tool with synthesized args; classify each response.
const runToolRegression = async (ctx, comps) => {
  const sample = buildSampler(comps);
  const perTool = []; // { tool, status: 'data'|'ok-error'|'BUG', detail, ms }
  for (const tool of V01_TOOLS) {
    if (WRITE_TOOLS.has(tool.name)) continue;
    const args = synthArgs(tool, sample);
    const t0 = performance.now();
    let status, detail = '';
    try {
      const r = parse(await dispatchTool(ctx, tool.name, args));
      if (r?.error) {
        const kind = r.error.kind ?? 'unknown';
        const threw = String(r.error.message || '').startsWith('THREW');
        if (kind === 'internal' || threw) { status = 'BUG'; detail = `${kind}: ${String(r.error.message).slice(0, 80)}`; }
        else if (OK_ERROR_KINDS.has(kind)) { status = 'ok-error'; detail = kind; }
        else { status = 'ok-error'; detail = kind; } // unknown-but-structured: tolerate, record
      } else if (r?.data !== undefined) {
        status = 'data';
      } else {
        status = 'BUG'; detail = 'no data and no error envelope';
      }
    } catch (e) {
      status = 'BUG'; detail = `THREW ${String(e?.message ?? e).slice(0, 80)}`;
    }
    perTool.push({ tool: tool.name, status, detail, ms: +(performance.now() - t0).toFixed(1) });
  }
  return perTool;
};

const runVault = async ({ name, path }) => {
  const built = await buildContext(path);
  if (!built.ok) { console.log(`SKIP ${name}: ${built.error.message}`); return null; }
  const ctx = built.value;
  try {
    const comps = await gatherComponents(ctx);
    const sample = sampleAcross(comps, SAMPLE);
    console.log(`\n[${name}] ${comps.length} components found; sampling ${sample.length}`);

    // Stem frequency across ALL components — lets us split a typo MISS into
    // "inherent ambiguity" (many components share this stem; no resolver can
    // pinpoint THE id from a fuzzy stem) vs "genuine fuzzy miss" (unique stem
    // the fuzzy layer simply failed to recover). Only the latter is tunable.
    const stemFreq = new Map();
    for (const c of comps) {
      const s = stem(c.apiName).toLowerCase();
      stemFreq.set(s, (stemFreq.get(s) ?? 0) + 1);
    }

    const lat = [];
    const disp = { exact: 0, ambiguous: 0, none: 0, other: 0 };
    let calls = 0, errors = 0;
    const misses = []; // exact-name queries the resolver can't find
    let exactTop1 = 0, exactTotal = 0, exactRecall = 0;
    let typoTotal = 0, typoRecall = 0;
    let typoMissAmbiguous = 0, typoMissUnique = 0;
    const typoMissDetail = [];
    const slow = [];

    const resolveQ = async (q, expectedId, kind, expectedStem) => {
      const t0 = performance.now();
      const r = parse(await dispatchTool(ctx, 'sfi.resolve', { query: q }));
      const dt = performance.now() - t0;
      lat.push(dt); calls++;
      slow.push({ q, dt, kind }); if (slow.length > 2000) slow.shift();
      if (!r || r.error) { errors++; return; }
      const d = r.data?.disposition ?? 'other';
      disp[d] = (disp[d] ?? 0) + 1;
      const cands = r.data?.candidates ?? [];
      const ids = cands.map((c) => c.componentId);
      if (kind === 'exact') {
        exactTotal++;
        if (ids[0] === expectedId) exactTop1++;
        if (ids.includes(expectedId)) exactRecall++;
        else misses.push({ q, expectedId, disposition: d });
      } else if (kind === 'typo') {
        typoTotal++;
        if (ids.includes(expectedId)) typoRecall++;
        else {
          // Split the miss: did many components share this stem (inherent
          // ambiguity, untunable) or is the stem unique (a genuine fuzzy miss)?
          const expStem = (expectedStem ?? '').toLowerCase();
          const freq = stemFreq.get(expStem) ?? 1;
          if (freq > 1) typoMissAmbiguous++; else typoMissUnique++;
          if (typoMissDetail.length < 25) typoMissDetail.push({ q, exp: expStem, freq, disposition: d, nCands: ids.length, top: cands[0]?.apiName });
        }
      }
    };

    for (const c of sample) {
      await resolveQ(c.apiName, c.id, 'exact');
      await resolveQ(stem(c.apiName).toLowerCase(), c.id, 'lower');
      await resolveQ(typo(c.apiName), c.id, 'typo', stem(c.apiName));
      await resolveQ(`where is the ${stem(c.apiName)} ${c.type === 'CustomField' ? 'field' : c.type === 'CustomObject' ? 'object' : ''}`.trim(), c.id, 'filler');
    }
    for (const q of CONCEPTS) await resolveQ(q, null, 'concept');

    // Secondary surface stress: hit specific high-value tools on MANY real
    // components (deep, repeated) to catch crashes that only specific inputs hit.
    let toolCalls = 0, toolErrors = 0;
    const objs = sample.filter((c) => c.type === 'CustomObject').slice(0, 20);
    const fields = sample.filter((c) => c.type === 'CustomField').slice(0, 20);
    const stress = [
      ...objs.map((c) => ['sfi.what_happens_on_save', { objectApiName: c.apiName, event: 'update' }]),
      ...objs.map((c) => ['sfi.automation_build_advisor', { objectApiName: c.apiName }]),
      ...fields.map((c) => ['sfi.safe_to_delete_field', { fieldId: c.id }]),
      ...fields.map((c) => ['sfi.field_change_advisor', { fieldId: c.id }]),
      ['sfi.org_overview', {}], ['sfi.find_dependency_cycles', {}], ['sfi.apex_test_coverage', {}],
    ];
    for (const [tool, args] of stress) {
      const t0 = performance.now();
      const r = parse(await dispatchTool(ctx, tool, args));
      const dt = performance.now() - t0;
      lat.push(dt); toolCalls++; slow.push({ q: `${tool}`, dt, kind: 'tool' });
      // component-not-found is a legit answer, not a crash; only count internal/throw as error.
      if (r?.error && (r.error.kind === 'internal' || String(r.error.message || '').startsWith('THREW'))) toolErrors++;
    }

    // BREADTH regression net: fire EVERY read-only tool once with schema-
    // synthesized realistic args, and classify each response (data / legit
    // structured error / BUG). A BUG is an internal error or thrown exception —
    // a real contract violation the net must surface for any of the ~120 tools.
    const toolReg = await runToolRegression(ctx, sample);
    const regSummary = { data: 0, okError: 0, bug: 0, tools: toolReg.length, bugs: [] };
    for (const t of toolReg) {
      if (t.status === 'data') regSummary.data++;
      else if (t.status === 'ok-error') regSummary.okError++;
      else { regSummary.bug++; regSummary.bugs.push(`${t.tool} → ${t.detail}`); }
    }

    slow.sort((a, b) => b.dt - a.dt);
    return {
      name, components: comps.length, resolveCalls: calls, toolCalls, errors, toolErrors,
      regSummary,
      latency: { meanMs: +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(2), p50: +pct(lat, 50).toFixed(2), p95: +pct(lat, 95).toFixed(2), p99: +pct(lat, 99).toFixed(2), maxMs: +Math.max(...lat).toFixed(2) },
      disposition: disp,
      accuracy: {
        exactTop1Pct: +((exactTop1 / exactTotal) * 100).toFixed(1),
        exactRecallPct: +((exactRecall / exactTotal) * 100).toFixed(1),
        typoRecallPct: +((typoRecall / Math.max(1, typoTotal)) * 100).toFixed(1),
        exactTotal, typoTotal,
      },
      typoMiss: {
        ambiguous: typoMissAmbiguous,
        unique: typoMissUnique,
        // "fixable" typo recall = recall over UNIQUE-stem typos only (the part a
        // resolver can actually improve; ambiguous-stem misses are not bugs).
        uniqueRecallPct: +(((typoRecall) / Math.max(1, typoRecall + typoMissUnique)) * 100).toFixed(1),
        detail: typoMissDetail.slice(0, 12),
      },
      misses: misses.slice(0, 12),
      slowest: slow.slice(0, 8).map((s) => ({ q: s.q.slice(0, 40), ms: +s.dt.toFixed(1), kind: s.kind })),
    };
  } finally {
    await shutdown(ctx);
  }
};

const main = async () => {
  const reports = [];
  for (const v of vaults) {
    const rep = await runVault(v);
    if (rep) reports.push(rep);
  }
  console.log('\n================ STRESS / REGRESSION REPORT ================');
  for (const r of reports) {
    console.log(`\n## ${r.name}  (${r.components} components)`);
    console.log(`   calls: ${r.resolveCalls} resolve + ${r.toolCalls} tool = ${r.resolveCalls + r.toolCalls} | errors: ${r.errors} resolve, ${r.toolErrors} tool`);
    const rs = r.regSummary;
    console.log(`   tool regression net: ${rs.tools} tools fired | ${rs.data} data, ${rs.okError} structured-error, ${rs.bug} BUG`);
    if (rs.bug > 0) {
      console.log(`   ⚠️  BUGS (internal error / threw):`);
      for (const b of rs.bugs.slice(0, 20)) console.log(`     - ${b}`);
    } else {
      console.log(`   ✅ no internal errors / crashes across the tool surface`);
    }
    console.log(`   latency ms: mean ${r.latency.meanMs} | p50 ${r.latency.p50} | p95 ${r.latency.p95} | p99 ${r.latency.p99} | max ${r.latency.maxMs}`);
    console.log(`   resolve disposition: ${JSON.stringify(r.disposition)}`);
    console.log(`   accuracy: exact top-1 ${r.accuracy.exactTop1Pct}% | exact recall ${r.accuracy.exactRecallPct}% | typo recall ${r.accuracy.typoRecallPct}% (n=${r.accuracy.exactTotal})`);
    console.log(`   typo misses: ${r.typoMiss.ambiguous} ambiguous-stem (untunable) + ${r.typoMiss.unique} unique-stem (fixable) | unique-stem recall ${r.typoMiss.uniqueRecallPct}%`);
    if (r.typoMiss.detail.length) {
      for (const m of r.typoMiss.detail.slice(0, 6)) console.log(`     miss "${m.q}" exp-stem="${m.exp}" (×${m.freq}) -> ${m.disposition}, ${m.nCands} cands, top=${m.top}`);
    }
    console.log(`   slowest: ${r.slowest.map((s) => `${s.q}=${s.ms}ms`).join(' · ')}`);
    if (r.misses.length) {
      console.log(`   REGRESSIONS (exact name not found, ${r.misses.length} shown):`);
      for (const m of r.misses) console.log(`     - "${m.q}" -> ${m.disposition} (expected ${m.expectedId})`);
    } else {
      console.log('   REGRESSIONS: none (every exact component name resolved)');
    }
  }
  const totalCalls = reports.reduce((a, r) => a + r.resolveCalls + r.toolCalls, 0);
  console.log(`\nTOTAL CALLS: ${totalCalls} across ${reports.length} vault(s)`);
};

await main();
process.exit(0);
