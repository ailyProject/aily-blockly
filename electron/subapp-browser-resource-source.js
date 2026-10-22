'use strict';

const { createHash } = require('node:crypto');
const { PROTOCOL, relativeEntry } = require('./subapp-browser-execution-source');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (record, keys) => record && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).sort().join(',') === [...keys].sort().join(',');

/** Main-only resource selection. The expected release identity and manifest
 * must come from trusted package/deployment selection, never Renderer IPC.
 * This adapter verifies public content; it grants no domain/Node authority. */
function createTrustedBrowserResourceServer({ source, resourceBaseUrl, releaseId, manifest,
    allowLoopbackHttp = false, timeoutMs = 10000, fetchImpl = globalThis.fetch }) {
    if (source?.protocol !== PROTOCOL || typeof source.identity !== 'string' || !source.identity
        || !/^[a-f0-9]{64}$/.test(source.sha256 || '') || !/^[a-f0-9]{64}$/.test(releaseId || '')
        || typeof resourceBaseUrl !== 'string' || typeof fetchImpl !== 'function'
        || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) {
        throw new TypeError('Invalid trusted Browser resource selection');
    }
    const base = new URL(resourceBaseUrl);
    if (base.href !== resourceBaseUrl || base.username || base.password || base.search || base.hash
        || base.protocol !== 'https:' && !(allowLoopbackHttp === true && base.protocol === 'http:' && base.hostname === '127.0.0.1')
        || !base.pathname.endsWith(`/releases/${releaseId}/`)) {
        throw new TypeError('Browser resources require an exact trusted version URL');
    }
    relativeEntry(base.pathname.slice(1, -1));
    const frozen = structuredClone(manifest);
    if (!exact(frozen, ['schemaVersion', 'kind', 'packageIdentity', 'files']) || frozen.schemaVersion !== 1
        || frozen.kind !== 'aily-browser-resource-release'
        || !exact(frozen.packageIdentity, ['name', 'version'])
        || frozen.packageIdentity.name !== source.packageName || frozen.packageIdentity.version !== source.version
        || !Array.isArray(frozen.files) || !frozen.files.length || frozen.files.length > 4096
        || digest(JSON.stringify(frozen)) !== releaseId) {
        throw new TypeError('Browser resource manifest does not match the selected package and release');
    }
    const pins = new Map();
    for (const file of frozen.files) {
        if (!exact(file, ['path', 'bytes', 'sha256']) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
            || file.bytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) {
            throw new TypeError('Invalid public Browser resource pin');
        }
        relativeEntry(file.path);
        if (pins.has(file.path)) throw new TypeError('Duplicate public Browser resource path');
        pins.set(file.path, Object.freeze(file));
    }
    const entry = relativeEntry(source.entry), entryPin = pins.get(entry);
    if (!entryPin || entryPin.sha256 !== source.sha256 || entryPin.bytes > 1024 * 1024) {
        throw new TypeError('Published execution entry differs from the selected installed entry');
    }
    for (const value of Object.values(source.surfaces || {})) {
        if (!pins.has(relativeEntry(value))) throw new TypeError('Published Browser surface is absent from the selected release');
    }
    const resourcePaths = Object.freeze([...pins.keys()]);
    const location = Object.freeze({ origin: base.origin, resourceBaseUrl: base.href, resourceIdentity: releaseId, resourcePaths });
    let closed = false, starting, controller;
    return Object.freeze({
        start() {
            if (closed) return Promise.reject(new Error('Browser resource selection is closed'));
            if (starting) return starting;
            controller = new AbortController();
            const active = controller;
            starting = (async () => {
                const timer = setTimeout(() => active.abort(new Error('Browser resource verification deadline exceeded')), timeoutMs);
                let reader;
                try {
                    const url = new URL(entry, base).href;
                    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: active.signal });
                    active.signal.throwIfAborted();
                    if (response.status !== 200 || response.redirected || response.url !== url
                        || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')
                        || Number(response.headers.get('content-length') || 0) > entryPin.bytes) {
                        await response.body?.cancel(); throw new Error('Trusted Browser document response is unavailable');
                    }
                    if (!response.body) throw new Error('Trusted Browser document body is missing');
                    reader = response.body.getReader();
                    const chunks = []; let size = 0;
                    for (;;) {
                        const { done, value } = await reader.read(); active.signal.throwIfAborted();
                        if (done) break;
                        size += value.byteLength;
                        if (size > entryPin.bytes) throw new Error('Trusted Browser document exceeds its selected size');
                        chunks.push(Buffer.from(value));
                    }
                    if (size !== entryPin.bytes || digest(Buffer.concat(chunks)) !== entryPin.sha256) {
                        throw new Error('Trusted Browser document content identity differs');
                    }
                    if (closed) throw new Error('Browser resource selection closed during verification');
                    return location;
                } finally {
                    clearTimeout(timer);
                    await reader?.cancel().catch(() => {});
                }
            })().catch(error => { starting = undefined; throw error; });
            return starting;
        },
        async close() {
            closed = true; controller?.abort(new Error('Browser resource selection closed'));
            await starting?.catch(() => {});
        },
    });
}

module.exports = { createTrustedBrowserResourceServer };
