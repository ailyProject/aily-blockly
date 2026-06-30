import { test as base, _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Electron 启动夹具（fixture）。
 *
 * 关键点：
 *  - 以项目根目录为 cwd，args 传 '.' —— Electron 把项目根作为 app 路径，
 *    主进程 electron/main.js 走「非 --serve」分支，loadFile('renderer/index.html')
 *    加载 global-setup 暂存好的生产渲染层。
 *  - 传入临时 --user-data-dir：main.js 的 setupPooledUserDataPath() 会在该目录下
 *    创建 instances/instance-N 隔离实例，从而不污染真实用户数据、也不触碰真实实例锁。
 *  - main.js 会预缓冲若干「子窗口」（about:blank，opacity 0）。因此必须用
 *    getMainWindow() 按 <app-main-window> 是否存在来识别真正的主窗口，
 *    而不能直接用 firstWindow()。
 */

const ROOT = path.resolve(__dirname, '..', '..');
let electronPreflightDone = false;

type AilyFixtures = {
  electronApp: ElectronApplication;
  mainWindow: Page;
};

type LaunchedAilyElectron = {
  app: ElectronApplication;
  userDataDir: string;
  close: () => Promise<void>;
};

export async function launchAilyElectron(): Promise<LaunchedAilyElectron> {
  assertElectronCanLaunch();

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'aily-e2e-'));
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;

  let app: ElectronApplication;
  try {
    app = await _electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: ROOT,
      timeout: 60_000,
      env: {
        ...env,
        // 标记测试环境，便于后续在应用内按需关闭自动更新 / 引导等。
        AILY_E2E: '1',
      },
    });
  } catch (error) {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  app.on('console', (msg) => {
    console.log(`[electron:${msg.type()}] ${msg.text()}`);
  });
  app.on('close', () => {});

  let closed = false;
  return {
    app,
    userDataDir,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await closeAilyElectronApp(app);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export async function closeAilyElectronApp(app: ElectronApplication, timeoutMs = 10_000): Promise<void> {
  const processRef = app.process();
  let didExit = processRef.exitCode !== null || processRef.signalCode !== null;
  processRef.once('exit', () => {
    didExit = true;
  });

  await app
    .evaluate(({ app }) => {
      app.exit(0);
    })
    .catch(() => {});

  await waitForElectronExit(processRef, timeoutMs);

  if (didExit || processRef.exitCode !== null || processRef.signalCode !== null) {
    return;
  }

  await Promise.race([app.close(), waitForElectronExit(processRef, timeoutMs)]).catch(() => {});

  if (didExit || processRef.exitCode !== null || processRef.signalCode !== null) {
    return;
  }

  throw new Error(`[e2e] Electron ${processRef.pid ?? ''} 关闭超时。`);
}

async function waitForElectronExit(processRef: ReturnType<ElectronApplication['process']>, timeoutMs: number): Promise<void> {
  if (processRef.exitCode !== null || processRef.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    processRef.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertElectronCanLaunch(): void {
  if (electronPreflightDone) {
    return;
  }

  const electronCli = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
  if (!existsSync(electronCli)) {
    throw new Error('[e2e] 未找到 Electron CLI。请先执行 `npm install` 安装 devDependencies。');
  }

  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  const result = spawnSync(process.execPath, [electronCli, '--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 15_000,
  });

  if (result.status !== 0) {
    const detail = [
      result.error ? `error=${result.error.message}` : '',
      result.signal ? `signal=${result.signal}` : '',
      `status=${result.status}`,
      result.stdout ? `stdout=${result.stdout.trim()}` : '',
      result.stderr ? `stderr=${result.stderr.trim()}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const macHint =
      process.platform === 'darwin'
        ? ' macOS 下可先检查 Electron.app 是否能直接运行、是否被系统策略拦截，必要时重装依赖或重新签名 Electron.app。'
        : '';
    throw new Error(`[e2e] Electron CLI 预检失败，无法启动 Electron。${detail}.${macHint}`);
  }

  electronPreflightDone = true;
}

/**
 * 在所有已打开窗口中找到「主窗口」。
 * 主窗口加载 /main 路由并渲染 <app-main-window>；预缓冲子窗口加载 about:blank。
 */
export async function getMainWindow(app: ElectronApplication, timeoutMs = 60_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;

  // 先确保至少有一个窗口已创建。
  await app.firstWindow({ timeout: timeoutMs }).catch((e) => (lastErr = e));

  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        const url = win.url();
        if (!url || url.startsWith('about:blank')) continue;
        const count = await win.locator('app-main-window').count();
        if (count > 0) {
          return win;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error(
    `[e2e] 在 ${timeoutMs}ms 内未找到主窗口（含 <app-main-window>）。最近错误：${String(lastErr)}`,
  );
}

/**
 * 通过 hash 路由导航当前窗口（应用使用 withHashLocation()）。
 * 例：navigate(win, '/serial-monitor') -> location.hash = '#/serial-monitor'
 */
export async function navigate(win: Page, route: string): Promise<void> {
  const hash = route.startsWith('#') ? route : `#${route}`;
  await win.evaluate((h) => {
    window.location.hash = h;
  }, hash);
}

/**
 * 以「打开 Blockly 项目」方式导航到编辑器。
 * BlocklyEditorComponent 监听 path 查询参数并调用 loadProject(path)。
 */
export async function openBlocklyProject(win: Page, projectPath: string): Promise<void> {
  const encoded = encodeURIComponent(projectPath);
  await navigate(win, `/main/blockly-editor?path=${encoded}`);
}

export const test = base.extend<AilyFixtures>({
  electronApp: async ({}, use, testInfo) => {
    const launched = await launchAilyElectron();

    await use(launched.app);

    await launched.close();
  },

  mainWindow: async ({ electronApp }, use) => {
    const win = await getMainWindow(electronApp);
    await win.waitForLoadState('domcontentloaded').catch(() => {});
    await use(win);
  },
});

export { expect };
export { ROOT };
