/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractSharingRules } from '../src/sharing-rules.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const ACCOUNT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.1/sharingRules/Account.sharingRules-meta.xml';
const ACCOUNT_GOLDEN_REL =
  'tests/golden/extractor-sharing-rules/Account.json';
const OPPORTUNITY_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.1/sharingRules/Opportunity.sharingRules-meta.xml';
const OPPORTUNITY_GOLDEN_REL =
  'tests/golden/extractor-sharing-rules/Opportunity.json';
const CONTACT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.1/sharingRules/Contact.sharingRules-meta.xml';
const CONTACT_GOLDEN_REL =
  'tests/golden/extractor-sharing-rules/Contact.json';

/**
 * Write `content` to a `.sharingRules-meta.xml` file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute
 * file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-sharing-rules-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Wrap a `<sharedTo>` body into a minimal valid criteria rule, then wrap
 * that into a `<SharingRules>` document. Used by the variant-resolution
 * suite — each variant gets the same outer scaffolding so the only thing
 * that varies is the `<sharedTo>` child.
 */
const buildVariantXml = (sharedToBody: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
    <sharingCriteriaRules>
        <fullName>Test_Rule</fullName>
        <label>Test Rule</label>
        <accessLevel>Read</accessLevel>
        <sharedTo>
${sharedToBody}
        </sharedTo>
        <criteriaItems>
            <field>Account.Name</field>
            <operation>notEqual</operation>
            <value>X</value>
        </criteriaItems>
    </sharingCriteriaRules>
</SharingRules>`;

describe('extractSharingRules', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Account (mixed criteria + owner)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, ACCOUNT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, ACCOUNT_GOLDEN_REL);

      const result = await extractSharingRules(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The golden's `sourcePath` is harness-relative; vitest's cwd is the
      // package directory, so the extractor's actual `sourcePath` is
      // absolute. Patch the golden to match before deep-equality.
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
      // The task description specifies 2 nodes + 2 parentOf + 3 sharedWith.
      expect(result.value.nodes).toHaveLength(2);
      expect(
        result.value.edges.filter((e) => e.edgeType === 'parentOf'),
      ).toHaveLength(2);
      expect(
        result.value.edges.filter((e) => e.edgeType === 'sharedWith'),
      ).toHaveLength(3);
    });

    itHarness('produces the golden output for Opportunity (synthetic target)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, OPPORTUNITY_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, OPPORTUNITY_GOLDEN_REL);

      const result = await extractSharingRules(fixtureAbsPath);
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

    itHarness('produces the golden output for Contact (subordinate inheritance)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, CONTACT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CONTACT_GOLDEN_REL);

      const result = await extractSharingRules(fixtureAbsPath);
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

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.sharingRules-meta.xml';
      const result = await extractSharingRules(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        '<?xml version="1.0"?><SharingRules><sharingOwnerRules></wrongClose></SharingRules>',
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <SharingRules>', async () => {
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <SharingRules> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a rule is missing <fullName>', async () => {
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingCriteriaRules>
    <label>No Name</label>
    <accessLevel>Read</accessLevel>
    <sharedTo><group>X</group></sharedTo>
  </sharingCriteriaRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <fullName>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a rule has an invalid accessLevel', async () => {
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingCriteriaRules>
    <fullName>Bad_Access</fullName>
    <label>Bad Access</label>
    <accessLevel>FullAccess</accessLevel>
    <sharedTo><group>X</group></sharedTo>
  </sharingCriteriaRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid accessLevel: FullAccess');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <sharedTo> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingCriteriaRules>
    <fullName>No_Target</fullName>
    <accessLevel>Read</accessLevel>
  </sharingCriteriaRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <sharedTo>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <sharedTo> has zero variant children', async () => {
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingCriteriaRules>
    <fullName>Empty_Target</fullName>
    <accessLevel>Read</accessLevel>
    <sharedTo>
      <description>not a variant</description>
    </sharedTo>
  </sharingCriteriaRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected exactly one <sharedTo> variant, found 0',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <sharedTo> has more than one variant', async () => {
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingCriteriaRules>
    <fullName>Two_Targets</fullName>
    <accessLevel>Read</accessLevel>
    <sharedTo>
      <group>G</group>
      <role>R</role>
    </sharedTo>
  </sharingCriteriaRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected exactly one <sharedTo> variant, found 2',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when an owner rule is missing <sharedFrom>', async () => {
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingOwnerRules>
    <fullName>No_From</fullName>
    <accessLevel>Read</accessLevel>
    <sharedTo><group>G</group></sharedTo>
  </sharingOwnerRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <sharedFrom>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('guest & territory rule kinds (CR-CAP-16)', () => {
    it('extracts a <sharingGuestRules> rule with the site name as the named Group target', async () => {
      // CR-CAP-16: a guest rule's <guestUser> inner text is the Experience-Cloud
      // SITE NAME. The extractor emits ONE SharingRule node (ruleType 'guest',
      // sharedToType 'guestUser', siteName ClientPortal) + a parentOf edge + a
      // sharedWith edge to a NAMED Group:ClientPortal carrying synthetic:true.
      // Before CR-CAP-16 this asserted empty nodes/edges — fails today.
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingGuestRules>
    <fullName>Share_To_Guest</fullName>
    <accessLevel>Read</accessLevel>
    <sharedTo><guestUser>ClientPortal</guestUser></sharedTo>
    <criteriaItems>
      <field>Account.Type</field>
      <operation>equals</operation>
      <value>Public</value>
    </criteriaItems>
  </sharingGuestRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('SharingRule:Account.Share_To_Guest');
        expect(node.properties['ruleType']).toBe('guest');
        expect(node.properties['sharedToType']).toBe('guestUser');
        expect(node.properties['sharedToName']).toBe('ClientPortal');
        expect(node.properties['siteName']).toBe('ClientPortal');
        expect(node.properties['criteriaItemCount']).toBe(1);
        const parentEdge = result.value.edges.find((e) => e.edgeType === 'parentOf');
        expect(parentEdge?.fromId).toBe('CustomObject:Account');
        expect(parentEdge?.toId).toBe('SharingRule:Account.Share_To_Guest');
        const sharedWith = result.value.edges.find((e) => e.edgeType === 'sharedWith');
        expect(sharedWith?.toId).toBe('Group:ClientPortal');
        expect(sharedWith?.confidence).toBe('declared');
        expect(sharedWith?.properties['synthetic']).toBe(true);
        expect(sharedWith?.properties['siteName']).toBe('ClientPortal');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts a <sharingTerritoryRules> shared with a normal group', async () => {
      // A territory rule shared with a standard <group> resolves like any other
      // group target; the rule is typed `territory`.
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingTerritoryRules>
    <fullName>Territory_To_Group</fullName>
    <accessLevel>Edit</accessLevel>
    <sharedTo><group>G</group></sharedTo>
    <criteriaItems>
      <field>Account.Region</field>
      <operation>equals</operation>
      <value>West</value>
    </criteriaItems>
  </sharingTerritoryRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0]!;
        expect(node.properties['ruleType']).toBe('territory');
        const sharedWith = result.value.edges.find((e) => e.edgeType === 'sharedWith');
        expect(sharedWith?.toId).toBe('Group:G');
        expect(sharedWith?.confidence).toBe('declared');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts a <sharingTerritoryGroupRules> with a territory variant as a Territory synthetic', async () => {
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingTerritoryGroupRules>
    <fullName>TerritoryGroup_To_Territory</fullName>
    <accessLevel>Read</accessLevel>
    <sharedTo><territory>WestRegion</territory></sharedTo>
  </sharingTerritoryGroupRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0]!;
        expect(node.properties['ruleType']).toBe('territoryGroup');
        expect(node.properties['sharedToType']).toBe('territory');
        const sharedWith = result.value.edges.find((e) => e.edgeType === 'sharedWith');
        expect(sharedWith?.toId).toBe('Territory:WestRegion');
        expect(sharedWith?.properties['synthetic']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('back-compat: a self-closing <guestUser/> still resolves to the synthetic Group:GuestUser', async () => {
      // A standard criteria rule whose <sharedTo> is a self-closing <guestUser/>
      // (the shared VARIANT_TABLE entry) must STILL collapse to Group:GuestUser —
      // CR-CAP-16's guest-branch-local resolver only applies to the guest
      // FAMILY, leaving the exported table untouched for the criteria path.
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingCriteriaRules>
    <fullName>Criteria_With_GuestUser</fullName>
    <accessLevel>Read</accessLevel>
    <sharedTo><guestUser/></sharedTo>
    <criteriaItems>
      <field>Account.Name</field>
      <operation>notEqual</operation>
      <value></value>
    </criteriaItems>
  </sharingCriteriaRules>
</SharingRules>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const sharedWith = result.value.edges.find((e) => e.edgeType === 'sharedWith');
        expect(sharedWith?.toId).toBe('Group:GuestUser');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('produces zero nodes for an empty <SharingRules> root', async () => {
      // Documented happy path: a SharingRules file with no rules is not
      // an error.
      const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata"/>`;
      const { dir, path } = await writeTempXml(
        'Account.sharingRules-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingRules(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('sharedTo variant resolution', () => {
    // One test per variant in Sharing.md's table. Each verifies the
    // edge `toId` and any extra-properties merge.
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly body: string;
      readonly expectedType: string;
      readonly expectedToId: string;
      readonly expectedExtraProps: Readonly<Record<string, unknown>>;
      readonly expectedName: string | null;
    }> = [
      {
        name: '<group>',
        body: '<group>Sales_Group</group>',
        expectedType: 'group',
        expectedToId: 'Group:Sales_Group',
        expectedExtraProps: {},
        expectedName: 'Sales_Group',
      },
      {
        name: '<role>',
        body: '<role>CEO</role>',
        expectedType: 'role',
        expectedToId: 'Role:CEO',
        expectedExtraProps: {},
        expectedName: 'CEO',
      },
      {
        name: '<portalRole>',
        body: '<portalRole>AcmePortalRole1</portalRole>',
        expectedType: 'portalRole',
        expectedToId: 'Role:AcmePortalRole1',
        expectedExtraProps: { portal: true },
        expectedName: 'AcmePortalRole1',
      },
      {
        name: '<roleAndSubordinates>',
        body: '<roleAndSubordinates>VP_Sales</roleAndSubordinates>',
        expectedType: 'roleAndSubordinates',
        expectedToId: 'Role:VP_Sales',
        expectedExtraProps: { inheritance: 'subordinates' },
        expectedName: 'VP_Sales',
      },
      {
        name: '<roleAndSubordinatesInternal>',
        body: '<roleAndSubordinatesInternal>VP_Sales</roleAndSubordinatesInternal>',
        expectedType: 'roleAndSubordinatesInternal',
        expectedToId: 'Role:VP_Sales',
        expectedExtraProps: { inheritance: 'subordinatesInternal' },
        expectedName: 'VP_Sales',
      },
      {
        name: '<allInternalUsers/>',
        body: '<allInternalUsers/>',
        expectedType: 'allInternalUsers',
        expectedToId: 'Group:AllInternalUsers',
        expectedExtraProps: { synthetic: true },
        expectedName: null,
      },
      {
        name: '<allCustomerPortalUsers/>',
        body: '<allCustomerPortalUsers/>',
        expectedType: 'allCustomerPortalUsers',
        expectedToId: 'Group:AllCustomerPortalUsers',
        expectedExtraProps: { synthetic: true },
        expectedName: null,
      },
      {
        name: '<partnerUsers/>',
        body: '<partnerUsers/>',
        expectedType: 'partnerUsers',
        expectedToId: 'Group:PartnerUsers',
        expectedExtraProps: { synthetic: true },
        expectedName: null,
      },
      {
        name: '<allPartnerUsers/>',
        body: '<allPartnerUsers/>',
        expectedType: 'allPartnerUsers',
        expectedToId: 'Group:AllPartnerUsers',
        expectedExtraProps: { synthetic: true },
        expectedName: null,
      },
      {
        name: '<guestUser/>',
        body: '<guestUser/>',
        expectedType: 'guestUser',
        expectedToId: 'Group:GuestUser',
        expectedExtraProps: { synthetic: true },
        expectedName: null,
      },
    ];

    for (const c of cases) {
      it(`resolves ${c.name} correctly`, async () => {
        const { dir, path } = await writeTempXml(
          'Account.sharingRules-meta.xml',
          buildVariantXml(`            ${c.body}`),
        );
        try {
          const result = await extractSharingRules(path);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.nodes).toHaveLength(1);
          const node = result.value.nodes[0]!;
          expect(node.properties.sharedToType).toBe(c.expectedType);
          expect(node.properties.sharedToName).toBe(c.expectedName);
          const sharedEdges = result.value.edges.filter(
            (e) => e.edgeType === 'sharedWith',
          );
          expect(sharedEdges).toHaveLength(1);
          const edge = sharedEdges[0]!;
          expect(edge.toId).toBe(c.expectedToId);
          expect(edge.properties).toEqual(c.expectedExtraProps);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  });
});
