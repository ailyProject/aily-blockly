'use strict';

const fs = require('node:fs');
const { tryLock } = require('fs-native-extensions');
const fault = message => Object.assign(new Error(`BUILD_WORKSPACE_CHANGED: ${message}`), { code: 'BUILD_WORKSPACE_CHANGED' });

// The anchor is permanent: never unlink/rename it, or different processes could
// lock different inodes. Its contents/existence do not represent ownership.
function tryAcquireFileLock(filename) {
    const descriptor = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600);
    let closed = false;
    const close = () => { if (!closed) { closed = true; fs.closeSync(descriptor); } };
    try {
        const identity = fs.lstatSync(filename), opened = fs.fstatSync(descriptor);
        // Windows fstat.dev and lstat.dev can differ; compare inode + path identity.
        if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1 || identity.ino !== opened.ino) {
            throw fault('Unsafe native lock anchor.');
        }
        let granted;
        try { granted = tryLock(descriptor); }
        catch (error) {
            if (['EAGAIN', 'EACCES', 'EBUSY'].includes(error.code)) granted = false;
            else throw error;
        }
        if (!granted) { close(); return null; }
        const assertHeld = () => {
            if (closed) throw fault('Native lock handle is closed.');
            const current = fs.lstatSync(filename);
            if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
                || current.dev !== identity.dev || current.ino !== identity.ino) throw fault('Native lock anchor changed.');
        };
        assertHeld();
        return { assertHeld, close, get closed() { return closed; } };
    } catch (error) { close(); throw error; }
}

module.exports = { tryAcquireFileLock };
