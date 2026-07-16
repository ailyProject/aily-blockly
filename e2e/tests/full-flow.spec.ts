import { test, expect, closeAilyElectronApp, getMainWindow, launchAilyElectron, navigate } from '../fixtures/electron-app';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 全流程验证：选择板子 → 新建项目 → 连续编译两次，以及项目广场项目全量编译。
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
 *   # 可选：指定多个开发板搜索关键字，逗号分隔；设置后优先于 AILY_E2E_BOARD_KEYWORD
 *   $env:AILY_E2E_BOARD_KEYWORDS = 'uno r4,esp32'
 *   npm run test:e2e:fast -- full-flow.spec.ts
 *
 *   # 项目广场全量编译（单个项目失败后继续，最后汇总）
 *   $env:AILY_E2E_PROJECT_PLAZA = '1'
 *   npm run test:e2e:fast -- full-flow.spec.ts
 *
 * 本机需具备：内置 Node 工具链（child/node）和全局安装的 aily-builder 命令、该开发板可安装
 * （网络/缓存），以及对应编译器与 SDK 已安装于应用数据目录下的 aily-project/tools 与 sdk。
 */
const ENABLED = process.env['AILY_E2E_FULLFLOW'] === '1';
const ALL_BOARDS_ENABLED = process.env['AILY_E2E_ALL_BOARDS'] === '1';
const PROJECT_PLAZA_ENABLED = process.env['AILY_E2E_PROJECT_PLAZA'] === '1';
const CLEAR_APPDATA = process.env['AILY_E2E_CLEAR_APPDATA'] === '1';
const BOARD_KEYWORD = process.env['AILY_E2E_BOARD_KEYWORD'] || 'uno r4';
const BOARD_KEYWORDS = readBoardKeywords();
const SINGLE_BOARD_TIMEOUT_MS = readTimeoutEnv('AILY_E2E_SINGLE_BOARD_TIMEOUT_MS', 60 * 60_000);
const INSTALL_TIMEOUT_MS = readTimeoutEnv('AILY_E2E_INSTALL_TIMEOUT_MS', 30 * 60_000);
const COMPILE_TIMEOUT_MS = readTimeoutEnv('AILY_E2E_COMPILE_TIMEOUT_MS', 10 * 60_000);
const PROJECT_PLAZA_LOAD_TIMEOUT_MS = readTimeoutEnv('AILY_E2E_PROJECT_PLAZA_LOAD_TIMEOUT_MS', 3 * 60_000);
const PROJECT_PLAZA_INSTALL_TIMEOUT_MS = readTimeoutEnv(
  'AILY_E2E_PROJECT_PLAZA_INSTALL_TIMEOUT_MS',
  5 * 60_000,
);
const PROJECT_PLAZA_CONCURRENCY = readPositiveIntegerEnv('AILY_E2E_PROJECT_PLAZA_CONCURRENCY', 2);
const POLL_INTERVAL_MS = 250;
const BOARD_COMPILE_ATTEMPTS = 2;
const PROJECT_PLAZA_PAGE_SIZE = 100;

type BoardCandidate = {
  name: string;
  label: string;
};

type BoardTarget = string | BoardCandidate;

type ProjectPlazaCandidate = {
  id: string;
  name: string;
  page: number;
  index: number;
};

type PageLogBuffer = {
  messages: string[];
  totalMessages: number;
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

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.warn(`[e2e] 忽略无效配置 ${name}=${raw}，使用默认值 ${fallback}。`);
    return fallback;
  }
  return value;
}

function readBoardKeywords(): string[] {
  const raw = process.env['AILY_E2E_BOARD_KEYWORDS'];
  if (!raw) {
    return [BOARD_KEYWORD];
  }

  const keywords = raw
    .split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean);

  if (keywords.length === 0) {
    console.warn('[e2e] AILY_E2E_BOARD_KEYWORDS 未包含有效关键字，回退到 AILY_E2E_BOARD_KEYWORD。');
    return [BOARD_KEYWORD];
  }

  return keywords;
}

test.describe('全流程：创建或加载项目 → 编译', () => {
  const projectDirs: string[] = [];
  const singleBoardTest = ENABLED ? test : test.skip;
  const allBoardsTest = ALL_BOARDS_ENABLED ? test : test.skip;
  const projectPlazaTest = PROJECT_PLAZA_ENABLED ? test : test.skip;

  test.beforeAll(async () => {
    if (!(ENABLED || ALL_BOARDS_ENABLED || PROJECT_PLAZA_ENABLED)) {
      return;
    }

    if (!CLEAR_APPDATA) {
      console.log('[e2e] 保留现有应用数据；如需清空，请设置 AILY_E2E_CLEAR_APPDATA=1。');
      return;
    }

    await cleanGlobalAilyProjectDir();
    await bootstrapAfterGlobalDataCleanup();
  });

  test.afterAll(async () => {
    test.setTimeout(30 * 60_000);
    for (const projectDir of projectDirs) {
      await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  singleBoardTest('应能让指定开发板从选板子一路走到连续编译两次', async ({ electronApp }) => {
    test.setTimeout(SINGLE_BOARD_TIMEOUT_MS * BOARD_KEYWORDS.length);

    if (BOARD_KEYWORDS.length === 1) {
      const win = await getMainWindow(electronApp);
      const pageLog = attachDiagnostics(win);
      await createProjectAndCompile(win, BOARD_KEYWORDS[0], projectDirs, pageLog);
      return;
    }

    console.log(`[e2e] 将验证 ${BOARD_KEYWORDS.length} 个指定开发板：${BOARD_KEYWORDS.join(', ')}`);
    await closeAilyElectronApp(electronApp).catch(() => {});

    const failures: Array<{ keyword: string; message: string }> = [];
    for (const keyword of BOARD_KEYWORDS) {
      await test.step(`创建并编译 ${keyword}`, async () => {
        const launched = await launchAilyElectron();
        try {
          const isolatedWin = await getMainWindow(launched.app);
          const pageLog = attachDiagnostics(isolatedWin);
          await createProjectAndCompile(isolatedWin, keyword, projectDirs, pageLog);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ keyword, message });
          console.log(`[e2e] ${keyword} 失败：${message}`);
        } finally {
          await launched.close();
        }
      });
    }

    expect(
      failures.map((failure) => `${failure.keyword}: ${failure.message}`),
      '以下指定开发板未完成新建项目并连续编译两次',
    ).toEqual([]);
  });

  allBoardsTest('应能让所有可创建开发板完成新建项目并连续编译两次', async ({ electronApp }) => {
    // 全量开发板安装与两轮真实编译耗时较长，给整批运行留足时间。
    test.setTimeout(24 * 60 * 60 * 1000);

    const win = await getMainWindow(electronApp);
    attachDiagnostics(win);

    const boards = await collectCreatableBoards(win);
    expect(boards.length, '至少应发现一个可创建的开发板').toBeGreaterThan(0);
    test.setTimeout(Math.max(24 * 60 * 60 * 1000, boards.length * SINGLE_BOARD_TIMEOUT_MS));
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
      '以下开发板未完成新建项目并连续编译两次',
    ).toEqual([]);
  });

  projectPlazaTest('应能让项目广场的所有项目完成编译', async ({ electronApp }) => {
    test.setTimeout(24 * 60 * 60 * 1000);

    const win = await getMainWindow(electronApp);
    attachDiagnostics(win);

    const projects = await collectProjectPlazaProjects(win);
    expect(projects.length, '项目广场至少应返回一个项目').toBeGreaterThan(0);
    const workerCount = Math.min(PROJECT_PLAZA_CONCURRENCY, projects.length);
    const perProjectTimeout =
      PROJECT_PLAZA_LOAD_TIMEOUT_MS + PROJECT_PLAZA_INSTALL_TIMEOUT_MS + COMPILE_TIMEOUT_MS + 2 * 60_000;
    test.setTimeout(
      Math.max(24 * 60 * 60 * 1000, Math.ceil(projects.length / workerCount) * perProjectTimeout),
    );
    console.log(`[project-plaza] 将验证 ${projects.length} 个项目，并发数：${workerCount}。`);
    await closeAilyElectronApp(electronApp).catch(() => {});

    const failures: Array<{ project: ProjectPlazaCandidate; message: string }> = [];
    let nextProjectIndex = 0;
    let completedProjects = 0;
    const runWorker = async () => {
      while (nextProjectIndex < projects.length) {
        const projectIndex = nextProjectIndex++;
        const project = projects[projectIndex];
        const startedAt = Date.now();
        await test.step(`[${projectIndex + 1}/${projects.length}] 加载并编译 ${project.name}`, async () => {
          let launched: Awaited<ReturnType<typeof launchAilyElectron>> | undefined;
          try {
            launched = await launchAilyElectron();
            const isolatedWin = await getMainWindow(launched.app);
            const pageLog = attachDiagnostics(isolatedWin, `project-plaza:${project.name}`);
            await loadProjectPlazaProject(isolatedWin, project, pageLog, projectDirs);
            await compileProject(isolatedWin, pageLog, `项目广场：${project.name}`, 1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ project, message });
            console.log(`[project-plaza] ${project.name} (ID: ${project.id || '缺失'}) 失败：${message}`);
          } finally {
            if (launched) {
              await launched.close().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.log(`[project-plaza] ${project.name} Electron 关闭失败，继续下一个项目：${message}`);
              });
            }
          }
        });
        completedProjects++;
        console.log(
          `[project-plaza] 进度 ${completedProjects}/${projects.length}：${project.name}，耗时 ${formatDuration(Date.now() - startedAt)}。`,
        );
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    expect(
      failures.map(
        (failure) =>
          `${failure.project.name} (ID: ${failure.project.id || '缺失'}, 第 ${failure.project.page} 页第 ${failure.project.index + 1} 个): ${failure.message}`,
      ),
      '以下项目广场项目加载或编译失败',
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

async function clickAfterOnboarding(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  locator: ReturnType<Awaited<ReturnType<typeof getMainWindow>>['locator']>,
): Promise<void> {
  await dismissOnboardingIfVisible(win, 5_000);
  try {
    await locator.click();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/onboarding-overlay|intercepts pointer events/.test(message)) {
      throw error;
    }
    await dismissOnboardingIfVisible(win, 5_000);
    await locator.click();
  }
}

function attachDiagnostics(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  label = '',
): PageLogBuffer {
  const pageLog: PageLogBuffer = { messages: [], totalMessages: 0 };
  const labelSuffix = label ? `:${label}` : '';
  win.on('console', (msg) => {
    const text = msg.text();
    pageLog.totalMessages++;
    pageLog.messages.push(text);
    if (pageLog.messages.length > 500) {
      pageLog.messages.shift();
    }
    console.log(`[page${labelSuffix}:${msg.type()}] ${text}`);
  });
  win.on('pageerror', (err) => {
    const text = `[pageerror] ${err.message}`;
    pageLog.totalMessages++;
    pageLog.messages.push(text);
    if (pageLog.messages.length > 500) {
      pageLog.messages.shift();
    }
    console.log(`[pageerror${labelSuffix}] ${err.message}`);
  });
  win.on('requestfailed', (request) => {
    console.log(`[requestfailed${labelSuffix}] ${request.failure()?.errorText || 'unknown'} ${request.url()}`);
  });
  return pageLog;
}

async function openProjectNew(win: Awaited<ReturnType<typeof getMainWindow>>): Promise<void> {
  await dismissOnboardingIfVisible(win);
  await navigate(win, '/main/project-new');
  await expect(win.locator('app-project-new .project-new-box')).toBeVisible();
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
    await win.waitForTimeout(POLL_INTERVAL_MS);
  }

  // 清空全局缓存后的首次加载中，ProjectNewComponent 可能先用空 boardList 初始化；
  // ConfigService 随后才异步写入 boardList。重新进入一次页面可让组件读取已完成的配置。
  console.log('[e2e] 未发现开发板卡片，重新进入新建项目页以避开首次配置加载竞态。');
  await navigate(win, '/main/guide');
  await win.waitForTimeout(POLL_INTERVAL_MS);
  await openProjectNew(win);

  while (Date.now() < deadline) {
    if ((await boardCards.count()) > 0) {
      await expect(boardCards.first()).toBeVisible({ timeout: 5_000 });
      return boardCards;
    }
    await win.waitForTimeout(POLL_INTERVAL_MS);
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

    await clickAfterOnboarding(win, card);
    const useThisBtn = win.locator('app-project-new .desc-box .next button').first();
    if (!(await useThisBtn.isVisible().catch(() => false))) {
      continue;
    }

    await clickAfterOnboarding(win, useThisBtn);
    const boardInput = win.locator('app-project-new input.board[disabled]').first();
    await expect(boardInput).toBeVisible({ timeout: 10_000 });
    const name = (await boardInput.inputValue()).trim();
    if (name) {
      boards.push({ name, label });
    }

    const prevBtn = win.locator('app-project-new .step-btns button.ant-btn-default').first();
    await clickAfterOnboarding(win, prevBtn);
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

async function collectProjectPlazaProjects(
  win: Awaited<ReturnType<typeof getMainWindow>>,
): Promise<ProjectPlazaCandidate[]> {
  await dismissOnboardingIfVisible(win);
  const firstResponsePromise = win.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/api/v1/cloud/projects/public') && !url.searchParams.get('id');
    },
    { timeout: 60_000 },
  );
  await navigate(win, '/main/playground/list');

  const initialResponse = await firstResponsePromise;
  const responseUrl = new URL(initialResponse.url());
  responseUrl.searchParams.set('page', '1');
  responseUrl.searchParams.set('perPage', String(PROJECT_PLAZA_PAGE_SIZE));

  const firstResponse = await win.request.get(responseUrl.toString());
  const firstPage = await readProjectPlazaPage(firstResponse, 1);
  const pageSize = firstPage.projects.length || 1;
  const pageCount = Math.ceil(firstPage.total / pageSize);
  const pages = [firstPage];

  for (let page = 2; page <= pageCount; page++) {
    responseUrl.searchParams.set('page', String(page));
    const response = await win.request.get(responseUrl.toString());
    pages.push(await readProjectPlazaPage(response, page));
  }

  const projects: ProjectPlazaCandidate[] = [];
  const seenIds = new Set<string>();
  for (const page of pages) {
    page.projects.forEach((project, index) => {
      const id = String(project?.id ?? project?.uuid ?? '').trim();
      if (id && seenIds.has(id)) {
        return;
      }
      if (id) {
        seenIds.add(id);
      }

      projects.push({
        id,
        name: String(project?.nickname || project?.name || `未命名项目 ${id || `${page.page}-${index + 1}`}`),
        page: page.page,
        index,
      });
    });
  }

  if (projects.length !== firstPage.total) {
    console.warn(
      `[project-plaza] API 声明共有 ${firstPage.total} 个项目，实际收集到 ${projects.length} 个去重项目。`,
    );
  }
  return projects;
}

async function readProjectPlazaPage(
  response: {
    ok: () => boolean;
    status: () => number;
    json: () => Promise<any>;
  },
  page: number,
): Promise<{ page: number; projects: any[]; total: number }> {
  if (!response.ok()) {
    throw new Error(`[project-plaza] 获取第 ${page} 页失败：HTTP ${response.status()}。`);
  }

  const payload = await response.json();
  if (payload?.status !== 200 || !Array.isArray(payload?.data?.list)) {
    throw new Error(`[project-plaza] 第 ${page} 页返回格式异常：${JSON.stringify(payload).slice(0, 500)}`);
  }

  return {
    page,
    projects: payload.data.list,
    total: Number(payload.data.total) || payload.data.list.length,
  };
}

async function loadProjectPlazaProject(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  project: ProjectPlazaCandidate,
  pageLog: PageLogBuffer,
  projectDirs: string[],
): Promise<string> {
  if (!project.id) {
    throw new Error(
      `[project-plaza] 项目缺少可用于加载的 id（第 ${project.page} 页第 ${project.index + 1} 个）。`,
    );
  }

  const loadDeadline = Date.now() + PROJECT_PLAZA_LOAD_TIMEOUT_MS;
  const loadLogStart = pageLog.totalMessages;
  await dismissOnboardingIfVisible(win);
  await navigate(win, `/main/playground/list?id=${encodeURIComponent(project.id)}`);

  let editorRoute = '';
  while (Date.now() < loadDeadline) {
    editorRoute = await win.evaluate(() => window.location.hash);
    if (/\/main\/(blockly|code)-editor/.test(editorRoute)) {
      break;
    }

    const messageText =
      (await win.locator('.ant-message-error').last().innerText().catch(() => '')) || '';
    if (/加载示例失败|load example failed/i.test(messageText)) {
      throw new Error(`[project-plaza] 加载项目失败：${messageText.trim()}`);
    }
    await win.waitForTimeout(POLL_INTERVAL_MS);
  }

  if (!/\/main\/(blockly|code)-editor/.test(editorRoute)) {
    throw new Error(`[project-plaza] 加载项目超时（${PROJECT_PLAZA_LOAD_TIMEOUT_MS}ms）。`);
  }

  const projectDir = await win.evaluate(() => {
    const route = new URL(window.location.hash.slice(1), 'https://e2e.local');
    return route.searchParams.get('path') || '';
  });
  if (!projectDir) {
    throw new Error('[project-plaza] 项目已进入编辑器，但路由中未找到项目路径。');
  }
  projectDirs.push(projectDir);

  if (/\/main\/blockly-editor/.test(editorRoute)) {
    await waitForBlocklyProjectLoaded(win, pageLog, loadLogStart, project.name, loadDeadline);
    await waitForDependencyInstallDone(win, pageLog, PROJECT_PLAZA_INSTALL_TIMEOUT_MS);
  } else {
    const remainingLoadTime = Math.max(1, loadDeadline - Date.now());
    await expect(win.locator('app-header .project-box')).not.toHaveText('', {
      timeout: Math.min(30_000, remainingLoadTime),
    });
  }

  const compileBtn = win.locator('app-header app-act-btn[data-action="compile"]');
  await expect(compileBtn).toBeVisible({ timeout: 60_000 });
  return projectDir;
}

async function waitForBlocklyProjectLoaded(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  pageLog: PageLogBuffer,
  loadLogStart: number,
  projectName: string,
  deadline: number,
): Promise<void> {
  let lastStatus = '';

  while (Date.now() < deadline) {
    if (win.isClosed()) {
      throw new Error('[project-plaza] Blockly 项目加载期间 Electron 页面意外关闭。');
    }

    const [state, footerText] = await withTimeout(
      Promise.all([
        win.evaluate(() => {
          const projectService = (window as any).projectService;
          return String(projectService?.stateSubject?.value || '');
        }),
        win.locator('app-footer .state').innerText().catch(() => ''),
      ]),
      Math.max(1, deadline - Date.now()),
      `[project-plaza] ${projectName} 的 Blockly 项目加载超过 ${PROJECT_PLAZA_LOAD_TIMEOUT_MS}ms。`,
    );
    const normalizedFooterText = footerText.trim();
    const status = `state=${state || 'unknown'} footer="${normalizedFooterText}"`;
    if (status !== lastStatus) {
      console.log(`[project-plaza:load:${projectName}] ${status}`);
      lastStatus = status;
    }

    if (state === 'loaded') {
      return;
    }
    if (state === 'error') {
      throw new Error(`[project-plaza] Blockly 项目加载失败，最后阶段：${normalizedFooterText || '未知'}。`);
    }

    const firstStoredMessage = pageLog.totalMessages - pageLog.messages.length;
    const loadLogs = pageLog.messages.slice(Math.max(0, loadLogStart - firstStoredMessage)).join('\n');
    if (/\[ProjectService\] project open completion timed out:|\[pageerror\]/i.test(loadLogs)) {
      const lastError = loadLogs
        .split('\n')
        .filter((line) => /\[ProjectService\] project open completion timed out:|\[pageerror\]/i.test(line))
        .at(-1);
      throw new Error(`[project-plaza] Blockly 项目加载异常：${lastError}`);
    }

    await win.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error(
    `[project-plaza] Blockly 项目加载超时（${PROJECT_PLAZA_LOAD_TIMEOUT_MS}ms），最后状态：${lastStatus || '未知'}。`,
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
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

  // 6) 等待依赖安装完成后再点击编译；预编译可由后台完成，也可由编译流程同步接管。
  await waitForDependencyInstallDone(win, pageLog);

  // 7) 首次完整编译成功后再执行第二次增量编译；首次失败时不再重试。
  const boardName = typeof boardTarget === 'string' ? boardTarget : boardTarget.name;
  await compileProject(win, pageLog, `${boardName} / ${projectName}`, BOARD_COMPILE_ATTEMPTS);
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
    await win.waitForTimeout(250);
    await expect(boardCards.first()).toBeVisible({ timeout: 15_000 });
    await dismissOnboardingIfVisible(win, 5_000);
    await boardCards.first().click();
    return;
  }

  await searchInput.fill('');
  await win.waitForTimeout(250);
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

async function waitForDependencyInstallDone(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  pageLog: PageLogBuffer,
  timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<void> {
  console.log('[e2e] 等待依赖安装完成后触发编译；后台预编译若未启动则交给编译流程处理。');

  const deadline = Date.now() + timeoutMs;
  let sawInstallDoneAt = 0;
  while (Date.now() < deadline) {
    const joined = pageLog.messages.join('\n');
    const noticeText = await getNoticeText(win);
    const installDone = /install board dependencies success|开发板依赖安装完成|依赖安装完成/.test(joined);
    const installNoticeSettled = !/依赖安装中|Installing|installing/i.test(noticeText);
    const precompileStarted = /开始预编译|执行预编译|检测到依赖变化，准备重新预处理/.test(joined);
    const precompileDone = /后台预处理完成|同步预处理完成|发现预编译缓存|预编译完成/.test(joined);
    const installFailed = /依赖安装失败|开发板依赖安装失败|installation failed/i.test(`${joined}\n${noticeText}`);

    if (installFailed) {
      throw new Error(`[e2e] 依赖安装失败：${noticeText.trim() || '请查看上方 [page] 日志。'}`);
    }

    if (installDone && !sawInstallDoneAt) {
      sawInstallDoneAt = Date.now();
    }

    if (installDone && precompileDone) {
      return;
    }

    // 安装已结束但后台预编译没有启动时，不继续空等。正式编译会检查缓存并同步预编译。
    if (installDone && installNoticeSettled && !precompileStarted) {
      return;
    }

    // 如果后台预编译已启动，给它一个很短的自然收尾窗口；之后仍由编译按钮接管。
    if (installDone && installNoticeSettled && precompileStarted && Date.now() - sawInstallDoneAt > 2_000) {
      return;
    }

    const compileRejected = /Cannot start build from state: INSTALLING/.test(joined);
    if (compileRejected) {
      throw new Error('[e2e] 测试过早触发编译：应用仍处于 INSTALLING 状态。');
    }

    await win.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error(`[e2e] 等待依赖安装完成超时（${timeoutMs}ms）。`);
}

async function getNoticeText(win: Awaited<ReturnType<typeof getMainWindow>>): Promise<string> {
  const title = (await win.locator('app-notification .text-box .ellipsis').first().innerText().catch(() => '')) || '';
  const text = (await win.locator('app-notification .text-box .ellipsis.text').innerText().catch(() => '')) || '';
  return `${title}\n${text}`;
}

async function compileProject(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  pageLog: PageLogBuffer,
  projectLabel: string,
  attempts: number,
): Promise<void> {
  const failures: Array<{ attempt: number; message: string }> = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptLabel = attempts > 1 ? `第 ${attempt} 次编译` : '编译';
    console.log(`[compile] ${projectLabel}：开始${attemptLabel}。`);
    try {
      await compileOnce(win, pageLog, attemptLabel);
      console.log(`[compile] ${projectLabel}：${attemptLabel}成功。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ attempt, message });
      console.log(`[compile] ${projectLabel}：${attemptLabel}失败：${message}`);
      break;
    }
  }

  if (failures.length > 0) {
    throw new Error(
      failures
        .map((failure) => `${attempts > 1 ? `第 ${failure.attempt} 次编译` : '编译'}失败：${failure.message}`)
        .join('；'),
    );
  }
}

async function compileOnce(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  pageLog: PageLogBuffer,
  attemptLabel: string,
): Promise<void> {
  const compileBtn = win.locator('app-header app-act-btn[data-action="compile"]');
  await expect(compileBtn).toBeVisible({ timeout: 60_000 });
  await expect(compileBtn.locator('.lloading')).toHaveCount(0, { timeout: 15_000 });

  const compileLogStart = pageLog.totalMessages;
  const noticeBeforeCompile = await getNoticeText(win);
  await dismissOnboardingIfVisible(win, 5_000);
  await compileBtn.click();
  await waitForCompileDone(win, pageLog, compileLogStart, noticeBeforeCompile, attemptLabel);
}

async function waitForCompileDone(
  win: Awaited<ReturnType<typeof getMainWindow>>,
  pageLog: PageLogBuffer,
  compileLogStart: number,
  noticeBeforeCompile: string,
  attemptLabel: string,
): Promise<void> {
  // 编译进度/结果通过 NoticeService 显示在 <app-notification>（非 footer）。
  // 成功：title="编译完成"、text 含 "Flash"；失败：title="编译失败"。
  const noticeTitle = win.locator('app-notification .text-box .ellipsis').first();
  const noticeText = win.locator('app-notification .text-box .ellipsis.text');

  const compileDeadline = Date.now() + COMPILE_TIMEOUT_MS;
  let compileResult = '';
  let lastError = '';
  let lastStatusLine = '';
  while (Date.now() < compileDeadline) {
    if (win.isClosed()) {
      throw new Error(`${attemptLabel}期间 Electron 页面意外关闭。`);
    }

    const title = (await noticeTitle.innerText().catch(() => '')) || '';
    const text = (await noticeText.innerText().catch(() => '')) || '';
    const doneBox = await win.locator('app-notification .box.done').count();
    const errBox = await win.locator('app-notification .box.error').count();
    const loading = await win.locator('app-header app-act-btn[data-action="compile"] .lloading').count();
    const firstStoredMessage = pageLog.totalMessages - pageLog.messages.length;
    const compileLogs = pageLog.messages.slice(Math.max(0, compileLogStart - firstStoredMessage)).join('\n');
    const statusLine = `[compile:${attemptLabel}] title="${title.trim()}" text="${text.trim()}" loading=${loading} done=${doneBox} err=${errBox}`;
    if (statusLine !== lastStatusLine) {
      console.log(statusLine);
      lastStatusLine = statusLine;
    }

    const successByNotice = doneBox > 0 || /编译完成/.test(title) || /Flash|RAM/.test(text);
    const successByLog =
      /编译命令完成：\s*buildCompleted=\s*true\s+isErrored=\s*false/.test(compileLogs) ||
      /lastBuildStatus:\s*success/.test(compileLogs) ||
      /编译耗时:\s*\d/.test(compileLogs);
    const noticeChanged = `${title}\n${text}` !== noticeBeforeCompile;

    if ((noticeChanged && successByNotice) || successByLog) {
      compileResult = 'done';
      break;
    }

    const failureByNotice = errBox > 0 || /编译失败|预编译失败/.test(title);
    const failureByLog =
      /buildCompleted=\s*false|isErrored=\s*true|lastBuildStatus:\s*error/.test(compileLogs) ||
      /编译失败，耗时|编译未完成，耗时|编译过程中发生错误|Cannot start build from state/.test(
        compileLogs,
      );
    if ((noticeChanged && failureByNotice) || failureByLog) {
      compileResult = 'error';
      lastError = `title="${title.trim()}" text="${text.trim()}"`;
      break;
    }
    await win.waitForTimeout(500);
  }
  if (compileResult !== 'done') {
    throw new Error(
      `${attemptLabel}未成功完成（请查看上方 [compile:${attemptLabel}]/[page] 日志）。最后错误状态：${lastError || '超时或无明确错误'}`,
    );
  }
}
