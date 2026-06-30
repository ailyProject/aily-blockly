import { test, expect, getMainWindow } from '../fixtures/electron-app';

/**
 * Phase 1 —— 冒烟测试。
 *
 * 验证应用能够：
 *  - 启动 Electron 主进程并创建主窗口；
 *  - 主窗口渲染出主布局（app-main-window / app-header / app-footer）；
 *  - 正确暴露 Electron/Node 版本（经 preload 的 window.electronAPI.versions）；
 *  - 渲染进程不崩溃。
 */
test.describe('冒烟测试', () => {
  test('应用应能启动并显示主窗口', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await expect(win.locator('app-main-window')).toBeVisible();
  });

  test('应用标题应为 aily blockly', async ({ electronApp }) => {
    const title = await electronApp.evaluate(async ({ app }) => app.getName());
    expect(title).toBe('aily blockly');
  });

  test('主窗口应渲染头部与底部布局', async ({ mainWindow }) => {
    await expect(mainWindow.locator('app-header')).toBeVisible();
    await expect(mainWindow.locator('app-footer')).toBeVisible();
  });

  test('应通过 preload 暴露 Electron 版本信息', async ({ mainWindow }) => {
    const versions = await mainWindow.evaluate(() => {
      const api = (window as unknown as { electronAPI?: { versions?: () => NodeJS.ProcessVersions } }).electronAPI;
      return api?.versions?.() ?? null;
    });
    expect(versions).not.toBeNull();
    expect(versions?.electron).toBeTruthy();
    expect(versions?.node).toBeTruthy();
  });

  test('渲染进程不应崩溃', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);

    let crashed = false;
    await electronApp.evaluate(({ webContents }) => {
      // 仅做一次性注册，验证当前没有崩溃信号。
      return webContents.getAllWebContents().length;
    });

    win.on('crash', () => {
      crashed = true;
    });

    // 主布局已稳定渲染即视为未崩溃。
    await expect(win.locator('app-main-window')).toBeVisible();
    expect(crashed).toBe(false);
  });
});
