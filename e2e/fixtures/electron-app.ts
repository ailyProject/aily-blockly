/**
 * Playwright Electron 启动 Fixture。
 *
 * 提供：
 *   - app:        ElectronApplication
 *   - mainWindow: Page（主窗口）
 *   - tmpUserData: string（本次 test 专用 userData 目录）
 *   - tmpProjectDir: string（本次 test 专用项目根目录，放 .abi）
 *
 * 环境变量：
 *   - AILY_TEST_TARGET = 'dev' | 'prod'
 *   - MOCK_BUILDER, MOCK_HARDWARE, MOCK_SERIAL → 透传给主进程
 *   - AILY_TEST_KEEP_USERDATA=1 → 测试结束不清理（用于排查）
 */

import { test as base, _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import waitOn from 'wait-on';

type Fixtures = {
  app: ElectronApplication;
  mainWindow: Page;
  tmpUserData: string;
  tmpProjectDir: string;
  repoRoot: string;
};

function uniqueTmpDir(prefix: string): string {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function ensureDevServer(url: string, timeout = 180_000) {
  // playwright webServer 已在 config 中声明会自动拉起 ng serve 并等待端口就绪。
  // 这里再保险地 wait-on 一次，涵盖 fixture 单独使用的场景。
  try {
    await waitOn({
      resources: [url],
      timeout,
      interval: 500,
      validateStatus: (s) => s === 200 || s === 304,
    });
  } catch (e) {
    throw new Error(
      `[e2e] dev server not ready at ${url} within ${timeout}ms. ` +
      `确认 playwright.config.ts 的 webServer 正常拉起了 npm start，或手动在另一终端运行 npm start 后重试。`
    );
  }
}

export const test = base.extend<Fixtures>({
  repoRoot: async ({}, use, testInfo) => {
    const root = (testInfo.project.metadata?.repoRoot as string) ||
      path.resolve(__dirname, '../..');
    await use(root);
  },

  tmpUserData: async ({}, use) => {
    const dir = uniqueTmpDir('aily-test-userdata');
    await use(dir);
    if (process.env.AILY_TEST_KEEP_USERDATA !== '1') {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  },

  tmpProjectDir: async ({}, use) => {
    const dir = uniqueTmpDir('aily-test-project');
    await use(dir);
    if (process.env.AILY_TEST_KEEP_USERDATA !== '1') {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  },

  app: async ({ repoRoot, tmpUserData }, use, testInfo) => {
    const target = (process.env.AILY_TEST_TARGET ?? 'dev') as 'dev' | 'prod';

    const extraEnv: Record<string, string> = {
      ELECTRON_TEST_MODE: '1',
      AILY_USERDATA: tmpUserData,
      AILY_DISABLE_UPDATER: '1',
    };
    for (const k of ['MOCK_BUILDER', 'MOCK_HARDWARE', 'MOCK_SERIAL', 'AILY_PROBE_RS_BIN', 'HARDWARE']) {
      if (process.env[k]) extraEnv[k] = process.env[k]!;
    }

    const electronArgs: string[] = [path.join(repoRoot, 'electron/main.js'), '--test-mode'];
    if (target === 'dev') {
      electronArgs.splice(1, 0, '--serve');
      await ensureDevServer('http://localhost:4200');
    }

    const app = await electron.launch({
      args: electronArgs,
      cwd: repoRoot,
      env: {
        ...process.env,
        ...extraEnv,
      },
      timeout: 60_000,
    });

    // 捕获主进程日志到 testInfo attachment，排障用
    app.process().stdout?.on('data', (buf) => {
      testInfo.attachments.push({
        name: 'main-stdout.log',
        contentType: 'text/plain',
        body: buf,
      });
    });

    await use(app);
    try { await app.close(); } catch {}
  },

  mainWindow: async ({ app }, use) => {
    const win = await app.firstWindow({ timeout: 60_000 });
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

export { expect };
