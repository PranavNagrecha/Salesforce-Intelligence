/// <reference types="vitest/globals" />

import { omnistudio } from '../src/index.js';

const {
  evaluateFormula,
  evaluateShowRule,
  extractAliases,
  nearMisses,
  nearMissRule,
  parseDataMapper,
  parseKeyPath,
  parseOmniProcess,
  parseShowRule,
  ruleConditions,
  scanBraceRefs,
  scanPercentRefs,
  soleMergeRef,
  elementRole,
  isRepeating,
  editBlockActionKind,
} = omnistudio;

const psc = (o: unknown): string => JSON.stringify(o).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * A script whose XML lists siblings ALPHABETICALLY (as retrieves do) while the
 * runtime order is by sequenceNumber: Zeta (seq 0) runs before Alpha (seq 1).
 */
const SCRIPT = `<?xml version="1.0" encoding="UTF-8"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <isIntegrationProcedure>false</isIntegrationProcedure>
    <language>Multi-Language</language>
    <name>Acme_Cart</name>
    <omniProcessElements>
        <childElements>
            <childElements>
                <isActive>true</isActive>
                <level>2.0</level>
                <name>Acme_Qty__c </name>
                <propertySetConfig>${psc({ label: 'Qty', mask: '999' })}</propertySetConfig>
                <sequenceNumber>0.0</sequenceNumber>
                <type>Number</type>
            </childElements>
            <isActive>true</isActive>
            <level>1.0</level>
            <name>LineEditBlock</name>
            <propertySetConfig>${psc({ allowDelete: true })}</propertySetConfig>
            <sequenceNumber>1.0</sequenceNumber>
            <type>Edit Block</type>
        </childElements>
        <childElements>
            <isActive>true</isActive>
            <level>1.0</level>
            <name>Zeta</name>
            <propertySetConfig>{not json</propertySetConfig>
            <sequenceNumber>0.0</sequenceNumber>
            <type>Text Block</type>
        </childElements>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>CartStep</name>
        <propertySetConfig>${psc({ label: 'Cart' })}</propertySetConfig>
        <sequenceNumber>0.0</sequenceNumber>
        <type>Step</type>
    </omniProcessElements>
    <omniProcessType>OmniScript</omniProcessType>
    <subType>Cart</subType>
    <type>Acme</type>
    <uniqueName>Acme_Cart_multiLanguage_3</uniqueName>
    <versionNumber>3.0</versionNumber>
</OmniScript>`;

describe('parseOmniProcess', () => {
  it('builds the runtime tree: sequence order, raw names, paths, lines, warnings', () => {
    const parsed = parseOmniProcess(SCRIPT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { header, roots, elements, warnings } = parsed.doc;
    expect(header).toMatchObject({
      kind: 'OmniScript',
      uniqueName: 'Acme_Cart_multiLanguage_3',
      type: 'Acme',
      subType: 'Cart',
      language: 'Multi-Language',
      versionNumber: 3,
      isActive: true,
    });
    expect(roots.map((r) => r.name)).toEqual(['CartStep']);
    // Zeta (seq 0) before LineEditBlock (seq 1) despite XML order.
    expect(roots[0]?.children.map((c) => c.name)).toEqual(['Zeta', 'LineEditBlock']);
    // Pre-order over the runtime tree, with the trailing space kept raw.
    expect(elements.map((e) => e.idPath)).toEqual([
      'CartStep',
      'CartStep/Zeta',
      'CartStep/LineEditBlock',
      'CartStep/LineEditBlock/Acme_Qty__c ',
    ]);
    const qty = elements[3];
    expect(qty?.path).toEqual(['CartStep', 'LineEditBlock', 'Acme_Qty__c ']);
    expect(qty?.config).toEqual({ label: 'Qty', mask: '999' });
    // Lines point at each element's <name>.
    const lines = SCRIPT.split('\n');
    for (const e of elements) {
      expect(e.line).not.toBeNull();
      expect(lines[(e.line as number) - 1]).toContain(`<name>${e.name}</name>`);
    }
    expect(elements[1]?.config).toBeNull();
    expect(elements[1]?.configError).not.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CartStep/Zeta');
  });

  it('recognizes an Integration Procedure root and its key', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>false</isActive>
    <isIntegrationProcedure>true</isIntegrationProcedure>
    <language>English</language>
    <name>Acme_SaveCart</name>
    <omniProcessKey>Acme_SaveCart</omniProcessKey>
    <omniProcessType>Integration Procedure</omniProcessType>
    <subType>SaveCart</subType>
    <type>Acme</type>
    <uniqueName>Acme_SaveCart_English_2</uniqueName>
    <versionNumber>2.0</versionNumber>
</OmniIntegrationProcedure>`;
    const parsed = parseOmniProcess(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.header).toMatchObject({
      kind: 'IntegrationProcedure',
      omniProcessKey: 'Acme_SaveCart',
      isActive: false,
    });
    expect(parsed.doc.elements).toEqual([]);
  });

  it('suffixes duplicate sibling names in idPath only', () => {
    const el = (name: string, seq: number): string => `
        <childElements>
            <isActive>true</isActive>
            <name>${name}</name>
            <sequenceNumber>${seq}.0</sequenceNumber>
            <type>Text</type>
        </childElements>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
    <omniProcessElements>${el('Dup', 0)}${el('Dup', 1)}
        <isActive>true</isActive>
        <name>S</name>
        <sequenceNumber>0.0</sequenceNumber>
        <type>Step</type>
    </omniProcessElements>
    <uniqueName>Acme_X_English_1</uniqueName>
</OmniScript>`;
    const parsed = parseOmniProcess(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.elements.map((e) => e.idPath)).toEqual(['S', 'S/Dup', 'S/Dup~2']);
    expect(parsed.doc.elements[2]?.path).toEqual(['S', 'Dup']);
  });

  it('returns a parse failure for malformed XML', () => {
    expect(parseOmniProcess('<OmniScript><a></OmniScript>').ok).toBe(false);
  });
});

describe('parseDataMapper / extractAliases', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <inputType>JSON</inputType>
    <name>AcmeGetCart</name>
    <omniDataTransformItem>
        <filterOperator>=</filterOperator>
        <filterValue>cartId</filterValue>
        <inputFieldName>Id</inputFieldName>
        <inputObjectName>Acme_Cart__c</inputObjectName>
        <name>AcmeGetCart</name>
        <outputFieldName>cart</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <omniDataTransformItem>
        <inputFieldName>cart:Acme_Total__c </inputFieldName>
        <name>AcmeGetCart</name>
        <outputFieldName>Cart:Total</outputFieldName>
        <outputObjectName>json</outputObjectName>
    </omniDataTransformItem>
    <outputType>JSON</outputType>
    <type>Extract</type>
    <uniqueName>AcmeGetCart_1</uniqueName>
    <versionNumber>1.0</versionNumber>
</OmniDataTransform>`;

  it('parses the header and items with raw paths and line numbers', () => {
    const parsed = parseDataMapper(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { header, items } = parsed.doc;
    expect(header).toMatchObject({ name: 'AcmeGetCart', uniqueName: 'AcmeGetCart_1', kind: 'Extract', active: false });
    expect(items).toHaveLength(2);
    expect(items[1]?.inputFieldName).toBe('cart:Acme_Total__c ');
    const lines = xml.split('\n');
    expect(lines[(items[0]?.line as number) - 1]).toContain('<omniDataTransformItem>');
    expect(extractAliases(items).get('cart')).toBe('Acme_Cart__c');
  });
});

describe('key paths and near-misses', () => {
  it('parses row markers but keeps names raw', () => {
    expect(parseKeyPath('Step:Block|n:Field ').segments).toEqual([
      { name: 'Step', row: 'none' },
      { name: 'Block', row: 'current' },
      { name: 'Field ', row: 'none' },
    ]);
    expect(parseKeyPath('Out:result|0:ok').segments[1]).toEqual({ name: 'result', row: 0 });
    expect(parseKeyPath('Out:result[2]').segments[1]).toEqual({ name: 'result', row: 2 });
  });

  it('classifies near-miss rules', () => {
    expect(nearMissRule('successFlag ', 'successFlag')).toBe('whitespace');
    expect(nearMissRule('AcmeQty__c', 'acmeqty__c')).toBe('case');
    expect(nearMissRule('Acme_Qty__c', 'AcmeQty__c')).toBe('underscore');
    expect(
      nearMissRule('AC_ME_Qty__c', 'ACME_Qty__c', { prefixVariants: [['AC_ME_', 'ACME_']] }),
    ).toBe('prefixVariant AC_ME_⇄ACME_');
    expect(nearMissRule('Acme_Qty__c', 'Acme_Price__c')).toBeNull();
  });

  it('suggests candidates differing in exactly one segment', () => {
    expect(
      nearMisses('LineEditBlock:ACME_Qty__c', [
        'LineEditBlock:AC_ME_Qty__c',
        'OtherBlock:AC_ME_Qty__c',
        'LineEditBlock:Price__c',
      ], { prefixVariants: [['AC_ME_', 'ACME_']] }),
    ).toEqual([{ candidate: 'LineEditBlock:AC_ME_Qty__c', rule: 'prefixVariant ACME_⇄AC_ME_' }]);
  });
});

describe('merge expressions', () => {
  it('finds %refs% in a condition and flags an unterminated opener', () => {
    const r = scanPercentRefs('%step% == 2 && ISNOTBLANK(%Details)');
    expect(r.refs.map((x) => x.raw)).toEqual(['step']);
    expect(r.malformed).toEqual([{ start: 26, fragment: '%Details' }]);
  });

  it('recovers after a stray opener and ignores literal percents', () => {
    const r = scanPercentRefs('ISNOTBLANK(%A) && %B% == 1, 50% off');
    expect(r.refs.map((x) => x.raw)).toEqual(['B']);
    expect(r.malformed.map((m) => m.fragment)).toEqual(['%A']);
  });

  it('keeps edge whitespace in a ref and parses its path', () => {
    const r = scanPercentRefs('%Step:Edit|n:Qty %');
    expect(r.refs[0]?.raw).toBe('Step:Edit|n:Qty ');
    expect(r.refs[0]?.path.segments.map((s) => s.name)).toEqual(['Step', 'Edit', 'Qty ']);
  });

  it('identifies a sole merge field (a move) versus a derived value', () => {
    expect(soleMergeRef(' %Cart:Lines% ')?.raw).toBe('Cart:Lines');
    expect(soleMergeRef('%a% %b%')).toBeNull();
    expect(soleMergeRef('=IF(%a%, 1, 2)')).toBeNull();
    expect(soleMergeRef('literal')).toBeNull();
  });

  it('finds {placeholders}', () => {
    expect(scanBraceRefs('Invalid id: {action.cartId} and {Params.id}').map((r) => r.raw)).toEqual([
      'action.cartId',
      'Params.id',
    ]);
  });
});

describe('show rules', () => {
  const rule = parseShowRule({
    group: {
      operator: 'AND',
      rules: [
        { field: 'Acme_Pays__c', condition: '=', data: 'Yes' },
        { group: { operator: 'OR', rules: [{ field: 'age', condition: '>=', data: '65' }, { field: 'flag ', condition: '<>', data: 'No' }] } },
      ],
    },
  });

  it('parses nested groups and lists conditions with positions', () => {
    expect(ruleConditions(rule).map((c) => [c.field, c.condition, c.at])).toEqual([
      ['Acme_Pays__c', '=', 'rules[0]'],
      ['age', '>=', 'rules[1].rules[0]'],
      ['flag ', '<>', 'rules[1].rules[1]'],
    ]);
  });

  it('evaluates three-valued', () => {
    const known = (m: Record<string, unknown>) => (f: string) =>
      f in m ? { known: true as const, value: m[f] } : { known: false as const };
    expect(evaluateShowRule(rule, known({ Acme_Pays__c: 'Yes', age: '70' }))).toBe('true');
    expect(evaluateShowRule(rule, known({ Acme_Pays__c: 'No' }))).toBe('false');
    expect(evaluateShowRule(rule, known({ Acme_Pays__c: 'Yes', age: '40' }))).toBe('unknown');
    expect(evaluateShowRule(null, known({}))).toBe('true');
  });
});

describe('evaluateFormula', () => {
  const lookup = (m: Record<string, unknown>) => (p: string) =>
    p in m ? { known: true as const, value: m[p] } : { known: false as const };

  it('evaluates a typical IP execution condition', () => {
    const f = '%step% == 2 && ISNOTBLANK(%Details%)';
    expect(evaluateFormula(f, lookup({ step: '2', Details: [{ a: 1 }] })).truth).toBe('true');
    expect(evaluateFormula(f, lookup({ step: '3', Details: [{ a: 1 }] })).truth).toBe('false');
    expect(evaluateFormula(f, lookup({ step: '2' })).truth).toBe('unknown');
    expect(evaluateFormula(f, lookup({ step: '3' })).truth).toBe('false');
    expect(evaluateFormula(f, lookup({})).refs.map((r) => r.raw)).toEqual(['step', 'Details']);
  });

  it('handles OR chains, keywords and IF', () => {
    const f = '%step% == 8 || %step% == 9 OR NOT(ISBLANK(%x%))';
    expect(evaluateFormula(f, lookup({ step: 9 })).truth).toBe('true');
    expect(evaluateFormula('IF(%a% == 1, true, false)', lookup({ a: 1 })).truth).toBe('true');
  });

  it('is UNKNOWN, never a guess, on what it does not evaluate', () => {
    expect(evaluateFormula('%a% + 1 == 2', lookup({ a: 1 })).truth).toBe('unknown');
    expect(evaluateFormula('AGE(%dob%) >= 65', lookup({ dob: '1950-01-01' })).truth).toBe('unknown');
    expect(evaluateFormula('%unterminated', lookup({})).parseError).not.toBeNull();
  });

  it('evaluates CONTAINS over text, multi-select values and lists, and its four-argument form', () => {
    expect(evaluateFormula('CONTAINS(%a%, "Health")', lookup({ a: 'Food;Health care' })).truth).toBe('true');
    expect(evaluateFormula('CONTAINS(%a%, "Health")', lookup({ a: 'Food' })).truth).toBe('false');
    expect(evaluateFormula('CONTAINS(%a%, "Health")', lookup({ a: ['Health', 'Food'] })).truth).toBe('true');
    expect(evaluateFormula('CONTAINS(%a%, "Health")', lookup({})).truth).toBe('unknown');
    expect(evaluateFormula('CONTAINS(%a%, "x", "in", "out")', lookup({ a: 'xyz' })).value).toEqual({ known: true, value: 'in' });
  });

  it('returns the computed value beside its truth', () => {
    expect(evaluateFormula('IF(%a% == 1, "One", "Other")', lookup({ a: 1 })).value).toEqual({ known: true, value: 'One' });
    expect(evaluateFormula('%a% + 1', lookup({ a: 1 })).value).toEqual({ known: false });
  });
});

describe('taxonomy', () => {
  it('classifies element roles', () => {
    expect(elementRole('Edit Block')).toBe('container');
    expect(elementRole('Radio')).toBe('input');
    expect(elementRole('Formula')).toBe('formula');
    expect(elementRole('Set Values')).toBe('setValues');
    expect(elementRole('Custom Lightning Web Component')).toBe('customLwc');
    expect(elementRole('Integration Procedure Action')).toBe('action');
    expect(elementRole('Text Block')).toBe('display');
    expect(elementRole('Some Future Action')).toBe('action');
    expect(elementRole('Some Future Input')).toBe('input');
  });

  it('detects repeating containers and edit-block actions', () => {
    const base = {
      name: 'x',
      level: 0,
      sequence: 0,
      isActive: true,
      configError: null,
      path: ['x'],
      idPath: 'x',
      line: null,
      documentIndex: 0,
      children: [],
    };
    expect(isRepeating({ ...base, type: 'Edit Block', canonicalType: 'Edit Block', config: null })).toBe(true);
    expect(isRepeating({ ...base, type: 'Block', canonicalType: 'Block', config: { repeat: true } })).toBe(true);
    expect(isRepeating({ ...base, type: 'Block', canonicalType: 'Block', config: { repeat: false } })).toBe(false);
    expect(editBlockActionKind('LineEditBlock', 'LineEditBlock-Delete')).toBe('Delete');
    expect(editBlockActionKind('LineEditBlock', 'OtherEditBlock-Delete')).toBeNull();
  });
});
