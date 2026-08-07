/**
 * AsyncLocalStorage for the active live grant disclosure.
 *
 * Lives in a leaf module so `live-exec` (auth/REST) and `live-plane` (gate)
 * can share the same store without a cycle through `live-session`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { LiveGrantDisclosure } from '../live-consent.js';

const LIVE_GRANT_ALS = new AsyncLocalStorage<LiveGrantDisclosure | null>();

/** Bind the active grant for the current async context (called by gateLive). */
export const enterLiveGrant = (grant: LiveGrantDisclosure | null): void => {
  LIVE_GRANT_ALS.enterWith(grant);
};

/** Read the grant bound by {@link enterLiveGrant}, if any. */
export const getActiveLiveGrant = (): LiveGrantDisclosure | null =>
  LIVE_GRANT_ALS.getStore() ?? null;
