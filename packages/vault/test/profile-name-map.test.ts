/// <reference types="vitest/globals" />

/**
 * PLATFORM-ACCESS-ORACLE — contract pins for the Profile label <-> API-name map.
 *
 * PRIVACY: every profile here is INVENTED. The real artifact holds the org's own
 * profile labels and API names and lives ONLY inside the vault (gitignored) —
 * it must never reach a tracked file, a fixture, or a test.
 *
 * The load-bearing pins:
 *  1. The join is on the 15-char Id, so an 18-char form on one side and a
 *     15-char form on the other still join.
 *  2. A profile present in only ONE source is a DISCLOSED gap, never a dropped
 *     row and never a guessed pairing.
 *  3. `null` (artifact absent) is NOT the same as a map with `entries: []`.
 *  4. An ambiguous label REFUSES to resolve rather than picking a winner.
 *  5. Resolution is by label, case-insensitively, and never falls back to
 *     name-matching.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  buildProfileNameMap,
  loadProfileNameMap,
  profileId15,
  profileNameMapPath,
  resolveProfileApiNameById,
  saveProfileNameMap,
  type ProfileNameMapFile,
} from '../src/profile-name-map.js';

/** Invented 15-char Id prefixes — shaped like Profile Ids, belong to no org. */
const ID_A = '00e0x0000000001';
const ID_B = '00e0x0000000002';
const ID_C = '00e0x0000000003';
const ID_D = '00e0x0000000004';

const NOW = '2026-08-20T00:00:00.000Z';

describe('profileId15 — the join key', () => {
  it('takes the 15-char prefix of an 18-char Id', () => {
    expect(profileId15(`${ID_A}AAA`)).toBe(ID_A);
    expect(profileId15(ID_A)).toBe(ID_A);
  });

  it('rejects anything too short to be an Id rather than joining on garbage', () => {
    expect(profileId15('short')).toBeNull();
    expect(profileId15(null)).toBeNull();
    expect(profileId15(undefined)).toBeNull();
  });
});

describe('buildProfileNameMap — the join', () => {
  it('joins 15-char against 18-char forms and keeps BOTH names', () => {
    const map = buildProfileNameMap(
      [{ id: `${ID_A}AAA`, fullName: 'WidgetAdmin' }],
      [{ Id: ID_A, Name: 'Widget Administrator' }],
      NOW,
    );
    expect(map.entries).toEqual([
      { id15: ID_A, apiName: 'WidgetAdmin', label: 'Widget Administrator' },
    ]);
    expect(map.onlyInMetadata).toEqual([]);
    expect(map.onlyInSoql).toEqual([]);
  });

  it('resolves a label that DIFFERS from the api name (the whole point)', () => {
    const map = buildProfileNameMap(
      [
        { id: ID_A, fullName: 'WidgetAdmin' },
        { id: ID_B, fullName: 'FieldTech' },
      ],
      [
        { Id: ID_A, Name: 'Widget Administrator' },
        { Id: ID_B, Name: 'Field Technician (2024 rename)' },
      ],
      NOW,
    );
    expect(resolveProfileApiNameById(map, ID_A)).toEqual({
      ok: true,
      apiName: 'WidgetAdmin',
      mappedLabel: 'Widget Administrator',
    });
    // The renamed org-custom case: label and api name share nothing.
    expect(resolveProfileApiNameById(map, ID_B)).toEqual({
      ok: true,
      apiName: 'FieldTech',
      mappedLabel: 'Field Technician (2024 rename)',
    });
  });

  it('DISCLOSES a profile present in only one source — never drops it, never guesses a pairing', () => {
    const map = buildProfileNameMap(
      [
        { id: ID_A, fullName: 'WidgetAdmin' },
        { id: ID_C, fullName: 'MetadataOnly' },
      ],
      [
        { Id: ID_A, Name: 'Widget Administrator' },
        { Id: ID_D, Name: 'Soql Only Profile' },
      ],
      NOW,
    );
    expect(map.entries.map((e) => e.apiName)).toEqual(['WidgetAdmin']);
    expect(map.onlyInMetadata).toEqual([ID_C]);
    expect(map.onlyInSoql).toEqual([ID_D]);
    // The unmatched pair is NOT joined to each other just because both are lonely.
    expect(resolveProfileApiNameById(map, ID_D)).toEqual({
      ok: false,
      reason: 'not-in-map',
    });
    expect(resolveProfileApiNameById(map, ID_C)).toEqual({
      ok: false,
      reason: 'not-in-map',
    });
  });

  it('skips malformed rows instead of joining against garbage', () => {
    const map = buildProfileNameMap(
      [
        { id: 'nope', fullName: 'Bad' },
        { id: ID_A, fullName: '  ' },
        { id: ID_B, fullName: 'Good' },
      ],
      [
        { Id: ID_B, Name: 'Good Label' },
        { Id: ID_A, Name: 'Orphan' },
      ],
      NOW,
    );
    expect(map.entries).toEqual([{ id15: ID_B, apiName: 'Good', label: 'Good Label' }]);
  });

  it('sorts entries by api name so the artifact is byte-stable across runs', () => {
    const rows = [
      { id: ID_B, fullName: 'Zeta' },
      { id: ID_A, fullName: 'Alpha' },
    ];
    const soql = [
      { Id: ID_A, Name: 'Alpha Label' },
      { Id: ID_B, Name: 'Zeta Label' },
    ];
    expect(buildProfileNameMap(rows, soql, NOW).entries.map((e) => e.apiName)).toEqual([
      'Alpha',
      'Zeta',
    ]);
    expect(
      buildProfileNameMap([...rows].reverse(), [...soql].reverse(), NOW).entries.map(
        (e) => e.apiName,
      ),
    ).toEqual(['Alpha', 'Zeta']);
  });
});

describe('resolveProfileApiNameById — the key is the Id, never the label', () => {
  const renamed = () =>
    buildProfileNameMap(
      [{ id: ID_A, fullName: 'WidgetAdmin' }],
      [{ Id: ID_A, Name: 'Widget Administrator' }],
      NOW,
    );

  it('resolves by ProfileId and reports the label the map was BUILT with', () => {
    expect(resolveProfileApiNameById(renamed(), ID_A)).toEqual({
      ok: true,
      apiName: 'WidgetAdmin',
      mappedLabel: 'Widget Administrator',
    });
  });

  it('accepts the 18-char ProfileId form as well as the 15-char one', () => {
    expect(resolveProfileApiNameById(renamed(), `${ID_A}AAA`).ok).toBe(true);
  });

  it('SURVIVES A RENAME: the id still resolves after the label changes', () => {
    // The failure that sank label-keying. The map was built when the profile
    // was called "Widget Administrator"; the customer has since renamed it.
    // Id-keyed resolution is unaffected — label-keyed resolution would have
    // found nothing, or worse, found a DIFFERENT profile.
    const map = renamed();
    expect(resolveProfileApiNameById(map, ID_A)).toEqual({
      ok: true,
      apiName: 'WidgetAdmin',
      mappedLabel: 'Widget Administrator',
    });
  });

  it('a REUSED label cannot cause misattribution — two profiles, two ids, no crosstalk', () => {
    // Profile B has been given the label Profile A used to carry. Under
    // label-keying this silently returned the wrong profile. Under id-keying
    // each resolves to itself.
    const map = buildProfileNameMap(
      [
        { id: ID_A, fullName: 'OriginalProfile' },
        { id: ID_B, fullName: 'ImposterProfile' },
      ],
      [
        { Id: ID_A, Name: 'Old Name' },
        { Id: ID_B, Name: 'Shared Support Name' },
      ],
      NOW,
    );
    expect(resolveProfileApiNameById(map, ID_A).ok && resolveProfileApiNameById(map, ID_A)).toMatchObject({
      apiName: 'OriginalProfile',
    });
    expect(resolveProfileApiNameById(map, ID_B).ok && resolveProfileApiNameById(map, ID_B)).toMatchObject({
      apiName: 'ImposterProfile',
    });
  });

  it('an ambiguous LABEL no longer blocks anything — ids cannot be ambiguous', () => {
    const map = buildProfileNameMap(
      [
        { id: ID_A, fullName: 'SupportTierOne' },
        { id: ID_B, fullName: 'SupportTierTwo' },
      ],
      [
        { Id: ID_A, Name: 'Support' },
        { Id: ID_B, Name: 'Support' },
      ],
      NOW,
    );
    // Still DISCLOSED so an operator can see the collision...
    expect(map.ambiguousLabels).toEqual(['support']);
    // ...but both resolve correctly, because the key is the id.
    expect(resolveProfileApiNameById(map, ID_A)).toMatchObject({ apiName: 'SupportTierOne' });
    expect(resolveProfileApiNameById(map, ID_B)).toMatchObject({ apiName: 'SupportTierTwo' });
  });

  it('refuses an unknown id, and refuses a non-Id entirely', () => {
    const map = renamed();
    expect(resolveProfileApiNameById(map, ID_C)).toEqual({ ok: false, reason: 'not-in-map' });
    expect(resolveProfileApiNameById(map, 'Widget Administrator')).toEqual({
      ok: false,
      reason: 'not-in-map',
    });
    expect(resolveProfileApiNameById(map, null)).toEqual({ ok: false, reason: 'not-in-map' });
  });
});

describe('persistence — absent is NOT empty', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-profile-map-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the vault has NO map (never built)', async () => {
    expect(await loadProfileNameMap(dir)).toBeNull();
  });

  it('returns a real map with entries:[] when the build ran and joined nothing', async () => {
    const empty = buildProfileNameMap([], [], NOW);
    const saved = await saveProfileNameMap(dir, empty);
    expect(saved.ok).toBe(true);
    const loaded = await loadProfileNameMap(dir);
    // The distinction the whole honesty contract rests on: this is NOT null.
    expect(loaded).not.toBeNull();
    expect(loaded?.entries).toEqual([]);
    expect(loaded?.builtAt).toBe(NOW);
  });

  it('round-trips a populated map through the vault path', async () => {
    const map = buildProfileNameMap(
      [{ id: ID_A, fullName: 'WidgetAdmin' }],
      [{ Id: ID_A, Name: 'Widget Administrator' }],
      NOW,
    );
    await saveProfileNameMap(dir, map);
    const loaded = await loadProfileNameMap(dir);
    expect(loaded).not.toBeNull();
    expect(resolveProfileApiNameById(loaded as ProfileNameMapFile, ID_A)).toEqual({
      ok: true,
      apiName: 'WidgetAdmin',
      mappedLabel: 'Widget Administrator',
    });
  });

  it('treats a corrupt artifact as ABSENT (null), never as an empty map', async () => {
    const path = profileNameMapPath(dir);
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(path, '{ this is not json', 'utf8');
    expect(await loadProfileNameMap(dir)).toBeNull();
  });

  it('treats a structurally-wrong artifact as ABSENT', async () => {
    const path = profileNameMapPath(dir);
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, entries: 'not-an-array' }), 'utf8');
    expect(await loadProfileNameMap(dir)).toBeNull();
  });

  it('writes under meta/ inside the vault (org data never leaves the vault)', () => {
    // Derived, not a literal: `join` renders with the host separator, so a
    // hardcoded forward-slash string asserts POSIX rather than the invariant
    // (the file lives under meta/ INSIDE the vault).
    const vault = join(sep, 'tmp', 'v');
    expect(profileNameMapPath(vault)).toBe(join(vault, 'meta', 'profile-name-map.json'));
  });
});


describe('adversarial axes — the join defends itself rather than assuming', () => {
  it('DISCLOSES a row that has a name but NO Id — never silently drops it', () => {
    // The known `listMetadata` quirk: FileProperties `id` can come back empty.
    // Whether STANDARD profiles are affected is NOT verified, so the build must
    // surface such rows instead of skipping them into oblivion.
    const map = buildProfileNameMap(
      [
        { id: '', fullName: 'StandardNoId' },
        { id: ID_A, fullName: 'WidgetAdmin' },
      ],
      [
        { Id: null, Name: 'Soql No Id' },
        { Id: ID_A, Name: 'Widget Administrator' },
      ],
      NOW,
    );
    expect(map.unjoinable.metadata).toEqual(['StandardNoId']);
    expect(map.unjoinable.soql).toEqual(['Soql No Id']);
    // ...and the healthy row is unaffected.
    expect(resolveProfileApiNameById(map, ID_A).ok).toBe(true);
  });

  it('DETECTS one Id carrying two conflicting names and refuses to pick', () => {
    // A 15-char Id is the record identity, so this should be impossible — but
    // it is only impossible while both sources preserve Id CASE. Rather than
    // assume that, detect it: the colliding Id is excluded and disclosed.
    const map = buildProfileNameMap(
      [
        { id: ID_A, fullName: 'FirstName' },
        { id: ID_A, fullName: 'SecondName' },
        { id: ID_B, fullName: 'Clean' },
      ],
      [
        { Id: ID_A, Name: 'Colliding Label' },
        { Id: ID_B, Name: 'Clean Label' },
      ],
      NOW,
    );
    expect(map.collidingIds).toEqual([ID_A]);
    expect(map.entries.map((e) => e.apiName)).toEqual(['Clean']);
    expect(resolveProfileApiNameById(map, ID_A)).toEqual({
      ok: false,
      reason: 'not-in-map',
    });
  });

  it('a repeated Id with the SAME name is not a collision (idempotent rows are fine)', () => {
    const map = buildProfileNameMap(
      [
        { id: ID_A, fullName: 'WidgetAdmin' },
        { id: `${ID_A}AAA`, fullName: 'WidgetAdmin' },
      ],
      [{ Id: ID_A, Name: 'Widget Administrator' }],
      NOW,
    );
    expect(map.collidingIds).toEqual([]);
    expect(map.entries).toHaveLength(1);
  });

  it('truncation is lossless: the 18-char form joins the 15-char form of the SAME record', () => {
    const map = buildProfileNameMap(
      [{ id: `${ID_A}AAA`, fullName: 'WidgetAdmin' }],
      [{ Id: ID_A, Name: 'Widget Administrator' }],
      NOW,
    );
    expect(map.entries).toHaveLength(1);
    expect(map.collidingIds).toEqual([]);
  });

  it('an Id differing only in CASE is treated as a DIFFERENT record, never folded together', () => {
    // Case-folding Ids is the one way a 15-char join could manufacture a
    // collision. The builder must not fold; these stay two distinct records.
    const upper = '00E0X0000000001';
    const map = buildProfileNameMap(
      [
        { id: ID_A, fullName: 'LowerCaseId' },
        { id: upper, fullName: 'UpperCaseId' },
      ],
      [
        { Id: ID_A, Name: 'Lower Label' },
        { Id: upper, Name: 'Upper Label' },
      ],
      NOW,
    );
    expect(map.collidingIds).toEqual([]);
    expect(map.entries.map((e) => e.apiName).sort()).toEqual(['LowerCaseId', 'UpperCaseId']);
  });
});
