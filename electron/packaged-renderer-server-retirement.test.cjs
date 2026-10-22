const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { createPackagedRendererServer } = require('./packaged-renderer-server');

// A serial transport difference check, independent of Electron and Node's test runner.
// Every wait is bounded; finally owns and closes only the test's sockets/FDs/server.
const DEADLINE_MS = 1000;

async function bounded(task, label) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: ${DEADLINE_MS}ms deadline`)), DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function controlledServer() {
  const server = new EventEmitter();
  Object.assign(server, {
    listening: false,
    listen() {},
    address() { return { port: 49153 }; },
    close(callback) { server.listening = false; callback(); },
  });
  return server;
}

async function fixture(check) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-http-retirement-'));
  const sockets = new Set();
  const servers = new Set();
  const streams = new Set();
  const release = new Set();
  const trackSocket = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const createHttpServer = (handler) => {
    const server = http.createServer(handler);
    servers.add(server);
    server.on('connection', trackSocket);
    return server;
  };
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>retirement</title>');
  fs.writeFileSync(path.join(directory, 'native.cjs'), 'module.exports = 1;');
  try {
    return await check({ directory, trackSocket, createHttpServer, streams, release });
  } finally {
    for (const resume of release) resume();
    for (const stream of streams) stream.destroy();
    for (const socket of sockets) socket.destroy();
    await bounded(Promise.all([...servers].map((server) => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    }))), 'fixture listener cleanup');
    await bounded(Promise.all([...streams].map((stream) => stream.closed
      ? Promise.resolve() : once(stream, 'close'))), 'fixture file cleanup');
    const relative = path.relative(os.tmpdir(), directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true });
  }
}

function get(origin, relative) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}/${relative}`, { agent: false }, (response) => {
      response.resume();
      response.once('end', () => resolve(response));
      response.once('error', reject);
    });
    request.once('error', reject);
  });
}

async function preconnectCheck(strictPublicFiles) {
  await fixture(async ({ directory, createHttpServer, trackSocket }) => {
    const server = createPackagedRendererServer({ createHttpServer, strictPublicFiles, crossOriginIsolated: true });
    const ready = await bounded(server.start({ rootDirectory: directory }), 'start');
    const response = await bounded(get(ready.origin, ''), 'normal file request');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['cross-origin-embedder-policy'], 'require-corp');
    assert.equal((await bounded(get(ready.origin, 'native.cjs'), 'policy request')).statusCode,
      strictPublicFiles ? 404 : 200);
    const socket = trackSocket(net.connect(ready.port, '127.0.0.1'));
    await bounded(once(socket, 'connect'), 'preconnect');
    const socketClosed = once(socket, 'close');
    const closing = server.close();
    assert.equal(server.close(), closing, 'concurrent closes share the same cleanup');
    await bounded(closing, 'owned preconnect retirement');
    await bounded(socketClosed, 'client physical socket close');
    assert.equal(server.status().state, 'stopped');
    await assert.rejects(bounded(get(ready.origin, ''), 'closed port request'), /ECONNREFUSED/);
  });
}

async function fileCloseCheck(strictPublicFiles) {
  await fixture(async ({ directory, createHttpServer, streams, release }) => {
    fs.writeFileSync(path.join(directory, 'active.bin'), Buffer.alloc(64 * 1024, 42));
    const destroyEntered = deferred();
    let activeStream;
    let resumeDestroy = () => {};
    const server = createPackagedRendererServer({
      createHttpServer,
      strictPublicFiles,
      fs: {
        ...fs,
        createReadStream(filePath) {
          const stream = fs.createReadStream(filePath, { highWaterMark: 1 });
          activeStream = stream;
          streams.add(stream);
          stream.once('data', () => stream.pause());
          const originalDestroy = stream._destroy;
          stream._destroy = function holdActualFileClose(error, callback) {
            let resumed = false;
            resumeDestroy = () => {
              if (resumed) return;
              resumed = true;
              originalDestroy.call(this, error, callback);
            };
            release.add(resumeDestroy);
            destroyEntered.resolve();
          };
          return stream;
        },
      },
    });
    const ready = await bounded(server.start({ rootDirectory: directory }), 'file start');
    const request = http.get(`${ready.origin}/active.bin`, { agent: false });
    request.on('error', () => {});
    const [response] = await bounded(once(request, 'response'), 'active response');
    response.on('error', () => {});
    response.pause();
    let retired = false;
    const closing = server.close().then(() => { retired = true; });
    await bounded(destroyEntered.promise, 'file destroy invoked');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retired, false, 'destroy requested is not a file close acknowledgement');
    assert.equal(activeStream.closed, false);
    assert.equal(typeof activeStream.fd, 'number', 'the real file descriptor remains owned');
    assert.equal(server.status().state, 'ready', 'ready resource remains accountable until close');
    resumeDestroy();
    await bounded(closing, 'actual file close retirement');
    assert.equal(activeStream.closed, true);
    assert.equal(activeStream.fd, null);
    assert.equal(server.status().state, 'stopped');
    request.destroy();
  });
}

async function failedCloseCheck(strictPublicFiles) {
  await fixture(async ({ directory }) => {
    const raw = controlledServer();
    let fail = true;
    let closes = 0;
    raw.listen = () => { raw.listening = true; queueMicrotask(() => raw.emit('listening')); };
    raw.close = (callback) => {
      closes += 1;
      if (fail) callback(new Error('Controlled original socket cleanup failure'));
      else { raw.listening = false; callback(); }
    };
    const server = createPackagedRendererServer({ strictPublicFiles, createHttpServer: () => raw });
    await bounded(server.start({ rootDirectory: directory }), 'mock start');
    await assert.rejects(server.close(), /original socket cleanup failure/);
    assert.equal(server.status().state, 'ready');
    assert.equal(raw.listening, true);
    await assert.rejects(server.start({ rootDirectory: directory }), /cleanup must complete/);
    fail = false;
    await bounded(server.close(), 'original resource retry');
    assert.equal(closes, 2);
    assert.equal(server.status().state, 'stopped');
  });
}

async function failedFileCloseCheck() {
  await fixture(async ({ directory, createHttpServer, streams }) => {
    fs.writeFileSync(path.join(directory, 'active.bin'), Buffer.alloc(64 * 1024, 42));
    let activeStream;
    const originalError = new Error('Controlled file close business outcome');
    const server = createPackagedRendererServer({
      createHttpServer,
      fs: {
        ...fs,
        createReadStream(filePath) {
          const stream = fs.createReadStream(filePath, { highWaterMark: 1 });
          activeStream = stream;
          streams.add(stream);
          stream.once('data', () => stream.pause());
          const originalDestroy = stream._destroy;
          stream._destroy = function failAfterActualFileClose(error, callback) {
            originalDestroy.call(this, error, (closeError) => callback(closeError || originalError));
          };
          return stream;
        },
      },
    });
    const ready = await bounded(server.start({ rootDirectory: directory }), 'file error start');
    const request = http.get(`${ready.origin}/active.bin`, { agent: false });
    request.on('error', () => {});
    const [response] = await bounded(once(request, 'response'), 'file error response');
    response.on('error', () => {});
    response.pause();
    await assert.rejects(bounded(server.close(), 'file error retirement'), (error) => error === originalError);
    assert.equal(activeStream.closed, true, 'physical file close is separately witnessed');
    assert.equal(activeStream.fd, null);
    assert.equal(server.status().state, 'ready', 'a business cleanup failure is not success');
    await assert.rejects(server.start({ rootDirectory: directory }), /cleanup must complete/);
    await bounded(server.close(), 'closed original file explicit retry');
    assert.equal(server.status().state, 'stopped');
    request.destroy();
  });
}

async function lateListenCheck() {
  await fixture(async ({ directory }) => {
    const raws = [];
    const closed = deferred();
    const server = createPackagedRendererServer({ createHttpServer: () => {
      const raw = controlledServer();
      raws.push(raw);
      raw.close = (callback) => { closed.promise.then(() => { raw.listening = false; callback(); }); };
      if (raws.length > 1) raw.listen = () => {
        raw.listening = true;
        queueMicrotask(() => raw.emit('listening'));
      };
      return raw;
    } });
    const starting = server.start({ rootDirectory: directory });
    const closing = server.close();
    let restarted = false;
    const restarting = server.start({ rootDirectory: directory }).then(() => { restarted = true; });
    assert.equal(raws.length, 1);
    raws[0].listening = true;
    raws[0].emit('listening');
    await bounded(starting, 'late listening result');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarted, false);
    assert.equal(raws.length, 1, 'no second listener before original close acknowledgement');
    closed.resolve();
    await bounded(closing, 'late listener retirement');
    await bounded(restarting, 'serialized restart');
    assert.equal(raws.length, 2);
    await bounded(server.close(), 'restarted listener close');
    assert.equal(server.status().state, 'stopped');
  });
}

async function failedStartupCheck() {
  await fixture(async ({ directory }) => {
    const raw = controlledServer();
    raw.listen = () => queueMicrotask(() => raw.emit('error', new Error('Controlled listen failure')));
    let closeFails = true;
    raw.close = (callback) => callback(closeFails ? new Error('Controlled startup cleanup failure') : undefined);
    const server = createPackagedRendererServer({ createHttpServer: () => raw });
    await assert.rejects(server.start({ rootDirectory: directory }), (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.errors[0].message, /listen failure/);
      assert.match(error.errors[1].message, /startup cleanup failure/);
      return true;
    });
    assert.equal(server.status().state, 'closing');
    await assert.rejects(server.start({ rootDirectory: directory }), /cleanup must complete/);
    closeFails = false;
    await bounded(server.close(), 'failed startup resource retry');
    assert.equal(server.status().state, 'stopped');
  });
}

async function runPackagedRendererRetirementChecks() {
  const cases = [];
  for (const strict of [false, true]) {
    cases.push([`${strict ? 'strict' : 'default'} raw preconnect and unchanged admission`, () => preconnectCheck(strict)]);
    cases.push([`${strict ? 'strict' : 'default'} real ReadStream FD close acknowledgement`, () => fileCloseCheck(strict)]);
    cases.push([`${strict ? 'strict' : 'default'} failed close keeps original retry obligation`, () => failedCloseCheck(strict)]);
  }
  cases.push(['late listen is retired before a serialized restart', lateListenCheck]);
  cases.push(['startup failure retains original cleanup error and resource', failedStartupCheck]);
  cases.push(['file close business error survives physical close until explicit retry', failedFileCloseCheck]);
  const results = [];
  for (const [name, check] of cases) {
    const started = performance.now();
    await bounded(check(), name);
    results.push({ name, passed: true, elapsedMs: Math.round(performance.now() - started) });
  }
  return { passed: true, cases: results, deadlineMs: DEADLINE_MS, electron: false, angularBuild: false };
}

module.exports = { runPackagedRendererRetirementChecks };

if (require.main === module) {
  runPackagedRendererRetirementChecks().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
