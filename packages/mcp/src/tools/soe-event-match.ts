/**
 * Which DML events each save-order firer runs on — ONE copy shared by
 * `sfi.what_happens_on_save`, `sfi.order_of_execution` and the save re-entry
 * report (`soe-reentry.ts`).
 *
 * The two tools used to carry their own copies "byte-for-byte", and they had
 * already drifted: `what_happens_on_save` treated a record-triggered Flow with
 * no `recordTriggerType` as the platform's `CreateAndUpdate` default, while
 * `order_of_execution` silently dropped it from every event chain.
 *
 * `upsert` is the union of insert and update. {@link upsertFiresOn} derives,
 * from the SAME matchers, which of the two a step actually fires on, so an
 * upsert answer can say a Create-only flow is insert-only instead of
 * presenting it as running on every save.
 */

export type SaveEvent = 'insert' | 'update' | 'upsert' | 'delete' | 'undelete';

/** Alias of {@link SaveEvent}, kept for the re-entry report's callers. */
export type SoeDmlEvent = SaveEvent;

/** The two events an `upsert` composition merges. */
export type UpsertBranch = 'insert' | 'update';
const UPSERT_BRANCHES: readonly UpsertBranch[] = ['insert', 'update'];

/**
 * WorkflowRule `triggerType` vs event. Workflows never fire on delete /
 * undelete; `onCreateOnly` is insert-only, every other value insert + update.
 */
export const workflowMatchesEvent = (triggerType: unknown, event: SaveEvent): boolean => {
  if (typeof triggerType !== 'string') return false;
  if (event === 'delete' || event === 'undelete') return false;
  if (event === 'upsert') return true;
  if (event === 'insert') {
    return (
      triggerType === 'onCreateOnly' ||
      triggerType === 'onCreateOrTriggeringUpdate' ||
      triggerType === 'onAllChanges' ||
      triggerType === 'onCreateOrAllChanges'
    );
  }
  if (event === 'update') {
    return (
      triggerType === 'onCreateOrTriggeringUpdate' ||
      triggerType === 'onAllChanges' ||
      triggerType === 'onCreateOrAllChanges'
    );
  }
  return false;
};

/**
 * Record-triggered Flow `recordTriggerType` (`Create` / `Update` /
 * `CreateAndUpdate` / `Delete`) vs event. An ABSENT value is the platform's
 * `CreateAndUpdate` default — a real, firing flow, never dropped — and never
 * implies a delete-triggered flow. Flows have no undelete trigger.
 */
export const flowMatchesEvent = (recordTriggerType: unknown, event: SaveEvent): boolean => {
  const effective = typeof recordTriggerType === 'string' ? recordTriggerType : 'CreateAndUpdate';
  if (event === 'undelete') return false;
  if (event === 'delete') return effective === 'Delete';
  if (event === 'upsert') {
    return effective === 'Create' || effective === 'Update' || effective === 'CreateAndUpdate';
  }
  if (event === 'insert') return effective === 'Create' || effective === 'CreateAndUpdate';
  return effective === 'Update' || effective === 'CreateAndUpdate';
};

/**
 * ApexTrigger `events` (`'before insert'`, `'after update'`, …) vs event at a
 * timing. `upsert` matches a trigger on insert OR update at that timing.
 */
export const triggerMatchesEvent = (
  events: unknown,
  event: SaveEvent,
  timing: 'before' | 'after',
): boolean => {
  if (!Array.isArray(events)) return false;
  for (const e of events) {
    if (typeof e !== 'string' || !e.startsWith(`${timing} `)) continue;
    const action = e.slice(timing.length + 1);
    if (event === 'upsert' ? action === 'insert' || action === 'update' : action === event) return true;
  }
  return false;
};

/** The upsert branches (insert / update) on which `matches` holds. */
export const upsertFiresOn = (matches: (event: UpsertBranch) => boolean): readonly UpsertBranch[] =>
  UPSERT_BRANCHES.filter((e) => matches(e));

/** Both branches — for phases that run on every insert and update save. */
export const BOTH_UPSERT_BRANCHES: readonly UpsertBranch[] = UPSERT_BRANCHES;
