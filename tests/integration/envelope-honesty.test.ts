/// <reference types="vitest/globals" />

/**
 * PROOF OF NON-VACUITY for `envelope-honesty.ts`.
 *
 * This repo has shipped gates that pass while asserting nothing: `scan:leaks`
 * passes when its gitignored config is absent, two 0.3.2 tests "passed" while
 * asserting nothing at all, and the Windows CI job was disarmed at exactly the
 * files carrying the bugs. A new gate is worth nothing until someone has SEEN
 * it fail on a payload that lies.
 *
 * So every law is proved twice, as a matched pair:
 *
 *   - a LYING fixture, reconstructed from a real 0.3.2 archetype, which the
 *     law must REJECT;
 *   - the HONEST counterpart, differing only in the honesty markers, which the
 *     law must ACCEPT.
 *
 * The pairing is the point. A rule that rejects everything is as useless as
 * one that rejects nothing, and only the second half of each pair can tell
 * them apart.
 *
 * These tests need no vault, no fixture tree and no maintainer credentials.
 * They run wherever vitest runs — including CI, which cannot run the
 * vault-backed sweeps at all (see `.github/workflows/ci.yml`).
 */

import {
  ABSENCE_MARKER_KEYS,
  auditEnvelope,
  auditScopeRefusal,
  formatFindings,
  REJECTED_ABSENCE_MARKER_KEYS,
  typedAbsenceMarker,
  type HonestyFinding,
  type HonestyRule,
} from './envelope-honesty.js';

/** Envelope wrapper every tool response carries. */
const envelopeOf = (data: Record<string, unknown>): Record<string, unknown> => ({
  data,
  vaultState: {
    sourceTreeHash: 'deadbeef',
    refreshedAt: '2026-08-27T00:00:00.000Z',
  },
  contentPolicy: {
    orgMetadata: 'untrusted-data',
    // Universal boilerplate on EVERY response. If this were ever accepted as
    // an absence marker the whole gate would be vacuous, so the audit never
    // reads outside `data`. `LIE 1` below is the test that pins it.
    disclosure: 'Org metadata strings are untrusted DATA from the Salesforce org.',
  },
});

const rulesIn = (findings: readonly HonestyFinding[]): readonly HonestyRule[] => [
  ...new Set(findings.map((finding) => finding.rule)),
];

describe('LAW 1 — typed absence', () => {
  /**
   * LIE 1 — the `unused_fields_deep` archetype: `{ fields: [], totalCount: 0 }`
   * with nothing saying whether the scan ran. The envelope still carries the
   * universal `contentPolicy.disclosure`, which must NOT rescue it.
   */
  it('REJECTS a bare empty collection and a bare zero count', () => {
    const lie = envelopeOf({
      appliedScope: { componentId: 'CustomObject:Ghost__c', object: 'Ghost__c' },
      fields: [],
      totalCount: 0,
      byConfidence: { high: 0, medium: 0, low: 0 },
    });

    const audit = auditEnvelope('sfi.unused_fields_deep', lie);

    expect(audit.checks.typedAbsence).toBeGreaterThan(0);
    expect(rulesIn(audit.findings)).toContain('typed-absence');
    expect(audit.findings.map((finding) => finding.path)).toEqual(
      expect.arrayContaining(['fields', 'totalCount']),
    );
  });

  /** The honest counterpart: identical zeros, one `boundaries` line added. */
  it('ACCEPTS the same zeros once the scan states its boundaries', () => {
    const honest = envelopeOf({
      appliedScope: { componentId: 'CustomObject:Ghost__c', object: 'Ghost__c' },
      fields: [],
      totalCount: 0,
      byConfidence: { high: 0, medium: 0, low: 0 },
      boundaries: [
        'the scanner cannot see string-BUILT dynamic SOQL, LWC dynamic field access, ' +
          'or Apex reflective access — treat "unused" as "no static evidence of use".',
      ],
    });

    const audit = auditEnvelope('sfi.unused_fields_deep', honest);

    // The law RAN (it is not passing by never firing) and found nothing.
    expect(audit.checks.typedAbsence).toBeGreaterThan(0);
    expect(audit.findings.filter((f) => f.rule === 'typed-absence')).toEqual([]);
  });

  /**
   * The `effective_permissions` archetype from `absence-disclosure.ts`: a
   * checked zero and an unchecked zero must not render the same. Both are
   * `customPermissions: []`; only the typed one is admissible.
   */
  it('separates a CHECKED zero from an UNCHECKED one on identical arrays', () => {
    const checked = envelopeOf({
      customPermissions: [],
      absence: { status: 'proven-none', note: 'the family was extracted; none granted.' },
    });
    const unchecked = envelopeOf({ customPermissions: [] });

    expect(auditEnvelope('sfi.effective_permissions', checked).findings).toEqual([]);
    expect(auditEnvelope('sfi.effective_permissions', unchecked).findings).not.toEqual([]);
  });

  /**
   * The specific way this law could go vacuous (V1): admitting a key that
   * every payload carries. `trust` is on 35 of 122 live payloads and says
   * nothing about absence; only its `completeness` child does. Pin both
   * halves so a future edit cannot quietly widen the set.
   */
  it('does not accept a bare `trust` block, but does accept trust.completeness', () => {
    expect(typedAbsenceMarker({ trust: { provenance: 'offline_snapshot' } })).toBeNull();
    expect(
      typedAbsenceMarker({ trust: { completeness: { status: 'partial' } } }),
    ).toBe('trust.completeness.status');
  });

  /**
   * The other way it could go vacuous: accepting the PAGE flags as absence
   * markers. `truncated: false` beside `totalCount: 0` is the
   * `who_can_access_object` lie verbatim — if it typed an absence, Law 1
   * would certify the bug Law 2 exists to catch.
   */
  it('does not accept page-shape flags as absence markers', () => {
    expect(typedAbsenceMarker({ truncated: false, hasMore: false, nextOffset: null })).toBeNull();
    expect(typedAbsenceMarker({ appliedScope: { object: 'Ghost__c' } })).toBeNull();
    expect(typedAbsenceMarker({ capped: false, limit: 50, offset: 0 })).toBeNull();
  });
});

describe('LAW 2 — pagination completeness', () => {
  /**
   * LIE 2 — `who_can_access_object` verbatim: 109 of 218 real rows shipped
   * with `hasMore: false` and `truncated: false`.
   */
  it('REJECTS a trimmed page that claims completeness', () => {
    const lie = envelopeOf({
      componentId: 'CustomObject:Account',
      granters: Array.from({ length: 109 }, (_, i) => ({ granterId: `Profile:P${String(i)}` })),
      totalCount: 218,
      limit: 120,
      offset: 0,
      hasMore: false,
      truncated: false,
      boundaries: ['object-level grants only; record-level sharing is not modeled.'],
    });

    const audit = auditEnvelope('sfi.who_can_access_object', lie);

    expect(audit.checks.pagination).toBe(1);
    const paging = audit.findings.filter((f) => f.rule === 'pagination-completeness');
    expect(paging).toHaveLength(1);
    expect(paging[0]?.path).toBe('totalCount');
    expect(paging[0]?.detail).toContain('218');
  });

  /** The honest counterpart: same 109 rows, the claim corrected. */
  it('ACCEPTS the same 109 rows once hasMore says so', () => {
    const honest = envelopeOf({
      componentId: 'CustomObject:Account',
      granters: Array.from({ length: 109 }, (_, i) => ({ granterId: `Profile:P${String(i)}` })),
      totalCount: 218,
      limit: 120,
      offset: 0,
      hasMore: true,
      nextOffset: 109,
      truncated: true,
      boundaries: ['object-level grants only; record-level sharing is not modeled.'],
    });

    const audit = auditEnvelope('sfi.who_can_access_object', honest);

    expect(audit.checks.pagination).toBe(1);
    expect(audit.findings.filter((f) => f.rule === 'pagination-completeness')).toEqual([]);
  });

  it('REJECTS a nextOffset that does not equal offset + rows.length', () => {
    const lie = envelopeOf({
      usages: [{ id: 'a' }, { id: 'b' }],
      totalCount: 40,
      offset: 10,
      limit: 25,
      hasMore: true,
      // Honest value would be 12. 35 points past eight rows the caller never saw.
      nextOffset: 35,
      boundaries: ['grep supplement is a literal text match.'],
    });

    const findings = auditEnvelope('sfi.find_code_usages', lie).findings;

    expect(findings.map((f) => f.path)).toContain('nextOffset');
    expect(
      auditEnvelope(
        'sfi.find_code_usages',
        envelopeOf({ ...(lie['data'] as Record<string, unknown>), nextOffset: 12 }),
      ).findings.filter((f) => f.path === 'nextOffset'),
    ).toEqual([]);
  });

  it('REJECTS hasMore:true with no way to reach the rest', () => {
    const lie = envelopeOf({
      rows: [{ id: 'a' }],
      totalCount: 118,
      returnedCount: 1,
      hasMore: true,
      nextOffset: null,
      boundaries: ['capped scan.'],
    });
    expect(
      auditEnvelope('sfi.query_graph', lie).findings.map((f) => f.path),
    ).toContain('hasMore');
  });

  it('REJECTS a payload contradicted by the response-budget guard', () => {
    // `jsonResult` stamps `responseBudget.truncated` AFTER the handler built
    // its page, so a handler flag left at `false` is false when printed.
    const lie = {
      ...envelopeOf({
        fields: [{ id: 'a' }],
        totalCount: 25,
        truncated: false,
        boundaries: ['eight-tier cross-walk.'],
      }),
      responseBudget: { applied: true, truncated: true, droppedCount: 24 },
    };
    expect(
      auditEnvelope('sfi.field_cleanup_candidates', lie).findings.map((f) => f.path),
    ).toContain('responseBudget.truncated');
  });

  it('REJECTS a returnedCount that describes no list in the payload', () => {
    const lie = envelopeOf({
      analyses: [{ id: 'a' }, { id: 'b' }],
      pageInfo: { totalCount: 212, returnedCount: 50, hasMore: true, nextCursor: 'abc' },
    });
    expect(
      auditEnvelope('sfi.list_analyses', lie).findings.map((f) => f.path),
    ).toContain('returnedCount');
  });

  /**
   * The counter-proof for Law 2: a genuinely complete page must pass. Without
   * this, a rule that flagged EVERY paginated payload would look like a
   * working gate.
   */
  it('ACCEPTS an exhausted page', () => {
    const honest = envelopeOf({
      matches: [{ id: 'a' }, { id: 'b' }],
      totalCount: 2,
      returnedCount: 2,
      limit: 25,
      offset: 0,
      hasMore: false,
      nextOffset: null,
      boundaries: ['matches are lexical, case-insensitive substring hits.'],
    });

    const audit = auditEnvelope('sfi.search_components', honest);
    expect(audit.checks.pagination).toBe(1);
    expect(audit.findings).toEqual([]);
  });
});

describe('LAW 3 — scope refusal', () => {
  const GHOST = 'Zzz_Nonexistent_Object_9x7__c';

  /**
   * LIE 3 — the headline 0.3.2 archetype: `{ fields: [], totalCount: 0 }` for
   * an object that DOES NOT EXIST. An unchecked zero wearing a checked zero's
   * clothes. Note it even carries `boundaries` and an `appliedScope`: a
   * payload can satisfy Law 1 and still be this lie, which is why Law 3 is a
   * separate law and not a marker check.
   */
  it('REJECTS a clean zero for an object that does not exist', () => {
    const lie = envelopeOf({
      appliedScope: { componentId: `CustomObject:${GHOST}`, object: GHOST },
      fields: [],
      totalCount: 0,
      boundaries: ['the scanner cannot see string-BUILT dynamic SOQL.'],
    });

    const audit = auditScopeRefusal('sfi.unused_fields_deep', 'objectApiName', GHOST, lie);

    expect(audit.checks.scopeRefusal).toBe(1);
    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]?.detail).toContain('CLEAN ZERO');
  });

  /** Worse than a clean zero: rows attributed to a component that is not there. */
  it('REJECTS fabricated rows for an object that does not exist', () => {
    const lie = envelopeOf({
      risks: [{ severity: 'high', summary: 'consider a before-save flow' }],
      recommendations: [{ summary: 'use a record-triggered flow' }],
      boundaries: ['advice is heuristic.'],
    });

    const audit = auditScopeRefusal('sfi.automation_build_advisor', 'objectApiName', GHOST, lie);

    expect(audit.findings).toHaveLength(1);
    expect(audit.findings[0]?.detail).toContain('FABRICATED ROWS');
  });

  /** The honest counterparts — both structured refusals the product already emits. */
  it('ACCEPTS invalid-query and component-not-found', () => {
    const invalidQuery = {
      error: {
        kind: 'invalid-query',
        message: `no object named '${GHOST}' exists in this vault`,
        path: 'objectApiName',
      },
    };
    const notFound = {
      error: {
        kind: 'component-not-found',
        message: `no CustomObject matches \`CustomObject:${GHOST}\` in this vault`,
      },
    };

    for (const refusal of [invalidQuery, notFound]) {
      const audit = auditScopeRefusal('sfi.unused_fields_deep', 'objectApiName', GHOST, refusal);
      expect(audit.checks.scopeRefusal).toBe(1);
      expect(audit.findings).toEqual([]);
    }
  });

  /** A crash is not a refusal. */
  it('REJECTS an `internal` error as a scope refusal', () => {
    const crash = { error: { kind: 'internal', message: 'boom' } };
    expect(
      auditScopeRefusal('sfi.pii_inventory', 'objectApiName', GHOST, crash).findings,
    ).toHaveLength(1);
  });
});

describe('LAW 0 — legacy stubs and the error vocabulary', () => {
  it('REJECTS both legacy stubs in the string AND the McpError form', () => {
    for (const stub of ['not-implemented', 'unknown-tool']) {
      expect(auditEnvelope('sfi.x', { error: stub }).findings).toHaveLength(1);
      expect(auditEnvelope('sfi.x', { error: { kind: stub, message: '' } }).findings).toHaveLength(1);
    }
  });

  /**
   * The original `assertNotStubEnvelope` compared `body.error` — a STRING — to
   * the stub names. Live handlers return `error` as an McpError OBJECT, so
   * that comparison could only ever fire on the legacy string form. This pins
   * the object form so the widening cannot be lost.
   */
  it('REJECTS an error.kind outside the McpError union', () => {
    const findings = auditEnvelope('sfi.x', {
      error: { kind: 'no-topic', message: 'unknown topic' },
    }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toContain('outside the McpError union');
  });

  it('ACCEPTS every kind the contract declares', () => {
    for (const kind of [
      'vault-missing',
      'vault-stale',
      'component-not-found',
      'invalid-query',
      'oversize',
      'internal',
    ]) {
      expect(auditEnvelope('sfi.x', { error: { kind, message: 'm' } }).findings).toEqual([]);
    }
  });
});

describe('anti-vacuity instrumentation', () => {
  /**
   * V2 — the failure mode where a law never fires and the silence reads as a
   * pass. A structured error has nothing to page and nothing to count, so the
   * absence laws must record ZERO evaluations rather than a silent success. A
   * sweep can then tell "the law passed" from "the law never ran".
   */
  it('reports zero evaluations for a payload no absence law applies to', () => {
    const audit = auditEnvelope('sfi.x', {
      error: { kind: 'invalid-query', message: 'm' },
    });
    expect(audit.checks.typedAbsence).toBe(0);
    expect(audit.checks.pagination).toBe(0);
    expect(audit.checks.legacyStub).toBe(1);
  });

  it('counts evaluations, not passes', () => {
    // An honest payload: zero findings, but the laws DID run.
    const audit = auditEnvelope(
      'sfi.x',
      envelopeOf({
        rows: [],
        totalCount: 0,
        hasMore: false,
        boundaries: ['scan boundary.'],
      }),
    );
    expect(audit.findings).toEqual([]);
    expect(audit.checks.typedAbsence).toBeGreaterThan(0);
    expect(audit.checks.pagination).toBe(1);
  });

  it('renders findings as a numbered report', () => {
    const audit = auditEnvelope('sfi.x', envelopeOf({ rows: [], totalCount: 0 }));
    const report = formatFindings(audit.findings);
    expect(report).toContain('[typed-absence] sfi.x @ rows');
  });
});

describe('marker-set drift', () => {
  /**
   * `ABSENCE_MARKER_KEYS` documents which keys type an absence, and
   * `typedAbsenceMarker` decides. A doc comment that merely CLAIMED the two
   * agree would drift the first time someone edited the function — the same
   * failure the duplicated disclosure wordings in `absence-disclosure.ts` hit.
   * This pins them together in both directions, so the list is a guard rather
   * than a comment and widening the accepted set has to be done in the open.
   */
  const minimalPayloadFor: Readonly<Record<string, Record<string, unknown>>> = {
    absence: { absence: { status: 'proven-none' } },
    absenceStatus: { absenceStatus: 'not-checked' },
    boundaries: { boundaries: ['a scan boundary.'] },
    completeness: { completeness: { status: 'partial' } },
    coverage: { coverage: { status: 'partial' } },
    coverageCaveat: { coverageCaveat: 'reports were not pulled.' },
    disclosure: { disclosure: 'freshness signals need an enriched refresh.' },
    evidenceEnvelope: { evidenceEnvelope: { absence: { status: 'not-checked' } } },
    limitations: { limitations: ['managed packages are opaque.'] },
    neverModeled: { neverModeled: true },
    notCheckedTypes: { notCheckedTypes: ['Report'] },
    notModeled: { notModeled: true },
    trust: { trust: { completeness: { status: 'partial' } } },
    uncheckedTypes: { uncheckedTypes: ['Dashboard'] },
  };

  it('accepts every key the documented marker set names', () => {
    // No key may be documented without a sample — an undocumented widening
    // would otherwise slip through as a missing map entry.
    expect(Object.keys(minimalPayloadFor).sort()).toEqual([...ABSENCE_MARKER_KEYS].sort());
    for (const key of ABSENCE_MARKER_KEYS) {
      expect(typedAbsenceMarker(minimalPayloadFor[key]), `marker '${key}'`).not.toBeNull();
    }
  });

  it('rejects every key the documented reject-list names, alone and together', () => {
    const all: Record<string, unknown> = {};
    for (const key of REJECTED_ABSENCE_MARKER_KEYS) {
      const single = { [key]: key === 'truncated' || key === 'hasMore' || key === 'capped' ? false : 0 };
      expect(typedAbsenceMarker(single), `rejected marker '${key}'`).toBeNull();
      all[key] = single[key];
    }
    // Even all of them at once must not add up to a typed absence.
    expect(typedAbsenceMarker(all)).toBeNull();
  });
});

/**
 * LAW 2's document-shaped branch — the exemption, and its fence.
 *
 * Two of the pagination predicates compare a published count against the
 * longest array the payload shipped. That is sound for a list and a guaranteed
 * false accusation for a GENERATOR, whose rows are rendered into
 * `document.body` and whose only arrays are metadata (`boundaries[]`).
 *
 * An exemption with no fence is just a hole, so both directions are asserted:
 * the generator shape is exempt, and every near-miss is NOT.
 */
describe('pagination completeness — the document-shaped exemption is fenced', () => {
  const GENERATOR_DOC = {
    frontmatter: {
      title: 'Compliance Report',
      generatedAt: '2026-08-28T00:00:00.000Z',
      sourceTreeHash: 'sha256:fixture',
      componentIds: [],
    },
    body: 'x'.repeat(400),
    sectionConfidence: {},
    boundaries: ['a boundary'],
  };
  // A count that names no array: the exact shape both predicates fire on.
  const page = { totalCount: 305, returnedCount: 1, hasMore: true, nextCursor: 'tok' };

  const paginationFindings = (data: Record<string, unknown>): readonly HonestyFinding[] =>
    auditEnvelope('sfi.probe', envelopeOf(data)).findings.filter(
      (f) => f.rule === 'pagination-completeness',
    );

  it('EXEMPT: a real GeneratedDocument payload is not accused of withholding rows', () => {
    expect(paginationFindings({ document: GENERATOR_DOC, pageInfo: page })).toEqual([]);
  });

  it('and the exemption is COUNTED, never silent', () => {
    const { checks } = auditEnvelope('sfi.probe', envelopeOf({ document: GENERATOR_DOC, pageInfo: page }));
    expect(checks.paginationDocumentShaped).toBe(1);
    // A list-shaped payload must not increment it.
    const list = auditEnvelope('sfi.probe', envelopeOf({ rows: [1], pageInfo: page }));
    expect(list.checks.paginationDocumentShaped ?? 0).toBe(0);
  });

  for (const [why, doc] of [
    ['`document` is a bare string, not the declared object', 'x'.repeat(400)],
    ['`document` is an ARRAY of rows wearing the name', [1, 2, 3]],
    ['no frontmatter — any object could claim the exemption otherwise', { body: 'x'.repeat(400) }],
    [
      'frontmatter without a sourceTreeHash',
      { frontmatter: { title: 't' }, body: 'x'.repeat(400) },
    ],
    [
      'a body too short to be a rendered document',
      { frontmatter: { sourceTreeHash: 'sha256:x' }, body: 'tiny' },
    ],
  ] as const) {
    it(`NOT EXEMPT: ${why}`, () => {
      const findings = paginationFindings({ document: doc, pageInfo: page });
      expect(
        findings.length,
        'a near-miss of the generator shape must still be measured — otherwise the ' +
          'exemption is a rename away for any list-shaped tool',
      ).toBeGreaterThan(0);
    });
  }
});
