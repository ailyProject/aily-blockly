import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { _electron } from '@playwright/test';
import { sha, documentHash, inventory, nativeDocument, editWorking, delay } from './fixtures/r1-customer-native.mjs';
import { assertCapturedEnvironmentProcess, selectEnvironmentProcessTree, remainingEnvironmentProcesses,
  environmentProcessStopScript } from './fixtures/r2-environment-cleanup.mjs';
import { loadCandidateSdk, fingerprintCandidateSdk, legacyCandidateArtifacts, appendCandidateUser, candidateSession,
  candidateFieldPlans, expectedCandidateDocument, candidateBase, exactCandidateFieldEdit,
  verifyCandidatePublication } from './fixtures/r3-customer-candidate.mjs';
import { readWorkingCandidateEvidence } from './fixtures/r3-candidate-evidence.mjs';

// Root executes only against its paired, sealed Host/SDK cohort. No provider is
// called, no source/proof/receipt is fabricated, and cold project open is never
// performed by the observer. Chat button Stop/ACK-loss belongs to another suite.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const required = ['project-input', 'test-root', 'output', 'executable-path', 'expected-host-hash', 'agent-root', 'expected-agent-hash', 'case'];
const { values } = parseArgs({ options: Object.fromEntries(required.map(name => [name, { type: 'string' }])) });
assert.equal(process.env.AILY_R3_CUSTOMER_HOST_WINDOW, '1', 'Root owns the unique actual Host window');
assert.ok(['787', 'chiyao'].includes(values.case));
for (const name of required.filter(name => !['case', 'expected-host-hash', 'expected-agent-hash'].includes(name))) assert.ok(path.isAbsolute(values[name] ?? ''), name);
assert.match(values['expected-host-hash'] ?? '', /^[a-f0-9]{64}$/);
assert.match(values['expected-agent-hash'] ?? '', /^[a-f0-9]{64}$/);
const inside = (root, target) => { const r = path.relative(root, target); return r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output));
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i);
const originalHash = values.case === '787' ? '1f162f73713562b4b82b81e916d1f61abda9c2eccd4d0dea82084cc50a50d24f'
  : '911cb578e55c445131c6cc57acbafbba92018fe8468b94eaa56d1f07d1580271';
const asar = path.join(path.dirname(values['executable-path']), 'resources/app.asar');
assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash']);
assert.equal(sha(await fs.readFile(path.join(values['project-input'], 'project.abi'))), originalHash);
await fs.mkdir(path.dirname(values.output), { recursive: true }); await fs.mkdir(values.output, { recursive: false });
await fs.mkdir(values['test-root'], { recursive: true });
const suite = await fs.mkdtemp(path.join(values['test-root'], `r3-customer-candidate-${values.case}-`));
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp');
for (const directory of [appData, home, temp]) await fs.mkdir(directory);
const originalFiles = await inventory(values['project-input']);
await fs.cp(values['project-input'], project, { recursive: true, dereference: false, errorOnExist: true, force: false });
assert.deepEqual(await inventory(project), originalFiles);
const original = JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'));
const evidence = { ok: false, case: values.case, suite, project, originalHash, hostHash: values['expected-host-hash'],
  actualOriginalProject: true, controlledDerivedNumericEdits: true, originalModelReplay: false,
  realPackagedHost: true, actualSdkSessionLifecycle: true, actualCoreCandidateFiles: true,
  paidModelRequests: 0, providerRequests: 0, chatStopTested: false, chatUiSessionRestoreTested: false,
  ackLossTested: false, manualColdProjectOpen: false, fabricatedCandidateAuthority: false,
  fabricatedHostReceipts: false, launches: [], phases: [], rpc: [], core: [] };
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2));
const phase = async name => { evidence.phases.push({ name, at: Date.now() }); console.log('R3_CANDIDATE_PHASE=' + name); await persist(); };
const exec = promisify(execFile);
const processes = async () => { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
{ windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }); const all = JSON.parse(stdout); return Array.isArray(all) ? all : [all]; };
const mirrors = async () => Promise.all(['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json'].map(async name => ({ name,
  sha256: sha(await fs.readFile(path.join(project, name))) })));
const configuration = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'));
Object.assign(configuration, { metricsEnabled: false, project_path: suite, recentlyProjects: [], onboardingCompleted: true,
  blocklyOnboardingCompleted: true, region: 'r3-offline' });
configuration.appdata_path[process.platform] = appData;
configuration.regions = { 'r3-offline': { official: false, enabled: true, name: 'R3 original candidate', ...Object.fromEntries(
  ['api_server', 'resource', 'web', 'tool_web', 'ucenter_web', 'npm_registry', 'npm_registry_linux'].map(key => [key, 'http://127.0.0.1:9'])) } };
await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(configuration), { flag: 'wx' });
await fs.mkdir(path.join(appData, 'npm-global/app'), { recursive: true });
await fs.writeFile(path.join(appData, 'npm-global/app/subapp-index.json'), '{"dev":true}', { flag: 'wx' });
let app, page, identity, sdk, session, sessionFile, manager;

async function launch(attempt) {
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_AUTH_FILE, AILY_LIBRARY_HOST_PID, PI_CODING_AGENT_DIR, AILY_PORTABLE_ROOT, ...env } = process.env;
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo,
    args: [`--user-data-dir=${path.join(suite, 'chromium-profile')}`], timeout: 60000, env: { ...env,
      AILY_E2E: '1', AILY_APPDATA_PATH: appData, AILY_NPM_PREFIX: path.join(appData, 'npm-global'),
      HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false', npm_config_registry: 'http://127.0.0.1:9', npm_config_cache: path.join(suite, 'npm-cache') } });
  const pid = await app.evaluate(() => process.pid);
  identity = (await processes()).find(entry => entry.ProcessId === pid); assert.ok(identity);
  assert.equal(path.resolve(identity.ExecutablePath).toLowerCase(), path.resolve(values['executable-path']).toLowerCase());
  assert.ok(identity.CommandLine.includes(path.join(suite, 'chromium-profile')));
  const record = { attempt, main: identity, initialSetupOpenIssued: false, coldObserverOpenIssued: false, at: Date.now() };
  evidence.launches.push(record);
  for (const stream of ['stdout', 'stderr']) app.process()[stream]?.pipe(nativeFs.createWriteStream(path.join(values.output, `main-${attempt}-${stream}.log`)));
  await app.context().route('**/*', route => { const u = new URL(route.request().url()); return !['http:', 'https:'].includes(u.protocol)
    || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? route.continue() : route.abort('blockedbyclient'); });
  page = undefined; const until = Date.now() + 60000;
  while (!page && Date.now() < until) { for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break; } if (!page) await delay(100); }
  assert.ok(page);
  page.on('pageerror', error => { (evidence.pageErrors ??= []).push({ phase: evidence.phases.at(-1)?.name, message: error.message }); });
  await page.evaluate(() => { const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click(); };
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss(); });
  await page.waitForFunction(() => { const element = document.querySelector('app-header'); return element && window.ng?.getComponent(element)?.projectService; });
  if (!attempt) {
    record.initialSetupOpenIssued = true;
    assert.equal(await page.evaluate(async target => { const domain = window.ng.getComponent(document.querySelector('app-header')).projectService;
      await domain.initializeProjectDataSchema(target); return domain.projectOpen(target); }, project), true);
  }
  await page.waitForFunction(target => { const element = document.querySelector('app-header'), domain = element && window.ng?.getComponent(element)?.projectService;
    return domain?.currentProjectPath === target && domain.getBlocklyProjectLoadStatus(target)?.ready === true; }, project, { timeout: 120000 });
  record.productAutomaticOriginalProject = attempt > 0;
  record.host = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath() }));
  assert.equal(record.host.packaged, true); assert.match(record.host.appPath, /app\.asar$/i);
  assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash']);
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(pid), AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home,
    PI_CODING_AGENT_DIR: path.join(home, '.aily-chat'), PI_OFFLINE: '1' });
  delete process.env.AILY_CHILD_PATH; delete process.env.AILY_PORTABLE_ROOT;
  await persist();
}

async function stopOwned(kind) {
  if (!identity) return;
  const all = await processes(), current = all.find(value => value.ProcessId === identity.ProcessId);
  assert.ok(current, 'Missing Main before owned-tree capture cannot qualify complete process cleanup');
  assertCapturedEnvironmentProcess(current, identity);
  assert.ok(current.CommandLine.includes(path.join(suite, 'chromium-profile')));
  const captured = selectEnvironmentProcessTree(all, identity);
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(identity)], { windowsHide: true, timeout: 20000 });
  for (const child of captured.slice(1).reverse())
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', environmentProcessStopScript(child)], { windowsHide: true, timeout: 20000 });
  const deadline = Date.now() + 30000; let remaining;
  do { remaining = remainingEnvironmentProcesses(captured, await processes()); if (!remaining.length) break; await delay(250); } while (Date.now() < deadline);
  (evidence.ownedCleanup ??= []).push({ kind, main: identity, captured, remaining, normalCloseCovered: false });
  assert.equal(remaining.length, 0, 'Only exact owned processes may be terminated; all must exit');
  app = undefined; identity = undefined;
}

async function saveWorking() {
  const saved = await page.evaluate(async target => { const value = await window.ng.getComponent(document.querySelector('app-header')).projectService.save(target);
    return { success: value.success, projectSaved: value.projectSaved, partial: value.partial, saveReceipt: value.saveReceipt, publication: value.publication, code: value.code }; }, project);
  assert.equal(saved.success, true, JSON.stringify(saved)); assert.equal(saved.publication.status, 'COMMITTED'); return saved;
}

async function assertLive(expected) {
  assert.equal(documentHash(await nativeDocument(page, project)), documentHash(expected), 'Every page, model, hidden attribute and field must match the independent full-document oracle');
}

async function exactCheckpoint(ref, expectedBase) {
  const verified = await readWorkingCandidateEvidence({ project,
    snapshot: { sessionId: manager.getSessionId(), entries: manager.getBranch() }, ref, expectedBase });
  return { ref: verified.ref, checkpointEntryId: verified.checkpointEntryId,
    sourceHash: verified.sourceHash, manifestPath: verified.manifestPath };
}

try {
  evidence.sdkBefore = await fingerprintCandidateSdk(values['agent-root']);
  evidence.sdkHash = sha(JSON.stringify(evidence.sdkBefore));
  assert.equal(evidence.sdkHash, values['expected-agent-hash'], 'Only the exact sealed compiled SDK module set may run');
  await phase('original-project-in-real-asar'); await launch(0);
  await assertLive(original); evidence.initialSave = await saveWorking();
  const savedS0 = await mirrors();
  sdk = await loadCandidateSdk(values['agent-root'], evidence.rpc);
  if (values.case === '787') {
    await phase('R4-original-native-save-without-placeholder-candidate');
    const nativeManager = sdk.SessionManager.create(project, path.join(suite, 'native-no-candidate-session'));
    appendCandidateUser(nativeManager, 'Save the current complete original project');
    const nativeSession = candidateSession(sdk, project, nativeManager, new AbortController().signal);
    try {
      await nativeSession.begin();
      assert.deepEqual(nativeSession.history.currentCheckpoint?.candidateRefs ?? {}, {});
      const saved = await nativeSession.save();
      assert.equal(saved.ok, true); assert.equal(saved.candidateApplied, false);
      assert.equal(saved.saveReceipt?.version, 2); assert.equal(saved.saveReceipt?.state, 'completed');
      assert.equal(saved.workingCandidate, undefined);
      assert.deepEqual(nativeSession.history.currentCheckpoint?.candidateRefs ?? {}, {}, 'A native save cannot manufacture a placeholder candidate');
      const dispatches = evidence.rpc.filter(value => value.channel === 'actual-app-command' && value.operation === 'project_save');
      assert.equal(dispatches.length, 1); assert.equal(dispatches[0].requestId, saved.saveReceipt.requestId);
      await assertLive(original); assert.deepEqual(await mirrors(), savedS0);
      evidence.nativeWithoutCandidate = { requestId: saved.saveReceipt.requestId, originalNativeReply: saved,
        sdkDispatchCount: dispatches.length, candidateRefsBeforeAndAfter: 0, completeOriginalUnchanged: true };
      await nativeSession.settle();
    } finally { await nativeSession.history.dispose(); }
  }
  const visible = await page.evaluate(() => window.Blockly.getMainWorkspace().getAllBlocks(false).map(block => block.id));
  const plans = candidateFieldPlans(original, visible); evidence.plans = plans;
  const expectedC = expectedCandidateDocument(original, plans.C), expectedABC = expectedCandidateDocument(original, plans.A, plans.B, plans.C);
  await editWorking(page, project, plans.C, plans.C.value); await assertLive(expectedC);
  assert.deepEqual(await mirrors(), savedS0, 'Dirty GUI C is not an implicit save');
  evidence.legacyCandidateBefore = await legacyCandidateArtifacts(project, home);
  manager = sdk.SessionManager.create(project, path.join(suite, 'sdk-sessions'));
  appendCandidateUser(manager, 'Continue the complete original program with two ordinary independent numeric edits');
  const owner = new AbortController();
  session = candidateSession(sdk, project, manager, owner.signal, (message, level) => { (evidence.notices ??= []).push({ message, level }); });
  await session.begin();
  await phase('actual-Core-read-freezes-dirty-Working-C');
  const first = (await session.read()).candidate, base = await candidateBase(session.history, first, owner.signal);
  assert.equal(documentHash(base.document), documentHash(expectedC));
  evidence.capture = { ref: first.ref, record: first.record, documentHash: documentHash(base.document), dirtyC: true };
  assert.equal(evidence.rpc.filter(value => value.action === 'candidate_capture').length, 1);
  assert.deepEqual(await mirrors(), savedS0);
  const editA = await exactCandidateFieldEdit(session.history, first, plans.A, owner.signal);
  const selectedA = (await session.edit(editA.oldText, editA.newText)).candidate;
  assert.equal(selectedA.ref.id, first.ref.id); assert.deepEqual(selectedA.record.base, first.record.base);
  evidence.core.push({ edit: 'A', ref: selectedA.ref, derivation: selectedA.record.derivation });
  evidence.checkpointA = await exactCheckpoint(selectedA.ref, first.record.base);
  assert.deepEqual(await mirrors(), savedS0, 'Core A remains private and cannot alter any canonical mirror');
  await phase('real-native-save-advances-Published-but-retains-candidate-base');
  evidence.intermediateSave = await session.save(); await assertLive(expectedC);
  assert.equal(evidence.intermediateSave.ok, true);
  assert.equal(evidence.intermediateSave.saveReceipt.version, 2);
  assert.match(evidence.intermediateSave.saveReceipt.requestId, /^pub2-[a-f0-9-]{36}$/);
  assert.equal(evidence.intermediateSave.saveReceipt.operation, 'project_save');
  assert.equal(evidence.intermediateSave.saveReceipt.state, 'completed');
  assert.equal(evidence.intermediateSave.publication.status, 'COMMITTED');
  assert.equal(evidence.intermediateSave.workspaceSaveVerification?.ok, true);
  assert.equal(evidence.intermediateSave.candidateApplied, false);
  assert.deepEqual(evidence.intermediateSave.workingCandidate, selectedA.ref);
  const saves = evidence.rpc.filter(value => value.channel === 'actual-app-command' && value.operation === 'project_save'
    && value.requestId === evidence.intermediateSave.saveReceipt.requestId);
  assert.equal(saves.length, 1, 'The real SDK save adapter may submit exactly one native mutation');
  assert.equal(saves[0].requestId, evidence.intermediateSave.saveReceipt.requestId);
  assert.equal(saves[0].requestVersion, 2); assert.equal(saves[0].targetPid, identity.ProcessId);
  assert.equal(saves[0].nativeSaveReceiptVersion, 2);
  evidence.intermediateSaveScope = { actualSdkProjectSaveRegistrar: true, nativeMutationCalls: 1,
    originalRequestId: saves[0].requestId, executorPid: saves[0].targetPid, candidateApplied: false };
  assert.notEqual(evidence.intermediateSave.publication.generation, evidence.initialSave.publication.generation,
    'The genuine native save must advance Published after GUI C');
  const beforeCold = await mirrors();
  assert.equal(documentHash(JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))), documentHash(expectedC));
  const stillA = await session.history.readCandidate(selectedA.ref, { signal: owner.signal });
  assert.equal(stillA.source, selectedA.source); assert.deepEqual(stillA.record.base, first.record.base);
  assert.deepEqual(session.history.candidateRef('project.abs'), selectedA.ref);
  evidence.legacyCandidateAfterNativeSave = await legacyCandidateArtifacts(project, home);
  assert.deepEqual(evidence.legacyCandidateAfterNativeSave, evidence.legacyCandidateBefore,
    'Core A and the new native save branch must not create or refresh a separate legacy proof/handoff/archive');
  assert.equal(manager.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'aily.abs-workflow'
    && entry.data?.retainedCandidate), false, 'The new candidate/native save path must not create a second legacy candidate writer');
  await session.settle(); sessionFile = manager.getSessionFile(); assert.ok(sessionFile);
  evidence.preCold = { sessionFile, sessionId: manager.getSessionId(), ref: selectedA.ref, base: selectedA.record.base, mirrors: beforeCold };
  await session.history.dispose(); session = undefined;
  await phase('whole-Host-kill-and-product-auto-original-project'); await stopOwned('intentional-whole-host-crash'); await launch(1);
  await assertLive(expectedC); assert.deepEqual(await mirrors(), beforeCold);
  manager = sdk.SessionManager.open(sessionFile);
  assert.equal(manager.getSessionId(), evidence.preCold.sessionId);
  appendCandidateUser(manager, 'Continue the original exact candidate after restart');
  session = candidateSession(sdk, project, manager, owner.signal);
  await phase('real-session-start-before-agent-start-auto-exactref-materialization'); await session.begin();
  assert.deepEqual(session.history.candidateRef('project.abs'), selectedA.ref, 'The production lifecycle, not this test, restores the original exact revision');
  const cold = (await session.read()).candidate;
  assert.deepEqual(cold.ref, selectedA.ref); assert.equal(cold.source, selectedA.source); assert.deepEqual(cold.record.base, first.record.base);
  evidence.coldCheckpoint = await exactCheckpoint(cold.ref, first.record.base);
  assert.equal(evidence.rpc.filter(value => value.action === 'candidate_capture').length, 1, 'Cold restoration must not recapture or substitute current Published');
  const editB = await exactCandidateFieldEdit(session.history, cold, plans.B, owner.signal);
  const selectedAB = (await session.edit(editB.oldText, editB.newText)).candidate;
  assert.equal(selectedAB.ref.id, first.ref.id); assert.deepEqual(selectedAB.record.base, first.record.base);
  evidence.core.push({ edit: 'B', ref: selectedAB.ref, derivation: selectedAB.record.derivation });
  evidence.checkpointAB = await exactCheckpoint(selectedAB.ref, first.record.base);
  assert.deepEqual(await mirrors(), beforeCold, 'Core B must retain the captured base and keep canonical C unchanged until native apply');
  await phase('actual-fixedref-native-prepare-apply-and-complete-ABC-oracle');
  const applied = await session.apply();
  evidence.application = applied; await persist();
  const terminal = evidence.rpc.filter(value => value.operation === 'abs_apply').at(-1);
  assert.ok(terminal?.result?.receipt, 'Qualification requires the real original Host application receipt');
  assert.deepEqual(terminal.result.receipt.workingCandidate, selectedAB.ref);
  assert.equal(evidence.rpc.filter(value => value.operation === 'abs_apply').length, 1, 'One genuine native application, never replay');
  assert.equal(terminal.requestId, terminal.result.receipt.requestId);
  evidence.fullPublication = await verifyCandidatePublication(project, expectedABC, applied, terminal.result.receipt);
  await assertLive(expectedABC); await session.settle();
  await assertLive(expectedABC);
  evidence.finalHost = await page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return { blocked: editor.blocklyService.isWorkspaceEditBlocked(), running: editor.blocklyService.isWorkspaceEditInProgress(),
      recoveryRequired: editor.blocklyService.isWorkspaceRecoveryRequired(), noticeDoing: editor.noticeService.data?.state === 'doing',
      ownedDoing: [...editor.noticeService.ownedNotices.values()].filter(notice => notice.state === 'doing').length };
  });
  assert.deepEqual(evidence.finalHost, { blocked: false, running: false, recoveryRequired: false, noticeDoing: false, ownedDoing: 0 });
  await page.screenshot({ path: path.join(values.output, 'original-cold-candidate-complete-ABC.png'), fullPage: true });
  evidence.final = { fullDocumentHash: documentHash(expectedABC), originalCandidateId: first.ref.id,
    finalCandidateRef: selectedAB.ref, automaticSameProject: true, automaticSdkExactRef: true };
  evidence.sdkAfter = await fingerprintCandidateSdk(values['agent-root']); assert.deepEqual(evidence.sdkAfter, evidence.sdkBefore);
  assert.deepEqual(await inventory(values['project-input']), originalFiles); evidence.originalInputUnchanged = true;
  evidence.ok = true;
} catch (error) {
  evidence.error = { name: error.name, code: error.code, message: error.message, stack: error.stack };
  try { await page?.screenshot({ path: path.join(values.output, 'failure.png'), fullPage: true }); } catch {}
} finally {
  try { await session?.history.dispose(); } catch (error) { evidence.ok = false; evidence.sdkCleanupError = error.message; }
  try { await stopOwned('forced-test-cleanup'); } catch (error) { evidence.ok = false; evidence.cleanupError = error.message; }
  evidence.finishedAt = new Date().toISOString();
  evidence.originalInputUnchanged = JSON.stringify(await inventory(values['project-input'])) === JSON.stringify(originalFiles);
  if (!evidence.originalInputUnchanged) evidence.ok = false;
  assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash']); await persist();
}
console.log(JSON.stringify({ ok: evidence.ok, case: evidence.case, output: values.output, error: evidence.error }, null, 2));
process.exitCode = evidence.ok ? 0 : 1;
