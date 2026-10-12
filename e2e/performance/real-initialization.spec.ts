import { cp, mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';

const source = process.env['AILY_E2E_PROJECT'];
test('large project initialization preserves roots through input races, editing and reopen', async () => {
  test.skip(!source, 'Set AILY_E2E_PROJECT to an installed large Blockly project.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-initialization-'));
  const sourceHash = createHash('sha256').update(await readFile(path.join(source!, 'project.abi'))).digest('hex');
  const project = path.join(temporary, 'project');
  await cp(source!, project, { recursive: true, dereference: true, filter: file => ![
    '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock',
  ].includes(path.basename(file)) });
  const output = path.resolve(process.env['BLOCKLY_INIT_OUTPUT'] || 'e2e/.artifacts/blockly-initialization-2026-10-09', process.env['BLOCKLY_INIT_LABEL'] || 'baseline');
  await mkdir(output, { recursive: true });
  const config = JSON.parse(await readFile(path.resolve('electron/config/config.json'), 'utf8'));
  config.blockly.minimap = true;
  config.blockly.renderer = process.env['BLOCKLY_INIT_RENDERER'] || 'thrasos';
  const launched = await launchAilyElectron({ config });
  const win = await getMainWindow(launched.app);
  const report: any = { source, rounds: [], errors: [], gpu: await launched.app.evaluate(({ app }) => app.getGPUFeatureStatus()) };
  let edited: { id: string; before: number; after: number } | undefined;
  let expectedCode: string | undefined;
  win.on('pageerror', error => report.errors.push(error.message));
  win.on('console', message => {
    if (/\[startup-drag\]/.test(message.text())) console.log(message.text());
    if (/discarded persisted state|Unable to open|加载项目失败/.test(message.text())) report.errors.push(message.text());
  });
  try {
    await win.evaluate(race => {
      const w = window as any; w.initialLoads = [];
      let current = w.Blockly;
      Object.defineProperty(w, 'Blockly', { configurable: true, get: () => current, set: value => {
        if (current !== value) {
          const load = value.serialization.workspaces.load;
          value.serialization.workspaces.load = function(state, ws, ...args) {
            const before = state.blocks?.blocks?.map(block => block.id) || [];
            const start = performance.now();
            try { return load.call(this, state, ws, ...args); }
            finally { if (ws.rendered) w.initialLoads.push({ before,
              after: ws.getTopBlocks(false).map(block => block.id), count: ws.getAllBlocks(false).length,
              ms: performance.now() - start, stats: ws.getViewportRenderer()?.getStats() });
              if (race && ws.rendered && ws.getAllBlocks(false).length > 7000) queueMicrotask(() => {
                const block = ws.getAllBlocks(false).find(b => b.getParent() && b.isMovable() && !b.isShadow()
                  && b.getSvgRoot().isConnected && b.getSvgRoot().getBoundingClientRect().top < 600);
                if (!block) throw Error('No startup drag target');
                const before = ws.getTopBlocks(false).map(b => b.id);
                const rect = block.getSvgRoot().getBoundingClientRect();
                const x = rect.x + 15, y = rect.y + 10;
                const send = (target, type, dx = 0, dy = 0) => target.dispatchEvent(new PointerEvent(type, {
                  bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
                  button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x + dx, clientY: y + dy }));
                const accepted = send(block.pathObject.svgPath, 'pointerdown');
                send(document, 'pointermove', 90, 50); send(document, 'pointermove', 160, 90);
                send(document, 'pointerup', 160, 90);
                w.startupDrag = { accepted, target: block.id, before, after: ws.getTopBlocks(false).map(b => b.id) };
                console.log('[startup-drag]', JSON.stringify(w.startupDrag));
              });
            }
          };
        }
        current = value;
      } });
    }, !!process.env['BLOCKLY_INIT_RACE']);
    if (process.env['BLOCKLY_INIT_CANCEL']) {
      await openBlocklyProject(win, project);
      await win.waitForFunction(() => {
        const ws = (window as any).blocklyWorkspace;
        return ws && !ws.getCanvas().isConnected && ws.getAllBlocks(false).length > 64;
      });
      await win.evaluate(() => { location.hash = '#/main/guide'; });
      await expect(win.locator('app-blockly-editor')).toHaveCount(0);
      report.cancelledPartialLoad = true;
    }
    for (let round = 0; round < Number(process.env['BLOCKLY_INIT_ROUNDS'] || 4); round++) {
      const storedProject = JSON.parse(await readFile(path.join(project, 'project.abi'), 'utf8'));
      const storedPage = storedProject.pages?.find(page => page.id === storedProject.activePageId);
      const requestedScale = process.env['BLOCKLY_INIT_SCALES']?.split(',')[round];
      if (requestedScale && storedPage) {
        storedPage.viewState = { ...storedPage.viewState, scale: Number(requestedScale) };
        await writeFile(path.join(project, 'project.abi'), JSON.stringify(storedProject));
      }
      await win.evaluate(race => {
        const w = window as any;
        w.startupDrags = [];
        const sample = w.loadResponsiveness = { tasks: [] as number[], frames: [] as number[], views: [] as any[], previous: performance.now(), active: true };
        sample.observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) sample.tasks.push(entry.duration);
        });
        sample.observer.observe({ entryTypes: ['longtask'] });
        const frame = (now: number) => {
          sample.frames.push(now - sample.previous); sample.previous = now;
          const ws = w.blocklyWorkspace;
          const canvas = ws?.getCanvas();
          if (canvas?.isConnected && canvas.querySelector('.blocklyPath') && getComputedStyle(canvas).visibility === 'visible') {
            const transform = canvas.getAttribute('transform');
            if (sample.views.at(-1)?.transform !== transform) sample.views.push({
              ms: now, scale: ws.scale, scrollX: ws.scrollX, scrollY: ws.scrollY,
              transform, ready: !!document.querySelector('iframe[data-runtime-ready="true"]'),
            });
          }
          if (race && ws && !document.querySelector('iframe[data-runtime-ready="true"]')) {
            const mounted = ws.getCanvas().isConnected;
            if (!w.startupDrags.some(item => item.mounted === mounted) && ws.getTopBlocks(false).length) {
              const before = ws.getTopBlocks(false).map(block => block.id);
              const target = mounted ? ws.getCanvas().querySelector('.blocklyPath') ?? ws.getParentSvg() : ws.getParentSvg();
              const accepted = target.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
                button: 0, buttons: 1, clientX: 350, clientY: 180 }));
              document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, buttons: 1, clientX: 500, clientY: 250 }));
              document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, buttons: 0, clientX: 500, clientY: 250 }));
              // Exercise the normal bubbling path from the workspace element.
              const keyboardAccepted = ws.getParentSvg().dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, key: 'Delete', code: 'Delete' }));
              w.startupDrags.push({ mounted, accepted, keyboardAccepted, before, after: ws.getTopBlocks(false).map(block => block.id) });
            }
          }
          if (sample.active) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, !!process.env['BLOCKLY_INIT_RACE']);
      const session = round === 0 ? await win.context().newCDPSession(win) : null;
      if (session) { await session.send('Profiler.enable'); await session.send('Profiler.start'); }
      const start = Date.now();
      await openBlocklyProject(win, project!);
      await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 90_000 });
      await win.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const visibleMs = Date.now() - start;
      // Keep sampling through the delayed resize/viewport refresh after readiness.
      if (process.env['BLOCKLY_INIT_VIEW']) await win.waitForTimeout(1000);
      const result = await win.evaluate(() => {
        const w = window as any, ws = w.blocklyWorkspace;
        const sample = w.loadResponsiveness;
        sample.active = false;
        for (const entry of sample.observer.takeRecords()) sample.tasks.push(entry.duration);
        sample.observer.disconnect();
        return { renderer: ws.options.renderer, loads: w.initialLoads.splice(0), startupDrag: w.startupDrag, startupDrags: w.startupDrags, roots: ws.getTopBlocks(false).map(block => block.id),
          count: ws.getAllBlocks(false).length, stats: ws.getViewportRenderer()?.getStats(), visibleViews: sample.views,
          responsiveness: { longTasks: sample.tasks, maxTaskMs: Math.max(0, ...sample.tasks),
            blockingMs: sample.tasks.reduce((sum, ms) => sum + Math.max(0, ms - 50), 0),
            maxFrameMs: Math.max(0, ...sample.frames), frames: sample.frames.length } };
      });
      report.rounds.push({ round, visibleMs, expectedView: storedPage?.viewState, ...result });
      console.log('[initialization]', JSON.stringify(report.rounds.at(-1)));
      if (process.env['BLOCKLY_INIT_VIEW'] === 'stable') {
        expect(result.visibleViews.length).toBeGreaterThan(0);
        expect([...new Set(result.visibleViews.map(view => view.scale))]).toEqual([storedPage.viewState.scale]);
        for (const view of result.visibleViews) {
          // Native scrollbar arithmetic can differ by trillionths of a pixel.
          expect(view.scrollX).toBeCloseTo(storedPage.viewState.scrollX, 5);
          expect(view.scrollY).toBeCloseTo(storedPage.viewState.scrollY, 5);
        }
        await win.screenshot({ path: path.join(output, `loaded-${round}.png`) });
      }
      if (session) {
        const { profile } = await session.send('Profiler.stop');
        await writeFile(path.join(output, 'load.cpuprofile'), JSON.stringify(profile)); await session.detach();
      }
      if (process.env['BLOCKLY_INIT_SETTLE']) {
        report.rounds.at(-1).afterReady = await win.evaluate(async () => {
          const tasks: number[] = [];
          const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => entry.duration)));
          observer.observe({ entryTypes: ['longtask'] });
          await new Promise(resolve => setTimeout(resolve, 2000));
          tasks.push(...observer.takeRecords().map(entry => entry.duration)); observer.disconnect();
          return { observedMs: 2000, longTasks: tasks, maxTaskMs: Math.max(0, ...tasks) };
        });
      }
      if (process.env['BLOCKLY_INIT_RACE']) {
        const attempts = [...result.startupDrags, ...(result.startupDrag ? [result.startupDrag] : [])];
        expect(attempts.length).toBeGreaterThan(0);
        for (const attempt of attempts) {
          expect(attempt.accepted).toBe(false);
          if ('keyboardAccepted' in attempt) expect(attempt.keyboardAccepted).toBe(false);
          expect(attempt.after).toEqual(attempt.before);
        }
      }
      await expect(win.locator('vite-error-overlay')).toHaveCount(0);
      for (const load of result.loads) expect(load.after).toEqual(load.before);
      expect(result.count).toBeGreaterThan(7000);
      const code = await win.evaluate(() => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        return realm.Arduino.workspaceToCode((window as any).blocklyWorkspace);
      });
      if (expectedCode !== undefined) expect(code).toBe(expectedCode);
      expectedCode = code;
      Object.assign(report.rounds.at(-1), { codeLength: code.length, codeSha256: createHash('sha256').update(code).digest('hex') });
      if (edited) expect(await win.evaluate(id => (window as any).blocklyWorkspace.getBlockById(id).getFieldValue('NUM'), edited.id)).toBe(edited.after);
      if (round === 0 && process.env['BLOCKLY_INIT_INTERACTIONS']) {
        edited = await win.evaluate(async () => {
          const w = window as any, ws = w.blocklyWorkspace;
          const block = ws.getAllBlocks(false).filter(b => b.type === 'math_number').at(-1);
          if (!block) throw Error('No numeric field');
          ws.centerOnBlock(block.id, false);
          await w.Blockly.renderManagement.finishQueuedRenders();
          ws.getViewportRenderer().refresh(); ws.clearUndo();
          block.getField('NUM').getClickTarget_().setAttribute('data-init-number', 'true');
          const before = Number(block.getFieldValue('NUM'));
          return { id: block.id, before, after: before + 1 };
        });
        await win.locator('[data-init-number="true"]').click();
        await win.locator('.blocklyHtmlInput').fill(String(edited.after));
        await win.locator('.blocklyHtmlInput').press('Enter');
        const value = () => win.evaluate(id => (window as any).blocklyWorkspace.getBlockById(id).getFieldValue('NUM'), edited!.id);
        await expect.poll(value).toBe(edited.after);
        await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getUndoStack().some(e => e.type === 'change'))).toBe(true);
        await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
        await expect.poll(value).toBe(edited.before);
        await win.evaluate(() => (window as any).blocklyWorkspace.undo(true));
        await expect.poll(value).toBe(edited.after);
        report.fieldEdit = edited;
        report.afterScroll = await win.evaluate(() => (window as any).blocklyWorkspace.getViewportRenderer().getStats());
        await win.screenshot({ path: path.join(output, 'deep-field-edit.png') });
        expectedCode = await win.evaluate(() => {
          const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
          return realm.Arduino.workspaceToCode((window as any).blocklyWorkspace);
        });
      }
      if (round === 0) await win.evaluate(async project => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        await realm.projectService.save(project);
      }, project!);
      await win.evaluate(() => { location.hash = '#/main/guide'; });
      await expect(win.locator('app-blockly-editor')).toHaveCount(0);
    }
    expect(report.errors).toEqual([]);
    report.sourceUnchanged = createHash('sha256').update(await readFile(path.join(source!, 'project.abi'))).digest('hex') === sourceHash;
    expect(report.sourceUnchanged).toBe(true);
  } finally {
    report.startupDrag = await win.evaluate(() => (window as any).startupDrag).catch(() => undefined);
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    await launched.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
