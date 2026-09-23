import {cp, mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {closeAilyElectronApp, expect, getMainWindow, openBlocklyProject, test} from '../fixtures/electron-app';

const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];

test('Blockly 1.0.2 background refresh preserves consecutive drags, editors, menus and comments', async ({electronApp}, testInfo) => {
  test.skip(!PROJECT_PATH, 'Set AILY_E2E_PROJECT to an installed Blockly project.');
  const blocklyVersion = JSON.parse(await readFile(path.join(__dirname, '../../node_modules/blockly/package.json'), 'utf8')).version;
  expect(blocklyVersion).toBe('1.0.2');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'aily-interaction-'));
  const projectPath = path.join(tempRoot, 'project');
  await cp(PROJECT_PATH!, projectPath, {recursive: true,
    filter: source => !['.git', '.temp', '.build', 'project-open.lock'].includes(path.basename(source))});
  const win = await getMainWindow(electronApp);
  const errors: string[] = [];
  win.on('console', message => {
    if (/project path|ProjectLoad|加载项目失败|项目数据加载失败|dependencies|Error/.test(message.text())) console.log(`[renderer:${message.type()}] ${message.text()}`);
    if (/Code generation error|Trying to end a gesture recursively|Tried to start same gesture twice/.test(message.text())) {
      errors.push(message.text());
    }
  });
  try {
    await openBlocklyProject(win, projectPath);
    await expect.poll(() => win.evaluate(() => {
      const iframe = document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement;
      const realm = iframe?.contentWindow as any;
      return {ready: !!((window as any).blocklyWorkspace?.getAllBlocks(false).length && realm?.Arduino
        && iframe.getAttribute('data-runtime-ready') === 'true'),
        hash: location.hash, notices: document.body.innerText.slice(-2000)};
    }), {timeout: 60_000}).toMatchObject({ready: true});

    // Use the real editor/renderer and project generator. Only the tiny program
    // is a fixture, isolated from the user's project and settings.
    await win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const probe = (window as any).__interactionProbe = {generations: 0, interruptedDrags: 0, cancellations: []};
      const originalGenerate = realm.Arduino.workspaceToCode.bind(realm.Arduino);
      realm.Arduino.workspaceToCode = (...args: any[]) => {
        probe.generations++;
        return probe.lastCode = originalGenerate(...args);
      };
      const originalCancel = ws.cancelCurrentGesture.bind(ws);
      ws.cancelCurrentGesture = () => {
        if (ws.isDragging()) probe.interruptedDrags++;
        probe.cancellations.push(new Error().stack);
        return originalCancel();
      };
      B.Blocks['interaction_probe'] = {init() {
        this.appendDummyInput().appendField('probe')
          .appendField(new B.FieldTextInput('initial'), 'TEXT')
          .appendField(new B.FieldNumber(1), 'NUMBER')
          .appendField(new B.FieldDropdown([['first', 'A'], ['second', 'B']]), 'CHOICE');
        this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(170);
      }};
      realm.Arduino.forBlock['interaction_probe'] = block => {
        realm.Arduino.addSetup(`interaction_${block.id}`,
          `// ${block.getFieldValue('TEXT')} ${block.getFieldValue('NUMBER')} ${block.getFieldValue('CHOICE')}\n// ${block.getCommentText()}\n`);
        return '';
      };
      const blocks = ['probe-a', 'probe-b', 'probe-c'].map(id => {
        const block = ws.newBlock('interaction_probe', id); block.initSvg(); block.render();
        block.getSvgRoot().setAttribute('data-interaction-block', id);
        for (const name of ['TEXT', 'NUMBER', 'CHOICE']) {
          block.getField(name).getClickTarget_().setAttribute('data-interaction-field', `${id}-${name}`);
        }
        return block;
      });
      // Keep the probes separate from the source project's arbitrary layout.
      blocks[0].moveBy(5000, 5000); blocks[1].moveBy(5000, 5070); blocks[2].moveBy(5000, 5180);
      blocks[0].nextConnection.connect(blocks[1].previousConnection);
      ws.centerOnBlock('probe-b');
    });
    await expect.poll(() => win.evaluate(() => (window as any).__interactionProbe.generations)).toBeGreaterThan(0);

    const drag = async (id: string, dx: number, holdMs: number) => {
      await win.evaluate(id => (window as any).blocklyWorkspace.centerOnBlock(id), id);
      // Hover waits for the real hit target to settle after workspace centering.
      // Drag the plain label, avoiding connection notches and editable fields.
      const block = win.locator(`[data-interaction-block="${id}"] .blocklyText`).first();
      await block.hover();
      const box = await block.boundingBox();
      if (!box) throw new Error(`Missing rendered block ${id}`);
      const start = {x: box.x + box.width / 2, y: box.y + box.height / 2};
      await win.mouse.move(start.x, start.y); await win.mouse.down();
      await win.mouse.move(start.x + dx, start.y + 25, {steps: 8});
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
      await win.waitForTimeout(holdMs);
      expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
      await win.mouse.move(start.x + dx + 15, start.y + 40, {steps: 5});
      await win.mouse.up();
      await expect.poll(() => win.evaluate(() => !!(window as any).blocklyWorkspace.currentGesture_)).toBe(false);
    };
    await drag('probe-b', 90, 1300); // Disconnect, keep holding beyond the debounce.
    await drag('probe-c', 150, 1300); // Second gesture while previous work is pending.
    await drag('probe-b', -40, 700);

    const generationsBeforeEditing = await win.evaluate(() => (window as any).__interactionProbe.generations);
    const text = win.locator('.blocklyHtmlInput');
    await win.locator('[data-interaction-field="probe-c-TEXT"]').click();
    await expect(text).toBeVisible();
    await text.fill('editing');
    await win.waitForTimeout(1200);
    await expect(text).toBeFocused();
    // Exercise composition events deterministically; this is not an OS IME test.
    await text.dispatchEvent('compositionstart', {data: ''});
    await text.fill('editing中文');
    await win.waitForTimeout(900);
    await expect(text).toBeFocused();
    await text.dispatchEvent('compositionend', {data: '中文'});
    await text.press('Enter');

    await win.locator('[data-interaction-field="probe-c-NUMBER"]').click();
    await text.fill('42');
    await win.waitForTimeout(900);
    await expect(text).toBeFocused();
    await text.press('Enter');
    await win.locator('[data-interaction-field="probe-c-CHOICE"]').click();
    const menu = win.locator('.blocklyDropDownDiv');
    await expect(menu).toBeVisible();
    await win.waitForTimeout(1200);
    await expect(menu).toBeVisible();
    await menu.getByText('second', {exact: true}).click();
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('probe-c').getFieldValue('CHOICE'))).toBe('B');

    await win.evaluate(() => {
      const B = (window as any).Blockly, block = (window as any).blocklyWorkspace.getBlockById('probe-c');
      block.setCommentText('comment');
      block.getIcon(B.icons.CommentIcon.TYPE).setBubbleVisible(true);
    });
    const comment = win.locator('textarea.blocklyTextarea').last();
    await expect(comment).toBeVisible();
    await comment.fill('注释输入后立即保存');
    await win.waitForTimeout(1500);
    await expect(comment).toBeFocused();
    expect(await win.evaluate(() => (window as any).__interactionProbe.generations)).toBe(generationsBeforeEditing);
    const interruptedDrags = await win.evaluate(() => (window as any).__interactionProbe.interruptedDrags);
    expect(interruptedDrags).toBe(0);
    await win.screenshot({path: testInfo.outputPath('comment-focus-preserved.png')});
    // Deferral must resume after editing, not permanently disable code refresh.
    await comment.blur();
    await expect.poll(() => win.evaluate(() => (window as any).__interactionProbe.generations)).toBeGreaterThan(generationsBeforeEditing);
    const latestCode = await win.evaluate(() => (window as any).__interactionProbe.lastCode);
    expect(latestCode).toContain('editing中文 42 B');
    expect(latestCode).toContain('注释输入后立即保存');
    // An explicit save still commits an in-progress comment under its edit lease.
    await comment.fill('注释输入后立即保存，保留最后输入');
    await win.evaluate(async projectPath => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      await realm.projectService.save(projectPath);
    }, projectPath);
    const saved = await readFile(path.join(projectPath, 'project.abi'), 'utf8');
    expect(saved).toContain('注释输入后立即保存，保留最后输入');
    expect(saved).toContain('editing中文');
    expect(errors).toEqual([]);
    await testInfo.attach('interaction-evidence', {contentType: 'application/json', body: JSON.stringify({
      blocklyPackage: blocklyVersion, dragHoldsMs: [1300, 1300, 700], textInput: true,
      compositionEvents: true, numberInput: true, dropdown: true, commentFocus: true,
      backgroundRefreshResumed: true, savedLiveComment: true, interruptedDrags,
    }, null, 2)});
  } catch (error) {
    await win.screenshot({path: testInfo.outputPath('failure.png')}).catch(() => {});
    throw error;
  } finally {
    await win.evaluate(() => { location.hash = '#/main/guide'; }).catch(() => {});
    // Background dependency jobs can still write logs after route disposal.
    // Close only this fixture's process before removing its project clone.
    await closeAilyElectronApp(electronApp);
    await rm(tempRoot, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
});
