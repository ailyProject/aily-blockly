// Opt-in acceptance of an externally supplied project, using an isolated copy.
// The packaged MCP entry is the same registry shipped inside Chat, not a mock host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const { createPackagedRendererServer } = require('../electron/packaged-renderer-server');

const [abiFile, packageFile, libraries, board, chat, agent, buildInputs, sessionFile] = process.argv.slice(2);
for (const value of [abiFile, packageFile, libraries, board, chat, agent]) assert.ok(value && path.isAbsolute(value),
  'Usage: node scripts/abs-session-acceptance.cjs ABI PACKAGE LIBRARIES BOARD INSTALLED_CHAT AGENT [BUILD_INPUTS]');
const repo = path.resolve(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
// A cancelled cold build can be resumed without replaying the accepted ABS writes.
const resumeFile = process.env.AILY_ABS_ACCEPTANCE_RESUME;
const previous = resumeFile ? readJson(resumeFile) : null;
const root = previous?.root || fs.mkdtempSync(path.join(os.tmpdir(), 'aily-abs-session-'));
assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
assert.ok(path.basename(root).startsWith('aily-abs-session-'));
const runId = Date.now();
const reusedProfile = process.env.AILY_ABS_ACCEPTANCE_APPDATA;
assert.ok(!reusedProfile || previous, 'An existing build profile is only allowed for resume');
const project = path.join(root, 'project');
const appData = reusedProfile || path.join(root, previous ? `app-data-build-${runId}` : 'app-data');
assert.equal(path.dirname(path.resolve(appData)), path.resolve(root), 'Build profile must stay in the owned test root');
const sha = value => createHash('sha256').update(value).digest('hex');
const originals = [abiFile, packageFile].map(file => sha(fs.readFileSync(file)));
const report = { root, project, appData, originals, calls: [], assertions: [], errors: [], llmTurnTested: false };
const resultFile = path.join(root, previous ? `build-result-${runId}.json` : 'result.json');
let app, page, client, transport, phase = 'prepare';
const renderer = createPackagedRendererServer();
const mark = value => { phase = value; console.log('PHASE=' + value); };
const record = value => { report.assertions.push(value); console.log('PASS=' + value); };
const mirrors = () => Object.fromEntries(['project.abi', 'project.abs', 'project.abs.map.json'].map(file =>
  [file, fs.existsSync(path.join(project, file)) ? sha(fs.readFileSync(path.join(project, file))) : null]));
function indexDocument(doc) {
  const blocks = {};
  const visit = (block, parent = null, edge = null) => {
    assert.ok(block.id && !blocks[block.id], 'Duplicate or absent block ID');
    const { inputs, next, x, y, ...attributes } = block;
    blocks[block.id] = { ...attributes, parent, edge };
    for (const [name, input] of Object.entries(inputs || {})) for (const kind of ['block', 'shadow']) {
      if (input[kind]) visit(input[kind], block.id, `${name}:${kind}`);
    }
    if (next?.block) visit(next.block, block.id, 'next');
  };
  for (const page of doc.pages || [{ content: doc }]) for (const block of page.content.blocks?.blocks || []) visit(block);
  for (const block of doc.sharedModel?.procedureBlocks || []) visit(block);
  return { blocks, variables: doc.sharedModel?.variables || doc.variables || [] };
}
function prepare() {
  fs.mkdirSync(project);
  fs.copyFileSync(abiFile, path.join(project, 'project.abi'));
  fs.copyFileSync(packageFile, path.join(project, 'package.json'));
  // Chat attachments may carry the Windows read-only attribute. Only the newly
  // owned copies are editable; never change permissions on the supplied inputs.
  for (const file of ['project.abi', 'package.json']) fs.chmodSync(path.join(project, file), 0o600);
  const candidates = [board, ...fs.readdirSync(libraries, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(libraries, e.name))];
  const byName = new Map(candidates.filter(p => fs.existsSync(path.join(p, 'package.json'))).map(p => [readJson(path.join(p, 'package.json')).name, p]));
  report.dependencies = [];
  for (const [name, version] of Object.entries(readJson(packageFile).dependencies)) {
    const source = byName.get(name); assert.ok(source, `Missing local dependency ${name}`);
    assert.equal(readJson(path.join(source, 'package.json')).version, version, name);
    const target = path.join(project, 'node_modules', name);
    fs.cpSync(source, target, { recursive: true, dereference: true, filter: p => !['.git', 'node_modules'].includes(path.basename(p)) });
    report.dependencies.push({ name, version, source });
    if (fs.existsSync(path.join(target, 'src.7z'))) {
      const unzip = spawnSync(path.join(repo, 'child/7za.exe'), ['x', path.join(target, 'src.7z'), '-o' + target, '-y'], { windowsHide: true });
      assert.equal(unzip.status, 0, `Unpack ${name}`);
    }
  }
  prepareProfile();
}
function prepareProfile() {
  if (reusedProfile) {
    const config = readJson(path.join(appData, 'config.json'));
    assert.equal(config.project_path, root);
    assert.equal(path.resolve(config.appdata_path[process.platform]), path.resolve(appData));
  } else {
    fs.mkdirSync(appData);
    const config = readJson(path.join(repo, 'electron/config/config.json'));
    config.project_path = root; config.appdata_path[process.platform] = appData;
    fs.writeFileSync(path.join(appData, 'config.json'), JSON.stringify(config));
  }
  if (buildInputs) {
    // Reuse only a dedicated, completed acceptance toolchain copy. Never link
    // an ordinary user's SDK or npm-global directory into this writable profile.
    const marker = readJson(path.join(buildInputs, 'abs-acceptance-build-inputs.json'));
    assert.equal(path.resolve(marker.ownedRoot), path.resolve(buildInputs));
    assert.equal(marker.completed, true);
    for (const [name, version] of Object.entries(readJson(path.join(board, 'package.json')).boardDependencies)) {
      assert.equal(readJson(path.join(buildInputs, 'node_modules', name, 'package.json')).version, version, `Build input ${name}`);
      if (reusedProfile) assert.equal(readJson(path.join(appData, 'node_modules', name, 'package.json')).version, version);
    }
    for (const entry of ['sdk', 'tools', 'npm-global']) {
      if (reusedProfile) assert.equal(fs.realpathSync(path.join(appData, entry)), fs.realpathSync(path.join(buildInputs, entry)));
      else fs.symlinkSync(path.join(buildInputs, entry), path.join(appData, entry), 'junction');
    }
    if (!reusedProfile) fs.cpSync(path.join(buildInputs, 'node_modules'), path.join(appData, 'node_modules'), {
      recursive: true, filter: file => !file.endsWith('.7z'),
    });
  }
  const evidence = readJson(path.join(chat, 'runtime/build-evidence.json'));
  report.buildEvidence = { inputHash: evidence.inputHash, outputHash: evidence.outputHash, buildTime: evidence.buildTime };
}
async function snapshot() {
  // Deep next/input trees exceed the browser protocol's object nesting limit.
  // Transfer their JSON text, rather than Playwright's recursively wrapped value.
  const current = JSON.parse(await page.evaluate(() => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const service = component.blocklyService;
    return JSON.stringify({ state: service.getWorkspaceJson(), code: service.getGeneratedCode(), mapping: Array.from(service.blockCodeMapSubject.value) });
  }));
  const revision = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-blockly-editor'))._projectService.getAbiRevisionSnapshot());
  const viewer = await page.evaluate(() => window.codeViewer.getState());
  return { ...current, revision, viewer };
}
async function waitProject() {
  await page.waitForFunction(() => {
    const component = window.ng?.getComponent(document.querySelector('app-blockly-editor'));
    return component?.projectService.getBlocklyProjectLoadStatus(component.projectService.currentProjectPath)?.ready
      && component.blocklyService.workspace?.getAllBlocks(false).length > 0
      && component.blocklyService.workspace !== window.acceptancePreviousWorkspace;
  }, undefined, { timeout: 120000 });
}
async function waitCode(expected) {
  // This repository's Playwright waitForFunction treats a Promise as truthy;
  // explicitly await each IPC observation instead of passing an async predicate.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(async expected => {
      const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
      const code = component?.blocklyService.getGeneratedCode();
      const viewer = await window.codeViewer.getState();
      return !!code && (!expected || code === expected) && viewer?.code === code;
    }, expected);
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Current generated code and IPC viewer did not converge within 30 seconds');
}
async function rejectLegacyRequests() {
  // Playwright may expose the launcher PID, not Electron main's PID on Windows.
  const pid = await app.evaluate(() => process.pid);
  const bridge = readJson(path.join(os.homedir(), '.aily-blockly/cli-bridge', `${pid}.json`));
  const before = mirrors(), state = (await snapshot()).state;
  report.legacy = [];
  for (const operation of ['abi_add', 'abi_move', 'abi_delete', 'abi_connect', 'abi_set_field']) {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/command`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ token: bridge.token, action: 'blockly-live-operation', path: project, operation, params: {} }) });
    const result = await response.json();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, 'ABS_PROTOCOL_REQUIRED', JSON.stringify(result));
    assert.equal(result.publication.status, 'NOT_COMMITTED');
    report.legacy.push({ operation, code: result.code, publication: result.publication });
  }
  assert.deepEqual(mirrors(), before); assert.deepEqual((await snapshot()).state, state);
  record('All five historical raw ABI write requests rejected without file/canvas mutation');
}
async function historicalCandidates() {
  if (!sessionFile) return;
  const session = fs.readFileSync(sessionFile, 'utf8');
  report.sessionHash = sha(session);
  const lines = session.trim().split(/\r?\n/).map(JSON.parse);
  const candidate = line => '# ABS Schema: 2\n' + lines[line - 1].message.content.find(item => item.type === 'toolCall').arguments.abs;
  const current = await accepted('abs_export');
  const before = mirrors(), state = (await snapshot()).state;
  for (const [line, code] of [[262, 'ABS_CONNECTION_INCOMPATIBLE'], [377, 'ABS_GENERATION_FAILED']]) {
    const rejected = await call('abs_apply', { generation: current.generation, abs: candidate(line), chunk: true });
    assert.equal(rejected.ok, false); assert.equal(rejected.code, code);
    assert.deepEqual(mirrors(), before); assert.deepEqual((await snapshot()).state, state);
  }
  // An explicit test-only semantic migration onto the freshly exported baseline;
  // product code does not silently upgrade or rebind historical drafts.
  await accepted('abs_validate', { generation: current.generation, abs: candidate(271), chunk: true });
  assert.deepEqual(mirrors(), before);
  await accepted('abs_apply', { generation: current.generation, abs: candidate(373), chunk: true });
  const applied = indexDocument(readJson(path.join(project, 'project.abi')));
  assert.equal(Object.keys(applied.blocks).length, 400); assert.equal(applied.variables.length, 21);
  for (const model of report.originalIndex.variables) {
    assert.deepEqual(applied.variables.find(item => item.id === model.id), model);
  }
  report.historical = { blocks: 400, models: 21,
    retained: Object.keys(report.originalIndex.blocks).filter(id => applied.blocks[id]).length,
    newBlocks: Object.keys(applied.blocks).filter(id => !report.originalIndex.blocks[id]).length };
  for (const [id, block] of Object.entries(report.originalIndex.blocks).filter(([, b]) => b.deletable === false)) {
    assert.equal(applied.blocks[id]?.type, block.type); assert.equal(applied.blocks[id]?.deletable, false);
  }
  assert.equal(sha(fs.readFileSync(sessionFile)), report.sessionHash);
  record('Historical bad nesting/typo rejected; corrected candidates validate/apply as 400 blocks / 21 models');
}
async function call(name, args = {}) {
  mark(name);
  const start = Date.now();
  // Leave room for the deployed client's own 620-second build error response.
  const response = await client.callTool({ name, arguments: { project, ...args } }, undefined, { timeout: name === 'project_build' ? 650000 : 120000 });
  const result = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  report.calls.push({ name, ms: Date.now() - start, result });
  console.log('TOOL=' + JSON.stringify({ name, ok: result.ok, code: result.code, ms: Date.now() - start }));
  return result;
}
async function accepted(name, args) {
  const result = await call(name, args); assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
async function buildAndVerify() {
  const before = mirrors();
  report.build = await accepted('project_build');
  await waitCode();
  const final = await snapshot();
  assert.equal(final.viewer.code, final.code);
  assert.deepEqual(final.viewer.blockCodeMap, final.mapping);
  assert.equal(fs.readFileSync(path.join(project, '.temp/sketch/sketch.ino'), 'utf8'), final.code);
  assert.equal(readJson(path.join(project, 'package.json')).codeHash, sha(final.code));
  assert.deepEqual(mirrors(), before, 'Compilation must not mutate the accepted ABI/ABS/map');
  report.buildCodeHash = sha(final.code);
  record('Actual board project_build succeeded; compiled sketch matches published code/viewer');
}
async function main() {
  if (previous) {
    assert.deepEqual(previous.originals, originals); assert.equal(previous.originalsUnchanged, true);
    assert.equal(path.resolve(previous.project), path.resolve(project));
    assert.ok(previous.assertions.includes('Historical bad nesting/typo rejected; corrected candidates validate/apply as 400 blocks / 21 models'));
    const binding = previous.calls.filter(item => item.name === 'abs_apply' && item.result.ok).at(-1)?.result.evidence?.binding;
    assert.ok(binding, 'Resume requires the previously verified apply output');
    const current = mirrors();
    for (const [file, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']]) {
      assert.equal('sha256:' + current[file], binding[key], `Accepted ${file} changed before resume`);
    }
    report.acceptedMirrors = current;
    report.resumedFrom = resumeFile; report.priorAssertions = previous.assertions;
    prepareProfile();
  } else prepare();
  console.log('ROOT=' + root);
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  await renderer.start({ rootDirectory: path.join(repo, 'dist/aily-blockly/browser') });
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${path.join(root, previous ? `profile-build-${runId}` : 'profile')}`], cwd: repo,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, PI_CODING_AGENT_DIR: path.join(root, 'agent-state') }, timeout: 60000 });
  await app.context().route('http://localhost:4200/**', route => route.fulfill({ status: 302, headers: { location: renderer.rendererUrl('/main/guide') } }));
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) {
    for (const win of app.windows()) if (await win.locator('app-main-window').count().catch(() => 0)) { page = win; break; }
    if (!page) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(page, 'Host main window');
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log('NAVIGATION=' + frame.url()); });
  await app.evaluate((_, cache) => { process.env.AILY_BUILDER_PATH = cache; }, path.join(root, 'builder-cache'));
  page.on('pageerror', e => report.errors.push({ phase, message: e.message }));
  page.on('console', e => { if (e.type() === 'error') report.errors.push({ phase, message: e.text() }); });
  await page.goto(renderer.rendererUrl('/main/guide'));
  await page.waitForFunction(() => !!document.querySelector('app-header') && !!window.ng?.getComponent);
  await page.evaluate(() => {
    const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click(); };
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss();
    for (const selector of ['app-header', 'app-guide', 'app-main-window']) {
      const component = window.ng.getComponent(document.querySelector(selector));
      if (component?.projectService?.projectOpen) { window.acceptanceProject = component.projectService; break; }
    }
  });
  mark('project-open');
  assert.equal(await page.evaluate(project => window.acceptanceProject.projectOpen(project), project), true);
  await waitProject();
  report.initial = await snapshot();
  report.originalIndex = indexDocument(readJson(abiFile));
  assert.equal(Object.keys(report.originalIndex.blocks).length, 383);
  assert.equal(report.originalIndex.variables.length, 20);
  record(previous ? 'Reopened accepted project for build-only verification; no ABS writes replayed' : 'Supplied 383-block / 20-model project loaded in real Electron');
  // The SDK is only the transport client; all tool execution comes from the deployed portable entry.
  const agentRequire = createRequire(path.join(agent, 'package.json'));
  const { Client } = agentRequire('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = agentRequire('@modelcontextprotocol/sdk/client/stdio.js');
  transport = new StdioClientTransport({ command: path.join(repo, 'child/node/node.exe'), args: [path.join(chat, 'runtime/mcp/cli.js')],
    cwd: project, env: { ...env, AILY_PORTABLE_ROOT: chat, PI_PACKAGE_DIR: path.join(chat, 'runtime/pi-package'),
      PI_CODING_AGENT_DIR: path.join(root, 'agent-state'), AILY_APPDATA_PATH: appData }, stderr: 'pipe' });
  client = new Client({ name: 'abs-session-acceptance', version: '1.0.0' });
  await client.connect(transport);
  transport.stderr?.on('data', () => {});
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'abs_apply'));
  assert.ok(!catalog.tools.some(tool => /^abi_(add|delete|connect|move|set_field)$/.test(tool.name)));
  record('Installed Chat MCP registry discovers real host; legacy ABI writers absent');
  if (previous) {
    await buildAndVerify();
    await page.screenshot({ path: path.join(root, 'accepted-build.png'), fullPage: true });
    report.success = true; return;
  }
  const exported = await accepted('abs_export', { initialize: true });
  const baseline = mirrors();
  await accepted('abs_validate', { generation: exported.generation, abs: exported.abs, chunk: true });
  assert.deepEqual(mirrors(), baseline);
  await accepted('abs_apply', { generation: exported.generation, abs: exported.abs, chunk: true });
  const roundTrip = indexDocument(readJson(path.join(project, 'project.abi')));
  assert.deepEqual(roundTrip, report.originalIndex, 'No-op must preserve every ID, field, edge, flag and model');
  record('No-op validate/apply preserves all 383 identities, connections, fields, flags and 20 models');
  await rejectLegacyRequests();
  const current = await accepted('abs_export');
  const text = current.abs;
  const match = /math_number\((\d+)\)/.exec(text); assert.ok(match, 'Numeric fixture field');
  const value = String(Number(match[1]) + 1);
  const candidate = text.slice(0, match.index) + `math_number(${value})` + text.slice(match.index + match[0].length);
  const beforeBad = mirrors(), beforeBadState = await snapshot();
  const bad = await call('abs_apply', { generation: current.generation, abs: text.replace('math_number(', 'nonexistent_acceptance_block('), chunk: true });
  assert.equal(bad.ok, false); assert.equal(bad.partialMutation, undefined);
  const afterBad = await snapshot();
  assert.deepEqual(mirrors(), beforeBad); assert.deepEqual(afterBad.state, beforeBadState.state);
  assert.equal(afterBad.code, beforeBadState.code); assert.deepEqual(afterBad.mapping, beforeBadState.mapping);
  record('Invalid candidate rejected without changing ABI/ABS/map or canvas');
  const application = await accepted('abs_apply', { generation: current.generation, abs: candidate, chunk: true });
  const changed = indexDocument(readJson(path.join(project, 'project.abi')));
  assert.deepEqual(Object.keys(changed.blocks).sort(), Object.keys(roundTrip.blocks).sort());
  assert.deepEqual(changed.variables, roundTrip.variables);
  const differences = Object.keys(changed.blocks).filter(id => JSON.stringify(changed.blocks[id]) !== JSON.stringify(roundTrip.blocks[id]));
  assert.equal(differences.length, 1, 'Exactly one block field should differ');
  const changedId = differences[0];
  assert.deepEqual(changed.blocks[changedId], { ...roundTrip.blocks[changedId], fields: { ...roundTrip.blocks[changedId].fields, NUM: Number(value) } });
  report.edit = { blockId: changedId, before: match[1], after: value };
  await waitCode();
  const committed = await snapshot();
  assert.equal(committed.revision.changed, false);
  assert.equal(committed.revision.diskHash, committed.revision.memoryHash);
  // A background preprocess may own the derived files. The ABS commit must
  // expose that deferral; final source/hash consistency is mandatory after build.
  const derivedDeferred = application.warnings?.some(w => w.includes('BUILD_WORKSPACE_BUSY')) === true;
  if (derivedDeferred) {
    assert.ok(buildInputs, 'Deferred derived outputs require the final real build check');
    report.derivedPublicationDeferred = application.warnings;
  } else assert.equal(readJson(path.join(project, 'package.json')).codeHash, sha(committed.code));
  assert.equal(committed.viewer.code, committed.code);
  assert.deepEqual(committed.viewer.blockCodeMap, committed.mapping);
  record('Single-field apply preserves all identities/subtrees and publishes matching code/viewer/map');
  await accepted('project_save');
  const saved = mirrors(), savedState = await snapshot();
  mark('reopen');
  await page.evaluate(async project => {
    const service = window.acceptanceProject;
    window.acceptancePreviousWorkspace = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService.workspace;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Reopen failed');
  }, project);
  await waitProject();
  await waitCode(savedState.code);
  assert.deepEqual(mirrors(), saved);
  report.reopened = await snapshot();
  assert.deepEqual(report.reopened.state, savedState.state);
  assert.equal(report.reopened.code, savedState.code);
  record('Save/reopen leaves ABI/ABS/map bytes, native workspace and C++ unchanged');
  await historicalCandidates();
  report.acceptedMirrors = mirrors();
  if (buildInputs) await buildAndVerify();
  await page.screenshot({ path: path.join(root, 'accepted.png'), fullPage: true });
  report.success = true;
}
main().catch(async error => {
  report.success = false; report.error = error.stack; console.error(error);
  if (page) await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  await client?.close().catch(() => {});
  if (app) {
    const child = app.process();
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    for (let i = 0; i < 50 && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 100));
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  await renderer.close();
  report.originalsUnchanged = [abiFile, packageFile].every((file, i) => sha(fs.readFileSync(file)) === originals[i]);
  if (!report.originalsUnchanged) { report.success = false; process.exitCode = 1; }
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  console.log('RESULT=' + resultFile);
});
