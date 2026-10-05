import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';

const SOURCE = process.env['AILY_E2E_PROJECT'];

for (const entry of ['open', 'new-from-template']) {
test(`startup, toolbox and passive notices preserve Blockly interaction (${entry})`, async ({}, testInfo) => {
  test.skip(!SOURCE, 'Set AILY_E2E_PROJECT to an installed Blockly project.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-startup-interaction-'));
  const project = path.join(root, 'project');
  await cp(SOURCE!, project, { recursive: true, filter: source => ![
    '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock',
  ].includes(path.basename(source)) });
  const launched = await launchAilyElectron({ config: { blocklyOnboardingCompleted: true, blockly: { minimap: true } } });
  const win = await getMainWindow(launched.app);
  const errors: string[] = [];
  win.on('console', message => {
    if (/Code generation error|Trying to end a gesture recursively|Tried to start same gesture twice|Failed to generate the project source artifact/.test(message.text())) errors.push(message.text());
  });
  try {
    if (entry === 'new-from-template') {
      // Obtain the real creation service from a bootstrap project, then use its
      // template creation + host activation path (no mocked creation or save).
      await openBlocklyProject(win, project);
      await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
      await win.evaluate(async () => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        const service = [...realm.projectService.injector.records.values()].map((record: any) => record?.value)
          .find(value => typeof value?.projectNewFromTemplate === 'function');
        (window as any).__creationService = service;
        await service.close();
        delete (window as any).blocklyWorkspace;
      });
      await expect(win.locator('app-blockly-editor')).toHaveCount(0);
    }
    await win.evaluate(() => {
      const probe = (window as any).__startupProbe = { calls: [], phase: 'load' };
      const timer = setInterval(() => {
        const B = (window as any).Blockly;
        const ws = (window as any).blocklyWorkspace;
        if (!B || !ws) return;
        clearInterval(timer);
        for (const name of ['hideChaff', 'cancelCurrentGesture', 'updateToolbox']) {
          const original = ws[name];
          ws[name] = function (...args) {
            if (this === (window as any).blocklyWorkspace) {
              probe.calls.push({ name, phase: probe.phase, args: name === 'hideChaff' ? args : [],
                flyout: this.getFlyout()?.isVisible(), dragging: this.isDragging(),
                field: B.WidgetDiv.isVisible(), stack: new Error().stack });
            }
            return original.apply(this, args);
          };
        }
      }, 5);
    });
    let creation: Promise<boolean> | undefined;
    if (entry === 'open') await openBlocklyProject(win, project);
    else creation = win.evaluate(({ project, root }) => {
      const service = (window as any).__creationService;
      const pkg = JSON.parse((window as any).fs.readFileSync(`${project}/package.json`, 'utf8'));
      const board = Object.keys(pkg.dependencies).find(name => name.includes('/board-'));
      return service.projectNewFromTemplate({ name: 'created', path: root, devmode: pkg.devmode,
        board: { name: board, version: pkg.dependencies[board] } }, project);
    }, { project, root });
    const category = win.locator('.toolbox-item').first();
    await category.click();
    await win.waitForTimeout(2200);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
    if (creation) expect(await creation).toBe(true);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getFlyout().isVisible())).toBe(true);
    const publishedProject = entry === 'open' ? project : path.join(root, 'created');
    await expect.poll(async () => readFile(path.join(publishedProject, '.temp/sketch/sketch.ino'), 'utf8')
      .then(code => code.length).catch(() => 0)).toBeGreaterThan(0);
    expect(await win.evaluate(() => (window as any).__startupProbe.calls.filter(call => call.name === 'cancelCurrentGesture'))).toEqual([]);
    await win.screenshot({ path: testInfo.outputPath('startup-toolbox.png') });
    await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const records = realm.projectService.injector.records;
      const editor = [...records.values()].map((record: any) => record?.value)
        .find(value => typeof value?.acquireWorkspaceEditLease === 'function');
      if (!editor) throw new Error('Cannot locate active editor service for notice fixture.');
      (window as any).__startupEditor = editor;
      (window as any).__startupProbe.phase = 'notification';
    });
    await expect.poll(() => win.evaluate(() => (window as any).__startupEditor.getGeneratedCode()))
      .toBe(await readFile(path.join(publishedProject, '.temp/sketch/sketch.ino'), 'utf8'));
    await win.evaluate(() => (window as any).__startupEditor.noticeService.update({
      title: 'Interaction regression', text: 'Passive progress update', state: 'doing', progress: 42, sendToLog: false,
    }));
    await win.waitForTimeout(1200);
    await expect(win.locator('.notification-box')).toBeVisible();
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getFlyout().isVisible())).toBe(true);
    await win.locator('[data-toolbox-sort-key="@aily-project/lib-core-time"] .toolbox-item').click();
    await win.evaluate(() => {
      const ws = (window as any).blocklyWorkspace;
      ws.getFlyout().getWorkspace().getTopBlocks(false)[0].getSvgRoot().setAttribute('data-startup-flyout', 'drag');
      (window as any).__startupProbe.phase = 'flyout-drag';
    });
    const source = win.locator('[data-startup-flyout="drag"] .blocklyText').first();
    const box = await source.boundingBox();
    if (!box) throw new Error('Flyout block is not rendered.');
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + 400, box.y + 60, { steps: 10 });
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
    await win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      (window as any).__startupEditor.noticeService.update({ title: 'Download finished', text: 'Background notification', state: 'done', sendToLog: false });
      B.Events.fire(new B.Events.FinishedLoading(ws));
    });
    await win.waitForTimeout(1300);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
    await win.mouse.move(box.x + 440, box.y + 90, { steps: 5 });
    await win.mouse.up();
    await win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      B.Blocks.startup_probe = { init() {
        this.appendDummyInput().appendField('startup probe').appendField(new B.FieldTextInput('initial'), 'TEXT')
          .appendField(new B.FieldNumber(1), 'NUM').appendField(new B.FieldDropdown([['one', 'A'], ['two', 'B']]), 'CHOICE');
        this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(170);
      } };
      realm.Arduino.forBlock.startup_probe = block => {
        realm.Arduino.addSetup(`startup_${block.id}`,
          `// ${block.getFieldValue('TEXT')} ${block.getFieldValue('NUM')} ${block.getFieldValue('CHOICE')}\n// ${block.getCommentText()}\n`);
        return '';
      };
      const blocks = ['first', 'second'].map((id, index) => {
        const block = ws.newBlock('startup_probe', id); block.initSvg(); block.render(); block.moveBy(1000, 1000 + index * 75);
        block.getSvgRoot().setAttribute('data-startup-block', id);
        for (const field of ['TEXT', 'NUM', 'CHOICE']) block.getField(field).getClickTarget_().setAttribute('data-startup-field', `${id}-${field}`);
        return block;
      });
      blocks[0].nextConnection.connect(blocks[1].previousConnection);
      (window as any).__noticeTimer = setInterval(() => (window as any).__startupEditor.noticeService.update({
        title: 'Background progress', text: 'Notification during user interaction', state: 'doing', progress: Date.now() % 100, sendToLog: false,
      }), 200);
      (window as any).__startupProbe.phase = 'workspace-pan';
    });
    // Pan an actual empty canvas point, rather than confusing block dragging
    // with workspace dragging or landing on the minimap/notification overlay.
    const pan = await win.evaluate(() => {
      const ws = (window as any).blocklyWorkspace;
      const bounds = ws.getParentSvg().getBoundingClientRect();
      for (const y of [0.35, 0.5, 0.65]) for (const x of [0.4, 0.55, 0.7]) {
        const point = { x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y };
        if (document.elementFromPoint(point.x, point.y)?.classList.contains('blocklyMainBackground')) return point;
      }
      throw new Error('No empty canvas point is available for the pan fixture.');
    });
    const scroll = () => win.evaluate(() => {
      const ws = (window as any).blocklyWorkspace; return { x: ws.scrollX, y: ws.scrollY };
    });
    const beforePan = await scroll();
    await win.mouse.move(pan.x, pan.y); await win.mouse.down();
    await win.mouse.move(pan.x + 100, pan.y + 60, { steps: 8 });
    await win.waitForTimeout(1300);
    expect(await win.evaluate(() => !!(window as any).blocklyWorkspace.currentGesture_)).toBe(true);
    const heldPan = await scroll(); expect(heldPan).not.toEqual(beforePan);
    await win.mouse.move(pan.x + 150, pan.y + 90, { steps: 5 });
    expect(await scroll()).not.toEqual(heldPan); await win.mouse.up();
    await win.evaluate(() => { (window as any).__startupProbe.phase = 'consecutive-drag'; });
    for (const id of ['second', 'first', 'second']) {
      await win.evaluate(id => (window as any).blocklyWorkspace.centerOnBlock(id), id);
      const label = win.locator(`[data-startup-block="${id}"] .blocklyText`).first();
      await label.hover(); const rect = await label.boundingBox();
      if (!rect) throw new Error('Probe not rendered.');
      await win.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await win.mouse.down();
      await win.mouse.move(rect.x + 220, rect.y + 70, { steps: 8 });
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
      await win.waitForTimeout(1300);
      expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
      await win.mouse.up();
    }
    await win.evaluate(() => { (window as any).__startupProbe.phase = 'editing'; (window as any).blocklyWorkspace.centerOnBlock('second'); });
    for (const field of ['TEXT', 'NUM']) {
      await win.locator(`[data-startup-field="second-${field}"]`).click();
      const input = win.locator('.blocklyHtmlInput');
      await input.fill(field === 'TEXT' ? '连续输入' : '42');
      await win.waitForTimeout(1200); await expect(input).toBeFocused(); await input.press('Enter');
    }
    await win.locator('[data-startup-field="second-CHOICE"]').click();
    await win.waitForTimeout(1200); await expect(win.locator('.blocklyDropDownDiv')).toBeVisible();
    await win.locator('.blocklyDropDownDiv').getByText('two', { exact: true }).click();
    await win.evaluate(() => {
      const B = (window as any).Blockly, block = (window as any).blocklyWorkspace.getBlockById('second');
      block.setCommentText('comment'); block.getIcon(B.icons.CommentIcon.TYPE).setBubbleVisible(true);
    });
    const comment = win.locator('textarea.blocklyTextarea').last();
    await comment.fill('通知更新不打断注释'); await win.waitForTimeout(1300); await expect(comment).toBeFocused();
    await win.screenshot({ path: testInfo.outputPath('comment-notification.png') });
    await comment.blur();
    await expect.poll(() => win.evaluate(() => (window as any).__startupEditor.getGeneratedCode())).toContain('连续输入 42 B');
    await expect.poll(() => win.evaluate(() => (window as any).__startupEditor.getGeneratedCode())).toContain('通知更新不打断注释');
    const calls = await win.evaluate(() => { clearInterval((window as any).__noticeTimer); return (window as any).__startupProbe.calls; });
    expect(calls.filter(call => call.name === 'cancelCurrentGesture')).toEqual([]);
    expect(errors).toEqual([]);
    await testInfo.attach('interaction-calls', { contentType: 'application/json', body: JSON.stringify(calls, null, 2) });
  } catch (error) {
    console.log('[startup-failure]', await win.evaluate(() => (window as any).__startupProbe));
    await win.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {});
    throw error;
  } finally {
    await launched.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
}
