/// <reference types="vitest/globals" />

import {
  canonicalElementType,
  OMNI_ELEMENT_CATALOG,
  omniElementInfo,
} from '../src/omnistudio/catalog.js';
import { parseOmniProcess } from '../src/omnistudio/process.js';
import { elementRole, ipStepRole } from '../src/omnistudio/taxonomy.js';

/**
 * The OmniStudio element catalog is the single description every OmniStudio
 * analysis reads. These tests hold its invariants: every entry is complete,
 * no name is claimed twice, alternate spellings resolve to their canonical
 * type, and every element / step type seen in real OmniStudio orgs (and in the
 * documented OmniStudio element list) has an entry — a new type is caught here,
 * not discovered later as a silent "unknown".
 */

/** Element types observed in real OmniStudio metadata (OmniScripts and Integration Procedures). */
const OBSERVED_TYPES = [
  // OmniScript
  'Text Block', 'Custom Lightning Web Component', 'Block', 'Formula', 'Integration Procedure Action', 'Radio',
  'Navigate Action', 'Text', 'Step', 'Set Values', 'Select', 'Validation', 'Edit Block', 'Date', 'Currency',
  'Set Errors', 'Multi-select', 'Number', 'Checkbox', 'Remote Action', 'DataRaptor Extract Action', 'Telephone',
  'Text Area', 'Type Ahead Block', 'DataRaptor Transform Action', 'PDF Action', 'Email', 'OmniScript',
  'Calculation Action', 'Password', 'File', 'Headline', 'DataRaptor Post Action', 'Disclosure', 'Radio Group',
  // Integration Procedure
  'DataRaptor Post Action', 'Try Catch Block', 'Response Action', 'List Merge Action', 'Rest Action',
  'Conditional Block', 'Loop Block', 'Delete Action', 'Matrix Action', 'Cache Block',
];

describe('OmniStudio element catalog', () => {
  it('has a complete entry for every type: a role in at least one runtime, effects and a doc', () => {
    for (const e of OMNI_ELEMENT_CATALOG) {
      expect(e.runtimes.length, e.type).toBeGreaterThan(0);
      expect(e.scriptRole !== null || e.ipRole !== null, e.type).toBe(true);
      expect(e.runtimes.includes('omniscript'), e.type).toBe(e.scriptRole !== null);
      expect(e.runtimes.includes('integration-procedure'), e.type).toBe(e.ipRole !== null);
      expect(e.effects.length, e.type).toBeGreaterThan(0);
      expect(e.doc.length, e.type).toBeGreaterThan(10);
    }
  });

  it('never claims a name (type or alias) twice', () => {
    const seen = new Map<string, string>();
    for (const e of OMNI_ELEMENT_CATALOG) {
      for (const name of [e.type, ...e.aliases]) {
        const key = name.toLowerCase();
        expect(seen.get(key), `${name} claimed by ${seen.get(key)} and ${e.type}`).toBeUndefined();
        seen.set(key, e.type);
      }
    }
  });

  it('covers every element type observed in real OmniStudio metadata', () => {
    const missing = [...new Set(OBSERVED_TYPES)].filter((t) => omniElementInfo(t) === null);
    expect(missing).toEqual([]);
  });

  it('maps alternate spellings to their canonical type, and keeps unknown types as written', () => {
    expect(canonicalElementType('Data Mapper Extract Action')).toBe('DataRaptor Extract Action');
    expect(canonicalElementType('DataRaptor Load Action')).toBe('DataRaptor Post Action');
    expect(canonicalElementType('Rest Action')).toBe('HTTP Action');
    expect(canonicalElementType(' Try-Catch Block ')).toBe('Try Catch Block');
    expect(canonicalElementType('Some Future Widget')).toBe('Some Future Widget');
    expect(ipStepRole('Data Mapper Load Action')).toBe('dataMapper');
    expect(ipStepRole('Rest Action')).toBe('rest');
    expect(ipStepRole('Some Future Step')).toBe('other');
    expect(elementRole('Data Mapper Post Action')).toBe('action');
    expect(elementRole('Image')).toBe('display');
  });

  it('the parser keeps the spelling it found and adds the canonical type', () => {
    const parsed = parseOmniProcess(`<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
    <omniProcessElements>
        <isActive>true</isActive>
        <level>0.0</level>
        <name>LoadIt</name>
        <propertySetConfig>{}</propertySetConfig>
        <sequenceNumber>1.0</sequenceNumber>
        <type>Data Mapper Load Action</type>
    </omniProcessElements>
    <type>Acme</type>
    <subType>Load</subType>
</OmniIntegrationProcedure>`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const el = parsed.doc.elements[0];
    expect(el?.type).toBe('Data Mapper Load Action');
    expect(el?.canonicalType).toBe('DataRaptor Post Action');
  });
});
