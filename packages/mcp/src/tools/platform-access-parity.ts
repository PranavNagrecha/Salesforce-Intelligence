/**
 * PLATFORM-ACCESS-ORACLE — the parity engine.
 *
 * `computeEffectiveGrants` (see `effective-permissions.ts`) reconstructs a
 * user's effective object access OFFLINE by re-implementing Salesforce's own
 * precedence rules over vault metadata: profile grants unioned with permission
 * sets, permission-set groups net of their muting sets, max-wins throughout.
 * That reconstruction is the product's moat — it answers with no org
 * connection — and it is also hundreds of lines of code that cannot tell you
 * when it is wrong.
 *
 * `UserEntityAccess` is Salesforce answering the same question itself. This
 * module is the *comparison*: given the offline engine's computed access and
 * the platform's verdict for the SAME user and the SAME objects, it produces a
 * structured per-object, per-verb diff.
 *
 * It is deliberately PURE — no org, no vault, no I/O, no clock. Feed it two
 * data structures, get a diff. That is what makes the parity claim testable.
 *
 * It is also a LEAF: its only imports are the Salesforce object-permission
 * vocabulary from `@sf-intelligence/contracts` and the row type from
 * `@sf-intelligence/tooling-api`. It deliberately does NOT import
 * `effective-permissions.ts` — an oracle that depended on the engine it audits
 * would be able to drift with it, and a ~1,000-line tool module is the wrong
 * thing for a pure comparison function to hang off.
 *
 * ## The four verdicts
 *
 *   - **AGREE** — offline and platform said the same thing for a verb that has
 *     a clean 1:1 mapping. This is the only verdict that is evidence the
 *     offline engine is right, and it is only as strong as the verb mapping.
 *   - **OFFLINE UNDERSTATES** — the platform grants it, the offline engine says
 *     no. The known systematic instance: `computeEffectiveGrants` never expands
 *     permission DEPENDENCIES (a permission that implies another), so it
 *     under-reports by construction. `ViewAllData` / `ModifyAllData` held by
 *     any container is a second known cause — a blanket system permission
 *     confers object access the per-object `grantedBy` edges never carry.
 *   - **OFFLINE OVERSTATES** — the offline engine says yes, the platform says
 *     no. The dangerous direction: the product would be telling someone access
 *     exists when it does not. Never fold this into "understates" or bury it
 *     in a count.
 *   - **UNKNOWN** — the comparison could not be made. Four structurally
 *     distinct reasons, each named on the row (see {@link ParityUnknownReason});
 *     UNKNOWN is never a soft AGREE and never a soft "no access".
 *
 * ## The verb mapping (and where it deliberately refuses to map)
 *
 * | verb               | offline (`objectPermissions`) | platform (`UserEntityAccess`) | mapping |
 * |--------------------|-------------------------------|-------------------------------|---------|
 * | `read`             | `allowRead`                   | `IsReadable`                  | 1:1     |
 * | `create`           | `allowCreate`                 | `IsCreatable`                 | 1:1     |
 * | `edit`             | `allowEdit`                   | `IsEditable`                  | 1:1     |
 * | `delete`           | `allowDelete`                 | `IsDeletable`                 | 1:1     |
 * | `undelete`         | — (none)                      | `IsUndeletable`               | UNKNOWN |
 * | `flsUpdatable`     | — (none)                      | `IsFlsUpdatable`              | UNKNOWN |
 * | `viewAllRecords`   | `viewAllRecords`              | — (no column)                 | UNKNOWN |
 * | `modifyAllRecords` | `modifyAllRecords`            | — (no column)                 | UNKNOWN |
 *
 * Why the four refusals, spelled out, because a tidier table would be a lie:
 *
 *   - **`undelete`** — Salesforce's declarative `<objectPermissions>` metadata
 *     has exactly six flags and undelete is not one of them. Undelete rights
 *     follow from record ownership / `ModifyAllRecords` / `ModifyAllData` at
 *     runtime. There is no offline flag to compare against, so mapping it to
 *     `allowDelete` (the tempting move — the names rhyme) would manufacture
 *     agreement out of nothing.
 *   - **`flsUpdatable`** — an ENTITY-level roll-up of field-level security. The
 *     offline engine models FLS per FIELD (`EffectiveGrantSet.fieldMap`), not
 *     as an object-level boolean. Rolling the field map up to "any field
 *     editable" would be a *new* inference of ours being scored against the
 *     platform, not a comparison of the engine's actual output — and it would
 *     silently pass or fail on how completely FLS was extracted. Left UNKNOWN
 *     until the field-level oracle (a separate object) is built.
 *   - **`viewAllRecords` / `modifyAllRecords`** — record-SCOPE permissions.
 *     `UserEntityAccess` has no column for either; its six flags are about
 *     entity access, not row visibility. The platform's record-scope answer
 *     lives in `UserRecordAccess`, which is per-RECORD, not per-object.
 *     Comparing `viewAllRecords` to `IsReadable` would conflate "can see the
 *     object" with "can see every row of it".
 *
 * The mapping is exported as data ({@link ACCESS_VERB_MAPPING}) so consumers
 * disclose the same table they diff against, rather than restating it in prose
 * that can drift.
 */

import {
  OBJECT_PERMISSION_FLAGS,
  type ObjectPermissionFlag,
} from '@sf-intelligence/contracts';
import type { UserEntityAccessRow } from '@sf-intelligence/tooling-api';

/** The verdict for one (object, verb) comparison. */
export type ParityVerdict =
  | 'agree'
  | 'offline-understates'
  | 'offline-overstates'
  | 'unknown';

/** Why a comparison could not be made. Always present on an `unknown` row. */
export type ParityUnknownReason =
  /** `UserEntityAccess` has no column for this verb (record-scope perms). */
  | 'no-platform-column'
  /** No offline flag models this verb (undelete, entity-level FLS roll-up). */
  | 'no-offline-equivalent'
  /** The platform returned no row for this object — NOT "no access". */
  | 'platform-returned-no-row'
  /** The vault never modeled this object, so the offline engine has no answer. */
  | 'object-not-in-vault';

/** The comparison axes, in canonical order. */
export const ACCESS_VERBS = [
  'read',
  'create',
  'edit',
  'delete',
  'undelete',
  'flsUpdatable',
  'viewAllRecords',
  'modifyAllRecords',
] as const;

export type AccessVerb = (typeof ACCESS_VERBS)[number];

/** The `UserEntityAccess` boolean columns this engine reads. */
export type PlatformAccessField =
  | 'IsReadable'
  | 'IsCreatable'
  | 'IsEditable'
  | 'IsDeletable'
  | 'IsUndeletable'
  | 'IsFlsUpdatable';

/** One row of the verb mapping table documented in the module header. */
export interface VerbMapping {
  readonly verb: AccessVerb;
  /** The offline `objectPermissions` flag, or `null` when none models it. */
  readonly offlineFlag: ObjectPermissionFlag | null;
  /** The `UserEntityAccess` column, or `null` when the object has none. */
  readonly platformField: PlatformAccessField | null;
  /** True only when both sides exist and mean the same thing. */
  readonly comparable: boolean;
  /** Why this row maps the way it does — surfaced verbatim to consumers. */
  readonly justification: string;
}

/**
 * The verb mapping, as data. Consumers echo this alongside the diff so the
 * reader can audit the comparison rather than trusting it.
 */
export const ACCESS_VERB_MAPPING: readonly VerbMapping[] = Object.freeze([
  {
    verb: 'read',
    offlineFlag: 'allowRead',
    platformField: 'IsReadable',
    comparable: true,
    justification:
      'Direct 1:1: the declarative <objectPermissions><allowRead> flag the offline engine unions max-wins is the same object-read right UserEntityAccess.IsReadable reports.',
  },
  {
    verb: 'create',
    offlineFlag: 'allowCreate',
    platformField: 'IsCreatable',
    comparable: true,
    justification:
      'Direct 1:1: <allowCreate> vs IsCreatable. Observed on a real org to move INDEPENDENTLY of IsEditable (C=false with E=true), so it is compared on its own axis and never inferred from another verb.',
  },
  {
    verb: 'edit',
    offlineFlag: 'allowEdit',
    platformField: 'IsEditable',
    comparable: true,
    justification:
      'Direct 1:1: <allowEdit> vs IsEditable. This is object-level edit, NOT field-level updatability (see flsUpdatable).',
  },
  {
    verb: 'delete',
    offlineFlag: 'allowDelete',
    platformField: 'IsDeletable',
    comparable: true,
    justification:
      'Direct 1:1: <allowDelete> vs IsDeletable.',
  },
  {
    verb: 'undelete',
    offlineFlag: null,
    platformField: 'IsUndeletable',
    comparable: false,
    justification:
      'NO offline equivalent. Salesforce <objectPermissions> carries six flags and undelete is not among them; undelete follows from ownership / ModifyAllRecords / ModifyAllData at runtime. Mapping it to allowDelete would manufacture agreement, so it is reported UNKNOWN and the platform value is carried through unjudged.',
  },
  {
    verb: 'flsUpdatable',
    offlineFlag: null,
    platformField: 'IsFlsUpdatable',
    comparable: false,
    justification:
      'NO clean offline equivalent. IsFlsUpdatable is an ENTITY-level field-level-security roll-up; the offline engine models FLS per FIELD (fieldMap), never as an object boolean. Rolling the field map up to "any field editable" would score a NEW inference of ours against the platform rather than the engine\'s actual output, and would pass or fail on FLS extraction completeness. Reported UNKNOWN pending a field-level oracle.',
  },
  {
    verb: 'viewAllRecords',
    offlineFlag: 'viewAllRecords',
    platformField: null,
    comparable: false,
    justification:
      'NO platform column. viewAllRecords is a record-SCOPE permission; UserEntityAccess reports entity access, not row visibility. The platform answers record scope through UserRecordAccess, which is per-RECORD. Comparing it to IsReadable would conflate "can see the object" with "can see every row".',
  },
  {
    verb: 'modifyAllRecords',
    offlineFlag: 'modifyAllRecords',
    platformField: null,
    comparable: false,
    justification:
      'NO platform column, for the same reason as viewAllRecords: record scope is not entity access, and UserEntityAccess has no column for it.',
  },
]);

/** The verbs that CAN be adjudicated. Everything else is UNKNOWN by design. */
export const COMPARABLE_VERBS: readonly AccessVerb[] = Object.freeze(
  ACCESS_VERB_MAPPING.filter((m) => m.comparable).map((m) => m.verb),
);

/**
 * The offline engine's answer for ONE object.
 *
 * `vaultHasObject` is separate from `flags` on purpose. The offline engine's
 * `objectMap` having no entry for an object is AMBIGUOUS: it means either "the
 * vault knows this object and no container grants anything on it" (a definite
 * offline NO) or "the vault never modeled this object at all" (no offline
 * answer exists). Collapsing those two would let an unmodeled object masquerade
 * as a proven denial — exactly the overstatement class this whole engine is
 * built to catch. The caller must resolve it and say which.
 */
export interface OfflineObjectAccess {
  readonly object: string;
  /** True when the vault actually models this object. */
  readonly vaultHasObject: boolean;
  /**
   * The offline net flags. `null` when the object has no `objectMap` row; with
   * `vaultHasObject: true` that is read as all-false (a definite offline "no").
   */
  readonly flags: Readonly<Record<ObjectPermissionFlag, boolean>> | null;
  /** Containers the offline engine credits for the grant (attribution). */
  readonly grantedBy?: readonly string[];
}

/** One adjudicated (object, verb) pair. */
export interface VerbParity {
  readonly verb: AccessVerb;
  readonly verdict: ParityVerdict;
  /** The offline answer, or `null` when the offline side has none. */
  readonly offline: boolean | null;
  /** The platform answer, or `null` when the platform side has none. */
  readonly platform: boolean | null;
  /** Present iff `verdict === 'unknown'`. */
  readonly unknownReason?: ParityUnknownReason;
  /** Human-readable one-liner for every row, agreement included. */
  readonly note: string;
}

/** The full comparison for one object. */
export interface ObjectParity {
  readonly object: string;
  /** False when the platform returned no row (never read as "no access"). */
  readonly platformAnswered: boolean;
  readonly vaultHasObject: boolean;
  readonly verbs: readonly VerbParity[];
  /**
   * The most severe verdict across this object's verbs, ranked
   * overstates > understates > unknown > agree.
   */
  readonly worstVerdict: ParityVerdict;
  readonly grantedBy: readonly string[];
}

/** One named disagreement, hoisted so it cannot be lost in a count. */
export interface ParityDisagreement {
  readonly object: string;
  readonly verb: AccessVerb;
  readonly offline: boolean;
  readonly platform: boolean;
}

/** Counts per verdict across every adjudicated (object, verb) pair. */
export interface ParityCounts {
  readonly agree: number;
  readonly offlineUnderstates: number;
  readonly offlineOverstates: number;
  readonly unknown: number;
}

/** The engine's output. */
export interface AccessParityReport {
  readonly objects: readonly ObjectParity[];
  readonly counts: ParityCounts;
  /** OFFLINE OVERSTATES — the dangerous class, listed explicitly. */
  readonly overstatements: readonly ParityDisagreement[];
  /** OFFLINE UNDERSTATES — the known permission-dependency bug class. */
  readonly understatements: readonly ParityDisagreement[];
  /** Objects the platform returned no row for. Unanswered, NOT denied. */
  readonly objectsPlatformDidNotAnswer: readonly string[];
  /** Objects the vault does not model — no offline answer exists for them. */
  readonly objectsNotInVault: readonly string[];
  /** True iff every comparable verb on every object landed on `agree`. */
  readonly fullAgreement: boolean;
  /** The verbs that were actually adjudicated. */
  readonly comparableVerbs: readonly AccessVerb[];
  /** The mapping table this diff was produced under. */
  readonly verbMapping: readonly VerbMapping[];
}

const VERDICT_SEVERITY: Readonly<Record<ParityVerdict, number>> = Object.freeze({
  'offline-overstates': 3,
  'offline-understates': 2,
  unknown: 1,
  agree: 0,
});

/** All-false offline flags — the "vault knows the object, nothing grants it" case. */
const noFlags = (): Record<ObjectPermissionFlag, boolean> => {
  const out = {} as Record<ObjectPermissionFlag, boolean>;
  for (const flag of OBJECT_PERMISSION_FLAGS) out[flag] = false;
  return out;
};

/**
 * Long-form meaning of each UNKNOWN reason. Emitted ONCE per response (rows
 * carry a short `note`), so the payload does not repeat a paragraph per verb
 * per object — and so the explanation has exactly one source of truth.
 */
export const PARITY_UNKNOWN_GLOSSARY: Readonly<
  Record<ParityUnknownReason, string>
> = Object.freeze({
  'no-platform-column':
    'UserEntityAccess has no column for this verb (it is a record-SCOPE permission, and this object reports entity access). The platform was NOT asked and did NOT answer; the offline value stands UNVERIFIED. The platform answers record scope through UserRecordAccess, which is per-RECORD.',
  'no-offline-equivalent':
    'No offline flag models this verb, so there is nothing to compare the platform value against. The platform value is carried through UNJUDGED rather than mapped onto a near-miss flag to make the diff look clean.',
  'platform-returned-no-row':
    'The platform returned NO row for this object. That is "NOT ANSWERED" — it is NOT evidence the user lacks access. Causes include: the object does not exist, it is not visible to the authenticated running user, it is not exposed through UserEntityAccess, or the batch carrying it failed.',
  'object-not-in-vault':
    'The vault does not model this object, so the offline engine has no answer for it. Absence of a grant here is "not checked", NEVER "denied". Re-run `sfi refresh` if the object should be modeled.',
});

/** Long-form meaning of each verdict. Emitted once per response. */
export const PARITY_VERDICT_GLOSSARY: Readonly<Record<ParityVerdict, string>> =
  Object.freeze({
    agree:
      'Platform CONFIRMED the offline answer. This is the only verdict that is positive evidence the offline engine is right, and it is only as strong as the verb mapping it was adjudicated under.',
    'offline-understates':
      'The platform GRANTS it and the offline engine says no. Known systematic causes: computeEffectiveGrants never expands permission DEPENDENCIES (a permission that implies another), and a blanket ViewAllData / ModifyAllData system permission confers object access that no per-object grantedBy edge carries.',
    'offline-overstates':
      'The offline engine says GRANTED and the platform says NOT. This is the dangerous direction — the offline answer would tell someone access exists when it does not. Do not act on the offline answer for this object/verb.',
    unknown:
      'The comparison could not be made. See `unknownReason` on the row: this is never a soft AGREE and never a soft "no access".',
  });

const UNKNOWN_NOTE: Readonly<Record<ParityUnknownReason, string>> = Object.freeze({
  'no-platform-column': 'Not compared: UserEntityAccess has no column for this verb.',
  'no-offline-equivalent': 'Not compared: no offline flag models this verb.',
  'platform-returned-no-row':
    'Not compared: platform returned NO row for this object (not answered, NOT "no access").',
  'object-not-in-vault': 'Not compared: the vault does not model this object.',
});

const platformValueOf = (
  row: UserEntityAccessRow | undefined,
  field: PlatformAccessField | null,
): boolean | null => {
  if (row === undefined || field === null) return null;
  return row[field];
};

/**
 * Adjudicate ONE (object, verb) pair.
 *
 * Order matters and is deliberate: STRUCTURAL impossibilities (no column on
 * one side or the other) are reported before DATA gaps (no row, not modeled),
 * because a missing column is a permanent property of the mapping while a
 * missing row is a property of this call.
 */
const adjudicate = (
  mapping: VerbMapping,
  offline: OfflineObjectAccess,
  row: UserEntityAccessRow | undefined,
): VerbParity => {
  const platform = platformValueOf(row, mapping.platformField);
  /** The offline answer for this verb, or null when there is none to give. */
  const offlineValueOf = (flag: ObjectPermissionFlag | null): boolean | null =>
    flag === null || !offline.vaultHasObject
      ? null
      : (offline.flags ?? noFlags())[flag];

  if (mapping.platformField === null) {
    return {
      verb: mapping.verb,
      verdict: 'unknown',
      offline: offlineValueOf(mapping.offlineFlag),
      platform: null,
      unknownReason: 'no-platform-column',
      note: UNKNOWN_NOTE['no-platform-column'],
    };
  }

  if (mapping.offlineFlag === null) {
    return {
      verb: mapping.verb,
      verdict: 'unknown',
      offline: null,
      platform,
      unknownReason: 'no-offline-equivalent',
      note: UNKNOWN_NOTE['no-offline-equivalent'],
    };
  }

  if (row === undefined) {
    return {
      verb: mapping.verb,
      verdict: 'unknown',
      offline: offlineValueOf(mapping.offlineFlag),
      platform: null,
      unknownReason: 'platform-returned-no-row',
      note: UNKNOWN_NOTE['platform-returned-no-row'],
    };
  }

  if (!offline.vaultHasObject) {
    return {
      verb: mapping.verb,
      verdict: 'unknown',
      offline: null,
      platform,
      unknownReason: 'object-not-in-vault',
      note: UNKNOWN_NOTE['object-not-in-vault'],
    };
  }

  const offlineValue = (offline.flags ?? noFlags())[mapping.offlineFlag];
  if (offlineValue === platform) {
    return {
      verb: mapping.verb,
      verdict: 'agree',
      offline: offlineValue,
      platform,
      note: `Platform CONFIRMED offline=${String(offlineValue)}.`,
    };
  }
  if (platform === true) {
    return {
      verb: mapping.verb,
      verdict: 'offline-understates',
      offline: offlineValue,
      platform,
      note: 'OFFLINE UNDERSTATES: platform grants it, offline says no.',
    };
  }
  return {
    verb: mapping.verb,
    verdict: 'offline-overstates',
    offline: offlineValue,
    platform,
    note: 'OFFLINE OVERSTATES: offline says granted, platform says NOT.',
  };
};

/**
 * Diff the offline engine's computed access against the platform's verdict.
 *
 * @param offlineAccess One entry per object the caller asked about, carrying
 *   the offline engine's answer AND whether the vault models the object at all.
 * @param platformRows The rows `UserEntityAccess` actually returned. Objects
 *   with no row are reported as unanswered, never as denied.
 *
 * @example
 *   const report = diffAccessParity(offline, fetched.rows);
 *   if (report.overstatements.length > 0) { ...  }   // read this FIRST
 */
export const diffAccessParity = (
  offlineAccess: readonly OfflineObjectAccess[],
  platformRows: readonly UserEntityAccessRow[],
): AccessParityReport => {
  // Case-insensitive: SOQL matches object names case-insensitively, so the
  // platform can echo a different casing than the caller typed. A casing
  // mismatch must never look like a missing row.
  const byEntity = new Map<string, UserEntityAccessRow>();
  for (const row of platformRows) {
    byEntity.set(row.EntityDefinitionId.toLowerCase(), row);
  }

  const objects: ObjectParity[] = [];
  const overstatements: ParityDisagreement[] = [];
  const understatements: ParityDisagreement[] = [];
  const objectsPlatformDidNotAnswer: string[] = [];
  const objectsNotInVault: string[] = [];
  let agree = 0;
  let unknown = 0;

  for (const offline of offlineAccess) {
    const row = byEntity.get(offline.object.toLowerCase());
    if (row === undefined) objectsPlatformDidNotAnswer.push(offline.object);
    if (!offline.vaultHasObject) objectsNotInVault.push(offline.object);

    const verbs = ACCESS_VERB_MAPPING.map((mapping) =>
      adjudicate(mapping, offline, row),
    );

    let worst: ParityVerdict = 'agree';
    for (const v of verbs) {
      if (VERDICT_SEVERITY[v.verdict] > VERDICT_SEVERITY[worst]) worst = v.verdict;
      if (v.verdict === 'agree') agree += 1;
      else if (v.verdict === 'unknown') unknown += 1;
      else if (v.verdict === 'offline-overstates') {
        overstatements.push({
          object: offline.object,
          verb: v.verb,
          offline: v.offline === true,
          platform: v.platform === true,
        });
      } else {
        understatements.push({
          object: offline.object,
          verb: v.verb,
          offline: v.offline === true,
          platform: v.platform === true,
        });
      }
    }

    objects.push({
      object: offline.object,
      platformAnswered: row !== undefined,
      vaultHasObject: offline.vaultHasObject,
      verbs,
      worstVerdict: worst,
      grantedBy: offline.grantedBy ?? [],
    });
  }

  const comparablePairs = offlineAccess.length * COMPARABLE_VERBS.length;
  return {
    objects,
    counts: {
      agree,
      offlineUnderstates: understatements.length,
      offlineOverstates: overstatements.length,
      unknown,
    },
    overstatements,
    understatements,
    objectsPlatformDidNotAnswer,
    objectsNotInVault,
    // Full agreement requires every comparable pair to have been ADJUDICATED
    // and agreed. A run where half the objects came back unanswered has zero
    // disagreements and is emphatically not full agreement.
    fullAgreement:
      comparablePairs > 0 &&
      agree === comparablePairs &&
      overstatements.length === 0 &&
      understatements.length === 0,
    comparableVerbs: COMPARABLE_VERBS,
    verbMapping: ACCESS_VERB_MAPPING,
  };
};
