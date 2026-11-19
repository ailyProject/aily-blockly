import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

// Real Gateway and IPC, with disposable board metadata and Pro client state.
// This verifies automatic local routing; it does not claim a successful compilation.
for (const mode of ['blockly', 'coder'] as const) test(`${mode}: live board support reaches the shared project preflight`, async ({}, info) => {
  test.skip(process.env['AILY_E2E_BOARD_SUPPORT_LIVE'] !== '1', 'Opt in to real Gateway board support checks.');
  const boardModule = '@aily-project/board-esp32s3dev', boardVersion = '3.2.1';
  const project = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-board-support-')));
  const boardRoot = path.join(project, 'node_modules', boardModule);
  await mkdir(boardRoot, { recursive: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'board-support-check', type: 'coder', dependencies: { [boardModule]: boardVersion } }));
  await writeFile(path.join(boardRoot, 'package.json'), JSON.stringify({ name: boardModule, version: boardVersion }));
  await writeFile(path.join(boardRoot, 'board.json'), '{}');
  const launch = await launchAilyElectron({ environment: { AILY_BUILD_PRODUCT: mode }, config: {
    selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: { backend: 'cloud' },
    devmode: { enabled: true, autoSave: false },
  } });
  try {
    const main = await getMainWindow(launch.app);
    await main.addLocatorHandler(main.locator('app-login .login-close'), button => button.click());
    await expect.poll(() => main.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window'))
      .authService.getAuthInitializationState())).toBe('signed_out');
    await main.evaluate(() => {
      const auth = (window as any).ng.getComponent(document.querySelector('app-main-window')).authService;
      auth.isLoggedInSubject.next(true);
      auth.setCurrentUserInfo({ id: 'board-support-fixture', subscription_plan: { name: 'pro' } });
    });
    await expect.poll(() => main.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-header'))
      .configService.getCompileBackend())).toBe('cloud');
    await main.evaluate(() => {
      const w = window as any, original = w.cloudBuild;
      w.__boardSupportRequests = [];
      w.cloudBuild = { ...original, boardSupport: async (options: any) => {
        const response = await original.boardSupport(options);
        w.__boardSupportRequests.push({ options, response });
        return response;
      } };
    });
    const result = await main.evaluate(async projectPath => {
      const service = (window as any).ng.getComponent(document.querySelector('app-header')).projectService;
      const context = service.getCoderProjectContext(projectPath);
      const backend = await context.resolveCompileBackend(undefined, true);
      return { backend, cloud: context.isCloudBuild(), saved: context.configService.data.compile.backend };
    }, project);
    const requests = await main.evaluate(() => (window as any).__boardSupportRequests);
    const support = requests.find((request: any) => request.response);
    expect(support).toBeTruthy();
    expect(support.options.boardModule).toBe(boardModule);
    expect(support.options.boardVersion).toBe(boardVersion);
    await info.attach('live-board-support', { body: JSON.stringify({ mode, result, requests }, null, 2), contentType: 'application/json' });
    test.skip(support.response.supported, 'Gateway now supports this board; fallback scenario is no longer available.');
    expect(result).toEqual({ backend: 'local', cloud: false, saved: 'cloud' });
    expect(requests).toHaveLength(1);
  } finally {
    await launch.close();
    await rm(project, { recursive: true, force: true });
  }
});

for (const loginTiming of ['before-open', 'after-open', 'during-preparation']) test(`unsupported board completes a real local Blockly compilation: ${loginTiming}`, async ({}, info) => {
  const loginAfterOpen = loginTiming !== 'before-open';
  const seed = process.env['AILY_E2E_CLOUD_SEED'];
  const toolchain = process.env['AILY_E2E_BOARD_SUPPORT_TOOLCHAIN_SEED'];
  test.skip(!seed || !toolchain || process.env['AILY_E2E_BOARD_SUPPORT_LOCAL'] !== '1', 'Requires installed board packages and the matching local toolchain.');
  test.setTimeout(600_000);
  const boardModule = '@aily-project/board-esp32s3dev';
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-local-fallback-')));
  const project = path.join(root, 'project');
  await cp(path.join(seed!, 'node_modules', boardModule, 'template'), project, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  manifest.name = 'board-support-local-compile';
  const copied = new Set<string>();
  const copyPackage = async (name: string) => {
    if (copied.has(name)) return;
    copied.add(name);
    const source = [seed, process.env['AILY_E2E_CLOUD_LIBRARY_SEED']].filter(Boolean)
      .map(directory => path.join(directory!, 'node_modules', name)).find(directory => existsSync(path.join(directory, 'package.json')));
    if (!source) throw new Error(`Missing installed package: ${name}`);
    await cp(source, path.join(project, 'node_modules', name), { recursive: true });
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    if (manifest.dependencies[name]) manifest.dependencies[name] = pkg.version;
    for (const dependency of Object.keys(pkg.dependencies || {})) await copyPackage(dependency);
  };
  for (const name of Object.keys(manifest.dependencies)) await copyPackage(name);
  await writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2));
  const launch = await launchAilyElectron({ environment: {
    AILY_BUILD_PRODUCT: 'blockly', AILY_E2E_TOOLCHAIN_SEED: toolchain!, AILY_E2E_TOOLCHAIN_PROJECT: project,
  }, config: { selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: { backend: 'cloud' },
    devmode: { enabled: true, autoSave: false } } });
  try {
    const main = await getMainWindow(launch.app);
    await main.addLocatorHandler(main.locator('app-login .login-close'), button => button.click());
    await expect.poll(() => main.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window'))
      .authService.getAuthInitializationState())).toBe('signed_out');
    if (loginTiming === 'during-preparation') await main.evaluate(() => {
      // Hold one real preparation boundary to reproduce login during a slow SDK
      // preparation. The original implementation still runs after release.
      const w = window as any, npm = w.ng.getComponent(document.querySelector('app-main-window')).npmService;
      const original = npm.installBoardDeps.bind(npm);
      npm.installBoardDeps = async (...args: any[]) => {
        npm.installBoardDeps = original;
        await new Promise<void>(resolve => { w.__releaseBoardPreparation = resolve; });
        return original(...args);
      };
    });
    if (loginAfterOpen) {
      await openBlocklyProject(main, project);
      await expect.poll(async () => (await readAilyHostOperation(launch.app, 'project_load_status', project)).ready,
        { timeout: 120_000 }).toBe(true);
    }
    await main.evaluate(() => {
      const w = window as any, auth = w.ng.getComponent(document.querySelector('app-main-window')).authService;
      auth.isLoggedInSubject.next(true);
      auth.setCurrentUserInfo({ id: 'local-fallback-fixture', subscription_plan: { name: 'pro' } });
      const original = w.cloudBuild;
      w.__fallbackSupport = [];
      w.__cloudSubmissions = 0;
      w.cloudBuild = { ...original,
        boardSupport: async (options: any) => { const result = await original.boardSupport(options); w.__fallbackSupport.push(result); return result; },
        run: async (options: any) => { w.__cloudSubmissions++; return original.run(options); },
      };
    });
    if (loginTiming === 'during-preparation') {
      await expect.poll(() => main.evaluate(() => typeof (window as any).__releaseBoardPreparation)).toBe('function');
      await main.evaluate(() => (window as any).__releaseBoardPreparation());
      await expect.poll(() => main.evaluate(projectPath => {
        const component = (window as any).ng.getComponent(document.querySelector('app-blockly-editor'));
        return { loaded: component.loadedProjectPath, error: component.projectService.getBlocklyProjectLoadStatus(projectPath).error || '' };
      }, project), { timeout: 10_000 }).toEqual({ loaded: project, error: '' });
    }
    if (!loginAfterOpen) await openBlocklyProject(main, project);
    await expect.poll(async () => (await readAilyHostOperation(launch.app, 'project_load_status', project)).ready,
      { timeout: 120_000 }).toBe(true);
    const readBackend = () => main.evaluate(() => {
      const header = (window as any).ng.getComponent(document.querySelector('app-header'));
      return { cloud: header.projectService.isCloudBuild(), saved: header.configService.data.compile.backend };
    });
    if (!loginAfterOpen) await expect.poll(readBackend).toEqual({ cloud: false, saved: 'cloud' });
    const started = Date.now();
    await main.locator('app-header app-act-btn[data-action="compile"]').click();
    await expect.poll(async () => {
      const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
      return Date.parse(pkg.buildInfo?.lastBuildTime || '') >= started ? pkg.buildInfo.lastBuildStatus : 'pending';
    }, { timeout: 240_000, intervals: [1000] }).toBe('success');
    const evidence = await main.evaluate(() => ({
      support: (window as any).__fallbackSupport, cloudSubmissions: (window as any).__cloudSubmissions,
    }));
    expect(evidence.support.some((result: any) => result.supported === false)).toBe(true);
    expect(evidence.cloudSubmissions).toBe(0);
    const backend = await readBackend();
    expect(backend).toEqual({ cloud: false, saved: 'cloud' });
    if (loginAfterOpen) {
      await main.evaluate(async projectPath => {
        const service = (window as any).ng.getComponent(document.querySelector('app-header')).projectService;
        const opened = await service.projectOpen(projectPath, { reason: 'reload' });
        if (!opened) throw new Error('Project reload did not complete.');
      }, project);
      await expect.poll(async () => (await readAilyHostOperation(launch.app, 'project_load_status', project)).ready).toBe(true);
    }
    await info.attach('local-fallback', { body: JSON.stringify({ backend, ...evidence }, null, 2), contentType: 'application/json' });
    await main.screenshot({ path: info.outputPath('local-fallback-compiled.png') });
  } finally {
    await launch.close();
    await rm(root, { recursive: true, force: true });
  }
});
