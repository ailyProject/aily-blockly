// Explicit, opt-in checks for reported session regressions. Only test-owned paths.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const copy = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true,
  filter: file => !['.git', 'node_modules'].includes(path.basename(file)) });

function prepareSerialReplay({ root, codes, appData, sourceAppData, sessionFile }) {
  const project = path.join(root, `serial-session-${Date.now()}`);
  const board = path.join(codes, 'aily-blockly-boards/arduino_uno');
  const libraries = path.join(codes, 'aily-blockly-libraries');
  const sources = [board, ...fs.readdirSync(libraries, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => path.join(libraries, entry.name))];
  const byName = new Map(sources.filter(dir => fs.existsSync(path.join(dir, 'package.json')))
    .map(dir => [json(path.join(dir, 'package.json')).name, dir]));
  const pkg = json(path.join(board, 'template/package.json'));
  pkg.name = 'serial-session-regression';
  for (const name of Object.keys(pkg.dependencies)) {
    const source = byName.get(name); assert.ok(source, name);
    pkg.dependencies[name] = json(path.join(source, 'package.json')).version;
    copy(source, path.join(project, 'node_modules', name));
  }
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.copyFileSync(path.join(board, 'template/project.abi'), path.join(project, 'project.abi'));
  for (const [name, version] of Object.entries(json(path.join(board, 'package.json')).boardDependencies)) {
    const source = path.join(sourceAppData, 'node_modules', name);
    assert.equal(json(path.join(source, 'package.json')).version, version);
    const target = path.join(appData, 'node_modules', name);
    if (!fs.existsSync(target)) copy(source, target);
  }
  for (const name of ['sdk/avr_1.8.6', 'tools/avr-gcc@7.3.0', 'tools/avrdude@6.3.0-arduino17']) {
    const target = path.join(appData, name);
    if (!fs.existsSync(target)) copy(path.join(sourceAppData, name), target);
  }
  const messages = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line).message).filter(Boolean);
  const calls = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'toolCall');
  const validations = calls.filter(call => call.name === 'abs_validate');
  const baseline = validations.map(call => call.arguments.abs).find(abs => !abs.includes('serial_') && !abs.includes('time_delay'));
  assert.ok(baseline?.includes('variable_define_scoped'));
  const edit = calls.find(call => call.name === 'edit').arguments.edits[0];
  assert.ok(baseline.includes(edit.oldText));
  // The log starts with existing local declarations, not creation requests.
  // Reconstruct their documented ABI shape before exporting an identity baseline.
  const state = json(path.join(board, 'template/project.abi'));
  state.blocks.blocks.find(block => block.type === 'arduino_setup').inputs = { ARDUINO_SETUP: { block: {
    type: 'variable_define', id: 'serial-fixture-existing-variable', fields: { VAR: 'variaddble', TYPE: 'int8_t' },
    next: { block: { type: 'variable_define_scoped', id: 'serial-fixture-existing-scoped-variable',
      fields: { SCOPE: 'local', VAR: 'variable2ccc', TYPE: 'int32_t' } } },
  } } };
  state.variables = [{ name: 'variaddble', id: 'serial-fixture-model-1' }, { name: 'variable2ccc', id: 'serial-fixture-model-2' }];
  fs.writeFileSync(path.join(project, 'project.abi'), JSON.stringify(state));
  return { project, dependencies: pkg.dependencies, baseline,
    candidates: [
      { name: 'serial-number', abs: validations[0].arguments.abs },
      { name: 'delay-only', abs: validations.at(-1).arguments.abs },
      { name: 'serial-text', abs: baseline.replace(edit.oldText, edit.newText) },
    ] };
}

async function replaySerialSession(fixture, { page, open, call }) {
  const { project, baseline, candidates } = fixture;
  await open(project);
  const initial = await call('abs_export', { project });
  for (const candidate of [{ name: 'original-baseline', abs: baseline }, ...candidates]) {
    await call('abs_validate', { project, abs: candidate.abs, generation: initial.generation });
  }
  const committed = await call('abs_apply', { project, abs: candidates.at(-1).abs, generation: initial.generation });
  assert.deepEqual(committed.warnings ?? [], []);
  const built = await call('project_build', { project });
  const sketch = fs.readFileSync(path.join(project, '.temp/sketch/sketch.ino'), 'utf8');
  assert.match(sketch, /Serial\.begin\(9600\)/);
  assert.match(sketch, /Serial\.println\("Hello"\)/);
  assert.match(sketch, /variaddble/); assert.match(sketch, /variable2ccc/);
  await page.screenshot({ path: path.join(project, 'serial-replay.png'), fullPage: true });
  return { project, dependencies: fixture.dependencies, checked: ['original-baseline', ...candidates.map(c => c.name)],
    applied: true, buildPassed: built.ok, sketchBytes: Buffer.byteLength(sketch), localReplacementLibraryCreated: false };
}

async function clearWorkspaceForAgent(page, project, evidenceDir) {
  const result = await page.evaluate(async projectPath => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const workspace = component.blocklyService.workspace;
    if (component._projectService.currentProjectPath !== projectPath) throw Error('Wrong test project');
    const before = { blocks: workspace.getAllBlocks(false).length, variables: workspace.getAllVariables().length };
    const roots = new Set(['arduino_global', 'arduino_setup', 'arduino_loop']);
    for (const block of workspace.getTopBlocks(false)) {
      if (roots.has(block.type)) for (const child of block.getChildren(false)) child.dispose(false);
      else block.dispose(false);
    }
    for (const variable of workspace.getAllVariables()) workspace.deleteVariableById(variable.getId());
    await component._projectService.save(projectPath);
    return { before, after: { blocks: workspace.getAllBlocks(false).map(block => ({ type: block.type,
      children: block.getChildren(false).length, deletable: block.isDeletable() })), variables: workspace.getAllVariables().length } };
  }, project);
  assert.ok(result.before.blocks > 3, 'Must clear an actually populated workspace');
  assert.deepEqual(result.after.blocks.map(block => block.type).sort(), ['arduino_global', 'arduino_loop', 'arduino_setup']);
  assert.ok(result.after.blocks.every(block => block.children === 0 && !block.deletable));
  assert.equal(result.after.variables, 0);
  const saved = json(path.join(project, 'project.abi'));
  assert.equal((saved.sharedModel?.variables ?? saved.variables ?? []).length, 0, 'Saved ABI retained old variables');
  fs.copyFileSync(path.join(project, 'project.abi'), path.join(evidenceDir, 'before-send.abi'));
  await page.screenshot({ path: path.join(evidenceDir, 'before-send.png'), fullPage: true });
  return result;
}

module.exports = { prepareSerialReplay, replaySerialSession, clearWorkspaceForAgent };
