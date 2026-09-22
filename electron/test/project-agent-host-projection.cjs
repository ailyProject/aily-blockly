const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fork, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { runProcedures, rejectCrossPageSignature } = require('./project-agent-procedures.cjs');
const { runCapabilities } = require('./project-agent-capabilities.cjs');
const { runCustomFunctions, rejectCustomCrossPage, rejectCustomRuntimeMutation } = require('./project-agent-custom-functions.cjs');
const { runStructural } = require('./project-agent-structural.cjs');
const { runFieldShape } = require('./project-agent-field-shape.cjs');
const { runConditional } = require('./project-agent-conditional.cjs');
const { runNativeInstances } = require('./project-agent-native-instances.cjs');
const { runNativeCreation } = require('./project-agent-native-creation.cjs');
const { runRandomLibrary } = require('./project-agent-random-libraries.cjs');

// Execute product Agent services over the real authenticated CLI bridge, without an LLM.
async function run() {
  const [project, agentRoot, mode] = process.argv.slice(2);
  const load = file => import(pathToFileURL(path.join(agentRoot, 'dist', file)).href);
  process.send?.({ phase: 'startup:catalog' });
  const { createBlocklyToolCatalog } = await load('blockly/tools/definitions.js');
  process.send?.({ phase: 'startup:history-runtime' });
  const { WorkspaceHistoryRuntime } = await load('extensions/pi-workspace-history/runtime.js');
  const history = new WorkspaceHistoryRuntime(project);
  try {
    process.send?.({ phase: 'startup:history-begin' });
    await history.begin(undefined);
    const catalog = createBlocklyToolCatalog(project, history);
    const call = async (name, args = {}) => {
      process.send?.({ phase: `start:${name}` });
      const tool = catalog.find(tool => tool.name === name); assert.ok(tool, name);
      const result = await tool.execute({ project, ...args });
      process.send?.({ phase: `done:${name}` });
      return result.structuredContent;
    };
    const report = mode === 'context' ? await call('abs_export', { initialize: true })
      : mode === 'candidate' ? await runCandidate(project, load, call, history)
      : mode === 'capabilities' ? await runCapabilities(project, call)
      : mode === 'custom-functions' ? await runCustomFunctions(project, load, call, history)
      : mode === 'custom-cross-page' ? await rejectCustomCrossPage(project, call)
      : mode === 'custom-rollback' ? await rejectCustomRuntimeMutation(project, call)
      : mode === 'procedures' ? await runProcedures(project, load, call, history)
      : mode === 'procedure-cross-page' ? await rejectCrossPageSignature(project, call)
      : mode === 'variables' ? await runVariables(project, load, call, history)
      : mode === 'structural' ? await runStructural(project, load, call, history)
      : mode === 'field-shape' ? await runFieldShape(project, load, call, history)
      : mode === 'conditional' ? await runConditional(project, load, call, history)
      : mode === 'native-instances' ? await runNativeInstances(project, load, call, history)
      : mode === 'native-creation' ? await runNativeCreation(project, load, call, history)
      : mode === 'random-library' ? await runRandomLibrary(project, load, call, history, catalog)
      : mode === 'rebind' ? await runRebind(project, call)
      : mode === 'verify-rebound' ? await verifyRebound(project, call) : await runProjection(project, call);
    const checkpoint = await history.finalize();
    process.send({ ...report, success: true, actualToolRegistry: true, historyChangedPaths: checkpoint?.changedPaths });
  } finally { await history.dispose(); }
  process.disconnect();
}

async function runProjection(project, call) {
  const before = fs.readFileSync(path.join(project, 'project.abi'));
  const exported = await call('abs_export', { initialize: true });
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.receipt.version, 2);
  assert.ok(exported.abs.includes('$ailyProjectDataValue'));
  assert.deepEqual(fs.readFileSync(path.join(project, 'project.abi')), before, 'Export must not save ABI');
  const compact = await call('abs_export', { includeHeader: false });
  assert.equal(compact.ok, true, JSON.stringify(compact));
  assert.ok(compact.abs.startsWith('# ABS Schema: 2'));
  const saved = await call('project_save'); assert.equal(saved.ok, true, JSON.stringify(saved));
  const tidied = await call('blocks_tidy'); assert.equal(tidied.ok, true, JSON.stringify(tidied));
  for (const result of [saved, tidied]) {
    assert.equal(result.absPersistence.verified, true);
    assert.equal(result.finalValidation.scope, 'generation-projection');
    assert.equal(result.generation, result.projectionReceipt.output.binding.generation);
  }
  return { exported: exported.receipt, compact: compact.receipt, saved: saved.projectionReceipt, tidied: tidied.projectionReceipt };
}

async function runCandidate(project, load, call, history) {
  const { createTools } = await load('tools/create-tools.js');
  const general = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = general.find(tool => tool.name === 'read'), write = general.find(tool => tool.name === 'write');
  const mirrors = () => ['project.abi', 'project.abs', 'project.abs.map.json'].map(name => fs.readFileSync(path.join(project, name)));
  const rounds = [];
  let lastValue;
  for (let round = 0; round < 2; round++) {
    const exported = await call('abs_export'); assert.equal(exported.ok, true, JSON.stringify(exported));
    const map = JSON.parse(fs.readFileSync(path.join(project, 'project.abs.map.json'), 'utf8'));
    const node = map.nodes.find(node => node.blockId === 'project_data_smoke_text'); assert.ok(node);
    const value = ('Agent generation round ' + round + ' 中文😀 ').repeat(1800);
    lastValue = value;
    const candidate = exported.abs.slice(0, node.start) + 'text(TEXT=' + JSON.stringify(value) + ')' + exported.abs.slice(node.end)
      + (round === 0 ? '\nstring_add_string()\n' : '');
    await read.execute('read-generation-' + round, { path: 'project.abs' }, undefined, undefined, {});
    await write.execute('write-candidate-' + round, { path: 'project.abs', content: candidate }, undefined, undefined, {});
    const before = mirrors();
    const validation = await call('abs_validate', { generation: exported.generation, absPath: 'project.abs', chunk: true });
    assert.equal(validation.ok, true, JSON.stringify(validation)); assert.deepEqual(mirrors(), before);
    const stale = await call('abs_validate', { generation: 'stale-generation', absPath: 'project.abs' });
    assert.equal(stale.ok, false); assert.deepEqual(mirrors(), before);
    // The first round exercises abs_apply; the second proves abs_import uses the same live identity merge.
    const applied = await call(round === 0 ? 'abs_apply' : 'abs_import', { generation: exported.generation, absPath: 'project.abs', chunk: true });
    assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(applied.applyVerification.ok, true);
    assert.equal(applied.receipt.validation.scope, 'complete-generation');
    assert.ok(!fs.readFileSync(path.join(project, 'project.abs'), 'utf8').includes(value));
    assert.ok(fs.readFileSync(path.join(project, 'project.abs'), 'utf8').includes('$ailyProjectDataValue'));
    rounds.push({ validation: validation.receipt, applied: applied.receipt });
    const saved = await call('project_save'); assert.equal(saved.ok, true, JSON.stringify(saved));
  }
  const recovery = await call('project_recover', { action: 'inspect' });
  assert.equal(recovery.ok, true, JSON.stringify(recovery)); assert.equal(recovery.pending, null);
  return { rounds, recovery, valueHash: createHash('sha256').update(lastValue).digest('hex'), valueLength: lastValue.length };
}

async function runVariables(project, load, call, history) {
  const { createTools } = await load('tools/create-tools.js');
  const general = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = general.find(tool => tool.name === 'read'), write = general.find(tool => tool.name === 'write');
  const mirrors = () => ['project.abi', 'project.abs', 'project.abs.map.json'].map(name => fs.readFileSync(path.join(project, name)));
  const exported = await call('abs_export', { initialize: true }); assert.equal(exported.ok, true, JSON.stringify(exported));
  const capability = await call('block_info', { type: 'variable_define' });
  assert.equal(capability.absCapability?.declaration?.nativeType, '', JSON.stringify(capability));
  let candidate = exported.abs.replace('arduino_global()', 'arduino_global()\n    variable_define("counter", int, math_number(7))')
    .replace('arduino_setup()', 'arduino_setup()\n    variables_set($counter, math_number(8))')
    .replace('arduino_loop()', 'arduino_loop()\n    variables_set($counter, $counter)\n    time_delay(math_number(1000))');
  await read.execute('read-variable-candidate', { path: 'project.abs' }, undefined, undefined, {});
  await write.execute('write-variable-candidate', { path: 'project.abs', content: candidate }, undefined, undefined, {});
  const before = mirrors();
  const missing = await call('abs_validate', { generation: exported.generation, abs: candidate.replace('variables_set($counter', 'variables_set($misspelled') });
  assert.equal(missing.ok, false); assert.deepEqual(mirrors(), before);
  const validation = await call('abs_validate', { generation: exported.generation, absPath: 'project.abs' });
  assert.equal(validation.ok, true, JSON.stringify(validation)); assert.deepEqual(mirrors(), before);
  const applied = await call('abs_apply', { generation: exported.generation, absPath: 'project.abs', chunk: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const first = JSON.parse(fs.readFileSync(path.join(project, 'project.abi'), 'utf8'));
  assert.equal(first.sharedModel.variables.length, 1);
  const model = first.sharedModel.variables[0]; assert.equal(model.name, 'counter');
  assert.equal(model.type ?? '', ''); assert.match(model.id, /^abs-variable:[a-f0-9]{64}:0$/);
  const next = await call('abs_export'); assert.equal(next.ok, true, JSON.stringify(next));
  const savedMirrors = mirrors();
  assert.ok(next.abs.includes('variables_get($counter)'), next.abs);
  const duplicate = await call('abs_validate', { generation: next.generation, abs: next.abs, createVariables: [{ name: 'counter' }] });
  assert.equal(duplicate.ok, false); assert.equal(duplicate.code, 'ABS_VARIABLE_EXISTS'); assert.deepEqual(mirrors(), savedMirrors);
  candidate = next.abs.replace('math_number(8)', 'math_number(9)'); assert.notEqual(candidate, next.abs);
  await read.execute('read-variable-edit', { path: 'project.abs' }, undefined, undefined, {});
  await write.execute('edit-variable-candidate', { path: 'project.abs', content: candidate }, undefined, undefined, {});
  const edited = await call('abs_import', { generation: next.generation, absPath: 'project.abs' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const saved = await call('project_save'); assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, 'project.abi'), 'utf8')).sharedModel.variables, first.sharedModel.variables);
  const inspection = await call('project_recover', { action: 'inspect' });
  assert.equal(inspection.ok, true); assert.equal(inspection.pending, null);
  return { model, missing: missing.code, duplicate: duplicate.code, validation: validation.receipt,
    applied: applied.receipt, edited: edited.receipt, saved: saved.projectionReceipt, diagnostics: inspection.diagnostics };
}

async function runRebind(project, call) {
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'];
  const mirrors = () => files.map(file => fs.readFileSync(path.join(project, file)));
  const before = mirrors();
  const refused = await call('abs_export'); assert.equal(refused.ok, false);
  assert.ok(['ABS_SCOPE_INVALID', 'ABS_MAP_INVALID'].includes(refused.code), JSON.stringify(refused));
  const inspected = await call('project_recover', { action: 'inspect' });
  assert.equal(inspected.ok, true, JSON.stringify(inspected)); assert.equal(inspected.diagnostics.status, 'rebind-required');
  assert.deepEqual(mirrors(), before, 'Diagnosis/refusal must not write');
  const rebound = await call('abs_export', { rebind: inspected.diagnostics.rebind.token });
  assert.equal(rebound.ok, true, JSON.stringify(rebound));
  assert.equal(rebound.receipt.rebind, inspected.diagnostics.rebind.token);
  assert.notEqual(rebound.generation, inspected.diagnostics.generation);
  assert.deepEqual(fs.readFileSync(path.join(project, 'project.abi')), before[0], 'Rebind must not save ABI');
  const after = mirrors();
  const stale = await call('abs_validate', { generation: inspected.diagnostics.generation, abs: rebound.abs });
  assert.equal(stale.ok, false); assert.deepEqual(mirrors(), after, 'Old generation must not be silently rebound');
  const record = JSON.parse(fs.readFileSync(path.join(project, '.aily/abs-sync/baselines', rebound.generation + '.json'), 'utf8'));
  assert.equal(record.inputMap, before[2].toString('utf8')); assert.equal(record.inputAbs, before[1].toString('utf8'));
  return { refused: refused.code, diagnostics: inspected.diagnostics, rebound: rebound.receipt };
}

async function verifyRebound(project, call) {
  const exported = await call('abs_export'); assert.equal(exported.ok, true, JSON.stringify(exported));
  const validation = await call('abs_validate', { generation: exported.generation, abs: exported.abs, chunk: true });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const applied = await call('abs_apply', { generation: exported.generation, abs: exported.abs, chunk: true });
  assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(applied.receipt.validation.scope, 'complete-generation');
  const inspection = await call('project_recover', { action: 'inspect' });
  assert.equal(inspection.ok, true, JSON.stringify(inspection)); assert.equal(inspection.diagnostics.status, 'ready');
  assert.equal(inspection.pending, null);
  return { validation: validation.receipt, applied: applied.receipt, diagnostics: inspection.diagnostics };
}

function testAgentHostProjection(project, agentRoot, mode = 'projection') {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [project, agentRoot, mode], { silent: true, windowsHide: true });
    let errors = ''; let result; let phase = 'startup'; let stopped = false;
    const phases = [], timings = [], startedAt = Date.now();
    child.stdout.resume(); child.stderr.on('data', value => errors += value);
    const stop = () => {
      if (stopped) return;
      stopped = true; clearTimeout(timeout); clearTimeout(idle);
      if (child.exitCode === null) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill();
      }
      reject(new Error(`Agent host projection test timed out at ${phase}`));
    };
    // Multi-edit scenarios perform multiple separate transactions. Bound each
    // operation's inactivity, as well as the whole finite scenario, independently.
    const timeout = setTimeout(stop, ['variables', 'procedures', 'custom-functions', 'structural', 'field-shape', 'conditional', 'native-instances', 'native-creation', 'random-library'].includes(mode) ? 270000 : mode === 'capabilities' ? 180000 : 90000);
    let idle = setTimeout(stop, 90000);
    child.on('message', value => {
      if (typeof value.phase === 'string') {
        phase = value.phase; phases.push(phase); clearTimeout(idle); idle = setTimeout(stop, 90000);
        timings.push({ phase, elapsedMs: Date.now() - startedAt });
        console.log(`[Agent smoke:${mode}] ${phase}`);
      } else result = value;
    });
    child.on('error', error => { clearTimeout(timeout); clearTimeout(idle); reject(error); });
    child.on('exit', code => {
      clearTimeout(timeout); clearTimeout(idle);
      if (code === 0 && result?.success) resolve({ ...result, phases, timings, elapsedMs: Date.now() - startedAt });
      else reject(new Error(errors || `Agent host projection exited ${code}`));
    });
  });
}
module.exports = { testAgentHostProjection, testAgentHostCandidate: (project, agentRoot) => testAgentHostProjection(project, agentRoot, 'candidate') };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; process.disconnect?.(); });
