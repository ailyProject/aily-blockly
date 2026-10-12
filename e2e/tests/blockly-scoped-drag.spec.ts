import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect, getMainWindow, launchAilyElectron, openBlocklyProject, test} from '../fixtures/electron-app';
import {selectFunctionView} from '../fixtures/function-view';

import {seedPlatform} from '../fixtures/platform-seed';

const SOURCE = process.env['AILY_E2E_REAL_PROJECT'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Keep explicit native-input/CPU metrics and the final screenshot as evidence.
test.use({trace: 'off', video: 'off'});

for (const scopeType of ['arduino_global', 'arduino_loop']) test(`${scopeType} remains responsive with the complete real large project loaded`, async ({}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!SOURCE, 'Set AILY_E2E_REAL_PROJECT to the installed large project.');
  const originals = await Promise.all(['project.abi', 'project.abs'].map(name => readFile(path.join(SOURCE!, name), 'utf8')));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-scoped-drag-'));
  const project = path.join(root, 'project');
  await cp(SOURCE!, project, {recursive: true, filter: source => ![
    '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock',
  ].includes(path.basename(source))});
  const launched = await launchAilyElectron({config: {blockly: {minimap: true}}});
  const win = await getMainWindow(launched.app);
  const errors: string[] = [];
  win.on('pageerror', error => errors.push(error.stack ?? error.message));
  try {
    await seedPlatform(project, launched.userDataDir);
    await openBlocklyProject(win, project);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, {timeout: 120_000});
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace?.getAllBlocks(false).length)).toBe(7765);
    const globalId = await win.evaluate(type => (window as any).blocklyWorkspace.getTopBlocks(false).find(block => block.type === type).id, scopeType);
    await selectFunctionView(win, globalId);
    await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-shapes', scopeType === 'arduino_loop' ? '715' : '45', {timeout: 45_000});
    const targetId = await win.evaluate(id => {
      const ws = (window as any).blocklyWorkspace;
      const block = ws.getBlockById(id).getDescendants(false).find(block => block.type === 'math_number');
      block.getSvgRoot().setAttribute('data-drag-probe', 'global');
      return block.id;
    }, globalId);
    await win.evaluate(id => {
      const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
      ws.getBlockById(id).getSvgRoot().setAttribute('data-drag-probe', 'global');
      const probe = (window as any).__dragProbe = {methods: {}, timers: [], longTasks: [], frames: [], active: false, cancellations: 0};
      const measure = (object, name, label = name) => {
        const original = object[name];
        object[name] = function(...args) {
          if (!probe.active) return original.apply(this, args);
          const started = performance.now();
          try { return original.apply(this, args); }
          finally {
            const metric = probe.methods[label] ||= {calls: 0, total: 0, max: 0};
            const duration = performance.now() - started;
            metric.calls++; metric.total += duration; metric.max = Math.max(metric.max, duration);
          }
        };
      };
      for (const name of ['getRootBlock', 'getRelativeToSurfaceXY', 'getDescendants']) measure(B.BlockSvg.prototype, name);
      measure(B.ConnectionDB.prototype, 'searchForClosest');
      measure(ws.connectionChecker, 'doDragChecks');
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      measure(realm.Arduino, 'workspaceToCode');
      const cancel = ws.cancelCurrentGesture;
      ws.cancelCurrentGesture = function(...args) { if (probe.active && this.isDragging()) probe.cancellations++; return cancel.apply(this, args); };
      new PerformanceObserver(list => {
        if (probe.active) probe.longTasks.push(...list.getEntries().map(entry => ({start: entry.startTime, duration: entry.duration})));
      }).observe({entryTypes: ['longtask']});
      const frame = (time: number) => { if (probe.active) probe.frames.push(time); requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      for (const name of ['setTimeout', 'setInterval']) {
        const original = window[name].bind(window);
        window[name] = function(callback, delay, ...args) {
          if (typeof callback !== 'function') return original(callback, delay, ...args);
          const stack = new Error().stack;
          return original(function(...values) {
            const started = performance.now();
            const duringGesture = !!ws.currentGesture_;
            try { return callback.apply(this, values); }
            finally {
              const duration = performance.now() - started;
              if (probe.active && duration > 8) probe.timers.push({name, delay, duration, duringGesture, stack});
            }
          }, delay, ...args);
        };
      }
    }, targetId);
    const initialSave = await win.evaluate(async project => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const result = await realm.projectService.save(project, 30_000);
      await (window as any).Blockly.renderManagement.finishQueuedRenders();
      (window as any).blocklyWorkspace.clearUndo();
      return result;
    }, project);
    expect(initialSave.success, JSON.stringify(initialSave)).toBe(true);
    const baseline = await win.evaluate(() => JSON.stringify((window as any).Blockly.serialization.workspaces.save((window as any).blocklyWorkspace)));
    const baselineCode = await readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8');
    const baselineMap = await win.evaluate(() => JSON.stringify([...(document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow['Arduino'].blockCodeMap]));
    const label = win.locator('.blocklyBlockCanvas [data-drag-probe="global"] > path.blocklyPath').first();
    await label.hover({position: {x: 6, y: 12}, timeout: 10_000});
    const box = await label.boundingBox(); expect(box).toBeTruthy();
    const start = {x: box!.x + 6, y: box!.y + box!.height / 2};
    const geometry = await win.evaluate(id => {
      const ws = (window as any).blocklyWorkspace, block = ws.getBlockById(id);
      const bounds = ws.getInjectionDiv().getBoundingClientRect(), origin = ws.getOriginOffsetInPixels(), point = block.getRelativeToSurfaceXY();
      return {left: bounds.left, top: bounds.top, x: origin.x + point.x * ws.scale, y: origin.y + point.y * ws.scale};
    }, targetId);
    const grab = {x: start.x - geometry.left - geometry.x, y: start.y - geometry.top - geometry.y};
    const cdp = await win.context().newCDPSession(win);
    if (process.env['AILY_E2E_DRAG_TIMELINE']) await cdp.send('Tracing.start', {categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,v8', transferMode: 'ReturnAsStream'});
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    const latencies: number[] = [];
    const emptyPoint = await win.evaluate(() => {
      const box = (window as any).blocklyWorkspace.getInjectionDiv().getBoundingClientRect();
      return {x: box.left + box.width * .72, y: box.top + box.height * .35};
    });
    console.log('[scoped-drag:start]', {targetId, scopeType});
    await win.evaluate(() => { (window as any).__dragProbe.active = true; });
    await win.mouse.move(start.x, start.y); await win.mouse.down();
    for (let i = 1; i <= 90; i++) {
      const started = Date.now();
      // Keep the first drop away from live value inputs. Subsequent gestures
      // probe the same detached block rather than accidentally replacing a
      // shadow inside another statement and then clicking its old position.
      const goal = i <= 30 ? emptyPoint : {x: start.x + 80, y: start.y + 20};
      await win.mouse.move(goal.x + Math.sin(i / 5) * 30, goal.y + Math.cos(i / 5) * 20);
      latencies.push(Date.now() - started);
      if (i === 1 || i === 31 || i === 61) {
        const gesture = await win.evaluate(id => {
        const ws = (window as any).blocklyWorkspace;
        return {dragging: ws.isDragging(), target: ws.currentGesture_?.targetBlock?.id, expected: id, scroll: [ws.scrollX, ws.scrollY]};
        }, targetId);
        expect(gesture, JSON.stringify({i, gesture})).toMatchObject({dragging: true, target: targetId});
      }
      if (i === 30 || i === 60) {
        await win.mouse.up();
        await new Promise(resolve => setTimeout(resolve, 650));
        // Use native translation data for the next real pointer target. A
        // locator boundingBox also performs injected visibility/layout checks
        // that took ~1 s each on this deep SVG and polluted drag measurements.
        const next = await win.evaluate(({id, geometry, grab}) => {
          const ws = (window as any).blocklyWorkspace, point = ws.getBlockById(id).getRelativeToSurfaceXY(), origin = ws.getOriginOffsetInPixels();
          return {x: geometry.left + origin.x + point.x * ws.scale + grab.x, y: geometry.top + origin.y + point.y * ws.scale + grab.y};
        }, {id: targetId, geometry, grab});
        start.x = next.x; start.y = next.y;
        await win.mouse.move(start.x, start.y); await win.mouse.down();
      }
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
    await win.mouse.up();
    await expect.poll(() => win.evaluate(() => !!(window as any).blocklyWorkspace.currentGesture_)).toBe(false);
    const probe = await win.evaluate(() => {
      const probe = (window as any).__dragProbe; probe.active = false;
      return {...probe, blocks: (window as any).blocklyWorkspace.getAllBlocks(false).length,
        frameGaps: probe.frames.slice(1).map((value, i) => value - probe.frames[i])};
    });
    const {profile} = await cdp.send('Profiler.stop');
    if (process.env['AILY_E2E_DRAG_TIMELINE']) {
      const done = new Promise<any>(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end'); const {stream} = await done;
      let trace = '';
      while (true) { const chunk = await cdp.send('IO.read', {handle: stream}); trace += chunk.data; if (chunk.eof) break; }
      await cdp.send('IO.close', {handle: stream}); await writeFile(testInfo.outputPath('timeline.json'), trace);
    }
    await cdp.detach();
    console.log('[scoped-drag]', JSON.stringify({scopeType, methods: probe.methods, timers: probe.timers, longTasks: probe.longTasks, cancellations: probe.cancellations,
      maxFrameGap: Math.max(0, ...probe.frameGaps), maxPointerLatency: Math.max(...latencies), blocks: probe.blocks}));
    await writeFile(testInfo.outputPath('cpu.json'), JSON.stringify(profile));
    await writeFile(testInfo.outputPath('metrics.json'), JSON.stringify({...probe, latencies}, null, 2));
    await testInfo.attach('scoped-drag-cpu', {path: testInfo.outputPath('cpu.json'), contentType: 'application/json'});
    await testInfo.attach('scoped-drag-metrics', {body: JSON.stringify({...probe, latencies}, null, 2), contentType: 'application/json'});
    expect(probe.blocks).toBe(7765); expect(probe.cancellations).toBe(0);
    expect(probe.timers.filter(timer => timer.stack.includes('scheduleCodePublication') && timer.duringGesture)).toEqual([]);
    // Budget catches the former ~1 s pauses between consecutive gestures.
    // Frame/IPC latency samples stay in the evidence rather than claiming FPS.
    if (!process.env['AILY_E2E_DRAG_BASELINE']) expect(Math.max(0, ...probe.longTasks.map(task => task.duration))).toBeLessThan(500);
    // Native bump/disconnect events can form additional undo groups; undo the
    // recorded operations, rather than assuming one group per pointer gesture.
    let undoGroups = 0;
    while (await win.evaluate(() => (window as any).blocklyWorkspace.getUndoStack().length > 0)) {
      expect(++undoGroups).toBeLessThan(20);
      await win.evaluate(async () => {
        const B = (window as any).Blockly, ws = (window as any).blocklyWorkspace;
        ws.undo(false); await B.renderManagement.finishQueuedRenders();
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 30)));
      });
    }
    expect(undoGroups).toBeGreaterThanOrEqual(3);
    expect(await win.evaluate(() => JSON.stringify((window as any).Blockly.serialization.workspaces.save((window as any).blocklyWorkspace)))).toBe(baseline);
    const undoCode = await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      return realm.Arduino.workspaceToCode((window as any).blocklyWorkspace);
    });
    expect(undoCode).toBe(baselineCode);
    // Preprocessing owns the derived sketch while it is running. Complete
    // that real job before validating save's on-disk code publication.
    await expect.poll(() => win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const builder = [...realm.projectService.injector.records.values()].map((record: any) => record?.value)
        .find(value => typeof value?.isPreprocessing === 'function');
      if (!builder) throw new Error('Blockly builder unavailable');
      return !builder.isPreprocessing() && !builder.pendingPrecompile;
    }), {timeout: 60_000}).toBe(true);
    await expect.poll(() => existsSync(path.join(project, '.build', 'aily-workspace.lock'))
      || existsSync(path.join(project, '.build', 'aily-builder.lock')), {timeout: 60_000}).toBe(false);
    const finalSave = await win.evaluate(async project => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      return realm.projectService.save(project, 30_000);
    }, project);
    expect(finalSave.success, JSON.stringify(finalSave)).toBe(true);
    expect(await readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')).toBe(baselineCode);
    expect(await win.evaluate(() => JSON.stringify([...(document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow['Arduino'].blockCodeMap]))).toBe(baselineMap);
    await win.screenshot({path: testInfo.outputPath('scoped-drag.png')});
    expect(errors).toEqual([]);
    for (let i = 0; i < originals.length; i++) expect(hash(await readFile(path.join(SOURCE!, ['project.abi', 'project.abs'][i]), 'utf8'))).toBe(hash(originals[i]));
  } catch (error) { await win.screenshot({path: testInfo.outputPath('failure.png')}).catch(() => {}); throw error;
  } finally { await launched.close(); await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); }
});
