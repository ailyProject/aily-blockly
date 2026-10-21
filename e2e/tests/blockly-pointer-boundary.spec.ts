import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {closeAilyElectronApp, expect, getMainWindow, openBlocklyProject, test} from '../fixtures/electron-app';

const PROJECT_PATH = process.env['AILY_E2E_PROJECT'];

test('Blockly releases canvas, block and scrollbar drags across an isolated iframe', async ({electronApp}, testInfo) => {
  test.skip(!PROJECT_PATH, 'Set AILY_E2E_PROJECT to an installed project with lib-core-io.');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'aily-pointer-boundary-'));
  const project = path.join(temp, 'project');
  const win = await getMainWindow(electronApp);
  const errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  try {
    await cp(PROJECT_PATH!, project, {recursive: true, filter: source =>
      !['.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock'].includes(path.basename(source))});
    await writeFile(path.join(project, 'project.abi'), await readFile(path.join(__dirname, '../fixtures/focus-recovery.abi')));
    await (await electronApp.browserWindow(win)).evaluate(window => window.setContentSize(1440, 900));
    await openBlocklyProject(win, project);
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace?.getAllBlocks(false).length), {timeout: 60_000}).toBe(21);
    await expect.poll(() => win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement)?.contentWindow as any;
      return realm?.projectService?.stateSubject?.value;
    })).toBe('loaded');
    const later = win.getByText('稍后登录', {exact: true});
    if (await later.isVisible()) await later.click();
    await electronApp.evaluate(({app}) => app.focus({steal: true}));
    await (await electronApp.browserWindow(win)).evaluate(window => window.focus());
    await expect.poll(() => win.evaluate(() => document.hasFocus())).toBe(true);
    await win.evaluate(() => {
      const events = (window as any).__boundaryEvents = [];
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
        document.addEventListener(type, (e: PointerEvent) => {
          events.push({type, id: e.pointerId, buttons: e.buttons, target: (e.target as Element)?.outerHTML?.slice(0, 160)});
        }, true);
      }
      window.addEventListener('blur', () => events.push({type: 'blur'}));
      const iframe = document.createElement('iframe');
      iframe.id = 'pointer-boundary-child';
      // Opaque origin: the host cannot read or relay this child document's events.
      iframe.sandbox.add('allow-scripts');
      iframe.srcdoc = '<body style="background:#dae7f3;font:18px sans-serif">子应用鼠标边界<input aria-label="child input"></body>';
      iframe.style.cssText = 'position:fixed;right:16px;top:180px;width:280px;height:440px;z-index:2147483647';
      document.body.append(iframe);
    });
    await expect(win.frameLocator('#pointer-boundary-child').locator('input')).toBeVisible();
    const child = await win.locator('#pointer-boundary-child').boundingBox();
    if (!child) throw new Error('Child iframe is missing');
    const end = {x: child.x + 90, y: child.y + 170};
    const state = () => win.evaluate(() => {
      const ws = (window as any).blocklyWorkspace;
      return {gesture: !!ws.getGesture(), dragging: ws.isDragging(), x: ws.scrollX, y: ws.scrollY,
        scrollbar: !!(ws.scrollbar.hScroll.onMouseMoveWrapper_ || ws.scrollbar.vScroll.onMouseMoveWrapper_),
        block: {...ws.getBlockById('write4').getRelativeToSurfaceXY()}};
    });
    const results: any[] = [];
    const point = async (kind: string) => {
      await win.evaluate(async () => {
        (window as any).blocklyWorkspace.centerOnBlock('write4');
        await (window as any).Blockly.renderManagement.finishQueuedRenders();
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      });
      return win.evaluate(kind => {
        const ws = (window as any).blocklyWorkspace;
        if (kind === 'block') {
          const b = ws.getBlockById('write4').pathObject.svgPath.getBoundingClientRect();
          return {x: b.x + 32, y: b.y + 18};
        }
        if (kind.endsWith('scrollbar')) {
          const handle = (kind === 'vertical-scrollbar' ? ws.scrollbar.vScroll : ws.scrollbar.hScroll).svgHandle;
          const b = handle.getBoundingClientRect();
          // The floating toolbar can cover part of the horizontal handle.
          for (let x = b.x + 3; x < b.right; x += 5) for (let y = b.y + 3; y < b.bottom; y += 5) {
            if (document.elementFromPoint(x, y) === handle) return {x, y};
          }
          throw new Error('No exposed scrollbar hit target');
        }
        const bounds = ws.getParentSvg().getBoundingClientRect();
        for (let y = bounds.y + 80; y < bounds.bottom - 60; y += 40) {
          for (let x = bounds.x + 250; x < Math.min(bounds.right - 100, 1000); x += 40) {
            if (document.elementFromPoint(x, y)?.classList.contains('blocklyMainBackground')) return {x, y};
          }
        }
        throw new Error('No empty workspace hit target');
      }, kind);
    };
    for (const kind of ['canvas', 'block', 'horizontal-scrollbar', 'vertical-scrollbar']) {
      const start = await point(kind);
      // Edge scrollbars must first move inward, otherwise the setup itself
      // leaves the native window and correctly triggers capture-loss cleanup.
      const directionX = kind === 'vertical-scrollbar' ? -1 : 1;
      const directionY = kind.endsWith('scrollbar') ? -1 : 1;
      const hit = await win.evaluate(start => {
        const element = document.elementFromPoint(start.x, start.y);
        return {block: element?.closest('[data-id]')?.getAttribute('data-id'), classes: element?.getAttribute('class')};
      }, start);
      if (kind === 'block') expect(hit.block).toBe('write4');
      if (kind.endsWith('scrollbar')) expect(hit.classes).toContain('blocklyScrollbarHandle');
      await win.mouse.move(start.x, start.y);
      await win.mouse.down();
      await win.mouse.move(start.x + 25 * directionX, start.y + 20 * directionY, {steps: 4});
      expect(await win.evaluate(kind => {
        const ws = (window as any).blocklyWorkspace;
        return kind.endsWith('scrollbar')
          ? !!(kind === 'vertical-scrollbar' ? ws.scrollbar.vScroll : ws.scrollbar.hScroll).onMouseMoveWrapper_
          : ws.isDragging();
      }, kind), `${kind}: native drag actually started`).toBe(true);
      await win.mouse.move(end.x, end.y, {steps: 12});
      await win.mouse.up();
      const released = await state();
      await win.mouse.move(start.x + 50 * directionX, start.y + 40 * directionY, {steps: 6});
      const returned = await state();
      await win.mouse.move(start.x + 85 * directionX, start.y + 65 * directionY, {steps: 6});
      const moved = await state();
      results.push({kind, start, released, returned, moved});
      // Let all boundary variants report their baseline before the assertion.
      await win.evaluate(() => {
        const ws = (window as any).blocklyWorkspace;
        ws.cancelCurrentGesture();
        ws.scrollbar.hScroll.onMouseUpHandle();
        ws.scrollbar.vScroll.onMouseUpHandle();
      });
    }
    for (const mode of ['held-return', 'outside-content', 'lost-capture', 'window-blur', 'capture-unavailable']) {
      if (mode === 'window-blur') {
        await electronApp.evaluate(({app}) => app.focus({steal: true}));
        await (await electronApp.browserWindow(win)).evaluate(window => window.focus());
        await expect.poll(() => win.evaluate(() => document.hasFocus())).toBe(true);
      }
      const start = await point('canvas');
      if (mode === 'capture-unavailable') await win.evaluate(() => {
        const host = (window as any).blocklyWorkspace.getInjectionDiv();
        host.setPointerCapture = () => { throw new Error('test: capture unavailable'); };
      });
      await win.mouse.move(start.x, start.y); await win.mouse.down();
      await win.mouse.move(start.x + 25, start.y + 20, {steps: 4});
      expect((await state()).dragging, `${mode}: native drag started`).toBe(true);
      if (mode === 'lost-capture') {
        await win.evaluate(() => {
          const ws = (window as any).blocklyWorkspace;
          const id = ws.getGesture().mostRecentEvent.pointerId;
          const host = ws.getInjectionDiv();
          if (!host.hasPointerCapture(id)) throw new Error('Pointer capture was not acquired');
          host.releasePointerCapture(id);
        });
        await win.mouse.move(start.x + 35, start.y + 30);
        expect((await state()).gesture).toBe(false);
        await win.mouse.up();
      } else if (mode === 'window-blur') {
        const otherWindow = await electronApp.evaluate(async ({BrowserWindow}) => {
          const other = new BrowserWindow({width: 240, height: 140, show: false});
          await other.loadURL('about:blank');
          other.show(); other.focus();
          return other.id;
        });
        await expect.poll(async () => (await state()).gesture).toBe(false);
        await win.mouse.up();
        await electronApp.evaluate(({BrowserWindow}, id) => BrowserWindow.fromId(id)?.destroy(), otherWindow);
        await (await electronApp.browserWindow(win)).evaluate(window => window.focus());
      } else {
        await win.mouse.move(mode === 'outside-content' ? -30 : end.x, mode === 'outside-content' ? -30 : end.y, {steps: 8});
        if (mode === 'held-return') {
          await win.mouse.move(start.x + 45, start.y + 30, {steps: 8});
          expect((await state()).dragging).toBe(true);
        }
        await win.mouse.up();
      }
      const beforeReturn = await state();
      await win.mouse.move(start.x + 50, start.y + 40, {steps: 6});
      const returned = await state();
      expect(returned.gesture, mode).toBe(false);
      expect(returned.dragging, mode).toBe(false);
      if (mode === 'capture-unavailable') {
        expect([returned.x, returned.y]).toEqual([beforeReturn.x, beforeReturn.y]);
        await win.evaluate(() => { delete (window as any).blocklyWorkspace.getInjectionDiv().setPointerCapture; });
      }
      await win.mouse.move(start.x + 80, start.y + 60, {steps: 6});
      expect(await state(), `${mode}: released drag stays still`).toEqual(returned);
      results.push({kind: mode, released: returned, returned, moved: await state()});
    }

    // A fresh flyout block uses a different creator workspace and its source
    // SVG disappears on auto-close. Capture must survive that transition.
    await win.locator('app-blockly-toolbox-pane .toolbox-item').first().click();
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getFlyout().isVisible())).toBe(true);
    const flyoutStart = await win.evaluate(async () => {
      const ws = (window as any).blocklyWorkspace;
      await (window as any).Blockly.renderManagement.finishQueuedRenders();
      const b = ws.getFlyout().getWorkspace().getTopBlocks(false)[0];
      const rect = b.pathObject.svgPath.getBoundingClientRect();
      return {x: rect.x + 15, y: rect.y + 15, count: ws.getAllBlocks(false).length};
    });
    await win.mouse.move(flyoutStart.x, flyoutStart.y); await win.mouse.down();
    const flyoutCapture = await win.evaluate(() => {
      const ws = (window as any).blocklyWorkspace, fly = ws.getFlyout().getWorkspace();
      const gesture = ws.getGesture(), id = gesture?.mostRecentEvent?.pointerId;
      return {id, captured: ws.getInjectionDiv().hasPointerCapture(id), sameDoc: fly.getParentSvg().ownerDocument === document,
        captureConnected: ws.getInjectionDiv().isConnected, flyoutSvg: fly.getParentSvg().outerHTML.slice(0, 180)};
    });
    await writeFile(testInfo.outputPath('flyout-capture.json'), JSON.stringify(flyoutCapture, null, 2));
    await win.mouse.move(end.x, end.y, {steps: 16});
    expect((await state()).dragging).toBe(true);
    await win.mouse.up();
    await expect.poll(async () => (await state()).gesture).toBe(false);
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getAllBlocks(false).length)).toBeGreaterThan(flyoutStart.count);
    const flyoutReleased = await win.evaluate(() => (window as any).blocklyWorkspace.getTopBlocks(false).map(b => [b.id, {...b.getRelativeToSurfaceXY()}]));
    await win.mouse.move(800, 500, {steps: 8});
    await win.mouse.move(850, 550, {steps: 8});
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getTopBlocks(false).map(b => [b.id, {...b.getRelativeToSurfaceXY()}]))).toEqual(flyoutReleased);

    // Existing nearby controls already capture their own pointer. Keep their
    // independent ownership and confirm iframe releases do not regress them.
    for (const selector of ['.blockly-minimap', 'app-dev-tool .drag-handle']) {
      const control = win.locator(selector);
      if (selector === '.blockly-minimap' && await control.count() === 0) continue;
      await control.hover();
      const rect = await control.boundingBox();
      if (!rect) throw new Error(`Missing control: ${selector}`);
      await win.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await win.mouse.down();
      await win.mouse.move(end.x, end.y, {steps: 12}); await win.mouse.up();
      await win.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      const stopped = await state(), stoppedBox = await control.boundingBox();
      await win.mouse.move(rect.x + 5, rect.y + 5, {steps: 6});
      await win.mouse.move(rect.x + 30, rect.y + 25, {steps: 6});
      expect(await state(), selector).toEqual(stopped);
      expect(await control.boundingBox(), selector).toEqual(stoppedBox);
    }
    expect(await win.evaluate(() => document.documentElement.classList.contains('aily-blockly-mouse-drag'))).toBe(false);
    const childInput = win.frameLocator('#pointer-boundary-child').locator('input');
    await childInput.fill('child interaction restored');
    await expect(childInput).toHaveValue('child interaction restored');
    await win.screenshot({path: testInfo.outputPath('pointer-boundary.png')});
    await writeFile(testInfo.outputPath('pointer-boundary.json'), JSON.stringify(results, null, 2));
    await testInfo.attach('pointer-boundary', {contentType: 'application/json', body: JSON.stringify({
      electron: await electronApp.evaluate(() => process.versions.electron), results, errors,
    }, null, 2)});
    for (const result of results) {
      expect.soft(result.released.gesture, `${result.kind}: gesture released over iframe`).toBe(false);
      expect.soft(result.released.dragging, `${result.kind}: drag released over iframe`).toBe(false);
      expect.soft(result.released.scrollbar, `${result.kind}: scrollbar listeners released`).toBe(false);
      expect.soft(result.moved, `${result.kind}: no movement without pressed buttons`).toEqual(result.returned);
    }
    expect(errors).toEqual([]);
  } catch (error) {
    console.error('Pointer boundary failure:', error);
    await writeFile(testInfo.outputPath('boundary-events.json'), JSON.stringify(await win.evaluate(() => (window as any).__boundaryEvents), null, 2)).catch(() => {});
    await win.screenshot({path: testInfo.outputPath('main-window-failure.png')}).catch(() => {});
    throw error;
  } finally {
    await closeAilyElectronApp(electronApp);
    await rm(temp, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
});
