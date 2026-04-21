/**
 * 10-board-matrix-build.spec.ts
 *
 * 数据驱动：读取 fixtures/boards.json，
 * 对每个板卡执行：新建项目 → 注入最小程序 → 编译 → 断言通过。
 *
 * 触发方式：
 *   npx playwright test specs/10-board-matrix-build.spec.ts
 *   或通过 CLI:
 *   npm run aily-test -- boards run
 *
 * 仅跑部分板卡：
 *   npx playwright test --grep "board:esp32"
 *
 * 默认 MOCK_BUILDER=1，走假 builder 快速冒烟。
 * 真实编译：MOCK_BUILDER=0 （但需确保 aily-builder 能在测试环境跑通）
 */

import { test, expect } from '../fixtures/electron-app';
import { MainWindowPage } from '../pages/main-window.page';
import { ProjectNewPage } from '../pages/project-new.page';
import { BlocklyEditorPage } from '../pages/blockly-editor.page';
import boards from '../fixtures/boards.json';

const DEFAULT_MINIMAL_XML =
  '<xml xmlns="https://developers.google.com/blockly/xml">' +
  '<block type="arduino_setup_loop" /></xml>';

// 允许通过 env 筛选板卡：BOARDS=arduino-uno,esp32-devmodule
const boardFilter = (process.env.BOARDS || '').split(',').filter(Boolean);
const activeBoards = boardFilter.length
  ? boards.filter((b) => boardFilter.includes(b.id))
  : boards;

test.describe('10 Board matrix build', () => {
  for (const board of activeBoards) {
    test(`board:${board.id} 新建项目并编译通过`, async ({
      app,
      mainWindow,
      tmpProjectDir,
    }) => {
      const main = new MainWindowPage(mainWindow);
      const newProj = new ProjectNewPage(mainWindow);
      const editor = new BlocklyEditorPage(mainWindow);

      await main.waitReady();
      await main.skipGuideIfPresent();

      // 1) mock 目录选择对话框 → 返回本测试临时目录
      await app.evaluate(
        async ({ dialog }, tmpDir) => {
          // 一次性 monkey-patch：调用一次后还原。
          const patchOnce = (method: string, result: any) => {
            const original = (dialog as any)[method];
            (dialog as any)[method] = async function () {
              (dialog as any)[method] = original;
              return result;
            };
          };
          patchOnce('showOpenDialog', { canceled: false, filePaths: [tmpDir] });
          patchOnce('showSaveDialog', { canceled: false, filePath: tmpDir });
        },
        tmpProjectDir
      );

      // 2) 进入新建项目页
      await main.gotoNewProject();

      // 3) 填写并提交（不传 boardId，直接用关键字搜索后取首张候选）
      const projectName = `smoke-${board.id}-${Date.now()}`;
      await newProj.create({
        name: projectName,
        boardKeyword: board.name,
      });

      // 4) 等 Blockly 编辑器就绪，注入最小程序
      await editor.waitReady(60_000);
      const xml = (board as any).minimalProgramXml || DEFAULT_MINIMAL_XML;
      await editor.loadWorkspaceXml(xml);

      // 5) 编译
      const buildResult = await editor.build({ timeout: 300_000 });
      expect
        .soft(buildResult.success, `board=${board.id} 编译失败\n--- build log ---\n${buildResult.log}`)
        .toBe(true);

      // 6) 上传/烧录（建议 MOCK_HARDWARE=1，否则需要插板）
      const uploadResult = await editor.upload({ timeout: 180_000 });
      expect
        .soft(uploadResult.success, `board=${board.id} 上传失败\n--- upload log ---\n${uploadResult.log}`)
        .toBe(true);

      expect.soft(buildResult.durationMs).toBeLessThan(300_000);
    });
  }
});
