'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { sourceManifest } = require('./build-source-capture');
const { captureLibrarySource } = require('./library-source-evidence');
const { collectLibraryPackages } = require('./library-packages');
const { blocklyProjectBuildInputs } = require('./blockly-project-build-inputs');
const hash = value => createHash('sha256').update(value).digest('hex');
const receiptPath = root => path.join(root, '.build', 'aily-upload-state.json');
const sharedSlot = config => config.execution?.layout === 'shared' ? config.execution.id : undefined;

// Ordinary upload reuse is separate from simulation/delivery acceptance. Read only
// compiler inputs and firmware, never create a workspace or treat a directory as a build.
function generatorInputDigest(config) {
    return hash(JSON.stringify([config.code, config.projectMacros || [], config.generatedArtifacts ?? null]));
}
function captureBlocklyUploadInputs(config, generatorDigest) {
    const root = fs.realpathSync(config.currentProjectPath);
    const manifest = sourceManifest(fs.readFileSync(path.join(root, 'package.json')));
    const pkg = JSON.parse(manifest);
    if (pkg.type === 'coder') throw new Error('Blockly upload reuse cannot inspect a Coder project.');
    const records = [];
    const add = filename => {
        if (!fs.existsSync(filename)) { records.push([filename, null]); return; }
        const captured = captureLibrarySource(filename);
        records.push([filename, captured.location, captured.fingerprint]);
    };
    for (const name of blocklyProjectBuildInputs(root)) add(path.join(root, name));
    const board = path.join(root, 'node_modules', config.boardModule);
    for (const name of ['package.json', 'board.json']) add(path.join(board, name));
    for (const lib of collectLibraryPackages(pkg.dependencies, root)) {
        for (const name of ['package.json', 'src', 'src.7z']) add(path.join(lib.packagePath, name));
    }
    if (config.execution?.storage === 'cache') return hash(JSON.stringify({ root, manifest, boardModule: config.boardModule,
        generator: generatorDigest ?? generatorInputDigest(config), records }));
    return hash(JSON.stringify({ root, manifest, boardModule: config.boardModule, code: config.code,
        projectMacros: config.projectMacros || [], generatedArtifacts: config.generatedArtifacts ?? null, records }));
}

const isRequestDirectory = relative => (process.platform === 'win32' ? relative.toLowerCase() : relative).split(path.sep)[0] === 'requests';

function captureFirmware(root) {
    const directory = path.join(root, '.build');
    if (!fs.existsSync(directory)) return null;
    const files = [];
    const visit = (folder, depth = 0) => {
        if (depth > 16 || fs.lstatSync(folder).isSymbolicLink()) throw new Error('Invalid firmware directory.');
        for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            // Request metadata is reclaimed independently of firmware.
            if (depth === 0 && isRequestDirectory(entry.name)) continue;
            const filename = path.join(folder, entry.name);
            if (entry.isDirectory()) visit(filename, depth + 1);
            else if (/\.(?:bin|hex|elf|eep|img|uf2)$/i.test(entry.name)) {
                if (!entry.isFile() || files.length >= 128) throw new Error('Invalid firmware output.');
                const captured = captureLibrarySource(filename);
                if (!captured.sizeBytes) throw new Error('Empty firmware output.');
                files.push([path.relative(directory, filename), captured.fingerprint]);
            }
        }
    };
    visit(directory);
    return files.length ? hash(JSON.stringify(files)) : null;
}

function invalidateBlocklyUploadState(root) {
    fs.rmSync(receiptPath(root), { force: true });
}

function espSrUploadPair(prepared, directory) {
    const command = prepared?.upload?.command;
    const board = prepared?.arduinoConfig?.board;
    const pair = /^\s*(0x[\da-f]+) \{build\.path\}\/srmodels\.bin$/i.exec(board?.['upload.extra_flags'] || '');
    if (prepared?.success !== true || typeof command !== 'string' || !pair || board?.['build.mcu'] !== 'esp32s3'
        || !/^esp_sr_\w+$/.test(board?.['build.partitions'] || '')
        || !['esptool_py', 'esptool_py_app_only'].includes(prepared.upload.toolName)
        || !/\swrite[-_]flash\s/.test(command)
        || typeof prepared.envVars?.BUILD_PATH !== 'string'
        || path.resolve(prepared.envVars.BUILD_PATH) !== path.resolve(directory)) return null;

    const model = path.join(directory, 'srmodels.bin');
    const escapedModel = model.replace(/\\/g, '/').split('/')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
    const pattern = new RegExp(`\\s+${pair[1]}\\s+(?:"${escapedModel}"|${escapedModel})(?=\\s|$)`, 'i');
    return pattern.test(command) ? { model, pattern, address: pair[1] } : null;
}

function needsEspSrModel(prepared, directory) {
    if (Array.isArray(prepared.dependencies)) {
        return prepared.dependencies.some(item => item?.type === 'library' && item.name === 'ESP_SR');
    }
    return fs.existsSync(path.join(directory, 'library', 'ESP_SR'))
        || fs.existsSync(path.join(directory, 'libraries', 'ESP_SR'));
}

function hasEspSrModel(model) {
    try {
        const stat = fs.lstatSync(model);
        if (!stat.isFile() || !stat.size) throw new Error('BUILD_ARTIFACT_INVALID: Invalid ESP_SR model image; build again.');
        return true;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return false;
    }
}

// Arduino's hook looks in libraries/ESP_SR; aily-builder also compiles into
// library/ESP_SR and can reuse archives without emitting that directory.
function materializeEspSrModel(preprocessPath, directory, { shared = false } = {}) {
    if (!shared && !fs.existsSync(preprocessPath)) return;
    const prepared = shared ? readSharedPreprocess(path.dirname(directory)).prepared
        : JSON.parse(fs.readFileSync(preprocessPath, 'utf8'));
    const pair = espSrUploadPair(prepared, directory);
    if (!pair) return;
    if (!needsEspSrModel(prepared, directory)) {
        if (shared) fs.rmSync(pair.model, { force: true });
        return;
    }
    // Shared builds can retain the previous SDK's model. Always use the
    // current SDK there, even when the compiler did not copy a new model.
    if (hasEspSrModel(pair.model) && !shared) return;

    const sdkPath = prepared.envVars.COMPILER_SDK_PATH;
    if (typeof sdkPath !== 'string' || !path.isAbsolute(sdkPath)) {
        throw new Error('BUILD_ARTIFACT_INVALID: Missing ESP_SR SDK directory; build again.');
    }
    const source = path.join(sdkPath, 'esp_sr', 'srmodels.bin');
    if (!hasEspSrModel(source)) {
        throw new Error('BUILD_ARTIFACT_INVALID: ESP_SR was built but the SDK has no srmodels.bin; reinstall the board tools.');
    }
    const temporary = `${pair.model}.${randomUUID()}.tmp`;
    try {
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        fs.renameSync(temporary, pair.model);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function resolveEspSrUploadCommand(prepared, directory) {
    const command = prepared?.upload?.command;
    const pair = espSrUploadPair(prepared, directory);
    if (!pair) return command;

    // Treat the model and its flash address as a pair. Quote the path because
    // the SDK's upload.extra_flags leaves the build directory unquoted.
    if (hasEspSrModel(pair.model)) {
        return command.replace(pair.pattern, () => ` ${pair.address} "${pair.model}"`);
    }
    if (needsEspSrModel(prepared, directory)) {
        throw new Error('BUILD_ARTIFACT_INVALID: ESP_SR was built but srmodels.bin is missing; build again.');
    }
    return command.replace(pair.pattern, '');
}

function readSharedPreprocess(root) {
    const filename = path.join(root, '.temp', 'preprocess.json');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024
        || fs.realpathSync(filename) !== filename) throw new Error('Invalid shared build recipe.');
    const bytes = fs.readFileSync(filename);
    const prepared = JSON.parse(bytes.toString('utf8'));
    const directory = path.join(root, '.build');
    if (prepared.success !== true || typeof prepared.envVars?.BUILD_PATH !== 'string'
        || fs.realpathSync(prepared.envVars.BUILD_PATH) !== directory) throw new Error('Invalid shared build recipe.');
    return { prepared, fingerprint: hash(bytes) };
}

function captureGeneratedUploadFiles(root, sharedPreprocess) {
    const directory = path.join(root, '.build');
    const filename = path.join(root, '.temp', 'preprocess.json');
    if (!sharedPreprocess && !fs.existsSync(filename)) return [];
    const prepared = sharedPreprocess?.prepared ?? JSON.parse(fs.readFileSync(filename, 'utf8'));
    const preparedDirectory = path.resolve(prepared.envVars?.BUILD_PATH || '');
    if (prepared.success !== true || typeof prepared.upload?.command !== 'string'
        || !fs.existsSync(preparedDirectory) || fs.realpathSync(preparedDirectory) !== directory) return [];
    const prefix = `${preparedDirectory.replace(/\\/g, '/')}/`;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}[^"\\r\\n]*?\\.(?:bin|hex|elf|eep|img|uf2)(?=["\\s:]|$)`, 'gi');
    const command = resolveEspSrUploadCommand(prepared, preparedDirectory);
    const files = [...command.replace(/\\/g, '/').matchAll(pattern)].map(match => {
        const file = path.resolve(match[0]);
        if (!fs.existsSync(file)
            || !fs.lstatSync(file).isFile() || !fs.statSync(file).size) {
            throw new Error('BUILD_ARTIFACT_INVALID: Generated upload output is missing or invalid; build again.');
        }
        const relative = path.relative(directory, fs.realpathSync(file));
        if (relative.startsWith('..') || path.isAbsolute(relative) || isRequestDirectory(relative)) {
            throw new Error('BUILD_ARTIFACT_INVALID: Generated upload output is outside the firmware area.');
        }
        return relative;
    });
    return [...new Set(files)].sort();
}

function readBlocklyUploadArtifacts(buildPath) {
    const directory = path.resolve(buildPath), root = path.dirname(directory);
    if (path.basename(directory) !== '.build') return [];
    const filename = receiptPath(root);
    if (!fs.existsSync(filename)) return [];
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.size > 65536) throw new Error('BUILD_ARTIFACT_INVALID: Invalid upload receipt; build again.');
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (saved.schemaVersion !== 2) return []; // Older/custom builds retain safe discovery.
    if (saved.firmware !== captureFirmware(root) || !Array.isArray(saved.uploadFiles)
        || (saved.executionId && saved.preprocess !== readSharedPreprocess(root).fingerprint)
        || saved.uploadFiles.some(file => typeof file !== 'string' || path.isAbsolute(file)
            || path.relative(directory, path.resolve(directory, file)).startsWith('..')
            || isRequestDirectory(path.relative(directory, path.resolve(directory, file))))) {
        throw new Error('BUILD_ARTIFACT_STALE: Firmware changed after compilation; build again.');
    }
    return saved.uploadFiles.map(file => path.resolve(directory, file));
}

// Called by compile.js after preprocessing has materialized archive sources, and
// again after the compiler closes. Edits during compilation cannot authorize reuse.
function publishBlocklyUploadState(config, inputs) {
    const root = fs.realpathSync(config.currentProjectPath);
    if (captureBlocklyUploadInputs(config) !== inputs) throw new Error('BUILD_SOURCE_STALE: Inputs changed during compilation; build again.');
    const firmware = captureFirmware(root);
    if (!firmware) return; // Legacy/custom toolchains still compile, but cannot use the fast path.
    const target = receiptPath(root), temporary = `${target}.${randomUUID()}.tmp`;
    try {
        const executionId = sharedSlot(config);
        const sharedPreprocess = executionId ? readSharedPreprocess(root) : undefined;
        const uploadFiles = captureGeneratedUploadFiles(root, sharedPreprocess);
        fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 2, inputs, firmware, uploadFiles,
            ...(executionId ? { executionId, preprocess: sharedPreprocess.fingerprint } : {}) }), { flag: 'wx' });
        fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
}

function canReuseBlocklyUpload(config, generatorDigest) {
    try {
        const root = fs.realpathSync(config.currentProjectPath), filename = receiptPath(root);
        if (!fs.existsSync(filename) || fs.statSync(filename).size > 65536) return false;
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        return saved.schemaVersion === 2 && typeof saved.firmware === 'string'
            && saved.executionId === sharedSlot(config)
            && (!saved.executionId || saved.preprocess === readSharedPreprocess(root).fingerprint)
            && saved.inputs === captureBlocklyUploadInputs(config, generatorDigest) && saved.firmware === captureFirmware(root);
    } catch { return false; } // Missing/changed/unreadable inputs require compilation.
}

module.exports = { generatorInputDigest, captureBlocklyUploadInputs, publishBlocklyUploadState, invalidateBlocklyUploadState, canReuseBlocklyUpload, readBlocklyUploadArtifacts, captureFirmware, resolveEspSrUploadCommand, materializeEspSrModel };
