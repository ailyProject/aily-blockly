import {test, expect, _electron, type Page, type ElectronApplication} from '@playwright/test';
import {writeFile, cp, mkdtemp, rm, readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {getMainWindow, launchAilyElectron, openBlocklyProject, ROOT} from '../fixtures/electron-app';
const {serve} = require('../../scripts/serve-blockly-performance.cjs');
const artifacts = path.join(ROOT, 'e2e/.artifacts/blockly-real-project-2026-09-28');

const variants = (process.env.BLOCKLY_PERF_VARIANTS || 'official,aily,aily-ui,host').split(',');
const topologies = (process.env.BLOCKLY_PERF_TOPOLOGIES || 'original').split(',');
const rounds = Number(process.env.BLOCKLY_PERF_ROUNDS || 1);
const startRound = Number(process.env.BLOCKLY_PERF_START_ROUND || 1);

for (let round = startRound; round <= rounds; round++) for (const topology of topologies) for (const variant of variants) {
  const expectedCount = topology === 'expanded' ? 8265 : 7765;
  test(`${variant} ${topology} round ${round}: ${expectedCount} blocks`, async ({}, info) => {
    const server: any = await serve(0, artifacts);
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-perf13-'));
    const report: any = {variant, topology, round, startedAt: new Date().toISOString(), label: process.env.BLOCKLY_PERF_LABEL || 'baseline'};
    const errors: string[] = [];
    let close: (() => Promise<void>) | undefined;
    let win: Page | undefined;
    let electronApp: ElectronApplication;
    try {
      const {ELECTRON_RUN_AS_NODE, ...env} = process.env;
      if (variant === 'host') {
        const project = path.join(temporary, 'project');
        await cp(path.join(artifacts, topology === 'original' ? 'project' : 'project-expanded'), project, {recursive: true, verbatimSymlinks: true});
        const launched = await launchAilyElectron({environment: {AILY_E2E_MINIMAP: '1'}});
        electronApp = launched.app;
        close = launched.close;
        win = await getMainWindow(launched.app);
        const handle = await launched.app.browserWindow(win);
        await handle.evaluate(window => window.setContentSize(1440, 800));
        win.on('pageerror', error => errors.push(error.message));
        win.on('console', message => {if (/Code generation error|Failed to generate the project source artifact|Canonical JSON exceeds|Maximum call stack/.test(message.text())) errors.push(message.text());});
        await win.evaluate(() => {
          const w = window as any;
          let current = w.Blockly;
          w.initialNativeLoads = [];
          Object.defineProperty(w, 'Blockly', {configurable: true, get: () => current, set: value => {
            if (value !== current) {
              const original = value.serialization.workspaces.load;
              value.serialization.workspaces.load = function(state, workspace, ...args) {
                const start = performance.now();
                try {return original.call(this, state, workspace, ...args);}
                finally {if (workspace.rendered) w.initialNativeLoads.push({ms: performance.now() - start, count: workspace.getAllBlocks(false).length});}
              };
            }
            current = value;
          }});
        });
        const started = Date.now();
        await openBlocklyProject(win, project);
        await win.waitForFunction(count => (window as any).blocklyWorkspace?.getAllBlocks(false).length === count, expectedCount, {timeout: 180_000});
        report.projectOpenMs = Date.now() - started;
        await win.waitForFunction(() => document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready') === 'true', null, {timeout: 180_000});
        await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        report.projectReadyMs = Date.now() - started;
        await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-ready', 'true', {timeout: 90_000});
        report.projectAndMinimapMs = Date.now() - started;
        report.initialNativeLoads = await win.evaluate(() => (window as any).initialNativeLoads);
      } else {
        const app = await _electron.launch({args: [path.join(ROOT, 'e2e/performance/electron.cjs')],
          env: {...env, BLOCKLY_PERF_URL: `http://127.0.0.1:${server.address().port}/${variant}.html?topology=${topology}`}});
        electronApp = app;
        close = async () => {await app.close();};
        win = await app.firstWindow();
        win.on('pageerror', error => errors.push(error.message));
        win.on('console', message => {if (/Code generation error|Failed to generate the project source artifact|Canonical JSON exceeds|Maximum call stack/.test(message.text())) errors.push(message.text());});
        await win.waitForFunction(() => !!(window as any).benchmarkLoaded, null, {timeout: 180_000});
        report.initial = await win.evaluate(() => (window as any).benchmarkLoaded);
      }
      await win.bringToFront();
      // Settle one-time project/native setup before measuring interaction.
      await win.waitForTimeout(1500);
      report.electron = await electronApp.evaluate(({app}) => ({versions: process.versions, gpu: app.getGPUFeatureStatus()}));
      report.environment = await win.evaluate(() => {
        const w = window as any, ws = w.blocklyWorkspace, B = w.Blockly;
        w.perfSignature = () => JSON.stringify(ws.getAllBlocks(false).map(b => [b.id, b.type, b.getParent()?.id, b.getNextBlock()?.id, b.isShadow(), b.inputList.map(i => [i.name,i.connection?.targetBlock()?.id, i.fieldRow.filter(f => f.name && f.SERIALIZABLE).map(f => [f.name, f.saveState()])])]).sort((a, b) => a[0].localeCompare(b[0])));
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement)?.contentWindow as any;
        w.loadForBenchmark ||= state => { B.serialization.workspaces.load(state, ws); B.renderManagement.triggerQueuedRenders(ws); };
        w.realCode ||= () => realm.Arduino.workspaceToCode(ws);
        w.realBeforeCode = w.realCode();
        w.perfBefore = w.perfSignature();
        w.realGeometry = JSON.stringify(ws.getAllBlocks(false).map(b => [b.id, b.width, b.height, b.inputList.flatMap(i => i.fieldRow.map(f => [f.name, f.getSize().width, f.getSize().height]))]).sort((a,b) => a[0].localeCompare(b[0])));
        return {version: B.VERSION, userAgent: navigator.userAgent, count: ws.getAllBlocks(false).length,
          viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
          renderer: ws.getRenderer().getClassName(), scale: ws.scale,
          largestStack: Math.max(...ws.getTopBlocks(false).map(b => b.getDescendants(false).length)),
          svgElements: ws.getCanvas().querySelectorAll('*').length};
      });
      report.geometrySha256 = createHash('sha256').update(await win.evaluate(() => (window as any).realGeometry)).digest('hex');
      report.codeSha256 = createHash('sha256').update(await win.evaluate(() => (window as any).realBeforeCode)).digest('hex');
      if(topology === 'original') expect(report.codeSha256).toBe(createHash('sha256').update(JSON.parse(await readFile(path.join(artifacts,'capture.json'),'utf8')).code).digest('hex'));
      expect(report.environment.count).toBe(expectedCount);
      expect(report.environment.version).toBe('13.3.0');
      expect(report.environment.viewport).toMatchObject({width: 1440, height: 800});
      // A reload with identical state measures the shared SVG load path. The
      // separate projectOpenMs above includes the host's real file/runtime path.
      console.log("[real-perf] loaded",variant,report.projectOpenMs);
      let loadSession;
      if(process.env.BLOCKLY_PERF_LOAD_PROFILE === '1') {loadSession=await win.context().newCDPSession(win);await loadSession.send('Profiler.enable');await loadSession.send('Profiler.start');}
      report.reload = await win.evaluate(async () => {
        const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace;
        const state = B.serialization.workspaces.save(ws);
        const start = performance.now();
        B.Events.disable(); B.utils.dom.startTextWidthCache();
        try { w.loadForBenchmark(state); }
        finally { B.utils.dom.stopTextWidthCache(); B.Events.enable(); }
        const synchronousMs = performance.now() - start;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {synchronousMs, paintedMs: performance.now() - start};
      });
      if(loadSession){const {profile}=await loadSession.send('Profiler.stop');await writeFile(path.join(artifacts,`${report.label}-${variant}-${topology}-${round}-load.cpuprofile`),JSON.stringify(profile));await loadSession.detach();}
      if(process.env.BLOCKLY_PERF_LOAD_ONLY === '1'){report.loadOnly=true;return;}
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
        // Native snap-and-bump may displace this root after release. Record the
        // public move reason rather than weakening the pointer-distance check.
        w.perfBumps = [];
        const moveBy = block.moveBy;
        block.moveBy = function(dx, dy, reasons, ...args) {
          if (reasons?.includes('bump')) w.perfBumps.push({dx, dy});
          return moveBy.call(this, dx, dy, reasons, ...args);
        };
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
      console.log("[real-perf] drag starting",variant,target);
      const dragStart = Date.now();
      const phases: any[] = []; let phaseStart = Date.now();
      const phase = (name: string) => {phases.push({name, ms: Date.now()-phaseStart}); phaseStart=Date.now();};
      await win.mouse.move(pointer.x, pointer.y); phase('hover');
      await win.mouse.down(); phase('down');
      await win.mouse.move(pointer.x + 96, pointer.y + 48, {steps: 12}); phase('moves');
      await win.mouse.up(); phase('up');
      report.dragPhases = phases;
      report.dragMs = Date.now() - dragStart;
      console.log("[real-perf] drag complete",variant,report.dragMs);
      report.after = await win.evaluate(id => {
        const w = window as any; w.perfSample.running = false;
        return {...w.blocklyWorkspace.getBlockById(id).getRelativeToSurfaceXY(), sample: w.perfSample, bumps: w.perfBumps};
      }, target.id);
      // Event dispatch completing is not the same as the dropped stack being
      // painted. Keep this separate so older dispatch-only records stay honest.
      await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      report.dragPaintedMs = Date.now() - dragStart;
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
      const bumpX = report.after.bumps.reduce((sum, bump) => sum + bump.dx, 0);
      const bumpY = report.after.bumps.reduce((sum, bump) => sum + bump.dy, 0);
      expect(report.after.x - target.before.x - bumpX).toBeCloseTo(96, 0);
      expect(report.after.y - target.before.y - bumpY).toBeCloseTo(48, 0);
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
      report.codePreserved = await win.evaluate(() => (window as any).realCode() === (window as any).realBeforeCode);
      expect(report.codePreserved).toBe(true);
      const shot = await (await electronApp.browserWindow(win)).evaluate(async w => (await w.webContents.capturePage()).toPNG().toString('base64'));
      await writeFile(path.join(artifacts, `${report.label}-${variant}-${topology}-${round}.png`), Buffer.from(shot,'base64'));
      report.passed = true;
    } catch (error) {
      report.failure = String(error); throw error;
    } finally {
      report.finishedAt = new Date().toISOString();
      report.errors = errors;
      await writeFile(path.join(artifacts, `${report.label}-${variant}-${topology}-${round}.json`), JSON.stringify(report, null, 2));
      console.log('[benchmark]', JSON.stringify({...report, after: report.after && {x: report.after.x, y: report.after.y}}));
      await close?.().catch(() => {});
      server.close();
      await rm(temporary, {recursive: true, force: true});
    }
  });
}
