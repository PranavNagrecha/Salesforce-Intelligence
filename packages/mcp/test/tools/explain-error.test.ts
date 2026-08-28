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
import { explainDebugLogHandler } from '../../src/tools/explain-debug-log.js';
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
// FIX 10 — explain_error must not be silent about a System.LimitException.
//
// The detector already existed one module over and is now SHARED
// (`./governor-limit-signature.js`), so the two tools cannot disagree about the
// same string. That is what the cross-tool table below asserts.
// ---------------------------------------------------------------------------

/** Limit strings the two tools must classify IDENTICALLY. */
const LIMIT_STRINGS: readonly string[] = [
  'System.LimitException: Too many SOQL queries: 101',
  'System.LimitException: Too many DML statements: 151',
  'System.LimitException: Too many query rows: 50001',
  'System.LimitException: Apex CPU time limit exceeded',
  'System.LimitException: Apex heap size too large: 7000000',
  'Number of SOQL queries: 101 out of 100',
];

describe('explain_error — runtime governor-limit signature (FIX 10)', () => {
  it('classifies System.LimitException instead of returning a fully-null `none`', async () => {
    // FAIL-BEFORE: the taxonomy held only DML/API status codes, so this string
    // returned disposition 'none' with every field null — while
    // sfi.explain_debug_log classified it as `soql`, 101.
    const r = await explainErrorHandler(ctx, {
      errorText: 'System.LimitException: Too many SOQL queries: 101',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).not.toBe('none');
    expect(d.disposition).toBe('matched');
    expect(d.detectedLimit?.limitType).toBe('soql');
    expect(d.detectedLimit?.actual).toBe(101);
    expect(d.triedStrategies).toContain(
      'governor-limit signature (runtime limit classification)',
    );
    // Category-level, never a source match: no candidate is fabricated.
    expect(d.candidates).toEqual([]);
    expect(d.boundaries.join(' ')).toContain('consumed across the WHOLE transaction');
    // The static cross-reference REUSES LIMIT_TO_STATIC_RULES rather than
    // re-deriving it: soql maps to soql-in-loop.
    expect(d.nextSteps.join(' ')).toContain('sfi.explain_debug_log');
    expect(d.nextSteps.join(' ')).toContain('soql-in-loop');
    // And it stops telling the caller to paste what they just pasted.
    expect(d.nextSteps.join(' ').toLowerCase()).not.toContain('paste the full error');
  });

  it('CROSS-TOOL CONSISTENCY: explain_error and explain_debug_log return the SAME detectedLimit', async () => {
    // This is the test that makes the re-use load-bearing rather than
    // incidental — a second copy of the classifier would drift and fail here.
    for (const text of LIMIT_STRINGS) {
      const viaError = await explainErrorHandler(ctx, { errorText: text });
      const viaLog = await explainDebugLogHandler(ctx, { logText: text });
      expect(viaError.ok).toBe(true);
      expect(viaLog.ok).toBe(true);
      if (!viaError.ok || !viaLog.ok) return;
      expect(viaError.value.data.detectedLimit).not.toBeNull();
      expect(viaError.value.data.detectedLimit).toEqual(
        viaLog.value.data.detectedLimit,
      );
    }
  });

  it('a limit signature and a status code are DIFFERENT AXES and do not compete', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText:
        'UNABLE_TO_LOCK_ROW, unable to obtain exclusive access to this record\nSystem.LimitException: Too many SOQL queries: 101',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.categoryExplanation?.statusCode).toBe('UNABLE_TO_LOCK_ROW');
    expect(d.detectedLimit?.limitType).toBe('soql');
  });

  it('a text with no limit signature reports detectedLimit: null (not a fabricated other)', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText: 'REQUIRED_FIELD_MISSING, Required fields are missing: [Name]',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.detectedLimit).toBeNull();
    expect(r.value.data.triedStrategies).not.toContain(
      'governor-limit signature (runtime limit classification)',
    );
  });

  it('an unrecognised System.*Exception stays `none` and names the GAP instead of asking for another paste', async () => {
    // FAIL-BEFORE: nextSteps told the caller to "Paste the FULL error" — which
    // is what they had just pasted — and nothing said the Apex exception
    // hierarchy is simply not modelled here.
    const r = await explainErrorHandler(ctx, {
      errorText: 'System.NullPointerException: Attempt to de-reference a null object',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.disposition).toBe('none');
    // Asserted BEFORE the new field so the pre-fix failure is a WRONG VALUE
    // (the old nextSteps said "Paste the FULL error"), not a missing symbol.
    expect(d.nextSteps.join(' ').toLowerCase()).not.toContain('paste the full error');
    expect(d.nextSteps.join(' ')).toContain('sfi.explain_debug_log');
    expect(d.boundaries).toContain(
      "This is an Apex RUNTIME exception (System.NullPointerException), not a DML / API status code. This tool's taxonomy covers 13 DML and API status codes and the runtime governor-limit signatures; it does not model the Apex exception hierarchy. For a runtime failure, sfi.explain_debug_log reads the debug log — stack frames, the fired limit, and the static governor-risk cross-reference. That is a GAP IN THIS TOOL, not a claim that nothing explains your error.",
    );
    expect(d.detectedLimit).toBeNull();
  });

  it('the disclosure names BOTH category-level recognizers', async () => {
    const r = await explainErrorHandler(ctx, { errorText: 'anything' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toContain('categoryExplanation');
    expect(r.value.data.disclosure).toContain('detectedLimit');
    expect(r.value.data.disclosure).toContain(
      'the SAME detector sfi.explain_debug_log uses',
    );
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

// ---------------------------------------------------------------------------
// R4 — the `object` hint must be VERIFIED against the vault before it is
// threaded into any graph read (VR filter / duplicate-rule filter /
// object-automation cross-reference), never string-templated on faith.
// ---------------------------------------------------------------------------

describe('explain_error — object hint verification (R4)', () => {
  it('fails closed with a named invalid-query on a mistyped object hint, instead of a confident empty automation cross-reference', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText:
        'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, OpportunityTrigger: execution of AfterUpdate caused by System.Exception',
      object: 'Acount', // typo for "Account" — and not the same as "Opportunity" either
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Acount');
  });

  it('a wrong-CASE object hint resolves to the vault exact casing before the object-automation cross-reference runs, instead of silently cross-referencing zero automation', async () => {
    const r = await explainErrorHandler(ctx, {
      errorText:
        'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, OpportunityTrigger: execution of AfterUpdate caused by System.Exception',
      object: 'opportunity', // vault holds "Opportunity" — case differs
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.categoryExplanation?.objectAutomation?.map((a) => a.componentId).sort()).toEqual([
      'ApexTrigger:OpportunityTrigger',
      'Flow:Opportunity_After_Save',
    ]);
  });
});

// ---------------------------------------------------------------------------
// R1 — `objectAutomation` is byte-budget capped at MAX_OBJECT_AUTOMATION (25);
// the cap must carry a `truncated` signal and must sort the FULL set before
// slicing, never slice-then-sort an arbitrary edge-order subset.
// ---------------------------------------------------------------------------

describe('explain_error — object-automation truncation (R1)', () => {
  it('caps objectAutomation at 25 AND discloses objectAutomationTruncated: true on an object with more automation than the cap', async () => {
    const n = 30;
    const triggerIds = Array.from(
      { length: n },
      (_, i) => `ApexTrigger:CaseAutomation_${String(i).padStart(2, '0')}`,
    );
    const extra: ExtractionResult = {
      nodes: [
        node({ id: 'CustomObject:Case', type: 'CustomObject', apiName: 'Case' }),
        ...triggerIds.map((id, i) =>
          node({
            id,
            type: 'ApexTrigger',
            apiName: `CaseAutomation_${String(i).padStart(2, '0')}`,
            properties: { triggerObject: 'Case', status: 'Active' },
          }),
        ),
      ],
      edges: triggerIds.map((fromId) =>
        edge({ fromId, toId: 'CustomObject:Case', edgeType: 'triggersOn' }),
      ),
    };
    const imp = await importExtractionResults(store, [extra]);
    expect(imp.ok).toBe(true);

    const r = await explainErrorHandler(ctx, {
      errorText:
        'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, CaseAutomation_00: execution of AfterUpdate caused by System.Exception',
      object: 'Case',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cat = r.value.data.categoryExplanation;
    expect(cat?.objectAutomation).toHaveLength(25);
    expect(cat?.objectAutomationTruncated).toBe(true);
    // The 25 kept must be the alphabetically-first 25 of the FULL 30 (proves a
    // sort over the whole set, not a sort of an arbitrary 25-item slice).
    const ids = (cat?.objectAutomation ?? []).map((a) => a.componentId);
    const expectedFirst25 = [...triggerIds].sort().slice(0, 25);
    expect(ids).toEqual(expectedFirst25);
  });
});

// ---------------------------------------------------------------------------
// R6 — the DuplicateRule scan must page past the 500-node single-page cap,
// exactly as the sibling ValidationRule scan in this same file does.
// ---------------------------------------------------------------------------

describe('explain_error — DuplicateRule full-scan pagination (R6)', () => {
  it('finds an active duplicate rule past the 500-row single-page cap, instead of reading only the alphabetical first page', async () => {
    const bigTempDir = mkdtempSync(join(tmpdir(), 'sfi-explain-error-r6-'));
    const o = await openGraph(join(bigTempDir, 'g.db'));
    if (!o.ok) throw new Error(o.error.message);
    const bigStore = o.value;
    try {
      // 500 filler rules that sort BEFORE the target — id-ASC digits < 'z' —
      // so the target lands at row 501, past a single un-paged 500-row page.
      const filler = Array.from({ length: 500 }, (_, i) =>
        node({
          id: `DuplicateRule:Lead.Filler_${String(i).padStart(4, '0')}`,
          type: 'DuplicateRule',
          apiName: `Lead.Filler_${String(i).padStart(4, '0')}`,
          parentId: 'CustomObject:Lead',
          properties: { isActive: false, alertText: 'filler' },
        }),
      );
      const target = node({
        id: 'DuplicateRule:Lead.zzz_Target_Rule',
        type: 'DuplicateRule',
        apiName: 'Lead.zzz_Target_Rule',
        label: 'Target Rule',
        parentId: 'CustomObject:Lead',
        properties: { isActive: true, alertText: 'Possible match on Lead.' },
      });
      const seedBig: ExtractionResult = {
        nodes: [node({ id: 'CustomObject:Lead', type: 'CustomObject', apiName: 'Lead' }), ...filler, target],
        edges: [],
      };
      const imp = await importExtractionResults(bigStore, [seedBig]);
      expect(imp.ok).toBe(true);
      const bigCtx: Context = { vaultRoot: bigTempDir, manifest: MANIFEST, graph: bigStore };

      const r = await explainErrorHandler(bigCtx, {
        errorText: 'DUPLICATES_DETECTED, Possible match on Lead.',
        object: 'Lead',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const dups = r.value.data.candidates.filter((c) => c.strategy === 'duplicate-rule');
      expect(dups.map((c) => c.componentId)).toContain('DuplicateRule:Lead.zzz_Target_Rule');
    } finally {
      await closeGraph(bigStore);
      rmSync(bigTempDir, { recursive: true, force: true });
    }
  });
});
