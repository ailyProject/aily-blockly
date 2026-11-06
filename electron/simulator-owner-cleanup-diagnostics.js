'use strict';
const { StringDecoder } = require('node:string_decoder');

const EVENT = 'simulator-owner-cleanup-stage-failed';
const MAX_LINE_BYTES = 1024;
const STAGES = new Set([
    'owner.scene-generation', 'owner.application', 'owner.workspace',
    'application.control-sessions', 'application.tool-launches',
    'application.artifact-reads', 'application.editor-locations',
]);
const ERROR_CODES = new Set([
    'artifact-in-use', 'artifact-unavailable', 'artifact-import-failed', 'artifact-capacity-reached',
    'cleanup-failed', 'cleanup-unconfirmed', 'closed', 'owner-closing', 'capacity-reached',
    'request-cancelled', 'control-closed', 'busy', 'session-conflict', 'session-not-found',
    'scene-close-failed', 'scene-not-found', 'launch-close-failed', 'launch-not-found',
    'authority-closed', 'attachment-not-found', 'owner-mismatch', 'owner-expired',
    'main-release-unconfirmed', 'gateway-failed', 'invalid-request', 'in-use',
    'source-invalid', 'source-missing', 'integrity-failed', 'scope-mismatch', 'workspace-busy',
    'aggregate-error', 'unclassified-error',
]);

// D12: only the existing private bounded D6/D9 formatter vocabulary may persist.
const INTERNAL_PREFIX = 'AILY_INTERNAL_CLEANUP_V1 ';
const MAX_BUFFER_LINE_BYTES = 4096;
const INTERNAL_PHASES = new Set(['main-view-disconnect', 'node-view-detach']);
const INTERNAL_SOURCES = new Set(['registered-view-cleanup', 'execution-view-detach', 'node-handler-cleanup', 'node-detach-result-send']);
const INTERNAL_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'AggregateError', 'DOMException', 'AbortError', 'TimeoutError', 'NonError']);
const INTERNAL_CODES = new Set(['unsupported', 'unavailable', 'permission-required', 'permission-denied', 'stale-scope', 'stale-epoch',
    'busy', 'backpressure', 'overflow', 'peer-disconnected', 'timeout', 'cancelled', 'delivery-unknown', 'cleanup-unconfirmed',
    'invalid-input', 'request-replayed', 'lease-revoked', 'grant-expired', 'grant-mismatch', 'backend-mismatch',
    'NODE_CONTROL_CLEANUP_UNCONFIRMED', 'NODE_CONTROL_CLOSED', 'NODE_CONTROL_FAILED', 'NODE_CONTROL_SEND_FAILED',
    'NODE_CONTROL_BUSY', 'NODE_CONTROL_INVALID_REQUEST', 'BROWSER_EXECUTION_CLEANUP_UNCONFIRMED',
    'BROWSER_EXECUTION_DISCONNECTED', 'BROWSER_EXECUTION_SEND_FAILED', 'BROWSER_EXECUTION_INVALID_RESULT']);
const INTERNAL_CATEGORIES = new Set(['unclassified', 'node-handler-cleanup-unconfirmed', 'node-control-cleanup-unconfirmed',
    'node-control-lifecycle-timeout', 'node-control-cleanup-deadline', 'local-network-cleanup-unconfirmed',
    'local-connection-cleanup-unconfirmed', 'guest-mapping-cleanup-unconfirmed', 'guest-service-cleanup-unconfirmed',
    'wireless-attachment-cleanup-unconfirmed', 'original-network-cleanup-unconfirmed', 'original-network-cleanup-unavailable',
    'original-network-owner-ended', 'network-binding-retired', 'browser-network-admission-ended', 'private-browser-owner-unavailable',
    'view-connection-cleanup-unconfirmed', 'browser-view-close-unconfirmed', 'cleanup-unconfirmed', 'permission-denied']);
const OBSERVATION_SOURCES = new Set(['node-pending-request-join', 'node-handler-close', 'node-network-original-ipc']);
const OBSERVATION_STATUSES = new Set(['rejected', 'submitted', 'delivery-unknown', 'confirmed', 'observer-timeout']);
const OBSERVATION_STAGES = new Set(['not-started', 'claiming', 'instruments', 'local-connections', 'build-workflow',
    'demonstrations', 'debugger-operations', 'debugger-launches', 'scene-view-release', 'returned']);
const OBSERVATION_WAITS = new Set(['not-entered', 'entered', 'returned']);
const ownRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => ownRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function internalFrame(value) {
    if (!ownRecord(value) || value.schemaVersion !== 1) return undefined;
    let projected;
    if (value.kind === 'aily-internal-cleanup-diagnostic') {
        if (!exactKeys(value, ['schemaVersion', 'kind', 'phase', 'truncated', 'nodes'])
            || !INTERNAL_PHASES.has(value.phase) || typeof value.truncated !== 'boolean'
            || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 16) return undefined;
        const nodes = [];
        for (const node of value.nodes) {
            if (!exactKeys(node, ['source', 'parent', 'depth', 'via', 'name', 'code', 'category'])
                || !INTERNAL_SOURCES.has(node.source) || !INTERNAL_NAMES.has(node.name)
                || (node.code !== null && !INTERNAL_CODES.has(node.code)) || !INTERNAL_CATEGORIES.has(node.category)
                || !Number.isSafeInteger(node.depth) || node.depth < 0 || node.depth >= 4) return undefined;
            if (node.parent === null) {
                if (node.depth !== 0 || node.via !== 'root') return undefined;
            } else {
                if (!Number.isSafeInteger(node.parent) || node.parent < 0 || node.parent >= nodes.length
                    || node.depth !== nodes[node.parent].depth + 1 || node.source !== nodes[node.parent].source
                    || (node.via !== 'aggregate' && node.via !== 'cause')) return undefined;
            }
            nodes.push({ source: node.source, parent: node.parent, depth: node.depth, via: node.via,
                name: node.name, code: node.code, category: node.category });
        }
        projected = { schemaVersion: 1, kind: 'aily-internal-cleanup-diagnostic', phase: value.phase,
            truncated: value.truncated, nodes };
    } else if (value.kind === 'aily-internal-cleanup-observation') {
        const keys = ['schemaVersion', 'kind', 'source', 'status'];
        for (const key of ['stage', 'serial', 'network']) if (Object.hasOwn(value, key)) keys.push(key);
        if (!exactKeys(value, keys) || !OBSERVATION_SOURCES.has(value.source) || !OBSERVATION_STATUSES.has(value.status)) return undefined;
        projected = { schemaVersion: 1, kind: 'aily-internal-cleanup-observation', source: value.source, status: value.status };
        for (const [key, vocabulary] of [['stage', OBSERVATION_STAGES], ['serial', OBSERVATION_WAITS], ['network', OBSERVATION_WAITS]]) {
            if (Object.hasOwn(value, key)) {
                if (!vocabulary.has(value[key])) return undefined;
                projected[key] = value[key];
            }
        }
    } else return undefined;
    return Buffer.byteLength(INTERNAL_PREFIX + JSON.stringify(projected) + '\n', 'utf8') <= MAX_BUFFER_LINE_BYTES ? projected : undefined;
}
// D12 end.

/** Persist only the existing safe Node stage projection in Main. A persistent
 * Runtime can outlive the Renderer command listener; raw stderr is not a log. */
function createSimulatorOwnerCleanupDiagnostics({ enabled, write: observer, notice: noticeObserver }) {
    // A failed observer is never a cleanup result, and is never awaited.
    const write = value => {
        try {
            const pending = observer(value);
            if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
        } catch { /* Diagnostic sink failure cannot affect command I/O. */ }
    };
    // Private presentation side-band only. Raw stderr is forwarded before push().
    // No observer is awaited or permitted to replace command/cleanup results.
    const notice = (classification, text) => {
        if (typeof noticeObserver !== 'function') return;
        try {
            const pending = noticeObserver({ classification, text });
            if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
        } catch { /* A notification sink is not a command result. */ }
    };
    const ordinaryText = value => {
        // Bound encoded notification bytes, including malformed UTF-8 replacement
        // expansion. The decoder retains at most one incomplete UTF-8 character.
        let text = '', size = 0;
        for (const character of value) {
            const next = Buffer.byteLength(character, 'utf8');
            if (size + next > MAX_BUFFER_LINE_BYTES) { notice('ordinary', text); text = ''; size = 0; }
            text += character; size += next;
        }
        if (text) notice('ordinary', text);
    };
    let closed = false, dropping = false, bytes = 0, parts = [], ordinaryMode = false, ordinaryDecoder;
    const ordinary = (chunk, final = false) => {
        if (typeof noticeObserver !== 'function') return;
        ordinaryDecoder ??= new StringDecoder('utf8');
        for (let at = 0; at < chunk.length; at += MAX_BUFFER_LINE_BYTES) {
            ordinaryText(ordinaryDecoder.write(chunk.subarray(at, at + MAX_BUFFER_LINE_BYTES)));
        }
        if (final) ordinaryText(ordinaryDecoder.end());
    };
    const reset = () => { dropping = false; bytes = 0; parts = []; ordinaryMode = false; ordinaryDecoder = undefined; };
    const prefix = Buffer.from(INTERNAL_PREFIX, 'utf8');
    const append = chunk => {
        if (!chunk.length) return;
        if (!dropping && chunk.length <= MAX_BUFFER_LINE_BYTES - bytes) {
            parts.push(Buffer.from(chunk)); bytes += chunk.length;
            if (ordinaryMode) ordinary(chunk);
            else {
                const held = Buffer.concat(parts, bytes);
                // Only a possible exact private prefix may delay notification.
                // All known ordinary stderr remains immediate, even without LF.
                if (!held.subarray(0, Math.min(bytes, prefix.length)).equals(prefix.subarray(0, Math.min(bytes, prefix.length)))) {
                    ordinaryMode = true; ordinary(held);
                }
            }
            return;
        }
        if (!ordinaryMode && bytes) ordinary(Buffer.concat(parts, bytes));
        ordinaryMode = true; dropping = true; bytes = 0; parts = [];
        // An overlong candidate cannot be private; no hidden or retained tail.
        ordinary(chunk);
    };
    const line = () => {
        if (!dropping && bytes) {
            const raw = Buffer.concat(parts, bytes);
            let internal;
            try {
                const text = raw.toString('utf8');
                if (text.startsWith(INTERNAL_PREFIX)) {
                    internal = internalFrame(JSON.parse(text.slice(INTERNAL_PREFIX.length)));
                    if (internal) write(internal);
                } else if (bytes <= MAX_LINE_BYTES) {
                    const value = JSON.parse(text);
                    if (value && typeof value === 'object' && !Array.isArray(value)
                        && Object.keys(value).sort().join(',') === 'errorCode,event,stage'
                        && value.event === EVENT && STAGES.has(value.stage) && ERROR_CODES.has(value.errorCode)) {
                        // Reconstruct, never forward a parsed object or extra fields.
                        write({ event: EVENT, stage: value.stage, errorCode: value.errorCode });
                    }
                }
            } catch { /* Bad input and a failed diagnostic sink cannot affect command I/O. */ }
            if (internal) notice('internal-cleanup', JSON.stringify(internal));
            else if (!ordinaryMode) ordinary(raw);
        }
        ordinary(Buffer.alloc(0), true);
        reset();
    };
    return Object.freeze({
        push(chunk) {
            if (!enabled || closed || !Buffer.isBuffer(chunk)) return;
            let start = 0;
            for (let index = 0; index < chunk.length; index++) {
                if (chunk[index] !== 10 && chunk[index] !== 13) continue;
                append(chunk.subarray(start, index)); line(); start = index + 1;
            }
            append(chunk.subarray(start));
        },
        close() {
            if (closed) return;
            closed = true;
            if (enabled) line(); else reset();
        },
    });
}

module.exports = { createSimulatorOwnerCleanupDiagnostics };
