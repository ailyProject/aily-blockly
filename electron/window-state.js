// All geometry in this module is in Electron DIP coordinates, never physical pixels.
const DEFAULT_SIZE = { width: 1200, height: 780 };
const DEFAULT_MINIMUM = { width: 800, height: 600 };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validBounds = rect => rect && ['x', 'y', 'width', 'height'].every(key => finite(rect[key]))
    && rect.width > 0 && rect.height > 0;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function isScreenSized(bounds, area) {
    return validBounds(bounds) && bounds.x <= area.x + 2 && bounds.y <= area.y + 2
        && bounds.x + bounds.width >= area.x + area.width - 2
        && bounds.y + bounds.height >= area.y + area.height - 2;
}

function fitNormalBounds(bounds, area, minimum = DEFAULT_MINIMUM) {
    // Reserve visible space around a normal window, including on very small desktops.
    const margin = Math.min(24, Math.floor(Math.min(area.width, area.height) / 20));
    const maxWidth = Math.max(1, Math.floor(area.width - margin * 2));
    const maxHeight = Math.max(1, Math.floor(area.height - margin * 2));
    const minWidth = Math.min(minimum.width, maxWidth);
    const minHeight = Math.min(minimum.height, maxHeight);
    const usable = validBounds(bounds) && !isScreenSized(bounds, area);
    const width = Math.round(clamp(usable ? bounds.width : DEFAULT_SIZE.width, minWidth, maxWidth));
    const height = Math.round(clamp(usable ? bounds.height : DEFAULT_SIZE.height, minHeight, maxHeight));
    const x = usable ? bounds.x : area.x + (area.width - width) / 2;
    const y = usable ? bounds.y : area.y + (area.height - height) / 2;
    return {
        x: Math.round(clamp(x, area.x + margin, area.x + area.width - margin - width)),
        y: Math.round(clamp(y, area.y + margin, area.y + area.height - margin - height)),
        width, height,
    };
}

function createWindowStateController({ screen, platform = process.platform, transitionTimeout = 1200 } = {}) {
    const records = new WeakMap();
    const metricHandlers = new Set();
    const refreshDisplays = () => { for (const handler of metricHandlers) handler(); };
    const displayEvents = ['display-metrics-changed', 'display-removed', 'display-added'];
    const displayFor = bounds => validBounds(bounds)
        ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
    const normalize = (bounds, minimum) => fitNormalBounds(bounds, displayFor(bounds).workArea, minimum);

    function snapshot(win) {
        const bounds = win.getBounds();
        const display = displayFor(bounds);
        const maximized = win.isMaximized();
        const fullScreen = win.isFullScreen();
        const minimized = win.isMinimized();
        return {
            maximized, fullScreen, minimized,
            mode: minimized ? (records.get(win)?.mode || 'normal')
                : fullScreen ? 'fullscreen' : (maximized || isScreenSized(bounds, display.workArea)) ? 'maximized' : 'normal',
            screenSized: isScreenSized(bounds, display.workArea),
            canRestore: !minimized && (maximized || fullScreen || isScreenSized(bounds, display.workArea)),
            bounds, normalBounds: records.get(win)?.normalBounds || win.getNormalBounds(),
            nativeNormalBounds: win.getNormalBounds(),
            minimumSize: win.getMinimumSize(),
            resizable: win.isResizable(), maximizable: win.isMaximizable(),
            displayId: display.id,
        };
    }

    function publish(win) {
        if (!win.isDestroyed() && !win.webContents?.isDestroyed()) {
            const state = snapshot(win);
            const record = records.get(win);
            const key = `${state.mode}/${state.minimized}/${state.maximized}/${state.fullScreen}/${state.canRestore}`;
            if (record?.publishedState === key) return;
            if (record) record.publishedState = key;
            win.webContents?.send('window-state-changed', state);
        }
    }

    function attach(win, { bounds, minimum } = {}) {
        if (records.has(win)) return records.get(win);
        const size = minimum || (() => { const [width, height] = win.getMinimumSize(); return { width, height }; })();
        const record = { normalBounds: normalize(bounds || win.getNormalBounds(), size), minimum: size, pending: null, mode: 'normal', displayId: displayFor(win.getBounds()).id };
        records.set(win, record);
        const refreshMinimum = () => {
            const area = displayFor(win.getBounds()).workArea;
            const fitted = fitNormalBounds(null, area, size);
            const next = [Math.min(size.width, fitted.width), Math.min(size.height, fitted.height)];
            const current = win.getMinimumSize();
            // Reapplying constraints during a Windows maximize can restore the native window.
            if (next[0] !== current[0] || next[1] !== current[1]) win.setMinimumSize(...next);
        };
        refreshMinimum();
        const changed = () => {
            if (win.isDestroyed()) return;
            const displayId = displayFor(win.getBounds()).id;
            if (record.displayId !== displayId) { record.displayId = displayId; refreshMinimum(); }
            const state = snapshot(win);
            if (!state.minimized) record.mode = state.mode;
            if (!record.pending && !state.canRestore && !state.minimized) record.normalBounds = normalize(state.bounds, size);
            publish(win);
        };
        const metricsChanged = () => {
            if (win.isDestroyed()) return;
            refreshMinimum();
            record.normalBounds = normalize(record.normalBounds, size);
            if (!record.pending && !win.isMaximized() && !win.isFullScreen() && !win.isMinimized()) win.setBounds(normalize(win.getBounds(), size));
            publish(win);
        };
        for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) win.on(event, changed);
        if (metricHandlers.size === 0) for (const event of displayEvents) screen.on(event, refreshDisplays);
        metricHandlers.add(metricsChanged);
        win.once('closed', () => {
            metricHandlers.delete(metricsChanged);
            if (metricHandlers.size === 0) for (const event of displayEvents) screen.removeListener(event, refreshDisplays);
        });
        return record;
    }

    async function transition(win, event, action) {
        let listener, timer;
        const completed = new Promise(resolve => {
            listener = resolve;
            win.once(event, listener);
            timer = setTimeout(resolve, transitionTimeout);
        });
        try { action(); await completed; }
        finally { clearTimeout(timer); win.removeListener(event, listener); }
        if (win.isDestroyed()) throw new Error('Window closed during state transition');
    }

    function change(win, action = 'toggle') {
        const record = attach(win);
        // Coalesce rapid clicks while native fullscreen/restore animations run.
        if (record.pending) return record.pending;
        const run = async () => {
            const before = snapshot(win);
            const restore = action === 'restore' || (action === 'toggle' && before.canRestore);
            if (restore) {
                if (win.isFullScreen()) await transition(win, 'leave-full-screen', () => win.setFullScreen(false));
                if (win.isFullScreen()) throw new Error('Window did not leave fullscreen');
                if (win.isMaximized()) await transition(win, 'unmaximize', () => win.unmaximize());
                if (win.isMinimized() || win.isMaximized()) win.restore();
                const area = displayFor(before.bounds).workArea;
                const target = fitNormalBounds(record.normalBounds, area, record.minimum);
                record.normalBounds = target;
                // Always apply a valid normal rectangle, even if native isMaximized() is false.
                win.setBounds(target);
                if (platform === 'win32') {
                    await new Promise(resolve => setTimeout(resolve, 60));
                    if (win.isDestroyed()) throw new Error('Window closed during restore');
                    win.setBounds(target);
                }
            } else {
                record.normalBounds = normalize(win.getBounds(), record.minimum);
                await transition(win, 'maximize', () => win.maximize());
            }
            const state = snapshot(win);
            if (restore && state.canRestore) throw new Error('Window did not return to normal bounds');
            return { success: true, state };
        };
        record.pending = Promise.resolve().then(run).catch(error => ({
            success: false, error: error.message, state: win.isDestroyed() ? null : snapshot(win),
        })).finally(() => { record.pending = null; publish(win); });
        return record.pending;
    }

    function diagnostics(win) {
        attach(win);
        const primary = screen.getPrimaryDisplay();
        return {
            window: snapshot(win),
            displays: screen.getAllDisplays().map(display => ({
                id: display.id, label: display.label || '', primary: display.id === primary.id,
                scaleFactor: display.scaleFactor, bounds: display.bounds, workArea: display.workArea,
                rotation: display.rotation, displayFrequency: display.displayFrequency,
            })),
        };
    }
    return { attach, change, snapshot, diagnostics, normalize };
}

module.exports = { createWindowStateController, fitNormalBounds, isScreenSized };
