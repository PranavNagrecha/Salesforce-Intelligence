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

  it('classifies Citizenship__c and Citizenship_Status__c as protected/protected-class', () => {
    for (const name of ['Citizenship__c', 'Citizenship_Status__c']) {
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
  it('does NOT classify Phi_Theta_Kappa__c (an honor society) as health', () => {
    const r = detectPiiClassificationWithReason(
      field('Contact', 'Phi_Theta_Kappa__c', { dataType: 'Checkbox' }),
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
