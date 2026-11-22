'use strict';

const AILY_HOST_AUTH_CHANNEL = 'aily-host-auth-v1';
const TOOL_OPERATIONS = new Map([
    ['aily-chat', new Set(['access-token', 'refresh-access-token', 'logout'])],
    ['device-manager', new Set(['access-token', 'refresh-access-token'])],
]);
const HOST_FAILURES = new Map([
    ['AUTH_SIGNED_OUT', ['lease', 'The host account is signed out']],
    ['AUTH_CREDENTIAL_UNAVAILABLE', ['lease', 'The host access token is unavailable']],
    ['HOST_API_SERVER_UNAVAILABLE', ['lease', 'The host API server is unavailable']],
    ['AUTH_REFRESH_FAILED', ['refresh', 'The host could not refresh the access token']],
    ['AUTH_CREDENTIALS_LOCK_TIMEOUT', ['credential-lock', 'The host credential lock is busy']],
    ['AUTH_CREDENTIALS_LOCK_UNVERIFIED', ['credential-lock', 'The host credential lock could not be verified']],
    ['AUTH_CREDENTIALS_LOCK_SHUTDOWN', ['credential-lock', 'The host is closing']],
    ['AUTH_CREDENTIALS_LOCK_UNAVAILABLE', ['credential-lock', 'The host credential lock is unavailable']],
    ['AUTH_CREDENTIALS_STORAGE_DENIED', ['credential-storage', 'The host could not access its local credentials']],
    ['AUTH_CREDENTIALS_STORAGE_IO', ['credential-storage', 'The host credential storage operation failed']],
    ['AUTH_CREDENTIALS_IPC_UNAVAILABLE', ['credential-ipc', 'The host credential service is unavailable']],
    ['HOST_AUTH_INVALID_REQUEST', ['request', 'Invalid host authentication request']],
    ['HOST_AUTH_INVALID_RESPONSE', ['renderer-ipc', 'The host authentication service returned an invalid response']],
    ['HOST_AUTH_UNAVAILABLE', ['renderer-ipc', 'The host authentication service is unavailable']],
    ['HOST_AUTH_BUSY', ['renderer-ipc', 'The host authentication service is busy']],
    ['HOST_AUTH_TIMEOUT', ['renderer-ipc', 'The host authentication request timed out']],
    ['HOST_AUTH_FAILED', ['request', 'The host authentication operation failed']],
]);
const FALLBACK_PHASES = new Set(['request', 'initialize', 'lease', 'refresh', 'logout']);

function parseAilyHostAuthRequest(toolId, message) {
    if (
        !TOOL_OPERATIONS.has(toolId)
        || message?.channel !== AILY_HOST_AUTH_CHANNEL
        || message?.type !== 'request'
    ) {
        return { handled: false };
    }

    const requestId = typeof message.requestId === 'string' ? message.requestId.trim() : '';
    const operation = typeof message.operation === 'string' ? message.operation.trim() : '';

    if (!requestId || requestId.length > 128
        || !TOOL_OPERATIONS.get(toolId)?.has(operation)) {
        return {
            handled: true,
            valid: false,
            requestId,
            result: {
                ok: false,
                errorCode: 'HOST_AUTH_INVALID_REQUEST',
                message: 'Invalid aily host authentication request',
            },
        };
    }

    return {
        handled: true,
        valid: true,
        requestId,
        operation,
        ...(Number.isInteger(message.rejectedGeneration) && message.rejectedGeneration >= 0
            ? { rejectedGeneration: message.rejectedGeneration }
            : {}),
    };
}

function normalizeAilyHostAuthResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            ok: false,
            errorCode: 'HOST_AUTH_INVALID_RESPONSE',
            message: 'The host authentication service returned an invalid response',
            phase: 'renderer-ipc',
        };
    }

    const generation = Number(value.generation);
    if (value.ok === true) {
        const accessToken = typeof value.accessToken === 'string' ? value.accessToken.trim() : '';
        const apiServer = normalizeApiServer(value.apiServer);
        const accountId = typeof value.accountId === 'string' && value.accountId.length <= 128 ? value.accountId : '';
        return {
            ok: true,
            authenticated: value.authenticated === true,
            ...(Number.isInteger(generation) && generation >= 0 ? { generation } : {}),
            ...(accessToken ? { accessToken } : {}),
            ...(accountId ? { accountId } : {}),
            ...(apiServer ? { apiServer } : {}),
        };
    }

    const errorCode = HOST_FAILURES.has(value.errorCode) ? value.errorCode : 'HOST_AUTH_FAILED';
    const [phase, message] = HOST_FAILURES.get(errorCode);
    return {
        ok: false,
        errorCode,
        message,
        phase: errorCode === 'HOST_AUTH_FAILED' && FALLBACK_PHASES.has(value.phase) ? value.phase : phase,
        ...(Number.isInteger(generation) && generation >= 0 ? { generation } : {}),
    };
}

function normalizeApiServer(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
        url.pathname = url.pathname.replace(/\/+$/u, '');
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/+$/u, '');
    } catch {
        return '';
    }
}

module.exports = {
    AILY_HOST_AUTH_CHANNEL,
    normalizeAilyHostAuthResult,
    parseAilyHostAuthRequest,
};
