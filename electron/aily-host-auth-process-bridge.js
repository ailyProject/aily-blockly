'use strict';

const AILY_HOST_AUTH_CHANNEL = 'aily-host-auth-v1';
const SUPPORTED_OPERATIONS = new Set(['access-token', 'refresh-access-token', 'logout']);
const HOST_MANAGED_AILY_TOOL_IDS = new Set(['aily-chat']);

function parseAilyHostAuthRequest(toolId, message) {
    if (
        !HOST_MANAGED_AILY_TOOL_IDS.has(toolId)
        || message?.channel !== AILY_HOST_AUTH_CHANNEL
        || message?.type !== 'request'
    ) {
        return { handled: false };
    }

    const requestId = typeof message.requestId === 'string' ? message.requestId.trim() : '';
    const operation = typeof message.operation === 'string' ? message.operation.trim() : '';
    if (!requestId || requestId.length > 128 || !SUPPORTED_OPERATIONS.has(operation)) {
        return {
            handled: true,
            valid: false,
            requestId,
            result: {
                ok: false,
                errorCode: 'HOST_AUTH_INVALID_REQUEST',
                message: 'Invalid Aily host authentication request',
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
        };
    }

    const generation = Number(value.generation);
    if (value.ok === true) {
        const accessToken = typeof value.accessToken === 'string' ? value.accessToken.trim() : '';
        const apiServer = normalizeApiServer(value.apiServer);
        return {
            ok: true,
            authenticated: value.authenticated === true,
            ...(Number.isInteger(generation) && generation >= 0 ? { generation } : {}),
            ...(accessToken ? { accessToken } : {}),
            ...(apiServer ? { apiServer } : {}),
        };
    }

    return {
        ok: false,
        errorCode: typeof value.errorCode === 'string' && value.errorCode.trim()
            ? value.errorCode.trim().slice(0, 80)
            : 'HOST_AUTH_FAILED',
        message: typeof value.message === 'string' && value.message.trim()
            ? value.message.trim().slice(0, 300)
            : 'The host authentication request failed',
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
