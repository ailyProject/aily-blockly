'use strict';

const { randomUUID } = require('node:crypto');

const ACTIONS = new Set(['list', 'open', 'read', 'write', 'close', 'revoke', 'status']);
const MONOTONIC_WRITE_PROTOCOL = 'monotonic-v1';
const ERRORS = new Set(['denied', 'unavailable', 'busy', 'stale-scope', 'stale-cursor', 'invalid-input',
    'io-error', 'revoked', 'duplicate-operation', 'delivery-unknown', 'overflow', 'unsupported']);

function failure(code) { return Object.assign(new Error(code), { localSerialCode: code }); }
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw failure('invalid-input');
}
function exactOptional(value, required, optional) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || required.some(key => !Object.hasOwn(value, key))
        || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw failure('invalid-input');
}
function identifier(value) { if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw failure('invalid-input'); }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) throw failure('invalid-input'); }
function monotonicOperationId(handleId, sequence) {
    identifier(handleId); integer(sequence, 1, Number.MAX_SAFE_INTEGER);
    const value = `${MONOTONIC_WRITE_PROTOCOL}:${handleId}:${sequence}`; identifier(value); return value;
}
function monotonicSequence(operationId, handleId) {
    identifier(operationId); identifier(handleId);
    const prefix = `${MONOTONIC_WRITE_PROTOCOL}:${handleId}:`;
    const suffix = operationId.startsWith(prefix) ? operationId.slice(prefix.length) : '';
    if (!/^[1-9]\d*$/u.test(suffix)) throw failure('invalid-input');
    const sequence = Number(suffix); integer(sequence, 1, Number.MAX_SAFE_INTEGER);
    if (String(sequence) !== suffix) throw failure('invalid-input');
    return sequence;
}

/** Main's defensive IPC boundary. The public protocol also validates both ends. */
function validateCommand(command) {
    if (!ACTIONS.has(command?.command) || command.schemaVersion !== 1 || command.kind !== 'aily-local-serial-command') throw failure('invalid-input');
    exact(command.scope, ['sessionId', 'nodeId', 'clockDomainId', 'generation']);
    for (const key of ['sessionId', 'nodeId', 'clockDomainId']) identifier(command.scope[key]);
    integer(command.scope.generation, 0, Number.MAX_SAFE_INTEGER);
    const extra = { list: [], open: ['deviceId', 'baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl'],
        read: ['handleId', 'afterSequence', 'maxBytes', 'maxRecords'], write: ['handleId', 'operationId', 'dataBase64', 'dataByteLength'],
        close: ['handleId'], revoke: [], status: ['handleId'] }[command.command];
    exactOptional(command, ['schemaVersion', 'kind', 'command', 'scope', ...extra], command.command === 'open' ? ['writeProtocol'] : []);
    if (Object.hasOwn(command, 'handleId')) identifier(command.handleId);
    if (command.command === 'open') {
        identifier(command.deviceId); integer(command.baudRate, 300, 4000000);
        if (command.writeProtocol !== undefined && command.writeProtocol !== MONOTONIC_WRITE_PROTOCOL) throw failure('unsupported');
        if (command.dataBits !== 8 || command.stopBits !== 1 || command.parity !== 'none' || command.flowControl !== 'none') throw failure('unsupported');
    }
    if (command.command === 'read') {
        integer(command.afterSequence, 0, Number.MAX_SAFE_INTEGER); integer(command.maxBytes, 1, 4096); integer(command.maxRecords, 1, 32);
    }
    if (command.command === 'write') {
        identifier(command.operationId); integer(command.dataByteLength, 1, 4096);
        if (typeof command.dataBase64 !== 'string' || command.dataBase64.length > 5464
            || Buffer.from(command.dataBase64, 'base64').toString('base64') !== command.dataBase64
            || Buffer.from(command.dataBase64, 'base64').length !== command.dataByteLength) throw failure('invalid-input');
    }
    return command;
}

function errorCode(error) {
    if (ERRORS.has(error?.localSerialCode)) return error.localSerialCode;
    const raw = String(error?.code || '').replace(/^BRIDGE_/u, '').toLowerCase().replaceAll('_', '-');
    return ERRORS.has(raw) ? raw : 'io-error';
}

/** One trusted Main authority per exact workspace controller AND simulation
 * scope. Neither project paths nor a caller-provided scope grants hardware.
 * Factory is lazy: catalog/registration never enumerates or opens a port. */
class SubappLocalSerialHost {
    constructor({ authorize, createBridge, confirmOpen, now = Date.now, idleMs = 30000, onError = console.warn }) {
        if (typeof authorize !== 'function' || typeof createBridge !== 'function' || typeof confirmOpen !== 'function') throw new TypeError('Local serial host ports are required');
        integer(idleMs, 1000, 30000);
        Object.assign(this, { authorize, createBridge, confirmOpen, now, idleMs, onError });
        this.owners = new Map(); this.bridgePromise = null; this.bridgeRetirement = null; this.bridgeFenced = false; this.closed = false;
        this.timer = setInterval(() => { void this.expire().catch(error => this.onError('[LocalSerial] cleanup remains unconfirmed', errorCode(error))); }, Math.min(5000, idleMs));
        this.timer.unref?.();
    }

    async invoke(event, envelope) {
        let command;
        try {
            exact(envelope, ['toolId', 'streamId', 'bindingId', 'command']);
            for (const name of ['toolId', 'streamId', 'bindingId']) identifier(envelope[name]);
            const validated = validateCommand(envelope.command);
            command = { ...validated, scope: { sessionId: validated.scope.sessionId, nodeId: validated.scope.nodeId,
                clockDomainId: validated.scope.clockDomainId, generation: validated.scope.generation } };
            if (this.closed) throw failure('revoked');
            let guard;
            try { guard = this.authorize(event, envelope); guard(); } catch { throw failure('denied'); }
            const authority = JSON.stringify([event.sender.id, envelope.toolId, envelope.streamId, envelope.bindingId]);
            const key = JSON.stringify([authority, command.scope]);
            let owner = this.owners.get(key);
            if (!owner) {
                if (command.command !== 'list' && command.command !== 'revoke') throw failure('revoked');
                if (this.owners.size >= 64) throw failure('busy');
                owner = { key, authority, senderId: event.sender.id, toolId: envelope.toolId, streamId: envelope.streamId,
                    bindingId: envelope.bindingId, scope: { ...command.scope }, id: `serial-owner:${randomUUID()}`,
                    devices: new Map(), handles: new Map(), revoked: false, tail: Promise.resolve(), touched: this.now(), pending: 0 };
                this.owners.set(key, owner);
            }
            if (command.command === 'revoke') {
                const count = owner.handles.size;
                await this.retire(owner);
                return this.result(command, { state: 'revoked', closedHandles: count });
            }
            if (owner.revoked || this.now() - owner.touched > this.idleMs) { await this.retire(owner); throw failure('revoked'); }
            if (command.command === 'close') return await this.closeHandle(owner, command, guard);
            if (owner.pending >= 16) throw failure('busy');
            owner.pending++;
            owner.touched = this.now();
            const work = owner.tail.catch(() => undefined).then(async () => {
                this.check(owner, guard);
                const bridge = await this.bridge(); this.check(owner, guard);
                const result = await this.perform(bridge, owner, command, guard);
                this.check(owner, guard);
                return this.result(command, result);
            }).finally(() => { owner.pending--; });
            owner.tail = work;
            return await work;
        } catch (error) {
            // Never serialize raw native errors, system paths or OS handles.
            if (!command) return { schemaVersion: 1, kind: 'aily-local-serial-ipc-error', ok: false, errorCode: errorCode(error) };
            return this.result(command, { ok: false, errorCode: errorCode(error) });
        }
    }

    result(command, fields) {
        return { schemaVersion: 1, kind: 'aily-local-serial-result', command: command.command, scope: { ...command.scope }, ok: true, ...fields };
    }

    async bridge() {
        if (this.bridgeRetirement) await this.bridgeRetirement;
        if (this.bridgeFenced) await this.releaseIdleBridge();
        return this.bridgePromise ??= Promise.resolve().then(() => this.createBridge()).catch(error => { this.bridgePromise = null; throw error; });
    }
    releaseIdleBridge() {
        if (this.bridgeRetirement) return this.bridgeRetirement;
        if (this.owners.size && !this.bridgeFenced || !this.bridgePromise) return Promise.resolve();
        this.bridgeFenced = true;
        const pending = this.bridgePromise;
        const cleanup = Promise.resolve().then(async () => {
            await (await pending).dispose();
            if (this.bridgePromise === pending) this.bridgePromise = null;
            this.bridgeFenced = false;
        }).finally(() => { if (this.bridgeRetirement === cleanup) this.bridgeRetirement = null; });
        this.bridgeRetirement = cleanup; return cleanup;
    }
    check(owner, guard) {
        if (this.closed || owner.revoked || this.owners.get(owner.key) !== owner) throw failure('revoked');
        try { guard(); } catch { owner.revoked = true; void this.retire(owner).catch(error => this.onError('[LocalSerial] revoked cleanup requires retry', errorCode(error))); throw failure('revoked'); }
    }

    async perform(bridge, owner, command, guard) {
        const scope = command.scope;
        if (command.command === 'list') {
            const listed = await bridge.listPorts({ scope }, owner.id); this.check(owner, guard);
            const ports = Array.isArray(listed) ? listed : listed.ports;
            if (!Array.isArray(ports) || ports.length > 128) throw failure('unavailable');
            const previous = new Map([...owner.devices].map(([id, port]) => [port.path, id]));
            owner.devices.clear();
            const devices = ports.map(port => {
                const portPath = port.portPath ?? port.path;
                if (typeof portPath !== 'string' || !portPath || portPath.length > 4096) throw failure('unavailable');
                const deviceId = previous.get(portPath) || `serial-device:${randomUUID()}`;
                owner.devices.set(deviceId, { ...port, path: portPath });
                const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 128) : undefined;
                const label = clean(String(port.label || port.friendlyName || port.manufacturer || '').replaceAll(portPath, '').trim());
                return { deviceId, label: label || `Serial device ${owner.devices.size}`,
                    ...(clean(port.vendorId) ? { vendorId: clean(port.vendorId) } : {}), ...(clean(port.productId) ? { productId: clean(port.productId) } : {}) };
            });
            return { devices };
        }
        if (command.command === 'open') {
            const device = owner.devices.get(command.deviceId);
            if (!device) throw failure('denied');
            if (command.writeProtocol && !bridge.writeProtocols?.includes(MONOTONIC_WRITE_PROTOCOL)) throw failure('unsupported');
            if (owner.handles.size >= 1) throw failure('busy');
            if (this.activeConfirmation) throw failure('busy');
            this.activeConfirmation = true;
            let allowed;
            try { allowed = await this.confirmOpen({ senderId: owner.senderId, toolId: owner.toolId, device: { ...device }, command }); }
            finally { this.activeConfirmation = false; }
            this.check(owner, guard);
            if (allowed !== true) throw failure('denied');
            const opened = await bridge.open({ portPath: device.path, scope, baudRate: command.baudRate,
                dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none',
                ...(command.writeProtocol ? { writeProtocol: command.writeProtocol } : {}) }, owner.id);
            if (owner.revoked || this.closed) { await bridge.revokeOwner(owner.id); throw failure('revoked'); }
            try { identifier(opened?.handleId); }
            catch {
                // An invalid receipt may still own native resources. Preserve
                // the owner and cancel through its backend authority.
                owner.revoked = true;
                void this.retire(owner).catch(error => this.onError('[LocalSerial] invalid open cleanup requires retry', errorCode(error)));
                throw failure('io-error');
            }
            const handleId = `serial-handle:${randomUUID()}`;
            const handle = { nativeId: opened.handleId, writeProtocol: command.writeProtocol };
            owner.handles.set(handleId, handle);
            if (opened.writeProtocol !== command.writeProtocol) {
                // Capture before checking optional capabilities. A backend that
                // silently ignored negotiation must not leak its opened fd.
                handle.fenced = true;
                try {
                    await bridge.close({ handleId: handle.nativeId, scope }, owner.id);
                    if (owner.handles.get(handleId) === handle) owner.handles.delete(handleId);
                } catch { throw failure('io-error'); } // owner retains the handle for explicit revoke/retry
                throw failure('unsupported');
            }
            return { handleId, state: 'open', nextSequence: 0,
                ...(command.writeProtocol ? { writeProtocol: command.writeProtocol } : {}) };
        }
        const handle = owner.handles.get(command.handleId);
        if (!handle) throw failure('revoked');
        if (handle.fenced && command.command !== 'status') throw failure('revoked');
        const nativeOperationId = command.command === 'write' && handle.writeProtocol === MONOTONIC_WRITE_PROTOCOL
            ? monotonicOperationId(handle.nativeId, monotonicSequence(command.operationId, command.handleId)) : command.operationId;
        const input = { handleId: handle.nativeId, scope,
            ...(command.command === 'read' ? { afterSequence: command.afterSequence, maxBytes: command.maxBytes, maxRecords: command.maxRecords } : {}),
            ...(command.command === 'write' ? { operationId: nativeOperationId, dataBase64: command.dataBase64, dataByteLength: command.dataByteLength } : {}) };
        let value;
        try { value = await bridge[command.command](input, owner.id); }
        catch (error) {
            if (command.command === 'write' && ['delivery-unknown', 'io-error'].includes(errorCode(error))) {
                handle.fenced = true; throw failure('delivery-unknown');
            }
            throw error;
        }
        if (command.command !== 'status' && (handle.fenced || owner.handles.get(command.handleId) !== handle)) {
            throw failure(command.command === 'write' ? 'delivery-unknown' : 'revoked');
        }
        if (command.command === 'close') { owner.handles.delete(command.handleId); return { handleId: command.handleId, state: 'closed' }; }
        if (command.command === 'write') {
            if (value?.acceptedBytes !== command.dataByteLength || value?.operationId !== nativeOperationId) {
                handle.fenced = true; throw failure('delivery-unknown');
            }
            return { handleId: command.handleId, operationId: command.operationId, acceptedBytes: value.acceptedBytes };
        }
        if (command.command === 'read') return { handleId: command.handleId, records: value.records.map(record => ({
            sequence: record.sequence, dataBase64: record.dataBase64, dataByteLength: record.dataByteLength })),
            nextSequence: value.nextSequence, hasMore: value.hasMore, droppedBytes: value.droppedBytes, state: value.state };
        return { handleId: command.handleId, state: value.state, bufferedBytes: value.bufferedBytes,
            droppedBytes: value.droppedBytes, nextSequence: value.nextSequence };
    }

    closeHandle(owner, command, guard) {
        this.check(owner, guard);
        const handle = owner.handles.get(command.handleId);
        if (!handle) return Promise.reject(failure('revoked'));
        handle.fenced = true;
        if (handle.closing) return handle.closing;
        // Close is a cancellation lane, never queued behind the I/O it cancels.
        const task = Promise.resolve().then(async () => {
            const bridge = await this.bridge();
            await bridge.close({ handleId: handle.nativeId, scope: command.scope }, owner.id);
            this.check(owner, guard);
            if (owner.handles.get(command.handleId) === handle) owner.handles.delete(command.handleId);
            return this.result(command, { handleId: command.handleId, state: 'closed' });
        }).finally(() => { if (handle.closing === task) handle.closing = null; });
        handle.closing = task; return task;
    }

    retire(owner) {
        owner.revoked = true; owner.devices.clear();
        if (owner.closing) return owner.closing;
        // Signal cancellation immediately, before joining in-flight operations.
        // The backend owns actual abort/close; no second writer or replay exists.
        const cancellation = this.bridgePromise ? this.bridgePromise.then(bridge => bridge.revokeOwner(owner.id)) : Promise.resolve();
        const cleanup = Promise.allSettled([cancellation, owner.tail]).then(async results => {
            if (results[0].status === 'rejected') throw results[0].reason;
            owner.handles.clear();
            if (this.owners.get(owner.key) === owner) this.owners.delete(owner.key);
            await this.releaseIdleBridge();
        }).finally(() => { if (owner.closing === cleanup) owner.closing = null; });
        owner.closing = cleanup;
        return cleanup;
    }
    async retireWhere(predicate) {
        const results = await Promise.allSettled([...this.owners.values()].filter(predicate).map(owner => this.retire(owner)));
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Local serial cleanup requires retry');
    }
    revokeBinding(senderId, input) { return this.retireWhere(owner => owner.senderId === senderId && owner.toolId === input.toolId && owner.streamId === input.streamId && owner.bindingId === input.bindingId); }
    revokeRuntime(streamId) { return this.retireWhere(owner => owner.streamId === streamId); }
    revokeSender(senderId) { return this.retireWhere(owner => owner.senderId === senderId); }
    async expire() { await this.retireWhere(owner => owner.revoked || this.now() - owner.touched > this.idleMs); await this.releaseIdleBridge(); }
    async dispose() {
        this.closed = true; clearInterval(this.timer);
        await this.retireWhere(() => true);
        await this.releaseIdleBridge();
    }
}

module.exports = { SubappLocalSerialHost, validateCommand, monotonicOperationId, monotonicSequence, MONOTONIC_WRITE_PROTOCOL };
