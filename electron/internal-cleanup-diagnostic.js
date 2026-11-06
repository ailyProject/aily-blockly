"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInternalCleanupDiagnostic = createInternalCleanupDiagnostic;
exports.emitInternalCleanupDiagnostic = emitInternalCleanupDiagnostic;
const PREFIX = 'AILY_INTERNAL_CLEANUP_V1 ';
const MAX_NODES = 16, MAX_DEPTH = 4, MAX_BYTES = 4096;
const names = new Set(['Error', 'TypeError', 'RangeError', 'AggregateError', 'DOMException', 'AbortError', 'TimeoutError']);
const codes = new Set(['unsupported', 'unavailable', 'permission-required', 'permission-denied', 'stale-scope', 'stale-epoch',
    'busy', 'backpressure', 'overflow', 'peer-disconnected', 'timeout', 'cancelled', 'delivery-unknown', 'cleanup-unconfirmed',
    'invalid-input', 'request-replayed', 'lease-revoked', 'grant-expired', 'grant-mismatch', 'backend-mismatch',
    'NODE_CONTROL_CLEANUP_UNCONFIRMED', 'NODE_CONTROL_CLOSED', 'NODE_CONTROL_FAILED', 'NODE_CONTROL_SEND_FAILED',
    'NODE_CONTROL_BUSY', 'NODE_CONTROL_INVALID_REQUEST', 'BROWSER_EXECUTION_CLEANUP_UNCONFIRMED',
    'BROWSER_EXECUTION_DISCONNECTED', 'BROWSER_EXECUTION_SEND_FAILED', 'BROWSER_EXECUTION_INVALID_RESULT']);
const categories = new Map([
    ['Node control handler cleanup is unconfirmed', 'node-handler-cleanup-unconfirmed'],
    ['Node control cleanup requires retry', 'node-control-cleanup-unconfirmed'],
    ['Node control lifecycle ACK timed out', 'node-control-lifecycle-timeout'],
    ['Local network cleanup requires retry.', 'local-network-cleanup-unconfirmed'],
    ['Local connection cleanup requires retry.', 'local-connection-cleanup-unconfirmed'],
    ['Host guest mapping cleanup is unconfirmed.', 'guest-mapping-cleanup-unconfirmed'],
    ['Host guest service retained resources.', 'guest-service-cleanup-unconfirmed'],
    ['Wireless Host attachment cleanup is unconfirmed.', 'wireless-attachment-cleanup-unconfirmed'],
    ['Original network owner cleanup remains unconfirmed.', 'original-network-cleanup-unconfirmed'],
    ['Original network cleanup is unavailable.', 'original-network-cleanup-unavailable'],
    ['Original network owner ended', 'original-network-owner-ended'],
    ['Network Provider binding is retired or cancelled.', 'network-binding-retired'],
    ['Original Browser network admission has ended', 'browser-network-admission-ended'],
    ['Original private Browser owner acknowledgement is unavailable', 'private-browser-owner-unavailable'],
    ['View connection cleanup was not acknowledged', 'view-connection-cleanup-unconfirmed'],
    ['Browser View close remains unconfirmed', 'browser-view-close-unconfirmed'],
    ['cleanup-unconfirmed', 'cleanup-unconfirmed'], ['permission-denied', 'permission-denied'],
]);
const sources = new Set(['registered-view-cleanup', 'execution-view-detach', 'node-handler-cleanup', 'node-detach-result-send']);
function data(value, key) {
    if (!value || typeof value !== 'object')
        return undefined;
    try {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return field && Object.hasOwn(field, 'value') ? field.value : undefined;
    }
    catch {
        return undefined;
    }
}
function errorName(value) {
    let current = value;
    for (let n = 0; n < 4 && current && typeof current === 'object'; n++) {
        const name = data(current, 'name');
        if (typeof name === 'string')
            return name.length <= 32 && names.has(name) ? name : 'Error';
        try {
            current = Object.getPrototypeOf(current);
        }
        catch {
            return 'Error';
        }
    }
    return value && typeof value === 'object' ? 'Error' : 'NonError';
}
/** Never copy a raw message/code/name. Only exact fixed vocabulary may leave. */
function createInternalCleanupDiagnostic(phase, failures) {
    try {
        if (phase !== 'main-view-disconnect' && phase !== 'node-view-detach' || !Array.isArray(failures))
            return undefined;
        const nodes = [], seen = new WeakSet();
        let truncated = false;
        const visit = (value, source, parent, depth, via) => {
            if (nodes.length >= MAX_NODES || depth >= MAX_DEPTH) {
                truncated = true;
                return;
            }
            if (value && typeof value === 'object') {
                if (seen.has(value)) {
                    truncated = true;
                    return;
                }
                seen.add(value);
            }
            const rawCode = data(value, 'code'), rawMessage = data(value, 'message');
            const index = nodes.length;
            nodes.push({ source, parent, depth, via, name: errorName(value),
                code: typeof rawCode === 'string' && rawCode.length <= 80 && codes.has(rawCode) ? rawCode : null,
                category: typeof rawMessage === 'string' && rawMessage.length <= 160 ? categories.get(rawMessage) ?? 'unclassified' : 'unclassified' });
            const children = data(value, 'errors');
            if (Array.isArray(children)) {
                const length = data(children, 'length');
                if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
                    if (length > MAX_NODES)
                        truncated = true;
                    for (let n = 0; n < Math.min(length, MAX_NODES); n++) {
                        if (nodes.length >= MAX_NODES) {
                            truncated = true;
                            break;
                        }
                        const child = data(children, String(n));
                        if (child !== undefined)
                            visit(child, source, index, depth + 1, 'aggregate');
                    }
                }
            }
            const cause = data(value, 'cause');
            if (cause !== undefined)
                visit(cause, source, index, depth + 1, 'cause');
        };
        for (let index = 0; index < Math.min(failures.length, MAX_NODES); index++) {
            const failure = data(failures, String(index)), source = data(failure, 'source');
            if (typeof source === 'string' && sources.has(source))
                visit(data(failure, 'error'), source, null, 0, 'root');
        }
        if (failures.length > MAX_NODES)
            truncated = true;
        if (!nodes.length)
            return undefined;
        const encode = () => PREFIX + JSON.stringify({ schemaVersion: 1, kind: 'aily-internal-cleanup-diagnostic', phase, truncated, nodes }) + '\n';
        let text = encode();
        while (new TextEncoder().encode(text).length > MAX_BYTES && nodes.length > 1) {
            nodes.pop();
            truncated = true;
            text = encode();
        }
        return new TextEncoder().encode(text).length <= MAX_BYTES ? text : undefined;
    }
    catch {
        return undefined;
    }
}
/** Original throws/ACKs never await this optional stderr observer. */
function emitInternalCleanupDiagnostic(phase, failures, sink = text => console.error(text.trimEnd())) {
    try {
        const text = createInternalCleanupDiagnostic(phase, failures);
        if (!text)
            return;
        const pending = sink(text);
        if (pending !== undefined)
            void Promise.resolve(pending).catch(() => undefined);
    }
    catch { /* Observation cannot acknowledge, fail or retry cleanup. */ }
}
