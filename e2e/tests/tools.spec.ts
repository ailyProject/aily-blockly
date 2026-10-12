import { test, expect, navigate } from '../fixtures/electron-app';

/**
 * Phase 4 —— 终端工具与底部面板。
 *
 * 终端位于主窗口底部面板，通过 footer 终端按钮打开（xterm 初始化）。
 */
test.describe('终端工具', () => {
  test('点击底部终端按钮应打开终端面板并初始化 xterm', async ({ mainWindow }) => {
    // A fresh profile may asynchronously offer login. The terminal itself is
    // available without an account; dismiss the offer through its real UI.
    await mainWindow.addLocatorHandler(mainWindow.locator('.login-modal-wrap app-login .login-close'), async (button) => {
      await button.click();
    });
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

  test('right sidebar should resize routed content and restore its width when closed', async ({mainWindow}) => {
    await mainWindow.addLocatorHandler(mainWindow.locator('.login-modal-wrap app-login .login-close'), async button => {
      await button.click();
    });
    await navigate(mainWindow, '/main/project-new');
    const content = mainWindow.locator('.aily-window-layout > nz-content');
    const original = await content.boundingBox();
    expect(original).not.toBeNull();
    await mainWindow.locator('app-header .toolbox .btn', {has: mainWindow.locator('i.fa-grid-2-plus')}).click();
    const sider = mainWindow.locator('.aily-window-layout > nz-sider');
    await expect(sider).toBeVisible();
    await expect(mainWindow.locator('nz-sider app-app-store')).toBeVisible();
    const assertSeparate = async () => {
      const left = await content.boundingBox(), right = await sider.boundingBox();
      expect(left).not.toBeNull(); expect(right).not.toBeNull();
      expect(Math.abs(left!.x + left!.width - right!.x)).toBeLessThanOrEqual(1);
      expect(left!.width + right!.width).toBeCloseTo(original!.width, 0);
      return right!;
    };
    const before = await assertSeparate();
    const handle = mainWindow.locator('nz-sider nz-resize-handle .toolbox-pane__resize-handle--left');
    const rect = await handle.boundingBox();
    expect(rect).not.toBeNull();
    await mainWindow.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
    await mainWindow.mouse.down();
    await mainWindow.mouse.move(rect!.x - 70, rect!.y + rect!.height / 2, {steps: 8});
    await mainWindow.mouse.up();
    await expect.poll(async () => (await sider.boundingBox())!.width).toBeGreaterThan(before.width + 30);
    await assertSeparate();
    await mainWindow.locator('nz-sider app-app-store app-tool-container .tool-btns .btn', {
      has: mainWindow.locator('i.fa-xmark'),
    }).click();
    await expect(sider).toHaveCount(0);
    await expect.poll(async () => (await content.boundingBox())!.width).toBeCloseTo(original!.width, 0);
  });
});
