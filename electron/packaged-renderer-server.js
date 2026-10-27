const fs = require('fs');
const http = require('http');
const path = require('path');

const LOOPBACK_HOST = '127.0.0.1';
const MAX_REQUEST_URL_LENGTH = 16 * 1024;

function createPackagedRendererServer(options = {}) {
  const createHttpServer = options.createHttpServer || http.createServer;
  const fsImplementation = options.fs || fs;
  const indexFile = options.indexFile || 'index.html';
  let state = null;
  let owned = null;
  let startTask = null;
  let closeTask = null;

  async function start(startOptions = {}) {
    if (closeTask) await closeTask;
    if (owned?.retiring) {
      throw new Error('Packaged renderer server cleanup must complete before restart.');
    }
    if (startTask) return startTask;
    if (state) return publicState(state);
    startTask = startInternal(startOptions).finally(() => {
      startTask = null;
    });
    return startTask;
  }

  async function startInternal(startOptions) {
    const rootDirectory = requireRendererRoot(
      startOptions.rootDirectory,
      fsImplementation,
    );
    const indexPath = resolveContainedFile(
      rootDirectory,
      indexFile,
      fsImplementation,
    );
    if (!indexPath) {
      throw new Error('Packaged renderer index.html is unavailable.');
    }

    let expectedHost = null;
    let resource;
    const server = createHttpServer((request, response) => {
      if (resource.retiring) {
        response.destroy();
        return;
      }
      void handleRequest({
        request,
        response,
        rootDirectory,
        expectedHost,
        fsImplementation,
        indexFile,
        securityOptions: options,
        resource,
      }).catch(() => {
        if (response.destroyed) return;
        if (!response.headersSent) {
          writeEmpty(response, 500);
        } else {
          response.destroy();
        }
      });
    });
    resource = {
      server,
      rootDirectory,
      retiring: false,
      listenerClosed: false,
      sockets: new Map(),
      streams: new Map(),
    };
    owned = resource;
    server.on('connection', (socket) => {
      const closed = new Promise((resolve) => {
        socket.once('close', () => {
          resource.sockets.delete(socket);
          resolve();
        });
      });
      resource.sockets.set(socket, closed);
      if (resource.retiring) socket.destroy();
    });

    try {
      const address = await listen(server);
      expectedHost = `${LOOPBACK_HOST}:${address.port}`;
      resource.port = address.port;
      resource.origin = `http://${expectedHost}`;
      state = resource;
      return publicState(state);
    } catch (error) {
      try {
        await retireResource(resource);
        if (owned === resource) owned = null;
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError],
          'Packaged renderer startup and cleanup both failed.');
      }
      throw error;
    }
  }

  function status() {
    return state ? publicState(state) : {
      state: owned ? (owned.retiring ? 'closing' : 'starting') : 'stopped',
    };
  }

  function rendererUrl(hash = '') {
    if (!state || state.retiring) {
      throw new Error('Packaged renderer server is not started.');
    }
    return createRendererUrl(state.origin, hash);
  }

  function close() {
    if (closeTask) return closeTask;
    const pendingStart = startTask;
    if (owned) owned.retiring = true;
    closeTask = (async () => {
      // A late listen result remains ours, including a failed startup's cleanup.
      if (pendingStart) await pendingStart.catch(() => undefined);
      const closing = owned;
      if (!closing) return;
      await retireResource(closing);
      if (state === closing) state = null;
      if (owned === closing) owned = null;
    })().finally(() => {
      closeTask = null;
    });
    return closeTask;
  }

  return Object.freeze({
    start,
    close,
    rendererUrl,
    status,
  });
}

async function handleRequest(options) {
  const {
    request,
    response,
    rootDirectory,
    expectedHost,
    fsImplementation,
    indexFile,
    securityOptions,
    resource,
  } = options;
  applySecurityHeaders(response, securityOptions);
  if (!expectedHost || request.headers.host !== expectedHost) {
    writeEmpty(response, 421);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    writeEmpty(response, 405);
    return;
  }
  const relativePath = parseRequestPath(request.url);
  if (relativePath === null) {
    writeEmpty(response, 400);
    return;
  }
  const filePath = resolveContainedFile(
    rootDirectory,
    relativePath || indexFile,
    fsImplementation,
  );
  if (!filePath) {
    writeEmpty(response, 404);
    return;
  }
  if (securityOptions?.strictPublicFiles === true && !isStrictPublicFile(rootDirectory, relativePath || indexFile, fsImplementation)) {
    writeEmpty(response, 404);
    return;
  }
  const stat = fsImplementation.statSync(filePath);
  response.statusCode = 200;
  response.setHeader('Content-Type', mimeType(filePath));
  response.setHeader('Content-Length', String(stat.size));
  response.setHeader(
    'Cache-Control',
    path.basename(filePath).toLowerCase() === 'index.html'
      ? 'no-store'
      : 'no-cache',
  );
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await pipeFile(fsImplementation, filePath, response, resource);
}

function parseRequestPath(requestUrl) {
  if (
    typeof requestUrl !== 'string'
    || requestUrl.length === 0
    || requestUrl.length > MAX_REQUEST_URL_LENGTH
  ) {
    return null;
  }
  const queryIndex = requestUrl.search(/[?#]/);
  const rawPathname = queryIndex >= 0
    ? requestUrl.slice(0, queryIndex)
    : requestUrl;
  if (!rawPathname.startsWith('/') || rawPathname.includes('\\')) {
    return null;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (
    pathname.includes('\0')
    || pathname.includes('\\')
    || pathname.split('/').includes('..')
  ) {
    return null;
  }
  const relative = pathname.replace(/^\/+/, '');
  if (!relative) return '';
  if (relative.endsWith('/')) return null;
  const normalized = path.posix.normalize(relative);
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function requireRendererRoot(value, fsImplementation) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Packaged renderer rootDirectory is required.');
  }
  let resolved;
  try {
    resolved = fsImplementation.realpathSync(path.resolve(value));
  } catch {
    throw new Error('Packaged renderer directory is unavailable.');
  }
  if (!fsImplementation.statSync(resolved).isDirectory()) {
    throw new Error('Packaged renderer root is not a directory.');
  }
  return resolved;
}

function resolveContainedFile(rootDirectory, relativePath, fsImplementation) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || path.isAbsolute(relativePath)
  ) {
    return null;
  }
  const candidate = path.resolve(rootDirectory, ...relativePath.split('/'));
  if (!isWithinRoot(rootDirectory, candidate)) return null;
  let real;
  try {
    real = fsImplementation.realpathSync(candidate);
    if (!isWithinRoot(rootDirectory, real)) return null;
    if (!fsImplementation.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

function isWithinRoot(rootDirectory, candidate) {
  const relative = path.relative(rootDirectory, candidate);
  return relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function createRendererUrl(origin, hash = '') {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== LOOPBACK_HOST
    || parsed.origin !== origin
  ) {
    throw new TypeError('Packaged renderer origin is invalid.');
  }
  if (hash === undefined || hash === null || hash === '') {
    return `${parsed.origin}/`;
  }
  if (
    typeof hash !== 'string'
    || hash.length > MAX_REQUEST_URL_LENGTH
    || /[\u0000-\u001f\u007f]/.test(hash)
  ) {
    throw new TypeError('Packaged renderer hash is invalid.');
  }
  const normalizedHash = hash.startsWith('#') ? hash : `#${hash}`;
  return `${parsed.origin}/${normalizedHash}`;
}

function applySecurityHeaders(response, options = {}) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (options.crossOriginIsolated === true) response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (options.contentSecurityPolicy) response.setHeader('Content-Security-Policy', options.contentSecurityPolicy);
}

function isStrictPublicFile(rootDirectory, relativePath, fsImplementation) {
  const extensions = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.png', '.jpg', '.jpeg',
    '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.wasm', '.txt', '.bin', '.hex', '.elf', '.data', '.rom', '.dat']);
  if (!extensions.has(path.extname(relativePath).toLowerCase())) return false;
  let candidate = rootDirectory;
  for (const part of relativePath.split('/')) {
    if (!part || part.startsWith('.')) return false;
    candidate = path.join(candidate, part);
    try { if (fsImplementation.lstatSync(candidate).isSymbolicLink()) return false; } catch { return false; }
  }
  return true;
}

function writeEmpty(response, statusCode) {
  response.statusCode = statusCode;
  response.setHeader('Content-Length', '0');
  response.end();
}

function pipeFile(fsImplementation, filePath, response, resource) {
  return new Promise((resolve, reject) => {
    const stream = fsImplementation.createReadStream(filePath);
    let streamError = null;
    const finished = () => { stream.unpipe(response); stream.destroy(); };
    const closed = new Promise((resolveClosed, rejectClosed) => {
      stream.once('close', () => {
        resource.streams.delete(stream);
        response.removeListener('finish', finished);
        response.removeListener('close', finished);
        if (resource.retiring && streamError) rejectClosed(streamError);
        else resolveClosed();
        if (streamError) reject(streamError);
        else resolve();
      });
    });
    // The HTTP request and explicit retirement observe the same close outcome.
    // Retain a rejection handler even when a request fails before close() starts.
    closed.catch(() => undefined);
    resource.streams.set(stream, closed);
    stream.once('error', (error) => {
      streamError = error;
      response.destroy();
    });
    response.once('finish', finished);
    response.once('close', finished);
    try {
      stream.pipe(response);
    } catch (error) {
      streamError = error;
      stream.destroy();
    }
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.removeListener('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.removeListener('error', handleError);
      const address = server.address();
      if (!address || typeof address === 'string' || !address.port) {
        reject(new Error('Packaged renderer server has no TCP address.'));
        return;
      }
      resolve(address);
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(0, LOOPBACK_HOST);
  });
}

async function retireResource(resource) {
  resource.retiring = true;
  const tasks = [closeHttpServer(resource)];
  const errors = [];
  // HTTP close does not own the lifetime of preconnect sockets or file FDs.
  for (const [stream, closed] of resource.streams) {
    try {
      stream.destroy();
      tasks.push(closed);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const [socket, closed] of resource.sockets) {
    try {
      socket.destroy();
      tasks.push(closed);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const outcome of await Promise.allSettled(tasks)) {
    if (outcome.status === 'rejected') errors.push(outcome.reason);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) {
    throw new AggregateError(errors, 'Packaged renderer resource cleanup failed.');
  }
}

function closeHttpServer(resource) {
  return new Promise((resolve, reject) => {
    if (resource.listenerClosed) {
      resolve();
      return;
    }
    resource.server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resource.listenerClosed = true;
      resolve();
    });
  });
}

function publicState(state) {
  return Object.freeze({
    state: 'ready',
    origin: state.origin,
    port: state.port,
  });
}

function mimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json':
    case '.map': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    case '.eot': return 'application/vnd.ms-fontobject';
    case '.wasm': return 'application/wasm';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

module.exports = {
  LOOPBACK_HOST,
  createPackagedRendererServer,
  createRendererUrl,
  mimeType,
  parseRequestPath,
};
