/**
 * Handler for the `sfi.recordtype_availability` MCP tool
 * (P11-ACCESS-recordtype-availability).
 *
 * Answers "what record types can this user create / see" for a Profile or
 * PermissionSet. Salesforce record-type access lives on a profile /
 * permission-set's `recordTypeVisibilities` — each entry names a
 * `Object.RecordType`, whether it is `visible` (a visible record type is one the
 * user can pick when creating a record), and whether it is the `default` for
 * that object. This tool reads those entries and groups them by object, with the
 * default surfaced per object.
 *
 * Input: `{ componentId: 'Profile:Admin' | 'PermissionSet:X' }` (canonical id).
 * Output: per-object visible/default record types. `declared` confidence — record
 * type visibility is declared profile metadata. A non-Profile/PermissionSet id
 * is `invalid-query`; an unknown id is `component-not-found`.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { familyWasExtracted, notExtractedFamilyDisclosure } from './absence-disclosure.js';
import {
  firstNonEmpty,
  resolveExistingObjectScope,
  toCustomObjectId,
  toObjectApiName,
  toProfileOrPermSetId,
} from './input-aliases.js';

const recordtypeAvailabilityInputBaseSchema = z.object({
  /** The Profile / PermissionSet visibility SUBJECT (resolved to its prefix). */
  componentId: z.string().min(1),
  /** Optional OBJECT filter (bare api name), resolved by the preprocess. */
  object: z.string().min(1).optional(),
});

/** Coerce an unknown to its string form (else undefined). */
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

/**
 * Zod schema for the `sfi.recordtype_availability` tool input.
 *
 * The tool answers record-type VISIBILITY for a **Profile / PermissionSet**
 * (`recordTypeVisibilities`), so its `componentId` is a `Profile:` /
 * `PermissionSet:` id — a bare name / `profileId` / `profileApiName` /
 * `permissionSetId` / `permissionSetApiName` alias is coerced to that container
 * prefix. This is the visibility SUBJECT and is resolved SEPARATELY from any
 * object mentioned in the same call.
 *
 * W3.5 residual fix (RECORDTYPE-AVAILABILITY-REJECTS-PROFILEAPINAME): a natural
 * "record types on Case for {profile}?" passes an object key (`objectApiName` /
 * `object` / `objectId`) ALONGSIDE a profile key (`profileApiName` / `profileId`
 * / …). Pre-fix the object was consumed into the container slot and the profile
 * key was stripped, so the call hard-failed. Now the profile is bound as the
 * container SUBJECT and the object becomes an OPTIONAL FILTER (`object`) the
 * handler narrows to, echoed in `appliedScope`.
 *
 * W3.3 misbind fix (ADMIN-SURFACE-ALIAS-SKEW-CLUSTER, preserved): an OBJECT-only
 * input — a `CustomObject:` `componentId`, or an object alias with NO container
 * key — must NOT be coerced into a phantom `Profile:CustomObject:Case`. It is
 * bound to the object (`CustomObject:X`) so the handler rejects it HONESTLY as a
 * CustomObject (this tool needs a Profile/PermissionSet), never a Profile
 * not-found.
 */
export const recordtypeAvailabilityInputSchema = z.preprocess((raw) => {
  const src =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = { ...src };
  // Strip the raw `object` alias; it is re-added canonically only with a container.
  delete out['object'];

  // OBJECT filter (optional) — the SObject mentioned in "record types on X for Y?".
  const objectRaw = firstNonEmpty(
    asStr(src['objectApiName']),
    asStr(src['object']),
    asStr(src['objectId']),
  );
  const objectFilter = objectRaw === undefined ? undefined : toObjectApiName(objectRaw);

  // CONTAINER (Profile / PermissionSet) — the visibility SUBJECT, resolved
  // independently of the object so a profile key is never stripped by an object.
  const cid = asStr(src['componentId']);
  const cidIsContainer =
    cid !== undefined &&
    (cid.startsWith('Profile:') || cid.startsWith('PermissionSet:'));
  const profileSel = firstNonEmpty(
    asStr(src['profileApiName']),
    asStr(src['profileId']),
    asStr(src['profileName']),
  );
  const permsetSel = firstNonEmpty(
    asStr(src['permissionSetApiName']),
    asStr(src['permissionSetId']),
  );

  let container: string | undefined;
  if (cidIsContainer) container = cid;
  else if (profileSel !== undefined) container = toProfileOrPermSetId(profileSel);
  else if (permsetSel !== undefined)
    container = permsetSel.startsWith('PermissionSet:')
      ? permsetSel
      : `PermissionSet:${permsetSel}`;
  else if (cid !== undefined && cid.length > 0 && !cid.startsWith('CustomObject:'))
    // A bare componentId that is not object-shaped → a Profile container.
    container = toProfileOrPermSetId(cid);

  if (container !== undefined) {
    out['componentId'] = container;
    if (objectFilter !== undefined) out['object'] = objectFilter;
  } else if (objectFilter !== undefined || (cid !== undefined && cid.startsWith('CustomObject:'))) {
    // Object given but NO container: bind to the OBJECT so the handler rejects it
    // HONESTLY as a CustomObject (W3.3), never a phantom `Profile:CustomObject:X`.
    out['componentId'] =
      cid !== undefined && cid.startsWith('CustomObject:')
        ? cid
        : toCustomObjectId(objectFilter as string);
  }
  return out;
}, recordtypeAvailabilityInputBaseSchema);

/** Parsed input shape. */
export type RecordtypeAvailabilityInput = z.infer<typeof recordtypeAvailabilityInputSchema>;

/** One record type's availability for the granter. */
export interface RecordTypeEntry {
  /** Full `Object.RecordType` api name. */
  readonly recordType: string;
  /** Just the record-type segment. */
  readonly name: string;
  /** True if the user can create records of this type (Salesforce `<visible>`). */
  readonly visible: boolean;
  /** True if this is the user's default record type for the object. */
  readonly default: boolean;
}

/** Record-type availability for one object. */
export interface ObjectRecordTypes {
  readonly object: string;
  readonly recordTypes: readonly RecordTypeEntry[];
  /** The default record-type name for this object, or null if none is marked. */
  readonly defaultRecordType: string | null;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface RecordtypeAvailabilityOutput {
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes a `profileApiName`
   * / `object` it passed was silently stripped (the W3.5 residual this closes).
   * `componentId` is the resolved Profile / PermissionSet subject; `object` is
   * the object filter that narrowed the result (or null when unscoped).
   */
  readonly appliedScope: {
    readonly componentId: string;
    readonly object: string | null;
  };
  readonly componentId: string;
  readonly granterType: 'Profile' | 'PermissionSet';
  readonly granterLabel: string;
  readonly objects: readonly ObjectRecordTypes[];
  readonly summary: {
    readonly objects: number;
    readonly visibleRecordTypes: number;
  };
  /** Honesty: an empty list is "not modeled" when the source property is absent, not a verified "none". */
  readonly boundaryNote: string;
}

const GRANTER_PREFIXES = ['Profile:', 'PermissionSet:'] as const;

/** A single `recordTypeVisibilities` entry, defensively typed. */
interface RawEntry {
  readonly recordType?: unknown;
  readonly visible?: unknown;
  readonly default?: unknown;
}

/**
 * The `sfi.recordtype_availability` MCP tool. Reads `recordTypeVisibilities` off
 * the Profile / PermissionSet and groups the visible/default record types by
 * object.
 *
 * @example
 *   await recordtypeAvailabilityHandler(ctx, { componentId: 'Profile:Admin' });
 */
export const recordtypeAvailabilityHandler = async (
  ctx: Context,
  input: RecordtypeAvailabilityInput,
): Promise<Result<McpResponse<RecordtypeAvailabilityOutput>, McpError>> => {
  if (!GRANTER_PREFIXES.some((p) => input.componentId.startsWith(p))) {
    // W3.3: a CustomObject-shaped id is a common misroute ("record types on
    // <object> for <profile>?") — name it as such rather than the generic
    // message, and never a phantom `Profile:CustomObject:X` not-found.
    const isObject = input.componentId.startsWith('CustomObject:');
    return err({
      kind: 'invalid-query',
      message: isObject
        ? `recordtype_availability answers record-type visibility for a Profile / PermissionSet — it needs a Profile: or PermissionSet: id, but got the CustomObject '${input.componentId}'. Pass the Profile / PermissionSet whose record-type access you want (a \`Profile:\` or \`PermissionSet:\` id).`
        : `componentId must be a Profile: or PermissionSet: id; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, componentId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  const node: Node | null = nodeResult.value;
  if (node === null) {
    return err({
      kind: 'component-not-found',
      message: `no Profile/PermissionSet matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }

  const raw = node.properties['recordTypeVisibilities'];
  // R1: whether the family was extracted is decided by whether the node
  // CARRIES the `recordTypeVisibilities` property AT ALL, never by whether the
  // array is empty — `Array.isArray` alone disagrees with the sentinel for a
  // present-but-null value (extracted, serialized as `null` rather than `[]`,
  // which `Array.isArray` would misreport as "never extracted"). Adopts the
  // shared sentinel `effective_permissions` already calls for this exact
  // property, so the two tools cannot drift into a sixth hand-rolled wording.
  const extracted = familyWasExtracted(node.properties, 'recordTypeVisibilities');
  const entries: RawEntry[] = Array.isArray(raw) ? (raw as RawEntry[]) : [];

  // Group by object. A `recordType` of `Object.RecordType` splits at the first
  // dot; entries with no dotted record type (the rare null "default for object"
  // state) are skipped — they name no specific record type.
  const byObject = new Map<string, RecordTypeEntry[]>();
  for (const e of entries) {
    if (typeof e.recordType !== 'string') continue;
    const dot = e.recordType.indexOf('.');
    if (dot <= 0) continue;
    const object = e.recordType.slice(0, dot);
    const name = e.recordType.slice(dot + 1);
    const entry: RecordTypeEntry = {
      recordType: e.recordType,
      name,
      // `<visible>` omitted (null) in older metadata means the type IS available;
      // only an explicit false hides it.
      visible: e.visible !== false,
      default: e.default === true,
    };
    const list = byObject.get(object) ?? [];
    list.push(entry);
    byObject.set(object, list);
  }

  const allObjects: ObjectRecordTypes[] = [...byObject.entries()]
    .map(([object, recordTypes]) => {
      recordTypes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const def = recordTypes.find((r) => r.default);
      return { object, recordTypes, defaultRecordType: def ? def.name : null };
    })
    .sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));

  // R4: verify the OBJECT FILTER exists in the vault BEFORE using it to narrow
  // the result. A string-templated `CustomObject:${name}` filter answered a
  // typo, a real object in the WRONG CASE, and an object the refresh never
  // retrieved all with the same confident-looking "zero record types" —
  // because `extracted` is true, that empty read as a DECLARED zero, not a
  // refusal. Adopts the shared `resolveExistingObjectScope` (the object axis
  // was already separated from the container axis by this tool's own
  // preprocess, so the existence check drops straight in ahead of the
  // filter) — the same primitive `flow_fault_audit` /
  // `flow_bulkification_audit` migrated their object scope onto.
  // `null` = no object named (bare call, unscoped, byte-identical to before);
  // a resolved scope carries the vault's exact-cased object name; an
  // unresolvable / wrong-case-ambiguous object → `invalid-query`, never a
  // silent empty.
  const scopeResult = await resolveExistingObjectScope(ctx.graph, { object: input.object });
  if (!scopeResult.ok) return err(scopeResult.error);
  const scope = scopeResult.value;
  const objects =
    scope === null
      ? allObjects
      : allObjects.filter(
          (o) => o.object.toLowerCase() === scope.object.toLowerCase(),
        );

  const visibleRecordTypes = objects.reduce(
    (n, o) => n + o.recordTypes.filter((r) => r.visible).length,
    0,
  );

  const boundaryNote = extracted
    ? 'Declared from `recordTypeVisibilities` (the record types this profile/permission set can pick when creating a record). The user must also be ASSIGNED this container, and Create needs the object Create permission (`object_access_audit`).'
    : notExtractedFamilyDisclosure({
        subject: 'Record-type visibility',
        verb: 'checked',
        sentinelProperty: 'recordTypeVisibilities',
        containers: [componentId],
        surface: '`objects` / `summary.objects`',
        zeroReading: '"no record types"',
      });

  return ok({
    data: {
      appliedScope: { componentId, object: scope?.object ?? null },
      componentId,
      granterType: node.type === 'PermissionSet' ? 'PermissionSet' : 'Profile',
      granterLabel: node.label ?? node.apiName,
      objects,
      summary: { objects: objects.length, visibleRecordTypes },
      boundaryNote,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
