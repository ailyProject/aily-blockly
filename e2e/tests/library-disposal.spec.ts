import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

const { runDependencyWorker } = require('../../electron/library-dependencies');
const tft = '@aily-project/lib-tft-espi';
const types = ['tftespi_setup', 'tftespi_play_animation', 'tftespi_animation'];

test('TFT library discard: cancellation, close, switch, real filesystem failure and recovery', async ({}, info) => {
  const libraries = process.env['AILY_E2E_LIBRARIES'];
  const seed = process.env['AILY_E2E_PLATFORM_SEED'];
  test.skip(!libraries || !seed, 'Requires local library sources and installed platform resources.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-library-disposal-')));
  const project = path.join(root, 'source'), target = path.join(root, 'target');
  async function createProject(directory: string) {
    await mkdir(directory);
    const dependencies: Record<string, string> = {};
    for (const folder of ['core-io', 'core-logic', 'core-loop', 'core-math', 'core-serial', 'core-text', 'core-time', 'core-variables', 'board-esp32s3']) {
      const source = folder.startsWith('board-') ? path.join(seed!, 'node_modules/@aily-project', folder) : path.join(libraries!, folder);
      const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
      await cp(source, path.join(directory, 'local-libraries', folder), { recursive: true, dereference: true });
      dependencies[pkg.name] = `file:local-libraries/${folder}`;
    }
    await cp(path.join(libraries!, 'TFT_eSPI'), path.join(directory, 'local-libraries/TFT_eSPI'), { recursive: true, dereference: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: path.basename(directory), version: '1.0.0',
      nickname: `Library disposal ${path.basename(directory)}`, board: 'ESP32S3', devmode: 'arduino', dependencies }, null, 2));
    await writeFile(path.join(directory, 'project.abi'), JSON.stringify({ blocks: { languageVersion: 0, blocks: [
      { type: 'arduino_global', id: 'global', x: 60, y: 40 },
      { type: 'arduino_setup', id: 'setup', x: 60, y: 150 },
      { type: 'arduino_loop', id: 'loop', x: 60, y: 260 },
    ] } }));
    await runDependencyWorker(directory, { save: true }); await runDependencyWorker(directory, {});
  }
  await createProject(project); await createProject(target);
  const baseline = await Promise.all(['package.json', 'package-lock.json', 'project.abi'].map(file => readFile(path.join(project, file), 'utf8')));
  const launched = await launchAilyElectron({ environment: {
    AILY_E2E_TOOLCHAIN_SEED: seed!, AILY_E2E_TOOLCHAIN_PROJECT: project,
  }, config: { lang: 'zh_CN', onboardingCompleted: true, blocklyOnboardingCompleted: true,
    blockly: { autoSave: false, minimap: false }, compile: { backend: 'local' } } });
  const win = await getMainWindow(launched.app);
  await win.addLocatorHandler(win.locator('app-login .login-close'), button => button.click());
  const errors: string[] = [], snapshots: any[] = [];
  win.on('pageerror', error => errors.push(error.message));
  const installed = () => existsSync(path.join(project, 'node_modules', tft, 'package.json'));
  const status = () => win.evaluate(project => (window as any).libraryDependencies.status(project), project);
  const ready = (directory = project) => expect.poll(async () => {
    try { return (await readAilyHostOperation(launched.app, 'project_load_status', directory)).ready; } catch { return false; }
  }, { timeout: 90_000 }).toBe(true);
  const runtime = () => win.evaluate(() => {
    const w = window as any, header = w.ng.getComponent(document.querySelector('app-header'));
    const main = document.querySelector('blockly-main');
    return { project: header.projectService.currentProjectPath, state: header.projectService.stateSubject.value,
      mounted: !!main, blocked: main ? w.ng.getComponent(main).blocklyService.isWorkspaceEditBlocked() : false,
      types: main ? w.blocklyWorkspace.getAllBlocks(false).map((block: any) => block.type) : [] };
  });
  const record = async (step: string) => {
    snapshots.push({ step, installed: installed(), status: await status(), runtime: await runtime() });
    await win.screenshot({ path: info.outputPath(`${step}.png`) });
  };
  async function installAndEdit() {
    if (!await win.locator('app-lib-manager').count()) await win.locator('.toolbox-footer__button').click();
    await expect(win.locator('app-lib-manager')).toBeVisible();
    // Offline catalog only. The install button, queue, dependency IPC, npm and
    // actual published TFT blocks/generator use the product implementation.
    await win.evaluate(tft => {
      const w = window as any, manager = w.ng.getComponent(document.querySelector('app-lib-manager'));
      ++manager.initialDataLoadToken;
      manager.libraryList = [{ name: tft, version: 'file:local-libraries/TFT_eSPI', nickname: 'TFT_eSPI', _nickname: 'TFT_eSPI',
        description: 'Offline actual TFT library', _description: 'Offline actual TFT library', author: 'ailyProject',
        icon: '', tested: true, state: 'default', compatibility: { core: ['esp32:esp32'] } }];
      manager._libraryList = manager.libraryList;
      manager.cd.detectChanges();
    }, tft);
    await win.locator('app-lib-manager .lib-item').filter({ hasText: 'Offline actual TFT library' })
      .getByRole('button', { name: '安装', exact: true }).click();
    await expect.poll(() => win.evaluate(() => !(window as any).ng.getComponent(document.querySelector('app-lib-manager')).isProcessingLibraryOperationQueue), { timeout: 90_000 }).toBe(true);
    expect(installed()).toBe(true); expect((await status()).dirty).toBe(true);
    await win.locator('app-lib-manager .header .btn').click();
    // Deterministic native Blockly editing; no project document or saved-state
    // mocks. All custom TFT fields and generator extensions are instantiated.
    await win.evaluate(() => {
      const w = window as any, workspace = w.blocklyWorkspace;
      const setup = workspace.newBlock('tftespi_setup', 'tft-setup'); setup.initSvg(); setup.render();
      workspace.getBlockById('setup').getInput('ARDUINO_SETUP')?.connection?.connect(setup.previousConnection);
      const play = w.Blockly.serialization.blocks.append({ type: 'tftespi_play_animation', id: 'tft-play',
        inputs: { X: { shadow: { type: 'math_number', fields: { NUM: 0 } } }, Y: { shadow: { type: 'math_number', fields: { NUM: 0 } } },
          ANIMATION: { block: { type: 'tftespi_animation', id: 'tft-animation' } } } }, workspace);
      workspace.getBlockById('loop').getInput('ARDUINO_LOOP').connection.connect(play.previousConnection);
    });
    for (const type of types) expect((await runtime()).types).toContain(type);
    await expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'true');
  }
  async function action(action: string) {
    await win.evaluate(action => {
      const w = window as any, header = w.ng.getComponent(document.querySelector('app-header'));
      w.__libraryDisposalAction = header.process({ action });
    }, action);
  }
  async function skip() {
    await expect(win.locator('app-unsave-dialog')).toBeVisible();
    await win.locator('app-unsave-dialog').getByRole('button', { name: '跳过保存', exact: true }).click();
    await expect(win.locator('app-unsave-dialog')).toHaveCount(0);
  }
  const unchangedDisk = async () => {
    const disk = await Promise.all(['package.json', 'package-lock.json', 'project.abi'].map(file => readFile(path.join(project, file), 'utf8')));
    // Generated build metadata can be refreshed independently of project Save.
    // Dependency rollback, the saved lockfile and admitted ABI are authoritative.
    expect(JSON.parse(disk[0]).dependencies).toEqual(JSON.parse(baseline[0]).dependencies);
    expect(disk.slice(1)).toEqual(baseline.slice(1));
  };
  try {
    await openBlocklyProject(win, project); await ready();
    baseline[2] = await readFile(path.join(project, 'project.abi'), 'utf8');
    await installAndEdit(); await record('01-unsaved-tft');
    // A cancelled native file picker is a real post-confirmation cancellation.
    await launched.app.evaluate(({ dialog }) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async (...args: any[]) => {
        dialog.showOpenDialog = original;
        return { canceled: true, filePaths: [] };
      };
    });
    await action('project-open'); await skip();
    await expect.poll(async () => (await runtime()).project).toBe(project);
    expect((await status()).dirty).toBe(true); expect(installed()).toBe(true);
    expect((await runtime()).blocked).toBe(false); await record('02-picker-cancel-preserves-edits');

    // Reject an unavailable destination after the same real confirmation UI.
    await win.evaluate(missing => {
      const w = window as any, header = w.ng.getComponent(document.querySelector('app-header'));
      w.__libraryDisposalAction = header.onHeaderMenuSubItemClick({ action: 'recent-project-open', data: { path: missing } });
    }, path.join(root, 'missing-project'));
    await skip(); await win.evaluate(() => (window as any).__libraryDisposalAction);
    expect((await runtime()).mounted).toBe(true); expect((await status()).dirty).toBe(true);
    await record('03-missing-target-preserves-edits');

    await action('project-close'); await skip(); await win.evaluate(() => (window as any).__libraryDisposalAction);
    expect((await runtime()).mounted).toBe(false); expect(installed()).toBe(false);
    expect((await status()).dirty).toBe(false); await unchangedDisk(); await record('04-discard-close');
    await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
    await ready(); expect((await runtime()).types.some((type: string) => type.startsWith('tftespi_'))).toBe(false);

    await installAndEdit();
    await win.evaluate(target => {
      const w = window as any, header = w.ng.getComponent(document.querySelector('app-header'));
      w.__libraryDisposalAction = header.onHeaderMenuSubItemClick({ action: 'recent-project-open', data: { path: target } });
    }, target);
    await skip(); await win.evaluate(() => (window as any).__libraryDisposalAction); await ready(target);
    expect(installed()).toBe(false); expect((await status()).dirty).toBe(false); await unchangedDisk(); await record('05-discard-switch');
    await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
    await ready(); await installAndEdit();

    // Real OS fault: npm cannot rename/remove packages in this read-only scope.
    const scope = path.join(project, 'node_modules/@aily-project');
    await chmod(scope, 0o555);
    try {
      await action('project-close'); await skip(); await win.evaluate(() => (window as any).__libraryDisposalAction);
      expect((await runtime()).mounted).toBe(false); expect((await runtime()).state).toBe('error');
      expect((await status()).dirty).toBe(true);
      await expect(win.locator('body')).toContainText('项目库依赖恢复失败');
      await record('06-real-permission-failure');
    } finally { await chmod(scope, 0o755); }
    await action('project-close'); await win.evaluate(() => (window as any).__libraryDisposalAction);
    expect((await runtime()).project).toBe(''); expect((await status()).dirty).toBe(false);
    expect(installed()).toBe(false); await unchangedDisk(); await record('07-retry-close-recovers');

    await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
    await ready(); await installAndEdit();
    await win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-header')).process({ action: 'project-save' }, null, 'manual'));
    await expect.poll(async () => (await status()).dirty).toBe(false);
    await action('project-close'); await win.evaluate(() => (window as any).__libraryDisposalAction);
    await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
    await ready(); for (const type of types) expect((await runtime()).types).toContain(type);
    expect(installed()).toBe(true); await record('08-saved-tft-reopens');
    expect(errors).toEqual([]);
    const temp = path.join(project, '.temp');
    const recoveries = existsSync(temp) ? (await readdir(temp)).filter(file => /^library-runtime-.*\.recovery\.json$/.test(file)) : [];
    expect(recoveries).toEqual([]);

    // A genuinely incomplete installed library must still quarantine the
    // runtime and retain the unsaved recovery snapshot. Closing that already
    // damaged editor must work without attempting another in-place rebuild.
    const blockFile = path.join(project, 'node_modules', tft, 'block.json');
    const originalBlocks = await readFile(blockFile, 'utf8');
    const savedAbi = await readFile(path.join(project, 'project.abi'), 'utf8');
    await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('tft-setup').setFieldValue('241', 'WIDTH'));
    await writeFile(blockFile, JSON.stringify(JSON.parse(originalBlocks).filter((block: any) => !types.includes(block.type))));
    try {
      const failure = await win.evaluate(async () => {
        const header = (window as any).ng.getComponent(document.querySelector('app-header'));
        try { await header.projectService.rebuildBlocklyRuntimeAfterLibraryChange(); return ''; }
        catch (error) { return (error as Error).message; }
      });
      expect(failure).toContain('project block definitions are not ready:');
      for (const type of types) expect(failure).toContain(type);
      snapshots.push({ step: 'incomplete-library-error', failure });
      expect((await runtime()).blocked).toBe(true);
      expect(await readFile(path.join(project, 'project.abi'), 'utf8')).toBe(savedAbi);
      await record('09-real-incomplete-library-quarantine');
    } finally { await writeFile(blockFile, originalBlocks); }
    await action('project-close');
    await expect(win.locator('app-unsave-dialog')).toContainText('无法确认保存状态');
    await win.screenshot({ path: info.outputPath('09a-quarantined-close-dialog.png') });
    await skip(); await win.evaluate(() => (window as any).__libraryDisposalAction);
    expect((await runtime()).mounted).toBe(false); expect((await runtime()).project).toBe('');
    await win.evaluate(project => (window as any).ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(project), project);
    await ready(); expect((await runtime()).blocked).toBe(false);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('tft-setup').getFieldValue('WIDTH'))).toBe('240');
    expect((await readdir(temp)).filter(file => /^library-runtime-.*\.recovery\.json$/.test(file)).length).toBe(1);
    expect(errors).toEqual([]); await record('10-quarantined-close-and-reopen');
  } finally {
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ root, project, target, errors, snapshots }, null, 2));
    await launched.close();
  }
});
