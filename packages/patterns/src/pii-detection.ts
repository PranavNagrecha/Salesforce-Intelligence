/**
 * PII detection pattern recognizer.
 *
 * The v2.0d sub-milestone shipping the compliance/privacy answer to
 * buyer priority #5 on the top-10 questions list: "which fields
 * contain PII and who can see/export them?".
 *
 * This recognizer is a pure function — given a single `CustomField`
 * `Node`, it inspects the field's API name, declared data type, and
 * description text, then returns a `(piiClassification, piiCategory)`
 * pair. No graph access is required; the recognizer is safe to call in
 * a tight per-field loop from the `sfi.pii_inventory` composer.
 *
 * Classification axis (`piiClassification`):
 *   - `pii`: Personally Identifiable Information. Contact information,
 *     identifiers (SSN, DOB), addresses. Generally regulated under
 *     GDPR, CCPA, and similar privacy regimes.
 *   - `sensitive`: Confidential business or regulated data (salary,
 *     credit card, health records, internal-only flags). Subject to
 *     stricter access controls (HIPAA, PCI-DSS, SOX).
 *   - `public`: No detected sensitive signal. The default for a field
 *     whose name and description do not match any rule.
 *   - `unknown`: Reserved for future use; the v2.0d recognizer always
 *     resolves to one of the three classes above.
 *
 * Category axis (`piiCategory`):
 *   - `identifier`: Direct personal identifier (SSN, DOB, drivers
 *     license, MRN, patient id).
 *   - `contact`: Contact data (email, phone, address, city, postal
 *     code).
 *   - `financial`: Monetary or financial-instrument data (salary,
 *     credit card, bank account, PCI).
 *   - `health`: Health data (medical record, diagnosis, HIPAA).
 *   - `unknown`: Sensitive signal detected but the category could not
 *     be narrowed (e.g., a description that only says "PII" without
 *     hinting at what kind).
 *
 * Detection layers, in precedence order:
 *
 *   1. **Field data type override.** `EncryptedText` ALWAYS classifies
 *      as `pii` regardless of the API name. The Salesforce
 *      classic-encryption type is itself the declaration that the
 *      value is personally sensitive. Category is derived from the API
 *      name if possible, else `unknown`.
 *
 *   2. **API-name patterns.** Substring matches against the field's
 *      stripped API name (case-insensitive). The pattern table covers
 *      identifier (SSN, DOB, drivers license), contact (email, phone,
 *      address), financial (salary, credit card, bank), and health
 *      (medical record, diagnosis, MRN) tokens. The first matching
 *      pattern wins; the table is ordered most-specific first so that
 *      `CreditCard*` matches before a generic `*_CC_*`.
 *
 *   3. **Data-type implications.** A field whose Salesforce type is
 *      `Email` carries `pii` + `contact` even without a matching name
 *      token. A field of type `Phone` does NOT classify by type alone
 *      (the type is used for non-PII business phones too); it requires
 *      a phone-ish name token.
 *
 *   4. **Description scanning.** The description text is scanned for
 *      compliance keywords (PII, Confidential, HIPAA, PCI, Sensitive,
 *      Internal Only). Keyword matches assign the strongest
 *      classification the keyword implies. Category falls out of the
 *      keyword (HIPAA -> health, PCI -> financial) where the keyword
 *      narrows it; otherwise the description leaves category as
 *      whatever the name-match resolved to (or `unknown` if none).
 *
 *   5. **Default.** No rule matched -> `{ piiClassification: 'public',
 *      piiCategory: 'unknown' }`.
 *
 * Determinism: the recognizer is referentially transparent — the same
 * `Node` always produces the same output. The `reason` field a caller
 * sees from `sfi.pii_inventory` is built from the rule that fired, not
 * from any random hash.
 *
 * Honesty axis: this is a heuristic. A field named `Notes__c` whose
 * description says "Patient diagnosis" classifies as `sensitive` /
 * `health` from the description; a field named `Notes__c` with no
 * description classifies as `public`. The recognizer cannot read
 * record-level data, so it cannot know if a `Description__c` field is
 * actually being used to store PII. The downstream
 * `compliance-pii-audit` skill is the place for that narrative.
 */

import type { Node } from '@sf-intelligence/contracts';

/** The Salesforce data type that ALWAYS implies `sensitive`. */
const ENCRYPTED_TEXT_DATA_TYPE = 'EncryptedText';

/** The Salesforce data type that implies `pii` + `contact` without a name match. */
const EMAIL_DATA_TYPE = 'Email';

/**
 * Field data types that can never HOLD a free-text contact value (an email
 * address, phone number, or mailing address): a boolean (`Checkbox`), a fixed
 * option set (`Picklist` / `MultiselectPicklist`), or a temporal / money value
 * (`Date` / `DateTime` / `Time` / `Currency` / `Percent`). A contact-token name
 * match on such a field is a configuration flag or metadata
 * (`Send_Email_to_Contact__c`, `Email_List__c`, `Last_Email_Date__c`,
 * `Phone_Bill_Amount__c`), not stored PII — see the suppression in
 * `detectPiiClassificationWithReason`. `Number` is DELIBERATELY excluded: a
 * phone number can plausibly be stored as a Number, so suppressing it would risk
 * a PII false-negative.
 */
const CONTACT_INCAPABLE_DATA_TYPES = new Set<string>([
  'Checkbox',
  'Picklist',
  'MultiselectPicklist',
  'Date',
  'DateTime',
  'Time',
  'Currency',
  'Percent',
]);

/** Strip the trailing `__c` so name matching works on `SSN`, not `SSN__c`. */
const CUSTOM_FIELD_SUFFIX = '__c';

/**
 * The classification axis the recognizer emits. See the module JSDoc
 * for the semantics of each value.
 */
export type PiiClassification = 'pii' | 'sensitive' | 'public' | 'unknown';

/**
 * The category axis the recognizer emits alongside the classification.
 * See the module JSDoc for the semantics of each value.
 */
export type PiiCategory =
  | 'identifier'
  | 'contact'
  | 'financial'
  | 'health'
  | 'unknown';

/**
 * The output shape of `detectPiiClassification`. Tools can match on
 * the classification, the category, or both; the `reason` lives on
 * the inventory composer rather than here so the recognizer stays a
 * pure data function.
 */
export interface PiiDetectionResult {
  readonly piiClassification: PiiClassification;
  readonly piiCategory: PiiCategory;
}

/**
 * Internal carrier used during rule evaluation. Same shape as the
 * exported `PiiDetectionResult` but with a `reason` string so the
 * caller can surface the matching rule. Exposed via
 * `detectPiiClassificationWithReason` for the `sfi.pii_inventory`
 * composer; `detectPiiClassification` drops the reason field.
 */
export interface PiiDetectionWithReason extends PiiDetectionResult {
  /** Plain-English explanation of which rule fired. */
  readonly reason: string;
}

interface NamePattern {
  readonly classification: PiiClassification;
  readonly category: PiiCategory;
  /** Sub-strings (case-insensitive) that mark this field as matching. */
  readonly tokens: readonly string[];
  /** Human-readable explanation for the match. */
  readonly reasonTemplate: string;
}

/**
 * Table of name-token rules. Order matters: the FIRST rule whose
 * `tokens` contains a sub-string of the stripped API name wins.
 *
 * Most-specific rules come first (e.g. `CreditCard` and `BankAccount`
 * before a generic `_CC_` so a field literally named `CreditCard__c`
 * is not classified twice). Tokens are case-insensitive; matching
 * happens against `apiName.toLowerCase()` and a copy of the token
 * lowercased once at module load.
 *
 * The pattern set is anchored to the v2.0d spec's enumeration:
 *
 *   - `*_SSN_*` / `*_SocialSecurity_*` / `SSN__c` -> pii/identifier
 *   - `*_Email__c` / `*_email_*` / `PersonalEmail__c` -> pii/contact
 *   - `*_Phone__c` / `Mobile__c` / `Fax__c` -> pii/contact
 *   - `*_DOB_*` / `BirthDate*` / `DateOfBirth*` -> pii/identifier
 *   - `*_Address_*` / `Street__c` / `City__c` / `PostalCode__c` ->
 *     pii/contact
 *   - `Salary__c` / `Compensation__c` / `Income__c` -> sensitive/financial
 *   - `CreditCard*` / `*_CC_Number_*` / `BankAccount*` ->
 *     sensitive/financial
 *   - `MedicalRecord*` / `Diagnosis__c` / `HealthCondition*` ->
 *     sensitive/health
 *   - `PatientID__c` / `MRN__c` -> sensitive/health
 */
const NAME_PATTERNS: readonly NamePattern[] = [
  // Health (most specific — `MRN__c` is short and could match elsewhere).
  {
    classification: 'sensitive',
    category: 'health',
    tokens: ['patientid', 'mrn', 'medicalrecord', 'diagnosis', 'healthcondition'],
    reasonTemplate:
      'name suggests health data (matches health-record token); classified sensitive/health',
  },
  // Financial — credit card and bank account come before SSN (which is also
  // a financial identifier in some contexts but the rule below routes it to
  // identifier).
  {
    classification: 'sensitive',
    category: 'financial',
    tokens: ['creditcard', 'cc_number', 'bankaccount', 'salary', 'compensation', 'income'],
    reasonTemplate:
      'name suggests financial data (matches financial token); classified sensitive/financial',
  },
  // Identifier — SSN, DOB, drivers license.
  {
    classification: 'pii',
    category: 'identifier',
    tokens: ['ssn', 'socialsecurity', 'dateofbirth', 'birthdate', 'dob', 'driverslicense'],
    reasonTemplate:
      'name suggests personal identifier (SSN/DOB/license); classified pii/identifier',
  },
  // Contact — email, phone, address, and personal-name fields.
  {
    classification: 'pii',
    category: 'contact',
    tokens: [
      'personalemail',
      'email',
      'mobile',
      'phone',
      'fax',
      'address',
      'street',
      'city',
      'postalcode',
      'zipcode',
      'first_name',
      'last_name',
      'firstname',
      'lastname',
      'given_name',
      'surname',
      'family_name',
    ],
    reasonTemplate:
      'name suggests contact or personal-name data; classified pii/contact',
  },
];

/** Parent-object api-name markers for venue / facility / org-location objects. */
const ORGANIZATIONAL_OBJECT_MARKERS = [
  'location',
  'engagement',
  'venue',
  'facility',
  'campus',
  'building',
  'site',
  'office',
] as const;

/**
 * Lowercased table built once at module load. Speeds up the per-field
 * loop in `sfi.pii_inventory` (every match is a `String.includes`
 * against a pre-lowercased token).
 */
const NAME_PATTERNS_LOWERCASED: ReadonlyArray<{
  readonly classification: PiiClassification;
  readonly category: PiiCategory;
  readonly tokensLower: readonly string[];
  readonly reasonTemplate: string;
}> = NAME_PATTERNS.map((p) => ({
  classification: p.classification,
  category: p.category,
  tokensLower: p.tokens.map((t) => t.toLowerCase()),
  reasonTemplate: p.reasonTemplate,
}));

/**
 * Description-keyword rules. Each keyword (case-insensitive substring
 * match) implies a `(classification, category)` overlay applied AFTER
 * the name rule. Ordered most-specific first so that PCI/HIPAA win
 * over the generic `Sensitive` keyword.
 */
interface DescriptionRule {
  readonly classification: PiiClassification;
  readonly category: PiiCategory | null;
  readonly keywords: readonly string[];
  readonly reason: string;
}

/** Description-rule table; per-keyword case-insensitive matches. */
const DESCRIPTION_RULES: readonly DescriptionRule[] = [
  {
    classification: 'sensitive',
    category: 'health',
    keywords: ['hipaa', 'health information', 'phi'],
    reason: 'description names a HIPAA/health-information rule; classified sensitive/health',
  },
  {
    classification: 'sensitive',
    category: 'financial',
    keywords: ['pci', 'cardholder data', 'cardholder'],
    reason: 'description names a PCI/cardholder-data rule; classified sensitive/financial',
  },
  {
    classification: 'sensitive',
    category: null,
    keywords: ['sensitive', 'internal only', 'privileged'],
    reason: 'description contains a sensitive/internal-only keyword; classified sensitive',
  },
  {
    classification: 'pii',
    category: null,
    keywords: ['pii', 'personally identifiable', 'confidential', 'restricted'],
    reason: 'description contains a PII/confidential keyword; classified pii',
  },
];

/**
 * Strip the trailing `__c` from a custom field API name. Standard
 * fields and managed-package fields do not carry the suffix; the
 * helper leaves them unchanged.
 */
const stripCustomFieldSuffix = (apiName: string): string =>
  apiName.endsWith(CUSTOM_FIELD_SUFFIX)
    ? apiName.slice(0, -CUSTOM_FIELD_SUFFIX.length)
    : apiName;

/** Normalize extractor / describe spellings to canonical Salesforce types. */
const normalizeDataType = (raw: string): string => {
  const compact = raw.trim().toLowerCase().replace(/\s+/g, '');
  if (compact === 'encryptedtext' || compact === 'encryptedstring') {
    return ENCRYPTED_TEXT_DATA_TYPE;
  }
  return raw.trim();
};

/**
 * Read the field's data type from `properties.dataType` if present.
 * Falls back to `null` so callers can check for "no data type
 * extracted" without a separate `in` check.
 */
const getDataType = (node: Node): string | null => {
  const dt = node.properties['dataType'];
  return typeof dt === 'string' ? normalizeDataType(dt) : null;
};

const parentObjectApiNameLower = (node: Node): string | null => {
  if (typeof node.parentId === 'string' && node.parentId.startsWith('CustomObject:')) {
    return node.parentId.slice('CustomObject:'.length).toLowerCase();
  }
  if (node.id.startsWith('CustomField:')) {
    const rest = node.id.slice('CustomField:'.length);
    const dot = rest.indexOf('.');
    if (dot >= 0) return rest.slice(0, dot).toLowerCase();
  }
  return null;
};

const isOrganizationalParentObject = (node: Node): boolean => {
  const parent = parentObjectApiNameLower(node);
  if (parent === null) return false;
  return ORGANIZATIONAL_OBJECT_MARKERS.some((m) => parent.includes(m));
};

/** Venue / event URL fields — not personal mailing addresses. */
const isVenueOrUrlFieldName = (apiNameLower: string): boolean =>
  apiNameLower.includes('web_address') ||
  apiNameLower.includes('website') ||
  apiNameLower.includes('event_url') ||
  apiNameLower.includes('_url_') ||
  apiNameLower.endsWith('_url');

/**
 * Read the field's description from `properties.description` if
 * present, lowercased so keyword matching is case-insensitive.
 */
const getDescriptionLower = (node: Node): string | null => {
  const desc = node.properties['description'];
  if (typeof desc !== 'string' || desc.length === 0) return null;
  return desc.toLowerCase();
};

/**
 * Find the first name-pattern rule whose tokens contain a sub-string
 * of the stripped, lowercased API name. Returns null when no rule
 * fires.
 */
const matchNamePattern = (
  apiNameLower: string,
): {
  readonly classification: PiiClassification;
  readonly category: PiiCategory;
  readonly reason: string;
} | null => {
  for (const rule of NAME_PATTERNS_LOWERCASED) {
    for (const token of rule.tokensLower) {
      if (apiNameLower.includes(token)) {
        return {
          classification: rule.classification,
          category: rule.category,
          reason: rule.reasonTemplate,
        };
      }
    }
  }
  return null;
};

/**
 * Find the first description-rule whose keywords appear in the
 * lowercased description. Returns null when no rule fires.
 */
const matchDescriptionRule = (
  descriptionLower: string,
): DescriptionRule | null => {
  for (const rule of DESCRIPTION_RULES) {
    for (const keyword of rule.keywords) {
      if (descriptionLower.includes(keyword)) {
        return rule;
      }
    }
  }
  return null;
};

/**
 * Promote `current` to `next` along the classification severity axis.
 * `sensitive > pii > public > unknown`. Used to layer the description
 * rule on top of the name rule when the description is stricter than
 * the name.
 */
const stricterClassification = (
  current: PiiClassification,
  next: PiiClassification,
): PiiClassification => {
  if (current === 'sensitive' || next === 'sensitive') return 'sensitive';
  if (current === 'pii' || next === 'pii') return 'pii';
  if (current === 'unknown' && next === 'public') return 'public';
  return current;
};

/**
 * Classify a CustomField node along the (classification, category)
 * pair. Returns the result + a plain-English reason string. Callers
 * that don't need the reason should prefer `detectPiiClassification`.
 *
 * @example
 *   const r = detectPiiClassificationWithReason(node);
 *   console.log(r.piiClassification, r.piiCategory, r.reason);
 */
export const detectPiiClassificationWithReason = (
  node: Node,
): PiiDetectionWithReason => {
  const apiNameLower = stripCustomFieldSuffix(node.apiName).toLowerCase();
  const dataType = getDataType(node);

  // Layer 1: EncryptedText override. Always `pii` — encryption IS the signal.
  if (dataType === ENCRYPTED_TEXT_DATA_TYPE) {
    const nameMatch = matchNamePattern(apiNameLower);
    const category = nameMatch === null ? 'unknown' : nameMatch.category;
    return {
      piiClassification: 'pii',
      piiCategory: category,
      reason:
        'field data type is EncryptedText; classified pii (the encryption type IS the declaration)',
    };
  }

  // Layer 2: name patterns.
  let nameMatch = matchNamePattern(apiNameLower);

  // Layer 2a: venue / org-location contact-token false positives — a field on
  // OA_Location__c or OA_Engagements__c named Location_Address__c or
  // Web_address_for_the_event__c is organizational metadata, not person PII.
  const suppressedOrganizationalContact =
    nameMatch?.category === 'contact' &&
    (isOrganizationalParentObject(node) || isVenueOrUrlFieldName(apiNameLower));
  if (suppressedOrganizationalContact) {
    nameMatch = null;
  }

  // Layer 2b: a Checkbox / Picklist / MultiselectPicklist field stores a
  // constrained value (a boolean or a value from a fixed option set), so it can
  // never STORE a free-text contact value (email address, phone number, mailing
  // address). A contact-token name match on such a field is therefore a
  // configuration or preference flag (`Send_Email_to_Contact__c`,
  // `Email_List__c`), not stored PII — suppress it so the inventory does not
  // over-report. Scoped to the `contact` category ONLY: a constrained field CAN
  // still encode a sensitive FACT (e.g. an `Ethnicity__c` picklist, a
  // `Has_Diagnosis__c` checkbox), so identifier / health / financial matches
  // are left intact.
  const suppressedContactFlag =
    dataType !== null &&
    CONTACT_INCAPABLE_DATA_TYPES.has(dataType) &&
    nameMatch?.category === 'contact';
  if (suppressedContactFlag) {
    nameMatch = null;
  }

  // Layer 3: Email data type implies pii/contact even without a name match.
  // We treat this as a name-equivalent overlay so the downstream description
  // layer can still strengthen it.
  let baseClassification: PiiClassification = 'public';
  let baseCategory: PiiCategory = 'unknown';
  let baseReason = suppressedOrganizationalContact
    ? 'API name matches a contact token, but the parent object or field name indicates an organizational venue/location (not person PII); classified public'
    : suppressedContactFlag
      ? `API name matches a contact token, but the field type (${dataType}) cannot hold a free-text contact value (email / phone / address); classified public — likely metadata or a configuration flag, not stored PII`
      : 'no PII signal detected in API name or data type';
  if (nameMatch !== null) {
    baseClassification = nameMatch.classification;
    baseCategory = nameMatch.category;
    baseReason = nameMatch.reason;
  } else if (dataType === EMAIL_DATA_TYPE) {
    baseClassification = 'pii';
    baseCategory = 'contact';
    baseReason =
      'field data type is Email; classified pii/contact (the data type IS the contract that the value is an email address)';
  }

  // Layer 4: description keyword overlay.
  const descLower = getDescriptionLower(node);
  if (descLower !== null) {
    const descRule = matchDescriptionRule(descLower);
    if (descRule !== null) {
      // The description rule wins when it is at least as strict as the
      // current classification. If the description narrows the category
      // (HIPAA -> health, PCI -> financial), apply that too.
      const promoted = stricterClassification(
        baseClassification,
        descRule.classification,
      );
      if (promoted !== baseClassification) {
        baseClassification = promoted;
        baseReason = descRule.reason;
      } else if (baseClassification === 'public') {
        // Even when the description doesn't strengthen severity (no
        // name match), it still classifies the field.
        baseClassification = descRule.classification;
        baseReason = descRule.reason;
      }
      if (descRule.category !== null) {
        baseCategory = descRule.category;
      } else if (baseCategory === 'unknown' && baseClassification !== 'public') {
        // Description-only PII (no name match) still leaves the category
        // unknown; the spec says "category unknown if not otherwise
        // classified" so the recognizer reports that honestly.
        baseCategory = 'unknown';
      }
    }
  }

  return {
    piiClassification: baseClassification,
    piiCategory: baseCategory,
    reason: baseReason,
  };
};

/**
 * Classify a CustomField node along the (classification, category)
 * pair. The thin wrapper drops the `reason` field;
 * `sfi.pii_inventory` calls the with-reason variant so it can surface
 * the matching rule to the caller.
 *
 * @example
 *   const r = detectPiiClassification(node);
 *   if (r.piiClassification === 'sensitive') {
 *     console.log('Sensitive field:', node.apiName, r.piiCategory);
 *   }
 */
export const detectPiiClassification = (node: Node): PiiDetectionResult => {
  const r = detectPiiClassificationWithReason(node);
  return {
    piiClassification: r.piiClassification,
    piiCategory: r.piiCategory,
  };
};
