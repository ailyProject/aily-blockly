'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SubappLocalSerialHost } = require('./subapp-local-serial-host');
function writeProtocols(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 1 || value.some(protocol => protocol !== 'monotonic-v1')) throw new Error('Serial write capability is unsupported');
    return value;
}

/** Uses the normal package manager's verified selection and update holder.
 * No renderer path, development-repository fallback, server or legacy serial
 * singleton participates in this resource acquisition. */
async function createInstalledBridge(prepareLaunch) {
    let prepared;
    try { prepared = await prepareLaunch({ id: 'serial-debugger', deferPreparedUpdate: true }); }
    catch (error) { throw Object.assign(error, { code: 'BRIDGE_UNAVAILABLE' }); }
    let bridge;
    try {
        const config = prepared.config;
        if (config?.catalogId !== 'serial-debugger' || config.packageName !== '@aily-project/subapp-serial-debugger') throw new Error('Serial runtime package mismatch');
        const root = fs.realpathSync(config.packagePath);
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (manifest.name !== config.packageName || manifest.version !== config.version) throw new Error('Serial runtime identity changed');
        const capability = manifest.ailySubapp?.runtime?.localSerialBackend;
        if (capability?.kind !== 'aily-local-serial-backend' || capability.apiVersion !== 1
            || capability.entry !== 'local-serial-backend.cjs') throw new Error('Serial runtime backend capability is unavailable');
        const entry = fs.realpathSync(path.join(root, 'local-serial-backend.cjs'));
        const relative = path.relative(root, entry);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(entry).isFile()) throw new Error('Serial runtime entry escapes package');
        const module = require(entry);
        if (module.LOCAL_SERIAL_BRIDGE_API_VERSION !== 1 || typeof module.createSessionSerialBridge !== 'function') throw new Error('Serial runtime update required');
        bridge = module.createSessionSerialBridge({ limits: { idleTimeoutMs: 30000 } });
        if (bridge?.apiVersion !== 1) throw new Error('Serial runtime factory API is unsupported');
        const declaredWrites = writeProtocols(capability.writeProtocols), actualWrites = writeProtocols(bridge.writeProtocols);
        if (declaredWrites.some(protocol => !actualWrites.includes(protocol))) throw new Error('Serial runtime write capability changed');
        for (const method of ['execute', 'listPorts', 'open', 'read', 'write', 'close', 'status', 'revokeOwner', 'dispose']) {
            if (typeof bridge?.[method] !== 'function') throw new Error('Serial runtime bridge is incomplete');
        }
        let disposed = false;
        const wrapped = { apiVersion: 1, writeProtocols: Object.freeze([...declaredWrites]) };
        for (const method of ['execute', 'listPorts', 'open', 'read', 'write', 'close', 'status', 'revokeOwner']) {
            wrapped[method] = bridge[method].bind(bridge);
        }
        wrapped.dispose = async () => {
            if (disposed) return;
            await bridge.dispose(); disposed = true; prepared.release();
        };
        return Object.freeze(wrapped);
    } catch (error) {
        // An invalid acquired resource still owns its cleanup. Retain it in a
        // fenced bridge (held by Main), rather than losing its update holder in
        // a rejected factory promise. Only cleanup can succeed on this object.
        if (bridge) {
            let released = false;
            const cleanup = async () => {
                if (released) return;
                if (typeof bridge.dispose !== 'function') throw new Error('Acquired serial cleanup is unavailable');
                await bridge.dispose(); prepared.release(); released = true;
            };
            try { await cleanup(); }
            catch {
                const unavailable = async () => { throw Object.assign(new Error('Serial runtime acquisition requires cleanup'), { code: 'BRIDGE_UNAVAILABLE' }); };
                return { execute: unavailable, listPorts: unavailable, open: unavailable, read: unavailable, write: unavailable,
                    close: unavailable, status: unavailable, revokeOwner: cleanup, dispose: cleanup };
            }
        } else prepared.release();
        throw Object.assign(error, { code: 'BRIDGE_UNAVAILABLE' });
    }
}

function registerLocalSerialHandlers({ ipcMain, getMainWindow, requireController, prepareLaunch, installHost,
    createBridge, confirmOpen }) {
    const host = new SubappLocalSerialHost({
        authorize(event, input) {
            const check = () => {
                const main = getMainWindow();
                if (!main || main.isDestroyed() || event.sender !== main.webContents || event.sender.isDestroyed()
                    || event.senderFrame !== event.sender.mainFrame || input.toolId !== 'simulator') throw new Error('Unauthorized hardware owner');
                requireController(event.sender.id, input);
            };
            check(); return check;
        },
        createBridge: createBridge || (() => createInstalledBridge(prepareLaunch)),
        confirmOpen: confirmOpen || (async ({ toolId, device, command }) => {
            const { dialog } = require('electron');
            const main = getMainWindow();
            if (!main || main.isDestroyed()) return false;
            const result = await dialog.showMessageBox(main, { type: 'question', buttons: ['取消', '连接'], defaultId: 0,
                cancelId: 0, noLink: true, title: '连接本机串口',
                message: `允许 ${toolId} 连接所选本机串口？`,
                detail: `${device.friendlyName || device.manufacturer || 'Serial device'}\n${device.path}\n${command.baudRate} baud · 8N1\n连接仅供当前仿真会话使用，不自动切换 DTR/RTS 或复位设备。` });
            return result.response === 1;
        }),
    });
    ipcMain.handle('subapp-local-serial', (event, input) => host.invoke(event, input));
    installHost(host);
    return host;
}

module.exports = { createInstalledBridge, registerLocalSerialHandlers };
