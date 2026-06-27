/// <reference types="vitest/globals" />

import {
  clampedNodeScanLimit,
  NODE_SCAN_HARD_CAP,
  nodeScanLimit,
  scanHitCap,
  scanTruncationNote,
} from '../../src/tools/scan-cap.js';

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

  // CR-RV10: nodeScanLimit is UNCLAMPED (an operator can set it > 500);
  // clampedNodeScanLimit is what every scan FETCH must use so the graph's
  // LIST_MAX_LIMIT(500) is never exceeded (which would hard-error the tool).
  it('clampedNodeScanLimit caps at the graph hard cap (CR-RV10)', () => {
    expect(NODE_SCAN_HARD_CAP).toBe(500);
    expect(clampedNodeScanLimit()).toBe(500);
    process.env['SFI_NODE_SCAN_LIMIT'] = '600';
    expect(nodeScanLimit()).toBe(600); // raw is unclamped
    expect(clampedNodeScanLimit()).toBe(500); // fetch is clamped
    process.env['SFI_NODE_SCAN_LIMIT'] = '10';
    expect(clampedNodeScanLimit()).toBe(10); // below the cap is untouched
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

  // CR-RV10 honesty (design-check BLOCKER #3): once a tool clamps its fetch, the
  // note must quote the EFFECTIVE clamped limit, NOT the raw nodeScanLimit().
  it('the truncation note quotes the EFFECTIVE clamped limit, not the raw env value', () => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '10000';
    // A clamped caller fetches 500 and passes that as the effective limit.
    const note = scanTruncationNote(['Profile'], clampedNodeScanLimit());
    expect(note).toMatch(/capped at 500/);
    expect(note).not.toMatch(/10000/);
  });
});
