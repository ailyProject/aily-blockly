import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { _electron } from 'playwright';
import ts from 'typescript';

const root = process.cwd();
const seed = process.env.AILY_CODER_CLOUD_SEED;
const coderRoot = process.env.AILY_CODER_CLOUD_EDITOR_ROOT;
const platformSeed = process.env.AILY_E2E_PLATFORM_SEED;
assert.ok(seed && path.isAbsolute(seed), 'Set AILY_CODER_CLOUD_SEED to an installed Blockly/Coder test seed; only copies are edited');
assert.ok(coderRoot && path.isAbsolute(coderRoot), 'Set AILY_CODER_CLOUD_EDITOR_ROOT to a built portable Coder editor');
assert.ok(platformSeed && path.isAbsolute(platformSeed), 'Set AILY_E2E_PLATFORM_SEED to installed SDK/tool assets; the test clones them read-only');
const output = path.resolve(process.env.AILY_CODER_CLOUD_OUTPUT || 'e2e/test-results/coder-cloud-sync');
assert.ok(output.startsWith(path.resolve('e2e/test-results') + path.sep));
const suite = path.join(output, `run-${Date.now()}`), source = path.join(suite, 'projects/source');
const stage = path.join(suite, 'app'), appdata = path.join(suite, 'appdata');
const sevenZip = process.env.AILY_CLOUD_SAVE_7Z || path.join(root, 'child', process.platform === 'win32' ? 'windows/7za.exe' : 'macos/7zz');
const devUrl = process.env.AILY_E2E_DEV_URL || 'http://localhost:4200';
const evidence = { suite, mode: 'coder', scenarios: [], uploads: [], lists: [], downloads: [],
  transport: 'actual Coder editor, save, 7z, import and HTTP client; cloud service responses intercepted' };
const projects = new Map();
let app, page, frame, catalog, failuresRemaining = 0, serial = 0;
const log = (...values) => console.log(new Date().toISOString(), ...values);
const json = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2)); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function routeCloud(route) {
  const request = route.request(), url = new URL(request.url());
  const reply = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  if (url.pathname.endsWith('/cloud/sync') && request.method() === 'POST') {
    const form = await new Request(url, { method: 'POST', headers: await request.allHeaders(), body: request.postDataBuffer() }).formData();
    assert.equal(form.get('category'), 'coder');
    const metadata = JSON.parse(form.get('projectData')), pid = form.get('pid');
    assert.equal(metadata.type, 'coder');
    const archive = Buffer.from(await form.get('archive').arrayBuffer());
    const archivePath = path.join(output, `upload-${evidence.uploads.length + 1}.7z`); await fs.writeFile(archivePath, archive);
    const entries = execFileSync(sevenZip, ['l', '-slt', archivePath], { encoding: 'utf8' }).split('----------')[1]
      .split('\n').filter(line => line.startsWith('Path = ')).map(line => line.slice(7).trim().replaceAll('\\', '/'));
    assert.ok(entries.includes('sketch/src/main.cpp'));
    assert.ok(entries.includes('sketch/libraries/Local/Local.h'));
    assert.ok(entries.includes('sketch/.aily-component-library.json'));
    assert.ok(entries.includes('assets/中文资源.txt'));
    assert.ok(!entries.includes('project.abi') && !entries.includes('project.abs') && !entries.includes('project.abs.map.json'));
    assert.ok(!entries.some(name => name.startsWith('.aily/') || name.startsWith('.build/')));
    const archivedSource = execFileSync(sevenZip, ['x', '-so', archivePath, 'sketch/src/main.cpp'], { encoding: 'utf8' });
    const item = { attempt: evidence.uploads.length + 1, pid, category: form.get('category'), metadata, archivePath, entries,
      sourceHash: hash(archivedSource), sourceMarkers: [...archivedSource.matchAll(/CODER_[A-Z_]+/g)].map(match => match[0]), intercepted: true };
    evidence.uploads.push(item);
    if (failuresRemaining > 0) { failuresRemaining--; item.failed = true; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"status":503,"messages":"controlled upload failure"}' }); }
    const id = pid || `coder-cloud-${++serial}`;
    if (pid) assert.ok(projects.has(pid), 'An update must retain an existing cloud ID');
    projects.set(id, { metadata: { id, name: metadata.name, nickname: metadata.nickname, description: metadata.description || '',
      doc_url: '', tags: '[]', image_url: null, category: 'coder', updated_at: '2026-10-29T08:30:00Z', is_published: false }, archive });
    item.id = id;
    return reply({ status: 200, data: { id } });
  }
  if (url.pathname.endsWith('/cloud/projects') && request.method() === 'GET') {
    assert.equal(url.searchParams.get('category'), 'coder');
    evidence.lists.push(Object.fromEntries(url.searchParams));
    return reply({ status: 200, data: { list: [...projects.values()].map(value => value.metadata), total: projects.size } });
  }
  const download = url.pathname.match(/\/cloud\/projects\/([^/]+)\/download$/);
  if (download) {
    const project = projects.get(download[1]); assert.ok(project);
    evidence.downloads.push({ id: download[1], bytes: project.archive.length });
    return route.fulfill({ status: 200, contentType: 'application/x-7z-compressed', body: project.archive });
  }
  const detail = url.pathname.match(/\/cloud\/projects\/([^/]+)$/);
  if (detail) return reply({ status: 200, data: projects.get(detail[1])?.metadata });
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
  if (url.hostname === 'api.yiyu.pro' || url.hostname === 'api.aily.pro') return reply({ status: 200, data: { id: 'isolated-coder-user', nickname: 'Coder 云同步验证', groups: [] } });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) return route.abort();
  return route.continue();
}

async function selectProject(project) {
  await page.evaluate(target => {
    const service = window.ng.getComponent(document.querySelector('app-main-window')).projectService;
    window.__coderCloudOpen = service.projectOpen(target).catch(error => { window.__coderCloudOpenError = String(error); });
  }, project);
  await ready(project);
}

async function ready(project) {
  await page.waitForFunction(target => {
    const element = document.querySelector('app-main-window'); if (!element) return false;
    return window.ng.getComponent(element).projectService.currentProjectPath === target;
  }, project, { timeout: 45000 });
  for (let attempt = 0; attempt < 100; attempt++) {
    const handle = await page.locator('app-code-editor-frame[aria-hidden="false"] iframe.is-ready').elementHandle();
    frame = await handle?.contentFrame();
    if (frame && await frame.locator('.monaco-workbench').count()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Real Coder editor did not become ready');
}

async function edit(marker) {
  const file = frame.getByText('main.cpp', { exact: true }).first(); await file.waitFor({ timeout: 30000 }); await file.dblclick();
  const editor = frame.locator('.monaco-editor .view-lines').first(); await editor.waitFor(); await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await page.keyboard.press('Home'); await page.keyboard.insertText(`// ${marker}\n`);
  await page.waitForFunction(() => document.querySelector('app-header .project-box')?.getAttribute('data-unsaved') === 'true');
}

async function sync(project, expectedPid, marker, expectedFailure = false, expectedAttempts = 1) {
  const before = evidence.uploads.length;
  assert.ok(!(await fs.readFile(path.join(project, 'sketch/src/main.cpp'), 'utf8')).includes(marker), 'The editor buffer must be unsaved before sync');
  await page.locator('.sync-btn').click({ timeout: 5000 });
  await page.waitForFunction(() => !window.ng.getComponent(document.querySelector('app-cloud-space')).isSyncing
    && /同步成功|同步失败/.test(document.querySelector('.ant-message')?.textContent || ''), undefined, { timeout: 45000 });
  assert.equal(evidence.uploads.length, before + expectedAttempts);
  const upload = evidence.uploads.at(-1); assert.equal(upload.pid, expectedPid); assert.equal(!!upload.failed, expectedFailure);
  assert.ok(upload.sourceMarkers.includes(marker), 'The uploaded archive must contain the saved editor buffer');
  assert.ok((await fs.readFile(path.join(project, 'sketch/src/main.cpp'), 'utf8')).includes(marker));
  if (!expectedFailure) assert.equal(JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')).cloudId, upload.id);
  await page.screenshot({ path: path.join(output, `sync-${upload.attempt}.png`) });
  return upload;
}

async function main() {
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(stage);
  await fs.cp(path.join(root, 'electron'), path.join(stage, 'electron'), { recursive: true,
    filter: file => !path.relative(path.join(root, 'electron'), file).split(path.sep).some(part => ['node_modules', 'tests', 'test'].includes(part)) });
  for (const name of ['node_modules', 'electron/node_modules', 'child'])
    await fs.symlink(path.join(root, name), path.join(stage, name), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.copyFile(path.join(root, 'e2e/electron/fixtures/subapp-product-bootstrap.cjs'), path.join(stage, 'electron/bootstrap.cjs'));
  await json(path.join(stage, 'package.json'), { ...JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')), main: 'electron/bootstrap.cjs' });
  const manifest = JSON.parse(await fs.readFile(path.join(seed, 'package.json'), 'utf8'));
  Object.assign(manifest, { name: 'coder-cloud-isolated', nickname: 'Coder 云同步回归', type: 'coder', entry: 'src/main.cpp', sourceRoots: ['src', 'libraries'], devmode: 'arduino', framework: 'arduino' });
  for (const key of ['cloudId', 'ailyBlocklyUsedLibraries', 'codeHash', 'buildInfo']) delete manifest[key];
  await json(path.join(source, 'package.json'), manifest);
  await fs.cp(path.join(seed, 'node_modules'), path.join(source, 'node_modules'), { recursive: true });
  await fs.cp(path.join(seed, 'node_modules'), path.join(appdata, 'node_modules'), { recursive: true });
  await fs.copyFile(path.join(seed, 'package-lock.json'), path.join(source, 'package-lock.json'));
  // Reuse the existing platform fixture in this standalone Node suite. Compile
  // its TypeScript into ignored output without modifying the shared fixture.
  const platformHelper = path.join(suite, 'platform-seed.cjs');
  const platformSource = await fs.readFile(path.join(root, 'e2e/fixtures/platform-seed.ts'), 'utf8');
  await fs.writeFile(platformHelper, ts.transpileModule(platformSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText);
  await (await import(pathToFileURL(platformHelper).href)).seedPlatform(source, appdata, platformSeed);
  await fs.mkdir(path.join(source, 'sketch/src'), { recursive: true });
  await fs.writeFile(path.join(source, 'sketch/src/main.cpp'), '// ORIGINAL_SOURCE\nvoid setup() {}\nvoid loop() {}\n');
  await fs.mkdir(path.join(source, 'sketch/libraries/Local'), { recursive: true });
  await fs.writeFile(path.join(source, 'sketch/libraries/Local/Local.h'), '// local header\n');
  await json(path.join(source, 'sketch/.aily-component-library.json'), { preserved: true });
  await fs.mkdir(path.join(source, 'assets')); await fs.writeFile(path.join(source, 'assets/中文资源.txt'), 'Coder 资源\n');
  for (const file of ['project.abi', 'project.abs', 'project.abs.map.json']) await fs.writeFile(path.join(source, file), `leftover ${file}`);
  await fs.mkdir(path.join(source, '.aily/abs-sync'), { recursive: true }); await fs.writeFile(path.join(source, '.aily/abs-sync/fixture.txt'), 'local state');
  const localMirrors = await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFile(path.join(source, file))));
  const editorManifest = JSON.parse(await fs.readFile(path.join(coderRoot, 'package.json'), 'utf8'));
  const appRoot = path.join(appdata, 'npm-global/app');
  await fs.mkdir(path.join(appRoot, 'node_modules/@aily-project'), { recursive: true });
  await fs.symlink(coderRoot, path.join(appRoot, 'node_modules', editorManifest.name), process.platform === 'win32' ? 'junction' : 'dir');
  const index = { dev: true, 'aily-coder-editor': { ...editorManifest.ailySubapp, id: 'aily-coder-editor', package: editorManifest.name,
    version: editorManifest.version, app: { ...editorManifest.ailySubapp.app, autoInstall: false } } };
  await json(path.join(appRoot, 'package.json'), { name: 'isolated-coder-cloud', private: true, dependencies: { [editorManifest.name]: editorManifest.version } });
  await json(path.join(appRoot, 'subapp-index.json'), index);
  catalog = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json'); response.setHeader('access-control-allow-origin', '*');
    response.end(JSON.stringify(request.url === '/subapp-index.json' ? index : { status: 200, data: { id: 'isolated-coder-user', nickname: 'Coder 验证', groups: [] } }));
  });
  await new Promise(resolve => catalog.listen(0, '127.0.0.1', resolve));
  const catalogUrl = `http://127.0.0.1:${catalog.address().port}`;
  const config = JSON.parse(await fs.readFile(path.join(stage, 'electron/config/config.json'), 'utf8'));
  Object.assign(config, { installed: 'true', onboardingCompleted: true, blocklyOnboardingCompleted: true, metricsEnabled: false,
    project_path: path.join(suite, 'projects'), theme: 'dark' });
  await json(path.join(stage, 'electron/config/config.json'), config);
  const profile = path.join(suite, 'profile'); await json(path.join(profile, 'config.json'), config);
  await json(path.join(appdata, 'auth/coder.json'), { access_token: 'isolated-coder-cloud-test' });
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  app = await _electron.launch({ cwd: stage, args: [stage, '--serve', '--coder', '--user-data-dir=' + profile], timeout: 45000,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appdata, AILY_DEV_RENDERER_URL: devUrl, AILY_BUILD_PRODUCT: 'coder',
      AILY_PRODUCT_ACCEPTANCE_ROOT: suite, AILY_SUBAPP_INSTALL_ROOT: appRoot, AILY_SUBAPP_INDEX_URL: catalogUrl + '/subapp-index.json' } });
  await app.context().route('**/*', routeCloud); await app.firstWindow();
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    page = app.windows().find(candidate => candidate.url().startsWith(devUrl) && !candidate.url().includes('#/settings'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss());
  page.on('console', event => { if (event.type() === 'error') log('renderer', event.text().slice(0, 800)); });
  await page.locator('app-main-window').waitFor({ timeout: 30000 });
  evidence.product = await page.evaluate(() => {
    const config = window.ng.getComponent(document.querySelector('app-main-window')).configService;
    return { coder: config.isCoderProduct(), mode: config.getDevelopmentModePreference() };
  }); assert.equal(evidence.product.coder, true); assert.equal(evidence.product.mode, 'coder');
  evidence.editorBuild = { version: editorManifest.version, runtime: hash(await fs.readFile(path.join(coderRoot, 'runtime/index.js'))), ui: hash(await fs.readFile(path.join(coderRoot, 'ui/index.html'))) };
  log('open actual coder editor'); await selectProject(source);
  await page.evaluate(() => {
    const main = window.ng.getComponent(document.querySelector('app-main-window'));
    main.uiService.openToolEmbedded('cloud-space'); main.cd.detectChanges();
  }); await page.locator('app-cloud-space').waitFor({ timeout: 10000 });
  // Only dependency bootstrapping is supplied locally. The real download,
  // extraction, copy, metadata update and project-open implementation run intact.
  await page.evaluate(seed => {
    const component = window.ng.getComponent(document.querySelector('app-cloud-space'));
    const original = component.crossPlatformCmdService.copyItem.bind(component.crossPlatformCmdService);
    component.crossPlatformCmdService.copyItem = async (...args) => {
      const result = await original(...args), target = args[1];
      window.fs.copySync(window.path.join(seed, 'node_modules'), window.path.join(target, 'node_modules'));
      window.fs.copySync(window.path.join(seed, 'package-lock.json'), window.path.join(target, 'package-lock.json'));
      return result;
    };
  }, seed);
  log('first cloud sync'); await edit('CODER_CREATE');
  const created = await sync(source, null, 'CODER_CREATE');
  const cloudId = created.id; evidence.scenarios.push({ name: 'create', id: cloudId, category: 'coder' });
  await page.locator('.ant-message').waitFor({ state: 'hidden', timeout: 10000 });
  log('update same cloud project'); await edit('CODER_UPDATE'); await sync(source, cloudId, 'CODER_UPDATE');
  assert.equal(projects.size, 1); evidence.scenarios.push({ name: 'update', id: cloudId });
  await page.locator('.ant-message').waitFor({ state: 'hidden', timeout: 10000 });
  log('download/open cloud copy');
  const card = page.locator('app-cloud-space .item').filter({ hasText: 'Coder 云同步回归' });
  await card.hover(); await card.locator('.btns button:has(i.fa-folder-open)').click({ timeout: 5000 });
  await page.waitForFunction(source => window.ng.getComponent(document.querySelector('app-main-window')).projectService.currentProjectPath !== source, source, { timeout: 45000 });
  const downloaded = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-main-window')).projectService.currentProjectPath);
  await ready(downloaded);
  assert.equal(JSON.parse(await fs.readFile(path.join(downloaded, 'package.json'), 'utf8')).cloudId, cloudId);
  assert.ok((await fs.readFile(path.join(downloaded, 'sketch/src/main.cpp'), 'utf8')).includes('CODER_UPDATE'));
  assert.equal(await fs.readFile(path.join(downloaded, 'assets/中文资源.txt'), 'utf8'), 'Coder 资源\n');
  assert.equal(await fs.readFile(path.join(downloaded, 'sketch/libraries/Local/Local.h'), 'utf8'), '// local header\n');
  await edit('CODER_DOWNLOADED'); await sync(downloaded, cloudId, 'CODER_DOWNLOADED');
  evidence.scenarios.push({ name: 'download-edit-sync', project: downloaded, id: cloudId });
  await page.locator('.ant-message').waitFor({ state: 'hidden', timeout: 10000 });
  // The host retries a 503 once after its health check. Fail both attempts so
  // the user-facing failure and subsequent manual retry are exercised as well.
  failuresRemaining = 2; await edit('CODER_RETRY'); await sync(downloaded, cloudId, 'CODER_RETRY', true, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(downloaded, 'package.json'), 'utf8')).cloudId, cloudId);
  await page.locator('.ant-message').waitFor({ state: 'hidden', timeout: 10000 });
  const before = evidence.uploads.length; await page.locator('.sync-btn').click();
  await page.waitForFunction(() => !window.ng.getComponent(document.querySelector('app-cloud-space')).isSyncing && document.body.innerText.includes('同步成功'), undefined, { timeout: 45000 });
  assert.equal(evidence.uploads.length, before + 1); assert.equal(evidence.uploads.at(-1).id, cloudId);
  evidence.scenarios.push({ name: 'server-failure-retry', id: cloudId, failedAttempts: 2, recovered: true });
  log('legacy Coder package with leftover map');
  const legacyArchive = path.join(suite, 'legacy-coder.7z');
  await fs.writeFile(legacyArchive, projects.get(cloudId).archive);
  execFileSync(sevenZip, ['a', legacyArchive, 'project.abi', 'project.abs.map.json'], { cwd: source });
  projects.set('legacy-coder', { metadata: { ...projects.get(cloudId).metadata, id: 'legacy-coder', name: 'legacy-coder', nickname: 'Coder 旧云包' },
    archive: await fs.readFile(legacyArchive) });
  await page.evaluate(async () => window.ng.getComponent(document.querySelector('app-cloud-space')).getCloudProjects());
  const legacyCard = page.locator('app-cloud-space .item').filter({ hasText: 'Coder 旧云包' });
  await legacyCard.hover(); await legacyCard.locator('.btns button:has(i.fa-folder-open)').click({ timeout: 5000 });
  await page.waitForFunction(previous => window.ng.getComponent(document.querySelector('app-main-window')).projectService.currentProjectPath !== previous, downloaded, { timeout: 45000 });
  const legacy = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-main-window')).projectService.currentProjectPath);
  await ready(legacy);
  await assert.rejects(fs.stat(path.join(legacy, '.cloud-import-backup')), { code: 'ENOENT' });
  await edit('CODER_LEGACY'); await sync(legacy, 'legacy-coder', 'CODER_LEGACY');
  assert.deepEqual(await fs.readFile(path.join(legacy, 'project.abs.map.json')), localMirrors[2]);
  evidence.scenarios.push({ name: 'legacy-coder-map-isolation', project: legacy, mapPreserved: true, savedAndSynced: true });
  assert.deepEqual(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFile(path.join(source, file)))), localMirrors);
  assert.ok(evidence.lists.length >= 1); assert.equal(evidence.downloads.length, 2);
  await page.screenshot({ path: path.join(output, 'coder-cloud-complete.png') });
  evidence.ok = true; log('PASS', output);
}

try { await main(); }
catch (error) {
  evidence.ok = false; evidence.error = error.stack;
  if (page) await page.screenshot({ path: path.join(output, 'failed.png') }).catch(() => {});
  throw error;
}
finally {
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  if (app) { const child = app.process(); await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  if (catalog) { catalog.closeAllConnections(); await new Promise(resolve => catalog.close(resolve)); }
}
