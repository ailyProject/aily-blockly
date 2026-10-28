import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { _electron } = require('playwright');
const seedRoot = process.env.AILY_SAVE_AS_SEED;
const coderRoot = process.env.AILY_SAVE_AS_CODER;
const libraryRoot = process.env.AILY_SAVE_AS_LIBRARIES || seedRoot;
assert.ok(seedRoot && coderRoot, 'Set AILY_SAVE_AS_SEED (installed platform root) and AILY_SAVE_AS_CODER (built editor repo).');
const artifactRoot = path.join(root, 'e2e/.artifacts/project-save-as');
fs.mkdirSync(artifactRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(artifactRoot, 'run-'));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
const link = (source, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(source, target, 'dir'); };
const until = async (probe, name, timeout = 90000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(150); } throw new Error('Timed out: ' + name); };
const checks = [];
console.log('Evidence: ' + output);
for (const mode of (process.env.AILY_SAVE_AS_MODES || 'blockly,coder').split(',')) {
  const work = path.join(output, mode), stage = path.join(work, 'app'), appdata = path.join(work, 'appdata');
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(root, 'electron'), path.join(stage, 'electron'), { recursive: true,
    filter: file => !path.relative(path.join(root, 'electron'), file).split(path.sep).some(part => ['node_modules', 'tests'].includes(part)) });
  link(path.join(root, 'node_modules'), path.join(stage, 'node_modules'));
  link(path.join(root, 'electron/node_modules'), path.join(stage, 'electron/node_modules'));
  link(path.join(root, 'child'), path.join(stage, 'child'));
  fs.copyFileSync(path.join(root, 'e2e/electron/fixtures/subapp-product-bootstrap.cjs'), path.join(stage, 'electron/bootstrap.cjs'));
  write(path.join(stage, 'package.json'), { ...require('./package.json'), main: 'electron/bootstrap.cjs' });
  const appRoot = path.join(appdata, 'npm-global/app');
  const manifest = JSON.parse(fs.readFileSync(path.join(coderRoot, 'package.json')));
  link(coderRoot, path.join(appRoot, 'node_modules', ...manifest.name.split('/')));
  const index = { dev: true, 'aily-coder-editor': { ...manifest.ailySubapp, package: manifest.name,
    version: manifest.version, app: { ...manifest.ailySubapp.app, autoInstall: false } } };
  write(path.join(appRoot, 'subapp-index.json'), index);
  write(path.join(appRoot, 'package.json'), { name: 'save-as-isolated', private: true, dependencies: { [manifest.name]: manifest.version } });
  const catalog = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', req.headers.origin || '*'); res.setHeader('access-control-allow-headers', '*');
    res.end(JSON.stringify(req.url === '/subapp-index.json' ? index : { status: 200, data: { id: 'save-as-test', nickname: 'Acceptance', groups: [] } }));
  });
  await new Promise(resolve => catalog.listen(0, '127.0.0.1', resolve));
  const configPath = path.join(stage, 'electron/config/config.json'), config = JSON.parse(fs.readFileSync(configPath));
  for (const region of Object.values(config.regions || {})) region.api_server = `http://127.0.0.1:${catalog.address().port}`;
  config.project_path = path.join(work, 'projects'); write(configPath, config);
  write(path.join(appdata, 'auth', `${mode === 'coder' ? 'coder' : 'blockly'}.json`), { access_token: 'isolated-save-as-test' });
  // Copy only small project dependencies; no user project or shared SDK is modified.
  const board = path.join(seedRoot, 'node_modules/@aily-project/board-arduino_uno');
  const source = path.join(work, 'A'), destination = path.join(work, 'B');
  fs.cpSync(path.join(board, mode === 'blockly' ? 'template' : 'template_arduino'), source, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))); pkg.name = 'source'; pkg.type = mode; pkg.cloudId = 'preserve-cloud';
  write(path.join(source, 'package.json'), pkg);
  for (const dependency of Object.keys(pkg.dependencies)) {
    const parts = dependency.split('/');
    const seed = fs.existsSync(path.join(seedRoot, 'node_modules', ...parts)) ? seedRoot : libraryRoot;
    fs.cpSync(path.join(seed, 'node_modules', ...parts), path.join(source, 'node_modules', ...parts), { recursive: true, dereference: true });
    fs.cpSync(path.join(seed, 'node_modules', ...parts), path.join(appdata, 'node_modules', ...parts), { recursive: true, dereference: true });
  }
  const boardDependencies = JSON.parse(fs.readFileSync(path.join(board, 'package.json'))).dependencies || {};
  for (const dependency of Object.keys(boardDependencies)) {
    const parts = dependency.split('/'), seed = path.join(seedRoot, 'node_modules', ...parts);
    if (fs.existsSync(seed)) fs.cpSync(seed, path.join(appdata, 'node_modules', ...parts), { recursive: true, dereference: true });
  }
  if (mode === 'coder') {
    fs.mkdirSync(path.join(source, 'sketch/src'), { recursive: true });
    fs.writeFileSync(path.join(source, 'sketch/src/main.cpp'), '// SAVED_SOURCE\nvoid setup() {}\nvoid loop() {}\n');
  }
  const testHome = path.join(work, 'home'); fs.mkdirSync(testHome);
  const { ELECTRON_RUN_AS_NODE, ...environment } = process.env;
  let application, main;
  const log = fs.createWriteStream(path.join(work, 'electron.log'));
  const record = data => { if (!log.writableEnded) log.write(data); };
  try {
    application = await _electron.launch({ executablePath: require('electron'), cwd: stage, timeout: 60000,
      args: [stage, '--serve', `--user-data-dir=${path.join(work, 'profile')}`],
      env: { ...environment, HOME: testHome, AILY_E2E: '1', AILY_APPDATA_PATH: appdata,
        AILY_PRODUCT_ACCEPTANCE_ROOT: work, AILY_BUILD_PRODUCT: mode, AILY_SUBAPP_INSTALL_ROOT: appRoot,
        AILY_SUBAPP_INDEX_URL: `http://127.0.0.1:${catalog.address().port}/subapp-index.json` } });
    application.process().stdout?.on('data', data => record(data)); application.process().stderr?.on('data', data => record(data));
    main = await until(async () => { for (const page of application.windows()) if (await page.locator('app-header').count().catch(() => 0)) return page; }, mode + ' main');
    main.on('console', event => record(`[renderer:${event.type()}] ${event.text()}\n`));
    main.on('pageerror', error => record(`[renderer-error] ${error.stack}\n`));
    await main.addLocatorHandler(main.getByText('跳过', { exact: true }), locator => locator.click());
    const opened = await main.evaluate(async source => window.ng.getComponent(document.querySelector('app-header')).projectService.projectOpen(source), source);
    assert.equal(opened, true, mode + ' opens source');
    if (mode === 'blockly') {
      await main.waitForFunction(source => window.ng.getComponent(document.querySelector('app-header')).projectService.getBlocklyProjectLoadStatus(source).ready, source, { timeout: 180000 });
      await main.evaluate(async () => {
        const header = window.ng.getComponent(document.querySelector('app-header'));
        const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'));
        await header.builderService?.stopPreprocess?.();
        const block = header.blocklyService.workspace.newBlock('text'); block.initSvg(); block.render(); block.setFieldValue('UNSAVED_COPY_757', 'TEXT');
      });
    } else {
      const frame = await until(() => main.frames().find(frame => frame.parentFrame() && frame.url().includes('nativeFsBridge=true')), 'Coder iframe', 180000);
      await until(async () => await frame.locator('.monaco-workbench').count(), 'Coder Workbench', 180000);
      const file = frame.getByText('main.cpp', { exact: true }).first();
      await file.waitFor({ state: 'visible', timeout: 90000 });
      await file.dblclick();
      await main.screenshot({ path: path.join(work, 'before-edit.png') });
      console.log('Coder frames:', frame.url(), await frame.locator('.monaco-editor textarea').evaluateAll(items => items.map(item => ({ label: item.getAttribute('aria-label'), readonly: item.readOnly }))));
      const input = frame.locator('.monaco-editor .view-lines').first(); await input.waitFor({ timeout: 60000 });
      await input.click(); await main.keyboard.press('Meta+a'); await main.keyboard.insertText('// UNSAVED_COPY_757\nvoid setup() {}\nvoid loop() {}\n');
      await until(() => main.evaluate(async () => {
        const frame = window.ng.getComponent(document.querySelector('app-code-editor-frame'));
        return frame && (await frame.requestCoderLifecycle('status')).dirtyAfter > 0;
      }), 'dirty Coder editor');
    }
    const savedFile = mode === 'blockly' ? 'project.abi' : 'sketch/src/main.cpp';
    const before = fs.readFileSync(path.join(source, savedFile));
    const manifestBefore = fs.readFileSync(path.join(source, 'package.json'));
    // Exercise the real shared header entry with a registered Chat running state.
    const busy = await main.evaluate(async () => {
      const header = window.ng.getComponent(document.querySelector('app-header'));
      const registry = header.projectService.application.aiOperationRegistry;
      registry.setActive('child-chat-run:save-as-test', true, { projectPath: header.projectService.currentProjectPath, sessionId: 'busy-test' });
      try { await header.process({ action: 'project-save-as' }); return document.body.innerText.includes('AI 任务正在运行'); }
      finally { registry.setActive('child-chat-run:save-as-test', false); }
    });
    assert.equal(busy, true, mode + ' AI running warning');
    await main.screenshot({ path: path.join(work, 'ai-busy.png') });
    await main.evaluate(async destination => {
      const service = window.ng.getComponent(document.querySelector('app-header')).projectService;
      const app = service.application, prepare = app.prepareProjectCopy.bind(app);
      app.prepareProjectCopy = async source => {
        console.log('COPY_PREPARE', source);
        const snapshot = await prepare(source);
        console.log('COPY_PREPARED');
        const write = snapshot.write.bind(snapshot);
        snapshot.write = async target => { console.log('COPY_WRITE', target); await write(target); console.log('COPY_WRITTEN'); };
        return snapshot;
      };
      try { await service.saveAs(destination); }
      catch (error) { console.error('SAVE_AS_ERROR', error.stack); throw error; }
    }, destination);
    assert.deepEqual(fs.readFileSync(path.join(source, savedFile)), before, mode + ' source bytes');
    assert.deepEqual(fs.readFileSync(path.join(source, 'package.json')), manifestBefore, mode + ' source manifest');
    assert.match(fs.readFileSync(path.join(destination, savedFile), 'utf8'), /UNSAVED_COPY_757/);
    const copied = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')));
    assert.equal(copied.cloudId, undefined); assert.equal(copied.nickname, 'B');
    const active = await main.evaluate(() => window.ng.getComponent(document.querySelector('app-header')).projectService.currentProjectPath);
    assert.equal(active, destination);
    if (mode === 'blockly') {
      await main.waitForFunction(destination => window.ng.getComponent(document.querySelector('app-header')).projectService.getBlocklyProjectLoadStatus(destination).ready, destination, { timeout: 180000 });
      assert.match(fs.readFileSync(path.join(destination, 'project.abs'), 'utf8'), /UNSAVED_COPY_757/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'project.abs.map.json'))).scope.projectKey, destination);
    }
    if (mode === 'coder') {
      const clean = await main.evaluate(async source => {
        const service = window.ng.getComponent(document.querySelector('app-header')).coderPersistence;
        return service ? await service.hasSavedProject(source, true) : null;
      }, source);
      assert.equal(clean, true, 'Transferred Coder source buffers are clean after activation');
    }
    await main.screenshot({ path: path.join(work, 'saved-copy.png') });
    checks.push({ mode, sourceUnchanged: true, dirtySnapshotInCopy: true, aiBusyBlocked: true, activatedCopy: true });
    console.log(mode + ': PASS');
  } finally {
    if (main) await main.evaluate(async () => {
      const frames = [...document.querySelectorAll('app-code-editor-frame')];
      if (frames.length) await window.ng.getComponent(frames[0]).childToolProcess.forceStop('aily-coder-editor');
      const header = window.ng.getComponent(document.querySelector('app-header'));
      if (header) await header.projectService.close({ save: false });
    }).catch(() => {});
    if (application) { await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); await application.close().catch(() => {}); }
    catalog.close(); log.end(); write(path.join(output, 'result.json'), { checks });
  }
}
