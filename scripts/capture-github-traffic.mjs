#!/usr/bin/env node
/**
 * Capture GitHub repo traffic (views + clones) into a local JSONL history.
 *
 * Why: GitHub's traffic API retains only ~14 days. Without periodic capture the
 * signal is lost, not merely inconvenient. This script is privacy-preserving:
 * it stores aggregate counts only (no popular paths, no referrers, no tokens).
 *
 * Cadence (maintainer): run at least weekly (daily is fine). Documented in
 * docs/reports/adoption-baseline.md. Default output is gitignored.
 *
 * Usage:
 *   node scripts/capture-github-traffic.mjs
 *   pnpm adoption:traffic
 *
 * Env:
 *   SFI_ADOPTION_TRAFFIC_PATH  Override output JSONL path
 *   (otherwise .sfi-local/adoption/github-traffic.jsonl under repo root)
 *
 * Requires: `gh` authenticated with `repo` scope (traffic endpoints need it).
 * Exit: 0 on success; 1 on usage/API failure.
 */

import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const defaultOut = join(repoRoot, '.sfi-local', 'adoption', 'github-traffic.jsonl');
const outPath =
  process.env['SFI_ADOPTION_TRAFFIC_PATH'] !== undefined &&
  process.env['SFI_ADOPTION_TRAFFIC_PATH'] !== ''
    ? resolve(process.env['SFI_ADOPTION_TRAFFIC_PATH'])
    : defaultOut;

/**
 * @param {string[]} args
 * @returns {unknown}
 */
const ghJson = (args) => {
  const r = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error) {
    throw new Error(`gh failed to start: ${r.error.message}`);
  }
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim() || `exit ${r.status}`;
    throw new Error(`gh ${args.join(' ')}: ${err}`);
  }
  const text = (r.stdout || '').trim();
  if (text === '') return null;
  return JSON.parse(text);
};

/**
 * Resolve owner/repo from the current git remote via gh — never hardcode.
 * @returns {string} "owner/repo"
 */
const resolveRepo = () => {
  const view = ghJson(['repo', 'view', '--json', 'nameWithOwner']);
  if (
    view === null ||
    typeof view !== 'object' ||
    typeof /** @type {{ nameWithOwner?: unknown }} */ (view).nameWithOwner !==
      'string'
  ) {
    throw new Error('gh repo view did not return nameWithOwner');
  }
  return /** @type {{ nameWithOwner: string }} */ (view).nameWithOwner;
};

/**
 * Pull only aggregate traffic counts (privacy: no paths / referrers).
 * @param {string} nameWithOwner
 */
const fetchTraffic = (nameWithOwner) => {
  const views = ghJson([
    'api',
    `repos/${nameWithOwner}/traffic/views`,
    '--jq',
    '{count,uniques}',
  ]);
  const clones = ghJson([
    'api',
    `repos/${nameWithOwner}/traffic/clones`,
    '--jq',
    '{count,uniques}',
  ]);
  return { views, clones };
};

const main = () => {
  let nameWithOwner;
  try {
    nameWithOwner = resolveRepo();
  } catch (e) {
    console.error(
      `capture-github-traffic: cannot resolve repo (${e instanceof Error ? e.message : String(e)})`,
    );
    process.exit(1);
  }

  let traffic;
  try {
    traffic = fetchTraffic(nameWithOwner);
  } catch (e) {
    console.error(
      `capture-github-traffic: traffic API failed (${e instanceof Error ? e.message : String(e)})`,
    );
    console.error(
      'Hint: traffic endpoints require a token with `repo` scope and push access.',
    );
    process.exit(1);
  }

  const row = {
    capturedAt: new Date().toISOString(),
    // Store the slug for multi-fork maintainers; counts only otherwise.
    repo: nameWithOwner,
    views: traffic.views,
    clones: traffic.clones,
    // Explicit: we deliberately omit popular/paths and popular/referrers.
    retentionNote: 'github-api-retains-~14d; this row preserves the snapshot',
  };

  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, `${JSON.stringify(row)}\n`, 'utf8');

  const viewsCount =
    traffic.views && typeof traffic.views === 'object' && 'count' in traffic.views
      ? /** @type {{ count: unknown }} */ (traffic.views).count
      : '?';
  const clonesCount =
    traffic.clones &&
    typeof traffic.clones === 'object' &&
    'count' in traffic.clones
      ? /** @type {{ count: unknown }} */ (traffic.clones).count
      : '?';

  console.log(
    `capture-github-traffic: appended views=${viewsCount} clones=${clonesCount} → ${outPath}` +
      (existsSync(outPath) ? '' : ''),
  );
};

main();
