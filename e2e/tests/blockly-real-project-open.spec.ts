import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';
import {selectFunctionView} from '../fixtures/function-view';

import {seedPlatform} from '../fixtures/platform-seed';

const SOURCE = process.env['AILY_E2E_REAL_PROJECT'] ?? process.env['AILY_E2E_PROJECT'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// Flat topology comparisons stay stack-safe and include fields, attributes,
// connection roles and serializer state, rather than relying on block counts.
function graph(document: any) {
  const workspace = document.pages ? document.pages.find(page => page.id === document.activePageId).content : document;
  const roots = [...(document.sharedModel?.procedureBlocks ?? []), ...workspace.blocks.blocks];
  const pending = roots.map(block => ({ block, owner: null as any }));
  const blocks: any[] = [];
  while (pending.length) {
    const { block, owner } = pending.pop()!;
    const { inputs, next, ...attributes } = block;
    blocks.push({ ...attributes, owner });
    for (const [name, slot] of Object.entries(inputs ?? {}) as any[]) {
      if (slot.block) pending.push({ block: slot.block, owner: [block.id, name, 'block'] });
      if (slot.shadow) pending.push({ block: slot.shadow, owner: [block.id, name, 'shadow'] });
    }
    if (next?.block) pending.push({ block: next.block, owner: [block.id, 'next'] });
  }
  return { blocks: blocks.sort((a, b) => a.id.localeCompare(b.id)),
    roots: roots.map(block => block.id), variables: document.sharedModel?.variables ?? workspace.variables };
}

test('opens the real large project without dropping its program and records native load costs', async ({}, testInfo) => {
  test.setTimeout(240_000);
  test.skip(!SOURCE, 'Set AILY_E2E_PROJECT to an installed real Blockly project.');
  const originalAbi = await readFile(path.join(SOURCE!, 'project.abi'), 'utf8');
  const originalAbs = await readFile(path.join(SOURCE!, 'project.abs'), 'utf8');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-real-project-open-'));
  const project = path.join(root, 'project');
  await cp(SOURCE!, project, { recursive: true, filter: source => ![
    '.git', '.aily', '.temp', '.build', '.log', '.workspace-history', 'project-open.lock',
  ].includes(path.basename(source)) });
  const launched = await launchAilyElectron({ config: { blockly: { minimap: true } } });
  const win = await getMainWindow(launched.app);
  const errors: string[] = [];
  win.on('pageerror', error => { errors.push(error.stack ?? error.message); console.log('[real-open:error]', error.stack); });
  win.on('console', async message => {
    if (/加载项目失败|Cannot restore|Maximum call|discarded|Code generation error|Minimap .*failed/.test(message.text())) {
      const details = await Promise.all(message.args().map(arg => arg.evaluate(value => {
        const error = value as any;
        return error?.stack ? { message: error.message, stack: error.stack, code: error.code, details: error.details } : String(value);
      }).catch(() => message.text())));
      errors.push(JSON.stringify(details)); console.log('[real-open:console]', JSON.stringify(details));
    }
  });
  try {
    await seedPlatform(project, launched.userDataDir);
    const profiler = process.env['AILY_E2E_PROFILE'] ? await win.context().newCDPSession(win) : null;
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
    await win.evaluate(() => {
    const probe = (window as any).__realOpen = { started: performance.now(), phases: [], longTasks: [] };
    new PerformanceObserver(list => probe.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration }))))
      .observe({ entryTypes: ['longtask'] });
    new MutationObserver(changes => {
      for (const change of changes) {
        const element = change.target as HTMLElement;
        if (element.getAttribute(change.attributeName!) === 'true') probe.phases.push({ name: change.attributeName, start: performance.now() });
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-runtime-ready', 'data-minimap-ready'] });
    let native = (window as any).Blockly;
    const instrument = B => {
      if (!B?.serialization?.workspaces || B.__realOpenInstrumented) return;
      B.__realOpenInstrumented = true;
      const load = B.serialization.workspaces.load;
      const measuredLoad = function(state, workspace, ...args) {
        const start = performance.now();
        try { return load.call(this, state, workspace, ...args); }
        finally {
          const duration = performance.now() - start;
          probe.phases.push({ name: 'native-load', start, duration, blocks: workspace.getAllBlocks(false).length });
        }
      };
      try { B.serialization.workspaces.load = measuredLoad; }
      catch { probe.phases.push({ name: 'native-load-hook-unavailable' }); }
    };
    instrument(native);
    Object.defineProperty(window, 'Blockly', { configurable: true, get: () => native, set(value) { native = value; instrument(value); } });
    });
    await openBlocklyProject(win, project);
    await expect.poll(async () => {
      const state = await win.evaluate(() => ({
        ready: document.querySelector('iframe[data-runtime-ready="true"]') !== null,
        blocks: (window as any).blocklyWorkspace?.getAllBlocks(false).length ?? 0,
        footer: document.querySelector('app-footer')?.textContent,
      }));
      if (errors.length) throw new Error(errors.join('\n'));
      return state;
    }, { timeout: 120_000 }).toMatchObject({ ready: true, blocks: 7765 });
    const probe = await win.evaluate(() => ({ ...(window as any).__realOpen, ready: performance.now() }));
    console.log('[real-open:timings]', JSON.stringify(probe));
    if (profiler) {
      const { profile } = await profiler.send('Profiler.stop');
      await testInfo.attach('open-cpu-profile', { contentType: 'application/json', body: JSON.stringify(profile) });
      await profiler.detach();
    }
    await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-ready', 'true', { timeout: 45_000 });
    await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-shapes', '7765');
    await expect(win.locator('.blockly-minimap > svg')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const before = await win.evaluate(() => JSON.stringify((window as any).Blockly.serialization.workspaces.save((window as any).blocklyWorkspace)));
    const loop = JSON.parse(originalAbi).blocks.blocks.find(block => block.type === 'arduino_loop');
    await selectFunctionView(win, loop.id);
    const scopedCount = graph({ blocks: { blocks: [loop] } }).blocks.length;
    await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-shapes', String(scopedCount));
    expect(await win.evaluate(() => JSON.stringify((window as any).Blockly.serialization.workspaces.save((window as any).blocklyWorkspace)))).toBe(before);
    await win.screenshot({ path: testInfo.outputPath('opened-project.png'), timeout: 60_000 });
    await win.evaluate(async project => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      await realm.projectService.save(project);
    }, project);
    const saved = await readFile(path.join(project, 'project.abi'), 'utf8');
    const savedGraph = graph(JSON.parse(saved));
    expect(savedGraph.blocks).toHaveLength(7765); expect(savedGraph.variables).toHaveLength(320);
    const beforeGraph = graph(JSON.parse(before));
    expect(savedGraph).toEqual(beforeGraph);
    const code = await readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8');
    expect(code).toContain('void setup()'); expect(code.length).toBeGreaterThan(100_000);
    await win.evaluate(() => { location.hash = '#/main/guide'; });
    await expect(select).toHaveCount(0);
    await openBlocklyProject(win, project);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 90_000 });
    const reopened = await win.evaluate(() => JSON.stringify((window as any).Blockly.serialization.workspaces.save((window as any).blocklyWorkspace)));
    expect(graph(JSON.parse(reopened))).toEqual(savedGraph);
    await win.evaluate(async project => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      await realm.projectService.save(project);
    }, project);
    expect(await readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')).toBe(code);
    await selectFunctionView(win, '');
    await expect(win.locator('.blockly-minimap')).toHaveAttribute('data-minimap-shapes', '7765', { timeout: 45_000 });
    expect(hash(await readFile(path.join(SOURCE!, 'project.abi'), 'utf8'))).toBe(hash(originalAbi));
    expect(hash(await readFile(path.join(SOURCE!, 'project.abs'), 'utf8'))).toBe(hash(originalAbs));
    expect(errors).toEqual([]);
    await testInfo.attach('real-project-open-evidence', { contentType: 'application/json', body: JSON.stringify({ ...probe,
      blocks: 7765, variables: 320, codeHash: hash(code), originalAbiHash: hash(originalAbi), originalAbsHash: hash(originalAbs),
      savedAndReopened: true }, null, 2) });
  } catch (error) {
    await win.screenshot({ path: testInfo.outputPath('failed-project.png') }).catch(() => {});
    console.log('[real-open:failure]', JSON.stringify(await win.evaluate(() => (window as any).__realOpen).catch(() => null)));
    throw error;
  } finally { await launched.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
