/// <reference types="vitest/globals" />

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Edge, Node } from '@sf-intelligence/contracts';

import { renderComponentMarkdown } from '../src/component-markdown.js';
import { serializeFrontmatter } from '../src/yaml-frontmatter.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL = 'tests/fixtures/render-input/CustomObject_CustomerProject__c.json';
const GOLDEN_PATH_REL = 'tests/golden/renderer-component-markdown/CustomObject_CustomerProject__c.md';

interface Fixture {
  readonly node: Node;
  readonly edges: readonly Edge[];
}

describe('renderComponentMarkdown', () => {
  itHarness('matches the golden for the CustomerProject__c fixture byte-for-byte', async () => {
    const fixture = JSON.parse(
      await readFile(resolve(HARNESS_ROOT, FIXTURE_PATH_REL), 'utf-8'),
    ) as Fixture;
    const golden = await readFile(resolve(HARNESS_ROOT, GOLDEN_PATH_REL), 'utf-8');

    const result = renderComponentMarkdown(fixture.node, fixture.edges);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fullOutput =
      '---\n' +
      serializeFrontmatter(result.value.frontmatter) +
      '\n---\n\n' +
      result.value.body +
      '\n';

    expect(fullOutput).toBe(golden);
  });

  it('returns the canonical output path for a top-level CustomObject', () => {
    const node: Node = {
      id: 'CustomObject:Foo__c',
      type: 'CustomObject',
      apiName: 'Foo__c',
      label: 'Foo',
      parentId: null,
      sourcePath: 'objects/Foo__c/Foo__c.object-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe('components/CustomObject/Foo__c.md');
  });

  it('expands parentId colon into a path segment for child components', () => {
    const node: Node = {
      id: 'CustomField:Account.Industry__c',
      type: 'CustomField',
      apiName: 'Industry__c',
      label: 'Industry',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Industry__c.field-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: { dataType: 'Text' },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe('components/CustomField/CustomObject/Account/Industry__c.md');
  });

  it('omits the description block (and its surrounding blank line) when description is absent', () => {
    const node: Node = {
      id: 'CustomObject:Bare__c',
      type: 'CustomObject',
      apiName: 'Bare__c',
      label: 'Bare',
      parentId: null,
      sourcePath: 'objects/Bare__c/Bare__c.object-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      // No `description` key — block should be omitted entirely.
      properties: { sharingModel: 'ReadWrite' },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exactly one blank line between the Type line and `## Properties`.
    expect(result.value.body).toContain('**Type:** CustomObject\n\n## Properties');
    // No description text leaks into output.
    expect(result.value.body).not.toContain('description');
  });

  it('also omits the description block when description is an empty string', () => {
    const node: Node = {
      id: 'CustomObject:Empty__c',
      type: 'CustomObject',
      apiName: 'Empty__c',
      label: 'Empty',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: { description: '' },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toContain('**Type:** CustomObject\n\n## Properties');
  });

  it('renders a captured description for an enterprise type (Report) and keeps it out of the Properties table', () => {
    // Report/Dashboard/ReportType/PermissionSetGroup now capture a top-level
    // <description> into properties.description. The renderer is generic, so the
    // paragraph block + Properties-table exclusion applies to them with no
    // renderer change — this test locks that behavior for an enterprise type.
    const node: Node = {
      id: 'Report:Widget_Usage',
      type: 'Report',
      apiName: 'Widget_Usage',
      label: 'Widget Usage',
      parentId: null,
      sourcePath: 'reports/Widget_Usage.report-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: { description: 'Weekly rollup of widget usage.', rawReferenceCount: 0 },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Description renders as its own paragraph block right after the Type line.
    expect(result.value.body).toContain(
      '**Type:** Report\n\nWeekly rollup of widget usage.\n\n## Properties',
    );
    // ...and is NOT duplicated as a Properties-table row.
    expect(result.value.body).not.toContain('| description |');
  });

  it('falls back to apiName for the heading when label is null', () => {
    const node: Node = {
      id: 'CustomObject:NoLabel__c',
      type: 'CustomObject',
      apiName: 'NoLabel__c',
      label: null,
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body.startsWith('# NoLabel__c\n')).toBe(true);
  });

  it('keeps a multi-line / pipe-containing formula property from breaking the Properties table', () => {
    // Regression: a CustomField `formula` is routinely multi-line and uses the
    // `||` operator. Rendered raw, its newlines end the table row and its pipes
    // split the columns, corrupting the Markdown table.
    const node: Node = {
      id: 'CustomField:Account.Risk__c',
      type: 'CustomField',
      apiName: 'Risk__c',
      label: 'Risk',
      parentId: 'CustomObject:Account',
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: { formula: "IF(\n  A__c || B__c,\n  'High', 'Low'\n)" },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const formulaRow = result.value.body
      .split('\n')
      .find((line) => line.startsWith('| formula |'));
    expect(formulaRow).toBeDefined();
    // The whole multi-line formula collapsed onto the single table row (its
    // tail is present, and the row is terminated by a trailing pipe).
    expect(formulaRow).toContain("'Low'");
    expect(formulaRow?.endsWith('|')).toBe(true);
    // The `||` OR operator is pipe-escaped, not left as bare column delimiters.
    expect(formulaRow).toContain('\\|\\|');
    expect(formulaRow).not.toContain(' || ');
  });

  it('names the source endpoint for incoming edges (not the rendered node itself)', () => {
    // Regression: previously the renderer hardcoded `toId` as the cell value,
    // so an incoming edge where `toId === thisNode.id` dumped the node's own
    // id into the table. After the fix, incoming edges name `fromId`.
    const node: Node = {
      id: 'CustomObject:Project__c',
      type: 'CustomObject',
      apiName: 'Project__c',
      label: 'Degree Program',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };
    const edge: Edge = {
      fromId: 'PermissionSet:Foo',
      toId: 'CustomObject:Project__c',
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'permission-set-extractor',
      properties: {},
    };
    const result = renderComponentMarkdown(node, [edge]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toContain('### grantedBy (incoming, 1)');
    expect(result.value.body).toContain('| Source | Confidence | Producer |');
    expect(result.value.body).toContain('| `PermissionSet:Foo` | declared | permission-set-extractor |');
    // Self-id must NOT appear as a row value.
    expect(result.value.body).not.toMatch(/\|\s*`CustomObject:Project__c`\s*\|\s*declared/);
  });

  it('names the target endpoint for outgoing edges', () => {
    const node: Node = {
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };
    const edge: Edge = {
      fromId: 'CustomObject:Account',
      toId: 'CustomField:Account.Industry__c',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'custom-object-extractor',
      properties: {},
    };
    const result = renderComponentMarkdown(node, [edge]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toContain('### parentOf (outgoing, 1)');
    expect(result.value.body).toContain('| Target | Confidence | Producer |');
    expect(result.value.body).toContain('| `CustomField:Account.Industry__c` | declared | custom-object-extractor |');
    // Self-id must NOT appear as a row value.
    expect(result.value.body).not.toMatch(/\|\s*`CustomObject:Account`\s*\|\s*declared/);
  });

  it('emits both incoming and outgoing subsections when a node has mixed-direction edges of the same type', () => {
    const node: Node = {
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };
    const edges: readonly Edge[] = [
      {
        fromId: 'ApexClass:AccountReader',
        toId: 'CustomObject:Account',
        edgeType: 'references',
        confidence: 'parsed',
        source: 'apex-ast-extractor',
        properties: {},
      },
      {
        fromId: 'CustomObject:Account',
        toId: 'CustomField:Account.Industry__c',
        edgeType: 'references',
        confidence: 'declared',
        source: 'custom-object-extractor',
        properties: {},
      },
    ];
    const result = renderComponentMarkdown(node, edges);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toContain('### references (incoming, 1)');
    expect(result.value.body).toContain('### references (outgoing, 1)');
    // Incoming row names fromId (ApexClass).
    expect(result.value.body).toContain('| `ApexClass:AccountReader` | parsed | apex-ast-extractor |');
    // Outgoing row names toId (CustomField).
    expect(result.value.body).toContain('| `CustomField:Account.Industry__c` | declared | custom-object-extractor |');
    // Incoming subsection appears before outgoing (by document order).
    const inIdx = result.value.body.indexOf('### references (incoming');
    const outIdx = result.value.body.indexOf('### references (outgoing');
    expect(inIdx).toBeGreaterThan(-1);
    expect(outIdx).toBeGreaterThan(inIdx);
  });

  it('reproduces the smoke-test bug fix: 5 incoming grantedBy edges name 5 distinct PermissionSet sources', () => {
    // Synthetic node mirroring the real CustomObject:Project__c symptom:
    // before the fix, all 5 rows showed the node's own id; after the fix, the
    // 5 PermissionSet ids appear and the self-id does not.
    const node: Node = {
      id: 'CustomObject:Project__c',
      type: 'CustomObject',
      apiName: 'Project__c',
      label: 'Degree Program',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };
    const psIds = [
      'PermissionSet:Advisor_Access',
      'PermissionSet:Faculty_Access',
      'PermissionSet:Registrar_Access',
      'PermissionSet:Student_Read',
      'Profile:Standard_User',
    ];
    const edges: readonly Edge[] = psIds.map((fromId) => ({
      fromId,
      toId: 'CustomObject:Project__c',
      edgeType: 'grantedBy',
      confidence: 'declared',
      source: 'permission-set-extractor',
      properties: {},
    }));
    const result = renderComponentMarkdown(node, edges);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toContain('### grantedBy (incoming, 5)');
    // No outgoing subsection emitted (count is 0).
    expect(result.value.body).not.toContain('### grantedBy (outgoing');
    for (const id of psIds) {
      expect(result.value.body).toContain(`| \`${id}\` | declared | permission-set-extractor |`);
    }
    // The node's own id must NOT appear as a table-row value.
    expect(result.value.body).not.toMatch(/\|\s*`CustomObject:Project__c`\s*\|\s*declared/);
  });

  it('renders picklistValues (an array property) as a YAML block sequence in the frontmatter', () => {
    // CustomField extractor emits `picklistValues: string[]` for picklist
    // fields. Before the yaml-frontmatter array fix the renderer threw on
    // this shape; the assertion below pins the post-fix behaviour: the
    // array appears as `- value` lines indented under the owning key inside
    // the `properties:` map.
    const node: Node = {
      id: 'CustomField:Account.Status__c',
      type: 'CustomField',
      apiName: 'Status__c',
      label: 'Status',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Status__c.field-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        dataType: 'Picklist',
        picklistValues: ['Open', 'In Progress', 'Closed'],
      },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fullOutput =
      '---\n' +
      serializeFrontmatter(result.value.frontmatter) +
      '\n---\n\n' +
      result.value.body +
      '\n';

    // The picklist values appear in the frontmatter, indented one level
    // deeper than `picklistValues:` inside the `properties:` map. Plain
    // spaces don't force quoting; insertion order is preserved.
    expect(fullOutput).toContain(
      'properties:\n  dataType: Picklist\n  picklistValues:\n    - Open\n    - In Progress\n    - Closed\n',
    );
  });

  it('H10: renders an object[] picklistValues body row human-readably (not [object Object]), marking inactive', () => {
    // A re-extracted vault stores picklistValues as objects. String(value) on
    // such an array yields `[object Object]` in the body Properties table;
    // renderValueAsBacktickedString must instead join the value labels and
    // suffix deactivated entries with (inactive).
    const node: Node = {
      id: 'CustomField:Account.Stage__c',
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Stage__c.field-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        dataType: 'Picklist',
        picklistValues: [
          { value: 'Open', isActive: true },
          { value: 'Closed', isActive: false },
        ],
      },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const picklistRow = result.value.body
      .split('\n')
      .find((line) => line.startsWith('| picklistValues |'));
    expect(picklistRow).toBeDefined();
    expect(picklistRow).not.toContain('[object Object]');
    expect(picklistRow).toContain('Open');
    expect(picklistRow).toContain('Closed (inactive)');
  });

  it('CR-P3 (low, golden-safe): a pure-string picklistValues row stays on the String() path (comma, no space)', () => {
    // A pure-string array has no [object Object] problem; it must NOT be
    // diverted to the comma-SPACE join, so its rendered cell is byte-identical
    // to the pre-fix `String()` output. This guards the golden/in-budget output.
    const node: Node = {
      id: 'CustomField:Account.Stage__c',
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Stage__c.field-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        dataType: 'Picklist',
        picklistValues: ['Open', 'In Progress', 'Closed'],
      },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const picklistRow = result.value.body
      .split('\n')
      .find((line) => line.startsWith('| picklistValues |'));
    // Exact pre-fix cell: `String(['Open','In Progress','Closed'])` -> commas,
    // no spaces, wrapped in backticks.
    expect(picklistRow).toBe('| picklistValues | `Open,In Progress,Closed` |');
  });

  it('CR-P3 (low): a MIXED legacy(string)+object picklistValues array renders each entry, never [object Object]', () => {
    // A vault refreshed across the legacy->object picklist-shape migration can
    // hold a heterogeneous array: some entries are bare strings (legacy) and
    // some are `{ value, isActive? }` objects (re-extracted). The guard used
    // `.every(isObject)`, so the string entry made it fall through to
    // String(value) -> `Open,[object Object]`. Both shapes must render.
    const node: Node = {
      id: 'CustomField:Account.Stage__c',
      type: 'CustomField',
      apiName: 'Stage__c',
      label: 'Stage',
      parentId: 'CustomObject:Account',
      sourcePath: 'objects/Account/fields/Stage__c.field-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        dataType: 'Picklist',
        picklistValues: ['Open', { value: 'Closed', isActive: false }],
      },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const picklistRow = result.value.body
      .split('\n')
      .find((line) => line.startsWith('| picklistValues |'));
    expect(picklistRow).toBeDefined();
    expect(picklistRow).not.toContain('[object Object]');
    expect(picklistRow).toContain('Open');
    expect(picklistRow).toContain('Closed (inactive)');
  });

  it('renders Profile loginIpRanges as readable IP range pairs (not [object Object])', () => {
    // A Profile's `loginIpRanges` is an array of `{ startAddress, endAddress }`
    // objects (collected by the profile extractor). A bare String() on the
    // array emits `[object Object]` for each entry; renderValueAsBacktickedString
    // must instead join the entries as `start-end` pairs.
    const node: Node = {
      id: 'Profile:RestrictedProfile',
      type: 'Profile',
      apiName: 'RestrictedProfile',
      label: 'Restricted Profile',
      parentId: null,
      sourcePath: 'profiles/RestrictedProfile.profile-meta.xml',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        userPermissions: ['ActivateContracts', 'AllowUniversalSearch'],
        loginIpRanges: [
          { startAddress: '10.0.0.1', endAddress: '10.0.0.255' },
          { startAddress: '192.168.1.0', endAddress: '192.168.1.255' },
        ],
      },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loginIpRangesRow = result.value.body
      .split('\n')
      .find((line) => line.startsWith('| loginIpRanges |'));
    expect(loginIpRangesRow).toBeDefined();
    // Each IP range rendered as startAddress-endAddress, comma-joined.
    expect(loginIpRangesRow).toContain('10.0.0.1-10.0.0.255');
    expect(loginIpRangesRow).toContain('192.168.1.0-192.168.1.255');
    // No [object Object] literals.
    expect(loginIpRangesRow).not.toContain('[object Object]');
  });
});

describe('renderComponentMarkdown — markdown injection / escaping (CR-16c)', () => {
  it('neutralizes structure-breaking chars in label, apiName, and description', () => {
    const node: Node = {
      id: 'CustomObject:Evil__c',
      type: 'CustomObject',
      // Newline (would inject a 2nd heading line), leading hash (level shift),
      // backtick (closes a span), pipe (table), asterisk (emphasis).
      label: 'Evil\n# Injected\n`code` | *bold*',
      apiName: 'Ev`il__c',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      // A line-leading hash, a pipe table row, and a code fence in the desc.
      properties: {
        description: '# Heading injection\n| col | injection |\n```js\nalert(1)\n```',
      },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.body;
    const lines = body.split('\n');

    // (a) Exactly one heading line — the newline in label was collapsed and the
    // injected leading hash neutralized, so no spurious second `# ` heading.
    const headingLines = lines.filter((l) => /^# /.test(l));
    expect(headingLines).toHaveLength(1);

    // (b) The API Name code span is not closed early by the backtick in apiName:
    // the whole apiName stays inside the span (escaped backtick).
    const apiLine = lines.find((l) => l.startsWith('**API Name:**'));
    expect(apiLine).toBeDefined();
    expect(apiLine).toContain('Ev\\`il__c');

    // (c) No description line is parsed as a heading / table-delimiter / fence —
    // the line-leading specials are backslash-escaped.
    const descLine = lines.find((l) => l.includes('Heading injection'));
    expect(descLine).toBeDefined();
    expect(descLine?.startsWith('\\#')).toBe(true);
    expect(lines.some((l) => l.startsWith('| col |'))).toBe(false);
    expect(lines.some((l) => l.startsWith('```'))).toBe(false);
  });

  it('neutralizes a `| --- |` table-delimiter line inside a description (no GFM table injection)', () => {
    const node: Node = {
      id: 'CustomObject:Tbl__c',
      type: 'CustomObject',
      label: 'Tbl',
      apiName: 'Tbl__c',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: { description: 'Header line\n| --- |\nMore prose' },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.body.split('\n');
    // The delimiter row's leading pipe is escaped, so it cannot turn the
    // preceding prose line into a GFM table.
    expect(lines.some((l) => l === '| --- |')).toBe(false);
    expect(lines.some((l) => l.startsWith('\\| --- |'))).toBe(true);
  });

  it('leaves a clean component byte-identical (no over-escaping)', () => {
    const node: Node = {
      id: 'CustomObject:CustomerProject__c',
      type: 'CustomObject',
      label: 'Degree Program',
      apiName: 'Project__c',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: { description: 'Plain prose.' },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.body;
    expect(body).toContain('# Degree Program\n');
    expect(body).toContain('**API Name:** `Project__c`');
    expect(body).toContain('Plain prose.');
    // No stray backslashes introduced into clean values.
    expect(body).not.toContain('\\');
  });

  it('CR-P3-6: neutralizes a markdown link / image in the H1 label (no live link or beacon image)', () => {
    const node: Node = {
      id: 'CustomObject:Lnk__c',
      type: 'CustomObject',
      label: '[x](http://evil) ![](http://beacon)',
      apiName: 'Lnk__c',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const headingLine = result.value.body
      .split('\n')
      .find((l) => l.startsWith('# '));
    expect(headingLine).toBeDefined();
    // Brackets and the image-bang are escaped.
    expect(headingLine).toContain('\\[x\\]');
    expect(headingLine).toContain('\\!\\[');
    // The heading is NOT a live link: no unescaped [..](..) pair survives.
    expect(headingLine).not.toMatch(/\[[^\]\\]*\]\([^)]*\)/);
  });

  it('CR-P3-6: neutralizes raw-HTML / autolink in the H1 label (no inline HTML beacon or autolink)', () => {
    const node: Node = {
      id: 'CustomObject:Html__c',
      type: 'CustomObject',
      label: '<img src=x onerror=alert(1)> <http://evil>',
      apiName: 'Html__c',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {},
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const headingLine = result.value.body
      .split('\n')
      .find((l) => l.startsWith('# '));
    expect(headingLine).toBeDefined();
    // Every `<` is escaped, so no live inline-HTML element or autolink survives.
    expect(headingLine).toContain('\\<img');
    expect(headingLine).toContain('\\<http://evil>');
    // No UNescaped `<` opens an element/autolink (every `<` is preceded by `\`).
    expect(headingLine).not.toMatch(/(^|[^\\])<[^>]*>/);
  });

  it('CR-P3-9: neutralizes setext underline, ordered-list leader, and raw-HTML in a description block', () => {
    const node: Node = {
      id: 'CustomObject:Desc__c',
      type: 'CustomObject',
      label: 'Desc',
      apiName: 'Desc__c',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        description:
          'Heading bait\n===\n1. injected item\n<img src=x onerror=alert(1)>',
      },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.body.split('\n');
    // (a) No bare setext underline; the `===` line starts with `\=`.
    expect(lines.some((l) => /^=+$/.test(l))).toBe(false);
    expect(lines.some((l) => l.startsWith('\\='))).toBe(true);
    // (b) Ordered-list leader: separator escaped, line is no longer a list item.
    expect(lines.some((l) => /^\s*\d+[.)]\s/.test(l))).toBe(false);
    expect(lines.some((l) => l.startsWith('1\\.'))).toBe(true);
    // (c) Raw-HTML block: leading `<` escaped.
    expect(lines.some((l) => /^</.test(l))).toBe(false);
    expect(lines.some((l) => l.startsWith('\\<img'))).toBe(true);
  });

  it('CR-P3-9: leaves clean parenthesized labels and inline-digit / version / equals prose byte-identical', () => {
    const node: Node = {
      id: 'CustomObject:Clean__c',
      type: 'CustomObject',
      label: 'Customer Project (active)',
      apiName: 'Clean__c',
      parentId: null,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: {
        description: 'Tracks projects. See item 1. inline. Version 2.0. a = b.',
      },
    };
    const result = renderComponentMarkdown(node, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.body;
    // Heading: parens NOT escaped.
    expect(body).toContain('# Customer Project (active)\n');
    // Description line byte-identical: no backslash before 1. / 2.0 / = / (.
    expect(body).toContain(
      'Tracks projects. See item 1. inline. Version 2.0. a = b.',
    );
    const descLine = body
      .split('\n')
      .find((l) => l.includes('Tracks projects'));
    expect(descLine).toBeDefined();
    expect(descLine).not.toContain('\\');
  });
});
