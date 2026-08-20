/**
 * The LEAD CONVERT chain — Salesforce's documented lead-conversion sequence,
 * instantiated against THIS org's extracted metadata.
 *
 * ## Documented sequence this module implements
 *
 * Source of truth: the Salesforce Metadata / Apex developer documentation for
 * lead conversion — `Database.convertLead` / `LeadConvert`, the "Convert Leads"
 * setup documentation, and `LeadConvertSettings` (the metadata type that holds
 * the convert field mapping). The order below is the platform's, not this
 * tool's invention:
 *
 *   1. The convert request is raised (Convert button, `Database.convertLead`,
 *      or the Flow `convertLead` action) and the platform guards it: the Lead
 *      must not already be converted, and the running user needs Convert Leads
 *      plus create/edit on the target objects.
 *   2. Lead-side validation rules and triggers run — but ONLY when the org's
 *      Lead Settings enable validation and triggers for lead convert.
 *   3. Duplicate / matching rules evaluate against the records the convert will
 *      create or match.
 *   4. The convert field mapping projects Lead fields onto Account / Contact /
 *      Opportunity fields.
 *   5. The Account is created (or an existing one is matched) — a FULL insert
 *      order of execution on Account.
 *   6. The Contact is created (or matched) — a FULL insert order of execution
 *      on Contact.
 *   7. An Opportunity is created unless the request opts out — a FULL insert
 *      order of execution on Opportunity.
 *   8. The Lead is updated: `IsConverted`, `ConvertedAccountId`,
 *      `ConvertedContactId`, `ConvertedOpportunityId`, `ConvertedDate`, and the
 *      converted `Status` — a FULL update order of execution on Lead.
 *   9. Ownership is applied to the created records from the convert request.
 *  10. Open activities, notes, attachments and campaign members are re-parented
 *      onto the created records.
 *
 * Steps 5–8 are the insight this module exists to surface: ONE convert action
 * fires up to FOUR complete save orders. Those are composed by calling
 * `what_happens_on_save` (via {@link composeNestedSave}), not by reimplementing
 * it — see that helper's JSDoc.
 *
 * ## What this module does NOT claim
 *
 * Every step is static composition over declared metadata. Conditions are
 * LISTED, never EVALUATED. Steps 4 and 9 are structurally unfillable from an
 * offline vault and are emitted as `unresolved` with the reason attached rather
 * than dropped; step 10's automation consequences are emitted as `not-modeled`.
 * A convert that matches an EXISTING Account instead of creating one runs that
 * object's UPDATE order, not the INSERT order modeled here — that fork is a
 * runtime property of the request and is disclosed, not guessed.
 */

import type { ComponentId, ComponentType, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import {
  type ChainComponentRef,
  type ChainStep,
  composeNestedSave,
  familyAbsence,
  fetchOwnedChildren,
  fetchRegisteredFirers,
  suppressedNestedSave,
  toChainRef,
} from './action-chain-model.js';
import { isActiveSoeFirer } from './soe-active.js';

/** The frozen, documented phase sequence of a lead convert. */
export const LEAD_CONVERT_PHASES = [
  'convert-request',
  'lead-validation',
  'convert-duplicate-check',
  'convert-field-mapping',
  'account-save',
  'contact-save',
  'opportunity-save',
  'lead-update',
  'ownership-assignment',
  'activity-carryover',
] as const;
export type LeadConvertPhase = (typeof LEAD_CONVERT_PHASES)[number];

const LEAD = 'Lead';
const LEAD_OBJECT_ID: ComponentId = 'CustomObject:Lead';

/**
 * The Flow invocable-action type for "Convert Lead". A record-triggered or
 * screen Flow that carries an `<actionCalls>` element with this `actionType`
 * INVOKES a conversion, which is the only invocation path this vault can see
 * (see {@link APEX_INVOCATION_BLIND_SPOT}).
 */
const FLOW_CONVERT_ACTION_TYPE = 'convertLead';

/**
 * The Apex invocation path this tool CANNOT see, stated as a blind spot rather
 * than omitted. The Apex extractor records field-level `readsFrom`/`writesTo`
 * edges and a small set of classifier booleans (`isBatchable`, `isQueueable`,
 * …); it does not record which platform methods a class calls, so
 * `Database.convertLead(...)` leaves no trace in the graph.
 */
const APEX_INVOCATION_BLIND_SPOT =
  'Apex that calls `Database.convertLead(...)` is NOT detected. The Apex scanner records field-level readsFrom/writesTo edges, not platform-method invocations, so a class that converts leads programmatically is invisible to this composition. This is a blind spot in this tool, NOT a claim that no Apex converts leads in this org. Grep the vault source or use `sfi.find_code_usages` against the fields a converter writes to close it manually.';

/**
 * The field-mapping metadata this vault does not hold. The Lead convert field
 * mapping lives in the `LeadConvertSettings` metadata type (its
 * `objectMapping` entries, each carrying `mappingFields` of
 * `inputField`→`outputField`). `LeadConvertSettings` is not a ComponentType
 * this product extracts, so the mapping is structurally absent — a HOLE, not a
 * zero, and never to be rendered as "no fields are mapped".
 */
const FIELD_MAPPING_UNRESOLVED =
  'The Lead convert field mapping lives in the `LeadConvertSettings` metadata type (`objectMapping[].mappingFields[]`, each an `inputField` → `outputField` pair). `LeadConvertSettings` is NOT a component family this product extracts, so this vault holds ZERO of the mapping. This step is UNRESOLVED — it is a hole in the answer, NOT a finding that no fields are mapped. Standard Lead→Account/Contact/Opportunity field mappings are platform defaults and are also not enumerated here. Read the mapping in Setup (Object Manager → Lead → Fields & Relationships → Map Lead Fields) or retrieve `LeadConvertSettings` directly.';

/**
 * Whether Lead validation rules and triggers execute DURING the conversion is
 * an org Setup toggle (Lead Settings → require validation and triggers for lead
 * convert), not component metadata. The vault holds the rules; it does not hold
 * the switch.
 */
const LEAD_VALIDATION_GATE_REASON =
  'Whether these Lead validation rules and triggers actually execute during a CONVERT (as opposed to an ordinary Lead edit) is controlled by an org-level Lead Settings toggle that enables validation and triggers for lead convert. That toggle is Setup configuration, not component metadata, and is not in this vault. The roster below is real and complete for the Lead object; its FIRING at convert time is unresolved. Do not read this step as "these will run", and do not read it as "these will not run".';

const VALIDATION_TYPES: ReadonlySet<ComponentType> = new Set(['ValidationRule']);
const DUPLICATE_TYPES: ReadonlySet<ComponentType> = new Set(['DuplicateRule']);
const ASSIGNMENT_TYPES: ReadonlySet<ComponentType> = new Set(['AssignmentRule']);
const ACTIVITY_AUTOMATION_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApexTrigger',
  'Flow',
]);

/** Objects a convert writes to, in documented creation order. */
const CONVERT_TARGETS: readonly {
  readonly phase: LeadConvertPhase;
  readonly object: string;
  readonly optional: boolean;
}[] = [
  { phase: 'account-save', object: 'Account', optional: false },
  { phase: 'contact-save', object: 'Contact', optional: false },
  { phase: 'opportunity-save', object: 'Opportunity', optional: true },
];

/** Options the handler threads into the composer. */
export interface LeadConvertChainOptions {
  /** 0 suppresses nested save expansion; 1 expands it (the documented cap). */
  readonly nestedSaveDepth: 0 | 1;
  /** Collector the nested save-order engine's verbatim disclosure dedupes into. */
  readonly soeDisclosureSink: Set<string>;
}

/** A step under construction, before its `stepIndex` is stamped. */
type PartialStep = Omit<ChainStep, 'stepIndex'>;

/**
 * Find every Flow that invokes the platform `convertLead` action, by scanning
 * the `properties.actionCalls` summary the Flow extractor stamps for EVERY
 * `<actionCalls>` element (apex and non-apex alike). This is the one invocation
 * path the vault can ground; see {@link APEX_INVOCATION_BLIND_SPOT} for the one
 * it cannot.
 *
 * Returns `scanTruncated` when the Flow scan hit the node-scan cap, so an
 * incomplete list is never presented as the whole set.
 */
const findConvertingFlows = async (
  ctx: Context,
): Promise<
  Result<{ readonly flows: readonly Node[]; readonly scanTruncated: boolean }, string>
> => {
  const FLOW_SCAN_LIMIT = 500;
  const flowsResult = await listNodesByType(ctx.graph, 'Flow', {
    limit: FLOW_SCAN_LIMIT,
  });
  if (!flowsResult.ok) return err(flowsResult.error.message);
  const matched: Node[] = [];
  for (const flow of flowsResult.value) {
    const calls = flow.properties['actionCalls'];
    if (!Array.isArray(calls)) continue;
    const invokes = calls.some(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        (c as Record<string, unknown>)['actionType'] === FLOW_CONVERT_ACTION_TYPE,
    );
    if (invokes) matched.push(flow);
  }
  return ok({
    flows: matched.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    scanTruncated: flowsResult.value.length >= FLOW_SCAN_LIMIT,
  });
};

/** Resolve the MatchingRules a DuplicateRule invokes (its `references` edges). */
const matchingRulesFor = async (
  ctx: Context,
  duplicateRuleId: ComponentId,
): Promise<Result<readonly ComponentId[], string>> => {
  const edges = await listEdges(ctx.graph, duplicateRuleId, {
    direction: 'out',
    edgeType: 'references',
  });
  if (!edges.ok) return err(edges.error.message);
  return ok([...edges.value.map((e) => e.toId)].sort());
};

/**
 * Compose the lead-convert chain for this org.
 *
 * Emits EVERY documented step, in documented order, whether or not this vault
 * could fill it. A step the vault cannot fill carries its typed reason; a step
 * this tool does not model says so by name. Nothing is silently omitted.
 */
export const composeLeadConvertChain = async (
  ctx: Context,
  options: LeadConvertChainOptions,
): Promise<Result<readonly ChainStep[], string>> => {
  const steps: PartialStep[] = [];

  // ---- 1. convert-request -------------------------------------------------
  const convertingFlows = await findConvertingFlows(ctx);
  if (!convertingFlows.ok) return err(convertingFlows.error);
  const flowRefs = convertingFlows.value.flows.map((f) =>
    toChainRef(
      f,
      'convert-invoker',
      `Flow carries an actionCalls element with actionType="${FLOW_CONVERT_ACTION_TYPE}"`,
    ),
  );
  steps.push({
    phase: 'convert-request',
    title: 'Convert request raised and platform-guarded',
    resolution: flowRefs.length > 0 ? 'resolved' : 'platform-step',
    components: flowRefs,
    note: `A convert is raised from the Convert button, from Apex \`Database.convertLead\`, or from a Flow \`${FLOW_CONVERT_ACTION_TYPE}\` action. The platform then refuses the request if the Lead is already converted (\`IsConverted\`) or the running user lacks Convert Leads plus create/edit on the target objects. Those permission checks are per-user runtime evaluation and are NOT evaluated here — use \`sfi.user_ability\` / \`sfi.effective_permissions\` for the access question.${convertingFlows.value.scanTruncated ? ' The Flow scan hit its node cap, so the invoker list below may be incomplete.' : ''}`,
  });
  steps.push({
    phase: 'convert-request',
    title: 'Apex convert invocations',
    resolution: 'not-modeled',
    components: [],
    note: 'The other programmatic invocation path for a convert.',
    notModeledReason: APEX_INVOCATION_BLIND_SPOT,
  });

  // ---- 2. lead-validation -------------------------------------------------
  const leadValidations = await fetchOwnedChildren(
    ctx,
    LEAD_OBJECT_ID,
    VALIDATION_TYPES,
  );
  if (!leadValidations.ok) return err(leadValidations.error);
  const activeLeadVrs = leadValidations.value.filter(isActiveSoeFirer);
  const inactiveLeadVrs = leadValidations.value.length - activeLeadVrs.length;
  const vrAbsence = familyAbsence(ctx, 'ValidationRule');
  steps.push({
    phase: 'lead-validation',
    title: 'Lead validation rules and Lead triggers during convert',
    resolution: activeLeadVrs.length > 0 ? 'resolved' : vrAbsence.resolution,
    components: activeLeadVrs.map((n) =>
      toChainRef(n, 'lead-validation-rule', 'listed, NOT evaluated'),
    ),
    note: `Lead-side validation runs before any target record is created. The full Lead-side trigger roster is in the \`lead-update\` step below, which composes the Lead object's own update save order.${inactiveLeadVrs > 0 ? ` ${inactiveLeadVrs} INACTIVE validation rule(s) on Lead are excluded from this roster — they are configured but would not run; \`what_happens_on_save\` lists them under \`inactiveConfigured\`.` : ''}`,
    ...(activeLeadVrs.length > 0
      ? {}
      : vrAbsence.resolution === 'verified-none'
        ? { absenceBasis: `${vrAbsence.basis} This org has no ACTIVE validation rule on Lead.` }
        : { unresolvedReason: vrAbsence.basis }),
    gate: {
      setting: 'Lead Settings — validation and triggers for lead convert',
      status: 'unresolved',
      reason: LEAD_VALIDATION_GATE_REASON,
    },
  });

  // ---- 3. convert-duplicate-check ----------------------------------------
  const leadDupRules = await fetchOwnedChildren(
    ctx,
    LEAD_OBJECT_ID,
    DUPLICATE_TYPES,
  );
  if (!leadDupRules.ok) return err(leadDupRules.error);
  const activeDupRules = leadDupRules.value.filter(isActiveSoeFirer);
  const inactiveDupRules = leadDupRules.value.length - activeDupRules.length;
  const dupRefs: ChainComponentRef[] = [];
  for (const rule of activeDupRules) {
    const ops = rule.properties['operationsOnInsert'];
    dupRefs.push(
      toChainRef(
        rule,
        'lead-duplicate-rule',
        Array.isArray(ops) && ops.length > 0
          ? `declared insert operations: ${ops.filter((o): o is string => typeof o === 'string').join(', ')}`
          : 'declared operations not extracted on this rule',
      ),
    );
    const matching = await matchingRulesFor(ctx, rule.id);
    if (!matching.ok) return err(matching.error);
    for (const id of matching.value) {
      dupRefs.push({
        componentId: id,
        componentType: 'MatchingRule',
        apiName: id.startsWith('MatchingRule:') ? id.slice('MatchingRule:'.length) : id,
        role: 'matching-rule',
        note: `invoked by ${rule.apiName}`,
      });
    }
  }
  const dupAbsence = familyAbsence(ctx, 'DuplicateRule');
  steps.push({
    phase: 'convert-duplicate-check',
    title: 'Duplicate and matching rules on the Lead at convert',
    resolution: dupRefs.length > 0 ? 'resolved' : dupAbsence.resolution,
    components: dupRefs,
    note: `Lead-scoped duplicate rules and the matching rules they invoke. Duplicate rules on the objects the convert CREATES (Account, Contact) are NOT repeated here — they appear inside those objects' nested insert chains below, in the save order's own \`duplicate-rules\` phase, so nothing is double-counted. Whether any given record actually matches a rule requires record data this offline vault does not hold.${inactiveDupRules > 0 ? ` ${inactiveDupRules} INACTIVE duplicate rule(s) on Lead are excluded — configured but not running.` : ''}`,
    ...(dupRefs.length > 0
      ? {}
      : dupAbsence.resolution === 'verified-none'
        ? { absenceBasis: `${dupAbsence.basis} This org has no ACTIVE duplicate rule on Lead.` }
        : { unresolvedReason: dupAbsence.basis }),
  });

  // ---- 4. convert-field-mapping ------------------------------------------
  steps.push({
    phase: 'convert-field-mapping',
    title: 'Convert field mapping (Lead field → Account / Contact / Opportunity field)',
    resolution: 'unresolved',
    components: [],
    note: 'The mapping that decides which Lead field value lands on which target field, applied BEFORE the target records are saved — so a mapped value is present for every validation rule, trigger and flow in the three nested chains below.',
    unresolvedReason: FIELD_MAPPING_UNRESOLVED,
  });

  // ---- 5-7. the created records' save orders ------------------------------
  for (const target of CONVERT_TARGETS) {
    const nested =
      options.nestedSaveDepth === 0
        ? suppressedNestedSave(target.object, 'insert')
        : await composeNestedSave(ctx, target.object, 'insert', 1, options.soeDisclosureSink);
    const failed = nested.composeError !== undefined;
    steps.push({
      phase: target.phase,
      title: `${target.object} record created — full insert order of execution on ${target.object}`,
      resolution: failed ? 'unresolved' : 'resolved',
      components: [],
      note: `${target.optional ? 'An Opportunity is created only when the convert request asks for one; opting out is a runtime property of the request this vault cannot read, so this chain is what fires WHEN one is created. ' : ''}A convert that MATCHES an existing ${target.object} instead of creating one runs that object's UPDATE order, not the insert order composed here — which branch a given convert takes depends on record data. ${nested.suppressedByDepthCap === true ? 'Expansion suppressed by `nestedSaveDepth: 0`; re-run with the default depth to see the chain.' : `${nested.summary.activeComponents} active automation component(s) fire on this insert.`}`,
      ...(failed
        ? {
            unresolvedReason: `The save-order engine could not compose an insert chain for \`${target.object}\`: ${nested.composeError}. Neither the object's definition nor any automation targeting it is in this vault, so this step is a hole — NOT a finding that nothing fires on ${target.object} insert.`,
          }
        : {}),
      nestedSave: nested,
    });
  }

  // ---- 8. lead-update -----------------------------------------------------
  const leadNested =
    options.nestedSaveDepth === 0
      ? suppressedNestedSave(LEAD, 'update')
      : await composeNestedSave(ctx, LEAD, 'update', 1, options.soeDisclosureSink);
  const leadFailed = leadNested.composeError !== undefined;
  steps.push({
    phase: 'lead-update',
    title: 'Lead updated to converted — full update order of execution on Lead',
    resolution: leadFailed ? 'unresolved' : 'resolved',
    components: [],
    note: `The platform writes \`IsConverted\`, \`ConvertedAccountId\`, \`ConvertedContactId\`, \`ConvertedOpportunityId\`, \`ConvertedDate\` and the converted \`Status\` onto the Lead. That is a Lead UPDATE, so the Lead's own update save order composes here. ${leadNested.suppressedByDepthCap === true ? 'Expansion suppressed by `nestedSaveDepth: 0`.' : `${leadNested.summary.activeComponents} active automation component(s) fire on a Lead update.`} Which of them the Lead Settings convert toggle suppresses is the same unresolved gate as the \`lead-validation\` step above.`,
    ...(leadFailed
      ? {
          unresolvedReason: `The save-order engine could not compose an update chain for \`Lead\`: ${leadNested.composeError}. This is a hole, NOT a finding that nothing fires on a Lead update.`,
        }
      : {}),
    nestedSave: leadNested,
  });

  // ---- 9. ownership-assignment -------------------------------------------
  const leadAssignment = await fetchOwnedChildren(
    ctx,
    LEAD_OBJECT_ID,
    ASSIGNMENT_TYPES,
  );
  if (!leadAssignment.ok) return err(leadAssignment.error);
  steps.push({
    phase: 'ownership-assignment',
    title: 'Ownership of the created records',
    resolution: 'unresolved',
    components: leadAssignment.value.map((n) =>
      toChainRef(
        n,
        'lead-assignment-rule-context',
        'governs the LEAD owner before convert; it does not re-run at convert',
      ),
    ),
    note: 'Salesforce provides assignment rules for Lead and Case only — Account, Contact and Opportunity have no assignment-rule surface, so no assignment rule can fire on the records this convert creates. The Lead assignment rules listed here are PRE-CONVERT context (how the Lead got its owner), not steps of this chain.',
    unresolvedReason:
      'The `OwnerId` applied to the created Account / Contact / Opportunity is chosen on the convert REQUEST at runtime (the Convert Lead page, or `Database.LeadConvert.setOwnerId`). It is a per-request input, not org metadata, so this vault cannot resolve it. This step is a hole, NOT a finding that ownership is unchanged.',
  });

  // ---- 10. activity-carryover --------------------------------------------
  const taskAutomation = await fetchRegisteredFirers(
    ctx,
    'CustomObject:Task',
    ACTIVITY_AUTOMATION_TYPES,
  );
  if (!taskAutomation.ok) return err(taskAutomation.error);
  const eventAutomation = await fetchRegisteredFirers(
    ctx,
    'CustomObject:Event',
    ACTIVITY_AUTOMATION_TYPES,
  );
  if (!eventAutomation.ok) return err(eventAutomation.error);
  const activityRefs = [...taskAutomation.value, ...eventAutomation.value]
    .filter(isActiveSoeFirer)
    .map((n) => toChainRef(n, 'activity-automation-not-expanded'));
  steps.push({
    phase: 'activity-carryover',
    title: 'Open activities, notes, attachments and campaign members re-parented',
    resolution: 'not-modeled',
    components: activityRefs,
    note: 'The platform re-parents the Lead\'s open activities, notes, attachments and campaign memberships onto the created records. This operates on RECORDS; an offline metadata vault holds no records, so neither the volume nor the outcome is derivable here.',
    notModeledReason: `Whether the re-parenting writes fire Task / Event automation is NOT modeled by this tool — that is a depth-2 consequence of the convert (see the nested-save depth cap) and the platform does not document it as an ordinary DML save for these objects. The ${activityRefs.length} active Task/Event automation component(s) listed above are shown so the surface is VISIBLE; their presence in this list is not a claim that a convert fires them.`,
  });

  return ok(steps.map((step, stepIndex) => ({ ...step, stepIndex })));
};
