import { test, expect, getMainWindow } from '../fixtures/electron-app';

/**
 * Phase 2（landing）—— 指南/主页。
 *
 * 应用默认进入 /main/guide。验证指南页渲染出入口菜单（新建/打开项目、
 * 项目中心、AI 助手），这些按钮来自 menu.config 的 GUIDE_MENU。
 */
test.describe('指南主页', () => {
  test('应渲染指南页与入口菜单', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);

    await expect(win.locator('app-guide .guide-box')).toBeVisible();
    // 入口菜单按钮（新建项目 / 打开项目 / 项目中心 / AI 助手）。
    const menuButtons = win.locator('app-guide .menu-box .btn.link');
    await expect(menuButtons.first()).toBeVisible();
    expect(await menuButtons.count()).toBeGreaterThan(0);
  });

  test('应显示版本号', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await expect(win.locator('app-guide .version')).toContainText('ver');
  });
});
