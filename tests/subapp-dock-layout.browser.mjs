import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Start the host development server, then run:
// npm --prefix tests run test:subapp-dock-layout
// Only local component state is seeded. No login, project, AI, or hardware is
// used; conversation and Dock backends may show their unavailable overlays.
const output = fileURLToPath(new URL('./.artifacts/subapp-dock-layout/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));

async function geometry() {
  return page.evaluate(() => {
    const rect = selector => {
      const { left, right, width } = document.querySelector(selector).getBoundingClientRect();
      return { left, right, width };
    };
    return {
      panel: rect('nz-sider'), dock: rect('app-subapp-activity-dock'),
      conversation: rect('.iframe-shell'), stored: localStorage.getItem('aily-main-window.right-sider-width'),
    };
  });
}

async function settled(width) {
  await page.waitForFunction(expected =>
    Math.abs(document.querySelector('nz-sider').getBoundingClientRect().width - expected) < 1, width);
  // Wait for the existing Dock width transition before measuring its children.
  await page.locator('app-subapp-activity-dock').evaluate(element =>
    Promise.all(element.getAnimations().map(animation => animation.finished)));
}

async function activity(tool, state = 'expanded') {
  await page.evaluate(({ tool, state }) => {
    window.chat.subappActivityService.recordInvocationStarted({
      sessionId: 'layout-test', toolId: tool, toolName: 'layout',
      presentation: { mode: 'dock', surface: 'compact', autoOpen: 'never' },
    });
    window.chat.subappActivityService.setSurfaceState('layout-test', tool, state);
    window.chat.cdr.detectChanges();
  }, { tool, state });
}

try {
  await page.goto(process.env.AILY_DEV_URL || 'http://localhost:4200', { waitUntil: 'networkidle' });
  for (const text of ['稍后登录', '跳过']) {
    const button = page.getByText(text, { exact: true });
    if (await button.count()) await button.first().click();
  }
  await page.evaluate(() => {
    window.shell = ng.getComponent(document.querySelector('app-main-window'));
    window.shell.configService.data.regions = { cn: { api_server: '' } };
    window.shell.uiService.openToolList = ['aily-chat'];
    window.shell.showRbox = true;
    window.shell.cd.detectChanges();
  });
  await page.locator('app-child-tool-host').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    window.chat = ng.getComponent(document.querySelector('app-child-tool-host'));
    window.chat.resolvedToolId = 'aily-chat';
    window.chat.ailyChatSessionId = 'layout-test';
    window.chat.cdr.detectChanges();
  });
  await page.locator('app-subapp-activity-dock').waitFor({ state: 'attached' });

  const baseline = await geometry();
  await activity('layout-one');
  await settled(770);
  const opened = await geometry();
  assert.equal(baseline.conversation.width, 450);
  assert.equal(opened.conversation.width, baseline.conversation.width);
  assert.equal(opened.panel.left, baseline.panel.left - 320);
  assert.equal(opened.panel.right, baseline.panel.right);
  assert.equal(opened.stored, baseline.stored);

  await activity('layout-two');
  await settled(770);
  await activity('layout-one', 'collapsed');
  await settled(770); // One remaining card still occupies one Dock column.

  const handle = await page.locator('.toolbox-pane__resize-handle--left').boundingBox();
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 500, y, { steps: 10 });
  await page.mouse.up();
  await settled(720);
  const minimum = await geometry();
  assert.equal(minimum.conversation.width, 400);
  assert.equal(minimum.stored, '400');

  const dockHandle = await page.locator('.subapp-dock > nz-resize-handle').boundingBox();
  // The Dock clips the outside half of its right-edge handle.
  const dockX = dockHandle.x + 1;
  const dockY = dockHandle.y + dockHandle.height / 2;
  await page.mouse.move(dockX, dockY);
  await page.mouse.down();
  await page.mouse.move(dockX + 240, dockY, { steps: 10 });
  await page.mouse.up();
  await settled(880);
  assert.equal((await geometry()).conversation.width, 400);
  assert.equal((await geometry()).stored, '400');

  await page.evaluate(() => { window.shell.uiService.openToolList.push('code-viewer'); window.shell.cd.detectChanges(); });
  await settled(400);
  await page.evaluate(() => { window.shell.uiService.openToolList.pop(); window.shell.cd.detectChanges(); });
  await settled(880);
  await page.evaluate(() => { window.chat.ailyChatSessionId = 'empty-session'; window.chat.cdr.detectChanges(); });
  await settled(400);
  await page.evaluate(() => { window.chat.ailyChatSessionId = 'layout-test'; window.chat.cdr.detectChanges(); });
  await settled(880);
  await page.screenshot({ path: `${output}/expanded.png` });
  await activity('layout-two', 'collapsed');
  await settled(400);
  assert.equal((await geometry()).conversation.width, 400);
  assert.deepEqual(errors, []);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.evaluate(() => ng.getComponent(document.querySelector('app-main-window')).siderWidth), 400);
  const report = {
    ok: true, baseline, opened, minimum,
    checks: ['expand-left', 'conversation-minimum', 'outer-resize', 'dock-resize', 'multiple-cards',
      'tool-switch', 'session-switch', 'collapse', 'persist-content-width', 'reload'],
    pageErrors: errors,
  };
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error(await geometry().catch(() => ({ pageErrors: errors })));
  throw error;
} finally {
  await browser.close();
}
