import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, test } from '../fixtures/electron-app';

const { runDependencyWorker } = require('../../electron/library-dependencies');

test('all eleven real digit-prefixed library blocks save and reopen with their fields, models and connections', async ({}, info) => {
  const libraries = process.env['AILY_E2E_LIBRARIES'], seed = process.env['AILY_E2E_PLATFORM_SEED'];
  test.skip(!libraries || !seed, 'Requires local library and platform seed roots.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aily-shiftregister-save-')));
  const project = path.join(root, 'project');
  await mkdir(project);
  const dependencies: Record<string, string> = {};
  for (const folder of ['core-io', 'core-logic', 'core-loop', 'core-math', 'core-serial', 'core-text', 'core-time', 'core-variables', '74HC595', 'sparkfun_5p49v60', 'board-esp32s3']) {
    const source = folder.startsWith('board-') ? path.join(seed!, 'node_modules/@aily-project', folder) : path.join(libraries!, folder);
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    await cp(source, path.join(project, 'local-libraries', folder), { recursive: true, dereference: true });
    dependencies[pkg.name] = `file:local-libraries/${folder}`;
  }
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'shiftregister-save', version: '1.0.0',
    board: 'ESP32S3', devmode: 'arduino', dependencies }, null, 2));
  await writeFile(path.join(project, 'project.abi'), JSON.stringify({ blocks: { languageVersion: 0, blocks: [
    { type: 'arduino_global', id: 'global', x: 60, y: 40 },
    { type: 'arduino_setup', id: 'setup', x: 60, y: 150 },
    { type: 'arduino_loop', id: 'loop', x: 60, y: 400 },
  ] } }));
  await runDependencyWorker(project, { save: true }); await runDependencyWorker(project, {});
  const launched = await launchAilyElectron({ environment: { AILY_E2E_TOOLCHAIN_SEED: seed!, AILY_E2E_TOOLCHAIN_PROJECT: project },
    config: { lang: 'zh_CN', blocklyOnboardingCompleted: true, blockly: { autoSave: false, minimap: false }, compile: { backend: 'local' } } });
  const win = await getMainWindow(launched.app), errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  await win.addLocatorHandler(win.locator('app-login .login-close'), button => button.click());
  const snapshot = () => win.evaluate(() => {
    const w = window as any;
    return JSON.parse(JSON.stringify(w.Blockly.serialization.workspaces.save(w.Blockly.getMainWorkspace())));
  });
  try {
    await openBlocklyProject(win, project);
    await expect.poll(async () => (await readAilyHostOperation(launched.app, 'project_load_status', project)).ready).toBe(true);
    await win.evaluate(() => {
      const w = window as any, Blockly = w.Blockly, workspace = Blockly.getMainWorkspace();
      workspace.getVariableMap().createVariable('hc1', 'HC', 'hc-model');
      const variable = { id: 'hc-model' };
      const number = (id: string, value: number) => ({ shadow: { type: 'math_number', id, fields: { NUM: value } } });
      const appendChain = (states: any[]) => {
        const blocks = states.map(state => Blockly.serialization.blocks.append(state, workspace));
        blocks.slice(0, -1).forEach((block, index) => block.nextConnection.connect(blocks[index + 1].previousConnection));
        return blocks[0];
      };
      const chain = appendChain([
        { type: '74hc595_create', id: 'hc-create', fields: { VAR: 'hc1', HCDATA_PIN: '4', HCCLOCK_PIN: '5', HCLATCH_PIN: '6' }, inputs: { HCNUMBER: number('hc-count', 2) } },
        { type: '74hc595_set', id: 'hc-set', fields: { VAR: variable, VALUE: 'HIGH' }, inputs: { HCPIN: number('hc-pin', 3) } },
        { type: '74hc595_setAll', id: 'hc-all', fields: { VAR: variable, ALLSTATE: 'Low' } },
        { type: '74hc595_setAllBin', id: 'hc-bin', fields: { VAR: variable, HCARRAY: 'hcBytes' } },
        { type: '74hc595_getstate', id: 'hc-get', fields: { VAR: variable }, inputs: { HCOUTPSTATE: number('hc-output', 7) } },
      ]);
      workspace.getBlockById('setup').getInput('ARDUINO_SETUP').connection.connect(chain.previousConnection);
      workspace.getVariableMap().createVariable('clockGen', '5P49V60', 'clock-model');
      const clockVar = { id: 'clock-model' };
      const clock = appendChain([
        { type: '5p49v60_init', id: 'clock-init', fields: { VAR: 'clockGen', ADDRESS: 'ALT' } },
        { type: '5p49v60_set_vco', id: 'clock-vco', fields: { VAR: clockVar }, inputs: { FREQ: number('clock-vco-freq', 1200) } },
        { type: '5p49v60_mux_pll_to_fod', id: 'clock-mux', fields: { VAR: clockVar, CHANNEL: '2' } },
        { type: '5p49v60_set_clock_freq', id: 'clock-freq', fields: { VAR: clockVar, CHANNEL: '3' }, inputs: { FREQ: number('clock-frequency', 24) } },
        { type: '5p49v60_set_clock_mode', id: 'clock-mode', fields: { VAR: clockVar, CHANNEL: '4', MODE: '3' } },
        { type: '5p49v60_skew_clock', id: 'clock-skew', fields: { VAR: clockVar, CHANNEL: '1' }, inputs: { SKEW: number('clock-skew-value', 5) } },
      ]);
      workspace.getBlockById('hc-get').nextConnection.connect(clock.previousConnection);
    });
    await expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'true');
    const before = await snapshot();
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'false');
    await expect(win.locator('.ant-message-success').filter({ hasText: '项目已保存' })).toHaveCount(1);
    await expect(win.locator('.ant-message-error')).toHaveCount(0);
    const savedAbs = await readFile(path.join(project, 'project.abs'), 'utf8');
    for (const type of ['74hc595_create', '74hc595_set', '74hc595_setAll', '74hc595_setAllBin', '74hc595_getstate',
      '5p49v60_init', '5p49v60_set_vco', '5p49v60_mux_pll_to_fod', '5p49v60_set_clock_freq', '5p49v60_set_clock_mode', '5p49v60_skew_clock']) {
      expect(savedAbs).toContain(`${type}(`);
    }
    const savedAbi = await readFile(path.join(project, 'project.abi'), 'utf8');
    expect(savedAbi).toContain('hcBytes');
    await win.reload({ waitUntil: 'domcontentloaded' });
    await win.locator('app-blockly-editor').waitFor();
    await expect.poll(async () => (await readAilyHostOperation(launched.app, 'project_load_status', project)).ready).toBe(true);
    expect(await snapshot()).toEqual(before);
    await win.evaluate(() => {
      const workspace = (window as any).Blockly.getMainWorkspace();
      workspace.getBlockById('hc-pin').setFieldValue(9, 'NUM');
      workspace.getBlockById('clock-frequency').setFieldValue(32, 'NUM');
    });
    await expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'true');
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect(win.locator('app-header .project-box')).toHaveAttribute('data-unsaved', 'false');
    const second = await snapshot();
    await win.reload({ waitUntil: 'domcontentloaded' });
    await win.locator('app-blockly-editor').waitFor();
    await expect.poll(async () => (await readAilyHostOperation(launched.app, 'project_load_status', project)).ready).toBe(true);
    expect(await snapshot()).toEqual(second);
    await expect(win.locator('.ant-message-error')).toHaveCount(0);
    expect(errors).toEqual([]);
    await win.screenshot({ path: info.outputPath('shiftregister-saved-reopened.png') });
  } finally {
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ root, project, errors }, null, 2));
    await launched.close();
  }
});
