const { _electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createPackagedRendererServer } = require('../electron/packaged-renderer-server');
const { startAgentPublication } = require('../electron/test/project-agent-process.cjs');
const { startPreparedAgent } = require('../electron/test/project-agent-prepared.cjs');
const { testAgentHostProjection, testAgentHostCandidate } = require('../electron/test/project-agent-host-projection.cjs');
const { testWorkspaceGeneration } = require('./project-data-generation-smoke.cjs');
const { testGenerationRebinding } = require('./project-data-rebind-smoke.cjs');
const { testVariableGeneration } = require('./project-data-variable-smoke.cjs');
const { prepareLinkedChatProfile, testLinkedChat } = require('./project-data-linked-chat-smoke.cjs');
const { testProcedureGeneration } = require('./project-data-procedure-smoke.cjs');
const { testLlmGeneration } = require('./project-data-llm-smoke.cjs');
const { testLlmNativeCreation } = require('./project-data-llm-native-smoke.cjs');
const { testLlmAssets } = require('./project-data-llm-assets-smoke.cjs');
const { prepareBuildProfile } = require('./project-data-build-profile.cjs');
const { testLinkedChatDisconnect, testDataAbsContext } = require('./project-data-context-smoke.cjs');
const { testStructuralGeneration } = require('./project-data-structural-smoke.cjs');
const { testFieldShapeGeneration } = require('./project-data-field-shape-smoke.cjs');
const { testNativeInstances } = require('./project-data-native-instance-smoke.cjs');
const { testNativeCreation } = require('./project-data-native-creation-smoke.cjs');
const { testNativeCandidateIsolation } = require('./project-data-native-candidate-smoke.cjs');
const { testRandomLibraries } = require('./project-data-random-library-smoke.cjs');

// Uses the real main.js, full preload, Angular page and installed project libraries.
// Serve the current development build with the application's own loopback server.
// Route this isolated browser context's dev bootstrap to its own built renderer;
// no dependency on or mutation of the user's localhost:4200 development server.
// All writable state lives in a new temp root; no existing renderer folder is staged/deleted.
const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error('Pass an absolute, installed source project path.');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-project-data-ui-'));
const archive = path.join(root, 'archive');
const seed = path.join(archive, 'project');
const destination = path.join(root, 'Imported Project');
const appData = path.join(root, 'app-data');
const profile = path.join(root, 'profile');
// Chat has its own persistence root, independent of the host app-data directory.
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent-state');
const hash = text => createHash('sha256').update(text).digest('hex');
const originalHash = hash(fs.readFileSync(path.join(source, 'project.abi')));
fs.mkdirSync(seed, { recursive: true }); fs.mkdirSync(appData);
for (const name of ['package.json', 'package-lock.json', 'project.abi', 'assets', 'node_modules', 'src']) {
  if (fs.existsSync(path.join(source, name))) fs.cpSync(path.join(source, name), path.join(seed, name), { recursive: true, dereference: true });
}
const seedAbi = JSON.parse(fs.readFileSync(path.join(seed, 'project.abi'), 'utf8'));
seedAbi.blocks.blocks.push({ type: 'text', id: 'project_data_smoke_text', x: 480, y: 60, fields: { TEXT: 'before' } });
fs.writeFileSync(path.join(seed, 'project.abi'), JSON.stringify(seedAbi));
fs.mkdirSync(path.join(seed, '.aily'));
fs.writeFileSync(path.join(seed, '.aily/project-files.write.lock'), 'archive owner - must not be copied');
const linkedChat = process.env.AILY_ABS_AUTH_SOURCE
  ? prepareLinkedChatProfile(appData, process.env.AILY_ABS_AUTH_SOURCE, process.env.AILY_AGENT_ROOT, process.env.AILY_ABS_AUTH_FILE) : undefined;
const config = linkedChat?.config ?? JSON.parse(fs.readFileSync(path.join(repo, 'electron/config/config.json'), 'utf8'));
config.project_path = root; config.appdata_path[process.platform] = appData;
fs.writeFileSync(path.join(appData, 'config.json'), JSON.stringify(config));
const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
let app; let page; let preparedAgent;
const renderer = createPackagedRendererServer();
const errors = [];
const report = { root, source, originalHash, assertions: [] };
let phase = 'startup';
const setPhase = value => { phase = value; console.log('PHASE=' + value); };
const record = message => { report.assertions.push(message); console.log(message); };
const large = 'Project Data 通用大文本 😀\n'.repeat(1800);
const edited = large + 'Saved through the real editor';

async function main() {
  console.log('TEMP_ROOT=' + root);
  if (process.env.AILY_ABS_LLM_ONLY === '1') {
    assert.ok(linkedChat, 'LLM test requires explicitly supplied copied authentication');
    report.buildProfile = prepareBuildProfile(appData, process.env.AILY_ABS_AUTH_SOURCE, seed);
  }
  await renderer.start({ rootDirectory: path.join(repo, 'dist/aily-blockly/browser') });
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${profile}`], cwd: repo,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData }, timeout: 60000 });
  await app.context().route('http://localhost:4200/**', route => route.fulfill({
    status: 302, headers: { location: renderer.rendererUrl('/main/guide') },
  }));
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) {
    for (const win of app.windows()) {
      if (await win.locator('app-main-window').count().catch(() => 0)) { page = win; break; }
    }
    if (!page) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(page, 'Real main window must be present');
  if (process.env.AILY_ABS_LLM_ONLY === '1') {
    // Explicit project --build-path still owns the firmware; isolate Builder's optional shared caches too.
    await app.evaluate((_, cachePath) => { process.env.AILY_BUILDER_PATH = cachePath; }, path.join(root, 'builder-cache'));
  }
  const captureError = (kind, message) => errors.push({ phase, at: new Date().toISOString(), kind, message });
  page.on('pageerror', error => captureError('pageerror', error.message));
  page.on('console', message => { if (message.type() === 'error') captureError('console', message.text()); });
  await page.goto(renderer.rendererUrl('/main/guide'));
  await page.waitForFunction(() => !!document.querySelector('app-header') && !!window.ng?.getComponent, undefined, { timeout: 60000 });
  await page.evaluate(() => {
    const dismiss = () => document.querySelector('app-onboarding .btn-skip')?.click();
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss();
    for (const selector of ['app-header', 'app-guide', 'app-main-window']) {
      const node = document.querySelector(selector); const component = node && window.ng?.getComponent(node);
      if (typeof component?.projectService?.importProjectDirectory === 'function') { window.projectDataSmokeService = component.projectService; break; }
    }
    if (!window.projectDataSmokeService) throw new Error('ProjectService is unavailable on the actual page');
    if (typeof window.fs?.importProjectDirectory !== 'function') throw new Error('Full preload is stale');
  });
  await dismissLogin();
  record('Real application page and full preload are ready');
  if (linkedChat) {
    report.linkedChat = await testLinkedChat(page, root, linkedChat.chatRoot);
    // Preparation can take minutes: recheck after loading, not only before copying SDKs.
    report.linkedChat.resourceParity = linkedChat.assertResourcesCurrent();
    linkedChat.assertSourceUnchanged();
    record('Main application restored the copied login and opened the workspace lex-pro in its embedded child window');
  }
  if (process.env.AILY_ABS_DISCONNECT_SMOKE === '1') {
    assert.ok(linkedChat, 'Disconnect smoke requires the isolated linked Chat');
    assert.equal(errors.length, 0, 'Clean startup must not report page errors');
    setPhase('catalog-disconnect');
    report.catalogDisconnect = await testLinkedChatDisconnect(page);
    assert.equal(errors.length, 0, 'Controlled disconnect must not leak unhandled rejections');
    setPhase('selected-context');
  }
  if (process.env.AILY_ABS_STRUCTURAL_ONLY === '1') {
    setPhase('structural-mutators');
    report.structuralGeneration = await testStructuralGeneration(page, seed, root);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    record('Actual Agent tools created and reshaped installed dynamic blocks; generated C++, mirrors and protected roots survived reopen; source ABI unchanged');
    await page.screenshot({ path: path.join(root, 'project-data-page.png'), fullPage: true });
    report.success = true; return;
  }
  if (process.env.AILY_ABS_RANDOM_LIBRARIES_ONLY === '1') {
    setPhase('random-libraries');
    report.randomLibraries = await testRandomLibraries(page, seed, root);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    report.success = report.randomLibraries.passed === report.randomLibraries.results.length && errors.length === 0;
    if (!report.success) process.exitCode = 1;
    record('Random library audit completed; per-library failures and real LLM-facing tool responses retained');
    return;
  }
  if (process.env.AILY_ABS_NATIVE_CANDIDATE_ONLY === '1') {
    setPhase('native-candidate');
    report.nativeCandidate = await testNativeCandidateIsolation(page, seed, root, repo);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    record('Independent native candidate created dynamic fields; failures, globals and models stayed isolated; host workspace and mirrors unchanged');
    await page.screenshot({ path: path.join(root, 'project-data-page.png'), fullPage: true });
    report.success = true; return;
  }
  if (process.env.AILY_ABS_NATIVE_CREATION_ONLY === '1') {
    setPhase('native-creation');
    report.nativeCreation = await testNativeCreation(page, seed, root);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    record('Actual Agent created native dynamic blocks, reshaped twice, saved and reopened without pre-seeded instances');
    await page.screenshot({ path: path.join(root, 'project-data-page.png'), fullPage: true });
    report.success = true; return;
  }
  if (process.env.AILY_ABS_NATIVE_INSTANCES_ONLY === '1') {
    setPhase('native-instances');
    report.nativeInstances = await testNativeInstances(page, seed, root);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    record('Actual Agent edited native DHT/MAX31865 instances without source recipes; state, C++ and mirrors survived reopen');
    await page.screenshot({ path: path.join(root, 'project-data-page.png'), fullPage: true });
    report.success = true; return;
  }
  if (process.env.AILY_ABS_FIELD_SHAPE_ONLY === '1' || process.env.AILY_ABS_CONDITIONAL_ONLY === '1') {
    const mode = process.env.AILY_ABS_CONDITIONAL_ONLY === '1' ? 'conditional' : 'field-shape';
    setPhase(mode);
    report.fieldShapeGeneration = await testFieldShapeGeneration(page, seed, root, mode);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    record('Actual Agent tools created UI-extended and field-dependent blocks, removed/restored inputs, generated C++, and preserved ABI/ABS/map and protected roots after reopen; source unchanged');
    await page.screenshot({ path: path.join(root, 'project-data-page.png'), fullPage: true });
    report.success = true; return;
  }
  if (process.env.AILY_ABS_VARIABLE_ONLY === '1') {
    report.variableOnly = true;
    report.variableGeneration = await testVariableGeneration(page, seed, root);
    if (process.env.AILY_ABS_DISCONNECT_SMOKE === '1') report.dataContext = await testDataAbsContext(page, seed, root);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    record('Variable-only real-page check used an empty installed board template and actual Agent tools; source ABI unchanged');
    await page.screenshot({ path: path.join(root, 'project-data-page.png'), fullPage: true });
    report.success = true; return;
  }
  if (process.env.AILY_ABS_LLM_ONLY === '1') {
    if (process.env.AILY_ABS_LLM_NATIVE_ONLY === '1') report.llmNative = await testLlmNativeCreation(page, seed, root, setPhase);
    else if (process.env.AILY_ABS_LLM_DATA_ONLY === '1') report.llmAssets = await testLlmAssets(page, seed, root, setPhase);
    else report.llmGeneration = await testLlmGeneration(page, seed, root, setPhase);
    report.linkedChat.llmTurnTested = true;
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    record('Real LLM edited ABS, built with the host compiler and preserved models, protected roots and external data after reopen');
    report.success = true; return;
  }
  if (process.env.AILY_ABS_PROCEDURE_ONLY === '1') {
    report.procedureOnly = true;
    report.procedureGeneration = await testProcedureGeneration(page, seed, root);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    record('Procedure-only real-page check passed creation, parameter change, repeat edit, save and reopen');
    report.success = true; return;
  }
  await page.evaluate(async ({ archive, destination, large }) => {
    const service = window.projectDataSmokeService;
    service.importProjectDirectory(archive, destination, true);
    await service.initializeProjectDataSchema(destination, () => {}, { project_data_smoke_text: large });
  }, { archive, destination, large });
  const migrated = JSON.parse(fs.readFileSync(path.join(destination, 'project.abi'), 'utf8'));
  const dataBlock = migrated.blocks.blocks.find(block => block.id === 'project_data_smoke_text');
  assert.ok(dataBlock.fields.TEXT.$ailyProjectDataValue);
  assert.ok(!fs.existsSync(path.join(destination, '.aily/project-files.write.lock')));
  const backup = path.join(destination, '.aily/project-data-backups', hash(fs.readFileSync(path.join(seed, 'project.abi'))) + '.abi');
  assert.deepEqual(fs.readFileSync(backup), fs.readFileSync(path.join(seed, 'project.abi')));
  record('Archive import filtered the lock; large parameters were externalized with an exact original backup');
  await page.evaluate(async destination => {
    if (!await window.projectDataSmokeService.projectOpen(destination)) throw new Error('Project open failed');
  }, destination);
  await waitForProject();
  const loaded = await page.evaluate(() => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const workspace = component.blocklyService.workspace;
    return { value: workspace.getBlockById('project_data_smoke_text').getFieldValue('TEXT'),
      roots: ['arduino_global_id0', 'arduino_setup_id0', 'arduino_loop_id0'].map(id => ({ id, deletable: workspace.getBlockById(id).isDeletable() })) };
  });
  assert.equal(loaded.value, large); assert.ok(loaded.roots.every(block => !block.deletable));
  record('Real Blockly page restored the entire large field and retained protected root IDs');
  if (process.env.AILY_AGENT_ROOT) {
    const release = await startAgentPublication(destination, process.env.AILY_AGENT_ROOT);
    let settled = false;
    const publication = page.evaluate(async destination => {
      await window.projectDataSmokeService.initializeProjectDataSchema(destination);
    }, destination).finally(() => { settled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(settled, false, 'The actual preload must wait for the independent Agent transaction');
    } finally { assert.equal((await release()).status, 'COMMITTED'); }
    await publication;
    record('Real Electron preload waited for the independent Agent history lock and resumed after its commit');
  }
  if (process.env.AILY_AGENT_ROOT) {
    const beforeAbi = fs.readFileSync(path.join(destination, 'project.abi'));
    const absPath = path.join(destination, 'project.abs');
    const beforeAbs = fs.existsSync(absPath) ? fs.readFileSync(absPath) : null;
    preparedAgent = await startPreparedAgent(destination, process.env.AILY_AGENT_ROOT);
    const { exported, imported } = preparedAgent.prepared;
    assert.equal(exported.ok, false); assert.equal(exported.code, 'ABS_HOST_REQUIRED');
    assert.equal(imported.ok, false); assert.equal(imported.code, 'ABS_HOST_REQUIRED');
    assert.deepEqual(fs.readFileSync(path.join(destination, 'project.abi')), beforeAbi);
    assert.deepEqual(fs.existsSync(absPath) ? fs.readFileSync(absPath) : null, beforeAbs);
    report.agentCapabilities = { exported, imported };
    record('Current Agent refused lossy Project Data export and nonempty offline import; original mirrors were retained');
  }
  await page.evaluate(async ({ edited, destination }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    component.blocklyService.workspace.getBlockById('project_data_smoke_text').setFieldValue(edited, 'TEXT');
    const result = await window.projectDataSmokeService.save(destination);
    if (!result.success) throw new Error(result.error || 'Real editor save failed');
  }, { edited, destination });
  const saved = fs.readFileSync(path.join(destination, 'project.abi'), 'utf8');
  assert.ok(!saved.includes('Saved through the real editor'));
  if (preparedAgent) {
    const stale = await preparedAgent.release();
    assert.equal(stale.status, 'REJECTED'); assert.match(stale.error, /workspace changed/);
    assert.equal(fs.readFileSync(path.join(destination, 'project.abi'), 'utf8'), saved);
    report.agentStaleWrite = stale;
    record('Real page save changed ABI; independent Agent stale direct write was rejected without undoing the save');
  }
  record('Actual project save persisted compact ABI and a new immutable payload');
  if (process.env.AILY_AGENT_ROOT) {
    report.hostProjection = await testAgentHostProjection(destination, process.env.AILY_AGENT_ROOT);
    record('Actual Agent abs_export, project_save and blocks_tidy used authenticated host projection receipts with Project Data preserved');
  }
  await page.evaluate(async destination => {
    const service = window.projectDataSmokeService;
    if (!await service.close()) throw new Error('Project close was rejected');
    if (!await service.projectOpen(destination)) throw new Error('Project reopen failed');
  }, destination);
  await waitForProject();
  assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))
    .blocklyService.workspace.getBlockById('project_data_smoke_text').getFieldValue('TEXT')), edited);
  assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
  record('Close/reopen restored edited text exactly; original user ABI remained unchanged');
  if (process.env.AILY_ABS_GENERATION_SMOKE === '1') {
    report.workspaceGeneration = await testWorkspaceGeneration(page, destination);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    record('Actual v2 coordinator preserved original IDs/protection/models through large-text chunk application, common generation commit and reopen');
    report.generationRebinding = await testGenerationRebinding(page, destination);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    record('Actual Agent tools rebound a copied project, repaired its map, switched page scope both ways, applied and reopened without altering source files');
    report.variableGeneration = await testVariableGeneration(page, destination);
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    record('Actual Agent created a variable model, declaration and references from an empty board template; second edit, C++ generation and reopen preserved its identity');
  } else if (process.env.AILY_AGENT_ROOT) {
    try { report.hostCandidate = await testAgentHostCandidate(destination, process.env.AILY_AGENT_ROOT); }
    catch (error) {
      report.hostCandidateFailure = await page.evaluate(edited => {
        const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
        const values = editor.workspace.getAllBlocks(false).map(block => block.getFieldValue('TEXT'));
        return { memoryVariables: editor.captureProjectSnapshot().document.sharedModel.variables,
          largeTextPresent: values.includes(edited), addedBlockPresent: values.includes('Host candidate applied 中文😀') };
      }, edited);
      report.hostCandidateFailure.diskVariables = JSON.parse(fs.readFileSync(path.join(destination, 'project.abi'), 'utf8')).sharedModel.variables;
      throw error;
    }
    const checkCandidate = () => page.waitForFunction(edited => {
      const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
      if (!component?.projectService.getBlocklyProjectLoadStatus(component.projectService.currentProjectPath)?.ready) return false;
      const values = component.blocklyService.workspace.getAllBlocks(false).map(block => block.getFieldValue('TEXT'));
      return values.includes(edited) && values.includes('Host candidate applied 中文😀');
    }, edited, { timeout: 90000 });
    await checkCandidate();
    const abiBeforeRepeat = fs.readFileSync(path.join(destination, 'project.abi'), 'utf8');
    report.preparedGeneration = await page.evaluate(async destination => {
      const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
      const editor = component.blocklyService;
      const before = editor.captureProjectSnapshot().revision;
      const result = await window.projectDataSmokeService.save(destination);
      if (!result.success) throw new Error(result.error || 'Repeated save failed');
      const saved = await component._projectService.getAbiRevisionSnapshot();
      const after = editor.captureProjectSnapshot().revision;
      const code = editor.getGeneratedCode();
      return { before, after, saved, code,
        memoryVariables: editor.captureProjectSnapshot().document.sharedModel.variables ?? [] };
    }, destination);
    assert.equal(report.preparedGeneration.before, report.preparedGeneration.after, 'Saving a prepared candidate must not register another model');
    assert.equal(report.preparedGeneration.saved.changed, false);
    assert.equal(report.preparedGeneration.saved.memoryHash, report.preparedGeneration.saved.diskHash);
    assert.equal(fs.readFileSync(path.join(destination, 'project.abi'), 'utf8'), abiBeforeRepeat);
    const code = report.preparedGeneration.code;
    const headers = [...code.matchAll(/#include\s+"((?:variables|objects)_[a-zA-Z0-9_-]+-[a-f0-9]{8}\.h)"/g)].map(match => match[1]);
    report.preparedGeneration.headers = headers.map(fileName => {
      const file = path.join(destination, 'src', fileName);
      assert.ok(fs.existsSync(file), 'Generated include must exist in project/src: ' + fileName);
      const content = fs.readFileSync(file, 'utf8'); assert.ok(content.length > 0);
      return { fileName, bytes: Buffer.byteLength(content), hash: hash(content) };
    });
    report.preparedGeneration.codeHash = hash(code);
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8')).codeHash, hash(code));
    delete report.preparedGeneration.code;
    record('Repeated save retained exact ABI/revision; memory matched disk and generated headers/codeHash matched prepared output');
    await page.evaluate(async destination => {
      const service = window.projectDataSmokeService;
      if (!await service.close() || !await service.projectOpen(destination)) throw new Error('Candidate reopen failed');
    }, destination);
    await checkCandidate();
    assert.equal(hash(fs.readFileSync(path.join(source, 'project.abi'))), originalHash);
    record('Candidate validation rejected missing resources/stale text; actual chunk apply and reopen retained full large text and added block');
  }
  await dismissLogin();
  await page.locator('app-blockly-editor .blocklyBox').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(root, 'project-data-page.png'), fullPage: true });
  report.success = true;
}

async function waitForProject() {
  await page.waitForFunction(() => {
    const node = document.querySelector('app-blockly-editor'); const component = node && window.ng?.getComponent(node);
    return component?.projectService.getBlocklyProjectLoadStatus(component.projectService.currentProjectPath)?.ready
      && !!component.blocklyService.workspace?.getBlockById('project_data_smoke_text');
  }, undefined, { timeout: 90000 });
}

async function dismissLogin() {
  const close = page.locator('app-login .login-close');
  if (await close.isVisible().catch(() => false)) await close.click();
}

main().catch(async error => {
  report.success = false; report.error = error.stack; console.error(error);
  if (page) {
    report.page = await page.locator('body').innerText().catch(() => 'unavailable');
    await page.screenshot({ path: path.join(root, 'project-data-failure.png'), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
}).finally(async () => {
  setPhase('shutdown');
  preparedAgent?.close();
  report.errors = errors;
  if (app) {
    const child = app.process();
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    for (let i = 0; i < 50 && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    }
  }
  await renderer.close();
  if (linkedChat) {
    try { linkedChat.assertSourceUnchanged(); }
    catch (error) { report.success = false; report.error = error.message; process.exitCode = 1; }
    finally { linkedChat.dispose(); }
  }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  // Retain this uniquely-created temp root for evidence and reproducibility. Never delete user projects.
  console.log('RESULT=' + path.join(root, 'result.json'));
});
