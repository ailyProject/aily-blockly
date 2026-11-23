'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { renameForAtomicReplace } = require('./atomic-replace');
const { tryAcquireFileLock } = require('./native-file-lock');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fail = message => { throw Object.assign(new Error(message), { code: 'BUILD_EXECUTION_INVALID' }); };
function directory(parent, name, create = true) {
    const filename = path.join(parent, name);
    if (create) try { fs.mkdirSync(filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(filename).isDirectory() || fs.lstatSync(filename).isSymbolicLink()
        || !samePath(fs.realpathSync(filename), filename)) fail('Execution directory is linked or replaced.');
    return filename;
}
function storage(projectPath, create = false, cache = false) {
    const root = fs.realpathSync(projectPath);
    const parent = cache ? directory(directory(root, '.build', create), 'requests', create)
        : directory(directory(root, '.aily', create), 'build-executions', create);
    return { root, parent, cache, pointer: path.join(parent, 'current.json'), anchor: path.join(parent, 'execution.guard') };
}
function json(filename, limit = 1024 * 1024) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail('Invalid execution record.');
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function write(filename, value, assertOwned, replace = renameForAtomicReplace) {
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        replace(temp, filename, assertOwned);
    } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function locked(store, action) {
    const guard = tryAcquireFileLock(store.anchor);
    if (!guard) throw Object.assign(new Error('BUILD_WORKSPACE_BUSY: Another execution transition is running.'), { code: 'BUILD_WORKSPACE_BUSY' });
    try { return action(guard); } finally { guard.close(); }
}
function readOptional(read, ...args) {
    try { return read(...args); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function requestPath(root, id, cache, create = false) {
    const key = createHash('sha256').update(id).digest('hex');
    if (!cache) return path.join(directory(storage(root, create).parent, 'requests', create), key + '.json');
    const log = directory(directory(directory(root, '.log', create), 'compile', create), 'requests', create);
    return path.join(log, key + '.build.json');
}

function findRequest(root, id) {
    for (const cache of [true, false]) {
        const file = readOptional(requestPath, root, id, cache);
        if (!file || !readOptional(fs.lstatSync, file)) continue;
        const index = json(file);
        if (!index || index.version !== 1 || index.buildRequestId !== id) fail('Invalid request index.');
        return { file, index, cache };
    }
}

// Index replacement (explicit retry) and publication of an original outcome
// must serialize, even when a stopped worker reports after the retry started.
function updateRequest(file, action) {
    return locked({ anchor: path.join(path.dirname(file), '.build-receipts.guard') }, action);
}

function storeForExecution(root, id) {
    const cached = readOptional(storage, root, false, true);
    if (cached && readOptional(directory, cached.parent, id, false)) return cached;
    return storage(root);
}

function retainOutcome(record, outcome) {
    if (record.storage !== 'cache' || (record.operation === 'preprocess' && !record.explicitPreprocess)) return;
    const file = requestPath(record.logicalProjectPath, record.buildRequestId, true);
    updateRequest(file, guard => {
        const index = json(file);
        if (index.id !== record.id || index.buildRequestId !== record.buildRequestId) return;
        if (index.outcome) {
            if (JSON.stringify(index.outcome) !== JSON.stringify(outcome)) fail('Original build outcome changed.');
            return;
        }
        // Only the facts needed to observe the original request survive cache cleanup.
        const { version, id, buildRequestId, inputDigest, operation, logicalProjectPath, abiHash, buildSnapshot, sourceCapture, explicitPreprocess } = record;
        write(file, { ...index, record: { version, id, buildRequestId, inputDigest, operation, logicalProjectPath,
            layout: 'shared', storage: 'cache', abiHash, buildSnapshot, sourceCapture, explicitPreprocess }, outcome }, guard.assertHeld);
    });
}

module.exports = { directory, json, write, locked, readOptional, storage, requestPath, findRequest,
    updateRequest, storeForExecution, retainOutcome };
