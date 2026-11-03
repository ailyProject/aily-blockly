'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { acquireBuildWorkspace } = require('./build-workspace-lease');
const { invalidateBuildDelivery } = require('./compile-delivery');
const HEADER = /^(?:variables|objects)_[a-zA-Z0-9_-]+-[a-f0-9]{8}\.h$/;
const MAX_BYTES = 128 * 1024 * 1024;
const fail = message => { throw new Error(`BUILD_PUBLICATION_INVALID: ${message}`); };

// Closed publication operations, not an arbitrary filesystem bridge. All I/O
// and the final release are synchronous: no renderer context-change await gap.
function publish(projectPath, action) {
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) fail('Expected an absolute project path.');
    const owner = acquireBuildWorkspace(projectPath, 'publish');
    try { return action(owner.projectRoot, owner.assertOwned); }
    finally { owner.release(); }
}

function physical(root, relative) {
    let cursor = root;
    for (const part of relative.split('/')) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
            fail(`Refusing linked or non-regular publication path: ${relative}`);
        }
    }
    return cursor;
}

function readBytes(root, relative, limit = MAX_BYTES) {
    const filename = physical(root, relative);
    try {
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size > limit) fail(`Invalid or oversized publication file: ${relative}`);
        return fs.readFileSync(filename);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function read(root, relative, limit = MAX_BYTES) {
    return readBytes(root, relative, limit)?.toString('utf8') ?? null;
}

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Only affected source bytes, under the same physical publication lease.
 * The manifest is written last and every file is verified before any source
 * replacement/deletion or invalidation of a successful build ticket. */
function archiveSuperseded(root, originals, removals, assertOwned) {
    const sources = [...originals].filter(([, bytes]) => bytes !== null);
    if (!sources.length) return;
    const bytes = sources.reduce((sum, [, contents]) => sum + contents.length, 0);
    if (bytes > MAX_BYTES) fail('Superseded generated sources exceed 128 MiB.');
    const parent = '.aily/generated-source-archives', directory = `${parent}/${randomUUID()}`;
    assertOwned();
    fs.mkdirSync(physical(root, parent), { recursive: true }); physical(root, parent);
    fs.mkdirSync(physical(root, directory)); physical(root, directory);
    const write = (relative, content) => {
        assertOwned();
        const filename = physical(root, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true }); physical(root, relative);
        const fd = fs.openSync(filename, 'wx', 0o600);
        try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        assertOwned();
        if (!readBytes(root, relative).equals(content)) fail('Generated source archive verification failed.');
    };
    const files = sources.map(([relative, content]) => {
        const archivedPath = `files/${relative}`;
        write(`${directory}/${archivedPath}`, content);
        return { path: relative, archivedPath, operation: removals.includes(relative) ? 'remove' : 'replace',
            bytes: content.length, hash: digest(content) };
    });
    const manifest = Buffer.from(JSON.stringify({ version: 1, kind: 'superseded-generated-source', files }, null, 2));
    const filename = `${directory}/manifest.json`;
    write(filename, manifest);
    return { version: 1, manifest: filename, hash: digest(manifest), fileCount: files.length, bytes };
}

function assertOriginalSources(root, originals, assertOwned, only) {
    for (const [relative, before] of originals) {
        if (only !== undefined && relative !== only) continue;
        assertOwned();
        const current = readBytes(root, relative);
        if (before === null ? current !== null : current === null || !before.equals(current)) {
            fail(`Generated source changed during preservation: ${relative}`);
        }
    }
}

/** A source-resolution commit outlives the renderer's optional flag. Only its
 * bounded, hash-bound metadata chain can carry preservation across a restart;
 * opaque ABS snapshots are never decoded or used to generate code here. */
function committedSourceResolution(root, assertOwned) {
    const committedPath = '.aily/abs-sync/committed.json';
    const pointerBytes = readBytes(root, committedPath, 4096);
    const current = () => {
        assertOwned(); const actual = readBytes(root, committedPath, 4096);
        if (pointerBytes === null ? actual !== null : actual === null || !pointerBytes.equals(actual)) fail('Committed source resolution changed during publication.');
    };
    if (pointerBytes === null) return { preserve: false, current };
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
    const parse = bytes => { try { return JSON.parse(bytes); } catch { fail('Invalid committed source resolution metadata.'); } };
    const pointer = parse(pointerBytes);
    if (!object(pointer) || pointer.schemaVersion !== 1 || typeof pointer.generation !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(pointer.generation)
        || !hash(pointer.hash) || Object.keys(pointer).sort().join(',') !== 'generation,hash,schemaVersion') fail('Invalid committed source resolution pointer.');
    const baselineKey = `baselines/${pointer.generation}.json`;
    const baselineBytes = readBytes(root, `.aily/abs-sync/${baselineKey}`);
    if (baselineBytes === null || digest(baselineBytes) !== pointer.hash) fail('Committed source resolution baseline hash mismatch.');
    const record = parse(baselineBytes);
    const context = record?.schemaVersion === 2 ? record.context : record?.schemaVersion === 1 ? record.projection?.map : null;
    if (!object(context) || context.generation !== pointer.generation || context.baselineRef !== baselineKey) fail('Invalid committed source resolution generation.');
    if (!Object.hasOwn(record, 'recoveryArchive')) { current(); return { preserve: false, current }; }
    const scope = context?.scope;
    const canonical = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
    const validScope = value => object(value) && typeof value.projectKey === 'string' && path.isAbsolute(value.projectKey)
        && canonical(value.projectKey) === canonical(root) && typeof value.pageId === 'string' && value.pageId.length > 0
        && Object.keys(value).sort().join(',') === 'pageId,projectKey';
    const reference = record.recoveryArchive;
    if (!object(reference) || !/^recoveries\/[A-Za-z0-9_-]{1,96}\.json$/.test(reference.key) || !hash(reference.hash)) fail('Invalid committed source resolution archive reference.');
    const archivedBytes = readBytes(root, `.aily/abs-sync/${reference.key}`);
    if (archivedBytes === null || digest(archivedBytes) !== reference.hash) fail('Committed source resolution archive hash mismatch.');
    const archive = parse(archivedBytes);
    if (!object(archive)) fail('Invalid committed source resolution archive.');
    if (!Object.hasOwn(archive, 'resolution')) { current(); return { preserve: false, current }; }
    if (!validScope(scope)) fail('Committed source resolution scope mismatch.');
    if (archive?.schemaVersion !== 1 || archive.generation !== pointer.generation || archive.authority !== 'workspace'
        || !validScope(archive.scope) || archive.scope.pageId !== scope.pageId || !hash(archive.repairToken)) fail('Invalid committed source resolution archive identity.');
    const resolution = archive.resolution;
    if (!object(resolution) || Object.keys(resolution).sort().join(',') !== 'choice,inputAbiHash,token'
        || !hash(resolution.token) || resolution.token !== archive.repairToken
        || !['keep_view', 'replace_view'].includes(resolution.choice) || !hash(resolution.inputAbiHash)
        || typeof archive.disk?.abi !== 'string' || digest(Buffer.from(archive.disk.abi)) !== resolution.inputAbiHash) {
        fail('Invalid committed source resolution proof.');
    }
    current(); return { preserve: true, current };
}

function replace(root, relative, content, assertOwned) {
    const filename = physical(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, content, { flag: 'wx' });
        for (let attempt = 0; ; attempt++) {
            // Windows readers can briefly deny replacement; retain the same
            // atomic write and recheck ownership/paths before every attempt.
            assertOwned(); physical(root, relative);
            try { fs.renameSync(temporary, filename); break; }
            catch (error) {
                if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (2 ** attempt));
            }
        }
    } finally { fs.rmSync(temporary, { force: true }); }
}

function publishArduinoGeneratedCode(projectPath, { artifacts = null, sketchCode, preserveSuperseded } = {}) {
    if (preserveSuperseded !== undefined && preserveSuperseded !== true) fail('Invalid source preservation option.');
    if (sketchCode !== undefined && typeof sketchCode !== 'string') fail('Invalid generated code.');
    if (artifacts !== null && (!Array.isArray(artifacts) || artifacts.length > 256)) fail('Invalid generated artifact list.');
    const names = new Set();
    let size = Buffer.byteLength(sketchCode || '', 'utf8');
    for (const artifact of artifacts || []) {
        if (!artifact || typeof artifact.fileName !== 'string' || !HEADER.test(artifact.fileName)
            || typeof artifact.content !== 'string' || typeof artifact.sourceTag !== 'string'
            || names.has(artifact.fileName.toLowerCase())) fail('Invalid or duplicate generated header.');
        names.add(artifact.fileName.toLowerCase());
        size += Buffer.byteLength(artifact.content, 'utf8');
    }
    if (size > MAX_BYTES) fail('Generated publication exceeds 128 MiB.');
    if (artifacts === null && sketchCode === undefined) return { changed: false };
    return publish(projectPath, (root, assertOwned) => {
        const original = read(root, 'package.json', 2 * 1024 * 1024);
        if (original === null) fail('Project package.json is missing.');
        const manifest = JSON.parse(original);
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Invalid project manifest.');
        if (manifest?.type === 'coder') fail('Generated Arduino publication is only for Blockly projects.');
        const writes = [], removals = [], originals = new Map(), observed = new Map();
        const observe = (relative, previous) => {
            observed.set(relative, previous === null ? null : digest(previous));
            if (preserveSuperseded) originals.set(relative, previous);
        };
        const remove = relative => {
            const previous = readBytes(root, relative); observe(relative, previous);
            removals.push(relative);
        };
        const write = (relative, content) => {
            const previous = readBytes(root, relative);
            const unchanged = preserveSuperseded ? previous !== null && previous.equals(Buffer.from(content)) : previous?.toString('utf8') === content;
            if (unchanged) return;
            observe(relative, previous);
            writes.push([relative, content]);
        };
        if (artifacts !== null) {
            const source = physical(root, 'src');
            for (const name of fs.existsSync(source) ? fs.readdirSync(source) : []) {
                if (HEADER.test(name) && !names.has(name.toLowerCase())) {
                    remove(`src/${name}`);
                }
            }
            for (const artifact of artifacts) {
                write(`src/${artifact.fileName}`, artifact.content);
            }
            const legacy = physical(root, '.temp/sketch/generated');
            for (const name of fs.existsSync(legacy) ? fs.readdirSync(legacy) : []) {
                if (HEADER.test(name)) remove(`.temp/sketch/generated/${name}`);
            }
        }
        if (sketchCode !== undefined) write('.temp/sketch/sketch.ino', sketchCode);
        if (!writes.length && !removals.length) return { changed: false };
        const committed = committedSourceResolution(root, assertOwned);
        const preserve = preserveSuperseded || committed.preserve;
        if (preserve && !preserveSuperseded) for (const [relative, expected] of observed) {
            const bytes = readBytes(root, relative);
            if ((bytes === null ? null : digest(bytes)) !== expected) fail('Generated source changed before inherited preservation.');
            originals.set(relative, bytes);
        }
        const sourceArchive = preserve ? archiveSuperseded(root, originals, removals, assertOwned) : undefined;
        try {
            committed.current();
            if (preserve) assertOriginalSources(root, originals, assertOwned);
            // Never leave a previous successful ticket after changing generated input.
            // Validate the whole requested publication before this first mutation.
            assertOwned(); invalidateBuildDelivery(root);
            for (const [name, content] of writes) {
                committed.current();
                if (preserve) assertOriginalSources(root, originals, assertOwned, name);
                replace(root, name, content, assertOwned);
            }
            for (const name of removals) {
                committed.current();
                if (preserve) assertOriginalSources(root, originals, assertOwned, name);
                assertOwned(); fs.unlinkSync(physical(root, name));
            }
        } catch (error) {
            if (!sourceArchive) throw error;
            const failure = new Error(`${error.message || String(error)}\nPreserved generated source archive: ${sourceArchive.manifest} (${sourceArchive.hash}).`, { cause: error });
            if (typeof error.code === 'string') failure.code = error.code;
            throw failure;
        }
        return { changed: true, ...(sourceArchive ? { sourceArchive } : {}) };
    });
}

function patchBuildMetadata(projectPath, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some(key => !['codeHash', 'buildInfo'].includes(key))) fail('Only build metadata may be patched.');
    if (patch.codeHash !== undefined && !/^[a-f0-9]{64}$/.test(patch.codeHash)) fail('Invalid code hash.');
    if (patch.buildInfo !== undefined) {
        const info = patch.buildInfo;
        if (!info || !['success', 'failed', 'cancelled'].includes(info.lastBuildStatus)
            || !/^[a-f0-9]{64}$/.test(info.lastBuildCode) || typeof info.lastBuildTime !== 'string'
            || !Number.isFinite(Date.parse(info.lastBuildTime)) || !Number.isFinite(info.lastBuildDuration) || info.lastBuildDuration < 0
            || Object.keys(info).some(key => !['lastBuildTime', 'lastBuildCode', 'lastBuildStatus', 'lastBuildDuration'].includes(key))) fail('Invalid build result metadata.');
    }
    return publish(projectPath, (root, assertOwned) => {
        const original = read(root, 'package.json', 2 * 1024 * 1024);
        if (original === null) fail('Project package.json is missing.');
        const manifest = JSON.parse(original);
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Invalid project manifest.');
        Object.assign(manifest, patch);
        const content = JSON.stringify(manifest, null, 2);
        if (Buffer.byteLength(content) > 2 * 1024 * 1024) fail('Project manifest exceeds 2 MiB.');
        if (content !== original) replace(root, 'package.json', content, assertOwned);
        return manifest;
    });
}

module.exports = { publishArduinoGeneratedCode, patchBuildMetadata, generatedSourceArchiveVersion: 1 };
