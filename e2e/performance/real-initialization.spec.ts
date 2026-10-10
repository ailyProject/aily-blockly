import { cp, mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';

const source = process.env['AILY_E2E_PROJECT'];
test('large project initialization preserves roots through input races, editing and reopen', async () => {
  test.skip(!source, 'Set AILY_E2E_PROJECT to an installed large Blockly project.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-initialization-'));
  const project = path.join(temporary, 'project');
  await cp(source!, project, { recursive: true, dereference: true, filter: file => ![
    '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock',
  ].includes(path.basename(file)) });
  const output = path.resolve('e2e/.artifacts/blockly-initialization-2026-10-09', process.env['BLOCKLY_INIT_LABEL'] || 'baseline');
  await mkdir(output, { recursive: true });
  const config = JSON.parse(await readFile(path.resolve('electron/config/config.json'), 'utf8'));
  config.blockly.minimap = true;
  config.blockly.renderer = process.env['BLOCKLY_INIT_RENDERER'] || 'thrasos';
  const launched = await launchAilyElectron({ config });
  const win = await getMainWindow(launched.app);
  const report: any = { source, rounds: [], errors: [], gpu: await launched.app.evaluate(({ app }) => app.getGPUFeatureStatus()) };
  let edited: { id: string; before: number; after: number } | undefined;
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
    for (let round = 0; round < Number(process.env['BLOCKLY_INIT_ROUNDS'] || 4); round++) {
      const session = round === 0 ? await win.context().newCDPSession(win) : null;
      if (session) { await session.send('Profiler.enable'); await session.send('Profiler.start'); }
      const start = Date.now();
      await openBlocklyProject(win, project!);
      await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 90_000 });
      await win.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const visibleMs = Date.now() - start;
      const result = await win.evaluate(() => {
        const w = window as any, ws = w.blocklyWorkspace;
        return { renderer: ws.options.renderer, loads: w.initialLoads.splice(0), startupDrag: w.startupDrag, roots: ws.getTopBlocks(false).map(block => block.id),
          count: ws.getAllBlocks(false).length, stats: ws.getViewportRenderer()?.getStats() };
      });
      report.rounds.push({ round, visibleMs, ...result });
      console.log('[initialization]', JSON.stringify(report.rounds.at(-1)));
      if (session) {
        const { profile } = await session.send('Profiler.stop');
        await writeFile(path.join(output, 'load.cpuprofile'), JSON.stringify(profile)); await session.detach();
      }
      if (process.env['BLOCKLY_INIT_RACE']) {
        expect(result.startupDrag.accepted).toBe(false);
        expect(result.startupDrag.after).toEqual(result.startupDrag.before);
      }
      await expect(win.locator('vite-error-overlay')).toHaveCount(0);
      for (const load of result.loads) expect(load.after).toEqual(load.before);
      expect(result.count).toBeGreaterThan(7000);
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
      }
      if (round === 0) await win.evaluate(async project => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        await realm.projectService.save(project);
      }, project!);
      await win.evaluate(() => { location.hash = '#/main/guide'; });
      await expect(win.locator('app-blockly-editor')).toHaveCount(0);
    }
    expect(report.errors).toEqual([]);
  } finally {
    report.startupDrag = await win.evaluate(() => (window as any).startupDrag).catch(() => undefined);
    await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    await launched.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
