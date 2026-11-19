import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadHistorySdk, wireHistoryLifecycle } from './r2-history-sdk.mjs';
import { indexCustomerProject } from './customer-project-baseline-case.mjs';
import { documentHash, sha } from './r1-customer-native.mjs';

export const r3CandidateModules = [
  'extensions/pi-workspace-history/runtime', 'extensions/pi-workspace-history/worker',
  'extensions/pi-workspace-history/extension', 'extensions/pi-workspace-history/runtime-candidates',
  'extensions/pi-workspace-history/candidate-store', 'extensions/pi-workspace-history/candidate-record',
  'operations/filesystem', 'operations/candidate-files', 'operations/abs-edit-provenance',
  'operations/abs-edit-evidence', 'extensions/pi-permission-mode/runtime',
  'operations/text-edit-context',
  'blockly/services/abs/working-candidate', 'blockly/services/abs/working-candidate-capability',
  'blockly/services/abs/live', 'blockly/services/abs/host-candidate', 'blockly/tools/registry',
  'blockly/tools/registrars/context', 'blockly/tools/registrars/abs/abs-apply', 'blockly/abs-workflow-guard',
  'blockly/tools/registrars/project/project-save', 'blockly/services/project/workspace',
  'blockly/services/project/save-observation', 'blockly/services/abs/working-candidate-publication', 'blockly/services/app/command',
];

export async function fingerprintCandidateSdk(agentRoot) {
  return Promise.all(r3CandidateModules.map(async name => ({ name,
    sha256: sha(await fs.readFile(path.join(agentRoot, 'dist', name + '.js'))) })));
}

export async function legacyCandidateArtifacts(project, home) {
  const result = [];
  const collect = async (root, label, candidateArchivesOnly = false) => {
    const visit = async directory => {
      let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        assert.equal(entry.isSymbolicLink(), false, 'Only owned physical legacy-artifact paths may be observed');
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (!candidateArchivesOnly) await visit(file); }
        else if (entry.isFile() && (!candidateArchivesOnly || /^candidate-[a-f0-9]{64}\.json$/.test(entry.name)))
          result.push({ path: label + '/' + path.relative(root, file).split(path.sep).join('/'), sha256: sha(await fs.readFile(file)) });
      }
    };
    await visit(root);
  };
  await collect(path.join(home, '.aily-chat/abs-edit-provenance'), 'private-legacy-edit-proof');
  await collect(path.join(home, '.aily-chat/artifacts/abs-edit-drafts'), 'private-legacy-draft-artifact');
  await collect(path.join(project, '.workspace-history/abs-candidate-handoffs'), 'history-legacy-handoff');
  await collect(path.join(project, '.aily/abs-sync/recoveries'), 'host-legacy-candidate-archive', true);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every capture/prepare/apply call delegates the selected production transport.
 * Only request/receipt identity metadata is observed; no response is substituted. */
export async function loadCandidateSdk(agentRoot, audit) {
  const sdk = await loadHistorySdk(agentRoot);
  const load = name => import(pathToFileURL(path.join(agentRoot, 'dist', name + '.js')).href);
  const [pi, capability, operations, permission, editContext, signals, live, transport,
    registry, registrars, applyRegistrar, workflow, saveRegistrar, workspaceServices, commands] = await Promise.all([
    import(sdk.dependency.entry), load('blockly/services/abs/working-candidate-capability'), load('operations/filesystem'),
    load('extensions/pi-permission-mode/runtime'), load('operations/text-edit-context'),
    load('operations/candidate-files'), load('blockly/services/abs/live'),
    load('blockly/services/app/live-operation'),
    load('blockly/tools/registry'), load('blockly/tools/registrars/context'),
    load('blockly/tools/registrars/abs/abs-apply'), load('blockly/abs-workflow-guard'),
    load('blockly/tools/registrars/project/project-save'), load('blockly/services/project/workspace'), load('blockly/services/app/command'),
  ]);
  const delegatedTransport = async (project, operation, params, options) => {
    const entry = { operation, action: params?.action, requestId: params?.requestId, at: Date.now(),
      workingCandidate: params?.workingCandidate ?? params?.validation?.workingCandidate,
      sourceKind: typeof params?.absPath === 'string' ? 'file' : typeof params?.abs === 'string' ? 'inline' : undefined };
    audit.push(entry);
    try {
      const result = await transport.tryLiveBlocklyOperation(project, operation, params, options);
      entry.completedAt = Date.now(); entry.result = result && { ok: result.ok, code: result.code,
        publication: result.publication, receipt: result.receipt, evidence: result.evidence,
        requiresReload: result.requiresReload, commandDispatched: result.commandDispatched };
      return result;
    } catch (error) {
      entry.completedAt = Date.now(); entry.error = { name: error.name, code: error.code, message: error.message }; throw error;
    }
  };
  return { ...sdk, pi, capability, operations, permission, editContext, signals, live,
    registry, registrars, applyRegistrar, workflow, saveRegistrar, workspaceServices,
    command: observeCandidateCommand(commands.appCommand, audit),
    transport: delegatedTransport };
}

/** Preserve the real command/onTarget handshake. The original save service
 * mints and persists its pub2 request before this observer records that ID. */
export function observeCandidateCommand(command, audit) {
  return async (action, project, payload, options = {}) => {
    const entry = { channel: 'actual-app-command', action, operation: payload?.operation, at: Date.now() };
    audit.push(entry);
    const identity = () => {
      const request = payload?.params?.saveRequest;
      if (request) { entry.requestId = request.requestId; entry.requestVersion = request.version; entry.requestOperation = request.operation; }
    };
    try {
      const result = await command(action, project, payload, { ...options, onTarget: async target => {
        await options.onTarget?.(target);
        identity(); entry.targetPid = target.pid; entry.nativeSaveReceiptVersion = target.nativeSaveReceiptVersion;
      } });
      identity(); entry.completedAt = Date.now();
      const facts = result?.result ?? result;
      entry.result = result && { ok: result.ok, code: result.code, saveReceipt: result.saveReceipt,
        publicationObservation: result.publicationObservation, publication: facts?.publication,
        projectionReceipt: facts?.projectionReceipt, absPersistence: facts?.absPersistence,
        finalValidation: facts?.finalValidation, generatedCodePublished: facts?.generatedCodePublished };
      return result;
    } catch (error) { identity(); entry.completedAt = Date.now(); entry.error = { name: error.name, code: error.code, message: error.message }; throw error; }
  };
}

export function appendCandidateUser(manager, text) {
  manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
  // Persist the ordinary Pi session header in this model-free lifecycle harness.
  manager.appendMessage({ role: 'assistant', content: [], api: 'openai-responses', provider: 'offline-fixture',
    model: 'no-provider-call', stopReason: 'stop', timestamp: Date.now(), usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } });
}

/** Actual production lifecycle owns checkpoint recording and cold materialization. */
export function candidateSession(sdk, project, manager, signal, onNotice = () => {}) {
  const wired = wireHistoryLifecycle(sdk, project, manager, onNotice);
  const { history, handlers, context } = wired;
  const mode = new sdk.permission.PermissionModeRuntime({ permissionMode: () => 'default' });
  mode.restore(context);
  const candidateFiles = sdk.capability.createWorkingCandidateFileCapability(project, history,
    { signal: () => signal, transport: sdk.transport });
  const files = sdk.operations.createWorkspaceFileOperations(project, history, mode, [], [], [], { candidateFiles, signal });
  const read = sdk.signals.withCandidateFileSignal(sdk.pi.createReadToolDefinition(project, { operations: files.read }));
  const edit = sdk.signals.withCandidateFileSignal(sdk.editContext.withTextEditContext(
    sdk.pi.createEditToolDefinition(project, { operations: files.edit })));
  const registry = sdk.registry.createBlocklyToolRegistry(project, history, 'blockly');
  const registrar = sdk.registrars.createRegistrarContext(registry, project, history,
    new sdk.workflow.AbsWorkflowGuard(), 'blockly');
  registrar.candidateBackupTransport = sdk.transport;
  sdk.applyRegistrar.registerAbsApply(registrar, 'abs_apply', (target, source, options) =>
    sdk.live.absApplyLiveFirst(target, source, options, sdk.transport));
  sdk.saveRegistrar.registerProjectSave(registrar, (target, _command, observation) =>
    sdk.workspaceServices.projectSaveLive(target, sdk.command, observation));
  const apply = registry.definitions().find(tool => tool.name === 'abs_apply'); assert.ok(apply);
  const save = registry.definitions().find(tool => tool.name === 'project_save'); assert.ok(save);
  return { ...wired, manager, files,
    async begin() { await handlers.get('session_start')({}, context); await handlers.get('before_agent_start')({}, context); },
    async read() {
      const result = await read.execute(randomUUID(), { path: 'project.abs' }, signal, undefined, context);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const selected = history.candidateRef('project.abs'); assert.ok(selected, 'Real Core read must select a durable candidate');
      const candidate = await history.readCandidate(selected, { signal });
      return { result, candidate };
    },
    async edit(oldText, newText) {
      const result = await edit.execute(randomUUID(), { path: 'project.abs', edits: [{ oldText, newText }] }, signal, undefined, context);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const candidate = await history.readCandidate(history.candidateRef('project.abs'), { signal });
      assert.equal(candidate.record.derivation.kind, 'splices', 'Core edit must publish its real exact-splice relationship');
      return { result, candidate };
    },
    async apply() {
      const result = await apply.execute({ project, absPath: 'project.abs' }, signal,
        { toolCallId: randomUUID(), sessionId: manager.getSessionId() });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent ?? result));
      assert.ok(result.structuredContent, 'The actual registrar must retain its structured native result');
      return result.structuredContent;
    },
    async save() {
      const result = await save.execute({ project }, signal,
        { toolCallId: randomUUID(), sessionId: manager.getSessionId() });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent ?? result));
      assert.ok(result.structuredContent, 'The actual project_save registrar must retain original native facts');
      return result.structuredContent;
    },
    async settle() { await handlers.get('agent_settled')({}, context); },
  };
}

export function candidateFieldPlans(document, visibleIds) {
  const visible = new Set(visibleIds);
  const nodes = [...indexCustomerProject(document).values()].filter(block => visible.has(block.id)
    && block.type === 'math_number' && Number.isSafeInteger(block.fields?.NUM)
    && block.fields.NUM >= 0 && block.fields.NUM < 9000);
  assert.ok(nodes.length >= 3, 'The original visible program needs three distinct genuine numeric blocks');
  const plan = (block, delta) => ({ blockId: block.id, field: 'NUM', oldValue: block.fields.NUM, value: block.fields.NUM + delta });
  return { A: plan(nodes[0], 1), B: plan(nodes[1], 2), C: plan(nodes[2], 7) };
}

export function expectedCandidateDocument(original, ...plans) {
  const expected = JSON.parse(JSON.stringify(original));
  const nodes = indexCustomerProject(expected);
  for (const plan of plans) { assert.ok(nodes.has(plan.blockId)); nodes.get(plan.blockId).fields[plan.field] = plan.value; }
  return expected;
}

export async function candidateBase(history, read, signal) {
  const result = {};
  for (const name of ['document', 'abs', 'map', 'contracts']) {
    const bytes = await history.readCandidateObject(read.ref, read.record.base[name], { signal });
    result[name] = name === 'abs' ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
  }
  return result;
}

/** Read actual immutable splice relationships to locate a known baseline ID in
 * its current source. This is only edit planning; Core owns every publication. */
export async function exactCandidateFieldEdit(history, read, plan, signal) {
  const map = JSON.parse((await history.readCandidateObject(read.ref, read.record.base.map, { signal })).toString('utf8'));
  const binding = map.nodes.find(node => node.blockId === plan.blockId);
  assert.ok(binding, 'The real frozen projection must contain the selected original ID');
  const chain = []; let selected = read;
  while (selected.record.parent) {
    chain.push(selected); selected = await history.readCandidate(selected.record.parent, { signal });
  }
  let start = binding.start, end = binding.end;
  for (const revision of chain.reverse()) {
    if (revision.record.derivation.kind === 'fork') continue;
    assert.equal(revision.record.derivation.kind, 'splices', 'An unresolved replacement cannot be treated as a tracked numeric edit');
    const edits = JSON.parse((await history.readCandidateObject(revision.ref, revision.record.derivation.edits, { signal })).toString('utf8'));
    let shift = 0;
    for (const edit of edits) {
      if (edit.end <= start) shift += edit.text.length - (edit.end - edit.start);
      else assert.ok(edit.start >= end, 'The next independently selected field must not overlap an earlier edit');
    }
    start += shift; end += shift;
  }
  const call = read.source.slice(start, end);
  const match = /^math_number\(\s*(?:NUM\s*=\s*)?(-?\d+(?:\.\d+)?)\s*\)/.exec(call);
  assert.ok(match, 'Use a genuine ordinary numeric call, never patch opaque state or model identities');
  assert.equal(Number(match[1]), plan.oldValue);
  const numberStart = start + match[0].indexOf(match[1], match[0].indexOf('('));
  let from = numberStart, to = numberStart + match[1].length, oldText;
  for (let context = 32; ; context = Math.min(read.source.length, context * 2)) {
    from = Math.max(0, numberStart - context); to = Math.min(read.source.length, numberStart + match[1].length + context);
    oldText = read.source.slice(from, to);
    if (read.source.indexOf(oldText) === read.source.lastIndexOf(oldText)) break;
    assert.ok(from > 0 || to < read.source.length, 'Even the full source must identify one exact Core edit');
  }
  assert.equal(read.source.indexOf(oldText), read.source.lastIndexOf(oldText), 'Core edit context must be unique');
  const newText = oldText.slice(0, numberStart - from) + String(plan.value) + oldText.slice(numberStart - from + match[1].length);
  return { oldText, newText };
}

export async function verifyCandidatePublication(project, expected, result, nativeReceipt) {
  assert.equal(result.ok, true, JSON.stringify({ code: result.code, error: result.error, publication: result.publication }));
  assert.equal(result.publication.status, 'COMMITTED'); assert.equal(result.requiresReload, false);
  assert.equal(result.applyVerification?.ok, true); assert.equal(result.absPersistence?.verified, true);
  assert.equal(nativeReceipt?.version, 2); assert.equal(nativeReceipt.validation?.ok, true);
  assert.equal(nativeReceipt.validation.scope, 'complete-generation');
  const binding = nativeReceipt.output.binding;
  const files = await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFile(path.join(project, file))));
  for (const [at, key] of ['abiHash', 'absHash', 'mapHash'].entries()) assert.equal('sha256:' + sha(files[at]), binding[key]);
  assert.equal(files[1].length, nativeReceipt.output.absBytes);
  assert.equal(documentHash(JSON.parse(files[0].toString('utf8'))), documentHash(expected));
  const map = JSON.parse(files[2].toString('utf8'));
  assert.equal(map.generation, binding.generation); assert.equal(map.baseAbsHash, binding.absHash);
  assert.deepEqual(map.scope, binding.scope);
  return { binding, bytes: files.map(value => value.length), fullDocumentVerified: true };
}
