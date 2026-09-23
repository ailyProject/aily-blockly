'use strict';

// A bounded display projection, not an engine/session/history store.
const idleSnapshot = () => ({ schemaVersion: 1, phase: 'idle', outcome: 'idle', steps: [], uart: '', canStop: false });
function projectProgress(previous, data) {
    const fields = ['schemaVersion', 'phase', 'outcome', 'steps', 'uart', 'uartTruncated', 'debugState', 'frame',
        'error', 'cleanup', 'timingsMs', 'durationMs', 'evidenceDirectory', 'displayTruncated'];
    let next = Object.fromEntries(fields.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]));
    if (data.firmware && typeof data.firmware === 'object') next.firmware = {
        artifactId: String(data.firmware.artifactId || '').slice(0, 128),
        target: String(data.firmware.target || '').slice(0, 80),
        board: String(data.firmware.board || '').slice(0, 128),
    };
    if (Buffer.byteLength(JSON.stringify(next)) > 128 * 1024) {
        next = { phase: data.phase, outcome: data.outcome, displayTruncated: true,
            error: data.error ? { code: String(data.error.code || '').slice(0, 128), message: String(data.error.message || '').slice(0, 1024) } : undefined };
    }
    if (Array.isArray(next.steps)) next.steps = next.steps.map(step => ({ ...previous.steps?.find(old => old.id === step.id), ...step }));
    const merged = { ...previous, ...next };
    if (Buffer.byteLength(JSON.stringify(merged)) > 128 * 1024) {
        // Even small patches can accumulate large non-log fields. Keep only a
        // bounded status/error fallback, never a partially unbounded object.
        return { ...idleSnapshot(), phase: String(merged.phase || '').slice(0, 64),
            outcome: String(merged.outcome || '').slice(0, 64), displayTruncated: true,
            error: merged.error ? { code: String(merged.error.code || '').slice(0, 128),
                message: String(merged.error.message || '').slice(0, 1024) } : undefined };
    }
    return merged;
}
module.exports = { idleSnapshot, projectProgress };
