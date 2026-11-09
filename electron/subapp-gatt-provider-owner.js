'use strict';
const { randomUUID } = require('node:crypto');
const { createMainConnectivityProviderOwner } = require('./subapp-connectivity-provider-owner');
const { createMainGattNativeChooser } = require('./subapp-gatt-native-chooser');
const { loadInstalledMainGattComposition } = require('./subapp-gatt-installed-backend');

/** Main owns both optional installed packages and the Native selection owner.
 * The shared provider owns grants/drivers; the shared Main owner joins Runtime
 * detach and transport retirement before either installed holder is released. */
function createMainGattProviderOwner({ prepareLaunch, MessageChannelMain, resolveOriginalOwnerBluetoothControl,
    dialog, getMainWindow, onBindingRetired, onBindingState, onDiagnostic,
    loadComposition = loadInstalledMainGattComposition,
    limits = { maxLeases: 1, maxPendingRequests: 8, maxQueuedRecords: 16, maxQueuedBytes: 1024,
        maxReadRecords: 16, maxReadBytes: 256, maxPayloadBytes: 16, idleTimeoutMs: 30000 } }) {
    if (!Number.isSafeInteger(limits.maxPayloadBytes) || limits.maxPayloadBytes < 1 || limits.maxPayloadBytes > 20)
        throw new TypeError('This installed Native GATT profile supports short values up to 20 bytes');
    let activeNative = null;
    const selections = new WeakMap();
    const selectedBackend = selected => {
        const original = selections.get(selected);
        if (!original || original !== activeNative || original.fenced) throw new Error('Original selected GATT backend ended');
        return original.backend;
    };
    // The proxy is inert. Its exact selected objects keep their original
    // backend even when a later composition becomes current.
    const chooserBackend = {
        async scan(options, signal) {
            const original = activeNative;
            if (!original || original.fenced) throw new Error('Installed GATT scan owner is unavailable');
            const scan = await original.backend.scan(options, signal);
            return Object.freeze({ ready: scan.ready, snapshot: () => scan.snapshot(), close: () => scan.close(),
                select(candidateId) {
                    if (activeNative !== original || original.fenced) throw new Error('Original GATT scan owner ended');
                    const selected = scan.select(candidateId); selections.set(selected, original); return selected;
                } });
        },
        createDriver(selected) { return selectedBackend(selected).createDriver(selected); },
        releaseSelection(selected) {
            const original = selections.get(selected);
            if (original) { original.backend.releaseSelection(selected); selections.delete(selected); }
        },
    };
    const choosePeer = createMainGattNativeChooser({ dialog, getMainWindow, backend: chooserBackend });
    async function acquireComposition() {
        let installed, provider, native;
        let providerClosed = false, nativeClosed = false;
        const composition = {
            isCleanupRequest: request => request.operation === 'release',
            context(raw) {
                if (raw === null) return null;
                const value = installed.provider.module.validateSessionBluetoothContextSnapshot(raw);
                if (value.sessionState !== 'running' || value.sceneRevision === null || !value.bluetooth
                    || value.bluetooth.snapshot.state !== 'open' || !value.bluetooth.descriptor.controllerModes.includes('le')) return null;
                return value;
            },
            bind({ input, authority, requireCurrentAuthority, trustedContext, registerOwnerRelease, onGrantRetiring }) {
                return provider.bind({ authority: { ...authority, bindingId: input.producerId }, requireCurrentAuthority, trustedBluetoothContext: trustedContext,
                    choosePeer: async (value, signal) => {
                        try { return await input.choosePeer(value, signal, requireCurrentAuthority); }
                        catch (error) { try { onDiagnostic?.('choose-peer', error); } catch {} throw error; }
                    }, registerOwnerRelease, onGrantRetiring });
            },
            serve: input => installed.provider.module.serveHostGattMessagePort(input),
            attachment: (grant, descriptor) => ({ sessionId: grant.scope.sessionId, descriptor, grant }),
            async close() {
                if (native) native.fenced = true;
                const results = await Promise.allSettled([
                    Promise.resolve().then(async () => { if (!providerClosed && provider) { await provider.dispose(); providerClosed = true; } }),
                    Promise.resolve().then(async () => { if (!nativeClosed && native) { await native.backend.dispose(); nativeClosed = true; } }),
                ]);
                if (results.some(result => result.status === 'rejected')) throw new Error('Original GATT provider or Native cleanup remains unconfirmed');
                // Package holders cannot outlive unconfirmed OS resources in
                // reverse: both actual cleanups must succeed before release.
                await installed?.release();
                if (activeNative === native) activeNative = null;
            },
        };
        try {
            try { installed = await loadComposition(prepareLaunch); }
            catch (error) { if (error.retainedInstalledOwner) installed = error.retainedInstalledOwner; throw error; }
            const module = installed.provider.module;
            if (module.HOST_GATT_MESSAGE_PORT_DISPOSAL_SETTLEMENT_VERSION !== 1
                || module.HOST_GATT_MESSAGE_PORT_TERMINAL_RESULT_SETTLEMENT_VERSION !== 2
                || typeof module.serveHostGattMessagePort !== 'function') throw new Error('Installed GATT settlement API is unavailable');
            native = { backend: installed.native.module.createHostGattNativeBackend({ onScanDiagnostic(value) {
                // This private callback accepts fixed leaf facts only. No
                // exception, device, permission value or payload is forwarded.
                try {
                    const data = (object, key) => {
                        const property = object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key) : undefined;
                        return property && 'value' in property ? property.value : undefined;
                    };
                    const stages = { createRuntime: 'native-scan-create-runtime', prepare: 'native-scan-prepare',
                        onCandidate: 'native-scan-on-candidate', startScan: 'native-scan-start', retire: 'native-scan-retire' };
                    const categories = new Set(['unknown', 'lifecycle-capability-unavailable', 'runtime-ended',
                        'adapter-powered-off', 'adapter-unauthorized', 'adapter-unsupported', 'initialization-failed',
                        'scan-refused', 'scan-stop-unconfirmed', 'disposal-unconfirmed']);
                    const stage = data(value, 'stage');
                    const category = data(value, 'category');
                    if (typeof stage === 'string' && Object.hasOwn(stages, stage))
                        onDiagnostic?.(stages[stage], { scanCategory: categories.has(category) ? category : 'unknown' });
                } catch { /* Diagnostic failure cannot alter Native resource ownership. */ }
            } }), fenced: false };
            if (typeof native.backend?.scan !== 'function' || typeof native.backend.createDriver !== 'function'
                || typeof native.backend.releaseSelection !== 'function' || typeof native.backend.dispose !== 'function')
                throw new Error('Installed GATT Native owner API is incomplete');
            const descriptor = module.validateHostGattBackendDescriptorV1({ schemaVersion: 1,
                kind: 'aily-host-gatt-backend', backendId: 'aily.local-gatt.central.v1', capability: 'bluetooth.gatt',
                executionLocation: 'user-device', resourceLocation: 'user-device', permissionAuthority: 'local-user',
                availability: 'available', permissionState: 'prompt', unavailableReason: null, roles: ['central'],
                operations: ['discover', 'read', 'write-with-response', 'write-without-response', 'notify'],
                rawHci: false, classicSpp: false, limits });
            provider = module.createNodeHostGattProvider({ hostInstanceId: 'local-gatt:' + randomUUID(), descriptor,
                operationTimeoutMs: 30000 });
            activeNative = native;
            return composition;
        } catch (error) {
            try { await composition.close(); }
            catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Installed GATT composition remains owned'), { retainedComposition: composition }); }
            throw error;
        }
    }
    const owner = createMainConnectivityProviderOwner({ configured: !!choosePeer, MessageChannelMain,
        resolveOriginalOwnerControl: async input => {
            const control = await resolveOriginalOwnerBluetoothControl?.(input);
            if (!control || typeof control.attach !== 'function' || typeof control.detach !== 'function') return null;
            return control;
        }, acquireComposition, onBindingRetired, onBindingState, onDiagnostic });
    return Object.freeze({ ...owner, choosePeer });
}
module.exports = { createMainGattProviderOwner };
