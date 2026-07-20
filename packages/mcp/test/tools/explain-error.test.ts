/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  detectStatusCode,
  explainErrorHandler,
  explainErrorInputSchema,
  extractValidationMessage,
  looksLikeDuplicate,
  parseApexStackFrame,
  parseFlowFault,
} from '../../src/tools/explain-error.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'declared', source: 'unit-test', properties: {}, ...o,
});

// Fixtures shaped like real graph rows produced by the extractors.
const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Opportunity', type: 'CustomObject', apiName: 'Opportunity' }),
    node({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact' }),
    // ValidationRule (validation-rule.ts shape: errorMessage/errorConditionFormula/active).
    node({
      id: 'ValidationRule:Opportunity.Require_Close_Date',
      type: 'ValidationRule',
      apiName: 'Require_Close_Date',
      label: 'Require_Close_Date',
      parentId: 'CustomObject:Opportunity',
      properties: {
        errorMessage: 'You must enter a close date before saving.',
        errorConditionFormula: 'ISBLANK(CloseDate)',
        active: true,
      },
    }),
    // An INACTIVE rule that reuses a similar message on a different object.
    node({
      id: 'ValidationRule:Contact.Block_Blank_Email',
      type: 'ValidationRule',
      apiName: 'Block_Blank_Email',
      label: 'Block_Blank_Email',
      parentId: 'CustomObject:Contact',
      properties: {
        errorMessage: 'Email is required for active contacts.',
        errorConditionFormula: 'AND(Active__c, ISBLANK(Email))',
        active: false,
      },
    }),
    // Flow (flow.ts shape: status/triggerObject/actionCalls).
    node({
      id: 'Flow:Opportunity_After_Save',
      type: 'Flow',
      apiName: 'Opportunity_After_Save',
      label: 'Opportunity After Save',
      properties: {
        status: 'Active',
        triggerObject: 'Opportunity',
        actionCalls: [{ actionType: 'apex', actionName: 'Notify_Owner' }],
      },
    }),
    // Apex class + trigger.
    node({ id: 'ApexClass:AccountService', type: 'ApexClass', apiName: 'AccountService' }),
    node({
      id: 'ApexTrigger:OpportunityTrigger',
      type: 'ApexTrigger',
      apiName: 'OpportunityTrigger',
      properties: { triggerObject: 'Opportunity', status: 'Active' },
    }),
    // DuplicateRule (duplicate-rule.ts shape: isActive/alertText).
    node({
      id: 'DuplicateRule:Contact.Standard_Contact',
      type: 'DuplicateRule',
      apiName: 'Contact.Standard_Contact',
      label: 'Standard Contact Duplicate Rule',
      parentId: 'CustomObject:Contact',
      properties: { isActive: true, alertText: 'Use one of these records?' },
    }),
    node({
      id: 'DuplicateRule:Contact.Inactive_Rule',
      type: 'DuplicateRule',
      apiName: 'Contact.Inactive_Rule',
      label: 'Inactive Rule',
      parentId: 'CustomObject:Contact',
      properties: { isActive: false, alertText: 'x' },
    }),
  ],
  edges: [
    edge({ fromId: 'ApexTrigger:OpportunityTrigger', toId: 'CustomObject:Opportunity', edgeType: 'triggersOn' }),
    edge({ fromId: 'Flow:Opportunity_After_Save', toId: 'CustomObject:Opportunity', edgeType: 'triggersOn' }),
  ],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-explain-error-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('explain_error — pure parsers', () => {
  it('detectStatusCode finds the FCVE code and the leading code in a chain', () => {
    expect(detectStatusCode('FIELD_CUSTOM_VALIDATION_EXCEPTION, nope: [X]')).toBe(
      'FIELD_CUSTOM_VALIDATION_EXCEPTION',
    );
    expect(detectStatusCode('REQUIRED_FIELD_MISSING, Required fields are missing: [Name]')).toBe(
      'REQUIRED_FIELD_MISSING',
    );
    expect(detectStatusCode('just a plain message')).toBeNull();
  });

  it('extractValidationMessage strips the FCVE prefix and the [Field] suffix', () => {
    const s = 'System.DmlException: Insert failed. First exception on row 0; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, You must enter a close date before saving.: [CloseDate]';
    expect(extractValidationMessage(s)).toBe('You must enter a close date before saving.');
  });

  it('extractValidationMessage returns the whole text for a bare message (no status code)', () => {
    expect(extractValidationMessage('  You must enter a close date before saving.  ')).toBe(
      'You must enter a close date before saving.',
    );
  });

  it('extractValidationMessage returns null for a non-FCVE status code (not a VR message)', () => {
    expect(extractValidationMessage('REQUIRED_FIELD_MISSING, Required fields: [Name]')).toBeNull();
  });

  it('parseFlowFault reads Flow API Name and element', () => {
    const s = 'An error occurred at element Create_Task (FlowRecordCreate).\nFlow API Name: Opportunity_After_Save';
    expect(parseFlowFault(s)).toEqual({
      flowApiName: 'Opportunity_After_Save',
      elementName: 'Create_Task',
    });
    expect(parseFlowFault('plain validation text')).toBeNull();
  });

  it('parseApexStackFrame reads class.method:line and trigger and system exception', () => {
    expect(parseApexStackFrame('Class.AccountService.doWork: line 42, column 1')).toEqual({
      className: 'AccountService', methodName: 'doWork', triggerName: null, line: 42, systemException: null,
    });
    expect(parseApexStackFrame('Trigger.OpportunityTrigger: line 7, column 1')?.triggerName).toBe('OpportunityTrigger');
    expect(parseApexStackFrame('caused by: System.NullPointerException')?.systemException).toBe('NullPointerException');
    expect(parseApexStackFrame('no apex here')).toBeNull();
  });

  it('looksLikeDuplicate recognizes duplicate phrasing', () => {
    expect(looksLikeDuplicate('DUPLICATES_DETECTED, Use one of these records?')).toBe(true);
    expect(looksLikeDuplicate('a possible duplicate was found')).toBe(true);
    expect(looksLikeDuplicate('nothing here')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strategy: validation rule
// ---------------------------------------------------------------------------

describe('explain_error — validation-rule strategy', () => {
  it('exact message match is a declared-grade matched disposition with the rule id + formula', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'FIELD_CUSTOM_VALIDATION_EXCEPTION, You must enter a close date before saving.: [CloseDate]',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).toBe('matched');
    expect(d.detectedStatusCode).toBe('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    expect(d.candidates[0]?.componentId).toBe('ValidationRule:Opportunity.Require_Close_Date');
    expect(d.candidates[0]?.confidence).toBe('declared');
    expect(d.candidates[0]?.matchKind).toBe('exact');
    expect(d.candidates[0]?.active).toBe(true);
    expect(d.candidates[0]?.detail['errorConditionFormula']).toBe('ISBLANK(CloseDate)');
  });

  it('a bare pasted message (no status code) still matches, and an object hint narrows it', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'You must enter a close date before saving.',
      object: 'Opportunity',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.candidates.map((c) => c.componentId)).toContain(
      'ValidationRule:Opportunity.Require_Close_Date',
    );
  });

  it('object hint filters out a same-message rule on a different object', async () => {
    // The Contact rule's message won't match this text; assert the hint filter
    // by matching the Contact message but hinting Opportunity → no VR candidate.
    const r = await explainErrorHandler(ctx, {
      errorText: 'Email is required for active contacts.',
      object: 'Opportunity',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.candidates.some((c) => c.strategy === 'validation-rule')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Strategy: flow fault
// ---------------------------------------------------------------------------

describe('explain_error — flow-fault strategy', () => {
  it('resolves the flow named in a fault email (declared) and confirms an action-call element', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'An error occurred at element Notify_Owner.\nFlow API Name: Opportunity_After_Save',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const c = r.value.data.candidates.find((x) => x.strategy === 'flow-fault');
    expect(c?.componentId).toBe('Flow:Opportunity_After_Save');
    expect(c?.confidence).toBe('declared');
    expect(c?.why).toContain('action call');
    expect(r.value.data.disposition).toBe('matched');
  });

  it('fails closed when the fault names a flow not in the vault (no fabricated match)', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'Flow API Name: Ghost_Flow\nAn error occurred at element X',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.candidates.some((c) => c.strategy === 'flow-fault')).toBe(false);
    expect(r.value.data.disposition).toBe('none');
    expect(r.value.data.boundaries.join(' ')).toContain('Ghost_Flow');
  });
});

// ---------------------------------------------------------------------------
// Strategy: apex
// ---------------------------------------------------------------------------

describe('explain_error — apex strategy', () => {
  it('resolves a class stack frame to the ApexClass node (declared)', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'System.NullPointerException: Attempt to de-reference a null object\nClass.AccountService.doWork: line 42, column 1',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const c = r.value.data.candidates.find((x) => x.strategy === 'apex');
    expect(c?.componentId).toBe('ApexClass:AccountService');
    expect(c?.confidence).toBe('declared');
    expect(c?.detail['line']).toBe(42);
  });

  it('resolves a trigger frame too', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'Trigger.OpportunityTrigger: line 7, column 1',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.candidates.some((c) => c.componentId === 'ApexTrigger:OpportunityTrigger')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Strategy: duplicate rules
// ---------------------------------------------------------------------------

describe('explain_error — duplicate-rule strategy', () => {
  it('lists ONLY active duplicate rules on the hinted object (heuristic listing)', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'DUPLICATES_DETECTED, Use one of these records?',
      object: 'Contact',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const dups = r.value.data.candidates.filter((c) => c.strategy === 'duplicate-rule');
    expect(dups.map((c) => c.componentId)).toEqual(['DuplicateRule:Contact.Standard_Contact']);
    expect(dups[0]?.confidence).toBe('heuristic');
    expect(dups[0]?.matchKind).toBe('listing');
  });

  it('without an object hint, discloses that the object is needed (no candidate)', async () => {
    const r = await explainErrorHandler(ctx, { errorText: 'DUPLICATES_DETECTED' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.candidates.some((c) => c.strategy === 'duplicate-rule')).toBe(false);
    expect(r.value.data.boundaries.join(' ')).toContain('object');
  });
});

// ---------------------------------------------------------------------------
// Strategy: status-code taxonomy + fail-closed
// ---------------------------------------------------------------------------

describe('explain_error — status-code taxonomy (category-level)', () => {
  it('explains CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY and cross-refs the object automation', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, OpportunityTrigger: execution of AfterUpdate caused by System.Exception',
      object: 'Opportunity',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const cat = r.value.data.categoryExplanation;
    expect(cat?.statusCode).toBe('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY');
    expect(cat?.categoryLevel).toBe(true);
    expect(cat?.objectAutomation?.map((a) => a.componentId).sort()).toEqual([
      'ApexTrigger:OpportunityTrigger', 'Flow:Opportunity_After_Save',
    ]);
  });

  it('fails closed on an unrecognizable error: none disposition, tried list, next steps', async () => {
    const r = await explainErrorHandler(ctx, { errorText: 'something totally unrecognizable zzz' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    // A bare unmatched message tries the VR strategy but finds nothing.
    expect(d.disposition).toBe('none');
    expect(d.candidates).toHaveLength(0);
    expect(d.triedStrategies.length).toBeGreaterThan(0);
    expect(d.nextSteps.join(' ')).toContain('what_happens_on_save');
  });

  it('recognized status code with no specific source stays none but explains the category', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'UNABLE_TO_LOCK_ROW, unable to obtain exclusive access to this record',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.disposition).toBe('none');
    expect(r.value.data.categoryExplanation?.statusCode).toBe('UNABLE_TO_LOCK_ROW');
    expect(r.value.data.boundaries.join(' ')).toContain('CATEGORY level');
  });

  it('always surfaces the verbatim honesty disclosure', async () => {
    const r = await explainErrorHandler(ctx, { errorText: 'anything' });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.disclosure).toContain('string matching against declared metadata');
  });
});

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

describe('explain_error — ambiguous', () => {
  it('two declared candidates (VR exact + apex frame) → ambiguous', async () => {
    // A paste that both exact-matches a VR message AND carries an apex frame.
    const r = await explainErrorHandler(ctx, {
      errorText: 'FIELD_CUSTOM_VALIDATION_EXCEPTION, You must enter a close date before saving.: [CloseDate]\nClass.AccountService.doWork: line 5',
    });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.value.data.disposition).toBe('ambiguous');
    expect(r.value.data.candidates.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Natural input aliases (EXPLAIN-ERROR-REJECTS-NATURAL-ALIASES): a host that
// pasted the banner under `error` / `message` / `errorMessage` / `text` is
// resolved to the same answer as canonical `errorText`; canonical wins on a
// collision; a genuinely-empty input fails closed with a named invalid-query.
// ---------------------------------------------------------------------------

describe('explain_error — natural input aliases', () => {
  const CANON =
    'FIELD_CUSTOM_VALIDATION_EXCEPTION, You must enter a close date before saving.: [CloseDate]';

  const runVia = async (raw: Record<string, unknown>) => {
    const parsed = explainErrorInputSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('schema rejected a valid alias input');
    const r = await explainErrorHandler(ctx, parsed.data);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('handler failed');
    return r.value.data;
  };

  it('error / message / errorMessage / text resolve byte-identically to canonical errorText', async () => {
    const canonical = await runVia({ errorText: CANON });
    for (const key of ['error', 'message', 'errorMessage', 'text']) {
      const viaAlias = await runVia({ [key]: CANON });
      expect(viaAlias).toEqual(canonical);
    }
  });

  it('canonical errorText wins when both errorText and an alias are present', () => {
    const parsed = explainErrorInputSchema.safeParse({
      errorText: CANON,
      error: 'unrelated banner zzz',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.errorText).toBe(CANON);
  });

  it('empty input (no canonical, no alias) fails closed with a named errorText invalid-query', () => {
    const parsed = explainErrorInputSchema.safeParse({ object: 'Opportunity' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.path.join('.') === 'errorText')).toBe(true);
  });
});
