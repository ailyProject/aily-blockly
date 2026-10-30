'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { captureProjectSources } = require('./compile-delivery');
const { confirmBuildSource } = require('./build-source-capture');
const { readLibraryProjections } = require('./library-source-evidence');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const fail = message => {
    throw Object.assign(new Error(`SIMULATION_UPLOAD_STALE: ${message} Rebuild and rerun simulation before uploading.`),
        { code: 'SIMULATION_UPLOAD_STALE' });
};

const unsupported = message => {
    throw Object.assign(new Error(`SIMULATION_UPLOAD_UNSUPPORTED: ${message}`), { code: 'SIMULATION_UPLOAD_UNSUPPORTED' });
};

function readFile(root, relative, limit) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)
        || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('Invalid Artifact file path.');

    let filename = root;

    for (const part of relative.split('/')) {
        filename = path.join(filename, part);

        if (fs.lstatSync(filename).isSymbolicLink()) fail('Artifact/source path was redirected.');
    }

    const before = fs.statSync(filename);

    if (!before.isFile() || before.size > limit) fail('Artifact/source file exceeds its boundary.');

    const bytes = fs.readFileSync(filename);
    const after = fs.statSync(filename);

    if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        fail('Artifact/source changed during verification.');
    }

    return bytes;
}

/** Reuse the host-observed build boundary; this does not decide whether a
 * simulation passed. The Agent supplies the ID from its verified run. */
function verifyUploadArtifact(projectPath, expected) {
    if (!expected || !sha(expected.artifactId) || !sha(expected.manifestSha256) || !sha(expected.requestDigest)) {
        fail('Verified build identity is missing.');
    }

    const root = fs.realpathSync(projectPath);
    const requestName = path.basename(String(expected.buildRequestPath || ''));

    if (!/^compile-request-[a-f0-9-]{36}\.json$/.test(requestName)
        || path.resolve(expected.buildRequestPath) !== path.join(root, '.temp', requestName)) fail('Build request is unavailable.');

    const requestBytes = readFile(root, `.temp/${requestName}`, 160 * 1024 * 1024);

    if (hash(requestBytes) !== expected.requestDigest) fail('Build request changed.');

    const config = JSON.parse(requestBytes);

    if (fs.realpathSync(config.currentProjectPath) !== root || config.sourceCapture?.mode !== 'blockly') {
        fail('The build belongs to another project or mode.');
    }

    const manifestBytes = readFile(root, '.build/aily-artifact-manifest.json', 2 * 1024 * 1024);

    if (hash(manifestBytes) !== expected.manifestSha256) fail('Artifact manifest changed.');

    const artifact = JSON.parse(manifestBytes);
    const receipt = JSON.parse(readFile(root, '.build/aily-build-delivery.json', 16384));

    if (artifact.kind !== 'aily-build-artifact' || artifact.schemaVersion !== 1 || artifact.artifactId !== expected.artifactId
        || receipt.kind !== 'aily-build-delivery' || receipt.artifactId !== artifact.artifactId
        || receipt.manifestSha256 !== expected.manifestSha256
        || receipt.project?.digest !== captureProjectSources(config).digest
        || receipt.project?.fqbn !== artifact.target?.fqbn
        || JSON.stringify(receipt.sourceCapture) !== JSON.stringify(config.sourceCapture)) fail('Project/build identity changed.');

    confirmBuildSource(config);

    const libraries = readLibraryProjections(config);

    if (libraries.digest !== receipt.libraryProjections?.digest) fail('Library projections changed.');
    if (!Array.isArray(artifact.files) || !artifact.files.length || artifact.files.length > 128) fail('Artifact file list is unavailable.');

    const paths = new Set();

    for (const file of artifact.files) {
        if (!sha(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || paths.has(file.path)) {
            fail('Invalid Artifact file entry.');
        }

        const bytes = readFile(root, `.build/${file.path}`, 256 * 1024 * 1024);

        if (bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256) fail(`Firmware changed: ${file.path}.`);

        paths.add(file.path);
    }

    return artifact;
}

/** Resolve the uploader's firmware placeholders only inside the verified
 * Artifact. A custom recipe with an unlisted firmware cannot use this mode. */

function resolveVerifiedFirmware(artifact, directory, pattern) {
    const expression = new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const matches = artifact.files.filter(file => expression.test(path.basename(file.path)));

    if (matches.length !== 1) unsupported(`Firmware selection is missing or ambiguous: ${pattern}.`);

    return path.join(directory, matches[0].path);
}

function assertVerifiedFirmwareArguments(artifact, directory, args) {
    const allowed = new Set(artifact.files.map(file => path.resolve(directory, file.path)));
    let found = false;

    for (const arg of args) {
        // Supports ordinary paths, quoted paths and avrdude -Uflash:w:<file>:i.
        const tokens = String(arg).match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g) || [];

        for (const token of tokens) {
            const filename = token.replace(/^["']|["']$/g, '').replace(/^-U[^:]+:[^:]+:/, '')
                .replace(/^--[^=]+=/, '').replace(/:[a-z]$/i, '');

            if (!/\.(?:bin|hex|elf|eep|img|uf2)$/i.test(filename)) continue;
            if (!allowed.has(path.resolve(directory, filename))) unsupported('Upload recipe references firmware outside the verified Artifact.');

            found = true;
        }
    }

    if (!found) unsupported('Upload recipe does not expose a verified firmware path.');
}

module.exports = { verifyUploadArtifact, resolveVerifiedFirmware, assertVerifiedFirmwareArguments };
