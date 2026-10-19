/**
 * The verbatim honesty-axis disclosure for both save-order tools.
 * One module so the 2,451-character string cannot drift byte-by-byte.
 */

import {
  soeReceiverVerificationNote,
  type ApexReceiverVerification,
} from './apex-receiver.js';
import {
  composeSoeDisclosure,
  type SoeAdmissionResult,
} from './soe-admission.js';
import { SOE_FRAMEWORK_HANDLERS_NOTE } from './soe-framework-handlers.js';
import { SOE_HANDLER_EFFECTS_NOTE } from './soe-trigger-effects.js';

export const SOE_PRIMARY_DISCLOSURE =
  "v2.0e composes the documented Salesforce order-of-execution instantiated against THIS org's extracted automation. Before-save record-triggered flows are modeled as the leading `before-save-flows` phase (they run BEFORE before-triggers). Duplicate rules are modeled as their own `duplicate-rules` phase, running after before-triggers and validation but BEFORE the save — evaluated on insert/update only, with the effective Block/Allow/Alert/Report operations surfaced per rule. Conditions ARE listed but NOT EVALUATED — the tool does not know whether this particular record satisfies them at runtime. Workflow field updates can re-fire before/after-update triggers (a second pass); this composition lists each automation once; `reentry` names the steps that write back to this object, what the documented second pass re-runs, and any visible recursion guard. A workflow rule's time-dependent actions (its workflowTimeTriggers) are SCHEDULED for an offset measured from a record field value the offline vault cannot evaluate; this composition lists the rule once in the synchronous post-save-workflows phase and does NOT claim its time-delayed actions fire at save. Parent Summary (roll-up) fields that aggregate this object recalculate in the `post-save-rollup-recalc` phase, capped to ONE level — a grandparent's own rollup on that recalculated parent is NOT walked — and the parent's own triggers/flows/workflows that its recalculated save would fire are NOT expanded (no re-entrancy). Entitlement-process and milestone-type METADATA is modeled elsewhere in the vault (R6-18: `EntitlementProcess`/`MilestoneType` nodes, queryable via `sfi.get_component` / `sfi.get_edges`, including each milestone's declared target `minutesToComplete` as of R7-C7) — but this composition does NOT simulate entitlement milestones as an order-of-execution phase: whether a specific record is currently on-track or breached against those target minutes is live, per-record timer data this offline vault cannot hold. Criteria-based sharing recalculation — the FINAL step in Salesforce's documented order-of-execution, evaluated after every phase modeled here (including post-save-async) — is also NOT modeled: a save that causes a record to newly match or stop matching a criteria-based sharing rule's criteria triggers a sharing recalculation this composition does not surface. Manual sharing, sharing sets, account teams, and Apex callouts after save are out of scope.";

/** Primary `disclosure` string shared by `what_happens_on_save` and `order_of_execution`. */
export const buildSoePrimaryDisclosure = (
  objectModeled: boolean,
  receiverVerification: ApexReceiverVerification,
  handlerEnriched: boolean,
  /** True when the composition lists at least one framework-registered handler step. */
  frameworkHandlers: boolean,
): string =>
  `${composeSoeDisclosure(SOE_PRIMARY_DISCLOSURE, objectModeled)}${soeReceiverVerificationNote(receiverVerification)}${handlerEnriched ? ` ${SOE_HANDLER_EFFECTS_NOTE}` : ''}${frameworkHandlers ? ` ${SOE_FRAMEWORK_HANDLERS_NOTE}` : ''}`;

export type { SoeAdmissionResult };
