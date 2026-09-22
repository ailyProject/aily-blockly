'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { launchPrivateRuntime } = require('./subapp-private-runtime');
const { bindSimulatorDebugRpc } = require('./simulator-debug-rpc');
const { resolveInstalledPackagePath, resolveSubappRoot } = require('./subapp-manager');
const { acquireInstallLock } = require('./subapp-install-lock');
const { getChildNodeExecutable } = require('./tools/managed-npm-cli');
const { resolveDebuggerRuntime } = require('./simulator-debug-runtime');
const fault = (code, message) => Object.assign(new Error(message), { code });
const TOOL_ID = 'simulator-debugger';

/** Native configuration only. Both packages use the existing installed store. */
function resolvePreviewConfiguration({ childRoot, appData, runtimeManifestPath, resourcesPath, subappRoot = resolveSubappRoot() }) {
    const release = acquireInstallLock(path.join(subappRoot, 'store', '.locks'));
    if (!release) throw fault('SUBAPP_BUSY', 'Subapp installation is in progress; retry after it completes.');
    try {
        const selected = resolveInstalledPackagePath(subappRoot, { id: TOOL_ID, package: '@aily-project/subapp-simulator-debugger' });
        if (selected.disabled || selected.selectionError) throw fault('SUBAPP_UNAVAILABLE', 'Debugger package selection is unavailable.');
        const root = fs.realpathSync(selected.packagePath), manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const entry = fs.realpathSync(path.resolve(root, manifest.main || 'index.js')), relative = path.relative(root, entry);
        if (manifest.name !== '@aily-project/subapp-simulator-debugger' || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw fault('SUBAPP_UNAVAILABLE', 'Invalid installed debugger package entry.');
        }
        let selectedRuntime;
        const runtime = () => selectedRuntime ||= resolveDebuggerRuntime({ runtimeManifestPath, subappRoot, resourcesPath });
        const { connectHostPeer: connect, describeRuntime, readEvidence } = require(entry);
        if (typeof connect !== 'function') throw fault('SUBAPP_UNAVAILABLE', 'Installed debugger does not provide the private host adapter.');
        let monitorPath;
        const monitor = path.join(root, 'ui', 'index.html');
        if (fs.existsSync(monitor)) {
            const resolved = fs.realpathSync(monitor), relative = path.relative(root, resolved);
            if (!relative.startsWith('..') && !path.isAbsolute(relative)) monitorPath = resolved;
        }
        return { node: getChildNodeExecutable(childRoot), entry, connect, credentialEnv: 'AILY_SIMDEBUG_HOST_TOKEN', release,
            monitorPath,
            get packageDependencies() { return runtime().source === 'installed' ? ['aily-simulator'] : []; },
            readEvidence: async params => {
                if (typeof readEvidence !== 'function') throw fault('SUBAPP_UPDATE_REQUIRED', 'Update Simulator Debugger to read saved evidence.');
                return readEvidence(path.join(appData, 'simulator-debugger/evidence'), params);
            },
            describe: async () => {
                if (typeof describeRuntime !== 'function') throw fault('SUBAPP_UPDATE_REQUIRED', 'Update Simulator Debugger to query Runtime capabilities.');
                return { ...(await describeRuntime(runtime().manifestPath)), selection: runtime() };
            },
            get args() { return ['serve', '--runtime-manifest', runtime().manifestPath, '--evidence-root', path.join(appData, 'simulator-debugger/evidence')]; } };
    } catch (error) { release(); throw error; }
}

/** Composition only: existing process registry, owner supervisor, artifact import
 * and installed Subapp. One L1 batch; no second persistent session manager. */
function createBuildDebugPreview({ registry, configuration, launch = launchPrivateRuntime, present }) {
    let active;
    return {
        async readEvidence(sender, input) {
            registry.supervisor.require(sender, input.owner?.generation);
            const config = configuration();
            try { return await config.readEvidence(input.params); }
            finally { config.release(); }
        },
        async describe() {
            const config = configuration();
            try { return await config.describe(); }
            finally { config.release(); }
        },
        async run(sender, input, { signal, timeoutMs = 15 * 60 * 1000 } = {}) {
            if (active) throw fault('SESSION_BUSY', 'A native debug batch is still running or cleaning up.');
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) throw fault('INVALID_INPUT', 'Invalid preview run budget.');
            if (typeof input.owner?.ownerSessionId !== 'string' || !input.owner.ownerSessionId.trim() || input.owner.ownerSessionId.length > 256) {
                throw fault('INVALID_INPUT', 'A native preview owner is required.');
            }
            registry.supervisor.require(sender, input.owner?.generation);
            if (typeof input.manifestPath !== 'string' || !path.isAbsolute(input.manifestPath)) {
                throw fault('INVALID_INPUT', 'An absolute artifact manifest path is required.');
            }
            const controller = new AbortController(), done = Promise.withResolvers(), deadline = Date.now() + timeoutMs;
            const run = { sender, id: input.requestId, controller }; active = run;
            const abort = () => controller.abort(fault('CANCELLED', 'Native debug batch cancelled.'));
            const destroyed = () => controller.abort(fault('SUBAPP_OWNER_EXPIRED', 'Native debug owner ended.'));
            const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) destroyed(); };
            sender.once('destroyed', destroyed); sender.once('render-process-gone', destroyed); sender.on('did-start-navigation', navigate);
            signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
            const timer = setTimeout(() => controller.abort(fault('RUN_TIMEOUT', 'Native debug deadline exceeded.')), timeoutMs);
            let runtime, binding, unregister, config, observer, terminal, tracked = false, stopped = false;
            const show = data => { try { observer?.update(data); } catch { /* UI is optional. */ } };
            const owner = { ...input.owner, toolId: TOOL_ID };
            try {
                controller.signal.throwIfAborted();
                config = configuration();
                try { observer = present?.(config.monitorPath, sender, abort, input.observer); } catch { /* UI failure cannot block firmware execution. */ }
                runtime = await launch({ ...config, signal: controller.signal, timeoutMs: Math.min(15000, timeoutMs) });
                controller.signal.throwIfAborted();
                unregister = registry.register(sender, { toolId: TOOL_ID, streamId: runtime.streamId, publicInfo: runtime.publicInfo,
                    packageDependencies: config.packageDependencies,
                    stop: async () => {
                        abort(); await done.promise;
                        await runtime.stop(); unregister?.();
                        if (active === run) active = undefined;
                    } });
                config.release(); config = undefined;
                await registry.supervisor.track(sender, owner); tracked = true;
                binding = await bindSimulatorDebugRpc({ connect: (_endpoint, handle, options) => runtime.connect(handle, options),
                    endpoint: runtime.publicInfo.wsUrl, supervisor: registry.supervisor,
                    sender, owner, manifestPath: input.manifestPath, signal: controller.signal, onProgress: data => {
                        if (data?.phase === 'finished') show({ ...data, phase: 'cleanup', outcome: 'running' });
                        else show(data);
                    } });
                controller.signal.throwIfAborted();
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw fault('RUN_TIMEOUT', 'Native debug deadline exceeded.');
                const report = await binding.run(input.scenario, { signal: controller.signal, timeoutMs: remaining });
                terminal = report;
                return report;
            } catch (error) {
                terminal = { outcome: error.code === 'CANCELLED' ? 'cancelled' : 'error',
                    error: { code: error.code, message: error.message } };
                throw error;
            } finally {
                show({ phase: 'cleanup', outcome: 'running' });
                // Stop the exact private Runtime even if RPC completion is lost.
                // Do not deregister a process whose termination is unconfirmed.
                try {
                    await binding?.close().catch(() => {});
                    try { await runtime?.stop(); }
                    catch (error) {
                        terminal = { outcome: 'error', cleanup: { failed: true },
                            error: { code: error.code, message: error.message } };
                        throw error;
                    }
                    stopped = true;
                    if (tracked) await registry.supervisor.release(sender, owner).catch(() => {});
                    unregister?.();
                } finally {
                    config?.release(); clearTimeout(timer);
                    signal?.removeEventListener('abort', abort); sender.removeListener('destroyed', destroyed);
                    sender.removeListener('render-process-gone', destroyed); sender.removeListener('did-start-navigation', navigate);
                    if (stopped || !runtime) active = undefined;
                    show({ ...terminal, phase: 'finished' });
                    done.resolve();
                }
            }
        },
        cancel(sender, requestId) {
            if (!active || active.sender !== sender || active.id !== requestId) return false;
            active.controller.abort(fault('CANCELLED', 'Native debug batch cancelled.')); return true;
        },
    };
}

function registerBuildDebugPreview(ipcMain, { isCurrentRenderer, preview, previewEnabled = true }) {
    const invoke = async (event, input = {}) => {
        if (!isCurrentRenderer(event.sender) || event.senderFrame !== event.sender.mainFrame) throw fault('RPC_FORBIDDEN', 'Native debug preview requires the current main frame.');
        if (input.action === 'describe') return preview.describe();
        if (input.action === 'evidence') return preview.readEvidence(event.sender, input);
        if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) throw fault('INVALID_INPUT', 'A unique request id is required.');
        if (input.action === 'cancel') return { cancelled: preview.cancel(event.sender, input.requestId) };
        if (input.action !== 'run') throw fault('INVALID_INPUT', 'Unknown debug preview action.');
        return preview.run(event.sender, { requestId: input.requestId, owner: { generation: input.generation, ownerSessionId: input.ownerSessionId },
            manifestPath: input.manifestPath, scenario: input.scenario, observer: input.observer }, { timeoutMs: input.timeoutMs });
    };
    if (previewEnabled) ipcMain.handle('build-debug-preview', invoke);
    // Preserve structured errors over Electron IPC; only this fixed adapter can
    // select a native tool. Package RPC metadata cannot choose executable paths.
    ipcMain.handle('subapp-native-agent', async (event, input = {}) => {
        try {
            if (input.toolId !== TOOL_ID) throw fault('SUBAPP_NATIVE_UNSUPPORTED', 'No native adapter is registered for this Subapp.');
            let request;
            if (input.action === 'cancel') request = { action: 'cancel', requestId: input.requestId };
            else if (input.action === 'call' && input.method === 'runtime.capabilities') request = { action: 'describe' };
            else if (input.action === 'call' && input.method === 'simdebug.evidence.read') {
                request = { action: 'evidence', owner: input.owner, params: input.params };
            }
            else if (input.action === 'call' && input.method === 'simdebug.run') {
                request = { action: 'run', requestId: input.requestId, generation: input.owner?.generation,
                    ownerSessionId: input.owner?.ownerSessionId, manifestPath: input.params?.manifestPath,
                    scenario: input.params?.scenario, timeoutMs: input.timeoutMs,
                    ...(typeof input.observer?.sessionId === 'string' ? { observer: {
                        sessionId: input.observer.sessionId.slice(0, 256), showWindow: false,
                    } } : {}) };
            } else throw fault('SUBAPP_NATIVE_UNSUPPORTED', 'Unsupported native batch method.');
            return { ok: true, result: await invoke(event, request) };
        } catch (error) {
            return { ok: false, error: error.message, errorCode: error.code || 'SUBAPP_RPC_FAILED', details: error.details };
        }
    });
}

module.exports = { createBuildDebugPreview, resolvePreviewConfiguration, registerBuildDebugPreview };
