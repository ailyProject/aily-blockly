'use strict';
// Formal installed package + default Runtime lookup; no compiler or source audit.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { root, installRoot, childRoot, manifestPath, scenario } = settings;
process.env.AILY_APPDATA_PATH = path.join(root, 'appdata');
process.env.AILY_NPM_PREFIX = path.dirname(installRoot);
process.env.AILY_CHILD_PATH = childRoot;
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { createBuildDebugPreview, resolvePreviewConfiguration, registerBuildDebugPreview } = require('../build-debug-preview');
const { nativeSubappRegistry, listChildToolHoldersForCatalogId, forceStopChildToolByCatalogId, getRunningSubappConfig } = require('../window');
const cmd = require('../cmd');
const result = { outcome: 'running', scope: 'installed-native-composition-not-agent-conversation', sourceAudit: false };
let window;
app.whenReady().then(async () => {
    try {
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: true,
            preload: path.join(__dirname, 'fixtures/build-delivery-preload.cjs') } });
        await window.loadURL('data:text/html,<title>Owned Runtime discovery acceptance</title>');
        const registry = { supervisor: nativeSubappRegistry.supervisor, register: (sender, input) => {
            const release = nativeSubappRegistry.register(sender, input);
            assert.ok(listChildToolHoldersForCatalogId('aily-simulator').some(holder => holder.toolId === 'simulator-debugger'));
            assert.equal(getRunningSubappConfig('aily-simulator'), null);
            return release;
        } };
        const preview = createBuildDebugPreview({ registry,
            configuration: () => resolvePreviewConfiguration({ childRoot, appData: path.join(root, 'evidence'), subappRoot: installRoot }) });
        registerBuildDebugPreview(ipcMain, { preview, isCurrentRenderer: sender => sender === window.webContents });
        const invoke = value => window.webContents.executeJavaScript(`window.buildTest.invoke('build-debug-preview',${JSON.stringify(value)})`);
        const start = Date.now();
        const description = await invoke({ action: 'describe', runtimeManifestPath: 'must-be-ignored' });
        result.discoveryMs = Date.now() - start;
        assert.equal(description.selection.source, 'installed');
        assert.equal(description.executionVerified, false);
        assert.equal(description.profiles[0].compatible, true);
        assert.equal(cmd.getActiveCmdProcesses().length, 0);
        result.description = description;
        const owner = { ...nativeSubappRegistry.supervisor.connect(window.webContents), ownerSessionId: 'owned-discovery-acceptance' };
        const report = await invoke({ action: 'run', requestId: randomUUID(), ...owner, manifestPath, scenario });
        fs.writeFileSync(path.join(root, 'native-report.json'), JSON.stringify(report, null, 2));
        assert.equal(report.outcome, 'passed', JSON.stringify(report.error));
        assert.equal(report.resultScope, 'supplied-firmware-snapshot');
        assert.equal(report.hostInputVerification, undefined);
        assert.equal(report.steps.length, scenario.steps.length);
        assert.ok(Object.values(report.cleanup.resources).every(value => value === 0));
        assert.equal(cmd.getActiveCmdProcesses().length, 0);
        assert.deepEqual(listChildToolHoldersForCatalogId('simulator-debugger'), []);
        assert.deepEqual(listChildToolHoldersForCatalogId('aily-simulator'), []);
        result.timingsMs = report.timingsMs; result.resources = report.cleanup.resources;
        // The existing Runtime uninstall/reinstall stop protocol cancels its
        // debugger consumer; it cannot delete an in-use package unnoticed.
        const pending = invoke({ action: 'run', requestId: randomUUID(), ...owner, manifestPath, scenario })
            .then(report => ({ report }), error => ({ error: String(error) }));
        const deadline = Date.now() + 10000;
        while (!listChildToolHoldersForCatalogId('aily-simulator').length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(listChildToolHoldersForCatalogId('aily-simulator').length);
        await forceStopChildToolByCatalogId('aily-simulator');
        const cancelled = await pending;
        assert.ok(cancelled.error || cancelled.report?.outcome === 'cancelled', JSON.stringify(cancelled));
        assert.equal(cmd.getActiveCmdProcesses().length, 0);
        assert.deepEqual(listChildToolHoldersForCatalogId('aily-simulator'), []);
        result.runtimeConsumerRelease = 'passed';
        result.report = path.join(root, 'native-report.json'); result.outcome = 'passed';
    } catch (error) { result.outcome = 'failed'; result.error = String(error.stack || error); }
    finally {
        window?.destroy(); await cmd.killAllCmdProcesses();
        fs.writeFileSync(path.join(root, 'native-verification.json'), JSON.stringify(result, null, 2));
        app.exit(result.outcome === 'passed' ? 0 : 1);
    }
});
