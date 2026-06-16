/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractRole } from '../src/role.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const EXEC_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.1/roles/Executive_Officer.role-meta.xml';
const EXEC_GOLDEN_PATH_REL = 'tests/golden/extractor-role/Executive_Officer.json';
const REP_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.1/roles/Sales_Rep.role-meta.xml';
const REP_GOLDEN_PATH_REL = 'tests/golden/extractor-role/Sales_Rep.json';

/**
 * Write a `.role-meta.xml` file under a fresh temp directory. Returns the
 * temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempRoleXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-role-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractRole', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Executive_Officer fixture (no parent)', async () => {
      // The extractor accepts the path verbatim and stores it as
      // `sourcePath`. The golden's `sourcePath` is the harness-rooted
      // relative path. Because vitest's cwd is the package directory (not
      // the harness root) and `process.chdir` is unsupported in vitest's
      // worker pool, we call the extractor with the absolute path and
      // patch the golden's `sourcePath` to match — deep-equality on every
      // other field still proves correctness.
      const fixtureAbsPath = resolve(HARNESS_ROOT, EXEC_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, EXEC_GOLDEN_PATH_REL);

      const result = await extractRole(fixtureAbsPath);
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

    itHarness('produces the golden output for the Sales_Rep fixture (inheritsFrom edge to Sales_Manager)', async () => {
      // Sales_Rep is the deepest role in the 4-deep synthetic hierarchy.
      // Its `<parentRole>Sales_Manager</parentRole>` produces one
      // `inheritsFrom` edge whose `toId` is `Role:Sales_Manager`.
      const fixtureAbsPath = resolve(HARNESS_ROOT, REP_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, REP_GOLDEN_PATH_REL);

      const result = await extractRole(fixtureAbsPath);
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

  describe('optional <parentRole>', () => {
    itHarness('emits zero edges and parentId=null for a top-of-hierarchy role', async () => {
      // Per Role.md, a role with no `<parentRole>` sits at the top of
      // the hierarchy — this is the documented happy path, not an error.
      const fixtureAbsPath = resolve(HARNESS_ROOT, EXEC_FIXTURE_PATH_REL);
      const result = await extractRole(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.parentId).toBeNull();
    });

    itHarness('emits one inheritsFrom edge to Role:{parentRole} when <parentRole> is present', async () => {
      // Per Role.md, the edge target uses the API name (basename) of the
      // parent role, not its display label. Sales_Rep's <parentRole> is
      // the API name `Sales_Manager`, not the display label "Sales Manager".
      const fixtureAbsPath = resolve(HARNESS_ROOT, REP_FIXTURE_PATH_REL);
      const result = await extractRole(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(1);
      const edge = result.value.edges[0];
      expect(edge).toBeDefined();
      if (!edge) return;
      expect(edge.fromId).toBe('Role:Sales_Rep');
      expect(edge.toId).toBe('Role:Sales_Manager');
      expect(edge.edgeType).toBe('inheritsFrom');
      expect(edge.confidence).toBe('declared');
      expect(edge.source).toBe('role-extractor');
      expect(edge.properties).toEqual({});
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.parentId).toBe('Role:Sales_Manager');
    });
  });

  describe('properties defaults', () => {
    it('defaults missing optional properties to null/false', async () => {
      // Per Role.md "Node properties map", every optional element
      // defaults: `*AccessLevel` and `description` to null,
      // `mayForecastManagerShare` to false.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Role xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Minimal Role</name>
</Role>`;
      const { dir, path } = await writeTempRoleXml(
        'Minimal_Role.role-meta.xml',
        xml,
      );
      try {
        const result = await extractRole(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('Role:Minimal_Role');
        expect(node.label).toBe('Minimal Role');
        expect(node.properties).toEqual({
          caseAccessLevel: null,
          contactAccessLevel: null,
          opportunityAccessLevel: null,
          mayForecastManagerShare: false,
          description: null,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('ignores elements outside the extractor surface (e.g., <forecastUserId>)', async () => {
      // Per Role.md "Elements the extractor ignores":
      // `opportunityAccessForAccountOwner` and `forecastUserId` may
      // appear in DX source but the extractor must skip them silently.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Role xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Ignores Extras</name>
  <opportunityAccessForAccountOwner>Read</opportunityAccessForAccountOwner>
  <forecastUserId>005xx000000000A</forecastUserId>
</Role>`;
      const { dir, path } = await writeTempRoleXml(
        'Extras.role-meta.xml',
        xml,
      );
      try {
        const result = await extractRole(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // Properties map should contain only the documented keys.
        expect(Object.keys(node.properties).sort()).toEqual([
          'caseAccessLevel',
          'contactAccessLevel',
          'description',
          'mayForecastManagerShare',
          'opportunityAccessLevel',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.role-meta.xml';
      const result = await extractRole(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      // Mismatched closing tag — fails XMLValidator.validate strictly.
      const { dir, path } = await writeTempRoleXml(
        'Bad.role-meta.xml',
        '<?xml version="1.0"?><Role><name>X</wrongClose></Role>',
      );
      try {
        const result = await extractRole(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <Role>', async () => {
      const { dir, path } = await writeTempRoleXml(
        'Wrong.role-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractRole(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <Role> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <name> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<Role xmlns="http://soap.sforce.com/2006/04/metadata">
  <description>No name field</description>
</Role>`;
      const { dir, path } = await writeTempRoleXml('NoName.role-meta.xml', xml);
      try {
        const result = await extractRole(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <name>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
