#!/usr/bin/env node
/**
 * Run what CI runs, locally, before a release.
 *
 *   pnpm release:check            # run every step, then print a pass/fail table
 *   pnpm release:check --list     # print the steps without running them
 *   pnpm release:check --bail     # stop at the first failing step
 *
 * Why this exists: the 0.4.0 release passed the unit suite and the QA commit
 * gate locally, then failed CI twice on steps neither of them runs (the org-leak
 * scan and the analytical eval). The step list is READ FROM
 * .github/workflows/ci.yml (jobs `unit-test` and `build-test`, the Linux jobs
 * publish.yml waits for), never hand-copied, so it cannot drift from CI.
 *
 * Differences from CI, all deliberate:
 * - setup steps (`uses:` actions, "Install pnpm/Node", `pnpm install`) are skipped:
 *   run `pnpm install --frozen-lockfile` yourself first;
 * - the org-leak step writes the blocklist from a CI secret and DELETES it at the
 *   end. Locally only its scanner commands run (lines starting with `node ` or
 *   `pnpm `), against scripts/forbidden-names.local.json, which must exist:
 *   without it the scan would pass vacuously, so this script fails closed;
 * - a command that appears in both jobs (e.g. `pnpm -r build`) runs once.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = join(ROOT, '.github', 'workflows', 'ci.yml');
const JOBS = ['unit-test', 'build-test'];
const SKIP_STEP = /^(Install (pnpm|Node|dependencies)\b|Checkout\b|Set ?up\b)/i;

const args = new Set(process.argv.slice(2));

/** Parse the `run:` steps (and job-level env) of the named jobs from ci.yml. */
function readSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  const env = {};
  let job = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const jobMatch = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (jobMatch) {
      job = JOBS.includes(jobMatch[1]) ? jobMatch[1] : null;
      continue;
    }
    if (!job) continue;
    if (/^ {4}env:\s*$/.test(line)) {
      for (let j = i + 1; j < lines.length && /^ {6}\S/.test(lines[j]); j++) {
        const kv = /^ {6}([A-Z0-9_]+):\s*'?([^'#]*?)'?\s*$/.exec(lines[j]);
        if (kv) env[kv[1]] = kv[2];
      }
      continue;
    }
    const nameMatch = /^ {6}- name:\s*(.+?)\s*$/.exec(line);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    let run = null;
    for (let j = i + 1; j < lines.length && !/^ {6}- /.test(lines[j]) && !/^ {2}\S/.test(lines[j]); j++) {
      if (/^ {8}run:\s*\|\s*$/.test(lines[j])) {
        const body = [];
        for (let k = j + 1; k < lines.length && (/^ {10}/.test(lines[k]) || lines[k].trim() === ''); k++) {
          body.push(lines[k].slice(10));
        }
        run = body.join('\n').trimEnd();
        break;
      }
      const single = /^ {8}run:\s+(\S.*?)\s*$/.exec(lines[j]);
      if (single) {
        run = single[1];
        break;
      }
    }
    if (run !== null && !SKIP_STEP.test(name)) steps.push({ job, name, run });
  }
  return { steps, env };
}

/** The leak step manages a CI secret; keep only its scanner commands. */
function localize(step) {
  if (!/ORG_LEAK_BLOCKLIST|forbidden-names\.local\.json/.test(step.run)) return step.run;
  return step.run
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(node|pnpm) /.test(l))
    .join('\n');
}

const { steps, env } = readSteps(readFileSync(CI_YML, 'utf8'));
if (steps.length === 0) {
  console.error(`release-check: found no run steps for jobs ${JOBS.join(', ')} in ${CI_YML}`);
  process.exit(2);
}

const seen = new Set();
const plan = [];
for (const step of steps) {
  const run = localize(step);
  if (!run || seen.has(run)) continue;
  seen.add(run);
  plan.push({ ...step, run });
}

if (args.has('--list')) {
  for (const [i, s] of plan.entries()) console.log(`${String(i + 1).padStart(2)}. [${s.job}] ${s.name}\n      ${s.run.split('\n').join('\n      ')}`);
  console.log(`\nenv: ${JSON.stringify(env)}`);
  process.exit(0);
}

const blocklist = join(ROOT, 'scripts', 'forbidden-names.local.json');
if (!existsSync(blocklist)) {
  console.error('release-check: scripts/forbidden-names.local.json is missing — the org-leak scan would pass vacuously. Restore it before releasing.');
  process.exit(2);
}

console.log(`release-check: ${plan.length} CI steps from ci.yml (${JOBS.join(' + ')}), env ${JSON.stringify(env)}`);
let head = '';
try {
  head = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
} catch {
  // not a git checkout; the summary just omits the SHA
}
const results = [];
for (const [i, s] of plan.entries()) {
  console.log(`\n=== ${i + 1}/${plan.length} ${s.name}`);
  const started = Date.now();
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', s.run], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  results.push({ name: s.name, ok: r.status === 0, secs: Math.round((Date.now() - started) / 1000) });
  if (r.status !== 0 && args.has('--bail')) break;
}

console.log(`\nrelease-check summary${head ? ` @ ${head}` : ''}:`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.secs}s)`);
const failed = results.filter((r) => !r.ok);
const skipped = plan.length - results.length;
if (skipped > 0) console.log(`  (stopped early: ${skipped} step(s) not run)`);
if (failed.length > 0 || skipped > 0) {
  console.log(`\nrelease-check: FAIL — fix before tagging. See RELEASING.md.`);
  process.exit(1);
}
console.log(`\nrelease-check: PASS — every CI step is green locally. Next: RELEASING.md step 4.`);
