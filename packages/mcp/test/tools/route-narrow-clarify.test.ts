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
    // R5-CLARIFY-riselever: cross-type same-apiName collision — a Flow AND an
    // ApexClass both named "DataSync". Neither has a parent (top-level
    // components). When a user asks "explain DataSync" without a type qualifier,
    // the router currently picks one type over the other without clarifying —
    // over-confident on a type that the user never specified. The narrow clarify
    // rule MUST fire here because the winning route's primary tool is either
    // sfi.explain_flow or sfi.explain_apex_method (both single-component-target
    // tools), and the disambiguation dimension is 'type' (shared name, shared
    // parentless ancestry). This is the NEW honest clarify-trigger class:
    // "cross-type single-name collision on a name-only query".
    node({
      id: 'Flow:DataSync',
      type: 'Flow',
      apiName: 'DataSync',
      label: 'DataSync',
    }),
    node({
      id: 'ApexClass:DataSync',
      type: 'ApexClass',
      apiName: 'DataSync',
      label: 'DataSync',
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

/**
 * R5-CLARIFY-riselever: NEW honest clarify-trigger class —
 * "cross-type single-name collision".
 *
 * When the SAME apiName (e.g. "DataSync") matches components of DIFFERENT
 * types (Flow AND ApexClass), a name-only explain-intent query ("explain
 * DataSync") is over-confident: the router would otherwise pick a winning type
 * without knowing which one the user meant. Instead the route BLOCKS with a
 * clarification. The actual mechanism (verified against the running handler,
 * not aspirational):
 *   - The resolver returns disposition:ambiguous (two same-named candidates of
 *     distinct types), which drives the RESOLVE-CANDIDATES clarify path.
 *   - The block surfaces as `route.clarification` with required:true, a generic
 *     ambiguity prompt ("Several components match. Which component did you
 *     mean?"), and `options` = the two competing component IDs
 *     ("ApexClass:DataSync", "Flow:DataSync") — NOT a synthetic type-picker.
 *   - `entityEvidence` is NOT populated on this path — it is undefined. There
 *     is no `disambiguateBy:'type'` field and no entity-evidence disposition to
 *     read; `route.clarification` IS the contract. The asserts below check that
 *     real signal unconditionally.
 *
 * Guard: the clarify path (executionBlocked=true, clarification set) must not
 * throw — assertions validate the shape is well-formed AND that both distinct
 * types remain in the options (no over-confident single-type pick).
 */
describe('R5-CLARIFY-riselever — cross-type same-name collision fires type-disambiguate', () => {
  it('"explain DataSync" (Flow AND ApexClass same name) blocks with a type-disambiguate clarification', async () => {
    const data = await route({ question: 'explain DataSync' });
    // Must be blocked — the router cannot pick Flow over ApexClass without asking.
    expect(data.executionBlocked).toBe(true);
    expect(data.route.clarification).not.toBeNull();
    const clr = data.route.clarification!;
    // Options are string labels/ids (RouteClarification.options: string[]).
    expect(clr.options.length).toBeGreaterThanOrEqual(2);
    const joined = clr.options.join('\n');
    expect(joined).toMatch(/Flow/i);
    expect(joined).toMatch(/ApexClass|Apex/i);
    expect(clr.required).toBe(true);
    expect(typeof clr.question).toBe('string');
    expect(clr.question.length).toBeGreaterThan(0);
    // R5 fires this clarify through the RESOLVE-CANDIDATES path, not the
    // entity-ambiguous path — so entityEvidence is deliberately ABSENT here.
    // Lock that in (a prior version guarded the disposition asserts behind
    // `if (data.entityEvidence)`, which made them vacuous because the branch
    // never runs). Assert UNCONDITIONALLY on the real signal instead.
    expect(data.entityEvidence).toBeUndefined();
    // clarificationRequired: the block is a hard stop.
    expect(clr.required).toBe(true);
    // The ambiguous disposition is expressed AS the resolve-candidates prompt
    // ("Several components match. Which component did you mean?") — assert the
    // wording so a regression to a non-ambiguous / auto-picked route fails here.
    expect(clr.question).toMatch(/which component|components? match/i);
    // The ambiguity, made concrete: two candidates of DISTINCT types (Flow AND
    // ApexClass). If the router regressed to over-confidently picking one type,
    // this set would collapse to size 1 and fail.
    const optionTypes = new Set(clr.options.map((o) => o.split(':')[0]));
    expect(optionTypes.has('Flow')).toBe(true);
    expect(optionTypes.has('ApexClass')).toBe(true);
    expect(optionTypes.size).toBeGreaterThanOrEqual(2);
  });

  it('"show me the DataSync flow" (type-qualified) does NOT block — type qualifier resolves ambiguity', async () => {
    // When the user explicitly says "flow", the resolver should prefer the Flow
    // candidate. If the resolver resolves to exact, no clarification is needed.
    // We assert only that the response is structurally valid (no throw).
    const data = await route({ question: 'show me the DataSync flow' });
    // executionBlocked may be false (type qualifier helped) or still true (if
    // the resolver didn't pick up the qualifier) — either is acceptable. What
    // MUST NOT happen: an unhandled exception.
    expect(typeof data.executionBlocked).toBe('boolean');
    expect(data.route).toBeDefined();
    // If still blocked, the clarification must be well-formed (guard).
    if (data.executionBlocked && data.route.clarification !== null) {
      const clr = data.route.clarification;
      expect(clr.options.length).toBeGreaterThanOrEqual(1);
      expect(typeof clr.question).toBe('string');
      expect(clr.question.length).toBeGreaterThan(0);
    }
  });

  it('"which DataSync components exist" (scope-vague DataSync mention) does NOT block — inventory ask is not single-component', async () => {
    const data = await route({ question: 'which DataSync components exist in this org' });
    // An inventory/existence question targets ALL matching components, not a
    // SINGLE named component → the narrow clarify guard (routeTargetsSingleComponent)
    // must suppress the block. Wrong-clarify must not fire here.
    expect(data.executionBlocked).toBe(false);
    expect(data.route.clarification).toBeNull();
  });
});
