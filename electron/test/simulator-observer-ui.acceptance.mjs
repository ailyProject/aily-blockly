import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, expect } = require('@playwright/test');
const { readObserverDocument } = require('../subapp-native-observer');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-observer-ui-'));
const pkg = path.join(root, 'node_modules/@aily-project/subapp-simulator-debugger');
fs.mkdirSync(path.dirname(pkg), { recursive: true });
fs.symlinkSync(path.resolve('..', 'aily-subapp/packages/simulator-debugger'), pkg, process.platform === 'win32' ? 'junction' : 'dir');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 980, height: 780 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<iframe sandbox="allow-scripts" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>');
  await page.evaluate(html => {
    window.stops = [];
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe').contentWindow || event.data.type !== 'stop') return;
      window.stops.push(event.data);
      event.source.postMessage({ channel: 'aily-native-observer-v1', type: 'stop-result', id: event.data.id, result: { ok: true } }, '*');
    });
    document.querySelector('iframe').srcdoc = html;
  }, readObserverDocument(root));
  const view = page.frameLocator('iframe');
  await expect(view.locator('#stop')).toBeVisible();
  let state = { runId: 'run-1', phase: 'idle', outcome: 'idle', steps: [], uart: '', canStop: false };
  const send = (theme, language, compact = false) => page.evaluate(data => {
    document.querySelector('iframe').contentWindow.postMessage({ channel: 'aily-native-observer-v1', type: 'snapshot', ...data }, '*');
  }, { snapshot: state, compact, context: { theme, language } });
  await send('dark', 'zh_cn');
  await expect(view.locator('#status')).toHaveText('待机');
  await expect(view.locator('#steps-empty')).toBeVisible();
  await expect(view.locator('#stop')).toBeDisabled();
  await page.screenshot({ path: path.join(root, 'idle-dark.png') });
  state = { runId: 'run-1', phase: 'scenario', outcome: 'running', canStop: true, durationMs: 1750,
    frame: { function: 'loop', file: 'sketch.ino', line: 32 }, debugState: 'stopped',
    steps: [{ id: 'input', op: 'adc.setRaw', outcome: 'passed', stimulus: { unit: 1, channel: 0, pin: 'GPIO1', raw: 2048 } },
      { id: 'release', op: 'gpio.setLevel', outcome: 'passed', stimulus: { source: 'gpio-input-injection', gpio: 1, pin: 'GPIO1', level: 'high-z', status: 'dispatched' } },
      { id: 'assert', op: 'observe.equals', expression: 'sample', expected: '2048', actual: '2048', outcome: 'passed' },
      { id: 'pwm', op: 'signal.measure', outcome: 'passed', measurement: { gpio: 1, modelDerived: true, completeCycles: 39,
        clockResolutionNs: 1, metrics: { frequencyHz: { mean: 1000, min: 1000, max: 1000 } },
        assertions: [{ metric: 'frequencyHz', expected: { min: 999, max: 1001 }, passed: true }] } },
      { id: 'uart', op: 'uart.expect', outcome: 'running' }],
    uart: 'ESP-ROM:esp32s3-20210327\nREADY\nADC raw=2048\n<script>not markup</script>' };
  await send('dark', 'zh_cn');
  await expect(view.locator('#status')).toHaveText('运行中');
  await expect(view.locator('#uart')).toContainText('<script>not markup</script>');
  await expect(view.locator('#uart script')).toHaveCount(0);
  await expect(view.locator('#values')).toContainText('非测量结果');
  await expect(view.locator('#values')).toContainText('GPIO1 level=high-z');
  await expect(view.locator('#values')).toContainText('LEDC 模型推导');
  await expect(view.locator('#values')).toContainText('frequencyHz: 1000');
  assert.equal(await view.locator('html').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(43, 45, 48)');
  await page.screenshot({ path: path.join(root, 'running-dark.png') });
  await send('light', 'en');
  await expect(view.locator('#status')).toHaveText('Running');
  await expect(view.locator('#values')).toContainText('LEDC model-derived');
  assert.equal(await view.locator('html').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(232, 232, 232)');
  await page.screenshot({ path: path.join(root, 'running-light.png') });
  await page.setViewportSize({ width: 280, height: 820 }); await send('dark', 'zh_cn', true);
  await expect(view.locator('body')).toHaveClass('compact');
  assert.equal(await view.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Compact UI cannot overflow horizontally');
  await view.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => window.stops.length)).toBe(1);
  assert.equal(await page.evaluate(() => window.stops[0].runId), 'run-1');
  await page.screenshot({ path: path.join(root, 'running-compact.png') });
  state = { ...state, phase: 'finished', outcome: 'failed', canStop: false, cleanup: { failed: true },
    error: { code: 'ASSERTION_FAILED', message: 'Expected marker was not observed.' } };
  await send('dark', 'zh_cn', true);
  await expect(view.locator('#stop')).toBeDisabled();
  await expect(view.locator('#error')).toBeVisible();
  await expect(view.locator('#cleanup')).toHaveAttribute('data-failed', 'true');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, root, checks: ['dark-light-live-theme', 'zh-en-live-language', 'idle-running-failed',
    'compact-280px-no-overflow', 'stop-current-run', 'plain-text-observations', 'virtual-measurement-and-model-origin', 'no-browser-errors'] }, null, 2));
} finally { await browser.close(); }
