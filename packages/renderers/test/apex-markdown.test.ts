/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { Edge, Node } from '@sf-intelligence/contracts';

import { renderApexMarkdown } from '../src/apex-markdown.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const APEX_FIXTURE_REL =
  'tests/fixtures/edu-org/source/main/default/classes/MRK_ClearLogsBatch.cls';

const buildClearLogsBatchNode = (sourcePath: string): Node => ({
  id: 'ApexClass:MRK_ClearLogsBatch',
  type: 'ApexClass',
  apiName: 'MRK_ClearLogsBatch',
  label: 'MRK_ClearLogsBatch',
  parentId: null,
  sourcePath,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: 50,
  properties: {
    status: 'Active',
    description: null,
    modifiers: ['public'],
    sharingModel: 'with sharing',
    superclass: null,
    implements: ['Database.Batchable<sObject>', 'Database.Stateful'],
    annotations: [],
    isTest: false,
    lineCount: 28,
    sourceBytes: 1242,
  },
});

describe('renderApexMarkdown — vault-relative sourcePath resolution', () => {
  it('resolves a relative sourcePath against the base dir for the read, keeping it relative in frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-intel-apex-base-'));
    try {
      const rel = 'source/main/default/classes/Rel.cls';
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, 'public class Rel { }\n', 'utf-8');
      const node: Node = {
        ...buildClearLogsBatchNode(rel),
        id: 'ApexClass:Rel',
        apiName: 'Rel',
        label: 'Rel',
      };

      const result = await renderApexMarkdown(node, [], root);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Read resolved against the base dir → source is present.
      expect(result.value.body).toContain('class Rel');
      // Frontmatter keeps the RELATIVE path — no absolute leak (this is what
      // sfi.get_component surfaces to the client).
      expect(result.value.frontmatter['sourcePath']).toBe(rel);
      expect(String(result.value.frontmatter['sourcePath']).includes(tmpdir())).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails cleanly when a relative sourcePath is given with no base dir', async () => {
    const node: Node = {
      ...buildClearLogsBatchNode('source/main/default/classes/Nope.cls'),
      id: 'ApexClass:Nope',
      apiName: 'Nope',
    };
    const result = await renderApexMarkdown(node, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('render-failure');
  });
});

describe('renderApexMarkdown', () => {
  itHarness('embeds the .cls source of the MRK_ClearLogsBatch fixture in a fenced apex block', async () => {
    const fixturePath = resolve(HARNESS_ROOT, APEX_FIXTURE_REL);
    const node = buildClearLogsBatchNode(fixturePath);

    const result = await renderApexMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body, path } = result.value;
    expect(path).toBe('components/ApexClass/MRK_ClearLogsBatch.md');
    expect(body).toContain('# MRK_ClearLogsBatch');
    expect(body).toContain('## Properties');
    expect(body).toContain('## Source');
    expect(body).toContain('```apex');
    // Known content from the fixture: the class declaration line.
    expect(body).toContain('class MRK_ClearLogsBatch');
    expect(body).toContain('```\n\n## Incident edges');
    // No truncation pointer for a 28-line file.
    expect(body).not.toContain('source truncated');
  });

  it('truncates source files longer than 500 lines and emits a pointer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-intel-apex-render-'));
    try {
      const longSource = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n');
      const sourcePath = join(dir, 'BigClass.cls');
      await writeFile(sourcePath, longSource, 'utf-8');

      const node: Node = {
        id: 'ApexClass:BigClass',
        type: 'ApexClass',
        apiName: 'BigClass',
        label: 'BigClass',
        parentId: null,
        sourcePath,
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      };

      const result = await renderApexMarkdown(node, []);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { body } = result.value;
      expect(body).toContain('line 500');
      expect(body).not.toContain('line 600');
      expect(body).toContain(
        `... [source truncated; 600 total lines. See ${sourcePath} for full text.]`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the source endpoint for incoming edges (not the rendered node itself)', async () => {
    // Regression: previously the renderer hardcoded `toId` as the cell value,
    // so an incoming edge where `toId === thisNode.id` dumped the node's own
    // id into the table. After the fix, incoming edges name `fromId`.
    const dir = await mkdtemp(join(tmpdir(), 'sf-intel-apex-incoming-'));
    try {
      const sourcePath = join(dir, 'AccountReader.cls');
      await writeFile(sourcePath, 'public class AccountReader {}\n', 'utf-8');
      const node: Node = {
        id: 'ApexClass:AccountReader',
        type: 'ApexClass',
        apiName: 'AccountReader',
        label: 'AccountReader',
        parentId: null,
        sourcePath,
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      };
      const edge: Edge = {
        fromId: 'ApexTrigger:AccountTrigger',
        toId: 'ApexClass:AccountReader',
        edgeType: 'callsApex',
        confidence: 'parsed',
        source: 'apex-ast-extractor',
        properties: {},
      };
      const result = await renderApexMarkdown(node, [edge]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body).toContain('### callsApex (incoming, 1)');
      expect(result.value.body).toContain('| Source | Confidence | Producer |');
      expect(result.value.body).toContain(
        '| `ApexTrigger:AccountTrigger` | parsed | apex-ast-extractor |',
      );
      // Self-id must NOT appear as a row value.
      expect(result.value.body).not.toMatch(/\|\s*`ApexClass:AccountReader`\s*\|\s*parsed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the target endpoint for outgoing edges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-intel-apex-outgoing-'));
    try {
      const sourcePath = join(dir, 'AccountReader.cls');
      await writeFile(sourcePath, 'public class AccountReader {}\n', 'utf-8');
      const node: Node = {
        id: 'ApexClass:AccountReader',
        type: 'ApexClass',
        apiName: 'AccountReader',
        label: 'AccountReader',
        parentId: null,
        sourcePath,
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      };
      const edge: Edge = {
        fromId: 'ApexClass:AccountReader',
        toId: 'CustomField:Account.Industry__c',
        edgeType: 'readsFrom',
        confidence: 'parsed',
        source: 'apex-ast-extractor',
        properties: {},
      };
      const result = await renderApexMarkdown(node, [edge]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body).toContain('### readsFrom (outgoing, 1)');
      expect(result.value.body).toContain('| Target | Confidence | Producer |');
      expect(result.value.body).toContain(
        '| `CustomField:Account.Industry__c` | parsed | apex-ast-extractor |',
      );
      expect(result.value.body).not.toMatch(/\|\s*`ApexClass:AccountReader`\s*\|\s*parsed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits both incoming and outgoing subsections when a node has mixed-direction edges of the same type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-intel-apex-mixed-'));
    try {
      const sourcePath = join(dir, 'AccountService.cls');
      await writeFile(sourcePath, 'public class AccountService {}\n', 'utf-8');
      const node: Node = {
        id: 'ApexClass:AccountService',
        type: 'ApexClass',
        apiName: 'AccountService',
        label: 'AccountService',
        parentId: null,
        sourcePath,
        lastModifiedDate: null,
        lastModifiedBy: null,
        apiVersion: null,
        properties: {},
      };
      const edges: readonly Edge[] = [
        {
          fromId: 'ApexTrigger:AccountTrigger',
          toId: 'ApexClass:AccountService',
          edgeType: 'callsApex',
          confidence: 'parsed',
          source: 'apex-ast-extractor',
          properties: {},
        },
        {
          fromId: 'ApexClass:AccountService',
          toId: 'ApexClass:Logger',
          edgeType: 'callsApex',
          confidence: 'parsed',
          source: 'apex-ast-extractor',
          properties: {},
        },
      ];
      const result = await renderApexMarkdown(node, edges);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.body).toContain('### callsApex (incoming, 1)');
      expect(result.value.body).toContain('### callsApex (outgoing, 1)');
      expect(result.value.body).toContain(
        '| `ApexTrigger:AccountTrigger` | parsed | apex-ast-extractor |',
      );
      expect(result.value.body).toContain('| `ApexClass:Logger` | parsed | apex-ast-extractor |');
      // Incoming subsection appears before outgoing (by document order).
      const inIdx = result.value.body.indexOf('### callsApex (incoming');
      const outIdx = result.value.body.indexOf('### callsApex (outgoing');
      expect(inIdx).toBeGreaterThan(-1);
      expect(outIdx).toBeGreaterThan(inIdx);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns render-failure when sourcePath does not exist', async () => {
    const node: Node = {
      id: 'ApexClass:Missing',
      type: 'ApexClass',
      apiName: 'Missing',
      label: 'Missing',
      parentId: null,
      sourcePath: '/nonexistent/path/to/Missing.cls',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };

    const result = await renderApexMarkdown(node, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('render-failure');
    expect(result.error.message).toContain('/nonexistent/path/to/Missing.cls');
    expect(result.error.nodeId).toBe('ApexClass:Missing');
  });
});
