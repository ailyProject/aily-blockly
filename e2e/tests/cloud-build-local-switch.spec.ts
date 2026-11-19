import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

// Real gateway and local compiler round trips, using a disposable profile/project.
// Upload checks end before device access; no physical board is flashed.
for (const mode of ['blockly', 'coder'] as const) test(`${mode}: switch cloud/local repeatedly within AI and upload tasks`, async ({}, info) => {
  const seed = process.env['AILY_E2E_CLOUD_SEED'];
  const accessToken = process.env['AILY_E2E_CLOUD_ACCESS_TOKEN'];
  test.skip(process.env['AILY_E2E_CLOUD_LOCAL_SWITCH'] !== '1' || !seed || !accessToken, 'Requires a Pro test token and installed board/toolchain seed.');
  test.setTimeout(600_000);
  const boardModule = '@aily-project/board-esp32s3';
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-cloud-local-')));
  try {
    const project = path.join(root, 'project');
    await cp(path.join(seed!, 'node_modules', boardModule, 'template'), project, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    manifest.name = `cloud-local-${mode}`;
    if (mode === 'coder') {
      Object.assign(manifest, { type: 'coder', framework: 'arduino', entry: 'src/main.cpp', dependencies: { [boardModule]: '3.3.10' } });
      await rm(path.join(project, 'project.abi'));
      await mkdir(path.join(project, 'sketch/src'), { recursive: true });
      await writeFile(path.join(project, 'sketch/src/main.cpp'), '#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n');
    }
    const copied = new Set<string>();
    async function copyPackage(name: string) {
      if (copied.has(name)) return;
      copied.add(name);
      const source = [seed, process.env['AILY_E2E_CLOUD_LIBRARY_SEED']].filter(Boolean)
        .map(root => path.join(root!, 'node_modules', name)).find(root => existsSync(path.join(root, 'package.json')));
      if (!source) throw new Error(`Missing installed package: ${name}`);
      await cp(source, path.join(project, 'node_modules', name), { recursive: true });
      const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
      if (manifest.dependencies[name]) manifest.dependencies[name] = pkg.version;
      for (const dependency of Object.keys(pkg.dependencies || {})) await copyPackage(dependency);
    }
    for (const name of Object.keys(manifest.dependencies)) await copyPackage(name);
    await writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2));
    await mkdir(path.join(project, 'components/switch_probe'), { recursive: true });
    await writeFile(path.join(project, 'components/switch_probe/probe.h'), `// isolated build ${Date.now()}\n`);
    const launch = await launchAilyElectron({ environment: {
      AILY_BUILD_PRODUCT: mode, AILY_E2E_TOOLCHAIN_SEED: process.env['AILY_E2E_SWITCH_TOOLCHAIN_SEED'] || seed!, AILY_E2E_TOOLCHAIN_PROJECT: project,
    }, config: { selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: { backend: 'cloud' },
      devmode: { enabled: true, autoSave: false } } });
    try {
      if (mode === 'coder') await cp(path.join(seed!, 'npm-global/app/store/subapp-aily-coder-editor'),
        path.join(launch.userDataDir, 'npm-global/app/store/subapp-aily-coder-editor'), { recursive: true, verbatimSymlinks: true });
      const win = await getMainWindow(launch.app);
      await win.addLocatorHandler(win.locator('app-login .login-close'), button => button.click());
      await expect.poll(() => win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window'))
        .authService.getAuthInitializationState())).toBe('signed_out');
      await writeFile(path.join(launch.userDataDir, '.aily'), JSON.stringify({ access_token: accessToken }), { mode: 0o600 });
      await win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window')).authService.initializeAuth());
      await expect.poll(() => win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window'))
        .authService.canUseCloudCompilation)).toBe(true);
      if (mode === 'blockly') {
        await openBlocklyProject(win, project);
        await expect.poll(async () => (await readAilyHostOperation(launch.app, 'project_load_status', project)).ready, { timeout: 120_000 }).toBe(true);
      } else {
        await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
        await expect(win.locator('iframe.coder-embed-frame.is-ready')).toHaveCount(1, { timeout: 120_000 });
        await expect.poll(() => win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.getProjectDependencyStatus(project), project)).toBe('ready');
      }
      await win.evaluate(() => {
        const w = window as any, original = w.cloudBuild;
        w.__switchEvidence = { requests: [], events: [], cancellations: [], uploads: [] };
        original.onProgress((event: any) => w.__switchEvidence.events.push(event));
        w.cloudBuild = { ...original,
          run: async (request: any) => { w.__switchEvidence.requests.push(request.requestId); return original.run(request); },
          cancel: async (request: any) => { const result = await original.cancel(request); w.__switchEvidence.cancellations.push(request.requestId); return result; },
        };
      });
      const switchButton = win.getByRole('button', { name: '切换本地编译', exact: true });
      const cloudButton = win.getByRole('button', { name: '切回云编译', exact: true });
      const assertRestored = async (finalCloud = false) => {
        expect(await win.evaluate(() => {
          const header = (window as any).ng.getComponent(document.querySelector('app-header'));
          return { cloud: header.projectService.isCloudBuild(), saved: header.configService.data.compile.backend };
        })).toEqual({ cloud: true, saved: 'cloud' });
        const artifact = await win.evaluate(project => (window as any).cloudBuild.artifactPath({ projectPath: project }), project);
        if (finalCloud) expect(artifact).toBeTruthy();
        else expect(artifact).toBeNull();
        expect(JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).buildInfo.lastBuildStatus).toBe('success');
      };
      // Same host operation used by AI tools; its original request stays pending.
      let aiSettled = false;
      const ai = readAilyHostOperation(launch.app, 'project_build', project, {}, 300_000).then(value => value, error => ({ error: error.message })).finally(() => { aiSettled = true; });
      await expect(switchButton).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => win.evaluate(() => (window as any).__switchEvidence.events.some((event: any) => event.stage === 'queued')),
        { timeout: 60_000, intervals: [50] }).toBe(true);
      await win.screenshot({ path: info.outputPath(`${mode}-switch-button.png`) });
      await switchButton.click();
      await expect(switchButton).toHaveCount(0);
      await expect(cloudButton).toBeVisible({ timeout: 120_000 });
      expect(aiSettled).toBe(false);
      await win.screenshot({ path: info.outputPath(`${mode}-switch-back-button.png`) });
      await cloudButton.click();
      await expect(switchButton).toBeVisible({ timeout: 120_000 });
      expect(aiSettled).toBe(false);
      await expect.poll(() => win.evaluate(() => {
        const evidence = (window as any).__switchEvidence;
        return evidence.events.some((event: any) => event.requestId === evidence.requests[1] && event.stage === 'queued');
      }), { timeout: 60_000, intervals: [50] }).toBe(true);
      await switchButton.click();
      const aiResult = await ai;
      await info.attach('ai-result', { body: JSON.stringify(aiResult), contentType: 'application/json' });
      expect(aiResult).toMatchObject({ ok: true });
      await assertRestored();

      // The upload operation must keep the task-local backend until the device boundary.
      await win.evaluate(({ mode, project }) => {
        const w = window as any, header = w.ng.getComponent(document.querySelector('app-header'));
        const facade = mode === 'coder'
          ? header.uploaderService.coderExecution.getSession(project).injector.get(header.uploaderService.constructor)
          : header.uploaderService;
        const uploader = facade.application.blocklyUploaderService;
        uploader.serialService.currentPort = 'TEST-NO-DEVICE';
        uploader.serialService.currentPortInfo = { type: 'serial' };
        uploader.workflowService.startUpload = () => {
          w.__switchEvidence.uploads.push({ cloud: header.projectService.isCloudBuild(), passed: uploader._builderService.passed });
          return false;
        };
        w.__uploadResult = undefined;
        uploader.upload().then((result: any) => { w.__uploadResult = result; }, (error: any) => { w.__uploadResult = error; });
      }, { mode, project });
      await expect(switchButton).toBeVisible({ timeout: 60_000 });
      await switchButton.click();
      await expect(cloudButton).toBeVisible({ timeout: 120_000 });
      await cloudButton.click();
      await expect.poll(() => win.evaluate(() => (window as any).__switchEvidence.uploads.length), { timeout: 240_000 }).toBe(1);
      await expect.poll(() => win.evaluate(() => !!(window as any).__uploadResult)).toBe(true);
      expect(await win.evaluate(() => (window as any).__switchEvidence.uploads[0].cloud)).toBe(true);
      await assertRestored(true);
      const evidence = await win.evaluate(() => (window as any).__switchEvidence);
      expect(evidence.requests).toHaveLength(4);
      expect(new Set(evidence.requests).size).toBe(4);
      expect(evidence.cancellations).toEqual(evidence.requests.slice(0, 3));
      await info.attach('switch-results', { body: JSON.stringify({ mode, aiResult, evidence }, null, 2), contentType: 'application/json' });
      await win.screenshot({ path: info.outputPath(`${mode}-roundtrip-complete.png`) });
    } finally {
      await launch.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
