/// <reference types="vitest/globals" />

import {
  apexClassOfSignature,
  classifyCodeUnit,
  debugLogCoverage,
  descendantNanosByKind,
  frameSelfNanos,
  indexFrames,
  NON_CPU_FRAME_KINDS,
  parseApexDebugLog,
  parseTriggerUnit,
} from '../src/apex-debug-log.js';

/**
 * A compact but structurally REAL log: header with per-category levels, nested
 * CODE_UNIT / METHOD frames on nanosecond offsets, a SOQL span, a DML span, a
 * flow interview with elements, a callout, a FATAL_ERROR with a stack trace, a
 * truncation marker, and a two-namespace CUMULATIVE_LIMIT_USAGE block.
 * Component names are invented, not read from any org.
 */
const LOG = [
  '57.0 APEX_CODE,FINE;APEX_PROFILING,INFO;CALLOUT,INFO;DB,INFO;NBA,NONE;SYSTEM,DEBUG;VALIDATION,NONE;VISUALFORCE,NONE;WAVE,NONE;WORKFLOW,FINER',
  '09:00:00.001 (1000000)|EXECUTION_STARTED',
  '09:00:00.001 (2000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001AAA|WidgetTrigger on Widget__c trigger event BeforeUpdate|__sfdc_trigger/WidgetTrigger',
  '09:00:00.002 (3000000)|METHOD_ENTRY|[1]|01p000000000001AAA|WidgetService.beforeUpdate(List<Widget__c>)',
  '09:00:00.003 (4000000)|SOQL_EXECUTE_BEGIN|[9]|Aggregations:0|SELECT Id FROM Widget__c WHERE Active__c = true',
  '09:00:00.014 (14000000)|SOQL_EXECUTE_END|[9]|Rows:42',
  '09:00:00.014 (15000000)|USER_DEBUG|[11]|DEBUG|loaded widgets',
  '09:00:00.019 (20000000)|METHOD_EXIT|[1]|01p000000000001AAA|WidgetService.beforeUpdate(List<Widget__c>)',
  '09:00:00.021 (21000000)|CODE_UNIT_FINISHED|WidgetTrigger on Widget__c trigger event BeforeUpdate',
  '09:00:00.022 (22000000)|FLOW_START_INTERVIEWS_BEGIN|1',
  '09:00:00.022 (23000000)|FLOW_START_INTERVIEW_BEGIN|1|Widget Post Save',
  '09:00:00.023 (24000000)|FLOW_ELEMENT_BEGIN|1|FlowRecordUpdate|Stamp_Widget',
  '09:00:00.024 (25000000)|DML_BEGIN|[EXTERNAL]|Op:Update|Type:Widget__c|Rows:42',
  '09:00:00.034 (35000000)|DML_END|[EXTERNAL]',
  '09:00:00.035 (36000000)|FLOW_ELEMENT_END|1|FlowRecordUpdate|Stamp_Widget',
  '09:00:00.036 (37000000)|FLOW_START_INTERVIEW_END|1|Widget Post Save',
  '09:00:00.036 (38000000)|FLOW_START_INTERVIEWS_END',
  '09:00:00.038 (39000000)|CODE_UNIT_STARTED|[EXTERNAL]|Flow:301000000000001AAA',
  '09:00:00.039 (40000000)|CODE_UNIT_FINISHED|Flow:301000000000001AAA',
  '09:00:00.040 (41000000)|CALLOUT_REQUEST|[30]|System.HttpRequest[Endpoint=https://svc.example.invalid/v1, Method=GET]',
  '09:00:00.090 (91000000)|CALLOUT_RESPONSE|[30]|System.HttpResponse[Status=OK, StatusCode=200]',
  '*** Skipped 12,345 bytes of detailed log',
  '09:00:00.091 (92000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001AAA|WidgetTrigger on Widget__c trigger event AfterUpdate|__sfdc_trigger/WidgetTrigger',
  '09:00:00.091 (93000000)|METHOD_ENTRY|[3]|01p000000000001AAA|WidgetService.recalc(Set<Id>)',
  '09:00:00.092 (94000000)|EXCEPTION_THROWN|[104]|System.LimitException: Too many SOQL queries: 101',
  '09:00:00.092 (95000000)|FATAL_ERROR|System.LimitException: Too many SOQL queries: 101',
  '',
  'Class.WidgetService.recalc: line 104, column 1',
  'Trigger.WidgetTrigger: line 12, column 1',
  '09:00:00.093 (96000000)|CUMULATIVE_LIMIT_USAGE',
  '09:00:00.093 (96000000)|LIMIT_USAGE_FOR_NS|(default)|',
  '  Number of SOQL queries: 101 out of 100',
  '  Number of DML statements: 2 out of 150',
  '  Maximum CPU time: 4210 out of 10000',
  '',
  '09:00:00.093 (96000000)|LIMIT_USAGE_FOR_NS|pkg|',
  '  Number of SOQL queries: 3 out of 100',
  '',
  '09:00:00.093 (96000000)|CUMULATIVE_LIMIT_USAGE_END',
  '09:00:00.094 (97000000)|EXECUTION_FINISHED',
  'MAXIMUM DEBUG LOG SIZE REACHED',
].join('\n');

describe('parseApexDebugLog — header', () => {
  it('reads the API version and every declared category level', () => {
    const p = parseApexDebugLog(LOG);
    expect(p.header.declared).toBe(true);
    expect(p.header.apiVersion).toBe('57.0');
    expect(p.header.levels.APEX_CODE).toBe('FINE');
    expect(p.header.levels.VALIDATION).toBe('NONE');
    expect(p.header.levels.WORKFLOW).toBe('FINER');
    expect(p.header.unrecognizedCategories).toEqual([]);
  });

  it('reports a MISSING header rather than assuming defaults', () => {
    const p = parseApexDebugLog('09:00:00.001 (1000000)|EXECUTION_STARTED');
    expect(p.header.declared).toBe(false);
    expect(p.parseCaveats.some((c) => c.kind === 'no-header')).toBe(true);
  });
});

describe('parseApexDebugLog — event stream', () => {
  it('parses timestamped events with nanos, fields and physical line numbers', () => {
    const p = parseApexDebugLog(LOG);
    expect(p.isDebugLog).toBe(true);
    const first = p.events[0];
    expect(first?.event).toBe('EXECUTION_STARTED');
    expect(first?.nanos).toBe(1_000_000);
    expect(first?.timestamp).toBe('09:00:00.001');
    expect(first?.line).toBe(2);
  });

  it('is NOT a debug log when the text carries no event lines', () => {
    const p = parseApexDebugLog('FIELD_CUSTOM_VALIDATION_EXCEPTION, Close date is required');
    expect(p.isDebugLog).toBe(false);
    expect(p.frames).toEqual([]);
  });

  it('counts each event token so "was this logged" is answerable', () => {
    const p = parseApexDebugLog(LOG);
    expect(p.eventCounts['CODE_UNIT_STARTED']).toBe(3);
    expect(p.eventCounts['VALIDATION_RULE']).toBeUndefined();
  });
});

describe('parseApexDebugLog — frame pairing and durations', () => {
  it('pairs entry/exit on the nanosecond offsets and nests by depth', () => {
    const p = parseApexDebugLog(LOG);
    const before = p.frames.find(
      (f) => f.kind === 'code-unit' && f.detail['triggerEvent'] === 'BeforeUpdate',
    );
    expect(before?.durationNanos).toBe(19_000_000);
    expect(before?.depth).toBe(1); // inside the EXECUTION frame
    const method = p.frames.find((f) => f.kind === 'method');
    expect(method?.parentId).toBe(before?.id);
    expect(method?.durationNanos).toBe(17_000_000);
  });

  it('parses SOQL query text + rows and DML op/type/rows off the span', () => {
    const p = parseApexDebugLog(LOG);
    const soql = p.frames.find((f) => f.kind === 'soql');
    expect(soql?.name).toContain('SELECT Id FROM Widget__c');
    expect(soql?.detail['rows']).toBe(42);
    expect(soql?.durationNanos).toBe(10_000_000);
    const dml = p.frames.find((f) => f.kind === 'dml');
    expect(dml?.detail['operation']).toBe('Update');
    expect(dml?.detail['objectApiName']).toBe('Widget__c');
    expect(dml?.detail['rows']).toBe(42);
  });

  it('records a flow interview and its element sequence', () => {
    const p = parseApexDebugLog(LOG);
    const interview = p.frames.find((f) => f.kind === 'flow-interview');
    expect(interview?.name).toBe('Widget Post Save');
    const element = p.frames.find((f) => f.kind === 'flow-element');
    expect(element?.name).toBe('Stamp_Widget');
    expect(element?.detail['elementType']).toBe('FlowRecordUpdate');
    expect(element?.parentId).toBe(interview?.id);
  });

  it('leaves a frame that never closed UNPAIRED with a null duration', () => {
    const p = parseApexDebugLog(LOG);
    const after = p.frames.find(
      (f) => f.kind === 'code-unit' && f.detail['triggerEvent'] === 'AfterUpdate',
    );
    expect(after?.unpaired).toBe(true);
    expect(after?.durationNanos).toBeNull();
    expect(p.parseCaveats.some((c) => c.kind === 'unpaired-open')).toBe(true);
  });

  it('flags an orphan close instead of inventing a frame for it', () => {
    const p = parseApexDebugLog(
      ['09:00:00.001 (1000000)|METHOD_EXIT|[1]|01p|Orphan.method()'].join('\n'),
    );
    expect(p.frames).toEqual([]);
    expect(p.parseCaveats.some((c) => c.kind === 'orphan-close')).toBe(true);
  });
});

describe('parseApexDebugLog — code unit identity', () => {
  it('splits a trigger unit into trigger / object / event', () => {
    expect(parseTriggerUnit('WidgetTrigger on Widget__c trigger event BeforeUpdate')).toEqual({
      triggerName: 'WidgetTrigger',
      objectApiName: 'Widget__c',
      event: 'BeforeUpdate',
    });
    expect(parseTriggerUnit('WidgetService.recalc()')).toBeNull();
  });

  it('skips the Salesforce record id and keeps the human-readable unit name', () => {
    const p = parseApexDebugLog(LOG);
    const before = p.frames.find(
      (f) => f.kind === 'code-unit' && f.detail['triggerEvent'] === 'BeforeUpdate',
    );
    expect(before?.name).toBe('WidgetTrigger on Widget__c trigger event BeforeUpdate');
    expect(before?.detail['triggerMarker']).toBe('WidgetTrigger');
  });

  it('keeps an ID-ONLY unit as the id — it is unresolvable, not renameable', () => {
    const p = parseApexDebugLog(LOG);
    const idOnly = p.frames.find((f) => f.name.startsWith('Flow:'));
    expect(idOnly?.name).toBe('Flow:301000000000001AAA');
    expect(idOnly?.codeUnitKind).toBe('flow');
  });

  it('classifies unit kinds, and says "other" rather than guessing', () => {
    expect(classifyCodeUnit('WidgetTrigger on Widget__c trigger event AfterInsert')).toBe('trigger');
    expect(classifyCodeUnit('execute_anonymous_apex')).toBe('anonymous');
    expect(classifyCodeUnit('Workflow:01Q000000000001')).toBe('workflow');
    expect(classifyCodeUnit('WidgetService.recalc()')).toBe('apex-method');
    expect(classifyCodeUnit('something entirely unfamiliar')).toBe('other');
  });

  it('takes the LEFTMOST type of a signature — an inner class is not a component', () => {
    expect(apexClassOfSignature('Outer.Inner.method(List<Id>)')).toBe('Outer');
    expect(apexClassOfSignature('noDotsHere')).toBeNull();
  });
});

describe('parseApexDebugLog — limits, errors and truncation', () => {
  it('parses the CUMULATIVE_LIMIT_USAGE table per namespace with exceeded flags', () => {
    const p = parseApexDebugLog(LOG);
    const soql = p.limits.find((l) => l.namespace === '(default)' && l.metric === 'SOQL queries');
    expect(soql).toMatchObject({ used: 101, allowed: 100, exceeded: true });
    expect(soql?.source).toBe('CUMULATIVE_LIMIT_USAGE');
    const cpu = p.limits.find((l) => l.metric === 'CPU time');
    expect(cpu).toMatchObject({ used: 4210, allowed: 10_000, exceeded: false });
    expect(p.limits.some((l) => l.namespace === 'pkg')).toBe(true);
  });

  it('attaches the untimestamped stack trace to the FATAL_ERROR that owns it', () => {
    const p = parseApexDebugLog(LOG);
    const fatal = p.errors.find((e) => e.kind === 'FATAL_ERROR');
    expect(fatal?.message).toBe('System.LimitException: Too many SOQL queries: 101');
    expect(fatal?.stack).toEqual([
      'Class.WidgetService.recalc: line 104, column 1',
      'Trigger.WidgetTrigger: line 12, column 1',
    ]);
    expect(p.errors.some((e) => e.kind === 'EXCEPTION_THROWN')).toBe(true);
  });

  it('detects truncation markers and the 20 MB ceiling', () => {
    const p = parseApexDebugLog(LOG);
    expect(p.truncation.truncated).toBe(true);
    expect(p.truncation.skippedBytes).toBe(12_345);
    expect(p.truncation.maximumSizeReached).toBe(true);
  });

  it('reports no truncation on a clean log', () => {
    const p = parseApexDebugLog(
      ['57.0 APEX_CODE,FINE', '09:00:00.001 (1000000)|EXECUTION_STARTED'].join('\n'),
    );
    expect(p.truncation.truncated).toBe(false);
    expect(p.truncation.markers).toEqual([]);
  });

  it('captures USER_DEBUG level, message and source line', () => {
    const p = parseApexDebugLog(LOG);
    expect(p.userDebug[0]).toMatchObject({
      level: 'DEBUG',
      message: 'loaded widgets',
      sourceLine: 11,
    });
  });
});

describe('debugLogCoverage — absent means NOT LOGGED', () => {
  it('marks a NONE category not-logged and says absence proves nothing', () => {
    const cov = debugLogCoverage(parseApexDebugLog(LOG));
    const validation = cov.find((c) => c.category === 'VALIDATION');
    expect(validation?.logged).toBe(false);
    expect(validation?.level).toBe('NONE');
    expect(validation?.meaning).toContain('NOT LOGGED');
    expect(validation?.meaning).toContain('not evidence');
  });

  it('marks a captured category logged and counts its events', () => {
    const cov = debugLogCoverage(parseApexDebugLog(LOG));
    const db = cov.find((c) => c.category === 'DB');
    expect(db?.logged).toBe(true);
    expect(db?.eventsSeen).toBeGreaterThan(0);
  });

  it('treats a header-less log as UNKNOWN capture, never as "nothing ran"', () => {
    const cov = debugLogCoverage(parseApexDebugLog('09:00:00.001 (1)|EXECUTION_STARTED'));
    expect(cov.every((c) => !c.logged)).toBe(true);
    expect(cov[0]?.meaning).toContain('UNKNOWN');
  });
});

describe('time attribution helpers', () => {
  it('frameSelfNanos excludes child spans', () => {
    const p = parseApexDebugLog(LOG);
    const byId = indexFrames(p.frames);
    const method = p.frames.find((f) => f.kind === 'method');
    // 17ms wall, 10ms of it inside the SOQL child.
    expect(method && frameSelfNanos(method, byId)).toBe(7_000_000);
  });

  it('frameSelfNanos is null for a span whose duration is unknown', () => {
    const p = parseApexDebugLog(LOG);
    const byId = indexFrames(p.frames);
    const after = p.frames.find(
      (f) => f.kind === 'code-unit' && f.detail['triggerEvent'] === 'AfterUpdate',
    );
    expect(after && frameSelfNanos(after, byId)).toBeNull();
  });

  it('descendantNanosByKind sums DB/callout wait so CPU can be separated', () => {
    const p = parseApexDebugLog(LOG);
    const byId = indexFrames(p.frames);
    const before = p.frames.find(
      (f) => f.kind === 'code-unit' && f.detail['triggerEvent'] === 'BeforeUpdate',
    );
    const nonCpu = before && descendantNanosByKind(before, byId, NON_CPU_FRAME_KINDS);
    expect(nonCpu?.nanos).toBe(10_000_000);
    expect(nonCpu?.count).toBe(1);
    expect(nonCpu?.unpairedCount).toBe(0);
  });
});

// =============================================================================
// W2F REVIEW — the defects two independent reviews and a real-org corpus found.
//
// Every case below produced a CONFIDENTLY FALSE answer before the fix, not a
// missing one. The pre-existing suite passed on all of them, which is why they
// are pinned here as behaviour rather than left to the happy-path fixture.
// =============================================================================

describe('parseApexDebugLog — header shapes real logs and the platform docs actually use', () => {
  it('reads a WRAPPED header: the docs own example breaks the category list over two lines', () => {
    // Matching only the tail declared 3 of 8 categories and lost the version,
    // and coverage then told the reader that APEX_CODE — captured at FINEST —
    // "was not declared, so absence proves nothing".
    const r = parseApexDebugLog(
      [
        '37.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;CALLOUT,INFO;DB,INFO;SYSTEM,DEBUG;',
        '    VALIDATION,INFO;VISUALFORCE,INFO;WORKFLOW,INFO',
        '16:06:58.18 (18348659)|EXECUTION_STARTED',
        '16:06:58.18 (54114689)|EXECUTION_FINISHED',
      ].join('\n'),
    );
    expect(r.header.declared).toBe(true);
    expect(r.header.apiVersion).toBe('37.0');
    expect(Object.keys(r.header.levels)).toHaveLength(8);
    expect(r.header.levels.APEX_CODE).toBe('FINEST');
  });

  it('accepts a header that ends in a semicolon', () => {
    const r = parseApexDebugLog('57.0 APEX_CODE,FINE;DB,INFO;\n16:06:58.18 (1)|EXECUTION_STARTED');
    expect(r.header.declared).toBe(true);
    expect(r.header.levels.DB).toBe('INFO');
  });

  it('recognizes DATA_ACCESS, which every header in a real-org sample declares', () => {
    const r = parseApexDebugLog(
      '67.0 APEX_CODE,FINEST;DATA_ACCESS,INFO;DB,FINEST\n16:06:58.18 (1)|EXECUTION_STARTED',
    );
    expect(r.header.levels.DATA_ACCESS).toBe('INFO');
    expect(r.header.unrecognizedCategories).toEqual([]);
    // Its governed events are not documented, so coverage must say exactly
    // that rather than report a confident "0 seen".
    const da = debugLogCoverage(r).find((c) => c.category === 'DATA_ACCESS');
    expect(da?.meaning).toMatch(/does not model which event lines/i);
    expect(da?.meaning).not.toMatch(/matching event line/);
  });
});

describe('debugLogCoverage — levels are CUMULATIVE, so "not NONE" is not "fully captured"', () => {
  it('WORKFLOW=INFO reports flow ELEMENTS as not written, not as a flow that ran none', () => {
    // The headline honesty defect: FLOW_ELEMENT_BEGIN/END are FINE+, so an
    // INFO capture records the interview and none of its elements. The answer
    // rendered that as `steps: []` — "this flow ran no elements".
    const r = parseApexDebugLog(
      [
        '57.0 APEX_CODE,DEBUG;WORKFLOW,INFO',
        '10:00:00.0 (1000000)|EXECUTION_STARTED',
        '10:00:00.0 (2000000)|FLOW_START_INTERVIEW_BEGIN|abc|Order Sync',
        '10:00:00.0 (9000000)|FLOW_START_INTERVIEW_END|abc|Order Sync',
        '10:00:00.0 (9500000)|EXECUTION_FINISHED',
      ].join('\n'),
    );
    const wf = debugLogCoverage(r).find((c) => c.category === 'WORKFLOW');
    expect(wf?.logged).toBe(true);
    expect(wf?.eventsBelowLevel).toContain('FLOW_ELEMENT_BEGIN');
    expect(wf?.eventsBelowLevel).toContain('FLOW_ELEMENT_END');
    expect(wf?.meaning).toMatch(/PARTIALLY/);
    expect(wf?.meaning).toMatch(/NOT CAPTURED, never "did not happen"/);
  });

  it('APEX_CODE=DEBUG — the platform DEFAULT for Apex tests — hides METHOD_ENTRY', () => {
    const r = parseApexDebugLog('57.0 APEX_CODE,DEBUG\n10:00:00.0 (1)|EXECUTION_STARTED');
    const ac = debugLogCoverage(r).find((c) => c.category === 'APEX_CODE');
    expect(ac?.eventsBelowLevel).toContain('METHOD_ENTRY');
    expect(ac?.eventsBelowLevel).toContain('CONSTRUCTOR_ENTRY');
  });

  it('a level that covers everything it governs reports no partial capture', () => {
    const r = parseApexDebugLog('57.0 WORKFLOW,FINEST\n10:00:00.0 (1)|EXECUTION_STARTED');
    const wf = debugLogCoverage(r).find((c) => c.category === 'WORKFLOW');
    expect(wf?.eventsBelowLevel).toEqual([]);
    expect(wf?.meaning).not.toMatch(/PARTIALLY/);
  });

  it('VF_APEX_CALL_* are APEX_CODE events, so VISUALFORCE=NONE must not excuse them', () => {
    // Claiming them under Visualforce made a VISUALFORCE=NONE log say those
    // lines "were NOT LOGGED, so their absence is a logging setting" — while
    // APEX_CODE=FINE would in fact have written them.
    const r = parseApexDebugLog('57.0 APEX_CODE,FINE;VISUALFORCE,NONE\n10:00:00.0 (1)|EXECUTION_STARTED');
    const vf = debugLogCoverage(r).find((c) => c.category === 'VISUALFORCE');
    expect(vf?.eventsGoverned).not.toContain('VF_APEX_CALL_START');
    expect(vf?.meaning).not.toMatch(/VF_APEX_CALL_START/);
    const ac = debugLogCoverage(r).find((c) => c.category === 'APEX_CODE');
    expect(ac?.eventsGoverned).toContain('VF_APEX_CALL_START');
  });
});

describe('parseApexDebugLog — a trimmed log drops lines from ANY location, not just the head', () => {
  const holed = [
    '57.0 APEX_CODE,FINE',
    '10:00:00.0 (10000000)|EXECUTION_STARTED',
    '10:00:00.0 (10000000)|CODE_UNIT_STARTED|[EXTERNAL]|A_Trigger on Account trigger event BeforeInsert|__sfdc_trigger/A_Trigger',
    '10:00:00.0 (11000000)|CODE_UNIT_STARTED|[EXTERNAL]|B_Trigger on Contact trigger event BeforeInsert|__sfdc_trigger/B_Trigger',
    // B's CODE_UNIT_FINISHED was removed from the MIDDLE of the log.
    '10:00:00.0 (99000000)|CODE_UNIT_FINISHED|A_Trigger on Account trigger event BeforeInsert|__sfdc_trigger/A_Trigger',
    '10:00:00.0 (99500000)|EXECUTION_FINISHED',
  ].join('\n');

  it("a close event lands on the unit it NAMES, not on the nearest open frame", () => {
    const r = parseApexDebugLog(holed);
    const a = r.frames.find((f) => f.name.startsWith('A_Trigger'));
    const b = r.frames.find((f) => f.name.startsWith('B_Trigger'));
    // A really did close; B's close is gone. Before the fix these were swapped,
    // so "the slowest code unit" named the wrong trigger with a real number.
    expect(a?.durationNanos).toBe(89_000_000);
    expect(a?.unpaired).toBe(false);
    expect(b?.durationNanos).toBeNull();
    expect(b?.unpaired).toBe(true);
  });
});

describe('parseApexDebugLog — a span that ends before it starts has no duration', () => {
  it('reports null and raises negative-duration rather than a negative number', () => {
    const r = parseApexDebugLog(
      [
        '57.0 APEX_CODE,FINE',
        '10:00:00.9 (99000000)|CODE_UNIT_STARTED|[EXTERNAL]|X on Account trigger event BeforeInsert|__sfdc_trigger/X',
        '10:00:00.1 (11000000)|CODE_UNIT_FINISHED|X on Account trigger event BeforeInsert|__sfdc_trigger/X',
      ].join('\n'),
    );
    expect(r.frames[0]?.durationNanos).toBeNull();
    expect(r.elapsedNanos).toBeNull();
    expect(r.parseCaveats.map((c) => c.kind)).toContain('negative-duration');
  });
});

describe('descendantNanosByKind — nested spans of the SAME kind are not double counted', () => {
  it('a DML inside a DML contributes its outermost span only', () => {
    // The commonest Apex shape (a trigger doing its own DML) summed both and
    // exceeded the unit containing them: 184 ms of DML inside a 96 ms unit,
    // driving the CPU estimate negative, where it was silently clamped to 0.
    const r = parseApexDebugLog(
      [
        '57.0 APEX_CODE,FINE;DB,INFO',
        '10:00:00.0 (0)|EXECUTION_STARTED',
        '10:00:00.0 (1000000)|CODE_UNIT_STARTED|[EXTERNAL]|T on Widget__c trigger event BeforeUpdate|__sfdc_trigger/T',
        '10:00:00.0 (2000000)|DML_BEGIN|[10]|Op:Update|Type:Widget__c|Rows:1',
        '10:00:00.0 (3000000)|DML_BEGIN|[20]|Op:Insert|Type:Log__c|Rows:1',
        '10:00:00.0 (93000000)|DML_END|[20]',
        '10:00:00.0 (96000000)|DML_END|[10]',
        '10:00:00.0 (97000000)|CODE_UNIT_FINISHED|T on Widget__c trigger event BeforeUpdate|__sfdc_trigger/T',
        '10:00:00.0 (98000000)|EXECUTION_FINISHED',
      ].join('\n'),
    );
    const unit = r.frames.find((f) => f.kind === 'code-unit');
    expect(unit?.durationNanos).toBe(96_000_000);
    const dml = descendantNanosByKind(unit!, indexFrames(r.frames), ['dml']);
    expect(dml.nanos).toBe(94_000_000); // outermost only, NOT 184ms
    expect(dml.count).toBe(2); // both statements still counted
    expect(unit!.durationNanos! - dml.nanos).toBeGreaterThan(0); // CPU stays positive
  });
});
