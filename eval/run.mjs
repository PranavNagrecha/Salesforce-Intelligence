#!/usr/bin/env node
// Standing eval harness — the regression net both prior QA passes lacked.
//
// Runs golden retrieval cases against the REAL vaults (read-only) and checks
// the resolver lands on known-correct components. Vault paths come from the
// workspace registry.json. A vault that isn't present is SKIPPED (so CI
// without vaults stays green); only genuine case failures exit non-zero.
//
// Run: pnpm eval   (from packages/graph build output)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  resolveComponents,
  openGraphReadOnly,
  closeGraph,
} from '../packages/graph/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const strict = process.env.EVAL_STRICT === '1';
// Honors SF_INTELLIGENCE_REGISTRY_PATH; in strict mode defaults to the CI registry.
const registryPath =
  process.env.SF_INTELLIGENCE_REGISTRY_PATH ??
  (strict ? join(here, 'registry.ci.json') : join(repoRoot, '..', 'registry.json'));

// Golden cases are keyed by registered-vault name and are LOADED from a file,
// not hard-coded — so private org identifiers (component api-names) never live
// in shipped source. Resolution order: `eval/cases.local.json` (gitignored —
// your real vaults + components) then `eval/cases.example.json` (synthetic
// demo, shipped). Matchers per case:
//   expectTop            top candidate id is exactly this
//   expectTopMatches     regex (i) on the top candidate id
//   expectContains       this id appears anywhere in candidates
//   expectContainsMatches regex (i) matches some candidate id
//   expectDisposition    disposition equals this
//   expectNotExact       disposition must NOT be 'exact' (false-positive guard)
const loadCases = () => {
  const order = strict
    ? ['cases.ci.json']
    : ['cases.local.json', 'cases.example.json', 'cases.ci.json'];
  for (const name of order) {
    try {
      return JSON.parse(readFileSync(join(here, name), 'utf8'));
    } catch {
      /* try the next source */
    }
  }
  return {};
};

const checkCase = (c, res) => {
  if (!res.ok) return [`resolve error: ${res.error.message}`];
  const { disposition, candidates } = res.value;
  const top = candidates[0];
  const ids = candidates.map((x) => x.id);
  const fails = [];
  if (c.expectTop && top?.id !== c.expectTop)
    fails.push(`top expected ${c.expectTop}, got ${top?.id ?? '(none)'}`);
  if (c.expectTopMatches && !(top && new RegExp(c.expectTopMatches, 'i').test(top.id)))
    fails.push(`top should match /${c.expectTopMatches}/i, got ${top?.id ?? '(none)'}`);
  if (c.expectContains && !ids.includes(c.expectContains))
    fails.push(`candidates should contain ${c.expectContains}`);
  if (c.expectContainsMatches && !ids.some((id) => new RegExp(c.expectContainsMatches, 'i').test(id)))
    fails.push(`candidates should contain /${c.expectContainsMatches}/i`);
  if (c.expectDisposition && disposition !== c.expectDisposition)
    fails.push(`disposition expected ${c.expectDisposition}, got ${disposition}`);
  if (c.expectNotExact && disposition === 'exact')
    fails.push(`disposition must NOT be exact (false-positive guard), got exact -> ${top?.id}`);
  return fails;
};

const main = async () => {
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch {
    if (strict) {
      console.error(`EVAL_STRICT: no registry at ${registryPath}`);
      return 1;
    }
    console.log(`No registry at ${registryPath} — nothing to eval.`);
    return 0;
  }

  const CASES = loadCases();

  let pass = 0;
  let fail = 0;
  let ran = 0;
  let maxMs = 0;
  // Scale regression guard: resolve is O(n) over the node corpus per query.
  // At the target scale (single org, a few thousand nodes) it is sub-100ms;
  // this budget catches a regression or a corpus that has outgrown the
  // scan-per-query approach (the cue to land a persisted token index).
  const SCALE_BUDGET_MS = 2000;

  for (const [vaultKey, cases] of Object.entries(CASES)) {
    const info = registry.vaults?.[vaultKey];
    if (!info) {
      console.log(`\n# ${vaultKey}: not in registry — SKIP`);
      continue;
    }
    const vaultRoot = isAbsolute(info.path) ? info.path : resolve(repoRoot, info.path);
    const dbPath = join(vaultRoot, 'graph', 'graph.duckdb');
    const opened = await openGraphReadOnly(dbPath);
    if (!opened.ok) {
      console.log(`\n# ${vaultKey}: cannot open (${opened.error.message}) — SKIP`);
      continue;
    }
    console.log(`\n# ${vaultKey}  (${dbPath})`);
    for (const c of cases) {
      ran += 1;
      const t0 = performance.now();
      const res = await resolveComponents(opened.value, c.query);
      maxMs = Math.max(maxMs, performance.now() - t0);
      const fails = checkCase(c, res);
      const top = res.ok ? res.value.candidates[0] : undefined;
      const disp = res.ok ? res.value.disposition : 'ERR';
      if (fails.length === 0) {
        pass += 1;
        console.log(`  PASS  "${c.query}" -> ${top?.id ?? '(none)'} [${disp}]`);
      } else {
        fail += 1;
        console.log(`  FAIL  "${c.query}"  (${c.note})`);
        for (const f of fails) console.log(`         ${f}`);
        if (res.ok)
          for (const cand of res.value.candidates.slice(0, 3))
            console.log(`         · ${cand.id}  score=${cand.score} base=${cand.base} ${cand.matchKind}`);
      }
    }
    await closeGraph(opened.value);
  }

  if (ran > 0) {
    console.log(
      `\nslowest resolve: ${maxMs.toFixed(1)}ms (scale budget ${SCALE_BUDGET_MS}ms)`,
    );
    if (maxMs > SCALE_BUDGET_MS) {
      console.error(
        `✗ scale regression: a resolve took ${maxMs.toFixed(0)}ms — time to land a persisted token index.`,
      );
      fail += 1;
    }
  }
  console.log(`\n${pass}/${ran} passed, ${fail} failed.`);
  if (ran === 0) {
    if (strict) {
      console.error('EVAL_STRICT: no eval cases ran (registry vaults missing or empty cases)');
      return 1;
    }
    console.log('No vaults available — eval skipped.');
  }
  return fail > 0 ? 1 : 0;
};

main().then((code) => process.exit(code));
