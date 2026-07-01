/// <reference types="vitest/globals" />

import type { Node } from '@sf-intelligence/contracts';

import { renderVaultIndex } from '../src/vault-index.js';

// Build a synthetic Node with v0.1 defaults; overrides override only what
// each test cares about. Keeps each test's intent localized — what the
// test asserts is what the test sets.
const buildNode = (overrides: {
  id: string;
  type: Node['type'];
  apiName: string;
  label?: string | null;
  parentId?: string | null;
  sourcePath?: string;
  properties?: Readonly<Record<string, unknown>>;
}): Node => ({
  id: overrides.id,
  type: overrides.type,
  apiName: overrides.apiName,
  label: overrides.label === undefined ? overrides.apiName : overrides.label,
  parentId: overrides.parentId ?? null,
  sourcePath: overrides.sourcePath ?? `source/${overrides.apiName}.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: overrides.properties ?? {},
});

// Eight nodes spanning four component types — exercises group-by-type
// grouping (multiple ApexClass), parent-id link resolution (CustomFields
// with a CustomObject parent), and the label/apiName fallback for the
// PermissionSet (label null) without bloating the smoke test.
const buildSyntheticVault = (): readonly Node[] => [
  buildNode({
    id: 'ApexClass:AccountTriggerHandler',
    type: 'ApexClass',
    apiName: 'AccountTriggerHandler',
    label: 'Account Trigger Handler',
  }),
  buildNode({
    id: 'ApexClass:FormulaShareHelperSchedule',
    type: 'ApexClass',
    apiName: 'FormulaShareHelperSchedule',
    label: 'Formula Share Helper Schedule',
  }),
  buildNode({
    id: 'CustomField:Account.Industry__c',
    type: 'CustomField',
    apiName: 'Industry__c',
    label: 'Industry',
    parentId: 'CustomObject:Account',
  }),
  buildNode({
    id: 'CustomField:Account.Region__c',
    type: 'CustomField',
    apiName: 'Region__c',
    label: 'Region',
    parentId: 'CustomObject:Account',
  }),
  buildNode({
    id: 'CustomField:Contact.Acc_Title__c',
    type: 'CustomField',
    apiName: 'Acc_Title__c',
    label: 'Account Title',
    parentId: 'CustomObject:Contact',
  }),
  buildNode({
    id: 'Flow:LeadEnrichment',
    type: 'Flow',
    apiName: 'LeadEnrichment',
    label: 'Lead Enrichment',
  }),
  buildNode({
    id: 'Flow:OpportunityRollup',
    type: 'Flow',
    apiName: 'OpportunityRollup',
    label: 'Opportunity Rollup',
  }),
  // label null exercises the apiName fallback in the bullet text.
  buildNode({
    id: 'PermissionSet:Read_Only_Access',
    type: 'PermissionSet',
    apiName: 'Read_Only_Access',
    label: null,
  }),
];

describe('renderVaultIndex', () => {
  it('renders a synthetic 8-node vault with sections, bullets, and matching frontmatter', () => {
    const nodes = buildSyntheticVault();
    const result = renderVaultIndex(nodes);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { path, frontmatter, body } = result.value;

    // Output lives at the vault's components root.
    expect(path).toBe('components/index.md');

    // Title is the first line of the body.
    expect(body.startsWith('# SfIntelligence vault\n')).toBe(true);

    // Summary reports the totals matching the input shape: 8 nodes across
    // 4 distinct types (ApexClass, CustomField, Flow, PermissionSet).
    expect(body).toContain(
      "This is the index for the Salesforce org's knowledge vault. 8 components across 4 types are indexed below.",
    );

    // Section headings — counts match how the synthetic input is shaped.
    expect(body).toContain('## ApexClass (2)');
    expect(body).toContain('## CustomField (3)');
    expect(body).toContain('## Flow (2)');
    expect(body).toContain('## PermissionSet (1)');

    // Bullet for an ApexClass (no parent): `./ApexClass/{apiName}.md`.
    expect(body).toContain(
      '- [`ApexClass:AccountTriggerHandler`](./ApexClass/AccountTriggerHandler.md) — Account Trigger Handler',
    );
    // Bullet for a CustomField with a parent — the parent's type and api
    // name become nested path segments, matching the layout produced by
    // `renderComponentMarkdown` (`components/CustomField/CustomObject/Account/Industry__c.md`).
    expect(body).toContain(
      '- [`CustomField:Account.Industry__c`](./CustomField/CustomObject/Account/Industry__c.md) — Industry',
    );
    // Bullet for a Flow.
    expect(body).toContain(
      '- [`Flow:LeadEnrichment`](./Flow/LeadEnrichment.md) — Lead Enrichment',
    );
    // PermissionSet has a null label → bullet text falls back to apiName.
    expect(body).toContain(
      '- [`PermissionSet:Read_Only_Access`](./PermissionSet/Read_Only_Access.md) — Read_Only_Access',
    );

    // Frontmatter mirrors the totals shown in the summary line.
    expect(frontmatter).toEqual({
      generatedBy: 'sf-intelligence-vault-index',
      totalComponents: 8,
      typesIndexed: 4,
    });
  });

  it('renders sections in alphabetical order regardless of input order (determinism)', () => {
    const ordered = buildSyntheticVault();
    // Reverse-order copy: the same set of nodes, opposite iteration order.
    // If the renderer leaks any insertion-order dependency the bodies will
    // diverge at the first reordering point (typically the section list).
    const reversed = [...ordered].reverse();

    const a = renderVaultIndex(ordered);
    const b = renderVaultIndex(reversed);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Byte equality on the body is the strongest deterministic guarantee
    // — every section heading, every bullet, every separator must match
    // exactly.
    expect(a.value.body).toBe(b.value.body);
    expect(a.value.frontmatter).toEqual(b.value.frontmatter);
    expect(a.value.path).toBe(b.value.path);
  });

  it('handles an empty vault by emitting the title and a zero-zero summary with no sections', () => {
    const result = renderVaultIndex([]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { body, frontmatter } = result.value;

    // Title + summary only; no `##` section headings should appear.
    expect(body).toBe(
      [
        '# SfIntelligence vault',
        '',
        "This is the index for the Salesforce org's knowledge vault. 0 components across 0 types are indexed below.",
      ].join('\n'),
    );
    expect(body).not.toContain('## ');

    expect(frontmatter).toEqual({
      generatedBy: 'sf-intelligence-vault-index',
      totalComponents: 0,
      typesIndexed: 0,
    });
  });

  it('URL-encodes spaces (and other URL-significant chars) in apiNames per path segment', () => {
    // Profile names in Salesforce can contain spaces (`System Administrator`,
    // `Standard User`). The link target must encode the space as `%20` so
    // Obsidian and standard Markdown viewers resolve the file correctly.
    const node = buildNode({
      id: 'Profile:System Administrator',
      type: 'Profile',
      apiName: 'System Administrator',
      label: 'System Administrator',
    });

    const result = renderVaultIndex([node]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { body } = result.value;
    // The bullet's link target — segment with a space is URL-encoded.
    expect(body).toContain(
      '- [`Profile:System Administrator`](./Profile/System%20Administrator.md) — System Administrator',
    );
    // No raw space in the link target — that would be invalid for many
    // Markdown viewers even though Obsidian tolerates it.
    expect(body).not.toContain('./Profile/System Administrator.md');
  });
});

describe('renderVaultIndex — bullet label escaping (CR-16c)', () => {
  it('keeps a newline in node.label from splitting the bullet or injecting a new one', () => {
    const evil = buildNode({
      id: 'CustomObject:Evil__c',
      type: 'CustomObject',
      apiName: 'Evil__c',
      // Newline would split the bullet; the trailing fragment could be parsed
      // as a new list item / heading / table row.
      label: 'Evil\n- injected bullet',
    });
    const clean = buildNode({
      id: 'CustomObject:Clean__c',
      type: 'CustomObject',
      apiName: 'Clean__c',
      label: 'Clean Object',
    });
    const result = renderVaultIndex([evil, clean]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.body.split('\n');

    // Exactly two bullet lines (one per node) — the newline in the evil label
    // did NOT inject a spurious third bullet.
    const bullets = lines.filter((l) => l.startsWith('- ['));
    expect(bullets).toHaveLength(2);

    // The evil bullet stays a single line with the label tail collapsed onto it.
    const evilBullet = bullets.find((l) => l.includes('CustomObject:Evil__c'));
    expect(evilBullet).toBeDefined();
    expect(evilBullet).toContain('Evil - injected bullet');

    // The clean bullet is byte-identical to the un-escaped form.
    expect(result.value.body).toContain(
      '- [`CustomObject:Clean__c`](./CustomObject/Clean__c.md) — Clean Object',
    );
  });

  it('CR-P3 (low): neutralizes inline-markdown vectors in the bullet label (prose context, not code span)', () => {
    // The label sits in inline PROSE after the em dash, NOT inside a code
    // span — so the code-span escaper (backtick-only) under-escapes it. A
    // label with a pipe / link / raw-HTML / emphasis / leading `#` must be
    // neutralized by the prose-appropriate escaper (consistent with the
    // CR-P3-6 heading escaper used elsewhere in the renderers).
    const evil = buildNode({
      id: 'CustomObject:Vec__c',
      type: 'CustomObject',
      apiName: 'Vec__c',
      label: '# A | [x](http://evil) <img src=y> *b*',
    });
    const result = renderVaultIndex([evil]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bullet = result.value.body
      .split('\n')
      .find((l) => l.includes('CustomObject:Vec__c'));
    expect(bullet).toBeDefined();
    // Assert the ESCAPED form of each vector is present (the backtick-only
    // code-span escaper would leave all of these raw). Substring-absence
    // checks would false-pass — `\[x\]` still contains `[x]` as a substring —
    // so the contract is verified positively against the escaped output.
    // No live link: the brackets are backslash-escaped.
    expect(bullet).toContain('\\[x\\]');
    // No live raw-HTML/image beacon: the `<` is backslash-escaped.
    expect(bullet).toContain('\\<img src=y>');
    // No live emphasis: the asterisks are backslash-escaped.
    expect(bullet).toContain('\\*b\\*');
    // The pipe is escaped so it cannot read as a table delimiter downstream.
    expect(bullet).toContain('\\|');
    // The leading `#` of the label fragment is escaped.
    expect(bullet).toContain('\\#');
    // Sanity: the backtick-only escaper would have left the link bracket raw;
    // confirm no UN-escaped `[x](` survives (the char before `[` is `\`).
    expect(bullet).not.toMatch(/[^\\]\[x\]\(/);
  });

  it('CR-P3 (low): a clean bullet label stays byte-identical under the prose escaper (golden-safe)', () => {
    // Spaces and parens are common in labels (e.g. "Status (active)"); the
    // prose escaper must leave a clean label untouched so golden output and
    // in-budget renders do not churn.
    const node = buildNode({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account (Standard)',
    });
    const result = renderVaultIndex([node]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toContain(
      '- [`CustomObject:Account`](./CustomObject/Account.md) — Account (Standard)',
    );
  });
});
