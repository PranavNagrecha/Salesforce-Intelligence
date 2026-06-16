#!/usr/bin/env node
// Analytical eval — verdict + trust tools (v4.1).
// Skips vaults missing from registry (CI-friendly).
// EVAL_STRICT=1 — fail if cases file lists vaults but none are registered.
// Run: pnpm eval:analytical

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildContext, shutdown } from '../packages/mcp/dist/src/server.js';
import { dispatchTool } from '../packages/mcp/dist/src/tools/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const strict = process.env.EVAL_STRICT === '1';
const registryPath =
  process.env.SF_INTELLIGENCE_REGISTRY_PATH ??
  (strict ? join(here, 'registry.ci.json') : join(repoRoot, '..', 'registry.json'));

const loadCases = () => {
  const order = strict
    ? ['cases.analytical.ci.json']
    : [
        'cases.analytical.local.json',
        'cases.analytical.example.json',
        'cases.analytical.ci.json',
      ];
  for (const name of order) {
    try {
      return { cases: JSON.parse(readFileSync(join(here, name), 'utf8')), source: name };
    } catch {
      /* try next */
    }
  }
  return { cases: {}, source: null };
};

const parseBody = (result) => {
  const text = result.content?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
};

const stableFindingsKey = (data) => {
  const findings = data?.findings ?? [];
  return JSON.stringify(
    findings.map((f) => ({
      rank: f.rank,
      severity: f.severity,
      category: f.category,
      summary: f.summary,
    })),
  );
};

const runCase = async (ctx, c, vaultName) => {
  const tool = c.tool;
  const result = await dispatchTool(ctx, tool, c.args ?? {});
  const body = parseBody(result);
  if (body?.error && !c.expectErrorKind) {
    return { ok: false, message: JSON.stringify(body.error) };
  }
  const data = body?.data ?? body;
  if (c.expectDeterministic === true) {
    const second = await dispatchTool(ctx, tool, c.args ?? {});
    const body2 = parseBody(second);
    const data2 = body2?.data ?? body2;
    if (stableFindingsKey(data) !== stableFindingsKey(data2)) {
      return { ok: false, message: 'findings ordering changed between calls' };
    }
  }
  if (c.expectVerdict && data?.verdict !== c.expectVerdict) {
    return {
      ok: false,
      message: `expected verdict ${c.expectVerdict}, got ${data?.verdict}`,
    };
  }
  if (c.expectCoverageCaveat && !data?.coverageCaveat) {
    return { ok: false, message: 'expected coverageCaveat' };
  }
  if (c.expectCoverageKnown && data?.coverageKnown !== true) {
    return { ok: false, message: 'expected coverageKnown' };
  }
  if (c.expectTrustProvenance && data?.trust?.provenance !== c.expectTrustProvenance) {
    return {
      ok: false,
      message: `expected trust.provenance ${c.expectTrustProvenance}`,
    };
  }
  if (c.expectTrustCompleteness && data?.trust?.completeness === undefined) {
    return { ok: false, message: 'expected trust.completeness' };
  }
  if (c.expectHasData && (data === undefined || data === null)) {
    return { ok: false, message: 'expected data payload' };
  }
  if (c.expectMinToolCount && (data?.toolCount ?? 0) < c.expectMinToolCount) {
    return {
      ok: false,
      message: `expected toolCount >= ${c.expectMinToolCount}`,
    };
  }
  if (c.expectIntelligencePlaneIds) {
    const ids = (data?.intelligencePlanes ?? []).map((p) => p.id);
    for (const expected of c.expectIntelligencePlaneIds) {
      if (!ids.includes(expected)) {
        return { ok: false, message: `expected intelligence plane ${expected}` };
      }
    }
  }
  if (c.expectErrorKind) {
    const kind = body?.error?.kind ?? body?.error;
    if (kind !== c.expectErrorKind) {
      return { ok: false, message: `expected error ${c.expectErrorKind}, got ${kind}` };
    }
  }
  if (c.expectReasoningStage) {
    const stages = (data?.reasoning ?? []).map((s) => s.stage);
    if (!stages.includes(c.expectReasoningStage)) {
      return {
        ok: false,
        message: `expected reasoning stage ${c.expectReasoningStage}, got ${stages.join(', ')}`,
      };
    }
  }
  if (c.expectUiSurface && data?.uiSurface !== c.expectUiSurface) {
    return {
      ok: false,
      message: `expected uiSurface ${c.expectUiSurface}, got ${data?.uiSurface}`,
    };
  }
  if (c.expectFlexiPageId && data?.flexiPageId !== c.expectFlexiPageId) {
    return {
      ok: false,
      message: `expected flexiPageId ${c.expectFlexiPageId}, got ${data?.flexiPageId}`,
    };
  }
  return { ok: true };
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
    console.log(`No registry at ${registryPath} — analytical eval skipped.`);
    return 0;
  }

  const { cases, source } = loadCases();
  if (source === null) {
    if (strict) {
      console.error('EVAL_STRICT: no analytical cases file');
      return 1;
    }
    console.log('No analytical cases file — skipped.');
    return 0;
  }

  let failures = 0;
  let passed = 0;
  let skippedVaults = 0;
  const byTool = {};
  const byCaseClass = {};

  const firstVaultName = Object.keys(registry.vaults ?? {})[0];

  for (const [vaultName, vaultCases] of Object.entries(cases)) {
    const resolvedName = vaultName === '*' ? firstVaultName : vaultName;
    if (resolvedName === undefined) {
      console.log(`skip ${vaultName}: no vault in registry`);
      skippedVaults += 1;
      continue;
    }
    const rawPath = registry.vaults?.[resolvedName]?.path;
    if (!rawPath) {
      console.log(`skip ${resolvedName}: not in registry`);
      skippedVaults += 1;
      continue;
    }
    const vaultPath = isAbsolute(rawPath) ? rawPath : resolve(repoRoot, rawPath);

    const built = await buildContext(vaultPath);
    if (!built.ok) {
      console.log(`skip ${resolvedName}: ${built.error.message}`);
      skippedVaults += 1;
      continue;
    }

    try {
      for (const c of vaultCases) {
        const tool = c.tool;
        const caseClass = c.caseClass ?? 'other';
        byTool[tool] = byTool[tool] ?? { pass: 0, fail: 0 };
        byCaseClass[caseClass] = byCaseClass[caseClass] ?? { pass: 0, fail: 0 };

        const outcome = await runCase(built.value, c, vaultName);
        if (!outcome.ok) {
          console.error(`FAIL ${vaultName} ${tool}: ${outcome.message}`);
          failures += 1;
          byTool[tool].fail += 1;
          byCaseClass[caseClass].fail += 1;
        } else {
          passed += 1;
          byTool[tool].pass += 1;
          byCaseClass[caseClass].pass += 1;
        }
      }
    } finally {
      await shutdown(built.value);
    }
  }

  const report = {
    source,
    passed,
    failures,
    skippedVaults,
    byTool,
    byCaseClass,
    generatedAt: new Date().toISOString(),
  };

  console.log('analytical eval report:');
  for (const [tool, counts] of Object.entries(byTool).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const total = counts.pass + counts.fail;
    const rate = total > 0 ? ((counts.pass / total) * 100).toFixed(1) : 'n/a';
    console.log(`  ${tool}: ${counts.pass}/${total} pass (${rate}%)`);
  }
  for (const [cls, counts] of Object.entries(byCaseClass).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    console.log(`  [${cls}] ${counts.pass} pass, ${counts.fail} fail`);
  }
  console.log(`  total: ${passed} pass, ${failures} fail, ${skippedVaults} vault(s) skipped`);

  const reportPath = process.env.EVAL_REPORT_PATH;
  if (reportPath) {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`  report written: ${reportPath}`);
  }

  if (strict && skippedVaults > 0 && Object.keys(cases).length > 0) {
    console.error('EVAL_STRICT: vault(s) in cases file not registered');
    return 1;
  }
  if (strict && passed === 0 && failures === 0) {
    console.error('EVAL_STRICT: no analytical cases ran');
    return 1;
  }
  if (failures > 0) {
    return 1;
  }
  console.log('analytical eval ok');
  return 0;
};

process.exit(await main());
