'use strict';

const CHANNEL = 'aily-subapp-safe-storage-v1';
const ALLOWED_TOOL_IDS = new Set(['device-manager']);

// The host binds encrypted payloads to the actual child-process identity.
// Payload schemas, account scopes and persistence belong to the subapp.
function handleSubappSafeStorageMessage(toolId, streamId, message, safeStorage, send) {
    if (!ALLOWED_TOOL_IDS.has(toolId) || message?.channel !== CHANNEL || message.type !== 'request') {
        return false;
    }

    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const prefix = `aily-subapp:${toolId}:v1:`;
    let result;

    try {
        if (!requestId || requestId.length > 128) throw new Error('Invalid storage request');
        if (!safeStorage.isEncryptionAvailable()) throw new Error('System secure storage is unavailable');

        if (message.operation === 'encrypt') {
            const value = bounded(message.value, 68 * 1024, true);

            result = { ok: true, value: safeStorage.encryptString(prefix + value).toString('base64') };
        } else if (message.operation === 'decrypt') {
            const value = bounded(message.value, 256 * 1024);

            if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
                throw new Error('Invalid encrypted value');
            }

            const decoded = safeStorage.decryptString(Buffer.from(value, 'base64'));

            if (!decoded.startsWith(prefix)) throw new Error('Encrypted payload belongs to another subapp');

            result = { ok: true, value: decoded.slice(prefix.length) };
        } else {
            throw new Error('Unsupported storage operation');
        }
    } catch (error) {
        result = { ok: false, errorCode: 'HOST_SAFE_STORAGE_FAILED', message: error.message };
    }

    void send(streamId, { channel: CHANNEL, type: 'response', requestId, result });

    return true;
}

function bounded(value, maximum, empty = false) {
    if (typeof value !== 'string' || (!empty && !value) || value.length > maximum) {
        throw new Error('Invalid storage value');
    }

    return value;
}

module.exports = { handleSubappSafeStorageMessage };
