import type { SubappManagerService } from '@integration/subapps/public-api';

/** Recovery changes the managed package only; it never opens, closes or starts a runtime. */
export async function recoverChildAppCapabilities(
  manager: Pick<SubappManagerService, 'refresh' | 'state' | 'repair'>,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = params['action'];
  const toolId = typeof params['toolId'] === 'string' ? params['toolId'].trim() : '';
  if (!['refresh', 'repair'].includes(String(action)) || (action === 'repair' && !toolId)) {
    return { ok: false, code: 'SUBAPP_RECOVERY_INVALID', error: 'Use action=refresh, or action=repair with a toolId from child_app_list.' };
  }
  try {
    await manager.refresh(false);
    const items = manager.state.apps.filter(item => !toolId || item.toolId === toolId);
    if (toolId && items.length !== 1) {
      return { ok: false, code: 'SUBAPP_RECOVERY_TARGET_UNKNOWN', error: 'The managed catalog has no unique matching toolId. Call child_app_list; do not guess an install path.' };
    }
    const result = action === 'repair' ? await manager.repair(items[0].id) : { ok: true };
    return { ...result, operation: 'child_app_recover', action,
      ...(toolId ? { toolId } : {}), installRoot: manager.state.installRoot,
      apps: manager.state.apps.filter(item => !toolId || item.toolId === toolId).map(item => ({
        toolId: item.toolId, packageName: item.packageName, installedVersion: item.installedVersion,
        installPath: item.installPath, installed: item.installed, installError: item.installError,
      })) };
  } catch (error) {
    return { ok: false, operation: 'child_app_recover', action, toolId,
      code: (error as { code?: string })?.code || 'SUBAPP_RECOVERY_FAILED',
      error: error instanceof Error ? error.message : String(error),
      recovery: { tool: 'child_app_recover', arguments: { action: 'refresh', ...(toolId ? { toolId } : {}) } } };
  }
}
