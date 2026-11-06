'use strict';

/** Normal cancellable Electron dialog, always parented to the current Main
 * window. The installed Electron35.7.5 MessageBoxOptions supports signal; on
 * macOS a parent is required for cancellation. No Electron import/UI action at
 * module load or construction, and cancellation is the selected default. */
function createMainNetworkNativeChooser({ dialog, getMainWindow } = {}) {
    if (!dialog || typeof dialog.showMessageBox !== 'function' || typeof getMainWindow !== 'function') return null;
    return async (input, signal) => {
        const main = getMainWindow();
        if (!main || main.isDestroyed() || !signal || signal.aborted) return { outcome: 'cancelled' };
        if (!Array.isArray(input.choices) || input.choices.length < 1 || input.choices.length > 16 || input.initialSelection !== null) throw new TypeError('Normal network chooser input changed');
        const result = await dialog.showMessageBox(main, { type: 'question', noLink: true,
            title: input.title, message: input.message,
            detail: input.choices.map((choice, index) => `${index + 1}. ${choice.label}\n${choice.detail}`).join('\n\n'),
            buttons: ['取消', ...input.choices.map(choice => `连接 ${choice.label}`)], defaultId: 0, cancelId: 0, signal });
        if (signal.aborted || main.isDestroyed() || getMainWindow() !== main) return { outcome: 'cancelled' };
        if (!Number.isSafeInteger(result?.response) || result.response < 0 || result.response > input.choices.length) throw new TypeError('Invalid normal network chooser response');
        return result.response === 0 ? { outcome: 'cancelled' } : { outcome: 'selected', endpointId: input.choices[result.response - 1].endpointId };
    };
}
module.exports = { createMainNetworkNativeChooser };
