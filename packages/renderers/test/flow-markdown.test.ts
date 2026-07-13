/// <reference types="vitest/globals" />

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Edge, Node } from '@sf-intelligence/contracts';

import { renderFlowMarkdown } from '../src/flow-markdown.js';
import { serializeFrontmatter } from '../src/yaml-frontmatter.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const EXTRACTOR_GOLDEN_REL =
  'tests/golden/extractor-flow/RT_CU_BS_Update_Number_of_Event_Members_on_Engagement.json';

interface ExtractorGolden {
  readonly nodes: readonly Node[];
  readonly edges: readonly never[];
}

// Build a synthetic Flow node with only the keys the test cares about; the
// rest of Node's required fields are filled with v0.1 defaults (parentId
// null, lastModified* null, no apiVersion). Keeps each test's intent
// localized — what the test asserts is what the test sets.
const buildFlowNode = (overrides: {
  apiName?: string;
  label?: string | null;
  properties: Readonly<Record<string, unknown>>;
}): Node => ({
  id: `Flow:${overrides.apiName ?? 'TestFlow'}`,
  type: 'Flow',
  apiName: overrides.apiName ?? 'TestFlow',
  label: overrides.label === undefined ? (overrides.apiName ?? 'TestFlow') : overrides.label,
  parentId: null,
  sourcePath: 'flows/TestFlow.flow-meta.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: overrides.properties,
});

describe('renderFlowMarkdown', () => {
  itHarness('renders the RT_CU_BS_Update_Number_of_Event_Members_on_Engagement fixture with all the expected sections', async () => {
    const golden = JSON.parse(
      await readFile(resolve(HARNESS_ROOT, EXTRACTOR_GOLDEN_REL), 'utf-8'),
    ) as ExtractorGolden;
    const node = golden.nodes[0];
    expect(node).toBeDefined();
    if (!node) return;

    const result = renderFlowMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body, path, frontmatter } = result.value;
    expect(path).toBe(
      'components/Flow/RT_CU_BS_Update_Number_of_Event_Members_on_Engagement.md',
    );
    // Heading uses the fixture's label.
    expect(body).toContain(`# ${node.label}`);
    // Flow details section header and the four key fields.
    expect(body).toContain('## Flow details');
    expect(body).toContain('- **Status:** `Active`');
    expect(body).toContain('- **Process type:** `AutoLaunchedFlow`');
    expect(body).toContain('- **Trigger object:** `OA_Engagements__c`');
    expect(body).toContain('- **Trigger type:** `RecordBeforeSave`');
    expect(body).toContain('- **Record trigger type:** `CreateAndUpdate`');
    // Empty-edges stub.
    expect(body).toContain(
      '## Incident edges\n\n_No incident edges in this version. Flow semantic edges (callsApex, readsFrom, writesTo) are tracked in v0.2._',
    );
    // Frontmatter, once serialized, carries `type: Flow`.
    expect(serializeFrontmatter(frontmatter)).toContain('type: Flow');
  });

  it('emits a bare em dash for null trigger fields in the Flow details section', () => {
    const node = buildFlowNode({
      apiName: 'AutoLaunchedNoStart',
      label: 'Auto-Launched No Start',
      properties: {
        label: 'Auto-Launched No Start',
        description: null,
        status: 'Active',
        processType: 'AutoLaunchedFlow',
        interviewLabel: null,
        runInMode: null,
        triggerObject: null,
        triggerType: null,
        recordTriggerType: null,
      },
    });

    const result = renderFlowMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body } = result.value;
    // Each em-dashed line is emitted unquoted (no backticks around the dash).
    expect(body).toContain('- **Trigger object:** —');
    expect(body).toContain('- **Trigger type:** —');
    expect(body).toContain('- **Record trigger type:** —');
    // Non-null fields remain backtick-wrapped.
    expect(body).toContain('- **Status:** `Active`');
    expect(body).toContain('- **Process type:** `AutoLaunchedFlow`');
  });

  it('excludes status/processType/trigger keys from the Properties table', () => {
    const node = buildFlowNode({
      apiName: 'PropExclusion',
      label: 'Property Exclusion',
      properties: {
        // These should all be hidden from the Properties table.
        label: 'Property Exclusion',
        description: 'Demo flow for the exclusion test',
        status: 'Active',
        processType: 'AutoLaunchedFlow',
        triggerObject: 'Account',
        triggerType: 'RecordAfterSave',
        recordTriggerType: 'Update',
        // These two should survive into the table.
        interviewLabel: 'Demo interview',
        runInMode: 'DefaultMode',
      },
    });

    const result = renderFlowMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body } = result.value;
    // Pin the table down to exactly the two non-trigger optional rows; the
    // raw string compare proves both inclusion (the two rows) and exclusion
    // (no row for status, processType, triggerObject, etc.).
    const expectedTable = [
      '## Properties',
      '',
      '| Key | Value |',
      '| --- | --- |',
      '| interviewLabel | `Demo interview` |',
      '| runInMode | `DefaultMode` |',
    ].join('\n');
    expect(body).toContain(expectedTable);

    // Sanity: a status/trigger row would start with `| status |` etc. None
    // of these substrings should appear inside the Properties table.
    expect(body).not.toContain('| status |');
    expect(body).not.toContain('| processType |');
    expect(body).not.toContain('| triggerObject |');
    expect(body).not.toContain('| triggerType |');
    expect(body).not.toContain('| recordTriggerType |');
    expect(body).not.toContain('| description |');
    expect(body).not.toContain('| label |');
  });

  it('names the source endpoint for incoming edges in the defensive non-empty branch (not the rendered node itself)', () => {
    // Regression: previously the renderer hardcoded `toId` as the cell value,
    // so an incoming edge where `toId === thisNode.id` dumped the node's own
    // id into the table. After the fix, incoming edges name `fromId`. v0.1
    // Flow nodes carry zero edges in practice, but the defensive branch must
    // still get this right for v0.2.
    const node = buildFlowNode({
      apiName: 'OrderProcessor',
      label: 'Order Processor',
      properties: {
        status: 'Active',
        processType: 'AutoLaunchedFlow',
        triggerObject: null,
        triggerType: null,
        recordTriggerType: null,
      },
    });
    const edge: Edge = {
      fromId: 'ApexClass:OrderHandler',
      toId: 'Flow:OrderProcessor',
      edgeType: 'callsApex',
      confidence: 'parsed',
      source: 'apex-ast-extractor',
      properties: {},
    };

    const result = renderFlowMarkdown(node, [edge]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body } = result.value;
    expect(body).toContain('### callsApex (incoming, 1)');
    expect(body).toContain('| Source | Confidence | Producer |');
    expect(body).toContain('| `ApexClass:OrderHandler` | parsed | apex-ast-extractor |');
    // The empty-edges stub must NOT appear when edges are passed.
    expect(body).not.toContain('_No incident edges in this version.');
    // Self-id must NOT appear as a row value.
    expect(body).not.toMatch(/\|\s*`Flow:OrderProcessor`\s*\|\s*parsed/);
  });

  it('names the target endpoint for outgoing edges in the defensive non-empty branch', () => {
    const node = buildFlowNode({
      apiName: 'OrderProcessor',
      label: 'Order Processor',
      properties: {
        status: 'Active',
        processType: 'AutoLaunchedFlow',
        triggerObject: null,
        triggerType: null,
        recordTriggerType: null,
      },
    });
    const edge: Edge = {
      fromId: 'Flow:OrderProcessor',
      toId: 'CustomField:Order__c.Status__c',
      edgeType: 'writesTo',
      confidence: 'parsed',
      source: 'flow-xml-extractor',
      properties: {},
    };

    const result = renderFlowMarkdown(node, [edge]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body } = result.value;
    expect(body).toContain('### writesTo (outgoing, 1)');
    expect(body).toContain('| Target | Confidence | Producer |');
    expect(body).toContain(
      '| `CustomField:Order__c.Status__c` | parsed | flow-xml-extractor |',
    );
    expect(body).not.toMatch(/\|\s*`Flow:OrderProcessor`\s*\|\s*parsed/);
  });

  it('emits both incoming and outgoing subsections when a Flow has mixed-direction edges of the same type', () => {
    const node = buildFlowNode({
      apiName: 'OrderProcessor',
      label: 'Order Processor',
      properties: {
        status: 'Active',
        processType: 'AutoLaunchedFlow',
        triggerObject: null,
        triggerType: null,
        recordTriggerType: null,
      },
    });
    const edges: readonly Edge[] = [
      {
        fromId: 'ApexClass:OrderHandler',
        toId: 'Flow:OrderProcessor',
        edgeType: 'callsApex',
        confidence: 'parsed',
        source: 'apex-ast-extractor',
        properties: {},
      },
      {
        fromId: 'Flow:OrderProcessor',
        toId: 'ApexClass:Logger',
        edgeType: 'callsApex',
        confidence: 'parsed',
        source: 'flow-xml-extractor',
        properties: {},
      },
    ];

    const result = renderFlowMarkdown(node, edges);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body } = result.value;
    expect(body).toContain('### callsApex (incoming, 1)');
    expect(body).toContain('### callsApex (outgoing, 1)');
    expect(body).toContain('| `ApexClass:OrderHandler` | parsed | apex-ast-extractor |');
    expect(body).toContain('| `ApexClass:Logger` | parsed | flow-xml-extractor |');
    // Incoming subsection appears before outgoing (by document order).
    const inIdx = body.indexOf('### callsApex (incoming');
    const outIdx = body.indexOf('### callsApex (outgoing');
    expect(inIdx).toBeGreaterThan(-1);
    expect(outIdx).toBeGreaterThan(inIdx);
  });

  it('omits the description block (and its surrounding blank line) when description is null', () => {
    const node = buildFlowNode({
      apiName: 'NoDescription',
      label: 'No Description Flow',
      properties: {
        label: 'No Description Flow',
        description: null,
        status: 'Draft',
        processType: 'AutoLaunchedFlow',
        interviewLabel: null,
        runInMode: null,
        triggerObject: null,
        triggerType: null,
        recordTriggerType: null,
      },
    });

    const result = renderFlowMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body } = result.value;
    // The Type line should be followed by exactly one blank line and then
    // the Flow details heading — no doubled blank line, no leftover
    // description paragraph.
    expect(body).toContain('**Type:** Flow\n\n## Flow details');
    // And no stray "null" or "description" text leaks into the body.
    expect(body).not.toContain('description');
  });
});

describe('renderFlowMarkdown — markdown injection / escaping (CR-16c)', () => {
  it('does not let a backtick in a Flow detail value close the code span early', () => {
    const node = buildFlowNode({
      apiName: 'EvilFlow',
      label: 'Evil\nFlow',
      properties: {
        status: 'Ac`tive',
        processType: 'AutoLaunchedFlow',
        triggerObject: 'OA_Engagements__c',
        triggerType: null,
        recordTriggerType: null,
      },
    });
    const result = renderFlowMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.body.split('\n');

    // Heading newline collapsed → exactly one `# ` heading line.
    expect(lines.filter((l) => /^# /.test(l))).toHaveLength(1);

    // The Status bullet's backtick is escaped so the inline span is intact on
    // one line; the value tail is not leaked into prose. CR-16d: a single
    // embedded backtick forces a wider (2-backtick) fence, per CommonMark —
    // backslash-escaping the backtick does NOT work inside a code span
    // (backslash escapes are inert there), so the fence must be widened.
    const statusLine = lines.find((l) => l.startsWith('- **Status:**'));
    expect(statusLine).toBeDefined();
    expect(statusLine).toContain('``Ac`tive``');

    // Clean detail values are untouched.
    expect(result.value.body).toContain('- **Trigger object:** `OA_Engagements__c`');
  });
});
