import type { UiAutomationCommandResult } from '../ui-automation-registry.service';

export const HOST_EXIT_REQUIRES_USER_REASON = 'host_exit_requires_user';
export const HOST_EXIT_REQUIRES_USER_MESSAGE =
  '当前 Agent 会话依赖主软件进程，不能通过自动化退出。请在任务结束后由用户从主软件界面手动退出；不得使用 kill、pkill 或 killall 绕过。';

export function mainMenuAutomationRejection(
  action: string | undefined,
  itemId: string,
): UiAutomationCommandResult | null {
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
