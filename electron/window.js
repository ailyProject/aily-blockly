// 管理主窗口和子窗口的创建、状态同步及窗口控制操作。
const { ipcMain, BrowserWindow, app, screen } = require("electron");
const { requestWindowAttention } = require('./window-attention');
const { killCmdProcess, getActiveCmdProcesses } = require('./cmd');
const { killRegisteredProcessTree } = require('./process-tree');
const {
    registerChatRuntimeHostIpc,
} = require('./chat-runtime-host');
const {
    CHILD_WINDOW_LAYOUTS,
    calculateChildWindowLayout,
    clampBoundsToWorkArea,
} = require('./child-window-layout');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CODE_VIEWER_STATE_CHANNEL = 'blockly-code-viewer-state';
const CODE_VIEWER_STATE_UPDATE_CHANNEL = 'blockly-code-viewer-state-update';
const CODE_VIEWER_STATE_GET_CHANNEL = 'blockly-code-viewer-state-get';

/** 后台预缓冲子窗口数量�? 个待�?+ 1 个备�?*/
const SUB_WINDOW_POOL_SIZE = 2;

/** 子窗口最小尺寸；兼顾内容可用性与多窗口平铺。 */
const SUB_WINDOW_MIN_WIDTH = 400;
const SUB_WINDOW_MIN_HEIGHT = 300;
const CHILD_TOOL_RELEASE_GRACE_MS = 15000;

/** @type {Map<string, { hostInfo: any, streamId: string, refCount: number, releaseTimer: NodeJS.Timeout | null }>} */
const childToolSessions = new Map();
const SUB_WINDOW_DARK_BACKGROUND_COLOR = '#2b2d30';
const SUB_WINDOW_LIGHT_BACKGROUND_COLOR = '#e8e8e8';

function readThemeFromConfigFile(configPath) {
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return config && config.theme;
        }
    } catch (e) {
        console.warn('[SubWindowPool] 读取主题配置失败:', e.message);
    }
    return null;
}

function getSubWindowBackgroundColor() {
    const appDataPath = process.env.AILY_APPDATA_PATH || app.getPath('userData');
    const theme =
        readThemeFromConfigFile(path.join(appDataPath, 'config.json')) ||
        readThemeFromConfigFile(path.join(__dirname, 'config', 'config.json'));

    return theme === 'light'
        ? SUB_WINDOW_LIGHT_BACKGROUND_COLOR
        : SUB_WINDOW_DARK_BACKGROUND_COLOR;
}

function applySubWindowMinimumSize(win) {
    if (!win || win.isDestroyed()) {
        return;
    }
    try {
        win.setMinimumSize(SUB_WINDOW_MIN_WIDTH, SUB_WINDOW_MIN_HEIGHT);
    } catch (e) {
        console.warn('[SubWindowPool] 子窗口最小尺寸设置失�?', e.message);
    }
}

/** 首次 before-quit 即置位；池窗�?closed �?Electron �?app.isQuitting 在实测中仍为 false */
let applicationIsQuitting = false;
app.once('before-quit', () => {
    applicationIsQuitting = true;
});

function isDevServeSubWindow() {
    return process.env.DEV === 'true' || process.env.DEV === true;
}

/**
 * 与正式子窗口一致的 webPreferences，用于预热池与即用窗口�?
 */
function getSubWindowWebPreferences() {
    return {
        nodeIntegration: true,
        webSecurity: false,
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
    };
}

function sanitizeChildToolId(toolId) {
    return String(toolId || '').trim();
}

function resolveChildToolIdFromWindowUrl(windowUrl) {
    const match = String(windowUrl || '').match(/^\/child-tool\/([^/?#]+)/);
    if (!match) return '';
    try {
        return sanitizeChildToolId(decodeURIComponent(match[1]));
    } catch (_) {
        return sanitizeChildToolId(match[1]);
    }
}

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function cloneChildToolSession(session) {
    return session
        ? {
            hostInfo: session.hostInfo,
            streamId: session.streamId,
            refCount: session.refCount,
        }
        : null;
}

function broadcastChildToolSessionStateChanged() {
    const payload = listChildToolSessions();
    for (const win of BrowserWindow.getAllWindows()) {
        try {
            if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send('child-tool-session-state-changed', payload);
            }
        } catch (error) {
            console.error('Error sending child-tool-session-state-changed:', error.message);
        }
    }
}

function cancelChildToolRelease(session) {
    if (!session || !session.releaseTimer) {
        return;
    }
    clearTimeout(session.releaseTimer);
    session.releaseTimer = null;
}

async function tryShutdownChildToolByUrl(session) {
    const shutdownUrl = typeof session?.hostInfo?.shutdownUrl === 'string'
        ? session.hostInfo.shutdownUrl.trim()
        : '';
    if (!shutdownUrl || typeof fetch !== 'function') {
        return false;
    }

    try {
        const response = await fetch(shutdownUrl, { method: 'POST' }).catch(() => fetch(shutdownUrl));
        return !!response?.ok;
    } catch (_) {
        return false;
    }
}

async function stopChildToolSessionProcess(session) {
    if (!session) {
        return false;
    }

    const hasActiveStream = !!session.streamId
        && getActiveCmdProcesses().some(processInfo => processInfo.streamId === session.streamId);
    if (hasActiveStream) {
        killCmdProcess(session.streamId);
    }

    const hostPid = Number.isInteger(session?.hostInfo?.pid) ? session.hostInfo.pid : null;
    if (hostPid && !isPidAlive(hostPid)) {
        return true;
    }

    const shutdownOk = await tryShutdownChildToolByUrl(session);
    if (hostPid && isPidAlive(hostPid)) {
        await killRegisteredProcessTree(hostPid, `child-tool:${session.streamId || 'detached'}`);
    }

    return shutdownOk || !hostPid || !isPidAlive(hostPid);
}

function scheduleChildToolRelease(toolId, session) {
    if (!session || session.releaseTimer) {
        return;
    }

    session.releaseTimer = setTimeout(() => {
        session.releaseTimer = null;
        if (session.refCount > 0) {
            return;
        }
        void stopChildToolSessionProcess(session).finally(() => {
            childToolSessions.delete(toolId);
            broadcastChildToolSessionStateChanged();
        });
    }, CHILD_TOOL_RELEASE_GRACE_MS);
}

function releaseChildToolSession(toolIdOrPayload) {
    const payload = toolIdOrPayload && typeof toolIdOrPayload === 'object'
        ? toolIdOrPayload
        : { toolId: toolIdOrPayload };
    const normalizedToolId = sanitizeChildToolId(payload.toolId);
    const session = childToolSessions.get(normalizedToolId);
    if (!session) {
        return { success: false, reason: 'not-found' };
    }
    const expectedStreamId = String(payload.streamId || '').trim();
    if (expectedStreamId && session.streamId !== expectedStreamId) {
        return {
            success: false,
            reason: 'stale-session',
            currentStreamId: session.streamId,
        };
    }

    session.refCount = Math.max(0, session.refCount - 1);
    if (session.refCount === 0) {
        scheduleChildToolRelease(normalizedToolId, session);
    }

    return { success: true, session: cloneChildToolSession(session) };
}

async function restartChildToolSession(toolId) {
    const normalizedToolId = sanitizeChildToolId(toolId);
    const session = childToolSessions.get(normalizedToolId);
    if (!session) {
        return { success: false, reason: 'not-found' };
    }

    cancelChildToolRelease(session);
    await stopChildToolSessionProcess(session);
    childToolSessions.delete(normalizedToolId);
    return { success: true };
}

function isChildToolSessionAlive(session) {
    if (!session) {
        return false;
    }
    if (session.streamId && getActiveCmdProcesses().some(processInfo => processInfo.streamId === session.streamId)) {
        return true;
    }
    return isPidAlive(session?.hostInfo?.pid);
}

function listChildToolSessions() {
    const activeProcesses = new Map(
        getActiveCmdProcesses().map((processInfo) => [processInfo.streamId, processInfo])
    );
    return Array.from(childToolSessions.entries()).map(([toolId, session]) => {
        const processInfo = session?.streamId ? activeProcesses.get(session.streamId) : null;
        const running = !!processInfo || isPidAlive(session?.hostInfo?.pid);
        return {
            toolId,
            streamId: session?.streamId || '',
            hostInfo: session?.hostInfo || null,
            refCount: session?.refCount || 0,
            running,
            pid: processInfo?.pid ?? session?.hostInfo?.pid,
            command: processInfo?.command || '',
            cwd: processInfo?.cwd || '',
            durationMs: processInfo?.durationMs || 0,
        };
    });
}

/** @type {import('electron').BrowserWindow[]} */
let subWindowPool = [];
/** @type {boolean} */
let subWindowReplenishScheduled = false;

function scheduleReplenishSubWindowPool(loadBasePage) {
    if (applicationIsQuitting) {
        return;
    }
    if (subWindowReplenishScheduled) {
        return;
    }
    subWindowReplenishScheduled = true;
    setImmediate(() => {
        subWindowReplenishScheduled = false;
        if (applicationIsQuitting) {
            return;
        }
        replenishSubWindowPool(loadBasePage);
    });
}

/**
 * 创建不可见（opacity 0）、不出现在任务栏的预缓冲子窗口并完成首屏加载�?
 * Windows 上不可设 transparent: true，否则会禁用 thickFrame 带来的边缘吸附与标题栏双击最大化�?
 */
function pushPooledSubWindow(loadBasePage) {
    if (applicationIsQuitting) {
        return;
    }
    try {
        const win = new BrowserWindow({
            frame: false,
            show: false,
            opacity: 0,
            backgroundColor: getSubWindowBackgroundColor(),
            skipTaskbar: true,
            autoHideMenuBar: true,
            thickFrame: true,
            titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
            alwaysOnTop: false,
            width: 800,
            height: 600,
            minWidth: SUB_WINDOW_MIN_WIDTH,
            minHeight: SUB_WINDOW_MIN_HEIGHT,
            webPreferences: getSubWindowWebPreferences(),
        });

        const onClosedWhilePooled = () => {
            const idx = subWindowPool.indexOf(win);
            if (idx !== -1) {
                subWindowPool.splice(idx, 1);
            }
            delete win.__subWindowPoolClosedHandler;
            if (!applicationIsQuitting) {
                scheduleReplenishSubWindowPool(loadBasePage);
            }
        };
        win.__subWindowPoolClosedHandler = onClosedWhilePooled;
        win.once('closed', onClosedWhilePooled);
        subWindowPool.push(win);
        loadBasePage(win.webContents);
    } catch (e) {
        console.warn('[SubWindowPool] 预缓冲子窗口创建失败:', e.message);
    }
}

function replenishSubWindowPool(loadBasePage) {
    if (applicationIsQuitting) {
        return;
    }
    while (subWindowPool.length < SUB_WINDOW_POOL_SIZE) {
        const prevLen = subWindowPool.length;
        pushPooledSubWindow(loadBasePage);
        if (subWindowPool.length === prevLen) {
            break;
        }
    }
}

/**
 * 从池中取出窗口后移除池的 closed 监听并触发补位�?
 * @param {import('electron').BrowserWindow} win
 * @param {(wc: import('electron').WebContents) => void} loadBasePage
 */
function removePoolHandlersFromWin(win, loadBasePage) {
    const h = win.__subWindowPoolClosedHandler;
    if (typeof h === 'function') {
        win.removeListener('closed', h);
        delete win.__subWindowPoolClosedHandler;
    }
    scheduleReplenishSubWindowPool(loadBasePage);
}

/**
 * 将子窗口居中到「主窗口当前所在显示器」的工作区内（多屏跟随主窗口）�?
 * @param {import('electron').BrowserWindow} subWindow
 * @param {import('electron').BrowserWindow | null} mainWin
 * @param {number} width
 * @param {number} height
 */
function centerSubWindowOnMainDisplay(subWindow, mainWin, width, height) {
    try {
        if (!subWindow || subWindow.isDestroyed()) {
            return;
        }
        const wa =
            mainWin && !mainWin.isDestroyed()
                ? screen.getDisplayMatching(mainWin.getBounds()).workArea
                : screen.getPrimaryDisplay().workArea;
        const w = Math.min(Math.max(SUB_WINDOW_MIN_WIDTH, width), wa.width);
        const h = Math.min(Math.max(SUB_WINDOW_MIN_HEIGHT, height), wa.height);
        const x = Math.round(wa.x + Math.max(0, (wa.width - w) / 2));
        const y = Math.round(wa.y + Math.max(0, (wa.height - h) / 2));
        subWindow.setBounds({ x, y, width: w, height: h });
    } catch (e) {
        console.warn('[SubWindowPool] 子窗口居中定位失�?', e.message);
    }
}

function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function setCurrentWindowSize(senderWindow, requestedWidth, requestedHeight) {
    if (!senderWindow || senderWindow.isDestroyed()) {
        return { success: false, error: 'window-not-found' };
    }

    const width = Math.round(Number(requestedWidth));
    const height = Math.round(Number(requestedHeight));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return { success: false, error: 'invalid-size' };
    }

    const display = screen.getDisplayMatching(senderWindow.getBounds());
    const workArea = display.workArea;
    const [minWidth, minHeight] = senderWindow.getMinimumSize();
    const nextWidth = clampNumber(width, minWidth || 1, workArea.width);
    const nextHeight = clampNumber(height, minHeight || 1, workArea.height);
    const currentBounds = senderWindow.getBounds();
    const centerX = currentBounds.x + currentBounds.width / 2;
    const centerY = currentBounds.y + currentBounds.height / 2;
    const nextX = clampNumber(
        Math.round(centerX - nextWidth / 2),
        workArea.x,
        workArea.x + workArea.width - nextWidth
    );
    const nextY = clampNumber(
        Math.round(centerY - nextHeight / 2),
        workArea.y,
        workArea.y + workArea.height - nextHeight
    );

    if (senderWindow.isFullScreen()) {
        senderWindow.setFullScreen(false);
    }
    if (senderWindow.isMaximized()) {
        senderWindow.unmaximize();
    }

    senderWindow.setBounds({
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
    });

    return {
        success: true,
        requested: { width, height },
        bounds: senderWindow.getBounds(),
    };
}

function terminateAilyProcess() {
    console.info('[PROC_TRACE][APP_NAME_KILL_DISABLED]');
}

function registerWindowHandlers(mainWindow) {
    registerChatRuntimeHostIpc(mainWindow);

    // 添加一个映射来存储已打开的窗�?
    const openWindows = new Map();
    let codeViewerState = {
        code: '',
        selectedBlockId: null,
        blockCodeMap: [],
        updatedAt: 0,
    };

    const sendCodeViewerState = (targetWindow) => {
        try {
            if (targetWindow && !targetWindow.isDestroyed() && targetWindow.webContents && !targetWindow.webContents.isDestroyed()) {
                targetWindow.webContents.send(CODE_VIEWER_STATE_CHANNEL, codeViewerState);
            }
        } catch (error) {
            console.error('[IPC] send blockly code-viewer state failed:', error.message);
        }
    };

    const broadcastCodeViewerState = () => {
        sendCodeViewerState(mainWindow);
        openWindows.forEach((subWindow) => sendCodeViewerState(subWindow));
    };

    const normalizeSubWindowUrl = (windowUrl) => {
        if (typeof windowUrl !== 'string') {
            return '';
        }
        const trimmedUrl = windowUrl.trim();
        if (!trimmedUrl) {
            return '';
        }
        const hashRouteIndex = trimmedUrl.indexOf('#/');
        const routeUrl = hashRouteIndex >= 0 ? trimmedUrl.slice(hashRouteIndex + 2) : trimmedUrl;
        return `/${routeUrl.replace(/^\/+/, '')}`;
    };

    const notifySubWindowState = (windowUrl, isOpen) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('sub-window-state-changed', {
                    path: normalizeSubWindowUrl(windowUrl),
                    open: !!isOpen,
                });
            }
        } catch (error) {
            console.error('Error sending sub-window-state-changed:', error.message);
        }
    };

    const notifyChildToolSessionStateChanged = () => {
        broadcastChildToolSessionStateChanged();
    };

    const focusSubWindow = (targetWindow) => {
        if (!targetWindow || targetWindow.isDestroyed()) {
            return false;
        }
        if (targetWindow.isMinimized()) {
            targetWindow.restore();
        }
        if (!targetWindow.isVisible()) {
            targetWindow.setOpacity(1);
            targetWindow.show();
        }
        if (typeof targetWindow.moveTop === 'function') {
            targetWindow.moveTop();
        }
        targetWindow.focus();
        return true;
    };

    const focusSubWindowByUrl = (windowUrl) => {
        const normalizedWindowUrl = normalizeSubWindowUrl(windowUrl);
        if (!normalizedWindowUrl) {
            return false;
        }
        const existingWindow = openWindows.get(normalizedWindowUrl);
        if (existingWindow && !existingWindow.isDestroyed()) {
            notifySubWindowState(normalizedWindowUrl, true);
            return focusSubWindow(existingWindow);
        }
        openWindows.delete(normalizedWindowUrl);
        return false;
    };

    const readSubWindowState = (windowUrl) => {
        const normalizedWindowUrl = normalizeSubWindowUrl(windowUrl);
        const targetWindow = normalizedWindowUrl ? openWindows.get(normalizedWindowUrl) : null;
        if (!targetWindow || targetWindow.isDestroyed()) {
            if (normalizedWindowUrl) {
                openWindows.delete(normalizedWindowUrl);
            }
            return {
                path: normalizedWindowUrl,
                open: false,
                visible: false,
                focused: false,
                minimized: false,
                maximized: false,
                fullScreen: false,
                bounds: null,
            };
        }

        const display = screen.getDisplayMatching(targetWindow.getBounds());
        const primaryDisplay = screen.getPrimaryDisplay();
        return {
            path: normalizedWindowUrl,
            open: true,
            visible: targetWindow.isVisible(),
            focused: targetWindow.isFocused(),
            minimized: targetWindow.isMinimized(),
            maximized: targetWindow.isMaximized(),
            fullScreen: targetWindow.isFullScreen(),
            bounds: targetWindow.getBounds(),
            display: {
                id: display.id,
                label: display.label || '',
                scaleFactor: display.scaleFactor,
                rotation: display.rotation,
                bounds: display.bounds,
                workArea: display.workArea,
                primary: display.id === primaryDisplay.id,
            },
        };
    };

    const listDisplaySnapshots = () => {
        const primaryDisplay = screen.getPrimaryDisplay();
        return screen.getAllDisplays()
            .map((display) => ({
                id: display.id,
                label: display.label || '',
                scaleFactor: display.scaleFactor,
                rotation: display.rotation,
                bounds: display.bounds,
                workArea: display.workArea,
                primary: display.id === primaryDisplay.id,
            }))
            .sort((left, right) => Number(right.primary) - Number(left.primary)
                || left.bounds.x - right.bounds.x
                || left.bounds.y - right.bounds.y);
    };

    const listSubWindowEnvironment = () => {
        const windows = [];
        for (const [windowUrl, targetWindow] of openWindows.entries()) {
            if (!targetWindow || targetWindow.isDestroyed()) {
                openWindows.delete(windowUrl);
                continue;
            }
            windows.push(readSubWindowState(windowUrl));
        }
        return {
            success: true,
            displays: listDisplaySnapshots(),
            windows,
        };
    };

    const prepareWindowForBoundsChange = (targetWindow) => {
        if (targetWindow.isFullScreen()) targetWindow.setFullScreen(false);
        if (targetWindow.isMinimized()) targetWindow.restore();
        if (targetWindow.isMaximized()) targetWindow.unmaximize();
    };

    const setSubWindowBoundsByUrl = async (windowUrl, options = {}) => {
        const normalizedWindowUrl = normalizeSubWindowUrl(windowUrl);
        const targetWindow = normalizedWindowUrl ? openWindows.get(normalizedWindowUrl) : null;
        if (!targetWindow || targetWindow.isDestroyed()) {
            return { success: false, error: 'window-not-found', path: normalizedWindowUrl };
        }

        const displays = screen.getAllDisplays();
        const requestedDisplayId = options.displayId;
        const currentBounds = targetWindow.getBounds();
        const currentDisplay = screen.getDisplayMatching(currentBounds);
        const targetDisplay = requestedDisplayId === undefined || requestedDisplayId === null
            ? currentDisplay
            : displays.find(display => String(display.id) === String(requestedDisplayId));
        if (!targetDisplay) {
            return {
                success: false,
                error: `display-not-found:${String(requestedDisplayId)}`,
                availableDisplays: listDisplaySnapshots(),
            };
        }

        const requestedBounds = options.bounds && typeof options.bounds === 'object' ? options.bounds : options;
        const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
        const relativeToDisplay = requestedDisplayId !== undefined
            && requestedDisplayId !== null
            && options.relativeToDisplay !== false;
        const currentRelativeX = currentBounds.x - currentDisplay.workArea.x;
        const currentRelativeY = currentBounds.y - currentDisplay.workArea.y;
        const rawX = numberOr(requestedBounds.x, targetDisplay.workArea.x + currentRelativeX);
        const rawY = numberOr(requestedBounds.y, targetDisplay.workArea.y + currentRelativeY);
        const candidate = {
            x: relativeToDisplay && Number.isFinite(Number(requestedBounds.x))
                ? targetDisplay.workArea.x + rawX
                : rawX,
            y: relativeToDisplay && Number.isFinite(Number(requestedBounds.y))
                ? targetDisplay.workArea.y + rawY
                : rawY,
            width: numberOr(requestedBounds.width, currentBounds.width),
            height: numberOr(requestedBounds.height, currentBounds.height),
        };
        const minimum = { width: SUB_WINDOW_MIN_WIDTH, height: SUB_WINDOW_MIN_HEIGHT };
        const sizeClamped = clampBoundsToWorkArea(candidate, targetDisplay.workArea, minimum);
        const nextBounds = options.clampToWorkArea === false
            ? { ...sizeClamped, x: candidate.x, y: candidate.y }
            : sizeClamped;

        prepareWindowForBoundsChange(targetWindow);
        targetWindow.setBounds(nextBounds);
        if (options.focus === true) focusSubWindow(targetWindow);
        await new Promise(resolve => setTimeout(resolve, 120));
        return {
            success: true,
            requested: {
                displayId: requestedDisplayId ?? null,
                relativeToDisplay,
                clampToWorkArea: options.clampToWorkArea !== false,
                bounds: requestedBounds,
            },
            state: readSubWindowState(normalizedWindowUrl),
        };
    };

    const resolveArrangementDisplays = (options = {}) => {
        const allDisplays = screen.getAllDisplays();
        const requestedIds = Array.isArray(options.displayIds) ? [...new Set(options.displayIds.map(String))] : [];
        if (requestedIds.length > 0) {
            const selected = requestedIds
                .map(id => allDisplays.find(display => String(display.id) === id))
                .filter(Boolean);
            if (selected.length !== requestedIds.length) {
                const foundIds = new Set(selected.map(display => String(display.id)));
                return {
                    error: `display-not-found:${requestedIds.filter(id => !foundIds.has(id)).join(',')}`,
                    displays: [],
                };
            }
            return { displays: selected };
        }
        if (options.displayMode === 'all') {
            const current = screen.getDisplayMatching(mainWindow.getBounds());
            return {
                displays: [
                    current,
                    ...allDisplays.filter(display => display.id !== current.id)
                        .sort((left, right) => left.bounds.x - right.bounds.x || left.bounds.y - right.bounds.y),
                ],
            };
        }
        if (options.displayMode === 'primary') {
            return { displays: [screen.getPrimaryDisplay()] };
        }
        return { displays: [screen.getDisplayMatching(mainWindow.getBounds())] };
    };

    const arrangeSubWindows = async (options = {}) => {
        const layout = CHILD_WINDOW_LAYOUTS.includes(options.layout) ? options.layout : 'auto';
        const requestedPaths = Array.isArray(options.paths)
            ? [...new Set(options.paths.map(normalizeSubWindowUrl).filter(Boolean))]
            : [];
        const entries = [];
        const missingPaths = [];
        const candidates = requestedPaths.length > 0 ? requestedPaths : [...openWindows.keys()];
        for (const windowUrl of candidates) {
            const targetWindow = openWindows.get(windowUrl);
            if (!targetWindow || targetWindow.isDestroyed()) {
                openWindows.delete(windowUrl);
                missingPaths.push(windowUrl);
                continue;
            }
            entries.push({ path: windowUrl, window: targetWindow });
        }
        if (requestedPaths.length > 0 && missingPaths.length > 0) {
            return {
                success: false,
                error: 'window-not-found',
                missingPaths,
                message: '部分目标子窗口未打开；请先打开或 detach 后再排列。',
            };
        }
        if (entries.length === 0) {
            return { success: false, error: 'no-open-windows', message: '当前没有可排列的独立子窗口。' };
        }

        const displayResolution = resolveArrangementDisplays(options);
        if (displayResolution.error) {
            return {
                success: false,
                error: displayResolution.error,
                availableDisplays: listDisplaySnapshots(),
            };
        }
        const displays = displayResolution.displays.slice(0, entries.length);
        const baseCount = Math.floor(entries.length / displays.length);
        let remainder = entries.length % displays.length;
        let cursor = 0;
        const arranged = [];
        const displayResults = [];
        for (const display of displays) {
            const groupSize = baseCount + (remainder > 0 ? 1 : 0);
            remainder = Math.max(0, remainder - 1);
            const group = entries.slice(cursor, cursor + groupSize);
            cursor += groupSize;
            const calculation = calculateChildWindowLayout(layout, group.length, display.workArea, options);
            displayResults.push({
                displayId: display.id,
                requestedLayout: calculation.requestedLayout,
                resolvedLayout: calculation.resolvedLayout,
                windowCount: group.length,
            });
            group.forEach((entry, index) => {
                prepareWindowForBoundsChange(entry.window);
                const minimum = { width: SUB_WINDOW_MIN_WIDTH, height: SUB_WINDOW_MIN_HEIGHT };
                const bounds = clampBoundsToWorkArea(calculation.bounds[index], display.workArea, minimum);
                entry.window.setBounds(bounds);
                entry.window.show();
                arranged.push({ path: entry.path, bounds, displayId: display.id });
            });
        }
        if (options.focus !== false && entries[0]) focusSubWindow(entries[0].window);
        await new Promise(resolve => setTimeout(resolve, 160));
        return {
            success: true,
            requestedLayout: layout,
            displayMode: options.displayMode || 'current',
            displays: displayResults,
            windows: arranged.map(item => ({ ...item, state: readSubWindowState(item.path) })),
        };
    };

    const controlSubWindowByUrl = async (windowUrl, action) => {
        const normalizedWindowUrl = normalizeSubWindowUrl(windowUrl);
        const targetWindow = normalizedWindowUrl ? openWindows.get(normalizedWindowUrl) : null;
        if (!targetWindow || targetWindow.isDestroyed()) {
            return { success: false, error: 'window-not-found', state: readSubWindowState(normalizedWindowUrl) };
        }

        switch (String(action || '')) {
            case 'focus':
                focusSubWindow(targetWindow);
                break;
            case 'restore':
                if (targetWindow.isMinimized()) targetWindow.restore();
                targetWindow.show();
                targetWindow.focus();
                break;
            case 'minimize':
                targetWindow.minimize();
                break;
            case 'maximize':
                if (targetWindow.isMinimized()) targetWindow.restore();
                if (!targetWindow.isMaximized()) targetWindow.maximize();
                targetWindow.show();
                break;
            case 'unmaximize':
                if (targetWindow.isMaximized()) targetWindow.unmaximize();
                break;
            case 'close':
                targetWindow.close();
                break;
            default:
                return {
                    success: false,
                    error: `unsupported-window-action:${String(action || '')}`,
                    state: readSubWindowState(normalizedWindowUrl),
                };
        }

        await new Promise((resolve) => setTimeout(resolve, 120));
        return { success: true, state: readSubWindowState(normalizedWindowUrl) };
    };

    const requestChildAppHostCommand = (windowUrl, command, timeoutMs = 120000) => {
        const normalizedWindowUrl = normalizeSubWindowUrl(windowUrl);
        const targetWindow = normalizedWindowUrl ? openWindows.get(normalizedWindowUrl) : null;
        if (!targetWindow || targetWindow.isDestroyed()) {
            return Promise.resolve({ ok: false, message: `独立子应用窗口未打开: ${normalizedWindowUrl}` });
        }

        return new Promise((resolve) => {
            const requestId = `child-app-host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const responseChannel = 'child-app-host-command-response';
            const timer = setTimeout(() => {
                ipcMain.removeListener(responseChannel, listener);
                resolve({ ok: false, message: `子应用宿主命令超时: ${command?.action || 'unknown'}` });
            }, timeoutMs);
            const listener = (event, payload = {}) => {
                if (event.sender !== targetWindow.webContents || payload.requestId !== requestId) {
                    return;
                }
                clearTimeout(timer);
                ipcMain.removeListener(responseChannel, listener);
                resolve(payload.result && typeof payload.result === 'object'
                    ? payload.result
                    : { ok: false, message: '子应用宿主返回了无效结果' });
            };

            ipcMain.on(responseChannel, listener);
            targetWindow.webContents.send('child-app-host-command', { requestId, command });
        });
    };

    const loadSubWindowBasePage = (webContents) => {
        /** 池中仅占位，不加�?SPA 根页，避免出�?index / 首页再切目标页的闪屏；正式打开时再 load 路由 */
        webContents.loadURL('about:blank');
    };

    /**
     * @param {import('electron').BrowserWindow} subWindow
     * @param {string} windowUrl
     */
    const attachSubWindowLifecycleListeners = (subWindow, windowUrl) => {
        subWindow.on('enter-full-screen', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-full-screen-changed', true);
                }
            } catch (error) {
                console.error('Error sending sub-window-full-screen-changed:', error.message);
            }
        });

        subWindow.on('leave-full-screen', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-full-screen-changed', false);
                }
            } catch (error) {
                console.error('Error sending sub-window-full-screen-changed:', error.message);
            }
        });

        subWindow.on('maximize', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-maximize-changed', true);
                }
            } catch (error) {
                console.error('Error sending window-maximize-changed:', error.message);
            }
        });

        subWindow.on('unmaximize', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-maximize-changed', false);
                }
            } catch (error) {
                console.error('Error sending window-maximize-changed:', error.message);
            }
        });

        subWindow.on('closed', () => {
            openWindows.delete(windowUrl);
            notifySubWindowState(windowUrl, false);
            const childToolId = resolveChildToolIdFromWindowUrl(windowUrl);
            if (childToolId) {
                const releaseResult = releaseChildToolSession(childToolId);
                if (releaseResult.success) notifyChildToolSessionStateChanged();
            }
        });
    };

    mainWindow.on('focus', () => {
        try {
            // 仅清除本功能设置�?Dock 角标，避免覆盖其它模块可能的徽章
            if (process.platform === 'darwin' && app.dock && typeof app.dock.getBadge === 'function') {
                try {
                    if (app.dock.getBadge() === '!') {
                        app.dock.setBadge('');
                    }
                } catch (_e) { /* dock API 不可用时忽略 */ }
            }
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-focus');
            }

        } catch (error) {
            console.error('Error sending window-focus:', error.message);
        }
    });

    mainWindow.on('blur', () => {
        // 检查窗口是否已销毁以�?webContents 是否有效
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-blur');
            }

        } catch (error) {
            console.error('Error sending window-blur:', error.message);
        }
    });

    mainWindow.on('enter-full-screen', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-full-screen-changed', true);
            }
        } catch (error) {
            console.error('Error sending window-full-screen-changed:', error.message);
        }
    });

    mainWindow.on('leave-full-screen', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-full-screen-changed', false);
            }
        } catch (error) {
            console.error('Error sending window-full-screen-changed:', error.message);
        }
    });

    // 为主窗口注册最大化/还原状态监�?
    mainWindow.on('maximize', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-maximize-changed', true);
            }
        } catch (error) {
            console.error('Error sending window-maximize-changed:', error.message);
        }
    });

    mainWindow.on('unmaximize', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-maximize-changed', false);
            }
        } catch (error) {
            console.error('Error sending window-maximize-changed:', error.message);
        }
    });


    ipcMain.on("window-open", (event, data) => {
        const windowUrl = normalizeSubWindowUrl(data.path);
        const width = data.width ? data.width : 800;
        const height = data.height ? data.height : 600;
        const alwaysOnTop = data.alwaysOnTop ? data.alwaysOnTop : false;
        const needInitPayload = !!(data.data || data.url || data.title);

        // 检查是否已存在该URL的窗�?
        if (openWindows.has(windowUrl)) {
            const existingWindow = openWindows.get(windowUrl);
            // 确保窗口仍然有效
            if (existingWindow && !existingWindow.isDestroyed()) {
                // 激活已存在的窗�?
                notifySubWindowState(windowUrl, true);
                focusSubWindow(existingWindow);
                return;
            } else {
                // 如果窗口已被销毁，从映射中移除
                openWindows.delete(windowUrl);
            }
        }

        let subWindow = null;
        while (subWindowPool.length > 0) {
            const candidate = subWindowPool.shift();
            if (!candidate || candidate.isDestroyed()) {
                continue;
            }
            removePoolHandlersFromWin(candidate, loadSubWindowBasePage);
            subWindow = candidate;
            subWindow.setBackgroundColor(getSubWindowBackgroundColor());
            break;
        }

        if (!subWindow) {
            subWindow = new BrowserWindow({
                frame: false,
                show: false,
                opacity: 0,
                backgroundColor: getSubWindowBackgroundColor(),
                autoHideMenuBar: true,
                thickFrame: true,
                titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
                alwaysOnTop,
                width,
                height,
                minWidth: SUB_WINDOW_MIN_WIDTH,
                minHeight: SUB_WINDOW_MIN_HEIGHT,
                webPreferences: getSubWindowWebPreferences(),
            });
        } else {
            try {
                subWindow.setAlwaysOnTop(!!alwaysOnTop);
            } catch (e) {
                console.warn('[SubWindowPool] 子窗口置顶设置失�?', e.message);
            }
        }

        applySubWindowMinimumSize(subWindow);
        centerSubWindowOnMainDisplay(subWindow, mainWindow, width, height);

        openWindows.set(windowUrl, subWindow);
        notifySubWindowState(windowUrl, true);
        attachSubWindowLifecycleListeners(subWindow, windowUrl);

        const sendInitToSubWindow = () => {
            if (needInitPayload) {
                subWindow.webContents.send('window-init-data', {
                    url: data.url,
                    title: data.title,
                    data: data.data,
                });
            }
        };

        const revealPooledSubWindow = () => {
            try {
                if (subWindow.isDestroyed()) {
                    return;
                }
                subWindow.setOpacity(1);
                subWindow.setSkipTaskbar(false);
                subWindow.show();
                subWindow.focus();
            } catch (e) {
                console.warn('[SubWindowPool] 显示子窗口失�?', e.message);
            }
        };

        let subWindowRevealFinalized = false;
        let revealFallbackTimer = null;
        const finalizeSubWindowReveal = () => {
            if (subWindowRevealFinalized || subWindow.isDestroyed()) {
                return;
            }
            subWindowRevealFinalized = true;
            if (revealFallbackTimer) {
                clearTimeout(revealFallbackTimer);
                revealFallbackTimer = null;
            }
            sendInitToSubWindow();
            revealPooledSubWindow();
        };
        const revealAfterRendererPaint = () => {
            if (subWindowRevealFinalized || subWindow.isDestroyed()) {
                return;
            }
            subWindow.webContents.executeJavaScript(
                'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
                true
            ).then(finalizeSubWindowReveal).catch(finalizeSubWindowReveal);
        };

        subWindow.once('ready-to-show', revealAfterRendererPaint);
        subWindow.webContents.once('did-finish-load', revealAfterRendererPaint);
        subWindow.webContents.once('did-navigate-in-page', revealAfterRendererPaint);
        revealFallbackTimer = setTimeout(revealAfterRendererPaint, 3000);

        if (isDevServeSubWindow()) {
            subWindow.loadURL(`http://localhost:4200/#/${data.path}`);
        } else {
            subWindow.loadFile('renderer/index.html', { hash: `#/${data.path}` });
        }
    });

    ipcMain.handle("window-focus-by-url", (_event, windowUrl) => {
        return focusSubWindowByUrl(windowUrl);
    });

    ipcMain.handle("window-state-by-url", (_event, windowUrl) => {
        return readSubWindowState(windowUrl);
    });

    ipcMain.handle("window-list", () => {
        return listSubWindowEnvironment();
    });

    ipcMain.handle("window-set-bounds-by-url", async (_event, payload = {}) => {
        return await setSubWindowBoundsByUrl(payload.path, payload);
    });

    ipcMain.handle("window-arrange", async (_event, payload = {}) => {
        return await arrangeSubWindows(payload);
    });

    ipcMain.handle("window-control-by-url", async (_event, payload = {}) => {
        return await controlSubWindowByUrl(payload.path, payload.action);
    });

    ipcMain.handle("child-app-host-command-by-url", (_event, payload = {}) => {
        return requestChildAppHostCommand(payload.path, payload.command);
    });

    ipcMain.handle("child-tool-session-acquire", (_event, toolId) => {
        const normalizedToolId = sanitizeChildToolId(toolId);
        const session = childToolSessions.get(normalizedToolId);
        if (!session?.hostInfo) {
            return null;
        }

        if (!isChildToolSessionAlive(session)) {
            cancelChildToolRelease(session);
            childToolSessions.delete(normalizedToolId);
            return null;
        }

        cancelChildToolRelease(session);
        session.refCount += 1;
        return cloneChildToolSession(session);
    });

    ipcMain.handle("child-tool-session-register", async (_event, payload = {}) => {
        const toolId = sanitizeChildToolId(payload.toolId);
        if (!toolId || !payload.hostInfo || !payload.streamId) {
            return { success: false, reason: 'invalid-payload' };
        }

        const existing = childToolSessions.get(toolId);
        if (existing && existing.streamId && existing.streamId !== payload.streamId) {
            cancelChildToolRelease(existing);
            await stopChildToolSessionProcess(existing);
        }

        childToolSessions.set(toolId, {
            hostInfo: payload.hostInfo,
            streamId: payload.streamId,
            refCount: 1,
            releaseTimer: null,
        });

        notifyChildToolSessionStateChanged();
        return { success: true, session: cloneChildToolSession(childToolSessions.get(toolId)) };
    });

    ipcMain.handle("child-tool-session-release", (_event, payload) => {
        const result = releaseChildToolSession(payload);
        notifyChildToolSessionStateChanged();
        return result;
    });

    ipcMain.handle("child-tool-session-restart", async (_event, toolId) => {
        const result = await restartChildToolSession(toolId);
        notifyChildToolSessionStateChanged();
        return result;
    });

    ipcMain.handle("child-tool-session-unregister", (_event, payload = {}) => {
        const toolId = sanitizeChildToolId(payload.toolId);
        const session = childToolSessions.get(toolId);
        if (!session || (payload.streamId && session.streamId !== payload.streamId)) {
            return { success: false, reason: 'not-found' };
        }

        cancelChildToolRelease(session);
        childToolSessions.delete(toolId);
        notifyChildToolSessionStateChanged();
        return { success: true };
    });

    ipcMain.handle("child-tool-session-list", () => {
        return listChildToolSessions();
    });

    ipcMain.handle("child-tool-session-stop", async (_event, toolId) => {
        const normalizedToolId = sanitizeChildToolId(toolId);
        const session = childToolSessions.get(normalizedToolId);
        if (!session) {
            return { success: false, reason: 'not-found' };
        }
        cancelChildToolRelease(session);
        await stopChildToolSessionProcess(session);
        childToolSessions.delete(normalizedToolId);
        notifyChildToolSessionStateChanged();
        return { success: true };
    });

    ipcMain.on("window-minimize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow) {
            senderWindow.minimize();
        }
    });

    ipcMain.on("window-maximize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow && !senderWindow.isMaximized()) {
            senderWindow.maximize();
        }
    });

    ipcMain.handle("window-set-size", (event, data = {}) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        return setCurrentWindowSize(senderWindow, data.width, data.height);
    });

    ipcMain.on("window-close", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        // 检查是否是主窗口，如果是主窗口，关闭整个应用程�?
        if (senderWindow === mainWindow) {
            app.quit();
            // Attempt to terminate any residual helper processes on exit.
            terminateAilyProcess();
        } else {
            senderWindow.close();
        }
    });

    // Mac 平台下处理系统关闭按钮的关闭检�?
    if (process.platform === 'darwin') {
        mainWindow.on('close', (event) => {
            event.preventDefault();
            mainWindow.webContents.send('window-close-request');
        });

        // 监听渲染进程返回的关闭确认结�?
        ipcMain.on('window-close-confirmed', (event) => {
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            if (senderWindow === mainWindow) {
                mainWindow.removeAllListeners('close');
                mainWindow.close();
                app.quit();
                terminateAilyProcess();
            }
        });
    }

    // 修改为同步处理程�?
    ipcMain.on("window-is-maximized", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isMaximized = senderWindow ? senderWindow.isMaximized() : false;
        event.returnValue = isMaximized;
    });

    // 添加 unmaximize 处理程序
    ipcMain.on("window-unmaximize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow && senderWindow.isMaximized()) {
            senderWindow.unmaximize();
        }
    });

    // 监听获取全屏状态的请求
    ipcMain.handle('window-is-full-screen', (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        return senderWindow.isFullScreen();
    });

    // 检查窗口是否获得焦点（同步�?
    ipcMain.on("window-is-focused", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isFocused = senderWindow ? senderWindow.isFocused() : false;
        event.returnValue = isFocused;
    });

    /**
     * 在应用处于后台时请求用户注意：任务栏闪烁（Windows）、Dock 弹跳与角标（macOS）�?
     * 与系统通知配合，解决「通知一闪而过不易察觉」的问题�?
     */
    ipcMain.handle('window-request-attention', (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        return requestWindowAttention(senderWindow);
    });

    // 检查窗口是否最小化（同步）
    ipcMain.on("window-is-minimized", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isMinimized = senderWindow ? senderWindow.isMinimized() : false;
        event.returnValue = isMinimized;
    });

    ipcMain.on("window-go-main", (event, data) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        mainWindow.webContents.send("window-go-main", normalizeSubWindowUrl(data));
        senderWindow.close();
    });

    ipcMain.handle("window-return-main", (event, data) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const normalizedPath = normalizeSubWindowUrl(data);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("window-go-main", normalizedPath);
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            if (typeof mainWindow.moveTop === 'function') {
                mainWindow.moveTop();
            }
            mainWindow.focus();
        }
        if (senderWindow && senderWindow !== mainWindow && !senderWindow.isDestroyed()) {
            senderWindow.hide();
        }
        return { success: true };
    });

    ipcMain.on("window-alwaysOnTop", (event, alwaysOnTop) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        senderWindow.setAlwaysOnTop(alwaysOnTop);
    });

    ipcMain.handle("window-send", (event, data) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (data.to == 'main') {
            // 创建唯一消息ID
            const messageId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
            // 创建Promise等待响应
            return new Promise((resolve) => {
                // 设置一次性监听器接收响应
                const responseListener = (event, response) => {
                    if (response.messageId === messageId) {
                        // 收到对应ID的响应，移除监听器并返回结果
                        ipcMain.removeListener('main-window-response', responseListener);
                        // console.log('window-send response', response);
                        resolve(response.data || "success");
                    }
                };
                // 注册监听�?
                ipcMain.on('main-window-response', responseListener);
                // 发送消息到main窗口，带上messageId
                mainWindow.webContents.send("window-receive", {
                    form: senderWindow.id,
                    data: data.data,
                    messageId: messageId
                });
                // 自定义超时或默认9秒超�?
                setTimeout(() => {
                    ipcMain.removeListener('main-window-response', responseListener);
                    resolve("timeout");
                }, data?.timeout || 9000);
            });
        }
        return true;
    });

    ipcMain.on(CODE_VIEWER_STATE_UPDATE_CHANNEL, (_event, data = {}) => {
        codeViewerState = {
            ...codeViewerState,
            ...data,
            updatedAt: Date.now(),
        };
        broadcastCodeViewerState();
    });

    ipcMain.handle(CODE_VIEWER_STATE_GET_CHANNEL, () => codeViewerState);

    // 用于sub窗口改变main窗口状态显�?
    ipcMain.on('state-update', (event, data) => {
        console.log('state-update: ', data);
        mainWindow.webContents.send('state-update', data);
    });

    // =====================================================
    // iframe 模块 IPC 通讯（规范：iframe-message-{模块名}，参�?{type, data}�?
    // =====================================================

    const IFRAME_CHANNEL_CONNECTION_GRAPH = 'iframe-message-connection-graph';

    ipcMain.on(IFRAME_CHANNEL_CONNECTION_GRAPH, (event, payload) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isFromMain = senderWindow && senderWindow.id === mainWindow.id;
        if (isFromMain) {
            // 主窗�?�?子窗口：广播给所有子窗口，由各模块按 type 自行处理（含 get-graph-data�?
            openWindows.forEach((subWindow) => {
                try {
                    if (subWindow && !subWindow.isDestroyed() && subWindow.webContents && !subWindow.webContents.isDestroyed()) {
                        subWindow.webContents.send(IFRAME_CHANNEL_CONNECTION_GRAPH, payload);
                    }
                } catch (error) {
                    console.error('[IPC] 转发 iframe-message-connection-graph 失败:', error.message);
                }
            });
            // 嵌入模式：主窗口内的 connection-graph（如 blockly-editor �?graph-editor tab）也会发�?get-graph-data�?
            // 主窗口的 ConnectionGraphService 需要收到请求并响应，故主窗口发出的消息也需回传主窗�?
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send(IFRAME_CHANNEL_CONNECTION_GRAPH, payload);
            }
        } else {
            // 子窗�?�?主窗口：转发给主窗口（含 get-graph-data�?
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send(IFRAME_CHANNEL_CONNECTION_GRAPH, payload);
            }
        }
    });

    scheduleReplenishSubWindowPool(loadSubWindowBasePage);
}


module.exports = {
    registerWindowHandlers,
};
