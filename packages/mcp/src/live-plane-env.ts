/**
 * The operator env switch for the live plane (`SFI_LIVE_PLANE_ENABLED=1|true`).
 *
 * A dependency-free leaf so both the live-plane consent seam
 * (`tools/live-plane.ts`) and the vault-only router (`route-question.ts`, which
 * must not import the seam — see plane-import-guard.test.ts) read ONE
 * definition of "switched on".
 */
export const isLivePlaneEnvEnabled = (): boolean => {
  const env = process.env['SFI_LIVE_PLANE_ENABLED'];
  return env === '1' || env === 'true';
};
