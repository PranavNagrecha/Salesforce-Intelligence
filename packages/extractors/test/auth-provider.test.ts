/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractAuthProvider } from '../src/auth-provider.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FULL_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/authproviders/MyOpenIdProvider.authprovider-meta.xml';
const FULL_GOLDEN_PATH_REL =
  'tests/golden/extractor-auth-provider/MyOpenIdProvider.json';
const MIN_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/authproviders/SamlProvider.authprovider-meta.xml';
const MIN_GOLDEN_PATH_REL =
  'tests/golden/extractor-auth-provider/SamlProvider.json';

/**
 * Write a `.authprovider-meta.xml` file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempAuthProviderXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-auth-provider-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractAuthProvider', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the MyOpenIdProvider fixture (all elements present)', async () => {
      // The extractor accepts the path verbatim and stores it as
      // `sourcePath`. The golden's `sourcePath` is the harness-rooted
      // relative path. Because vitest's cwd is the package directory (not
      // the harness root) and `process.chdir` is unsupported in vitest's
      // worker pool, we call the extractor with the absolute path and
      // patch the golden's `sourcePath` to match.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FULL_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, FULL_GOLDEN_PATH_REL);

      const result = await extractAuthProvider(fixtureAbsPath);
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

    itHarness('produces the golden output for the SamlProvider fixture (minimal)', async () => {
      // SamlProvider only has the two required elements; every
      // optional property defaults to null or false. This pins the
      // documented defaults for the integration-map renderer.
      const fixtureAbsPath = resolve(HARNESS_ROOT, MIN_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, MIN_GOLDEN_PATH_REL);

      const result = await extractAuthProvider(fixtureAbsPath);
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

  describe('edges', () => {
    itHarness('emits zero edges per AuthProvider.md (Auth Providers are referenced, not referencing)', async () => {
      // Per AuthProvider.md §Edges: the registrationHandler property
      // names an ApexClass and executionUser names a User but v1.5
      // does NOT emit `references` edges for either — both are
      // string bindings surfaced as plain properties.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FULL_FIXTURE_PATH_REL);
      const result = await extractAuthProvider(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.authprovider-meta.xml';
      const result = await extractAuthProvider(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      // Mismatched closing tag — fails XMLValidator.validate strictly.
      const { dir, path } = await writeTempAuthProviderXml(
        'Bad.authprovider-meta.xml',
        '<?xml version="1.0"?><AuthProvider><friendlyName>X</wrongClose></AuthProvider>',
      );
      try {
        const result = await extractAuthProvider(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <AuthProvider>', async () => {
      const { dir, path } = await writeTempAuthProviderXml(
        'Wrong.authprovider-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractAuthProvider(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <AuthProvider> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <friendlyName> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<AuthProvider xmlns="http://soap.sforce.com/2006/04/metadata">
  <providerType>OpenIdConnect</providerType>
</AuthProvider>`;
      const { dir, path } = await writeTempAuthProviderXml(
        'NoFriendlyName.authprovider-meta.xml',
        xml,
      );
      try {
        const result = await extractAuthProvider(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <friendlyName>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <providerType> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<AuthProvider xmlns="http://soap.sforce.com/2006/04/metadata">
  <friendlyName>X</friendlyName>
</AuthProvider>`;
      const { dir, path } = await writeTempAuthProviderXml(
        'NoProviderType.authprovider-meta.xml',
        xml,
      );
      try {
        const result = await extractAuthProvider(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <providerType>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('providerType value handling', () => {
    it('surfaces unknown providerType values verbatim (no allowed-value validation)', async () => {
      // Per AuthProvider.md: "The extractor does NOT validate the
      // providerType value against the allowed-value set — Salesforce
      // extends the set over time, and the extractor surfaces new
      // values without error."
      const xml = `<?xml version="1.0"?>
<AuthProvider xmlns="http://soap.sforce.com/2006/04/metadata">
  <friendlyName>Custom</friendlyName>
  <providerType>NewExperimentalProvider</providerType>
</AuthProvider>`;
      const { dir, path } = await writeTempAuthProviderXml(
        'Custom.authprovider-meta.xml',
        xml,
      );
      try {
        const result = await extractAuthProvider(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['providerType']).toBe('NewExperimentalProvider');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
