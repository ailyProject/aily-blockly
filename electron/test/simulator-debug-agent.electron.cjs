'use strict';
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { installRoot, childRoot, manifestPath, scenario, lexRoot, config } = settings;
const root = process.env.AILY_TEST_MONITOR_LANGUAGE ? path.join(settings.root, 'language-check') : settings.root;
fs.mkdirSync(root, { recursive: true });
process.env.AILY_APPDATA_PATH = path.join(root, 'agent-appdata');
process.env.AILY_NPM_PREFIX = path.dirname(installRoot); process.env.AILY_CHILD_PATH = childRoot;
app.setPath('userData', path.join(root, 'agent-profile')); app.disableHardwareAcceleration();
if (process.env.AILY_TEST_MONITOR_LANGUAGE) app.commandLine.appendSwitch('lang', process.env.AILY_TEST_MONITOR_LANGUAGE);
app.on('window-all-closed', () => {});
const { createBuildDebugPreview, resolvePreviewConfiguration, registerBuildDebugPreview } = require('../build-debug-preview');
const { registerSubappOwnerSupervisor } = require('../subapp-owner-supervisor');
const { nativeSubappRegistry, listChildToolHoldersForCatalogId } = require('../window');
const { bundleAgentBridge, loadAgentClient } = require('./fixtures/subapp-agent-test-build.cjs');
const { createDebugMonitorPresenter } = require('../simulator-debug-monitor');
const cmd = require('../cmd');
const result = { outcome: 'running', scope: 'production-agent-client-and-bridge-native-composition-not-chat-ui-or-llm', checks: [] };
let window, monitor, clients = [];
async function until(probe) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Agent native checkpoint timed out');
}
app.whenReady().then(async () => {
    try {
        const { SubappAgentSession, discoverInstalledSubappAgentCatalog } = await loadAgentClient(lexRoot);
        for (const developmentMode of ['blockly', 'coder']) {
            const catalog = discoverInstalledSubappAgentCatalog({ env: { AILY_NPM_PREFIX: path.dirname(installRoot) }, developmentMode });
            assert.deepEqual(catalog.tools.filter(tool => tool.toolId === 'simulator-debugger').map(tool => tool.name).sort(),
                ['simulator_debug_capabilities', 'simulator_debug_evidence', 'simulator_debug_run']);
        }
        result.checks.push('real-Lex-catalog-discovers-both-modes');
        window = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: true,
            preload: path.join(__dirname, 'fixtures/subapp-native-agent-preload.cjs') } });
        await window.loadFile(path.join(__dirname, 'fixtures/subapp-native-agent.html'));
        registerSubappOwnerSupervisor(ipcMain, nativeSubappRegistry.supervisor);
        const present = createDebugMonitorPresenter(BrowserWindow, { visible: false, ipcMain });
        registerBuildDebugPreview(ipcMain, { previewEnabled: false, isCurrentRenderer: sender => sender === window.webContents,
            preview: createBuildDebugPreview({ registry: nativeSubappRegistry,
                present: (file, sender, stop) => {
                    assert.ok(file.endsWith(path.join('ui', 'index.html')));
                    const observer = present(file, sender, stop);
                    monitor = BrowserWindow.getAllWindows().find(candidate => candidate !== window);
                    return observer;
                },
                configuration: () => resolvePreviewConfiguration({ childRoot, subappRoot: installRoot, appData: path.join(root, 'agent-evidence') }) }) });
        await window.webContents.executeJavaScript(await bundleAgentBridge(true));
        await window.webContents.executeJavaScript(`(() => {
            AgentBridgeFixture.replaceChildToolConfigs([${JSON.stringify(config)}]);
            const forbidden = () => { throw new Error('Headless calls must not use UI runtime/presentation'); };
            window.agentBridge = new AgentBridgeFixture.SubappAgentBridgeService({acquire:forbidden,release:forbidden},
                {openChildApp:forbidden,isChildAppWindowOpen:forbidden},
                {recordInvocationStarted(){},recordInvocationCompleted(){},recordRuntimeState(){},releaseSession(){}});
            window.agentDispatch = (operation, params) => operation === 'subapp_agent_owner'
                ? agentBridge.manageOwnerLease(params)
                : agentBridge.execute(params, undefined, {sessionId:params.sessionId,ownerLeaseId:params.ownerLeaseId,
                    toolCallId:params.requestId,workspaceRoot:params.context?.workspaceRoot,developmentMode:params.context?.developmentMode});
        })()`);
        const createClient = () => {
            const client = new SubappAgentSession(async (operation, params, options) => {
                options.onTarget?.({ id: 'owned-hidden-renderer' });
                return window.webContents.executeJavaScript(`window.agentDispatch(${JSON.stringify(operation)},${JSON.stringify(params)})`);
            }); clients.push(client); return client;
        };
        const input = tool => ({ toolId: 'simulator-debugger', tool, sessionId: 'owned-agent-session', requestId: randomUUID(),
            params: tool === 'simulator_debug_run' ? { manifestPath, scenario } : {},
            context: { workspaceRoot: path.join(root, 'different-current-project'), developmentMode: 'coder' } });
        const client = createClient();
        const capabilities = await client.call(input('simulator_debug_capabilities'));
        assert.equal(capabilities.ok, true); assert.equal(capabilities.result.executionVerified, false);
        assert.equal(cmd.getActiveCmdProcesses().length, 0);
        const runningBatch = client.call(input('simulator_debug_run'));
        await until(async () => monitor && !monitor.webContents.isLoading()
            && await monitor.webContents.executeJavaScript("document.getElementById('phase')?.textContent.includes('QEMU')"));
        assert.equal(await monitor.webContents.executeJavaScript('typeof window.electronAPI'), 'undefined');
        assert.equal(await monitor.webContents.executeJavaScript('typeof require'), 'undefined');
        const response = await runningBatch;
        assert.equal(response.ok, true, JSON.stringify(response));
        const report = response.result;
        assert.equal(report.outcome, 'passed', JSON.stringify(report.error));
        assert.equal(report.resultScope, 'supplied-firmware-snapshot');
        assert.equal(report.steps.length, scenario.steps.length);
        const readSaved = file => client.call({ ...input('simulator_debug_evidence'), params: { runId: report.evidence.runId, file, limitBytes: 512 } });
        for (const file of ['report', 'events']) {
            const saved = await readSaved(file);
            assert.equal(saved.ok, true, JSON.stringify(saved));
            assert.equal(saved.result.text, fs.readFileSync(path.join(report.evidence.directory, file === 'report' ? 'report.json' : 'events.jsonl')).subarray(0, saved.result.nextOffsetBytes).toString('utf8'));
            assert.equal(cmd.getActiveCmdProcesses().length, 0);
        }
        result.checks.push('saved-report-and-events-without-runtime');
        assert.ok(Object.values(report.cleanup.resources).every(value => value === 0));
        fs.writeFileSync(path.join(root, 'agent-report.json'), JSON.stringify(report, null, 2));
        result.timingsMs = report.timingsMs;
        result.checks.push('actual-Agent-client-owner-lease-and-renderer-bridge', 'one-batch-real-QEMU-with-cross-project-firmware');
        await until(() => monitor.webContents.executeJavaScript("document.getElementById('status').dataset.outcome === 'passed'"));
        const displayed = await monitor.webContents.executeJavaScript(`({uart:document.getElementById('uart').textContent,
            steps:document.querySelectorAll('#steps li[data-outcome="passed"]').length, text:document.body.innerText,
            overflow:document.documentElement.scrollWidth > window.innerWidth})`);
        assert.ok(displayed.uart.includes('READY')); assert.equal(displayed.steps, report.steps.length); assert.equal(displayed.overflow, false);
        assert.ok(displayed.text.includes(report.evidence.directory));
        // A hidden window can retain a stale compositor frame even after DOM
        // assertions pass. Paint the real view before taking visual evidence.
        monitor.showInactive();
        await monitor.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        for (const theme of ['light', 'dark']) {
            nativeTheme.themeSource = theme;
            await until(() => monitor.webContents.executeJavaScript(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`));
            await monitor.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            assert.equal(await monitor.webContents.executeJavaScript("getComputedStyle(document.documentElement).backgroundColor"),
                theme === 'dark' ? 'rgb(17, 24, 32)' : 'rgb(248, 250, 252)');
            fs.writeFileSync(path.join(root, `debug-monitor-${theme}.png`), (await monitor.webContents.capturePage()).toPNG());
        }
        monitor.webContents.reload();
        await until(() => !monitor.webContents.isLoading() && monitor.webContents.executeJavaScript("document.getElementById('status')?.dataset.outcome === 'passed'"));
        assert.ok(await monitor.webContents.executeJavaScript("document.getElementById('uart').textContent.includes('READY') && document.getElementById('stop').disabled"));
        const language = await monitor.webContents.executeJavaScript('document.documentElement.lang');
        result.monitorLanguage = language;
        if (process.env.AILY_TEST_MONITOR_LANGUAGE) assert.equal(language, process.env.AILY_TEST_MONITOR_LANGUAGE.startsWith('zh') ? 'zh-CN' : 'en');
        result.checks.push('real-monitor-live-progress-final-result-no-node-and-theme-and-late-reload');
        const bad = input('simulator_debug_run');
        bad.params.scenario = { schemaVersion: 1, timeoutMs: 1000, steps: [{ id: 'resume', op: 'resume' },
            { id: 'missing', op: 'uart.expect', contains: 'DELIBERATELY_MISSING_ACCEPTANCE_MARKER' }] };
        const failed = await client.call(bad);
        assert.equal(failed.ok, true); assert.equal(failed.result.outcome, 'failed'); assert.equal(failed.result.error.code, 'EXPECT_TIMEOUT');
        await until(() => !monitor.webContents.isLoading() && monitor.webContents.executeJavaScript("document.getElementById('status')?.dataset.outcome === 'failed'"));
        assert.equal(cmd.getActiveCmdProcesses().length, 0);
        result.checks.push('one-call-failed-assertion-shown-as-failed-not-transport-success');
        if (settings.adc) {
            const request = input('simulator_debug_run');
            request.params = settings.adc;
            const adcResponse = await client.call(request);
            assert.equal(adcResponse.ok, true, JSON.stringify(adcResponse));
            assert.equal(adcResponse.result.outcome, 'passed', JSON.stringify(adcResponse.result));
            assert.equal(adcResponse.result.steps.filter(step => step.stimulus).length, 5);
            assert.ok(Object.values(adcResponse.result.cleanup.resources).every(value => value === 0));
            await until(() => !monitor.webContents.isLoading() && monitor.webContents.executeJavaScript("document.getElementById('status')?.dataset.outcome === 'passed'"));
            const text = await monitor.webContents.executeJavaScript("document.getElementById('values').textContent");
            assert.ok(text.includes('raw=2048')); assert.ok(text.includes('ADC1 CH0 (GPIO1)'));
            assert.ok(text.includes('非测量结果') || text.includes('not a measurement'));
            fs.writeFileSync(path.join(root, 'agent-adc-report.json'), JSON.stringify(adcResponse.result, null, 2));
            monitor.showInactive();
            await monitor.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
            fs.writeFileSync(path.join(root, 'debug-monitor-adc.png'), (await monitor.webContents.capturePage()).toPNG());
            result.checks.push('one-agent-batch-adc-inputs-fresh-firmware-readings-and-ui');
        }
        for (const mode of ['ui-stop', 'cancel', 'session-close']) {
            const controller = new AbortController();
            const running = client.call(input('simulator_debug_run'), controller.signal).then(value => ({ value }), error => ({ error: String(error) }));
            await until(() => listChildToolHoldersForCatalogId('simulator-debugger').length > 0);
            if (mode === 'ui-stop') {
                await until(() => !monitor.webContents.isLoading() && monitor.webContents.executeJavaScript("document.getElementById('stop')?.disabled === false"));
                await monitor.webContents.executeJavaScript("document.getElementById('stop').click()");
            } else {
                // Closing the optional view must leave ownership and execution intact.
                monitor?.destroy();
                assert.ok(listChildToolHoldersForCatalogId('simulator-debugger').length > 0);
                if (mode === 'cancel') controller.abort(); else await client.close();
            }
            const stopped = await running;
            assert.ok(stopped.error || stopped.value?.ok === false, JSON.stringify(stopped));
            assert.equal(cmd.getActiveCmdProcesses().length, 0);
            assert.deepEqual(listChildToolHoldersForCatalogId('aily-simulator'), []);
            if (mode === 'ui-stop') {
                await until(() => monitor.webContents.executeJavaScript("document.getElementById('status').dataset.outcome === 'cancelled'"));
                assert.equal(await monitor.webContents.executeJavaScript("document.getElementById('stop').disabled"), true);
            }
            result.checks.push(`${mode}-joins-native-cleanup`);
        }
        // A new incarnation of the same logical conversation gets a new lease.
        const reopened = createClient();
        assert.equal((await reopened.call(input('simulator_debug_capabilities'))).ok, true);
        await reopened.close(); result.checks.push('same-logical-session-can-reopen-with-new-owner');
        assert.equal(cmd.getActiveCmdProcesses().length, 0);
        result.outcome = 'passed';
    } catch (error) { result.outcome = 'failed'; result.error = String(error.stack || error); }
    finally {
        await Promise.all(clients.map(client => client.close().catch(() => {})));
        if (window && !window.isDestroyed()) await window.webContents.executeJavaScript('window.agentBridge?.ngOnDestroy()').catch(() => {});
        window?.destroy(); await cmd.killAllCmdProcesses();
        for (const view of BrowserWindow.getAllWindows()) view.destroy();
        fs.writeFileSync(path.join(root, 'agent-verification.json'), JSON.stringify(result, null, 2));
        app.exit(result.outcome === 'passed' ? 0 : 1);
    }
});
