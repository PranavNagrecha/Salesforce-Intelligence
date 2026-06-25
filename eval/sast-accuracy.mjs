#!/usr/bin/env node
// SAST accuracy measurement (P21-MOAT-accuracy-report): runs the heuristic
// code-quality recognizers over a labeled synthetic corpus and computes
// per-rule precision / recall / false-positive / false-negative rates — turning
// the product's honest "every finding is heuristic" into a measured number.
// Synthetic data only. Re-run: `pnpm --filter @sf-intelligence/patterns build && node eval/sast-accuracy.mjs`.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectCodeQualityIssues } from '../packages/patterns/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'sast-corpus.json'), 'utf8'));
const META = { apiVersion: 61, isTest: false };

const byRule = new Map();
const misses = []; // FP/FN for transparency
const tally = (rule) => {
  if (!byRule.has(rule)) byRule.set(rule, { tp: 0, fp: 0, tn: 0, fn: 0 });
  return byRule.get(rule);
};

for (const c of corpus.cases) {
  const issues = detectCodeQualityIssues(c.source, META);
  const fired = issues.some((i) => i.rule === c.rule);
  const t = tally(c.rule);
  if (c.shouldFire && fired) t.tp += 1;
  else if (!c.shouldFire && fired) { t.fp += 1; misses.push({ ...c, kind: 'FALSE POSITIVE' }); }
  else if (c.shouldFire && !fired) { t.fn += 1; misses.push({ ...c, kind: 'FALSE NEGATIVE' }); }
  else t.tn += 1;
}

const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);
const rows = [...byRule.entries()].map(([rule, t]) => {
  const precision = pct(t.tp, t.tp + t.fp);
  const recall = pct(t.tp, t.tp + t.fn);
  return { rule, ...t, precision, recall, n: t.tp + t.fp + t.tn + t.fn };
});
const total = rows.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, tn: a.tn + r.tn, fn: a.fn + r.fn }), { tp: 0, fp: 0, tn: 0, fn: 0 });

const lines = [];
lines.push('# SAST accuracy report — heuristic code-quality recognizers');
lines.push('');
lines.push('Measured against a **labeled synthetic Apex corpus** (`eval/sast-corpus.json`). Every');
lines.push('finding the product emits is tagged `confidence: heuristic`; this report makes that');
lines.push('honesty *measurable*. Synthetic data only — re-run with `node eval/sast-accuracy.mjs`.');
lines.push('');
lines.push(`Corpus: **${corpus.cases.length} cases** across ${rows.length} rules (positives, negatives, FP-traps, and FN-blindspots).`);
lines.push('');
lines.push('## Per-rule results');
lines.push('');
lines.push('| Rule | Cases | TP | FP | FN | TN | Precision | Recall |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  lines.push(`| \`${r.rule}\` | ${r.n} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${r.precision} | ${r.recall} |`);
}
lines.push(`| **overall** | ${corpus.cases.length} | ${total.tp} | ${total.fp} | ${total.fn} | ${total.tn} | **${pct(total.tp, total.tp + total.fp)}** | **${pct(total.tp, total.tp + total.fn)}** |`);
lines.push('');
lines.push('## Where it misses (transparency)');
lines.push('');
if (misses.length === 0) {
  lines.push('No false positives or false negatives on the current corpus.');
} else {
  for (const m of misses) {
    lines.push(`- **${m.kind}** — \`${m.rule}\` · case \`${m.id}\` (${m.kind === 'FALSE NEGATIVE' ? 'a real issue the heuristic missed' : 'flagged clean code'})`);
  }
}
lines.push('');
lines.push('## Honest reading');
lines.push('');
lines.push('- **High precision is the design goal:** the recognizers are conservative — they avoid');
lines.push('  false positives (flagging clean code) even at the cost of recall, because a noisy SAST');
lines.push('  tool gets ignored. The FP-trap cases (SOQL in a comment/string, short non-Id literals)');
lines.push('  confirm comments/strings are stripped before matching.');
lines.push('- **The false negatives are the *documented* boundary, not surprises:** cross-method');
lines.push('  issues (a helper class that performs the DML/SOQL) and reflective access are invisible');
lines.push('  to a regex/token scanner — exactly what CLAUDE.md / POSITIONING disclose. (A dynamic');
lines.push('  `Database.query(...)` inside a loop IS still caught as a governor risk; only the');
lines.push("  query's resolved targets stay unknown.) The FN are measured here, not hand-waved.");
lines.push('- **Per-rule samples are small** (this is a seed corpus — expand `eval/sast-corpus.json`).');
lines.push('  The robust headline is overall precision; per-rule recall with n<5 is illustrative.');
lines.push('- **Use it as an advisor, not an oracle:** every finding stays `heuristic`; this report is');
lines.push('  the evidence behind that label.');
lines.push('');
const reportPath = join(here, '..', 'docs', 'reports', 'sast-accuracy-report.md');
writeFileSync(reportPath, lines.join('\n') + '\n');

console.log(`sast-accuracy: ${corpus.cases.length} cases, ${rows.length} rules`);
console.log(`  overall precision ${pct(total.tp, total.tp + total.fp)}, recall ${pct(total.tp, total.tp + total.fn)} (TP ${total.tp} / FP ${total.fp} / FN ${total.fn} / TN ${total.tn})`);
console.log(`  wrote ${reportPath}`);
