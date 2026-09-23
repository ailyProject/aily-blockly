'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { SubappOwnerSupervisor, registerSubappOwnerSupervisor } = require('../../subapp-owner-supervisor');
const { SubappOwnerProcessLeases } = require('../../subapp-owner-process-lease');
const root = process.env.SUBAPP_CRASH_FIXTURE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Isolated test root required');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.env.SERIAL_SUBAPP_ROOT, 'agent/tools.json')));
    const runtime = JSON.parse(fs.readFileSync(process.env.SUBAPP_CRASH_DESCRIPTOR));
    const window = new BrowserWindow({ show: false, webPreferences: {
        preload: path.resolve(__dirname, '../../preload.js'), contextIsolation: true, sandbox: false,
    } });
    const supervisor = new SubappOwnerSupervisor({ processLeases: new SubappOwnerProcessLeases(root),
        resolveRuntime: (_tool, renderer) => renderer === window.webContents.id ? {
            streamId: 'external-fixture-daemon', hostInfo: { ...runtime, runtimeConfig: { agent: manifest } },
        } : null });
    registerSubappOwnerSupervisor(ipcMain, supervisor);
    await window.loadFile(path.join(__dirname, 'subapp-owner.html'));
    const ownerSessionId = process.env.SUBAPP_CRASH_OWNER;
    const result = await window.webContents.executeJavaScript(`(async () => {
        const api = window.electronAPI.childToolSession.superviseOwner;
        const connected = await api({action:'connect'});
        return await api({action:'track',generation:connected.generation,toolId:'serial-debugger',ownerSessionId:${JSON.stringify(ownerSessionId)}});
    })()`);
    if (!result.ok) throw new Error(JSON.stringify(result));
    fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ pid: process.pid, ownerSessionId, context: result.context }));
}).catch(error => { console.error(error); app.exit(1); });
