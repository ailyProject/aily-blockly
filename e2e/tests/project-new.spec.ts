import { test, expect, getMainWindow, navigate } from '../fixtures/electron-app';

/**
 * Phase 2 —— 新建项目流程。
 *
 * 完整「创建项目」依赖本地已安装的开发板包（npm）与文件系统写入，
 * 在干净的测试环境中不一定具备。因此本套件：
 *  - 默认验证「新建项目向导」能正确加载并渲染（开发板搜索、品牌列表）；
 *  - 当确实加载出开发板时，额外验证可以选中一个开发板进入下一步。
 */
test.describe('新建项目流程', () => {
  test('应能打开新建项目向导', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await navigate(win, '/main/project-new');

    await expect(win.locator('app-project-new .project-new-box')).toBeVisible();
    // 第 0 步：开发板搜索输入 + 品牌列表。
    await expect(win.locator('app-project-new input[nz-input]')).toBeVisible();
    await expect(win.locator('app-project-new app-brand-list')).toBeVisible();
  });

  test('若已安装开发板包，选中开发板后应能进入下一步', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await navigate(win, '/main/project-new');

    const boards = win.locator('app-project-new .board-selector .board.ccenter.btn');
    // 等待品牌/开发板异步加载（最多 10s）。
    await win
      .waitForFunction(
        () =>
          document.querySelectorAll('app-project-new .board-selector .board.ccenter.btn').length > 0,
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => {});

    const count = await boards.count();
    test.skip(count === 0, '当前环境未安装任何开发板包，跳过开发板选择校验。');

    await boards.first().click();
    // 选中后右侧出现开发板描述与「使用此开发板」按钮。
    await expect(win.locator('app-project-new .desc-box')).toBeVisible();
  });
});
