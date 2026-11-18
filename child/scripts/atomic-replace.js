'use strict';

const fs = require('node:fs');

/** Keep the previous file visible while Windows readers briefly hold it open. */
function renameForAtomicReplace(source, target, assertOwned = () => {}) {
    let waitBuffer;
    for (let attempt = 0; ; attempt++) {
        assertOwned();
        try { fs.renameSync(source, target); return; }
        catch (error) {
            // The renderer also imports the receipt reader. Chromium may
            // disable shared memory there, while the managed build Node can wait.
            if (process.platform !== 'win32' || attempt >= 4
                || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
                || typeof SharedArrayBuffer !== 'function') throw error;
            waitBuffer ??= new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(waitBuffer, 0, 0, 20 * (2 ** attempt));
        }
    }
}

module.exports = { renameForAtomicReplace };
