'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { isWindowsSharingError, retryDeferredWindowsFile } = require('./atomic-replace');
const { directory, json, write, locked, readOptional, storage, requestPath, findRequest, updateRequest,
    storeForExecution, retainOutcome } = require('./build-execution-storage');
const { collectLibraryPackages } = require('./library-packages');
const { generatorInputDigest } = require('./blockly-upload-state');
const { captureBuildSource, isGeneratedBuildHeader, mergeGeneratorInputs } = require('./build-source-capture');
const { buildSnapshotReceipt } = require('./build-snapshot-receipt');
const { getSystemBootId } = require('./system-boot-id');
const { observeBuildProcessIdentity } = require('./build-process-identity');
const { acquireBuildWorkspace, inspectBuildWorkspaceIdle, requiresIsolatedBuildRecovery } = require('./build-workspace-lease');
const { blocklyProjectBuildInputs } = require('./blockly-project-build-inputs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const UUID = /^[a-f0-9-]{36}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'not-started'];
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const REFUSAL_MESSAGE_LIMIT = 4096;
const fail = message => { throw Object.assign(new Error(`BUILD_EXECUTION_INVALID: ${message}`), { code: 'BUILD_EXECUTION_INVALID' }); };
const state = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const activeOwners = new Map();
const SHARED = 'shared';
const configurationLimit = 160 * 1024 * 1024;
const supervisorEnvironment = 'AILY_BUILD_WORKSPACE_SUPERVISOR';

function executionTransition(value, action) {
    // Only requests/current publication shares the project admission guard.
    // Background preprocessing owns a different execution.json and must not
    // reject an unrelated foreground request while updating its own status.
    return locked({ anchor: path.join(value.folder, 'transition.guard') }, action);
}

function sharedDispatchPath(store, operation) {
    return path.join(store.parent, operation === 'compile' ? 'pending-compile.json' : 'pending-preprocess.json');
}

// These files only select current work. A malformed selector provides no
// execution identity. Path, file type, and IO failures remain hard errors.
function readSharedSelector(filename) {
    try {
        const value = json(filename);
        const valid = value?.version === 1 && typeof value.id === 'string' && UUID.test(value.id)
            && typeof value.buildRequestId === 'string' && REQUEST_ID.test(value.buildRequestId);
        return { filename, value: valid ? value : null };
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) return { filename, value: null };
        throw error;
    }
}

function isSharedDispatchCurrent({ store, record }) {
    if (!store.cache) {
        const newer = readOptional(storage, store.root, false, true);
        if (newer && readSharedSelector(sharedDispatchPath(newer, record.operation))) return false;
    }
    const pending = readSharedSelector(sharedDispatchPath(store, record.operation))?.value;
    return !!pending && pending.id === record.id && pending.buildRequestId === record.buildRequestId;
}

function ownsStandalonePreprocess(store, record) {
    if (readOptional(fs.lstatSync, store.pointer)) {
        const current = json(store.pointer);
        if (current?.version !== 1 || !UUID.test(current.id) || current.id === record.id) return false;
    }
    const index = findRequest(store.root, record.buildRequestId)?.index;
    return record.explicitPreprocess === true
        ? index?.version === 1 && index.operation === 'preprocess' && index.id === record.id && index.buildRequestId === record.buildRequestId
        : !index;
}

function retirePreprocessInputs(store, id) {
    try {
        if (!UUID.test(id)) return;
        const folder = directory(store.parent, id, false), filename = path.join(folder, 'execution.json');
        const canRetire = record => record?.version === 1 && record.id === id && record.operation === 'preprocess'
            && !record.preprocessInputsRetired && (TERMINAL_STATUSES.includes(record.status) || record.explicitPreprocess === true);
        if (!canRetire(json(filename))) return;
        executionTransition({ folder }, () => {
            const record = json(filename);
            if (!canRetire(record) || !/^[a-f0-9]{64}$/.test(record.inputDigest)
                || typeof record.buildRequestId !== 'string' || !REQUEST_ID.test(record.buildRequestId)) return;
            const outcome = readOutcome({ folder, record });
            if (!outcome || (outcome.status !== record.status && outcome.status !== 'cancelled')) return;

            if (!ownsStandalonePreprocess(store, record)) return;

            // A copied archive may describe a different absolute project location.
            // Use the local physical directory and its actual leases, never that old path.
            const root = directory(folder, 'project', false);
            const idle = inspectBuildWorkspaceIdle(root);
            try {
                const temp = readOptional(directory, root, '.temp', false);
                const inputs = [
                    readOptional(directory, root, 'node_modules', false),
                    temp && readOptional(directory, temp, 'libraries', false),
                ];
                for (const input of inputs) {
                    if (!input) continue;
                    idle.assertIdle();
                    fs.rmSync(input, { recursive: true });
                }
                write(filename, { ...record, status: outcome.status, preprocessInputsRetired: true });
            } finally { idle.release(); }
        });
    } catch { /* Retain ambiguous or busy executions and retry on a future build. */ }
}

const executionFiles = new Set(['config.json', 'execution.json', 'outcome.json', 'transition.guard', 'outcome.guard']);
const uploadRequestFile = /^upload-request-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;

// A request UUID is never reused. Detach the finished directory before
// removing its files so a late reader can never acquire a new guard at that path.
function retireCachedExecution(store, id, clearIdleUpload) {
    if (!store.cache || !UUID.test(id)) return;
    const folder = readOptional(directory, store.parent, id, false);
    if (!folder || readSharedSelector(store.pointer)?.value?.id === id) return;
    const settled = executionTransition({ folder }, () => {
        const record = json(path.join(folder, 'execution.json'));
        if (record.storage !== 'cache' || record.id !== id || !samePath(record.logicalProjectPath, store.root)
            || !TERMINAL_STATUSES.includes(record.status)) return false;
        const outcome = readOutcome({ folder, record });
        if (!outcome) return false;
        retainOutcome(record, outcome);
        return true;
    });
    if (!settled) return;
    for (const name of fs.readdirSync(folder)) {
        if (executionFiles.has(name)) continue;
        if (!clearIdleUpload || !uploadRequestFile.test(name)) return;
        clearIdleUpload();
        const file = path.join(folder, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1) return;
        fs.unlinkSync(file);
    }
    const retired = path.join(store.parent, '.retired-' + id);
    fs.renameSync(folder, retired);
    removeRetired(retired);
}

function removeRetired(folder) {
    for (const name of executionFiles) {
        const file = path.join(folder, name), stat = readOptional(fs.lstatSync, file);
        if (stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) fs.unlinkSync(file);
    }
    fs.rmdirSync(folder);
}

function retireStandalonePreprocessInputs(config) {
    try {
        if (config.execution.layout === SHARED) {
            const value = recordFor(config);
            if (readOutcome(value)) {
                removeSharedConfig(value.folder);
                if (value.store.cache) retireCachedExecution(value.store, value.record.id);
            }
        } else retirePreprocessInputs(storage(config.execution.logicalProjectPath), config.execution.id);
    }
    catch { /* Cleanup cannot change the observed preprocess result. */ }
}

function pruneTerminalPreprocessInputs(projectPath, shared = false) {
    try {
        const legacy = readOptional(storage, projectPath);
        const cache = shared && readOptional(storage, projectPath, false, true);
        const legacyCurrent = legacy && readSharedSelector(legacy.pointer)?.value?.id;
        const current = cache && readSharedSelector(cache.pointer)?.value;
        if (legacy) for (const id of fs.readdirSync(legacy.parent).filter(name => UUID.test(name))) {
            retirePreprocessInputs(legacy, id);
            if (shared) try {
                if (id === legacyCurrent && !current) {
                    const record = json(path.join(directory(legacy.parent, id, false), 'execution.json'));
                    if (samePath(record.logicalProjectPath, legacy.root)) continue;
                }
                retireLegacyBuildInputs(legacy, id);
            } catch { /* Busy old writers are retried later. */ }
        }
        if (cache) for (const name of fs.readdirSync(cache.parent)) {
            try {
                if (UUID.test(name)) retireCachedExecution(cache, name);
                else if (name.startsWith('.retired-') && UUID.test(name.slice(9))) {
                    removeRetired(directory(cache.parent, name, false));
                }
            } catch { /* Observation and archival can finish before Windows readers close. */ }
        }
    } catch { /* Projects with no readable execution store have no safe cleanup target. */ }
}

/** These are detached byte copies, including npm junctions. No hardlinks or live
 * library links may give an old compiler a path into the new execution. */
function snapshot(config, target, copy, { compilerInputsOnly = false, retainedAbi, generator, generatedHeaders = config.generatedArtifacts !== undefined } = {}) {
    const root = fs.realpathSync(config.currentProjectPath), manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    delete manifest.codeHash; delete manifest.buildInfo;
    if (compilerInputsOnly) mergeGeneratorInputs(manifest, config);
    const inputs = [], active = new Set();
    let bytes = 0, count = 0;
    const visit = (source, relative, depth = 0, boundary) => {
        if (depth > 64) fail('Execution source depth exceeds budget.');
        const real = fs.realpathSync(source), before = fs.statSync(source);
        if (boundary) {
            const fromBoundary = path.relative(boundary, real);
            if (fromBoundary === '..' || fromBoundary.startsWith('..' + path.sep) || path.isAbsolute(fromBoundary))
                fail('Linked project audio escapes its input directory.');
        }
        if (before.isDirectory()) {
            if (active.has(real)) fail('Execution source contains a link cycle.');
            active.add(real);
            if (copy) fs.mkdirSync(path.join(target, relative), { recursive: true });
            inputs.push([relative, 'directory']);
            for (const name of fs.readdirSync(source).sort()) {
                // Generated declarations come from the exact generator capture,
                // never an interrupted older publisher's shared src directory.
                if (relative === 'src' && isGeneratedBuildHeader(name) && generatedHeaders) continue;
                visit(path.join(source, name), path.join(relative, name), depth + 1, boundary);
            }
            active.delete(real);
        } else if (before.isFile()) {
            if (++count > 100000 || (bytes += before.size) > 2 * 1024 * 1024 * 1024) fail('Execution source exceeds capture budget.');
            const content = fs.readFileSync(source);
            if (state(before) !== state(fs.statSync(source))) fail('Execution source changed while copying.');
            inputs.push([relative, relative === 'project.abi' && retainedAbi
                ? resolveCurrentAbiHash(content, retainedAbi) : hash(content)]);
            if (copy) { fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true }); fs.writeFileSync(path.join(target, relative), content, { flag: 'wx', mode: before.mode & 0o777 }); }
        } else fail('Unsupported execution source entry.');
    };
    inputs.push(['package.json', hash(JSON.stringify(compilerInputsOnly ? canonical(manifest) : manifest))]);
    if (copy) fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    // The retained ABI is part of the historical capture. Conversion evidence
    // only needs compiler files, code, declarations and macros.
    for (const name of ['project.abi', ...blocklyProjectBuildInputs(root)]) {
        if (compilerInputsOnly && name === 'project.abi') continue;
        const source = path.join(root, name);
        if (fs.existsSync(source)) visit(source, name, 0, name === 'audio' ? source : undefined);
        else if (compilerInputsOnly && name === 'src' && config.generatedArtifacts != null) inputs.push([name, 'directory']);
    }
    const packages = new Map([[path.join('node_modules', config.boardModule), path.join(root, 'node_modules', config.boardModule)]]);
    for (const pkg of collectLibraryPackages(manifest.dependencies, root)) packages.set(path.relative(root, pkg.packagePath), pkg.packagePath);
    for (const [relative, source] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        // A parent package copy already includes its nested dependencies.
        if ([...packages.keys()].some(parent => parent !== relative && relative.startsWith(parent + path.sep))) continue;
        visit(source, relative);
    }
    if (generator !== undefined) return hash(JSON.stringify({ inputs, boardModule: config.boardModule, generator }));
    return hash(JSON.stringify({ inputs, boardModule: config.boardModule, code: config.code,
        generatedArtifacts: compilerInputsOnly && config.generatedArtifacts != null
            ? config.generatedArtifacts.map(({ fileName, content }) => [fileName, content]).sort(([a], [b]) => a.localeCompare(b))
            : config.generatedArtifacts ?? null,
        projectMacros: compilerInputsOnly ? undefined : config.projectMacros ?? [] }));
}

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function buildDocumentHash(bytes) {
    // Match the renderer's build document; preserve block fields, layout and
    // project data while disregarding persistence formatting and page viewports.
    const { pages, $ailyProjectData, ...document } = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(pages)) return null;
    return hash(JSON.stringify(canonical({ ...document, pages: pages.map(({ viewState, ...page }) => page) })));
}

function resolveCurrentAbiHash(content, retained) {
    const digest = hash(content);
    if (digest === retained.digest) return digest;
    try {
        const documentHash = buildDocumentHash(content);
        if (!documentHash) return digest;
        if (documentHash === retained.compiledDocumentHash || documentHash === retained.savedDocumentHash) return retained.digest;
        if (retained.filename) {
            const original = fs.readFileSync(retained.filename);
            if (hash(original) === retained.digest && buildDocumentHash(original) === documentHash) return retained.digest;
        }
    } catch { /* Unrecognized or unavailable documents require a new build. */ }
    return digest;
}

function applyGeneratorInputs(root, config) {
    const pkgPath = path.join(root, 'package.json'), pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (config.projectMacros !== undefined) {
        mergeGeneratorInputs(pkg, config);
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }
    if (config.generatedArtifacts !== undefined && config.generatedArtifacts !== null) {
        directory(root, 'src');
        for (const artifact of config.generatedArtifacts) {
            if (!isGeneratedBuildHeader(artifact.fileName) || typeof artifact.content !== 'string') fail('Invalid captured generated artifact.');
            fs.writeFileSync(path.join(root, 'src', artifact.fileName), artifact.content, { flag: 'wx' });
        }
    }
}

/** A shared request reserves immutable inputs, never the shared write directory.
 * The verified native child lease admits it before any project-cache mutation. */
function prepareBuildExecution(config, workspace, operation = 'compile', { shared = false, cache = shared, isolatedRecovery = false } = {}) {
    if (!config || typeof config.code !== 'string' || typeof config.boardModule !== 'string'
        || !/^@[^/\\]+\/[^/\\]+$/.test(config.boardModule) || config.boardModule.includes('..')
        || !['compile', 'preprocess'].includes(operation) || (isolatedRecovery && (shared || cache))) fail('Invalid execution request.');
    const store = storage(config.currentProjectPath, true, cache);
    if (JSON.parse(fs.readFileSync(path.join(store.root, 'package.json'), 'utf8')).type === 'coder') fail('Coder execution uses its own build contract.');
    const explicitPreprocess = operation === 'preprocess' && config.explicitPreprocess === true;
    const id = randomUUID(), buildRequestId = config.buildRequestId || id;
    if (typeof buildRequestId !== 'string' || !REQUEST_ID.test(buildRequestId) || (explicitPreprocess && !config.buildRequestId))
        fail('Invalid build request identity.');
    const index = operation === 'compile' || explicitPreprocess
        ? requestPath(store.root, buildRequestId, cache, true) : null;
    const assertIndexAvailable = () => {
        const previous = findRequest(store.root, buildRequestId)?.index;
        if (previous && (operation !== 'compile' || previous.operation === 'preprocess'
            || !UUID.test(config.executionRetryOf) || previous.id !== config.executionRetryOf)) {
            throw Object.assign(new Error('BUILD_EXECUTION_EXISTS: Inspect the existing request instead of starting it twice.'),
                { code: 'BUILD_EXECUTION_EXISTS', buildRequestId });
        }
    };
    if (index) assertIndexAvailable();
    const root = shared ? store.root : directory(directory(store.parent, id), 'project');
    const sharedStore = isolatedRecovery && readOptional(storage, store.root, false, true);
    const interruptedExecution = sharedStore && readSharedSelector(sharedStore.pointer)?.value?.id;
    const generator = cache ? generatorInputDigest(config) : undefined;
    const inputDigest = snapshot(config, root, !shared, { generator });
    const savedAbi = readOptional(fs.readFileSync, path.join(root, 'project.abi'));
    let savedDocumentHash;
    if (shared && savedAbi) {
        try { savedDocumentHash = buildDocumentHash(savedAbi); } catch { /* Nonstandard ABI uses exact bytes. */ }
    }
    const compilerInputDigest = shared ? snapshot(config, '', false, { compilerInputsOnly: true }) : undefined;
    if (snapshot(config, root, false, { generator }) !== inputDigest) fail('Project inputs changed during execution capture.');
    if (!shared) applyGeneratorInputs(root, config);
    const execution = { version: 1, id, logicalProjectPath: store.root, inputDigest,
        buildRequestId, operation, ...(explicitPreprocess ? { explicitPreprocess } : {}),
        ...(shared ? { layout: SHARED } : {}), ...(cache ? { storage: 'cache' } : {}),
        ...(isolatedRecovery ? { isolatedRecovery: true } : {}),
        ...(savedAbi ? { abiHash: `sha256:${hash(savedAbi)}` } : {}),
        ...(config.executionRetryOf ? { retryOf: config.executionRetryOf } : {}) };
    const prepared = { ...config, currentProjectPath: root, partitionFilePath: path.join(root, 'partitions.csv'), execution };
    delete prepared.sourceCapture;
    delete prepared.savedBuildComparison;
    prepared.sourceCapture = captureBuildSource(prepared, workspace);
    if (operation === 'compile') {
        execution.buildSnapshot = buildSnapshotReceipt(prepared.sourceCapture, execution.buildRequestId,
            inputDigest, config.savedBuildComparison, execution.abiHash);
    }
    const folder = directory(store.parent, id), configFilePath = path.join(folder, 'config.json');
    const record = { ...execution, status: 'prepared', sourceCapture: prepared.sourceCapture,
        ...(shared ? { boardModule: config.boardModule, generator, generatedHeaders: config.generatedArtifacts !== undefined, compilerInputDigest, configDigest: hash(JSON.stringify(prepared)),
            ...(savedDocumentHash ? { savedDocumentHash } : {}) } : {}) };
    let previousPending, published = false;
    const admit = () => {
        const pendingPath = shared && sharedDispatchPath(store, operation);
        if (pendingPath) previousPending = readSharedSelector(pendingPath)?.value;
        if (index) {
            const publish = () => {
                assertIndexAvailable();
                write(index, { version: 1, id, buildRequestId, ...(explicitPreprocess ? { operation } : {}) });
                published = true;
            };
            if (shared && config.executionRetryOf) updateRequest(index, publish);
            else publish();
        }
        if (pendingPath) {
            write(pendingPath, { version: 1, id, buildRequestId });
            published = true;
        }
        if (operation === 'compile' && !shared) write(store.pointer, { version: 1, id, buildRequestId,
            ...(interruptedExecution ? { supersedesShared: interruptedExecution } : {}) });
    };
    try {
        write(path.join(folder, 'execution.json'), record);
        write(configFilePath, prepared);
        if (index || shared) locked(store, admit);
    } catch (error) {
        if (shared && !published) {
            try { removeRetired(folder); } catch { /* Preserve the original admission error. */ }
        }
        throw error;
    }
    // A running original remains under its supervisor. Only an unstarted
    // predecessor of the same operation can be retired by a new preparation.
    if (shared) {
        try {
            if (previousPending) settleSharedBuild(store, previousPending, { requirePrepared: true });
            if (store.cache) {
                const legacy = readOptional(storage, store.root);
                const older = legacy && readSharedSelector(sharedDispatchPath(legacy, operation))?.value;
                if (older) settleSharedBuild(legacy, { ...older, operation }, { requirePrepared: true });
            }
        } catch { /* Dispatch independently checks the durable pending selector. */ }
    }
    return shared ? { ...prepared, configFilePath } : prepared;
}

function executionRoot(store, folder, record) {
    if (record.layout === SHARED) return store.root;
    if (record.layout !== undefined) fail('Unsupported build execution layout.');
    return path.join(folder, 'project');
}

function recordFor(config) {
    const execution = config.execution;
    if (execution?.version !== 1 || !UUID.test(execution.id)) fail('Missing execution identity.');
    const store = storage(execution.logicalProjectPath, false, execution.storage === 'cache'), folder = directory(store.parent, execution.id, false);
    const record = json(path.join(folder, 'execution.json')), root = executionRoot(store, folder, record);
    if (!samePath(fs.realpathSync(config.currentProjectPath), root)) fail('Execution path does not belong to its request.');
    if (record.version !== 1 || record.layout !== execution.layout || record.storage !== execution.storage
        || record.id !== execution.id || record.inputDigest !== execution.inputDigest || record.buildRequestId !== execution.buildRequestId
        || record.operation !== execution.operation || record.explicitPreprocess !== execution.explicitPreprocess
        || record.abiHash !== execution.abiHash
        || JSON.stringify(record.buildSnapshot) !== JSON.stringify(execution.buildSnapshot)
        || !samePath(record.logicalProjectPath, store.root) || JSON.stringify(record.sourceCapture) !== JSON.stringify(config.sourceCapture)) fail('Execution binding changed.');
    return { store, folder, root, record };
}

/** Keep the generated source for the exact request after the shared sketch is superseded. */
function retainSharedBuildSource(config, materialized) {
    if (config.execution?.layout !== SHARED || config.execution.storage === 'cache') return;
    const { folder, root, record } = recordFor(config);
    const source = Buffer.from(config.code, 'utf8');
    if (materialized?.path !== path.join(root, '.temp', 'sketch', 'sketch.ino')
        || materialized.sha256 !== record.sourceCapture?.sourceSha256 || hash(source) !== materialized.sha256) {
        fail('Historical source does not match the captured shared input.');
    }
    fs.writeFileSync(path.join(folder, 'sketch.ino'), source, { flag: 'wx', mode: 0o600 });
}

function validateSharedBuildLaunch(configPath, expectedProject, operation) {
    if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) fail('Invalid shared build request path.');
    const config = json(configPath, configurationLimit);
    if (config?.execution?.layout !== SHARED) fail('Missing shared build request.');
    const value = recordFor(config);
    if (!samePath(path.resolve(configPath), path.join(value.folder, 'config.json'))
        || !samePath(fs.realpathSync(configPath), path.join(value.folder, 'config.json'))
        || (expectedProject && !samePath(fs.realpathSync(expectedProject), value.root))
        || (operation && value.record.operation !== operation)
        || value.record.configDigest !== hash(JSON.stringify(config))
        || value.record.status !== 'prepared' || readOutcome(value) || !isSharedDispatchCurrent(value))
        fail('Shared build request is no longer eligible for dispatch.');
    readOptional(directory, value.root, '.temp', false);
    return config;
}

function confirmSharedBuildInputs(config) {
    if (config.execution?.layout !== SHARED) return;
    const { root, record } = recordFor(config);
    readOptional(directory, root, '.temp', false);
    // An editor save does not change the requested code. File, dependency,
    // media and macro changes do change the compiler input contract.
    if (snapshot(config, '', false, { compilerInputsOnly: true }) !== record.compilerInputDigest) {
        throw Object.assign(new Error('BUILD_SOURCE_STALE: Project compiler inputs changed; build again.'), { code: 'BUILD_SOURCE_STALE' });
    }
}

function removeSharedConfig(folder) {
    const filename = path.join(folder, 'config.json');
    const stat = readOptional(fs.lstatSync, filename);
    if (!stat) return true;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('Invalid execution configuration.');
    try { fs.unlinkSync(filename); }
    catch (error) {
        if (error.code === 'ENOENT') return true;
        // A Windows reader can keep a retired config open after the matching
        // request has already settled. The file is not a writer lease.
        if (isWindowsSharingError(error)) return false;
        throw error;
    }
    return true;
}

function retirePreviousSharedConfig(store, pointer, except) {
    if (!pointer || pointer.version !== 1 || !UUID.test(pointer.id) || pointer.id === except) return true;
    const folder = readOptional(directory, store.parent, pointer.id, false);
    const record = folder && readOptional(json, path.join(folder, 'execution.json'));
    if (record?.layout === SHARED && record.id === pointer.id && record.buildRequestId === pointer.buildRequestId
        && samePath(record.logicalProjectPath, store.root)) return removeSharedConfig(folder);
    return true;
}

function syncStoppedStatus(store, folder, filename, record, outcome) {
    const updated = { ...record, status: outcome.status };
    const matches = () => JSON.stringify(readOptional(json, filename)) === JSON.stringify(record)
        && JSON.stringify(readOutcome({ folder, record })) === JSON.stringify(outcome);
    const replace = () => write(filename, updated, undefined, fs.renameSync);
    try { replace(); }
    catch (error) {
        // The durable outcome has already settled this drained writer.
        if (!isWindowsSharingError(error) || error.dest !== filename || !matches()) throw error;
        retryDeferredWindowsFile(() => {
            if (!readOptional(directory, store.parent, record.id, false)) return;
            try { executionTransition({ folder }, () => { if (matches()) replace(); }); }
            catch (error) {
                if (error.code === 'BUILD_WORKSPACE_BUSY') return false;
                throw error;
            }
        });
    }
}

function settleSharedBuild(store, { id, buildRequestId, operation } = {}, {
    requirePrepared = false, refusal, allowUnreadableHistory = false, deferStoppedStatus = false, retainedConfigs,
} = {}) {
    if (typeof id !== 'string' || !UUID.test(id) || typeof buildRequestId !== 'string' || !REQUEST_ID.test(buildRequestId)) return null;
    const folder = readOptional(directory, store.parent, id, false);
    if (!folder) return null;
    return executionTransition({ folder }, () => {
        const filename = path.join(folder, 'execution.json');
        let record;
        try { record = json(filename); }
        catch (error) {
            // A drained Job or an exclusive cleanup lease excludes a writer.
            // Preserve unreadable history without assigning it a result.
            if (allowUnreadableHistory && (error.code === 'ENOENT' || error instanceof SyntaxError)) return { status: 'unconfirmed' };
            throw error;
        }
        if (record.version !== 1 || record.layout !== SHARED || record.id !== id
            || record.buildRequestId !== buildRequestId || !samePath(record.logicalProjectPath, store.root)
            || (operation !== undefined && record.operation !== operation)) return null;
        let existing;
        try { existing = readOutcome({ folder, record }); }
        catch (error) {
            if (allowUnreadableHistory && error.code === 'BUILD_OUTCOME_UNREADABLE') return { status: 'unconfirmed' };
            throw error;
        }
        const status = refusal ? 'not-started' : 'cancelled';
        if (existing && existing.status !== status) return existing;
        if (requirePrepared && (record.status !== 'prepared' || record.owner)) return existing;
        if (!existing && !['prepared', 'running'].includes(record.status)) return null;
        const outcome = existing ?? claimOutcome({ folder, record }, status, refusal);
        if (outcome.status === status) {
            if (record.status !== status) {
                if (deferStoppedStatus) syncStoppedStatus(store, folder, filename, record, outcome);
                else write(filename, { ...record, status: outcome.status });
            }
            if (!removeSharedConfig(folder)) retainedConfigs?.add(id);
        }
        return outcome;
    });
}

function settleOriginal(projectPath, request, options) {
    if (typeof request?.id !== 'string' || !UUID.test(request.id)
        || typeof request.buildRequestId !== 'string' || !REQUEST_ID.test(request.buildRequestId)) return null;
    const root = fs.realpathSync(projectPath);
    const store = readOptional(storeForExecution, root, request.id);
    if (store && readOptional(directory, store.parent, request.id, false)) return settleSharedBuild(store, request, options);
    const indexed = findRequest(root, request.buildRequestId)?.index;
    if (indexed?.id === request.id && indexed.record?.id === request.id && indexed.outcome
        && samePath(indexed.record.logicalProjectPath, root) && indexed.buildRequestId === request.buildRequestId
        && (!request.operation || request.operation === indexed.record.operation)) {
        return readOutcome({ record: indexed.record }, indexed.outcome);
    }
    return null;
}

function settleStoppedSharedBuild(projectPath, request) {
    return settleOriginal(projectPath, request, { allowUnreadableHistory: true, deferStoppedStatus: true });
}

/** Denial releases only this original, unstarted execution's request file. */
function settleUnstartedSharedBuild(projectPath, request, error) {
    if (!['compile', 'preprocess'].includes(request?.operation)) return null;
    const code = typeof error?.code === 'string' && REFUSAL_CODE.test(error.code) ? error.code : 'BUILD_DISPATCH_REJECTED';
    const message = code === 'BUILD_WORKSPACE_RECOVERY_REQUIRED'
        ? 'A previous build still owns the project cache; it can be reused after its exit is verified.'
        : String(error?.message || 'The build was refused before starting.').slice(0, REFUSAL_MESSAGE_LIMIT);
    return settleOriginal(projectPath, request, { requirePrepared: true, refusal: { code, message } });
}

function assertSharedBuildSupervisor(config) {
    if (config.execution?.layout === SHARED && !UUID.test(process.env[supervisorEnvironment] ?? ''))
        fail('Shared build must be dispatched by its native supervisor.');
}
function readOutcome({ folder, record }, archived) {
    let outcome;
    try { outcome = archived ?? json(path.join(folder, 'outcome.json')); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) error.code = 'BUILD_OUTCOME_UNREADABLE';
        throw error;
    }
    if (outcome?.version !== 1 || outcome.id !== record.id || outcome.buildRequestId !== record.buildRequestId
        || outcome.inputDigest !== record.inputDigest || !TERMINAL_STATUSES.includes(outcome.status)
        || (TERMINAL_STATUSES.includes(record.status) && record.status !== outcome.status)) fail('Terminal execution receipt changed.');
    if (outcome.status === 'not-started' && (typeof outcome.code !== 'string' || !REFUSAL_CODE.test(outcome.code) || typeof outcome.message !== 'string'
        || !outcome.message || outcome.message.length > REFUSAL_MESSAGE_LIMIT)) fail('Invalid build refusal receipt.');
    return outcome;
}

function claimOutcome(value, status, refusal) {
    // Cancellation and completion use one immutable first-writer receipt. A
    // late Stop cannot rewrite a completed build, and a late compiler cannot
    // undo cancellation. This guard is separate from the mutable status guard.
    const filename = path.join(value.folder, 'outcome.json');
    const receipt = { version: 1, id: value.record.id, buildRequestId: value.record.buildRequestId,
        inputDigest: value.record.inputDigest, status, ...(refusal ?? {}) };
    const persist = result => {
        try { retainOutcome(value.record, result); }
        catch (error) {
            // The immutable outcome is already readable here. Retirement must
            // publish it before discarding this directory and can retry later.
            if (error.code !== 'BUILD_WORKSPACE_BUSY') throw error;
        }
        return result;
    };
    const existing = readOutcome(value);
    if (existing) return persist(existing);
    try {
        return locked({ anchor: path.join(value.folder, 'outcome.guard') }, guard => {
            const current = readOutcome(value);
            if (current) return persist(current);
            write(filename, receipt, guard.assertHeld);
            return persist(receipt);
        });
    } catch (error) {
        if (error.code === 'BUILD_WORKSPACE_BUSY') {
            const winner = readOutcome(value);
            if (winner) return persist(winner);
        }
        throw error;
    }
}
function startBuildExecution(config, lease) {
    if (!config.execution) return;
    const value = recordFor(config);
    if (!samePath(lease.projectRoot, value.root) || !UUID.test(lease.buildId)) fail('Execution lease belongs to another workspace.');
    assertSharedBuildSupervisor(config);
    lease.assertOwned();
    const owner = { pid: process.pid, creation: observeBuildProcessIdentity(process.pid), bootId: getSystemBootId(), token: lease.buildId };
    executionTransition(value, () => {
        const start = () => {
            lease.assertOwned();
            const filename = path.join(value.folder, 'execution.json'), current = json(filename);
            if (current.status !== 'prepared' || readOutcome(value)) fail('Execution was already started or cancelled. Inspect its original request.');
            if (current.layout === SHARED) {
                const writer = json(path.join(value.root, '.build', 'aily-workspace.lock'));
                if (writer.token !== lease.buildId || writer.supervisor !== process.env[supervisorEnvironment]
                    || !isSharedDispatchCurrent(value)) fail('Shared build lost its original dispatch or writer binding.');
            }
            const sharedCompile = current.layout === SHARED && current.operation === 'compile';
            const previous = sharedCompile ? readSharedSelector(value.store.pointer)?.value : null;
            write(filename, { ...current, status: 'running', owner });
            activeOwners.set(value.record.id, owner.token);
            if (sharedCompile) {
                if (readOutcome(value)) fail('Build was cancelled before its shared workspace started.');
                write(value.store.pointer, { version: 1, id: current.id, buildRequestId: current.buildRequestId });
                try { retirePreviousSharedConfig(value.store, previous, current.id); }
                catch { /* Pruning a historical configuration is advisory. */ }
            }
        };
        if (value.record.layout === SHARED) locked(value.store, start);
        else start();
    });
}
function finishBuildExecution(config, success) {
    if (!config.execution) return;
    const value = recordFor(config);
    executionTransition(value, () => {
        const current = json(path.join(value.folder, 'execution.json'));
        if (!['prepared', 'running'].includes(current.status)) return;
        if (current.layout === SHARED && current.status === 'running'
            && (current.owner?.pid !== process.pid || activeOwners.get(current.id) !== current.owner?.token)) return;
        if (success && !fs.existsSync(path.join(value.folder, 'outcome.json'))
            && (current.status !== 'running' || current.owner?.pid !== process.pid
                || activeOwners.get(current.id) !== current.owner?.token)) fail('Completion does not belong to the observed execution owner.');
        const outcome = claimOutcome(value, success ? 'completed' : 'failed');
        write(path.join(value.folder, 'execution.json'), { ...current, status: outcome.status });
        activeOwners.delete(current.id);
        if (current.layout === SHARED && (outcome.status !== 'completed' || current.storage === 'cache')) {
            try { removeSharedConfig(value.folder); } catch { /* Evidence remains in the independent receipt. */ }
        }
    });
}
function cancelBuildExecution(config) {
    if (!config?.execution) return;
    const value = readOptional(recordFor, config);
    if (!value && config.execution.storage === 'cache' && config.execution.layout === SHARED) {
        const { logicalProjectPath, buildRequestId, operation, id, inputDigest } = config.execution;
        if (!samePath(fs.realpathSync(config.currentProjectPath), fs.realpathSync(logicalProjectPath))) fail('Invalid cancellation scope.');
        const previous = findRequest(logicalProjectPath, buildRequestId)?.index;
        const record = previous?.record;
        if (record?.storage === 'cache' && previous.id === id && record.id === id && record.operation === operation
            && record.buildRequestId === buildRequestId && record.inputDigest === inputDigest && previous.outcome
            && samePath(record.logicalProjectPath, fs.realpathSync(logicalProjectPath))) return readOutcome({ record }, previous.outcome);
    }
    if (!value) fail('Original execution record is missing.');
    if (TERMINAL_STATUSES.includes(value.record.status)) {
        const outcome = readOutcome(value);
        if (!outcome) fail('Terminal execution receipt is missing.');
        return outcome;
    }
    if (!['prepared', 'running'].includes(value.record.status)) fail('Execution status is unknown.');
    return claimOutcome(value, 'cancelled');
}

/** The caller has relinquished the exact preparation without dispatching it. */
function abandonPreparedPreprocess(config) {
    if (config?.execution?.operation !== 'preprocess') return false;
    const value = recordFor(config);
    const abandoned = executionTransition(value, () => {
        const { record: current } = recordFor(config);
        if (current.version !== 1 || current.operation !== 'preprocess' || current.status !== 'prepared' || current.owner
            || typeof current.buildRequestId !== 'string' || !REQUEST_ID.test(current.buildRequestId)
            || !ownsStandalonePreprocess(value.store, current)) return false;
        if (current.layout === SHARED) {
            // An unstarted shared request has not taken the writer lease and
            // must not touch a different task which currently owns the cache.
            const outcome = claimOutcome(value, 'cancelled');
            if (outcome.status !== 'cancelled') return false;
            write(path.join(value.folder, 'execution.json'), { ...current, status: outcome.status });
            return true;
        }
        const idle = inspectBuildWorkspaceIdle(value.root);
        try {
            idle.assertIdle();
            const outcome = claimOutcome(value, 'cancelled');
            if (outcome.status !== 'cancelled') return false;
            write(path.join(value.folder, 'execution.json'), { ...current, status: outcome.status });
            return true;
        } finally { idle.release(); }
    });
    if (abandoned) retireStandalonePreprocessInputs(config);
    return abandoned;
}
function currentExecutionStore(projectPath) {
    const cache = readOptional(storage, projectPath, false, true);
    const shared = cache && readSharedSelector(cache.pointer);
    if (!shared) return storage(projectPath);
    try {
        const isolated = readOptional(storage, projectPath);
        const selected = isolated && readSharedSelector(isolated.pointer)?.value;
        // A subsequently started shared build has a different selector.
        if (selected?.supersedesShared && selected.supersedesShared === shared.value?.id) return isolated;
    } catch { /* An invalid older isolated store cannot replace a shared selection. */ }
    return cache;
}

function completedExecution(projectPath) {
    const store = currentExecutionStore(projectPath);
    const pointer = json(store.pointer);
    if (pointer.version !== 1 || !UUID.test(pointer.id)) return null;
    const folder = directory(store.parent, pointer.id, false);
    const record = json(path.join(folder, 'execution.json')), root = executionRoot(store, folder, record);
    if (record.version !== 1 || (pointer.supersedesShared && record.isolatedRecovery !== true)
        || !['running', 'completed'].includes(record.status)
        || record.operation !== 'compile' || record.id !== pointer.id
        || record.buildRequestId !== pointer.buildRequestId || !samePath(record.logicalProjectPath, store.root)
        || readOutcome({ folder, record })?.status !== 'completed'
        || !samePath(fs.realpathSync(root), root)) return null;
    if (record.layout === SHARED && process.platform === 'darwin' && requiresIsolatedBuildRecovery(root)) return null;
    // A directory or exit code alone is never a firmware receipt.
    const upload = require('./blockly-upload-state');
    const config = store.cache ? { currentProjectPath: root, execution: record, boardModule: record.boardModule }
        : json(path.join(folder, 'config.json'), configurationLimit);
    if (store.cache ? !SHA256.test(record.generator) || record.storage !== 'cache'
        : record.layout === SHARED && record.configDigest !== hash(JSON.stringify(config))) return null;
    if (!upload.canReuseBlocklyUpload({ ...config, currentProjectPath: root }, store.cache ? record.generator : undefined)) return null;
    return { store, pointer, record, root, config };
}

/** Read-only conversion evidence. This does not grant permission to reuse a
 * firmware for upload and never publishes or starts a build. */
function inspectBlocklyCompileProof(config) {
    try {
        const completed = completedExecution(config.currentProjectPath);
        if (!completed) return { version: 1, status: 'unverified', reason: 'no-completed-build' };
        const { store, pointer, record, root, config: compiled } = completed;
        const options = { compilerInputsOnly: true };
        const actual = snapshot(config, '', false, options);
        const expected = record.layout === SHARED ? record.compilerInputDigest
            : snapshot({ ...compiled, currentProjectPath: root }, '', false, options);
        if (snapshot(config, '', false, options) !== actual || !samePath(currentExecutionStore(config.currentProjectPath).pointer, store.pointer)
            || JSON.stringify(json(store.pointer)) !== JSON.stringify(pointer)) {
            return { version: 1, status: 'unknown', reason: 'inputs-changed-during-check' };
        }
        return { version: 1, status: actual === expected ? 'verified' : 'unverified',
            reason: actual === expected ? 'matching-compiler-inputs' : 'compiler-inputs-changed',
            executionId: record.id, buildRequestId: record.buildRequestId };
    } catch (error) {
        return { version: 1, status: error.code === 'ENOENT' ? 'unverified' : 'unknown',
            reason: error.code === 'ENOENT' ? 'missing-build-input-or-receipt' : 'evidence-unavailable' };
    }
}

function resolveBuildExecution(projectPath, liveConfig) {
    try {
        const completed = completedExecution(projectPath);
        if (!completed) return null;
        const { store, pointer, record, root, config } = completed;
        // Keep the original input digest and ABI receipt. A view-only save, or
        // saving the actual compiled canvas, can stand in for the same ABI entry.
        const retainedAbi = /^sha256:[a-f0-9]{64}$/.test(record.abiHash ?? '') ? {
            filename: record.layout === SHARED ? undefined : path.join(root, 'project.abi'),
            savedDocumentHash: record.savedDocumentHash, digest: record.abiHash.slice(7),
            compiledDocumentHash: record.sourceCapture?.workspace?.documentSha256,
        } : undefined;
        const generator = store.cache ? (liveConfig ? generatorInputDigest(liveConfig) : record.generator) : undefined;
        const generatedHeaders = liveConfig ? liveConfig.generatedArtifacts !== undefined : record.generatedHeaders;
        if (snapshot({ ...(liveConfig ?? config), currentProjectPath: store.root }, '', false, { retainedAbi, generator, generatedHeaders }) !== record.inputDigest
            || !samePath(currentExecutionStore(projectPath).pointer, store.pointer)
            || JSON.stringify(json(store.pointer)) !== JSON.stringify(pointer)) return null;
        return { currentProjectPath: root, logicalProjectPath: store.root, buildPath: path.join(root, '.build'),
            preprocessPath: path.join(root, '.temp', 'preprocess.json'), buildRequestId: record.buildRequestId, inputDigest: record.inputDigest,
            ...(record.isolatedRecovery ? { isolatedRecovery: true, executionId: record.id } : {}),
            ...(record.layout === SHARED ? { executionId: record.id, layout: SHARED, ...(store.cache ? { storage: 'cache' } : {}) } : {}) };
    } catch { return null; }
}
function canReuseBuildExecution(config) {
    return !!resolveBuildExecution(config?.currentProjectPath, config);
}
function resolveBuildProjectPath(projectPath) {
    try {
        const root = fs.realpathSync(projectPath);
        if (json(path.join(root, 'package.json'), 2 * 1024 * 1024).type === 'coder') return root;
        return resolveBuildExecution(root)?.currentProjectPath ?? null;
    } catch { return null; }
}
function readBuildLogReference(store, project, requestId) {
    try {
        const logs = directory(directory(directory(store.root, '.log', false), 'compile', false), 'requests', false);
        const filename = `${hash(requestId)}.log`;
        const physicalPath = path.join(logs, filename);
        const before = fs.lstatSync(physicalPath);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
            || !samePath(fs.realpathSync(physicalPath), physicalPath)) return undefined;
        const fd = fs.openSync(physicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
            const opened = fs.fstatSync(fd);
            // Some Windows Electron builds omit the device only on path stat.
            const named = process.platform === 'win32' && before.dev === 0
                ? { ...before, dev: opened.dev } : before;
            if (!opened.isFile() || opened.nlink !== 1 || state(opened) !== state(named)) return undefined;
            const prefix = Buffer.alloc(Math.min(before.size, 128 * 1024));
            const count = fs.readSync(fd, prefix, 0, prefix.length, 0);
            const header = /^Build request: ([^\r\n]+)\nProject: ([^\r\n]+)\n\n/.exec(prefix.subarray(0, count).toString('utf8'));
            if (header?.[1] !== requestId || !path.isAbsolute(header[2])
                || (!samePath(path.resolve(header[2]), store.root) && !samePath(path.resolve(header[2]), path.resolve(project))))
                return undefined;
            let receipt;
            try { receipt = json(physicalPath + '.receipt.json', 1024); } catch { /* Legacy or incomplete captures have no proof. */ }
            if (state(fs.fstatSync(fd)) !== state(opened) || state(fs.lstatSync(physicalPath)) !== state(before)
                || !samePath(fs.realpathSync(physicalPath), physicalPath)) return undefined;
            return { version: 1, requestId, project, path: path.resolve(project, '.log', 'compile', 'requests', filename),
                complete: receipt?.version === 1 && receipt.requestId === requestId && receipt.size === before.size };
        } finally { fs.closeSync(fd); }
    } catch { return undefined; }
}

function historicalBuildReference(record, sourceRoot) {
    const { id, buildRequestId, inputDigest, sourceCapture } = record;
    const { digest, ...capture } = sourceCapture ?? {};
    const sourceSha256 = capture.schemaVersion === 1 && capture.scope === 'captured-build-source' && capture.mode === 'blockly'
        && typeof capture.sourceSha256 === 'string' && SHA256.test(capture.sourceSha256) && digest === hash(JSON.stringify(capture))
        && capture.projectLocationSha256 === hash(process.platform === 'win32' ? sourceRoot.toLowerCase() : sourceRoot)
        ? capture.sourceSha256 : undefined;
    return { version: 1, operation: record.operation, executionId: id, buildRequestId, inputDigest,
        ...(sourceSha256 ? { sourceSha256 } : {}) };
}

function inspectBuildExecution(projectPath, buildRequestId) {
    try {
        if (typeof buildRequestId !== 'string' || !REQUEST_ID.test(buildRequestId)) return null;
        const rootPath = fs.realpathSync(projectPath);
        const found = findRequest(rootPath, buildRequestId);
        if (!found) return null;
        const { index, file: indexPath, cache } = found;
        if (index.version !== 1 || index.buildRequestId !== buildRequestId || !UUID.test(index.id)) return null;
        const available = readOptional(storage, rootPath, false, cache);
        const store = available ?? { root: rootPath };
        const folder = available && readOptional(directory, store.parent, index.id, false);
        const archived = cache && !folder && index.outcome;
        const record = archived ? { ...index.record, status: archived.status } : json(path.join(folder, 'execution.json'));
        const root = executionRoot(store, folder, record);
        const operation = index.operation ?? 'compile';
        if (record.version !== 1 || (cache && (record.storage !== 'cache' || record.layout !== SHARED))
            || !['compile', 'preprocess'].includes(operation) || record.operation !== operation
            || (operation === 'preprocess' && record.explicitPreprocess !== true) || record.id !== index.id
            || record.buildRequestId !== buildRequestId || typeof record.inputDigest !== 'string' || !SHA256.test(record.inputDigest)
            || !samePath(record.logicalProjectPath, store.root)) return null;
        let current;
        try { if (available) current = json(store.pointer); } catch { /* The exact request remains observable if pointer publication was interrupted. */ }
        let outcome, unreadableOutcome = false;
        try { outcome = readOutcome({ folder, record }, archived || undefined); }
        catch (error) {
            if (record.layout !== SHARED || error.code !== 'BUILD_OUTCOME_UNREADABLE') throw error;
            unreadableOutcome = true;
        }
        if (!outcome && !unreadableOutcome && !['prepared', 'running'].includes(record.status)) return null;
        let status = unreadableOutcome ? 'unconfirmed' : outcome?.status ?? record.status;
        let ownerState = unreadableOutcome ? 'outcome-unreadable' : undefined;
        let isCurrent = false;
        if (operation === 'compile' && current?.id === record.id && current.buildRequestId === buildRequestId) {
            try { isCurrent = samePath(currentExecutionStore(rootPath).pointer, store.pointer); }
            catch { /* The exact request remains observable without a current selection. */ }
        }
        const resolved = status === 'completed' && isCurrent ? resolveBuildExecution(projectPath) : null;
        const selected = resolved?.buildRequestId === buildRequestId
            && samePath(resolved.currentProjectPath, root) ? resolved : null;
        if (status === 'prepared') ownerState = 'start-unobserved';
        if (status === 'running') {
            const owner = record.owner, boot = getSystemBootId();
            let alive = false;
            try { process.kill(owner?.pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
            if (!owner || !alive || (boot && owner.bootId && boot !== owner.bootId)) { status = 'interrupted'; ownerState = 'owner-exited'; }
            else {
                const actual = owner.creation ? observeBuildProcessIdentity(owner.pid) : null;
                let lease;
                try { lease = json(path.join(root, '.build', 'aily-workspace.lock')); } catch { /* Unknown lease cannot certify an active execution. */ }
                if (actual && actual === owner.creation && boot && owner.bootId === boot
                    && lease?.token === owner.token && lease.pid === owner.pid) ownerState = 'live';
                else if (actual && owner.creation && actual !== owner.creation) { status = 'interrupted'; ownerState = 'identity-changed'; }
                else { status = 'unconfirmed'; ownerState = 'identity-unavailable'; }
            }
        }
        const buildLog = (outcome || unreadableOutcome) && readBuildLogReference(store, projectPath, buildRequestId);
        if (JSON.stringify(json(indexPath)) !== JSON.stringify(index)) return null;
        return { version: 1, operation, executionId: record.id, buildRequestId, status, inputDigest: record.inputDigest,
            ...(record.buildSnapshot ? { buildSnapshot: record.buildSnapshot } : {}),
            ...(operation === 'compile' && record.abiHash ? { buildInput: { version: 1, executionId: record.id, buildRequestId,
                inputDigest: record.inputDigest, abiHash: record.abiHash } } : {}),
            ...(outcome ? { buildHistory: historicalBuildReference(record, root) } : {}),
            ...(buildLog ? { buildLog } : {}),
            ...(ownerState ? { ownerState } : {}),
            ...(status === 'not-started' ? { code: outcome.code, message: outcome.message } : {}),
            nextAction: status === 'running' && ownerState === 'live' ? 'observe-original'
                : ['prepared', 'interrupted', 'unconfirmed'].includes(status) ? 'new-execution-required'
                : operation === 'compile' && status === 'completed' && !selected ? 'rebuild-current-inputs' : 'terminal',
            current: isCurrent, ...(selected ? { result: selected } : {}) };
    } catch { return null; }
}

const buildOwnerEntries = new Set(['aily-workspace.lock', 'aily-builder.lock', 'aily-workspace-recovery.lock']);

function clearBuildDirectory(root, assertIdle, preserveRequests = false) {
    const build = directory(root, '.build', false);
    for (const name of fs.readdirSync(build)) {
        if (buildOwnerEntries.has(name.toLowerCase()) || (preserveRequests && name.toLowerCase() === 'requests')) continue;
        assertIdle();
        fs.rmSync(path.join(build, name), { recursive: true, force: true });
    }
}

function retireLegacyTemporary(root, assertIdle) {
    const temporary = readOptional(directory, root, '.temp', false);
    if (!temporary) return;
    const sketch = readOptional(directory, temporary, 'sketch', false);
    const source = sketch && readOptional(fs.lstatSync, path.join(sketch, 'sketch.ino'));
    if (!source?.isFile() || source.nlink !== 1) {
        assertIdle();
        fs.rmSync(temporary, { recursive: true, force: true });
        return;
    }
    // History resolves this exact v1 path after the original worktree is retired.
    for (const [parent, retained] of [[temporary, 'sketch'], [sketch, 'sketch.ino']]) {
        for (const name of fs.readdirSync(parent)) {
            if (name === retained) continue;
            assertIdle();
            fs.rmSync(path.join(parent, name), { recursive: true, force: true });
        }
    }
}

function retireLegacyBuildInputs(store, id) {
    const folder = directory(store.parent, id, false);
    const initial = readOptional(json, path.join(folder, 'execution.json'));
    if (!initial) return false;
    if (initial.layout === SHARED) {
        if (!readOptional(fs.lstatSync, path.join(folder, 'config.json'))) return true;
        return initial.id === id && !!readOutcome({ folder, record: initial }) && removeSharedConfig(folder);
    }
    if (initial.inputsRetired === true) return true;
    return executionTransition({ folder }, () => {
        const record = readOptional(json, path.join(folder, 'execution.json'));
        if (record?.version !== 1 || record.id !== id || record.layout !== undefined
            || !['compile', 'preprocess'].includes(record.operation) || !SHA256.test(record.inputDigest)
            || typeof record.buildRequestId !== 'string' || !REQUEST_ID.test(record.buildRequestId)
            || typeof record.logicalProjectPath !== 'string' || !path.isAbsolute(record.logicalProjectPath)
            || !readOutcome({ folder, record })) return false;
        if (!samePath(record.logicalProjectPath, store.root)) {
            const file = readOptional(requestPath, store.root, record.buildRequestId, false);
            const index = file && readOptional(json, file);
            if (record.operation === 'compile' || record.explicitPreprocess) {
                if (index?.id !== id || index?.buildRequestId !== record.buildRequestId
                    || (index.operation ?? 'compile') !== record.operation) return false;
            } else if (index || record.buildRequestId !== id) return false;
        }
        const root = readOptional(directory, folder, 'project', false);
        if (!root) return true;
        const idle = inspectBuildWorkspaceIdle(root);
        try {
            if (readOptional(directory, root, '.build', false)) clearBuildDirectory(root, idle.assertIdle);
            if (process.platform === 'darwin') retireLegacyTemporary(root, idle.assertIdle);
            else {
                idle.assertIdle();
                fs.rmSync(path.join(root, '.temp'), { recursive: true, force: true });
            }
            for (const name of ['node_modules', ...blocklyProjectBuildInputs(root), 'project.abi', 'package.json']) {
                idle.assertIdle();
                fs.rmSync(path.join(root, name), { recursive: true, force: true });
            }
            if (!removeSharedConfig(folder)) return false;
            write(path.join(folder, 'execution.json'), { ...record, inputsRetired: true });
            return true;
        } finally { idle.release(); }
    });
}

/** Clearing remains part of the same project-root write protocol as building.
 * Historical status, logs and lock anchors are outside the cleanup set. */
function clearSharedBuildCache(projectPath, { preserveSketch = false } = {}) {
    const root = fs.realpathSync(projectPath);
    if (json(path.join(root, 'package.json'), 2 * 1024 * 1024).type === 'coder') fail('Coder cache uses its own build contract.');
    const lease = acquireBuildWorkspace(root, 'clean');
    try {
        const temporary = readOptional(directory, root, '.temp', false);
        const retainedExecutionIds = new Set();
        const stores = [readOptional(storage, root, false, true), readOptional(storage, root)].filter(Boolean);
        lease.clearLegacyRecovery();
        for (const store of stores) locked(store, () => {
            lease.assertBuilderIdle();
            const current = readSharedSelector(store.pointer);
            const dispatch = ['compile', 'preprocess'].map(operation => ({
                operation, selector: readSharedSelector(sharedDispatchPath(store, operation)),
            }));
            // Revoke each exact pending request durably before removing its
            // selector or touching cache files. A failed cleanup can then be retried.
            for (const { operation, selector } of dispatch) {
                if (selector?.value) settleSharedBuild(store, { ...selector.value, operation }, {
                    requirePrepared: true, allowUnreadableHistory: true, retainedConfigs: retainedExecutionIds,
                });
            }
            for (const selector of [current, ...dispatch.map(entry => entry.selector)]) {
                if (selector) fs.unlinkSync(selector.filename);
            }
            const previous = current?.value;
            try { if (!retirePreviousSharedConfig(store, previous)) retainedExecutionIds.add(previous.id); }
            catch { if (previous) retainedExecutionIds.add(previous.id); }
        });
        clearBuildDirectory(root, lease.assertBuilderIdle, true);
        if (temporary) {
            const clear = preserveSketch ? ['libraries', 'library-archives', 'library-cache.json', 'preprocess.json', 'target-compile.json']
                .map(name => path.join(temporary, name)) : [temporary];
            for (const target of clear) {
                lease.assertBuilderIdle();
                fs.rmSync(target, { recursive: true, force: true });
            }
        }
        for (const store of stores) for (const id of fs.readdirSync(store.parent).filter(name => UUID.test(name))) {
            try {
                if (store.cache) retireCachedExecution(store, id, lease.assertBuilderIdle);
                else if (!retireLegacyBuildInputs(store, id)) retainedExecutionIds.add(id);
            } catch { retainedExecutionIds.add(id); }
        }
        return { cleared: true, retainedExecutionIds: [...retainedExecutionIds] };
    } finally { lease.release(); }
}

module.exports = { prepareBuildExecution, startBuildExecution, finishBuildExecution, cancelBuildExecution, resolveBuildExecution,
    resolveBuildProjectPath, canReuseBuildExecution, inspectBuildExecution, recordFor, retireStandalonePreprocessInputs,
    pruneTerminalPreprocessInputs, abandonPreparedPreprocess, inspectBlocklyCompileProof, validateSharedBuildLaunch,
    confirmSharedBuildInputs, settleStoppedSharedBuild, settleUnstartedSharedBuild, mergeGeneratorInputs, clearSharedBuildCache,
    assertSharedBuildSupervisor, retainSharedBuildSource };
