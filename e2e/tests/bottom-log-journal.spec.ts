import { test, expect } from '../fixtures/electron-app';
import fs from 'node:fs';
import path from 'node:path';

test('底部日志从后台文件增量显示，并支持搜索和清空', async ({ mainWindow, electronApp }) => {
  // A fresh isolated profile can show the login modal. Open the log pane without account access.
  await mainWindow.evaluate(() => (document.querySelector('app-footer .btn') as HTMLElement)?.click());
  await expect(mainWindow.locator('app-log .log-box')).toBeVisible();

  const marker = `journal-e2e-${Date.now()}`;
  const response = await mainWindow.evaluate(async (detail) => {
    const ipc = (window as any).electronAPI.ipcRenderer;
    return await ipc.invoke('window-send', {
      to: 'main',
      data: { action: 'log', log: { title: 'Journal', detail, state: 'error' } },
    });
  }, marker);
  expect(response).toMatchObject({ success: true });
  await expect(mainWindow.locator('app-log .item .text')).toContainText(marker);

  const diskPage = await mainWindow.evaluate(async () => {
    return await (window as any).electronAPI.ipcRenderer.invoke('bottom-log:read', {
      streamId: 'main', options: { mode: 'tail', limit: 20 },
    });
  });
  expect(diskPage.entries.some((item: { detail: string }) => item.detail === marker)).toBe(true);
  const appDataPath = await electronApp.evaluate(() => process.env['AILY_APPDATA_PATH']);
  const sessionDir = path.join(appDataPath!, 'logs', 'bottom-panel');
  const session = fs.readdirSync(sessionDir).find(name => fs.existsSync(path.join(sessionDir, name, 'main-0.jsonl')));
  expect(session).toBeTruthy();
  expect(fs.readFileSync(path.join(sessionDir, session!, 'main-0.jsonl'), 'utf8')).toContain(marker);

  await mainWindow.evaluate(async () => {
    const ipc = (window as any).electronAPI.ipcRenderer;
    for (let i = 0; i < 600; i++) {
      await ipc.invoke('window-send', {
        to: 'main',
        data: { action: 'log', log: { detail: `burst-${i}`, state: 'info' } },
      });
    }
  });
  await expect(mainWindow.locator('app-log .item .text').last()).toContainText('burst-599');
  const lines = fs.readFileSync(path.join(sessionDir, session!, 'main-0.jsonl'), 'utf8').trim().split('\n');
  expect(lines.length).toBeGreaterThanOrEqual(601);

  await mainWindow.evaluate(() => (document.querySelector('.tool-btns .fa-search') as HTMLElement)?.click());
  await mainWindow.locator('app-log input[type="search"]').fill(marker);
  await expect(mainWindow.locator('app-log .item')).toHaveCount(1);
  await mainWindow.locator('app-log input[type="search"]').fill('not-present-in-journal');
  await expect(mainWindow.locator('app-log .item')).toHaveCount(0);

  await mainWindow.evaluate(() => (document.querySelector('.tool-btns .fa-broom-wide') as HTMLElement)?.click());
  const cleared = await mainWindow.evaluate(async () => {
    return await (window as any).electronAPI.ipcRenderer.invoke('bottom-log:read', {
      streamId: 'main', options: { mode: 'tail', limit: 20 },
    });
  });
  expect(cleared.entries).toHaveLength(0);
});
