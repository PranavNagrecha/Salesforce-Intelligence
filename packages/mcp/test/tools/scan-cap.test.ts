/// <reference types="vitest/globals" />

import { nodeScanLimit, scanHitCap, scanTruncationNote } from '../../src/tools/scan-cap.js';

describe('scan-cap (P12-HONESTY-scan-cap-disclosure)', () => {
  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('defaults the node-scan cap to 500', () => {
    expect(nodeScanLimit()).toBe(500);
  });

  it('honors SFI_NODE_SCAN_LIMIT (positive integer) and ignores garbage', () => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '3';
    expect(nodeScanLimit()).toBe(3);
    process.env['SFI_NODE_SCAN_LIMIT'] = '0';
    expect(nodeScanLimit()).toBe(500);
    process.env['SFI_NODE_SCAN_LIMIT'] = 'nope';
    expect(nodeScanLimit()).toBe(500);
  });

  it('scanHitCap is true only at/above the cap', () => {
    expect(scanHitCap(499, 500)).toBe(false);
    expect(scanHitCap(500, 500)).toBe(true);
    expect(scanHitCap(501, 500)).toBe(true);
  });

  it('the truncation note names the capped types and the cap, de-duplicated + sorted', () => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '500';
    const note = scanTruncationNote(['PermissionSet', 'Profile', 'Profile']);
    expect(note).toMatch(/capped at 500/);
    expect(note).toMatch(/PermissionSet \/ Profile/);
    expect(note).toMatch(/scanTruncated/);
  });
});
