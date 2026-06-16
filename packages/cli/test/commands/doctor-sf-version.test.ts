/// <reference types="vitest/globals" />

import { isLegacySfdxToolbelt, parseSfCliVersion } from '../../src/commands/doctor.js';

describe('parseSfCliVersion', () => {
  it('extracts major.minor.patch from a real sf version line', () => {
    expect(parseSfCliVersion('@salesforce/cli/2.103.7 darwin-arm64 node-v20.11.0')).toEqual([2, 103, 7]);
  });

  it('returns null when no version is present', () => {
    expect(parseSfCliVersion('some unrelated text')).toBeNull();
  });
});

describe('isLegacySfdxToolbelt', () => {
  it('flags the legacy standalone sfdx-cli (v7) by product name, not number', () => {
    // 7 > 2 numerically, so only a NAME-based check catches this.
    expect(isLegacySfdxToolbelt('sfdx-cli/7.209.6 darwin-x64 node-v18')).toBe(true);
  });

  it('passes the modern unified CLI', () => {
    expect(isLegacySfdxToolbelt('@salesforce/cli/2.103.7 darwin-arm64 node-v20')).toBe(false);
    expect(isLegacySfdxToolbelt('@salesforce/cli/2.0.0 linux-x64 node-v20')).toBe(false);
  });

  it('does not warn on an unrecognised version line (no false positive)', () => {
    expect(isLegacySfdxToolbelt('Salesforce CLI (unknown build)')).toBe(false);
  });
});
