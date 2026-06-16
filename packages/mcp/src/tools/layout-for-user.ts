/**
 * Handler for the `sfi.layout_for_user` MCP tool.
 *
 * The v1.2 headline tool — the analogous layout-routing twin of
 * v1.1's `sfi.why_cant_user_see_record`. Answers the admin-facing
 * question "what page layout does this user see for object X record
 * type Y?". Walks the Profile -> layoutAssignments -> Layout chain in
 * the order Salesforce itself resolves it and returns a structured
 * routing trail a caller can render verbatim or summarise.
 *
 * The Salesforce model, in short:
 *   - Every Profile has zero or more `<layoutAssignments>` entries,
 *     each a `{ layout, recordType? }` pair.
 *   - For each `(profile, object, recordType)` triple, exactly one
 *     Layout is assigned.
 *   - If the caller omits `recordTypeId`, the profile's default
 *     assignment for that object (the entry with no `<recordType>`)
 *     is used.
 *   - If the profile has no matching assignment, the org's default
 *     layout for that object applies — but org defaults are out of
 *     v1.2 scope and surface as `verdict: 'unknown'`.
 *
 * The cascade, in this exact order:
 *
 *   1. **ProfileLookup** — fetch the Profile node by `profileId`. If
 *      not found, return a single `not-found` step. The cascade
 *      short-circuits with `layoutId: null` and `recordTypeUsed: null`.
 *
 *   2. **LayoutAssignment** — read the profile's
 *      `properties.layoutAssignments` array. If the property is
 *      absent (the v0.1 Profile extractor does not yet extract this
 *      element — production orgs often have profile XML in the
 *      multi-megabyte range and the extractor may also skip elements
 *      under file-size pressure), the cascade short-circuits with a
 *      single `unknown` step. This is the **honesty axis** — the
 *      tool prefers "I don't know" over a fabricated answer.
 *
 *   3. **RecordTypeResolution** — when `recordTypeId` is supplied,
 *      look for an entry matching `(objectApiName, recordTypeId)`.
 *      When `recordTypeId` is null/omitted, find the profile's
 *      default record type for the object — the assignment whose
 *      `recordType` is null AND whose `layout` targets the object.
 *      Reports which record type was inferred.
 *
 *   4. **Match / Fallback** — if a matching layoutAssignment is
 *      found, return `{ layoutId: 'Layout:{objectApiName}.{layoutName}',
 *      recordTypeUsed, ... }` with verdict='matched'. If no match,
 *      return `{ layoutId: null, ... }` with `verdict: 'unknown'`
 *      and a reason explaining what was searched.
 *
 * **Honesty axis**: the tool never fabricates. If the Profile node
 * does not carry an extracted `layoutAssignments` array — either
 * because the v0.1 Profile extractor predates the v1.2 element
 * coverage, or because the production profile XML is too large for
 * the extractor's parser to fully cover — the cascade reports
 * `unknown` with a reason that points the admin at the missing
 * extraction. A `matched` verdict means the cascade found an exact
 * layout assignment in the profile metadata; an `unknown` verdict
 * means the answer depends on data outside the extracted vault.
 *
 * Implementation notes:
 *   - `properties.layoutAssignments` is the contract surface the
 *     v0.1 Profile extractor will eventually populate (see
 *     `packages/extractors/src/profile.ts`'s `<layoutAssignments>`
 *     parsing). Each entry has the shape
 *     `{ layout: string, recordType?: string | null }`. The XML uses
 *     `'Object-Layout Name'` for the layout (dash-separated) and
 *     `'Object.RecordTypeName'` for the recordType (dot-separated).
 *     This tool reads the array as opaque — the extractor is
 *     responsible for whatever normalization happens at extraction
 *     time. The tool's only job is to find the entry that matches
 *     the input axes.
 *   - The matching algorithm filters layoutAssignments to entries
 *     whose `layout` value names the target object as its
 *     dash-separated prefix. Both `Object-Layout Name` (production
 *     XML form) and the canonical `Layout:Object.LayoutName` form
 *     are recognised so the tool stays robust if the extractor
 *     starts emitting canonical ids at extraction time.
 *   - `recordTypeUsed` carries the canonical id form
 *     `RecordType:{ObjectApiName}.{RecordTypeName}`. When the
 *     profile's default record type is inferred (input
 *     `recordTypeId` was null/omitted), this value is `null` —
 *     mirroring the "no record type" state in the metadata model.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Zod schema for the `sfi.layout_for_user` tool input.
 *
 *   - `objectApiName`: required, non-empty. The Salesforce object
 *     whose layout is being routed (e.g., `'Account'`, `'Opportunity'`,
 *     `'OA_Location__c'`). Unknown objects surface as `unknown` from
 *     the LayoutAssignment stage, not a Zod rejection.
 *   - `recordTypeId`: optional. Canonical id form
 *     `'RecordType:{ObjectApiName}.{RecordTypeName}'`. Omit to
 *     resolve the profile's default record type for the object.
 *   - `profileId`: required, non-empty. Canonical id form
 *     `'Profile:{ProfileName}'`. Unknown ids surface as a single
 *     `not-found` step, not a Zod rejection.
 */
export const layoutForUserInputSchema = z.object({
  objectApiName: z.string().min(1),
  recordTypeId: z.string().min(1).optional(),
  profileId: z.string().min(1),
});

/** Parsed input shape, inferred from `layoutForUserInputSchema`. */
export type LayoutForUserInput = z.infer<typeof layoutForUserInputSchema>;

/**
 * One step in the layout-routing cascade. The structure mirrors the
 * order Salesforce itself resolves layout routing for a profile.
 *
 *   - `stage`: which step of the cascade this entry comes from.
 *   - `verdict`: `matched` if the stage resolved cleanly,
 *     `fallback` if a default was chosen (e.g., the profile's
 *     default record type for the object), `unknown` if the v1.2
 *     metadata model cannot decide, `not-found` if the named
 *     component is missing from the vault.
 *   - `reason`: a plain-English explanation citing the metadata the
 *     verdict rests on. Never empty.
 *   - `value`: optional resolved component id when `verdict` is
 *     `matched` or `fallback` — the layoutAssignment-derived layout
 *     id at the LayoutAssignment stage, or the inferred record type
 *     id at the RecordTypeResolution stage.
 */
export interface LayoutRoutingStep {
  readonly stage:
    | 'ProfileLookup'
    | 'LayoutAssignment'
    | 'RecordTypeResolution'
    | 'LightningPageLookup'
    | 'Default';
  readonly verdict: 'matched' | 'fallback' | 'unknown' | 'not-found';
  readonly reason: string;
  readonly value?: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface LayoutForUserOutput {
  readonly layoutId: ComponentId | null;
  /** Lightning record page when the vault models FlexiPages for this object. */
  readonly flexiPageId: ComponentId | null;
  /** Which UI surface the answer primarily describes. */
  readonly uiSurface: 'classic-layout' | 'lightning-flexipage' | 'unknown';
  readonly recordTypeUsed: ComponentId | null;
  readonly reasoning: readonly LayoutRoutingStep[];
  /** Set when Classic layout metadata is returned but Lightning pages exist. */
  readonly boundaryNote?: string;
}

/**
 * One entry in a Profile's `properties.layoutAssignments` array, as
 * the v0.1 Profile extractor will eventually emit it. The shape
 * mirrors the `<layoutAssignments>` XML element verbatim — `layout`
 * is the assignment's target layout, `recordType` is the record-
 * type axis (null/undefined means "default for object").
 */
export interface LayoutAssignmentEntry {
  readonly layout: string;
  readonly recordType?: string | null;
}

/**
 * Build a reasoning step. Centralised because every helper produces
 * a step and `exactOptionalPropertyTypes` makes the `value?` branch
 * sharper here than at each call site.
 */
const step = (
  stage: LayoutRoutingStep['stage'],
  verdict: LayoutRoutingStep['verdict'],
  reason: string,
  value?: string,
): LayoutRoutingStep =>
  value === undefined
    ? { stage, verdict, reason }
    : { stage, verdict, reason, value };

/**
 * Resolve the Profile node and emit a ProfileLookup step. Returns
 * `profile: null` with a `not-found` step when the Profile id is
 * unknown to the vault; the caller short-circuits the cascade on
 * that condition.
 */
const evaluateProfileLookup = async (
  ctx: Context,
  profileId: ComponentId,
): Promise<Result<{ profile: Node | null; step: LayoutRoutingStep }, string>> => {
  const nodeResult = await getNodeById(ctx.graph, profileId);
  if (!nodeResult.ok) {
    return err(nodeResult.error.message);
  }
  const node = nodeResult.value;
  if (node === null) {
    return ok({
      profile: null,
      step: step(
        'ProfileLookup',
        'not-found',
        `profile not found: ${profileId}`,
      ),
    });
  }
  return ok({
    profile: node,
    step: step('ProfileLookup', 'matched', `profile resolved: ${profileId}`),
  });
};

/**
 * Read the Profile's `properties.layoutAssignments` array. Returns
 * `null` when the property is absent, an empty array, or has a shape
 * the tool does not recognise — the caller surfaces this as the
 * honesty-axis `unknown` step.
 */
export const readLayoutAssignments = (
  profile: Node,
): readonly LayoutAssignmentEntry[] | null => {
  const raw = profile.properties['layoutAssignments'];
  if (!Array.isArray(raw)) return null;
  const out: LayoutAssignmentEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const layout = entry['layout'];
    if (typeof layout !== 'string' || layout.length === 0) continue;
    const recordType = entry['recordType'];
    if (
      recordType === undefined ||
      recordType === null ||
      typeof recordType === 'string'
    ) {
      out.push({ layout, recordType: recordType ?? null });
    }
  }
  return out;
};

/**
 * Find the profile's DEFAULT record type for an object from
 * `properties.recordTypeVisibilities` — the entry whose `recordType` targets
 * the object AND is flagged `default: true`. Used when the caller omits a
 * record type and the object has NO `recordType: null` ("master")
 * layoutAssignment: Salesforce then routes by the user's default record type,
 * so the cascade resolves THAT record type's layout instead of giving up.
 * Returns the bare `{Object}.{RecordTypeName}` form (matching how
 * layoutAssignments store the record type), or `null` when no default
 * visibility is recorded for the object.
 */
const defaultRecordTypeForObject = (
  profile: Node,
  objectApiName: string,
): string | null => {
  const raw = profile.properties['recordTypeVisibilities'];
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry['default'] !== true) continue;
    const rt = entry['recordType'];
    if (typeof rt === 'string' && rt.startsWith(`${objectApiName}.`)) {
      return rt;
    }
  }
  return null;
};

/**
 * Decide whether a layoutAssignment entry's `layout` value targets
 * `objectApiName`. Accepts two forms produced by the Profile XML and
 * by future canonical-id emitters:
 *   - `'Object-Layout Name'` — production XML form, dash-separated
 *     by the extractor's verbatim pass-through.
 *   - `'Layout:Object.LayoutName'` — canonical id form, used when
 *     the extractor emits ids at extraction time.
 */
export const layoutTargetsObject = (
  layoutValue: string,
  objectApiName: string,
): boolean => {
  if (layoutValue.startsWith(`${objectApiName}-`)) return true;
  if (layoutValue.startsWith(`Layout:${objectApiName}.`)) return true;
  return false;
};

/**
 * Extract the layout name from a layoutAssignment's `layout` value
 * and build the canonical `Layout:{Object}.{LayoutName}` id. Both
 * the production XML form (`Object-Layout Name`) and the canonical
 * id form (`Layout:Object.LayoutName`) round-trip to the same id.
 */
export const canonicaliseLayoutId = (
  layoutValue: string,
  objectApiName: string,
): ComponentId => {
  if (layoutValue.startsWith(`Layout:${objectApiName}.`)) {
    return layoutValue;
  }
  // `Object-Layout Name` → strip the leading `Object-` and prefix
  // with the canonical `Layout:Object.` form.
  const layoutName = layoutValue.slice(objectApiName.length + 1);
  return `Layout:${objectApiName}.${layoutName}`;
};

/**
 * Find the layoutAssignment entry matching `(objectApiName,
 * recordTypeId)`. Returns three orthogonal cases:
 *   - **explicit match**: caller supplied `recordTypeId` and an
 *     entry's `recordType` equals it. Verdict `matched`.
 *   - **default match**: caller omitted `recordTypeId` and a
 *     default entry (`recordType === null`) targets the object.
 *     Verdict `fallback`.
 *   - **no match**: the assignments list contained nothing
 *     matching the input axes. Verdict `unknown`.
 *
 * The `recordTypeUsed` value tracks which record type the matched
 * assignment carried — `null` for default entries.
 */
const findLayoutAssignment = (
  assignments: readonly LayoutAssignmentEntry[],
  objectApiName: string,
  recordTypeId: string | undefined,
  defaultRecordType: string | null,
): {
  readonly match: LayoutAssignmentEntry | null;
  readonly recordTypeUsed: string | null;
  readonly step: LayoutRoutingStep;
} => {
  // Narrow to entries targeting this object first; cross-object
  // assignments cannot match regardless of record type.
  const forObject = assignments.filter((a) =>
    layoutTargetsObject(a.layout, objectApiName),
  );
  if (forObject.length === 0) {
    return {
      match: null,
      recordTypeUsed: null,
      step: step(
        'LayoutAssignment',
        'unknown',
        `no layoutAssignments target object '${objectApiName}'`,
      ),
    };
  }

  if (recordTypeId !== undefined) {
    // The input contract documents `recordTypeId` as the canonical id
    // form `RecordType:{Object}.{RecordTypeName}`, but profile
    // `<layoutAssignments>` store the record type as the bare
    // dot-separated `{Object}.{RecordTypeName}` (no `RecordType:`
    // prefix). Strip the prefix before comparing — otherwise the
    // documented canonical input never `===` a real assignment and
    // every record-type-specific routing query wrongly resolves to
    // `unknown` / no layout. Bare input (no prefix) passes through
    // unchanged, so both forms resolve.
    const normalizedRecordType = recordTypeId.startsWith('RecordType:')
      ? recordTypeId.slice('RecordType:'.length)
      : recordTypeId;
    const explicit = forObject.find(
      (a) => a.recordType === normalizedRecordType,
    );
    if (explicit !== undefined) {
      return {
        match: explicit,
        recordTypeUsed: normalizedRecordType,
        step: step(
          'LayoutAssignment',
          'matched',
          `layoutAssignment matches (object='${objectApiName}', recordType='${normalizedRecordType}')`,
        ),
      };
    }
    return {
      match: null,
      recordTypeUsed: null,
      step: step(
        'LayoutAssignment',
        'unknown',
        `no layoutAssignment matches (object='${objectApiName}', recordType='${normalizedRecordType}')`,
      ),
    };
  }

  // No recordTypeId supplied: the profile's default for this object
  // is the entry with `recordType: null`.
  const fallback = forObject.find(
    (a) => a.recordType === null || a.recordType === undefined,
  );
  if (fallback !== undefined) {
    return {
      match: fallback,
      recordTypeUsed: null,
      step: step(
        'LayoutAssignment',
        'fallback',
        `default layoutAssignment matches object '${objectApiName}' (no recordType specified)`,
      ),
    };
  }
  // No master (`recordType: null`) assignment. Salesforce then routes by the
  // user's DEFAULT record type for the object — resolve THAT record type's
  // layout assignment (profile layout-assignment depth) rather than giving up.
  // The default record type comes from the profile's recordTypeVisibilities.
  if (defaultRecordType !== null) {
    const viaDefault = forObject.find((a) => a.recordType === defaultRecordType);
    if (viaDefault !== undefined) {
      return {
        match: viaDefault,
        recordTypeUsed: defaultRecordType,
        step: step(
          'LayoutAssignment',
          'fallback',
          `no master (recordType: null) assignment for '${objectApiName}'; resolved via the profile's default record type '${defaultRecordType}'`,
        ),
      };
    }
  }
  return {
    match: null,
    recordTypeUsed: null,
    step: step(
      'LayoutAssignment',
      'unknown',
      `no default layoutAssignment for object '${objectApiName}'; caller omitted recordTypeId`,
    ),
  };
};

/** Prefer record pages whose apiName matches `{Object}_*` patterns. */
const pickFlexiPageForObject = (
  pages: readonly Node[],
  objectApiName: string,
): Node | null => {
  const forObject = pages.filter(
    (page) =>
      page.apiName.startsWith(`${objectApiName}_`) ||
      page.apiName.startsWith(`${objectApiName}.`),
  );
  if (forObject.length === 0) return null;
  const recordPage = forObject.find(
    (page) =>
      page.apiName.includes('Record') ||
      page.apiName.toLowerCase().includes('record_page'),
  );
  return recordPage ?? forObject[0] ?? null;
};

/**
 * Resolve a Lightning FlexiPage for the object when the vault contains
 * record pages. Profile metadata still assigns Classic layouts; this
 * stage surfaces the Lightning surface users actually see.
 */
const evaluateLightningPageLookup = async (
  ctx: Context,
  objectApiName: string,
): Promise<Result<{ step: LayoutRoutingStep; flexiPageId: ComponentId | null }, string>> => {
  const pagesResult = await listNodesByType(ctx.graph, 'FlexiPage', { limit: 500 });
  if (!pagesResult.ok) return err(pagesResult.error.message);
  const match = pickFlexiPageForObject(pagesResult.value, objectApiName);
  if (match === null) {
    return ok({
      flexiPageId: null,
      step: step(
        'LightningPageLookup',
        'unknown',
        `no FlexiPage in vault targets object '${objectApiName}'`,
      ),
    });
  }
  return ok({
    flexiPageId: match.id,
    step: step(
      'LightningPageLookup',
      'matched',
      `FlexiPage '${match.id}' models the Lightning record surface for '${objectApiName}'`,
      match.id,
    ),
  });
};

/**
 * The `sfi.layout_for_user` MCP tool. Walks the Salesforce layout-
 * routing cascade (ProfileLookup -> LayoutAssignment ->
 * RecordTypeResolution) for a given object + (optional) record type
 * + profile, and returns a structured reasoning chain plus the
 * resolved layout id. See the module JSDoc for the cascade rules
 * and the honesty-axis design.
 *
 * @example
 *   const r = await layoutForUserHandler(ctx, {
 *     objectApiName: 'Account',
 *     profileId: 'Profile:System Administrator',
 *   });
 *   if (r.ok) console.log(r.value.data.layoutId);
 */
export const layoutForUserHandler = async (
  ctx: Context,
  input: LayoutForUserInput,
): Promise<Result<McpResponse<LayoutForUserOutput>, McpError>> => {
  const { objectApiName, recordTypeId, profileId } = input;

  // Stage 1: ProfileLookup. Short-circuit on missing profile — the
  // cascade has nothing to walk without one.
  const lookupResult = await evaluateProfileLookup(ctx, profileId);
  if (!lookupResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${lookupResult.error}`,
    });
  }
  const { profile, step: lookupStep } = lookupResult.value;
  if (profile === null) {
    return ok({
      data: {
        layoutId: null,
        flexiPageId: null,
        uiSurface: 'unknown',
        recordTypeUsed: null,
        reasoning: [lookupStep],
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const reasoning: LayoutRoutingStep[] = [lookupStep];

  // Stage 2: LayoutAssignment. Honesty axis — when the Profile
  // extractor has not (yet) populated `layoutAssignments`, refuse
  // to fabricate and surface `unknown` with a reason that points
  // the admin at the missing extraction.
  const assignments = readLayoutAssignments(profile);
  if (assignments === null) {
    reasoning.push(
      step(
        'LayoutAssignment',
        'unknown',
        'layout assignments not present in extracted profile properties',
      ),
    );
    return ok({
      data: {
        layoutId: null,
        flexiPageId: null,
        uiSurface: 'unknown',
        recordTypeUsed: null,
        reasoning,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // When the caller omits a record type, the user's default record type can
  // route the layout if the object has no master assignment (depth fallback).
  const defaultRecordType =
    recordTypeId === undefined
      ? defaultRecordTypeForObject(profile, objectApiName)
      : null;
  const { match, recordTypeUsed, step: assignmentStep } = findLayoutAssignment(
    assignments,
    objectApiName,
    recordTypeId,
    defaultRecordType,
  );
  reasoning.push(assignmentStep);

  // Stage 3: RecordTypeResolution. Reports which record type axis
  // the cascade ended up using — the caller's explicit value, the
  // profile's default (null), or nothing if the LayoutAssignment
  // stage already returned unknown.
  if (match !== null) {
    const rtReason =
      recordTypeUsed === null
        ? `profile default record type used (no recordTypeId supplied; matched assignment has no <recordType>)`
        : `record type '${recordTypeUsed}' resolved against profile layoutAssignment`;
    reasoning.push(
      step(
        'RecordTypeResolution',
        recordTypeUsed === null ? 'fallback' : 'matched',
        rtReason,
        recordTypeUsed ?? undefined,
      ),
    );
  }

  if (match === null) {
    const lightningResult = await evaluateLightningPageLookup(ctx, objectApiName);
    if (!lightningResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${lightningResult.error}`,
      });
    }
    reasoning.push(lightningResult.value.step);
    return ok({
      data: {
        layoutId: null,
        flexiPageId: lightningResult.value.flexiPageId,
        uiSurface:
          lightningResult.value.flexiPageId === null ? 'unknown' : 'lightning-flexipage',
        recordTypeUsed: null,
        reasoning,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const layoutId = canonicaliseLayoutId(match.layout, objectApiName);

  const lightningResult = await evaluateLightningPageLookup(ctx, objectApiName);
  if (!lightningResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${lightningResult.error}`,
    });
  }
  reasoning.push(lightningResult.value.step);

  const flexiPageId = lightningResult.value.flexiPageId;
  const uiSurface =
    flexiPageId !== null ? 'lightning-flexipage' : 'classic-layout';
  const boundaryNote =
    flexiPageId !== null
      ? `Profile layoutAssignments resolve to Classic layout '${layoutId}', but the vault models Lightning FlexiPage '${flexiPageId}' for this object — users in Lightning Experience typically see the FlexiPage.`
      : undefined;

  return ok({
    data: {
      layoutId,
      flexiPageId,
      uiSurface,
      recordTypeUsed,
      reasoning,
      ...(boundaryNote !== undefined ? { boundaryNote } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
