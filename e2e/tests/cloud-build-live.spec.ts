import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

const seed = process.env['AILY_E2E_CLOUD_SEED'];
const enabled = process.env['AILY_E2E_CLOUD_LIVE'] === '1';
const accessToken = process.env['AILY_E2E_CLOUD_ACCESS_TOKEN'];
const boardModule = '@aily-project/board-esp32s3';

for (const mode of ['blockly', 'coder'] as const) test(`${mode}: real cloud compilation, signed artifact reuse and source invalidation`, async ({}, info) => {
  test.skip(!enabled || !seed || !accessToken, 'Opt in with AILY_E2E_CLOUD_LIVE=1, an installed package seed and a Pro test access token.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-cloud-merge-')));
  const project = path.join(root, 'project');
  const write = async (file: string, content: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  const boardRoot = path.join(seed!, 'node_modules', boardModule);
  await cp(path.join(boardRoot, 'template'), project, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  manifest.name = `cloud-merge-${mode}`;
  if (mode === 'coder') {
    Object.assign(manifest, { type: 'coder', framework: 'arduino', entry: 'src/main.cpp', dependencies: { [boardModule]: '3.3.10' } });
    await rm(path.join(project, 'project.abi'));
    await write(path.join(project, 'sketch/src/main.cpp'), '#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n');
  }
  await write(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2));
  const copied = new Set<string>();
  async function copyPackage(name: string) {
    if (copied.has(name)) return;
    copied.add(name);
    const source = [seed, process.env['AILY_E2E_CLOUD_LIBRARY_SEED']].filter(Boolean)
      .map(root => path.join(root!, 'node_modules', name)).find(root => existsSync(path.join(root, 'package.json')));
    if (!source) throw new Error(`Missing package seed: ${name}`);
    await cp(source, path.join(project, 'node_modules', name), { recursive: true });
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(pkg.dependencies || {})) await copyPackage(dependency);
  }
  for (const name of Object.keys(manifest.dependencies)) await copyPackage(name);
  const probe = path.join(project, 'components/merge_probe/merge_probe.h');
  await write(probe, '#pragma once\n');
  const boardBefore = await readFile(path.join(project, 'node_modules', boardModule, 'board.json'), 'utf8');
  const launch = await launchAilyElectron({ environment: { AILY_BUILD_PRODUCT: mode }, config: {
    selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: { backend: 'local' },
    devmode: { enabled: true, autoSave: false },
  } });
  const errors: string[] = [];
  try {
    if (mode === 'coder') await cp(path.join(seed!, 'npm-global/app/store/subapp-aily-coder-editor'),
      path.join(launch.userDataDir, 'npm-global/app/store/subapp-aily-coder-editor'), { recursive: true, verbatimSymlinks: true });
    const win = await getMainWindow(launch.app);
    win.on('pageerror', error => errors.push(error.message));
    await win.addLocatorHandler(win.locator('app-login .login-close'), button => button.click());
    await expect.poll(() => win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window'))
      .authService.getAuthInitializationState())).toBe('signed_out');
    // Write only to the disposable profile; keep the token out of Playwright IPC traces.
    await writeFile(path.join(launch.userDataDir, '.aily'), JSON.stringify({ access_token: accessToken }), { mode: 0o600 });
    await win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window')).authService.initializeAuth());
    await expect.poll(() => win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window'))
      .authService.canUseCloudCompilation)).toBe(true);
    await win.evaluate(() => (window as any).electronAPI.subWindow.open({ path: 'settings', windowClass: 'builtin', width: 700, height: 550 }));
    await expect.poll(() => launch.app.windows().some(page => page.url().includes('#/settings'))).toBe(true);
    const settings = launch.app.windows().find(page => page.url().includes('#/settings'))!;
    await settings.locator('app-settings').waitFor();
    await settings.evaluate(() => {
      const w = window as any;
      const component = w.ng.getComponent(document.querySelector('app-settings'));
      Object.defineProperty(component, 'showCloudCompilation', { get: () => true });
      w.ng.applyChanges(component);
    });
    const toggle = settings.locator('#cloud-compilation-enabled');
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toHaveClass(/ant-switch-checked/);
    await toggle.click();
    await expect(toggle).toHaveClass(/ant-switch-checked/);
    await expect.poll(async () => JSON.parse(await readFile(path.join(launch.userDataDir, 'config.json'), 'utf8')).compile.backend).toBe('cloud');
    await expect.poll(() => win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-header')).configService.getCompileBackend())).toBe('cloud');
    await settings.screenshot({ path: info.outputPath(`${mode}-settings.png`) });
    await settings.locator('.window-footer button').first().click();

    if (mode === 'blockly') {
      await openBlocklyProject(win, project);
      await expect.poll(async () => (await readAilyHostOperation(launch.app, 'project_load_status', project)).ready, { timeout: 120_000 }).toBe(true);
    } else {
      await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
      await expect(win.locator('iframe.coder-embed-frame.is-ready')).toHaveCount(1, { timeout: 120_000 });
      await expect.poll(() => win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.getProjectDependencyStatus(project), project)).toBe('ready');
    }
    const menu = await win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.getBoardConfigMenu());
    expect(menu.some((item: any) => item.key === 'CDCOnBoot' && item.children?.length)).toBe(true);
    const started = Date.now();
    await win.locator('app-header app-act-btn[data-action="compile"]').click();
    await expect.poll(async () => {
      const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
      return Date.parse(pkg.buildInfo?.lastBuildTime || '') >= started ? pkg.buildInfo.lastBuildStatus : 'pending';
    }, { timeout: 240_000, intervals: [500, 1000] }).toBe('success');
    await expect(win.locator('body')).toContainText(/云编译完成 \(耗时: \d+\.\d{2}s\)/);
    const artifactPath = await win.evaluate(project => (window as any).cloudBuild.artifactPath({ projectPath: project }), project);
    expect(typeof artifactPath).toBe('string');
    const result = JSON.parse(await readFile(path.join(artifactPath, 'aily-cloud-result.json'), 'utf8'));
    expect(result.manifest).toMatchObject({ runner: 'aily-builder', action: 'compile', boardModule });
    expect(result.signature.algorithm).toBe('Ed25519');
    expect(result.manifest.artifacts.length).toBeGreaterThan(0);
    const reuse = () => win.evaluate(async ({ project, mode }) => {
      const w = window as any;
      return mode === 'blockly'
        ? w.ng.getComponent(document.querySelector('app-blockly-editor'))._builderService.canReuseBuildForUpload(() => false)
        : w.ng.getComponent(document.querySelector('app-header')).builderService.canReuseBuildForUpload(project);
    }, { project, mode });
    expect(await reuse()).toBe(true);
    // A second Compile verifies live inputs/target and every signed byte,
    // without submitting a new job for the same result.
    await win.evaluate(() => {
      const w = window as any;
      w.__liveCloudEvents = [];
      w.cloudBuild.onProgress((event: any) => w.__liveCloudEvents.push(event));
    });
    const repeatedAt = Date.now();
    await win.locator('app-header app-act-btn[data-action="compile"]').click();
    await expect.poll(async () => {
      const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
      return Date.parse(pkg.buildInfo?.lastBuildTime || '') >= repeatedAt ? pkg.buildInfo.lastBuildStatus : 'pending';
    }, { timeout: 30_000, intervals: [200, 500] }).toBe('success');
    expect(await win.evaluate(project => (window as any).cloudBuild.artifactPath({ projectPath: project }), project)).toBe(artifactPath);
    const repeatedEvents = await win.evaluate(() => (window as any).__liveCloudEvents);
    expect(repeatedEvents.some((event: any) => event.stage === 'complete' && event.reused === true)).toBe(true);
    expect(repeatedEvents.some((event: any) => event.stage === 'queued')).toBe(false);
    await expect(win.locator('body')).toContainText(/已复用云编译结果 \(耗时: \d+\.\d{2}s\)/);
    expect(await reuse()).toBe(true);
    // Invalid serial input must be rejected before any physical device is opened.
    const uploadError = await win.evaluate(async project => {
      try { await (window as any).cloudBuild.upload({ projectPath: project, requestId: 'merge-invalid-port', serialPort: 'TEST-NO-DEVICE' }); return null; }
      catch (error: any) { return error.code; }
    }, project);
    expect(uploadError).toBe('UPLOAD_INVALID');
    await write(probe, '#pragma once\n// changed after compilation\n');
    expect(await reuse()).toBe(false);
    expect(await readFile(path.join(project, 'node_modules', boardModule, 'board.json'), 'utf8')).toBe(boardBefore);
    expect(existsSync(path.join(launch.userDataDir, 'sdk/esp32_3.3.10'))).toBe(false);
    expect(existsSync(path.join(launch.userDataDir, 'tools/esp-x32@14.2.0'))).toBe(false);
    await win.screenshot({ path: info.outputPath(`${mode}-compiled.png`) });
    await info.attach('cloud-build-result', { body: JSON.stringify({ mode, manifest: result.manifest, errors }, null, 2), contentType: 'application/json' });
    expect(errors).toEqual([]);
  } finally {
    await launch.close();
    await rm(root, { recursive: true, force: true });
  }
});
