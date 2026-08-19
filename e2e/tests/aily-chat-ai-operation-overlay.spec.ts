import { expect, getMainWindow, openBlocklyProject, test } from '../fixtures/electron-app';

const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];
const OVERLAY_E2E_ENABLED = process.env['AILY_E2E_AI_OPERATION_OVERLAY'] === '1';

test.describe('新版 Aily Chat 的 Blockly AI 操作提示', () => {
  test.skip(
    !PROJECT_PATH || !OVERLAY_E2E_ENABLED,
    '需设置 AILY_E2E_PROJECT 和 AILY_E2E_AI_OPERATION_OVERLAY=1 才运行真实模型回归。',
  );

  test('请求运行期间显示遮罩和提示，并可从宿主停止', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await openBlocklyProject(win, PROJECT_PATH!);

    await expect(win.locator('app-blockly-editor .blocklyBox')).toBeVisible({ timeout: 30_000 });
    const aiChatButton = win.locator('app-header .toolbox .btn', {
      has: win.locator('.more', { hasText: 'AI' }),
    });
    await expect(aiChatButton).toBeVisible({ timeout: 30_000 });
    await aiChatButton.click();

    const childHost = win.locator('app-child-tool-host');
    await expect(childHost).toBeVisible({ timeout: 30_000 });
    const chat = childHost.frameLocator('iframe');
    const composer = chat.locator('.aily-chat-composer-input[contenteditable="true"]');
    await expect(composer).toBeVisible({ timeout: 60_000 });

    await composer.fill(
      '请用 abs_apply 或等价积木写入工具在工作区做一个最小改动（例如微调一个无害字段），操作积木时保持等待，方便观察遮罩；完成后简要说明即可。',
    );
    await chat.locator('button.send-action').click();

    await expect(chat.locator('button.stop-action')).toBeVisible({ timeout: 30_000 });
    // 与旧版 Angular 一致：遮罩/「AI正在操作」仅在积木写入工具执行期间出现，而非整轮思考。
    await expect(win.locator('.blockly-spin.show')).toBeVisible({ timeout: 120_000 });
    const operationNotice = win.locator('app-notification .notification-box', {
      hasText: 'AI正在操作',
    });
    await expect(operationNotice).toBeVisible({ timeout: 15_000 });
    await expect(operationNotice.locator('.btn.red')).toBeVisible();

    await operationNotice.locator('.btn.red').click();

    await expect(win.locator('.blockly-spin.show')).toHaveCount(0, { timeout: 30_000 });
    await expect(operationNotice).toHaveCount(0, { timeout: 30_000 });
    await expect(chat.locator('button.stop-action')).toHaveCount(0, { timeout: 30_000 });

    await composer.fill('只回复“收到”，不要调用任何工具。');
    await chat.locator('button.send-action').click();
    await expect(chat.locator('button.stop-action')).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('.blockly-spin.show')).toHaveCount(0);
    await expect(operationNotice).toHaveCount(0);
    await expect(chat.locator('button.stop-action')).toHaveCount(0, { timeout: 60_000 });
  });
});
