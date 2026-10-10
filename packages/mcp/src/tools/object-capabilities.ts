/**
 * The ONE place that says what an `objectPermissions` row, or a god-mode
 * system permission, lets its holder DO on an object.
 *
 * Several access tools used to re-derive this privately (`allowEdit ||
 * modifyAllRecords` here, `allowRead || viewAllRecords` there), and each copy
 * applied a different slice of the platform's implication rules. This module
 * applies them all, once:
 *
 *   - Modify All  ⇒ Read, Edit, Delete, View All (on every record)
 *   - View All    ⇒ Read (on every record)
 *   - Delete      ⇒ Read, Edit
 *   - Edit/Create ⇒ Read
 *   - `ModifyAllData` ⇒ every capability on every object
 *   - `ViewAllData`   ⇒ Read + View All on every object
 *
 * The platform refuses to save a container that violates these dependencies,
 * so applying them never invents access — it only stops a tool from
 * UNDER-stating access when a capture carries the higher flag alone.
 */

/** The object capabilities, in the platform's own escalating order. */
export const OBJECT_CAPABILITIES = [
  'read',
  'create',
  'edit',
  'delete',
  'viewAll',
  'modifyAll',
] as const;

export type ObjectCapability = (typeof OBJECT_CAPABILITIES)[number];

const ORDER: ReadonlyMap<ObjectCapability, number> = new Map(
  OBJECT_CAPABILITIES.map((c, i) => [c, i]),
);

/** Sort capabilities into the canonical {@link OBJECT_CAPABILITIES} order. */
export const sortCapabilities = (
  caps: Iterable<ObjectCapability>,
): ObjectCapability[] =>
  [...new Set(caps)].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));

/** Add every capability the platform implies from the ones already held. */
export const closeObjectCapabilities = (
  declared: Iterable<ObjectCapability>,
): Set<ObjectCapability> => {
  const out = new Set(declared);
  if (out.has('modifyAll')) {
    out.add('viewAll');
    out.add('delete');
    out.add('edit');
  }
  if (out.has('viewAll')) out.add('read');
  if (out.has('delete')) out.add('edit');
  if (out.has('edit') || out.has('create')) out.add('read');
  return out;
};

/** Effective capabilities conferred by one `grantedBy` objectPermissions edge. */
export const objectCapabilitiesFromGrant = (
  p: Readonly<Record<string, unknown>>,
): Set<ObjectCapability> => {
  const declared: ObjectCapability[] = [];
  if (p['allowRead'] === true) declared.push('read');
  if (p['allowCreate'] === true) declared.push('create');
  if (p['allowEdit'] === true) declared.push('edit');
  if (p['allowDelete'] === true) declared.push('delete');
  if (p['viewAllRecords'] === true) declared.push('viewAll');
  if (p['modifyAllRecords'] === true) declared.push('modifyAll');
  return closeObjectCapabilities(declared);
};

/**
 * Capabilities a container's SYSTEM permissions confer on EVERY object
 * (`ModifyAllData` / `ViewAllData`). Empty for anything else.
 */
export const objectCapabilitiesFromSystemPermissions = (
  userPermissions: unknown,
): Set<ObjectCapability> => {
  if (!Array.isArray(userPermissions)) return new Set();
  if (userPermissions.includes('ModifyAllData')) {
    return closeObjectCapabilities(['modifyAll', 'create']);
  }
  if (userPermissions.includes('ViewAllData')) {
    return closeObjectCapabilities(['viewAll']);
  }
  return new Set();
};

/**
 * Every granter kind a `who_can_access_object` row can carry: Profile / PermissionSet (object and
 * system permissions) and the sharing-rule targets and their expanded members.
 * A `principalType` outside this list is rejected, never answered as an empty
 * list (an unknown kind would otherwise read as "nobody"). A Queue is not one:
 * it grants no object access and is never a sharing-rule target.
 */
export const GRANTER_KINDS = [
  'Profile',
  'PermissionSet',
  'Role',
  'Group',
  'User',
  'Territory',
] as const;
