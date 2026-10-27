import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

// Real Electron UI, generator, dependency preparation and local compiler.
// Only cloud eligibility and the cloud board-support response are controlled:
// no remote account/service or hardware is required, including on macOS.
for (const mode of ['blockly', 'coder'] as const) test(`${mode}: click after cloud error compiles locally once and retains cloud preference`, async ({}, info) => {
  const seed = process.env['AILY_E2E_RETRY_PROJECT_SEED'];
  const toolchain = process.env['AILY_E2E_RETRY_TOOLCHAIN_SEED'];
  test.skip(!seed || !toolchain, 'Requires an installed UNO project and matching local toolchain.');
  const board = '@aily-project/board-arduino_uno';
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-cloud-error-retry-')));
  const project = path.join(root, 'project');
  await cp(path.join(seed!, 'node_modules', board, 'template'), project, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  manifest.name = `cloud-error-local-retry-${mode}`;
  if (mode === 'coder') {
    Object.assign(manifest, { type: 'coder', framework: 'arduino', entry: 'src/main.cpp', dependencies: { [board]: '1.8.6' } });
    await rm(path.join(project, 'project.abi'), { force: true });
    await mkdir(path.join(project, 'sketch/src'), { recursive: true });
    await writeFile(path.join(project, 'sketch/src/main.cpp'), '#include <Arduino.h>\nvoid setup() { Serial.begin(115200); pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); Serial.println("local retry"); delay(100); digitalWrite(13, LOW); delay(100); }\n');
  }
  const copied = new Set<string>();
  async function copyPackage(name: string) {
    if (copied.has(name)) return;
    copied.add(name);
    const from = path.join(seed!, 'node_modules', name);
    await cp(from, path.join(project, 'node_modules', name), { recursive: true, mode: constants.COPYFILE_FICLONE });
    const pkg = JSON.parse(await readFile(path.join(from, 'package.json'), 'utf8'));
    if (manifest.dependencies[name]) manifest.dependencies[name] = pkg.version;
    for (const dependency of Object.keys(pkg.dependencies || {})) await copyPackage(dependency);
  }
  for (const name of Object.keys(manifest.dependencies)) await copyPackage(name);
  await writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2));
  const launch = await launchAilyElectron({ environment: { AILY_BUILD_PRODUCT: mode,
    AILY_E2E_TOOLCHAIN_SEED: toolchain!, AILY_E2E_TOOLCHAIN_PROJECT: project }, config: {
    selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: { backend: 'cloud' }, devmode: { enabled: true, autoSave: false },
  } });
  try {
    if (mode === 'coder') await cp(path.join(toolchain!, 'npm-global/app/store/subapp-aily-coder-editor'),
      path.join(launch.userDataDir, 'npm-global/app/store/subapp-aily-coder-editor'), { recursive: true, verbatimSymlinks: true });
    const win = await getMainWindow(launch.app);
    await win.addLocatorHandler(win.locator('app-login .login-close'), button => button.click());
    await expect.poll(() => win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-main-window'))
      .authService.getAuthInitializationState())).toBe('signed_out');
    if (mode === 'blockly') {
      await openBlocklyProject(win, project);
      await expect.poll(async () => (await readAilyHostOperation(launch.app, 'project_load_status', project)).ready, { timeout: 120_000 }).toBe(true);
    } else {
      await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
      await expect(win.locator('iframe.coder-embed-frame.is-ready')).toHaveCount(1, { timeout: 120_000 });
      await expect.poll(() => win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header'))
        .projectService.getProjectDependencyStatus(project), project)).toBe('ready');
    }
    console.log(`${mode}: project ready`);
    const before = await win.evaluate(() => {
      const w = window as any, header = w.ng.getComponent(document.querySelector('app-header'));
      // Platform/account eligibility is independent of this retry contract.
      header.configService.getCompileBackend = () => header.configService.data.compile.backend;
      w.__retryEvidence = { boardLookups: 0 };
      w.cloudBuild = { ...w.cloudBuild, boardSupport: async (request: any) => {
        w.__retryEvidence.boardLookups++;
        return { boardModule: request.boardModule, boardVersion: request.boardVersion,
          supported: false, available: false, reason: 'not_supported' };
      } };
      return header.configService.data.compile;
    });
    const compile = win.locator('app-header app-act-btn[data-action="compile"]');
    console.log(`${mode}: click compile`);
    await compile.click();
    const retry = win.getByRole('button', { name: '切换本地编译', exact: true });
    await expect(retry).toBeVisible();
    await expect(win.locator('app-notification .text')).toContainText('云');
    await win.screenshot({ path: info.outputPath(`${mode}-cloud-error.png`) });
    const prior = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    expect(prior.buildInfo?.lastBuildStatus).not.toBe('success');
    // Leave the error idle to detect unwanted fallback without clicking.
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).buildInfo?.lastBuildStatus).not.toBe('success');
    const started = Date.now();
    console.log(`${mode}: click local switch`);
    await retry.click();
    await expect.poll(async () => {
      const notice = await win.locator('app-notification').innerText();
      if (await win.locator('app-notification .error').count()) throw new Error(`Local retry failed: ${notice}`);
      const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
      return pkg.buildInfo?.lastBuildStatus === 'success' && Date.parse(pkg.buildInfo.lastBuildTime) >= started;
    }, { timeout: 180_000 }).toBe(true);
    await expect(win.locator('app-notification .done')).toBeVisible();
    await win.screenshot({ path: info.outputPath(`${mode}-local-success.png`) });
    const after = await win.evaluate(() => {
      const header = (window as any).ng.getComponent(document.querySelector('app-header'));
      return { saved: header.configService.data.compile, effective: header.configService.getCompileBackend(),
        cloud: header.projectService.isCloudBuild(), evidence: (window as any).__retryEvidence };
    });
    expect(after.saved).toEqual(before);
    expect(after.effective).toBe('cloud');
    expect(after.cloud).toBe(true);
    if (mode === 'coder') expect(await win.evaluate(() => {
      const h = (window as any).ng.getComponent(document.querySelector('app-header'));
      return h.builderService.coderExecution.getState(h.projectService.currentProjectPath).build;
    })).toBe('done');
    expect(after.evidence.boardLookups).toBe(1);
    const firmware: any[] = [];
    async function collect(dir: string) {
      for (const name of await readdir(dir)) {
        if (name === 'node_modules') continue;
        const file = path.join(dir, name), meta = await stat(file);
        if (meta.isDirectory()) await collect(file);
        else if (/\.(hex|elf)$/.test(name)) firmware.push({ file: path.relative(project, file), bytes: meta.size,
          modified: meta.mtimeMs, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
      }
    }
    await collect(project);
    expect(firmware.some(file => file.bytes > 0 && file.modified >= started)).toBe(true);
    const built = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    const latestResult = JSON.parse(await readFile(path.join(project, '.log/compile/latest-result.json'), 'utf8'));
    expect(latestResult.success).toBe(true); expect(latestResult.source).toBe('manual');
    expect(latestResult.finishedAt).toBeGreaterThanOrEqual(started);
    // A normal new click must use cloud again; it must not inherit the retry lease.
    console.log(`${mode}: click compile`);
    await compile.click();
    await expect(retry).toBeVisible();
    expect(await win.evaluate(() => (window as any).__retryEvidence.boardLookups)).toBe(2);
    const evidence = JSON.stringify({ mode, pid: launch.app.process().pid,
      cloudFailure: 'controlled board-support response', started, buildInfo: built.buildInfo, latestResult, before, after, firmware }, null, 2);
    await writeFile(info.outputPath('evidence.json'), evidence);
    await info.attach('local-retry-evidence', { path: info.outputPath('evidence.json'), contentType: 'application/json' });
  } finally {
    await launch.close();
    await rm(root, { recursive: true, force: true });
  }
});
