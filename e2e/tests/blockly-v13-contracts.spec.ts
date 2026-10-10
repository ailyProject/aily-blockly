import {test, expect, getMainWindow, openBlocklyProject, closeAilyElectronApp} from '../fixtures/electron-app';
import {cp, mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];

test.describe('Blockly v13 production renderer contracts', () => {
  test.skip(!PROJECT_PATH, 'Requires an isolated installed Blockly fixture project.');
  let projectPath: string;
  let tempRoot: string;
  test.beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-blockly-v13-contract-'));
    projectPath = path.join(tempRoot, 'project');
    await cp(PROJECT_PATH!, projectPath, {recursive: true});
  });
  test.afterEach(async ({electronApp}) => {
    const win = await getMainWindow(electronApp);
    await win.evaluate(() => { window.location.hash = '#/main/guide'; }).catch(() => {});
    await expect(win.locator('app-blockly-editor')).toHaveCount(0);
    // Finish this isolated app's background dependency/preprocess jobs before
    // deleting their project directory. Route disposal alone does not stop them.
    await closeAilyElectronApp(electronApp);
    await rm(tempRoot, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  });

  test('preserves code and project state through JSON/XML, comments and undo/redo', async ({electronApp}, testInfo) => {
    const win = await getMainWindow(electronApp);
    const errors: string[] = [];
    win.on('pageerror', e => errors.push(e.message));
    await openBlocklyProject(win, projectPath);
    await expect.poll(() => win.evaluate(() => document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready'))).toBe('true');
    const result = await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly;
      const workspace = (window as any).blocklyWorkspace;
      const generator = realm.Arduino;
      const initial = B.serialization.workspaces.save(workspace);
      const initialCode = generator.workspaceToCode(workspace);
      const count = workspace.getAllBlocks(false).length;
      B.serialization.workspaces.load(initial, workspace);
      await B.renderManagement.finishQueuedRenders();
      const jsonCode = generator.workspaceToCode(workspace);
      const xml = B.Xml.workspaceToDom(workspace);
      B.Xml.clearWorkspaceAndLoadFromXml(xml, workspace);
      await B.renderManagement.finishQueuedRenders();
      const xmlCode = generator.workspaceToCode(workspace);
      const block = workspace.getAllBlocks(false).find((b: any) => b.type === 'math_number');
      if (!block) throw new Error('Fixture must include a numeric field');
      B.keyboardNavigationController.setIsActive(true);
      const field = block.getField('NUM');
      B.getFocusManager().focusNode(field);
      const fieldElement = field.getFocusableElement();
      const rect = fieldElement.querySelector('.blocklyFieldRect');
      const focus = {active: getComputedStyle(rect).stroke, passive: '', restored: ''};
      const external = document.createElement('button');
      document.body.append(external);
      const restoreFocus = B.getFocusManager().takeEphemeralFocus(external);
      focus.passive = getComputedStyle(rect).strokeDasharray;
      restoreFocus();
      focus.restored = getComputedStyle(rect).stroke;
      B.getFocusManager().focusNode(workspace);
      external.remove();
      B.keyboardNavigationController.setIsActive(false);
      workspace.clearUndo();
      const before = block.getFieldValue('NUM');
      block.setFieldValue(Number(before) + 7, 'NUM');
      await new Promise(resolve => setTimeout(resolve, 50));
      workspace.undo(false);
      const undo = block.getFieldValue('NUM');
      workspace.undo(true);
      const redo = block.getFieldValue('NUM');
      block.setCommentText('initial');
      const icon = block.getIcon(B.icons.CommentIcon.TYPE);
      await icon.setBubbleVisible(true);
      const textarea = document.querySelector('.blocklyTextInputBubble textarea') as HTMLTextAreaElement;
      if (!textarea) throw new Error('Comment editor not rendered');
      textarea.value = '未失焦注释\nBlockly v13';
      textarea.dispatchEvent(new Event('input', {bubbles: true}));
      const commentText = icon.saveState().text;
      const commented = B.serialization.workspaces.save(workspace);
      B.serialization.workspaces.load(commented, workspace);
      await B.renderManagement.finishQueuedRenders();
      const restoredText = workspace.getBlockById(block.id).getCommentText();
      B.serialization.workspaces.load(initial, workspace);
      await B.renderManagement.finishQueuedRenders();
      return {version: B.VERSION, count, initialCode, jsonCode, xmlCode, before, undo, redo, commentText, restoredText, focus};
    });
    expect(result.version).toBe('13.3.0');
    expect(result.count).toBeGreaterThan(0);
    expect(result.initialCode.length).toBeGreaterThan(0);
    expect(result.jsonCode).toBe(result.initialCode);
    expect(result.xmlCode).toBe(result.initialCode);
    expect(result.undo).toBe(result.before);
    // Aily's renderer supplies #fc3, overriding Blockly's default #fff200.
    expect(result.focus.active).toBe('rgb(255, 204, 51)');
    expect(result.focus.passive).toBe('5px, 3px');
    expect(result.focus.restored).toBe(result.focus.active);
    expect(result.redo).toBe(Number(result.before) + 7);
    expect(result.commentText).toBe('未失焦注释\nBlockly v13');
    expect(result.restoredText).toBe(result.commentText);
    expect(errors).toEqual([]);
    await testInfo.attach('roundtrip-and-generated-code', {body: JSON.stringify(result, null, 2), contentType: 'application/json'});
    await win.screenshot({path: testInfo.outputPath('blockly-v13-workspace.png')});
  });

  test('renders and roundtrips every active custom field and opens its editor', async ({electronApp}, testInfo) => {
    const win = await getMainWindow(electronApp);
    await openBlocklyProject(win, projectPath);
    await expect.poll(() => win.evaluate(() => document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready'))).toBe('true');
    const results = await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly;
      const workspace = (window as any).blocklyWorkspace;
      const fields = [
        'field_bitmap', 'field_bitmap_u8g2', 'field_u8g2_animation', 'field_tftespi_animation', 'field_tftespi_image',
        'field_audio', 'field_image_selector', 'field_image_preview', 'field_led_matrix', 'field_led_matrix_image',
        'field_led_pattern_selector', 'field_tone_picker', 'field_multilinetext', 'field_slider', 'field_angle180', 'field_angle',
        'field_colour_hsv_sliders',
      ];
      const results = [];
      for (const type of fields) {
        const blockType = `upgrade_probe_${type}`;
        let block: any;
        let restored: any;
        try {
          const options: any = {type, name: 'VALUE'};
          if (type === 'field_tone_picker') options.text = '440';
          if (type === 'field_multilinetext') options.text = '中文\nhello';
          if (type.startsWith('field_angle') || type === 'field_slider') options.value = 45;
          B.Blocks[blockType] = {init() { this.jsonInit({message0: '%1', args0: [options], colour: '#4274cc'}); }};
          realm.Arduino.forBlock[blockType] = () => '';
          block = workspace.newBlock(blockType);
          block.initSvg(); block.render(); block.moveBy(80, 80);
          await B.renderManagement.finishQueuedRenders();
          const field = block.getField('VALUE');
          const box = field.getSvgRoot().getBBox();
          const value = JSON.stringify(field.getValue());
          const saved = B.serialization.blocks.save(block);
          restored = B.serialization.blocks.append(saved, workspace);
          await B.renderManagement.finishQueuedRenders();
          const restoredValue = JSON.stringify(restored.getField('VALUE').getValue());
          // Public editor entry exercises FocusManager, DropDownDiv and WidgetDiv.
          field.showEditor();
          await new Promise(resolve => setTimeout(resolve, 30));
          B.DropDownDiv.hideWithoutAnimation();
          B.WidgetDiv.hide();
          results.push({type, value, restoredValue, width: box.width, height: box.height});
        } catch (error) {
          results.push({type, error: String(error)});
        } finally {
          B.DropDownDiv.hideWithoutAnimation(); B.WidgetDiv.hide();
          restored?.dispose(false); block?.dispose(false);
          delete B.Blocks[blockType]; delete realm.Arduino.forBlock[blockType];
        }
      }
      return results;
    });
    await testInfo.attach('custom-field-matrix', {body: JSON.stringify(results, null, 2), contentType: 'application/json'});
    expect(results).toHaveLength(17);
    for (const result of results) {
      expect(result, result.type).not.toHaveProperty('error');
      expect(result.restoredValue, result.type).toBe(result.value);
      expect(result.width, result.type).toBeGreaterThan(0);
      expect(result.height, result.type).toBeGreaterThan(0);
    }
  });

  test('keeps the minimap synchronized and pans the main workspace', async ({electronApp}, testInfo) => {
    const win = await getMainWindow(electronApp);
    const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    await openBlocklyProject(win, projectPath);
    const ready = () => expect.poll(() => win.evaluate(() => document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready'))).toBe('true');
    await ready();
    // Change only this isolated process's in-memory preference, then use the
    // real route lifecycle to create the optional minimap.
    await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      realm.projectService.configService.data.blockly.minimap = true;
      window.location.hash = '#/main/guide';
    });
    await expect(win.locator('app-blockly-editor')).toHaveCount(0);
    await openBlocklyProject(win, projectPath);
    await ready();
    await expect(win.locator('.blockly-minimap')).toBeVisible();
    const count = await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const ws = (window as any).blocklyWorkspace;
      const block = ws.newBlock('math_number', 'minimap_probe');
      block.setFieldValue(8193, 'NUM'); block.initSvg(); block.render(); block.moveBy(4000, 3000);
      await realm.Blockly.renderManagement.finishQueuedRenders();
      return ws.getAllBlocks(false).length;
    });
    const readMirror = () => win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const mini = document.querySelector('.blockly-minimap[data-minimap-ready="true"]');
      if (!mini) return null;
      const sources = [...mini.querySelectorAll('[data-minimap-source]')];
      return {count: sources.reduce((sum, source) => sum + source.querySelectorAll('.blocklyPath').length, 0),
        values: sources.flatMap(source => [...source.querySelectorAll('text')].map(text => Number(text.textContent))),
        duplicateWorkspaces: realm.Blockly.common.getAllWorkspaces().filter((ws: any) =>
          ws.getInjectionDiv?.()?.closest('.blockly-minimap')).length};
    });
    await expect.poll(readMirror).toMatchObject({count, values: expect.arrayContaining([8193]), duplicateWorkspaces: 0});
    await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('minimap_probe').setFieldValue(8194, 'NUM'));
    await expect.poll(readMirror).toMatchObject({count, values: expect.arrayContaining([8194])});
    const before = await win.evaluate(() => ({x: (window as any).blocklyWorkspace.scrollX, y: (window as any).blocklyWorkspace.scrollY}));
    const bounds = await win.locator('.blockly-minimap').boundingBox();
    if (!bounds) throw new Error('Minimap has no rendered bounds');
    await win.mouse.click(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.8);
    await expect.poll(() => win.evaluate(() => ({x: (window as any).blocklyWorkspace.scrollX, y: (window as any).blocklyWorkspace.scrollY}))).not.toEqual(before);
    const clicked = await win.evaluate(() => (window as any).blocklyWorkspace.scrollY);
    await win.locator('.blockly-minimap').press('ArrowDown');
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.scrollY)).not.toBe(clicked);
    await expect(win.locator('.blockly-minimap .blockly-focus-region')).toHaveAttribute('width', /[0-9]/);
    await win.screenshot({path: testInfo.outputPath('minimap-pan.png')});
    await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('minimap_probe').dispose(false));
    await expect.poll(readMirror).toMatchObject({count: count - 1});
    expect(errors).toEqual([]);
  });

  test('selects, drags, copies, pastes and deletes multiple blocks with real pointer and keyboard input', async ({electronApp}, testInfo) => {
    const win = await getMainWindow(electronApp);
    const errors: string[] = [];
    win.on('pageerror', e => errors.push(e.message));
    await openBlocklyProject(win, projectPath);
    await expect.poll(() => win.evaluate(() => document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready'))).toBe('true');
    const before = await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly;
      const ws = (window as any).blocklyWorkspace;
      ws.clear(); ws.setScale(1);
      // Verify pointer delta independently of the application's delayed grid snap.
      ws.getGrid().setSnapToGrid(false);
      const blocks = [0, 1].map(i => {
        const block = ws.newBlock('time_delay', `multi_probe_${i}`);
        block.initSvg(); block.render(); block.moveBy(150 + 250 * i, 120);
        return block;
      });
      await B.renderManagement.finishQueuedRenders();
      ws.scrollCenter(); ws.clearUndo();
      B.getFocusManager().focusNode(ws.getRootFocusableNode());
      return blocks.map((b: any) => ({id: b.id, x: b.getRelativeToSurfaceXY().x, y: b.getRelativeToSurfaceXY().y}));
    });
    await win.keyboard.press('ControlOrMeta+A');
    await expect.poll(() => win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      return realm.Blockly.getSelected()?.subDraggables?.size || 0;
    })).toBe(2);
    const start = await win.evaluate(() => {
      const block = (window as any).blocklyWorkspace.getBlockById('multi_probe_0');
      const rect = block.getSvgRoot().querySelector('.blocklyPath').getBoundingClientRect();
      return {x: rect.x + 8, y: rect.y + rect.height / 2};
    });
    const readSelection = () => win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly;
      const selected = B.getSelected();
      return {id: selected?.id, size: selected?.subDraggables?.size, focused: document.activeElement?.id,
        gesture: B.Gesture.inProgress(), positions: (window as any).blocklyWorkspace.getAllBlocks(false).map((b: any) => ({id:b.id, x:b.getRelativeToSurfaceXY().x,y:b.getRelativeToSurfaceXY().y}))};
    });
    const stages: any[] = [await readSelection()];
    await win.mouse.move(start.x, start.y);
    stages.push(await readSelection());
    await win.mouse.down();
    stages.push(await readSelection());
    await win.mouse.move(start.x + 70, start.y + 45, {steps: 12});
    await win.mouse.up();
    const after = await win.evaluate(() => ['multi_probe_0', 'multi_probe_1'].map(id => {
      const b = (window as any).blocklyWorkspace.getBlockById(id);
      return {id, x: b.getRelativeToSurfaceXY().x, y: b.getRelativeToSurfaceXY().y};
    }));
    stages.push(await readSelection());
    await testInfo.attach('multi-drag-coordinates', {body: JSON.stringify({before, after, errors, stages}, null, 2), contentType: 'application/json'});
    await win.screenshot({path: testInfo.outputPath('multi-drag.png')});
    expect(errors).toEqual([]);
    expect(after[0].x - before[0].x).toBeCloseTo(70, 0);
    expect(after[0].y - before[0].y).toBeCloseTo(45, 0);
    expect(after[1].x - before[1].x).toBeCloseTo(70, 0);
    expect(after[1].y - before[1].y).toBeCloseTo(45, 0);
    await win.keyboard.press('ControlOrMeta+C');
    await win.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getAllBlocks(false).length)).toBe(4);
    await win.keyboard.press('ControlOrMeta+A');
    await expect.poll(() => win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      return realm.Blockly.getSelected()?.subDraggables?.size || 0;
    })).toBe(4);
    stages.push(await readSelection());
    await win.keyboard.press('Backspace');
    stages.push(await readSelection());
    await testInfo.attach('multi-delete-state', {body: JSON.stringify({errors, stages}, null, 2), contentType: 'application/json'});
    expect(errors).toEqual([]);
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getAllBlocks(false).length)).toBe(0);
  });
});
