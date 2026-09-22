'use strict';
// Ordinary compilation -> selected artifact -> private Subapp -> real QEMU.
// Hidden renderer exercises native IPC, not a full editor/Agent conversation.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { root, mode, appData, prefix, childRoot, runtimeManifestPath, fixtureSource, scenario } = settings;
process.env.AILY_APPDATA_PATH = appData;
process.env.AILY_NPM_PREFIX = prefix;
process.env.AILY_CHILD_PATH = childRoot;
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const locks = require('../appdata-resource-lock'), cmd = require('../cmd');
const { createBuildDebugPreview, resolvePreviewConfiguration, registerBuildDebugPreview } = require('../build-debug-preview');
const { nativeSubappRegistry, listChildToolHoldersForCatalogId } = require('../window');
const { prepareS3Project } = require('./fixtures/s3-project.cjs');
const invoke = (window, channel, value) => window.webContents.executeJavaScript(`window.buildTest.invoke(${JSON.stringify(channel)},${JSON.stringify(value)})`);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function until(probe, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('Owned native S3 checkpoint timed out.');
}
const result = { schemaVersion: 1, mode, root, outcome: 'running', checks: [], startedAt: new Date().toISOString(),
    evidenceScope: 'ordinary-build-selected-firmware-native-composition', currentProjectAcceptance: false };
const progress = phase => { result.phase = phase; write(path.join(root, 'progress.json'), result); console.log(JSON.stringify({ mode, phase })); };
let window, foreign, removeExit;

app.whenReady().then(async () => {
    try {
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: true,
            preload: path.join(__dirname, 'fixtures/build-delivery-preload.cjs') } });
        await window.loadURL('data:text/html,<title>Owned native S3 firmware acceptance</title>');
        foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: true,
            preload: path.join(__dirname, 'fixtures/build-delivery-preload.cjs') } });
        await foreign.loadURL('data:text/html,<title>Foreign test owner</title>');
        const project = path.join(root, 'project');
        const { config } = prepareS3Project({ mode, project, appData, fixtureSource });
        locks.registerAppDataResourceLockHandlers(); cmd.registerCmdHandlers();
        const preview = createBuildDebugPreview({ registry: nativeSubappRegistry,
            configuration: () => resolvePreviewConfiguration({ childRoot, appData: path.join(root, 'evidence'), runtimeManifestPath }) });
        registerBuildDebugPreview(ipcMain, { preview, isCurrentRenderer: sender => sender === window.webContents });
        const request = path.join(project, `.temp/compile-request-${randomUUID()}.json`);
        fs.mkdirSync(path.dirname(request), { recursive: true }); write(request, config);
        const lease = await invoke(window, 'appdata-resource-lock-acquire', { mode: 'read', requestId: randomUUID(), label: 'Native S3 acceptance', timeoutMs: 60000 });
        assert.equal(lease.ok, true, JSON.stringify(lease));
        const streamId = `native-s3-${mode}-${randomUUID()}`, closed = Promise.withResolvers();
        removeExit = cmd.onCmdProcessExit(event => { if (event.streamId === streamId) closed.resolve(event); });
        const compileStart = Date.now(); progress('compile');
        const started = await invoke(window, 'cmd-run', { command: 'node', args: [path.join(childRoot, 'scripts/compile.js'), request],
            cwd: project, shellProfile: false, streamId, buildWorkspace: project,
            appDataResourceToken: lease.token, env: { PATH: settings.commandPath, DEV: 'false', AILY_E2E: '0' } });
        await invoke(window, 'appdata-resource-lock-release', { token: lease.token });
        assert.equal(started.success, true, started.error);
        const child = cmd.getCmdProcess(streamId), log = fs.createWriteStream(path.join(root, 'compile.log'));
        child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
        const exit = await closed.promise;
        await new Promise(resolve => log.end(resolve)); removeExit(); removeExit = undefined;
        assert.equal(exit.code, 0, `Compile failed; inspect ${path.join(root, 'compile.log')}`); assert.equal(exit.signal, null);
        assert.equal(fs.existsSync(lease.lockPath), false);
        result.compileMs = Date.now() - compileStart;
        result.checks.push('actual-host-compile-ipc-and-sdk-reader');
        const manifestPath = path.join(project, '.build/aily-artifact-manifest.json');
        const manifest = json(manifestPath);
        assert.equal(manifest.build.inputs, undefined);
        assert.equal(started.buildDeliveryHandle, undefined);
        for (const name of ['aily-build-inputs.json', 'aily-build-input-context.json', 'aily-build-delivery.json', 'aily-library-projections.json']) {
            assert.equal(fs.existsSync(path.join(project, '.build', name)), false, name);
        }
        result.checks.push('ordinary-build-without-input-recording');
        // Source changes after compilation must not gate a caller-selected firmware.
        const editedSource = path.join(project, mode === 'coder' ? 'sketch/src/main.cpp' : '.temp/sketch/sketch.ino');
        fs.appendFileSync(editedSource, '\n// Owned fixture edit after compilation.\n');
        const owner = { ...nativeSubappRegistry.supervisor.connect(window.webContents), ownerSessionId: `native-s3-${mode}` };
        const makeInput = () => ({ action: 'run', requestId: randomUUID(), generation: owner.generation, ownerSessionId: owner.ownerSessionId,
            manifestPath, scenario });
        progress('selected-firmware-qemu');
        const report = await invoke(window, 'build-debug-preview', makeInput());
        write(path.join(root, 'report.json'), report);
        assert.equal(report.outcome, 'passed', JSON.stringify(report.error));
        assert.equal(report.currentProjectAcceptance, false);
        assert.equal(report.hostSourceVerification, undefined);
        assert.equal(report.hostInputVerification, undefined);
        assert.equal(report.resultScope, 'supplied-firmware-snapshot');
        assert.deepEqual(Object.keys(report.timingsMs).sort(), ['cleanup', 'import', 'prepare', 'scenario']);
        assert.equal(report.snapshot.files.some(file => file.role === 'build-inputs'), false);
        assert.equal(report.steps.length, scenario.steps.length);
        assert.ok(Object.values(report.cleanup.resources).every(value => value === 0));
        result.timingsMs = report.timingsMs; result.report = path.join(root, 'report.json'); result.identity = report.identity;
        result.checks.push('installed-portable-debugger-private-rpc', 'source-edits-do-not-gate-snapshot', 'actual-qemu-uart-exchange', 'execution-resources-zero');
        assert.deepEqual(listChildToolHoldersForCatalogId('simulator-debugger'), []);
        await assert.rejects(invoke(foreign, 'build-debug-preview', makeInput()), /current main frame/);
        result.checks.push('foreign-window-rejected');
        progress('cancel-private-run');
        const cancellingInput = makeInput();
        const cancelled = invoke(window, 'build-debug-preview', cancellingInput).then(report => ({ report }), error => ({ error: String(error) }));
        await until(() => listChildToolHoldersForCatalogId('simulator-debugger').length > 0);
        assert.equal((await invoke(window, 'build-debug-preview', { action: 'cancel', requestId: cancellingInput.requestId })).cancelled, true);
        const cancellation = await cancelled; assert.ok(cancellation.error, JSON.stringify(cancellation));
        result.checks.push('private-run-cancel-and-process-cleanup');
        assert.equal(cmd.getActiveCmdProcesses().length, 0);
        assert.deepEqual(listChildToolHoldersForCatalogId('simulator-debugger'), []);
        for (const marker of ['aily-workspace.lock', 'aily-builder.lock']) assert.equal(fs.existsSync(path.join(project, '.build', marker)), false);
        assert.equal(digest(settings.builderCli), settings.builderSha256); assert.equal(digest(settings.debuggerCli), settings.debuggerSha256);
        result.outcome = 'passed'; progress('complete');
    } catch (error) { result.outcome = 'failed'; result.error = { message: error.message, stack: error.stack }; console.error(error); }
    finally {
        removeExit?.(); await cmd.killAllCmdProcesses(); await nativeSubappRegistry.supervisor.idle();
        if (foreign && !foreign.isDestroyed()) foreign.destroy(); if (window && !window.isDestroyed()) window.destroy();
        result.finishedAt = new Date().toISOString(); write(path.join(root, 'verification.json'), result);
        console.log(JSON.stringify({ mode, outcome: result.outcome, receipt: path.join(root, 'verification.json') }));
        app.exit(result.outcome === 'passed' ? 0 : 1);
    }
});
