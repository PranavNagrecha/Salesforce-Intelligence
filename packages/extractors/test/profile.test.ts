/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractProfile } from '../src/profile.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/profiles/Course Manager.profile-meta.xml';
const GOLDEN_PATH_REL = 'tests/golden/extractor-profile/Course Manager.json';

/**
 * Write `content` to a profile-meta.xml file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeProfileXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-profile-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractProfile', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Course Manager fixture', async () => {
      // The extractor stores the path it was given as `sourcePath`. Because
      // vitest's cwd is the package directory (not the harness root) and
      // `process.chdir` is unsupported in vitest's worker pool, we call the
      // extractor with the absolute path and patch the golden's `sourcePath`
      // to match — deep-equality on every other field still proves correctness.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractProfile(fixtureAbsPath);
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

  describe('UI visibility extraction (P11-UI-app-tab-visibility-extract)', () => {
    it('extracts applicationVisibilities + tabVisibilities onto properties', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <applicationVisibilities>
    <application>standard__Sales</application>
    <default>true</default>
    <visible>true</visible>
  </applicationVisibilities>
  <applicationVisibilities>
    <application>MyApp__c</application>
    <default>false</default>
    <visible>false</visible>
  </applicationVisibilities>
  <tabVisibilities>
    <tab>standard-Account</tab>
    <visibility>DefaultOn</visibility>
  </tabVisibilities>
  <tabVisibilities>
    <tab>MyTab__c</tab>
    <visibility>Hidden</visibility>
  </tabVisibilities>
</Profile>`;
      const { dir, path } = await writeProfileXml('UiVis.profile-meta.xml', xml);
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]!.properties;
        expect(props['applicationVisibilities']).toEqual([
          { application: 'standard__Sales', default: true, visible: true },
          { application: 'MyApp__c', default: false, visible: false },
        ]);
        expect(props['tabVisibilities']).toEqual([
          { tab: 'standard-Account', visibility: 'DefaultOn' },
          { tab: 'MyTab__c', visibility: 'Hidden' },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('always emits the arrays (empty when absent) so tools can tell "extracted, none" from "never extracted"', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
</Profile>`;
      const { dir, path } = await writeProfileXml('NoUiVis.profile-meta.xml', xml);
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]!.properties;
        expect(props['applicationVisibilities']).toEqual([]);
        expect(props['tabVisibilities']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('user ability extraction (P11-USER-ability-run)', () => {
    it('emits a grantedBy edge to Flow per enabled flowAccess + captures login restrictions', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <flowAccesses><enabled>true</enabled><flow>Onboard_Contact</flow></flowAccesses>
  <flowAccesses><enabled>false</enabled><flow>Disabled_Flow</flow></flowAccesses>
  <loginIpRanges><startAddress>10.0.0.1</startAddress><endAddress>10.0.0.255</endAddress></loginIpRanges>
</Profile>`;
      const { dir, path } = await writeProfileXml('Ability.profile-meta.xml', xml);
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Only the enabled flow gets a grantedBy edge to Flow:.
        const flowEdges = result.value.edges.filter((e) => e.toId.startsWith('Flow:'));
        expect(flowEdges.length).toBe(1);
        expect(flowEdges[0]?.toId).toBe('Flow:Onboard_Contact');
        expect(flowEdges[0]?.edgeType).toBe('grantedBy');
        expect(flowEdges[0]?.properties['flowAccess']).toBe(true);
        const props = result.value.nodes[0]!.properties;
        expect(props['flowGrantCount']).toBe(1);
        expect(props['loginIpRanges']).toEqual([
          { startAddress: '10.0.0.1', endAddress: '10.0.0.255' },
        ]);
        expect(props['loginHoursDefined']).toBe(false);
        expect(props['loginHours']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts <loginHours> per-weekday windows into properties.loginHours, skipping unrestricted days', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <loginHours>
    <mondayStart>480</mondayStart>
    <mondayEnd>1020</mondayEnd>
    <tuesdayStart>480</tuesdayStart>
    <tuesdayEnd>1020</tuesdayEnd>
    <fridayStart>480</fridayStart>
    <fridayEnd>780</fridayEnd>
  </loginHours>
</Profile>`;
      const { dir, path } = await writeProfileXml('LoginHours.profile-meta.xml', xml);
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]!.properties;
        expect(props['loginHoursDefined']).toBe(true);
        // Monday/Tuesday/Friday are restricted; Wed/Thu/Sat/Sun have no pair in
        // the source (unrestricted), so only the three declared windows appear,
        // in weekday-declaration order.
        expect(props['loginHours']).toEqual([
          { day: 'Monday', startTime: '480', endTime: '1020' },
          { day: 'Tuesday', startTime: '480', endTime: '1020' },
          { day: 'Friday', startTime: '480', endTime: '780' },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // CR-CAP-10 profile parity: zero in-vault profiles use <customPermissions>,
    // so this synthetic fixture is the ONLY proof the symmetric profile edit
    // works. enabled=false is excluded by the same continue-guard.
    it('emits a grantedBy edge to CustomPermission per enabled customPermissions block (false excluded)', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <customPermissions><enabled>true</enabled><name>SkipValidation</name></customPermissions>
  <customPermissions><enabled>false</enabled><name>Off_Perm</name></customPermissions>
</Profile>`;
      const { dir, path } = await writeProfileXml('CustomPerm.profile-meta.xml', xml);
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const cpEdges = result.value.edges.filter((e) => e.toId.startsWith('CustomPermission:'));
        expect(cpEdges.map((e) => e.toId)).toEqual(['CustomPermission:SkipValidation']);
        expect(cpEdges[0]?.fromId).toBe('Profile:CustomPerm');
        expect(cpEdges[0]?.edgeType).toBe('grantedBy');
        expect(cpEdges[0]?.confidence).toBe('declared');
        expect(cpEdges[0]?.properties['enabled']).toBe(true);
        expect(result.value.nodes[0]?.properties['customPermissionGrantCount']).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // GUEST-PAGE-ACCESS: <pageAccesses> was the one access element the profile
    // extractor walked past, so a Visualforce page a GUEST profile enables
    // could never become a finding in sfi.guest_exposure_report — that tool
    // shipped a permanent "extractor emits no Profile -> VisualforcePage grant
    // edge" disclosure instead of an answer. A Visualforce page RUNS its
    // controller Apex, so an enabled page on an internet-facing site guest
    // profile is a real guest-reachable code surface. Same shape and the same
    // <enabled> continue-guard as classAccesses/flowAccesses above.
    it('emits a grantedBy edge to VisualforcePage per enabled pageAccesses block (false excluded)', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Guest User License</userLicense>
  <pageAccesses><apexPage>SelfServiceIntake</apexPage><enabled>true</enabled></pageAccesses>
  <pageAccesses><apexPage>Disabled_Page</apexPage><enabled>false</enabled></pageAccesses>
  <pageAccesses><apexPage>NS__Vendor_Page</apexPage><enabled>true</enabled></pageAccesses>
</Profile>`;
      const { dir, path } = await writeProfileXml('Fx_PageGrants.profile-meta.xml', xml);
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const pageEdges = result.value.edges.filter((e) => e.toId.startsWith('VisualforcePage:'));
        // Sorted by toId with the rest of the edge list, so assert as a set.
        expect(pageEdges.map((e) => e.toId).sort()).toEqual([
          'VisualforcePage:NS__Vendor_Page',
          'VisualforcePage:SelfServiceIntake',
        ]);
        expect(pageEdges.every((e) => e.fromId === 'Profile:Fx_PageGrants')).toBe(true);
        expect(pageEdges.every((e) => e.edgeType === 'grantedBy')).toBe(true);
        expect(pageEdges.every((e) => e.confidence === 'declared')).toBe(true);
        expect(pageEdges.every((e) => e.properties['enabled'] === true)).toBe(true);
        expect(result.value.nodes[0]?.properties['pageGrantCount']).toBe(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // "extracted, none" must be distinguishable from "never extracted": a
    // profile with no <pageAccesses> at all reports 0, not undefined, so a
    // consumer reading pageGrantCount === 0 knows the walk RAN.
    it('reports pageGrantCount 0 (not undefined) when the profile declares no pageAccesses', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
</Profile>`;
      const { dir, path } = await writeProfileXml('NoPages.profile-meta.xml', xml);
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['pageGrantCount']).toBe(0);
        expect(result.value.edges.some((e) => e.toId.startsWith('VisualforcePage:'))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.profile-meta.xml';
      const result = await extractProfile(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      // Mismatched closing tag — fails XMLValidator.validate strictly.
      const { dir, path } = await writeProfileXml(
        'Bad.profile-meta.xml',
        '<?xml version="1.0"?><Profile><userLicense>X</wrongClose></Profile>',
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <Profile>', async () => {
      const { dir, path } = await writeProfileXml(
        'Wrong.profile-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <Profile> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <userLicense> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <description>No license here</description>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'NoLicense.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <userLicense>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a <fieldPermissions><field> is not in Object.Field form', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <fieldPermissions>
    <field>Industry__c</field>
    <editable>true</editable>
    <readable>true</readable>
  </fieldPermissions>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'BadField.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'field reference Industry__c not in Object.Field form',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the filename has malformed URL encoding', async () => {
      // `%2` is a truncated escape sequence and throws URIError when decoded.
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
</Profile>`;
      const { dir, path } = await writeProfileXml('Bad%2.profile-meta.xml', xml);
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'malformed URL encoding in filename',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('filename URL decoding', () => {
    it('decodes %20 and other URL-encoded characters in the filename', async () => {
      // `Course Development w%2FConga Access` decodes to `Course Development w/Conga Access`.
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'My%20Profile%2FX.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.apiName).toBe('My Profile/X');
        expect(node.label).toBe('My Profile/X');
        expect(node.id).toBe('Profile:My Profile/X');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('edge filtering', () => {
    it('skips object permissions where every flag is false', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <objectPermissions>
    <object>Skipped__c</object>
    <allowCreate>false</allowCreate>
    <allowDelete>false</allowDelete>
    <allowEdit>false</allowEdit>
    <allowRead>false</allowRead>
    <modifyAllRecords>false</modifyAllRecords>
    <viewAllRecords>false</viewAllRecords>
  </objectPermissions>
  <objectPermissions>
    <object>Kept__c</object>
    <allowCreate>false</allowCreate>
    <allowDelete>false</allowDelete>
    <allowEdit>false</allowEdit>
    <allowRead>true</allowRead>
    <modifyAllRecords>false</modifyAllRecords>
    <viewAllRecords>false</viewAllRecords>
  </objectPermissions>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'Filter.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe('CustomObject:Kept__c');
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['objectGrantCount']).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('collects only enabled user permissions, sorted alphabetically', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <userPermissions>
    <enabled>true</enabled>
    <name>ViewSetup</name>
  </userPermissions>
  <userPermissions>
    <enabled>false</enabled>
    <name>ManageUsers</name>
  </userPermissions>
  <userPermissions>
    <enabled>true</enabled>
    <name>ApiEnabled</name>
  </userPermissions>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'UserPerms.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['userPermissions']).toEqual([
          'ApiEnabled',
          'ViewSetup',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('properties', () => {
    it('defaults description to null and custom to false when absent', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce Platform</userLicense>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'Minimal.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['description']).toBeNull();
        expect(node.properties['custom']).toBe(false);
        expect(node.properties['userLicense']).toBe('Salesforce Platform');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('layoutAssignments', () => {
    it('collects entries verbatim, preserving recordType-null for default assignments', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <layoutAssignments>
    <layout>Account-Account Layout</layout>
  </layoutAssignments>
  <layoutAssignments>
    <layout>Case-Prospect Case Layout</layout>
    <recordType>Case.Partner</recordType>
  </layoutAssignments>
  <layoutAssignments>
    <layout>Case-Prospect Case Layout</layout>
    <recordType>Case.Support</recordType>
  </layoutAssignments>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'WithLayouts.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['layoutAssignments']).toEqual([
          { layout: 'Account-Account Layout', recordType: null },
          { layout: 'Case-Prospect Case Layout', recordType: 'Case.Partner' },
          { layout: 'Case-Prospect Case Layout', recordType: 'Case.Support' },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits an empty array when <layoutAssignments> is absent', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'NoLayouts.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // Always-present `[]` is the contract surface the
        // `sfi.layout_for_user` tool relies on to distinguish "no
        // assignments" from "extractor never populated this".
        expect(node.properties['layoutAssignments']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('recordTypeVisibilities', () => {
    it('collects entries with default and visible booleans', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <recordTypeVisibilities>
    <default>true</default>
    <recordType>Account.PartnerAccount</recordType>
    <visible>true</visible>
  </recordTypeVisibilities>
  <recordTypeVisibilities>
    <default>false</default>
    <recordType>Case.Partner</recordType>
    <visible>false</visible>
  </recordTypeVisibilities>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'WithVisibilities.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['recordTypeVisibilities']).toEqual([
          {
            recordType: 'Account.PartnerAccount',
            default: true,
            visible: true,
          },
          { recordType: 'Case.Partner', default: false, visible: false },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('surfaces null for <visible> when the element is absent (older orgs)', async () => {
      // `<visible>` was added in a later Salesforce API version; older
      // org metadata omits it. The extractor must distinguish "absent"
      // from "false" so downstream tools don't conflate the two.
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
  <recordTypeVisibilities>
    <default>true</default>
    <recordType>Account.Default</recordType>
  </recordTypeVisibilities>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'OldOrgVisibilities.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['recordTypeVisibilities']).toEqual([
          { recordType: 'Account.Default', default: true, visible: null },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits an empty array when <recordTypeVisibilities> is absent', async () => {
      const xml = `<?xml version="1.0"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
  <userLicense>Salesforce</userLicense>
</Profile>`;
      const { dir, path } = await writeProfileXml(
        'NoVisibilities.profile-meta.xml',
        xml,
      );
      try {
        const result = await extractProfile(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['recordTypeVisibilities']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
