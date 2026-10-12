import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect, getMainWindow, launchAilyElectron, openBlocklyProject, test} from '../fixtures/electron-app';

const source = process.env['AILY_E2E_PROJECT'];
const libraries = process.env['AILY_E2E_LIBRARIES'];
for (const renderer of ['thrasos', 'zelos']) test(`${renderer}: library blocks preview without initialization side effects`, async ({}, info) => {
  test.skip(!source || !libraries, 'Set AILY_E2E_PROJECT and AILY_E2E_LIBRARIES to installed project and library sources.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-insertion-'));
  const project = path.join(root, 'project');
  await mkdir(project);
  const pkg = JSON.parse(await readFile(path.join(source!, 'package.json'), 'utf8'));
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => /lib-core-|board-/.test(name)));
  for (const name of Object.keys(dependencies)) {
    await cp(path.join(source!, 'node_modules', name), path.join(project, 'node_modules', name), {recursive: true});
  }
  for (const folder of ['aily_iic', 'esp32_spi']) {
    const lib = JSON.parse(await readFile(path.join(libraries!, folder, 'package.json'), 'utf8'));
    dependencies[lib.name] = lib.version;
    await cp(path.join(libraries!, folder), path.join(project, 'node_modules', lib.name), {recursive: true});
  }
  await writeFile(path.join(project, 'package.json'), JSON.stringify({name: 'insertion-preview', version: '1.0.0', board: pkg.board, devmode: 'arduino', dependencies}));
  await writeFile(path.join(project, 'project.abi'), JSON.stringify({blocks: {languageVersion: 0, blocks: [
    {type: 'arduino_global', id: 'global', x: 60, y: 100}, {type: 'arduino_setup', id: 'setup', x: 60, y: 220},
    {type: 'arduino_loop', id: 'loop', x: 60, y: 340},
  ]}}));
  const launched = await launchAilyElectron({config: {blockly: {renderer, minimap: false}}});
  const win = await getMainWindow(launched.app);
  const errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  try {
    await openBlocklyProject(win, project);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, {timeout: 90_000});
    await win.evaluate(async () => {
      const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace;
      B.Events.disable();
      try {
        ws.clear(); ws.setScale(.8);
        const setup = ws.newBlock('arduino_setup', 'target'); setup.initSvg(); setup.render(); setup.moveBy(70, 140);
        let connection = setup.getInput('ARDUINO_SETUP').connection;
        for (let i = 0; i < 7; i++) {
          const b = ws.newBlock('time_delay', `target-${i}`); b.initSvg(); b.render();
          const n = ws.newBlock('math_number'); n.initSvg(); n.render(); b.getInput('DELAY_TIME').connection.connect(n.outputConnection);
          connection.connect(b.previousConnection); connection = b.nextConnection;
        }
        // Hidden/offscreen blocks reproduce the cost of library-wide scans.
        for (let i = 0; i < 600; i++) {
          const b = ws.newBlock('serial_println'); b.initSvg(); b.render(); b.moveBy(1600 + i % 20 * 300, 100 + Math.floor(i / 20) * 60);
        }
        for (const [i, type] of ['serial_begin_esp32_custom', 'serial_begin_software', 'wire_begin_with_settings', 'esp32_spi_begin_custom'].entries()) {
          const b = ws.newBlock(type, type); b.initSvg(); b.render(); b.moveBy(430, 140 + i * 100);
        }
      } finally { B.Events.enable(); }
      B.Events.fire(new B.Events.FinishedLoading(ws));
      await B.renderManagement.finishQueuedRenders();
      ws.scroll(0, 0);
    });
    await win.waitForTimeout(1500);
    await win.screenshot({path: info.outputPath('before.png')});
    const all = [];
    for (const type of ['serial_begin_esp32_custom', 'serial_begin_software', 'wire_begin_with_settings', 'esp32_spi_begin_custom']) {
      await win.evaluate(type => {
        const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace;
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        w.probe = {clones: 0, scans: 0, scanMs: 0, timers: 0, previews: 0, maxPreviewMs: 0};
        if (!w.instrumented) {
          w.instrumented = true;
          const originalNew = ws.newBlock, originalScan = ws.getAllBlocks, originalTimeout = realm.setTimeout;
          ws.newBlock = function(...args) { w.probe.clones++; return originalNew.apply(this, args); };
          ws.getAllBlocks = function(...args) { const t = performance.now(); try { return originalScan.apply(this, args); } finally { w.probe.scans++; w.probe.scanMs += performance.now() - t; } };
          realm.setTimeout = function(...args) { w.probe.timers++; return originalTimeout.apply(this, args); };
          const proto = B.InsertionMarkerPreviewer.prototype, originalPreview = proto.previewConnection;
          proto.previewConnection = function(...args) { const t = performance.now(); w.probe.previews++; try { return originalPreview.apply(this, args); } finally { w.probe.maxPreviewMs = Math.max(w.probe.maxPreviewMs, performance.now() - t); } };
        }
        w.beforeDrag = JSON.stringify(B.serialization.workspaces.save(ws));
        w.beforePorts = JSON.stringify([realm.customSerialPorts, realm.customI2CWires, realm.customESPSPIs]);
        w.beforeListeners = ws.listeners.length;
        ws.clearUndo();
        ws.getBlockById(type).getSvgRoot().setAttribute('data-drag-probe', 'source');
      }, type);
      // Grab the block body, away from editable fields.
      const body = win.locator('.blocklyBlockCanvas [data-drag-probe="source"] > .blocklyPath').first();
      const box = await body.boundingBox(); expect(box).toBeTruthy();
      const grab = {x: box!.x + 7, y: box!.y + 12};
      const offset = await win.evaluate(({type, grab}) => {
        const ws = (window as any).blocklyWorkspace, c = ws.getBlockById(type).previousConnection;
        const point = new DOMPoint(c.x, c.y).matrixTransform(ws.getCanvas().getScreenCTM());
        return {x: grab.x - point.x, y: grab.y - point.y};
      }, {type, grab});
      await win.mouse.move(grab.x, grab.y); await win.mouse.down();
      await win.mouse.move(grab.x + 20, grab.y + 10);
      const latencies: number[] = [];
      for (let i = 0; i < 24; i++) {
        const goal = await win.evaluate(({offset, index}) => {
          const ws = (window as any).blocklyWorkspace, target = ws.getBlockById(`target-${index % 6}`);
          const c = target.previousConnection;
          const point = new DOMPoint(c.x, c.y).matrixTransform(ws.getCanvas().getScreenCTM());
          return {x: point.x + offset.x, y: point.y + offset.y};
        }, {offset, index: i});
        const t = Date.now(); await win.mouse.move(goal.x, goal.y); latencies.push(Date.now() - t);
        await win.waitForTimeout(60);
      }
      expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
      const markers = await win.locator('.blocklyInsertionMarker').count();
      await win.screenshot({path: info.outputPath(`${type}-preview.png`)});
      if (process.env['AILY_E2E_DRAG_BASELINE']) await win.mouse.move(grab.x, grab.y);
      await win.mouse.up();
      await win.waitForTimeout(500);
      const result = await win.evaluate(type => {
        const w = window as any, ws = w.blocklyWorkspace;
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        ws.getBlockById(type).getSvgRoot().removeAttribute('data-drag-probe');
        return {type, ...w.probe, listenerDelta: ws.listeners.length - w.beforeListeners,
          portsPreserved: JSON.stringify([realm.customSerialPorts, realm.customI2CWires, realm.customESPSPIs]) === w.beforePorts};
      }, type);
      all.push({...result, markers, maxPointerMs: Math.max(...latencies)});
      console.log('[insertion-preview]', renderer, JSON.stringify(all.at(-1)));
      if (!process.env['AILY_E2E_DRAG_BASELINE']) {
        expect(markers).toBeGreaterThan(0); expect(result.previews).toBeGreaterThan(10);
        expect(result.clones).toBe(0); expect(result.listenerDelta).toBe(0); expect(result.portsPreserved).toBe(true);
        expect(await win.evaluate(type => {
          const b = (window as any).blocklyWorkspace.getBlockById(type);
          return [b.previousConnection.targetBlock()?.id, b.nextConnection.targetBlock()?.id];
        }, type)).toEqual(['target-4', 'target-5']);
        for (let i = 0; i < 10 && await win.evaluate(() => (window as any).blocklyWorkspace.getUndoStack().length); i++) {
          await win.evaluate(async () => { const w = window as any; w.blocklyWorkspace.undo(false); await w.Blockly.renderManagement.finishQueuedRenders(); });
          await win.waitForTimeout(50);
        }
        const restored = await win.evaluate(() => {
          const w = window as any;
          // Undo re-adds a detached root at the end of the workspace's root list.
          const normalize = (state: any) => { state.blocks.blocks.sort((a, b) => a.id.localeCompare(b.id)); return state; };
          return {actual: normalize(w.Blockly.serialization.workspaces.save(w.blocklyWorkspace)), expected: normalize(JSON.parse(w.beforeDrag))};
        });
        await writeFile(info.outputPath(`${type}-undo.json`), JSON.stringify(restored));
        expect(restored.actual).toEqual(restored.expected);
      }
    }
    await writeFile(info.outputPath('metrics.json'), JSON.stringify({renderer, all, errors}, null, 2));
    expect(errors).toEqual([]);
  } finally { await launched.close(); await rm(root, {recursive: true, force: true, maxRetries: 5}); }
});
