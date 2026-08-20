/// <reference types="vitest/globals" />

/**
 * PLATFORM-ACCESS-ORACLE — contract pins for the parity engine.
 *
 * Pure and hermetic: no org, no vault, no network. The engine is fed the two
 * data structures and the verdicts are asserted directly.
 *
 * Fixtures use the REAL observed flag combination from a live sandbox
 * (`R=true C=false E=true D=false Undel=true FLS=true`) rather than a tidy
 * invention — the platform's answer is the ground truth by definition here, so
 * the tests must reflect a real one.
 *
 * The load-bearing pins:
 *  1. All four verdicts are reachable and distinct.
 *  2. OFFLINE OVERSTATES is hoisted into its own list — never folded into a
 *     count with understatements.
 *  3. A missing platform row is UNKNOWN with a named reason, NEVER "no access"
 *     and never a quiet AGREE.
 *  4. The four unmapped verbs stay UNKNOWN — no invented equivalence.
 *  5. `fullAgreement` requires every comparable pair to have been ADJUDICATED,
 *     so a run where the platform answered nothing is not "full agreement"
 *     just because it found no disagreement.
 */

import type { ObjectPermissionFlag } from '@sf-intelligence/contracts';
import type { UserEntityAccessRow } from '@sf-intelligence/tooling-api';

import {
  ACCESS_VERB_MAPPING,
  COMPARABLE_VERBS,
  diffAccessParity,
  PARITY_UNKNOWN_GLOSSARY,
  type OfflineObjectAccess,
} from '../../src/tools/platform-access-parity.js';

const flags = (o: Partial<Record<ObjectPermissionFlag, boolean>>): Record<ObjectPermissionFlag, boolean> => ({
  allowCreate: false,
  allowRead: false,
  allowEdit: false,
  allowDelete: false,
  viewAllRecords: false,
  modifyAllRecords: false,
  ...o,
});

/**
 * The REAL observed row: readable + editable + undeletable + FLS-updatable,
 * NOT creatable, NOT deletable. Do not "fix" the combination.
 */
const observed = (entity: string): UserEntityAccessRow => ({
  EntityDefinitionId: entity,
  IsReadable: true,
  IsCreatable: false,
  IsEditable: true,
  IsDeletable: false,
  IsUndeletable: true,
  IsFlsUpdatable: true,
});

const offline = (
  object: string,
  o: Partial<Record<ObjectPermissionFlag, boolean>>,
  overrides: Partial<OfflineObjectAccess> = {},
): OfflineObjectAccess => ({
  object,
  vaultHasObject: true,
  flags: flags(o),
  ...overrides,
});

const verdictFor = (
  report: ReturnType<typeof diffAccessParity>,
  object: string,
  verb: string,
): string | undefined =>
  report.objects
    .find((o) => o.object === object)
    ?.verbs.find((v) => v.verb === verb)?.verdict;

describe('the verb mapping table', () => {
  it('marks exactly four verbs comparable and names a justification for every row', () => {
    expect([...COMPARABLE_VERBS]).toEqual(['read', 'create', 'edit', 'delete']);
    for (const m of ACCESS_VERB_MAPPING) {
      expect(m.justification.length, `${m.verb} has no justification`).toBeGreaterThan(20);
      // A row is comparable IFF both sides exist. Nothing is "comparable" on
      // one side only — that is exactly the invented-equivalence trap.
      expect(m.comparable).toBe(m.offlineFlag !== null && m.platformField !== null);
    }
  });

  it('refuses to map undelete / IsFlsUpdatable and viewAll / modifyAll', () => {
    const byVerb = new Map(ACCESS_VERB_MAPPING.map((m) => [m.verb, m]));
    expect(byVerb.get('undelete')?.offlineFlag).toBeNull();
    expect(byVerb.get('flsUpdatable')?.offlineFlag).toBeNull();
    expect(byVerb.get('viewAllRecords')?.platformField).toBeNull();
    expect(byVerb.get('modifyAllRecords')?.platformField).toBeNull();
    // The tempting near-misses are NOT used anywhere in the table.
    expect(ACCESS_VERB_MAPPING.some((m) => m.verb === 'undelete' && m.offlineFlag === 'allowDelete')).toBe(false);
  });
});

describe('diffAccessParity — the four verdicts', () => {
  // Offline says read+edit (matching the platform), claims create (the platform
  // denies it), and misses delete... except the platform denies delete too, so
  // we drive UNDERSTATES through `IsUndeletable`-free territory: the platform
  // grants read, and a second object where offline has no read.
  const report = diffAccessParity(
    [
      // AGREE on read/edit; OVERSTATES create; AGREE on delete (both false).
      offline('Account', { allowRead: true, allowEdit: true, allowCreate: true }),
      // UNDERSTATES read (platform true, offline false).
      offline('Contact', {}),
    ],
    [observed('Account'), observed('Contact')],
  );

  it('AGREE when both sides say the same thing on a 1:1-mapped verb', () => {
    expect(verdictFor(report, 'Account', 'read')).toBe('agree');
    expect(verdictFor(report, 'Account', 'edit')).toBe('agree');
    // Both false is agreement too — the platform confirmed a NEGATIVE.
    expect(verdictFor(report, 'Account', 'delete')).toBe('agree');
  });

  it('OFFLINE OVERSTATES when the offline engine claims access the platform denies', () => {
    expect(verdictFor(report, 'Account', 'create')).toBe('offline-overstates');
    expect(report.overstatements).toEqual([
      { object: 'Account', verb: 'create', offline: true, platform: false },
    ]);
  });

  it('OFFLINE UNDERSTATES when the platform grants what the offline engine misses', () => {
    expect(verdictFor(report, 'Contact', 'read')).toBe('offline-understates');
    expect(verdictFor(report, 'Contact', 'edit')).toBe('offline-understates');
    expect(
      report.understatements.map((d) => `${d.object}.${d.verb}`).sort(),
    ).toEqual(['Contact.edit', 'Contact.read']);
  });

  it('UNKNOWN for every verb with no clean 1:1 mapping — no invented equivalence', () => {
    for (const object of ['Account', 'Contact']) {
      expect(verdictFor(report, object, 'undelete')).toBe('unknown');
      expect(verdictFor(report, object, 'flsUpdatable')).toBe('unknown');
      expect(verdictFor(report, object, 'viewAllRecords')).toBe('unknown');
      expect(verdictFor(report, object, 'modifyAllRecords')).toBe('unknown');
    }
    const undelete = report.objects[0]?.verbs.find((v) => v.verb === 'undelete');
    expect(undelete?.unknownReason).toBe('no-offline-equivalent');
    // The platform value is carried through UNJUDGED, not dropped.
    expect(undelete?.platform).toBe(true);
    expect(undelete?.offline).toBeNull();

    const viewAll = report.objects[0]?.verbs.find((v) => v.verb === 'viewAllRecords');
    expect(viewAll?.unknownReason).toBe('no-platform-column');
    expect(viewAll?.platform).toBeNull();
  });

  it('keeps overstatements OUT of the understatement list and vice versa', () => {
    expect(report.counts.offlineOverstates).toBe(1);
    expect(report.counts.offlineUnderstates).toBe(2);
    expect(report.overstatements.some((d) => d.object === 'Contact')).toBe(false);
    expect(report.understatements.some((d) => d.object === 'Account')).toBe(false);
  });

  it('ranks the per-object worstVerdict overstates > understates > unknown > agree', () => {
    expect(report.objects.find((o) => o.object === 'Account')?.worstVerdict).toBe(
      'offline-overstates',
    );
    expect(report.objects.find((o) => o.object === 'Contact')?.worstVerdict).toBe(
      'offline-understates',
    );
  });
});

describe('diffAccessParity — a missing platform row is silence, not denial', () => {
  const report = diffAccessParity(
    [offline('Account', { allowRead: true }), offline('Ghost__c', { allowRead: true })],
    [observed('Account')], // nothing came back for Ghost__c
  );

  it('marks every verb on the unanswered object UNKNOWN with the row reason', () => {
    for (const verb of COMPARABLE_VERBS) {
      expect(verdictFor(report, 'Ghost__c', verb)).toBe('unknown');
    }
    const read = report.objects
      .find((o) => o.object === 'Ghost__c')
      ?.verbs.find((v) => v.verb === 'read');
    expect(read?.unknownReason).toBe('platform-returned-no-row');
    expect(read?.platform).toBeNull();
    // The offline value is still carried so the reader can see what WOULD have
    // been compared — it is simply not adjudicated.
    expect(read?.offline).toBe(true);
  });

  it('never counts an unanswered object as an agreement or a disagreement', () => {
    expect(report.overstatements.some((d) => d.object === 'Ghost__c')).toBe(false);
    expect(report.understatements.some((d) => d.object === 'Ghost__c')).toBe(false);
    expect(report.objectsPlatformDidNotAnswer).toEqual(['Ghost__c']);
    expect(report.objects.find((o) => o.object === 'Ghost__c')?.platformAnswered).toBe(false);
  });

  it('spells out in the glossary that a missing row is NOT evidence of no access', () => {
    expect(PARITY_UNKNOWN_GLOSSARY['platform-returned-no-row']).toMatch(/NOT evidence/i);
  });
});

describe('diffAccessParity — an object the vault never modeled has no offline answer', () => {
  it('is UNKNOWN with `object-not-in-vault`, never a proven offline denial', () => {
    const report = diffAccessParity(
      [{ object: 'Unmodeled__c', vaultHasObject: false, flags: null }],
      [observed('Unmodeled__c')],
    );
    const read = report.objects[0]?.verbs.find((v) => v.verb === 'read');
    expect(read?.verdict).toBe('unknown');
    expect(read?.unknownReason).toBe('object-not-in-vault');
    expect(read?.offline).toBeNull();
    // Critically: the platform GRANTS read here, and the engine still does NOT
    // call it an understatement — we have no offline answer to understate.
    expect(read?.platform).toBe(true);
    expect(report.understatements).toEqual([]);
    expect(report.objectsNotInVault).toEqual(['Unmodeled__c']);
  });

  it('distinguishes "vault knows it, nothing grants it" (a real NO) from "not modeled"', () => {
    // Same absent objectMap row, but the vault DOES model the object: that is a
    // definite offline "no", so the platform's yes IS an understatement.
    const report = diffAccessParity(
      [{ object: 'Account', vaultHasObject: true, flags: null }],
      [observed('Account')],
    );
    expect(verdictFor(report, 'Account', 'read')).toBe('offline-understates');
  });
});

describe('diffAccessParity — fullAgreement is not the absence of disagreement', () => {
  it('is true only when every comparable pair was adjudicated and agreed', () => {
    const report = diffAccessParity(
      [offline('Account', { allowRead: true, allowEdit: true })],
      [observed('Account')],
    );
    expect(report.counts.offlineOverstates).toBe(0);
    expect(report.counts.offlineUnderstates).toBe(0);
    expect(report.counts.agree).toBe(COMPARABLE_VERBS.length);
    expect(report.fullAgreement).toBe(true);
  });

  it('is FALSE when the platform answered nothing, even though nothing disagreed', () => {
    const report = diffAccessParity([offline('Account', { allowRead: true })], []);
    expect(report.overstatements).toEqual([]);
    expect(report.understatements).toEqual([]);
    expect(report.counts.agree).toBe(0);
    expect(report.fullAgreement).toBe(false);
  });

  it('is FALSE on an empty request (nothing was checked)', () => {
    const report = diffAccessParity([], []);
    expect(report.fullAgreement).toBe(false);
  });
});

describe('diffAccessParity — platform casing is not a missing row', () => {
  it('matches a row the platform echoed with different casing', () => {
    const report = diffAccessParity(
      [offline('account', { allowRead: true, allowEdit: true })],
      [observed('Account')],
    );
    expect(report.objectsPlatformDidNotAnswer).toEqual([]);
    expect(verdictFor(report, 'account', 'read')).toBe('agree');
  });
});
