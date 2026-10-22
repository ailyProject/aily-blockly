'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tryAcquireFileLock } = require('./native-file-lock');

const OWNER_ENV = 'AILY_BUILD_WORKSPACE_OWNER';
const SUPERVISOR_ENV = 'AILY_BUILD_WORKSPACE_SUPERVISOR';
const BUILDER_ENV = 'AILY_BUILDER_WORKSPACE';
const BUILDER_MARKER = 'aily-builder.lock';
const LEGACY_RECOVERY_MARKER = 'aily-workspace-recovery.lock';
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
    const coordination = path.join(root, '.aily');
    try { fs.mkdirSync(coordination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const checkCoordination = () => {
        check();
        const stat = fs.lstatSync(coordination);
        if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(fs.realpathSync(coordination)) !== canonical(coordination)) {
            throw fault('BUILD_WORKSPACE_INVALID', 'Coordination directory must not be a symlink/junction.');
        }
    };
    checkCoordination();
    return { root, directory, filename: path.join(directory, 'aily-workspace.lock'),
        anchor: path.join(coordination, 'build-workspace.guard'), check: checkCoordination };
}

function readOwner(workspace, filename = workspace.filename) {
    workspace.check();
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw fault('BUILD_WORKSPACE_INVALID', 'Unsafe build owner record.');
    const bytes = fs.readFileSync(filename, 'utf8');
    let record;
    try { record = JSON.parse(bytes); }
    catch {
        // New host records are compact JSON; old interrupted recoveries had journals.
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

function acquireNative(workspace) {
    workspace.check();
    const guard = tryAcquireFileLock(workspace.anchor);
    if (!guard) throw fault('BUILD_WORKSPACE_BUSY', 'Another build operation owns this project. Retry after it finishes.');
    return guard;
}

function writeOwner(workspace, record) {
    const bytes = JSON.stringify(record);
    const temporary = path.join(workspace.directory, `.aily-workspace-${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
        const stat = fs.lstatSync(temporary);
        workspace.check();
        fs.renameSync(temporary, workspace.filename);
        // No fallible read after installation: ownership uses the prepared bytes
        // and identity. The caller can now always receive/release the lease.
        return { record, bytes, stat };
    } finally {
        try { fs.unlinkSync(temporary); } catch { /* An unused unique staging file is not an ownership gate. */ }
    }
}

function assertBuilderAbsent(workspace) {
    if (markerExists(workspace, path.join(workspace.directory, BUILDER_MARKER))) {
        throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', 'Builder has not released its delegated phase. Confirm the complete process tree stopped before cleanup.');
    }
}

function assertPreviousRecoverable(workspace) {
    let previous;
    try { previous = readOwner(workspace); }
    catch (error) {
        if (error.code === 'ENOENT') return;
        throw fault('BUILD_WORKSPACE_BUSY', 'Unreadable legacy build record requires verified cleanup.');
    }
    const record = previous.record;
    // The kernel proves that no native host lease remains. Only operations that
    // never spawn descendants can be recovered without a completed receipt.
    // In particular, cloud verify leases also cover native uploader processes.
    if (record.nativeLeaseVersion === 1 && (record.released === true || NON_DELEGATING_OPERATIONS.has(record.operation))) return;
    if (processAlive(record.pid)) throw fault('BUILD_WORKSPACE_BUSY', 'Another host build/preprocess owns this project.');
    if (!NON_DELEGATING_OPERATIONS.has(record.operation)) {
        throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', `Host owner PID ${record.pid} exited. Confirm all compiler descendants stopped before cleanup.`);
    }
    // Read-only migration of the old journal, including records above its former
    // 256 KiB cap. Never append another election or grow the legacy file.
    const claims = new Map();
    for (const line of previous.bytes.split('\n').slice(1)) {
        let item; try { item = JSON.parse(line); } catch { continue; }
        if (!item || !UUID.test(item.token) || !Number.isSafeInteger(item.pid) || item.pid < 1) continue;
        if (item.kind === 'claim') claims.set(item.token, item.pid);
        if (item.kind === 'retire') claims.delete(item.token);
    }
    if ([...claims.values()].some(processAlive)) throw fault('BUILD_WORKSPACE_BUSY', 'An older host is still recovering this project. Restart that host before retrying.');
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
        assertBuilderAbsent(workspace);
        return lease(workspace, owner, false);
    }
    const guard = acquireNative(workspace);
    try {
        checkLegacyRecovery(workspace);
        assertBuilderAbsent(workspace);
        assertPreviousRecoverable(workspace);
        const supervisor = process.env[SUPERVISOR_ENV];
        const record = { schemaVersion: 1, nativeLeaseVersion: 1,
            pid: process.pid, token: randomUUID(), operation, startedAt: new Date().toISOString(),
            ...(typeof supervisor === 'string' && UUID.test(supervisor) ? { supervisor } : {}) };
        return lease(workspace, writeOwner(workspace, record), true, guard);
    } catch (error) { guard.close(); throw error; }
}

function lease(workspace, owner, owns, guard) {
    let released = false;
    const assertOwned = () => {
        if (released) throw fault('BUILD_WORKSPACE_CHANGED', 'Build lease was already released.');
        if (owns) guard.assertHeld();
        const current = readOwner(workspace);
        if (!sameFile(owner.stat, current.stat) || current.bytes !== owner.bytes || !processAlive(owner.record.pid)) {
            throw fault('BUILD_WORKSPACE_CHANGED', 'Build ownership changed; do not publish or remove another build\'s files.');
        }
    };
    const assertBuilderIdle = () => {
        assertOwned();
        assertBuilderAbsent(workspace);
    };
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
            // A failed release still closes the kernel handle. A caller retaining
            // this lease can retry cleanup, but must acquire exclusion again first.
            if (owns && guard.closed) guard = acquireNative(workspace);
            try {
                assertBuilderIdle();
                if (owns) {
                    try { fs.unlinkSync(workspace.filename); }
                    catch (error) {
                        // Successful completion must not depend on deleting a file.
                        // Retain a complete, explicitly released receipt if deletion
                        // is denied; the next native owner can replace it safely.
                        owner = writeOwner(workspace, { ...owner.record, released: true });
                    }
                }
                released = true;
            } finally { if (owns) guard.close(); }
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
                try {
                    const record = readOwner(workspace, filename).record;
                    const completed = filename === workspace.filename && record.nativeLeaseVersion === 1 && record.released === true;
                    if (record.supervisor === token && !completed) return false;
                }
                catch (error) { if (error.code !== 'ENOENT') return false; }
            }
            return true;
        },
        releaseAfterTermination: stopped => {
            if (stopped !== true) return false;
            let guard;
            try { guard = acquireNative(workspace); }
            catch (error) { if (error.code === 'BUILD_WORKSPACE_BUSY') return false; throw error; }
            try {
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
            } finally { guard.close(); }
        },
    };
}

module.exports = { acquireBuildWorkspace, createBuildWorkspaceSupervisor, OWNER_ENV, BUILDER_ENV };
