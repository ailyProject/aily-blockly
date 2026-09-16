import { test, expect, getMainWindow, openBlocklyProject } from '../fixtures/electron-app';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Use a disposable copy of the NLCS11 reproduction; never repair the input project.
const SOURCE = process.env['AILY_E2E_LIBRARY_RECOVERY_PROJECT'];
const LIBRARY = '@aily-project/lib-emakefun-nlcs11';

test('bad library opens with a red badge and recovers after repairing its generator', async ({ electronApp }, testInfo) => {
  test.skip(!SOURCE, 'Set AILY_E2E_LIBRARY_RECOVERY_PROJECT to the NLCS11 reproduction project.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-library-recovery-e2e-'));
  const project = path.join(root, 'project');
  await cp(SOURCE!, project, {
    recursive: true, dereference: true,
    filter: source => !['project-open.lock', '.temp', '.build', '.log', '.workspace-history'].includes(path.basename(source)),
  });
  const generatorFile = path.join(project, 'node_modules', ...LIBRARY.split('/'), 'generator.js');
  // The reproduction also contains a misspelled generator method.
  const originalGenerator = (await readFile(generatorFile, 'utf8'))
    .replace(/^asd\s*$/m, '').replace(/\baddLibraary\b/g, 'addLibrary');
  await writeFile(generatorFile, `const recoveryProbe = 1;\nmissingRecoveryProbe;\n${originalGenerator}`);
  const win = await getMainWindow(electronApp);
  win.on('pageerror', error => console.log('[recovery-pageerror]', error.message));
  win.on('console', message => {
    if (message.type() === 'error') console.log('[recovery-console]', message.text().slice(0, 1000));
  });
  try {
    await openBlocklyProject(win, project);
    const badLibrary = win.getByRole('button', { name: /NLCS11/ });
    await expect(badLibrary.locator('.toolbox-item__load-error-badge')).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveAttribute('data-runtime-project-path', project);
    const readBlockIds = () => win.evaluate(() => {
      const realm = document.querySelector<HTMLIFrameElement>('iframe[data-blockly-generator-runtime]')!.contentWindow as any;
      return realm.Blockly.getMainWorkspace().getAllBlocks(false).map((b: any) => b.id).sort();
    });
    const before = await readBlockIds();
    expect(before.length).toBeGreaterThan(5);
    await win.getByRole('button', { name: /数学/ }).click();
    await expect(win.locator('.blocklyFlyout:visible').first()).toBeVisible();
    await badLibrary.click();
    const notice = win.locator('app-notification');
    await expect(notice).toContainText('missingRecoveryProbe');
    await expect(notice).toContainText('AI处理');
    await expect(notice).toContainText('重试');
    await win.screenshot({ path: testInfo.outputPath('library-failure.png') });
    expect(await readBlockIds()).toEqual(before);

    await writeFile(generatorFile, `const recoveryProbe = 2;\n${originalGenerator}`);
    await badLibrary.click();
    await expect(badLibrary).toBeVisible();
    await expect(badLibrary.locator('.toolbox-item__load-error-badge')).toHaveCount(0);
    await expect(notice).toContainText('库加载成功');
    expect(await readBlockIds()).toEqual(before);
    const code = await win.evaluate(() => {
      const realm = document.querySelector<HTMLIFrameElement>('iframe[data-blockly-generator-runtime]')!.contentWindow as any;
      return realm.Arduino.workspaceToCode(realm.Blockly.getMainWorkspace());
    });
    expect(code).toContain('color_sensor_nlcs11.h');
    expect(code).toContain('Serial');
    await win.screenshot({ path: testInfo.outputPath('library-recovered.png') });
  } finally {
    await win.screenshot({ path: testInfo.outputPath('final-state.png') }).catch(() => {});
    console.log('[recovery-final-state]', win.url(), (await win.locator('body').innerText().catch(() => '')).slice(-2500));
    await win.evaluate(() => { window.location.hash = '#/main/guide'; }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
