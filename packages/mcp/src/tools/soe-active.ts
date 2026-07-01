/**
 * Active/inactive filtering for SOE composition tools. Execution answers list
 * only automation that would run; inactive configured automation is disclosed
 * separately.
 */

import type { ComponentId, ComponentType, Node } from '@sf-intelligence/contracts';

export interface InactiveConfiguredFirer {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly inactiveReason: string;
}

/**
 * Whether a firer node represents automation that runs at save time. Flow uses
 * `status === 'Active'`; WorkflowRule, ValidationRule, and ApprovalProcess use
 * `active: true`; ApexTrigger uses `status !== 'Inactive'` (the extractor
 * emits `status: Active | Inactive` from the trigger's `<status>` element).
 * Missing status/active is treated as active (conservative prior).
 */
export const isActiveSoeFirer = (node: Node): boolean => {
  const props = node.properties;
  if (node.type === 'Flow') {
    const status = props['status'];
    if (typeof status === 'string') return status === 'Active';
    return true;
  }
  if (node.type === 'ApexTrigger') {
    const status = props['status'];
    // The extractor records `status: Active | Inactive` from the trigger XML.
    // Treat absent status as active (conservative prior for older vault data).
    if (typeof status === 'string') return status !== 'Inactive';
    return true;
  }
  if (
    node.type === 'WorkflowRule' ||
    node.type === 'ApprovalProcess' ||
    node.type === 'ValidationRule'
  ) {
    const active = props['active'];
    if (typeof active === 'boolean') return active;
    return true;
  }
  return true;
};

const inactiveReasonFor = (node: Node): string => {
  if (node.type === 'Flow') {
    const status = node.properties['status'];
    return typeof status === 'string' ? `status: ${status}` : 'status: unknown';
  }
  if (node.type === 'ApexTrigger') {
    const status = node.properties['status'];
    return typeof status === 'string' ? `status: ${status}` : 'status: Inactive';
  }
  if (
    node.type === 'WorkflowRule' ||
    node.type === 'ApprovalProcess' ||
    node.type === 'ValidationRule'
  ) {
    return 'active: false';
  }
  return 'inactive';
};

/** Record an inactive firer once in the collector (deduped by id). */
export const recordInactiveSoeFirer = (
  collector: Map<ComponentId, InactiveConfiguredFirer>,
  node: Node,
): void => {
  if (isActiveSoeFirer(node)) return;
  if (collector.has(node.id)) return;
  collector.set(node.id, {
    componentId: node.id,
    componentType: node.type,
    apiName: node.apiName,
    inactiveReason: inactiveReasonFor(node),
  });
};

/** True when the firer is inactive and was recorded — caller should skip SOE emission. */
export const skipInactiveSoeFirer = (
  collector: Map<ComponentId, InactiveConfiguredFirer>,
  node: Node,
): boolean => {
  if (isActiveSoeFirer(node)) return false;
  recordInactiveSoeFirer(collector, node);
  return true;
};

export const sortedInactiveConfigured = (
  collector: Map<ComponentId, InactiveConfiguredFirer>,
): readonly InactiveConfiguredFirer[] =>
  [...collector.values()].sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );
