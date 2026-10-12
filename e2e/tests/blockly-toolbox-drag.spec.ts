import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {selectFunctionView} from '../fixtures/function-view';
import {expect, getMainWindow, launchAilyElectron, openBlocklyProject, test} from '../fixtures/electron-app';

const source = process.env['AILY_E2E_PROJECT'];
const libraries = process.env['AILY_E2E_LIBRARIES'];
const real = process.env['AILY_E2E_TOOLBOX_REAL'] === '1';
const serialLibrary = process.env['AILY_E2E_SERIAL_LIBRARY'];
for (const renderer of ['thrasos', 'zelos']) test(`${renderer}: toolbox block initialization batches dependent renders`, async ({}, info) => {
  test.skip(!source || !libraries, 'Set AILY_E2E_PROJECT and AILY_E2E_LIBRARIES to installed project and library sources.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-toolbox-drag-'));
  const project = path.join(root, 'project');
  await mkdir(project);
  const pkg = JSON.parse(await readFile(path.join(source!, 'package.json'), 'utf8'));
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => real || /lib-core-|board-/.test(name)));
  for (const name of Object.keys(dependencies)) {
    await cp(path.join(source!, 'node_modules', name), path.join(project, 'node_modules', name), {recursive: true});
  }
  for (const folder of ['aily_iic', 'esp32_spi']) {
    const lib = JSON.parse(await readFile(path.join(libraries!, folder, 'package.json'), 'utf8'));
    dependencies[lib.name] = lib.version;
    await cp(path.join(libraries!, folder), path.join(project, 'node_modules', lib.name), {recursive: true});
  }
  if (serialLibrary) await cp(serialLibrary, path.join(project, 'node_modules/@aily-project/lib-core-serial'), {recursive: true});
  await writeFile(path.join(project, 'package.json'), JSON.stringify({name: 'toolbox-drag', version: '1.0.0', board: pkg.board, devmode: 'arduino', dependencies}));
  await writeFile(path.join(project, 'project.abi'), JSON.stringify({blocks: {languageVersion: 0, blocks: [
    {type: 'arduino_global', id: 'global', x: 60, y: 100}, {type: 'arduino_setup', id: 'setup', x: 60, y: 220},
    {type: 'arduino_loop', id: 'loop', x: 60, y: 340},
  ]}}));
  if (real) await cp(path.join(source!, 'project.abi'), path.join(project, 'project.abi'));
  const launched = await launchAilyElectron({config: {blockly: {renderer, minimap: false}}});
  const win = await getMainWindow(launched.app);
  const errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  try {
    await openBlocklyProject(win, project);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, {timeout: 90_000});
    if (process.env['AILY_E2E_DRAG_BASELINE']) await win.evaluate(() => {
      // A controlled baseline uses the same host, board and installed scripts;
      // release only this fix on the disposable workspace.
      const component=(window as any).ng.getComponent(document.querySelector('blockly-main'));
      component.releaseDragRenderBatch(); component.releaseDragRenderBatch=undefined;
    });
    if (!real) await win.evaluate(async () => {
      const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace;
      B.Events.disable();
      try {
        ws.clear(); ws.setScale(.8);
        const setup = ws.newBlock('arduino_setup', 'target'); setup.initSvg(); setup.render(); setup.moveBy(500, 200);
        for (let i = 0; i < 600; i++) {
          const type = ['serial_println', 'wire_begin_transmission', 'esp32_spi_end_transaction'][i % 3];
          const b = ws.newBlock(type); b.initSvg(); b.render(); b.moveBy(1800 + i % 20 * 300, 100 + Math.floor(i / 20) * 70);
        }
      } finally { B.Events.enable(); }
      B.Events.fire(new B.Events.FinishedLoading(ws));
      await B.renderManagement.finishQueuedRenders(); ws.scroll(0, 0);
    });
    if (real) {
      const id = await win.evaluate(() => (window as any).blocklyWorkspace.getTopBlocks(false).find(b => b.type === 'arduino_global').id);
      await selectFunctionView(win, id);
    }
    await win.waitForTimeout(2000);
    await win.evaluate(() => {
      const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace;
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const probe = w.probe = {active: false, methods: {}, timers: [], events: [], frames: [], longTasks: []};
      const wrap = (obj, name, label = name) => {
        const original = obj[name]; if (typeof original !== 'function') return;
        obj[name] = function(...args) {
          if (!probe.active) return original.apply(this, args);
          const start = performance.now();
          try { return original.apply(this, args); }
          finally { const m = probe.methods[label] ||= {calls: 0, total: 0, max: 0}; const dt = performance.now()-start; m.calls++; m.total += dt; m.max = Math.max(m.max, dt); }
        };
      };
      for (const name of ['getAllBlocks', 'newBlock', 'refreshToolboxSelection']) wrap(ws, name);
      for (const name of ['render', 'initSvg']) wrap(B.BlockSvg.prototype, name);
      for (const name of ['setValue', 'forceRerender']) wrap(B.FieldDropdown.prototype, name);
      for (const name of ['updateSerialBlocksWithCustomPorts', 'updateI2CBlocksWithPinInfo', 'updateESPSPIBlocksWithCustomPorts']) wrap(realm, name);
      wrap(realm.Arduino, 'workspaceToCode');
      const timeout = realm.setTimeout;
      realm.setTimeout = function(callback, delay, ...args) {
        const stack = new Error().stack;
        return timeout(function(...values) { const start=performance.now(); try { return callback.apply(this, values); } finally {
          if (probe.active) probe.timers.push({delay, duration: performance.now()-start, dragging: ws.isDragging(), stack});
        } }, delay, ...args);
      };
      new PerformanceObserver(list => { if(probe.active) probe.longTasks.push(...list.getEntries().map(e => ({start: e.startTime, duration: e.duration}))); }).observe({entryTypes:['longtask']});
      const frame = time => {if(probe.active) probe.frames.push(time); requestAnimationFrame(frame);}; requestAnimationFrame(frame);
      ws.addChangeListener(e => {if(probe.active) probe.events.push({type:e.type, start:e.isStart, time:performance.now()});});
    });
    const blockCount = await win.evaluate(() => (window as any).blocklyWorkspace.getAllBlocks(false).length);
    const results = [];
    const cdp = await win.context().newCDPSession(win); await cdp.send('Profiler.enable');
    for (const type of (real ? ['serial_begin_esp32_custom', 'serial_println'] : ['serial_begin_esp32_custom', 'serial_begin_software', 'wire_begin_with_settings', 'esp32_spi_begin_custom'])) {
      // Use the real category and flyout, including its shadows and extensions.
      await win.evaluate(async type => {
        const ws = (window as any).blocklyWorkspace, toolbox = ws.getToolbox();
        let category = toolbox.getToolboxItems().find(item => JSON.stringify(item.getContents?.() || []).includes(type));
        if (!category && type === 'serial_begin_software') {
          // SoftwareSerial is AVR-only in the palette; exercise the same native
          // flyout path on this ESP32 fixture without changing board support.
          category = toolbox.getToolboxItems().find(item => JSON.stringify(item.getContents?.() || []).includes('serial_begin_esp32_custom'));
          category.updateFlyoutContents([...category.getContents(), {kind:'block',type}]);
        }
        if (!category) throw new Error(`Missing category for ${type}`);
        toolbox.setSelectedItem(category);
        await (window as any).Blockly.renderManagement.finishQueuedRenders();
        const flyout = ws.getFlyout(), b = flyout.getWorkspace().getAllBlocks(false).find(b => b.type === type);
        if (!b) throw new Error(`Missing flyout block ${type}`);
        flyout.getWorkspace().scrollbar.setY(Math.max(0, b.getRelativeToSurfaceXY().y * flyout.getWorkspace().scale - 60));
        b.getSvgRoot().setAttribute('data-toolbox-drag', type);
      }, type);
      await win.waitForTimeout(500);
      const body = win.locator(`[data-toolbox-drag="${type}"] > .blocklyPath`).first();
      const box = await body.boundingBox(); expect(box).toBeTruthy();
      const grab = {x:box!.x+8, y:box!.y+12};
      const target = await win.evaluate(() => {const r=(window as any).blocklyWorkspace.getInjectionDiv().getBoundingClientRect(); return {x:r.left+r.width*.65,y:r.top+r.height*.5};});
      const beforeIds = await win.evaluate(() => (window as any).blocklyWorkspace.getAllBlocks(false).map(b => b.id));
      await win.evaluate(() => (window as any).blocklyWorkspace.clearUndo());
      await cdp.send('Profiler.start');
      await win.evaluate(() => { const p=(window as any).probe; p.methods={};p.timers=[];p.events=[];p.frames=[];p.longTasks=[];p.active=true; });
      await win.mouse.move(grab.x,grab.y); await win.mouse.down();
      const latencies = [];
      for(let i=0;i<60;i++) {const start=Date.now(); await win.mouse.move(target.x+Math.sin(i/5)*60,target.y+Math.cos(i/5)*40); latencies.push(Date.now()-start); await win.waitForTimeout(16);}
      expect(await win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
      const during = await win.evaluate(() => JSON.parse(JSON.stringify((window as any).probe)));
      await win.mouse.up(); await win.waitForTimeout(800);
      const result = await win.evaluate(() => {const p=(window as any).probe;p.active=false;return JSON.parse(JSON.stringify(p));});
      const {profile}=await cdp.send('Profiler.stop'); await writeFile(info.outputPath(`${type}.cpuprofile`),JSON.stringify(profile));
      results.push({type,during,result,maxPointerMs:Math.max(...latencies)});
      await win.screenshot({path:info.outputPath(`${type}.png`)});
      if (!process.env['AILY_E2E_DRAG_BASELINE']) {
        expect(during.methods.render?.calls || 0).toBeLessThan(10);
        expect(Math.max(0, ...during.longTasks.map(t => t.duration))).toBeLessThan(real ? 250 : 150);
        const created = await win.evaluate(({type, beforeIds}) => {
          const ws = (window as any).blocklyWorkspace;
          const b = ws.getAllBlocks(false).find(b => b.type === type && !beforeIds.includes(b.id));
          if (!b) throw new Error('Drag did not create a workspace block');
          return {id:b.id, state:(window as any).Blockly.serialization.blocks.save(b)};
        }, {type,beforeIds});
        await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
        await expect.poll(() => win.evaluate(id => !!(window as any).blocklyWorkspace.getBlockById(id),created.id)).toBe(false);
        await win.waitForTimeout(150);
        await win.evaluate(() => (window as any).blocklyWorkspace.undo(true));
        await expect.poll(() => win.evaluate(id => !!(window as any).blocklyWorkspace.getBlockById(id),created.id)).toBe(true);
        await win.waitForTimeout(300);
        expect(await win.evaluate(id => {
          const w=window as any; return w.Blockly.serialization.blocks.save(w.blocklyWorkspace.getBlockById(id));
        },created.id)).toEqual(created.state);
      }
      console.log('[toolbox-drag]',type,JSON.stringify({methods:during.methods,timers:during.timers.map(t=>({duration:t.duration,delay:t.delay,dragging:t.dragging})),longTasks:during.longTasks,maxPointerMs:Math.max(...latencies)}));
      await writeFile(info.outputPath('metrics.json'),JSON.stringify({renderer,blockCount,results,errors},null,2));
    }
    if (!real) {
      // Changing a selected bus label must still update both the dropdown and
      // rendered field geometry after the performance optimization.
      await win.evaluate(() => {
        const w=window as any, ws=w.blocklyWorkspace;
        const wire=ws.getBlocksByType('wire_begin_with_settings',false)[0];
        wire.getInputTargetBlock('SDA').setFieldValue(9,'NUM');
        const spi=ws.getBlocksByType('esp32_spi_begin_custom',false)[0];
        spi.getInputTargetBlock('SCK').setFieldValue(13,'NUM');
      });
      await expect.poll(() => win.evaluate(() => {
        const w=window as any, ws=w.blocklyWorkspace;
        const realm=(document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        const wire=ws.getBlocksByType('wire_begin_with_settings',false)[0].getFieldValue('WIRE');
        const spi=ws.getBlocksByType('esp32_spi_begin_custom',false)[0].getFieldValue('VAR');
        return [realm.customI2CPins?.[wire]?.find(p=>p[0]==='SDA')?.[1],realm.customESPSPIs?.[spi]?.sck].map(String);
      })).toEqual(['9','13']);
      const labels = await win.evaluate(async () => {
        const w=window as any, ws=w.blocklyWorkspace;
        const wire=ws.getBlocksByType('wire_begin_transmission',false)[0];
        const spi=ws.getBlocksByType('esp32_spi_end_transaction',false)[0];
        spi.setFieldValue(ws.getBlocksByType('esp32_spi_begin_custom',false)[0].getFieldValue('VAR'),'SPI');
        await w.Blockly.renderManagement.finishQueuedRenders();
        return [wire.getField('WIRE').getText(),spi.getField('SPI').getText()];
      });
      expect(labels[0]).toContain('SDA:9'); expect(labels[1]).toContain('SCK:13');
      const unchanged = await win.evaluate(async () => {
        const w=window as any,p=w.probe;
        const realm=(document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        p.methods={};p.active=true;
        for (let i=0;i<5;i++) {realm.updateI2CBlocksWithPinInfo();realm.updateESPSPIBlocksWithCustomPorts();}
        await w.Blockly.renderManagement.finishQueuedRenders(); p.active=false;
        return p.methods;
      });
      expect(unchanged.render?.calls || 0).toBe(0);
      expect(unchanged.forceRerender?.calls || 0).toBe(0);
    }
    const saved = await win.evaluate(async project => {
      const realm=(document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const result=await realm.projectService.save(project,30_000);
      const w=window as any;
      return {success:result.success,blocks:JSON.stringify(w.Blockly.serialization.workspaces.save(w.blocklyWorkspace).blocks.blocks.sort((a,b)=>a.id.localeCompare(b.id)))};
    },project);
    expect(saved.success).toBe(true);
    await win.reload();
    await openBlocklyProject(win,project);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1,{timeout:90_000});
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace?.getAllBlocks(false).length)).toBeGreaterThan(600);
    const reopened = await win.evaluate(() => {const w=window as any;return JSON.stringify(w.Blockly.serialization.workspaces.save(w.blocklyWorkspace).blocks.blocks.sort((a,b)=>a.id.localeCompare(b.id)));});
    expect(reopened).toBe(saved.blocks);
    expect(errors).toEqual([]);
  } finally { await launched.close(); await rm(root,{recursive:true,force:true,maxRetries:5}); }
});
