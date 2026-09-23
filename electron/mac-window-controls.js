const RENDERER_CLOSE_AUTHORIZED = Symbol('renderer-close-authorized');

/**
 * Electron 35 can render visible but inert traffic-light buttons when a
 * hiddenInset window is also frameless. Keep the native frame on macOS;
 * hiddenInset still lets the existing HTML title bar fill the window.
 */
function shouldUseNativeMacFrame(platform = process.platform) {
    return platform === 'darwin';
}

function authorizeRendererWindowClose(win) {
    if (!win || win.isDestroyed?.()) return false;
    win[RENDERER_CLOSE_AUTHORIZED] = true;
    return true;
}

/**
 * Route the native traffic-light close through the renderer so subapps get
 * the same beforeClose / unsaved-change handling as the HTML close button.
 */
function attachMacWindowCloseBridge(win, requestRendererClose, options = {}) {
    const platform = options.platform || process.platform;
    if (platform !== 'darwin' || !win || typeof win.on !== 'function') return false;

    const isQuitting = typeof options.isQuitting === 'function'
        ? options.isQuitting
        : () => false;
    const onClose = event => {
        if (win[RENDERER_CLOSE_AUTHORIZED]) {
            delete win[RENDERER_CLOSE_AUTHORIZED];
            return;
        }
        if (isQuitting()) return;
        event?.preventDefault?.();
        requestRendererClose?.();
    };
    win.on('close', onClose);
    return true;
}

module.exports = {
    attachMacWindowCloseBridge,
    authorizeRendererWindowClose,
    shouldUseNativeMacFrame,
};
