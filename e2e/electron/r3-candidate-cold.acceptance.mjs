import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from '@playwright/test';
import { createAbsStopModel } from '../fixtures/abs-stop-model.mjs';
import { createLocalChatApiRouter, prepareInstalledChatProfile, assertInstalledChatLoaded } from '../fixtures/installed-chat-ui.mjs';
import { prepareBuildLogProject } from './fixtures/build-log-project.mjs';
import { singleFieldExpectedDocument } from './fixtures/online-comparison.mjs';
import { readWorkingCandidateEvidence, selectedWorkingCandidateRef } from './fixtures/r3-candidate-evidence.mjs';
import { installR3CandidatePublicationFault } from './fixtures/r3-candidate-publication-fault.mjs';
import { createCandidateColdGates, installCandidateColdAudit, assertCandidateColdDispatches,
  assertPhysicalCandidateMode, readCandidateAcceptanceEvidence } from './fixtures/r3-candidate-cold.mjs';
import { readBoardSessionStartup } from './fixtures/r2-board-session-startup.mjs';
import { waitForColdSessionOpen } from './fixtures/abs-cold-continuity.mjs';
import { assertUserStoppedAssistant, assertUserStopTerminalUi, readUserStopTerminalUi } from './fixtures/abs-stop-presentation.mjs';
import { assertCapturedEnvironmentProcess, selectEnvironmentProcessTree, remainingEnvironmentProcesses, environmentProcessStopScript } from './fixtures/r2-environment-cleanup.mjs';

// Root runs this once against an explicitly sealed pair. Only provider output
// is deterministic; every Candidate, native publication and Stop is production.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const names = ['executable-path', 'installed-root', 'lex-root', 'resource-root', 'test-root', 'output', 'expected-input-hash', 'expected-host-hash'];
const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) });
assert.equal(process.env.AILY_R3_CANDIDATE_COLD_HOST_WINDOW, '1', 'Root owns the single actual Host window');
for (const name of names.filter(name => !name.startsWith('expected-'))) assert.ok(path.isAbsolute(values[name] ?? ''), name);
for (const name of names.filter(name => name.startsWith('expected-'))) assert.match(values[name] ?? '', /^[a-f0-9]{64}$/);
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output));
assert.ok(inside(path.join(values['resource-root'], 'dev-tests'), values['test-root']));
const sha = value => createHash('sha256').update(value).digest('hex'), hash = value => 'sha256:' + sha(value), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const { verifyPortableBuild } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/server/portable-integrity.ts')));
const { captureBuildInputs } = await import(pathToFileURL(path.join(values['lex-root'], 'packages/aily-chat/scripts/portable-build-inputs.mjs')));
const artifact = await verifyPortableBuild(values['installed-root']);
assert.equal(artifact.inputHash, values['expected-input-hash']);
assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))));
const asar = path.join(path.dirname(values['executable-path']), 'resources/app.asar');
assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash']);
await fs.mkdir(values.output, { recursive: false }); await fs.mkdir(values['test-root'], { recursive: true });
const suite = await fs.mkdtemp(path.join(values['test-root'], 'r3-candidate-cold-')),
  project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp'), absPath = path.join(project, 'project.abs');
await fs.mkdir(home); await fs.mkdir(temp);
const fixture = await prepareBuildLogProject({ directory: project, boardsRoot: path.resolve(repo, '../aily-blockly-boards'),
  librariesRoot: path.resolve(repo, '../aily-blockly-libraries'), scenario: 'field-edit', marker: 'R3_CANDIDATE_COLD_NO_BUILD' });
const seed = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'));
seed.blocks.blocks.find(block => block.type === 'arduino_global').inputs.ARDUINO_GLOBAL.block.next = {
  block: { type: fixture.blockType, id: 'r3_cold_B', fields: { VALUE: 200 },
    next: { block: { type: fixture.blockType, id: 'r3_cold_C', fields: { VALUE: 300 } } } } };
await fs.writeFile(path.join(project, 'project.abi'), JSON.stringify(seed, null, 2));
const evidence = { ok: false, suite, project, artifact, hostHash: values['expected-host-hash'], startedAt: new Date().toISOString(),
  realInstalledChat: true, realAsarHost: true, deterministicLocalModel: true, paidModelRequests: 0,
  fabricatedCandidateAuthority: false, fabricatedHostReceipts: false, manualColdProjectOpen: false, manualColdSessionOpen: false,
  stages: [], launchAttempts: [], launches: [], tools: [], sessionCommands: [], sessionResponses: [], abortCommands: [], abortResponses: [], eventCounts: {}, resources: [] };
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2));
const phase = async name => { evidence.stages.push({ name, at: Date.now() }); console.log('R3_CANDIDATE_COLD_PHASE=' + name); await persist(); };
const textOf = message => (message?.content ?? []).filter(value => value.type === 'text').map(value => value.text).join('\n');
const resultOf = message => { if (message?.details?.result) return message.details.result; try { return JSON.parse(textOf(message)); } catch {} };
const callsOf = snapshot => (snapshot.messages ?? []).filter(message => message.role === 'assistant').flatMap(message => message.content ?? [])
  .filter(value => value.type === 'toolCall').map(value => ({ ...value, actualName: value.name === 'tool_invoke' ? value.arguments.name : value.name }));
const native = (id, name, args) => ({ id, name, arguments: args }), deferred = (id, name, args) => native(id, 'tool_invoke', { name, arguments: args });
const latestCheckpoint = () => snapshot.entries.findLast(value => value.type === 'custom' && value.customType === 'aily.workspace-history'
  && (!value.data?.workspaceRoot || same(value.data.workspaceRoot, project)))?.data;
const exec = promisify(execFile), gates = createCandidateColdGates();
const processes = async () => { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }); const all = JSON.parse(stdout); return Array.isArray(all) ? all : [all]; };
const mirrors = async () => Object.fromEntries(await Promise.all(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json'].map(async name => {
  try { const raw = await fs.readFile(path.join(project, name)); return [name, { hash: hash(raw), bytes: raw.length }]; }
  catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error; }
})));
let app, page, loaded, router, model, profile, mainIdentity, sessionId, snapshot, attempt = 0, startupReady = false,
  baseDocument, expectedC, expectedAC, expectedABC, candidateA, originalRequestId, faultInstalled = false, coldReopened = false;
const seenTools = new Set(), abortIds = new Set();
const document = () => page.evaluate(() => JSON.parse(window.ng.getComponent(window.document.querySelector('app-blockly-editor')).blocklyService.captureRecoverySnapshot().documentText));
const state = () => page.evaluate(() => {
  const editorElement = document.querySelector('app-blockly-editor'), hostElement = document.querySelector('app-child-tool-host'), headerElement = document.querySelector('app-header');
  const editor = editorElement && window.ng.getComponent(editorElement), host = hostElement && window.ng.getComponent(hostElement), domain = headerElement && window.ng.getComponent(headerElement)?.projectService;
  return { project: domain?.currentProjectPath ?? null, ready: domain?.getBlocklyProjectLoadStatus()?.ready ?? false,
    blocked: editor?.blocklyService.isWorkspaceEditBlocked() ?? false, running: editor?.blocklyService.isWorkspaceEditInProgress() ?? false,
    recoveryRequired: editor?.blocklyService.isWorkspaceRecoveryRequired() ?? false, writing: editor?.blocklyService.aiWriting ?? false,
    hasRunning: host?.aiOperationProtocol?.hasRunning ?? false,
    doingNotices: [...(editor?.noticeService.ownedNotices.values() ?? [])].filter(value => value.state === 'doing').length,
    noticeHasStop: typeof editor?.noticeService.data?.stop === 'function' };
});
async function descriptor() {
  const deadline = Date.now() + 30000, filename = path.join(home, '.aily-blockly/cli-bridge', mainIdentity.ProcessId + '.json');
  while (Date.now() < deadline) { try { const value = JSON.parse(await fs.readFile(filename, 'utf8')); assert.equal(value.pid, mainIdentity.ProcessId); return value; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await wait(50); } }
  throw Error('Actual owned CLI descriptor was not published');
}
async function installAuditAndFault(cold = false) {
  const info = await descriptor(), config = { project, appData, pid: mainIdentity.ProcessId, port: info.port };
  if (cold) {
    assert.equal((await app.evaluate(installCandidateColdAudit, JSON.stringify(config))).available, true);
    evidence.coldFaultInstalled = await app.evaluate(installR3CandidatePublicationFault, JSON.stringify({ ...config,
      observationOnly: true, requestId: originalRequestId, ref: candidateA.ref, expectedDocument: expectedAC }));
  } else {
    evidence.initialFaultInstalled = await app.evaluate(installR3CandidatePublicationFault, JSON.stringify({ ...config,
      ref: candidateA.ref, expectedDocument: expectedAC }));
  }
  faultInstalled = true;
}
async function acknowledgeTrust() {
  assert.equal(await loaded.frame.locator('.full-access-permission-dialog').isVisible(), false);
  const dialogs = loaded.frame.locator('.pi-extension-dialog');
  for (let index = 0; index < await dialogs.count(); index++) { const dialog = dialogs.nth(index); if (!await dialog.isVisible()) continue;
    const lines = String(await dialog.getAttribute('aria-label')).split(/\r?\n/); assert.equal(lines[0], 'Trust project folder?'); assert.ok(same(lines[1], project));
    await dialog.getByRole('button', { name: 'Trust (this session only)', exact: true }).click(); }
}
async function observe() {
  assert.deepEqual(model.snapshot().failures, []); await acknowledgeTrust();
  if (!startupReady) {
    const opened = await readBoardSessionStartup({ commands: evidence.sessionCommands.filter(value => value.attempt === attempt), responses: evidence.sessionResponses,
      project, readRegistry: async () => (await loaded.e2e('session.list')).sessions.filter(value => same(value.cwd, project)) });
    if (!opened) return;
    assert.ok(opened.registry.length <= 1 && opened.registry.some(value => value.sessionId === opened.ready.sessionId));
    if (sessionId) assert.equal(opened.ready.sessionId, sessionId); else sessionId = opened.ready.sessionId;
    startupReady = true; evidence.launches.at(-1).sessionStartup = opened;
  }
  snapshot = (await loaded.e2e('session.read', { sessionId })).session;
  assert.equal(snapshot.sessionId, sessionId); assert.ok(same(snapshot.cwd, project)); assert.equal(snapshot.permissionMode, 'default');
  const calls = callsOf(snapshot);
  for (const message of snapshot.messages.filter(value => value.role === 'toolResult')) {
    if (seenTools.has(message.toolCallId)) continue; seenTools.add(message.toolCallId);
    const result = resultOf(message), tool = { id: message.toolCallId, name: calls.find(value => value.id === message.toolCallId)?.actualName ?? message.toolName,
      isError: message.isError === true, result }; evidence.tools.push(tool);
    if (!gates.has(tool.id)) continue;
    assert.equal(tool.isError, false, JSON.stringify(tool));
    if (tool.id === 'read-Working-before-A') {
      evidence.capture = await readWorkingCandidateEvidence({ project, snapshot });
      evidence.initialSourceMode = assertPhysicalCandidateMode(selectedWorkingCandidateRef(snapshot, project).checkpoint, evidence.capture.ref, { prepared: true });
      const object = evidence.capture.record.base.document;
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, '.workspace-history/objects', object.hash.slice(0, 2), object.hash + '.blob'), 'utf8')), expectedC);
      assert.deepEqual(await document(), expectedC); assert.deepEqual(await mirrors(), evidence.dirtyWorking.savedMirrors);
    }
    if (tool.id === 'edit-private-A') {
      const source = evidence.capture.source.replace(`${fixture.blockType}(100)`, `${fixture.blockType}(101)`); assert.notEqual(source, evidence.capture.source);
      candidateA = await readWorkingCandidateEvidence({ project, snapshot, candidateHash: hash(source), expectedBase: evidence.capture.record.base });
      assert.equal(candidateA.ref.id, evidence.capture.ref.id); assert.equal(candidateA.record.derivation.kind, 'splices');
      evidence.candidateA = candidateA; assert.deepEqual(await document(), expectedC); assert.deepEqual(await mirrors(), evidence.dirtyWorking.savedMirrors);
      await installAuditAndFault(false);
    }
    if (tool.id === 'read-A-after-cold') {
      evidence.workingAfterAcceptedA = await readWorkingCandidateEvidence({ project, snapshot });
      evidence.successorSourceMode = assertPhysicalCandidateMode(selectedWorkingCandidateRef(snapshot, project).checkpoint, evidence.workingAfterAcceptedA.ref, { prepared: true });
      assert.notEqual(evidence.workingAfterAcceptedA.ref.id, candidateA.ref.id, 'A confirmed accepted intent closes; the next read opens a new Working candidate');
      const base = evidence.workingAfterAcceptedA.record.base.document;
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, '.workspace-history/objects', base.hash.slice(0, 2), base.hash + '.blob'), 'utf8')), expectedAC);
      assert.equal(evidence.workingAfterAcceptedA.record.derivation.kind, 'capture');
      assert.equal(evidence.workingAfterAcceptedA.record.base.published?.generation, evidence.firstFault.terminals[0].generation);
      evidence.oldAcceptedA = await readWorkingCandidateEvidence({ project, ref: candidateA.ref, candidateHash: candidateA.sourceHash, expectedBase: candidateA.record.base });
      assert.deepEqual(await document(), expectedAC);
    }
    if (tool.id === 'edit-B-after-cold') {
      const current = evidence.workingAfterAcceptedA, source = current.source.replace(`${fixture.blockType}(200)`, `${fixture.blockType}(201)`); assert.notEqual(source, current.source);
      evidence.candidateAB = await readWorkingCandidateEvidence({ project, snapshot, candidateHash: hash(source), expectedBase: current.record.base });
      assert.equal(evidence.candidateAB.ref.id, current.ref.id); assert.notEqual(evidence.candidateAB.ref.revisionHash, current.ref.revisionHash);
      assert.deepEqual(await document(), expectedAC); assert.deepEqual(await mirrors(), evidence.afterStop.mirrors);
    }
    if (tool.id === 'apply-ABC-after-cold') await verifyFinalApplication(result);
    gates.release(tool.id);
  }
}
async function until(predicate, label) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { await observe(); if (await predicate()) return; await wait(100); }
  throw Error(label);
}
async function clearUi() {
  await until(async () => { const current = await state(); return current.ready && !current.blocked && !current.running && !current.recoveryRequired
    && !current.writing && !current.hasRunning && current.doingNotices === 0 && !current.noticeHasStop; }, 'Actual Stop left native/notice work running');
  await loaded.frame.locator('button.primary-action.stop-action').waitFor({ state: 'hidden', timeout: 15000 });
  assert.equal(await page.locator('app-notification .notification-box').filter({ hasText: /AI正在操作|正在停止 AI|正在同步 AI 状态/ }).count(), 0);
}
async function submit(text) {
  await acknowledgeTrust(); const composer = loaded.frame.locator('.aily-chat-composer-input[role="textbox"]');
  await composer.fill(text); const send = loaded.frame.locator('button.primary-action.send-action'); await send.waitFor({ state: 'visible', timeout: 15000 }); await send.click();
}
function wireSocket(socket) {
  socket.on('framesent', ({ payload }) => { let value; try { value = JSON.parse(String(payload)); } catch { return; }
    if (value.channel !== 'agent') return; const command = value.command;
    if (command?.type === 'abort') { abortIds.add(value.id); evidence.abortCommands.push({ id: value.id, sessionId: command.sessionId, source: command.source, reason: command.reason, at: Date.now() }); }
    if (['session.create', 'session.subscribe', 'session.openSubscribe', 'session.open', 'prompt'].includes(command?.type))
      evidence.sessionCommands.push({ attempt, id: value.id, type: command.type, sessionId: command.sessionId ?? command.options?.sessionId, cwd: command.options?.cwd, at: Date.now() });
  });
  socket.on('framereceived', ({ payload }) => { let value; try { value = JSON.parse(String(payload)); } catch { return; }
    if (value.channel !== 'agent') return;
    if (value.type === 'event' && value.event?.type) evidence.eventCounts[value.event.type] = (evidence.eventCounts[value.event.type] ?? 0) + 1;
    if (value.type !== 'response') return;
    if (abortIds.has(value.id)) evidence.abortResponses.push({ id: value.id, ok: value.ok, accepted: value.result?.accepted, at: Date.now() });
    if (evidence.sessionCommands.some(command => command.id === value.id)) evidence.sessionResponses.push({ id: value.id, ok: value.ok,
      subscribed: value.result?.subscribed, sessionId: value.result?.snapshot?.sessionId, cwd: value.result?.snapshot?.cwd,
      errorCode: value.error?.code, errorMessage: value.error?.message, at: Date.now() });
  });
}
async function launch(nextAttempt) {
  attempt = nextAttempt; startupReady = false; page = undefined;
  assert.ok(os.freemem() >= 1024 ** 3, 'Tiny functional host cold reserve is 1024 MiB'); evidence.resources.push({ attempt, freeMemory: os.freemem(), at: Date.now() });
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_PORTABLE_ROOT, AILY_AUTH_FILE, ...env } = process.env;
  evidence.launchAttempts.push({ attempt, at: Date.now() });
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo, args: [`--user-data-dir=${path.join(suite, 'electron-profile')}`], timeout: 60000,
    env: { ...env, ...profile.env, AILY_E2E: '1', HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_audit: 'false' } });
  const pid = await app.evaluate(() => process.pid); mainIdentity = (await processes()).find(value => value.ProcessId === pid);
  assertCapturedEnvironmentProcess(mainIdentity, { ...mainIdentity, ExecutablePath: values['executable-path'] });
  assert.ok(mainIdentity.CommandLine.includes(path.join(suite, 'electron-profile'))); assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  evidence.launches.push({ attempt, main: mainIdentity, at: Date.now(), observerProjectOpenIssued: false, observerSessionOpenIssued: false });
  if (attempt) await installAuditAndFault(true);
  else { const info = await descriptor(); assert.equal((await app.evaluate(installCandidateColdAudit, JSON.stringify({ project, appData, pid, port: info.port }))).available, true); }
  await app.context().route('**/*', route => { const url = new URL(route.request().url()); return !['http:', 'https:'].includes(url.protocol)
    || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient'); });
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) { for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break; } if (!page) await wait(100); }
  assert.ok(page); page.on('websocket', wireSocket); page.on('dialog', dialog => dialog.dismiss());
  await page.evaluate(() => { const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click(); };
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss(); });
  await page.waitForFunction(() => { const element = document.querySelector('app-header'); return element && window.ng?.getComponent(element)?.projectService; });
  if (!attempt) { evidence.launches.at(-1).initialFixtureOpenIssued = true;
    await page.evaluate(async target => { const domain = window.ng.getComponent(document.querySelector('app-header')).projectService;
      await domain.initializeProjectDataSchema(target); if (!await domain.projectOpen(target)) throw Error('Owned tiny project failed to open'); }, project); }
  await page.waitForFunction(target => { const element = document.querySelector('app-header'), domain = element && window.ng?.getComponent(element)?.projectService;
    return domain?.currentProjectPath === target && domain?.getBlocklyProjectLoadStatus(target)?.ready === true; }, project, { timeout: 120000 });
  const output = path.join(values.output, 'launch-' + attempt); await fs.mkdir(output);
  loaded = await assertInstalledChatLoaded(page, { installedRoot: values['installed-root'], output, expectedApiBase: router.origin,
    expectedInputHash: artifact.inputHash, expectedOutputHash: artifact.outputHash }); evidence.launches.at(-1).chat = loaded.evidence;
  if (attempt) { evidence.launches.at(-1).originalSessionOpen = await waitForColdSessionOpen({ project, sessionId, attempt,
      commands: () => evidence.sessionCommands, responses: () => evidence.sessionResponses,
      readRegistry: async () => (await loaded.e2e('session.list')).sessions.filter(value => same(value.cwd, project)) }); startupReady = true; }
}
async function stopOwned(kind) {
  if (!mainIdentity) return;
  const all = await processes(), current = all.find(value => value.ProcessId === mainIdentity.ProcessId);
  assert.ok(current, 'Capture owned tree before Main disappears'); assertCapturedEnvironmentProcess(current, mainIdentity);
  const tree = selectEnvironmentProcessTree(all, mainIdentity);
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(mainIdentity)], { windowsHide: true, timeout: 20000 });
  for (const child of remainingEnvironmentProcesses(tree, await processes()).filter(value => value.ProcessId !== mainIdentity.ProcessId))
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(child)], { windowsHide: true, timeout: 20000 });
  const deadline = Date.now() + 30000; let remaining;
  do { remaining = remainingEnvironmentProcesses(tree, await processes()); if (!remaining.length) break; await wait(100); } while (Date.now() < deadline);
  (evidence.cleanup ??= []).push({ kind, main: mainIdentity, tree, remaining, gracefulCloseTested: false }); assert.deepEqual(remaining, []);
  app = undefined; page = undefined; loaded = undefined; mainIdentity = undefined; faultInstalled = false;
}
async function verifyFinalApplication(result) {
  assert.equal(result?.ok, true); assert.equal(result.publication?.status, 'COMMITTED'); assert.equal(result.applyVerification?.ok, true);
  assert.equal(result.requiresReload, false); assert.equal(result.absPersistence?.verified, true);
  const audit = await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit.snapshot());
  const terminal = audit.terminals.findLast(value => value.operation === 'abs_apply' && value.ok === true);
  assert.ok(terminal?.receipt); assert.notEqual(terminal.requestId, originalRequestId); assert.deepEqual(terminal.receipt.workingCandidate, evidence.candidateAB.ref);
  for (const [file, key] of [['project.abi', 'abiHash'], ['project.abs', 'absHash'], ['project.abs.map.json', 'mapHash']])
    assert.equal(hash(await fs.readFile(path.join(project, file))), terminal.receipt.output.binding[key]);
  assert.deepEqual(await document(), expectedABC); assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expectedABC);
  evidence.finalApplication = { result, requestId: terminal.requestId, receipt: terminal.receipt };
}

try {
  model = await createAbsStopModel({ nextTool: async input => {
    assert.deepEqual(model.snapshot().failures, []); if (input.turn) assert.equal(coldReopened, true);
    await gates.wait(input); const { turn, step } = input;
    if (!turn) {
      if (step === 0) return native('load-candidate-tools', 'tool_load', { names: ['abs_apply', 'project_recover'] });
      if (step === 1) return native('read-Working-before-A', 'read', { path: absPath });
      if (step === 2) return native('edit-private-A', 'edit', { path: absPath, edits: [{ oldText: `${fixture.blockType}(100)`, newText: `${fixture.blockType}(101)` }] });
      if (step === 3) return deferred('apply-A-lost-ACK', 'abs_apply', { project, absPath });
      throw Error('The real first turn must Stop during original-ID observation before another provider step');
    }
    assert.equal(turn, 1, 'Only two actual user/provider turns are allowed');
    if (step === 0) return native('read-A-after-cold', 'read', { path: absPath });
    if (step === 1) return native('edit-B-after-cold', 'edit', { path: absPath, edits: [{ oldText: `${fixture.blockType}(200)`, newText: `${fixture.blockType}(201)` }] });
    if (step === 2) return deferred('apply-ABC-after-cold', 'abs_apply', { project, absPath });
    assert.equal(step, 3); return undefined;
  } });
  router = await createLocalChatApiRouter({ operationOrigin: model.origin, installedRoot: values['installed-root'] });
  profile = await prepareInstalledChatProfile({ appData, installedRoot: values['installed-root'], apiBase: router.origin,
    baseConfigPath: path.join(repo, 'electron/config/config.json'), resourceAppData: values['resource-root'], token: router.token });
  await phase('fresh-real-installed-Chat-and-dirty-Working-C'); await launch(0);
  baseDocument = await document(); const savedMirrors = await mirrors();
  await page.evaluate(() => { const block = window.Blockly.getMainWorkspace().getBlockById('r3_cold_C'); if (!block) throw Error('Actual C block missing'); block.setFieldValue(301, 'VALUE'); });
  expectedC = singleFieldExpectedDocument(baseDocument, 'r3_cold_C', 'VALUE', 300, 301);
  expectedAC = singleFieldExpectedDocument(expectedC, fixture.blockId, 'VALUE', 100, 101);
  expectedABC = singleFieldExpectedDocument(expectedAC, 'r3_cold_B', 'VALUE', 200, 201);
  assert.deepEqual(await document(), expectedC); assert.deepEqual(await mirrors(), savedMirrors);
  evidence.dirtyWorking = { savedMirrors, fullDocument: expectedC, implicitlySaved: false };
  await submit('Change field A from 100 to 101 and apply it, preserving the existing program and my field C change.');
  await phase('real-commit-A-then-drop-ACK-and-hold-original-readonly-observation');
  await until(async () => {
    if (!faultInstalled) return false;
    const value = await app.evaluate(() => globalThis.__ailyR3CandidateFault.snapshot());
    assert.deepEqual(value.failures, []); if (value.drops !== 1 || value.held !== 1) return false;
    evidence.firstFault = value; originalRequestId = value.requestId; return true;
  }, 'The exact original COMMITTED ACK and following current observation were not intercepted');
  assert.equal(evidence.firstFault.commands.filter(value => value.operation === 'abs_apply').length, 1);
  assert.deepEqual(evidence.firstFault.ref, candidateA.ref); assert.deepEqual(await document(), expectedAC);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8')), expectedAC);
  await page.screenshot({ path: path.join(values.output, 'committed-A-original-observation-held.png'), fullPage: true });
  await phase('click-real-Chat-Stop-original-observation');
  await loaded.frame.locator('button.primary-action.stop-action').waitFor({ state: 'visible', timeout: 15000 });
  await loaded.frame.locator('button.primary-action.stop-action').click();
  await until(() => snapshot?.isIdle && !snapshot.isStreaming && snapshot.messages.filter(value => value.role === 'user').length === 1, 'Actual first turn did not settle after user Stop');
  await clearUi(); evidence.firstStop = assertUserStoppedAssistant(snapshot);
  await loaded.frame.locator('.x-aily-interruption-divider[role="status"], .x-aily-interruption-text[role="status"]').first().waitFor({ state: 'visible', timeout: 15000 });
  evidence.firstStopUi = await loaded.frame.evaluate(readUserStopTerminalUi); assertUserStopTerminalUi(evidence.firstStopUi);
  assert.equal(evidence.abortCommands.length, 1); assert.equal(evidence.abortCommands[0].sessionId, sessionId);
  assert.equal(evidence.abortCommands[0].source, 'user'); assert.equal(evidence.abortCommands[0].reason, 'user_stop');
  assert.ok(evidence.abortResponses.some(value => value.ok && value.accepted === true));
  const selected = selectedWorkingCandidateRef(snapshot, project), pending = selected.checkpoint.candidatePublications?.[originalRequestId];
  assert.equal(pending?.kind, 'abs_apply'); assert.deepEqual(pending.ref, candidateA.ref);
  assert.equal(pending.acceptance, undefined, 'The stopped held observation has not accepted the original result');
  evidence.stoppedSourceMode = assertPhysicalCandidateMode(selected.checkpoint, candidateA.ref);
  evidence.pendingOriginal = pending; evidence.afterStop = { mirrors: await mirrors(), state: await state(), candidate: await readWorkingCandidateEvidence({ project, snapshot, ref: candidateA.ref, expectedBase: candidateA.record.base }) };
  await fs.writeFile(path.join(values.output, 'first-turn-stopped-session.json'), JSON.stringify(snapshot, null, 2));
  await page.screenshot({ path: path.join(values.output, 'first-turn-stopped-neutral.png'), fullPage: true });
  await app.evaluate(() => globalThis.__ailyR3CandidateFault.restore()); faultInstalled = false;
  await wait(250); await observe();
  assert.deepEqual(selectedWorkingCandidateRef(snapshot, project).checkpoint.candidatePublications?.[originalRequestId], pending, 'Late held body must not adopt/clear the stopped attempt');
  assert.deepEqual(await mirrors(), evidence.afterStop.mirrors);
  evidence.firstAudit = await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit.snapshot());
  await phase('whole-owned-Host-kill-product-auto-original-root-and-session'); await stopOwned('intentional-whole-host-crash');
  await launch(1); coldReopened = true; await observe();
  assert.deepEqual(await document(), expectedAC); assert.deepEqual(await mirrors(), evidence.afterStop.mirrors);
  evidence.coldBeforeUser = { state: await state(), retainedOldRef: await readWorkingCandidateEvidence({ project, ref: candidateA.ref, expectedBase: candidateA.record.base }) };
  await submit('Keep field A and my field C. Change only field B from 200 to 201 and apply the complete program.');
  await phase('cold-original-ID-readonly-before-next-provider-business');
  await until(async () => {
    const fault = await app.evaluate(() => globalThis.__ailyR3CandidateFault.snapshot()); assert.deepEqual(fault.failures, []);
    if (!fault.terminals.length) return false;
    assert.equal(fault.commands.filter(value => value.operation === 'abs_apply').length, 0); assert.equal(fault.drops, 0); assert.equal(fault.held, 0);
    assert.ok(fault.terminals.some(value => value.requestId === originalRequestId && value.observation?.current === true));
    if (!snapshot?.messages || snapshot.messages.filter(value => value.role === 'user').length !== 2 || model.snapshot().createCount !== 2) return false;
    const firstProvider = model.snapshot().requests.find(value => value.turn === 1 && value.path === '/api/v3/interactions');
    assert.ok(firstProvider && fault.terminals[0].at <= firstProvider.at, 'Original outcome is observed before a new provider begins');
    const checkpoint = latestCheckpoint(); assert.ok(checkpoint);
    // Accepted history may keep the old exact submission in its raw audit.
    // The next real Core read, not a guessed serialized field, must prove the
    // accepted transition by opening a new Candidate with actual Working AC.
    evidence.coldCheckpointAfterObservation = checkpoint;
    evidence.coldAcceptedFact = await readCandidateAcceptanceEvidence({ project, checkpoint, snapshot,
      requestId: originalRequestId, ref: candidateA.ref, expectedOutput: evidence.firstFault.terminals[0].evidence });
    evidence.coldOriginalObservation = fault; return true;
  }, 'The product did not independently observe the exact original committed attempt before next business');
  await app.evaluate(() => globalThis.__ailyR3CandidateFault.restore()); faultInstalled = false; gates.release('cold-original-observed');
  await until(() => snapshot?.isIdle && !snapshot.isStreaming && snapshot.messages.filter(value => value.role === 'user').length === 2, 'Fresh B apply did not settle');
  await clearUi(); assert.ok(evidence.finalApplication); assert.deepEqual(await document(), expectedABC);
  evidence.finalCandidate = await readWorkingCandidateEvidence({ project, ref: evidence.candidateAB.ref, expectedBase: evidence.workingAfterAcceptedA.record.base });
  evidence.finalOldAcceptedA = await readWorkingCandidateEvidence({ project, ref: candidateA.ref, candidateHash: candidateA.sourceHash, expectedBase: candidateA.record.base });
  evidence.coldAudit = await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit.snapshot());
  assertCandidateColdDispatches(evidence.firstAudit, evidence.coldAudit, originalRequestId, evidence.finalApplication.requestId);
  assert.deepEqual(model.snapshot().failures, []); assert.equal(model.snapshot().createCount, 2);
  assert.equal(callsOf(snapshot).filter(value => value.actualName === 'abs_apply').length, 2);
  assert.equal((snapshot.entries ?? []).some(value => value.type === 'custom' && value.customType === 'aily.abs-workflow' && value.data?.retainedCandidate), false);
  evidence.final = { originalRequestId, finalRequestId: evidence.finalApplication.requestId, fullDocument: expectedABC, mirrors: await mirrors(),
    state: await state(), originalAcceptedCandidateId: candidateA.ref.id, nextWorkingCandidateId: evidence.finalCandidate.ref.id,
    acceptedTransitionCreatedNewCandidate: candidateA.ref.id !== evidence.finalCandidate.ref.id, originalApplyDispatchCount: 1, laterApplyDispatchCount: 1,
    automaticOriginalProjectAndSession: true, oldAcceptedBaseUnchanged: true, nextWorkingBaseIsActualAC: true };
  await fs.writeFile(path.join(values.output, 'final-session.json'), JSON.stringify(snapshot, null, 2));
  await page.screenshot({ path: path.join(values.output, 'cold-original-candidate-complete-ABC.png'), fullPage: true });
  evidence.ok = true;
} catch (error) {
  evidence.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }; gates.cancel(error);
  if (app) { evidence.failureFault = await app.evaluate(() => globalThis.__ailyR3CandidateFault?.snapshot()).catch(() => undefined);
    evidence.failureAudit = await app.evaluate(() => globalThis.__ailyR3CandidateColdAudit?.snapshot()).catch(() => undefined); }
  if (page) { evidence.failureState = await state().catch(value => ({ observationError: value.message })); await page.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }).catch(() => {}); }
  if (loaded && startupReady && sessionId) { const raw = await loaded.e2e('session.read', { sessionId }).catch(() => undefined);
    if (raw) await fs.writeFile(path.join(values.output, 'failure-session.json'), JSON.stringify(raw.session, null, 2)); }
} finally {
  gates.cancel(Error('Owned fixture is finishing'));
  if (app) await app.evaluate(restoreFault => { if (restoreFault) globalThis.__ailyR3CandidateFault?.restore(); globalThis.__ailyR3CandidateColdAudit?.restore(); }, faultInstalled).catch(() => {});
  try { await stopOwned('forced-test-cleanup'); } catch (error) { evidence.ok = false; evidence.cleanupError = error.message; }
  evidence.transport = model?.snapshot(); evidence.api = router?.snapshot(); evidence.phaseGates = gates.snapshot();
  await router?.close(); await model?.close();
  try { assert.deepEqual(await verifyPortableBuild(values['installed-root']), artifact); assert.equal(artifact.inputHash, sha(JSON.stringify(await captureBuildInputs(values['lex-root']))));
    assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash']); evidence.artifactsUnchanged = true; }
  catch (error) { evidence.ok = false; evidence.artifactError = error.message; }
  const ownershipCompletelyObserved = evidence.launchAttempts.length === evidence.launches.length && evidence.launches.every(launch =>
    evidence.cleanup?.some(cleanup => cleanup.main.ProcessId === launch.main.ProcessId && cleanup.main.CreationDate === launch.main.CreationDate && cleanup.remaining.length === 0));
  evidence.finishedAt = new Date().toISOString(); evidence.finalOwnedProcesses = !evidence.cleanupError && ownershipCompletelyObserved ? 0 : null;
  if (evidence.finalOwnedProcesses !== 0) evidence.ok = false;
  await persist();
}
console.log(JSON.stringify({ ok: evidence.ok, output: values.output, originalRequestId, error: evidence.error }, null, 2));
process.exitCode = evidence.ok ? 0 : 1;
