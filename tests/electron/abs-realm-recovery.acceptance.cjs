// Private real-Electron acceptance. Uses only this suite's project/profile/build.
// Run from repo root with bundled Node; configurable roots never select a user project.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron } = require('@playwright/test');
const requiredPath = name => {
  const value = process.env[name];
  assert.ok(value && path.isAbsolute(value), `${name} must explicitly name an absolute private test path`);
  return path.resolve(value);
};
const privateRoot = requiredPath('AILY_REALM_TEST_ROOT');
const agent = requiredPath('AILY_REALM_AGENT_ROOT');
const seed = requiredPath('AILY_REALM_SEED_PROJECT');
const output = path.resolve(process.env.AILY_REALM_OUTPUT || 'tests/test-results/abs-realm-recovery');
const build = requiredPath('AILY_REALM_HOST_BUILD');
const project = path.join(privateRoot, 'projects', `abs_realm_close_${Date.now()}`);
const profile = path.join(privateRoot, `profile-realm-close-${Date.now()}`);
const ids = ['realm-' + 'a'.repeat(294), 'realm-' + 'b'.repeat(506)];
const extra = { version: 3, params: [{ name: 'value', type: 'int', values: [0, 91, null] }], dictionary: { note: '界😀', preserved: true } };
let app, history;
async function main() {
  assert.ok(path.resolve(project).startsWith(path.resolve(privateRoot, 'projects') + path.sep));
  assert.ok(seed.startsWith(privateRoot + path.sep), 'only a seed inside the private root may be copied');
  assert.ok(output.startsWith(path.resolve('tests/test-results') + path.sep), 'outputs must remain in ignored test artifacts');
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(project);
  console.log('PHASE private-copy', project);
  for (const name of ['package.json', 'package-lock.json', 'project.abi', 'node_modules'])
    await fs.cp(path.join(seed, name), path.join(project, name), { recursive: true });
  const library = path.join(project, 'node_modules/@aily-project/lib-realm-fixture');
  await fs.cp(path.join(__dirname, 'fixtures/realm-library'), library, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
  manifest.name = path.basename(project); manifest.nickname = 'Private realm acceptance';
  manifest.dependencies['@aily-project/lib-realm-fixture'] = '1.0.0';
  delete manifest.buildInfo; delete manifest.codeHash;
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify(manifest, null, 2));
  const document = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'));
  const roots = document.pages[0].content.blocks.blocks;
  ids.forEach((id, i) => roots.push({ type: 'realm_state_fixture', id, x: 650, y: 80 + i * 160,
    deletable: false, collapsed: true, ...(i === 0 ? { disabledReasons: ['MANUALLY_DISABLED'] } : {}),
    fields: { PICK: 'B' }, extraState: extra }));
  await fs.writeFile(path.join(project, 'project.abi'), JSON.stringify(document));
  const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
  const home = path.join(privateRoot, 'isolated-home');
  app = await _electron.launch({ args: ['.', '--serve', `--user-data-dir=${profile}`], cwd: process.cwd(), timeout: 60000,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: path.join(privateRoot, 'appdata'), HOME: home, USERPROFILE: home } });
  await app.context().route('http://localhost:4200/**', async route => {
    let pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname === '/' || !path.extname(pathname)) pathname = '/index.html';
    const file = path.resolve(build, '.' + pathname);
    if (!file.startsWith(build + path.sep)) return route.abort();
    try { await route.fulfill({ path: file }); } catch { await route.fulfill({ status: 404, body: 'missing private test asset' }); }
  });
  await app.firstWindow();
  let page;
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) {
    page = app.windows().find(candidate => /^http:\/\/localhost:4200\/?$|^chrome-error:/.test(candidate.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(page, 'private main window'); page.on('dialog', dialog => dialog.dismiss());
  page.on('console', message => { if (message.type() === 'warning' && /realm|block|library|项目|加载/i.test(message.text())) console.warn('RENDERER_WARNING', message.text().slice(0, 1000)); });
  page.on('console', message => { if (message.type() === 'error') console.error('RENDERER', message.text()); });
  await page.goto('http://localhost:4200'); await page.locator('app-main-window').waitFor({ timeout: 60000 });
  await page.evaluate(target => { location.hash = '#/main/blockly-editor?path=' + encodeURIComponent(target); }, project);
  const waitLoaded = async () => {
    try { await page.waitForFunction(ids => ids.every(id => window.Blockly?.getMainWorkspace?.()?.getBlockById(id)), ids, { timeout: 60000 }); }
    catch (error) {
      console.error('LOAD_DIAGNOSTIC', await page.evaluate(() => ({ hash: location.hash,
        component: !!document.querySelector('blockly-main'), registered: !!window.Blockly?.Blocks.realm_state_fixture,
        blocks: window.Blockly?.getMainWorkspace?.()?.getAllBlocks(false).map(b => ({ type: b.type, idLength: b.id.length })),
        text: document.body.innerText.slice(-1600) })));
      await page.screenshot({ path: path.join(output, 'load-failure.png') }); throw error;
    }
  };
  await waitLoaded();
  console.log('PHASE loaded');
  const canvas = () => page.evaluate(ids => {
    const workspace = window.Blockly.getMainWorkspace();
    return ids.map(id => {
      const block = workspace.getBlockById(id), extraState = block.saveExtraState();
      return { id: block.id, length: block.id.length, dropdown: block.getFieldValue('PICK'), extraState,
        foreign: Object.getPrototypeOf(extraState) !== Object.prototype,
        disabled: !block.isEnabled(), collapsed: block.isCollapsed(), deletable: block.isDeletable() };
    });
  }, ids);
  let state = await canvas();
  for (const value of state) {
    assert.equal(value.foreign, true); assert.equal(value.dropdown, 'B'); assert.deepEqual(value.extraState, extra);
    assert.equal(value.disabled, value.id === ids[0]); assert.equal(value.collapsed, true); assert.equal(value.deletable, false);
  }
  const hostPid = await app.evaluate(() => process.pid);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, AILY_LIBRARY_HOST_PID: String(hostPid),
    AILY_APPDATA_PATH: path.join(privateRoot, 'appdata'), PI_CODING_AGENT_DIR: path.join(privateRoot, 'agent-realm-profile') });
  const mod = name => import(pathToFileURL(path.join(agent, 'dist', name + '.js')).href);
  const { requestHostAbsProjection } = await mod('blockly/services/abs/host-projection');
  const { WorkspaceHistoryRuntime } = await mod('extensions/pi-workspace-history/runtime');
  const { WorkspaceBinding } = await mod('workspace-binding');
  const { AbsWorkflowGuard } = await mod('blockly/abs-workflow-guard');
  const { createBlocklyToolRegistry } = await mod('blockly/tools/registry');
  const { registerProjectRecover } = await mod('blockly/tools/registrars/project/project-recover');
  const { registerAbsApply } = await mod('blockly/tools/registrars/abs/abs-apply');
  const { registerProjectBuild } = await mod('blockly/tools/registrars/project/project-build');
  const { registerBlocksSetState } = await mod('blockly/tools/registrars/project/blocks-set-state');
  const { createAilyBlocklyExtension } = await mod('extensions/pi-aily-blockly/extension');
  const initial = await requestHostAbsProjection(project, { initialize: true });
  assert.equal(initial.ok, true, JSON.stringify(initial));
  history = new WorkspaceHistoryRuntime(project); await history.begin(undefined);
  const binding = new WorkspaceBinding(project, privateRoot, history, {}), guard = new AbsWorkflowGuard();
  const registry = createBlocklyToolRegistry(binding, history, 'blockly');
  const context = { registry, workspace: binding, workspaceHistory: history, absWorkflow: guard };
  [registerProjectRecover, registerAbsApply, registerProjectBuild, registerBlocksSetState].forEach(register => register(context));
  const handlers = new Map(), entries = [];
  createAilyBlocklyExtension({ workspaceBinding: binding, absWorkflow: guard, blocklyTools: registry.definitions() }).factory({
    on: (name, handler) => handlers.set(name, handler), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data })
  });
  const invoke = async (name, input) => {
    console.log('TOOL', name, input.action || '');
    const gate = handlers.get('tool_call')({ toolName: name, input });
    assert.equal(gate, undefined, JSON.stringify({ name, gate }));
    const result = (await registry.definitions().find(tool => tool.name === name).execute(input)).structuredContent;
    await handlers.get('tool_result')({ toolName: name, input, content: [{ type: 'text', text: JSON.stringify(result) }],
      details: { aily: { kind: 'aily.blockly', operation: name }, result }, isError: result.ok === false },
      { sessionManager: { getEntries: () => entries }, isProjectTrusted: () => true });
    return result;
  };
  const inspected = await invoke('blocks_set_state', { project, action: 'inspect', blockIds: ids });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const update = await invoke('blocks_set_state', { project, action: 'update', expectedGeneration: inspected.expectedGeneration,
    changes: ids.map(blockId => ({ blockId, collapsed: false })) });
  assert.equal(update.ok, true, JSON.stringify(update));
  const text = await fs.readFile(path.join(project, 'project.abs'), 'utf8');
  assert.match(text, /variable_define\("chain_counter", int, math_number\(\d+\)\)/);
  const candidate = text.replace(/variable_define\("chain_counter", int, math_number\(\d+\)\)/,
    'variable_define("chain_counter", int, math_number(42))');
  const applied = await invoke('abs_apply', { project, generation: update.generation, abs: candidate });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  state = await canvas();
  for (const value of state) {
    assert.deepEqual(value.extraState, extra); assert.equal(value.dropdown, 'B'); assert.equal(value.disabled, value.id === ids[0]);
    assert.equal(value.collapsed, false); assert.equal(value.deletable, false);
  }
  const built = await invoke('project_build', { project });
  assert.equal(built.ok, true, JSON.stringify(built));
  await page.reload(); await page.locator('app-main-window').waitFor({ timeout: 60000 }); await waitLoaded();
  state = await canvas();
  for (const value of state) {
    assert.equal(value.foreign, true); assert.deepEqual(value.extraState, extra); assert.equal(value.dropdown, 'B');
    assert.equal(value.disabled, value.id === ids[0]); assert.equal(value.collapsed, false); assert.equal(value.deletable, false);
  }
  await page.evaluate(() => {
    const component = window.ng.getComponent(document.querySelector('blockly-main'));
    const editor = component.blocklyService, lease = editor.acquireWorkspaceEditLease();
    lease.quarantine('isolated realm regression quarantine'); lease.release();
    if (!editor.isWorkspaceEditBlocked() || editor.isWorkspaceEditInProgress()) throw Error('private quarantine setup failed');
  });
  guard.recordConflict(project, { ok: false, code: 'ABS_SOURCE_CONFLICT', error: 'isolated source guard' });
  const files = ['package.json', 'project.abi', 'project.abs', 'project.abs.map.json'];
  const source = Object.fromEntries(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(project, file), 'utf8')])));
  const isolated = await invoke('project_recover', { project, action: 'inspect' });
  assert.equal(isolated.ok, false, JSON.stringify(isolated)); assert.equal(isolated.code, 'ABS_WORKSPACE_QUARANTINED');
  assert.deepEqual(isolated.nextAction, { tool: 'project_recover', input: { project, action: 'fork' } });
  assert.match(isolated.recovery, /independent recovery project/i);
  const fork = await invoke(isolated.nextAction.tool, isolated.nextAction.input);
  assert.equal(fork.ok, true, JSON.stringify(fork)); assert.equal(fork.projectionReady, true, JSON.stringify(fork));
  assert.notEqual(fork.project, project); assert.equal(fork.activated, true);
  const target = fork.project;
  assert.ok(path.resolve(target).startsWith(path.resolve(privateRoot, 'projects') + path.sep));
  for (const file of files) assert.equal(await fs.readFile(path.join(project, file), 'utf8'), source[file]);
  assert.ok(guard.snapshot(project).concurrentEdit); assert.equal(binding.root, project);
  state = await canvas();
  for (const value of state) { assert.deepEqual(value.extraState, extra); assert.equal(value.dropdown, 'B'); assert.equal(value.deletable, false); }
  const targetBuild = await invoke('project_build', { project: target }); assert.equal(targetBuild.ok, true, JSON.stringify(targetBuild));
  for (const file of files) assert.equal(await fs.readFile(path.join(project, file), 'utf8'), source[file]);
  const result = { at: new Date().toISOString(), project, target, hostPid, productionIframeExtraState: true,
    deferredDropdownRestored: true, exactExtraStatePreserved: true, inspectedIdLengths: ids.map(id => id.length),
    stateUpdate: update.ok, absApply: applied.ok, sourceCompile: built.ok, savedReopen: true,
    quarantineInspectCode: isolated.code, guidedFork: fork.ok, freshTargetProjection: fork.projectionReady,
    targetCompile: targetBuild.ok, originalSourceFilesPreservedExactly: true, originalSessionGuardPreserved: true,
    isolation: { userProjectsModified: false, dailyInstallReplaced: false, simulatorInvoked: false, uploaded: false } };
  await fs.writeFile(path.join(output, 'fix-real-electron.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  await history?.dispose().catch(() => {});
  if (app) { await app.evaluate(({ app }) => app.quit()).catch(() => {}); await new Promise(resolve => setTimeout(resolve, 1000));
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
});
