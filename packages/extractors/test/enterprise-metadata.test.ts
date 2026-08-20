/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractCertificate,
  extractCustomPermission,
  extractDashboard,
  extractEntitlementProcess,
  extractFlexiPage,
  extractListView,
  extractMilestoneType,
  extractPermissionSetGroup,
  extractPresenceUserConfig,
  extractQueueRoutingConfig,
  extractReport,
  extractReportType,
  extractRestrictionRule,
  extractScopingRule,
  extractServiceChannel,
  extractTransactionSecurityPolicy,
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
      // RESTRICTION-RULE-MISSING-OBJECT-GRAPH: a traversable object→rule
      // `parentOf` edge must also be emitted (parentId alone left get_edges
      // empty and object-scoped surfaces blind to the rule).
      const parentEdge = result.value.edges.find(
        (e) => e.edgeType === 'parentOf',
      );
      expect(parentEdge?.fromId).toBe('CustomObject:Account');
      expect(parentEdge?.toId).toBe('RestrictionRule:Limit_Course_Access');
      expect(parentEdge?.confidence).toBe('declared');
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
      // No parent object resolved → no object→rule parentOf edge (never a
      // dangling `CustomObject:` edge from a missing targetEntity).
      expect(
        result.value.edges.some((e) => e.edgeType === 'parentOf'),
      ).toBe(false);
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
      // RESTRICTION-RULE-MISSING-OBJECT-GRAPH: ScopingRule also emits the
      // object→rule parentOf edge.
      const parentEdge = result.value.edges.find(
        (e) => e.edgeType === 'parentOf',
      );
      expect(parentEdge?.fromId).toBe('CustomObject:Contact');
      expect(parentEdge?.toId).toBe('ScopingRule:Best_Advisor_Scope');
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
        'Widget_Assignments__c',
        'listViews',
        'Completed.listView-meta.xml',
      );
      await mkdir(join(dir, 'objects', 'Widget_Assignments__c', 'listViews'), {
        recursive: true,
      });
      await writeFile(
        path,
        '<ListView><columns>NAME</columns>' +
          '<filters><field>UserWidgetId__c</field><operation>equals</operation><value>1</value></filters>' +
          '</ListView>',
      );

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = result.value.edges.find(
        (e) => e.toId === 'CustomField:Widget_Assignments__c.UserWidgetId__c',
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
          e.toId === 'CustomField:Widget_Assignments__c.UserWidgetId__c' &&
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

  it('R6-04: legacy dotted SOAP-style addressing (CONTACT.EMAIL, CORE.USERS.ALIAS, …) is skipped, not phantomed, and counted', async () => {
    // Real shape observed in a production-scale gate vault: objects/Contact/listViews/
    // New_Associate_AS_AAS_LPN_to_BS_Nrsg.listView-meta.xml. Before R6-04,
    // the <columns> sweep minted CustomField:CONTACT.EMAIL,
    // CustomField:CONTACT.PHONE3, and CustomField:CORE.USERS.ALIAS — ids
    // that can never resolve to a real graph node (the real node id is
    // CustomField:Contact.Email, not CustomField:CONTACT.EMAIL). The
    // <filters> path already silently excluded the filter-side sibling
    // (CONTACT.CREATED_DATE) via its pre-existing blanket rule; this test
    // also asserts that stays true AND is now counted.
    const dir = await makeTemp();
    try {
      const path = join(dir, 'objects', 'Contact', 'listViews', 'Real_Org_Shape.listView-meta.xml');
      await mkdir(join(dir, 'objects', 'Contact', 'listViews'), { recursive: true });
      await writeFile(
        path,
        '<ListView>' +
          '<columns>FULL_NAME</columns>' +
          '<columns>Permanent_State_Province__c</columns>' +
          '<columns>CONTACT.PHONE3</columns>' +
          '<columns>CONTACT.EMAIL</columns>' +
          '<columns>CORE.USERS.ALIAS</columns>' +
          '<filterScope>Everything</filterScope>' +
          '<filters><field>Permanent_State_Province__c</field><operation>notEqual</operation><value>MA</value></filters>' +
          '<filters><field>CONTACT.CREATED_DATE</field><operation>greaterOrEqual</operation><value>11/1/2021 12:00 AM</value></filters>' +
          '</ListView>',
      );

      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const toIds = result.value.edges.filter((e) => e.edgeType === 'references').map((e) => e.toId);
      // The legacy dotted tokens mint NO edge — from either sweep.
      for (const phantom of [
        'CustomField:CONTACT.PHONE3',
        'CustomField:CONTACT.EMAIL',
        'CustomField:CORE.USERS.ALIAS',
        'CustomField:CONTACT.CREATED_DATE',
      ]) {
        expect(toIds).not.toContain(phantom);
      }
      // Real fields (bare uppercase pseudo-column aside) still resolve.
      expect(toIds).toContain('CustomField:Contact.Permanent_State_Province__c');

      // The skip is disclosed on the node, not silently dropped: 3 from
      // <columns> (PHONE3, EMAIL, CORE.USERS.ALIAS) + 1 from <filters>
      // (CONTACT.CREATED_DATE) = 4.
      const node = result.value.nodes[0]!;
      expect(node.properties['legacyAddressingRefsSkipped']).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('R6-04: legacyAddressingRefsSkipped is omitted (not zero) when nothing was skipped', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'objects', 'Contact', 'listViews', 'Clean.listView-meta.xml');
      await mkdir(join(dir, 'objects', 'Contact', 'listViews'), { recursive: true });
      await writeFile(path, '<ListView><columns>Email</columns></ListView>');
      const result = await extractListView(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]!.properties['legacyAddressingRefsSkipped']).toBeUndefined();
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

  // FLEXIPAGE-FIELDREFS-RECORD-PREFIX-PHANTOM: a FlexiPage `<fieldItem>` names a
  // field on the page's record context with the literal `Record.` pseudo-object
  // head. `Record` is not an SObject, so a `CustomField:Record.Field` id is a
  // phantom that never resolves and hides the real field's reverse usage. The
  // extractor must rewrite `Record.` to the page's `sobjectType`. Generic
  // synthetic object (no org identifiers).
  it('rescopes a Record.* fieldItem to the page sobjectType (no Record. phantom)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Widget_Record_Page.flexipage-meta.xml');
      await writeFile(
        path,
        '<FlexiPage><sobjectType>Widget__c</sobjectType>' +
          '<fieldInstance><fieldItem>Record.Resolution__c</fieldItem></fieldInstance>' +
          '<fieldInstance><fieldItem>Record.Name</fieldItem></fieldInstance>' +
          '</FlexiPage>',
      );
      const result = await extractFlexiPage(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toIds = result.value.edges.map((e) => e.toId);
      // The direct record field is now object-qualified and resolvable…
      expect(toIds).toContain('CustomField:Widget__c.Resolution__c');
      expect(toIds).toContain('CustomField:Widget__c.Name');
      // …and NO `Record.*` phantom id survives.
      expect(toIds.filter((id) => id.startsWith('CustomField:Record.'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // FLEXIPAGE-EMBEDDED-FLOW-UNGRAPHED: a Lightning record page embeds Screen
  // Flows via `flowruntime:interview` components naming the Flow through a
  // `flowName` property. Those were invisible to the field/permission sweeps, so
  // an active embedded Flow read 0-usage / safe-to-delete. The extractor must
  // emit FlexiPage -> Flow:{flowName} edges. Generic synthetic flow names.
  it('emits FlexiPage -> Flow edges for flowruntime:interview embedded flows (FLEXIPAGE-EMBEDDED-FLOW-UNGRAPHED)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Widget_Record_Page.flexipage-meta.xml');
      await writeFile(
        path,
        '<FlexiPage><sobjectType>Widget__c</sobjectType>' +
          '<flexiPageRegions><itemInstances><componentInstance>' +
          '<componentInstanceProperties><name>flowLayout</name><value>oneColumn</value></componentInstanceProperties>' +
          '<componentInstanceProperties><name>flowName</name><value>Widget_Screen_Flow</value></componentInstanceProperties>' +
          '<componentName>flowruntime:interview</componentName>' +
          '<identifier>flowruntime_interview</identifier>' +
          '</componentInstance></itemInstances>' +
          '<itemInstances><componentInstance>' +
          '<componentInstanceProperties><name>flowName</name><value>Widget_Approval_Screen_Flow</value></componentInstanceProperties>' +
          '<componentName>flowruntime:interview</componentName>' +
          '</componentInstance></itemInstances></flexiPageRegions>' +
          // A non-flow component that happens to carry a `flowName`-shaped prop
          // on a bespoke LWC must NOT mint a Flow edge (precise scoping).
          '<flexiPageRegions><itemInstances><componentInstance>' +
          '<componentInstanceProperties><name>flowName</name><value>Not_A_Flow_Ref</value></componentInstanceProperties>' +
          '<componentName>c:myCustomWidget</componentName>' +
          '</componentInstance></itemInstances></flexiPageRegions>' +
          '</FlexiPage>',
      );
      const result = await extractFlexiPage(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const flowEdges = result.value.edges.filter((e) =>
        e.toId.startsWith('Flow:'),
      );
      const flowTargets = flowEdges.map((e) => e.toId).sort();
      expect(flowTargets).toEqual([
        'Flow:Widget_Approval_Screen_Flow',
        'Flow:Widget_Screen_Flow',
      ]);
      // Declared confidence + embeddedFlow kind, and the node lists them.
      expect(flowEdges[0]?.confidence).toBe('declared');
      expect(flowEdges[0]?.properties['referenceKind']).toBe('embeddedFlow');
      expect(result.value.nodes[0]?.properties['embeddedFlows']).toEqual([
        'Widget_Approval_Screen_Flow',
        'Widget_Screen_Flow',
      ]);
      // The bespoke-LWC `flowName` prop did NOT mint a Flow edge.
      expect(flowTargets).not.toContain('Flow:Not_A_Flow_Ref');
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

  // PERMISSIONSETGROUP-OMITS-STATUS-AND-ACTIVATION: <status> and
  // <hasActivationRequired> were dropped, so "is this PSG ready /
  // session-activated?" could not be answered from structured facts.
  it('projects PermissionSetGroup <status> and <hasActivationRequired>', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Sample_Perm_Group.permissionsetgroup-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSetGroup xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Bundle for sample users.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Sample Perm Group</label>
    <permissionSets>Widget_Base</permissionSets>
    <status>Updated</status>
</PermissionSetGroup>`,
        'utf8',
      );
      const result = await extractPermissionSetGroup(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.properties['status']).toBe('Updated');
      expect(node.properties['hasActivationRequired']).toBe('false');
      // Membership capture (pre-existing) must not regress.
      expect(node.properties['permissionSets']).toEqual(['Widget_Base']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // REPORT-TYPE-OMITS-BASE-OBJECT-JOIN-AND-COLUMNS: the report type was
  // description-only; base object, joined relationships, and column count were
  // invisible. Real-org shape: Account base with Contacts → pkg__Related_Items__r
  // joins and hundreds of section columns.
  it('surfaces ReportType baseObject (+ edge), join relationships, and column count', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Accounts_with_Related_Items.reportType-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<ReportType xmlns="http://soap.sforce.com/2006/04/metadata">
    <baseObject>Account</baseObject>
    <category>accounts</category>
    <deployed>true</deployed>
    <label>Accounts with Related Items</label>
    <join>
        <join>
            <relationship>pkg__Related_Items__r</relationship>
        </join>
        <outerJoin>false</outerJoin>
        <relationship>Contacts</relationship>
    </join>
    <sections>
        <columns><field>Name</field><table>Account</table></columns>
        <columns><field>Industry</field><table>Account</table></columns>
        <columns><field>Email</field><table>Contacts</table></columns>
        <masterLabel>Account Columns</masterLabel>
    </sections>
</ReportType>`,
        'utf8',
      );
      const result = await extractReportType(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.properties['baseObject']).toBe('Account');
      expect(node.properties['category']).toBe('accounts');
      expect(node.properties['deployed']).toBe('true');
      // Join relationships (Account base + Contacts + pkg__Related_Items__r).
      expect(node.properties['joinRelationships']).toEqual([
        'Contacts',
        'pkg__Related_Items__r',
      ]);
      // Column COUNT with the honest coverage caveat (per-column identity deferred).
      expect(node.properties['columnCount']).toBe(3);
      expect(node.properties['columnsModeled']).toBe(false);
      // A declared edge to the base object (so object blast-radius sees it).
      expect(result.value.edges).toContainEqual(
        expect.objectContaining({
          fromId: 'ReportType:Accounts_with_Related_Items',
          toId: 'CustomObject:Account',
          edgeType: 'references',
          confidence: 'declared',
          properties: { referenceKind: 'reportTypeBaseObject' },
        }),
      );
      // Relationship names must NOT be minted as phantom CustomObject edges.
      expect(
        result.value.edges.some((e) => e.toId === 'CustomObject:Contacts'),
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Bug fix: ReportType <label> was never extracted — makeNode always set label: null
  // because extractReportType passed no labelXmlElement config. Real org shape from
  // org-kb/source/main/default/reportTypes/Sample_Report_Daily_v2.reportType-meta.xml.
  it('extracts the <label> from a real ReportType XML and surfaces it as node.label', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Sample_Report_Daily_v2.reportType-meta.xml');
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
      expect(node.id).toBe('ReportType:Sample_Report_Daily_v2');
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
  // org-kb/source/main/default/restrictionRules/Limit_Access_to_Sample_Records.rule-meta.xml
  it('extracts enforcementType, recordFilter, userCriteria, and active from a real RestrictionRule', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Limit_Access_to_Sample_Records.rule-meta.xml');
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
    <description>Reviewers should be allowed to see only records where they are the assigned reviewer.</description>
    <enforcementType>Restrict</enforcementType>
    <masterLabel>Limit Access to Sample Records</masterLabel>
    <recordFilter>Widget_Contact__r.Widget_User_Record__c=$User.Id</recordFilter>
    <targetEntity>ns__Widget__c</targetEntity>
    <userCriteria>$User.ProfileId=&apos;00eXX0000000001AAA&apos;</userCriteria>
    <version>1</version>
</RestrictionRule>`,
        'utf8',
      );
      const result = await extractRestrictionRule(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      // Top-level file: id is just the stem; parentId comes from <targetEntity>.
      expect(node.id).toBe('RestrictionRule:Limit_Access_to_Sample_Records');
      expect(node.parentId).toBe('CustomObject:ns__Widget__c');
      // Previously missing — must now be present.
      expect(node.properties['enforcementType']).toBe('Restrict');
      expect(node.properties['active']).toBe('true');
      expect(node.properties['recordFilter']).toBe('Widget_Contact__r.Widget_User_Record__c=$User.Id');
      // extractXmlValues uses a plain regex (no XML entity decoding) so &apos;
      // is returned verbatim from the raw text, not decoded to '.
      expect(node.properties['userCriteria']).toBe("$User.ProfileId=&apos;00eXX0000000001AAA&apos;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE: an active RestrictionRule
  // gates on a hardcoded Profile Id in <userCriteria>, but the graph never edged
  // RestrictionRule -> Profile, so "which profiles are constrained by this rule?"
  // could not be answered and the profile looked unused. A single-file extractor
  // CANNOT resolve the opaque id to the name-keyed Profile node (that is an
  // org-wide mapping, and real Profile metadata carries no id), so it emits an
  // explicit `UnresolvedProfile:{id}` STUB with disclosure — it must NEVER mint a
  // `Profile:{id}` node that masquerades as a real Profile. The cross-file
  // resolution to `Profile:{apiName}` runs downstream
  // (`resolveRestrictionRuleProfileEdges`). Synthetic ProfileId.
  it('emits an UNRESOLVED Profile stub from a userCriteria $User.ProfileId, never a Profile:{id} phantom (RESTRICTION-RULE-OMITS-PROFILE-USERCRITERIA-EDGE)', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Limit_Widget_Access.rule-meta.xml');
      // &apos; is returned verbatim by the regex extractor (no entity decoding),
      // so the ProfileId parser must tolerate the &apos; delimiter.
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<RestrictionRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <enforcementType>Restrict</enforcementType>
    <recordFilter>OwnerId=$User.Id</recordFilter>
    <targetEntity>Widget__c</targetEntity>
    <userCriteria>$User.ProfileId=&apos;00eZZZ000000000AAA&apos;</userCriteria>
</RestrictionRule>`,
        'utf8',
      );
      const result = await extractRestrictionRule(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.properties['userCriteriaProfileIds']).toEqual([
        '00eZZZ000000000AAA',
      ]);
      // Disclosure: at extract time every gated id is unresolved.
      expect(node.properties['unresolvedProfileIds']).toEqual([
        '00eZZZ000000000AAA',
      ]);
      // A `Profile:{id}` phantom must NEVER be minted — the opaque id can be
      // mistaken for a real Profile in profile-scoped queries.
      expect(
        result.value.edges.some((e) => e.toId === 'Profile:00eZZZ000000000AAA'),
      ).toBe(false);
      const stubEdge = result.value.edges.find(
        (e) => e.toId === 'UnresolvedProfile:00eZZZ000000000AAA',
      );
      expect(stubEdge).toBeDefined();
      if (!stubEdge) return;
      expect(stubEdge.fromId).toBe('RestrictionRule:Limit_Widget_Access');
      expect(stubEdge.edgeType).toBe('references');
      expect(stubEdge.confidence).toBe('heuristic');
      expect(stubEdge.source).toBe('enterprise-metadata-extractor');
      expect(stubEdge.properties).toEqual({
        referenceKind: 'restrictionUserProfileUnresolved',
        unresolvedProfileId: '00eZZZ000000000AAA',
        idBasedTarget: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ScopingRule uses the same XML schema as RestrictionRule (real-org shape from
  // org-kb/source/main/default/restrictionRules/Viewer_is_Best_Widget.rule-meta.xml
  // — note: that file has <enforcementType>Scoping</enforcementType> despite living
  // in the restrictionRules/ folder; Salesforce stores both types as .rule-meta.xml).
  it('extracts enforcementType=Scoping and extra properties from a real ScopingRule', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Viewer_is_Best_Widget.rule-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<RestrictionRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Used to filter a list view when the user is the best reviewer</description>
    <enforcementType>Scoping</enforcementType>
    <masterLabel>Viewer is Best Widget</masterLabel>
    <recordFilter>Best_Widget__r.Id=$User.Id</recordFilter>
    <targetEntity>Contact</targetEntity>
    <userCriteria>$User.ProfileId=&apos;00eXX0000000002&apos;</userCriteria>
    <version>1</version>
</RestrictionRule>`,
        'utf8',
      );
      const result = await extractScopingRule(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.id).toBe('ScopingRule:Viewer_is_Best_Widget');
      expect(node.parentId).toBe('CustomObject:Contact');
      // Previously missing — must now be present.
      expect(node.properties['enforcementType']).toBe('Scoping');
      expect(node.properties['active']).toBe('true');
      expect(node.properties['recordFilter']).toBe('Best_Widget__r.Id=$User.Id');
      // userCriteria uses &apos; which is returned verbatim by the regex extractor.
      expect(node.properties['userCriteria']).toBe("$User.ProfileId=&apos;00eXX0000000002&apos;");
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
      const path = join(dir, 'Sample_Record_Page.flexipage-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Sample Record Page</masterLabel>
    <sobjectType>ns__Widget__c</sobjectType>
    <type>RecordPage</type>
    <flexiPageRegions>
        <componentInstances>
            <componentInstanceProperties>
                <name>visibilityRule</name>
                <value>
                    <criteria>
                        <leftValue>{!$Permission.CustomPermission.AssignSampleLead}</leftValue>
                        <operator>EQUAL</operator>
                        <rightValue>true</rightValue>
                    </criteria>
                    <criteria>
                        <leftValue>{!$Permission.CustomPermission.ViewSampleDashboard}</leftValue>
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
        'CustomPermission:AssignSampleLead',
        'CustomPermission:ViewSampleDashboard',
      ]);
      // Edge properties: declared confidence + visibilityRulePermission kind.
      for (const edge of permEdges) {
        expect(edge.confidence).toBe('declared');
        expect(edge.properties['referenceKind']).toBe('visibilityRulePermission');
      }
      // permissionRefs mirrored on the node.
      const node = result.value.nodes[0]!;
      expect((node.properties['permissionRefs'] as string[]).sort()).toEqual([
        'CustomPermission:AssignSampleLead',
        'CustomPermission:ViewSampleDashboard',
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

  // Description capture: Report / Dashboard / ReportType / PermissionSetGroup
  // each carry a top-level <description> in Salesforce source that the generic
  // enterprise extractor dropped until extraProperties:['description'] was added.
  // The key is captured when present and OMITTED when absent — the honest
  // "extracted, none present" signal (distinct from a not-modeled type).
  it('captures only description PRESENCE on a Report, never the text', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Widget_Usage.report-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Weekly rollup of widget usage by region.</description>
    <name>Widget Usage</name>
</Report>`,
        'utf8',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // REPORT-DASHBOARD-GRAPH-PERSISTENCE (privacy): Report nodes are now
      // PERSISTED, so the freeform description TEXT is never captured — only
      // its PRESENCE, which is all `missingDescription` ever needed.
      expect(result.value.nodes[0]?.properties['description']).toBeUndefined();
      expect(result.value.nodes[0]?.properties['descriptionPresent']).toBe(true);
      expect(JSON.stringify(result.value.nodes[0])).not.toContain('Weekly rollup');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('OMITS the description key on a Report with no <description>', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'No_Desc.report-meta.xml');
      await writeFile(
        path,
        '<Report xmlns="http://soap.sforce.com/2006/04/metadata"><name>No Desc</name></Report>',
        'utf8',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // "extracted, none present": the key is absent, not null — so the
      // list_components presence filter reads it as "no description".
      expect('description' in result.value.nodes[0]!.properties).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // REPORT-DASHBOARD-GRAPH-PERSISTENCE: the node id must be FOLDER-QUALIFIED.
  // The bare DeveloperName is not unique across report folders, and these
  // nodes are now persisted under `nodes.id` (a PK) — a bare-name id would let
  // one report silently overwrite a same-named sibling in another folder, and
  // no dashboard `<report>Folder/Name</report>` reference would ever resolve.
  it('mints a FOLDER-QUALIFIED Report id, not the bare basename', async () => {
    const dir = await makeTemp();
    try {
      const folder = join(dir, 'reports', 'Sales_Reports');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'Weekly_Summary.report-meta.xml');
      await writeFile(
        path,
        '<Report xmlns="http://soap.sforce.com/2006/04/metadata"><reportType>AccountList</reportType></Report>',
        'utf8',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('Report:Sales_Reports/Weekly_Summary');
      expect(result.value.nodes[0]?.apiName).toBe('Sales_Reports/Weekly_Summary');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // REPORT-DASHBOARD-GRAPH-PERSISTENCE: Salesforce identity is
  // `{LeafFolder}/{DeveloperName}` — ONE folder segment, however deep the
  // retrieve wrote the tree. Measured on a real org: 35% of reports live in
  // nested folders, and joining the full chain broke 93 dashboard->report
  // edges that should have resolved (61.0% -> 75.8% resolution when fixed).
  // The absence of a nested fixture is exactly why that shipped once.
  it('uses ONLY the LEAF folder for a NESTED report path (not the full chain)', async () => {
    const dir = await makeTemp();
    try {
      const folder = join(dir, 'source', 'reports', 'Admissions_Reports', 'MindMaxReports');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'MM_Case_Log_Day.report-meta.xml');
      await writeFile(
        path,
        '<Report xmlns="http://soap.sforce.com/2006/04/metadata"><reportType>CaseList</reportType></Report>',
        'utf8',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Leaf only. The full chain (`Admissions_Reports/MindMaxReports/...`)
      // is an id no dashboard reference and no retrieve member ever names.
      expect(result.value.nodes[0]?.id).toBe('Report:MindMaxReports/MM_Case_Log_Day');
      expect(result.value.nodes[0]?.apiName).toBe('MindMaxReports/MM_Case_Log_Day');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a NESTED dashboard resolves its component-report edge to the LEAF-folder id', async () => {
    const dir = await makeTemp();
    try {
      const folder = join(dir, 'source', 'dashboards', 'Leadership', 'Exec_Dashboards');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'KPIs.dashboard-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<Dashboard xmlns="http://soap.sforce.com/2006/04/metadata">
    <dashboardGridLayout>
        <dashboardGridComponents>
            <report>MindMaxReports/MM_Case_Log_Day</report>
        </dashboardGridComponents>
    </dashboardGridLayout>
</Dashboard>`,
        'utf8',
      );
      const result = await extractDashboard(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('Dashboard:Exec_Dashboards/KPIs');
      // The edge target must be byte-equal to the nested Report's node id
      // asserted in the test above — that equality IS the resolution.
      expect(
        result.value.edges.find(
          (e) => e.properties['referenceKind'] === 'dashboardComponentReport',
        )?.toId,
      ).toBe('Report:MindMaxReports/MM_Case_Log_Day');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves the metadata-type root, not a user folder that is ALSO named "reports"', async () => {
    const dir = await makeTemp();
    try {
      // A legal (if perverse) report folder named `reports`, under a DX
      // retrieve root. A last-occurrence search would return the bare
      // `Weekly_Summary` here and collide with a top-level unfiled report of
      // the same name; anchoring on `unpackaged` keeps the folder qualifier.
      const folder = join(dir, 'source', 'unpackaged', 'reports', 'reports');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'Weekly_Summary.report-meta.xml');
      await writeFile(
        path,
        '<Report xmlns="http://soap.sforce.com/2006/04/metadata"/>',
        'utf8',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('Report:reports/Weekly_Summary');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the bare api name for an unfoldered report file', async () => {
    const dir = await makeTemp();
    try {
      const folder = join(dir, 'reports');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'Unfiled_Item.report-meta.xml');
      await writeFile(
        path,
        '<Report xmlns="http://soap.sforce.com/2006/04/metadata"/>',
        'utf8',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.id).toBe('Report:Unfiled_Item');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // REPORT-DASHBOARD-GRAPH-PERSISTENCE: report -> its source frame. A standard
  // `{Object}List` report type resolves to the object; a custom report type
  // resolves to the `ReportType:` node.
  it('emits a report -> source-object edge for a STANDARD report type', async () => {
    const dir = await makeTemp();
    try {
      const folder = join(dir, 'reports', 'Ops');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'Std.report-meta.xml');
      await writeFile(
        path,
        '<Report xmlns="http://soap.sforce.com/2006/04/metadata"><reportType>AccountList</reportType></Report>',
        'utf8',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = result.value.edges.find(
        (e) => e.properties['referenceKind'] === 'reportSourceObject',
      );
      expect(edge?.toId).toBe('CustomObject:Account');
      expect(edge?.confidence).toBe('declared');
      expect(result.value.nodes[0]?.properties['reportType']).toBe('AccountList');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits a report -> ReportType edge for a CUSTOM report type', async () => {
    const dir = await makeTemp();
    try {
      const folder = join(dir, 'reports', 'Ops');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'Cust.report-meta.xml');
      await writeFile(
        path,
        '<Report xmlns="http://soap.sforce.com/2006/04/metadata"><reportType>Widget_Metrics__c</reportType></Report>',
        'utf8',
      );
      const result = await extractReport(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = result.value.edges.find(
        (e) => e.properties['referenceKind'] === 'reportSourceType',
      );
      expect(edge?.toId).toBe('ReportType:Widget_Metrics__c');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // REPORT-DASHBOARD-GRAPH-PERSISTENCE: dashboard -> its component reports.
  // The `<report>` value is already `Folder/Name`, matching the Report node id.
  it('emits dashboard -> component-report edges and NEVER reads <runningUser>', async () => {
    const dir = await makeTemp();
    try {
      const folder = join(dir, 'dashboards', 'Exec_Dashboards');
      await mkdir(folder, { recursive: true });
      const path = join(folder, 'KPIs.dashboard-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<Dashboard xmlns="http://soap.sforce.com/2006/04/metadata">
    <dashboardType>SpecifiedUser</dashboardType>
    <runningUser>synthetic.analyst@example.invalid</runningUser>
    <dashboardGridLayout>
        <dashboardGridComponents>
            <report>Sales_Reports/Weekly_Summary</report>
        </dashboardGridComponents>
        <dashboardGridComponents>
            <report>Ops/Std</report>
        </dashboardGridComponents>
    </dashboardGridLayout>
</Dashboard>`,
        'utf8',
      );
      const result = await extractDashboard(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.id).toBe('Dashboard:Exec_Dashboards/KPIs');
      // Sorted + deduplicated so the emitted edge set is byte-stable.
      expect(node.properties['componentReports']).toEqual([
        'Ops/Std',
        'Sales_Reports/Weekly_Summary',
      ]);
      expect(node.properties['dashboardType']).toBe('SpecifiedUser');
      const reportEdges = result.value.edges.filter(
        (e) => e.properties['referenceKind'] === 'dashboardComponentReport',
      );
      expect(reportEdges.map((e) => e.toId).sort()).toEqual([
        'Report:Ops/Std',
        'Report:Sales_Reports/Weekly_Summary',
      ]);
      // PRIVACY: `<runningUser>` is a real org username. It is never read, so
      // it can appear NOWHERE in the extracted result.
      expect(JSON.stringify(result.value)).not.toContain('synthetic.analyst');
      expect(node.properties['runningUser']).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures only description PRESENCE on a Dashboard, never the text', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Ops_Board.dashboard-meta.xml');
      await writeFile(
        path,
        '<Dashboard xmlns="http://soap.sforce.com/2006/04/metadata"><description>Operations KPIs.</description></Dashboard>',
        'utf8',
      );
      const result = await extractDashboard(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Presence only, never the text — same rationale as the Report sibling.
      expect(result.value.nodes[0]?.properties['description']).toBeUndefined();
      expect(result.value.nodes[0]?.properties['descriptionPresent']).toBe(true);
      expect(JSON.stringify(result.value.nodes[0])).not.toContain('Operations KPIs');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures both <label> and <description> on a ReportType', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Widget_Metrics.reportType-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<ReportType xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Widget Metrics</label>
    <description>Custom report type joining widgets to regions.</description>
    <deployed>true</deployed>
</ReportType>`,
        'utf8',
      );
      const result = await extractReportType(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      // label capture (pre-existing) must not regress alongside description.
      expect(node.label).toBe('Widget Metrics');
      expect(node.properties['description']).toBe(
        'Custom report type joining widgets to regions.',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures <description> on a PermissionSetGroup alongside membership', async () => {
    const dir = await makeTemp();
    try {
      const path = join(dir, 'Regional_Ops.permissionsetgroup-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSetGroup xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Bundle for regional operations staff.</description>
    <label>Regional Ops</label>
    <permissionSets>Widget_Editor</permissionSets>
</PermissionSetGroup>`,
        'utf8',
      );
      const result = await extractPermissionSetGroup(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.properties['description']).toBe('Bundle for regional operations staff.');
      // membership capture (pre-existing) must not regress.
      expect(node.properties['permissionSets']).toEqual(['Widget_Editor']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // R6-24: report depth beyond column identity — filters/booleanFilter/
  // groupings/buckets/crossFilters/chart/format on the Report node.
  describe('R6-24: Report structural depth', () => {
    it('captures filters, booleanFilter, groupings, and a bucket (+ its source-field edge) on a Summary report', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Summary_Widget_Report.report-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://soap.sforce.com/2006/04/metadata">
    <buckets>
        <bucketType>text</bucketType>
        <developerName>BucketField_1</developerName>
        <masterLabel>Region Bucket</masterLabel>
        <sourceColumnName>Account.BillingState</sourceColumnName>
    </buckets>
    <columns>
        <field>Account.Name</field>
    </columns>
    <filter>
        <booleanFilter>1 AND 2</booleanFilter>
        <criteriaItems>
            <column>Account.Industry</column>
            <columnToColumn>false</columnToColumn>
            <operator>equals</operator>
            <value>Technology</value>
        </criteriaItems>
        <criteriaItems>
            <column>Account.AnnualRevenue</column>
            <columnToColumn>false</columnToColumn>
            <operator>greaterThan</operator>
            <value>1000000</value>
        </criteriaItems>
    </filter>
    <format>Summary</format>
    <groupingsDown>
        <dateGranularity>Day</dateGranularity>
        <field>BucketField_1</field>
        <sortOrder>Asc</sortOrder>
    </groupingsDown>
    <name>Widget Report</name>
    <reportType>AccountList</reportType>
</Report>`,
          'utf8',
        );
        const result = await extractReport(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;

        expect(node.properties['filters']).toEqual([
          { field: 'Account.Industry', operator: 'equals', hasValue: true },
          { field: 'Account.AnnualRevenue', operator: 'greaterThan', hasValue: true },
        ]);
        expect(node.properties['booleanFilter']).toBe('1 AND 2');
        expect(node.properties['groupings']).toEqual([
          { field: 'BucketField_1', dateGranularity: 'Day', axis: 'down' },
        ]);
        expect(node.properties['buckets']).toEqual([
          { field: 'BucketField_1', label: 'Region Bucket', sourceField: 'Account.BillingState' },
        ]);
        expect(node.properties['format']).toBe('Summary');
        // no crossFilters/chart on this fixture — omitted, not empty/null.
        expect('crossFilters' in node.properties).toBe(false);
        expect('chart' in node.properties).toBe(false);

        // Bucket source-field reference edge: declared confidence, tagged
        // with the bucket's developerName so a consumer can attribute it.
        const bucketEdge = result.value.edges.find(
          (e) => e.toId === 'CustomField:Account.BillingState' && e.properties['referenceKind'] === 'bucketSource',
        );
        expect(bucketEdge).toBeDefined();
        expect(bucketEdge?.fromId).toBe(node.id);
        expect(bucketEdge?.confidence).toBe('declared');
        expect(bucketEdge?.properties['bucketField']).toBe('BucketField_1');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('captures crossFilters (related object + condition presence, never the criteria values) on a Matrix report with groupingsAcross', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Matrix_Pipeline.report-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://soap.sforce.com/2006/04/metadata">
    <crossFilters>
        <criteriaItems>
            <column>Type</column>
            <operator>equals</operator>
            <value>Partner</value>
        </criteriaItems>
        <operation>with</operation>
        <primaryTableColumn>ACCOUNT_ID</primaryTableColumn>
        <relatedTable>Opportunity</relatedTable>
    </crossFilters>
    <format>Matrix</format>
    <groupingsAcross>
        <field>StageName</field>
    </groupingsAcross>
    <groupingsDown>
        <field>Account.Industry</field>
    </groupingsDown>
    <name>Pipeline Matrix</name>
</Report>`,
          'utf8',
        );
        const result = await extractReport(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;

        expect(node.properties['format']).toBe('Matrix');
        expect(node.properties['crossFilters']).toEqual([
          { relatedObject: 'Opportunity', operation: 'with', hasConditions: true },
        ]);
        expect(node.properties['groupings']).toEqual(
          expect.arrayContaining([
            { field: 'StageName', dateGranularity: null, axis: 'across' },
            { field: 'Account.Industry', dateGranularity: null, axis: 'down' },
          ]),
        );
        // no <filter> block on this fixture.
        expect('filters' in node.properties).toBe(false);
        expect('booleanFilter' in node.properties).toBe(false);

        // The crossFilter's literal criteria value must never be captured —
        // only its field/operator/presence, per the value-omission rule.
        expect(JSON.stringify(result.value)).not.toContain('Partner');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('captures chart type + summary-axis presence', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Case_Chart.report-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://soap.sforce.com/2006/04/metadata">
    <chart>
        <chartType>Pie</chartType>
        <chartSummaries>
            <axisBinding>y</axisBinding>
            <column>RowCount</column>
        </chartSummaries>
        <groupingColumn>STATUS</groupingColumn>
    </chart>
    <format>Summary</format>
    <name>Case Chart</name>
</Report>`,
          'utf8',
        );
        const result = await extractReport(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['chart']).toEqual({
          type: 'Pie',
          hasSummaryAxis: true,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('OMITS every R6-24 depth key on a minimal Tabular report (no filter/buckets/chart/crossFilters)', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Tabular_Minimal.report-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://soap.sforce.com/2006/04/metadata">
    <columns>
        <field>Name</field>
    </columns>
    <format>Tabular</format>
    <name>Minimal Tabular</name>
</Report>`,
          'utf8',
        );
        const result = await extractReport(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['format']).toBe('Tabular');
        for (const key of ['filters', 'booleanFilter', 'groupings', 'buckets', 'crossFilters', 'chart', 'truncatedCounts']) {
          expect(key in node.properties).toBe(false);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('caps filters/groupings/buckets/crossFilters at REPORT_DETAIL_LIST_CAP and discloses the drop count in truncatedCounts', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Joined_Huge.report-meta.xml');
        const cap = 100;
        const overflow = 5;
        const criteriaItems = Array.from(
          { length: cap + overflow },
          (_, i) => `<criteriaItems><column>Field_${i}__c</column><operator>equals</operator><value>v${i}</value></criteriaItems>`,
        ).join('');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://soap.sforce.com/2006/04/metadata">
    <filter>${criteriaItems}</filter>
    <format>Summary</format>
    <name>Joined Huge</name>
</Report>`,
          'utf8',
        );
        const result = await extractReport(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect((node.properties['filters'] as unknown[]).length).toBe(cap);
        expect(node.properties['truncatedCounts']).toEqual({ filters: overflow });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('never stores a report filter literal value — only field/operator/hasValue', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Sensitive_Filter.report-meta.xml');
        const secretLiteral = 'UnlikelyLiteralToken_9f3a7c';
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://soap.sforce.com/2006/04/metadata">
    <filter>
        <criteriaItems>
            <column>Contact.Email</column>
            <operator>equals</operator>
            <value>${secretLiteral}</value>
        </criteriaItems>
    </filter>
    <format>Summary</format>
    <name>Sensitive Filter</name>
</Report>`,
          'utf8',
        );
        const result = await extractReport(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['filters']).toEqual([
          { field: 'Contact.Email', operator: 'equals', hasValue: true },
        ]);
        // The literal must not survive anywhere in the extraction result.
        expect(JSON.stringify(result.value)).not.toContain(secretLiteral);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does NOT apply report depth parsing to a Dashboard (reportDetail is Report-only)', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Ops_Board.dashboard-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Dashboard xmlns="http://soap.sforce.com/2006/04/metadata">
    <format>Summary</format>
</Dashboard>`,
          'utf8',
        );
        const result = await extractDashboard(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // A Dashboard's own <format> element is unrelated to R6-24 — the
        // config flag is unset for extractDashboard, so no depth keys land.
        expect('format' in result.value.nodes[0]!.properties).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // R6-22: security-surface extractors — Certificate + TransactionSecurityPolicy.
  describe('R6-22: Certificate + TransactionSecurityPolicy', () => {
    it('extracts a Certificate node with metadata-only properties (never the paired .crt content file)', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'EC_Community.crt-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Certificate xmlns="http://soap.sforce.com/2006/04/metadata">
    <caSigned>true</caSigned>
    <encryptedWithPlatformEncryption>false</encryptedWithPlatformEncryption>
    <expirationDate>2026-11-12T14:40:53.000Z</expirationDate>
    <keySize>2048</keySize>
    <masterLabel>EC Community</masterLabel>
    <privateKeyExportable>true</privateKeyExportable>
</Certificate>`,
          'utf8',
        );
        // Simulate the paired content file the Metadata API always retrieves
        // alongside the sidecar — the extractor must never read it, only the
        // `.crt-meta.xml` suffix is dispatched to `extractCertificate`.
        await writeFile(
          join(dir, 'EC_Community.crt'),
          '-----BEGIN CERTIFICATE-----\nMIIGsjCCBZqgAwIBAgIIIELCj3jmVIAw...\n-----END CERTIFICATE-----',
          'utf8',
        );

        const result = await extractCertificate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('Certificate:EC_Community');
        expect(node.type).toBe('Certificate');
        expect(node.parentId).toBe(null);
        expect(node.label).toBe('EC Community');
        expect(node.properties['caSigned']).toBe('true');
        expect(node.properties['expirationDate']).toBe('2026-11-12T14:40:53.000Z');
        expect(node.properties['keySize']).toBe('2048');
        // No edges — Certificate is a flat, edge-less definition node.
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts a self-signed Certificate (caSigned: false)', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'SelfSignedCert_20250129.crt-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<Certificate xmlns="http://soap.sforce.com/2006/04/metadata">
    <caSigned>false</caSigned>
    <expirationDate>2027-02-02T12:00:00.000Z</expirationDate>
    <keySize>2048</keySize>
    <masterLabel>SelfSignedCert_20250129</masterLabel>
</Certificate>`,
          'utf8',
        );
        const result = await extractCertificate(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['caSigned']).toBe('false');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts eventName/active/action + a references edge to the Apex condition class', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Block_Suspicious_Login.transactionSecurityPolicy-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<TransactionSecurityPolicy xmlns="http://soap.sforce.com/2006/04/metadata">
    <action>
        <block>true</block>
        <endSession>false</endSession>
        <freezeUser>false</freezeUser>
        <notifications>
            <inApp>true</inApp>
            <sendEmail>true</sendEmail>
            <user>admin@example.com</user>
        </notifications>
        <twoFactorAuthentication>false</twoFactorAuthentication>
    </action>
    <active>true</active>
    <apexClass>SuspiciousLoginCondition</apexClass>
    <developerName>Block_Suspicious_Login</developerName>
    <eventName>LoginEvent</eventName>
    <masterLabel>Block Suspicious Login</masterLabel>
</TransactionSecurityPolicy>`,
          'utf8',
        );
        const result = await extractTransactionSecurityPolicy(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('TransactionSecurityPolicy:Block_Suspicious_Login');
        expect(node.properties['eventName']).toBe('LoginEvent');
        expect(node.properties['active']).toBe('true');
        expect(node.properties['action']).toEqual({
          block: true,
          endSession: false,
          freezeUser: false,
          twoFactorAuthentication: false,
          notificationCount: 1,
        });
        // The notification recipient identity must never be captured.
        expect(JSON.stringify(result.value)).not.toContain('admin@example.com');

        const conditionEdge = result.value.edges.find(
          (e) => e.properties['referenceKind'] === 'conditionClass',
        );
        expect(conditionEdge).toBeDefined();
        expect(conditionEdge?.fromId).toBe(node.id);
        expect(conditionEdge?.toId).toBe('ApexClass:SuspiciousLoginCondition');
        expect(conditionEdge?.confidence).toBe('declared');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('OMITS the action property and emits no condition-class edge when <apexClass> and <action> are absent', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Log_Only_Policy.transactionSecurityPolicy-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<TransactionSecurityPolicy xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <developerName>Log_Only_Policy</developerName>
    <eventName>ReportEvent</eventName>
</TransactionSecurityPolicy>`,
          'utf8',
        );
        const result = await extractTransactionSecurityPolicy(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['eventName']).toBe('ReportEvent');
        expect(node.properties['active']).toBe('false');
        expect('action' in node.properties).toBe(false);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // R6-18: Service Cloud entitlement/SLA + Omni-Channel routing tier.
  // Fixture shapes below are synthesized to mirror REAL retrieves from two
  // live orgs (folder/suffix, field names, and element nesting all verified
  // against real `sf project retrieve` output) — no real org identifiers are
  // reproduced, per the privacy policy. The milestone names used here
  // ("First Response to Customer" / "Escalate Case" / "Close Case") are
  // Salesforce's own standard out-of-the-box milestone type names, not
  // org-specific data.
  describe('R6-18: EntitlementProcess', () => {
    it('extracts an EntitlementProcess node and one references edge per distinct <milestoneName>', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Gold_Support_Process.entitlementProcess-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<EntitlementProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <SObjectType>Case</SObjectType>
    <active>true</active>
    <businessHours>Gold Support Hours</businessHours>
    <description>Runs the gold-tier SLA process for Case.</description>
    <entryStartDateField>Case.CreatedDate</entryStartDateField>
    <isVersionDefault>true</isVersionDefault>
    <milestones>
        <milestoneName>First Response to Customer</milestoneName>
        <minutesToComplete>240</minutesToComplete>
        <useCriteriaStartTime>false</useCriteriaStartTime>
    </milestones>
    <milestones>
        <milestoneName>Escalate Case</milestoneName>
        <minutesToComplete>1440</minutesToComplete>
        <useCriteriaStartTime>false</useCriteriaStartTime>
    </milestones>
    <milestones>
        <milestoneName>Close Case</milestoneName>
        <minutesToComplete>5760</minutesToComplete>
        <useCriteriaStartTime>false</useCriteriaStartTime>
    </milestones>
    <name>Gold Support Process</name>
    <versionMaster>Gold_Support_Process</versionMaster>
    <versionNumber>2</versionNumber>
</EntitlementProcess>`,
          'utf8',
        );
        const result = await extractEntitlementProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('EntitlementProcess:Gold_Support_Process');
        // Flat top-level convention — versioning is modeled as separate
        // files/nodes, not merged; no parent scope.
        expect(node.parentId).toBe(null);
        expect(node.label).toBe('Gold Support Process');
        expect(node.properties['SObjectType']).toBe('Case');
        expect(node.properties['active']).toBe('true');
        expect(node.properties['businessHours']).toBe('Gold Support Hours');
        expect(node.properties['versionNumber']).toBe('2');
        expect(node.properties['versionMaster']).toBe('Gold_Support_Process');
        expect(node.properties['milestoneName']).toEqual([
          'Close Case',
          'Escalate Case',
          'First Response to Customer',
        ]);
        // R7-C7: the repeated-element correctness crux — each of the three
        // <milestones> blocks carries a DIFFERENT minutesToComplete
        // (240/1440/5760, matching a real verified org file); the flat
        // extraProperties first-occurrence trap this fixes would have
        // returned 240 (the FIRST occurrence) for every milestone,
        // silently misattributing the other two. Order matches the file's
        // OWN <milestones> block order (not the sorted milestoneName list).
        expect(node.properties['milestones']).toEqual([
          {
            milestoneName: 'First Response to Customer',
            minutesToComplete: 240,
            useCriteriaStartTime: false,
          },
          {
            milestoneName: 'Escalate Case',
            minutesToComplete: 1440,
            useCriteriaStartTime: false,
          },
          {
            milestoneName: 'Close Case',
            minutesToComplete: 5760,
            useCriteriaStartTime: false,
          },
        ]);

        const edgeTargets = result.value.edges.map((e) => e.toId).sort();
        expect(edgeTargets).toEqual([
          'MilestoneType:Close Case',
          'MilestoneType:Escalate Case',
          'MilestoneType:First Response to Customer',
        ]);
        for (const edge of result.value.edges) {
          expect(edge.fromId).toBe('EntitlementProcess:Gold_Support_Process');
          expect(edge.edgeType).toBe('references');
          expect(edge.confidence).toBe('declared');
          expect(edge.properties).toEqual({ referenceKind: 'entitlementMilestone' });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does not merge multiple version files of the same process into one node', async () => {
      // Versioning honesty: two files sharing a versionMaster are two
      // DISTINCT nodes keyed by their own fullName — never collapsed.
      const dir = await makeTemp();
      try {
        const v1Path = join(dir, 'Gold_Support_Process.entitlementProcess-meta.xml');
        const v2Path = join(dir, 'Gold_Support_Process_2.entitlementProcess-meta.xml');
        const body = (versionNumber: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<EntitlementProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <SObjectType>Case</SObjectType>
    <active>false</active>
    <versionMaster>Gold_Support_Process</versionMaster>
    <versionNumber>${versionNumber}</versionNumber>
</EntitlementProcess>`;
        await writeFile(v1Path, body('1'), 'utf8');
        await writeFile(v2Path, body('2'), 'utf8');
        const r1 = await extractEntitlementProcess(v1Path);
        const r2 = await extractEntitlementProcess(v2Path);
        expect(r1.ok && r2.ok).toBe(true);
        if (!r1.ok || !r2.ok) return;
        expect(r1.value.nodes[0]?.id).toBe('EntitlementProcess:Gold_Support_Process');
        expect(r2.value.nodes[0]?.id).toBe('EntitlementProcess:Gold_Support_Process_2');
        expect(r1.value.nodes[0]?.properties['versionNumber']).toBe('1');
        expect(r2.value.nodes[0]?.properties['versionNumber']).toBe('2');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('tolerates a file with no <name>, no version fields, and zero milestones (matches a real verified fixture shape)', async () => {
      // Mirrors the exact shape of a real EntitlementProcess file verified
      // against a live org: no top-level <name>, no version elements.
      const dir = await makeTemp();
      try {
        const path = join(dir, 'standard_case.entitlementProcess-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<EntitlementProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <SObjectType>Case</SObjectType>
    <active>true</active>
    <entryStartDateField>Case.CreatedDate</entryStartDateField>
</EntitlementProcess>`,
          'utf8',
        );
        const result = await extractEntitlementProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.label).toBe(null);
        expect(node.properties['versionNumber']).toBeUndefined();
        expect(node.properties['businessHours']).toBeUndefined();
        // Zero <milestones> blocks -> `milestones` is OMITTED, not an empty
        // array (matches this file's "extracted, none present" convention
        // elsewhere, e.g. `legacyAddressingRefsSkipped`).
        expect('milestones' in node.properties).toBe(false);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves minutesToComplete/useCriteriaStartTime null (not 0/false) when a <milestones> block omits them', async () => {
      // Tri-state discipline: an absent element is `null` — never defaulted
      // — mirroring this file's Network guest-switch precedent ("absent
      // switch is null, never fabricated false").
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Bronze_Support.entitlementProcess-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<EntitlementProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <SObjectType>Case</SObjectType>
    <active>true</active>
    <milestones>
        <milestoneName>First Response to Customer</milestoneName>
    </milestones>
</EntitlementProcess>`,
          'utf8',
        );
        const result = await extractEntitlementProcess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['milestones']).toEqual([
          {
            milestoneName: 'First Response to Customer',
            minutesToComplete: null,
            useCriteriaStartTime: null,
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('R6-18: MilestoneType', () => {
    it('extracts a MilestoneType node with no parent scope and no <name>/<label> element (matches real org shape)', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Escalate Case.milestoneType-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<MilestoneType xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Sets a recurring milestone for escalating a Case.</description>
    <recurrenceType>recursIndependently</recurrenceType>
</MilestoneType>`,
          'utf8',
        );
        const result = await extractMilestoneType(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('MilestoneType:Escalate Case');
        expect(node.apiName).toBe('Escalate Case');
        expect(node.parentId).toBe(null);
        expect(node.properties['description']).toBe(
          'Sets a recurring milestone for escalating a Case.',
        );
        expect(node.properties['recurrenceType']).toBe('recursIndependently');
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('R6-18: ServiceChannel', () => {
    it('extracts relatedEntityType (not salesforceObject) and capacity/behavior flags', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'sfdc_phone.serviceChannel-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<ServiceChannel xmlns="http://soap.sforce.com/2006/04/metadata">
    <doesMinimizeWidgetOnAccept>true</doesMinimizeWidgetOnAccept>
    <hasAfterConvoWorkTimer>false</hasAfterConvoWorkTimer>
    <hasAutoAcceptEnabled>false</hasAutoAcceptEnabled>
    <isInterruptible>false</isInterruptible>
    <label>Phone</label>
    <relatedEntityType>VoiceCall</relatedEntityType>
</ServiceChannel>`,
          'utf8',
        );
        const result = await extractServiceChannel(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('ServiceChannel:sfdc_phone');
        expect(node.parentId).toBe(null);
        expect(node.label).toBe('Phone');
        expect(node.properties['relatedEntityType']).toBe('VoiceCall');
        expect(node.properties['salesforceObject']).toBeUndefined();
        expect(node.properties['doesMinimizeWidgetOnAccept']).toBe('true');
        expect(node.properties['isInterruptible']).toBe('false');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('captures capacityModel when present (documented field, not present in either verification org)', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Case_Channel.serviceChannel-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<ServiceChannel xmlns="http://soap.sforce.com/2006/04/metadata">
    <capacityModel>StatusBased</capacityModel>
    <label>Case Channel</label>
    <relatedEntityType>Case</relatedEntityType>
</ServiceChannel>`,
          'utf8',
        );
        const result = await extractServiceChannel(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['capacityModel']).toBe('StatusBased');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // SERVICE-CHANNEL-RELATED-ENTITY-UNGRAPHED: relatedEntityType was extracted
    // as a scalar string but emitted no edge, so "which Omni channel owns
    // MessagingSession?" and MessagingSession blast-radius missed the channel.
    it('emits a declared references edge ServiceChannel -> CustomObject for relatedEntityType', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'My_Messaging_Channel.serviceChannel-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<ServiceChannel xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Messaging</label>
    <relatedEntityType>MessagingSession</relatedEntityType>
</ServiceChannel>`,
          'utf8',
        );
        const result = await extractServiceChannel(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        // The scalar property is preserved (NOT turned into an array).
        expect(node.properties['relatedEntityType']).toBe('MessagingSession');
        const edge = result.value.edges.find(
          (e) => e.toId === 'CustomObject:MessagingSession',
        );
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.fromId).toBe('ServiceChannel:My_Messaging_Channel');
        expect(edge.edgeType).toBe('references');
        expect(edge.confidence).toBe('declared');
        expect(edge.source).toBe('enterprise-metadata-extractor');
        expect(edge.properties).toEqual({ referenceKind: 'serviceChannelEntity' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('R6-18: QueueRoutingConfig', () => {
    it('extracts routing/capacity properties and a references edge to Queue for a set <queueOverflowAssignee>', async () => {
      // Verified against a real file: <queueOverflowAssignee> holds a Queue
      // DEVELOPER NAME (not an opaque record id).
      const dir = await makeTemp();
      try {
        const path = join(dir, 'agent_routing.queueRoutingConfig-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<QueueRoutingConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <capacityType>INHERITED</capacityType>
    <capacityWeight>5.0</capacityWeight>
    <isAttributeBased>false</isAttributeBased>
    <label>agent routing</label>
    <queueOverflowAssignee>Fallback_Queue</queueOverflowAssignee>
    <routingModel>MOST_AVAILABLE</routingModel>
    <routingPriority>1</routingPriority>
</QueueRoutingConfig>`,
          'utf8',
        );
        const result = await extractQueueRoutingConfig(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('QueueRoutingConfig:agent_routing');
        expect(node.parentId).toBe(null);
        expect(node.label).toBe('agent routing');
        expect(node.properties['routingModel']).toBe('MOST_AVAILABLE');
        expect(node.properties['routingPriority']).toBe('1');
        expect(node.properties['capacityWeight']).toBe('5.0');
        expect(node.properties['capacityType']).toBe('INHERITED');
        // childRefs mirrors the raw values onto properties as an array
        // (same convention as PermissionSetGroup's permissionSets/
        // mutingPermissionSets), even for a single-valued reference.
        expect(node.properties['queueOverflowAssignee']).toEqual(['Fallback_Queue']);

        expect(result.value.edges).toContainEqual(
          expect.objectContaining({
            fromId: 'QueueRoutingConfig:agent_routing',
            toId: 'Queue:Fallback_Queue',
            edgeType: 'references',
            confidence: 'declared',
            properties: { referenceKind: 'queueOverflowAssignee' },
          }),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits zero edges when <queueOverflowAssignee> is absent (matches a real verified fixture shape)', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'cases_Routing_config.queueRoutingConfig-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<QueueRoutingConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <capacityWeight>1.0</capacityWeight>
    <isAttributeBased>false</isAttributeBased>
    <label>cases_Routing_config</label>
    <routingModel>LEAST_ACTIVE</routingModel>
    <routingPriority>1</routingPriority>
</QueueRoutingConfig>`,
          'utf8',
        );
        const result = await extractQueueRoutingConfig(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        expect(result.value.nodes[0]?.properties['queueOverflowAssignee']).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('captures pushTimeout when present', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Chat_Admissions.queueRoutingConfig-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<QueueRoutingConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <capacityWeight>1.0</capacityWeight>
    <isAttributeBased>false</isAttributeBased>
    <label>Chat - Admissions</label>
    <pushTimeout>60</pushTimeout>
    <routingModel>LEAST_ACTIVE</routingModel>
    <routingPriority>1</routingPriority>
</QueueRoutingConfig>`,
          'utf8',
        );
        const result = await extractQueueRoutingConfig(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['pushTimeout']).toBe('60');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // R7-C7: Omni-Channel presence configuration — the R6-18 leftover ("the
  // <assignments><users> sub-block has no User ComponentType to target").
  // Fixture shapes mirror REAL retrieves from two live orgs (a
  // production-scale university sandbox and a small services org) — no real
  // org identifiers reproduced, per the privacy policy.
  describe('R7-C7: PresenceUserConfig', () => {
    it('captures profile assignments as a references edge and user assignments as a property array with NO edge', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'agentforce.presenceUserConfig-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<PresenceUserConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <assignments>
        <profiles>
            <profile>einstein agent user</profile>
        </profiles>
        <users>
            <user>agentuser@example.invalid</user>
        </users>
    </assignments>
    <capacity>10</capacity>
    <enableAutoAccept>false</enableAutoAccept>
    <enableDecline>false</enableDecline>
    <enableDeclineReason>false</enableDeclineReason>
    <enableDisconnectSound>true</enableDisconnectSound>
    <enableRequestSound>true</enableRequestSound>
    <label>agentforce</label>
</PresenceUserConfig>`,
          'utf8',
        );
        const result = await extractPresenceUserConfig(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('PresenceUserConfig:agentforce');
        expect(node.parentId).toBe(null);
        expect(node.label).toBe('agentforce');
        expect(node.properties['capacity']).toBe('10');
        expect(node.properties['enableAutoAccept']).toBe('false');
        expect(node.properties['enableDecline']).toBe('false');
        expect(node.properties['enableDeclineReason']).toBe('false');
        expect(node.properties['enableDisconnectSound']).toBe('true');
        expect(node.properties['enableRequestSound']).toBe('true');
        // profile -> a real Profile node: mirrored onto properties AND edged.
        expect(node.properties['profile']).toEqual(['einstein agent user']);
        // user -> NO ComponentType exists: captured as a property array,
        // NO edge minted (never a fabricated User: node).
        expect(node.properties['assignedUsernames']).toEqual(['agentuser@example.invalid']);

        expect(result.value.edges).toContainEqual(
          expect.objectContaining({
            fromId: 'PresenceUserConfig:agentforce',
            toId: 'Profile:einstein agent user',
            edgeType: 'references',
            confidence: 'declared',
            properties: { referenceKind: 'presenceProfileAssignment' },
          }),
        );
        // No edge whose target is derived from a username — the whole edge
        // set must contain exactly the one profile-assignment edge.
        expect(result.value.edges).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('captures every assigned username, not just the first, when multiple <user> entries repeat', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'Military.presenceUserConfig-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<PresenceUserConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <assignments>
        <users>
            <user>alice@example.invalid</user>
            <user>bob@example.invalid</user>
            <user>carol@example.invalid</user>
        </users>
    </assignments>
    <capacity>2</capacity>
    <enableAutoAccept>false</enableAutoAccept>
    <enableDecline>false</enableDecline>
    <enableDeclineReason>false</enableDeclineReason>
    <enableDisconnectSound>true</enableDisconnectSound>
    <enableRequestSound>true</enableRequestSound>
    <label>Chat- Military</label>
</PresenceUserConfig>`,
          'utf8',
        );
        const result = await extractPresenceUserConfig(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['assignedUsernames']).toEqual([
          'alice@example.invalid',
          'bob@example.invalid',
          'carol@example.invalid',
        ]);
        // No Profile assignment in this fixture — zero edges.
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('tolerates a config with no <assignments> block at all (matches a real org-default fixture shape)', async () => {
      const dir = await makeTemp();
      try {
        const path = join(dir, 'default_presence_config.presenceUserConfig-meta.xml');
        await writeFile(
          path,
          `<?xml version="1.0" encoding="UTF-8"?>
<PresenceUserConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <capacity>5</capacity>
    <enableAutoAccept>false</enableAutoAccept>
    <enableDecline>false</enableDecline>
    <enableDeclineReason>false</enableDeclineReason>
    <enableDisconnectSound>true</enableDisconnectSound>
    <enableRequestSound>true</enableRequestSound>
    <label>Default Presence Configuration</label>
</PresenceUserConfig>`,
          'utf8',
        );
        const result = await extractPresenceUserConfig(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['capacity']).toBe('5');
        expect('assignedUsernames' in node.properties).toBe(false);
        expect('profile' in node.properties).toBe(false);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
