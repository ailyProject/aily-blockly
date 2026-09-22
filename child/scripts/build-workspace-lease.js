'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const OWNER_ENV = 'AILY_BUILD_WORKSPACE_OWNER';
const SUPERVISOR_ENV = 'AILY_BUILD_WORKSPACE_SUPERVISOR';
const BUILDER_ENV = 'AILY_BUILDER_WORKSPACE';
const BUILDER_MARKER = 'aily-builder.lock';
const fault = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const OPERATIONS = new Set(['compile', 'preprocess', 'publish', 'clean', 'verify']);

/** Cooperative host build lease, not a file-editor lock or a security boundary.
 * A dead parent does NOT prove that its compiler descendants stopped. Therefore
 * no time-based/PID-only takeover is allowed; interruption retains the marker.
 */
function openWorkspace(projectPath) {
    const root = fs.realpathSync(projectPath), identity = fs.lstatSync(root);
    if (!identity.isDirectory()) throw fault('BUILD_WORKSPACE_INVALID', 'Project root is not a directory.');
    const directory = path.join(root, '.build');
    const check = () => {
        const current = fs.lstatSync(root);
        if (!sameFile(identity, current) || current.isSymbolicLink()) throw fault('BUILD_WORKSPACE_CHANGED', 'Project root changed.');
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(fs.realpathSync(directory)) !== canonical(directory)) {
            throw fault('BUILD_WORKSPACE_INVALID', 'Build directory must not be a symlink/junction.');
        }
    };
    try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    check();
    return { root, directory, filename: path.join(directory, 'aily-workspace.lock'), check };
}

function readOwner(workspace, filename = workspace.filename) {
    workspace.check();
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw fault('BUILD_WORKSPACE_INVALID', 'Unsafe build owner record.');
    const bytes = fs.readFileSync(filename, 'utf8');
    let record;
    try { record = JSON.parse(bytes); } catch { throw fault('BUILD_WORKSPACE_INVALID', 'Incomplete build owner record; no automatic takeover.'); }
    if (record?.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1
        || typeof record.token !== 'string' || !/^[a-f0-9-]{36}$/.test(record.token)
        || !OPERATIONS.has(record.operation)) throw fault('BUILD_WORKSPACE_INVALID', 'Invalid build owner record.');
    return { record, stat, bytes };
}

function processAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

function acquireBuildWorkspace(projectPath, operation, { inherited = undefined } = {}) {
    if (!OPERATIONS.has(operation)) throw fault('BUILD_WORKSPACE_INVALID', 'Invalid operation.');
    const workspace = openWorkspace(projectPath);
    if (inherited !== undefined) {
        // Only compile.js's direct preprocess child may borrow this owner. A
        // command launched elsewhere cannot silently turn into a nested build.
        const owner = readOwner(workspace);
        if (operation !== 'preprocess' || owner.record.operation !== 'compile' || owner.record.token !== inherited
            || owner.record.pid !== process.ppid || !processAlive(owner.record.pid)) {
            throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Preprocess does not belong to this live compile owner.');
        }
        return lease(workspace, owner, false);
    }
    let descriptor;
    try { descriptor = fs.openSync(workspace.filename, 'wx', 0o600); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = readOwner(workspace).record; } catch { /* A partial/unsafe marker is still exclusive. */ }
        if (previous && !processAlive(previous.pid)) {
            throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', `Host owner PID ${previous.pid} exited. Do not retry or remove its marker until all compiler descendants are confirmed stopped; then explicitly clean only .build/aily-workspace.lock.`);
        }
        throw fault('BUILD_WORKSPACE_BUSY', 'Another host build/preprocess owns this project. Retry after it finishes. An interrupted owner requires verified cleanup; do not delete its marker while compiler descendants may be running.');
    }
    const supervisor = process.env[SUPERVISOR_ENV];
    const record = { schemaVersion: 1, pid: process.pid, token: randomUUID(), operation, startedAt: new Date().toISOString(),
        ...(typeof supervisor === 'string' && /^[a-f0-9-]{36}$/.test(supervisor) ? { supervisor } : {}) };
    try {
        fs.writeFileSync(descriptor, JSON.stringify(record), 'utf8');
        return lease(workspace, readOwner(workspace), true);
    } finally { fs.closeSync(descriptor); }
}

function lease(workspace, owner, owns) {
    let released = false;
    const assertOwned = () => {
        if (released) throw fault('BUILD_WORKSPACE_CHANGED', 'Build lease was already released.');
        const current = readOwner(workspace);
        if (!sameFile(owner.stat, current.stat) || current.bytes !== owner.bytes || !processAlive(owner.record.pid)) {
            throw fault('BUILD_WORKSPACE_CHANGED', 'Build ownership changed; do not publish or remove another build\'s files.');
        }
    };
    const assertBuilderIdle = () => {
        assertOwned();
        try { fs.lstatSync(path.join(workspace.directory, BUILDER_MARKER)); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', 'Builder has not released its delegated phase. Confirm the complete process tree stopped before cleanup.');
    };
    // An orphaned child remains exclusive even if someone removed its parent
    // marker. Never let a new host writer overwrite that child's inputs.
    try { assertBuilderIdle(); }
    catch (error) {
        if (owns) { assertOwned(); fs.unlinkSync(workspace.filename); }
        throw error;
    }
    return {
        projectRoot: workspace.root,
        buildId: owner.record.token,
        assertOwned,
        assertBuilderIdle,
        childEnvironment: () => { assertOwned(); return { ...process.env, [OWNER_ENV]: owner.record.token }; },
        builderEnvironment: operation => {
            assertBuilderIdle();
            if (!['compile', 'preprocess', 'verify'].includes(operation)
                || !(owner.record.operation === operation || (owner.record.operation === 'compile' && operation === 'preprocess'))) {
                throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Invalid Builder delegation operation.');
            }
            return { ...process.env, [BUILDER_ENV]: JSON.stringify({ schemaVersion: 1, directory: workspace.directory,
                token: owner.record.token, operation, issuerPid: process.pid }) };
        },
        release: () => {
            if (released) return;
            assertBuilderIdle();
            if (owns) fs.unlinkSync(workspace.filename);
            released = true;
        },
    };
}

/** Only the registered command supervisor can clean its own interrupted build,
 * after the existing process-tree terminator confirms success. This is not a
 * generic stale-lock recovery or PID-only takeover API.
 */
function createBuildWorkspaceSupervisor(projectPath) {
    const workspace = openWorkspace(projectPath), token = randomUUID();
    return {
        environment: { [SUPERVISOR_ENV]: token },
        canReleaseResources: () => {
            // A normally finished child removed its own records. Another build's
            // record is not ours to release; unreadable records remain unsafe.
            for (const filename of [workspace.filename, path.join(workspace.directory, BUILDER_MARKER)]) {
                try { if (readOwner(workspace, filename).record.supervisor === token) return false; }
                catch (error) { if (error.code !== 'ENOENT') return false; }
            }
            return true;
        },
        releaseAfterTermination: stopped => {
            if (stopped !== true) return false;
            let owner;
            try { owner = readOwner(workspace); }
            catch (error) { if (error.code === 'ENOENT') return true; throw error; }
            if (owner.record.supervisor !== token || processAlive(owner.record.pid)) return false;
            const current = readOwner(workspace);
            if (!sameFile(owner.stat, current.stat) || owner.bytes !== current.bytes) return false;
            const builderPath = path.join(workspace.directory, BUILDER_MARKER);
            let builder;
            try { builder = readOwner(workspace, builderPath); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (builder) {
                if (builder.record.ownerToken !== owner.record.token || builder.record.supervisor !== token || processAlive(builder.record.pid)) return false;
                const currentBuilder = readOwner(workspace, builderPath);
                if (!sameFile(builder.stat, currentBuilder.stat) || builder.bytes !== currentBuilder.bytes) return false;
                fs.unlinkSync(builderPath);
            }
            fs.unlinkSync(workspace.filename);
            return true;
        },
    };
}

module.exports = { acquireBuildWorkspace, createBuildWorkspaceSupervisor, OWNER_ENV, BUILDER_ENV };
