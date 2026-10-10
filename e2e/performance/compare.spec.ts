import {test, expect, _electron, type Page, type ElectronApplication} from '@playwright/test';
import {writeFile, cp, mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {getMainWindow, launchAilyElectron, openBlocklyProject, ROOT} from '../fixtures/electron-app';
const {serve} = require('../../scripts/serve-blockly-performance.cjs');
const artifacts = path.join(ROOT, 'e2e/.artifacts/blockly-performance-2026-09-28');

const variants = (process.env.BLOCKLY_PERF_VARIANTS || 'official,aily,aily-ui,host').split(',');
const topologies = (process.env.BLOCKLY_PERF_TOPOLOGIES || 'spread,stack').split(',');
const rounds = Number(process.env.BLOCKLY_PERF_ROUNDS || 1);

for (let round = 1; round <= rounds; round++) for (const topology of topologies) for (const variant of variants) {
  test(`${variant} ${topology} round ${round}: 8285 blocks`, async ({}, info) => {
    const server: any = await serve();
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-perf13-'));
    const report: any = {variant, topology, round, label: process.env.BLOCKLY_PERF_LABEL || 'baseline'};
    const errors: string[] = [];
    let close: (() => Promise<void>) | undefined;
    let win: Page | undefined;
    let electronApp: ElectronApplication;
    try {
      const {ELECTRON_RUN_AS_NODE, ...env} = process.env;
      if (variant === 'host') {
        const project = path.join(temporary, 'project');
        await cp(path.join(artifacts, `project-${topology}`), project, {recursive: true});
        const launched = await launchAilyElectron({environment: {AILY_E2E_MINIMAP: '1'}});
        electronApp = launched.app;
        close = launched.close;
        win = await getMainWindow(launched.app);
        const handle = await launched.app.browserWindow(win);
        await handle.evaluate(window => window.setContentSize(1440, 800));
        win.on('pageerror', error => errors.push(error.message));
        const started = Date.now();
        await openBlocklyProject(win, project);
        await win.waitForFunction(() => (window as any).blocklyWorkspace?.getAllBlocks(false).length === 8285, {timeout: 180_000});
        report.projectOpenMs = Date.now() - started;
        await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-ready', 'true', {timeout: 90_000});
        report.projectAndMinimapMs = Date.now() - started;
      } else {
        const app = await _electron.launch({args: [path.join(ROOT, 'e2e/performance/electron.cjs')],
          env: {...env, BLOCKLY_PERF_URL: `http://127.0.0.1:${server.address().port}/${variant}.html?topology=${topology}`}});
        electronApp = app;
        close = async () => {await app.close();};
        win = await app.firstWindow();
        win.on('pageerror', error => errors.push(error.message));
        await win.waitForFunction(() => !!(window as any).benchmarkLoaded, {timeout: 180_000});
        report.initial = await win.evaluate(() => (window as any).benchmarkLoaded);
      }
      await win.bringToFront();
      // Settle one-time project/native setup before measuring interaction.
      await win.waitForTimeout(1500);
      report.electron = await electronApp.evaluate(({app}) => ({versions: process.versions, gpu: app.getGPUFeatureStatus()}));
      report.environment = await win.evaluate(() => {
        const w = window as any, ws = w.blocklyWorkspace, B = w.Blockly;
        w.perfSignature = () => JSON.stringify(ws.getAllBlocks(false).map(b => [b.id, b.type,
          b.getParent()?.id, b.getNextBlock()?.id, b.getField('NUM')?.getValue()]).sort((a, b) => a[0].localeCompare(b[0])));
        w.perfBefore = w.perfSignature();
        return {version: B.VERSION, userAgent: navigator.userAgent, count: ws.getAllBlocks(false).length,
          viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
          renderer: ws.getRenderer().getClassName(), scale: ws.scale,
          largestStack: Math.max(...ws.getTopBlocks(false).map(b => b.getDescendants(false).length)),
          svgElements: ws.getCanvas().querySelectorAll('*').length};
      });
      expect(report.environment.count).toBe(8285);
      expect(report.environment.version).toBe('13.3.0');
      expect(report.environment.viewport).toMatchObject({width: 1440, height: 800});
      // A reload with identical state measures the shared SVG load path. The
      // separate projectOpenMs above includes the host's real file/runtime path.
      report.reload = await win.evaluate(async () => {
        const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace;
        const state = B.serialization.workspaces.save(ws);
        const start = performance.now();
        B.Events.disable(); B.utils.dom.startTextWidthCache();
        try { B.serialization.workspaces.load(state, ws); B.renderManagement.triggerQueuedRenders(); }
        finally { B.utils.dom.stopTextWidthCache(); B.Events.enable(); }
        const synchronousMs = performance.now() - start;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {synchronousMs, paintedMs: performance.now() - start};
      });
      await win.waitForTimeout(500);
      const target = await win.evaluate(() => {
        const w = window as any, ws = w.blocklyWorkspace, B = w.Blockly;
        B.hideChaff(false); B.getFocusManager().focusNode(ws.getRootFocusableNode());
        ws.getGrid().setSnapToGrid(false); ws.setScale(1);
        const block = ws.getTopBlocks(false).filter(b => b.isMovable())
          .sort((a, b) => b.getDescendants(false).length - a.getDescendants(false).length)[0];
        const before = {...block.getRelativeToSurfaceXY()};
        ws.scroll(240 - before.x, 100 - before.y);
        return {id: block.id, before, descendants: block.getDescendants(false).length};
      });
      await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const pointer = await win.evaluate(id => {
        const block = (window as any).blocklyWorkspace.getBlockById(id);
        const rect = block.pathObject.svgPath.getBoundingClientRect();
        // Aily puts a clickable icon in the header. Drag the SVG path itself,
        // never an icon or field whose nearest block happens to be this root.
        const point = [[8, 20], [4, 24], [5, 30], [40, 8]].map(([x, y]) => ({x: rect.x + x, y: rect.y + y}))
          .find(p => document.elementFromPoint(p.x, p.y) === block.pathObject.svgPath);
        if (!point) throw new Error('Drag hit target mismatch');
        const w = window as any;
        w.perfSample = {frames: [], longTasks: [], trustedMoves: 0, stage: 'drag'};
        let last = performance.now();
        function frame(t) { if (!w.perfSample.running) return; w.perfSample.frames.push(t - last); last = t; requestAnimationFrame(frame); }
        w.perfSample.running = true; requestAnimationFrame(frame);
        new PerformanceObserver(list => w.perfSample.longTasks.push(...list.getEntries().map(e => e.duration))).observe({entryTypes: ['longtask']});
        document.addEventListener('pointermove', event => {if (event.isTrusted) w.perfSample.trustedMoves++;});
        return point;
      }, target.id);
      report.target = target;
      const session = await win.context().newCDPSession(win);
      const trace: unknown[] = [];
      if (process.env.BLOCKLY_PERF_TRACE === '1') {
        session.on('Tracing.dataCollected', ({value}) => trace.push(...value));
        await session.send('Tracing.start', {categories: 'devtools.timeline,blink', transferMode: 'ReportEvents'});
      }
      if (process.env.BLOCKLY_PERF_PROFILE === '1') {await session.send('Profiler.enable'); await session.send('Profiler.start');}
      const dragStart = Date.now();
      await win.mouse.move(pointer.x, pointer.y); await win.mouse.down();
      await win.mouse.move(pointer.x + 96, pointer.y + 48, {steps: 12}); await win.mouse.up();
      report.dragMs = Date.now() - dragStart;
      report.after = await win.evaluate(id => {
        const w = window as any; w.perfSample.running = false;
        return {...w.blocklyWorkspace.getBlockById(id).getRelativeToSurfaceXY(), sample: w.perfSample};
      }, target.id);
      if (process.env.BLOCKLY_PERF_PROFILE === '1') {
        const {profile} = await session.send('Profiler.stop');
        await writeFile(path.join(artifacts, `${report.label}-${variant}-${topology}-${round}.cpuprofile`), JSON.stringify(profile));
      }
      if (process.env.BLOCKLY_PERF_TRACE === '1') {
        const complete = new Promise<void>(resolve => session.once('Tracing.tracingComplete', () => resolve()));
        await session.send('Tracing.end'); await complete;
        await writeFile(path.join(artifacts, `${report.label}-${variant}-${topology}-${round}.trace.json`), JSON.stringify({traceEvents: trace}));
      }
      await session.detach();
      expect(report.after.x - target.before.x).toBeCloseTo(96, 0);
      expect(report.after.y - target.before.y).toBeCloseTo(48, 0);
      expect(report.after.sample.trustedMoves).toBeGreaterThanOrEqual(12);
      report.zoom = await win.evaluate(async () => {
        const ws = (window as any).blocklyWorkspace, start = performance.now(), before = ws.scale;
        ws.zoomCenter(1);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {ms: performance.now() - start, before, scale: ws.scale};
      });
      expect(report.zoom.scale).toBeGreaterThan(report.zoom.before);
      report.redraw = await win.evaluate(async () => {
        const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace, start = performance.now();
        B.utils.dom.startTextWidthCache();
        try {for (const block of ws.getAllBlocks(false)) block.queueRender(); B.renderManagement.triggerQueuedRenders();}
        finally {B.utils.dom.stopTextWidthCache();}
        const synchronousMs = performance.now() - start;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {synchronousMs, paintedMs: performance.now() - start, statePreserved: w.perfSignature() === w.perfBefore};
      });
      expect(report.redraw.statePreserved).toBe(true);
      expect(errors).toEqual([]);
      await win.screenshot({path: path.join(artifacts, `${report.label}-${variant}-${topology}-${round}.png`), timeout: 30_000});
      report.passed = true;
    } catch (error) {
      report.failure = String(error); throw error;
    } finally {
      report.errors = errors;
      await writeFile(path.join(artifacts, `${report.label}-${variant}-${topology}-${round}.json`), JSON.stringify(report, null, 2));
      console.log('[benchmark]', JSON.stringify({...report, after: report.after && {x: report.after.x, y: report.after.y}}));
      await close?.().catch(() => {});
      server.close();
      await rm(temporary, {recursive: true, force: true});
    }
  });
}
