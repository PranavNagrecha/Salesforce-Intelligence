/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractCustomPermission,
  extractFlexiPage,
  extractListView,
  extractPermissionSetGroup,
  extractReport,
  extractReportType,
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

  // CR-CAP-15: CustomPermission DEFINITION nodes (the grant target CR-CAP-10
  // points at). Reuses extractEnterpriseMetadata with a flat top-level config.
  it('extracts a CustomPermission definition node (flat top-level id, no parent)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'SkipValidation.customPermission-meta.xml');
      await writeFile(
        path,
        '<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata"><label>Skip Validation</label></CustomPermission>',
        'utf8',
      );
      const result = await extractCustomPermission(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('CustomPermission:SkipValidation');
      expect(result.value.nodes[0]?.type).toBe('CustomPermission');
      expect(result.value.nodes[0]?.apiName).toBe('SkipValidation');
      // Flat top-level convention (like RemoteSiteSetting/AuthProvider): no
      // parent scope, so the grant edge target id matches a bare <name> grant.
      expect(result.value.nodes[0]?.parentId).toBe(null);
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

  // CR-CAP-13: list-view `<filters><field>` identity capture.
  it('CR-CAP-13: tags a filter-only field as a filterRef references edge', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'objects',
        'Training_Assignments__c',
        'listViews',
        'Completed.listView-meta.xml',
      );
      await mkdir(join(dir, 'objects', 'Training_Assignments__c', 'listViews'), {
        recursive: true,
      });
      await writeFile(
        path,
        '<ListView><columns>NAME</columns>' +
          '<filters><field>UserFacultyId__c</field><operation>equals</operation><value>1</value></filters>' +
          '</ListView>',
      );

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = result.value.edges.find(
        (e) => e.toId === 'CustomField:Training_Assignments__c.UserFacultyId__c',
      );
      expect(edge).toBeDefined();
      expect(edge?.edgeType).toBe('references');
      expect(edge?.confidence).toBe('heuristic');
      // The whole point of CR-CAP-13: a filter-only field is `filterRef`,
      // NOT the column `fieldRef` it was mis-tagged as before this CR.
      expect(edge?.properties['referenceKind']).toBe('filterRef');
      // It must NOT also surface as a column row (no duplicate edge).
      const sameTarget = result.value.edges.filter(
        (e) =>
          e.toId === 'CustomField:Training_Assignments__c.UserFacultyId__c' &&
          e.edgeType === 'references',
      );
      expect(sameTarget).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13: mints NO edge for non-field filter tokens or value-derived dotted phantoms', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'objects',
        'Evaluation__c',
        'listViews',
        'My_Open_Flags.listView-meta.xml',
      );
      await mkdir(join(dir, 'objects', 'Evaluation__c', 'listViews'), {
        recursive: true,
      });
      await writeFile(
        path,
        '<ListView><columns>NAME</columns>' +
          '<filters><field>RECORDTYPE</field><operation>equals</operation><value>Evaluation__c.Student_Evaluation</value></filters>' +
          '<filters><field>CREATED_DATE</field><operation>greaterOrEqual</operation><value>LAST_N_DAYS:30</value></filters>' +
          '<filters><field>UPDATEDBY_USER.ALIAS</field><operation>equals</operation><value>jdoe</value></filters>' +
          '</ListView>',
      );

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toIds = result.value.edges.map((e) => e.toId);
      // Special non-field pseudo-columns mint NO field edge.
      expect(toIds.some((id) => id.includes('RECORDTYPE'))).toBe(false);
      expect(toIds.some((id) => id.includes('CREATED_DATE'))).toBe(false);
      expect(toIds.some((id) => id.includes('UPDATEDBY_USER'))).toBe(false);
      expect(toIds.some((id) => id.includes('ALIAS'))).toBe(false);
      // The value-derived dotted RecordType-name phantom must NOT be minted.
      expect(toIds).not.toContain('CustomField:Evaluation__c.Student_Evaluation');
      // The date-range literal must not be minted either.
      expect(toIds.some((id) => id.includes('LAST_N_DAYS'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13: PUBLISH_STATUS/LANGUAGE/numeric-value filters mint no edge', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'objects',
        'Knowledge__kav',
        'listViews',
        'archived_articles.listView-meta.xml',
      );
      await mkdir(join(dir, 'objects', 'Knowledge__kav', 'listViews'), {
        recursive: true,
      });
      await writeFile(
        path,
        '<ListView>' +
          '<filters><field>PUBLISH_STATUS</field><operation>equals</operation><value>3</value></filters>' +
          '<filters><field>LANGUAGE</field><operation>equals</operation><value>en_US</value></filters>' +
          '</ListView>',
      );

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toIds = result.value.edges.map((e) => e.toId);
      expect(toIds.some((id) => id.includes('PUBLISH_STATUS'))).toBe(false);
      expect(toIds.some((id) => id.includes('LANGUAGE'))).toBe(false);
      expect(toIds.some((id) => id.includes('en_US'))).toBe(false);
      // No numeric/locale value edge.
      expect(result.value.edges.filter((e) => e.edgeType === 'references')).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13: a column-only list view is unchanged (single fieldRef, no filterRef)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'objects', 'Account', 'listViews', 'Enterprise2.listView-meta.xml');
      await mkdir(join(dir, 'objects', 'Account', 'listViews'), { recursive: true });
      await writeFile(path, '<ListView><columns>Industry__c</columns></ListView>');

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const refEdges = result.value.edges.filter((e) => e.edgeType === 'references');
      expect(refEdges).toHaveLength(1);
      expect(refEdges[0]?.toId).toBe('CustomField:Account.Industry__c');
      expect(refEdges[0]?.properties['referenceKind']).toBe('fieldRef');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13: a field that is both column and filter yields ONE merged columnAndFilter edge', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'objects', 'OA_Project__c', 'listViews', 'Open.listView-meta.xml');
      await mkdir(join(dir, 'objects', 'OA_Project__c', 'listViews'), { recursive: true });
      await writeFile(
        path,
        '<ListView><columns>Status__c</columns>' +
          '<filters><field>Status__c</field><operation>equals</operation><value>Open</value></filters>' +
          '</ListView>',
      );

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // ONE edge per (ListView, field) — the graph edge PK is
      // (fromId,toId,edgeType,source), so two references edges would collide
      // and one would be silently dropped at import. Merge the role instead.
      const sameTarget = result.value.edges.filter(
        (e) =>
          e.toId === 'CustomField:OA_Project__c.Status__c' &&
          e.edgeType === 'references',
      );
      expect(sameTarget).toHaveLength(1);
      expect(sameTarget[0]?.properties['referenceKind']).toBe('columnAndFilter');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13b: ListView <columns> pseudo-columns mint NO edge but real UPPERCASE std fields survive', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'objects',
        'Knowledge__kav',
        'listViews',
        'All_Articles.listView-meta.xml',
      );
      await mkdir(join(dir, 'objects', 'Knowledge__kav', 'listViews'), {
        recursive: true,
      });
      await writeFile(
        path,
        '<ListView>' +
          // Real all-UPPERCASE standard fields — MUST survive (NOT dropped
          // by a blanket all-uppercase rule).
          '<columns>NAME</columns>' +
          '<columns>TITLE</columns>' +
          '<columns>ABSTRACT</columns>' +
          // Real mixed-case standard fields + a real custom field — survive.
          '<columns>MasterLabel</columns>' +
          '<columns>Topic__c</columns>' +
          // Pseudo platform operands — mint NO edge.
          '<columns>CREATED_DATE</columns>' +
          '<columns>CREATEDBY_USER</columns>' +
          '<columns>UPDATEDBY_USER</columns>' +
          '<columns>LAST_UPDATE</columns>' +
          '<columns>OWNER.ALIAS</columns>' +
          '<columns>OWNER.FIRST_NAME</columns>' +
          '<columns>OWNER_ID</columns>' +
          '<columns>RECORDTYPE</columns>' +
          '<columns>PUBLISH_STATUS</columns>' +
          '<columns>ARTICLE_NUMBER</columns>' +
          '<columns>SETUP_TYPE</columns>' +
          '<columns>ARCHIVED_DATE</columns>' +
          '<columns>ARCHIVEDBY_USER</columns>' +
          '<columns>LAST_PUBLISHED_DATE</columns>' +
          '<columns>CREATEDBY_USER.ALIAS</columns>' +
          '</ListView>',
      );

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toIds = result.value.edges
        .filter((e) => e.edgeType === 'references')
        .map((e) => e.toId)
        .sort();
      // Real fields KEPT.
      expect(toIds).toContain('CustomField:Knowledge__kav.NAME');
      expect(toIds).toContain('CustomField:Knowledge__kav.TITLE');
      expect(toIds).toContain('CustomField:Knowledge__kav.ABSTRACT');
      expect(toIds).toContain('CustomField:Knowledge__kav.MasterLabel');
      expect(toIds).toContain('CustomField:Knowledge__kav.Topic__c');
      // Exactly the five real fields — no pseudo phantoms.
      expect(toIds).toEqual([
        'CustomField:Knowledge__kav.ABSTRACT',
        'CustomField:Knowledge__kav.MasterLabel',
        'CustomField:Knowledge__kav.NAME',
        'CustomField:Knowledge__kav.TITLE',
        'CustomField:Knowledge__kav.Topic__c',
      ]);
      // Spot-check the pseudo tokens never appear.
      for (const pseudo of [
        'CREATED_DATE',
        'CREATEDBY_USER',
        'UPDATEDBY_USER',
        'LAST_UPDATE',
        'ALIAS',
        'FIRST_NAME',
        'OWNER_ID',
        'RECORDTYPE',
        'PUBLISH_STATUS',
        'ARTICLE_NUMBER',
        'SETUP_TYPE',
        'ARCHIVED_DATE',
        'ARCHIVEDBY_USER',
        'LAST_PUBLISHED_DATE',
      ]) {
        expect(toIds.some((id) => id.includes(pseudo))).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13b: real custom field ending in _USER survives the audit-user guard', async () => {
    const dir = await makeTemp();
    try {
      const path = join(
        dir,
        'objects',
        'Training__c',
        'listViews',
        'Assigned.listView-meta.xml',
      );
      await mkdir(join(dir, 'objects', 'Training__c', 'listViews'), {
        recursive: true,
      });
      await writeFile(
        path,
        '<ListView><columns>Assigned_To_User__c</columns></ListView>',
      );
      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toIds = result.value.edges.map((e) => e.toId);
      // `__c` -> `__C` after upper-fold, so the `_USER$` anchor misses it.
      expect(toIds).toContain('CustomField:Training__c.Assigned_To_User__c');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13b: a Report dotted RELATIONSHIP column survives the column guard (cross-type)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Acct_Rel.report-meta.xml');
      await writeFile(
        path,
        '<Report>' +
          '<columns>Owner.Name</columns>' +
          '<columns>CreatedBy.Name</columns>' +
          '<columns>Account.Industry__c</columns>' +
          '<columns>Account.OwnerId</columns>' +
          // A pseudo column also present — must still drop uniformly.
          '<columns>CREATED_DATE</columns>' +
          '</Report>',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toIds = result.value.edges
        .filter((e) => e.edgeType === 'references')
        .map((e) => e.toId);
      // Mixed-case dotted relationship columns are legitimate Report columns
      // and MUST NOT be dropped by the OWNER./.ALIAS structural rejects.
      expect(toIds).toContain('CustomField:Owner.Name');
      expect(toIds).toContain('CustomField:CreatedBy.Name');
      expect(toIds).toContain('CustomField:Account.Industry__c');
      expect(toIds).toContain('CustomField:Account.OwnerId');
      // The pseudo column is still dropped uniformly across types.
      expect(toIds.some((id) => id.includes('CREATED_DATE'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13b: a FlexiPage dotted relationship fieldItem survives the column guard', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Account_Record_Page.flexipage-meta.xml');
      await writeFile(
        path,
        '<FlexiPage><sobjectType>Account</sobjectType>' +
          '<fieldInstance><fieldItem>Owner.Name</fieldItem></fieldInstance>' +
          '<fieldInstance><fieldItem>Industry__c</fieldItem></fieldInstance>' +
          '</FlexiPage>',
      );
      const result = await extractFlexiPage(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toIds = result.value.edges.map((e) => e.toId);
      expect(toIds).toContain('CustomField:Owner.Name');
      expect(toIds).toContain('CustomField:Account.Industry__c');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CR-CAP-13: a Report `<field>` column still mints a fieldRef edge (no shared-extractor regression)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Acct_Cols.report-meta.xml');
      await writeFile(
        path,
        '<Report><reportType>AccountList</reportType><field>Industry__c</field></Report>',
      );

      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = result.value.edges.find(
        (e) => e.toId === 'CustomField:Account.Industry__c',
      );
      expect(edge).toBeDefined();
      expect(edge?.properties['referenceKind']).toBe('fieldRef');
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

  // Bug fix: ReportType <label> was never extracted — makeNode always set label: null
  // because extractReportType passed no labelXmlElement config. Real org shape from
  // org-kb/source/main/default/reportTypes/Bot_Metrics_Daily_v2.reportType-meta.xml.
  it('extracts the <label> from a real ReportType XML and surfaces it as node.label', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Bot_Metrics_Daily_v2.reportType-meta.xml');
      // Real-org XML shape: top-level <label> with a literal apostrophe distinguishes
      // versioned clones (the real file uses a literal ' not an XML entity).
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<ReportType xmlns="http://soap.sforce.com/2006/04/metadata">
    <baseObject></baseObject>
    <category>other</category>
    <deployed>true</deployed>
    <description>Einstein Bot metrics aggregated by day.</description>
    <label>Bot Metrics Daily Summer '22</label>
    <sections>
        <masterLabel>Conversation Definition Dialog Daily Metrics</masterLabel>
    </sections>
</ReportType>`,
        'utf8',
      );
      const result = await extractReportType(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.id).toBe('ReportType:Bot_Metrics_Daily_v2');
      // Previously always null — must now carry the seasonal-release label.
      expect(node.label).toBe("Bot Metrics Daily Summer '22");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves ReportType node.label null when the XML has no <label> element', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Unlabeled_Type.reportType-meta.xml');
      await writeFile(
        path,
        '<ReportType xmlns="http://soap.sforce.com/2006/04/metadata"><deployed>true</deployed></ReportType>',
        'utf8',
      );
      const result = await extractReportType(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.label).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Bug fix: extractRestrictionRule never read enforcementType / recordFilter /
  // userCriteria / active — the generic extractor only produced fieldRefs.
  // Real-org XML shape from:
  // org-kb/source/main/default/restrictionRules/Limit_Access_to_Example_Course_for_Faculty.rule-meta.xml
  it('extracts enforcementType, recordFilter, userCriteria, and active from a real RestrictionRule', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Limit_Access_to_Example_Course_for_Faculty.rule-meta.xml');
      // Exact real-org XML shape. RestrictionRule files are top-level (not nested
      // under an object folder), so the node id is just the file stem — the
      // parentId comes from <targetEntity> via parentFromXmlElement. The
      // userCriteria uses an XML entity (&apos;) which extractXmlValues returns
      // verbatim (no entity decoding) because it is a plain regex, not an XML parser.
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<RestrictionRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Faculty should be allowed to see only records where they are the assigned faculty.</description>
    <enforcementType>Restrict</enforcementType>
    <masterLabel>Limit Access to Course Offering for Faculty</masterLabel>
    <recordFilter>hed__Faculty__r.Faculty_User_Record__c=$User.Id</recordFilter>
    <targetEntity>hed__Example_Course__c</targetEntity>
    <userCriteria>$User.ProfileId=&apos;00e4O000001ADFpQAO&apos;</userCriteria>
    <version>1</version>
</RestrictionRule>`,
        'utf8',
      );
      const result = await extractRestrictionRule(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      // Top-level file: id is just the stem; parentId comes from <targetEntity>.
      expect(node.id).toBe('RestrictionRule:Limit_Access_to_Example_Course_for_Faculty');
      expect(node.parentId).toBe('CustomObject:hed__Example_Course__c');
      // Previously missing — must now be present.
      expect(node.properties['enforcementType']).toBe('Restrict');
      expect(node.properties['active']).toBe('true');
      expect(node.properties['recordFilter']).toBe('hed__Faculty__r.Faculty_User_Record__c=$User.Id');
      // extractXmlValues uses a plain regex (no XML entity decoding) so &apos;
      // is returned verbatim from the raw text, not decoded to '.
      expect(node.properties['userCriteria']).toBe("$User.ProfileId=&apos;00e4O000001ADFpQAO&apos;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ScopingRule uses the same XML schema as RestrictionRule (real-org shape from
  // org-kb/source/main/default/restrictionRules/Viewer_is_Best_Academic_Advisor.rule-meta.xml
  // — note: that file has <enforcementType>Scoping</enforcementType> despite living
  // in the restrictionRules/ folder; Salesforce stores both types as .rule-meta.xml).
  it('extracts enforcementType=Scoping and extra properties from a real ScopingRule', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Viewer_is_Best_Academic_Advisor.rule-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<RestrictionRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Used to filter a list view when the user is the best academic advisor</description>
    <enforcementType>Scoping</enforcementType>
    <masterLabel>Viewer is Best Academic Advisor</masterLabel>
    <recordFilter>Best_Academic_Advisor__r.Id=$User.Id</recordFilter>
    <targetEntity>Contact</targetEntity>
    <userCriteria>$User.ProfileId=&apos;00e0B000000uM1N&apos;</userCriteria>
    <version>1</version>
</RestrictionRule>`,
        'utf8',
      );
      const result = await extractScopingRule(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.id).toBe('ScopingRule:Viewer_is_Best_Academic_Advisor');
      expect(node.parentId).toBe('CustomObject:Contact');
      // Previously missing — must now be present.
      expect(node.properties['enforcementType']).toBe('Scoping');
      expect(node.properties['active']).toBe('true');
      expect(node.properties['recordFilter']).toBe('Best_Academic_Advisor__r.Id=$User.Id');
      // userCriteria uses &apos; which is returned verbatim by the regex extractor.
      expect(node.properties['userCriteria']).toBe("$User.ProfileId=&apos;00e0B000000uM1N&apos;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // v2.9 — FlexiPage $Permission.CustomPermission visibility-rule edges.
  it('v2.9: extractFlexiPage emits a declared references edge for each $Permission.CustomPermission.X in <leftValue>', async () => {
    // Scenario: a Lightning Record Page that gates a component on a custom
    // permission via {!$Permission.CustomPermission.X} inside a
    // <visibilityRule><criteria><leftValue> block. extractFieldRefs only
    // matches <columns>/<field>/<fieldItem>/<fieldApiName> elements — none
    // of which appear in <leftValue> blocks — so pre-v2.9 this pattern was
    // silently dropped and no graph edge was emitted.
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Clinical_Record_Page.flexipage-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Course Offering Record Page</masterLabel>
    <sobjectType>hed__Example_Course__c</sobjectType>
    <type>RecordPage</type>
    <flexiPageRegions>
        <componentInstances>
            <componentInstanceProperties>
                <name>visibilityRule</name>
                <value>
                    <criteria>
                        <leftValue>{!$Permission.CustomPermission.AssignClinicalLead}</leftValue>
                        <operator>EQUAL</operator>
                        <rightValue>true</rightValue>
                    </criteria>
                    <criteria>
                        <leftValue>{!$Permission.CustomPermission.ViewClinicalDashboard}</leftValue>
                        <operator>EQUAL</operator>
                        <rightValue>true</rightValue>
                    </criteria>
                </value>
            </componentInstanceProperties>
        </componentInstances>
    </flexiPageRegions>
</FlexiPage>`,
        'utf8',
      );
      const result = await extractFlexiPage(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Two distinct custom-permission refs, each emits one declared edge.
      const permEdges = result.value.edges.filter(
        (e) =>
          e.edgeType === 'references' &&
          e.toId.startsWith('CustomPermission:'),
      );
      expect(permEdges).toHaveLength(2);
      const permIds = permEdges.map((e) => e.toId).sort();
      expect(permIds).toEqual([
        'CustomPermission:AssignClinicalLead',
        'CustomPermission:ViewClinicalDashboard',
      ]);
      // Edge properties: declared confidence + visibilityRulePermission kind.
      for (const edge of permEdges) {
        expect(edge.confidence).toBe('declared');
        expect(edge.properties['referenceKind']).toBe('visibilityRulePermission');
      }
      // permissionRefs mirrored on the node.
      const node = result.value.nodes[0]!;
      expect((node.properties['permissionRefs'] as string[]).sort()).toEqual([
        'CustomPermission:AssignClinicalLead',
        'CustomPermission:ViewClinicalDashboard',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('v2.9: extractFlexiPage emits no permission edge when no $Permission.CustomPermission pattern is present', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Simple_Page.flexipage-meta.xml');
      await writeFile(
        path,
        '<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata"><masterLabel>Simple Page</masterLabel><type>AppPage</type></FlexiPage>',
        'utf8',
      );
      const result = await extractFlexiPage(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const permEdges = result.value.edges.filter(
        (e) =>
          e.edgeType === 'references' &&
          e.toId.startsWith('CustomPermission:'),
      );
      expect(permEdges).toHaveLength(0);
      expect(result.value.nodes[0]?.properties['permissionRefs']).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('v2.9: extractFlexiPage deduplicates repeated $Permission.CustomPermission.X occurrences', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Dup_Perm_Page.flexipage-meta.xml');
      await writeFile(
        path,
        `<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
  <type>RecordPage</type>
  <flexiPageRegions>
    <componentInstances>
      <componentInstanceProperties>
        <value>
          <criteria><leftValue>{!$Permission.CustomPermission.MyPerm}</leftValue></criteria>
          <criteria><leftValue>{!$Permission.CustomPermission.MyPerm}</leftValue></criteria>
        </value>
      </componentInstanceProperties>
    </componentInstances>
  </flexiPageRegions>
</FlexiPage>`,
        'utf8',
      );
      const result = await extractFlexiPage(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const permEdges = result.value.edges.filter(
        (e) =>
          e.edgeType === 'references' &&
          e.toId.startsWith('CustomPermission:'),
      );
      // Duplicated occurrences collapse to one edge.
      expect(permEdges).toHaveLength(1);
      expect(permEdges[0]!.toId).toBe('CustomPermission:MyPerm');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
