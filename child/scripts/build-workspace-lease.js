'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { tryAcquireFileLock } = require('./native-file-lock');
const { getSystemBootId, isSystemBootId } = require('./system-boot-id');

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
const ISOLATED_RECOVERY_GUIDANCE = "Original build outputs remain protected. Use project_recover(action='fork') to save an independent recovery project; continue validation and compilation only after that copy is activated. The original workspace has not been unlocked.";

/** Cooperative host build lease, not a file-editor lock or a security boundary.
 * A dead parent does NOT prove that its compiler descendants stopped.
 * A persisted grant is written BEFORE any subprocess can start. An interrupted
 * owner with no grant is recoverable; granted/legacy owners need a confirmed
 * process-tree stop or a different kernel boot identity, never a PID timeout.
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

function assertBuilderAbsent(workspace, recovery = ISOLATED_RECOVERY_GUIDANCE) {
    if (markerExists(workspace, path.join(workspace.directory, BUILDER_MARKER))) {
        throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', `Builder has not released its delegated phase. ${recovery}`);
    }
}

function assertLegacyClaimsStopped(previous) {
    const claims = new Map();
    for (const line of previous.bytes.split('\n').slice(1)) {
        let item; try { item = JSON.parse(line); } catch { continue; }
        if (!item || !UUID.test(item.token) || !Number.isSafeInteger(item.pid) || item.pid < 1) continue;
        if (item.kind === 'claim') claims.set(item.token, item.pid);
        if (item.kind === 'retire') claims.delete(item.token);
    }
    if ([...claims.values()].some(processAlive)) throw fault('BUILD_WORKSPACE_BUSY', 'An older host is still recovering this project. Restart that host before retrying.');
}

function assertPreviousRecoverable(workspace) {
    let previous;
    try { previous = readOwner(workspace); }
    catch (error) {
        if (error.code === 'ENOENT') { assertBuilderAbsent(workspace); checkLegacyRecovery(workspace); return; }
        throw fault('BUILD_WORKSPACE_BUSY', 'Unreadable legacy build record requires verified cleanup.');
    }
    const record = previous.record;
    const bootId = getSystemBootId();
    const storedBoot = record.bootId || record.recoveryObservedBootId;
    const previousBoot = isSystemBootId(storedBoot) ? storedBoot.toLowerCase() : storedBoot;
    // An OS restart ends the entire old tree, even when its PID has been reused.
    // Keep unknown/foreign Builder records; only this owner's phase may be removed.
    if (bootId && isSystemBootId(previousBoot) && previousBoot !== bootId
        && previousBoot.split(':')[0] === bootId.split(':')[0]) {
        const builderPath = path.join(workspace.directory, BUILDER_MARKER);
        if (markerExists(workspace, builderPath)) {
            const builder = readOwner(workspace, builderPath);
            if (builder.record.ownerToken !== record.token || builder.record.supervisor !== record.supervisor) {
                throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', `Build phase ownership is inconsistent. ${ISOLATED_RECOVERY_GUIDANCE}`);
            }
            fs.unlinkSync(builderPath);
        }
        return;
    }
    checkLegacyRecovery(workspace);
    const alive = processAlive(record.pid);
    // Remember observing a legacy record in THIS boot. Its startedAt/mtime cannot
    // prove a reboot (wall clocks can change). Retire journals only after checking claims.
    if (!alive && bootId && !previousBoot) {
        assertLegacyClaimsStopped(previous);
        writeOwner(workspace, { ...record, recoveryObservedBootId: bootId });
    }
    const recovery = `${bootId ? '' : 'Cannot verify the system boot identity. '}${ISOLATED_RECOVERY_GUIDANCE}`;
    assertBuilderAbsent(workspace, alive ? undefined : recovery);
    if (record.nativeLeaseVersion === 1 && (record.released === true || NON_DELEGATING_OPERATIONS.has(record.operation))) return;
    if (alive) throw fault('BUILD_WORKSPACE_BUSY', 'Another host build/preprocess owns this project.');
    if (record.nativeLeaseVersion === 1 && record.delegationVersion === 1 && record.delegated === false) return;
    if (!NON_DELEGATING_OPERATIONS.has(record.operation)) {
        throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', `Host owner PID ${record.pid} exited. ${recovery}`);
    }
    // Old publication journals may be replaced only after their claims stop.
    // Never append another election or grow the legacy file.
    assertLegacyClaimsStopped(previous);
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
            || owner.record.delegationVersion !== 1 || owner.record.delegated !== true
            || owner.record.pid !== process.ppid || !processAlive(owner.record.pid)) {
            throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Preprocess does not belong to this live compile owner.');
        }
        assertBuilderAbsent(workspace);
        return lease(workspace, owner, false);
    }
    const guard = acquireNative(workspace);
    try {
        assertPreviousRecoverable(workspace);
        const supervisor = process.env[SUPERVISOR_ENV];
        const record = { schemaVersion: 1, nativeLeaseVersion: 1, delegationVersion: 1, delegated: false,
            pid: process.pid, token: randomUUID(), operation, startedAt: new Date().toISOString(),
            ...(getSystemBootId() ? { bootId: getSystemBootId() } : {}),
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
    const markDelegated = () => {
        assertBuilderIdle();
        if (NON_DELEGATING_OPERATIONS.has(owner.record.operation)) {
            throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Publication and cleanup cannot delegate work.');
        }
        if (owner.record.delegated === true) return;
        // A borrowed preprocess lease must already have a persisted parent grant.
        if (!owns) throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Parent did not record its subprocess grant.');
        owner = writeOwner(workspace, { ...owner.record, delegated: true });
    };
    return {
        projectRoot: workspace.root,
        buildId: owner.record.token,
        assertOwned,
        assertBuilderIdle,
        markDelegated,
        childEnvironment: () => {
            assertOwned();
            if (owner.record.operation !== 'compile') throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Only compile may delegate a preprocess child.');
            markDelegated();
            return { ...process.env, [OWNER_ENV]: owner.record.token };
        },
        builderEnvironment: operation => {
            assertBuilderIdle();
            if (!['compile', 'preprocess', 'verify'].includes(operation)
                || !(owner.record.operation === operation || (owner.record.operation === 'compile' && operation === 'preprocess'))) {
                throw fault('BUILD_WORKSPACE_OWNER_MISMATCH', 'Invalid Builder delegation operation.');
            }
            markDelegated();
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
        releaseAfterOwnerExit: () => {
            // No process-tree kill is needed when this supervisor's owner never
            // granted a child. Never signal a PID after its close event.
            let guard;
            try {
                guard = acquireNative(workspace);
                const owner = readOwner(workspace);
                if (owner.record.supervisor !== token || processAlive(owner.record.pid)
                    || owner.record.nativeLeaseVersion !== 1 || owner.record.delegationVersion !== 1
                    || owner.record.delegated !== false) return false;
                assertBuilderAbsent(workspace);
                fs.unlinkSync(workspace.filename);
                return true;
            } catch { return false; }
            finally { guard?.close(); }
        },
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

/** Hold the existing cooperative build exclusion while observing idleness.
 * Unlike acquisition/recovery this never rewrites owner journals, retires old
 * claims or removes Builder evidence. A dead delegated parent is not idle. */
function inspectBuildWorkspaceIdle(projectPath) {
    const workspace = openWorkspace(projectPath);
    const ownerFacts = record => record ? { pid: record.pid, operation: record.operation,
        delegated: record.delegated === true, released: record.released === true } : null;
    const deny = (reason, owner, recordPath, code = 'BUILD_WORKSPACE_RECOVERY_REQUIRED') => {
        const details = { resource: 'build-workspace', reason, owner: ownerFacts(owner), recordPath };
        return Object.assign(fault(code, 'Build idleness is not established; existing ownership evidence remains unchanged.'),
            { resource: details.resource, owner: details.owner, details });
    };
    let guard;
    try { guard = acquireNative(workspace); }
    catch (error) {
        let owner; try { owner = readOwner(workspace).record; } catch { /* Unknown owner remains unknown. */ }
        throw deny('native-guard-unavailable', owner, workspace.anchor, error.code || 'BUILD_WORKSPACE_BUSY');
    }
    const assertMarkersAbsent = () => {
        for (const [name, reason] of [[BUILDER_MARKER, 'builder-phase-unconfirmed'], [LEGACY_RECOVERY_MARKER, 'legacy-recovery-unconfirmed']]) {
            const filename = path.join(workspace.directory, name);
            if (!markerExists(workspace, filename)) continue;
            let owner; try { owner = readOwner(workspace, filename).record; } catch { /* Preserve malformed/foreign markers too. */ }
            throw deny(reason, owner, filename);
        }
    };
    const assertIdle = () => {
        try {
            guard.assertHeld(); workspace.check(); assertMarkersAbsent();
            let owner;
            try { owner = readOwner(workspace); }
            catch (error) { if (error.code !== 'ENOENT') throw deny('owner-unreadable', null, workspace.filename); }
            if (owner) {
                const record = owner.record;
                const alive = processAlive(record.pid);
                const released = record.nativeLeaseVersion === 1 && record.released === true;
                const stoppedBeforeDelegation = record.nativeLeaseVersion === 1 && record.delegationVersion === 1
                    && record.delegated === false && !alive;
                if (!released && !stoppedBeforeDelegation) throw deny(
                    alive ? 'owner-alive' : record.nativeLeaseVersion !== 1 || record.delegationVersion !== 1
                        ? 'legacy-owner-unconfirmed' : 'delegation-unconfirmed',
                    record, workspace.filename, alive ? 'BUILD_WORKSPACE_BUSY' : undefined);
                const after = readOwner(workspace);
                if (!sameFile(owner.stat, after.stat) || owner.bytes !== after.bytes) throw deny('owner-changed', after.record, workspace.filename);
            }
            assertMarkersAbsent(); guard.assertHeld();
        } catch (error) {
            guard.close();
            if (error.details?.resource === 'build-workspace') throw error;
            throw deny('inspection-changed', null, workspace.filename, error.code || 'BUILD_WORKSPACE_CHANGED');
        }
    };
    try { assertIdle(); }
    catch (error) { guard.close(); throw error; }
    return { assertIdle, release: () => guard.close() };
}

module.exports = { acquireBuildWorkspace, createBuildWorkspaceSupervisor, inspectBuildWorkspaceIdle, OWNER_ENV, BUILDER_ENV };
