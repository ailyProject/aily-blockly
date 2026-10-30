'use strict';

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

/** Persist only the existing safe Node stage projection in Main. A persistent
 * Runtime can outlive the Renderer command listener; raw stderr is not a log. */
function createSimulatorOwnerCleanupDiagnostics({ enabled, write }) {
    let closed = false, dropping = false, bytes = 0, parts = [];
    const reset = () => { dropping = false; bytes = 0; parts = []; };
    const append = chunk => {
        if (dropping || !chunk.length) return;
        if (chunk.length > MAX_LINE_BYTES - bytes) { dropping = true; bytes = 0; parts = []; return; }
        parts.push(Buffer.from(chunk)); bytes += chunk.length;
    };
    const line = () => {
        if (!dropping && bytes) {
            try {
                const value = JSON.parse(Buffer.concat(parts, bytes).toString('utf8'));
                if (value && typeof value === 'object' && !Array.isArray(value)
                    && Object.keys(value).sort().join(',') === 'errorCode,event,stage'
                    && value.event === EVENT && STAGES.has(value.stage) && ERROR_CODES.has(value.errorCode)) {
                    // Reconstruct, never forward a parsed object or extra fields.
                    write({ event: EVENT, stage: value.stage, errorCode: value.errorCode });
                }
            } catch { /* Bad input and a failed diagnostic sink cannot affect command I/O. */ }
        }
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
