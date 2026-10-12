import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';

const SOURCE = process.env['AILY_E2E_PROJECT'];
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

for (const minimap of [true, false]) {
  test(`AI ABS publication refreshes the minimap and code preview (minimap=${minimap})`, async ({}, testInfo) => {
    test.skip(!SOURCE, 'Set AILY_E2E_PROJECT to an installed Blockly project.');
    const root = await mkdtemp(path.join(os.tmpdir(), 'aily-ai-minimap-'));
    const project = path.join(root, 'project');
    await cp(SOURCE!, project, { recursive: true, filter: source => ![
      '.git', '.aily', '.temp', '.build', '.log', '.workspace-history',
      'project-open.lock', 'project.abs', 'project.abs.map.json',
    ].includes(path.basename(source)) });
    const launched = await launchAilyElectron({ config: { blockly: { minimap } } });
    const win = await getMainWindow(launched.app);
    const errors: string[] = [];
    win.on('console', message => {
      if (/Minimap .*failed|Code generation error|Trying to end a gesture recursively/.test(message.text())) {
        errors.push(message.text()); console.log('[minimap-regression]', message.text());
      }
    });
    try {
      await openBlocklyProject(win, project);
      await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
      await expect.poll(() => win.evaluate(project => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        return realm.projectService.getBlocklyProjectLoadStatus(project).ready;
      }, project), {timeout: 60_000}).toBe(true);
      const windowHandle = await launched.app.browserWindow(win);
      const contentsId = await windowHandle.evaluate(window => window.webContents.id);
      // The same host bridge used by Agent tools; receipts are issued by the real
      // validate operation, and apply persists ABI/ABS before returning.
      const operation = async (operation: string, params: Record<string, unknown>): Promise<any> => {
        return launched.app.evaluate(({ ipcMain, webContents }, request) => new Promise((resolve, reject) => {
          const channel = 'cli-bridge:blockly-live-operation:response';
          const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error(`Timed out: ${request.operation}`)); }, 40_000);
          const listener = (_event: unknown, reply: any) => {
            if (reply?.requestId !== request.requestId) return;
            clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(reply);
          };
          ipcMain.on(channel, listener);
          webContents.fromId(request.contentsId)!.send('cli-bridge:blockly-live-operation', request);
        }), { contentsId, requestId: randomUUID(), path: project, operation, params });
      };

      const saved = await win.evaluate(async project => {
        const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
        // Reuse installed libraries but start with only the board's entry roots.
        const state = B.serialization.workspaces.save(ws);
        state.blocks.blocks = state.blocks.blocks.filter(block => ['arduino_global', 'arduino_setup', 'arduino_loop'].includes(block.type))
          .map(({ inputs, next, ...root }) => root);
        delete state.variables;
        B.serialization.workspaces.load(state, ws);
        const setup = ws.getBlocksByType('arduino_setup', false)[0];
        if (!setup) throw new Error('Fixture requires an Arduino setup root.');
        const delay = ws.newBlock('time_delay', 'minimap-delay'); delay.initSvg(); delay.render();
        const number = ws.newBlock('math_number', 'minimap-number'); number.initSvg(); number.setFieldValue(1101, 'NUM'); number.render();
        delay.getInput('DELAY_TIME').connection.connect(number.outputConnection);
        let connection = setup.inputList.find(input => input.connection)?.connection;
        while (connection?.targetBlock()) connection = connection.targetBlock().nextConnection;
        if (!connection) throw new Error('Fixture setup has no free statement connection.');
        connection.connect(delay.previousConnection);
        await B.renderManagement.finishQueuedRenders();
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        return realm.projectService.save(project, 30_000);
      }, project);
      expect(saved.success, JSON.stringify(saved)).toBe(true);

      const snapshot = () => win.evaluate(() => {
        const B = (window as any).Blockly, main = (window as any).blocklyWorkspace;
        const mini = document.querySelector('.blockly-minimap') as HTMLElement;
        // The minimap projects the native SVG and never creates another model.
        // Selecting/editing a block changes SVG stacking order. Compare all
        // rendered text values independently of that order, plus native IDs
        // and transforms, so focus changes don't imply stale content.
        const text = svg => Array.from(svg.querySelectorAll('text')).map((element: Element) => element.textContent).sort();
        const blocks = ws => ws.getAllBlocks(false).map(block => ({ id: block.id, type: block.type,
          text: text(block.getSvgRoot()), transform: block.getSvgRoot().getAttribute('transform') }));
        const projection = mini?.dataset.minimapReady === 'true' ? blocks(main).map(block => {
          const root = Array.from(mini.querySelectorAll('[data-minimap-source]')).find(element =>
            element.getAttribute('data-minimap-source') === main.getBlockById(block.id).getRootBlock().getSvgRoot().id);
          const copies = root ? [root, ...root.querySelectorAll('[data-id]')].filter(element => element.tagName.toLowerCase() === 'g') : [];
          const copy = copies.find(element => element.getAttribute('data-id') === block.id);
          return { ...block, text: copy ? text(copy) : null, transform: copy?.getAttribute('transform') ?? null };
        }) : null;
        return { main: blocks(main), mini: projection, duplicateModel: B.common.getAllWorkspaces().some(ws => ws.getInjectionDiv?.()?.closest('.blockly-minimap')), eventsEnabled: B.Events.isEnabled(),
          mainNumber: main.getBlockById('minimap-number')?.getFieldValue('NUM') };
      });
      if (minimap) {
        const overview = win.locator('.blockly-minimap');
        await expect(overview).toBeVisible();
        await expect(win.locator('.blockly-minimap > svg')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect.poll(async () => { const state = await snapshot(); return state.mini; }).toEqual((await snapshot()).main);
        const viewport = () => win.evaluate(() => {
          const ws = (window as any).blocklyWorkspace; return { x: ws.scrollX, y: ws.scrollY };
        });
        const box = await overview.boundingBox();
        if (!box) throw new Error('Minimap is not rendered.');
        const initialView = await viewport();
        await overview.click({ position: { x: box.width / 2, y: box.height / 2 } });
        await expect.poll(viewport).not.toEqual(initialView);
        const clickedView = await viewport();
        await overview.press('ArrowDown');
        await expect.poll(viewport).not.toEqual(clickedView);
        const keyboardView = await viewport();
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await win.mouse.down();
        await win.mouse.move(box.x + box.width / 2, box.y + box.height * 0.65, { steps: 5 });
        await win.mouse.up();
        await expect.poll(viewport).not.toEqual(keyboardView);
      } else {
        expect((await snapshot()).mini).toBeNull();
      }
      const exported = await operation('abs_projection', { version: 2, requestId: randomUUID(), initialize: true,
        expectedAbiHash: hash(await readFile(path.join(project, 'project.abi'), 'utf8')) });
      expect(exported.ok, JSON.stringify(exported)).toBe(true);
      let source: string = exported.abs;
      let base = exported.evidence.binding;
      expect(source).toContain('1101');

      for (const [previous, next, addRoot] of [[1101, 2202, true], [2202, 4404, false]] as const) {
        const start = source.indexOf(String(previous));
        expect(start).toBeGreaterThan(-1);
        const edits: Array<{ start: number; end: number; text: string }> = [
          { start, end: start + String(previous).length, text: String(next) },
        ];
        if (addRoot) edits.push({ start: source.length, end: source.length, text: '\ntime_delay(math_number(3303))\n' });
        else {
          const extra = /time_delay\(\s*math_number\((?:NUM=)?3303\)\s*\)/.exec(source);
          expect(extra, source).not.toBeNull();
          edits.push({ start: extra!.index, end: extra!.index + extra![0].length, text: '' });
        }
        edits.sort((a, b) => a.start - b.start);
        let candidate = source;
        for (const edit of [...edits].reverse()) candidate = candidate.slice(0, edit.start) + edit.text + candidate.slice(edit.end);
        const requestId = randomUUID();
        const validated = await operation('abs_validate', { version: 2, requestId, abs: candidate, base,
          candidate: { hash: hash(candidate), bytes: Buffer.byteLength(candidate) }, sourceEdits: [edits] });
        expect(validated.ok, JSON.stringify(validated)).toBe(true);
        const applied = await operation('abs_apply', { version: 2, requestId, abs: candidate,
          validation: validated.receipt, chunk: true });
        expect(applied.ok, JSON.stringify(applied)).toBe(true);
        expect(applied.publication.status).toBe('COMMITTED');

        // Open an editor immediately after AI completion, while its minimap
        // refresh may still be pending; the refresh must not steal input focus.
        await win.evaluate(() => {
          const ws = (window as any).blocklyWorkspace;
          ws.centerOnBlock('minimap-number');
          ws.getBlockById('minimap-number').getField('NUM').getClickTarget_().setAttribute('data-minimap-probe', 'number');
        });
        await win.locator('.blocklyBlockCanvas [data-minimap-probe="number"]').click();
        const input = win.locator('.blocklyHtmlInput');
        await expect(input).toBeFocused();
        await win.waitForTimeout(900);
        await expect(input).toBeFocused();
        await input.press('Enter');
        const current = await snapshot();
        expect(current.mainNumber).toBe(next);
        expect(current.eventsEnabled).toBe(true);
        expect(current.duplicateModel).toBe(false);
        if (minimap) {
          await expect(async () => { const state = await snapshot();
            expect(state.mini).toEqual(state.main); }).toPass({timeout: 15_000});
          const visibleNumber = await win.evaluate(next => {
            return document.querySelector('.blockly-minimap')?.textContent;
          }, next);
          expect(visibleNumber).toContain(String(next));
        } else expect(current.mini).toBeNull();
        // Publication waits while the native editor owns focus, then resumes
        // with the latest AI result through the existing coalesced IPC update.
        await expect.poll(async () => JSON.stringify(await win.evaluate(() =>
          (window as any).electronAPI.codeViewer.getState()))).toContain(`delay(${next})`);
        const saved = await readFile(path.join(project, 'project.abi'), 'utf8');
        expect(saved).toContain(String(next));
        source = await readFile(path.join(project, 'project.abs'), 'utf8');
        base = applied.evidence.binding;
      }
      expect(errors).toEqual([]);
      await win.screenshot({ path: testInfo.outputPath(`ai-minimap-${minimap ? 'enabled' : 'disabled'}.png`) });
      await testInfo.attach('minimap-evidence', { contentType: 'application/json', body: JSON.stringify(await snapshot(), null, 2) });
    } catch (error) {
      console.log('[minimap-state]', await win.evaluate(() => ({ focus: document.activeElement?.outerHTML,
        workspaces: (window as any).Blockly?.common.getAllWorkspaces().map(ws => ({id: ws.id, blocks: ws.getAllBlocks(false).length,
          div: ws.getInjectionDiv?.()?.outerHTML.slice(0, 240)})) })).catch(() => null));
      await win.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {});
      throw error;
    } finally {
      await launched.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}
