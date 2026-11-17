import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, getMainWindow, launchAilyElectron, openBlocklyProject, test } from '../fixtures/electron-app';

test('错误通知查看详情定位磁盘日志，兼容关闭重开、筛选和已有流式输出', async ({}, testInfo) => {
  test.skip(!process.env['AILY_E2E_PROJECT'], 'Set AILY_E2E_PROJECT to an installed Blockly fixture.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'aily-log-navigation-'));
  const project = path.join(root, 'project');
  await cp(process.env['AILY_E2E_PROJECT']!, project, { recursive: true, filter: file =>
    !['.git', '.aily', '.temp', '.build', '.log', 'project-open.lock'].includes(path.basename(file)) });
  const launched = await launchAilyElectron({ config: { blocklyOnboardingCompleted: true } });
  try {
    const win = await getMainWindow(launched.app);
    await openBlocklyProject(win, project);
    await expect(win.locator('app-notification')).toHaveCount(1);
    await expect(win.locator('iframe[data-runtime-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
    const closeLogin = win.locator('.ant-modal-close').first();
    if (await closeLogin.isVisible()) await closeLogin.click();
    await win.evaluate(() => {
      const w = window as any;
      const notice = w.ng.getComponent(document.querySelector('app-notification')).noticeService;
      w.__logNavigation = { notice, logs: notice.logService };
      for (let i = 0; i < 80; i++) notice.logService.update({ title: 'Compile', detail: `before-${i}\n${'line\n'.repeat(i % 5)}`, state: 'info' });
      notice.update({ title: 'Compile error', text: 'Missing symbol', detail: 'navigation-target: missing_symbol\nsource.cpp:42:3', state: 'error' });
      for (let i = 0; i < 650; i++) notice.logService.update({ detail: `after-${i}\n${'line\n'.repeat(i % 6)}`, state: 'info' });
    });
    const view = win.locator('app-notification .btns .btn').first();
    await view.click();
    const focused = win.locator('app-log .item.focused');
    await expect(focused).toContainText('navigation-target');
    const atTop = () => win.evaluate(() => {
      const box = document.querySelector('app-log .log-box')?.getBoundingClientRect();
      const row = document.querySelector('app-log .item.focused')?.getBoundingClientRect();
      return !!box && !!row && Math.abs(row.top - box.top) < 3;
    });
    await expect.poll(atTop).toBe(true);
    await win.locator('.tool-btns .fa-search').click();
    await win.locator('app-log input[type="search"]').fill('not-present');
    await expect(win.locator('app-log .item')).toHaveCount(0);
    await view.click();
    await expect(win.locator('app-log input[type="search"]')).toHaveValue('');
    await expect.poll(atTop).toBe(true);
    await win.screenshot({ path: testInfo.outputPath('notification-log-focused.png') });

    await win.locator('.tool-btns .fa-xmark').click();
    await expect(win.locator('app-log')).toHaveCount(0);
    await view.click();
    await expect.poll(atTop).toBe(true);

    await win.evaluate(() => {
      const { logs, notice } = (window as any).__logNavigation;
      logs.update({ title: 'Compile', detail: 'streamed-failure-target', state: 'error' });
      notice.update({ title: 'Compile failed', detail: 'streamed-failure-target', state: 'error', sendToLog: false });
      for (let i = 0; i < 30; i++) logs.update({ detail: `later-${i}`, state: 'info' });
    });
    await view.click();
    await expect(focused).toContainText('streamed-failure-target');
    await expect.poll(atTop).toBe(true);
    const page = await win.evaluate(async () => (window as any).__logNavigation.logs.readPage({ mode: 'tail', limit: 100 }));
    expect(page.entries.filter((entry: { detail: string }) => entry.detail === 'streamed-failure-target')).toHaveLength(1);
  } finally {
    await launched.close();
    await rm(root, { recursive: true, force: true });
  }
});
