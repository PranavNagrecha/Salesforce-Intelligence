/**
 * PLATFORM-ACCESS-ORACLE — the Profile Id ↔ API-name map.
 *
 * ## The gap this closes
 *
 * SOQL exposes `User.Profile.Name`, which is the profile's **label** ("System
 * Administrator"). Every offline surface in this product keys Profile nodes by
 * the metadata **API name** ("Admin") — the `.profile-meta.xml` file name. No
 * SOQL field returns the API name, and nothing in this repo mapped between
 * them, so any tool that starts from a live user and needs that user's OFFLINE
 * profile container had no way to get there.
 *
 * Measured on a real org: 52 profiles, 43 (83%) where label happens to equal
 * API name, 9 (17%) where it does not — and **3 of those 9 were org-custom
 * profiles**, not Salesforce standards. A profile renamed after creation keeps
 * its original API name forever. That is why a static standard-profile alias
 * table is NOT sufficient and is deliberately not what this module does.
 *
 * ## The join
 *
 * ```
 * sf org list metadata -m Profile  ->  { id, fullName }   fullName IS the API name
 * SELECT Id, Name FROM Profile     ->  { Id,  Name }      Name     IS the label
 * join on the 15-char Id           ->  52 of 52. COMPLETE.
 * ```
 *
 * The 15-char prefix is the join key because the two sources disagree on case
 * sensitivity handling of the 18-char form. An exact-Id join also finds MORE
 * divergence than name matching does (11 of 52 rows have `label !== apiName`,
 * vs the 9 name-matching notices), so it is both complete and strictly more
 * accurate than any heuristic.
 *
 * The shortcut that does NOT work, checked and rejected: the backing
 * `PermissionSet` where `IsOwnedByProfile = true` does not carry the profile
 * API name — its `Name` is an auto-generated internal id.
 *
 * ## Honesty contract
 *
 *   - **`null` (artifact absent) is NOT an empty map.** `loadProfileNameMap`
 *     returns `null` when the vault has no map (never built, or unreadable),
 *     and a real {@link ProfileNameMapFile} — possibly with `entries: []` —
 *     when the build ran. A consumer must treat those differently: absent means
 *     "we never asked", empty means "we asked and got nothing".
 *   - **A profile in one source but not the other is a DISCLOSED gap, never a
 *     dropped row.** `onlyInMetadata` / `onlyInSoql` carry those ids.
 *   - **Resolution is keyed on ProfileId, never on the label.** Labels are
 *     mutable and re-usable; a rename between refreshes would make a
 *     label-keyed lookup silently return a DIFFERENT profile. `ambiguousLabels`
 *     is still recorded, but only as a disclosure — it can no longer affect a
 *     lookup, because ids cannot be ambiguous.
 *
 * ## Privacy
 *
 * This artifact contains the ORG'S OWN profile labels and API names. It lives
 * ONLY inside the vault (`{vaultRoot}/meta/profile-name-map.json`, gitignored)
 * and must never be written into a tracked file, a fixture, or a test. Tests
 * use invented profiles.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';

import { vaultPaths } from './layout.js';

/** Bumped on a breaking change to the persisted shape. */
export const PROFILE_NAME_MAP_VERSION = 1;

/** One joined profile: its Id, its metadata API name, and its SOQL label. */
export interface ProfileNameEntry {
  /** 15-char Id prefix — the join key. */
  readonly id15: string;
  /** `fullName` from `sf org list metadata -m Profile`. The vault node key. */
  readonly apiName: string;
  /** `Name` from `SELECT Id, Name FROM Profile`. What SOQL shows a user. */
  readonly label: string;
}

/** The persisted artifact. */
export interface ProfileNameMapFile {
  readonly version: number;
  /** ISO-8601 build time — a stale map is still a map, but say how old. */
  readonly builtAt: string;
  readonly entries: readonly ProfileNameEntry[];
  /**
   * Ids returned by `list metadata` with no matching SOQL row. Disclosed, not
   * dropped: these profiles have an API name but no known label, so a
   * label-keyed lookup can never reach them.
   */
  readonly onlyInMetadata: readonly string[];
  /**
   * Ids returned by SOQL with no matching `list metadata` row. Disclosed, not
   * dropped: these have a label but no known API name, so resolving them would
   * require a guess.
   */
  readonly onlyInSoql: readonly string[];
  /**
   * Labels claimed by more than one profile. DISCLOSURE ONLY — resolution is
   * keyed on ProfileId, so an ambiguous label can no longer mis-resolve
   * anything. Kept because it tells an operator their org has label collisions.
   */
  readonly ambiguousLabels: readonly string[];
  /**
   * Rows that carried a usable NAME but no usable Id, so they could not enter
   * the join at all — disclosed, never silently dropped.
   *
   * This is the shape a known `listMetadata` quirk takes: FileProperties `id`
   * is documented to be empty for some components, and whether STANDARD
   * profiles are among them is NOT verified here. If they are, they land in
   * `metadata` below, they never resolve, and every consumer refuses for them
   * — an honest refusal with a named cause, rather than a wrong answer.
   */
  readonly unjoinable: {
    /** `fullName`s from `list metadata` that had no Id. */
    readonly metadata: readonly string[];
    /** `Name`s from SOQL that had no Id. */
    readonly soql: readonly string[];
  };
  /**
   * 15-char Ids that appeared MORE THAN ONCE within a single source carrying
   * CONFLICTING names.
   *
   * A 15-char Salesforce Id is the record identity (the 18-char form is the
   * same Id plus a case-insensitivity checksum), so truncating 15<-18 is
   * lossless and two distinct records cannot legitimately collide. It is
   * case-SENSITIVE, though, so a source that ever case-folded an Id could
   * manufacture one. Rather than assume neither source does, the build DETECTS
   * it: a colliding Id is excluded from `entries` entirely and listed here, and
   * anything it touched refuses to resolve. An unverifiable assumption becomes
   * a runtime-checked, fail-closed condition.
   */
  readonly collidingIds: readonly string[];
}

export interface ProfileNameMapError {
  readonly kind: 'write-failed';
  readonly message: string;
  readonly path?: string;
}

/** A `sf org list metadata -m Profile --json` row (only the fields we use). */
export interface ProfileMetadataListRow {
  readonly id?: string | null;
  readonly fullName?: string | null;
}

/** A `SELECT Id, Name FROM Profile` row. */
export interface ProfileSoqlRow {
  readonly Id?: string | null;
  readonly Name?: string | null;
}

/**
 * Normalize a Salesforce Id to its 15-char case-sensitive prefix — the join
 * key. Returns `null` for anything that is not plausibly an Id, so a malformed
 * row is skipped rather than joined against garbage.
 */
export const profileId15 = (id: string | null | undefined): string | null => {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (trimmed.length < 15) return null;
  return trimmed.slice(0, 15);
};

const nonEmpty = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Join the two org reads into a map. PURE — no I/O, no clock (pass `builtAt`).
 *
 * @example
 *   const map = buildProfileNameMap(metadataRows, soqlRows, new Date().toISOString());
 *   resolveProfileApiNameById(map, user.ProfileId); // -> { ok: true, apiName: 'Admin' }
 */
export const buildProfileNameMap = (
  metadataRows: readonly ProfileMetadataListRow[],
  soqlRows: readonly ProfileSoqlRow[],
  builtAt: string,
): ProfileNameMapFile => {
  // Pass 1 per source: index by id15 while DETECTING (a) rows with a name but
  // no Id — the `listMetadata` empty-id quirk — and (b) one Id carrying two
  // conflicting names, which a 15-char truncation is not supposed to be able
  // to produce. Neither is dropped; both are disclosed and both fail closed.
  const indexSource = <T>(
    rows: readonly T[],
    idOf: (row: T) => string | null | undefined,
    nameOf: (row: T) => string | null | undefined,
  ): {
    readonly byId: Map<string, string>;
    readonly noId: string[];
    readonly colliding: Set<string>;
  } => {
    const byId = new Map<string, string>();
    const noId: string[] = [];
    const colliding = new Set<string>();
    for (const row of rows) {
      const name = nonEmpty(nameOf(row));
      const id = profileId15(idOf(row));
      if (name === null) continue; // nothing usable at all — not a profile row
      if (id === null) {
        // Has a name, has no Id: cannot enter the join. DISCLOSE it.
        noId.push(name);
        continue;
      }
      const seen = byId.get(id);
      if (seen === undefined) {
        byId.set(id, name);
      } else if (seen !== name) {
        // Same Id, two different names. Do not pick one.
        colliding.add(id);
      }
    }
    for (const id of colliding) byId.delete(id);
    return { byId, noId, colliding };
  };

  const meta = indexSource(
    metadataRows,
    (r) => r.id,
    (r) => r.fullName,
  );
  const soql = indexSource(
    soqlRows,
    (r) => r.Id,
    (r) => r.Name,
  );

  const collidingIds = [...new Set([...meta.colliding, ...soql.colliding])].sort();

  const entries: ProfileNameEntry[] = [];
  const onlyInMetadata: string[] = [];
  for (const [id15, apiName] of meta.byId) {
    const label = soql.byId.get(id15);
    if (label === undefined) {
      onlyInMetadata.push(id15);
      continue;
    }
    entries.push({ id15, apiName, label });
  }

  const onlyInSoql: string[] = [];
  for (const id15 of soql.byId.keys()) {
    if (!meta.byId.has(id15)) onlyInSoql.push(id15);
  }

  // A label claimed by two DIFFERENT profiles cannot be resolved to one API
  // name. Detect it here so the resolver never has to guess.
  const labelCounts = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.label.toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const ambiguousLabels = [...labelCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([label]) => label)
    .sort();

  entries.sort((a, b) => a.apiName.localeCompare(b.apiName));
  return {
    version: PROFILE_NAME_MAP_VERSION,
    builtAt,
    entries,
    onlyInMetadata: onlyInMetadata.sort(),
    onlyInSoql: onlyInSoql.sort(),
    ambiguousLabels,
    unjoinable: {
      metadata: meta.noId.sort(),
      soql: soql.noId.sort(),
    },
    collidingIds,
  };
};

/** Why a profile could not be turned into an API name. */
export type ProfileResolutionFailure = 'not-in-map';

export type ProfileApiNameResolution =
  | {
      readonly ok: true;
      readonly apiName: string;
      /** The label the map recorded at BUILD time — not necessarily current. */
      readonly mappedLabel: string;
    }
  | { readonly ok: false; readonly reason: ProfileResolutionFailure };

/**
 * Resolve a Salesforce **ProfileId** to its metadata API name.
 *
 * THE KEY IS THE ID, DELIBERATELY. An earlier design keyed this on the profile
 * LABEL (`User.Profile.Name`) and that was wrong in a way that matters: labels
 * are MUTABLE and RE-USABLE. Rename a profile between two refreshes — or free a
 * label and re-apply it to a different profile — and a label-keyed lookup
 * silently resolves to the WRONG profile, then diffs the user against a
 * container bundle that is not theirs. On a security question, a confidently
 * wrong answer is the worst possible failure, and it would look exactly like a
 * genuine permission finding. Ids do not move.
 *
 * `id` may be the 15- or 18-char form; it is normalized to the 15-char join key.
 * Unknown ids REFUSE — there is no name-matching fallback anywhere in this
 * module.
 */
export const resolveProfileApiNameById = (
  map: ProfileNameMapFile,
  id: string | null | undefined,
): ProfileApiNameResolution => {
  const key = profileId15(id);
  if (key === null) return { ok: false, reason: 'not-in-map' };
  const hit = map.entries.find((e) => e.id15 === key);
  return hit === undefined
    ? { ok: false, reason: 'not-in-map' }
    : { ok: true, apiName: hit.apiName, mappedLabel: hit.label };
};

/** `{vaultRoot}/meta/profile-name-map.json`. */
export const profileNameMapPath = (vaultRoot: string): string =>
  vaultPaths(vaultRoot).profileNameMap;

const isEntry = (value: unknown): value is ProfileNameEntry => {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['id15'] === 'string' &&
    typeof r['apiName'] === 'string' &&
    typeof r['label'] === 'string'
  );
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * Read the map, or `null` when the vault has none.
 *
 * `null` means ABSENT — never built, unreadable, or structurally invalid. It is
 * NOT the same as a map with `entries: []`, which means the build ran and
 * joined nothing. Consumers must distinguish the two: absent is "we never
 * asked", empty is "we asked and the answer was nothing".
 */
export const loadProfileNameMap = async (
  vaultRoot: string,
): Promise<ProfileNameMapFile | null> => {
  try {
    const raw = await readFile(profileNameMapPath(vaultRoot), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj['entries'])) return null;
    if (typeof obj['builtAt'] !== 'string') return null;
    return {
      version:
        typeof obj['version'] === 'number' ? obj['version'] : PROFILE_NAME_MAP_VERSION,
      builtAt: obj['builtAt'],
      entries: obj['entries'].filter(isEntry),
      onlyInMetadata: stringList(obj['onlyInMetadata']),
      onlyInSoql: stringList(obj['onlyInSoql']),
      ambiguousLabels: stringList(obj['ambiguousLabels']),
      unjoinable: {
        metadata: stringList(
          (obj['unjoinable'] as Record<string, unknown> | undefined)?.['metadata'],
        ),
        soql: stringList(
          (obj['unjoinable'] as Record<string, unknown> | undefined)?.['soql'],
        ),
      },
      collidingIds: stringList(obj['collidingIds']),
    };
  } catch {
    return null;
  }
};

/** Atomically persist the map (temp file + rename), creating `meta/`. */
export const saveProfileNameMap = async (
  vaultRoot: string,
  map: ProfileNameMapFile,
): Promise<Result<ProfileNameMapFile, ProfileNameMapError>> => {
  const path = profileNameMapPath(vaultRoot);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return ok(map);
  } catch (cause) {
    return err({
      kind: 'write-failed',
      message: cause instanceof Error ? cause.message : String(cause),
      path,
    });
  }
};
