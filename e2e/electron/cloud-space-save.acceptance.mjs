import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { _electron } from 'playwright';

const root = process.cwd();
const seed = process.env.AILY_CLOUD_SAVE_SEED;
assert.ok(seed && path.isAbsolute(seed), 'AILY_CLOUD_SAVE_SEED must identify an installed Blockly test seed; only copies are edited');
const output = path.resolve(process.env.AILY_CLOUD_SAVE_OUTPUT || 'e2e/test-results/cloud-space-save');
assert.ok(output.startsWith(path.resolve('e2e/test-results') + path.sep), 'Keep evidence in ignored E2E results');
const suite = path.join(output, `run-${Date.now()}`);
const source = path.join(suite, 'source');
const devUrl = process.env.AILY_E2E_DEV_URL || 'http://localhost:4200';
const sevenZip = process.env.AILY_CLOUD_SAVE_7Z || path.join(root, 'child', process.platform === 'win32' ? 'windows/7za.exe' : 'macos/7zz');
const evidence = { seed, suite, scenarios: [], transport: 'real local packaging/extraction; remote cloud responses intercepted', remoteWrites: [] };
let app, page;
const log = (...values) => console.log(new Date().toISOString(), ...values);
const digest = value => createHash('sha256').update(value).digest('hex');

async function selectProject(project) {
  await page.evaluate(target => {
    const service = window.ng.getComponent(document.querySelector('app-main-window')).projectService;
    window.__cloudTestOpen = service.projectOpen(target).catch(error => { window.__cloudTestOpenError = String(error); });
  }, project);
  await page.waitForFunction(target => {
    const element = document.querySelector('blockly-main');
    if (!element) return false;
    const service = window.ng.getComponent(element).projectService;
    return service.currentProjectPath === target && service.getBlocklyProjectLoadStatus(target).ready;
  }, project, { timeout: 45000 });
  const skip = page.getByText('跳过', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function save() {
  const result = await page.evaluate(async () =>
    window.ng.getComponent(document.querySelector('blockly-main')).projectService.save());
  assert.equal(result.success, true, JSON.stringify(result));
  return result;
}

async function packageProject(project) {
  return page.evaluate(async target => window.ng.getComponent(document.querySelector('app-cloud-space')).packageProject(target), project);
}

async function extract(archive) {
  return page.evaluate(async file => {
    const service = window.ng.getComponent(document.querySelector('app-cloud-space')).cloudService;
    return service.downloadAndExtractArchive(new Blob([window.fs.readFileSync(file, null)], { type: 'application/x-7z-compressed' }));
  }, archive);
}

function archivePaths(archive) {
  const listing = execFileSync(sevenZip, ['l', '-slt', archive], { encoding: 'utf8' });
  return listing.split('----------')[1].split('\n').filter(line => line.startsWith('Path = ')).map(line => line.slice(7).trim().replaceAll('\\', '/'));
}

async function importDownload(extracted, target) {
  const actual = await page.evaluate(({ extracted, target }) =>
    window.ng.getComponent(document.querySelector('app-main-window')).projectService.importProjectDirectory(extracted, target, true),
  { extracted, target });
  assert.equal(actual, target);
  await fs.cp(path.join(source, 'node_modules'), path.join(target, 'node_modules'), { recursive: true });
  await fs.copyFile(path.join(source, 'package-lock.json'), path.join(target, 'package-lock.json'));
}

async function inspectDocument(project, expectedValue) {
  const document = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'));
  assert.equal(document.pages.length, 2);
  assert.equal(document.sharedModel.cloudTestPreserved, 'shared metadata');
  const other = document.pages.find(page => page.id === 'cloud-other-page');
  assert.equal(other.content.blocks.blocks[0].fields.TEXT, '第二页原样保留');
  assert.deepEqual(other.content.blocks.blocks[0].disabledReasons, ['MANUALLY_DISABLED']);
  const roots = document.pages[0].content.blocks.blocks;
  assert.equal(roots.find(block => block.type === 'arduino_setup').deletable, false);
  if (expectedValue !== undefined) {
    const values = [];
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'math_number') values.push(value.fields.NUM);
      Object.values(value).forEach(child => Array.isArray(child) ? child.forEach(visit) : visit(child));
    };
    visit(document); assert.ok(values.includes(expectedValue), JSON.stringify(values));
  }
  const resource = await page.evaluate(async ({ project, ref }) => {
    const service = window.ng.getComponent(document.querySelector('app-main-window')).projectService;
    return service.createProjectDataStore(project).resolve(ref);
  }, { project, ref: document.cloudRoundtripAsset });
  assert.equal(digest(resource), evidence.assetHash);
  assert.equal(await fs.readFile(path.join(project, 'local-libraries/cloud-test-driver/driver.h'), 'utf8'), '// cloud local library source\n');
}

async function editSyncReopen(project, value, name) {
  await selectProject(project);
  await page.evaluate(value => {
    window.Blockly.getMainWorkspace().getBlocksByType('math_number', false)[0].setFieldValue(String(value), 'NUM');
  }, value);
  await page.locator('.sync-btn').click({ timeout: 5000 });
  await page.waitForFunction(() => !window.ng.getComponent(document.querySelector('app-cloud-space')).isSyncing
    && document.body.innerText.includes('同步成功'), undefined, { timeout: 30000 });
  await inspectDocument(project, value);
  assert.ok(await fs.stat(path.join(project, 'project.abs.map.json')));
  await page.screenshot({ path: path.join(output, `${name}-saved.png`) });
  const away = path.join(suite, `away-${name}`);
  await fs.mkdir(away);
  for (const file of ['package.json', 'package-lock.json', 'project.abi', 'node_modules', 'assets', 'local-libraries'])
    await fs.cp(path.join(source, file), path.join(away, file), { recursive: true });
  await selectProject(away); await selectProject(project);
  await inspectDocument(project, value);
  const live = await page.evaluate(value => window.Blockly.getMainWorkspace().getBlocksByType('math_number', false)
    .some(block => block.getFieldValue('NUM') === value), value);
  assert.equal(live, true);
  evidence.scenarios.push({ name, project, editedValue: value, saved: true, reopened: true, resourcesPreserved: true });
}

async function main() {
  await fs.mkdir(source, { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'project.abi', 'node_modules'])
    await fs.cp(path.join(seed, file), path.join(source, file), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  Object.assign(manifest, { name: 'isolated-cloud-space-save', nickname: '云空间保存回归' });
  delete manifest.cloudId; delete manifest.codeHash; delete manifest.buildInfo;
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify(manifest, null, 2));
  const document = JSON.parse(await fs.readFile(path.join(source, 'project.abi'), 'utf8'));
  assert.ok(document.pages?.length === 1, 'Use a single-page seed; this test adds a separate page');
  document.pages.push({ id: 'cloud-other-page', title: '第二页', content: { blocks: { languageVersion: 0, blocks: [
    { id: 'cloud-other-text', type: 'text', fields: { TEXT: '第二页原样保留' }, disabledReasons: ['MANUALLY_DISABLED'] },
  ] } } });
  document.sharedModel.cloudTestPreserved = 'shared metadata';
  await fs.mkdir(path.join(source, 'local-libraries/cloud-test-driver'), { recursive: true });
  await fs.writeFile(path.join(source, 'local-libraries/cloud-test-driver/driver.h'), '// cloud local library source\n');
  const profile = path.join(suite, 'profile'); await fs.mkdir(profile);
  const config = JSON.parse(await fs.readFile(path.join(root, 'electron/config/config.json'), 'utf8'));
  Object.assign(config, { installed: 'true', metricsEnabled: false, theme: 'dark', project_path: suite });
  await fs.writeFile(path.join(profile, 'config.json'), JSON.stringify(config));
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  app = await _electron.launch({ cwd: root, args: ['.', '--serve', '--user-data-dir=' + profile], timeout: 45000,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: path.join(suite, 'appdata'), AILY_DEV_RENDERER_URL: devUrl } });
  await app.firstWindow();
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    page = app.windows().find(candidate => candidate.url().startsWith(devUrl) && !candidate.url().includes('#/settings'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss());
  page.on('console', event => { if (event.type() === 'error') log('renderer', event.text().slice(0, 700)); });
  await page.locator('app-main-window').waitFor({ timeout: 30000 });
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (request.method() === 'POST' && url.includes('/cloud/sync')) {
      evidence.remoteWrites.push({ intercepted: true, method: request.method(), url });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 200, data: { id: 'isolated-cloud-id' } }) });
    } else if (request.method() === 'GET' && /\/cloud\/projects\?/.test(url)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 200, data: { list: [], total: 0 } }) });
    } else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !url.startsWith(devUrl)) {
      await route.abort();
    } else await route.continue();
  });
  const later = page.getByText('稍后登录', { exact: true });
  if (await later.isVisible().catch(() => false)) await later.click();
  const asset = '云包外置资源 😀\n'.repeat(6000);
  document.cloudRoundtripAsset = await page.evaluate(async ({ project, asset }) => {
    const service = window.ng.getComponent(document.querySelector('app-main-window')).projectService;
    const store = service.createProjectDataStore(project), ref = await store.put({ codec: 'utf8-v1', value: asset });
    await store.flushPending(); return ref;
  }, { project: source, asset });
  evidence.assetHash = digest(asset);
  await fs.writeFile(path.join(source, 'project.abi'), JSON.stringify(document));
  log('open source'); await selectProject(source); await save();
  await page.evaluate(() => {
    const main = window.ng.getComponent(document.querySelector('app-main-window'));
    main.uiService.openToolList.push('cloud-space'); main.showRbox = true; main.cd.detectChanges();
  });
  await page.locator('app-cloud-space').waitFor();
  const mirrorsBefore = await Promise.all(['project.abs', 'project.abs.map.json'].map(file => fs.readFile(path.join(source, file))));
  const archive = await packageProject(source); assert.ok(archive);
  const entries = archivePaths(archive);
  assert.ok(entries.includes('project.abi')); assert.ok(entries.some(name => name.startsWith('assets/project-data/')));
  assert.ok(entries.includes('local-libraries/cloud-test-driver/driver.h'));
  assert.ok(!entries.includes('project.abs') && !entries.includes('project.abs.map.json'));
  assert.ok(!entries.some(name => name.startsWith('.aily/')));
  const mirrorsAfter = await Promise.all(['project.abs', 'project.abs.map.json'].map(file => fs.readFile(path.join(source, file))));
  assert.deepEqual(mirrorsAfter, mirrorsBefore, 'Packaging must leave local ABS and map intact');
  evidence.archiveEntries = entries;
  const downloaded = path.join(suite, 'new-download');
  await importDownload(await extract(archive), downloaded);
  log('new package edit/save/reopen'); await editSyncReopen(downloaded, 1200, 'new-cloud-package');
  const legacyArchive = path.join(suite, 'legacy.7z');
  execFileSync(sevenZip, ['a', '-t7z', legacyArchive, 'package.json', 'project.abi', 'project.abs.map.json', 'assets', 'local-libraries'], { cwd: source });
  const extracted = await extract(legacyArchive);
  const old = path.join(suite, 'legacy-download'); await importDownload(extracted, old);
  const backups = await fs.readdir(path.join(old, '.cloud-import-backup'));
  assert.equal(backups.length, 1);
  assert.deepEqual(await fs.readFile(path.join(old, '.cloud-import-backup', backups[0])), mirrorsBefore[1]);
  await assert.rejects(fs.stat(path.join(old, 'project.abs.map.json')), { code: 'ENOENT' });
  log('legacy package edit/save/reopen'); await editSyncReopen(old, 1400, 'legacy-cloud-package');
  const coder = path.join(suite, 'coder'); await fs.mkdir(path.join(coder, 'sketch'), { recursive: true });
  await fs.writeFile(path.join(coder, 'package.json'), '{"name":"coder","type":"coder"}');
  await fs.writeFile(path.join(coder, 'sketch/main.cpp'), 'void setup() {}\nvoid loop() {}\n');
  await fs.writeFile(path.join(coder, 'sketch/.aily-component-library.json'), '{"preserve":true}');
  for (const file of ['project.abs', 'project.abs.map.json']) await fs.writeFile(path.join(coder, file), 'leftover Blockly metadata');
  const coderEntries = archivePaths(await packageProject(coder));
  assert.ok(coderEntries.includes('sketch/main.cpp'));
  assert.ok(coderEntries.includes('sketch/.aily-component-library.json'));
  assert.ok(!coderEntries.includes('project.abs') && !coderEntries.includes('project.abs.map.json'));
  evidence.scenarios.push({ name: 'coder-package-isolation', entries: coderEntries });
  assert.equal(evidence.remoteWrites.length, 2);
  evidence.ok = true; log('PASS', output);
}

try { await main(); }
catch (error) { evidence.ok = false; evidence.error = error.stack; throw error; }
finally {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  if (app) {
    const owned = app.process();
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))]);
    if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGTERM');
  }
}
