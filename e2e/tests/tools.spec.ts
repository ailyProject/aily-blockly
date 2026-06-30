import { test, expect, getMainWindow, navigate } from '../fixtures/electron-app';

/**
 * Phase 4 —— 串口监视器与终端工具。
 *
 * 这两个工具在「无真实硬件设备」时也应能正常渲染 UI：
 *  - 串口监视器：作为独立路由 /serial-monitor 渲染（同一渲染组件）。
 *  - 终端：位于主窗口底部面板，通过 footer 终端按钮打开（xterm 初始化）。
 */
test.describe('串口监视器 & 终端工具', () => {
  test('串口监视器 UI 应能在无设备时渲染', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await navigate(win, '/serial-monitor');

    await expect(win.locator('app-serial-monitor')).toBeVisible();
    // 独立路由下工具以 app-sub-window 容器渲染（sider 内则为 app-tool-container）。
    await expect(win.locator('app-serial-monitor app-sub-window')).toBeVisible();
    await expect(win.locator('app-serial-monitor .window-box')).toBeVisible();
  });

  test('点击底部终端按钮应打开终端面板并初始化 xterm', async ({ mainWindow }) => {
    // footer 终端按钮：图标 fa-square-terminal。
    const terminalBtn = mainWindow.locator('app-footer .footer-box .btn.ccenter', {
      has: mainWindow.locator('i.fa-square-terminal'),
    });
    await expect(terminalBtn).toBeVisible();
    await terminalBtn.click();

    // 底部面板出现，终端组件与 xterm 容器渲染。
    await expect(mainWindow.locator('app-terminal')).toBeVisible();
    await expect(mainWindow.locator('app-terminal .xterm')).toBeVisible({ timeout: 15_000 });
  });
});
