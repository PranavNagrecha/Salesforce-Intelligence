/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER (second review): sharing-rule `<criteriaItems>` and
 * restriction / scoping rule `<recordFilter>` fields were stored only as node
 * properties, so no edge reached the field. `safe_to_delete_field` derives its
 * `sharing` category from these families and read "checked, none" for a field
 * two criteria-based sharing rules test — a delete Salesforce refuses. Each
 * tested field now gets a `references` edge from the rule. Names synthetic.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractRecordFilterFieldNames,
  extractRestrictionRule,
  extractScopingRule,
  recordFilterRelationshipPaths,
} from '../src/enterprise-metadata.js';
import { extractSharingRules } from '../src/sharing-rules.js';

const withFile = async <T>(name: string, xml: string, run: (path: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'sfi-rule-field-edges-'));
  try {
    const path = join(dir, name);
    await writeFile(path, xml, 'utf8');
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('sharing-rule criteria field edges', () => {
  it('a criteria rule references each field its criteria test (object prefix stripped)', async () => {
    const xml = `<?xml version="1.0"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
  <sharingCriteriaRules>
    <fullName>Share_West</fullName>
    <accessLevel>Read</accessLevel>
    <sharedTo><group>West_Team</group></sharedTo>
    <criteriaItems><field>Region__c</field><operation>equals</operation><value>West</value></criteriaItems>
    <criteriaItems><field>Project__c.Tier__c</field><operation>equals</operation><value>Gold</value></criteriaItems>
    <criteriaItems><field>Region__c</field><operation>notEqual</operation><value>East</value></criteriaItems>
  </sharingCriteriaRules>
</SharingRules>`;
    await withFile('Project__c.sharingRules-meta.xml', xml, async (path) => {
      const r = await extractSharingRules(path);
      if (!r.ok) throw new Error(r.error.message);
      const refs = r.value.edges
        .filter((e) => e.edgeType === 'references')
        .map((e) => [e.fromId, e.toId, e.properties['referenceKind']]);
      expect(refs.sort()).toEqual([
        ['SharingRule:Project__c.Share_West', 'CustomField:Project__c.Region__c', 'sharingCriteria'],
        ['SharingRule:Project__c.Share_West', 'CustomField:Project__c.Tier__c', 'sharingCriteria'],
      ]);
    });
  });
});

describe('restriction / scoping rule recordFilter field edges', () => {
  it('extractRecordFilterFieldNames reads bare fields and custom lookup paths, not literals or $User', () => {
    expect(extractRecordFilterFieldNames("<recordFilter>Region__c = 'Status__c = x' AND Tier__c != null</recordFilter>")).toEqual([
      'Region__c',
      'Tier__c',
    ]);
    expect(extractRecordFilterFieldNames('<recordFilter>Advisor__r.Id=$User.Id</recordFilter>')).toEqual(['Advisor__c']);
    expect(extractRecordFilterFieldNames('<recordFilter>Amount__c &gt;= 10</recordFilter>')).toEqual(['Amount__c']);
  });

  it('a RestrictionRule and a ScopingRule reference the fields their filter tests', async () => {
    const body = (root: string): string =>
      `<${root} xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><targetEntity>Project__c</targetEntity><recordFilter>Region__c = 'West'</recordFilter></${root}>`;
    for (const [root, extract, id] of [
      ['RestrictionRule', extractRestrictionRule, 'RestrictionRule:West_Only'],
      ['ScopingRule', extractScopingRule, 'ScopingRule:West_Only'],
    ] as const) {
      await withFile('West_Only.rule-meta.xml', body(root), async (path) => {
        const r = await extract(path);
        if (!r.ok) throw new Error(r.error.message);
        const ref = r.value.edges.find((e) => e.edgeType === 'references' && e.toId.startsWith('CustomField:'));
        expect(ref?.fromId).toBe(id);
        expect(ref?.toId).toBe('CustomField:Project__c.Region__c');
        expect(ref?.properties['referenceKind']).toBe('recordFilter');
      });
    }
  });
});

describe('restriction / scoping rule recordFilter relationship paths', () => {
  it('reads whole relationship paths, not $User merge fields or literals', () => {
    expect(
      recordFilterRelationshipPaths("Lookup__r.Field__c = $User.Id AND Account.Owner.Name != 'A.B' AND Region__c = 'x'"),
    ).toEqual(['Account.Owner.Name', 'Lookup__r.Field__c']);
  });

  it('a rule node carries the paths its filter tests, for the refresh pass to resolve', async () => {
    const xml =
      '<RestrictionRule xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active><targetEntity>Project__c</targetEntity><recordFilter>Lookup__r.Field__c=$User.Id</recordFilter></RestrictionRule>';
    await withFile('Lead_Only.rule-meta.xml', xml, async (path) => {
      const r = await extractRestrictionRule(path);
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.nodes[0]?.properties['recordFilterPaths']).toEqual(['Lookup__r.Field__c']);
    });
  });
});
