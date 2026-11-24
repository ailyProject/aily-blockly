// Test-owned scheduling of an actual Electron Main HTTP response. Commands and
// response bytes are unchanged; no descriptor, Host source or endpoint is moved.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function nativeObservationWindow({ electron, descriptorFile, project, requestId, initialPublication = false, operation = 'project_save' }) {
  const descriptor = JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
  assert.ok(Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0);
  assert.ok(Number.isSafeInteger(descriptor.port) && descriptor.port > 0);
  assert.ok(typeof descriptor.token === 'string' && descriptor.token.length > 0);
  assert.ok(electron && typeof electron.evaluate === 'function');
  assert.ok(['project_save', 'blocks_set_state'].includes(operation));
  const key = 'aily-native-observation-window-' + randomUUID();
  await electron.evaluate((_electron, input) => {
    const symbol = Symbol.for(input.key);
    if (process.pid !== input.pid || globalThis[symbol]) throw Error('Owned Main identity changed');
    const server = process._getActiveHandles().find(handle => {
      try { return typeof handle.listeners === 'function' && handle.address()?.port === input.port; }
      catch { return false; }
    });
    if (!server) throw Error('Owned bridge HTTP server was not found');
    const listeners = server.rawListeners('request');
    if (listeners.length !== 1) throw Error('Owned bridge must have one original request listener');
    const original = listeners[0];
    const state = { server, original, wrapper: undefined, held: undefined, pending: undefined, trace: [], statusSeen: false, historySeen: false, released: false };
    state.release = () => {
      state.released = true;
      const pending = state.pending;
      state.pending = undefined;
      if (pending) {
        pending.res.end = pending.end;
        if (!pending.res.destroyed) pending.end.apply(pending.res, pending.args);
      }
    };
    state.wrapper = function (req, res) {
      let phase, bytes = 0;
      const chunks = [];
      const collect = chunk => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) chunks.push(Buffer.from(chunk));
      };
      const parse = () => {
        try {
          if (bytes > 1024 * 1024) return;
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const own = body.token === input.token && typeof body.path === 'string' && body.path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === input.project;
          if (!own) return;
          if (input.initialPublication) {
            if (input.operation === 'blocks_set_state') {
              if (body.action !== 'blockly-live-operation') return;
              const update = body.operation === 'blocks_set_state';
              const observe = body.operation === 'abs_recovery' && body.params?.action === 'observe_state';
              const request = update ? body.params : observe ? body.params?.state : undefined;
              if (request?.version !== 2 || request.action !== 'update' || typeof request.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request.requestId)) return;
              const nativeRequestId = 'pub2-' + request.requestId;
              if (update && !state.requestId) state.requestId = nativeRequestId;
              if (nativeRequestId === state.requestId && !state.held) phase = 'publication';
              return;
            }
            const request = body.params?.saveRequest;
            if (body.operation === 'project_save' && request?.version === 2 && /^pub2-[a-f0-9-]{36}$/.test(request.requestId) && !state.requestId) state.requestId = request.requestId;
            if (['project_save', 'project_publication_status'].includes(body.operation) && request?.requestId === state.requestId && state.requestId && !state.held) {
              phase = 'publication';
            }
            return;
          }
          if (body.operation === 'project_publication_status' && body.params?.saveRequest?.requestId === input.requestId) phase = 'status';
          else if (state.statusSeen && body.operation === 'abs_recovery' && body.params?.action === 'history_inspect') phase = 'history';
          else if (state.historySeen && body.operation === 'abs_recovery' && body.params?.action === 'candidate_capture' && !state.held && !state.released) phase = 'capture';
        } catch { /* Non-JSON traffic remains untouched. */ }
      };
      req.on('data', collect);
      req.once('end', parse);
      const end = res.end;
      res.end = function (...args) {
        if (phase) state.trace.push({ phase, responseStatus: res.statusCode, at: Date.now() });
        if (phase === 'status' && res.statusCode === 200) state.statusSeen = true;
        if (phase === 'history' && res.statusCode === 200) state.historySeen = true;
        let completedPublication;
        // An exact completed state receipt can accompany a partial HTTP400 error.
        const publicationResponse = res.statusCode === 200 || (input.operation === 'blocks_set_state' && res.statusCode === 400);
        if (phase === 'publication' && publicationResponse) {
          try {
            const reply = JSON.parse(Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : args[0]);
            const receipt = reply.saveReceipt;
            const ownReceipt = input.operation === 'project_save' || (typeof receipt?.project === 'string' && receipt.project.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === input.project);
            if (receipt?.version === 2 && receipt.state === 'completed' && receipt.requestId === state.requestId && receipt.operation === input.operation && ownReceipt) {
              completedPublication = { requestId: receipt.requestId, receipt, publication: reply.result?.publication ?? reply.publication, targetPid: reply.targetPid };
            }
          } catch { /* An invalid or nonterminal reply is never held as a known commit. */ }
        }
        if (((phase === 'capture' && res.statusCode === 200) || completedPublication) && !state.held && !state.released) {
          const body = args[0];
          state.held = { pid: process.pid, requestId: completedPublication?.requestId ?? input.requestId, responseStatus: res.statusCode, bytes: typeof body === 'string' ? Buffer.byteLength(body, typeof args[1] === 'string' ? args[1] : undefined) : body?.length ?? 0, clientClosed: false, ...(completedPublication ? { originalPublication: completedPublication } : {}) };
          state.pending = { res, end, args };
          res.once('close', () => { state.held.clientClosed = true; });
          return this;
        }
        res.end = end;
        return end.apply(this, args);
      };
      return original.call(this, req, res);
    };
    server.removeListener('request', original);
    server.on('request', state.wrapper);
    globalThis[symbol] = state;
  }, { key, pid: descriptor.pid, port: descriptor.port, token: descriptor.token, project: path.resolve(project).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(), requestId, initialPublication, operation });
  let held, trace = [], closed = false;
  return {
    get held() { return held; },
    get trace() { return trace; },
    async sample() {
      const value = await electron.evaluate((_electron, key) => {
        const state = globalThis[Symbol.for(key)];
        return state ? { held: state.held, trace: state.trace } : undefined;
      }, key);
      if (value) { held = value.held; trace = value.trace; }
      return value;
    },
    async release() {
      if (!closed) await electron.evaluate((_electron, key) => globalThis[Symbol.for(key)]?.release(), key);
    },
    async close() {
      if (closed) return;
      await electron.evaluate((_electron, key) => {
        const symbol = Symbol.for(key), state = globalThis[symbol];
        if (!state) return;
        try {
          state.server.removeListener('request', state.wrapper);
          if (!state.server.rawListeners('request').includes(state.original)) state.server.on('request', state.original);
        } finally {
          state.release();
          delete globalThis[symbol];
        }
      }, key);
      closed = true;
    },
  };
}
