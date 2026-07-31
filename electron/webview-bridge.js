const { BrowserWindow, ipcMain, session } = require("electron");

const FETCH_CHANNEL = "webview-bridge-fetch";
const SEARCH_CHANNEL = "webview-bridge-search";
const PARTITION = "persist:aily-webview-bridge";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_WAIT_AFTER_LOAD_MS = 800;
const IDLE_DESTROY_MS = 60 * 1000;
const MAX_HTML_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 200_000;
const SEARCH_WAIT_AFTER_LOAD_MS = 1500;
const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let sessionConfigured = false;
let nextBridgeTabId = 1;
const bridgeTabs = [];

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function logBridgeInfo(message, details) {
  if (details) {
    console.log(`[webview-bridge] ${message}`, details);
    return;
  }
  console.log(`[webview-bridge] ${message}`);
}

function logBridgeWarn(message, details) {
  if (details) {
    console.warn(`[webview-bridge] ${message}`, details);
    return;
  }
  console.warn(`[webview-bridge] ${message}`);
}

function logBridgeError(message, details) {
  if (details) {
    console.error(`[webview-bridge] ${message}`, details);
    return;
  }
  console.error(`[webview-bridge] ${message}`);
}

function getBridgeWindowMeta(win) {
  if (!win) {
    return { windowId: null, webContentsId: null };
  }

  return {
    windowId: typeof win.id === "number" ? win.id : null,
    webContentsId: win.webContents?.id ?? null,
  };
}

function getSafeUrl(win) {
  try {
    return win?.webContents?.getURL?.() || "";
  } catch {
    return "";
  }
}

function getBridgeTabMeta(tab) {
  return {
    tabId: tab?.id ?? null,
    busy: tab?.busy === true,
    operation: typeof tab?.operation === "string" ? tab.operation : null,
    ...getBridgeWindowMeta(tab?.win),
  };
}

function ensureBridgeSessionConfigured() {
  if (sessionConfigured) {
    return;
  }

  const bridgeSession = session.fromPartition(PARTITION);
  bridgeSession.setUserAgent(SEARCH_USER_AGENT);
  bridgeSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        "User-Agent": SEARCH_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      },
    });
  });

  sessionConfigured = true;
  logBridgeInfo("configured bridge session", { partition: PARTITION });
}

function removeBridgeTab(tab) {
  const index = bridgeTabs.indexOf(tab);
  if (index >= 0) {
    bridgeTabs.splice(index, 1);
  }
}

function clearTabIdleDestroyTimer(tab) {
  if (!tab?.idleTimer) {
    return;
  }
  clearTimeout(tab.idleTimer);
  tab.idleTimer = null;
}

function destroyBridgeTab(tab, reason, details) {
  if (!tab) {
    return;
  }

  const win = tab.win;
  if (!win) {
    removeBridgeTab(tab);
    return;
  }

  const meta = {
    ...getBridgeTabMeta(tab),
    url: getSafeUrl(win),
    reason,
    ...details,
  };
  clearTabIdleDestroyTimer(tab);
  removeBridgeTab(tab);

  if (win.isDestroyed()) {
    logBridgeWarn("bridge tab already destroyed", meta);
    return;
  }

  logBridgeWarn("destroying bridge tab", meta);
  try {
    win.destroy();
  } catch (error) {
    logBridgeError("failed to destroy bridge tab", {
      ...meta,
      error: describeError(error),
    });
  }
}

function attachBridgeWindowObservers(tab) {
  const win = tab.win;
  const baseMeta = getBridgeTabMeta(tab);

  win.once("closed", () => {
    clearTabIdleDestroyTimer(tab);
    removeBridgeTab(tab);
    logBridgeInfo("bridge tab closed", {
      ...baseMeta,
      url: getSafeUrl(win),
    });
  });

  win.on("unresponsive", () => {
    destroyBridgeTab(tab, "unresponsive", baseMeta);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    destroyBridgeTab(tab, "render-process-gone", {
      ...baseMeta,
      exitCode: details?.exitCode,
      reason: details?.reason,
    });
  });

  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }

      const detail = {
        ...baseMeta,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      };

      if (errorCode === -3) {
        logBridgeWarn("bridge tab load aborted", detail);
        return;
      }

      destroyBridgeTab(tab, "did-fail-load", detail);
    },
  );
}

function createBridgeTab() {
  ensureBridgeSessionConfigured();
  const win = new BrowserWindow({
    show: false,
    width: 1366,
    height: 900,
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const tab = {
    id: nextBridgeTabId++,
    win,
    busy: false,
    operation: null,
    idleTimer: null,
  };
  bridgeTabs.push(tab);
  attachBridgeWindowObservers(tab);
  logBridgeInfo("created bridge tab", {
    ...getBridgeTabMeta(tab),
    partition: PARTITION,
  });
  return tab;
}

function scheduleTabIdleDestroy(tab) {
  if (!tab) {
    return;
  }
  clearTabIdleDestroyTimer(tab);
  tab.idleTimer = setTimeout(() => {
    if (tab.busy) {
      return;
    }
    destroyBridgeTab(tab, "idle-timeout");
  }, IDLE_DESTROY_MS);
}

function acquireBridgeTab(operationLabel = "bridge") {
  for (const tab of bridgeTabs) {
    if (!tab || tab.busy || !tab.win || tab.win.isDestroyed()) {
      continue;
    }
    clearTabIdleDestroyTimer(tab);
    tab.busy = true;
    tab.operation = operationLabel;
    logBridgeInfo("reusing bridge tab", {
      ...getBridgeTabMeta(tab),
      url: getSafeUrl(tab.win),
    });
    return tab;
  }

  const tab = createBridgeTab();
  tab.busy = true;
  tab.operation = operationLabel;
  return tab;
}

function releaseBridgeTab(tab) {
  if (!tab) {
    return;
  }
  if (!bridgeTabs.includes(tab)) {
    return;
  }
  if (!tab.win || tab.win.isDestroyed()) {
    removeBridgeTab(tab);
    return;
  }
  tab.busy = false;
  tab.operation = null;
  scheduleTabIdleDestroy(tab);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  return Number.isFinite(value) && value > 0
    ? Math.max(1000, Math.min(Number(value), 60000))
    : fallback;
}

async function loadUrlWithTimeout(tab, url, timeoutMs, operationLabel = "loadURL") {
  const win = tab.win;
  const meta = {
    ...getBridgeTabMeta(tab),
    url,
    timeoutMs,
    operation: operationLabel,
  };
  logBridgeInfo("starting bridge tab navigation", meta);

  await new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle = null;
    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      win.webContents.removeListener("did-finish-load", onFinish);
      win.webContents.removeListener("did-fail-load", onFail);
      win.webContents.removeListener("render-process-gone", onGone);
      win.removeListener("unresponsive", onUnresponsive);
      win.removeListener("closed", onClosed);
    };
    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      logBridgeInfo("bridge tab navigation finished", {
        ...meta,
        finalUrl: getSafeUrl(win),
      });
      settleResolve();
    };
    const onFail = (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || settled) {
        return;
      }
      logBridgeWarn("bridge tab navigation failed", {
        ...meta,
        errorCode,
        errorDescription,
        validatedUrl,
      });
      if (errorCode === -3) {
        return;
      }
      settleReject(new Error(`Load failed (${errorCode}): ${errorDescription || validatedUrl || url}`));
    };
    const onGone = (_event, details) => {
      logBridgeError("bridge tab renderer process gone during navigation", {
        ...meta,
        reason: details?.reason,
        exitCode: details?.exitCode,
      });
      settleReject(
        new Error(`Bridge renderer process gone during ${operationLabel}: ${details?.reason || "unknown"}`),
      );
    };
    const onUnresponsive = () => {
      logBridgeError("bridge tab unresponsive during navigation", meta);
      settleReject(new Error(`Bridge tab became unresponsive during ${operationLabel}`));
    };
    const onClosed = () => {
      logBridgeWarn("bridge tab closed during navigation", meta);
      settleReject(new Error(`Bridge tab closed during ${operationLabel}`));
    };
    const onTimeout = () => {
      if (settled) {
        return;
      }
      logBridgeWarn("bridge tab navigation timed out", meta);
      settleReject(new Error(`webview bridge timed out after ${timeoutMs}ms`));
      destroyBridgeTab(tab, "navigation-timeout", meta);
    };

    timeoutHandle = setTimeout(onTimeout, timeoutMs);
    win.webContents.once("did-finish-load", onFinish);
    win.webContents.on("did-fail-load", onFail);
    win.webContents.once("render-process-gone", onGone);
    win.once("unresponsive", onUnresponsive);
    win.once("closed", onClosed);
    void win.loadURL(url).catch(error => {
      logBridgeError("bridge tab loadURL threw", {
        ...meta,
        error: describeError(error),
      });
      settleReject(error);
    });
  });
}

async function withBridgeWindow(task, operationLabel = "bridge") {
  const tab = acquireBridgeTab(operationLabel);
  try {
    return await task(tab.win, tab);
  } finally {
    releaseBridgeTab(tab);
  }
}

async function fetchViaWebview(payload = {}) {
  const timeoutMs = normalizeTimeout(payload.timeoutMs);
  const waitAfterLoadMs = normalizeTimeout(payload.waitAfterLoadMs, DEFAULT_WAIT_AFTER_LOAD_MS);
  const captureFullContent = payload.captureFullContent === true;
  const targetUrl = String(payload.url || "");
  return await withBridgeWindow(async (win, tab) => {
    await loadUrlWithTimeout(tab, targetUrl, timeoutMs, `fetch:${targetUrl}`);
    if (waitAfterLoadMs > 0) {
      await delay(waitAfterLoadMs);
    }

    let result;
    try {
      result = await win.webContents.executeJavaScript(
        `(() => {
          const html = document.documentElement?.outerHTML || "";
          const text = document.body?.innerText || document.documentElement?.innerText || "";
          return {
            url: location.href,
            title: document.title || "",
            html: ${captureFullContent ? "html" : `html.slice(0, ${MAX_HTML_CHARS})`},
            text: ${captureFullContent ? "text" : `text.slice(0, ${MAX_TEXT_CHARS})`},
          };
        })()`,
        true,
      );
    } catch (error) {
      destroyBridgeTab(tab, "execute-javascript-failed", {
        ...getBridgeTabMeta(tab),
        url: targetUrl,
        operation: "fetch",
        error: describeError(error),
      });
      throw error;
    }

    return {
      ok: true,
      status: 200,
      contentType: "text/html; charset=utf-8",
      ...result,
    };
  }, `fetch:${targetUrl}`);
}

async function loadSearchPageViaWebview(searchUrl, timeoutMs, captureFullContent) {
  return await withBridgeWindow(async (win, tab) => {
    await loadUrlWithTimeout(tab, searchUrl, timeoutMs, `search:${searchUrl}`);
    await delay(SEARCH_WAIT_AFTER_LOAD_MS);

    try {
      return await win.webContents.executeJavaScript(
        `(() => ({
          url: location.href,
          title: document.title || "",
          html: ${captureFullContent
            ? '(document.documentElement?.outerHTML || "")'
            : `(document.documentElement?.outerHTML || "").slice(0, ${MAX_HTML_CHARS})`},
        }))()`,
        true,
      );
    } catch (error) {
      destroyBridgeTab(tab, "execute-javascript-failed", {
        ...getBridgeTabMeta(tab),
        url: searchUrl,
        operation: `search:${searchUrl}`,
        error: describeError(error),
      });
      throw error;
    }
  }, `search:${searchUrl}`);
}

async function searchViaWebview(payload = {}) {
  const searchUrl = String(payload.url || "").trim();
  const timeoutMs = normalizeTimeout(payload.timeoutMs);
  const captureFullContent = payload.captureFullContent === true;

  if (!searchUrl) {
    return {
      ok: false,
      error: "Missing search url",
    };
  }

  try {
    logBridgeInfo("starting bridge search attempt", { url: searchUrl });
    const page = await loadSearchPageViaWebview(searchUrl, timeoutMs, captureFullContent);
    if (!page?.html) {
      return {
        ok: false,
        error: `empty html for ${searchUrl}`,
      };
    }

    logBridgeInfo("bridge search attempt succeeded", {
      url: searchUrl,
      finalUrl: page.url,
    });
    return { ok: true, ...page };
  } catch (error) {
    logBridgeWarn("bridge search attempt failed", {
      url: searchUrl,
      error: describeError(error),
    });
    return {
      ok: false,
      error: `${searchUrl}: ${describeError(error)}`,
    };
  }
}

function normalizeHttpUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

async function executeWebviewFetch(payload = {}) {
  const url = normalizeHttpUrl(payload.url);
  if (!url) {
    return {
      ok: false,
      error: "WebView fetch requires a valid http/https url",
    };
  }

  try {
    return await fetchViaWebview({
      ...payload,
      url,
    });
  } catch (error) {
    logBridgeError("fetch request failed", {
      url,
      error: describeError(error),
    });
    return {
      ok: false,
      error: describeError(error),
    };
  }
}

async function executeWebviewSearch(payload = {}) {
  const url = normalizeHttpUrl(payload.url);
  if (!url) {
    return {
      ok: false,
      error: "WebView search requires a valid http/https url",
    };
  }

  try {
    return await searchViaWebview({
      ...payload,
      url,
    });
  } catch (error) {
    logBridgeError("search request failed", {
      url,
      error: describeError(error),
    });
    return {
      ok: false,
      error: describeError(error),
    };
  }
}

function registerWebviewBridgeHandlers() {
  ipcMain.removeHandler(FETCH_CHANNEL);
  ipcMain.removeHandler(SEARCH_CHANNEL);

  ipcMain.handle(FETCH_CHANNEL, async (_event, payload = {}) => executeWebviewFetch(payload));
  ipcMain.handle(SEARCH_CHANNEL, async (_event, payload = {}) => executeWebviewSearch(payload));
}

module.exports = {
  executeWebviewFetch,
  executeWebviewSearch,
  registerWebviewBridgeHandlers,
};
