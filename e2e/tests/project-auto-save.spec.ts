import { constants } from 'node:fs';
import { cp, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

test('autosave is opt-in and saves pans again after saving and a long idle', async ({}, info) => {
  const source = process.env['AILY_E2E_AUTOSAVE_PROJECT'];
  test.skip(!source, 'Set AILY_E2E_AUTOSAVE_PROJECT to an installed Blockly project; only a disposable copy is edited.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-autosave-')));
  const project = path.join(root, 'project');
  await cp(source!, project, { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE,
    filter: file => !['.git', '.temp', '.build', '.log', '.aily', '.workspace-history', 'project-open.lock'].includes(path.basename(file)) });
  // Optional frozen renderer, independent of another task's long-running dev server.
  const renderer = process.env['AILY_E2E_AUTOSAVE_RENDERER'];
  const launched = await launchAilyElectron({ rendererDirectory: renderer, environment: { AILY_BUILD_PRODUCT: 'blockly' }, config: {
    selectedLanguage: 'zh_cn', onboardingCompleted: true, blocklyOnboardingCompleted: true,
    blockly: { minimap: false },
  } });
  const win = await getMainWindow(launched.app);
  await win.addLocatorHandler(win.locator('app-login .login-close'), async button => { await button.click(); });
  const disk = () => readFile(path.join(project, 'project.abi'), 'utf8');
  const state = () => win.evaluate(() => {
    const w = window as any, h = w.ng.getComponent(document.querySelector('app-header'));
    const dirty = h.blocklyService.projectDirtyState;
    return { saves: w.autosaveChecks.saves, states: w.autosaveChecks.states, autosaveStates: w.autosaveChecks.autosaveStates,
      state: h.autoSaveState, enabled: h.configService.data.blockly.autoSave === true,
      ready: h.autoSave.hooks.ready(), active: h.autoSave.hooks.enabled(), dirty: dirty.changed.value,
      viewport: w.blocklyWorkspace && { scrollX: w.blocklyWorkspace.scrollX, scrollY: w.blocklyWorkspace.scrollY },
      savedViews: [...dirty.views], observedViews: [...dirty.observedViews], route: h.router.url };
  });
  const record = async (label: string) => writeFile(info.outputPath(`${label}.json`), JSON.stringify(await state(), null, 2));
  try {
    await win.waitForFunction(() => (window as any).ng?.getComponent(document.querySelector('app-header')));
    await win.evaluate(() => {
      const w = window as any, h = w.ng.getComponent(document.querySelector('app-header'));
      w.autosaveChecks = { saves: [], states: [], autosaveStates: [] };
      h.projectService.stateSubject.subscribe((state: string) => w.autosaveChecks.states.push(state));
      const reportState = h.autoSave.hooks.state;
      h.autoSave.hooks.state = (...args: any[]) => { w.autosaveChecks.autosaveStates.push(args); reportState(...args); };
      const save = h.projectService.saveInBackground;
      h.projectService.saveInBackground = async function (...args: any[]) {
        const entry: any = { started: Date.now() }; w.autosaveChecks.saves.push(entry);
        const result = await save.apply(this, args);
        entry.result = { success: result.success, projectSaved: result.projectSaved, code: result.code }; return result;
      };
    });
    await openBlocklyProject(win, project);
    await expect.poll(async () => {
      try { return (await readAilyHostOperation(launched.app, 'project_load_status', project)).ready; }
      catch { return false; }
    }, { timeout: 90_000 }).toBe(true);
    const loginClose = win.locator('app-login .login-close');
    if (await loginClose.isVisible()) await loginClose.click();
    await win.bringToFront();
    await win.waitForTimeout(3000);
    const initial = await disk();
    expect((await state()).enabled).toBe(false);
    expect((await state()).saves).toHaveLength(0);

    // Real mouse gestures on empty canvas, with normal Blockly viewport events.
    const pan = async () => {
      const background = win.locator('blockly-main .blocklyMainBackground').first();
      const bounds = await background.boundingBox(); expect(bounds).not.toBeNull();
      const before = await win.evaluate(() => (window as any).blocklyWorkspace.scrollX);
      const x = bounds!.x + bounds!.width - 110, y = bounds!.y + bounds!.height - 110;
      await win.mouse.move(x, y); await win.mouse.down();
      await win.mouse.move(x - 55, y - 25, { steps: 10 }); await win.mouse.up();
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.scrollX)).not.toBe(before);
    };
    await pan(); await win.waitForTimeout(3000);
    expect(await disk()).toBe(initial); expect((await state()).saves).toHaveLength(0);
    await record('default-off');

    await win.evaluate(() => (window as any).ng.getComponent(document.querySelector('app-header')).uiService
      .openWindow({ type: 'window', path: 'settings', windowClass: 'builtin', width: 700, height: 550 }));
    let settings: typeof win | undefined;
    await expect.poll(async () => {
      settings = undefined;
      for (const page of launched.app.windows()) {
        if (await page.locator('app-settings').count().catch(() => 0)) { settings = page; break; }
      }
      return Boolean(settings);
    }).toBe(true);
    const toggle = settings!.locator('#blockly-autosave');
    await expect(toggle).not.toHaveClass(/ant-switch-checked/); await toggle.click();
    await expect.poll(async () => (await state()).enabled).toBe(true);
    await expect.poll(async () => (await state()).state).toBe('saved');
    expect((await state()).saves).toHaveLength(1);
    const settingsWindow = await launched.app.browserWindow(settings!);
    await settingsWindow.evaluate(window => window.close());
    await win.bringToFront();

    const expectSavedViewport = async (count: number) => {
      await expect.poll(async () => (await state()).saves.length).toBe(count);
      await expect.poll(async () => (await state()).state).toBe('saved');
      const saved = JSON.parse(await disk());
      const live = await win.evaluate(() => {
        const ws = (window as any).blocklyWorkspace; return { scrollX: ws.scrollX, scrollY: ws.scrollY, scale: ws.scale };
      });
      const view = saved.pages.find((page: any) => page.id === saved.activePageId).viewState;
      expect(view.scrollX).toBeCloseTo(live.scrollX, 5); expect(view.scrollY).toBeCloseTo(live.scrollY, 5);
      expect(view.scale).toBeCloseTo(live.scale, 5);
      expect((await state()).saves[count - 1].result.success).toBe(true);
      await expect(win.locator('app-footer .state')).toContainText('自动保存成功');
      await expect(win.locator('app-header .project-save-status')).toHaveCount(0);
      await expect(win.locator('.ant-message-notice-content').filter({ hasText: /项目保存中|项目已保存/ })).toHaveCount(0);
      expect((await state()).states.filter((value: string) => ['saving', 'saved'].includes(value))).toEqual([]);
    };
    await expectSavedViewport(1);
    await pan(); await expectSavedViewport(2); await record('pan-after-save');
    await win.waitForTimeout(6000); expect((await state()).saves).toHaveLength(2);
    await expect(win.locator('app-footer .state')).toHaveCount(0);
    await pan(); await expectSavedViewport(3); await record('pan-after-idle');

    // Hold a real publication's asynchronous tail while its editor lease is
    // active, then pan with the mouse. The newer viewport must survive and save.
    await win.evaluate(() => {
      const w = window as any, p = w.ng.getComponent(document.querySelector('app-blockly-editor'))._projectService;
      const publish = p.publishPreparedSaveOutputs; let held = false;
      p.publishPreparedSaveOutputs = async function (...args: any[]) {
        if (!held) {
          held = true; w.autosaveTailHeld = true;
          await new Promise<void>(resolve => { w.releaseAutosaveTail = resolve; });
        }
        return publish.apply(this, args);
      };
    });
    await pan();
    await win.waitForFunction(() => (window as any).autosaveTailHeld === true);
    expect(await win.evaluate(() => {
      const w = window as any, component = w.ng.getComponent(document.querySelector('blockly-main'));
      return { writing: component.blocklyService.aiWriting, overlay: component.showSpinOverlay };
    })).toEqual({ writing: false, overlay: false });
    await pan();
    await win.evaluate(() => (window as any).releaseAutosaveTail());
    await expectSavedViewport(5); await record('pan-during-background-save');

    // Zoom is another viewport change; it must follow the same idle-save path.
    await win.evaluate(() => (window as any).blocklyWorkspace.zoomCenter(1));
    await expectSavedViewport(6);
    await win.screenshot({ path: info.outputPath('saved-after-pan-and-zoom.png') });
    await win.waitForTimeout(6000); expect((await state()).saves).toHaveLength(6);
    await record('settled-without-loop');

    const saved = await disk(), modified = (await stat(path.join(project, 'project.abi'))).mtimeMs;
    await win.reload();
    await expect.poll(async () => {
      try { return (await readAilyHostOperation(launched.app, 'project_load_status', project)).ready; }
      catch { return false; }
    }, { timeout: 90_000 }).toBe(true);
    await win.waitForTimeout(6000);
    expect(await disk()).toBe(saved); expect((await stat(path.join(project, 'project.abi'))).mtimeMs).toBe(modified);
    await expect(win.locator('app-header .project-save-status')).toHaveCount(0);
  } finally {
    await win.evaluate(() => (window as any).releaseAutosaveTail?.()).catch(() => {});
    await record('final-state').catch(() => {});
    await launched.close();
    await rm(root, { recursive: true, force: true });
  }
});
