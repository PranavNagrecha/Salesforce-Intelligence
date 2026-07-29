#!/usr/bin/env node
/**
 * Single source of truth for product surface counts (tools, types, skills).
 * Emits JSON to stdout; used by doc-drift tests and maintainer scripts.
 *
 * Run: node scripts/product-surface.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const contractsSrc = readFileSync(
  join(root, 'packages/contracts/src/index.ts'),
  'utf8',
);
// Bounded blocks — do not use `[\s\S]*?;` (stops at the first `;` in a comment).
const componentTypeBlock =
  contractsSrc.match(/export type ComponentType =([\s\S]*?)\nexport type ComponentId/)?.[1] ??
  '';
const edgeTypeBlock =
  contractsSrc.match(/export type EdgeType =([\s\S]*?)\nexport const EDGE_TYPES/)?.[1] ??
  '';

const componentTypeCount = (componentTypeBlock.match(/\| '[^']+'/g) ?? []).length;
const edgeTypeCount = (edgeTypeBlock.match(/\| '[^']+'/g) ?? []).length;

const { V01_TOOLS } = await import(
  join(root, 'packages/mcp/dist/src/tools/index.js')
);
const toolCount = V01_TOOLS.length;

const skillsRoot = join(root, '.claude/skills');
const skillCount = readdirSync(skillsRoot, { withFileTypes: true }).filter((d) =>
  d.isDirectory(),
).length;

const commandsRoot = join(root, '.claude/commands');
let slashCommandCount = 0;
try {
  slashCommandCount = readdirSync(commandsRoot).filter((f) => f.endsWith('.md'))
    .length;
} catch {
  slashCommandCount = 0;
}

const agentsRoot = join(root, '.claude/agents');
let agentCount = 0;
try {
  agentCount = readdirSync(agentsRoot).filter((f) => f.endsWith('.md')).length;
} catch {
  agentCount = 0;
}

const surface = {
  toolCount,
  componentTypeCount,
  edgeTypeCount,
  skillCount,
  slashCommandCount,
  agentCount,
  generatedAt: new Date().toISOString(),
};

if (process.argv.includes('--write')) {
  const outPath = join(root, 'eval/product-surface.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, `${JSON.stringify(surface, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
} else {
  console.log(JSON.stringify(surface, null, 2));
}
