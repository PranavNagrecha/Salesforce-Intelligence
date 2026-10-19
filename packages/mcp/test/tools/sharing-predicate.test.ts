/// <reference types="vitest/globals" />

import { renderSharingPredicate } from '../../src/tools/sharing-predicate.js';

const rule = (properties: Record<string, unknown>) => ({ properties });

describe('renderSharingPredicate', () => {
  it('AND-joins criteriaItems when the rule has no booleanFilter (one criterion)', () => {
    expect(
      renderSharingPredicate(
        rule({ booleanFilter: null, criteriaItems: [{ field: 'CreatedById', operation: 'startsWith', value: '005' }] }),
      ),
    ).toBe('CreatedById startsWith 005');
  });

  it('AND-joins several criteria when there is no custom logic', () => {
    expect(
      renderSharingPredicate(
        rule({
          criteriaItems: [
            { field: 'Status__c', operation: 'equals', value: 'Open' },
            { field: 'Amount__c', operation: 'greaterThan', value: '1000' },
          ],
        }),
      ),
    ).toBe('Status__c equals Open AND Amount__c greaterThan 1000');
  });

  it('substitutes each criterion into the booleanFilter custom logic', () => {
    expect(
      renderSharingPredicate(
        rule({
          booleanFilter: '1 AND (2 OR 3)',
          criteriaItems: [
            { field: 'Status__c', operation: 'equals', value: 'Open' },
            { field: 'Region__c', operation: 'equals', value: 'EMEA' },
            { field: 'Region__c', operation: 'equals', value: 'APAC' },
          ],
        }),
      ),
    ).toBe('Status__c equals Open AND (Region__c equals EMEA OR Region__c equals APAC)');
  });

  it('does not renumber the logic when the extractor skipped a criterion', () => {
    expect(
      renderSharingPredicate(
        rule({
          booleanFilter: '1 AND (2 OR 3)',
          criteriaItemCount: 3,
          criteriaItems: [
            { field: 'Status__c', operation: 'equals', value: 'Open' },
            { field: 'Region__c', operation: 'equals', value: 'APAC' },
          ],
        }),
      ),
    ).toBe('1 AND (2 OR 3) over 2 of 3 criteria extracted: Status__c equals Open; Region__c equals APAC');
  });

  it('renders a value-less criterion (null / not-null operations) without a dangling value', () => {
    expect(
      renderSharingPredicate(rule({ criteriaItems: [{ field: 'Owner__c', operation: 'notEqual', value: null }] })),
    ).toBe('Owner__c notEqual');
  });

  it('falls back to the raw booleanFilter when a vault predates criteriaItems', () => {
    expect(renderSharingPredicate(rule({ booleanFilter: '1 AND 2', criteriaItemCount: 2 }))).toBe('1 AND 2');
  });

  it('says "(predicate not extracted)" only when the node has neither', () => {
    expect(renderSharingPredicate(rule({ booleanFilter: null, criteriaItems: [] }))).toBe('(predicate not extracted)');
    expect(renderSharingPredicate(rule({}))).toBe('(predicate not extracted)');
  });
});
