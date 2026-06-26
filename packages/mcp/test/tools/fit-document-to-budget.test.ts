/// <reference types="vitest/globals" />

import type { ComponentId } from '@sf-intelligence/contracts';

import type { GeneratedDocument } from '../../src/tools/generate-data-dictionary.js';
import {
  fitDocumentToBudget,
  generatedDocByteBudget,
  renderFooter,
  splitBodyIntoSections,
} from '../../src/tools/generate-data-dictionary.js';

/** The renderFooter block every generator emits as the LAST body element. */
const FOOTER = renderFooter(
  '2026-05-27T14:33:08Z',
  'Re-run `sfi.generate_data_dictionary({ objectId: \'CustomObject:Account\' })` after the next `sfi refresh`.',
);

/** Build a `## Section N` block padded to roughly `padBytes` bytes. */
const makeSection = (n: number, padBytes: number): string => {
  const filler = 'x'.repeat(Math.max(0, padBytes));
  return [`## Section ${n.toString()}`, '', `Body for section ${n.toString()}: ${filler}`].join(
    '\n',
  );
};

/** Assemble a GeneratedDocument body: H1 + preamble head, sections, footer. */
const makeDoc = (
  sections: readonly string[],
  footer = FOOTER,
): GeneratedDocument => {
  const body = [
    '# Account — Data Dictionary',
    '',
    '_(preamble paragraph before the first H2)_',
    '',
    ...sections.flatMap((s) => [s, '']),
    footer,
  ].join('\n');
  return {
    frontmatter: {
      title: 'Account — Data Dictionary',
      generatedAt: '2026-06-26T00:00:00Z',
      sourceTreeHash: 'sha256:fixture',
      componentIds: ['CustomObject:Account', 'CustomField:Account.Industry__c'],
    },
    body,
    sectionConfidence: {
      'Section 1': 'declared',
      'Section 2': 'declared',
    },
    boundaries: [
      'Generated from offline vault; missing real-time data.',
      'Section confidence is inherited from the source edges.',
    ],
  };
};

const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** A run of realistic canonical component ids, for provenance-bloat docs. */
const makeIds = (n: number): ComponentId[] => {
  const types = ['CustomObject', 'CustomField', 'ApexClass', 'Flow', 'ValidationRule', 'PermissionSet'];
  return Array.from(
    { length: n },
    (_, i) => `${types[i % types.length]}:Component_${i.toString()}__c.Field_${i.toString()}__c` as ComponentId,
  );
};

/**
 * Build an admin_handbook-shaped doc: a large `componentIds[]` provenance list
 * (the real bloat for the union-everything generators) over a small readable
 * body. `idCount` controls the provenance size; the body stays ~2 KB.
 */
const makeBloatedIdsDoc = (idCount: number): GeneratedDocument => {
  const body = [
    '# Org — Admin Handbook',
    '',
    '## Overview',
    '',
    'This org contains many components across schema, automation, and permissions.',
    '',
    '## Key Objects',
    '',
    ...Array.from({ length: 20 }, (_, i) => `- \`CustomObject:Object_${i.toString()}__c\` — some description here`),
    '',
    FOOTER,
  ].join('\n');
  return {
    frontmatter: {
      title: 'Org — Admin Handbook',
      generatedAt: '2026-06-26T00:00:00Z',
      sourceTreeHash: 'sha256:abcdef0123456789',
      componentIds: makeIds(idCount),
    },
    body,
    sectionConfidence: { Overview: 'declared', 'Key Objects': 'declared' },
    boundaries: [
      'Generated from offline vault on 2026-05-27T14:33:08Z; missing real-time data.',
      'Section confidence is inherited from the source edges.',
    ],
  };
};

describe('fitDocumentToBudget', () => {
  it('FAIL-BEFORE / PASS-AFTER: preserves the honesty footer when dropping oversized sections', () => {
    // Many ~4 KB sections so the doc is far over an 8 KB budget.
    const sections = Array.from({ length: 12 }, (_, i) => makeSection(i + 1, 4_000));
    const doc = makeDoc(sections);

    // Sanity: the unfitted doc is genuinely over budget (the H7 condition).
    expect(byteLen(doc)).toBeGreaterThan(8_000);

    const fitted = fitDocumentToBudget(doc, 8_000);

    // The footer (the disclosures the 1024-char cut would have destroyed) survives.
    expect(fitted.body).toContain('## Boundaries');
    expect(fitted.body).toContain('## How To Regenerate');
    expect(fitted.body).toContain(
      'Generated from offline vault on 2026-05-27T14:33:08Z',
    );

    // A truncation note is present and names at least one dropped section + the remedy.
    expect(fitted.body).toContain('## Truncation Note');
    expect(fitted.body).toMatch(/`Section \d+`/);
    expect(fitted.body).toMatch(/objectFilter|pagination|personaFocus/);

    // GUARANTEE (not just symptom): the full serialized doc actually fits, so the
    // global guard's slimDataStrings never engages on document.body downstream.
    expect(byteLen(fitted)).toBeLessThanOrEqual(8_000);

    // frontmatter is untouched.
    expect(fitted.frontmatter).toEqual(doc.frontmatter);
  });

  it('SMALL-DOC IDENTITY: an under-budget doc is returned unchanged (referential)', () => {
    const doc = makeDoc([makeSection(1, 50), makeSection(2, 50)]);
    expect(byteLen(doc)).toBeLessThanOrEqual(34_000);

    const fitted = fitDocumentToBudget(doc, 34_000);

    // Same object reference — no spread, no new body, no note.
    expect(fitted).toBe(doc);
    expect(fitted.body).not.toContain('## Truncation Note');
  });

  it('FOOTER-NEVER-DROPPED EDGE: under extreme pressure the Boundaries footer still survives', () => {
    // A budget so tiny that even head + footer + note + ONE section cannot fit;
    // the helper must drop ALL middle sections rather than sacrifice the footer.
    const sections = Array.from({ length: 6 }, (_, i) => makeSection(i + 1, 6_000));
    const doc = makeDoc(sections);

    const fitted = fitDocumentToBudget(doc, 1_500);

    // The honesty footer is STILL present.
    expect(fitted.body).toContain('## Boundaries');
    expect(fitted.body).toContain('## How To Regenerate');
    // And a truncation note explains the gap.
    expect(fitted.body).toContain('## Truncation Note');
    // Every middle section was dropped to make head + footer + note fit.
    expect(fitted.body).not.toContain('## Section 1');
    expect(fitted.body).not.toContain('## Section 6');
  });

  it('BUDGET-ALIGNMENT: an admin_handbook-sized doc (832 ids, ~2KB body, ~37KB) passes byte-identical at the real budget', () => {
    // 832 componentIds = ~34 KB provenance, ~2 KB readable body — the exact
    // shape the CR-08 regression over-truncated. With the corrected budget
    // (cap - measured envelope overhead ~= 38_976) the full envelope is under
    // the global cap, so the doc must pass UNCHANGED (no truncation, no note).
    const doc = makeBloatedIdsDoc(832);
    const budget = generatedDocByteBudget();

    // Sanity: it really is the under-cap admin/onboarding case (~37 KB doc).
    expect(byteLen(doc)).toBeGreaterThan(35_000);
    expect(byteLen(doc)).toBeLessThanOrEqual(budget);

    const fitted = fitDocumentToBudget(doc, budget);

    // Referential identity — same object, no spread, no note, ids untouched.
    expect(fitted).toBe(doc);
    expect(fitted.body).not.toContain('## Truncation Note');
    expect(fitted.frontmatter.componentIds).toHaveLength(832);
  });

  it('REDUCTION-PRIORITY: a genuinely-oversized doc (5000 ids) trims componentIds FIRST, preserving the readable body', () => {
    // 5000 ids = ~225 KB of provenance over a ~2 KB body — far over budget,
    // but the bloat is the id list, NOT readable content.
    const doc = makeBloatedIdsDoc(5_000);
    const budget = generatedDocByteBudget();
    expect(byteLen(doc)).toBeGreaterThan(budget);

    const fitted = fitDocumentToBudget(doc, budget);

    // componentIds were trimmed to the sample (NOT the full 5000), with a count.
    expect(fitted.frontmatter.componentIds.length).toBeLessThan(5_000);
    expect(fitted.frontmatter.componentIds.length).toBeLessThanOrEqual(25);
    // Provenance order preserved — the sample is the FIRST ids.
    expect(fitted.frontmatter.componentIds[0]).toBe(doc.frontmatter.componentIds[0]);

    // The READABLE body survived — trimming ids alone was enough, so no section
    // was dropped. Both detail sections remain.
    expect(fitted.body).toContain('## Overview');
    expect(fitted.body).toContain('## Key Objects');

    // The trim is disclosed honestly: a note with the dropped-id count, AND the
    // footer is intact.
    expect(fitted.body).toContain('## Truncation Note');
    expect(fitted.body).toMatch(/and 4975 more components/);
    expect(fitted.body).toContain('## Boundaries');
    expect(fitted.body).toContain('## How To Regenerate');

    // GUARANTEE: the full serialized doc actually fits the budget now.
    expect(byteLen(fitted)).toBeLessThanOrEqual(budget);
  });

  it('REDUCTION-PRIORITY-THEN-SECTIONS: ids-trim alone insufficient → body sections drop tail-first, footer + body head survive', () => {
    // Many large body sections AND a large id list so trimming ids is NOT
    // enough — the helper must ALSO drop sections, but only AFTER the ids.
    const sections = Array.from({ length: 10 }, (_, i) => makeSection(i + 1, 4_000));
    const base = makeDoc(sections);
    const doc: GeneratedDocument = {
      ...base,
      frontmatter: { ...base.frontmatter, componentIds: makeIds(2_000) },
    };
    const budget = 8_000;
    expect(byteLen(doc)).toBeGreaterThan(budget);

    const fitted = fitDocumentToBudget(doc, budget);

    // Step 1 happened: ids trimmed to the sample.
    expect(fitted.frontmatter.componentIds.length).toBeLessThanOrEqual(25);
    // Step 2 happened: at least one body section dropped (tail-first).
    expect(fitted.body).toContain('## Truncation Note');
    expect(fitted.body).toMatch(/`Section \d+`/);
    // Note discloses BOTH the id trim and the dropped sections.
    expect(fitted.body).toMatch(/componentIds/);
    expect(fitted.body).toMatch(/readable section/);
    // Footer always preserved.
    expect(fitted.body).toContain('## Boundaries');
    expect(fitted.body).toContain('## How To Regenerate');
    // It actually fits.
    expect(byteLen(fitted)).toBeLessThanOrEqual(budget);
  });

  it('FOOTER-MISSING DEFENSE: a doc with no Boundaries footer is returned unchanged', () => {
    // Use a non-renderFooter tail so there is no `## Boundaries` anchor at all.
    const sections = Array.from({ length: 8 }, (_, i) => makeSection(i + 1, 4_000));
    const noFooter = '## Closing\n\nNo boundaries here.';
    const doc = makeDoc(sections, noFooter);
    expect(byteLen(doc)).toBeGreaterThan(8_000);

    const fitted = fitDocumentToBudget(doc, 8_000);

    // Never risk dropping content when there is no honesty footer to anchor on.
    expect(fitted).toBe(doc);
    expect(fitted.body).not.toContain('## Truncation Note');
  });
});

describe('splitBodyIntoSections', () => {
  it('SPLIT-FIDELITY: keeps ### subheadings and ```mermaid fences bound to their parent ## section', () => {
    const body = [
      '# Title',
      '',
      '_(preamble)_',
      '',
      '## Alpha',
      '',
      '### Sub Alpha',
      '',
      'detail',
      '',
      '## Beta',
      '',
      '```mermaid',
      'graph TD',
      '## not a heading — inside a fence',
      '```',
      '',
      FOOTER,
    ].join('\n');

    const { head, sections, footer } = splitBodyIntoSections(body);

    expect(head).toContain('# Title');
    expect(head).toContain('_(preamble)_');
    expect(head).not.toContain('## Alpha');

    // Exactly two middle sections — the fenced `## not a heading` did NOT split Beta.
    expect(sections).toHaveLength(2);
    const alpha = sections[0] ?? '';
    const beta = sections[1] ?? '';
    expect(alpha).toContain('## Alpha');
    expect(alpha).toContain('### Sub Alpha');
    expect(beta).toContain('## Beta');
    expect(beta).toContain('## not a heading — inside a fence');
    expect(beta).toContain('```mermaid');

    // Footer captures Boundaries + How To Regenerate together.
    expect(footer).not.toBeNull();
    expect(footer ?? '').toContain('## Boundaries');
    expect(footer ?? '').toContain('## How To Regenerate');
  });

  it('returns footer=null when there is no ## Boundaries anchor', () => {
    const body = ['# Title', '', '## Alpha', '', 'x', '', '## Closing', '', 'y'].join('\n');
    const { footer } = splitBodyIntoSections(body);
    expect(footer).toBeNull();
  });
});
