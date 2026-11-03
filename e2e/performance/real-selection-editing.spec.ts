import {cp, mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {test, expect, launchAilyElectron, getMainWindow, openBlocklyProject} from '../fixtures/electron-app';

// Exercise the registered production commands with real project libraries and
// host listeners. Native pointer/keyboard acceptance is recorded separately.
test('large project declaration duplicate/delete preserves the original graph', async () => {
  const source = process.env['AILY_E2E_PROJECT'];
  test.skip(!source, 'Set AILY_E2E_PROJECT to an installed large Blockly project.');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'aily-selection-editing-'));
  const project = path.join(temp, 'project');
  const original = await readFile(path.join(source!, 'project.abi'));
  await cp(source!, project, {recursive: true, dereference: true, filter: file =>
    !['.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock'].includes(path.basename(file))});
  const output = path.resolve('e2e/performance/test-results/selection-editing', process.env['AILY_PERF_LABEL'] || 'current');
  await mkdir(output, {recursive: true});
  const config = JSON.parse(await readFile('electron/config/config.json', 'utf8'));
  config.blockly.minimap = true;
  const launched = await launchAilyElectron({config});
  const win = await getMainWindow(launched.app);
  const results: any = {sourceSha256: createHash('sha256').update(original).digest('hex'), rounds: []};
  try {
    await openBlocklyProject(win, project);
    await win.waitForFunction(() => { const el = document.querySelector('app-blockly-editor'); return el && (window as any).ng?.getComponent(el)?.npmService; });
    await win.evaluate(() => { (window as any).ng.getComponent(document.querySelector('app-blockly-editor')).npmService.installBoardDeps = async () => {}; });
    await win.waitForFunction(() => {
      const w = window as any;
      return w.blocklyWorkspace?.getAllBlocks(false).length > 1000 &&
        document.querySelector('blockly-main') && w.ng?.getComponent(document.querySelector('blockly-main'))?.blocklyService;
    }, null, {timeout: 120000});
    await win.waitForFunction(() => !!document.querySelector('iframe[data-runtime-ready="true"]'), null, {timeout: 120000});
    await win.waitForTimeout(5000);
    await win.evaluate(() => {
      const w = window as any;
      w.selectionGraph = () => JSON.stringify(w.blocklyWorkspace.getAllBlocks(false)
        .map(b => [b.id, b.type, b.getParent()?.id, b.getNextBlock()?.id,
          b.inputList.flatMap(i => i.fieldRow.filter(f => f.name).map(f => [f.name, f.getValue()]))])
        .sort((a, b) => a[0].localeCompare(b[0])));
      w.selectionBefore = w.selectionGraph();
    });
    await win.waitForTimeout(4000);
    results.count = await win.evaluate(() => (window as any).blocklyWorkspace.getAllBlocks(false).length);
    for (let round = 0; round < 2; round++) {
      const cdp = await win.context().newCDPSession(win);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
      const duplicated = await win.evaluate(async () => {
        const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace;
        const root = ws.getTopBlocks(false).find(b => b.type === 'arduino_global');
        if (!root) throw new Error('Missing global declaration root: ' + ws.getTopBlocks(false).map(b => b.type).join(','));
        const count = ws.getAllBlocks(false).length;
        w.selectionTasks = [];
        w.selectionObserver = new PerformanceObserver(list => w.selectionTasks.push(...list.getEntries().map(e => e.duration)));
        w.selectionObserver.observe({entryTypes: ['longtask']});
        B.common.setSelected(root);
        const start = performance.now();
        B.ContextMenuRegistry.registry.getItem('blockDuplicate').callback({block: root});
        const syncMs = performance.now() - start;
        await B.renderManagement.finishQueuedRenders();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return {syncMs, paintedMs: performance.now() - start, added: ws.getAllBlocks(false).length - count};
      });
      await win.waitForTimeout(2500);
      const dupTasks = await win.evaluate(() => { const w = window as any; w.selectionObserver.disconnect(); return w.selectionTasks; });
      const {profile: dupProfile} = await cdp.send('Profiler.stop');
      await writeFile(path.join(output, `duplicate-${round}.cpuprofile`), JSON.stringify(dupProfile));
      const duplicateGraph = await win.evaluate(() => { const w = window as any; w.blocklyWorkspace.clearUndo(); return w.selectionGraph(); });
      await cdp.send('Profiler.start');
      const deleted = await win.evaluate(async () => {
        const w = window as any, B = w.Blockly, ws = w.blocklyWorkspace;
        const count = ws.getAllBlocks(false).length;
        w.selectionTasks = [];
        w.selectionObserver.observe({entryTypes: ['longtask']});
        const selected = B.getSelected();
        if (!selected) throw new Error('Duplicate selection missing');
        const start = performance.now();
        const command = Object.values(B.ShortcutRegistry.registry.getRegistry()).find((s: any) => s.name === 'multiselectDelete') as any;
        if (!command) throw new Error('Delete shortcut missing: ' + Object.keys(B.ShortcutRegistry.registry.getRegistry()).join(','));
        command.callback(ws, new KeyboardEvent('keydown', {key: 'Delete', cancelable: true}));
        const syncMs = performance.now() - start;
        await B.renderManagement.finishQueuedRenders();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        return {syncMs, paintedMs: performance.now() - start, removed: count - ws.getAllBlocks(false).length};
      });
      await win.waitForTimeout(2500);
      const delTasks = await win.evaluate(() => { const w = window as any; w.selectionObserver.disconnect(); return w.selectionTasks; });
      const {profile: delProfile} = await cdp.send('Profiler.stop');
      await writeFile(path.join(output, `delete-${round}.cpuprofile`), JSON.stringify(delProfile));
      await cdp.detach();
      const preserved = await win.evaluate(() => {const w = window as any; return w.selectionGraph() === w.selectionBefore;});
      const difference = preserved ? [] : await win.evaluate(() => {const w = window as any; const before = new Map(JSON.parse(w.selectionBefore).map(b => [b[0], JSON.stringify(b)])); return JSON.parse(w.selectionGraph()).filter(b => before.get(b[0]) !== JSON.stringify(b)).map(b => ({id: b[0], type: b[1]})).slice(0, 20);});
      await win.evaluate(() => (window as any).blocklyWorkspace.undo(false));
      await win.waitForTimeout(300);
      const undoPreserved = await win.evaluate(expected => (window as any).selectionGraph() === expected, duplicateGraph);
      await win.evaluate(() => (window as any).blocklyWorkspace.undo(true));
      await win.waitForTimeout(300);
      const redoPreserved = await win.evaluate(() => {const w = window as any; return w.selectionGraph() === w.selectionBefore;});
      results.rounds.push({duplicated, dupTasks, deleted, delTasks, preserved, difference, undoPreserved, redoPreserved});
      await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
      expect(deleted.removed).toBe(duplicated.added);
      expect(preserved).toBe(true);
      expect(undoPreserved).toBe(true);
      expect(redoPreserved).toBe(true);
    }
  } finally {
    await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    await launched.close();
    await rm(temp, {recursive: true, force: true});
    expect(await readFile(path.join(source!, 'project.abi'))).toEqual(original);
  }
});
