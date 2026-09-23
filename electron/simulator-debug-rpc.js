'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fault = (code, message) => Object.assign(new Error(message), { code });

/** Native host composition. connect is the installed Subapp's public transport
 * adapter; supervisor grants the existing acknowledged Agent owner capability.
 * The caller selects a firmware manifest; no build/source authority is required.
 */
async function bindSimulatorDebugRpc({ connect, endpoint, supervisor, sender, owner, manifestPath, signal, onProgress }) {
    const assertOwner = supervisor.createOwnerGuard(sender, owner);
    if (new URL(endpoint).origin !== assertOwner.runtime.origin) throw fault('SUBAPP_OWNER_EXPIRED', 'Host endpoint does not belong to the acknowledged Runtime.');
    if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) throw fault('INVALID_INPUT', 'An absolute artifact manifest path is required.');
    const bindingId = randomUUID(); let active, closed = false, peer, closePromise, watch, detachCleanup;
    const initialized = Promise.withResolvers(), connecting = new AbortController();
    const abortConnect = () => connecting.abort(signal.reason);
    signal?.addEventListener('abort', abortConnect, { once: true }); if (signal?.aborted) abortConnect();
    const check = () => { if (closed || peer?.closed) throw fault('SUBAPP_OWNER_EXPIRED', 'Host binding has ended.'); assertOwner(); };
    const cancel = reason => { if (active && !active.controller.signal.aborted) active.controller.abort(reason); };
    const destroy = () => { cancel(fault('SUBAPP_OWNER_EXPIRED', 'Host window ended.')); void close().catch(() => {}); };
    try {
        detachCleanup = assertOwner.attachCleanup(close);
        sender.once('destroyed', destroy);
        watch = setInterval(() => { try { check(); } catch (error) { cancel(error); void close().catch(() => {}); } }, 250);
        peer = await connect(endpoint, async () => {
            throw fault('RPC_METHOD_UNKNOWN', 'Debugger runs do not request source verification.');
        }, { signal: connecting.signal, onEvent: message => {
            if (message.event === 'simdebug.progress') {
                try { onProgress?.(message.data); } catch { /* Read-only observer. */ }
            }
        } });
        check();
        const bound = await peer.request('runtime.owner.bind', { bindingId, ownerSessionId: assertOwner.ownerSessionId, manifestPath }, { signal: connecting.signal });
        if (bound?.bound !== true || bound.bindingId !== bindingId || bound.currentProjectAcceptance !== false) throw fault('RPC_FAILED', 'Runtime did not acknowledge this exact binding.');
        check();
    } catch (error) { clearInterval(watch); sender.removeListener('destroyed', destroy); detachCleanup?.(); peer?.close(); await peer?.drain(); throw error; }
    finally { signal?.removeEventListener('abort', abortConnect); initialized.resolve(); }
    function close() {
        if (closePromise) return closePromise;
        closed = true; clearInterval(watch); sender.removeListener('destroyed', destroy);
        connecting.abort(fault('CANCELLED', 'Host binding closed.'));
        cancel(fault('CANCELLED', 'Host binding closed.'));
        closePromise = (async () => {
            await initialized.promise;
            if (active) await active.done?.catch(() => {});
            try { if (peer && !peer.closed) await peer.request('runtime.owner.release', { bindingId }, { timeoutMs: 5000 }); }
            finally { peer?.close(); await peer?.drain(); detachCleanup?.(); }
        })();
        return closePromise;
    }
    return {
        async run(scenario, { timeoutMs = 15 * 60 * 1000, signal } = {}) {
            check();
            if (active) throw fault('SESSION_BUSY', 'This owner already has an active run.');
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) throw fault('INVALID_INPUT', 'Invalid run budget.');
            const run = { id: randomUUID(), controller: new AbortController(), deadlineAt: Date.now() + timeoutMs }; active = run;
            const abort = () => cancel(typeof signal.reason?.code === 'string' ? signal.reason : fault('CANCELLED', 'Run cancelled.'));
            signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
            const deadlineAt = run.deadlineAt;
            const timer = setTimeout(() => cancel(fault('RUN_TIMEOUT', 'Host run deadline exceeded.')), timeoutMs);
            run.done = peer.request('simdebug.run', { bindingId, runId: run.id, deadlineAt, scenario },
                { signal: run.controller.signal, timeoutMs });
            try {
                const report = await run.done;
                await peer.drain();
                check();
                if (Date.now() >= deadlineAt) throw fault('RUN_TIMEOUT', 'Host run deadline exceeded.');
                if (report?.schemaVersion !== 1 || report.kind !== 'aily-firmware-debug-report'
                    || !['passed', 'failed', 'cancelled', 'error'].includes(report.outcome)) throw fault('RPC_FAILED', 'Invalid debugger report.');
                if (report.currentProjectAcceptance !== false || report.resultScope !== 'supplied-firmware-snapshot') {
                    throw fault('RPC_FAILED', 'Debugger report must describe the supplied firmware snapshot.');
                }
                return report;
            } finally {
                clearTimeout(timer); signal?.removeEventListener('abort', abort);
                await peer.drain(); active = undefined;
            }
        },
        close,
    };
}
module.exports = { bindSimulatorDebugRpc };
