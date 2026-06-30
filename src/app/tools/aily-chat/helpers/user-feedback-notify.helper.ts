/**
 * 当聊天流程需要用户在界面内操作（确认工具、回答问题、点击按钮），
 * 而应用窗口不在前台时，通过宿主 Electron：
 * - 任务栏闪烁 / Dock 弹跳与角标（持久视觉线索，不依赖通知气泡时长）
 * - 系统通知（尽量改为 macOS 不自动消失、Linux 高 urgency，减少「一闪而过」）
 */

import { AilyHost } from '../core/host';
import type { IAilyHostAPI } from '../core/host-api';

/** 宿主透传的 ElectronService：notify / 窗口状态 / 请求注意 */
type ElectronPassthrough = {
  isElectron?: boolean;
  isWindowFocused?: () => boolean;
  isWindowMinimized?: () => boolean;
  notify?: (title: string, body: string, options?: DesktopNotifyOptions) => Promise<unknown>;
  requestWindowAttention?: () => Promise<{ success?: boolean }>;
};

/** 与 Electron `notification.show` / Notification 构造函数对齐的可选字段 */
type DesktopNotifyOptions = {
  silent?: boolean;
  timeoutType?: 'default' | 'never';
  urgency?: 'normal' | 'critical' | 'low';
};

/**
 * 按平台拼通知选项：延长可见时间、提高优先级（尽量不吵但更显眼）。
 */
function buildDesktopNotifyOptions(host: IAilyHostAPI): DesktopNotifyOptions {
  const plat = host.platform;
  const opts: DesktopNotifyOptions = {
    // 允许系统播放默认提示音（若用户未全局静音）
    silent: false,
    // 仅 macOS 生效：通知保留在通知中心直到用户处理，避免一闪即关
    timeoutType: 'never',
  };
  // Linux（尤其是 GNOME）用 urgency 提升可见度
  if (plat.isLinux) {
    opts.urgency = 'critical';
  }
  return opts;
}

/**
 * 判断 Aily IDE 窗口是否在前台可操作状态。
 * - Electron：需同时处于聚焦且未最小化（用户在其它应用时也应提醒）。
 */
export function isAilyChatAppForeground(): boolean {
  try {
    const electron = AilyHost.get()?.electron as ElectronPassthrough | undefined;
    if (electron?.isElectron) {
      const focused = electron.isWindowFocused?.() ?? false;
      const minimized = electron.isWindowMinimized?.() ?? false;
      return focused && !minimized;
    }
  } catch {
    /* 宿主异常时不阻断聊天 */
  }

  // 浏览器 / 预览：用 document.hasFocus 近似前台
  if (typeof document !== 'undefined') {
    return document.hasFocus();
  }
  return true;
}

/**
 * 非前台时：先请求窗口级注意（任务栏/Dock），再发系统通知。
 * 即使气泡式通知被系统快速收起，用户仍能看到闪烁或角标。
 */
export function notifyAwaitingUserFeedbackIfBackground(title: string, body: string): void {
  if (isAilyChatAppForeground()) {
    return;
  }

  const host = AilyHost.get();
  const electron = host?.electron as ElectronPassthrough | undefined;

  // 1) 主进程侧视觉提醒（与 toast 时长无关）
  if (electron?.requestWindowAttention) {
    void electron.requestWindowAttention().catch(() => undefined);
  } else if (typeof window !== 'undefined' && (window as unknown as { iWindow?: { requestAttention?: () => Promise<unknown> } }).iWindow?.requestAttention) {
    void (window as unknown as { iWindow: { requestAttention: () => Promise<unknown> } }).iWindow.requestAttention().catch(() => undefined);
  }

  if (!electron?.notify) {
    return;
  }

  const opts = buildDesktopNotifyOptions(host);
  void electron.notify(title, body, opts).catch((err: unknown) => {
    console.warn('[notifyAwaitingUserFeedbackIfBackground]', err);
  });
}
