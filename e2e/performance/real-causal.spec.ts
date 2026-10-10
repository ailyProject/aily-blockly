import { test, expect, _electron } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { exerciseViewport } from './viewport-interactions';
import { exerciseEditingLatency } from './editing-latency';
import { exerciseSerialRefresh } from './serial-refresh';
import {
  ROOT,
  getMainWindow,
  openBlocklyProject,
  closeAilyElectronApp,
} from '../fixtures/electron-app';
const { serve } = require('../../scripts/serve-blockly-performance.cjs');
const fixtures = path.join(
  ROOT,
  'e2e/.artifacts/blockly-real-project-2026-09-28',
);
const output = path.join(
  ROOT,
  'e2e/.artifacts/blockly-causal-2026-10-09',
  process.env.BLOCKLY_CAUSAL_LABEL || '',
);
const cases = (
  process.env.BLOCKLY_CAUSAL_CASES ||
  'aily-ui:baseline,aily-ui:no-effects,aily-ui:no-foreign-object,aily-ui:inplace,aily-ui:no-drag-class,aily-ui:light,aily:baseline,official:baseline,aily-ui:split-stacks,aily-ui:host-loader'
).split(',');
for (const item of cases)
  test(`causal ${item}`, async () => {
    const [variant, diagnostic] = item.split(':');
    const report: any = { variant, diagnostic, date: new Date().toISOString() };
    const server: any = await serve(0, fixtures);
    const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-causal-'));
    const host = variant === 'host';
    const project = path.join(temporary, 'project');
    if (host) {
      await cp(path.join(fixtures, 'project-expanded'), project, {
        recursive: true,
      });
      // Test a freshly packed serial library only in the disposable project.
      // The captured real project and its installed dependencies stay intact.
      if (process.env.BLOCKLY_CAUSAL_SERIAL_PACKAGE) {
        execFileSync('tar', [
          '-xzf',
          process.env.BLOCKLY_CAUSAL_SERIAL_PACKAGE,
          '--strip-components=1',
          '-C',
          path.join(project, 'node_modules/@aily-project/lib-core-serial'),
        ]);
        report.serialPackage = path.basename(
          process.env.BLOCKLY_CAUSAL_SERIAL_PACKAGE,
        );
      }
      execFileSync(process.execPath, [
        path.join(ROOT, 'scripts/migrate-project-data-v1.mjs'),
        project,
      ]);
      const config = JSON.parse(
        await readFile(path.join(ROOT, 'electron/config/config.json'), 'utf8'),
      );
      config.blockly.minimap = diagnostic !== 'no-minimap';
      config.blockly.viewportRendering = diagnostic !== 'native';
      await writeFile(
        path.join(temporary, 'config.json'),
        JSON.stringify(config),
      );
    }
    const app = await _electron.launch({
      cwd: ROOT,
      args: host
        ? ['electron/main.js', '--serve', `--user-data-dir=${temporary}`]
        : [
            path.join(ROOT, 'e2e/performance/electron.cjs'),
            `--user-data-dir=${temporary}`,
          ],
      env: {
        ...env,
        AILY_E2E: '1',
        AILY_APPDATA_PATH: temporary,
        BLOCKLY_PERF_URL: `http://127.0.0.1:${server.address().port}/${variant}.html?topology=expanded&diagnostic=${diagnostic}`,
      },
    });
    if (host && process.env.BLOCKLY_CAUSAL_HOST_URL) {
      await app.context().route('http://localhost:4200/**', (route) =>
        route.fulfill({
          status: 302,
          headers: { location: process.env.BLOCKLY_CAUSAL_HOST_URL! },
        }),
      );
    }
    await mkdir(output, { recursive: true });
    const errors: string[] = [];
    try {
      const win = host ? await getMainWindow(app) : await app.firstWindow();
      win.on('pageerror', (e) => errors.push(e.message));
      if (host) {
        await (
          await app.browserWindow(win)
        ).evaluate((w) => w.setContentSize(1440, 800));
        const logs: string[] = [];
        win.on('console', (m) => {
          if (m.type() === 'error') logs.push(m.text());
        });
        report.consoleErrors = logs;
        await win.evaluate(() => {
          const w = window as any;
          w.nativeLoads = [];
          let current = w.Blockly;
          Object.defineProperty(w, 'Blockly', {
            configurable: true,
            get: () => current,
            set: (value) => {
              if (value !== current) {
                const original = value.serialization.workspaces.load;
                value.serialization.workspaces.load = function (
                  state,
                  ws,
                  ...args
                ) {
                  const start = performance.now();
                  try {
                    return original.call(this, state, ws, ...args);
                  } finally {
                    if (ws.rendered)
                      w.nativeLoads.push({
                        ms: performance.now() - start,
                        count: ws.getAllBlocks(false).length,
                      });
                  }
                };
              }
              current = value;
            },
          });
        });
        const loadSession = await win.context().newCDPSession(win);
        await loadSession.send('Profiler.enable');
        await loadSession.send('Profiler.start');
        const start = Date.now();
        await openBlocklyProject(win, project);
        await win.waitForFunction(
          () =>
            (window as any).blocklyWorkspace?.getAllBlocks(false).length ===
            8265,
          null,
          { timeout: 180000 },
        );
        report.openMs = Date.now() - start;
        await win.waitForFunction(
          () =>
            document
              .querySelector('iframe[data-blockly-generator-runtime]')
              ?.getAttribute('data-runtime-ready') === 'true',
          null,
          { timeout: 180000 },
        );
        await win.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        report.visibleMs = Date.now() - start;
        if (diagnostic !== 'no-minimap')
          await expect(win.locator('.blockly-minimap')).toHaveAttribute(
            'data-minimap-ready',
            'true',
            { timeout: 90000 },
          );
        report.readyMs = Date.now() - start;
        const { profile } = await loadSession.send('Profiler.stop');
        await writeFile(
          path.join(output, `${variant}-${diagnostic}-load.cpuprofile`),
          JSON.stringify(profile),
        );
        await loadSession.detach();
        report.initial = await win.evaluate(() => ({
          nativeLoads: (window as any).nativeLoads,
          url: location.href,
          minimapShapes: Number(
            (document.querySelector('.blockly-minimap') as HTMLElement)?.dataset
              .minimapShapes,
          ),
        }));
        if (diagnostic !== 'no-minimap')
          expect(report.initial.minimapShapes).toBe(8265);
        await win.evaluate(() => {
          const w = window as any;
          const realm = (
            document.querySelector(
              'iframe[data-blockly-generator-runtime]',
            ) as HTMLIFrameElement
          ).contentWindow as any;
          w.realCode = () => realm.Arduino.workspaceToCode(w.blocklyWorkspace);
        });
      } else {
        await win.waitForFunction(
          () => !!(window as any).benchmarkLoaded,
          null,
          { timeout: 180000 },
        );
        report.initial = await win.evaluate(
          () => (window as any).benchmarkLoaded,
        );
      }
      report.sourceLinkProbe = await win.evaluate(() =>
        getComputedStyle(document.querySelector('.injectionDiv')!)
          .getPropertyValue('--aily-source-link-probe')
          .trim(),
      );
      report.cachedFieldMeasurement = await win.evaluate(
        () =>
          typeof (window as any).Blockly.Field.prototype
            .canMeasureWithoutDom === 'function',
      );
      if (process.env.BLOCKLY_CAUSAL_LINK_PROBE)
        expect(report.sourceLinkProbe).toBe(
          process.env.BLOCKLY_CAUSAL_LINK_PROBE,
        );
      report.runtime = await app.evaluate(({ app }) => ({
        versions: process.versions,
        gpu: app.getGPUFeatureStatus(),
      }));
      await win.bringToFront();
      await win.waitForTimeout(500);
      report.target = await win.evaluate(() => {
        const w = window as any,
          B = w.Blockly,
          ws = w.blocklyWorkspace;
        B.hideChaff(false);
        B.getFocusManager().focusNode(ws.getRootFocusableNode());
        ws.getGrid().setSnapToGrid(false);
        ws.setScale(1);
        w.signature = () =>
          JSON.stringify(
            ws
              .getAllBlocks(false)
              .map((b) => [
                b.id,
                b.type,
                b.getParent()?.id,
                b.getNextBlock()?.id,
                b.inputList.map((i) => [
                  i.name,
                  i.connection?.targetBlock()?.id,
                  i.fieldRow
                    .filter((f) => f.name && f.SERIALIZABLE)
                    .map((f) => [f.name, f.saveState()]),
                ]),
              ])
              .sort((a, b) => a[0].localeCompare(b[0])),
          );
        w.beforeSignature = w.signature();
        w.beforeCode = w.realCode();
        w.geometryMismatches = () => {
          const c = ws.getCanvas().getCTM();
          return ws.getAllBlocks(false).filter((b) => {
            if (!b.getSvgRoot().isConnected) return false;
            const xy = b.getRelativeToSurfaceXY(),
              m = b.getSvgRoot().getCTM();
            return (
              Math.abs(m.e - (c.e + c.a * xy.x)) > 0.1 ||
              Math.abs(m.f - (c.f + c.d * xy.y)) > 0.1
            );
          }).length;
        };
        const b = ws
          .getTopBlocks(false)
          .filter((b) => b.isMovable())
          .sort(
            (a, b) =>
              b.getDescendants(false).length - a.getDescendants(false).length,
          )[0];
        const before = { ...b.getRelativeToSurfaceXY() };
        ws.scroll(240 - before.x, 100 - before.y);
        w.scrollIntoView = [];
        const originalScrollIntoView = ws.scrollBoundsIntoView;
        ws.scrollBoundsIntoView = function (rect, ...args) {
          w.scrollIntoView.push({
            dragging: ws.isDragging(),
            rect,
            scrollX: ws.scrollX,
            scrollY: ws.scrollY,
          });
          return originalScrollIntoView.call(this, rect, ...args);
        };
        w.bumps = [];
        const original = b.moveBy;
        b.moveBy = function (dx, dy, reasons, ...args) {
          if (reasons?.includes('bump')) w.bumps.push({ dx, dy });
          return original.call(this, dx, dy, reasons, ...args);
        };
        let maxDepth = 0;
        for (const block of ws.getAllBlocks(false)) {
          let depth = 0,
            el = block.getSvgRoot();
          while (el && el !== ws.getCanvas()) {
            depth++;
            el = el.parentElement;
          }
          maxDepth = Math.max(maxDepth, depth);
        }
        return {
          id: b.id,
          before,
          descendants: b.getDescendants(false).length,
          count: ws.getAllBlocks(false).length,
          svg: ws.getCanvas().querySelectorAll('*').length,
          foreignObjects: ws.getCanvas().querySelectorAll('foreignObject')
            .length,
          maxDepth,
          renderer: ws.getRenderer().getClassName(),
        };
      });
      expect(report.target.count).toBe(8265);
      await win.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      if (process.env.BLOCKLY_VISUAL_CHECK === '1')
        await win.screenshot({
          path: path.join(output, `${variant}-${diagnostic}-before-drag.png`),
        });
      const pointer = await win.evaluate((id) => {
        const w = window as any,
          b = w.blocklyWorkspace.getBlockById(id),
          rect = b.pathObject.svgPath.getBoundingClientRect();
        const point = [
          [8, 20],
          [4, 24],
          [5, 30],
          [40, 8],
        ]
          .map(([x, y]) => ({ x: rect.x + x, y: rect.y + y }))
          .find(
            (p) => document.elementFromPoint(p.x, p.y) === b.pathObject.svgPath,
          );
        if (!point) throw Error('Pointer target not on block path');
        w.sample = { frames: [], longTasks: [], trusted: 0, running: true };
        let last = performance.now();
        const frame = (t) => {
          if (!w.sample.running) return;
          w.sample.frames.push(t - last);
          last = t;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        new PerformanceObserver((list) =>
          w.sample.longTasks.push(...list.getEntries().map((e) => e.duration)),
        ).observe({ entryTypes: ['longtask'] });
        document.addEventListener('pointermove', (e) => {
          if (e.isTrusted) w.sample.trusted++;
        });
        return point;
      }, report.target.id);
      const cdp = await win.context().newCDPSession(win);
      const trace: any[] = [];
      cdp.on('Tracing.dataCollected', ({ value }) => trace.push(...value));
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,blink',
        transferMode: 'ReportEvents',
      });
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      const begin = Date.now();
      let last = begin;
      report.phases = [];
      const phase = (name) => {
        report.phases.push({ name, ms: Date.now() - last });
        last = Date.now();
      };
      await win.mouse.move(pointer.x, pointer.y);
      phase('hover');
      await win.mouse.down();
      phase('down');
      await win.mouse.move(pointer.x + 96, pointer.y + 48, { steps: 12 });
      phase('moves');
      await win.mouse.up();
      phase('up');
      report.dispatchMs = Date.now() - begin;
      await win.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      report.paintedMs = Date.now() - begin;
      const { profile } = await cdp.send('Profiler.stop');
      const complete = new Promise<void>((r) =>
        cdp.once('Tracing.tracingComplete', () => r()),
      );
      await cdp.send('Tracing.end');
      await complete;
      const traceSummary = {};
      for (const e of trace)
        if (e.ph === 'X' && e.dur)
          traceSummary[e.name] = (traceSummary[e.name] || 0) + e.dur / 1000;
      report.traceInclusiveMs = traceSummary;
      report.after = await win.evaluate((id) => {
        const w = window as any;
        w.sample.running = false;
        return {
          ...w.blocklyWorkspace.getBlockById(id).getRelativeToSurfaceXY(),
          sample: w.sample,
          scrollIntoView: w.scrollIntoView,
          bumps: w.bumps,
          statePreserved: w.signature() === w.beforeSignature,
          codePreserved: w.realCode() === w.beforeCode,
          geometryMismatches: w.geometryMismatches(),
          viewport: w.blocklyWorkspace.getViewportRenderer?.()?.getStats(),
          dragging: w.blocklyWorkspace.isDragging(),
          gesture: !!w.blocklyWorkspace.currentGesture_,
        };
      }, report.target.id);
      const bx = report.after.bumps.reduce((n, b) => n + b.dx, 0),
        by = report.after.bumps.reduce((n, b) => n + b.dy, 0);
      expect(report.after.x - report.target.before.x - bx).toBeCloseTo(96, 0);
      expect(report.after.y - report.target.before.y - by).toBeCloseTo(48, 0);
      expect(report.after.statePreserved).toBe(true);
      // The split diagnostic intentionally makes statements top-level; moving a
      // root can change their execution order. It is not a product optimization.
      if (diagnostic !== 'split-stacks')
        expect(report.after.codePreserved).toBe(true);
      expect(report.after.sample.trusted).toBeGreaterThanOrEqual(12);
      expect(report.after.dragging).toBe(false);
      expect(report.after.gesture).toBe(false);
      expect(errors).toEqual([]);
      expect(report.after.geometryMismatches).toBe(0);
      if (report.after.viewport) {
        expect(report.after.viewport.blocks).toBe(8265);
        expect(report.after.viewport.mounted).toBeLessThan(500);
      }
      await writeFile(
        path.join(output, `${variant}-${diagnostic}.cpuprofile`),
        JSON.stringify(profile),
      );
      await writeFile(
        path.join(output, `${variant}-${diagnostic}.trace.json`),
        JSON.stringify({ traceEvents: trace }),
      );
      const shot = await (
        await app.browserWindow(win)
      ).evaluate(async (w) =>
        (await w.webContents.capturePage()).toPNG().toString('base64'),
      );
      await writeFile(
        path.join(output, `${variant}-${diagnostic}.png`),
        Buffer.from(shot, 'base64'),
      );
      if (process.env.BLOCKLY_VISUAL_CHECK === '1') {
        // The faster load can leave the success toast and async title-bar
        // buttons visible during the first shot. Wait for the toast naturally
        // and compare the complete editor SVG, excluding unrelated app chrome.
        if (host)
          await expect(win.locator('.ant-message-notice')).toHaveCount(0);
        const clip = await win.evaluate(() => {
          const rect = (window as any).blocklyWorkspace
            .getParentSvg()
            .getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        });
        await win.evaluate(() => {
          const w = window as any;
          w.Blockly.getFocusManager().focusNode(
            w.blocklyWorkspace.getRootFocusableNode(),
          );
        });
        await win.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        const virtualImage = await win.screenshot({
          clip,
          path: path.join(
            output,
            `${variant}-${diagnostic}-virtual-parity.png`,
          ),
        });
        await win.evaluate(() =>
          (window as any).blocklyWorkspace.setViewportRendering(false),
        );
        await win.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        const nativeImage = await win.screenshot({
          clip,
          path: path.join(
            output,
            `${variant}-${diagnostic}-native-restored.png`,
          ),
        });
        expect(
          nativeImage.equals(virtualImage),
          'viewport/native pixels must match after clearing focus',
        ).toBe(true);
        expect(
          await win.evaluate(() => (window as any).geometryMismatches()),
        ).toBe(0);
        report.visualParity = true;
        await win.evaluate(() =>
          (window as any).blocklyWorkspace.setViewportRendering(true),
        );
      }
      if (process.env.BLOCKLY_VIEWPORT_INTERACTIONS === '1')
        report.interactions = await exerciseViewport(win);
      if (process.env.BLOCKLY_EDIT_LATENCY === '1')
        report.editing = await exerciseEditingLatency(
          win,
          output,
          process.env.BLOCKLY_EDIT_PROFILE === '1',
        );
      if (process.env.BLOCKLY_CAUSAL_SERIAL_PACKAGE)
        report.serialRefresh = await exerciseSerialRefresh(win);
      expect(errors).toEqual([]);
      report.passed = true;
    } catch (e) {
      report.failure = String(e);
      try {
        const failedWin = host
          ? await getMainWindow(app)
          : await app.firstWindow();
        await failedWin.screenshot({
          path: path.join(output, `${variant}-${diagnostic}-failed.png`),
        });
      } catch {}
      throw e;
    } finally {
      report.errors = errors;
      await writeFile(
        path.join(output, `${variant}-${diagnostic}.json`),
        JSON.stringify(report, null, 2),
      );
      console.log(
        '[causal]',
        JSON.stringify({
          variant,
          diagnostic,
          load: report.initial,
          target: report.target,
          dispatchMs: report.dispatchMs,
          paintedMs: report.paintedMs,
          passed: report.passed,
          failure: report.failure,
        }),
      );
      if (host) await closeAilyElectronApp(app);
      else await app.close();
      server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
