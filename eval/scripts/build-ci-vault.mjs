#!/usr/bin/env node
/**
 * Builds the git-tracked CI eval vault at eval/fixtures/ci-vault/org-kb.
 * Run after graph package changes: pnpm eval:build-ci-vault
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeGraph,
  importExtractionResults,
  openGraph,
} from '../../packages/graph/dist/src/index.js';
import { vaultPaths } from '../../packages/vault/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const vaultRoot = join(here, '..', 'fixtures', 'ci-vault', 'org-kb');
const p = vaultPaths(vaultRoot);

const COVERAGE_TYPES = [
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'QuickAction',
  'WorkflowRule',
  'SharingRule',
  'Report',
  'Dashboard',
  'ListView',
  'ReportType',
  'FlexiPage',
  'Profile',
  'RestrictionRule',
  'PermissionSetGroup',
  'CustomObject',
];

const coverage = COVERAGE_TYPES.map((type) => ({
  type,
  requested: true,
  retrieved: 1,
  errored: false,
  neverModeled: false,
}));

const node = (overrides) => ({
  label: null,
  parentId: null,
  sourcePath: 'eval/ci-fixture.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const extraction = {
  nodes: [
    node({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      label: 'Account',
      properties: { sharingModel: 'Private' },
    }),
    node({
      id: 'CustomObject:Payment__c',
      type: 'CustomObject',
      apiName: 'Payment__c',
      label: 'Payment',
    }),
    node({
      id: 'CustomField:Account.Industry',
      type: 'CustomField',
      apiName: 'Industry',
      label: 'Industry',
      parentId: 'CustomObject:Account',
    }),
    node({
      id: 'CustomField:Payment__c.Amount__c',
      type: 'CustomField',
      apiName: 'Amount__c',
      label: 'Amount',
      parentId: 'CustomObject:Payment__c',
    }),
    node({
      id: 'Report:Account_Usage',
      type: 'Report',
      apiName: 'Account_Usage',
      label: 'Account Usage',
    }),
    node({
      id: 'RestrictionRule:Account.Hide_External',
      type: 'RestrictionRule',
      apiName: 'Account.Hide_External',
      label: 'Hide External',
      parentId: 'CustomObject:Account',
    }),
    node({
      id: 'FlexiPage:Account_Record_Page',
      type: 'FlexiPage',
      apiName: 'Account_Record_Page',
      label: 'Account Record Page',
    }),
    node({
      id: 'Profile:Standard User',
      type: 'Profile',
      apiName: 'Standard User',
      label: 'Standard User',
      properties: {
        layoutAssignments: [
          { layout: 'Account-Account Standard Layout', recordType: null },
        ],
      },
    }),
    node({
      id: 'PermissionSetGroup:Sales_Group',
      type: 'PermissionSetGroup',
      apiName: 'Sales_Group',
      label: 'Sales Group',
    }),
  ],
  edges: [
    {
      fromId: 'CustomField:Account.Industry',
      toId: 'CustomObject:Account',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'ci-fixture',
      properties: {},
    },
    {
      fromId: 'CustomField:Payment__c.Amount__c',
      toId: 'CustomObject:Payment__c',
      edgeType: 'parentOf',
      confidence: 'declared',
      source: 'ci-fixture',
      properties: {},
    },
    {
      fromId: 'Report:Account_Usage',
      toId: 'CustomField:Account.Industry',
      edgeType: 'references',
      confidence: 'heuristic',
      source: 'ci-fixture',
      properties: { referenceKind: 'fieldRef' },
    },
  ],
};

mkdirSync(p.meta, { recursive: true });
mkdirSync(dirname(p.graphDb), { recursive: true });

writeFileSync(
  p.config,
  JSON.stringify(
    {
      targetOrg: 'ci-eval',
      vaultRoot,
      version: '0.1.0',
      createdAt: '2026-05-29T00:00:00.000Z',
    },
    null,
    2,
  ),
);

writeFileSync(
  join(p.meta, 'manifest.json'),
  JSON.stringify(
    {
      version: '0.1.0',
      refreshedAt: '2026-05-29T00:00:00.000Z',
      sourceOrg: 'ci-eval',
      components: {
        CustomObject: 2,
        CustomField: 2,
        Report: 1,
        RestrictionRule: 1,
        FlexiPage: 1,
        Profile: 1,
        PermissionSetGroup: 1,
      },
      edges: { parentOf: 2, references: 1 },
      sourceTreeHash: 'sha256:ci-eval-fixture',
      coverageComputedAt: '2026-05-29T00:00:00.000Z',
      coverage,
    },
    null,
    2,
  ),
);

const opened = await openGraph(p.graphDb);
if (!opened.ok) {
  console.error(opened.error.message);
  process.exit(1);
}
const imported = await importExtractionResults(opened.value, [extraction]);
if (!imported.ok) {
  console.error(imported.error.message);
  process.exit(1);
}
await closeGraph(opened.value);
console.log(`CI vault written to ${vaultRoot}`);
