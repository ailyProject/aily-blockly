'use strict';

const fs = require('node:fs');
const isWindowsSharingError = error => process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);

/** Keep the previous file visible while Windows readers briefly hold it open. */
function renameForAtomicReplace(source, target, assertOwned = () => {}) {
    let waitBuffer;
    for (let attempt = 0; ; attempt++) {
        assertOwned();
        try { fs.renameSync(source, target); return; }
        catch (error) {
            // The renderer also imports the receipt reader. Chromium may
            // disable shared memory there, while the managed build Node can wait.
            if (!isWindowsSharingError(error) || attempt >= 4
                || typeof SharedArrayBuffer !== 'function') throw error;
            waitBuffer ??= new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(waitBuffer, 0, 0, 20 * (2 ** attempt));
        }
    }
}

/** A stopped build's historical files can outlive the one admission that retired them. */
function retryDeferredWindowsFile(attempt, delay = 250) {
    if (delay > 16000) return;
    setTimeout(() => {
        try { if (attempt() === false) retryDeferredWindowsFile(attempt, delay * 2); }
        catch (error) {
            if (isWindowsSharingError(error)) retryDeferredWindowsFile(attempt, delay * 2);
        }
    }, delay).unref();
}

module.exports = { renameForAtomicReplace, isWindowsSharingError, retryDeferredWindowsFile };
