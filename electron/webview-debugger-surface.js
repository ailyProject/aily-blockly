'use strict';

const { randomUUID } = require('node:crypto');
const {
  WEBVIEW_DEBUGGER_PARTITION,
  isAllowedWebviewDebuggerUrl,
} = require('./webview-debugger-policy');

const EVENT_CHANNEL = 'webview-debugger-surface-event';
const MAX_TEXT_CHARS = 24000;
const MAX_HTML_CHARS = 48000;
const MAX_EVALUATION_CHARS = 48000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function normalizeBounds(input, windowBounds) {
  const availableWidth = Math.max(1, boundedInteger(windowBounds?.width, 1, 1, 100000));
  const availableHeight = Math.max(1, boundedInteger(windowBounds?.height, 1, 1, 100000));
  const x = boundedInteger(input?.x, 0, 0, Math.max(0, availableWidth - 1));
  const y = boundedInteger(input?.y, 0, 0, Math.max(0, availableHeight - 1));
  return {
    x,
    y,
    width: boundedInteger(input?.width, availableWidth - x, 1, availableWidth - x),
    height: boundedInteger(input?.height, availableHeight - y, 1, availableHeight - y),
  };
}

function serializeError(error, fallbackCode = 'WEBVIEW_SURFACE_FAILED') {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error || 'Unknown WebView surface error'),
    errorCode: error?.code || fallbackCode,
  };
}

function createWebviewDebuggerSurfaceManager(dependencies) {
  const {
    BrowserWindow,
    WebContentsView,
    shell,
  } = dependencies;
  const surfaces = new Map();
  const ownerSurfaces = new Map();
  const lifecycleOwners = new WeakSet();

  function requireOwner(event) {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    if (!ownerWindow || ownerWindow.isDestroyed()) {
      const error = new Error('WebView surface owner window is unavailable');
      error.code = 'WEBVIEW_SURFACE_OWNER_MISSING';
      throw error;
    }
    return ownerWindow;
  }

  function requireSurface(event, surfaceId) {
    const surface = surfaces.get(String(surfaceId || ''));
    if (!surface || surface.ownerContentsId !== event.sender.id) {
      const error = new Error('WebView surface was not found for this renderer');
      error.code = 'WEBVIEW_SURFACE_NOT_FOUND';
      throw error;
    }
    return surface;
  }

  function sendEvent(surface, event, data = {}) {
    const ownerContents = surface.ownerWindow?.webContents;
    if (!ownerContents || ownerContents.isDestroyed()) return;
    ownerContents.send(EVENT_CHANNEL, {
      surfaceId: surface.id,
      event,
      data,
    });
  }

  function navigationHistory(contents) {
    return contents.navigationHistory || contents;
  }

  function stateOf(surface) {
    const contents = surface.view.webContents;
    const history = navigationHistory(contents);
    return {
      surfaceId: surface.id,
      url: contents.getURL() || 'about:blank',
      title: contents.getTitle() || '',
      loading: contents.isLoading(),
      readyState: surface.readyState,
      canGoBack: history.canGoBack?.() === true,
      canGoForward: history.canGoForward?.() === true,
      bounds: { ...surface.bounds },
    };
  }

  function validateNavigation(event, url) {
    if (isAllowedWebviewDebuggerUrl(url)) return;
    event?.preventDefault?.();
  }

  function attachGuestEvents(surface) {
    const contents = surface.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedWebviewDebuggerUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', validateNavigation);
    contents.on('did-start-loading', () => {
      surface.readyState = 'loading';
      sendEvent(surface, 'page', stateOf(surface));
    });
    contents.on('did-stop-loading', () => {
      surface.readyState = 'ready';
      sendEvent(surface, 'page', stateOf(surface));
    });
    contents.on('did-navigate', () => sendEvent(surface, 'page', stateOf(surface)));
    contents.on('did-navigate-in-page', () => sendEvent(surface, 'page', stateOf(surface)));
    contents.on('page-title-updated', () => sendEvent(surface, 'page', stateOf(surface)));
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      surface.readyState = 'error';
      sendEvent(surface, 'page', {
        ...stateOf(surface),
        error: `${errorDescription || 'Page load failed'} (${errorCode})`,
        url: validatedURL || contents.getURL(),
      });
    });
    contents.on('console-message', details => {
      const normalizedLevel = details.level === 'warning' ? 'warn' : details.level;
      sendEvent(surface, 'console', {
        level: normalizedLevel,
        message: String(details.message || '').slice(0, 8000),
        source: String(details.sourceId || '').slice(0, 2048),
        line: boundedInteger(details.lineNumber, 0, 0, 10000000),
        timestamp: Date.now(),
      });
    });
    contents.on('render-process-gone', (_event, details) => {
      surface.readyState = 'error';
      sendEvent(surface, 'page', {
        ...stateOf(surface),
        error: `Guest renderer stopped: ${details?.reason || 'unknown'}`,
      });
    });
  }

  function destroySurface(surface) {
    if (!surface || !surfaces.has(surface.id)) return;
    surfaces.delete(surface.id);
    ownerSurfaces.get(surface.ownerContentsId)?.delete(surface.id);
    try {
      surface.ownerWindow.contentView.removeChildView(surface.view);
    } catch {
      // The owner window may already be closing.
    }
    try {
      if (!surface.view.webContents.isDestroyed()) surface.view.webContents.close();
    } catch {
      // Best-effort cleanup during window teardown.
    }
  }

  function destroyOwnerSurfaces(ownerContentsId) {
    const ids = [...(ownerSurfaces.get(ownerContentsId) || [])];
    for (const id of ids) destroySurface(surfaces.get(id));
    ownerSurfaces.delete(ownerContentsId);
  }

  async function create(event, payload = {}) {
    const ownerWindow = requireOwner(event);
    const requestedUrl = String(payload.url || 'about:blank');
    if (!isAllowedWebviewDebuggerUrl(requestedUrl)) {
      const error = new Error('Only credential-free http://, https://, and about:blank URLs are allowed');
      error.code = 'WEBVIEW_NAVIGATION_REJECTED';
      throw error;
    }
    const view = new WebContentsView({
      webPreferences: {
        allowRunningInsecureContent: false,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        partition: WEBVIEW_DEBUGGER_PARTITION,
        sandbox: true,
        spellcheck: false,
        webSecurity: true,
      },
    });
    view.webContents.session?.setPermissionCheckHandler?.(() => false);
    view.webContents.session?.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
    const id = randomUUID();
    const bounds = normalizeBounds(payload.bounds, ownerWindow.getContentBounds());
    const surface = {
      id,
      ownerContentsId: event.sender.id,
      ownerWindow,
      view,
      bounds,
      readyState: 'idle',
    };
    surfaces.set(id, surface);
    if (!ownerSurfaces.has(event.sender.id)) {
      ownerSurfaces.set(event.sender.id, new Set());
    }
    if (!lifecycleOwners.has(event.sender)) {
      lifecycleOwners.add(event.sender);
      event.sender.once?.('destroyed', () => destroyOwnerSurfaces(event.sender.id));
      event.sender.on?.('render-process-gone', () => destroyOwnerSurfaces(event.sender.id));
      event.sender.on?.('did-start-navigation', details => {
        if (details?.isMainFrame && !details.isSameDocument) destroyOwnerSurfaces(event.sender.id);
      });
    }
    ownerSurfaces.get(event.sender.id).add(id);
    ownerWindow.contentView.addChildView(view);
    view.setBounds(bounds);
    view.setVisible?.(payload.visible !== false);
    view.setBackgroundColor('#ffffff');
    attachGuestEvents(surface);
    if (requestedUrl !== 'about:blank') await view.webContents.loadURL(requestedUrl);
    return { ok: true, ...stateOf(surface) };
  }

  function setBounds(event, payload = {}) {
    const surface = requireSurface(event, payload.surfaceId);
    surface.bounds = normalizeBounds(payload.bounds, surface.ownerWindow.getContentBounds());
    surface.view.setBounds(surface.bounds);
    surface.view.setVisible?.(payload.visible !== false);
    return { ok: true, ...stateOf(surface) };
  }

  async function snapshot(surface, params = {}) {
    const selector = String(params.selector || 'body').slice(0, 512);
    const maxTextChars = boundedInteger(params.maxTextChars, 12000, 256, MAX_TEXT_CHARS);
    const maxHtmlChars = boundedInteger(params.maxHtmlChars, 24000, 256, MAX_HTML_CHARS);
    const source = `(() => {
      const selector = ${JSON.stringify(selector)};
      const maxTextChars = ${maxTextChars};
      const maxHtmlChars = ${maxHtmlChars};
      const root = document.querySelector(selector);
      const text = root ? (root.innerText || root.textContent || '') : '';
      const html = root ? (root.outerHTML || '') : '';
      return {
        url: location.href,
        title: document.title || '',
        selector,
        matched: Boolean(root),
        readyState: document.readyState,
        text: text.slice(0, maxTextChars),
        html: html.slice(0, maxHtmlChars),
        textTruncated: text.length > maxTextChars,
        htmlTruncated: html.length > maxHtmlChars,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 80).map(node => ({
          level: Number(node.tagName.slice(1)), text: (node.innerText || node.textContent || '').trim().slice(0, 1000)
        })),
        links: Array.from(document.querySelectorAll('a[href]')).slice(0, 80).map(node => ({
          text: (node.innerText || node.textContent || '').trim().slice(0, 500), href: node.href
        }))
      };
    })()`;
    return await surface.view.webContents.executeJavaScript(source, true);
  }

  function waitForMainFrameLoad(contents, timeoutMs) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        contents.removeListener('did-stop-loading', onStop);
        contents.removeListener('did-fail-load', onFail);
      };
      const onStop = () => {
        cleanup();
        resolve();
      };
      const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        cleanup();
        const error = new Error(`${errorDescription || 'Page load failed'} (${errorCode}) ${validatedURL || ''}`.trim());
        error.code = 'WEBVIEW_LOAD_FAILED';
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error(`WebView control timed out after ${timeoutMs} ms`);
        error.code = 'WEBVIEW_COMMAND_TIMEOUT';
        reject(error);
      }, timeoutMs);
      contents.once('did-stop-loading', onStop);
      contents.on('did-fail-load', onFail);
    });
  }

  async function command(event, payload = {}) {
    const surface = requireSurface(event, payload.surfaceId);
    const contents = surface.view.webContents;
    const action = String(payload.action || '');
    const params = payload.params || {};
    if (action === 'navigate') {
      const url = String(params.url || '');
      if (!isAllowedWebviewDebuggerUrl(url)) {
        const error = new Error('Only credential-free http://, https://, and about:blank URLs are allowed');
        error.code = 'WEBVIEW_NAVIGATION_REJECTED';
        throw error;
      }
      await contents.loadURL(url);
      return { ok: true, loaded: true, page: stateOf(surface) };
    }
    if (action === 'control') {
      const control = String(params.action || '');
      const history = navigationHistory(contents);
      if (control === 'stop') {
        contents.stop();
        return { ok: true, controlled: true, action: control, page: stateOf(surface) };
      }
      const timeoutMs = boundedInteger(params.timeoutMs, 20000, 1000, 60000);
      let completion;
      if (control === 'back' && history.canGoBack?.()) {
        completion = waitForMainFrameLoad(contents, timeoutMs);
        history.goBack();
      } else if (control === 'forward' && history.canGoForward?.()) {
        completion = waitForMainFrameLoad(contents, timeoutMs);
        history.goForward();
      } else if (control === 'reload') {
        completion = waitForMainFrameLoad(contents, timeoutMs);
        contents.reload();
      } else {
        return { ok: true, controlled: false, action: control, page: stateOf(surface) };
      }
      await completion;
      return { ok: true, controlled: true, action: control, page: stateOf(surface) };
    }
    if (action === 'snapshot') {
      return { ok: true, snapshot: await snapshot(surface, params), page: stateOf(surface) };
    }
    if (action === 'evaluate') {
      const expression = String(params.expression || '').slice(0, 32768);
      if (!expression.trim()) {
        const error = new Error('A JavaScript expression is required');
        error.code = 'WEBVIEW_EXPRESSION_REQUIRED';
        throw error;
      }
      const source = `(async () => {
        const value = await (${expression});
        const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        try {
          const serialized = JSON.stringify(value);
          if (typeof serialized === 'string' && serialized.length > ${MAX_EVALUATION_CHARS}) {
            return { kind, value: serialized.slice(0, ${MAX_EVALUATION_CHARS}), truncated: true };
          }
          return { kind, value: JSON.parse(serialized) };
        }
        catch { return { kind, value: String(value) }; }
      })()`;
      return { ok: true, result: await contents.executeJavaScript(source, true), page: stateOf(surface) };
    }
    if (action === 'devtools') {
      contents.openDevTools({ mode: 'detach', activate: true });
      return { ok: true, opened: true };
    }
    if (action === 'state') return { ok: true, page: stateOf(surface) };
    const error = new Error(`Unsupported WebView surface action: ${action}`);
    error.code = 'WEBVIEW_SURFACE_ACTION_UNSUPPORTED';
    throw error;
  }

  function destroy(event, payload = {}) {
    const surface = requireSurface(event, payload.surfaceId);
    destroySurface(surface);
    return { ok: true, destroyed: true, surfaceId: surface.id };
  }

  function register(ipcMain) {
    ipcMain.handle('webview-debugger-surface-create', async (event, payload) => {
      try { return await create(event, payload); }
      catch (error) { return serializeError(error); }
    });
    ipcMain.handle('webview-debugger-surface-bounds', (event, payload) => {
      try { return setBounds(event, payload); }
      catch (error) { return serializeError(error); }
    });
    ipcMain.handle('webview-debugger-surface-command', async (event, payload) => {
      try { return await command(event, payload); }
      catch (error) { return serializeError(error); }
    });
    ipcMain.handle('webview-debugger-surface-destroy', (event, payload) => {
      try { return destroy(event, payload); }
      catch (error) { return serializeError(error); }
    });
    return { destroyOwnerSurfaces };
  }

  return {
    command,
    create,
    destroy,
    destroyOwnerSurfaces,
    register,
    setBounds,
  };
}

function registerWebviewDebuggerSurfaceHandlers(dependencies) {
  const manager = createWebviewDebuggerSurfaceManager(dependencies);
  return manager.register(dependencies.ipcMain);
}

module.exports = {
  EVENT_CHANNEL,
  createWebviewDebuggerSurfaceManager,
  normalizeBounds,
  registerWebviewDebuggerSurfaceHandlers,
};
