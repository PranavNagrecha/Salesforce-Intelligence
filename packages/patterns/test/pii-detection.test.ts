/// <reference types="vitest/globals" />

import type { Node } from '@sf-intelligence/contracts';

import {
  detectPiiClassification,
  detectPiiClassificationWithReason,
} from '../src/pii-detection.js';

/** Build a minimal CustomField node for the recognizer tests. */
const field = (
  parent: string,
  apiName: string,
  properties: Readonly<Record<string, unknown>> = {},
): Node => ({
  id: `CustomField:${parent}.${apiName}`,
  type: 'CustomField',
  apiName,
  label: apiName,
  parentId: `CustomObject:${parent}`,
  sourcePath: `objects/${parent}/fields/${apiName}.field-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { dataType: 'Text', ...properties },
});

describe('detectPiiClassification: name-based identifier patterns', () => {
  it('classifies SSN__c as pii/identifier', () => {
    const r = detectPiiClassification(field('Contact', 'SSN__c'));
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('identifier');
  });

  it('classifies SocialSecurity_Number__c as pii/identifier', () => {
    const r = detectPiiClassification(
      field('Contact', 'SocialSecurity_Number__c'),
    );
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('identifier');
  });

  it('classifies BirthDate__c as pii/identifier', () => {
    const r = detectPiiClassification(field('Contact', 'BirthDate__c'));
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('identifier');
  });

  it('classifies Employee_DOB__c as pii/identifier', () => {
    const r = detectPiiClassification(field('Employee__c', 'Employee_DOB__c'));
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('identifier');
  });
});

describe('detectPiiClassification: name-based contact patterns', () => {
  it('classifies PersonalEmail__c as pii/contact', () => {
    const r = detectPiiClassification(field('Contact', 'PersonalEmail__c'));
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('contact');
  });

  it('classifies Mobile_Phone__c as pii/contact', () => {
    const r = detectPiiClassification(field('Contact', 'Mobile_Phone__c'));
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('contact');
  });

  it('classifies Street__c as pii/contact', () => {
    const r = detectPiiClassification(field('Account', 'Street__c'));
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('contact');
  });

  it('classifies PostalCode__c as pii/contact', () => {
    const r = detectPiiClassification(field('Account', 'PostalCode__c'));
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('contact');
  });

  it('classifies First_Name__c and Last_Name__c as pii/contact', () => {
    const first = detectPiiClassification(field('Student_Record__c', 'First_Name__c'));
    expect(first.piiClassification).toBe('pii');
    expect(first.piiCategory).toBe('contact');
  });

  it('does not classify venue location fields on organizational objects as PII', () => {
    const venueAddress = {
      id: 'CustomField:OA_Location__c.Location_Address__c',
      type: 'CustomField' as const,
      apiName: 'Location_Address__c',
      label: 'Location Address',
      parentId: 'CustomObject:OA_Location__c' as const,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: { dataType: 'Text' },
    };
    const eventUrl = {
      id: 'CustomField:OA_Engagements__c.Web_address_for_the_event__c',
      type: 'CustomField' as const,
      apiName: 'Web_address_for_the_event__c',
      label: 'Web address for the event',
      parentId: 'CustomObject:OA_Engagements__c' as const,
      sourcePath: 'x',
      lastModifiedDate: null,
      lastModifiedBy: null,
      apiVersion: null,
      properties: { dataType: 'Url' },
    };
    expect(detectPiiClassification(venueAddress).piiClassification).toBe('public');
    expect(detectPiiClassification(eventUrl).piiClassification).toBe('public');
  });

  it('classifies an Email-typed field with no PII name as pii/contact', () => {
    const r = detectPiiClassification(
      field('Contact', 'Notification_Channel__c', { dataType: 'Email' }),
    );
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('contact');
  });
});

describe('detectPiiClassification: constrained-type (Checkbox/Picklist) contact-flag suppression', () => {
  it('does NOT flag a Checkbox with a contact-token name as PII (it is a config flag)', () => {
    // Regression: `Send_Email_to_Contact__c` matched the `email` contact token
    // and was flagged pii/contact even though a Checkbox stores only
    // true/false — it is an action flag, not a stored contact value.
    const r = detectPiiClassificationWithReason(
      field('Account', 'Send_Email_to_Contact__c', { dataType: 'Checkbox' }),
    );
    expect(r.piiClassification).toBe('public');
    expect(r.reason).toMatch(/Checkbox/i);
  });

  it('does NOT flag a Picklist / MultiselectPicklist with a contact-token name as PII', () => {
    // `Email_List__c` (a MultiselectPicklist of which lists to send) is config:
    // a fixed option set never holds a raw email/phone/address value.
    for (const dataType of ['Picklist', 'MultiselectPicklist']) {
      const r = detectPiiClassificationWithReason(
        field('OA_Communication_Request__c', 'Email_List__c', { dataType }),
      );
      expect(r.piiClassification).toBe('public');
      expect(r.reason).toContain(dataType);
    }
  });

  it('does NOT flag a Date / DateTime / Time / Currency / Percent field with a contact-token name as PII', () => {
    // A temporal or money field (e.g. `Last_Email_Date__c`, `Phone_Bill_Amount__c`)
    // can never STORE a free-text contact value, so a contact-token name on it is
    // metadata, not stored PII. (Number is NOT suppressed — a phone number can
    // plausibly be stored as a Number.)
    for (const dataType of ['Date', 'DateTime', 'Time', 'Currency', 'Percent']) {
      const r = detectPiiClassificationWithReason(
        field('Contact', 'Mobile_Phone__c', { dataType }),
      );
      expect(r.piiClassification).toBe('public');
      expect(r.reason).toContain(dataType);
    }
  });

  it('still flags a Text field with the same contact name as pii/contact (type-gated)', () => {
    // The suppression is gated on the Boolean type: a real Text field that
    // could actually hold the value is unaffected.
    const r = detectPiiClassification(
      field('Account', 'Widget_Email__c', { dataType: 'Text' }),
    );
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('contact');
  });

  it('leaves a non-contact Checkbox match intact (suppression is contact-only)', () => {
    // A boolean CAN encode a sensitive FACT, so only the contact channel is
    // suppressed; an identifier-token Checkbox is still surfaced.
    const r = detectPiiClassification(
      field('Contact', 'Has_SSN__c', { dataType: 'Checkbox' }),
    );
    expect(r.piiClassification).not.toBe('public');
  });
});

describe('detectPiiClassification: name-based financial patterns', () => {
  it('classifies Salary__c as sensitive/financial', () => {
    const r = detectPiiClassification(field('Employee__c', 'Salary__c'));
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('financial');
  });

  it('classifies CreditCard_Number__c as sensitive/financial', () => {
    const r = detectPiiClassification(
      field('Account', 'CreditCard_Number__c'),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('financial');
  });

  it('classifies BankAccount__c as sensitive/financial', () => {
    const r = detectPiiClassification(field('Account', 'BankAccount__c'));
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('financial');
  });
});

// GROUP-A PII-safety: a Currency / Number field whose name carries a money token
// is a financial access-signal — classify as sensitive/financial (additive).
describe('detectPiiClassification: money-token Currency/Number fields', () => {
  it('classifies a Currency Payment_Amount__c as sensitive/financial', () => {
    const r = detectPiiClassification(
      field('Account', 'Payment_Amount__c', { dataType: 'Currency' }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('financial');
  });

  it('classifies a Number Outstanding_Balance__c as sensitive/financial', () => {
    const r = detectPiiClassification(
      field('Account', 'Outstanding_Balance__c', { dataType: 'Number' }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('financial');
  });

  it('classifies a Currency Late_Fee__c as sensitive/financial', () => {
    const r = detectPiiClassification(
      field('Contact', 'Late_Fee__c', { dataType: 'Currency' }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('financial');
  });

  it('does NOT classify a Text field with a money token (no Currency/Number type)', () => {
    // additive scope: the rule fires only for Currency / Number data types.
    const r = detectPiiClassification(field('Account', 'Payment_Status__c'));
    expect(r.piiClassification).toBe('public');
  });

  it('does NOT classify a generic product/catalog list price as PII', () => {
    // false-positive guard: a product catalog price is not a person/account
    // financial signal.
    const r = detectPiiClassification(
      field('Product2', 'List_Price__c', { dataType: 'Currency' }),
    );
    expect(r.piiClassification).toBe('public');
  });
});

describe('detectPiiClassification: name-based health patterns', () => {
  it('classifies Diagnosis__c as sensitive/health', () => {
    const r = detectPiiClassification(field('Patient__c', 'Diagnosis__c'));
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('health');
  });

  it('classifies PatientID__c as sensitive/health', () => {
    const r = detectPiiClassification(field('Patient__c', 'PatientID__c'));
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('health');
  });

  it('classifies MRN__c as sensitive/health', () => {
    const r = detectPiiClassification(field('Patient__c', 'MRN__c'));
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('health');
  });
});

describe('detectPiiClassification: EncryptedText precedence rule', () => {
  it('classifies any EncryptedText field as pii regardless of name', () => {
    const r = detectPiiClassification(
      field('Account', 'Notes__c', { dataType: 'EncryptedText' }),
    );
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('unknown');
  });

  it('uses the name match for the category when EncryptedText overrides a SSN-named field', () => {
    const r = detectPiiClassification(
      field('Contact', 'SSN__c', { dataType: 'EncryptedText' }),
    );
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('identifier');
  });

  it('classifies Student_SSN__c EncryptedText as pii/identifier', () => {
    const r = detectPiiClassification(
      field('Student_Record__c', 'Student_SSN__c', { dataType: 'EncryptedText' }),
    );
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('identifier');
  });

  it("emits a reason naming the EncryptedText override on a generic name", () => {
    const r = detectPiiClassificationWithReason(
      field('Account', 'Notes__c', { dataType: 'EncryptedText' }),
    );
    expect(r.reason).toContain('EncryptedText');
  });
});

describe('detectPiiClassification: description-based patterns', () => {
  it('classifies a generic-named field as pii when the description mentions PII', () => {
    const r = detectPiiClassification(
      field('Account', 'Notes__c', { description: 'Contains PII data' }),
    );
    expect(r.piiClassification).toBe('pii');
  });

  it('classifies a generic-named field as sensitive/health when the description mentions HIPAA', () => {
    const r = detectPiiClassification(
      field('Account', 'Notes__c', { description: 'HIPAA-protected note' }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('health');
  });

  it('classifies a generic-named field as sensitive/financial when the description mentions PCI', () => {
    const r = detectPiiClassification(
      field('Account', 'Notes__c', {
        description: 'PCI / cardholder data flag',
      }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('financial');
  });

  it('classifies a generic-named field as sensitive when the description mentions Sensitive', () => {
    const r = detectPiiClassification(
      field('Account', 'Notes__c', { description: 'Sensitive internal data' }),
    );
    expect(r.piiClassification).toBe('sensitive');
  });

  it("escalates a name-only pii match to sensitive when the description names HIPAA", () => {
    // SSN__c is pii/identifier by name; but the description names HIPAA so
    // the recognizer must escalate.
    const r = detectPiiClassification(
      field('Contact', 'SSN__c', {
        description: 'HIPAA-protected medical id',
      }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('health');
  });
});

describe('detectPiiClassification: defaults and edge cases', () => {
  it("returns public/unknown for a field with no rule match and no description", () => {
    const r = detectPiiClassification(field('Account', 'Industry__c'));
    expect(r.piiClassification).toBe('public');
    expect(r.piiCategory).toBe('unknown');
  });

  it("returns public/unknown for a non-CustomField-suffix standard field name without PII tokens", () => {
    const r = detectPiiClassification(field('Account', 'Industry'));
    expect(r.piiClassification).toBe('public');
    expect(r.piiCategory).toBe('unknown');
  });

  it("matches case-insensitively (an all-lowercase name still classifies)", () => {
    const r = detectPiiClassification(field('Contact', 'home_email__c'));
    expect(r.piiClassification).toBe('pii');
    expect(r.piiCategory).toBe('contact');
  });

  it("is deterministic across repeated calls", () => {
    const node = field('Contact', 'SSN__c');
    const a = detectPiiClassification(node);
    const b = detectPiiClassification(node);
    expect(a).toEqual(b);
  });
});

// D4 (P1 compliance): protected-class attributes are the HIGHEST sensitivity
// tier. Synthetic field names only — general protected-class vocabulary.
describe('detectPiiClassification: protected-class patterns', () => {
  it('classifies Race__c as protected/protected-class', () => {
    const r = detectPiiClassification(field('Contact', 'Race__c'));
    expect(r.piiClassification).toBe('protected');
    expect(r.piiCategory).toBe('protected-class');
  });

  it('classifies Ethnicity__c as protected/protected-class', () => {
    const r = detectPiiClassification(field('Contact', 'Ethnicity__c'));
    expect(r.piiClassification).toBe('protected');
    expect(r.piiCategory).toBe('protected-class');
  });

  it('classifies a Disability_Status__c Checkbox as protected (constrained type does NOT suppress a protected fact)', () => {
    const r = detectPiiClassification(
      field('Contact', 'Disability_Status__c', { dataType: 'Checkbox' }),
    );
    expect(r.piiClassification).toBe('protected');
    expect(r.piiCategory).toBe('protected-class');
  });

  it('classifies a Race__c MultiselectPicklist as protected (constrained type does NOT suppress a protected fact)', () => {
    const r = detectPiiClassification(
      field('Contact', 'Race__c', { dataType: 'MultiselectPicklist' }),
    );
    expect(r.piiClassification).toBe('protected');
    expect(r.piiCategory).toBe('protected-class');
  });

  it('classifies Citizenship__c and Citizenship_Detail__c as protected/protected-class', () => {
    for (const name of ['Citizenship__c', 'Citizenship_Detail__c']) {
      const r = detectPiiClassification(field('Contact', name));
      expect(r.piiClassification).toBe('protected');
      expect(r.piiCategory).toBe('protected-class');
    }
  });

  it('covers general protected-class vocabulary (org-independent tokens)', () => {
    for (const name of [
      'Veteran_Status__c',
      'Military_Status__c',
      'Religion__c',
      'Religious_Affiliation__c',
      'National_Origin__c',
      'Nationality__c',
      'Sexual_Orientation__c',
      'Gender_Identity__c',
      'Ethnic_Group__c',
    ]) {
      const r = detectPiiClassification(field('Contact', name));
      expect(r.piiClassification).toBe('protected');
      expect(r.piiCategory).toBe('protected-class');
    }
  });

  it('matches `race` only as a WHOLE word — Grace/Trace/Racetrack/Embrace do NOT classify protected', () => {
    for (const name of [
      'Grace_Period__c',
      'Trace_Id__c',
      'Racetrack_Location__c',
      'Embrace_Program__c',
    ]) {
      const r = detectPiiClassification(field('Account', name));
      expect(r.piiClassification).toBe('public');
    }
  });
});

// D4: the bare 3-letter `phi` token was a false-positive generator. The PHI
// health signal must fire ONLY on the genuine acronym, never the Greek letter.
describe('detectPiiClassification: PHI acronym vs Greek-letter / word context', () => {
  it('does NOT classify Phi_Sigma_Member__c (a Greek-letter society) as health', () => {
    const r = detectPiiClassificationWithReason(
      field('Contact', 'Phi_Sigma_Member__c', { dataType: 'Checkbox' }),
    );
    expect(r.piiCategory).not.toBe('health');
    expect(r.piiClassification).not.toBe('sensitive');
    expect(r.piiClassification).toBe('public');
  });

  it('does NOT classify Philosophy__c or Philadelphia_Office__c as health', () => {
    expect(
      detectPiiClassification(field('Contact', 'Philosophy__c')).piiClassification,
    ).toBe('public');
    expect(
      detectPiiClassification(field('Account', 'Philadelphia_Office__c'))
        .piiClassification,
    ).toBe('public');
  });

  it('does NOT fire health on a description naming the Phi Theta Kappa honor society', () => {
    const r = detectPiiClassification(
      field('Contact', 'Member_Flag__c', {
        dataType: 'Checkbox',
        description:
          "Is the applicant a member of the Phi Theta Kappa honor's society?",
      }),
    );
    expect(r.piiCategory).not.toBe('health');
    expect(r.piiClassification).toBe('public');
  });

  it('classifies PHI__c (standalone acronym) as sensitive/health', () => {
    const r = detectPiiClassification(field('Patient__c', 'PHI__c'));
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('health');
  });

  it('classifies Protected_Health_Info__c as sensitive/health', () => {
    const r = detectPiiClassification(
      field('Patient__c', 'Protected_Health_Info__c'),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('health');
  });

  it('classifies a description naming "protected health" as sensitive/health', () => {
    const r = detectPiiClassification(
      field('Account', 'Notes__c', {
        description: 'Contains protected health information',
      }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.piiCategory).toBe('health');
  });
});

// D4: a declared <securityClassification> is the HIGHEST-PRECEDENCE signal.
describe('detectPiiClassification: declared securityClassification precedence', () => {
  it('classifies an innocuous-named Confidential field as sensitive at declared confidence', () => {
    const r = detectPiiClassificationWithReason(
      field('Account', 'Detail__c', { securityClassification: 'Confidential' }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.confidence).toBe('declared');
    expect(r.reason).toMatch(/securityClassification/i);
  });

  it('classifies a Restricted field as protected at declared confidence', () => {
    const r = detectPiiClassificationWithReason(
      field('Account', 'Detail__c', { securityClassification: 'Restricted' }),
    );
    expect(r.piiClassification).toBe('protected');
    expect(r.confidence).toBe('declared');
  });

  it('escalates a name-only pii field (SSN) to sensitive when Confidential is declared', () => {
    const r = detectPiiClassificationWithReason(
      field('Contact', 'SSN__c', { securityClassification: 'Confidential' }),
    );
    expect(r.piiClassification).toBe('sensitive');
    expect(r.confidence).toBe('declared');
  });

  it('does NOT downgrade a stronger protected name signal for a Confidential field', () => {
    // name -> protected (rank 4) beats Confidential -> sensitive (rank 3):
    // keep protected, and the verdict stays heuristic (name-driven).
    const r = detectPiiClassificationWithReason(
      field('Student_Record__c', 'Disability_Status__c', {
        dataType: 'Checkbox',
        securityClassification: 'Confidential',
      }),
    );
    expect(r.piiClassification).toBe('protected');
    expect(r.confidence).toBe('heuristic');
  });

  it('falls back to heuristics for a non-escalating (Public) classification — never a silent downgrade', () => {
    const r = detectPiiClassificationWithReason(
      field('Contact', 'SSN__c', { securityClassification: 'Public' }),
    );
    expect(r.piiClassification).toBe('pii');
    expect(r.confidence).toBe('heuristic');
  });
});

describe('detectPiiClassification: confidence axis', () => {
  it('marks a name-based match heuristic', () => {
    expect(
      detectPiiClassification(field('Contact', 'SSN__c')).confidence,
    ).toBe('heuristic');
  });

  it('marks a declared-classification match declared', () => {
    expect(
      detectPiiClassification(
        field('Account', 'Innocuous__c', {
          securityClassification: 'Confidential',
        }),
      ).confidence,
    ).toBe('declared');
  });
});

/**
 * Short name tokens matched as substrings produced confident PII verdicts about
 * fields that hold no personal data at all. These pin both directions: the
 * ambiguous carriers stay clean, and the real contact fields still classify.
 */
describe('detectPiiClassification: whole-word-only tokens', () => {
  const notPii = (parent: string, apiName: string): void => {
    const r = detectPiiClassificationWithReason(field(parent, apiName));
    expect(r.piiClassification, `${apiName} should carry no PII signal`).toBe(
      'public',
    );
  };
  const isPii = (parent: string, apiName: string): void => {
    const r = detectPiiClassificationWithReason(field(parent, apiName));
    expect(r.piiClassification, `${apiName} should still classify as PII`).toBe(
      'pii',
    );
  };

  it('does not classify fields that merely CONTAIN city/phone/street', () => {
    // Each of these was a measured false positive before the fix.
    notPii('Session__c', 'Seating_Capacity__c');
    notPii('Meter__c', 'Electricity_Usage__c');
    notPii('Shipment__c', 'Velocity__c');
    notPii('Campaign', 'Publicity_Flag__c');
    notPii('Sample__c', 'Toxicity_Level__c');
    notPii('Asset', 'Headphone_Model__c');
    notPii('Asset', 'Microphone_Count__c');
    notPii('Route__c', 'Streetlight_Count__c');
  });

  it('still classifies the contact fields those tokens exist to catch', () => {
    isPii('Contact', 'Mailing_City__c');
    isPii('Account', 'BillingCity');
    isPii('Contact', 'Home_Phone__c');
    isPii('Contact', 'CellPhone');
    isPii('Contact', 'Street_Address__c');
    isPii('Contact', 'MailingStreet');
  });

  it('keeps Telephone__c classified, which whole-word `phone` alone would drop', () => {
    // `telephone` is a single word segment, so it is carried as its own token.
    isPii('Contact', 'Telephone__c');
  });
});

/**
 * SEPARATOR-SENSITIVE NAME MATCHING.
 *
 * The name vocabulary carries multi-word concepts as ONE concatenated token
 * (`socialsecurity`, `dateofbirth`, `zipcode`), and the match was a plain
 * substring test against the api name with its separators INTACT. So the same
 * concept classified differently depending on how the admin punctuated it:
 * `SocialSecurity_Number__c` matched, `Social_Security_Number__c` did not and
 * fell to the unmatched `public` / `unknown` default. Two fields naming the
 * same regulated concept, on the same object, landing in different buckets is
 * the failure a compliance sweep cannot see: the miss looks like a clean row.
 *
 * The fix matches the token against the api name's word segments joined
 * (`social` + `security` + `number` -> `socialsecuritynumber`) but ONLY where
 * the match starts on a segment boundary, so a token cannot straddle two words
 * that merely happen to abut (see the false-positive block below).
 */
describe('detectPiiClassification: separator-spelled multi-word concepts', () => {
  const identifier = (parent: string, apiName: string): void => {
    const r = detectPiiClassificationWithReason(field(parent, apiName));
    expect(r.piiClassification, `${apiName} classification`).toBe('pii');
    expect(r.piiCategory, `${apiName} category`).toBe('identifier');
  };

  it('classifies the underscore-spelled social security number', () => {
    identifier('Contact', 'Social_Security_Number__c');
  });

  it('classifies the underscore-spelled and long-form date of birth', () => {
    identifier('Lead', 'Date_of_Birth__c');
    identifier('Lead', 'Birth_Date__c');
    identifier('Lead', 'Student_Date_Of_Birth__c');
  });

  it('classifies the underscore-spelled drivers license', () => {
    identifier('Contact', 'Drivers_License_Number__c');
  });

  it('classifies separator-spelled contact concepts', () => {
    const zip = detectPiiClassificationWithReason(field('Contact', 'Zip_Code__c'));
    expect(zip.piiClassification).toBe('pii');
    expect(zip.piiCategory).toBe('contact');
    const postal = detectPiiClassificationWithReason(
      field('Contact', 'Postal_Code__c'),
    );
    expect(postal.piiClassification).toBe('pii');
    expect(postal.piiCategory).toBe('contact');
  });

  it('classifies separator-spelled protected-class and financial concepts', () => {
    const bank = detectPiiClassificationWithReason(
      field('Account', 'Bank_Account_Number__c'),
    );
    expect(bank.piiClassification).toBe('sensitive');
    expect(bank.piiCategory).toBe('financial');
    const card = detectPiiClassificationWithReason(
      field('Payment__c', 'Credit_Card_Last_Four__c'),
    );
    expect(card.piiClassification).toBe('sensitive');
    expect(card.piiCategory).toBe('financial');
    const mrec = detectPiiClassificationWithReason(
      field('Patient__c', 'Medical_Record_Id__c'),
    );
    expect(mrec.piiClassification).toBe('sensitive');
    expect(mrec.piiCategory).toBe('health');
  });
});

/**
 * The naive form of the same fix — squashing the WHOLE api name and running the
 * unchanged `includes` over it — lets a short token straddle a word boundary.
 * Every name below squashes to a string that CONTAINS a vocabulary token
 * (`class`+`number` -> "...ssn...", `record`+`object` -> "...dob...",
 * `team`+`rn` -> "...mrn...", `address`+`number` -> "...ssn..."), and none of
 * them holds an identifier. Boundary-aligned matching is what keeps them out.
 */
describe('detectPiiClassification: squashed-name straddle false positives', () => {
  const notIdentifier = (parent: string, apiName: string): void => {
    const r = detectPiiClassificationWithReason(field(parent, apiName));
    expect(
      r.piiCategory,
      `${apiName} must not classify as an identifier (reason: ${r.reason})`,
    ).not.toBe('identifier');
  };

  it('does not read an SSN out of two abutting words', () => {
    notIdentifier('Course__c', 'Class_Number__c');
    notIdentifier('Process__c', 'Process_Note__c');
  });

  it('does not read a DOB or MRN out of two abutting words', () => {
    notIdentifier('Audit__c', 'Record_Object__c');
    notIdentifier('Team__c', 'Team_RN_Count__c');
  });

  it('keeps the whole-word-only tokens out of the squashed form', () => {
    // `capacity` squashes next to `seating`; `city` must still not fire.
    const r = detectPiiClassificationWithReason(
      field('Session__c', 'Seating_Capacity__c'),
    );
    expect(r.piiClassification).toBe('public');
  });
});

/**
 * WHAT THE DESCRIPTION LAYER ACTUALLY DOES.
 *
 * The tool advertises that the recognizer inspects "API name, declared data
 * type, AND description text", and a reader takes that to mean the description
 * can rescue a name-token miss. It cannot, for identifiers: `DESCRIPTION_RULES`
 * carries compliance-REGIME keywords only (hipaa / protected health / pci /
 * cardholder / sensitive / internal only / privileged / pii / personally
 * identifiable / confidential / restricted). It recognizes an admin DECLARING a
 * regulatory character, not a description that merely names the data.
 *
 * The disposition is NARROW THE CLAIM, not add identifier vocabulary — see the
 * `DESCRIPTION_RULES` JSDoc for the false positives that decision avoids. These
 * cases pin both halves of the narrowed claim: the layer fires on a declaration,
 * and the unmatched reason says which three things were checked so the caller is
 * not left believing a concept mention was consulted.
 */
describe('detectPiiClassification: the description layer reads declarations, not concepts', () => {
  it('fires when the description declares a regime', () => {
    const r = detectPiiClassificationWithReason(
      field('Case', 'Notes__c', {
        description: 'Confidential — treat as PII under the privacy policy.',
      }),
    );
    expect(r.piiClassification).toBe('pii');
  });

  it('does NOT fire on a description that merely names the concept', () => {
    const r = detectPiiClassificationWithReason(
      field('Obj_A__c', 'Enrolment_Marker__c', {
        dataType: 'Date',
        description: "Date of this individual's birth.",
      }),
    );
    expect(r.piiClassification).toBe('public');
  });

  it('names the description in the unmatched reason, so the claim is not overstated', () => {
    const r = detectPiiClassificationWithReason(
      field('Obj_A__c', 'Enrolment_Marker__c', {
        dataType: 'Date',
        description: "Date of this individual's birth.",
      }),
    );
    // The old text — "no PII signal detected in API name or data type" — named
    // two of the three layers, so a reader could not tell whether the
    // description had been consulted and found nothing, or never consulted.
    expect(r.reason).toMatch(/description/i);
  });
});
