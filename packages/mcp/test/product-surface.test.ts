/// <reference types="vitest/globals" />

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { V01_TOOLS } from '../src/tools/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const readRepoFile = (rel: string): string =>
  readFileSync(join(repoRoot, rel), 'utf8');

/** Marketing docs must not hard-code stale tool counts. */
const FORBIDDEN_TOOL_COUNT_PATTERNS = [
  /\|\s*\*\*9[0-9]\*\*\s*\|\s*MCP tools/i,
  /\b94\s+MCP tools\b/i,
  /\b96\s+handlers\b/i,
  /\b88\s+MCP tools\b/i,
  /One file per tool[^\n]*\b96\b/,
];

const surfaceFromScript = (): {
  toolCount: number;
  componentTypeCount: number;
  edgeTypeCount: number;
  skillCount: number;
} => {
  const out = execSync('node scripts/product-surface.mjs', {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(out) as {
    toolCount: number;
    componentTypeCount: number;
    edgeTypeCount: number;
    skillCount: number;
  };
};

const countUnionMembers = (relPath: string, startMarker: string, endMarker: string): number => {
  const src = readRepoFile(relPath);
  const block = src.match(new RegExp(`${startMarker}([\\s\\S]*?)\\n${endMarker}`))?.[1] ?? '';
  return (block.match(/\| '[^']+'/g) ?? []).length;
};

describe('product surface counts', () => {
  it('V01_TOOLS.length matches product-surface script', () => {
    const surface = surfaceFromScript();
    expect(surface.toolCount).toBe(V01_TOOLS.length);
  });

  it('component and edge type counts match contracts unions', () => {
    const surface = surfaceFromScript();
    const componentTypes = countUnionMembers(
      'packages/contracts/src/index.ts',
      'export type ComponentType =',
      'export type ComponentId',
    );
    const edgeTypes = countUnionMembers(
      'packages/contracts/src/index.ts',
      'export type EdgeType =',
      'export const EDGE_TYPES',
    );
    expect(surface.componentTypeCount).toBe(componentTypes);
    expect(surface.edgeTypeCount).toBe(edgeTypes);
    expect(componentTypes).toBeGreaterThan(50);
    // CR-CAP-12 added the `hasMember` EdgeType (Group → member), 22 → 23.
    expect(edgeTypes).toBe(23);
  });

  it('marketing docs do not hard-code stale MCP tool counts', () => {
    const files = [
      'README.md',
      'docs/architecture.md',
      'docs/POSITIONING.md',
      'REPO-STRUCTURE.md',
      '.claude-plugin/plugin.json',
    ];
    for (const file of files) {
      const text = readRepoFile(file);
      for (const pattern of FORBIDDEN_TOOL_COUNT_PATTERNS) {
        expect(pattern.test(text), `${file} matches ${pattern}`).toBe(false);
      }
    }
  });

  it('README references live capabilities count instead of a fixed tool number', () => {
    const readme = readRepoFile('README.md');
    expect(readme).toContain('sfi.capabilities');
    expect(readme).not.toMatch(/\|\s*\*\*\d{2,3}\*\*\s*\|\s*MCP tools/);
  });
});
