// Passive observation of the owned Main bridge. The original listener receives
// the original request; every write/end argument and callback passes unchanged.
// Actual build cancellation belongs to the visible compile-notice Stop button.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function nativeBuildObservation({ electron, descriptorFile, project }) {
  const descriptor = JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
  assert.ok(Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0);
  assert.ok(Number.isSafeInteger(descriptor.port) && descriptor.port > 0 && descriptor.port <= 65535);
  assert.ok(typeof descriptor.token === 'string' && descriptor.token.length > 0);
  assert.ok(typeof project === 'string' && path.isAbsolute(project));
  assert.ok(electron && typeof electron.evaluate === 'function');
  const key = 'aily-native-build-observation-' + randomUUID();
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
    const original = listeners[0], { createHash } = process.getBuiltinModule('crypto');
    const normalize = value => typeof value === 'string'
      ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : undefined;
    const uuid = value => typeof value === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const limit = 1024 * 1024;
    const state = { server, original, wrapper: undefined, requests: [], responses: new Set() };
    state.wrapper = function (req, res) {
      if (req.method !== 'POST' || req.url !== '/command') return original.call(this, req, res);
      let entry, requestBytes = 0, responseBytes = 0;
      const requestChunks = [], responseChunks = [], digest = createHash('sha256');
      const write = res.write, end = res.end;
      const collectRequest = chunk => {
        requestBytes += chunk.length;
        if (requestBytes <= limit) requestChunks.push(Buffer.from(chunk));
        else requestChunks.length = 0;
      };
      const parseRequest = () => {
        try {
          if (requestBytes > limit) return;
          const body = JSON.parse(Buffer.concat(requestChunks).toString('utf8'));
          if (body.token !== input.token || normalize(body.path) !== input.project
            || body.action !== 'blockly-live-operation'
            || !['project_build', 'project_build_status'].includes(body.operation)
            || !object(body.params)) return;
          const request = body.params.buildRequest;
          // Host receipt protocol v1; normal Agent starts use system UUIDs.
          if (!object(request) || request.version !== 1 || !uuid(request.requestId)
            || request.waitMs !== undefined && (!Number.isInteger(request.waitMs)
              || request.waitMs < 0 || request.waitMs > 10000)) return;
          const options = {};
          for (const name of ['preprocess_only', 'clear_cache']) {
            if (body.params[name] !== undefined && typeof body.params[name] !== 'boolean') return;
            if (body.params[name] !== undefined) options[name] = body.params[name];
          }
          entry = { operation: body.operation, requestId: request.requestId, requestVersion: request.version,
            ...(request.waitMs !== undefined ? { waitMs: request.waitMs } : {}), options, at: Date.now() };
          state.requests.push(entry);
        } catch { /* Unowned or malformed traffic is passed to the real listener. */ }
        finally { requestChunks.length = 0; }
      };
      const collectResponse = (chunk, encoding) => {
        if (!entry || chunk === undefined || chunk === null || typeof chunk === 'function') return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
          : Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk) ? Buffer.from(chunk) : undefined;
        if (!bytes) return;
        responseBytes += bytes.length;
        digest.update(bytes);
        if (responseBytes <= limit) responseChunks.push(bytes);
        else responseChunks.length = 0;
      };
      const restore = () => {
        if (res.write === wrappedWrite) res.write = write;
        if (res.end === wrappedEnd) res.end = end;
      };
      const detach = () => {
        restore();
        req.removeListener('data', collectRequest);
        req.removeListener('end', parseRequest);
        res.removeListener('finish', finish);
        res.removeListener('close', closed);
        requestChunks.length = responseChunks.length = 0;
        state.responses.delete(detach);
      };
      const finish = () => {
        if (entry) {
          const response = { status: res.statusCode, bytes: responseBytes,
            sha256: digest.digest('hex'), receiptMatchesRequest: false };
          try {
            if (responseBytes <= limit) {
              const reply = JSON.parse(Buffer.concat(responseChunks).toString('utf8'));
              if (typeof reply.ok === 'boolean') response.ok = reply.ok;
              if (['project_build', 'project_build_status'].includes(reply.operation)) response.operation = reply.operation;
              const receipt = reply.buildReceipt;
              if (object(receipt) && receipt.version === 1 && receipt.requestId === entry.requestId
                && normalize(receipt.project) === input.project && ['running', 'completed', 'unknown'].includes(receipt.state)
                && reply.operation === entry.operation) {
                response.receiptMatchesRequest = true;
                response.receipt = { version: receipt.version, requestId: receipt.requestId,
                  project: receipt.project, state: receipt.state };
              }
              const result = object(reply.result) ? reply.result : reply;
              const facts = {};
              if (typeof result.ok === 'boolean') facts.ok = result.ok;
              if (typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.code)) facts.code = result.code;
              if (['cancelled', 'failed', 'unknown', 'not-started', 'success'].includes(result.buildOutcome))
                facts.buildOutcome = result.buildOutcome;
              if (Object.keys(facts).length) response.result = facts;
            }
          } catch { /* The digest still describes the exact original non-JSON bytes. */ }
          entry.response = response;
        }
        detach();
      };
      const closed = () => {
        if (entry && !entry.response) entry.closedBeforeFinish = true;
        detach();
      };
      function wrappedWrite(...args) {
        collectResponse(args[0], args[1]);
        return write.apply(this, args);
      }
      function wrappedEnd(...args) {
        collectResponse(args[0], args[1]);
        // ServerResponse.end may call write internally. Restore before forwarding
        // so final bytes and the original completion callback are counted once.
        restore();
        return end.apply(this, args);
      }
      req.on('data', collectRequest);
      req.once('end', parseRequest);
      res.once('finish', finish);
      res.once('close', closed);
      res.write = wrappedWrite;
      res.end = wrappedEnd;
      state.responses.add(detach);
      try { return original.call(this, req, res); }
      catch (error) { detach(); throw error; }
    };
    server.removeListener('request', original);
    try {
      server.on('request', state.wrapper);
      globalThis[symbol] = state;
    } catch (error) {
      server.removeListener('request', state.wrapper);
      if (!server.rawListeners('request').includes(original)) server.on('request', original);
      throw error;
    }
  }, { key, pid: descriptor.pid, port: descriptor.port, token: descriptor.token,
    project: path.resolve(project).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() });
  let closed = false, latest;
  return {
    async sample() {
      if (closed) return latest;
      latest = await electron.evaluate((_electron, key) => {
        const state = globalThis[Symbol.for(key)];
        return state ? { requests: state.requests } : undefined;
      }, key);
      return latest;
    },
    async close() {
      if (closed) return;
      const value = await electron.evaluate((_electron, key) => {
        const symbol = Symbol.for(key), state = globalThis[symbol];
        if (!state) return;
        try {
          state.server.removeListener('request', state.wrapper);
        } finally {
          try {
            if (!state.server.rawListeners('request').includes(state.original)) state.server.on('request', state.original);
          } finally {
            for (const detach of [...state.responses]) detach();
            delete globalThis[symbol];
          }
        }
        return { requests: state.requests };
      }, key);
      latest = value ?? latest;
      closed = true;
    }
  };
}
