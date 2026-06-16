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
