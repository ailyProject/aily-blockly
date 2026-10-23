'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { sourceManifest } = require('./build-source-capture');
const { captureLibrarySource } = require('./library-source-evidence');
const { collectLibraryPackages } = require('./library-packages');
const hash = value => createHash('sha256').update(value).digest('hex');
const receiptPath = root => path.join(root, '.build', 'aily-upload-state.json');

// Ordinary upload reuse is separate from simulation/delivery acceptance. Read only
// compiler inputs and firmware, never create a workspace or treat a directory as a build.
function captureBlocklyUploadInputs(config) {
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
    for (const name of ['src', 'components', 'partitions.csv']) add(path.join(root, name));
    const board = path.join(root, 'node_modules', config.boardModule);
    for (const name of ['package.json', 'board.json']) add(path.join(board, name));
    for (const lib of collectLibraryPackages(pkg.dependencies, root)) {
        for (const name of ['package.json', 'src', 'src.7z']) add(path.join(lib.packagePath, name));
    }
    return hash(JSON.stringify({ root, manifest, boardModule: config.boardModule, code: config.code,
        projectMacros: config.projectMacros || [], generatedArtifacts: config.generatedArtifacts ?? null, records }));
}

function captureFirmware(root) {
    const directory = path.join(root, '.build');
    if (!fs.existsSync(directory)) return null;
    const files = [];
    const visit = (folder, depth = 0) => {
        if (depth > 16 || fs.lstatSync(folder).isSymbolicLink()) throw new Error('Invalid firmware directory.');
        for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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

function captureGeneratedUploadFiles(root) {
    const directory = path.join(root, '.build');
    const filename = path.join(root, '.temp', 'preprocess.json');
    if (!fs.existsSync(filename)) return [];
    const prepared = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const preparedDirectory = path.resolve(prepared.envVars?.BUILD_PATH || '');
    if (prepared.success !== true || typeof prepared.upload?.command !== 'string'
        || !fs.existsSync(preparedDirectory) || fs.realpathSync(preparedDirectory) !== directory) return [];
    const prefix = `${preparedDirectory.replace(/\\/g, '/')}/`;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}[^"\\r\\n]*?\\.(?:bin|hex|elf|eep|img|uf2)(?=["\\s:]|$)`, 'gi');
    const files = [...prepared.upload.command.replace(/\\/g, '/').matchAll(pattern)].map(match => {
        const file = path.resolve(match[0]);
        if (!fs.existsSync(file)
            || !fs.lstatSync(file).isFile() || !fs.statSync(file).size) {
            throw new Error('BUILD_ARTIFACT_INVALID: Generated upload output is missing or invalid; build again.');
        }
        const relative = path.relative(directory, fs.realpathSync(file));
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error('BUILD_ARTIFACT_INVALID: Generated upload output escapes the build directory.');
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
        || saved.uploadFiles.some(file => typeof file !== 'string' || path.isAbsolute(file)
            || path.relative(directory, path.resolve(directory, file)).startsWith('..'))) {
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
        const uploadFiles = captureGeneratedUploadFiles(root);
        fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 2, inputs, firmware, uploadFiles }), { flag: 'wx' });
        fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
}

function canReuseBlocklyUpload(config) {
    try {
        const root = fs.realpathSync(config.currentProjectPath), filename = receiptPath(root);
        if (!fs.existsSync(filename) || fs.statSync(filename).size > 65536) return false;
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        return saved.schemaVersion === 2 && typeof saved.firmware === 'string'
            && saved.inputs === captureBlocklyUploadInputs(config) && saved.firmware === captureFirmware(root);
    } catch { return false; } // Missing/changed/unreadable inputs require compilation.
}

module.exports = { captureBlocklyUploadInputs, publishBlocklyUploadState, invalidateBlocklyUploadState, canReuseBlocklyUpload, readBlocklyUploadArtifacts };
