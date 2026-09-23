'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const cmd = require('./cmd');
const fault = (code, message) => Object.assign(new Error(message), { code });
const commands = { execute: cmd.executeCmdCommand, kill: cmd.killCmdProcess, get: cmd.getCmdProcess };

/** Native-only bootstrap over the existing command supervisor. Nothing in the
 * returned publicInfo contains the private control capability. No shell, replay,
 * package discovery or domain/session state belongs in this transport module. */
async function launchPrivateRuntime({ node, entry, args, credentialEnv, connect, signal, timeoutMs = 15000 }, processHost = commands) {
    if (!path.isAbsolute(entry) || typeof node !== 'string' || !Array.isArray(args)
        || !/^[A-Z][A-Z0-9_]+$/.test(credentialEnv) || typeof connect !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fault('INVALID_INPUT', 'Invalid native Runtime configuration.');
    signal?.throwIfAborted();
    const token = randomBytes(32).toString('hex'), streamId = `subapp-private-${randomUUID()}`;
    const child = processHost.execute({ command: node, args: [entry, ...args], cwd: path.dirname(entry), shellProfile: false,
        env: { [credentialEnv]: token }, streamId, messagePort: { transport: 'node-ipc-v1', maxMessageBytes: 4096 } }).process;
    let exited = false, exit, stopping, hostUrl, bytes = 0, buffer = '', settled = false;
    const ready = Promise.withResolvers(), closed = Promise.withResolvers();
    const fail = error => { if (!settled) { settled = true; ready.reject(error); } };
    child.once('error', () => fail(fault('SUBAPP_START_FAILED', 'Private Runtime process failed to start.')));
    child.once('close', (code, signal) => {
        exited = true; exit = { code, signal }; closed.resolve(exit);
        fail(fault('SUBAPP_EXITED', 'Private Runtime exited before ready.'));
    });
    const collect = (data, stdout) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 256 * 1024) { fail(fault('SUBAPP_OUTPUT_LIMIT', 'Private Runtime output limit exceeded.')); void stop().catch(() => {}); return; }
        if (!stdout || settled) return;
        buffer += data;
        for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (message.event === 'fatal') { fail(fault('SUBAPP_START_FAILED', 'Private Runtime reported startup failure.')); return; }
            if (message.event !== 'ready') continue;
            try {
                const data = message.data, url = new URL(data.url), ws = new URL(data.wsUrl);
                if (data.pid !== child.pid || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
                    || url.username || url.password || url.search || url.hash || url.pathname !== '/'
                    || ws.protocol !== 'ws:' || ws.host !== url.host || ws.pathname !== '/ws'
                    || ws.username || ws.password || ws.hash || !/^[a-f0-9]{64}$/.test(ws.searchParams.get('token') || '')
                    || ws.searchParams.get('token') === token) throw new Error();
                hostUrl = new URL(ws); hostUrl.search = ''; hostUrl.searchParams.set('token', token);
                // Whitelist, never forward arbitrary ready fields or logs.
                settled = true; ready.resolve(Object.freeze({ mode: 'serve', pid: child.pid, url: url.origin, wsUrl: ws.href }));
            } catch { fail(fault('SUBAPP_READY_INVALID', 'Private Runtime ready does not match the launched process.')); }
            return;
        }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => collect(data, true)); child.stderr.on('data', data => collect(data, false));
    const abort = () => fail(fault('CANCELLED', 'Private Runtime startup cancelled.'));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => fail(fault('SUBAPP_START_TIMEOUT', 'Private Runtime startup timed out.')), timeoutMs);
    async function stop() {
        if (stopping) return stopping;
        stopping = (async () => {
            if (!exited && hostUrl) {
                const shutdown = new URL(hostUrl); shutdown.protocol = 'http:'; shutdown.pathname = '/api/shutdown';
                try { await fetch(shutdown, { method: 'POST', signal: AbortSignal.timeout(3000) }); } catch { /* Registered tree fallback below. */ }
                let timer;
                await Promise.race([closed.promise, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); clearTimeout(timer);
            }
            if (!exited || processHost.get(streamId)) {
                const stopped = await processHost.kill(streamId);
                if (!stopped && processHost.get(streamId)) throw fault('SUBAPP_STOP_UNCONFIRMED', 'Private Runtime termination is unconfirmed.');
                await closed.promise;
            }
            if (processHost.get(streamId)) throw fault('SUBAPP_STOP_UNCONFIRMED', 'Private Runtime ownership is still retained.');
        })();
        try { return await stopping; } catch (error) { stopping = undefined; throw error; }
    }
    try {
        const publicInfo = await ready.promise;
        signal?.throwIfAborted();
        if (exited) throw fault('SUBAPP_EXITED', 'Private Runtime exited during startup.');
        return { publicInfo, streamId, stop, closed: closed.promise,
            get exited() { return exited; },
            connect: (handler, options) => {
                if (exited || stopping) throw fault('SUBAPP_EXITED', 'Private Runtime is not available.');
                return connect(hostUrl.href, handler, options);
            } };
    } catch (error) { await stop(); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { launchPrivateRuntime };
