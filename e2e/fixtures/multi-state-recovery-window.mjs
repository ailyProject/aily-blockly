// Own-Desktop fault scheduling only: execute the real setters, lose two ACKs,
// then hold only the second original read during the real recovery preflight.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function multiStateRecoveryWindow({ electron, descriptorFile, project }) {
  const descriptor = JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
  assert.ok(Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0);
  assert.ok(Number.isSafeInteger(descriptor.port) && descriptor.port > 0);
  assert.ok(typeof descriptor.token === 'string' && descriptor.token.length > 0);
  const key = 'aily-multi-state-window-' + randomUUID();
  await electron.evaluate((_electron, input) => {
    const symbol = Symbol.for(input.key);
    if (process.pid !== input.pid || globalThis[symbol]) throw Error('Owned Main identity changed');
    const server = process._getActiveHandles().find(handle => {
      try { return typeof handle.listeners === 'function' && handle.address()?.port === input.port; }
      catch { return false; }
    });
    if (!server) throw Error('Owned bridge HTTP server was not found');
    const listeners = server.rawListeners('request');
    if (listeners.length !== 1) throw Error('Expected one original bridge listener');
    const state = { server, original: listeners[0], wrapper: undefined, mode: 'create',
      originals: [], trace: [], held: undefined, pending: undefined };
    state.release = () => {
      const pending = state.pending;
      state.pending = undefined;
      if (pending) {
        pending.res.end = pending.end;
        if (!pending.res.destroyed) pending.end.apply(pending.res, pending.args);
      }
    };
    state.wrapper = function (req, res) {
      let candidate, size = 0;
      const chunks = [];
      req.on('data', chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(Buffer.from(chunk)); });
      req.once('end', () => {
        try {
          if (size > 1024 * 1024) return;
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body.token !== input.token || body.action !== 'blockly-live-operation' ||
              typeof body.path !== 'string' || body.path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() !== input.project) return;
          const update = body.operation === 'blocks_set_state';
          const observe = body.operation === 'abs_recovery' && body.params?.action === 'observe_state' && body.params.originalTargetPid === input.pid;
          const request = update ? body.params : observe ? body.params.state : undefined;
          if (request?.version !== 2 || request.action !== 'update' || typeof request.requestId !== 'string' ||
              !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(request.requestId)) return;
          candidate = { phase: update ? 'update' : 'observe', requestId: 'pub2-' + request.requestId };
        } catch { /* Unrelated/non-JSON traffic is untouched. */ }
      });
      const end = res.end;
      res.end = function (...args) {
        let receipt, reply;
        if (candidate) {
          try { reply = JSON.parse(Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : args[0]); receipt = reply.saveReceipt; } catch {}
          const observation = reply?.publicationObservation;
          const ownObservation = observation?.version === 1 && observation.durable === true &&
            observation.requestId === candidate.requestId && observation.operation === 'blocks_set_state' &&
            observation.executor?.hostPid === input.pid && observation.observer?.hostPid === input.pid;
          const completed = ownObservation && receipt?.version === 2 && receipt.state === 'completed' &&
            receipt.operation === 'blocks_set_state' && receipt.requestId === candidate.requestId &&
            typeof receipt.project === 'string' && receipt.project.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === input.project &&
            [200, 400].includes(res.statusCode);
          const event = { ...candidate, status: res.statusCode, completed, at: Date.now() };
          state.trace.push(event);
          if (state.mode === 'create' && candidate.phase === 'update' && completed && state.originals.length < 2 && !state.originals.includes(candidate.requestId)) {
            state.originals.push(candidate.requestId);
            event.action = 'drop-completed-ack';
            res.end = end;
            res.destroy();
            return this;
          }
          if (state.mode === 'recover' && candidate.phase === 'observe' && candidate.requestId === state.originals[1] && completed && !state.held) {
            event.action = 'hold-second-original';
            state.held = { requestId: candidate.requestId, status: res.statusCode, receipt,
              bytes: Buffer.byteLength(args[0]), clientClosed: false };
            state.pending = { res, end, args };
            res.once('close', () => { state.held.clientClosed = true; });
            return this;
          }
        }
        res.end = end;
        return end.apply(this, args);
      };
      return state.original.call(this, req, res);
    };
    server.removeListener('request', state.original);
    server.on('request', state.wrapper);
    globalThis[symbol] = state;
  }, { key, pid: descriptor.pid, port: descriptor.port, token: descriptor.token,
    project: path.resolve(project).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() });
  let closed = false;
  return {
    async sample() {
      return electron.evaluate((_electron, key) => {
        const state = globalThis[Symbol.for(key)];
        return state ? { originals: state.originals, trace: state.trace, held: state.held, mode: state.mode } : undefined;
      }, key);
    },
    async arm() {
      await electron.evaluate((_electron, key) => {
        const state = globalThis[Symbol.for(key)];
        if (!state || state.mode !== 'create' || state.originals.length !== 2) throw Error('Need exactly two actual original completed setters');
        state.mode = 'recover';
      }, key);
    },
    async close() {
      if (closed) return;
      await electron.evaluate((_electron, key) => {
        const symbol = Symbol.for(key), state = globalThis[symbol];
        if (!state) return;
        try {
          state.server.removeListener('request', state.wrapper);
          if (!state.server.rawListeners('request').includes(state.original)) state.server.on('request', state.original);
        } finally { state.release(); delete globalThis[symbol]; }
      }, key);
      closed = true;
    },
  };
}
