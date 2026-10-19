import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {closeAilyElectronApp, expect, getMainWindow, openBlocklyProject, test} from '../fixtures/electron-app';

const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];

test('focus callback failure does not poison native drags or project reload', async ({electronApp}, testInfo) => {
  test.skip(!PROJECT_PATH, 'Set AILY_E2E_PROJECT to an installed Arduino UNO project with @aily-project/lib-core-io.');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'aily-focus-recovery-'));
  const project = path.join(temp, 'project');
  const win = await getMainWindow(electronApp);
  const errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  win.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    await cp(PROJECT_PATH!, project, {recursive: true, filter: source =>
      !['.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock'].includes(path.basename(source))});
    await writeFile(path.join(project, 'project.abi'), await readFile(path.join(__dirname, '../fixtures/focus-recovery.abi')));
    await (await electronApp.browserWindow(win)).evaluate(window => window.setContentSize(1440, 840));
    await openBlocklyProject(win, project);
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace?.getAllBlocks(false).length), {timeout: 60_000}).toBe(21);
    const later = win.getByText('稍后登录', {exact: true});
    if (await later.isVisible()) await later.click();

    const state = () => win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement)?.contentWindow as any;
      return {locked: B.getFocusManager().lockFocusStateChanges, updating: B.getFocusManager().isUpdatingFocusedNode,
        gesture: !!ws?.currentGesture_, dragging: !!ws?.isDragging(), state: realm?.projectService?.stateSubject?.value,
        faultCount: (window as any).__focusRecoveryFaults || 0, count: ws?.getAllBlocks(false).length};
    });
    const point = (id: string, field?: string) => win.evaluate(({id, field}) => {
      const block = (window as any).blocklyWorkspace.getBlockById(id);
      const box = (field ? block.getField(field).getSvgRoot() : block.pathObject.svgPath).getBoundingClientRect();
      return field ? {x: box.x + box.width / 2, y: box.y + box.height / 2} : {x: box.x + 38, y: box.y + 20};
    }, {id, field});
    const drag = async (id: string, dx: number, dy: number) => {
      const p = await point(id);
      await win.mouse.move(p.x, p.y); await win.mouse.down();
      await win.mouse.move(p.x + dx, p.y + dy, {steps: 8}); await win.mouse.up();
      await expect.poll(state).toMatchObject({locked: false, updating: false, gesture: false, dragging: false});
    };

    // Same boundary as the reported cascade: dropdown -> focus callback throws
    // once -> native mouse drag -> another drag -> toolbar reload.
    const dropdown = await point('mode1_mode', 'MODE');
    await win.mouse.click(dropdown.x, dropdown.y);
    await expect(win.locator('.blocklyDropDownDiv')).toBeVisible();
    await win.evaluate(() => {
      const focus = (window as any).Blockly.getFocusManager();
      if (!focus.ephemeralFocusTaken()) throw new Error('Dropdown did not take focus');
      const node = focus.getFocusedNode(), original = node.onNodeFocus;
      node.onNodeFocus = function() {
        node.onNodeFocus = original;
        (window as any).__focusRecoveryFaults = ((window as any).__focusRecoveryFaults || 0) + 1;
        throw new Error('focus-recovery-test: one-shot callback exception');
      };
    });
    await drag('write1', 35, 20);
    expect((await state()).faultCount).toBe(1);
    const before = await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('write2').getRelativeToSurfaceXY());
    await drag('write2', 100, 30);
    const after = await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('write2').getRelativeToSurfaceXY());
    expect(after).not.toEqual(before);
    await drag('mode2', 100, 100);
    await drag('write4', 140, -40);
    const afterDrags = await state();

    await win.locator('app-dev-tool .fa-sync').click();
    await expect.poll(state, {timeout: 60_000}).toMatchObject({state: 'loaded', count: 21, gesture: false, locked: false});
    await expect(win.getByText('项目加载中...', {exact: true})).toHaveCount(0);
    await drag('write4', -50, 30);

    // Independent route failure verifies the loading-state fallback even though
    // fixed focus callbacks no longer poison workspace teardown.
    await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const service = realm.projectService, router = service.router, navigate = router.navigate;
      (window as any).__recoveryProjectService = service;
      router.navigate = function(...args: any[]) {
        router.navigate = navigate;
        return Promise.reject(new Error('focus-recovery-test: one-shot route teardown failure'));
      };
    });
    await win.locator('app-dev-tool .fa-sync').click();
    await expect.poll(() => win.evaluate(() => (window as any).__recoveryProjectService.stateSubject.value)).toBe('error');
    expect(await win.evaluate(() => (window as any).__recoveryProjectService.isProjectOpening)).toBe(false);
    await expect(win.getByText('项目加载中...', {exact: true})).toHaveCount(0);
    await win.screenshot({path: testInfo.outputPath('reload-error-without-stuck-loading.png')});
    await win.locator('app-dev-tool .fa-sync').click();
    await expect.poll(state, {timeout: 60_000}).toMatchObject({state: 'loaded', count: 21, gesture: false, locked: false});
    await drag('write4', 35, -20);
    await win.screenshot({path: testInfo.outputPath('recovered-editor.png')});
    expect(errors.filter(error => /FocusManager state changes|gesture had already been started|cleanup failed/.test(error))).toEqual([]);
    await testInfo.attach('recovery-evidence', {contentType: 'application/json', body: JSON.stringify({
      electron: await electronApp.evaluate(() => process.versions.electron), renderer: win.url(),
      afterDrags, final: await state(), moved: {before, after}, errors,
    }, null, 2)});
  } finally {
    await closeAilyElectronApp(electronApp);
    await rm(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
});
