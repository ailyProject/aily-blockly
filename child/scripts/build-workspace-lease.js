'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const OWNER_ENV = 'AILY_BUILD_WORKSPACE_OWNER';
const SUPERVISOR_ENV = 'AILY_BUILD_WORKSPACE_SUPERVISOR';
const BUILDER_ENV = 'AILY_BUILDER_WORKSPACE';
const BUILDER_MARKER = 'aily-builder.lock';
const LEGACY_RECOVERY_MARKER = 'aily-workspace-recovery.lock';
// Only needed if a filesystem error prevents recording a failed claim's release.
const abandonedClaims = new Set();
const UUID = /^[a-f0-9-]{36}$/;
const fault = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const OPERATIONS = new Set(['compile', 'preprocess', 'publish', 'clean', 'verify']);
const NON_DELEGATING_OPERATIONS = new Set(['publish', 'clean']);

/** Cooperative host build lease, not a file-editor lock or a security boundary.
 * A dead parent does NOT prove that its compiler descendants stopped. Therefore
 * compile/preprocess/verify interruptions retain the marker. Publication and
 * cleanup never delegate work: their exited owner can be recovered separately.
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw fault('BUILD_WORKSPACE_INVALID', 'Unsafe build owner record.');
    const bytes = fs.readFileSync(filename, 'utf8');
    let record;
    try { record = JSON.parse(bytes); }
    catch {
        // Host records are compact JSON; only an interrupted recovery has a journal.
        try { record = JSON.parse(bytes.split('\n', 1)[0]); }
        catch { throw fault('BUILD_WORKSPACE_INVALID', 'Incomplete build owner record; no automatic takeover.'); }
    }
    if (record?.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1
        || typeof record.token !== 'string' || !/^[a-f0-9-]{36}$/.test(record.token)
        || !OPERATIONS.has(record.operation)) throw fault('BUILD_WORKSPACE_INVALID', 'Invalid build owner record.');
    return { record, stat, bytes };
}

function processAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

function markerExists(workspace, filename) {
    workspace.check();
    try { fs.lstatSync(filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Recovery contenders append complete records in ONE O_APPEND write. The first
// child of an election head wins; siblings can never become winners later. A
// dead/relinquished winner can itself have a successor. No second lock file, no
// unlink/create gap, and a delayed reader only ever writes its original inode.
function recoveryHead(bytes, original) {
    let head = { token: original.token, pid: original.pid, available: !processAlive(original.pid) };
    const lines = bytes.split('\n');
    for (const line of lines.slice(1, -1)) {
        let item;
        try { item = JSON.parse(line); } catch { continue; } // Interrupted short append.
        if (!item || !UUID.test(item.token) || !Number.isSafeInteger(item.pid) || item.pid < 1) continue;
        if (item.kind === 'claim' && item.parent === head.token && head.available) {
            head = { token: item.token, pid: item.pid,
                available: !processAlive(item.pid) || abandonedClaims.has(item.token) };
        } else if (item.kind === 'retire' && item.token === head.token && item.pid === head.pid) {
            head.available = true;
        }
    }
    return head;
}

function readDescriptor(descriptor) {
    const size = fs.fstatSync(descriptor).size;
    if (size > 256 * 1024) throw fault('BUILD_WORKSPACE_INVALID', 'Build recovery journal exceeds its limit.');
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const count = fs.readSync(descriptor, buffer, offset, size - offset, offset);
        if (!count) throw fault('BUILD_WORKSPACE_CHANGED', 'Build recovery journal changed.');
        offset += count;
    }
    return buffer.toString('utf8');
}

function appendRecovery(descriptor, record) {
    const buffer = Buffer.from(`\n${JSON.stringify(record)}\n`);
    // Never finish a short write with a second append: another contender's record
    // may already follow ours. An incomplete record grants no ownership.
    if (fs.writeSync(descriptor, buffer) !== buffer.length) throw fault('BUILD_WORKSPACE_INVALID', 'Incomplete recovery journal write.');
}

function recoverPublication(workspace, previous, record) {
    if (!NON_DELEGATING_OPERATIONS.has(previous.record.operation)
        || markerExists(workspace, path.join(workspace.directory, BUILDER_MARKER))) return undefined;
    // Do not reinterpret an externally reformatted/multiline owner as a journal.
    try { JSON.parse(previous.bytes.split('\n', 1)[0]); } catch { return undefined; }
    const temporary = path.join(workspace.directory, `.aily-workspace-${record.token}.tmp`);
    let descriptor, installed = false, claimed = false;
    try {
        // Prepare the complete replacement BEFORE competing. Failed preparation
        // does not reserve ownership, and rename never exposes an empty marker.
        fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        descriptor = fs.openSync(workspace.filename, fs.constants.O_RDWR | fs.constants.O_APPEND);
        const bytes = readDescriptor(descriptor);
        if (bytes.split('\n', 1)[0] !== previous.bytes.split('\n', 1)[0]
            || fs.fstatSync(descriptor).ino !== previous.stat.ino) {
            throw fault('BUILD_WORKSPACE_BUSY', 'Build ownership changed before recovery.');
        }
        const head = recoveryHead(bytes, previous.record);
        if (!head.available) throw fault('BUILD_WORKSPACE_BUSY', 'Build workspace recovery is already in progress.');
        claimed = true;
        appendRecovery(descriptor, { kind: 'claim', pid: process.pid, token: record.token, parent: head.token });
        if (recoveryHead(readDescriptor(descriptor), previous.record).token !== record.token) {
            throw fault('BUILD_WORKSPACE_BUSY', 'Another recovery contender owns this workspace.');
        }
        // An older loaded host may still use the standalone recovery guard.
        // After our append it cannot parse this marker for a new takeover; if
        // it already passed that read, its guard must still be honored here.
        checkLegacyRecovery(workspace);
        const current = readOwner(workspace);
        if (!sameFile(previous.stat, current.stat) || current.bytes.split('\n', 1)[0] !== previous.bytes.split('\n', 1)[0]
            || processAlive(current.record.pid)) throw fault('BUILD_WORKSPACE_BUSY', 'Build ownership changed during recovery.');
        if (markerExists(workspace, path.join(workspace.directory, BUILDER_MARKER))) return undefined;
        fs.renameSync(temporary, workspace.filename);
        installed = true;
        return lease(workspace, readOwner(workspace), true);
    } finally {
        if (descriptor !== undefined) {
            try {
                if (claimed && !installed) {
                    abandonedClaims.add(record.token);
                    try {
                        appendRecovery(descriptor, { kind: 'retire', pid: process.pid, token: record.token });
                        abandonedClaims.delete(record.token);
                    } catch { /* Preserve the original error; a retry here or process exit releases the claim. */ }
                }
            } finally { fs.closeSync(descriptor); }
        }
        // A leftover unique staging file is inert. Cleanup must never turn a
        // successful takeover into an exception or hide its initialized lease.
        try { fs.unlinkSync(temporary); } catch { /* No shared ownership lives here. */ }
    }
}

function checkLegacyRecovery(workspace) {
    const filename = path.join(workspace.directory, LEGACY_RECOVERY_MARKER);
    if (!markerExists(workspace, filename)) return;
    let record;
    try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error('unsafe');
        record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch { throw fault('BUILD_WORKSPACE_BUSY', 'An unreadable legacy recovery marker requires verified cleanup.'); }
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !UUID.test(record.ownerToken) || processAlive(record.pid)) {
        throw fault('BUILD_WORKSPACE_BUSY', 'Legacy workspace recovery may still be running.');
    }
    // This old implementation cannot run after its process exits. Leave its
    // evidence intact; it is no longer an acquisition gate in the new protocol.
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
    checkLegacyRecovery(workspace);
    const supervisor = process.env[SUPERVISOR_ENV];
    const record = { schemaVersion: 1, pid: process.pid, token: randomUUID(), operation, startedAt: new Date().toISOString(),
        ...(typeof supervisor === 'string' && UUID.test(supervisor) ? { supervisor } : {}) };
    let descriptor;
    try { descriptor = fs.openSync(workspace.filename, 'wx', 0o600); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = readOwner(workspace); } catch { /* A partial/unsafe marker is still exclusive. */ }
        if (previous && !processAlive(previous.record.pid)) {
            const recovered = recoverPublication(workspace, previous, record);
            if (recovered === undefined) {
                throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', `Host owner PID ${previous.record.pid} exited. Do not retry or remove its marker until all compiler descendants are confirmed stopped; then explicitly clean only .build/aily-workspace.lock.`);
            }
            return recovered;
        } else {
            throw fault('BUILD_WORKSPACE_BUSY', 'Another host build/preprocess owns this project. Retry after it finishes. An interrupted owner requires verified cleanup; do not delete its marker while compiler descendants may be running.');
        }
    }
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
        childEnvironment: () => {
            assertOwned();
            if (owner.record.operation !== 'compile') throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Only compile may delegate a preprocess child.');
            return { ...process.env, [OWNER_ENV]: owner.record.token };
        },
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
