'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const project = require('./aily-code-project');
const { sourceManifest } = require('./build-source-capture');
const { captureLibrarySource } = require('./library-source-evidence');
const { collectLibraryPackages } = require('./library-packages');
const { resolvePlatformResourceRoots, resolveBoardResourceDirectory } = require('./platform-resource-roots');
const { captureFirmware } = require('./blockly-upload-state');

const hash = value => createHash('sha256').update(value).digest('hex');
const receiptPath = root => path.join(root, '.build', 'aily-coder-upload-state.json');
const ignoredDirectories = new Set(['.git', '.aily', '.build', '.temp', '.log', '.workspace-history', 'node_modules']);
const generatedSketchFile = /^(?:build-config|upload-config|preprocess|target-compile|library-cache|compile-preprocess-.+)\.json$/;

function includeSource(relative, arduinoSketch) {
    if (ignoredDirectories.has(relative.split('/')[0]) || path.posix.basename(relative) === '.DS_Store') return false;
    if (arduinoSketch && ['package.json', 'package-lock.json', 'libraries'].includes(relative)) return false;
    const sketchRelative = arduinoSketch ? relative.replace(/^sketch\//, '') : relative;
    return !generatedSketchFile.test(sketchRelative);
}

function captureCoderUploadInputs({ currentProjectPath, boardModule, appDataPath }) {
    const root = fs.realpathSync(currentProjectPath);
    const manifest = sourceManifest(fs.readFileSync(path.join(root, 'package.json')));
    const pkg = JSON.parse(manifest);
    if (pkg.type !== 'coder' || typeof boardModule !== 'string' || !/^@[^/\\]+\/[^/\\]+$/.test(boardModule)
        || boardModule.includes('..')) throw new Error('Invalid Coder build target.');
    const recorded = new Map();
    const add = (filename, options) => {
        if (recorded.has(filename)) return;
        const captured = fs.existsSync(filename) ? captureLibrarySource(filename, options) : null;
        recorded.set(filename, captured ? [captured.location, captured.fingerprint] : null);
    };
    add(pkg.arduinoSketch === true ? root : project.resolveCompileWorkspacePath(root), {
        include: relative => includeSource(relative, pkg.arduinoSketch === true),
        maxFiles: 100000, maxBytes: 2 * 1024 * 1024 * 1024,
    });
    // Cover native import library roots, including symlinked sketchbook libraries.
    if (pkg.arduinoSketch === true) {
        for (const directory of project.collectArduinoLibraryDirectories(root)) {
            for (const name of fs.readdirSync(directory).sort()) add(path.join(directory, name));
        }
    }
    add(path.join(root, 'partitions.csv'));
    const board = path.join(root, 'node_modules', boardModule);
    for (const name of ['package.json', 'board.json', 'partitions.csv']) add(path.join(board, name));
    for (const lib of collectLibraryPackages(pkg.dependencies, root, true)) {
        for (const name of ['package.json', 'src', 'src.7z']) add(path.join(lib.packagePath, name));
    }

    // Managed SDK/compiler directories are versioned installations. Bind the
    // actual installation and the recipe files that can be overridden in place.
    const boardPackage = JSON.parse(fs.readFileSync(path.join(board, 'package.json'), 'utf8'));
    const resources = resolvePlatformResourceRoots(appDataPath);
    const toolchain = [];
    for (const [name, version] of Object.entries(boardPackage.boardDependencies || {})) {
        const match = /^@aily-project\/(sdk|compiler)-(.+)$/.exec(name);
        if (!match) continue;
        const [, kind, resource] = match;
        const directory = fs.realpathSync(resolveBoardResourceDirectory(
            kind === 'sdk' ? resources.sdkPath : resources.compilerPath, kind, resource, version));
        const stat = fs.statSync(directory);
        toolchain.push([directory, stat.ino, stat.mtimeMs]);
        if (kind === 'sdk') {
            for (const file of ['boards.txt', 'boards.local.txt', 'platform.txt', 'platform.local.txt']) add(path.join(directory, file));
        }
    }
    const builder = path.join(process.env.AILY_NPM_PREFIX || path.join(appDataPath, 'npm-global'), 'lib', 'node_modules', '@aily-project', 'aily-builder');
    for (const file of ['package.json', 'aily-builder.js']) add(path.join(builder, file));
    return hash(JSON.stringify({ root, manifest, boardModule, files: [...recorded], toolchain,
        recipe: captureUploadRecipe(root) }));
}

function captureUploadRecipe(root) {
    const prepared = JSON.parse(fs.readFileSync(project.resolvePreprocessResultPath(root), 'utf8'));
    if (prepared.success !== true) throw new Error('Coder preparation did not complete.');
    const { command, toolName, use1200bpsTouch, waitForUploadPort } = prepared.upload || {};
    return hash(JSON.stringify([command, toolName, use1200bpsTouch, waitForUploadPort]));
}

function invalidateCoderUploadState(root) {
    fs.rmSync(receiptPath(root), { force: true });
}

function publishCoderUploadState(config, inputs) {
    const root = fs.realpathSync(config.currentProjectPath);
    if (captureCoderUploadInputs(config) !== inputs) throw new Error('BUILD_SOURCE_STALE: Coder inputs changed during compilation; build again.');
    const firmware = captureFirmware(root);
    if (!firmware) return;
    const receipt = { version: 1, inputs, firmware };
    const target = receiptPath(root), temporary = `${target}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx' });
        fs.renameSync(temporary, target);
    } finally { fs.rmSync(temporary, { force: true }); }
}

function canReuseCoderUpload(config) {
    try {
        const root = fs.realpathSync(config.currentProjectPath), filename = receiptPath(root);
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.size > 4096 || fs.lstatSync(path.dirname(filename)).isSymbolicLink()) return false;
        const text = fs.readFileSync(filename, 'utf8'), saved = JSON.parse(text);
        return saved.version === 1 && typeof saved.firmware === 'string'
            && saved.inputs === captureCoderUploadInputs(config)
            && saved.firmware === captureFirmware(root) && fs.readFileSync(filename, 'utf8') === text;
    } catch { return false; }
}

module.exports = { captureCoderUploadInputs, publishCoderUploadState, invalidateCoderUploadState, canReuseCoderUpload };
