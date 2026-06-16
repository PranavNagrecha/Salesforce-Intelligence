/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractFlexiPage,
  extractListView,
  extractPermissionSetGroup,
  extractReport,
  extractRestrictionRule,
  extractScopingRule,
} from '../src/enterprise-metadata.js';

const makeTemp = (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-enterprise-metadata-'));

describe('enterprise metadata extractors', () => {
  it('extracts a top-level RestrictionRule from a real .rule-meta.xml file', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Limit_Course_Access.rule-meta.xml');
      await writeFile(
        path,
        '<RestrictionRule xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><targetEntity>Account</targetEntity></RestrictionRule>',
        'utf8',
      );
      const result = await extractRestrictionRule(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('RestrictionRule:Limit_Course_Access');
      // Parent comes from <targetEntity> — the top-level path names no object.
      // why_cant_user_see_record / who_can_access_object key their restriction
      // caveats on parentId, so null here = the caveat never fires on real orgs.
      expect(result.value.nodes[0]?.parentId).toBe('CustomObject:Account');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves RestrictionRule parentId null when the XML has no targetEntity', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'No_Target.rule-meta.xml');
      await writeFile(
        path,
        '<RestrictionRule xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active></RestrictionRule>',
        'utf8',
      );
      const result = await extractRestrictionRule(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.parentId).toBe(null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts a top-level ScopingRule from a real .rule-meta.xml file', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Best_Advisor_Scope.rule-meta.xml');
      await writeFile(
        path,
        '<ScopingRule xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><targetEntity>Contact</targetEntity></ScopingRule>',
        'utf8',
      );
      const result = await extractScopingRule(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('ScopingRule:Best_Advisor_Scope');
      expect(result.value.nodes[0]?.parentId).toBe('CustomObject:Contact');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts dotted report column references', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Account_Usage.report-meta.xml');
      await writeFile(
        path,
        '<Report><columns>Account.Industry__c</columns><columns>Account.OwnerId</columns></Report>',
      );

      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('Report:Account_Usage');
      expect(result.value.edges.map((edge) => edge.toId)).toContain(
        'CustomField:Account.Industry__c',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scopes bare report columns via standard reportType', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Account_Usage.report-meta.xml');
      await writeFile(
        path,
        '<Report><reportType>AccountList</reportType><columns>Industry__c</columns></Report>',
      );

      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges.map((edge) => edge.toId)).toContain(
        'CustomField:Account.Industry__c',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('scopes list view field references to the parent object', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'objects', 'Account', 'listViews', 'Enterprise.listView-meta.xml');
      await mkdir(join(dir, 'objects', 'Account', 'listViews'), { recursive: true });
      await writeFile(path, '<ListView><columns>Industry__c</columns></ListView>');

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('ListView:Account.Enterprise');
      expect(result.value.nodes[0]?.parentId).toBe('CustomObject:Account');
      expect(result.value.edges[0]?.toId).toBe('CustomField:Account.Industry__c');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures a list view <sharedTo> scope as visibleTo edges + properties', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'objects', 'Contact', 'listViews', 'VIPs.listView-meta.xml');
      await mkdir(join(dir, 'objects', 'Contact', 'listViews'), { recursive: true });
      await writeFile(
        path,
        `<ListView>
          <fullName>VIPs</fullName>
          <filterScope>Everything</filterScope>
          <sharedTo>
            <group>Sales_Ops</group>
            <role>VP_Sales</role>
            <roleAndSubordinatesInternal>Field_Reps</roleAndSubordinatesInternal>
            <allInternalUsers></allInternalUsers>
          </sharedTo>
        </ListView>`,
      );

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const node = result.value.nodes[0]!;
      expect(node.id).toBe('ListView:Contact.VIPs');
      expect(node.properties.filterScope).toBe('Everything');
      // sharedTo mirrored onto properties, one entry per target.
      const sharedTo = node.properties.sharedTo as Array<Record<string, unknown>>;
      expect(sharedTo.map((s) => s.targetId).sort()).toEqual([
        'Group:AllInternalUsers',
        'Group:Sales_Ops',
        'Role:Field_Reps',
        'Role:VP_Sales',
      ]);
      // The subordinates marker rides through from the shared variant table.
      expect(sharedTo.find((s) => s.targetId === 'Role:Field_Reps')?.inheritance).toBe(
        'subordinatesInternal',
      );
      expect(sharedTo.find((s) => s.targetId === 'Group:AllInternalUsers')?.synthetic).toBe(true);

      // A visibleTo edge per target — NOT sharedWith (record access).
      const visibleTo = result.value.edges.filter((e) => e.edgeType === 'visibleTo');
      expect(visibleTo).toHaveLength(4);
      expect(result.value.edges.some((e) => e.edgeType === 'sharedWith')).toBe(false);
      const vpEdge = visibleTo.find((e) => e.toId === 'Role:VP_Sales')!;
      expect(vpEdge.confidence).toBe('declared');
      expect(vpEdge.properties.sharedToType).toBe('role');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits sharedTo properties for a list view with no <sharedTo>', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'objects', 'Account', 'listViews', 'Private.listView-meta.xml');
      await mkdir(join(dir, 'objects', 'Account', 'listViews'), { recursive: true });
      await writeFile(path, '<ListView><fullName>Private</fullName><filterScope>Mine</filterScope></ListView>');

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.properties.filterScope).toBe('Mine');
      expect(node.properties.sharedTo).toEqual([]);
      expect(result.value.edges.some((e) => e.edgeType === 'visibleTo')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts dotted FlexiPage field item references', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Account_Record_Page.flexipage-meta.xml');
      await writeFile(
        path,
        '<FlexiPage><fieldInstance><fieldItem>Account.AnnualRevenue</fieldItem></fieldInstance></FlexiPage>',
      );

      const result = await extractFlexiPage(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('FlexiPage:Account_Record_Page');
      expect(result.value.edges[0]?.toId).toBe('CustomField:Account.AnnualRevenue');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures FlexiPage sobjectType / pageType / masterLabel + object edge (P11-UI-flexipage-activation)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Account_Record_Page.flexipage-meta.xml');
      // `<type>` is overloaded: Region/Facet are region kinds; RecordPage is the page kind.
      await writeFile(
        path,
        '<FlexiPage><masterLabel>Account Record Page</masterLabel>' +
          '<sobjectType>Account</sobjectType>' +
          '<flexiPageRegions><type>Region</type></flexiPageRegions>' +
          '<type>RecordPage</type></FlexiPage>',
      );
      const result = await extractFlexiPage(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.properties['sobjectType']).toBe('Account');
      expect(node.properties['pageType']).toBe('RecordPage'); // picked the page type, not 'Region'
      expect(node.properties['masterLabel']).toBe('Account Record Page');
      // Honesty flag: activations are not in the metadata.
      expect(node.properties['activationsModeled']).toBe(false);
      // Emits a references edge to the object.
      const objEdge = result.value.edges.find((e) => e.toId === 'CustomObject:Account');
      expect(objEdge?.properties['referenceKind']).toBe('flexiPageObject');
      expect(objEdge?.confidence).toBe('declared');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts PermissionSetGroup membership + muting as references edges + properties', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'My_Group.permissionsetgroup-meta.xml');
      await writeFile(
        path,
        '<PermissionSetGroup><label>My Group</label>' +
          '<permissionSets>Sales_PS</permissionSets>' +
          '<permissionSets>Admin_PS</permissionSets>' +
          '<mutingPermissionSets>Mute_PS</mutingPermissionSets>' +
          '<status>Updated</status></PermissionSetGroup>',
      );
      const result = await extractPermissionSetGroup(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node?.id).toBe('PermissionSetGroup:My_Group');
      expect(node?.properties['permissionSets']).toEqual([
        'Admin_PS',
        'Sales_PS',
      ]);
      expect(node?.properties['mutingPermissionSets']).toEqual(['Mute_PS']);
      expect(result.value.edges).toContainEqual(
        expect.objectContaining({
          fromId: 'PermissionSetGroup:My_Group',
          toId: 'PermissionSet:Sales_PS',
          edgeType: 'references',
          confidence: 'declared',
          properties: { referenceKind: 'permissionSetGroupMember' },
        }),
      );
      expect(result.value.edges).toContainEqual(
        expect.objectContaining({
          toId: 'MutingPermissionSet:Mute_PS',
          properties: { referenceKind: 'mutingPermissionSet' },
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
