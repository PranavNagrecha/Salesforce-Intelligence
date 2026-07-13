import { describe, expect, it } from 'vitest';

import {
  gradeFromFindingCount,
  securityPostureMetricsFromFindingCount,
} from '../../src/tools/security-posture-metric.js';

describe('security-posture-metric (R8-SECURITY-TREND)', () => {
  it('grades finding counts like the retired org_scorecard Security dimension', () => {
    expect(gradeFromFindingCount(0)).toBe('A');
    expect(gradeFromFindingCount(1)).toBe('B');
    expect(gradeFromFindingCount(2)).toBe('B');
    expect(gradeFromFindingCount(3)).toBe('C');
    expect(gradeFromFindingCount(5)).toBe('C');
    expect(gradeFromFindingCount(6)).toBe('D');
    expect(gradeFromFindingCount(10)).toBe('D');
    expect(gradeFromFindingCount(11)).toBe('F');
  });

  it('maps grades to securityScore 0–100 and securityGrade GPA', () => {
    expect(securityPostureMetricsFromFindingCount(0)).toEqual({
      securityScore: 100,
      securityGrade: 4,
    });
    expect(securityPostureMetricsFromFindingCount(2)).toEqual({
      securityScore: 75,
      securityGrade: 3,
    });
    expect(securityPostureMetricsFromFindingCount(11)).toEqual({
      securityScore: 0,
      securityGrade: 0,
    });
  });
});
