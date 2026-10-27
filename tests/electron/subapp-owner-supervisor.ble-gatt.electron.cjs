'use strict';
// Actual renderer lifecycle; only native provider and process acquisition ports are controlled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const bleRoot = path.resolve(process.env.BLE_SUBAPP_ROOT || path.join(root, '../aily-subapp/packages/ble-debugger'));
const output = path.resolve(process.env.AILY_BLE_GATT_OWNER_OUTPUT || path.join(root, 'tests/test-results/subapp-owner-ble-gatt', new Date().toISOString().replace(/[:.]/g, '-')));
const fingerprint = file => { const bytes = fs.readFileSync(file); return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; };
if (!process.versions.electron) {
  assert(!fs.existsSync(output), 'Use a fresh output directory; prior results are retained');
  fs.mkdirSync(output, { recursive: true });
  const { ELECTRON_RUN_AS_NODE, ...environment } = process.env;
  const executable = require('electron');
  const child = spawn(executable, [__filename], { cwd: root, windowsHide: true,
    env: { ...environment, AILY_BLE_GATT_OWNER_OUTPUT: output, BLE_SUBAPP_ROOT: bleRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = fs.createWriteStream(path.join(output, 'stdout.log')), stderr = fs.createWriteStream(path.join(output, 'stderr.log'));
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('close', async (actualExitCode, signal) => {
    clearTimeout(timeout);
    await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
    let result;
    try { result = JSON.parse(fs.readFileSync(path.join(output, 'report.json'))); } catch { result = { ok: false }; }
    const report = { ok: result.ok === true && actualExitCode === 0 && !timedOut, actualExitCode, signal, timedOut, pid: child.pid,
      nodeVersion: process.version, electron: executable, checks: result.checks?.length || 0,
      report: fs.existsSync(path.join(output, 'report.json')) ? fingerprint(path.join(output, 'report.json')) : null };
    fs.writeFileSync(path.join(output, 'launcher-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, output })); process.exitCode = report.ok ? 0 : 1;
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const windows = [];
  let core, domain, server, supervisor, fixture;
  const report = { ok: false, checks: [], cleanupErrors: [], rfUsed: false, modelInvoked: false, fullInstalledHost: false,
    versions: process.versions,
    scope: 'Real Electron renderer destroy/reload/crash, production preload/AgentBridge/Supervisor and BLE Core/Runtime/server/evidence worker; controlled native GATT provider and process-acquisition/automation ports. Not the installed host or RF.' };
  process.on('uncaughtException', error => { fs.writeFileSync(path.join(output, 'uncaught.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2)); console.error(error); process.exit(1); });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(probe) { const end = Date.now() + 8000; while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(20); } throw Error('BLE GATT lifecycle checkpoint timed out'); }
  const check = name => { report.checks.push({ name, passed: true }); fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(report, null, 2) + '\n'); console.log('PASS ' + name); };
  async function run() {
    const ble = createRequire(path.join(bleRoot, 'package.json'));
    const { BleRuntime } = ble('./runtime/ble-runtime'), { createBleDebuggerCore } = ble('./core');
    const { startBleDebuggerServer } = ble('./server'), { callBleRuntime } = ble('./runtime/rpc-client');
    const manifest = ble('./agent/tools.json');
    const { SubappOwnerSupervisor, registerSubappOwnerSupervisor } = require('../../electron/subapp-owner-supervisor');
    const { SubappOwnerProcessLeases } = require('../../electron/subapp-owner-process-lease');
    const { acquireOwner, releaseOwnerFromSessions, hasOwnerId } = require('../../electron/child-tool-session-leases');
    fixture = require('./fixtures/ble-gatt-provider.cjs').createProvider();
    domain = new BleRuntime({ scanProvider: fixture.provider, evidenceOptions: { rootDir: path.join(output, 'evidence') } });
    core = createBleDebuggerCore({ runtime: domain });
    const requests = [], execute = core.executeAction;
    core.executeAction = (...args) => { requests.push(args[0].method); return execute(...args); };
    server = await startBleDebuggerServer({ core, runtimeRoot: path.join(output, 'runtime') });
    const runtimeConfig = { id: 'ble-debugger', namespace: 'BLE_DEBUGGER', titleKey: 'BLE_DEBUGGER.TITLE',
      agent: { ...manifest, tools: manifest.tools.map(tool => ({ ...tool, presentation: undefined })) } };
    const session = { streamId: 'ble-gatt-lifecycle-test', owners: new Map(), hostInfo: { wsUrl: server.wsUrl, runtimeConfig } };
    const sessions = new Map([['ble-debugger', session]]), warnings = [];
    supervisor = new SubappOwnerSupervisor({ processLeases: new SubappOwnerProcessLeases(output), onError: (...args) => warnings.push(args),
      resolveRuntime: (toolId, rendererId) => toolId === 'ble-debugger' && hasOwnerId(session, rendererId) ? session : null });
    registerSubappOwnerSupervisor(ipcMain, supervisor);
    const bundle = await require('esbuild').build({ stdin: { contents: [
      "export { SubappAgentBridgeService } from './src/app/services/integrations/subapps/subapp-agent-bridge.service';",
      "export { replaceChildToolConfigs } from './src/app/configs/tool.config';"
    ].join('\n'), resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife', globalName: 'fixture', write: false, metafile: true,
      plugins: [{ name: 'decorators-only', setup(builder) {
        builder.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const Injectable = () => target => target; export const Inject = () => () => {}; export class InjectionToken {}' }));
      } }] });
    const inputs = new Set([__filename, path.join(root, 'electron/preload.js')]);
    for (const file of Object.keys(require.cache)) if ((file.startsWith(bleRoot + path.sep) || file.startsWith(path.join(root, 'electron') + path.sep) || file === path.join(__dirname, 'fixtures/ble-gatt-provider.cjs')) && !file.includes(path.sep + 'node_modules' + path.sep)) inputs.add(file);
    for (const file of Object.keys(bundle.metafile.inputs)) { const absolute = path.resolve(root, file); if (fs.existsSync(absolute) && absolute.startsWith(path.join(root, 'src') + path.sep)) inputs.add(absolute); }
    report.sourceFiles = Object.fromEntries([...inputs].sort().map(file => [file, fingerprint(file)]));
    const call = (window, body) => window.webContents.executeJavaScript(`(async () => { ${body} })()`);
    async function initialize(window) {
      await window.webContents.executeJavaScript(bundle.outputFiles[0].text + '\nvoid 0;');
      await call(window, `fixture.replaceChildToolConfigs([${JSON.stringify(runtimeConfig)}]);
        window.bridge = new fixture.SubappAgentBridgeService({acquire:async()=>(${JSON.stringify(session.hostInfo)}),release:async()=>{}},
          {isChildAppWindowOpen:async()=>false,openChildApp:async()=>{throw Error('Unexpected presentation')}},
          {recordInvocationStarted(){},recordInvocationCompleted(){},recordRuntimeState(){},releaseSession(){}});`);
    }
    async function createWindow() {
      const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } }); windows.push(window);
      const contents = window.webContents, rendererId = contents.id;
      acquireOwner(session, rendererId, 'fixture-runtime-reference');
      contents.on('render-process-gone', () => releaseOwnerFromSessions(sessions, rendererId));
      contents.once('destroyed', () => releaseOwnerFromSessions(sessions, rendererId));
      let preloadError; contents.on('preload-error', (_event, _file, error) => { preloadError = error; });
      await window.loadFile(path.join(__dirname, 'fixtures/subapp-owner.html')); assert.ifError(preloadError); await initialize(window); return window;
    }
    async function acquire(window, sessionId) {
      // This is the controlled process-acquisition port, explicitly requested by the new document.
      acquireOwner(session, window.webContents.id, 'fixture-runtime-reference');
      const owner = await call(window, `window.owner=await bridge.manageOwnerLease({action:'acquire',sessionId:${JSON.stringify(sessionId)}});if(!owner.ok)throw Error(JSON.stringify(owner));return owner;`);
      await invoke(window, 'ble_connection_manage', { action: 'list' });
      const state = supervisor.renderers.get(window.webContents.id), binding = [...state.bindings.values()][0];
      assert.equal(binding.acknowledged, true);
      return { generation: state.generation, owner, context: { actor: 'agent', sessionId: owner.ownerLeaseId, ownerPid: process.pid, leaseFile: binding.processLease.leaseFile } };
    }
    let invocation = 0;
    async function rawInvoke(window, tool, params, owner) {
      return call(window, `return await bridge.execute({toolId:'ble-debugger',tool:${JSON.stringify(tool)},params:${JSON.stringify(params)}},undefined,${owner ? JSON.stringify({ sessionId: owner.sessionId, ownerLeaseId: owner.ownerLeaseId, toolCallId: String(++invocation) }) : `{sessionId:owner.sessionId,ownerLeaseId:owner.ownerLeaseId,toolCallId:${JSON.stringify(String(++invocation))}}`});`);
    }
    async function invoke(window, tool, params) { const result = await rawInvoke(window, tool, params); assert.equal(result.ok, true, JSON.stringify(result)); return result.result; }
    const connectionRef = connection => ({ connectionId: connection.connectionId, connectionEpoch: connection.connectionEpoch });
    async function open(window) {
      const scan = await invoke(window, 'ble_scan_manage', { action: 'start', durationMs: 120000 }); fixture.observe();
      const page = await invoke(window, 'ble_scan_manage', { action: 'query', scanId: scan.scanId });
      const connection = await invoke(window, 'ble_connection_manage', { action: 'open', scanId: scan.scanId, deviceRef: page.items[0].deviceRef, adapterEpoch: page.adapterEpoch });
      const discovered = await invoke(window, 'ble_connection_manage', { action: 'discover', ...connectionRef(connection) });
      const catalog = await invoke(window, 'ble_connection_manage', { action: 'catalog', ...connectionRef(connection), databaseEpoch: discovered.databaseEpoch, limit: 16 });
      const c0 = catalog.items.find(item => item.attributeHandle === 2), c1 = catalog.items.find(item => item.attributeHandle === 3);
      assert(c0 && c1); assert.equal(c0.uuid, c1.uuid); assert.notDeepEqual(c0.ref, c1.ref);
      return { connection: connectionRef(connection), ref: c0.ref, duplicateRef: c1.ref };
    }
    const a = await createWindow(), b = await createWindow();
    const ownerA = await acquire(a, 'gatt-a'), ownerB = await acquire(b, 'gatt-b');
    const first = await open(a);
    await invoke(b, 'ble_connection_manage', { action: 'acquire', ...first.connection });
    await invoke(b, 'ble_connection_manage', { action: 'writerAcquire', ...first.connection });
    const subA = await invoke(a, 'ble_notification_manage', { action: 'subscribe', ref: first.ref, mode: 'notify' });
    const subB = await invoke(b, 'ble_notification_manage', { action: 'subscribe', ref: first.ref, mode: 'notify' });
    assert.equal(fixture.calls.open.length, 1); assert.equal(fixture.calls.enable.length, 1);
    assert.equal(core.status().owners.active, 2); assert.equal(core.status().connections.holds, 2);
    assert.equal((await invoke(b, 'ble_gatt_read', { action: 'read', ref: first.duplicateRef })).valueHex, '11');
    assert.equal(fixture.calls.read.at(-1).params.attributeToken, 'c1');
    fixture.emit('native-1', 'c0', 'a0');
    assert.equal((await invoke(b, 'ble_notification_manage', { action: 'query', subscriptionId: subB.subscriptionId })).items.at(-1).valueHex, 'a0');
    await until(() => domain.evidence.snapshot().health.state === 'healthy'); assert.equal(domain.evidence.snapshot().workers, 1);
    assert.equal(fs.existsSync(path.join(output, 'evidence/store.lock')), true);
    check('Two independent renderers share one exact connection/listener; B explicitly owns writer, with a real evidence worker');

    const aClosed = once(a, 'closed'); a.destroy(); await aClosed; await supervisor.idle();
    await until(() => core.status().owners.active === 1);
    assert.equal(fs.existsSync(ownerA.context.leaseFile), false);
    assert.equal(fixture.calls.close.length, 0); assert.equal(fixture.calls.disable.length, 0);
    assert.equal(core.status().connections.holds, 1);
    const current = await invoke(b, 'ble_connection_manage', { action: 'list' }); assert.equal(current.items[0].writer.owned, true);
    assert.equal((await invoke(b, 'ble_gatt_read', { action: 'read', ref: first.ref })).valueHex, '10');
    await invoke(b, 'ble_gatt_write', { action: 'write', ref: first.ref, valueHex: 'b0', writeMode: 'with-response' });
    fixture.emit('native-1', 'c0', 'b1');
    assert.equal((await invoke(b, 'ble_notification_manage', { action: 'query', subscriptionId: subB.subscriptionId })).items.at(-1).valueHex, 'b1');
    const foreignSubscription = await rawInvoke(b, 'ble_notification_manage', { action: 'query', subscriptionId: subA.subscriptionId });
    assert.equal(foreignSubscription.ok, false); assert.equal(foreignSubscription.errorCode, 'BLE_TARGET_NOT_FOUND');
    await assert.rejects(callBleRuntime(server, 'ble.gatt.read', { ref: first.ref }, { context: ownerA.context }), error => /^BLE_OWNER_/.test(error.code));
    check('Actual A window destruction revokes only A; B keeps connection/writer and performs read/write/notification without restart');

    const loaded = once(b.webContents, 'did-finish-load'); b.webContents.reload(); await loaded; await supervisor.idle();
    await until(() => core.status().owners.active === 0 && core.status().connections.connections === 0);
    assert.equal(fixture.calls.close.length, 1); assert.equal(fixture.calls.disable.length, 1);
    assert.equal(fs.existsSync(ownerB.context.leaseFile), false);
    const beforeReloadInit = fixture.counts(); await initialize(b); await delay(100);
    assert.deepEqual(fixture.counts(), beforeReloadInit);
    const staleGeneration = await call(b, `return await window.electronAPI.childToolSession.superviseOwner({action:'track',generation:${JSON.stringify(ownerB.generation)},toolId:'ble-debugger',ownerSessionId:${JSON.stringify(ownerB.owner.ownerLeaseId)}});`);
    assert.equal(staleGeneration.ok, false); assert.equal(staleGeneration.errorCode, 'SUBAPP_RENDERER_EXPIRED');
    const staleOwner = await rawInvoke(b, 'ble_gatt_write', { action: 'write', ref: first.ref, valueHex: 'ff', writeMode: 'with-response' }, ownerB.owner);
    assert.equal(staleOwner.ok, false); assert.equal(staleOwner.errorCode, 'SUBAPP_OWNER_EXPIRED');
    await assert.rejects(callBleRuntime(server, 'ble.gatt.write', { ref: first.ref, valueHex: 'ff', writeMode: 'with-response' }, { context: ownerB.context }), error => /^BLE_OWNER_/.test(error.code));
    assert.deepEqual(fixture.counts(), beforeReloadInit);
    check('Actual B reload removes final old holds/listener/writer; old generation and owner are fenced, and initialization replays no native operation');

    const renewed = await acquire(b, 'gatt-b');
    assert.notEqual(renewed.generation, ownerB.generation); assert.notEqual(renewed.owner.ownerLeaseId, ownerB.owner.ownerLeaseId);
    const staleRef = await rawInvoke(b, 'ble_gatt_read', { action: 'read', ref: first.ref });
    assert.equal(staleRef.ok, false); assert.match(staleRef.errorCode, /^BLE_(STALE_REFERENCE|TARGET_NOT_FOUND|OWNER_MISMATCH)$/);
    const second = await open(b); assert.notEqual(second.connection.connectionEpoch, first.connection.connectionEpoch);
    await invoke(b, 'ble_connection_manage', { action: 'writerAcquire', ...second.connection });
    const renewedSub = await invoke(b, 'ble_notification_manage', { action: 'subscribe', ref: second.ref, mode: 'notify' });
    await invoke(b, 'ble_gatt_write', { action: 'write', ref: second.ref, valueHex: 'c0', writeMode: 'with-response' });
    fixture.emit('native-2', 'c0', 'c1');
    assert.equal((await invoke(b, 'ble_notification_manage', { action: 'query', subscriptionId: renewedSub.subscriptionId })).items.at(-1).valueHex, 'c1');
    check('The renewed document explicitly acquires fresh owner/connection/catalog/writer/subscription; old exact GATT reference remains invalid');

    const crashed = once(b.webContents, 'render-process-gone'); b.webContents.forcefullyCrashRenderer(); await crashed; await supervisor.idle();
    await until(() => core.status().owners.active === 0 && core.status().connections.connections === 0);
    assert.equal(fs.existsSync(renewed.context.leaseFile), false);
    assert.equal(fixture.calls.close.length, 2); assert.equal(fixture.calls.disable.length, 2);
    assert.equal(core.status().connections.holds, 0); assert.equal(core.status().connections.writerClaims, 0);
    assert.equal(core.status().connections.nativePending, 0); assert.equal(core.status().connections.cleanupPending, 0);
    assert.equal(core.status().gatt.scheduler.tasks, 0); assert.equal(core.status().gatt.scheduler.nativePending, 0);
    assert.equal(core.status().gatt.notifications.logicalSubscriptions, 0); assert.equal(core.status().gatt.notifications.physicalSubscriptions, 0);
    for (const field of ['catalogEntries', 'retainedNativeCatalogEntries', 'catalogBytes', 'retainedNativeCatalogBytes']) assert.equal(core.status().connections[field], 0, field);
    for (const field of ['payloadBytes', 'domains', 'quarantinedConnections']) assert.equal(core.status().gatt.scheduler[field], 0, field);
    for (const field of ['retainedSubscriptions', 'cleanupPending', 'metricsStreams']) assert.equal(core.status().gatt.notifications[field], 0, field);
    assert.equal(core.status().owners.cleanupPending, 0); assert.equal(core.status().operations.pending, 0); assert.equal(core.status().cleanupOperations.pending, 0);
    assert.equal(domain.evidence.snapshot().workers, 1, 'Runtime still owns the evidence worker after final owner');
    assert.deepEqual(fixture.resources(), { connections: 0, listeners: 0 });
    await assert.rejects(callBleRuntime(server, 'ble.notification.query', { subscriptionId: renewedSub.subscriptionId }, { context: renewed.context }), error => /^BLE_OWNER_/.test(error.code));
    assert.equal(warnings.length, 0, JSON.stringify(warnings));
    report.beforeShutdown = core.status(); report.providerCounts = fixture.counts(); report.requests = requests;
    check('Actual final renderer crash releases exact listener/connection once and converges writer, ATT/native pending and managed leases');

    const crashCounts = fixture.counts();
    const reloaded = once(b.webContents, 'did-finish-load'); b.webContents.reload(); await reloaded; await supervisor.idle();
    await initialize(b); await delay(100); assert.deepEqual(fixture.counts(), crashCounts);
    const crashedGeneration = await call(b, `return await window.electronAPI.childToolSession.superviseOwner({action:'track',generation:${JSON.stringify(renewed.generation)},toolId:'ble-debugger',ownerSessionId:${JSON.stringify(renewed.owner.ownerLeaseId)}});`);
    assert.equal(crashedGeneration.ok, false); assert.equal(crashedGeneration.errorCode, 'SUBAPP_RENDERER_EXPIRED');
    const crashedOwner = await rawInvoke(b, 'ble_notification_manage', { action: 'subscribe', ref: second.ref, mode: 'notify' }, renewed.owner);
    assert.equal(crashedOwner.ok, false); assert.equal(crashedOwner.errorCode, 'SUBAPP_OWNER_EXPIRED');
    assert.deepEqual(fixture.counts(), crashCounts);
    const recovered = await acquire(b, 'gatt-b');
    assert.notEqual(recovered.generation, renewed.generation); assert.notEqual(recovered.owner.ownerLeaseId, renewed.owner.ownerLeaseId);
    const crashedRef = await rawInvoke(b, 'ble_gatt_read', { action: 'read', ref: second.ref });
    assert.equal(crashedRef.ok, false); assert.match(crashedRef.errorCode, /^BLE_(STALE_REFERENCE|TARGET_NOT_FOUND|OWNER_MISMATCH)$/);
    const crashedSubscription = await rawInvoke(b, 'ble_notification_manage', { action: 'query', subscriptionId: renewedSub.subscriptionId });
    assert.equal(crashedSubscription.ok, false); assert.equal(crashedSubscription.errorCode, 'BLE_TARGET_NOT_FOUND');
    assert.deepEqual(fixture.counts(), crashCounts);
    const third = await open(b); assert.notEqual(third.connection.connectionEpoch, second.connection.connectionEpoch);
    await invoke(b, 'ble_connection_manage', { action: 'writerAcquire', ...third.connection });
    const recoveredSub = await invoke(b, 'ble_notification_manage', { action: 'subscribe', ref: third.ref, mode: 'notify' });
    await invoke(b, 'ble_gatt_write', { action: 'write', ref: third.ref, valueHex: 'd0', writeMode: 'with-response' });
    fixture.emit('native-3', 'c0', 'd1');
    assert.equal((await invoke(b, 'ble_notification_manage', { action: 'query', subscriptionId: recoveredSub.subscriptionId })).items.at(-1).valueHex, 'd1');
    const lastClosed = once(b, 'closed'); b.destroy(); await lastClosed; await supervisor.idle();
    await until(() => core.status().owners.active === 0 && core.status().connections.connections === 0);
    assert.equal(fs.existsSync(recovered.context.leaseFile), false);
    assert.deepEqual(fixture.calls.close, ['native-1', 'native-2', 'native-3']);
    assert.deepEqual(fixture.calls.read.map(item => [item.token, item.params.attributeToken]), [['native-1', 'c1'], ['native-1', 'c0']]);
    for (const key of ['write', 'enable', 'disable']) assert.deepEqual(fixture.calls[key].map(item => [item.token, item.params.attributeToken]), ['native-1', 'native-2', 'native-3'].map(token => [token, 'c0']), key);
    assert.deepEqual(fixture.resources(), { connections: 0, listeners: 0 });
    for (const field of ['holds', 'writerClaims', 'nativePending', 'cleanupPending', 'catalogEntries', 'retainedNativeCatalogEntries']) assert.equal(core.status().connections[field], 0, field);
    for (const field of ['tasks', 'nativePending', 'payloadBytes', 'domains', 'quarantinedConnections']) assert.equal(core.status().gatt.scheduler[field], 0, field);
    for (const field of ['logicalSubscriptions', 'physicalSubscriptions', 'retainedSubscriptions', 'cleanupPending', 'metricsStreams']) assert.equal(core.status().gatt.notifications[field], 0, field);
    assert.equal(core.status().owners.cleanupPending, 0); assert.equal(core.status().operations.pending, 0); assert.equal(core.status().cleanupOperations.pending, 0);
    assert.equal(warnings.length, 0, JSON.stringify(warnings));
    report.beforeShutdown = core.status(); report.providerCounts = fixture.counts(); report.requests = requests;
    report.finalLeases = [ownerA, ownerB, renewed, recovered].map(value => ({ leaseFile: value.context.leaseFile, exists: fs.existsSync(value.context.leaseFile) }));
    report.finalProviderResources = fixture.resources();
    check('Crash recovery initializes without replay, rejects old owner/ref/subscription, then explicit third acquisition works and final destroy settles exact tokens');
    report.ok = true;
  }
  app.whenReady().then(async () => {
    try { await run(); } catch (error) { report.failure = { message: error.message, stack: error.stack }; }
    finally {
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
      try { await supervisor?.idle(); } catch (error) { report.cleanupErrors.push(error.message); }
      try { await server?.stop(); } catch (error) { report.cleanupErrors.push(error.message); }
      if (domain) {
        report.finalEvidence = domain.evidence.snapshot(); report.finalDomain = domain.status();
        if (report.ok) try {
          assert.equal(report.finalEvidence.workers, 0); assert.equal(report.finalEvidence.health.state, 'closed');
          assert.equal(report.finalEvidence.actualWorkerRequests, 0); assert.equal(report.finalEvidence.pendingRecords, 0);
          assert.equal(report.finalEvidence.health.openFds, 0); assert.equal(report.finalEvidence.readers, 0);
          assert.equal(fs.existsSync(path.join(output, 'evidence/store.lock')), false);
          check('Explicit server stop closes the real evidence worker, file descriptors/readers and its actual store.lock');
        } catch (error) { report.cleanupErrors.push(error.message); }
      }
      report.sourceStable = report.sourceFiles && Object.entries(report.sourceFiles).every(([file, value]) => JSON.stringify(fingerprint(file)) === JSON.stringify(value));
      report.ok = report.ok && report.sourceStable && report.cleanupErrors.length === 0;
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, output, failure: report.failure, cleanupErrors: report.cleanupErrors })); app.exit(report.ok ? 0 : 1);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
