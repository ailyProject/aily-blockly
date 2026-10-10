import {test as base, expect, getMainWindow, openBlocklyProject, launchAilyElectron, closeAilyElectronApp} from '../fixtures/electron-app';
import {cp, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SOURCE = process.env['AILY_E2E_LARGE_PROJECT'];
const test = base.extend({
  electronApp: async ({}, use) => {
    const launched = await launchAilyElectron({environment: {AILY_E2E_MINIMAP: '1'}});
    try {await use(launched.app);} finally {await launched.close();}
  },
});

test('large workspace worker paints the real project and preserves navigation, code and disposal', async ({electronApp}, testInfo) => {
  test.skip(!SOURCE, 'Requires an installed large project; only a temporary clone is edited.');
  test.setTimeout(180_000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-minimap-overview-'));
  const project = path.join(temporary, 'project');
  const win = await getMainWindow(electronApp);
  try {
    await cp(SOURCE!, project, {recursive: true, filter: source =>
      !['.git', '.build', '.temp', '.log', '.workspace-history', 'project-open.lock'].includes(path.basename(source))});
    const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    const start = Date.now();
    await openBlocklyProject(win, project);
    const minimap = win.locator('.blockly-minimap');
    await expect(minimap).toHaveAttribute('data-minimap-mode', 'canvas-worker', {timeout: 120_000});
    await expect(minimap).toHaveAttribute('data-minimap-ready', 'true', {timeout: 60_000});
    const readyMs = Date.now() - start;
    const before = await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const ws = (window as any).blocklyWorkspace;
      return {count: ws.getAllBlocks(false).length, code: realm.Arduino.workspaceToCode(ws), scrollY: ws.scrollY,
        duplicateModels: realm.Blockly.common.getAllWorkspaces().filter((other: any) =>
          other !== ws && other.getAllBlocks(false).length >= ws.getAllBlocks(false).length).length};
    });
    expect(before.count).toBeGreaterThan(300);
    expect(before.duplicateModels).toBe(0);
    expect(Number(await minimap.getAttribute('data-minimap-shapes'))).toBeGreaterThan(300);
    expect(await minimap.locator('use, [data-minimap-source]').count()).toBe(0);
    expect(await minimap.locator('svg').evaluate(svg => getComputedStyle(svg).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    const bounds = await minimap.boundingBox();
    if (!bounds) throw new Error('Missing minimap bounds');
    await win.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.7);
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.scrollY)).not.toBe(before.scrollY);
    const clicked = await win.evaluate(() => (window as any).blocklyWorkspace.scrollY);
    await minimap.press('ArrowUp');
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.scrollY)).not.toBe(clicked);
    const after = await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      return realm.Arduino.workspaceToCode((window as any).blocklyWorkspace);
    });
    expect(after).toBe(before.code);
    expect(errors).toEqual([]);
    await testInfo.attach('large-overview', {body: JSON.stringify({readyMs, count: before.count,
      duplicateModels: before.duplicateModels, codePreserved: true}), contentType: 'application/json'});
    await win.screenshot({path: testInfo.outputPath('large-worker-minimap.png')});
    await minimap.screenshot({path: testInfo.outputPath('large-worker-overview.png')});
    await win.evaluate(() => {location.hash = '#/main/guide';});
    await expect(minimap).toHaveCount(0);
  } finally {
    await closeAilyElectronApp(electronApp);
    await rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
});

test('large workspace worker overview preserves navigation, stack dragging, code and disposal', async ({electronApp}, testInfo) => {
  test.skip(!SOURCE, 'Requires an installed large project; only a temporary clone is edited.');
  test.setTimeout(240_000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-minimap-large-'));
  const project = path.join(temporary, 'project');
  const win = await getMainWindow(electronApp);
  try {
    await cp(SOURCE!, project, {recursive: true, filter: source =>
      !['.git', '.build', '.temp', '.log', '.workspace-history', 'project-open.lock'].includes(path.basename(source))});
    const errors: string[] = [];
    win.on('pageerror', error => errors.push(error.message));
    await win.evaluate(() => {
      (window as any).__minimapPerf = {stage: 'load', long: []};
      (window as any).__minimapPerf.pointers = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        document.addEventListener(type, (event: Event) => {
          const perf = (window as any).__minimapPerf;
          if (perf.stage !== 'drag' || perf.pointers.length >= 50) return;
          const pointer = event as PointerEvent;
          perf.pointers.push({type, x: pointer.clientX, y: pointer.clientY, buttons: pointer.buttons, trusted: pointer.isTrusted});
        }, true);
      }
      new PerformanceObserver(list => {
        const perf = (window as any).__minimapPerf;
        for (const entry of list.getEntries()) perf.long.push({stage: perf.stage, duration: entry.duration});
      }).observe({entryTypes: ['longtask']});
    });
    const started = Date.now();
    await openBlocklyProject(win, project);
    await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-mode', 'canvas-worker', {timeout: 120_000});
    await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-ready', 'true', {timeout: 60_000});
    const loadedMs = Date.now() - started;
    const initial = await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const ws = (window as any).blocklyWorkspace;
      const count = ws.getAllBlocks(false).length;
      (window as any).__minimapCode = realm.Arduino.workspaceToCode(ws);
      return {count, duplicateModels: realm.Blockly.common.getAllWorkspaces()
        .filter((other: any) => other !== ws && other.getAllBlocks(false).length >= count).length};
    });
    expect(initial.count).toBeGreaterThan(300);
    expect(initial.duplicateModels).toBe(0);
    expect(await win.locator('.blockly-minimap use').count()).toBe(0);
    const navigationBefore = await win.evaluate(() => (window as any).blocklyWorkspace.scrollY);
    const mini = await win.locator('.blockly-minimap').boundingBox();
    if (!mini) throw new Error('Missing minimap bounds');
    await win.mouse.click(mini.x + mini.width / 2, mini.y + mini.height * 0.7);
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.scrollY)).not.toBe(navigationBefore);
    await win.locator('.blockly-minimap').press('ArrowUp');

    const target = await win.evaluate(() => {
      const ws = (window as any).blocklyWorkspace;
      const B = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      B.Blockly.hideChaff(false);
      B.Blockly.getFocusManager().focusNode(ws.getRootFocusableNode());
      ws.getGrid().setSnapToGrid(false);
      const block = ws.getTopBlocks(false).filter((b: any) => b.isMovable())
        .sort((a: any, b: any) => b.getDescendants(false).length - a.getDescendants(false).length)[0];
      const before = {...block.getRelativeToSurfaceXY()};
      ws.scroll(400 - before.x * ws.scale, 120 - before.y * ws.scale);
      return {id: block.id, before, descendants: block.getDescendants(false).length, scale: ws.scale};
    });
    await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pointer = await win.evaluate(id => {
      const block = (window as any).blocklyWorkspace.getBlockById(id);
      const rect = block.pathObject.svgPath.getBoundingClientRect();
      const point = [[8, 20], [4, 24], [5, 30], [40, 8]].map(([x, y]) => ({x: rect.x + x, y: rect.y + y}))
        .find(p => document.elementFromPoint(p.x, p.y) === block.pathObject.svgPath);
      if (!point) {
        throw new Error('Stack drag hit test did not reach its SVG');
      }
      (window as any).__minimapPerf.stage = 'drag';
      return point;
    }, target.id);
    await win.bringToFront();
    const dragStart = Date.now();
    console.log('[large-minimap] starting real pointer drag');
    const session = await win.context().newCDPSession(win);
    const trace: unknown[] = [];
    if (process.env['AILY_E2E_TRACE_PERF'] === '1') {
      session.on('Tracing.dataCollected', ({value}) => trace.push(...value));
      await session.send('Tracing.start', {categories: process.env['AILY_E2E_TRACE_CSS'] === '1'
        ? 'devtools.timeline,disabled-by-default-blink.debug,disabled-by-default-devtools.timeline.invalidationTracking'
        : 'devtools.timeline', transferMode: 'ReportEvents'});
      await session.send('Profiler.enable'); await session.send('Profiler.start');
    }
    await win.mouse.move(pointer.x, pointer.y);
    await win.mouse.down();
    await win.mouse.move(pointer.x + 80, pointer.y + 40, {steps: 8});
    await win.mouse.up();
    const after = await win.evaluate(id => {
      const ws = (window as any).blocklyWorkspace;
      return {...ws.getBlockById(id).getRelativeToSurfaceXY(), scrollX: ws.scrollX, scrollY: ws.scrollY};
    }, target.id);
    const dragMs = Date.now() - dragStart;
    if (process.env['AILY_E2E_TRACE_PERF'] === '1') {
      const {profile} = await session.send('Profiler.stop');
      await writeFile(testInfo.outputPath('drag-cpu.json'), JSON.stringify(profile));
      const complete = new Promise<void>(resolve => session.once('Tracing.tracingComplete', () => resolve()));
      await session.send('Tracing.end'); await complete;
      await writeFile(testInfo.outputPath('drag-browser-trace.json'), JSON.stringify({traceEvents: trace}));
    }
    await session.detach();
    const report = JSON.stringify({loadedMs, dragMs, initial, target, after,
      perf: await win.evaluate(() => (window as any).__minimapPerf)}, null, 2);
    await writeFile(testInfo.outputPath('large-minimap-performance.json'), report);
    await testInfo.attach('large-minimap-performance', {body: report, contentType: 'application/json'});
    expect(after.x - target.before.x).toBeCloseTo(80 / target.scale, 0);
    expect(after.y - target.before.y).toBeCloseTo(40 / target.scale, 0);
    expect(await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      return realm.Arduino.workspaceToCode((window as any).blocklyWorkspace) === (window as any).__minimapCode;
    })).toBe(true);
    await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-ready', 'true');
    await win.screenshot({path: testInfo.outputPath('large-worker-minimap.png')});
    expect(errors).toEqual([]);
    await win.evaluate(() => {location.hash = '#/main/guide';});
    await expect(win.locator('.blockly-minimap')).toHaveCount(0);
  } finally {
    await closeAilyElectronApp(electronApp);
    await rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
});
