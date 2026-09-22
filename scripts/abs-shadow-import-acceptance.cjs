// Real cloud entry + isolated installed dependencies. Never changes the cloud
// archive, user projects, the daily SDK or the installed Chat bundle.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { _electron } = require('playwright');
const { createPackagedRendererServer } = require('../electron/packaged-renderer-server');
const [fixture, inputs, chat, agent] = process.argv.slice(2);
for (const value of [fixture, inputs, chat, agent]) assert.ok(value && path.isAbsolute(value));
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-shadow-acceptance-'));
const appData = path.join(root, 'app-data');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const sha = value => createHash('sha256').update(value).digest('hex');
const fixtureHash = sha(read(path.join(fixture, 'project.abi')));
let original, originalHash;
const report = { root, fixtureHash, assertions: [], errors: [], calls: [] };
const renderer = createPackagedRendererServer();
let app, page, client, project, phase = 'prepare';
const mark = value => { phase = value; console.log('PHASE=' + value); };
const pass = value => { report.assertions.push(value); console.log('PASS=' + value); };
const list = document => {
  const result = [], stack = [...(document.blocks?.blocks || document.pages?.flatMap(p => p.content.blocks?.blocks || []) || []), ...(document.sharedModel?.procedureBlocks || [])];
  while (stack.length) {
    const block = stack.pop(); result.push(block);
    for (const input of Object.values(block.inputs || {})) { if (input.block) stack.push(input.block); if (input.shadow) stack.push(input.shadow); }
    if (block.next?.block) stack.push(block.next.block);
  }
  return result;
};
const checkIds = document => { const blocks = list(document); assert.equal(new Set(blocks.map(b => b.id)).size, blocks.length); return blocks.length; };
const mirrors = () => Object.fromEntries(['project.abi', 'project.abs', 'project.abs.map.json'].map(name => [name,
  fs.existsSync(path.join(project, name)) ? sha(read(path.join(project, name))) : null]));
async function ready() {
  await page.waitForFunction(() => {
    const element = document.querySelector('app-blockly-editor');
    const c = element && window.ng?.getComponent(element);
    return c?.projectService.getBlocklyProjectLoadStatus(c.projectService.currentProjectPath)?.ready
      && c.blocklyService.workspace?.getAllBlocks(false).length > 1000
      && c.blocklyService.workspace !== window.previousShadowWorkspace
      && c.blocklyService.getGeneratedCode().length > 0;
  }, undefined, { timeout: 180000 });
}
async function snapshot() {
  return JSON.parse(await page.evaluate(() => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return JSON.stringify({ document: c.blocklyService.getProjectDocument(), code: c.blocklyService.getGeneratedCode() });
  }));
}
async function tool(name, args = {}) {
  mark(name); const start = Date.now();
  const response = await client.callTool({ name, arguments: { project, ...args } }, undefined, { timeout: 240000 });
  const value = response.structuredContent ?? JSON.parse(response.content.find(c => c.type === 'text').text);
  report.calls.push({ name, ms: Date.now() - start, result: value }); assert.equal(value.ok, true, JSON.stringify(value));
  return value;
}
async function main() {
  console.log('ROOT=' + root);
  fs.mkdirSync(appData);
  const marker = json(path.join(inputs, 'abs-acceptance-build-inputs.json'));
  assert.equal(marker.completed, true); assert.equal(path.resolve(marker.ownedRoot), path.resolve(inputs));
  for (const entry of ['sdk', 'tools', 'npm-global']) fs.symlinkSync(path.join(inputs, entry), path.join(appData, entry), 'junction');
  fs.cpSync(path.join(inputs, 'node_modules'), path.join(appData, 'node_modules'), { recursive: true });
  const config = json(path.join(repo, 'electron/config/config.json'));
  config.project_path = root; config.appdata_path[process.platform] = appData;
  fs.writeFileSync(path.join(appData, 'config.json'), JSON.stringify(config));
  await renderer.start({ rootDirectory: path.join(repo, 'dist/aily-blockly/browser') });
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(root, 'profile')}`], cwd: repo,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, PI_CODING_AGENT_DIR: path.join(root, 'agent-state') }, timeout: 60000 });
  await app.context().route('http://localhost:4200/**', route => route.fulfill({ status: 302, headers: { location: renderer.rendererUrl('/main/playground/list') } }));
  for (let i = 0; i < 300 && !page; i++) {
    for (const win of app.windows()) if (await win.locator('app-main-window').count().catch(() => 0)) { page = win; break; }
    if (!page) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(page);
  await app.evaluate((_, cache) => { process.env.AILY_BUILDER_PATH = cache; }, path.join(root, 'builder-cache'));
  page.on('pageerror', error => report.errors.push({ phase, message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ phase, message: message.text() }); });
  await page.exposeFunction('seedShadowDependencies', target => {
    const relative = path.relative(root, path.resolve(target));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    // Test setup only: cached registry dependencies, before the untouched loader.
    if (!fs.existsSync(path.join(target, 'node_modules'))) fs.cpSync(path.join(fixture, 'node_modules'), path.join(target, 'node_modules'), { recursive: true, dereference: true });
    project = target; report.project = project;
  });
  await page.exposeFunction('recordShadowSource', text => {
    assert.equal(original, undefined, 'Capture the download before its first normalization');
    original = JSON.parse(text); originalHash = sha(text);
    report.originalHash = originalHash;
    report.originalCounts = { blocks: list(original).length, variables: original.variables.length };
    assert.equal(list(original).length - new Set(list(original).map(b => b.id)).size, 95);
    fs.writeFileSync(path.join(root, 'downloaded-original.abi'), text);
  });
  await page.goto(renderer.rendererUrl('/main/playground/list'));
  await page.waitForFunction(() => {
    const element = document.querySelector('app-example-list');
    return element && window.ng?.getComponent(element);
  });
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click(); };
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss();
    const component = window.ng.getComponent(document.querySelector('app-example-list'));
    window.shadowProject = component.projectService;
    const initialize = component.projectService.initializeProjectDataSchema.bind(component.projectService);
    component.projectService.initializeProjectDataSchema = async (...args) => {
      await window.recordShadowSource(window.fs.readFileSync(args[0] + '/project.abi', 'utf8'));
      return initialize(...args);
    };
    const open = component.projectService.projectOpen.bind(component.projectService);
    component.projectService.projectOpen = async (...args) => { await window.seedShadowDependencies(args[0]); return open(...args); };
  });
  mark('cloud-project-302');
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-example-list')).exampleList.some(item => item.id === 302), undefined, { timeout: 60000 });
  report.cloud = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-example-list')).exampleList.find(item => item.id === 302));
  const row = page.locator('.example-item').filter({ hasText: 'ESP32S3小智AI小狗' });
  await row.locator('.load-btn').click();
  await ready();
  pass('Cloud project 302 loaded through the real project-square download/import/open entry');
  const migrated = JSON.parse(await page.evaluate(async () => {
    const service = window.shadowProject, project = service.currentProjectPath;
    const text = window.fs.readFileSync(project + '/project.abi', 'utf8');
    return JSON.stringify(await service.ensureProjectDataSchemaForLoad(project, JSON.parse(text), text));
  }));
  assert.equal(checkIds(migrated), report.originalCounts.blocks);
  assert.equal(migrated.variables.length, report.originalCounts.variables);
  const oldBlocks = list(original), newBlocks = list(migrated);
  const changes = newBlocks.filter((b, i) => b.id !== oldBlocks[i].id);
  assert.equal(changes.length, 95); assert.ok(changes.every(b => b.type === 'math_number' && b.fields.NUM === 1500));
  report.migratedIds = changes.map(b => b.id);
  const restored = JSON.parse(JSON.stringify(migrated));
  list(restored).forEach((b, i) => { b.id = oldBlocks[i].id; }); delete restored.$ailyProjectData;
  assert.deepEqual(restored, original);
  const backups = fs.readdirSync(path.join(project, '.aily/project-data-backups'));
  assert.ok(backups.some(file => sha(read(path.join(project, '.aily/project-data-backups', file))) === originalHash));
  pass(`${report.originalCounts.blocks} blocks / ${report.originalCounts.variables} models retained; exactly 95 hidden IDs migrated, all other materialized data unchanged, original backed up`);
  const agentRequire = createRequire(path.join(agent, 'package.json'));
  const { Client } = agentRequire('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = agentRequire('@modelcontextprotocol/sdk/client/stdio.js');
  client = new Client({ name: 'shadow-import-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: path.join(repo, 'child/node/node.exe'), args: [path.join(chat, 'runtime/mcp/cli.js')], cwd: project,
    env: { ...env, AILY_APPDATA_PATH: appData, AILY_PORTABLE_ROOT: chat, PI_PACKAGE_DIR: path.join(chat, 'runtime/pi-package'), PI_CODING_AGENT_DIR: path.join(root, 'agent-state') }, stderr: 'pipe' });
  await client.connect(transport); transport.stderr?.on('data', () => {});
  const initial = await snapshot();
  const exported = await tool('abs_export', { initialize: true });
  await tool('abs_apply', { generation: exported.generation, abs: exported.abs, chunk: true });
  await tool('project_save');
  const before = await snapshot(), files = mirrors();
  assert.equal(checkIds(before.document), report.originalCounts.blocks);
  assert.deepEqual(idsByType(before.document), idsByType(initial.document));
  assert.deepEqual(semanticDocument(before.document), semanticDocument(initial.document));
  assert.ok(before.code.length > 0); assert.equal(before.code, initial.code);
  for (const id of report.migratedIds) assert.ok(list(before.document).some(b => b.id === id));
  mark('reopen');
  await page.evaluate(async () => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    window.previousShadowWorkspace = c.blocklyService.workspace;
    const service = window.shadowProject, project = service.currentProjectPath;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Reopen failed');
  });
  await ready();
  const after = await snapshot();
  assert.deepEqual(idsByType(after.document), idsByType(before.document));
  assert.deepEqual(semanticDocument(after.document), semanticDocument(before.document));
  report.codeGenerationStable = after.code === before.code;
  if (!report.codeGenerationStable) {
    fs.writeFileSync(path.join(root, 'code-on-reopen.cpp'), after.code);
    const repeated = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))
      .blocklyService.runWithPreparedProjectCode(prepared => prepared.code, true));
    fs.writeFileSync(path.join(root, 'code-after-repeat.cpp'), repeated);
    assert.equal(repeated, before.code, 'Repeated generation must recover the exact pre-reopen code without changing Blockly');
    report.followUp = 'Cold library generator differs from repeated generation; see captured C++. Identity acceptance does not certify cold generation.';
    console.log('FOLLOW_UP=' + report.followUp);
  }
  assert.deepEqual(mirrors(), files);
  pass('Installed Chat ABS export/apply, save and reopen preserve migrated identities and ABI/ABS/map bytes');
  mark('native-context-menu-copy');
  report.copy = JSON.parse(await page.evaluate(async () => {
    const c = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const b = window.Blockly, workspace = c.blocklyService.workspace;
    const flush = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    await flush(); workspace.clearUndo();
    const original = workspace.getAllBlocks(false).find(block => block.type === 'servo_write_microseconds'
      && block.getInput('MICROSECONDS')?.connection?.getShadowState());
    if (!original) throw new Error('Expected the real covered servo default');
    const occupied = new Set(workspace.getAllBlocks(false).map(block => block.id));
    b.ContextMenuRegistry.registry.getItem('blockDuplicate').callback({ block: original });
    await flush();
    const copied = workspace.getAllBlocks(false).find(block => !occupied.has(block.id) && block.type === original.type);
    if (!copied) throw new Error('Context-menu duplicate did not create a servo block');
    const connection = copied.getInput('MICROSECONDS').connection;
    const fallback = connection.getShadowState().id;
    const copiedState = b.serialization.blocks.save(copied);
    b.Events.setGroup(true);
    connection.targetBlock().outputConnection.disconnect();
    b.Events.setGroup(false);
    await flush();
    const visibleDefault = copied.getInputTargetBlock('MICROSECONDS');
    if (visibleDefault.id !== fallback || !visibleDefault.isShadow() || visibleDefault.getFieldValue('NUM') !== 1500) {
      throw new Error('Copied fallback did not preserve its identity/value when uncovered');
    }
    workspace.undo(false); await flush();
    if (JSON.stringify(b.serialization.blocks.save(copied)) !== JSON.stringify(copiedState)) throw new Error('Unplug undo changed copied state');
    workspace.undo(false); await flush();
    if (workspace.getBlockById(copiedState.id)) throw new Error('Copy undo retained a copied block');
    workspace.undo(true); await flush();
    const redone = workspace.getBlockById(copiedState.id);
    if (JSON.stringify(b.serialization.blocks.save(redone)) !== JSON.stringify(copiedState)) throw new Error('Redo changed copied identities');
    workspace.undo(false); await flush();
    return JSON.stringify({ root: copiedState.id, fallback, sourceFallback: original.getInput('MICROSECONDS').connection.getShadowState().id,
      restored: c.blocklyService.getProjectDocument() });
  }));
  assert.notEqual(report.copy.fallback, report.copy.sourceFallback);
  assert.equal(checkIds(report.copy.restored), report.originalCounts.blocks);
  assert.deepEqual(semanticDocument(report.copy.restored), semanticDocument(after.document));
  delete report.copy.restored;
  pass('Real project context-menu duplicate, uncovered 1500 default, undo and redo preserve distinct identities and restore the original graph');
  await page.screenshot({ path: path.join(root, 'accepted.png'), fullPage: true });
  report.success = true;
}
function idsByType(document) { return list(document).map(b => [b.id, b.type]).sort((a, b) => a[0].localeCompare(b[0])); }
function semanticDocument(document) {
  const blocks = {};
  const visit = (block, parent = null, edge = null) => {
    const { inputs, next, x, y, ...attributes } = block;
    assert.equal(blocks[block.id], undefined);
    blocks[block.id] = { ...attributes, parent, edge };
    for (const [name, input] of Object.entries(inputs || {})) for (const kind of ['block', 'shadow']) {
      if (input[kind]) visit(input[kind], block.id, `${name}:${kind}`);
    }
    if (next?.block) visit(next.block, block.id, 'next');
  };
  for (const page of document.pages || [{ content: document }]) for (const block of page.content.blocks?.blocks || []) visit(block);
  for (const block of document.sharedModel?.procedureBlocks || []) visit(block);
  return { blocks, variables: document.sharedModel?.variables || document.variables || [] };
}
main().catch(async error => {
  report.success = false; report.error = error.stack; console.error(error); process.exitCode = 1;
  await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  await client?.close().catch(() => {});
  await app?.evaluate(({ app }) => app.quit()).catch(() => {});
  await renderer.close();
  report.originalUnchanged = fixtureHash === sha(read(path.join(fixture, 'project.abi')));
  if (!report.originalUnchanged) { report.success = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log('RESULT=' + path.join(root, 'result.json'));
});
