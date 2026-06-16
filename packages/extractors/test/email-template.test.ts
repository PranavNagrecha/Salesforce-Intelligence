/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractEmailTemplate } from '../src/email-template.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const WELCOME_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/email/MarketingFolder/Welcome.email-meta.xml';
const WELCOME_GOLDEN_REL =
  'tests/golden/extractor-email-template/MarketingFolder.Welcome.json';
const NEWSLETTER_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/email/MarketingFolder/Newsletter.email-meta.xml';
const NEWSLETTER_GOLDEN_REL =
  'tests/golden/extractor-email-template/MarketingFolder.Newsletter.json';
const CASE_ACK_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/email/SupportFolder/CaseAck.email-meta.xml';
const CASE_ACK_GOLDEN_REL =
  'tests/golden/extractor-email-template/SupportFolder.CaseAck.json';

/**
 * Write a `.email-meta.xml` file under a fresh temp directory shaped as
 * `{tmpdir}/email/{folder}/{filename}`. Returns the temp-dir root (for
 * cleanup) and the absolute file path. The `email/` ancestor is
 * required by the extractor's folder-derivation rule.
 */
const writeTempEmailTemplate = async (
  folder: string,
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-email-template-'));
  const emailDir = join(dir, 'email', folder);
  await mkdir(emailDir, { recursive: true });
  const path = join(emailDir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Write a `.email-meta.xml` file under a custom dir layout where the
 * caller picks every directory segment. Used for the "missing email/
 * ancestor" path test.
 */
const writeAtCustomLayout = async (
  segments: readonly string[],
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-email-template-bad-'));
  const target = join(dir, ...segments);
  await mkdir(target, { recursive: true });
  const path = join(target, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractEmailTemplate', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Welcome (html, letterhead ref to Corporate)', async () => {
      // Golden's `sourcePath` is harness-relative; the extractor sees
      // an absolute path. Patch the golden to match before deep-equal.
      const fixtureAbsPath = resolve(HARNESS_ROOT, WELCOME_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, WELCOME_GOLDEN_REL);

      const result = await extractEmailTemplate(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden output for Newsletter (text, no letterhead, zero edges)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, NEWSLETTER_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, NEWSLETTER_GOLDEN_REL);

      const result = await extractEmailTemplate(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
      expect(result.value.edges).toEqual([]);
    });

    itHarness('produces the golden output for CaseAck (custom type, letterhead ref to Corporate)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, CASE_ACK_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CASE_ACK_GOLDEN_REL);

      const result = await extractEmailTemplate(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('cross-reference with Letterhead', () => {
    itHarness("emits a `references` edge targeting `Letterhead:{letterhead}` with role='letterhead'", async () => {
      // Welcome's <letterhead> is `Corporate`; the edge must target
      // `Letterhead:Corporate` exactly, with `properties.role` set to
      // `letterhead` per the EmailTemplate.md spec. The Welcome and
      // CaseAck fixtures both reference the Corporate letterhead, which
      // proves the Letterhead fixture is a real cross-reference target.
      const fixtureAbsPath = resolve(HARNESS_ROOT, WELCOME_FIXTURE_REL);
      const result = await extractEmailTemplate(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(1);
      const edge = result.value.edges[0];
      expect(edge).toBeDefined();
      if (!edge) return;
      expect(edge.fromId).toBe('EmailTemplate:MarketingFolder.Welcome');
      expect(edge.toId).toBe('Letterhead:Corporate');
      expect(edge.edgeType).toBe('references');
      expect(edge.confidence).toBe('declared');
      expect(edge.source).toBe('email-template-extractor');
      expect(edge.properties).toEqual({ role: 'letterhead' });
    });
  });

  describe('variant <type> values', () => {
    it('accepts visualforce templates and surfaces visualforcePageRef, bodyLength=0', async () => {
      // Per EmailTemplate.md, the `visualforce` variant carries no
      // inline body; instead, `<contentVisualforcePage>` names the VF
      // page that holds the body. `bodyLength` is always 0 for this
      // variant, even when there is incidental `<content>` text.
      // v3.0: visualforce templates skip the body merge scan since
      // their merge tokens live in the referenced VF page (covered by
      // the v1.4 visualforce-page extractor).
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>VF Wrapper</name>
  <subject>Generated by VF</subject>
  <type>visualforce</type>
  <available>true</available>
  <contentVisualforcePage>MyTemplatePage</contentVisualforcePage>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'PartnerFolder',
        'VfWrapper.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('EmailTemplate:PartnerFolder.VfWrapper');
        expect(node.properties.templateType).toBe('visualforce');
        expect(node.properties.visualforcePageRef).toBe('MyTemplatePage');
        expect(node.properties.bodyLength).toBe(0);
        expect(node.properties['mergeFields']).toEqual([]);
        expect(node.properties['referencedObjects']).toEqual([]);
        expect(node.properties['richTemplateSyntaxDetected']).toBe(false);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects template types outside {text, html, custom, visualforce}', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Bad Type</name>
  <subject>X</subject>
  <type>markdown</type>
  <available>true</available>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'AnyFolder',
        'BadType.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid template type: markdown');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('path / folder handling', () => {
    it('preserves slashes in FolderName for flattened nested folders', async () => {
      // Per EmailTemplate.md: a path like email/A/B/Template.email-meta.xml
      // treats `A/B` as a flat folder name (Salesforce's MDAPI flattens
      // nested UI folders this way).
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Nested</name>
  <subject>X</subject>
  <type>text</type>
  <available>true</available>
  <content>hi</content>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'OuterFolder/InnerFolder',
        'Nested.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe(
          'EmailTemplate:OuterFolder/InnerFolder.Nested',
        );
        expect(node.apiName).toBe('OuterFolder/InnerFolder.Nested');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the path has no `email/` ancestor', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Stranded</name>
  <subject>X</subject>
  <type>text</type>
  <available>true</available>
  <content>hi</content>
</EmailTemplate>`;
      // Place under `Other/Folder/` — no `email/` ancestor anywhere.
      const { dir, path } = await writeAtCustomLayout(
        ['Other', 'Folder'],
        'Stranded.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'cannot derive FolderName from path',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('optional element defaults', () => {
    it('defaults missing optional elements to null and emits no edge', async () => {
      // Minimal valid EmailTemplate: only the four required elements
      // plus content. Optional `description`, `encoding`, `letterhead`,
      // `style`, `uiType`, `contentVisualforcePage` all default to null.
      // v3.0 additive defaults: `mergeFields: []`, `referencedObjects: []`,
      // `richTemplateSyntaxDetected: false` when the body holds no
      // merge envelopes.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Minimal</name>
  <subject>Hi</subject>
  <type>text</type>
  <available>true</available>
  <content>body</content>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'unfiled$public',
        'Minimal.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('EmailTemplate:unfiled$public.Minimal');
        expect(node.properties).toEqual({
          subject: 'Hi',
          templateType: 'text',
          available: true,
          description: null,
          encoding: null,
          letterheadName: null,
          style: null,
          uiType: null,
          visualforcePageRef: null,
          bodyLength: 4,
          mergeFields: [],
          referencedObjects: [],
          richTemplateSyntaxDetected: false,
        });
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('v3.0 body merge-token extension', () => {
    it('emits one references edge per distinct merged field for a basic body', async () => {
      // Basic single-field merge: the Welcome variant of the v3.0 R2
      // emitter contract test. One `{!Account.Customer_Segment__c}`
      // token in the body produces one `references` edge with
      // `confidence: 'parsed'` and `role: 'body-merge'`.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Sales Welcome</name>
  <subject>Welcome, {!Account.Name}</subject>
  <type>html</type>
  <available>true</available>
  <content>&lt;p&gt;Hello {!Account.Name}, your segment is {!Account.Customer_Segment__c}.&lt;/p&gt;</content>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'Sales',
        'WelcomeEmail.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // mergeFields is sorted by canonical id ASC; Customer_Segment__c
        // precedes Name alphabetically inside CustomField:Account.*.
        expect(node.properties['mergeFields']).toEqual([
          'CustomField:Account.Customer_Segment__c',
          'CustomField:Account.Name',
        ]);
        expect(node.properties['referencedObjects']).toEqual(['Account']);
        expect(node.properties['richTemplateSyntaxDetected']).toBe(false);

        // Two body-merge edges; no letterhead in this fixture.
        expect(result.value.edges).toHaveLength(2);
        const segmentEdge = result.value.edges.find(
          (e) => e.toId === 'CustomField:Account.Customer_Segment__c',
        );
        expect(segmentEdge).toBeDefined();
        if (!segmentEdge) return;
        expect(segmentEdge.fromId).toBe(
          'EmailTemplate:Sales.WelcomeEmail',
        );
        expect(segmentEdge.edgeType).toBe('references');
        expect(segmentEdge.confidence).toBe('parsed');
        expect(segmentEdge.source).toBe('email-template-extractor');
        expect(segmentEdge.properties['role']).toBe('body-merge');
        expect(segmentEdge.properties['conditional']).toBe(false);
        expect(typeof segmentEdge.properties['mergeContext']).toBe('string');
        // The captured context preserves the `{!...}` envelope verbatim.
        expect(segmentEdge.properties['mergeContext']).toBe(
          '{!Account.Customer_Segment__c}',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('flips richTemplateSyntaxDetected when conditional merges appear', async () => {
      // Conditional merges (`{!IF(...)}`) capture the field references
      // inside the function call but flip the rich-syntax boolean so
      // the renderer can surface the "firing logic NOT captured"
      // disclosure per PLAN-v3.0 §4 honesty axis.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Marketing Nurture</name>
  <subject>Your offer</subject>
  <type>html</type>
  <available>true</available>
  <content>&lt;p&gt;{!IF(Account.Customer_Segment__c == "Enterprise", "Premium offer", "Standard offer")}&lt;/p&gt;</content>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'Marketing',
        'NurtureSeries.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['richTemplateSyntaxDetected']).toBe(true);
        expect(node.properties['mergeFields']).toEqual([
          'CustomField:Account.Customer_Segment__c',
        ]);
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe(
          'CustomField:Account.Customer_Segment__c',
        );
        // The conditional flag fires on the edge as well so downstream
        // consumers can filter to "only the conditional refs" without
        // re-walking the node's rich-syntax boolean.
        expect(edge.properties['conditional']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('deduplicates repeated references and spans multiple objects', async () => {
      // A multi-field merge that touches two objects; each distinct
      // (Object, Field) tuple produces exactly one edge regardless of
      // how many times it appears in the body. Tests both the dedup
      // discipline and the referencedObjects multi-object case.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Renewal</name>
  <subject>Renewal for {!Account.Name}</subject>
  <type>html</type>
  <available>true</available>
  <content>&lt;p&gt;Hi {!Contact.FirstName} {!Contact.LastName}, your account {!Account.Name} renews on {!Account.Renewal_Date__c}. Reach out to {!Contact.Email} or {!Contact.Email} for help.&lt;/p&gt;</content>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'Sales',
        'RenewalEmail.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // Five distinct fields across two objects; sorted ASC.
        expect(node.properties['mergeFields']).toEqual([
          'CustomField:Account.Name',
          'CustomField:Account.Renewal_Date__c',
          'CustomField:Contact.Email',
          'CustomField:Contact.FirstName',
          'CustomField:Contact.LastName',
        ]);
        expect(node.properties['referencedObjects']).toEqual([
          'Account',
          'Contact',
        ]);
        // One edge per distinct field — Contact.Email referenced twice
        // collapses to one edge.
        expect(result.value.edges).toHaveLength(5);
        // No conditional merges in this body — flag stays false even
        // with multiple references.
        expect(node.properties['richTemplateSyntaxDetected']).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('skips body scan for visualforce templates', async () => {
      // Visualforce templates have no inline body; field references
      // live inside the referenced VF page and are picked up by the
      // visualforce-page extractor. Even when `<content>` is present
      // it is incidental — the body scan must skip it so we don't
      // double-count refs that the VF extractor already captures.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>VF Wrapped</name>
  <subject>VF generated</subject>
  <type>visualforce</type>
  <available>true</available>
  <contentVisualforcePage>MyTemplatePage</contentVisualforcePage>
  <content>{!Account.Industry__c}</content>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'Partner',
        'VfWrapped.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['mergeFields']).toEqual([]);
        expect(node.properties['referencedObjects']).toEqual([]);
        expect(node.properties['richTemplateSyntaxDetected']).toBe(false);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('preserves a letterhead edge alongside body-merge edges', async () => {
      // Mixed-edge case: a template that BOTH references a Letterhead
      // AND merges a field. The output should hold two `references`
      // edges differentiated by `properties.role`.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Branded Welcome</name>
  <subject>Hello {!Account.Name}</subject>
  <type>html</type>
  <available>true</available>
  <letterhead>Corporate</letterhead>
  <content>&lt;p&gt;Welcome, {!Account.Name}.&lt;/p&gt;</content>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'Sales',
        'BrandedWelcome.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(2);
        const roles = result.value.edges.map(
          (e) => e.properties['role'],
        );
        expect(roles).toContain('letterhead');
        expect(roles).toContain('body-merge');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      // Path must include `email/{folder}/` for the path validator to
      // pass before the file-read step. Tests of file-existence go
      // through the well-formed path branch.
      const path = '/nonexistent/email/X/Missing.email-meta.xml';
      const result = await extractEmailTemplate(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempEmailTemplate(
        'X',
        'Bad.email-meta.xml',
        '<?xml version="1.0"?><EmailTemplate><name>X</wrongClose></EmailTemplate>',
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <EmailTemplate>', async () => {
      const { dir, path } = await writeTempEmailTemplate(
        'X',
        'Wrong.email-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <EmailTemplate> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <subject> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>No Subject</name>
  <type>text</type>
  <available>true</available>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'X',
        'NoSubject.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <subject>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <encoding> is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<EmailTemplate xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Bad Encoding</name>
  <subject>x</subject>
  <type>text</type>
  <available>true</available>
  <encoding>ASCII</encoding>
</EmailTemplate>`;
      const { dir, path } = await writeTempEmailTemplate(
        'X',
        'BadEnc.email-meta.xml',
        xml,
      );
      try {
        const result = await extractEmailTemplate(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid encoding: ASCII');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
