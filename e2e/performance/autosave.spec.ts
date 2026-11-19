import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

test('profiles real idle autosave and renderer responsiveness on a large project', async () => {
  const source = process.env['AILY_AUTOSAVE_PERF_PROJECT'];
  test.skip(!source, 'Provide an installed large Blockly project; only its disposable copy is changed.');
  const label = process.env['AILY_AUTOSAVE_PERF_LABEL'] || 'current';
  const output = path.resolve(process.env['AILY_AUTOSAVE_PERF_OUTPUT'] || 'e2e/performance/test-results/autosave', label);
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-autosave-perf-')));
  const project = path.join(root, 'project');
  const original = await readFile(path.join(source!, 'project.abi'));
  await cp(source!, project, { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE,
    filter: file => !['.git', '.temp', '.build', '.log', '.aily', '.workspace-history', 'project-open.lock'].includes(path.basename(file)) });
  const launched = await launchAilyElectron({ rendererDirectory: process.env['AILY_AUTOSAVE_PERF_RENDERER'],
    environment: { AILY_BUILD_PRODUCT: 'blockly' }, config: {
      selectedLanguage: 'zh_cn', onboardingCompleted: true, blocklyOnboardingCompleted: true,
      blockly: { autoSave: false, minimap: false },
    } });
  const win = await getMainWindow(launched.app);
  const report: any = { label, sourceSha256: createHash('sha256').update(original).digest('hex'), abiBytes: original.length,
    environment: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
      node: process.version, release: os.release(), minimap: false }, rounds: [], errors: [] };
  report.environment.electron = await launched.app.evaluate(() => process.versions.electron);
  const renderer = process.env['AILY_AUTOSAVE_PERF_RENDERER'];
  if (renderer) report.environment.rendererIndexSha256 = createHash('sha256').update(await readFile(path.join(renderer, 'index.html'))).digest('hex');
  win.on('pageerror', error => report.errors.push(error.stack || error.message));
  win.on('console', message => { if (message.type() === 'error' || message.text().includes('Background project save failed:')) { report.errors.push(message.text()); console.log('[renderer-error]', message.text()); } });
  const persist = () => writeFile(path.join(output, 'measurement.json'), JSON.stringify(report, null, 2));
  try {
    await openBlocklyProject(win, project);
    // Saving/editing readiness is independent of optional SDK compilation assets.
    // Keep the native diagnostic as evidence; never fake dependency completion.
    await win.waitForFunction(() => {
      const w = window as any, element = document.querySelector('app-header'), h = element && w.ng?.getComponent(element);
      return w.blocklyWorkspace?.getAllBlocks(false).length > 0 && h?.autoSave?.hooks.ready();
    }, null, { timeout: 240_000 });
    try {
      const status = await readAilyHostOperation(launched.app, 'project_load_status', project);
      report.nativeLoadStatus = { ready: status.ready, phase: status.phase, code: status.code };
    } catch (error) { report.nativeLoadStatus = { error: String(error) }; }
    const login = win.locator('app-login .login-close'); if (await login.isVisible()) await login.click();
    await win.bringToFront();
    await expect.poll(() => win.evaluate(() => {
      const h = (window as any).ng.getComponent(document.querySelector('app-header'));
      return !h.projectService.isProjectDependencyPreparationInProgress(h.projectService.currentProjectPath);
    }), { timeout: 240_000 }).toBe(true);
    await win.waitForTimeout(3000);
    report.initial = await win.evaluate(() => {
      const w = window as any, h = w.ng.getComponent(document.querySelector('app-header'));
      const editor = w.ng.getComponent(document.querySelector('app-blockly-editor')), b = editor.blocklyService;
      w.autosavePerf = { current: null, errors: [] };
      const saveNative = editor._projectService.saveProjectAfterPreprocess;
      editor._projectService.saveProjectAfterPreprocess = async function (...args: any[]) {
        try { return await saveNative.apply(this, args); }
        catch (error: any) { w.autosavePerf.errors.push(error.stack || String(error)); throw error; }
      };
      const wrap = (object: any, key: string, label: string, async: boolean) => {
        const original = object[key]; if (typeof original !== 'function') throw new Error(`Missing ${label}`);
        const done = (sample: any, started: number) => {
          if (!sample) return;
          const metric = sample.calls[label] ||= { count: 0, totalMs: 0, maxMs: 0 }, ms = performance.now() - started;
          metric.count++; metric.totalMs += ms; metric.maxMs = Math.max(metric.maxMs, ms);
        };
        object[key] = async ? async function (...args: any[]) {
          const p = w.autosavePerf.current, started = performance.now();
          try { return await original.apply(this, args); } finally { done(p, started); }
        } : function (...args: any[]) {
          const p = w.autosavePerf.current, started = performance.now();
          try { return original.apply(this, args); } finally { done(p, started); }
        };
      };
      for (const [object, key, label, async] of [
        [b, 'getProjectDocument', 'project-document', false], [b, 'captureProjectSnapshot', 'snapshot-revision', false],
        [b, 'getWorkspaceJson', 'native-serialization', false], [b, 'getProjectAbiForSave', 'abi-clone', false],
        [b, 'normalizeProjectAbi', 'abi-normalize', false], [b, 'prepareProjectCode', 'prepare-code', true],
        [h.projectService, 'hasUnsavedChanges', 'dirty-query', true],
        [editor._projectService, 'prepareSave', 'prepare-save', true],
        [editor._projectService, 'publishPreparedSaveOutputs', 'publish-outputs', true],
      ] as any[]) wrap(object, key, label, async);
      const save = h.projectService.saveInBackground;
      h.projectService.saveInBackground = async function (...args: any[]) {
        const p = w.autosavePerf.current;
        if (p) { p.saveStart = performance.now(); p.saveCalls++; }
        try {
          const result = await save.apply(this, args);
          if (p) p.result = { success: result.success, projectSaved: result.projectSaved, partial: result.partial, code: result.code, error: result.error };
          return result;
        } finally { if (p) { p.saveEnd = performance.now(); p.done = true; } }
      };
      return { blocks: w.blocklyWorkspace.getAllBlocks(false).length, pages: b.pagesSubject.value.length };
    });
    await win.evaluate(async () => {
      await (window as any).ng.getComponent(document.querySelector('app-header')).configService.saveBlocklyPreference('autoSave', true);
    });
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Profiler.enable');
    const rounds = Number(process.env['AILY_AUTOSAVE_PERF_ROUNDS'] || 3);
    for (const kind of ['viewport', 'content']) for (let round = 0; round < rounds; round++) {
      await win.bringToFront(); await win.waitForTimeout(1200);
      await cdp.send('Profiler.start');
      await win.evaluate(({ kind, round }) => {
        const w = window as any, p = w.autosavePerf.current = { kind, round, calls: {}, tasks: [], frames: [], saveCalls: 0,
          started: performance.now(), previous: performance.now(), done: false, active: true };
        p.observer = new PerformanceObserver(list => p.tasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration }))));
        p.observer.observe({ entryTypes: ['longtask'] });
        const frame = (now: number) => { p.frames.push(now - p.previous); p.previous = now; if (p.active) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        if (kind === 'viewport') w.blocklyWorkspace.scroll(w.blocklyWorkspace.scrollX - 15, w.blocklyWorkspace.scrollY - 8);
        else {
          const block = w.blocklyWorkspace.getAllBlocks(false).find((b: any) => b.type === 'math_number' && b.getField('NUM'));
          if (!block) throw new Error('Project needs a numeric field for a semantic edit');
          p.editedBlock = block.id; block.setFieldValue(String(Number(block.getFieldValue('NUM')) + 1), 'NUM');
        }
      }, { kind, round });
      await win.waitForFunction(() => (window as any).autosavePerf.current.done, null, { timeout: 240_000 });
      await win.waitForTimeout(300);
      const measured = await win.evaluate(() => {
        const p = (window as any).autosavePerf.current; p.active = false;
        p.tasks.push(...p.observer.takeRecords().map((e: any) => ({ start: e.startTime, ms: e.duration }))); p.observer.disconnect();
        const percentile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] || 0;
        return { kind: p.kind, round: p.round, saveMs: p.saveEnd - p.saveStart, totalMs: p.saveEnd - p.started,
          saveCalls: p.saveCalls, result: p.result, calls: p.calls, errors: (window as any).autosavePerf.errors,
          maxFrameGapMs: Math.max(0, ...p.frames), p95FrameGapMs: percentile(p.frames, .95),
          maxLongTaskMs: Math.max(0, ...p.tasks.map((t: any) => t.ms)),
          blockingMs: p.tasks.reduce((sum: number, t: any) => sum + Math.max(0, t.ms - 50), 0), longTasks: p.tasks };
      });
      const { profile } = await cdp.send('Profiler.stop');
      await writeFile(path.join(output, `${kind}-${round}.cpuprofile`), JSON.stringify(profile));
      measured.fileBytes = Object.fromEntries(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(async name => [name, await stat(path.join(project, name)).then(s => s.size).catch(() => 0)])));
      measured.abiSha256 = createHash('sha256').update(await readFile(path.join(project, 'project.abi'))).digest('hex');
      report.rounds.push(measured); await persist();
      console.log('[autosave-perf]', JSON.stringify({ kind, round, blocks: report.initial.blocks,
        saveMs: measured.saveMs, maxFrameGapMs: measured.maxFrameGapMs, blockingMs: measured.blockingMs, result: measured.result }));
      expect(measured.result.success, JSON.stringify(measured.result)).toBe(true);
      expect(measured.saveCalls).toBe(1);
    }
    if (process.env['AILY_AUTOSAVE_PERF_INTERACTION'] === '1') {
      await win.evaluate(async () => {
        const w = window as any, h = w.ng.getComponent(document.querySelector('app-header'));
        w.autosavePerf.current = null;
        await h.configService.saveBlocklyPreference('autoSave', false);
        const block = w.blocklyWorkspace.getAllBlocks(false).find((b: any) => b.type === 'math_number' && b.getField('NUM') && b.isEditable());
        w.autosaveInteraction = { id: block.id, value: Number(block.getFieldValue('NUM')), saves: [], inputLag: [], held: false };
        w.blocklyWorkspace.centerOnBlock(block.id);
      });
      await win.waitForTimeout(1000);
      await win.evaluate(() => {
        const w = window as any, p = w.autosaveInteraction, h = w.ng.getComponent(document.querySelector('app-header'));
        const b = w.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
        const acquire = b.acquireWorkspaceEditLease;
        b.acquireWorkspaceEditLease = function (...args: any[]) {
          const lease = acquire.apply(this, args), allow = lease.allowUserEdits;
          if (allow) lease.allowUserEdits = () => { allow(); p.inputReleased = true; };
          return lease;
        };
        const save = h.projectService.saveInBackground;
        h.projectService.saveInBackground = async function (...args: any[]) {
          const entry: any = { started: performance.now() }; p.saves.push(entry);
          try { const result = await save.apply(this, args); entry.success = result.success; entry.error = result.error; return result; }
          finally { entry.finished = performance.now(); }
        };
        const project = w.ng.getComponent(document.querySelector('app-blockly-editor'))._projectService;
        const publish = project.publishPreparedSaveOutputs;
        project.publishPreparedSaveOutputs = async function (...args: any[]) {
          if (!p.held) { p.held = true; await new Promise<void>(resolve => { p.release = resolve; }); }
          return publish.apply(this, args);
        };
        document.addEventListener('pointermove', event => {
          if (p.saves.length === 1 && !p.saves[0].finished) p.inputLag.push(performance.now() - event.timeStamp);
        }, true);
      });
      const edit = await win.evaluate(async () => {
        const w = window as any, h = w.ng.getComponent(document.querySelector('app-header')), p = w.autosaveInteraction;
        await h.configService.saveBlocklyPreference('autoSave', true);
        w.blocklyWorkspace.getBlockById(p.id).setFieldValue(String(p.value + 1), 'NUM');
        return { id: p.id, value: p.value + 2 };
      });
      await win.waitForFunction(() => (window as any).autosaveInteraction.inputReleased === true);
      const background = win.locator('blockly-main .blocklyMainBackground').first(), bounds = (await background.boundingBox())!;
      const viewport = await win.evaluate(() => ({ x: (window as any).blocklyWorkspace.scrollX, y: (window as any).blocklyWorkspace.scrollY }));
      const point = await win.evaluate(bounds => {
        for (const fy of [.85, .65, .45, .25]) for (const fx of [.85, .65, .45, .25]) {
          const x = bounds.x + bounds.width * fx, y = bounds.y + bounds.height * fy;
          const element = document.elementFromPoint(x, y);
          if (element?.classList.contains('blocklyMainBackground')) return { x, y };
        }
        throw new Error('No empty native Blockly canvas point is visible.');
      }, bounds);
      await win.mouse.move(point.x, point.y); await win.mouse.down();
      await win.mouse.move(point.x - 70, point.y - 30, { steps: 20 }); await win.mouse.up();
      expect(await win.evaluate(() => (window as any).blocklyWorkspace.scrollX)).not.toBe(viewport.x);
      const field = await win.evaluate(id => {
        const element = (window as any).blocklyWorkspace.getBlockById(id).getField('NUM').getSvgRoot();
        const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, edit.id);
      const editStarted = Date.now();
      await win.mouse.dblclick(field.x, field.y);
      const input = win.locator('.blocklyHtmlInput'); await expect(input).toBeVisible({ timeout: 2000 });
      await input.fill(String(edit.value)); await input.press('Enter');
      expect(await win.evaluate(id => Number((window as any).blocklyWorkspace.getBlockById(id).getFieldValue('NUM')), edit.id)).toBe(edit.value);
      const nativeEditWallMs = Date.now() - editStarted;
      await win.waitForFunction(() => (window as any).autosaveInteraction.held);
      expect(await win.evaluate(() => Boolean((window as any).autosaveInteraction.saves[0].finished))).toBe(false);
      const spinner = win.locator('app-footer [data-owner="project-auto-save"] .lloading');
      await expect(spinner).toBeVisible();
      const animation = await spinner.locator('.fa-loader').evaluate(element => ({ name: getComputedStyle(element).animationName,
        duration: getComputedStyle(element).animationDuration, state: getComputedStyle(element).animationPlayState }));
      expect(animation.name).not.toBe('none');
      expect(await win.evaluate(() => {
        const w = window as any, component = w.ng.getComponent(document.querySelector('blockly-main'));
        return { writing: component.blocklyService.aiWriting, overlay: component.showSpinOverlay };
      })).toEqual({ writing: false, overlay: false });
      await expect(win.locator('app-header .project-save-status')).toHaveCount(0);
      await expect(win.locator('.ant-message-notice-content').filter({ hasText: /项目保存中|项目已保存/ })).toHaveCount(0);
      await win.screenshot({ path: path.join(output, 'editing-while-saving.png') });
      await win.evaluate(() => (window as any).autosaveInteraction.release());
      await win.waitForFunction(() => {
        const p = (window as any).autosaveInteraction; return p.saves.length === 2 && p.saves.every((s: any) => s.finished);
      }, null, { timeout: 240_000 });
      report.interaction = await win.evaluate(() => {
        const p = (window as any).autosaveInteraction;
        return { id: p.id, value: p.value + 2, saves: p.saves, maxPointerLagMs: Math.max(0, ...p.inputLag), pointerEvents: p.inputLag.length };
      });
      report.interaction.nativeEditWallMs = nativeEditWallMs; report.interaction.spinner = animation;
      const saved = JSON.parse(await readFile(path.join(project, 'project.abi'), 'utf8'));
      const pending: any[] = [saved]; let value: any;
      while (pending.length) { const item = pending.pop(); if (!item || typeof item !== 'object') continue;
        if (item.id === edit.id) { value = item.fields.NUM; break; } pending.push(...Object.values(item)); }
      expect(Number(value)).toBe(edit.value);
      expect(report.interaction.saves.every((s: any) => s.success)).toBe(true);
      await win.waitForTimeout(6000);
      expect(await win.evaluate(() => (window as any).autosaveInteraction.saves.length)).toBe(2);
      await win.reload();
      await win.waitForFunction(() => {
        const w = window as any, element = document.querySelector('app-header'), h = element && w.ng?.getComponent(element);
        return w.blocklyWorkspace?.getAllBlocks(false).length > 0 && h?.autoSave?.hooks.ready();
      }, null, { timeout: 240_000 });
      expect(await win.evaluate(id => Number((window as any).blocklyWorkspace.getBlockById(id).getFieldValue('NUM')), edit.id)).toBe(edit.value);
      report.interaction.reopened = true; await persist();
    }
    await cdp.detach();
  } finally {
    await win.evaluate(() => (window as any).autosaveInteraction?.release?.()).catch(() => {});
    report.sourceUnchanged = (await readFile(path.join(source!, 'project.abi'))).equals(original);
    await persist(); await launched.close(); await rm(root, { recursive: true, force: true });
    expect(report.sourceUnchanged).toBe(true);
  }
});
