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
 * Classification axis (`piiClassification`), from strongest to weakest:
 *   - `protected`: Protected-class / special-category attribute (race,
 *     ethnicity, disability, citizenship / national origin, religion,
 *     veteran status, sexual orientation, gender identity). The HIGHEST
 *     sensitivity tier — these are legally protected characteristics
 *     regulated under FERPA, Title VI/VII/IX, the ADA, GDPR Art. 9
 *     "special categories", and similar regimes.
 *   - `sensitive`: Confidential business or regulated data (salary,
 *     credit card, health records, internal-only flags). Subject to
 *     stricter access controls (HIPAA, PCI-DSS, SOX).
 *   - `pii`: Personally Identifiable Information. Contact information,
 *     identifiers (SSN, DOB), addresses. Generally regulated under
 *     GDPR, CCPA, and similar privacy regimes.
 *   - `public`: No detected sensitive signal. The default for a field
 *     whose name and description do not match any rule.
 *   - `unknown`: Reserved for future use; the recognizer resolves to
 *     one of the classes above.
 *
 * Category axis (`piiCategory`):
 *   - `identifier`: Direct personal identifier (SSN, DOB, drivers
 *     license, MRN, patient id).
 *   - `contact`: Contact data (email, phone, address, city, postal
 *     code).
 *   - `financial`: Monetary or financial-instrument data (salary,
 *     credit card, bank account, PCI).
 *   - `health`: Health data (medical record, diagnosis, HIPAA, PHI).
 *   - `protected-class`: Legally protected characteristic (race,
 *     ethnicity, disability, citizenship / national origin, religion,
 *     veteran / military status, sexual orientation, gender identity).
 *   - `unknown`: Sensitive signal detected but the category could not
 *     be narrowed (e.g., a description that only says "PII" without
 *     hinting at what kind).
 *
 * Confidence axis (`confidence`):
 *   - `declared`: driven by a declared `<securityClassification>` on the
 *     field metadata (an admin's own data-classification assertion) —
 *     the HIGHEST-PRECEDENCE signal.
 *   - `heuristic`: driven by a name / label / data-type / description
 *     match. Absence of a signal is NEVER a clearance.
 *
 * Detection layers, in precedence order:
 *
 *   0. **Declared security classification (highest precedence).** A
 *      declared `<securityClassification>` of `Confidential` (→
 *      `sensitive`) or `Restricted` / `MissionCritical` (→ `protected`)
 *      is an admin's own data-classification assertion. It sets a FLOOR:
 *      the field classifies at least that tier at `declared` confidence,
 *      overriding a weaker name/label heuristic — so a `Confidential`
 *      field with an innocuous name is still surfaced. It never
 *      DOWNGRADES a stronger heuristic signal (a name that already
 *      resolves to `protected` keeps `protected`). Absent → fall back to
 *      the heuristics below (all `heuristic` confidence).
 *
 *   1. **Field data type override.** `EncryptedText` ALWAYS classifies
 *      as `pii` regardless of the API name. The Salesforce
 *      classic-encryption type is itself the declaration that the
 *      value is personally sensitive. Category is derived from the API
 *      name if possible, else `unknown`.
 *
 *   2. **API-name patterns.** Substring matches against the field's
 *      stripped API name (case-insensitive). The pattern table covers
 *      protected-class (race, ethnicity, disability, citizenship /
 *      national origin, religion, veteran status, sexual orientation,
 *      gender identity), identifier (SSN, DOB, drivers license), contact
 *      (email, phone, address), financial (salary, credit card, bank),
 *      and health (medical record, diagnosis, MRN, the PHI acronym)
 *      tokens. The first matching pattern wins; the table is ordered
 *      most-specific / highest-sensitivity first. The short, ambiguous
 *      `race` token matches only as a whole WORD segment (so `Grace`,
 *      `Trace`, `Racetrack` do not fire), and the `PHI` health acronym
 *      matches only the standalone UPPERCASE token (so `Phi Theta Kappa`,
 *      `philosophy`, `Philadelphia` do not fire).
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
 * Severity rank on the classification axis (higher = more sensitive).
 * `protected > sensitive > pii > public > unknown`. Used both to layer the
 * description overlay and to apply the declared-securityClassification FLOOR
 * (a declaration escalates but never downgrades a stronger heuristic signal).
 */
const CLASSIFICATION_RANK: Readonly<Record<PiiClassification, number>> = {
  protected: 4,
  sensitive: 3,
  pii: 2,
  public: 1,
  unknown: 0,
};

/**
 * Map a declared Salesforce `<securityClassification>` (the field-level Data
 * Classification "sensitivity level") to the classification tier it asserts.
 * Only the ESCALATING levels are mapped — `Confidential -> sensitive`,
 * `Restricted` / `MissionCritical -> protected`. `Public` / `Internal` (and any
 * unrecognized value) return `null` so the field falls back to the heuristics
 * rather than being force-declared (and never silently DOWNGRADED to public).
 */
const SECURITY_CLASSIFICATION_TIERS: Readonly<Record<string, PiiClassification>> = {
  confidential: 'sensitive',
  restricted: 'protected',
  missioncritical: 'protected',
};

/**
 * Read a declared `<securityClassification>` from `properties`, normalized to
 * the classification tier it asserts, or `null` when absent / non-escalating.
 * This is the HIGHEST-PRECEDENCE signal (`declared` confidence).
 */
const getDeclaredSecurityTier = (node: Node): PiiClassification | null => {
  const raw = node.properties['securityClassification'];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return SECURITY_CLASSIFICATION_TIERS[raw.trim().toLowerCase()] ?? null;
};

/** The raw declared `<securityClassification>` string, for the reason text. */
const getDeclaredSecurityRaw = (node: Node): string | null => {
  const raw = node.properties['securityClassification'];
  return typeof raw === 'string' && raw.length > 0 ? raw.trim() : null;
};

/**
 * Split an API name into lowercase word segments, breaking on non-alphanumeric
 * delimiters (`_`) AND camelCase / acronym boundaries. So `Student_Race` and
 * `StudentRace` both yield `['student','race']`, while `Grace_Period` yields
 * `['grace','period']` and `Racetrack` yields `['racetrack']`. Used for the
 * ambiguous short `race` token, which must match as a whole word — never as the
 * substring inside `Grace` / `Trace` / `Embrace` / `Racetrack`.
 */
const toWordSegments = (name: string): readonly string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMWord boundary
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());

/**
 * Name tokens that must match a WHOLE word segment rather than a substring.
 *
 * `apiNameLower.includes(token)` is right for a distinctive token like
 * `postalcode`, and wrong for a short one that is a common English substring.
 * Every entry below was a measured false positive, not a hypothetical:
 * `Seating_Capacity__c`, `Electricity_Usage__c`, `Velocity__c`,
 * `Publicity_Flag__c` and `Toxicity_Level__c` all classified as contact PII
 * because they contain `city`; `Headphone_Model__c` and `Microphone_Count__c`
 * because they contain `phone`; `Streetlight_Count__c` because it contains
 * `street`. A field-access audit that flags an asset's headphone model as
 * personal data trains the reader to ignore the whole report.
 *
 * This is the same remedy `hasRaceSegment` already applies below for the
 * equally ambiguous `race` (Grace, Trace) — generalized, so the next ambiguous
 * token is one line here rather than another bespoke branch.
 *
 * `telephone` is carried as its own token in the contact list above, because
 * whole-word `phone` would otherwise stop matching `Telephone__c` — a real
 * contact field whose single word segment is not `phone`.
 */
const WHOLE_WORD_ONLY_TOKENS: ReadonlySet<string> = new Set([
  'city',
  'phone',
  'street',
]);

/** True when `race` appears as a standalone word segment (not inside Grace/Trace). */
const hasRaceSegment = (rawApiName: string): boolean =>
  toWordSegments(rawApiName).includes('race');

/**
 * True when the standalone UPPERCASE `PHI` acronym (Protected Health
 * Information) appears in `text`, delimited by non-letters on both sides.
 * Case-SENSITIVE by design: it matches the health acronym `PHI` (`PHI__c`,
 * "stores PHI") but NOT the Greek letter / word prefix `Phi` ("Phi Theta
 * Kappa", "philosophy", "Philadelphia") nor a letter run like "GRAPHIC".
 */
const PHI_ACRONYM_RE = /(?<![A-Za-z])PHI(?![A-Za-z])/;
const hasPhiAcronym = (rawText: string): boolean => PHI_ACRONYM_RE.test(rawText);

/**
 * The classification axis the recognizer emits. See the module JSDoc
 * for the semantics of each value.
 */
export type PiiClassification =
  | 'protected'
  | 'sensitive'
  | 'pii'
  | 'public'
  | 'unknown';

/**
 * The category axis the recognizer emits alongside the classification.
 * See the module JSDoc for the semantics of each value.
 */
export type PiiCategory =
  | 'identifier'
  | 'contact'
  | 'financial'
  | 'health'
  | 'protected-class'
  | 'unknown';

/**
 * Confidence axis for a classification. `declared` means the verdict
 * came from a declared `<securityClassification>` on the field metadata
 * (highest precedence); `heuristic` means it came from a name / label /
 * data-type / description match. See the module JSDoc.
 */
export type PiiConfidence = 'declared' | 'heuristic';

/**
 * The output shape of `detectPiiClassification`. Tools can match on
 * the classification, the category, or both; the `reason` lives on
 * the inventory composer rather than here so the recognizer stays a
 * pure data function.
 */
export interface PiiDetectionResult {
  readonly piiClassification: PiiClassification;
  readonly piiCategory: PiiCategory;
  /**
   * Whether the verdict is `declared` (from a `<securityClassification>`)
   * or `heuristic` (from a name / type / description match).
   */
  readonly confidence: PiiConfidence;
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
 * The pattern set is anchored to the spec's enumeration:
 *
 *   - `*Race*` / `*Ethnicity*` / `*Disability*` / `*Citizenship*` /
 *     `*National_Origin*` / `*Religion*` / `*Veteran*` /
 *     `*Sexual_Orientation*` / `*Gender_Identity*` -> protected/protected-class
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
 *   - `PatientID__c` / `MRN__c` / `PHI__c` / `Protected_Health_Info__c`
 *     -> sensitive/health
 *
 * The `race` token and the `PHI` health acronym are NOT matched here by
 * plain substring — they are ambiguous (`Grace`, `Trace`, `Phi Theta
 * Kappa`, `philosophy`) — and are handled by dedicated whole-word /
 * whole-acronym matchers in {@link matchNamePattern}.
 */
const NAME_PATTERNS: readonly NamePattern[] = [
  // Protected class (highest sensitivity — legally protected characteristics).
  // GENERAL, org-independent vocabulary matched on the semantic token, not on
  // any specific package prefix or real field name. `race` is handled as a
  // whole-word segment in `matchNamePattern` (not a substring), so `Grace` /
  // `Trace` / `Racetrack` do not fire here.
  {
    classification: 'protected',
    category: 'protected-class',
    tokens: [
      'ethnicity',
      'ethnic',
      'disability',
      'disabilities',
      'disabled',
      'citizenship',
      'citizen',
      'national_origin',
      'nationalorigin',
      'national origin',
      'nationality',
      'veteran',
      'military',
      'religion',
      'religious',
      'sexual_orientation',
      'sexualorientation',
      'sexual orientation',
      'gender_identity',
      'genderidentity',
      'gender identity',
    ],
    reasonTemplate:
      'name suggests a protected-class attribute (race / ethnicity / disability / citizenship / national origin / religion / veteran status / sexual orientation / gender identity); classified protected/protected-class',
  },
  // Health (most specific — `MRN__c` is short and could match elsewhere).
  // `phi` is NOT listed as a plain substring token (it would match
  // `Phi Theta Kappa`, `philosophy`, `Philadelphia`); the standalone `PHI`
  // acronym is handled by a case-sensitive whole-word matcher instead.
  {
    classification: 'sensitive',
    category: 'health',
    tokens: [
      'patientid',
      'mrn',
      'medicalrecord',
      'diagnosis',
      'healthcondition',
      'protected_health',
      'protectedhealth',
    ],
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
      'telephone',
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

/**
 * Money-amount name tokens. A Currency or Number field whose api name contains
 * one of these holds a monetary VALUE (a payment, balance, fee owed, etc.),
 * which is a financial access-signal worth surfacing as `sensitive`/`financial`
 * even though the amount alone is not directly person-identifying. The rule is
 * gated to the Currency / Number data types so a Text status / label field that
 * merely mentions "payment" (`Payment_Status__c`) is NOT swept in, and it is
 * suppressed for generic product-catalog price fields (see
 * `GENERIC_CATALOG_PRICE_MARKERS`) to avoid false positives on list/unit prices.
 * This rule is HEURISTIC: absence of a financial flag is NOT a clearance.
 */
const MONEY_AMOUNT_TOKENS = [
  'amount',
  'payment',
  'fee',
  'charge',
  'balance',
  'cost',
  'price',
  'paid',
] as const;

/** Salesforce data types that can HOLD a monetary amount. */
const MONEY_CAPABLE_DATA_TYPES = new Set<string>(['Currency', 'Number']);

/**
 * Generic product / catalog price markers. A `price` / `cost` field on a
 * product-catalog-shaped object (or named like a list / unit / standard price)
 * is reference data, not a person/account financial signal — suppress the
 * money-amount rule for it to avoid swamping the inventory with catalog prices.
 */
const GENERIC_CATALOG_PRICE_MARKERS = [
  'list_price',
  'listprice',
  'unit_price',
  'unitprice',
  'standard_price',
  'standardprice',
  'sales_price',
  'salesprice',
  'msrp',
  'retail_price',
  'retailprice',
] as const;
const GENERIC_CATALOG_PARENT_MARKERS = [
  'product',
  'pricebook',
  'catalog',
  'item',
  'sku',
] as const;

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
    // Bare 'phi' was REMOVED: as a 3-letter substring it fired on
    // "Phi Theta Kappa", "philosophy", and "Philadelphia". The genuine
    // Protected-Health-Information signal is the multi-word phrase
    // "protected health" or the standalone UPPERCASE `PHI` acronym (matched
    // case-sensitively in `descriptionNamesPhiAcronym`), not the substring.
    keywords: ['hipaa', 'health information', 'protected health'],
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

/**
 * True when a Currency / Number field's name marks it as a monetary amount that
 * is a financial access-signal (a payment / balance / fee owed), and it is NOT a
 * generic product-catalog price. Heuristic; see `MONEY_AMOUNT_TOKENS`.
 */
const isMoneyAmountField = (
  node: Node,
  apiNameLower: string,
  dataType: string | null,
): boolean => {
  if (dataType === null || !MONEY_CAPABLE_DATA_TYPES.has(dataType)) return false;
  if (!MONEY_AMOUNT_TOKENS.some((t) => apiNameLower.includes(t))) return false;
  // False-positive guard: generic product-catalog list / unit / standard prices.
  if (GENERIC_CATALOG_PRICE_MARKERS.some((m) => apiNameLower.includes(m))) {
    return false;
  }
  const parent = parentObjectApiNameLower(node);
  if (
    parent !== null &&
    GENERIC_CATALOG_PARENT_MARKERS.some((m) => parent.includes(m))
  ) {
    return false;
  }
  return true;
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
 * Find the first name-pattern rule that matches, in table priority order
 * (protected-class > health > financial > identifier > contact). A rule matches
 * on a plain substring token; the protected-class rule ALSO matches the
 * whole-word `race` segment and the health rule ALSO matches the standalone
 * `PHI` acronym — both checked at that rule's own priority so higher-sensitivity
 * verdicts still win. `apiNameLower` is the stripped, lowercased name;
 * `apiNameRaw` is the stripped, case-PRESERVED name (needed for the
 * case-sensitive PHI acronym). Returns null when no rule fires.
 */
const matchNamePattern = (
  apiNameLower: string,
  apiNameRaw: string,
): {
  readonly classification: PiiClassification;
  readonly category: PiiCategory;
  readonly reason: string;
} | null => {
  for (const rule of NAME_PATTERNS_LOWERCASED) {
    for (const token of rule.tokensLower) {
      const matched = WHOLE_WORD_ONLY_TOKENS.has(token)
        ? toWordSegments(apiNameRaw).includes(token)
        : apiNameLower.includes(token);
      if (matched) {
        return {
          classification: rule.classification,
          category: rule.category,
          reason: rule.reasonTemplate,
        };
      }
    }
    // Protected-class: the ambiguous short `race` token, whole-word only.
    if (rule.category === 'protected-class' && hasRaceSegment(apiNameRaw)) {
      return {
        classification: rule.classification,
        category: rule.category,
        reason:
          'name contains the protected-class token "race" (whole-word); classified protected/protected-class',
      };
    }
    // Health: the standalone UPPERCASE `PHI` (Protected Health Information)
    // acronym — never the Greek letter / word prefix `Phi` (Phi Theta Kappa).
    if (rule.category === 'health' && hasPhiAcronym(apiNameRaw)) {
      return {
        classification: rule.classification,
        category: rule.category,
        reason:
          'name contains the standalone PHI (Protected Health Information) acronym; classified sensitive/health',
      };
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
 * Return the stricter of two classifications along the severity axis
 * (`protected > sensitive > pii > public > unknown`, per {@link
 * CLASSIFICATION_RANK}). Used to layer the description rule on top of the name
 * rule when the description is stricter — and, crucially, to NEVER downgrade a
 * stronger signal (a `protected` name match survives a `sensitive` description).
 */
const stricterClassification = (
  current: PiiClassification,
  next: PiiClassification,
): PiiClassification =>
  CLASSIFICATION_RANK[next] > CLASSIFICATION_RANK[current] ? next : current;

/** The heuristic (name / type / description) verdict, before the declared floor. */
interface HeuristicVerdict {
  readonly classification: PiiClassification;
  readonly category: PiiCategory;
  readonly reason: string;
}

/**
 * Run the name / data-type / description heuristics (Layers 1–4) and return the
 * verdict WITHOUT the declared-securityClassification floor. All verdicts here
 * are `heuristic` confidence; the caller applies the declared floor.
 */
const detectHeuristic = (node: Node): HeuristicVerdict => {
  const apiNameRaw = stripCustomFieldSuffix(node.apiName);
  const apiNameLower = apiNameRaw.toLowerCase();
  const dataType = getDataType(node);

  // Layer 1: EncryptedText override. Always `pii` — encryption IS the signal.
  if (dataType === ENCRYPTED_TEXT_DATA_TYPE) {
    const nameMatch = matchNamePattern(apiNameLower, apiNameRaw);
    const category = nameMatch === null ? 'unknown' : nameMatch.category;
    return {
      classification: 'pii',
      category,
      reason:
        'field data type is EncryptedText; classified pii (the encryption type IS the declaration)',
    };
  }

  // Layer 2: name patterns.
  let nameMatch = matchNamePattern(apiNameLower, apiNameRaw);

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
  } else if (isMoneyAmountField(node, apiNameLower, dataType)) {
    // Layer 3b: a Currency / Number field carrying a money-amount token is a
    // financial access-signal. ADDITIVE — only fires when no name/Email rule
    // already classified the field, so existing classifications are unchanged.
    baseClassification = 'sensitive';
    baseCategory = 'financial';
    baseReason = `field data type is ${dataType} and the name carries a money-amount token; classified sensitive/financial (a monetary value is a financial access-signal) — heuristic, not a person-identifier`;
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
    classification: baseClassification,
    category: baseCategory,
    reason: baseReason,
  };
};

/**
 * Classify a CustomField node along the (classification, category, confidence)
 * triple. Returns the result + a plain-English reason string. Callers that
 * don't need the reason should prefer `detectPiiClassification`.
 *
 * A declared `<securityClassification>` (`Confidential` / `Restricted` /
 * `MissionCritical`) is the HIGHEST-PRECEDENCE signal: it sets a FLOOR at
 * `declared` confidence, overriding a weaker name/label heuristic — but it never
 * DOWNGRADES a stronger heuristic verdict. Absent → the heuristic verdict stands
 * at `heuristic` confidence.
 *
 * @example
 *   const r = detectPiiClassificationWithReason(node);
 *   console.log(r.piiClassification, r.piiCategory, r.reason, r.confidence);
 */
export const detectPiiClassificationWithReason = (
  node: Node,
): PiiDetectionWithReason => {
  const heuristic = detectHeuristic(node);

  // Layer 0: declared securityClassification FLOOR (highest precedence).
  const declaredTier = getDeclaredSecurityTier(node);
  if (
    declaredTier !== null &&
    CLASSIFICATION_RANK[declaredTier] >= CLASSIFICATION_RANK[heuristic.classification]
  ) {
    const raw = getDeclaredSecurityRaw(node) ?? declaredTier;
    return {
      piiClassification: declaredTier,
      // The declaration carries no category; keep any name-derived one.
      piiCategory: heuristic.category,
      confidence: 'declared',
      reason: `declared securityClassification "${raw}" → ${declaredTier}; a declared data-classification is the highest-precedence signal and overrides name/label heuristics`,
    };
  }

  return {
    piiClassification: heuristic.classification,
    piiCategory: heuristic.category,
    confidence: 'heuristic',
    reason: heuristic.reason,
  };
};

/**
 * Classify a CustomField node along the (classification, category, confidence)
 * triple. The thin wrapper drops the `reason` field; `sfi.pii_inventory` calls
 * the with-reason variant so it can surface the matching rule to the caller.
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
    confidence: r.confidence,
  };
};

/**
 * True when a classification is regulated / sensitive enough to warrant a
 * compliance escalation on deletion, AI-exposure, and field-access surfaces —
 * i.e. `pii`, `sensitive`, or `protected` (protected-class). Callers that gate
 * escalations on the classification should use this rather than an ad-hoc
 * `=== 'pii' || === 'sensitive'` check, so `protected` is never missed.
 */
export const isRegulatedPiiClassification = (
  classification: PiiClassification,
): classification is 'pii' | 'sensitive' | 'protected' =>
  classification === 'pii' ||
  classification === 'sensitive' ||
  classification === 'protected';
