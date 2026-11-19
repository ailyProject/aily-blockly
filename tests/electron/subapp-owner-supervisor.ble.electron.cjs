'use strict';
// Actual renderer crash/reload and production owner transport. No Bluetooth hardware opens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const bleRoot = path.resolve(process.env.BLE_SUBAPP_ROOT || path.join(root, '../aily-subapp/packages/ble-debugger'));
const output = process.env.AILY_BLE_OWNER_OUTPUT
  ? path.resolve(process.env.AILY_BLE_OWNER_OUTPUT)
  : path.join(root, 'tests/test-results/subapp-owner-ble', new Date().toISOString().replace(/[:.]/g, '-'));
const fingerprint = file => {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
};

if (!process.versions.electron) {
  assert(!fs.existsSync(output), 'Use a fresh output directory; prior results are retained');
  fs.mkdirSync(output, { recursive: true });
  const { ELECTRON_RUN_AS_NODE, ...environment } = process.env;
  const executable = require('electron');
  const child = spawn(executable, [__filename], { cwd: root, windowsHide: true,
    env: { ...environment, AILY_BLE_OWNER_OUTPUT: output, BLE_SUBAPP_ROOT: bleRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = fs.createWriteStream(path.join(output, 'stdout.log'));
  const stderr = fs.createWriteStream(path.join(output, 'stderr.log'));
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('close', async (actualExitCode, signal) => {
    clearTimeout(timeout);
    await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
    let result;
    try { result = JSON.parse(fs.readFileSync(path.join(output, 'report.json'))); } catch { result = { ok: false }; }
    const report = { ok: result.ok === true && actualExitCode === 0 && !timedOut, actualExitCode, signal,
      timedOut, pid: child.pid, electron: executable, checks: result.checks?.length || 0,
      report: fs.existsSync(path.join(output, 'report.json')) ? fingerprint(path.join(output, 'report.json')) : null };
    fs.writeFileSync(path.join(output, 'launcher-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, output }));
    process.exitCode = report.ok ? 0 : 1;
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  // The test owns shutdown after asynchronous domain and worker cleanup.
  app.on('window-all-closed', () => {});
  const windows = [];
  let server, core, domain, supervisor;
  const report = { ok: false, scope: 'Real Electron renderer crash/reload, production preload/AgentBridge/Supervisor, BLE Core/Runtime/server/evidence worker. Controlled scanner, process-acquisition and automation ports.',
    checks: [], rfUsed: false, modelInvoked: false, fullInstalledHost: false, cleanupErrors: [] };
  // Electron otherwise displays a modal dialog for main-process fixture errors.
  process.on('uncaughtException', error => {
    fs.writeFileSync(path.join(output, 'uncaught.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2));
    console.error(error); process.exit(1);
  });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(probe) {
    const end = Date.now() + 8000;
    while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(20); }
    throw Error('BLE lifecycle checkpoint timed out');
  }
  const check = name => { report.checks.push({ name, passed: true }); fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(report, null, 2) + '\n'); };
  async function run() {
    const esbuild = require('esbuild');
    const ble = createRequire(path.join(bleRoot, 'package.json'));
    const { BleRuntime } = ble('./runtime/ble-runtime');
    const { createBleDebuggerCore } = ble('./core');
    const { startBleDebuggerServer } = ble('./server');
    const { callBleRuntime } = ble('./runtime/rpc-client');
    const manifest = ble('./agent/tools.json');
    const { SubappOwnerSupervisor, registerSubappOwnerSupervisor } = require('../../electron/subapp-owner-supervisor');
    const { SubappOwnerProcessLeases } = require('../../electron/subapp-owner-process-lease');
    const { acquireOwner, releaseOwnerFromSessions, hasOwnerId } = require('../../electron/child-tool-session-leases');
    let starts = 0, stops = 0, observation;
    const scanner = {
      capabilities: () => ({ implementationAvailable: true, readiness: 'unverified', provider: 'test-only' }),
      snapshot: () => ({ bluetoothInitialized: false, controlled: true }),
      start: input => { starts++; observation = input; return { confirmed: true }; },
      stop: () => { stops++; return { confirmed: true, processExited: true, watcherStopped: true }; },
    };
    domain = new BleRuntime({ scanProvider: scanner, evidenceOptions: { rootDir: path.join(output, 'evidence') } });
    core = createBleDebuggerCore({ runtime: domain });
    const requests = [], execute = core.executeAction;
    core.executeAction = (...args) => { requests.push(args[0].method); return execute(...args); };
    server = await startBleDebuggerServer({ core, runtimeRoot: path.join(output, 'runtime') });
    const runtimeConfig = { id: 'ble-debugger', namespace: 'BLE_DEBUGGER', titleKey: 'BLE_DEBUGGER.TITLE',
      agent: { ...manifest, tools: manifest.tools.map(tool => ({ ...tool, presentation: undefined })) } };
    const session = { streamId: 'ble-lifecycle-test', owners: new Map(),
      hostInfo: { wsUrl: server.wsUrl, runtimeConfig } };
    const sessions = new Map([['ble-debugger', session]]), warnings = [];
    supervisor = new SubappOwnerSupervisor({ processLeases: new SubappOwnerProcessLeases(output),
      onError: (...args) => warnings.push(args),
      resolveRuntime: (toolId, rendererId) => toolId === 'ble-debugger' && hasOwnerId(session, rendererId) ? session : null });
    registerSubappOwnerSupervisor(ipcMain, supervisor);
    const bundle = await esbuild.build({ stdin: { contents: [
      "export { SubappAgentBridgeService } from './src/app/services/integrations/subapps/subapp-agent-bridge.service';",
      "export { replaceChildToolConfigs } from './src/app/configs/tool.config';",
    ].join('\n'), resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife',
      globalName: 'fixture', write: false, metafile: true, plugins: [{ name: 'decorators-only', setup(builder) {
        builder.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
          'export const Injectable = () => target => target; export const Inject = () => () => {}; export class InjectionToken {}' }));
      } }] });
    const inputs = new Set([__filename, path.join(root, 'electron/preload.js')]);
    for (const file of Object.keys(require.cache)) if ((file.startsWith(bleRoot + path.sep) || file.startsWith(path.join(root, 'electron') + path.sep)) && !file.includes(path.sep + 'node_modules' + path.sep)) inputs.add(file);
    for (const file of Object.keys(bundle.metafile.inputs)) {
      const absolute = path.resolve(root, file);
      if (fs.existsSync(absolute) && absolute.startsWith(path.join(root, 'src') + path.sep)) inputs.add(absolute);
    }
    report.sourceFiles = Object.fromEntries([...inputs].sort().map(file => [file, fingerprint(file)]));
    const call = (window, body) => window.webContents.executeJavaScript(`(async () => { ${body} })()`);
    async function initialize(window) {
      await window.webContents.executeJavaScript(bundle.outputFiles[0].text + '\nvoid 0;');
      await call(window, `fixture.replaceChildToolConfigs([${JSON.stringify(runtimeConfig)}]);
        window.bridge = new fixture.SubappAgentBridgeService({acquire:async()=>(${JSON.stringify(session.hostInfo)}),release:async()=>{}},
          {isChildAppWindowOpen:async()=>false,openChildApp:async()=>{throw Error('Unexpected presentation')}} ,
          {recordInvocationStarted(){},recordInvocationCompleted(){},recordRuntimeState(){},releaseSession(){}});
        return typeof window.electronAPI.childToolSession.superviseOwner;`);
    }
    async function createWindow() {
      const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'),
        contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
      windows.push(window);
      const contents = window.webContents, rendererId = contents.id;
      acquireOwner(session, rendererId, 'fixture-runtime-reference');
      contents.on('render-process-gone', () => releaseOwnerFromSessions(sessions, rendererId));
      contents.once('destroyed', () => releaseOwnerFromSessions(sessions, rendererId));
      let preloadError;
      window.webContents.on('preload-error', (_event, _file, error) => { preloadError = error; });
      await window.loadFile(path.join(__dirname, 'fixtures/subapp-owner.html'));
      assert.ifError(preloadError); await initialize(window);
      return window;
    }
    async function start(window, sessionId) {
      const result = await call(window, `window.owner=await bridge.manageOwnerLease({action:'acquire',sessionId:${JSON.stringify(sessionId)}});
        if(!owner.ok)throw Error(JSON.stringify(owner));return await bridge.execute({toolId:'ble-debugger',tool:'ble_scan_manage',params:{action:'start'}},undefined,
          {sessionId:owner.sessionId,ownerLeaseId:owner.ownerLeaseId,toolCallId:'start'});`);
      assert.equal(result.ok, true, JSON.stringify(result));
      const owner = await call(window, 'return owner;');
      const state = supervisor.renderers.get(window.webContents.id);
      assert.equal(state.bindings.size, 1);
      const binding = [...state.bindings.values()][0];
      assert.equal(binding.acknowledged, true);
      return { scanId: result.result.scanId, generation: state.generation, owner,
        context: { actor: 'agent', sessionId: owner.ownerLeaseId, ownerPid: process.pid, leaseFile: binding.processLease.leaseFile } };
    }
    const query = (window, scanId) => call(window, `return await bridge.execute({toolId:'ble-debugger',tool:'ble_scan_manage',params:{action:'query',scanId:${JSON.stringify(scanId)}}},undefined,{sessionId:owner.sessionId,ownerLeaseId:owner.ownerLeaseId,toolCallId:'query'});`);
    const emit = (name, key) => observation.onObservation({ deviceKey: key, name, address: '010203040506', addressType: 'public', rssi: -44,
      sections: [{ type: 9, dataHex: Buffer.from(name).toString('hex') }], source: { provider: 'test-only', rawFormat: 'os-data-sections-normalized' } });
    console.log('PHASE runtime-and-bundle-ready');
    const a = await createWindow(), b = await createWindow();
    console.log('PHASE windows-ready');
    const oldA = await start(a, 'chat-a'), oldB = await start(b, 'chat-b');
    assert.equal(starts, 1); assert.equal(stops, 0); assert.equal(core.status().owners.active, 2);
    emit('Before crash', 'first');
    assert.equal((await query(b, oldB.scanId)).result.items.length, 1);
    await until(() => domain.evidence.snapshot().health.state === 'healthy');
    assert.equal(domain.evidence.snapshot().workers, 1);
    check('Two renderer owners use production preload and AgentBridge with one shared scanner and a real evidence worker');
    console.log('PHASE two-owners-ready');

    const crashed = once(a.webContents, 'render-process-gone');
    a.webContents.forcefullyCrashRenderer(); await crashed; await supervisor.idle();
    await until(() => core.status().owners.active === 1);
    assert.equal(starts, 1); assert.equal(stops, 0); assert.equal(core.status().scanning, true);
    assert.equal(fs.existsSync(oldA.context.leaseFile), false);
    await assert.rejects(supervisor.track(a.webContents, { generation: oldA.generation, toolId: 'ble-debugger', ownerSessionId: oldA.owner.ownerLeaseId }), { code: 'SUBAPP_RENDERER_EXPIRED' });
    await assert.rejects(callBleRuntime(server, 'ble.scan.start', {}, { context: oldA.context }), error => /^BLE_OWNER_/.test(error.code));
    emit('After crash', 'second');
    const preserved = await query(b, oldB.scanId);
    assert.equal(preserved.ok, true); assert.equal(preserved.result.items.length, 2);
    assert.equal(requests.filter(method => method === 'ble.scan.start').length, 3); // two explicit starts and one deliberately rejected stale call
    check('Actual renderer crash revokes only A; B consumes new observations without restart or replay, and old A generation/lease is fenced');
    console.log('PHASE crash-accepted');

    const loaded = once(b.webContents, 'did-finish-load'); b.webContents.reload(); await loaded; await supervisor.idle();
    await until(() => core.status().owners.active === 0 && stops === 1);
    assert.equal(core.status().scanning, false); assert.equal(starts, 1);
    assert.equal(fs.existsSync(oldB.context.leaseFile), false);
    await initialize(b);
    const staleGeneration = await call(b, `return await window.electronAPI.childToolSession.superviseOwner({action:'track',generation:${JSON.stringify(oldB.generation)},toolId:'ble-debugger',ownerSessionId:${JSON.stringify(oldB.owner.ownerLeaseId)}});`);
    assert.equal(staleGeneration.ok, false); assert.equal(staleGeneration.errorCode, 'SUBAPP_RENDERER_EXPIRED');
    const staleOwner = await call(b, `return await bridge.execute({toolId:'ble-debugger',tool:'ble_scan_manage',params:{action:'start'}},undefined,${JSON.stringify({ sessionId: oldB.owner.sessionId, ownerLeaseId: oldB.owner.ownerLeaseId, toolCallId: 'stale' })});`);
    assert.equal(staleOwner.ok, false); assert.equal(staleOwner.errorCode, 'SUBAPP_OWNER_EXPIRED');
    await assert.rejects(callBleRuntime(server, 'ble.scan.start', {}, { context: oldB.context }), error => /^BLE_OWNER_/.test(error.code));
    assert.equal(starts, 1); assert.equal(stops, 1);
    check('Actual reload releases the final old owner once; stale document IPC and old bridge/Runtime owner capabilities cannot reacquire');
    console.log('PHASE reload-accepted');

    console.log('PHASE renewing');
    const renewed = await start(b, 'chat-b');
    console.log('PHASE renewed');
    assert.notEqual(renewed.generation, oldB.generation); assert.notEqual(renewed.owner.ownerLeaseId, oldB.owner.ownerLeaseId);
    assert.notEqual(renewed.context.leaseFile, oldB.context.leaseFile);
    assert.equal(starts, 2); assert.equal(stops, 1);
    emit('New document', 'third'); assert.equal((await query(b, renewed.scanId)).result.items.length, 1);
    const closed = once(b, 'closed');
    b.destroy(); await closed; await supervisor.idle();
    await until(() => core.status().owners.active === 0 && stops === 2);
    assert.equal(core.status().scanning, false);
    assert.equal(requests.filter(method => method === 'ble.scan.start').length, 5); // three explicit starts and two deliberately rejected stale calls
    assert.equal(warnings.length, 0, JSON.stringify(warnings));
    report.observations = { starts, stops, startRequests: 5, explicitStartRequests: 3, deliberatelyRejectedStaleStartRequests: 2 };
    check('A new document explicitly acquires a new owner and scanner; actual window destruction settles its owner with no automatic domain replay');
    report.ok = true;
  }
  app.whenReady().then(async () => {
    try { await run(); }
    catch (error) { report.failure = { message: error.message, stack: error.stack }; fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify(report, null, 2) + '\n'); }
    finally {
      console.log('PHASE cleanup');
      try { await supervisor?.idle(); } catch (error) { report.cleanupErrors.push(error.message); }
      try { await server?.stop(); } catch (error) { report.cleanupErrors.push(error.message); }
      if (domain) {
        report.finalEvidence = domain.evidence.snapshot();
        if (report.ok) {
          try {
            assert.equal(report.finalEvidence.workers, 0); assert.equal(report.finalEvidence.health.state, 'closed');
            assert.equal(report.finalEvidence.actualWorkerRequests, 0); assert.equal(report.finalEvidence.pendingRecords, 0);
          } catch (error) { report.cleanupErrors.push(error.message); }
        }
      }
      report.sourceStable = report.sourceFiles && Object.entries(report.sourceFiles).every(([file, value]) => JSON.stringify(fingerprint(file)) === JSON.stringify(value));
      report.ok = report.ok && report.sourceStable && report.cleanupErrors.length === 0;
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, output, failure: report.failure }));
      app.exit(report.ok ? 0 : 1);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
