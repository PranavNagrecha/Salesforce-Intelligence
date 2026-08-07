/**
 * Hermetic live-plane grant for unit tests (AUDIT-F3).
 * Writes a v2 consent record with OrgId+principal+all scopes so handlers
 * that no longer accept `liveEnabled: true` as consent still run.
 */

import { grantLiveConsent, type LiveScope, LIVE_SCOPES } from '../../src/live-consent.js';

const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

export const TEST_ORG_ID = '00D000000000001AAA';
export const TEST_PRINCIPAL = 'test-user@example.com';

export const grantTestLiveAccess = async (
  org: string,
  scopes: readonly LiveScope[] = LIVE_SCOPES,
): Promise<void> => {
  const r = await grantLiveConsent(org, {
    orgId: TEST_ORG_ID,
    principalUsername: TEST_PRINCIPAL,
    scopes,
    expiresAt: FAR_FUTURE,
    grantId: 'test-grant',
  });
  if (!r.ok) {
    throw new Error(`grantTestLiveAccess failed: ${r.error.message}`);
  }
};
