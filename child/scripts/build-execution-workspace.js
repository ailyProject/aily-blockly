'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { tryAcquireFileLock } = require('./native-file-lock');
const { collectLibraryPackages } = require('./library-packages');
const { captureBuildSource } = require('./build-source-capture');
const { getSystemBootId } = require('./system-boot-id');
const { processIdentity } = require('./build-process-identity');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const UUID = /^[a-f0-9-]{36}$/;
const HEADER = /^(?:variables|objects)_[a-zA-Z0-9_-]+-[a-f0-9]{8}\.h$/;
const fail = message => { throw Object.assign(new Error(`BUILD_EXECUTION_INVALID: ${message}`), { code: 'BUILD_EXECUTION_INVALID' }); };
const state = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const activeOwners = new Map();

function directory(parent, name, create = true) {
    const filename = path.join(parent, name);
    if (create) try { fs.mkdirSync(filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(filename).isDirectory() || fs.lstatSync(filename).isSymbolicLink()
        || !samePath(fs.realpathSync(filename), filename)) fail('Execution directory is linked or replaced.');
    return filename;
}
function storage(projectPath, create = false) {
    const root = fs.realpathSync(projectPath);
    const parent = directory(directory(root, '.aily', create), 'build-executions', create);
    return { root, parent, pointer: path.join(parent, 'current.json'), anchor: path.join(parent, 'execution.guard') };
}
function json(filename, limit = 1024 * 1024) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail('Invalid execution record.');
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function write(filename, value) {
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temp, filename);
    } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function locked(store, action) {
    const guard = tryAcquireFileLock(store.anchor);
    if (!guard) throw Object.assign(new Error('BUILD_WORKSPACE_BUSY: Another execution transition is running.'), { code: 'BUILD_WORKSPACE_BUSY' });
    try { return action(); } finally { guard.close(); }
}

/** These are detached byte copies, including npm junctions. No hardlinks or live
 * library links may give an old compiler a path into the new execution. */
function snapshot(config, target, copy) {
    const root = fs.realpathSync(config.currentProjectPath), manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    delete manifest.codeHash; delete manifest.buildInfo;
    const inputs = [], active = new Set();
    let bytes = 0, count = 0;
    const visit = (source, relative, depth = 0) => {
        if (depth > 64) fail('Execution source depth exceeds budget.');
        const real = fs.realpathSync(source), before = fs.statSync(source);
        if (before.isDirectory()) {
            if (active.has(real)) fail('Execution source contains a link cycle.');
            active.add(real);
            if (copy) fs.mkdirSync(path.join(target, relative), { recursive: true });
            inputs.push([relative, 'directory']);
            for (const name of fs.readdirSync(source).sort()) {
                // Generated declarations come from the exact generator capture,
                // never an interrupted older publisher's shared src directory.
                if (relative === 'src' && HEADER.test(name) && config.generatedArtifacts !== undefined) continue;
                visit(path.join(source, name), path.join(relative, name), depth + 1);
            }
            active.delete(real);
        } else if (before.isFile()) {
            if (++count > 100000 || (bytes += before.size) > 2 * 1024 * 1024 * 1024) fail('Execution source exceeds capture budget.');
            const content = fs.readFileSync(source);
            if (state(before) !== state(fs.statSync(source))) fail('Execution source changed while copying.');
            inputs.push([relative, hash(content)]);
            if (copy) { fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true }); fs.writeFileSync(path.join(target, relative), content, { flag: 'wx', mode: before.mode & 0o777 }); }
        } else fail('Unsupported execution source entry.');
    };
    inputs.push(['package.json', hash(JSON.stringify(manifest))]);
    if (copy) fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    for (const name of ['project.abi', 'src', 'components', 'partitions.csv']) if (fs.existsSync(path.join(root, name))) visit(path.join(root, name), name);
    const packages = new Map([[path.join('node_modules', config.boardModule), path.join(root, 'node_modules', config.boardModule)]]);
    for (const pkg of collectLibraryPackages(manifest.dependencies, root)) packages.set(path.relative(root, pkg.packagePath), pkg.packagePath);
    for (const [relative, source] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        // A parent package copy already includes its nested dependencies.
        if ([...packages.keys()].some(parent => parent !== relative && relative.startsWith(parent + path.sep))) continue;
        visit(source, relative);
    }
    return hash(JSON.stringify({ inputs, boardModule: config.boardModule, code: config.code,
        generatedArtifacts: config.generatedArtifacts ?? null, projectMacros: config.projectMacros ?? [] }));
}

function applyGeneratorInputs(root, config) {
    const pkgPath = path.join(root, 'package.json'), pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (config.projectMacros !== undefined) {
        const macros = new Map();
        for (const item of pkg.MACROS || []) { const value = String(Array.isArray(item) ? item[0] : item).trim(); if (value) macros.set(value.split('=')[0], value); }
        for (const [name, value] of Object.entries(pkg.ailyGeneratorMacros || {})) if (macros.get(name) === value) macros.delete(name);
        const owned = {};
        for (const { name, value } of [...config.projectMacros].sort((a, b) => a.name.localeCompare(b.name))) {
            macros.delete(name); if (value !== null) { macros.set(name, value); owned[name] = value; }
        }
        pkg.MACROS = [...macros.values()].map(value => [value]); pkg.ailyGeneratorMacros = owned;
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }
    if (config.generatedArtifacts !== undefined && config.generatedArtifacts !== null) {
        directory(root, 'src');
        for (const artifact of config.generatedArtifacts) {
            if (!HEADER.test(artifact.fileName) || typeof artifact.content !== 'string') fail('Invalid captured generated artifact.');
            fs.writeFileSync(path.join(root, 'src', artifact.fileName), artifact.content, { flag: 'wx' });
        }
    }
}

/** Every new Blockly build is private, including the healthy case. Therefore a
 * crashed legacy writer can keep its old paths without gating document saves. */
function prepareBuildExecution(config, workspace, operation = 'compile') {
    if (!config || typeof config.code !== 'string' || typeof config.boardModule !== 'string'
        || !/^@[^/\\]+\/[^/\\]+$/.test(config.boardModule) || config.boardModule.includes('..')
        || !['compile', 'preprocess'].includes(operation)) fail('Invalid execution request.');
    const store = storage(config.currentProjectPath, true);
    if (JSON.parse(fs.readFileSync(path.join(store.root, 'package.json'), 'utf8')).type === 'coder') fail('Coder execution uses its own build contract.');
    const id = randomUUID(), folder = directory(store.parent, id), root = directory(folder, 'project');
    const inputDigest = snapshot(config, root, true);
    if (snapshot(config, root, false) !== inputDigest) fail('Project inputs changed during execution capture.');
    applyGeneratorInputs(root, config);
    const execution = { version: 1, id, logicalProjectPath: store.root, inputDigest,
        buildRequestId: config.buildRequestId || id, operation,
        ...(config.executionRetryOf ? { retryOf: config.executionRetryOf } : {}) };
    if (typeof execution.buildRequestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(execution.buildRequestId)) fail('Invalid build request identity.');
    const prepared = { ...config, currentProjectPath: root, partitionFilePath: path.join(root, 'partitions.csv'), execution };
    delete prepared.sourceCapture;
    prepared.sourceCapture = captureBuildSource(prepared, workspace);
    write(path.join(folder, 'execution.json'), { ...execution, status: 'prepared', sourceCapture: prepared.sourceCapture });
    write(path.join(folder, 'config.json'), prepared);
    if (operation === 'compile') locked(store, () => {
        const index = path.join(directory(store.parent, 'requests'), `${hash(execution.buildRequestId)}.json`);
        if (fs.existsSync(index) && (!UUID.test(execution.retryOf) || json(index).id !== execution.retryOf)) {
            throw Object.assign(new Error('BUILD_EXECUTION_EXISTS: Inspect the existing request instead of starting it twice.'),
                { code: 'BUILD_EXECUTION_EXISTS', buildRequestId: execution.buildRequestId });
        }
        write(index, { version: 1, id, buildRequestId: execution.buildRequestId });
        write(store.pointer, { version: 1, id, buildRequestId: execution.buildRequestId });
    });
    return prepared;
}

function recordFor(config) {
    const execution = config.execution;
    if (execution?.version !== 1 || !UUID.test(execution.id)) fail('Missing execution identity.');
    const store = storage(execution.logicalProjectPath), folder = path.join(store.parent, execution.id), root = path.join(folder, 'project');
    if (!samePath(fs.realpathSync(config.currentProjectPath), root)) fail('Execution path does not belong to its request.');
    const record = json(path.join(folder, 'execution.json'));
    if (record.id !== execution.id || record.inputDigest !== execution.inputDigest || record.buildRequestId !== execution.buildRequestId
        || !samePath(record.logicalProjectPath, store.root) || JSON.stringify(record.sourceCapture) !== JSON.stringify(config.sourceCapture)) fail('Execution binding changed.');
    return { store, folder, root, record };
}
function claimOutcome(value, status) {
    // Cancellation and completion use one immutable first-writer receipt. A
    // late Stop cannot rewrite a completed build, and a late compiler cannot
    // undo cancellation. Neither contender waits on the mutable status guard.
    const filename = path.join(value.folder, 'outcome.json');
    const receipt = { version: 1, id: value.record.id, buildRequestId: value.record.buildRequestId,
        inputDigest: value.record.inputDigest, status };
    try {
        const fd = fs.openSync(filename, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        return receipt;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = json(filename);
        if (existing.version !== 1 || existing.id !== receipt.id || existing.buildRequestId !== receipt.buildRequestId
            || existing.inputDigest !== receipt.inputDigest || !['completed', 'failed', 'cancelled'].includes(existing.status)) fail('Terminal execution receipt changed.');
        return existing;
    }
}
function startBuildExecution(config, lease) {
    if (!config.execution) return;
    const value = recordFor(config);
    if (!samePath(lease.projectRoot, value.root) || !UUID.test(lease.buildId)) fail('Execution lease belongs to another workspace.');
    lease.assertOwned();
    const owner = { pid: process.pid, creation: processIdentity(process.pid), bootId: getSystemBootId(), token: lease.buildId };
    locked(value.store, () => {
        lease.assertOwned();
        const current = json(path.join(value.folder, 'execution.json'));
        if (current.status !== 'prepared' || fs.existsSync(path.join(value.folder, 'outcome.json'))) fail('Execution was already started or cancelled. Inspect its original request.');
        write(path.join(value.folder, 'execution.json'), { ...current, status: 'running', owner });
        activeOwners.set(value.record.id, owner.token);
    });
}
function finishBuildExecution(config, success) {
    if (!config.execution) return;
    const value = recordFor(config);
    locked(value.store, () => {
        const current = json(path.join(value.folder, 'execution.json'));
        if (!['prepared', 'running'].includes(current.status)) return;
        if (success && !fs.existsSync(path.join(value.folder, 'outcome.json'))
            && (current.status !== 'running' || current.owner?.pid !== process.pid
                || activeOwners.get(current.id) !== current.owner?.token)) fail('Completion does not belong to the observed execution owner.');
        const outcome = claimOutcome(value, success ? 'completed' : 'failed');
        write(path.join(value.folder, 'execution.json'), { ...current, status: outcome.status });
        activeOwners.delete(current.id);
    });
}
function cancelBuildExecution(config) {
    if (!config?.execution) return;
    const value = recordFor(config);
    if (!['prepared', 'running'].includes(value.record.status)) return { status: value.record.status };
    return claimOutcome(value, 'cancelled');
}
function resolveBuildExecution(projectPath) {
    try {
        const store = storage(projectPath), pointer = json(store.pointer);
        if (!UUID.test(pointer.id)) return null;
        const folder = path.join(store.parent, pointer.id), record = json(path.join(folder, 'execution.json')), root = path.join(folder, 'project');
        const outcome = json(path.join(folder, 'outcome.json'));
        if (outcome.status !== 'completed' || outcome.id !== record.id || outcome.buildRequestId !== record.buildRequestId
            || outcome.inputDigest !== record.inputDigest) return null;
        if (record.status !== 'completed' || record.operation !== 'compile' || record.id !== pointer.id
            || record.buildRequestId !== pointer.buildRequestId || !samePath(record.logicalProjectPath, store.root)
            || !samePath(fs.realpathSync(root), root)) return null;
        // A directory or exit code alone is never a firmware receipt.
        const upload = require('./blockly-upload-state'), config = json(path.join(folder, 'config.json'), 160 * 1024 * 1024);
        if (!upload.canReuseBlocklyUpload({ ...config, currentProjectPath: root })
            || snapshot({ ...config, currentProjectPath: store.root }, '', false) !== record.inputDigest) return null;
        return { currentProjectPath: root, logicalProjectPath: store.root, buildPath: path.join(root, '.build'),
            preprocessPath: path.join(root, '.temp', 'preprocess.json'), buildRequestId: record.buildRequestId, inputDigest: record.inputDigest };
    } catch { return null; }
}
function canReuseBuildExecution(config) {
    try {
        const current = resolveBuildExecution(config.currentProjectPath);
        if (!current) return false;
        return snapshot(config, '', false) === current.inputDigest;
    } catch { return false; }
}
function resolveBuildProjectPath(projectPath) {
    try {
        const root = fs.realpathSync(projectPath);
        if (json(path.join(root, 'package.json'), 2 * 1024 * 1024).type === 'coder') return root;
        return resolveBuildExecution(root)?.currentProjectPath ?? null;
    } catch { return null; }
}
function inspectBuildExecution(projectPath, buildRequestId) {
    try {
        const store = storage(projectPath), index = json(path.join(store.parent, 'requests', `${hash(buildRequestId)}.json`));
        if (index.buildRequestId !== buildRequestId || !UUID.test(index.id)) return null;
        const record = json(path.join(store.parent, index.id, 'execution.json'));
        if (record.id !== index.id || record.buildRequestId !== buildRequestId || !samePath(record.logicalProjectPath, store.root)) return null;
        let current;
        try { current = json(store.pointer); } catch { /* The exact request remains observable if pointer publication was interrupted. */ }
        const selected = record.status === 'completed' ? resolveBuildExecution(projectPath) : null;
        let status = record.status, ownerState;
        try { if (json(path.join(store.parent, index.id, 'outcome.json')).status === 'cancelled') status = 'cancelled'; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (status === 'prepared') ownerState = 'start-unobserved';
        if (status === 'running') {
            const owner = record.owner, boot = getSystemBootId();
            let alive = false;
            try { process.kill(owner?.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
            if (!owner || !alive || (boot && owner.bootId && boot !== owner.bootId)) { status = 'interrupted'; ownerState = 'owner-exited'; }
            else {
                const actual = owner.creation ? processIdentity(owner.pid) : null;
                let lease;
                try { lease = json(path.join(store.parent, index.id, 'project/.build/aily-workspace.lock')); } catch { /* Unknown lease cannot certify an active execution. */ }
                if (actual && actual === owner.creation && boot && owner.bootId === boot
                    && lease?.token === owner.token && lease.pid === owner.pid) ownerState = 'live';
                else if (actual && owner.creation && actual !== owner.creation) { status = 'interrupted'; ownerState = 'identity-changed'; }
                else { status = 'unconfirmed'; ownerState = 'identity-unavailable'; }
            }
        }
        return { version: 1, executionId: record.id, buildRequestId, status, inputDigest: record.inputDigest,
            ...(ownerState ? { ownerState } : {}),
            nextAction: status === 'running' && ownerState === 'live' ? 'observe-original'
                : ['prepared', 'interrupted', 'unconfirmed'].includes(status) ? 'new-execution-required'
                : status === 'completed' && !selected ? 'rebuild-current-inputs' : 'terminal',
            current: current?.id === record.id, ...(selected?.buildRequestId === buildRequestId ? { result: selected } : {}) };
    } catch { return null; }
}

module.exports = { prepareBuildExecution, startBuildExecution, finishBuildExecution, cancelBuildExecution, resolveBuildExecution,
    resolveBuildProjectPath, canReuseBuildExecution, inspectBuildExecution, recordFor };
