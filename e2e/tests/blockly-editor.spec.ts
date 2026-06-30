import { test, expect, getMainWindow, openBlocklyProject } from '../fixtures/electron-app';

/**
 * Phase 3 —— Blockly 编辑器。
 *
 * 需要一个真实的 Blockly 项目（含 project.abi），并且其依赖的开发板/库包
 * 已安装。通过环境变量 AILY_E2E_PROJECT 指定项目目录的绝对路径，例如：
 *
 *   $env:AILY_E2E_PROJECT = 'D:\\path\\to\\blockly-project'
 *   npm run test:e2e -- blockly-editor.spec.ts
 *
 * 未设置该变量时整套用例自动跳过。
 */
const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];

test.describe('Blockly 编辑器', () => {
  test.skip(!PROJECT_PATH, '未设置 AILY_E2E_PROJECT，跳过 Blockly 编辑器用例。');

  test('打开项目后应渲染 Blockly 工作区', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await openBlocklyProject(win, PROJECT_PATH!);

    await expect(win.locator('app-blockly-editor')).toBeVisible({ timeout: 30_000 });
    // 第三方 Blockly 库注入的工作区容器。
    await expect(win.locator('app-blockly-editor .blocklyDiv')).toBeVisible({ timeout: 30_000 });
    // 头部应显示已加载项目的名称。
    await expect(win.locator('app-header .project-box')).not.toBeEmpty();
  });

  test('应渲染工具箱', async ({ electronApp }) => {
    const win = await getMainWindow(electronApp);
    await openBlocklyProject(win, PROJECT_PATH!);

    await expect(win.locator('app-blockly-editor .blocklyToolboxDiv')).toBeVisible({
      timeout: 30_000,
    });
  });
});
