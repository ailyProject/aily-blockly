/**
 * Playwright <-> Electron 主进程桥接工具。
 *
 * 核心依赖 app.evaluate：它把回调丢进主进程上下文执行，
 * 可直接拿到 ipcMain/BrowserWindow/fs 等。
 *
 * 也封装了 test-hooks 暴露的 __test:* IPC 便捷调用。
 */

import type { ElectronApplication, Page } from 'playwright';

export async function getAppState(app: ElectronApplication) {
  return app.evaluate(async ({ ipcMain, BrowserWindow, app: electronApp }) => {
    const wins = BrowserWindow.getAllWindows();
    const win = wins.find((w) => !w.isDestroyed());
    if (!win) return { ready: false } as any;
    return {
      ready: true,
      url: win.webContents.getURL(),
      title: win.getTitle(),
      isVisible: win.isVisible(),
      userDataPath: electronApp.getPath('userData'),
      version: electronApp.getVersion(),
      pid: process.pid,
    };
  });
}

/**
 * 预置一次 dialog.show*Dialog 的返回值。
 * 例如：mockDialog(app, 'showOpenDialog', { canceled:false, filePaths:[tmpDir] })
 */
export async function mockDialog(
  app: ElectronApplication,
  method:
    | 'showOpenDialog'
    | 'showOpenDialogSync'
    | 'showSaveDialog'
    | 'showSaveDialogSync'
    | 'showMessageBox'
    | 'showMessageBoxSync',
  result: any
) {
  return app.evaluate(
    async ({ dialog }, payload) => {
      const m = payload.method;
      const r = payload.result;
      const original = (dialog as any)[m];
      (dialog as any)[m] = async function () {
        (dialog as any)[m] = original;
        const isSync = m.endsWith('Sync');
        return isSync ? r : r;
      };
      return { queued: 1 };
    },
    { method, result }
  );
}

/**
 * 通过 test-hooks 注入的 IPC 发送 set-config 事件给渲染进程。
 * 渲染端需监听 `test:set-config` IPC。
 */
export async function setRendererConfig(
  app: ElectronApplication,
  config: Record<string, any>
) {
  return app.evaluate(async ({ BrowserWindow }, cfg) => {
    const wins = BrowserWindow.getAllWindows();
    const win = wins.find((w) => !w.isDestroyed());
    if (!win) return { sent: false };
    win.webContents.send('test:set-config', cfg);
    return { sent: true };
  }, config);
}

/**
 * 在主进程执行任意 IPC handler（通过 app.evaluate 直接调用模块函数更可靠）。
 * 这里提供一个通用工具：通过 ipcRenderer from mainWindow 转发。
 */
export async function invokeIpcFromRenderer(
  page: Page,
  channel: string,
  ...args: any[]
): Promise<any> {
  return page.evaluate(
    async ({ channel, args }) => {
      const api: any = (window as any).electronAPI;
      if (!api?.ipcRenderer?.invoke) {
        throw new Error('electronAPI.ipcRenderer.invoke not available');
      }
      // 渲染端的 invoke 只传 (channel, data) 单参数；这里对 args[0] 做传递
      return api.ipcRenderer.invoke(channel, args.length === 1 ? args[0] : args);
    },
    { channel, args }
  );
}
