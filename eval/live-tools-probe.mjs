// Real-org probe for the operational live tools. Fires each (read-only,
// liveEnabled:true) against BOTH sandboxes and classifies the response as
// data / structured-error / BUG (internal error or throw). Finds real-org bugs
// the unit tests (mocked exec) can't. Read-only; never mutates an org.
//
//   pnpm --filter @sf-intelligence/mcp build
//   STRESS_VAULTS="a=/abs/a/org-kb,b=/abs/b/org-kb" node eval/live-tools-probe.mjs

import { buildContext, shutdown } from '../packages/mcp/dist/src/server.js';
import { dispatchTool } from '../packages/mcp/dist/src/tools/index.js';

const vaults = (process.env.STRESS_VAULTS ?? '')
  .split(',')
  .filter(Boolean)
  .map((s) => { const [name, path] = s.split('='); return { name, path }; });

// The operational live tools + realistic args. Standard objects so the query is
// valid on any org; the point is "does it execute and return shaped data".
const PROBES = [
  ['sfi.live_storage_by_object', { liveEnabled: true, limit: 15 }],
  ['sfi.live_data_skew', { liveEnabled: true, objectApiName: 'Account', ownerField: 'OwnerId', threshold: 200 }],
  ['sfi.live_setup_audit_trail', { liveEnabled: true, days: 30, limit: 15 }],
  ['sfi.live_security_exposure', { liveEnabled: true }],
  ['sfi.live_org_health', { liveEnabled: true }],
  ['sfi.live_report_usage', { liveEnabled: true, limit: 15 }],
  ['sfi.live_folder_access', { liveEnabled: true, limit: 15 }],
  ['sfi.live_email_template_usage', { liveEnabled: true, limit: 15 }],
];

const parse = (r) => { try { return JSON.parse(r.content?.[0]?.text ?? ''); } catch { return null; } };

const sig = (tool, d) => {
  if (!d || typeof d !== 'object') return '';
  const pick = (k) => (d[k] !== undefined ? `${k}=${d[k]}` : null);
  return [
    pick('totalRecords'), pick('objectCount'), pick('skewDetected'), pick('maxConcentration'),
    pick('totalChanges'), pick('modifyAllGrants'), pick('usersWithModifyAll'),
    pick('failedAsyncJobs'), pick('pausedFlowInterviews'), pick('totalReports'), pick('staleReports'),
    pick('totalFolders'), pick('publicFolders'), pick('totalTemplates'), pick('migrationCandidates'),
  ].filter(Boolean).slice(0, 4).join(' ');
};

const classify = (r) => {
  if (!r) return { status: 'BUG', detail: 'no-parse' };
  if (r.error) {
    const kind = r.error.kind ?? 'unknown';
    if (kind === 'internal' || String(r.error.message || '').startsWith('THREW')) {
      return { status: 'BUG', detail: `${kind}: ${String(r.error.message).slice(0, 90)}` };
    }
    return { status: 'ok-error', detail: `${kind}: ${String(r.error.message).slice(0, 70)}` };
  }
  return { status: 'data', detail: '' };
};

const runVault = async ({ name, path }) => {
  const built = await buildContext(path);
  if (!built.ok) { console.log(`SKIP ${name}: ${built.error.message}`); return null; }
  const ctx = built.value;
  console.log(`\n[${name}]  (org: ${ctx.manifest.sourceOrg})`);
  let bugs = 0;
  for (const [tool, args] of PROBES) {
    let out;
    try {
      const r = parse(await dispatchTool(ctx, tool, args));
      out = classify(r);
      out.sig = r?.data ? sig(tool, r.data) : '';
    } catch (e) {
      out = { status: 'BUG', detail: `THREW ${String(e?.message ?? e).slice(0, 90)}` };
    }
    if (out.status === 'BUG') bugs++;
    const mark = out.status === 'BUG' ? '❌' : out.status === 'data' ? '✅' : '·';
    console.log(`  ${mark} ${tool.padEnd(32)} ${out.status}${out.sig ? ` (${out.sig})` : ''}${out.detail ? ` [${out.detail}]` : ''}`);
  }
  await shutdown(ctx);
  return bugs;
};

const main = async () => {
  if (vaults.length === 0) { console.log('Set STRESS_VAULTS.'); process.exit(0); }
  console.log(`Live-tools real-org probe — ${PROBES.length} tools × ${vaults.length} sandbox(es)`);
  let totalBugs = 0;
  for (const v of vaults) { const b = await runVault(v); if (b !== null) totalBugs += b; }
  console.log(`\n==== ${totalBugs === 0 ? '✅ no BUGs' : `❌ ${totalBugs} BUG(s)`} across both orgs ====`);
  process.exit(totalBugs === 0 ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(1); });
