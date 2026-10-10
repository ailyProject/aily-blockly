import { test, expect, getMainWindow, openBlocklyProject } from '../fixtures/electron-app';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

/**
 * Phase 6 —— 编译（compile）。
 *
 * 编译依赖完整工具链：已安装的编译器/SDK（AILY_COMPILERS_PATH 等）、项目的
 * board.json，以及全局安装的 aily-builder 命令。这些前置在干净环境中通常不具备，且首次
 * 编译耗时较长，因此本套件需要显式开启：
 *
 *   $env:AILY_E2E_PROJECT = 'D:\\path\\to\\blockly-project'   # 一个可编译的项目
 *   $env:AILY_E2E_COMPILE = '1'                               # 显式开启编译用例
 *   npm run test:e2e -- compile.spec.ts
 *
 * 缺少上述任一环境变量时整套用例自动跳过。
 */
const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];
const COMPILE_ENABLED = process.env['AILY_E2E_COMPILE'] === '1';

test.describe('编译', () => {
  test.skip(!PROJECT_PATH || !COMPILE_ENABLED, '未开启编译用例（需 AILY_E2E_PROJECT + AILY_E2E_COMPILE=1）。');

  // 编译可能较慢，单独放宽超时。
  test('点击编译应进入编译流程并最终完成', async ({ electronApp }, testInfo) => {
    test.setTimeout(300_000);
    const win = await getMainWindow(electronApp);
    await win.addLocatorHandler(win.locator('.login-modal-wrap app-login .login-close'), async button => { await button.click(); });
    const messages: string[] = [];
    win.on('console', message => messages.push(message.text()));
    await openBlocklyProject(win, PROJECT_PATH!);

    // 等待编辑器与头部编译按钮就绪（编译按钮仅在编辑器路由下显示）。
    const compileBtn = win.locator('app-header app-act-btn[data-action="compile"]');
    await expect(compileBtn).toBeVisible({ timeout: 30_000 });
    // Header visibility precedes project/library loading and dependency setup.
    // Wait for the same ready signal used by the full-flow suite before clicking.
    await expect.poll(() => messages.some(message =>
      /后台预处理完成|同步预处理完成|发现预编译缓存|预编译完成/.test(message),
    ), {timeout: 120_000}).toBe(true);
    const compileStartedAt = Date.now();
    await compileBtn.click();

    // 编译进度/结果通过 NoticeService 显示在 <app-notification>（非 footer）。
    const noticeTitle = win.locator('app-notification .text-box .title').first();

    const compileDeadline = Date.now() + 280_000;
    let compileResult = '';
    while (Date.now() < compileDeadline) {
      const title = (await noticeTitle.innerText().catch(() => '')) || '';
      // Read back a result from THIS build, not a stale notice or a first-item
      // locator hidden behind another notification. Works in any UI locale.
      const pkg = JSON.parse(await readFile(path.join(PROJECT_PATH!, 'package.json'), 'utf8'));
      const currentBuild = Date.parse(pkg.buildInfo?.lastBuildTime || '') >= compileStartedAt;
      if (currentBuild && pkg.buildInfo?.lastBuildStatus === 'success') {
        compileResult = 'done';
        break;
      }
      if ((currentBuild && pkg.buildInfo?.lastBuildStatus === 'error') || /编译失败/.test(title)) {
        compileResult = 'error';
        break;
      }
      await win.waitForTimeout(500);
    }
    expect(compileResult, '编译未成功完成（请查看 Playwright 输出与 trace）').toBe('done');

    // 日志面板应有编译输出。
    if (!(await win.locator('app-log').isVisible())) {
      await win.locator('app-footer .btn').filter({has: win.locator('i.fa-square-list')}).click();
    }
    await expect(win.locator('app-log .log-box .item').first()).toBeVisible();
    expect(messages.some(message => /编译命令执行完成/.test(message))).toBe(true);
    await testInfo.attach('build-metadata', {body: JSON.stringify(JSON.parse(await readFile(path.join(PROJECT_PATH!, 'package.json'), 'utf8')).buildInfo, null, 2), contentType: 'application/json'});
    await win.screenshot({path: testInfo.outputPath('compile-success.png')});
  });
});
