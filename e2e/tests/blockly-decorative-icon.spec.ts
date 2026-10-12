import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';

const SOURCE = process.env['AILY_E2E_PROJECT'];

for (const renderer of ['thrasos', 'zelos']) {
  test(`${renderer}: decorative icons stay part of the block after click, hover and repeated drag`, async ({}, testInfo) => {
    test.skip(!SOURCE, 'Set AILY_E2E_PROJECT to an installed Blockly project.');
    const root = await mkdtemp(path.join(os.tmpdir(), 'aily-icon-gesture-'));
    const project = path.join(root, 'project');
    await cp(SOURCE!, project, { recursive: true, filter: source => ![
      '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock', 'project.abs', 'project.abs.map.json',
    ].includes(path.basename(source)) });
    const launched = await launchAilyElectron({ config: { blockly: { renderer, minimap: true } } });
    const win = await getMainWindow(launched.app);
    const errors: string[] = [];
    const evidence: unknown[] = [];
    win.on('pageerror', error => errors.push(error.message));
    win.on('console', message => {
      if (/Trying to end a gesture recursively|Tried to start same gesture twice|Trying to focus a node that can't be focused/.test(message.text())) errors.push(message.text());
    });
    const settle = () => win.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const snapshot = () => win.evaluate(() => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      const block = ws.getBlockById('icon-gesture-probe');
      const icon = block.getIcons().find(icon => icon.getType().toString() === 'aily-icon');
      const element = icon.getFocusableElement();
      const rect = element.getBoundingClientRect();
      const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      const pos = block.getRelativeToSurfaceXY();
      return { point, x: pos.x, y: pos.y, cursor: hit && getComputedStyle(hit).cursor,
        hit: hit?.tagName, hitBlock: hit?.closest('[data-id]')?.getAttribute('data-id'),
        iconFocused: element.contains(document.activeElement) || B.getFocusManager().getFocusedNode() === icon,
        blockFocused: B.getFocusManager().getFocusedNode() === block,
        canFocus: icon.canBeFocused(), role: element.getAttribute('role'), hidden: element.getAttribute('aria-hidden'),
        dragging: block.isDragging(), gesture: !!ws.currentGesture_, scale: ws.scale,
        scrollX: ws.scrollX, scrollY: ws.scrollY };
    });
    try {
      await openBlocklyProject(win, project);
      await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 90_000 });
      const count = await win.evaluate(async () => {
        const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
        const count = ws.getAllBlocks(false).length;
        const block = ws.newBlock('time_delay', 'icon-gesture-probe'); block.initSvg(); block.render();
        const number = ws.newBlock('math_number', 'icon-gesture-number'); number.initSvg(); number.render();
        block.getInput('DELAY_TIME').connection.connect(number.outputConnection);
        block.moveBy(100000, 100); ws.centerOnBlock(block.id, false);
        await B.renderManagement.finishQueuedRenders();
        return count;
      });
      const actualRenderer = await win.evaluate(() => (window as any).blocklyWorkspace.options.renderer);
      expect(actualRenderer).toBe(`aily-${renderer}`);
      evidence.push({ renderer: actualRenderer, projectBlocks: count });
      for (const virtual of [true, false]) {
        await win.evaluate(virtual => (window as any).blocklyWorkspace.setViewportRendering(virtual), virtual);
        for (const type of ['i', 'svg', 'image']) {
          await win.evaluate(type => {
            const w = window as any, ws = w.blocklyWorkspace;
            const state = { type, width: 20, height: 20, src: type === 'i' ? 'fa-solid fa-play' : type === 'svg'
              ? '<path d="M80 20 L480 256 L80 492 Z" />'
              : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"%3E%3Cpath fill="white" d="M2 1 L18 10 L2 19 Z"/%3E%3C/svg%3E' };
            w.__ailyBlockDefinitionsMap.set('time_delay', state);
            ws.getBlockById('icon-gesture-probe').render(); ws.centerOnBlock('icon-gesture-probe', false);
          }, type);
          await settle();
          for (let repeat = 0; repeat < 2; repeat++) {
            const before = await snapshot();
            await win.mouse.click(before.point.x, before.point.y);
            await win.mouse.move(before.point.x + 150, before.point.y - 70);
            await win.mouse.move(before.point.x, before.point.y);
            const clicked = await snapshot();
            evidence.push({ virtual, type, repeat, phase: 'click-hover', ...clicked });
            expect.soft(clicked.iconFocused).toBe(false);
            expect.soft(clicked.blockFocused).toBe(true);
            expect.soft(clicked.cursor).toBe('grab');
            expect.soft(clicked.role).not.toBe('button');
            expect.soft(clicked.canFocus).toBe(false);
            await win.mouse.move(clicked.point.x, clicked.point.y);
            await win.evaluate(() => (window as any).blocklyWorkspace.clearUndo());
            await win.mouse.down();
            await win.mouse.move(clicked.point.x + 75, clicked.point.y + 45, { steps: 12 });
            expect((await snapshot()).dragging).toBe(true);
            await win.mouse.up();
            await expect.poll(async () => (await snapshot()).gesture).toBe(false);
            const expected = await win.evaluate(({ x, y }) => {
              const w = window as any, grid = w.blocklyWorkspace.getGrid();
              return grid.shouldSnap() ? grid.alignXY(new w.Blockly.utils.Coordinate(x, y)) : { x, y };
            }, { x: before.x + 75 / before.scale, y: before.y + 45 / before.scale });
            // Native grid snapping is scheduled after pointerup.
            await expect.poll(async () => {
              const position = await snapshot();
              return Math.abs(position.x - expected.x) < 0.5 && Math.abs(position.y - expected.y) < 0.5;
            }).toBe(true);
            const dragged = await snapshot();
            evidence.push({ virtual, type, repeat, phase: 'drag-end', ...dragged });
            expect(dragged.x).toBeCloseTo(expected.x, 0);
            expect(dragged.y).toBeCloseTo(expected.y, 0);
            expect(dragged.iconFocused).toBe(false);
            await expect.poll(() => win.evaluate(() => {
              const stack = (window as any).blocklyWorkspace.getUndoStack();
              return stack.some(event => event.type === 'move' && event.blockId === 'icon-gesture-probe');
            })).toBe(true);
            await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
            expect((await snapshot()).x).toBeCloseTo(before.x, 0);
            expect((await snapshot()).y).toBeCloseTo(before.y, 0);
            await win.evaluate(() => (window as any).blocklyWorkspace.undo(true));
            expect((await snapshot()).x).toBeCloseTo(dragged.x, 0);
          }
        }
      }
      // Keep native editors and interactive comment icons working.
      await win.evaluate(() => {
        const ws = (window as any).blocklyWorkspace;
        ws.centerOnBlock('icon-gesture-probe', false);
        ws.getBlockById('icon-gesture-number').getField('NUM').getClickTarget_().setAttribute('data-icon-test-field', 'number');
      });
      await win.locator('[data-icon-test-field="number"]').click();
      await win.locator('.blocklyHtmlInput').fill('123');
      await win.locator('.blocklyHtmlInput').press('Enter');
      expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('icon-gesture-number').getFieldValue('NUM'))).toBe(123);
      await win.evaluate(async () => {
        const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
        const block = ws.getBlockById('icon-gesture-probe'); block.setCommentText('icon regression');
        await B.renderManagement.finishQueuedRenders();
        block.getIcon(B.icons.CommentIcon.TYPE).getFocusableElement().setAttribute('data-icon-test-comment', 'true');
      });
      await win.locator('[data-icon-test-comment="true"]').click();
      await expect(win.locator('textarea.blocklyTextarea').last()).toBeVisible();
      await win.locator('textarea.blocklyTextarea').last().fill('interactive comment still works');
      await win.locator('textarea.blocklyTextarea').last().blur();
      expect(await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('icon-gesture-probe').getCommentText())).toBe('interactive comment still works');
      await win.locator('[data-icon-test-comment="true"]').click();
      await expect(win.locator('textarea.blocklyTextarea').last()).toBeHidden();

      // Drag from the same decorative area in the actual toolbox flyout.
      await win.locator('app-blockly-toolbox-pane .toolbox-item').filter({ hasText: /时间|Time/i }).first().click();
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getFlyout().isVisible())).toBe(true);
      const flyout = await win.evaluate(() => {
        const ws = (window as any).blocklyWorkspace;
        const block = ws.getFlyout().getWorkspace().getBlocksByType('time_delay', false)[0];
        const icon = block.getIcons().find(icon => icon.getType().toString() === 'aily-icon');
        const rect = icon.getFocusableElement().getBoundingClientRect();
        const workspace = ws.getParentSvg().getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, endX: workspace.right - 200, endY: workspace.top + 160,
          count: ws.getBlocksByType('time_delay', false).length,
          hitsBlock: hit === block.pathObject.svgPath, canFocus: icon.canBeFocused() };
      });
      expect(flyout.hitsBlock).toBe(true); expect(flyout.canFocus).toBe(false);
      await win.mouse.move(flyout.x, flyout.y); await win.mouse.down();
      await win.mouse.move(flyout.endX, flyout.endY, { steps: 20 }); await win.mouse.up();
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getBlocksByType('time_delay', false).length)).toBe(flyout.count + 1);
      evidence.push({ fieldEditor: true, commentOpenEditClose: true, flyoutIconDrag: true, undoRedo: true });
      await win.screenshot({ path: testInfo.outputPath('icon-interactions.png') });
      expect(errors).toEqual([]);
    } finally {
      const evidencePath = testInfo.outputPath('icon-interaction-evidence.json');
      await writeFile(evidencePath, JSON.stringify({ evidence, errors }, null, 2));
      await testInfo.attach('icon-interaction-evidence', { contentType: 'application/json', path: evidencePath });
      await launched.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
