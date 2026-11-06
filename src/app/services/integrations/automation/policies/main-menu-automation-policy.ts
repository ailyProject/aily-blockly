import type { UiAutomationCommandResult } from '../ui-automation-registry.service';

export const HOST_EXIT_REQUIRES_USER_REASON = 'host_exit_requires_user';
export const HOST_EXIT_REQUIRES_USER_MESSAGE =
  '当前 Agent 会话依赖主软件进程，不能通过自动化退出。请在任务结束后由用户从主软件界面手动退出；不得使用 kill、pkill 或 killall 绕过。';

export function mainMenuAutomationRejection(
  action: string | undefined,
  itemId: string,
): UiAutomationCommandResult | null {
  if (action === 'project-save-as' || action === 'project-save') return {
    ok: false, operation: 'main_menu_execute', itemId, action,
    code: action === 'project-save-as' ? 'PROJECT_RECOVERY_IN_PLACE_REQUIRED' : 'PROJECT_SAVE_REQUIRES_TOOL',
    reason: action === 'project-save-as' ? 'project_copy_requires_user_intent' : 'project_save_requires_candidate_preservation',
    requiresUserAction: false, retryable: false, commandDispatched: false,
    nextAction: { tool: action === 'project-save-as' ? 'project_recover' : 'project_save',
      ...(action === 'project-save-as' ? { input: { action: 'inspect' } } : {}) },
    message: action === 'project-save-as'
      ? '自动恢复必须留在当前项目；系统保存内部恢复版本，不得要求用户打开或切换副本。'
      : '请使用当前项目的 project_save 工具，系统会先保留待应用的 ABS 草稿再保存当前画布。',
  };
  if (action !== 'app-exit') {
    return null;
  }

  return {
    ok: false,
    operation: 'main_menu_execute',
    itemId,
    action,
    reason: HOST_EXIT_REQUIRES_USER_REASON,
    requiresUserAction: true,
    retryable: false,
    message: HOST_EXIT_REQUIRES_USER_MESSAGE,
  };
}
