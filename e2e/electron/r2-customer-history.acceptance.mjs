import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import nativeFs from 'node:fs'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { _electron } from '@playwright/test'
import { loadHistorySdk, wireHistoryLifecycle, appendHistoryUserAnchor } from './fixtures/r2-history-sdk.mjs'
import { installHistoryPublicationFault } from './fixtures/r2-history-publication-fault.mjs'
import { loadHistoryResume } from './fixtures/r2-history-resume.mjs'
import { historyFieldPlans, historyExpectedDocument, pendingHistoryStep } from './fixtures/r2-history-document.mjs'
import { sha, documentHash, inventory, nativeDocument, editWorking, delay } from './fixtures/r1-customer-native.mjs'

// R2 actual packaged program publisher and real SDK History/SessionManager/Worker.
// Frozen-base undo/redo must preserve unrelated GUI C; a second undo loses its
// genuine terminal HTTP response and is observed by the automatic SDK lifecycle.
// No paid model or Chat UI navigation is claimed here.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const names = ['project-input', 'test-root', 'output', 'executable-path', 'expected-host-hash', 'agent-root', 'case']
const { values } = parseArgs({ options: Object.fromEntries([...names, 'resume-result'].map(name => [name, { type: 'string' }])) })
assert.equal(process.env.AILY_R2_CUSTOMER_HOST_WINDOW, '1', 'Use the root-coordinated R2 host window')
for (const name of names.filter(name => !['case', 'expected-host-hash'].includes(name))) assert.ok(path.isAbsolute(values[name] ?? ''), name)
assert.ok(['787', 'chiyao'].includes(values.case)); assert.match(values['expected-host-hash'] ?? '', /^[a-f0-9]{64}$/)
const inside = (parent, child) => { const r = path.relative(parent, child); return r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }
assert.ok(inside(path.join(repo, 'e2e/test-results'), values.output))
assert.match(values['test-root'].replaceAll('\\', '/'), /\/aily-project\/dev-tests\//i)
const originalHash = values.case === '787' ? '1f162f73713562b4b82b81e916d1f61abda9c2eccd4d0dea82084cc50a50d24f'
  : '911cb578e55c445131c6cc57acbafbba92018fe8468b94eaa56d1f07d1580271'
assert.equal(sha(await fs.readFile(path.join(values['project-input'], 'project.abi'))), originalHash)
const asar = path.join(path.dirname(values['executable-path']), 'resources/app.asar')
assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash'])
await fs.mkdir(path.dirname(values.output), { recursive: true }); await fs.mkdir(values.output, { recursive: false })
await fs.mkdir(values['test-root'], { recursive: true })
const resume = values['resume-result'] ? await loadHistoryResume({resultFile:values['resume-result'],testRoot:values['test-root'],
  projectInput:values['project-input'],agentRoot:values['agent-root'],hostHash:values['expected-host-hash'],caseName:values.case}) : undefined
const suite = resume?.suite ?? await fs.mkdtemp(path.join(values['test-root'], `r2-customer-history-${values.case}-`))
const project = path.join(suite, 'project'), appData = path.join(suite, 'appdata'), home = path.join(suite, 'home'), temp = path.join(suite, 'temp')
if(!resume)for (const directory of [appData, home, temp]) await fs.mkdir(directory)
const originalFiles = await inventory(values['project-input'])
if(!resume){await fs.cp(values['project-input'], project, { recursive: true, dereference: false, errorOnExist: true, force: false })
assert.deepEqual(await inventory(project), originalFiles)}
const original = resume?.original ?? JSON.parse(await fs.readFile(path.join(project, 'project.abi'), 'utf8'))
const evidence = { ok: false, case: values.case, suite, project, hostHash: values['expected-host-hash'], originalHash,
  realOriginalProject: true, derivedFieldEdit: true, exactLateCandidateReplayed: false,
  realPackagedHost: true, realSdkServices: true, actualSdkSessionLifecycle: true, installedChatUiHistoryNavigation: false, paidModelRequests: 0, explicitCompileRequested: false, compilerCoverage: 'not-tested',
  chatStopTested: false, observationAbortRequested: false, observationCancellationConfirmed: false,
  manualColdOpen: false, clickedRecent: false,
  fabricatedHostReceipts: false, launches: [], phases: [], cleanupFailures: [] }
if(resume)evidence.resumedProvenance=resume.provenance
const persist = () => fs.writeFile(path.join(values.output, 'result.json'), JSON.stringify(evidence, null, 2))
const phase = async name => { evidence.phases.push({ name, at: Date.now() }); console.log('R2_HISTORY_PHASE=' + name); await persist() }
const exec = promisify(execFile)
const processes = async () => { const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
{ windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }); const list = JSON.parse(stdout); return Array.isArray(list) ? list : [list] }
const tree = async pid => { const all = await processes(), ids = new Set([pid]); let changed
  do { changed = false; for (const item of all) if (ids.has(item.ParentProcessId) && !ids.has(item.ProcessId)) { ids.add(item.ProcessId); changed = true } } while (changed)
  return all.filter(item => ids.has(item.ProcessId)) }
const waitExited = async owned => { const until = Date.now() + 30000
  do { const active = await processes(), remaining = owned.filter(old => active.some(now => now.ProcessId === old.ProcessId && now.CreationDate === old.CreationDate))
    if (!remaining.length) return { ownedRemaining: 0 }; await delay(300) } while (Date.now() < until)
  throw Error('Owned host descendants remain after termination') }
const configuration = JSON.parse(await fs.readFile(path.join(repo, 'electron/config/config.json'), 'utf8'))
Object.assign(configuration, { metricsEnabled: false, project_path: suite, recentlyProjects: [], onboardingCompleted: true,
  blocklyOnboardingCompleted: true, region: 'r1-offline' })
configuration.appdata_path[process.platform] = appData
configuration.regions = { 'r1-offline': { official: false, enabled: true, name: 'R1 customer native', ...Object.fromEntries(
  ['api_server', 'resource', 'web', 'tool_web', 'ucenter_web', 'npm_registry', 'npm_registry_linux'].map(name => [name, 'http://127.0.0.1:9'])) } }
if(!resume){await fs.writeFile(path.join(appData, 'config.json'), JSON.stringify(configuration), { flag: 'wx' })
await fs.mkdir(path.join(appData, 'npm-global/app'), { recursive: true })
await fs.writeFile(path.join(appData, 'npm-global/app/subapp-index.json'), '{"dev":true}', { flag: 'wx' })}
let app, page, hostPid, descriptor, sdk, history, manager, store, handlers, context, plans, checkpointA, sessionFile, expectedAC, expectedC
const mirrors = () => Promise.all(['project.abi', 'project.abs', 'project.abs.map.json'].map(name => fs.readFile(path.join(project, name), 'utf8')))
async function launch(attempt) {
  const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, AILY_AUTH_FILE, AILY_LIBRARY_HOST_PID, PI_CODING_AGENT_DIR, AILY_PORTABLE_ROOT, ...env } = process.env
  app = await _electron.launch({ executablePath: values['executable-path'], cwd: repo,
    args: [`--user-data-dir=${path.join(suite, 'chromium-profile')}`], timeout: 60000,
    env: { ...env, AILY_E2E: '1', AILY_APPDATA_PATH: appData, AILY_NPM_PREFIX: path.join(appData, 'npm-global'),
      HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, npm_config_offline: 'true', npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false', npm_config_registry: 'http://127.0.0.1:9', npm_config_cache: path.join(suite, 'npm-cache') } })
  hostPid = await app.evaluate(() => process.pid)
  const launch = { attempt, hostPid, explicitProjectArg: false, observerOpenIssued: false, at: Date.now() }; evidence.launches.push(launch)
  const created = (await processes()).find(entry => entry.ProcessId === hostPid)
  assert.ok(created); launch.creationDate = created.CreationDate
  for (const stream of ['stdout', 'stderr']) app.process()[stream]?.pipe(nativeFs.createWriteStream(path.join(values.output, `main-${attempt}-${stream}.log`)))
  app.process().on('exit', (code, signal) => { (evidence.processExits ??= []).push({ attempt, hostPid: launch.hostPid, code, signal, at: Date.now() }) })
  await app.context().route('**/*', route => { const u = new URL(route.request().url()); return !['http:', 'https:'].includes(u.protocol)
    || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? route.continue() : route.abort('blockedbyclient') })
  page = undefined; const until = Date.now() + 60000
  while (!page && Date.now() < until) { for (const candidate of app.windows()) if (await candidate.locator('app-main-window').count()) { page = candidate; break }; if (!page) await delay(100) }
  assert.ok(page); page.on('dialog', dialog => dialog.dismiss())
  page.on('pageerror', error => { (evidence.pageErrors ??= []).push({ phase: evidence.phases.at(-1)?.name, message: String(error.message).slice(0, 600) }) })
  await page.evaluate(() => { const dismiss = () => { document.querySelector('app-onboarding .btn-skip')?.click(); document.querySelector('app-login .login-close')?.click() }
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true }); dismiss() })
  await page.waitForFunction(() => window.ng?.getComponent(document.querySelector('app-header'))?.projectService)
  if (attempt === 0) {
    launch.initialSetupOpenIssued = true
    assert.equal(await page.evaluate(async target => { const domain = window.ng.getComponent(document.querySelector('app-header')).projectService
      await domain.initializeProjectDataSchema(target); return await domain.projectOpen(target) }, project), true)
  }
  // No click, open RPC, schema initialization or projectOpen on cold startup.
  await page.waitForFunction(target => { const domain = window.ng?.getComponent(document.querySelector('app-header'))?.projectService
    return domain?.currentProjectPath === target && domain.getBlocklyProjectLoadStatus(target)?.ready === true }, project, { timeout: 120000 })
  launch.projectRestoredByProduct = attempt > 0
  const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    node: process.version, electron: process.versions.electron }))
  assert.equal(info.packaged, true); assert.match(info.appPath, /app\.asar$/i); launch.host = info
  assert.equal(sha(await fs.readFile(asar)), values['expected-host-hash'])
  const discoveryFile = path.join(home, '.aily-blockly/cli-bridge', hostPid + '.json')
  for (let i = 0; i < 50; i++) { try { descriptor = JSON.parse(await fs.readFile(discoveryFile, 'utf8')); break } catch { await delay(100) } }
  assert.equal(descriptor?.pid, hostPid); assert.equal(descriptor.nativeSaveReceiptVersion, 2)
  const capabilities = await page.evaluate(async () => ({ program: window.fs.projectProgramPublicationVersion, environment: await window.libraryDependencies.capabilities() }))
  assert.equal(capabilities.program, 1); assert.equal(capabilities.environment.dependencyEnvironmentVersion, 2)
  launch.actualCapabilities = capabilities
  launch.dependencyEnvironmentContract = { version: 2, terminalHashKeys: ['package', 'lock', 'npmrc', 'shrinkwrap', 'yarn'],
    capabilitySource: 'actual Main library-dependencies:capabilities IPC', terminalHashesReadAtLaunch: false }
  Object.assign(process.env, { AILY_LIBRARY_HOST_PID: String(hostPid), AILY_APPDATA_PATH: appData, HOME: home, USERPROFILE: home, PI_OFFLINE: '1' })
  await persist()
}
async function killOwned() {
  const actual = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter 'ProcessId = ${hostPid}' | Select-Object ProcessId,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath,CommandLine | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 15000 })
  const identity = JSON.parse(actual.stdout)
  assert.equal(identity.ProcessId, hostPid)
  assert.equal(identity.CreationDate, evidence.launches.at(-1).creationDate, 'Never kill a reused PID')
  assert.equal(path.resolve(identity.ExecutablePath).toLowerCase(), path.resolve(values['executable-path']).toLowerCase())
  assert.ok(identity.CommandLine.includes(path.join(suite, 'chromium-profile')), 'Refuse an unrelated profile')
  const owned = await tree(hostPid), main = owned.find(entry => entry.ProcessId === hostPid)
  assert.equal(main.CreationDate, identity.CreationDate)
  const closed = app.waitForEvent('close', { timeout: 15000 })
  const literal=value=>"'"+String(value).replaceAll("'","''")+"'"
  const script=`$r2Owned = Get-CimInstance Win32_Process -Filter 'ProcessId = ${hostPid}' -ErrorAction Stop
if (-not $r2Owned -or $r2Owned.CreationDate.ToUniversalTime().ToString('o') -cne ${literal(identity.CreationDate)} -or
  [IO.Path]::GetFullPath([string]$r2Owned.ExecutablePath) -ine [IO.Path]::GetFullPath(${literal(values['executable-path'])}) -or
  -not ([string]$r2Owned.CommandLine).Contains(${literal(path.join(suite,'chromium-profile'))})) { throw 'Owned Main identity changed before forced test cleanup' }
Stop-Process -Id ${hostPid} -Force -ErrorAction Stop`
  await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:20000})
  await closed; app = undefined; evidence.lastKill = { executorPid: hostPid, ...await waitExited(owned) }; await persist()
}
const load = relative => import(pathToFileURL(path.join(values['agent-root'], 'dist', relative + '.js')).href)
// Always use this explicitly fingerprinted SDK's worker, rather than an
// unrelated portable runtime inherited by the runner shell.
delete process.env.AILY_PORTABLE_ROOT
delete process.env.AILY_CHILD_PATH
const modules = ['extensions/pi-workspace-history/runtime','extensions/pi-workspace-history/worker','extensions/pi-workspace-history/store',
  'extensions/pi-workspace-history/extension','extensions/pi-workspace-history/native-history-navigation','extensions/pi-workspace-history/runtime-pending-navigation',
  'blockly/services/abs/history-publication','blockly/services/project/publication-observation']
const sdkHashes = () => Promise.all(modules.map(async name => ({name,sha256:sha(await fs.readFile(path.join(values['agent-root'],'dist',name+'.js')))})))
async function saveWorking() {
  const saved=await page.evaluate(async project=>{
    const value=await window.ng.getComponent(document.querySelector('app-header')).projectService.save(project)
    return {success:value.success,projectSaved:value.projectSaved,partial:value.partial,code:value.code,saveReceipt:value.saveReceipt,publication:value.publication}
  },project)
  assert.equal(saved.success,true,JSON.stringify(saved));assert.equal(saved.saveReceipt.version,2)
  return saved
}
async function assertDocument(expected) {
  assert.equal(documentHash(await nativeDocument(page,project)),documentHash(expected),'Complete live document including every page/model/opaque field')
  assert.equal(documentHash(JSON.parse(await fs.readFile(path.join(project,'project.abi'),'utf8'))),documentHash(expected),'Complete saved document')
  const inspected=await sdk.inspectHistoryProgram(project)
  assert.equal(inspected.ok,true,JSON.stringify({code:inspected.code,error:inspected.error}));assert.equal(inspected.historyVerification.current,true)
  return inspected
}
function wireLifecycle() {
  const wired=wireHistoryLifecycle(sdk,project,manager,(message,level)=>{(evidence.lifecycleNotices??=[]).push({message,level})})
  history=wired.history;handlers=wired.handlers;context=wired.context
}
try {
  evidence.agentBefore=await sdkHashes()
  if(resume){
    const old=resume.previous.launches[0]
    assert.equal((await processes()).some(item=>item.ProcessId===old.hostPid&&item.CreationDate===old.creationDate),false,'The original owned Main must already have exited')
    evidence.resumedProvenance.originalExecutorExited=true
    assert.deepEqual(evidence.agentBefore,resume.previous.agentBefore)
    sdk=resume.sdk;manager=resume.manager;store=resume.store;checkpointA=resume.checkpoint;sessionFile=resume.sessionFile
    plans=resume.previous.plans;expectedAC=resume.expectedAC;expectedC=resume.expectedC
    evidence.plans=plans;evidence.historyCommit=resume.previous.historyCommit;evidence.undoRedo=resume.previous.undoRedo
    await phase('resume-product-auto-cold-start-exact-original-suite-and-checkpoint');await launch(1)
    await assertDocument(expectedAC)
    assert.deepEqual(await Promise.all(resume.mirrors.map(async({name})=>({name,sha256:sha(await fs.readFile(path.join(project,name)))}))),resume.mirrors,'Cold launch cannot publish a different head before the remaining fault stage')
    wireLifecycle();await handlers.get('session_start')({},context)
    assert.deepEqual(store.readSession(checkpointA.historySessionId),resume.session)
    assert.equal(store.listTransactions().length,0)
    evidence.resumedProvenance.productAutoColdLaunchVerified=true
    evidence.resumedProvenance.completeACVerified=true
    evidence.resumedProvenance.originalActiveCursorVerified=true
  }else{
  await phase('actual-packaged-host-capabilities-and-original-project');await launch(0)
  assert.equal(documentHash(await nativeDocument(page,project)),documentHash(original))
  sdk=await loadHistorySdk(values['agent-root'])
  const {WorkspaceHistoryStore,latestCheckpoint,SessionManager}=sdk
  evidence.actualPiDependency=sdk.dependency
  // Legacy input initialization belongs to the real host save; History never creates its program mirrors.
  evidence.initializationSave=await saveWorking()
  const publishedS0=await assertDocument(original),s0=await mirrors()
  const visible=await page.evaluate(()=>window.Blockly.getMainWorkspace().getAllBlocks(false).map(block=>block.id))
  plans=historyFieldPlans(original,visible)
  evidence.plans=plans
  manager=SessionManager.create(project,path.join(suite,'sdk-sessions'))
  appendHistoryUserAnchor(manager)
  wireLifecycle();store=new WorkspaceHistoryStore(project,path.join(project,'.workspace-history'))
  await handlers.get('session_start')({},context);await handlers.get('before_agent_start')({},context)
  const privateBefore=await fs.readFile(path.join(history.executionRoot,'project.abs'))
  assert.equal(sha(privateBefore),sha(publishedS0.abs))
  await phase('real-gui-A-save-and-metadata-only-history-record')
  await editWorking(page,project,plans.A,plans.A.valueA)
  const expectedA=historyExpectedDocument(original,plans.A,plans.A.valueA)
  evidence.saveA=await saveWorking();const publishedA=await assertDocument(expectedA)
  const adopted=await history.adoptAbsRepair({candidateHash:'sha256:'+sha(privateBefore),hashes:{abi:publishedA.evidence.binding.abiHash,abs:publishedA.evidence.binding.absHash,map:publishedA.evidence.binding.mapHash}})
  assert.equal(adopted.ok,true);assert.equal(adopted.canonicalWritten,false)
  await handlers.get('agent_settled')({},context)
  checkpointA=latestCheckpoint(manager,undefined,project)
  assert.ok(checkpointA?.checkpointId&&!checkpointA.checkpointId.startsWith('noop:'))
  sessionFile=manager.getSessionFile()
  assert.ok((await fs.readFile(sessionFile,'utf8')).includes(checkpointA.checkpointId),'Actual session JSONL must contain native history checkpoint')
  const commit=store.readCommit(checkpointA.checkpointId),program=commit.changes.find(change=>change.path==='project.abs')
  assert.equal(program?.beforeHash,sha(publishedS0.abs));assert.equal(program?.afterHash,sha(publishedA.abs));assert.equal(program.draftOnly,undefined)
  evidence.historyCommit={checkpoint:checkpointA,before:program.beforeHash,after:program.afterHash,realNativeAdoption:true,canonicalWrittenByHistory:false}
  await phase('unrelated-latest-GUI-C-remains-dirty')
  await editWorking(page,project,plans.C,plans.C.valueA)
  expectedAC=historyExpectedDocument(expectedA,plans.C,plans.C.valueA);expectedC=historyExpectedDocument(original,plans.C,plans.C.valueA)
  assert.equal(documentHash(await nativeDocument(page,project)),documentHash(expectedAC))
  assert.equal(documentHash(JSON.parse(await fs.readFile(path.join(project,'project.abi'),'utf8'))),documentHash(expectedA))
  await phase('real-History-undo-preserves-complete-GUI-C')
  const undo=await history.revertTurn(checkpointA.historySessionId,checkpointA.turnIndex)
  assert.equal(undo.ok,true);assert.ok(undo.nativeHistory);await assertDocument(expectedC)
  assert.equal(store.readSession(checkpointA.historySessionId).commits.find(ref=>ref.commitId===checkpointA.checkpointId).active,false)
  await phase('real-History-redo-uses-frozen-before-source-and-preserves-C')
  const redo=await history.reapplyTurn(checkpointA.historySessionId,checkpointA.turnIndex)
  assert.equal(redo.ok,true);assert.ok(redo.nativeHistory);await assertDocument(expectedAC)
  const afterRedo=store.readSession(checkpointA.historySessionId)
  assert.equal(afterRedo.commits.find(ref=>ref.commitId===checkpointA.checkpointId).active,true)
  evidence.undoRedo={undo,redo,undoFullDocumentHash:documentHash(expectedC),redoFullDocumentHash:documentHash(expectedAC),unrelatedCPreserved:true,frozenBase:program.beforeHash}
  }
  const {SessionManager}=sdk
  await phase('second-undo-terminal-genuine-COMMITTED-response-lost')
  const proofFile=path.join(suite,'r2-history-fault-0.json')
  assert.equal((await app.evaluate(installHistoryPublicationFault,JSON.stringify({pid:hostPid,project,appData,port:descriptor.port,proofFile,dropTerminal:true,expectedDocument:expectedC}))).available,true)
  const observationOwner=new AbortController()
  history.setNavigationSignalProvider(()=>observationOwner.signal)
  let settled=false,fault
  const undoing=history.revertTurn(checkpointA.historySessionId,checkpointA.turnIndex).then(result=>{settled=true;return{result}},error=>{settled=true;return{error:{name:error.name,code:error.code,message:error.message}}})
  const faultDeadline=Date.now()+120000
  while(Date.now()<faultDeadline){
    fault=JSON.parse(await fs.readFile(proofFile,'utf8'))
    assert.deepEqual(fault.failures,[])
    if(fault.drops>0)break
    assert.equal(settled,false,'The native operation must reach the genuine terminal fault before owner Stop')
    await delay(50)
  }
  assert.ok(fault?.drops>0,'Stop is triggered only after the genuine original COMMITTED terminal was destroyed')
  observationOwner.abort(new DOMException('R2 SDK owner stops observing the original History request','AbortError'))
  const stopped=await undoing,pendingError=stopped.error
  assert.equal(pendingError?.name,'AbortError')
  assert.equal(fault.commands.filter(command=>command.action==='history_publish').length,1)
  assert.ok(fault.terminals.length>=1&&fault.commands[0].responseDestroyed===true)
  evidence.sdkOwnerStop=true;evidence.chatUiHistoryStopCovered=false
  const pending=pendingHistoryStep(store.listTransactions()),beforeColdCursor=store.readSession(checkpointA.historySessionId)
  assert.equal(pending.requestId,fault.requestId);assert.equal(pending.executorPid,hostPid)
  await assertDocument(expectedC)
  const savedBeforeCold=await mirrors(),originalExecutor=hostPid
  evidence.pending={...pending,error:pendingError,terminal:fault.terminals[0],originalCursor:beforeColdCursor}
  await history.dispose();history=undefined
  await phase('whole-host-kill-and-product-auto-same-root');await killOwned();await launch(resume?2:1)
  assert.notEqual(hostPid,originalExecutor);await assertDocument(expectedC);assert.deepEqual(await mirrors(),savedBeforeCold)
  const coldProof=path.join(suite,'r2-history-fault-1.json')
  assert.equal((await app.evaluate(installHistoryPublicationFault,JSON.stringify({pid:hostPid,originalTargetPid:originalExecutor,project,appData,port:descriptor.port,
    proofFile:coldProof,requestId:pending.requestId,readOnly:true,expectedDocument:expectedC}))).available,true)
  manager=SessionManager.open(sessionFile);wireLifecycle();history.setNavigationSignalProvider(()=>undefined)
  await phase('actual-session-start-automatic-original-ID-observation-without-navigation-goal')
  await handlers.get('session_start')({},context)
  const observed=JSON.parse(await fs.readFile(coldProof,'utf8'))
  assert.equal(observed.failures.length,0);assert.equal(observed.commands.length,1)
  assert.equal(observed.commands[0].action,'history_observe');assert.equal(observed.commands[0].requestId,pending.requestId)
  assert.equal(observed.commands[0].originalTargetPid,originalExecutor);assert.equal(observed.terminals.length,1)
  assert.deepEqual(store.readSession(checkpointA.historySessionId),beforeColdCursor,'Read-only automatic lookup does not force a cursor/UI navigation goal')
  assert.deepEqual(await mirrors(),savedBeforeCold,'Automatic observation cannot republish or compensate')
  const durable=store.listTransactions().find(tx=>tx.id===pending.transactionId)
  assert.equal(durable.programNavigation.steps.find(step=>step.request?.requestId===pending.requestId).state,'completed')
  evidence.coldObservation={originalRequestId:pending.requestId,originalExecutorPid:originalExecutor,observerPid:hostPid,readonly:observed,
    automaticSdkSessionStart:true,cursorAdvanced:false,preparedStepsPublished:false,manualGoalActivation:false}
  await phase('next-normal-GUI-edit-B-and-native-save-remain-available')
  await editWorking(page,project,plans.A,plans.A.oldValue+2)
  const expectedBC=historyExpectedDocument(expectedC,plans.A,plans.A.oldValue+2)
  evidence.saveB=await saveWorking();await assertDocument(expectedBC)
  assert.notEqual(evidence.saveB.saveReceipt.requestId,pending.requestId)
  await page.screenshot({path:path.join(values.output,'history-cold-original-observed-and-fresh-B.png'),fullPage:true})
  evidence.agentAfter=await sdkHashes();assert.deepEqual(evidence.agentAfter,evidence.agentBefore)
  assert.equal(sha(await fs.readFile(asar)),values['expected-host-hash'])
  assert.deepEqual(await inventory(values['project-input']),originalFiles)
  for(const group of ['node_modules','local-libraries','.assets'])for(const entry of originalFiles.filter(entry=>entry.path.startsWith(group+path.sep)))
    assert.equal(sha(await fs.readFile(path.join(project,entry.path))),entry.sha256,'Original definitions/resources: '+entry.path)
  evidence.originalInputUnchanged=true;evidence.fixedOriginalDefinitionFilesUnchanged=true;evidence.finalFullDocumentHash=documentHash(expectedBC)
  evidence.ok=true;await phase('passed')
}catch(error){
  evidence.error={name:error.name,code:error.code,message:String(error.message).slice(0,2400)}
  if(page)await page.screenshot({path:path.join(values.output,'failure.png'),fullPage:true}).catch(()=>{})
  await persist();throw error
}finally{
  await history?.dispose().catch(error=>{evidence.cleanupFailures.push('SDK History: '+error.message);evidence.ok=false})
  if(app){try{evidence.finalCleanupMode='forced-test-cleanup';evidence.normalCloseCoverage=false;await killOwned();evidence.finalOwnedProcesses=0}catch(error){evidence.cleanupFailures.push('Host: '+error.message);evidence.ok=false}}
  evidence.originalInputUnchanged=JSON.stringify(await inventory(values['project-input']))===JSON.stringify(originalFiles)
  if(!evidence.originalInputUnchanged)evidence.ok=false
  await persist()
}
