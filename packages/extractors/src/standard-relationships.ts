/**
 * STANDARD-LOOKUP-REFERENCETO-NULL: the Metadata API ships a standard lookup
 * (`Contact.AccountId`, `Opportunity.AccountId`, `Case.ContactId`, …) as just
 * `<fullName>` + `<type>Lookup</type>` — no `<referenceTo>`. The field
 * extractor reads only the declared element, so every standard relationship had
 * `referenceTo: null`, minted no `lookupTo` edge, and the data model omitted
 * the backbone of the standard schema (nothing pointed at Account).
 *
 * This is a CURATED, platform-fixed table: the target of a standard lookup is
 * defined by Salesforce, not by the org, so it is the same in every org. It is
 * consulted ONLY when the XML names no target, ONLY for a standard field on a
 * standard object, and it never guesses from a name pattern — a standard
 * lookup not listed here keeps `referenceTo: null` exactly as before.
 *
 * Entries are `Object.Field -> targets` (a polymorphic lookup has several);
 * `*` as the object means "this field name has the same target on every
 * standard object that has it".
 */

const SELF = '<self>';

/** Field name -> targets, true on every standard object that carries it. */
const ANY_OBJECT: Readonly<Record<string, readonly string[]>> = {
  AccountId: ['Account'],
  ContactId: ['Contact'],
  OpportunityId: ['Opportunity'],
  CampaignId: ['Campaign'],
  ContractId: ['Contract'],
  OrderId: ['Order'],
  AssetId: ['Asset'],
  Pricebook2Id: ['Pricebook2'],
  Product2Id: ['Product2'],
  EntitlementId: ['Entitlement'],
  ServiceContractId: ['ServiceContract'],
  MasterRecordId: [SELF],
};

/** Object-specific standard lookups (where the target depends on the object). */
const BY_OBJECT: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  Account: { ParentId: [SELF], OwnerId: ['User'] },
  Contact: { ReportsToId: ['Contact'], OwnerId: ['User'] },
  Opportunity: { OwnerId: ['User'] },
  Contract: { OwnerId: ['User'] },
  Campaign: { ParentId: [SELF], OwnerId: ['User'] },
  Case: { ParentId: [SELF], OwnerId: ['User', 'Group'] },
  Lead: {
    OwnerId: ['User', 'Group'],
    ConvertedAccountId: ['Account'],
    ConvertedContactId: ['Contact'],
    ConvertedOpportunityId: ['Opportunity'],
  },
  Asset: { ParentId: [SELF], RootAssetId: [SELF], OwnerId: ['User'] },
  User: { ManagerId: ['User'], DelegatedApproverId: ['User', 'Group'], ProfileId: ['Profile'], UserRoleId: ['UserRole'] },
  Task: { WhoId: ['Contact', 'Lead'], OwnerId: ['User', 'Group'] },
  Event: { WhoId: ['Contact', 'Lead'], OwnerId: ['User', 'Group'] },
};

/** Marker stamped on edges / nodes whose target came from this table. */
export const STANDARD_RELATIONSHIP_SOURCE = 'standard-relationship-table';

/**
 * The platform-fixed target object(s) of a standard lookup, or `[]` when the
 * field is custom, the object is custom, or the field is not in the table.
 */
export const standardLookupTargets = (
  objectApiName: string,
  fieldApiName: string,
): readonly string[] => {
  if (objectApiName.includes('__') || fieldApiName.includes('__')) return [];
  const targets = BY_OBJECT[objectApiName]?.[fieldApiName] ?? ANY_OBJECT[fieldApiName];
  if (targets === undefined) return [];
  return targets.map((t) => (t === SELF ? objectApiName : t));
};
