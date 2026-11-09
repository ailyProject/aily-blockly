'use strict';
const { createMainGattHostBoundary } = require('./subapp-gatt-host-boundary');
const { createMainGattProviderOwner } = require('./subapp-gatt-provider-owner');

const nativeScanStages = new Set(['native-scan-create-runtime', 'native-scan-prepare', 'native-scan-on-candidate',
    'native-scan-start', 'native-scan-retire']);
const nativeScanCategories = new Set(['unknown', 'lifecycle-capability-unavailable', 'runtime-ended',
    'adapter-powered-off', 'adapter-unauthorized', 'adapter-unsupported', 'initialization-failed',
    'scan-refused', 'scan-stop-unconfirmed', 'disposal-unconfirmed']);
const diagnosticStages = new Set(['resolve-original-owner-control', 'acquire-composition', 'query-context', 'bind',
    'choose-peer', 'installed-protocol', 'ipc-non-typed', 'ipc-negative', 'ipc-exception', ...nativeScanStages]);
const diagnosticCodes = new Set(['invalid-input', 'unavailable', 'permission-denied', 'lease-revoked', 'stale-scope',
    'cleanup-unconfirmed', 'cancelled', 'timeout', 'backpressure', 'request-replayed', 'ENOENT', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND',
    'backend-ended', 'invalid-signal', 'invalid-scan', 'scan-owned']);
// Only fixed product messages are retained. Arbitrary errors can contain
// addresses, paths, selected peer names or tokens, so their text is redacted.
const diagnosticMessages = new Set(['Main connectivity owner is unavailable.', 'Original connectivity control is unavailable.',
    'Original connectivity context is unavailable.', 'Original registered Browser owner is unavailable',
    'Original private Browser owner acknowledgement is unavailable', 'Original Browser network admission has ended',
    'Execution lifecycle request failed', 'Normal Main connectivity owner has ended',
    'Installed GATT package identity changed', 'Installed GATT package version changed', 'Installed GATT capability is unavailable',
    'Installed GATT entry escapes its package', 'Installed GATT module API is incomplete', 'Installed GATT settlement API is unavailable',
    'Installed GATT Native owner API is incomplete', 'Installed GATT composition remains owned',
    'Invalid Session Bluetooth context identity.', 'Invalid Session Bluetooth context data.',
    'Session Bluetooth context has inconsistent actual clock facts.', 'Session Bluetooth context data exceeds its bound.',
    'Session Bluetooth context requires plain data.', 'Session Bluetooth context accessors are forbidden.',
    'Core Bluetooth context is changing.', 'Original Core Bluetooth engine is not running.',
    'Original Host GATT Runner changed.', 'Core Bluetooth owner or actual port context changed during the query.',
    'Original GATT chooser authority is required', 'A local Bluetooth selection is already open',
    'Original GATT chooser window ended', 'Invalid GATT chooser response',
    'Installed GATT scan API is incomplete', 'Installed GATT scan owner is unavailable', 'Original network owner ended']);
const ownData = (value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && 'value' in property ? property.value : undefined;
};

/** Explicit local opt-in only. A new private file is created lazily on the first
 * failure; old logs, symlinks and files outside the task log root are refused.
 * It never serializes arbitrary error properties or request/result values. */
function createGattAdmissionDiagnostic({ file } = {}) {
    if (!file) return Object.assign(() => {}, { close() {} });
    const fs = require('node:fs'), path = require('node:path'), root = '/Volumes/data/aily-work/logs';
    let fd = null, ended = false, records = 0;
    const valid = typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file
        && file.startsWith(root + '/') && /^gatt-admission[-a-z0-9]*\.ndjson$/u.test(path.basename(file));
    const write = (stage, error) => {
        if (ended || !valid || !diagnosticStages.has(stage) || records >= 128) return;
        try {
            if (fd === null) {
                let parent = root;
                for (const part of path.relative(root, path.dirname(file)).split('/').filter(Boolean)) {
                    const existing = fs.lstatSync(parent); if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error();
                    parent = path.join(parent, part);
                    try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
                }
                const existing = fs.lstatSync(parent); if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error();
                fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            }
            if (nativeScanStages.has(stage)) {
                const category = ownData(error, 'scanCategory');
                fs.writeSync(fd, JSON.stringify({ schemaVersion: 1, kind: 'aily-main-gatt-admission-diagnostic',
                    at: new Date().toISOString(), stage, scanCategory: nativeScanCategories.has(category) ? category : 'unknown' }) + '\n');
                records++; return;
            }
            const message = ownData(error, 'message'), name = ownData(error, 'name');
            const code = ownData(error, 'connectivityCode') ?? ownData(error, 'code');
            const errorName = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'HostGattLedgerError', 'BrowserExecutionError', 'AbortError'].includes(name)
                ? name : error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error instanceof SyntaxError ? 'SyntaxError' : 'Error';
            const row = { schemaVersion: 1, kind: 'aily-main-gatt-admission-diagnostic', at: new Date().toISOString(), stage,
                errorName, message: diagnosticMessages.has(message) ? message : '[message redacted]',
                errorCode: diagnosticCodes.has(code) ? code : null };
            fs.writeSync(fd, JSON.stringify(row) + '\n'); records++;
        } catch { ended = true; if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; } }
    };
    write.close = () => { ended = true; if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; } };
    return write;
}

async function loadInstalledGattProtocol() {
    return { ...await import('@aily-project/simulator-protocol/connectivity-gatt-provider'),
        ...await import('@aily-project/simulator-protocol/connectivity-host') };
}
function registerMainGattHostHandlers({ ipcMain, dialog, getMainWindow, requireController, installHost,
    prepareLaunch, MessageChannelMain, resolveOriginalOwnerBluetoothControl, loadProtocol = loadInstalledGattProtocol,
    diagnosticPath = process.env.AILY_W8_GATT_ADMISSION_DIAGNOSTIC_PATH,
    onError = message => console.warn('[LocalGatt]', message) }) {
    if (typeof ipcMain?.handle !== 'function' || typeof installHost !== 'function')
        throw new TypeError('Normal Main GATT IPC composition is unavailable');
    let host = null, owner = null, disposed = false;
    const diagnostic = createGattAdmissionDiagnostic({ file: diagnosticPath });
    const ready = Promise.resolve().then(async () => {
        const protocol = await loadProtocol();
        owner = createMainGattProviderOwner({ dialog, getMainWindow, prepareLaunch, MessageChannelMain,
            resolveOriginalOwnerBluetoothControl, onDiagnostic: diagnostic,
            onBindingRetired(authority) {
                host?.retireProducer(authority);
                const main = getMainWindow();
                if (main && !main.isDestroyed() && !main.webContents.isDestroyed() && main.webContents.id === authority.senderId)
                    main.webContents.send('subapp-local-gatt-lifetime-ended', { toolId: authority.toolId,
                        streamId: authority.streamId, bindingId: authority.bindingId, producerId: authority.producerId });
            },
            onBindingState: value => host?.observeProducerPhase(value.authority, value.phase) });
        host = createMainGattHostBoundary({ protocol, getMainWindow, requireController, choosePeer: owner.choosePeer,
            resolveOriginalOwnerGattPort: input => owner.bind(input) });
        if (disposed) { await host.dispose(); await owner.dispose(); }
        return host;
    }).catch(error => { diagnostic('installed-protocol', error); onError('installed-gatt-module-unavailable'); throw error; });
    void ready.catch(() => undefined);
    const withHost = async action => {
        let value;
        try { value = await ready; } catch (error) { if (!host) return; throw error; }
        return action(value);
    };
    ipcMain.handle('subapp-local-gatt', async (event, input) => {
        try {
            const result = await (await ready).invoke(event, input), kind = ownData(result, 'kind');
            if (kind === 'aily-main-gatt-ipc-error') diagnostic('ipc-non-typed', { code: ownData(result, 'errorCode') });
            else if (kind === 'aily-host-gatt-bound-provider-result') {
                const inner = ownData(result, 'result');
                if (ownData(inner, 'ok') === false) diagnostic('ipc-negative', { code: ownData(inner, 'errorCode') });
            } else if (kind !== 'aily-main-gatt-producer-state' && ownData(result, 'ok') !== true) diagnostic('ipc-non-typed', null);
            return result;
        } catch (error) { diagnostic('ipc-exception', error); return { kind: 'aily-main-gatt-ipc-error', ok: false, errorCode: 'unavailable' }; }
    });
    const original = Object.freeze({
        closeBinding: authority => withHost(value => value.closeBinding(authority)),
        closeRuntime: streamId => withHost(value => value.closeRuntime(streamId)),
        closeSender: senderId => withHost(value => value.closeSender(senderId)),
        async dispose() {
            disposed = true;
            const result = await Promise.allSettled([withHost(value => value.dispose()), owner?.dispose()]);
            if (result.some(value => value.status === 'rejected')) throw new Error('Original GATT resources remain unconfirmed');
            diagnostic.close();
        },
    });
    installHost(original);
    return original;
}
module.exports = { registerMainGattHostHandlers, loadInstalledGattProtocol, createGattAdmissionDiagnostic };
