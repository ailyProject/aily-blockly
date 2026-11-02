import { test, expect, getMainWindow } from '../fixtures/electron-app';

/**
 * Phase 2（landing）—— 指南/主页。
 *
 * 应用默认进入 /main/guide。验证指南页渲染出入口菜单（新建/打开项目、
 * 项目广场），这些按钮来自 menu.config 的 GUIDE_MENU。
 * AI 助手和应用商店由标题栏提供，完整引导通过 test:onboarding 验证。
 */
test.describe('指南主页', () => {
  test('应渲染指南页与入口菜单', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);

    await expect(win.locator('app-guide .guide-box')).toBeVisible();
    // 排除最近项目列表，首页保留三个菜单入口。
    const menuButtons = win.locator('app-guide .left-box > .menu-box').first().locator('.btn.link');
    await expect(menuButtons.first()).toBeVisible();
    await expect(menuButtons).toHaveCount(3);
    await expect(win.locator('app-header [data-onboarding="app-store"]')).toBeVisible();
  });

  test('应显示版本号', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await expect(win.locator('app-guide .version')).toContainText('ver');
  });
});
