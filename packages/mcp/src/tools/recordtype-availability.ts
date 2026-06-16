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

import { mergeInputAliases, toProfileOrPermSetId } from './input-aliases.js';

const recordtypeAvailabilityInputBaseSchema = z.object({
  componentId: z.string().min(1),
});

/** Zod schema for the `sfi.recordtype_availability` tool input. */
export const recordtypeAvailabilityInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    {
      canonical: 'componentId',
      aliases: ['profileId', 'permissionSetId'],
    },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.componentId === 'string' ? o.componentId : '';
    if (
      id.length > 0 &&
      !id.startsWith('Profile:') &&
      !id.startsWith('PermissionSet:')
    ) {
      const fromPs =
        typeof (raw as Record<string, unknown>).permissionSetId === 'string';
      o.componentId = fromPs ? `PermissionSet:${id}` : toProfileOrPermSetId(id);
    }
  }
  return merged;
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
    return err({
      kind: 'invalid-query',
      message: `componentId must be a Profile: or PermissionSet: id; got '${input.componentId}'`,
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
  // An ABSENT `recordTypeVisibilities` key means the surface was not extracted
  // (a pre-extraction / stale vault), NOT that the container sees no record
  // types — so an empty result must disclose "not modeled", like tab_availability.
  const extracted = Array.isArray(raw);
  const entries: RawEntry[] = extracted ? (raw as RawEntry[]) : [];

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

  const objects: ObjectRecordTypes[] = [...byObject.entries()]
    .map(([object, recordTypes]) => {
      recordTypes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const def = recordTypes.find((r) => r.default);
      return { object, recordTypes, defaultRecordType: def ? def.name : null };
    })
    .sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));

  const visibleRecordTypes = objects.reduce(
    (n, o) => n + o.recordTypes.filter((r) => r.visible).length,
    0,
  );

  const boundaryNote = extracted
    ? 'Declared from `recordTypeVisibilities` (the record types this profile/permission set can pick when creating a record). The user must also be ASSIGNED this container, and Create needs the object Create permission (`object_access_audit`).'
    : 'This Profile/PermissionSet carries no extracted `recordTypeVisibilities` property — re-run `/sfi-refresh`; the empty list is "not modeled", not a verified "no record types".';

  return ok({
    data: {
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
