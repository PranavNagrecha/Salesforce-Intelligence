/// <reference types="vitest/globals" />

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { classifyQuestion, type Plane } from '../src/intent-router.js';

// Load the fixture from the eval directory
const loadFixture = () => {
  try {
    const fixturePath = join(dirname(__filename), '../../..', 'eval', 'access-surface.cases.json');
    const content = readFileSync(fixturePath, 'utf8');
    return JSON.parse(content) as {
      _about: string;
      cases: Array<{
        id: string;
        query: string;
        expect: 'routes' | 'unrouted-gap';
        intent: string;
        plane: Plane;
        tools: string[];
        gap: string | null;
        note: string;
      }>;
    };
  } catch (error) {
    throw new Error(`Failed to load access-surface.cases.json fixture: ${error instanceof Error ? error.message : String(error)}`);
  }
};

interface AssertionResult {
  id: string;
  query: string;
  passed: boolean;
  expected: {
    expect: string;
    intent: string;
    plane: Plane;
    gap: string | null;
  };
  actual: {
    intent: string;
    plane: Plane;
    gap: string | null;
  };
  message?: string;
}

const assertCase = (caseItem: {
  id: string;
  query: string;
  expect: 'routes' | 'unrouted-gap';
  intent: string;
  plane: Plane;
  tools: string[];
  gap: string | null;
  note: string;
}): AssertionResult => {
  const result = classifyQuestion(caseItem.query);
  
  const expected = {
    expect: caseItem.expect,
    intent: caseItem.intent,
    plane: caseItem.plane,
    gap: caseItem.gap,
  };
  
  const actual = {
    intent: result.intent,
    plane: result.plane,
    gap: result.gap?.category ?? null,
  };
  
  // Validate intent
  const intentMatches = actual.intent === expected.intent;
  
  // Validate plane
  const planeMatches = actual.plane === expected.plane;
  
  // Validate gap consistency with the expect value
  let gapMatches = true;
  if (caseItem.expect === 'routes') {
    // Routes can have a gap (honest-gap cases) or no gap (regular routes)
    // The gap should match exactly
    gapMatches = actual.gap === expected.gap;
  } else if (caseItem.expect === 'unrouted-gap') {
    // Unrouted-gap cases must have a gap present
    gapMatches = actual.gap !== null;
  }
  
  const passed = intentMatches && planeMatches && gapMatches;
  
  const message = passed
    ? undefined
    : [
        !intentMatches && `intent mismatch: expected '${expected.intent}', got '${actual.intent}'`,
        !planeMatches && `plane mismatch: expected '${expected.plane}', got '${actual.plane}'`,
        !gapMatches && `gap mismatch: expected gap=${JSON.stringify(expected.gap)}, got gap=${JSON.stringify(actual.gap)}`,
      ]
        .filter(Boolean)
        .join('; ');
  // Omit `message` entirely when passing — exactOptionalPropertyTypes forbids
  // assigning `undefined` to an optional field.
  return {
    id: caseItem.id,
    query: caseItem.query,
    passed,
    expected,
    actual,
    ...(message !== undefined ? { message } : {}),
  };
};

describe('access-surface regression fixture', () => {
  const fixture = loadFixture();
  
  it('loads the fixture correctly', () => {
    expect(fixture.cases).toBeDefined();
    expect(fixture.cases.length).toBeGreaterThan(0);
  });
  
  // Test each case individually so failures are isolated
  fixture.cases.forEach((caseItem) => {
    it(`case: ${caseItem.id} — ${caseItem.query}`, () => {
      const assertion = assertCase(caseItem);
      
      if (!assertion.passed) {
        throw new Error(
          `${caseItem.id} failed: ${assertion.message}\n` +
          `Note: ${caseItem.note}`
        );
      }
      
      // All assertions passed
      expect(assertion.passed).toBe(true);
    });
  });
  
  // Summary: assert all cases pass
  it('all cases pass', () => {
    const results = fixture.cases.map(assertCase);
    const failures = results.filter((r) => !r.passed);
    
    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  ${f.id}: ${f.message}`)
        .join('\n');
      throw new Error(`${failures.length} case(s) failed:\n${summary}`);
    }
    
    expect(failures).toEqual([]);
  });
});
