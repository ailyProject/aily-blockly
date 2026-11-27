'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const project = require('./aily-code-project');
const { captureSketchInputs } = require('./sketch-inputs');
const HEADER = /^(?:variables|objects)_[a-zA-Z0-9_-]+-[a-f0-9]{8}\.h$/;
const SAVED_PROJECT_FILES = ['project.abi', 'project.abs', 'project.abs.map.json'];
const MAX_WORKSPACE_BYTES = 128 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = message => { throw Object.assign(new Error(`BUILD_SOURCE_STALE: ${message}`), { code: 'BUILD_SOURCE_STALE' }); };

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

const location = filename => hash(process.platform === 'win32' ? filename.toLowerCase() : filename);
const state = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const generatedLimit = 128 * 1024 * 1024;
const isGeneratedBuildHeader = name => HEADER.test(name);

function sourceManifest(bytes) {
    const manifest = JSON.parse(bytes.toString('utf8'));

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('Invalid project manifest.');

    delete manifest.codeHash; delete manifest.buildInfo;

    return JSON.stringify(canonical(manifest));
}

function read(root, relative, limit = 2 * 1024 * 1024) {
    let filename = root;

    for (const segment of relative.split('/')) {
        filename = path.join(filename, segment);

        if (fs.lstatSync(filename).isSymbolicLink()) fail('Source capture cannot traverse implicit links.');
    }

    const before = fs.statSync(filename);

    if (!before.isFile() || before.size > limit) fail('Source capture file exceeds its boundary.');

    const bytes = fs.readFileSync(filename);

    if (state(before) !== state(fs.statSync(filename)) || bytes.length > limit) fail('Source changed during capture.');

    return bytes;
}

function workspaceRecord(value) {
    if (value === undefined) return undefined;

    if (value?.scope !== 'serialized-blockly-document' || !sha(value.documentSha256)
        || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Number.isSafeInteger(value.runtimeRevision) || value.runtimeRevision < 0
        || typeof value.pageId !== 'string' || !value.pageId || value.pageId.length > 256) fail('Invalid workspace capture.');

    const files = value.savedProjectFiles;

    if (files !== undefined) {
        if (!Array.isArray(files) || ![1, 3].includes(files.length)) fail('Invalid saved workspace file boundary.');

        let sizeBytes = 0;

        for (const [index, file] of files.entries()) {
            if (!file || typeof file !== 'object' || Array.isArray(file)
                || Object.keys(file).sort().join(',') !== 'path,sha256,sizeBytes'
                || file.path !== SAVED_PROJECT_FILES[index] || !sha(file.sha256)
                || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
                || (sizeBytes += file.sizeBytes) > MAX_WORKSPACE_BYTES) fail('Invalid saved workspace file boundary.');
        }
    }

    return { scope: value.scope, documentSha256: value.documentSha256, revision: value.revision,
        runtimeRevision: value.runtimeRevision, pageId: value.pageId,
        ...(files === undefined ? {} : { savedProjectFiles: files.map(file => ({ path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 })) }) };
}

function confirmSavedWorkspace(root, workspace) {
    if (workspace?.savedProjectFiles === undefined) return;

    const present = relative => {
        try { fs.lstatSync(path.join(root, relative)); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };

    const hasAbs = present('project.abs'), hasMap = present('project.abs.map.json');

    if (hasAbs !== hasMap) fail('Saved ABS and its map must be present together.');

    let remaining = MAX_WORKSPACE_BYTES;

    const current = SAVED_PROJECT_FILES.slice(0, hasAbs ? 3 : 1).map(relative => {
        let bytes;

        try { bytes = read(root, relative, remaining); }
        catch (error) { if (error.code === 'ENOENT') fail('Saved workspace file is unavailable.'); throw error; }

        remaining -= bytes.length;

        return { path: relative, sizeBytes: bytes.length, sha256: hash(bytes) };
    });

    if (JSON.stringify(current) !== JSON.stringify(workspace.savedProjectFiles)) fail('Saved workspace files differ from the prepared boundary.');
}

function generatedArtifacts(value, caseInsensitive) {
    if (value === undefined) return undefined;

    const artifacts = value ?? [];

    if (!Array.isArray(artifacts) || artifacts.length > 256) fail('Invalid captured generated artifacts.');

    const seen = new Set();
    let size = 0;

    return artifacts.map(artifact => {
        const { fileName, content } = artifact ?? {};

        if (typeof fileName !== 'string' || !HEADER.test(fileName) || typeof content !== 'string') fail('Invalid captured generated artifact.');

        const key = caseInsensitive ? fileName.toLowerCase() : fileName;

        if (seen.has(key) || (size += Buffer.byteLength(content)) > generatedLimit) fail('Generated artifact exceeds its capture boundary.');

        seen.add(key);

        return { fileName, content };
    }).sort((a, b) => a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0);
}

/** A shared build stages captured declarations only in its temporary sketch. */
function sharedGeneratedArtifacts(config) {
    return config.execution?.layout === 'shared'
        ? generatedArtifacts(config.generatedArtifacts, process.platform === 'win32') : undefined;
}

function isolatedCloudGeneratorInputs(config) {
    const artifacts = generatedArtifacts(config.generatedArtifacts ?? undefined, true);
    const effects = config.projectMacros;

    if (effects === undefined) return { artifacts };
    if (!Array.isArray(effects) || effects.length > 512) fail('Invalid captured generator macros.');

    const seen = new Set();

    const projectMacros = effects.map(effect => {
        const { name, value } = effect ?? {};

        if (typeof name !== 'string' || !/^[A-Za-z_]\w{0,127}$/u.test(name) || seen.has(name)
            || (value !== null && (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/u.test(value)
                || (value !== name && !value.startsWith(`${name}=`))))) fail('Invalid captured generator macro.');

        seen.add(name);

        return { name, value };
    });

    return { artifacts, projectMacros };
}

function mergeGeneratorInputs(pkg, config) {
    if (config.projectMacros !== undefined) {
        const macros = new Map();

        for (const item of pkg.MACROS || []) { const value = String(Array.isArray(item) ? item[0] : item).trim(); if (value) macros.set(value.split('=')[0], value); }
        for (const [name, value] of Object.entries(pkg.ailyGeneratorMacros || {})) if (macros.get(name) === value) macros.delete(name);

        const owned = Object.create(null);

        for (const { name, value } of [...config.projectMacros].sort((a, b) => a.name.localeCompare(b.name))) {
            macros.delete(name); if (value !== null) { macros.set(name, value); owned[name] = value; }
        }

        pkg.MACROS = [...macros.values()].map(value => [value]); pkg.ailyGeneratorMacros = owned;
    }
}

function confirmSharedGeneratedArtifacts(config, root) {
    const artifacts = sharedGeneratedArtifacts(config);

    if (!artifacts) return;

    const names = fs.readdirSync(root).filter(name => HEADER.test(name)).sort();

    if (names.length !== artifacts.length || artifacts.some(({ fileName }, index) => fileName !== names[index])) {
        fail('Materialized generated declaration names changed.');
    }

    for (const { fileName, content } of artifacts) {
        const expected = Buffer.from(content);

        if (!read(root, fileName, expected.length).equals(expected)) fail('Materialized generated declaration bytes changed.');
    }
}

/** A bounded capture of request/configuration/generated files, not a complete
 * source tree or authenticated memory revision. No writes, locks or IPC here.
 */
function record(config, workspace) {
    if (typeof config.currentProjectPath !== 'string' || !path.isAbsolute(config.currentProjectPath)
        || typeof config.code !== 'string' || Buffer.byteLength(config.code) > 128 * 1024 * 1024
        || typeof config.boardModule !== 'string' || !/^@[^/\\]+\/[^/\\]+$/.test(config.boardModule)
        || config.boardModule.includes('..')) fail('Invalid build source request.');

    const root = fs.realpathSync(config.currentProjectPath);
    const manifest = sourceManifest(read(root, 'package.json'));
    const mode = project.isAilyCodeProjectRoot(root) ? 'coder' : 'blockly';
    const board = fs.realpathSync(path.join(root, 'node_modules', config.boardModule));
    const headers = [];
    const cloud = mode === 'blockly' && config.isolatedCloudBuild === true ? isolatedCloudGeneratorInputs(config) : undefined;
    const artifacts = cloud ? cloud.artifacts : sharedGeneratedArtifacts(config);
    let generatedBytes = 0;

    if (mode === 'blockly') {
        if (config.recordProjectDelivery === true && config.graphSemanticRevision !== undefined && workspace?.savedProjectFiles === undefined) {
            fail('Scene-bound delivery requires a saved workspace file boundary.');
        }

        confirmSavedWorkspace(root, workspace);
    }

    if (mode === 'coder') {
        if (workspace) fail('Coder cannot claim a Blockly workspace revision.');

        const entry = path.relative(root, project.resolveCompileSourcePath(root)).split(path.sep).join('/');

        if (entry.startsWith('../') || path.isAbsolute(entry) || read(root, entry, 128 * 1024 * 1024).toString('utf8') !== config.code) {
            fail('Coder entry differs from the captured request; save and build again.');
        }
    } else if (artifacts) {
        for (const { fileName, content } of artifacts) {
            headers.push({ name: fileName, sizeBytes: Buffer.byteLength(content), sha256: hash(content) });
        }
    } else if (fs.existsSync(path.join(root, 'src'))) {
        if (fs.lstatSync(path.join(root, 'src')).isSymbolicLink()) fail('Generated source directory is linked.');

        for (const name of fs.readdirSync(path.join(root, 'src')).filter(name => HEADER.test(name)).sort()) {
            if (headers.length >= 256) fail('Generated header count exceeds budget.');

            const bytes = read(root, `src/${name}`, generatedLimit - generatedBytes);

            generatedBytes += bytes.length;

            headers.push({ name, sizeBytes: bytes.length, sha256: hash(bytes) });
        }
    }

    let sketchInputs;

    if (mode === 'blockly') {
        sketchInputs = captureSketchInputs(path.join(root, 'src')).manifest;

        if (artifacts) {
            const files = sketchInputs.files.filter(file => !HEADER.test(file.path));

            files.push(...headers.map(({ name, sizeBytes, sha256 }) => ({ path: name, sizeBytes, sha256 })));
            files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

            const sketch = { schemaVersion: sketchInputs.schemaVersion, scope: sketchInputs.scope, files };
            sketchInputs = { ...sketch, digest: hash(JSON.stringify(sketch)) };
        }
    }

    const body = { schemaVersion: 1, scope: 'captured-build-source', mode, projectLocationSha256: location(root),
        sourceSha256: hash(config.code), projectManifestSha256: hash(manifest),
        boardModule: config.boardModule, boardLocationSha256: location(board),
        boardJsonSha256: hash(read(board, 'board.json')), boardPackageSha256: hash(read(board, 'package.json')),
        generatedHeadersSha256: hash(JSON.stringify(headers)), generatedHeaderCount: headers.length,
        ...(cloud ? { isolatedCloudBuild: true, ...(cloud.projectMacros ? { generatorMacrosSha256: hash(JSON.stringify(cloud.projectMacros)) } : {}) } : {}),
        ...(mode === 'blockly' ? { sketchInputs } : {
            // Coder owns persistent multi-file sources, including localized
            // libraries. Keep this separate from Blockly's copied Ninja graph
            // binding; full delivery still verifies its complete ProjectSources.
            coderInputs: captureSketchInputs(
                JSON.parse(manifest).arduinoSketch === true ? root : project.resolveCompileWorkspacePath(root),
                path.relative(JSON.parse(manifest).arduinoSketch === true ? root : project.resolveCompileWorkspacePath(root),
                    project.resolveCompileSourcePath(root)).split(path.sep).join('/'),
                { recursiveSources: true },
            ).manifest,
        }),
        ...(workspace ? { workspace } : {}) };

    return { ...body, digest: hash(JSON.stringify(body)) };
}

function captureBuildSource(config, workspace) {
    let capturedWorkspace;

    if (workspace !== undefined) {
        if (typeof workspace.documentText !== 'string' || Buffer.byteLength(workspace.documentText) > 128 * 1024 * 1024) fail('Invalid workspace document.');

        capturedWorkspace = workspaceRecord({ ...workspace, scope: 'serialized-blockly-document', documentSha256: hash(workspace.documentText) });
    }

    const captured = record(config, capturedWorkspace);

    // Detect changes across separate file reads. This is still a bookend check.
    if (record(config, capturedWorkspace).digest !== captured.digest) fail('Configuration changed during capture.');

    return captured;
}

function confirmBuildSource(config) {
    if (config.sourceCapture === undefined) return undefined; // Legacy/explicit historical CLI callers.

    const captured = config.sourceCapture;

    if (captured?.schemaVersion !== 1 || captured.scope !== 'captured-build-source' || !sha(captured.digest)) fail('Invalid capture contract.');

    const current = record(config, workspaceRecord(captured.workspace));

    if (JSON.stringify(current) !== JSON.stringify(captured)) {
        const changed = Object.keys(current).filter(key => key !== 'digest'
            && JSON.stringify(current[key]) !== JSON.stringify(captured[key]));

        fail(`Project/board/generated inputs changed after capture (${changed.join(', ') || 'capture digest'}); build again.`);
    }

    return current;
}

/** The copied compile workspace must match the frozen project source boundary.
 * Keep physical file state private to this compile; mtime is not portable source
 * identity, but detects mutation-and-restore while a compiler is running.
 */

function confirmPreparedBuildSource(config, previous) {
    if (config.sourceCapture === undefined || config.sourceCapture.mode !== 'blockly') return undefined;

    const root = fs.realpathSync(config.currentProjectPath);
    const temporary = path.join(root, '.temp');

    if (fs.realpathSync(temporary) !== temporary) fail('Prepared sketch cannot traverse implicit links.');

    const current = captureSketchInputs(path.join(temporary, 'sketch'));

    if (JSON.stringify(current.manifest) !== JSON.stringify(config.sourceCapture.sketchInputs)) {
        fail('Prepared Arduino sketch inputs differ from the captured project sources.');
    }

    if (previous && JSON.stringify(current) !== JSON.stringify(previous)) fail('Prepared Arduino sketch inputs changed during compilation.');

    return current;
}

module.exports = { captureBuildSource, confirmBuildSource, confirmPreparedBuildSource, sourceManifest, isGeneratedBuildHeader,
    sharedGeneratedArtifacts, confirmSharedGeneratedArtifacts, isolatedCloudGeneratorInputs, mergeGeneratorInputs };
