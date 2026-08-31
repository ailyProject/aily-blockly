export const SERVICE_REGION_LOGIN_REASON = 'service-region-changed';

export interface ServiceRegionSwitchDependencies {
  closeProtectedTools: () => Promise<void>;
  clearLocalAuthSession: () => Promise<void>;
  stopProtectedRuntime: () => Promise<void>;
  setRegion: (regionKey: string) => Promise<void>;
  requestLogin: (reason: string) => void;
}

/**
 * Keep the region switch on the main-window auth/config instance. A region
 * change is a local context transition, so it must not call the server's
 * account-wide logout endpoint while a new-region login may be starting.
 */
export async function switchServiceRegionAndRequestLogin(
  regionKey: string,
  dependencies: ServiceRegionSwitchDependencies,
): Promise<void> {
  const normalizedRegionKey = regionKey.trim();
  if (!normalizedRegionKey) {
    throw new Error('Service region is required');
  }

  await dependencies.closeProtectedTools();

  // The first clear closes the authentication gate before stopping the old
  // runtime. The second removes any credential write-back that raced with the
  // stop operation. Clearing local auth is intentionally idempotent.
  await dependencies.clearLocalAuthSession();
  await dependencies.stopProtectedRuntime();
  await dependencies.clearLocalAuthSession();

  await dependencies.setRegion(normalizedRegionKey);
  dependencies.requestLogin(SERVICE_REGION_LOGIN_REASON);
}
