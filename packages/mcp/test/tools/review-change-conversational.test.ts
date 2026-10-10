/// <reference types="vitest/globals" />

/**
 * WOW-6 — "what's risky in this deployment?" answerable from chat.
 *
 * `sfi.review_change` used to accept ONLY hand-assembled
 * `{ type, apiName, changeKind }` rows; the package.xml / git-diff parsing
 * lived in the CLI, so a host LLM holding a manifest or a file list had to
 * re-implement it. These tests pin the conversational inputs (package.xml,
 * destructiveChanges.xml, source paths, bare names, defaulted change kinds),
 * the honesty of what is NOT reviewed, the composed automation collisions, and
 * the derived go / no-go decision. Every fixture is synthetic.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CoverageEntry,
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  deriveComponentFromPath,
  parseManifestComponents,
  parseSourcePathEntries,
} from '../../src/tools/change-set-input.js';
import { reviewChangeHandler, reviewChangeInputSchema } from '../../src/tools/review-change.js';
import { dispatchTool } from '../../src/tools/tool-dispatch.js';

const covered = (type: string): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 1,
  errored: false,
  neverModeled: false,
});
const FAMILIES = [
  'ApexClass', 'ApexTrigger', 'CustomField', 'Flow', 'CustomObject', 'Profile',
  'PermissionSet', 'LightningComponentBundle', 'AuraDefinitionBundle', 'VisualforcePage',
  'VisualforceComponent', 'ValidationRule', 'WorkflowRule', 'Layout', 'FlexiPage',
  'QuickAction', 'Report', 'Dashboard', 'ReportType', 'ListView', 'EmailTemplate',
  'ApprovalProcess', 'AssignmentRule', 'AutoResponseRule', 'EscalationRule', 'SharingRule',
  'OmniDataTransform', 'OmniIntegrationProcedure', 'OmniScript', 'OmniUiCard',
  'CustomMetadataRecord', 'WebLink', 'RestrictionRule', 'ScopingRule', 'CustomSite',
  'CustomTab', 'CustomApplication', 'RecordType', 'CompactLayout', 'CustomPermission',
  'DuplicateRule', 'MatchingRule',
];

const manifest: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-review-change-chat',
  coverage: FAMILIES.map(covered),
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
};

const node = (id: string, props: Record<string, unknown> = {}): Node => {
  const idx = id.indexOf(':');
  return {
    id,
    type: id.slice(0, idx) as Node['type'],
    apiName: id.slice(idx + 1),
    label: null,
    parentId: null,
    sourcePath: 'unused',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: props,
  };
};
/** A node built from a real-looking source file (vault-relative, as stored). */
const nodeAt = (id: string, sourcePath: string, props: Record<string, unknown> = {}): Node => ({
  ...node(id, props),
  sourcePath,
});
const edge = (
  fromId: string,
  toId: string,
  edgeType: Edge['edgeType'],
  properties: Record<string, unknown> = {},
  confidence: Edge['confidence'] = 'declared',
): Edge => ({ fromId, toId, edgeType, confidence, source: 'unit-test', properties });

// Synthetic org:
//   ShopService      ← ShopController (callsApex) ← ShopServiceTest covers both
//   IdleService      — isolated
//   Widget__c.Level__c ← LevelFlowA / LevelFlowB (both write it: a collision)
//   LevelFlowA / LevelFlowB triggersOn Widget__c (after-save, Active)
//   Gadget__c.Spare__c — no dependents
//   Gadget__c.Code__c and Widget__c.Code__c — same bare name on two objects
const SEED: ExtractionResult = {
  nodes: [
    node('ApexClass:ShopService', { isTest: false }),
    node('ApexClass:ShopController', { isTest: false }),
    node('ApexClass:ShopServiceTest', { isTest: true }),
    node('ApexClass:IdleService', { isTest: false }),
    node('CustomObject:Widget__c'),
    node('CustomObject:Gadget__c'),
    node('CustomField:Widget__c.Level__c'),
    node('CustomField:Gadget__c.Spare__c'),
    node('CustomField:Gadget__c.Code__c'),
    node('CustomField:Widget__c.Code__c'),
    node('Flow:LevelFlowA', { status: 'Active', triggerType: 'RecordAfterSave' }),
    node('Flow:LevelFlowB', { status: 'Active', triggerType: 'RecordAfterSave' }),
    node('ValidationRule:Widget__c.Gate_Rule', { active: true }),
    // Families whose file name is NOT `{ApiName}.{ext}` — the vault id must
    // come from the node built from that file, not from cutting the name.
    nodeAt('QuickAction:Widget__c.Send_Note', 'source/quickActions/Widget__c.Send_Note.quickAction-meta.xml'),
    nodeAt('Layout:Widget__c.Widget Layout', 'source/layouts/Widget__c-Widget Layout.layout-meta.xml'),
    nodeAt('VisualforcePage:KeepPage', 'source/pages/KeepPage.page'),
    nodeAt('CustomSite:Portal', 'source/sites/Portal.site-meta.xml'),
    nodeAt('CustomMetadataRecord:Rate_Card.Default', 'source/customMetadata/Rate_Card.Default.md-meta.xml'),
    nodeAt('Report:Sales_Folder/Pipeline_View', 'source/reports/Sales_Folder/Pipeline_View.report-meta.xml'),
    nodeAt('PathAssistant:Widget__c.Widget_Path', 'source/pathAssistants/Widget_Path.pathAssistant-meta.xml'),
    nodeAt('SharingRule:Widget__c.Share_A', 'source/sharingRules/Widget__c.sharingRules-meta.xml'),
    nodeAt('SharingRule:Widget__c.Share_B', 'source/sharingRules/Widget__c.sharingRules-meta.xml'),
    nodeAt('SecuritySettings:default', 'source/settings/Security.settings-meta.xml'),
  ],
  edges: [
    edge('ApexClass:ShopController', 'ApexClass:ShopService', 'callsApex'),
    edge('ApexClass:ShopServiceTest', 'ApexClass:ShopService', 'callsApex'),
    edge('ApexClass:ShopServiceTest', 'ApexClass:ShopController', 'callsApex'),
    edge('CustomObject:Widget__c', 'CustomField:Widget__c.Level__c', 'parentOf'),
    edge('CustomObject:Gadget__c', 'CustomField:Gadget__c.Spare__c', 'parentOf'),
    edge('CustomObject:Widget__c', 'ValidationRule:Widget__c.Gate_Rule', 'parentOf'),
    edge('Flow:LevelFlowA', 'CustomObject:Widget__c', 'triggersOn', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Flow:LevelFlowB', 'CustomObject:Widget__c', 'triggersOn', {
      recordTriggerType: 'Update',
      triggerType: 'RecordAfterSave',
    }),
    edge('Layout:Widget__c.Widget Layout', 'QuickAction:Widget__c.Send_Note', 'references'),
    edge('CustomSite:Portal', 'VisualforcePage:KeepPage', 'references'),
    edge('Flow:LevelFlowA', 'CustomField:Widget__c.Level__c', 'writesTo', { operation: 'recordUpdate' }, 'parsed'),
    edge('Flow:LevelFlowB', 'CustomField:Widget__c.Level__c', 'writesTo', { operation: 'recordUpdate' }, 'parsed'),
  ],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-review-change-chat-'));
  const opened = await openGraph(join(dir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: dir, manifest, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

/** Parse through the schema (as dispatch does), then run the handler. */
const review = async (args: Record<string, unknown>) => {
  const parsed = reviewChangeInputSchema.safeParse(args);
  if (!parsed.success) throw new Error(parsed.error.message);
  return reviewChangeHandler(ctx, parsed.data);
};

const PACKAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>ShopService</members><members>IdleService</members><name>ApexClass</name></types>
  <types><members>*</members><name>Layout</name></types>
  <version>60.0</version>
</Package>`;

const DESTRUCTIVE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>Widget__c.Level__c</members><name>CustomField</name></types>
</Package>`;

describe('change-set parsing (shared with the CLI)', () => {
  it('a destructiveChanges body yields deletions; a non-manifest body is flagged, not empty-as-none', () => {
    const d = parseManifestComponents(DESTRUCTIVE_XML, 'deleted');
    expect(d.components).toEqual([
      { type: 'CustomField', apiName: 'Widget__c.Level__c', changeKind: 'deleted' },
    ]);
    expect(parseManifestComponents('<NotAPackage/>').notAManifest).toBe(true);
  });

  it('source paths: git status letters, bundle files collapse, non-metadata paths are named', () => {
    const r = parseSourcePathEntries([
      'D\tforce-app/main/default/classes/ShopService.cls',
      'D\tforce-app/main/default/classes/ShopService.cls-meta.xml',
      'M\tforce-app/main/default/classes/IdleService.cls-meta.xml',
      'M force-app/main/default/objects/Widget__c/fields/Level__c.field-meta.xml',
      'force-app/main/default/lwc/shopCard/shopCard.js',
      'force-app/main/default/lwc/shopCard/shopCard.html',
      'README.md',
    ]);
    expect(r.components).toEqual([
      {
        type: 'ApexClass',
        apiName: 'ShopService',
        changeKind: 'deleted',
        sourcePath: 'force-app/main/default/classes/ShopService.cls',
      },
      // A sidecar-only change (an API-version bump) is a change to its class,
      // and points at the class file the vault built the node from.
      {
        type: 'ApexClass',
        apiName: 'IdleService',
        changeKind: 'modified',
        sourcePath: 'force-app/main/default/classes/IdleService.cls',
      },
      {
        type: 'CustomField',
        apiName: 'Widget__c.Level__c',
        changeKind: 'modified',
        sourcePath: 'force-app/main/default/objects/Widget__c/fields/Level__c.field-meta.xml',
      },
      { type: 'LightningComponentBundle', apiName: 'shopCard', changeKind: 'modified' },
    ]);
    expect(r.skippedPaths).toEqual(['README.md']);
  });
});

describe('review_change — conversational inputs (WOW-6)', () => {
  it('rejects a call with no change set at all, naming every accepted input', () => {
    const r = reviewChangeInputSchema.safeParse({});
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.message).toMatch(/packageXml/);
    expect(r.error.message).toMatch(/sourcePaths/);
  });

  it('reviews a package.xml body + destructiveChanges body, and discloses the wildcard it did not review', async () => {
    const r = await review({ packageXml: PACKAGE_XML, destructiveChangesXml: DESTRUCTIVE_XML });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.reviewed.map((x) => `${x.id}/${x.changeKind}`);
    expect(ids).toContain('ApexClass:ShopService/modified');
    expect(ids).toContain('CustomField:Widget__c.Level__c/deleted');
    const del = r.value.data.reviewed.find((x) => x.id === 'CustomField:Widget__c.Level__c');
    expect(del?.verdict).toBe('blocking');
    expect(r.value.data.inputResolution?.wildcardTypes).toEqual(['Layout']);
    expect(r.value.data.inputResolution?.sources).toMatchObject({ packageXml: 2, destructiveChangesXml: 1 });
    expect(r.value.data.deployDecision.decision).toBe('no-go');
    expect(r.value.data.deployDecision.reasons.join(' ')).toMatch(/Widget__c\.Level__c/);
    expect(r.value.data.deployDecision.reasons.join(' ')).toMatch(/wildcard/);
  });

  it('reviews source paths (a deletion via a git status line)', async () => {
    const r = await review({
      sourcePaths: ['D\tforce-app/main/default/classes/ShopService.cls'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]).toMatchObject({
      id: 'ApexClass:ShopService',
      changeKind: 'deleted',
      verdict: 'blocking',
    });
  });

  it('bare names resolve on an EXACT api name only; an ambiguous name is disclosed, never guessed', async () => {
    const r = await review({ components: ['ShopService', 'Code__c', 'ShopServic'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed.map((x) => x.id)).toEqual(['ApexClass:ShopService']);
    const unresolved = r.value.data.inputResolution?.unresolved ?? [];
    const amb = unresolved.find((u) => u.input === 'Code__c');
    expect(amb?.reason).toBe('ambiguous');
    expect(amb?.candidates).toEqual(
      expect.arrayContaining(['CustomField:Gadget__c.Code__c', 'CustomField:Widget__c.Code__c']),
    );
    expect(unresolved.find((u) => u.input === 'ShopServic')?.reason).toBe('not-found');
    // Two names were not reviewed, so the decision can never be `go`.
    expect(r.value.data.deployDecision.decision).not.toBe('go');
  });

  it('a row with no changeKind defaults to modified AND is counted, so a hidden delete is not a silent go', async () => {
    const r = await review({ components: ['ApexClass:IdleService'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
    expect(r.value.data.inputResolution?.changeKindDefaulted).toBe(1);
    expect(r.value.data.deployDecision.decision).toBe('review-first');
    expect(r.value.data.deployDecision.reasons.join(' ')).toMatch(/no change kind was given/);
  });

  it('an explicit deletion beats a package.xml listing of the same component', async () => {
    const r = await review({
      packageXml: PACKAGE_XML,
      components: [{ componentId: 'ApexClass:ShopService', changeKind: 'deleted' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.value.data.reviewed.find((x) => x.id === 'ApexClass:ShopService');
    expect(row?.changeKind).toBe('deleted');
    expect(r.value.data.inputResolution?.duplicatesMerged).toBe(1);
  });

  it('corrects api-name casing to the vault id instead of reporting not-in-vault', async () => {
    const r = await review({
      components: [{ type: 'ApexClass', apiName: 'shopservice', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.id).toBe('ApexClass:ShopService');
    expect(r.value.data.reviewed[0]?.inVault).toBe(true);
    expect(r.value.data.inputResolution?.recased).toBe(1);
  });

  it('nothing reviewable is an invalid-query naming why, never an empty "safe" review', async () => {
    const r = await review({ sourcePaths: ['README.md', 'docs/notes.txt'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/not deployable metadata/);
  });

  it('composes automation collisions that involve a changed component', async () => {
    const r = await review({
      components: [{ componentId: 'Flow:LevelFlowA', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const col = r.value.data.automationCollisions;
    expect(col?.objects[0]?.objectId).toBe('CustomObject:Widget__c');
    const f = col?.objects[0]?.involvingChange[0];
    expect(f?.kind).toBe('field-write-collision');
    expect(f?.fieldId).toBe('CustomField:Widget__c.Level__c');
    expect(f?.automations).toEqual(expect.arrayContaining(['Flow:LevelFlowA', 'Flow:LevelFlowB']));
    expect(r.value.data.deployDecision.reasons.join(' ')).toMatch(/collision/);
    // Opt-out keeps the section out of the response.
    const off = await review({
      components: [{ componentId: 'Flow:LevelFlowA', changeKind: 'modified' }],
      includeCollisions: false,
    });
    expect(off.ok && off.value.data.automationCollisions).toBeUndefined();
  });

  it('a fully safe, fully explicit change set is a `go` with no inputResolution block', async () => {
    const r = await review({
      components: [{ type: 'CustomField', apiName: 'Gadget__c.Spare__c', changeKind: 'modified' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.verdict).toBe('safe');
    expect(r.value.data.deployDecision.decision).toBe('go');
    expect(r.value.data.inputResolution).toBeUndefined();
  });

  it('a zero-dependent blocker (live save-time automation) names WHY in the decision, not "0 dependents"', async () => {
    const r = await review({
      destructiveChangesXml:
        '<Package><types><members>Widget__c.Gate_Rule</members><name>ValidationRule</name></types></Package>',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.deployDecision.decision).toBe('no-go');
    const reasons = r.value.data.deployDecision.reasons.join(' ');
    expect(reasons).toMatch(/Active ValidationRule/);
    expect(reasons).not.toMatch(/\(0 dependent/);
  });

  it('is reachable through dispatch with only a package.xml (the chat path)', async () => {
    const res = await dispatchTool(ctx, 'sfi.review_change', { packageXml: PACKAGE_XML });
    const text = (res.content[0] as { text: string }).text;
    const body = JSON.parse(text) as { data?: { deployDecision?: { decision: string } } };
    expect(body.data?.deployDecision?.decision).toBeDefined();
  });
});

// ===========================================================================
// Fix pass — the gate must never under-call what it was handed
// ===========================================================================

const SRC = 'force-app/main/default';

describe('change-set parsing — names that are not `{ApiName}.{ext}`', () => {
  it('derives dotted, hyphenated and foldered names from the file name, not the first dot', () => {
    expect(deriveComponentFromPath(`${SRC}/quickActions/Widget__c.Send_Note.quickAction-meta.xml`)).toEqual({
      type: 'QuickAction',
      apiName: 'Widget__c.Send_Note',
    });
    expect(deriveComponentFromPath(`${SRC}/customMetadata/Rate_Card.Default.md-meta.xml`)).toEqual({
      type: 'CustomMetadataRecord',
      apiName: 'Rate_Card.Default',
    });
    expect(deriveComponentFromPath(`${SRC}/layouts/Widget__c-Widget Layout.layout-meta.xml`)).toEqual({
      type: 'Layout',
      apiName: 'Widget__c.Widget Layout',
    });
    expect(deriveComponentFromPath(`${SRC}/reports/Parent/Sales_Folder/Pipeline_View.report-meta.xml`)).toEqual({
      type: 'Report',
      apiName: 'Sales_Folder/Pipeline_View',
    });
    expect(deriveComponentFromPath(`${SRC}/email/Notices/Welcome.email`)).toEqual({
      type: 'EmailTemplate',
      apiName: 'Notices.Welcome',
    });
    expect(deriveComponentFromPath(`${SRC}/staticresources/SiteKit/maintenance.html`)).toEqual({
      type: 'StaticResource',
      apiName: 'SiteKit',
    });
  });

  it('a container file, unmodelled metadata and project files are each named, never invented ids', () => {
    const r = parseSourcePathEntries([
      `M ${SRC}/sharingRules/Widget__c.sharingRules-meta.xml`,
      `M ${SRC}/labels/CustomLabels.labels-meta.xml`,
      `M ${SRC}/settings/Language.settings-meta.xml`,
      'M README.md',
      `M ${SRC}/lwc/shopCard/__tests__/shopCard.test.js`,
    ]);
    expect(r.components).toEqual([]);
    expect(r.unreviewable).toEqual([
      expect.objectContaining({ input: `${SRC}/sharingRules/Widget__c.sharingRules-meta.xml`, reason: 'container', containerType: 'SharingRule' }),
      expect.objectContaining({ input: `${SRC}/labels/CustomLabels.labels-meta.xml`, reason: 'container', containerType: 'CustomLabel' }),
      expect.objectContaining({ input: `${SRC}/settings/Language.settings-meta.xml`, reason: 'not-modeled' }),
    ]);
    expect(r.skippedPaths).toEqual(['README.md', `${SRC}/lwc/shopCard/__tests__/shopCard.test.js`]);
  });

  it('a rename reviews the OLD component as deleted and the NEW one as added', () => {
    const r = parseSourcePathEntries([`R100\t${SRC}/classes/ShopService.cls\t${SRC}/classes/ShopService2.cls`]);
    expect(r.components.map((c) => `${c.type}:${c.apiName}/${c.changeKind}`)).toEqual([
      'ApexClass:ShopService/deleted',
      'ApexClass:ShopService2/added',
    ]);
  });

  it('a file deleted inside a bundle modifies the bundle; only an all-deleted bundle is deleted', () => {
    const partial = parseSourcePathEntries([
      `D ${SRC}/lwc/shopCard/shopCard.css`,
      `M ${SRC}/lwc/shopCard/shopCard.js`,
    ]);
    expect(partial.components).toEqual([
      { type: 'LightningComponentBundle', apiName: 'shopCard', changeKind: 'modified' },
    ]);
    const whole = parseSourcePathEntries([
      `D ${SRC}/lwc/shopCard/shopCard.css`,
      `D ${SRC}/lwc/shopCard/shopCard.js`,
    ]);
    expect(whole.components[0]?.changeKind).toBe('deleted');
  });

  it('manifest names map through the inverse of export_manifest’s table (ApexPage, ApexComponent, CustomMetadata, Layout, Settings)', () => {
    const r = parseManifestComponents(
      `<Package>
        <types><members>KeepPage</members><name>ApexPage</name></types>
        <types><members>Banner</members><name>ApexComponent</name></types>
        <types><members>Rate_Card.Default</members><name>CustomMetadata</name></types>
        <types><members>Widget__c-Widget Layout</members><name>Layout</name></types>
        <types><members>Security</members><members>Language</members><name>Settings</name></types>
        <types><members>Widget__c</members><name>SharingRules</name></types>
        <types><members>Widget__c.Share_A</members><name>SharingCriteriaRule</name></types>
      </Package>`,
    );
    expect(r.components.map((c) => `${c.type}:${c.apiName}`)).toEqual([
      'VisualforcePage:KeepPage',
      'VisualforceComponent:Banner',
      'CustomMetadataRecord:Rate_Card.Default',
      'Layout:Widget__c.Widget Layout',
      'SecuritySettings:default',
      'SessionSettings:default',
      'SharingRule:Widget__c.Share_A',
    ]);
    expect(r.unreviewable).toEqual([
      expect.objectContaining({ input: 'Settings:Language', reason: 'not-modeled' }),
      expect.objectContaining({ input: 'SharingRules:Widget__c', reason: 'container', containerType: 'SharingRule' }),
    ]);
  });
});

describe('review_change — fix pass (deploy gate honesty)', () => {
  it('a changed metadata file the vault does not model keeps the decision off `go` (was: go)', async () => {
    const r = await review({
      sourcePaths: [
        `M ${SRC}/settings/Language.settings-meta.xml`,
        `M ${SRC}/objects/Gadget__c/fields/Spare__c.field-meta.xml`,
        'M README.md',
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed.map((x) => x.verdict)).toEqual(['safe']);
    expect(r.value.data.deployDecision.decision).toBe('review-first');
    const unresolved = r.value.data.inputResolution?.unresolved ?? [];
    expect(unresolved).toEqual([
      expect.objectContaining({ input: `${SRC}/settings/Language.settings-meta.xml`, reason: 'not-modeled' }),
    ]);
    expect(r.value.data.deployDecision.reasons.join(' ')).toMatch(/NOT reviewed \(1 not-modeled/);
    // A README is disclosed but does not block.
    expect(r.value.data.inputResolution?.skippedPaths).toEqual(['README.md']);
  });

  it('a deleted QuickAction source file maps to the vault id and is BLOCKING (was: not in vault, review-first)', async () => {
    const r = await review({ sourcePaths: [`D ${SRC}/quickActions/Widget__c.Send_Note.quickAction-meta.xml`] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]).toMatchObject({
      id: 'QuickAction:Widget__c.Send_Note',
      inVault: true,
      verdict: 'blocking',
    });
    expect(r.value.data.deployDecision.decision).toBe('no-go');
  });

  it('every in-vault family resolves to the node built from that file (layout, CMDT, report, path assistant)', async () => {
    const r = await review({
      sourcePaths: [
        `M ${SRC}/layouts/Widget__c-Widget Layout.layout-meta.xml`,
        `M ${SRC}/customMetadata/Rate_Card.Default.md-meta.xml`,
        `M ${SRC}/reports/Sales_Folder/Pipeline_View.report-meta.xml`,
        // The id's object comes from INSIDE the file — no name rule can derive it.
        `M ${SRC}/pathAssistants/Widget_Path.pathAssistant-meta.xml`,
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = r.value.data.reviewed;
    expect(rows.map((x) => x.id).sort()).toEqual([
      'CustomMetadataRecord:Rate_Card.Default',
      'Layout:Widget__c.Widget Layout',
      'PathAssistant:Widget__c.Widget_Path',
      'Report:Sales_Folder/Pipeline_View',
    ]);
    expect(rows.every((x) => x.inVault)).toBe(true);
  });

  it('a destructiveChanges ApexPage member is the VisualforcePage it deletes, and blocks (was: not in vault)', async () => {
    const r = await review({
      destructiveChangesXml: '<Package><types><members>KeepPage</members><name>ApexPage</name></types></Package>',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]).toMatchObject({ id: 'VisualforcePage:KeepPage', verdict: 'blocking' });
    expect(r.value.data.deployDecision.decision).toBe('no-go');
  });

  it('a container member is disclosed with what it holds; a DELETED container reviews every component in it', async () => {
    const xml = '<Package><types><members>Widget__c</members><name>SharingRules</name></types></Package>';
    const modified = await review({
      packageXml: xml,
      components: [{ type: 'CustomField', apiName: 'Gadget__c.Spare__c', changeKind: 'modified' }],
    });
    expect(modified.ok).toBe(true);
    if (!modified.ok) return;
    const u = modified.value.data.inputResolution?.unresolved[0];
    expect(u).toMatchObject({ input: 'SharingRules:Widget__c', reason: 'container', componentsInVault: 2 });
    expect(modified.value.data.deployDecision.decision).toBe('review-first');

    const deleted = await review({ destructiveChangesXml: xml });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.value.data.reviewed.map((x) => `${x.id}/${x.changeKind}`).sort()).toEqual([
      'SharingRule:Widget__c.Share_A/deleted',
      'SharingRule:Widget__c.Share_B/deleted',
    ]);
    expect(deleted.value.data.inputResolution?.containersExpanded).toBe(1);

    const viaPath = await review({ sourcePaths: [`D ${SRC}/sharingRules/Widget__c.sharingRules-meta.xml`] });
    expect(viaPath.ok && viaPath.value.data.reviewed.length).toBe(2);
  });

  it('new Apex no test reaches is never `go` (was: go, "run the 0 selected tests")', async () => {
    const r = await review({
      sourcePaths: [
        `A ${SRC}/triggers/NewWidgetTrigger.trigger`,
        `A ${SRC}/triggers/NewWidgetTrigger.trigger-meta.xml`,
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed).toHaveLength(1);
    expect(r.value.data.reviewed[0]).toMatchObject({
      id: 'ApexTrigger:NewWidgetTrigger',
      changeKind: 'added',
      testCoverage: 'uncovered',
    });
    expect(r.value.data.deployDecision.decision).toBe('review-first');
    expect(r.value.data.deployDecision.reasons.join(' ')).toMatch(/added Apex .*NewWidgetTrigger/);
  });

  it('a rename names the old component too, so its dependents are not silently dropped', async () => {
    const r = await review({
      sourcePaths: [`R100\t${SRC}/classes/ShopService.cls\t${SRC}/classes/ShopService2.cls`],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const old = r.value.data.reviewed.find((x) => x.id === 'ApexClass:ShopService');
    expect(old).toMatchObject({ changeKind: 'deleted', verdict: 'blocking' });
    expect(r.value.data.deployDecision.decision).toBe('no-go');
  });

  it('object-qualifying a bare nested name is disclosed as `qualified`, not as a casing fix', async () => {
    const r = await review({ components: [{ type: 'CustomField', apiName: 'Spare__c', changeKind: 'modified' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed[0]?.id).toBe('CustomField:Gadget__c.Spare__c');
    expect(r.value.data.inputResolution).toMatchObject({ qualified: 1, recased: 0 });
  });

  it('a bare Report leaf name resolves to its one foldered id', async () => {
    const r = await review({ components: [{ name: 'Pipeline_View', changeKind: 'modified' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.reviewed.map((x) => x.id)).toEqual(['Report:Sales_Folder/Pipeline_View']);
  });

  it('opting out of the collision check is a stated reason, not a silent `go`', async () => {
    const r = await review({
      components: [{ type: 'CustomField', apiName: 'Gadget__c.Spare__c', changeKind: 'modified' }],
      includeCollisions: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.deployDecision.decision).toBe('review-first');
    expect(r.value.data.deployDecision.reasons.join(' ')).toMatch(/includeCollisions: false/);
  });
});
