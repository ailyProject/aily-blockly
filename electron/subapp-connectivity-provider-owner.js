'use strict';
const { adaptMainNetworkMessagePort } = require('./subapp-network-installed-backend');

/** One Main lifecycle owner shared by installed connectivity compositions.
 * Each composition supplies its own typed policy/provider/transport; this owner
 * joins the original Runtime detach, actual backend, ports and package holders.
 * A thrown acquire must own no resources, or publish retainedComposition. */
function createMainConnectivityProviderOwner({ MessageChannelMain, configured = true,
    resolveOriginalOwnerControl, acquireComposition, onBindingRetired = () => {}, onBindingState = () => {},
    onDiagnostic = () => {} }) {
    let shared = null, loading = null, disposed = false, bindingTail = Promise.resolve();
    const owners = new Set();
    // Optional Main-only observation. Logging cannot change admission, retain
    // a payload, throw into cleanup or create another owner.
    const diagnostic = (stage, error) => { try { onDiagnostic(stage, error); } catch { /* Observation only. */ } };
    const quarantined = cleanup => Object.freeze({
        async request() { throw new Error('Original connectivity acquisition remains fenced for cleanup'); }, close: cleanup,
    });
    async function obtain() {
        if (disposed) throw new Error('Normal Main connectivity owner has ended');
        if (shared?.fenced) await retireShared(shared);
        if (shared) return shared;
        if (loading) return loading;
        const record = { composition: null, retirement: null, acquisitions: new Set(), fenced: false };
        shared = record;
        const task = Promise.resolve().then(async () => {
            try { record.composition = await acquireComposition(); }
            catch (error) {
                if (error.retainedComposition) { record.composition = error.retainedComposition; record.fenced = true; }
                else if (shared === record) shared = null;
                throw error;
            }
            if (disposed) await retireShared(record);
            return record;
        });
        loading = task;
        try { return await task; } finally { if (loading === task) loading = null; }
    }
    async function retireShared(record) {
        if (record.retirement) return record.retirement;
        record.fenced = true;
        const task = Promise.resolve().then(async () => {
            await Promise.all([...record.acquisitions]);
            if (owners.size) return;
            if (!record.composition) throw new Error('Original connectivity acquisition remains unconfirmed');
            await record.composition.close();
            if (shared === record) shared = null;
        });
        record.retirement = task;
        return task.finally(() => { if (record.retirement === task) record.retirement = null; });
    }
    async function bindOne(input) {
        let control;
        try {
            input.requireCurrentController();
            if (disposed || !configured || typeof resolveOriginalOwnerControl !== 'function' || typeof MessageChannelMain !== 'function') {
                diagnostic('resolve-original-owner-control', new Error('Main connectivity owner is unavailable.')); return null;
            }
            control = await resolveOriginalOwnerControl(input);
            input.requireCurrentController();
            if (!control) { diagnostic('resolve-original-owner-control', new Error('Original connectivity control is unavailable.')); return null; }
            control.requireCurrent();
        } catch (error) { diagnostic('resolve-original-owner-control', error); return null; } // No module/backend acquisition has occurred.
        let record;
        try { record = await obtain(); }
        catch (error) {
            diagnostic('acquire-composition', error);
            const retained = shared;
            return retained && !owners.size ? quarantined(() => retireShared(retained)) : null;
        }
        let endReservation;
        const reservation = new Promise(resolve => { endReservation = resolve; });
        record.acquisitions.add(reservation);
        const releaseReservation = () => { record.acquisitions.delete(reservation); endReservation(); };
        let first = null, initialFailed = false;
        try {
            input.requireCurrentController(); control.requireCurrent();
            if (disposed) throw new Error('Main network admission ended during loading');
            first = record.composition.context(await control.query());
            input.requireCurrentController(); control.requireCurrent();
            if (!first) diagnostic('query-context', new Error('Original connectivity context is unavailable.'));
        } catch (error) { initialFailed = true; diagnostic('query-context', error); }
        if (initialFailed || !first || disposed || record.fenced || shared !== record) {
            releaseReservation();
            if (!owners.size) {
                try { await retireShared(record); }
                catch { return quarantined(() => retireShared(record)); }
            }
            return null;
        }
        const local = { binding: null, attachment: null, ended: false, closed: false, closing: null, released: false,
            removeOwnerRelease: null, removeRequested: false, notified: false, published: false, producerStarted: false,
            fault: null, stateRevision: 0 };
        owners.add(local); // Retain all partial acquisitions before external bind callbacks.
        releaseReservation();
        const guard = () => { input.requireCurrentController(); control.requireCurrent(); if (disposed || local.closed || local.ended || local.fault) throw new Error('Original network owner ended'); };
        function publishState(phase) {
            const fault = local.fault;
            if (!fault || local.released || fault.phase === phase) return;
            fault.phase = phase;
            if (local.stateRevision >= Number.MAX_SAFE_INTEGER) return; // Admission stays fenced.
            const value = Object.freeze({ authority: Object.freeze({ ...input.authority, ...(input.producerId ? { producerId: input.producerId } : {}) }), revision: ++local.stateRevision,
                phase, selection: fault.attachment.selection, grant: fault.attachment.grantIdentity });
            // A callback may synchronously request close or return its Promise.
            // Its cleanup can never become part of the original dispose ACK.
            try { void Promise.resolve(onBindingState(value)).catch(() => {}); } catch { /* Original owner remains retained. */ }
        }
        // The dispose wire has no trusted cause. Main-declared cleanup is
        // expected; all other grant endings (including Runtime-initiated normal
        // lifecycle detach) conservatively retire this binding, without
        // claiming a network/MCU failure or retrying any business operation.
        function undeclaredDisposal(attachment) {
            if (local.released || local.closed || local.ended || local.attachment !== attachment || attachment.expectedDetaching || local.fault) return;
            let handoff;
            const ready = new Promise(resolve => { handoff = resolve; });
            local.fault = { attachment, ready, handoff, handedOff: false, automaticCloseStarted: false, phase: null };
            publishState('closing'); // Fence before invoking actual backend cleanup.
        }
        function disposalSettled(attachment) {
            const fault = local.fault;
            if (!fault || fault.attachment !== attachment || local.released || fault.handedOff) return;
            fault.handedOff = true;
            fault.handoff(); // Original grant reply submission attempt has settled.
            if (!fault.automaticCloseStarted) {
                fault.automaticCloseStarted = true;
                // Separate flight, never awaited by the server settlement hook.
                void close(false).catch(() => {});
            }
        }
        function terminalResultSettled(attachment) {
            // This is an actual execute-result settlement, NOT a dispose ACK.
            // Only the still-current original attachment may start this path;
            // an existing remote-dispose fault keeps its own D13 handoff.
            if (local.released || local.closed || local.ended || local.attachment !== attachment || attachment.expectedDetaching || local.fault) return;
            local.fault = { attachment, ready: Promise.resolve(), handedOff: true,
                automaticCloseStarted: true, phase: null, cause: 'grant-terminal-result' };
            publishState('closing');
            // The server has already removed the original request's active
            // slot. Existing detach -> remote dispose -> actual ACK remains
            // the only resource cleanup chain; no business request is replayed.
            void close(false).catch(() => {});
        }
        function autonomousGrantRetiring(grant, reason) {
            // Optional trusted composition callback, not a wire result or a
            // guessed timer. Only an independently expiring original ledger
            // invokes it. Execute/dispose results keep their existing frontier.
            if (local.released || local.closed || local.ended || local.fault
                || reason !== 'lease-revoked' && reason !== 'grant-expired') return;
            const attachment = local.attachment;
            if (!attachment) {
                // A selected Node grant can end before its select/attach
                // handoff. Fence this captured binding without inventing an
                // installed attachment, UI grant or Runtime detach receipt.
                void close(false).catch(() => {});
                return;
            }
            const expected = attachment.grantIdentity;
            if (attachment.expectedDetaching || !grant || !grant.scope
                || ['grantId', 'backendId', 'executionId', 'profileId'].some(key => grant[key] !== expected[key])
                || Object.keys(grant.scope).length !== Object.keys(expected.scope).length
                || Object.keys(expected.scope).some(key => grant.scope[key] !== expected.scope[key])) return;
            local.fault = { attachment, ready: Promise.resolve(), handedOff: true,
                automaticCloseStarted: true, phase: null, cause: 'autonomous-grant-retirement' };
            publishState('closing');
            // This separate flight still requires exact Runtime detach, actual
            // backend/server work and both holders. It never manufactures an
            // execute-result settlement or a dispose ACK from the expiry fact.
            void close(false).catch(() => {});
        }
        const currentContext = async signal => {
            try {
                guard(); const raw = await control.query(signal); guard(); signal?.throwIfAborted();
                const context = record.composition.context(raw); // Never retained as synchronous authority.
                if (!context) diagnostic('query-context', new Error('Original connectivity context is unavailable.'));
                return context;
            } catch (error) { diagnostic('query-context', error); throw error; }
        };
        async function closeAttachment(retry = false) {
            const attachment = local.attachment;
            if (!attachment) return;
            attachment.expectedDetaching = true; // Sticky through failed cleanup/retry.
            // Every caller joins this original attachment's full cleanup flight.
            // An ended owner is not a Runtime detach confirmation; even terminal
            // cleanup must retain the live server until the actual detach ACK.
            if (attachment.closing) return attachment.closing;
            if (attachment.cleanupError && !retry) throw attachment.cleanupError;
            attachment.cleanupError = null;
            const task = Promise.resolve().then(async () => {
                if (!attachment.detachConfirmed) {
                    await control.detach(attachment.sessionId, attachment.grantId);
                    attachment.detachConfirmed = true;
                }
                // Detach can wake an admitted attach, so dispatch it first.
                // Its ACK alone does not settle Main's original attach flight.
                // A rejected attach is a settled outcome, never an attach ACK.
                if (attachment.attaching) await Promise.allSettled([attachment.attaching]);
                if (attachment.server) await attachment.server.close(); else await attachment.backend.dispose();
                for (const port of attachment.ports) port.close();
                if (local.attachment === attachment) local.attachment = null;
            }).catch(error => {
                attachment.cleanupError = error; // Only an explicit close/release can retry.
                throw error;
            });
            attachment.closing = task;
            return task.finally(() => { if (attachment.closing === task) attachment.closing = null; });
        }
        async function close(retryAttachment = true) {
            local.closed = true;
            if (local.released) return;
            if (local.closing) return local.closing;
            const task = Promise.resolve().then(async () => {
                // Reentrant UI cleanup may arrive before the grant ACK. Keep
                // that same close owner pending; never cut its server early.
                if (local.fault) await local.fault.ready;
                const outcomes = await Promise.allSettled([closeAttachment(retryAttachment), local.binding?.close()]);
                if (outcomes.some(result => result.status === 'rejected')) throw new Error('Original network binding cleanup remains unconfirmed');
                owners.delete(local);
                if (!owners.size) await retireShared(record);
                local.released = true;
                if (local.removeRequested) local.removeOwnerRelease?.();
                if (local.published && !local.notified) {
                    local.notified = true;
                    // A failed cleanup never publishes a new producer lifetime.
                    // This event only follows actual binding/server/ref retirement.
                    try { onBindingRetired(Object.freeze({ ...input.authority, ...(input.producerId ? { producerId: input.producerId } : {}) })); } catch { /* Window may already be physically gone. */ }
                }
            }).catch(error => { publishState('cleanup-unconfirmed'); throw error; });
            local.closing = task;
            if (local.fault?.phase === 'cleanup-unconfirmed') publishState('closing');
            return task.finally(() => { if (local.closing === task) local.closing = null; });
        }
        local.close = close;
        try {
            local.binding = record.composition.bind({ input, authority: input.authority, requireCurrentAuthority: guard,
                trustedContext: currentContext,
                onGrantRetiring: autonomousGrantRetiring,
                registerOwnerRelease: retire => {
                    local.removeOwnerRelease = control.registerOwnerRelease(async () => {
                        local.ended = true;
                        // This callback runs BEFORE the original Worker owner
                        // release. Keep the server alive while Runtime detaches;
                        // its grant-only dispose never calls this terminal path.
                        const outcomes = await Promise.allSettled([closeAttachment(true), retire()]);
                        if (outcomes.some(result => result.status === 'rejected')) throw new Error('Original Main/Runtime network cleanup remains unconfirmed');
                        await close(false);
                    });
                    // The shared provider may finish its own cleanup before
                    // Main's extra server/port/holder joins finish. Its request
                    // to unsubscribe cannot discard a still-failing Main owner.
                    return () => { local.removeRequested = true; if (local.released) local.removeOwnerRelease?.(); };
                },
            });
            if (typeof local.binding.acquireGrantBackend !== 'function') throw new Error('Installed network grant consumer API is unavailable');
            const port = Object.freeze({
                async request(request, signal) {
                    if (record.composition.isCleanupRequest?.(request)) {
                        // Only cleanup on this captured original binding may
                        // outlive business admission. No new driver is made.
                        const results = await Promise.allSettled([closeAttachment(true), local.binding.request(request, signal)]);
                        if (results.some(value => value.status === 'rejected')) throw new Error('Original connectivity release remains unconfirmed');
                        const result = results[1].value;
                        await close(true);
                        return result;
                    }
                    guard();
                    if (!local.producerStarted) {
                        if (request.requestSequence !== 1) {
                            // Earlier unavailable catalog polls had no actual
                            // Node owner. End this unused real port before UI or
                            // I/O, publish a new normal outer catalog lifetime,
                            // and reject this request without renumber/replay.
                            await close();
                            throw new Error('Normal network producer lifetime changed');
                        }
                        local.producerStarted = true;
                    }
                    if (local.attachment?.retired || request.operation === 'release') await closeAttachment(true);
                    const result = await local.binding.request(request, signal);
                    guard(); signal.throwIfAborted();
                    if (result.ok && result.operation === 'select' && result.outcome === 'selected') {
                        const grant = result.grant, actual = local.binding.acquireGrantBackend(grant.grantId);
                        const attachment = { sessionId: grant.scope.sessionId, grantId: grant.grantId, retired: false, server: null, backend: null, ports: [], expectedDetaching: false,
                            closing: null, cleanupError: null, detachConfirmed: false, attaching: null,
                            selection: Object.freeze({ requestId: request.requestId, requestSequence: request.requestSequence }),
                            grantIdentity: Object.freeze({ grantId: grant.grantId, backendId: grant.backendId,
                                executionId: grant.executionId, profileId: grant.profileId, scope: Object.freeze({ ...grant.scope }) }) };
                        const backend = Object.freeze({ descriptor: actual.descriptor,
                            execute: (command, current) => actual.execute(command, current),
                            async dispose() {
                                undeclaredDisposal(attachment);
                                await actual.dispose(); attachment.retired = true;
                            } });
                        const { port1, port2 } = new MessageChannelMain();
                        attachment.backend = backend; attachment.ports = [port1, port2];
                        local.attachment = attachment;
                        try {
                            attachment.server = record.composition.serve({ port: adaptMainNetworkMessagePort(port1), backend, grant,
                                onDisposeSettled: () => disposalSettled(attachment),
                                onTerminalResultSettled: () => terminalResultSettled(attachment) });
                            guard(); signal.throwIfAborted();
                            attachment.attaching = Promise.resolve(control.attach(record.composition.attachment(grant, actual.descriptor), port2));
                            await attachment.attaching;
                            guard(); signal.throwIfAborted();
                        } catch (error) { await closeAttachment(true); throw error; }
                    }
                    return result;
                },
                close: () => close(),
            });
            local.published = true;
            return port;
        } catch (error) {
            diagnostic('bind', error);
            try { await close(false); return null; }
            catch { return quarantined(() => close(false)); }
        }
    }
    return Object.freeze({
        bind(input) {
            // Only low-frequency binding acquisition is ordered. Actual I/O
            // remains concurrent in the one shared provider/ledger. This keeps
            // an idle module from retiring under another in-flight bind query.
            const task = bindingTail.then(() => bindOne(input));
            bindingTail = task.then(() => undefined, () => undefined);
            return task;
        },
        async dispose() {
            disposed = true;
            await bindingTail;
            const outcomes = await Promise.allSettled([...owners].map(owner => owner.close()));
            if (outcomes.some(result => result.status === 'rejected')) throw new Error('Main shared network owners remain unconfirmed');
            // Normal controller closures own attachment retirement; do not
            // silently erase an unresolved owner or release its package holder.
            if (owners.size) throw new Error('Main network binding close remains required');
            if (shared) await retireShared(shared);
        },
    });
}
module.exports = { createMainConnectivityProviderOwner };
