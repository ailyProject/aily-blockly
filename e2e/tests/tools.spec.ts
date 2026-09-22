import { test, expect, navigate } from '../fixtures/electron-app';

/**
 * Phase 4 —— 终端工具与底部面板。
 *
 * 终端位于主窗口底部面板，通过 footer 终端按钮打开（xterm 初始化）。
 */
test.describe('终端工具', () => {
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

  test('bottom panel should resize routed pages instead of covering them', async ({ mainWindow }) => {
    const terminalBtn = mainWindow.locator('app-footer .footer-box .btn.ccenter', {
      has: mainWindow.locator('i.fa-square-terminal'),
    });

    await navigate(mainWindow, '/main/project-new');
    await expect(mainWindow.locator('app-project-new .project-new-box')).toBeVisible();
    await terminalBtn.click();
    await expect(mainWindow.locator('.resizable-box')).toBeVisible();

    const expectAboveBottomPanel = async (selector: string) => {
      await expect
        .poll(async () => {
          const contentBox = await mainWindow.locator(selector).boundingBox();
          const bottomPanelBox = await mainWindow.locator('.resizable-box').boundingBox();
          if (!contentBox || !bottomPanelBox) {
            return Number.POSITIVE_INFINITY;
          }

          return contentBox.y + contentBox.height - bottomPanelBox.y;
        })
        .toBeLessThanOrEqual(1);
    };

    await expectAboveBottomPanel('app-project-new .project-new-box');

    await navigate(mainWindow, '/main/playground/list');
    await expect(mainWindow.locator('app-playground .lib-manager-box')).toBeVisible();
    await expect(mainWindow.locator('app-example-list .content-box')).toBeVisible();
    await expectAboveBottomPanel('app-example-list .content-box');
    await expectAboveBottomPanel('app-example-list .pagination');
  });
});
