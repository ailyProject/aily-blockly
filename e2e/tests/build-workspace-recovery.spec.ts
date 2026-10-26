import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {TestInfo} from '@playwright/test';
import {expect, getMainWindow, launchAilyElectron, openBlocklyProject, readAilyHostOperation, ROOT, test} from '../fixtures/electron-app';

async function seedProject(info: TestInfo): Promise<{project: string; seed: string}> {
  const seed = process.env['AILY_E2E_PLATFORM_SEED'];
  test.skip(!seed, 'Set AILY_E2E_PLATFORM_SEED to installed platform assets.');
  const project = info.outputPath('project');
  const board = '@aily-project/board-stm32f103c8';
  await cp(path.join(seed!, 'node_modules', board, 'template'), project, {recursive: true});
  const pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies)) {
    const target = path.join(project, 'node_modules', name);
    await mkdir(path.dirname(target), {recursive: true});
    const source = path.join(name === board ? seed! : process.env['AILY_E2E_LIBRARY_SEED'] || seed!, 'node_modules', name);
    await cp(source, target, {recursive: true, dereference: true});
  }
  return {project, seed: seed!};
}

for (const operation of ['publish', 'compile']) test(`issue 745: interrupted ${operation} and recovery survive editor reopen and compile`, async ({}, info) => {
  const {project, seed} = await seedProject(info);
  const crashed = spawnSync(process.execPath, ['-e',
    `require(process.argv[1]).acquireBuildWorkspace(process.argv[2], process.argv[3]); process.kill(process.pid, 'SIGKILL');`,
    path.join(ROOT, 'child/scripts/build-workspace-lease.js'), project, operation], {encoding: 'utf8'});
  expect(crashed.signal).toBe('SIGKILL');
  if (process.env['AILY_ISSUE745_BASELINE'] !== '1') {
    // Kill the next process immediately after installing its recovered owner.
    const interruptedRecovery = spawnSync(process.execPath, ['-e',
      `const fs=require('node:fs'),rename=fs.renameSync;
       fs.renameSync=(...args)=>{const result=rename(...args);
         if(String(args[1]).endsWith('aily-workspace.lock'))process.kill(process.pid,'SIGKILL');return result};
       require(process.argv[1]).acquireBuildWorkspace(process.argv[2], process.argv[3]);`,
      path.join(ROOT, 'child/scripts/build-workspace-lease.js'), project, operation], {encoding: 'utf8'});
    expect(interruptedRecovery.signal).toBe('SIGKILL');
  }
  const marker = path.join(project, '.build/aily-workspace.lock');
  const abandoned = await readFile(marker, 'utf8');
  const launch = await launchAilyElectron({
    environment: {AILY_E2E_TOOLCHAIN_SEED: seed!, AILY_E2E_TOOLCHAIN_PROJECT: project},
    config: {selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: {backend: 'local'}},
  });
  const win = await getMainWindow(launch.app);
  const errors: string[] = [];
  win.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  win.on('pageerror', error => errors.push(error.message));
  const generate = () => win.evaluate(async project => {
    const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
    try {
      const saved = await realm.projectService.save(project, 30_000);
      return {code: realm.Arduino.workspaceToCode((window as any).blocklyWorkspace), error: saved.success ? '' : JSON.stringify(saved)};
    }
    catch (error) { return {code: '', error: String(error)}; }
  }, project);
  try {
    const attempts = [];
    for (let index = 0; index < 2; index++) {
      await openBlocklyProject(win, project);
      await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, {timeout: 90_000});
      await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace?.getAllBlocks(false).length)).toBe(3);
      await expect.poll(async () => (await readAilyHostOperation(launch.app, 'project_load_status', project)).ready, {timeout: 90_000}).toBe(true);
      attempts.push(await generate());
      if (process.env['AILY_ISSUE745_BASELINE'] === '1') {
        await expect.poll(() => errors.filter(error => error.includes('BUILD_WORKSPACE_RECOVERY_REQUIRED')).length).toBeGreaterThan(index);
      }
      if (index === 0) {
        const closed = await win.evaluate(async () => {
          const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
          return realm.projectService.close();
        });
        expect(closed).toBe(true);
        await expect(win.locator('app-blockly-editor')).toHaveCount(0);
      }
    }
    await writeFile(info.outputPath('reopen-evidence.json'), JSON.stringify({abandoned: JSON.parse(abandoned.split('\n')[0]), attempts, errors}, null, 2));
    await win.screenshot({path: info.outputPath('reopened.png')});
    if (process.env['AILY_ISSUE745_BASELINE'] === '1') {
      expect(errors.filter(error => error.includes('BUILD_WORKSPACE_RECOVERY_REQUIRED')).length).toBeGreaterThanOrEqual(2);
      expect(await readFile(marker, 'utf8')).toBe(abandoned);
      return;
    }
    for (const attempt of attempts) { expect(attempt.error).toBe(''); expect(attempt.code).toContain('void setup()'); }
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(path.join(project, '.aily/build-workspace.guard'), 'utf8')).toBe('');
    expect(existsSync(path.join(project, '.build/aily-workspace-recovery.lock'))).toBe(false);
    // A native pointer gesture and save exercise the normal editor change chain.
    await expect(win.locator('.blockly-spin')).toHaveCount(0);
    await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('arduino_setup_id0').getSvgRoot().setAttribute('data-recovery-drag', 'setup'));
    const block = win.locator('[data-recovery-drag="setup"] .blocklyText').first();
    const box = await block.boundingBox(); expect(box).toBeTruthy();
    const beforeDrag = await win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('arduino_setup_id0').getRelativeToSurfaceXY().x);
    await win.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await win.mouse.down();
    await win.mouse.move(box!.x + 120, box!.y + 60, {steps: 12});
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.isDragging())).toBe(true);
    await win.mouse.up();
    await expect.poll(() => win.evaluate(() => (window as any).blocklyWorkspace.getBlockById('arduino_setup_id0').getRelativeToSurfaceXY().x)).not.toBe(beforeDrag);
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect.poll(async () => (await readFile(path.join(project, '.temp/sketch/sketch.ino'), 'utf8')).includes('void setup()')).toBe(true);
    await expect.poll(async () => (await readAilyHostOperation(launch.app, 'project_load_status', project)).ready, {timeout: 90_000}).toBe(true);
    await win.locator('app-header app-act-btn[data-action="compile"]').click();
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).buildInfo?.lastBuildStatus; }
      catch { return null; }
    }, {timeout: 180_000}).toBe('success');
    await win.screenshot({path: info.outputPath('compiled.png')});
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(project, '.build/aily-workspace-recovery.lock'))).toBe(false);
    expect(existsSync(path.join(project, '.build/sketch.elf'))).toBe(true);
    expect(existsSync(path.join(project, '.build/sketch.bin'))).toBe(true);
    expect(errors.filter(error => /BUILD_WORKSPACE_|Code generation error/.test(error))).toEqual([]);
  } finally {
    await writeFile(info.outputPath('renderer-errors.json'), JSON.stringify(errors, null, 2));
    await launch.close();
  }
});

test('issue 745: a surviving delegated process stays protected and save reports the incomplete code update', async ({}, info) => {
  test.skip(process.env['AILY_ISSUE745_BASELINE'] === '1', 'New recovery diagnostics are not part of the old baseline.');
  const {project, seed} = await seedProject(info);
  const pidFile = path.join(project, 'descendant.pid');
  const crashed = spawnSync(process.execPath, ['-e', `
    const owner=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
      {env:owner.childEnvironment(),detached:true,stdio:'ignore',windowsHide:true});
    child.unref();require('node:fs').writeFileSync(process.argv[3],String(child.pid));
    process.kill(process.pid,'SIGKILL');`, path.join(ROOT, 'child/scripts/build-workspace-lease.js'), project, pidFile],
  {encoding: 'utf8', timeout: 10000});
  const descendant = Number(await readFile(pidFile, 'utf8'));
  let launch: Awaited<ReturnType<typeof launchAilyElectron>> | undefined;
  const attempts: unknown[] = [];
  const marker = path.join(project, '.build/aily-workspace.lock');
  let abandoned = '';
  try {
    expect(crashed.signal).toBe('SIGKILL');
    abandoned = await readFile(marker, 'utf8');
    launch = await launchAilyElectron({
      environment: {AILY_E2E_TOOLCHAIN_SEED: seed, AILY_E2E_TOOLCHAIN_PROJECT: project},
      config: {selectedLanguage: 'zh_cn', blocklyOnboardingCompleted: true, compile: {backend: 'local'}},
    });
    const win = await getMainWindow(launch.app);
    for (let index = 0; index < 2; index++) {
      await openBlocklyProject(win, project);
      await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, {timeout: 90_000});
      await expect.poll(async () => (await readAilyHostOperation(launch!.app, 'project_load_status', project)).ready, {timeout: 90_000}).toBe(true);
      const saved = await win.evaluate(async project => {
        const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
        return realm.projectService.save(project, 30_000);
      }, project);
      attempts.push(saved);
      expect(saved.success).toBe(false);
      expect(saved.error).toContain('Project file saved, but generated code could not be updated.');
      expect(saved.error).toContain('Restart the computer');
      expect(await readFile(marker, 'utf8')).toBe(abandoned);
      expect(() => process.kill(descendant, 0)).not.toThrow();
      expect(JSON.parse(await readFile(path.join(project, 'project.abi'), 'utf8'))).toBeTruthy();
      if (index === 0) {
        expect(await win.evaluate(async () => {
          const realm = (document.querySelector('iframe[data-blockly-generator-runtime]') as HTMLIFrameElement).contentWindow as any;
          return realm.projectService.close();
        })).toBe(true);
        await expect(win.locator('app-blockly-editor')).toHaveCount(0);
      }
    }
    await win.screenshot({path: info.outputPath('protected.png')});
  } finally {
    try {
      await writeFile(info.outputPath('protected-evidence.json'), JSON.stringify({abandoned: abandoned ? JSON.parse(abandoned) : null, descendant, attempts}, null, 2));
    } finally {
      try { await launch?.close(); }
      finally {
        try { process.kill(descendant, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    }
  }
});
