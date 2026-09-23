'use strict';
// Isolated hidden Electron process. Fake serial ports only; no user app/profile is reused.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const esbuild = require('esbuild');
const { SubappOwnerSupervisor, registerSubappOwnerSupervisor } = require('../subapp-owner-supervisor');
const { acquireOwner, releaseOwnerFromSessions, hasOwnerId } = require('../child-tool-session-leases');
const root = path.resolve(__dirname, '../..');
const serialRoot = process.env.SERIAL_SUBAPP_ROOT || path.resolve(root, '../aily-subapp/packages/serial-debugger');
const serialRequire = createRequire(path.join(serialRoot, 'package.json'));
const { startSerialDebuggerServer } = serialRequire('./server');
const { FakeSerialPort } = serialRequire('./test/fake-serial-port');
const manifest = serialRequire('./agent/tools.json');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'subapp-owner-electron-'));
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const windows = [];
let runtime;

async function run() {
    FakeSerialPort.reset();
    FakeSerialPort.ports = ['SIM_A', 'SIM_B'].map(port => ({ path: port }));
    runtime = await startSerialDebuggerServer({ host: '127.0.0.1', port: 0, token: 'supervision-test',
        journal: false, SerialPortClass: FakeSerialPort, runtimeRoot: output });
    const runtimeConfig = { id: 'serial-debugger', namespace: 'SERIAL', titleKey: 'Serial', agent: {
        ...manifest, tools: manifest.tools.map(tool => ({ ...tool, presentation: undefined })),
    } };
    const session = { streamId: 'isolated-runtime', owners: new Map(), hostInfo: { wsUrl: runtime.wsUrl, runtimeConfig } };
    const sessions = new Map([['serial-debugger', session]]);
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: (_toolId, ownerId) => hasOwnerId(session, ownerId) ? session : null });
    registerSubappOwnerSupervisor(ipcMain, supervisor);
    const bundle = await esbuild.build({ stdin: { contents: [
        "export { SubappAgentBridgeService } from './src/app/services/integrations/subapps/subapp-agent-bridge.service';",
        "export { replaceChildToolConfigs } from './src/app/configs/tool.config';",
    ].join('\n'), resolveDir: root, loader: 'ts' }, bundle: true, platform: 'browser', format: 'iife',
    globalName: 'fixture', write: false, plugins: [{ name: 'angular-stub', setup(builder) {
        builder.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents:
            'export const Injectable = () => target => target; export const Inject = () => () => {}; export class InjectionToken {}' }));
    } }] });

    const createWindow = async () => {
        const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'),
            contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false } });
        windows.push(window);
        acquireOwner(session, window.webContents.id, 'test-runtime-ref');
        window.webContents.on('render-process-gone', () => releaseOwnerFromSessions(sessions, window.webContents.id));
        let preloadError;
        window.webContents.on('preload-error', (_event, _file, error) => { preloadError = error; });
        await window.loadFile(path.join(__dirname, 'fixtures/subapp-owner.html'));
        assert.ifError(preloadError);
        assert.equal(await window.webContents.executeJavaScript('typeof window.electronAPI?.childToolSession?.superviseOwner'), 'function', 'production preload must expose owner supervision');
        await window.webContents.executeJavaScript(bundle.outputFiles[0].text + '\nvoid 0;');
        await window.webContents.executeJavaScript(`
            fixture.replaceChildToolConfigs([${JSON.stringify(runtimeConfig)}]);
            window.bridge = new fixture.SubappAgentBridgeService({
                acquire: async () => (${JSON.stringify(session.hostInfo)}), release: async () => {}
            }, {}, {recordInvocationStarted(){},recordInvocationCompleted(){},recordRuntimeState(){},releaseSession(){}});
            void 0;
        `);
        return window;
    };
    const call = (window, body) => window.webContents.executeJavaScript(`(async () => { ${body} })()`);
    const open = async (window, logicalId, port, channelId) => {
        const result = await call(window, `window.owner = await bridge.manageOwnerLease({action:'acquire',sessionId:${JSON.stringify(logicalId)}});
            if (!owner.ok) throw new Error(JSON.stringify(owner));
            return await bridge.execute({toolId:'serial-debugger',tool:'serial_session_manage',params:${JSON.stringify({ action: 'open', path: port, channelId, baudRate: 115200, dtrOnOpen: false })}},
              undefined,{sessionId:owner.sessionId,ownerLeaseId:owner.ownerLeaseId,toolCallId:'open'});`);
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.result.channelId;
    };
    const a = await createWindow();
    const b = await createWindow();
    const channelA = await open(a, 'chat-a', 'SIM_A');
    const channelB = await open(b, 'chat-b', 'SIM_B');
    assert.equal(supervisor.renderers.get(a.webContents.id)?.bindings.size, 1, 'owner binding must precede serial open');
    await runtime.core.connect({ channelId: channelB, port: 'SIM_B' }, { actor: 'ui', actorId: 'manual-user' });
    const before = runtime.core.status({ channelId: channelB }).connectedAt;
    const crashed = once(a.webContents, 'render-process-gone');
    a.webContents.forcefullyCrashRenderer();
    await crashed;
    await supervisor.idle();
    assert.equal(runtime.core.status({ channelId: channelA }).connected, false);
    assert.equal(runtime.core.status({ channelId: channelB }).connected, true);
    assert.equal(runtime.core.status({ channelId: channelB }).connectedAt, before);
    assert.equal(runtime.core.status({ channelId: channelB }).ownerCount, 2);
    const released = await call(b, 'return await bridge.manageOwnerLease({action:"release",...owner});');
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(runtime.core.status({ channelId: channelB }).ownerCount, 1);
    assert.equal(runtime.core.status({ channelId: channelB }).connected, true);
    const c = await createWindow();
    await open(c, 'chat-a', 'SIM_A', channelA);
    const navigated = once(c.webContents, 'did-finish-load');
    c.webContents.reload();
    await navigated;
    await supervisor.idle();
    assert.equal(runtime.core.status({ channelId: channelA }).connected, false);
    assert.equal(runtime.core.status({ channelId: channelB }).connected, true);
    return { ok: true, output, checks: ['actual-preload', 'bind-before-RPC', 'renderer-crash', 'independent-owner', 'UI-retained', 'normal-release', 'reopen', 'reload'] };
}

app.whenReady().then(async () => {
    let code = 0;
    try { console.log(JSON.stringify(await run())); }
    catch (error) { console.error(error); code = 1; }
    finally {
        for (const window of windows) if (!window.isDestroyed()) window.destroy();
        await runtime?.stop();
        app.exit(code);
    }
}).catch(error => { console.error(error); app.exit(1); });
