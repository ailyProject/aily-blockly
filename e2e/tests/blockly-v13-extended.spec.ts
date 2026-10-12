import {test as base, expect, getMainWindow, openBlocklyProject, closeAilyElectronApp, launchAilyElectron} from '../fixtures/electron-app';
import {cp, mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Page} from '@playwright/test';

const SOURCE = process.env['AILY_E2E_PROJECT'];
const test = base.extend<{upgradedProject: string}>({
  upgradedProject: async ({electronApp}, use) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-v13-extended-'));
    const project = path.join(temporary, 'project');
    try {
      await cp(SOURCE!, project, {recursive: true,
        filter: source => !['.git', '.build', '.temp', '.log', 'project-open.lock'].includes(path.basename(source))});
      await use(project);
    } finally {
      // Complete background jobs before removing their disposable project.
      for (const page of electronApp.windows()) {
        if (await page.locator('app-blockly-editor').count().catch(() => 0)) {
          await page.evaluate(() => {window.location.hash = '#/main/guide';}).catch(() => {});
          await page.waitForFunction(() => !document.querySelector('app-blockly-editor')).catch(() => {});
        }
      }
      await closeAilyElectronApp(electronApp);
      await rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    }
  },
});

async function openReady(win: Page, project: string) {
  await openBlocklyProject(win, project);
  await expect.poll(() => win.evaluate(() => {
    const frame = document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement;
    return frame?.getAttribute('data-runtime-ready') === 'true' && (frame.contentWindow as any).Blockly.VERSION;
  }), {timeout: 60_000}).toBe('13.3.0');
}

test.describe('Blockly v13 extended regression', () => {
  test.skip(!SOURCE, 'Requires an installed disposable Blockly fixture source.');

  test('commits and cancels native number edits, and edits custom slider and multiline fields', async ({electronApp, upgradedProject}, testInfo) => {
    const win = await getMainWindow(electronApp);
    const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    await openReady(win, upgradedProject);
    const target = await win.evaluate(() => {
      const ws = (window as any).blocklyWorkspace;
      const block = ws.getAllBlocks(false).find((b: any) => b.type === 'math_number');
      ws.centerOnBlock(block.id);
      ws.clearUndo();
      block.getField('NUM').showEditor();
      return {id: block.id, before: Number(block.getFieldValue('NUM'))};
    });
    const numberInput = win.locator('.blocklyWidgetDiv input.blocklyHtmlInput');
    await expect(numberInput).toBeVisible();
    await numberInput.fill('1234');
    await numberInput.press('Enter');
    const number = () => win.evaluate(id => (window as any).blocklyWorkspace.getBlockById(id).getFieldValue('NUM'), target.id);
    await expect.poll(number).toBe(1234);
    // The live value is updated before Blockly publishes the grouped commit.
    // Undo only after the native editor has closed and that event is queued.
    await expect(numberInput).toBeHidden();
    await expect.poll(() => win.evaluate(id => (window as any).blocklyWorkspace.getUndoStack()
      .some((event: any) => event.blockId === id && event.element === 'field' && event.name === 'NUM' && event.newValue === 1234), target.id)).toBe(true);
    await testInfo.attach('native-number-undo-stack', {body: JSON.stringify(await win.evaluate(() =>
      (window as any).blocklyWorkspace.getUndoStack().map((event: any) => event.toJson()))), contentType: 'application/json'});
    await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
    await expect.poll(number).toBe(target.before);
    await win.evaluate(() => (window as any).blocklyWorkspace.undo(true));
    await expect.poll(number).toBe(1234);
    await win.evaluate(id => (window as any).blocklyWorkspace.getBlockById(id).getField('NUM').showEditor(), target.id);
    await numberInput.fill('5678');
    await numberInput.press('Escape');
    await expect.poll(number).toBe(1234);

    await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly, ws = (window as any).blocklyWorkspace;
      for (const [id, options] of [
        ['edit_slider', {type: 'field_slider', value: 45, min: 0, max: 100, precision: 1}],
        ['edit_multiline', {type: 'field_multilinetext', text: 'initial'}],
      ] as any[]) {
        B.Blocks[id] = {init() {this.jsonInit({message0: '%1', args0: [{...options, name: 'VALUE'}], colour: '#4274cc'});}};
        realm.Arduino.forBlock[id] = () => '';
        const block = ws.newBlock(id, id);
        block.initSvg(); block.render(); block.moveBy(80, 80);
      }
      await B.renderManagement.finishQueuedRenders();
      ws.centerOnBlock('edit_slider');
      ws.getBlockById('edit_slider').getField('VALUE').showEditor();
    });
    const slider = win.locator('input.fieldSlider');
    await expect(slider).toBeVisible();
    await slider.focus();
    await slider.press('End');
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('edit_slider').getFieldValue('VALUE'))).toBe(100);
    await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      realm.Blockly.DropDownDiv.hideWithoutAnimation(); realm.Blockly.WidgetDiv.hide();
      const ws = (window as any).blocklyWorkspace;
      ws.centerOnBlock('edit_multiline'); ws.getBlockById('edit_multiline').getField('VALUE').showEditor();
    });
    const multiline = win.locator('.blocklyWidgetDiv textarea');
    await expect(multiline).toBeVisible();
    await multiline.fill('中文第一行\nsecond line');
    await win.evaluate(() => {
      const B = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      B.Blockly.WidgetDiv.hide();
    });
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('edit_multiline').getFieldValue('VALUE'))).toBe('中文第一行\nsecond line');
    expect(errors).toEqual([]);
  });

  test('renames a published-library variable and preserves its id through rendered JSON restore', async ({electronApp, upgradedProject}) => {
    const win = await getMainWindow(electronApp);
    const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    await openReady(win, upgradedProject);
    const result = await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly, ws = (window as any).blocklyWorkspace;
      const variable = ws.createVariable('upgrade_before', '', 'upgrade_variable_id');
      const block = ws.newBlock('variables_get', 'upgrade_variable_get');
      block.setFieldValue(variable.getId(), 'VAR'); block.initSvg(); block.render();
      await B.renderManagement.finishQueuedRenders();
      const refs = block.getVars();
      const uses = ws.getVariableUsesById(variable.getId()).map((b: any) => b.id);
      ws.renameVariableById(variable.getId(), 'upgrade_after');
      await new Promise(resolve => setTimeout(resolve, 100));
      const label = block.getField('VAR').getText();
      const generated = realm.Arduino.blockToCode(block);
      const saved = B.serialization.blocks.save(block);
      B.Events.disable();
      let restored: any;
      try {block.dispose(false); restored = B.serialization.blocks.append(saved, ws);}
      finally {B.Events.enable();}
      await B.renderManagement.finishQueuedRenders();
      return {refs, uses, label, generated, restoredId: restored.getFieldValue('VAR'),
        restoredLabel: restored.getField('VAR').getText(), modelId: ws.getVariable('upgrade_after', '').getId()};
    });
    expect(result.refs).toEqual(['upgrade_variable_id']);
    expect(result.uses).toContain('upgrade_variable_get');
    expect(result.label).toBe('upgrade_after');
    expect(result.generated[0]).toContain('upgrade_after');
    expect(result.restoredId).toBe('upgrade_variable_id');
    expect(result.modelId).toBe('upgrade_variable_id');
    expect(result.restoredLabel).toBe('upgrade_after');
    expect(errors).toEqual([]);
  });

  test('retains connected stacks, collapse and independent disabling reasons through JSON and undo', async ({electronApp, upgradedProject}) => {
    const win = await getMainWindow(electronApp);
    const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    await openReady(win, upgradedProject);
    const result = await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly, ws = (window as any).blocklyWorkspace;
      const delay = ws.getAllBlocks(false).find((b: any) => b.type === 'time_delay' && b.previousConnection?.targetConnection);
      if (!delay) throw new Error('Fixture needs a connected delay block');
      const before = realm.Arduino.workspaceToCode(ws);
      const connection = delay.previousConnection.targetConnection;
      const parentId = connection.getSourceBlock().id;
      const collapsed = delay.isCollapsed();
      delay.setCollapsed(true);
      await B.renderManagement.finishQueuedRenders();
      const collapseCodeUnchanged = realm.Arduino.workspaceToCode(ws) === before;
      delay.setEnabled(false);
      delay.setDisabledReason(true, 'upgrade_probe_reason');
      delay.setEnabled(true);
      const independentReason = !delay.isEnabled();
      delay.setDisabledReason(false, 'upgrade_probe_reason');
      const enabledAgain = delay.isEnabled();
      delay.setCollapsed(collapsed);
      await new Promise(resolve => setTimeout(resolve, 100));
      ws.clearUndo();
      delay.previousConnection.disconnect();
      await new Promise(resolve => setTimeout(resolve, 100));
      const detached = !delay.previousConnection.isConnected();
      ws.undo(false);
      await new Promise(resolve => setTimeout(resolve, 100));
      const undoParent = delay.previousConnection.targetConnection?.getSourceBlock().id;
      const saved = B.serialization.workspaces.save(ws);
      B.Events.disable();
      try {B.serialization.workspaces.load(saved, ws);} finally {B.Events.enable();}
      await B.renderManagement.finishQueuedRenders();
      return {collapseCodeUnchanged, independentReason, enabledAgain, detached, parentId, undoParent,
        restoredCodeUnchanged: realm.Arduino.workspaceToCode(ws) === before};
    });
    expect(result.collapseCodeUnchanged).toBe(true);
    expect(result.independentReason).toBe(true);
    expect(result.enabledAgain).toBe(true);
    expect(result.detached).toBe(true);
    expect(result.undoParent).toBe(result.parentId);
    expect(result.restoredCodeUnchanged).toBe(true);
    expect(errors).toEqual([]);
  });

  test('saves an unblurred comment and numeric edit, then restores them in a fresh Electron process', async ({electronApp, upgradedProject}, testInfo) => {
    const win = await getMainWindow(electronApp);
    await openReady(win, upgradedProject);
    const saved = await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly, ws = (window as any).blocklyWorkspace;
      const block = ws.getAllBlocks(false).find((b: any) => b.type === 'math_number');
      block.setFieldValue(4321, 'NUM');
      block.setCommentText('initial');
      await block.getIcon(B.icons.CommentIcon.TYPE).setBubbleVisible(true);
      const input = document.querySelector('.blocklyTextInputBubble textarea') as HTMLTextAreaElement;
      input.value = 'v13 restart proof 未失焦注释';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      const response = await realm.projectService.save(undefined, 30000);
      return {response, id: block.id, count: ws.getAllBlocks(false).length, code: realm.Arduino.workspaceToCode(ws)};
    });
    expect(saved.response.success).toBe(true);
    expect(await readFile(path.join(upgradedProject, 'project.abi'), 'utf8')).toContain('v13 restart proof');
    await win.evaluate(() => {window.location.hash = '#/main/guide';});
    await expect(win.locator('app-blockly-editor')).toHaveCount(0);
    await closeAilyElectronApp(electronApp);
    const reopened = await launchAilyElectron();
    try {
      const fresh = await getMainWindow(reopened.app);
      const errors: string[] = [];
      fresh.on('pageerror', error => errors.push(error.message));
      await openReady(fresh, upgradedProject);
      const actual = await fresh.evaluate(id => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        const ws = (window as any).blocklyWorkspace, block = ws.getBlockById(id);
        return {count: ws.getAllBlocks(false).length, value: block.getFieldValue('NUM'), comment: block.getCommentText(), code: realm.Arduino.workspaceToCode(ws)};
      }, saved.id);
      expect(actual).toEqual({count: saved.count, value: 4321, comment: 'v13 restart proof 未失焦注释', code: saved.code});
      expect(errors).toEqual([]);
      await fresh.screenshot({path: testInfo.outputPath('restart-restored-comment.png')});
      await fresh.evaluate(() => {window.location.hash = '#/main/guide';});
      await expect(fresh.locator('app-blockly-editor')).toHaveCount(0);
    } finally {await reopened.close();}
  });

  test('renders both supported Aily renderers and preserves code through zoom and route reload', async ({electronApp, upgradedProject}, testInfo) => {
    const win = await getMainWindow(electronApp);
    const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    await openReady(win, upgradedProject);
    const before = await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const ws = (window as any).blocklyWorkspace;
      return {code: realm.Arduino.workspaceToCode(ws), count: ws.getAllBlocks(false).length};
    });
    for (const renderer of ['thrasos', 'zelos']) {
      await win.evaluate(renderer => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        realm.projectService.configService.data.blockly.renderer = renderer;
        window.location.hash = '#/main/guide';
      }, renderer);
      await expect(win.locator('app-blockly-editor')).toHaveCount(0);
      await openReady(win, upgradedProject);
      const result = await win.evaluate(async () => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        const ws = (window as any).blocklyWorkspace;
        await realm.Blockly.renderManagement.finishQueuedRenders();
        const scale = ws.scale;
        ws.zoomCenter(1);
        const zoomed = ws.scale;
        ws.zoomCenter(-1);
        return {renderer: ws.options.renderer, scale, zoomed, restoredScale: ws.scale,
          code: realm.Arduino.workspaceToCode(ws), count: ws.getAllBlocks(false).length,
          invalidBounds: ws.getAllBlocks(false).filter((block: any) => {
            const box = block.getSvgRoot().getBBox();
            return !Number.isFinite(box.width) || box.width <= 0 || !Number.isFinite(box.height) || box.height <= 0;
          }).map((block: any) => block.type)};
      });
      expect(result.renderer).toBe(`aily-${renderer}`);
      expect(result.zoomed).toBeGreaterThan(result.scale);
      expect(result.restoredScale).toBeCloseTo(result.scale, 8);
      expect(result.code).toBe(before.code);
      expect(result.count).toBe(before.count);
      expect(result.invalidBounds).toEqual([]);
      await win.screenshot({path: testInfo.outputPath(`${renderer}-workspace.png`)});
    }
    expect(errors).toEqual([]);
  });
});
