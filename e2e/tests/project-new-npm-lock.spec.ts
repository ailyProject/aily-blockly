import {test, expect, getMainWindow, navigate, launchAilyElectron, readAilyHostOperation} from '../fixtures/electron-app';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('creates an ESP32 project while AppData .aily remains an existing file', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aily-project-npm-lock-'));
  const name = 'npm_lock_regression';
  const project = path.join(temporary, name);
  const defaults = JSON.parse(await readFile(path.resolve(__dirname, '../../electron/config/config.json'), 'utf8'));
  let launched: Awaited<ReturnType<typeof launchAilyElectron>> | undefined;
  try {
    launched = await launchAilyElectron({config: {
      ...defaults, onboardingCompleted: true, metricsEnabled: false, project_path: temporary,
    }});
    const {app, userDataDir} = launched;
    const win = await getMainWindow(app);
    await win.addLocatorHandler(win.locator('.login-modal-wrap app-login .login-close'), button => button.click());
    // Preserve the login-file shape without borrowing credentials or contacting an account.
    const authPath = path.join(userDataDir, '.aily');
    const auth = '{"npmLockRegression":true}\n';
    await writeFile(authPath, auth, {mode: 0o600});
    await app.evaluate(({dialog}, folder) => {
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [folder]});
    }, temporary);
    await navigate(win, '/main/project-new');
    await win.locator('app-project-new .header input[nz-input]').fill('esp32');
    const board = win.locator('app-project-new .board-selector .board.ccenter.btn')
      .filter({has: win.locator('.name', {hasText: /^ESP32 chip$/i})});
    await expect(board).toBeVisible({timeout: 30_000});
    await board.click();
    await win.locator('app-project-new .desc-box .next button').first().click();
    await expect(win.locator('app-project-new input.board[disabled]')).toHaveValue('@aily-project/board-esp32');
    await win.locator('app-project-new .right-content input[nz-input]:not([disabled])').fill(name);
    await win.locator('app-project-new .ant-input-group-addon .btn').click();
    await expect(win.locator('app-project-new nz-input-group input[disabled]:not(.board)')).toHaveValue(temporary + path.sep);
    await win.locator('app-project-new .step-btns button.ant-btn-primary').first().click();
    await expect(win.locator('app-blockly-editor')).toBeVisible({timeout: 120_000});
    await expect.poll(async () => {
      try { return (await readAilyHostOperation(app, 'project_load_status', project)).ready; }
      catch { return false; }
    }, {timeout: 120_000}).toBe(true);
    expect(new URL(win.url().split('#')[1], 'https://test.local').searchParams.get('path')).toBe(project);
    const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    expect(manifest.dependencies['@aily-project/board-esp32']).toBeTruthy();
    expect((await stat(path.join(project, 'project.abi'))).size).toBeGreaterThan(0);
    expect((await stat(path.join(userDataDir, '.aily-npm', 'npm-mutation.lock'))).isFile()).toBe(true);
    expect(await readFile(authPath, 'utf8')).toBe(auth);
    await win.screenshot({path: testInfo.outputPath('created-esp32.png')});
  } finally {
    try { await launched?.close(); }
    finally { await rm(temporary, {recursive: true, force: true, maxRetries: 3, retryDelay: 200}); }
  }
});
