/**
 * Shared receiver resolution for the Apex scanner's `readsFrom` / `writesTo` /
 * `callsApex` / `dispatchesAsync` edges — the LEXICAL predicates, and the
 * GRAPH-VERIFIED classification that supersedes them.
 *
 * The scanner keys an edge on the TEXTUAL receiver token, so an un-type-resolved
 * local variable or an Apex `this`/`super` member produces an edge to a phantom
 * id (`CustomField:acc.Status__c`, `CustomField:this.y`, `ApexClass:acc`). The
 * lexical predicates below catch that lowercase-local shape and nothing else —
 * which is the reason they were never enough. A receiver that LOOKS like an
 * SObject (`PascalCase`, `Something__c`, `ns__Thing__c`) is emitted as a real
 * component id no matter what it actually names, so an Apex class, an inner
 * DTO, a `__r` relationship traversal and a describe token (`Contact.fields`)
 * all sailed into resolved object / field lists — some at `parsed` confidence,
 * naming components that do not exist. Measured on one real 129-object vault:
 * 13.8% of the emitted object rows and 16.9% of the emitted field rows were not
 * Salesforce components at all.
 *
 * {@link resolveApexReceivers} closes that in ONE batched `listNodesByIds`: it
 * asks the vault what each receiver token IS, and {@link classifyApexTarget}
 * turns the answer into a typed verdict. `sfi.apex_structure` verifies its
 * `touches` block the same way and shares this vocabulary — `sobject` /
 * `apex-type` / `not-in-vault`, and the `ApexReceiverUnresolvedReason` tiers —
 * so the two can never disagree about the same edge.
 *
 * The verification is a QUERY, so it can fail. It fails LOUD: `resolveApexReceivers`
 * returns an error rather than a permissive index, and every consumer must
 * report `checked: false` with the reason. Falling back to the lexical guess is
 * exactly the bug this module exists to close.
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByIds, type GraphStore } from '@sf-intelligence/graph';

const FIELD_RECEIVER_RE = /^CustomField:([^.]+)\./;

/**
 * True for a CustomField id whose RECEIVER is an Apex `this`/`super` member or an
 * un-type-resolved local variable (a lowercase single identifier with no
 * namespace / custom `__` marker). PascalCase standard (`Account`), custom
 * (`Payment__c`), and namespaced (`hed__Course__c`) receivers are real fields and
 * return false — even when their node isn't vaulted (the legitimate phantom
 * surface, classified by the phantom taxonomy).
 */
export const isUnresolvedFieldReceiver = (fieldId: string): boolean => {
  const m = FIELD_RECEIVER_RE.exec(fieldId);
  const receiver = m?.[1];
  if (receiver === undefined) return false;
  if (receiver === 'this' || receiver === 'super') return true;
  return /^[a-z]/.test(receiver) && !receiver.includes('__');
};

const APEX_CALL_RE = /^ApexClass:(.+)$/;

/** Context handles / Trigger map tokens the scanner must never treat as classes. */
const HEURISTIC_APEX_CALL_ARTIFACTS = new Set([
  'newMap',
  'oldMap',
  'new',
  'old',
  'this',
  'super',
]);

/**
 * True for a `callsApex` / `dispatchesAsync` target whose class token is an
 * un-type-resolved local variable — a single-token all-lowercase camelCase
 * identifier (`acc`, `map`) or a known context handle (`oldMap`, `newMap`).
 *
 * Real Apex classes that violate PascalCase (e.g. `pkb_Controller`) or carry
 * namespace markers (`ns__Foo`) are NOT flagged — GRF-01.
 */
export const isUnresolvedApexCallTarget = (toId: string): boolean => {
  const m = APEX_CALL_RE.exec(toId);
  const cls = m?.[1];
  if (cls === undefined) return false;
  if (HEURISTIC_APEX_CALL_ARTIFACTS.has(cls)) return true;
  // Underscore-separated names are class api names, not locals (`pkb_Controller`).
  if (cls.includes('_')) return false;
  if (cls.includes('__')) return false;
  // Single-token all-lowercase camelCase → typical local (`acc`, `comment`).
  return /^[a-z][a-zA-Z0-9]*$/.test(cls);
};

// ---------------------------------------------------------------------------
// graph-verified receiver classification
// ---------------------------------------------------------------------------

const FIELD_PREFIX = 'CustomField:';
const OBJECT_PREFIX = 'CustomObject:';
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

/**
 * What THIS VAULT says a `readsFrom` / `writesTo` receiver token is.
 *
 * `not-in-vault` is deliberately one tier, not two: it mixes a real standard
 * SObject this vault did not retrieve with an Apex system type and an inner
 * class, and nothing in the vault separates them. Naming that tier as
 * unresolved is correct; claiming either reading is not.
 */
export type ApexReceiverKind = 'sobject' | 'apex-type' | 'not-in-vault';

/**
 * Why a `readsFrom` / `writesTo` target is NOT reported as a real object field.
 *
 * "Nobody could resolve this" and "this is provably not an SObject field" are
 * different facts, so each shape carries its own reason.
 *
 * The first five are the vocabulary `sfi.apex_structure` also emits, verbatim.
 * `receiver-not-verified` is this module's own sixth tier: the verification
 * QUERY failed, so no receiver was classified at all and nothing is claimed
 * either way — a NOT-CHECKED marker, never a finding about the token.
 */
export type ApexReceiverUnresolvedReason =
  /** `this.x` / an untyped local — the receiver is not a type at all. */
  | 'unresolved-receiver'
  /** The receiver names an ApexClass / ApexTrigger NODE here: an Apex member, not a field. */
  | 'apex-type-receiver'
  /** `Foo__r.Bar` — a field on the RELATED object, not on this one. */
  | 'relationship-traversal'
  /** `Contact.fields` / `X.SObjectType` — an Apex describe token, not a field. */
  | 'describe-token'
  /** Nothing here names the receiver: an unvaulted SObject, an Apex system type, or an inner class. */
  | 'receiver-not-in-vault'
  /** The verification query FAILED — not checked, so not claimed. */
  | 'receiver-not-verified';

/** One target that is NOT reported as a real component, with the reason. */
export interface ApexUnresolvedTarget {
  /** The raw `receiver.field` (or bare receiver) token, verbatim. NEVER a component id. */
  readonly token: string;
  readonly reason: ApexReceiverUnresolvedReason;
}

/**
 * The verdict for one `readsFrom` / `writesTo` target id.
 *
 * `resolved: true` means the receiver names an SObject node in THIS vault, so
 * the id may be surfaced as a component. Otherwise `unresolved` carries the raw
 * token and the typed reason, and the id must not be claimed.
 */
export type ApexTargetVerdict =
  | { readonly resolved: true; readonly componentId: ComponentId }
  | { readonly resolved: false; readonly unresolved: ApexUnresolvedTarget };

/**
 * Apex DESCRIBE tokens that read like a field name after a dot but are not
 * fields: `Contact.fields`, `Account.SObjectType`, `Case.fieldSets`.
 */
const DESCRIBE_TOKENS: ReadonlySet<string> = new Set([
  'fields',
  'sobjecttype',
  'fieldsets',
  'getdescribe',
]);

/**
 * Every receiver token the given `readsFrom` / `writesTo` target ids would
 * emit, so one batched query can answer for all of them.
 *
 * Takes ids rather than edges so a caller that already narrowed to targets
 * (and a caller holding whole edges) can both use it without a second shape.
 */
export const apexReceiverTokens = (targetIds: Iterable<string>): readonly string[] => {
  const names = new Set<string>();
  for (const id of targetIds) {
    if (id.startsWith(OBJECT_PREFIX)) {
      names.add(id.slice(OBJECT_PREFIX.length));
      continue;
    }
    if (!id.startsWith(FIELD_PREFIX)) continue;
    const rest = id.slice(FIELD_PREFIX.length);
    const dot = rest.indexOf('.');
    if (dot > 0) names.add(rest.slice(0, dot));
  }
  return [...names];
};

/** The vault's answer for each receiver token, from {@link resolveApexReceivers}. */
export interface ApexReceiverIndex {
  readonly kindOf: (receiver: string) => ApexReceiverKind;
  /** How many tokens were asked about — so a caller can say what was checked. */
  readonly tokenCount: number;
}

/**
 * Ask the vault, in ONE batched `listNodesByIds`, whether each receiver token
 * names an SObject, an Apex type, or nothing at all.
 *
 * Returns an ERROR when the query fails. It must not degrade into a permissive
 * index: an unverified receiver list is exactly what puts an Apex type in a
 * field list, so every caller reports `checked: false` and a reason instead.
 *
 * @example
 *   const idx = await resolveApexReceivers(ctx.graph, ['Account', 'MyDTO']);
 *   if (idx.ok) idx.value.kindOf('MyDTO'); // 'apex-type'
 */
export const resolveApexReceivers = async (
  graph: GraphStore,
  receivers: readonly string[],
): Promise<Result<ApexReceiverIndex, string>> => {
  const unique = [...new Set(receivers)];
  if (unique.length === 0) {
    return ok({ kindOf: () => 'not-in-vault' as const, tokenCount: 0 });
  }
  const probe = await listNodesByIds(graph, [
    ...unique.map((n) => `${OBJECT_PREFIX}${n}` as ComponentId),
    ...unique.map((n) => `${APEX_CLASS_PREFIX}${n}` as ComponentId),
    ...unique.map((n) => `${APEX_TRIGGER_PREFIX}${n}` as ComponentId),
  ]);
  if (!probe.ok) return err(probe.error.message);
  const known = new Set(probe.value.map((n) => n.id));
  return ok({
    tokenCount: unique.length,
    kindOf: (receiver: string): ApexReceiverKind =>
      known.has(`${OBJECT_PREFIX}${receiver}`)
        ? 'sobject'
        : known.has(`${APEX_CLASS_PREFIX}${receiver}`) ||
            known.has(`${APEX_TRIGGER_PREFIX}${receiver}`)
          ? 'apex-type'
          : 'not-in-vault',
  });
};

/**
 * Classify ONE `readsFrom` / `writesTo` target id against the vault's answer.
 *
 * `index` is `null` when the verification query failed — every target is then
 * unresolved with `receiver-not-verified`, so a failed check can never be read
 * as a clean resolved list.
 *
 * The tier order matters and mirrors `sfi.apex_structure`: the shape-only
 * verdicts (`unresolved-receiver`, `describe-token`, `relationship-traversal`)
 * are decided BEFORE the vault is consulted, because they are true regardless
 * of what the vault happens to hold.
 */
export const classifyApexTarget = (
  targetId: string,
  index: ApexReceiverIndex | null,
): ApexTargetVerdict => {
  const unresolved = (token: string, reason: ApexReceiverUnresolvedReason): ApexTargetVerdict => ({
    resolved: false,
    unresolved: { token, reason },
  });

  if (targetId.startsWith(OBJECT_PREFIX)) {
    const objectName = targetId.slice(OBJECT_PREFIX.length);
    if (index === null) return unresolved(objectName, 'receiver-not-verified');
    const kind = index.kindOf(objectName);
    if (kind === 'sobject') return { resolved: true, componentId: targetId as ComponentId };
    return unresolved(
      objectName,
      kind === 'apex-type' ? 'apex-type-receiver' : 'receiver-not-in-vault',
    );
  }

  if (!targetId.startsWith(FIELD_PREFIX)) {
    // Not a receiver-keyed id at all (a `callsApex` target, a Flow id): the
    // caller owns it, and this function must not silently demote it.
    return { resolved: true, componentId: targetId as ComponentId };
  }

  const rest = targetId.slice(FIELD_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return unresolved(rest, 'unresolved-receiver');
  const receiver = rest.slice(0, dot);
  const field = rest.slice(dot + 1);
  if (isUnresolvedFieldReceiver(targetId)) return unresolved(rest, 'unresolved-receiver');
  if (DESCRIBE_TOKENS.has((field.split('.')[0] ?? '').toLowerCase())) {
    return unresolved(rest, 'describe-token');
  }
  if (receiver.endsWith('__r') || field.includes('.')) {
    return unresolved(rest, 'relationship-traversal');
  }
  if (index === null) return unresolved(rest, 'receiver-not-verified');
  const kind = index.kindOf(receiver);
  if (kind === 'sobject') return { resolved: true, componentId: targetId as ComponentId };
  return unresolved(
    rest,
    kind === 'apex-type' ? 'apex-type-receiver' : 'receiver-not-in-vault',
  );
};

/** Human-readable gloss for each reason, for the tools' honesty surfaces. */
export const APEX_RECEIVER_REASON_GLOSS: Readonly<
  Record<ApexReceiverUnresolvedReason, string>
> = Object.freeze({
  'unresolved-receiver':
    '`this.x` / an untyped local — the scanner keys edges on the textual receiver, so this is not a type at all',
  'apex-type-receiver':
    'the receiver names an Apex class / trigger NODE in this vault, so the "field" is an Apex member, not an SObject field',
  'relationship-traversal':
    '`Foo__r.Bar` — a field on the RELATED object, not a field on this one',
  'describe-token': '`Contact.fields` / `X.SObjectType` — an Apex describe token, not a field',
  'receiver-not-in-vault':
    'nothing in this vault names the receiver: an SObject this vault does not carry, an Apex system type, or an inner class — this tier cannot be told apart, so it is not claimed either way',
  'receiver-not-verified':
    'the query that verifies receivers against the vault FAILED, so no target was checked and none is claimed',
});

/**
 * Census of demoted targets by reason, for a tool's honesty surface.
 *
 * Counts DISTINCT TOKENS, not edges: `readsFrom` + `writesTo` on the same
 * `Guard.hasRun` is ONE thing a caller could have mistaken for a component, and
 * counting it twice would overstate the defect. A per-STEP action count is a
 * different number and is reported separately (`unresolvedActionsOmitted`).
 */
export type ApexReceiverDemotionCounts = Partial<
  Record<ApexReceiverUnresolvedReason, number>
>;

/** Tally one verdict list into a per-reason census. */
export const apexReceiverDemotionCounts = (
  unresolved: readonly ApexUnresolvedTarget[],
): ApexReceiverDemotionCounts => {
  const counts: Record<string, number> = {};
  for (const row of unresolved) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  return counts as ApexReceiverDemotionCounts;
};

/**
 * One sentence naming what a demotion census means, for a tool's `disclosure`.
 *
 * A ZERO census returns the CHECKED-and-nothing-demoted sentence rather than
 * nothing at all, so an absent demotion list is never ambiguous between "we
 * checked and everything resolved" and "we never checked".
 *
 * @param from - the field the rows were demoted OUT of (`fieldAccess`).
 * @param into - the field they landed IN (`unresolvedFieldAccess`).
 */
export const apexReceiverDemotionNote = (
  counts: ApexReceiverDemotionCounts,
  from: string,
  into: string,
): string => {
  const rows = (Object.entries(counts) as [ApexReceiverUnresolvedReason, number][])
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) {
    return ` Every Apex field-access receiver behind \`${from}\` was CHECKED against this vault and each one names an SObject node here, so nothing was demoted — that empty \`${into}\` is CHECKED-and-empty.`;
  }
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  const detail = rows
    .map(([reason, n]) => `${n} ${reason} (${APEX_RECEIVER_REASON_GLOSS[reason]})`)
    .join('; ');
  return ` ${total} DISTINCT Apex field-access token(s) were CHECKED against this vault, found NOT to name an SObject node, and demoted out of \`${from}\` into \`${into}\` as RAW TOKENS with a reason — ${detail}. The Apex scanner keys its edges on the TEXTUAL receiver, so these are parse artifacts, not components: do not read them as fields, and do not re-query them as component ids.`;
};

/** The verbatim NOT-CHECKED sentence for a failed receiver-verification query. */
export const apexReceiverNotCheckedNote = (
  reason: string,
  from: string,
): string =>
  ` NOT CHECKED — the query that verifies each Apex field-access receiver against this vault FAILED (${reason}), and an unverified receiver list is exactly what puts an Apex type in a field list. \`${from}\` is therefore EMPTY because nothing could be verified, not because this component touches no fields; every target is listed as a raw token with reason \`receiver-not-verified\`.`;

// ---------------------------------------------------------------------------
// action-list partition (the save-order composers)
// ---------------------------------------------------------------------------

/**
 * The minimum shape the save-order composers' `SoeStepAction` satisfies.
 * Structural so `what_happens_on_save` and `order_of_execution` can each keep
 * their own action type and still share this partition.
 */
export interface ApexTargetedAction {
  readonly kind: string;
  readonly targetId?: string;
}

/**
 * Every receiver token a step's action list would emit, so ONE batched query
 * can answer for a WHOLE composition rather than one query per firer.
 */
export const apexActionReceiverTokens = (
  actions: Iterable<ApexTargetedAction>,
): readonly string[] => {
  const ids: string[] = [];
  for (const action of actions) {
    if (action.kind !== 'readsFrom' && action.kind !== 'writesTo') continue;
    if (action.targetId !== undefined) ids.push(action.targetId);
  }
  return apexReceiverTokens(ids);
};

/** What {@link partitionApexActions} kept, and what it demoted with a reason. */
export interface ApexActionPartition<A> {
  readonly kept: readonly A[];
  readonly demoted: readonly ApexUnresolvedTarget[];
}

/**
 * Split an action list into the actions that name REAL components and the
 * scanner artifacts that do not.
 *
 * Two families are demoted, for two different reasons:
 *
 *   - `readsFrom` / `writesTo` — verified against the vault via `index`. Before
 *     this check, only lowercase locals were caught, so an Apex class name, an
 *     inner DTO, a `__r` traversal and a describe token were all emitted as
 *     save-time FIELD actions on components that do not exist.
 *   - `callsApex` / `dispatchesAsync` — the pre-existing lexical local-variable
 *     test ({@link isUnresolvedApexCallTarget}). These were already dropped;
 *     they are now RETURNED so the composer can disclose them instead of
 *     deleting them silently.
 *
 * `index === null` (the verification query failed) demotes every field-access
 * action with `receiver-not-verified` — never a silent fall back to the guess.
 */
export const partitionApexActions = <A extends ApexTargetedAction>(
  actions: readonly A[],
  index: ApexReceiverIndex | null,
): ApexActionPartition<A> => {
  const kept: A[] = [];
  const demoted: ApexUnresolvedTarget[] = [];
  for (const action of actions) {
    const targetId = action.targetId;
    if (targetId === undefined) {
      kept.push(action);
      continue;
    }
    if (action.kind === 'readsFrom' || action.kind === 'writesTo') {
      const verdict = classifyApexTarget(targetId, index);
      if (verdict.resolved) kept.push(action);
      else demoted.push(verdict.unresolved);
      continue;
    }
    if (
      (action.kind === 'callsApex' || action.kind === 'dispatchesAsync') &&
      isUnresolvedApexCallTarget(targetId)
    ) {
      demoted.push({
        token: targetId.slice(targetId.indexOf(':') + 1),
        reason: 'unresolved-receiver',
      });
      continue;
    }
    kept.push(action);
  }
  return { kept, demoted };
};

/**
 * Cap on the composition-level demoted-token list. The per-reason CENSUS is
 * always complete; only the token sample is capped, because these lists ride
 * inside a byte-budgeted save-order payload and must not compete with the
 * steps for room.
 */
export const APEX_RECEIVER_TOKEN_CAP = 40;

/**
 * The composition-level honesty block both save-order composers emit.
 *
 * `checked: false` is the ONLY state in which `demoted` is `null`: there is no
 * census when nothing was classified. A `checked: true` block with an empty
 * census is a CHECKED zero — every receiver resolved to an SObject here.
 */
export interface ApexReceiverVerification {
  readonly checked: boolean;
  /** Why the check did not run. `null` when it did. */
  readonly reason: string | null;
  /**
   * Complete per-reason census of the demoted TOKENS. `null` when not checked.
   * Deduped, so it counts things-that-are-not-components, not edges; a step's
   * `unresolvedActionsOmitted` counts the ACTIONS that step lost.
   */
  readonly demoted: ApexReceiverDemotionCounts | null;
  /** Deduped sample of the raw tokens, sorted, capped at {@link APEX_RECEIVER_TOKEN_CAP}. */
  readonly tokens: readonly ApexUnresolvedTarget[];
  /** True when `tokens` is a capped sample of a longer list. */
  readonly tokensTruncated: boolean;
}

/**
 * Build the composition-level block from every demoted row a composition saw.
 * Dedupes by token (first reason wins — the tiers are disjoint per id).
 */
export const buildApexReceiverVerification = (
  demoted: readonly ApexUnresolvedTarget[],
  checkFailureReason: string | null,
): ApexReceiverVerification => {
  const unique = new Map<string, ApexUnresolvedTarget>();
  for (const row of demoted) if (!unique.has(row.token)) unique.set(row.token, row);
  const sorted = [...unique.values()].sort((a, b) => a.token.localeCompare(b.token));
  return {
    checked: checkFailureReason === null,
    reason: checkFailureReason,
    demoted:
      checkFailureReason === null ? apexReceiverDemotionCounts(sorted) : null,
    tokens: sorted.slice(0, APEX_RECEIVER_TOKEN_CAP),
    tokensTruncated: sorted.length > APEX_RECEIVER_TOKEN_CAP,
  };
};

/**
 * A save-order step whose `actions` may be partitioned in place. Structural —
 * both composers' own `SoeStep` satisfy it — and deliberately mutable, the same
 * contract `BoundableStep` uses for the byte-budget pass.
 */
export interface ReceiverVerifiableStep {
  actions: readonly ApexTargetedAction[];
  unresolvedActionsOmitted?: number;
}

/**
 * Verify every save-order step's field-access receivers against the vault, IN
 * PLACE, and return the composition-level honesty block.
 *
 * ONE batched query answers for the WHOLE composition, not one per firer: the
 * save-order tools' pinned query budget requires a count that does not scale
 * with the object's fan-out, and a per-step probe would have broken it.
 *
 * A failed probe demotes EVERY field-access action with `receiver-not-verified`
 * and returns `checked: false` — the caller must surface that, because an
 * unverified action list is exactly the defect this closes.
 *
 * @example
 *   const v = await verifyStepActionReceivers(ctx.graph, soe as ReceiverVerifiableStep[]);
 *   if (!v.checked) data.disclosure += apexReceiverNotCheckedNote(v.reason ?? '', 'soe[].actions');
 */
export const verifyStepActionReceivers = async (
  graph: GraphStore,
  steps: readonly ReceiverVerifiableStep[],
): Promise<ApexReceiverVerification> => {
  const tokens = apexActionReceiverTokens(steps.flatMap((s) => [...s.actions]));
  const probe = await resolveApexReceivers(graph, tokens);
  const index = probe.ok ? probe.value : null;
  const demoted: ApexUnresolvedTarget[] = [];
  for (const step of steps) {
    const split = partitionApexActions(step.actions, index);
    if (split.demoted.length === 0) continue;
    step.actions = split.kept;
    step.unresolvedActionsOmitted =
      (step.unresolvedActionsOmitted ?? 0) + split.demoted.length;
    demoted.push(...split.demoted);
  }
  return buildApexReceiverVerification(demoted, probe.ok ? null : probe.error);
};

/**
 * The `disclosure` sentence for a save-order composition's verification block —
 * CHECKED-with-a-census, CHECKED-and-clean, or NOT CHECKED. Always emitted, so
 * an absent demotion list is never ambiguous.
 */
export const soeReceiverVerificationNote = (
  verification: ApexReceiverVerification,
): string =>
  verification.checked
    ? apexReceiverDemotionNote(
        verification.demoted ?? {},
        'soe[].actions',
        'receiverVerification.tokens',
      ) +
      (verification.tokensTruncated
        ? ` The token sample is capped at ${APEX_RECEIVER_TOKEN_CAP}; the per-reason census above is complete.`
        : '')
    : apexReceiverNotCheckedNote(
        verification.reason ?? 'reason not reported',
        'soe[].actions field-access rows',
      );
