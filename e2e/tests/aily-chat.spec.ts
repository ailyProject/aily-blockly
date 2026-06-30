import { test, expect, getMainWindow, navigate } from '../fixtures/electron-app';

/**
 * Phase 5 —— AI 聊天工具（aily-chat）。
 *
 * 基础 UI 不需要登录/网络即可渲染。验证：
 *  - 工具容器、输入框、发送区渲染；
 *  - 输入框可输入文本。
 *
 * 注意：不实际发送（避免依赖网络/鉴权与外部服务）。
 */
test.describe('AI 聊天工具', () => {
  test('aily-chat UI 应能离线渲染', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await navigate(win, '/aily-chat');

    await expect(win.locator('app-aily-chat')).toBeVisible();
    // 独立路由下工具以 app-sub-window 容器渲染（sider 内则为 app-tool-container）。
    await expect(win.locator('app-aily-chat app-sub-window')).toBeVisible();
    await expect(win.locator('app-aily-chat .window-box')).toBeVisible();
  });

  test('聊天输入框应可输入文本', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await navigate(win, '/aily-chat');

    const textarea = win.locator('app-aily-chat textarea').first();
    await expect(textarea).toBeVisible();
    await textarea.fill('hello aily');
    await expect(textarea).toHaveValue('hello aily');
  });
});
