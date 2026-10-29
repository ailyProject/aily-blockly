import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, test } from '../fixtures/electron-app';

test('native quit: cancel, X and Escape remain usable; skip exits with a missing manifest', async ({}, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-close-missing-manifest-'));
  const project = path.join(root, 'recovered-project');
  await mkdir(project);
  await writeFile(path.join(project, 'project.abi'), '{}');
  const launched = await launchAilyElectron({ config: { lang: 'zh_CN', onboardingCompleted: true, blocklyOnboardingCompleted: true } });
  const electronProcess = launched.app.process();
  const win = await getMainWindow(launched.app);
  const errors: string[] = [];
  win.on('pageerror', error => errors.push(error.message));
  try {
    await expect.poll(() => win.evaluate(() => Boolean((window as any).ng?.getComponent(document.querySelector('app-header'))))).toBe(true);
    // Finish the unauthenticated startup prompt before opening a quit modal.
    const loginClose = win.locator('app-login .login-close');
    await loginClose.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    if (await loginClose.isVisible()) await loginClose.click();
    // Fault injection only: represent an already admitted/recovered workspace
    // whose package.json disappeared. Dirty check, IPC, modal and quit are real.
    await win.evaluate(project => {
      const header = (window as any).ng.getComponent(document.querySelector('app-header'));
      header.projectService.currentProjectPathSubject._value = project;
      header.projectService.stateSubject._value = 'loaded';
    }, project);
    const dialog = win.locator('app-unsave-dialog');
    const quit = () => launched.app.evaluate(({ app }) => { app.quit(); });
    for (const action of ['取消', 'X', 'Escape']) {
      await quit();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('无法确认保存状态');
      await expect(dialog).toContainText('package.json');
      await dialog.evaluate(element => {
        (window as any).ng.getComponent(element).modal.getBackdropElement()?.setAttribute('data-unsaved-close-backdrop', 'true');
      });
      if (action === 'X') await dialog.locator('.close').click();
      else if (action === 'Escape') await win.keyboard.press('Escape');
      else await dialog.getByRole('button', { name: action, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(electronProcess.exitCode).toBeNull();
      await expect(win.locator('[data-unsaved-close-backdrop]')).toHaveCount(0);
    }
    await quit();
    await expect(dialog).toBeVisible();
    await win.screenshot({ path: info.outputPath('missing-manifest-close.png') });
    await dialog.getByRole('button', { name: '跳过保存', exact: true }).click();
    await expect.poll(() => electronProcess.exitCode, { timeout: 20_000 }).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    // Leave no fake workspace active if an assertion fails before normal exit.
    await win.evaluate(() => {
      const header = (window as any).ng?.getComponent(document.querySelector('app-header'));
      if (header) { header.projectService.currentProjectPathSubject._value = ''; header.projectService.stateSubject._value = 'default'; }
    }).catch(() => {});
    await launched.close();
    await rm(root, { recursive: true, force: true });
  }
});
