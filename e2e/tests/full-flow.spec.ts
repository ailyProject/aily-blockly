import { test, expect, closeAilyElectronApp, getMainWindow, launchAilyElectron, navigate } from '../fixtures/electron-app';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 全流程验证：选择板子 → 新建项目 → 编译。
 *
 * 这是一条「重」用例，会真实地：
 *  - 执行 `npm install <board>`（需要网络或 npm 缓存命中）；
 *  - 从板卡模板创建真实项目目录（默认在 ~/Documents/aily-project/<name>）；
 *  - 调用 aily-arduino-cli 真实编译（需要已安装对应编译器/SDK）。
 *
 * 因此默认跳过，需显式开启：
 *
 *   $env:AILY_E2E_FULLFLOW = '1'
 *   # 可选：指定要选择的开发板搜索关键字（默认 "uno r4"，需本机已装该板的编译器/SDK）
 *   $env:AILY_E2E_BOARD_KEYWORD = 'uno r4'
 *   npm run test:e2e:fast -- full-flow.spec.ts
 *
 * 本机需具备：内置工具链（child/node、child/aily-builder）、该开发板可安装
 * （网络/缓存），以及对应编译器与 SDK 已安装于应用数据目录下的 aily-project/tools 与 sdk。
 */
const ENABLED = process.env['AILY_E2E_FULLFLOW'] === '1';
const ALL_BOARDS_ENABLED = process.env['AILY_E2E_ALL_BOARDS'] === '1';
const BOARD_KEYWORD = process.env['AILY_E2E_BOARD_KEYWORD'] || 'uno r4';
const SINGLE_BOARD_TIMEOUT_MS = readTimeoutEnv('AILY_E2E_SINGLE_BOARD_TIMEOUT_MS', 45 * 60_000);
const INSTALL_TIMEOUT_MS = readTimeoutEnv('AILY_E2E_INSTALL_TIMEOUT_MS', 30 * 60_000);
const COMPILE_TIMEOUT_MS = readTimeoutEnv('AILY_E2E_COMPILE_TIMEOUT_MS', 10 * 60_000);

type BoardCandidate = {
  name: string;
  label: string;
};

type BoardTarget = string | BoardCandidate;

type PageLogBuffer = {
  messages: string[];
};

function readTimeoutEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallbackMs;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[e2e] 忽略无效超时配置 ${name}=${raw}，使用默认值 ${fallbackMs}ms。`);
    return fallbackMs;
  }
  return value;
}

test.describe('全流程：选板子 → 新建项目 → 编译', () => {
  const projectDirs: string[] = [];
  const singleBoardTest = ENABLED ? test : test.skip;
  const allBoardsTest = ALL_BOARDS_ENABLED ? test : test.skip;

  test.beforeAll(async () => {
    if (ENABLED || ALL_BOARDS_ENABLED) {
      await cleanGlobalAilyProjectDir();
      await bootstrapAfterGlobalDataCleanup();
    }
  });

  test.afterAll(async () => {
    for (const projectDir of projectDirs) {
      await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  singleBoardTest('应能从选板子一路走到编译完成', async ({ electronApp }) => {
    test.setTimeout(SINGLE_BOARD_TIMEOUT_MS);

    const win = await getMainWindow(electronApp);
    const pageLog = attachDiagnostics(win);

    await createProjectAndCompile(win, BOARD_KEYWORD, projectDirs, pageLog);
  });

  allBoardsTest('应能让所有可创建开发板完成新建项目并编译', async ({ electronApp }) => {
    // 每块板最多 7 分钟，给全量运行留足时间。
    test.setTimeout(24 * 60 * 60 * 1000);

    const win = await getMainWindow(electronApp);
    attachDiagnostics(win);

    const boards = await collectCreatableBoards(win);
    expect(boards.length, '至少应发现一个可创建的开发板').toBeGreaterThan(0);
    console.log(`[all-boards] 将验证 ${boards.length} 个可创建开发板。`);
    await closeAilyElectronApp(electronApp).catch(() => {});

    const failures: Array<{ board: BoardCandidate; message: string }> = [];
    for (const board of boards) {
      await test.step(`创建并编译 ${board.name}`, async () => {
        const launched = await launchAilyElectron();
        try {
          const isolatedWin = await getMainWindow(launched.app);
          const pageLog = attachDiagnostics(isolatedWin);
          await createProjectAndCompile(isolatedWin, board, projectDirs, pageLog);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ board, message });
          console.log(`[all-boards] ${board.name} 失败：${message}`);
        } finally {
          await launched.close();
        }
      });
    }

    expect(
      failures.map((failure) => `${failure.board.name} (${failure.board.label}): ${failure.message}`),
      '以下开发板未完成新建项目并编译',
    ).toEqual([]);
  });
});

async function cleanGlobalAilyProjectDir(): Promise<void> {
  const globalProjectDir = getAilyAppDataPath();

  if (!path.resolve(globalProjectDir).endsWith(`${path.sep}aily-project`)) {
    throw new Error(`[e2e] 拒绝清理异常全局目录：${globalProjectDir}`);
  }

  console.log(`[e2e] 清理全局 aily-project 目录：${globalProjectDir}`);
  await rmWithRetry(globalProjectDir);
}

function getAilyAppDataPath(): string {
  if (process.env['AILY_APPDATA_PATH']) {
    return process.env['AILY_APPDATA_PATH'];
  }

  const configPath = path.resolve(__dirname, '..', '..', 'electron', 'config', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    appdata_path?: Partial<Record<NodeJS.Platform, string>>;
  };
  const configuredPath = config.appdata_path?.[process.platform];

  if (!configuredPath) {
    throw new Error(`[e2e] electron/config/config.json 未配置当前平台 appdata_path：${process.platform}`);
  }

  return configuredPath
    .replace('%HOMEPATH%', os.homedir())
    .replace(/^~(?=$|[\\/])/, os.homedir());
}

async function cleanAilyBuilderArtifacts(): Promise<void> {
  const targets = getAilyBuilderArtifactDirs();

  for (const targetPath of targets) {
    const resolved = path.resolve(targetPath);
    if (!/(^|[\\/])aily-builder[\\/](project|cache)$/.test(resolved)) {
      throw new Error(`[e2e] 拒绝清理异常 aily-builder 目录：${targetPath}`);
    }

    console.log(`[e2e] 清理 aily-builder 构建缓存：${targetPath}`);
    await rmWithRetry(targetPath);
  }
}

function getAilyBuilderArtifactDirs(): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(localAppData, 'aily-builder', 'project'),
      path.join(localAppData, 'aily-builder', 'cache'),
    ];
  }

  if (process.platform === 'darwin') {
    return [
      path.join(os.homedir(), 'Library', 'aily-builder', 'project'),
      path.join(os.homedir(), 'Library', 'Caches', 'aily-builder', 'cache'),
    ];
  }

  return [
    path.join(os.homedir(), '.cache', 'aily-builder', 'project'),
    path.join(os.homedir(), '.aily-builder', 'cache'),
  ];
}

async function bootstrapAfterGlobalDataCleanup(): Promise<void> {
  console.log('[e2e] 全局数据已清理，先启动一次应用以完成首次初始化，然后关闭并重新打开执行用例。');
  const launched = await launchAilyElectron();
  try {
    const win = await getMainWindow(launched.app, 120_000);
    attachDiagnostics(win);
    await win.waitForLoadState('domcontentloaded').catch(() => {});
    await expect(win.locator('app-guide .menu-box .btn.link').first()).toBeVisible({ timeout: 60_000 });
    await dismissOnboardingIfVisible(win, 10_000);
    await win.waitForTimeout(1_000);
  } finally {
    await launched.close();
  }
}

async function rmWithRetry(targetPath: string): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[e2e] 清理目录失败：${targetPath}。请确认没有残留 Electron/编译器进程占用该目录。原始错误：${message}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

async function dismissOnboardingIfVisible(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  timeout = 2_000,
): Promise<void> {
  const overlay = win.locator('app-onboarding .onboarding-overlay');
  const skipButton = win.locator('app-onboarding .btn-skip').first();

  if (!(await overlay.first().isVisible({ timeout }).catch(() => false))) {
    return;
  }

  console.log('[e2e] 检测到新手引导遮罩，点击跳过以避免阻塞自动化流程。');
  await skipButton.click({ timeout: 10_000 }).catch(async () => {
    await win.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('app-onboarding .btn-skip');
      button?.click();
    });
  });
  await expect(overlay).toHaveCount(0, { timeout: 10_000 });
}

function attachDiagnostics(win: Awaited<ReturnType<typeof getMainWindow>>): PageLogBuffer {
  const pageLog: PageLogBuffer = { messages: [] };
  win.on('console', (msg) => {
    const text = msg.text();
    pageLog.messages.push(text);
    if (pageLog.messages.length > 500) {
      pageLog.messages.shift();
    }
    console.log(`[page:${msg.type()}] ${text}`);
  });
  win.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
  win.on('requestfailed', (request) => {
    console.log(`[requestfailed] ${request.failure()?.errorText || 'unknown'} ${request.url()}`);
  });
  return pageLog;
}

async function openProjectNew(win: Awaited<ReturnType<typeof getMainWindow>>): Promise<void> {
  await dismissOnboardingIfVisible(win);
  await navigate(win, '/main/project-new');
  await expect(win.locator('app-project-new .project-new-box')).toBeVisible();
  await win.waitForTimeout(750);
  await dismissOnboardingIfVisible(win, 5_000);
}

async function waitForBoardCards(win: Awaited<ReturnType<typeof getMainWindow>>, timeout = 60_000) {
  const boardCards = win.locator('app-project-new .board-selector .board.ccenter.btn');
  const deadline = Date.now() + timeout;
  const firstAttemptDeadline = Date.now() + Math.min(10_000, timeout);

  while (Date.now() < firstAttemptDeadline) {
    if ((await boardCards.count()) > 0) {
      await expect(boardCards.first()).toBeVisible({ timeout: 5_000 });
      return boardCards;
    }
    await win.waitForTimeout(500);
  }

  // 清空全局缓存后的首次加载中，ProjectNewComponent 可能先用空 boardList 初始化；
  // ConfigService 随后才异步写入 boardList。重新进入一次页面可让组件读取已完成的配置。
  console.log('[e2e] 未发现开发板卡片，重新进入新建项目页以避开首次配置加载竞态。');
  await navigate(win, '/main/guide');
  await win.waitForTimeout(500);
  await openProjectNew(win);

  while (Date.now() < deadline) {
    if ((await boardCards.count()) > 0) {
      await expect(boardCards.first()).toBeVisible({ timeout: 5_000 });
      return boardCards;
    }
    await win.waitForTimeout(500);
  }

  const diagnostics = await win.evaluate(() => {
    const projectNew = document.querySelector('app-project-new');
    return {
      hash: window.location.hash,
      projectNewText: projectNew?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500) || '',
      projectNewHtml: projectNew?.innerHTML?.replace(/\s+/g, ' ').trim().slice(0, 1000) || '',
      boardSelectorCount: document.querySelectorAll('app-project-new .board-selector').length,
      boardCardCount: document.querySelectorAll('app-project-new .board-selector .board.ccenter.btn').length,
      inputCount: document.querySelectorAll('app-project-new input').length,
    };
  });
  console.log(`[e2e] 开发板卡片等待超时诊断：${JSON.stringify(diagnostics)}`);
  await expect(boardCards.first()).toBeVisible({ timeout: 1 });
  return boardCards;
}

async function collectCreatableBoards(win: Awaited<ReturnType<typeof getMainWindow>>): Promise<BoardCandidate[]> {
  await openProjectNew(win);
  const boardCards = await waitForBoardCards(win);
  const searchInput = win.locator('app-project-new .header input[nz-input]').first();
  await searchInput.fill('');

  const count = await boardCards.count();
  const boards: BoardCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const card = boardCards.nth(i);
    await card.scrollIntoViewIfNeeded();

    const label = ((await card.locator('.name').innerText().catch(() => '')) || '').trim();
    if (!label || /\(todo\)/i.test(label)) {
      continue;
    }

    await dismissOnboardingIfVisible(win, 5_000);
    await card.click();
    const useThisBtn = win.locator('app-project-new .desc-box .next button').first();
    if (!(await useThisBtn.isVisible().catch(() => false))) {
      continue;
    }

    await useThisBtn.click();
    const boardInput = win.locator('app-project-new input.board[disabled]').first();
    await expect(boardInput).toBeVisible({ timeout: 10_000 });
    const name = (await boardInput.inputValue()).trim();
    if (name) {
      boards.push({ name, label });
    }

    const prevBtn = win.locator('app-project-new .step-btns button.ant-btn-default').first();
    await prevBtn.click();
    await expect(boardCards.first()).toBeVisible({ timeout: 10_000 });
  }

  const seen = new Set<string>();
  return boards.filter((board) => {
    if (seen.has(board.name)) {
      return false;
    }
    seen.add(board.name);
    return true;
  });
}

async function createProjectAndCompile(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  boardTarget: BoardTarget,
  projectDirs: string[],
  pageLog: PageLogBuffer,
): Promise<string> {
  await cleanAilyBuilderArtifacts();
  await openProjectNew(win);
  await waitForBoardCards(win);

  // 1) 选择目标开发板。
  await selectBoardForProject(win, boardTarget);

  // 2) 选中后右侧出现描述与「使用此开发板」按钮。
  const useThisBtn = win.locator('app-project-new .desc-box .next button').first();
  await expect(useThisBtn).toBeVisible({ timeout: 10_000 });
  await useThisBtn.click();

  // 3) 基本设置页：使用默认项目名与默认路径（~/Documents/aily-project）。
  // 名称输入框是该页唯一未禁用的输入框（开发板/路径输入框均为 disabled）。
  const boardInput = win.locator('app-project-new input.board[disabled]').first();
  if (typeof boardTarget !== 'string') {
    await expect(boardInput).toHaveValue(boardTarget.name, { timeout: 10_000 });
  } else if (boardTarget.startsWith('@aily-project/')) {
    await expect(boardInput).toHaveValue(boardTarget, { timeout: 10_000 });
  } else {
    await expect(boardInput).toBeVisible({ timeout: 10_000 });
  }

  const nameInput = win.locator('app-project-new .right-content input[nz-input]:not([disabled])');
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  const projectName = (await nameInput.inputValue()).trim();
  expect(projectName, '默认项目名不应为空').not.toBe('');
  const projectDir = path.join(os.homedir(), 'Documents', 'aily-project', projectName);
  projectDirs.push(projectDir);

  // 4) 创建项目。
  const createBtn = win.locator('app-project-new .step-btns button.ant-btn-primary').first();
  await expect(createBtn).toBeEnabled({ timeout: 10_000 });
  await createBtn.click();

  // 5) 等待创建完成并跳转到编辑器（blockly-editor）。
  await win.waitForFunction(
    () => /\/main\/(blockly|code)-editor/.test(window.location.hash),
    undefined,
    { timeout: 120_000 },
  );
  // 头部应显示项目名。
  await expect(win.locator('app-header .project-box')).toContainText(projectName, {
    timeout: 30_000,
  });

  // 6) 等待后台依赖安装与预编译完成后再点击编译。
  await waitForDependenciesAndPrecompile(win, pageLog);

  // 7) 点击编译按钮（仅在编辑器路由、项目已加载时显示）。
  const compileBtn = win.locator('app-header app-act-btn[data-action="compile"]');
  await expect(compileBtn).toBeVisible({ timeout: 60_000 });
  const compileLogStart = pageLog.messages.length;
  await dismissOnboardingIfVisible(win, 5_000);
  await compileBtn.click();

  await waitForCompileDone(win, pageLog, compileLogStart);
  return projectDir;
}

async function selectBoardForProject(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  boardTarget: BoardTarget,
): Promise<void> {
  const searchInput = win.locator('app-project-new .header input[nz-input]').first();
  const boardCards = win.locator('app-project-new .board-selector .board.ccenter.btn');

  if (typeof boardTarget === 'string') {
    await searchInput.fill(boardTarget);
    // ProjectNewComponent.search() 有 200ms debounce，等搜索结果稳定后再点。
    await win.waitForTimeout(500);
    await expect(boardCards.first()).toBeVisible({ timeout: 15_000 });
    await dismissOnboardingIfVisible(win, 5_000);
    await boardCards.first().click();
    return;
  }

  await searchInput.fill('');
  await win.waitForTimeout(500);
  await expect(boardCards.first()).toBeVisible({ timeout: 15_000 });
  await dismissOnboardingIfVisible(win, 5_000);

  const targetLabel = normalizeBoardLabel(boardTarget.label);
  const count = await boardCards.count();
  for (let i = 0; i < count; i++) {
    const card = boardCards.nth(i);
    const label = normalizeBoardLabel((await card.locator('.name').innerText().catch(() => '')) || '');
    if (label === targetLabel) {
      await card.scrollIntoViewIfNeeded();
      await dismissOnboardingIfVisible(win, 5_000);
      await card.click();
      return;
    }
  }

  throw new Error(`[e2e] 未找到开发板卡片：${boardTarget.name} (${boardTarget.label})`);
}

function normalizeBoardLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim();
}

async function waitForDependenciesAndPrecompile(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  pageLog: PageLogBuffer,
): Promise<void> {
  console.log('[e2e] 等待依赖安装与后台预编译完成后再触发编译。');

  const deadline = Date.now() + INSTALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const joined = pageLog.messages.join('\n');
    const installDone =
      /install board dependencies success|开发板依赖安装完成|依赖安装完成/.test(joined) &&
      !/依赖安装中/.test(await getNoticeText(win));
    const precompileDone =
      /后台预处理完成|同步预处理完成|发现预编译缓存|预编译完成/.test(joined);

    if (installDone && precompileDone) {
      await win.waitForTimeout(500);
      return;
    }

    const compileRejected = /Cannot start build from state: INSTALLING/.test(joined);
    if (compileRejected) {
      throw new Error('[e2e] 测试过早触发编译：应用仍处于 INSTALLING 状态。');
    }

    await win.waitForTimeout(1000);
  }

  throw new Error(`[e2e] 等待依赖安装和后台预编译完成超时（${INSTALL_TIMEOUT_MS}ms）。`);
}

async function getNoticeText(win: Awaited<ReturnType<typeof getMainWindow>>): Promise<string> {
  const title = (await win.locator('app-notification .text-box .ellipsis').first().innerText().catch(() => '')) || '';
  const text = (await win.locator('app-notification .text-box .ellipsis.text').innerText().catch(() => '')) || '';
  return `${title}\n${text}`;
}

async function waitForCompileDone(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  pageLog: PageLogBuffer,
  compileLogStart: number,
): Promise<void> {
  // 编译进度/结果通过 NoticeService 显示在 <app-notification>（非 footer）。
  // 成功：title="编译完成"、text 含 "Flash"；失败：title="编译失败"。
  const noticeTitle = win.locator('app-notification .text-box .ellipsis').first();
  const noticeText = win.locator('app-notification .text-box .ellipsis.text');

  const compileDeadline = Date.now() + COMPILE_TIMEOUT_MS;
  let compileResult = '';
  let lastError = '';
  while (Date.now() < compileDeadline) {
    const title = (await noticeTitle.innerText().catch(() => '')) || '';
    const text = (await noticeText.innerText().catch(() => '')) || '';
    const doneBox = await win.locator('app-notification .box.done').count();
    const errBox = await win.locator('app-notification .box.error').count();
    const compileLogs = pageLog.messages.slice(compileLogStart).join('\n');
    console.log(`[compile] title="${title.trim()}" text="${text.trim()}" done=${doneBox} err=${errBox}`);

    const successByNotice = /编译完成/.test(title) || /Flash|RAM/.test(text);
    const successByLog =
      /编译命令完成：\s*buildCompleted=\s*true\s+isErrored=\s*false/.test(compileLogs) ||
      /lastBuildStatus:\s*success/.test(compileLogs) ||
      /编译耗时:\s*\d/.test(compileLogs);

    if (successByNotice || successByLog) {
      compileResult = 'done';
      break;
    }

    if (/编译失败|预编译失败/.test(title) || /buildCompleted=\s*false|isErrored=\s*true|lastBuildStatus:\s*error/.test(compileLogs)) {
      compileResult = 'error';
      lastError = `title="${title.trim()}" text="${text.trim()}"`;
    }
    await win.waitForTimeout(3000);
  }
  expect(
    compileResult,
    `编译未成功完成（请查看上方 [compile]/[page] 日志）。最后错误状态：${lastError || '无'}`,
  ).toBe('done');
}
