/**
 * Salesforce API-name classifiers.
 *
 * Small, shared, and deliberately boring: an api-name suffix is the ONLY
 * offline signal that separates an org's own metadata from the platform's, and
 * getting it wrong turns a report about the org into a report about Salesforce.
 */

/**
 * Is this field API name a CUSTOM field — one this org (or a managed package)
 * defined — as opposed to a standard field Salesforce ships?
 *
 * Custom fields end in `__c`; person-account mirror fields on Contact end in
 * `__pc`. Everything else (`Name`, `AccountId`, `BillingCity`, …) is a standard
 * field whose name was chosen by Salesforce, not by this org.
 *
 * Namespaced managed-package fields (`ns__Thing__c`) end in `__c` and are
 * therefore IN. Their naming convention is the package vendor's rather than
 * this org's, but excluding them is a separate product decision from this
 * classifier and is not made here.
 *
 * KNOWN DUPLICATES — declared, not silently added to. Four MCP tools already
 * roll their own version of this predicate and they DISAGREE:
 *
 *   - `packages/mcp/src/tools/access-parity.ts` (~131)        — `__c` only
 *   - `packages/mcp/src/tools/unused-fields-deep.ts` (~907)   — `__c` / `__s`
 *   - `packages/mcp/src/tools/safe-to-delete-field.ts` (~1037)— `__c` only
 *   - `packages/mcp/src/tools/object-360.ts` (~560)           — `__c` / `__mdt` / `__e` / `__b` / `__x`
 *
 * Converging those four is a FOLLOW-UP, not this change: each is a behaviour
 * change inside a destructive-adjacent tool with no reported defect behind it.
 * This JSDoc exists so the debt is visible to the next reader instead of this
 * becoming a fifth hidden copy.
 */
export const isCustomFieldApiName = (apiName: string): boolean =>
  apiName.endsWith('__c') || apiName.endsWith('__pc');
