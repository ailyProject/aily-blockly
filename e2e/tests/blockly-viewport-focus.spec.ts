import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect, getMainWindow, launchAilyElectron, openBlocklyProject, test} from '../fixtures/electron-app';

const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];

for (const renderer of ['zelos', 'thrasos']) for (const minimap of [true, false]) {
  test(`${renderer}, minimap=${minimap}: native child-to-root drag preserves focus, connections and saved project`, async ({}, testInfo) => {
    test.skip(!PROJECT_PATH, 'Set AILY_E2E_PROJECT to an installed UNO project with lib-core-io.');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'aily-viewport-focus-'));
    const project = path.join(temp, 'project');
    const config = JSON.parse(await readFile(path.join(__dirname, '../../electron/config/config.json'), 'utf8'));
    config.blockly = {...config.blockly, renderer, minimap, viewportRendering: true};
    const launched = await launchAilyElectron({config});
    const win = await getMainWindow(launched.app);
    const errors: string[] = [];
    const steps: unknown[] = [];
    win.on('pageerror', error => errors.push(error.message));
    win.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await cp(PROJECT_PATH!, project, {recursive: true, filter: source =>
        !['.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock'].includes(path.basename(source))});
      await writeFile(path.join(project, 'project.abi'), await readFile(path.join(__dirname, '../fixtures/focus-recovery.abi')));
      await (await launched.app.browserWindow(win)).evaluate(window => window.setContentSize(1440, 840));
      await openBlocklyProject(win, project);
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace?.getAllBlocks(false).length), {timeout: 60_000}).toBe(21);
      await expect(win.locator('.blockly-minimap')).toHaveCount(minimap ? 1 : 0);
      const settle = () => win.evaluate(async () => {
        await (window as any).Blockly.renderManagement.finishQueuedRenders();
        // Focusing a different node scrolls it into view after queued renders.
        // Read pointer coordinates only after that scroll and layout complete.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
      const point = async (id: string) => {
        let target: {x: number; y: number; hit?: string};
        // Route completion precedes the loading overlay's exit animation.
        // Wait for a real pointer hit, so no gesture is silently swallowed.
        await expect.poll(async () => {
          const later = win.getByText('稍后登录', {exact: true});
          if (await later.isVisible()) await later.click();
          target = await win.evaluate(id => {
            const block = (window as any).blocklyWorkspace.getBlockById(id);
            const box = block.pathObject.svgPath.getBoundingClientRect();
            const x = box.x + 35, y = box.y + 20;
            const element = document.elementFromPoint(x, y);
            const hit = element?.closest('[data-id]')?.getAttribute('data-id') ?? element?.outerHTML.slice(0,250);
            return {x, y, hit};
          }, id);
          return target.hit;
        }).toBe(id);
        return target!;
      };
      const snapshot = () => win.evaluate(() => {
        const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace, focus = B.getFocusManager();
        return {locked: focus.lockFocusStateChanges, updating: focus.isUpdatingFocusedNode,
          gesture: !!ws.currentGesture_, dragging: ws.isDragging(), count: ws.getAllBlocks(false).length,
          focused: focus.getFocusedNode()?.id,
          blocks: ['write1', 'write2', 'write3', 'write4'].map(id => {
            const b = ws.getBlockById(id), xy = b.getRelativeToSurfaceXY();
            return {id, x: xy.x, y: xy.y, parent: b.getParent()?.id ?? null, next: b.getNextBlock()?.id ?? null};
          })};
      });
      const drag = async (id: string, dx: number, dy: number) => {
        const p = await point(id);
        await win.mouse.move(p.x, p.y); await win.mouse.down();
        await win.mouse.move(p.x + dx, p.y + dy, {steps: 12}); await win.mouse.up();
        await settle();
        await expect.poll(snapshot).toMatchObject({locked: false, updating: false, gesture: false, dragging: false, count: 21});
      };
      for (let i = 0; i < 8; i++) {
        const p = await point('write4');
        await win.mouse.click(p.x, p.y);
        await settle();
        await expect.poll(snapshot).toMatchObject({focused: 'write4'});
        const before = await snapshot();
        await drag('write3', i % 2 ? -80 : 80, i % 2 ? -40 : 40);
        const after = await snapshot();
        steps.push({before, after});
        expect(after.focused).toBe('write3');
        expect(Math.abs(after.blocks[2].x - before.blocks[2].x - (i % 2 ? -80 : 80))).toBeLessThanOrEqual(20);
        expect(Math.abs(after.blocks[2].y - before.blocks[2].y - (i % 2 ? -40 : 40))).toBeLessThanOrEqual(20);
        expect(after.blocks[2].next).toBe('write4');
        expect(after.blocks[3].parent).toBe('write3');
        expect(errors.filter(error => /FocusManager state changes|gesture had already been started|cleanup failed/.test(error))).toEqual([]);
      }
      // Break a different stack, then undo through the product shortcut.
      await drag('write2', 100, 60);
      expect((await snapshot()).blocks[1].parent).toBeNull();
      await win.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => (await snapshot()).blocks[1].parent).toBe('write1');
      await settle();
      const saved = (await snapshot()).blocks;
      const previousWorkspace = await win.evaluate(() => (window as any).blocklyWorkspace.id);
      await win.locator('app-dev-tool .fa-sync').click();
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace?.id), {timeout: 60_000}).not.toBe(previousWorkspace);
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace?.getAllBlocks(false).length), {timeout: 60_000}).toBe(21);
      await expect.poll(async () => (await snapshot()).blocks, {timeout: 60_000}).toEqual(saved);
      await expect(win.getByText('项目加载中...', {exact: true})).toHaveCount(0);
      expect(JSON.parse(await readFile(path.join(project, 'project.abi'), 'utf8')).pages.length).toBeGreaterThan(0);
      const p = await point('write4'); await win.mouse.click(p.x, p.y);
      await settle();
      await drag('write3', 40, 20);
      expect(errors.filter(error => /FocusManager state changes|gesture had already been started|cleanup failed/.test(error))).toEqual([]);
      await win.screenshot({path: testInfo.outputPath(`${renderer}-focus-fixed.png`)});
      await testInfo.attach('native-focus-evidence', {contentType: 'application/json', body: JSON.stringify({
        renderer, minimap, electron: await launched.app.evaluate(() => process.versions.electron), url: win.url(), steps, saved, final: await snapshot(), errors,
      }, null, 2)});
    } catch (error) {
      await win.screenshot({path: testInfo.outputPath('failure.png')}).catch(() => {});
      await testInfo.attach('failed-motion', {contentType: 'application/json', body: JSON.stringify({steps, errors})});
      throw error;
    } finally {
      await launched.close();
      await rm(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    }
  });
}
