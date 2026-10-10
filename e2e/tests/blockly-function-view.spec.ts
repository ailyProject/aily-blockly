import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';
import {selectFunctionView} from '../fixtures/function-view';

const SOURCE = process.env['AILY_E2E_PROJECT'];
const LONG_FUNCTION_NAME = 'viewFunction11_withLongParametersAndConfiguration';
const hash = (data: string) => createHash('sha256').update(data).digest('hex');

test('function views preserve full saves, calls, undo and navigation while reducing the painted workspace and minimap', async ({}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!SOURCE, 'Set AILY_E2E_PROJECT to an installed project with lib-core-functions.');
  const originalHash = hash(await readFile(path.join(SOURCE!, 'project.abi'), 'utf8'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-function-view-'));
  const project = path.join(root, 'project');
  await cp(SOURCE!, project, { recursive: true, filter: source => ![
    '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock', 'project.abs', 'project.abs.map.json',
  ].includes(path.basename(source)) });
  const launched = await launchAilyElectron({ config: { blockly: { minimap: true } } });
  const win = await getMainWindow(launched.app);
  const errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  win.on('console', message => {
    if (/Minimap .*failed|Code generation error|Trying to end a gesture recursively|加载项目失败/.test(message.text())) errors.push(message.text());
    if (/加载项目失败|ProjectLoad|开始重置|重置完成|runtime|dependency.*cancelled/i.test(message.text())) console.log('[function-view]', message.text());
  });
  try {
    await openBlocklyProject(win, project);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 90_000 });
    await expect.poll(() => win.evaluate(() => !!(window as any).Blockly.Blocks.custom_function_def)).toBe(true);
    await win.evaluate(async longName => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      const source = B.serialization.workspaces.save(ws);
      source.blocks.blocks = source.blocks.blocks.filter(block => ['arduino_global', 'arduino_setup', 'arduino_loop'].includes(block.type))
        .map(({ inputs, next, ...block }) => block);
      delete source.variables;
      B.Events.disable();
      try {
        ws.clear(); B.serialization.workspaces.load(source, ws);
        for (let f = 0; f < 12; f++) {
          const def = ws.newBlock('custom_function_def', `function-view-${f}`);
          def.setFieldValue(f === 11 ? longName : `viewFunction${f}`, 'FUNC_NAME'); def.setFieldValue('void', 'RETURN_TYPE');
          def.initSvg(); def.render(); def.moveBy(60 + f % 4 * 450, 100 + Math.floor(f / 4) * 1200);
          let connection = def.getInput('STACK').connection;
          for (let n = 0; n < 40; n++) {
            const delay = ws.newBlock('time_delay', `view-delay-${f}-${n}`); delay.initSvg(); delay.render();
            const number = ws.newBlock('math_number', `view-number-${f}-${n}`); number.setFieldValue(10 + f, 'NUM'); number.initSvg(); number.render();
            delay.getInput('DELAY_TIME').connection.connect(number.outputConnection);
            connection.connect(delay.previousConnection); connection = delay.nextConnection;
          }
        }
      } finally { B.Events.enable(); }
      B.Events.fire(new B.Events.FinishedLoading(ws));
      await B.renderManagement.finishQueuedRenders();
    }, LONG_FUNCTION_NAME);
    // Native generation initializes the library's function-variable metadata.
    await win.evaluate(async project => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      await realm.projectService.save(project);
    }, project);
    await win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      const call = ws.newBlock('custom_function_call_advance', 'view-call'); call.initSvg(); call.render();
      const def = ws.getBlockById('function-view-0'); call.setFieldValue(def.funcVarId_, 'FUNC_NAME');
      const setup = ws.getBlocksByType('arduino_setup', false)[0];
      setup.inputList.find(input => input.connection)?.connection.connect(call.previousConnection);
      ws.clearUndo();
      (window as any).__functionViewBaseline = JSON.stringify(B.serialization.workspaces.save(ws));
    });
    const select = win.locator('.function-view__trigger');
    await expect(select).toBeEnabled();
    await expect(win.locator('.function-view select')).toHaveCount(0);
    await select.focus();
    expect(await select.evaluate(element => ({outline: getComputedStyle(element).outlineStyle,
      shadow: getComputedStyle(element).boxShadow}))).toEqual({outline: 'none', shadow: 'none'});
    await select.press('ArrowDown');
    const menu = win.getByRole('menu', {name: '查看函数或整个文件'});
    await expect(menu).toBeVisible();
    const expectAlignedMenu = async () => {
      const triggerBox = (await select.boundingBox())!, menuBox = (await menu.boundingBox())!;
      expect(Math.abs(menuBox.x - triggerBox.x)).toBeLessThan(1);
      expect(Math.abs(menuBox.width - triggerBox.width)).toBeLessThan(1);
    };
    await expectAlignedMenu();
    await expect.poll(() => menu.evaluate(element => element.scrollTop)).toBe(0);
    await win.screenshot({path: testInfo.outputPath('function-menu.png')});
    await win.keyboard.press('End');
    await expect(menu.getByRole('menuitemradio').last()).toBeFocused();
    await win.keyboard.press('Home');
    await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(select).toBeFocused();
    await select.click();
    await win.locator('.workspace-stage').click({position: {x: 2, y: 2}});
    await expect(menu).toBeHidden();
    await select.press('ArrowDown');
    await win.keyboard.press('End');
    const lastScope = await menu.getByRole('menuitemradio').last().getAttribute('data-scope-id');
    await win.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(select).toHaveAttribute('data-scope-id', lastScope!);
    const snapshot = () => win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      const mini = document.querySelector('.blockly-minimap') as HTMLElement;
      const visible = ws.getAllBlocks(false).filter(block => block.getRootBlock().getSvgRoot().style.display !== 'none');
      return { total: ws.getAllBlocks(false).length, visible: visible.length, mini: mini?.dataset.minimapReady === 'true' ? Number(mini.dataset.minimapShapes) : -1,
        serialized: JSON.stringify(B.serialization.workspaces.save(ws)), undo: ws.getUndoStack().length };
    });
    await selectFunctionView(win, 'function-view-0');
    await expect.poll(async () => (await snapshot()).visible).toBe(81);
    await expect.poll(async () => (await snapshot()).mini).toBe(81);
    const scoped = await snapshot();
    expect(scoped.total).toBeGreaterThan(960);
    expect(scoped.serialized).toBe(await win.evaluate(() => (window as any).__functionViewBaseline));
    expect(scoped.undo).toBe(0);
    await win.screenshot({ path: testInfo.outputPath('single-function.png') });

    // Use the real field editor rather than setting a fixture value directly.
    await win.evaluate(() => {
      const ws = (window as any).blocklyWorkspace;
      ws.centerOnBlock('view-number-0-0', false);
      ws.getBlockById('view-number-0-0').getField('NUM').getClickTarget_().setAttribute('data-function-view-field', 'number');
    });
    await win.locator('.blocklyBlockCanvas [data-function-view-field="number"]').click();
    await win.locator('.blocklyHtmlInput').fill('123');
    await win.locator('.blocklyHtmlInput').press('Enter');
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('view-number-0-0').getFieldValue('NUM'))).toBe(123);
    // Blockly dispatches the final field event asynchronously after closing the
    // editor. Wait for its actual history entry before testing native undo.
    await expect.poll(() => win.evaluate(() => {
      const stack = (window as any).blocklyWorkspace.getUndoStack();
      const last = stack[stack.length - 1];
      return last?.blockId === 'view-number-0-0' && last?.element === 'field' && String(last?.newValue) === '123';
    })).toBe(true);
    await selectFunctionView(win, 'function-view-1');
    await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('view-number-0-0').getFieldValue('NUM'))).toBe(10);
    await win.evaluate(() => (window as any).blocklyWorkspace.undo(true));
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('view-number-0-0').getFieldValue('NUM'))).toBe(123);
    await win.evaluate(() => (window as any).blocklyWorkspace.centerOnBlock('view-number-0-0', false));
    await expect(select).toHaveAttribute('data-scope-id', 'function-view-0');

    // Both forms of Select All must exclude hidden functions.
    const selectedIds = await win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      B.ShortcutRegistry.registry.getRegistry().selectall.callback(ws, { preventDefault() {} });
      return [...B.getSelected().subDraggables.keys()].map(block => block.id);
    });
    expect(selectedIds).toEqual(['function-view-0']);
    await selectFunctionView(win, 'function-view-1');
    expect(await win.evaluate(() => (window as any).Blockly.getSelected())).toBeNull();
    const contextSelectedIds = await win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      B.ContextMenuRegistry.registry.getItem('workspaceSelectAll').callback({ workspace: ws });
      return [...B.getSelected().subDraggables.keys()].map(block => block.id);
    });
    expect(contextSelectedIds).toEqual(['function-view-1']);
    // Automatic navigation also retires a multi-selection that would become
    // invisible, so later delete/copy cannot affect the old function.
    await win.evaluate(() => (window as any).blocklyWorkspace.centerOnBlock('view-number-0-0', false));
    await expect(select).toHaveAttribute('data-scope-id', 'function-view-0');
    expect(await win.evaluate(() => (window as any).Blockly.getSelected())).toBeNull();

    // A pinned comment is native persisted state. Filtering may hide its SVG,
    // but must preserve the live editor value and restore the same bubble.
    await win.evaluate(async () => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      const block = ws.getBlockById('view-delay-0-0'); block.setCommentText('函数内注释');
      await block.getIcon(B.icons.CommentIcon.TYPE).setBubbleVisible(true);
    });
    const comment = win.locator('textarea.blocklyTextarea').last();
    await expect(comment).toBeVisible();
    await comment.fill('函数内注释，切换后保留'); await comment.blur();
    const commentedState = (await snapshot()).serialized;
    await selectFunctionView(win, 'function-view-1'); await expect(comment).toBeHidden();
    expect((await snapshot()).serialized).toBe(commentedState);
    await selectFunctionView(win, 'function-view-0'); await expect(comment).toBeVisible();
    expect((await snapshot()).serialized).toBe(commentedState);
    await selectFunctionView(win, 'function-view-1');

    await win.evaluate(async project => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      await realm.projectService.save(project);
    }, project);
    const saved = await readFile(path.join(project, 'project.abi'), 'utf8');
    const code = await readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8');
    for (let f = 0; f < 12; f++) expect(code).toContain(`void ${f === 11 ? LONG_FUNCTION_NAME : `viewFunction${f}`}(`);
    expect(code).toContain('viewFunction0();'); expect(code).toContain('delay(123)');

    // Exercise the actual Agent/AI ABS bridge while another function is hidden.
    await selectFunctionView(win, 'function-view-0');
    const handle = await launched.app.browserWindow(win);
    const contentsId = await handle.evaluate(window => window.webContents.id);
    const operation = (operation: string, params: Record<string, unknown>): Promise<any> => launched.app.evaluate(
      ({ ipcMain, webContents }, request) => new Promise((resolve, reject) => {
        const channel = 'cli-bridge:blockly-live-operation:response';
        const listener = (_event: unknown, reply: any) => {
          if (reply?.requestId !== request.requestId) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(reply);
        };
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error(`Timed out: ${request.operation}`)); }, 40_000);
        ipcMain.on(channel, listener); webContents.fromId(request.contentsId)!.send('cli-bridge:blockly-live-operation', request);
      }), { contentsId, requestId: randomUUID(), path: project, operation, params });
    const exported = await operation('abs_projection', { version: 2, requestId: randomUUID(), initialize: true,
      expectedAbiHash: `sha256:${hash(await readFile(path.join(project, 'project.abi'), 'utf8'))}` });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    const match = /math_number\((?:NUM=)?11\)/.exec(exported.abs);
    expect(match).not.toBeNull();
    const start = match!.index + match![0].indexOf('11');
    const edit = { start, end: start + 2, text: '911' };
    const candidate = exported.abs.slice(0, start) + edit.text + exported.abs.slice(edit.end);
    const requestId = randomUUID();
    const validated = await operation('abs_validate', { version: 2, requestId, abs: candidate,
      base: exported.evidence.binding, candidate: { hash: `sha256:${hash(candidate)}`, bytes: Buffer.byteLength(candidate) }, sourceEdits: [[edit]] });
    expect(validated.ok, JSON.stringify(validated)).toBe(true);
    const applied = await operation('abs_apply', { version: 2, requestId, abs: candidate, validation: validated.receipt, chunk: true });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    expect(applied.publication.status).toBe('COMMITTED');
    await expect(select).toHaveAttribute('data-scope-id', 'function-view-0');
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('view-number-1-0').getFieldValue('NUM'))).toBe(911);
    await expect.poll(async () => (await snapshot()).mini).toBe(81);
    expect(await readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')).toContain('delay(911)');
    const editedState = (await snapshot()).serialized;
    await select.focus(); await selectFunctionView(win, '');
    await expect(select).not.toBeFocused();
    await expect.poll(async () => (await snapshot()).visible).toBe(scoped.total);
    await expect.poll(async () => (await snapshot()).mini).toBe(scoped.total);
    expect((await snapshot()).serialized).toBe(editedState);
    const commentBeforeReopen = await win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      return ws.getBlockById('view-delay-0-0').getIcon(B.icons.CommentIcon.TYPE).saveState();
    });
    await win.screenshot({ path: testInfo.outputPath('whole-file.png') });
    await win.evaluate(() => { location.hash = '#/main/guide'; });
    await expect(select).toHaveCount(0);
    await openBlocklyProject(win, project);
    await expect.poll(() => win.evaluate(() => {
      const iframe = document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement | null;
      const realm = iframe?.contentWindow as any;
      return { ready: iframe?.getAttribute('data-runtime-ready'),
        blocks: (window as any).blocklyWorkspace?.getAllBlocks(false).length,
        load: realm?.projectService?.getBlocklyProjectLoadStatus(),
        number: (window as any).blocklyWorkspace?.getBlockById('view-number-0-0')?.getFieldValue('NUM') };
    }), { timeout: 45_000 }).toMatchObject({ ready: 'true', number: 123 });
    expect((await snapshot()).total).toBe(scoped.total);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('view-number-1-0').getFieldValue('NUM'))).toBe(911);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('view-delay-0-0').getCommentText())).toBe('函数内注释，切换后保留');
    expect(await win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      return ws.getBlockById('view-delay-0-0').getIcon(B.icons.CommentIcon.TYPE).saveState();
    })).toEqual(commentBeforeReopen);
    expect(hash(await readFile(path.join(SOURCE!, 'project.abi'), 'utf8'))).toBe(originalHash);
    // A long real function label must scroll only when it overflows, using
    // the same one-way hover motion as the application's main menu.
    await selectFunctionView(win, '');
    await select.click();
    await expectAlignedMenu();
    const longItem = menu.locator('[data-scope-id="function-view-11"]');
    await longItem.hover();
    const scrollState = (element: any) => {
      const content = element.querySelector('.function-view__text') as HTMLElement;
      const viewport = content.parentElement!;
      return {distance: content.scrollWidth - viewport.clientWidth,
        x: new DOMMatrixReadOnly(getComputedStyle(content).transform).m41};
    };
    expect((await longItem.evaluate(scrollState)).distance).toBeGreaterThan(0);
    await expect.poll(async () => (await longItem.evaluate(scrollState)).x).toBeLessThan(-2);
    await expect.poll(async () => {
      const state = await longItem.evaluate(scrollState); return Math.abs(state.x + state.distance);
    }, {timeout: 20_000}).toBeLessThan(1);
    await win.screenshot({path: testInfo.outputPath('function-menu-hover-end.png')});
    await select.hover();
    expect((await longItem.evaluate(scrollState)).x).toBe(0);
    await longItem.click();
    await expect(select).toHaveAttribute('data-scope-id', 'function-view-11');
    await select.hover();
    expect((await select.evaluate(scrollState)).distance).toBeGreaterThan(0);
    await expect.poll(async () => (await select.evaluate(scrollState)).x).toBeLessThan(-2);
    await select.click();
    await expectAlignedMenu();
    await win.keyboard.press('Escape');
    expect(errors).toEqual([]);
    await testInfo.attach('function-view-evidence', { contentType: 'application/json', body: JSON.stringify({
      totalBlocks: scoped.total, scopedBlocks: scoped.visible, scopedMinimapBlocks: scoped.mini,
      serializationUnchangedBySwitch: true, fieldEditor: true, undoRedoAcrossViews: true,
      pinnedCommentRestoredAcrossViewsAndReopen: true,
      completeFunctionsAndCallsInGeneratedSketch: true, saveReopen: true,
      aiAbsEditsHiddenFunction: true,
      originalProjectUnchanged: true, savedAbiHash: hash(saved),
    }, null, 2) });
  } catch (error) {
    console.log('[function-view] renderer errors:', JSON.stringify(errors));
    await win.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {}); throw error;
  } finally { await launched.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
