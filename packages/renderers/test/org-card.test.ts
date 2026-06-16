/// <reference types="vitest/globals" />

import {
  ORG_CARD_MAX_BYTES,
  renderOrgCard,
  type OrgCardInput,
} from '../src/org-card.js';

/**
 * P13-CARD-render — pure-renderer tests: determinism (same input → same
 * bytes), the 16KB hard cap with deterministic trimming, every number in the
 * body traceable to the input, and the wall-clock stamp confined to the
 * frontmatter.
 */

const baseInput = (): OrgCardInput => ({
  generatedAt: '2026-06-10T01:02:03.000Z',
  sourceTreeHash: 'sha256:cardfixture',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  targetOrg: 'card-fixture-org',
  componentCounts: [
    ['CustomField', 240],
    ['CustomObject', 31],
    ['Flow', 12],
  ],
  totalComponents: 283,
  totalEdges: 944,
  coverage: {
    status: 'partial',
    coveredTypeCount: 18,
    partialTypes: ['Report'],
    notModeledTypes: ['Territory2', 'SharingSet'],
    erroredTypes: ['Dashboard'],
  },
  topObjects: [
    { id: 'CustomObject:Case_Log__c' as never, inboundRefs: 57 },
    { id: 'CustomObject:Account' as never, inboundRefs: 41 },
  ],
  objectScanCount: 31,
  automation: [
    { type: 'Flow', total: 12, active: 9 },
    { type: 'ApexTrigger', total: 7, active: 7 },
  ],
  permissions: {
    profileCount: 3,
    permissionSetCount: 14,
    godModeContainers: 2,
    godModeScanCount: 17,
  },
  integrations: [
    ['NamedCredential', 4],
    ['AuthProvider', 1],
  ],
  naming: [{ pattern: 'Custom fields end in __c suffix groups', matching: 200, total: 240 }],
});

describe('renderOrgCard', () => {
  it('is deterministic: identical input renders byte-identical body and json', () => {
    const a = renderOrgCard(baseInput());
    const b = renderOrgCard(baseInput());
    expect(a.body).toBe(b.body);
    expect(JSON.stringify(a.json)).toBe(JSON.stringify(b.json));
  });

  it('keeps the wall-clock stamp in frontmatter/json only — never the body', () => {
    const r = renderOrgCard(baseInput());
    expect(r.frontmatter['generatedAt']).toBe('2026-06-10T01:02:03.000Z');
    expect(r.body).not.toContain('2026-06-10T01:02:03.000Z');
    // the REFRESH stamp is graph-derived state and allowed; the render-time
    // stamp is what must not leak.
  });

  it('every headline number in the body comes from the input (re-derivable)', () => {
    const input = baseInput();
    const r = renderOrgCard(input);
    expect(r.body).toContain('283 components, 944 dependency edges');
    expect(r.body).toContain('| CustomField | 240 |');
    expect(r.body).toContain('`CustomObject:Case_Log__c` | 57');
    expect(r.body).toContain('| Flow | 12 | 9 |');
    expect(r.body).toContain('3 profiles, 14 permission sets. 2 of 17');
    expect(r.body).toContain('NamedCredential: 4 · AuthProvider: 1');
    expect(r.body).toContain('(200/240 fields)');
    expect(r.body).toContain('**partial** — 18 metadata families');
    expect(r.body).toContain('NOT modeled (2 families');
    expect(r.body).toContain('Errored at retrieve: Dashboard');
  });

  it('coverage & blind spots render BEFORE the scale section', () => {
    const r = renderOrgCard(baseInput());
    expect(r.body.indexOf('## Coverage & blind spots')).toBeLessThan(
      r.body.indexOf('## Scale'),
    );
  });

  it('enforces the 16KB hard cap with deterministic trimming and a disclosure', () => {
    const huge: OrgCardInput = {
      ...baseInput(),
      componentCounts: Array.from({ length: 60 }, (_, i) => [`Type_${String(i).padStart(3, '0')}`, 1000 - i] as const),
      topObjects: Array.from({ length: 20 }, (_, i) => ({
        id: `CustomObject:Very_Long_Object_Name_For_Cap_Testing_${String(i).padStart(2, '0')}__c` as never,
        inboundRefs: 500 - i,
      })),
      naming: Array.from({ length: 5 }, (_, i) => ({
        pattern: `Observed naming pattern number ${i} with quite a long explanatory statement attached to it ${'x'.repeat(2_400)}`,
        matching: 100 - i,
        total: 120,
      })),
    };
    const a = renderOrgCard(huge);
    const b = renderOrgCard(huge);
    expect(Buffer.byteLength(a.body, 'utf8')).toBeLessThanOrEqual(ORG_CARD_MAX_BYTES);
    expect(a.trimmed).toBe(true);
    expect(a.body).toContain('trimmed to keep this card under its size cap');
    expect(a.body).toBe(b.body); // trimming is deterministic too
  });

  it('renders honestly-empty sections for a sparse vault', () => {
    const sparse: OrgCardInput = {
      ...baseInput(),
      integrations: [],
      naming: [],
    };
    const r = renderOrgCard(sparse);
    expect(r.body).toContain('No integration components retrieved');
    expect(r.body).not.toContain('## Naming conventions');
    expect(r.trimmed).toBe(false);
  });
});
