'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const FILE = 'aily-build-input-context.json', LIMIT = 4 * 1024 * 1024;
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const fail = () => { throw Object.assign(new Error('Build input context is missing, unsafe or does not match this build.'), { code: 'BUILD_INPUT_CONTEXT_INVALID' }); };

// Bind bounded private bytes, not SDK content. The Builder remains the only
// implementation of input-tree verification; no paths escape this helper.
function readBuildInputContextBinding(projectPath, inputsDigest) {
    const directory = path.join(fs.realpathSync(projectPath), '.build');
    if (key(fs.realpathSync(directory)) !== key(directory)) fail();
    const filename = path.join(directory, FILE), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > LIMIT) fail();
    const fd = fs.openSync(filename, 'r');
    let bytes;
    try {
        const opened = fs.fstatSync(fd);
        // Windows Node/Electron versions may report dev=0 for pathname stats
        // but a real device ID for fstat. Compare it only when available.
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino
            || (stat.dev !== 0 && opened.dev !== stat.dev) || opened.size !== stat.size) fail();
        bytes = Buffer.alloc(stat.size + 1);
        let size = 0, read;
        while (size < bytes.length && (read = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += read;
        if (size !== stat.size) fail();
        bytes = bytes.subarray(0, size);
    } finally { fs.closeSync(fd); }
    const context = JSON.parse(bytes.toString('utf8'));
    if (context?.schemaVersion !== 1 || context.kind !== 'aily-build-input-context'
        || typeof context.buildPath !== 'string' || key(context.buildPath) !== key(directory)
        || !/^[a-f0-9]{64}$/.test(inputsDigest) || context.preparedInputsDigest !== inputsDigest) fail();
    return createHash('sha256').update(bytes).digest('hex');
}

module.exports = { readBuildInputContextBinding };
