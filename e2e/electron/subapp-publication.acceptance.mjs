import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const { buildSync } = require('esbuild');
assert.ok(['darwin', 'win32'].includes(process.platform), 'Run native publication acceptance on macOS or Windows');
const resultRoot = path.join(repo, 'e2e/test-results/subapp-publication');
fs.mkdirSync(resultRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(resultRoot, 'run-'));
const appdata = path.join(output, 'appdata');
const installRoot = path.join(appdata, 'npm-global/app');
const source = version => path.join(installRoot, 'store/subapp-aily-chat', version, 'source');
const report = { platform: process.platform, output, scope: 'production Electron IPC/preload/renderer service plus real fixture runtime; isolated contract shell', scenarios: [] };
let application, page, log;
const api = async (method, ...args) => application.evaluate((_electron, { method, args }) =>
  globalThis.publicationAcceptance[method](...args), { method, args });
const record = (name, detail = {}) => { report.scenarios.push({ name, ...detail }); console.log(`PASS ${name}`); };
async function start(action) {
  await page.locator(`[data-action="${action}"]`).click();
}
async function finish(expectedError = null) {
  await page.waitForFunction(() => window.publicationOperation?.settled, undefined, { timeout: 20000 });
  const outcome = await page.evaluate(() => window.publicationOperation);
  if (expectedError) assert.match(outcome.error, expectedError);
  else assert.equal(outcome.error, null);
  return outcome;
}
async function launch(expected) {
  const config = await page.evaluate(async () => {
    const selected = await window.electronAPI.subapps.prepareLaunch({ id: 'aily-chat' });
    try { return selected.config; }
    finally { await window.electronAPI.subapps.finishLaunch(selected.token); }
  });
  assert.equal(config.version, expected);
  assert.equal(await api('execute', config), expected);
}
async function arm(version, mode) {
  await api('arm', version, mode);
  await page.evaluate(() => window.publicationService.refresh(true));
}
async function stage(version) {
  await arm(version, null); await start('downloadUpdate'); await finish();
}
async function queueLaunchDuringRetry() {
  await application.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (!globalThis.publicationAcceptance.stats().observed?.length) {
      if (Date.now() > deadline) throw new Error('Native directory rename did not fail');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  });
  await page.evaluate(() => {
    window.queuedLaunchSettled = false;
    window.queuedLaunch = window.electronAPI.subapps.prepareLaunch({ id: 'aily-chat' }).then(
      value => { window.queuedLaunchSettled = true; return value; },
      error => { window.queuedLaunchSettled = true; throw error; });
    window.queuedLaunch.catch(() => {});
  });
  await delay(120);
  assert.equal(await page.evaluate(() => window.queuedLaunchSettled), false, 'launch must wait through replacement/rollback');
}
async function finishQueuedLaunch(expected) {
  const config = await page.evaluate(async () => {
    const launch = await window.queuedLaunch;
    try { return launch.config; }
    finally { await window.electronAPI.subapps.finishLaunch(launch.token); }
  });
  assert.equal(config.version, expected);
  assert.equal(await api('execute', config), expected);
}

try {
  fs.mkdirSync(appdata, { recursive: true });
  fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>子应用发布验收</title>
    <h1>子应用发布验收</h1><output data-version></output><pre data-error></pre>
    ${['install', 'update', 'reinstall', 'downloadUpdate', 'installUpdate'].map(action => `<button data-action="${action}">${action}</button>`).join('')}
    <script src="renderer.js"></script>`);
  buildSync({ entryPoints: [path.join(repo, 'e2e/electron/fixtures/subapp-publication-renderer.ts')], bundle: true,
    platform: 'browser', format: 'iife', tsconfig: path.join(repo, 'tsconfig.json'), outfile: path.join(output, 'renderer.js'), logLevel: 'silent' });
  const env = { ...process.env, AILY_APPDATA_PATH: appdata, AILY_PUBLICATION_OUTPUT: output };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'AILY_CHILD_PATH', 'NODE_PATH']) delete env[key];
  log = fs.createWriteStream(path.join(output, 'electron.log'));
  application = await _electron.launch({ executablePath: require('electron'), cwd: repo,
    args: [path.join(repo, 'e2e/electron/fixtures/subapp-publication-host.cjs')], env, timeout: 45000 });
  for (const stream of [application.process().stdout, application.process().stderr]) stream.on('data', bytes => log.write(bytes));
  page = await application.firstWindow();
  await page.waitForFunction(() => window.electronAPI?.subapps && window.startPublicationAcceptance);
  await page.evaluate(url => window.startPublicationAcceptance(url), await api('indexUrl'));
  report.runtime = await application.evaluate(() => process.versions);

  await api('arm', '1.0.0', 'transient'); await start('install'); await finish(); await launch('1.0.0');
  assert.equal((await api('stats')).observed.length, 2);
  record('first install retries real native rename denials', await api('stats'));

  await api('arm', '1.0.0', 'gated'); await start('reinstall'); await queueLaunchDuringRetry();
  await api('unlock'); await finish(); await finishQueuedLaunch('1.0.0');
  record('concurrent IPC launch waits for reinstall publication', await api('stats'));

  const marker = path.join(source('1.0.0'), 'rollback-marker.txt'); fs.writeFileSync(marker, 'preserve');
  await api('arm', '1.0.0', 'persistent'); await start('reinstall'); await queueLaunchDuringRetry();
  await finish(/无法完成替换/); await finishQueuedLaunch('1.0.0');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve');
  assert.equal((await api('stats')).observed.length, 8);
  record('concurrent IPC launch waits for failed reinstall rollback', await api('stats')); await api('unlock');

  await api('arm', '1.0.0', 'remove-runtime'); await start('reinstall');
  await finish(/runtime is incomplete/); await launch('1.0.0');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve');
  record('post-publication entry validation rolls back before deleting the original generation');

  await stage('2.0.0'); fs.rmSync(path.join(source('2.0.0'), 'server/index.js'));
  const downloads = (await api('stats')).downloads; await api('offline');
  await start('installUpdate'); await finish(); await launch('2.0.0');
  assert.equal((await api('stats')).downloads, downloads);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve');
  record('missing downloaded runtime is rebuilt offline before activation');

  await stage('3.0.0'); fs.rmSync(path.join(source('3.0.0'), 'ui/index.html'));
  await start('update'); await finish(); await launch('3.0.0');
  assert.ok(fs.existsSync(path.join(source('3.0.0'), 'ui/index.html')));
  record('missing downloaded UI is rebuilt before update reports success');

  await arm('4.0.0', 'persistent'); await start('update');
  const failure = await finish(/当前版本 3\.0\.0 仍可继续使用/);
  assert.doesNotMatch(failure.error, /Error invoking remote method/); await launch('3.0.0');
  await api('arm', '4.0.0', null); await start('update'); await finish(); await launch('4.0.0');
  record('persistent update failure preserves the old runtime and manual retry succeeds');

  await page.screenshot({ path: path.join(output, 'complete.png') });
  report.passed = true;
} finally {
  if (application) {
    await api('unlock').catch(() => {});
    await application.close();
  }
  log?.end();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${output}`);
}
