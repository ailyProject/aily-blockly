import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

const { runDependencyWorker } = require('../../electron/library-dependencies');

test('save during an active native build owner commits ABI, defers sources and never replays stale edits', async ({}, info) => {
  const libraries = process.env['AILY_E2E_LIBRARIES'], seed = process.env['AILY_E2E_PLATFORM_SEED'];
  test.skip(!libraries || !seed, 'Requires local library and platform seed roots.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-save-contention-')));
  const project = path.join(root, 'project');
  await mkdir(project);
  const dependencies: Record<string, string> = {};
  for (const folder of ['core-io', 'core-logic', 'core-loop', 'core-math', 'core-serial', 'core-text', 'core-time', 'core-variables', 'board-esp32s3']) {
    const source = folder.startsWith('board-') ? path.join(seed!, 'node_modules/@aily-project', folder) : path.join(libraries!, folder);
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    await cp(source, path.join(project, 'local-libraries', folder), { recursive: true, dereference: true });
    dependencies[pkg.name] = `file:local-libraries/${folder}`;
  }
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'save-contention', version: '1.0.0',
    board: 'ESP32S3', devmode: 'arduino', dependencies }, null, 2));
  await writeFile(path.join(project, 'project.abi'), JSON.stringify({ blocks: { languageVersion: 0, blocks: [
    { type: 'arduino_global', id: 'global', x: 60, y: 40 },
    { type: 'arduino_setup', id: 'setup', x: 60, y: 150, inputs: { ARDUINO_SETUP: { block: {
      type: 'serial_println', id: 'print', fields: { SERIAL: 'Serial' }, inputs: { VAR: { block: {
        type: 'text', id: 'text', fields: { TEXT: 'SAVE_BASELINE' },
      } } },
    } } } },
    { type: 'arduino_loop', id: 'loop', x: 60, y: 300 },
  ] } }));
  await runDependencyWorker(project, { save: true }); await runDependencyWorker(project, {});
  const launched = await launchAilyElectron({ environment: { AILY_E2E_TOOLCHAIN_SEED: seed!, AILY_E2E_TOOLCHAIN_PROJECT: project },
    config: { lang: 'zh_CN', blocklyOnboardingCompleted: true, blockly: { autoSave: false, minimap: false }, compile: { backend: 'local' } } });
  const win = await getMainWindow(launched.app), errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  await win.addLocatorHandler(win.locator('app-login .login-close'), button => button.click());
  const sketch = path.join(project, '.temp/sketch/sketch.ino');
  const change = (text: string) => win.evaluate(text => (window as any).blocklyWorkspace.getBlockById('text').setFieldValue(text, 'TEXT'), text);
  const save = () => win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  const owner = async (acquire: boolean) => launched.app.evaluate(({ app }, { project, acquire }) => {
    const w = globalThis as any;
    if (acquire) {
      const p = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(p.join(app.getAppPath(), 'package.json'));
      const { childScriptPath } = require(p.join(app.getAppPath(), 'electron/child-script-path.js'));
      w.__saveContentionOwner = require(childScriptPath('build-workspace-lease.js')).acquireBuildWorkspace(project, 'preprocess');
    } else { w.__saveContentionOwner?.release(); delete w.__saveContentionOwner; }
  }, { project, acquire });
  try {
    await openBlocklyProject(win, project);
    await expect.poll(async () => (await readAilyHostOperation(launched.app, 'project_load_status', project)).ready).toBe(true);
    await expect.poll(async () => existsSync(sketch) && (await readFile(sketch, 'utf8')).includes('SAVE_BASELINE')).toBe(true);
    const baseline = await readFile(sketch, 'utf8');
    await owner(true);
    const lock = await readFile(path.join(project, '.build/aily-workspace.lock'), 'utf8');
    await change('SAVE_FIRST'); await save();
    await expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'false');
    await expect(win.locator('.ant-message-success')).toContainText('项目已保存');
    await expect(win.locator('.ant-message-error')).toHaveCount(0);
    expect(await readFile(path.join(project, 'project.abi'), 'utf8')).toContain('SAVE_FIRST');
    expect(await readFile(sketch, 'utf8')).toBe(baseline);
    expect(await readFile(path.join(project, '.build/aily-workspace.lock'), 'utf8')).toBe(lock);
    // A later unsaved edit invalidates the queued capture without blocking input.
    await change('SAVE_LATEST');
    await expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'true');
    await owner(false);
    await expect.poll(() => win.evaluate(() => !(window as any).ng.getComponent(document.querySelector('app-blockly-editor'))._projectService.deferredSaveOutputs)).toBe(true);
    expect(await readFile(sketch, 'utf8')).toBe(baseline);
    // The next save supersedes the cancelled capture and publishes when idle.
    await owner(true); await save();
    await expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'false');
    expect(await readFile(sketch, 'utf8')).toBe(baseline);
    await owner(false);
    await expect.poll(async () => (await readFile(sketch, 'utf8')).includes('SAVE_LATEST')).toBe(true);
    expect(await readFile(sketch, 'utf8')).not.toContain('SAVE_FIRST');
    await expect(win.locator('.ant-message-error')).toHaveCount(0);
    expect(errors).toEqual([]);
    await win.screenshot({ path: info.outputPath('saved-after-build-released.png') });
  } finally {
    await owner(false).catch(() => {});
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ root, project, errors }, null, 2));
    await launched.close();
  }
});
