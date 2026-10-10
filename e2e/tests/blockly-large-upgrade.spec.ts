import {test, expect, getMainWindow, openBlocklyProject, closeAilyElectronApp} from '../fixtures/electron-app';
import {constants} from 'node:fs';
import {cp, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {Page} from '@playwright/test';

const SOURCE = process.env['AILY_E2E_LARGE_PROJECT'];
// DOM tracing recursively snapshots deeply nested SVG stacks and can dominate
// the workload. Keep real screenshots/contract evidence without that observer.
test.use({trace: 'off'});

async function observeProgressOnNextEditor(win: Page) {
  await win.evaluate(() => {
    const state = window as any;
    const evidence = state.__largeProgressEvidence ??= {samples: 0, invalid: [] as string[], mounts: 0};
    state.__largeProgressObserver?.disconnect();
    state.__largeProgressMountObserver?.disconnect();
    // Each route entry creates a new notification element. Do not keep
    // observing a detached element after the save/reopen part of this test.
    const mountObserver = new MutationObserver(attach);
    state.__largeProgressMountObserver = mountObserver;
    function attach() {
      const root = document.querySelector('app-blockly-editor app-notification');
      if (!root) return;
      mountObserver.disconnect();
      evidence.mounts++;
      const sample = () => {
        const text = root.querySelector('.num-box')?.textContent?.trim();
        if (!text) return;
        evidence.samples++;
        const value = Number(text.replace('%', ''));
        if (!Number.isFinite(value) || value < 0 || value > 100) evidence.invalid.push(text);
      };
      const observer = new MutationObserver(sample);
      state.__largeProgressObserver = observer;
      observer.observe(root, {subtree: true, childList: true, characterData: true});
      sample();
    }
    mountObserver.observe(document.body, {subtree: true, childList: true});
    attach();
  });
}

test('large real-project copy preserves all blocks, code, JSON and live field undo', async ({electronApp}, testInfo) => {
  test.skip(!SOURCE, 'Set AILY_E2E_LARGE_PROJECT to a real Blockly project; only a temporary copy is modified.');
  test.setTimeout(180_000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-v13-large-'));
  const project = path.join(temporary, 'project');
  const win = await getMainWindow(electronApp);
  const errors: string[] = [];
  win.on('pageerror', error => {errors.push(error.message); console.log('[upgrade-large] error', error.message);});
  win.on('console', message => {
    if (message.text().startsWith('[upgrade-large]')) console.log(new Date().toISOString(), message.text());
  });
  try {
    await observeProgressOnNextEditor(win);
    await cp(SOURCE!, project, {recursive: true, mode: constants.COPYFILE_FICLONE,
      // Runtime locks belong to the source instance, never to the disposable
      // clone. Keep the real user's project/lock completely untouched.
      filter: source => !['.git', '.temp', '.build', 'build', '.workspace-history', 'project-open.lock'].includes(path.basename(source))});
    const started = Date.now();
    console.log('[upgrade-large] clone ready; opening');
    await openBlocklyProject(win, project);
    await expect.poll(() => win.evaluate(() => document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready')), {timeout: 90_000}).toBe('true');
    const loadedAt = Date.now();
    const result = await win.evaluate(async () => {
      console.log('[upgrade-large] runtime ready');
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      const B = realm.Blockly;
      const ws = (window as any).blocklyWorkspace;
      const count = ws.getAllBlocks(false).length;
      const svgCount = ws.getCanvas().querySelectorAll('.blocklyDraggable').length;
      const variables = ws.getVariableMap().getAllVariables().length;
      const start = performance.now();
      const code = realm.Arduino.workspaceToCode(ws);
      console.log('[upgrade-large] generated', count, code.length);
      const generationMs = performance.now() - start;
      const saved = B.serialization.workspaces.save(ws);
      console.log('[upgrade-large] serialized');
      // Match the production page loader's bulk-load transaction. Replaying
      // thousands of intermediate deletes/moves is not a user edit or the
      // host's load contract; field editing below is still event-enabled.
      B.Events.disable();
      B.utils.dom.startTextWidthCache();
      try {
        B.serialization.workspaces.load(saved, ws);
        B.renderManagement.triggerQueuedRenders();
      } finally {
        B.utils.dom.stopTextWidthCache();
        B.Events.enable();
      }
      await B.renderManagement.finishQueuedRenders();
      console.log('[upgrade-large] roundtrip rendered');
      const codeAfter = realm.Arduino.workspaceToCode(ws);
      const countAfter = ws.getAllBlocks(false).length;
      const block = ws.getAllBlocks(false).find((candidate: any) => candidate.type === 'math_number');
      ws.clearUndo();
      const before = block.getFieldValue('NUM');
      block.setFieldValue(Number(before) + 1, 'NUM');
      await new Promise(resolve => setTimeout(resolve, 50));
      ws.undo(false);
      return {version: B.VERSION, count, svgCount, variables, countAfter, codeLength: code.length,
        codeMatches: code === codeAfter, generationMs, code,
        undoMatches: block.getFieldValue('NUM') === before};
    });
    expect(result.version).toBe('13.3.0');
    expect(result.count).toBeGreaterThan(2000);
    expect(result.svgCount).toBeGreaterThan(2000);
    expect(result.countAfter).toBe(result.count);
    expect(result.codeLength).toBeGreaterThan(10000);
    expect(result.codeMatches).toBe(true);
    expect(result.undoMatches).toBe(true);
    console.log('[upgrade-large] contract checks passed; saving');
    const saveStartedAt = Date.now();
    const save = await win.evaluate(async () => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      return realm.projectService.save(undefined, 30_000);
    });
    expect(save.success, JSON.stringify(save)).toBe(true);
    const savedAt = Date.now();
    console.log('[upgrade-large] saved; reopening');
    await win.evaluate(() => { window.location.hash = '#/main/guide'; });
    await expect(win.locator('app-blockly-editor')).toHaveCount(0);
    await observeProgressOnNextEditor(win);
    await openBlocklyProject(win, project);
    await expect.poll(() => win.evaluate(() => document.querySelector('iframe[data-blockly-generator-runtime]')?.getAttribute('data-runtime-ready')), {timeout: 90_000}).toBe('true');
    expect(await win.evaluate(() => (window as any).blocklyWorkspace.getAllBlocks(false).length)).toBe(result.count);
    expect(await win.evaluate(() => {
      const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
      return realm.Arduino.workspaceToCode((window as any).blocklyWorkspace);
    })).toBe(result.code);
    expect(errors).toEqual([]);
    const progress = await win.evaluate(() => (window as any).__largeProgressEvidence);
    expect(progress.mounts).toBe(2);
    // Project loading reports stages in the footer. It has no numeric
    // notification when dependencies are already installed; validate any
    // percentages that genuinely appeared rather than inventing a download.
    expect(progress.invalid).toEqual([]);
    const {code, ...contract} = result;
    const evidence = {...contract, codeSha256: createHash('sha256').update(code).digest('hex'),
      savedAndReopened: true, elapsedMs: Date.now() - started,
      loadMs: loadedAt - started, roundtripAndUndoMs: saveStartedAt - loadedAt,
      saveMs: savedAt - saveStartedAt, reopenMs: Date.now() - savedAt, progress, errors};
    console.log('[upgrade-large] evidence', JSON.stringify(evidence));
    const evidencePath = testInfo.outputPath('large-workspace-contract.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach('large-workspace-contract', {path: evidencePath, contentType: 'application/json'});
    // Electron's compositor capture avoids CDP's extra screenshot/layout pass
    // over this deeply nested SVG. Keep a real rendered-window artifact, not a
    // DOM-only assertion or a skipped screenshot.
    const screenshot = await electronApp.evaluate(async ({BrowserWindow}, url) => {
      const target = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url);
      if (!target) throw new Error('Large-project window is missing');
      const captured = await target.webContents.capturePage();
      return {size: captured.getSize(), png: captured.toPNG().toString('base64')};
    }, win.url());
    expect(screenshot.size.width).toBeGreaterThan(400);
    expect(screenshot.size.height).toBeGreaterThan(300);
    await writeFile(testInfo.outputPath('large-workspace.png'), Buffer.from(screenshot.png, 'base64'));
  } finally {
    await win.evaluate(() => { window.location.hash = '#/main/guide'; }).catch(() => {});
    // A test timeout closes the renderer; do not mask its original failure or
    // strand the disposable project clone when the page has already closed.
    await expect(win.locator('app-blockly-editor')).toHaveCount(0).catch(() => {});
    await closeAilyElectronApp(electronApp);
    await rm(temporary, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
});
