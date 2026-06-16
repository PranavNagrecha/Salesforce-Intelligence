/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractExternalService } from '../src/external-service.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const ORDER_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/externalServiceRegistrations/OrderService.externalServiceRegistration-meta.xml';
const ORDER_GOLDEN_PATH_REL =
  'tests/golden/extractor-external-service/OrderService.json';

/**
 * Write a `.externalServiceRegistration-meta.xml` file under a fresh
 * temp directory. Returns the temp-dir root (for cleanup) and the
 * absolute file path.
 */
const writeTempExternalServiceXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-external-service-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractExternalService', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the OrderService fixture (with namedCredential edge)', async () => {
      // OrderService exercises the namedCredential edge: the fixture
      // declares <namedCredential>OrderApi</namedCredential> which
      // produces one `references` edge to `NamedCredential:OrderApi`
      // with confidence 'declared' and properties { role: 'credential' }.
      const fixtureAbsPath = resolve(HARNESS_ROOT, ORDER_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, ORDER_GOLDEN_PATH_REL);

      const result = await extractExternalService(fixtureAbsPath);
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

  describe('namedCredential edge', () => {
    itHarness('emits a single references edge to NamedCredential when <namedCredential> is set', async () => {
      // Pin the documented edge shape: edgeType, confidence,
      // source, and the role: 'credential' property per task spec.
      const fixtureAbsPath = resolve(HARNESS_ROOT, ORDER_FIXTURE_PATH_REL);
      const result = await extractExternalService(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(1);
      const edge = result.value.edges[0];
      expect(edge).toBeDefined();
      if (!edge) return;
      expect(edge.fromId).toBe('ExternalService:OrderService');
      expect(edge.toId).toBe('NamedCredential:OrderApi');
      expect(edge.edgeType).toBe('references');
      expect(edge.confidence).toBe('declared');
      expect(edge.source).toBe('external-service');
      expect(edge.properties).toEqual({ role: 'credential' });
    });

    it('emits zero edges when <namedCredential> is absent', async () => {
      // Inline schema, no named credential — no edge emitted.
      const xml = `<?xml version="1.0"?>
<ExternalServiceRegistration xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>NoNC</label>
  <schemaType>OpenApi3</schemaType>
  <schema>openapi: 3.0.0
info:
  title: stub</schema>
  <status>InProgress</status>
</ExternalServiceRegistration>`;
      const { dir, path } = await writeTempExternalServiceXml(
        'NoNC.externalServiceRegistration-meta.xml',
        xml,
      );
      try {
        const result = await extractExternalService(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['namedCredential']).toBeNull();
        // Inline schema is surfaced as schemaInline (the rename).
        expect(node.properties['schemaInline']).toBe(
          'openapi: 3.0.0\ninfo:\n  title: stub',
        );
        expect(node.properties['schemaUrl']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('canonical ID and root tag mismatch', () => {
    itHarness('reads from <ExternalServiceRegistration> root but emits ExternalService:* canonical ID', async () => {
      // Per ExternalService.md: the XML root tag is
      // ExternalServiceRegistration (matching the metadata type
      // name) but the v1.5 ComponentType is the shorter
      // ExternalService. The canonical ID prefix is ExternalService.
      const fixtureAbsPath = resolve(HARNESS_ROOT, ORDER_FIXTURE_PATH_REL);
      const result = await extractExternalService(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('ExternalService:OrderService');
      expect(node.type).toBe('ExternalService');
      expect(node.apiName).toBe('OrderService');
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.externalServiceRegistration-meta.xml';
      const result = await extractExternalService(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempExternalServiceXml(
        'Bad.externalServiceRegistration-meta.xml',
        '<?xml version="1.0"?><ExternalServiceRegistration><label>X</wrongClose></ExternalServiceRegistration>',
      );
      try {
        const result = await extractExternalService(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <ExternalServiceRegistration>', async () => {
      const { dir, path } = await writeTempExternalServiceXml(
        'Wrong.externalServiceRegistration-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractExternalService(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <ExternalServiceRegistration> root',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <label> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ExternalServiceRegistration xmlns="http://soap.sforce.com/2006/04/metadata">
  <schemaType>OpenApi3</schemaType>
  <status>Complete</status>
</ExternalServiceRegistration>`;
      const { dir, path } = await writeTempExternalServiceXml(
        'NoLabel.externalServiceRegistration-meta.xml',
        xml,
      );
      try {
        const result = await extractExternalService(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <schemaType> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ExternalServiceRegistration xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>X</label>
  <status>Complete</status>
</ExternalServiceRegistration>`;
      const { dir, path } = await writeTempExternalServiceXml(
        'NoSchemaType.externalServiceRegistration-meta.xml',
        xml,
      );
      try {
        const result = await extractExternalService(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <schemaType>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <status> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ExternalServiceRegistration xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>X</label>
  <schemaType>OpenApi3</schemaType>
</ExternalServiceRegistration>`;
      const { dir, path } = await writeTempExternalServiceXml(
        'NoStatus.externalServiceRegistration-meta.xml',
        xml,
      );
      try {
        const result = await extractExternalService(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <status>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('schema source flexibility', () => {
    it('tolerates both <schemaUrl> and <schema> absent (no error)', async () => {
      // Per ExternalService.md: "The extractor does NOT enforce that
      // exactly one of <schemaUrl> / <schema> is present — both may
      // be absent ... the extractor surfaces the absence as
      // schemaUrl: null + schemaInline: null rather than as an error."
      const xml = `<?xml version="1.0"?>
<ExternalServiceRegistration xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Incomplete</label>
  <schemaType>OpenApi3</schemaType>
  <status>NotComplete</status>
</ExternalServiceRegistration>`;
      const { dir, path } = await writeTempExternalServiceXml(
        'NoSchemaSource.externalServiceRegistration-meta.xml',
        xml,
      );
      try {
        const result = await extractExternalService(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['schemaUrl']).toBeNull();
        expect(node.properties['schemaInline']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
