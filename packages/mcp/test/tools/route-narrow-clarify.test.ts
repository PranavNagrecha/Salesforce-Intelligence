/// <reference types="vitest/globals" />

/**
 * R4 NARROW CLARIFY (DIAGNOSIS-R4 §2.2). The narrow re-introduction rule fires
 * a clarification ONLY when resolve=ambiguous with ≥2 near-equal candidates
 * (top2/top1 ≥ 0.8) of DISTINCT components AND the winning route targets a
 * single named component AND no refuse-shape matched. Scope-vague turns (no
 * single-component target) stay untouched — that is the precision guard that
 * holds wrong-clarifies ≤87 (tripwire T6).
 *
 * Both directions are tested: entity-ambiguous FIRES; scope-vague does NOT.
 * SYNTHETIC fixture names only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  routeQuestionHandler,
  type RouteQuestionInput,
} from '../../src/tools/route-question.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-07-02T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:narrow-clarify-fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'apiName'>): Node => ({
  type: 'CustomObject',
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

// Two APEX CLASSES sharing the exact same bare name "ApplicationForm" (a
// controller vs a service) — a genuine entity ambiguity for a single-component
// intent (explain_apex_method / call_graph). This is the §2.1 "ApplicationForm
// class (controller vs service)" shape, synthetic.
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Account', apiName: 'Account', label: 'Account' }),
    node({
      id: 'ApexClass:ApplicationForm_Controller',
      type: 'ApexClass',
      apiName: 'ApplicationForm',
      label: 'ApplicationForm Controller',
    }),
    node({
      id: 'ApexClass:ApplicationForm_Service',
      type: 'ApexClass',
      apiName: 'ApplicationForm',
      label: 'ApplicationForm Service',
    }),
    // Two same-named Concentration__c fields on different objects (a
    // single-component field intent), for the field-ambiguity direction.
    node({
      id: 'CustomField:Account.Concentration__c',
      type: 'CustomField',
      apiName: 'Concentration__c',
      label: 'Concentration',
      parentId: 'CustomObject:Account',
    }),
    node({
      id: 'CustomField:Contact.Concentration__c',
      type: 'CustomField',
      apiName: 'Concentration__c',
      label: 'Concentration',
      parentId: 'CustomObject:Contact',
    }),
    node({ id: 'CustomObject:Contact', apiName: 'Contact', label: 'Contact' }),
    // A field with a UNIQUE name — a scope/audit ask over it must NOT clarify.
    node({
      id: 'CustomField:Account.SsnValue__c',
      type: 'CustomField',
      apiName: 'SsnValue__c',
      label: 'SSN',
      parentId: 'CustomObject:Account',
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-narrow-clarify-'));
  const opened = await openGraph(join(tempDir, 'nc.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

const route = async (input: RouteQuestionInput) => {
  const r = await routeQuestionHandler(ctx, input);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.data;
};

describe('R4 narrow clarify — entity-ambiguous on a single-component intent FIRES', () => {
  it('"explain the ApplicationForm class" (2 same-named apex classes) blocks with a clarification', async () => {
    const data = await route({ question: 'explain the ApplicationForm class' });
    expect(data.executionBlocked).toBe(true);
    expect(data.route.clarification?.required).toBe(true);
    // Options are the resolve candidates (both distinct apex classes), never
    // invented.
    const opts = data.route.clarification?.options ?? [];
    expect(opts).toContain('ApexClass:ApplicationForm_Controller');
    expect(opts).toContain('ApexClass:ApplicationForm_Service');
    expect(data.entityEvidence?.disposition).toBe('ambiguous');
    expect(data.entityEvidence?.clarificationRequired).toBe(true);
  });
});

describe('R4 narrow clarify — scope-vague does NOT fire', () => {
  it('"audit the sensitive fields" (no single entity) never blocks on a clarification', async () => {
    const data = await route({ question: 'audit the sensitive fields' });
    expect(data.executionBlocked).toBe(false);
    expect(data.route.clarification).toBeNull();
  });

  it('"which fields hold financial data" (scope-vague) never blocks', async () => {
    const data = await route({ question: 'which fields hold financial data across the org' });
    expect(data.executionBlocked).toBe(false);
    expect(data.route.clarification).toBeNull();
  });

  it('a UNIQUELY-named field over a scope/audit intent routes clean (no false clarify)', async () => {
    const data = await route({ question: 'who can edit the SsnValue__c field' });
    // Unique name → exact resolve → routes; never a clarification block.
    expect(data.executionBlocked).toBe(false);
    expect(data.route.clarification).toBeNull();
  });
});
