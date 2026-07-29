const fs = require('fs');
const http = require('http');
const path = require('path');

const LOOPBACK_HOST = '127.0.0.1';
const MAX_REQUEST_URL_LENGTH = 16 * 1024;

function createPackagedRendererServer(options = {}) {
  const createHttpServer = options.createHttpServer || http.createServer;
  const fsImplementation = options.fs || fs;
  let state = null;
  let startTask = null;
  let closeTask = null;

  async function start(startOptions = {}) {
    if (state) return publicState(state);
    if (startTask) return startTask;
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
      'index.html',
      fsImplementation,
    );
    if (!indexPath) {
      throw new Error('Packaged renderer index.html is unavailable.');
    }

    let expectedHost = null;
    const server = createHttpServer((request, response) => {
      void handleRequest({
        request,
        response,
        rootDirectory,
        expectedHost,
        fsImplementation,
      }).catch(() => {
        if (!response.headersSent) {
          writeEmpty(response, 500);
        } else {
          response.destroy();
        }
      });
    });

    try {
      const address = await listen(server);
      expectedHost = `${LOOPBACK_HOST}:${address.port}`;
      state = {
        server,
        rootDirectory,
        port: address.port,
        origin: `http://${expectedHost}`,
      };
      return publicState(state);
    } catch (error) {
      await closeHttpServer(server).catch(() => undefined);
      throw error;
    }
  }

  function status() {
    return state ? publicState(state) : { state: 'stopped' };
  }

  function rendererUrl(hash = '') {
    if (!state) {
      throw new Error('Packaged renderer server is not started.');
    }
    return createRendererUrl(state.origin, hash);
  }

  function close() {
    if (closeTask) return closeTask;
    const closing = state;
    state = null;
    if (!closing) return Promise.resolve();
    closeTask = closeHttpServer(closing.server).finally(() => {
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
  } = options;
  applySecurityHeaders(response);
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
    relativePath || 'index.html',
    fsImplementation,
  );
  if (!filePath) {
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
  await pipeFile(fsImplementation, filePath, response);
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

function applySecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function writeEmpty(response, statusCode) {
  response.statusCode = statusCode;
  response.setHeader('Content-Length', '0');
  response.end();
}

function pipeFile(fsImplementation, filePath, response) {
  return new Promise((resolve, reject) => {
    const stream = fsImplementation.createReadStream(filePath);
    stream.once('error', reject);
    response.once('finish', resolve);
    response.once('close', resolve);
    stream.pipe(response);
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

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
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
