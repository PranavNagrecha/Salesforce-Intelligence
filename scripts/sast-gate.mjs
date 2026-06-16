#!/usr/bin/env node
/**
 * SAST gate — proactive delivery. Runs sf-intelligence's own quality tools
 * (code_quality_audit + governor_limit_risks) read-only against a vault and
 * exits non-zero when critical/high findings exceed an allowed budget. Drop
 * it into a Salesforce org repo's CI to fail the build on a NEW SOQL
 * injection, SOQL-in-loop, DML-in-loop, etc. — value with no prompt.
 *
 * Usage:
 *   node scripts/sast-gate.mjs [vaultRoot]
 * Resolution order for the vault: argv[2] -> $SF_INTELLIGENCE_VAULT_ROOT ->
 * first vault in the registry -> ./org-kb.
 * Budget: $SAST_MAX_FINDINGS (default 0) — max allowed critical+high.
 *
 * Exit codes: 0 = under budget, 1 = gate failed (too many findings),
 * 2 = setup error (vault missing/unreadable).
 *
 * Example consumer CI step:
 *   - run: pnpm sfi refresh           # rebuild the vault from the org
 *   - run: node scripts/sast-gate.mjs # fail on new critical/high issues
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  openGraphReadOnly,
  closeGraph,
} from '../packages/graph/dist/src/index.js';
import { loadManifest, vaultPaths } from '../packages/vault/dist/src/index.js';
import { codeQualityAuditHandler } from '../packages/mcp/dist/src/tools/code-quality-audit.js';
import { governorLimitRisksHandler } from '../packages/mcp/dist/src/tools/governor-limit-risks.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUDGET = Number(process.env.SAST_MAX_FINDINGS ?? 0);
// Severities that count toward the gate. Default critical+high; a brownfield
// org can start at SAST_FAIL_ON=critical (the genuinely dangerous issues:
// injections, SOQL/DML-in-loop) and ratchet down as it cleans up.
const FAIL_ON = new Set(
  (process.env.SAST_FAIL_ON ?? 'critical,high')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const firstRegistryVault = () => {
  const p =
    process.env.SF_INTELLIGENCE_REGISTRY_PATH ??
    join(here, '..', '..', 'registry.json');
  try {
    const reg = JSON.parse(readFileSync(p, 'utf8'));
    const first = Object.values(reg.vaults ?? {})[0];
    return first?.path;
  } catch {
    return undefined;
  }
};

const vaultRoot =
  process.argv[2] ??
  process.env.SF_INTELLIGENCE_VAULT_ROOT ??
  firstRegistryVault() ??
  join(process.cwd(), 'org-kb');

const fail = (code, msg) => {
  console.error(msg);
  process.exit(code);
};

const manifest = await loadManifest(vaultRoot);
if (!manifest.ok) fail(2, `SAST gate: cannot load manifest at ${vaultRoot}: ${manifest.error.message}`);
const opened = await openGraphReadOnly(vaultPaths(vaultRoot).graphDb);
if (!opened.ok) fail(2, `SAST gate: cannot open vault: ${opened.error.message}`);

const ctx = { vaultRoot, manifest: manifest.value, graph: opened.value };

const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
const examples = [];

// 1. Code quality. summary.bySeverity is the authoritative FULL count;
//    issues[] (sliced to limit) provides the example lines.
const cq = await codeQualityAuditHandler(ctx, { limit: 500 });
if (cq.ok) {
  for (const [sev, n] of Object.entries(cq.value.data.summary.bySeverity)) {
    if (sev in counts) counts[sev] += n;
  }
  for (const i of cq.value.data.issues) {
    if (FAIL_ON.has(i.severity))
      examples.push(`  [${i.severity}] ${i.rule} — ${i.componentId} @ ${i.location}`);
  }
}

// 2. Governor limits. Severity lives per-finding inside each class.
const gov = await governorLimitRisksHandler(ctx, { limit: 500 });
if (gov.ok) {
  for (const cls of gov.value.data.classes) {
    for (const r of cls.risks) {
      if (r.severity in counts) counts[r.severity] += 1;
      if (FAIL_ON.has(r.severity))
        examples.push(`  [${r.severity}] ${r.rule} — ${cls.componentId} @ ${r.location}`);
    }
  }
}

await closeGraph(opened.value);

const total = [...FAIL_ON].reduce((s, sev) => s + (counts[sev] ?? 0), 0);
console.log(`SAST gate — vault: ${vaultRoot}`);
console.log('  counts: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
console.log(`  gating on [${[...FAIL_ON].join(', ')}] -> ${total} finding(s) (budget ${BUDGET})`);
if (examples.length > 0) {
  console.log('\nFindings:');
  for (const e of examples.slice(0, 25)) console.log(e);
  if (examples.length > 25) console.log(`  … and ${examples.length - 25} more`);
}

if (total > BUDGET) {
  console.error(`\n✗ SAST gate FAILED: ${total} critical/high finding(s) exceed budget ${BUDGET}.`);
  process.exit(1);
}
console.log(`\n✓ SAST gate passed.`);
process.exit(0);
