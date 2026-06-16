#!/usr/bin/env node
/**
 * Onboarding smoke (P11-sfi-onboard) — drives the REAL user-facing onboarding
 * chain end to end on a self-contained synthetic fixture, with no live org and
 * no `sf` CLI:
 *
 *     sfi init  →  sfi refresh --no-pull  →  sfi doctor  →  samples
 *
 * This is the invariant the existing `e2e-smoke.mjs` cannot prove: e2e builds a
 * vault at the GRAPH level (`importExtractionResults`), bypassing init/refresh.
 * This smoke proves the COMMANDS a new user actually runs produce a queryable
 * vault — the "one command exits 0 on fixture" bar.
 *
 * `sfi doctor` legitimately reports an Org-auth FAIL on a fixture (there is no
 * live org to query, and `sf` may be absent in CI), so the smoke asserts the
 * VAULT-side checks (Vault / Freshness / Graph all PASS) instead of doctor's
 * overall exit code. The "samples" stage spawns the REAL `sfi mcp` server and
 * queries the freshly-built vault over the MCP protocol.
 *
 * Self-contained (synthetic metadata only, no real org names) → CI-safe.
 * Run: `pnpm onboard:smoke`. Exit 0 = all assertions pass, 1 = a failure.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { vaultPaths } from '@sf-intelligence/vault';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'cli', 'bin', 'sfi.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Run the `sfi` bin in `cwd` and capture its outcome (never throws). */
const sfi = (args, cwd) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

// --- Synthetic source tree (no real org names) ---
// A small multi-type slice that exercises schema + automation + apex so the
// sample queries have real nodes and edges to return: an object with a field
// and a validation rule, a flow, and an apex class called by a trigger on the
// object. Shapes mirror the extractor unit fixtures (required elements only).
const OBJECT = 'Onboard_Widget__c';
const SOURCE_FILES = {
  [`objects/${OBJECT}/${OBJECT}.object-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <label>Onboard Widget</label>
    <nameField>
        <label>Widget Name</label>
        <type>Text</type>
    </nameField>
    <pluralLabel>Onboard Widgets</pluralLabel>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>`,
  [`objects/${OBJECT}/fields/Status__c.field-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <label>Status</label>
    <type>Text</type>
    <length>80</length>
</CustomField>`,
  [`objects/${OBJECT}/validationRules/Require_Status.validationRule-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Require_Status</fullName>
    <active>true</active>
    <errorConditionFormula>ISBLANK(Status__c)</errorConditionFormula>
    <errorMessage>Status is required.</errorMessage>
</ValidationRule>`,
  'flows/Onboard_Widget_Flow.flow-meta.xml': `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Onboard Widget Flow</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
</Flow>`,
  'classes/OnboardWidgetService.cls': `public with sharing class OnboardWidgetService {
    public static void touch(Onboard_Widget__c w) {
        w.Status__c = 'Reviewed';
    }
}`,
  'classes/OnboardWidgetService.cls-meta.xml': `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <status>Active</status>
</ApexClass>`,
  'triggers/OnboardWidgetTrigger.trigger': `trigger OnboardWidgetTrigger on Onboard_Widget__c (before insert) {
    for (Onboard_Widget__c w : Trigger.new) {
        OnboardWidgetService.touch(w);
    }
}`,
  'triggers/OnboardWidgetTrigger.trigger-meta.xml': `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <status>Active</status>
</ApexTrigger>`,
};

const writeSourceTree = (sourceRoot) => {
  for (const [rel, content] of Object.entries(SOURCE_FILES)) {
    const abs = join(sourceRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
};

const callText = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content?.[0]?.text ?? JSON.stringify(r);
};

console.log('sfi onboarding smoke\n');

const projectRoot = mkdtempSync(join(tmpdir(), 'sfi-onboard-'));
const vaultRoot = join(projectRoot, 'org-kb');
const paths = vaultPaths(vaultRoot);

try {
  // === Stage 1: sfi init (no org call) ===
  console.log('# init');
  const init = sfi(['init', '--target-org', 'ci-fixture', '--vault-root', 'org-kb'], projectRoot);
  check('sfi init exits 0', init.status === 0, `status ${init.status}${init.stderr ? ` — ${init.stderr.trim().slice(0, 120)}` : ''}`);
  let configWritten = false;
  try {
    JSON.parse(readFileSync(paths.config, 'utf8'));
    configWritten = true;
  } catch {
    /* leave false */
  }
  check('init wrote a vault config (org-kb/meta/config.json)', configWritten);

  // === Stage 2: sfi refresh --no-pull (extracts the synthetic source) ===
  console.log('\n# refresh --no-pull');
  writeSourceTree(paths.source);
  const refresh = sfi(['refresh', '--no-pull'], projectRoot);
  check('sfi refresh --no-pull exits 0', refresh.status === 0, `status ${refresh.status}${refresh.stderr ? ` — ${refresh.stderr.trim().slice(0, 200)}` : ''}`);

  let components = {};
  try {
    const manifest = JSON.parse(readFileSync(join(paths.meta, 'manifest.json'), 'utf8'));
    components = manifest.components ?? {};
  } catch {
    /* leave empty — the count assertions below will fail informatively */
  }
  // Every type in the synthetic slice must have made it into the manifest. A
  // zero anywhere means an extractor silently failed during the onboarding run.
  for (const type of ['CustomObject', 'CustomField', 'ValidationRule', 'Flow', 'ApexClass', 'ApexTrigger']) {
    check(`refresh modeled ${type} (count ≥ 1)`, (components[type] ?? 0) >= 1, `count ${components[type] ?? 0}`);
  }

  // === Stage 3: sfi doctor (vault-side checks must pass; org-auth may fail) ===
  console.log('\n# doctor');
  const doctor = sfi(['doctor'], projectRoot);
  const out = `${doctor.stdout ?? ''}${doctor.stderr ?? ''}`;
  check('doctor ran and produced a report', out.includes('sfi doctor'), `status ${doctor.status}`);
  check('doctor: Vault check PASS', out.includes('PASS  Vault:'), firstFail(out));
  check('doctor: Freshness check PASS (just refreshed)', out.includes('PASS  Freshness:'), firstFail(out));
  check('doctor: Graph check PASS', out.includes('PASS  Graph:'), firstFail(out));
  // The onboarding-relevant checks must never be FAIL on a freshly-built vault.
  check(
    'doctor: no vault-side FAIL (Vault/Refresh/Graph)',
    !out.includes('FAIL  Vault:') && !out.includes('FAIL  Refresh:') && !out.includes('FAIL  Graph:'),
    firstFail(out),
  );

  // === Stage 4: samples — query the onboarded vault over the real MCP server ===
  console.log('\n# samples (sfi mcp)');
  const transport = new StdioClientTransport({ command: 'node', args: [BIN, 'mcp'], cwd: projectRoot, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  const client = new Client({ name: 'onboard-smoke', version: '1' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const health = await callText(client, 'sfi.health_check', {});
    check('health_check: graph readable', health.includes('"graphReadable":true'), health.slice(0, 120));

    const list = await callText(client, 'sfi.list_components', { type: 'CustomObject' });
    check('list_components returns the onboarded object', list.includes(`CustomObject:${OBJECT}`), list.slice(0, 120));

    const resolved = await callText(client, 'sfi.resolve', { query: 'onboard widget' });
    check('resolve maps an informal name to the object', resolved.includes(`CustomObject:${OBJECT}`), resolved.slice(0, 120));

    const component = await callText(client, 'sfi.get_component', { id: `CustomObject:${OBJECT}` });
    check('get_component returns the onboarded object', component.includes(OBJECT), component.slice(0, 120));
  } catch (e) {
    check('samples scenario ran', false, `${e.message}${stderr ? ` | server: ${stderr.trim().slice(0, 160)}` : ''}`);
  } finally {
    await client.close().catch(() => {});
  }
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}

/** Extract the first `FAIL  <name>` line from a doctor report, for context. */
function firstFail(report) {
  const line = report.split('\n').find((l) => l.includes('FAIL  '));
  return line ? line.trim() : '';
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
