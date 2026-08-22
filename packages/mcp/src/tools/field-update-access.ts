/**
 * The shared "can this container actually UPDATE this field" decision
 * predicates.
 *
 * ## Why this exists
 *
 * Updating a field value needs THREE declared things — FLS Edit on the field,
 * object-level Edit on its parent object, and a field that is type-writable at
 * all — plus a fourth, EDIT on the specific record, which is runtime and is
 * disclosed rather than decided.
 *
 * `sfi.field_access_audit` composed all three. `sfi.user_ability` composed only
 * the first, and answered `editable: true` for 7,900 measured field/container
 * pairs whose own `<objectPermissions>` row says `allowEdit: false`. Two
 * shipped tools returned opposite answers to the identical question about the
 * identical vault, and the reason they could is that each derived the rule
 * privately.
 *
 * So the DECISION PREDICATES live here and both tools import them. The SCAN
 * does not: each tool already has the relevant edges loaded for its own reason,
 * and forcing a shared scan would cost graph round-trips to buy nothing. What
 * is shared is the part that must never diverge — what an `objectPermissions`
 * row MEANS, and which field types can be written at all.
 *
 * `assessUpdatability` and `RECORD_EDIT_DEPENDENCY` were MOVED here verbatim
 * from `field-access-audit.ts`, which now imports them back, so its behaviour
 * is provably unchanged by the extraction.
 */

import type { Node } from '@sf-intelligence/contracts';

/**
 * An `objectPermissions` grant edge confers object-level EDIT.
 *
 * `modifyAllRecords` is the object-scoped "Modify All" checkbox and implies
 * edit on every record of that object; it is a different thing from the
 * org-wide `ModifyAllData` system permission ({@link hasModifyAllData}).
 */
export const grantsObjectEdit = (p: Readonly<Record<string, unknown>>): boolean =>
  p['allowEdit'] === true || p['modifyAllRecords'] === true;

/** An `objectPermissions` grant edge confers object-level READ. */
export const grantsObjectRead = (p: Readonly<Record<string, unknown>>): boolean =>
  p['allowRead'] === true || p['viewAllRecords'] === true || grantsObjectEdit(p);

/**
 * The container holds the `ModifyAllData` system permission.
 *
 * It implies object-edit on every object without an explicit CRUD row, but it
 * does NOT bypass field-level security — so it only ever matters for a
 * container that already holds FLS Edit on the field in question.
 */
export const hasModifyAllData = (node: Node | null): boolean => {
  const perms = node?.properties['userPermissions'];
  return Array.isArray(perms) && perms.includes('ModifyAllData');
};

/**
 * Assess whether the field is updatable by TYPE. Formula fields (a non-empty
 * `properties.formula`), auto-number, and rollup-summary fields are derived —
 * their value can never be set directly regardless of permissions. When the
 * field's own definition was not retrieved (`notModeled`), the type is unknown,
 * so it's treated as updatable with a caveat rather than a fabricated verdict.
 */
export const assessUpdatability = (
  field: Node,
  notModeled: boolean,
): { fieldUpdatable: boolean; fieldUpdatableNote?: string } => {
  if (notModeled) {
    return {
      fieldUpdatable: true,
      fieldUpdatableNote:
        'field definition not retrieved — type-based updatability (formula / auto-number / rollup) could not be confirmed',
    };
  }
  const formula = field.properties['formula'];
  if (typeof formula === 'string' && formula.length > 0) {
    return { fieldUpdatable: false, fieldUpdatableNote: 'formula field — value is derived, not directly editable' };
  }
  const dataType = field.properties['dataType'];
  if (dataType === 'AutoNumber') {
    return { fieldUpdatable: false, fieldUpdatableNote: 'auto-number field — value is system-assigned' };
  }
  if (dataType === 'Summary') {
    return { fieldUpdatable: false, fieldUpdatableNote: 'roll-up summary field — value is aggregated, not directly editable' };
  }
  return { fieldUpdatable: true };
};

/** Verbatim record-edit dependency note attached to every update assessment. */
export const RECORD_EDIT_DEPENDENCY =
  'Updating a value also requires EDIT access to the specific record — check `why_cant_user_see_record` with `accessLevel: "edit"`; this audit covers only field + object permissions.';
